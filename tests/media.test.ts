import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exifOrientation, inspect, locationIn, sniff, TELEMETRY_CODECS } from '../src/media/inspect.js'
import { orientationExif, stripMetadata } from '../src/media/strip.js'

/**
 * Fixtures in tests/fixtures/media were made for leap with Pillow and ffmpeg
 * (sizes and durations below are ffprobe's): a 16×8 JPEG with orientation 6,
 * a camera make, GPS, an ICC profile and a comment; PNG with a text chunk;
 * WebP lossy, lossless and with EXIF; an animated GIF with a comment; MP4, MOV
 * and WebM clips, and two videos carrying a location.
 */
const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url)))
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, 'latin1'))

describe('inspect', () => {
  it('reads type and size of every still openGym accepts', () => {
    expect(inspect(file('plain.jpg'))).toEqual({ mime: 'image/jpeg', kind: 'image', width: 16, height: 8, orientation: 1 })
    expect(inspect(file('photo-gps.jpg'))).toEqual({ mime: 'image/jpeg', kind: 'image', width: 8, height: 16, orientation: 6 })
    expect(inspect(file('text.png'))).toEqual({ mime: 'image/png', kind: 'image', width: 16, height: 8 })
    expect(inspect(file('lossy.webp'))).toEqual({ mime: 'image/webp', kind: 'image', width: 16, height: 8 })
    expect(inspect(file('lossless.webp'))).toEqual({ mime: 'image/webp', kind: 'image', width: 16, height: 8 })
    expect(inspect(file('exif.webp'))).toEqual({ mime: 'image/webp', kind: 'image', width: 8, height: 16, orientation: 6 })
    expect(inspect(file('anim.gif'))).toEqual({ mime: 'image/gif', kind: 'gif', width: 12, height: 10 })
  })

  it('reads size, duration and codec of videos, and whether they carry a location', () => {
    expect(inspect(file('clip.mp4'))).toEqual({ mime: 'video/mp4', kind: 'video', width: 32, height: 16, dur: 1, codec: 'avc1', hasLocation: false })
    expect(inspect(file('clip.mov'))).toEqual({ mime: 'video/quicktime', kind: 'video', width: 24, height: 16, dur: 1, codec: 'avc1', hasLocation: false })
    expect(inspect(file('clip.webm'))).toEqual({ mime: 'video/webm', kind: 'video', width: 20, height: 12, dur: 2, codec: 'vp9' })
    expect(inspect(file('located.mov'))).toMatchObject({ dur: 1.5, hasLocation: true })
    expect(inspect(file('located.mp4'))).toMatchObject({ dur: 1.5, hasLocation: true })
    expect(inspect(file('gps-uuid.mp4'))).toMatchObject({ hasLocation: true })
  })

  it('finds 3GPP locations and GPS telemetry tracks', () => {
    expect(locationIn(new TextEncoder().encode('....loci....'))).toBe(true)
    expect(locationIn(new TextEncoder().encode('...<exif:GPSLatitude>...'))).toBe(true)
    expect(locationIn(new TextEncoder().encode('an ordinary movie header'))).toBe(false)
    expect(TELEMETRY_CODECS.has('gpmd') && TELEMETRY_CODECS.has('camm')).toBe(true)
  })

  it('refuses anything else', () => {
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(() => inspect(new TextEncoder().encode('%PDF-1.7'))).toThrow(/not a photo or video openGym accepts/)
    expect(() => inspect(file('plain.jpg').subarray(0, 20))).toThrow(/JPEG/)
  })
})

describe('stripMetadata', () => {
  it('removes EXIF, GPS, comments and keeps orientation and colour profile in a JPEG', () => {
    const before = file('photo-gps.jpg')
    expect(has(before, 'LeapTestCam') && has(before, 'secret comment')).toBe(true)
    const after = stripMetadata(before, 'image/jpeg')
    expect(has(after, 'LeapTestCam')).toBe(false)
    expect(has(after, 'secret comment')).toBe(false)
    expect(has(after, 'ICC_PROFILE')).toBe(true)
    expect(inspect(after)).toEqual(inspect(before))
    expect(after.length).toBeLessThan(before.length)
  })

  it('drops everything after the end of the image (motion photos, extra images, trailers)', () => {
    const before = file('trailer.jpg')
    expect(has(before, 'TRAILER-GPS')).toBe(true)
    const after = stripMetadata(before, 'image/jpeg')
    expect(has(after, 'TRAILER-GPS')).toBe(false)
    expect(has(after, 'secret-second-image')).toBe(false)
    expect([...after.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(after).toEqual(file('plain.jpg'))
  })

  it('keeps every scan of a progressive JPEG', () => {
    const progressive = file('progressive.jpg')
    expect(stripMetadata(progressive, 'image/jpeg')).toEqual(progressive)
  })

  it('leaves a JPEG without metadata byte for byte', () => {
    const plain = file('plain.jpg')
    expect(stripMetadata(plain, 'image/jpeg')).toEqual(plain)
  })

  it('removes text from a PNG, EXIF from a WebP and comments from a GIF', () => {
    const png = stripMetadata(file('text.png'), 'image/png')
    expect(has(png, 'secret author')).toBe(false)
    expect(inspect(png)).toMatchObject({ width: 16, height: 8 })

    const webp = stripMetadata(file('exif.webp'), 'image/webp')
    expect(has(webp, 'LeapTestCam')).toBe(false)
    expect(webp[20]! & 0x0c).toBe(0x08)
    expect(new DataView(webp.buffer, webp.byteOffset).getUint32(4, true)).toBe(webp.length - 8)
    expect(inspect(webp)).toEqual(inspect(file('exif.webp')))
    expect(stripMetadata(file('lossy.webp'), 'image/webp')).toEqual(file('lossy.webp'))

    const gif = stripMetadata(file('anim.gif'), 'image/gif')
    expect(has(gif, 'secret gif comment')).toBe(false)
    expect(has(gif, 'NETSCAPE2.0')).toBe(true)
    expect(gif.at(-1)).toBe(0x3b)
  })

  it('writes a minimal EXIF block that reads back as the orientation', () => {
    const app1 = orientationExif(8)
    expect(exifOrientation(app1.subarray(10))).toBe(8)
  })

  it('returns videos unchanged', () => {
    const clip = file('clip.mp4')
    expect(stripMetadata(clip, 'video/mp4')).toBe(clip)
  })
})
