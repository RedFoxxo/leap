import { describe, expect, it } from 'vitest'
import { ExerciseIndex } from '../src/catalog/exercises.js'
import { beatsWeight, bestSet, estimate1RM, exerciseSessions, muscleLoads, muscleName } from '../src/domain/stats.js'
import { fixtureCatalog } from './fixtures/exercises.js'
import { profile } from './fixtures/profile.js'

const index = (state: Record<string, unknown>) => new ExerciseIndex(fixtureCatalog(), state)
const workout = (id: string, d: string, sets: Record<string, unknown>[], ex = '0025') => ({ id, d, start: 1, entries: [{ id: ex, sets }] })

describe('estimate1RM', () => {
  it('follows openGym’s rules', () => {
    expect(estimate1RM(100, 5)).toBe(116.7)
    expect(estimate1RM(100, 1)).toBe(100)
    expect(estimate1RM(100, 12)).toBe(140)
    expect(estimate1RM(100, 13)).toBeNull()
    expect(estimate1RM(0, 5)).toBeNull()
    expect(estimate1RM(100, 0)).toBeNull()
    expect(estimate1RM(100, 5, 'brzycki')).toBe(112.5)
    expect(estimate1RM(100, 5, 'lombardi')).toBe(117.5)
  })
})

describe('bestSet', () => {
  it('takes completed reps work sets only, each done side on its own', () => {
    const entry = {
      sets: [
        { w: 200, r: 3, done: true, phase: 'warmup' },
        { w: 100, r: 5, done: true },
        { w: 120, r: 5, done: false },
        { sec: 60, w: 300, done: true },
        { w: 50, r: 20, done: false, sides: { L: { w: 110, r: 4, done: true }, R: { w: 130, r: 4, done: false } } },
      ],
    }
    expect(bestSet(entry)).toEqual({ estimate: 124.7, w: 110, r: 4 })
    expect(bestSet(entry, 'epley', true)).toBeNull()
  })
})

describe('records', () => {
  it('counts the first load as a record and later ones only when they beat it', () => {
    const state = {
      workouts: [
        workout('a', '2026-01-01', [{ w: 100, r: 5, done: true }]),
        workout('b', '2026-01-08', [{ w: 100, r: 8, done: true }]),
        workout('c', '2026-01-15', [{ w: 105, r: 3, done: true }]),
        workout('d', '2026-01-22', [{ w: 0, r: 5, done: false }]),
      ],
    }
    const s = exerciseSessions(state, '0025', index(state))
    expect(s.map((x) => [x.workoutId, x.weightRecord, x.estimateRecord])).toEqual([
      ['a', true, true],
      ['b', false, true],
      ['c', true, false],
    ])
  })

  it('treats less help as better on assistance machines', () => {
    expect(beatsWeight(30, 40, true)).toBe(true)
    expect(beatsWeight(50, 40, true)).toBe(false)
    expect(beatsWeight(40, 0, true)).toBe(true)
    expect(beatsWeight(0, 0)).toBe(false)
  })

  it('describes the sessions of every set kind', () => {
    const state = profile()
    const [legs] = exerciseSessions(state, '0043', index(state))
    expect(legs).toEqual({
      workoutId: 'w-legs',
      date: '2026-09-30',
      name: 'Leg Day',
      sets: ['100×5', '100×5 → 80×6 → 60×8', '100×12 (rest-pause)'],
      workSets: 3,
      reps: 22,
      volume: 3160,
      bestWeight: 100,
      best1RM: { estimate: 140, w: 100, r: 12 },
      weightRecord: true,
      estimateRecord: true,
    })
    const [curl] = exerciseSessions(state, '0294', index(state))
    expect(curl!.sets).toEqual(['L 14×10 / R 14×10', 'L 16×10 / R 14×8'])
  })
})

describe('muscle balance', () => {
  it('weights target muscles 1 and secondary ones 0.4, maps synonyms and levels against the top', () => {
    const state = profile()
    const { loads, unknownExercises } = muscleLoads(state.workouts as Record<string, unknown>[], index(state))
    expect(loads).toEqual([
      { muscle: 'biceps', sets: 3, primarySets: 3, level: 4 },
      { muscle: 'glutes', sets: 3, primarySets: 3, level: 4 },
      { muscle: 'pectorals', sets: 2, primarySets: 2, level: 3 },
      { muscle: 'forearms', sets: 1.2, primarySets: 0, level: 2 },
      { muscle: 'hamstrings', sets: 1.2, primarySets: 0, level: 2 },
      { muscle: 'quads', sets: 1.2, primarySets: 0, level: 2 },
      { muscle: 'abs', sets: 1, primarySets: 1, level: 2 },
      { muscle: 'delts', sets: 0.8, primarySets: 0, level: 2 },
      { muscle: 'triceps', sets: 0.8, primarySets: 0, level: 2 },
    ])
    expect(unknownExercises).toEqual(['9001'])
    expect(muscleName('Shoulders')).toBe('delts')
    expect(['gluteal', 'deltoids', 'upper-back', 'hamstring', 'tibialis'].map(muscleName)).toEqual(['glutes', 'delts', 'upper back', 'hamstrings', 'shins'])
  })
})
