import { describe, expect, it } from 'vitest'
import { FetchStub } from '../helpers/fetch-stub.js'
import { BASE, harness } from '../helpers/harness.js'

describe('read_me', () => {
  it('returns the profile without leaking a renewed token', async () => {
    const stub = new FetchStub().get('/api/me', { user: { id: 'Zk3q9XyPbA2LmN0v', name: 'Ada', admin: false }, token: 'renewed.hmac' })
    const h = await harness({ stub })
    const r = await h.call('read_me')
    expect(r.isError).toBe(false)
    expect(r.json).toEqual({ id: 'Zk3q9XyPbA2LmN0v', name: 'Ada', admin: false, tokenRenewalDue: true })
    expect(r.text).not.toContain('renewed')
    await h.close()
  })

  it('reports an expired or revoked token', async () => {
    const stub = new FetchStub().get('/api/me', { error: 'not signed in' }, { status: 401 })
    const h = await harness({ stub })
    const r = await h.call('read_me')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/401: not signed in/)
    await h.close()
  })
})

describe('read_instance', () => {
  it('combines health and configuration', async () => {
    const config = { invite_only: true, allow_guest: false, coach: null, media: { imageMB: 2, quotaMB: 200 } }
    const stub = new FetchStub().get('/api/health', { ok: true, users: 3 }).get('/api/config', config)
    const h = await harness({ stub })
    const r = await h.call('read_instance')
    expect(r.json).toEqual({ url: BASE, up: true, users: 3, config })
    await h.close()
  })
})
