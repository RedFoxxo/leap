import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('profile reads (live)', () => {
  beforeAll(seedFixture)

  it('read_profile, read_settings and read_document see the stored profile', async () => {
    const c = await liveClient()
    const profile = await c.call('read_profile')
    expect(profile.isError, profile.text).toBe(false)
    expect(profile.json).toMatchObject({ name: 'Leap Tester', admin: true, unit: 'kg', counts: { workouts: 2, routines: 3 } })

    const settings = await c.call('read_settings')
    expect(settings.json.settings).toMatchObject({ lang: 'de', futureFeature: { keep: 'me' } })
    expect(settings.json.settings).not.toHaveProperty('workouts')

    const doc = await c.call('read_document', { key: 'futureFeature' })
    expect(doc.json.value).toEqual({ keep: 'me' })
    await c.close()
  })
})
