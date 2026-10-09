# openGym: what leap relies on

How openGym stores a profile and syncs it, as far as leap depends on it, from
reading openGym's source. Where leap ports openGym logic, the code names the
source file and commit (see "Licensing rule" in `CLAUDE.md`).

Researched at openGym commit `31c6795b` (2026-10-06, API 1.3.9) and brought up
to **v1.4.0** (`28b7e4dc`, 2026-10-09). Paths below are relative to the openGym
repository at v1.4.0 unless a section says otherwise. Re-check them when openGym
releases a version that touches sync, the state shape or `api/server.js`.

Evidence key: **source** = read in openGym's code; **live** = verified against
the API image in `scripts/test-server.mjs`.

## The profile document

- One JSON document per profile, `GET /api/data` → `{ state, rev }`. `state` is
  `null` before the first sync. (**source**: `api/server.js`, `GET /api/data`)
- `PUT /api/data { state, baseRev, baseWid?, stamped? }` replaces the document.
  For a **stamping** writer (`stamped: true`, the app and leap) a key missing from
  `state` is gone afterwards; for a writer that does not stamp, the server puts
  back every key and entry field it left out (except a short list v1.3.9 itself
  drops) and stamps the change at server time (`api/sync-stamps.js` stampPut,
  `api/server.js` ~2195-2291).
- With `baseRev` the write is conditional: a stale `baseRev`, or a `baseWid`
  that is not the stored document's `_wid` (a restored backup that reached the
  same revision), answers `409 { error: "conflict", rev, state }`.
- The answer is `{ ok, ts, rev, wid }`; `GET /api/data/rev` gives `{ rev, wid }`.
  A stored file that cannot be read answers `503 { error: "state unreadable" }`
  to GET and PUT (nothing written). `GET /api/health` carries `writable` from
  1.4.0 on, and answers 503 `{ ok: false, writable: false }` when the data folder
  cannot be written: leap tells openGym 1.4.0 from older servers by that field.
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
| `reminder` (`{ on: false, time: "08:00", tz: null }`) | Daily push; the server reads it. `tz` is the phone's zone (kept up to date while the reminder is on); the server also takes it as the user's day (`server.js` userNow, `queue.js` dayIn) |
| `restSec` (90), `restPauseSec` (15), `effort` (`null` = none/legacy, `rir`, `rpe`) | Workout settings |
| `weekStart` (1), `startFrom` (`plan`), `logRef` (`last`), `workoutView` (`cards`), `wdec` (1), `speedUnit` (`null`) | Display and session settings |
| `lang`, `theme`, `accent`, `body`, `sound`, `keepAwake`, ... | Plain settings |
| `barWeights`, `plates`, `loadKind`, `gymCards`, `balanceTemplate`, `balanceOverrides`, ... | Equipment and feature data |
| `coach` | Coach consent and state; preserve as is |
| `resetAt`, `resetIds` | "Reset everything" stamp; preserve as is |
| `edited`, `deleted`, `undone`, `_wid`, `_wids` | Sync records (see below); `_unstamped`/`_prior` are server-only and never sent |
| `queue` (`null`), `rotation` (`null`), `scheduleMode` (`null`) | The live round, the saved rotation, the plan mode (see "Rotation and the session queue") |
| `dayNotes` (`{}`) | ISO date → `{ tag?, text?, _ts }`: missed-day notes |
| `measurements` (`[]`), `measurementEnabled` (`null`), `customMeasurements` (`[]`) | Body measurements |
| `dbLoad` (`{}`), `dumbbells` (`{}`) | What a dumbbell weight means per exercise; the owned dumbbells per unit |
| `oneRmFormula` | `epley` (default), `brzycki`, `lombardi`, `oconner`, `mayhew`, `wathan`, `lander`, `weighted` |
| `reminder.nudge` (false), `reminder.tone` (`friendly`) | Missed-workout nudge and its tone (`friendly`, `guilt`, `drill`) |

leap must keep every key it does not know, unchanged.

## Sync between devices

(**source**: `frontend/src/lib/sync-merge.js`, `api/sync-stamps.js`,
`frontend/src/store/useStore.js`; the sync rework landed in v1.3.10)

- The app polls `GET /api/data/rev` every 30 s while open and on focus/resume,
  compares `rev` and `wid`, and pushes about 1.5 s after a local change with
  `{ state, stamped: true, baseRev, baseWid }`.
- It takes the server copy as it is when that copy descends from the one it last
  synced and it owes nothing; otherwise it merges the two copies by their stamps:
  - `edited`: per setting (`restSec`, `queue`, …) and per key of `week`,
    `dayPlan`, `exNotes`, `barWeights` (`"week.3"`, `"dayPlan.2026-10-08"`), plus
    `routineOrder`: the later stamp wins, a removal included.
  - `workouts`, `routines`, `customEx`, `equipProfiles`, `gymCards`: union by id;
    per field, the side with the later `_f[field]` wins; fields nobody stamped
    follow the entry with the later `_ts`.
  - `bodyweight`, `measurements`: union by day, the later `t` wins.
  - Stamped maps (`balanceOverrides`, `loadKind`, `plates`, `dbLoad`,
    `dumbbells`, `dayNotes`): per key, the entry with the later `_ts` wins; a
    cleared entry is a stamped entry, never a deleted key.
  - `deleted[list][key]`: a positive stamp removes the entry when it is at least
    the entry's own time; a negative one records it was added back; a star in
    `favEx` is always an add-back.
  - `exWeights`: per exercise, the better weight.
- How a change is stamped, in one time `now = max(clock, highest stamp + 1)`:
  ported to leap as `src/state/stamps.ts` (openGym `stampChange`).
  `scripts/check-parity.mjs` compares the port with openGym's own `stampChange`
  on randomised changes (no difference at v1.4.0).
- **Old devices**: a phone still on openGym 1.3.9 does not stamp. Its stale
  values can overwrite newer settings when it never read an updated copy, and
  its merge can bring back an entry deleted elsewhere. Only then can a leap
  change or delete be undone; the tools say so.

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
| `d` | Local calendar day `YYYY-MM-DD` (no time zone stored; leap takes the user's zone from `reminder.tz`, as the server does, else the machine's) |
| `start`, `end` | ms since epoch |
| `name` | Usually the routine's name |
| `routineId` | Routine it came from, or `null` |
| `entries` | `[{ id: exerciseId, sets: [...], topW }]` |
| `vol` | Total volume; **must be present** (the list shows it raw) |
| `prs` | Exercise ids that set a weight PR in this workout |
| `bw` | Body weight that day (optional) |
| `note`, `media` | Optional; `media` is a list of media refs (max 6) |
| `_ts` | When it was logged or last edited; leap stamps a new workout too |

Set rows (`sets[]`):

- Normal: `{ w, r, done }`, optional `rir` or `rpe`; `failure: true` (taken to
  failure, RIR 0 unless rated; never on a warm-up), `max: true` (a pyramid's Max set).
- Warm-up: `phase: "warmup"` (also read: `"warm-up"`, `"warm_up"`, and the older
  `warmup: true`). Excluded from volume, PRs and muscle balance.
- Drop set: `type: "dropset"` with `drops: [{ w, r }]`; drops add to volume.
- Rest-pause: `type: "restpause"` with `clusters: [{ r, restSec }]`; `r` is the
  total reps, clusters add nothing extra.
- Per side: `sides: { L, R }`, with the row's own fields mirroring them; a drop
  set or rest-pause lives on each side (`sides.L.type/drops/clusters`) and the
  row mirrors its `type` (`workout-model.js` syncSideAggregate).
- Timed: `{ sec, w }`; a hold per side is two rows `side: "L"` and `side: "R"`.
  Cardio: `{ min, speed, incline? }`, speed always in km/h, incline in % (0–40).
- No "assisted" set type (assistance is a property of the exercise; its weight
  improves downwards). Rows also carry app fields leap keeps as they are
  (`at`, `planSec`, `weightOrigin`, …).
- An entry's `target.dbLoad` (`each`/`total`) says what its weights meant; the
  app stamps it on sessions of a dumbbell exercise whose meaning is not "as
  entered" (`frontend/src/lib/dumbbells.js`, `session-start.js`).

Derived when a workout is finished:

- `vol`: sum of `w × r` over done, non-warm-up rows, plus their drops; an entry
  logged per dumbbell (`target.dbLoad: "each"`) on two-handed work counts twice
  (one bell when per side or named one-arm/single-arm).
- `topW` per entry: best completed working weight, reps rows first (a timed
  row's weight counts only when the entry has no reps rows), and the stored
  `topW` when no row has a usable weight (`history.js` bestWeightForEntry).
- `prs`: exercises whose best weight beats every earlier workout's best.
- `exWeights[id]`: updated when the new weight is better (not for back-dated
  entries).

`workouts` must stay sorted by `d`, then `start`: "last time" reads from the end.

What the app does when a session is saved, and leap with it (**source**:
`lib/session-merge.js`, `lib/session-start.js`, `lib/finish-workout.js`,
`lib/session-edit.js`, `sheets.jsx` finish and past-log flows):

- Every entry of a combined session carries `rid`, the routine it came from;
  without it the entry counts for `routineIds[0]`. `routineIds` has no
  duplicates.
- Entries from a routine with `excludeFromProgression` get `noProg: true`;
  when all do, the workout gets `excludeFromProgression: true`.
- Only exercises with a completed set are kept. The name is the routines'
  names joined ("A + B", from four on "A + B + N more"), else "Freestyle".
  `bw` is that session's weigh-in, if any. Notes are at most 500 characters.
  Past logs and moves never go beyond today.
- On a per-side set, drop sets and rest-pause live on each side.
- A workout saved before ids existed is known by `"<d>|<start>"`; an edit or a
  move freezes that key as its id (`workout-date.js`). A move keeps the time of
  day and the length (`retimeWorkout`). An edit is compared without `vol`,
  `prs` and stamps (`session-edit.js` sameData).
- An edit replaces the record by id, keeps the entry fields it does not edit,
  and is skipped (no stamp) when nothing changed.

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
(superset group id), `note`, `intensifier`, and from 1.4.0 `setsMax` (triple
progression), `lastToFailure`, `backoff`, `pyramid` (reps or `"max"` per set,
≤ 10), `pyramidRest`, `pyramidWeight`, `dbLoad` (`as`/`each`/`total`), `sgName`
and `sgRest` (on every member of a superset). (**source**: `views/sheets.jsx`
routine editor, `lib/plan-share.js`, `lib/pyramid.js`, `lib/backoff.js`,
`lib/superset-meta.js`)

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
- Policies: reps `off|linear|greyskull|double|triple` (default linear), timed
  `off|time`, cardio `off`; at routine level the reps ones. `deloadFactor`
  at most 0.95 (default 0.9). Triple progression: choosing it sets `setsMax` to
  `min(10, sets + 2)`; `setsMax` is stored only above `sets`.
- A pyramid sets `sets` to its length and `reps` to its first number, drops
  intensifier, back-off, last set to failure and `setsMax`, and is never
  progressed. `pyramidRest`/`pyramidWeight` are aligned to it and stored only
  when some value is above 0. Back-off sets fit reps exercises with weight, not
  assistance machines or rest-pause. `dbLoad` is stored only for dumbbell or
  kettlebell exercises and only when it differs from the exercise's default.
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

Since 1.4.0 openGym keeps its own catalogue in `catalogue/exercises/<id>.json`
(one file per exercise, English text) and builds the app's data from it
(`scripts/catalogue/build.mjs`). No API serves it. 5,632 exercises (ids of 4 or
5 digits) plus 922 alias ids (`{ id, variantOf }`, a female drawing of another
exercise; the app stores the main id). Fields: `name`, `bodyPart` (adds `full
body`), `equipment` (adds suspension trainer, sandbag, landmine, weight plate,
clubbell, macebell), `target`, `secondaryMuscles`, `category`, `description`,
`instructions`, `textSource`, optional `muscleMap`. The 1,324 entries marked
`textSource: "exercisedb"` kept their ids, names and muscles.

leap ships the text in `data/exercises.json` (generated by
`scripts/build-catalogue.mjs` from a release tag). Licensing (`NOTICE.md` in
both projects): the `exercisedb` entries' names, muscles and instructions are
MIT; everything else is openGym's AGPL. The pictures and animations are licensed
from Gym visual for openGym only and are never part of leap.

The app's library search matches every query word in the name and also in
target, equipment, body part and secondary muscles, with gym shorthand,
plurals, run-together names and typos for words nothing has literally
(`frontend/src/lib/exercises.js` searchExercises); leap's `src/catalog/search.ts`
does the same in its own words.

## Stats

(**source**: `frontend/src/lib/onerm.js`, `muscles.js`, `progression.js`)

- Estimated 1RM, by the profile's `oneRmFormula` (default Epley): Epley,
  Brzycki, Lombardi, O'Conner, Mayhew, Wathan, Lander, or `weighted`, a blend of
  the seven plus an RTS %1RM table that counts reps plus RIR, up to 15. One rep
  (without RIR) is the weight itself; a single formula gives nothing above 12
  reps and ignores RIR; rounded to 0.1. Ported as `src/domain/stats.ts`
  (`frontend/src/lib/onerm.js`), checked against openGym's own values.
- Dumbbell meanings: history, records and 1RM read an exercise's sessions in
  its current meaning (its `dbLoad` default, else the last stamped session's,
  else as entered), converting `each`↔`total` by the number of bells. `topW`,
  `exWeights` and the PR badges of past logs and edits (`rebuildPrHistory`) stay
  raw; a session finished today is judged against history read in its own
  meaning (`sheets.jsx` finish).
- The best set for the estimate: completed, non-warm-up rows in reps mode,
  each done side of a per-side row on its own; none for assistance machines.
  (**source**: `onerm.js` `bestSetOf`)
- Weight PR (`prs`): the session's best completed working load beats the best
  of every earlier session; with no earlier load, the first one counts. On an
  assistance machine (see below) the smaller load is better.
  (**source**: `exercises.js` `beatsWeight`, `sheets.jsx` finish flow,
  `workout-date.js` `rebuildPrHistory`). **Verified**: leap marks the same PRs
  as openGym on 30 of the demo profile's 33 workouts; the 3 others are its
  first week, where the demo generator deliberately stores no badges.
- Assistance machine (**source**: `exercises.js` `isAssisted`): an explicit
  `assisted` boolean on a custom exercise wins; otherwise equipment
  `leverage machine` and a name matching `assist(ed)` — 10 catalogue exercises
  at 1.4.0. The catalogue's equipment `assisted` (partner-assisted stretches
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

## Rotation and the session queue

(**source**: `frontend/src/lib/queue.js`, `rotation.js`, `history.js`
effectiveRoutineIds, `day-notes.js`; `api/queue.js`, `api/nudge.js`; v1.3.10 and
v1.4.0. Ported to leap as `src/domain/queue.ts`; `scripts/check-parity.mjs`
checks it against openGym's own functions on randomised cases.)

- `queue = { ids, since, startsOn, label, strict?, rotationId? }` is the live
  round; `rotation = { id, sequence, label }` the saved loop;
  `scheduleMode` holds the plan mode before a round exists. A usable queue
  always means rotation mode. The round is the app's when
  `queue.rotationId === rotation.id`; otherwise it is a planner's ("Externally
  managed"), which the app never refills or edits.
- A session is done when a workout on its routine started at or after `since`,
  or (unless `strict`) is dated on or after `startsOn` and named after the
  routine. A combined workout credits every routine in it.
- The queue answers only for `max(today, startsOn)`: the session pinned there
  (`dayPlan[date]` naming a round routine), else the first undone one not pinned
  elsewhere. A date's plan: `"rest"` override → rest; an override outside the
  round → that routine; otherwise the round's session first, the weekday's
  routines outside the round alongside.
- The app's finish of the workout that completes its own round starts the next
  round the day after, rotated after the last session that workout credited,
  and clears the old round's future pins. A phone that simply adopts the
  server's copy does not do this, so leap does it in `write_log_workout`.
- Deleting a routine leaves its id in the loop and the round; readers skip it.
- `dayNotes[date] = { tag?, text?, _ts }` (tags `sick`, `travel`, `rest`,
  `injured`, text ≤ 500, today or earlier): a noted day is skipped by the
  missed-workout nudge and the workout-day reminder.

## Body measurements

(**source**: `frontend/src/lib/measurements.js`, `views/Measurements.jsx`)

One entry per day `{ d, t, <19 built-in kinds>: cm | null, other: [{ id, name,
value }] }`; lengths always in cm (a lb profile sees inches), `bodyFat` in %
(≤ 100), values > 0 rounded to 0.1. `measurementEnabled` lists the built-in
kinds the form shows (null: all but abdomen, wrists, ankles and body fat);
`customMeasurements = [{ id, name (≤ 60), enabled }]`. Merged by day on `t`,
removals recorded in `deleted.measurements`.

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
