import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpCore } from '../src/http/core.js'
import { extensionOf, prepareUpload, saveNew } from '../src/media/files.js'
import { FetchStub } from './helpers/fetch-stub.js'

const dir = () => mkdtempSync(join(tmpdir(), 'leap-files-'))
const fixture = (name: string) => new URL(`./fixtures/media/${name}`, import.meta.url).pathname

describe('prepareUpload', () => {
  it('refuses a named pipe without blocking on it', () => {
    const fifo = join(dir(), 'pipe.jpg')
    execFileSync('mkfifo', [fifo])
    expect(() => prepareUpload(fifo)).toThrow(/not a file/)
  })

  it('reads a regular file through a symlink, but only if it is media', () => {
    const d = dir()
    symlinkSync(fixture('plain.jpg'), join(d, 'link.jpg'))
    expect(prepareUpload(join(d, 'link.jpg')).info.mime).toBe('image/jpeg')
    writeFileSync(join(d, 'secret.txt'), 'API_KEY=123')
    symlinkSync(join(d, 'secret.txt'), join(d, 'photo.jpg'))
    expect(() => prepareUpload(join(d, 'photo.jpg'))).toThrow(/not a photo or video/)
  })
})

describe('saveNew', () => {
  it('refuses hidden folders and files, which shells and desktops load at start', () => {
    const d = dir()
    mkdirSync(join(d, '.bashrc.d'))
    expect(() => saveNew(join(d, '.bashrc.d', 'x.jpg'), 'a'.repeat(64), 'image/jpeg', new Uint8Array([1]))).toThrow(/hidden/)
    expect(() => saveNew(join(d, '.x.jpg'), 'a'.repeat(64), 'image/jpeg', new Uint8Array([1]))).toThrow(/hidden/)
    expect(existsSync(join(d, '.bashrc.d', 'x.jpg'))).toBe(false)
  })

  it('treats only real media types as known', () => {
    expect(extensionOf('image/png')).toBe('png')
    expect(extensionOf('constructor')).toBe('bin')
    expect(extensionOf('toString')).toBe('bin')
  })
})

describe('downloads', () => {
  it('refuse a file the server says is larger than openGym allows', async () => {
    const stub = new FetchStub().get('/api/media/x', new Uint8Array([1, 2, 3]), { headers: { 'content-length': String(300 * 1024 * 1024) } })
    const http = new HttpCore({ baseUrl: 'https://gym.example', token: 't0ken-1234', fetch: stub.fetch })
    const r = await http.request({ method: 'GET', path: '/api/media/x', expect: 'bytes', maxBytes: 200 * 1024 * 1024 })
    expect(!r.ok && r.message).toMatch(/larger than/)
  })
})
