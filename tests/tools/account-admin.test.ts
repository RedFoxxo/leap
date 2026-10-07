import { describe, expect, it } from 'vitest'
import { FetchStub } from '../helpers/fetch-stub.js'
import { harness } from '../helpers/harness.js'

const ME = { user: { id: 'me000000', name: 'Foxxo', admin: true } }

describe('account', () => {
  it('read_account combines sign-in details and passkeys without their keys', async () => {
    const stub = new FetchStub()
      .get('/api/account/password', { set: true, setAt: '2026-10-01T00:00:00Z', passkeys: 1, name: 'Foxxo', nameTaken: false, email: null })
      .get('/api/account/passkeys', { passkeys: [{ id: 'cred1', name: 'Phone', created: 'a', lastUsed: 'b', transports: ['internal'] }], password: true, lastWayIn: false })
    const h = await harness({ stub })
    expect((await h.call('read_account')).json).toEqual({
      name: 'Foxxo',
      passwordSet: true,
      passwordSetAt: '2026-10-01T00:00:00Z',
      email: null,
      passkeyCount: 1,
      passkeys: [{ id: 'cred1', name: 'Phone', created: 'a', lastUsed: 'b' }],
    })
    await h.close()
  })

  it('delete_all_sessions needs an explicit confirm and says leap must pair again', async () => {
    const stub = new FetchStub().post('/api/logout/all', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('delete_all_sessions', {})).isError).toBe(true)
    expect(stub.calls).toHaveLength(0)
    expect((await h.call('delete_all_sessions', { confirm: true })).json.next).toMatch(/leap pair/)
    await h.close()
  })

  it('offers no tool that takes a password', async () => {
    const h = await harness()
    const names = (schema: unknown): string[] => {
      if (!schema || typeof schema !== 'object') return []
      const node = schema as Record<string, unknown>
      const own = node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : []
      return [...own, ...Object.values(node).flatMap((v) => (Array.isArray(v) ? v.flatMap(names) : names(v)))]
    }
    for (const tool of await h.listTools()) {
      const props = names((tool as unknown as { inputSchema: unknown }).inputSchema)
      expect(props.filter((p) => /password|current|token|secret/i.test(p)), tool.name).toEqual([])
    }
    await h.close()
  })
})

describe('admin', () => {
  it('reports a non-admin profile plainly', async () => {
    const stub = new FetchStub().get('/api/admin/users', { error: 'forbidden' }, { status: 403 })
    const h = await harness({ stub })
    expect((await h.call('admin_users')).text).toMatch(/not an admin of the instance/)
    await h.close()
  })

  it('deletes a user only when the name matches, and never the caller', async () => {
    const stub = new FetchStub()
      .get('/api/me', ME)
      .get('/api/admin/user', (c: { query: URLSearchParams }) => ({ user: { id: c.query.get('id'), name: c.query.get('id') === 'me000000' ? 'Foxxo' : 'Alex' } }))
      .post('/api/admin/user/delete', { ok: true, id: 'alex0000' })
    const h = await harness({ stub })
    expect((await h.call('admin_delete_user', { id: 'alex0000', confirmName: 'Bob' })).text).toMatch(/does not match the profile's name \("Alex"\); nothing was deleted/)
    expect((await h.call('admin_delete_user', { id: 'me000000', confirmName: 'Foxxo' })).text).toMatch(/your own profile/)
    expect(stub.find('POST', '/api/admin/user/delete')).toHaveLength(0)
    expect((await h.call('admin_delete_user', { id: 'alex0000', confirmName: ' alex ' })).json).toEqual({ deleted: { id: 'alex0000', name: 'Alex' } })
    await h.close()
  })

  it('sends only the Coach settings given, and needs a confirm to clear the log', async () => {
    const stub = new FetchStub().post('/api/admin/coach/config', { ok: true }).post('/api/admin/audit/clear', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_config', { enabled: false, caps: { perProfileDaily: 5 } })).json).toEqual({ changed: { enabled: false, caps: { perProfileDaily: 5 } } })
    expect(stub.find('POST', '/api/admin/coach/config')[0]!.body).toEqual({ enabled: false, caps: { perProfileDaily: 5 } })
    expect((await h.call('admin_coach_config', {})).text).toMatch(/nothing to change/)
    expect((await h.call('admin_clear_audit', {})).isError).toBe(true)
    expect(stub.find('POST', '/api/admin/audit/clear')).toHaveLength(0)
    await h.close()
  })

  it('pages the activity log with the API’s own parameters', async () => {
    const stub = new FetchStub().get('/api/admin/audit', { events: [], nextBefore: null })
    const h = await harness({ stub })
    await h.call('admin_audit', { category: 'fail', limit: 50, before: 120 })
    const q = stub.calls[0]!.query
    expect([q.get('cat'), q.get('limit'), q.get('before')]).toEqual(['fail', '50', '120'])
    await h.close()
  })
})
