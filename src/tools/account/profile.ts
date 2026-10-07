import { z } from 'zod'
import { addDays, localDateTime, today, WEEKDAYS, weekdayOf } from '../../domain/dates.js'
import { planFor, routineName } from '../../domain/plan.js'
import { listOf, unitOf, type State } from '../../state/types.js'
import { failure, success } from '../respond.js'
import { defineTool } from '../types.js'

/** Keys with their own tools; everything else at the top level is a setting. */
const DATA_KEYS = new Set([
  'workouts',
  'routines',
  'bodyweight',
  'customEx',
  'exWeights',
  'exNotes',
  'week',
  'dayPlan',
  'favEx',
  'equipProfiles',
  'gymCards',
  'coach',
  'resetAt',
  'resetIds',
  'unitSet',
  'active',
  '_rev',
  '_ts',
])

export const readProfile = defineTool({
  name: 'read_profile',
  description:
    'Overview of the signed-in profile: name, unit, how much is logged (workouts, routines, custom exercises, weigh-ins), first and last workout, workouts in the last 7 and 30 days (today included), what is planned today and the next training day, latest body weight and goal. Start here.',
  input: {},
  async handler(_args, ctx) {
    const [me, snapshot] = await Promise.all([
      ctx.http.request<{ user: { id: string; name: string; admin?: boolean } }>({ method: 'GET', path: '/api/me' }),
      ctx.store.load(),
    ])
    if (!me.ok) return failure('Could not read the signed-in profile', me)
    if (!snapshot.ok) return failure('Could not read the profile', snapshot)
    const { state, rev } = snapshot.data
    const workouts = listOf(state, 'workouts')
    const day = today()
    const since = (days: number) => workouts.filter((w) => String(w.d) > addDays(day, -days) && String(w.d) <= day).length
    const named = (ids: string[]) => ids.map((id) => ({ id, name: routineName(state, id) }))
    const todayPlan = planFor(state, day)
    let next: { date: string; weekday: string; routines: { id: string; name: string }[] } | undefined
    for (let i = 1; i <= 7 && !next; i++) {
      const date = addDays(day, i)
      const plan = planFor(state, date)
      if (plan.routineIds.length) next = { date, weekday: WEEKDAYS[weekdayOf(date)]!, routines: named(plan.routineIds) }
    }
    const weighIns = listOf(state, 'bodyweight').filter((e) => typeof e.d === 'string')
    const latest = weighIns.sort((a, b) => String(a.d).localeCompare(String(b.d))).at(-1)
    return success({
      id: me.data.user.id,
      name: me.data.user.name,
      ...(me.data.user.admin ? { admin: true } : {}),
      unit: unitOf(state),
      synced: state !== null,
      counts: {
        workouts: workouts.length,
        routines: listOf(state, 'routines').length,
        customExercises: listOf(state, 'customEx').length,
        weighIns: weighIns.length,
      },
      ...(workouts.length ? { firstWorkout: workouts[0]!.d, lastWorkout: workouts.at(-1)!.d } : {}),
      workoutsLast7Days: since(7),
      workoutsLast30Days: since(30),
      today: {
        date: day,
        weekday: WEEKDAYS[weekdayOf(day)],
        ...(todayPlan.routineIds.length ? { planned: named(todayPlan.routineIds) } : { rest: true }),
        done: workouts.filter((w) => w.d === day).map((w) => ({ id: w.id, name: w.name })),
      },
      ...(next ? { nextTraining: next } : {}),
      ...(latest ? { bodyWeight: { date: latest.d, weight: latest.w } } : {}),
      ...(typeof state?.targetW === 'number' ? { goalWeight: state.targetW } : {}),
      revision: rev,
      ...(localDateTime(state?._ts) ? { lastChanged: localDateTime(state?._ts) } : {}),
    })
  },
})

function settingsOf(state: State | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state ?? {}).filter(([k]) => !DATA_KEYS.has(k)))
}

export const readSettings = defineTool({
  name: 'read_settings',
  description:
    'Every stored setting of the profile as openGym keeps it (unit, lang, theme, accent, restSec, restPauseSec, effort none/rir/rpe, weekStart 0=Sunday 1=Monday, startFrom plan/last, reminder {on,time,tz}, targetW, workoutView, wdec, speedUnit, sound, keepAwake, weighIn, autoBackup, ...). A setting that is absent uses the app default. Training data has its own tools.',
  input: {},
  async handler(_args, ctx) {
    const snapshot = await ctx.store.load()
    if (!snapshot.ok) return failure('Could not read the profile', snapshot)
    return success({ unit: unitOf(snapshot.data.state), settings: settingsOf(snapshot.data.state) })
  },
})

const MAX_CHARS = 200_000

export const readDocument = defineTool({
  name: 'read_document',
  description:
    'Escape hatch: the raw profile document openGym stores. Without `key`, lists its top-level keys with their type and size. With `key`, returns that value as stored. Prefer the dedicated tools; use this for data they do not cover. Large values are refused with their size.',
  input: { key: z.string().min(1).max(64).optional() },
  async handler(args, ctx) {
    const snapshot = await ctx.store.load()
    if (!snapshot.ok) return failure('Could not read the profile', snapshot)
    const state = snapshot.data.state ?? {}
    if (!args.key) {
      return success({
        revision: snapshot.data.rev,
        keys: Object.entries(state)
          .map(([key, value]) => ({
            key,
            type: Array.isArray(value) ? `list(${value.length})` : value === null ? 'null' : typeof value,
            chars: JSON.stringify(value)?.length ?? 0,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      })
    }
    if (!(args.key in state)) return failure(`The profile has no "${args.key}"; list the keys with read_document without a key`)
    const value = state[args.key]
    const chars = JSON.stringify(value)?.length ?? 0
    if (chars > MAX_CHARS) return failure(`"${args.key}" is ${chars} characters, above the ${MAX_CHARS} limit; use the dedicated read tools`)
    return success({ revision: snapshot.data.rev, key: args.key, value })
  },
})

export const profileReadTools = [readProfile, readSettings, readDocument]
