import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isRecord } from './state/types.js'
import type { ToolContext } from './tools/context.js'
import { toolsFor, type AnyToolDef } from './tools/index.js'
import { LISTED_SHORT } from './tools/schema.js'
import { TOOLSETS, tierOf } from './tools/types.js'
import { INSTRUCTIONS } from './tools/write.js'
import { VERSION } from './version.js'

/**
 * Only reads are marked (read tools and the admin tools that only read). Everything else keeps the
 * MCP defaults (not read-only, destructive, open world): writes overwrite and delete profile data.
 */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true }

export function createServer(ctx: ToolContext, tools: AnyToolDef[] = toolsFor(ctx.config.toolsets ?? TOOLSETS)): McpServer {
  const server = new McpServer({ name: 'leap', version: VERSION }, { instructions: INSTRUCTIONS })
  const listed: Tool[] = []

  for (const tool of tools) {
    const tier = tierOf(tool.name)
    if (!tier) throw new Error(`Tool "${tool.name}" has no tier prefix (read_/write_/delete_/admin_)`)
    if (listed.some((t) => t.name === tool.name)) throw new Error(`Tool "${tool.name}" is registered twice`)
    const annotations = tier === 'read' || tool.readOnly === true ? { annotations: READ_ONLY } : {}
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, ...annotations }, async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) =>
      tool.handler(args, ctx, { signal: extra?.signal }),
    )
    listed.push({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.input), ...annotations })
  }

  // The SDK's own tools/list repeats `$schema` and `execution: { taskSupport: "forbidden" }` (the protocol's
  // default) on every tool, bytes every client pays for in context. This lists the same tools in fewer tokens,
  // built once. Calls still go through the SDK, which validates arguments against the full zod shapes.
  if (listed.length) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }))
  return server
}

/**
 * The input JSON Schema the model reads: the one the SDK derives, without `$schema` (JSON Schema
 * 2020-12 is MCP's default dialect), with the sub-schemas marked `sameAs` in short, and compacted.
 */
function inputSchema(shape: z.ZodRawShape): Tool['inputSchema'] {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(shape), {
    target: 'draft-2020-12',
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      const short = LISTED_SHORT.get(zodSchema)
      if (short === undefined) return
      const { type } = jsonSchema
      for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Record<string, unknown>)[key]
      Object.assign(jsonSchema, { description: short, type })
    },
  })
  return compact(schema) as Tool['inputSchema']
}

/** Values that are data, not schemas: never rewritten. */
const DATA_KEYWORDS: Record<string, true> = { enum: true, const: true, default: true, examples: true }
const PRIMITIVES: Record<string, true> = { string: true, number: true, integer: true, boolean: true }

/**
 * Says the same in fewer tokens: drops `propertyNames: {type: "string"}` (JSON keys always are
 * strings), `additionalProperties: {}` (anything is the default) and the safe-integer `maximum` zod
 * adds to a positive integer, and writes a nullable primitive `anyOf: [X, {type: "null"}]` as X with
 * `type: [X.type, "null"]` (and null in its `enum`). Keys under `properties` are names, never keywords.
 */
function compact(schema: Record<string, unknown>): Record<string, unknown> {
  const sub = (value: unknown): unknown => (Array.isArray(value) ? value.map(sub) : isRecord(value) ? compact(value) : value)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'propertyNames' && isRecord(value) && value.type === 'string' && Object.keys(value).length === 1) continue
    if (key === 'additionalProperties' && isRecord(value) && Object.keys(value).length === 0) continue
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue
    if (DATA_KEYWORDS[key]) out[key] = value
    else if (key === 'properties' && isRecord(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, s]) => [name, sub(s)]))
    else out[key] = sub(value)
  }
  return nullablePrimitive(out)
}

function nullablePrimitive(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf, ...rest } = schema
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return schema
  const nullAt = anyOf.findIndex((s) => isRecord(s) && s.type === 'null' && Object.keys(s).length === 1)
  const value: unknown = anyOf[1 - nullAt]
  if (nullAt < 0 || !isRecord(value) || typeof value.type !== 'string' || !PRIMITIVES[value.type] || 'const' in value) return schema
  const merged: Record<string, unknown> = { ...rest, ...value, type: [value.type, 'null'] }
  if (Array.isArray(value.enum)) merged.enum = [...value.enum, null]
  if (rest.description !== undefined) merged.description = rest.description
  return merged
}
