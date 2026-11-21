// Orca's own CLI is the only way to reach a native chat: the plugin host API has no mail method.
// Everything read from it is checked here, so an Orca update that changes a shape stops delivery
// (replies stay saved in the Inbox) instead of sending something wrong.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { argvLimit } from './envelope'
import { byteLength, canonicalSession, isRecord } from './util'

const MAX_OUTPUT = 32 * 1024 * 1024
/** How Orca names a native chat's pane: `structured-agent-session-<session id>:<uuid>`. */
const CHAT_PANE = /^structured-agent-session-([A-Za-z0-9_-]{1,160}):[0-9a-fA-F-]{36}$/
const MAIL_ADDRESS = /^(?:run|dispatch):[A-Za-z0-9_-]{1,160}$/
/** How long an unreadable command schema is trusted to mean "no `--body-file`" before asking again. */
const BODY_FILE_ASK_AGAIN_MS = 10 * 60_000

export type ExecResult = { code: number; stdout: string }
/** `input`, when given, is written to the program's standard input and closed. */
export type Exec = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number; input?: string }
) => Promise<ExecResult>

/** One native Orca chat on this machine. */
export type NativeSession = {
  session: string
  busy: boolean
  provider: string | null
  title: string | null
  workspacePath: string | null
  /** The bot whose chat this is (it runs in that bot's home), or null for any other chat. */
  bot: string | null
  /** What the chat waits on the person for, as `worktree ps` says (`chatWait`); null when it does not wait. */
  waiting: ChatWait
  /** When the chat's current state began (Orca's clock, ms); null when Orca does not say. */
  stateStartedAt: number | null
}

/**
 * `blocked`: the chat itself shows a prompt it waits on (a permission or a question; `agent read`
 * says which). `lead-waiting`: the chat's own turn asked the person something it does not wait on.
 * A wait held only by a child agent is not the chat's and reads as null.
 */
export type ChatWait = 'blocked' | 'lead-waiting' | null
/** The kind of prompt a chat waits on, in the Inbox's words. */
export type PromptKind = 'permission' | 'question'

/** What one `worktree ps` agent row says the chat waits on (see `ChatWait`). */
export function chatWait(agent: Record<string, unknown>): ChatWait {
  if (agent.state === 'blocked') return 'blocked'
  if (agent.state === 'waiting' && isRecord(agent.mainAgent) && agent.mainAgent.state === 'waiting') return 'lead-waiting'
  return null
}

function startedAt(agent: Record<string, unknown>): number | null {
  const value = agent.stateStartedAt
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The kind of prompt an `orca agent read` answer shows pending: a permission when any approval is,
 * else a question when any question is, else null. Only each entry's `kind` and `pending` are read;
 * the words of the conversation are never kept.
 */
export function promptKindOf(result: unknown): PromptKind | null {
  if (!isRecord(result) || !Array.isArray(result.entries)) return null
  let question = false
  for (const entry of result.entries) {
    if (!isRecord(entry) || entry.pending !== true) continue
    if (entry.kind === 'approval') return 'permission'
    if (entry.kind === 'question') question = true
  }
  return question ? 'question' : null
}

/** How long a read that found no pending prompt (or failed) stands before the chat is read again. */
const PROMPT_READ_AGAIN_MS = 60_000
/** A chat that has not been asked about for this long is forgotten. */
const PROMPT_FORGET_MS = 10 * 60_000

/** Reads the kind of prompt one chat waits on: null when none is pending or Orca cannot say. Never throws. */
export type PromptReader = { pendingPromptKind(session: string): Promise<PromptKind | null> }

/**
 * The kind of prompt each blocked chat waits on, read once per wait and shared by everyone who asks
 * (reply delivery and the Inbox's chat list), so a wait costs one `agent read`. A wait is told apart
 * by the time Orca says the chat's state began. A kind once found stands for that wait; a read that
 * found none, or failed, is tried again after a minute.
 */
export class PromptKinds {
  private readonly now: () => number
  private readonly known = new Map<string, { started: number | null; kind: PromptKind | null; at: number; asked: number; reading: Promise<PromptKind | null> | null }>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  kindOf(reader: PromptReader, session: string, started: number | null): Promise<PromptKind | null> {
    const at = this.now()
    for (const [key, entry] of this.known) if (at - entry.asked > PROMPT_FORGET_MS) this.known.delete(key)
    let entry = this.known.get(session)
    if (entry && entry.started !== started) entry = undefined
    if (entry) {
      entry.asked = at
      if (entry.reading) return entry.reading
      // A wait Orca gives no start time for cannot be told from the next one: it is read again too.
      if (entry.kind !== null && started !== null) return Promise.resolve(entry.kind)
      if (at - entry.at < PROMPT_READ_AGAIN_MS) return Promise.resolve(entry.kind)
    }
    const fresh = { started, kind: null as PromptKind | null, at, asked: at, reading: null as Promise<PromptKind | null> | null }
    fresh.reading = reader
      .pendingPromptKind(session)
      .catch(() => null)
      .then((kind) => {
        fresh.kind = kind
        fresh.at = this.now()
        fresh.reading = null
        return kind
      })
    this.known.set(session, fresh)
    return fresh.reading
  }
}

/**
 * The bot a `worktree ps` row is the home of, or null. Orca marks a bot's home with `botHome` and
 * the bot's name, and every chat in that home is the bot's; a workspace merely nested under a bot
 * carries `bot` without `botHome`, and its chats are ordinary chats.
 */
export function homeBot(tree: Record<string, unknown>): string | null {
  if (tree.botHome !== true || typeof tree.bot !== 'string') return null
  const name = tree.bot.replace(/\s+/g, ' ').trim().slice(0, 120)
  return name === '' ? null : name
}

/**
 * The payload Orca puts on mail that reaches a bot's chat in place of the sender's own: a JSON
 * object with a `botRequest` view the receiving bot reads beside the message.
 */
export function isBotRequestPayload(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) && isRecord(parsed.botRequest)
  } catch {
    return false
  }
}
export type MailMessage = Record<string, unknown> & { id: string; to_handle: string }
export type SendInput = { session: string; subject: string; body: string; payload: string }

/** Orca answered with an error. `notSent` is true only when Orca itself says nothing was sent. */
export class OrcaRefused extends Error {
  readonly code: string
  readonly notSent: boolean
  /** Orca's own words for the error, when it gave any. */
  readonly detail: string | null
  /** The flags the command takes, when Orca refused a flag it does not know. */
  readonly validFlags: readonly string[] | null
  constructor(code: string, notSent: boolean, detail: string | null = null, validFlags: readonly string[] | null = null) {
    super(`Orca refused: ${code}`)
    this.code = code
    this.notSent = notSent
    this.detail = detail
    this.validFlags = validFlags
  }
}
/**
 * A reply this Orca's CLI cannot carry: it has no `--body-file`, and the reply is longer than a
 * command line may be. Nothing was sent.
 */
export class OrcaTooLong extends Error {}
/** The CLI could not be started at all, so nothing was sent. */
export class OrcaNotRun extends Error {}
/** The CLI ran but its answer is not one this plugin understands. */
export class OrcaContractError extends Error {}

export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolvePromise, reject) => {
    try {
      const child = execFile(
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
      if (options.input !== undefined && child.stdin) {
        // A CLI that stops before reading all of it (it refused an argument) closes the pipe early.
        child.stdin.on('error', () => undefined)
        child.stdin.end(options.input, 'utf8')
      }
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
        workspacePath: typeof tree.path === 'string' ? tree.path : null,
        bot: homeBot(tree),
        waiting: chatWait(agent),
        stateStartedAt: startedAt(agent)
      })
    }
  }
  // A session listed twice cannot be told apart: deliver to neither.
  for (const session of duplicates) sessions.delete(session)
  return sessions
}

/**
 * One native chat as a click on an "Open in Orca" link needs it: which workspace holds it, and
 * whether that workspace is a plain folder (which `orca worktree activate` refuses to open).
 * A session listed more than once yields more than one row; the caller decides what that means.
 */
export type NavigationTarget = {
  session: string
  /** Orca's workspace id, as `worktree ps` lists it and `agentSession.reveal` echoes it. */
  worktreeId: string
  /** The selector `orca worktree activate --worktree` takes for exactly this workspace. */
  selector: string
  folder: boolean
  /** The bot whose chat this is, or null (see `homeBot`). */
  bot?: string | null
  /** The chat's name as Orca lists it, when it has one. */
  title?: string | null
}

export function parseNavigationTargets(result: unknown): NavigationTarget[] {
  if (!isRecord(result) || !Array.isArray(result.worktrees)) {
    throw new OrcaContractError('Orca listed its workspaces in an unknown shape.')
  }
  if (result.truncated === true) throw new OrcaContractError('Orca listed only part of its workspaces.')
  const targets: NavigationTarget[] = []
  for (const tree of result.worktrees) {
    if (!isRecord(tree) || !Array.isArray(tree.agents)) continue
    // A chat on a paired or SSH host is not on this computer, so a local link cannot open it.
    if (tree.hostId !== undefined && tree.hostId !== null && tree.hostId !== 'local') continue
    if (typeof tree.worktreeId !== 'string' || tree.worktreeId === '' || tree.worktreeId.length > 4096) continue
    const folder = tree.workspaceKind === 'folder-workspace' || tree.worktreeId.startsWith('folder:')
    const bot = homeBot(tree)
    for (const agent of tree.agents) {
      if (!isRecord(agent) || typeof agent.paneKey !== 'string') continue
      const match = CHAT_PANE.exec(agent.paneKey)
      const session = match ? canonicalSession(match[1]) : null
      if (!session) continue
      const title = [agent.conversationName, agent.taskTitle].find((value) => typeof value === 'string' && value.trim() !== '')
      targets.push({
        session,
        worktreeId: tree.worktreeId,
        selector: `id:${tree.worktreeId}`,
        folder,
        bot,
        title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : null
      })
    }
  }
  return targets
}

/**
 * One Orca repository (`orca repo list`). `repoIcon` is passed on unchecked: the caller decides what
 * it may use. `local` is false for a repository on an SSH or runtime host.
 */
export type OrcaRepo = { path: string; displayName: string | null; repoIcon: unknown; local: boolean }

export function parseRepoList(result: unknown): OrcaRepo[] {
  if (!isRecord(result) || !Array.isArray(result.repos)) {
    throw new OrcaContractError('Orca listed its repositories in an unknown shape.')
  }
  const repos: OrcaRepo[] = []
  for (const repo of result.repos) {
    if (!isRecord(repo) || typeof repo.path !== 'string' || repo.path === '') continue
    const host = repo.executionHostId
    const local = (repo.connectionId === undefined || repo.connectionId === null) && (host === undefined || host === null || host === 'local')
    repos.push({
      path: repo.path,
      displayName: typeof repo.displayName === 'string' ? repo.displayName.slice(0, 120) : null,
      repoIcon: repo.repoIcon ?? null,
      local
    })
  }
  return repos
}

export function parseMail(value: unknown): MailMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.to_handle !== 'string') return null
  return value as MailMessage
}

/**
 * Orca's argument check refusing `--body-file` as a flag it does not know. That check runs before
 * the CLI connects to the app, so nothing was sent.
 */
function isUnknownBodyFile(error: unknown): boolean {
  if (!(error instanceof OrcaRefused) || error.code !== 'invalid_argument') return false
  if (error.detail !== null && /unknown flag --body-file\b/i.test(error.detail)) return true
  return error.validFlags !== null && error.validFlags.length > 0 && !error.validFlags.includes('body-file')
}

/** Whether a mail fits on one command line on this platform (see `src/envelope.ts`). */
function fitsCommandLine(input: SendInput): boolean {
  return byteLength(input.body) + byteLength(input.payload) + byteLength(input.subject) <= argvLimit(process.platform)
}

export class OrcaCli {
  private readonly command: string[]
  private readonly exec: Exec
  private readonly env: Record<string, string | undefined>
  private readonly now: () => number
  /** Whether `orchestration send` takes `--body-file`; `final` once Orca has said so clearly. */
  private bodyFile: { value: boolean; final: boolean; until: number } | null = null
  readonly sender: string

  constructor(options: {
    command: string[]
    exec?: Exec
    env?: Record<string, string | undefined>
    sender?: string
    profile?: string | null
    now?: () => number
  }) {
    this.command = options.command
    this.exec = options.exec ?? defaultExec
    this.now = options.now ?? Date.now
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

  async call(args: string[], timeoutMs = 25_000, input?: string): Promise<Record<string, unknown>> {
    const [file, ...prefix] = this.command
    const { code, stdout } = await this.exec(file!, [...prefix, ...args, '--environment', 'local', '--json'], {
      env: this.env,
      timeoutMs,
      ...(input === undefined ? {} : { input })
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
      const validFlags = Array.isArray(data.validFlags) ? data.validFlags.filter((flag): flag is string => typeof flag === 'string') : null
      throw new OrcaRefused(
        typeof error.code === 'string' ? error.code : 'command_failed',
        data.requestSent === false,
        typeof error.message === 'string' ? error.message.slice(0, 500) : null,
        validFlags
      )
    }
    return isRecord(parsed.result) ? parsed.result : {}
  }

  /**
   * Whether this CLI's `orchestration send` takes `--body-file` (Orca 1.4.265 and later), read
   * from its own command schema (`orca agent-context`, a local read that needs no running app).
   * A clear answer is kept for the life of this object; an unreadable one is asked again later.
   */
  async takesBodyFile(): Promise<boolean> {
    const known = this.bodyFile
    if (known && (known.final || this.now() < known.until)) return known.value
    const [file, ...prefix] = this.command
    let value: boolean | null = null
    try {
      const { stdout } = await this.exec(file!, [...prefix, 'agent-context', '--json'], { env: this.env, timeoutMs: 15_000 })
      const schema: unknown = JSON.parse(stdout)
      if (isRecord(schema) && Array.isArray(schema.commands)) {
        const send = schema.commands.find((entry) => isRecord(entry) && entry.command === 'orchestration send')
        if (isRecord(send) && Array.isArray(send.flags)) value = send.flags.includes('body-file')
      }
    } catch {
      value = null
    }
    // A clear answer stays; while the schema cannot be read, the command line is used.
    this.bodyFile = value === null ? { value: false, final: false, until: this.now() + BODY_FILE_ASK_AGAIN_MS } : { value, final: true, until: 0 }
    return this.bodyFile.value
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

  /**
   * The kind of prompt one chat waits on (`orca agent read`, its newest entries): a permission, a
   * question, or null when none is pending, the read fails, or this Orca has no `agent read`. The
   * answer holds the conversation's words; only each entry's kind and whether it is pending are
   * read from it, and nothing of it is kept or logged.
   */
  async pendingPromptKind(session: string): Promise<PromptKind | null> {
    try {
      return promptKindOf(await this.call(['agent', 'read', '--id', `orca_session_id:${session}`, '--limit', '10'], 12_000))
    } catch {
      return null
    }
  }

  /** The local native chats with the workspace each one is in, for "Open in Orca" links. */
  async navigationTargets(): Promise<NavigationTarget[]> {
    return parseNavigationTargets(await this.call(['worktree', 'ps', '--limit', '1000']))
  }

  /**
   * Brings one workspace forward in Orca, as clicking it in the sidebar would. Orca refuses a
   * folder workspace here. Returns the workspace id Orca says it opened.
   */
  async activateWorktree(selector: string): Promise<string | null> {
    const result = await this.call(['worktree', 'activate', '--worktree', selector], 15_000)
    return typeof result.worktreeId === 'string' ? result.worktreeId : null
  }

  /**
   * How this CLI is started (argv and environment), for a helper that must run with the same
   * Orca and the same profile, such as the one that brings a chat tab forward.
   */
  launchInfo(): { command: string[]; env: Record<string, string | undefined> } {
    return { command: [...this.command], env: { ...this.env } }
  }

  /** Orca's repositories with their icons (`repo list`). Read only. */
  async repoList(): Promise<OrcaRepo[]> {
    return parseRepoList(await this.call(['repo', 'list'], 12_000))
  }

  /**
   * Queues one mail for a chat. `requestId` makes a repeat replay the first result.
   *
   * The body goes through standard input (`--body-file -`) where this Orca takes it, so a long
   * reply is never cut by the system's limit on a command line and never shows in the process
   * list. An Orca without `--body-file` refuses the flag while reading its arguments, before it
   * reaches the app, so nothing was sent: the same request goes again with `--body`, and this
   * object remembers that Orca's answer.
   */
  async send(input: SendInput, requestId: string): Promise<MailMessage> {
    const head = ['orchestration', 'send', '--from', this.sender, '--to', `orca_session_id:${input.session}`, '--type', 'status', '--subject', input.subject]
    const tail = ['--payload', input.payload, '--retry-request', requestId, '--full']
    if (await this.takesBodyFile()) {
      try {
        const result = await this.call([...head, '--body-file', '-', ...tail], 25_000, input.body)
        return this.checkedMessage(result.message, input)
      } catch (error) {
        if (!isUnknownBodyFile(error)) throw error
        this.bodyFile = { value: false, final: true, until: 0 }
      }
    }
    if (!fitsCommandLine(input)) {
      throw new OrcaTooLong('This reply is too long for this Orca’s command line, and this Orca cannot take it another way, so nothing was sent. Update Orca, then press Send again.')
    }
    const result = await this.call([...head, '--body', input.body, ...tail])
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

  /**
   * A receipt counts only when it is this exact mail: same sender, body, payload and a chat address.
   * Mail to a bot's chat is the one exception Orca makes: it keeps the sender, address and body but
   * replaces the payload with its own record of the request (`isBotRequestPayload`).
   */
  checkedMessage(value: unknown, input: SendInput): MailMessage {
    const message = parseMail(value)
    const address = message?.to_handle ?? ''
    const addressed = address === `orca_session_id:${input.session}` || MAIL_ADDRESS.test(address)
    if (
      !message ||
      !addressed ||
      message.from_handle !== this.sender ||
      (message.payload !== input.payload && !isBotRequestPayload(message.payload)) ||
      message.body !== input.body
    ) {
      throw new OrcaContractError('Orca returned a receipt that does not match the mail that was sent.')
    }
    return message
  }

  /** Workspaces, chats and repositories, read together (Start, Stop and Resume from the Inbox). */
  async lifecycleInventory(): Promise<LifecycleInventory> {
    const ps = await this.call(['worktree', 'ps', '--limit', '1000'])
    const repos = await this.call(['repo', 'list'], 12_000)
    return parseLifecycleInventory(ps, repos)
  }

  /**
   * Starts one native chat in an existing workspace with `orca agent launch --surface chat`, under
   * the given operation id. No prompt: the first message reaches the chat as a reply would.
   */
  async launchChat(launch: ChatLaunch, timeoutMs = 35_000): Promise<Record<string, unknown>> {
    const args = ['agent', 'launch', '--agent', launch.agent, '--worktree', launch.selector, '--surface', 'chat', '--retry-launch', launch.operationId]
    if (launch.model) args.push('--model', launch.model)
    if (launch.effort) args.push('--effort', launch.effort)
    return this.call(args, timeoutMs)
  }
}

// ---------------------------------------------------------------------------------------------
// Start, Stop and Resume from the Inbox (src/lifecycle.ts)

/** One local workspace a chat can be started in, as `worktree ps` and `repo list` describe it. */
export type LifecycleWorkspace = {
  /** The workspace's folder, as Orca lists it. */
  folder: string
  /** Its repository's root folder. */
  project: string
  /** The selector `--worktree` takes for exactly this workspace. */
  selector: string
  /** Orca's workspace id (`worktreeId`). */
  workspaceId: string
  workspaceKind: string | null
  name: string
}
/** One native chat as Start, Stop and Resume need it. */
export type LifecycleSession = {
  session: string
  pane: string
  workspaceId: string
  /** `agentType`, e.g. `claude`, `codex`, `opencode2`. */
  agentType: string | null
  /** True while the chat is working; false otherwise. */
  busy: boolean
  /** Orca's own word for what the chat is doing (`working`, `idle`, …), when it gives one. */
  state: string | null
  /** What the chat waits on the person for (see `ChatWait`). */
  waiting: ChatWait
  /** When the chat's current state began (Orca's clock, ms); null when Orca does not say. */
  stateStartedAt: number | null
}
export type LifecycleInventory = {
  workspaces: LifecycleWorkspace[]
  /** Chats listed exactly once; a chat listed twice is left out. */
  sessions: Map<string, LifecycleSession>
  /** Orca's local repositories (`repo list`), for the Inbox's project list. */
  repos: { path: string; name: string }[]
}

const LIFECYCLE_PANE = /^structured-agent-session-([A-Za-z0-9_-]{1,160}):[0-9a-fA-F-]{36}$/

/**
 * Workspaces and native chats from one `worktree ps` and one `repo list`. Only this computer's:
 * rows on a paired or SSH host, archived workspaces and repositories on another host are left
 * out. A partial listing is refused rather than read as complete.
 */
export function parseLifecycleInventory(ps: unknown, repoList: unknown): LifecycleInventory {
  if (!isRecord(ps) || !Array.isArray(ps.worktrees)) throw new OrcaContractError('Orca listed its workspaces in an unknown shape.')
  if (!isRecord(repoList) || !Array.isArray(repoList.repos)) throw new OrcaContractError('Orca listed its repositories in an unknown shape.')
  if (ps.truncated === true || repoList.truncated === true) throw new OrcaContractError('Orca listed only part of its workspaces.')
  const roots = new Map<string, string>()
  const repos: { path: string; name: string }[] = []
  for (const repo of repoList.repos) {
    if (!isRecord(repo) || typeof repo.path !== 'string' || repo.path === '') continue
    const host = repo.executionHostId
    const local = (repo.connectionId === undefined || repo.connectionId === null) && (host === undefined || host === null || host === 'local')
    if (!local) continue
    if (typeof repo.id === 'string') roots.set(repo.id, repo.path)
    const name = typeof repo.displayName === 'string' && repo.displayName.trim() !== '' ? repo.displayName.trim() : basename(repo.path)
    repos.push({ path: repo.path, name: name.slice(0, 200) })
  }
  const workspaces: LifecycleWorkspace[] = []
  const sessions = new Map<string, LifecycleSession>()
  const twice = new Set<string>()
  for (const tree of ps.worktrees) {
    if (!isRecord(tree)) continue
    if (tree.hostId !== undefined && tree.hostId !== null && tree.hostId !== 'local') continue
    if (typeof tree.worktreeId !== 'string' || tree.worktreeId === '' || tree.worktreeId.length > 4096) continue
    if (typeof tree.path !== 'string' || tree.path === '') continue
    for (const agent of Array.isArray(tree.agents) ? tree.agents : []) {
      if (!isRecord(agent) || typeof agent.paneKey !== 'string') continue
      const match = LIFECYCLE_PANE.exec(agent.paneKey)
      const session = match ? canonicalSession(match[1]) : null
      if (!session) continue
      if (sessions.has(session)) twice.add(session)
      sessions.set(session, {
        session,
        pane: agent.paneKey,
        workspaceId: tree.worktreeId,
        agentType: typeof agent.agentType === 'string' ? agent.agentType : null,
        busy: agent.state === 'working',
        state: typeof agent.state === 'string' ? agent.state.slice(0, 40) : null,
        waiting: chatWait(agent),
        stateStartedAt: startedAt(agent)
      })
    }
    if (tree.isArchived === true) continue
    // A bot's home is the bot's: a chat started there would be the bot's chat, which the Inbox does not start.
    if (homeBot(tree) !== null) continue
    const project = typeof tree.repoId === 'string' ? roots.get(tree.repoId) : undefined
    if (!project) continue
    const address = isRecord(tree.address) ? tree.address : null
    // The address Orca gives this row on this computer; an older Orca without one gets the exact id.
    const selector = address
      ? address.environment === 'local' && typeof address.worktree === 'string' && address.worktree !== ''
        ? address.worktree
        : null
      : `id:${tree.worktreeId}`
    if (!selector || selector.length > 4096) continue
    const display = [tree.displayName, tree.repo].find((value) => typeof value === 'string' && value.trim() !== '')
    workspaces.push({
      folder: tree.path,
      project,
      selector,
      workspaceId: tree.worktreeId,
      workspaceKind: typeof tree.workspaceKind === 'string' ? tree.workspaceKind : null,
      name: (typeof display === 'string' ? display.trim() : basename(tree.path)).slice(0, 200)
    })
  }
  for (const session of twice) sessions.delete(session)
  return { workspaces, sessions, repos }
}

export type ChatLaunch = {
  /** Orca's agent id: `claude`, `codex`, `opencode2`. */
  agent: string
  /** `--worktree` selector of an existing workspace. */
  selector: string
  /** `--retry-launch`: the operation id this launch is recorded under, so a repeat replays it. */
  operationId: string
  model?: string
  effort?: string
}

