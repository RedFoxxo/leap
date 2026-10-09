import { z } from 'zod'
import { today, zoneOf } from '../../domain/dates.js'
import { routineName } from '../../domain/plan.js'
import {
  chooseFixedWeek,
  chooseRotation,
  DAY_NOTE_MAX,
  DAY_NOTE_TAGS,
  dayNoteOf,
  managedByApp,
  queueOf,
  queueUnusable,
  queueView,
  readDayNote,
  rotationIds,
  saveRotation,
  scheduleModeOf,
  startNewPass,
  startPass,
  stopPass,
  loopLabel,
  roundOut,
} from '../../domain/queue.js'
import { newId } from '../../state/ids.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, writableMap, type State } from '../../state/types.js'
import { invalid } from '../respond.js'
import { entryId, isoDate } from '../schema.js'
import { defineTool } from '../types.js'
import { change, LAST_CHANGE_NOTE } from '../write.js'

/**
 * The rotation (A → B → C …) and the session queue, written as the app's Plan
 * screen writes them (see domain/queue.ts). The app owns a round when it
 * carries the rotation's id; a queue without it is a planner's. A round's
 * `since` is the clock's time, as the app takes it; only the sync stamps use the
 * write's lifted stamp time.
 */

const ROUTINES = z.array(entryId).min(1).max(30)

const round = roundOut

const checkRoutines = (draft: State, ids: string[]) => {
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length) return `each routine can be in the rotation once (${[...new Set(dupes)].join(', ')} repeats)`
  const missing = ids.filter((id) => !listOf(draft, 'routines').some((r) => r.id === id))
  return missing.length ? `no routine with id ${missing.map((m) => `"${m}"`).join(', ')}; find ids with read_routines` : undefined
}

const PLANNER_NOTE =
  'A planner\'s queue (written by write_session_queue or another app) shows as "Externally managed" in the app: the app does not refill it, and the user can adopt it as their own rotation.'

export const writeRotation = defineTool({
  name: 'write_rotation',
  description:
    `Set the rotation: the routines trained in turn (A → B → C → A …), not tied to weekdays; the next session is the first one of the round not done yet, on whatever day is trained next. Switches the plan to rotation mode. Editing a running rotation keeps the round's progress (done is by routine since the round began), clears date pins of routines taken out, and starts the next round when the edit leaves the current one complete. When a round completes, logging its last workout starts the next round the day after. Weekday routines stay and count on top of the loop. ${PLANNER_NOTE} adopt: true takes such a queue over as the user's own rotation. ${LAST_CHANGE_NOTE}`,
  input: {
    routineIds: ROUTINES.describe('The routines in order, each once'),
    adopt: z.boolean().optional().describe("Take over a planner's queue that is running now (default false: refused)"),
  },
  async handler(args, ctx) {
    return change(
      ctx,
      'save the rotation',
      (draft, { now }) => {
        const problem = checkRoutines(draft, args.routineIds)
        if (problem) return refuse(problem)
        const day = today(ctx.now(), zoneOf(draft))
        const q = queueOf(draft)
        const planner = !!q && !managedByApp(draft, q)
        if (planner && !args.adopt) {
          return refuse(`a planner's queue${q.label ? ` ("${q.label}")` : ''} is running; adopt: true makes it the user's own rotation (the planner no longer controls it, and a later week it writes replaces the rotation)`)
        }
        // Adopting gives the loop no name of its own: the planner's week name belongs to that one round (Plan.jsx adopt).
        const label = planner ? '' : loopLabel(draft)
        const { swept, refilled } = saveRotation(draft, args.routineIds, label, () => newId('', now), day, ctx.now())
        draft.scheduleMode = 'rotation'
        return apply({ view: queueView(draft, day), swept, refilled, adopted: planner, names: namedRoutines(draft, args.routineIds) })
      },
      (r) => ({
        schedule: 'rotation',
        rotation: r.names,
        round: round(r.view),
        ...(r.adopted ? { adopted: true } : {}),
        ...(r.refilled ? { nextRoundStarted: true } : {}),
        ...(r.swept.length ? { clearedPins: r.swept.sort() } : {}),
      }),
      { verify: (s) => (JSON.stringify(rotationIds(s)) === JSON.stringify(args.routineIds) && managedByApp(s) ? [] : ['rotation']) },
    )
  },
})

export const writeScheduleMode = defineTool({
  name: 'write_schedule_mode',
  description:
    `How training is planned, as the app's "How you train" switch: "rotation" holds rotation mode and starts a round from the saved rotation when there is one (set the rotation with write_rotation); "week" goes back to fixed weekdays, which were never touched: the app's own round stops (its future date pins go) and the rotation stays saved for later. Choosing the mode the plan is already in changes nothing, so a running round keeps its progress. A planner's queue is not stopped by "week"; clear it with write_session_queue. ${LAST_CHANGE_NOTE}`,
  input: { mode: z.enum(['week', 'rotation']) },
  async handler(args, ctx) {
    return change(
      ctx,
      'save the schedule mode',
      (draft) => {
        const day = today(ctx.now(), zoneOf(draft))
        // As the app's switch: choosing the mode it is already in does nothing (Plan.jsx setMode).
        if (scheduleModeOf(draft) === args.mode) return apply({ started: false, stopped: false, plannerKept: false, view: queueView(draft, day), unusable: queueUnusable(draft), mode: args.mode })
        if (args.mode === 'rotation') {
          const started = chooseRotation(draft, day, ctx.now())
          return apply({ started, stopped: false, plannerKept: false, view: queueView(draft, day), unusable: queueUnusable(draft), mode: scheduleModeOf(draft) })
        }
        const before = queueOf(draft)
        const { stopped } = chooseFixedWeek(draft, day)
        return apply({ started: false, stopped, plannerKept: !!before && !stopped, view: queueView(draft, day), unusable: false, mode: scheduleModeOf(draft) })
      },
      (r) => ({
        schedule: r.mode,
        ...(r.started ? { roundStarted: true } : {}),
        ...(r.stopped ? { roundStopped: true } : {}),
        ...(r.view ? { round: round(r.view) } : {}),
        ...(r.mode === 'rotation' && !r.view && !r.unusable ? { note: 'No round is running: set the rotation with write_rotation, or start it with write_rotation_round' } : {}),
        ...(r.unusable ? { note: 'A stored round has no routines left; clear it with write_session_queue (null) before starting a new one' } : {}),
        ...(r.plannerKept ? { note: "A planner's queue is still running, so the plan stays in rotation mode; clear it with write_session_queue (null)" } : {}),
      }),
      { verify: (s, r) => (scheduleModeOf(s) === r.mode ? [] : ['scheduleMode']) },
    )
  },
})

export const writeRotationRound = defineTool({
  name: 'write_rotation_round',
  description:
    `Control the round of the app's own rotation: "start" begins a round from the saved rotation when none is running; "restart" starts the loop over from its first routine today, and nothing logged before now counts for it; "stop" ends the round and keeps the rotation saved (rotation mode stays selected; write_schedule_mode "week" goes back to weekdays). The round's future date pins are cleared when it is replaced or stopped. ${LAST_CHANGE_NOTE}`,
  input: { action: z.enum(['start', 'restart', 'stop']) },
  async handler(args, ctx) {
    return change(
      ctx,
      'change the round',
      (draft) => {
        const day = today(ctx.now(), zoneOf(draft))
        const q = queueOf(draft)
        if (q && !managedByApp(draft, q)) return refuse("the running queue is a planner's, not the app's rotation; write_rotation with adopt: true takes it over, write_session_queue changes or clears it")
        if (args.action === 'stop') {
          if (!q) return refuse('no round is running')
          stopPass(draft, day)
          return apply(null)
        }
        if (queueUnusable(draft)) return refuse('a stored round has no routines left; clear it first (write_schedule_mode "week", or write_session_queue null for a planner\'s queue)')
        if (!rotationIds(draft).length) return refuse('there is no saved rotation; set one with write_rotation')
        if (args.action === 'start') {
          if (q) return refuse('a round is already running; restart starts it over')
          startPass(draft, day, ctx.now())
        } else startNewPass(draft, day, ctx.now())
        draft.scheduleMode = 'rotation'
        return apply(queueView(draft, day))
      },
      (v) => ({ action: args.action, round: round(v) }),
      { verify: (s) => ((args.action === 'stop') === (s.queue == null) ? [] : ['queue']) },
    )
  },
})

export const writeSessionQueue = defineTool({
  name: 'write_session_queue',
  description:
    `Act as a planner: write the sessions of a coming week as a queue (the routines in order; the first one not done yet is the session of whatever day is trained next), or clear the queue with routineIds null. ${PLANNER_NOTE} It replaces whatever round is running, the app's own rotation included (the saved rotation stays). A session counts as done when a workout of its routine starts after the queue was written, or is dated from startsOn on and named after the routine (unless strict). Use write_rotation instead for the user's own rotation. ${LAST_CHANGE_NOTE}`,
  input: {
    routineIds: ROUTINES.nullable().describe('The sessions in order, each routine once; null clears the queue'),
    label: z.string().trim().max(60).optional().describe('Shown on Home, e.g. "Week 3"'),
    startsOn: isoDate.optional().describe('The day the queue begins (default today); until then it waits'),
    strict: z.boolean().optional().describe('Count only workouts started after the queue was written'),
  },
  async handler(args, ctx) {
    if (args.routineIds === null && (args.label !== undefined || args.startsOn !== undefined || args.strict !== undefined)) return invalid('clearing the queue takes no label, startsOn or strict')
    return change(
      ctx,
      args.routineIds ? 'write the queue' : 'clear the queue',
      (draft) => {
        const day = today(ctx.now(), zoneOf(draft))
        if (args.routineIds === null) {
          if (draft.queue == null) return refuse('there is no queue to clear')
          stopPass(draft, day)
          if (draft.scheduleMode === 'rotation' && !rotationIds(draft).length) draft.scheduleMode = 'week'
          return apply({ view: null, mode: scheduleModeOf(draft) })
        }
        const problem = checkRoutines(draft, args.routineIds)
        if (problem) return refuse(problem)
        const old = queueOf(draft)
        if (old) stopPass(draft, day)
        draft.queue = { ids: args.routineIds, since: ctx.now(), startsOn: args.startsOn ?? day, label: args.label ?? '', ...(args.strict ? { strict: true } : {}) }
        return apply({ view: queueView(draft, day), mode: scheduleModeOf(draft) })
      },
      (r) => ({ schedule: r.mode, queue: round(r.view) }),
      { verify: (s) => (args.routineIds === null ? (s.queue == null ? [] : ['queue']) : JSON.stringify(queueOf(s)?.ids) === JSON.stringify(args.routineIds) ? [] : ['queue']) },
    )
  },
})

export const writeDayNote = defineTool({
  name: 'write_day_note',
  description:
    `Note why a day had no training (sick, travel, rest, injured, and/or a line of text), today or earlier; a day with a note is excused: the missed-workout nudge and the workout-day reminder leave it alone, and the app shows the note in its calendar. A field left out keeps what the note has; null removes it, and a note with no tag and no text is removed. The app offers a new note only on a day without a workout; leap allows it and says so. ${LAST_CHANGE_NOTE}`,
  input: {
    date: isoDate,
    tag: z.enum(DAY_NOTE_TAGS).nullable().optional(),
    text: z.string().max(DAY_NOTE_MAX).nullable().optional(),
  },
  async handler(args, ctx) {
    if (args.date > today(ctx.now(), await ctx.store.zone())) return invalid(`${args.date} is in the future; only today and earlier days take a note`)
    if (args.tag === undefined && args.text === undefined) return invalid('give a tag or a text (null removes one)')
    return change(
      ctx,
      'save the day note',
      (draft, { now }) => {
        const notes = writableMap(draft, 'dayNotes')
        const previous = dayNoteOf(draft, args.date)
        const tag = args.tag === undefined ? previous?.tag : (args.tag ?? undefined)
        const text = args.text === undefined ? previous?.text : args.text?.trim() || undefined
        const note = tag || text ? { ...(tag ? { tag } : {}), ...(text ? { text } : {}) } : null
        if (!previous && !note) return refuse(`there is no note on ${args.date} to remove`)
        // A cleared note is a stamped empty entry, never a deleted key: another device would bring the key back.
        // An unchanged note is not stamped again: a fresh stamp would outrank an unsynced edit elsewhere.
        if (JSON.stringify(previous) !== JSON.stringify(note)) notes[args.date] = { ...(note ?? {}), _ts: now }
        const trained = listOf(draft, 'workouts').some((w) => w.d === args.date)
        return apply({ previous, note, trained })
      },
      (r) => ({
        date: args.date,
        note: r.note,
        ...(r.previous ? { previous: r.previous } : {}),
        ...(r.trained && r.note ? { warning: 'a workout is logged on this day; the app itself only offers a note on a day without training' } : {}),
      }),
      {
        verify: (s, r) => {
          const stored = readDayNote(isRecord(s.dayNotes) ? s.dayNotes[args.date] : undefined)
          return JSON.stringify(stored) === JSON.stringify(r.note) ? [] : [`dayNotes ${args.date}`]
        },
      },
    )
  },
})

/** Names for a list of routine ids, for outputs. */
const namedRoutines = (state: State, ids: string[]) => ids.map((id) => ({ id, name: routineName(state, id) }))

export const rotationWriteTools = [writeRotation, writeScheduleMode, writeRotationRound, writeSessionQueue, writeDayNote]
