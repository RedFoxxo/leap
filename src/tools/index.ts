import { accountReadTools } from './account/read.js'
import type { ToolDef } from './types.js'

export type AnyToolDef = ToolDef<any>

/** Every tool leap registers, in registration order. */
export function allTools(): AnyToolDef[] {
  return [...accountReadTools]
}
