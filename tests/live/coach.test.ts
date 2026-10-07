import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

/** Needs the Coach on with openGym's fixture provider, as scripts/test-server.mjs sets it up. */
describe.runIf(LIVE)('AI Coach (live, fixture provider)', () => {
  beforeAll(async () => {
    await seedFixture()
    const c = await liveClient()
    await c.call('delete_coach_data')
    await c.close()
  })

  it('asks for a review, applies the accepted change with leap’s tools and records the decision', async () => {
    const c = await liveClient()
    const review = await c.call('write_coach_request', { kind: 'review', waitSec: 30 })
    expect(review.isError, review.text).toBe(false)
    expect(review.json.outcome).toBe('ready')
    const change = review.json.proposal.changes[0]
    expect(change).toMatchObject({ type: 'sets', target: { routineId: 'r-push', exId: '0025', exerciseName: 'barbell bench press' }, before: 4, after: 5 })

    const routine = (await c.call('read_routine', { id: 'r-push' })).json
    const exercises = routine.exercises.map((e: Record<string, any>) => ({
      exerciseId: e.id,
      sets: e.id === change.target.exId ? change.after : e.sets,
      ...(e.reps ? { reps: e.reps } : {}),
      ...(e.repsMin ? { repsMin: e.repsMin, repsMax: e.repsMax } : {}),
      ...(e.weight ? { weight: e.weight } : {}),
      ...(e.side ? { perSide: true } : {}),
    }))
    expect((await c.call('write_routine', { id: 'r-push', exercises })).json.saved).toBe(true)
    expect((await c.call('write_coach_resolve', { accepted: [change.id] })).json).toMatchObject({ kind: 'review', accepted: [change.id] })

    const after = await c.call('read_coach')
    expect(after.json.pending).toBeNull()
    expect(after.json.last).toMatchObject({ kind: 'review', outcome: 'applied' })
    expect((await c.call('read_routine', { id: 'r-push' })).json.exercises[0].sets).toBe(5)
    await c.close()
  })

  it('asks for a plan and a debrief, and dismisses or marks them read', async () => {
    const c = await liveClient()
    const plan = await c.call('write_coach_request', { kind: 'plan', intake: { goal: 'muscle', experience: 'novice', daysPerWeek: 3, equipment: ['barbell'] }, waitSec: 30 })
    expect(plan.json.proposal.bundle.routines.length).toBeGreaterThan(0)
    expect(plan.json.proposal.bundle.routines[0].ex[0].name).toEqual(expect.any(String))
    expect((await c.call('write_coach_resolve', { dismissed: true })).json.dismissed).toBe(true)

    const debrief = await c.call('write_coach_request', { kind: 'debrief', workoutId: 'w-push', waitSec: 30 })
    expect(debrief.json.proposal).toMatchObject({ kind: 'debrief', workout: { id: 'w-push' }, score: expect.any(Number) })
    expect((await c.call('write_coach_resolve', { accepted: ['debrief'] })).isError).toBe(false)

    expect((await c.call('read_coach_cohort')).isError).toBe(false)
    expect((await c.call('write_coach_share', { share: false })).json.sharing).toBe(false)
    await c.close()
  })
})
