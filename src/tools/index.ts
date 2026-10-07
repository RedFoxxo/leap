import { profileReadTools } from './account/profile.js'
import { coachDeleteTools, coachReadTools, coachWriteTools } from './coach/tools.js'
import { mediaDeleteTools, mediaReadTools, mediaWriteTools } from './media/tools.js'
import { accountReadTools } from './account/read.js'
import { exerciseReadTools } from './exercises/read.js'
import { exerciseDeleteTools, exerciseWriteTools } from './exercises/write.js'
import { routineDeleteTools, routineWriteTools } from './routines/write.js'
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
    ...statsReadTools,
    ...exerciseReadTools,
    ...mediaReadTools,
    ...coachReadTools,
    ...accountReadTools,
    ...workoutWriteTools,
    ...routineWriteTools,
    ...exerciseWriteTools,
    ...settingsWriteTools,
    ...mediaWriteTools,
    ...coachWriteTools,
    ...workoutDeleteTools,
    ...routineDeleteTools,
    ...exerciseDeleteTools,
    ...settingsDeleteTools,
    ...mediaDeleteTools,
    ...coachDeleteTools,
  ]
}
