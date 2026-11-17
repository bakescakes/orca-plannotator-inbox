// Agent icons. In the Inbox every Orca chat has the host `orca`, so by itself each one would show
// the same neutral icon. The Orca build of Plannotator accepts a face `mark:<host>`: "draw this
// agent with that host's own mark". This module gives each Orca chat the mark of the agent it runs
// (Claude Code, Codex, OpenCode, …), through the same route the Inbox's own face picker uses.
//
// It never replaces a face a person chose: it writes only where the Inbox keeps no face, or the
// face it wrote itself. Standard Plannotator does not know `mark:` faces, so nothing is sent to it.
import type { KeyValue } from './ledger'
import { errorText, isRecord, type Json } from './util'

export const FACES_FEATURE = 'mark-faces'
const STORE_KEY = 'faces.v1'
/** At most this many chats are given a face in one pass; the rest follow on later passes. */
const MAX_PER_PASS = 20
const MAX_REMEMBERED = 500
const HOST = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Orca's agent ids whose Plannotator host name differs. Every other id is its own host name. */
const RENAMED: Readonly<Record<string, string>> = { claude: 'claude-code', opencode2: 'opencode' }

/** The face for one Orca agent id (`claude`, `codex`, …), or null when the id cannot name a host. */
export function faceFor(provider: string | null): string | null {
  if (provider === null) return null
  const host = RENAMED[provider] ?? provider
  return HOST.test(host) ? `mark:${host}` : null
}

export type FaceEntry = { face: string; sessions: string[] }
export type FacesInbox = {
  /** The features the Orca build reports; [] for standard Plannotator. */
  orcaFeatures(timeoutMs?: number): Promise<string[]>
  agentFaces(timeoutMs?: number): Promise<{ serverSession: string | null; faces: Record<string, FaceEntry> }>
  setAgentFace(agent: string, face: string, serverSession: string, timeoutMs?: number): Promise<void>
}
/** `agent`: the id the Inbox lists the chat under (its launch id when the Inbox started it, else its session id). */
export type FaceChat = { agent: string; session: string; provider: string | null }
export type FacesReport = { ok: boolean; set: number; reason?: string }

export class FaceSync {
  private running: Promise<FacesReport> | null = null

  constructor(private readonly deps: { inbox: FacesInbox; store: KeyValue }) {}

  /** One pass; never throws. A pass already running is returned instead of starting a second. */
  tick(chats: readonly FaceChat[]): Promise<FacesReport> {
    if (this.running) return this.running
    const work = this.pass(chats).catch((error): FacesReport => ({ ok: false, set: 0, reason: errorText(error) }))
    this.running = work
    void work.finally(() => {
      if (this.running === work) this.running = null
    })
    return work
  }

  private async remembered(): Promise<Record<string, string>> {
    const saved = await this.deps.store.get(STORE_KEY).catch(() => null)
    const out: Record<string, string> = {}
    if (isRecord(saved) && isRecord(saved.set)) {
      for (const [agent, face] of Object.entries(saved.set)) if (typeof face === 'string') out[agent] = face
    }
    return out
  }

  private async pass(chats: readonly FaceChat[]): Promise<FacesReport> {
    const wanted = new Map<string, { face: string; session: string }>()
    for (const chat of chats) {
      const face = faceFor(chat.provider)
      if (face && !wanted.has(chat.agent)) wanted.set(chat.agent, { face, session: chat.session })
    }
    if (wanted.size === 0) return { ok: true, set: 0 }
    const { inbox, store } = this.deps
    if (!(await inbox.orcaFeatures()).includes(FACES_FEATURE)) return { ok: true, set: 0, reason: 'standard Plannotator' }
    const { serverSession, faces } = await inbox.agentFaces()
    if (serverSession === null) return { ok: false, set: 0, reason: 'the Inbox named no server session' }
    const mine = await this.remembered()
    let set = 0
    for (const [agent, want] of wanted) {
      if (set >= MAX_PER_PASS) break
      // The Inbox files a face under the agent's id, and lists every session id that agent had.
      const kept = faces[agent] ?? Object.values(faces).find((entry) => entry.sessions.includes(agent) || entry.sessions.includes(want.session))
      if (kept && kept.face === want.face) {
        continue
      }
      // Any other face is a person's choice, unless it is one this plugin wrote (the agent changed).
      if (kept && kept.face !== 'agent' && mine[agent] !== kept.face) continue
      // A person put the agent's own mark back after this plugin set one: leave it.
      if (!kept && mine[agent] === want.face) continue
      await inbox.setAgentFace(agent, want.face, serverSession)
      mine[agent] = want.face
      set += 1
    }
    if (set > 0) {
      const kept = Object.entries(mine).slice(-MAX_REMEMBERED)
      await store.set(STORE_KEY, { v: 1, set: Object.fromEntries(kept) } as Json).catch(() => undefined)
    }
    return { ok: true, set }
  }
}
