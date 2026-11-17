// Stand-ins for the Orca build's release and for Plannotator itself, for the updater's tests.
//
// releaseServer(): a GitHub release host on 127.0.0.1 that serves `index.json`, each build's
// `manifest.json` and its binary, with the faults a real download can meet.
// fakePlannotator(): a "Plannotator binary" (a POSIX shell script) whose `--version`, `inbox
// status|restart|stop|--background` and Inbox server behave like Plannotator's, in a chosen flavour.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const KEY = `${process.platform}-${process.arch}`
export const ASSET = `plannotator-orca-${KEY}${process.platform === 'win32' ? '.exe' : ''}`

export function tempRoot(prefix = 'orca-plannotator-update-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * builds: [{ version, build, bytes, manifest?: (m) => m, asset?: false }]. `faults` (mutable):
 *   truncate: asset name → send half and cut the connection
 *   redirect: asset name → URL to redirect it to (relative paths stay on this server)
 *   delayMs: before a binary's first byte
 *   noIndex: index.json is 404
 */
export async function releaseServer(builds = []) {
  const faults = { truncate: new Set(), redirect: new Map(), delayMs: 0, noIndex: false }
  const hits = []
  const releases = new Map()
  const publish = (entry) => {
    const tag = `plannotator-${entry.version}-${entry.build}`
    const assets = entry.asset === false ? {} : { [KEY]: { name: ASSET, sha256: sha256(entry.bytes), size: entry.bytes.length } }
    let manifest = { v: 1, plannotator: entry.version, build: entry.build, pluginMin: '0.2.0', assets }
    if (entry.manifest) manifest = entry.manifest(manifest)
    releases.set(tag, { entry, manifest })
  }
  for (const entry of builds) publish(entry)
  const index = () => {
    const all = [...releases.values()].map(({ entry }) => ({ plannotator: entry.version, build: entry.build, tag: `plannotator-${entry.version}-${entry.build}` }))
    const latest = all[all.length - 1] ?? null
    return { v: 1, latest, builds: all }
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
    hits.push(path)
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const parts = path.split('/').filter(Boolean)
    if (parts[0] === 'cdn') parts.shift()
    const [tag, name] = parts
    if (tag === 'plannotator-orca-index' && name === 'index.json') return faults.noIndex ? json(404, {}) : json(200, index())
    const release = releases.get(tag)
    if (!release) return json(404, { message: 'Not Found' })
    if (name === 'manifest.json') return json(200, release.manifest)
    if (name !== ASSET || release.entry.asset === false) return json(404, { message: 'Not Found' })
    if (!path.startsWith('/cdn/') && faults.redirect.has(tag)) {
      response.writeHead(302, { location: faults.redirect.get(tag) })
      return response.end()
    }
    const bytes = release.entry.bytes
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) })
      if (faults.truncate.has(tag)) {
        response.write(bytes.subarray(0, Math.floor(bytes.length / 2)))
        setTimeout(() => response.socket?.destroy(), 20)
        return
      }
      response.end(bytes)
    }, faults.delayMs)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    faults,
    hits,
    publish,
    downloads: () => hits.filter((path) => path.endsWith(ASSET)).length,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

// --- A Plannotator stand-in ----------------------------------------------------------------------

/**
 * One program for every flavour. The flavour and version come from the script that runs it, so each
 * flavour is a different file with a different checksum, as different builds are.
 *   good      behaves
 *   nosmoke   `--version` fails
 *   dead      `inbox restart` stops the running Inbox and starts one that never answers
 * `update` is Plannotator's own updater: it rewrites this very file to the release FAKE_UPDATE_TO names,
 * as the install script replaces the binary; FAKE_UPDATE_FAIL makes it fail as a download does;
 * FAKE_UPDATE_SEEN names a file that gets the environment it ran with.
 */
const PROGRAM = `
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
const flavor = process.env.FAKE_FLAVOR
const version = process.env.FAKE_VERSION
const self = process.env.FAKE_SELF
const args = process.argv.slice(2)
const data = process.env.PLANNOTATOR_DATA_DIR
const registryPath = () => join(data, 'inbox', 'inbox.json')
const registry = () => { try { return JSON.parse(readFileSync(registryPath(), 'utf8')) } catch { return null } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const running = () => { const entry = registry(); return entry && alive(entry.pid) ? entry : null }
async function stop() {
  const entry = running()
  if (!entry) return
  process.kill(entry.pid, 'SIGTERM')
  for (let i = 0; i < 100 && alive(entry.pid); i++) await sleep(50)
}
async function start() {
  const env = { ...process.env, FAKE_SERVE: '1' }
  const child = spawn(self, ['__serve'], { detached: true, stdio: 'ignore', env })
  child.unref()
  for (let i = 0; i < 100; i++) { const entry = registry(); if (entry && entry.pid === child.pid) return entry; await sleep(50) }
  return null
}
if (args[0] === '--version') {
  if (flavor === 'nosmoke') { process.stderr.write('broken\\n'); process.exit(1) }
  process.stdout.write('plannotator ' + version + '\\n')
} else if (args[0] === 'update') {
  if (process.env.FAKE_UPDATE_SEEN) writeFileSync(process.env.FAKE_UPDATE_SEEN, JSON.stringify({ dataDir: data ?? null, orcaMode: process.env.PLANNOTATOR_ORCA_MODE ?? null }))
  const to = process.env.FAKE_UPDATE_TO
  if (process.env.FAKE_UPDATE_FAIL) {
    process.stdout.write('Plannotator ' + to + ' is available (you have ' + version + ').\\nInstalling v' + to + '.\\n')
    process.stderr.write("Couldn't download the update. " + version + ' is still installed and works. Try again later: plannotator update\\nIf this keeps happening, install it yourself:\\n  curl -fsSL https://example.invalid/install.sh | bash\\nDetails: /tmp/update.log\\n')
    process.exit(1)
  }
  if (!to || to === version) { process.stdout.write('Plannotator ' + version + ' is installed. Up to date (checked just now).\\n'); process.exit(0) }
  writeFileSync(self, readFileSync(self, 'utf8').replace("FAKE_VERSION='" + version + "'", "FAKE_VERSION='" + to + "'"))
  process.stdout.write('Updated to ' + to + '.\\n')
} else if (args[0] === '__serve') {
  const server = createServer((request, response) => {
    if (flavor === 'dead') return
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (request.url === '/api/inbox/health') return send(200, { ok: true, version, pid: process.pid, self, orcaMode: process.env.PLANNOTATOR_ORCA_MODE ?? null, orcaConfig: process.env.PLANNOTATOR_ORCA_CONFIG ?? null })
    if (request.url === '/api/inbox/orca') return process.env.PLANNOTATOR_ORCA_MODE === '1' ? send(200, { version: 1, mode: 'orca' }) : send(404, { error: 'Orca mode is off.' })
    send(404, {})
  })
  server.listen(0, '127.0.0.1', () => {
    mkdirSync(join(data, 'inbox'), { recursive: true })
    writeFileSync(registryPath(), JSON.stringify({ pid: process.pid, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port + '/', version, token: 't' }), { mode: 0o600 })
  })
  process.on('SIGTERM', () => process.exit(0))
} else if (args[0] === 'inbox' && args[1] === 'status') {
  const entry = running()
  process.stdout.write(JSON.stringify(entry ? { state: 'running', running: true, pid: entry.pid, version: entry.version } : { state: 'stopped', running: false }) + '\\n')
  process.exit(entry ? 0 : 1)
} else if (args[0] === 'inbox' && args[1] === 'stop') {
  await stop()
} else if (args[0] === 'inbox' && (args[1] === 'restart' || args[1] === '--background')) {
  if (args[1] === 'restart') await stop()
  else if (running()) { process.stdout.write(registry().url + '\\n'); process.exit(0) }
  const entry = await start()
  if (!entry) process.exit(1)
  process.stdout.write(entry.url + '\\n')
} else {
  process.stderr.write('unknown ' + args.join(' ') + '\\n')
  process.exit(2)
}
`

let programPath = null
function program() {
  if (!programPath) {
    const folder = tempRoot('orca-plannotator-fake-')
    programPath = join(folder, 'fake-plannotator.mjs')
    writeFileSync(programPath, PROGRAM)
  }
  return programPath
}

/** The bytes of a stand-in Plannotator binary of `flavor` and `version` (a shell script). */
export function fakeBinary(flavor = 'good', version = '0.28.66', salt = '') {
  const q = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
  return Buffer.from(
    [
      '#!/bin/sh',
      `# ${salt}`,
      `FAKE_FLAVOR=${q(flavor)} FAKE_VERSION=${q(version)} FAKE_SELF="$0" ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(program())} "$@"`,
      ''
    ].join('\n')
  )
}

/** Writes a stand-in binary to `path`, executable. */
export function installFake(path, flavor = 'good', version = '0.28.66') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, fakeBinary(flavor, version), { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

/** Runs a program to the end: `{ code, stdout, stderr }`. */
export function runProgram(file, args, env, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
