import { isRecord, mapOf, writableMap, type Entry, type State } from '../state/types.js'
import { bestWeight, entriesOf } from './sets.js'
import { beatsWeight } from './stats.js'

/** Whether an exercise is an assistance machine (less weight is better). */
export type AssistedCheck = (exerciseId: string) => boolean

const byDayStart = (a: Entry, b: Entry) =>
  String(a.d) === String(b.d) ? (Number(a.start) || 0) - (Number(b.start) || 0) : String(a.d) < String(b.d) ? -1 : 1

/** Workouts stay sorted by day, then start: the app reads "last time" from the end. */
export function sortWorkouts(workouts: unknown[]): unknown[] {
  const records = workouts.filter(isRecord)
  const others = workouts.filter((w) => !isRecord(w))
  return [...records.sort(byDayStart), ...others]
}

/** The best load one workout logged for an exercise, across every occurrence of it. */
export function bestIn(workout: Entry | null | undefined, id: string, assisted: AssistedCheck): number {
  let best = 0
  for (const e of workout ? entriesOf(workout) : []) {
    if (e.id !== id) continue
    const w = bestWeight(e, assisted(id))
    if (beatsWeight(w, best, assisted(id))) best = w
  }
  return best
}

/**
 * PR badges after history changed, as openGym rebuilds them: walking the
 * workouts in order, a session keeps its badge for an exercise only while it
 * still leads every earlier session. Only `moved` (the logged or edited
 * workout) can gain a badge; other sessions never sprout new ones.
 */
export function rebuildPrHistory(workouts: unknown[], exerciseIds: Iterable<string>, moved: Entry | null, assisted: AssistedCheck): unknown[] {
  const ids = new Set(exerciseIds)
  if (!ids.size) return workouts
  const best = new Map<string, number>()
  return workouts.map((w) => {
    if (!isRecord(w)) return w
    const had = Array.isArray(w.prs) ? w.prs.filter((x): x is string => typeof x === 'string') : []
    const kept: string[] = []
    let trains = false
    for (const e of entriesOf(w)) {
      const id = String(e.id)
      if (!ids.has(id)) continue
      trains = true
      const top = bestWeight(e, assisted(id))
      const leads = beatsWeight(top, best.get(id) ?? 0, assisted(id))
      if (leads) best.set(id, top)
      if (leads && (w === moved || had.includes(id))) kept.push(id)
    }
    if (!trains) return w
    const prs = [...new Set([...had.filter((id) => !ids.has(id)), ...kept])]
    if (prs.length === had.length && prs.every((id, i) => id === had[i])) return w
    return { ...w, prs }
  })
}

/**
 * The remembered working weight (`exWeights`) is lowered only when it came
 * from this workout and the change took that load away; it then falls back
 * to the best left in history, or is removed. `after` is null for a delete.
 */
export function lowerKeptWeights(state: State, ids: Iterable<string>, before: Entry, after: Entry | null, assisted: AssistedCheck): void {
  const weights = mapOf(state, 'exWeights')
  for (const id of ids) {
    const kept = weights[id]
    const was = bestIn(before, id, assisted)
    if (!isRecord(kept) || !(Number(kept.w) > 0) || kept.w !== was || !beatsWeight(was, bestIn(after, id, assisted), assisted(id))) continue
    let best: { w: number; d: unknown } | null = null
    for (const w of Array.isArray(state.workouts) ? state.workouts.filter(isRecord) : []) {
      const top = bestIn(w, id, assisted)
      if (beatsWeight(top, best?.w ?? 0, assisted(id))) best = { w: top, d: w.d }
    }
    const map = writableMap(state, 'exWeights')
    if (best) map[id] = best
    else delete map[id]
  }
}

/** After a session finished today: remember a better working weight, as the app's finish does. */
export function raiseKeptWeights(state: State, workout: Entry, assisted: AssistedCheck): string[] {
  const raised: string[] = []
  for (const e of entriesOf(workout)) {
    const id = String(e.id)
    const top = bestWeight(e, assisted(id))
    const current = mapOf(state, 'exWeights')[id]
    if (top > 0 && beatsWeight(top, isRecord(current) ? Number(current.w) || 0 : 0, assisted(id))) {
      writableMap(state, 'exWeights')[id] = { w: top, d: workout.d }
      raised.push(id)
    }
  }
  return raised
}
