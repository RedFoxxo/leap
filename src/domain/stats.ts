import type { ExerciseIndex } from '../catalog/exercises.js'
import { listOf, type Entry, type State } from '../state/types.js'
import { currentDbLoad, entryAs } from './dumbbells.js'
import {
  bestWeight,
  completedReps,
  doneUnits,
  entriesOf,
  entryVolume,
  hasCompletedWork,
  isWarmup,
  setMode,
  setsOf,
  sidesOf,
  targetOf,
} from './sets.js'

/**
 * Estimated one-rep max, as openGym computes it (docs/OPENGYM.md, "Stats").
 * Ported from openGym `frontend/src/lib/onerm.js` at v1.4.0 (28b7e4dc): seven
 * published formulas, and "weighted", a blend of all seven plus an RIR table.
 */
export const FORMULAS = {
  epley: (w: number, r: number) => w * (1 + r / 30),
  brzycki: (w: number, r: number) => (w * 36) / (37 - r),
  lombardi: (w: number, r: number) => w * r ** 0.1,
  oconner: (w: number, r: number) => w * (1 + r / 40),
  mayhew: (w: number, r: number) => (w * 100) / (52.2 + 41.9 * Math.exp(-0.055 * r)),
  wathan: (w: number, r: number) => (w * 100) / (48.8 + 53.8 * Math.exp(-0.075 * r)),
  lander: (w: number, r: number) => (w * 100) / (101.3 - 2.67123 * r),
} as const

export type Formula = keyof typeof FORMULAS | 'weighted'
export const FORMULA_NAMES = [...(Object.keys(FORMULAS) as (keyof typeof FORMULAS)[]), 'weighted'] as const

/** The formula the profile picked (Settings → 1RM formula); anything else reads as Epley, as in the app. */
export function formulaOf(state: State | null): Formula {
  const f = state?.oneRmFormula
  return typeof f === 'string' && (FORMULA_NAMES as readonly string[]).includes(f) ? (f as Formula) : 'epley'
}

/** Above this many reps a single formula gives no estimate. */
export const REP_CAP = 12
/** The blend tolerates a few more effective reps. */
export const WEIGHTED_REP_CAP = 15

/** %1RM at 1–15 reps to failure (the RTS chart). */
const RIR_PCT = [100, 95.5, 92.2, 89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 71.7, 69.5, 67.5, 65.5, 63.6]

/** Per formula: reliability, and from how many reps on its weight fades, how fast, down to what. */
const BLEND: Record<keyof typeof FORMULAS | 'table', { a: number; knee: number; slope: number; floor: number }> = {
  epley: { a: 0.95, knee: 6, slope: 0.12, floor: 0.4 },
  brzycki: { a: 1.1, knee: 8, slope: 0.18, floor: 0.3 },
  lombardi: { a: 0.85, knee: 5, slope: 0.1, floor: 0.4 },
  oconner: { a: 0.9, knee: 6, slope: 0.12, floor: 0.4 },
  mayhew: { a: 0.95, knee: 8, slope: 0.1, floor: 0.5 },
  wathan: { a: 0.9, knee: 7, slope: 0.12, floor: 0.4 },
  lander: { a: 0.85, knee: 7, slope: 0.15, floor: 0.35 },
  table: { a: 1, knee: 10, slope: 0.15, floor: 0.4 },
}

const blendWeight = (k: keyof typeof BLEND, r: number) => {
  const b = BLEND[k]
  return b.a * (r <= b.knee ? 1 : Math.max(b.floor, 1 - (r - b.knee) * b.slope))
}

function weightedEstimate(w: number, reps: number): number {
  let total = 0
  let sum = 0
  for (const [name, fn] of Object.entries(FORMULAS) as [keyof typeof FORMULAS, (w: number, r: number) => number][]) {
    const k = blendWeight(name, reps)
    total += fn(w, reps) * k
    sum += k
  }
  const table = (w * 100) / RIR_PCT[Math.min(Math.max(Math.round(reps) - 1, 0), RIR_PCT.length - 1)]!
  const k = blendWeight('table', reps)
  return (total + table * k) / (sum + k)
}

/**
 * One set's estimate: one rep (without reps in reserve) is the weight itself; a
 * single formula gives nothing above 12 reps and ignores RIR; the blend counts
 * reps plus RIR, up to 15. Rounded to 0.1.
 */
export function estimate1RM(w: unknown, r: unknown, formula: Formula = 'epley', rir: unknown = null): number | null {
  const weight = Number(w)
  const reps = Number(r)
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps < 1) return null
  const validRir = rir != null && Number(rir) >= 0
  if (reps === 1 && (!validRir || Number(rir) === 0)) return Math.round(weight * 10) / 10
  let est: number
  if (formula === 'weighted') {
    const effective = validRir ? reps + Number(rir) : reps
    if (effective > WEIGHTED_REP_CAP) return null
    est = weightedEstimate(weight, effective)
  } else {
    if (reps > REP_CAP) return null
    est = reps === 1 ? weight : (FORMULAS[formula] ?? FORMULAS.epley)(weight, Math.round(reps))
  }
  return Number.isFinite(est) && est > 0 ? Math.round(est * 10) / 10 : null
}

export interface BestSet {
  estimate: number
  w: number
  r: number
}

/** The completed work set with the highest estimate; each done side of a per-side row on its own. None for assistance machines. */
export function bestSet(entry: Entry, formula: Formula = 'epley', assisted = false): BestSet | null {
  if (assisted) return null
  let best: BestSet | null = null
  const target = targetOf(entry)
  for (const s of setsOf(entry)) {
    if (isWarmup(s) || setMode(s, target) !== 'reps' || !hasCompletedWork(s)) continue
    const sides = sidesOf(s)
    for (const row of sides ? [sides.L, sides.R].filter((x) => x.done === true) : [s]) {
      const estimate = estimate1RM(row.w, row.r, formula, row.rir ?? null)
      if (estimate !== null && (!best || estimate > best.estimate)) best = { estimate, w: Number(row.w), r: Math.round(Number(row.r)) }
    }
  }
  return best
}

export interface Session {
  workoutId: string
  date: string
  name?: string
  /** Work sets in logged order, e.g. "100×5", "60s", "20min". */
  sets: string[]
  workSets: number
  reps: number
  volume: number
  bestWeight: number
  best1RM: BestSet | null
  weightRecord: boolean
  estimateRecord: boolean
}

function setLabel(s: Entry, target: Entry): string {
  const mode = setMode(s, target)
  if (mode === 'time') return `${Number(s.sec) || 0}s${Number(s.w) ? ` @${Number(s.w)}` : ''}`
  if (mode === 'cardio') return `${Number(s.min) || 0}min${s.speed != null ? ` @${Number(s.speed)}km/h` : ''}`
  const sides = sidesOf(s)
  if (sides) return `L ${Number(sides.L.w) || 0}×${Number(sides.L.r) || 0} / R ${Number(sides.R.w) || 0}×${Number(sides.R.r) || 0}`
  const drops = Array.isArray(s.drops) && s.type === 'dropset' ? s.drops.map((d: Entry) => ` → ${Number(d.w) || 0}×${Number(d.r) || 0}`).join('') : ''
  return `${Number(s.w) || 0}×${Number(s.r) || 0}${drops}${s.type === 'restpause' ? ' (rest-pause)' : ''}`
}

/**
 * Whether `weight` is a better load than `previous`, as openGym judges a PR: the
 * first load ever logged counts, and on an assistance machine less help is better.
 */
export function beatsWeight(weight: number, previous: number, assisted = false): boolean {
  return weight > 0 && (previous <= 0 || (assisted ? weight < previous : weight > previous))
}

/** Every workout an exercise was done in, oldest first, with records marked against all earlier sessions. */
export function exerciseSessions(state: State | null, exerciseId: string, exercises: ExerciseIndex, formula: Formula = formulaOf(state)): Session[] {
  const assisted = exercises.assisted(exerciseId)
  const name = exercises.name(exerciseId)
  // Dumbbell weights are read in the exercise's current meaning, so sessions logged per bell and
  // both together compare like with like (openGym exercise-history.js, v1.4.0).
  const as = currentDbLoad(state, exerciseId)
  const out: Session[] = []
  let topWeight = 0
  let topEstimate = 0
  for (const w of listOf(state, 'workouts')) {
    const entries = entriesOf(w)
      .filter((e) => e.id === exerciseId)
      .map((e) => entryAs(e, as, name))
    if (!entries.length) continue
    const done = entries.flatMap((e) => setsOf(e).filter((s) => !isWarmup(s) && hasCompletedWork(s)).map((s) => ({ s, target: targetOf(e) })))
    if (!done.length) continue
    const weight = entries.reduce((best, e) => {
      const b = bestWeight(e, assisted)
      return beatsWeight(b, best, assisted) ? b : best
    }, 0)
    const best1RM = entries.map((e) => bestSet(e, formula, assisted)).reduce<BestSet | null>((a, b) => (b && (!a || b.estimate > a.estimate) ? b : a), null)
    const weightRecord = beatsWeight(weight, topWeight, assisted)
    const estimateRecord = best1RM !== null && best1RM.estimate > topEstimate
    if (weightRecord) topWeight = weight
    if (estimateRecord) topEstimate = best1RM.estimate
    out.push({
      workoutId: String(w.id),
      date: String(w.d),
      ...(typeof w.name === 'string' ? { name: w.name } : {}),
      sets: done.map(({ s, target }) => setLabel(s, target)),
      workSets: done.reduce((n, { s }) => n + doneUnits(s), 0),
      reps: done.reduce((n, { s }) => n + completedReps(s), 0),
      volume: Math.round(entries.reduce((v, e) => v + entryVolume(e, name), 0) * 100) / 100,
      bestWeight: weight,
      best1RM,
      weightRecord,
      estimateRecord,
    })
  }
  return out
}

/** Exercise ids that appear in any workout, in first-logged order. */
export function loggedExerciseIds(state: State | null): string[] {
  const seen = new Set<string>()
  for (const w of listOf(state, 'workouts')) for (const e of entriesOf(w)) if (typeof e.id === 'string') seen.add(e.id)
  return [...seen]
}

/** Secondary-muscle names in the exercise dataset, mapped onto its target-muscle names. */
const MUSCLE_ALIASES: Record<string, string> = {
  shoulders: 'delts',
  deltoids: 'delts',
  'rear deltoids': 'delts',
  quadriceps: 'quads',
  chest: 'pectorals',
  'upper chest': 'pectorals',
  trapezius: 'traps',
  'latissimus dorsi': 'lats',
  core: 'abs',
  abdominals: 'abs',
  'lower abs': 'abs',
  'inner thighs': 'adductors',
  groin: 'adductors',
  soleus: 'calves',
  // The app's body-map names, which custom exercises store.
  'upper-back': 'upper back',
  serratus: 'serratus anterior',
  forearm: 'forearms',
  'lower-back': 'lower back',
  gluteal: 'glutes',
  hamstring: 'hamstrings',
  'hip-flexors': 'hip flexors',
  tibialis: 'shins',
}

export const muscleName = (m: string) => MUSCLE_ALIASES[m.toLowerCase()] ?? m.toLowerCase()

/** Primary (target) muscles count 1 per completed work set, secondary ones 0.4, as in openGym's muscle map. */
export const SECONDARY_WEIGHT = 0.4

export interface MuscleLoad {
  muscle: string
  sets: number
  primarySets: number
  level: number
}

export function muscleLoads(workouts: Entry[], exercises: ExerciseIndex): { loads: MuscleLoad[]; unknownExercises: string[] } {
  const totals = new Map<string, { sets: number; primary: number }>()
  const unknown = new Set<string>()
  const add = (m: string, v: number, primary: boolean) => {
    const t = totals.get(m) ?? { sets: 0, primary: 0 }
    t.sets += v
    if (primary) t.primary += v
    totals.set(m, t)
  }
  for (const w of workouts) {
    for (const e of entriesOf(w)) {
      const sets = setsOf(e).filter((s) => !isWarmup(s)).reduce((n, s) => n + doneUnits(s), 0)
      if (!sets) continue
      const ex = exercises.get(String(e.id))
      if (!ex?.target) {
        unknown.add(String(e.id))
        continue
      }
      add(muscleName(ex.target), sets, true)
      for (const m of new Set(ex.secondary.map(muscleName))) if (m !== muscleName(ex.target)) add(m, sets * SECONDARY_WEIGHT, false)
    }
  }
  const max = Math.max(0, ...[...totals.values()].map((t) => t.sets))
  const loads = [...totals.entries()]
    .map(([muscle, t]) => ({
      muscle,
      sets: Math.round(t.sets * 10) / 10,
      primarySets: Math.round(t.primary * 10) / 10,
      level: max > 0 ? Math.min(4, Math.max(1, Math.ceil((t.sets / max) * 4))) : 0,
    }))
    .sort((a, b) => b.sets - a.sets || a.muscle.localeCompare(b.muscle))
  return { loads, unknownExercises: [...unknown] }
}
