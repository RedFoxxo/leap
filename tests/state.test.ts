import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpCore } from '../src/http/core.js'
import { defaultBackupDir, fileBackups } from '../src/state/backup.js'
import { newId } from '../src/state/ids.js'
import { apply, checkDocument, refuse, StateStore } from '../src/state/store.js'
import { writableList, type State } from '../src/state/types.js'
import { FakeOpenGym } from './helpers/fake-opengym.js'
import { BASE, TOKEN } from './helpers/harness.js'

const NOW = 1_790_000_000_000

function store(fake: FakeOpenGym, options: ConstructorParameters<typeof StateStore>[1] = {}): StateStore {
  return new StateStore(new HttpCore({ baseUrl: BASE, token: TOKEN, fetch: fake.stub.fetch }), { now: () => NOW, ...options })
}

const profile = (): State => ({
  _ts: NOW - 5000,
  unit: 'kg',
  lang: 'de',
  workouts: [{ id: 'w1', d: '2026-10-01', start: 1, entries: [], vol: 0 }],
  routines: [],
  bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
  someFutureKey: { nested: [1, 2, 3] },
  coach: { consent: true },
})

const addWeighIn = (draft: State, { now }: { now: number }) => {
  writableList(draft, 'bodyweight').push({ d: '2026-10-07', w: 79.5, t: now })
  return apply({ d: '2026-10-07' })
}

describe('StateStore.update', () => {
  it('changes only what was asked and keeps every other key', async () => {
    const fake = new FakeOpenGym(profile(), 7)
    const r = await store(fake).update(addWeighIn)
    expect(r.ok).toBe(true)
    const put = fake.stub.find('PUT', '/api/data')[0]!.body as { state: State; baseRev: number }
    expect(put.baseRev).toBe(7)
    expect(put.state).toEqual({
      ...profile(),
      _ts: NOW,
      bodyweight: [
        { d: '2026-10-01', w: 80, t: 1 },
        { d: '2026-10-07', w: 79.5, t: NOW },
      ],
    })
    expect(r.ok && r.data).toMatchObject({ result: { d: '2026-10-07' }, rev: 8, retries: 0, verified: true, notPersisted: [] })
  })

  it('keeps a "token" value stored in the profile exactly as it is', async () => {
    const fake = new FakeOpenGym({ ...profile(), integration: { token: 'not-a-secret-of-leap' } })
    await store(fake).update(addWeighIn)
    expect(fake.state!.integration).toEqual({ token: 'not-a-secret-of-leap' })
  })

  it('moves _ts forward even when the clock is behind the stored one', async () => {
    const fake = new FakeOpenGym({ ...profile(), _ts: NOW + 60_000 })
    await store(fake).update(addWeighIn)
    expect(fake.state!._ts).toBe(NOW + 60_001)
  })

  it('never sends _rev or an active workout', async () => {
    const fake = new FakeOpenGym({ ...profile(), active: { started: 1 } }, 3)
    await store(fake).update(addWeighIn)
    const sent = (fake.stub.find('PUT', '/api/data')[0]!.body as { state: State }).state
    expect(sent).not.toHaveProperty('_rev')
    expect(sent).not.toHaveProperty('active')
  })

  it('redoes the change on the newer document when another device wrote first', async () => {
    const fake = new FakeOpenGym(profile(), 4)
    fake.beforePut = (f) => {
      f.beforePut = undefined
      f.otherDeviceWrites((s) => {
        ;(s.workouts as unknown[]).push({ id: 'phone', d: '2026-10-07', start: 2, entries: [], vol: 100 })
      })
    }
    const r = await store(fake).update(addWeighIn)
    expect(r.ok && r.data.retries).toBe(1)
    expect((fake.state!.workouts as { id: string }[]).map((w) => w.id)).toEqual(['w1', 'phone'])
    expect((fake.state!.bodyweight as unknown[]).length).toBe(2)
    expect(fake.rev).toBe(6)
  })

  it('gives up after repeated conflicts and says nothing was saved', async () => {
    const fake = new FakeOpenGym(profile())
    fake.beforePut = (f) => f.otherDeviceWrites((s) => void (s.lang = `x${f.rev}`))
    const r = await store(fake).update(addWeighIn)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/gave up after 4 attempts, nothing of this change was saved/)
    expect(fake.puts).toHaveLength(0)
  })

  it('does not apply a change twice when the response to an applied write is lost', async () => {
    const fake = new FakeOpenGym(profile(), 2)
    fake.dropResponses = 1
    const r = await store(fake).update(addWeighIn)
    expect(r.ok).toBe(true)
    expect(fake.puts).toHaveLength(1)
    expect((fake.state!.bodyweight as unknown[]).length).toBe(2)
    expect(r.ok && r.data.warnings.join()).toMatch(/profile shows it was applied/)
  })

  /** A create with a fresh id per attempt, as write_log_workout does: a retry of a landed write duplicates it. */
  const createWorkout = (draft: State, { now }: { now: number }) => {
    const id = newId('', now)
    writableList(draft, 'workouts').push({ id, d: '2026-10-07', start: now, entries: [], vol: 0 })
    return apply(id)
  }
  const verifyCreated = { verify: (s: State, id: string) => ((s.workouts as { id: string }[]).some((w) => w.id === id) ? [] : [id]) }

  it('does not apply a change twice when a proxy answered 504 although openGym saved it', async () => {
    const fake = new FakeOpenGym(profile(), 2)
    fake.gatewayAfterApply = 1
    const r = await store(fake).update(createWorkout, verifyCreated)
    expect(r.ok, !r.ok ? r.message : '').toBe(true)
    expect(fake.puts).toHaveLength(1)
    expect((fake.state!.workouts as unknown[]).length).toBe(2)
  })

  it('does not apply a change twice when another device wrote right after a lost response', async () => {
    const fake = new FakeOpenGym(profile(), 2)
    fake.dropResponses = 1
    fake.afterApply = (f) => {
      f.afterApply = undefined
      f.otherDeviceWrites((s) => void (s._ts = (s._ts as number) + 1000))
    }
    const r = await store(fake).update(createWorkout, verifyCreated)
    expect(r.ok, !r.ok ? r.message : '').toBe(true)
    expect(fake.puts).toHaveLength(1)
    expect((fake.state!.workouts as unknown[]).length).toBe(2)
  })

  it('says plainly when no attempt was confirmed and none landed', async () => {
    const fake = new FakeOpenGym(profile(), 2)
    fake.failBeforeApply = 4
    const r = await store(fake).update(createWorkout, verifyCreated)
    expect(!r.ok && r.message).toMatch(/did not confirm any of 4 attempts and the change is not in the profile/)
    expect(fake.puts).toHaveLength(0)
  })

  it('retries a write that failed before reaching openGym', async () => {
    const fake = new FakeOpenGym(profile(), 2)
    fake.failBeforeApply = 1
    const r = await store(fake).update(addWeighIn)
    expect(r.ok).toBe(true)
    expect(fake.puts).toHaveLength(1)
    expect(r.ok && r.data.warnings.join()).toMatch(/the change is not in the profile, so it was retried/)
  })

  it('sends nothing when the change is refused', async () => {
    const fake = new FakeOpenGym(profile())
    const r = await store(fake).update(() => refuse('no workout with id nope'))
    expect(!r.ok && r).toMatchObject({ code: 'refused', message: 'no workout with id nope' })
    expect(fake.stub.writes).toHaveLength(0)
  })

  it('refuses to change the unit, openGym bookkeeping or a list into something else', async () => {
    const fake = new FakeOpenGym(profile())
    for (const change of [
      (d: State) => void (d.unit = 'lb'),
      (d: State) => void (d.coach = null),
      (d: State) => void (d.resetAt = NOW),
      (d: State) => void (d.workouts = null),
      (d: State) => void (d.week = []),
    ]) {
      const r = await store(fake).update((d) => (change(d), apply(null)))
      expect(!r.ok && r.code, String(change)).toBe('refused')
    }
    expect(fake.stub.writes).toHaveLength(0)
  })

  it('creates the first document of a profile that never synced', async () => {
    const fake = new FakeOpenGym(null)
    const r = await store(fake).update(addWeighIn)
    expect(r.ok).toBe(true)
    expect(fake.state).toMatchObject({ _ts: NOW, _rev: 1, bodyweight: [{ d: '2026-10-07' }] })
  })

  it('reports values that did not persist', async () => {
    const fake = new FakeOpenGym(profile())
    const r = await store(fake).update(addWeighIn, {
      verify: (state) => ((state.bodyweight as unknown[]).length === 99 ? [] : ['bodyweight 2026-10-07']),
    })
    expect(r.ok && r.data.notPersisted).toEqual(['bodyweight 2026-10-07'])
  })

  it('backs up the document before writing and refuses when it cannot', async () => {
    const fake = new FakeOpenGym(profile(), 5)
    const saved: [State, number][] = []
    const r = await store(fake, { backup: (s, rev) => (saved.push([s, rev]), '/backups/x.json') }).update(addWeighIn)
    expect(r.ok && r.data.backup).toBe('/backups/x.json')
    expect(saved[0]![1]).toBe(5)
    expect((saved[0]![0].bodyweight as unknown[]).length).toBe(1)

    const failing = await store(fake, {
      backup: () => {
        throw new Error('disk full')
      },
    }).update(addWeighIn)
    expect(!failing.ok && failing.message).toMatch(/could not back up.*disk full/)
    expect(fake.puts).toHaveLength(1)
  })

  it('refuses a document over openGym’s size limit', async () => {
    const fake = new FakeOpenGym(profile())
    const r = await store(fake).update((d) => ((d.blob = 'x'.repeat(5 * 1024 * 1024)), apply(null)))
    expect(!r.ok && r.message).toMatch(/5 MiB/)
    expect(fake.stub.writes).toHaveLength(0)
  })

  it('passes an expired token through without writing', async () => {
    const fake = new FakeOpenGym(profile())
    fake.stub.first({ method: 'GET', path: '/api/data', status: 401, body: { error: 'not signed in' } })
    const r = await store(fake).update(addWeighIn)
    expect(!r.ok && r.message).toBe('401: not signed in')
    expect(fake.stub.writes).toHaveLength(0)
  })
})

describe('checkDocument', () => {
  it('accepts a document that keeps unit and bookkeeping', () => {
    expect(checkDocument({ ...profile(), lang: 'en' }, profile())).toEqual([])
  })

  it('allows a deliberate unit switch', () => {
    expect(checkDocument({ ...profile(), unit: 'lb', unitSet: { at: 1 } }, profile(), { allowUnitChange: true })).toEqual([])
  })
})

describe('backups', () => {
  it('writes owner-only files and keeps the newest ones', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'leap-')), 'b')
    let t = 0
    const write = fileBackups(dir, 3, () => new Date(Date.UTC(2026, 9, 7, 12, 0, t++)))
    for (let rev = 1; rev <= 5; rev++) write({ rev }, rev)
    const files = readdirSync(dir).sort()
    expect(files).toHaveLength(3)
    expect(files[2]).toMatch(/2026-10-07T12-00-04-000Z-rev5\.json$/)
    expect(JSON.parse(readFileSync(join(dir, files[2]!), 'utf8'))).toEqual({ rev: 5 })
    expect(statSync(join(dir, files[2]!)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('keeps each instance apart under the state directory', () => {
    expect(defaultBackupDir('https://gym.example.com/sub', { XDG_STATE_HOME: '/state' })).toBe(
      '/state/leap/backups/gym.example.com_sub',
    )
  })
})

describe('newId', () => {
  it('uses the app’s format', () => {
    expect(newId('', NOW)).toMatch(new RegExp(`^${NOW.toString(36)}[0-9a-z]{5}$`))
    expect(newId('c', NOW)).toMatch(/^c/)
  })
})
