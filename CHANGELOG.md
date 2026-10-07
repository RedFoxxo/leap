# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal) and is reported to
MCP clients in the server handshake.

## 1.0.0 — 2026-10-07

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
