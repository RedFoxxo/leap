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
