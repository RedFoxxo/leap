/**
 * The profile document. openGym treats it as opaque and it grows with the app,
 * so it is typed loosely: leap reads the fields it knows and carries every
 * other key through unchanged. See docs/OPENGYM.md.
 */
export type State = Record<string, unknown> & {
  _ts?: number
  _rev?: number
  unit?: string
  workouts?: unknown
  routines?: unknown
}

export type Entry = Record<string, unknown>

export interface Snapshot {
  /** `null` before the profile's first sync. */
  state: State | null
  rev: number
}

/** Top-level keys whose default is a list; never written as anything else. */
export const LIST_KEYS = [
  'workouts',
  'routines',
  'bodyweight',
  'customEx',
  'favEx',
  'equipProfiles',
  'gymCards',
  'measurements',
  'customMeasurements',
] as const

/** Top-level keys whose default is an object map; never written as anything else. */
export const MAP_KEYS = [
  'week',
  'dayPlan',
  'exWeights',
  'exNotes',
  'barWeights',
  'plates',
  'loadKind',
  'reminder',
  'balanceOverrides',
  'enParens',
  'enOnly',
  'dayNotes',
  'dbLoad',
  'dumbbells',
  'edited',
  'deleted',
] as const

/** The profile's weight unit; every stored weight is in it. The app defaults to kg. */
export function unitOf(state: State | null | undefined): 'kg' | 'lb' {
  return state?.unit === 'lb' ? 'lb' : 'kg'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The list under `key`, or an empty list when absent or malformed. Read-only use. */
export function listOf(state: State | null | undefined, key: string): Entry[] {
  const value = state?.[key]
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** The map under `key`, or an empty map when absent or malformed. Read-only use. */
export function mapOf(state: State | null | undefined, key: string): Record<string, unknown> {
  const value = state?.[key]
  return isRecord(value) ? value : {}
}

/** The list under `key` for writing: created when absent, so changes land in the document. */
export function writableList(state: State, key: string): unknown[] {
  const value = state[key]
  if (Array.isArray(value)) return value
  const created: unknown[] = []
  state[key] = created
  return created
}

/** The map under `key` for writing: created when absent. */
export function writableMap(state: State, key: string): Record<string, unknown> {
  const value = state[key]
  if (isRecord(value)) return value
  const created: Record<string, unknown> = {}
  state[key] = created
  return created
}
