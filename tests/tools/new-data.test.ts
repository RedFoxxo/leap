import { describe, expect, it } from 'vitest'
import { profile } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()

async function setup(state: Record<string, unknown> = profile()) {
  const fake = new FakeOpenGym(state, 60)
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  return { fake, h, doc: () => fake.state as Record<string, any> }
}

describe('body measurements', () => {
  it('logs a day in cm with every kind present, joins later values, and reads them back', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_measurement', { date: '2026-10-06', values: { waist: 81.24, upperArmLeft: 33 }, custom: { Glutes: 98 } })
    expect(r.json).toMatchObject({ saved: true, lengthUnit: 'cm', createdKinds: ['Glutes'], measurement: { date: '2026-10-06', waist: 81.2, upperArmLeft: 33, other: [{ name: 'Glutes', value: 98 }] } })
    const entry = doc().measurements[0]
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['d', 't', 'neck', 'bodyFat', 'other']))
    expect(entry).toMatchObject({ d: '2026-10-06', t: NOW, waist: 81.2, neck: null })
    expect(doc().customMeasurements).toEqual([{ id: expect.any(String), name: 'Glutes', enabled: true }])

    const more = await h.call('write_measurement', { date: '2026-10-06', values: { waist: null, bodyFat: 14.5 } })
    expect(more.json).toMatchObject({ joinedExisting: true, note: expect.stringMatching(/bodyFat is saved but hidden/) })
    expect(doc().measurements[0]).toMatchObject({ waist: null, upperArmLeft: 33, bodyFat: 14.5 })

    const read = await h.call('read_measurements')
    expect(read.json).toMatchObject({ lengthUnit: 'cm', total: 1, latest: { upperArmLeft: { value: 33 }, bodyFat: { value: 14.5 } }, customKinds: [{ name: 'Glutes' }] })
    await h.close()
  })

  it('takes and shows inches for a lb profile, stores cm', async () => {
    const { h, doc } = await setup({ ...profile(), unit: 'lb' })
    await h.call('write_measurement', { values: { waist: 32 } })
    expect(doc().measurements[0].waist).toBe(81.3)
    expect((await h.call('read_measurements')).json.entries[0].waist).toBe(32)
    await h.close()
  })

  it('deletes a day with the removal recorded, and refuses nonsense', async () => {
    const { h, doc } = await setup()
    await h.call('write_measurement', { date: '2026-10-05', values: { chest: 100 } })
    expect((await h.call('write_measurement', { values: { bodyFat: 120 } })).text).toMatch(/at most 100/)
    expect((await h.call('write_measurement', { date: '2026-10-08', values: { chest: 100 } })).text).toMatch(/future/)
    expect((await h.call('write_measurement', { custom: { Waist: 80 } })).text).toMatch(/built-in kind/)
    await h.call('delete_measurement', { date: '2026-10-05' })
    expect(doc().measurements).toEqual([])
    expect(doc().deleted.measurements).toHaveProperty('2026-10-05')
    await h.close()
  })
})

describe('dumbbells', () => {
  it('saves the rack per unit, stamped, and what a weight means per exercise', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_dumbbell_rack', { weights: [10, 2, 4, 4, 12.5] })
    expect(r.json).toMatchObject({ unit: 'kg', dumbbells: [2, 4, 10, 12.5] })
    expect(doc().dumbbells).toEqual({ kg: { weights: [2, 4, 10, 12.5], _ts: NOW } })
    await h.call('write_dumbbell_load', { exerciseId: '0294', mode: 'each' })
    expect(doc().dbLoad['0294']).toEqual({ mode: 'each', _ts: NOW + 1 })
    expect((await h.call('read_exercise', { id: '0294' })).json.weightMeans).toBe('each')
    await h.call('write_dumbbell_load', { exerciseId: '0294', mode: 'as' })
    expect(doc().dbLoad['0294']).toEqual({ mode: null, _ts: NOW + 2 })
    expect((await h.call('write_dumbbell_load', { exerciseId: '0025', mode: 'each' })).text).toMatch(/not a dumbbell or kettlebell exercise/)
    await h.close()
  })
})

describe('writes that change nothing', () => {
  it('stamp nothing for an unchanged day note, dumbbell rack or dumbbell meaning', async () => {
    const { h, fake } = await setup({
      ...profile(),
      dayNotes: { '2026-10-06': { tag: 'sick', _ts: 5 } },
      dumbbells: { kg: { weights: [2, 4], _ts: 5 } },
      dbLoad: { '0294': { mode: 'each', _ts: 5 } },
      measurements: [{ d: '2026-10-06', t: 5, waist: 80, other: [] }],
    })
    const calls = [
      h.call('write_day_note', { date: '2026-10-06', tag: 'sick' }),
      h.call('write_dumbbell_rack', { weights: [4, 2] }),
      h.call('write_dumbbell_load', { exerciseId: '0294', mode: 'each' }),
      h.call('write_dumbbell_load', { exerciseId: '12001', mode: 'as' }),
    ]
    for (const r of await Promise.all(calls)) expect(r.json, r.text).toMatchObject({ saved: false, unchanged: true })
    expect((await h.call('write_dumbbell_load', { exerciseId: '0294', mode: 'each' })).json.unchanged).toBe(true)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('alias ids', () => {
  it('unstars an exercise by its alias id, and keeps an entry stored under an alias id', async () => {
    const state = profile()
    ;(state as any).favEx = ['12001']
    ;(state.workouts as any[])[0].entries.push({ id: '12900', sets: [{ w: 16, r: 10, done: true }], target: { keep: true }, topW: 16 })
    const { h, doc } = await setup(state)
    await h.call('write_favourite', { exerciseId: '12900', favourite: false })
    expect(doc().favEx).toEqual([])
    const read = await h.call('read_workout', { id: 'w-legs' })
    const alias = read.json.entries.find((e: { exerciseId: string }) => e.exerciseId === '12900')
    alias.sets[0].reps = 12
    await h.call('write_update_workout', { id: 'w-legs', entries: read.json.entries })
    expect(doc().workouts[0].entries.at(-1)).toMatchObject({ id: '12900', target: { keep: true }, sets: [{ w: 16, r: 12 }] })
    await h.close()
  })
})

describe('write_settings, openGym 1.4.0 settings', () => {
  it('writes the new settings, an own accent colour, the rest sound and the nudge', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_settings', {
      workoutView: 'focus',
      oneRmFormula: 'weighted',
      accent: '#12AB34',
      restSound: 'classic',
      collapseCompleted: true,
      lang: 'bn',
      reminder: { nudge: true, tone: 'friendly' },
    })
    expect(r.isError, r.text).toBe(false)
    expect(doc()).toMatchObject({ workoutView: 'focus', oneRmFormula: 'weighted', accent: 'custom', accentCustom: '#12ab34', restSound: 'classic', classicChime: true, collapseCompleted: true, lang: 'bn' })
    expect(doc().reminder).toMatchObject({ on: true, nudge: true, tone: 'friendly', tz: 'Europe/Warsaw' })
    expect(doc().edited).toMatchObject({ accent: NOW, accentCustom: NOW, reminder: NOW })
    expect((await h.call('write_settings', { reminder: { tone: 'mean' } })).isError).toBe(true)
    await h.close()
  })

  it('keeps the profile’s own data out of the raw escape hatch', async () => {
    const { h } = await setup()
    for (const key of ['queue', 'rotation', 'dayNotes', 'measurements', 'dbLoad', 'dumbbells', 'deleted', 'edited']) {
      expect((await h.call('write_document', { key, value: {} })).text, key).toMatch(/dedicated tool or belongs to openGym/)
    }
    await h.close()
  })
})
