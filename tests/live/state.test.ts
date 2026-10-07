import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { HttpCore, type FetchLike } from '../../src/http/core.js'
import { apply, StateStore } from '../../src/state/store.js'
import { writableList, type State } from '../../src/state/types.js'
import { LIVE } from './helpers.js'

function liveStore(fetchImpl?: FetchLike): { store: StateStore; http: HttpCore } {
  const config = loadConfig()
  const http = new HttpCore({ baseUrl: config.baseUrl, token: config.token, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  return { store: new StateStore(http), http }
}

const marker = (draft: State, key: string, value: unknown) => {
  writableList(draft, 'favEx')
  draft[key] = value
  return apply(value)
}

describe.runIf(LIVE)('state store (live)', () => {
  it('writes, bumps the revision and keeps unknown keys', async () => {
    const { store } = liveStore()
    const before = await store.load()
    expect(before.ok).toBe(true)
    if (!before.ok) return

    const seeded = await store.update((d) => marker(d, 'leapLiveUnknown', { keep: [1, 2] }))
    expect(seeded.ok, !seeded.ok ? seeded.message : '').toBe(true)
    const r = await store.update((d) => marker(d, 'leapLiveMarker', 'one'), {
      verify: (s) => (s.leapLiveMarker === 'one' ? [] : ['leapLiveMarker']),
    })
    expect(r.ok, !r.ok ? r.message : '').toBe(true)
    if (!r.ok) return
    expect(r.data.notPersisted).toEqual([])
    expect(r.data.rev).toBe(before.data.rev + 2)

    const after = await store.load()
    expect(after.ok && after.data.state).toMatchObject({ leapLiveUnknown: { keep: [1, 2] }, leapLiveMarker: 'one' })
  })

  it('redoes a change after a real 409 from another device', async () => {
    const config = loadConfig()
    let interfered = false
    const realFetch: FetchLike = (input, init) => fetch(input, init)
    // Before leap's first PUT lands, another "device" writes with the same base revision.
    const wrapped: FetchLike = async (input, init) => {
      if (init?.method === 'PUT' && !interfered) {
        interfered = true
        const sent = JSON.parse(String(init.body)) as { state: State; baseRev: number }
        const other = { ...sent.state, leapLiveOther: 'phone', _ts: (sent.state._ts as number) - 1 }
        const r = await realFetch(`${config.baseUrl}/api/data`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: other, baseRev: sent.baseRev }),
        })
        expect(r.status).toBe(200)
      }
      return realFetch(input, init)
    }
    const { store } = liveStore(wrapped)
    const r = await store.update((d) => marker(d, 'leapLiveMarker', 'two'))
    expect(r.ok, !r.ok ? r.message : '').toBe(true)
    expect(r.ok && r.data.retries).toBe(1)
    const after = await liveStore().store.load()
    expect(after.ok && after.data.state).toMatchObject({ leapLiveOther: 'phone', leapLiveMarker: 'two' })
  })
})
