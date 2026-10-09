import type { ExerciseIndex } from '../../catalog/exercises.js'
import { localDateTime, zoneOf } from '../../domain/dates.js'
import { routineName } from '../../domain/plan.js'
import {
  bestWeight,
  doneUnits,
  entriesOf,
  entryRoutineId,
  entryVolume,
  isWarmup,
  routineIdsOf,
  setsOf,
  setUnits,
  workoutVolume,
} from '../../domain/sets.js'
import { entryDbLoad } from '../../domain/dumbbells.js'
import { isRecord, type Entry, type State } from '../../state/types.js'
import { MANAGED_ENTRY_KEYS, setForTools } from '../../domain/workout-items.js'
import { workoutKey } from '../../domain/workouts.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** An entry's exercise name; a deleted custom exercise's entries carry its name in `n`. */
export function entryName(exercises: ExerciseIndex, entry: Entry): string {
  const id = String(entry.id)
  return exercises.get(id)?.name ?? str(entry.n) ?? id
}

/** Rounds away float noise (33.75 × 12 sums) without hiding real decimals. */
export const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits

function setCounts(workout: Entry) {
  let done = 0
  let total = 0
  let work = 0
  for (const e of entriesOf(workout)) {
    for (const s of setsOf(e)) {
      total += setUnits(s)
      done += doneUnits(s)
      if (!isWarmup(s)) work += doneUnits(s)
    }
  }
  return { done, total, work }
}

function durationMin(workout: Entry): number | undefined {
  const start = finite(workout.start)
  const end = finite(workout.end)
  return start !== undefined && end !== undefined && end >= start ? Math.round((end - start) / 60_000) : undefined
}

function mediaCount(workout: Entry): number {
  return Array.isArray(workout.media) ? workout.media.filter(isRecord).length : 0
}

/** One line per workout for lists. */
export function workoutSummary(workout: Entry, state: State | null, exercises: ExerciseIndex): Entry {
  const routines = routineIdsOf(workout)
  const stored = finite(workout.vol)
  const prs = Array.isArray(workout.prs) ? workout.prs.filter((x): x is string => typeof x === 'string') : []
  const out: Entry = {
    id: workoutKey(workout),
    date: workout.d,
    name: str(workout.name) ?? (routines.length ? routines.map((r) => routineName(state, r)).join(' + ') : 'Workout'),
  }
  if (routines.length) out.routines = routines.map((id) => ({ id, name: routineName(state, id) }))
  const start = localDateTime(workout.start, zoneOf(state))
  if (start) out.start = start
  const minutes = durationMin(workout)
  if (minutes !== undefined) out.durationMin = minutes
  out.exercises = entriesOf(workout).map((e) => entryName(exercises, e))
  out.sets = setCounts(workout)
  out.volume = round(stored ?? workoutVolume(workout, (id) => exercises.name(id)))
  if (prs.length) out.prs = prs.map((id) => exercises.name(id))
  if (finite(workout.bw) !== undefined) out.bodyWeight = workout.bw
  const note = str(workout.note)
  if (note) out.note = note
  const media = mediaCount(workout)
  if (media) out.media = media
  return out
}

/** Set by set, with names, per-exercise volume and best weight. */
export function workoutDetail(workout: Entry, state: State | null, exercises: ExerciseIndex): Entry {
  const summary = workoutSummary(workout, state, exercises)
  delete summary.exercises
  const end = localDateTime(workout.end, zoneOf(state))
  if (end) summary.end = end
  if (workout.excludeFromProgression === true) summary.excludeFromProgression = true
  summary.entries = entriesOf(workout).map((e, i) => {
    const id = String(e.id)
    const sets = setsOf(e)
    // The format write_update_workout takes back as it is; position, name, routineName, volume, weightMeans and bestWeight are for reading.
    const out: Entry = { position: i + 1, name: entryName(exercises, e), exerciseId: id, sets: sets.map(setForTools) }
    const note = str(e.note)
    if (note) out.note = note
    if (str(e.sg)) out.superset = e.sg
    if (typeof e.rid === 'string' && e.rid) out.routineId = e.rid
    const rid = entryRoutineId(workout, e)
    if (rid && routineIdsOf(workout).length > 1) out.routineName = routineName(state, rid)
    out.volume = round(entryVolume(e, entryName(exercises, e)))
    const meaning = entryDbLoad(e)
    if (meaning !== 'as') out.weightMeans = meaning
    const best = bestWeight(e, exercises.assisted(id))
    if (best > 0) out.bestWeight = best
    const other = Object.fromEntries(Object.entries(e).filter(([k]) => !MANAGED_ENTRY_KEYS.has(k) && e[k] !== null))
    if (Object.keys(other).length) out.other = other
    return out
  })
  if (Array.isArray(workout.media)) {
    summary.media = workout.media.filter(isRecord).map((m) => ({ kind: m.kind, hash: m.hash, mime: m.mime, size: m.size }))
  }
  return summary
}
