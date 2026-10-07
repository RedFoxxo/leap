import { routineIdsOf } from '../../domain/sets.js'
import { listOf, unitOf } from '../../state/types.js'
import { loadProfile } from '../context.js'
import { failure, invalid, success } from '../respond.js'
import { entryId, exerciseId, isoDate, limit } from '../schema.js'
import { defineTool } from '../types.js'
import { workoutDetail, workoutSummary } from './format.js'

export const readWorkouts = defineTool({
  name: 'read_workouts',
  description:
    'Logged workouts, newest first: date, name, routines, start, duration, exercises, sets (done/total/work), volume, PRs, body weight, note. Filter by date range (inclusive), routine or exercise. Weights and volume are in the profile unit (`unit`).',
  input: {
    from: isoDate.optional(),
    to: isoDate.optional(),
    routineId: entryId.optional(),
    exerciseId: exerciseId.optional(),
    limit: limit(20, 500),
  },
  async handler(args, ctx) {
    if (args.from && args.to && args.from > args.to) return invalid('from is after to')
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const matches = listOf(state, 'workouts')
      .filter(
        (w) =>
          (!args.from || String(w.d) >= args.from) &&
          (!args.to || String(w.d) <= args.to) &&
          (!args.routineId || routineIdsOf(w).includes(args.routineId)) &&
          (!args.exerciseId || listOf(w, 'entries').some((e) => e.id === args.exerciseId)),
      )
      .reverse()
    const max = args.limit ?? 20
    return success({
      unit: unitOf(state),
      total: matches.length,
      ...(matches.length > max ? { truncated: true } : {}),
      ...(exercises.warning ? { warning: exercises.warning } : {}),
      workouts: matches.slice(0, max).map((w) => workoutSummary(w, state, exercises)),
    })
  },
})

export const readWorkout = defineTool({
  name: 'read_workout',
  description:
    'One workout set by set, by `id` or by `date`, in the format write_update_workout takes back: each exercise with exerciseId, sets (weight, reps, done, rir/rpe, warmup, drops for a drop set, clusters for rest-pause where reps is the total, left/right for a per-side set, sec for timed, min and speed in km/h for cardio), note, superset, routineId; plus name, volume and bestWeight for reading, and `other` for fields openGym keeps that leap leaves alone. A date with several workouts returns their ids to choose from.',
  input: { id: entryId.optional(), date: isoDate.optional() },
  async handler(args, ctx) {
    if (!args.id === !args.date) return invalid('give exactly one of id or date')
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const workouts = listOf(state, 'workouts')
    const found = args.id ? workouts.filter((w) => w.id === args.id) : workouts.filter((w) => w.d === args.date)
    if (found.length === 0) {
      return failure(args.id ? `No workout with id "${args.id}"; find ids with read_workouts` : `No workout on ${args.date}`)
    }
    if (found.length > 1 && args.date) {
      return success({
        date: args.date,
        unit: unitOf(state),
        choose: 'Several workouts on this day; read one by id',
        workouts: found.map((w) => workoutSummary(w, state, exercises)),
      })
    }
    return success({ unit: unitOf(state), ...workoutDetail(found[0]!, state, exercises), ...(exercises.warning ? { warning: exercises.warning } : {}) })
  },
})

export const workoutReadTools = [readWorkouts, readWorkout]
