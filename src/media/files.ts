import { createHash } from 'node:crypto'
import { openSync, closeSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { inspect, KIND_OF, type MediaInfo, type MediaMime } from './inspect.js'
import { stripMetadata } from './strip.js'

/** openGym refuses anything over 200 MB in a reference; nothing larger is read. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024

export function expandPath(p: string): string {
  const raw = p.trim()
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded)) throw new Error(`give an absolute path (or one starting with ~/), got "${p}"`)
  return resolve(expanded)
}

export interface Prepared {
  path: string
  bytes: Uint8Array
  info: MediaInfo
  hash: string
  /** Bytes removed with the metadata. */
  stripped: number
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/**
 * Reads a local photo or video for upload: a regular file, within openGym's
 * size limit, whose bytes are one of the seven accepted types. Stills lose
 * their metadata (location, camera, time) and keep their orientation; a video
 * that records a location is refused, since removing it means rewriting the file.
 */
export function prepareUpload(path: string): Prepared {
  const real = realpathSync(expandPath(path))
  const st = statSync(real)
  if (!st.isFile()) throw new Error(`${real} is not a file`)
  if (st.size === 0) throw new Error(`${real} is empty`)
  if (st.size > MAX_FILE_BYTES) throw new Error(`${real} is ${Math.round(st.size / 1048576)} MB; openGym takes at most 200 MB`)
  const original = new Uint8Array(readFileSync(real))
  const info = inspect(original)
  if (info.hasLocation) {
    throw new Error('this video records where it was filmed; remove the location first (e.g. export it again without location) — leap does not upload it')
  }
  const bytes = stripMetadata(original, info.mime)
  return { path: real, bytes, info, hash: sha256(bytes), stripped: original.length - bytes.length }
}

const EXT: Record<MediaMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

export const extensionOf = (mime: string) => (mime in KIND_OF ? EXT[mime as MediaMime] : 'bin')

/** Writes a new file; an existing path is never overwritten. A directory gets `<hash>.<ext>`. */
export function saveNew(target: string, hash: string, mime: string, bytes: Uint8Array): string {
  let path = expandPath(target)
  try {
    if (statSync(path).isDirectory()) path = join(path, `${hash}.${extensionOf(mime)}`)
  } catch {
    // not there yet: a file name
  }
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
  return path
}
