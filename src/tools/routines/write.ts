import { z } from 'zod'
import { builtinIdShape, ExerciseIndex } from '../../catalog/exercises.js'
import { BELL_EQUIPMENT, exerciseDbLoad, type DbLoad } from '../../domain/dumbbells.js'
import { alignedOrNone, defaultItem, ITEM_FIELDS, MAX_PLANNED_SETS, normalizePyramid, POLICIES_FOR, ROUTINE_POLICIES, type ItemMode } from '../../domain/routine-items.js'
import { today, WEEKDAYS } from '../../domain/dates.js'
import { routineName, weekdayRoutineIds } from '../../domain/plan.js'
import { queueOf, queueUnusable } from '../../domain/queue.js'
import { newId } from '../../state/ids.js'
import { withoutStamps } from '../../state/stamps.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, mapOf, writableList, writableMap, type Entry, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { entryId, exerciseId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, LAST_CHANGE_NOTE, RESURRECTION_NOTE } from '../write.js'

const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional()
const intensifier = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dropset'), count: z.number().int().min(1).max(10), pct: z.number().int().min(5).max(90) }),
  z.object({ type: z.literal('restpause'), totalReps: z.number().int().min(1).max(200), restSec: z.number().int().min(5).max(120) }),
])

/**
 * One routine exercise in the format read_routine returns. For an exercise the routine already has,
 * a field left out keeps its value and null removes it; a new exercise starts from the app's defaults.
 */
const item = z
  .object({
    exerciseId,
    sets: z.number().int().min(1).max(20).optional().describe('Default 3 (cardio 1)'),
    reps: nullable(z.number().int().min(1).max(100)).describe('Reps per set (default 10); with double progression the top of the range; per side: the total of both sides, even'),
    repsMin: nullable(z.number().int().min(1).max(100)).describe('Double progression: the bottom of the range, below reps (default reps - 2)'),
    repsMax: nullable(z.number().int().min(1).max(200)).describe('Body-weight exercises without added weight: reps at which a set is added; not below reps'),
    weight: nullable(z.number().min(0).max(2000)).describe('In the profile unit; added weight for body-weight exercises'),
    mode: nullable(z.enum(['reps', 'time', 'cardio'])).describe('reps or time (sec); cardio (min, speed) is for cardio exercises only'),
    sec: nullable(z.number().int().min(1).max(7200)),
    min: nullable(z.number().min(0.5).max(600)),
    speed: nullable(z.number().min(0).max(60)).describe('km/h'),
    restSec: nullable(z.number().int().min(0).max(3600)),
    warmupRestSec: nullable(z.number().int().min(0).max(3600)),
    warmupSets: nullable(z.number().int().min(0).max(5)),
    superset: nullable(z.string().min(1).max(64)).describe('Label (or the id read_routine shows) shared by adjacent exercises done as a superset'),
    note: nullable(z.string().max(500)),
    progression: nullable(z.enum(['off', 'linear', 'greyskull', 'double', 'triple', 'time'])).describe('Overrides the routine progression: reps exercises off/linear/greyskull/double/triple, timed off/time, cardio off'),
    increment: nullable(z.number().positive().max(100)),
    deloadFactor: nullable(z.number().min(0.5).max(0.95)),
    bodyweight: nullable(z.boolean()),
    perSide: nullable(z.boolean()).describe('Unilateral; reps are the total of both sides; a timed hold per side holds the full time on each side'),
    assisted: nullable(z.boolean()),
    intensifier: nullable(intensifier),
    setsMax: nullable(z.number().int().min(2).max(10)).describe('Triple progression: the most sets it climbs to, above sets (default sets + 2 when triple is chosen)'),
    lastSetToFailure: nullable(z.boolean()).describe('Plan the last work set as an all-out set to failure (reps and timed exercises)'),
    backoff: nullable(z.boolean()).describe('Back-off sets: every set one increment lighter than the one before (reps exercises with weight; not body weight, assistance machines or rest-pause)'),
    pyramid: nullable(z.array(z.union([z.number().int().min(1).max(100), z.literal('max')])).min(1).max(10)).describe('Pyramid: the reps of each set, or "max" for as many as possible, e.g. [12, 10, 8, "max"]. Sets and reps follow it; a pyramid is never progressed'),
    pyramidRestSec: nullable(z.array(z.number().int().min(0).max(3600)).max(10)).describe('Pyramid: rest after each set in seconds (0 = the exercise rest)'),
    pyramidWeight: nullable(z.array(z.number().min(0).max(2000)).max(10)).describe('Pyramid: weight of each set in the profile unit (0 = what that set lifted last time)'),
    dumbbellLoad: nullable(z.enum(['as', 'each', 'total'])).describe("Dumbbell and kettlebell exercises: what the weight means here, per dumbbell (each), both together (total) or as entered (as); default the exercise's own choice"),
    supersetName: nullable(z.string().max(40)).describe("The superset's name (on every exercise of the superset)"),
    supersetRestSec: nullable(z.number().int().min(0).max(900)).describe('Rest after each round of the superset, seconds (0 or null: the longest rest of its exercises)'),
    position: z.number().optional().describe('Ignored (from read_routine)'),
    name: z.string().optional().describe('Ignored (from read_routine)'),
    other: z.record(z.string(), z.unknown()).optional().describe('Ignored (from read_routine); those fields are kept as they are'),
  })
  .strict()

type Item = z.output<typeof item>

function supersetProblems(items: Item[]): string[] {
  const problems: string[] = []
  const labels = items.map((x) => x.superset ?? undefined)
  const seen = new Set<string>()
  labels.forEach((label, i) => {
    if (!label) return
    if (seen.has(label) && labels[i - 1] !== label) problems.push(`superset "${label}" is split; its exercises must be next to each other`)
    seen.add(label)
  })
  for (const label of seen) if (labels.filter((l) => l === label).length < 2) problems.push(`superset "${label}" has only one exercise`)
  return problems
}

/**
 * Superset ids that no longer pair adjacent exercises are dropped, as the app does, and a group's
 * name and rest are on every member: what this call gave, else the first member's (openGym
 * `history.js` cleanupSg and `superset-meta.js`, v1.4.0). An exercise outside a group has neither.
 */
function cleanupSupersets(items: unknown[], given = new Map<string, { sgName?: string | null; sgRest?: number | null }>()): void {
  items.forEach((e, i) => {
    if (!isRecord(e) || !e.sg) return
    const prev = items[i - 1]
    const next = items[i + 1]
    if (!((isRecord(prev) && prev.sg === e.sg) || (isRecord(next) && next.sg === e.sg))) delete e.sg
  })
  const members = new Map<string, Entry[]>()
  for (const e of items) {
    if (!isRecord(e)) continue
    if (typeof e.sg !== 'string' || !e.sg) {
      delete e.sgName
      delete e.sgRest
      continue
    }
    members.set(e.sg, [...(members.get(e.sg) ?? []), e])
  }
  for (const [sg, list] of members) {
    const meta = given.get(sg) ?? {}
    const name = meta.sgName !== undefined ? meta.sgName : (list.map((e) => e.sgName).find((v) => typeof v === 'string' && v.trim()) as string | undefined)
    const rest = meta.sgRest !== undefined ? meta.sgRest : (list.map((e) => e.sgRest).find((v) => typeof v === 'number' && v > 0) as number | undefined)
    for (const e of list) {
      if (name) e.sgName = name
      else delete e.sgName
      if (rest) e.sgRest = rest
      else delete e.sgRest
    }
  }
}

interface Catalogue {
  /** The id an exercise is stored under (an alias id means the exercise it draws). */
  canonical: (id: string) => string
  unknown: (ids: string[]) => string | undefined
  cardio: (id: string) => boolean
  bodyweight: (id: string) => boolean
  equipment: (id: string) => string | undefined
  assisted: (id: string) => boolean
  /** What the exercise's weight means by default (state.dbLoad), "as" when nothing was chosen. */
  dbLoad: (id: string) => DbLoad
}

async function catalogue(ctx: ToolContext): Promise<(state: State) => Catalogue> {
  const builtin = await ctx.builtinExercises()
  return (state) => {
    const index = new ExerciseIndex(builtin, state)
    return {
      canonical: (id) => index.canonical(id),
      unknown: (ids) => {
        const missing = ids.filter((id) => !index.get(id) && !(builtin.error && builtinIdShape(id)))
        return missing.length ? `unknown exercise ids: ${[...new Set(missing)].join(', ')}; find ids with read_exercises` : undefined
      },
      cardio: (id) => index.get(id)?.bodyPart === 'cardio',
      bodyweight: (id) => index.get(id)?.equipment === 'body weight',
      equipment: (id) => index.get(id)?.equipment,
      assisted: (id) => index.assisted(id),
      dbLoad: (id) => exerciseDbLoad(state, id),
    }
  }
}

/**
 * The routine's new exercise list: input order; an exercise the routine had keeps every field not
 * given (null removes one), a new one starts from the app's defaults; checked as the app's editor
 * checks it (openGym `frontend/src/sheets.jsx` routine editor, v1.4.0). Returns the items or why not.
 */
function buildItems(inputs: Item[], existing: Entry[], routineProg: unknown, cat: Catalogue, now: number): Entry[] | string {
  const pool = new Map<string, Entry[]>()
  for (const e of existing) pool.set(String(e.id), [...(pool.get(String(e.id)) ?? []), e])
  const oldGroups = new Set(existing.map((e) => e.sg).filter((g): g is string => typeof g === 'string'))
  const groups = new Map<string, string>()
  /** A superset's name and rest given in this call, per stored group id: they apply to every member. */
  const groupMeta = new Map<string, { sgName?: string | null; sgRest?: number | null }>()
  const out: Entry[] = []
  for (const [i, x] of inputs.entries()) {
    const where = `exercise ${i + 1} (${x.exerciseId})`
    const cardio = cat.cardio(x.exerciseId)
    const old = pool.get(x.exerciseId)?.shift()
    const mode0: ItemMode = (x.mode ?? (cardio ? 'cardio' : 'reps')) as ItemMode
    const e: Entry = old ? structuredClone(old) : defaultItem(x.exerciseId, mode0, cat.bodyweight(x.exerciseId))
    for (const [tool, key] of ITEM_FIELDS) {
      const value = (x as Record<string, unknown>)[tool]
      if (value === undefined) continue
      const v = typeof value === 'string' ? value.trim() : value
      // The app stores these switches only when on.
      if (v === null || v === '' || (v === false && (key === 'lastToFailure' || key === 'backoff'))) delete e[key]
      else e[key] = v
    }
    if (x.superset === null) delete e.sg
    else if (x.superset) {
      if (!groups.has(x.superset)) {
        const used = new Set(groups.values())
        let id = oldGroups.has(x.superset) && !used.has(x.superset) ? x.superset : newId('sg', now)
        while (used.has(id)) id = newId('sg', now + used.size)
        groups.set(x.superset, id)
      }
      e.sg = groups.get(x.superset)
    }
    if (typeof e.sg === 'string' && (x.supersetName !== undefined || x.supersetRestSec !== undefined)) {
      const meta = groupMeta.get(e.sg) ?? {}
      if (x.supersetName !== undefined) meta.sgName = x.supersetName?.trim() || null
      if (x.supersetRestSec !== undefined) meta.sgRest = x.supersetRestSec || null
      groupMeta.set(e.sg, meta)
    }
    // An exercise this call neither adds nor changes is kept as it is, odd old data included: it must not block other edits.
    const touched = !old || x.superset !== undefined || ITEM_FIELDS.some(([tool]) => (x as Record<string, unknown>)[tool] !== undefined)
    if (!touched) {
      out.push(e)
      continue
    }
    const mode: ItemMode = e.mode === 'time' ? 'time' : e.mode === 'cardio' || (e.mode === undefined && cardio) ? 'cardio' : 'reps'
    if (cardio && mode !== 'cardio') return `${where} is a cardio exercise; it is planned in minutes and speed (mode cardio)`
    if (!cardio && mode === 'cardio') return `${where} is not a cardio exercise; use mode reps or time`
    const problem = checkNewFields(e, x, mode, where, cat)
    if (problem) return problem
    if (mode === 'reps') {
      if (!(typeof e.reps === 'number' && e.reps >= 1)) return `${where} needs reps`
      if (e.side === true && e.reps % 2 !== 0) return `${where} is per side: reps are the total of both sides and must be even (e.g. ${e.reps + 1})`
      if (typeof e.repsMin === 'number' && e.repsMin >= e.reps) return `${where}: repsMin (${e.repsMin}) must be below reps (${e.reps}), the top of the range`
      if (typeof e.repsMax === 'number' && e.repsMax < e.reps) return `${where}: repsMax (${e.repsMax}) is where a set is added and must not be below reps (${e.reps})`
    }
    if (mode === 'time' && !(typeof e.sec === 'number')) return `${where} is timed and needs sec`
    if (mode === 'cardio' && !(typeof e.min === 'number')) return `${where} is cardio and needs min`
    const policy = String(e.prog ?? routineProg ?? (mode === 'reps' ? 'linear' : 'off'))
    if (e.prog !== undefined && !POLICIES_FOR[mode].includes(String(e.prog))) {
      return `${where}: progression "${String(e.prog)}" does not fit a ${mode} exercise (${POLICIES_FOR[mode].join(', ')})`
    }
    // The app gives a double- or triple-progression range its bottom (and triple its most sets) when the plan is set up; only then, not on every edit.
    const rangeAsked = !old || (x.reps !== undefined && x.reps !== old.reps) || (x.progression !== undefined && x.progression !== old.prog) || x.repsMin !== undefined
    const ranged = mode === 'reps' && (policy === 'double' || policy === 'triple') && !Array.isArray(e.pyramid)
    if (ranged && typeof e.repsMin !== 'number' && rangeAsked) e.repsMin = Math.max(1, Number(e.reps) - 2)
    if (ranged && policy === 'triple' && typeof e.setsMax !== 'number' && rangeAsked) {
      const most = Math.min(MAX_PLANNED_SETS, Number(e.sets) + 2)
      if (most > Number(e.sets)) e.setsMax = most
    }
    out.push(e)
  }
  cleanupSupersets(out, groupMeta)
  return out
}

/** The 1.4.0 item fields, checked and normalised as the app's editor does. Returns why not, or nothing. */
function checkNewFields(e: Entry, x: Item, mode: ItemMode, where: string, cat: Catalogue): string | undefined {
  const pyramid = Array.isArray(e.pyramid) && e.pyramid.length > 0
  if (pyramid) {
    if (mode !== 'reps') return `${where}: a pyramid is for exercises done in reps`
    const p = normalizePyramid(e.pyramid as (number | 'max')[], e.side === true)
    e.pyramid = p
    e.sets = p.length
    e.reps = p.find((v): v is number => typeof v === 'number') ?? 10
    const rest = alignedOrNone(e.pyramidRest as number[] | undefined, p.length, Math.round)
    if (rest) e.pyramidRest = rest
    else delete e.pyramidRest
    const weight = e.bodyweight === true ? undefined : alignedOrNone(e.pyramidWeight as number[] | undefined, p.length, (v) => Math.round(v * 100) / 100)
    if (weight) e.pyramidWeight = weight
    else delete e.pyramidWeight
    for (const [tool, key] of [['intensifier', 'intensifier'], ['backoff', 'backoff'], ['lastSetToFailure', 'lastToFailure'], ['setsMax', 'setsMax']] as const) {
      if ((x as Record<string, unknown>)[tool]) return `${where}: a pyramid plans every set itself, so it takes no ${tool}`
      delete e[key]
    }
  } else {
    delete e.pyramid
    delete e.pyramidRest
    delete e.pyramidWeight
  }
  if (e.setsMax !== undefined) {
    if (mode !== 'reps') return `${where}: setsMax is for exercises done in reps (triple progression)`
    if (!(Number(e.setsMax) > Number(e.sets))) {
      if (x.setsMax != null) return `${where}: setsMax (${String(e.setsMax)}) is the most sets triple progression climbs to and must be above sets (${String(e.sets)})`
      delete e.setsMax
    }
  }
  if (e.lastToFailure === true && mode === 'cardio') return `${where}: a cardio exercise has no last set to failure`
  if (e.backoff === true) {
    const why = mode !== 'reps' ? 'it is not done in reps' : e.bodyweight === true ? 'it is a body-weight exercise' : e.assisted === true || (e.assisted !== false && cat.assisted(String(e.id))) ? 'it is an assistance machine' : isRecord(e.intensifier) && e.intensifier.type === 'restpause' ? 'it is planned as rest-pause' : undefined
    if (why) return `${where}: back-off sets do not fit, ${why}`
  }
  if (e.dbLoad !== undefined) {
    if (!BELL_EQUIPMENT.has(cat.equipment(String(e.id)) ?? '') || e.bodyweight === true) return `${where}: dumbbellLoad (what the weight means) is for dumbbell and kettlebell exercises`
    // Stored only when it differs from the exercise's own default, as the app does.
    if (e.dbLoad === cat.dbLoad(String(e.id))) delete e.dbLoad
  }
  return undefined
}

const routineLine = (r: Entry) => ({ id: r.id, name: r.name, exercises: listOf(r, 'ex').length })
const withoutStamp = (r: Entry) => JSON.stringify({ ...r, _ts: undefined })

export const writeRoutine = defineTool({
  name: 'write_routine',
  description:
    'Create a routine (no id) or change one (id). `exercises`, when given, is the new list in that order, in the format read_routine returns: for an exercise the routine already has, every field left out keeps its value and null removes it; a new exercise starts from the app\'s defaults (3 × 10, timed 3 × 45 s, cardio 1 × 20 min at 8 km/h). Fields openGym keeps that leap does not know are kept. Weights in the profile unit. `progression` is the routine default: off, linear (default), greyskull, double, triple (reps climb to the top of the range, then a set is added up to setsMax, then the weight goes up). Also per exercise: last set to failure, back-off sets, pyramids (reps, rest and weight per set), what a dumbbell weight means, and a superset\'s name and rest.',
  input: {
    id: entryId.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    emoji: z.string().max(40).optional().describe("The app's icon key, e.g. figureStrength; unknown keys show the default icon; empty removes it"),
    progression: z.enum(ROUTINE_POLICIES).optional(),
    excludeFromProgression: z.boolean().optional().describe('Sessions of this routine (e.g. a deload) do not count for progression'),
    exercises: z.array(item).max(40).optional(),
  },
  async handler(args, ctx) {
    if (!args.id && !args.name) return invalid('a new routine needs a name')
    if (args.id && [args.name, args.emoji, args.progression, args.excludeFromProgression, args.exercises].every((v) => v === undefined)) {
      return invalid('nothing to change')
    }
    const problems = supersetProblems(args.exercises ?? [])
    if (problems.length) return invalid(problems.join('; '))
    const makeCatalogue = await catalogue(ctx)
    return change(
      ctx,
      'save the routine',
      (draft, { now }) => {
        const cat = makeCatalogue(draft)
        const asked = args.exercises?.map((x) => ({ ...x, exerciseId: cat.canonical(x.exerciseId) }))
        const unknown = cat.unknown((asked ?? []).map((x) => x.exerciseId))
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
        const before = withoutStamp(routine)
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
        if (asked) {
          const items = buildItems(asked, listOf(routine, 'ex'), routine.prog, cat, now)
          if (typeof items === 'string') return refuse(items)
          routine.ex = items
        }
        // Stamped only when it changed: a fresh stamp on an unchanged routine would outrank an unsynced edit elsewhere.
        if (!args.id || withoutStamp(routine) !== before) routine._ts = now
        return apply({ routine: structuredClone(routine), created: !args.id })
      },
      (r) => ({ ...(r.created ? { created: true } : {}), routine: routineLine(r.routine) }),
      {
        verify: (s, r) => {
          const stored = listOf(s, 'routines').find((x) => x.id === r.routine.id)
          if (!stored) return [`routine ${String(r.routine.id)}`]
          return withoutStamps(stored) === withoutStamps(r.routine) ? [] : [`routine ${String(r.routine.id)} differs from what was written`]
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
  description: `Delete a routine, as the app does: it is also taken off every weekday and every date it was planned on. Logged workouts keep their history. Like the app, it stays listed in the rotation and the running round, where it is skipped; deleting the last routine of a round leaves the round unusable (the app then offers to discard it). ${RESURRECTION_NOTE}`,
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
        const inRound = isRecord(draft.queue) && Array.isArray(draft.queue.ids) && draft.queue.ids.includes(args.id)
        return apply({ name: routine.name, weekdays, dates: dates.sort(), inRound, roundGone: inRound && queueUnusable(draft) })
      },
      (r) => ({
        deleted: { id: args.id, name: r.name },
        ...(r.weekdays.length ? { removedFromWeekdays: r.weekdays } : {}),
        ...(r.dates.length ? { removedFromDates: r.dates } : {}),
        ...(r.inRound ? { inRound: r.roundGone ? 'it was the last routine of the running round, which is now unusable; start a new one with write_rotation, or clear it with write_schedule_mode "week" (or write_session_queue null for a planner\'s queue)' : 'skipped in the running round from now on' } : {}),
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
    `Set the routines planned on weekdays, e.g. { "Monday": [pushId], "Friday": [pushId, legsId] }. Several routines on one day make a combined session; an empty list makes the day a rest day. Weekdays not given are left as they are. Date overrides (write_day_plan) still win on their dates. In rotation mode the weekdays stay in force on top of the loop (routines that are in the loop are not repeated on the loop's day), and going back to the fixed week uses them as they are. ${LAST_CHANGE_NOTE}`,
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
    `Override the plan for one date: a routine id, "rest", or null to go back to the weekly plan. A date takes one routine (combined days come from the weekly plan). While a rotation round runs: a routine of the round pins that session to the date (it is that day's session and is skipped on other days; once done, the pin is fulfilled), another routine replaces the round's session that day, and "rest" pauses the round that day. ${LAST_CHANGE_NOTE}`,
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
        return apply({ previous, name: args.plan && args.plan !== 'rest' ? routineName(draft, args.plan) : undefined, pin: args.plan !== null && queueOf(draft)?.ids.includes(args.plan) === true })
      },
      (r) => ({
        date: args.date,
        plan: args.plan === null ? 'weekly plan' : args.plan === 'rest' ? 'rest' : { id: args.plan, name: r.name },
        ...(r.pin ? { kind: 'pin' } : {}),
        ...(r.pin && args.date < today(ctx.now()) ? { warning: 'a pin on a past date has no effect: the session floats again' } : {}),
        previous: r.previous,
      }),
      { verify: (s) => ((mapOf(s, 'dayPlan')[args.date] ?? null) === args.plan ? [] : [`dayPlan ${args.date}`]) },
    )
  },
})

export const routineWriteTools = [writeRoutine, writeCopyRoutine, writeWeekPlan, writeDayPlan]
export const routineDeleteTools = [deleteRoutine]
