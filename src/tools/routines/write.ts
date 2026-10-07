import { z } from 'zod'
import { customExercises } from '../../catalog/exercises.js'
import { WEEKDAYS } from '../../domain/dates.js'
import { routineName, weekdayRoutineIds } from '../../domain/plan.js'
import { newId } from '../../state/ids.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, mapOf, writableList, writableMap, type Entry, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { entryId, exerciseId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, LAST_CHANGE_NOTE, RESURRECTION_NOTE } from '../write.js'

const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'] as const

const item = z
  .object({
    exerciseId,
    sets: z.number().int().min(1).max(20),
    reps: z.number().int().min(1).max(100).optional(),
    repsMin: z.number().int().min(1).max(100).optional().describe('Bottom of a rep range (double progression)'),
    repsMax: z.number().int().min(1).max(100).optional(),
    weight: z.number().min(0).max(2000).optional().describe('In the profile unit; added weight for body-weight exercises'),
    mode: z.enum(['reps', 'time', 'cardio']).optional().describe('Default reps; time uses sec, cardio uses min and speed'),
    sec: z.number().int().min(1).max(7200).optional(),
    min: z.number().min(0.5).max(600).optional(),
    speed: z.number().min(0).max(60).optional().describe('km/h'),
    restSec: z.number().int().min(0).max(3600).optional(),
    warmupRestSec: z.number().int().min(0).max(3600).optional(),
    warmupSets: z.number().int().min(0).max(5).optional(),
    superset: z.string().min(1).max(20).optional().describe('Label shared by adjacent exercises done as a superset, e.g. "A"'),
    note: z.string().max(500).optional(),
    progression: z.enum(POLICIES).optional().describe('Overrides the routine progression for this exercise'),
    increment: z.number().positive().max(100).optional(),
    deloadFactor: z.number().min(0.5).max(1).optional(),
    bodyweight: z.boolean().optional(),
    perSide: z.boolean().optional().describe('Unilateral; reps are the total of both sides'),
    assisted: z.boolean().optional(),
    intensifier: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('dropset'), count: z.number().int().min(1).max(10), pct: z.number().int().min(5).max(90) }),
        z.object({ type: z.literal('restpause'), totalReps: z.number().int().min(1).max(200), restSec: z.number().int().min(5).max(120) }),
      ])
      .optional(),
  })
  .strict()

type Item = z.output<typeof item>

/** Item fields leap writes; anything else on an existing item is openGym's and is carried over. */
const MANAGED = new Set([
  'id', 'sets', 'reps', 'repsMin', 'repsMax', 'weight', 'mode', 'sec', 'min', 'speed', 'restSec', 'warmupRestSec',
  'warmupSets', 'sg', 'note', 'prog', 'inc', 'deloadFactor', 'bodyweight', 'side', 'assisted', 'intensifier',
])

function storedItem(input: Item, sg: string | undefined, carried: Entry): Entry {
  const out: Entry = { ...carried, id: input.exerciseId, sets: input.sets }
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== '') out[key] = value
  }
  set('reps', input.reps)
  set('repsMin', input.repsMin)
  set('repsMax', input.repsMax)
  set('weight', input.weight)
  set('mode', input.mode)
  set('sec', input.sec)
  set('min', input.min)
  set('speed', input.speed)
  set('restSec', input.restSec)
  set('warmupRestSec', input.warmupRestSec)
  set('warmupSets', input.warmupSets)
  set('sg', sg)
  set('note', input.note?.trim())
  set('prog', input.progression)
  set('inc', input.increment)
  set('deloadFactor', input.deloadFactor)
  set('bodyweight', input.bodyweight)
  set('side', input.perSide)
  set('assisted', input.assisted)
  set('intensifier', input.intensifier)
  return out
}

function itemProblems(items: Item[]): string[] {
  const problems: string[] = []
  items.forEach((x, i) => {
    if (x.repsMin !== undefined && x.repsMax !== undefined && x.repsMin > x.repsMax) problems.push(`exercise ${i + 1}: repsMin is above repsMax`)
    if (x.mode === 'cardio' && (x.reps !== undefined || x.sec !== undefined)) problems.push(`exercise ${i + 1}: a cardio exercise takes min and speed, not reps or sec`)
    if (x.mode === 'time' && x.reps !== undefined) problems.push(`exercise ${i + 1}: a timed exercise takes sec, not reps`)
  })
  const labels = items.map((x) => x.superset)
  const seen = new Set<string>()
  labels.forEach((label, i) => {
    if (!label) return
    if (seen.has(label) && labels[i - 1] !== label) problems.push(`superset "${label}" is split; its exercises must be next to each other`)
    seen.add(label)
  })
  for (const label of seen) if (labels.filter((l) => l === label).length < 2) problems.push(`superset "${label}" has only one exercise`)
  return problems
}

/** The routine's new exercise list: input order, superset labels turned into ids, openGym's extra fields kept per exercise. */
function buildItems(items: Item[], existing: Entry[], now: number): Entry[] {
  const pool = new Map<string, Entry[]>()
  for (const e of existing) {
    const id = String(e.id)
    pool.set(id, [...(pool.get(id) ?? []), e])
  }
  const groups = new Map<string, string>()
  return items.map((x) => {
    const old = pool.get(x.exerciseId)?.shift()
    const carried = old ? Object.fromEntries(Object.entries(old).filter(([k]) => !MANAGED.has(k))) : {}
    let sg: string | undefined
    if (x.superset) {
      if (!groups.has(x.superset)) {
        const reuse = typeof old?.sg === 'string' && ![...groups.values()].includes(old.sg) ? old.sg : undefined
        groups.set(x.superset, reuse ?? newId('sg', now))
      }
      sg = groups.get(x.superset)
    }
    return storedItem(x, sg, carried)
  })
}

async function exerciseCheck(ctx: ToolContext): Promise<(state: State, ids: string[]) => string | undefined> {
  const builtin = await ctx.builtinExercises()
  return (state, ids) => {
    const custom = new Set(customExercises(state).map((c) => c.id))
    const unknown = ids.filter((id) => !builtin.exercises.has(id) && !custom.has(id) && !(builtin.error && !id.startsWith('c')))
    return unknown.length ? `unknown exercise ids: ${[...new Set(unknown)].join(', ')}; find ids with read_exercises` : undefined
  }
}

const routineLine = (r: Entry) => ({ id: r.id, name: r.name, exercises: listOf(r, 'ex').length })

export const writeRoutine = defineTool({
  name: 'write_routine',
  description:
    'Create a routine (no id) or change one (id). `exercises`, when given, replaces the whole list in that order; fields openGym keeps that this tool does not know are carried over from the same exercise\'s existing entry. Weights in the profile unit. Exercises sharing a `superset` label must be next to each other. `progression` is the routine default: off, linear (default for reps), greyskull, double, time.',
  input: {
    id: entryId.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    emoji: z.string().max(30).optional(),
    progression: z.enum(POLICIES).optional(),
    excludeFromProgression: z.boolean().optional(),
    exercises: z.array(item).max(40).optional(),
  },
  async handler(args, ctx) {
    if (!args.id && !args.name) return invalid('a new routine needs a name')
    if (args.id && [args.name, args.emoji, args.progression, args.excludeFromProgression, args.exercises].every((v) => v === undefined)) {
      return invalid('nothing to change')
    }
    const problems = itemProblems(args.exercises ?? [])
    if (problems.length) return invalid(problems.join('; '))
    const check = await exerciseCheck(ctx)
    return change(
      ctx,
      'save the routine',
      (draft, { now }) => {
        const unknown = check(draft, (args.exercises ?? []).map((x) => x.exerciseId))
        if (unknown) return refuse(unknown)
        const routines = writableList(draft, 'routines')
        let routine: Entry
        if (args.id) {
          const found = routines.find((r): r is Entry => isRecord(r) && r.id === args.id)
          if (!found) return refuse(`no routine with id "${args.id}"; find ids with read_routines`)
          routine = found
        } else {
          routine = { id: newId('', now), name: args.name, ex: [] }
          routines.push(routine)
        }
        if (args.name !== undefined) routine.name = args.name
        if (args.emoji !== undefined) {
          if (args.emoji) routine.emoji = args.emoji
          else delete routine.emoji
        }
        if (args.progression !== undefined) routine.prog = args.progression
        if (args.excludeFromProgression !== undefined) {
          if (args.excludeFromProgression) routine.excludeFromProgression = true
          else delete routine.excludeFromProgression
        }
        if (args.exercises) routine.ex = buildItems(args.exercises, listOf(routine, 'ex'), now)
        routine._ts = now
        return apply({ routine: structuredClone(routine), created: !args.id })
      },
      (r) => ({ ...(r.created ? { created: true } : {}), routine: routineLine(r.routine) }),
      {
        verify: (s, r) => {
          const stored = listOf(s, 'routines').find((x) => x.id === r.routine.id)
          if (!stored) return [`routine ${String(r.routine.id)}`]
          return JSON.stringify(stored) === JSON.stringify(r.routine) ? [] : [`routine ${String(r.routine.id)} differs from what was written`]
        },
      },
    )
  },
})

export const writeCopyRoutine = defineTool({
  name: 'write_copy_routine',
  description: 'Copy a routine with all its exercises and settings under a new id; the name defaults to "<name> (Copy)", as in the app.',
  input: { id: entryId, name: z.string().trim().min(1).max(60).optional() },
  async handler(args, ctx) {
    return change(
      ctx,
      'copy the routine',
      (draft, { now }) => {
        const routines = writableList(draft, 'routines')
        const source = routines.find((r): r is Entry => isRecord(r) && r.id === args.id)
        if (!source) return refuse(`no routine with id "${args.id}"; find ids with read_routines`)
        const copy = structuredClone(source)
        copy.id = newId('', now)
        copy.name = args.name ?? copyName(String(source.name ?? ''), routines)
        copy._ts = now
        routines.push(copy)
        return apply(copy)
      },
      (copy) => ({ created: true, routine: routineLine(copy), copiedFrom: args.id }),
      { verify: (s, copy) => (listOf(s, 'routines').some((r) => r.id === copy.id) ? [] : [`routine ${String(copy.id)}`]) },
    )
  },
})

/** "Push (Copy)", then "Push (Copy 2)", never "Push (Copy) (Copy)". */
function copyName(name: string, routines: unknown[]): string {
  const base = name.replace(/ \(Copy(?: \d+)?\)$/, '')
  const taken = new Set(routines.filter(isRecord).map((r) => r.name))
  if (!taken.has(`${base} (Copy)`)) return `${base} (Copy)`
  for (let n = 2; ; n++) if (!taken.has(`${base} (Copy ${n})`)) return `${base} (Copy ${n})`
}

export const deleteRoutine = defineTool({
  name: 'delete_routine',
  description: `Delete a routine, as the app does: it is also taken off every weekday and every date it was planned on. Logged workouts keep their history. ${RESURRECTION_NOTE}`,
  input: { id: entryId },
  async handler(args, ctx) {
    return change(
      ctx,
      'delete the routine',
      (draft) => {
        const routine = listOf(draft, 'routines').find((r) => r.id === args.id)
        if (!routine) return refuse(`no routine with id "${args.id}"; find ids with read_routines`)
        draft.routines = writableList(draft, 'routines').filter((r) => !(isRecord(r) && r.id === args.id))
        const week = writableMap(draft, 'week')
        const weekdays: string[] = []
        for (const day of Object.keys(week)) {
          const ids = weekdayRoutineIds(draft, Number(day))
          if (!ids.includes(args.id)) continue
          weekdays.push(WEEKDAYS[Number(day)] ?? day)
          const rest = ids.filter((id) => id !== args.id)
          if (rest.length) week[day] = rest
          else delete week[day]
        }
        const dayPlan = writableMap(draft, 'dayPlan')
        const dates = Object.keys(dayPlan).filter((d) => dayPlan[d] === args.id)
        for (const d of dates) delete dayPlan[d]
        return apply({ name: routine.name, weekdays, dates: dates.sort() })
      },
      (r) => ({
        deleted: { id: args.id, name: r.name },
        ...(r.weekdays.length ? { removedFromWeekdays: r.weekdays } : {}),
        ...(r.dates.length ? { removedFromDates: r.dates } : {}),
        note: RESURRECTION_NOTE,
      }),
      {
        verify: (s) =>
          listOf(s, 'routines').some((r) => r.id === args.id) || Object.values(mapOf(s, 'dayPlan')).includes(args.id)
            ? [`routine ${args.id} is still there`]
            : [],
      },
    )
  },
})

const weekdayKey = z
  .string()
  .transform((v, c) => {
    const i = WEEKDAYS.findIndex((d) => d.toLowerCase() === v.trim().toLowerCase())
    const n = /^[0-6]$/.test(v.trim()) ? Number(v) : i
    if (n < 0) {
      c.addIssue({ code: 'custom', message: `"${v}" is not a weekday (Monday … Sunday)` })
      return z.NEVER
    }
    return String(n)
  })

export const writeWeekPlan = defineTool({
  name: 'write_week_plan',
  description:
    `Set the routines planned on weekdays, e.g. { "Monday": [pushId], "Friday": [pushId, legsId] }. Several routines on one day make a combined session; an empty list makes the day a rest day. Weekdays not given are left as they are. Date overrides (write_day_plan) still win on their dates. ${LAST_CHANGE_NOTE}`,
  input: { days: z.record(weekdayKey, z.array(entryId).max(5)) },
  async handler(args, ctx) {
    const entries = Object.entries(args.days)
    if (!entries.length) return invalid('no weekday given')
    return change(
      ctx,
      'save the week plan',
      (draft) => {
        const known = new Set(listOf(draft, 'routines').map((r) => r.id))
        const missing = entries.flatMap(([, ids]) => ids).filter((id) => !known.has(id))
        if (missing.length) return refuse(`no routine with id ${[...new Set(missing)].map((m) => `"${m}"`).join(', ')}; find ids with read_routines`)
        const week = writableMap(draft, 'week')
        for (const [day, ids] of entries) {
          const unique = [...new Set(ids)]
          if (unique.length) week[day] = unique
          else delete week[day]
        }
        return apply(Object.fromEntries(entries.map(([day, ids]) => [WEEKDAYS[Number(day)]!, [...new Set(ids)].map((id) => ({ id, name: routineName(draft, id) }))])))
      },
      (days) => ({ days }),
      {
        verify: (s) =>
          entries.filter(([day, ids]) => JSON.stringify(weekdayRoutineIds(s, Number(day))) !== JSON.stringify([...new Set(ids)])).map(([day]) => `week ${WEEKDAYS[Number(day)]}`),
      },
    )
  },
})

export const writeDayPlan = defineTool({
  name: 'write_day_plan',
  description:
    `Override the plan for one date: a routine id, "rest", or null to go back to the weekly plan. A date takes one routine (combined days come from the weekly plan). ${LAST_CHANGE_NOTE}`,
  input: { date: isoDate, plan: z.union([entryId, z.null()]).describe('Routine id, "rest", or null') },
  async handler(args, ctx) {
    return change(
      ctx,
      'save the day plan',
      (draft) => {
        if (args.plan !== null && args.plan !== 'rest' && !listOf(draft, 'routines').some((r) => r.id === args.plan)) {
          return refuse(`no routine with id "${args.plan}"; find ids with read_routines`)
        }
        const dayPlan = writableMap(draft, 'dayPlan')
        const previous = dayPlan[args.date] ?? null
        if (args.plan === null) delete dayPlan[args.date]
        else dayPlan[args.date] = args.plan
        return apply({ previous, name: args.plan && args.plan !== 'rest' ? routineName(draft, args.plan) : undefined })
      },
      (r) => ({ date: args.date, plan: args.plan === null ? 'weekly plan' : args.plan === 'rest' ? 'rest' : { id: args.plan, name: r.name }, previous: r.previous }),
      { verify: (s) => ((mapOf(s, 'dayPlan')[args.date] ?? null) === args.plan ? [] : [`dayPlan ${args.date}`]) },
    )
  },
})

export const routineWriteTools = [writeRoutine, writeCopyRoutine, writeWeekPlan, writeDayPlan]
export const routineDeleteTools = [deleteRoutine]
