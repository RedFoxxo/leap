import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGS, profile, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

async function setup(state: Record<string, unknown> | null = profile()) {
  const fake = new FakeOpenGym(state, 12)
  fake.stub.get('/api/me', { user: { id: 'u1', name: 'Foxxo', admin: false } })
  return { fake, h: await harness({ stub: fake.stub }) }
}

afterEach(() => vi.useRealTimers())

describe('read_profile', () => {
  it('summarises the profile, today and the next training day', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T09:00:00'), toFake: ['Date'] })
    const { h } = await setup()
    const r = await h.call('read_profile')
    expect(r.json).toEqual({
      id: 'u1',
      name: 'Foxxo',
      unit: 'kg',
      synced: true,
      counts: { workouts: 2, routines: 3, customExercises: 1, weighIns: 3 },
      firstWorkout: '2026-09-30',
      lastWorkout: '2026-10-05',
      workoutsLast7Days: 1,
      workoutsLast30Days: 2,
      today: { date: '2026-10-07', weekday: 'Wednesday', routines: [{ id: LEGS, name: 'Leg Day' }], plannedBy: 'weekday', workouts: [] },
      schedule: 'week',
      nextTraining: { date: '2026-10-11', weekday: 'Sunday', routines: [{ id: 'r-pull', name: 'Pull Day' }] },
      bodyWeight: { date: '2026-10-05', weight: 78.4 },
      goalWeight: 77,
      revision: 12,
      lastChanged: '2026-10-05T19:30',
    })
    await h.close()
  })

  it('works for a profile that never synced', async () => {
    const { h } = await setup(null)
    const r = await h.call('read_profile')
    expect(r.json).toMatchObject({ synced: false, counts: { workouts: 0 }, today: { rest: true, workouts: [] } })
    await h.close()
  })
})

describe('read_settings', () => {
  it('returns every setting and none of the training data', async () => {
    const { h } = await setup()
    const r = await h.call('read_settings')
    expect(r.json).toEqual({
      unit: 'kg',
      settings: {
        unit: 'kg',
        lang: 'de',
        effort: 'rir',
        weekStart: 1,
        targetW: 77,
        restSec: 120,
        reminder: { on: true, time: '07:30', tz: 'Europe/Warsaw' },
        futureFeature: { keep: 'me' },
      },
    })
    await h.close()
  })
})

describe('read_document', () => {
  it('lists keys with type and size, and returns one value as stored', async () => {
    const { h } = await setup()
    const keys = await h.call('read_document')
    expect(keys.json.revision).toBe(12)
    expect(keys.json.keys).toContainEqual({ key: 'routines', type: 'list(3)', chars: expect.any(Number) })
    expect(keys.json.keys).toContainEqual({ key: 'futureFeature', type: 'object', chars: 13 })
    const week = await h.call('read_document', { key: 'week' })
    expect(week.json).toEqual({ revision: 12, key: 'week', value: { '1': [PUSH], '3': LEGS, '5': [PUSH, LEGS] } })
    expect((await h.call('read_document', { key: 'nope' })).isError).toBe(true)
    await h.close()
  })

  it('refuses a value too large for tool output', async () => {
    const { h } = await setup({ ...profile(), big: 'x'.repeat(250_000) })
    const r = await h.call('read_document', { key: 'big' })
    expect(r.text).toMatch(/250002 characters, above the 200000 limit/)
    await h.close()
  })
})
