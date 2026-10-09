import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASSISTED_IDS, BuiltinCatalogProvider, customExercises, ExerciseIndex, isAssisted } from '../src/catalog/exercises.js'
import { BODY_PARTS, EQUIPMENT } from '../src/tools/exercises/write.js'
import { OPENGYM } from '../src/version.js'
import { fixtureCatalog } from './fixtures/exercises.js'

describe('parseCatalogue', () => {
  it('keeps names, muscles, category, description and steps, skips bad records, keeps usable aliases', () => {
    const c = fixtureCatalog()
    expect([...c.exercises.keys()]).toEqual(['0025', '0043', '0294', '0739', '0032', '12001', '12002'])
    expect(c.exercises.get('0025')).toEqual({
      id: '0025',
      name: 'barbell bench press',
      bodyPart: 'chest',
      equipment: 'barbell',
      target: 'pectorals',
      secondary: ['triceps', 'shoulders'],
      category: 'strength',
      description: 'The classic flat-bench press.',
      steps: ['Lie flat on the bench.', 'Press the bar up.'],
      classic: true,
      custom: false,
    })
    expect(c.aliases).toEqual(new Map([['12900', '12001']]))
    expect(c.source).toEqual({ version: '1.4.0', commit: 'fixture' })
  })
})

describe('BuiltinCatalogProvider', () => {
  it('ships the catalogue of the openGym release this leap supports', async () => {
    const c = await new BuiltinCatalogProvider().get()
    expect(c.error).toBeUndefined()
    expect(c.source?.version).toBe(OPENGYM.tested)
    expect(c.exercises.size).toBe(5632)
    expect(c.aliases?.size).toBe(922)
    expect(c.exercises.get('0739')?.name).toBe('sled 45° leg press')
    // The offline list of assistance machines is exactly what the catalogue says.
    expect(new Set([...c.exercises.values()].filter(isAssisted).map((e) => e.id))).toEqual(ASSISTED_IDS)
  })

  it('has no body part or equipment that write_custom_exercise would refuse', async () => {
    const c = await new BuiltinCatalogProvider().get()
    const all = [...c.exercises.values()]
    const bodyParts = new Set(all.map((e) => e.bodyPart))
    const equipment = new Set(all.map((e) => e.equipment))
    expect(bodyParts.size).toBeGreaterThan(5)
    expect(equipment.size).toBeGreaterThan(20)
    expect([...bodyParts].filter((b) => !(BODY_PARTS as readonly unknown[]).includes(b))).toEqual([])
    expect([...equipment].filter((e) => !(EQUIPMENT as readonly unknown[]).includes(e))).toEqual([])
  })

  it('shows ids when the catalogue file is missing or damaged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leap-cat-'))
    expect((await new BuiltinCatalogProvider({ file: join(dir, 'nope.json') }).get()).error).toMatch(/unavailable .*ids are shown instead/)
    writeFileSync(join(dir, 'bad.json'), '{"not":"a catalogue"}')
    expect((await new BuiltinCatalogProvider({ file: join(dir, 'bad.json') }).get()).error).toMatch(/no exercise list/)
  })
})

describe('ExerciseIndex', () => {
  const state = {
    customEx: [{ id: 'cabc', n: 'Landmine press', bp: 'shoulders', eq: 'barbell', primaries: ['delts'], url: 'https://x.example', custom: true }],
    favEx: ['0043', 7],
    exNotes: { '0025': 'seat 4' },
  }

  it('adds custom exercises, favourites and notes', () => {
    const index = new ExerciseIndex(fixtureCatalog(), state)
    expect(index.get('cabc')).toMatchObject({ name: 'Landmine press', target: 'delts', custom: true, url: 'https://x.example' })
    expect(index.favourites).toEqual(new Set(['0043']))
    expect(index.note('0025')).toBe('seat 4')
    expect(index.name('nope')).toBe('nope')
  })

  it('reads an alias id as the exercise it draws', () => {
    const index = new ExerciseIndex(fixtureCatalog(), state)
    expect(index.canonical('12900')).toBe('12001')
    expect(index.name('12900')).toBe('kettlebell test swing')
    expect(index.canonical('0025')).toBe('0025')
    expect(index.canonical('unknown')).toBe('unknown')
  })

  it('reads custom exercises defensively', () => {
    expect(customExercises({ customEx: [null, { n: 'no id' }, { id: 'c1' }] })).toEqual([{ id: 'c1', name: 'c1', secondary: [], steps: [], custom: true }])
  })
})

describe('isAssisted', () => {
  it('follows openGym: an explicit flag, else a leverage machine named assisted', () => {
    const ex = (name: string, equipment: string, assisted?: boolean) => ({ id: 'x', name, equipment, secondary: [], steps: [], custom: false, ...(assisted !== undefined ? { assisted } : {}) })
    expect(isAssisted(ex('assisted pull-up', 'leverage machine'))).toBe(true)
    expect(isAssisted(ex('lever assisted chin-up', 'leverage machine'))).toBe(true)
    expect(isAssisted(ex('assisted lying leg raise', 'assisted'))).toBe(false)
    expect(isAssisted(ex('lever seated row', 'leverage machine'))).toBe(false)
    expect(isAssisted(ex('band pull-up', 'band', true))).toBe(true)
    expect(isAssisted(ex('assisted pull-up', 'leverage machine', false))).toBe(false)
  })
})
