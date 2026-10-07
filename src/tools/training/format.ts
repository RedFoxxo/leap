import type { ExerciseIndex } from '../../catalog/exercises.js'
import { localDateTime } from '../../domain/dates.js'
import { routineName } from '../../domain/plan.js'
import {
  bestWeight,
  completedVolume,
  describeSet,
  doneUnits,
  entriesOf,
  entryRoutineId,
  isWarmup,
  routineIdsOf,
  setsOf,
  setUnits,
  workoutVolume,
} from '../../domain/sets.js'
import { isRecord, type Entry, type State } from '../../state/types.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const isAssisted = (exercises: ExerciseIndex, id: string) => exercises.get(id)?.equipment === 'assisted'

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
    id: workout.id,
    date: workout.d,
    name: str(workout.name) ?? (routines.length ? routines.map((r) => routineName(state, r)).join(' + ') : 'Workout'),
  }
  if (routines.length) out.routines = routines.map((id) => ({ id, name: routineName(state, id) }))
  const start = localDateTime(workout.start)
  if (start) out.start = start
  const minutes = durationMin(workout)
  if (minutes !== undefined) out.durationMin = minutes
  out.exercises = entriesOf(workout).map((e) => exercises.name(String(e.id)))
  out.sets = setCounts(workout)
  out.volume = round(stored ?? workoutVolume(workout))
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
  const end = localDateTime(workout.end)
  if (end) summary.end = end
  if (workout.excludeFromProgression === true) summary.excludeFromProgression = true
  summary.entries = entriesOf(workout).map((e, i) => {
    const id = String(e.id)
    const sets = setsOf(e)
    const out: Entry = { position: i + 1, id, name: exercises.name(id) }
    const rid = entryRoutineId(workout, e)
    if (rid && routineIdsOf(workout).length > 1) out.routine = { id: rid, name: routineName(state, rid) }
    if (str(e.sg)) out.superset = e.sg
    out.sets = sets.map(describeSet)
    out.volume = round(sets.filter((s) => !isWarmup(s)).reduce((v, s) => v + completedVolume(s), 0))
    const best = bestWeight(e, isAssisted(exercises, id))
    if (best > 0) out.bestWeight = best
    if (isRecord(e.target)) out.target = e.target
    const note = str(e.note)
    if (note) out.note = note
    if (e.noProg === true) out.excludeFromProgression = true
    return out
  })
  if (Array.isArray(workout.media)) {
    summary.media = workout.media.filter(isRecord).map((m) => ({ kind: m.kind, hash: m.hash, mime: m.mime, size: m.size }))
  }
  return summary
}
