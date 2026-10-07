import type { Logger } from '../log.js'
import { VERSION } from '../version.js'
import { redactBody, redactToken } from './redact.js'
import { err, ok, type Err, type Result } from './result.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  baseUrl: string
  token: string
  fetch?: FetchLike
  log?: Logger
  timeoutMs?: number
}

export type QueryValue = string | number | boolean | undefined | null
export type Query = Record<string, QueryValue>

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface RequestSpec {
  method: Method
  /** Path below the instance root, starting with `/api/`. */
  path: string
  query?: Query
  /** JSON request body. */
  json?: unknown
  /** Raw request body (media upload) with its content type. */
  bytes?: { data: Uint8Array; contentType: string }
  /** Extra request headers. */
  headers?: Record<string, string>
  /** `json` (default) requires a JSON response; `bytes` returns the raw body. */
  expect?: 'json' | 'bytes'
  /** Keep `"token"` fields in the response body. Only `leap pair` needs this. */
  keepTokens?: boolean
  /** Overrides the default timeout (file transfers). */
  timeoutMs?: number
}

export interface Bytes {
  data: Uint8Array
  contentType: string
}

const DEFAULT_TIMEOUT_MS = 60_000
/** Routes whose answers can carry a session token: a renewed one on /api/me, pairing, a password change. */
const TOKEN_ROUTES = /^\/api\/(me|pair\/|account\/|login|register|device-link)/
const BODY_CAP = 4000

/**
 * The single place where leap talks to openGym. Adds the Bearer token, logs
 * the request to stderr, and turns every outcome into a `Result`.
 */
export class HttpCore {
  readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: FetchLike
  private readonly log: Logger
  private readonly timeoutMs: number

  constructor(options: HttpOptions) {
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.log = options.log ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  url(path: string, query: Query = {}): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      params.set(key, String(value))
    }
    const search = params.toString()
    return `${this.baseUrl}${path}${search ? `?${search}` : ''}`
  }

  redact(text: string): string {
    return redactBody(text, this.token)
  }

  async request(spec: RequestSpec & { expect: 'bytes' }): Promise<Result<Bytes>>
  async request<T = unknown>(spec: RequestSpec): Promise<Result<T>>
  async request<T = unknown>(spec: RequestSpec): Promise<Result<T | Bytes>> {
    const url = this.url(spec.path, spec.query)
    const shown = `${spec.method} ${spec.path}`
    this.log(shown)

    const headers: Record<string, string> = {
      Accept: spec.expect === 'bytes' ? '*/*' : 'application/json',
      'User-Agent': `leap/${VERSION}`,
      ...spec.headers,
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    let body: string | Uint8Array | undefined
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(spec.json)
    } else if (spec.bytes) {
      headers['Content-Type'] = spec.bytes.contentType
      body = spec.bytes.data
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: body as RequestInit['body'],
        redirect: 'manual',
        signal: AbortSignal.timeout(spec.timeoutMs ?? this.timeoutMs),
      })
    } catch (error) {
      const reason = this.redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      const unknown = spec.method === 'GET' ? '' : `; the ${spec.method} may or may not have been applied, so check before retrying`
      return err(0, `No response from openGym (${reason})${unknown}`, reason, shown)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      return err(
        response.status,
        `openGym redirected to ${location || 'another page'}; check OPENGYM_URL (https, no /api suffix)`,
        '',
        shown,
      )
    }

    if (response.ok && spec.expect === 'bytes') {
      try {
        const data = new Uint8Array(await response.arrayBuffer())
        return ok({ data, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }, response.status)
      } catch (error) {
        return err(response.status, `Could not read the file (${error instanceof Error ? error.message : String(error)})`, '', shown)
      }
    }

    let text: string
    try {
      const raw = await response.text()
      // The configured token never appears in a body. `"token"` fields are removed only where openGym hands
      // tokens out; elsewhere (the profile document) such a field is user data and must round-trip intact.
      const handsOutTokens = TOKEN_ROUTES.test(spec.path) && !(spec.keepTokens && response.ok)
      text = handsOutTokens ? this.redact(raw) : redactToken(raw, this.token)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const unknown =
        spec.method === 'GET'
          ? ''
          : `; openGym answered ${response.status}${response.ok ? ', so the write was most likely applied' : ''}: check before retrying`
      return err(response.status, `Could not read the response body (${reason})${unknown}`, '', shown)
    }

    if (!response.ok) return errorResult(response, text, shown)

    if (text.trim() === '') return ok(null as T, response.status)
    try {
      return ok(JSON.parse(text) as T, response.status)
    } catch {
      return err(response.status, `Expected JSON from openGym but got ${describeBody(text)}`, capBody(text), shown)
    }
  }
}

function errorResult(response: Response, text: string, shown: string): Err {
  const e = err(response.status, errorMessage(response.status, text), capBody(text), shown)
  const parsed = parseObject(text)
  if (typeof parsed?.code === 'string') e.code = parsed.code
  const retry = Number(response.headers.get('retry-after') ?? parsed?.retryAfter)
  if (Number.isFinite(retry) && retry > 0) e.retryAfter = retry
  return e
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Error bodies go into tool output; an HTML error page must not flood it. */
function capBody(text: string): string {
  return text.length <= BODY_CAP ? text : `${text.slice(0, BODY_CAP)}… (${text.length - BODY_CAP} more characters)`
}

function describeBody(text: string): string {
  const head = text.trimStart().slice(0, 15).toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'an HTML page (is OPENGYM_URL the openGym instance?)'
  return 'a non-JSON body'
}

/** openGym's own message: every error body is `{"error": "..."}`. */
export function errorMessage(status: number, text: string): string {
  const parsed = parseObject(text)
  if (typeof parsed?.error === 'string' && parsed.error) return `${status}: ${parsed.error}`
  const trimmed = text.trim()
  if (trimmed.startsWith('<')) return `${status}: openGym returned ${describeBody(trimmed)}`
  const firstLine = trimmed.split('\n', 1)[0]?.slice(0, 200)
  return firstLine ? `${status}: ${firstLine}` : `${status}: request failed with no body`
}
