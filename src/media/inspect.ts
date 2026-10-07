/**
 * What a media file is, read from its own bytes: type, pixel size, and for
 * videos duration and codec. Written from the file-format specifications
 * (JPEG/JFIF, PNG, GIF89a, WebP/RIFF, ISO-BMFF, Matroska/EBML); nothing is
 * decoded. openGym accepts exactly these seven types (docs/OPENGYM.md, "Media").
 */

export type MediaMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/quicktime' | 'video/webm'
export type MediaKind = 'image' | 'gif' | 'video'
export type Codec = 'avc1' | 'hvc1' | 'av01' | 'vp09' | 'vp8' | 'vp9' | 'other'

export const KIND_OF: Record<MediaMime, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'gif',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
}

export interface MediaInfo {
  mime: MediaMime
  kind: MediaKind
  width: number
  height: number
  /** Seconds (videos), one decimal. */
  dur?: number
  codec?: Codec
  /** JPEG EXIF orientation 1–8 (1 when absent). */
  orientation?: number
  /** A video carries a recording location (QuickTime/MP4 metadata). */
  hasLocation?: boolean
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)

export function sniff(b: Uint8Array): MediaMime | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') return ascii(b, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  return undefined
}

/** Reads the type and size of a file openGym accepts; throws with a readable reason otherwise. */
export function inspect(b: Uint8Array): MediaInfo {
  const mime = sniff(b)
  if (!mime) throw new Error('not a photo or video openGym accepts (JPEG, PNG, WebP, GIF, MP4, MOV or WebM)')
  const base = { mime, kind: KIND_OF[mime] }
  switch (mime) {
    case 'image/jpeg':
      return { ...base, ...jpeg(b) }
    case 'image/png':
      if (ascii(b, 12, 4) !== 'IHDR') throw new Error('a PNG without a header chunk')
      return { ...base, width: u32be(b, 16), height: u32be(b, 20) }
    case 'image/gif':
      return { ...base, width: u16le(b, 6), height: u16le(b, 8) }
    case 'image/webp':
      return { ...base, ...webp(b) }
    case 'video/mp4':
    case 'video/quicktime':
      return { ...base, ...isoBmff(b) }
    case 'video/webm':
      return { ...base, ...matroska(b) }
  }
}

/** EXIF orientation from an APP1 "Exif" payload (starting at the TIFF header). */
export function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1
  const le = ascii(tiff, 0, 2) === 'II'
  const r16 = (at: number) => (le ? u16le(tiff, at) : u16be(tiff, at))
  const r32 = (at: number) => (le ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16)) + tiff[at + 3]! * 2 ** 24 : u32be(tiff, at))
  const ifd = r32(4)
  if (ifd + 2 > tiff.length) return 1
  const count = r16(ifd)
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12
    if (at + 12 > tiff.length) break
    if (r16(at) === 0x0112) {
      const v = r16(at + 8)
      return v >= 1 && v <= 8 ? v : 1
    }
  }
  return 1
}

function jpeg(b: Uint8Array): { width: number; height: number; orientation: number } {
  let at = 2
  let orientation = 1
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw new Error('a damaged JPEG')
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const len = u16be(b, at + 2)
    if (marker === 0xe1 && ascii(b, at + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b.subarray(at + 10, at + 2 + len))
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      const height = u16be(b, at + 5)
      const width = u16be(b, at + 7)
      // Orientations 5–8 turn the picture a quarter: it is shown with width and height swapped.
      return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation }
    }
    if (marker === 0xda) break
    at += 2 + len
  }
  throw new Error('a JPEG without a frame header')
}

/** No real photo or video has this many chunks, boxes or elements in one walk; a file that does is crafted. */
export const MAX_ELEMENTS = 65_536

export function tooMany(): never {
  throw new Error('a damaged file (too many parts)')
}

export interface RiffChunk {
  type: string
  /** Offset of the chunk header. */
  at: number
  /** Offset just past the chunk, padding included (never beyond the file). */
  end: number
  data: Uint8Array
}

/**
 * The chunks of a WebP (RIFF) file after its 12-byte header. Sizes are unsigned
 * 32-bit little-endian; a chunk that does not fit in the file ends the walk, so
 * a corrupt size can neither run backwards nor allocate beyond the file.
 */
export function riffChunks(b: Uint8Array): RiffChunk[] {
  const out: RiffChunk[] = []
  for (let at = 12; at + 8 <= b.length; ) {
    const size = (b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16)) + b[at + 7]! * 2 ** 24
    if (at + 8 + size > b.length) break
    const end = Math.min(b.length, at + 8 + size + (size & 1))
    out.push({ type: ascii(b, at, 4), at, end, data: b.subarray(at + 8, at + 8 + size) })
    if (out.length > MAX_ELEMENTS) tooMany()
    at = end
  }
  return out
}

function webp(b: Uint8Array): { width: number; height: number; orientation?: number } {
  const chunk = ascii(b, 12, 4)
  const d = 20
  if (chunk === 'VP8X') {
    const width = u24le(b, d + 4) + 1
    const height = u24le(b, d + 7) + 1
    let orientation = 1
    for (const c of riffChunks(b)) {
      if (c.type === 'EXIF') orientation = exifOrientation(ascii(c.data, 0, 6) === 'Exif\0\0' ? c.data.subarray(6) : c.data)
    }
    if (orientation === 1) return { width, height }
    return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation }
  }
  if (chunk === 'VP8L') {
    const b1 = b[d + 1]!
    const b2 = b[d + 2]!
    const b3 = b[d + 3]!
    const b4 = b[d + 4]!
    return { width: 1 + (b1 | ((b2 & 0x3f) << 8)), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) }
  }
  if (chunk === 'VP8 ') return { width: u16le(b, d + 6) & 0x3fff, height: u16le(b, d + 8) & 0x3fff }
  throw new Error('a WebP of an unknown layout')
}

interface Box {
  type: string
  start: number
  end: number
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = u32be(b, at)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12)
      header = 16
    } else if (size === 0) size = to - at
    if (size < header || at + size > to) break
    out.push({ type: ascii(b, at + 4, 4), start: at + header, end: at + size })
    if (out.length > MAX_ELEMENTS) tooMany()
    at += size
  }
  return out
}

const child = (b: Uint8Array, box: Box, type: string) => boxes(b, box.start, box.end).find((x) => x.type === type)

const CODEC_FOURCC: Record<string, Codec> = { avc1: 'avc1', avc3: 'avc1', hvc1: 'hvc1', hev1: 'hvc1', av01: 'av01', vp09: 'vp09', vp08: 'vp8' }

function isoBmff(b: Uint8Array): { width: number; height: number; dur?: number; codec: Codec; hasLocation: boolean } {
  const top = boxes(b, 0, b.length)
  const moov = top.find((x) => x.type === 'moov')
  if (!moov) throw new Error('a video without a movie header (moov)')
  let dur: number | undefined
  const mvhd = child(b, moov, 'mvhd')
  if (mvhd) {
    const v1 = b[mvhd.start] === 1
    const scale = u32be(b, mvhd.start + (v1 ? 20 : 12))
    const length = v1 ? u32be(b, mvhd.start + 24) * 2 ** 32 + u32be(b, mvhd.start + 28) : u32be(b, mvhd.start + 16)
    if (scale > 0) dur = Math.round((length / scale) * 10) / 10
  }
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia')
    const hdlr = mdia && child(b, mdia, 'hdlr')
    if (!hdlr || ascii(b, hdlr.start + 8, 4) !== 'vide') continue
    const tkhd = child(b, trak, 'tkhd')
    if (!tkhd) continue
    const stored = { width: Math.round(u32be(b, tkhd.end - 8) / 65536), height: Math.round(u32be(b, tkhd.end - 4) / 65536) }
    // The display matrix sits just before the size; a quarter turn (a = d = 0) is how phones mark portrait video.
    const matrix = tkhd.end - 8 - 36
    const quarterTurn = matrix >= tkhd.start && u32be(b, matrix) === 0 && u32be(b, matrix + 16) === 0
    const { width, height } = quarterTurn ? { width: stored.height, height: stored.width } : stored
    const stsd = (() => {
      const minf = mdia && child(b, mdia, 'minf')
      const stbl = minf && child(b, minf, 'stbl')
      return stbl && child(b, stbl, 'stsd')
    })()
    const fourcc = stsd && stsd.start + 16 <= stsd.end ? ascii(b, stsd.start + 12, 4) : ''
    return { width, height, ...(dur !== undefined ? { dur } : {}), codec: CODEC_FOURCC[fourcc] ?? 'other', hasLocation: hasLocation(b, top, moov) }
  }
  throw new Error('a video without a video track')
}

/** Sample formats of tracks that record position: GoPro's GPMF, Google's camera motion and DJI's telemetry. */
export const TELEMETRY_CODECS: ReadonlySet<string> = new Set(['gpmd', 'camm', 'djmd'])

const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0))
/**
 * Location metadata as cameras and phones write it: QuickTime `©xyz`, the 3GPP
 * `loci` box, Apple's `com.apple.quicktime.location.*` keys, and EXIF/XMP GPS tags
 * that some vendors embed in metadata boxes.
 */
const LOCATION_NEEDLES = [[0xa9, 0x78, 0x79, 0x7a], bytesOf('loci'), bytesOf('com.apple.quicktime.location'), bytesOf('GPSCoordinates'), bytesOf('GPSLatitude')]

export function locationIn(area: Uint8Array): boolean {
  return LOCATION_NEEDLES.some((bytes) => {
    outer: for (let i = 0; i + bytes.length <= area.length; i++) {
      for (let j = 0; j < bytes.length; j++) if (area[i + j] !== bytes[j]) continue outer
      return true
    }
    return false
  })
}

/** Boxes that only group others; metadata can sit anywhere below them. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'udta'])
/** Boxes that hold metadata; only these are searched, never sample tables or media data. */
const METADATA = new Set(['udta', 'meta', 'uuid', 'keys', 'ilst', 'loci', '\u00a9xyz'])

/** Location metadata in the metadata boxes of the file, or a track that records position. */
function hasLocation(b: Uint8Array, top: Box[], moov: Box): boolean {
  const areas: Box[] = []
  const visit = (list: Box[], depth: number) => {
    for (const x of list) {
      if (METADATA.has(x.type)) areas.push(x)
      if (CONTAINERS.has(x.type) && depth < 8) visit(boxes(b, x.start, x.end), depth + 1)
    }
  }
  visit(top.filter((x) => x.type !== 'mdat'), 0)
  if (areas.some((x) => x.type === 'loci' || x.type === '\u00a9xyz' || locationIn(b.subarray(x.start, x.end)))) return true
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia')
    const minf = mdia && child(b, mdia, 'minf')
    const stbl = minf && child(b, minf, 'stbl')
    const stsd = stbl && child(b, stbl, 'stsd')
    if (stsd && stsd.start + 16 <= stsd.end && TELEMETRY_CODECS.has(ascii(b, stsd.start + 12, 4))) return true
  }
  return false
}

/** An EBML variable-length integer: its length, and its value without (size) or with (id) the marker bits. */
function vint(b: Uint8Array, at: number, keepMarker: boolean): { length: number; value: number; unknown: boolean } {
  const first = b[at]!
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8 || at + length > b.length) throw new Error('a damaged WebM')
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = value === (0xff >> length)
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i]!
    if (b[at + i] !== 0xff) allOnes = false
  }
  return { length, value, unknown: !keepMarker && allOnes }
}

function ebml(b: Uint8Array, from: number, to: number): { id: number; start: number; end: number }[] {
  const out: { id: number; start: number; end: number }[] = []
  let at = from
  while (at < to) {
    const id = vint(b, at, true)
    const size = vint(b, at + id.length, false)
    const start = at + id.length + size.length
    const end = size.unknown ? to : Math.min(to, start + size.value)
    out.push({ id: id.value, start, end })
    if (out.length > MAX_ELEMENTS) tooMany()
    if (id.value === 0x1f43b675) break
    at = end
  }
  return out
}

const uintOf = (b: Uint8Array, s: number, e: number) => {
  let v = 0
  for (let i = s; i < e; i++) v = v * 256 + b[i]!
  return v
}

const WEBM_CODECS: Record<string, Codec> = { V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av01', 'V_MPEG4/ISO/AVC': 'avc1', 'V_MPEGH/ISO/HEVC': 'hvc1' }

function matroska(b: Uint8Array): { width: number; height: number; dur?: number; codec: Codec } {
  const segment = ebml(b, 0, b.length).find((e) => e.id === 0x18538067)
  if (!segment) throw new Error('a WebM without a segment')
  let scale = 1_000_000
  let duration: number | undefined
  let found: { width: number; height: number; codec: Codec } | undefined
  for (const top of ebml(b, segment.start, segment.end)) {
    if (top.id === 0x1549a966) {
      for (const e of ebml(b, top.start, top.end)) {
        if (e.id === 0x2ad7b1) scale = uintOf(b, e.start, e.end)
        if (e.id === 0x4489 && (e.end - e.start === 4 || e.end - e.start === 8)) {
          const view = new DataView(b.buffer, b.byteOffset + e.start, e.end - e.start)
          duration = e.end - e.start === 4 ? view.getFloat32(0) : view.getFloat64(0)
        }
      }
    }
    if (top.id === 0x1654ae6b && !found) {
      for (const track of ebml(b, top.start, top.end).filter((e) => e.id === 0xae)) {
        const fields = ebml(b, track.start, track.end)
        const video = fields.find((e) => e.id === 0xe0)
        if (!video) continue
        const codecId = fields.find((e) => e.id === 0x86)
        const dims = ebml(b, video.start, video.end)
        const w = dims.find((e) => e.id === 0xb0)
        const h = dims.find((e) => e.id === 0xba)
        if (!w || !h) continue
        found = { width: uintOf(b, w.start, w.end), height: uintOf(b, h.start, h.end), codec: WEBM_CODECS[codecId ? ascii(b, codecId.start, codecId.end - codecId.start) : ''] ?? 'other' }
        break
      }
    }
  }
  if (!found) throw new Error('a WebM without a video track')
  return { ...found, ...(duration !== undefined ? { dur: Math.round(((duration * scale) / 1e9) * 10) / 10 } : {}) }
}
