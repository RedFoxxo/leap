import type { Config } from '../config.js'
import { HttpCore, type FetchLike } from '../http/core.js'
import { silentLogger, type Logger } from '../log.js'
import { defaultBackupDir, fileBackups, type BackupWriter } from '../state/backup.js'
import { StateStore } from '../state/store.js'

/** Everything a tool handler may use. Built once per server. */
export interface ToolContext {
  config: Config
  http: HttpCore
  /** The profile document: reads, and every write (read-modify-write with conflict retry). */
  store: StateStore
  log: Logger
}

export interface ContextOptions {
  fetch?: FetchLike
  log?: Logger
  /** Where pre-write backups go. Defaults to files under the user's state directory; `null` disables them (tests). */
  backup?: BackupWriter | null
  /** Clock for write stamps (tests). */
  now?: () => number
}

export function createContext(config: Config, options: ContextOptions = {}): ToolContext {
  const log = options.log ?? silentLogger
  const httpOptions = { baseUrl: config.baseUrl, token: config.token, log }
  const http = new HttpCore(options.fetch ? { ...httpOptions, fetch: options.fetch } : httpOptions)
  const backup = options.backup === undefined ? fileBackups(defaultBackupDir(config.baseUrl)) : (options.backup ?? undefined)
  const store = new StateStore(http, {
    ...(backup ? { backup } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  return { config, http, store, log }
}
