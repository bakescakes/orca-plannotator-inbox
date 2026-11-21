// "Open in Orca" links. A small web listener on 127.0.0.1 turns a signed link into the native
// Orca chat it names: it brings that exact chat tab forward when this Orca allows it, and
// otherwise opens the chat's workspace through the public CLI.
//
// Two owner-only files in the shared folder (`~/.orca-plannotator-inbox`) are the contract with
// whoever writes links (the MCP launcher):
//   link-key          64 lowercase hex characters and a newline: the HMAC key. Never rotated.
//   navigation.json   {"v":1,"port":…,"pid":…,"at":…}: where the listener is. Renewed every 15 s
//                     while it listens, removed when it stops cleanly.
//
// Safety rules:
// - Only this computer: the listener binds 127.0.0.1 and refuses any other Host header.
// - A link only opens something when a person clicked it: a GET opens the chat only for a real
//   user navigation (Sec-Fetch-User ?1, Sec-Fetch-Mode navigate). Link previews, prefetches and
//   scripts get a page with one button, which POSTs back to the same origin.
// - A link names a chat, never a path or a tab instance, and is checked against Orca's current
//   list of chats on every click. A chat that is gone or listed twice is not opened, and nothing
//   is created or replaced in its place. A chat in a folder workspace (a bot's home is one) opens
//   only by bringing that chat itself forward: Orca does not open a folder workspace by its id.
// - Nothing from the request is written into a page unescaped, and signed links are never logged.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import { constants, existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NavigationTarget } from './orca-cli'
import { canonicalSession, errorText, isRecord } from './util'

export const LINK_KEY_FILE = 'link-key'
export const NAVIGATION_FILE = 'navigation.json'
export const NAVIGATION_HEARTBEAT_MS = 15_000
const LOOPBACK = '127.0.0.1'
const TAB_PREFIX = 'structured-agent-session-'
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
const KEY_HEX = /^[0-9a-f]{64}$/
const TOKEN = /^([A-Za-z0-9_-]{1,600})\.([0-9a-f]{64})$/
const MAX_TOKEN = 700
const MAX_FORM_BYTES = 4096
/** How long one click may take in all: two inventory reads, the helper, and the activation. */
const OPEN_DEADLINE_MS = 45_000
const HELPER_TIMEOUT_MS = 15_000
const HELPER_MAX_OUTPUT = 64 * 1024
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

// ---------------------------------------------------------------------------------------------
// Links

export type LinkClaim = { session: string; tab: string }

function keyBytes(keyHex: string): Buffer {
  if (!KEY_HEX.test(keyHex)) throw new Error('invalid link key')
  return Buffer.from(keyHex, 'hex')
}

function signature(keyHex: string, payload: string): string {
  return createHmac('sha256', keyBytes(keyHex)).update(payload, 'utf8').digest('hex')
}

/** The token for one chat: `base64url(claim JSON) + "." + hex HMAC-SHA256 of that text`. */
export function signToken(keyHex: string, session: string): string {
  const bare = canonicalSession(session)
  if (!bare) throw new Error('invalid session id')
  const payload = Buffer.from(JSON.stringify({ v: 1, session: bare, tab: TAB_PREFIX + bare }), 'utf8').toString('base64url')
  return `${payload}.${signature(keyHex, payload)}`
}

/** `http://127.0.0.1:<port>/open/<token>` for one native chat (an `orca_session_id:` prefix is dropped). */
export function signLink(keyHex: string, port: number, session: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
  return `http://${LOOPBACK}:${port}/open/${signToken(keyHex, session)}`
}

/** The chat a token names, or null when it is malformed, tampered with, or signed with another key. */
export function parseToken(keyHex: string, token: string): LinkClaim | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, payload, given] = match as unknown as [string, string, string]
  let wanted: string
  try {
    wanted = signature(keyHex, payload)
  } catch {
    return null
  }
  if (!timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(wanted, 'utf8'))) return null
  const raw = Buffer.from(payload, 'base64url')
  // Only the one canonical spelling of the payload counts.
  if (raw.toString('base64url') !== payload) return null
  let claim: unknown
  try {
    claim = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(claim)) return null
  const keys = Object.keys(claim).sort()
  if (keys.length !== 3 || keys[0] !== 'session' || keys[1] !== 'tab' || keys[2] !== 'v') return null
  if (claim.v !== 1 || typeof claim.session !== 'string' || !SESSION.test(claim.session)) return null
  if (claim.tab !== TAB_PREFIX + claim.session) return null
  return { session: claim.session, tab: claim.tab }
}

// ---------------------------------------------------------------------------------------------
// The shared files

export class NavigationKeyError extends Error {}

type FileChecks = { uid: number | null }

async function readKey(file: string, checks: FileChecks): Promise<string> {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile()) throw new NavigationKeyError(`${file} is not a regular file`)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== info.ino) throw new NavigationKeyError(`${file} changed while it was read`)
    if (checks.uid !== null && stat.uid !== checks.uid) throw new NavigationKeyError(`${file} belongs to someone else`)
    if (checks.uid !== null && (stat.mode & 0o077) !== 0) throw new NavigationKeyError(`${file} can be read by others`)
    if (stat.size > 128) throw new NavigationKeyError(`${file} is not a link key`)
    const text = await handle.readFile('utf8')
    const hex = text.endsWith('\n') ? text.slice(0, -1) : text
    if (!KEY_HEX.test(hex)) throw new NavigationKeyError(`${file} is not a link key`)
    return hex
  } finally {
    await handle.close()
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/**
 * The link key, created the first time. An existing key is used only when it is a regular file
 * of this user that nobody else can read; anything else is refused, not replaced, so links that
 * were handed out keep their meaning and a planted key is never trusted.
 */
export async function loadLinkKey(
  dir: string,
  options: { randomBytes?: (size: number) => Buffer; uid?: number | null } = {}
): Promise<string> {
  const checks: FileChecks = { uid: options.uid !== undefined ? options.uid : currentUid() }
  const file = join(dir, LINK_KEY_FILE)
  try {
    return await readKey(file, checks)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const fresh = (options.randomBytes ?? cryptoRandomBytes)(32)
  if (fresh.length !== 32) throw new NavigationKeyError('not enough random bytes for a link key')
  try {
    await writeFile(file, `${fresh.toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another worker made it first: use theirs, after the same checks.
    if (errorCode(error) !== 'EEXIST') throw error
  }
  return readKey(file, checks)
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

export type NavigationRecord = { v: 1; port: number; pid: number; at: number }

/** The port the last listener used, so links already handed out keep working; null when unknown. */
export async function readRecordedPort(dir: string): Promise<number | null> {
  try {
    const file = join(dir, NAVIGATION_FILE)
    const info = await lstat(file)
    if (!info.isFile() || info.size > 4096) return null
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!isRecord(parsed) || parsed.v !== 1) return null
    const port = parsed.port
    return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

async function writeRecord(dir: string, record: NavigationRecord): Promise<void> {
  const file = join(dir, NAVIGATION_FILE)
  const temporary = `${file}.${record.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

/** Removes navigation.json only while it still describes this listener (another profile may have taken over). */
async function removeRecord(dir: string, pid: number, port: number): Promise<void> {
  const file = join(dir, NAVIGATION_FILE)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (isRecord(parsed) && parsed.pid === pid && parsed.port === port) await rm(file, { force: true })
  } catch {
    // Nothing to remove.
  }
}

// ---------------------------------------------------------------------------------------------
// Opening a chat

/** What a click needs from Orca's CLI. `OrcaCli` has all three. */
export type NavigationCli = {
  navigationTargets(): Promise<NavigationTarget[]>
  activateWorktree(selector: string): Promise<string | null>
  launchInfo?(): { command: string[]; env: Record<string, string | undefined> }
}

export type RevealResult = { ok: true; sessionId: string; workspaceId: string } | { ok: false; reason: string }
/** Brings one exact chat tab forward. Must never throw for an Orca that cannot; returns ok:false. */
export type Reveal = (session: string, cli: NavigationCli) => Promise<RevealResult>

export type OpenOutcome =
  | 'chat' // the exact chat tab is in front
  | 'workspace' // its workspace is in front; Orca could not bring the chat tab forward
  | 'gone' // Orca does not list this chat
  | 'unsupported' // listed twice, or in a folder workspace Orca could not bring the chat forward in: not opened
  | 'bot' // a bot's chat Orca could not bring forward: not opened
  | 'moved' // the chat changed workspace (or vanished) while it was being opened
  | 'failed' // Orca could not be asked

type OpenDeps = {
  cli: () => NavigationCli | null | Promise<NavigationCli | null>
  reveal: Reveal
  log: (message: string) => void
}

function only(targets: NavigationTarget[], session: string): NavigationTarget[] {
  return targets.filter((target) => target.session === session)
}

/**
 * Opens one chat by its native session id: checks Orca's current list, brings the exact tab
 * forward when it can, then re-reads the list and opens the workspace through the public CLI
 * only when the chat is still exactly where it was.
 */
export async function openChat(session: string, deps: OpenDeps): Promise<OpenOutcome> {
  return (await openChatTarget(session, deps)).outcome
}

/** `openChat`, with the chat as Orca listed it (null when it was not listed once), for the page that says what happened. */
export async function openChatTarget(session: string, deps: OpenDeps): Promise<{ outcome: OpenOutcome; target: NavigationTarget | null }> {
  const outcome = (value: OpenOutcome, target: NavigationTarget | null = null) => ({ outcome: value, target })
  let cli: NavigationCli | null
  try {
    cli = await deps.cli()
  } catch (error) {
    deps.log(`navigation: Orca's CLI is not available (${errorText(error)})`)
    return outcome('failed')
  }
  if (!cli) {
    deps.log('navigation: Orca’s CLI was not found')
    return outcome('failed')
  }
  let found: NavigationTarget[]
  try {
    found = only(await cli.navigationTargets(), session)
  } catch (error) {
    deps.log(`navigation: could not list Orca's chats (${errorText(error)})`)
    return outcome('failed')
  }
  if (found.length === 0) return outcome('gone')
  if (found.length > 1) {
    deps.log('navigation: a chat is listed more than once, so it was not opened')
    return outcome('unsupported')
  }
  const target = found[0]!
  const which = target.bot ? `the bot ${target.bot}’s chat` : 'the chat'

  let revealed = false
  try {
    const result = await deps.reveal(session, cli)
    if (result.ok && result.sessionId === session && result.workspaceId === target.worktreeId) revealed = true
    else deps.log(`navigation: Orca could not bring ${which} forward (${result.ok ? 'it answered for another chat or workspace' : result.reason})`)
  } catch (error) {
    deps.log(`navigation: Orca could not bring ${which} forward (${errorText(error)})`)
  }

  // A folder workspace, a bot's home among them, opens only with the chat itself: `worktree
  // activate` refuses it. Orca checked the chat and its workspace as it brought it forward.
  if (target.folder) {
    if (revealed) return outcome('chat', target)
    deps.log(`navigation: ${which} is in a folder workspace, which Orca opens from a link only by bringing the chat forward, so nothing was opened`)
    return outcome(target.bot ? 'bot' : 'unsupported', target)
  }

  // Look again before opening anything, so a chat that moved or was replaced is never guessed at.
  let again: NavigationTarget[]
  try {
    again = only(await cli.navigationTargets(), session)
  } catch (error) {
    deps.log(`navigation: could not list Orca's chats again (${errorText(error)})`)
    return outcome(revealed ? 'chat' : 'failed', target)
  }
  if (again.length !== 1 || again[0]!.worktreeId !== target.worktreeId || again[0]!.folder) {
    deps.log('navigation: the chat changed while it was being opened; nothing else was opened')
    return outcome(again.length === 0 && !revealed ? 'gone' : 'moved', target)
  }
  try {
    const opened = await cli.activateWorktree(target.selector)
    if (opened !== null && opened !== target.worktreeId) {
      deps.log('navigation: Orca opened a different workspace than the chat’s')
      return outcome(revealed ? 'chat' : 'failed', target)
    }
  } catch (error) {
    deps.log(`navigation: Orca could not open the workspace (${errorText(error)})`)
    return outcome(revealed ? 'chat' : 'failed', target)
  }
  return outcome(revealed ? 'chat' : 'workspace', target)
}

// ---------------------------------------------------------------------------------------------
// The reveal helper

/** The Orca executable and app folder that belong to the CLI the plugin located. */
export type RevealRuntime = { executable: string; outDir: string }

/**
 * Finds Orca's executable and its unpacked app code (`app.asar.unpacked/out`) from the CLI
 * command, without assuming where Orca is installed:
 * - `[<orca executable>, <…>/out/cli/index.js]`: the CLI inside this Orca, as the worker runs it.
 * - `[<…>/Contents/Resources/bin/orca]` (macOS), `[<install>\resources\bin\orca.exe]` (Windows),
 *   `[<install>/resources/bin/orca-ide]` (Linux): the launcher Orca ships, possibly via a symlink.
 * Anything else, or a layout whose files are missing, is null: reveal is then not attempted.
 */
export function revealRuntime(
  command: string[],
  options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean; realpath?: (path: string) => string } = {}
): RevealRuntime | null {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const real = options.realpath ?? ((path: string) => realpathSync(path))
  const path = platform === 'win32' ? win32 : posix
  let executable: string | null = null
  let outDir: string | null = null
  try {
    if (command.length === 2) {
      const cli = command[1]!
      const cliDir = path.dirname(cli)
      if (path.basename(cli) === 'index.js' && path.basename(cliDir) === 'cli') {
        executable = command[0]!
        outDir = path.dirname(cliDir)
      }
    } else if (command.length === 1) {
      const launcher = real(command[0]!)
      const bin = path.dirname(launcher)
      const resources = path.dirname(bin)
      const install = path.dirname(resources)
      // Only Orca's own launcher layout: <app>/Contents/Resources/bin (macOS), <install>/resources/bin.
      const shaped =
        path.basename(bin).toLowerCase() === 'bin' &&
        (platform === 'darwin'
          ? path.basename(resources) === 'Resources' && path.basename(install) === 'Contents'
          : path.basename(resources).toLowerCase() === 'resources')
      if (shaped) {
        outDir = path.join(resources, 'app.asar.unpacked', 'out')
        const candidates =
          platform === 'darwin'
            ? [path.join(install, 'MacOS', 'Orca')]
            : platform === 'win32'
              ? [path.join(install, 'Orca.exe')]
              : ['orca-ide', 'orca', 'Orca'].map((name) => path.join(install, name))
        executable = candidates.find((candidate) => exists(candidate)) ?? null
      }
    }
  } catch {
    return null
  }
  if (!executable || !outDir || !path.isAbsolute(executable) || !path.isAbsolute(outDir)) return null
  if (!exists(executable) || !exists(path.join(outDir, 'cli')) || !exists(path.join(outDir, 'shared'))) return null
  return { executable, outDir }
}

export type HelperRun = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; input: string; timeoutMs: number }
) => Promise<{ code: number; stdout: string }>

/** Runs the helper with a byte cap on its answer and a hard time limit. */
export const runHelper: HelperRun = (file, args, options) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { env: options.env as NodeJS.ProcessEnv, cwd: process.platform === 'win32' ? undefined : '/', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let done = false
    const finish = (error: Error | null, code = 1): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ code, stdout })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('the helper took too long'))
    }, options.timeoutMs)
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > HELPER_MAX_OUTPUT) {
        child.kill('SIGKILL')
        finish(new Error('the helper answered too much'))
      }
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(null, typeof code === 'number' ? code : 1))
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(options.input)
  })

export const REVEAL_HELPER = fileURLToPath(new URL('../bin/reveal.cjs', import.meta.url))

/** How a helper is started: which runner, how its Orca is found, and how long it may take. */
export type HelperOptions = {
  run?: HelperRun
  runtime?: (command: string[]) => RevealRuntime | null
  timeoutMs?: number
}

/**
 * What one helper run answered. `started` is false when the helper never ran (no CLI layout, no
 * launch info), so nothing can have reached Orca. `ok: true` carries the helper's `result`; an
 * ok:false keeps the helper's own `error` text and its `code` when it gave one.
 */
export type HelperAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string; started: boolean; code: string | null }

/**
 * Runs one helper script (`bin/reveal.cjs`, `bin/session.cjs`) with the same Orca executable and
 * profile as the CLI, in Node mode, with `input` as JSON on stdin and the Orca app folder as its
 * one argument. Every failure, from a missing file to a timeout, is an ok:false answer.
 */
export async function callHelper(helper: string, input: unknown, cli: Pick<NavigationCli, 'launchInfo'>, options: HelperOptions = {}): Promise<HelperAnswer> {
  const launch = cli.launchInfo?.()
  if (!launch) return { ok: false, reason: 'this CLI cannot start the helper', started: false, code: null }
  const runtime = (options.runtime ?? revealRuntime)(launch.command)
  if (!runtime) return { ok: false, reason: 'unsupported Orca layout', started: false, code: null }
  const env: Record<string, string | undefined> = { ...launch.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  let answer: { code: number; stdout: string }
  try {
    answer = await (options.run ?? runHelper)(runtime.executable, [helper, runtime.outDir], {
      env,
      input: JSON.stringify(input),
      timeoutMs: options.timeoutMs ?? HELPER_TIMEOUT_MS
    })
  } catch (error) {
    return { ok: false, reason: errorText(error), started: true, code: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.stdout)
  } catch {
    return { ok: false, reason: `the helper gave no readable answer (exit ${answer.code})`, started: true, code: null }
  }
  if (!isRecord(parsed) || parsed.ok !== true || answer.code !== 0) {
    const why = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : `exit ${answer.code}`
    const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code.slice(0, 40) : null
    return { ok: false, reason: why, started: true, code }
  }
  return { ok: true, result: isRecord(parsed.result) ? parsed.result : {} }
}

/**
 * The default `Reveal`: runs `bin/reveal.cjs` with the same Orca executable and profile as the
 * CLI, in Node mode. Every failure, from a missing file to a timeout, is an ok:false answer.
 */
export function helperReveal(options: HelperOptions & { helper?: string } = {}): Reveal {
  return async (session, cli) => {
    if (!SESSION.test(session)) return { ok: false, reason: 'invalid session id' }
    const answer = await callHelper(options.helper ?? REVEAL_HELPER, { sessionId: session }, cli, options)
    if (!answer.ok) return { ok: false, reason: answer.reason }
    const result = answer.result
    if (typeof result.sessionId !== 'string' || typeof result.workspaceId !== 'string') {
      return { ok: false, reason: 'the helper answered in an unknown shape' }
    }
    return { ok: true, sessionId: result.sessionId, workspaceId: result.workspaceId }
  }
}

// ---------------------------------------------------------------------------------------------
// Pages

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

const STYLE =
  'body{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}' +
  'button{font:inherit;padding:.6rem 1.1rem;cursor:pointer}p{opacity:.8}'

function page(title: string, body: string): string {
  return `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style><h1>${escapeHtml(title)}</h1>${body}</html>`
}

function message(title: string, text: string): string {
  return page(title, `<p>${escapeHtml(text)}</p>`)
}

/** The page for a bot's chat Orca could not bring forward: names the bot and the chat, and where to find it. */
export function botNotOpenedText(target: Pick<NavigationTarget, 'bot' | 'title'>): string {
  const bot = target.bot ?? 'the bot'
  const chat = target.title && target.title !== target.bot ? `“${target.title}”, a chat of the bot ${bot},` : `this chat of the bot ${bot}`
  return `Orca could not bring ${chat} forward from this link, so nothing was opened. Open ${bot} in Orca to find it.`
}

/** What a preview or a plain fetch of a link gets: one button that opens the chat. */
export function confirmPage(token: string): string {
  return page(
    'Open in Orca',
    `<p>Open this chat in Orca on this computer.</p><form method=post action=/open><input type=hidden name=token value="${escapeHtml(token)}"><button type=submit autofocus>Open the chat</button></form>`
  )
}

const OUTCOMES: Record<OpenOutcome | 'busy' | 'slow', [number, string, string]> = {
  chat: [200, 'Opened in Orca', 'Opened the chat. You can close this tab.'],
  workspace: [200, 'Opened in Orca', 'Opened the workspace; Orca could not bring the chat itself forward.'],
  gone: [404, 'Chat not open', 'This chat is no longer open in Orca.'],
  unsupported: [409, 'Not opened', 'Orca cannot open this chat from a link.'],
  bot: [409, 'Not opened', 'Orca could not bring this bot’s chat forward from a link.'],
  moved: [409, 'Not opened', 'This chat changed while Orca was opening it, so nothing else was opened.'],
  failed: [503, 'Not opened', 'Orca could not be reached to open this chat. Try again in a moment.'],
  busy: [409, 'Not opened', 'Orca is already opening a chat. Try again in a moment.'],
  slow: [504, 'Still opening', 'Orca is taking a long time to open this chat.']
}

// ---------------------------------------------------------------------------------------------
// The listener

export type NavigationDeps = {
  /** The folder shared with the MCP launcher (`~/.orca-plannotator-inbox`). */
  sharedDir: string
  /** Orca's CLI as it is right now (settings can change it); null when it was not found. */
  cli: () => NavigationCli | null | Promise<NavigationCli | null>
  log: (message: string) => void
  /** Brings a chat tab forward; defaults to `helperReveal()`. */
  reveal?: Reveal
  now?: () => number
  randomBytes?: (size: number) => Buffer
  pid?: number
  /** The owner every shared file must have; defaults to this process's user (null skips the check). */
  uid?: number | null
  heartbeatMs?: number
  /** A port to try first instead of the recorded one (tests). */
  port?: number
}

export type Navigation = {
  port: number
  /** The signed link for one native chat. */
  link(session: string): string
  /** Stops listening and removes navigation.json if it is still this listener's. */
  stop(): Promise<void>
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening)
      reject(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('no port'))
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen({ host: LOOPBACK, port, exclusive: true })
  })
}

function readForm(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const declared = Number(request.headers['content-length'] ?? 'NaN')
    if (!Number.isInteger(declared) || declared <= 0 || declared > MAX_FORM_BYTES) {
      request.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        request.destroy()
        resolve(null)
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(size === declared ? Buffer.concat(chunks).toString('utf8') : null))
    request.on('error', () => resolve(null))
  })
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Starts the listener: loads (or creates) the link key, listens on the recorded port when it is
 * free and on a new one otherwise, and keeps navigation.json current. Call `stop()` when the
 * worker stops.
 */
export async function startNavigation(deps: NavigationDeps): Promise<Navigation> {
  const now = deps.now ?? Date.now
  const pid = deps.pid ?? process.pid
  const reveal = deps.reveal ?? helperReveal()
  await mkdir(deps.sharedDir, { recursive: true, mode: 0o700 })
  const key = await loadLinkKey(deps.sharedDir, { randomBytes: deps.randomBytes, uid: deps.uid })

  let port = 0
  let hosts = new Set<string>()
  let origins = new Set<string>()
  let opening = false

  const send = (response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void => {
    response.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      Connection: 'close'
    })
    response.end(body)
  }
  const answer = (response: ServerResponse, outcome: keyof typeof OUTCOMES): void => {
    const [status, title, text] = OUTCOMES[outcome]
    send(response, status, message(title, text))
  }

  const openClaim = async (response: ServerResponse, claim: LinkClaim): Promise<void> => {
    if (opening) return answer(response, 'busy')
    opening = true
    const work = openChatTarget(claim.session, { cli: deps.cli, reveal, log: deps.log })
    // The lock is held until Orca has really finished, even when the page gives up waiting.
    void work.finally(() => (opening = false)).catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    const opened = await Promise.race([
      work.catch(() => ({ outcome: 'failed' as const, target: null })),
      new Promise<{ outcome: 'slow'; target: null }>((resolve) => (timer = setTimeout(() => resolve({ outcome: 'slow', target: null }), OPEN_DEADLINE_MS)))
    ])
    clearTimeout(timer)
    if (opened.outcome === 'bot' && opened.target) {
      const [status, title] = OUTCOMES.bot
      return send(response, status, message(title, botNotOpenedText(opened.target)))
    }
    answer(response, opened.outcome)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = header(request, 'host')
    if (!host || !hosts.has(host)) return send(response, 403, message('Not allowed', 'This link works only on this computer.'))
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/health') {
      return send(response, 200, '{"ok":true}', 'application/json')
    }
    if (request.method === 'GET' && url.startsWith('/open/')) {
      const token = url.slice('/open/'.length)
      const claim = parseToken(key, token)
      if (!claim) return send(response, 404, message('Link not valid', 'This link is not valid on this computer.'))
      // Only a person's click opens anything; previews, prefetches and scripts get the button.
      if (header(request, 'sec-fetch-user') === '?1' && header(request, 'sec-fetch-mode') === 'navigate') {
        return openClaim(response, claim)
      }
      return send(response, 200, confirmPage(token))
    }
    if (request.method === 'POST' && url === '/open') {
      const origin = header(request, 'origin')
      if (!origin || !origins.has(origin) || origin !== `http://${host}`) {
        request.resume()
        return send(response, 403, message('Not allowed', 'Open this link in your browser.'))
      }
      if ((header(request, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        request.resume()
        return send(response, 415, message('Not opened', 'This request is not a link click.'))
      }
      const form = await readForm(request)
      const fields = form === null ? null : new URLSearchParams(form)
      const tokens = fields?.getAll('token') ?? []
      const claim = tokens.length === 1 && [...fields!.keys()].length === 1 ? parseToken(key, tokens[0]!) : null
      if (!claim) return send(response, 400, message('Link not valid', 'This link is not valid on this computer.'))
      return openClaim(response, claim)
    }
    request.resume()
    if (url === '/health' || url === '/open' || url.startsWith('/open/')) return send(response, 405, message('Not allowed', 'Not allowed.'))
    return send(response, 404, message('Not found', 'Nothing is here.'))
  }

  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 8_192 }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      deps.log(`navigation: request failed (${errorText(error)})`)
      if (!response.headersSent) send(response, 500, message('Not opened', 'Something went wrong.'))
      else response.destroy()
    })
  })
  server.maxHeadersCount = 64
  // A click can wait on Orca for up to OPEN_DEADLINE_MS; an idle connection cannot linger longer.
  server.setTimeout(OPEN_DEADLINE_MS + 5_000)

  const preferred = deps.port ?? (await readRecordedPort(deps.sharedDir))
  try {
    port = await listen(server, preferred ?? 0)
  } catch (error) {
    if (!preferred) throw error
    deps.log(`navigation: port ${preferred} is taken, so links made before this start will not open (${errorCode(error) ?? errorText(error)})`)
    port = await listen(server, 0)
  }
  hosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`])
  origins = new Set([...hosts].map((value) => `http://${value}`))

  let warned = false
  let stopping = false
  // One write at a time, and none once stopping: a renewal still in flight must not put the record
  // back after `stop()` removed it.
  let writing: Promise<void> = Promise.resolve()
  const heartbeat = (): Promise<void> => {
    writing = writing.then(async () => {
      if (stopping) return
      try {
        await writeRecord(deps.sharedDir, { v: 1, port, pid, at: now() })
        warned = false
      } catch (error) {
        if (!warned) deps.log(`navigation: could not write ${NAVIGATION_FILE} (${errorText(error)})`)
        warned = true
      }
    })
    return writing
  }
  try {
    await writeRecord(deps.sharedDir, { v: 1, port, pid, at: now() })
  } catch (error) {
    server.close()
    throw error
  }
  const timer = setInterval(() => void heartbeat(), deps.heartbeatMs ?? NAVIGATION_HEARTBEAT_MS)
  timer.unref()

  let stopped: Promise<void> | null = null
  return {
    port,
    link: (session) => signLink(key, port, session),
    stop: () =>
      (stopped ??= (async () => {
        clearInterval(timer)
        stopping = true
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
        await writing
        await removeRecord(deps.sharedDir, pid, port)
      })())
  }
}
