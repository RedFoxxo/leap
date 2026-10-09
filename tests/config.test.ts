import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, loadPairConfig } from '../src/config.js'

const base = { OPENGYM_URL: 'https://gym.example.com', OPENGYM_TOKEN: 'secret' }

describe('loadConfig', () => {
  it('accepts the required variables', () => {
    expect(loadConfig(base)).toEqual({ baseUrl: 'https://gym.example.com', token: 'secret' })
  })

  it('strips a trailing slash and keeps a sub-path', () => {
    expect(loadConfig({ ...base, OPENGYM_URL: 'https://example.com/gym/' }).baseUrl).toBe('https://example.com/gym')
  })

  it('reports every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    try {
      loadConfig({})
    } catch (error) {
      expect((error as Error).message).toMatch(/OPENGYM_URL is required/)
      expect((error as Error).message).toMatch(/OPENGYM_TOKEN is required/)
    }
  })

  it('rejects an /api suffix', () => {
    expect(() => loadConfig({ ...base, OPENGYM_URL: 'https://gym.example.com/api' })).toThrow(/without \/api/)
  })

  it('requires https except for localhost', () => {
    expect(() => loadConfig({ ...base, OPENGYM_URL: 'http://gym.example.com' })).toThrow(/must be an https URL/)
    expect(loadConfig({ ...base, OPENGYM_URL: 'http://localhost:8080' }).baseUrl).toBe('http://localhost:8080')
  })

  it('never prints credentials from the URL', () => {
    for (const url of ['http://user:hunter2@gym.example.com', 'https://user:hunter2@gym.example.com/api', 'ht!tp://user:hunter2@x']) {
      expect(() => loadConfig({ ...base, OPENGYM_URL: url })).toThrow()
      try {
        loadConfig({ ...base, OPENGYM_URL: url })
      } catch (error) {
        expect((error as Error).message).not.toContain('hunter2')
      }
    }
  })

  it('rejects credentials, query strings and fragments', () => {
    expect(() => loadConfig({ ...base, OPENGYM_URL: 'https://a:b@gym.example.com' })).toThrow(/credentials/)
    expect(() => loadConfig({ ...base, OPENGYM_URL: 'https://gym.example.com/?x=1' })).toThrow(/query string/)
  })
})

describe('loadPairConfig', () => {
  it('needs only the URL', () => {
    expect(loadPairConfig({ OPENGYM_URL: 'https://gym.example.com' })).toEqual({ baseUrl: 'https://gym.example.com', token: '' })
    expect(() => loadPairConfig({})).toThrow(/OPENGYM_URL is required/)
  })
})
