import type { HttpCore } from './http/core.js'
import type { Result } from './http/result.js'
import { OPENGYM } from './version.js'

/**
 * Which openGym the instance runs, as far as leap needs to know. openGym's API
 * does not report its version, so it is told from what the server answers:
 * `GET /api/health` carries `writable` from 1.4.0 on (openGym `api/server.js`
 * at v1.4.0, the health route; at v1.3.10 it answered `{ ok, users }` only).
 */
export interface ServerCompat {
  /** Whether leap may write the profile: openGym 1.4.0 or later with a writable data folder. */
  writable: boolean
  /** What was detected, in words: "1.4.0 or later", "older than 1.4.0". */
  openGym: string
  /** The range this leap release supports. */
  supported: string
  /** Why writes are refused, when they are. */
  reason?: string
}

export function compatOf(health: Result<{ ok?: unknown; writable?: unknown }>): ServerCompat {
  const supported = `${OPENGYM.minimum} or later (tested with ${OPENGYM.tested})`
  if (health.ok) {
    if (health.data?.writable === true) return { writable: true, openGym: `${OPENGYM.minimum} or later`, supported }
    return {
      writable: false,
      openGym: `older than ${OPENGYM.minimum}`,
      supported,
      reason: `this openGym is older than ${OPENGYM.minimum}, which this leap release needs to write safely (sync stamps); update openGym, or use leap 1.0.0 with openGym 1.3.9`,
    }
  }
  if (health.status === 503 && /"writable"\s*:\s*false/.test(health.body)) {
    return { writable: false, openGym: `${OPENGYM.minimum} or later`, supported, reason: 'openGym reports that it cannot write its data folder (disk full or read-only); nothing can be saved until the instance admin fixes it' }
  }
  return { writable: false, openGym: 'unknown', supported, reason: `could not check the openGym version (${health.message}), so nothing was written` }
}

/** How long a refusal is remembered before the server is asked again (it may have been updated). */
const RECHECK_MS = 60_000

/** Asks the server once, remembers a good answer for the session and a bad one briefly. */
export class ServerCheck {
  private last: { at: number; compat: ServerCompat } | undefined

  constructor(
    private readonly http: HttpCore,
    private readonly now: () => number = Date.now,
  ) {}

  async compat(): Promise<ServerCompat> {
    if (this.last && (this.last.compat.writable || this.now() - this.last.at < RECHECK_MS)) return this.last.compat
    const health = await this.http.request<{ ok?: unknown; writable?: unknown }>({ method: 'GET', path: '/api/health' })
    const compat = compatOf(health)
    // Only a real answer is remembered: a network failure or a proxy's error page (openGym restarting)
    // says nothing about the version, so the next write asks again.
    if (health.ok || (health.status === 503 && compat.openGym !== 'unknown')) this.last = { at: this.now(), compat }
    return compat
  }

  async writable(): Promise<{ ok: true } | { ok: false; message: string }> {
    const c = await this.compat()
    return c.writable ? { ok: true } : { ok: false, message: c.reason ?? 'this openGym cannot be written to' }
  }
}
