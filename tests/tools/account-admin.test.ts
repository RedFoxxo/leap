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
      .get('/api/admin/users', { users: [{ id: 'me000000', name: 'Foxxo' }, { id: 'alex0000', name: 'Alex' }] })
      .post('/api/admin/user/delete', { ok: true, id: 'alex0000' })
    const h = await harness({ stub })
    expect((await h.call('admin_delete_user', { id: 'alex0000', confirmName: 'Bob' })).text).toMatch(/does not match the profile's name \("Alex"\); nothing was deleted/)
    expect((await h.call('admin_delete_user', { id: 'me000000', confirmName: 'Foxxo' })).text).toMatch(/your own profile/)
    expect((await h.call('admin_delete_user', { id: 'nobody00', confirmName: 'X' })).text).toMatch(/no profile with id/)
    expect(stub.find('POST', '/api/admin/user/delete')).toHaveLength(0)
    expect((await h.call('admin_delete_user', { id: 'alex0000', confirmName: ' alex ' })).json).toEqual({ deleted: { id: 'alex0000', name: 'Alex' } })
    await h.close()
  })

  it('sends only the Coach settings given, and needs a confirm to clear the log', async () => {
    const stub = new FetchStub().get('/api/admin/coach', { caps: { perProfileDaily: 10, instanceDaily: 0 } }).post('/api/admin/coach/config', { ok: true }).post('/api/admin/audit/clear', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_config', { enabled: false, caps: { perProfileDaily: 5 } })).json).toEqual({ changed: { enabled: false, caps: { perProfileDaily: 5, instanceDaily: 0 } } })
    expect(stub.find('POST', '/api/admin/coach/config')[0]!.body).toEqual({ enabled: false, caps: { perProfileDaily: 5, instanceDaily: 0 } })
    expect((await h.call('admin_coach_config', {})).text).toMatch(/nothing to change/)
    expect((await h.call('admin_clear_audit', {})).isError).toBe(true)
    expect(stub.find('POST', '/api/admin/audit/clear')).toHaveLength(0)
    await h.close()
  })

  it('keeps the other Coach limit when changing one (the server resets a missing one to "no limit")', async () => {
    const stub = new FetchStub().get('/api/admin/coach', { enabled: true, caps: { perProfileDaily: 10, instanceDaily: 300 } }).post('/api/admin/coach/config', { ok: true })
    const h = await harness({ stub })
    await h.call('admin_coach_config', { caps: { perProfileDaily: 5 } })
    expect(stub.find('POST', '/api/admin/coach/config')[0]!.body).toEqual({ caps: { perProfileDaily: 5, instanceDaily: 300 } })
    await h.close()
  })

  it('sets the Coach output limit and routing headers, never credentials', async () => {
    const stub = new FetchStub().post('/api/admin/coach/config', { ok: true })
    const h = await harness({ stub })
    const r = await h.call('admin_coach_config', { outputLimit: 20000, headers: { 'X-Title': 'openGym' } })
    expect(r.isError, r.text).toBe(false)
    expect(stub.find('POST', '/api/admin/coach/config')[0]!.body).toEqual({ maxOutputTokens: 20000, headers: { 'X-Title': 'openGym' } })
    await h.call('admin_coach_config', { headers: null })
    expect(stub.find('POST', '/api/admin/coach/config')[1]!.body).toEqual({ headers: null })
    expect((await h.call('admin_coach_config', { headers: { 'X-Api-Key': 'x' } })).text).toMatch(/looks like a credential/)
    expect((await h.call('admin_coach_config', { headers: { 'X-Route': 'Bearer abc123' } })).text).toMatch(/looks like a credential/)
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`X-H${i}`, 'v']))
    expect((await h.call('admin_coach_config', { headers: many })).text).toMatch(/at most 8 headers/)
    expect(stub.find('POST', '/api/admin/coach/config')).toHaveLength(2)
    await h.close()
  })

  it('summarises a profile instead of returning its whole history', async () => {
    const workouts = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, d: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, name: 'Push', vol: 100 + i, entries: [{ id: '0025', sets: [] }] }))
    const stub = new FetchStub().get('/api/admin/user', {
      user: { id: 'alex0000', name: 'Alex', disabled: false, admin: false },
      unit: 'kg',
      lastSync: 5,
      routines: [{ id: 'r1', name: 'A', ex: [] }],
      bodyweight: [{ d: '2026-09-01', w: 80 }, { d: '2026-09-20', w: 79 }],
      workouts,
    })
    const h = await harness({ stub })
    const r = await h.call('admin_user', { id: 'alex0000' })
    expect(r.json).toMatchObject({ user: { name: 'Alex' }, unit: 'kg', counts: { workouts: 40, routines: 1, weighIns: 2 }, latestWeighIn: { date: '2026-09-20', weight: 79 }, truncated: true })
    expect(r.json.recentWorkouts).toHaveLength(10)
    expect(r.json.recentWorkouts[0]).toEqual({ id: 'w39', date: '2026-09-12', name: 'Push', volume: 139, exercises: 1 })
    expect(r.text.length).toBeLessThan(3000)
    await h.close()
  })

  it('looks a profile’s name up in the user list before deleting, and needs a confirm for password resets', async () => {
    const stub = new FetchStub()
      .get('/api/me', ME)
      .get('/api/admin/users', { users: [{ id: 'alex0000', name: 'Alex' }] })
      .post('/api/admin/user/delete', { ok: true })
      .post('/api/admin/user/password-reset', { ok: true, name: 'Alex', code: 'abc', expires: 1 })
    const h = await harness({ stub })
    expect((await h.call('admin_delete_user', { id: 'alex0000', confirmName: 'Alex' })).isError).toBe(false)
    expect(stub.find('GET', '/api/admin/user')).toHaveLength(0)
    expect((await h.call('admin_password_reset', { id: 'alex0000' })).isError).toBe(true)
    expect(stub.find('POST', '/api/admin/user/password-reset')).toHaveLength(0)
    expect((await h.call('admin_password_reset', { id: 'alex0000', confirm: true })).json.code).toBe('abc')
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
