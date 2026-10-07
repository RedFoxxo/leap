import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGS, profile, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

async function setup(state: Record<string, unknown> = profile()) {
  const fake = new FakeOpenGym(state, 40)
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  const doc = () => fake.state as Record<string, any>
  const workout = (id: string) => doc().workouts.find((w: { id: string }) => w.id === id)
  return { fake, h, doc, workout }
}

describe('write_log_workout', () => {
  it('logs today with every set kind, as the app stores it', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_log_workout', {
      routineIds: [LEGS],
      note: ' Heavy day ',
      entries: [
        {
          exerciseId: '0043',
          sets: [
            { weight: 60, reps: 5, warmup: true },
            { weight: 105, reps: 5, rir: 1 },
            { weight: 105, reps: 5, drops: [{ weight: 80, reps: 6 }] },
            { weight: 100, reps: 12, clusters: [{ reps: 3, restSec: 15 }] },
            { weight: 110, reps: 3, done: false },
          ],
        },
        { exerciseId: '0294', superset: 'A', sets: [{ left: { weight: 16, reps: 10, rpe: 8 }, right: { weight: 14, reps: 9, rpe: 9 } }] },
        { exerciseId: '0032', superset: 'A', sets: [{ weight: 140, reps: 3 }] },
        { exerciseId: 'cplank', sets: [{ sec: 60, weight: 10 }] },
        { exerciseId: '0739', sets: [{ min: 20, speed: 9 }] },
      ],
    })
    expect(r.isError, r.text).toBe(false)
    expect(r.json.logged).toEqual({
      id: expect.any(String),
      date: '2026-10-07',
      name: 'Leg Day',
      exercises: ['barbell full squat', 'dumbbell biceps curl', 'barbell deadlift', 'Weighted plank', 'sled 45° leg press'],
      volume: 3436,
      unit: 'kg',
      prs: ['barbell full squat', 'barbell deadlift'],
    })
    expect(r.json.rememberedWeightRaised).toEqual(['barbell full squat', 'dumbbell biceps curl', 'barbell deadlift', 'Weighted plank'])
    const w = doc().workouts.at(-1)
    expect(w).toMatchObject({
      d: '2026-10-07',
      start: NOW - 3_600_000,
      end: NOW,
      routineIds: [LEGS],
      routineId: LEGS,
      name: 'Leg Day',
      bw: 78.4,
      note: 'Heavy day',
      vol: 3436,
      _ts: NOW,
    })
    expect(w.entries[0]).toEqual({
      id: '0043',
      target: null,
      topW: 105,
      sets: [
        { w: 60, r: 5, done: true, phase: 'warmup' },
        { w: 105, r: 5, done: true, rir: 1 },
        { w: 105, r: 5, done: true, type: 'dropset', drops: [{ w: 80, r: 6 }] },
        { w: 100, r: 12, done: true, type: 'restpause', clusters: [{ r: 3, restSec: 15 }] },
        { w: 110, r: 3, done: false },
      ],
    })
    expect(w.entries[1]).toEqual({
      id: '0294',
      target: null,
      topW: 16,
      sg: expect.stringMatching(/^sg/),
      sets: [{ w: 16, r: 19, done: true, rpe: 9, sides: { L: { w: 16, r: 10, done: true, rpe: 8 }, R: { w: 14, r: 9, done: true, rpe: 9 } } }],
    })
    expect(w.entries[2].sg).toBe(w.entries[1].sg)
    expect(w.entries[3].sets).toEqual([{ sec: 60, w: 10, done: true }])
    expect(w.entries[4]).toEqual({ id: '0739', target: null, topW: null, sets: [{ min: 20, speed: 9, done: true }] })
    expect(doc().exWeights['0043']).toEqual({ w: 105, d: '2026-10-07' })
    expect(doc().exWeights['0025']).toEqual({ w: 82.5, d: '2026-10-05' })
    await h.close()
  })

  it('logs into the past in order, takes the badge it leads with from later sessions, and leaves the remembered weight', async () => {
    const { h, doc, workout } = await setup()
    const r = await h.call('write_log_workout', {
      date: '2026-09-29',
      start: '17:30',
      durationMin: 45,
      entries: [{ exerciseId: '0043', sets: [{ weight: 110, reps: 3 }] }],
    })
    expect(r.json.logged).toMatchObject({ name: 'Workout', prs: ['barbell full squat'] })
    expect(doc().workouts.map((w: { d: string }) => w.d)).toEqual(['2026-09-29', '2026-09-30', '2026-10-05'])
    const logged = doc().workouts[0]
    expect(logged).toMatchObject({ start: new Date('2026-09-29T17:30:00').getTime(), end: new Date('2026-09-29T18:15:00').getTime(), routineIds: [], routineId: null })
    expect(logged.bw).toBe(79)
    expect(workout('w-legs').prs).toEqual([])
    expect(workout('w-push').prs).toEqual(['0025'])
    expect(r.json).not.toHaveProperty('rememberedWeightRaised')
    expect(doc().exWeights).toEqual({ '0025': { w: 82.5, d: '2026-10-05' } })
    await h.close()
  })

  it('refuses invalid sets, split supersets and unknown ids before or without writing', async () => {
    const { h, fake } = await setup()
    const bad = [
      { entries: [{ exerciseId: '0043', sets: [{ weight: 100 }] }] },
      { entries: [{ exerciseId: '0043', sets: [{ left: { reps: 5 } }] }] },
      { entries: [{ exerciseId: '0043', sets: [{ weight: 100, reps: 5, rir: 1, rpe: 9 }] }] },
      { entries: [{ exerciseId: '0043', sets: [{ weight: 100, reps: 5, drops: [{ weight: 80, reps: 5 }], clusters: [{ reps: 2 }] }] }] },
      { entries: [{ exerciseId: '0043', sets: [{ weight: 100, reps: 3, clusters: [{ reps: 2 }, { reps: 2 }] }] }] },
      { entries: [{ exerciseId: '0043', sets: [{ sec: 30, reps: 5 }] }] },
      { entries: [{ exerciseId: '0043', superset: 'A', sets: [{ weight: 1, reps: 1 }] }] },
      { entries: [] },
    ]
    for (const args of bad) expect((await h.call('write_log_workout', args)).isError, JSON.stringify(args)).toBe(true)
    expect(fake.stub.calls).toHaveLength(0)
    expect((await h.call('write_log_workout', { entries: [{ exerciseId: '9999', sets: [{ weight: 1, reps: 1 }] }] })).text).toMatch(/unknown exercise ids: 9999/)
    expect((await h.call('write_log_workout', { routineIds: ['nope'], entries: [{ exerciseId: '0043', sets: [{ weight: 1, reps: 1 }] }] })).text).toMatch(/no routine with id "nope"/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('judges assistance machines by less help', async () => {
    const state = profile()
    ;(state.customEx as unknown[]).push({ id: 'cassist', n: 'Gym assisted dip', eq: 'leverage machine', assisted: true, custom: true })
    const { h, doc } = await setup(state)
    await h.call('write_log_workout', { date: '2026-10-01', entries: [{ exerciseId: 'cassist', sets: [{ weight: 30, reps: 8 }, { weight: 25, reps: 6 }] }] })
    const r = await h.call('write_log_workout', { date: '2026-10-03', entries: [{ exerciseId: 'cassist', sets: [{ weight: 20, reps: 8 }] }] })
    expect(r.json.logged.prs).toEqual(['Gym assisted dip'])
    expect(doc().workouts.find((w: { d: string }) => w.d === '2026-10-01').entries[0].topW).toBe(25)
    await h.close()
  })
})

describe('write_update_workout', () => {
  it('replaces sets, recomputes volume and badges, lowers the remembered weight it took away', async () => {
    const { h, doc, workout } = await setup()
    const r = await h.call('write_update_workout', {
      id: 'w-push',
      entries: [
        { exerciseId: '0025', note: 'paused', sets: [{ weight: 80, reps: 8 }, { weight: 80, reps: 8 }] },
        { exerciseId: 'cplank', sets: [{ sec: 75, weight: 10 }] },
      ],
    })
    expect(r.json.updated).toMatchObject({ id: 'w-push', volume: 1280, prs: ['barbell bench press', 'Weighted plank'] })
    const w = workout('w-push')
    expect(w).toMatchObject({ vol: 1280, _ts: NOW, note: 'Felt strong', bw: 78.4, routineIds: [PUSH, LEGS] })
    expect(w.media).toHaveLength(1)
    expect(w.entries[0]).toEqual({ id: '0025', sets: [{ w: 80, r: 8, done: true }, { w: 80, r: 8, done: true }], target: null, topW: 80, note: 'paused' })
    expect(doc().exWeights['0025']).toEqual({ w: 80, d: '2026-10-05' })
    await h.close()
  })

  it('moves a workout to another day, keeping its time of day, and re-sorts', async () => {
    const { h, doc, workout } = await setup()
    await h.call('write_update_workout', { id: 'w-push', date: '2026-09-29', name: 'Moved' })
    expect(doc().workouts.map((w: { id: string }) => w.id)).toEqual(['w-push', 'w-legs'])
    expect(workout('w-push')).toMatchObject({
      d: '2026-09-29',
      name: 'Moved',
      start: new Date('2026-09-29T18:00:00').getTime(),
      end: new Date('2026-09-29T19:10:00').getTime(),
    })
    await h.close()
  })

  it('clears the note and body weight, and changes the duration', async () => {
    const { h, workout } = await setup()
    await h.call('write_update_workout', { id: 'w-push', note: '', bodyWeight: null, durationMin: 50 })
    const w = workout('w-push')
    expect(w).not.toHaveProperty('note')
    expect(w).not.toHaveProperty('bw')
    expect(w.end - w.start).toBe(50 * 60_000)
    await h.close()
  })

  it('refuses an empty change and an unknown workout', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_update_workout', { id: 'w-push' })).text).toMatch(/nothing to change/)
    expect((await h.call('write_update_workout', { id: 'nope', name: 'x' })).text).toMatch(/no workout with id "nope"/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('delete_workout', () => {
  it('deletes and drops a remembered weight that only it held', async () => {
    const { h, doc } = await setup()
    const r = await h.call('delete_workout', { id: 'w-push' })
    expect(r.json).toMatchObject({ deleted: { id: 'w-push', date: '2026-10-05' }, note: expect.stringMatching(/no record of deletions/) })
    expect(doc().workouts.map((w: { id: string }) => w.id)).toEqual(['w-legs'])
    expect(doc().exWeights).toEqual({})
    expect((await h.call('delete_workout', { id: 'w-push' })).text).toMatch(/no workout with id/)
    await h.close()
  })
})
