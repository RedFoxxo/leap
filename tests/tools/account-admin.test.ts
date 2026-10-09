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

  it('write_passkey_name sends the name and reports the one openGym stored', async () => {
    // api/server.js POST /api/account/passkeys/rename and api/passkeys-store.js passkeyName, v1.4.0.
    const stub = new FetchStub()
      .post('/api/account/passkeys/rename', { ok: true, passkeys: [{ id: 'cred1', name: 'Work laptop', created: 'a', lastUsed: 'b', transports: [] }], password: false, lastWayIn: false }, { times: 1 })
      .post('/api/account/passkeys/rename', { ok: true, passkeys: [{ id: 'cred1', name: null, created: 'a', lastUsed: 'b', transports: [] }], password: false, lastWayIn: false }, { times: 1 })
      .post('/api/account/passkeys/rename', { error: 'passkey not found', code: 'not-found' }, { status: 404 })
    const h = await harness({ stub })
    expect((await h.call('write_passkey_name', { id: 'cred1', name: ' Work \t  laptop ' })).json).toEqual({ renamed: 'cred1', name: 'Work laptop' })
    expect(stub.calls[0]!.body).toEqual({ id: 'cred1', name: 'Work \t  laptop' })
    expect((await h.call('write_passkey_name', { id: 'cred1', name: '' })).json).toEqual({ renamed: 'cred1', name: null })
    expect((await h.call('write_passkey_name', { id: 'nope', name: 'x' })).text).toMatch(/No passkey of this profile has that id/)
    await h.close()
  })

  it('write_pairing_code hands over the one-shot code', async () => {
    const stub = new FetchStub().post('/api/pair/create', { code: 'K7Q2M9XD' })
    const h = await harness({ stub })
    expect((await h.call('write_pairing_code')).json).toEqual({ code: 'K7Q2M9XD', validFor: '5 minutes, once' })
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/pair/create'])
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
    // openGym sends the workouts newest first (api/server.js, GET /api/admin/user, v1.4.0).
    const workouts = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, d: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, name: 'Push', vol: 100 + i, entries: [{ id: '0025', sets: [] }] })).reverse()
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
    expect(r.json.recentWorkouts.map((w: { id: string }) => w.id)).toEqual(['w39', 'w38', 'w37', 'w36', 'w35', 'w34', 'w33', 'w32', 'w31', 'w30'])
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

/** GET /api/admin/coach as openGym answers it (api/coach/routes.js, v1.4.0): a compatible endpoint with a filed key. */
function coachCard(over: Record<string, unknown> = {}) {
  const provider = (id: string, extra: Record<string, unknown> = {}) => ({
    id, label: id, runtime: 'HTTPS', setupToken: false, deviceLogin: false, apiKey: true, http: true, baseUrl: id === 'compatible', keyOptional: id === 'compatible', keyPlaceholder: null, defaultModel: null, connected: false, ...extra,
  })
  return {
    disabledByEnv: false,
    enabled: true,
    provider: 'compatible',
    providers: [
      { id: 'fixture', label: 'Fixture (testing)', runtime: 'Fixture', setupToken: false, deviceLogin: false, apiKey: false, http: false, baseUrl: false, keyOptional: false, keyPlaceholder: null, defaultModel: null, connected: false },
      provider('anthropic', { connected: true }),
      provider('openai'),
      provider('compatible', { connected: true }),
    ],
    model: 'qwen3.8-27b',
    models: { compatible: 'qwen3.8-27b' },
    baseUrl: 'https://llm.home.example/v1',
    headers: null,
    knownModels: ['qwen3.8-27b'],
    caps: { perProfileDaily: 10, instanceDaily: 0 },
    maxMessageLen: 1000,
    maxOutputTokens: 16000,
    community: false,
    runtime: { ok: true, version: null, error: null, needsKey: false },
    authMode: 'instance',
    boundUid: null,
    auth: { state: 'connected', type: 'apikey', account: '', connectedAt: '2026-10-01T08:00:00.000Z' },
    unprivileged: { ok: true, dropped: false, why: 'this provider runs no child process' },
    jobsToday: 2,
    lastSuccess: null,
    lastError: null,
    recent: [],
    ...over,
  }
}

describe('admin_coach_config and the filed provider key', () => {
  it('refuses to point a provider holding a key at another endpoint, or to switch to one, without confirm', async () => {
    const stub = new FetchStub().get('/api/admin/coach', coachCard()).post('/api/admin/coach/config', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_config', { baseUrl: 'https://elsewhere.example/v1' })).text).toMatch(/key is filed for compatible; .*send that stored key to "https:\/\/elsewhere\.example\/v1".*confirm: true/)
    expect((await h.call('admin_coach_config', { provider: 'anthropic' })).text).toMatch(/confirm: true/)
    expect(stub.find('POST', '/api/admin/coach/config')).toHaveLength(0)
    const r = await h.call('admin_coach_config', { baseUrl: 'https://elsewhere.example/v1', confirm: true })
    expect(r.json).toEqual({ changed: { baseUrl: 'https://elsewhere.example/v1' } })
    expect(stub.find('POST', '/api/admin/coach/config')[0]!.body).toEqual({ baseUrl: 'https://elsewhere.example/v1' })
    await h.close()
  })

  it('needs no confirm where no key is filed, or for settings that send it nowhere new', async () => {
    const card = coachCard({ auth: { state: 'optional' }, providers: coachCard().providers.map((p) => ({ ...p, connected: false })) })
    const stub = new FetchStub().get('/api/admin/coach', card).post('/api/admin/coach/config', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_config', { baseUrl: 'http://192.168.1.20:11434/v1' })).isError).toBe(false)
    expect((await h.call('admin_coach_config', { provider: 'openai' })).isError).toBe(false)
    await h.close()
    const keyed = new FetchStub().get('/api/admin/coach', coachCard()).post('/api/admin/coach/config', { ok: true })
    const k = await harness({ stub: keyed })
    expect((await k.call('admin_coach_config', { provider: 'compatible', model: 'gpt-oss-120b' })).isError).toBe(false)
    expect((await k.call('admin_coach_config', { provider: 'openai' })).isError).toBe(false)
    expect(keyed.find('POST', '/api/admin/coach/config').map((c) => c.body)).toEqual([{ provider: 'compatible', model: 'gpt-oss-120b' }, { provider: 'openai' }])
    await k.close()
  })

  it('refuses when it cannot tell whether a key is filed', async () => {
    const stub = new FetchStub().get('/api/admin/coach', { error: 'forbidden' }, { status: 403 }).post('/api/admin/coach/config', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_config', { baseUrl: 'https://elsewhere.example/v1' })).isError).toBe(true)
    expect(stub.find('POST', '/api/admin/coach/config')).toHaveLength(0)
    await h.close()
  })

  it('says in its description that the stored key goes to the endpoint', async () => {
    const h = await harness()
    const tool = (await h.listTools()).find((t) => t.name === 'admin_coach_config')!
    expect(tool.description).toMatch(/stored key is sent to that host/)
    await h.close()
  })
})

describe('admin contracts', () => {
  it('admin_disable_user', async () => {
    const stub = new FetchStub()
      .post('/api/admin/user/disable', { ok: true, id: 'alex0000', disabled: true }, { times: 1 })
      .post('/api/admin/user/disable', { error: 'cannot disable an admin' }, { status: 400 })
    const h = await harness({ stub })
    expect((await h.call('admin_disable_user', { id: 'alex0000', disabled: true })).json).toEqual({ ok: true, id: 'alex0000', disabled: true })
    expect(stub.calls[0]).toMatchObject({ method: 'POST', path: '/api/admin/user/disable', body: { id: 'alex0000', disabled: true } })
    expect((await h.call('admin_disable_user', { id: 'me000000', disabled: true })).text).toMatch(/cannot disable an admin/)
    await h.close()
  })

  it('admin_invites, admin_create_invite and admin_revoke_invite', async () => {
    const invite = { code: '0123456789ABCDEF', note: 'for Alex', createdBy: 'me000000', created: '2026-10-09T08:00:00.000Z' }
    const stub = new FetchStub()
      .get('/api/admin/invites', { invites: [{ ...invite, usedByName: null }, { code: 'AAAABBBB', note: '', createdBy: 'me000000', created: '2026-01-01T00:00:00.000Z', usedBy: 'alex0000', usedAt: '2026-01-02T00:00:00.000Z', usedByName: 'Alex' }], invite_only: true })
      .post('/api/admin/invites/new', { invite })
      .post('/api/admin/invites/revoke', { ok: true }, { times: 1 })
      .post('/api/admin/invites/revoke', { error: 'already used, cannot revoke' }, { status: 400 })
    const h = await harness({ stub })
    expect((await h.call('admin_invites')).json).toMatchObject({ invite_only: true, invites: [{ code: invite.code }, { usedByName: 'Alex' }] })
    expect((await h.call('admin_create_invite', { note: 'for Alex' })).json).toEqual({ invite })
    expect(stub.find('POST', '/api/admin/invites/new')[0]!.body).toEqual({ note: 'for Alex' })
    await h.call('admin_create_invite')
    expect(stub.find('POST', '/api/admin/invites/new')[1]!.body).toEqual({})
    expect((await h.call('admin_revoke_invite', { code: invite.code })).json).toEqual({ ok: true })
    expect(stub.find('POST', '/api/admin/invites/revoke')[0]!.body).toEqual({ code: invite.code })
    expect((await h.call('admin_revoke_invite', { code: 'AAAABBBB' })).text).toMatch(/already used, cannot revoke/)
    await h.close()
  })

  it('admin_coach shows the card, never a credential', async () => {
    const stub = new FetchStub().get('/api/admin/coach', coachCard())
    const h = await harness({ stub })
    const r = await h.call('admin_coach')
    expect(r.json).toEqual(coachCard())
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/admin/coach'])
    await h.close()
  })

  it('admin_coach_test, admin_coach_models and admin_coach_disconnect', async () => {
    const stub = new FetchStub()
      .post('/api/admin/coach/test', { ok: false, version: null, error: 'the provider did not answer in time' })
      .post('/api/admin/coach/models', { ok: true, models: ['qwen3.8-27b', 'gpt-oss-120b'] })
      .post('/api/admin/coach/disconnect', { ok: true })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_test')).json).toEqual({ ok: false, version: null, error: 'the provider did not answer in time' })
    expect((await h.call('admin_coach_models')).json).toEqual({ ok: true, models: ['qwen3.8-27b', 'gpt-oss-120b'] })
    expect((await h.call('admin_coach_disconnect', {})).isError).toBe(true)
    expect(stub.find('POST', '/api/admin/coach/disconnect')).toHaveLength(0)
    expect((await h.call('admin_coach_disconnect', { confirm: true })).json).toEqual({ ok: true })
    expect(stub.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/admin/coach/test', {}],
      ['POST', '/api/admin/coach/models', {}],
      ['POST', '/api/admin/coach/disconnect', {}],
    ])
    await h.close()
  })

  it('reports a non-admin on every admin tool', async () => {
    const stub = new FetchStub().on({ method: 'POST', path: /^\/api\/admin\//, status: 403, body: { error: 'forbidden' } })
    const h = await harness({ stub })
    expect((await h.call('admin_coach_models')).text).toMatch(/not an admin of the instance/)
    await h.close()
  })
})
