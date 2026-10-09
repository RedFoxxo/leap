import type { Exercise } from './exercises.js'

/**
 * Exercise search, in leap's own words, close to how the app's library search
 * behaves (openGym `frontend/src/lib/exercises.js`, searchExercises, v1.4.0):
 * every query word must be found; a word may be a gym shorthand, a plural, a
 * run-together name ("benchpress") or, when nothing in the list has it, a
 * small typo; words also match the target muscle, equipment, body part and
 * secondary muscles, but a hit in the name counts more.
 */

/** Gym shorthand → what it stands for (each a phrase the name may hold). */
const SHORTHAND: Record<string, string[]> = {
  db: ['dumbbell'],
  bb: ['barbell'],
  kb: ['kettlebell'],
  ez: ['ez barbell'],
  bw: ['body weight'],
  ohp: ['overhead press', 'shoulder press', 'military press'],
  rdl: ['romanian deadlift'],
  sldl: ['stiff leg deadlift', 'straight leg deadlift'],
  dl: ['deadlift'],
  bp: ['bench press'],
  pullup: ['pull up'],
  pullups: ['pull up'],
  chinup: ['chin up'],
  chinups: ['chin up'],
  pushup: ['push up'],
  pushups: ['push up'],
  situp: ['sit up'],
  situps: ['sit up'],
  trx: ['suspension'],
  flyes: ['fly'],
  flies: ['fly'],
  bicep: ['biceps'],
  tricep: ['triceps'],
  quad: ['quads', 'quadriceps'],
  quads: ['quads', 'quadriceps'],
  hammy: ['hamstring'],
  hammies: ['hamstring'],
  lat: ['lats', 'lat'],
  delt: ['delts', 'deltoid'],
  // The catalogue names most weight-stack machines "lever …".
  machine: ['machine', 'lever'],
}

/** Lowercase, without accents, with hyphens and slashes as spaces. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_/,()]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** A plural's simple singular: "curls" → "curl", "presses" → "press"; short words and "abs" stay. */
function singular(w: string): string {
  if (w.length <= 3 || w === 'abs') return w
  if (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches') || w.endsWith('xes')) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Edit distance with adjacent swaps counted once, giving up beyond `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1)
      row.push(v)
      best = Math.min(best, v)
    }
    if (best > max) return max + 1
    rows.push(row)
  }
  return rows[a.length]![b.length]!
}

const typosAllowed = (w: string) => (w.length < 4 ? 0 : w.length <= 6 ? 1 : 2)

interface Prepared {
  e: Exercise
  name: string
  words: string[]
  other: string
}

const prepare = (e: Exercise): Prepared => {
  const name = normalize(e.name)
  return {
    e,
    name,
    words: name.split(' '),
    other: normalize([e.target, e.equipment, e.bodyPart, ...e.secondary, ...(e.primaryMuscles ?? [])].filter(Boolean).join(' ')),
  }
}

/** How well one query word (in its forms) hits an exercise: 0 is a miss. */
function wordScore(forms: string[], p: Prepared, typos: boolean): number {
  let best = 0
  for (const f of forms) {
    if (f.includes(' ')) {
      if (p.name.includes(f)) best = Math.max(best, 6)
      else if (p.other.includes(f)) best = Math.max(best, 1)
      continue
    }
    if (p.words.includes(f)) best = Math.max(best, 6)
    else if (p.words.some((w) => w.startsWith(f))) best = Math.max(best, 5)
    else if (p.name.includes(f)) best = Math.max(best, 4)
    else if (f.length >= 4 && p.words.some((_, i) => p.words.slice(i).join('').startsWith(f))) best = Math.max(best, 3)
    else if (p.other.split(' ').some((w) => w.startsWith(f))) best = Math.max(best, 1)
  }
  if (best === 0 && typos) {
    const w = forms[0]!
    const max = typosAllowed(w)
    if (max > 0 && p.words.some((n) => distance(w, n, max) <= max || (w.length >= 5 && n.length > w.length && distance(w, n.slice(0, w.length), max) <= max))) best = 2
  }
  return best
}

export interface SearchOptions {
  /** Ids sorted first among equal matches. */
  favourites?: Set<string>
}

/** The exercises that match every word of `query`, best first. An empty query keeps the list, sorted by name. */
export function searchExercises(list: Exercise[], query: string, options: SearchOptions = {}): Exercise[] {
  const favourites = options.favourites ?? new Set<string>()
  const q = normalize(query)
  const tiebreak = (a: Exercise, b: Exercise) =>
    Number(favourites.has(b.id)) - Number(favourites.has(a.id)) ||
    Number(b.custom) - Number(a.custom) ||
    Number(b.classic === true) - Number(a.classic === true) ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name)
  if (!q) return [...list].sort(tiebreak)
  const prepared = list.map(prepare)
  const words = q.split(' ')
  const formsOf = words.map((w) => [...new Set([w, singular(w), ...(SHORTHAND[w] ?? [])])])
  // A typo is only forgiven for a word that nothing in the list has as it was typed.
  const literal = formsOf.map((forms) => prepared.some((p) => wordScore(forms, p, false) > 0))
  const scored: { e: Exercise; score: number }[] = []
  for (const p of prepared) {
    if (p.e.id === query.trim()) {
      scored.push({ e: p.e, score: 1000 })
      continue
    }
    let score = 0
    let miss = false
    for (const [i, forms] of formsOf.entries()) {
      const s = wordScore(forms, p, !literal[i])
      if (s === 0) {
        miss = true
        break
      }
      score += s
    }
    if (miss) continue
    if (p.name === q) score += 20
    score -= 0.2 * Math.max(0, p.words.length - words.length)
    scored.push({ e: p.e, score })
  }
  scored.sort((a, b) => b.score - a.score || tiebreak(a.e, b.e))
  return scored.map((s) => s.e)
}
