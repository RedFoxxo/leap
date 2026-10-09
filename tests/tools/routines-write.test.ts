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
  const withCardio = () => {
    const state = profile()
    ;(state.customEx as unknown[]).push({ id: 'crow', n: 'Rowing erg', bp: 'cardio', eq: 'leverage machine', primaries: ['cardiovascular system'], custom: true })
    return state
  }

  it('creates a routine from the app’s defaults plus what is given', async () => {
    const { h, doc } = await setup(withCardio())
    const r = await h.call('write_routine', {
      name: 'Upper A',
      emoji: 'figureStrength',
      progression: 'double',
      exercises: [
        { exerciseId: '0025', sets: 3, reps: 10, repsMin: 6, weight: 80, restSec: 180, warmupSets: 2, superset: 'A' },
        { exerciseId: '0294', reps: 12, weight: 14, perSide: true, superset: 'A', intensifier: { type: 'dropset', count: 1, pct: 20 } },
        { exerciseId: 'cplank', mode: 'time', sec: 60, note: ' neutral spine ' },
        { exerciseId: 'crow' },
      ],
    })
    expect(r.json).toMatchObject({ saved: true, created: true, routine: { name: 'Upper A', exercises: 4 } })
    const created = doc().routines.at(-1)
    expect(created).toMatchObject({ name: 'Upper A', emoji: 'figureStrength', prog: 'double', _ts: NOW })
    const [bench, curl, plank, row] = created.ex
    expect(bench).toEqual({ id: '0025', sets: 3, reps: 10, repsMin: 6, weight: 80, mode: 'reps', restSec: 180, warmupSets: 2, sg: expect.stringMatching(/^sg/) })
    expect(curl).toEqual({ id: '0294', sets: 3, reps: 12, repsMin: 10, weight: 14, mode: 'reps', side: true, intensifier: { type: 'dropset', count: 1, pct: 20 }, sg: bench.sg })
    expect(plank).toEqual({ id: 'cplank', sets: 3, sec: 60, weight: 0, mode: 'time', note: 'neutral spine' })
    expect(row).toEqual({ id: 'crow', sets: 1, min: 20, speed: 8 })
    await h.close()
  })

  it('leaves an untouched exercise with odd old data alone instead of refusing the edit', async () => {
    const state = profile()
    delete (state.routines as any[])[0].ex[1].reps
    const { h, routine } = await setup(state)
    const r = await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025', weight: 85 }, { exerciseId: '0294' }] })
    expect(r.isError, r.text).toBe(false)
    expect(routine(PUSH).ex[1]).not.toHaveProperty('reps')
    await h.close()
  })

  it('changes one exercise and keeps everything else, fields left out included', async () => {
    const state = profile()
    ;(state.routines as any[])[0].ex[0].appOnlyField = { x: 1 }
    const { h, routine } = await setup(state)
    const before = structuredClone(routine(PUSH))
    await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025', weight: 85 }, { exerciseId: '0294' }] })
    expect(routine(PUSH).ex).toEqual([{ ...before.ex[0], weight: 85 }, before.ex[1]])
    expect(routine(PUSH)._ts).toBe(NOW)
    await h.close()
  })

  it('takes exercises of the 1.4.0 catalogue and stores an alias id as the exercise it draws', async () => {
    const { h, routine } = await setup()
    const r = await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025' }, { exerciseId: '0294' }, { exerciseId: '12001' }, { exerciseId: '12900', sets: 2 }] })
    expect(r.isError, r.text).toBe(false)
    expect(routine(PUSH).ex.map((e: { id: string }) => e.id)).toEqual(['0025', '0294', '12001', '12001'])
    await h.close()
  })

  it('stamps the changed fields as the app does and reports the edit as saved', async () => {
    const state = profile()
    ;(state.routines as any[])[0]._f = { name: 5 }
    const { h, routine } = await setup(state)
    const r = await h.call('write_routine', { id: PUSH, name: 'Push heavy', exercises: [{ exerciseId: '0025', weight: 85 }, { exerciseId: '0294' }] })
    expect(r.json).toMatchObject({ saved: true })
    expect(r.json).not.toHaveProperty('notPersisted')
    expect(routine(PUSH)).toMatchObject({ name: 'Push heavy', _ts: NOW, _f: { name: NOW, ex: NOW } })
    await h.close()
  })

  it('removes a field with null', async () => {
    const { h, routine } = await setup()
    await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025', warmupSets: null, progression: null, increment: null }, { exerciseId: '0294', superset: null }] })
    expect(routine(PUSH).ex[0]).toEqual({ id: '0025', sets: 4, reps: 8, weight: 80, restSec: 150 })
    expect(routine(PUSH).ex[0]).not.toHaveProperty('repsMin')
    expect(routine(PUSH).ex[1]).not.toHaveProperty('sg')
    await h.close()
  })

  it('takes back what read_routine returns, and writes nothing when nothing changed', async () => {
    const { h, fake } = await setup()
    const read = await h.call('read_routine', { id: PUSH })
    const r = await h.call('write_routine', { id: PUSH, name: read.json.name, exercises: read.json.exercises })
    expect(r.json).toMatchObject({ saved: false, unchanged: true })
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('checks plans as the app’s editor does', async () => {
    const { h, fake } = await setup(withCardio())
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ exerciseId: '0025', reps: null }, /needs reps/],
      [{ exerciseId: '0294', reps: 11, perSide: true }, /per side.*must be even/],
      [{ exerciseId: '0025', reps: 8, repsMin: 8 }, /repsMin \(8\) must be below reps \(8\)/],
      [{ exerciseId: '0025', repsMax: 6 }, /must not be below reps/],
      [{ exerciseId: '0025', mode: 'cardio' }, /not a cardio exercise/],
      [{ exerciseId: 'crow', mode: 'reps' }, /is a cardio exercise/],
      [{ exerciseId: '0025', progression: 'time' }, /does not fit a reps exercise/],
      [{ exerciseId: 'cplank', mode: 'time', sec: 30, progression: 'linear' }, /does not fit a time exercise/],
    ]
    for (const [x, message] of refused) expect((await h.call('write_routine', { name: 'X', exercises: [x] })).text, JSON.stringify(x)).toMatch(message)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('plans triple progression as the app does: a range and the most sets', async () => {
    const { h, routine } = await setup()
    const r = await h.call('write_routine', { id: PUSH, exercises: [{ exerciseId: '0025', progression: 'triple', reps: 12 }, { exerciseId: '0294' }] })
    expect(r.isError, r.text).toBe(false)
    expect(routine(PUSH).ex[0]).toMatchObject({ prog: 'triple', reps: 12, repsMin: 10, sets: 4, setsMax: 6 })
    const read = await h.call('read_routine', { id: PUSH })
    expect(read.json.exercises[0]).toMatchObject({ progression: 'triple', setsMax: 6 })
    expect((await h.call('write_routine', { id: PUSH, name: read.json.name, exercises: read.json.exercises })).json).toMatchObject({ unchanged: true })
    expect((await h.call('write_routine', { id: PUSH, progression: 'triple' })).isError).toBe(false)
    await h.close()
  })

  it('writes the 1.4.0 exercise options and removes them again', async () => {
    const state = profile()
    ;(state as any).dbLoad = { '0294': { mode: 'each', _ts: 1 } }
    const { h, routine } = await setup(state)
    const r = await h.call('write_routine', {
      id: PUSH,
      exercises: [
        { exerciseId: '0025', lastSetToFailure: true, backoff: true, supersetName: 'Upper', supersetRestSec: 120 },
        { exerciseId: '0294', dumbbellLoad: 'total' },
        { exerciseId: '0043', pyramid: [12, 10, 7, 'max'], pyramidRestSec: [60, 90], pyramidWeight: [60, 70, 80, 0], perSide: false },
      ],
    })
    expect(r.isError, r.text).toBe(false)
    const [bench, curl, squat] = routine(PUSH).ex
    expect(bench).toMatchObject({ lastToFailure: true, backoff: true, sgName: 'Upper', sgRest: 120 })
    expect(curl).toMatchObject({ dbLoad: 'total', sgName: 'Upper', sgRest: 120 })
    expect(squat).toMatchObject({ pyramid: [12, 10, 7, 'max'], sets: 4, reps: 12, pyramidRest: [60, 90, 0, 0], pyramidWeight: [60, 70, 80, 0] })
    expect(squat).not.toHaveProperty('sgName')

    await h.call('write_routine', {
      id: PUSH,
      exercises: [
        { exerciseId: '0025', lastSetToFailure: false, backoff: null, supersetName: null },
        { exerciseId: '0294', dumbbellLoad: 'each' },
        { exerciseId: '0043', pyramid: null },
      ],
    })
    const [b2, c2, s2] = routine(PUSH).ex
    expect(b2).not.toHaveProperty('lastToFailure')
    expect(b2).not.toHaveProperty('backoff')
    expect(b2).not.toHaveProperty('sgName')
    expect(c2).not.toHaveProperty('dbLoad')
    expect(c2.sgRest).toBe(120)
    expect(s2).not.toHaveProperty('pyramid')
    expect(s2).not.toHaveProperty('pyramidRest')
    // The second write comes after every stamp the first one left, whatever the clock says.
    expect(routine(PUSH)._f).toMatchObject({ ex: NOW + 1 })
    await h.close()
  })

  it('checks the 1.4.0 options as the app’s editor does', async () => {
    const { h, fake } = await setup(withCardio())
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ exerciseId: '0025', sets: 4, setsMax: 3 }, /setsMax \(3\).*must be above sets \(4\)/],
      [{ exerciseId: 'cplank', mode: 'time', sec: 30, setsMax: 5 }, /setsMax is for exercises done in reps/],
      [{ exerciseId: 'crow', lastSetToFailure: true }, /no last set to failure/],
      [{ exerciseId: 'cplank', mode: 'time', sec: 30, pyramid: [10, 8] }, /pyramid is for exercises done in reps/],
      [{ exerciseId: '0025', pyramid: [10, 8], backoff: true }, /pyramid plans every set itself/],
      [{ exerciseId: '0025', backoff: true, intensifier: { type: 'restpause', totalReps: 20, restSec: 15 } }, /back-off sets do not fit, it is planned as rest-pause/],
      [{ exerciseId: '0025', dumbbellLoad: 'each' }, /for dumbbell and kettlebell exercises/],
    ]
    for (const [x, message] of refused) expect((await h.call('write_routine', { name: 'X', exercises: [x] })).text, JSON.stringify(x)).toMatch(message)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('refuses bad input before sending anything', async () => {
    const { h, fake } = await setup()
    const bad = [
      {},
      { id: PUSH },
      { name: 'X', progression: 'time' },
      { name: 'X', exercises: [{ exerciseId: '0025', deloadFactor: 0.99 }] },
      { name: 'X', exercises: [{ exerciseId: '0025', superset: 'A' }, { exerciseId: '0043' }, { exerciseId: '0294', superset: 'A' }] },
      { name: 'X', exercises: [{ exerciseId: '0025', superset: 'A' }] },
      { name: 'X', exercises: [{ exerciseId: '0025', sets: 0 }] },
      { name: 'X', exercises: [{ exerciseId: '0025', unknownField: 1 }] },
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
