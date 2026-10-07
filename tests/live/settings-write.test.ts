import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('settings and body weight writes (live)', () => {
  beforeAll(seedFixture)

  it('writes, reads back and deletes through the real API', async () => {
    const c = await liveClient()
    const before = (await c.call('read_profile')).json.revision

    const w = await c.call('write_bodyweight', { weight: 78.1, date: '2026-10-06' })
    expect(w.isError, w.text).toBe(false)
    expect(w.json).toMatchObject({ saved: true, revision: before + 1 })
    expect(w.json).not.toHaveProperty('notPersisted')
    expect((await c.call('read_bodyweight')).json.entries[0]).toEqual({ date: '2026-10-06', weight: 78.1 })

    expect((await c.call('delete_bodyweight', { date: '2026-10-06' })).json.saved).toBe(true)
    expect((await c.call('read_bodyweight')).json.latest).toEqual({ date: '2026-10-05', weight: 78.4 })

    const s = await c.call('write_settings', { restSec: 75, reminder: { on: false } })
    expect(s.json.changed.reminder.to).toEqual({ on: false, time: '07:30', tz: 'Europe/Warsaw' })
    expect((await c.call('write_exercise_note', { exerciseId: '0043', note: 'belt on top sets' })).json.saved).toBe(true)
    expect((await c.call('write_favourite', { exerciseId: '0043', favourite: true })).json.saved).toBe(true)
    expect((await c.call('read_exercise', { id: '0043' })).json).toMatchObject({ note: 'belt on top sets', favourite: true })

    const settings = (await c.call('read_settings')).json.settings
    expect(settings).toMatchObject({ restSec: 75, futureFeature: { keep: 'me' }, unit: 'kg' })
    await c.close()
  })
})
