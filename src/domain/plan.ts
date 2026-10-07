import { listOf, mapOf, type Entry, type State } from '../state/types.js'
import { weekdayOf } from './dates.js'

/** The routines on a weekday (`week[0..6]`): a list now, a single id in older documents. */
export function weekdayRoutineIds(state: State | null, weekday: number): string[] {
  const value = mapOf(state, 'week')[String(weekday)]
  const ids = Array.isArray(value) ? value : value != null ? [value] : []
  return ids.filter((x): x is string => typeof x === 'string' && x !== '')
}

export interface DayPlan {
  routineIds: string[]
  /** `rest` or `routine` when `dayPlan` overrides the weekly plan for this date. */
  override?: 'rest' | 'routine'
}

/**
 * What is planned on a date, as the app decides it: a `dayPlan` override (one
 * routine id, or `"rest"`) wins over the weekday's routines. Ids of routines
 * that no longer exist are ignored, as the app ignores them.
 */
export function planFor(state: State | null, iso: string): DayPlan {
  const routines = new Set(listOf(state, 'routines').map((r) => r.id))
  const override = mapOf(state, 'dayPlan')[iso]
  if (override === 'rest') return { routineIds: [], override: 'rest' }
  if (typeof override === 'string' && routines.has(override)) return { routineIds: [override], override: 'routine' }
  return { routineIds: weekdayRoutineIds(state, weekdayOf(iso)).filter((id) => routines.has(id)) }
}

export function routineById(state: State | null, id: string): Entry | undefined {
  return listOf(state, 'routines').find((r) => r.id === id)
}

export function routineName(state: State | null, id: string): string {
  const name = routineById(state, id)?.name
  return typeof name === 'string' && name ? name : id
}
