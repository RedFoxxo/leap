import { describe, expect, it } from 'vitest'
import { HttpCore } from '../src/http/core.js'
import { redactBody } from '../src/http/redact.js'
import { normalizeCode, redeem } from '../src/pair.js'
import { FetchStub } from './helpers/fetch-stub.js'
import { BASE, TOKEN } from './helpers/harness.js'

function http(stub: FetchStub, token = TOKEN, lines: string[] = []): HttpCore {
  return new HttpCore({ baseUrl: BASE, token, fetch: stub.fetch, log: (l) => lines.push(l) })
}

describe('HttpCore', () => {
  it('sends the token as a Bearer header, never in the URL', async () => {
    const stub = new FetchStub().get('/api/me', { user: { id: 'u1', name: 'Ada' } })
    const lines: string[] = []
    await http(stub, TOKEN, lines).request({ method: 'GET', path: '/api/me' })
    const call = stub.calls[0]!
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.url.toString()).not.toContain(TOKEN)
    expect(lines.join('\n')).not.toContain(TOKEN)
  })

  it('never follows a redirect, so the token cannot travel to another host', async () => {
    const stub = new FetchStub().get('/api/me', '', { status: 302, headers: { location: 'https://evil.example/steal' } })
    const r = await http(stub).request({ method: 'GET', path: '/api/me' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/redirected to https:\/\/evil\.example\/steal; check OPENGYM_URL/)
    expect(stub.calls).toHaveLength(1)
  })

  it('keeps the configured token out of error bodies, network errors and token fields of a failed answer', async () => {
    const body = { error: `bad token ${TOKEN}`, token: 'other.secret' }
    const stub = new FetchStub()
      .on({ method: 'POST', path: '/api/pair/redeem', status: 400, body })
      .on({ method: 'GET', path: '/api/me', networkError: `connect failed for ${TOKEN}` })
    const failed = await http(stub).request({ method: 'POST', path: '/api/pair/redeem', json: {}, keepTokens: true })
    expect(JSON.stringify(failed)).not.toContain(TOKEN)
    expect(JSON.stringify(failed)).not.toContain('other.secret')
    const offline = await http(stub).request({ method: 'GET', path: '/api/me' })
    expect(JSON.stringify(offline)).not.toContain(TOKEN)
  })

  it('names a proxy’s error page as such, and a success page as a wrong URL', async () => {
    const stub = new FetchStub().get('/api/a', '<html>Bad Gateway</html>', { status: 502 }).get('/api/b', '<!doctype html><p>app</p>')
    const a = await http(stub).request({ method: 'GET', path: '/api/a' })
    expect(!a.ok && a.message).toMatch(/error page from a proxy/)
    const b = await http(stub).request({ method: 'GET', path: '/api/b' })
    expect(!b.ok && b.message).toMatch(/is OPENGYM_URL the openGym instance/)
  })

  it('sends no Authorization header without a token', async () => {
    const stub = new FetchStub().get('/api/health', { ok: true })
    await http(stub, '').request({ method: 'GET', path: '/api/health' })
    expect(stub.calls[0]!.headers.Authorization).toBeUndefined()
  })

  it('reports openGym errors with message, code and Retry-After', async () => {
    const stub = new FetchStub().on({
      method: 'POST',
      path: '/api/login/password',
      status: 429,
      body: { error: 'too many attempts — try again later', code: 'locked', retryAfter: 60 },
      headers: { 'retry-after': '60' },
    })
    const r = await http(stub).request({ method: 'POST', path: '/api/login/password', json: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(429)
    expect(r.message).toBe('429: too many attempts — try again later')
    expect(r.code).toBe('locked')
    expect(r.retryAfter).toBe(60)
  })

  it('redacts tokens from response bodies', async () => {
    const stub = new FetchStub().get('/api/me', { user: { id: 'u1', name: 'Ada' }, token: 'renewed.secret' })
    const r = await http(stub).request<{ token: string }>({ method: 'GET', path: '/api/me' })
    expect(r.ok && r.data.token).toBe('***')
  })

  it('says a write may have been applied when no response arrived', async () => {
    const stub = new FetchStub().on({ method: 'PUT', path: '/api/data', networkError: 'socket hang up' })
    const r = await http(stub).request({ method: 'PUT', path: '/api/data', json: { state: {} } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(0)
    expect(r.message).toMatch(/may or may not have been applied/)
  })

  it('flags an HTML page as a wrong URL', async () => {
    const stub = new FetchStub().get('/api/me', '<!DOCTYPE html><html></html>', { headers: { 'content-type': 'text/html' } })
    const r = await http(stub).request({ method: 'GET', path: '/api/me' })
    expect(!r.ok && r.message).toMatch(/HTML page/)
  })

  it('returns raw bytes for downloads', async () => {
    const stub = new FetchStub().get(/^\/api\/media\//, 'GIF89a', { headers: { 'content-type': 'image/gif' } })
    const r = await http(stub).request({ method: 'GET', path: '/api/media/abc', expect: 'bytes' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.contentType).toBe('image/gif')
    expect(new TextDecoder().decode(r.data.data)).toBe('GIF89a')
  })
})

describe('redactBody', () => {
  it('removes the configured token and every token field', () => {
    expect(redactBody(`{"a":"${TOKEN}","token":"other.value"}`, TOKEN)).toBe('{"a":"***","token":"***"}')
  })
})

describe('pairing', () => {
  it('normalises codes and rejects impossible ones', () => {
    expect(normalizeCode('k7wq-2mzp')).toBe('K7WQ2MZP')
    expect(normalizeCode('K7WQ2MZ0')).toBeUndefined()
    expect(normalizeCode('SHORT')).toBeUndefined()
  })

  it('redeems a code and keeps the token', async () => {
    const stub = new FetchStub().post('/api/pair/redeem', { token: 'uid:1:0.hmac', user: { id: 'u1', name: 'Ada' } })
    const r = await redeem(http(stub, ''), 'k7wq2mzp')
    expect(r.ok && r.data.token).toBe('uid:1:0.hmac')
    expect(stub.calls[0]!.body).toEqual({ code: 'K7WQ2MZP' })
  })

  it('sends nothing for a malformed code', async () => {
    const stub = new FetchStub()
    const r = await redeem(http(stub, ''), 'nope')
    expect(r.ok).toBe(false)
    expect(stub.calls).toHaveLength(0)
  })

  it('passes openGym’s refusal through', async () => {
    const stub = new FetchStub().post('/api/pair/redeem', { error: 'invalid or expired code' }, { status: 400 })
    const r = await redeem(http(stub, ''), 'K7WQ2MZP')
    expect(!r.ok && r.message).toBe('400: invalid or expired code')
  })
})
