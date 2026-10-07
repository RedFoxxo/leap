import type { Config } from '../config.js'
import { HttpCore, type FetchLike } from '../http/core.js'
import { silentLogger, type Logger } from '../log.js'

/** Everything a tool handler may use. Built once per server. */
export interface ToolContext {
  config: Config
  http: HttpCore
  log: Logger
}

export interface ContextOptions {
  fetch?: FetchLike
  log?: Logger
}

export function createContext(config: Config, options: ContextOptions = {}): ToolContext {
  const log = options.log ?? silentLogger
  const httpOptions = { baseUrl: config.baseUrl, token: config.token, log }
  const http = new HttpCore(options.fetch ? { ...httpOptions, fetch: options.fetch } : httpOptions)
  return { config, http, log }
}
