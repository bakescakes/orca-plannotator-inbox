#!/usr/bin/env node
// Installs and updates the Orca build of Plannotator: a Plannotator binary built with its Orca mode,
// published as a release of this plugin's own repository. Stock Plannotator stays the fallback: this
// never touches the `plannotator` a person installed, and anything that fails leaves the build in
// use (or stock Plannotator) as it was.
//
//   plannotator-update [--version <x.y.z>]   install the newest Orca build of that Plannotator
//                                            version (no --version: the newest build published)
//   plannotator-update --restart             restart the Inbox on the installed build, in Orca mode
//
// What runs it: the Plannotator Inbox in Orca mode (its Update button and its automatic updates run
// `config.upgradeCommand --version <x.y.z>` detached, and read `upgradeStateFile` for progress), and
// the plugin's worker. It writes, in `<shared>` (`~/.orca-plannotator-inbox`):
//   bridge/upgrade-state.json   {phase, version, at (s), detail}: resolving → building → staged →
//                               activating → ready, or failed / rolled-back. Only the run that
//                               holds the lock writes it.
//   plannotator/versions/<version>-<build>/plannotator[.exe]   one folder per installed build
//   plannotator/current.json    the build in use; previous.json the one before it (kept for rollback)
//   plannotator/update.lock     held while a run works, so two runs never overlap
// The last line on stdout is one JSON object saying what happened (the worker reads it).
//
// Downloads come only from https://github.com/ and the hosts GitHub redirects release assets to,
// redirects are followed by hand (at most 5), every answer has a size cap and a timeout, and a
// binary is checked against the manifest's size and SHA-256 before it is made executable or run.
// Plain JavaScript, Node builtins only: it is copied out of the plugin and run by a launcher.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'bakescakes/orca-plannotator-inbox'
/** Where releases are downloaded from. Tests point `ORCA_PLANNOTATOR_RELEASES` at a loopback server. */
export const RELEASES = `https://github.com/${REPOSITORY}/releases/download`
export const INDEX_TAG = 'plannotator-orca-index'
/** github.com answers a release asset with a redirect to one of these. */
export const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']
export const LIMITS = {
  json: 256 * 1024,
  binary: 400 * 1024 * 1024,
  redirects: 5,
  /** Until the answer's headers arrive. */
  connectMs: 30_000,
  /** Between two pieces of a download. */
  idleMs: 60_000,
  /** One whole download. */
  totalMs: 20 * 60_000,
  smokeMs: 20_000,
  healthMs: 30_000,
  commandMs: 90_000,
  /** A lock older than this, or whose holder is gone, is taken over. */
  lockStaleMs: 2 * 60 * 60_000,
  /** The lock's gate is held for a moment; a run waits this often, this long, to get in. */
  gateTries: 200,
  gatePauseMs: 10,
  /** A gate this old was left behind, whatever it says. */
  gateStaleMs: 60_000
}
const PHASES = ['queued', 'resolving', 'building', 'staged', 'activating', 'ready', 'failed', 'rolled-back']
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/
const BUILD = /^orca\.(\d{1,6})$/
const SHA256 = /^[0-9a-f]{64}$/
const RECORD_BYTES = 4096
const posix = process.platform !== 'win32'
const myUid = typeof process.getuid === 'function' ? process.getuid() : null
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A failure whose message is one plain sentence for the person. */
export class UpdateError extends Error {}

// ---------------------------------------------------------------------------------------------
// Versions

export function compareVersions(a, b) {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return 0
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  return 0
}

const buildNumber = (build) => Number(BUILD.exec(build)?.[1] ?? -1)

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  return PLATFORMS.includes(key) ? key : null
}

export function assetName(key) {
  return `plannotator-orca-${key}${key.startsWith('win32-') ? '.exe' : ''}`
}

export function binaryName(platform = process.platform) {
  return platform === 'win32' ? 'plannotator.exe' : 'plannotator'
}

// ---------------------------------------------------------------------------------------------
// Where things live

function expandHome(value, home) {
  if (value === '~') return home
  return value.startsWith('~/') || value.startsWith('~\\') ? join(home, value.slice(2)) : value
}

/** The shared folder: an explicit one, `ORCA_PLANNOTATOR_HOME`, the folder this file was installed in, then the default. */
export function sharedDir(env, home = homedir(), self = null) {
  const override = (env.ORCA_PLANNOTATOR_HOME ?? '').trim()
  if (override) return resolve(expandHome(override, home))
  if (self && existsSync(join(dirname(self), 'plannotator-update.json'))) return dirname(self)
  return join(home, '.orca-plannotator-inbox')
}

export function paths(shared) {
  const store = join(shared, 'plannotator')
  return {
    shared,
    store,
    versions: join(store, 'versions'),
    current: join(store, 'current.json'),
    previous: join(store, 'previous.json'),
    lock: join(store, 'update.lock'),
    bridge: join(shared, 'bridge'),
    config: join(shared, 'bridge', 'config.json'),
    state: join(shared, 'bridge', 'upgrade-state.json'),
    heartbeat: join(shared, 'state.json'),
    installed: join(shared, 'plannotator-update.json')
  }
}

/** Plannotator's own data-dir rule. */
function defaultDataDir(env, home) {
  const explicit = (env.PLANNOTATOR_DATA_DIR ?? '').trim()
  if (explicit) return resolve(expandHome(explicit, home))
  const dotFolder = join(home, '.plannotator')
  const xdg = (env.XDG_DATA_HOME ?? '').trim()
  if (!existsSync(dotFolder) && xdg && isAbsolute(xdg) && existsSync(join(xdg, 'plannotator'))) return join(xdg, 'plannotator')
  return dotFolder
}

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function inside(folder, path) {
  const rel = relative(folder, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

// ---------------------------------------------------------------------------------------------
// Small private files

/** A small file only this user can read and write, not a link; throws otherwise. */
export function readPrivate(path, maximum = RECORD_BYTES) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('a link')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('not a file')
    if (posix && ((myUid !== null && info.uid !== myUid) || (info.mode & 0o077) !== 0)) throw new Error('not private')
    if (info.size > maximum) throw new Error('too large')
    const buffer = Buffer.alloc(maximum + 1)
    const length = readSync(fd, buffer, 0, maximum + 1, 0)
    if (length > maximum) throw new Error('too large')
    return buffer.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

/** Writes `value` as JSON, readable by this user only, all at once (write, sync, rename). */
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * The build a record names, when everything about it holds: a private record, a path inside
 * `<shared>/plannotator/versions` exactly where its version and build say, a plain file (not a link)
 * that belongs to this user, nobody else can write, and has the recorded size. The SHA-256 was
 * checked when it was installed; it is not read again on every start (the file is ~200 MB).
 */
export function validRecord(record, shared, platform = process.platform) {
  if (!isRecord(record) || record.v !== 1) return null
  const { version, build, path, sha256, size, installedAt } = record
  if (typeof version !== 'string' || !VERSION.test(version) || typeof build !== 'string' || !BUILD.test(build)) return null
  if (typeof sha256 !== 'string' || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > LIMITS.binary) return null
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
  const { versions } = paths(shared)
  const expected = join(versions, `${version}-${build}`, binaryName(platform))
  const key = (value) => (platform === 'win32' ? value.toLowerCase() : value)
  if (key(resolve(path)) !== key(resolve(expected))) return null
  try {
    const root = real(versions)
    for (const part of [dirname(path), path]) {
      if (lstatSync(part).isSymbolicLink()) return null
    }
    if (!inside(root, real(path))) return null
    const info = statSync(path)
    if (!info.isFile() || info.size !== size) return null
    if (posix && ((myUid !== null && info.uid !== myUid) || (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0)) return null
  } catch {
    return null
  }
  return { v: 1, version, build, path, sha256, size, installedAt: Number.isFinite(installedAt) ? installedAt : 0 }
}

/** `current.json` (or `previous.json`), when it names a usable build; otherwise null. */
export function readRecord(file, shared, platform = process.platform) {
  try {
    return validRecord(JSON.parse(readPrivate(file).toString('utf8')), shared, platform)
  } catch {
    return null
  }
}

export function readState(shared) {
  try {
    const state = JSON.parse(readPrivate(paths(shared).state, 16 * 1024).toString('utf8'))
    return isRecord(state) && PHASES.includes(state.phase) ? state : null
  } catch {
    return null
  }
}

export function writeState(shared, phase, version, detail, clock = Date.now) {
  const state = { phase, ...(version ? { version } : {}), at: clock() / 1000, detail }
  writePrivateJson(paths(shared).state, state)
  return state
}

function readJsonFile(path, maximum = 64 * 1024) {
  try {
    return JSON.parse(readPrivate(path, maximum).toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// The lock

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** What a lock file says, or null when it is missing or says nothing. */
function lockRecord(file) {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(held) ? held : null
  } catch {
    return null
  }
}

/** The run that holds the lock now, or null. */
export function lockHolder(shared, now = Date.now()) {
  const held = lockRecord(paths(shared).lock)
  // No lock, or one that cannot be read: nobody holds it.
  return held && alive(held.pid) && Number.isFinite(held.at) && now - held.at < LIMITS.lockStaleMs ? held : null
}

const pause = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
/** What `open` answers on Windows for a file another run is just removing. */
const TAKEN = process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EBUSY', 'EACCES'] : ['EEXIST']

/**
 * Removes a gate that was left behind: its run is gone, or it is older than any run keeps one.
 * It is moved aside first and looked at again there, so a gate another run made in the meantime
 * is never the one removed: that one is put back.
 */
function clearLeftGate(gate, now = Date.now()) {
  let seen
  try {
    seen = statSync(gate, { bigint: true })
  } catch {
    return
  }
  const said = lockRecord(gate)
  if (!(said && !alive(said.pid)) && now - Number(seen.mtimeMs) <= LIMITS.gateStaleMs) return
  const aside = `${gate}.${process.pid}.${randomBytes(4).toString('hex')}.left`
  try {
    renameSync(gate, aside)
  } catch {
    return
  }
  try {
    const moved = statSync(aside, { bigint: true })
    if (moved.ino === seen.ino && moved.mtimeNs === seen.mtimeNs) return
    try {
      linkSync(aside, gate)
    } catch (error) {
      // A file system without links: put back by name. `EEXIST`: a run is in already; leave it.
      if (error?.code !== 'EEXIST') renameSync(aside, gate)
    }
  } catch {
    // Gone meanwhile.
  } finally {
    rmSync(aside, { force: true })
  }
}

/**
 * Runs `work` with nobody else at the lock: every look at the lock that may change it happens in
 * here, so no run acts on what another is about to change. The gate is a second file made
 * exclusively and held for a moment. Returns what `work` returns, or undefined when the gate
 * stayed taken.
 */
function alone(shared, work) {
  const gate = `${paths(shared).lock}.gate`
  const id = randomBytes(8).toString('hex')
  for (let attempt = 0; attempt < LIMITS.gateTries; attempt += 1) {
    let fd
    try {
      fd = openSync(gate, 'wx', 0o600)
    } catch (error) {
      if (!TAKEN.includes(error?.code)) throw error
      clearLeftGate(gate)
      pause(LIMITS.gatePauseMs)
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, id }))
    } catch (error) {
      closeSync(fd)
      rmSync(gate, { force: true })
      throw error
    }
    closeSync(fd)
    try {
      return work()
    } finally {
      // Only this run's own: had it stood still long enough to be taken for left behind, the
      // gate there now is another run's.
      if (lockRecord(gate)?.id === id) rmSync(gate, { force: true })
    }
  }
  return undefined
}

/** Takes the lock, or returns null while another live run holds it. A lock left behind is taken over. */
export function takeLock(shared, now = Date.now()) {
  const { lock, store } = paths(shared)
  mkdirSync(store, { recursive: true, mode: 0o700 })
  const id = randomBytes(8).toString('hex')
  const taken = alone(shared, () => {
    if (lockHolder(shared, now)) return false
    // Free, or left by a run that is gone. Written beside it and moved into place, so the lock
    // is never there half-written.
    const draft = `${lock}.${process.pid}.${id}.new`
    try {
      writeFileSync(draft, JSON.stringify({ pid: process.pid, at: now, id }), { mode: 0o600, flag: 'wx' })
      for (let attempt = 0; ; attempt += 1) {
        try {
          renameSync(draft, lock)
          return true
        } catch (error) {
          // Windows refuses while another program has the old lock open to read it.
          if (attempt >= 5 || !TAKEN.includes(error?.code) || error.code === 'EEXIST') throw error
          pause(20)
        }
      }
    } catch (error) {
      rmSync(draft, { force: true })
      throw error
    }
  })
  if (!taken) return null
  return () => {
    try {
      alone(shared, () => {
        if (lockRecord(lock)?.id === id) unlinkSync(lock)
      })
    } catch {
      // Left there: it stops counting when this run ends.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Downloads

/** The release base, and which hosts it may lead to. Only a loopback override is taken. */
export function source(env) {
  const override = (env.ORCA_PLANNOTATOR_RELEASES ?? '').trim()
  if (override) {
    let url
    try {
      url = new URL(override)
    } catch {
      throw new UpdateError('ORCA_PLANNOTATOR_RELEASES is not an address.')
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new UpdateError('ORCA_PLANNOTATOR_RELEASES may only name a server on 127.0.0.1.')
    return { base: override.replace(/\/+$/, ''), hosts: ['127.0.0.1'], protocol: 'http:' }
  }
  return { base: RELEASES, hosts: ALLOWED_HOSTS, protocol: 'https:' }
}

function allowed(url, from) {
  return url.protocol === from.protocol && from.hosts.includes(url.hostname) && url.username === '' && url.password === ''
}

/** Fetches `url`, following redirects by hand within the allowed hosts. Returns the final response. */
async function open(url, from, signal, fetchImpl = fetch) {
  let next = new URL(url)
  for (let hop = 0; hop <= LIMITS.redirects; hop += 1) {
    if (!allowed(next, from)) throw new UpdateError(`The download was sent to ${next.host || next.href}, which is not GitHub, so it was stopped.`)
    const response = await fetchImpl(next, { redirect: 'manual', signal, headers: { accept: 'application/octet-stream', 'user-agent': 'orca-plannotator-inbox-updater' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new UpdateError('GitHub answered with a redirect that leads nowhere.')
      next = new URL(location, next)
      continue
    }
    return response
  }
  throw new UpdateError('The download was redirected too many times, so it was stopped.')
}

/** Reads a response in pieces, with an idle timeout and a size cap; `sink` gets each piece. */
async function drain(response, maximum, sink, abort) {
  const reader = response.body.getReader()
  let size = 0
  let idle
  const arm = () => {
    clearTimeout(idle)
    idle = setTimeout(() => abort(new UpdateError('The download stalled, so it was stopped.')), LIMITS.idleMs)
  }
  arm()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new UpdateError('The download is larger than it should be, so it was stopped.')
      }
      sink(value)
      arm()
    }
  } finally {
    clearTimeout(idle)
  }
  return size
}

function timed(totalMs) {
  const controller = new AbortController()
  let reason = null
  const abort = (error) => {
    reason ??= error
    controller.abort(error)
  }
  const timer = setTimeout(() => abort(new UpdateError('The download took too long, so it was stopped.')), totalMs)
  return { signal: controller.signal, abort, reason: () => reason, done: () => clearTimeout(timer) }
}

/** One small JSON file from a release. Null when the release or the file does not exist (404). */
export async function fetchJson(from, tag, name, fetchImpl = fetch) {
  const clock = timed(LIMITS.connectMs * 2)
  try {
    const response = await open(`${from.base}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, from, clock.signal, fetchImpl)
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok || !response.body) throw new UpdateError(`GitHub answered ${response.status} for ${name}.`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > LIMITS.json) throw new UpdateError(`${name} is larger than it should be.`)
    const chunks = []
    await drain(response, LIMITS.json, (chunk) => chunks.push(chunk), clock.abort)
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new UpdateError(`${name} is not valid JSON.`)
    }
  } catch (error) {
    throw clock.reason() ?? asUpdateError(error, `${name} could not be downloaded`)
  } finally {
    clock.done()
  }
}

function asUpdateError(error, what) {
  if (error instanceof UpdateError) return error
  return new UpdateError(`${what} (${error?.cause?.code ?? error?.code ?? error?.message ?? 'network error'}).`)
}

/**
 * Downloads one asset to `target` (a new file), hashing as it goes. Throws unless it has exactly
 * `size` bytes and the SHA-256 `sha256`; the file is removed then.
 */
export async function download(from, tag, asset, target, fetchImpl = fetch) {
  const clock = timed(LIMITS.totalMs)
  const hash = createHash('sha256')
  const fd = openSync(target, 'wx', 0o600)
  let ok = false
  try {
    const response = await open(`${from.base}/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`, from, clock.signal, fetchImpl)
    if (response.status === 404) throw new UpdateError(`${asset.name} is listed in the release but is not there.`)
    if (!response.ok || !response.body) throw new UpdateError(`GitHub answered ${response.status} for ${asset.name}.`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > asset.size) throw new UpdateError('The download is larger than the release says, so it was stopped.')
    const size = await drain(
      response,
      Math.min(asset.size, LIMITS.binary),
      (chunk) => {
        hash.update(chunk)
        writeSync(fd, chunk)
      },
      clock.abort
    )
    if (size !== asset.size) throw new UpdateError(`The download has ${size} bytes, not the ${asset.size} the release lists, so it was not used.`)
    if (hash.digest('hex') !== asset.sha256) throw new UpdateError('The download does not match the checksum the release lists, so it was not used.')
    fsyncSync(fd)
    ok = true
  } catch (error) {
    throw clock.reason() ?? asUpdateError(error, 'The download failed')
  } finally {
    clock.done()
    closeSync(fd)
    if (!ok) rmSync(target, { force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Index and manifest

function readRef(value) {
  if (!isRecord(value)) return null
  const { plannotator, build, tag } = value
  if (typeof plannotator !== 'string' || !VERSION.test(plannotator) || typeof build !== 'string' || !BUILD.test(build)) return null
  if (tag !== `plannotator-${plannotator}-${build}`) return null
  return { plannotator, build, tag }
}

/** The index's builds, newest first; throws when it is not an index. */
export function readIndex(index) {
  if (!isRecord(index) || index.v !== 1) throw new UpdateError('The list of Orca builds has a shape this plugin does not know; update the plugin.')
  const latest = readRef(index.latest)
  const listed = Array.isArray(index.builds) ? index.builds.slice(0, 1000).map(readRef).filter(Boolean) : []
  const builds = [...(latest ? [latest] : []), ...listed]
  builds.sort((a, b) => compareVersions(b.plannotator, a.plannotator) || buildNumber(b.build) - buildNumber(a.build))
  return { latest: latest ?? builds[0] ?? null, builds }
}

/** The build to install: the newest of `version`, or the newest of all. Null when there is none. */
export function pickBuild(index, version) {
  if (!version) return index.latest
  return index.builds.find((entry) => entry.plannotator === version) ?? null
}

export function readManifest(manifest, ref, key) {
  if (!isRecord(manifest) || manifest.v !== 1) throw new UpdateError('The Orca build’s manifest has a shape this plugin does not know; update the plugin.')
  if (manifest.plannotator !== ref.plannotator || manifest.build !== ref.build) throw new UpdateError('The Orca build’s manifest names another build, so it was not used.')
  const pluginMin = typeof manifest.pluginMin === 'string' && VERSION.test(manifest.pluginMin) ? manifest.pluginMin : null
  if (!pluginMin) throw new UpdateError('The Orca build’s manifest does not say which plugin it needs, so it was not used.')
  const asset = isRecord(manifest.assets) ? manifest.assets[key] : undefined
  if (asset === undefined) return { pluginMin, asset: null }
  if (
    !isRecord(asset) ||
    asset.name !== assetName(key) ||
    typeof asset.sha256 !== 'string' ||
    !SHA256.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > LIMITS.binary
  ) {
    throw new UpdateError('The Orca build’s manifest lists this computer’s file in a shape this plugin does not know, so it was not used.')
  }
  return { pluginMin, asset: { name: asset.name, sha256: asset.sha256, size: asset.size } }
}

// ---------------------------------------------------------------------------------------------
// Running programs

/** Environment for Plannotator started from here: without what only this process or its starter needed. */
export function childEnvironment(env, extra = {}) {
  const out = { ...env }
  // This file runs with Orca's own binary in Node mode; nothing started from here may inherit that.
  delete out.ELECTRON_RUN_AS_NODE
  // Set by an Inbox for the processes it starts (this one, when its Update button ran it).
  delete out.PLANNOTATOR_INBOX_LOCK_HELD
  delete out.PLANNOTATOR_INBOX_DETACHED
  delete out.PLANNOTATOR_ORCA_MODE
  delete out.PLANNOTATOR_ORCA_CONFIG
  delete out.NODE_OPTIONS
  return { ...out, ...extra }
}

/** Runs a program to the end; resolves `{code, out}` (stdout and stderr together, capped). Never throws. */
export function run(binary, args, { env, timeoutMs, cwd }) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(binary, args, { env, cwd: cwd ?? tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      return done({ code: null, out: '', error: error.message })
    }
    let out = ''
    const take = (chunk) => {
      if (out.length < 64 * 1024) out += chunk.toString('utf8')
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ code: null, out, error: 'timed out' })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ code: null, out, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, out, error: null })
    })
  })
}

/** The system variables a program needs to start (on Windows, at all). */
function systemEnv(env) {
  const keys = posix ? ['PATH', 'TMPDIR', 'LANG'] : ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
  return Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]))
}

/** `<binary> --version` in a throwaway home and data folder: it must start and name `version`. */
export async function smoke(binary, version, env) {
  const home = mkdtempSync(join(tmpdir(), 'orca-plannotator-smoke-'))
  try {
    const result = await run(binary, ['--version'], {
      env: { ...systemEnv(env), HOME: home, USERPROFILE: home, PLANNOTATOR_DATA_DIR: join(home, 'data'), PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_AUTO_UPDATE: '0', PLANNOTATOR_INBOX_CONNECT: '0' },
      timeoutMs: LIMITS.smokeMs,
      cwd: home
    })
    const named = new RegExp(`(^|[^0-9.])${version.replaceAll('.', '\\.')}([^0-9.]|$)`).test(result.out)
    if (result.code !== 0 || !named) {
      const why = result.error === 'timed out' ? 'did not answer within 20 seconds' : result.code !== 0 ? `failed to start (${result.error ?? `exit ${result.code}`})` : 'reported another version'
      throw new UpdateError(`The downloaded Plannotator ${version} ${why}, so it was not used.`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** macOS marks some downloads as quarantined; the build is ad-hoc signed and must run as it is. */
function clearQuarantine(file) {
  if (process.platform !== 'darwin') return Promise.resolve()
  return run('/usr/bin/xattr', ['-d', 'com.apple.quarantine', file], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 }).then(() => undefined)
}

// ---------------------------------------------------------------------------------------------
// The Inbox server

/** Where the Inbox this plugin serves keeps its data: Orca's bridge config, the worker's heartbeat, then Plannotator's default. */
export function inboxDataDir(shared, env, home = homedir()) {
  const p = paths(shared)
  const config = readJsonFile(p.config)
  const fromConfig = isRecord(config) ? (config.canonicalDataDir ?? (Array.isArray(config.dataDirs) ? config.dataDirs[0] : undefined)) : undefined
  if (typeof fromConfig === 'string' && isAbsolute(fromConfig)) return fromConfig
  try {
    const beat = JSON.parse(readFileSync(p.heartbeat, 'utf8'))
    if (isRecord(beat) && typeof beat.dataDir === 'string' && isAbsolute(beat.dataDir)) return beat.dataDir
  } catch {
    // No worker heartbeat: Plannotator's own default.
  }
  return defaultDataDir(env, home)
}

/** Orca mode applies when Orca's bridge config is there, private to this user (Plannotator insists). */
export function orcaModeConfig(shared) {
  const { config } = paths(shared)
  try {
    readPrivate(config, 64 * 1024)
    return config
  } catch {
    return null
  }
}

/** The running Inbox's record for `dataDir`, or null. */
export function registry(dataDir) {
  try {
    const entry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8'))
    return isRecord(entry) && Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65536 ? entry : null
  } catch {
    return null
  }
}

/** Whether an Inbox runs for `dataDir`: Plannotator's own `inbox status` (exit 0 running, 2 not answering). */
export async function inboxRunning(binary, dataDir, env) {
  const result = await run(binary, ['inbox', 'status', '--json'], { env: childEnvironment(env, { PLANNOTATOR_DATA_DIR: dataDir }), timeoutMs: 20_000 })
  try {
    const status = JSON.parse(result.out.slice(result.out.indexOf('{')))
    return status.state === 'running' || status.state === 'busy' ? { pid: Number(status.pid) || null } : null
  } catch {
    return result.code === 0 || result.code === 2 ? { pid: null } : null
  }
}

/**
 * Waits for the Inbox of `dataDir` to answer `/api/inbox/health` as a process other than `oldPid`
 * (when the answer names its pid). Resolves the health answer, or null after `timeoutMs`.
 */
export async function waitHealthy(dataDir, { oldPid = null, timeoutMs = LIMITS.healthMs, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entry = registry(dataDir)
    if (entry) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${entry.port}/api/inbox/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
        const health = response.ok ? await response.json() : null
        const pid = isRecord(health) && Number.isInteger(health.pid) ? health.pid : null
        if (isRecord(health) && (pid === null || pid !== oldPid) && (pid === null || entry.pid === undefined || entry.pid === pid)) return health
      } catch {
        // Not up yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/**
 * Restarts the Inbox of `dataDir` on `binary`: Plannotator's own `inbox restart`, which holds the
 * Inbox's start lock, asks the running Inbox to stop (it saves as it goes, so nothing is lost),
 * and starts `binary` detached without a browser tab. Then waits for it to answer. Resolves the
 * health answer, or null when it did not come up.
 */
export async function restartOn(binary, dataDir, env, orcaConfig, { oldPid = null, fetchImpl = fetch } = {}) {
  const extra = { PLANNOTATOR_DATA_DIR: dataDir, ...(orcaConfig ? { PLANNOTATOR_ORCA_MODE: '1', PLANNOTATOR_ORCA_CONFIG: orcaConfig } : {}) }
  const result = await run(binary, ['inbox', 'restart'], { env: childEnvironment(env, extra), timeoutMs: LIMITS.commandMs, cwd: tmpdir() })
  if (result.code !== 0) return null
  return waitHealthy(dataDir, { oldPid, fetchImpl })
}

/** Stock Plannotator: an explicit `PLANNOTATOR_BIN`, then PATH, then Plannotator's own install folders. */
export function findStock(env, home = homedir()) {
  const explicit = (env.PLANNOTATOR_BIN ?? '').trim()
  if (explicit && existsSync(explicit)) return explicit
  const names = posix ? ['plannotator'] : ['plannotator.exe', 'plannotator.cmd', 'plannotator']
  const folders = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin')]
  if (!posix && env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'plannotator'))
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Keeping the store tidy

/** Removes every build folder except the ones in `keep`, and leftover downloads. Never anything outside the store. */
export function prune(shared, keep) {
  const { versions } = paths(shared)
  let names
  try {
    names = readdirSync(versions)
  } catch {
    return
  }
  const kept = new Set(keep.filter(Boolean).map((record) => `${record.version}-${record.build}`))
  for (const name of names) {
    if (kept.has(name)) continue
    const path = join(versions, name)
    try {
      const info = lstatSync(path)
      if (info.isSymbolicLink() || info.isFile()) unlinkSync(path)
      else if (info.isDirectory()) rmSync(path, { recursive: true, force: true })
    } catch {
      // In use (Windows) or gone: next time.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The run

function describe(record) {
  return record ? `the Orca build of Plannotator ${record.version}` : 'stock Plannotator'
}

/**
 * Installs the newest Orca build of `version` (or of all), and moves the running Inbox onto it.
 * Returns the outcome; throws only when the lock cannot be taken safely.
 */
export async function update(options) {
  const { shared, env = process.env, version = null, pluginVersion = null, home = homedir(), fetchImpl = fetch, clock = Date.now } = options
  const p = paths(shared)
  const release = takeLock(shared, clock())
  if (!release) return { ok: true, busy: true, detail: 'Another update of the Orca build is already running.' }
  let target = version
  const state = (phase, detail) => writeState(shared, phase, target, detail, clock)
  const before = readRecord(p.current, shared)
  const staying = describe(before)
  try {
    state('resolving', version ? `Looking for the Orca build of Plannotator ${version}.` : 'Looking for the newest Orca build of Plannotator.')
    const key = platformKey()
    if (!key) throw new UpdateError(`Orca builds of Plannotator are not made for ${process.platform}-${process.arch}, so ${staying} stays in use.`)
    if (version !== null && !VERSION.test(version)) throw new UpdateError(`${version} is not a Plannotator version, so ${staying} stays in use.`)
    const from = source(env)
    const rawIndex = await fetchJson(from, INDEX_TAG, 'index.json', fetchImpl)
    if (rawIndex === null) throw new UpdateError(`No Orca build of Plannotator has been published yet, so ${staying} stays in use.`)
    const index = readIndex(rawIndex)
    const latest = index.latest ? { version: index.latest.plannotator, build: index.latest.build } : null
    const ref = pickBuild(index, version)
    if (!ref) {
      throw new UpdateError(
        version ? `No Orca build of Plannotator ${version} has been published yet, so ${staying} stays in use.` : `No Orca build of Plannotator has been published yet, so ${staying} stays in use.`
      )
    }
    target = ref.plannotator
    if (before && compareVersions(ref.plannotator, before.version) < 0) {
      throw new UpdateError(`Plannotator ${ref.plannotator} is older than the ${before.version} in use, so nothing was changed.`)
    }
    if (before && before.version === ref.plannotator && buildNumber(before.build) >= buildNumber(ref.build)) {
      const detail = `The Orca build of Plannotator ${before.version} (${before.build}) is already the newest, and it stays in use.`
      state('ready', detail)
      return { ok: true, installed: false, version: before.version, build: before.build, latest, detail }
    }
    const manifest = await fetchJson(from, ref.tag, 'manifest.json', fetchImpl)
    if (manifest === null) throw new UpdateError(`The Orca build of Plannotator ${ref.plannotator} is listed but its release is missing, so ${staying} stays in use.`)
    const { pluginMin, asset } = readManifest(manifest, ref, key)
    if (!asset) throw new UpdateError(`The Orca build of Plannotator ${ref.plannotator} has no file for ${key}, so ${staying} stays in use.`)
    if (!pluginVersion || !VERSION.test(pluginVersion) || compareVersions(pluginVersion, pluginMin) < 0) {
      throw new UpdateError(`The Orca build of Plannotator ${ref.plannotator} needs version ${pluginMin} of the Plannotator Inbox plugin; update the plugin first. ${capitalize(staying)} stays in use.`)
    }

    state('building', `Downloading the Orca build of Plannotator ${ref.plannotator} (${Math.round(asset.size / 1024 / 1024)} MB).`)
    mkdirSync(p.versions, { recursive: true, mode: 0o700 })
    const work = mkdtempSync(join(p.versions, '.download-'))
    const part = join(work, binaryName())
    await download(from, ref.tag, asset, part, fetchImpl)
    chmodSync(part, 0o755)
    await clearQuarantine(part)

    state('staged', `Checking that the Orca build of Plannotator ${ref.plannotator} starts.`)
    await smoke(part, ref.plannotator, env)
    const folder = join(p.versions, `${ref.plannotator}-${ref.build}`)
    rmSync(folder, { recursive: true, force: true })
    renameSync(work, folder)
    chmodSync(folder, 0o700)
    const record = { v: 1, version: ref.plannotator, build: ref.build, path: join(folder, binaryName()), sha256: asset.sha256, size: asset.size, installedAt: clock() }
    if (!validRecord(record, shared)) throw new UpdateError(`The Orca build of Plannotator ${ref.plannotator} could not be put in place, so ${staying} stays in use.`)

    state('activating', `Switching to the Orca build of Plannotator ${ref.plannotator}.`)
    const outcome = await activate({ shared, env, home, record, before, fetchImpl })
    if (outcome.rolledBack !== undefined) {
      state(outcome.rolledBack ? 'rolled-back' : 'failed', outcome.detail)
      return { ok: false, rolledBack: outcome.rolledBack, version: ref.plannotator, build: ref.build, latest, detail: outcome.detail }
    }
    prune(shared, [record, before])
    const detail = `The Orca build of Plannotator ${ref.plannotator} (${ref.build}) is in use${outcome.restarted ? ', and the Inbox was restarted on it' : ''}.`
    state('ready', detail)
    return { ok: true, installed: true, restarted: outcome.restarted, version: ref.plannotator, build: ref.build, latest, detail }
  } catch (error) {
    let detail = error instanceof UpdateError ? error.message : `The update failed (${error?.message ?? error}), so ${staying} stays in use.`
    if (!/stays in use|nothing was changed/.test(detail)) detail = `${detail} ${capitalize(staying)} stays in use.`
    try {
      state('failed', detail)
    } catch {
      // The state file cannot be written; the result line still says it.
    }
    return { ok: false, version: target, detail }
  } finally {
    for (const name of safeList(p.versions)) {
      if (name.startsWith('.download-')) rmSync(join(p.versions, name), { recursive: true, force: true })
    }
    release()
  }
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1)

function safeList(folder) {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

/**
 * Makes `record` the build in use. When an Inbox runs for the served data folder in Orca mode,
 * restarts it on the new build and waits for it; when it does not come up, puts the previous build
 * (or stock Plannotator) back and restarts on that. Returns `{restarted}` on success, or
 * `{rolledBack, detail}`.
 */
async function activate({ shared, env, home, record, before, fetchImpl }) {
  const p = paths(shared)
  writePrivateJson(p.current, record)
  if (before && before.path !== record.path) writePrivateJson(p.previous, before)
  const orcaConfig = orcaModeConfig(shared)
  const dataDir = inboxDataDir(shared, env, home)
  // Asked with what ran so far, which is known to answer `inbox status`.
  const running = await inboxRunning(before?.path ?? findStock(env, home) ?? record.path, dataDir, env)
  // Nothing runs, or Orca mode is not set up: the next start uses the new build by itself.
  if (!running || !orcaConfig) return { restarted: false }
  const healthy = await restartOn(record.path, dataDir, env, orcaConfig, { oldPid: running.pid, fetchImpl })
  if (healthy) return { restarted: true }

  // Back to what ran before.
  if (before) writePrivateJson(p.current, before)
  else rmSync(p.current, { force: true })
  const fallback = before?.path ?? findStock(env, home)
  const back = fallback ? await restartOn(fallback, dataDir, env, before ? orcaConfig : null, { fetchImpl }) : null
  const failed = `The Orca build of Plannotator ${record.version} did not answer within 30 seconds after the restart`
  if (back) return { rolledBack: true, detail: `${failed}, so ${describe(before)} was put back and the Inbox runs on it again.` }
  return { rolledBack: false, detail: `${failed}, and ${describe(before)} did not start again either; the Inbox starts again with an agent’s next message.` }
}

/** Restarts the Inbox on the installed build in Orca mode, or on stock Plannotator when that fails. */
export async function restartInbox(options) {
  const { shared, env = process.env, home = homedir(), fetchImpl = fetch } = options
  const p = paths(shared)
  const release = takeLock(shared)
  if (!release) return { ok: false, busy: true, detail: 'An update of the Orca build is running; the Inbox is restarted when it finishes.' }
  try {
    const record = readRecord(p.current, shared)
    const dataDir = inboxDataDir(shared, env, home)
    const orcaConfig = orcaModeConfig(shared)
    if (!record) return { ok: false, detail: 'No Orca build of Plannotator is installed yet, so the Inbox stays as it is.' }
    if (!orcaConfig) return { ok: false, detail: 'Orca has not set up the Inbox connection yet, so the Inbox stays as it is.' }
    const running = await inboxRunning(findStock(env, home) ?? record.path, dataDir, env)
    if (await restartOn(record.path, dataDir, env, orcaConfig, { oldPid: running?.pid ?? null, fetchImpl })) {
      return { ok: true, version: record.version, build: record.build, detail: `The Inbox runs on the Orca build of Plannotator ${record.version}.` }
    }
    const stock = findStock(env, home)
    const back = stock ? await restartOn(stock, dataDir, env, null, { fetchImpl }) : null
    return {
      ok: false,
      detail: back
        ? `The Orca build of Plannotator ${record.version} did not answer within 30 seconds, so the Inbox runs on stock Plannotator again.`
        : `The Orca build of Plannotator ${record.version} did not answer within 30 seconds, and stock Plannotator did not start either; the Inbox starts again with an agent’s next message.`
    }
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------------------------
// Command line

export function parseArgs(argv) {
  const out = { version: null, restart: false, sharedDir: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version') {
      out.version = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--restart') out.restart = true
    else if (arg === '--shared-dir') {
      out.sharedDir = argv[i + 1] ?? ''
      i += 1
    } else throw new UpdateError(`Unknown option ${arg}.`)
  }
  if (out.version !== null && !VERSION.test(out.version)) throw new UpdateError('--version takes a Plannotator version such as 0.28.66.')
  if (out.restart && out.version !== null) throw new UpdateError('--restart does not go with --version.')
  return out
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, detail: error.message })}\n`)
    return 64
  }
  const self = fileURLToPath(import.meta.url)
  const shared = args.sharedDir ? resolve(args.sharedDir) : sharedDir(env, homedir(), self)
  const installed = readJsonFile(paths(shared).installed)
  const pluginVersion = isRecord(installed) && typeof installed.pluginVersion === 'string' ? installed.pluginVersion : null
  const result = args.restart ? await restartInbox({ shared, env }) : await update({ shared, env, version: args.version, pluginVersion })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.ok || result.busy) return 0
  return result.rolledBack ? 2 : 1
}

// Run only when started as a program; tests import the functions above.
const invoked = process.argv[1] ? real(process.argv[1]) : ''
const self = real(fileURLToPath(import.meta.url))
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  main().then(
    (code) => process.stdout.write('', () => process.exit(code)),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, detail: `The updater stopped: ${error?.message ?? error}` })}\n`, () => process.exit(1))
    }
  )
}
