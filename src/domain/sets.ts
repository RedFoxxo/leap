import { isRecord, type Entry } from '../state/types.js'

/**
 * How openGym reads a logged set row (docs/OPENGYM.md, "Workouts"). A row is a
 * plain record; everything optional is read defensively, since documents come
 * from every app version and from imports.
 */

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const n0 = (v: unknown): number => num(v) ?? (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0)

/** `phase: "warmup"` wins; older rows carry `warmup: true`. */
export function isWarmup(set: Entry): boolean {
  if (typeof set.phase === 'string' && set.phase.trim() !== '') return set.phase.trim().toLowerCase() === 'warmup'
  return set.warmup === true
}

export type SetType = 'straight' | 'dropset' | 'restpause'

export function setType(set: Entry): SetType {
  return set.type === 'dropset' || set.type === 'restpause' ? set.type : 'straight'
}

/** A per-side row logs each limb in `sides.L` / `sides.R`; its own `w`/`r`/`done` only mirror them. */
export function sidesOf(set: Entry): { L: Entry; R: Entry } | undefined {
  const sides = set.sides
  return isRecord(sides) && isRecord(sides.L) && isRecord(sides.R) ? { L: sides.L, R: sides.R } : undefined
}

const list = (v: unknown): Entry[] => (Array.isArray(v) ? v.filter(isRecord) : [])

/** Weight × reps of what was completed: each done side on its own, drops added, rest-pause bursts already in `r`. */
export function completedVolume(set: Entry): number {
  const sides = sidesOf(set)
  if (sides) return completedVolume(sides.L) + completedVolume(sides.R)
  if (set.done !== true) return 0
  const drops = setType(set) === 'dropset' ? list(set.drops).reduce((v, d) => v + n0(d.w) * n0(d.r), 0) : 0
  return n0(set.w) * n0(set.r) + drops
}

/** Completed reps, counting only completed limbs of a per-side row. */
export function completedReps(set: Entry): number {
  const sides = sidesOf(set)
  if (sides) return [sides.L, sides.R].filter((s) => s.done === true).reduce((n, s) => n + Math.max(0, n0(s.r)), 0)
  return set.done === true ? Math.max(0, n0(set.r)) : 0
}

/** Whether any of the row was completed (one side of a per-side row is enough). */
export function hasCompletedWork(set: Entry): boolean {
  const sides = sidesOf(set)
  return sides ? sides.L.done === true || sides.R.done === true : set.done === true
}

/** Set units: a per-side row counts once per side, as the app's "x / y sets" does. */
export const setUnits = (set: Entry): number => (sidesOf(set) ? 2 : 1)
export function doneUnits(set: Entry): number {
  const sides = sidesOf(set)
  if (sides) return (sides.L.done === true ? 1 : 0) + (sides.R.done === true ? 1 : 0)
  return set.done === true ? 1 : 0
}

export type SetMode = 'reps' | 'time' | 'cardio'

export function setMode(set: Entry): SetMode {
  if (set.mode === 'reps' || set.mode === 'time' || set.mode === 'cardio') return set.mode
  if (set.min != null || set.speed != null) return 'cardio'
  if (set.sec != null) return 'time'
  return 'reps'
}

export function entriesOf(workout: Entry): Entry[] {
  return list(workout.entries)
}

export function setsOf(entry: Entry): Entry[] {
  return list(entry.sets)
}

/** Total completed volume of a workout, warm-ups excluded. */
export function workoutVolume(workout: Entry): number {
  let v = 0
  for (const e of entriesOf(workout)) for (const s of setsOf(e)) if (!isWarmup(s)) v += completedVolume(s)
  return v
}

/** Completed weights of an entry's work rows (each done side on its own). */
export function completedWorkWeights(entry: Entry): number[] {
  const out: number[] = []
  for (const s of setsOf(entry)) {
    if (isWarmup(s) || !hasCompletedWork(s)) continue
    const sides = sidesOf(s)
    for (const row of sides ? [sides.L, sides.R].filter((x) => x.done === true) : [s]) {
      const w = num(row.w) ?? (typeof row.w === 'string' ? Number(row.w) : NaN)
      if (Number.isFinite(w)) out.push(w)
    }
  }
  return out
}

/**
 * The best completed working weight of an entry: the heaviest, or for an
 * assistance machine the least assistance (a 0 there is "not entered", not a set
 * without help). 0 when nothing qualifies, as for body-weight-only work.
 */
export function bestWeight(entry: Entry, assisted = false): number {
  const weights = completedWorkWeights(entry)
  if (assisted) {
    const positive = weights.filter((w) => w > 0)
    return positive.length ? Math.min(...positive) : 0
  }
  return weights.length ? Math.max(0, ...weights) : 0
}

/** The routine a workout entry was planned by: its own `rid` on combined days, else the workout's. */
export function entryRoutineId(workout: Entry, entry: Entry): string | null {
  if (typeof entry.rid === 'string' && entry.rid) return entry.rid
  if (entriesOf(workout).some((e) => typeof e.rid === 'string' && e.rid)) return null
  return routineIdsOf(workout)[0] ?? null
}

/** A workout's routines: `routineIds` (combined days), else `routineId`. */
export function routineIdsOf(workout: Entry): string[] {
  const ids = Array.isArray(workout.routineIds) ? workout.routineIds : workout.routineId != null ? [workout.routineId] : []
  return ids.filter((x): x is string => typeof x === 'string' && x !== '')
}

const pick = (from: Entry, keys: readonly string[]): Entry => {
  const out: Entry = {}
  for (const k of keys) if (from[k] !== undefined && from[k] !== null) out[k] = from[k]
  return out
}

const SIDE_KEYS = ['w', 'r', 'done', 'rir', 'rpe', 'type', 'drops', 'clusters'] as const
const ROW_KEYS = ['w', 'r', 'done', 'rir', 'rpe', 'sec', 'min', 'speed', 'drops', 'clusters'] as const

/** A set row for tool output: what was logged, with its kind spelled out. */
export function describeSet(set: Entry, index: number): Entry {
  const out: Entry = { n: index + 1 }
  if (isWarmup(set)) out.kind = 'warmup'
  const type = setType(set)
  if (type !== 'straight') out.type = type
  const mode = setMode(set)
  if (mode !== 'reps') out.mode = mode
  Object.assign(out, pick(set, ROW_KEYS))
  if (out.done === undefined) out.done = false
  const sides = sidesOf(set)
  if (sides) out.sides = { L: pick(sides.L, SIDE_KEYS), R: pick(sides.R, SIDE_KEYS) }
  return out
}
