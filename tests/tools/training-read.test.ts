import { describe, expect, it, vi } from 'vitest'
import { profile, PULL, PUSH, LEGS } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

async function setup(state: Record<string, unknown> | null = profile()) {
  const fake = new FakeOpenGym(state)
  return { fake, h: await harness({ stub: fake.stub }) }
}

describe('read_workouts', () => {
  it('lists newest first with names, set counts, volume and PRs', async () => {
    const { h } = await setup()
    const r = await h.call('read_workouts')
    expect(r.json.unit).toBe('kg')
    expect(r.json.total).toBe(2)
    expect(r.json.workouts[0]).toEqual({
      id: 'w-push',
      date: '2026-10-05',
      name: 'Push Day + Leg Day',
      routines: [
        { id: PUSH, name: 'Push Day' },
        { id: LEGS, name: 'Leg Day' },
      ],
      start: '2026-10-05T18:00',
      durationMin: 70,
      exercises: ['barbell bench press', 'dumbbell biceps curl', 'Weighted plank'],
      sets: { done: 6, total: 7, work: 6 },
      volume: 1677.5,
      prs: ['barbell bench press'],
      bodyWeight: 78.4,
      note: 'Felt strong',
      media: 1,
    })
    expect(r.json.workouts[1]).toMatchObject({ id: 'w-legs', sets: { done: 5, total: 6, work: 4 }, volume: 3160 })
    await h.close()
  })

  it('filters by dates, routine and exercise, and caps', async () => {
    const { h } = await setup()
    const ids = async (args: Record<string, unknown>) => (await h.call('read_workouts', args)).json.workouts.map((w: { id: string }) => w.id)
    expect(await ids({ from: '2026-10-01' })).toEqual(['w-push'])
    expect(await ids({ to: '2026-09-30' })).toEqual(['w-legs'])
    expect(await ids({ routineId: LEGS })).toEqual(['w-push', 'w-legs'])
    expect(await ids({ exerciseId: '0043' })).toEqual(['w-legs'])
    expect((await h.call('read_workouts', { limit: 1 })).json).toMatchObject({ total: 2, truncated: true })
    expect((await h.call('read_workouts', { from: '2026-10-05', to: '2026-10-01' })).text).toMatch(/Not sent: from is after to/)
    expect((await h.call('read_workouts', { from: '2026-02-30' })).isError).toBe(true)
    await h.close()
  })

  it('handles a profile that never synced', async () => {
    const { h } = await setup(null)
    expect((await h.call('read_workouts')).json).toEqual({ unit: 'kg', total: 0, workouts: [] })
    await h.close()
  })
})

describe('read_workout', () => {
  it('shows every set kind in the format write_update_workout takes back', async () => {
    const { h } = await setup()
    const r = await h.call('read_workout', { id: 'w-legs' })
    const squat = r.json.entries[0]
    expect(squat).toMatchObject({ position: 1, name: 'barbell full squat', exerciseId: '0043', volume: 3160, bestWeight: 100 })
    expect(squat.sets).toEqual([
      { weight: 60, reps: 5, done: true, warmup: true },
      { weight: 100, reps: 5, done: true, rir: 2 },
      { weight: 100, reps: 5, done: true, rir: 1, drops: [{ weight: 80, reps: 6 }, { weight: 60, reps: 8 }] },
      { weight: 100, reps: 12, done: true, clusters: [{ reps: 3, restSec: 15 }, { reps: 2, restSec: 15 }] },
      { weight: 100, reps: 5, done: false },
    ])
    expect(r.json.entries[1]).toMatchObject({ exerciseId: '9001', name: '9001', sets: [{ min: 20, speed: 9.5, done: true }] })
    await h.close()
  })

  it('shows per-side rows, supersets, routines on combined days, notes and media', async () => {
    const { h } = await setup()
    const r = await h.call('read_workout', { date: '2026-10-05' })
    expect(r.json).toMatchObject({ id: 'w-push', end: '2026-10-05T19:10', note: 'Felt strong', unit: 'kg' })
    expect(r.json.entries[0]).toMatchObject({ note: 'pause reps', routineId: PUSH, routineName: 'Push Day' })
    expect(r.json.entries[1]).toMatchObject({ superset: 'sg1', bestWeight: 16, volume: 440 })
    expect(r.json.entries[1].sets[1]).toEqual({ left: { weight: 16, reps: 10, done: true }, right: { weight: 14, reps: 8, done: false } })
    expect(r.json.entries[2]).toMatchObject({ name: 'Weighted plank', routineId: LEGS, routineName: 'Leg Day', sets: [{ sec: 60, weight: 10, done: true }] })
    expect(r.json.media).toEqual([{ kind: 'image', hash: 'a'.repeat(64), mime: 'image/webp', size: 1200 }])
    await h.close()
  })

  it('offers a choice when a day has several workouts, and needs exactly one of id and date', async () => {
    const state = profile()
    ;(state.workouts as Record<string, unknown>[]).push({ id: 'w-late', d: '2026-10-05', start: 2, entries: [], vol: 0, name: 'Evening' })
    const { h } = await setup(state)
    const r = await h.call('read_workout', { date: '2026-10-05' })
    expect(r.json.workouts.map((w: { id: string }) => w.id)).toEqual(['w-push', 'w-late'])
    expect((await h.call('read_workout', {})).text).toMatch(/exactly one of id or date/)
    expect((await h.call('read_workout', { id: 'nope' })).text).toMatch(/No workout with id "nope"/)
    await h.close()
  })
})

describe('read_routines and read_routine', () => {
  it('lists routines with weekdays and last done', async () => {
    const { h } = await setup()
    const r = await h.call('read_routines')
    expect(r.json.routines).toEqual([
      { id: PUSH, name: 'Push Day', emoji: 'barbell', exercises: 2, weekdays: ['Monday', 'Friday'], lastDone: '2026-10-05' },
      { id: LEGS, name: 'Leg Day', emoji: 'legs', exercises: 1, weekdays: ['Wednesday', 'Friday'], lastDone: '2026-10-05' },
      { id: PULL, name: 'Pull Day', exercises: 1 },
    ])
    await h.close()
  })

  it('shows a routine with exercise names and every stored plan field', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T10:00:00'), toFake: ['Date'] })
    const { h } = await setup()
    const r = await h.call('read_routine', { id: PULL })
    expect(r.json).toMatchObject({ id: PULL, name: 'Pull Day', plannedDates: ['2026-10-11'], unit: 'kg' })
    const push = await h.call('read_routine', { id: PUSH })
    expect(push.json).toMatchObject({ name: 'Push Day', emoji: 'barbell' })
    expect(push.json.exercises[0]).toEqual({
      position: 1,
      name: 'barbell bench press',
      exerciseId: '0025',
      sets: 4,
      reps: 8,
      weight: 80,
      restSec: 150,
      warmupSets: 2,
      progression: 'double',
      increment: 2.5,
      superset: 'sg1',
    })
    expect(push.json.exercises[1]).toMatchObject({ exerciseId: '0294', repsMin: 10, repsMax: 12, superset: 'sg1', perSide: true })
    expect(push.json).not.toHaveProperty('ex')
    expect((await h.call('read_routine', { id: 'nope' })).isError).toBe(true)
    vi.useRealTimers()
    await h.close()
  })
})

describe('read_week_plan', () => {
  it('shows the weekly schedule and resolves overrides day by day', async () => {
    const { h } = await setup()
    const r = await h.call('read_week_plan', { from: '2026-10-05', days: 8 })
    expect(r.json.weekStartsOn).toBe('Monday')
    expect(Object.keys(r.json.week)[0]).toBe('Monday')
    expect(r.json.week.Friday).toEqual([
      { id: PUSH, name: 'Push Day' },
      { id: LEGS, name: 'Leg Day' },
    ])
    expect(r.json.days[0]).toEqual({
      date: '2026-10-05',
      weekday: 'Monday',
      routines: [{ id: PUSH, name: 'Push Day' }],
      plannedBy: 'weekday',
      workouts: [{ id: 'w-push', name: 'Push Day + Leg Day' }],
    })
    expect(r.json.schedule).toBe('week')
    expect(r.json.days[1]).toEqual({ date: '2026-10-06', weekday: 'Tuesday', rest: true, plannedBy: 'rest' })
    expect(r.json.days[4]).toEqual({ date: '2026-10-09', weekday: 'Friday', rest: true, plannedBy: 'rest-override' })
    expect(r.json.days[6]).toEqual({ date: '2026-10-11', weekday: 'Sunday', routines: [{ id: PULL, name: 'Pull Day' }], plannedBy: 'override' })
    expect(r.json.days[7]).toEqual({ date: '2026-10-12', weekday: 'Monday', routines: [{ id: PUSH, name: 'Push Day' }], plannedBy: 'weekday' })
    await h.close()
  })
})

describe('read_bodyweight', () => {
  it('reports latest, goal, changes and entries newest first', async () => {
    const { h } = await setup()
    const r = await h.call('read_bodyweight')
    expect(r.json).toEqual({
      unit: 'kg',
      latest: { date: '2026-10-05', weight: 78.4 },
      goal: 77,
      toGoal: -1.4,
      change7d: -0.6,
      change30d: -2.8,
      total: 3,
      entries: [
        { date: '2026-10-05', weight: 78.4 },
        { date: '2026-09-28', weight: 79 },
        { date: '2026-09-01', weight: 81.2 },
      ],
    })
    expect((await h.call('read_bodyweight', { from: '2026-09-15', limit: 1 })).json).toMatchObject({ total: 2, truncated: true })
    await h.close()
  })
})
