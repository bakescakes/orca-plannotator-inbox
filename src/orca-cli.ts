// Orca's own CLI is the only way to reach a native chat: the plugin host API has no mail method.
// Everything read from it is checked here, so an Orca update that changes a shape stops delivery
// (replies stay saved in the Inbox) instead of sending something wrong.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { canonicalSession, isRecord } from './util'

const MAX_OUTPUT = 32 * 1024 * 1024
/** How Orca names a native chat's pane: `structured-agent-session-<session id>:<uuid>`. */
const CHAT_PANE = /^structured-agent-session-([A-Za-z0-9_-]{1,160}):[0-9a-fA-F-]{36}$/
const MAIL_ADDRESS = /^(?:run|dispatch):[A-Za-z0-9_-]{1,160}$/

export type ExecResult = { code: number; stdout: string }
export type Exec = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number }
) => Promise<ExecResult>

/** One native Orca chat on this machine. */
export type NativeSession = {
  session: string
  busy: boolean
  provider: string | null
  title: string | null
  workspacePath: string | null
}
export type MailMessage = Record<string, unknown> & { id: string; to_handle: string }
export type SendInput = { session: string; subject: string; body: string; payload: string }

/** Orca answered with an error. `notSent` is true only when Orca itself says nothing was sent. */
export class OrcaRefused extends Error {
  readonly code: string
  readonly notSent: boolean
  constructor(code: string, notSent: boolean) {
    super(`Orca refused: ${code}`)
    this.code = code
    this.notSent = notSent
  }
}
/** The CLI could not be started at all, so nothing was sent. */
export class OrcaNotRun extends Error {}
/** The CLI ran but its answer is not one this plugin understands. */
export class OrcaContractError extends Error {}

export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolvePromise, reject) => {
    try {
      execFile(
        file,
        args,
        { env: options.env as NodeJS.ProcessEnv, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT, cwd: '/', windowsHide: true },
        (error, stdout) => {
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new OrcaNotRun('The Orca CLI was not found.'))
          if (error && (error as NodeJS.ErrnoException).code === 'EACCES') return reject(new OrcaNotRun('The Orca CLI cannot be run.'))
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
          resolvePromise({ code, stdout: String(stdout ?? '') })
        }
      )
    } catch {
      // Refused before anything started (Windows does this for a `.cmd`), so nothing was sent.
      reject(new OrcaNotRun('The Orca CLI cannot be run.'))
    }
  })

/**
 * The command that runs Orca's CLI, as argv. The worker is Orca's own binary in Node mode, and
 * the CLI entry sits beside the worker entry, so this needs no PATH and follows Orca wherever
 * it is installed; the bundled `bin/orca` and PATH are fallbacks.
 */
export function locateOrcaCli(setting: string | undefined, env: Record<string, string | undefined>): string[] | null {
  const explicit = (setting ?? '').trim()
  if (explicit) return existsSync(explicit) ? [explicit] : null
  const entry = process.argv[1]
  if (entry) {
    const cli = resolve(dirname(entry), '..', 'cli', 'index.js')
    if (existsSync(cli)) return [process.execPath, cli]
  }
  // Not `orca.cmd`: Windows cannot start it directly, and it refuses to carry message bodies.
  const names = process.platform === 'win32' ? ['orca.exe', 'orca'] : ['orca']
  const resources = (process as { resourcesPath?: string }).resourcesPath
  const folders = [
    ...(resources ? [join(resources, 'bin')] : []),
    resolve(dirname(process.execPath), '..', 'Resources', 'bin'),
    resolve(dirname(process.execPath), 'resources', 'bin'),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean)
  ]
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name)
      if (existsSync(candidate)) return [candidate]
    }
  }
  return null
}

const MARKERS = [join('plugins', 'plugins.lock.json'), 'orca-runtime.json']

/**
 * The Orca profile this plugin is installed in, when it is not the default one. The CLI reads
 * `<profile>/orca-runtime.json` to find the running app, and the worker is told nothing about
 * profiles, so without this a worker in a second profile (a dev build, `orca serve` with its own
 * data folder) would ask the default profile's Orca, or none.
 *
 * Only Orca's exact installed layout counts, `<profile>/plugins/<plugin>/<version>/src/<file>`,
 * and only a profile that belongs to this user and that nobody else can write to: what this
 * returns decides which program receives the person's replies. A development folder, or anything
 * else, gives null and the CLI uses its default.
 */
export function findProfile(pluginFile: string, why: (reason: string) => void = () => undefined): string | null {
  try {
    const file = realpathSync(pluginFile)
    const plugins = dirname(dirname(dirname(dirname(file))))
    if (basename(plugins) !== 'plugins') {
      why(`not installed in an Orca profile (${file})`)
      return null
    }
    const profile = dirname(plugins)
    const mine = typeof process.getuid === 'function' ? process.getuid() : null
    for (const path of [profile, plugins]) {
      const found = lstatSync(path)
      if (!found.isDirectory()) {
        why(`${path} is not a folder`)
        return null
      }
      if (mine !== null && (found.uid !== mine || (found.mode & 0o022) !== 0)) {
        why(`${path} belongs to someone else or can be written by others`)
        return null
      }
    }
    // Something only Orca puts there. `orca-runtime.json` alone would not do: it is written a
    // moment after the app starts, which can be after this worker has.
    if (!MARKERS.some((marker) => existsSync(join(profile, marker)))) {
      why(`${profile} does not look like an Orca profile`)
      return null
    }
    return profile
  } catch (error) {
    why(error instanceof Error ? error.message : String(error))
    return null
  }
}

export function parseInventory(result: unknown): Map<string, NativeSession> {
  if (!isRecord(result) || !Array.isArray(result.worktrees)) {
    throw new OrcaContractError('Orca listed its workspaces in an unknown shape.')
  }
  if (result.truncated === true) throw new OrcaContractError('Orca listed only part of its workspaces.')
  const sessions = new Map<string, NativeSession>()
  const duplicates = new Set<string>()
  for (const tree of result.worktrees) {
    if (!isRecord(tree) || !Array.isArray(tree.agents)) continue
    // Chats on a paired or SSH host are that host's to deliver to.
    if (tree.hostId !== undefined && tree.hostId !== null && tree.hostId !== 'local') continue
    for (const agent of tree.agents) {
      if (!isRecord(agent) || typeof agent.paneKey !== 'string') continue
      const match = CHAT_PANE.exec(agent.paneKey)
      const session = match ? canonicalSession(match[1]) : null
      if (!session) continue
      if (sessions.has(session)) duplicates.add(session)
      const title = [agent.conversationName, agent.taskTitle].find((value) => typeof value === 'string' && value.trim() !== '')
      sessions.set(session, {
        session,
        busy: agent.state === 'working',
        provider: typeof agent.agentType === 'string' ? agent.agentType : null,
        title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
        workspacePath: typeof tree.path === 'string' ? tree.path : null
      })
    }
  }
  // A session listed twice cannot be told apart: deliver to neither.
  for (const session of duplicates) sessions.delete(session)
  return sessions
}

export function parseMail(value: unknown): MailMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.to_handle !== 'string') return null
  return value as MailMessage
}

export class OrcaCli {
  private readonly command: string[]
  private readonly exec: Exec
  private readonly env: Record<string, string | undefined>
  readonly sender: string

  constructor(options: { command: string[]; exec?: Exec; env?: Record<string, string | undefined>; sender?: string; profile?: string | null }) {
    this.command = options.command
    this.exec = options.exec ?? defaultExec
    this.sender = options.sender ?? 'plannotator-inbox'
    // The plugin speaks as itself: never with an agent's identity or a remote selection.
    const env: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (key.startsWith('ORCA_') || key === 'CODEX_THREAD_ID' || key === 'CLAUDE_SESSION_ID' || key === 'NODE_OPTIONS') continue
      env[key] = value
    }
    env.ELECTRON_RUN_AS_NODE = '1'
    // The one Orca setting passed on: which profile's running app the CLI talks to.
    if (options.profile) env.ORCA_USER_DATA_PATH = options.profile
    this.env = env
  }

  async call(args: string[], timeoutMs = 25_000): Promise<Record<string, unknown>> {
    const [file, ...prefix] = this.command
    const { code, stdout } = await this.exec(file!, [...prefix, ...args, '--environment', 'local', '--json'], {
      env: this.env,
      timeoutMs
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new OrcaContractError('Orca returned no readable answer.')
    }
    if (!isRecord(parsed)) throw new OrcaContractError('Orca returned an unknown answer.')
    if (code !== 0 || parsed.ok !== true) {
      const error = isRecord(parsed.error) ? parsed.error : {}
      const data = isRecord(error.data) ? error.data : {}
      throw new OrcaRefused(typeof error.code === 'string' ? error.code : 'command_failed', data.requestSent === false)
    }
    return isRecord(parsed.result) ? parsed.result : {}
  }

  async version(): Promise<string | null> {
    const status = await this.call(['status'], 12_000)
    const runtime = isRecord(status.runtime) ? status.runtime : {}
    if (runtime.reachable !== true) throw new OrcaContractError('Orca is not reachable yet.')
    return typeof runtime.appVersion === 'string' ? runtime.appVersion : null
  }

  async inventory(): Promise<Map<string, NativeSession>> {
    return parseInventory(await this.call(['worktree', 'ps', '--limit', '1000']))
  }

  /** Queues one mail for a chat. `requestId` makes a repeat replay the first result. */
  async send(input: SendInput, requestId: string): Promise<MailMessage> {
    const result = await this.call([
      'orchestration', 'send',
      '--from', this.sender,
      '--to', `orca_session_id:${input.session}`,
      '--type', 'status',
      '--subject', input.subject,
      '--body', input.body,
      '--payload', input.payload,
      '--retry-request', requestId,
      '--full'
    ])
    return this.checkedMessage(result.message, input)
  }

  /** Whether an earlier send landed; null when Orca holds no record of it. */
  async receipt(requestId: string, input: SendInput): Promise<MailMessage | null> {
    const result = await this.call(['orchestration', 'request-show', '--request', requestId, '--full'])
    if (result.state !== 'completed') return null
    const receipt = isRecord(result.receipt) ? result.receipt : {}
    return this.checkedMessage(receipt.message, input)
  }

  /** Reads a mailbox without consuming anything in it. */
  async mailbox(address: string): Promise<MailMessage[]> {
    const result = await this.call(['orchestration', 'inbox', '--terminal', address, '--limit', '200', '--full'])
    if (!Array.isArray(result.messages)) throw new OrcaContractError('Orca listed a mailbox in an unknown shape.')
    return result.messages.map(parseMail).filter((message): message is MailMessage => message !== null)
  }

  /** A receipt counts only when it is this exact mail: same sender, body, payload and a chat address. */
  checkedMessage(value: unknown, input: SendInput): MailMessage {
    const message = parseMail(value)
    const address = message?.to_handle ?? ''
    const addressed = address === `orca_session_id:${input.session}` || MAIL_ADDRESS.test(address)
    if (
      !message ||
      !addressed ||
      message.from_handle !== this.sender ||
      message.payload !== input.payload ||
      message.body !== input.body
    ) {
      throw new OrcaContractError('Orca returned a receipt that does not match the mail that was sent.')
    }
    return message
  }
}
