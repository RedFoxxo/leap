/** Calendar days as the app stores them: local `YYYY-MM-DD`, no time zone. */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const pad = (n: number) => String(n).padStart(2, '0')

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Noon avoids daylight-saving edges when stepping whole days. */
export function dateOf(iso: string): Date {
  return new Date(`${iso}T12:00:00`)
}

export function isValidIsoDate(iso: string): boolean {
  return ISO_DATE.test(iso) && isoDate(dateOf(iso)) === iso
}

export function addDays(iso: string, days: number): string {
  const d = dateOf(iso)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** 0 = Sunday … 6 = Saturday, the keys of the app's `week`. */
export function weekdayOf(iso: string): number {
  return dateOf(iso).getDay()
}

/**
 * The user's time zone: the one the app files with the reminder (the phone's, kept up to date when
 * it travels), which openGym's server also takes as the user's day (`api/server.js` userNow,
 * `api/queue.js` dayIn). Undefined without a usable one: the machine's zone is used then.
 */
export function zoneOf(state: unknown): string | undefined {
  const reminder = typeof state === 'object' && state !== null ? (state as { reminder?: unknown }).reminder : undefined
  const tz = typeof reminder === 'object' && reminder !== null ? (reminder as { tz?: unknown }).tz : undefined
  return typeof tz === 'string' && tz && formatter(tz) ? tz : undefined
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    } catch {
      f = null
    }
    formatters.set(zone, f)
  }
  return f
}

interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

/** The wall clock at an instant: in `zone`, else the machine's. */
function wallAt(ms: number, zone: string | undefined): Wall {
  const f = zone ? formatter(zone) : null
  if (!f) {
    const d = new Date(ms)
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]))
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! }
}

const dayText = (w: Wall) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`

/** The calendar day of an instant, in `zone` (else the machine's). */
export function dayOf(ms: number, zone?: string): string {
  return dayText(wallAt(ms, zone))
}

/** Local date and time to the minute, e.g. `2026-10-05T18:47`, in `zone` (else the machine's); undefined for a missing timestamp. */
export function localDateTime(ms: unknown, zone?: string): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const w = wallAt(ms, zone)
  return `${dayText(w)}T${pad(w.h)}:${pad(w.mi)}`
}

export function today(now: number = Date.now(), zone?: string): string {
  return dayOf(now, zone)
}

/**
 * The instant a wall time `HH:MM` on a day names, in `zone` (else the machine's). An hour the clocks
 * repeat gives its first instant; one they skip, the hour after, as Date does.
 */
export function instantAt(iso: string, time: string, zone?: string): number {
  const [h, m] = time.split(':').map(Number)
  if (!zone || !formatter(zone)) {
    const d = dateOf(iso)
    d.setHours(h ?? 0, m ?? 0, 0, 0)
    return d.getTime()
  }
  const [y, mo, d] = iso.split('-').map(Number)
  const wall = Date.UTC(y!, mo! - 1, d!, h ?? 0, m ?? 0)
  const offset = (ms: number) => {
    const w = wallAt(ms, zone)
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000
  }
  const before = offset(wall - 12 * 3_600_000)
  const after = offset(wall + 12 * 3_600_000)
  const fits = [wall - before, wall - after].filter((t) => offset(t) === wall - t).sort((a, b) => a - b)
  return fits[0] ?? wall - before
}
