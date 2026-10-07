import { describe, expect, it } from 'vitest'
import { HttpCore } from '../../src/http/core.js'
import { redeem } from '../../src/pair.js'
import { LIVE, liveClient } from './helpers.js'

/** A second throwaway profile on the test server, registered with password login like the test profile. */
async function registerSecond(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/register/password`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Second ${Date.now()}`, password: 'second-test-password-2026' }),
  })
  const body = (await r.json()) as { user: { id: string } }
  return body.user.id
}

describe.runIf(LIVE)('account and admin (live)', () => {
  it('reads the account and makes a pairing code that really pairs', async () => {
    const c = await liveClient()
    const account = await c.call('read_account')
    expect(account.json).toMatchObject({ name: 'Leap Tester', passwordSet: true, passkeys: [] })
    const pairing = await c.call('write_pairing_code')
    const paired = await redeem(new HttpCore({ baseUrl: process.env.OPENGYM_URL!, token: '' }), pairing.json.code)
    expect(paired.ok && paired.data.user.name).toBe('Leap Tester')
    expect((await c.call('write_passkey_name', { id: 'nope', name: 'x' })).text).toMatch(/No passkey of this profile has that id/)
    await c.close()
  })

  it('administers users, invites, the log and the Coach', async () => {
    const c = await liveClient()
    const id = await registerSecond(process.env.OPENGYM_URL!)
    const users = await c.call('admin_users')
    const second = users.json.users.find((u: { id: string }) => u.id === id)
    expect(second).toMatchObject({ disabled: false })

    expect((await c.call('admin_disable_user', { id, disabled: true })).isError).toBe(false)
    expect((await c.call('admin_user', { id })).json.user.disabled).toBe(true)
    expect((await c.call('admin_disable_user', { id, disabled: false })).isError).toBe(false)
    expect((await c.call('admin_password_reset', { id })).json).toMatchObject({ code: expect.any(String) })

    expect((await c.call('admin_delete_user', { id, confirmName: 'Somebody else' })).text).toMatch(/nothing was deleted/)
    expect((await c.call('admin_delete_user', { id, confirmName: second.name })).json.deleted.id).toBe(id)
    expect((await c.call('admin_users')).json.users.some((u: { id: string }) => u.id === id)).toBe(false)

    const invite = await c.call('admin_create_invite', { note: 'for Alex' })
    expect(invite.json.invite.note).toBe('for Alex')
    expect((await c.call('admin_revoke_invite', { code: invite.json.invite.code })).isError).toBe(false)

    const audit = await c.call('admin_audit', { category: 'admin', limit: 5 })
    expect(audit.json.events.map((e: { ev: string }) => e.ev)).toContain('admin.user.delete')

    expect((await c.call('admin_coach')).isError).toBe(false)
    expect((await c.call('admin_coach_test')).json).toMatchObject({ ok: true })
    expect((await c.call('admin_coach_config', { caps: { perProfileDaily: 20 } })).isError).toBe(false)
    await c.close()
  })
})
