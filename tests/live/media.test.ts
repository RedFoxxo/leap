import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

const fixture = (name: string) => new URL(`../fixtures/media/${name}`, import.meta.url).pathname

describe.runIf(LIVE)('media (live)', () => {
  beforeAll(seedFixture)

  it('uploads stripped files, attaches, downloads and detaches through the real API', async () => {
    const c = await liveClient()
    const usage = await c.call('read_media_usage')
    expect(usage.isError, usage.text).toBe(false)
    expect(usage.json.enabled).toBe(true)

    const photo = await c.call('write_attach_media', { path: fixture('photo-gps.jpg'), workoutId: 'w-legs' })
    expect(photo.isError, photo.text).toBe(false)
    expect(photo.json).not.toHaveProperty('notPersisted')
    const hash = photo.json.attached.hash as string

    const video = await c.call('write_attach_media', { path: fixture('clip.mp4'), workoutId: 'w-legs' })
    expect(video.isError, video.text).toBe(false)
    expect(video.json.attached).toMatchObject({ kind: 'video', mime: 'video/mp4', durationSec: 1 })
    const gif = await c.call('write_attach_media', { path: fixture('anim.gif'), customExerciseId: 'cplank' })
    expect(gif.isError, gif.text).toBe(false)

    const read = await c.call('read_workout', { id: 'w-legs' })
    expect(read.json.media.map((m: { kind: string }) => m.kind)).toEqual(['image', 'video'])

    const dir = mkdtempSync(join(tmpdir(), 'leap-live-media-'))
    const saved = await c.call('read_media', { hash, saveTo: dir })
    expect(saved.isError, saved.text).toBe(false)
    const bytes = readFileSync(saved.json.saved)
    expect(bytes.includes(Buffer.from('LeapTestCam'))).toBe(false)

    const after = await c.call('read_media_usage')
    expect(after.json.missingOnServer).toEqual(['a'.repeat(64)])

    expect((await c.call('delete_media', { hash, workoutId: 'w-legs' })).json.saved).toBe(true)
    expect((await c.call('read_workout', { id: 'w-legs' })).json.media).toHaveLength(1)

    const sweep = await c.call('delete_media_sweep')
    expect(sweep.isError, sweep.text).toBe(false)
    expect(sweep.json.removed).toBeGreaterThanOrEqual(1)
    const gone = await c.call('read_media', { hash, saveTo: dir })
    expect(gone.text).toMatch(/does not have that file/)
    await c.close()
  })
})
