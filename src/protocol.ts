// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Where the plugin stands, most blocking first. Only `ready` delivers replies. */
export type Phase =
  | 'off' // switched off in Settings
  | 'standby' // another adapter already delivers this Inbox's replies
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

/** How one agent reaches the Inbox from an Orca chat. */
export type AgentLink = {
  agent: 'claude' | 'codex'
  name: string
  state:
    | 'connected' // runs this plugin's launcher
    | 'builtin' // Plannotator's own plugin for that agent already handles Orca chats
    | 'plannotator' // runs Plannotator directly: works, but replies do not come back to Orca chats
    | 'other' // a `plannotator-inbox` entry this plugin did not write; left alone
    | 'absent' // the agent is installed, the Inbox is not connected
    | 'missing' // the agent is not installed
  detail: string
}

export type Status = {
  at: number
  phase: Phase
  headline: string
  detail: string | null
  inbox: { dataDir: string; version: string | null; url: string | null }
  orca: { version: string | null }
  sessions: SessionStatus[]
  counts: { inFlight: number; delivered: number; blocked: number }
  blocked: BlockedDelivery[]
  agents: AgentLink[]
}

export type ActionResult = { ok: boolean; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The current status; `fresh` looks again first instead of answering from the last look. */
    'status.get': { input: { fresh?: boolean }; output: Status }
    /** Opens the Inbox window in the browser, starting the Inbox when it is not running. */
    'inbox.open': { output: ActionResult }
    /** Points the agents found on this computer at the launcher. */
    'agents.connect': { input: { agent?: 'claude' | 'codex' }; output: ActionResult }
    /** Puts back what `agents.connect` replaced. */
    'agents.disconnect': { input: { agent?: 'claude' | 'codex' }; output: ActionResult }
    /** A person chose to send a blocked reply again. */
    'delivery.retry': { input: { key: string }; output: ActionResult }
  }
  interface PluginPanelEvents {
    'status.changed': Status
  }
}
