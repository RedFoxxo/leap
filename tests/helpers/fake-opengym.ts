import { FetchStub, StubReply, type StubCall } from './fetch-stub.js'

type Doc = Record<string, unknown>

const isMap = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Lists whose removals openGym records, how it names an entry, and when the entry was last edited. */
const DEL_LISTS: Record<string, { key: (x: any) => string; time: (x: any) => number }> = {
  workouts: { key: (w) => (w?.id != null ? String(w.id) : `${w?.d}|${w?.start}`), time: (w) => Number(w?._ts) || Number(w?.end) || Number(w?.start) || 0 },
  routines: { key: (x) => String(x?.id), time: (x) => Number(x?._ts) || 0 },
  customEx: { key: (x) => String(x?.id), time: (x) => Number(x?._ts) || 0 },
  bodyweight: { key: (e) => String(e?.d), time: (e) => Number(e?.t) || 0 },
  measurements: { key: (e) => String(e?.d), time: (e) => Number(e?.t) || 0 },
  gymCards: { key: (x) => String(x?.id), time: (x) => Number(x?._ts) || 0 },
  equipProfiles: { key: (x) => String(x?.id), time: (x) => Number(x?._ts) || 0 },
  favEx: { key: (x) => String(x), time: () => 0 },
}

/**
 * A stateful stand-in for openGym 1.4.0's `/api/data`, following `PUT /api/data`
 * in openGym's api/server.js and the stamping writer's path of api/sync-stamps.js
 * (see docs/OPENGYM.md): conditional write on `baseRev` and `baseWid` with a 409
 * carrying the current document, `active` and the server-only notes stripped,
 * `deleted` and `edited` joined with the stored ones, entries held against a
 * removal on record marked as added back, `_rev`/`_wid`/`_wids` set by the
 * server, and the same refusals. leap always writes as a stamping client, so a
 * PUT without `stamped: true` is refused here to make a regression fail loudly
 * (the real server would accept it and correct it).
 */
export class FakeOpenGym {
  readonly stub: FetchStub
  state: Doc | null
  rev: number
  /** Every document accepted by PUT, in order. */
  readonly puts: Doc[] = []
  /** Every PUT body as sent (state, baseRev, baseWid, stamped). */
  readonly bodies: Doc[] = []
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
  /** What `GET /api/health` answers (openGym 1.4.0 adds `writable`). */
  health: { status: number; body: unknown } = { status: 200, body: { ok: true, users: 1, writable: true } }
  private wids = 0

  constructor(state: Doc | null = null, rev = state ? 1 : 0, stub = new FetchStub()) {
    this.state = state ? structuredClone(state) : null
    this.rev = rev
    if (this.state) this.state._rev = rev
    this.stub = stub
    stub.on({ method: 'GET', path: '/api/health', body: () => new StubReply(this.health.status, this.health.body) })
    stub.on({ method: 'GET', path: '/api/data', body: () => ({ state: this.state ? structuredClone(this.state) : null, rev: this.rev }) })
    stub.on({ method: 'GET', path: '/api/data/rev', body: () => ({ rev: this.rev, ...(typeof this.state?._wid === 'string' ? { wid: this.state._wid } : {}) }) })
    stub.on({ method: 'PUT', path: '/api/data', body: (call: StubCall) => this.put(call) })
  }

  /** Another device's write: applies `change` to the stored document as an accepted PUT. */
  otherDeviceWrites(change: (state: Doc) => void): void {
    const next = structuredClone(this.state ?? {})
    change(next)
    this.rev++
    next._rev = this.rev
    this.stampWrite(next)
    this.state = next
  }

  private stampWrite(doc: Doc): void {
    const before = this.state
    if (typeof before?._wid === 'string') doc._wids = [...(Array.isArray(before._wids) ? before._wids : []), before._wid].slice(-50)
    doc._wid = `w${String(++this.wids).padStart(15, '0')}`
  }

  private put(call: StubCall): unknown {
    this.beforePut?.(this)
    if (this.failBeforeApply > 0) {
      this.failBeforeApply--
      throw new TypeError('fetch failed')
    }
    const body = call.body as { state?: unknown; baseRev?: unknown; baseWid?: unknown; stamped?: unknown }
    this.bodies.push(structuredClone(body) as Doc)
    const state = body?.state
    if (!state || typeof state !== 'object') return new StubReply(400, { error: 'state required' })
    if (Array.isArray(state)) return new StubReply(400, { error: 'invalid state' })
    if (body.stamped !== true) return new StubReply(400, { error: 'fake openGym: leap must write with stamped: true' })
    const doc = structuredClone(state) as Doc
    if (!Object.keys(doc).some((k) => k !== '_rev' && k !== '_ts')) return new StubReply(400, { error: 'state required' })
    const listOk = (v: unknown) => v == null || Array.isArray(v)
    if (!listOk(doc.workouts) || !listOk(doc.routines)) return new StubReply(400, { error: 'invalid state' })
    const wid = this.state?._wid
    if (body.baseRev != null && (body.baseRev !== this.rev || (typeof body.baseWid === 'string' && typeof wid === 'string' && body.baseWid !== wid))) {
      return new StubReply(409, { error: 'conflict', rev: this.rev, state: this.state })
    }
    delete doc.active
    delete doc._unstamped
    delete doc._prior
    if (this.state) {
      const d = joinDeleted(this.state.deleted, doc.deleted)
      if (d) doc.deleted = d
      else delete doc.deleted
      const e = joinEdited(this.state.edited, doc.edited)
      if (e) doc.edited = e
      else delete doc.edited
    }
    keepHeld(doc)
    this.rev++
    doc._rev = this.rev
    this.stampWrite(doc)
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
    return { ok: true, ts: doc._ts ?? null, rev: this.rev, wid: doc._wid }
  }
}

/** Removal records of both copies: per entry the later stamp, the add-back on a tie. */
function joinDeleted(a: unknown, b: unknown): Doc | null {
  const out: Doc = {}
  for (const f of Object.keys(DEL_LISTS)) {
    const x = isMap(a) && isMap(a[f]) ? a[f] : {}
    const y = isMap(b) && isMap(b[f]) ? b[f] : {}
    const m: Record<string, number> = { ...(x as Record<string, number>) }
    for (const [k, v] of Object.entries(y as Record<string, number>)) {
      const cur = m[k]
      if (cur === undefined || Math.abs(v) > Math.abs(cur) || (Math.abs(v) === Math.abs(cur) && v < cur)) m[k] = v
    }
    if (Object.keys(m).length) out[f] = m
  }
  return Object.keys(out).length ? out : null
}

/** Edit stamps of both copies: per key the later one. */
function joinEdited(a: unknown, b: unknown): Doc | null {
  const out: Record<string, number> = { ...((isMap(a) ? a : {}) as Record<string, number>) }
  for (const [k, v] of Object.entries((isMap(b) ? b : {}) as Record<string, number>)) if (!((out[k] ?? 0) >= v)) out[k] = v
  return Object.keys(out).length ? out : null
}

/** An entry the document holds although a removal on record is at least its time: kept, marked as added back. */
function keepHeld(doc: Doc): void {
  const del = doc.deleted
  if (!isMap(del)) return
  for (const [f, { key, time }] of Object.entries(DEL_LISTS)) {
    const m = del[f]
    if (!isMap(m) || !Array.isArray(doc[f])) continue
    for (const x of doc[f] as unknown[]) {
      if (x == null) continue
      const at = Number(m[key(x)]) || 0
      if (at > 0 && at >= time(x)) m[key(x)] = -(at + 1)
    }
  }
}
