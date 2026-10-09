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
  ['setsMax', 'setsMax'],
  ['lastSetToFailure', 'lastToFailure'],
  ['backoff', 'backoff'],
  ['pyramid', 'pyramid'],
  ['pyramidRestSec', 'pyramidRest'],
  ['pyramidWeight', 'pyramidWeight'],
  ['dumbbellLoad', 'dbLoad'],
  ['supersetName', 'sgName'],
  ['supersetRestSec', 'sgRest'],
] as const

/** Stored fields leap understands; anything else on an item is openGym's own and is kept as it is. */
export const MANAGED_ITEM_KEYS: ReadonlySet<string> = new Set(['id', 'sg', ...ITEM_FIELDS.map(([, stored]) => stored)])

export type ItemMode = 'reps' | 'time' | 'cardio'

/** Progression policies the app offers per logging mode, and at routine level. */
export const POLICIES_FOR: Record<ItemMode, readonly string[]> = {
  reps: ['off', 'linear', 'greyskull', 'double', 'triple'],
  time: ['off', 'time'],
  cardio: ['off'],
}
export const ROUTINE_POLICIES = ['off', 'linear', 'greyskull', 'double', 'triple'] as const

/** Most sets a pyramid or triple progression plans (openGym pyramid.js, progression.js, v1.4.0). */
export const MAX_PLANNED_SETS = 10

/** A pyramid as the app keeps it: whole reps of at least 1 or "max", per side rounded up to even, at most 10 (pyramid.js normalizePyramid). */
export function normalizePyramid(list: readonly (number | 'max')[], perSide: boolean): (number | 'max')[] {
  return list.slice(0, MAX_PLANNED_SETS).map((v) => {
    if (v === 'max') return v
    const r = Math.max(1, Math.round(v))
    return perSide && r % 2 ? r + 1 : r
  })
}

/** A per-set list aligned to the pyramid (missing values 0), or undefined when every value is 0: not stored. */
export function alignedOrNone(values: readonly number[] | undefined, length: number, step: (v: number) => number): number[] | undefined {
  if (!values) return undefined
  const out = Array.from({ length }, (_, i) => step(Math.max(0, values[i] ?? 0)))
  return out.some((v) => v > 0) ? out : undefined
}

/** Equipment the app treats as body weight unless an exercise says otherwise (openGym `exercises.js` isBodyweightEq). */
export const BODYWEIGHT_EQUIPMENT: ReadonlySet<string> = new Set(['body weight', 'band', 'resistance band'])

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
