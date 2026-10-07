# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal) and is reported to
MCP clients in the server handshake.

## Unreleased

- Project scaffold: stdio MCP server, HTTP layer with Bearer auth and token
  redaction, `leap pair` to trade an openGym pairing code for a token.
- `read_me` and `read_instance`.
- State layer: every write is a read-modify-write against the revision it
  read, redone on the newer document when another device wrote first, never
  applied twice when a response is lost, backed up beforehand and read back
  afterwards. Unknown keys are kept; the unit and openGym's own bookkeeping are
  never changed by accident.
- Exercise catalogue: the 1,324 built-in exercises (names, muscles, English
  instructions) from the MIT exercise dataset openGym uses, downloaded once
  from a pinned commit, hash-checked and cached; plus the profile's custom
  exercises. `read_exercises` and `read_exercise`.
- Training reads: `read_workouts`, `read_workout` (every set kind: warm-ups,
  drop sets, rest-pause, per-side, timed, cardio), `read_routines`,
  `read_routine`, `read_week_plan` (date overrides win over the weekday) and
  `read_bodyweight` (goal, 7- and 30-day change).
- `read_profile` (overview, today and the next training day), `read_settings`
  and `read_document`, the raw escape hatch for any part of the profile.
- Stats: `read_exercise_history` (sessions with records), `read_records`,
  `read_training_summary` (per week, month or day) and `read_muscle_balance`.
  Estimated 1RM by Epley (default), Brzycki or Lombardi, with openGym's rules.
- First writes: `write_bodyweight` and `delete_bodyweight`, `write_goal_weight`,
  `write_settings`, `write_exercise_note`, `write_favourite`, and
  `write_document` for settings no dedicated tool covers. Every write reports
  the new revision, conflicts it redid, and anything that did not persist.
- Routines and the plan: `write_routine` (create or change, with rep ranges,
  supersets, timed and cardio work, warm-ups, progression and intensifiers),
  `write_copy_routine`, `delete_routine` (also taken off the plan, as in the
  app), `write_week_plan` and `write_day_plan`.
- Workouts: `write_log_workout` (every set kind; today or back-dated),
  `write_update_workout` and `delete_workout`. Volume, best weights, PR badges
  and the remembered working weight follow the app's rules; checked with
  openGym's own code on workouts leap wrote.
- Custom exercises: `write_custom_exercise` (muscles in the app's body-map
  names, link, assistance flag) and `delete_custom_exercise` (taken out of
  routines, favourites and remembered weights; history keeps its name).
  Muscle balance counts custom exercises with the built-in ones.
- Photos and videos: `write_attach_media` uploads a local file to a workout
  or custom exercise, after removing location, camera and time metadata from
  photos (the orientation stays); videos that record a location are refused.
  `read_media` downloads to a new file, `read_media_usage` shows space and
  limits, `delete_media` detaches, `delete_media_sweep` frees space at once.
- AI Coach: `write_coach_request` (a plan, a review or a debrief; waits for
  the answer), `read_coach` (the waiting proposal with names and how to apply
  it with leap's tools), `write_coach_resolve`, `read_coach_cohort`,
  `write_coach_share` and `delete_coach_data`. leap never gives consent; that
  stays in the app.
- Account: `read_account`, `write_passkey_name`, `write_pairing_code` (pair the
  phone app or another computer) and `delete_all_sessions`. Changing the
  password or sign-in e-mail and removing passkeys stay in the app, so no
  password passes through an AI conversation.
- Admin (admin profiles only): users (`admin_users`, `admin_user`,
  `admin_disable_user`, `admin_delete_user` with a name check,
  `admin_password_reset`), invites, the activity log, and the AI Coach
  settings.
- Fixed: assistance machines (where less weight is better) are now recognised
  as openGym recognises them, a leverage machine named "assisted" or a custom
  exercise marked so; before, 15 exercises with the dataset's "assisted"
  equipment were treated that way by mistake.
