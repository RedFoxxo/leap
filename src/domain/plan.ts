import { listOf, mapOf, type Entry, type State } from '../state/types.js'
import { effectivePlan, type PlannedBy } from './queue.js'

/** The routines on a weekday (`week[0..6]`): a list now, a single id in older documents. */
export function weekdayRoutineIds(state: State | null, weekday: number): string[] {
  const value = mapOf(state, 'week')[String(weekday)]
  const ids = Array.isArray(value) ? value : value != null ? [value] : []
  return ids.filter((x): x is string => typeof x === 'string' && x !== '')
}

export interface DayPlan {
  routineIds: string[]
  /** `rest` or `routine` when `dayPlan` overrides the plan for this date (a pin is not an override). */
  override?: 'rest' | 'routine'
  /** What decided it: a date override, a pinned session, the rotation or a planner's queue, the weekday, or nothing (rest). */
  plannedBy: PlannedBy
}

/**
 * What is planned on a date, as the app decides it (see queue.ts, effectivePlan):
 * a `dayPlan` override wins; otherwise the rotation's or a planner's session for
 * the day comes first, with the weekday's own routines alongside. `today`
 * matters because the queue answers only for one day. Ids of routines that no
 * longer exist are ignored, as the app ignores them.
 */
export function planFor(state: State | null, iso: string, today: string): DayPlan {
  const p = effectivePlan(state, iso, today)
  const override = p.plannedBy === 'rest-override' ? 'rest' : p.plannedBy === 'override' ? 'routine' : undefined
  return { routineIds: p.routineIds, plannedBy: p.plannedBy, ...(override ? { override } : {}) }
}

export function routineById(state: State | null, id: string): Entry | undefined {
  return listOf(state, 'routines').find((r) => r.id === id)
}

export function routineName(state: State | null, id: string): string {
  const name = routineById(state, id)?.name
  return typeof name === 'string' && name ? name : id
}
