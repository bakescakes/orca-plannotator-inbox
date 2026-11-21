// Start, Stop, Resume and Open for Orca chats, asked for from the Plannotator Inbox (through the
// bridge in src/bridge.ts). The rules:
//
// - Only a person's own launch in the Inbox can start a chat, and only in one existing, local Orca
//   workspace (limited by the "Only these projects" setting when it lists folders).
// - A launch is recorded, with the operation id Orca will see, before Orca is asked. A launch whose
//   outcome is not known is never repeated as a new one: "Try again" re-asks Orca for that same
//   operation, which Orca answers with the chat it already made. No path starts a second chat.
// - A chat started from the Inbox is owned by that launch. Stop, Resume and Open act only on a chat
//   that exactly one launch owns, and only when the caller names both. Each action carries an id;
//   repeating it replays the first result and never acts twice. An action whose result is unknown
//   is not repeated.
// - Stop and Continue use Orca's own (unpublished) chat requests through bin/session.cjs, after
//   checking that this Orca offers them. When it does not, the answer says so; nothing is guessed
//   and nothing is started in its place.
//
// The ownership record lives in the plugin's own Orca storage (KeyValue), like the delivery record.
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realOrSelf } from './courier'
import { isInside } from './engine'
import { InboxClient, type InboxDeps } from './inbox'
import type { KeyValue } from './ledger'
import { callHelper, helperReveal, openChat, type HelperAnswer, type HelperOptions, type NavigationCli, type Reveal } from './navigation'
import { OrcaRefused, type ChatLaunch, type LifecycleInventory, type LifecycleWorkspace, type PromptKinds, type PromptReader } from './orca-cli'
import { ID, KeyedQueue, canonicalSession, errorText, isRecord, type Json } from './util'

/** Plannotator's provider id → Orca's agent id and the name the Inbox shows. */
export const PROVIDERS: Readonly<Record<string, { nativeAgent: string; name: string }>> = {
  codex: { nativeAgent: 'codex', name: 'Codex in Orca' },
  'claude-code': { nativeAgent: 'claude', name: 'Claude in Orca' },
  opencode: { nativeAgent: 'opencode2', name: 'OpenCode in Orca' }
}
/** A model or effort as the Inbox may name it. */
const CHOICE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNTIME_PANE = /^structured-agent-session-[A-Za-z0-9_-]{1,160}:[0-9a-fA-F-]{36}$/
const STORE_KEY = 'lifecycle.v1'
/** A lifecycle request body bigger than this is refused. */
export const MAX_REQUEST_BYTES = 8192
const MAX_ACTIONS = 2000
const KEEP_ACTIONS_MS = 30 * 24 * 60 * 60 * 1000
const MAX_THREAD_BYTES = 4 * 1024 * 1024
/** How long a proof that a new chat's tab exists (or does not) is reused. */
const PROOF_TTL_MS = 15_000

/** A request that cannot be carried out, with words for the person. Nothing was done. */
export class LifecycleError extends Error {}

export type LaunchState = 'prepared' | 'in-flight' | 'uncertain' | 'created' | 'unsupported-outcome' | 'removed'
const LAUNCH_STATES: readonly string[] = ['prepared', 'in-flight', 'uncertain', 'created', 'unsupported-outcome', 'removed'] satisfies LaunchState[]

/** What a launch was asked to do; frozen when it is first recorded. */
export type LaunchRequest = {
  launchId: string
  threadId: string
  messageId: string
  provider: string
  folder: string
  project: string
  selector: string
  workspaceId: string
  nativeAgent: string
  model?: string
  effort?: string
}
export type LaunchRecord = {
  request: LaunchRequest
  operation: string
  state: LaunchState
  /** `session` once created; `stoppedAt`/`resumeRequestedAt` (ms) once stopped or resumed. */
  result: Record<string, Json> | null
  updated: number
}
type ActionRecord = { request: string; state: 'pending' | 'completed' | 'uncertain'; result: Json | null; updated: number }

/** One chat a launch owns, as Orca shows it now. */
export type OwnedSession = {
  session: string
  launchId: string
  threadId: string
  messageId: string
  /** The Inbox the launch came from (`InboxClient.key`). */
  inboxKey: string
  /** The launch's project folder (the thread's project root). */
  project: string
  folder: string
  workspaceId: string
  selector: string
  agentType: string
  /** True while working, false while not; null when Orca lists no activity for it yet. */
  busy: boolean | null
  state: string
  /** `inventory`: Orca lists it with its activity. `tab`: a new chat, proven by its own tab. */
  proof: 'inventory' | 'tab'
}

/** How far the plugin has got with the replies for one chat. */
export type DeliveryVerdict = 'acknowledged' | 'queued' | 'unknown'
export type DeliveryState = (
  session: string,
  launch: { launchId: string; threadId: string; messageId: string; replyId: string | null }
) => DeliveryVerdict | Promise<DeliveryVerdict>

/** What Start, Stop and Resume need from Orca's CLI. `OrcaCli` has all of it. */
export type LifecycleCli = NavigationCli & {
  lifecycleInventory(): Promise<LifecycleInventory>
  launchChat(launch: ChatLaunch, timeoutMs?: number): Promise<Record<string, unknown>>
} & Partial<PromptReader>

export type NativeAction = 'support' | 'session-proof' | 'prepare-stop' | 'stop' | 'continue'
/** Runs one operation of bin/session.cjs. Must never throw; failures are ok:false answers. */
export type NativeRun = (action: NativeAction, body: Record<string, Json>, cli: LifecycleCli) => Promise<HelperAnswer>

export const SESSION_HELPER = fileURLToPath(new URL('../bin/session.cjs', import.meta.url))

/** The default `NativeRun`: bin/session.cjs, started exactly as the reveal helper is. */
export function helperNative(options: HelperOptions & { helper?: string } = {}): NativeRun {
  return (action, body, cli) => callHelper(options.helper ?? SESSION_HELPER, { ...body, action }, cli, { timeoutMs: 20_000, ...options })
}

/** The Inbox a launch came from: its key, and one thread exactly as the Inbox serves it. */
export type SourceReader = { key: string; thread(threadId: string): Promise<Record<string, unknown>> }

/**
 * Reads launch sources from the Inbox at `dataDir`, over the same loopback route the Inbox window
 * uses (`GET /api/inbox/threads/<id>`). Returns the raw `thread` object.
 */
export function inboxSource(dataDir: string, deps: InboxDeps = {}): SourceReader {
  const client = new InboxClient(dataDir, deps)
  const fetchImpl = deps.fetch ?? fetch
  return {
    key: client.key,
    thread: async (threadId) => {
      if (!ID.test(threadId)) throw new LifecycleError('The launch names a thread this plugin cannot read.')
      const registry = await client.registry().catch(() => null)
      if (!registry) throw new LifecycleError('The Plannotator Inbox is not available to confirm the launch.')
      let response: Response
      try {
        response = await fetchImpl(`http://127.0.0.1:${registry.port}/api/inbox/threads/${encodeURIComponent(threadId)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(8000)
        })
      } catch {
        throw new LifecycleError('The Plannotator Inbox is not answering, so the launch could not be confirmed.')
      }
      const text = await response.text().catch(() => '')
      if (text.length > MAX_THREAD_BYTES) throw new LifecycleError('The launch’s thread is too large to check.')
      if (response.status === 404) throw new LifecycleError('The launch’s thread is no longer in the Inbox.')
      if (response.status !== 200) throw new LifecycleError(`The Inbox would not show the launch’s thread (${response.status}).`)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new LifecycleError('The Inbox answered a thread read with something that is not JSON.')
      }
      if (!isRecord(parsed) || !isRecord(parsed.thread)) throw new LifecycleError('The Inbox answered a thread read in an unknown shape.')
      return parsed.thread
    }
  }
}

export type LifecycleDeps = {
  store: KeyValue
  /** Orca's CLI as it is now; null when it was not found. */
  cli: () => LifecycleCli | null | Promise<LifecycleCli | null>
  /** The Inbox launches come from; null while none is configured. */
  source: () => SourceReader | null
  /**
   * The "Only these projects" folders as absolute real paths: [] for every project, null when the
   * setting names folders but none is usable (then no workspace is offered).
   */
  projects: () => readonly string[] | null
  deliveryState: DeliveryState
  /** Told about each owned chat when it is created, replayed, resumed or delivered to. */
  register?: (owned: OwnedSession) => void | Promise<void>
  /**
   * The kinds of prompt chats wait on, shared with reply delivery so a wait costs one `agent read`.
   * Without it the catalog says nothing about waits.
   */
  prompts?: PromptKinds
  native?: NativeRun
  reveal?: Reveal
  log: (message: string) => void
  now?: () => number
  randomUUID?: () => string
}

/** Sorted-key JSON, so two equal requests always compare equal. */
export function encoded(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(encoded).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encoded(entry)}`).join(',')}}`
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseLaunch(value: unknown): LaunchRecord | null {
  if (!isRecord(value) || !isRecord(value.request)) return null
  const { request, operation, state, result, updated } = value
  const fields = ['launchId', 'threadId', 'messageId', 'provider', 'folder', 'project', 'selector', 'workspaceId', 'nativeAgent'] as const
  if (fields.some((field) => typeof request[field] !== 'string')) return null
  if (request.model !== undefined && typeof request.model !== 'string') return null
  if (request.effort !== undefined && typeof request.effort !== 'string') return null
  if (typeof operation !== 'string' || typeof state !== 'string' || !LAUNCH_STATES.includes(state) || typeof updated !== 'number') return null
  if (result !== null && !isRecord(result)) return null
  return { request: request as unknown as LaunchRequest, operation, state: state as LaunchState, result: (result as Record<string, Json> | null) ?? null, updated }
}

function parseAction(value: unknown): ActionRecord | null {
  if (!isRecord(value) || typeof value.request !== 'string' || typeof value.updated !== 'number') return null
  if (value.state !== 'pending' && value.state !== 'completed' && value.state !== 'uncertain') return null
  return { request: value.request, state: value.state, result: (value.result ?? null) as Json, updated: value.updated }
}

/** The ownership record: launches by `<inbox key>:<launch id>`, actions by `<inbox key>:<action id>`. */
class OwnershipRecord {
  private launches = new Map<string, LaunchRecord>()
  private actions = new Map<string, ActionRecord>()
  private loaded: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly store: KeyValue
  private readonly now: () => number
  constructor(store: KeyValue, now: () => number) {
    this.store = store
    this.now = now
  }

  /** Throws when the saved record cannot be read: acting without it could start a second chat. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const saved = await this.store.get(STORE_KEY)
      if (saved === null || saved === undefined) return
      if (!isRecord(saved) || !isRecord(saved.launches) || !isRecord(saved.actions)) throw new LifecycleError('The saved record of Inbox chats is unreadable; nothing was done.')
      for (const [key, value] of Object.entries(saved.launches)) {
        const row = parseLaunch(value)
        if (!row) throw new LifecycleError('The saved record of Inbox chats has an unknown entry; nothing was done.')
        this.launches.set(key, row)
      }
      for (const [key, value] of Object.entries(saved.actions)) {
        const row = parseAction(value)
        if (!row) throw new LifecycleError('The saved record of Inbox chats has an unknown entry; nothing was done.')
        this.actions.set(key, row)
      }
    })().catch((error: unknown) => {
      this.loaded = null
      throw error
    })
    return this.loaded
  }

  launch(key: string): LaunchRecord | null {
    const row = this.launches.get(key)
    return row ? structuredClone(row) : null
  }
  allLaunches(): Array<[string, LaunchRecord]> {
    return [...this.launches.entries()].map(([key, row]) => [key, structuredClone(row)])
  }
  action(key: string): ActionRecord | null {
    const row = this.actions.get(key)
    return row ? structuredClone(row) : null
  }

  /** Durable before it returns: the caller crosses a process boundary next. */
  async putLaunch(key: string, row: LaunchRecord): Promise<void> {
    this.launches.set(key, structuredClone(row))
    await this.save()
  }
  async setLaunch(key: string, state: LaunchState, result: Record<string, Json> | null): Promise<void> {
    const row = this.launches.get(key)
    if (!row) throw new LifecycleError('No launch is recorded under that id.')
    this.launches.set(key, { ...row, state, result: structuredClone(result), updated: this.now() })
    await this.save()
  }
  async putAction(key: string, row: ActionRecord): Promise<void> {
    this.actions.set(key, structuredClone(row))
    await this.save()
  }

  private save(): Promise<void> {
    const write = this.writing.then(async () => {
      // Old action receipts go first; launches are kept: they are what proves ownership.
      const cutoff = this.now() - KEEP_ACTIONS_MS
      for (const [key, row] of this.actions) if (row.state !== 'pending' && row.updated < cutoff) this.actions.delete(key)
      if (this.actions.size > MAX_ACTIONS) {
        const oldest = [...this.actions.entries()].filter(([, row]) => row.state !== 'pending').sort((a, b) => a[1].updated - b[1].updated)
        for (const [key] of oldest.slice(0, this.actions.size - MAX_ACTIONS)) this.actions.delete(key)
      }
      await this.store.set(STORE_KEY, {
        launches: Object.fromEntries(this.launches) as unknown as Json,
        actions: Object.fromEntries(this.actions) as unknown as Json
      })
    })
    this.writing = write.catch(() => undefined)
    return write
  }
}

/** A workspace with its folders as real paths. */
type Place = LifecycleWorkspace & { realFolder: string; realProject: string }

export type LifecycleAction = 'status' | 'catalog' | 'start' | 'stop' | 'resume' | 'open'
const ACTIONS: readonly string[] = ['status', 'catalog', 'start', 'stop', 'resume', 'open'] satisfies LifecycleAction[]

export class Lifecycle {
  private readonly deps: LifecycleDeps
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly record: OwnershipRecord
  private readonly native: NativeRun
  private readonly reveal: Reveal
  /** Launches with a live attempt in this process. */
  private readonly launching = new Set<string>()
  /** Stop, Resume and Open for one chat run one at a time. */
  private readonly perSession = new KeyedQueue()
  private readonly proofs = new Map<string, { at: number; owned: OwnedSession | null; why: string }>()

  constructor(deps: LifecycleDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.uuid = deps.randomUUID ?? cryptoRandomUUID
    this.record = new OwnershipRecord(deps.store, this.now)
    this.native = deps.native ?? helperNative()
    this.reveal = deps.reveal ?? helperReveal()
  }

  /** One request from the bridge. Throws LifecycleError for a request that cannot be carried out. */
  async handle(action: string, body: unknown = {}): Promise<Record<string, Json>> {
    if (!ACTIONS.includes(action)) throw new LifecycleError('Unsupported lifecycle action.')
    if (!isRecord(body) || Buffer.byteLength(encoded(body)) > MAX_REQUEST_BYTES) throw new LifecycleError('Invalid lifecycle request.')
    await this.record.load()
    switch (action as LifecycleAction) {
      case 'status':
        return this.status(body)
      case 'catalog':
        return this.catalog()
      case 'start':
        return this.start(body)
      case 'stop':
        return this.stop(body)
      case 'resume':
        return this.resume(body)
      case 'open':
        return this.open(body)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reading

  private inbox(): SourceReader {
    const source = this.deps.source()
    if (!source) throw new LifecycleError('No Plannotator Inbox is configured for Orca.')
    return source
  }

  private key(launchId: string): string {
    return `${this.inbox().key}:${launchId}`
  }

  private async cli(): Promise<LifecycleCli> {
    let cli: LifecycleCli | null
    try {
      cli = await this.deps.cli()
    } catch (error) {
      throw new LifecycleError(`Orca’s CLI is not available (${errorText(error)}).`)
    }
    if (!cli) throw new LifecycleError('Orca’s CLI was not found.')
    return cli
  }

  private async inventory(cli: LifecycleCli): Promise<LifecycleInventory> {
    try {
      return await cli.lifecycleInventory()
    } catch (error) {
      throw new LifecycleError(`Orca could not list its workspaces (${errorText(error)}).`)
    }
  }

  private approved(place: Place): boolean {
    const projects = this.deps.projects()
    if (projects === null) return false
    if (projects.length === 0) return true
    return projects.some((folder) => isInside(folder, place.realProject) || isInside(folder, place.realFolder))
  }

  /** The workspaces a chat may be started in: local, in a known repository, in a chosen project. */
  private async places(inventory: LifecycleInventory): Promise<Place[]> {
    const places = await Promise.all(
      inventory.workspaces.map(async (row) => ({ ...row, realFolder: await realOrSelf(row.folder), realProject: await realOrSelf(row.project) }))
    )
    return places.filter((place) => this.approved(place))
  }

  /** The one approved workspace at exactly this folder. */
  private async place(folder: unknown, inventory: LifecycleInventory): Promise<Place> {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096) throw new LifecycleError('An exact local workspace folder is required.')
    const real = await realOrSelf(folder)
    const rows = (await this.places(inventory)).filter((row) => row.realFolder === real)
    if (rows.length !== 1) throw new LifecycleError('That folder is not one Orca workspace this plugin may start chats in.')
    return rows[0]!
  }

  /** Every recorded launch that names this chat, up to `limit`. */
  private sessionRecords(session: string, limit = 2): Array<[string, LaunchRecord]> {
    const found: Array<[string, LaunchRecord]> = []
    for (const [key, row] of this.record.allLaunches()) {
      const named = row.result ? canonicalSession(row.result.session) : null
      if (row.state === 'created' && !named) throw new LifecycleError('The saved record of Inbox chats is incomplete.')
      if (named === session) {
        found.push([key, row])
        if (found.length >= limit) break
      }
    }
    return found
  }

  /**
   * The chat a created launch owns, as Orca shows it now. A chat Orca lists must be in the
   * launch's workspace and run its agent. A new chat Orca lists no activity for yet is proven by
   * its own tab in that exact workspace instead.
   */
  private async owned(row: LaunchRecord, inventory: LifecycleInventory, cli: LifecycleCli): Promise<OwnedSession> {
    const request = row.request
    const session = row.result ? canonicalSession(row.result.session) : null
    if (row.state !== 'created' || !session || session !== row.result?.session) throw new LifecycleError('No chat was created for this launch.')
    const base = {
      session,
      launchId: request.launchId,
      threadId: request.threadId,
      messageId: request.messageId,
      inboxKey: this.inbox().key,
      project: request.project,
      folder: request.folder,
      workspaceId: request.workspaceId,
      selector: request.selector,
      agentType: request.nativeAgent
    }
    const listed = inventory.sessions.get(session)
    if (listed) {
      if (listed.workspaceId !== request.workspaceId || listed.agentType !== request.nativeAgent) {
        throw new LifecycleError('The chat this launch owns is no longer in its workspace.')
      }
      this.proofs.delete(session)
      return { ...base, busy: listed.busy, state: listed.state === 'working' || listed.busy ? 'working' : 'waiting', proof: 'inventory' }
    }
    const cached = this.proofs.get(session)
    if (cached && this.now() - cached.at < PROOF_TTL_MS) {
      if (!cached.owned) throw new LifecycleError(cached.why)
      return cached.owned
    }
    try {
      const found = await this.proveTab(row, session, base, inventory, cli)
      this.proofs.set(session, { at: this.now(), owned: found, why: '' })
      return found
    } catch (error) {
      const why = error instanceof LifecycleError ? error.message : 'The chat this launch owns could not be found.'
      this.proofs.set(session, { at: this.now(), owned: null, why })
      throw new LifecycleError(why)
    }
  }

  private async proveTab(
    row: LaunchRecord,
    session: string,
    base: Omit<OwnedSession, 'busy' | 'state' | 'proof'>,
    inventory: LifecycleInventory,
    cli: LifecycleCli
  ): Promise<OwnedSession> {
    const request = row.request
    if (PROVIDERS[request.provider]?.nativeAgent !== request.nativeAgent) throw new LifecycleError('The launch names an agent this plugin no longer maps.')
    const place = await this.place(request.folder, inventory)
    const project = await realOrSelf(request.project)
    if (place.workspaceId !== request.workspaceId || place.selector !== request.selector || (project !== place.realProject && project !== place.realFolder)) {
      throw new LifecycleError('The launch’s workspace changed.')
    }
    const proof = await this.native('session-proof', { sessionId: session, agent: request.nativeAgent, worktree: place.selector, workspaceId: place.workspaceId }, cli)
    if (!proof.ok) throw new LifecycleError(`Orca does not show the chat this launch owns (${proof.reason}).`)
    const result = proof.result
    if (
      result.sessionId !== session ||
      result.agent !== request.nativeAgent ||
      result.workspaceId !== place.workspaceId ||
      result.tabId !== `structured-agent-session-${session}` ||
      typeof result.pane !== 'string' ||
      !RUNTIME_PANE.test(result.pane) ||
      !result.pane.startsWith(`structured-agent-session-${session}:`)
    ) {
      throw new LifecycleError('Orca showed the chat’s tab in an unexpected shape.')
    }
    return { ...base, busy: null, state: 'unknown', proof: 'tab' }
  }

  /** Every chat a launch owns that Orca shows now. */
  async ownedSessions(inventory?: LifecycleInventory): Promise<OwnedSession[]> {
    await this.record.load()
    const cli = await this.cli()
    const current = inventory ?? (await this.inventory(cli))
    const found: OwnedSession[] = []
    for (const [, row] of this.record.allLaunches()) {
      if (row.state !== 'created') continue
      try {
        found.push(await this.owned(row, current, cli))
      } catch {
        // Not shown now; it is offered again when Orca shows it.
      }
    }
    return found
  }

  /** `GET /api/lifecycle/status[?session=<id>]`: which launches own one chat, or the latest launches. */
  async status(body: Record<string, unknown>): Promise<Record<string, Json>> {
    const keys = Object.keys(body)
    if (keys.length > 0) {
      const session = body.session
      if (keys.length !== 1 || keys[0] !== 'session' || typeof session !== 'string' || canonicalSession(session) !== session) {
        throw new LifecycleError('One exact chat is required for an ownership lookup.')
      }
      const rows = this.sessionRecords(session, 3)
      const launches: Json[] = []
      for (const [key, row] of rows.slice(0, 2)) {
        if (!ID.test(row.request.launchId) || key !== this.key(row.request.launchId) || row.result?.session !== session) {
          throw new LifecycleError('The saved ownership of this chat is incompatible.')
        }
        launches.push({ launchId: row.request.launchId, state: row.state, session })
      }
      return { ok: true, version: 1, session, complete: rows.length < 3, launches }
    }
    const recent = this.record
      .allLaunches()
      .sort((a, b) => b[1].updated - a[1].updated)
      .slice(0, 100)
      .map(([, row]) => ({ launchId: row.request.launchId, state: row.state, session: text(row.result?.session) }))
    return { ok: true, version: 1, launches: recent }
  }

  /**
   * What an owned chat waits on, as the Inbox's run line can word it: `permission` while it holds a
   * permission prompt; null otherwise, and for a question, which the run line would call a
   * permission prompt. From the same prompt kinds reply delivery uses, as far as they are known now:
   * the catalog never waits on a read, which runs in the background for the next catalog.
   */
  private waitingOn(cli: LifecycleCli, inventory: LifecycleInventory, session: string): 'permission' | null {
    const listed = inventory.sessions.get(session)
    const prompts = this.deps.prompts
    if (!prompts || !cli.pendingPromptKind || listed?.waiting !== 'blocked') return null
    const reader: PromptReader = { pendingPromptKind: (chat) => cli.pendingPromptKind!(chat) }
    return prompts.knownKind(reader, session, listed.stateStartedAt) === 'permission' ? 'permission' : null
  }

  /** `GET /api/lifecycle/catalog`: where chats can start, the owned chats, and Orca's projects. */
  async catalog(): Promise<Record<string, Json>> {
    const cli = await this.cli()
    const inventory = await this.inventory(cli)
    const places = await this.places(inventory)
    const sessions: Record<string, Json> = {}
    for (const owned of await this.ownedSessions(inventory)) {
      const row = this.record.launch(this.key(owned.launchId))
      const stoppedAt = typeof row?.result?.stoppedAt === 'number' ? row.result.stoppedAt : 0
      const resumedAt = typeof row?.result?.resumeRequestedAt === 'number' ? row.result.resumeRequestedAt : 0
      const stopped = stoppedAt > resumedAt && owned.busy !== true
      const waiting = stopped ? null : this.waitingOn(cli, inventory, owned.session)
      sessions[owned.session] = { busy: owned.busy, state: stopped ? 'stopped' : owned.state, stopped, workspaceId: owned.workspaceId, ...(waiting ? { waiting } : {}) }
    }
    const projects: Json[] = []
    const seen = new Set<string>()
    const chosen = this.deps.projects()
    for (const repo of inventory.repos) {
      const root = await realOrSelf(repo.path)
      if (!isAbsolute(root) || root.length > 4096 || seen.has(root)) continue
      if (chosen === null || (chosen.length > 0 && !chosen.some((folder) => isInside(folder, root)))) continue
      seen.add(root)
      projects.push({ root, name: repo.name.trim() || root })
      if (projects.length >= 1000) break
    }
    return {
      ok: true,
      version: 1,
      providers: Object.entries(PROVIDERS).map(([id, provider]) => ({ id, nativeAgent: provider.nativeAgent, name: provider.name })),
      workspaces: places.map((place) => ({
        folder: place.folder,
        project: place.realProject,
        selector: place.selector,
        workspaceId: place.workspaceId,
        workspaceKind: place.workspaceKind,
        name: place.name
      })),
      sessions,
      projects
    }
  }

  // -------------------------------------------------------------------------------------------
  // Start

  /**
   * Checks the launch against its source in the Inbox: a message a person wrote in that thread (its
   * first message, or a reply that starts a new agent) which carries this launch, unchanged.
   */
  private async source(body: Record<string, unknown>): Promise<{ project: string }> {
    for (const field of ['launchId', 'threadId', 'messageId'] as const) {
      if (typeof body[field] !== 'string' || !ID.test(body[field] as string)) throw new LifecycleError('Exact launch, thread and message ids are required.')
    }
    const thread = await this.inbox().thread(body.threadId as string)
    const messages = Array.isArray(thread.messages) ? thread.messages : null
    if (!messages || messages.length > 10_000) throw new LifecycleError('The launch’s thread could not be read.')
    const found = messages.filter((message) => isRecord(message) && message.id === body.messageId)
    if (found.length !== 1) throw new LifecycleError('The launch’s message is missing or listed twice.')
    const root = found[0] as Record<string, unknown>
    const launch = root.launch
    const author = isRecord(root.author) ? root.author : {}
    if (author.kind !== 'person' || !isRecord(launch)) throw new LifecycleError('Only a launch a person made in the Inbox can start an Orca chat.')
    if (launch.deleted_at || launch.scratch || launch.clone) throw new LifecycleError('Only an existing Orca workspace can be launched in from here.')
    if (launch.id !== body.launchId || launch.agent !== body.provider || launch.folder !== body.folder) throw new LifecycleError('The launch changed in the Inbox; nothing was started.')
    for (const name of ['model', 'effort'] as const) {
      if ((launch[name] ?? null) !== (body[name] ?? null)) throw new LifecycleError('The launch’s model choice changed in the Inbox; nothing was started.')
    }
    const project = isRecord(thread.project) ? thread.project.root : null
    if (typeof project !== 'string' || !isAbsolute(project)) throw new LifecycleError('The launch’s project folder is not known.')
    return { project }
  }

  /** `POST /api/lifecycle/start`. */
  async start(body: Record<string, unknown>): Promise<Record<string, Json>> {
    if (body.ownerAction !== true) throw new LifecycleError('Only a person’s own action can start a chat.')
    const provider = typeof body.provider === 'string' ? PROVIDERS[body.provider] : undefined
    if (!provider || !Object.hasOwn(PROVIDERS, body.provider as string)) throw new LifecycleError('That agent cannot be started as an Orca chat.')
    for (const name of ['model', 'effort'] as const) {
      const value = body[name]
      if (value !== undefined && value !== null && (typeof value !== 'string' || !CHOICE.test(value))) throw new LifecycleError('The model or effort is not one Orca can be given.')
    }
    if (body.effort && !body.model) throw new LifecycleError('An effort needs a model.')
    const { project } = await this.source(body)
    const cli = await this.cli()
    const place = await this.place(body.folder, await this.inventory(cli))
    const realProject = await realOrSelf(project)
    if (realProject !== place.realProject && realProject !== place.realFolder) throw new LifecycleError('The launch’s project does not hold that workspace.')
    const request: LaunchRequest = {
      launchId: body.launchId as string,
      threadId: body.threadId as string,
      messageId: body.messageId as string,
      provider: body.provider as string,
      folder: body.folder as string,
      project,
      selector: place.selector,
      workspaceId: place.workspaceId,
      nativeAgent: provider.nativeAgent,
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.effort === 'string' ? { effort: body.effort } : {})
    }
    const key = this.key(request.launchId)
    if (this.launching.has(key)) {
      return {
        ok: false,
        blocked: true,
        state: 'in-flight',
        operationId: this.record.launch(key)?.operation ?? null,
        text: 'This launch is already being started. Nothing else was started.'
      }
    }
    this.launching.add(key)
    try {
      return await this.startLocked(body, request, key, cli)
    } finally {
      this.launching.delete(key)
    }
  }

  private async startLocked(body: Record<string, unknown>, request: LaunchRequest, key: string, cli: LifecycleCli): Promise<Record<string, Json>> {
    let row = this.record.launch(key)
    if (row && encoded(row.request) !== encoded(request)) throw new LifecycleError('This launch was already recorded with other details; nothing was started.')
    if (row && row.state === 'created') {
      const owned = await this.owned(row, await this.inventory(cli), cli)
      await this.tell(owned)
      return { ok: true, session: owned.session, ref: owned.session, operationId: row.operation, replayed: true, initialDelivery: 'courier-pending' }
    }
    if (row && (!['uncertain', 'prepared', 'in-flight'].includes(row.state) || body.reconcile !== true)) {
      return {
        ok: false,
        blocked: true,
        state: row.state,
        operationId: row.operation,
        text: 'This launch already has an attempt whose outcome is not settled. Try again to ask Orca about that same attempt; no second chat is started.'
      }
    }
    let operation: string
    if (!row) {
      const support = await this.native('support', { agent: request.nativeAgent, worktree: request.selector }, cli)
      if (!support.ok) return { ok: false, text: `This Orca cannot start a chat from the Inbox (${support.reason}). Nothing was started.` }
      if (support.result.supported !== true) return { ok: false, text: 'This Orca cannot start that agent as a chat in this workspace. Nothing was started.' }
      if ((request.model && support.result.model !== true) || (request.effort && support.result.effort !== true)) {
        return { ok: false, text: 'This Orca cannot start a chat on a chosen model or effort. Choose the default model, or update Orca. Nothing was started.' }
      }
      const at = this.now()
      operation = `${String(Math.trunc(at)).padStart(13, '0')}-${this.uuid().replaceAll('-', '').toLowerCase()}`
      row = { request, operation, state: 'prepared', result: null, updated: at }
      await this.record.putLaunch(key, row)
    } else {
      operation = row.operation
    }
    await this.record.setLaunch(key, 'in-flight', { operationId: operation })

    let answer: Record<string, unknown>
    try {
      answer = await cli.launchChat({
        agent: request.nativeAgent,
        selector: request.selector,
        operationId: operation,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {})
      })
    } catch (error) {
      await this.record.setLaunch(key, 'uncertain', { operationId: operation, ...(error instanceof OrcaRefused ? { error: error.code } : {}) })
      const why = error instanceof OrcaRefused ? `Orca answered ${error.code}` : errorText(error)
      this.deps.log(`lifecycle: the launch’s outcome is not known (${why})`)
      return {
        ok: false,
        blocked: true,
        operationId: operation,
        text: `Orca did not confirm the launch (${why}). Try again to ask Orca about this same launch; a second chat is never started.`
      }
    }
    const outcome = isRecord(answer.outcome) ? answer.outcome : {}
    const session = canonicalSession(outcome.sessionId)
    if (outcome.kind !== 'structured' || !session || session !== outcome.sessionId || answer.worktreeId !== request.workspaceId) {
      await this.record.setLaunch(key, 'unsupported-outcome', {
        operationId: operation,
        outcome: JSON.parse(JSON.stringify(outcome)) as Json,
        worktreeId: typeof answer.worktreeId === 'string' ? answer.worktreeId : null
      })
      return {
        ok: false,
        blocked: true,
        operationId: operation,
        text: 'Orca started something other than a chat in that workspace. It was kept as it is; nothing else was started.'
      }
    }
    await this.record.setLaunch(key, 'created', { session, operationId: operation })
    this.proofs.delete(session)
    const created = this.record.launch(key)!
    try {
      const owned = await this.owned(created, await this.inventory(cli), cli)
      await this.tell(owned)
    } catch (error) {
      return {
        ok: false,
        blocked: true,
        created: true,
        session,
        operationId: operation,
        text: `The chat exists, but Orca does not show it yet (${errorText(error)}). Try again to pick it up; no second chat is started.`
      }
    }
    return { ok: true, session, ref: session, operationId: operation, initialDelivery: 'courier-pending' }
  }

  private async tell(owned: OwnedSession): Promise<void> {
    try {
      await this.deps.register?.(owned)
    } catch (error) {
      this.deps.log(`lifecycle: could not enrol an owned chat (${errorText(error)})`)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Stop, Resume, Open

  private target(body: Record<string, unknown>): { session: string; launchId: string } {
    const session = body.session
    if (body.ownerAction !== true || typeof body.launchId !== 'string' || !ID.test(body.launchId) || typeof session !== 'string' || canonicalSession(session) !== session) {
      throw new LifecycleError('An exact action by a person, naming its launch and chat, is required.')
    }
    return { session, launchId: body.launchId }
  }

  /** The launch that owns this chat: it must name it, and be the only one that does. */
  private ownedRecord(body: Record<string, unknown>): { key: string; row: LaunchRecord } {
    const { session, launchId } = this.target(body)
    const key = this.key(launchId)
    const row = this.record.launch(key)
    if (!row || row.state !== 'created' || row.result?.session !== session) throw new LifecycleError('That chat was not started by this launch.')
    const owners = this.sessionRecords(session)
    if (owners.length !== 1 || owners[0]![0] !== key) throw new LifecycleError('More than one launch names that chat, so nothing was done.')
    return { key, row }
  }

  private async ownedNow(body: Record<string, unknown>, cli: LifecycleCli): Promise<{ key: string; row: LaunchRecord; owned: OwnedSession }> {
    const { key, row } = this.ownedRecord(body)
    return { key, row, owned: await this.owned(row, await this.inventory(cli), cli) }
  }

  /**
   * One action, once. Its id is recorded with the exact request before anything happens; a repeat
   * with the same id replays the first result, a repeat with other details is refused, and an
   * action whose result is not known is not repeated. `perform` throws only when it may have acted.
   */
  private async action(
    kind: string,
    body: Record<string, unknown>,
    cli: LifecycleCli,
    perform: (current: { key: string; row: LaunchRecord; owned: OwnedSession }, actionId: string) => Promise<Record<string, Json>>
  ): Promise<Record<string, Json>> {
    await this.ownedNow(body, cli)
    const actionId = body.actionId
    if (typeof actionId !== 'string' || !UUID.test(actionId)) throw new LifecycleError('A stable action id is required.')
    const key = `${this.inbox().key}:${actionId}`
    const frozen = encoded({ action: kind, body })
    const old = this.record.action(key)
    if (old) {
      if (old.request !== frozen) throw new LifecycleError('That action id already names another request.')
      if (old.state === 'completed' && isRecord(old.result)) return old.result as Record<string, Json>
      return { ok: false, blocked: true, text: 'This action’s result is not known, so it was not repeated. Check the chat in Orca.' }
    }
    await this.record.putAction(key, { request: frozen, state: 'pending', result: null, updated: this.now() })
    let result: Record<string, Json>
    try {
      // Waiting for another action on this chat must not act on what was true before it.
      result = await perform(await this.ownedNow(body, cli), actionId)
    } catch (error) {
      if (error instanceof LifecycleError) {
        result = { ok: false, text: error.message }
      } else {
        this.deps.log(`lifecycle: ${kind} may or may not have happened (${errorText(error)})`)
        result = { ok: false, blocked: true, text: 'Orca did not confirm the action. It was not repeated; check the chat in Orca.' }
        await this.record.putAction(key, { request: frozen, state: 'uncertain', result, updated: this.now() })
        return result
      }
    }
    await this.record.putAction(key, { request: frozen, state: 'completed', result, updated: this.now() })
    // The Inbox's run line shows a refused Stop or Open with this reason; it is kept in the log too.
    const opened = typeof result.opened === 'string' ? ` (${result.opened})` : ''
    this.deps.log(`lifecycle: ${kind} ${result.ok === true ? `done${opened}` : `refused (${typeof result.text === 'string' ? result.text : 'no reason'})`}`)
    return result
  }

  /** `POST /api/lifecycle/stop`. */
  async stop(body: Record<string, unknown>): Promise<Record<string, Json>> {
    const { session } = this.target(body)
    const cli = await this.cli()
    return this.perSession.run(session, () =>
      this.action('stop', body, cli, async ({ key }, actionId) => {
        const operationId = `${String(Math.trunc(this.now())).padStart(13, '0')}-${actionId.replaceAll('-', '').toLowerCase()}`
        // Reading where the chat is sends nothing; whatever fails here, nothing was stopped.
        const prepared = await this.native('prepare-stop', { sessionId: session, operationId }, cli)
        if (!prepared.ok) {
          throw new LifecycleError(
            prepared.code === 'unsupported'
              ? `This Orca does not let the Inbox stop a chat (${prepared.reason}). Stop it in Orca; nothing was changed.`
              : `Orca could not prepare the Stop (${prepared.reason}). Nothing was sent.`
          )
        }
        // From here on, replies written before this moment are held for this chat.
        const before = this.record.launch(key)!
        const previous = before.result?.stoppedAt
        await this.record.setLaunch(key, 'created', { ...(before.result ?? {}), stoppedAt: this.now() })
        const stopped = await this.native('stop', { sessionId: session, prepared: prepared.result as Json }, cli)
        if (stopped.ok) return { ok: true, session, result: stopped.result as Json }
        if (!stopped.started || stopped.code === 'unsupported' || stopped.code === 'changed' || stopped.code === 'refused') {
          // Orca did not stop it: let replies through again as before.
          const latest = this.record.launch(key)!
          const restored: Record<string, Json> = { ...(latest.result ?? {}) }
          if (typeof previous === 'number') restored.stoppedAt = previous
          else delete restored.stoppedAt
          await this.record.setLaunch(key, 'created', restored)
          throw new LifecycleError(`Orca did not stop the chat (${stopped.reason}). Nothing was changed; try again or stop it in Orca.`)
        }
        throw new Error(stopped.reason)
      })
    )
  }

  /**
   * `POST /api/lifecycle/resume`. Clears a Stop so new replies reach the chat again; with
   * `deliver: true` also says how far the plugin has got delivering to it; with `turnItemId`
   * continues one interrupted turn; with `removeAssociation: true` forgets the launch after the
   * person deleted it in the Inbox (the chat and its history stay in Orca).
   */
  async resume(body: Record<string, unknown>): Promise<Record<string, Json>> {
    const { session } = this.target(body)
    const cli = await this.cli()
    return this.perSession.run(session, async () => {
      if (body.removeAssociation === true) {
        // Forgetting asks nothing of Orca, so the chat need not be open; the record must own it.
        const { key, row } = this.ownedRecord(body)
        const thread = await this.inbox().thread(row.request.threadId)
        const messages = Array.isArray(thread.messages) ? thread.messages : []
        const root = messages.find((message) => isRecord(message) && message.id === row.request.messageId)
        const launch = isRecord(root) && isRecord(root.launch) ? root.launch : null
        if (!launch?.deleted_at) throw new LifecycleError('Only deleting the launch in the Inbox can forget its chat.')
        const latest = this.ownedRecord(body).row
        await this.record.setLaunch(key, 'removed', latest.result)
        this.proofs.delete(session)
        return { ok: true, retainedNativeHistory: true }
      }
      const { key, row, owned } = await this.ownedNow(body, cli)
      const turnItemId = body.turnItemId
      if (turnItemId !== undefined && turnItemId !== null && (typeof turnItemId !== 'string' || turnItemId.length < 1 || turnItemId.length > 1024)) {
        throw new LifecycleError('The interrupted turn is not named exactly.')
      }
      await this.tell(owned)
      // Another action may have run meanwhile: merge with the latest record, never an older copy.
      const latest = this.ownedRecord(body).row
      if (encoded(latest.request) !== encoded(row.request)) throw new LifecycleError('The launch changed while it was being resumed.')
      if (latest.result?.stoppedAt !== undefined) await this.record.setLaunch(key, 'created', { ...latest.result, resumeRequestedAt: this.now() })
      if (typeof turnItemId === 'string') {
        return this.action('continue', body, cli, async () => {
          const answer = await this.native('continue', { sessionId: session, turnItemId }, cli)
          if (answer.ok) return { ok: true, session, result: answer.result as Json }
          if (!answer.started || answer.code === 'unsupported' || answer.code === 'refused') {
            throw new LifecycleError(`Orca did not continue the chat (${answer.reason}). Nothing was sent.`)
          }
          throw new Error(answer.reason)
        })
      }
      if (body.deliver === true) {
        const verdict = await this.deps.deliveryState(session, {
          launchId: row.request.launchId,
          threadId: row.request.threadId,
          messageId: row.request.messageId,
          replyId: typeof body.replyId === 'string' && ID.test(body.replyId) ? body.replyId : null
        })
        if (verdict === 'acknowledged' || verdict === 'queued') return { ok: true, session, state: verdict }
        return { ok: false, session, state: 'unknown', text: 'The plugin has not confirmed that this reached the chat yet. It stays saved in the Inbox.' }
      }
      // Orca keeps a chat between turns; nothing needs starting again.
      this.deps.log('lifecycle: resume done')
      return { ok: true, session, retained: true, initialDelivery: 'courier-pending' }
    })
  }

  /** `POST /api/lifecycle/open`: brings the owned chat forward in Orca. */
  async open(body: Record<string, unknown>): Promise<Record<string, Json>> {
    const { session } = this.target(body)
    const cli = await this.cli()
    return this.perSession.run(session, () =>
      this.action('open', body, cli, async ({ owned }): Promise<Record<string, Json>> => {
        if (owned.proof === 'inventory') {
          // Only the chat in the launch's own workspace counts; one that moved is "gone".
          const exact: NavigationCli = {
            navigationTargets: async () => (await cli.navigationTargets()).filter((target) => target.worktreeId === owned.workspaceId),
            activateWorktree: (selector) => cli.activateWorktree(selector),
            ...(cli.launchInfo ? { launchInfo: () => cli.launchInfo!() } : {})
          }
          const outcome = await openChat(session, { cli: () => exact, reveal: this.reveal, log: this.deps.log })
          if (outcome === 'chat' || outcome === 'workspace') return { ok: true, session, opened: outcome }
          const why: Record<string, string> = {
            gone: 'This chat is no longer open in Orca.',
            unsupported: 'Orca cannot open this chat from here.',
            moved: 'This chat changed while Orca was opening it, so nothing else was opened.',
            failed: 'Orca could not be reached to open this chat.'
          }
          return { ok: false, session, text: why[outcome] ?? 'Orca did not open the chat.' }
        }
        // A new chat Orca lists no activity for yet: bring its tab forward, then its workspace.
        const revealed = await this.reveal(session, cli)
        if (revealed.ok && (revealed.sessionId !== session || revealed.workspaceId !== owned.workspaceId)) {
          return { ok: false, session, text: 'Orca answered for another chat; nothing else was opened.' }
        }
        const opened = await cli.activateWorktree(owned.selector).catch(() => undefined)
        if (opened === undefined || (opened !== null && opened !== owned.workspaceId)) {
          return revealed.ok ? { ok: true, session, opened: 'chat' } : { ok: false, session, text: 'Orca could not open this chat’s workspace.' }
        }
        return { ok: true, session, opened: revealed.ok ? 'chat' : 'workspace' }
      })
    )
  }

  // -------------------------------------------------------------------------------------------
  // Delivery

  /**
   * Runs `task` for this chat with no Stop, Resume or Open for it running meanwhile. The courier
   * runs a reply's `deliveryAllowed` check and its send in here, so a Stop pressed while a reply is
   * prepared waits for that send, and every reply checked after it is held. Other chats are not held up.
   */
  exclusive<T>(session: string, task: () => Promise<T>): Promise<T> {
    return this.perSession.run(session, task)
  }

  /**
   * Whether a reply may be delivered to this chat now. A chat no launch owns is not this
   * module's to judge (true). An owned chat that is stopped receives only a person's reply
   * written after the Stop, which also resumes it; older replies are held in the Inbox until it
   * runs again (that newer reply, or Resume), and then go along. A chat two launches name, or
   * whose launch was removed, receives nothing. Never throws.
   */
  async deliveryAllowed(session: string, reply: { id: string; threadId: string }): Promise<boolean> {
    try {
      await this.record.load()
      if (canonicalSession(session) !== session) return false
      const rows = this.sessionRecords(session)
      if (rows.length === 0) return true
      if (rows.length !== 1) return false
      const [key, row] = rows[0]!
      if (row.state !== 'created' || row.result?.session !== session || key !== this.key(row.request.launchId)) return false
      const stoppedAt = row.result.stoppedAt
      if (stoppedAt === undefined) return true
      if (typeof stoppedAt !== 'number' || !Number.isFinite(stoppedAt)) return false
      // Resumed since that Stop, as `catalog` reads it: nothing is held any more.
      const resumedAt = row.result.resumeRequestedAt
      if (typeof resumedAt === 'number' && Number.isFinite(resumedAt) && resumedAt >= stoppedAt) return true
      if (!ID.test(reply.id) || !ID.test(reply.threadId)) return false
      const thread = await this.inbox().thread(reply.threadId)
      const messages = Array.isArray(thread.messages) ? thread.messages : []
      const items = messages.filter((message) => isRecord(message) && message.id === reply.id && isRecord(message.author) && message.author.kind === 'person')
      if (items.length !== 1) return false
      const written = typeof (items[0] as Record<string, unknown>).created_at === 'string' ? Date.parse((items[0] as Record<string, string>).created_at!) : NaN
      if (!Number.isFinite(written) || written <= stoppedAt) return false
      // A person's new reply after the Stop: it resumes the chat.
      const latest = this.record.launch(key)!
      await this.record.setLaunch(key, 'created', { ...(latest.result ?? {}), resumeRequestedAt: written })
      return true
    } catch {
      return false
    }
  }
}
