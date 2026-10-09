import type { HttpCore } from '../http/core.js'
import { err, ok, type Err, type Result } from '../http/result.js'
import { zoneOf } from '../domain/dates.js'
import type { BackupWriter } from './backup.js'
import { stampChange, stampTime } from './stamps.js'
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
  /** The change left the document as it was, so nothing was written. */
  unchanged?: boolean
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

/**
 * openGym answers 503 "state unreadable" when its stored profile file cannot be read: nothing was
 * written, unlike a 503 from a proxy in front of it.
 */
function unreadable(r: Err): Err | undefined {
  if (r.status !== 503 || !/state unreadable/i.test(r.message)) return undefined
  return err(503, 'openGym cannot read the stored profile (its data file is damaged or unreadable); nothing was written. The instance admin has to look at the server', r.body, r.request)
}

export interface StoreOptions {
  backup?: BackupWriter
  now?: () => number
  /** Checked before every write: whether the server is an openGym version leap can write to. */
  server?: () => Promise<{ ok: true } | { ok: false; message: string }>
}

/**
 * Reads and writes the profile document. Every write is a read-modify-write
 * against the revision it read, so a change made on another device in the
 * meantime is never overwritten: the change is redone on the newer document.
 */
export class StateStore {
  private readonly backup: BackupWriter | undefined
  private readonly now: () => number
  private readonly server: StoreOptions['server']
  /** The time zone of the profile last read; undefined before the first read, null when it has none. */
  private seenZone: string | null | undefined

  constructor(
    private readonly http: HttpCore,
    options: StoreOptions = {},
  ) {
    this.backup = options.backup
    this.now = options.now ?? Date.now
    this.server = options.server
  }

  async load(): Promise<Result<Snapshot>> {
    const r = await this.http.request<{ state: unknown; rev?: number }>({ method: 'GET', path: '/api/data' })
    if (!r.ok) return unreadable(r) ?? r
    const state = r.data?.state
    if (state !== null && state !== undefined && !isRecord(state)) {
      return err(r.status, 'openGym returned a profile document that is not an object', JSON.stringify(state).slice(0, 200))
    }
    this.seenZone = zoneOf(state) ?? null
    return ok({ state: (state ?? null) as State | null, rev: typeof r.data?.rev === 'number' ? r.data.rev : 0 }, r.status)
  }

  /**
   * The user's time zone (domain/dates.ts zoneOf) for deciding what "today" is before a write reads
   * the profile: the one of the profile last read, read once if none was. Undefined: the machine's.
   */
  async zone(): Promise<string | undefined> {
    if (this.seenZone === undefined) await this.load()
    return this.seenZone ?? undefined
  }

  async update<R>(mutate: Mutate<R>, options: UpdateOptions<R> = {}): Promise<Result<Written<R>>> {
    if (this.server) {
      const supported = await this.server()
      if (!supported.ok) return refused(supported.message)
    }
    let base = await this.load()
    if (!base.ok) return base
    let retries = 0
    let backup: string | undefined
    const warnings: string[] = []
    /**
     * Attempts whose outcome is unknown: they may have landed, possibly after a later read. Their check
     * proves a landing only when it fails on the document the attempt was made on (`telling`).
     */
    const lost: { now: number; result: R; telling: boolean }[] = []

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { state: current, rev } = base.data
      const now = stampTime(current, this.now())
      const draft: State = current ? structuredClone(current) : {}
      const decided = mutate(draft, { now })
      if (!decided.ok) return refused(decided.message)
      // Nothing to change: no write, no new revision, and no fresh stamp that would outrank an
      // unsynced edit on another device (the app skips unchanged saves for the same reason).
      if (current && JSON.stringify(draft) === JSON.stringify(current)) {
        return ok({ result: decided.result, rev, retries, notPersisted: [], verified: true, warnings, unchanged: true })
      }

      const problems = checkDocument(draft, current, options)
      if (problems.length > 0) return refused(`leap would write an invalid document, so nothing was sent: ${problems.join('; ')}`)
      stampChange(current, draft, now)
      draft._ts = now
      delete draft._rev
      delete draft.active
      delete draft._unstamped
      delete draft._prior
      const payload: Record<string, unknown> = { state: draft, baseRev: rev, stamped: true }
      if (typeof current?._wid === 'string') payload.baseWid = current._wid
      const body = JSON.stringify(payload)
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

      const put = await this.http.request<{ ok: boolean; rev: number } | null>({ method: 'PUT', path: '/api/data', json: payload })
      if (put.ok && typeof put.data?.rev === 'number') {
        return ok(await this.readBack(decided.result, put.data.rev, now, retries, backup, warnings, options), put.status)
      }
      if (!put.ok) {
        const cannotRead = unreadable(put)
        if (cannotRead) return cannotRead
      }

      // No answer, a proxy in front of openGym that gave up, or a success whose answer could not be
      // read: the write may well have been saved.
      const status = put.status
      const unknown = status === 0 || GATEWAY_ERRORS.has(status) || (status >= 200 && status < 300)
      const telling = options.verify !== undefined && options.verify(current ?? {}, decided.result).length > 0
      if (unknown) lost.push({ now, result: decided.result, telling })
      if (put.status === 409 || unknown) {
        const fresh = await this.load()
        if (!fresh.ok) {
          const what = lost.length ? 'the write may or may not have been applied' : 'another device wrote first'
          return err(fresh.status, `${what}, and re-reading the profile failed: ${fresh.message}`, fresh.body, fresh.request)
        }
        // A lost attempt may have landed, even after an earlier re-read. Redoing it would apply the
        // change twice (a second workout), so look for it: its `_ts`, or the change itself.
        const landed = lost.find((a) => fresh.data.state?._ts === a.now || (a.telling && options.verify!(fresh.data.state ?? {}, a.result).length === 0))
        if (landed) {
          warnings.push('openGym did not confirm the write, but the profile shows it was applied')
          return ok(await this.readBack(landed.result, fresh.data.rev, landed.now, retries, backup, warnings, options, fresh.data), 200)
        }
        if (unknown) warnings.push(`no confirmation for attempt ${attempt} (${put.ok ? 'an answer without a revision' : put.message}); the change is not in the profile, so it was retried`)
        else retries++
        base = fresh
        continue
      }

      return put as Err
    }

    if (lost.length === MAX_ATTEMPTS) {
      return err(0, `openGym did not confirm any of ${MAX_ATTEMPTS} attempts and the change was not in the profile when it was read again; a late one may still land, so read the profile before retrying`)
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
  // Only what this change touched: a key the server already holds in a wrong shape is not leap's to refuse every write over.
  const changed = (key: string) => !before || !sameJson(draft[key], before[key])
  for (const key of LIST_KEYS) {
    if (key in draft && !Array.isArray(draft[key]) && changed(key)) problems.push(`${key} must be a list`)
  }
  for (const key of MAP_KEYS) {
    if (key in draft && !isRecord(draft[key]) && changed(key)) problems.push(`${key} must be an object`)
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

/**
 * Keys only openGym itself writes: the "reset everything" stamp, the Coach's consent and state, and
 * the sync records (leap's own stamping adds to those after this check, see stamps.ts).
 */
const OWN_BOOKKEEPING = ['resetAt', 'resetIds', 'coach', 'deleted', 'edited', 'undone', '_wid', '_wids'] as const

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
