// The bridge a modified Plannotator Inbox (Orca mode) calls to start, stop, resume and open Orca
// chats and to show Orca's connection health. A small JSON listener on 127.0.0.1 that the worker
// runs, and three owner-only files in `<sharedDir>/bridge/` that are its contract with the Orca
// build of Plannotator (the shapes are fixed):
//
//   link-key         exactly 32 random bytes. Created once, never rotated. Every request carries
//                    `Authorization: Bearer <lowercase hex of those bytes>`.
//   navigation.json  {"version":1,"port":…,"pid":…,"at":…}: where the listener is. Rewritten every
//                    15 s while it listens, removed when it stops cleanly.
//   config.json      {"v":1,"canonicalDataDir":…,"dataDirs":[…],"stateDir":…,"mcpCommand":[…],
//                    "upgradeCommand":[…],"upgradeStateFile":…,"upgradeBackoffMs":21600000}:
//                    which Inbox is Orca's, and the launcher and updater Plannotator may name.
//
// Routes (all need the bearer key; bodies are JSON):
//   GET  /api/health                     Orca connection health for the Inbox's status line
//   GET  /api/lifecycle/catalog          workspaces, providers, owned chats, Orca's projects
//   GET  /api/lifecycle/status[?session=<id>]  which launches own a chat
//   POST /api/lifecycle/start|stop|resume|open
// A request that cannot be carried out answers `{"ok":false,"text":…}` (status 200 for a POST, so
// Plannotator shows the words; 409 for a GET).
//
// Only this computer: the listener binds 127.0.0.1, refuses any Host but its own, sends no CORS
// headers and closes every connection after one answer. Bodies, answers and time are bounded.
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveProjects, type EngineStatus } from './engine'
import type { InboxDeps } from './inbox'
import type { KeyValue } from './ledger'
import { Lifecycle, LifecycleError, inboxSource, type DeliveryState, type LifecycleCli, type NativeRun, type OwnedSession, type SourceReader } from './lifecycle'
import type { Reveal } from './navigation'
import { canonicalSession, errorText, isRecord, type Json } from './util'

export const BRIDGE_DIR = 'bridge'
export const BRIDGE_KEY_FILE = 'link-key'
export const BRIDGE_NAVIGATION_FILE = 'navigation.json'
export const BRIDGE_CONFIG_FILE = 'config.json'
export const BRIDGE_HEARTBEAT_MS = 15_000
export const UPGRADE_BACKOFF_MS = 21_600_000
const LOOPBACK = '127.0.0.1'
const MAX_BODY = 64 * 1024
const MAX_ANSWER = 1024 * 1024
const MAX_IN_FLIGHT = 16
/** Plannotator gives a GET 5 s and a POST 45 s; answer a little before it gives up. */
const READ_DEADLINE_MS = 4_500
const ACTION_DEADLINE_MS = 42_000
/** Health is "fresh" while the engine looked this recently. */
const FRESH_MS = 45_000

/** A bridge file that exists but cannot be trusted. It is refused, never replaced. */
export class BridgeFileError extends Error {}

// ---------------------------------------------------------------------------------------------
// Files

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** `<sharedDir>/bridge`, created owner-only. A link, a file, or another user's folder is refused. */
export async function ensureBridgeDir(sharedDir: string, uid: number | null = currentUid()): Promise<string> {
  await mkdir(sharedDir, { recursive: true, mode: 0o700 })
  const dir = join(sharedDir, BRIDGE_DIR)
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeFileError(`${dir} is not a folder`)
  if (uid !== null && info.uid !== uid) throw new BridgeFileError(`${dir} belongs to someone else`)
  if (uid !== null && (info.mode & 0o077) !== 0) await chmod(dir, 0o700)
  return dir
}

async function readPrivate(file: string, uid: number | null, maxBytes: number): Promise<Buffer> {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile()) throw new BridgeFileError(`${file} is not a regular file`)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== info.ino) throw new BridgeFileError(`${file} changed while it was read`)
    if (uid !== null && stat.uid !== uid) throw new BridgeFileError(`${file} belongs to someone else`)
    if (uid !== null && (stat.mode & 0o077) !== 0) throw new BridgeFileError(`${file} can be read by others`)
    if (stat.size > maxBytes) throw new BridgeFileError(`${file} is too large`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * The bridge key: exactly 32 raw bytes, created the first time. An existing key is used only when
 * it is a regular file of this user that nobody else can read and exactly 32 bytes long; anything
 * else is refused, not replaced.
 */
export async function loadBridgeKey(dir: string, options: { randomBytes?: (size: number) => Buffer; uid?: number | null } = {}): Promise<Buffer> {
  const uid = options.uid !== undefined ? options.uid : currentUid()
  const file = join(dir, BRIDGE_KEY_FILE)
  const checked = async (): Promise<Buffer> => {
    const key = await readPrivate(file, uid, 64)
    if (key.length !== 32) throw new BridgeFileError(`${file} is not a bridge key`)
    return key
  }
  try {
    return await checked()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const fresh = (options.randomBytes ?? cryptoRandomBytes)(32)
  if (fresh.length !== 32) throw new BridgeFileError('not enough random bytes for a bridge key')
  try {
    await writeFile(file, fresh, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another worker made it first: use theirs, after the same checks.
    if (errorCode(error) !== 'EEXIST') throw error
  }
  return checked()
}

let temporaries = 0
/** Replaces a file in one step, owner-only. */
async function writePrivate(file: string, text: string): Promise<void> {
  temporaries += 1
  const temporary = `${file}.${process.pid}.${temporaries}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export type BridgeRecord = { version: 1; port: number; pid: number; at: number }

/** The port the last listener used, so the Inbox finds this one at the same place; null when unknown. */
async function recordedPort(dir: string): Promise<number | null> {
  try {
    const file = join(dir, BRIDGE_NAVIGATION_FILE)
    const info = await lstat(file)
    if (!info.isFile() || info.size > 4096) return null
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1) return null
    const port = parsed.port
    return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

/** Removes navigation.json only while it still names this listener (another profile may have taken over). */
async function removeRecord(dir: string, pid: number, port: number): Promise<void> {
  const file = join(dir, BRIDGE_NAVIGATION_FILE)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (isRecord(parsed) && parsed.pid === pid && parsed.port === port) await rm(file, { force: true })
  } catch {
    // Nothing to remove.
  }
}

/** What the worker tells the bridge, and what config.json is written from. */
export type BridgeConfig = {
  /** Orca's Inbox: the Plannotator data folder the plugin serves. Absolute. */
  dataDir: string
  /** The MCP launcher agents run (`<sharedDir>/inbox-mcp`). Absolute. */
  launcher: string
  /**
   * The command Plannotator may start for an update of the Orca build; null when there is none.
   * Its first item is the program, as an absolute path (a launcher file, or `cmd.exe` on Windows).
   */
  upgradeCommand: readonly string[] | null
  /** The "Only these projects" folders, as the setting lists them (absolute); empty for every project. */
  projects: readonly string[]
}

/** Where config.json is: the file `PLANNOTATOR_ORCA_CONFIG` names. */
export function bridgeConfigPath(sharedDir: string): string {
  return join(sharedDir, BRIDGE_DIR, BRIDGE_CONFIG_FILE)
}

/** config.json, exactly as Plannotator reads it. */
export function bridgeConfigFile(sharedDir: string, config: BridgeConfig): Record<string, Json> {
  const stateDir = join(sharedDir, BRIDGE_DIR)
  const dataDir = resolve(config.dataDir)
  return {
    v: 1,
    canonicalDataDir: dataDir,
    dataDirs: [dataDir],
    stateDir,
    mcpCommand: [config.launcher],
    upgradeCommand: config.upgradeCommand ? [...config.upgradeCommand] : [],
    upgradeStateFile: join(stateDir, 'upgrade-state.json'),
    upgradeBackoffMs: UPGRADE_BACKOFF_MS
  }
}

function checkConfig(config: BridgeConfig): void {
  if (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw new BridgeFileError('the Inbox data folder must be an absolute path')
  if (typeof config.launcher !== 'string' || !isAbsolute(config.launcher)) throw new BridgeFileError('the launcher must be an absolute path')
  const upgrade = config.upgradeCommand
  if (upgrade !== null) {
    if (!Array.isArray(upgrade) || upgrade.length === 0 || upgrade.length > 8 || upgrade.some((item) => typeof item !== 'string' || item === '')) {
      throw new BridgeFileError('the update command must be a short list of words')
    }
    if (!isAbsolute(upgrade[0]!)) throw new BridgeFileError('the update command must start with an absolute path')
  }
  for (const value of [config.dataDir, config.launcher, ...(upgrade ?? [])]) {
    if (value.includes('\0')) throw new BridgeFileError('a path holds a NUL character')
  }
}

// ---------------------------------------------------------------------------------------------
// Health

export type BridgeHealth = {
  version: 1
  level: 'ready' | 'waiting' | 'error'
  fresh: boolean
  connected: number
  conversations: number
  delivered: number
  waiting: number
  blocked: number
}

/**
 * The Inbox's view of Orca, from the engine's status: an error
 * while a reply is blocked; waiting while the engine has not looked lately, is not ready, or a
 * chat is not listening (or none is); ready otherwise.
 */
export function bridgeHealth(status: EngineStatus, now: number): BridgeHealth {
  const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)
  const fresh = Number.isFinite(status.at) && now - status.at >= 0 && now - status.at < FRESH_MS
  const conversations = status.sessions.length
  const connected = status.sessions.filter((session) => session.listening).length
  const blocked = count(status.counts.blocked)
  const level: BridgeHealth['level'] =
    blocked > 0 ? 'error' : !fresh || status.phase !== 'ready' || conversations === 0 || connected < conversations ? 'waiting' : 'ready'
  return { version: 1, level, fresh, connected, conversations, delivered: count(status.counts.delivered), waiting: count(status.counts.inFlight), blocked }
}

// ---------------------------------------------------------------------------------------------
// The listener

export type BridgeDeps = {
  /** The folder shared with the MCP launcher (`~/.orca-plannotator-inbox`). */
  sharedDir: string
  /** What config.json is first written from; `configure` changes it. */
  config: BridgeConfig
  /** Orca's CLI as it is right now; null when it was not found. */
  cli: () => LifecycleCli | null | Promise<LifecycleCli | null>
  /** The plugin's own Orca storage; the ownership record is kept there. */
  store: KeyValue
  /** The engine's latest status (`Engine.status()`). */
  status: () => EngineStatus
  /** How far delivery to one chat has got (for Resume with `deliver: true`). */
  deliveryState: DeliveryState
  /** Told about each chat a launch owns, when it is created or resumed. */
  register?: (owned: OwnedSession) => void | Promise<void>
  log: (message: string) => void
  // Test seams.
  now?: () => number
  randomBytes?: (size: number) => Buffer
  /** A port to try first instead of the recorded one. */
  port?: number
  heartbeatMs?: number
  pid?: number
  /** The owner every bridge file must have; defaults to this process's user (null skips the check). */
  uid?: number | null
  /** Runs bin/session.cjs operations; defaults to the real helper. */
  native?: NativeRun
  /** Brings a chat tab forward; defaults to bin/reveal.cjs. */
  reveal?: Reveal
  /** How the Inbox is read for launch sources (a stand-in fetch and registry in tests). */
  inbox?: InboxDeps
  randomUUID?: () => string
}

export type Bridge = {
  port: number
  /** Start, Stop, Resume and Open, and the ownership record, for the worker's own use. */
  lifecycle: Lifecycle
  /** Applies new settings: rewrites config.json when it changes. */
  configure(next: BridgeConfig): Promise<void>
  /** Stops listening and removes navigation.json if it is still this listener's. */
  stop(): Promise<void>
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening)
      reject(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      const address = server.address()
      if (address && typeof address === 'object') resolvePort(address.port)
      else reject(new Error('no port'))
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen({ host: LOOPBACK, port, exclusive: true })
  })
}

function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolveBody) => {
    const declared = Number(request.headers['content-length'] ?? 'NaN')
    if (!Number.isInteger(declared) || declared <= 0 || declared > MAX_BODY) {
      request.resume()
      resolveBody(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        resolveBody(null)
      } else chunks.push(chunk)
    })
    request.on('end', () => resolveBody(size === declared ? Buffer.concat(chunks) : null))
    request.on('error', () => resolveBody(null))
  })
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

class Deadline extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Deadline()), ms)))
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * Starts the bridge: loads (or creates) the key, writes config.json, listens on the recorded port
 * when it is free and on a new one otherwise, and keeps navigation.json current.
 */
export async function startBridge(deps: BridgeDeps): Promise<Bridge> {
  const now = deps.now ?? Date.now
  const pid = deps.pid ?? process.pid
  const uid = deps.uid !== undefined ? deps.uid : currentUid()
  checkConfig(deps.config)
  const dir = await ensureBridgeDir(deps.sharedDir, uid)
  const key = await loadBridgeKey(dir, { randomBytes: deps.randomBytes, uid })
  const expected = digest(`Bearer ${key.toString('hex')}`)

  let config = deps.config
  let projects: readonly string[] | null = await resolveProjects(config.projects)
  let source: SourceReader = inboxSource(resolve(config.dataDir), deps.inbox)
  let writtenConfig = ''
  // One file write at a time, and none once stopping: a renewal still in flight must not put the
  // record back after `stop()` removed it.
  let writing: Promise<void> = Promise.resolve()
  let stopping = false
  const queue = (task: () => Promise<void>): Promise<void> => {
    const next = writing.then(async () => {
      if (!stopping) await task()
    })
    writing = next.catch(() => undefined)
    return next
  }
  const writeConfig = (): Promise<void> =>
    queue(async () => {
      const text = `${JSON.stringify(bridgeConfigFile(deps.sharedDir, config), null, 2)}\n`
      if (text === writtenConfig) return
      await writePrivate(join(dir, BRIDGE_CONFIG_FILE), text)
      writtenConfig = text
    })
  await writeConfig()

  const lifecycle = new Lifecycle({
    store: deps.store,
    cli: deps.cli,
    source: () => source,
    projects: () => projects,
    deliveryState: deps.deliveryState,
    register: deps.register,
    native: deps.native,
    reveal: deps.reveal,
    log: deps.log,
    now,
    randomUUID: deps.randomUUID
  })

  let port = 0
  let hosts = new Set<string>()
  let inFlight = 0

  const send = (response: ServerResponse, status: number, value: unknown): void => {
    let body = JSON.stringify(value)
    if (Buffer.byteLength(body) > MAX_ANSWER) {
      status = 500
      body = JSON.stringify({ ok: false, text: 'The answer was too large to send.' })
    }
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close'
    })
    response.end(body)
  }

  const authorized = (request: IncomingMessage): boolean => {
    const given = request.headers.authorization
    // Compared as digests, so neither the length nor the bytes of the key leak through timing.
    return typeof given === 'string' && timingSafeEqual(digest(given), expected)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = request.headers.host
    if (typeof host !== 'string' || !hosts.has(host)) {
      request.resume()
      return send(response, 403, { ok: false, text: 'This bridge answers only on this computer.' })
    }
    if (!authorized(request)) {
      request.resume()
      return send(response, 401, { ok: false, text: 'Not allowed.' })
    }
    const raw = request.url ?? ''
    if (!raw.startsWith('/') || raw.length > 2048) {
      request.resume()
      return send(response, 404, { ok: false, text: 'Nothing is here.' })
    }
    const url = new URL(raw, `http://${LOOPBACK}`)
    const path = url.pathname
    const method = request.method ?? ''
    const reads = new Set(['/api/health', '/api/lifecycle/catalog', '/api/lifecycle/status'])
    const actions = new Set(['/api/lifecycle/start', '/api/lifecycle/stop', '/api/lifecycle/resume', '/api/lifecycle/open'])
    if (!reads.has(path) && !actions.has(path)) {
      request.resume()
      return send(response, 404, { ok: false, text: 'Nothing is here.' })
    }
    if ((reads.has(path) && method !== 'GET') || (actions.has(path) && method !== 'POST')) {
      request.resume()
      return send(response, 405, { ok: false, text: 'Not allowed.' })
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      request.resume()
      return send(response, 503, { ok: false, text: 'The bridge is busy. Try again in a moment.' })
    }
    inFlight += 1
    try {
      if (method === 'GET') {
        request.resume()
        const params = [...url.searchParams.entries()]
        let work: Promise<Record<string, Json> | BridgeHealth>
        if (path === '/api/health') {
          if (params.length > 0) return send(response, 400, { ok: false, text: 'Unexpected query.' })
          work = Promise.resolve(bridgeHealth(deps.status(), now()))
        } else if (path === '/api/lifecycle/catalog') {
          if (params.length > 0) return send(response, 400, { ok: false, text: 'Unexpected query.' })
          work = lifecycle.handle('catalog', {})
        } else {
          const session = params.length === 1 && params[0]![0] === 'session' ? params[0]![1] : null
          if (params.length > 1 || (params.length === 1 && (session === null || canonicalSession(session) !== session))) {
            return send(response, 400, { ok: false, text: 'One exact chat is required.' })
          }
          work = lifecycle.handle('status', session === null ? {} : { session })
        }
        try {
          return send(response, 200, await within(work, READ_DEADLINE_MS))
        } catch (error) {
          if (error instanceof Deadline) return send(response, 503, { ok: false, text: 'Orca is slow to answer. Try again in a moment.' })
          if (error instanceof LifecycleError) return send(response, 409, { ok: false, text: error.message })
          throw error
        }
      }
      const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (type !== 'application/json') {
        request.resume()
        return send(response, 415, { ok: false, text: 'Send JSON.' })
      }
      if (url.search !== '') {
        request.resume()
        return send(response, 400, { ok: false, text: 'Unexpected query.' })
      }
      const bytes = await readBody(request)
      let body: unknown = null
      try {
        body = bytes === null ? null : JSON.parse(bytes.toString('utf8'))
      } catch {
        body = null
      }
      if (!isRecord(body)) return send(response, 400, { ok: false, text: 'The request is not a JSON object within 64 KiB.' })
      try {
        return send(response, 200, await within(lifecycle.handle(path.slice('/api/lifecycle/'.length), body), ACTION_DEADLINE_MS))
      } catch (error) {
        if (error instanceof Deadline) {
          // The work goes on and is recorded; asking again replays it instead of repeating it.
          return send(response, 200, { ok: false, blocked: true, text: 'Orca is still working on this. Try again in a moment for the result; nothing is done twice.' })
        }
        if (error instanceof LifecycleError) return send(response, 200, { ok: false, text: error.message })
        throw error
      }
    } finally {
      inFlight -= 1
    }
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 8_192 }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      deps.log(`bridge: request failed (${errorText(error)})`)
      if (!response.headersSent) send(response, 500, { ok: false, text: 'The bridge failed; it is not known whether anything changed.' })
      else response.destroy()
    })
  })
  server.maxHeadersCount = 64
  server.setTimeout(ACTION_DEADLINE_MS + 8_000)

  const preferred = deps.port ?? (await recordedPort(dir))
  try {
    port = await listen(server, preferred ?? 0)
  } catch (error) {
    if (!preferred) throw error
    deps.log(`bridge: port ${preferred} is taken, so it listens on another (${errorCode(error) ?? errorText(error)})`)
    port = await listen(server, 0)
  }
  hosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`])

  const record = (): Promise<void> =>
    writePrivate(join(dir, BRIDGE_NAVIGATION_FILE), `${JSON.stringify({ version: 1, port, pid, at: now() } satisfies BridgeRecord)}\n`)
  try {
    await record()
  } catch (error) {
    server.close()
    throw error
  }
  let warned = false
  const heartbeat = (): Promise<void> =>
    queue(async () => {
      try {
        await record()
        warned = false
      } catch (error) {
        if (!warned) deps.log(`bridge: could not write ${BRIDGE_NAVIGATION_FILE} (${errorText(error)})`)
        warned = true
      }
    })
  const timer = setInterval(() => void heartbeat(), Math.min(deps.heartbeatMs ?? BRIDGE_HEARTBEAT_MS, BRIDGE_HEARTBEAT_MS))
  timer.unref()

  let stopped: Promise<void> | null = null
  return {
    port,
    lifecycle,
    configure: async (next) => {
      checkConfig(next)
      const nextProjects = await resolveProjects(next.projects)
      if (resolve(next.dataDir) !== resolve(config.dataDir)) source = inboxSource(resolve(next.dataDir), deps.inbox)
      config = next
      projects = nextProjects
      await writeConfig()
    },
    stop: () =>
      (stopped ??= (async () => {
        clearInterval(timer)
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose())
          server.closeAllConnections()
        })
        // Wait for any write already started, then stop all further ones.
        await queue(async () => undefined).catch(() => undefined)
        stopping = true
        await writing
        await removeRecord(dir, pid, port)
      })())
  }
}
