import { describe, expect, it } from 'vitest'
import { cleanUrl } from '../../src/tools/exercises/write.js'
import { profile, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()

async function setup(state: Record<string, unknown> = profile()) {
  const fake = new FakeOpenGym(state, 50)
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  const doc = () => fake.state as Record<string, any>
  return { fake, h, doc }
}

describe('write_custom_exercise', () => {
  it('creates an exercise the way the app stores it', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_custom_exercise', {
      name: 'Landmine press',
      bodyPart: 'shoulders',
      equipment: 'barbell',
      primaryMuscles: ['triceps', 'deltoids'],
      secondaryMuscles: ['chest', 'deltoids', 'abs'],
      target: 'deltoids',
      description: ' Half-kneeling ',
      url: 'youtube.com/watch?v=abc',
    })
    expect(r.json).toMatchObject({ saved: true, created: true, exercise: { name: 'Landmine press', target: 'deltoids', url: 'https://youtube.com/watch?v=abc' } })
    const c = doc().customEx.at(-1)
    expect(c).toEqual({
      id: expect.stringMatching(/^c[0-9a-z]+$/),
      custom: true,
      n: 'Landmine press',
      bp: 'shoulders',
      eq: 'barbell',
      tg: 'deltoids',
      primaries: ['deltoids', 'triceps'],
      secondaries: ['chest', 'abs'],
      sm: ['chest', 'abs'],
      muscleGroups: ['deltoids', 'triceps', 'chest', 'abs'],
      desc: 'Half-kneeling',
      url: 'https://youtube.com/watch?v=abc',
      _ts: NOW,
    })
    const found = await h.call('read_exercises', { query: 'landmine' })
    expect(found.json.exercises[0]).toMatchObject({ name: 'Landmine press', custom: true })
    await h.close()
  })

  it('makes a cardio exercise train the cardiovascular system', async () => {
    const { h, doc } = await setup()
    await h.call('write_custom_exercise', { name: 'Rowing erg', bodyPart: 'cardio', equipment: 'leverage machine', primaryMuscles: ['quadriceps'] })
    expect(doc().customEx.at(-1)).toMatchObject({ primaries: ['cardiovascular system'], tg: 'cardiovascular system' })
    await h.close()
  })

  it('changes only what is given and keeps fields it does not manage', async () => {
    const state = profile()
    ;(state.customEx as any[])[0].media = { kind: 'image', hash: 'b'.repeat(64) }
    const { h, doc } = await setup(state)
    await h.call('write_custom_exercise', { id: 'cplank', description: 'Squeeze glutes', assisted: false })
    expect(doc().customEx[0]).toEqual({
      id: 'cplank',
      n: 'Weighted plank',
      bp: 'waist',
      eq: 'weighted',
      tg: 'abs',
      custom: true,
      desc: 'Squeeze glutes',
      assisted: false,
      media: { kind: 'image', hash: 'b'.repeat(64) },
      _ts: NOW,
      _f: { desc: NOW, assisted: NOW },
    })
    await h.call('write_custom_exercise', { id: 'cplank', url: null, assisted: null })
    expect(doc().customEx[0]).not.toHaveProperty('assisted')
    expect(doc().customEx[0].tg).toBe('abs')
    await h.close()
  })

  it('seeds the muscles of an exercise stored without primaries the way the app opens it', async () => {
    const state = profile()
    ;(state.customEx as any[]).push(
      { id: 'cimp', n: 'Imported row', bp: 'back', eq: 'cable', tg: 'lats', sm: ['biceps', 'rear deltoids'], custom: true },
      { id: 'cold', n: 'Old curl', bp: 'upper arms', eq: 'dumbbell', tg: 'biceps', primaries: ['biceps', 'grip'], secondaries: ['forearm', 'brachioradialis'], custom: true },
    )
    const { h, doc } = await setup(state)
    await h.call('write_custom_exercise', { id: 'cplank', secondaryMuscles: ['obliques'] })
    expect(doc().customEx[0]).toMatchObject({ tg: 'abs', primaries: ['abs'], secondaries: ['obliques'], muscleGroups: ['abs', 'obliques'] })
    await h.call('write_custom_exercise', { id: 'cimp', target: 'upper-back' })
    expect(doc().customEx[1]).toMatchObject({ tg: 'upper-back', primaries: ['upper-back'], secondaries: ['deltoids', 'biceps'], sm: ['deltoids', 'biceps'] })
    // Names the body map does not know stay, at the end, as the app's inMuscleOrder keeps them.
    await h.call('write_custom_exercise', { id: 'cold', target: 'biceps' })
    expect(doc().customEx[2]).toMatchObject({ tg: 'biceps', primaries: ['biceps', 'grip'], secondaries: ['forearm', 'brachioradialis'], muscleGroups: ['biceps', 'grip', 'forearm', 'brachioradialis'] })
    await h.call('write_custom_exercise', { id: 'cold', primaryMuscles: ['triceps', 'biceps'] })
    expect(doc().customEx[2]).toMatchObject({ tg: 'biceps', primaries: ['biceps', 'triceps'], secondaries: ['forearm', 'brachioradialis'] })
    const before = structuredClone(doc().customEx[2])
    await h.call('write_custom_exercise', { id: 'cold', name: 'Old hammer curl' })
    const { n: _n, _ts: _t, _f: _s, ...after } = doc().customEx[2]
    const { n: _n2, _ts: _t2, _f: _s2, ...kept } = before
    expect(after).toEqual(kept)
    expect(Object.keys(doc().customEx[2]._f).filter((k) => !Object.keys(before._f).includes(k))).toEqual(['n'])
    await h.close()
  })

  it('refuses duplicates, bad links, a target that is not primary, and built-in ids', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_custom_exercise', { name: 'Barbell Bench Press', bodyPart: 'chest', equipment: 'barbell' })).text).toMatch(/"barbell bench press" already exists \(0025\)/)
    expect((await h.call('write_custom_exercise', { name: 'X', bodyPart: 'chest', equipment: 'barbell', primaryMuscles: ['chest'], target: 'biceps' })).text).toMatch(/not one of the primary muscles/)
    expect((await h.call('write_custom_exercise', { id: '0025', name: 'Mine' })).text).toMatch(/built-in exercises cannot be changed/)
    expect(fake.puts).toHaveLength(0)
    const calls = fake.stub.calls.length
    expect((await h.call('write_custom_exercise', { name: 'X', bodyPart: 'chest', equipment: 'barbell', url: 'javascript:alert(1)' })).text).toMatch(/not a web address/)
    expect((await h.call('write_custom_exercise', { name: 'X' })).text).toMatch(/needs a name, bodyPart and equipment/)
    expect((await h.call('write_custom_exercise', { name: 'X', bodyPart: 'legs', equipment: 'barbell' })).isError).toBe(true)
    expect((await h.call('write_custom_exercise', { name: 'X', bodyPart: 'chest', equipment: 'barbell', primaryMuscles: ['pecs'] })).isError).toBe(true)
    expect(fake.stub.calls).toHaveLength(calls)
    await h.close()
  })
})

describe('cleanUrl', () => {
  it('accepts web addresses only', () => {
    expect(cleanUrl('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(cleanUrl('example.com')).toBe('https://example.com/')
    expect(cleanUrl('not a url')).toBeNull()
    expect(cleanUrl('ftp://example.com')).toBeNull()
    expect(cleanUrl('https://user:pw@example.com')).toBeNull()
    expect(cleanUrl('https://localhost:8080/x')).toBe('https://localhost:8080/x')
  })

  it('accepts and refuses the hosts the app does (media-refs.js plausibleHost)', () => {
    expect(cleanUrl('https://example.com./x')).toBe('https://example.com./x')
    expect(cleanUrl('http://[::1]:3000/')).toBe('http://[::1]:3000/')
    expect(cleanUrl('https://10.0.0.2/x')).toBe('https://10.0.0.2/x')
    expect(cleanUrl('https://xn--mnchen-3ya.de/')).toBe('https://xn--mnchen-3ya.de/')
    expect(cleanUrl('https://-bad.example.com')).toBeNull()
    expect(cleanUrl('https://bad-.example.com')).toBeNull()
    expect(cleanUrl(`https://${'a'.repeat(64)}.com`)).toBeNull()
    expect(cleanUrl('https://intranet/x')).toBeNull()
  })
})

describe('delete_custom_exercise', () => {
  it('removes it from routines, favourites and weights, and keeps history readable', async () => {
    const state = profile()
    const push = (state.routines as any[])[0]
    push.ex.push({ id: 'cplank', sets: 3, mode: 'time', sec: 60, sg: 'sg2' }, { id: '0043', sets: 3, sg: 'sg2' })
    ;(state.favEx as string[]).push('cplank')
    ;(state.exWeights as Record<string, unknown>).cplank = { w: 10, d: '2026-10-05' }
    const { h, doc } = await setup(state)
    const r = await h.call('delete_custom_exercise', { id: 'cplank' })
    expect(r.json).toMatchObject({ deleted: { id: 'cplank', name: 'Weighted plank' }, removedFromRoutines: ['Push Day'], workoutsKeepingIt: 1 })
    expect(doc().customEx).toEqual([])
    const routine = doc().routines.find((x: { id: string }) => x.id === PUSH)
    expect(routine.ex.map((e: { id: string }) => e.id)).toEqual(['0025', '0294', '0043'])
    expect(routine.ex[2]).not.toHaveProperty('sg')
    expect(routine.ex[1].sg).toBe('sg1')
    expect(routine._ts).toBe(NOW)
    expect(doc().favEx).toEqual(['0025'])
    expect(doc().exWeights).toEqual({ '0025': { w: 82.5, d: '2026-10-05' } })
    const entry = doc().workouts[1].entries[2]
    expect(entry).toMatchObject({ id: 'cplank', n: 'Weighted plank', muscleSnapshot: { n: 'Weighted plank', bp: 'waist' } })
    expect(entry.sets).toEqual([{ sec: 60, w: 10, done: true }])
    const read = await h.call('read_workout', { id: 'w-push' })
    expect(read.json.entries[2].name).toBe('Weighted plank')
    await h.close()
  })
})
