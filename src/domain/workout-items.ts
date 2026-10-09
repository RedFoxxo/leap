import { isRecord, type Entry } from '../state/types.js'
import { isWarmup, setType, sidesOf } from './sets.js'

/**
 * A logged set and a workout entry as openGym stores them, and as leap's tools
 * read and write them. read_workout returns the tool format, so a workout can
 * be read, changed and written back as it is (docs/OPENGYM.md, "Workouts").
 */

export interface SideInput {
  weight?: number | undefined
  reps: number
  done?: boolean | undefined
  rir?: number | undefined
  rpe?: number | undefined
}

export interface SetInput {
  weight?: number | undefined
  reps?: number | undefined
  done?: boolean | undefined
  warmup?: boolean | undefined
  rir?: number | undefined
  rpe?: number | undefined
  sec?: number | undefined
  min?: number | undefined
  speed?: number | undefined
  drops?: { weight: number; reps: number }[] | undefined
  clusters?: { reps: number; restSec?: number | undefined }[] | undefined
  left?: SideInput | undefined
  right?: SideInput | undefined
  /** Taken to failure (the app's "F"; counts as RIR 0 unless rated). */
  failure?: boolean | undefined
  /** A pyramid's "Max" set: as many reps as possible. */
  max?: boolean | undefined
  /** Cardio: incline in percent. */
  incline?: number | undefined
  /** Timed hold per side: which side this row is (the app logs L and R as two rows). */
  side?: 'L' | 'R' | undefined
  /** Fields openGym keeps on the row that leap does not manage (from read_workout); kept as they are. */
  other?: Record<string, unknown> | undefined
}

/** Row fields leap writes; anything else on a stored row is openGym's own and comes back through `other`. */
export const MANAGED_SET_KEYS: ReadonlySet<string> = new Set([
  'w', 'r', 'done', 'rir', 'rpe', 'sec', 'min', 'speed', 'drops', 'clusters', 'sides', 'type', 'phase', 'warmup', 'failure', 'max', 'incline', 'side',
])

const withEffort = (row: Entry, s: { rir?: number | undefined; rpe?: number | undefined }) => {
  if (s.rir !== undefined) row.rir = s.rir
  if (s.rpe !== undefined) row.rpe = s.rpe
  return row
}

/** A set as openGym stores it: a per-side row mirrors its sides (heavier weight, summed reps, done when both are, the harder effort). */
export function storedSet(s: SetInput): Entry {
  const done = s.done ?? true
  let row: Entry
  if (s.left && s.right) {
    const L = withEffort({ w: s.left.weight ?? 0, r: s.left.reps, done: s.left.done ?? done }, s.left)
    const R = withEffort({ w: s.right.weight ?? 0, r: s.right.reps, done: s.right.done ?? done }, s.right)
    row = { w: Math.max(Number(L.w), Number(R.w)), r: Number(L.r) + Number(R.r), done: L.done === true && R.done === true, sides: { L, R } }
    const rirs = [L.rir, R.rir].filter((v): v is number => typeof v === 'number')
    const rpes = [L.rpe, R.rpe].filter((v): v is number => typeof v === 'number')
    if (rirs.length) row.rir = Math.min(...rirs)
    else if (rpes.length) row.rpe = Math.max(...rpes)
  } else if (s.min !== undefined || s.speed !== undefined) {
    row = { ...(s.min !== undefined ? { min: s.min } : {}), ...(s.speed !== undefined ? { speed: s.speed } : {}), done }
  } else if (s.sec !== undefined) {
    row = withEffort({ sec: s.sec, w: s.weight ?? 0, done }, s)
  } else {
    row = withEffort({ w: s.weight ?? 0, r: s.reps ?? 0, done }, s)
  }
  if (s.drops) {
    row.type = 'dropset'
    row.drops = s.drops.map((d) => ({ w: d.weight, r: d.reps }))
  }
  if (s.clusters) {
    row.type = 'restpause'
    row.clusters = s.clusters.map((c) => ({ r: c.reps, ...(c.restSec !== undefined ? { restSec: c.restSec } : {}) }))
  }
  if (s.warmup) row.phase = 'warmup'
  else if (s.failure) row.failure = true
  if (s.max) row.max = true
  if (s.incline !== undefined && s.incline > 0 && row.min !== undefined) row.incline = s.incline
  if (s.side && row.sec !== undefined) row.side = s.side
  if (s.other) for (const [k, v] of Object.entries(s.other)) if (!MANAGED_SET_KEYS.has(k) && !(k in row)) row[k] = v
  return row
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const effortOf = (row: Entry) => ({ ...(num(row.rir) !== undefined ? { rir: row.rir } : {}), ...(num(row.rpe) !== undefined ? { rpe: row.rpe } : {}) })

/** A stored set in the tool format. */
export function setForTools(row: Entry): Entry {
  const out: Entry = {}
  const sides = sidesOf(row)
  if (sides) {
    const side = (s: Entry) => ({ weight: num(s.w) ?? 0, reps: num(s.r) ?? 0, done: s.done === true, ...effortOf(s) })
    out.left = side(sides.L)
    out.right = side(sides.R)
  } else if (row.min != null || row.speed != null) {
    if (num(row.min) !== undefined) out.min = row.min
    if (num(row.speed) !== undefined) out.speed = row.speed
    out.done = row.done === true
  } else if (row.sec != null) {
    Object.assign(out, { sec: num(row.sec) ?? 0, weight: num(row.w) ?? 0, done: row.done === true }, effortOf(row))
  } else {
    Object.assign(out, { weight: num(row.w) ?? 0, reps: num(row.r) ?? 0, done: row.done === true }, effortOf(row))
  }
  if (isWarmup(row)) out.warmup = true
  else if (row.failure === true) out.failure = true
  if (row.max === true) out.max = true
  if (num(row.incline) !== undefined && Number(row.incline) > 0) out.incline = row.incline
  if (row.side === 'L' || row.side === 'R') out.side = row.side
  const type = setType(row)
  if (type === 'dropset' && Array.isArray(row.drops)) out.drops = row.drops.filter(isRecord).map((d) => ({ weight: num(d.w) ?? 0, reps: num(d.r) ?? 0 }))
  if (type === 'restpause' && Array.isArray(row.clusters)) {
    out.clusters = row.clusters.filter(isRecord).map((c) => ({ reps: num(c.r) ?? 0, ...(num(c.restSec) !== undefined ? { restSec: c.restSec } : {}) }))
  }
  const other = Object.fromEntries(Object.entries(row).filter(([k, v]) => !MANAGED_SET_KEYS.has(k) && v !== undefined))
  if (Object.keys(other).length) out.other = other
  return out
}

/** Entry fields leap writes; everything else on an entry (target, planned, muscleSnapshot, noProg, ...) is kept as it is. */
export const MANAGED_ENTRY_KEYS: ReadonlySet<string> = new Set(['id', 'sets', 'topW', 'note', 'notePin', 'sg', 'rid'])

/** The session name the app derives from its routines: up to three joined, then "A + B + N more". */
export function sessionName(names: string[]): string {
  if (!names.length) return 'Freestyle'
  if (names.length <= 3) return names.join(' + ')
  return `${names[0]} + ${names[1]} + ${names.length - 2} more`
}
