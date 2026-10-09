import { profileReadTools } from './account/profile.js'
import { coachDeleteTools, coachReadTools, coachWriteTools } from './coach/tools.js'
import { mediaDeleteTools, mediaReadTools, mediaWriteTools } from './media/tools.js'
import { accountReadTools } from './account/read.js'
import { accountDeleteTools, accountExtraReadTools, accountWriteTools } from './account/write.js'
import { adminTools } from './admin/tools.js'
import { exerciseReadTools } from './exercises/read.js'
import { exerciseDeleteTools, exerciseWriteTools } from './exercises/write.js'
import { rotationWriteTools } from './routines/rotation.js'
import { routineDeleteTools, routineWriteTools } from './routines/write.js'
import { measurementDeleteTools, measurementReadTools, measurementWriteTools } from './settings/measurements.js'
import { settingsDeleteTools, settingsWriteTools } from './settings/write.js'
import { statsReadTools } from './stats/read.js'
import { planReadTools } from './training/plan.js'
import { workoutReadTools } from './training/workouts.js'
import type { ToolDef } from './types.js'
import { workoutDeleteTools, workoutWriteTools } from './workouts/write.js'

export type AnyToolDef = ToolDef<any>

/** Every tool leap registers, in registration order. */
export function allTools(): AnyToolDef[] {
  return [
    ...profileReadTools,
    ...workoutReadTools,
    ...planReadTools,
    ...measurementReadTools,
    ...statsReadTools,
    ...exerciseReadTools,
    ...mediaReadTools,
    ...coachReadTools,
    ...accountReadTools,
    ...accountExtraReadTools,
    ...workoutWriteTools,
    ...routineWriteTools,
    ...rotationWriteTools,
    ...exerciseWriteTools,
    ...settingsWriteTools,
    ...measurementWriteTools,
    ...mediaWriteTools,
    ...coachWriteTools,
    ...accountWriteTools,
    ...workoutDeleteTools,
    ...routineDeleteTools,
    ...exerciseDeleteTools,
    ...settingsDeleteTools,
    ...measurementDeleteTools,
    ...mediaDeleteTools,
    ...coachDeleteTools,
    ...accountDeleteTools,
    ...adminTools,
  ]
}
