import { z } from 'zod'
import type { Exercise } from '../../catalog/exercises.js'
import { searchExercises } from '../../catalog/search.js'
import { BELL_EQUIPMENT, exerciseDbLoad } from '../../domain/dumbbells.js'
import { muscleName } from '../../domain/stats.js'
import { isRecord, mapOf, unitOf } from '../../state/types.js'
import { loadProfile } from '../context.js'
import { failure, success } from '../respond.js'
import { exerciseId, limit } from '../schema.js'
import { defineTool } from '../types.js'

const lower = (s: string | undefined) => s?.toLowerCase().trim()

function summary(e: Exercise, favourite: boolean) {
  return {
    id: e.id,
    name: e.name,
    ...(e.bodyPart ? { bodyPart: e.bodyPart } : {}),
    ...(e.equipment ? { equipment: e.equipment } : {}),
    ...(e.target ? { target: e.target } : {}),
    ...(e.category ? { category: e.category } : {}),
    ...(e.custom ? { custom: true } : {}),
    ...(favourite ? { favourite: true } : {}),
  }
}

export const readExercises = defineTool({
  name: 'read_exercises',
  description:
    "Find exercises: openGym's built-in catalogue (5,632, English names) and the profile's own custom exercises. Every word of `query` must be found, best matches first: in the name above all, also in the target muscle, equipment, body part or secondary muscles; gym shorthand (db, bb, kb, ohp, rdl, …), plurals, run-together names (\"benchpress\") and small typos work. Filters match exactly (case-insensitive). Body parts: back, cardio, chest, full body, lower arms, lower legs, neck, shoulders, upper arms, upper legs, waist. Categories: strength, calisthenics, stretching, mobility, plyometrics, isometric, cardio, yoga, olympic, pilates, rehab, combat. Use the returned id in other tools.",
  input: {
    query: z.string().max(100).optional().describe('e.g. "incline db press"'),
    bodyPart: z.string().max(40).optional(),
    equipment: z.string().max(40).optional().describe('e.g. barbell, dumbbell, cable, body weight, leverage machine, kettlebell, landmine'),
    target: z.string().max(40).optional().describe('Main muscle, e.g. pectorals, lats, quads, glutes, delts'),
    category: z.string().max(40).optional().describe('Built-in exercises only, e.g. strength, stretching, mobility'),
    source: z.enum(['all', 'builtin', 'custom']).optional().describe('Default all'),
    favouritesOnly: z.boolean().optional(),
    limit: limit(50, 500),
  },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { exercises } = profile.data
    const source = args.source ?? 'all'
    const filtered = [...exercises.byId.values()].filter(
      (e) =>
        (source === 'all' || (source === 'custom') === e.custom) &&
        (!args.favouritesOnly || exercises.favourites.has(e.id)) &&
        (!args.bodyPart || lower(e.bodyPart) === lower(args.bodyPart)) &&
        (!args.equipment || lower(e.equipment) === lower(args.equipment)) &&
        (!args.category || lower(e.category) === lower(args.category)) &&
        (!args.target || (e.target !== undefined && muscleName(e.target) === muscleName(args.target))),
    )
    const matches = searchExercises(filtered, args.query ?? '', { favourites: exercises.favourites })
    const max = args.limit ?? 50
    return success({
      total: matches.length,
      ...(matches.length > max ? { truncated: true } : {}),
      ...(exercises.warning ? { warning: exercises.warning } : {}),
      exercises: matches.slice(0, max).map((e) => summary(e, exercises.favourites.has(e.id))),
    })
  },
})

export const readExercise = defineTool({
  name: 'read_exercise',
  description:
    'One exercise by id: name, body part, equipment, category, target and secondary muscles, description and instruction steps (built-in, English), or description, link, muscles and photo or video (custom; the hash works with write_download_media and delete_media), plus the profile\'s standing note for it, whether it is a favourite, for dumbbell and kettlebell exercises what a weight means (weightMeans: as entered, each, total), and the remembered working weight (`lastWeight`, in the profile unit).',
  input: { id: exerciseId },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { exercises, state } = profile.data
    const e = exercises.get(args.id)
    if (!e) {
      const hint = exercises.warning ? ` (${exercises.warning})` : '; find ids with read_exercises'
      return failure(`No exercise with id "${args.id}"${hint}`)
    }
    const memory = mapOf(state, 'exWeights')[e.id]
    const note = exercises.note(e.id)
    const means = BELL_EQUIPMENT.has(e.equipment ?? '') ? exerciseDbLoad(state, e.id) : undefined
    return success({
      ...summary(e, exercises.favourites.has(e.id)),
      secondary: e.secondary,
      ...(e.steps.length ? { steps: e.steps } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.url ? { url: e.url } : {}),
      ...(e.primaryMuscles ? { primaryMuscles: e.primaryMuscles } : {}),
      ...(e.secondaryMuscles ? { secondaryMuscles: e.secondaryMuscles } : {}),
      ...(e.media ? { media: { hash: e.media.hash, kind: e.media.kind, mime: e.media.mime, size: e.media.size, width: e.media.width, height: e.media.height } } : {}),
      ...(note ? { note } : {}),
      ...(means ? { weightMeans: means } : {}),
      ...(isRecord(memory) && typeof memory.w === 'number'
        ? { lastWeight: { weight: memory.w, unit: unitOf(state), ...(typeof memory.d === 'string' ? { date: memory.d } : {}) } }
        : {}),
    })
  },
})

export const exerciseReadTools = [readExercises, readExercise]
