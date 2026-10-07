import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuiltinCatalogProvider, customExercises, defaultCacheFile, DATASET, ExerciseIndex, isAssisted, slimDataset } from '../src/catalog/exercises.js'
import { DATASET_RECORDS, fixtureCatalog } from './fixtures/exercises.js'
import { FetchStub } from './helpers/fetch-stub.js'

const BODY = JSON.stringify(DATASET_RECORDS)
const SHA = createHash('sha256').update(BODY).digest('hex')
const URL_ = 'https://data.example/exercises.json'

function provider(stub: FetchStub, cacheFile: string, now = () => 0) {
  return new BuiltinCatalogProvider({ cacheFile, dataset: { url: URL_, sha256: SHA }, fetch: stub.fetch, now })
}

const tmpCache = () => join(mkdtempSync(join(tmpdir(), 'leap-cat-')), 'sub', 'exercises.json')

describe('slimDataset', () => {
  it('keeps names, muscles and English steps, fixes the broken degree sign, skips bad records', () => {
    const list = slimDataset(DATASET_RECORDS)
    expect(list.map((e) => e.id)).toEqual(['0025', '0043', '0294', '0739', '0032'])
    expect(list[0]).toEqual({
      id: '0025',
      name: 'barbell bench press',
      bodyPart: 'chest',
      equipment: 'barbell',
      target: 'pectorals',
      secondary: ['triceps', 'shoulders'],
      steps: ['Lie flat on the bench.', 'Press the bar up.'],
      custom: false,
    })
    expect(list[3]!.name).toBe('sled 45° leg press')
  })
})

describe('BuiltinCatalogProvider', () => {
  it('downloads once, checks the hash and caches', async () => {
    const cacheFile = tmpCache()
    const stub = new FetchStub().get('/exercises.json', BODY)
    const first = await provider(stub, cacheFile).get()
    expect(first.error).toBeUndefined()
    expect(first.exercises.get('0043')?.name).toBe('barbell full squat')
    expect(existsSync(cacheFile)).toBe(true)

    const offline = new FetchStub()
    const second = await provider(offline, cacheFile).get()
    expect(second.exercises.size).toBe(5)
    expect(offline.calls).toHaveLength(0)
  })

  it('never sends the openGym token to the dataset host', async () => {
    const stub = new FetchStub().get('/exercises.json', BODY)
    await provider(stub, tmpCache()).get()
    expect(stub.calls[0]!.headers).not.toHaveProperty('Authorization')
  })

  it('refuses a download that does not match the pinned hash', async () => {
    const stub = new FetchStub().get('/exercises.json', `${BODY} `)
    const r = await provider(stub, tmpCache()).get()
    expect(r.exercises.size).toBe(0)
    expect(r.error).toMatch(/does not match the pinned hash/)
  })

  it('works without names when offline, and retries after a pause', async () => {
    let now = 0
    const stub = new FetchStub().on({ method: 'GET', path: '/exercises.json', networkError: 'offline', times: 1 }).get('/exercises.json', BODY)
    const p = provider(stub, tmpCache(), () => now)
    expect((await p.get()).error).toMatch(/unavailable \(offline\); ids are shown instead/)
    expect((await p.get()).error).toBeDefined()
    expect(stub.calls).toHaveLength(1)
    now = 6 * 60_000
    expect((await p.get()).error).toBeUndefined()
  })

  it('pins the upstream dataset by commit and caches per commit', () => {
    expect(DATASET.url).toContain(DATASET.commit)
    expect(defaultCacheFile({ XDG_CACHE_HOME: '/c' })).toBe(`/c/leap/exercises-${DATASET.commit.slice(0, 12)}.json`)
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
