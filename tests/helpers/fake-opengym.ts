import { FetchStub, StubReply, type StubCall } from './fetch-stub.js'

/**
 * A stateful stand-in for openGym's `/api/data`, following the rules of
 * `PUT /api/data` in openGym's api/server.js (see docs/OPENGYM.md): conditional
 * write on `baseRev` with a 409 carrying the current document, `active`
 * stripped, `_rev` set by the server, and the same refusals.
 */
export class FakeOpenGym {
  readonly stub: FetchStub
  state: Record<string, unknown> | null
  rev: number
  /** Every document accepted by PUT, in order. */
  readonly puts: Record<string, unknown>[] = []
  /** Runs before each PUT is judged: simulate another device writing first. */
  beforePut: ((fake: FakeOpenGym) => void) | undefined
  /** Accept the next N PUTs but drop their response (network failure after the write). */
  dropResponses = 0
  /** Fail the next N PUTs without applying them (network failure before the write). */
  failBeforeApply = 0
  /** Accept the next N PUTs but answer 504, as a reverse proxy that gave up waiting does. */
  gatewayAfterApply = 0
  /** Runs right after a PUT was applied: simulate another device writing before leap re-reads. */
  afterApply: ((fake: FakeOpenGym) => void) | undefined

  constructor(state: Record<string, unknown> | null = null, rev = state ? 1 : 0, stub = new FetchStub()) {
    this.state = state ? structuredClone(state) : null
    this.rev = rev
    if (this.state) this.state._rev = rev
    this.stub = stub
    stub.on({ method: 'GET', path: '/api/data', body: () => ({ state: this.state ? structuredClone(this.state) : null, rev: this.rev }) })
    stub.on({ method: 'GET', path: '/api/data/rev', body: () => ({ rev: this.rev }) })
    stub.on({ method: 'PUT', path: '/api/data', body: (call: StubCall) => this.put(call) })
  }

  /** Another device's write: applies `change` to the stored document as an accepted PUT. */
  otherDeviceWrites(change: (state: Record<string, unknown>) => void): void {
    const next = structuredClone(this.state ?? {})
    change(next)
    this.rev++
    next._rev = this.rev
    this.state = next
  }

  private put(call: StubCall): unknown {
    this.beforePut?.(this)
    if (this.failBeforeApply > 0) {
      this.failBeforeApply--
      throw new TypeError('fetch failed')
    }
    const body = call.body as { state?: unknown; baseRev?: unknown }
    const state = body?.state
    if (!state || typeof state !== 'object') return new StubReply(400, { error: 'state required' })
    if (Array.isArray(state)) return new StubReply(400, { error: 'invalid state' })
    const doc = structuredClone(state) as Record<string, unknown>
    if (!Object.keys(doc).some((k) => k !== '_rev' && k !== '_ts')) return new StubReply(400, { error: 'state required' })
    const listOk = (v: unknown) => v == null || Array.isArray(v)
    if (!listOk(doc.workouts) || !listOk(doc.routines)) return new StubReply(400, { error: 'invalid state' })
    if (body.baseRev != null && body.baseRev !== this.rev) {
      return new StubReply(409, { error: 'conflict', rev: this.rev, state: this.state })
    }
    delete doc.active
    this.rev++
    doc._rev = this.rev
    this.state = doc
    this.puts.push(structuredClone(doc))
    this.afterApply?.(this)
    if (this.gatewayAfterApply > 0) {
      this.gatewayAfterApply--
      return new StubReply(504, '<html><body>504 Gateway Time-out</body></html>')
    }
    if (this.dropResponses > 0) {
      this.dropResponses--
      throw new TypeError('socket hang up')
    }
    return { ok: true, ts: doc._ts ?? null, rev: this.rev }
  }
}
