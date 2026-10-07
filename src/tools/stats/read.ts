import { z } from 'zod'
import { addDays, dateOf, isoDate as isoOf, today } from '../../domain/dates.js'
import { exerciseSessions, loggedExerciseIds, muscleLoads, type BestSet, type Formula } from '../../domain/stats.js'
import { completedReps, doneUnits, entriesOf, isWarmup, setsOf, workoutVolume } from '../../domain/sets.js'
import { listOf, unitOf, type Entry } from '../../state/types.js'
import { loadProfile } from '../context.js'
import { failure, invalid, success } from '../respond.js'
import { exerciseId, isoDate, limit } from '../schema.js'
import { defineTool } from '../types.js'
import { round } from '../training/format.js'

const formula = z
  .enum(['epley', 'brzycki', 'lombardi'])
  .optional()
  .describe('1RM formula (default epley, as in the app). No estimate above 12 reps; 1 rep is the weight itself.')

const oneRm = (b: BestSet | null) => (b ? { estimate: b.estimate, weight: b.w, reps: b.r } : undefined)

export const readExerciseHistory = defineTool({
  name: 'read_exercise_history',
  description:
    'Every session of one exercise, newest first: the completed work sets ("100×5", drops as "→ 80×6", per side as "L …/ R …"), work sets, reps, volume, best weight, best estimated 1RM, and whether the session set a weight record or a 1RM record against all earlier sessions (the first load ever logged counts, as in the app). Plus all-time bests. Weights in the profile unit.',
  input: { exerciseId, from: isoDate.optional(), to: isoDate.optional(), limit: limit(20, 1000), formula },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const all = exerciseSessions(state, args.exerciseId, exercises, (args.formula ?? 'epley') as Formula)
    if (!all.length && !exercises.get(args.exerciseId)) return failure(`No exercise with id "${args.exerciseId}" and no sessions of it; find ids with read_exercises`)
    const bestWeight = all.filter((s) => s.weightRecord).at(-1)
    const best1RM = all.filter((s) => s.estimateRecord).at(-1)
    const inRange = all.filter((s) => (!args.from || s.date >= args.from) && (!args.to || s.date <= args.to)).reverse()
    const max = args.limit ?? 20
    return success({
      id: args.exerciseId,
      name: exercises.name(args.exerciseId),
      unit: unitOf(state),
      formula: args.formula ?? 'epley',
      sessionsTotal: all.length,
      ...(all.length ? { firstDone: all[0]!.date, lastDone: all.at(-1)!.date } : {}),
      ...(bestWeight ? { bestWeight: { weight: bestWeight.bestWeight, date: bestWeight.date } } : {}),
      ...(best1RM?.best1RM ? { best1RM: { ...oneRm(best1RM.best1RM), date: best1RM.date } } : {}),
      total: inRange.length,
      ...(inRange.length > max ? { truncated: true } : {}),
      sessions: inRange.slice(0, max).map((s) => ({
        date: s.date,
        workoutId: s.workoutId,
        ...(s.name ? { workout: s.name } : {}),
        sets: s.sets,
        workSets: s.workSets,
        reps: s.reps,
        volume: s.volume,
        ...(s.bestWeight > 0 ? { bestWeight: s.bestWeight } : {}),
        ...(s.best1RM ? { best1RM: oneRm(s.best1RM) } : {}),
        ...(s.weightRecord ? { weightRecord: true } : {}),
        ...(s.estimateRecord ? { estimateRecord: true } : {}),
      })),
    })
  },
})

export const readRecords = defineTool({
  name: 'read_records',
  description:
    'Personal records of every exercise ever logged: best weight (and when), best estimated 1RM with the set it came from, number of sessions, last done. Sort by most recent record (default), by 1RM, or by name. Weights in the profile unit.',
  input: {
    sort: z.enum(['recent', 'estimate', 'name']).optional(),
    since: isoDate.optional().describe('Only exercises with a record set on or after this date'),
    limit: limit(50, 2000),
    formula,
  },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const rows = loggedExerciseIds(state).map((id) => {
      const sessions = exerciseSessions(state, id, exercises, (args.formula ?? 'epley') as Formula)
      const w = sessions.filter((s) => s.weightRecord).at(-1)
      const e = sessions.filter((s) => s.estimateRecord).at(-1)
      const lastRecord = [w?.date, e?.date].filter((d): d is string => !!d).sort().at(-1)
      return {
        id,
        name: exercises.name(id),
        sessions: sessions.length,
        ...(sessions.length ? { lastDone: sessions.at(-1)!.date } : {}),
        ...(w ? { bestWeight: { weight: w.bestWeight, date: w.date } } : {}),
        ...(e?.best1RM ? { best1RM: { ...oneRm(e.best1RM), date: e.date } } : {}),
        ...(lastRecord ? { lastRecord } : {}),
      }
    })
    const filtered = rows.filter((r) => r.sessions > 0 && (!args.since || (r.lastRecord ?? '') >= args.since))
    const sort = args.sort ?? 'recent'
    filtered.sort(
      (a, b) =>
        (sort === 'estimate'
          ? (b.best1RM?.estimate ?? 0) - (a.best1RM?.estimate ?? 0)
          : sort === 'recent'
            ? (b.lastRecord ?? '').localeCompare(a.lastRecord ?? '')
            : 0) || a.name.localeCompare(b.name),
    )
    const max = args.limit ?? 50
    return success({
      unit: unitOf(state),
      formula: args.formula ?? 'epley',
      total: filtered.length,
      ...(filtered.length > max ? { truncated: true } : {}),
      ...(exercises.warning ? { warning: exercises.warning } : {}),
      records: filtered.slice(0, max),
    })
  },
})

/** Start of the period a day belongs to: its week (by the profile's first weekday) or month. */
function periodStart(iso: string, by: 'week' | 'month' | 'day', weekStart: number): string {
  if (by === 'day') return iso
  if (by === 'month') return `${iso.slice(0, 7)}-01`
  const back = (dateOf(iso).getDay() - weekStart + 7) % 7
  return addDays(iso, -back)
}

function range(args: { from?: string | undefined; to?: string | undefined }, defaultDays: number) {
  const to = args.to ?? today()
  return { from: args.from ?? addDays(to, -(defaultDays - 1)), to }
}

const MAX_PERIODS = 400

export const readTrainingSummary = defineTool({
  name: 'read_training_summary',
  description:
    'Training totals per week (default; weeks start on the profile\'s first weekday), month or day over a date range (default the last 12 weeks): workouts, minutes, completed work sets, reps and volume, plus totals for the whole range. Weights in the profile unit.',
  input: {
    from: isoDate.optional(),
    to: isoDate.optional(),
    groupBy: z.enum(['week', 'month', 'day']).optional(),
  },
  async handler(args, ctx) {
    const { from, to } = range(args, 84)
    if (from > to) return invalid('from is after to')
    const by = args.groupBy ?? 'week'
    const span = (dateOf(to).getTime() - dateOf(from).getTime()) / 86_400_000
    const count = by === 'day' ? span + 1 : by === 'week' ? span / 7 + 1 : span / 28 + 1
    if (count > MAX_PERIODS) return invalid(`too many ${by}s (${Math.round(count)}); choose a shorter range or group by ${by === 'day' ? 'week or month' : 'month'}`)
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state } = profile.data
    const weekStart = state?.weekStart === 0 ? 0 : 1
    const periods = new Map<string, { workouts: number; minutes: number; workSets: number; reps: number; volume: number }>()
    const blank = () => ({ workouts: 0, minutes: 0, workSets: 0, reps: 0, volume: 0 })
    for (let d = periodStart(from, by, weekStart); d <= to; d = by === 'month' ? isoOf(new Date(dateOf(d).getFullYear(), dateOf(d).getMonth() + 1, 1)) : addDays(d, by === 'week' ? 7 : 1)) {
      periods.set(d, blank())
    }
    const total = blank()
    for (const w of listOf(state, 'workouts')) {
      const d = String(w.d)
      if (d < from || d > to) continue
      const p = periods.get(periodStart(d, by, weekStart)) ?? blank()
      const minutes = typeof w.start === 'number' && typeof w.end === 'number' && w.end > w.start ? Math.round((w.end - w.start) / 60_000) : 0
      const work = entriesOf(w).flatMap((e: Entry) => setsOf(e).filter((s) => !isWarmup(s)))
      const add = {
        workouts: 1,
        minutes,
        workSets: work.reduce((n, s) => n + doneUnits(s), 0),
        reps: work.reduce((n, s) => n + completedReps(s), 0),
        volume: workoutVolume(w),
      }
      for (const t of [p, total]) for (const k of Object.keys(add) as (keyof typeof add)[]) t[k] += add[k]
      periods.set(periodStart(d, by, weekStart), p)
    }
    return success({
      unit: unitOf(state),
      from,
      to,
      groupBy: by,
      total: { ...total, volume: round(total.volume) },
      periods: [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, t]) => ({ start, ...t, volume: round(t.volume) })),
    })
  },
})

export const readMuscleBalance = defineTool({
  name: 'read_muscle_balance',
  description:
    'Which muscles were trained over a date range (default the last 7 days, today included): completed work sets per muscle, where the exercise\'s target muscle counts 1 per set and each secondary muscle 0.4, ranked, with a level 1–4 relative to the most trained muscle, and the main muscles not trained at all. Based on the exercise dataset\'s muscles, so it can differ from the app\'s own muscle map.',
  input: { from: isoDate.optional(), to: isoDate.optional() },
  async handler(args, ctx) {
    const { from, to } = range(args, 7)
    if (from > to) return invalid('from is after to')
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const workouts = listOf(state, 'workouts').filter((w) => String(w.d) >= from && String(w.d) <= to)
    const { loads, unknownExercises } = muscleLoads(workouts, exercises)
    const trained = new Set(loads.map((l) => l.muscle))
    const main = [...new Set([...exercises.byId.values()].filter((e) => !e.custom && e.target && e.target !== 'cardiovascular system').map((e) => e.target!))]
    return success({
      from,
      to,
      workouts: workouts.length,
      muscles: loads,
      untrained: main.filter((m) => !trained.has(m)).sort(),
      ...(unknownExercises.length ? { notCounted: unknownExercises.map((id) => exercises.name(id)), notCountedReason: 'no muscle data for these exercises' } : {}),
      ...(exercises.warning ? { warning: exercises.warning } : {}),
    })
  },
})

export const statsReadTools = [readExerciseHistory, readRecords, readTrainingSummary, readMuscleBalance]
