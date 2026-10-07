import { z } from 'zod'
import { prepareUpload, saveNew, sha256, type Prepared } from '../../media/files.js'
import { KIND_OF, type MediaMime } from '../../media/inspect.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, writableList, type Entry, type State } from '../../state/types.js'
import type { ToolContext } from '../context.js'
import { failure, invalid, success } from '../respond.js'
import { entryId } from '../schema.js'
import { defineTool } from '../types.js'
import { change } from '../write.js'

const hash = z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 (64 lowercase hex characters)')
const MB = 1024 * 1024
/** At most six photos or videos per workout, as in the app. */
export const WORKOUT_MEDIA_MAX = 6

interface MediaCaps {
  imageMB?: number
  gifMB?: number
  videoMB?: number
  videoSec?: number
  quotaMB?: number
  workouts?: boolean
}

/** Every file the profile references: custom exercises' media and workouts' media, with posters. */
export function referencedHashes(state: State | null): string[] {
  const out = new Set<string>()
  const add = (ref: unknown) => {
    if (!isRecord(ref)) return
    if (typeof ref.hash === 'string') out.add(ref.hash)
    if (isRecord(ref.poster) && typeof ref.poster.hash === 'string') out.add(ref.poster.hash)
  }
  for (const c of listOf(state, 'customEx')) add(c.media)
  for (const w of listOf(state, 'workouts')) if (Array.isArray(w.media)) w.media.forEach(add)
  return [...out].filter((h) => /^[0-9a-f]{64}$/.test(h))
}

const usageOf = (u: { bytes?: number; count?: number; quotaBytes?: number } | undefined) =>
  u ? { usedMB: Math.round(((u.bytes ?? 0) / MB) * 10) / 10, files: u.count ?? 0, quotaMB: u.quotaBytes ? Math.round(u.quotaBytes / MB) : 'no limit' } : undefined

export const readMediaUsage = defineTool({
  name: 'read_media_usage',
  description:
    'Photo and video storage of the profile: space used and the quota, how many files the profile references, which of those the server does not have, and the instance\'s limits per file (MB, video seconds).',
  input: {},
  async handler(_args, ctx) {
    const [snapshot, config] = await Promise.all([ctx.store.load(), ctx.http.request<{ media?: MediaCaps }>({ method: 'GET', path: '/api/config' })])
    if (!snapshot.ok) return failure('Could not read the profile', snapshot)
    if (!config.ok) return failure('Could not read the instance configuration', config)
    if (!config.data.media) return success({ enabled: false, note: 'This instance does not store photos and videos (MEDIA_UPLOADS=0).' })
    const hashes = referencedHashes(snapshot.data.state)
    const missing: string[] = []
    let usage: Parameters<typeof usageOf>[0]
    for (let i = 0; i === 0 || i < hashes.length; i += 1000) {
      const r = await ctx.http.request<{ missing: string[]; usage: Parameters<typeof usageOf>[0] }>({
        method: 'POST',
        path: '/api/media/missing',
        json: { hashes: hashes.slice(i, i + 1000) },
      })
      if (!r.ok) return failure('Could not read the media usage', r)
      missing.push(...(r.data.missing ?? []))
      usage = r.data.usage
    }
    return success({ enabled: true, usage: usageOf(usage), referenced: hashes.length, missingOnServer: missing, limits: config.data.media })
  },
})

function capProblem(p: Prepared, caps: MediaCaps): string | undefined {
  const size = p.bytes.length
  const { kind } = p.info
  const capMB = kind === 'video' ? caps.videoMB : kind === 'gif' ? caps.gifMB : caps.imageMB
  if (capMB && size > capMB * MB) {
    const advice = kind === 'video' ? 'shorten or compress it' : 'resize or compress it'
    return `the file is ${(size / MB).toFixed(1)} MB; this instance takes ${kind === 'image' ? 'photos' : kind === 'gif' ? 'GIFs' : 'videos'} up to ${capMB} MB, so ${advice} first (the app does that itself; leap uploads files as they are)`
  }
  if (kind === 'video' && caps.videoSec && p.info.dur !== undefined && p.info.dur > caps.videoSec + 1) return `the video is ${p.info.dur} s; this instance takes up to ${caps.videoSec} s`
  return undefined
}

export const writeAttachMedia = defineTool({
  name: 'write_attach_media',
  description:
    'Upload a photo or video from this computer and attach it to a logged workout (up to 6) or to a custom exercise (one; replaces the old one). `path` is an absolute local path (~/ allowed). Only JPEG, PNG, WebP, GIF, MP4, MOV and WebM files are read. Photos lose their metadata first (location, camera, time; the orientation stays); a video that records a location is refused. Files are not resized: check the limits with read_media_usage.',
  input: {
    path: z.string().min(1).max(4096),
    workoutId: entryId.optional(),
    customExerciseId: entryId.optional(),
  },
  async handler(args, ctx) {
    if (!args.workoutId === !args.customExerciseId) return invalid('give exactly one of workoutId or customExerciseId')
    let prepared: Prepared
    try {
      prepared = prepareUpload(args.path)
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error))
    }
    const config = await ctx.http.request<{ media?: MediaCaps }>({ method: 'GET', path: '/api/config' })
    if (!config.ok) return failure('Could not read the instance configuration', config)
    const caps = config.data.media
    if (!caps) return invalid('this instance does not store photos and videos (MEDIA_UPLOADS=0)')
    if (args.workoutId && !caps.workouts) return invalid('this openGym version keeps photos and videos on custom exercises only')
    const tooBig = capProblem(prepared, caps)
    if (tooBig) return invalid(tooBig)

    const before = await ctx.store.load()
    if (!before.ok) return failure('Could not read the profile', before)
    const target = args.workoutId
      ? listOf(before.data.state, 'workouts').find((w) => w.id === args.workoutId)
      : listOf(before.data.state, 'customEx').find((c) => c.id === args.customExerciseId)
    if (!target) return invalid(args.workoutId ? `no workout with id "${args.workoutId}"` : `no custom exercise with id "${args.customExerciseId}"`)

    const up = await ctx.http.request<{ ok: boolean; hash: string; mime: string; size: number; existed: boolean }>({
      method: 'PUT',
      path: `/api/media/${prepared.hash}`,
      bytes: { data: prepared.bytes, contentType: prepared.info.mime },
    })
    if (!up.ok) return failure('openGym did not take the file', up)
    const mime = (up.data.mime in KIND_OF ? up.data.mime : prepared.info.mime) as MediaMime

    return change(
      ctx,
      'attach the file',
      (draft, { now }) => {
        const ref: Entry = {
          kind: KIND_OF[mime],
          hash: prepared.hash,
          mime,
          size: prepared.bytes.length,
          width: prepared.info.width,
          height: prepared.info.height,
          ...(prepared.info.dur !== undefined ? { dur: prepared.info.dur } : {}),
          ...(prepared.info.codec ? { codec: prepared.info.codec } : {}),
          at: now,
        }
        if (args.workoutId) {
          const w = writableList(draft, 'workouts').find((x): x is Entry => isRecord(x) && x.id === args.workoutId)
          if (!w) return refuse(`the workout "${args.workoutId}" was deleted meanwhile; the file stays on the server until its grace period ends`)
          const list = Array.isArray(w.media) ? w.media : []
          if (list.some((m) => isRecord(m) && m.hash === prepared.hash)) return refuse('this file is already on the workout')
          if (list.filter(isRecord).length >= WORKOUT_MEDIA_MAX) return refuse(`the workout already has ${WORKOUT_MEDIA_MAX} photos or videos; remove one first`)
          w.media = [...list, ref]
          w._ts = now
        } else {
          const c = writableList(draft, 'customEx').find((x): x is Entry => isRecord(x) && x.id === args.customExerciseId)
          if (!c) return refuse(`the custom exercise "${args.customExerciseId}" was deleted meanwhile`)
          c.media = ref
          c._ts = now
        }
        return apply(ref)
      },
      (ref) => ({
        attached: { hash: ref.hash, kind: ref.kind, mime: ref.mime, sizeKB: Math.round(Number(ref.size) / 1024), width: ref.width, height: ref.height, ...(ref.dur !== undefined ? { durationSec: ref.dur } : {}) },
        to: args.workoutId ? { workoutId: args.workoutId } : { customExerciseId: args.customExerciseId },
        ...(prepared.stripped > 0 ? { metadataRemovedBytes: prepared.stripped } : {}),
        ...(up.data.existed ? { alreadyOnServer: true } : {}),
      }),
      {
        verify: (s) => {
          const holder = args.workoutId ? listOf(s, 'workouts').find((w) => w.id === args.workoutId) : listOf(s, 'customEx').find((c) => c.id === args.customExerciseId)
          const refs = holder ? (args.workoutId ? (Array.isArray(holder.media) ? holder.media : []) : [holder.media]) : []
          return refs.some((m) => isRecord(m) && m.hash === prepared.hash) ? [] : ['media reference']
        },
      },
    )
  },
})

export const deleteMedia = defineTool({
  name: 'delete_media',
  description:
    'Take a photo or video off a workout or a custom exercise. openGym deletes the file itself once nothing references it for its grace period (14 days by default), or at once with delete_media_sweep.',
  input: { hash, workoutId: entryId.optional(), customExerciseId: entryId.optional() },
  async handler(args, ctx) {
    if (!args.workoutId === !args.customExerciseId) return invalid('give exactly one of workoutId or customExerciseId')
    return change(
      ctx,
      'remove the file',
      (draft, { now }) => {
        if (args.workoutId) {
          const w = writableList(draft, 'workouts').find((x): x is Entry => isRecord(x) && x.id === args.workoutId)
          if (!w) return refuse(`no workout with id "${args.workoutId}"`)
          const list = Array.isArray(w.media) ? w.media : []
          const left = list.filter((m) => !(isRecord(m) && m.hash === args.hash))
          if (left.length === list.length) return refuse('that file is not on this workout')
          if (left.length) w.media = left
          else delete w.media
          w._ts = now
        } else {
          const c = writableList(draft, 'customEx').find((x): x is Entry => isRecord(x) && x.id === args.customExerciseId)
          if (!c) return refuse(`no custom exercise with id "${args.customExerciseId}"`)
          if (!isRecord(c.media) || c.media.hash !== args.hash) return refuse('that file is not on this exercise')
          delete c.media
          c._ts = now
        }
        return apply(null)
      },
      () => ({ removed: args.hash, from: args.workoutId ? { workoutId: args.workoutId } : { customExerciseId: args.customExerciseId } }),
      {
        verify: (s) => {
          const still = args.workoutId
            ? listOf(s, 'workouts').some((w) => w.id === args.workoutId && Array.isArray(w.media) && w.media.some((m) => isRecord(m) && m.hash === args.hash))
            : listOf(s, 'customEx').some((c) => c.id === args.customExerciseId && isRecord(c.media) && c.media.hash === args.hash)
          return still ? ['the media reference is still there'] : []
        },
      },
    )
  },
})

export const readMedia = defineTool({
  name: 'read_media',
  description:
    'Download one of the profile\'s photos or videos (by hash, see read_workout or read_exercise) to a new local file. `saveTo` is an absolute path (~/ allowed): a directory gets "<hash>.<ext>"; an existing file is never overwritten. The download is checked against its hash.',
  input: { hash, saveTo: z.string().min(1).max(4096) },
  async handler(args, ctx) {
    const r = await ctx.http.request({ method: 'GET', path: `/api/media/${args.hash}`, expect: 'bytes' })
    if (!r.ok) return failure(r.status === 404 ? 'openGym does not have that file for this profile' : 'Could not download the file', r)
    if (sha256(r.data.data) !== args.hash) return failure('The download does not match its hash; nothing was saved')
    const mime = r.data.contentType.split(';')[0]!.trim()
    try {
      const path = saveNew(args.saveTo, args.hash, mime, r.data.data)
      return success({ saved: path, mime, sizeKB: Math.round(r.data.data.length / 1024) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(`Not saved: ${/EEXIST/.test(message) ? 'that file already exists' : message}`)
    }
  },
})

export const deleteMediaSweep = defineTool({
  name: 'delete_media_sweep',
  description:
    'Delete at once every stored photo and video of the profile that nothing references any more, instead of waiting for the grace period. At most 10 times an hour.',
  input: {},
  async handler(_args, ctx: ToolContext) {
    const r = await ctx.http.request<{ removed: number; freedBytes: number; usage: Parameters<typeof usageOf>[0] }>({ method: 'POST', path: '/api/media/sweep', json: {} })
    if (!r.ok) return failure('The sweep did not run', r)
    return success({ removed: r.data.removed, freedMB: Math.round((r.data.freedBytes / MB) * 10) / 10, usage: usageOf(r.data.usage) })
  },
})

export const mediaReadTools = [readMediaUsage, readMedia]
export const mediaWriteTools = [writeAttachMedia]
export const mediaDeleteTools = [deleteMedia, deleteMediaSweep]
