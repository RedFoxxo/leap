import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('training reads (live)', () => {
  beforeAll(seedFixture)

  it('reads workouts, routines, plan and body weight from the server', async () => {
    const c = await liveClient()
    const workouts = await c.call('read_workouts')
    expect(workouts.isError, workouts.text).toBe(false)
    expect(workouts.json.workouts.map((w: { id: string }) => w.id)).toEqual(['w-push', 'w-legs'])
    expect(workouts.json.workouts[0].exercises).toEqual(['barbell bench press', 'dumbbell biceps curl', 'Weighted plank'])

    const legs = await c.call('read_workout', { id: 'w-legs' })
    expect(legs.json.entries[0].sets[2]).toMatchObject({ drops: [{ weight: 80, reps: 6 }, { weight: 60, reps: 8 }] })

    expect((await c.call('read_routines')).json.routines).toHaveLength(3)
    expect((await c.call('read_week_plan', { from: '2026-10-09', days: 1 })).json.days[0]).toMatchObject({ rest: true, plannedBy: 'rest-override' })
    expect((await c.call('read_bodyweight')).json.latest).toEqual({ date: '2026-10-05', weight: 78.4 })
    await c.close()
  })
})
