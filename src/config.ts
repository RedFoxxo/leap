import { TOOLSETS, type Toolset } from './tools/types.js'

export interface Config {
  /** Instance root without a trailing slash, e.g. `https://gym.example.com`. */
  baseUrl: string
  /** Bearer token from `leap pair`. Empty only for commands that do not need one. */
  token: string
  /** Tool groups to expose; every group when unset. */
  toolsets?: Toolset[]
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** Validates `OPENGYM_URL`. Returns the normalised root, or pushes a problem. */
function baseUrlOf(env: NodeJS.ProcessEnv, problems: string[]): string {
  const raw = env.OPENGYM_URL?.trim()
  if (!raw) {
    problems.push('OPENGYM_URL is required, e.g. https://gym.example.com')
    return ''
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Not echoed: a malformed value can still hold a password.
    problems.push('OPENGYM_URL is not a valid URL')
    return ''
  }
  // Checked first, and every message below shows the URL without them.
  if (url.username || url.password) {
    problems.push('OPENGYM_URL must not contain credentials')
    return ''
  }
  const shown = `${url.protocol}//${url.host}${url.pathname}`
  const local = LOCAL_HOSTS.includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    problems.push(`OPENGYM_URL must be an https URL (the token is sent with every request), got "${shown}"`)
  } else if (/\/api(\/|$)/i.test(url.pathname)) {
    problems.push(`OPENGYM_URL must be the instance root without /api/..., got "${shown}"`)
  } else if (url.search || url.hash) {
    problems.push('OPENGYM_URL must not contain a query string or fragment')
  } else {
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  }
  return ''
}

function toolsets(env: NodeJS.ProcessEnv, problems: string[]): Toolset[] | undefined {
  const raw = env.LEAP_TOOLSETS?.trim()
  if (!raw) return undefined
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0) {
    problems.push(`LEAP_TOOLSETS names no toolset (known: ${TOOLSETS.join(', ')}); unset it to register them all`)
    return undefined
  }
  const unknown = names.filter((n) => !TOOLSETS.some((t) => t === n))
  if (unknown.length > 0) {
    problems.push(`LEAP_TOOLSETS has unknown toolsets: ${unknown.join(', ')} (known: ${TOOLSETS.join(', ')})`)
    return undefined
  }
  return TOOLSETS.filter((t) => names.includes(t))
}

function fail(problems: string[]): never {
  throw new ConfigError(`Invalid leap configuration:\n- ${problems.join('\n- ')}`)
}

/** Reads and validates the environment. Throws `ConfigError` listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []
  const baseUrl = baseUrlOf(env, problems)
  const token = env.OPENGYM_TOKEN?.trim() ?? ''
  if (!token) problems.push('OPENGYM_TOKEN is required: run `npx -y @redfoxxo/leap pair` to get one')
  const sets = toolsets(env, problems)
  if (problems.length > 0) fail(problems)
  return sets === undefined ? { baseUrl, token } : { baseUrl, token, toolsets: sets }
}

/** For `leap pair`, which needs the instance but has no token yet. */
export function loadPairConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []
  const baseUrl = baseUrlOf(env, problems)
  if (problems.length > 0) fail(problems)
  return { baseUrl, token: '' }
}
