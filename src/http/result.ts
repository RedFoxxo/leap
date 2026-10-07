/**
 * Outcome of every request. HTTP failures are values, never exceptions, and
 * never a bare `Error`: narrow on `ok`.
 */
export type Result<T> = Ok<T> | Err

export interface Ok<T> {
  ok: true
  status: number
  data: T
}

export interface Err {
  ok: false
  /** HTTP status, or 0 when no response was received (network error, timeout). */
  status: number
  /** One-line summary: openGym's own `error` message when it sent one. */
  message: string
  /** openGym's stable reason (`locked`, `media-quota`, `busy`, ...) when it sent one. */
  code?: string
  /** Seconds from `Retry-After`, on 429 and busy answers. */
  retryAfter?: number
  /** Raw response body (redacted, capped), or the reason no response was received. */
  body: string
  /** `METHOD path`, for diagnostics. */
  request?: string
}

export function ok<T>(data: T, status = 200): Ok<T> {
  return { ok: true, status, data }
}

export function err(status: number, message: string, body = '', request?: string): Err {
  const e: Err = { ok: false, status, message, body }
  if (request !== undefined) e.request = request
  return e
}
