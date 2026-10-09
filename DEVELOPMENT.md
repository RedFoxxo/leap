# Developing leap

`CLAUDE.md` holds the architecture, domain rules and conventions;
`docs/OPENGYM.md` what leap relies on in openGym. Read both before changing behaviour.

## From source

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/RedFoxxo/leap.git
cd leap
npm ci
npm run build
```

The server entry point is `build/index.js` (MCP over stdio). To run a local build
instead of the published package, point your client at it, e.g. in opencode:

```json
"leap": {
  "type": "local",
  "command": ["node", "/path/to/leap/build/index.js"],
  "environment": { "OPENGYM_URL": "{env:OPENGYM_URL}", "OPENGYM_TOKEN": "{env:OPENGYM_TOKEN}" }
}
```

`.env.example` lists the variables. leap does not read `.env` files itself.

## Commands

```sh
npm test            # unit + contract tests (stubbed fetch, no network)
npm run typecheck   # src and tests
npm run build       # compile to build/
node build/index.js pair   # trade a pairing code for a token (needs OPENGYM_URL)
```

Run `npm run typecheck`, `npm test` and `npm run build` before every commit.

## Live tests

Live tests hit the instance in `OPENGYM_URL`, run only with `OPENGYM_LIVE=1`,
and are never part of `npm test`. Run them against a throwaway instance, never
against a profile you care about. `scripts/test-server.mjs` starts one in Docker
(the official `opengym-api` image, API only, on `127.0.0.1:3999`), registers an
admin test profile with password login, pairs it, and writes the variables to
`.cache/test-server/env`:

```sh
node scripts/test-server.mjs start
set -a; . .cache/test-server/env; set +a
npm run test:live
node scripts/test-server.mjs stop     # removes the container and its data
```

The image defaults to the openGym release in `OPENGYM.tested` (`src/version.ts`).
`OPENGYM_IMAGE` picks another image tag, `OPENGYM_TEST_PORT` another port.

## Exercise catalogue

`data/exercises.json` is openGym's exercise catalogue (text only), generated
from an openGym checkout at a release tag:

```sh
git clone https://gitlab.com/DuarteSantos8/opengym.git ../opengym
git -C ../opengym checkout v1.4.0
node scripts/build-catalogue.mjs ../opengym
```

Never copy the pictures or animations (`catalogue/media/`): they are licensed
from Gym visual for openGym only.

## Moving to a new openGym release

1. Research what changed since the release in `docs/OPENGYM.md` (sync, the
   document's shape, `api/server.js`) and update that file.
2. Regenerate the catalogue from the new tag.
3. Set `OPENGYM` in `src/version.ts`, the README's compatibility table, the
   changelog line and the test server's image tag (a test keeps them equal).
4. `npm run build`, then `node scripts/check-parity.mjs <openGym checkout>`: leap's ports
   (sync stamps, rotation and queue) against openGym's own code on randomised documents.
5. Run the live tests against the new image.
6. Raising `OPENGYM.minimum` drops servers that worked before: say so in the
   changelog.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Development. All work happens here. |
| `stable` | Released, known-good state. Updated from `main` only when a version is released. |

## Releasing

1. Bump the version in `package.json` and `src/version.ts` (a test keeps them
   equal), move the changelog entry from "Unreleased" to the release date, and
   replace "(next)" in the README's compatibility table.
2. Commit on `main`; `npm run typecheck`, `npm test` and `npm run build` must pass.
3. Fast-forward `stable` to `main` and tag the release: `git tag v<version>`.
4. Push `main`, `stable` and the tag.
5. `npm publish` publishes `@redfoxxo/leap` publicly (`publishConfig`), after
   running typecheck, tests and build via `prepublishOnly`. Check the contents
   beforehand with `npm pack --dry-run`.
6. Create the GitHub release from the tag: `gh release create v<version>` with the
   changelog entry as notes.
