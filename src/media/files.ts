import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { inspect, type MediaInfo, type MediaMime } from './inspect.js'
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
  // One handle for the checks and the read, so the path cannot be swapped in between; a pipe or device
  // opened non-blocking is refused by the size and type checks instead of hanging the server.
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let original: Uint8Array
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`${real} is not a file`)
    if (st.size === 0) throw new Error(`${real} is empty`)
    if (st.size > MAX_FILE_BYTES) throw new Error(`${real} is ${Math.round(st.size / 1048576)} MB; openGym takes at most 200 MB`)
    original = new Uint8Array(st.size)
    let read = 0
    while (read < st.size) {
      const n = readSync(fd, original, read, st.size - read, read)
      if (n === 0) throw new Error(`${real} changed while it was read`)
      read += n
    }
  } finally {
    closeSync(fd)
  }
  const info = inspect(original)
  if (info.hasLocation) {
    throw new Error('this video records where it was filmed; remove the location first (e.g. export it again without location) — leap does not upload it')
  }
  const bytes = stripMetadata(original, info.mime)
  // What is uploaded must still be the same picture: read it again rather than trust the stripper.
  const again = inspect(bytes)
  if (again.mime !== info.mime || again.width !== info.width || again.height !== info.height) {
    throw new Error('the file could not be cleaned of its metadata without changing it; it is not uploaded')
  }
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

const HIDDEN = 'downloads are not saved in hidden folders or as hidden files'

/**
 * Where a download goes, checked before anything is downloaded: an existing
 * folder, as given and with links resolved (a link to a hidden folder counts as
 * one), and the file name when `target` is not a folder.
 */
export function downloadTarget(target: string): { folder: string; name?: string } {
  const given = expandPath(target)
  let isDir = false
  try {
    isDir = statSync(given).isDirectory()
  } catch {
    // not there yet: a file name
  }
  const folder = isDir ? given : dirname(given)
  let real: string
  try {
    real = realpathSync(folder)
  } catch {
    throw new Error(`the folder ${folder} does not exist`)
  }
  if ([...folder.split(sep), ...real.split(sep)].some((part) => part.startsWith('.'))) throw new Error(HIDDEN)
  return isDir ? { folder: real } : { folder: real, name: basename(given) }
}

/**
 * Writes a new file; an existing path is never overwritten. A directory gets
 * `<hash>.<ext>`; a file name must carry the extension of the file's type, and
 * no part of the path, as given or with links resolved, may be hidden (shells
 * and desktops load files from hidden folders such as ~/.bashrc.d or
 * ~/.config/autostart).
 */
export function saveNew(target: string, hash: string, mime: MediaMime, bytes: Uint8Array): string {
  const ext = EXT[mime]
  const { folder, name: given } = downloadTarget(target)
  const allowed = ext === 'jpg' ? ['jpg', 'jpeg'] : [ext]
  if (given !== undefined && !allowed.some((e) => given.toLowerCase().endsWith(`.${e}`))) throw new Error(`the file name must end in .${ext} for this ${mime} file`)
  const name = given ?? `${hash}.${ext}`
  if (name.startsWith('.')) throw new Error(HIDDEN)
  const path = join(folder, name)
  const fd = openSync(path, 'wx', 0o600)
  try {
    for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done)
  } catch (error) {
    closeSync(fd)
    unlinkSync(path)
    throw error
  }
  closeSync(fd)
  return path
}
