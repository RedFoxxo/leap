import { z } from 'zod'
import { customExercises } from '../../catalog/exercises.js'
import { today } from '../../domain/dates.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, LIST_KEYS, listOf, MAP_KEYS, mapOf, unitOf, writableList, writableMap, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { exerciseId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, RESURRECTION_NOTE } from '../write.js'

const weight = z.number().positive().max(1000)
const sameNumber = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

/** Built-in ids known from the catalogue; a custom id must be in the document being changed. */
async function exerciseCheck(ctx: ToolContext): Promise<(state: State, id: string) => string | undefined> {
  const builtin = await ctx.builtinExercises()
  return (state, id) => {
    if (builtin.exercises.has(id) || customExercises(state).some((c) => c.id === id)) return undefined
    if (builtin.error && !id.startsWith('c')) return undefined
    return `no exercise with id "${id}"; find ids with read_exercises`
  }
}

export const writeBodyweight = defineTool({
  name: 'write_bodyweight',
  description:
    'Log body weight for a day (default today), in the profile unit. openGym keeps one weigh-in per day, so this replaces that day\'s entry if there is one.',
  input: { weight, date: isoDate.optional() },
  async handler(args, ctx) {
    const date = args.date ?? today()
    return change(
      ctx,
      'save the weigh-in',
      (draft, { now }) => {
        const list = writableList(draft, 'bodyweight')
        const previous = listOf(draft, 'bodyweight').find((e) => e.d === date)
        const kept = list.filter((e) => !(isRecord(e) && e.d === date))
        kept.push({ ...(previous ?? {}), d: date, w: args.weight, t: now })
        kept.sort((a, b) => String((a as { d?: unknown }).d).localeCompare(String((b as { d?: unknown }).d)))
        draft.bodyweight = kept
        return apply({ date, unit: unitOf(draft), replaced: previous && typeof previous.w === 'number' ? previous.w : undefined })
      },
      (r) => ({ date: r.date, weight: args.weight, unit: r.unit, ...(r.replaced !== undefined ? { replaced: r.replaced } : {}) }),
      { verify: (s) => (listOf(s, 'bodyweight').some((e) => e.d === date && sameNumber(e.w, args.weight)) ? [] : [`bodyweight ${date}`]) },
    )
  },
})

export const deleteBodyweight = defineTool({
  name: 'delete_bodyweight',
  description: `Delete the weigh-in of a day. ${RESURRECTION_NOTE}`,
  input: { date: isoDate },
  async handler(args, ctx) {
    return change(
      ctx,
      'delete the weigh-in',
      (draft) => {
        const entry = listOf(draft, 'bodyweight').find((e) => e.d === args.date)
        if (!entry) return refuse(`there is no weigh-in on ${args.date}`)
        draft.bodyweight = writableList(draft, 'bodyweight').filter((e) => !(isRecord(e) && e.d === args.date))
        return apply({ weight: entry.w })
      },
      (r) => ({ deleted: { date: args.date, weight: r.weight }, note: RESURRECTION_NOTE }),
      { verify: (s) => (listOf(s, 'bodyweight').some((e) => e.d === args.date) ? [`bodyweight ${args.date} is still there`] : []) },
    )
  },
})

export const writeGoalWeight = defineTool({
  name: 'write_goal_weight',
  description: 'Set the goal body weight (targetW) in the profile unit, or clear it with null.',
  input: { weight: weight.nullable() },
  async handler(args, ctx) {
    return change(
      ctx,
      'save the goal weight',
      (draft) => {
        const previous = draft.targetW
        draft.targetW = args.weight
        return apply({ previous, unit: unitOf(draft) })
      },
      (r) => ({ goal: args.weight, unit: r.unit, ...(typeof r.previous === 'number' ? { previous: r.previous } : {}) }),
      { verify: (s) => (s.targetW === args.weight || sameNumber(s.targetW, args.weight ?? NaN) ? [] : ['targetW']) },
    )
  },
})

const flag = z.boolean().optional()

/** The settings openGym reads, with the values it accepts. Unknown settings go through write_document. */
const SETTINGS = {
  lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional().describe('UI language, e.g. en, de, de-CH, pl, pt-BR'),
  theme: z.string().min(1).max(30).optional(),
  accent: z.string().min(1).max(30).optional(),
  restSec: z.number().int().min(0).max(3600).optional().describe('Default rest between sets, seconds'),
  restPauseSec: z.number().int().min(0).max(600).optional().describe('Rest between rest-pause bursts, seconds'),
  effort: z.enum(['none', 'rir', 'rpe']).optional().describe('Per-set effort scale'),
  weekStart: z.union([z.literal(0), z.literal(1)]).optional().describe('First weekday: 1 Monday, 0 Sunday'),
  startFrom: z.enum(['plan', 'last']).optional().describe("Planned sessions open at the routine's reps (plan) or the last session's (last)"),
  logRef: z.enum(['last', 'best']).optional(),
  workoutView: z.enum(['cards', 'list', 'compact']).optional(),
  wdec: z.union([z.literal(1), z.literal(2)]).optional().describe('Decimals shown on weights'),
  speedUnit: z.enum(['kmh', 'mph']).nullable().optional().describe('Cardio speed display; null follows the weight unit'),
  heatmapMetric: z.string().min(1).max(20).optional(),
  sound: flag,
  soundOnSilent: flag,
  timerFlash: flag,
  timedSetOvertime: flag,
  keepAwake: flag,
  weighIn: flag.describe('Ask for body weight before a workout'),
  showWeightCard: flag,
  checkIn: flag,
  autoBackup: flag,
  reminder: z
    .object({
      on: z.boolean().optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('HH:MM'),
      tz: z.string().min(1).max(64).nullable().optional().describe('IANA time zone, e.g. Europe/Warsaw'),
    })
    .strict()
    .optional()
    .describe('Daily "workout planned today" push; merged into the current reminder'),
}

export const writeSettings = defineTool({
  name: 'write_settings',
  description:
    'Change profile settings; only the ones given change. The weight unit is not changed here: switching it converts every stored weight, which the app does.',
  input: SETTINGS,
  async handler(args, ctx) {
    const given = Object.entries(args).filter(([, v]) => v !== undefined)
    if (!given.length) return invalid('no setting given')
    return change(
      ctx,
      'save settings',
      (draft) => {
        const changed: Record<string, { from: unknown; to: unknown }> = {}
        for (const [key, value] of given) {
          const from = draft[key] ?? null
          if (key === 'reminder') {
            const current = isRecord(draft.reminder) ? draft.reminder : { on: false, time: '08:00', tz: null }
            draft.reminder = { ...current, ...(value as object) }
          } else draft[key] = value
          // A profile that never picked a language follows an automatic one (`langAuto`) and ignores `lang`; the app's own choice turns it off.
          if (key === 'lang') draft.langAuto = false
          changed[key] = { from, to: draft[key] }
        }
        return apply(changed)
      },
      (changed) => ({ changed }),
      {
        verify: (s) =>
          given
            .filter(([k, v]) => (k === 'reminder' ? Object.entries(v as object).some(([rk, rv]) => mapOf(s, 'reminder')[rk] !== rv) : s[k] !== v))
            .map(([k]) => k),
      },
    )
  },
})

export const writeExerciseNote = defineTool({
  name: 'write_exercise_note',
  description: 'Set the standing note of an exercise (shown every time it is done, e.g. "seat 4, pin 7"); an empty note removes it. At most 500 characters.',
  input: { exerciseId, note: z.string().max(500) },
  async handler(args, ctx) {
    const check = await exerciseCheck(ctx)
    const note = args.note.trim()
    return change(
      ctx,
      'save the note',
      (draft) => {
        const problem = check(draft, args.exerciseId)
        if (problem) return refuse(problem)
        const notes = writableMap(draft, 'exNotes')
        const previous = notes[args.exerciseId]
        if (note) notes[args.exerciseId] = note
        else delete notes[args.exerciseId]
        return apply({ previous })
      },
      (r) => ({ exerciseId: args.exerciseId, note: note || null, ...(typeof r.previous === 'string' ? { previous: r.previous } : {}) }),
      { verify: (s) => ((mapOf(s, 'exNotes')[args.exerciseId] ?? '') === note ? [] : ['exNotes']) },
    )
  },
})

export const writeFavourite = defineTool({
  name: 'write_favourite',
  description: 'Mark an exercise as a favourite (sorted to the top of the exercise picker) or unmark it.',
  input: { exerciseId, favourite: z.boolean() },
  async handler(args, ctx) {
    const check = await exerciseCheck(ctx)
    return change(
      ctx,
      'save the favourite',
      (draft) => {
        if (args.favourite) {
          const problem = check(draft, args.exerciseId)
          if (problem) return refuse(problem)
        }
        const list = writableList(draft, 'favEx').filter((x) => x !== args.exerciseId)
        if (args.favourite) list.push(args.exerciseId)
        draft.favEx = list
        return apply(null)
      },
      () => ({ exerciseId: args.exerciseId, favourite: args.favourite }),
      { verify: (s) => ((Array.isArray(s.favEx) && s.favEx.includes(args.exerciseId)) === args.favourite ? [] : ['favEx']) },
    )
  },
})

/** Keys with dedicated tools or owned by openGym: never set through the raw escape hatch. */
const RAW_PROTECTED = new Set([...LIST_KEYS, ...MAP_KEYS, 'unit', 'unitSet', 'resetAt', 'resetIds', 'coach', 'active', 'targetW', '_ts', '_rev'])

export const writeDocument = defineTool({
  name: 'write_document',
  description:
    'Escape hatch: set one top-level value of the profile document that no dedicated tool covers (a setting from a newer openGym version), or remove it with null. Refused for training data, the unit and openGym\'s own bookkeeping. Check the current value with read_document first.',
  input: { key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), value: z.unknown() },
  async handler(args, ctx) {
    if (RAW_PROTECTED.has(args.key)) return invalid(`"${args.key}" has a dedicated tool or belongs to openGym; it cannot be set raw`)
    if (args.value === undefined) return invalid('value is required (null removes the key)')
    return change(
      ctx,
      'save',
      (draft) => {
        const previous = draft[args.key]
        if (args.value === null) delete draft[args.key]
        else draft[args.key] = args.value
        return apply({ previous })
      },
      (r) => ({ key: args.key, value: args.value, previous: r.previous ?? null }),
      { verify: (s) => (JSON.stringify(s[args.key] ?? null) === JSON.stringify(args.value) ? [] : [args.key]) },
    )
  },
})

export const settingsWriteTools = [writeBodyweight, writeGoalWeight, writeSettings, writeExerciseNote, writeFavourite, writeDocument]
export const settingsDeleteTools = [deleteBodyweight]
