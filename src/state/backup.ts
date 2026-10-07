import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { State } from './types.js'

/** Writes a copy of the document as it was before a write. Returns the file path. */
export type BackupWriter = (state: State, rev: number) => string

const KEEP = 50

/** `$XDG_STATE_HOME/leap/backups/<instance>`, or `~/.local/state/leap/backups/<instance>`. */
export function defaultBackupDir(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
  const instance = baseUrl.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_')
  return join(root, 'leap', 'backups', instance)
}

/**
 * Keeps the newest `keep` backups in `dir`, readable by the owner only. A
 * profile is personal data, and the document holds everything of it.
 */
export function fileBackups(dir: string, keep = KEEP, now: () => Date = () => new Date()): BackupWriter {
  return (state, rev) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `${stamp}-rev${rev}.json`)
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, old), { force: true })
    return file
  }
}
