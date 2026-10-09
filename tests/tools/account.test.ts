import { describe, expect, it } from 'vitest'
import { VERSION } from '../../src/version.js'
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
  const config = { invite_only: true, allow_guest: false, coach: null, media: { imageMB: 2, quotaMB: 200 } }

  it('combines health, compatibility and configuration', async () => {
    const stub = new FetchStub().get('/api/health', { ok: true, users: 3, writable: true }).get('/api/config', config)
    const h = await harness({ stub })
    const r = await h.call('read_instance')
    expect(r.json).toEqual({
      url: BASE,
      up: true,
      users: 3,
      compatibility: { leap: VERSION, openGym: '1.4.0 or later', supported: '1.4.0 or later (tested with 1.4.0)', leapCanWrite: true },
      config,
    })
    await h.close()
  })

  it('says when the openGym is too old for leap to write to', async () => {
    const stub = new FetchStub().get('/api/health', { ok: true, users: 3 }).get('/api/config', config)
    const h = await harness({ stub })
    const r = await h.call('read_instance')
    expect(r.json.compatibility).toMatchObject({ openGym: 'older than 1.4.0', leapCanWrite: false, reason: expect.stringContaining('update openGym') })
    await h.close()
  })

  it('reports an instance that cannot write its data folder', async () => {
    const stub = new FetchStub().get('/api/health', { ok: false, writable: false }, { status: 503 }).get('/api/config', config)
    const h = await harness({ stub })
    const r = await h.call('read_instance')
    expect(r.json).toMatchObject({ up: false, compatibility: { openGym: '1.4.0 or later', leapCanWrite: false, reason: expect.stringContaining('cannot write its data folder') } })
    await h.close()
  })
})
