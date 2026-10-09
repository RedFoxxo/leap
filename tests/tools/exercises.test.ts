import { describe, expect, it } from 'vitest'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const state = {
  unit: 'lb',
  customEx: [{ id: 'cland', n: 'Landmine press', bp: 'shoulders', eq: 'barbell', tg: 'delts', desc: 'Half-kneeling', custom: true }],
  favEx: ['0043'],
  exNotes: { '0025': 'grip at the rings' },
  exWeights: { '0025': { w: 185, d: '2026-10-01' } },
}

describe('read_exercises', () => {
  it('matches every word of the query, name hits first, favourites breaking ties', async () => {
    const h = await harness({ stub: new FakeOpenGym(state).stub })
    const r = await h.call('read_exercises', { query: 'Barbell' })
    expect(r.json.exercises.map((e: { id: string }) => e.id)).toEqual(['0032', '0043', '0025', 'cland'])
    expect(r.json.exercises[1]).toEqual({ id: '0043', name: 'barbell full squat', bodyPart: 'upper legs', equipment: 'barbell', target: 'glutes', category: 'strength', favourite: true })
    expect((await h.call('read_exercises', { query: 'press barbell' })).json.exercises.map((e: { id: string }) => e.id)).toEqual(['0025', 'cland'])
    await h.close()
  })

  it('understands shorthand, plurals, run-together names and small typos', async () => {
    const h = await harness({ stub: new FakeOpenGym(state).stub })
    const ids = async (query: string) => (await h.call('read_exercises', { query })).json.exercises.map((e: { id: string }) => e.id)
    expect(await ids('bb bench')).toEqual(['0025'])
    expect(await ids('db curls')).toEqual(['0294'])
    expect(await ids('benchpress')).toEqual(['0025'])
    expect(await ids('deadlfit')).toEqual(['0032'])
    expect(await ids('kettlebell swing')).toEqual(['12001'])
    expect(await ids('hamstrings')).toEqual(['12002', '0032', '0043', '12001'])
    await h.close()
  })

  it('filters by body part, equipment, target and source, and caps the list', async () => {
    const h = await harness({ stub: new FakeOpenGym(state).stub })
    expect((await h.call('read_exercises', { bodyPart: 'Upper Legs', target: 'glutes', equipment: 'sled machine' })).json.exercises).toHaveLength(1)
    expect((await h.call('read_exercises', { category: 'Stretching' })).json.exercises.map((e: { id: string }) => e.id)).toEqual(['12002'])
    const custom = await h.call('read_exercises', { source: 'custom' })
    expect(custom.json.exercises).toEqual([{ id: 'cland', name: 'Landmine press', bodyPart: 'shoulders', equipment: 'barbell', target: 'delts', custom: true }])
    const capped = await h.call('read_exercises', { limit: 2 })
    expect(capped.json).toMatchObject({ total: 8, truncated: true })
    expect(capped.json.exercises).toHaveLength(2)
    await h.close()
  })

  it('still finds custom exercises when built-in names are unavailable', async () => {
    const h = await harness({
      stub: new FakeOpenGym(state).stub,
      context: { builtinExercises: async () => ({ exercises: new Map(), error: 'built-in exercise names are unavailable (offline)' }) },
    })
    const r = await h.call('read_exercises', {})
    expect(r.json).toMatchObject({ total: 1, warning: expect.stringMatching(/offline/) })
    await h.close()
  })
})

describe('read_exercise', () => {
  it('returns details with the profile note, favourite and remembered weight in the profile unit', async () => {
    const h = await harness({ stub: new FakeOpenGym(state).stub })
    const r = await h.call('read_exercise', { id: '0025' })
    expect(r.json).toEqual({
      id: '0025',
      name: 'barbell bench press',
      bodyPart: 'chest',
      equipment: 'barbell',
      target: 'pectorals',
      category: 'strength',
      secondary: ['triceps', 'shoulders'],
      description: 'The classic flat-bench press.',
      steps: ['Lie flat on the bench.', 'Press the bar up.'],
      note: 'grip at the rings',
      lastWeight: { weight: 185, unit: 'lb', date: '2026-10-01' },
    })
    expect((await h.call('read_exercise', { id: 'cland' })).json).toMatchObject({ custom: true, description: 'Half-kneeling' })
    expect((await h.call('read_exercise', { id: '12900' })).json).toMatchObject({ id: '12001', name: 'kettlebell test swing' })
    await h.close()
  })

  it('reports an unknown id and validates the id before sending anything', async () => {
    const fake = new FakeOpenGym(state)
    const h = await harness({ stub: fake.stub })
    const r = await h.call('read_exercise', { id: '9999' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No exercise with id "9999"; find ids with read_exercises/)
    const bad = await h.call('read_exercise', { id: '../../etc' })
    expect(bad.isError).toBe(true)
    expect(fake.stub.calls).toHaveLength(1)
    await h.close()
  })
})
