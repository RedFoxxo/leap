import { z } from 'zod'
import { today } from '../../domain/dates.js'
import { newId } from '../../state/ids.js'
import { apply, refuse } from '../../state/store.js'
import { isRecord, listOf, unitOf, writableList, type Entry, type State } from '../../state/types.js'
import { loadProfile } from '../context.js'
import { failure, invalid, success } from '../respond.js'
import { isoDate, limit } from '../schema.js'
import { defineTool } from '../types.js'
import { change, RESURRECTION_NOTE } from '../write.js'

/**
 * Body measurements (openGym 1.4.0), stored as the app stores them (openGym
 * `frontend/src/lib/measurements.js`, v1.4.0): one check-in per day
 * `{ d, t, <every built-in kind>: cm | null, other: [{ id, name, value }] }`,
 * lengths always in centimetres whatever the weight unit (a lb profile sees
 * inches), body fat in percent; custom kinds in `customMeasurements`.
 */

export const MEASUREMENT_KINDS = [
  'neck', 'shoulders', 'chest', 'waist', 'hips', 'abdomen',
  'upperArmLeft', 'upperArmRight', 'forearmLeft', 'forearmRight', 'wristLeft', 'wristRight',
  'thighLeft', 'thighRight', 'calfLeft', 'calfRight', 'ankleLeft', 'ankleRight', 'bodyFat',
] as const
type Kind = (typeof MEASUREMENT_KINDS)[number]

/** Shown in the app's form unless the profile chose otherwise (`measurementEnabled`). */
const SHOWN_BY_DEFAULT = MEASUREMENT_KINDS.filter((k) => !['abdomen', 'wristLeft', 'wristRight', 'ankleLeft', 'ankleRight', 'bodyFat'].includes(k))
const LABELS: Record<Kind, string> = {
  neck: 'Neck', shoulders: 'Shoulders', chest: 'Chest', waist: 'Waist', hips: 'Hips', abdomen: 'Abdomen',
  upperArmLeft: 'Left upper arm', upperArmRight: 'Right upper arm', forearmLeft: 'Left forearm', forearmRight: 'Right forearm',
  wristLeft: 'Left wrist', wristRight: 'Right wrist', thighLeft: 'Left thigh', thighRight: 'Right thigh',
  calfLeft: 'Left calf', calfRight: 'Right calf', ankleLeft: 'Left ankle', ankleRight: 'Right ankle', bodyFat: 'Body fat',
}

const round1 = (v: number) => Math.round(v * 10) / 10
const valid = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? round1(Number(v)) : null)
const lengthUnit = (state: State | null) => (unitOf(state) === 'lb' ? 'in' : 'cm')

interface CustomKind {
  id: string
  name: string
  enabled: boolean
}

function customKinds(state: State | null): CustomKind[] {
  const seen = new Set<string>()
  const out: CustomKind[] = []
  for (const c of listOf(state, 'customMeasurements')) {
    const id = typeof c.id === 'string' ? c.id : ''
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: name.slice(0, 60), enabled: c.enabled !== false })
  }
  return out
}

/** An entry for output: the values it has, in the unit the app shows them. */
function shown(e: Entry, state: State | null) {
  const inches = lengthUnit(state) === 'in'
  const values: Record<string, number> = {}
  for (const k of MEASUREMENT_KINDS) {
    const v = valid(e[k])
    if (v !== null) values[k] = k === 'bodyFat' || !inches ? v : round1(v / 2.54)
  }
  const other = listOf(e, 'other')
    .map((o) => ({ name: String(o.name ?? 'Other'), value: valid(o.value) }))
    .filter((o): o is { name: string; value: number } => o.value !== null)
    .map((o) => ({ name: o.name, value: inches ? round1(o.value / 2.54) : o.value }))
  return { date: e.d, ...values, ...(other.length ? { other } : {}) }
}

export const readMeasurements = defineTool({
  name: 'read_measurements',
  description:
    'Body measurements (waist, arms, body fat, the profile\'s own kinds …), newest first: lengths in cm, or in inches for a lb profile, as the app shows them; body fat in %. Also the latest value of each kind with its change since the first one in the range, which kinds the app\'s form shows, and the custom kinds.',
  input: { from: isoDate.optional(), to: isoDate.optional(), limit: limit(30, 2000) },
  async handler(args, ctx) {
    const profile = await loadProfile(ctx)
    if (!profile.ok) return failure('Could not read the profile', profile)
    const { state } = profile.data
    const all = listOf(state, 'measurements')
      .filter((e) => typeof e.d === 'string')
      .sort((a, b) => String(a.d).localeCompare(String(b.d)))
    const inRange = all.filter((e) => (!args.from || String(e.d) >= args.from) && (!args.to || String(e.d) <= args.to))
    const rows = inRange.map((e) => shown(e, state))
    const latest: Record<string, { value: number; date: unknown; change?: number }> = {}
    for (const k of MEASUREMENT_KINDS) {
      const withValue = rows.filter((r) => typeof (r as Record<string, unknown>)[k] === 'number')
      const last = withValue.at(-1) as Record<string, unknown> | undefined
      const first = withValue[0] as Record<string, unknown> | undefined
      if (last) latest[k] = { value: Number(last[k]), date: last.date, ...(first && first !== last ? { change: round1(Number(last[k]) - Number(first[k])) } : {}) }
    }
    const enabled = Array.isArray(state?.measurementEnabled) ? state.measurementEnabled.filter((k): k is string => typeof k === 'string') : SHOWN_BY_DEFAULT
    const max = args.limit ?? 30
    const newest = rows.reverse()
    return success({
      lengthUnit: lengthUnit(state),
      shownInApp: MEASUREMENT_KINDS.filter((k) => enabled.includes(k)),
      ...(customKinds(state).length ? { customKinds: customKinds(state).map((c) => ({ name: c.name, ...(c.enabled ? {} : { hidden: true }) })) } : {}),
      latest,
      total: newest.length,
      ...(newest.length > max ? { truncated: true } : {}),
      entries: newest.slice(0, max),
    })
  },
})

const value = z.number().positive().max(1000).nullable()

export const writeMeasurement = defineTool({
  name: 'write_measurement',
  description:
    'Log body measurements for a day (default today; one check-in per day, so values given here join or replace that day\'s, and null removes one). Lengths in `unit` (default the one the app shows: cm, or in for a lb profile), stored in cm as the app does; bodyFat in %. `custom` takes the profile\'s own kinds by name, and a new name creates that kind. Kinds: ' +
    MEASUREMENT_KINDS.join(', ') +
    '.',
  input: {
    date: isoDate.optional(),
    values: z.object(Object.fromEntries(MEASUREMENT_KINDS.map((k) => [k, value.optional()])) as Record<Kind, z.ZodOptional<typeof value>>).strict().optional(),
    custom: z.record(z.string().trim().min(1).max(60), value).optional().describe('Own kinds by name, e.g. { "Glutes": 98 }'),
    unit: z.enum(['cm', 'in']).optional(),
  },
  async handler(args, ctx) {
    const date = args.date ?? today(ctx.now())
    if (date > today(ctx.now())) return invalid(`${date} is in the future; measurements are logged for a day that happened`)
    const given = Object.entries(args.values ?? {}).filter(([, v]) => v !== undefined) as [Kind, number | null][]
    const custom = Object.entries(args.custom ?? {})
    if (!given.length && !custom.length) return invalid('no measurement given')
    if (given.some(([k, v]) => k === 'bodyFat' && v !== null && v > 100)) return invalid('body fat is a percentage, at most 100')
    return change(
      ctx,
      'save the measurements',
      (draft, { now }) => {
        const unit = args.unit ?? lengthUnit(draft)
        const cm = (v: number | null) => (v === null ? null : valid(unit === 'in' ? v * 2.54 : v))
        const kinds = writableList(draft, 'customMeasurements')
        const known = customKinds(draft)
        const created: string[] = []
        const otherValues = new Map<string, { name: string; value: number | null }>()
        for (const [name, v] of custom) {
          let kind = known.find((c) => c.name.toLowerCase() === name.toLowerCase())
          if (!kind) {
            if (Object.values(LABELS).some((l) => l.toLowerCase() === name.toLowerCase())) return refuse(`"${name}" is a built-in kind; give it in values`)
            kind = { id: newId('', now + created.length), name, enabled: true }
            kinds.push({ ...kind })
            known.push(kind)
            created.push(name)
          }
          otherValues.set(kind.id, { name: kind.name, value: cm(v) })
        }
        const list = writableList(draft, 'measurements')
        const i = list.findIndex((e) => isRecord(e) && e.d === date)
        const old = i >= 0 ? (list[i] as Entry) : undefined
        const entry: Entry = { ...(old ?? {}), d: date, t: now }
        for (const k of MEASUREMENT_KINDS) entry[k] = valid(old?.[k])
        for (const [k, v] of given) entry[k] = k === 'bodyFat' ? (v === null ? null : valid(v)) : cm(v)
        const other = new Map(listOf(old, 'other').filter((o) => typeof o.id === 'string').map((o) => [String(o.id), { ...o }]))
        for (const kind of known) if (!other.has(kind.id)) other.set(kind.id, { id: kind.id, name: kind.name, value: null })
        for (const [id, o] of otherValues) other.set(id, { ...(other.get(id) ?? {}), id, name: o.name, value: o.value })
        entry.other = [...other.values()]
        const hasValue = MEASUREMENT_KINDS.some((k) => entry[k] !== null) || listOf(entry, 'other').some((o) => valid(o.value) !== null)
        if (!hasValue) return refuse(old ? `that would leave ${date} without any measurement; delete_measurement removes the day` : 'no value to log')
        const unchanged = old && JSON.stringify({ ...old, t: 0 }) === JSON.stringify({ ...entry, t: 0 })
        // Unchanged, the day keeps its stamp: a fresh one would outrank an unsynced change elsewhere.
        if (unchanged) return apply({ entry: shown(old, draft), unit: lengthUnit(draft), created, hidden: [] as Kind[], replaced: true })
        if (i >= 0) list[i] = entry
        else list.push(entry)
        draft.measurements = list.filter(isRecord).sort((a, b) => String(a.d).localeCompare(String(b.d)))
        const enabled = Array.isArray(draft.measurementEnabled) ? draft.measurementEnabled : SHOWN_BY_DEFAULT
        const hidden = given.filter(([k, v]) => v !== null && !enabled.includes(k)).map(([k]) => k)
        return apply({ entry: shown(entry, draft), unit: lengthUnit(draft), created, hidden, replaced: !!old })
      },
      (r) => ({
        measurement: r.entry,
        lengthUnit: r.unit,
        ...(r.replaced ? { joinedExisting: true } : {}),
        ...(r.created.length ? { createdKinds: r.created } : {}),
        ...(r.hidden.length ? { note: `${r.hidden.join(', ')} ${r.hidden.length > 1 ? 'are' : 'is'} saved but hidden in the app's form; turn ${r.hidden.length > 1 ? 'them' : 'it'} on in the app's measurement settings` } : {}),
      }),
      { verify: (s) => (listOf(s, 'measurements').some((e) => e.d === date) ? [] : [`measurements ${date}`]) },
    )
  },
})

export const deleteMeasurement = defineTool({
  name: 'delete_measurement',
  description: `Delete the body measurements of a day. ${RESURRECTION_NOTE}`,
  input: { date: isoDate },
  async handler(args, ctx) {
    return change(
      ctx,
      'delete the measurements',
      (draft) => {
        if (!listOf(draft, 'measurements').some((e) => e.d === args.date)) return refuse(`there are no measurements on ${args.date}`)
        draft.measurements = writableList(draft, 'measurements').filter((e) => !(isRecord(e) && e.d === args.date))
        return apply(null)
      },
      () => ({ deleted: { date: args.date }, note: RESURRECTION_NOTE }),
      { verify: (s) => (listOf(s, 'measurements').some((e) => e.d === args.date) ? [`measurements ${args.date} are still there`] : []) },
    )
  },
})

export const measurementReadTools = [readMeasurements]
export const measurementWriteTools = [writeMeasurement]
export const measurementDeleteTools = [deleteMeasurement]
