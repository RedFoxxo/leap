import { describe, expect, it } from 'vitest'
import { addDays, isValidIsoDate, localDateTime, weekdayOf } from '../src/domain/dates.js'
import { planFor, weekdayRoutineIds } from '../src/domain/plan.js'
import {
  bestWeight,
  completedReps,
  completedVolume,
  describeSet,
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
    expect(isWarmup({ phase: 'work', warmup: true })).toBe(false)
    expect(isWarmup({ warmup: true })).toBe(true)
  })

  it('tells reps, timed and cardio rows apart', () => {
    expect(setMode({ w: 1, r: 1 })).toBe('reps')
    expect(setMode({ sec: 60, w: 10 })).toBe('time')
    expect(setMode({ min: 20, speed: 9.5 })).toBe('cardio')
  })

  it('describes a row with its kind', () => {
    expect(describeSet({ w: 60, r: 5, done: true, phase: 'warmup', weightOrigin: 'manual' }, 0)).toEqual({ n: 1, kind: 'warmup', w: 60, r: 5, done: true })
    expect(describeSet({ min: 20, speed: 9.5 }, 2)).toEqual({ n: 3, mode: 'cardio', min: 20, speed: 9.5, done: false })
  })

  it('finds the best completed working weight, the least help on assistance machines', () => {
    const entry = { sets: [{ w: 200, r: 5, done: true, phase: 'warmup' }, { w: 100, r: 5, done: true }, { w: 120, r: 1, done: false }] }
    expect(bestWeight(entry)).toBe(100)
    expect(bestWeight({ sets: [{ w: 0, r: 8, done: true }, { w: 30, r: 8, done: true }, { w: 20, r: 6, done: true }] }, true)).toBe(20)
    expect(bestWeight({ sets: [{ w: 0, r: 10, done: true }] })).toBe(0)
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
    expect(planFor(profile(), '2026-10-09')).toEqual({ routineIds: [], override: 'rest' })
    expect(planFor(profile(), '2026-10-11')).toEqual({ routineIds: [PULL], override: 'routine' })
    expect(planFor(profile(), '2026-10-12')).toEqual({ routineIds: [PUSH] })
    expect(planFor({ ...profile(), routines: [] }, '2026-10-12')).toEqual({ routineIds: [] })
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
})
