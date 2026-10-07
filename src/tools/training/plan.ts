import { z } from 'zod'
import { addDays, today, WEEKDAYS, weekdayOf } from '../../domain/dates.js'
import { planFor, routineName, weekdayRoutineIds } from '../../domain/plan.js'
import { itemForTools } from '../../domain/routine-items.js'
import { routineIdsOf } from '../../domain/sets.js'
import { listOf, mapOf, unitOf, type Entry, type State } from '../../state/types.js'
import { loadProfile } from '../context.js'
import { failure, success } from '../respond.js'
import { entryId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function weekdaysOf(state: State | null, routineId: string): string[] {
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => weekdayRoutineIds(state, d).includes(routineId)).map((d) => WEEKDAYS[d]!)
}

function lastDone(state: State | null, routineId: string): string | undefined {
  const w = listOf(state, 'workouts').findLast((x) => routineIdsOf(x).includes(routineId))
  return typeof w?.d === 'string' ? w.d : undefined
}

function exercisesOf(routine: Entry): Entry[] {
  return listOf(routine, 'ex')
}

export const readRoutines = defineTool({
  name: 'read_routines',
  description: 'The profile\'s routines (workout templates): id, name, emoji, number of exercises, the weekdays they are planned on, and when each was last done.',
  input: {},
  async handler(_args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state } = profile.data
    return success({
      routines: listOf(state, 'routines').map((r) => {
        const id = String(r.id)
        const done = lastDone(state, id)
        const days = weekdaysOf(state, id)
        return {
          id,
          name: str(r.name) ?? id,
          ...(str(r.emoji) ? { emoji: r.emoji } : {}),
          exercises: exercisesOf(r).length,
          ...(days.length ? { weekdays: days } : {}),
          ...(done ? { lastDone: done } : {}),
          ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
        }
      }),
    })
  },
})

export const readRoutine = defineTool({
  name: 'read_routine',
  description:
    'One routine: every exercise in the format write_routine takes (exerciseId, sets, reps — with double progression the top of the range, repsMin its bottom —, repsMax, weight in the profile unit, mode reps/time/cardio with sec or min/speed, restSec, warmupSets, superset, note, progression, increment, deloadFactor, bodyweight, perSide, assisted, intensifier; `other` lists fields openGym keeps that leap leaves alone), plus its name, weekdays, upcoming date overrides and when it was last done. What the app prescribes next can differ: history and progression move the weight.',
  input: { id: entryId },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state, exercises } = profile.data
    const routine = listOf(state, 'routines').find((r) => r.id === args.id)
    if (!routine) return failure(`No routine with id "${args.id}"; find ids with read_routines`)
    const from = today()
    const dates = Object.entries(mapOf(state, 'dayPlan'))
      .filter(([date, id]) => id === args.id && date >= from)
      .map(([date]) => date)
      .sort()
    const { ex: _ex, prog, ...rest } = routine
    const days = weekdaysOf(state, args.id)
    const done = lastDone(state, args.id)
    return success({
      unit: unitOf(state),
      ...rest,
      ...(prog !== undefined ? { progression: prog } : {}),
      exercises: exercisesOf(routine).map((item, i) => itemForTools(item, i + 1, exercises.name(String(item.id)))),
      ...(days.length ? { weekdays: days } : {}),
      ...(dates.length ? { plannedDates: dates } : {}),
      ...(done ? { lastDone: done } : {}),
      ...(exercises.warning ? { warning: exercises.warning } : {}),
    })
  },
})

export const readWeekPlan = defineTool({
  name: 'read_week_plan',
  description:
    'The training plan: the weekly schedule (weekday → routines) and, day by day from `from` (default today) for `days` days (default 7), what is planned (a date override in dayPlan wins over the weekday; "rest" means rest) and which workouts were logged that day.',
  input: {
    from: isoDate.optional(),
    days: z.number().int().min(1).max(62).optional(),
  },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state } = profile.data
    const start = args.from ?? today()
    const named = (ids: string[]) => ids.map((id) => ({ id, name: routineName(state, id) }))
    const weekStart = state?.weekStart === 0 ? 0 : 1
    const order = weekStart === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0]
    const workouts = listOf(state, 'workouts')
    const days = Array.from({ length: args.days ?? 7 }, (_, i) => {
      const date = addDays(start, i)
      const plan = planFor(state, date)
      const logged = workouts.filter((w) => w.d === date).map((w) => ({ id: w.id, name: w.name }))
      return {
        date,
        weekday: WEEKDAYS[weekdayOf(date)],
        ...(plan.routineIds.length ? { routines: named(plan.routineIds) } : { rest: true }),
        ...(plan.override ? { override: plan.override } : {}),
        ...(logged.length ? { workouts: logged } : {}),
      }
    })
    return success({
      weekStartsOn: WEEKDAYS[weekStart],
      week: Object.fromEntries(order.map((d) => [WEEKDAYS[d], named(weekdayRoutineIds(state, d))])),
      days,
    })
  },
})

const round1 = (v: number) => Math.round(v * 10) / 10

export const readBodyweight = defineTool({
  name: 'read_bodyweight',
  description:
    'Body-weight log (one weigh-in per day), newest first, in the profile unit: the latest weigh-in, the goal (targetW) and the distance to it, the change over the last 7 and 30 days, and the entries in the range (default the last 30).',
  input: {
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximum entries (default 30)'),
  },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state } = profile.data
    const all = listOf(state, 'bodyweight')
      .filter((e) => typeof e.d === 'string' && typeof e.w === 'number')
      .sort((a, b) => String(a.d).localeCompare(String(b.d)))
    const latest = all.at(-1)
    const at = (date: string) => all.findLast((e) => String(e.d) <= date)
    const change = (days: number) => {
      if (!latest) return undefined
      const then = at(addDays(String(latest.d), -days))
      return then ? round1(Number(latest.w) - Number(then.w)) : undefined
    }
    const goal = typeof state?.targetW === 'number' ? state.targetW : undefined
    const inRange = all.filter((e) => (!args.from || String(e.d) >= args.from) && (!args.to || String(e.d) <= args.to)).reverse()
    const max = args.limit ?? 30
    const c7 = change(7)
    const c30 = change(30)
    return success({
      unit: unitOf(state),
      ...(latest ? { latest: { date: latest.d, weight: latest.w } } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(goal !== undefined && latest ? { toGoal: round1(goal - Number(latest.w)) } : {}),
      ...(c7 !== undefined ? { change7d: c7 } : {}),
      ...(c30 !== undefined ? { change30d: c30 } : {}),
      total: inRange.length,
      ...(inRange.length > max ? { truncated: true } : {}),
      entries: inRange.slice(0, max).map((e) => ({ date: e.d, weight: e.w })),
    })
  },
})

export const planReadTools = [readRoutines, readRoutine, readWeekPlan, readBodyweight]
