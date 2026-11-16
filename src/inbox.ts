// Client for the stock Plannotator Inbox, over the same loopback routes its own agent plugins use:
//   <data>/inbox/inbox.json           where the running Inbox is (port, token; re-read on every call)
//   GET  /api/inbox/health            version and liveness
//   POST /api/inbox/bridge/poll       the replies waiting for one session (long poll)
//   POST /api/inbox/bridge/event      "delivered" acknowledgement
//   GET  /api/inbox/threads           read once in a while to find Orca sessions that wrote before
// Every field Plannotator adds later is ignored; only the ones read here must keep their shape.
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ID, canonicalSession, isRecord, sha256 } from './util'

const MAX_RESPONSE = 4 * 1024 * 1024
/** The server holds a poll for at most 25 s; stay under it. */
export const POLL_WAIT_MS = 20_000

export type Registry = { port: number; token: string; version: string | null; url: string | null }
export type InboxHealth = { version: string | null; serverSession: string | null }
/** One reply or message the Inbox wants delivered. Unknown fields are kept for the envelope. */
export type InboxCommand = Record<string, unknown> & {
  id: string
  thread_id: string
  type: 'reply' | 'message'
  body: string
}
export type ThreadAuthor = { session: string; raw: string; projectRoot: string | null }

/** The Inbox is not installed, not running, or not answering: replies simply wait in it. */
export class InboxUnavailable extends Error {}
/** The Inbox answered in a shape this plugin does not understand. */
export class InboxContractError extends Error {}
/** The Inbox refused one request (4xx). `status` is the HTTP status. */
export class InboxRefused extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type InboxDeps = {
  fetch?: typeof fetch
  readRegistry?: (path: string) => Promise<string | null>
}

async function readPrivateFile(path: string): Promise<string | null> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
  // Holds the Inbox token: only a plain file that belongs to this user and nobody else can read.
  if (!info.isFile()) throw new InboxContractError('The Inbox registry is not a regular file.')
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new InboxContractError('The Inbox registry is readable by other users; refusing its token.')
    }
  }
  if (info.size > MAX_RESPONSE) throw new InboxContractError('The Inbox registry is too large.')
  return readFile(path, 'utf8')
}

export function parseCommand(value: unknown): InboxCommand | null {
  if (!isRecord(value)) return null
  const { id, thread_id: threadId, type, body } = value
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (typeof threadId !== 'string' || !ID.test(threadId)) return null
  if (type !== 'reply' && type !== 'message') return null
  if (typeof body !== 'string') return null
  return value as InboxCommand
}

export class InboxClient {
  readonly dataDir: string
  /** Stable id of this Inbox for ledger keys; never the path itself. */
  readonly key: string
  private readonly fetchImpl: typeof fetch
  private readonly readRegistry: (path: string) => Promise<string | null>

  constructor(dataDir: string, deps: InboxDeps = {}) {
    this.dataDir = dataDir
    this.key = sha256(dataDir)
    this.fetchImpl = deps.fetch ?? fetch
    this.readRegistry = deps.readRegistry ?? readPrivateFile
  }

  /** Null when the Inbox has never run here. */
  async registry(): Promise<Registry | null> {
    const raw = await this.readRegistry(join(this.dataDir, 'inbox', 'inbox.json'))
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new InboxContractError('The Inbox registry is not valid JSON.')
    }
    if (!isRecord(parsed)) throw new InboxContractError('The Inbox registry has an unknown shape.')
    const { port, token } = parsed
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new InboxContractError('The Inbox registry has no usable port.')
    }
    if (typeof token !== 'string' || token === '' || /[\r\n]/.test(token)) {
      throw new InboxContractError('The Inbox registry has no usable token.')
    }
    return {
      port,
      token,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      url: typeof parsed.url === 'string' ? parsed.url : null
    }
  }

  private async request(
    path: string,
    body: Record<string, unknown> | null,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    // Read again on every call: a restart rotates the token and may move the port.
    const registry = await this.registry()
    if (registry === null) throw new InboxUnavailable('The Plannotator Inbox has not run on this computer yet.')
    const headers: Record<string, string> = { accept: 'application/json' }
    const init: RequestInit = { method: 'GET', headers, redirect: 'error' }
    if (body !== null) {
      headers.authorization = `Bearer ${registry.token}`
      headers['content-type'] = 'application/json'
      init.method = 'POST'
      init.body = JSON.stringify(body)
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    init.signal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${registry.port}${path}`, init)
    } catch {
      throw new InboxUnavailable('The Plannotator Inbox is not answering.')
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      throw new InboxUnavailable('The Plannotator Inbox closed the connection.')
    }
    if (text.length > MAX_RESPONSE) throw new InboxContractError('The Inbox answer is too large.')
    if (response.status === 401) throw new InboxUnavailable('The Plannotator Inbox restarted; reconnecting.')
    if (response.status >= 500) throw new InboxUnavailable(`The Plannotator Inbox failed (${response.status}).`)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new InboxContractError(`The Inbox answered ${path} with something that is not JSON.`)
    }
    if (!isRecord(parsed)) throw new InboxContractError(`The Inbox answered ${path} in an unknown shape.`)
    if (response.status >= 400) {
      const reason = typeof parsed.code === 'string' ? parsed.code : `status ${response.status}`
      throw new InboxRefused(response.status, `The Inbox refused ${path}: ${reason}`)
    }
    return parsed
  }

  async health(signal?: AbortSignal): Promise<InboxHealth> {
    const answer = await this.request('/api/inbox/health', null, 4000, signal)
    return {
      version: typeof answer.version === 'string' ? answer.version : null,
      serverSession: typeof answer.serverSession === 'string' ? answer.serverSession : null
    }
  }

  /**
   * The replies waiting for one session. Polling is also what tells the Inbox the session is
   * connected, so only poll for sessions this plugin can really deliver to.
   */
  async poll(
    route: { raw: string; projectPath: string | null; title: string | null },
    busy: boolean,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<{ commands: InboxCommand[]; invalid: number }> {
    const body: Record<string, unknown> = { host: 'orca', session: route.raw, busy, waitMs }
    if (route.projectPath) body.project_path = route.projectPath
    if (route.title) body.title = route.title
    const answer = await this.request('/api/inbox/bridge/poll', body, waitMs + 8000, signal)
    if (!Array.isArray(answer.commands) || answer.commands.length > 500) {
      throw new InboxContractError('The Inbox reply queue has an unknown shape.')
    }
    const commands: InboxCommand[] = []
    let invalid = 0
    for (const item of answer.commands) {
      const command = parseCommand(item)
      if (command) commands.push(command)
      else invalid += 1
    }
    return { commands, invalid }
  }

  /** Tells the Inbox one reply reached the agent. Safe to repeat. */
  async acknowledge(rawSession: string, id: string, signal?: AbortSignal): Promise<void> {
    const answer = await this.request(
      '/api/inbox/bridge/event',
      { host: 'orca', session: rawSession, type: 'delivered', id },
      8000,
      signal
    )
    if (answer.ok !== true) throw new InboxContractError('The Inbox did not confirm the delivery.')
  }

  /**
   * Orca sessions that wrote in this Inbox before (author host `orca`). Best effort: it walks
   * the thread list for author records instead of relying on its layout, and an unreadable
   * list just means sessions are found when they next send.
   */
  async orcaAuthors(signal?: AbortSignal): Promise<ThreadAuthor[]> {
    const model = await this.request('/api/inbox/threads', null, 8000, signal)
    const roots = new Map<string, string>()
    if (Array.isArray(model.projects)) {
      for (const project of model.projects) {
        if (isRecord(project) && typeof project.id === 'string' && typeof project.root === 'string') {
          roots.set(project.id, project.root)
        }
      }
    }
    const found = new Map<string, ThreadAuthor>()
    let visited = 0
    const walk = (node: unknown, depth: number): void => {
      if (depth > 8 || visited > 200_000 || node === null || typeof node !== 'object') return
      visited += 1
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1)
        return
      }
      const record = node as Record<string, unknown>
      const author = record.author
      if (isRecord(author) && author.kind === 'agent' && author.host === 'orca' && typeof author.session === 'string') {
        const session = canonicalSession(author.session)
        if (session && !found.has(author.session)) {
          const projectId = typeof record.project_id === 'string' ? record.project_id : null
          found.set(author.session, {
            session,
            raw: author.session,
            projectRoot: projectId ? (roots.get(projectId) ?? null) : null
          })
        }
      }
      for (const value of Object.values(record)) walk(value, depth + 1)
    }
    walk(model.sections ?? model, 0)
    return [...found.values()]
  }
}
