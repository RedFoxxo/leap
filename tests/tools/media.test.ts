import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profile } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { StubReply, type StubCall } from '../helpers/fetch-stub.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()
const MEDIA = { imageMB: 2, gifMB: 8, videoMB: 40, videoSec: 60, quotaMB: 200, workouts: true }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const fixture = (name: string) => new URL(`../fixtures/media/${name}`, import.meta.url).pathname

/** The fake keeps uploaded files by hash and refuses a body that does not hash to its name, like openGym. */
async function setup(options: { media?: object | null; state?: Record<string, unknown> } = {}) {
  const fake = new FakeOpenGym(options.state ?? profile(), 60)
  const files = new Map<string, Uint8Array>()
  fake.stub.get('/api/config', { invite_only: false, allow_guest: true, coach: null, ...(options.media === null ? {} : { media: options.media ?? MEDIA }) })
  fake.stub.on({
    method: 'PUT',
    path: /^\/api\/media\/[0-9a-f]{64}$/,
    body: (call: StubCall) => {
      const bytes = call.body as Uint8Array
      const name = call.path.split('/').pop()!
      if (sha(bytes) !== name) return new StubReply(400, { error: 'the file does not match its name', code: 'hash-mismatch' })
      const existed = files.has(name)
      files.set(name, bytes)
      return new StubReply(existed ? 200 : 201, { ok: true, hash: name, mime: call.headers['Content-Type'], size: bytes.length, existed })
    },
  })
  fake.stub.on({ method: 'GET', path: /^\/api\/media\/[0-9a-f]{64}$/, body: (call: StubCall) => {
    const f = files.get(call.path.split('/').pop()!)
    return f ?? new StubReply(404, { error: 'no such file', code: 'media-missing' })
  }, headers: { 'content-type': 'image/jpeg' } })
  fake.stub.post('/api/media/missing', (call: StubCall) => ({
    missing: (call.body as { hashes: string[] }).hashes.filter((h) => !files.has(h)),
    usage: { bytes: 3 * 1048576, count: files.size, quotaBytes: 200 * 1048576 },
  }))
  const h = await harness({ stub: fake.stub, context: { now: () => NOW } })
  const dir = mkdtempSync(join(tmpdir(), 'leap-media-'))
  return { fake, h, files, dir, doc: () => fake.state as Record<string, any> }
}

describe('write_attach_media', () => {
  it('strips a photo, uploads it under its hash and attaches it to a workout', async () => {
    const { h, files, doc } = await setup()
    const r = await h.call('write_attach_media', { path: fixture('photo-gps.jpg'), workoutId: 'w-legs' })
    expect(r.isError, r.text).toBe(false)
    const [hash, bytes] = [...files.entries()][0]!
    expect(Buffer.from(bytes).includes(Buffer.from('LeapTestCam'))).toBe(false)
    expect(r.json).toMatchObject({ saved: true, attached: { hash, kind: 'image', mime: 'image/jpeg', width: 8, height: 16 }, to: { workoutId: 'w-legs' }, metadataRemovedBytes: expect.any(Number) })
    const w = doc().workouts.find((x: { id: string }) => x.id === 'w-legs')
    expect(w.media).toEqual([{ kind: 'image', hash, mime: 'image/jpeg', size: bytes.length, width: 8, height: 16, at: NOW }])
    expect(w._ts).toBe(NOW)
    await h.close()
  })

  it('puts a video with duration and codec on a custom exercise, replacing the old one', async () => {
    const state = profile()
    ;(state.customEx as any[])[0].media = { kind: 'image', hash: 'c'.repeat(64), mime: 'image/png', size: 1, width: 1, height: 1, at: 1 }
    const { h, doc } = await setup({ state })
    const r = await h.call('write_attach_media', { path: fixture('clip.webm'), customExerciseId: 'cplank' })
    expect(r.json.attached).toMatchObject({ kind: 'video', mime: 'video/webm', width: 20, height: 12, durationSec: 2 })
    expect(doc().customEx[0].media).toMatchObject({ kind: 'video', codec: 'vp9', dur: 2, at: NOW })
    await h.close()
  })

  it('refuses files that are not media, located videos, relative paths and oversize files, uploading nothing', async () => {
    const { h, fake, dir } = await setup({ media: { ...MEDIA, imageMB: 0.0001 } })
    writeFileSync(join(dir, 'notes.txt'), 'password=hunter2')
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ path: join(dir, 'notes.txt'), workoutId: 'w-legs' }, /not a photo or video openGym accepts/],
      [{ path: fixture('located.mov'), workoutId: 'w-legs' }, /records where it was filmed/],
      [{ path: 'relative/photo.jpg', workoutId: 'w-legs' }, /absolute path/],
      [{ path: dir, workoutId: 'w-legs' }, /is not a file/],
      [{ path: fixture('plain.jpg'), workoutId: 'w-legs', customExerciseId: 'cplank' }, /exactly one of/],
      [{ path: fixture('plain.jpg'), workoutId: 'w-legs' }, /this instance takes photos up to 0.0001 MB/],
    ]
    for (const [args, message] of cases) expect((await h.call('write_attach_media', args)).text, JSON.stringify(args)).toMatch(message)
    expect(fake.stub.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    await h.close()
  })

  it('refuses a seventh file, a duplicate, an unknown workout, and an instance without media', async () => {
    const state = profile()
    const w = (state.workouts as any[])[1]
    w.media = Array.from({ length: 6 }, (_, i) => ({ kind: 'image', hash: String(i).repeat(64), mime: 'image/png', size: 1, width: 1, height: 1, at: 1 }))
    const { h } = await setup({ state })
    expect((await h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'w-push' })).text).toMatch(/already has 6/)
    expect((await h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'nope' })).text).toMatch(/no workout with id "nope"/)
    const twice = await h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'w-legs' })
    expect(twice.isError).toBe(false)
    expect((await h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'w-legs' })).text).toMatch(/already on the workout/)
    await h.close()
    const off = await setup({ media: null })
    expect((await off.h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'w-legs' })).text).toMatch(/does not store photos and videos/)
    await off.h.close()
  })
})

describe('delete_media', () => {
  it('takes a file off a workout and stamps it', async () => {
    const { h, doc } = await setup()
    const r = await h.call('delete_media', { hash: 'a'.repeat(64), workoutId: 'w-push' })
    expect(r.json).toMatchObject({ saved: true, removed: 'a'.repeat(64) })
    const w = doc().workouts.find((x: { id: string }) => x.id === 'w-push')
    expect(w).not.toHaveProperty('media')
    expect(w._ts).toBe(NOW)
    expect((await h.call('delete_media', { hash: 'a'.repeat(64), workoutId: 'w-push' })).text).toMatch(/not on this workout/)
    await h.close()
  })
})

describe('read_media and read_media_usage', () => {
  it('downloads to a new file, checks the hash, never overwrites', async () => {
    const { h, files, dir } = await setup()
    await h.call('write_attach_media', { path: fixture('plain.jpg'), workoutId: 'w-legs' })
    const [hash, bytes] = [...files.entries()][0]!
    const r = await h.call('read_media', { hash, saveTo: dir })
    expect(r.json).toMatchObject({ saved: join(dir, `${hash}.jpg`), mime: 'image/jpeg' })
    expect(new Uint8Array(readFileSync(join(dir, `${hash}.jpg`)))).toEqual(bytes)
    expect(statSync(join(dir, `${hash}.jpg`)).mode & 0o777).toBe(0o600)
    expect((await h.call('read_media', { hash, saveTo: dir })).text).toMatch(/already exists/)
    expect((await h.call('read_media', { hash: 'd'.repeat(64), saveTo: dir })).text).toMatch(/does not have that file/)
    expect(existsSync(join(dir, `${'d'.repeat(64)}.jpg`))).toBe(false)
    await h.close()
  })

  it('saves nothing when the bytes do not match the hash', async () => {
    const { h, fake, dir } = await setup()
    const wrong = 'e'.repeat(64)
    fake.stub.first({ method: 'GET', path: `/api/media/${wrong}`, body: new Uint8Array([1, 2, 3]) })
    expect((await h.call('read_media', { hash: wrong, saveTo: dir })).text).toMatch(/does not match its hash; nothing was saved/)
    expect(existsSync(join(dir, `${wrong}.bin`))).toBe(false)
    await h.close()
  })

  it('reports usage and which referenced files the server lacks', async () => {
    const { h } = await setup()
    const r = await h.call('read_media_usage')
    expect(r.json).toEqual({ enabled: true, usage: { usedMB: 3, files: 0, quotaMB: 200 }, referenced: 1, missingOnServer: ['a'.repeat(64)], limits: MEDIA })
    await h.close()
  })
})

describe('copying a fixture keeps paths honest', () => {
  it('reads through a ~/ path', async () => {
    const { h } = await setup()
    const home = process.env.HOME!
    const name = `.leap-test-${process.pid}.png`
    copyFileSync(fixture('text.png'), join(home, name))
    try {
      expect((await h.call('write_attach_media', { path: `~/${name}`, workoutId: 'w-legs' })).isError).toBe(false)
    } finally {
      ;(await import('node:fs')).rmSync(join(home, name))
    }
    await h.close()
  })
})
