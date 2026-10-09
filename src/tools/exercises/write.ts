import { z } from 'zod'
import { customExercises } from '../../catalog/exercises.js'
import { newId } from '../../state/ids.js'
import { withoutStamps } from '../../state/stamps.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, mapOf, writableList, writableMap, type Entry } from '../../state/types.js'
import { invalid } from '../respond.js'
import { entryId } from '../schema.js'
import { defineTool } from '../types.js'
import { change, RESURRECTION_NOTE } from '../write.js'

/**
 * Body parts and equipment the app offers for custom exercises: the catalogue's words, plus the
 * accessories bench and pull-up bar (openGym `scripts/catalogue/validate.mjs` and
 * `frontend/src/lib/equipment.js`, v1.4.0).
 */
const BODY_PARTS = ['back', 'cardio', 'chest', 'full body', 'lower arms', 'lower legs', 'neck', 'shoulders', 'upper arms', 'upper legs', 'waist'] as const
const EQUIPMENT = [
  'body weight', 'cable', 'leverage machine', 'assisted', 'medicine ball', 'stability ball', 'band', 'barbell', 'rope',
  'dumbbell', 'ez barbell', 'sled machine', 'upper body ergometer', 'kettlebell', 'olympic barbell', 'weighted',
  'bosu ball', 'resistance band', 'roller', 'skierg machine', 'hammer', 'smith machine', 'wheel roller',
  'stationary bike', 'tire', 'trap bar', 'elliptical machine', 'stepmill machine',
  'suspension trainer', 'sandbag', 'landmine', 'weight plate', 'clubbell', 'macebell', 'bench', 'pull-up bar',
] as const
/** The muscles the app's body map knows, head to toe; custom exercises store these names, in this order. */
export const APP_MUSCLES = [
  'trapezius', 'deltoids', 'chest', 'upper-back', 'serratus', 'biceps', 'triceps', 'forearm', 'abs', 'obliques',
  'lower-back', 'gluteal', 'quadriceps', 'hamstring', 'adductors', 'hip-flexors', 'calves', 'tibialis',
] as const

const muscles = z.array(z.enum(APP_MUSCLES)).max(APP_MUSCLES.length)
const inMapOrder = (list: readonly string[]) => APP_MUSCLES.filter((m) => list.includes(m))

/** A link the app accepts: http(s), a plausible host, no credentials; a bare host gets https://. */
export function cleanUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s || s.length > 2048) return null
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9+.-]+:/i.test(s)) return null
    s = `https://${s}`
  }
  if (/\s/.test(/^https?:\/\/([^/?#]*)/i.exec(s)?.[1] ?? '')) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
  const host = u.hostname
  const plausible = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)
  return plausible && u.href.length <= 2048 ? u.href : null
}

export const writeCustomExercise = defineTool({
  name: 'write_custom_exercise',
  description:
    'Create a custom exercise (no id) or change one (id). It then works like any built-in exercise in routines, workouts and stats. Muscles use the app\'s body-map names; `target` is the main one (default the first primary). A cardio exercise logs time and speed. Names must be unique among all exercises.',
  input: {
    id: entryId.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    bodyPart: z.enum(BODY_PARTS).optional(),
    equipment: z.enum(EQUIPMENT).optional(),
    primaryMuscles: muscles.optional(),
    secondaryMuscles: muscles.optional(),
    target: z.enum(APP_MUSCLES).optional(),
    description: z.string().max(1000).optional().describe('Setup, cues; empty removes it'),
    url: z.string().max(2048).nullable().optional().describe('A video or guide link (http/https); null removes it'),
    assisted: z.boolean().nullable().optional().describe('An assistance machine (less weight is better); null follows the default'),
  },
  async handler(args, ctx) {
    if (!args.id && (!args.name || !args.bodyPart || !args.equipment)) return invalid('a new custom exercise needs a name, bodyPart and equipment')
    const { id: _id, ...fields } = args
    if (args.id && Object.values(fields).every((v) => v === undefined)) return invalid('nothing to change')
    const url = typeof args.url === 'string' && args.url.trim() ? cleanUrl(args.url) : null
    if (typeof args.url === 'string' && args.url.trim() && !url) return invalid('url is not a web address')
    const builtin = await ctx.builtinExercises()
    return change(
      ctx,
      'save the custom exercise',
      (draft, { now }) => {
        const list = writableList(draft, 'customEx')
        let c: Entry
        if (args.id) {
          const found = list.find((x): x is Entry => isRecord(x) && x.id === args.id)
          if (!found) return refuse(`no custom exercise with id "${args.id}"; built-in exercises cannot be changed`)
          c = found
        } else {
          c = { id: newId('c', now), custom: true }
          list.push(c)
        }
        const name = args.name ?? String(c.n ?? '')
        const lower = name.toLowerCase()
        // As the app: only a new or changed name is checked, so an imported exercise may keep its own.
        if (!args.id || lower !== String(c.n ?? '').toLowerCase()) {
          const taken = [...builtin.exercises.values()].find((e) => e.name.toLowerCase() === lower) ?? customExercises(draft).find((e) => e.id !== c.id && e.name.toLowerCase() === lower)
          if (taken) return refuse(`"${taken.name}" already exists (${taken.id})`)
        }
        const bodyPart = args.bodyPart ?? String(c.bp ?? '')
        const oldPrimaries = Array.isArray(c.primaries) ? c.primaries.filter((m): m is string => typeof m === 'string') : []
        const oldSecondaries = Array.isArray(c.secondaries) ? c.secondaries.filter((m): m is string => typeof m === 'string') : []
        const primaries = bodyPart === 'cardio' ? ['cardiovascular system'] : inMapOrder(args.primaryMuscles ?? oldPrimaries)
        const secondaries = inMapOrder((args.secondaryMuscles ?? oldSecondaries).filter((m) => !primaries.includes(m)))
        if (args.target && !primaries.includes(args.target)) return refuse(`target "${args.target}" is not one of the primary muscles`)
        const target = args.target ?? (typeof c.tg === 'string' && primaries.includes(c.tg) ? c.tg : (primaries[0] ?? ''))
        c.n = name
        c.bp = bodyPart
        c.eq = args.equipment ?? c.eq
        c.tg = target
        c.primaries = primaries
        c.secondaries = secondaries
        c.sm = secondaries
        c.muscleGroups = [...primaries, ...secondaries]
        if (args.description !== undefined) c.desc = args.description.trim()
        else if (c.desc === undefined) c.desc = ''
        if (args.url !== undefined) {
          if (url) c.url = url
          else delete c.url
        }
        if (args.assisted !== undefined) {
          if (args.assisted === null) delete c.assisted
          else c.assisted = args.assisted
        }
        c.custom = true
        c._ts = now
        return apply({ exercise: structuredClone(c), created: !args.id })
      },
      (r) => ({
        ...(r.created ? { created: true } : {}),
        exercise: { id: r.exercise.id, name: r.exercise.n, bodyPart: r.exercise.bp, equipment: r.exercise.eq, target: r.exercise.tg, primaryMuscles: r.exercise.primaries, secondaryMuscles: r.exercise.secondaries, ...(r.exercise.url ? { url: r.exercise.url } : {}) },
      }),
      {
        verify: (s, r) => {
          const stored = listOf(s, 'customEx').find((x) => x.id === r.exercise.id)
          return stored && withoutStamps(stored) === withoutStamps(r.exercise) ? [] : [`custom exercise ${String(r.exercise.id)}`]
        },
      },
    )
  },
})

/** Superset ids that no longer pair adjacent exercises are dropped, as the app does. */
function cleanupSupersets(items: unknown[]): void {
  items.forEach((e, i) => {
    if (!isRecord(e) || !e.sg) return
    const prev = items[i - 1]
    const next = items[i + 1]
    if (!((isRecord(prev) && prev.sg === e.sg) || (isRecord(next) && next.sg === e.sg))) delete e.sg
  })
}

export const deleteCustomExercise = defineTool({
  name: 'delete_custom_exercise',
  description: `Delete a custom exercise, as the app does: it is taken out of every routine, the favourites and the remembered weights; logged workouts keep their sets, with its name and muscles copied onto them so history still reads. ${RESURRECTION_NOTE}`,
  input: { id: entryId },
  async handler(args, ctx) {
    return change(
      ctx,
      'delete the custom exercise',
      (draft, { now }) => {
        const ex = listOf(draft, 'customEx').find((x) => x.id === args.id)
        if (!ex) return refuse(`no custom exercise with id "${args.id}"`)
        const snapshot: Entry = {}
        for (const k of ['n', 'bp', 'primaries', 'secondaries', 'muscleGroups'] as const) if (ex[k] !== undefined) snapshot[k] = structuredClone(ex[k])
        let workouts = 0
        for (const w of listOf(draft, 'workouts')) {
          let touched = false
          for (const e of listOf(w, 'entries')) {
            if (e.id !== args.id) continue
            touched = true
            e.n = ex.n
            if (!isRecord(e.muscleSnapshot) || !Object.keys(e.muscleSnapshot).length) e.muscleSnapshot = structuredClone(snapshot)
          }
          if (touched) workouts++
        }
        draft.customEx = writableList(draft, 'customEx').filter((x) => !(isRecord(x) && x.id === args.id))
        const routines: string[] = []
        for (const r of listOf(draft, 'routines')) {
          const items = Array.isArray(r.ex) ? r.ex : []
          if (!items.some((x) => isRecord(x) && x.id === args.id)) continue
          r.ex = items.filter((x) => !(isRecord(x) && x.id === args.id))
          cleanupSupersets(r.ex as unknown[])
          r._ts = now
          routines.push(String(r.name ?? r.id))
        }
        if (args.id in mapOf(draft, 'exWeights')) delete writableMap(draft, 'exWeights')[args.id]
        if (Array.isArray(draft.favEx)) draft.favEx = draft.favEx.filter((x) => x !== args.id)
        return apply({ name: ex.n, routines, workouts })
      },
      (r) => ({
        deleted: { id: args.id, name: r.name },
        ...(r.routines.length ? { removedFromRoutines: r.routines } : {}),
        ...(r.workouts ? { workoutsKeepingIt: r.workouts } : {}),
        note: RESURRECTION_NOTE,
      }),
      { verify: (s) => (listOf(s, 'customEx').some((x) => x.id === args.id) ? [`custom exercise ${args.id} is still there`] : []) },
    )
  },
})

export const exerciseWriteTools = [writeCustomExercise]
export const exerciseDeleteTools = [deleteCustomExercise]
