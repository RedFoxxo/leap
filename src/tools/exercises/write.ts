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
export const BODY_PARTS = ['back', 'cardio', 'chest', 'full body', 'lower arms', 'lower legs', 'neck', 'shoulders', 'upper arms', 'upper legs', 'waist'] as const
export const EQUIPMENT = [
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

/*
 * How the app reads an exercise's muscles when it opens one for editing, ported from openGym
 * `frontend/src/lib/muscles.js` (inMuscleOrder, ALIAS, hasExplicitMuscleMetadata, muscleGroupsOf)
 * and `frontend/src/sheets.jsx` CustomExForm, v1.4.0 (28b7e4dc). A custom exercise stored without
 * `primaries` (an import, an older app) is seeded from its target and secondary muscles.
 */

/** In the body map's order; names it does not know keep their order at the end, as in the app. */
const inMuscleOrder = (list: readonly string[]) => {
  const at = (m: string) => {
    const i = (APP_MUSCLES as readonly string[]).indexOf(m)
    return i < 0 ? APP_MUSCLES.length : i
  }
  return [...list].sort((a, b) => at(a) - at(b))
}

/** Every spelling of a muscle in the dataset, onto the body map's names; null cannot be drawn. */
const MUSCLE_ALIAS: Record<string, string | null> = {
  abs: 'abs', pectorals: 'chest', biceps: 'biceps', glutes: 'gluteal', delts: 'deltoids',
  triceps: 'triceps', 'upper back': 'upper-back', lats: 'upper-back', calves: 'calves',
  quads: 'quadriceps', forearms: 'forearm', hamstrings: 'hamstring', spine: 'lower-back',
  traps: 'trapezius', adductors: 'adductors', 'serratus anterior': 'serratus',
  abductors: 'gluteal', 'levator scapulae': 'trapezius', 'cardiovascular system': 'cardiovascular system',
  shoulders: 'deltoids', deltoids: 'deltoids', 'rear deltoids': 'deltoids',
  'rotator cuff': 'deltoids', quadriceps: 'quadriceps', core: 'abs', abdominals: 'abs',
  'lower abs': 'abs', chest: 'chest', 'upper chest': 'chest', 'hip flexors': 'hip-flexors',
  obliques: 'obliques', 'lower back': 'lower-back', rhomboids: 'upper-back',
  trapezius: 'trapezius', back: 'upper-back', 'latissimus dorsi': 'upper-back',
  brachialis: 'biceps', soleus: 'calves', shins: 'tibialis', wrists: 'forearm',
  'wrist flexors': 'forearm', 'wrist extensors': 'forearm', 'grip muscles': 'forearm',
  groin: 'adductors', 'inner thighs': 'adductors',
  ankles: null, feet: null, hands: null, 'ankle stabilizers': null, sternocleidomastoid: null,
}

/** The muscles a body part stands for when nothing else is known, in the app's order. */
const BY_BODY_PART: Record<string, string[]> = {
  chest: ['chest'], back: ['upper-back', 'lower-back'], shoulders: ['deltoids'], 'upper arms': ['biceps', 'triceps'],
  'lower arms': ['forearm'], waist: ['abs', 'obliques'], 'upper legs': ['quadriceps', 'hamstring', 'gluteal'],
  'lower legs': ['calves', 'tibialis'], neck: ['trapezius'], 'full body': ['chest', 'upper-back', 'gluteal', 'quadriceps', 'hamstring', 'abs'], cardio: [],
}

const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])

function canonicalMuscle(v: unknown): string | null {
  const name = String(v || '').toLowerCase().trim()
  if ((APP_MUSCLES as readonly string[]).includes(name)) return name
  return Object.hasOwn(MUSCLE_ALIAS, name) ? MUSCLE_ALIAS[name]! : null
}

const canonicalUnique = (values: unknown[]) => [...new Set(values.map(canonicalMuscle).filter((m): m is string => m !== null))]

function firstPresent(ex: Entry, keys: string[]): unknown {
  for (const k of keys) if (Object.hasOwn(ex, k)) return ex[k]
  return null
}

function explicitParts(ex: Entry): { primary: unknown[]; secondary: unknown[] } | null {
  const primary = firstPresent(ex, ['primaries', 'primaryMuscles', 'primary'])
  const secondary = firstPresent(ex, ['secondaries', 'secondaryMuscles', 'secondary'])
  return primary !== null || secondary !== null ? { primary: arrayOf(primary), secondary: arrayOf(secondary) } : null
}

function explicitGroups(ex: Entry): unknown[] | null {
  for (const k of ['muscleGroups', 'muscles', 'targetMuscles']) {
    if (!Object.hasOwn(ex, k)) continue
    const groups = arrayOf(ex[k])
    return groups.length ? groups : null
  }
  return null
}

function hasExplicitMuscles(ex: Entry): boolean {
  const parts = explicitParts(ex)
  if (parts && [...parts.primary, ...parts.secondary].some(canonicalMuscle)) return true
  if (explicitGroups(ex)?.some(canonicalMuscle)) return true
  return [ex.tg, ex.mg, ...arrayOf(ex.sm)].some(canonicalMuscle)
}

function muscleGroupsOf(ex: Entry): string[] {
  const parts = explicitParts(ex)
  const useParts = !!parts && [...parts.primary, ...parts.secondary].some(canonicalMuscle)
  const out = canonicalUnique(useParts ? [...parts!.primary, ...parts!.secondary] : (explicitGroups(ex) ?? [ex.tg, ex.mg, ...arrayOf(ex.sm)]))
  return out.length || useParts ? out : canonicalUnique(BY_BODY_PART[String(ex.bp)] ?? [])
}

/** The primary and secondary muscles the app's form starts with for a stored exercise. */
function openedMuscles(c: Entry): { primaries: string[]; secondaries: string[] } {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : [])
  if (Array.isArray(c.primaries) && c.primaries.length) return { primaries: strings(c.primaries), secondaries: strings(c.secondaries) }
  const groups = hasExplicitMuscles(c) ? muscleGroupsOf(c) : []
  return { primaries: c.bp === 'cardio' ? ['cardiovascular system'] : groups.slice(0, 1), secondaries: groups.slice(1) }
}

/** A host a browser could reach: dotted labels, localhost or an IPv6 address (openGym `frontend/src/lib/media-refs.js` plausibleHost, v1.4.0). */
function plausibleHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true
  const h = host.replace(/\.$/, '').toLowerCase()
  if (h === 'localhost') return true
  const labels = h.split('.')
  return labels.length >= 2 && labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(l))
}

/** A link the app accepts: http(s), a plausible host, no credentials; a bare host gets https:// (media-refs.js cleanUrl). */
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
  return plausibleHost(u.hostname) && u.href.length <= 2048 ? u.href : null
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
        // Muscles are rewritten only when asked: the app's form rewrites them on every save, but a
        // rename should not turn an imported exercise's muscles into the form's reading of them.
        if (args.primaryMuscles || args.secondaryMuscles || args.target || args.bodyPart) {
          const opened = openedMuscles(c)
          // Off cardio, the cardio pseudo-muscle goes; the app's form cannot untick it.
          const primaries = bodyPart === 'cardio' ? ['cardiovascular system'] : inMuscleOrder((args.primaryMuscles ?? opened.primaries).filter((m) => m !== 'cardiovascular system'))
          const secondaries = inMuscleOrder((args.secondaryMuscles ?? opened.secondaries).filter((m) => !primaries.includes(m)))
          if (args.target && !primaries.includes(args.target)) return refuse(`target "${args.target}" is not one of the primary muscles`)
          c.tg = args.target ?? (typeof c.tg === 'string' && primaries.includes(c.tg) ? c.tg : (primaries[0] ?? ''))
          c.primaries = primaries
          c.secondaries = secondaries
          c.sm = secondaries
          c.muscleGroups = [...primaries, ...secondaries]
        }
        c.n = name
        c.bp = bodyPart
        c.eq = args.equipment ?? c.eq
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
