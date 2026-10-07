import { describe, expect, it } from 'vitest'
import { LEGS, profile, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { FetchStub } from '../helpers/fetch-stub.js'
import { harness } from '../helpers/harness.js'

async function setup(state: Record<string, unknown> = profile()) {
  const fake = new FakeOpenGym(state, 70)
  return { fake, h: await harness({ stub: fake.stub }), doc: () => fake.state as Record<string, any> }
}

describe('reads that showed too little or the wrong thing', () => {
  it('read_exercise shows a custom exercise’s media and every muscle', async () => {
    const state = profile()
    ;(state.customEx as any[])[0] = {
      ...(state.customEx as any[])[0],
      primaries: ['abs', 'obliques'],
      secondaries: ['lower-back'],
      media: { kind: 'image', hash: 'b'.repeat(64), mime: 'image/png', size: 9, width: 4, height: 4, at: 1 },
    }
    const { h } = await setup(state)
    const r = await h.call('read_exercise', { id: 'cplank' })
    expect(r.json).toMatchObject({ primaryMuscles: ['abs', 'obliques'], secondaryMuscles: ['lower-back'], media: { hash: 'b'.repeat(64), kind: 'image' } })
    await h.close()
  })

  it('read_exercises finds custom exercises by target muscle in either naming', async () => {
    const state = profile()
    ;(state.customEx as any[]).push({ id: 'cfly', n: 'Cable fly (mine)', bp: 'chest', eq: 'cable', tg: 'chest', custom: true })
    const { h } = await setup(state)
    const r = await h.call('read_exercises', { target: 'pectorals' })
    expect(r.json.exercises.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(['0025', 'cfly']))
    await h.close()
  })

  it('read_week_plan leaves deleted routines out of the weekly schedule too', async () => {
    const state = profile()
    ;(state.week as Record<string, unknown>)['2'] = ['gone', PUSH]
    const { h } = await setup(state)
    const r = await h.call('read_week_plan', { from: '2026-10-06', days: 1 })
    expect(r.json.week.Tuesday).toEqual([{ id: PUSH, name: 'Push Day' }])
    await h.close()
  })

  it('read_training_summary refuses more periods than it can show', async () => {
    const { h, fake } = await setup()
    expect((await h.call('read_training_summary', { from: '2020-01-01', to: '2026-01-01', groupBy: 'day' })).text).toMatch(/too many/)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })
})

describe('writes', () => {
  it('say saved: "partly" when something did not persist', async () => {
    const { h, fake } = await setup()
    fake.stub.first({ method: 'GET', path: '/api/data', times: 2, body: () => ({ state: fake.state, rev: fake.rev }) })
    fake.afterApply = (f) => f.otherDeviceWrites((s) => void ((s.bodyweight as any[]).length = 0))
    const r = await h.call('write_bodyweight', { weight: 70, date: '2026-10-06' })
    expect(r.json).toMatchObject({ saved: 'partly', notPersisted: ['bodyweight 2026-10-06'] })
    await h.close()
  })

  it('a custom exercise moved off cardio loses the cardiovascular system as its muscle', async () => {
    const state = profile()
    ;(state.customEx as any[]).push({ id: 'crow', n: 'Rowing erg', bp: 'cardio', eq: 'leverage machine', tg: 'cardiovascular system', primaries: ['cardiovascular system'], secondaries: [], custom: true })
    const { h, doc } = await setup(state)
    await h.call('write_custom_exercise', { id: 'crow', bodyPart: 'back' })
    expect(doc().customEx.at(-1)).toMatchObject({ bp: 'back', primaries: [], tg: '' })
    await h.close()
  })
})

describe('the Coach', () => {
  it('read_coach answers that the Coach is off instead of failing', async () => {
    const stub = new FetchStub()
      .get('/api/coach/status', { error: 'the Coach is not set up on this instance' }, { status: 503 })
      .get('/api/coach/account', { error: 'off' }, { status: 503 })
    const fake = new FakeOpenGym(profile(), 1, stub)
    const h = await harness({ stub: fake.stub })
    const r = await h.call('read_coach')
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ enabled: false })
    await h.close()
  })
})

describe('server answers of an unexpected shape', () => {
  it('give a failure, not a crash', async () => {
    const stub = new FetchStub()
      .get('/api/account/password', { set: true })
      .get('/api/account/passkeys', { weird: true })
      .get('/api/me', { nope: 1 })
      .post('/api/coach/cohort/share', 'ok')
      .post('/api/media/sweep', {})
    const h = await harness({ stub })
    for (const [tool, args] of [['read_account', {}], ['read_me', {}], ['write_coach_share', { share: true }], ['delete_media_sweep', {}]] as const) {
      const r = await h.call(tool, args)
      expect(r.text, tool).not.toMatch(/Cannot read properties|is not a function|undefined \(reading/)
    }
    await h.close()
  })
})

describe('untrusted text', () => {
  it('tools returning text other people wrote say it is data', async () => {
    const h = await harness()
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.description ?? '']))
    for (const name of ['read_coach', 'write_coach_request', 'admin_users', 'admin_user', 'admin_audit']) expect(tools.get(name), name).toMatch(/not instructions/)
    await h.close()
  })
})

void LEGS
