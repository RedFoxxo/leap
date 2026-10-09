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

/**
 * When a settings or plan change can still be undone, said by the tools that write them: openGym
 * (1.3.10 and later) merges settings, plan days and notes one at a time, by their stamps (see
 * docs/OPENGYM.md, "Sync between devices").
 */
export const LAST_CHANGE_NOTE =
  'openGym merges settings and the plan one setting and one day at a time: only a device that changes the same setting or day later, before it syncs, keeps its own value.'

/** When a deleted entry can still come back, said by every delete tool. */
export const RESURRECTION_NOTE =
  'openGym records the deletion, so every updated device drops the entry too; it comes back only from a device still on openGym 1.3.9 with unsynced changes, or from a device that edits the entry after the deletion before it syncs.'
