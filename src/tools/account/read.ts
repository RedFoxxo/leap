import { failure, success } from '../respond.js'
import { defineTool } from '../types.js'

interface SessionUser {
  id: string
  name: string
  admin?: boolean
}

export const readMe = defineTool({
  name: 'read_me',
  description:
    'Who leap is signed in as: profile id, name and whether it is an admin. tokenRenewalDue: true means the token is past half its lifetime; run `leap pair` again before it expires.',
  input: {},
  async handler(_args, ctx) {
    const r = await ctx.http.request<{ user: SessionUser; token?: string }>({ method: 'GET', path: '/api/me' })
    if (!r.ok) return failure('Could not read the signed-in profile', r)
    const { id, name, admin } = r.data.user
    return success({ id, name, admin: admin === true, tokenRenewalDue: typeof r.data.token === 'string' })
  },
})

export const readInstance = defineTool({
  name: 'read_instance',
  description:
    'The instance: whether it is up, how many accounts it has, and its configuration (invite-only, guest mode, password login, default language, media limits in MB, and the AI Coach block, null when the Coach is off).',
  input: {},
  async handler(_args, ctx) {
    const [health, config] = await Promise.all([
      ctx.http.request<{ ok: boolean; users?: number }>({ method: 'GET', path: '/api/health' }),
      ctx.http.request<Record<string, unknown>>({ method: 'GET', path: '/api/config' }),
    ])
    if (!health.ok) return failure('openGym is not reachable or not healthy', health)
    if (!config.ok) return failure('Could not read the instance configuration', config)
    return success({ url: ctx.config.baseUrl, up: health.data.ok === true, users: health.data.users, config: config.data })
  },
})

export const accountReadTools = [readMe, readInstance]
