import { exifOrientation, type MediaMime } from './inspect.js'

/**
 * Removes metadata from a still image without touching its pixels: EXIF (GPS
 * position, camera, time), XMP, IPTC and comments. A JPEG keeps its colour
 * profile and, as a minimal EXIF block, only its orientation, so a portrait
 * photo still shows upright. Videos are returned as they are; the caller
 * checks them for a location instead.
 */
export function stripMetadata(b: Uint8Array, mime: MediaMime): Uint8Array {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(b)
    case 'image/png':
      return stripPng(b)
    case 'image/webp':
      return stripWebp(b)
    case 'image/gif':
      return stripGif(b)
    default:
      return b
  }
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

/** An APP1 segment holding a big-endian TIFF header and one IFD entry: Orientation (0x0112). */
export function orientationExif(orientation: number): Uint8Array {
  const payload = [
    ...[0x45, 0x78, 0x69, 0x66, 0, 0], // "Exif\0\0"
    ...[0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8], // "MM", 42, IFD0 at 8
    ...[0, 1], // one entry
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0], // Orientation, SHORT, 1, value
    ...[0, 0, 0, 0], // no next IFD
  ]
  const len = payload.length + 2
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload])
}

/** Where the entropy-coded data after a scan header ends: the next marker that is not stuffing (FF00), a restart (FFD0–D7) or fill. */
function scanEnd(b: Uint8Array, from: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue
    const next = b[i + 1]!
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) continue
    return i
  }
  return b.length
}

/**
 * Walks every segment and every scan (a progressive JPEG has several) up to the
 * end-of-image marker, and drops what follows it: a motion photo's video,
 * further images with their own metadata, vendor trailers.
 */
function stripJpeg(b: Uint8Array): Uint8Array {
  const jfif: Uint8Array[] = []
  const kept: Uint8Array[] = []
  let at = 2
  let orientation = 1
  while (at + 2 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd9) {
      kept.push(b.subarray(at, at + 2))
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(at, at + 2))
      at += 2
      continue
    }
    if (at + 4 > b.length) break
    const len = (b[at + 2]! << 8) | b[at + 3]!
    const end = Math.min(b.length, at + 2 + len)
    if (marker === 0xda) {
      const data = scanEnd(b, end)
      kept.push(b.subarray(at, data))
      at = data
      continue
    }
    const seg = b.subarray(at, end)
    const isApp = marker >= 0xe0 && marker <= 0xef
    if (marker === 0xe1 && ascii(b, at + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b.subarray(at + 10, end))
    if (marker === 0xe0 && (ascii(b, at + 4, 5) === 'JFIF\0' || ascii(b, at + 4, 5) === 'JFXX\0')) jfif.push(seg)
    else if ((marker === 0xe2 && ascii(b, at + 4, 12) === 'ICC_PROFILE\0') || (marker === 0xee && ascii(b, at + 4, 5) === 'Adobe') || (!isApp && marker !== 0xfe)) {
      kept.push(seg)
    }
    at = end
  }
  // Start of image, the JFIF header, the orientation where EXIF belongs, then the kept segments and scans up to the end of the image.
  return concat([b.subarray(0, 2), ...jfif, ...(orientation > 1 ? [orientationExif(orientation)] : []), ...kept])
}

/** Chunks a PNG needs to look the same (image data, colour, transparency, animation); text, EXIF and time go. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'sPLT', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT'])

function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  let at = 8
  while (at + 12 <= b.length) {
    const len = ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
    const type = ascii(b, at + 4, 4)
    const end = at + 12 + len
    if (end > b.length) break
    if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end))
    at = end
    if (type === 'IEND') break
  }
  return concat(parts)
}

/** A WebP EXIF chunk holds the TIFF data, sometimes still behind an "Exif\0\0" prefix. */
export function webpExifTiff(chunk: Uint8Array): Uint8Array {
  return ascii(chunk, 0, 6) === 'Exif\0\0' ? chunk.subarray(6) : chunk
}

function stripWebp(b: Uint8Array): Uint8Array {
  if (ascii(b, 12, 4) !== 'VP8X') return b
  const parts: Uint8Array[] = []
  let orientation = 1
  let at = 12
  while (at + 8 <= b.length) {
    const size = b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | (b[at + 7]! * 2 ** 24)
    const type = ascii(b, at, 4)
    const end = Math.min(b.length, at + 8 + size + (size & 1))
    if (type === 'EXIF') orientation = exifOrientation(webpExifTiff(b.subarray(at + 8, at + 8 + size)))
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(b.subarray(at, end))
    at = end
  }
  if (orientation > 1) {
    // The TIFF part of the minimal EXIF block (without "Exif\0\0"); 26 bytes, so no padding.
    const tiff = orientationExif(orientation).subarray(10)
    parts.push(new Uint8Array([0x45, 0x58, 0x49, 0x46, tiff.length, 0, 0, 0]), tiff)
  }
  const body = concat(parts)
  // VP8X flags: bit 3 EXIF (only the orientation is left), bit 2 XMP (gone).
  body[8] = (body[8]! & ~0x0c) | (orientation > 1 ? 0x08 : 0)
  const out = concat([b.subarray(0, 12), body])
  const riff = out.length - 8
  out[4] = riff & 0xff
  out[5] = (riff >> 8) & 0xff
  out[6] = (riff >> 16) & 0xff
  out[7] = (riff >>> 24) & 0xff
  return out
}

/** Comment extensions and application extensions other than the animation loop (e.g. XMP) go. */
function stripGif(b: Uint8Array): Uint8Array {
  const packed = b[10]!
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
  const parts: Uint8Array[] = [b.subarray(0, at)]
  const subBlocks = (from: number) => {
    let p = from
    while (p < b.length && b[p] !== 0) p += b[p]! + 1
    return p + 1
  }
  while (at < b.length) {
    const intro = b[at]
    if (intro === 0x3b) {
      parts.push(b.subarray(at, at + 1))
      break
    }
    if (intro === 0x2c) {
      const local = b[at + 9]!
      const start = at
      at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0)
      at = subBlocks(at + 1)
      parts.push(b.subarray(start, at))
      continue
    }
    if (intro === 0x21) {
      const label = b[at + 1]
      const start = at
      const end = subBlocks(at + 2)
      const app = label === 0xff ? ascii(b, at + 3, 11) : ''
      const keep = label !== 0xfe && (label !== 0xff || app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0')
      if (keep) parts.push(b.subarray(start, end))
      at = end
      continue
    }
    throw new Error('a damaged GIF')
  }
  return concat(parts)
}
