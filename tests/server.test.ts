import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'
import { allTools } from '../src/tools/index.js'
import { tierOf } from '../src/tools/types.js'
import { harness } from './helpers/harness.js'

describe('server', () => {
  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('completes the MCP handshake and lists every tool', async () => {
    const h = await harness()
    const tools = await h.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(allTools().map((t) => t.name).sort())
    await h.close()
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

  it('read tools are annotated read-only and nothing else is', async () => {
    const h = await harness()
    for (const tool of await h.listTools()) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(tool.name.startsWith('read_'))
    }
    await h.close()
  })
})

describe('sync notes', () => {
  it('every tool whose change a later phone edit can undo says so', async () => {
    const h = await harness()
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.description ?? '']))
    for (const name of ['write_settings', 'write_goal_weight', 'write_week_plan', 'write_day_plan', 'write_document']) {
      expect(tools.get(name), name).toMatch(/from the copy changed last/)
    }
    for (const name of [...tools.keys()].filter((n) => n.startsWith('delete_') && !['delete_media_sweep', 'delete_all_sessions', 'delete_coach_data', 'delete_media'].includes(n))) {
      expect(tools.get(name), name).toMatch(/no record of deletions/)
    }
    await h.close()
  })
})
