import type { Result } from '../http/result.js'
import type { Mutate, UpdateOptions, Written } from '../state/store.js'
import type { ToolContext } from './context.js'
import { failure, success } from './respond.js'
import type { ToolOutput } from './types.js'

/**
 * What every write tool reports: what was saved, the new revision, and
 * anything to know (conflicts redone, values that did not persist, warnings).
 */
export function written<R>(r: Written<R>, shown: Record<string, unknown>): ToolOutput {
  if (r.unchanged) return success({ saved: false, unchanged: true, ...shown, message: 'That is already how the profile stands; nothing was written.' })
  return success({
    saved: r.notPersisted.length ? 'partly' : true,
    revision: r.rev,
    ...shown,
    ...(r.notPersisted.length ? { notPersisted: r.notPersisted } : {}),
    ...(r.verified ? {} : { verified: false }),
    ...(r.retries ? { conflictsRedone: r.retries } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
  })
}

/** Runs a change through the store and reports it. */
export async function change<R>(
  ctx: ToolContext,
  what: string,
  mutate: Mutate<R>,
  show: (result: R) => Record<string, unknown>,
  options: UpdateOptions<R> = {},
): Promise<ToolOutput> {
  const r: Result<Written<R>> = await ctx.store.update(mutate, options)
  if (!r.ok) return r.code === 'refused' ? failure(`Not saved: ${r.message}`) : failure(`Could not ${what}`, r)
  return written(r.data, show(r.data.result))
}

/** When a deleted entry can still come back, said by every delete tool that records one (in its answer). */
export const RESURRECTION_NOTE =
  'openGym records the deletion; the entry comes back only from a device still on openGym 1.3.9 with unsynced changes, or one that edits it after the deletion, before it syncs.'

/**
 * leap's server instructions, sent once per session instead of in every tool description: when a
 * change can still be undone by another device. openGym (1.3.10 and later) merges settings, plan
 * days and notes one at a time, by their stamps (see docs/OPENGYM.md, "Sync between devices").
 */
export const INSTRUCTIONS = [
  "leap changes an openGym profile that the openGym app on the user's devices syncs too.",
  'Settings (write_settings, write_goal_weight, write_document), exercise notes and the plan (weekdays, dates, rotation, schedule mode, round, queue, day notes):' +
    ' openGym syncs one setting and one day at a time: a device that changes the same one later, before it syncs, keeps its value.',
  `Deleted workouts, routines, custom exercises, weigh-ins and measurements: ${RESURRECTION_NOTE}`,
].join('\n')
