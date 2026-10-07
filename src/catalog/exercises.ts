import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FetchLike } from '../http/core.js'
import type { Logger } from '../log.js'
import { isRecord, listOf, mapOf, type State } from '../state/types.js'

/**
 * openGym's built-in exercises come from hasaneyldrm/exercises-dataset, whose
 * metadata and instruction text are MIT; the ids are the same. leap does not
 * bundle the data: it downloads this pinned commit once, checks its hash, and
 * caches a slim copy. The dataset's images and GIFs are third-party content and
 * are never fetched. See docs/OPENGYM.md.
 */
export const DATASET = {
  commit: '7455efae41b330c265e7cd4b78dfa848e7ce5ebd',
  url: 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/7455efae41b330c265e7cd4b78dfa848e7ce5ebd/data/exercises.json',
  sha256: '656634224b8977b99a6d765470ee123260d4979715eaa4e7c0b7c8bb0d79f93d',
  licence: 'MIT, hasaneyldrm/exercises-dataset (originally ExerciseDB)',
}

export interface Exercise {
  id: string
  name: string
  bodyPart?: string
  equipment?: string
  /** Main target muscle. */
  target?: string
  secondary: string[]
  /** English instruction steps (built-in exercises). */
  steps: string[]
  custom: boolean
  /** Custom exercises: explicitly marked as an assistance machine (or explicitly not). */
  assisted?: boolean
  /** Custom exercises: description and link. */
  description?: string
  url?: string
}

export interface BuiltinCatalog {
  exercises: Map<string, Exercise>
  /** Why the built-in names are unavailable; tools then show ids. */
  error?: string
}

const RETRY_AFTER_MS = 5 * 60_000

export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache')
  return join(root, 'leap', `exercises-${DATASET.commit.slice(0, 12)}.json`)
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => s !== undefined) : [])

/** Upstream mis-encodes "°" in four names ("45в°"). */
const fixName = (name: string) => name.replace(/в°/g, '°')

/** The dataset's records, reduced to what leap shows. */
export function slimDataset(records: unknown): Exercise[] {
  if (!Array.isArray(records)) throw new Error('the exercise dataset is not a list')
  const out: Exercise[] = []
  for (const r of records) {
    if (!isRecord(r)) continue
    const id = text(r.id)
    const name = text(r.name)
    if (!id || !name) continue
    const steps = isRecord(r.instruction_steps) ? texts(r.instruction_steps.en) : []
    const e: Exercise = { id, name: fixName(name), secondary: texts(r.secondary_muscles), steps, custom: false }
    const bodyPart = text(r.body_part)
    const equipment = text(r.equipment)
    const target = text(r.target)
    if (bodyPart) e.bodyPart = bodyPart
    if (equipment) e.equipment = equipment
    if (target) e.target = target
    out.push(e)
  }
  return out
}

export interface CatalogOptions {
  cacheFile?: string
  /** Override the pinned dataset (tests). */
  dataset?: { url: string; sha256: string }
  fetch?: FetchLike
  log?: Logger
  now?: () => number
}

/** Loads the built-in catalogue once (cache first, then the pinned download) and keeps it. */
export class BuiltinCatalogProvider {
  private loading: Promise<BuiltinCatalog> | undefined
  private failedAt: number | undefined
  private readonly cacheFile: string
  private readonly dataset: { url: string; sha256: string }
  private readonly fetchImpl: FetchLike
  private readonly log: Logger
  private readonly now: () => number

  constructor(options: CatalogOptions = {}) {
    this.cacheFile = options.cacheFile ?? defaultCacheFile()
    this.dataset = options.dataset ?? DATASET
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  /** Starts loading in the background, so the first tool call does not wait for the download. */
  start(): void {
    void this.get()
  }

  get(): Promise<BuiltinCatalog> {
    if (this.loading && !(this.failedAt !== undefined && this.now() - this.failedAt > RETRY_AFTER_MS)) return this.loading
    this.failedAt = undefined
    this.loading = this.load().then(
      (list) => ({ exercises: new Map(list.map((e) => [e.id, e])) }),
      (error: unknown) => {
        this.failedAt = this.now()
        const message = error instanceof Error ? error.message : String(error)
        this.log(`exercise names unavailable: ${message}`)
        return { exercises: new Map(), error: `built-in exercise names are unavailable (${message}); ids are shown instead` }
      },
    )
    return this.loading
  }

  private async load(): Promise<Exercise[]> {
    try {
      return JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Exercise[]
    } catch {
      // not cached yet, or unreadable: download
    }
    this.log(`downloading exercise names (${DATASET.licence})`)
    const response = await this.fetchImpl(this.dataset.url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`download failed with ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== this.dataset.sha256) throw new Error('the downloaded dataset does not match the pinned hash')
    const list = slimDataset(JSON.parse(new TextDecoder().decode(bytes)))
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(list))
      renameSync(tmp, this.cacheFile)
    } catch (error) {
      this.log(`could not cache exercise names: ${error instanceof Error ? error.message : String(error)}`)
    }
    return list
  }
}

/** The profile's own exercises, in the same shape as the built-in ones. */
export function customExercises(state: State | null): Exercise[] {
  const out: Exercise[] = []
  for (const c of listOf(state, 'customEx')) {
    const id = text(c.id)
    if (!id) continue
    const e: Exercise = {
      id,
      name: text(c.n) ?? id,
      secondary: texts(c.secondaries).length ? texts(c.secondaries) : texts(c.sm),
      steps: [],
      custom: true,
    }
    const bodyPart = text(c.bp)
    const equipment = text(c.eq)
    const target = text(c.tg) ?? texts(c.primaries)[0]
    const description = text(c.desc)
    const url = text(c.url)
    if (bodyPart) e.bodyPart = bodyPart
    if (equipment) e.equipment = equipment
    if (target) e.target = target
    if (description) e.description = description
    if (url) e.url = url
    if (typeof c.assisted === 'boolean') e.assisted = c.assisted
    out.push(e)
  }
  return out
}

/**
 * Whether lighter is better (an assistance machine), as openGym decides it: an
 * explicit `assisted` flag wins; otherwise a leverage machine whose name says
 * "assist(ed)" (the assisted pull-up, dip and their variants). The dataset's
 * "assisted" equipment is partner-assisted stretches and the like, where
 * heavier is still harder, so it does not count.
 */
export function isAssisted(e: Exercise | undefined): boolean {
  if (!e) return false
  if (typeof e.assisted === 'boolean') return e.assisted
  return e.equipment === 'leverage machine' && /\bassist(ed)?\b/i.test(e.name)
}

/** Every exercise the profile can use: built-in ones and its own, by id. */
export class ExerciseIndex {
  readonly byId: Map<string, Exercise>
  readonly favourites: Set<string>
  private readonly notes: Record<string, unknown>

  constructor(
    builtin: BuiltinCatalog,
    state: State | null,
    readonly warning: string | undefined = builtin.error,
  ) {
    this.byId = new Map(builtin.exercises)
    for (const c of customExercises(state)) this.byId.set(c.id, c)
    this.favourites = new Set(Array.isArray(state?.favEx) ? state.favEx.filter((x): x is string => typeof x === 'string') : [])
    this.notes = mapOf(state, 'exNotes')
  }

  get(id: string): Exercise | undefined {
    return this.byId.get(id)
  }

  assisted(id: string): boolean {
    return isAssisted(this.byId.get(id))
  }

  /** The exercise's name, or its id when it is unknown (deleted custom exercise, names unavailable). */
  name(id: string): string {
    return this.byId.get(id)?.name ?? id
  }

  note(id: string): string | undefined {
    return text(this.notes[id])
  }
}
