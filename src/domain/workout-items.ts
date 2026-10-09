import { isRecord, type Entry } from '../state/types.js'
import { isWarmup, setType, sidesOf } from './sets.js'

/**
 * A logged set and a workout entry as openGym stores them, and as leap's tools
 * read and write them. read_workout returns the tool format, so a workout can
 * be read, changed and written back as it is (docs/OPENGYM.md, "Workouts").
 */

type Drops = { weight: number; reps: number }[] | undefined
type Clusters = { reps: number; restSec?: number | undefined }[] | undefined

/** One limb of a per-side set; since openGym 1.3.x a side carries its own drop set or rest-pause. */
export interface SideInput {
  weight?: number | undefined
  reps: number
  done?: boolean | undefined
  rir?: number | undefined
  rpe?: number | undefined
  drops?: Drops
  clusters?: Clusters
  /** Fields openGym keeps on the side that leap does not manage (from read_workout); kept as they are. */
  other?: Record<string, unknown> | undefined
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
  drops?: Drops
  clusters?: Clusters
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

/** Side fields leap writes; anything else on a stored side comes back through the side's `other`. */
const MANAGED_SIDE_KEYS: ReadonlySet<string> = new Set(['w', 'r', 'done', 'rir', 'rpe', 'type', 'drops', 'clusters'])

const withEffort = (row: Entry, s: { rir?: number | undefined; rpe?: number | undefined }) => {
  if (s.rir !== undefined) row.rir = s.rir
  if (s.rpe !== undefined) row.rpe = s.rpe
  return row
}

const withIntensifier = (row: Entry, s: { drops?: Drops; clusters?: Clusters }) => {
  if (s.drops) {
    row.type = 'dropset'
    row.drops = s.drops.map((d) => ({ w: d.weight, r: d.reps }))
  }
  if (s.clusters) {
    row.type = 'restpause'
    row.clusters = s.clusters.map((c) => ({ r: c.reps, ...(c.restSec !== undefined ? { restSec: c.restSec } : {}) }))
  }
  return row
}

const withOther = (row: Entry, other: Record<string, unknown> | undefined, managed: ReadonlySet<string>) => {
  if (other) for (const [k, v] of Object.entries(other)) if (!managed.has(k) && !(k in row)) row[k] = v
  return row
}

function storedSide(s: SideInput, done: boolean): Entry {
  const side = withIntensifier(withEffort({ w: s.weight ?? 0, r: s.reps, done: s.done ?? done }, s), s)
  return withOther(side, s.other, MANAGED_SIDE_KEYS)
}

/**
 * A set as openGym stores it. A per-side row mirrors its sides (heavier weight, summed reps,
 * done when both are, the harder effort) and their drop set or rest-pause type, which lives on
 * the sides (openGym `workout-model.js` syncSideAggregate, v1.4.0, 28b7e4dc).
 */
export function storedSet(s: SetInput): Entry {
  const done = s.done ?? true
  let row: Entry
  if (s.left && s.right) {
    const L = storedSide(s.left, done)
    const R = storedSide(s.right, done)
    row = { w: Math.max(Number(L.w), Number(R.w)), r: Number(L.r) + Number(R.r), done: L.done === true && R.done === true, sides: { L, R } }
    const rirs = [L.rir, R.rir].filter((v): v is number => typeof v === 'number')
    const rpes = [L.rpe, R.rpe].filter((v): v is number => typeof v === 'number')
    if (rirs.length) row.rir = Math.min(...rirs)
    else if (rpes.length) row.rpe = Math.max(...rpes)
    const type = setType(L) !== 'straight' ? setType(L) : setType(R)
    if (type !== 'straight') row.type = type
  } else if (s.min !== undefined || s.speed !== undefined) {
    row = { ...(s.min !== undefined ? { min: s.min } : {}), ...(s.speed !== undefined ? { speed: s.speed } : {}), done }
  } else if (s.sec !== undefined) {
    row = withEffort({ sec: s.sec, w: s.weight ?? 0, done }, s)
  } else {
    row = withIntensifier(withEffort({ w: s.weight ?? 0, r: s.reps ?? 0, done }, s), s)
  }
  if (s.warmup) row.phase = 'warmup'
  else if (s.failure) row.failure = true
  if (s.max) row.max = true
  if (s.incline !== undefined && s.incline > 0 && row.min !== undefined) row.incline = s.incline
  if (s.side && row.sec !== undefined) row.side = s.side
  return withOther(row, s.other, MANAGED_SET_KEYS)
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const effortOf = (row: Entry) => ({ ...(num(row.rir) !== undefined ? { rir: row.rir } : {}), ...(num(row.rpe) !== undefined ? { rpe: row.rpe } : {}) })

/** A row's (or a side's) drops or rest-pause bursts in the tool format. */
function intensifierOf(row: Entry): Entry {
  const type = setType(row)
  if (type === 'dropset' && Array.isArray(row.drops)) return { drops: row.drops.filter(isRecord).map((d) => ({ weight: num(d.w) ?? 0, reps: num(d.r) ?? 0 })) }
  if (type === 'restpause' && Array.isArray(row.clusters)) {
    return { clusters: row.clusters.filter(isRecord).map((c) => ({ reps: num(c.r) ?? 0, ...(num(c.restSec) !== undefined ? { restSec: c.restSec } : {}) })) }
  }
  return {}
}

const otherOf = (row: Entry, managed: ReadonlySet<string>) => {
  const other = Object.fromEntries(Object.entries(row).filter(([k, v]) => !managed.has(k) && v !== undefined))
  return Object.keys(other).length ? { other } : {}
}

/** A stored set in the tool format. */
export function setForTools(row: Entry): Entry {
  const out: Entry = {}
  const sides = sidesOf(row)
  if (sides) {
    const side = (s: Entry) => ({ weight: num(s.w) ?? 0, reps: num(s.r) ?? 0, done: s.done === true, ...effortOf(s), ...intensifierOf(s), ...otherOf(s, MANAGED_SIDE_KEYS) })
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
  return Object.assign(out, intensifierOf(row), otherOf(row, MANAGED_SET_KEYS))
}

/** Entry fields leap writes; everything else on an entry (target, planned, muscleSnapshot, noProg, ...) is kept as it is. */
export const MANAGED_ENTRY_KEYS: ReadonlySet<string> = new Set(['id', 'sets', 'topW', 'note', 'notePin', 'sg', 'rid'])

/** The session name the app derives from its routines: up to three joined, then "A + B + N more". */
export function sessionName(names: string[]): string {
  if (!names.length) return 'Freestyle'
  if (names.length <= 3) return names.join(' + ')
  return `${names[0]} + ${names[1]} + ${names.length - 2} more`
}
