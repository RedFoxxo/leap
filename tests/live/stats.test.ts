import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('stats (live)', () => {
  beforeAll(seedFixture)

  it('computes history, records, summary and muscle balance from the stored profile', async () => {
    const c = await liveClient()
    const history = await c.call('read_exercise_history', { exerciseId: '0043' })
    expect(history.isError, history.text).toBe(false)
    expect(history.json.best1RM).toMatchObject({ estimate: 140, weight: 100, reps: 12 })

    const records = await c.call('read_records', { sort: 'name' })
    expect(records.json.total).toBe(5)

    const summary = await c.call('read_training_summary', { from: '2026-09-28', to: '2026-10-11' })
    expect(summary.json.total).toEqual({ workouts: 2, minutes: 135, workSets: 10, reps: 67, volume: 4837.5 })

    const balance = await c.call('read_muscle_balance', { from: '2026-09-28', to: '2026-10-05' })
    expect(balance.json.muscles[0]).toMatchObject({ muscle: 'biceps', level: 4 })
    expect(balance.json.untrained.length).toBeGreaterThan(5)
    await c.close()
  })
})
