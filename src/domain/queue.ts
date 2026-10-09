import { isRecord, listOf, mapOf, type Entry, type State } from '../state/types.js'
import { addDays, isoDate } from './dates.js'
import { routineIdsOf } from './sets.js'

/**
 * The rotation and the session queue (openGym 1.3.10 and later). Ported from
 * openGym `frontend/src/lib/queue.js` and `frontend/src/lib/rotation.js` at
 * v1.4.0 (28b7e4dc); see docs/OPENGYM.md, "Rotation and the session queue".
 *
 *   queue    = null | { ids, since, startsOn, label, strict?, rotationId? }  the live pass
 *   rotation = null | { id, sequence, label }                               the saved loop
 *   scheduleMode = null | "week" | "rotation"
 *
 * A pass belongs to the app when `queue.rotationId === rotation.id`; a queue
 * without it is a planner's ("Externally managed") and the app never rewrites it.
 * A session is done when a finished workout on its routine started at or after
 * `since`, or (unless strict) is dated on or after `startsOn` and is named after
 * the routine. A `dayPlan` entry naming a queue routine is a pin.
 */

export interface Queue {
  ids: string[]
  /** As stored: a queue without it counts no workout by start time (the app compares with undefined). */
  since: number | undefined
  startsOn: string
  label: string
  strict?: boolean
  rotationId?: string
}

const routinesOf = (state: State | null) => listOf(state, 'routines')
const nameParts = (w: Entry) => String(w.name ?? '').split(' + ')

/** The live queue read tolerantly: unknown routines and repeats dropped; null when nothing usable is left. */
export function queueOf(state: State | null): Queue | null {
  const q = state?.queue
  if (!isRecord(q) || !Array.isArray(q.ids)) return null
  const routines = routinesOf(state)
  const raw: unknown[] = q.ids
  const ids = raw.filter((id, i): id is string => typeof id === 'string' && raw.indexOf(id) === i && routines.some((r) => r.id === id))
  if (!ids.length) return null
  return {
    ...(q as object),
    ids,
    since: q.since as number | undefined,
    label: typeof q.label === 'string' ? q.label : '',
    startsOn: typeof q.startsOn === 'string' ? q.startsOn : isoDate(new Date(Number(q.since) || 0)),
  } as Queue
}

/** A queue is stored but unusable (malformed, every routine deleted): the app offers to discard it. */
export const queueUnusable = (state: State | null) => state?.queue != null && !queueOf(state)

/** Whether the live queue is the app's own rotation pass (else a planner's, or none). */
export function managedByApp(state: State | null, q = queueOf(state)): boolean {
  const rotation = state?.rotation
  return !!q && typeof q.rotationId === 'string' && isRecord(rotation) && q.rotationId === rotation.id
}

/** "rotation" while a usable queue exists or once chosen with nothing built yet; else "week". */
export const scheduleModeOf = (state: State | null): 'week' | 'rotation' => (queueOf(state) || state?.scheduleMode === 'rotation' ? 'rotation' : 'week')

/** The saved loop's routines that still exist, first occurrence of each: the ids a new pass gets. */
export function rotationIds(state: State | null): string[] {
  const rotation = state?.rotation
  const seq = isRecord(rotation) && Array.isArray(rotation.sequence) ? rotation.sequence : []
  const routines = routinesOf(state)
  return seq.filter((id, i): id is string => typeof id === 'string' && seq.indexOf(id) === i && routines.some((r) => r.id === id))
}

/** The DONE RULE for one workout and one session. */
function countsFor(state: State | null, q: Queue, w: Entry, id: string): boolean {
  if (!routineIdsOf(w).includes(id)) return false
  // As the app: `(start ?? 0) >= since`, which is false when since is missing.
  if (((w.start ?? 0) as number) >= (q.since as number)) return true
  const name = routinesOf(state).find((r) => r.id === id)?.name
  return q.strict !== true && String(w.d ?? '') >= q.startsOn && typeof name === 'string' && nameParts(w).includes(name)
}

const isDone = (state: State | null, q: Queue, id: string) => listOf(state, 'workouts').some((w) => countsFor(state, q, w, id))

/** The sessions still to do, in slot order. */
export function queueRemaining(state: State | null): string[] {
  const q = queueOf(state)
  return q ? q.ids.filter((id) => !isDone(state, q, id)) : []
}

/** The routines of a pass a workout credits. */
export function creditedBy(state: State | null, w: Entry): string[] {
  const q = queueOf(state)
  return q ? q.ids.filter((id) => countsFor(state, q, w, id)) : []
}

/** The one date the queue answers for: today, or its start while that is still ahead. */
const answerDay = (q: Queue, today: string) => (today > q.startsOn ? today : q.startsOn)

function activePins(state: State | null, remaining: string[], today: string): { iso: string; id: string }[] {
  return Object.entries(mapOf(state, 'dayPlan'))
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[0] >= today && remaining.includes(e[1]))
    .map(([iso, id]) => ({ iso, id }))
}

function nextOn(state: State | null, remaining: string[], on: string, today: string): string | null {
  const pins = activePins(state, remaining, today)
  const here = pins.find((p) => p.iso === on)
  if (here) return here.id
  return remaining.find((id) => !pins.some((p) => p.id === id)) ?? null
}

/** The queue's session for a date: only on the day it answers for, else null. */
export function queueNext(state: State | null, iso: string, today: string): string | null {
  const q = queueOf(state)
  if (!q || iso !== answerDay(q, today)) return null
  return nextOn(state, queueRemaining(state), iso, today)
}

/** Whether `iso` is the queue's day with sessions still to do (its own weekday pointers stay hidden then). */
function queueLiveOn(state: State | null, iso: string, today: string): boolean {
  const q = queueOf(state)
  return !!q && iso === answerDay(q, today) && queueRemaining(state).length > 0
}

/** What a date override naming `id` means for the queue: an open pin, a fulfilled one, or nothing to do with it. */
export function pinState(state: State | null, id: unknown): 'open' | 'done' | null {
  const q = queueOf(state)
  if (!q || typeof id !== 'string' || !q.ids.includes(id)) return null
  return isDone(state, q, id) ? 'done' : 'open'
}

export type PlannedBy = 'rest-override' | 'override' | 'pin' | 'rotation' | 'queue' | 'weekday' | 'rest'

/**
 * The routines planned on a date, as the app decides them (openGym `history.js`
 * effectiveRoutineIds, v1.4.0): a "rest" override is rest; an override naming a
 * routine outside the queue is that routine; otherwise the queue's session for
 * the day (an open pin, or the next one on the day the queue answers for)
 * comes first, with the weekday's own routines outside the queue riding along.
 */
export function effectivePlan(state: State | null, iso: string, today: string): { routineIds: string[]; plannedBy: PlannedBy } {
  const routines = routinesOf(state)
  const exists = (id: unknown): id is string => typeof id === 'string' && routines.some((r) => r.id === id)
  const ov = mapOf(state, 'dayPlan')[iso]
  if (ov === 'rest') return { routineIds: [], plannedBy: 'rest-override' }
  const pin = pinState(state, ov)
  if (!pin && exists(ov)) return { routineIds: [ov], plannedBy: 'override' }
  const raw = mapOf(state, 'week')[String(new Date(`${iso}T12:00:00`).getDay())]
  const weekday = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).filter(exists)
  const q = pin === 'open' ? (ov as string) : queueNext(state, iso, today)
  const queueIds = isRecord(state?.queue) && Array.isArray(state.queue.ids) ? state.queue.ids : []
  const own = q || queueLiveOn(state, iso, today) ? weekday.filter((id) => !queueIds.includes(id)) : weekday
  if (q) return { routineIds: [q, ...own], plannedBy: pin === 'open' ? 'pin' : managedByApp(state) ? 'rotation' : 'queue' }
  return { routineIds: own, plannedBy: own.length ? 'weekday' : 'rest' }
}

export interface QueueView {
  label: string
  managedBy: 'app' | 'planner'
  startsOn: string
  waiting: boolean
  complete: boolean
  strict?: boolean
  done: number
  total: number
  sessions: { id: string; name: string; state: 'done' | 'next' | 'pinned' | 'later'; pinnedTo?: string }[]
}

/** The pass as Home shows it: each session done, next, pinned to a day or later. Null without a queue. */
export function queueView(state: State | null, today: string): QueueView | null {
  const q = queueOf(state)
  if (!q) return null
  const remaining = queueRemaining(state)
  const on = answerDay(q, today)
  const next = nextOn(state, remaining, on, today)
  const pins = activePins(state, remaining, today).sort((a, b) => a.iso.localeCompare(b.iso))
  const nameOf = (id: string) => {
    const n = routinesOf(state).find((r) => r.id === id)?.name
    return typeof n === 'string' && n ? n : id
  }
  return {
    label: q.label,
    managedBy: managedByApp(state, q) ? 'app' : 'planner',
    startsOn: q.startsOn,
    waiting: today < q.startsOn,
    complete: remaining.length === 0,
    ...(q.strict === true ? { strict: true } : {}),
    done: q.ids.length - remaining.length,
    total: q.ids.length,
    sessions: q.ids.map((id) => {
      const pin = id !== next ? pins.find((p) => p.id === id && p.iso !== on) : undefined
      const state_ = !remaining.includes(id) ? 'done' : id === next ? 'next' : pin ? 'pinned' : 'later'
      return { id, name: nameOf(id), state: state_, ...(pin ? { pinnedTo: pin.iso } : {}) }
    }),
  }
}

// ---- writing passes (rotation.js) ----

const dayAfter = (iso: string) => addDays(iso, 1)

/** Workouts that could have credited `q`'s pass: dated on or after its start, on one of its routines. */
const creditWindow = (state: State, q: Queue) => listOf(state, 'workouts').filter((w) => String(w.d ?? '') >= q.startsOn && routineIdsOf(w).some((id) => q.ids.includes(id)))

/** `now`, or later when a workout of the old pass would otherwise also credit the new one. */
const sinceAfter = (state: State, q: Queue, now: number) => Math.max(now, ...creditWindow(state, q).map((w) => (Number(w.start) || 0) + 1))

const lastCreditDay = (state: State): string | null => {
  const q = queueOf(state)
  if (!q) return null
  const days = creditWindow(state, q).map((w) => String(w.d))
  return days.length ? days.sort().at(-1)! : null
}

/** Clears pins dated today or later that name one of `ids`: the pass no longer owns them. Returns the dates cleared. */
function sweepPins(state: State, ids: string[], today: string): string[] {
  const plan = state.dayPlan
  if (!ids.length || !isRecord(plan)) return []
  const swept = Object.keys(plan).filter((iso) => iso >= today && ids.includes(plan[iso] as string))
  for (const iso of swept) delete plan[iso]
  return swept
}

const newPass = (ids: string[], label: string, rotationId: string, startsOn: string, since: number): Queue => ({ ids, since, startsOn, label, rotationId })

const rotationLabel = (state: State) => (isRecord(state.rotation) && typeof state.rotation.label === 'string' ? state.rotation.label : '')

/** Starts a pass from the saved loop. False when nothing valid is left to start. */
export function startPass(state: State, today: string, now: number): boolean {
  const ids = rotationIds(state)
  if (!ids.length || !isRecord(state.rotation)) return false
  state.queue = newPass(ids, rotationLabel(state), String(state.rotation.id), today, now)
  return true
}

/**
 * Creates, edits or adopts the loop (Plan's editor save): the running pass keeps
 * its start, so progress survives a reorder; pins of sessions taken out are
 * cleared; an edit that leaves the pass complete starts the next one.
 */
export function saveRotation(state: State, ids: string[], newId: () => string, today: string, now: number): { swept: string[]; refilled: boolean } {
  const prev = queueOf(state)
  const label = isRecord(state.rotation) && typeof state.rotation.label === 'string' ? state.rotation.label : ''
  const id = isRecord(state.rotation) && typeof state.rotation.id === 'string' ? state.rotation.id : newId()
  state.rotation = { ...(isRecord(state.rotation) ? state.rotation : {}), id, sequence: ids, label }
  state.queue = { ids, since: prev?.since ?? now, startsOn: prev?.startsOn ?? today, label, rotationId: id, ...(prev?.strict === true ? { strict: true } : {}) }
  const swept = sweepPins(state, (prev?.ids ?? []).filter((x) => !ids.includes(x)), today)
  let refilled = false
  if (prev && ids.every((x) => prev.ids.includes(x)) && queueView(state, today)?.complete) {
    const q = queueOf(state)!
    const last = lastCreditDay(state)
    swept.push(...sweepPins(state, q.ids, today))
    state.queue = newPass(rotationIds(state), label, id, last ? dayAfter(last) : today, sinceAfter(state, q, now))
    refilled = true
  }
  return { swept, refilled }
}

/** Ends the current pass, keeping the saved loop; its future pins go with it. */
export function stopPass(state: State, today: string): string[] {
  const q = queueOf(state)
  const swept = q ? sweepPins(state, q.ids, today) : []
  state.queue = null
  return swept
}

/** "How you train: Rotation": holds Rotation selected and starts a pass from the saved loop when there is one. */
export function chooseRotation(state: State, today: string, now: number): boolean {
  state.scheduleMode = 'rotation'
  if (queueUnusable(state) || !rotationIds(state).length) return false
  return startPass(state, today, now)
}

/** "How you train: Fixed week": stops the app's own pass; a planner's queue is not the app's to drop. */
export function chooseFixedWeek(state: State, today: string): { stopped: boolean } {
  const q = queueOf(state)
  const external = !!q && !managedByApp(state, q)
  if (!external) stopPass(state, today)
  state.scheduleMode = 'week'
  return { stopped: !external && !!q }
}

/** "Start the loop over": a new strict pass from today; nothing logged before now counts for it. */
export function startNewPass(state: State, today: string, now: number): boolean {
  if (!isRecord(state.rotation)) return false
  const ids = rotationIds(state)
  if (!ids.length) return false
  const q = queueOf(state)
  if (q) sweepPins(state, q.ids, today)
  const since = q ? sinceAfter(state, q, now) : now
  state.queue = { ...newPass(ids, rotationLabel(state), String(state.rotation.id), today, since), strict: true }
  return true
}

const isCircular = (ids: string[], seq: string[]) => {
  if (!ids.length || ids.length !== seq.length) return false
  const i = seq.indexOf(ids[0]!)
  return i >= 0 && ids.every((id, n) => seq[(i + n) % seq.length] === id)
}

const rotate = (seq: string[], afterId: string | null) => {
  const i = afterId === null ? -1 : seq.indexOf(afterId)
  return i < 0 ? seq : [...seq.slice(i + 1), ...seq.slice(0, i + 1)]
}

/**
 * After a finished workout is in the document: replaces a complete pass the app
 * manages with the next one, starting the day after, rotated to begin after the
 * last session this workout credited. Returns the new pass, or null.
 */
export function refillAfter(state: State, w: Entry, today: string, now: number): Queue | null {
  const q = queueOf(state)
  if (!q || !managedByApp(state, q)) return null
  if (!queueView(state, today)?.complete) return null
  const seq = rotationIds(state)
  if (!isCircular(q.ids, seq)) return null
  const credited = routineIdsOf(w)
  const last = q.ids.filter((id) => credited.includes(id)).at(-1) ?? null
  const bound = [String(w.d), lastCreditDay(state)].filter((d): d is string => !!d).sort().at(-1)!
  sweepPins(state, q.ids, today)
  const next = newPass(rotate(seq, last), rotationLabel(state), q.rotationId!, dayAfter(bound), sinceAfter(state, q, now))
  state.queue = next
  return next
}

// ---- missed-day notes (day-notes.js) ----

export const DAY_NOTE_TAGS = ['sick', 'travel', 'rest', 'injured'] as const
export type DayNoteTag = (typeof DAY_NOTE_TAGS)[number]
export const DAY_NOTE_MAX = 500

/** A stored note read back, or null for none or a cleared one. */
export function readDayNote(entry: unknown): { tag?: DayNoteTag; text?: string } | null {
  if (!isRecord(entry)) return null
  const tag = (DAY_NOTE_TAGS as readonly unknown[]).includes(entry.tag) ? (entry.tag as DayNoteTag) : undefined
  const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, DAY_NOTE_MAX) : ''
  return tag || text ? { ...(tag ? { tag } : {}), ...(text ? { text } : {}) } : null
}

export const dayNoteOf = (state: State | null, iso: string) => readDayNote(mapOf(state, 'dayNotes')[iso])
