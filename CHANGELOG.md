# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal) and is reported to
MCP clients in the server handshake.

## 1.1.0 — 2026-10-09

Works with openGym 1.4.0 or later (tested with 1.4.0). **Needs openGym 1.4.0**:
leap refuses to write to an older server; use leap 1.0.0 with openGym 1.3.9.

- **Licence**: leap is now AGPL-3.0-or-later, like openGym (1.0.0 stays MIT).
  See NOTICE.md.
- **Sync**: writes as an up-to-date openGym client (`stamped: true`): every
  changed setting, plan day, routine field and deletion is stamped as the app
  stamps it, so devices merge leap's changes field by field and removals stick.
  Sends the server's write id, and says plainly when the server cannot read the
  stored profile. Fixes edits of routines, workouts and custom exercises that
  were reported as not saved on openGym 1.3.10 and later. Checked against
  openGym's own stamping code.
- **Compatibility**: `read_instance` says which openGym the server runs as far
  as leap can tell and whether leap can write to it.
- **Exercise catalogue**: openGym's 5,632 exercises ship with leap (text only;
  nothing is downloaded any more). Alias ids are stored as the exercise they
  draw; 5-digit ids work. `read_exercises` matches like the app: gym shorthand,
  plurals, run-together names, small typos, target/equipment/body part, best
  matches first, and a category filter. Custom exercises take the new body
  part and equipment.
- **Rotation and session queue**: `read_week_plan` and `read_profile` follow
  the rotation (rounds, pins, what planned each day); new `write_rotation`,
  `write_schedule_mode`, `write_rotation_round`, `write_session_queue`
  (planner) and `write_day_note` (missed-day notes). Logging the workout that
  completes a round starts the next one, as the app does.
- **Training**: triple progression, max sets, last set to failure, back-off
  sets, pyramids (reps, rest and weight per set), what a dumbbell weight means,
  superset names and rest; sets to failure, Max sets, treadmill incline and
  timed holds per side; set fields leap does not manage are kept.
- **Stats**: the seven 1RM formulas and the weighted blend, following the
  profile's choice; volume counts both bells of a per-dumbbell entry; history
  and records read dumbbell weights in the exercise's current meaning.
- **New data**: body measurements (`read_measurements`, `write_measurement`,
  `delete_measurement`), the dumbbell rack (`write_dumbbell_rack`) and what a
  dumbbell weight means per exercise (`write_dumbbell_load`); the new settings
  (focus view, 1RM formula, own accent colour, rest sound, nudge and its tone,
  Bengali and Traditional Chinese, …) in `write_settings`.
- **Coach and admin**: the Coach's "not set up" code; admin Coach output limit
  and routing headers.
- **Output fields renamed** for one vocabulary across tools: a round is
  `round` everywhere (`read_week_plan`, `read_profile`, `write_log_workout`;
  the saved loop in `read_week_plan` is `rotation`); `read_profile`'s today
  lists `routines` and `workouts`; `read_bodyweight` says `goalWeight`; a
  dumbbell meaning is `weightMeans` with `each`/`total` (history and records
  too); an unchanged write's text is `message`.
- **Round trips**: what `read_workout` and `read_routine` return can be written
  back unchanged: per-side drop sets and rest-pause, dumbbell meanings, values
  the app stores and workouts from before ids (`YYYY-MM-DD|start`) are kept.
- **Fixes**: `write_schedule_mode` no longer restarts a running round or takes
  over a planner's queue; editing a custom exercise stored without primary
  muscles no longer wipes its muscles; `admin_user` lists the newest workouts;
  `write_document` refuses keys `write_settings` checks; `admin_coach_config`
  needs `confirm` before a filed key is sent to another host; a write whose
  answer was lost or garbled is not repeated or reported as failed; workouts
  that end in the future are refused; best weight and warm-ups follow the app.
- Workout times and "today" come from the wall clock, stamps from the stamp
  clock, and are read in the user's time zone (the one the app files with the
  reminder, as openGym's server does), else the machine's: leap in a UTC
  container no longer shifts days and times.
- `write_routine` can add an exercise to a stored superset by naming only that
  exercise.
- Verified end to end against a live openGym server (API 1.4.0).

## 1.0.0 — 2026-10-07

Works with openGym 1.3.9.

First release.

- 64 tools in four permission tiers (`read_`, `write_`, `delete_`, `admin_`):
  21 read, 20 write, 8 delete and 15 admin.
- Full coverage of what the openGym API offers a signed-in profile: workouts,
  routines and the week plan, body weight, settings, custom exercises, stats
  and records, photos and videos, the AI Coach, the account and, for admin
  profiles, administration.
- Writes follow the app's own rules: volume, best weights, PR badges, the
  remembered working weight, combined days and deloads, and the routine
  editor's defaults and checks. Routines and workouts are read in the format
  the write tools take back, and fields a write does not mention are kept.
- Every write is a read-modify-write against the revision it read: redone when
  another device wrote first, never applied twice, backed up beforehand, read
  back afterwards, and skipped when nothing changes. Checked against openGym's
  own sync merge.
- The 1,324 built-in exercises come from the MIT exercise dataset openGym
  uses, downloaded once from a pinned commit, hash-checked and cached.
- Photos are uploaded without location, camera and time metadata (the
  orientation stays); videos that record a location are refused. The media
  parsers are hardened against crafted files.
- `leap pair` trades an openGym pairing code for a token; no password passes
  through an AI conversation.
- Verified end to end against a live openGym server (API 1.3.9).
- Setup instructions for opencode.
