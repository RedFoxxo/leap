import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { HttpCore } from '../../src/http/core.js'
import { LIVE, liveClient, seedFixture } from './helpers.js'

/** What openGym 1.4.0 does with leap's stamped writes, against the real API image. */
describe.runIf(LIVE)('openGym 1.4.0 (live)', () => {
  beforeAll(seedFixture)

  const rev = async () => {
    const config = loadConfig()
    const r = await new HttpCore({ baseUrl: config.baseUrl, token: config.token }).request<{ rev: number; wid?: string }>({ method: 'GET', path: '/api/data/rev' })
    if (!r.ok) throw new Error(r.message)
    return r.data
  }

  it('knows the server and writes as a stamping client the server takes as it is', async () => {
    const c = await liveClient()
    expect((await c.call('read_instance')).json.compatibility).toMatchObject({ openGym: '1.4.0 or later', leapCanWrite: true })
    const r = await c.call('write_settings', { restSec: 95 })
    expect(r.json).toMatchObject({ saved: true })
    // Nothing put back by the server: it stored exactly the revision it answered.
    const now = await rev()
    expect(now.rev).toBe(r.json.revision)
    expect(typeof now.wid).toBe('string')
    const edited = (await c.call('read_document', { key: 'edited' })).json.value
    expect(edited.restSec).toBeGreaterThan(0)
    await c.close()
  })

  it('removes what it is asked to remove, for good', async () => {
    const c = await liveClient()
    const made = await c.call('write_routine', { name: 'Live Emoji', emoji: 'figureStrength', exercises: [{ exerciseId: '0025', lastSetToFailure: true }] })
    const id = made.json.routine.id as string
    const cleared = await c.call('write_routine', { id, emoji: '', exercises: [{ exerciseId: '0025', lastSetToFailure: false }] })
    expect(cleared.json).toMatchObject({ saved: true })
    expect(cleared.json).not.toHaveProperty('notPersisted')
    const read = await c.call('read_routine', { id })
    expect(read.json).not.toHaveProperty('emoji')
    expect(read.json.exercises[0]).not.toHaveProperty('lastSetToFailure')
    await c.call('write_document', { key: 'leapLiveFlag', value: true })
    await c.call('write_document', { key: 'leapLiveFlag', value: null })
    expect((await c.call('read_document', { key: 'leapLiveFlag' })).isError).toBe(true)
    await c.call('delete_routine', { id })
    expect((await c.call('read_document', { key: 'deleted' })).json.value.routines).toHaveProperty(id)
    await c.close()
  })

  it('runs a rotation round, notes a day and logs measurements', async () => {
    const c = await liveClient()
    const routines = (await c.call('read_routines')).json.routines.map((r: { id: string }) => r.id) as string[]
    const today = (await c.call('read_profile')).json.today.date as string
    await c.call('write_day_plan', { date: today, plan: null })
    const set = await c.call('write_rotation', { routineIds: routines.slice(0, 2) })
    expect(set.json).toMatchObject({ saved: true, round: { managedBy: 'app', total: 2 } })
    const plan = await c.call('read_week_plan', { days: 1 })
    expect(plan.json).toMatchObject({ schedule: 'rotation', days: [{ plannedBy: 'rotation' }] })
    expect((await c.call('write_schedule_mode', { mode: 'week' })).json).toMatchObject({ roundStopped: true })

    const note = await c.call('write_day_note', { date: '2026-10-01', tag: 'travel' })
    expect(note.json).toMatchObject({ saved: true, note: { tag: 'travel' } })
    const m = await c.call('write_measurement', { date: '2026-10-01', values: { waist: 80 } })
    expect(m.json).toMatchObject({ saved: true, measurement: { waist: 80 } })
    expect((await c.call('read_measurements')).json.latest.waist.value).toBe(80)
    await c.close()
  })
})
