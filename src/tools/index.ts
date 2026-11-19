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
import type { ToolDef, Toolset } from './types.js'
import { workoutDeleteTools, workoutWriteTools } from './workouts/write.js'

export type AnyToolDef = ToolDef<any>

/** The tools of each toolset (`LEAP_TOOLSETS`); every tool is in exactly one. */
export const TOOLSET_TOOLS: Record<Toolset, readonly string[]> = {
  training: ['read_profile', 'read_workouts', 'read_workout', 'write_log_workout', 'write_update_workout', 'delete_workout'],
  routines: [
    'read_routines', 'read_routine', 'read_week_plan', 'write_routine', 'write_copy_routine', 'write_week_plan', 'write_day_plan',
    'write_rotation', 'write_schedule_mode', 'write_rotation_round', 'write_session_queue', 'write_day_note', 'delete_routine',
  ],
  body: ['read_bodyweight', 'read_measurements', 'write_bodyweight', 'write_goal_weight', 'write_measurement', 'delete_bodyweight', 'delete_measurement'],
  stats: ['read_exercise_history', 'read_records', 'read_training_summary', 'read_muscle_balance'],
  exercises: ['read_exercises', 'read_exercise', 'write_custom_exercise', 'write_exercise_note', 'write_favourite', 'write_dumbbell_load', 'delete_custom_exercise'],
  settings: ['read_settings', 'read_document', 'write_settings', 'write_dumbbell_rack', 'write_document'],
  media: ['read_media_usage', 'write_attach_media', 'write_download_media', 'delete_media', 'delete_media_sweep'],
  coach: ['read_coach', 'read_coach_cohort', 'write_coach_request', 'write_coach_resolve', 'write_coach_share', 'delete_coach_data'],
  account: ['read_me', 'read_instance', 'read_account', 'write_passkey_name', 'write_pairing_code', 'delete_all_sessions'],
  admin: [
    'admin_users', 'admin_user', 'admin_disable_user', 'admin_delete_user', 'admin_password_reset', 'admin_invites', 'admin_create_invite',
    'admin_revoke_invite', 'admin_audit', 'admin_clear_audit', 'admin_coach', 'admin_coach_config', 'admin_coach_test', 'admin_coach_models',
    'admin_coach_disconnect',
  ],
}

/** The tools of the given toolsets, in registration order. */
export function toolsFor(toolsets: readonly Toolset[]): AnyToolDef[] {
  const names = new Set(toolsets.flatMap((t) => TOOLSET_TOOLS[t]))
  return allTools().filter((tool) => names.has(tool.name))
}

/** Every tool leap can register, in registration order. */
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
