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

Status: 0.1.0, scaffold. See "Status and remaining work" at the end.

## Licensing rule

openGym is AGPL-3.0-or-later; leap is MIT. **Never copy openGym code** (not the
frontend helpers, not the official `mcp/` server, not the exercise data unless
its own licence allows it). Reading openGym's source to learn the data format
and behaviour is fine; implement everything in our own words. Record where a
fact came from (file and commit) so it can be re-checked when openGym changes.

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

Besides `OPENGYM_URL`, leap contacts exactly one other host: once per
dataset version it downloads the exercise catalogue from
`raw.githubusercontent.com` (pinned commit, hash-checked, never with the
token) and caches it under `$XDG_CACHE_HOME/leap`. Offline, tools show ids
instead of built-in names and say so.

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
  pair.ts              pairing-code redemption
  log.ts, version.ts
  http/
    core.ts            the one request function: Bearer token, User-Agent, stderr log, Result
    result.ts          Result<T> = { ok: true, status, data } | { ok: false, status, message, code?, retryAfter?, body }
    redact.ts          token redaction (configured token and every "token" field in bodies)
  catalog/
    exercises.ts       built-in exercises (pinned upstream MIT dataset, hash-checked, cached),
                       custom exercises from the profile, ExerciseIndex (names, favourites, notes)
  domain/
    sets.ts            how a logged set row is read: warm-ups, drop sets, rest-pause, per-side
                       rows, modes; volume, completed reps, best weight, entry routine
    plan.ts            weekday plan (list or legacy single id), date overrides, routine lookup
    dates.ts           local calendar days (`YYYY-MM-DD`), weekdays
    stats.ts           1RM formulas and best set, PR rule (beatsWeight), exercise sessions,
                       muscle loads (dataset muscles, synonyms mapped to target names)
  state/
    types.ts           the loosely typed profile document, list/map accessors
    store.ts           load, and update(): the one write path (see "Writing the profile")
    backup.ts          pre-write backups
    ids.ts             entry ids in the app's format
  tools/
    types.ts, context.ts, respond.ts, index.ts
    account/           read_me, read_instance; profile.ts: read_profile, read_settings,
                       read_document (raw escape hatch: any top-level key)
    exercises/         read_exercises, read_exercise
    training/          read_workouts, read_workout, read_routines, read_routine,
                       read_week_plan, read_bodyweight; format.ts shapes workouts for output
    stats/             read_exercise_history, read_records, read_training_summary,
                       read_muscle_balance
docs/OPENGYM.md        what leap relies on in openGym: document, sync, shapes, with sources
scripts/test-server.mjs  throwaway openGym API in Docker for live tests
tests/                 contract tests (tools/), helpers (fetch stub, MCP harness, stateful
                       fake openGym), live/ (OPENGYM_LIVE=1 only)
```

### Writing the profile

openGym stores a profile as **one document** that `PUT /api/data` replaces
whole, and the phone app merges copies by `_ts` stamps without tombstones. Read
`docs/OPENGYM.md` before writing a tool that changes it. Every write goes
through `StateStore.update(mutate, { verify })`:

1. Load the document and its `rev`.
2. `mutate(draft, { now })` changes a private copy, or refuses (nothing is sent).
   It is called again on the fresh document after a conflict, so it must decide
   from `draft` alone. Stamp what it changes with `now` (`_ts`; `t` on weigh-ins).
3. The store sets the top-level `_ts` (always moving forward), drops `_rev` and
   `active`, and refuses a document leap must never send: a list or map key
   holding anything else, a changed `unit`/`unitSet` (unless `allowUnitChange`),
   changed `resetAt`/`resetIds`/`coach`, an empty document, or one over 5 MiB.
4. Back up the current document (owner-only files, newest 50, under
   `$XDG_STATE_HOME/leap/backups/<instance>`). No backup, no write.
5. `PUT` with `baseRev`. On 409, reload and redo step 2 (up to 4 attempts). With
   no response, reload: if the document carries this write's `_ts` it was
   applied (never redo it), otherwise retry.
6. Read back and run `verify`; report `notPersisted`, `retries`, `warnings`.

Rules for mutate functions:

- Change only what was asked. Keep every unknown key and field.
- Never write `null` where the app's default is a list or map.
- Weights are in the profile's `unit`; never convert silently.
- Keep `workouts` sorted by `d`, then `start`; `bodyweight` one entry per day,
  sorted by day.
- Deleting cannot be guaranteed: a device with unsynced changes brings the
  entry back on its next merge. Delete tools say so.

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
  (`tests/helpers/harness.ts`). Required for every tool.
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
openGym's on the demo profile).

Planned, in order:

1. Write and delete tools for training data and settings. Logging or editing a
   workout must set `vol`, `topW` and `prs` the way the app does, and rebuild
   later sessions' PR badges when history changes (`rebuildPrHistory`, see
   docs/OPENGYM.md "Stats").
2. Media, Coach, account, admin.
