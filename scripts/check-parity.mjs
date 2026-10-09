#!/usr/bin/env node
// Compares leap's ports with openGym's own code on randomised documents, so a new openGym release
// can be checked before leap claims to support it.
//
//   npm run build
//   node scripts/check-parity.mjs <path to an openGym checkout at the release tag>
//
// Checks src/state/stamps.ts against frontend/src/lib/sync-merge.js (stampChange), and
// src/domain/queue.ts against frontend/src/lib/queue.js, rotation.js and history.js
// (effectiveRoutineIds, queueView, scheduleModeOf, refillAfter, saveRotation). Exits 1 on any
// difference and prints the first few.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/check-parity.mjs <path to an openGym checkout>')
  process.exit(2)
}
const app = (file) => import(pathToFileURL(resolve(source, 'frontend/src/lib', file)).href)
const leap = (file) => import(pathToFileURL(resolve(import.meta.dirname, '..', 'build', file)).href)

const [Sync, Q, R, H, LS, LQ] = await Promise.all([app('sync-merge.js'), app('queue.js'), app('rotation.js'), app('history.js'), leap('state/stamps.js'), leap('domain/queue.js')])

let seed = 11
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = (a) => a[Math.floor(rnd() * a.length)]
const c = (x) => JSON.parse(JSON.stringify(x))
const shown = []
let checks = 0
const differ = (what, a, b) => {
  if (shown.length < 5) shown.push(`${what}\n  openGym: ${JSON.stringify(a)}\n  leap:    ${JSON.stringify(b)}`)
}

// ---- stamping ----
for (let t = 0; t < 4000; t++) {
  const T = 1_790_000_000_000 + Math.floor(rnd() * 1e6)
  const prev = {
    _ts: T - 5000, restSec: 90, accent: pick(['lime', 'custom']), accentCustom: '#112233',
    week: { 1: ['a'], 3: ['b'] }, dayPlan: { '2026-10-01': 'a' }, exNotes: { '0025': 'x' },
    routines: [{ id: 'a', name: 'A', ex: [], _ts: T - 100, ...(rnd() < 0.5 ? { _f: { name: T - 100 } } : {}), ...(rnd() < 0.2 ? { _u: { name: [1, 2, T - 100] } } : {}) }, { id: 'b', name: 'B', ex: [{ id: '0025' }], _ts: T - 50 }],
    customEx: [{ id: 'c1', n: 'C', _ts: T - 10 }],
    equipProfiles: [{ id: 'e1', name: 'Home', equipment: [] }],
    workouts: [{ id: 'w1', d: '2026-10-01', start: T - 9000, end: T - 8000, entries: [], _ts: T - 7000 }, { id: 'w2', d: '2026-10-02', start: T - 6000 }],
    bodyweight: [{ d: '2026-10-01', w: 80, t: T - 3000 }],
    measurements: [{ d: '2026-10-01', t: T - 2000, waist: 80 }],
    favEx: ['0025'],
    dbLoad: { '0294': { mode: 'each', _ts: T - 20 } },
    ...(rnd() < 0.3 ? { deleted: { routines: { z: T + (rnd() < 0.5 ? 50000 : -50000) } } } : {}),
    ...(rnd() < 0.3 ? { edited: { restSec: T + Math.floor(rnd() * 100000) }, undone: { restSec: [1, 2, 3] } } : {}),
  }
  const next = c(prev)
  const ops = [
    () => (next.restSec = 120), () => delete next.accentCustom, () => ((next.accent = 'custom'), (next.accentCustom = '#000000')),
    () => (next.week[3] = ['a']), () => delete next.week[1], () => (next.dayPlan['2026-10-05'] = 'rest'), () => delete next.exNotes['0025'],
    () => next.routines[0] && (next.routines[0].name = 'A2'), () => next.routines.reverse(), () => next.routines.pop(), () => next.routines.push({ id: 'z', name: 'Z', ex: [] }),
    () => next.routines[1] && (next.routines[1].ex = []), () => next.routines[0] && (next.routines[0]._ts = 1), () => next.customEx[0] && (next.customEx[0].n = 'C2'), () => (next.customEx = []),
    () => next.equipProfiles[0] && (next.equipProfiles[0].name = 'Gym'), () => (next.equipProfiles = []),
    () => next.workouts[0] && ((next.workouts[0].note = 'n'), (next.workouts[0]._ts = 5)), () => (next.workouts = next.workouts.slice(1)), () => next.workouts.push({ id: 'w3', d: '2026-10-03', start: T, _ts: T }),
    () => next.bodyweight[0] && ((next.bodyweight[0].w = 79), (next.bodyweight[0].t = 1)), () => next.bodyweight.push({ d: '2026-10-02', w: 78, t: 2 }), () => (next.bodyweight = []),
    () => next.measurements[0] && ((next.measurements[0].waist = 79), (next.measurements[0].t = 1)), () => (next.measurements = []),
    () => (next.favEx = []), () => next.favEx.push('0043'), () => (next.dbLoad['0294'] = { mode: null, _ts: 3 }), () => (next.dbLoad['0333'] = { mode: 'total', _ts: 4 }),
    () => (next.newSetting = { a: 1 }), () => (next.dayNotes = { '2026-10-01': { tag: 'sick', _ts: 9 } }),
  ]
  for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) pick(ops)()
  const wall = T + pick([0, -1e7, 1e5])
  const a = c(next)
  const b = c(next)
  const nowA = Sync.stampChange(c(prev), a, wall)
  const nowB = LS.stampTime(c(prev), wall)
  LS.stampChange(c(prev), b, nowB)
  checks++
  if (nowA !== nowB || JSON.stringify(a) !== JSON.stringify(b)) differ('stampChange', { now: nowA, doc: a }, { now: nowB, doc: b })
}

// ---- rotation and queue ----
const ids = ['A', 'B', 'C', 'D']
const day = (n) => {
  const d = new Date('2026-10-01T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
const ms = (n) => new Date(`${day(n)}T18:00:00`).getTime()
for (let t = 0; t < 3000; t++) {
  const routines = ids.filter(() => rnd() < 0.85).map((id) => ({ id, name: `R${id}`, ex: [{ id: '0025' }] }))
  const seq = ids.filter(() => rnd() < 0.7)
  const rotation = rnd() < 0.8 ? { id: 'rot', sequence: seq, label: rnd() < 0.5 ? '' : 'L' } : null
  const qids = rnd() < 0.5 ? [...seq] : ids.filter(() => rnd() < 0.6)
  if (rnd() < 0.2 && qids.length) qids.push(qids[0])
  const startN = Math.floor(rnd() * 8)
  const queue0 = rnd() < 0.85 ? { ids: qids, since: ms(startN) - 3600000 * Math.floor(rnd() * 30), startsOn: day(startN), label: 'Q', ...(rnd() < 0.3 ? { strict: true } : {}), ...(rnd() < 0.7 ? { rotationId: 'rot' } : {}) } : null
  const queue = queue0 && rnd() < 0.1 ? (({ since: _since, ...rest }) => rest)(queue0) : queue0
  const workouts = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => {
    const n = Math.floor(rnd() * 12)
    const rs = ids.filter(() => rnd() < 0.35)
    return { id: `w${i}`, d: day(n), start: ms(n) + Math.floor(rnd() * 5) * 3600000 - 7200000, end: ms(n) + 3600000, routineIds: rs, name: rs.map((x) => `R${x}`).join(' + ') || 'Freestyle', entries: [] }
  }).sort((a, b) => (a.d < b.d ? -1 : 1))
  const dayPlan = {}
  for (let n = 0; n < 12; n++) if (rnd() < 0.2) dayPlan[day(n)] = pick([...ids, 'rest'])
  const week = {}
  for (let w = 0; w < 7; w++) if (rnd() < 0.4) week[w] = ids.filter(() => rnd() < 0.4)
  const S = { routines, rotation, queue, workouts, dayPlan, week, scheduleMode: pick([null, 'week', 'rotation']) }
  const today = day(Math.floor(rnd() * 10))
  for (let n = 0; n < 12; n++) {
    checks++
    const a = H.effectiveRoutineIds(c(S), day(n), today)
    const b = LQ.effectivePlan(c(S), day(n), today).routineIds
    if (JSON.stringify(a) !== JSON.stringify(b)) differ(`effective plan ${day(n)} (today ${today})`, a, b)
  }
  checks++
  const norm = (v) => v && { complete: v.complete, waiting: v.waiting, startsOn: v.startsOn, items: (v.items || v.sessions).map((i) => [i.id, i.state, i.on || i.pinnedTo || null]) }
  const va = norm(Q.queueView(c(S), today))
  const vb = norm(LQ.queueView(c(S), today))
  if (JSON.stringify(va) !== JSON.stringify(vb)) differ('queueView', va, vb)
  checks++
  if (R.scheduleModeOf(c(S)) !== LQ.scheduleModeOf(c(S))) differ('scheduleModeOf', R.scheduleModeOf(c(S)), LQ.scheduleModeOf(c(S)))
  if (!workouts.length) continue
  const now = ms(12)
  const sa = c(S)
  const sb = c(S)
  const ra = R.refillAfter(sa, sa.workouts.at(-1), today, now)
  const rb = LQ.refillAfter(sb, sb.workouts.at(-1), today, now)
  checks++
  if (ra !== !!rb || JSON.stringify(sa.queue) !== JSON.stringify(sb.queue) || JSON.stringify(sa.dayPlan) !== JSON.stringify(sb.dayPlan)) differ('refillAfter', sa.queue, sb.queue)
  const newIds = ids.filter(() => rnd() < 0.6)
  if (!newIds.length || !routines.length) continue
  const s1 = c(S)
  const s2 = c(S)
  R.saveRotation(s1, newIds, 'L2', today, now)
  LQ.saveRotation(s2, newIds, 'L2', () => 'NEW', today, now)
  const strip = (s) => ({ q: { ...s.queue, rotationId: s.queue?.rotationId ? 'x' : undefined }, dp: s.dayPlan, seq: s.rotation.sequence, label: s.rotation.label })
  checks++
  if (JSON.stringify(strip(s1)) !== JSON.stringify(strip(s2))) differ('saveRotation', strip(s1), strip(s2))
}

if (shown.length) {
  console.error(`${shown.length}+ differences in ${checks} checks:\n${shown.join('\n')}`)
  process.exit(1)
}
console.log(`no difference in ${checks} checks`)
