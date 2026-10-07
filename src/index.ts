#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig, loadPairConfig, type Config } from './config.js'
import { HttpCore } from './http/core.js'
import { stderrLogger } from './log.js'
import { redeem } from './pair.js'
import { createServer } from './server.js'
import { createContext } from './tools/context.js'

function configOrExit(load: () => Config): Config {
  try {
    return load()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

/** `leap pair [code]`: trades a pairing code for a token. The token is the only thing written to stdout. */
async function pair(codeArg: string | undefined): Promise<void> {
  const config = configOrExit(() => loadPairConfig())
  let code = codeArg
  if (!code) {
    process.stderr.write(`In openGym (${config.baseUrl}) open Settings → "Pair the mobile app".\n`)
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    code = await rl.question('Pairing code: ')
    rl.close()
  }
  const r = await redeem(new HttpCore({ baseUrl: config.baseUrl, token: '' }), code)
  if (!r.ok) {
    process.stderr.write(`leap: pairing failed: ${r.message}\n`)
    process.exit(1)
  }
  process.stderr.write(
    `Paired as ${r.data.user.name}. Store this token as OPENGYM_TOKEN (e.g. in your shell profile), never in a config file:\n`,
  )
  process.stdout.write(`${r.data.token}\n`)
}

async function serve(): Promise<void> {
  const config = configOrExit(() => loadConfig())
  const server = createServer(createContext(config, { log: stderrLogger }))
  await server.connect(new StdioServerTransport())
  process.stderr.write('leap: ready on stdio\n')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'pair') return pair(rest[0])
  if (command === undefined) return serve()
  process.stderr.write(`leap: unknown command "${command}". Usage: leap (MCP server on stdio) | leap pair [code]\n`)
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`leap: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
