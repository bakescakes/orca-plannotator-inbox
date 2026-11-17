// Keeps the right Orca chats listening for their Inbox replies.
//
// Every few seconds: find the Orca chats that use this Inbox (the launcher's registrations, plus
// chats that wrote before), keep only the ones Orca lists as open native chats on this computer,
// and hold one reply poll per chat. Each reply goes through the courier. Polling is also what
// tells the Inbox a session is connected, so a chat is polled only while every part needed to
// deliver to it works; otherwise replies simply wait in the Inbox.
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Courier, realOrSelf, type Outcome } from './courier'
import { FaceSync } from './faces'
import { InboxClient, InboxContractError, InboxUnavailable, POLL_WAIT_MS, type ThreadAuthor } from './inbox'
import { Activation, Ledger, type KeyValue } from './ledger'
import { OrcaCli, locateOrcaCli, parseInventory, type Exec, type NativeSession } from './orca-cli'
import { resolveDataDir, type Env } from './paths'
import { PresentationSync } from './presentation'
import type { BlockedDelivery, Phase, RejectedDelivery, SessionStatus } from './protocol'
import { readRegistrations, writeHeartbeat } from './shared'
import { errorText, isRecord, sleep } from './util'

export const MAX_ROUTES = 64
const TICK_MS = 10_000
const AUTHORS_EVERY_MS = 60_000
const REPOS_EVERY_MS = 60_000
const PICTURES_EVERY_MS = 60_000
const VERSION_EVERY_MS = 5 * 60_000
const CHAT_PANE = /^structured-agent-session-([A-Za-z0-9_-]{1,160}):/

/**
 * `projects`: absolute folders; when it names any, only chats whose worktree or repository root is
 * one of them or inside one are served. Empty or missing: every project (the default).
 */
export type EngineSettings = {
  enabled: boolean
  dataDir: string
  orcaCliPath: string
  projects?: readonly string[]
  /** Copy each Orca repository's icon to its Inbox project as its picture. Missing: on. */
  pictures?: boolean
  /** Give each Orca chat its agent's icon in the Inbox (Orca build only). Absent: on. */
  agentIcons?: boolean
}
export type EngineStatus = {
  at: number
  phase: Phase
  headline: string
  detail: string | null
  inbox: { dataDir: string; version: string | null; url: string | null }
  orca: { version: string | null }
  sessions: SessionStatus[]
  counts: { inFlight: number; delivered: number; blocked: number; rejected: number }
  blocked: BlockedDelivery[]
  rejected: RejectedDelivery[]
  /** The project folders replies are limited to, as real paths; empty: every project. */
  projects: string[]
}

/**
 * True when `path` is `folder` or inside it. Both must be absolute, normalised real paths. On
 * Windows either slash separates folders, so both are read the same way.
 */
export function isInside(folder: string, path: string, separator: string = sep): boolean {
  const plain = (value: string): string => (separator === '\\' ? value.replaceAll('/', '\\') : value)
  const [outer, inner] = [plain(folder), plain(path)]
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(separator) ? outer : `${outer}${separator}`)
}

/**
 * The chosen project folders as absolute real paths, without repeats; [] for every project. Entries
 * that are not absolute paths are left out (which only narrows the set). Null when the list names
 * folders but none is usable: then no chat is served, rather than every one.
 */
export async function resolveProjects(list: readonly unknown[] | undefined): Promise<string[] | null> {
  const given = (Array.isArray(list) ? list : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (given.length === 0) return []
  const usable = given.filter((entry) => isAbsolute(entry))
  if (usable.length === 0) return null
  return [...new Set(await Promise.all(usable.map((entry) => realOrSelf(resolve(entry)))))]
}

export type EngineDeps = {
  settings: () => Promise<EngineSettings>
  store: KeyValue
  env: Env
  home: string
  sharedDir: string
  log: (message: string) => void
  onStatus: (status: EngineStatus) => void
  now?: () => number
  exec?: Exec
  fetch?: typeof fetch
  locateCli?: typeof locateOrcaCli
  /** The Orca profile this plugin runs in, when known; null uses the CLI's default. */
  profile?: string | null
  tickMs?: number
  /**
   * Chats the Inbox started in Orca (Start in a thread). They are listened for from the start, so
   * the message that started them is delivered like any reply.
   */
  owned?: () => ReadonlyArray<{ session: string; launchId: string; inboxKey: string; project: string; folder: string; agentType?: string | null }>
  /** Whether a reply may go to a chat now: false holds it in the Inbox (a chat a person stopped). */
  gate?: (session: string, reply: { id: string; threadId: string }) => Promise<boolean>
}

type RouteState = {
  session: string
  raw: string
  projectPath: string | null
  /** The chat's own folders (worktree, repository root, the folder its agent runs in): a reply's thread must be in one. */
  roots: string[]
  /** The chat's repository root as a real path, when Orca names one. */
  repoRoot: string | null
  title: string | null
  provider: string | null
  busy: boolean
  listening: boolean
  note: string | null
  stop: AbortController
}
type Look = { phase: Phase; headline: string; detail: string | null }

const HEADLINES: Record<Phase, string> = {
  off: 'Switched off',
  'no-plannotator': 'Plannotator Inbox not found',
  'inbox-stopped': 'Inbox not running',
  'no-orca': 'Orca CLI not available',
  problem: 'Delivery paused',
  ready: 'Ready'
}

const real = realOrSelf

export class Engine {
  private readonly deps: EngineDeps
  private readonly now: () => number
  private readonly ledger: Ledger
  private readonly activation: Activation
  private ledgerLoaded = false
  /** The chosen project folders (real paths); [] for every project. */
  private projects: string[] = []
  private repos: { byId: Map<string, string>; at: number } = { byId: new Map(), at: 0 }
  private faces: { sync: FaceSync; inbox: InboxClient; at: number } | null = null
  private pictures: { sync: PresentationSync; inbox: InboxClient; orca: OrcaCli; at: number } | null = null
  private inbox: InboxClient | null = null
  private orca: OrcaCli | null = null
  private orcaKey = ''
  private orcaVersion: { value: string | null; at: number } | null = null
  private courier: Courier | null = null
  private authors: { list: ThreadAuthor[]; at: number } = { list: [], at: 0 }
  private readonly routes = new Map<string, RouteState>()
  private readonly pollers = new Set<Promise<void>>()
  private readonly stopAll = new AbortController()
  private wake = new AbortController()
  private loop: Promise<void> | null = null
  private last: EngineStatus
  private inboxInfo: { version: string | null; url: string | null } = { version: null, url: null }

  constructor(deps: EngineDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.ledger = new Ledger(deps.store, this.now)
    this.activation = new Activation(deps.store, this.now)
    this.last = {
      at: this.now(),
      phase: 'problem',
      headline: 'Starting',
      detail: null,
      inbox: { dataDir: resolveDataDir(undefined, deps.env, deps.home), version: null, url: null },
      orca: { version: null },
      sessions: [],
      counts: { inFlight: 0, delivered: 0, blocked: 0, rejected: 0 },
      blocked: [],
      rejected: [],
      projects: []
    }
  }

  start(): void {
    if (this.loop) return
    this.loop = (async () => {
      while (!this.stopAll.signal.aborted) {
        await this.look()
        await sleep(this.deps.tickMs ?? TICK_MS, AbortSignal.any([this.stopAll.signal, this.wake.signal]))
        if (this.wake.signal.aborted) this.wake = new AbortController()
      }
    })()
  }

  /** Looks again now and resolves with what it found. */
  async refresh(): Promise<EngineStatus> {
    if (!this.loop || this.stopAll.signal.aborted) return this.last
    await this.look()
    return this.last
  }

  status(): EngineStatus {
    return this.last
  }

  /** How far one Inbox item has got on its way to one chat. */
  deliveryState(session: string, id: string): 'acknowledged' | 'queued' | 'unknown' {
    if (!this.inbox || !this.ledgerLoaded) return 'unknown'
    const row = this.ledger.get(Ledger.key(this.inbox.key, id, session))
    return row?.state === 'acknowledged' ? 'acknowledged' : row?.state === 'accepted' ? 'queued' : 'unknown'
  }

  async retry(key: string): Promise<boolean> {
    if (!this.courier || !this.ledgerLoaded) return false
    const done = await this.courier.retry(key)
    if (done) this.wake.abort()
    return done
  }

  /** Stops polling and says so in the heartbeat, so agents are no longer told replies arrive by themselves. */
  async stop(): Promise<void> {
    this.stopAll.abort()
    this.stopRoutes()
    await this.loop?.catch(() => undefined)
    const settled = new AbortController()
    await Promise.race([Promise.allSettled([...this.pollers]).then(() => settled.abort()), sleep(1500, settled.signal)])
    await writeHeartbeat(this.deps.sharedDir, { at: this.now(), dataDir: this.last.inbox.dataDir, delivering: false, projects: this.projects }).catch(
      () => undefined
    )
  }

  private looking: Promise<void> | null = null

  private look(): Promise<void> {
    // One look at a time: a refresh during a tick waits for that tick instead of racing it.
    this.looking ??= this.lookOnce()
      .catch((error) => this.deps.log(`look failed: ${errorText(error)}`))
      .finally(() => {
        this.looking = null
      })
    return this.looking
  }

  private async lookOnce(): Promise<void> {
    const settings = await this.deps.settings()
    const dataDir = resolveDataDir(settings.dataDir, this.deps.env, this.deps.home)
    if (!this.inbox || this.inbox.dataDir !== dataDir) {
      this.stopRoutes()
      this.inbox = new InboxClient(dataDir, { fetch: this.deps.fetch })
      this.authors = { list: [], at: 0 }
      this.inboxInfo = { version: null, url: null }
    }
    let result: Look
    const projects = await resolveProjects(settings.projects)
    if (projects === null) {
      // Folders were chosen but none can be used: serve nothing rather than every project.
      result = { phase: 'problem', headline: HEADLINES.problem, detail: 'None of the project folders in Settings is an absolute path, so no chat is served.' }
    } else {
      this.projects = projects
      try {
        result = await this.assess(settings, dataDir)
        if (result.phase === 'ready') result = await this.route(dataDir)
      } catch (error) {
        result = { phase: 'problem', headline: HEADLINES.problem, detail: errorText(error) }
      }
    }
    if (result.phase !== 'ready') this.stopRoutes()
    else {
      if (settings.pictures !== false) this.syncPictures()
      if (settings.agentIcons !== false) this.syncFaces()
    }
    // "Delivering" is what the launcher reads to make an Orca chat the author. It holds while the
    // Inbox is merely stopped: the chat's first message starts it, and the next look picks it up.
    const delivering = result.phase === 'ready' || ((result.phase === 'inbox-stopped' || result.phase === 'no-plannotator') && this.orcaVersion !== null)
    // `projects` tells the launcher which chats this worker serves; absent, every one.
    await writeHeartbeat(this.deps.sharedDir, { at: this.now(), dataDir, delivering, projects: this.projects }).catch((error) =>
      this.deps.log(`heartbeat not written: ${errorText(error)}`)
    )
    this.publish(result, dataDir)
  }

  /** Everything that must hold before any chat is polled. */
  private async assess(settings: EngineSettings, dataDir: string): Promise<Look> {
    const at = (phase: Phase, detail: string | null): Look => ({ phase, headline: HEADLINES[phase], detail })
    if (!settings.enabled) return at('off', 'Reply delivery is switched off in Settings. Replies wait in the Inbox.')
    if (!this.ledgerLoaded) {
      await this.ledger.load()
      this.ledgerLoaded = true
    }
    // Replies written before this plugin first served this Inbox are never delivered.
    await this.activation.ensure(this.inbox!.key)
    // Orca first: whether replies can be delivered at all does not depend on the Inbox running,
    // and an agent's first message is what starts a stopped Inbox.
    const command = (this.deps.locateCli ?? locateOrcaCli)(settings.orcaCliPath, this.deps.env)
    if (command === null) return at('no-orca', 'The Orca CLI was not found. Set its path in this plugin’s settings.')
    const key = command.join('\0')
    if (!this.orca || this.orcaKey !== key) {
      this.orca = new OrcaCli({ command, exec: this.deps.exec, env: this.deps.env, profile: this.deps.profile })
      this.orcaKey = key
      this.orcaVersion = null
      this.courier = new Courier(this.orca, this.ledger, this.now, (inboxKey) => this.activation.get(inboxKey))
      this.repos = { byId: new Map(), at: 0 }
      this.stopRoutes()
    }
    if (!this.orcaVersion || this.now() - this.orcaVersion.at > VERSION_EVERY_MS) {
      try {
        this.orcaVersion = { value: await this.orca.version(), at: this.now() }
      } catch (error) {
        this.orcaVersion = null
        return at('no-orca', `Orca’s CLI did not answer (${errorText(error)}).`)
      }
    }
    const inbox = this.inbox!
    let registry
    try {
      registry = await inbox.registry()
    } catch (error) {
      if (error instanceof InboxContractError) return at('problem', error.message)
      throw error
    }
    if (registry === null) {
      return at('no-plannotator', 'The Plannotator Inbox has not run on this computer yet. Install Plannotator, then run `plannotator inbox` once.')
    }
    this.inboxInfo = { version: registry.version, url: registry.url }
    try {
      const health = await inbox.health(this.stopAll.signal)
      this.inboxInfo.version = health.version ?? registry.version
    } catch (error) {
      if (error instanceof InboxUnavailable) return at('inbox-stopped', 'It starts by itself with an agent’s next Inbox message, or when you open it.')
      if (error instanceof InboxContractError) return at('problem', error.message)
      throw error
    }
    return at('ready', null)
  }

  /**
   * Once a minute, in the background: gives each Inbox project the icon of its Orca repository. It
   * never holds up a look, never throws, and only ever replaces a picture this plugin set itself.
   */
  private syncPictures(): void {
    const inbox = this.inbox
    const orca = this.orca
    if (!inbox || !orca) return
    if (!this.pictures || this.pictures.inbox !== inbox || this.pictures.orca !== orca) {
      this.pictures = { sync: new PresentationSync({ inbox, repos: () => orca.repoList(), store: this.deps.store, clock: this.now }), inbox, orca, at: 0 }
    }
    const pictures = this.pictures
    if (this.now() - pictures.at < PICTURES_EVERY_MS) return
    pictures.at = this.now()
    const chats = [...this.routes.values()].map((route) => ({ session: route.session, provider: route.provider, repoRoot: route.repoRoot }))
    void pictures.sync
      .tick(chats)
      .then((report) => {
        const set = report.projects.filter((item) => item.outcome === 'set').length
        if (set > 0) this.deps.log(`project pictures set: ${set}`)
        else if (!report.ok && report.reason && report.reason !== 'busy') this.deps.log(`project pictures not synced: ${report.reason}`)
      })
      .catch(() => undefined)
  }

  /**
   * Once a minute, in the background: gives each Orca chat the icon of the agent it runs. Only the
   * Orca build of Plannotator is asked, and a face a person chose is never replaced.
   */
  private syncFaces(): void {
    const inbox = this.inbox
    if (!inbox) return
    if (!this.faces || this.faces.inbox !== inbox) this.faces = { sync: new FaceSync({ inbox, store: this.deps.store }), inbox, at: 0 }
    const faces = this.faces
    if (this.now() - faces.at < PICTURES_EVERY_MS) return
    faces.at = this.now()
    const launches = new Map((this.deps.owned?.() ?? []).map((owned) => [owned.session, owned.launchId]))
    const chats = [...this.routes.values()].map((route) => ({ agent: launches.get(route.session) ?? route.raw, session: route.raw, provider: route.provider }))
    void faces.sync
      .tick(chats)
      .then((report) => {
        if (report.set > 0) this.deps.log(`agent icons set: ${report.set}`)
        else if (!report.ok && report.reason) this.deps.log(`agent icons not set: ${report.reason}`)
      })
      .catch(() => undefined)
  }

  /** Orca's repositories by id (their root folders), read once a minute; the last good list while Orca cannot say. */
  private async repoRoots(orca: OrcaCli): Promise<Map<string, string>> {
    if (this.now() - this.repos.at <= REPOS_EVERY_MS) return this.repos.byId
    try {
      const result = await orca.call(['repo', 'list'])
      if (!Array.isArray(result.repos) || result.truncated === true) throw new Error('Orca listed its repositories in an unknown shape.')
      const byId = new Map<string, string>()
      for (const repo of result.repos) {
        if (isRecord(repo) && typeof repo.id === 'string' && typeof repo.path === 'string' && isAbsolute(repo.path)) byId.set(repo.id, repo.path)
      }
      this.repos = { byId, at: this.now() }
    } catch (error) {
      this.repos = { byId: this.repos.byId, at: this.now() }
      this.deps.log(`repository list not read: ${errorText(error)}`)
    }
    return this.repos.byId
  }

  /** Works out which chats to poll and starts or stops their polls. */
  private async route(dataDir: string): Promise<Look> {
    const inbox = this.inbox!
    const orca = this.orca!
    /** `cwd`: the folder the chat's agent runs in, as its launcher registered it. */
    type Candidate = { session: string; raw: string; projectPath: string | null; cwd: string | null }
    const candidates = new Map<string, Candidate>()
    if (this.now() - this.authors.at > AUTHORS_EVERY_MS) {
      try {
        this.authors = { list: await inbox.orcaAuthors(this.stopAll.signal), at: this.now() }
      } catch (error) {
        // The thread list is a convenience: chats still register themselves when they send.
        this.authors = { list: this.authors.list, at: this.now() }
        this.deps.log(`thread list not read: ${errorText(error)}`)
      }
    }
    // One chat can have written under two spellings of its id (bare, and with Orca's mail prefix). The
    // Inbox keeps a separate reply queue for each, so each spelling is listened for; the courier still
    // delivers to the chat one reply at a time and records a reply once.
    for (const author of this.authors.list) {
      candidates.set(author.raw, { session: author.session, raw: author.raw, projectPath: author.projectRoot, cwd: null })
    }
    const mine = await real(dataDir)
    const justSent: string[] = []
    for (const registration of await readRegistrations(this.deps.sharedDir, this.now())) {
      if (registration.dataDir !== null && (await real(registration.dataDir)) !== mine) continue
      if (this.now() - registration.at < 60_000) justSent.push(registration.session)
      // The launcher knows the chat's own folder, so it wins over the thread list for the same spelling.
      candidates.set(registration.raw, { session: registration.session, raw: registration.raw, projectPath: registration.projectPath, cwd: registration.projectPath })
    }
    for (const owned of this.deps.owned?.() ?? []) {
      if (owned.inboxKey !== inbox.key || candidates.has(owned.session)) continue
      candidates.set(owned.session, { session: owned.session, raw: owned.session, projectPath: owned.project, cwd: owned.folder })
    }
    if (candidates.size === 0) {
      this.stopRoutes()
      return { phase: 'ready', headline: HEADLINES.ready, detail: 'No Orca chat has used the Inbox yet. A chat starts listening with its first Inbox message.' }
    }
    let open: Map<string, NativeSession>
    const repoOf = new Map<string, string>()
    try {
      // Read here rather than through `orca.inventory()` so that each chat's repository is known too.
      const listing = await orca.call(['worktree', 'ps', '--limit', '1000'])
      open = parseInventory(listing)
      // Orca lists a chat only after its first turn; one the Inbox started was proven by its own tab, so it is reachable now.
      // A chat Orca does list but that was left out above (listed twice) stays out.
      const listed = JSON.stringify(listing)
      for (const chat of this.deps.owned?.() ?? []) {
        if (chat.inboxKey !== inbox.key || open.has(chat.session) || listed.includes(chat.session)) continue
        open.set(chat.session, { session: chat.session, busy: false, provider: chat.agentType ?? null, title: null, workspacePath: chat.folder })
      }
      for (const tree of Array.isArray(listing.worktrees) ? listing.worktrees : []) {
        if (!isRecord(tree) || typeof tree.repoId !== 'string' || !Array.isArray(tree.agents)) continue
        for (const agent of tree.agents) {
          const match = isRecord(agent) && typeof agent.paneKey === 'string' ? CHAT_PANE.exec(agent.paneKey) : null
          if (match) repoOf.set(match[1]!, tree.repoId)
        }
      }
    } catch (error) {
      return { phase: 'no-orca', headline: HEADLINES['no-orca'], detail: `Orca did not list its chats (${errorText(error)}).` }
    }
    const repos = await this.repoRoots(orca)
    /** A chat's folders as real paths: its worktree, its repository root, and where its agent runs. */
    const folders = async (candidate: Candidate, chat: NativeSession): Promise<{ own: string[]; roots: string[]; repoRoot: string | null }> => {
      const repoId = repoOf.get(candidate.session)
      const repoPath = repoId ? (repos.get(repoId) ?? null) : null
      const own = [chat.workspacePath, repoPath].filter((path): path is string => typeof path === 'string' && isAbsolute(path))
      const cwd = candidate.cwd !== null && isAbsolute(candidate.cwd) ? [candidate.cwd] : []
      const realOwn = await Promise.all(own.map((path) => real(resolve(path))))
      const roots = [...new Set([...realOwn, ...(await Promise.all(cwd.map((path) => real(resolve(path)))))])]
      return { own: realOwn, roots, repoRoot: repoPath !== null && isAbsolute(repoPath) ? await real(resolve(repoPath)) : null }
    }
    const reachable = [...candidates.values()].filter((candidate) => open.has(candidate.session))
    const served: Array<Candidate & { roots: string[]; repoRoot: string | null }> = []
    let outside = 0
    for (const candidate of reachable) {
      const { own, roots, repoRoot } = await folders(candidate, open.get(candidate.session)!)
      // Limited to chosen projects: the chat's worktree or repository root must be one of them or inside one.
      if (this.projects.length > 0 && !own.some((path) => this.projects.some((folder) => isInside(folder, path)))) {
        outside += 1
        continue
      }
      served.push({ ...candidate, roots, repoRoot })
    }
    const wanted = served.slice(0, MAX_ROUTES)
    const keep = new Set(wanted.map((candidate) => candidate.raw))
    for (const [raw, route] of this.routes) {
      if (!keep.has(raw)) {
        route.stop.abort()
        this.routes.delete(raw)
      }
    }
    for (const candidate of wanted) {
      const chat = open.get(candidate.session)!
      const existing = this.routes.get(candidate.raw)
      if (existing) {
        existing.busy = chat.busy
        existing.title = chat.title
        existing.provider = chat.provider
        existing.roots = candidate.roots
        existing.repoRoot = candidate.repoRoot
        continue
      }
      const route: RouteState = {
        session: candidate.session,
        raw: candidate.raw,
        projectPath: candidate.projectPath ?? chat.workspacePath,
        roots: candidate.roots,
        repoRoot: candidate.repoRoot,
        title: chat.title,
        provider: chat.provider,
        busy: chat.busy,
        listening: true,
        note: null,
        stop: new AbortController()
      }
      this.routes.set(candidate.raw, route)
      // An escaped rejection would end the whole worker; a poll that dies is found again on the next look.
      const poller: Promise<void> = this.poll(inbox, route)
        .catch((error) => this.deps.log(`poll ended: ${errorText(error)}`))
        .finally(() => this.pollers.delete(poller))
      this.pollers.add(poller)
    }
    const notes: string[] = []
    // A chat that sent a moment ago is open. If Orca does not list it, Orca's chat list changed
    // shape or the chat runs somewhere this plugin cannot reach: say so instead of staying quiet.
    if (justSent.some((session) => !open.has(session))) {
      notes.push('A chat that just used the Inbox is not in Orca\u2019s list of open chats on this computer, so its replies wait in the Inbox.')
    }
    if (wanted.length < served.length) {
      notes.push(`Only the first ${MAX_ROUTES} chats are listened for.`)
    }
    if (outside > 0) {
      notes.push(`${outside} chat(s) outside the chosen projects are not listened for; their replies wait in the Inbox.`)
    }
    return { phase: 'ready', headline: HEADLINES.ready, detail: notes.join(' ') || null }
  }

  /** One chat's reply loop. Ends when the chat closes, the Inbox changes or the plugin stops. */
  private async poll(inbox: InboxClient, route: RouteState): Promise<void> {
    const signal = AbortSignal.any([route.stop.signal, this.stopAll.signal])
    let failures = 0
    let waiting = 0
    while (!signal.aborted) {
      let pause = 0
      try {
        const { commands, invalid } = await inbox.poll(route, route.busy, POLL_WAIT_MS, signal)
        if (signal.aborted) return
        failures = 0
        route.listening = true
        route.note = invalid > 0 ? `${invalid} item(s) from the Inbox could not be read and were left there.` : null
        for (const command of commands) {
          if (signal.aborted) return
          // A chat a person stopped from the Inbox takes nothing until they write again or resume it.
          if (this.deps.gate && !(await this.deps.gate(route.session, { id: command.id, threadId: command.thread_id }).catch(() => false))) {
            pause = Math.max(pause, 15_000)
            continue
          }
          const outcome: Outcome = await this.courier!.deliver(inbox, { session: route.session, raw: route.raw, roots: route.roots }, command)
          // The Inbox hands an unacknowledged reply back on every poll; wait before asking again.
          // A busy chat takes its mail when its turn ends: look again soon at first, then less often.
          if (outcome === 'queued') pause = Math.max(pause, Math.min(15_000, 2000 * (waiting + 1)))
          if (outcome === 'deferred') pause = Math.max(pause, 10_000)
          // Rejected and ignored replies stay unacknowledged in the Inbox, which hands them back on every poll.
          if (outcome === 'blocked' || outcome === 'rejected' || outcome === 'ignored') pause = Math.max(pause, 15_000)
        }
        waiting = pause > 0 ? waiting + 1 : 0
        if (commands.length > 0) this.publishCounts()
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        route.listening = false
        route.note = errorText(error)
        pause = Math.min(60_000, 2000 * 2 ** Math.min(failures, 5))
        if (failures === 1) this.deps.log(`poll for a chat failed: ${errorText(error)}`)
      }
      if (pause > 0) await sleep(pause, signal)
    }
  }

  private stopRoutes(): void {
    for (const route of this.routes.values()) route.stop.abort()
    this.routes.clear()
  }

  private counts(): Pick<EngineStatus, 'counts' | 'blocked' | 'rejected'> {
    if (!this.ledgerLoaded) return { counts: { inFlight: 0, delivered: 0, blocked: 0, rejected: 0 }, blocked: [], rejected: [] }
    const counts = this.ledger.counts()
    const rows = this.ledger.all()
    const latest = (state: 'blocked' | 'rejected'): BlockedDelivery[] =>
      rows
        .filter((row) => row.state === state)
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 20)
        .map((row) => ({ key: row.key, subject: row.subject, session: row.session, error: row.error, updated: row.updated }))
    // Ignored replies (written before activation) are counted nowhere: they are not a problem.
    return {
      counts: { inFlight: counts.prepared + counts.sending + counts.accepted, delivered: counts.acknowledged, blocked: counts.blocked, rejected: counts.rejected },
      blocked: latest('blocked'),
      rejected: latest('rejected')
    }
  }

  private publishCounts(): void {
    this.last = { ...this.last, at: this.now(), ...this.counts(), sessions: this.sessions() }
    this.deps.onStatus(this.last)
  }

  private sessions(): SessionStatus[] {
    // One line per chat, however many spellings of its id are listened for.
    const chats = new Map<string, SessionStatus>()
    for (const route of this.routes.values()) {
      const shown = chats.get(route.session)
      if (shown) {
        shown.listening = shown.listening && route.listening
        shown.note ??= route.note
      } else {
        chats.set(route.session, { session: route.session, title: route.title, provider: route.provider, listening: route.listening, note: route.note })
      }
    }
    return [...chats.values()]
  }

  private publish(look: Look, dataDir: string): void {
    this.last = {
      at: this.now(),
      phase: look.phase,
      headline: look.headline,
      detail: look.detail,
      inbox: { dataDir, ...this.inboxInfo },
      orca: { version: this.orcaVersion?.value ?? null },
      sessions: this.sessions(),
      ...this.counts(),
      projects: this.projects
    }
    this.deps.onStatus(this.last)
  }
}
