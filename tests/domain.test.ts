import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addDays, dayOf, instantAt, isValidIsoDate, localDateTime, today, weekdayOf, zoneOf } from '../src/domain/dates.js'
import { planFor, weekdayRoutineIds } from '../src/domain/plan.js'
import {
  bestWeight,
  completedReps,
  completedVolume,
  entryRoutineId,
  isWarmup,
  setMode,
  workoutVolume,
} from '../src/domain/sets.js'
import { LEGS, profile, PULL, PUSH } from './fixtures/profile.js'

const workouts = () => profile().workouts as Record<string, any>[]

describe('volume', () => {
  it('matches the stored volume of every fixture workout', () => {
    for (const w of workouts()) expect(workoutVolume(w), String(w.id)).toBe(w.vol)
  })

  it('adds drops, but not rest-pause clusters (r is already the total)', () => {
    expect(completedVolume({ w: 100, r: 5, done: true, type: 'dropset', drops: [{ w: 80, r: 6 }] })).toBe(980)
    expect(completedVolume({ w: 100, r: 12, done: true, type: 'restpause', clusters: [{ r: 3 }, { r: 2 }] })).toBe(1200)
    expect(completedVolume({ w: 100, r: 5, done: true, drops: [{ w: 80, r: 6 }] })).toBe(500)
  })

  it('counts each completed side at its own weight', () => {
    const row = { w: 16, r: 18, done: false, sides: { L: { w: 16, r: 10, done: true }, R: { w: 14, r: 8, done: false } } }
    expect(completedVolume(row)).toBe(160)
    expect(completedReps(row)).toBe(10)
  })

  it('ignores undone rows and reads numeric strings from imports', () => {
    expect(completedVolume({ w: 100, r: 5, done: false })).toBe(0)
    expect(completedVolume({ w: '20', r: '10', done: true })).toBe(200)
  })
})

describe('set rows', () => {
  it('reads warm-ups from phase, then the legacy flag', () => {
    expect(isWarmup({ phase: 'warmup' })).toBe(true)
    expect(isWarmup({ phase: 'Warm-up' })).toBe(true)
    expect(isWarmup({ phase: 'warm_up' })).toBe(true)
    expect(isWarmup({ phase: 'work', warmup: true })).toBe(false)
    expect(isWarmup({ warmup: true })).toBe(true)
  })

  it('tells reps, timed and cardio rows apart', () => {
    expect(setMode({ w: 1, r: 1 })).toBe('reps')
    expect(setMode({ sec: 60, w: 10 })).toBe('time')
    expect(setMode({ min: 20, speed: 9.5 })).toBe('cardio')
  })

  it('reads a row’s mode as the app does: the row’s own, then the target’s, then the row’s fields', () => {
    expect(setMode({ w: 1, r: 1, unit: 'sec' })).toBe('time')
    expect(setMode({ durationSec: 30 })).toBe('time')
    expect(setMode({ sec: 30 }, { mode: 'reps' })).toBe('reps')
    expect(setMode({ w: 10, r: 5 }, { mode: 'time' })).toBe('time')
    expect(setMode({ mode: 'cardio', r: 5 }, { mode: 'reps' })).toBe('cardio')
    expect(setMode({ sec: 30 }, { id: 'x' })).toBe('time')
  })

  it('finds the best completed working weight, the least help on assistance machines', () => {
    const entry = { sets: [{ w: 200, r: 5, done: true, phase: 'warmup' }, { w: 100, r: 5, done: true }, { w: 120, r: 1, done: false }] }
    expect(bestWeight(entry)).toBe(100)
    expect(bestWeight({ sets: [{ w: 0, r: 8, done: true }, { w: 30, r: 8, done: true }, { w: 20, r: 6, done: true }] }, true)).toBe(20)
    expect(bestWeight({ sets: [{ w: 0, r: 10, done: true }] })).toBe(0)
  })

  it('reads the best weight from reps rows first, as the app does', () => {
    expect(bestWeight({ sets: [{ w: 100, r: 5, done: true }, { sec: 60, w: 140, done: true }] })).toBe(100)
    expect(bestWeight({ sets: [{ sec: 60, w: 20, done: true }, { sec: 45, w: 25, done: true }] })).toBe(25)
  })

  it('falls back to the stored topW when no row gives a usable weight', () => {
    expect(bestWeight({ sets: [{ r: 5, done: true }], topW: 80 })).toBe(80)
    expect(bestWeight({ sets: [], topW: 60 })).toBe(60)
    expect(bestWeight({ sets: [{ w: 0, r: 8, done: true }], topW: 30 }, true)).toBe(30)
    // A real row, even an unloaded one, wins; a warm-up or a timed row rules the fallback out.
    expect(bestWeight({ sets: [{ w: 0, r: 10, done: true }], topW: 80 })).toBe(0)
    expect(bestWeight({ sets: [{ w: 40, r: 5, done: true, phase: 'warmup' }, { r: 5, done: true }], topW: 80 })).toBe(0)
    expect(bestWeight({ sets: [{ sec: 30, done: true }], topW: 80 })).toBe(0)
  })

  it('reads an entry’s routine on combined days', () => {
    const [legs, push] = workouts()
    expect(entryRoutineId(push!, push!.entries[2])).toBe(LEGS)
    expect(entryRoutineId(legs!, legs!.entries[0])).toBe(LEGS)
    expect(entryRoutineId({ routineId: PUSH, entries: [{ id: 'a', rid: PUSH }, { id: 'b' }] }, { id: 'b' })).toBeNull()
  })
})

describe('plan', () => {
  it('reads weekday lists and legacy single ids', () => {
    expect(weekdayRoutineIds(profile(), 5)).toEqual([PUSH, LEGS])
    expect(weekdayRoutineIds(profile(), 3)).toEqual([LEGS])
    expect(weekdayRoutineIds(profile(), 0)).toEqual([])
  })

  it('lets a date override win and ignores deleted routines', () => {
    const today = '2026-10-07'
    expect(planFor(profile(), '2026-10-09', today)).toEqual({ routineIds: [], plannedBy: 'rest-override' })
    expect(planFor(profile(), '2026-10-11', today)).toEqual({ routineIds: [PULL], plannedBy: 'override' })
    expect(planFor(profile(), '2026-10-12', today)).toEqual({ routineIds: [PUSH], plannedBy: 'weekday' })
    expect(planFor({ ...profile(), routines: [] }, '2026-10-12', today)).toEqual({ routineIds: [], plannedBy: 'rest' })
  })
})

describe('dates', () => {
  it('validates calendar dates and steps across month ends', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false)
    expect(isValidIsoDate('2028-02-29')).toBe(true)
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
    expect(weekdayOf('2026-10-07')).toBe(3)
    expect(localDateTime(new Date('2026-10-05T18:07:00').getTime())).toBe('2026-10-05T18:07')
    expect(localDateTime(undefined)).toBeUndefined()
  })

  describe('in the profile’s time zone, whatever the machine’s', () => {
    const machine = process.env.TZ
    beforeEach(() => {
      process.env.TZ = 'UTC'
    })
    afterEach(() => {
      if (machine === undefined) delete process.env.TZ
      else process.env.TZ = machine
    })

    it('takes the zone from the reminder, and only a real one', () => {
      expect(zoneOf({ reminder: { tz: 'Europe/Warsaw' } })).toBe('Europe/Warsaw')
      expect(zoneOf({ reminder: { tz: 'Mars/Olympus' } })).toBeUndefined()
      expect(zoneOf({ reminder: { tz: null } })).toBeUndefined()
      expect(zoneOf(null)).toBeUndefined()
    })

    it('names the day and time of an instant there', () => {
      const t = Date.UTC(2026, 9, 7, 22, 30) // 00:30 on the 8th in Warsaw (CEST)
      expect(today(t)).toBe('2026-10-07')
      expect(today(t, 'Europe/Warsaw')).toBe('2026-10-08')
      expect(dayOf(t, 'Europe/Warsaw')).toBe('2026-10-08')
      expect(localDateTime(t, 'Europe/Warsaw')).toBe('2026-10-08T00:30')
      expect(localDateTime(t, 'America/New_York')).toBe('2026-10-07T18:30')
    })

    it('turns a wall time there into the instant, across daylight-saving changes', () => {
      expect(instantAt('2026-10-08', '00:30', 'Europe/Warsaw')).toBe(Date.UTC(2026, 9, 7, 22, 30))
      expect(instantAt('2026-12-01', '18:00', 'Europe/Warsaw')).toBe(Date.UTC(2026, 11, 1, 17, 0))
      expect(instantAt('2026-10-25', '12:00', 'Europe/Warsaw')).toBe(Date.UTC(2026, 9, 25, 11, 0))
      expect(instantAt('2026-10-08', '18:00')).toBe(Date.UTC(2026, 9, 8, 18, 0))
      // A time the clocks skip (02:30 on 29 March) lands on the hour after, as Date does.
      expect(localDateTime(instantAt('2026-03-29', '02:30', 'Europe/Warsaw'), 'Europe/Warsaw')).toBe('2026-03-29T03:30')
    })
  })
})
