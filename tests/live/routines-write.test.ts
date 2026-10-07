import { beforeAll, describe, expect, it } from 'vitest'
import { LIVE, liveClient, seedFixture } from './helpers.js'

describe.runIf(LIVE)('routine and plan writes (live)', () => {
  beforeAll(seedFixture)

  it('creates, plans, copies and deletes a routine through the real API', async () => {
    const c = await liveClient()
    const created = await c.call('write_routine', {
      name: 'Live Upper',
      exercises: [
        { exerciseId: '0025', sets: 3, repsMin: 6, repsMax: 10, weight: 80, superset: 'A' },
        { exerciseId: '0294', sets: 3, reps: 12, weight: 14, superset: 'A' },
      ],
    })
    expect(created.isError, created.text).toBe(false)
    expect(created.json).not.toHaveProperty('notPersisted')
    const id = created.json.routine.id as string

    const read = await c.call('read_routine', { id })
    expect(read.json.exercises.map((e: { name: string }) => e.name)).toEqual(['barbell bench press', 'dumbbell biceps curl'])
    expect(read.json.exercises[0].sg).toBe(read.json.exercises[1].sg)

    expect((await c.call('write_week_plan', { days: { Tuesday: [id] } })).json.saved).toBe(true)
    expect((await c.call('write_day_plan', { date: '2026-10-20', plan: id })).json.saved).toBe(true)
    const week = await c.call('read_week_plan', { from: '2026-10-20', days: 1 })
    expect(week.json.week.Tuesday).toEqual([{ id, name: 'Live Upper' }])

    const copy = await c.call('write_copy_routine', { id })
    expect(copy.json.routine.name).toBe('Live Upper (Copy)')

    const deleted = await c.call('delete_routine', { id })
    expect(deleted.json).toMatchObject({ removedFromWeekdays: ['Tuesday'], removedFromDates: ['2026-10-20'] })
    const routines = (await c.call('read_routines')).json.routines.map((r: { name: string }) => r.name)
    expect(routines).toContain('Live Upper (Copy)')
    expect(routines).not.toContain('Live Upper')
    await c.close()
  })
})
