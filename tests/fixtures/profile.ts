/**
 * A profile document in openGym's shape (docs/OPENGYM.md), written for leap's
 * tests. Covers every set kind, a combined day, a date override, a legacy
 * single-id weekday and unknown keys that must survive writes.
 */
export const T0 = new Date('2026-10-05T18:00:00').getTime()
const min = 60_000

export const PUSH = 'r-push'
export const LEGS = 'r-legs'
export const PULL = 'r-pull'

export function profile(): Record<string, unknown> {
  return {
    _ts: T0 + 90 * min,
    unit: 'kg',
    lang: 'de',
    effort: 'rir',
    weekStart: 1,
    targetW: 77,
    restSec: 120,
    reminder: { on: true, time: '07:30', tz: 'Europe/Warsaw' },
    routines: [
      {
        id: PUSH,
        name: 'Push Day',
        emoji: 'barbell',
        ex: [
          { id: '0025', sets: 4, reps: 8, weight: 80, restSec: 150, warmupSets: 2, prog: 'double', inc: 2.5, sg: 'sg1' },
          { id: '0294', sets: 3, reps: 12, repsMin: 10, repsMax: 12, weight: 14, sg: 'sg1', side: true },
        ],
        _ts: T0 - 10 * min,
      },
      { id: LEGS, name: 'Leg Day', emoji: 'legs', ex: [{ id: '0043', sets: 5, reps: 5, weight: 100 }] },
      { id: PULL, name: 'Pull Day', ex: [{ id: '0032', sets: 3, reps: 5, weight: 140 }] },
    ],
    week: { '1': [PUSH], '3': LEGS, '5': [PUSH, LEGS] },
    dayPlan: { '2026-10-09': 'rest', '2026-10-11': PULL, '2026-10-12': 'deleted-routine' },
    workouts: [
      {
        id: 'w-legs',
        d: '2026-09-30',
        start: new Date('2026-09-30T17:00:00').getTime(),
        end: new Date('2026-09-30T18:05:00').getTime(),
        routineIds: [LEGS],
        routineId: LEGS,
        name: 'Leg Day',
        entries: [
          {
            id: '0043',
            sets: [
              { w: 60, r: 5, done: true, phase: 'warmup' },
              { w: 100, r: 5, done: true, rir: 2 },
              { w: 100, r: 5, done: true, rir: 1, type: 'dropset', drops: [{ w: 80, r: 6 }, { w: 60, r: 8 }] },
              { w: 100, r: 12, done: true, type: 'restpause', clusters: [{ r: 3, restSec: 15 }, { r: 2, restSec: 15 }] },
              { w: 100, r: 5, done: false },
            ],
            topW: 100,
          },
          { id: '9001', sets: [{ min: 20, speed: 9.5, done: true }] },
        ],
        prs: ['0043'],
        vol: 3160,
      },
      {
        id: 'w-push',
        d: '2026-10-05',
        start: T0,
        end: T0 + 70 * min,
        routineIds: [PUSH, LEGS],
        routineId: PUSH,
        name: 'Push Day + Leg Day',
        bw: 78.4,
        note: 'Felt strong',
        entries: [
          { id: '0025', rid: PUSH, sets: [{ w: 82.5, r: 8, done: true, rpe: 8 }, { w: 82.5, r: 7, done: true }], topW: 82.5, note: 'pause reps' },
          {
            id: '0294',
            rid: PUSH,
            sg: 'sg1',
            sets: [
              { w: 14, r: 20, done: true, sides: { L: { w: 14, r: 10, done: true }, R: { w: 14, r: 10, done: true } } },
              { w: 16, r: 18, done: false, sides: { L: { w: 16, r: 10, done: true }, R: { w: 14, r: 8, done: false } } },
            ],
            topW: 16,
          },
          { id: 'cplank', rid: LEGS, sets: [{ sec: 60, w: 10, done: true }], topW: 10 },
        ],
        prs: ['0025'],
        vol: 1677.5,
        media: [{ kind: 'image', hash: 'a'.repeat(64), mime: 'image/webp', size: 1200, width: 800, height: 600, at: T0 }],
      },
    ],
    bodyweight: [
      { d: '2026-09-01', w: 81.2, t: 1 },
      { d: '2026-09-28', w: 79.0, t: 2 },
      { d: '2026-10-05', w: 78.4, t: 3 },
    ],
    customEx: [{ id: 'cplank', n: 'Weighted plank', bp: 'waist', eq: 'weighted', tg: 'abs', custom: true, _ts: 1 }],
    exWeights: { '0025': { w: 82.5, d: '2026-10-05' } },
    exNotes: { '0025': 'grip at the rings' },
    favEx: ['0025'],
    coach: { consent: { agreedAt: '2026-10-01T08:00:00.000Z', version: 1 } },
    futureFeature: { keep: 'me' },
  }
}
