import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OPENGYM, VERSION } from '../src/version.js'
import { allTools, TOOLSET_TOOLS } from '../src/tools/index.js'
import { tierOf, TOOLSETS } from '../src/tools/types.js'
import { harness } from './helpers/harness.js'

describe('server', () => {
  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('lists every tool in the README, and only those', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const section = readme.slice(readme.indexOf('## Tools'), readme.indexOf('## Limitations'))
    const listed = [...section.matchAll(/`((?:read|write|delete|admin)_[a-z_]+)`/g)].map((m) => m[1])
    expect(listed.sort()).toEqual(allTools().map((t) => t.name).sort())
  })

  it('states the supported openGym the same way everywhere', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const range = `${OPENGYM.minimum} or later (tested with ${OPENGYM.tested})`
    expect(read('../README.md')).toContain(`| ${range} |`)
    expect(read('../CHANGELOG.md')).toContain(`Works with openGym ${range}`)
    expect(read('../scripts/test-server.mjs')).toContain(`opengym-api:${OPENGYM.tested}'`)
    expect(read('../data/exercises.json').slice(0, 300)).toContain(`"version":"${OPENGYM.tested}"`)
  })

  it('completes the MCP handshake and lists every tool', async () => {
    const h = await harness()
    const tools = await h.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(allTools().map((t) => t.name).sort())
    await h.close()
  })

  it('lists tools without the dialect and default execution the SDK repeats on every tool', async () => {
    const h = await harness()
    const tools = (await h.listTools()) as unknown as Record<string, unknown>[]
    for (const tool of tools) {
      expect(tool, String(tool.name)).not.toHaveProperty('execution')
      expect(tool.inputSchema, String(tool.name)).toMatchObject({ type: 'object' })
      expect(tool.inputSchema, String(tool.name)).not.toHaveProperty('$schema')
    }
    const routine = tools.find((t) => t.name === 'write_routine')!.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(routine.properties)).toEqual(['id', 'name', 'emoji', 'progression', 'excludeFromProgression', 'exercises'])
    await h.close()
  })

  it('lists schemas compactly without changing what calls accept', async () => {
    const h = await harness()
    const text = JSON.stringify(await h.listTools())
    expect(text).not.toContain('"propertyNames":{"type":"string"}')
    expect(text).not.toContain('"additionalProperties":{}')
    expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER))
    expect(text).not.toMatch(/"anyOf":\[\{"type":"(?:string|number|integer|boolean)"[^{}]*\},\{"type":"null"\}\]/)
    expect(text).toContain('"right":{"description":"Same fields as left","type":"object"}')
    expect(text).toContain(`"drops":{"description":"As the set's drops","type":"array"}`)
    expect(text).toContain('"note":{"description":"Left out: kept; null or empty: removed","type":["string","null"],"maxLength":500}')
    expect(text).toContain('"enum":["reps","time","cardio",null]')
    // The SDK still validates the parts listed in short against the full schema.
    const refused = await h.call('write_log_workout', { entries: [{ exerciseId: '0025', sets: [{ left: { reps: 5 }, right: { reps: 5, bogus: 1 } }] }] })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/bogus/)
    expect(h.stub.calls).toHaveLength(0)
    await h.close()
  })
})

describe('toolsets', () => {
  it('puts every tool in exactly one toolset', () => {
    const grouped = TOOLSETS.flatMap((t) => TOOLSET_TOOLS[t])
    expect(grouped.slice().sort()).toEqual(allTools().map((t) => t.name).sort())
  })

  it('exposes only the configured toolsets, in registration order', async () => {
    const h = await harness({ config: { toolsets: ['training', 'body'] } })
    const names = (await h.listTools()).map((t) => t.name)
    expect(names.slice().sort()).toEqual([...TOOLSET_TOOLS.training, ...TOOLSET_TOOLS.body].sort())
    expect(names).toEqual(allTools().map((t) => t.name).filter((n) => names.includes(n)))
    await h.close()
  })

  it('lists each toolset in the README with its tools', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const section = readme.slice(readme.indexOf('### Toolsets'), readme.indexOf('### Rules leap enforces'))
    for (const toolset of TOOLSETS) {
      const start = section.indexOf(`**${toolset}** (${TOOLSET_TOOLS[toolset].length})`)
      expect(start, toolset).toBeGreaterThanOrEqual(0)
      const paragraph = section.slice(start, section.indexOf('\n\n', start))
      const listed = [...paragraph.matchAll(/`((?:read|write|delete|admin)_[a-z_]+)`/g)].map((m) => m[1])
      expect(listed.sort(), toolset).toEqual([...TOOLSET_TOOLS[toolset]].sort())
    }
  })
})

describe('tool naming contract', () => {
  const tools = allTools()

  it('every tool has a tier prefix and no leap_ prefix', () => {
    for (const tool of tools) {
      expect(tierOf(tool.name), tool.name).toBeDefined()
      expect(tool.name.startsWith('leap_')).toBe(false)
    }
  })

  it('names are unique', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('marks read tools and the admin tools that only read as read-only, and leaves the MCP defaults to the rest', async () => {
    const h = await harness()
    const adminReads = new Set(['admin_users', 'admin_user', 'admin_invites', 'admin_audit', 'admin_coach'])
    for (const tool of await h.listTools()) {
      const readOnly = tool.name.startsWith('read_') || adminReads.has(tool.name)
      expect(tool.annotations, tool.name).toEqual(readOnly ? { readOnlyHint: true } : undefined)
    }
    await h.close()
  })
})

describe('sync notes', () => {
  it('the server instructions say which changes a later phone edit can undo, once for every tool', async () => {
    const h = await harness()
    const instructions = h.instructions() ?? ''
    expect(instructions).toMatch(/Settings \(write_settings, write_goal_weight, write_document\), exercise notes and the plan .*one setting and one day at a time/)
    expect(instructions).toMatch(/Deleted workouts, routines, custom exercises, weigh-ins and measurements: openGym records the deletion/)
    for (const tool of await h.listTools()) expect(tool.description, tool.name).not.toMatch(/one setting and one day at a time|records the deletion/)
    await h.close()
  })
})
