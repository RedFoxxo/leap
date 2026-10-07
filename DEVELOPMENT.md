# Developing leap

`CLAUDE.md` holds the architecture, domain rules, conventions and the confirmed
openGym API surface. Read it before changing behaviour.

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
and are never part of `npm test`:

```sh
npm run test:live
```

Run write tests against a throwaway instance, never against a profile you care
about.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Development. All work happens here. |
| `stable` | Released, known-good state. Updated from `main` only when a version is released. |

## Releasing

1. Bump the version in `package.json` and `src/version.ts` (a test keeps them
   equal), and move the changelog entry from "Unreleased" to the release date.
2. Commit on `main`; `npm run typecheck`, `npm test` and `npm run build` must pass.
3. Fast-forward `stable` to `main` and tag the release: `git tag v<version>`.
4. Push `main`, `stable` and the tag.
5. `npm publish` publishes `@redfoxxo/leap` publicly (`publishConfig`), after
   running typecheck, tests and build via `prepublishOnly`. Check the contents
   beforehand with `npm pack --dry-run`.
6. Create the GitHub release from the tag: `gh release create v<version>` with the
   changelog entry as notes.
