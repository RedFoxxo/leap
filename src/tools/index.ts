import { profileReadTools } from './account/profile.js'
import { accountReadTools } from './account/read.js'
import { exerciseReadTools } from './exercises/read.js'
import { routineDeleteTools, routineWriteTools } from './routines/write.js'
import { settingsDeleteTools, settingsWriteTools } from './settings/write.js'
import { statsReadTools } from './stats/read.js'
import { planReadTools } from './training/plan.js'
import { workoutReadTools } from './training/workouts.js'
import type { ToolDef } from './types.js'

export type AnyToolDef = ToolDef<any>

/** Every tool leap registers, in registration order. */
export function allTools(): AnyToolDef[] {
  return [
    ...profileReadTools,
    ...workoutReadTools,
    ...planReadTools,
    ...statsReadTools,
    ...exerciseReadTools,
    ...accountReadTools,
    ...routineWriteTools,
    ...settingsWriteTools,
    ...routineDeleteTools,
    ...settingsDeleteTools,
  ]
}
