// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Where the plugin stands, most blocking first. Only `ready` delivers replies. */
export type Phase =
  | 'off' // switched off in Settings
  | 'no-plannotator' // the Plannotator Inbox has never run here
  | 'inbox-stopped' // installed, not running now (it starts with an agent's next message)
  | 'no-orca' // Orca's CLI cannot be run or does not answer
  | 'problem' // something this plugin does not understand; replies stay saved in the Inbox
  | 'ready'

export type SessionStatus = {
  session: string
  title: string | null
  provider: string | null
  /** False while its reply poll is failing. */
  listening: boolean
  note: string | null
}

export type BlockedDelivery = { key: string; subject: string | null; session: string; error: string | null; updated: number }
/**
 * A reply that was not delivered and never will be: its source failed the checks (not a person's
 * reply, another chat's or another project's thread, or gone from the Inbox), or the Inbox handed
 * over something that cannot be sent. It stays unacknowledged in the Inbox. `error` says why.
 */
export type RejectedDelivery = BlockedDelivery

/** The agents this plugin connects with its own writer (the rest go through Plannotator's connector). */
export type OwnAgentId = 'claude' | 'codex' | 'opencode'
/** One agent in the list: an `OwnAgentId`, or the id Plannotator gives any other agent (`gemini`, `cursor`, …). */
export type AgentId = string

/** How one agent reaches the Inbox from an Orca chat. */
export type AgentLink = {
  agent: AgentId
  name: string
  state:
    | 'connected' // runs this plugin's launcher
    | 'builtin' // Plannotator's own plugin for that agent already handles Orca chats
    | 'plannotator' // runs Plannotator directly: works, but replies do not come back to Orca chats
    | 'other' // a `plannotator-inbox` entry this plugin did not write, or settings that cannot be read; left alone
    | 'off' // turned off in Plannotator's Settings
    | 'manual' // only a person can connect it (`detail` says how)
    | 'absent' // the agent is installed, the Inbox is not connected
    | 'missing' // the agent is not installed (Claude Code, Codex and OpenCode only)
  detail: string
}

/**
 * The Orca build of Plannotator: the same Plannotator with Orca support added, downloaded and kept
 * up to date by this plugin. `stock` means agents and the Inbox run the Plannotator on this computer.
 */
export type BuildInfo = {
  mode: 'orca-build' | 'stock'
  version: string | null
  build: string | null
  /** The newest Orca build published, when the last look found one. */
  latestKnown: { version: string; build: string } | null
  /** Why the last download or update did not work, in one sentence. */
  lastError: string | null
  updating: boolean
  phase: string | null
  detail: string | null
  /** A newer Plannotator that is out with no Orca build yet (`since` in ms); absent from older workers. */
  waiting?: { version: string; since: number } | null
  /** The build in use leaves out some Orca changes: `lacks` in plain words, `omitted` the changes' names. */
  reduced?: { lacks: string[]; omitted: string[] } | null
}

/** What the running Inbox is: the Orca build in Orca mode, standard Plannotator, or not running. */
export type ServerMode = 'orca' | 'stock' | 'stopped'

export type Status = {
  at: number
  phase: Phase
  headline: string
  detail: string | null
  inbox: { dataDir: string; version: string | null; url: string | null }
  orca: { version: string | null }
  sessions: SessionStatus[]
  /** `rejected`: replies not delivered because they failed their checks (absent from older workers). */
  counts: { inFlight: number; delivered: number; blocked: number; rejected?: number }
  blocked: BlockedDelivery[]
  /** The most recent rejected replies, newest first (absent from older workers). */
  rejected?: RejectedDelivery[]
  /** The project folders replies are limited to (real paths); empty or absent: every project. */
  projects?: string[]
  agents: AgentLink[]
  /** Absent from older workers and when the Orca build is switched off in Settings. */
  build?: BuildInfo
  server?: ServerMode
}

export type ActionResult = { ok: boolean; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The current status; `fresh` looks again first instead of answering from the last look. */
    'status.get': { input: { fresh?: boolean }; output: Status }
    /** Opens the Inbox window in the browser, starting the Inbox when it is not running. */
    'inbox.open': { output: ActionResult }
    /** Points the agents found on this computer at the launcher. `agent`: only that one of the plugin's own three. */
    'agents.connect': { input: { agent?: OwnAgentId }; output: ActionResult }
    /** Puts back what `agents.connect` replaced. */
    'agents.disconnect': { input: { agent?: OwnAgentId }; output: ActionResult }
    /** Stops the running Inbox and starts it on the Orca build; nothing saved is lost. */
    'inbox.restartOnBuild': { output: ActionResult }
    /** Looks for a newer Orca build now and installs it. */
    'build.check': { output: ActionResult }
    /** A person chose to send a blocked reply again. */
    'delivery.retry': { input: { key: string }; output: ActionResult }
  }
  interface PluginPanelEvents {
    'status.changed': Status
  }
}
