import { isRecord, type Entry } from '../state/types.js'
import { volumeFactor } from './dumbbells.js'

/**
 * How openGym reads a logged set row (docs/OPENGYM.md, "Workouts"). A row is a
 * plain record; everything optional is read defensively, since documents come
 * from every app version and from imports.
 */

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const n0 = (v: unknown): number => num(v) ?? (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * A set `phase` ("warmup", "warm-up" or "warm_up") wins; older rows carry `warmup: true`
 * (openGym `workout-model.js` phaseForSet, v1.4.0, 28b7e4dc).
 */
export function isWarmup(set: Entry): boolean {
  if (set.phase != null && set.phase !== '') {
    const token = typeof set.phase === 'string' ? set.phase.trim().toLowerCase() : ''
    return token === 'warmup' || token === 'warm-up' || token === 'warm_up'
  }
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

const MODES: readonly string[] = ['reps', 'time', 'cardio']
const token = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function modeFromUnit(v: unknown): SetMode | null {
  const t = token(v)
  if (['rep', 'reps', 'repetition', 'repetitions'].includes(t)) return 'reps'
  if (['sec', 'secs', 'second', 'seconds'].includes(t)) return 'time'
  if (['min', 'mins', 'minute', 'minutes'].includes(t)) return 'cardio'
  return null
}

const explicitMode = (s: Entry): SetMode | null => (MODES.includes(token(s.mode)) ? (token(s.mode) as SetMode) : modeFromUnit(s.unit))

function inferredMode(s: Entry): SetMode | null {
  const explicit = explicitMode(s)
  if (explicit) return explicit
  if (token(s.mode) === 'amrap') return 'reps'
  if (s.min != null || s.speed != null) return 'cardio'
  if (s.sec != null || s.seconds != null || s.durationSec != null) return 'time'
  if (s.r != null || s.reps != null || s.actualReps != null) return 'reps'
  return null
}

/**
 * A row's mode as openGym resolves it: the row's own mode (or unit), then the entry's target
 * (the routine exercise it was planned by), then the row's fields
 * (`workout-model.js` modeForSet, v1.4.0, 28b7e4dc).
 */
export function setMode(set: Entry, target: Entry = {}): SetMode {
  return explicitMode(set) ?? inferredMode(target) ?? inferredMode(set) ?? 'reps'
}

/** What an entry's rows are read against: its target, else the entry itself, as the app does. */
export const targetOf = (entry: Entry): Entry => (isRecord(entry.target) ? entry.target : entry)

export function entriesOf(workout: Entry): Entry[] {
  return list(workout.entries)
}

export function setsOf(entry: Entry): Entry[] {
  return list(entry.sets)
}

/** Completed volume of one entry, warm-ups excluded; a dumbbell entry logged per bell counts both bells. */
export function entryVolume(entry: Entry, name = ''): number {
  const f = volumeFactor(entry, name)
  return setsOf(entry).reduce((v, s) => v + (isWarmup(s) ? 0 : completedVolume(s) * f), 0)
}

/**
 * Total completed volume of a workout, warm-ups excluded, as openGym 1.4.0 counts it
 * (`history.js` workoutVolume): `nameOf` gives an exercise's name, which tells a one-arm
 * dumbbell exercise (one bell) from a two-handed one.
 */
export function workoutVolume(workout: Entry, nameOf: (id: string) => string = () => ''): number {
  return entriesOf(workout).reduce((v, e) => v + entryVolume(e, nameOf(String(e.id))), 0)
}

/**
 * The best completed working weight of an entry: the heaviest, or for an
 * assistance machine the least assistance (a 0 there is "not entered", not a set
 * without help). Reps rows decide when there are any (a timed row's added load
 * counts only without them); each done side on its own. When no row gives a
 * usable weight, an old record's stored `topW` stands in, unless the entry has
 * warm-ups or rows that are not reps. 0 when nothing qualifies, as for
 * body-weight-only work. Ported from openGym `history.js` bestWeightForEntry
 * (v1.4.0, 28b7e4dc).
 */
export function bestWeight(entry: Entry, assisted = false): number {
  const target = targetOf(entry)
  const work = setsOf(entry).filter((s) => !isWarmup(s))
  const done = work.filter(hasCompletedWork)
  const reps = done.filter((s) => setMode(s, target) === 'reps')
  let best = 0
  let usable = false
  for (const s of reps.length ? reps : done) {
    const sides = sidesOf(s)
    for (const row of sides ? [sides.L, sides.R].filter((x) => x.done === true) : [s]) {
      const w = Number(row.w)
      if (!Number.isFinite(w) || (assisted && !(w > 0))) continue
      best = !usable ? w : assisted ? Math.min(best, w) : Math.max(best, w)
      usable = true
    }
  }
  if (usable) return best
  const topW = Number(entry.topW)
  const onlyReps = setMode({}, target) === 'reps' && !work.some((s) => setMode(s, target) !== 'reps')
  return onlyReps && !setsOf(entry).some(isWarmup) && Number.isFinite(topW) ? topW : 0
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

