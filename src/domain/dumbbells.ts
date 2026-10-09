import { isRecord, listOf, mapOf, type Entry, type State } from '../state/types.js'

/**
 * What a dumbbell or kettlebell weight means ("per dumbbell or both
 * together"), as openGym reads it. Ported from openGym
 * `frontend/src/lib/dumbbells.js` at v1.4.0 (28b7e4dc).
 *
 * The meaning lives in three places: the exercise's default
 * (`state.dbLoad[id] = { mode, _ts }`), a routine exercise's own choice
 * (`item.dbLoad`), and the stamp a logged session carries (`entry.target.dbLoad`).
 * "as" (as entered) is today's behaviour and never converts.
 */

export type DbLoad = 'as' | 'each' | 'total'

/** Equipment held one in each hand. */
export const BELL_EQUIPMENT: ReadonlySet<string> = new Set(['dumbbell', 'kettlebell'])

/** A stored meaning, or null when there is none (`{ mode }` or a bare value). */
export function dbLoadOf(value: unknown): DbLoad | null {
  const m = isRecord(value) ? value.mode : value
  return m === 'each' || m === 'total' || m === 'as' ? m : null
}

/** The exercise's own default (state.dbLoad), "as" when it has none. */
export const exerciseDbLoad = (state: State | null, exerciseId: string): DbLoad => dbLoadOf(mapOf(state, 'dbLoad')[exerciseId]) ?? 'as'

/** One arm at a time means one bell; "alternating" still holds two. */
const ONE_ARM = /\b(one|single)[- ]?(arm|hand|handed)\b/i

/** How many bells are lifted at once: 1 when logged per side or named one-arm, else 2. */
export const bellsIn = (cfg: Entry | undefined, name: string): number => (cfg?.side || ONE_ARM.test(name) ? 1 : 2)

/** The meaning a logged entry was saved with: its target's stamp, "as" when it has none. */
export const entryDbLoad = (entry: Entry): DbLoad => dbLoadOf(isRecord(entry.target) ? entry.target.dbLoad : undefined) ?? 'as'

/** What one logged kilo of an entry is worth in volume: 2 for "each" on two bells, else 1. */
export function volumeFactor(entry: Entry, name: string): number {
  return entryDbLoad(entry) === 'each' ? bellsIn(isRecord(entry.target) ? entry.target : undefined, name) : 1
}

/** The factor that turns a weight meant as `from` into the same load meant as `to`. */
export function meaningFactor(from: DbLoad, to: DbLoad, cfg: Entry | undefined, name: string): number {
  if (from === to || from === 'as' || to === 'as') return 1
  const n = bellsIn(cfg, name)
  if (n === 1) return 1
  return from === 'each' ? n : 1 / n
}

const tidy = (w: number) => Math.round(w * 1000) / 1000

function scaleRow(row: unknown, f: number): unknown {
  if (!isRecord(row)) return row
  const out: Entry = { ...row }
  if (row.w != null && Number.isFinite(Number(row.w))) out.w = tidy(Number(row.w) * f)
  if (Array.isArray(row.drops)) out.drops = row.drops.map((d) => (isRecord(d) ? { ...d, w: tidy((Number(d.w) || 0) * f) } : d))
  if (isRecord(row.sides)) out.sides = Object.fromEntries(Object.entries(row.sides).map(([k, s]) => [k, scaleRow(s, f)]))
  return out
}

/** The entry with its weights read as `to`: a scaled copy when the meanings differ. For comparing, never for storing. */
export function entryAs(entry: Entry, to: DbLoad, name: string): Entry {
  const from = entryDbLoad(entry)
  const f = meaningFactor(from, to, isRecord(entry.target) ? entry.target : undefined, name)
  if (f === 1) return entry
  const out: Entry = { ...entry, target: { ...(isRecord(entry.target) ? entry.target : {}), dbLoad: to }, sets: listOf(entry, 'sets').map((s) => scaleRow(s, f)) }
  if (Number(entry.topW) > 0) out.topW = tidy(Number(entry.topW) * f)
  return out
}

/**
 * The meaning an exercise's history is read in when no session is asking: the
 * exercise's own default, else the meaning it was last logged with, else "as".
 */
export function currentDbLoad(state: State | null, exerciseId: string): DbLoad {
  const own = dbLoadOf(mapOf(state, 'dbLoad')[exerciseId])
  if (own) return own
  const workouts = listOf(state, 'workouts')
  for (let i = workouts.length - 1; i >= 0; i--) {
    const entries = listOf(workouts[i], 'entries')
    for (let j = entries.length - 1; j >= 0; j--) {
      const e = entries[j]!
      if (e.id === exerciseId && isRecord(e.target) && e.target.dbLoad) return entryDbLoad(e)
    }
  }
  return 'as'
}

/** The owned dumbbells of the profile's unit, cleaned as the app reads them (single bells, ascending). */
export function ownedDumbbells(state: State | null, unit: 'kg' | 'lb'): number[] {
  const rack = mapOf(state, 'dumbbells')[unit]
  const list = isRecord(rack) && Array.isArray(rack.weights) ? rack.weights : []
  const clean = list.map(Number).filter((w) => Number.isFinite(w) && w > 0 && w < 10000).map(tidy)
  return [...new Set(clean)].sort((a, b) => a - b)
}
