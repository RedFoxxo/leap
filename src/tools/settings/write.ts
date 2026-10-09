import { z } from 'zod'
import { builtinIdShape, ExerciseIndex } from '../../catalog/exercises.js'
import { today } from '../../domain/dates.js'
import { BELL_EQUIPMENT, exerciseDbLoad, ownedDumbbells } from '../../domain/dumbbells.js'
import { FORMULA_NAMES } from '../../domain/stats.js'
import { STAMPED_MAPS, SYNC_KEYS, withoutStamps } from '../../state/stamps.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, mapOf, unitOf, writableList, writableMap, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { invalid } from '../respond.js'
import { exerciseId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, LAST_CHANGE_NOTE, RESURRECTION_NOTE } from '../write.js'

const weight = z.number().positive().max(1000)
const sameNumber = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

/**
 * The id an exercise is stored under, or why there is none: built-in ids come from the catalogue
 * (an alias id means the exercise it draws); a custom id must be in the document being changed.
 */
async function exerciseCheck(ctx: ToolContext): Promise<(state: State, id: string) => { id: string } | { problem: string }> {
  const builtin = await ctx.builtinExercises()
  return (state, id) => {
    const index = new ExerciseIndex(builtin, state)
    if (index.get(id)) return { id: index.canonical(id) }
    if (builtin.error && builtinIdShape(id)) return { id }
    return { problem: `no exercise with id "${id}"; find ids with read_exercises` }
  }
}

export const writeBodyweight = defineTool({
  name: 'write_bodyweight',
  description:
    'Log body weight for a day (default today), in the profile unit. openGym keeps one weigh-in per day, so this replaces that day\'s entry if there is one.',
  input: { weight, date: isoDate.optional() },
  async handler(args, ctx) {
    const date = args.date ?? today(ctx.now())
    if (date > today(ctx.now())) return invalid(`${date} is in the future; a weigh-in is logged for a day that happened`)
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
  description: `Set the goal body weight (targetW) in the profile unit, or clear it with null. ${LAST_CHANGE_NOTE}`,
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

/** The languages the app has (Settings → Language). */
const LANGS = ['en', 'de', 'de-CH', 'es', 'fr', 'it', 'pt', 'pt-BR', 'pl', 'tr', 'ru', 'uk', 'zh', 'zh-TW', 'ko', 'hi', 'bn', 'th', 'hu', 'ar'] as const

/** Whether the server can read a time zone: it skips a reminder whose zone it cannot. */
function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The settings openGym reads, with the values it accepts. Unknown settings go through write_document. */
const SETTINGS = {
  lang: z.enum(LANGS).optional().describe('UI language'),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  accent: z
    .union([z.enum(['lime', 'sky', 'orange', 'violet', 'pink', 'red', 'teal', 'gold']), z.string().regex(/^#[0-9a-fA-F]{6}$/)])
    .optional()
    .describe('A preset (lime green, sky blue, orange, violet purple, pink, red, teal, gold yellow) or an own colour as #rrggbb; the app nudges an own colour until text on it stays readable'),
  restSec: z.number().int().min(0).max(3600).optional().describe('Default rest between sets, seconds'),
  restPauseSec: z.number().int().min(0).max(600).optional().describe('Rest between rest-pause bursts, seconds'),
  effort: z.enum(['none', 'rir', 'rpe']).optional().describe('Per-set effort scale'),
  weekStart: z.union([z.literal(0), z.literal(1)]).optional().describe('First weekday: 1 Monday, 0 Sunday'),
  startFrom: z.enum(['plan', 'last']).optional().describe("Planned sessions open at the routine's reps (plan) or the last session's (last)"),
  logRef: z.enum(['last', 'best']).optional(),
  workoutView: z.enum(['cards', 'list', 'compact', 'focus']).optional().describe('cards, list, compact, or focus (one exercise at a time, nothing else on screen)'),
  collapseCompleted: flag.describe('List and compact views fold a finished exercise into one line'),
  exerciseView: z.enum(['list', 'cards']).optional().describe('Exercise library and picker layout'),
  oneRmFormula: z.enum(FORMULA_NAMES).optional().describe('Formula for estimated 1RM; weighted blends all seven and counts reps in reserve'),
  exFigure: z.enum(['male', 'female']).optional().describe('Which figure exercise drawings show'),
  body: z.enum(['male', 'female']).optional().describe('Body map figure'),
  restSound: z.enum(['chime', 'classic', 'bell', 'beep', 'whistle', 'soft']).optional().describe('Sound at the end of a rest'),
  gifSize: z.enum(['full', 'mini', 'off']).optional().describe('Size of exercise animations'),
  vibrate: flag,
  vibrateOnSilent: flag.describe('Android: buzz at the end of a rest even when the phone is on silent'),
  connStatus: flag.describe('Show the connection line at the top'),
  connLocal: flag.describe('Show the "on this phone only" line'),
  shareMap: flag.describe('Put the muscle map on a workout shared as an image'),
  wdec: z.union([z.literal(1), z.literal(2)]).optional().describe('Decimals shown on weights'),
  speedUnit: z.enum(['kmh', 'mph']).nullable().optional().describe('Cardio speed display; null follows the weight unit'),
  heatmapMetric: z.enum(['time', 'vol']).optional(),
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
      nudge: z.boolean().optional().describe('Missed-workout nudge: one push between 20:00 and 21:30 on a planned day with nothing logged; quiet after 3 missed days in a row, and never on a day with a note (write_day_note). Needs the reminder on'),
      tone: z.enum(['friendly', 'guilt', 'drill']).optional().describe('Tone of the nudge: friendly, guilt (guilt trip), drill (drill sergeant)'),
    })
    .strict()
    .optional()
    .describe("Daily \"workout planned today\" push; merged into the current reminder. Without a time zone it gets this computer's. It needs a device with push notifications on"),
}

export const writeSettings = defineTool({
  name: 'write_settings',
  description:
    `Change profile settings; only the ones given change. The weight unit is not changed here: switching it converts every stored weight, which the app does. ${LAST_CHANGE_NOTE}`,
  input: SETTINGS,
  async handler(args, ctx) {
    const given = Object.entries(args).filter(([, v]) => v !== undefined)
    if (!given.length) return invalid('no setting given')
    if (typeof args.reminder?.tz === 'string' && !validTimeZone(args.reminder.tz)) return invalid(`"${args.reminder.tz}" is not a time zone (e.g. Europe/Warsaw)`)
    return change(
      ctx,
      'save settings',
      (draft) => {
        const changed: Record<string, { from: unknown; to: unknown }> = {}
        for (const [key, value] of given) {
          const from = draft[key] ?? null
          if (key === 'reminder') {
            const current = isRecord(draft.reminder) ? draft.reminder : { on: false, time: '08:00', tz: null }
            const next: Record<string, unknown> = { ...current, ...(value as object) }
            // The app sets the device's zone with every reminder change; without one the server fires it on UTC.
            if (next.tz == null && (next.on === true || (value as { time?: unknown }).time !== undefined || (value as { nudge?: unknown }).nudge === true)) next.tz = localTimeZone()
            draft.reminder = next
          } else if (key === 'accent' && typeof value === 'string' && value.startsWith('#')) {
            // An own colour is two settings the app writes together (openGym lib/accent.js, v1.4.0).
            draft.accent = 'custom'
            draft.accentCustom = value.toLowerCase()
          } else draft[key] = value
          // The app keeps the legacy classic-chime switch in step with the rest sound.
          if (key === 'restSound') draft.classicChime = value === 'classic'
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
            .filter(([k, v]) =>
              k === 'reminder'
                ? Object.entries(v as object).some(([rk, rv]) => mapOf(s, 'reminder')[rk] !== rv)
                : k === 'accent' && typeof v === 'string' && v.startsWith('#')
                  ? s.accent !== 'custom' || s.accentCustom !== v.toLowerCase()
                  : s[k] !== v,
            )
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
        const found = check(draft, args.exerciseId)
        if ('problem' in found) return refuse(found.problem)
        const notes = writableMap(draft, 'exNotes')
        const previous = notes[found.id]
        if (note) notes[found.id] = note
        else delete notes[found.id]
        return apply({ id: found.id, previous })
      },
      (r) => ({ exerciseId: r.id, note: note || null, ...(typeof r.previous === 'string' ? { previous: r.previous } : {}) }),
      { verify: (s, r) => ((mapOf(s, 'exNotes')[r.id] ?? '') === note ? [] : ['exNotes']) },
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
        const found = check(draft, args.exerciseId)
        if (args.favourite && 'problem' in found) return refuse(found.problem)
        const id = 'id' in found ? found.id : args.exerciseId
        // Unstarring takes the id as given and the exercise it draws, whichever is stored.
        const list = writableList(draft, 'favEx').filter((x) => x !== id && x !== args.exerciseId)
        if (args.favourite) list.push(id)
        draft.favEx = list
        return apply({ id })
      },
      (r) => ({ exerciseId: r.id, favourite: args.favourite }),
      { verify: (s, r) => ((Array.isArray(s.favEx) && s.favEx.includes(r.id)) === args.favourite ? [] : ['favEx']) },
    )
  },
})

export const writeDumbbellRack = defineTool({
  name: 'write_dumbbell_rack',
  description:
    "The dumbbells the user owns, single bells in the profile unit (e.g. [2, 4, 6, 8, 10, 12.5]); an empty list removes the rack. The app then moves progression, deloads, warm-ups, drop sets and the +/− buttons of dumbbell exercises onto weights that exist. Kept per unit; nothing logged changes.",
  input: { weights: z.array(z.number().positive().max(1000)).max(100) },
  async handler(args, ctx) {
    const weights = [...new Set(args.weights.map((w) => Math.round(w * 1000) / 1000))].sort((a, b) => a - b)
    return change(
      ctx,
      'save the dumbbell rack',
      (draft, { now }) => {
        const unit = unitOf(draft)
        const previous = ownedDumbbells(draft, unit)
        const stored = isRecord(mapOf(draft, 'dumbbells')[unit])
        // A stamped entry per unit; an empty rack is a stamped empty list, never a deleted key. Unchanged, nothing is stamped.
        if (JSON.stringify(previous) !== JSON.stringify(weights) || (!stored && weights.length)) writableMap(draft, 'dumbbells')[unit] = { weights, _ts: now }
        return apply({ unit, previous })
      },
      (r) => ({ unit: r.unit, dumbbells: weights, ...(r.previous.length ? { previous: r.previous } : {}) }),
      { verify: (s, r) => (JSON.stringify(ownedDumbbells(s, r.unit)) === JSON.stringify(weights) ? [] : ['dumbbells']) },
    )
  },
})

export const writeDumbbellLoad = defineTool({
  name: 'write_dumbbell_load',
  description:
    'What a weight means for a dumbbell or kettlebell exercise by default: per dumbbell (each), both together (total), or as entered (as, how it always worked). Volume counts both bells for "each" on two-handed work; records and history compare sessions in the current meaning. Workouts already logged keep the meaning they were logged with; a routine can choose its own (write_routine, dumbbellLoad).',
  input: { exerciseId, mode: z.enum(['as', 'each', 'total']) },
  async handler(args, ctx) {
    const builtin = await ctx.builtinExercises()
    return change(
      ctx,
      'save what the weight means',
      (draft, { now }) => {
        const index = new ExerciseIndex(builtin, draft)
        const e = index.get(args.exerciseId)
        if (!e) return refuse(`no exercise with id "${args.exerciseId}"; find ids with read_exercises`)
        if (!BELL_EQUIPMENT.has(e.equipment ?? '')) return refuse(`${e.name} is not a dumbbell or kettlebell exercise`)
        const id = index.canonical(args.exerciseId)
        const previous = exerciseDbLoad(draft, id)
        // "As entered" is a stamped null, never a deleted key, so it wins over an older choice on another device.
        // Unchanged, nothing is stamped (a fresh stamp would outrank an unsynced change elsewhere).
        if (previous !== args.mode) writableMap(draft, 'dbLoad')[id] = { mode: args.mode === 'as' ? null : args.mode, _ts: now }
        return apply({ id, name: e.name, previous })
      },
      (r) => ({ exerciseId: r.id, name: r.name, weightMeans: args.mode, previous: r.previous }),
      { verify: (s, r) => (exerciseDbLoad(s, r.id) === args.mode ? [] : ['dbLoad']) },
    )
  },
})

/** Keys with dedicated tools or owned by openGym: never set through the raw escape hatch. */
const RAW_PROTECTED = new Set<string>([
  'workouts', 'routines', 'bodyweight', 'customEx', 'week', 'dayPlan', 'exWeights', 'exNotes', 'favEx', 'reminder', 'targetW',
  'unit', 'unitSet', 'resetAt', 'resetIds', 'coach', 'active', ...SYNC_KEYS,
  'queue', 'rotation', 'scheduleMode', 'dayNotes', 'measurements', 'customMeasurements', 'dbLoad', 'dumbbells',
])

/**
 * A stamped map (plates, load kinds, …) written raw: every entry that changed carries the write's
 * stamp, as the app's do; a key cannot be removed, because the merge takes keys from every copy and
 * only a newer stamped entry replaces one.
 */
function stampRaw(key: string, previous: unknown, value: unknown, now: number): string | undefined {
  if (!(STAMPED_MAPS as readonly string[]).includes(key)) return undefined
  if (!isRecord(value)) return `"${key}" is a map whose entries sync one by one; give the whole map (an object), with every entry it has now`
  const before = isRecord(previous) ? previous : {}
  const dropped = Object.keys(before).filter((k) => !(k in value))
  if (dropped.length) return `"${key}" cannot lose entries (${dropped.join(', ')}): another device would bring them back. Write a cleared entry instead`
  for (const [k, v] of Object.entries(value)) {
    if (isRecord(v) && withoutStamps(v) !== withoutStamps(before[k])) v._ts = now
  }
  return undefined
}

export const writeDocument = defineTool({
  name: 'write_document',
  description:
    `Escape hatch: set one top-level value of the profile document that no dedicated tool covers (equipment profiles, plate inventory, bar weights, a setting from a newer openGym version), or remove it with null. Lists and maps keep their type. Refused for training data, values with their own tool, the unit and openGym's own bookkeeping. Check the current value with read_document first. ${LAST_CHANGE_NOTE}`,
  input: { key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), value: z.unknown() },
  async handler(args, ctx) {
    if (RAW_PROTECTED.has(args.key)) return invalid(`"${args.key}" has a dedicated tool or belongs to openGym; it cannot be set raw`)
    if (args.value === undefined) return invalid('value is required (null removes the key)')
    return change(
      ctx,
      'save',
      (draft, { now }) => {
        const previous = draft[args.key]
        const value = structuredClone(args.value)
        const problem = stampRaw(args.key, previous, value, now)
        if (problem) return refuse(problem)
        if (value === null) delete draft[args.key]
        else draft[args.key] = value
        return apply({ previous, value })
      },
      (r) => ({ key: args.key, value: r.value, previous: r.previous ?? null }),
      { verify: (s, r) => (JSON.stringify(s[args.key] ?? null) === JSON.stringify(r.value) ? [] : [args.key]) },
    )
  },
})

export const settingsWriteTools = [writeBodyweight, writeGoalWeight, writeSettings, writeExerciseNote, writeFavourite, writeDumbbellRack, writeDumbbellLoad, writeDocument]
export const settingsDeleteTools = [deleteBodyweight]
