import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { HttpCore } from '../../src/http/core.js'
import { StateStore } from '../../src/state/store.js'
import { profile } from '../fixtures/profile.js'
import { LIVE, liveClient } from './helpers.js'

/** Replaces the test profile with the fixture. Only ever run against the throwaway test server. */
export async function seedFixture(): Promise<void> {
  const config = loadConfig()
  const http = new HttpCore({ baseUrl: config.baseUrl, token: config.token })
  const current = await new StateStore(http).load()
  if (!current.ok) throw new Error(current.message)
  const r = await http.request({ method: 'PUT', path: '/api/data', json: { state: profile(), baseRev: current.data.rev } })
  if (!r.ok) throw new Error(r.message)
}

describe.runIf(LIVE)('training reads (live)', () => {
  beforeAll(seedFixture)

  it('reads workouts, routines, plan and body weight from the server', async () => {
    const c = await liveClient()
    const workouts = await c.call('read_workouts')
    expect(workouts.isError, workouts.text).toBe(false)
    expect(workouts.json.workouts.map((w: { id: string }) => w.id)).toEqual(['w-push', 'w-legs'])
    expect(workouts.json.workouts[0].exercises).toEqual(['barbell bench press', 'dumbbell biceps curl', 'Weighted plank'])

    const legs = await c.call('read_workout', { id: 'w-legs' })
    expect(legs.json.entries[0].sets[2]).toMatchObject({ type: 'dropset', drops: [{ w: 80, r: 6 }, { w: 60, r: 8 }] })

    expect((await c.call('read_routines')).json.routines).toHaveLength(3)
    expect((await c.call('read_week_plan', { from: '2026-10-09', days: 1 })).json.days[0]).toMatchObject({ rest: true, override: 'rest' })
    expect((await c.call('read_bodyweight')).json.latest).toEqual({ date: '2026-10-05', weight: 78.4 })
    await c.close()
  })
})
