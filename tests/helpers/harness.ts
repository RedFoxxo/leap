import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Config } from '../../src/config.js'
import { createServer } from '../../src/server.js'
import { createContext, type ContextOptions, type ToolContext } from '../../src/tools/context.js'
import { fixtureCatalog } from '../fixtures/exercises.js'
import { FetchStub } from './fetch-stub.js'

export const BASE = 'https://gym.example'
export const TOKEN = 'test-token-0000.signature'

export interface CallResult {
  isError: boolean
  text: string
  /** Parsed JSON body of a successful call. */
  json: any
}

export interface Harness {
  stub: FetchStub
  ctx: ToolContext
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>
  listTools: () => Promise<{ name: string; description?: string; annotations?: Record<string, unknown> }[]>
  close: () => Promise<void>
}

/**
 * The real server, real client and real handlers, connected to an MCP client
 * over an in-memory transport. Only `fetch` is stubbed.
 */
export async function harness(
  options: { stub?: FetchStub; config?: Partial<Config>; context?: Omit<ContextOptions, 'fetch'> } = {},
): Promise<Harness> {
  const stub = options.stub ?? new FetchStub()
  const config: Config = { baseUrl: BASE, token: TOKEN, ...options.config }
  const ctx = createContext(config, {
    backup: null,
    builtinExercises: async () => fixtureCatalog(),
    ...options.context,
    fetch: stub.fetch,
  })
  const server = createServer(ctx)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)

  return {
    stub,
    ctx,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as { type: string; text: string }[]
      const text = content.map((c) => c.text).join('\n')
      let json: unknown
      if (!result.isError) {
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
      }
      return { isError: Boolean(result.isError), text, json }
    },
    async listTools() {
      return (await client.listTools()).tools as { name: string; description?: string; annotations?: Record<string, unknown> }[]
    },
    async close() {
      await client.close()
    },
  }
}
