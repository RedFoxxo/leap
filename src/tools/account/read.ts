import { compatOf } from '../../compat.js'
import { VERSION } from '../../version.js'
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
    if (!r.data?.user || typeof r.data.user.id !== 'string') return failure('openGym answered without a profile; check OPENGYM_URL points at openGym')
    const { id, name, admin } = r.data.user
    return success({ id, name, admin: admin === true, tokenRenewalDue: typeof r.data.token === 'string' })
  },
})

export const readInstance = defineTool({
  name: 'read_instance',
  description:
    'The instance: whether it is up, how many accounts it has, which openGym it runs as far as leap can tell and whether leap can write to it (compatibility), and its configuration (invite-only, guest mode, password login, default language, media limits in MB, and the AI Coach block, null when the Coach is off).',
  input: {},
  async handler(_args, ctx) {
    const [health, config] = await Promise.all([
      ctx.http.request<{ ok: boolean; users?: number; writable?: boolean }>({ method: 'GET', path: '/api/health' }),
      ctx.http.request<Record<string, unknown>>({ method: 'GET', path: '/api/config' }),
    ])
    const compat = compatOf(health)
    if (!health.ok && !(health.status === 503 && compat.openGym !== 'unknown')) return failure('openGym is not reachable or not healthy', health)
    if (!config.ok) return failure('Could not read the instance configuration', config)
    const up = health.ok && health.data.ok === true
    return success({
      url: ctx.config.baseUrl,
      up,
      ...(health.ok ? { users: health.data.users } : {}),
      compatibility: { leap: VERSION, openGym: compat.openGym, supported: compat.supported, leapCanWrite: compat.writable, ...(compat.reason ? { reason: compat.reason } : {}) },
      config: config.data,
    })
  },
})

export const accountReadTools = [readMe, readInstance]
