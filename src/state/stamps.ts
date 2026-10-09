import { isRecord, type Entry, type State } from './types.js'

/**
 * The sync stamps openGym (1.3.10 and later) keeps inside the profile document,
 * written the way the app writes them, so a change leap makes merges on every
 * device exactly like a change made in the app. leap writes with
 * `stamped: true`, which tells the server not to correct anything: every stamp
 * below is leap's job.
 *
 * Ported from openGym `frontend/src/lib/sync-merge.js` at v1.4.0 (28b7e4dc):
 * highestStamp, stampChange, stampEntry, stampDeletions, stampEdits and their
 * helpers. Merging and Undo are the app's business and are not ported; leap
 * only keeps the app's Undo markers consistent (settleMarks). See
 * docs/OPENGYM.md, "Sync between devices".
 */

/** Settings maps whose entries carry their own `_ts`; a cleared entry is a stamped entry, never a deleted key. */
export const STAMPED_MAPS = ['balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes'] as const

/** Keys openGym and its sync own: never set by a tool, never stamped as a setting. */
export const SYNC_KEYS = ['_ts', '_rev', '_wid', '_wids', '_unstamped', '_prior', 'deleted', 'edited', 'undone'] as const

/** Top-level keys with a merge of their own, so not stamped in `edited`. */
const OWN_MERGE = new Set<string>([
  ...SYNC_KEYS, 'active', 'unit', 'unitSet', 'resetAt', 'resetIds', 'routineOrder',
  'workouts', 'routines', 'customEx', 'equipProfiles', 'gymCards', 'bodyweight', 'measurements', 'favEx',
  'exWeights', ...STAMPED_MAPS,
])

/** Stamped per key (`edited["week.3"]`): one plan day, one exercise's note or bar. */
const PER_KEY = new Set(['week', 'dayPlan', 'exNotes', 'barWeights'])

/** The order of the routines is a choice of its own. */
const ORDER_KEY = 'routineOrder'

/** A per-key stamp of a key no longer held is dropped after this long. */
const EDIT_KEEP_MS = 180 * 86_400_000

/** Most removal records kept per list; the oldest go first. */
export const DELETED_MAX = 5000

const ENTRY_META = new Set(['id', '_ts', '_f', '_u'])

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stampOf = (v: unknown) => (isRecord(v) ? Number(v._ts) || 0 : 0)
const workoutKey = (w: Entry) => (w.id != null ? String(w.id) : `${String(w.d)}|${String(w.start)}`)
const workoutTime = (w: Entry) => Number(w._ts) || Number(w.end) || Number(w.start) || 0
const ownTime = (x: Entry) => Number(x._ts) || 0
const weighInTime = (e: Entry) => Number(e.t) || 0

/** Lists whose removals are recorded in `deleted`: how an entry is named, and when it was last edited. */
const DELETABLE: Record<string, { key: (x: never) => string; time?: (x: Entry) => number }> = {
  workouts: { key: workoutKey, time: workoutTime },
  routines: { key: (x: Entry) => String(x.id), time: ownTime },
  customEx: { key: (x: Entry) => String(x.id), time: ownTime },
  bodyweight: { key: (e: Entry) => String(e.d), time: weighInTime },
  measurements: { key: (e: Entry) => String(e.d), time: weighInTime },
  gymCards: { key: (x: Entry) => String(x.id), time: ownTime },
  equipProfiles: { key: (x: Entry) => String(x.id), time: ownTime },
  favEx: { key: (x: string) => String(x) },
}

/** An entry without its sync stamps, to compare content. */
export function withoutStamps(entry: unknown): string {
  return isRecord(entry) ? JSON.stringify({ ...entry, _ts: 0, _f: 0, _u: 0 }) : JSON.stringify(entry)
}

/** The latest stamp a document carries: its `_ts`, and every setting, removal and entry stamp. */
export function highestStamp(s: State | null | undefined): number {
  let m = 0
  const see = (v: unknown) => {
    const n = Math.abs(Number(v) || 0)
    if (n > m) m = n
  }
  if (!s) return 0
  see(s._ts)
  if (isRecord(s.unitSet)) see(s.unitSet.at)
  see(s.resetAt)
  if (isRecord(s.edited)) Object.values(s.edited).forEach(see)
  if (isRecord(s.deleted)) for (const f of Object.values(s.deleted)) if (isRecord(f)) Object.values(f).forEach(see)
  for (const f of ['workouts', 'routines', 'customEx', 'equipProfiles', 'gymCards']) {
    for (const x of list(s[f])) {
      if (!isRecord(x)) continue
      see(x._ts)
      if (isRecord(x._f)) Object.values(x._f).forEach(see)
    }
  }
  for (const f of STAMPED_MAPS) if (isRecord(s[f])) Object.values(s[f]).forEach((v) => see(stampOf(v)))
  for (const e of [...list(s.bodyweight), ...list(s.measurements)]) if (isRecord(e)) see(e.t)
  return m
}

/** The time a change made now is stamped with: after every stamp the document it was made on carries. */
export function stampTime(prev: State | null | undefined, wall: number): number {
  return Math.max(Number(wall) || 0, highestStamp(prev) + 1)
}

/**
 * Undo markers (`_u` on an entry, `undone` on the document) brought up to date
 * after a change stamped `now`: a pending marker of a field this change stamped
 * gets `now`; one whose field moved on since is dropped.
 */
function settleMarks(marks: unknown, stamps: Record<string, unknown> | undefined, now: number): Record<string, unknown> | null {
  if (!isRecord(marks)) return null
  const out: Record<string, unknown> = {}
  for (const [k, m] of Object.entries(marks)) {
    if (!Array.isArray(m)) continue
    const at = Number(stamps?.[k]) || 0
    if (m.length === 2 && at === now) out[k] = [Number(m[0]) || 0, Number(m[1]) || 0, now]
    else if (m.length === 3 && at > 0 && Number(m[2]) === at) out[k] = m
  }
  return Object.keys(out).length ? out : null
}

/**
 * Stamps `x`, the new version of an entry whose previous version is `old`, as
 * edited at `now`: its `_ts`, and in `_f` every field that differs from `old`.
 * A new entry gets its `_ts` only.
 */
export function stampEntry(old: Entry | undefined, x: Entry, now: number): Entry {
  x._ts = now
  if (!old) return x
  const f: Record<string, unknown> = isRecord(old._f) ? { ...old._f } : {}
  for (const k of new Set([...Object.keys(old), ...Object.keys(x)])) {
    if (ENTRY_META.has(k)) continue
    if (k in old !== k in x || !same(old[k], x[k])) f[k] = now
  }
  if (Object.keys(f).length) x._f = f
  else delete x._f
  const u = settleMarks(x._u, f, now)
  if (u) x._u = u
  else delete x._u
  return x
}

/** Stamps every entry of `next` that is new or differs from its version in `prev` (routines, custom exercises, …). */
function stampEntries(prev: unknown, next: unknown, now: number, skip: (x: Entry) => boolean = () => false): void {
  const before = new Map(list(prev).filter(isRecord).filter((x) => x.id != null).map((x) => [x.id, x]))
  for (const x of list(next)) {
    if (!isRecord(x) || x.id == null) continue
    const old = before.get(x.id)
    if (!old && skip(x)) continue
    if (!old || (old !== x && withoutStamps(old) !== withoutStamps(x))) stampEntry(old, x, now)
  }
}

function capStamps(m: Record<string, number>): Record<string, number> {
  const keys = Object.keys(m)
  if (keys.length <= DELETED_MAX) return m
  keys.sort((a, b) => Math.abs(m[a]!) - Math.abs(m[b]!))
  for (const k of keys.slice(0, keys.length - DELETED_MAX)) delete m[k]
  return m
}

/**
 * Records in `next.deleted` every entry `prev` had and `next` no longer has,
 * never before the entry's own time, and marks as added back (`-now`) an entry
 * `next` brought in again whose removal was on record (and every favourite starred).
 */
function stampDeletions(prev: State | null, next: State, now: number): void {
  const del: Record<string, unknown> = isRecord(next.deleted) ? next.deleted : {}
  let touched = false
  for (const [field, { key, time }] of Object.entries(DELETABLE)) {
    const before = list(prev?.[field]).filter((x) => x != null)
    const after = list(next[field]).filter((x) => x != null)
    if (prev?.[field] === next[field]) continue
    const name = key as (x: unknown) => string
    const have = new Set(after.map(name))
    const had = new Set(before.map(name))
    const m = (isRecord(del[field]) ? del[field] : {}) as Record<string, number>
    let changed = false
    for (const x of before) {
      const k = name(x)
      if (!have.has(k)) {
        m[k] = Math.max(now, (time && isRecord(x) ? time(x) : 0) + 1)
        changed = true
      }
    }
    for (const k of have) {
      if (had.has(k)) continue
      if (k in m ? m[k]! > 0 : field === 'favEx') {
        m[k] = -now
        changed = true
      }
    }
    if (changed) {
      del[field] = capStamps(m)
      touched = true
    }
  }
  if (touched) next.deleted = del
}

/** Whether two routine lists hold the routines both have in a different order. */
function orderMoved(a: unknown, b: unknown): boolean {
  const ids = (v: unknown) => list(v).filter(isRecord).map((r) => r.id).filter((id) => id != null)
  const ia = ids(a)
  const ib = ids(b)
  const inA = new Set(ia)
  const inB = new Set(ib)
  return !same(ia.filter((id) => inB.has(id)), ib.filter((id) => inA.has(id)))
}

/** Stamps in `next.edited` every setting, plan day, note and bar weight that differs from `prev`. */
function stampEdits(prev: State | null, next: State, now: number): void {
  const ed: Record<string, unknown> = isRecord(next.edited) ? next.edited : {}
  let touched = false
  for (const k of new Set([...Object.keys(prev ?? {}), ...Object.keys(next)])) {
    if (OWN_MERGE.has(k)) continue
    const p = prev?.[k]
    const n = next[k]
    if (PER_KEY.has(k)) {
      if (p === n) continue
      const pm = isRecord(p) ? p : {}
      const nm = isRecord(n) ? n : {}
      for (const s of new Set([...Object.keys(pm), ...Object.keys(nm)])) {
        if (s in pm !== s in nm || !same(pm[s], nm[s])) {
          ed[`${k}.${s}`] = now
          touched = true
        }
      }
    } else if (p !== n && !same(p, n)) {
      ed[k] = now
      touched = true
    }
  }
  if (prev && prev.routines !== next.routines && orderMoved(prev.routines, next.routines)) {
    ed[ORDER_KEY] = now
    touched = true
  }
  // An own accent colour is one choice made in two fields.
  if (touched && next.accent === 'custom' && (ed.accent === now || ed.accentCustom === now)) {
    ed.accent = now
    ed.accentCustom = now
  }
  if (touched) {
    for (const [k, at] of Object.entries(ed)) {
      const dot = k.indexOf('.')
      if (dot < 0 || now - Number(at) < EDIT_KEEP_MS) continue
      const m = next[k.slice(0, dot)]
      if (!isRecord(m) || !(k.slice(dot + 1) in m)) delete ed[k]
    }
    next.edited = ed
  }
  if ('undone' in next) {
    const u = settleMarks(next.undone, ed, now)
    if (u) next.undone = u
    else delete next.undone
  }
}

/**
 * Stamps everything the change from `prev` to `next` touched, at `now` (from
 * stampTime): workouts whose `_ts` a tool moved, routines, custom exercises,
 * equipment profiles and gym cards that differ, stamped-map entries and
 * weigh-ins or measurements a tool re-stamped, removals, settings and plan
 * days. Mutates `next`.
 */
export function stampChange(prev: State | null, next: State, now: number): void {
  const before = new Map(list(prev?.workouts).filter(isRecord).filter((w) => w.id != null).map((w) => [w.id, w]))
  for (const w of list(next.workouts)) {
    if (!isRecord(w) || w.id == null || w._ts == null) continue
    const old = before.get(w.id)
    if (old && w._ts !== old._ts) stampEntry(old, w, now)
  }
  for (const f of STAMPED_MAPS) {
    const p = isRecord(prev?.[f]) ? (prev[f] as Record<string, unknown>) : {}
    const n = next[f]
    if (!isRecord(n)) continue
    for (const [k, v] of Object.entries(n)) if (isRecord(v) && v._ts != null && stampOf(v) !== stampOf(p[k])) v._ts = now
  }
  for (const f of ['bodyweight', 'measurements']) {
    const old = new Map(list(prev?.[f]).filter(isRecord).filter((e) => e.d != null).map((e) => [e.d, e]))
    for (const e of list(next[f])) {
      if (!isRecord(e) || e.d == null || e.t == null) continue
      const was = old.get(e.d)
      if (!was || was.t !== e.t) e.t = Math.max(Number(e.t) || 0, now)
    }
  }
  // A routine put back keeps the edit time it had: its add-back is on record, it was not edited.
  const gone = isRecord(prev?.deleted) && isRecord(prev.deleted.routines) ? prev.deleted.routines : {}
  const putBack = (r: Entry) =>
    Number(gone[String(r.id)]) > 0 && (!(Number(r._ts) > 0) || Number(r._ts) < Number(gone[String(r.id)])) && !list(prev?.routines).some((x) => isRecord(x) && x.id === r.id)
  stampEntries(prev?.routines, next.routines, now, putBack)
  stampEntries(prev?.customEx, next.customEx, now)
  stampEntries(prev?.equipProfiles, next.equipProfiles, now)
  stampEntries(prev?.gymCards, next.gymCards, now)
  stampDeletions(prev, next, now)
  stampEdits(prev, next, now)
}
