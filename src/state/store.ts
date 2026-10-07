import type { HttpCore } from '../http/core.js'
import { err, ok, type Err, type Result } from '../http/result.js'
import type { BackupWriter } from './backup.js'
import { isRecord, LIST_KEYS, MAP_KEYS, type Snapshot, type State } from './types.js'

/** What a change function decides: apply (with a result to report) or refuse (nothing is sent). */
export type Mutation<R> = { ok: true; result: R } | { ok: false; message: string }

export const apply = <R>(result: R): Mutation<R> => ({ ok: true, result })
export const refuse = (message: string): Mutation<never> => ({ ok: false, message })

export interface MutateContext {
  /** The write's timestamp (ms): stamp changed entries with it (`_ts`, or `t` on weigh-ins). */
  now: number
}

/**
 * Changes `draft` in place, a private copy of the current document. Called
 * again on the fresh document after a conflict, so it must decide from
 * `draft` alone.
 */
export type Mutate<R> = (draft: State, ctx: MutateContext) => Mutation<R>

export interface UpdateOptions<R> {
  /** Checks the read-back document. Returns a line per requested value that did not persist. */
  verify?: (state: State, result: R) => string[]
  /** Allow the change to touch `unit` (a deliberate unit switch only). */
  allowUnitChange?: boolean
}

export interface Written<R> {
  result: R
  /** The revision this write produced. */
  rev: number
  /** Conflicts with another device's write that were redone on its newer document. */
  retries: number
  /** Copy of the document as it was before the write. */
  backup?: string
  /** Requested values missing from the read-back; empty when everything persisted. */
  notPersisted: string[]
  /** False when the read-back failed: `notPersisted` is then unknown. */
  verified: boolean
  warnings: string[]
}

/** openGym's body limit is 5 MiB. Stay clearly below it. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024 - 64 * 1024
const MAX_ATTEMPTS = 4
/** Answers from a reverse proxy that cut the request short; openGym itself may have saved it. */
const GATEWAY_ERRORS = new Set([502, 503, 504])

/** A change refused before anything was sent; `code: "refused"`. */
function refused(message: string): Err {
  const e = err(0, message)
  e.code = 'refused'
  return e
}

export interface StoreOptions {
  backup?: BackupWriter
  now?: () => number
}

/**
 * Reads and writes the profile document. Every write is a read-modify-write
 * against the revision it read, so a change made on another device in the
 * meantime is never overwritten: the change is redone on the newer document.
 */
export class StateStore {
  private readonly backup: BackupWriter | undefined
  private readonly now: () => number

  constructor(
    private readonly http: HttpCore,
    options: StoreOptions = {},
  ) {
    this.backup = options.backup
    this.now = options.now ?? Date.now
  }

  async load(): Promise<Result<Snapshot>> {
    const r = await this.http.request<{ state: unknown; rev?: number }>({ method: 'GET', path: '/api/data' })
    if (!r.ok) return r
    const state = r.data?.state
    if (state !== null && state !== undefined && !isRecord(state)) {
      return err(r.status, 'openGym returned a profile document that is not an object', JSON.stringify(state).slice(0, 200))
    }
    return ok({ state: (state ?? null) as State | null, rev: typeof r.data?.rev === 'number' ? r.data.rev : 0 }, r.status)
  }

  async update<R>(mutate: Mutate<R>, options: UpdateOptions<R> = {}): Promise<Result<Written<R>>> {
    let base = await this.load()
    if (!base.ok) return base
    let retries = 0
    let backup: string | undefined
    const warnings: string[] = []
    /** Attempts whose outcome is unknown: they may have landed, possibly after a later read. */
    const lost: { now: number; result: R }[] = []

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { state: current, rev } = base.data
      const now = Math.max(this.now(), (typeof current?._ts === 'number' ? current._ts : 0) + 1)
      const draft: State = current ? structuredClone(current) : {}
      const decided = mutate(draft, { now })
      if (!decided.ok) return refused(decided.message)

      draft._ts = now
      delete draft._rev
      delete draft.active
      const problems = checkDocument(draft, current, options)
      if (problems.length > 0) return refused(`leap would write an invalid document, so nothing was sent: ${problems.join('; ')}`)
      const body = JSON.stringify({ state: draft, baseRev: rev })
      if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) {
        return refused(`the profile would exceed openGym's 5 MiB limit (${Buffer.byteLength(body)} bytes)`)
      }

      if (current && this.backup) {
        try {
          backup = this.backup(current, rev)
        } catch (error) {
          return refused(`could not back up the profile before writing, so nothing was sent (${error instanceof Error ? error.message : String(error)})`)
        }
      }

      const put = await this.http.request<{ ok: boolean; rev: number }>({ method: 'PUT', path: '/api/data', json: { state: draft, baseRev: rev } })
      if (put.ok) {
        return ok(await this.readBack(decided.result, put.data.rev, now, retries, backup, warnings, options), put.status)
      }

      // No answer, or a proxy in front of openGym that gave up: the write may still have been saved.
      const unknown = put.status === 0 || GATEWAY_ERRORS.has(put.status)
      if (unknown) lost.push({ now, result: decided.result })
      if (put.status === 409 || unknown) {
        const fresh = await this.load()
        if (!fresh.ok) {
          const what = lost.length ? 'the write may or may not have been applied' : 'another device wrote first'
          return err(fresh.status, `${what}, and re-reading the profile failed: ${fresh.message}`, fresh.body, fresh.request)
        }
        // A lost attempt may have landed, even after an earlier re-read. Redoing it would apply the
        // change twice (a second workout), so look for it: its `_ts`, or the change itself.
        const landed = lost.find((a) => fresh.data.state?._ts === a.now || (options.verify !== undefined && options.verify(fresh.data.state ?? {}, a.result).length === 0))
        if (landed) {
          warnings.push('openGym did not confirm the write, but the profile shows it was applied')
          return ok(await this.readBack(landed.result, fresh.data.rev, landed.now, retries, backup, warnings, options, fresh.data), 200)
        }
        if (unknown) warnings.push(`no confirmation for attempt ${attempt} (${put.message}); the change is not in the profile, so it was retried`)
        else retries++
        base = fresh
        continue
      }

      return put
    }

    if (lost.length === MAX_ATTEMPTS) {
      return err(0, `openGym did not confirm any of ${MAX_ATTEMPTS} attempts and the change is not in the profile; nothing of it was saved`)
    }
    return err(409, `another device kept writing to the profile; gave up after ${MAX_ATTEMPTS} attempts, nothing of this change was saved`)
  }

  private async readBack<R>(
    result: R,
    rev: number,
    stamp: number,
    retries: number,
    backup: string | undefined,
    warnings: string[],
    options: UpdateOptions<R>,
    known?: Snapshot,
  ): Promise<Written<R>> {
    const written: Written<R> = { result, rev, retries, notPersisted: [], verified: false, warnings }
    if (backup) written.backup = backup
    const after = known ? ok(known) : await this.load()
    if (!after.ok) {
      warnings.push(`saved as revision ${rev}, but reading it back failed (${after.message}); not verified`)
      return written
    }
    const state = after.data.state ?? {}
    if (after.data.rev > rev && state._ts !== stamp) {
      warnings.push(`another device wrote right after (revision ${after.data.rev}); checked against its version`)
    }
    written.notPersisted = options.verify ? options.verify(state, result) : []
    written.verified = true
    return written
  }
}

/** Guards against leap itself building a document the app or server would choke on. */
export function checkDocument(draft: State, before: State | null, options: { allowUnitChange?: boolean } = {}): string[] {
  const problems: string[] = []
  for (const key of LIST_KEYS) {
    if (key in draft && !Array.isArray(draft[key])) problems.push(`${key} must be a list`)
  }
  for (const key of MAP_KEYS) {
    if (key in draft && !isRecord(draft[key])) problems.push(`${key} must be an object`)
  }
  if (!Object.keys(draft).some((k) => k !== '_rev' && k !== '_ts')) problems.push('the document would be empty')
  if (!before) return problems
  if (!options.allowUnitChange) {
    for (const key of ['unit', 'unitSet']) {
      if (!sameJson(draft[key], before[key])) problems.push(`${key} would change; weights are stored in the profile's unit`)
    }
  }
  for (const key of OWN_BOOKKEEPING) {
    if (!sameJson(draft[key], before[key])) problems.push(`${key} is openGym's own bookkeeping and must not change`)
  }
  return problems
}

/** Keys only openGym itself writes: the "reset everything" stamp and the Coach's consent and state. */
const OWN_BOOKKEEPING = ['resetAt', 'resetIds', 'coach'] as const

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
