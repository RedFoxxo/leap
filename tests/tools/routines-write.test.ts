import { describe, expect, it } from 'vitest'
import { LEGS, profile, PULL, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()

async function setup(state: Record<string, unknown> = profile()) {
  const fake = new FakeOpenGym(state, 30)
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  const doc = () => fake.state as Record<string, any>
  const routine = (id: string) => doc().routines.find((r: { id: string }) => r.id === id)
  return { fake, h, doc, routine }
}

describe('write_routine', () => {
  it('creates a routine with supersets, ranges, timed work and intensifiers', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_routine', {
      name: 'Upper A',
      emoji: 'dumbbell',
      progression: 'double',
      exercises: [
        { exerciseId: '0025', sets: 3, repsMin: 6, repsMax: 10, weight: 80, restSec: 180, warmupSets: 2, superset: 'A' },
        { exerciseId: '0294', sets: 3, reps: 12, weight: 14, perSide: true, superset: 'A', intensifier: { type: 'dropset', count: 1, pct: 20 } },
        { exerciseId: 'cplank', sets: 3, mode: 'time', sec: 60, note: 'neutral spine' },
      ],
    })
    expect(r.json).toMatchObject({ saved: true, created: true, routine: { name: 'Upper A', exercises: 3 } })
    const created = doc().routines.at(-1)
    expect(created).toMatchObject({ name: 'Upper A', emoji: 'dumbbell', prog: 'double', _ts: NOW })
    expect(created.id).toMatch(/^[0-9a-z]+$/)
    const [bench, curl, plank] = created.ex
    expect(bench).toEqual({ id: '0025', sets: 3, repsMin: 6, repsMax: 10, weight: 80, restSec: 180, warmupSets: 2, sg: expect.stringMatching(/^sg/) })
    expect(curl).toEqual({ id: '0294', sets: 3, reps: 12, weight: 14, sg: bench.sg, side: true, intensifier: { type: 'dropset', count: 1, pct: 20 } })
    expect(plank).toEqual({ id: 'cplank', sets: 3, mode: 'time', sec: 60, note: 'neutral spine' })
    await h.close()
  })

  it('replaces the exercise list but keeps fields leap does not manage', async () => {
    const state = profile()
    ;(state.routines as any[])[0].ex[0].appOnlyField = { x: 1 }
    const { h, routine } = await setup(state)
    await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025', sets: 5, reps: 5, weight: 85 }] })
    expect(routine(PUSH).ex).toEqual([{ appOnlyField: { x: 1 }, id: '0025', sets: 5, reps: 5, weight: 85 }])
    expect(routine(PUSH)).toMatchObject({ name: 'Push Day', emoji: 'barbell', _ts: NOW })
    await h.close()
  })

  it('renames without touching the exercises', async () => {
    const { h, routine } = await setup()
    const before = structuredClone(routine(LEGS).ex)
    await h.call('write_routine', { id: LEGS, name: 'Legs & Glutes', emoji: '' })
    expect(routine(LEGS)).toEqual({ id: LEGS, name: 'Legs & Glutes', ex: before, _ts: NOW })
    await h.close()
  })

  it('refuses bad plans before sending anything', async () => {
    const { h, fake } = await setup()
    const bad = [
      {},
      { id: PUSH },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 3, repsMin: 10, repsMax: 6 }] },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 3, superset: 'A' }, { exerciseId: '0043', sets: 3 }, { exerciseId: '0294', sets: 3, superset: 'A' }] },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 3, superset: 'A' }] },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 0 }] },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 3, unknownField: 1 }] },
    ]
    for (const args of bad) expect((await h.call('write_routine', args)).isError, JSON.stringify(args)).toBe(true)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })

  it('refuses unknown exercises and routines without writing', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_routine', { name: 'X', exercises: [{ exerciseId: '9999', sets: 3 }] })).text).toMatch(/unknown exercise ids: 9999/)
    expect((await h.call('write_routine', { id: 'nope', name: 'X' })).text).toMatch(/no routine with id "nope"/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('write_copy_routine', () => {
  it('copies under a new id with the app’s naming', async () => {
    const { h, doc } = await setup()
    const first = await h.call('write_copy_routine', { id: PUSH })
    expect(first.json.routine.name).toBe('Push Day (Copy)')
    const second = await h.call('write_copy_routine', { id: PUSH })
    expect(second.json.routine.name).toBe('Push Day (Copy 2)')
    const copy = doc().routines.at(-1)
    expect(copy.id).not.toBe(PUSH)
    expect(copy.ex).toEqual(profile().routines && (profile().routines as any[])[0].ex)
    await h.close()
  })
})

describe('delete_routine', () => {
  it('removes the routine from weekdays and dates, keeping other days intact', async () => {
    const { h, doc } = await setup()
    const r = await h.call('delete_routine', { id: LEGS })
    expect(r.json).toMatchObject({ deleted: { id: LEGS, name: 'Leg Day' }, removedFromWeekdays: ['Wednesday', 'Friday'] })
    expect(doc().routines.map((x: { id: string }) => x.id)).toEqual([PUSH, PULL])
    expect(doc().week).toEqual({ '1': [PUSH], '5': [PUSH] })
    expect(doc().workouts.map((w: { id: string }) => w.id)).toEqual(['w-legs', 'w-push'])
    const pull = await h.call('delete_routine', { id: PULL })
    expect(pull.json.removedFromDates).toEqual(['2026-10-11'])
    expect(doc().dayPlan).toEqual({ '2026-10-09': 'rest', '2026-10-12': 'deleted-routine' })
    await h.close()
  })
})

describe('write_week_plan', () => {
  it('sets weekdays by name, makes empty days rest, leaves the others', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_week_plan', { days: { tuesday: [PULL], Friday: [], Saturday: [LEGS, PUSH, LEGS] } })
    expect(r.json.days).toEqual({
      Tuesday: [{ id: PULL, name: 'Pull Day' }],
      Friday: [],
      Saturday: [
        { id: LEGS, name: 'Leg Day' },
        { id: PUSH, name: 'Push Day' },
      ],
    })
    expect(doc().week).toEqual({ '1': [PUSH], '2': [PULL], '3': LEGS, '6': [LEGS, PUSH] })
    await h.close()
  })

  it('refuses unknown weekdays and routines', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_week_plan', { days: { Funday: [PUSH] } })).isError).toBe(true)
    expect((await h.call('write_week_plan', { days: { Monday: ['nope'] } })).text).toMatch(/no routine with id "nope"/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('describes weekdays as plain string keys to MCP clients', async () => {
    const { h } = await setup()
    const tool = (await h.listTools()).find((t) => t.name === 'write_week_plan') as unknown as { inputSchema: any }
    expect(tool.inputSchema.properties.days.type).toBe('object')
    await h.close()
  })
})

describe('write_day_plan', () => {
  it('overrides, rests and clears a date', async () => {
    const { h, doc } = await setup()
    expect((await h.call('write_day_plan', { date: '2026-10-08', plan: PULL })).json).toMatchObject({ plan: { id: PULL, name: 'Pull Day' }, previous: null })
    expect((await h.call('write_day_plan', { date: '2026-10-08', plan: 'rest' })).json).toMatchObject({ plan: 'rest', previous: PULL })
    await h.call('write_day_plan', { date: '2026-10-09', plan: null })
    expect(doc().dayPlan).toEqual({ '2026-10-08': 'rest', '2026-10-11': PULL, '2026-10-12': 'deleted-routine' })
    expect((await h.call('write_day_plan', { date: '2026-10-08', plan: 'nope' })).isError).toBe(true)
    await h.close()
  })
})
