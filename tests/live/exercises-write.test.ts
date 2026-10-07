import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('custom exercise writes (live)', () => {
  beforeAll(seedFixture)

  it('creates, uses, edits and deletes a custom exercise through the real API', async () => {
    const c = await liveClient()
    const created = await c.call('write_custom_exercise', {
      name: 'Live landmine press',
      bodyPart: 'shoulders',
      equipment: 'barbell',
      primaryMuscles: ['deltoids'],
      secondaryMuscles: ['triceps'],
    })
    expect(created.isError, created.text).toBe(false)
    const id = created.json.exercise.id as string

    const logged = await c.call('write_log_workout', { date: '2026-10-06', entries: [{ exerciseId: id, sets: [{ weight: 40, reps: 10 }] }] })
    expect(logged.json.logged.exercises).toEqual(['Live landmine press'])
    const balance = await c.call('read_muscle_balance', { from: '2026-10-06', to: '2026-10-06' })
    expect(balance.json.muscles).toEqual([
      { muscle: 'delts', sets: 1, primarySets: 1, level: 4 },
      { muscle: 'triceps', sets: 0.4, primarySets: 0, level: 2 },
    ])

    expect((await c.call('write_custom_exercise', { id, name: 'Live landmine press (kneeling)' })).json.saved).toBe(true)
    const deleted = await c.call('delete_custom_exercise', { id })
    expect(deleted.json).toMatchObject({ workoutsKeepingIt: 1 })
    const history = await c.call('read_workout', { id: logged.json.logged.id })
    expect(history.json.entries[0]).toMatchObject({ name: 'Live landmine press (kneeling)', sets: [{ weight: 40, reps: 10, done: true }] })
    await c.close()
  })
})
