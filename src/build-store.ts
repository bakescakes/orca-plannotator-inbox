// The Orca build of Plannotator, as the worker sees it: which build is in use, keeping it in step
// with the Plannotator installed here, and starting or restarting the Inbox on it. The work itself (download, checks, switch, rollback)
// is bin/plannotator-update.mjs, which the Inbox's own Update button also runs; this file reads
// what it leaves behind and starts it.
//
//   <shared>/plannotator/current.json   the build in use (written only by the updater)
//   <shared>/plannotator/check.json     when the worker last ran the updater, and what came of it
//   <shared>/bridge/upgrade-state.json  the updater's progress, read by the Inbox in Orca mode
//   <shared>/plannotator/waiting.json   the Plannotator installed here has no Orca build in use yet
//
// Stock Plannotator is the fallback everywhere: with no valid build, or no Orca bridge config, or
// the plugin not delivering, everything runs the `plannotator` the person installed, as before.
import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findOnPath } from './connect'
import { InboxClient } from './inbox'
import type { Env } from './paths'
import type { ActionResult } from './protocol'
import { updaterLauncherName, updaterLauncherScript, upgradeCommand } from './shared'
import { errorText, isRecord } from './util'

/** The updater runs at most this often by itself; each failure in a row doubles it, up to 8×. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
/**
 * While the Plannotator installed here has no Orca build in use yet, or the build in use is a reduced
 * one, the updater looks this often instead (one small read of the release list), until the build is there.
 */
export const WAITING_CHECK_MS = 15 * 60 * 1000
/** The updater's sentence for a release with no build yet, as versions before 0.3.0 wrote it as a failure. */
const NOT_PUBLISHED = /^No Orca build of Plannotator (\d{1,6}\.\d{1,6}\.\d{1,6}) has been published yet\b/
const MAX_BACKOFF_STEPS = 3
/** One updater run, download included. */
const UPDATER_TIMEOUT_MS = 30 * 60 * 1000
const LOCK_STALE_MS = 2 * 60 * 60 * 1000
/** Same as the launcher: a heartbeat older than this does not say "delivering". */
const HEARTBEAT_FRESH_MS = 90_000
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const BUILD = /^orca\.\d{1,6}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_BINARY = 400 * 1024 * 1024
/** A standard Inbox is moved onto the build by itself at most this many times a day, */
export const PLAIN_RESTARTS_A_DAY = 3
/** and after a move that failed, not again for this long, unless the build or the Plannotator installed here changed. */
export const PLAIN_RESTART_WAIT_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** `features` and `omitted`: a reduced build's manifest says what it serves and which Orca changes it leaves out. */
export type BuildRecord = {
  v: 1
  version: string
  build: string
  path: string
  sha256: string
  size: number
  installedAt: number
  features?: string[]
  omitted?: string[]
}
/** A Plannotator release with no Orca build in use yet (the Inbox runs the Plannotator installed here); `since` in ms. */
export type Waiting = { version: string; since: number }
/** A build in use that leaves out some of the Orca changes. `lacks`: plain words for what it lacks. */
export type Reduced = { lacks: string[]; omitted: string[] }
export type UpgradePhase = 'queued' | 'resolving' | 'building' | 'staged' | 'activating' | 'ready' | 'failed' | 'rolled-back'
export type UpgradeState = { phase: UpgradePhase; version: string | null; at: number; detail: string | null }
export type BuildRef = { version: string; build: string }
/** What the updater printed as its last line. */
export type UpdaterResult = {
  ok: boolean
  busy?: boolean
  rolledBack?: boolean
  installed?: boolean
  version?: string | null
  build?: string
  latest?: BuildRef | null
  /** A release with no Orca build in use yet: the run waited, it did not fail. */
  waiting?: { version: string } | null
  /** The Inbox runs the Plannotator installed here until that build is in use. */
  plain?: boolean
  /** The running Inbox was restarted on the build. */
  restarted?: boolean
  detail: string
}

/** For the panel. `mode`: which Plannotator agents and the Inbox start with now. */
export type BuildStatus = {
  mode: 'orca-build' | 'stock'
  /** The Orca build in use; null in stock mode. */
  version: string | null
  build: string | null
  /** The newest Orca build the last look at the release list found. */
  latestKnown: BuildRef | null
  /** The last failure, in one sentence, while it is the most recent outcome. */
  lastError: string | null
  updating: boolean
  /** The updater's own progress (`upgrade-state.json`), when there is one. */
  phase: UpgradePhase | null
  detail: string | null
  /** A newer Plannotator that is out with no Orca build yet. */
  waiting: Waiting | null
  /** The build in use leaves out some Orca changes. */
  reduced: Reduced | null
  /** A standard Inbox is being restarted on the build by itself (after a login, say). */
  moving: boolean
}

/** What each feature an Orca build can serve gives a person, in words for the panel. */
export const FEATURE_WORDS: Readonly<Record<string, string>> = {
  'mark-faces': 'per-agent icons',
  'launch-hosts': 'starting and stopping chats from the Inbox',
  agents: 'connecting every agent',
  'update-state': 'update progress in the Inbox',
  'update-detail': 'update progress in the Inbox'
}

/** What a reduced build lacks: the known features its manifest does not list. Null for a full build. */
export function reducedOf(record: Pick<BuildRecord, 'features' | 'omitted'> | null): Reduced | null {
  const omitted = record?.omitted ?? []
  if (omitted.length === 0) return null
  const served = record?.features ? new Set(record.features) : null
  const lacks = served ? [...new Set(Object.entries(FEATURE_WORDS).filter(([id]) => !served.has(id)).map(([, words]) => words))] : []
  return { lacks, omitted: [...omitted] }
}

/**
 * The last time a standard Inbox was moved onto the build by itself. `serverSession`: that Inbox's own
 * id from its health answer (each start of an Inbox has another); `at`: the last try; `failures` in a
 * row; `tries`: the tries of the last day; `build` and `stock`: the build in use and the Plannotator
 * installed here then (a change to either ends the wait after a failure).
 */
export type PlainRestart = { serverSession: string; at: number; failures: number; tries: number[]; build: string; stock: string }
/** `stock`: the Plannotator installed here as the last look saw it (`stockSignature`, "" when none was found); null before the first look. */
type Check = {
  v: 1
  lastAttempt: number
  failures: number
  lastError: string | null
  lastErrorAt: number
  latestKnown: BuildRef | null
  stock: string | null
  plainRestart?: PlainRestart | null
}
const NO_CHECK: Check = { v: 1, lastAttempt: 0, failures: 0, lastError: null, lastErrorAt: 0, latestKnown: null, stock: null }

function readPlainRestart(value: unknown): PlainRestart | null {
  if (!isRecord(value) || typeof value.serverSession !== 'string' || value.serverSession === '' || value.serverSession.length > 200) return null
  const number = (item: unknown): number => (typeof item === 'number' && Number.isFinite(item) ? item : 0)
  return {
    serverSession: value.serverSession,
    at: number(value.at),
    failures: Math.max(0, Math.min(100, Math.floor(number(value.failures)))),
    tries: Array.isArray(value.tries) ? value.tries.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).slice(-PLAIN_RESTARTS_A_DAY) : [],
    build: typeof value.build === 'string' ? value.build.slice(0, 100) : '',
    stock: typeof value.stock === 'string' ? value.stock.slice(0, 5000) : ''
  }
}

/**
 * Whether the standard Inbox `serverSession` may be moved onto the build now: once for each one, at
 * most three times a day, and not for six hours after a move that failed unless the build in use or
 * the Plannotator installed here changed since.
 */
export function plainRestartAllowed(memory: PlainRestart | null | undefined, serverSession: string, now: number, build: string, stock: string): boolean {
  if (!memory) return true
  if (memory.serverSession === serverSession) return false
  if (memory.tries.filter((at) => now - at < DAY_MS).length >= PLAIN_RESTARTS_A_DAY) return false
  if (memory.failures > 0 && now - memory.at < PLAIN_RESTART_WAIT_MS && memory.build === build && memory.stock === stock) return false
  return true
}

/**
 * The Plannotator installed here, as its file's place, size and time: it changes when Plannotator
 * updates itself or a person installs another release. Found as the updater finds it. Null: none.
 */
export async function stockSignature(env: Env, home: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const explicit = (env.PLANNOTATOR_BIN ?? '').trim()
  const names = platform === 'win32' ? ['plannotator.exe', 'plannotator.cmd', 'plannotator'] : ['plannotator']
  const folders = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin')]
  if (platform === 'win32' && env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'plannotator'))
  const candidates = [...(explicit ? [explicit] : []), ...folders.flatMap((folder) => names.map((name) => join(folder, name)))]
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return `${candidate}:${info.size}:${Math.floor(info.mtimeMs)}`
    } catch {
      // Not there: the next place.
    }
  }
  return null
}

export function storePaths(sharedDir: string) {
  const store = join(sharedDir, 'plannotator')
  return {
    store,
    versions: join(store, 'versions'),
    current: join(store, 'current.json'),
    check: join(store, 'check.json'),
    lock: join(store, 'update.lock'),
    config: join(sharedDir, 'bridge', 'config.json'),
    state: join(sharedDir, 'bridge', 'upgrade-state.json'),
    heartbeat: join(sharedDir, 'state.json'),
    updater: join(sharedDir, 'plannotator-update.mjs'),
    installed: join(sharedDir, 'plannotator-update.json')
  }
}

const binaryName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'plannotator.exe' : 'plannotator')

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** A small file that belongs to this user, nobody else can read, and is not a link; null when missing. Throws otherwise. */
async function readPrivate(path: string, maximum: number): Promise<string | null> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile()) throw new Error('not a regular file')
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) throw new Error('readable by other users')
  }
  if (info.size > maximum) throw new Error('too large')
  return readFile(path, 'utf8')
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

/**
 * The build `current.json` names, when it can be trusted: a private record, a binary exactly at
 * `versions/<version>-<build>/plannotator[.exe]` inside the store (no links), owned by this user,
 * not writable by others, with the recorded size. Null otherwise: stock Plannotator then.
 */
export async function readCurrentBuild(sharedDir: string, platform: NodeJS.Platform = process.platform): Promise<BuildRecord | null> {
  const paths = storePaths(sharedDir)
  let record: unknown
  try {
    const raw = await readPrivate(paths.current, 4096)
    if (raw === null) return null
    record = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(record) || record.v !== 1) return null
  const { version, build, path, sha256, size, installedAt } = record
  if (typeof version !== 'string' || !VERSION.test(version) || typeof build !== 'string' || !BUILD.test(build)) return null
  if (typeof sha256 !== 'string' || !SHA256.test(sha256) || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BINARY) return null
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
  const expected = join(paths.versions, `${version}-${build}`, binaryName(platform))
  const key = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  if (key(resolve(path)) !== key(resolve(expected))) return null
  try {
    for (const part of [dirname(path), path]) if ((await lstat(part)).isSymbolicLink()) return null
    if (!inside(await realpath(paths.versions), await realpath(path))) return null
    const info = await stat(path)
    if (!info.isFile() || info.size !== size) return null
    if (process.platform !== 'win32') {
      const uid = process.getuid?.()
      if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0) return null
    }
  } catch {
    return null
  }
  const names = (value: unknown): string[] | null =>
    Array.isArray(value) && value.length <= 24 && value.every((item) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(item)) ? [...new Set(value as string[])] : null
  const features = names(record.features)
  const omitted = names(record.omitted)
  return {
    v: 1,
    version,
    build,
    path,
    sha256,
    size,
    installedAt: typeof installedAt === 'number' ? installedAt : 0,
    ...(features ? { features } : {}),
    ...(omitted ? { omitted } : {})
  }
}

/**
 * The release waited for, when it is newer than the build in use (or none is in use): the updater's
 * `waiting.json`, or a "not published yet" failure an older updater wrote in the state file.
 */
export async function readWaiting(sharedDir: string, inUse: string | null, state: UpgradeState | null): Promise<Waiting | null> {
  let waiting: Waiting | null = null
  try {
    const raw = await readPrivate(join(storePaths(sharedDir).store, 'waiting.json'), 4096)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (isRecord(value) && value.v === 1 && typeof value.version === 'string' && VERSION.test(value.version)) {
      waiting = { version: value.version, since: typeof value.since === 'number' && Number.isFinite(value.since) ? value.since : 0 }
    }
  } catch {
    // Unreadable: not waiting.
  }
  const older = state && state.phase === 'failed' ? NOT_PUBLISHED.exec(state.detail ?? '') : null
  if (!waiting && older && state && state.version === older[1]) waiting = { version: older[1]!, since: state.at * 1000 }
  return waiting && (inUse === null || newerVersion(waiting.version, inUse)) ? waiting : null
}

function newerVersion(a: string, b: string): boolean {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

export async function readUpgradeState(sharedDir: string): Promise<UpgradeState | null> {
  try {
    const raw = await readPrivate(storePaths(sharedDir).state, 16 * 1024)
    const state: unknown = raw === null ? null : JSON.parse(raw)
    const phases: UpgradePhase[] = ['queued', 'resolving', 'building', 'staged', 'activating', 'ready', 'failed', 'rolled-back']
    if (!isRecord(state) || !phases.includes(state.phase as UpgradePhase)) return null
    return {
      phase: state.phase as UpgradePhase,
      version: typeof state.version === 'string' && VERSION.test(state.version) ? state.version : null,
      at: typeof state.at === 'number' && Number.isFinite(state.at) ? state.at : 0,
      detail: typeof state.detail === 'string' ? state.detail.slice(0, 500) : null
    }
  } catch {
    return null
  }
}

/** Whether Orca's bridge config is in place and private (Plannotator's Orca mode refuses it otherwise). */
export async function orcaConfigReady(sharedDir: string): Promise<boolean> {
  try {
    return (await readPrivate(storePaths(sharedDir).config, 64 * 1024)) !== null
  } catch {
    return false
  }
}

/** The worker's heartbeat says it delivers replies for `dataDir`, as the launcher reads it. */
export async function deliveringFor(sharedDir: string, dataDir: string, now: number = Date.now()): Promise<boolean> {
  try {
    const beat: unknown = JSON.parse(await readFile(storePaths(sharedDir).heartbeat, 'utf8'))
    if (!isRecord(beat) || beat.delivering !== true || typeof beat.at !== 'number' || Math.abs(now - beat.at) > HEARTBEAT_FRESH_MS) return false
    if (typeof beat.dataDir !== 'string' || beat.dataDir === '') return false
    const same = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path))
    return (await same(beat.dataDir)) === (await same(dataDir))
  } catch {
    return false
  }
}

async function lockHeld(sharedDir: string, now: number): Promise<boolean> {
  try {
    const held: unknown = JSON.parse(await readFile(storePaths(sharedDir).lock, 'utf8'))
    if (!isRecord(held) || typeof held.pid !== 'number' || typeof held.at !== 'number' || now - held.at > LOCK_STALE_MS) return false
    try {
      process.kill(held.pid, 0)
      return true
    } catch (error) {
      return isRecord(error) && error.code === 'EPERM'
    }
  } catch {
    return false
  }
}

function readRef(value: unknown): BuildRef | null {
  if (!isRecord(value)) return null
  return typeof value.version === 'string' && VERSION.test(value.version) && typeof value.build === 'string' && BUILD.test(value.build)
    ? { version: value.version, build: value.build }
    : null
}

/** The plugin's own version, from its manifest (the updater refuses builds that need a newer plugin). */
export async function pluginVersion(manifest: string = fileURLToPath(new URL('../orca-plugin.json', import.meta.url))): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    return isRecord(parsed) && typeof parsed.version === 'string' && VERSION.test(parsed.version) ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Puts the updater, its launcher and the plugin's version next to the MCP launcher. Safe to repeat.
 * Returns the `upgradeCommand` for Orca's bridge config.
 */
export async function installUpdater(
  dir: string,
  options: { source?: string; pluginVersion: string | null; node?: string; platform?: NodeJS.Platform; env?: Env }
): Promise<string[]> {
  const platform = options.platform ?? process.platform
  const source = options.source ?? fileURLToPath(new URL('../bin/plannotator-update.mjs', import.meta.url))
  const paths = storePaths(dir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = `${paths.updater}.${process.pid}.tmp`
  await copyFile(source, temporary)
  await rename(temporary, paths.updater)
  const launcher = join(dir, updaterLauncherName(platform))
  const script = updaterLauncherScript(dir, options.node ?? process.execPath, platform)
  if ((await readFile(launcher, 'utf8').catch(() => null)) !== script) {
    const next = `${launcher}.${process.pid}.tmp`
    await writeFile(next, script, { mode: 0o755 })
    await rename(next, launcher)
  }
  if (platform !== 'win32') await chmod(launcher, 0o755)
  await writePrivateJson(paths.installed, { v: 1, pluginVersion: options.pluginVersion })
  return upgradeCommand(dir, platform, options.env)
}

export type BuildStoreDeps = {
  sharedDir: string
  env: Env
  home: string
  /** Runs the installed updater with these arguments. Default: Orca's own binary in Node mode. */
  runUpdater?: (args: string[]) => Promise<UpdaterResult>
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string) => void
  /** Runs a program and resolves its stdout; for `plannotator inbox --open`. */
  exec?: (binary: string, args: string[], env: Env) => Promise<{ ok: boolean; stdout: string; error: string | null }>
  platform?: NodeJS.Platform
}

/** What the Inbox server for a data folder is: Plannotator in Orca mode, stock, or not running. */
export type ServerMode = 'orca' | 'stock' | 'stopped'

export class BuildStore {
  private readonly deps: BuildStoreDeps
  /** The look in flight (two callers share it). It may start no updater at all. */
  private running: Promise<BuildStatus> | null = null
  /** Updater runs this store started that have not ended. */
  private updaterRuns = 0
  /** The move of a standard Inbox onto the build in flight, if any. */
  private following: Promise<{ ran: boolean; result?: UpdaterResult }> | null = null
  /** While that move's updater runs (it holds the update lock, so it is not "updating"). */
  private moving = 0

  constructor(deps: BuildStoreDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async readCheck(): Promise<Check> {
    try {
      const raw = await readPrivate(storePaths(this.deps.sharedDir).check, 16 * 1024)
      const parsed: unknown = raw === null ? null : JSON.parse(raw)
      if (!isRecord(parsed) || parsed.v !== 1) return NO_CHECK
      const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      return {
        v: 1,
        lastAttempt: number(parsed.lastAttempt),
        failures: Math.max(0, Math.min(100, Math.floor(number(parsed.failures)))),
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError.slice(0, 500) : null,
        lastErrorAt: number(parsed.lastErrorAt),
        latestKnown: readRef(parsed.latestKnown),
        stock: typeof parsed.stock === 'string' ? parsed.stock.slice(0, 5000) : null,
        plainRestart: readPlainRestart(parsed.plainRestart)
      }
    } catch {
      return NO_CHECK
    }
  }

  private writeCheck(check: Check): Promise<void> {
    return writePrivateJson(storePaths(this.deps.sharedDir).check, check)
  }

  async status(): Promise<BuildStatus> {
    const [record, check, state, held] = await Promise.all([
      readCurrentBuild(this.deps.sharedDir, this.deps.platform),
      this.readCheck(),
      readUpgradeState(this.deps.sharedDir),
      lockHeld(this.deps.sharedDir, this.now())
    ])
    const waiting = await readWaiting(this.deps.sharedDir, record?.version ?? null, state)
    // The most recent failure, whoever ran the updater (the worker, or the Inbox's Update button). A release
    // with no Orca build yet is a wait, not a failure, even as an older updater wrote it.
    const notPublished = !!state && NOT_PUBLISHED.test(state.detail ?? '')
    const stateFailedAt = state && (state.phase === 'failed' || state.phase === 'rolled-back') && !notPublished ? state.at * 1000 : 0
    const stateOkAt = state && state.phase === 'ready' ? state.at * 1000 : 0
    let lastError: string | null = null
    if (stateFailedAt > 0 && stateFailedAt >= check.lastErrorAt) lastError = state!.detail
    else if (check.lastError && check.lastErrorAt > stateOkAt) lastError = check.lastError
    return {
      mode: record ? 'orca-build' : 'stock',
      version: record?.version ?? null,
      build: record?.build ?? null,
      latestKnown: check.latestKnown,
      lastError,
      // An updater at work, here or elsewhere: a look that starts none is not an update. The lock the
      // move of a standard Inbox holds is not one either.
      updating: this.updaterRuns > 0 || (held && this.moving === 0),
      phase: state?.phase ?? null,
      detail: state?.detail ?? null,
      waiting,
      reduced: reducedOf(record),
      moving: this.moving > 0
    }
  }

  /**
   * Runs the updater when it is due: at most every 6 hours, longer after failures in a row. The
   * updater follows the Plannotator installed here: it installs the Orca build of that release, and
   * never asks Plannotator to update. While that release has no Orca build in use yet, or the build
   * in use is a reduced one, it is due every 15 minutes instead (unless the last run failed). It is
   * due at once when the Plannotator installed here changed (it updated itself, or a person did).
   * `force` (a person pressed "Check now") skips the wait.
   */
  ensure(options: { force?: boolean } = {}): Promise<BuildStatus> {
    if (this.running) {
      // A forced look must really look: wait for the run in flight (it may be a routine one that
      // found nothing due), then run again.
      const inFlight = this.running
      return options.force ? inFlight.then(() => this.ensure(options), () => this.ensure(options)) : inFlight
    }
    // The move of a standard Inbox writes check.json too: one after the other.
    if (this.following) return this.following.then(() => this.ensure(options), () => this.ensure(options))
    const work = (async (): Promise<BuildStatus> => {
      const check = await this.readCheck()
      const now = this.now()
      const [record, state] = await Promise.all([readCurrentBuild(this.deps.sharedDir, this.deps.platform), readUpgradeState(this.deps.sharedDir)])
      const waiting = await readWaiting(this.deps.sharedDir, record?.version ?? null, state)
      const soon = (waiting !== null || reducedOf(record) !== null) && check.failures === 0
      const wait = soon ? WAITING_CHECK_MS : CHECK_EVERY_MS * 2 ** Math.min(check.failures, MAX_BACKOFF_STEPS)
      const signature = () => stockSignature(this.deps.env, this.deps.home, this.deps.platform).then((found) => found ?? '', () => '')
      const seen = await signature()
      // The first look only notes it; a change after that (a first install, too) is followed at once.
      const moved = check.stock !== null && seen !== check.stock
      if ((!options.force && !moved && now - check.lastAttempt < wait) || (await lockHeld(this.deps.sharedDir, now))) {
        if (check.stock === null) await this.writeCheck({ ...check, stock: seen }).catch(() => undefined)
        return this.status()
      }
      // Saved first, so a crash part way is not retried at once.
      await this.writeCheck({ ...check, lastAttempt: now, stock: seen }).catch(() => undefined)
      // A person asked: a build that could not be used is fetched again now, not after its wait.
      const result = await this.runUpdater(options.force ? ['--again'] : [])
      const latestKnown = readRef(result.latest) ?? check.latestKnown
      // The signature saved is the one from before the run: a Plannotator that changed while the run
      // worked was not what the run followed, so the next look sees the change and follows it at once.
      const stock = seen
      if (result.busy) {
        await this.writeCheck({ ...check, lastAttempt: now, latestKnown, stock: seen }).catch(() => undefined)
      } else if (result.ok) {
        if (result.restarted) this.deps.log?.(`Orca build of Plannotator: ${result.detail}`)
        await this.writeCheck({ v: 1, lastAttempt: now, failures: 0, lastError: null, lastErrorAt: 0, latestKnown, stock, plainRestart: check.plainRestart }).catch(() => undefined)
      } else {
        this.deps.log?.(`Orca build of Plannotator: ${result.detail}`)
        await this.writeCheck({ v: 1, lastAttempt: now, failures: check.failures + 1, lastError: result.detail, lastErrorAt: this.now(), latestKnown, stock, plainRestart: check.plainRestart }).catch(() => undefined)
      }
      return this.status()
    })()
    this.running = work
    void work.finally(() => {
      if (this.running === work) this.running = null
    }).catch(() => undefined)
    return work
  }

  /** One updater run, counted while it lasts (as "updating" unless `counted` is false); a run that cannot start is an outcome, not an error. */
  private async runUpdater(args: string[], counted = true): Promise<UpdaterResult> {
    if (counted) this.updaterRuns += 1
    try {
      return await (this.deps.runUpdater ?? this.defaultRunner())(args)
    } catch (error) {
      return { ok: false, detail: `The updater could not run (${errorText(error)}).` }
    } finally {
      if (counted) this.updaterRuns -= 1
    }
  }

  private defaultRunner(): (args: string[]) => Promise<UpdaterResult> {
    const { sharedDir, env } = this.deps
    return (args) =>
      new Promise((done) => {
        const childEnv: Env = { ...env, ELECTRON_RUN_AS_NODE: '1', ORCA_PLANNOTATOR_HOME: sharedDir }
        execFile(
          process.execPath,
          [storePaths(sharedDir).updater, ...args],
          { env: childEnv as NodeJS.ProcessEnv, timeout: UPDATER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, cwd: sharedDir },
          (error, stdout) => {
            const last = String(stdout ?? '').trim().split('\n').pop() ?? ''
            try {
              const parsed: unknown = JSON.parse(last)
              if (isRecord(parsed) && typeof parsed.ok === 'boolean' && typeof parsed.detail === 'string') return done(parsed as UpdaterResult)
            } catch {
              // Fall through.
            }
            done({ ok: false, detail: `The updater did not finish (${error ? errorText(error) : 'no answer'}).` })
          }
        )
      })
  }

  /** Whether the Inbox of `dataDir` runs, and in Orca mode (`GET /api/inbox/orca` answers with mode "orca"). */
  async serverMode(dataDir: string): Promise<ServerMode> {
    return (await this.server(dataDir)).mode
  }

  /**
   * The same, and for a standard Inbox which run of it this is: its `serverSession` (a new one on each
   * start), or its pid when it does not say.
   */
  private async server(dataDir: string): Promise<{ mode: ServerMode; session: string | null }> {
    const fetchImpl = this.deps.fetch ?? fetch
    const stopped = { mode: 'stopped' as const, session: null }
    let port: number
    try {
      const registry = await new InboxClient(dataDir, { fetch: fetchImpl }).registry()
      if (!registry) return stopped
      port = registry.port
    } catch {
      return stopped
    }
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/inbox/orca`, { redirect: 'error', signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } })
      const body: unknown = await response.json().catch(() => null)
      if (response.ok && isRecord(body) && body.mode === 'orca') return { mode: 'orca', session: null }
      const health = await fetchImpl(`http://127.0.0.1:${port}/api/inbox/health`, { redirect: 'error', signal: AbortSignal.timeout(4000) })
      if (!health.ok) {
        await health.body?.cancel().catch(() => undefined)
        return stopped
      }
      const said: unknown = await health.json().catch(() => null)
      const session = isRecord(said) && typeof said.serverSession === 'string' && said.serverSession !== '' ? said.serverSession.slice(0, 200) : null
      const pid = isRecord(said) && Number.isInteger(said.pid) ? String(said.pid) : null
      return { mode: 'stock', session: session ?? (pid !== null ? `pid:${pid}` : null) }
    } catch {
      return stopped
    }
  }

  /**
   * A standard Inbox while the Orca build of its release is in use (after a login, Plannotator's own
   * login item or a plain `plannotator` command starts the Inbox on standard Plannotator): restarts it
   * on the build, as Restart in the panel does, through the updater's `--restart --if-plain`, which
   * checks again that it is a running standard Inbox of the build's own release and that the
   * Plannotator installed here is not newer. Only while the build is in use and ready, nothing is
   * updating or waiting for a newer release, Orca's bridge config is in place and the worker delivers
   * for `dataDir`. Once for each standard Inbox, at most three times a day, and after a failure not
   * again for six hours unless the build or the Plannotator installed here changed. `onStart`: the
   * restart begins (the status says `moving` until it ends). `ran`: the updater was asked.
   */
  followRunning(dataDir: string, onStart?: () => void): Promise<{ ran: boolean; result?: UpdaterResult }> {
    if (this.following) return this.following
    // A look in flight writes check.json too; the next look comes soon enough.
    if (this.running) return Promise.resolve({ ran: false })
    const work = (async (): Promise<{ ran: boolean; result?: UpdaterResult }> => {
      const { sharedDir } = this.deps
      const none = { ran: false }
      const now = this.now()
      const [record, state] = await Promise.all([readCurrentBuild(sharedDir, this.deps.platform), readUpgradeState(sharedDir)])
      if (!record || this.updaterRuns > 0 || (await lockHeld(sharedDir, now))) return none
      if ((await readWaiting(sharedDir, record.version, state)) !== null) return none
      if (!(await orcaConfigReady(sharedDir)) || !(await deliveringFor(sharedDir, dataDir, now))) return none
      const running = await this.server(dataDir)
      if (running.mode !== 'stock' || running.session === null) return none
      const check = await this.readCheck()
      const build = `${record.version}-${record.build}`
      const stock = (await stockSignature(this.deps.env, this.deps.home, this.deps.platform).catch(() => null)) ?? ''
      if (!plainRestartAllowed(check.plainRestart, running.session, now, build, stock)) return none
      let result: UpdaterResult
      this.moving += 1
      try {
        onStart?.()
        result = await this.runUpdater(['--restart', '--if-plain'], false)
      } finally {
        this.moving -= 1
      }
      // Another run held the lock: nothing was tried.
      if (result.busy) return none
      const memory = check.plainRestart ?? null
      const tried = result.restarted === true || !result.ok
      const recent = (memory?.tries ?? []).filter((at) => now - at < DAY_MS)
      const plainRestart: PlainRestart = {
        serverSession: running.session,
        at: tried ? now : (memory?.at ?? 0),
        failures: !result.ok ? (memory?.failures ?? 0) + 1 : result.restarted ? 0 : (memory?.failures ?? 0),
        tries: (tried ? [...recent, now] : recent).slice(-PLAIN_RESTARTS_A_DAY),
        build,
        stock
      }
      this.deps.log?.(result.detail)
      const latest = await this.readCheck()
      const next: Check = { ...latest, plainRestart }
      if (!result.ok) {
        // Shown in the panel, with Restart, until a look or a move ends well.
        next.lastError = result.detail
        next.lastErrorAt = this.now()
      } else if (result.restarted && latest.failures === 0 && latest.lastError !== null) {
        // The failure shown was a move like this one, not an update.
        next.lastError = null
        next.lastErrorAt = 0
      }
      await this.writeCheck(next).catch(() => undefined)
      return { ran: true, result }
    })()
    this.following = work
    void work.finally(() => {
      if (this.following === work) this.following = null
    }).catch(() => undefined)
    return work
  }

  /**
   * Which Plannotator to start for `dataDir`, as the launcher chooses: a `PLANNOTATOR_BIN` the
   * person set wins; then the Orca build in Orca mode, when one is installed, Orca's bridge config is
   * in place and the worker delivers for this Inbox; then stock `plannotator`.
   */
  async plannotatorFor(dataDir: string): Promise<{ binary: string | null; env: Env; orca: boolean }> {
    const { env, home, sharedDir } = this.deps
    const childEnv: Env = { ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    const explicit = (env.PLANNOTATOR_BIN ?? '').trim()
    if (explicit) return { binary: explicit, env: childEnv, orca: false }
    const record = await readCurrentBuild(sharedDir, this.deps.platform)
    if (record && (await orcaConfigReady(sharedDir)) && (await deliveringFor(sharedDir, dataDir, this.now()))) {
      return { binary: record.path, env: { ...childEnv, PLANNOTATOR_ORCA_MODE: '1', PLANNOTATOR_ORCA_CONFIG: storePaths(sharedDir).config }, orca: true }
    }
    return { binary: findOnPath('plannotator', env, home), env: childEnv, orca: false }
  }

  /**
   * "Open Inbox": Plannotator's own `inbox --open` (starts the Inbox in the background when needed,
   * opens the window, returns at once), on the Plannotator `plannotatorFor` picks.
   */
  async openInbox(dataDir: string, explicitDataDir: boolean): Promise<ActionResult> {
    const { binary, env, orca } = await this.plannotatorFor(dataDir)
    if (!binary) return { ok: false, message: 'Plannotator was not found. Install it from https://plannotator.ai, then run `plannotator inbox` once.' }
    if (explicitDataDir || orca) env.PLANNOTATOR_DATA_DIR = dataDir
    const result = await (this.deps.exec ?? ((file, args, childEnv) => execText(file, args, childEnv, this.deps.home)))(binary, ['inbox', '--open'], env)
    const address = /https?:\/\/\S+/.exec(result.stdout)?.[0]
    if (!result.ok && !address) return { ok: false, message: `Plannotator could not open the Inbox (${result.error ?? 'no answer'}).` }
    return { ok: true, message: address ? `The Inbox is open at ${address}` : 'The Inbox is open in your browser.' }
  }

  /**
   * "Restart the Inbox on the Orca build": stops the Inbox of the served data folder (stock or not)
   * and starts the Orca build in Orca mode; when that does not answer within 30 seconds, the Inbox
   * is started on stock Plannotator again. Plannotator's own `inbox restart` does the stop and start,
   * so nothing saved is lost and agents reconnect by themselves.
   */
  async restartInbox(): Promise<ActionResult> {
    const result = await this.runUpdater(['--restart'])
    return { ok: result.ok, message: result.detail }
  }
}

function execText(binary: string, args: string[], env: Env, cwd: string): Promise<{ ok: boolean; stdout: string; error: string | null }> {
  return new Promise((done) => {
    // `inbox --open` on the run that turns the Inbox on also connects agents, for up to 25 s after its URL.
    execFile(binary, args, { env: env as NodeJS.ProcessEnv, timeout: 30_000, windowsHide: true, cwd }, (error, stdout) =>
      done({ ok: !error, stdout: String(stdout ?? ''), error: error ? errorText(error) : null })
    )
  })
}
