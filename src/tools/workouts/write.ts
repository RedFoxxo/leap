import { z } from 'zod'
import { builtinIdShape, ExerciseIndex } from '../../catalog/exercises.js'
import { instantAt, localDateTime, today } from '../../domain/dates.js'
import { routineName } from '../../domain/plan.js'
import { creditedBy, refillAfter } from '../../domain/queue.js'
import { dbLoadOf, entryAs, entryDbLoad, exerciseDbLoad } from '../../domain/dumbbells.js'
import { beatsWeight } from '../../domain/stats.js'
import { defaultItem } from '../../domain/routine-items.js'
import { bestWeight, entriesOf, routineIdsOf, setMode, setsOf, targetOf, workoutVolume } from '../../domain/sets.js'
import { sessionName, storedSet } from '../../domain/workout-items.js'
import { editedData, lowerKeptWeights, raiseKeptWeights, rebuildPrHistory, sameData, sortWorkouts, workoutKey, type AssistedCheck } from '../../domain/workouts.js'
import { newId } from '../../state/ids.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, unitOf, writableList, type Entry, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { entryId, exerciseId, isoDate, workoutId } from '../schema.js'
import { defineTool } from '../types.js'
import { change, RESURRECTION_NOTE } from '../write.js'

const effort = {
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve (0 = failure)'),
  rpe: z.number().min(1).max(10).optional(),
}

const drops = z
  .array(z.object({ weight: z.number().min(0).max(2000), reps: z.number().int().min(0).max(1000) }).strict())
  .min(1)
  .max(10)
  .optional()
  .describe('Drop set: the drops after the main set')
const clusters = z
  .array(z.object({ reps: z.number().int().min(0).max(1000), restSec: z.number().int().min(0).max(600).optional() }).strict())
  .min(1)
  .max(20)
  .optional()
  .describe('Rest-pause: how the total reps broke down')
const other = z.record(z.string(), z.unknown()).optional().describe('Ignored (from read_workout); those fields are kept as they are')

const side = z
  .object({ weight: z.number().min(0).max(2000).optional(), reps: z.number().int().min(0).max(1000), done: z.boolean().optional(), ...effort, drops, clusters, other })
  .strict()

const setInput = z
  .object({
    weight: z.number().min(0).max(2000).optional().describe('In the profile unit; added weight for body-weight exercises; 0 when none'),
    reps: z.number().int().min(0).max(1000).optional().describe('Reps; for rest-pause the total including bursts'),
    done: z.boolean().optional().describe('Default true'),
    warmup: z.boolean().optional(),
    ...effort,
    sec: z.number().int().min(0).max(36000).optional().describe('Timed set: seconds held'),
    min: z.number().min(0).max(1440).optional().describe('Cardio: minutes'),
    speed: z.number().min(0).max(100).optional().describe('Cardio: km/h'),
    drops,
    clusters,
    left: side.optional().describe('Per-side set: give left and right instead of weight/reps, each with its own rir/rpe, drops or clusters'),
    right: side.optional(),
    failure: z.boolean().optional().describe('Taken to failure (the app shows an F; counts as RIR 0 unless rated). Not on warm-ups'),
    max: z.boolean().optional().describe("A pyramid's Max set (as many reps as possible)"),
    incline: z.number().min(0).max(40).multipleOf(0.5).optional().describe('Cardio: incline in percent (treadmill, stairs), 0–40 in steps of 0.5'),
    side: z.enum(['L', 'R']).optional().describe('A timed hold done per side: the app logs each side as its own row, L then R'),
    other,
  })
  .strict()

/** One exercise of a workout in the format read_workout returns; the informational fields it adds are accepted and ignored. */
const entryInput = z
  .object({
    exerciseId,
    sets: z.array(setInput).min(1).max(50).optional().describe('The sets; required for a new exercise, left out to keep an exercise\'s sets'),
    note: z.string().max(500).nullable().optional().describe('Left out: kept; null or empty: removed'),
    superset: z.string().min(1).max(64).nullable().optional().describe('Label (or the id read_workout shows) shared by adjacent exercises done as a superset; null removes it'),
    routineId: entryId.nullable().optional().describe('On a combined day: the routine this exercise came from (inferred when left out)'),
    position: z.number().optional().describe('Ignored (from read_workout)'),
    name: z.string().optional().describe('Ignored (from read_workout)'),
    routineName: z.string().optional().describe('Ignored (from read_workout)'),
    volume: z.number().optional().describe('Ignored (from read_workout)'),
    bestWeight: z.number().optional().describe('Ignored (from read_workout)'),
    weightMeans: z.string().optional().describe('Ignored (from read_workout)'),
    other,
  })
  .strict()

type EntryInput = z.output<typeof entryInput>

/** Whether a set input records something done: done defaults to true; on a per-side set, either side done is enough. */
function completed(s: z.output<typeof setInput>): boolean {
  if (s.left || s.right) return (s.left?.done ?? s.done ?? true) || (s.right?.done ?? s.done ?? true)
  return s.done ?? true
}

function setProblems(entries: EntryInput[], requireSets: boolean): string[] {
  const problems: string[] = []
  entries.forEach((e, i) => {
    if (requireSets && !e.sets) problems.push(`exercise ${i + 1}: sets are required`)
    e.sets?.forEach((s, j) => {
      const where = `exercise ${i + 1}, set ${j + 1}`
      const sided = s.left !== undefined || s.right !== undefined
      if (sided && (!s.left || !s.right)) problems.push(`${where}: a per-side set needs both left and right`)
      if (sided && (s.weight !== undefined || s.reps !== undefined)) problems.push(`${where}: give weight and reps per side, not on the set`)
      if (sided && (s.rir !== undefined || s.rpe !== undefined)) problems.push(`${where}: give rir and rpe per side, not on the set`)
      if (sided && (s.drops || s.clusters)) problems.push(`${where}: give drops and clusters per side, not on the set`)
      if (s.drops && s.clusters) problems.push(`${where}: a set is a drop set or rest-pause, not both`)
      for (const [name, x] of [['left', s.left], ['right', s.right]] as const) {
        if (x?.drops && x.clusters) problems.push(`${where}, ${name}: a side is a drop set or rest-pause, not both`)
        if (x?.clusters && x.clusters.reduce((n, c) => n + c.reps, 0) > x.reps) problems.push(`${where}, ${name}: the clusters add up to more than reps (reps is the total)`)
      }
      const cardio = s.min !== undefined || s.speed !== undefined
      if (cardio && (s.reps !== undefined || s.sec !== undefined || sided || s.weight !== undefined || s.rir !== undefined || s.rpe !== undefined)) {
        problems.push(`${where}: a cardio set takes min and speed only (and incline)`)
      }
      if (s.sec !== undefined && (s.reps !== undefined || sided)) problems.push(`${where}: a timed set takes sec (and weight), not reps`)
      if (!cardio && s.sec === undefined && !sided && s.reps === undefined) problems.push(`${where}: reps are required (or sec for a timed set, min for cardio)`)
      if ((s.drops || s.clusters) && (cardio || s.sec !== undefined)) problems.push(`${where}: drop sets and rest-pause are for reps sets, not timed or cardio ones`)
      if (s.clusters && s.reps !== undefined && s.clusters.reduce((n, c) => n + c.reps, 0) > s.reps) problems.push(`${where}: the clusters add up to more than reps (reps is the total)`)
      if (s.failure && s.warmup) problems.push(`${where}: a warm-up is never taken to failure`)
      if (s.failure && cardio) problems.push(`${where}: a cardio set is not taken to failure`)
      if (s.max && cardio) problems.push(`${where}: a cardio set is not a Max set`)
      if (s.incline !== undefined && !cardio) problems.push(`${where}: incline is for cardio sets (min, speed)`)
      else if (s.incline !== undefined && s.min === undefined) problems.push(`${where}: incline needs min (minutes)`)
      if (s.side !== undefined && s.sec === undefined) problems.push(`${where}: side (L/R) is for timed holds done per side; a per-side reps set takes left and right`)
    })
    // The app keeps only exercises with something done; an entry with no completed set would count as training that was not.
    if (e.sets && !e.sets.some(completed)) {
      problems.push(`exercise ${i + 1}: no completed set; leave the exercise out instead`)
    }
  })
  const labels = entries.map((e) => e.superset ?? undefined)
  const seen = new Set<string>()
  labels.forEach((label, i) => {
    if (!label) return
    if (seen.has(label) && labels[i - 1] !== label) problems.push(`superset "${label}" is split; its exercises must be next to each other`)
    seen.add(label)
  })
  // A new workout with a one-exercise superset is a mistake; on an edit, a lone id is dropped quietly, as the app does.
  if (requireSets) for (const label of seen) if (labels.filter((l) => l === label).length < 2) problems.push(`superset "${label}" has only one exercise`)
  return problems
}

/** Superset ids that no longer pair adjacent exercises are dropped, as the app does. */
function cleanupSupersets(items: Entry[]): void {
  items.forEach((e, i) => {
    if (!e.sg) return
    if (!(items[i - 1]?.sg === e.sg || items[i + 1]?.sg === e.sg)) delete e.sg
  })
}

interface EntryContext {
  routineIds: string[]
  routines: Entry[]
  assisted: AssistedCheck
  bodyweight: (id: string) => boolean
  now: number
  state: State
}

/** The routine an exercise came from on a combined day: the first of the session's routines that plans it. */
function inferRid(exerciseId: string, c: EntryContext): string | undefined {
  if (c.routineIds.length < 2) return undefined
  return c.routineIds.find((rid) => listOf(c.routines.find((r) => r.id === rid), 'ex').some((x) => x.id === exerciseId))
}

/**
 * A new entry of a dumbbell exercise whose weight means "per dumbbell" or "both together" (the
 * routine's choice, else the exercise's): the target carries the meaning, as a session the app
 * starts does, so volume and comparisons read the weights right. The routine exercise is the
 * target, as in the app; a freestyle entry gets the exercise's default plan, as the app's
 * defaultConfig. Nothing for "as entered".
 */
function meaningFor(exerciseId: string, entry: Entry, c: EntryContext): Entry | undefined {
  const rid = typeof entry.rid === 'string' ? entry.rid : c.routineIds.length === 1 ? c.routineIds[0] : undefined
  const item = listOf(c.routines.find((r) => r.id === rid), 'ex').find((x) => x.id === exerciseId)
  const meaning = dbLoadOf(item?.dbLoad) ?? exerciseDbLoad(c.state, exerciseId)
  if (meaning === 'as') return undefined
  const mode = setMode(setsOf(entry)[0] ?? {}, targetOf(entry))
  return { ...(item ? structuredClone(item) : defaultItem(exerciseId, mode, c.bodyweight(exerciseId))), dbLoad: meaning }
}

/** Sessions of a routine marked excludeFromProgression (a deload) do not count for progression, as in the app. */
function excluded(entry: Entry, c: EntryContext): boolean {
  const rid = typeof entry.rid === 'string' ? entry.rid : c.routineIds.length === 1 ? c.routineIds[0] : undefined
  return rid !== undefined && c.routines.find((r) => r.id === rid)?.excludeFromProgression === true
}

/**
 * The workout's exercises: input order; an exercise the workout had (matched by id, in order) keeps
 * what is not given, a new one is built from the input. Returns the entries or why not.
 */
function buildEntries(inputs: (EntryInput & { rawId?: string })[], existing: Entry[], c: EntryContext): Entry[] | string {
  const pool = new Map<string, Entry[]>()
  for (const e of existing) pool.set(String(e.id), [...(pool.get(String(e.id)) ?? []), e])
  const oldGroups = new Set(existing.map((e) => e.sg).filter((g): g is string => typeof g === 'string'))
  const groups = new Map<string, string>()
  const out: Entry[] = []
  for (const [i, x] of inputs.entries()) {
    // An entry stored under an alias id (an import, a plan file) is matched by that id first; it keeps it.
    const old = (x.rawId !== undefined && x.rawId !== x.exerciseId ? pool.get(x.rawId)?.shift() : undefined) ?? pool.get(x.exerciseId)?.shift()
    if (!old && !x.sets) return `exercise ${i + 1} (${x.exerciseId}) is new to this workout and needs its sets`
    const e: Entry = old ? structuredClone(old) : { id: x.exerciseId, target: null }
    if (x.sets) e.sets = x.sets.map(storedSet)
    if (x.note !== undefined) {
      const note = x.note?.trim()
      if (note) e.note = note
      else {
        delete e.note
        delete e.notePin
      }
    }
    if (x.superset === null) delete e.sg
    else if (x.superset) {
      if (!groups.has(x.superset)) {
        const used = new Set(groups.values())
        let id = oldGroups.has(x.superset) && !used.has(x.superset) ? x.superset : newId('sg', c.now)
        while (used.has(id)) id = newId('sg', c.now + used.size)
        groups.set(x.superset, id)
      }
      e.sg = groups.get(x.superset)
    }
    if (x.routineId === null) delete e.rid
    else if (x.routineId !== undefined) {
      if (!c.routineIds.includes(x.routineId)) return `exercise ${i + 1}: routine "${x.routineId}" is not one of this session's routines (${c.routineIds.join(', ') || 'none'})`
      e.rid = x.routineId
    } else if (!old) {
      const rid = inferRid(x.exerciseId, c)
      if (rid) e.rid = rid
    }
    if (!old && excluded(e, c)) e.noProg = true
    if (!old) {
      const meaning = meaningFor(x.exerciseId, e, c)
      if (meaning) e.target = meaning
    }
    e.topW = bestWeight(e, c.assisted(x.exerciseId)) || null
    out.push(e)
  }
  cleanupSupersets(out)
  return out
}

/** The local time of day of a timestamp, `HH:MM`. */
const timeOf = (ms: number, zone: string | undefined) => localDateTime(ms, zone)?.slice(11) ?? '18:00'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')

interface Checks {
  names: ExerciseIndex
  assisted: AssistedCheck
  /** Unknown ids among `ids`; `allowed` are ids the workout already holds (a deleted custom exercise stays editable). */
  unknown: (ids: string[], allowed?: Set<string>) => string | undefined
}

async function checks(ctx: ToolContext): Promise<(state: State) => Checks> {
  const builtin = await ctx.builtinExercises()
  return (state) => {
    const index = new ExerciseIndex(builtin, state)
    return {
      names: index,
      assisted: (id) => index.assisted(id),
      unknown: (ids, allowed = new Set()) => {
        const missing = ids.filter((id) => !index.get(id) && !allowed.has(id) && !(builtin.error && builtinIdShape(id)))
        return missing.length ? `unknown exercise ids: ${[...new Set(missing)].join(', ')}; find ids with read_exercises` : undefined
      },
    }
  }
}

/** The body weight the app records with a session: that day's weigh-in, if there is one. */
function weighInOn(state: State, date: string): number | undefined {
  const w = listOf(state, 'bodyweight').find((e) => e.d === date && typeof e.w === 'number')
  return w ? Number(w.w) : undefined
}

/** What a write reports about the workout, named with the profile's own exercises. */
function summary(w: Entry, state: State, names: ExerciseIndex) {
  return {
    id: w.id,
    date: w.d,
    name: w.name,
    exercises: entriesOf(w).map((e) => names.get(String(e.id))?.name ?? (typeof e.n === 'string' ? e.n : String(e.id))),
    volume: Math.round(Number(w.vol) * 100) / 100,
    unit: unitOf(state),
    ...(Array.isArray(w.prs) && w.prs.length ? { prs: w.prs.map((id: unknown) => names.name(String(id))) } : {}),
  }
}

/**
 * A session finished today is held against history read the way it logged a dumbbell weight, as
 * the app's finish does (openGym `sheets.jsx` finish, `bestWeightFor(…, entryDbLoad(e))`, v1.4.0):
 * 20 kg "each" on two bells beats an earlier 38 kg "total". Entries logged as entered keep the
 * badge rebuildPrHistory gave them.
 */
function badgesInMeaning(state: State, saved: Entry, c: Checks): void {
  const prs = new Set(Array.isArray(saved.prs) ? saved.prs.filter((x): x is string => typeof x === 'string') : [])
  for (const e of entriesOf(saved)) {
    const id = String(e.id)
    const meaning = entryDbLoad(e)
    if (meaning === 'as') continue
    const assisted = c.assisted(id)
    const name = c.names.name(id)
    let prior = 0
    for (const w of listOf(state, 'workouts')) {
      if (w.id === saved.id) continue
      for (const other of entriesOf(w)) {
        if (other.id !== id) continue
        const b = bestWeight(entryAs(other, meaning, name), assisted)
        if (beatsWeight(b, prior, assisted)) prior = b
      }
    }
    if (beatsWeight(bestWeight(e, assisted), prior, assisted)) prs.add(id)
    else prs.delete(id)
  }
  saved.prs = [...prs]
}

const notInFuture = (date: string, day: string) => (date > day ? `${date} is in the future; only training that happened is logged` : undefined)

/** A session still going on at `clock` was not trained yet (openGym `workout-date.js` endsInFuture, v1.4.0, 28b7e4dc). */
const endsInFuture = (end: number, clock: number, zone: string | undefined) =>
  end > clock ? `the workout ends in the future (${localDateTime(end, zone) ?? end}); only training that happened is logged, so give an earlier start or a shorter duration` : undefined

export const writeLogWorkout = defineTool({
  name: 'write_log_workout',
  description:
    'Log a finished workout. Sets: weight + reps (done defaults to true), warmup, rir and/or rpe, failure (taken to failure), a drop set (drops), rest-pause (clusters; reps is the total), a pyramid\'s Max set (max), per side (left and right, each with its own weight, reps, rir/rpe and drops or clusters), timed (sec, optional weight; a hold per side is two rows, side L then R) or cardio (min, speed in km/h, optional incline in % with min). Weights in the profile unit; for a dumbbell exercise whose weight means per dumbbell or both together, the session is stamped with that meaning, as in the app, and volume counts both bells when it is per dumbbell. Every exercise needs at least one completed set. On a combined day (several routineIds) each exercise is linked to its routine, inferred when not given; sessions of a routine excluded from progression are marked so. leap computes volume, best weights and PR badges as the app does; logging today also raises the remembered working weight. When the plan follows the app\'s rotation, the output says which sessions of the round the workout did, and the workout that completes a round starts the next one the day after, as the app does. Without a start time, today ends now (starting no earlier than midnight) and other days start at 18:00. No future dates or times: the workout must have ended by now.',
  input: {
    date: isoDate.optional().describe('Default today'),
    start: time.optional().describe("Start time HH:MM in the user's time zone (the profile's reminder zone, else this machine's)"),
    durationMin: z.number().int().min(1).max(600).optional().describe('Default 60'),
    routineIds: z.array(entryId).max(10).optional().describe('The routine(s) this session followed; several make a combined day'),
    name: z.string().trim().min(1).max(80).optional().describe('Default the routine name(s) as the app joins them, else "Freestyle"'),
    note: z.string().max(500).optional(),
    bodyWeight: z.number().positive().max(1000).optional().describe("Default that day's weigh-in, if any"),
    entries: z.array(entryInput).min(1).max(40),
  },
  async handler(args, ctx) {
    const problems = setProblems(args.entries, true)
    if (problems.length) return invalid(problems.join('; '))
    // The wall clock decides when the workout was and what today is; the store's `now` is a stamp time, possibly lifted past it.
    // Days and times in the user's time zone (the profile's, else this machine's).
    const clock = ctx.now()
    const zone = await ctx.store.zone()
    const day = today(clock, zone)
    const date = args.date ?? day
    const future = notInFuture(date, day)
    if (future) return invalid(future)
    const duration = (args.durationMin ?? 60) * 60_000
    const start = args.start ? instantAt(date, args.start, zone) : date === day ? Math.max(instantAt(date, '00:00', zone), clock - duration) : instantAt(date, '18:00', zone)
    const end = !args.start && date === day ? clock : start + duration
    const late = endsInFuture(end, clock, zone)
    if (late) return invalid(late)
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'log the workout',
      (draft, { now }) => {
        const c = makeChecks(draft)
        const asked = args.entries.map((e) => ({ ...e, exerciseId: c.names.canonical(e.exerciseId) }))
        const unknown = c.unknown(asked.map((e) => e.exerciseId))
        if (unknown) return refuse(unknown)
        const routineIds = [...new Set(args.routineIds ?? [])]
        const routines = listOf(draft, 'routines')
        const missing = routineIds.filter((id) => !routines.some((r) => r.id === id))
        if (missing.length) return refuse(`no routine with id ${missing.map((m) => `"${m}"`).join(', ')}`)
        const entries = buildEntries(asked, [], { routineIds, routines, assisted: c.assisted, bodyweight: (id) => c.names.get(id)?.equipment === 'body weight', now, state: draft })
        if (typeof entries === 'string') return refuse(entries)
        const bw = args.bodyWeight ?? weighInOn(draft, date)
        const allExcluded = entries.length > 0 && entries.every((e) => e.noProg === true)
        const workout: Entry = {
          id: newId('', now),
          d: date,
          start,
          end,
          routineIds,
          routineId: routineIds[0] ?? null,
          name: args.name ?? sessionName(routineIds.map((id) => routineName(draft, id))),
          ...(bw !== undefined ? { bw } : {}),
          entries,
          prs: [],
          ...(allExcluded ? { excludeFromProgression: true } : {}),
          ...(args.note?.trim() ? { note: args.note.trim() } : {}),
        }
        workout.vol = workoutVolume(workout, (id) => c.names.name(id))
        workout._ts = now
        const list = writableList(draft, 'workouts')
        list.push(workout)
        const ids = entriesOf(workout).map((e) => String(e.id))
        draft.workouts = rebuildPrHistory(sortWorkouts(list), ids, workout, c.assisted)
        const saved = listOf(draft, 'workouts').find((w) => w.id === workout.id)!
        if (date === day) badgesInMeaning(draft, saved, c)
        const raised = date === day ? raiseKeptWeights(draft, saved, c.assisted) : []
        // The rotation: which sessions of the round this workout did, and the next round when it closed this one (as the app's finish does).
        const credited = creditedBy(draft, saved).map((id) => routineName(draft, id))
        const next = refillAfter(draft, saved, day, clock)
        const round = credited.length ? { sessionsDone: credited, ...(next ? { roundComplete: true, nextRound: { startsOn: next.startsOn, sessions: next.ids.map((id) => routineName(draft, id)) } } : {}) } : undefined
        return apply({ id: saved.id, shown: summary(saved, draft, c.names), raised: raised.map((x) => c.names.name(x)), round })
      },
      (r) => ({ logged: r.shown, ...(r.raised.length ? { rememberedWeightRaised: r.raised } : {}), ...(r.round ? { round: r.round } : {}) }),
      { verify: (s, r) => (listOf(s, 'workouts').some((w) => w.id === r.id) ? [] : [`workout ${String(r.id)}`]) },
    )
  },
})

export const writeUpdateWorkout = defineTool({
  name: 'write_update_workout',
  description:
    'Change a logged workout: its date, start time, duration, name, note, body weight, or its exercises. `entries`, when given, is the new list in the format read_workout returns: an exercise the workout had keeps what is left out (its sets, note, superset, routine; null removes a note, superset or routine), a new one needs its sets. A new date keeps the time of day and the length. Volume, best weights and PR badges are worked out again as the app does after an edit; a remembered working weight that came from a removed set falls back to the best left in history. A workout from before ids (read_workouts shows it as "YYYY-MM-DD|<start>") takes that key as its id, as in the app. An edit that changes nothing writes nothing. No future dates or times: the workout must have ended by now.',
  input: {
    id: workoutId,
    date: isoDate.optional(),
    start: time.optional(),
    durationMin: z.number().int().min(1).max(600).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    note: z.string().max(500).optional().describe('Empty removes the note'),
    bodyWeight: z.number().positive().max(1000).nullable().optional().describe('null removes it'),
    entries: z.array(entryInput).min(1).max(40).optional(),
  },
  async handler(args, ctx) {
    const { id, ...fields } = args
    if (Object.values(fields).every((v) => v === undefined)) return invalid('nothing to change')
    const problems = setProblems(args.entries ?? [], false)
    if (problems.length) return invalid(problems.join('; '))
    const clock = ctx.now()
    const zone = await ctx.store.zone()
    if (args.date) {
      const future = notInFuture(args.date, today(clock, zone))
      if (future) return invalid(future)
    }
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'update the workout',
      (draft, { now }) => {
        const c = makeChecks(draft)
        const list = writableList(draft, 'workouts')
        const i = list.findIndex((w) => isRecord(w) && workoutKey(w) === id)
        if (i < 0) return refuse(`no workout with id "${id}"; find ids with read_workouts`)
        const before = list[i] as Entry
        const asked = args.entries?.map((e) => ({ ...e, rawId: e.exerciseId, exerciseId: c.names.canonical(e.exerciseId) }))
        if (asked) {
          const unknown = c.unknown(asked.map((e) => e.exerciseId), new Set(entriesOf(before).map((e) => String(e.id))))
          if (unknown) return refuse(unknown)
        }
        const record: Entry = structuredClone(before)
        if (args.date || args.start || args.durationMin !== undefined) {
          // As the app's retimeWorkout: a move keeps the time of day and the length the workout had.
          const date = args.date ?? String(before.d)
          const oldStart = Number(before.start) || instantAt(String(before.d), '18:00', zone)
          const oldEnd = before.end != null && Number.isFinite(Number(before.end)) ? Number(before.end) : oldStart
          const duration = args.durationMin !== undefined ? args.durationMin * 60_000 : Math.max(0, oldEnd - oldStart)
          const start = args.start ? instantAt(date, args.start, zone) : date !== before.d ? instantAt(date, timeOf(oldStart, zone), zone) : oldStart
          const late = endsInFuture(start + duration, clock, zone)
          if (late) return refuse(late)
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
        if (asked) {
          const entries = buildEntries(asked, entriesOf(before), { routineIds: routineIdsOf(before), routines: listOf(draft, 'routines'), assisted: c.assisted, bodyweight: (id) => c.names.get(id)?.equipment === 'body weight', now, state: draft })
          if (typeof entries === 'string') return refuse(entries)
          record.entries = entries
        }
        // An unchanged workout is not stamped: the stamp would outrank an unsynced edit made elsewhere. Compared as the app's
        // Save does, without what an edit works out again (volume, badges) and the stamp.
        if (sameData(editedData(record), editedData(before))) return apply({ stamp: before._ts, shown: summary(before, draft, c.names) })
        record.vol = workoutVolume(record, (id) => c.names.name(id))
        // A workout from before ids keeps the key the sync knows it by, as the app's edit and move do.
        if (record.id == null) record.id = id
        record._ts = now
        list[i] = record
        const touched = new Set([...entriesOf(before), ...entriesOf(record)].map((e) => String(e.id)))
        draft.workouts = rebuildPrHistory(sortWorkouts(list), touched, record, c.assisted)
        const saved = listOf(draft, 'workouts').find((w) => workoutKey(w) === id)!
        lowerKeptWeights(draft, touched, before, saved, c.assisted)
        return apply({ stamp: now, shown: summary(saved, draft, c.names) })
      },
      (r) => ({ updated: r.shown }),
      {
        verify: (s, r) => {
          const stored = listOf(s, 'workouts').find((w) => workoutKey(w) === id)
          return stored && Number(stored._ts) >= Number(r.stamp) ? [] : [`workout ${id}`]
        },
      },
    )
  },
})

export const deleteWorkout = defineTool({
  name: 'delete_workout',
  description: `Delete a logged workout (by the id read_workouts shows; for a workout from before ids, "YYYY-MM-DD|<start>"). A remembered working weight that came from it falls back to the best left in history; its photos and videos are deleted by openGym after a grace period. ${RESURRECTION_NOTE}`,
  input: { id: workoutId },
  async handler(args, ctx) {
    const makeChecks = await checks(ctx)
    return change(
      ctx,
      'delete the workout',
      (draft) => {
        const c = makeChecks(draft)
        const before = listOf(draft, 'workouts').find((w) => workoutKey(w) === args.id)
        if (!before) return refuse(`no workout with id "${args.id}"; find ids with read_workouts`)
        draft.workouts = writableList(draft, 'workouts').filter((w) => !(isRecord(w) && workoutKey(w) === args.id))
        lowerKeptWeights(draft, new Set(entriesOf(before).map((e) => String(e.id))), before, null, c.assisted)
        return apply({ date: before.d, name: before.name })
      },
      (r) => ({ deleted: { id: args.id, date: r.date, name: r.name }, note: RESURRECTION_NOTE }),
      { verify: (s) => (listOf(s, 'workouts').some((w) => workoutKey(w) === args.id) ? [`workout ${args.id} is still there`] : []) },
    )
  },
})

export const workoutWriteTools = [writeLogWorkout, writeUpdateWorkout]
export const workoutDeleteTools = [deleteWorkout]
