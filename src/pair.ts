import type { HttpCore } from './http/core.js'
import { err, ok, type Result } from './http/result.js'

/** The alphabet openGym uses for pairing codes: no 0/O/1/I. */
const CODE = /^[A-HJ-NP-Z2-9]{8}$/

export function normalizeCode(raw: string): string | undefined {
  const code = raw.replace(/[\s-]/g, '').toUpperCase()
  return CODE.test(code) ? code : undefined
}

export interface Paired {
  token: string
  user: { id: string; name: string; admin?: boolean }
}

/**
 * Redeems a pairing code (openGym Settings → "Pair the mobile app") for the
 * same Bearer token the phone app gets. The code is one-shot and expires after
 * five minutes.
 */
export async function redeem(http: HttpCore, rawCode: string): Promise<Result<Paired>> {
  const code = normalizeCode(rawCode)
  if (!code) return err(0, 'A pairing code is 8 characters from A-Z and 2-9 (no 0, O, 1 or I)')
  const r = await http.request<Paired>({ method: 'POST', path: '/api/pair/redeem', json: { code }, keepTokens: true })
  if (!r.ok) return r.code === 'pair-invalid' ? { ...r, message: `${r.message} (the code is wrong, already used or expired; make a new one in openGym)` } : r
  if (typeof r.data?.token !== 'string' || !r.data.token) return err(r.status, 'openGym accepted the code but sent no token')
  return ok(r.data, r.status)
}
