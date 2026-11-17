// Client for the stock Plannotator Inbox, over the same loopback routes its own agent plugins use:
//   <data>/inbox/inbox.json           where the running Inbox is (port, token; re-read on every call)
//   GET  /api/inbox/health            version and liveness
//   POST /api/inbox/bridge/poll       the replies waiting for one session (long poll)
//   POST /api/inbox/bridge/event      "delivered" acknowledgement
//   GET  /api/inbox/threads           read once in a while to find Orca sessions that wrote before
//   GET  /api/inbox/projects          projects and the run's serverSession (project pictures)
//   POST /api/inbox/projects/:id/picture, GET the same: a project's picture (presentation.ts)
//   GET  /api/inbox/threads/<id>      one thread, to check where a reply came from before it is sent
//   GET  /api/inbox/agents            the agents Plannotator knows and how each reaches the Inbox (window route)
//   POST /api/inbox/control/connect   Plannotator connects the agents on this computer its own way
//   GET/POST /api/inbox/control/orca-agents   the Orca build only: the same, writing the launcher
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
/** One message of a thread, as `GET /api/inbox/threads/<id>` serves it; only what source checks read. */
export type ThreadMessage = {
  id: string
  replyTo: string | null
  author: { kind: string | null; host: string | null; session: string | null }
  /** An explicit addressee (a person's New message, or a reply handed to another session); null when none. */
  to: { host: string | null; session: string | null } | null
  createdAt: string | null
}
/** One thread: its project's root (an absolute real path) and its messages by id. */
export type ThreadSource = { threadId: string; root: string; messages: Map<string, ThreadMessage> }

const MAX_THREAD_MESSAGES = 10_000

/** The Inbox is not installed, not running, or not answering: replies simply wait in it. */
export class InboxUnavailable extends Error {}
/**
 * The Inbox answered with a server error (5xx). Still "unavailable" for replies (they are tried
 * again later); `message` carries the Inbox's own `error` text when it gave one.
 */
export class InboxFailed extends InboxUnavailable {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
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

/** An Inbox project id, as the window's picture route takes it. */
export const PROJECT_ID = /^prj_[A-Za-z0-9_]{1,150}$/
const MAX_PROJECTS = 5000
/** Stock keeps a set picture at 512 KB; a read far past that is not one. */
const MAX_PICTURE_READ = 1024 * 1024

/**
 * One project as the window lists it. `picture` is stock's marker for a set picture (when it was
 * set, in ms) and is left for the caller to judge; `mergedInto` names a project it was combined into.
 */
export type InboxProjectRow = { id: string; root: string; picture: unknown; mergedInto: string | null }
export type InboxProjects = { serverSession: string; projects: InboxProjectRow[] }

export function parseProjectRow(value: unknown): InboxProjectRow | null {
  if (!isRecord(value)) return null
  const { id, root } = value
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || typeof root !== 'string' || root === '') return null
  return { id, root, picture: value.picture, mergedInto: typeof value.merged_into === 'string' ? value.merged_into : null }
}

/**
 * How one agent reaches the Inbox, in the Orca build's words (`/api/inbox/control/orca-agents`):
 * `orca` runs the launcher; `plannotator` runs Plannotator directly; `tool` goes through
 * Plannotator's own plugin for that agent; `off` was turned off in Plannotator's Settings; `other`
 * is a `plannotator-inbox` entry that runs something else; `manual` must be connected by hand;
 * `absent` is found and not connected; `unreadable` has settings that cannot be read.
 */
export type InboxAgentState = 'orca' | 'plannotator' | 'tool' | 'off' | 'other' | 'manual' | 'absent' | 'unreadable'
export type InboxAgentRow = { id: string; label: string; detected: boolean; state: InboxAgentState; reason: string | null; path: string | null }
export type InboxAgentProblem = { agent: string; reason: string }
/** What a connect or disconnect did. `skipped`: Plannotator did nothing at all (switched off, or a test sandbox). */
export type InboxAgentsResult = { agents: InboxAgentRow[]; changed: string[]; problems: InboxAgentProblem[]; skipped: 'env' | 'sandbox' | null }

const AGENT_STATES: readonly InboxAgentState[] = ['orca', 'plannotator', 'tool', 'off', 'other', 'manual', 'absent', 'unreadable']
/** Plannotator knows 17 agents; anything far past that is not an agent list. */
const MAX_AGENT_ROWS = 64
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
/** The agents the plugin connects itself; the Orca build's route leaves them alone when asked. */
export const OWN_AGENT_IDS = ['claude-code', 'codex', 'opencode'] as const

/** A string the panel shows, cut to a sane length; null for anything else. */
function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (flat === '') return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function agentList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new InboxContractError(`The Inbox answered ${what} without its list of agents.`)
  return value.slice(0, MAX_AGENT_ROWS)
}

/** One row of the Orca build's agent list; null when it cannot be read. An unknown state reads as `other`. */
export function parseOrcaAgentRow(value: unknown): InboxAgentRow | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !AGENT_ID.test(value.id)) return null
  const state = AGENT_STATES.includes(value.state as InboxAgentState) ? (value.state as InboxAgentState) : 'other'
  return {
    id: value.id,
    label: shortText(value.label, 80) ?? value.id,
    detected: value.detected === true,
    state,
    reason: shortText(value.reason, 500),
    path: shortText(value.path, 1024)
  }
}

/**
 * One row of standard Plannotator's `GET /api/inbox/agents` (`InboxAgentRow` there: `reach` says
 * how it reaches the Inbox), in the Orca build's words. An entry Plannotator connected runs
 * Plannotator directly, so it is `plannotator`.
 */
export function parseStockAgentRow(value: unknown): InboxAgentRow | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !AGENT_ID.test(value.id)) return null
  const reach = isRecord(value.reach) ? value.reach : {}
  let state: InboxAgentState
  switch (reach.state) {
    case 'connected':
    case 'elsewhere':
      state = reach.kind === 'mcp' ? 'plannotator' : 'tool'
      break
    case 'off':
    case 'removed':
      state = 'off'
      break
    case 'foreign':
      state = 'other'
      break
    case 'manual':
      state = 'manual'
      break
    case 'not_connected':
      state = 'absent'
      break
    case 'unreadable':
      state = 'unreadable'
      break
    default:
      state = 'other'
  }
  return {
    id: value.id,
    label: shortText(value.label, 80) ?? value.id,
    detected: value.detected === true,
    state,
    reason: shortText(reach.reason, 500),
    path: shortText(reach.path, 1024)
  }
}

function parseRows(value: unknown, what: string, parse: (row: unknown) => InboxAgentRow | null): InboxAgentRow[] {
  const rows: InboxAgentRow[] = []
  const seen = new Set<string>()
  for (const item of agentList(value, what)) {
    const row = parse(item)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

function parseProblems(value: unknown): InboxAgentProblem[] {
  if (!Array.isArray(value)) return []
  const problems: InboxAgentProblem[] = []
  for (const item of value.slice(0, MAX_AGENT_ROWS)) {
    if (!isRecord(item) || typeof item.agent !== 'string' || !AGENT_ID.test(item.agent)) continue
    problems.push({ agent: item.agent, reason: shortText(item.reason, 500) ?? 'It could not be changed.' })
  }
  return problems
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_AGENT_ROWS).filter((item): item is string => typeof item === 'string' && AGENT_ID.test(item))
}

function parseSkipped(value: unknown): 'env' | 'sandbox' | null {
  return value === 'env' || value === 'sandbox' ? value : null
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
    signal?: AbortSignal,
    /** Sends the Inbox token; every POST does. A GET only for routes behind it (the control routes). */
    auth = body !== null
  ): Promise<Record<string, unknown>> {
    // Read again on every call: a restart rotates the token and may move the port.
    const registry = await this.registry()
    if (registry === null) throw new InboxUnavailable('The Plannotator Inbox has not run on this computer yet.')
    const headers: Record<string, string> = { accept: 'application/json' }
    const init: RequestInit = { method: 'GET', headers, redirect: 'error' }
    if (auth) headers.authorization = `Bearer ${registry.token}`
    if (body !== null) {
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
    if (response.status >= 500) {
      let said: string | null = null
      try {
        const body: unknown = JSON.parse(text)
        said = isRecord(body) ? shortText(body.error, 300) : null
      } catch {
        // Not JSON: the status alone.
      }
      throw new InboxFailed(response.status, said ? `The Plannotator Inbox failed (${response.status}): ${said}` : `The Plannotator Inbox failed (${response.status}).`)
    }
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
   * The Inbox's projects and this run's `serverSession`, from the window's own read route
   * (`GET /api/inbox/projects`). A write to a window route echoes that nonce; a restarted Inbox
   * refuses an old one with 409 and saves nothing.
   */
  async projectList(timeoutMs = 8000, signal?: AbortSignal): Promise<InboxProjects> {
    const answer = await this.request('/api/inbox/projects', null, timeoutMs, signal)
    const nonce = answer.serverSession
    if (typeof nonce !== 'string' || nonce === '' || nonce.length > 200) {
      throw new InboxContractError('The Inbox listed its projects without a server session.')
    }
    if (!Array.isArray(answer.projects) || answer.projects.length > MAX_PROJECTS) {
      throw new InboxContractError('The Inbox listed its projects in an unknown shape.')
    }
    const projects: InboxProjectRow[] = []
    const seen = new Set<string>()
    for (const item of answer.projects) {
      const row = parseProjectRow(item)
      if (!row) throw new InboxContractError('The Inbox listed a project in an unknown shape.')
      // Two rows with one id cannot be told apart: nothing is changed for either.
      if (seen.has(row.id)) throw new InboxContractError('The Inbox listed one project twice.')
      seen.add(row.id)
      projects.push(row)
    }
    return { serverSession: nonce, projects }
  }

  /**
   * Sets one project's picture (the window's Set picture…): an inline `data:image/…;base64,` URL.
   * Answers the project as the Inbox now lists it, or null. Stock refuses (4xx) before it saves
   * anything; a lost answer may or may not have saved it.
   */
  async setProjectPicture(
    projectId: string,
    picture: string,
    serverSession: string,
    timeoutMs = 8000,
    signal?: AbortSignal
  ): Promise<InboxProjectRow | null> {
    if (!PROJECT_ID.test(projectId)) throw new InboxContractError('Not an Inbox project id.')
    const answer = await this.request(`/api/inbox/projects/${projectId}/picture`, { picture, serverSession }, timeoutMs, signal)
    if (answer.project === null) return null
    const row = parseProjectRow(answer.project)
    if (!row) throw new InboxContractError('The Inbox answered a picture change in an unknown shape.')
    return row
  }

  /**
   * What the Orca build of Plannotator says it can do (`GET /api/inbox/orca`); [] for standard
   * Plannotator, which has no such route.
   */
  async orcaFeatures(timeoutMs = 4000, signal?: AbortSignal): Promise<string[]> {
    let answer: Record<string, unknown>
    try {
      answer = await this.request('/api/inbox/orca', null, timeoutMs, signal)
    } catch (error) {
      if (error instanceof InboxRefused || error instanceof InboxContractError) return []
      throw error
    }
    if (answer.mode !== 'orca' || !Array.isArray(answer.features)) return []
    return answer.features.filter((item): item is string => typeof item === 'string' && item.length <= 60).slice(0, 50)
  }

  /**
   * The Orca build's list of agents (`GET /api/inbox/control/orca-agents`, when `orcaFeatures()`
   * includes `agents`). Rows for `OWN_AGENT_IDS` are in it too; the caller drops them.
   */
  async orcaAgents(timeoutMs = 4000, signal?: AbortSignal): Promise<InboxAgentRow[]> {
    const answer = await this.request('/api/inbox/control/orca-agents', null, timeoutMs, signal, true)
    if (answer.v !== 1) throw new InboxContractError('The Inbox answered the agent list in an unknown version.')
    return parseRows(answer.agents, 'the agent list', parseOrcaAgentRow)
  }

  /**
   * The Orca build connects (writing the launcher) or disconnects every agent it supports but
   * `except`. Each agent's own CLI may take a while: up to about 40 s in all.
   */
  async orcaAgentsAction(
    action: 'connect' | 'disconnect',
    except: readonly string[],
    timeoutMs = 60_000,
    signal?: AbortSignal
  ): Promise<InboxAgentsResult> {
    const answer = await this.request('/api/inbox/control/orca-agents', { action, except: [...except] }, timeoutMs, signal)
    if (answer.v !== 1) throw new InboxContractError(`The Inbox answered the agent ${action} in an unknown version.`)
    return {
      agents: parseRows(answer.agents, `the agent ${action}`, parseOrcaAgentRow),
      changed: parseIds(answer.changed),
      problems: parseProblems(answer.problems),
      skipped: parseSkipped(answer.skipped)
    }
  }

  /** Standard Plannotator's list of agents (`GET /api/inbox/agents`, a window route), in the Orca build's words. */
  async stockAgents(timeoutMs = 4000, signal?: AbortSignal): Promise<InboxAgentRow[]> {
    const answer = await this.request('/api/inbox/agents', null, timeoutMs, signal)
    return parseRows(answer.agents, 'the agent list', parseStockAgentRow)
  }

  /**
   * Standard Plannotator connects the agents on this computer its own way, as a terminal
   * `plannotator inbox` does (`POST /api/inbox/control/connect`, answering `{ connect: report }`).
   * `changed` is what this run connected; `problems` what failed and why; `manual` what only a person can connect, and why.
   */
  async stockConnect(timeoutMs = 60_000, signal?: AbortSignal): Promise<Omit<InboxAgentsResult, 'agents'> & { manual: InboxAgentProblem[] }> {
    const answer = await this.request('/api/inbox/control/connect', {}, timeoutMs, signal)
    const report = answer.connect
    if (!isRecord(report)) throw new InboxContractError('The Inbox answered the agent connect in an unknown shape.')
    const problems = parseProblems(report.failed)
    const manual: InboxAgentProblem[] = []
    if (Array.isArray(report.manual_why)) {
      for (const item of report.manual_why.slice(0, MAX_AGENT_ROWS)) {
        if (!isRecord(item) || typeof item.agent !== 'string' || !AGENT_ID.test(item.agent)) continue
        const why = shortText(item.why, 500)
        if (why) manual.push({ agent: item.agent, reason: why })
      }
    }
    return { changed: parseIds(report.added), problems, manual, skipped: parseSkipped(report.skipped) }
  }

  /** The face each agent's icon shows, and this run's `serverSession` (which a face change echoes). */
  async agentFaces(timeoutMs = 8000, signal?: AbortSignal): Promise<{ serverSession: string | null; faces: Record<string, { face: string; sessions: string[] }> }> {
    const [health, answer] = await Promise.all([this.health(signal), this.request('/api/inbox/agent-faces', null, timeoutMs, signal)])
    const faces: Record<string, { face: string; sessions: string[] }> = {}
    if (isRecord(answer.faces)) {
      for (const [agent, entry] of Object.entries(answer.faces).slice(0, 2000)) {
        if (!isRecord(entry) || typeof entry.face !== 'string') continue
        faces[agent] = { face: entry.face, sessions: Array.isArray(entry.sessions) ? entry.sessions.filter((item): item is string => typeof item === 'string') : [] }
      }
    }
    return { serverSession: health.serverSession, faces }
  }

  /** Sets one agent's face, as the window's own picker does. The Inbox refuses (4xx) before it saves anything. */
  async setAgentFace(agent: string, face: string, serverSession: string, timeoutMs = 8000, signal?: AbortSignal): Promise<void> {
    await this.request('/api/inbox/agent-faces', { agent, face, serverSession }, timeoutMs, signal)
  }

  /**
   * The bytes of the picture the Inbox shows for a project (a set picture first), or null when it
   * has none. Read only to learn whether an earlier write landed.
   */
  async projectPicture(projectId: string, timeoutMs = 8000, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (!PROJECT_ID.test(projectId)) throw new InboxContractError('Not an Inbox project id.')
    const registry = await this.registry()
    if (registry === null) throw new InboxUnavailable('The Plannotator Inbox has not run on this computer yet.')
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`http://127.0.0.1:${registry.port}/api/inbox/projects/${projectId}/picture`, {
        method: 'GET',
        headers: { accept: 'image/*' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
    } catch {
      throw new InboxUnavailable('The Plannotator Inbox is not answering.')
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (response.status >= 500) throw new InboxUnavailable(`The Plannotator Inbox failed (${response.status}).`)
    if (response.status !== 200) throw new InboxRefused(response.status, 'The Inbox refused the picture read.')
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_PICTURE_READ) throw new InboxContractError('The Inbox picture is too large.')
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      throw new InboxUnavailable('The Plannotator Inbox closed the connection.')
    }
    if (bytes.byteLength > MAX_PICTURE_READ) throw new InboxContractError('The Inbox picture is too large.')
    return bytes
  }

  /**
   * One thread as the Inbox window reads it (`GET /api/inbox/threads/<id>`), for checking where a
   * reply came from before it is delivered. Throws InboxUnavailable while the Inbox cannot answer
   * (read again later), InboxRefused with status 404 when the thread is gone, and
   * InboxContractError when the answer is not in the expected shape.
   */
  async thread(threadId: string, signal?: AbortSignal): Promise<ThreadSource> {
    if (!ID.test(threadId)) throw new InboxContractError('The reply names a thread id this plugin cannot read.')
    const path = `/api/inbox/threads/${encodeURIComponent(threadId)}`
    let answer: Record<string, unknown>
    try {
      answer = await this.request(path, null, 8000, signal)
    } catch (error) {
      // Only the Inbox saying this thread is gone counts as gone; any other refusal (a route an
      // older or newer Inbox does not have, say) is a shape this plugin does not understand.
      if (error instanceof InboxRefused && !(error.status === 404 && error.message === `The Inbox refused ${path}: thread_not_found`)) {
        throw new InboxContractError(`The Inbox would not show a reply's thread (${error.message}).`)
      }
      throw error
    }
    const thread = answer.thread
    if (!isRecord(thread) || !Array.isArray(thread.messages)) throw new InboxContractError('The Inbox answered a thread read in an unknown shape.')
    if (thread.thread_id !== undefined && thread.thread_id !== threadId) throw new InboxContractError('The Inbox answered with another thread.')
    const project = thread.project
    if (!isRecord(project) || typeof project.root !== 'string' || project.root === '') {
      throw new InboxContractError('The Inbox answered a thread read without its project folder.')
    }
    if (thread.messages.length > MAX_THREAD_MESSAGES) throw new InboxContractError('The Inbox thread is too large to check.')
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
    const messages = new Map<string, ThreadMessage>()
    for (const item of thread.messages) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') throw new InboxContractError('The Inbox thread holds a message without an id.')
      // Two messages under one id cannot be told apart: refuse to judge rather than pick one.
      if (messages.has(item.id)) throw new InboxContractError('The Inbox thread holds two messages with the same id.')
      const author = isRecord(item.author) ? item.author : {}
      const to = item.to === undefined || item.to === null ? null : isRecord(item.to) ? item.to : {}
      messages.set(item.id, {
        id: item.id,
        replyTo: text(item.reply_to),
        author: { kind: text(author.kind), host: text(author.host), session: text(author.session) },
        to: to === null ? null : { host: text(to.host), session: text(to.session) },
        createdAt: text(item.created_at)
      })
    }
    return { threadId, root: project.root, messages }
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
