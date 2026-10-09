# CLAUDE.md

Guidance for working in this repository.

## What this is

**leap** is an MCP server for [openGym](https://github.com/DuarteSantos8/openGym),
a self-hosted gym and body-weight tracker. It runs on the user's machine (stdio)
and talks to their openGym instance **only through its HTTP API**, signed in
with the same Bearer token the phone app uses.

Goal: **full coverage.** Everything the API offers a signed-in profile is
reachable: training data (read, create, update, delete), computed stats, media,
the AI Coach, account settings and, for admin profiles, administration.

Status: 1.0.0 released 2026-10-07 (openGym 1.3.9); 1.1.0 in progress for
openGym 1.4.0. See "Status and remaining work" at the end.

Supported openGym versions live in `OPENGYM` in `src/version.ts`; the README's
compatibility table, the changelog, the test server image and the shipped
catalogue must agree with it (a test checks). Raising the minimum means
re-researching openGym (docs/OPENGYM.md), regenerating the catalogue and
running the live tests against the new image.

## Licensing rule

leap is AGPL-3.0-or-later, like openGym (from 1.1.0; 1.0.0 and earlier were
MIT). Porting openGym logic is allowed when matching its behaviour exactly
matters (sync stamps, volume, PRs): write it in TypeScript in leap's style, name
the openGym source file and commit next to it, and cover it with leap's own
tests. Record where every fact came from (file and commit) so it can be
re-checked when openGym changes. `NOTICE.md` lists what comes from openGym.

The exercise catalogue's text (ids, names, muscles, steps) is bundled, generated
from openGym's `catalogue/` by `scripts/build-catalogue.mjs`. **Never** include,
download, display or describe the exercise pictures and animations: they are
licensed from Gym visual for openGym only and are not covered by the AGPL.

## Stack

- TypeScript (strict), ESM, Node `>=22.12`
- `@modelcontextprotocol/sdk` with the stdio transport
- `zod` for tool input schemas
- `vitest` for tests
- No other runtime dependencies. Add a library only for a concrete need the
  standard library cannot meet, and ask first.

Versions are pinned exactly. Before every commit run `npm run typecheck`,
`npm test` and `npm run build`.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `OPENGYM_URL` | yes | Instance root, e.g. `https://gym.example.com` (no `/api/...`). https only, except localhost |
| `OPENGYM_TOKEN` | yes (not for `leap pair`) | Bearer token. **Redact it from every log line and tool output** |

That is the complete list. Fail at startup with a clear message if a required
variable is missing.

leap contacts no host but `OPENGYM_URL`. The exercise catalogue ships in
`data/exercises.json`; if it cannot be read, tools show ids instead of
built-in names and say so.

## Authentication

- openGym signs in with passkeys (WebAuthn), which an MCP server cannot do.
  The phone app instead redeems a one-shot pairing code (Settings → "Pair the
  mobile app", 8 characters, 5 minutes) at `POST /api/pair/redeem` for a signed
  session token, sent as `Authorization: Bearer <token>`. leap does the same:
  `leap pair [code]` prints the token on stdout (everything else on stderr).
- Tokens last `SESSION_DAYS` (default 90). Past half their lifetime,
  `GET /api/me` returns a renewed `token`; leap never shows it (bodies are
  redacted) and reports `tokenRenewalDue: true` from `read_me` instead.
- Bearer requests skip openGym's CSRF origin check.
- `POST /api/logout/all` revokes every token of the profile, leap's included.

## Architecture

```
src/
  index.ts             bootstrap: `leap` (MCP on stdio) and `leap pair`
  server.ts            tool registration; tier check and MCP annotations
  config.ts            env loading + validation
  compat.ts            which openGym the server runs (told from /api/health), whether leap may write
  pair.ts              pairing-code redemption
  log.ts, version.ts
  http/
    core.ts            the one request function: Bearer token, User-Agent, stderr log, Result
    result.ts          Result<T> = { ok: true, status, data } | { ok: false, status, message, code?, retryAfter?, body }
    redact.ts          token redaction (configured token and every "token" field in bodies)
  catalog/
    exercises.ts       built-in exercises (data/exercises.json, openGym's catalogue), alias ids,
                       custom exercises from the profile, ExerciseIndex (names, favourites, notes)
    search.ts          exercise search close to the app's (shorthand, plurals, typos, ranking)
  domain/
    sets.ts            how a logged set row is read: warm-ups, drop sets, rest-pause, per-side
                       rows, modes; volume, completed reps, best weight, entry routine
    plan.ts            weekday plan (list or legacy single id), what is planned on a date, routine lookup
    queue.ts           rotation and session queue: done rule, pins, rounds, refill, day notes
                       (ported from openGym queue.js / rotation.js)
    dumbbells.ts       what a dumbbell weight means (per bell / both), volume factor, conversion
    dates.ts           local calendar days (`YYYY-MM-DD`), weekdays
    routine-items.ts   routine exercise: stored format ↔ tool format, app defaults, policies
    workout-items.ts   logged set and entry: stored format ↔ tool format, session name
    workouts.ts        sorting, PR badge rebuild, remembered-weight raise/lower (the app's rules)
    stats.ts           1RM formulas (seven + weighted) and best set, PR rule (beatsWeight), exercise sessions,
                       muscle loads (dataset muscles, synonyms mapped to target names)
  media/
    inspect.ts         type sniffing and pixel size / duration / codec from file headers
                       (JPEG, PNG, GIF, WebP, MP4/MOV, WebM), video location detection
    strip.ts           metadata removal for stills (orientation kept), no re-encoding
    files.ts           reading local uploads (regular files of an accepted type only) and
                       saving downloads (new files only, never overwriting)
  state/
    types.ts           the loosely typed profile document, list/map accessors
    store.ts           load, and update(): the one write path (see "Writing the profile")
    stamps.ts          the app's sync stamps for a change (ported from openGym sync-merge.js)
    backup.ts          pre-write backups
    ids.ts             entry ids in the app's format
  tools/
    types.ts, context.ts, respond.ts, index.ts
    account/           read_me, read_instance; profile.ts: read_profile, read_settings,
                       read_document (raw escape hatch: any top-level key); write.ts:
                       read_account, write_passkey_name, write_pairing_code, delete_all_sessions
    admin/             admin_* (users, invites, activity log, Coach settings); admin profiles only
    exercises/         read_exercises, read_exercise, write_custom_exercise,
                       delete_custom_exercise (history keeps its name, as in the app)
    training/          read_workouts, read_workout, read_routines, read_routine,
                       read_week_plan, read_bodyweight; format.ts shapes workouts for output
    stats/             read_exercise_history, read_records, read_training_summary,
                       read_muscle_balance
    settings/          write_bodyweight, delete_bodyweight, write_goal_weight, write_settings
                       (known settings, validated; never the unit), write_exercise_note,
                       write_favourite, write_dumbbell_rack, write_dumbbell_load, write_document
                       (raw escape hatch, protected keys refused); measurements.ts:
                       read_measurements, write_measurement, delete_measurement
    workouts/          write_log_workout, write_update_workout (entries in read_workout's format,
                       matched by exercise id, what is left out is kept), delete_workout; volume,
                       topW, PR badges, exWeights, rid and noProg as the app sets them
    routines/          write_routine (items in read_routine's format; per exercise a field left
                       out is kept and null removes it; app defaults and checks), write_copy_routine,
                       delete_routine (also off weekdays and dates, as the app does),
                       write_week_plan, write_day_plan; rotation.ts: write_rotation,
                       write_schedule_mode, write_rotation_round, write_session_queue, write_day_note
    media/             read_media_usage, write_download_media, write_attach_media,
                       delete_media (detach), delete_media_sweep
    coach/             read_coach, read_coach_cohort, write_coach_request (plan, review,
                       debrief; waits for the answer), write_coach_resolve, write_coach_share,
                       delete_coach_data. Proposals are applied with the write tools (option A)
    write.ts           change(): runs a mutation through the store and reports it the same way
                       for every write tool (saved, revision, notPersisted, conflictsRedone, warnings)
docs/OPENGYM.md        what leap relies on in openGym: document, sync, shapes, with sources
data/exercises.json    openGym's exercise catalogue (text), from scripts/build-catalogue.mjs
scripts/build-catalogue.mjs  regenerates it from an openGym checkout at a release tag
scripts/test-server.mjs  throwaway openGym API in Docker (the tested release) for live tests
tests/                 contract tests (tools/), helpers (fetch stub, MCP harness, stateful
                       fake openGym), live/ (OPENGYM_LIVE=1 only)
```

### Writing the profile

openGym stores a profile as **one document** that `PUT /api/data` replaces
whole. Since 1.3.10 the document carries sync stamps (`edited`, `deleted`,
per-field `_f` on entries) and leap writes as an up-to-date client
(`stamped: true`), so the server corrects nothing: leap stamps every change
exactly as the app does. Read `docs/OPENGYM.md` before writing a tool that
changes the document. Every write goes through `StateStore.update(mutate, { verify })`:

1. Check that the server is an openGym leap can write to (`compat.ts`; asked
   once, a refusal re-checked after a minute).
2. Load the document, its `rev` and its write id `_wid`.
3. `mutate(draft, { now })` changes a private copy, or refuses (nothing is sent).
   It is called again on the fresh document after a conflict, so it must decide
   from `draft` alone. `now` is after every stamp the document carries.
4. The store refuses a document leap must never send (a list or map key holding
   anything else, a changed `unit`/`unitSet` unless `allowUnitChange`, a tool
   touching `resetAt`/`resetIds`/`coach` or the sync records, an empty
   document, one over 5 MiB), then stamps the change (`stamps.ts`, a port of the
   app's `stampChange`: settings and plan days in `edited`, removals in
   `deleted`, changed entries' `_ts`/`_f`, re-stamped weigh-ins and stamped-map
   entries) and sets the top-level `_ts`.
5. Back up the current document (owner-only files, newest 50, under
   `$XDG_STATE_HOME/leap/backups/<instance>`). No backup, no write.
6. `PUT { state, baseRev, baseWid, stamped: true }`. On 409, reload and redo
   step 3 (up to 4 attempts). With no response, reload: if the document carries
   this write's `_ts` it was applied (never redo it), otherwise retry. A 503
   "state unreadable" means nothing was written.
7. Read back and run `verify` (compare entries without their stamps); report
   `notPersisted`, `retries`, `warnings`.

Rules for mutate functions:

- Change only what was asked. Keep every unknown key and field, `_f` and `_u` included.
- Never write `null` where the app's default is a list or map.
- Stamp a workout a tool edits with `_ts = now`; the store adds its `_f`. An entry of
  a stamped map (`dayNotes`, `dbLoad`, `dumbbells`, `plates`, …) is cleared by writing
  a stamped empty entry, never by deleting its key.
- Weights are in the profile's `unit`; never convert silently.
- Keep `workouts` sorted by `d`, then `start`; `bodyweight` one entry per day,
  sorted by day.
- Deletions are recorded in `deleted`; only a device still on openGym 1.3.9
  with unsynced changes can bring an entry back. Delete tools say so.

### HTTP layer

- A single request function; all tool code goes through it.
- Returns `Result<T>`, never throws for HTTP errors. Every openGym error body is
  `{"error": "...", "code"?: "...", "retryAfter"?: n}`; `message` is
  `<status>: <error>`, `code` and `Retry-After` are kept.
- A write with no response has an unknown outcome; the message says so.
- Log method + path to stderr. stdout belongs to the MCP transport.

## Tool conventions

- Register tools **without** a `leap_` prefix; MCP clients add the server key
  (`read_me` → `leap_read_me`).
- Tier prefixes are the permission contract: `read_` (allow), `write_` (ask),
  `delete_` (ask), `admin_` (deny by default). Never put a mutation in `read_`.
  Coach requests that spend provider budget are `write_`.
- Responses are compact JSON. Errors: `isError: true`, a one-line summary, then
  `status`, `code` and `body`.

## Testing

- **Contract tests** (`tests/tools/`) stub `fetch` with the payload openGym
  really returns and drive the real client through the MCP server
  (`tests/helpers/harness.ts`). Required for every tool. The stateful fake
  openGym follows 1.4.0's `PUT /api/data` for a stamping writer and refuses a
  write without `stamped: true`.
- **Live tests** (`npm run test:live`, `tests/live/`) run only with
  `OPENGYM_LIVE=1`. Write tests run against a throwaway local instance,
  never a real profile: `scripts/test-server.mjs start` runs the official API
  image in Docker with password login and an admin test profile, and writes
  `OPENGYM_URL`/`OPENGYM_TOKEN` to `.cache/test-server/env` (see DEVELOPMENT.md).
- When fixing a bug, first write a test that fails against the old code.

## Status and remaining work

Done: scaffold, HTTP layer, pairing, `read_me`, `read_instance`, the state
layer (verified live, including a real 409 from a second writer), the exercise
catalogue with `read_exercises` and `read_exercise` (verified live), training
reads: workouts, routines, week plan, body weight (verified live; volume and
best weight match openGym's stored `vol`/`topW` on all 33 workouts of its demo
profile), `read_profile`, `read_settings`, `read_document`, stats (PRs match
openGym's on the demo profile), body weight, goal, settings, notes,
favourites and the raw write, routines and the plan, workouts (verified live
and against openGym's own code), custom exercises, media (verified live).

Local files: leap reads a file only for `write_attach_media` (a regular file
whose bytes are one of the seven media types) and writes one only for
`write_download_media` (a new file, mode 600, never overwriting, named with
the extension of the media type, so it can never become a script, a key or a
start-up file; a local write, so it is in the write tier). Photos lose their
metadata before upload; videos with a location are refused. Both decided with
the user (2026-10-07).

AI Coach (verified live with the fixture provider). Applying a proposal is
done with leap's write tools, not by re-implementing the app's apply code
(decided with the user, 2026-10-07). leap never gives consent.

Account and admin (verified live). Not offered, decided with the user
(2026-10-07): anything that needs the current password as proof (setting or
removing the password or sign-in e-mail, removing a passkey, device links) and
filing a Coach provider credential, so no password or secret passes through
an AI conversation; passkey ceremonies, which need a device; push
subscriptions, which belong to a browser. A test asserts that no tool takes a
password, token or secret.

Released as 1.0.0 (2026-10-07) after three focused reviews (openGym parity,
security, tool contracts), fuzzing of the media parsers and a check of leap's
writes with openGym's own merge code.

1.1.0 (openGym 1.4.0, 2026-10-09): stamped writes, the bundled catalogue and
search, rotation and session queue, the 1.4.0 training fields, 1RM formulas,
dumbbell meanings, measurements and the new settings. The ports were checked
against openGym's own functions with randomised states (stampChange: 4,000
changes; effective plan, round view, refill and rotation save: about 47,000
checks; no difference), and the live tests pass against the 1.4.0 API image.
