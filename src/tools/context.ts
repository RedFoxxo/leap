import { BuiltinCatalogProvider, ExerciseIndex, type BuiltinCatalog } from '../catalog/exercises.js'
import { ServerCheck } from '../compat.js'
import type { Config } from '../config.js'
import { HttpCore, type FetchLike } from '../http/core.js'
import type { Result } from '../http/result.js'
import { ok } from '../http/result.js'
import { silentLogger, type Logger } from '../log.js'
import { defaultBackupDir, fileBackups, type BackupWriter } from '../state/backup.js'
import { StateStore } from '../state/store.js'
import type { Snapshot } from '../state/types.js'

/** Everything a tool handler may use. Built once per server. */
export interface ToolContext {
  config: Config
  http: HttpCore
  /** The profile document: reads, and every write (read-modify-write with conflict retry). */
  store: StateStore
  /** openGym's built-in exercises (names, muscles, instructions). */
  builtinExercises: () => Promise<BuiltinCatalog>
  log: Logger
  /** The clock writes are stamped with; "today" for a write tool comes from it too. */
  now: () => number
  /** Which openGym the instance runs; profile writes are refused on one this release does not support. */
  server: ServerCheck
}

export interface ContextOptions {
  fetch?: FetchLike
  log?: Logger
  /** Where pre-write backups go. Defaults to files under the user's state directory; `null` disables them (tests). */
  backup?: BackupWriter | null
  /** Clock for write stamps (tests). */
  now?: () => number
  /** Override the built-in exercise catalogue (tests). Defaults to the cached upstream dataset, loaded in the background. */
  builtinExercises?: () => Promise<BuiltinCatalog>
}

export function createContext(config: Config, options: ContextOptions = {}): ToolContext {
  const log = options.log ?? silentLogger
  const httpOptions = { baseUrl: config.baseUrl, token: config.token, log }
  const http = new HttpCore(options.fetch ? { ...httpOptions, fetch: options.fetch } : httpOptions)
  const backup = options.backup === undefined ? fileBackups(defaultBackupDir(config.baseUrl)) : (options.backup ?? undefined)
  const now = options.now ?? Date.now
  const server = new ServerCheck(http, now)
  const store = new StateStore(http, { ...(backup ? { backup } : {}), now, server: () => server.writable() })
  let builtinExercises = options.builtinExercises
  if (!builtinExercises) {
    const provider = new BuiltinCatalogProvider({ log })
    builtinExercises = () => provider.get()
  }
  return { config, http, store, builtinExercises, log, now, server }
}

/** The profile document and every exercise it can use, loaded together. */
export async function loadProfile(ctx: ToolContext): Promise<Result<Snapshot & { exercises: ExerciseIndex }>> {
  const [snapshot, builtin] = await Promise.all([ctx.store.load(), ctx.builtinExercises()])
  if (!snapshot.ok) return snapshot
  return ok({ ...snapshot.data, exercises: new ExerciseIndex(builtin, snapshot.data.state) }, snapshot.status)
}
