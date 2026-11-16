// Keeps the right Orca chats listening for their Inbox replies.
//
// Every few seconds: find the Orca chats that use this Inbox (the launcher's registrations, plus
// chats that wrote before), keep only the ones Orca lists as open native chats on this computer,
// and hold one reply poll per chat. Each reply goes through the courier. Polling is also what
// tells the Inbox a session is connected, so a chat is polled only while every part needed to
// deliver to it works; otherwise replies simply wait in the Inbox.
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Courier, type Outcome } from './courier'
import { InboxClient, InboxContractError, InboxUnavailable, POLL_WAIT_MS, type ThreadAuthor } from './inbox'
import { Ledger, type KeyValue } from './ledger'
import { OrcaCli, locateOrcaCli, type Exec, type NativeSession } from './orca-cli'
import { resolveDataDir, type Env } from './paths'
import type { BlockedDelivery, Phase, SessionStatus } from './protocol'
import { readRegistrations, writeHeartbeat } from './shared'
import { errorText, isRecord, sleep } from './util'

export const MAX_ROUTES = 64
const TICK_MS = 10_000
const AUTHORS_EVERY_MS = 60_000
const VERSION_EVERY_MS = 5 * 60_000
/** The Python adapter this plugin replaces writes its status this often or faster. */
const LEGACY_FRESH_MS = 90_000
/** The name that adapter sends Orca mail under. */
const LEGACY_SENDER = 'plannotator-orca-adapter'

export type EngineSettings = { enabled: boolean; dataDir: string; orcaCliPath: string }
export type EngineStatus = {
  at: number
  phase: Phase
  headline: string
  detail: string | null
  inbox: { dataDir: string; version: string | null; url: string | null }
  orca: { version: string | null }
  sessions: SessionStatus[]
  counts: { inFlight: number; delivered: number; blocked: number }
  blocked: BlockedDelivery[]
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
  /** Where the adapter this plugin replaces keeps its config; null to skip the check. */
  legacyConfig?: string | null
}

type RouteState = {
  session: string
  raw: string
  projectPath: string | null
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
  standby: 'Standing by',
  'no-plannotator': 'Plannotator Inbox not found',
  'inbox-stopped': 'Inbox not running',
  'no-orca': 'Orca CLI not available',
  problem: 'Delivery paused',
  ready: 'Ready'
}

async function real(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

export class Engine {
  private readonly deps: EngineDeps
  private readonly now: () => number
  private readonly ledger: Ledger
  private ledgerLoaded = false
  private inbox: InboxClient | null = null
  private orca: OrcaCli | null = null
  private orcaKey = ''
  private orcaVersion: { value: string | null; at: number } | null = null
  private courier: Courier | null = null
  /** True where the adapter this plugin replaces served this Inbox and has stopped. */
  private tookOver = false
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
    this.last = {
      at: this.now(),
      phase: 'problem',
      headline: 'Starting',
      detail: null,
      inbox: { dataDir: resolveDataDir(undefined, deps.env, deps.home), version: null, url: null },
      orca: { version: null },
      sessions: [],
      counts: { inFlight: 0, delivered: 0, blocked: 0 },
      blocked: []
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
    await writeHeartbeat(this.deps.sharedDir, { at: this.now(), dataDir: this.last.inbox.dataDir, delivering: false }).catch(() => undefined)
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
    try {
      result = await this.assess(settings, dataDir)
      if (result.phase === 'ready') result = await this.route(dataDir)
    } catch (error) {
      result = { phase: 'problem', headline: HEADLINES.problem, detail: errorText(error) }
    }
    if (result.phase !== 'ready') this.stopRoutes()
    // "Delivering" is what the launcher reads to make an Orca chat the author. It holds while the
    // Inbox is merely stopped: the chat's first message starts it, and the next look picks it up.
    const delivering = result.phase === 'ready' || ((result.phase === 'inbox-stopped' || result.phase === 'no-plannotator') && this.orcaVersion !== null)
    await writeHeartbeat(this.deps.sharedDir, { at: this.now(), dataDir, delivering }).catch((error) =>
      this.deps.log(`heartbeat not written: ${errorText(error)}`)
    )
    this.publish(result, dataDir)
  }

  /** Everything that must hold before any chat is polled. */
  private async assess(settings: EngineSettings, dataDir: string): Promise<Look> {
    const at = (phase: Phase, detail: string | null): Look => ({ phase, headline: HEADLINES[phase], detail })
    if (!settings.enabled) return at('off', 'Reply delivery is switched off in Settings. Replies wait in the Inbox.')
    const legacy = await this.legacy(dataDir)
    if (legacy === 'alive') {
      return at('standby', 'Another Plannotator adapter for Orca already delivers replies for this Inbox. This plugin takes over when that adapter is stopped.')
    }
    this.tookOver = legacy === 'stopped'
    if (!this.ledgerLoaded) {
      await this.ledger.load()
      this.ledgerLoaded = true
    }
    // Orca first: whether replies can be delivered at all does not depend on the Inbox running,
    // and an agent's first message is what starts a stopped Inbox.
    const command = (this.deps.locateCli ?? locateOrcaCli)(settings.orcaCliPath, this.deps.env)
    if (command === null) return at('no-orca', 'The Orca CLI was not found. Set its path in this plugin’s settings.')
    const key = command.join('\0')
    if (!this.orca || this.orcaKey !== key) {
      this.orca = new OrcaCli({ command, exec: this.deps.exec, env: this.deps.env, profile: this.deps.profile })
      this.orcaKey = key
      this.orcaVersion = null
      this.courier = new Courier(this.orca, this.ledger, this.now, () => (this.tookOver ? LEGACY_SENDER : null))
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

  /** The Python adapter this plugin replaces, for the same Inbox: alive, stopped, or never set up here. */
  private async legacy(dataDir: string): Promise<'alive' | 'stopped' | 'none'> {
    const path = this.deps.legacyConfig === undefined ? join(this.deps.home, '.config', 'lookout', 'plannotator-adapter.json') : this.deps.legacyConfig
    if (path === null) return 'none'
    let stateDir: string
    try {
      const config: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!isRecord(config) || typeof config.stateDir !== 'string' || !Array.isArray(config.dataDirs)) return 'none'
      const mine = await real(dataDir)
      const served = await Promise.all(config.dataDirs.filter((dir): dir is string => typeof dir === 'string').map(real))
      if (!served.includes(mine)) return 'none'
      stateDir = config.stateDir
    } catch {
      return 'none'
    }
    try {
      const status: unknown = JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8'))
      const at = isRecord(status) && typeof status.at === 'string' ? Date.parse(status.at) : Number.NaN
      return Number.isFinite(at) && Math.abs(this.now() - at) <= LEGACY_FRESH_MS ? 'alive' : 'stopped'
    } catch {
      return 'stopped'
    }
  }

  /** Works out which chats to poll and starts or stops their polls. */
  private async route(dataDir: string): Promise<Look> {
    const inbox = this.inbox!
    const orca = this.orca!
    type Candidate = { session: string; raw: string; projectPath: string | null }
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
      candidates.set(author.raw, { session: author.session, raw: author.raw, projectPath: author.projectRoot })
    }
    const mine = await real(dataDir)
    const justSent: string[] = []
    for (const registration of await readRegistrations(this.deps.sharedDir, this.now())) {
      if (registration.dataDir !== null && (await real(registration.dataDir)) !== mine) continue
      if (this.now() - registration.at < 60_000) justSent.push(registration.session)
      // The launcher knows the chat's own folder, so it wins over the thread list for the same spelling.
      candidates.set(registration.raw, { session: registration.session, raw: registration.raw, projectPath: registration.projectPath })
    }
    if (candidates.size === 0) {
      this.stopRoutes()
      return { phase: 'ready', headline: HEADLINES.ready, detail: 'No Orca chat has used the Inbox yet. A chat starts listening with its first Inbox message.' }
    }
    let open: Map<string, NativeSession>
    try {
      open = await orca.inventory()
    } catch (error) {
      return { phase: 'no-orca', headline: HEADLINES['no-orca'], detail: `Orca did not list its chats (${errorText(error)}).` }
    }
    const wanted = [...candidates.values()].filter((candidate) => open.has(candidate.session)).slice(0, MAX_ROUTES)
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
        continue
      }
      const route: RouteState = {
        session: candidate.session,
        raw: candidate.raw,
        projectPath: candidate.projectPath ?? chat.workspacePath,
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
    if (wanted.length < [...candidates.values()].filter((candidate) => open.has(candidate.session)).length) {
      notes.push(`Only the first ${MAX_ROUTES} chats are listened for.`)
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
          const outcome: Outcome = await this.courier!.deliver(inbox, { session: route.session, raw: route.raw }, command)
          // The Inbox hands an unacknowledged reply back on every poll; wait before asking again.
          // A busy chat takes its mail when its turn ends: look again soon at first, then less often.
          if (outcome === 'queued') pause = Math.max(pause, Math.min(15_000, 2000 * (waiting + 1)))
          if (outcome === 'deferred') pause = Math.max(pause, 10_000)
          if (outcome === 'blocked' || outcome === 'rejected') pause = Math.max(pause, 15_000)
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

  private counts(): Pick<EngineStatus, 'counts' | 'blocked'> {
    if (!this.ledgerLoaded) return { counts: { inFlight: 0, delivered: 0, blocked: 0 }, blocked: [] }
    const counts = this.ledger.counts()
    const blocked = this.ledger
      .all()
      .filter((row) => row.state === 'blocked')
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 20)
      .map((row) => ({ key: row.key, subject: row.subject, session: row.session, error: row.error, updated: row.updated }))
    return {
      counts: { inFlight: counts.prepared + counts.sending + counts.accepted, delivered: counts.acknowledged, blocked: counts.blocked },
      blocked
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
      ...this.counts()
    }
    this.deps.onStatus(this.last)
  }
}
