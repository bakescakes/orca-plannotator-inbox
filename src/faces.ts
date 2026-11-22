// Agent icons. In the Inbox every Orca chat has the host `orca`, so by itself each one would show
// the same neutral icon. The Orca build of Plannotator accepts a face `mark:<host>`: "draw this
// agent with that host's own mark". This module gives each Orca chat the mark of the agent it runs
// (Claude Code, Codex, OpenCode, …), through the same route the Inbox's own face picker uses.
//
// A bot's chat (one in a bot's home) gets the bot's own picture from Orca instead (src/bot-avatars.ts),
// the way a person gives an agent "Your own…" picture in the picker: the picture is kept by the Inbox
// and the face names it, `own:<sha256>`. When Orca's picture cannot be read or shown, or the Inbox
// keeps no pictures for agents, the bot's chat has its agent's mark like any other.
//
// It never replaces a face a person chose: it writes only where the Inbox keeps no face and this
// plugin never set one (once it has, no face means the person chose "Agent"), or over the face it
// wrote itself. Standard Plannotator does not know `mark:` faces, so nothing is sent to it.
import { InboxRefused } from './inbox'
import type { KeyValue } from './ledger'
import type { BotRef } from './bot-avatars'
import type { Picture, PictureResult } from './presentation'
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
  /** Keeps a picture for agents' icons and answers its id (the SHA-256 of its bytes). */
  keepAgentPicture(picture: string, serverSession: string, timeoutMs?: number): Promise<string>
}
/** Reads a bot's own picture from Orca (src/bot-avatars.ts). Never throws. */
export type FacesAvatars = { picture(bot: BotRef): Promise<PictureResult> }
/**
 * `agent`: the id the Inbox lists the chat under (its launch id when the Inbox started it, else its session id).
 * `bot`: the bot whose home the chat runs in, when it is a bot's chat; absent or null for any other chat.
 */
export type FaceChat = { agent: string; session: string; provider: string | null; bot?: BotRef | null }
export type FacesReport = { ok: boolean; set: number; reason?: string }

type Wanted = { session: string; mark: string | null; bot: BotRef | null }

/**
 * What this plugin set, at most MAX_REMEMBERED agents, the oldest forgotten first. A chat Orca has
 * now is never forgotten: without its entry, a face a person reset would be set again.
 */
function forgetOldest(mine: Record<string, string>, live: ReadonlySet<string>): Record<string, string> {
  const entries = Object.entries(mine)
  let over = entries.length - MAX_REMEMBERED
  const out: Record<string, string> = {}
  for (const [agent, face] of entries) {
    if (over > 0 && !live.has(agent)) {
      over -= 1
      continue
    }
    out[agent] = face
  }
  return out
}

export class FaceSync {
  private running: Promise<FacesReport> | null = null

  constructor(private readonly deps: { inbox: FacesInbox; store: KeyValue; avatars?: FacesAvatars }) {}

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
    const wanted = new Map<string, Wanted>()
    for (const chat of chats) {
      const mark = faceFor(chat.provider)
      const bot = this.deps.avatars && chat.bot ? chat.bot : null
      if ((mark || bot) && !wanted.has(chat.agent)) wanted.set(chat.agent, { session: chat.session, mark, bot })
    }
    if (wanted.size === 0) return { ok: true, set: 0 }
    const { inbox, store } = this.deps
    if (!(await inbox.orcaFeatures()).includes(FACES_FEATURE)) return { ok: true, set: 0, reason: 'standard Plannotator' }
    const { serverSession, faces } = await inbox.agentFaces()
    if (serverSession === null) return { ok: false, set: 0, reason: 'the Inbox named no server session' }
    const mine = await this.remembered()
    let set = 0
    /** Whether this plugin may give `agent` the face `face` now (see the note at the top). */
    const mayWrite = (agent: string, kept: FaceEntry | undefined, face: string): boolean => {
      // The agent's own mark: no entry, or `agent` beside a name or tile the person gave it.
      if (!kept || kept.face === 'agent') {
        // Only before this plugin ever set it a face. After that, the person chose "Agent" in the
        // picker, and that stays, whatever face this plugin would give it now (a bot's picture changes).
        return mine[agent] === undefined
      }
      if (kept.face === face) return false
      // Any other face is a person's choice, unless it is the one this plugin wrote (the agent or the bot's picture changed).
      return mine[agent] === kept.face
    }
    for (const [agent, want] of wanted) {
      if (set >= MAX_PER_PASS) break
      // The Inbox files a face under the agent's id, and lists every session id that agent had.
      const kept = faces[agent] ?? Object.values(faces).find((entry) => entry.sessions.includes(agent) || entry.sessions.includes(want.session))
      // Read again on every pass, so a picture changed in Orca follows.
      const shown: Picture | null = want.bot ? await this.botPicture(want.bot) : null
      let face = shown ? `own:${shown.digest}` : want.mark
      if (face === null || !mayWrite(agent, kept, face)) continue
      if (shown) {
        try {
          const id = await inbox.keepAgentPicture(shown.url, serverSession)
          if (id !== shown.digest) throw new Error('The Inbox kept the bot’s picture as other bytes.')
        } catch (error) {
          // 409: the Inbox restarted under this pass; the next pass reads it again.
          if (!(error instanceof InboxRefused) || error.status === 409) throw error
          // An Inbox that keeps no pictures for agents, or not this one: the agent's own mark.
          face = want.mark
          if (face === null || !mayWrite(agent, kept, face)) continue
        }
      }
      await inbox.setAgentFace(agent, face, serverSession)
      // Latest last, so the oldest are forgotten first.
      delete mine[agent]
      mine[agent] = face
      set += 1
    }
    if (set > 0) await store.set(STORE_KEY, { v: 1, set: forgetOldest(mine, new Set(wanted.keys())) } as Json).catch(() => undefined)
    return { ok: true, set }
  }

  private async botPicture(bot: BotRef): Promise<Picture | null> {
    const result = await this.deps.avatars!.picture(bot).catch((): PictureResult => ({ ok: false, reason: 'unreadable' }))
    return result.ok ? result.picture : null
  }
}
