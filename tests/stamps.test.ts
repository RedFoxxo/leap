import { describe, expect, it } from 'vitest'
import { HttpCore } from '../src/http/core.js'
import { highestStamp, stampChange, stampTime } from '../src/state/stamps.js'
import { apply, StateStore } from '../src/state/store.js'
import { writableList, writableMap, type State } from '../src/state/types.js'
import { FakeOpenGym } from './helpers/fake-opengym.js'
import { BASE, TOKEN } from './helpers/harness.js'

const T = 1_790_000_000_000

/** Applies `change` to a copy of `prev` and stamps it at `now`, as the store does. */
function stamped(prev: State, change: (s: State) => void, now = T): State {
  const next = structuredClone(prev)
  change(next)
  stampChange(prev, next, now)
  return next
}

describe('highestStamp and stampTime', () => {
  it('sees every stamp the app keeps, removals and add-backs included', () => {
    const s: State = {
      _ts: 10,
      unitSet: { at: 20 },
      edited: { restSec: 30 },
      deleted: { favEx: { '0025': -40 } },
      routines: [{ id: 'r', _ts: 5, _f: { ex: 50 } }],
      dayNotes: { '2026-10-01': { tag: 'sick', _ts: 60 } },
      measurements: [{ d: '2026-10-01', t: 70 }],
    }
    expect(highestStamp(s)).toBe(70)
    expect(stampTime(s, 1)).toBe(71)
    expect(stampTime(s, 1000)).toBe(1000)
  })
})

describe('stampChange', () => {
  it('stamps a changed routine field by field, and a new one with its time only', () => {
    const prev: State = { routines: [{ id: 'a', name: 'Push', ex: [], _ts: 1, _f: { name: 1 } }] }
    const next = stamped(prev, (s) => {
      const [a] = s.routines as Record<string, unknown>[]
      a!.ex = [{ id: '0025', sets: 3 }]
      ;(s.routines as unknown[]).push({ id: 'b', name: 'Pull', ex: [] })
    })
    const [a, b] = next.routines as Record<string, unknown>[]
    expect(a).toMatchObject({ _ts: T, _f: { name: 1, ex: T } })
    expect(b).toEqual({ id: 'b', name: 'Pull', ex: [], _ts: T })
  })

  it('leaves an unchanged routine alone even when a tool re-stamped it', () => {
    const prev: State = { routines: [{ id: 'a', name: 'Push', _ts: 1 }] }
    const next = stamped(prev, (s) => ((s.routines as Record<string, unknown>[])[0]!._ts = T))
    expect((next.routines as Record<string, unknown>[])[0]).toEqual({ id: 'a', name: 'Push', _ts: T })
    expect(next.edited).toBeUndefined()
  })

  it('stamps a workout only when a tool moved its time', () => {
    const prev: State = { workouts: [{ id: 'w', note: 'a', _ts: 1 }, { id: 'v', note: 'b' }] }
    const next = stamped(prev, (s) => {
      const [w, v] = s.workouts as Record<string, unknown>[]
      w!.note = 'changed'
      w!._ts = T
      v!.n = 'kept as the app keeps it'
    })
    const [w, v] = next.workouts as Record<string, unknown>[]
    expect(w).toMatchObject({ _ts: T, _f: { note: T } })
    expect(v).not.toHaveProperty('_f')
  })

  it('records removals no earlier than what they removed, and favourites starred again', () => {
    const prev: State = {
      workouts: [{ id: 'w', _ts: T + 50 }],
      bodyweight: [{ d: '2026-10-01', w: 80, t: 3 }],
      favEx: ['0025'],
      deleted: { favEx: { '0294': 7 } },
    }
    const next = stamped(prev, (s) => {
      s.workouts = []
      s.bodyweight = []
      s.favEx = ['0294']
    })
    expect(next.deleted).toEqual({
      workouts: { w: T + 51 },
      bodyweight: { '2026-10-01': T },
      favEx: { '0025': T, '0294': -T },
    })
  })

  it('stamps settings, plan days and notes one by one, removals included', () => {
    const prev: State = { restSec: 90, week: { 1: ['a'], 3: ['b'] }, exNotes: { '0025': 'seat 4' }, someSetting: true }
    const next = stamped(prev, (s) => {
      s.restSec = 120
      writableMap(s, 'week')[3] = ['c']
      delete writableMap(s, 'exNotes')['0025']
      delete s.someSetting
    })
    expect(next.edited).toEqual({ restSec: T, 'week.3': T, 'exNotes.0025': T, someSetting: T })
  })

  it('stamps a reorder of the routines as a choice of its own', () => {
    const prev: State = { routines: [{ id: 'a', _ts: 1 }, { id: 'b', _ts: 1 }] }
    const next = stamped(prev, (s) => (s.routines as unknown[]).reverse())
    expect(next.edited).toEqual({ routineOrder: T })
  })

  it('gives re-stamped weigh-ins and stamped-map entries the change’s time', () => {
    const prev: State = { bodyweight: [{ d: '2026-10-01', w: 80, t: 3 }], dbLoad: { '0294': { mode: 'each', _ts: 4 } } }
    const next = stamped(prev, (s) => {
      writableList(s, 'bodyweight').push({ d: '2026-10-02', w: 79, t: 1 })
      ;(writableMap(s, 'dbLoad')['0294'] as Record<string, unknown>)._ts = 5
    })
    expect((next.bodyweight as Record<string, unknown>[])[1]!.t).toBe(T)
    expect((next.dbLoad as Record<string, Record<string, unknown>>)['0294']!._ts).toBe(T)
  })

  it('drops an Undo marker whose field moved on, keeps one still current', () => {
    const prev: State = { restSec: 90, sound: true, edited: { restSec: 10, sound: 12 }, undone: { restSec: [1, 5, 10], sound: [2, 6, 12] } }
    const next = stamped(prev, (s) => (s.restSec = 60))
    expect(next.undone).toEqual({ sound: [2, 6, 12] })
  })
})

describe('StateStore writes as a stamping client', () => {
  const store = (fake: FakeOpenGym, now = T) => new StateStore(new HttpCore({ baseUrl: BASE, token: TOKEN, fetch: fake.stub.fetch }), { now: () => now })

  it('sends stamped: true and the write id it read, and stamps after every stamp it saw', async () => {
    const fake = new FakeOpenGym({ unit: 'kg', _ts: 5, _wid: 'w0', edited: { restSec: T + 100 }, restSec: 90 }, 3)
    const r = await store(fake).update((d) => {
      d.restSec = 120
      return apply(null)
    })
    expect(r.ok).toBe(true)
    expect(fake.bodies[0]).toMatchObject({ stamped: true, baseRev: 3, baseWid: 'w0' })
    expect(fake.state).toMatchObject({ restSec: 120, _ts: T + 101, edited: { restSec: T + 101 } })
  })

  it('redoes the change when the stored document was replaced by a restore with the same revision', async () => {
    const fake = new FakeOpenGym({ unit: 'kg', _wid: 'w0', restSec: 90 }, 3)
    fake.beforePut = (f) => {
      f.beforePut = undefined
      f.state = { ...f.state, _wid: 'restored' }
    }
    const r = await store(fake).update((d) => {
      d.restSec = 120
      return apply(null)
    })
    expect(r.ok && r.data.retries).toBe(1)
    expect(fake.bodies.map((b) => b.baseWid)).toEqual(['w0', 'restored'])
  })

  it('never lets a tool change the sync records itself', async () => {
    const fake = new FakeOpenGym({ unit: 'kg', deleted: { workouts: { w: 5 } } }, 3)
    const r = await store(fake).update((d) => {
      d.deleted = {}
      return apply(null)
    })
    expect(r.ok).toBe(false)
    expect(fake.puts).toHaveLength(0)
  })

  it('says nothing was written when openGym cannot read its stored profile', async () => {
    const fake = new FakeOpenGym({ unit: 'kg' }, 3)
    fake.stub.first({ method: 'PUT', path: '/api/data', status: 503, body: { error: 'state unreadable' } })
    const r = await store(fake).update((d) => {
      d.restSec = 1
      return apply(null)
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/cannot read the stored profile; nothing was written|nothing was written/)
    expect(fake.stub.find('PUT', '/api/data')).toHaveLength(1)
  })

  it('refuses to write to an openGym older than 1.4.0, and asks again later', async () => {
    let now = T
    const fake = new FakeOpenGym({ unit: 'kg' }, 3)
    fake.health = { status: 200, body: { ok: true, users: 1 } }
    const { ServerCheck } = await import('../src/compat.js')
    const http = new HttpCore({ baseUrl: BASE, token: TOKEN, fetch: fake.stub.fetch })
    const check = new ServerCheck(http, () => now)
    const s = new StateStore(http, { now: () => now, server: () => check.writable() })
    const change = (d: State) => {
      d.restSec = 1
      return apply(null)
    }
    const refused = await s.update(change)
    expect(!refused.ok && refused.message).toMatch(/older than 1\.4\.0.*update openGym/)
    expect(fake.puts).toHaveLength(0)
    fake.health = { status: 200, body: { ok: true, users: 1, writable: true } }
    expect((await s.update(change)).ok).toBe(false)
    now += 61_000
    expect((await s.update(change)).ok).toBe(true)
    expect(fake.stub.find('GET', '/api/health')).toHaveLength(2)
  })
})
