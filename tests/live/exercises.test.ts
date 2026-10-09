import { describe, expect, it } from 'vitest'
import { LIVE, liveClient } from './helpers.js'

describe.runIf(LIVE)('exercises (live)', () => {
  it('finds built-in exercises of the shipped catalogue', async () => {
    const c = await liveClient()
    const r = await c.call('read_exercises', { query: 'barbell bench press', equipment: 'barbell' })
    expect(r.isError, r.text).toBe(false)
    expect(r.json.warning).toBeUndefined()
    expect(r.json.exercises[0]).toMatchObject({ id: '0025', name: 'barbell bench press', target: 'pectorals' })

    const all = await c.call('read_exercises', { source: 'builtin', limit: 1 })
    expect(all.json.total).toBe(5632)

    const one = await c.call('read_exercise', { id: '0739' })
    expect(one.json.name).toBe('sled 45° leg press')
    expect(one.json.steps.length).toBeGreaterThan(0)
    await c.close()
  })
})
