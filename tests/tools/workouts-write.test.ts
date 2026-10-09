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
  it('logs exercises of the 1.4.0 catalogue, an alias id as the exercise it draws', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_log_workout', { entries: [{ exerciseId: '12900', sets: [{ weight: 16, reps: 12 }] }] })
    expect(r.isError, r.text).toBe(false)
    expect(doc().workouts.at(-1).entries.map((e: { id: string }) => e.id)).toEqual(['12001'])
    await h.close()
  })

  it('logs sets to failure, a Max set, incline and timed holds per side, and reads them back', async () => {
    const state = profile()
    ;(state.customEx as unknown[]).push({ id: 'ctread', n: 'Incline treadmill walk', bp: 'cardio', eq: 'leverage machine', primaries: ['cardiovascular system'], custom: true })
    const { h, doc } = await setup(state)
    const r = await h.call('write_log_workout', {
      entries: [
        { exerciseId: '0025', sets: [{ weight: 80, reps: 8, failure: true }, { weight: 60, reps: 12, max: true }] },
        { exerciseId: 'ctread', sets: [{ min: 8, speed: 5.5, incline: 8 }] },
        { exerciseId: 'cplank', sets: [{ sec: 45, side: 'L' }, { sec: 45, side: 'R' }] },
      ],
    })
    expect(r.isError, r.text).toBe(false)
    const logged = doc().workouts.at(-1)
    expect(logged.entries[0].sets).toEqual([{ w: 80, r: 8, done: true, failure: true }, { w: 60, r: 12, done: true, max: true }])
    expect(logged.entries[1].sets).toEqual([{ min: 8, speed: 5.5, done: true, incline: 8 }])
    expect(logged.entries[2].sets).toEqual([{ sec: 45, w: 0, done: true, side: 'L' }, { sec: 45, w: 0, done: true, side: 'R' }])
    const read = await h.call('read_workout', { id: logged.id })
    expect(read.json.entries[0].sets[0]).toMatchObject({ failure: true })
    expect(read.json.entries[1].sets[0]).toMatchObject({ incline: 8 })
    const again = await h.call('write_update_workout', { id: logged.id, entries: read.json.entries })
    expect(again.json).toMatchObject({ unchanged: true })
    const bad = await h.call('write_log_workout', { entries: [{ exerciseId: '0025', sets: [{ weight: 40, reps: 10, warmup: true, failure: true }, { weight: 80, reps: 8, incline: 2 }] }] })
    expect(bad.text).toMatch(/warm-up is never taken to failure.*incline is for cardio sets/)
    await h.close()
  })

  it('keeps fields of a set it does not manage when the set comes back from read_workout', async () => {
    const state = profile()
    ;(state.workouts as any[])[0].entries[0].sets[1].at = 123
    ;(state.workouts as any[])[0].entries[0].sets[1].weightOrigin = 'plan'
    const { h, workout } = await setup(state)
    const read = await h.call('read_workout', { id: 'w-legs' })
    expect(read.json.entries[0].sets[1].other).toEqual({ at: 123, weightOrigin: 'plan' })
    read.json.entries[0].sets[1].reps = 6
    await h.call('write_update_workout', { id: 'w-legs', entries: read.json.entries })
    expect(workout('w-legs').entries[0].sets[1]).toEqual({ w: 100, r: 6, done: true, rir: 2, at: 123, weightOrigin: 'plan' })
    await h.close()
  })

  it('stamps the dumbbell meaning and counts both bells per dumbbell, as the app does', async () => {
    const state = profile()
    ;(state as any).dbLoad = { '0294': { mode: 'each', _ts: 1 } }
    const { h, doc } = await setup(state)
    await h.call('write_log_workout', { entries: [{ exerciseId: '0294', sets: [{ weight: 20, reps: 10 }] }, { exerciseId: '0025', sets: [{ weight: 50, reps: 10 }] }] })
    const logged = doc().workouts.at(-1)
    // As the app: the exercise's default plan with the meaning, so its progression reads the session right.
    expect(logged.entries[0].target).toEqual({ id: '0294', sets: 3, reps: 10, weight: 0, mode: 'reps', dbLoad: 'each' })
    expect(logged.entries[1].target).toBeNull()
    expect(logged.vol).toBe(20 * 10 * 2 + 50 * 10)
    await h.close()
  })

  it('judges today’s dumbbell record against history in the same meaning, as the app’s finish does', async () => {
    const state = profile()
    ;(state as any).dbLoad = { '0294': { mode: 'each', _ts: 1 } }
    ;(state.workouts as any[]).push({ id: 'w-old', d: '2026-10-06', start: NOW - 86_400_000, entries: [{ id: '0294', target: { id: '0294', dbLoad: 'total' }, sets: [{ w: 38, r: 10, done: true }], topW: 38 }], prs: [], vol: 380 })
    const { h, doc } = await setup(state)
    const r = await h.call('write_log_workout', { entries: [{ exerciseId: '0294', sets: [{ weight: 20, reps: 10 }] }] })
    expect(r.json.logged.prs).toEqual(['dumbbell biceps curl'])
    expect(doc().workouts.at(-1).prs).toEqual(['0294'])
    await h.close()
  })

  it('counts one bell for a dumbbell exercise logged per side or named one-arm', async () => {
    const state = profile()
    ;(state as any).dbLoad = { '0294': { mode: 'each', _ts: 1 }, '12001': { mode: 'each', _ts: 1 } }
    ;(state.customEx as unknown[]).push({ id: 'crow1', n: 'Dumbbell one-arm row', bp: 'back', eq: 'dumbbell', primaries: ['upper-back'], custom: true })
    ;(state as any).dbLoad.crow1 = { mode: 'each', _ts: 1 }
    const { h, doc } = await setup(state)
    await h.call('write_log_workout', { entries: [{ exerciseId: 'crow1', sets: [{ weight: 30, reps: 10 }] }] })
    expect(doc().workouts.at(-1).vol).toBe(300)
    // Push Day plans the curl per side: one bell.
    await h.call('write_log_workout', { routineIds: [PUSH], entries: [{ exerciseId: '0294', sets: [{ left: { weight: 14, reps: 10 }, right: { weight: 14, reps: 10 } }] }] })
    expect(doc().workouts.at(-1).entries[0].target).toMatchObject({ side: true, dbLoad: 'each' })
    expect(doc().workouts.at(-1).vol).toBe(280)
    await h.close()
  })

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
    expect(r.json.logged).toMatchObject({ name: 'Freestyle', prs: ['barbell full squat'] })
    expect(doc().workouts.map((w: { d: string }) => w.d)).toEqual(['2026-09-29', '2026-09-30', '2026-10-05'])
    const logged = doc().workouts[0]
    expect(logged).toMatchObject({ start: new Date('2026-09-29T17:30:00').getTime(), end: new Date('2026-09-29T18:15:00').getTime(), routineIds: [], routineId: null })
    expect(logged).not.toHaveProperty('bw')
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

describe('assistance machines while the catalogue is unavailable', () => {
  it('still judges the built-in ones by less help', async () => {
    const fake = new FakeOpenGym(profile(), 40)
    const h = await harness({
      stub: fake.stub,
      context: { now: () => NOW, builtinExercises: async () => ({ exercises: new Map(), error: 'built-in exercise names are unavailable (offline)' }) },
    })
    await h.call('write_log_workout', { date: '2026-10-01', entries: [{ exerciseId: '0017', sets: [{ weight: 30, reps: 8 }, { weight: 25, reps: 6 }] }] })
    const r = await h.call('write_log_workout', { date: '2026-10-03', entries: [{ exerciseId: '0017', sets: [{ weight: 20, reps: 8 }] }] })
    expect(r.json.logged.prs).toEqual(['0017'])
    const first = (fake.state as any).workouts.find((w: { d: string }) => w.d === '2026-10-01')
    expect(first.entries[0].topW).toBe(25)
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
    expect(w.entries[0]).toEqual({ id: '0025', rid: PUSH, sets: [{ w: 80, r: 8, done: true }, { w: 80, r: 8, done: true }], topW: 80, note: 'paused' })
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

describe('workout edits keep what is not mentioned', () => {
  it('takes back what read_workout returns, and writes nothing when nothing changed', async () => {
    const { h, fake } = await setup()
    const read = await h.call('read_workout', { id: 'w-push' })
    const r = await h.call('write_update_workout', { id: 'w-push', entries: read.json.entries })
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toMatchObject({ saved: false, unchanged: true })
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('changes one exercise and keeps the others’ sets, notes, supersets, routines and app fields', async () => {
    const state = profile()
    ;(state.workouts as any[])[1].entries[1].muscleSnapshot = { n: 'kept' }
    const { h, workout } = await setup(state)
    const before = structuredClone((state.workouts as any[])[1])
    await h.call('write_update_workout', { id: 'w-push', entries: [{ exerciseId: '0294' }, { exerciseId: 'cplank', sets: [{ sec: 90, weight: 10 }] }] })
    const w = workout('w-push')
    expect(w.entries.map((e: { id: string }) => e.id)).toEqual(['0294', 'cplank'])
    // Everything of the curl is kept; only its superset id goes, since its partner (the bench press) left the workout.
    const { sg: _sg, ...curl } = before.entries[1]
    expect(w.entries[0]).toEqual(curl)
    expect(w.entries[1]).toMatchObject({ id: 'cplank', rid: LEGS, sets: [{ sec: 90, w: 10, done: true }] })
    await h.close()
  })

  it('removes a note, superset or routine link with null', async () => {
    const { h, workout } = await setup()
    await h.call('write_update_workout', { id: 'w-push', entries: [{ exerciseId: '0025', note: null, routineId: null }, { exerciseId: '0294', superset: null }, { exerciseId: 'cplank' }] })
    const w = workout('w-push')
    expect(w.entries[0]).not.toHaveProperty('note')
    expect(w.entries[0]).not.toHaveProperty('rid')
    expect(w.entries[1]).not.toHaveProperty('sg')
    await h.close()
  })

  it('keeps a deleted custom exercise editable', async () => {
    const state = profile()
    state.customEx = []
    const { h, workout } = await setup(state)
    const r = await h.call('write_update_workout', { id: 'w-push', entries: [{ exerciseId: '0025' }, { exerciseId: '0294' }, { exerciseId: 'cplank', sets: [{ sec: 45, weight: 0 }] }] })
    expect(r.isError, r.text).toBe(false)
    expect(workout('w-push').entries[2].sets).toEqual([{ sec: 45, w: 0, done: true }])
    await h.close()
  })
})

describe('combined days and deloads', () => {
  it('links each exercise to its routine, inferred or given, and checks it belongs to the session', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_log_workout', {
      date: '2026-10-06',
      routineIds: [PUSH, LEGS, PUSH],
      entries: [{ exerciseId: '0043', sets: [{ weight: 100, reps: 5 }] }, { exerciseId: '0025', sets: [{ weight: 80, reps: 5 }] }, { exerciseId: '0032', routineId: LEGS, sets: [{ weight: 140, reps: 3 }] }],
    })
    expect(r.json.logged.name).toBe('Push Day + Leg Day')
    const w = doc().workouts.find((x: { d: string }) => x.d === '2026-10-06')
    expect(w.routineIds).toEqual([PUSH, LEGS])
    expect(w.entries.map((e: { rid?: string }) => e.rid)).toEqual([LEGS, PUSH, LEGS])
    const wrong = await h.call('write_log_workout', { date: '2026-10-06', routineIds: [PUSH, LEGS], entries: [{ exerciseId: '0032', routineId: 'r-pull', sets: [{ weight: 1, reps: 1 }] }] })
    expect(wrong.text).toMatch(/not one of this session's routines/)
    await h.close()
  })

  it('marks sessions of a routine excluded from progression', async () => {
    const state = profile()
    ;(state.routines as any[]).find((r) => r.id === LEGS).excludeFromProgression = true
    const { h, doc } = await setup(state)
    await h.call('write_log_workout', { date: '2026-10-06', routineIds: [LEGS], entries: [{ exerciseId: '0043', sets: [{ weight: 60, reps: 5 }] }] })
    const w = doc().workouts.find((x: { d: string }) => x.d === '2026-10-06')
    expect(w.entries[0].noProg).toBe(true)
    expect(w.excludeFromProgression).toBe(true)
    await h.close()
  })
})

describe('workout input the app would not store', () => {
  it('is refused before anything is sent', async () => {
    const { h, fake } = await setup()
    const one = (sets: unknown[]) => ({ entries: [{ exerciseId: '0043', sets }] })
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ date: '2026-10-08', ...one([{ weight: 1, reps: 1 }]) }, /in the future/],
      [one([{ weight: 100, reps: 5, done: false }]), /no completed set/],
      [one([{ left: { weight: 10, reps: 5 }, right: { weight: 10, reps: 5 }, drops: [{ weight: 5, reps: 5 }] }]), /not logged on per-side sets/],
      [{ note: 'x'.repeat(501), ...one([{ weight: 1, reps: 1 }]) }, /./],
    ]
    for (const [args, message] of cases) expect((await h.call('write_log_workout', args)).text, JSON.stringify(args).slice(0, 80)).toMatch(message)
    expect((await h.call('write_update_workout', { id: 'w-push', date: '2026-12-01' })).text).toMatch(/in the future/)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })

  it('names a session of four routines as the app does', async () => {
    const state = profile()
    ;(state.routines as any[]).push({ id: 'r4', name: 'Core', ex: [] })
    const { h } = await setup(state)
    const r = await h.call('write_log_workout', { date: '2026-10-06', routineIds: [PUSH, LEGS, 'r-pull', 'r4'], entries: [{ exerciseId: '0043', sets: [{ weight: 1, reps: 1 }] }] })
    expect(r.json.logged.name).toBe('Push Day + Leg Day + 2 more')
    await h.close()
  })
})

describe('delete_workout', () => {
  it('deletes and drops a remembered weight that only it held', async () => {
    const { h, doc } = await setup()
    const r = await h.call('delete_workout', { id: 'w-push' })
    expect(r.json).toMatchObject({ deleted: { id: 'w-push', date: '2026-10-05' }, note: expect.stringMatching(/records the deletion/) })
    expect(doc().workouts.map((w: { id: string }) => w.id)).toEqual(['w-legs'])
    expect(doc().deleted.workouts).toHaveProperty('w-push')
    expect(doc().exWeights).toEqual({})
    expect((await h.call('delete_workout', { id: 'w-push' })).text).toMatch(/no workout with id/)
    await h.close()
  })
})
