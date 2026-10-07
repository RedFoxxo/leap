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
