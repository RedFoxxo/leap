import { z } from 'zod'
import { customExercises, ExerciseIndex } from '../../catalog/exercises.js'
import { dateOf, today } from '../../domain/dates.js'
import { routineName } from '../../domain/plan.js'
import { bestWeight, entriesOf, workoutVolume } from '../../domain/sets.js'
import { lowerKeptWeights, raiseKeptWeights, rebuildPrHistory, sortWorkouts, type AssistedCheck } from '../../domain/workouts.js'
import { newId } from '../../state/ids.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, unitOf, writableList, type Entry, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { entryId, exerciseId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, RESURRECTION_NOTE } from '../write.js'

const effort = {
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve (0 = failure)'),
  rpe: z.number().min(1).max(10).optional(),
}

const side = z.object({ weight: z.number().min(0).max(2000).optional(), reps: z.number().int().min(0).max(1000), done: z.boolean().optional(), ...effort }).strict()

const setInput = z
  .object({
    weight: z.number().min(0).max(2000).optional().describe('In the profile unit; added weight for body-weight exercises; 0 when none'),
    reps: z.number().int().min(0).max(1000).optional().describe('Reps; for rest-pause the total including bursts'),
    done: z.boolean().optional().describe('Default true'),
    warmup: z.boolean().optional(),
    ...effort,
    sec: z.number().int().min(1).max(36000).optional().describe('Timed set: seconds held'),
    min: z.number().min(0.1).max(1440).optional().describe('Cardio: minutes'),
    speed: z.number().min(0).max(100).optional().describe('Cardio: km/h'),
    drops: z.array(z.object({ weight: z.number().min(0).max(2000), reps: z.number().int().min(1).max(1000) }).strict()).min(1).max(10).optional().describe('Drop set: the drops after the main set'),
    clusters: z.array(z.object({ reps: z.number().int().min(1).max(1000), restSec: z.number().int().min(1).max(600).optional() }).strict()).min(1).max(20).optional().describe('Rest-pause: how the total reps broke down'),
    left: side.optional().describe('Per-side set: give left and right instead of weight/reps'),
    right: side.optional(),
  })
  .strict()

const entryInput = z
  .object({
    exerciseId,
    sets: z.array(setInput).min(1).max(50),
    note: z.string().max(500).optional(),
    superset: z.string().min(1).max(20).optional().describe('Label shared by adjacent exercises done as a superset'),
    routineId: entryId.optional().describe('On a combined day: the routine this exercise came from'),
  })
  .strict()

type SetInput = z.output<typeof setInput>
type EntryInput = z.output<typeof entryInput>

function setProblems(entries: EntryInput[]): string[] {
  const problems: string[] = []
  entries.forEach((e, i) =>
    e.sets.forEach((s, j) => {
      const where = `exercise ${i + 1}, set ${j + 1}`
      const sided = s.left !== undefined || s.right !== undefined
      if (sided && (!s.left || !s.right)) problems.push(`${where}: a per-side set needs both left and right`)
      if (sided && (s.weight !== undefined || s.reps !== undefined)) problems.push(`${where}: give weight and reps per side, not on the set`)
      if (s.drops && s.clusters) problems.push(`${where}: a set is a drop set or rest-pause, not both`)
      if (s.rir !== undefined && s.rpe !== undefined) problems.push(`${where}: give rir or rpe, not both`)
      const cardio = s.min !== undefined || s.speed !== undefined
      if (cardio && (s.reps !== undefined || s.sec !== undefined || sided)) problems.push(`${where}: a cardio set takes min and speed only`)
      if (s.sec !== undefined && (s.reps !== undefined || sided)) problems.push(`${where}: a timed set takes sec (and weight), not reps`)
      if (!cardio && s.sec === undefined && !sided && s.reps === undefined) problems.push(`${where}: reps are required (or sec for a timed set, min for cardio)`)
      if (s.clusters && s.reps !== undefined && s.clusters.reduce((n, c) => n + c.reps, 0) > s.reps) problems.push(`${where}: the clusters add up to more than reps (reps is the total)`)
    }),
  )
  const labels = entries.map((e) => e.superset)
  const seen = new Set<string>()
  labels.forEach((label, i) => {
    if (!label) return
    if (seen.has(label) && labels[i - 1] !== label) problems.push(`superset "${label}" is split; its exercises must be next to each other`)
    seen.add(label)
  })
  for (const label of seen) if (labels.filter((l) => l === label).length < 2) problems.push(`superset "${label}" has only one exercise`)
  return problems
}

const withEffort = (row: Entry, s: { rir?: number | undefined; rpe?: number | undefined }) => {
  if (s.rir !== undefined) row.rir = s.rir
  if (s.rpe !== undefined) row.rpe = s.rpe
  return row
}

/** A set as openGym stores it (docs/OPENGYM.md, "Workouts"). */
function storedSet(s: SetInput): Entry {
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
  return row
}

/** Entry fields leap writes; others on an existing entry (muscleSnapshot, planned, notePin, ...) are kept by position. */
const MANAGED_ENTRY = new Set(['id', 'sets', 'topW', 'note', 'sg', 'rid', 'target'])

function storedEntries(inputs: EntryInput[], existing: Entry[], assisted: AssistedCheck, now: number): Entry[] {
  const groups = new Map<string, string>()
  return inputs.map((e, i) => {
    const old = existing[i]?.id === e.exerciseId ? existing[i] : undefined
    const carried = old ? Object.fromEntries(Object.entries(old).filter(([k]) => !MANAGED_ENTRY.has(k))) : {}
    const sets = e.sets.map(storedSet)
    const entry: Entry = { ...carried, id: e.exerciseId, sets, target: old?.target ?? null }
    entry.topW = bestWeight(entry, assisted(e.exerciseId)) || null
    if (e.routineId) entry.rid = e.routineId
    if (e.superset) {
      if (!groups.has(e.superset)) groups.set(e.superset, typeof old?.sg === 'string' ? old.sg : newId('sg', now))
      entry.sg = groups.get(e.superset)
    }
    const note = e.note?.trim()
    if (note) entry.note = note
    return entry
  })
}

/** Local time on a day: `HH:MM`, as ms since epoch. */
function at(date: string, time: string): number {
  const d = dateOf(date)
  const [h, m] = time.split(':').map(Number)
  d.setHours(h ?? 0, m ?? 0, 0, 0)
  return d.getTime()
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')

interface Checks {
  names: ExerciseIndex
  assisted: AssistedCheck
  unknown: (ids: string[]) => string | undefined
}

async function checks(ctx: ToolContext): Promise<(state: State) => Checks> {
  const builtin = await ctx.builtinExercises()
  return (state) => {
    const index = new ExerciseIndex(builtin, state)
    const custom = new Set(customExercises(state).map((c) => c.id))
    return {
      names: index,
      assisted: (id) => index.assisted(id),
      unknown: (ids) => {
        const missing = ids.filter((id) => !builtin.exercises.has(id) && !custom.has(id) && !(builtin.error && !id.startsWith('c')))
        return missing.length ? `unknown exercise ids: ${[...new Set(missing)].join(', ')}; find ids with read_exercises` : undefined
      },
    }
  }
}

function lastWeighIn(state: State, date: string): number | undefined {
  const w = listOf(state, 'bodyweight')
    .filter((e) => typeof e.d === 'string' && e.d <= date && typeof e.w === 'number')
    .sort((a, b) => String(a.d).localeCompare(String(b.d)))
    .at(-1)
  return w ? Number(w.w) : undefined
}

/** What a write reports about the workout, named with the profile's own exercises. */
function summary(w: Entry, state: State, names: ExerciseIndex) {
  return {
    id: w.id,
    date: w.d,
    name: w.name,
    exercises: entriesOf(w).map((e) => names.name(String(e.id))),
    volume: Math.round(Number(w.vol) * 100) / 100,
    unit: unitOf(state),
    ...(Array.isArray(w.prs) && w.prs.length ? { prs: w.prs.map((id: unknown) => names.name(String(id))) } : {}),
  }
}

export const writeLogWorkout = defineTool({
  name: 'write_log_workout',
  description:
    'Log a finished workout. Sets: weight + reps (done defaults to true), warmup, rir or rpe, a drop set (drops), rest-pause (clusters; reps is the total), per side (left and right), timed (sec, optional weight) or cardio (min, speed in km/h). Weights in the profile unit. leap computes volume, best weights and PR badges as the app does; logging today also raises the remembered working weight. Without a start time, today ends now and other days start at 18:00.',
  input: {
    date: isoDate.optional().describe('Default today'),
    start: time.optional().describe('Local start time HH:MM'),
    durationMin: z.number().int().min(1).max(600).optional().describe('Default 60'),
    routineIds: z.array(entryId).max(5).optional().describe('The routine(s) this session followed; several make a combined day'),
    name: z.string().trim().min(1).max(80).optional().describe('Default the routine name(s), else "Workout"'),
    note: z.string().max(1000).optional(),
    bodyWeight: z.number().positive().max(1000).optional().describe('Default the latest weigh-in up to that day'),
    entries: z.array(entryInput).min(1).max(40),
  },
  async handler(args, ctx) {
    const problems = setProblems(args.entries)
    if (problems.length) return invalid(problems.join('; '))
    const date = args.date ?? today()
    const duration = (args.durationMin ?? 60) * 60_000
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'log the workout',
      (draft, { now }) => {
        const c = makeChecks(draft)
        const unknown = c.unknown(args.entries.map((e) => e.exerciseId))
        if (unknown) return refuse(unknown)
        const routines = args.routineIds ?? []
        const missing = [...routines, ...args.entries.flatMap((e) => (e.routineId ? [e.routineId] : []))].filter((id) => !listOf(draft, 'routines').some((r) => r.id === id))
        if (missing.length) return refuse(`no routine with id ${[...new Set(missing)].map((m) => `"${m}"`).join(', ')}`)
        const start = args.start ? at(date, args.start) : date === today(now) ? now - duration : at(date, '18:00')
        const bw = args.bodyWeight ?? lastWeighIn(draft, date)
        const workout: Entry = {
          id: newId('', now),
          d: date,
          start,
          end: start + duration,
          routineIds: routines,
          routineId: routines[0] ?? null,
          name: args.name ?? (routines.length ? routines.map((id) => routineName(draft, id)).join(' + ') : 'Workout'),
          ...(bw !== undefined ? { bw } : {}),
          entries: storedEntries(args.entries, [], c.assisted, now),
          prs: [],
          ...(args.note?.trim() ? { note: args.note.trim() } : {}),
        }
        workout.vol = workoutVolume(workout)
        workout._ts = now
        const list = writableList(draft, 'workouts')
        list.push(workout)
        const ids = entriesOf(workout).map((e) => String(e.id))
        draft.workouts = rebuildPrHistory(sortWorkouts(list), ids, workout, c.assisted)
        const saved = listOf(draft, 'workouts').find((w) => w.id === workout.id)!
        const raised = date === today(now) ? raiseKeptWeights(draft, saved, c.assisted) : []
        return apply({ id: saved.id, shown: summary(saved, draft, c.names), raised: raised.map((x) => c.names.name(x)) })
      },
      (r) => ({ logged: r.shown, ...(r.raised.length ? { rememberedWeightRaised: r.raised } : {}) }),
      { verify: (s, r) => (listOf(s, 'workouts').some((w) => w.id === r.id) ? [] : [`workout ${String(r.id)}`]) },
    )
  },
})

export const writeUpdateWorkout = defineTool({
  name: 'write_update_workout',
  description:
    'Change a logged workout: its date, start time, duration, name, note, body weight, or its exercises and sets (`entries` replaces them all; same set format as write_log_workout). Volume, best weights and PR badges are worked out again as the app does after an edit; a remembered working weight that came from a removed set falls back to the best left in history.',
  input: {
    id: entryId,
    date: isoDate.optional(),
    start: time.optional(),
    durationMin: z.number().int().min(1).max(600).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    note: z.string().max(1000).optional().describe('Empty removes the note'),
    bodyWeight: z.number().positive().max(1000).nullable().optional().describe('null removes it'),
    entries: z.array(entryInput).min(1).max(40).optional(),
  },
  async handler(args, ctx) {
    const { id, ...fields } = args
    if (Object.values(fields).every((v) => v === undefined)) return invalid('nothing to change')
    const problems = setProblems(args.entries ?? [])
    if (problems.length) return invalid(problems.join('; '))
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'update the workout',
      (draft, { now }) => {
        const c = makeChecks(draft)
        const list = writableList(draft, 'workouts')
        const i = list.findIndex((w) => isRecord(w) && w.id === id)
        if (i < 0) return refuse(`no workout with id "${id}"; find ids with read_workouts`)
        const before = list[i] as Entry
        if (args.entries) {
          const unknown = c.unknown(args.entries.map((e) => e.exerciseId))
          if (unknown) return refuse(unknown)
        }
        const record: Entry = structuredClone(before)
        const date = args.date ?? String(before.d)
        const oldStart = Number(before.start) || at(String(before.d), '18:00')
        const oldDuration = Number(before.end) > oldStart ? Number(before.end) - oldStart : 60 * 60_000
        const duration = args.durationMin !== undefined ? args.durationMin * 60_000 : oldDuration
        let start = oldStart
        if (args.start) start = at(date, args.start)
        else if (args.date && args.date !== before.d) start = oldStart + (dateOf(date).getTime() - dateOf(String(before.d)).getTime())
        if (args.date || args.start || args.durationMin !== undefined) {
          record.d = date
          record.start = start
          record.end = start + duration
        }
        if (args.name !== undefined) record.name = args.name
        if (args.note !== undefined) {
          if (args.note.trim()) record.note = args.note.trim()
          else delete record.note
        }
        if (args.bodyWeight !== undefined) {
          if (args.bodyWeight === null) delete record.bw
          else record.bw = args.bodyWeight
        }
        if (args.entries) record.entries = storedEntries(args.entries, entriesOf(before), c.assisted, now)
        record.vol = workoutVolume(record)
        record._ts = now
        list[i] = record
        const touched = new Set([...entriesOf(before), ...entriesOf(record)].map((e) => String(e.id)))
        draft.workouts = rebuildPrHistory(sortWorkouts(list), touched, record, c.assisted)
        const saved = listOf(draft, 'workouts').find((w) => w.id === id)!
        lowerKeptWeights(draft, touched, before, saved, c.assisted)
        return apply({ stamp: now, shown: summary(saved, draft, c.names) })
      },
      (r) => ({ updated: r.shown }),
      {
        verify: (s, r) => {
          const stored = listOf(s, 'workouts').find((w) => w.id === id)
          return stored && stored._ts === r.stamp ? [] : [`workout ${id}`]
        },
      },
    )
  },
})

export const deleteWorkout = defineTool({
  name: 'delete_workout',
  description: `Delete a logged workout. A remembered working weight that came from it falls back to the best left in history; its photos and videos are deleted by openGym after a grace period. ${RESURRECTION_NOTE}`,
  input: { id: entryId },
  async handler(args, ctx) {
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'delete the workout',
      (draft) => {
        const c = makeChecks(draft)
        const before = listOf(draft, 'workouts').find((w) => w.id === args.id)
        if (!before) return refuse(`no workout with id "${args.id}"; find ids with read_workouts`)
        draft.workouts = writableList(draft, 'workouts').filter((w) => !(isRecord(w) && w.id === args.id))
        lowerKeptWeights(draft, new Set(entriesOf(before).map((e) => String(e.id))), before, null, c.assisted)
        return apply({ date: before.d, name: before.name })
      },
      (r) => ({ deleted: { id: args.id, date: r.date, name: r.name }, note: RESURRECTION_NOTE }),
      { verify: (s) => (listOf(s, 'workouts').some((w) => w.id === args.id) ? [`workout ${args.id} is still there`] : []) },
    )
  },
})

export const workoutWriteTools = [writeLogWorkout, writeUpdateWorkout]
export const workoutDeleteTools = [deleteWorkout]
