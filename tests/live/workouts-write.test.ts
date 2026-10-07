import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('workout writes (live)', () => {
  beforeAll(seedFixture)

  it('logs, edits and deletes workouts through the real API', async () => {
    const c = await liveClient()
    const logged = await c.call('write_log_workout', {
      date: '2026-10-06',
      start: '18:30',
      routineIds: ['r-legs'],
      entries: [
        { exerciseId: '0043', sets: [{ weight: 60, reps: 5, warmup: true }, { weight: 105, reps: 5, rir: 2 }, { weight: 105, reps: 5, drops: [{ weight: 80, reps: 6 }] }] },
        { exerciseId: '0294', sets: [{ left: { weight: 16, reps: 10 }, right: { weight: 16, reps: 10 } }] },
      ],
    })
    expect(logged.isError, logged.text).toBe(false)
    expect(logged.json).not.toHaveProperty('notPersisted')
    const id = logged.json.logged.id as string
    expect(logged.json.logged).toMatchObject({ volume: 1850, prs: ['barbell full squat'] })

    const read = await c.call('read_workout', { id })
    expect(read.json.entries[0].sets[2]).toMatchObject({ type: 'dropset', drops: [{ w: 80, r: 6 }] })

    const updated = await c.call('write_update_workout', { id, note: 'live edit', entries: [{ exerciseId: '0043', sets: [{ weight: 100, reps: 5 }] }] })
    expect(updated.json.updated).toMatchObject({ volume: 500 })
    expect(updated.json.updated).not.toHaveProperty('prs')

    const history = await c.call('read_exercise_history', { exerciseId: '0043' })
    expect(history.json.sessions.map((s: { date: string }) => s.date)).toEqual(['2026-10-06', '2026-09-30'])

    expect((await c.call('delete_workout', { id })).json.saved).toBe(true)
    expect((await c.call('read_workouts')).json.total).toBe(2)
    await c.close()
  })
})
