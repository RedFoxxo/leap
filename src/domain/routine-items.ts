import type { Entry } from '../state/types.js'

/**
 * A routine exercise as openGym stores it, and the same item as leap's tools
 * read and write it. read_routine returns the tool format, so an exercise can
 * be read, changed and written back as it is (docs/OPENGYM.md, "Routines").
 */

/** Tool field ↔ stored field. `exerciseId` ↔ `id` and `superset` ↔ `sg` are handled on their own. */
export const ITEM_FIELDS = [
  ['sets', 'sets'],
  ['reps', 'reps'],
  ['repsMin', 'repsMin'],
  ['repsMax', 'repsMax'],
  ['weight', 'weight'],
  ['mode', 'mode'],
  ['sec', 'sec'],
  ['min', 'min'],
  ['speed', 'speed'],
  ['restSec', 'restSec'],
  ['warmupRestSec', 'warmupRestSec'],
  ['warmupSets', 'warmupSets'],
  ['note', 'note'],
  ['progression', 'prog'],
  ['increment', 'inc'],
  ['deloadFactor', 'deloadFactor'],
  ['bodyweight', 'bodyweight'],
  ['perSide', 'side'],
  ['assisted', 'assisted'],
  ['intensifier', 'intensifier'],
] as const

/** Stored fields leap understands; anything else on an item is openGym's own and is kept as it is. */
export const MANAGED_ITEM_KEYS: ReadonlySet<string> = new Set(['id', 'sg', ...ITEM_FIELDS.map(([, stored]) => stored)])

export type ItemMode = 'reps' | 'time' | 'cardio'

/** Progression policies the app offers per logging mode, and at routine level. */
export const POLICIES_FOR: Record<ItemMode, readonly string[]> = {
  reps: ['off', 'linear', 'greyskull', 'double'],
  time: ['off', 'time'],
  cardio: ['off'],
}
export const ROUTINE_POLICIES = ['off', 'linear', 'greyskull', 'double'] as const

/** What the app gives a freshly added exercise (its defaultConfig). */
export function defaultItem(id: string, mode: ItemMode, bodyweight: boolean): Entry {
  if (mode === 'cardio') return { id, sets: 1, min: 20, speed: 8 }
  const bw = bodyweight ? { bodyweight: true } : {}
  if (mode === 'time') return { id, sets: 3, sec: 45, weight: 0, mode: 'time', ...bw }
  return { id, sets: 3, reps: 10, weight: 0, mode: 'reps', ...bw }
}

/** A stored item in the tool format, with its position and name for reading. */
export function itemForTools(stored: Entry, position: number, name: string): Entry {
  const out: Entry = { position, name, exerciseId: stored.id }
  for (const [tool, key] of ITEM_FIELDS) if (stored[key] !== undefined && stored[key] !== null) out[tool] = stored[key]
  if (typeof stored.sg === 'string' && stored.sg) out.superset = stored.sg
  const other = Object.fromEntries(Object.entries(stored).filter(([k]) => !MANAGED_ITEM_KEYS.has(k)))
  if (Object.keys(other).length) out.other = other
  return out
}
