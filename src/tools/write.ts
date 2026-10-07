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
  return success({
    saved: true,
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

/** Why a deleted entry can come back, said by every delete tool. */
/**
 * Why a settings or plan change can be undone, said by the tools that write them: openGym merges
 * settings, the week plan and date overrides whole, from the copy changed last (verified with its
 * own merge code; see docs/OPENGYM.md, "Sync between devices").
 */
export const LAST_CHANGE_NOTE =
  'openGym takes settings and the plan as a whole from the copy changed last: a device that made its own unsynced change after this write keeps its values when it syncs. Check again later if that matters.'

export const RESURRECTION_NOTE =
  'openGym keeps no record of deletions: a device that still holds unsynced changes from before this delete brings the entry back when it syncs. Check again later if that matters.'
