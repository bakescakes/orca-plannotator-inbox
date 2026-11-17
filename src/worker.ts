// The plugin's worker. Orca keeps it running while the plugin is enabled (it owns a status bar
// item), so it can hold the reply polls open. Orca transpiles this file when it loads: no build.
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { bridgeConfigPath, startBridge, type Bridge, type BridgeConfig, type BridgeDeps } from './bridge'
import { BuildStore, installUpdater, pluginVersion, type BuildStoreDeps } from './build-store'
import { agentLinks, allAgentLinks, connectAllAgents, disconnectAllAgents, type ConnectDeps } from './connect'
import { Engine, type EngineDeps, type EngineSettings, type EngineStatus } from './engine'
import { InboxClient } from './inbox'
import type { KeyValue } from './ledger'
import type { OwnedSession } from './lifecycle'
import { resolveDataDir, sharedDir, type Env } from './paths'
import { startNavigation, type Navigation, type NavigationDeps } from './navigation'
import { OrcaCli, findProfile, locateOrcaCli } from './orca-cli'
import type { ActionResult, AgentLink, BuildInfo, OwnAgentId, ServerMode, Status } from './protocol'
import { installShared, launcherPath } from './shared'
import { reducedLine, waitingLine } from './build-words'
import { errorText, isRecord, type Json } from './util'

const STATUS_ITEM = 'inbox'
const PREVIEW_STATUS = 'preview.status'
/** How often the worker re-reads which Plannotator is installed and running. */
const BUILD_LOOK_MS = 5_000
/** How long "Check for a new build" waits before it answers that the check goes on. */
const CHECK_ANSWER_MS = 8_000
/** How often the chats the Inbox started are checked against what Orca still shows. */
const OWNED_EVERY_MS = 60_000

/** What the worker takes from the machine. Tests replace parts of it; Orca uses the defaults. */
export type Runtime = {
  env: Env
  home: string
  sharedDir: string
  /** The wrapper shipped in the plugin's bin/, copied to the shared folder on start. */
  wrapperSource: string
  /**
   * True under `orca plugin test` and `orca plugin check`, which run this worker on a mock host.
   * A preview never reads or writes the machine: no Inbox, no Orca CLI, no agent settings.
   */
  preview: boolean
  /** Which Orca profile the CLI is pointed at, and why; logged once. */
  note?: string
  engine: Partial<Pick<EngineDeps, 'exec' | 'fetch' | 'locateCli' | 'profile' | 'tickMs' | 'now'>>
  connect: Partial<Pick<ConnectDeps, 'run' | 'find'>>
  /** Parts of the "Open in Orca" link listener; tests replace how a chat is revealed. */
  navigation?: Partial<Pick<NavigationDeps, 'reveal' | 'port' | 'heartbeatMs'>>
  openInbox?: (dataDir: string) => Promise<ActionResult>
  /** Parts of the bridge the Orca build of Plannotator calls; tests replace how Orca is driven. */
  bridge?: Partial<Pick<BridgeDeps, 'native' | 'reveal' | 'port' | 'heartbeatMs' | 'uid' | 'inbox'>>
  /** Parts of the Orca build's store; tests replace the updater so nothing is downloaded. */
  builds?: Partial<Pick<BuildStoreDeps, 'runUpdater' | 'fetch' | 'now' | 'exec' | 'platform'>>
}

function defaultRuntime(): Runtime {
  const env = process.env as Env
  const home = homedir()
  let note = ''
  const profile = findProfile(fileURLToPath(import.meta.url), (reason) => (note = `using Orca’s default profile: ${reason}`))
  return {
    note: profile ? `using the Orca profile at ${profile}` : note,
    env,
    home,
    sharedDir: sharedDir(env, home),
    wrapperSource: fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url)),
    preview: (env.ORCA_PLUGIN_TEST_ROOT ?? '') !== '',
    engine: { profile },
    connect: {}
  }
}

const IDLE: Status = {
  at: 0,
  phase: 'inbox-stopped',
  headline: 'Inbox not running',
  detail: 'It starts by itself with an agent’s next Inbox message, or when you open it.',
  inbox: { dataDir: '~/.plannotator', version: null, url: null },
  orca: { version: null },
  sessions: [],
  counts: { inFlight: 0, delivered: 0, blocked: 0, rejected: 0 },
  blocked: [],
  rejected: [],
  projects: [],
  agents: []
}

/** The "Only these projects" setting: one folder per line (commas also separate); `~` is the home folder. */
export function readProjects(value: unknown, home: string): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => (entry === '~' ? home : /^~[\\/]/.test(entry) ? join(home, entry.slice(2)) : entry))
}

function readSettings(raw: Record<string, unknown>, home: string): EngineSettings & { notifyBlocked: boolean; links: boolean; orcaBuild: boolean } {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    enabled: raw.enabled !== false,
    dataDir: text(raw.dataDir),
    orcaCliPath: text(raw.orcaCliPath),
    projects: readProjects(raw.projects, home),
    pictures: raw.pictures !== false,
    agentIcons: raw.agentIcons !== false,
    links: raw.links !== false,
    orcaBuild: raw.orcaBuild !== false,
    notifyBlocked: raw.notifyBlocked !== false
  }
}

function summary(status: Status): string {
  const lines = [`Plannotator Inbox: ${status.headline}${status.detail ? ` — ${status.detail}` : ''}`]
  if (status.inbox.version) lines.push(`Plannotator ${status.inbox.version}${status.orca.version ? `, Orca ${status.orca.version}` : ''}`)
  const rejected = status.counts.rejected ?? 0
  lines.push(
    `${status.sessions.length} chat(s) listening; ${status.counts.inFlight} on the way, ${status.counts.delivered} delivered, ${status.counts.blocked} blocked${rejected > 0 ? `, ${rejected} not delivered` : ''}.`
  )
  if (status.build) {
    const build = status.build
    lines.push(
      build.mode === 'orca-build'
        ? `Orca build of Plannotator ${build.version} (${build.build})${status.server === 'stock' ? '; the running Inbox is still standard Plannotator' : ''}`
        : 'Standard Plannotator (no Orca build installed)'
    )
    if (build.waiting) lines.push(waitingLine(build))
    if (build.mode === 'orca-build' && build.reduced) lines.push(reducedLine(build.reduced))
    if (build.lastError) lines.push(`Orca build: ${build.lastError}`)
  }
  if (status.projects && status.projects.length > 0) lines.push(`Only these projects: ${status.projects.join(', ')}`)
  for (const agent of status.agents) lines.push(`${agent.name}: ${agent.detail}`)
  return lines.join('\n')
}

let stopRunning: (() => Promise<void>) | null = null

/** `activate` with parts of the machine replaced; what the tests call. */
export async function start(orca: OrcaWorkerApi, overrides: Partial<Runtime> = {}): Promise<void> {
  const runtime: Runtime = { ...defaultRuntime(), ...overrides }
  const store: KeyValue = {
    get: (key) => orca.storage.get(key),
    set: (key, value: Json) => orca.storage.set(key, value),
    delete: (key) => orca.storage.delete(key)
  }
  const settings = async (): Promise<ReturnType<typeof readSettings>> => readSettings(await orca.settings.get().catch(() => ({})), runtime.home)
  const connectDeps: ConnectDeps = {
    home: runtime.home,
    env: runtime.env,
    launcher: launcherPath(runtime.sharedDir),
    store,
    ...runtime.connect
  }

  let agents: AgentLink[] = []
  let shown = ''
  let knownBlocked: Set<string> | null = null

  const showInStatusBar = (status: Status): void => {
    const trouble = status.counts.blocked > 0 || ['no-orca', 'problem'].includes(status.phase)
    const text = status.counts.blocked > 0 ? `Inbox · ${status.counts.blocked} blocked` : status.phase === 'off' ? 'Inbox off' : 'Inbox'
    const tooltip = `Plannotator Inbox: ${status.headline}${status.phase === 'ready' ? ` · ${status.sessions.length} chat(s) listening` : ''}. Press to open it.`
    const next = JSON.stringify([text, trouble, tooltip])
    if (next === shown) return
    shown = next
    void orca.host
      .call('statusBar.update', { id: STATUS_ITEM, text, icon: 'bell', tone: trouble ? 'warning' : 'neutral', tooltip })
      .catch(() => undefined)
  }

  const publish = (status: Status): void => {
    showInStatusBar(status)
    orca.panels.post('status.changed', status)
  }

  const notifyNewlyBlocked = async (status: EngineStatus): Promise<void> => {
    const keys = new Set(status.blocked.map((row) => row.key))
    const fresh = knownBlocked === null ? [] : status.blocked.filter((row) => !knownBlocked!.has(row.key))
    knownBlocked = keys
    if (fresh.length === 0 || !(await settings()).notifyBlocked) return
    await orca.host
      .call('notifications.show', {
        title: 'A Plannotator Inbox reply needs you',
        body: `${fresh[0]!.subject ?? 'A reply'} could not be confirmed as delivered. Open the Plannotator Inbox panel to decide.`
      })
      .catch(() => undefined)
  }

  if (runtime.preview) {
    // The test kit's mock host: show what a scenario stored, touch nothing else.
    const preview = async (): Promise<Status> => {
      const saved = await orca.storage.get(PREVIEW_STATUS).catch(() => null)
      return isRecord(saved) ? ({ ...IDLE, ...saved } as Status) : IDLE
    }
    const unavailable: ActionResult = { ok: false, message: 'Not available in a preview.' }
    orca.panels.handle('status.get', preview)
    orca.panels.handle('inbox.open', () => unavailable)
    orca.panels.handle('agents.connect', () => unavailable)
    orca.panels.handle('agents.disconnect', () => unavailable)
    orca.panels.handle('delivery.retry', () => unavailable)
    orca.panels.handle('inbox.restartOnBuild', () => unavailable)
    orca.panels.handle('build.check', () => unavailable)
    orca.commands.register('inbox.restartOnBuild', () => unavailable.message)
    orca.commands.register('build.check', () => unavailable.message)
    orca.commands.register('inbox.open', () => unavailable.message)
    orca.commands.register('inbox.status', async () => summary(await preview()))
    orca.commands.register('agents.connect', () => unavailable.message)
    orca.commands.register('agents.disconnect', () => unavailable.message)
    stopRunning = null
    return
  }

  if (runtime.note) orca.log(runtime.note)
  try {
    await installShared(runtime.sharedDir, runtime.wrapperSource)
  } catch (error) {
    orca.log(`launcher not installed: ${errorText(error)}`)
  }

  // The Orca build of Plannotator: this plugin downloads it, checks it and keeps it up to date.
  let upgradeCommand: string[] | null = null
  try {
    upgradeCommand = await installUpdater(runtime.sharedDir, { pluginVersion: await pluginVersion(), env: runtime.env })
  } catch (error) {
    orca.log(`updater not installed: ${errorText(error)}`)
  }
  const builds = new BuildStore({
    sharedDir: runtime.sharedDir,
    env: runtime.env,
    home: runtime.home,
    log: (message) => orca.log(message),
    fetch: runtime.engine.fetch,
    ...runtime.builds
  })
  let build: BuildInfo | undefined
  let server: ServerMode | undefined
  let buildLookedAt = 0

  // The bridge: what the Orca build of Plannotator calls to start, stop, resume and open Orca chats.
  let bridge: Bridge | null = null
  const owned = new Map<string, OwnedSession>()

  /** The running Inbox, read again on every call (a restart moves the port and the token). */
  const inboxNow = async (): Promise<InboxClient> =>
    new InboxClient(resolveDataDir((await settings()).dataDir, runtime.env, runtime.home), { fetch: runtime.engine.fetch })
  /**
   * The plugin's own three, and every other agent Plannotator found. Read when the panel asks for a
   * fresh look and after a connect, never on a timer; the Inbox is only read (GET, short timeouts),
   * and when it cannot be, the other agents of the last good read stand.
   */
  const refreshAgents = async (): Promise<void> => {
    agents = await allAgentLinks(connectDeps, await inboxNow(), agents).catch(() => agents)
  }
  // Start does not wait on the Inbox: the three now, every other agent right after.
  agents = await agentLinks(connectDeps).catch(() => agents)
  void refreshAgents().then(() => publish(whole(engine.status()))).catch(() => undefined)

  const engine = new Engine({
    settings,
    store,
    env: runtime.env,
    home: runtime.home,
    sharedDir: runtime.sharedDir,
    log: (message) => orca.log(message),
    owned: () => [...owned.values()],
    gate: (session, reply) => (bridge ? bridge.lifecycle.deliveryAllowed(session, reply) : Promise.resolve(true)),
    onStatus: (status) => {
      publish(whole(status))
      void notifyNewlyBlocked(status).catch(() => undefined)
      keepBuild()
      void refreshOwned().catch(() => undefined)
    },
    ...runtime.engine
  })

  const whole = (status: EngineStatus): Status => ({ ...status, agents, ...(build ? { build } : {}), ...(server ? { server } : {}) })

  /** Reads which Plannotator is installed and running; publishes when that changed. */
  const lookAtBuild = async (force: boolean): Promise<void> => {
    const now = Date.now()
    if (!force && now - buildLookedAt < BUILD_LOOK_MS) return
    buildLookedAt = now
    const { dataDir, orcaBuild } = await settings()
    const before = JSON.stringify([build, server])
    if (orcaBuild) {
      const [nextBuild, nextServer] = await Promise.all([builds.status(), builds.serverMode(resolveDataDir(dataDir, runtime.env, runtime.home))])
      build = nextBuild
      server = nextServer
    } else {
      build = undefined
      server = undefined
    }
    if (JSON.stringify([build, server]) !== before) publish(whole(engine.status()))
  }
  /** Each look: installs or updates the Orca build when that is due (at most every 6 hours). */
  const keepBuild = (): void => {
    void (async () => {
      if (!(await settings()).orcaBuild) return lookAtBuild(false)
      const work = builds.ensure()
      await lookAtBuild(false)
      await work
      await lookAtBuild(true)
    })().catch(() => undefined)
  }

  const current = async (fresh: boolean): Promise<Status> => {
    if (fresh) {
      await refreshAgents()
      const status = await engine.refresh()
      await lookAtBuild(true).catch(() => undefined)
      return whole(status)
    }
    return whole(engine.status())
  }
  const open = async (): Promise<ActionResult> => {
    const { dataDir } = await settings()
    const resolved = resolveDataDir(dataDir, runtime.env, runtime.home)
    const result = await (runtime.openInbox ? runtime.openInbox(resolved) : builds.openInbox(resolved, dataDir !== ''))
    void engine.refresh().catch(() => undefined)
    return result
  }
  const restartOnBuild = async (): Promise<ActionResult> => {
    const result = await builds.restartInbox()
    void engine.refresh().catch(() => undefined)
    await lookAtBuild(true).catch(() => undefined)
    return result
  }
  const checkBuild = async (): Promise<ActionResult> => {
    if (!(await settings()).orcaBuild) return { ok: false, message: 'The Orca build is switched off in this plugin’s settings.' }
    const work = builds.ensure({ force: true })
    void lookAtBuild(true).catch(() => undefined)
    const done = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_ANSWER_MS))])
    void work.then(() => lookAtBuild(true)).catch(() => undefined)
    if (done === null) return { ok: true, message: 'Looking for a new Orca build. This panel shows the result.' }
    if (done.lastError) return { ok: false, message: done.lastError }
    // A newer Plannotator with no Orca build yet is an answer, not a failure.
    if (done.waiting) return { ok: true, message: waitingLine(done) }
    return done.mode === 'orca-build'
      ? { ok: true, message: `Using the Orca build of Plannotator ${done.version} (${done.build}).` }
      : { ok: true, message: 'No Orca build is installed.' }
  }
  const connect = async (action: typeof connectAllAgents, agent?: OwnAgentId): Promise<ActionResult> => {
    let result: ActionResult
    try {
      result = await action(connectDeps, await inboxNow(), { agent, known: agents })
    } catch (error) {
      result = { ok: false, message: errorText(error) }
    }
    await refreshAgents()
    publish(whole(engine.status()))
    return result
  }

  orca.panels.handle('status.get', (input) => current(input?.fresh === true))
  orca.panels.handle('inbox.open', open)
  orca.panels.handle('agents.connect', (input) => connect(connectAllAgents, input?.agent))
  orca.panels.handle('agents.disconnect', (input) => connect(disconnectAllAgents, input?.agent))
  orca.panels.handle('inbox.restartOnBuild', restartOnBuild)
  orca.panels.handle('build.check', checkBuild)
  orca.panels.handle('delivery.retry', async (input) => {
    const done = await engine.retry(input.key).catch(() => false)
    return done
      ? { ok: true, message: 'Sending it again.' }
      : { ok: false, message: 'That reply is no longer waiting to be sent again.' }
  })

  orca.commands.register('inbox.open', async () => (await open()).message)
  orca.commands.register('inbox.status', async () => summary(await current(true)))
  orca.commands.register('agents.connect', async () => (await connect(connectAllAgents)).message)
  orca.commands.register('agents.disconnect', async () => (await connect(disconnectAllAgents)).message)
  orca.commands.register('inbox.restartOnBuild', async () => (await restartOnBuild()).message)
  orca.commands.register('build.check', async () => (await checkBuild()).message)

  const cliNow = async (): Promise<OrcaCli | null> => {
    const command = (runtime.engine.locateCli ?? locateOrcaCli)((await settings()).orcaCliPath, runtime.env)
    return command ? new OrcaCli({ command, exec: runtime.engine.exec, env: runtime.env, profile: runtime.engine.profile ?? null }) : null
  }

  // With the Orca build in use, Plannotator reads `bridge/config.json` and calls the bridge. With
  // it switched off there is no config file, so the launcher and "Open Inbox" use standard Plannotator.
  // The chats the Inbox started that Orca still shows. Read again once a minute, so a chat closed
  // in Orca is no longer listened for; when Orca cannot be asked, the last list stands.
  let ownedAt = 0
  const refreshOwned = async (force = false): Promise<void> => {
    const running = bridge
    if (running === null || (!force && Date.now() - ownedAt < OWNED_EVERY_MS)) return
    ownedAt = Date.now()
    let now: OwnedSession[]
    try {
      now = await running.lifecycle.ownedSessions()
    } catch {
      return
    }
    if (bridge !== running) return
    owned.clear()
    for (const chat of now) owned.set(chat.session, chat)
  }

  let bridgeWork: Promise<void> = Promise.resolve()
  const applyBridge = (stop = false): Promise<void> => {
    bridgeWork = bridgeWork.then(async () => {
      const current = await settings()
      const on = !stop && current.orcaBuild
      const config: BridgeConfig = {
        dataDir: resolveDataDir(current.dataDir, runtime.env, runtime.home),
        launcher: launcherPath(runtime.sharedDir),
        upgradeCommand,
        projects: current.projects ?? []
      }
      if (on && bridge === null) {
        try {
          bridge = await startBridge({
            sharedDir: runtime.sharedDir,
            config,
            cli: cliNow,
            store,
            status: () => engine.status(),
            deliveryState: (session, launch) => engine.deliveryState(session, launch.replyId ?? launch.messageId),
            register: (chat) => {
              owned.set(chat.session, chat)
              void engine.refresh().catch(() => undefined)
            },
            log: (message) => orca.log(message),
            inbox: { fetch: runtime.engine.fetch },
            ...runtime.bridge
          })
          await refreshOwned(true)
        } catch (error) {
          orca.log(`Starting chats from the Inbox is off: ${errorText(error)}`)
        }
      } else if (on && bridge !== null) {
        await bridge.configure(config).catch((error) => orca.log(`bridge settings not applied: ${errorText(error)}`))
      } else if (bridge !== null) {
        const running = bridge
        bridge = null
        owned.clear()
        await running.stop().catch(() => undefined)
      }
      // Switched off (not merely stopping with Orca): Plannotator must no longer be started in Orca mode.
      if (!stop && !current.orcaBuild) await rm(bridgeConfigPath(runtime.sharedDir), { force: true }).catch(() => undefined)
    })
    return bridgeWork
  }
  await applyBridge()

  // "Open in Orca" links: a listener on this computer only, which the launcher signs links for.
  // While it is not running the launcher adds no link, so switching the setting off removes them.
  let navigation: Navigation | null = null
  let navigationWork: Promise<void> = Promise.resolve()
  const applyLinks = (wanted: boolean | null): Promise<void> => {
    navigationWork = navigationWork.then(async () => {
      const on = wanted ?? (await settings()).links
      if (on && navigation === null) {
        navigation = await startNavigation({
          sharedDir: runtime.sharedDir,
          log: (message) => orca.log(message),
          cli: cliNow,
          ...runtime.navigation
        }).catch((error) => {
          orca.log(`"Open in Orca" links are off: ${errorText(error)}`)
          return null
        })
      } else if (!on && navigation !== null) {
        const running = navigation
        navigation = null
        await running.stop().catch(() => undefined)
      }
    })
    return navigationWork
  }
  await applyLinks(null)

  const settingsWatch = orca.settings.onDidChange(() => {
    void engine.refresh().catch(() => undefined)
    void applyLinks(null).catch(() => undefined)
    void applyBridge().catch(() => undefined)
  })
  engine.start()
  stopRunning = async () => {
    settingsWatch.dispose()
    await Promise.all([engine.stop(), applyLinks(false).catch(() => undefined), applyBridge(true).catch(() => undefined)])
  }
}

export default function activate(orca: OrcaWorkerApi): Promise<void> {
  return start(orca)
}

/** Orca waits up to 2 s for this before it stops the worker. */
export async function deactivate(): Promise<void> {
  const stop = stopRunning
  stopRunning = null
  await stop?.()
}
