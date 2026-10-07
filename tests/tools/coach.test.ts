import { describe, expect, it } from 'vitest'
import { profile, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

/** The proposal shapes the fixture provider of a real openGym returned (see tests/live/coach.test.ts). */
const REVIEW = {
  id: 'job1',
  kind: 'review',
  summary: 'One change.',
  changes: [{ id: 'c1', type: 'sets', target: { routineId: PUSH, exId: '0025' }, why: 'Ready for more.', before: 4, after: 5 }],
  notes: [],
}
const PLAN = {
  id: 'job2',
  kind: 'create',
  bundle: { opengym_plan: 1, name: 'Coach plan', week: { '1': 'r1' }, routines: [{ id: 'r1', name: 'Full body A', ex: [{ id: '0043', sets: 3, reps: 8 }, { id: 'cnew', sets: 3, reps: 10 }] }], customEx: [{ id: 'cnew', n: 'Coach curl' }] },
}

async function setup(pending: unknown = null, extra: (fake: FakeOpenGym) => void = () => {}) {
  const fake = new FakeOpenGym(profile())
  fake.stub.get('/api/coach/status', { job: null, pending, cap: { used: 1, limit: 10 }, last: null, maxMessageLen: 1000 })
  fake.stub.get('/api/coach/account', { mode: 'instance', provider: 'fixture', connected: true })
  extra(fake)
  return { fake, h: await harness({ stub: fake.stub }) }
}

describe('read_coach', () => {
  it('shows the waiting review with names and how to apply it', async () => {
    const { h } = await setup(REVIEW)
    const r = await h.call('read_coach')
    expect(r.json).toMatchObject({ consent: true, account: { provider: 'fixture' }, cap: { used: 1, limit: 10 }, howToApply: expect.stringMatching(/write_routine/) })
    expect(r.json.pending.changes[0].target).toEqual({ routineId: PUSH, exId: '0025', exerciseName: 'barbell bench press', routineName: 'Push Day' })
    await h.close()
  })

  it('names the exercises of a plan bundle, its own custom ones included', async () => {
    const { h } = await setup(PLAN)
    const r = await h.call('read_coach')
    expect(r.json.pending.bundle.routines[0].ex.map((e: { name: string }) => e.name)).toEqual(['barbell full squat', 'Coach curl'])
    expect(r.json.howToApply).toMatch(/accepted: \["plan"\]/)
    await h.close()
  })

  it('says when the Coach is off', async () => {
    const { h } = await setup(null, (f) => f.stub.first({ method: 'GET', path: '/api/coach/status', status: 503, body: { error: 'the Coach is not set up on this instance' } }))
    expect((await h.call('read_coach')).text).toMatch(/not set up on this instance/)
    await h.close()
  })
})

describe('write_coach_request', () => {
  it('queues a review and returns the proposal when it is ready', async () => {
    const { h, fake } = await setup(REVIEW, (f) => f.stub.post('/api/coach/review', { job: { id: 'job1' } }))
    const r = await h.call('write_coach_request', { kind: 'review', note: 'Shoulder is fine again', waitSec: 5 })
    expect(r.json).toMatchObject({ job: 'job1', outcome: 'ready', proposal: { kind: 'review' }, howToApply: expect.any(String) })
    expect(fake.stub.find('POST', '/api/coach/review')[0]!.body).toEqual({ note: 'Shoulder is fine again' })
    await h.close()
  })

  it('explains a missing consent and never gives it', async () => {
    const { h, fake } = await setup(null, (f) =>
      f.stub.on({ method: 'POST', path: '/api/coach/plan', status: 403, body: { error: 'the Coach needs your go-ahead first', code: 'consent' } }),
    )
    const r = await h.call('write_coach_request', { kind: 'plan', intake: { goal: 'muscle', daysPerWeek: 3 } })
    expect(r.text).toMatch(/agree there\. leap does not give consent/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('rejects arguments that belong to another kind', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_coach_request', { kind: 'review', intake: { goal: 'x' } })).isError).toBe(true)
    expect((await h.call('write_coach_request', { kind: 'plan', workoutId: 'w-push' })).isError).toBe(true)
    expect((await h.call('write_coach_request', { kind: 'plan', intake: {}, refine: 'more legs' })).isError).toBe(true)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })
})

describe('write_coach_resolve', () => {
  it('records accepted and rejected changes of a review', async () => {
    const { h, fake } = await setup({ ...REVIEW, changes: [...REVIEW.changes, { id: 'c2', type: 'reps' }] }, (f) => f.stub.post('/api/coach/pending/resolve', { ok: true }))
    const r = await h.call('write_coach_resolve', { accepted: ['c1'], rejected: ['c2'] })
    expect(r.json).toEqual({ resolved: 'job1', kind: 'review', accepted: ['c1'], rejected: ['c2'] })
    expect(fake.stub.find('POST', '/api/coach/pending/resolve')[0]!.body).toEqual({ accepted: ['c1'], rejected: ['c2'] })
    await h.close()
  })

  it('refuses ids the proposal does not have, and resolving nothing', async () => {
    const { h, fake } = await setup(PLAN)
    expect((await h.call('write_coach_resolve', { accepted: ['c1'] })).text).toMatch(/not in the waiting proposal: c1 \(it has plan\)/)
    expect((await h.call('write_coach_resolve', {})).isError).toBe(true)
    expect((await h.call('write_coach_resolve', { dismissed: true, accepted: ['plan'] })).isError).toBe(true)
    expect(fake.stub.find('POST', '/api/coach/pending/resolve')).toHaveLength(0)
    await h.close()
    const none = await setup(null)
    expect((await none.h.call('write_coach_resolve', { dismissed: true })).text).toMatch(/no proposal is waiting/)
    await none.h.close()
  })
})
