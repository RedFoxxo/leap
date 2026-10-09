import { z } from 'zod'
import { failure, success } from '../respond.js'
import { defineTool } from '../types.js'

/**
 * Account actions that need no proof. Changing the password or sign-in e-mail,
 * removing a passkey and creating a device link need the current password (or
 * a passkey) as proof; they stay in the app so no password passes through an
 * AI conversation (decided with the user, 2026-10-07).
 */

export const readAccount = defineTool({
  name: 'read_account',
  description:
    'How this profile signs in: its sign-in name, whether it has a password, its sign-in e-mail, and its passkeys (name, created, last used). Changing the password, e-mail or passkeys is done in the openGym app.',
  input: {},
  async handler(_args, ctx) {
    const [password, passkeys] = await Promise.all([
      ctx.http.request<Record<string, unknown>>({ method: 'GET', path: '/api/account/password' }),
      ctx.http.request<{ passkeys: Record<string, unknown>[]; lastWayIn?: boolean }>({ method: 'GET', path: '/api/account/passkeys' }),
    ])
    const out: Record<string, unknown> = {}
    if (password.ok) {
      const { set, name, email, passkeys: count, setAt } = password.data
      Object.assign(out, { name, passwordSet: set === true, ...(setAt ? { passwordSetAt: setAt } : {}), email: email ?? null, passkeyCount: count })
    } else if (password.status !== 404) return failure('Could not read the account', password)
    else out.passwordLogin = 'off on this instance'
    if (!passkeys.ok) return failure('Could not read the passkeys', passkeys)
    const list = Array.isArray(passkeys.data?.passkeys) ? passkeys.data.passkeys : []
    out.passkeys = list.map(({ id, name, created, lastUsed }) => ({ id, name: name ?? null, created, lastUsed }))
    if (passkeys.data?.lastWayIn) out.lastWayIn = true
    return success(out)
  },
})

export const writePasskeyName = defineTool({
  name: 'write_passkey_name',
  description: 'Name one of the profile\'s passkeys ("Work laptop"); ids from read_account. An empty name removes it.',
  input: { id: z.string().min(1).max(512), name: z.string().max(40) },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/account/passkeys/rename', json: { id: args.id, name: args.name.trim() } })
    if (!r.ok) return failure(r.status === 404 ? 'No passkey of this profile has that id' : 'Could not rename the passkey', r)
    return success({ renamed: args.id, name: args.name.trim() || null })
  },
})

export const writePairingCode = defineTool({
  name: 'write_pairing_code',
  description:
    'Make a pairing code for another device of this profile: the openGym phone app, or leap on another computer (`leap pair`). The code works once, within 5 minutes, and gives that device full access to the profile. A new code replaces any code made before that was not used yet.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request<{ code: string }>({ method: 'POST', path: '/api/pair/create' })
    if (!r.ok) return failure('Could not make a pairing code', r)
    return success({ code: r.data.code, validFor: '5 minutes, once' })
  },
})

export const deleteAllSessions = defineTool({
  name: 'delete_all_sessions',
  description:
    'Sign this profile out everywhere: every browser session and every paired device, leap itself included. Use it when a device or token may be in the wrong hands. Afterwards leap stops working until it is paired again (`leap pair`). Passkeys and the password are untouched.',
  input: { confirm: z.literal(true).describe('Must be true: this also signs leap out') },
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/logout/all' })
    if (!r.ok) return failure('Could not sign out everywhere', r)
    return success({ signedOutEverywhere: true, next: 'Pair leap again with `npx -y @redfoxxo/leap pair` and update OPENGYM_TOKEN.' })
  },
})

export const accountExtraReadTools = [readAccount]
export const accountWriteTools = [writePasskeyName, writePairingCode]
export const accountDeleteTools = [deleteAllSessions]
