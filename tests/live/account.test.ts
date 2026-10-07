import { describe, expect, it } from 'vitest'
import { LIVE, liveClient } from './helpers.js'

describe.runIf(LIVE)('account (live)', () => {
  it('read_me resolves the paired profile', async () => {
    const c = await liveClient()
    const r = await c.call('read_me')
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toMatchObject({ id: expect.any(String), name: expect.any(String), tokenRenewalDue: false })
    await c.close()
  })

  it('read_instance reports a healthy instance', async () => {
    const c = await liveClient()
    const r = await c.call('read_instance')
    expect(r.isError, r.text).toBe(false)
    expect(r.json.up).toBe(true)
    expect(r.json.config).toHaveProperty('coach')
    await c.close()
  })
})
