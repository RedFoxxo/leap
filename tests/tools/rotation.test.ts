import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGS, profile, PULL, PUSH } from '../fixtures/profile.js'
import { FakeOpenGym } from '../helpers/fake-opengym.js'
import { harness } from '../helpers/harness.js'

const NOW = new Date('2026-10-07T08:00:00').getTime()
const HOUR = 3_600_000

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

async function setup(state: Record<string, unknown> = profile(), now = () => NOW) {
  const fake = new FakeOpenGym(state, 50)
  fake.stub.get('/api/me', { user: { id: 'u1', name: 'Foxxo' } })
  const h = await harness({ stub: fake.stub, context: { now } })
  const doc = () => fake.state as Record<string, any>
  return { fake, h, doc }
}

const log = (h: Awaited<ReturnType<typeof harness>>, routineId: string, exerciseId: string, date?: string) =>
  h.call('write_log_workout', { routineIds: [routineId], ...(date ? { date } : {}), entries: [{ exerciseId, sets: [{ weight: 50, reps: 5 }] }] })

describe('write_rotation', () => {
  it('saves the loop and starts a round the app owns; today plans its first session', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_rotation', { routineIds: [PUSH, LEGS, PULL] })
    expect(r.json).toMatchObject({ saved: true, schedule: 'rotation', round: { managedBy: 'app', done: 0, total: 3, startsOn: '2026-10-07' } })
    expect(doc().rotation).toMatchObject({ sequence: [PUSH, LEGS, PULL], label: '' })
    expect(doc().queue).toMatchObject({ ids: [PUSH, LEGS, PULL], since: NOW, startsOn: '2026-10-07', label: '', rotationId: doc().rotation.id })
    expect(doc().scheduleMode).toBe('rotation')
    expect(doc().edited).toMatchObject({ queue: NOW, rotation: NOW, scheduleMode: NOW })

    const plan = await h.call('read_week_plan', { days: 2 })
    // The profile's override of 2026-10-11 names Pull Day, a session of the round: it now pins it there.
    expect(plan.json).toMatchObject({ schedule: 'rotation', rotation: { managedBy: 'app', sessions: [{ state: 'next' }, { state: 'later' }, { state: 'pinned', pinnedTo: '2026-10-11' }] } })
    // Wednesday plans Leg Day by weekday, but it is in the loop: the loop's session is the day's.
    expect(plan.json.days[0]).toMatchObject({ routines: [{ id: PUSH }], plannedBy: 'rotation' })
    expect(plan.json.days[1]).toMatchObject({ rest: true, plannedBy: 'rest' })
    const profileR = await h.call('read_profile')
    expect(profileR.json).toMatchObject({ schedule: 'rotation', rotation: { managedBy: 'app', done: 0, total: 3, next: { id: PUSH } } })
    expect(profileR.json).not.toHaveProperty('nextTraining')
    await h.close()
  })

  it('refuses repeats and unknown routines', async () => {
    const { h, fake } = await setup()
    expect((await h.call('write_rotation', { routineIds: [PUSH, PUSH] })).text).toMatch(/once/)
    expect((await h.call('write_rotation', { routineIds: ['nope'] })).text).toMatch(/no routine with id "nope"/)
    expect(fake.puts).toHaveLength(0)
    await h.close()
  })
})

describe('the round and logged workouts', () => {
  it('credits sessions and starts the next round the day after the one that closed it', async () => {
    let now = NOW
    const { h, doc } = await setup(profile(), () => now)
    await h.call('write_rotation', { routineIds: [PUSH, LEGS, PULL] })
    now += HOUR
    vi.setSystemTime(now)
    const first = await log(h, PUSH, '0025')
    expect(first.json.rotation).toEqual({ sessionsDone: ['Push Day'] })
    now += 24 * HOUR
    vi.setSystemTime(now)
    await log(h, LEGS, '0043')
    now += 24 * HOUR
    vi.setSystemTime(now)
    const last = await log(h, PULL, '0032')
    expect(last.json.rotation).toEqual({ sessionsDone: ['Pull Day'], roundComplete: true, nextRound: { startsOn: '2026-10-10', sessions: ['Push Day', 'Leg Day', 'Pull Day'] } })
    expect(doc().queue).toMatchObject({ startsOn: '2026-10-10', rotationId: doc().rotation.id })
    expect(doc().queue.since).toBeGreaterThan(doc().workouts.at(-1).start)
    await h.close()
  })

  it('pins a session to a date with write_day_plan', async () => {
    const { h } = await setup()
    await h.call('write_rotation', { routineIds: [PUSH, LEGS] })
    const r = await h.call('write_day_plan', { date: '2026-10-08', plan: LEGS })
    expect(r.json).toMatchObject({ kind: 'pin' })
    const plan = await h.call('read_week_plan', { days: 2 })
    expect(plan.json.days[1]).toMatchObject({ routines: [{ id: LEGS }], plannedBy: 'pin' })
    expect(plan.json.rotation.sessions[1]).toMatchObject({ state: 'pinned', pinnedTo: '2026-10-08' })
    await h.close()
  })
})

describe('write_schedule_mode and write_rotation_round', () => {
  it('goes back to the fixed week, keeps the loop, and starts it again later', async () => {
    const { h, doc } = await setup()
    await h.call('write_rotation', { routineIds: [PUSH, LEGS] })
    const week = await h.call('write_schedule_mode', { mode: 'week' })
    expect(week.json).toMatchObject({ schedule: 'week', roundStopped: true })
    expect(doc().queue).toBeNull()
    expect(doc().rotation.sequence).toEqual([PUSH, LEGS])
    expect((await h.call('read_week_plan', { days: 1 })).json.days[0]).toMatchObject({ routines: [{ id: LEGS }], plannedBy: 'weekday' })
    const back = await h.call('write_schedule_mode', { mode: 'rotation' })
    expect(back.json).toMatchObject({ schedule: 'rotation', roundStarted: true, round: { total: 2 } })
    await h.close()
  })

  it('starts the loop over: a strict round from today', async () => {
    const { h, doc } = await setup()
    await h.call('write_rotation', { routineIds: [PUSH, LEGS] })
    await log(h, PUSH, '0025')
    const r = await h.call('write_rotation_round', { action: 'restart' })
    expect(r.json).toMatchObject({ round: { done: 0, total: 2 } })
    expect(doc().queue.strict).toBe(true)
    expect((await h.call('write_rotation_round', { action: 'start' })).text).toMatch(/already running/)
    await h.call('write_rotation_round', { action: 'stop' })
    expect(doc().queue).toBeNull()
    expect(doc().scheduleMode).toBe('rotation')
    await h.close()
  })
})

describe('write_session_queue', () => {
  it('writes a planner queue the app shows as externally managed, and clears it', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_session_queue', { routineIds: [LEGS, PULL], label: 'Week 3' })
    expect(r.json).toMatchObject({ schedule: 'rotation', queue: { managedBy: 'planner', label: 'Week 3', total: 2 } })
    expect(doc().queue).not.toHaveProperty('rotationId')
    expect((await h.call('read_week_plan', { days: 1 })).json.days[0]).toMatchObject({ routines: [{ id: LEGS }], plannedBy: 'queue' })
    expect((await h.call('write_rotation', { routineIds: [PUSH] })).text).toMatch(/planner's queue \("Week 3"\) is running; adopt: true/)
    expect((await h.call('write_rotation_round', { action: 'stop' })).text).toMatch(/planner's/)
    const week = await h.call('write_schedule_mode', { mode: 'week' })
    expect(week.json.note).toMatch(/still running/)
    await h.call('write_session_queue', { routineIds: null })
    expect(doc().queue).toBeNull()
    expect(doc().edited.queue).toBeGreaterThan(NOW)
    await h.close()
  })

  it('is adopted as the user’s own rotation', async () => {
    const { h, doc } = await setup()
    await h.call('write_session_queue', { routineIds: [LEGS, PULL] })
    const r = await h.call('write_rotation', { routineIds: [LEGS, PULL], adopt: true })
    expect(r.json).toMatchObject({ adopted: true, round: { managedBy: 'app' } })
    expect(doc().queue.rotationId).toBe(doc().rotation.id)
    await h.close()
  })
})

describe('write_day_note', () => {
  it('notes a missed day, stamped, and clears it with a stamped empty entry', async () => {
    const { h, doc } = await setup()
    const r = await h.call('write_day_note', { date: '2026-10-06', tag: 'sick', text: ' flu ' })
    expect(r.json).toMatchObject({ saved: true, note: { tag: 'sick', text: 'flu' } })
    expect(doc().dayNotes['2026-10-06']).toEqual({ tag: 'sick', text: 'flu', _ts: NOW })
    expect((await h.call('read_week_plan', { from: '2026-10-06', days: 1 })).json.days[0].note).toEqual({ tag: 'sick', text: 'flu' })
    await h.call('write_day_note', { date: '2026-10-06', tag: null, text: '' })
    expect(doc().dayNotes['2026-10-06']).toEqual({ _ts: NOW + 1 })
    await h.close()
  })

  it('refuses the future, says when the day had training', async () => {
    const { h } = await setup()
    expect((await h.call('write_day_note', { date: '2026-10-08', tag: 'travel' })).text).toMatch(/future/)
    expect((await h.call('write_day_note', { date: '2026-10-05', tag: 'rest' })).json.warning).toMatch(/workout is logged/)
    await h.close()
  })
})

describe('delete_routine and the round', () => {
  it('says when the deleted routine was the last of the round', async () => {
    const { h } = await setup()
    await h.call('write_rotation', { routineIds: [PULL] })
    const r = await h.call('delete_routine', { id: PULL })
    expect(r.json.inRound).toMatch(/last routine of the running round/)
    expect((await h.call('read_week_plan', { days: 1 })).json.rotationProblem).toMatch(/discard/)
    await h.close()
  })
})
