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
  tools/
    types.ts, context.ts, respond.ts, index.ts
    account/           read_me, read_instance
tests/                 contract tests (tools/), helpers (fetch stub, MCP harness), live/ (OPENGYM_LIVE=1 only)
```

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
  `OPENGYM_LIVE=1`. Write tests run against a throwaway local instance
  (Docker), never a real profile.
- When fixing a bug, first write a test that fails against the old code.

## Status and remaining work

Done: scaffold, HTTP layer, pairing, `read_me`, `read_instance`.

Planned, in order:

1. State layer: read the profile document, typed views of it, and the safe
   write path (read-modify-write with `baseRev`, retry on 409, keep unknown
   fields, read back to verify).
2. Read tools for training data and stats.
3. Write and delete tools for training data and settings.
4. Media, Coach, account, admin.
