import { z } from 'zod'
import type { Err } from '../../http/result.js'
import { failure, invalid, success } from '../respond.js'
import { entryId } from '../schema.js'
import { defineTool } from '../types.js'

/**
 * Instance administration, for admin profiles only (ADMIN_UIDS or an admin
 * flag). Every tool here carries the `admin_` prefix so one permission rule
 * covers them; the suggested rule is deny. Filing a provider credential for the
 * Coach is left to the app, so no secret passes through an AI conversation.
 */

const userId = entryId.describe('User id (read admin_users)')

function adminFailure(summary: string, e: Err) {
  return failure(e.status === 403 ? 'This profile is not an admin of the instance (the attempt is recorded in its activity log)' : summary, e)
}

export const adminUsers = defineTool({
  name: 'admin_users',
  description: 'Admin: every profile on the instance with its id, name, admin and disabled flags, passkeys, password, last sign-in and training activity.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/admin/users' })
    return r.ok ? success(r.data) : adminFailure('Could not list the users', r)
  },
})

export const adminUser = defineTool({
  name: 'admin_user',
  description: 'Admin: one profile in detail (sign-in methods, activity, recent workouts as the admin dashboard shows them).',
  input: { id: userId },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/admin/user', query: { id: args.id } })
    return r.ok ? success(r.data) : adminFailure('Could not read the user', r)
  },
})

export const adminDisableUser = defineTool({
  name: 'admin_disable_user',
  description: 'Admin: disable a profile (it cannot sign in and every session it has ends) or enable it again.',
  input: { id: userId, disabled: z.boolean() },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/user/disable', json: { id: args.id, disabled: args.disabled } })
    return r.ok ? success(r.data) : adminFailure('Could not change the user', r)
  },
})

export const adminDeleteUser = defineTool({
  name: 'admin_delete_user',
  description:
    'Admin: delete a profile and everything of it (training data, photos, passkeys) for good. `confirmName` must be the profile\'s name, as a check against a wrong id. A profile cannot delete itself here.',
  input: { id: userId, confirmName: z.string().min(1).max(80) },
  async handler(args, ctx) {
    const [me, user] = await Promise.all([
      ctx.http.request<{ user: { id: string } }>({ method: 'GET', path: '/api/me' }),
      ctx.http.request<{ user?: { name?: string }; name?: string }>({ method: 'GET', path: '/api/admin/user', query: { id: args.id } }),
    ])
    if (!me.ok) return failure('Could not read the signed-in profile', me)
    if (me.data.user.id === args.id) return invalid('this is your own profile; it is not deleted from here')
    if (!user.ok) return adminFailure('Could not read the user', user)
    const name = user.data.user?.name ?? user.data.name
    if (typeof name !== 'string' || name.trim().toLowerCase() !== args.confirmName.trim().toLowerCase()) {
      return invalid(`confirmName does not match the profile's name${typeof name === 'string' ? ` ("${name}")` : ''}; nothing was deleted`)
    }
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/user/delete', json: { id: args.id } })
    return r.ok ? success({ deleted: { id: args.id, name } }) : adminFailure('Could not delete the user', r)
  },
})

export const adminPasswordReset = defineTool({
  name: 'admin_password_reset',
  description: 'Admin: issue a one-time code with which a profile sets a new password (password sign-in must be on). Give the code to that person only.',
  input: { id: userId },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/user/password-reset', json: { id: args.id } })
    return r.ok ? success(r.data) : adminFailure('Could not issue a reset code', r)
  },
})

export const adminInvites = defineTool({
  name: 'admin_invites',
  description: 'Admin: invite codes (for invite-only instances): unused and used, with their notes.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/admin/invites' })
    return r.ok ? success(r.data) : adminFailure('Could not list the invites', r)
  },
})

export const adminCreateInvite = defineTool({
  name: 'admin_create_invite',
  description: 'Admin: make a single-use invite code, optionally with a note ("for Alex").',
  input: { note: z.string().max(60).optional() },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/invites/new', json: args.note ? { note: args.note } : {} })
    return r.ok ? success(r.data) : adminFailure('Could not make an invite', r)
  },
})

export const adminRevokeInvite = defineTool({
  name: 'admin_revoke_invite',
  description: 'Admin: revoke an unused invite code.',
  input: { code: z.string().min(1).max(64) },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/invites/revoke', json: { code: args.code } })
    return r.ok ? success(r.data) : adminFailure('Could not revoke the invite', r)
  },
})

export const adminAudit = defineTool({
  name: 'admin_audit',
  description: 'Admin: the activity log, newest first: sign-ins, failed attempts and admin actions. Filter by category; page with `before` (nextBefore of the previous page).',
  input: {
    category: z.enum(['auth', 'admin', 'fail']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    before: z.number().int().positive().optional(),
  },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/admin/audit', query: { cat: args.category, limit: args.limit, before: args.before } })
    return r.ok ? success(r.data) : adminFailure('Could not read the activity log', r)
  },
})

export const adminClearAudit = defineTool({
  name: 'admin_clear_audit',
  description: 'Admin: clear the whole activity log. The clearing itself is recorded.',
  input: { confirm: z.literal(true) },
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/audit/clear', json: {} })
    return r.ok ? success(r.data) : adminFailure('Could not clear the activity log', r)
  },
})

export const adminCoach = defineTool({
  name: 'admin_coach',
  description: "Admin: the AI Coach card: on or off, provider, model and endpoint, whether a credential is filed (never the credential), caps and today's usage, and a live check of the provider.",
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: '/api/admin/coach' })
    return r.ok ? success(r.data) : adminFailure('Could not read the Coach settings', r)
  },
})

export const adminCoachConfig = defineTool({
  name: 'admin_coach_config',
  description:
    'Admin: change the AI Coach settings; only what is given changes. Provider ids are listed by admin_coach. Filing the provider credential is done in the app, so no secret passes through this conversation.',
  input: {
    enabled: z.boolean().optional(),
    provider: z.string().min(1).max(40).optional(),
    model: z.string().max(80).optional().describe('Empty clears it'),
    baseUrl: z.string().max(2048).optional().describe('Only for providers with a configurable endpoint; empty = default'),
    community: z.boolean().optional().describe('Offer the comparison with others'),
    caps: z
      .object({ perProfileDaily: z.number().int().min(0).max(200).optional(), instanceDaily: z.number().int().min(0).max(5000).optional() })
      .strict()
      .optional()
      .describe('Daily job limits; 0 = no cap'),
    maxMessageLen: z.number().int().min(200).max(4000).optional(),
  },
  async handler(args, ctx) {
    const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
    if (!Object.keys(body).length) return invalid('nothing to change')
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/coach/config', json: body })
    return r.ok ? success({ changed: body }) : adminFailure('Could not change the Coach settings', r)
  },
})

export const adminCoachTest = defineTool({
  name: 'admin_coach_test',
  description: 'Admin: run one small round trip against the configured Coach provider and report whether it answered.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/coach/test', json: {} })
    return r.ok ? success(r.data) : adminFailure('The test did not run', r)
  },
})

export const adminCoachModels = defineTool({
  name: 'admin_coach_models',
  description: "Admin: the models the Coach provider's endpoint serves (HTTPS providers).",
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/coach/models', json: {} })
    return r.ok ? success(r.data) : adminFailure('Could not list the models', r)
  },
})

export const adminCoachDisconnect = defineTool({
  name: 'admin_coach_disconnect',
  description: "Admin: remove the Coach provider's stored credential.",
  input: { confirm: z.literal(true) },
  async handler(_args, ctx) {
    const r = await ctx.http.request({ method: 'POST', path: '/api/admin/coach/disconnect', json: {} })
    return r.ok ? success(r.data ?? { ok: true }) : adminFailure('Could not remove the credential', r)
  },
})

export const adminTools = [
  adminUsers,
  adminUser,
  adminDisableUser,
  adminDeleteUser,
  adminPasswordReset,
  adminInvites,
  adminCreateInvite,
  adminRevokeInvite,
  adminAudit,
  adminClearAudit,
  adminCoach,
  adminCoachConfig,
  adminCoachTest,
  adminCoachModels,
  adminCoachDisconnect,
]
