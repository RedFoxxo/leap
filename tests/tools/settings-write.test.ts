import { describe, expect, it } from 'vitest'
import { profile } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()

async function setup(state: Record<string, unknown> | null = profile()) {
  const fake = new FakeOpenGym(state, 20)
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  const doc = () => fake.state as Record<string, any>
  return { fake, h, doc }
}

describe('write_bodyweight', () => {
  it('adds a weigh-in in day order, stamped, keeping everything else', async () => {
    const { h, doc, fake } = await setup()
    const r = await h.call('write_bodyweight', { weight: 78.9, date: '2026-09-30' })
    expect(r.json).toEqual({ saved: true, revision: 21, date: '2026-09-30', weight: 78.9, unit: 'kg' })
    expect(doc().bodyweight.map((e: { d: string }) => e.d)).toEqual(['2026-09-01', '2026-09-28', '2026-09-30', '2026-10-05'])
    expect(doc().bodyweight[2]).toEqual({ d: '2026-09-30', w: 78.9, t: NOW })
    const { _ts, _rev, _wid, bodyweight, ...rest } = doc()
    const { _ts: _a, bodyweight: _b, ...before } = profile()
    expect(rest).toEqual(before)
    expect(_ts).toBe(NOW)
    expect(fake.puts).toHaveLength(1)
    await h.close()
  })

  it('replaces the entry of a day that has one, and defaults to today', async () => {
    const { h, doc } = await setup({ ...profile(), bodyweight: [{ d: '2026-10-07', w: 80, t: 1, extra: 'kept' }] })
    const r = await h.call('write_bodyweight', { weight: 79.6 })
    expect(r.json).toMatchObject({ date: '2026-10-07', replaced: 80 })
    expect(doc().bodyweight).toEqual([{ d: '2026-10-07', w: 79.6, t: NOW, extra: 'kept' }])
    await h.close()
  })

  it('redoes the change when the phone wrote first', async () => {
    const { h, doc, fake } = await setup()
    fake.beforePut = (f) => {
      f.beforePut = undefined
      f.otherDeviceWrites((s) => (s.bodyweight as unknown[]).push({ d: '2026-10-06', w: 78.6, t: 5 }))
    }
    const r = await h.call('write_bodyweight', { weight: 78.2, date: '2026-10-07' })
    expect(r.json).toMatchObject({ saved: true, conflictsRedone: 1 })
    expect(doc().bodyweight.map((e: { d: string }) => e.d).slice(-2)).toEqual(['2026-10-06', '2026-10-07'])
    await h.close()
  })

  it('rejects impossible weights before sending', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_bodyweight', { weight: -1 })).isError).toBe(true)
    expect((await h.call('write_bodyweight', { weight: 80, date: '2026-13-01' })).isError).toBe(true)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })
})

describe('delete_bodyweight', () => {
  it('removes the day and says a delete can be undone by another device', async () => {
    const { h, doc } = await setup()
    const r = await h.call('delete_bodyweight', { date: '2026-09-28' })
    expect(r.json).toMatchObject({ saved: true, deleted: { date: '2026-09-28', weight: 79 }, note: expect.stringMatching(/records the deletion/) })
    expect(doc().bodyweight.map((e: { d: string }) => e.d)).toEqual(['2026-09-01', '2026-10-05'])
    expect(doc().deleted).toEqual({ bodyweight: { '2026-09-28': expect.any(Number) } })
    await h.close()
  })

  it('refuses a day without a weigh-in and writes nothing', async () => {
    const { h, fake } = await setup()
    const r = await h.call('delete_bodyweight', { date: '2026-01-01' })
    expect(r.text).toMatch(/Not saved: there is no weigh-in on 2026-01-01/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('write_goal_weight', () => {
  it('sets and clears the goal', async () => {
    const { h, doc } = await setup()
    expect((await h.call('write_goal_weight', { weight: 75 })).json).toMatchObject({ goal: 75, previous: 77, unit: 'kg' })
    expect(doc().targetW).toBe(75)
    await h.call('write_goal_weight', { weight: null })
    expect(doc().targetW).toBeNull()
    await h.close()
  })
})

describe('write_settings', () => {
  it('changes only the given settings and merges the reminder', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_settings', { restSec: 90, effort: 'rpe', reminder: { time: '06:45' } })
    expect(r.json.changed).toEqual({
      restSec: { from: 120, to: 90 },
      effort: { from: 'rir', to: 'rpe' },
      reminder: { from: { on: true, time: '07:30', tz: 'Europe/Warsaw' }, to: { on: true, time: '06:45', tz: 'Europe/Warsaw' } },
    })
    expect(doc()).toMatchObject({ restSec: 90, effort: 'rpe', lang: 'de', unit: 'kg' })
    await h.close()
  })

  it('makes a language choice stick on a profile that still follows the automatic one', async () => {
    const { h, doc } = await setup({ ...profile(), langAuto: true })
    await h.call('write_settings', { lang: 'pl' })
    expect(doc()).toMatchObject({ lang: 'pl', langAuto: false })
    await h.close()
  })

  it('validates values, refuses an empty call and never touches the unit', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_settings', { effort: 'hard' })).isError).toBe(true)
    expect((await h.call('write_settings', { reminder: { time: '25:00' } })).isError).toBe(true)
    expect((await h.call('write_settings', {})).text).toMatch(/no setting given/)
    expect((await h.call('write_settings', { unit: 'lb' } as Record<string, unknown>)).text).toMatch(/no setting given/)
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })
})

describe('settings the app would not take', () => {
  it('gives a reminder turned on the local time zone, and refuses zones the server cannot read', async () => {
    const { h, doc, fake } = await setup({ ...profile(), reminder: { on: false, time: '08:00', tz: null } })
    await h.call('write_settings', { reminder: { on: true } })
    expect(doc().reminder).toEqual({ on: true, time: '08:00', tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
    const puts = fake.puts.length
    expect((await h.call('write_settings', { reminder: { tz: 'Mars/Olympus' } })).text).toMatch(/not a time zone/)
    expect(fake.puts).toHaveLength(puts)
    await h.close()
  })

  it('keeps a time zone cleared on purpose, and reports the reminder as saved', async () => {
    const { h, doc } = await setup({ ...profile(), reminder: { on: false, time: '08:00', tz: 'Europe/Warsaw' } })
    const r = await h.call('write_settings', { reminder: { on: true, tz: null } })
    expect(r.json).toMatchObject({ saved: true })
    expect(r.json).not.toHaveProperty('notPersisted')
    expect(doc().reminder).toEqual({ on: true, time: '08:00', tz: null })
    await h.close()
  })

  it('offers the rest times the app’s wheels do', async () => {
    const { h, fake } = await setup()
    for (const args of [{ restSec: 901 }, { restSec: -1 }, { restPauseSec: 4 }, { restPauseSec: 301 }, { restPauseSec: 0 }]) {
      expect((await h.call('write_settings', args)).isError, JSON.stringify(args)).toBe(true)
    }
    expect(fake.stub.calls).toHaveLength(0)
    expect((await h.call('write_settings', { restSec: 0, restPauseSec: 5 })).isError).toBe(false)
    expect((await h.call('write_settings', { restSec: 900, restPauseSec: 300 })).isError).toBe(false)
    await h.close()
  })

  it('brings the "on this phone only" line back with the connection status, as the app does', async () => {
    const { h, doc } = await setup({ ...profile(), connStatus: false, connLocal: false })
    const r = await h.call('write_settings', { connStatus: true })
    expect(r.json).toMatchObject({ saved: true, changed: { connStatus: { from: false, to: true }, connLocal: { from: false, to: true } } })
    expect(doc()).toMatchObject({ connStatus: true, connLocal: true })
    await h.call('write_settings', { connStatus: false })
    expect(doc()).toMatchObject({ connStatus: false, connLocal: true })
    await h.call('write_settings', { connStatus: true, connLocal: false })
    expect(doc()).toMatchObject({ connStatus: true, connLocal: false })
    await h.close()
  })

  it('accepts only the values the app offers', async () => {
    const { h, fake } = await setup()
    for (const args of [{ theme: 'neon' }, { accent: 'purple' }, { lang: 'xx' }, { heatmapMetric: 'reps' }]) {
      expect((await h.call('write_settings', args)).isError, JSON.stringify(args)).toBe(true)
    }
    expect(fake.stub.calls).toHaveLength(0)
    expect((await h.call('write_settings', { theme: 'system', accent: 'violet', lang: 'pt-BR', heatmapMetric: 'vol' })).isError).toBe(false)
    await h.close()
  })

  it('refuses a weigh-in in the future', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_bodyweight', { weight: 80, date: '2999-01-01' })).text).toMatch(/in the future/)
    // What "today" is depends on the profile's time zone, so the profile may be read; nothing is written.
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('write_exercise_note and write_favourite', () => {
  it('sets and clears a note', async () => {
    const { h, doc } = await setup()
    expect((await h.call('write_exercise_note', { exerciseId: '0043', note: '  bar on traps ' })).json).toMatchObject({ note: 'bar on traps' })
    expect(doc().exNotes).toEqual({ '0025': 'grip at the rings', '0043': 'bar on traps' })
    expect((await h.call('write_exercise_note', { exerciseId: '0025', note: '' })).json).toMatchObject({ note: null, previous: 'grip at the rings' })
    expect(doc().exNotes).toEqual({ '0043': 'bar on traps' })
    await h.close()
  })

  it('says how a note syncs, like every setting', async () => {
    const h = await harness()
    expect((await h.listTools()).find((t) => t.name === 'write_exercise_note')!.description).toMatch(/one setting and one day at a time/)
    await h.close()
  })

  it('refuses unknown exercises', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_exercise_note', { exerciseId: '9999', note: 'x' })).text).toMatch(/no exercise with id "9999"/)
    expect((await h.call('write_favourite', { exerciseId: 'cnope', favourite: true })).isError).toBe(true)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })

  it('adds and removes favourites without duplicates', async () => {
    const { h, doc } = await setup()
    await h.call('write_favourite', { exerciseId: 'cplank', favourite: true })
    await h.call('write_favourite', { exerciseId: 'cplank', favourite: true })
    expect(doc().favEx).toEqual(['0025', 'cplank'])
    await h.call('write_favourite', { exerciseId: '0025', favourite: false })
    expect(doc().favEx).toEqual(['cplank'])
    await h.close()
  })
})

describe('write_document', () => {
  it('sets and removes an unknown top-level value', async () => {
    const { h, doc } = await setup()
    expect((await h.call('write_document', { key: 'newSetting', value: { a: 1 } })).json).toMatchObject({ key: 'newSetting', previous: null })
    expect(doc().newSetting).toEqual({ a: 1 })
    await h.call('write_document', { key: 'futureFeature', value: null })
    expect(doc()).not.toHaveProperty('futureFeature')
    await h.close()
  })

  it('sets settings that have no dedicated tool, such as the plate inventory', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_document', { key: 'barWeights', value: { '0025': 15 } })
    expect(r.isError, r.text).toBe(false)
    expect(doc().barWeights).toEqual({ '0025': 15 })
    expect(doc().edited).toMatchObject({ 'barWeights.0025': NOW })
    expect((await h.call('write_document', { key: 'enOnly', value: [1] })).text).toMatch(/enOnly must be an object/)
    await h.close()
  })

  it('stamps every changed entry of a map that syncs entry by entry, and never drops one', async () => {
    const { h, doc } = await setup({ ...profile(), plates: { kg: { list: [20, 10], _ts: 3 }, lb: { list: [45], _ts: 3 } } })
    const r = await h.call('write_document', { key: 'plates', value: { kg: { list: [20, 10, 5] }, lb: { list: [45], _ts: 3 } } })
    expect(r.isError, r.text).toBe(false)
    expect(doc().plates).toEqual({ kg: { list: [20, 10, 5], _ts: NOW }, lb: { list: [45], _ts: 3 } })
    expect((await h.call('write_document', { key: 'plates', value: { kg: { list: [20] } } })).text).toMatch(/cannot lose entries \(lb\)/)
    expect((await h.call('write_document', { key: 'plates', value: [1] })).text).toMatch(/give the whole map/)
    await h.close()
  })

  it('removes a top-level key for good, with the removal stamped', async () => {
    const { h, doc } = await setup({ ...profile(), oldFlag: true })
    await h.call('write_document', { key: 'oldFlag', value: null })
    expect(doc()).not.toHaveProperty('oldFlag')
    expect(doc().edited).toMatchObject({ oldFlag: NOW })
    expect((await h.call('write_document', { key: 'edited', value: {} })).text).toMatch(/belongs to openGym/)
    await h.close()
  })

  it('refuses training data, the unit and openGym bookkeeping', async () => {
    const { h, fake } = await setup()
    for (const key of ['workouts', 'unit', 'coach', 'resetAt', 'week', 'targetW', 'reminder', 'exNotes', 'favEx']) {
      expect((await h.call('write_document', { key, value: 1 })).text, key).toMatch(/cannot be set raw/)
    }
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })

  it('refuses every setting write_settings validates, and the values it keeps in step', async () => {
    const { h, fake } = await setup()
    const tools = await h.listTools()
    const settings = Object.keys((tools.find((t) => t.name === 'write_settings') as unknown as { inputSchema: { properties: object } }).inputSchema.properties)
    expect(settings).toEqual(expect.arrayContaining(['restSec', 'accent', 'theme', 'lang', 'connStatus', 'speedUnit']))
    for (const key of [...settings, 'accentCustom', 'classicChime', 'langAuto']) {
      expect((await h.call('write_document', { key, value: 'x' })).text, key).toMatch(/cannot be set raw/)
    }
    expect(fake.stub.calls).toHaveLength(0)
    await h.close()
  })
})
