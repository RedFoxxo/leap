# openGym: what leap relies on

How openGym stores a profile and syncs it, as far as leap depends on it. Written
in our own words from reading openGym's source; no openGym code is copied (see
"Licensing rule" in `CLAUDE.md`).

Researched at openGym commit `31c6795b` (2026-10-06, API 1.3.9). Paths below are
relative to the openGym repository at that commit. Re-check them when openGym
releases a version that touches sync, the state shape or `api/server.js`.

Evidence key: **source** = read in openGym's code; **live** = verified against
the API image in `scripts/test-server.mjs`.

## The profile document

- One JSON document per profile, `GET /api/data` → `{ state, rev }`. `state` is
  `null` before the first sync. (**source**: `api/server.js`, `GET /api/data`)
- `PUT /api/data { state, baseRev }` **replaces the whole document**. A key
  missing from `state` is gone afterwards. (**source**: `api/server.js` ~2005-2073)
- With `baseRev` the write is conditional: a stale `baseRev` answers
  `409 { error: "conflict", rev, state }` with the current document.
- The server refuses (400) a `state` that is an array, has nothing but `_rev` /
  `_ts`, or has `workouts` / `routines` that are not arrays or null. Non-object
  entries inside those two arrays are silently dropped.
- The server strips `active` (the in-progress workout, device-local), sets
  `_rev = previous + 1`, and never lets `resetAt` / `resetIds` move backwards.
- The body limit is 5 MiB (413 above it).
- No rate limit on `/api/data`, `/api/data/rev`, `/api/me` or pairing.

### Defaults

The app overlays the stored document on its defaults (`DEF` in
`frontend/src/store/useStore.js` ~74-180). A key that is absent takes the
default; a key that is present wins **even when it is `null`**. Never write
`null` where the default is an array or object: readers crash on it.

Main keys (default in brackets):

| Key | Meaning |
|---|---|
| `unit` (`kg`) | `kg` or `lb`. **Every stored weight is in this unit**; nothing is normalised |
| `unitSet` | Stamp of the last unit switch; preserve as is |
| `workouts` (`[]`) | Logged workouts, sorted by day `d`, then `start` |
| `routines` (`[]`) | Workout templates |
| `week` (`{}`) | Weekday `0`(Sunday)…`6` → **array** of routine ids (a bare string is still read) |
| `dayPlan` (`{}`) | ISO date → routine id or `"rest"`; wins over `week` |
| `bodyweight` (`[]`) | Weigh-ins `{ d, w, t }`, **one per day**, sorted by day |
| `targetW` (`null`) | Goal body weight, in `unit` |
| `customEx` (`[]`) | User-made exercises |
| `exWeights` (`{}`) | Exercise id → `{ w, d }`: best/last working weight memory |
| `exNotes` (`{}`) | Exercise id → standing note |
| `favEx` (`[]`) | Favourite exercise ids |
| `equipProfiles` (`[]`), `activeEquipId`, `equipFilterOn` | Equipment profiles |
| `reminder` (`{ on: false, time: "08:00", tz: null }`) | Daily push; the server reads it |
| `restSec` (90), `restPauseSec` (15), `effort` (`null` = none/legacy, `rir`, `rpe`) | Workout settings |
| `weekStart` (1), `startFrom` (`plan`), `logRef` (`last`), `workoutView` (`cards`), `wdec` (1), `speedUnit` (`null`) | Display and session settings |
| `lang`, `theme`, `accent`, `body`, `sound`, `keepAwake`, ... | Plain settings |
| `barWeights`, `plates`, `loadKind`, `gymCards`, `balanceTemplate`, `balanceOverrides`, ... | Equipment and feature data |
| `coach` | Coach consent and state; preserve as is |
| `resetAt`, `resetIds` | "Reset everything" stamp; preserve as is |

leap must keep every key it does not know, unchanged.

## Sync between devices

(**source**: `frontend/src/lib/sync-merge.js` header and `mergeStates`;
`frontend/src/store/useStore.js`)

- The app polls `GET /api/data/rev` every 30 s while open and on focus/resume,
  and pushes about 1.5 s after a local change, always with `baseRev`.
- When the revision changed and the device has **no unsent change**, it adopts
  the server document as it is. A leap write then simply shows up.
- When the device **has** unsent changes it merges the two copies:
  - Top-level `_ts` decides scalars and settings, `week`, `dayPlan`, `reminder`:
    the copy with the newer `_ts` wins.
  - `workouts`, `routines`, `customEx`: union by `id`; for an id both copies
    have, the version with the newer per-entry `_ts` wins (the newer copy's on
    a tie).
  - `bodyweight`: union by day; for a day both have, the newer `t` wins.
  - `exWeights`: per exercise, the better weight.
  - `favEx`: set union. `exNotes`, `barWeights`: key union.
- **There are no tombstones.** An entry deleted on one device while another
  device holds unsent changes comes back on that device's merge. openGym
  documents this as a known limit. leap's delete tools say so and verify.

**Verified** (2026-10-07) by running openGym's own `mergeStates` over
documents leap wrote, against a phone copy holding an unsynced change made
before and after leap's write: logged and edited workouts, routines, custom
exercises, weigh-ins and exercise notes survive in both cases, and PR badges
stay consistent. Settings, the week plan and date overrides survive only when
the phone's change was made before leap's write; made after, the phone's copy
is newer and its values win as a whole (the same happens between two app
devices). Deleted workouts come back in both cases (no tombstones). The
affected tools say so in their descriptions.

What leap does on every write:

1. Read the document and its `rev`.
2. Change only what was asked, on a copy, keeping every other key and field.
3. Set the top-level `_ts` to `max(now, previous _ts + 1)`.
4. Stamp the changed entry: `_ts = now` on a workout, routine or custom
   exercise; `t = now` on a weigh-in.
5. `PUT` with `baseRev`. On 409, redo step 2 on the document the 409 returned.
6. Read back and report anything that did not persist.

## Ids

The app makes ids as base-36 milliseconds followed by 5 random base-36
characters (`frontend/src/lib/format.js`, `uid`). Custom exercises are prefixed
`c`. Any unique string works; leap uses the same format so its entries look
like the app's.

## Workouts

(**source**: `frontend/src/lib/workout-model.js`, `history.js`,
`import-csv.js`, `views/sheets.jsx` finish flow)

A logged workout:

| Field | Meaning |
|---|---|
| `id` | Unique id |
| `d` | Local calendar day `YYYY-MM-DD` (no time zone stored) |
| `start`, `end` | ms since epoch |
| `name` | Usually the routine's name |
| `routineId` | Routine it came from, or `null` |
| `entries` | `[{ id: exerciseId, sets: [...], topW }]` |
| `vol` | Total volume; **must be present** (the list shows it raw) |
| `prs` | Exercise ids that set a weight PR in this workout |
| `bw` | Body weight that day (optional) |
| `note`, `media` | Optional; `media` is a list of media refs (max 6) |
| `_ts` | Set when edited after logging |

Set rows (`sets[]`):

- Normal: `{ w, r, done }`, optional `rir` or `rpe`.
- Warm-up: `phase: "warmup"`. Excluded from volume, PRs and muscle balance.
- Drop set: `type: "dropset"` with `drops: [{ w, r }]`; drops add to volume.
- Rest-pause: `type: "restpause"` with `clusters: [{ r, restSec }]`; `r` is the
  total reps, clusters add nothing extra.
- Per side: `sides: { L, R }`, with the row's own fields mirroring them.
- Timed: `{ sec, w }`. Cardio: `{ min, speed }`, speed always in km/h.
- No "failure" type (that is RIR 0) and no "assisted" set type (assistance is a
  property of the exercise; its weight improves downwards).

Derived when a workout is finished:

- `vol`: sum of `w × r` over done, non-warm-up rows, plus their drops.
- `topW` per entry: best completed working weight.
- `prs`: exercises whose best weight beats every earlier workout's best.
- `exWeights[id]`: updated when the new weight is better (not for back-dated
  entries).

`workouts` must stay sorted by `d`, then `start`: "last time" reads from the end.

A workout from a combined day carries `routineIds` (all of them; `routineId`
is the first) and a `rid` on each entry; an entry without `rid` in a workout
where others have one belongs to no routine. A finished entry may also carry
`target` (what was prescribed), `planned`, `sg` (superset), `note`, `notePin`
and `noProg` (excluded from progression). (**source**: `lib/finish-workout.js`,
`history.js` `entryRoutineId`)

Volume per row (**source**: `workout-model.js` `completedVolumeOf`,
`history.js` `workoutVolume`): a per-side row counts each completed side at its
own `w × r` (its scalar `w`/`r` only mirror the sides: max weight, summed
reps, done when both are); a drop set adds its drops; a rest-pause row's `r`
already includes its bursts. **Verified**: leap's implementation reproduces
the stored `vol` of all 33 workouts and the `topW` of all 187 entries in
openGym's demo profile (`lib/demoSeed.js`).

## Routines

`{ id, name, emoji, ex: [...], prog?, excludeFromProgression?, _ts }`.

Exercise items: `{ id, sets }` plus optional `reps`, `repsMin`, `repsMax`,
`weight`, `sec`, `min`, `speed`, `mode`, `bodyweight`, `side`, `assisted`,
`prog`, `inc`, `deloadFactor`, `restSec`, `warmupRestSec`, `warmupSets`, `sg`
(superset group id), `note`, `intensifier`. (**source**: `views/sheets.jsx`
routine editor, `lib/plan-share.js`)

How the app's editor writes them (**source**: `sheets.jsx` ~1430-1450,
`lib/history.js` `defaultConfig`, `lib/rep-range.js`, `lib/progression.js`):

- A new exercise: reps `{ sets: 3, reps: 10, weight: 0, mode: "reps" }`, timed
  `{ sets: 3, sec: 45, weight: 0, mode: "time" }`, cardio `{ sets: 1, min: 20,
  speed: 8 }`; body-weight equipment adds `bodyweight: true`. Cardio is decided
  by the exercise (body part `cardio`), not chosen.
- `reps` is always there in reps mode; readers assume it (a missing one shows
  "3 × undefined" and makes every session a miss, so progression deloads).
- Double progression stores its range as `repsMin` (bottom, default reps − 2)
  to `reps` (top). `repsMax` is something else: for body-weight work without
  added weight, the reps at which a set is added; never below `reps`.
- Per side, `reps` is the total of both sides and is kept even.
- Policies: reps `off|linear|greyskull|double` (default linear), timed
  `off|time`, cardio `off`; at routine level the first four. `deloadFactor`
  at most 0.95 (default 0.9).
- A routine with `excludeFromProgression` gives each session entry
  `noProg: true` (deload weeks).
- Routines are stamped (`_ts`) when changed; an unchanged save is not stamped.

## Custom exercises

`{ id: "c…", n: name, bp: body part, eq: equipment, tg: target, primaries,
secondaries, sm, muscleGroups, desc, custom: true, media?, url?, _ts }`.

Custom exercises store muscles in the app's body-map vocabulary (`trapezius`,
`deltoids`, `chest`, `upper-back`, `serratus`, `biceps`, `triceps`, `forearm`,
`abs`, `obliques`, `lower-back`, `gluteal`, `quadriceps`, `hamstring`,
`adductors`, `hip-flexors`, `calves`, `tibialis`), in that order; a cardio
exercise's only primary is `cardiovascular system`. `tg` is one of the
primaries, `sm` mirrors `secondaries`, `muscleGroups` is both lists. Names are
unique among all exercises (case-insensitive). (**source**: `sheets.jsx`
`CustomExForm`, `lib/muscles.js`)

Deleting one (**source**: `sheets.jsx` `deleteCustomEx`): every logged entry
of it gets `n` (its name) and, if it has none, a `muscleSnapshot`; it is
removed from `customEx`, from every routine (superset ids left without a
neighbour are dropped), from `exWeights` and `favEx`. The app's snapshot also
holds `muscleWeights` derived by its muscle map; leap writes `n`, `bp`,
`primaries`, `secondaries`, `muscleGroups` only.

## Built-in exercise catalogue

1,324 exercises in `frontend/src/lib/exercises-data.js`, ids are 4-digit
strings (`"0001"`), with name `n`, body part `bp`, equipment `eq`, target `tg`,
secondary muscles `sm` and instructions. No API serves it.

Licensing (`NOTICE.md`): the English metadata comes from
`hasaneyldrm/exercises-dataset` under MIT (originally ExerciseDB). openGym's
translations are AGPL. The images and GIFs are third-party content licensed to
nobody downstream. leap does **not** bundle any of it; names are looked up from
the upstream MIT dataset at runtime.

The upstream dataset (`data/exercises.json`, pinned at commit `7455efae`,
SHA-256 `65663422…`) has the same 1,324 ids as openGym's catalogue, with the
same names except four where upstream mis-encodes "°" as "в°" (`0738`, `0739`,
`0740`, `1464`), and the same targets (**verified** by comparing both files).
Its fields: `name`, `body_part`, `equipment`, `target`, `muscle_group`,
`secondary_muscles`, `instruction_steps` per language. openGym's own muscle
mapping for Stats (`exercise-muscle-*.json`) is AGPL and not used by leap, so
leap's muscle figures are based on `target` and `secondary_muscles` and can
differ from the app's.

## Stats

(**source**: `frontend/src/lib/onerm.js`, `muscles.js`, `progression.js`)

- Estimated 1RM: Epley `w × (1 + r/30)` by default; Brzycki `w × 36/(37 − r)`;
  Lombardi `w × r^0.1`. One rep is the weight itself; above 12 reps there is no
  estimate; rounded to 0.1.
- The best set for the estimate: completed, non-warm-up rows in reps mode,
  each done side of a per-side row on its own; none for assistance machines.
  (**source**: `onerm.js` `bestSetOf`)
- Weight PR (`prs`): the session's best completed working load beats the best
  of every earlier session; with no earlier load, the first one counts. On an
  assistance machine (equipment `assisted`) the smaller load is better.
  (**source**: `exercises.js` `beatsWeight`, `sheets.jsx` finish flow,
  `workout-date.js` `rebuildPrHistory`). **Verified**: leap marks the same PRs
  as openGym on 30 of the demo profile's 33 workouts; the 3 others are its
  first week, where the demo generator deliberately stores no badges.
- Assistance machine (**source**: `exercises.js` `isAssisted`): an explicit
  `assisted` boolean on a custom exercise wins; otherwise equipment
  `leverage machine` and a name matching `assist(ed)` — 8 catalogue exercises.
  The dataset's equipment `assisted` (15 exercises: partner-assisted stretches
  and the like) is ordinary load. **Verified** against the catalogue.
- After logging into the past or editing a workout, the app rebuilds badges of
  the touched exercises: walking history in order, a session keeps a badge only
  while it leads every earlier one, and only the logged/edited session can gain
  one (`workout-date.js` `rebuildPrHistory`). The remembered weight
  (`exWeights`) is raised only by a session finished today, and lowered only
  when an edit or delete took away the load it came from
  (`session-edit.js` `lowerKeptWeights`). Deleting from the workout detail
  rebuilds nothing.
- **Verified** (2026-10-07): workouts logged and edited by leap on the test
  server, checked with openGym's own `workoutVolume`, `bestWeightForEntry` and
  `rebuildPrHistory`: every volume and best weight matches, and openGym's
  rebuild leaves every badge leap wrote unchanged.
- Muscle balance: done, non-warm-up sets per muscle; primary muscles count 1,
  secondary 0.4.

## Media

(**source**: `api/media.js`, `frontend/src/lib/media-refs.js`)

- Upload: `PUT /api/media/<sha256 hex of the exact bytes>` with one of the
  accepted content types. The server sniffs the real type and refuses a hash
  that does not match. 600 uploads per hour per profile.
- Then reference it from the state: `workouts[].media[]` or `customEx[].media`,
  with `size` equal to the byte count. A `poster` (still image, at most 480 px)
  is what lists show.
- Files no longer referenced are deleted after a 14-day grace period.
- A ref (**source**: `lib/media-refs.js` `normalizeMediaRef`) is `{ kind, hash,
  mime, size, width, height, dur?, codec?, poster?, at }`; `kind` must match the
  mime (`image/gif` is always `gif`), size 1 B–200 MB, sides 1–16384 px,
  `dur` 0–3600 s, `codec` one of `avc1 hvc1 av01 vp09 vp8 vp9 other`. The
  poster is optional. Anything else reads as "no media".
- A workout keeps at most 6 (`WORKOUT_MEDIA_MAX`), no hash twice; adding or
  removing one stamps the workout's `_ts` (`lib/workout-media.js`). A custom
  exercise has one `media`.
- Size caps per kind come from `GET /api/config` → `media` (MB of 2^20; images
  2 MB by default). The app re-encodes photos to fit and removes metadata; the
  server never alters a file. leap cannot re-encode: it removes metadata from
  stills without touching pixels (keeping the orientation as a minimal EXIF
  block in JPEG and WebP, and dropping whatever follows a JPEG's end-of-image
  marker), refuses videos with location data it recognises (`©xyz`, `loci`,
  Apple location keys, EXIF/XMP GPS tags in metadata boxes, `gpmd`/`camm`
  telemetry tracks), and reports
  files over the cap. **Verified**: stripped fixtures decode to identical
  pixels (Pillow, EXIF rotation applied); the real API accepted stripped JPEG,
  GIF and an MP4.

## Coach

`POST /api/coach/plan|review|debrief` answers 202 with a job; the outcome comes
through `GET /api/coach/status` (the app polls every 3 s). A proposal is applied
by the client editing the state, then `POST /api/coach/pending/resolve`.
(**source**: `api/coach/jobs.js`, `views/CoachChat.jsx`)

- Consent is `state.coach.consent = { agreedAt: ISO, version }`, written by the
  app's consent screen and checked by the server on every job (403 `consent`).
  leap never writes it: `coach` is in the store's protected keys.
- Proposal kinds: `review` (a `changes` list, each `{ id, type, target:
  { routineId, exId }, before, after, why }`), `create` (a plan `bundle` with
  `routines`, `week`, `customEx`), `debrief` (`score`, `highlights`, `watch`,
  `nextTime` about one `workout`). Proposals expire after 14 days.
- Resolve bodies, as the app sends them: a review `{ accepted: [change ids],
  rejected: [...] }`, a plan `{ accepted: ["plan"] }`, a debrief
  `{ accepted: ["debrief"] }`, or `{ dismissed: true }`. The status's `last`
  then reads `applied` or `dismissed`.
- leap applies accepted changes with its own write tools (decided with the
  user, 2026-10-07) instead of re-implementing the app's apply code. It does
  not write the app's Coach log or snapshots in `state.coach` (the app uses
  them to show history and revert).
- Test setup: `POST /api/admin/coach/config { enabled: true, provider:
  "fixture" }` turns on the built-in fixture provider, which answers every job
  kind deterministically. **Verified** live: review → change applied with
  `write_routine` → resolved → `last.outcome` `applied`.
