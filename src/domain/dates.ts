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

/** Local date and time to the minute, e.g. `2026-10-05T18:47`; undefined for a missing timestamp. */
export function localDateTime(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const d = new Date(ms)
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function today(now: number = Date.now()): string {
  return isoDate(new Date(now))
}
