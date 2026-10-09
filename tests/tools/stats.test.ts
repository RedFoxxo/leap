import { afterEach, describe, expect, it, vi } from 'vitest'
import { profile } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

async function setup(state: Record<string, unknown> = profile()) {
  return harness({ stub: new FakeOpenGym(state).stub })
}

afterEach(() => vi.useRealTimers())

describe('read_exercise_history', () => {
  it('lists sessions newest first with all-time bests', async () => {
    const state = profile()
    const workouts = state.workouts as Record<string, unknown>[]
    workouts.push({ id: 'w3', d: '2026-10-06', start: 3, entries: [{ id: '0043', sets: [{ w: 105, r: 3, done: true }] }], vol: 315 })
    const h = await setup(state)
    const r = await h.call('read_exercise_history', { exerciseId: '0043' })
    expect(r.json).toMatchObject({
      id: '0043',
      name: 'barbell full squat',
      unit: 'kg',
      formula: 'epley',
      sessionsTotal: 2,
      firstDone: '2026-09-30',
      lastDone: '2026-10-06',
      bestWeight: { weight: 105, date: '2026-10-06' },
      best1RM: { estimate: 140, weight: 100, reps: 12, date: '2026-09-30' },
      total: 2,
    })
    expect(r.json.sessions[0]).toEqual({
      date: '2026-10-06',
      workoutId: 'w3',
      sets: ['105×3'],
      workSets: 1,
      reps: 3,
      volume: 315,
      bestWeight: 105,
      best1RM: { estimate: 115.5, weight: 105, reps: 3 },
      weightRecord: true,
    })
    expect((await h.call('read_exercise_history', { exerciseId: '0043', formula: 'brzycki', limit: 1 })).json).toMatchObject({ truncated: true, formula: 'brzycki' })
    expect((await h.call('read_exercise_history', { exerciseId: 'zzz' })).isError).toBe(true)
    await h.close()
  })
})

describe('read_records', () => {
  it('lists the records of every logged exercise', async () => {
    const h = await setup()
    const r = await h.call('read_records', { sort: 'estimate' })
    expect(r.json.records[0]).toEqual({
      id: '0043',
      name: 'barbell full squat',
      sessions: 1,
      lastDone: '2026-09-30',
      bestWeight: { weight: 100, date: '2026-09-30' },
      best1RM: { estimate: 140, weight: 100, reps: 12, date: '2026-09-30' },
      lastRecord: '2026-09-30',
    })
    expect(r.json.records.map((x: { id: string }) => x.id)).toEqual(['0043', '0025', '0294', '9001', 'cplank'])
    const since = await h.call('read_records', { since: '2026-10-01', sort: 'name' })
    expect(since.json.records.map((x: { name: string }) => x.name)).toEqual(['barbell bench press', 'dumbbell biceps curl', 'Weighted plank'])
    await h.close()
  })
})

describe('read_training_summary', () => {
  it('totals per week from the profile’s first weekday', async () => {
    const h = await setup()
    const r = await h.call('read_training_summary', { from: '2026-09-28', to: '2026-10-11' })
    expect(r.json).toEqual({
      unit: 'kg',
      from: '2026-09-28',
      to: '2026-10-11',
      groupBy: 'week',
      total: { workouts: 2, minutes: 135, workSets: 10, reps: 67, volume: 4837.5 },
      periods: [
        { start: '2026-09-28', workouts: 1, minutes: 65, workSets: 4, reps: 22, volume: 3160 },
        { start: '2026-10-05', workouts: 1, minutes: 70, workSets: 6, reps: 45, volume: 1677.5 },
      ],
    })
    const months = await h.call('read_training_summary', { from: '2026-08-15', to: '2026-10-31', groupBy: 'month' })
    expect(months.json.periods.map((p: { start: string; workouts: number }) => [p.start, p.workouts])).toEqual([
      ['2026-08-01', 0],
      ['2026-09-01', 1],
      ['2026-10-01', 1],
    ])
    await h.close()
  })

  it('defaults to the last 12 weeks', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00'), toFake: ['Date'] })
    const h = await setup()
    const r = await h.call('read_training_summary')
    expect(r.json).toMatchObject({ from: '2026-07-16', to: '2026-10-07' })
    expect(r.json.periods).toHaveLength(13)
    await h.close()
  })
})

describe('read_muscle_balance', () => {
  it('ranks muscles and names what was not counted', async () => {
    const h = await setup()
    const r = await h.call('read_muscle_balance', { from: '2026-09-28', to: '2026-10-05' })
    expect(r.json.workouts).toBe(2)
    expect(r.json.muscles[0]).toEqual({ muscle: 'biceps', sets: 3, primarySets: 3, level: 4 })
    expect(r.json.untrained).toEqual([])
    expect(r.json.notCounted).toEqual(['9001'])
    const empty = await h.call('read_muscle_balance', { from: '2026-01-01', to: '2026-01-07' })
    expect(empty.json).toMatchObject({ workouts: 0, muscles: [], untrained: ['biceps', 'glutes', 'hamstrings', 'pectorals'] })
    await h.close()
  })
})
