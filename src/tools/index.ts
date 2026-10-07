import { accountReadTools } from './account/read.js'
import { exerciseReadTools } from './exercises/read.js'
import { planReadTools } from './training/plan.js'
import { workoutReadTools } from './training/workouts.js'
import type { ToolDef } from './types.js'

export type AnyToolDef = ToolDef<any>

/** Every tool leap registers, in registration order. */
export function allTools(): AnyToolDef[] {
  return [...accountReadTools, ...workoutReadTools, ...planReadTools, ...exerciseReadTools]
}
