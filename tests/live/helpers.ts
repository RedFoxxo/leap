import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BuiltinCatalogProvider } from '../../src/catalog/exercises.js'
import { loadConfig } from '../../src/config.js'
import { createServer } from '../../src/server.js'
import { fileBackups } from '../../src/state/backup.js'
import { createContext } from '../../src/tools/context.js'

export const LIVE = process.env.OPENGYM_LIVE === '1'

export interface LiveResult {
  isError: boolean
  text: string
  json: any
}

/** The real server against the instance in OPENGYM_URL, over an in-memory MCP transport. */
export async function liveClient(): Promise<{ call: (name: string, args?: Record<string, unknown>) => Promise<LiveResult>; close: () => Promise<void> }> {
  const catalog = new BuiltinCatalogProvider({ cacheFile: '.cache/live-exercises.json' })
  const server = createServer(
    createContext(loadConfig(), { backup: fileBackups('.cache/test-server/backups'), builtinExercises: () => catalog.get() }),
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'live', version: '0' })
  await client.connect(clientTransport)
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args })
      const text = (result.content as { text: string }[]).map((c) => c.text).join('\n')
      let json: unknown
      try {
        json = result.isError ? undefined : JSON.parse(text)
      } catch {
        json = undefined
      }
      return { isError: Boolean(result.isError), text, json }
    },
    close: () => client.close(),
  }
}
