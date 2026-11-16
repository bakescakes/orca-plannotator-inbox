// The plugin's worker. Orca keeps it running while the plugin is enabled (it owns a status bar
// item), so it can hold the reply polls open. Orca transpiles this file when it loads: no build.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { agentLinks, connectAgents, disconnectAgents, findOnPath, type ConnectDeps } from './connect'
import { Engine, type EngineDeps, type EngineSettings, type EngineStatus } from './engine'
import type { KeyValue } from './ledger'
import { resolveDataDir, sharedDir, type Env } from './paths'
import { findProfile } from './orca-cli'
import type { ActionResult, AgentLink, Status } from './protocol'
import { installShared, launcherPath } from './shared'
import { errorText, isRecord, type Json } from './util'

const STATUS_ITEM = 'inbox'
const PREVIEW_STATUS = 'preview.status'

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
  engine: Partial<Pick<EngineDeps, 'exec' | 'fetch' | 'locateCli' | 'profile' | 'legacyConfig' | 'tickMs' | 'now'>>
  connect: Partial<Pick<ConnectDeps, 'run' | 'find'>>
  openInbox?: (dataDir: string) => Promise<ActionResult>
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
  counts: { inFlight: 0, delivered: 0, blocked: 0 },
  blocked: [],
  agents: []
}

function readSettings(raw: Record<string, unknown>): EngineSettings & { notifyBlocked: boolean } {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    enabled: raw.enabled !== false,
    dataDir: text(raw.dataDir),
    orcaCliPath: text(raw.orcaCliPath),
    notifyBlocked: raw.notifyBlocked !== false
  }
}

function openWithPlannotator(env: Env, home: string, dataDir: string, explicitDataDir: boolean): Promise<ActionResult> {
  const explicit = (env.PLANNOTATOR_BIN ?? '').trim()
  const binary = explicit || findOnPath('plannotator', env, home)
  if (!binary) {
    return Promise.resolve({ ok: false, message: 'Plannotator was not found. Install it from https://plannotator.ai, then run `plannotator inbox` once.' })
  }
  const childEnv: Env = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  if (explicitDataDir) childEnv.PLANNOTATOR_DATA_DIR = dataDir
  return new Promise((resolve) => {
    // Plannotator's own "open the window" command: starts the Inbox when needed and returns at once.
    execFile(binary, ['inbox', '--open'], { env: childEnv as NodeJS.ProcessEnv, timeout: 20_000, cwd: home, windowsHide: true }, (error, stdout) => {
      const address = /https?:\/\/\S+/.exec(String(stdout ?? ''))?.[0]
      if (error && !address) resolve({ ok: false, message: `Plannotator could not open the Inbox (${errorText(error)}).` })
      else resolve({ ok: true, message: address ? `The Inbox is open at ${address}` : 'The Inbox is open in your browser.' })
    })
  })
}

function summary(status: Status): string {
  const lines = [`Plannotator Inbox: ${status.headline}${status.detail ? ` — ${status.detail}` : ''}`]
  if (status.inbox.version) lines.push(`Plannotator ${status.inbox.version}${status.orca.version ? `, Orca ${status.orca.version}` : ''}`)
  lines.push(`${status.sessions.length} chat(s) listening; ${status.counts.inFlight} on the way, ${status.counts.delivered} delivered, ${status.counts.blocked} blocked.`)
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
  const settings = async (): Promise<ReturnType<typeof readSettings>> => readSettings(await orca.settings.get().catch(() => ({})))
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

  const refreshAgents = async (): Promise<void> => {
    agents = await agentLinks(connectDeps).catch(() => agents)
  }
  await refreshAgents()

  const engine = new Engine({
    settings,
    store,
    env: runtime.env,
    home: runtime.home,
    sharedDir: runtime.sharedDir,
    log: (message) => orca.log(message),
    onStatus: (status) => {
      publish({ ...status, agents })
      void notifyNewlyBlocked(status).catch(() => undefined)
    },
    ...runtime.engine
  })

  const current = async (fresh: boolean): Promise<Status> => {
    if (fresh) {
      await refreshAgents()
      return { ...(await engine.refresh()), agents }
    }
    return { ...engine.status(), agents }
  }
  const open = async (): Promise<ActionResult> => {
    const { dataDir } = await settings()
    const resolved = resolveDataDir(dataDir, runtime.env, runtime.home)
    const result = await (runtime.openInbox ? runtime.openInbox(resolved) : openWithPlannotator(runtime.env, runtime.home, resolved, dataDir !== ''))
    void engine.refresh().catch(() => undefined)
    return result
  }
  const connect = async (action: typeof connectAgents, agent?: 'claude' | 'codex'): Promise<ActionResult> => {
    let result: ActionResult
    try {
      result = await action(connectDeps, agent)
    } catch (error) {
      result = { ok: false, message: errorText(error) }
    }
    await refreshAgents()
    publish({ ...engine.status(), agents })
    return result
  }

  orca.panels.handle('status.get', (input) => current(input?.fresh === true))
  orca.panels.handle('inbox.open', open)
  orca.panels.handle('agents.connect', (input) => connect(connectAgents, input?.agent))
  orca.panels.handle('agents.disconnect', (input) => connect(disconnectAgents, input?.agent))
  orca.panels.handle('delivery.retry', async (input) => {
    const done = await engine.retry(input.key).catch(() => false)
    return done
      ? { ok: true, message: 'Sending it again.' }
      : { ok: false, message: 'That reply is no longer waiting to be sent again.' }
  })

  orca.commands.register('inbox.open', async () => (await open()).message)
  orca.commands.register('inbox.status', async () => summary(await current(true)))
  orca.commands.register('agents.connect', async () => (await connect(connectAgents)).message)
  orca.commands.register('agents.disconnect', async () => (await connect(disconnectAgents)).message)

  const settingsWatch = orca.settings.onDidChange(() => void engine.refresh().catch(() => undefined))
  engine.start()
  stopRunning = async () => {
    settingsWatch.dispose()
    await engine.stop()
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
