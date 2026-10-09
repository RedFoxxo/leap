// Throwaway openGym API in Docker for live tests. Never point live write tests at a real profile.
//
//   node scripts/test-server.mjs start   # container on 127.0.0.1:3999, admin test profile, AI Coach with the
//                                        # fixture provider, token in .cache/test-server/env
//   node scripts/test-server.mjs stop    # removes the container and its data
//
// Then: set -a; . .cache/test-server/env; set +a; npm run test:live
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NAME = 'leap-opengym-test'
// The openGym release this leap is tested with (OPENGYM.tested in src/version.ts; a test keeps them equal).
const IMAGE = process.env.OPENGYM_IMAGE ?? 'ghcr.io/duartesantos8/opengym-api:1.4.0'
const PORT = Number(process.env.OPENGYM_TEST_PORT ?? 3999)
const ORIGIN = `http://localhost:${PORT}`
const DIR = resolve('.cache/test-server')
const PROFILE = { name: 'Leap Tester', password: 'leap-test-password-2026' }

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function removeContainer() {
  try {
    docker('rm', '-f', NAME)
  } catch {
    // not running
  }
}

/**
 * The server writes some files as root (Coach job directories), which this user cannot delete.
 * A short-lived container of the same image empties the data folder first.
 */
function removeData() {
  // Only when it exists: mounting a missing folder makes Docker create it, owned by root.
  if (existsSync(`${DIR}/data`)) {
    docker('run', '--rm', '-v', `${DIR}/data:/data`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /data/* /data/.[!.]* 2>/dev/null; true')
  }
  rmSync(DIR, { recursive: true, force: true })
}

function run(adminUid) {
  const env = ['-e', 'RP_ID=localhost', '-e', `ORIGIN=${ORIGIN}`, '-e', 'PASSWORD_LOGIN=1', '-e', 'DATA_DIR=/data']
  if (adminUid) env.push('-e', `ADMIN_UIDS=${adminUid}`)
  docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:3000`, ...env, '-v', `${DIR}/data:/data`, IMAGE)
}

async function waitUntilUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/health`)
      if (r.ok) return
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`openGym did not come up on ${ORIGIN}; see: docker logs ${NAME}`)
}

/** Browser-style call: same-origin header and the session cookie. */
async function browser(path, cookie, body) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const r = await fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text}`)
  return { json: JSON.parse(text), cookie: r.headers.get('set-cookie')?.split(';')[0] ?? cookie }
}

async function start() {
  removeContainer()
  removeData()
  mkdirSync(`${DIR}/data`, { recursive: true })

  run()
  await waitUntilUp()
  const registered = await browser('/api/register/password', undefined, PROFILE)
  const uid = registered.json.user.id

  // ADMIN_UIDS is read at start-up: restart with the new profile as admin. Data persists in the volume.
  removeContainer()
  run(uid)
  await waitUntilUp()
  const login = await browser('/api/login/password', undefined, { identifier: PROFILE.name, password: PROFILE.password })
  const { code } = (await browser('/api/pair/create', login.cookie)).json
  const paired = await browser('/api/pair/redeem', undefined, { code })

  // The AI Coach with openGym's built-in test provider: the whole loop, no AI account.
  const coach = await fetch(`${ORIGIN}/api/admin/coach/config`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${paired.json.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, provider: 'fixture', caps: { perProfileDaily: 0, instanceDaily: 0 } }),
  })
  if (!coach.ok) throw new Error(`enabling the Coach: ${coach.status} ${await coach.text()}`)

  writeFileSync(
    `${DIR}/env`,
    `OPENGYM_URL=${ORIGIN}\nOPENGYM_TOKEN=${paired.json.token}\nOPENGYM_TEST_PASSWORD=${PROFILE.password}\n`,
    { mode: 0o600 },
  )
  process.stderr.write(`openGym test server on ${ORIGIN}, admin profile "${PROFILE.name}" (${uid}). Env: ${DIR}/env\n`)
}

function stop() {
  removeContainer()
  removeData()
  process.stderr.write('openGym test server removed\n')
}

const command = process.argv[2]
if (command === 'start') await start()
else if (command === 'stop') stop()
else {
  process.stderr.write('usage: node scripts/test-server.mjs start|stop\n')
  process.exit(1)
}
