// Keeps the Inbox's project pictures in step with Orca's repository icons, through the stock Inbox's
// own window routes (`GET /api/inbox/projects`, `POST /api/inbox/projects/:id/picture`). Optional and
// quiet: it never touches delivery, nothing escapes `tick()`, and a picture the person chose is never
// changed.
//
// What it will write: an inline picture (an Orca emoji drawn as a tiny SVG, or an image Orca holds as
// a data URI), at most 512 KB, of a type its first bytes prove, an SVG only after the checks below. A
// remote image URL is never fetched. Only for an Inbox project whose root is exactly the real path of
// a local Orca repository, and only while the project shows no picture or the one this plugin set.
//
// Agent faces are left alone. Stock draws Claude Code's, Codex's and OpenCode's marks only for an
// agent whose host is that program; a native Orca chat routes as host `orca`, and no face id stock
// accepts (`agent`, the glass colours, `transparent`, `totman`, `own:<sha256>`, `set:<set>/<icon>`)
// names a provider mark. Uploading the providers' logos would ship third-party marks in this plugin.
//
// Stock has no compare-and-set, so every write is fenced: the project is read again just before it,
// the intent is saved as pending before the POST, and a pending intent is settled later only by
// reading (the project's marker and the picture's bytes), never by posting again.
import { createHash } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs/promises'
import { InboxRefused, PROJECT_ID, type InboxProjectRow, type InboxProjects } from './inbox'
import type { KeyValue } from './ledger'
import type { OrcaRepo } from './orca-cli'
import { canonicalSession, errorText, isRecord, type Json } from './util'

export const MAX_PICTURE_BYTES = 512 * 1024
/** Stock refuses a longer data URL whatever it decodes to. */
const MAX_DATA_URL = 800_000
export const MAX_ITEMS = 200
export const DEFAULT_BUDGET_MS = 5000
/** No single Inbox call may take longer than this, inside the pass's budget. */
const CALL_MS = 4000
const MAX_STATE_ROWS = 1000

export type Outcome = 'unchanged' | 'set' | 'override' | 'unavailable' | `skipped:${string}`

/** One native Orca chat the engine serves. `repoRoot`, when known, puts its project first. */
export type PresentationChat = { session: string; provider: string | null; repoRoot: string | null }

export type PresentationReport = {
  /** False when the pass could not run at all (`reason` says why); items are then partial or empty. */
  ok: boolean
  reason: string | null
  projects: Array<{ root: string; name: string | null; project: string | null; outcome: Outcome }>
  agents: Array<{ session: string; provider: string | null; outcome: Outcome }>
  /** Items past the per-pass cap, looked at in a later pass. */
  omitted: number
  tookMs: number
}

/** The slice of `InboxClient` this needs. */
export type PresentationInbox = {
  readonly key: string
  projectList(timeoutMs: number): Promise<InboxProjects>
  setProjectPicture(projectId: string, picture: string, serverSession: string, timeoutMs: number): Promise<InboxProjectRow | null>
  projectPicture(projectId: string, timeoutMs: number): Promise<Uint8Array | null>
}

export type PresentationDeps = {
  inbox: PresentationInbox
  /** Orca's repositories (`OrcaCli.repoList`). */
  repos: () => Promise<OrcaRepo[]>
  /** Durable storage for what this plugin set (the plugin's own Orca storage). */
  store: KeyValue
  clock?: () => number
  realpath?: (path: string) => Promise<string>
  budgetMs?: number
}

// ---------------------------------------------------------------------------------------------
// Pictures

export type Picture = { url: string; digest: string; type: string }
export type PictureResult = { ok: true; picture: Picture } | { ok: false; reason: string }

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to))
}

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * The picture to set for an Orca repository icon, or why there is none. Never fetches anything and
 * never reads a file: an emoji is drawn as a tiny SVG, an image must already be inline.
 */
export function picture(icon: unknown): PictureResult {
  if (icon === null || icon === undefined) return { ok: false, reason: 'no-icon' }
  if (!isRecord(icon)) return { ok: false, reason: 'unknown-icon' }
  let type: string
  let raw: Buffer
  if (icon.type === 'lucide') return { ok: false, reason: 'lucide-icon' }
  if (icon.type === 'emoji') {
    const emoji = icon.emoji
    // An emoji is a few code points; anything long, empty or with control characters is not one.
    if (typeof emoji !== 'string' || emoji.trim() === '' || emoji.length > 32 || /[\u0000-\u001f\u007f]/.test(emoji)) {
      return { ok: false, reason: 'bad-emoji' }
    }
    type = 'image/svg+xml'
    raw = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="49" text-anchor="middle" font-size="48">${escapeXml(emoji)}</text></svg>`,
      'utf8'
    )
  } else if (icon.type === 'image') {
    const src = icon.src
    if (typeof src !== 'string' || src === '') return { ok: false, reason: 'unknown-icon' }
    // A GitHub avatar, a favicon service, any URL: never fetched by this plugin.
    if (!src.startsWith('data:')) return { ok: false, reason: 'remote-image' }
    if (src.length > MAX_DATA_URL) return { ok: false, reason: 'too-big' }
    const match = DATA_URL.exec(src)
    if (!match) return { ok: false, reason: 'wrong-type' }
    const body = match[2]!.replace(/\s+/g, '')
    if (!BASE64.test(body)) return { ok: false, reason: 'wrong-type' }
    type = match[1]!.toLowerCase()
    raw = Buffer.from(body, 'base64')
  } else {
    return { ok: false, reason: 'unknown-icon' }
  }
  if (raw.byteLength === 0) return { ok: false, reason: 'wrong-type' }
  if (raw.byteLength > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-big' }
  if (type === 'image/svg+xml') {
    if (!svgIsSafe(raw)) return { ok: false, reason: 'unsafe-svg' }
  } else if (!SIGNATURES[type]?.(raw)) {
    return { ok: false, reason: 'wrong-type' }
  }
  return {
    ok: true,
    picture: { url: `data:${type};base64,${raw.toString('base64')}`, digest: sha256Hex(raw), type }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// The SVG checks, without an XML library: a strict
// reader that refuses whatever it does not fully understand. No DOCTYPE, entity declaration, CDATA or
// processing instruction (but a leading XML declaration); only the five predefined entities and
// character references; one `svg` root; whitelisted elements; no `on*`, `href`, `src` or `style`
// attribute, no URL scheme or `//` in any value, and `url(...)` only as a local `url(#id)`.
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs',
  'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'clipPath'
])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const REFERENCE = /&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos));/y
const TAG = /<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:\s+[^\s=/<>"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y
const ATTRIBUTE = /\s+([^\s=/<>"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g
const XML_DECLARATION = /<\?xml(?:\s[^<>?]*)?\?>/y
const UNSAFE_VALUE = /(?:https?:|data:|javascript:|file:|\/\/)/i
const LOCAL_URL = /^url\(#[A-Za-z0-9_-]+\)$/

/** Text with its references resolved, or null when one is not allowed. */
function resolveReferences(text: string): string | null {
  let out = ''
  let at = 0
  for (;;) {
    const amp = text.indexOf('&', at)
    if (amp === -1) return out + text.slice(at)
    REFERENCE.lastIndex = amp
    const match = REFERENCE.exec(text)
    if (!match) return null
    let value: string
    if (match[3]) value = NAMED[match[3]]!
    else {
      const code = match[1] ? Number.parseInt(match[1], 10) : Number.parseInt(match[2]!, 16)
      if (code === 0 || code > 0x10ffff) return null
      value = String.fromCodePoint(code)
    }
    out += text.slice(at, amp) + value
    at = REFERENCE.lastIndex
  }
}

function attributesAreSafe(source: string): boolean {
  const seen = new Set<string>()
  ATTRIBUTE.lastIndex = 0
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    const key = match[1]!
    if (seen.has(key)) return false
    seen.add(key)
    const value = resolveReferences(match[2] ?? match[3] ?? '')
    if (value === null) return false
    // A namespace name is an identifier, never loaded.
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue
    const local = (key.split(':').pop() ?? '').toLowerCase()
    if (local.startsWith('on') || local === 'href' || local === 'src' || local === 'style') return false
    if (UNSAFE_VALUE.test(value)) return false
    if (value.toLowerCase().includes('url(') && !LOCAL_URL.test(value)) return false
  }
  return true
}

export function svgIsSafe(raw: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return false
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return false
  let at = 0
  XML_DECLARATION.lastIndex = 0
  if (XML_DECLARATION.test(text)) at = XML_DECLARATION.lastIndex
  const open: string[] = []
  let rooted = false
  while (at < text.length) {
    const lt = text.indexOf('<', at)
    const chunk = lt === -1 ? text.slice(at) : text.slice(at, lt)
    if (chunk !== '') {
      // Nothing but space outside the one root element.
      if (open.length === 0 && chunk.trim() !== '') return false
      if (resolveReferences(chunk) === null) return false
    }
    if (lt === -1) break
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end === -1) return false
      at = end + 3
      continue
    }
    TAG.lastIndex = lt
    const match = TAG.exec(text)
    if (!match) return false
    const [whole, closing, name, attributes, selfClosing] = match as unknown as [string, string, string, string, string]
    if (closing) {
      if (attributes.trim() !== '' || selfClosing || open.pop() !== name) return false
    } else {
      const local = name.split(':').pop() ?? ''
      if (open.length === 0) {
        if (rooted || local !== 'svg') return false
        rooted = true
      }
      if (!SVG_ELEMENTS.has(local) || !attributesAreSafe(attributes)) return false
      if (!selfClosing) open.push(name)
    }
    at = lt + whole.length
  }
  return rooted && open.length === 0
}

// ---------------------------------------------------------------------------------------------
// What this plugin set, per Inbox

type ProjectRecord =
  | { status: 'owned'; root: string; digest: string; marker: number }
  | { status: 'override'; root: string }
  /** Saved before the POST; `before` is the owned record it replaces, if any. */
  | { status: 'pending'; root: string; digest: string; before: { digest: string; marker: number } | null }

type State = { v: 1; inbox: string; projects: Record<string, ProjectRecord> }

/** Thrown for a saved record this code does not understand: nothing is written while it is. */
class StateUnreadable extends Error {}
/** The pass ran out of time. */
class OutOfTime extends Error {}

function parseRecord(value: unknown): ProjectRecord | null {
  if (!isRecord(value) || typeof value.root !== 'string') return null
  const { status, root, digest } = value
  if (status === 'override') return { status, root }
  if (typeof digest !== 'string') return null
  if (status === 'owned' && typeof value.marker === 'number') return { status, root, digest, marker: value.marker }
  if (status === 'pending') {
    const before = value.before
    if (before === null) return { status, root, digest, before: null }
    if (isRecord(before) && typeof before.digest === 'string' && typeof before.marker === 'number') {
      return { status, root, digest, before: { digest: before.digest, marker: before.marker } }
    }
  }
  return null
}

function parseState(saved: unknown, inbox: string): State {
  if (saved === null || saved === undefined) return { v: 1, inbox, projects: {} }
  if (!isRecord(saved) || saved.v !== 1 || saved.inbox !== inbox || !isRecord(saved.projects)) {
    throw new StateUnreadable('The saved picture record is unreadable or belongs to another Inbox.')
  }
  const projects: Record<string, ProjectRecord> = {}
  for (const [id, value] of Object.entries(saved.projects)) {
    const record = parseRecord(value)
    if (!PROJECT_ID.test(id) || !record) throw new StateUnreadable('The saved picture record has an unknown entry.')
    projects[id] = record
  }
  return { v: 1, inbox, projects }
}

/** Stock's marker for a set picture: absent (none), or when it was set. Anything else is not understood. */
function markerOf(project: InboxProjectRow): number | null {
  const value = project.picture
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('The Inbox marks a project picture in an unknown way.')
}

// ---------------------------------------------------------------------------------------------

export class PresentationSync {
  private readonly deps: PresentationDeps
  private readonly clock: () => number
  private readonly realpath: (path: string) => Promise<string>
  private readonly budgetMs: number
  private running = false
  private state: State | null = null
  private deadline = 0

  constructor(deps: PresentationDeps) {
    this.deps = deps
    this.clock = deps.clock ?? Date.now
    this.realpath = deps.realpath ?? ((path) => fsRealpath(path))
    this.budgetMs = Math.max(100, Math.min(deps.budgetMs ?? DEFAULT_BUDGET_MS, 60_000))
  }

  /** The storage key for one Inbox's record. */
  static storeKey(inboxKey: string): string {
    return `presentation.v1.${inboxKey.slice(0, 16)}`
  }

  /** One bounded pass. Never throws; a pass already running answers `busy`. */
  async tick(chats: readonly PresentationChat[] = []): Promise<PresentationReport> {
    const started = this.clock()
    const report: PresentationReport = { ok: false, reason: null, projects: [], agents: [], omitted: 0, tookMs: 0 }
    if (this.running) {
      report.reason = 'busy'
      return report
    }
    this.running = true
    try {
      this.deadline = started + this.budgetMs
      await this.pass(Array.isArray(chats) ? chats : [], report)
      report.ok = true
    } catch (error) {
      report.reason = errorText(error)
    } finally {
      this.running = false
      this.state = null
      report.tookMs = Math.max(0, this.clock() - started)
    }
    return report
  }

  private async pass(chats: readonly PresentationChat[], report: PresentationReport): Promise<void> {
    let budget = MAX_ITEMS
    // Faces: see the note at the top. Nothing is read or written for them.
    const sessions = new Set<string>()
    for (const chat of chats) {
      const session = isRecord(chat) ? canonicalSession(chat.session) : null
      if (!session) continue
      if (budget <= 0) {
        report.omitted += 1
        continue
      }
      budget -= 1
      const provider = typeof chat.provider === 'string' ? chat.provider.slice(0, 40) : null
      report.agents.push({ session, provider, outcome: sessions.has(session) ? 'skipped:duplicate' : 'skipped:no-stock-mark' })
      sessions.add(session)
    }

    const { inbox, store } = this.deps
    // Read before anything else: an unreadable record means nothing may be written.
    this.state = parseState(await store.get(PresentationSync.storeKey(inbox.key)), inbox.key)
    const repos = (await this.deps.repos()).filter((repo) => repo.local)
    const listed = await inbox.projectList(this.timeout())

    // The chats' own repositories first, so the cap and the budget favour what is in use.
    const inUse = new Set(chats.map((chat) => (isRecord(chat) && typeof chat.repoRoot === 'string' ? chat.repoRoot : '')))
    const ordered = [...repos.filter((repo) => inUse.has(repo.path)), ...repos.filter((repo) => !inUse.has(repo.path))]
    const done = new Set<string>()
    for (const repo of ordered) {
      if (budget <= 0) {
        report.omitted += 1
        continue
      }
      budget -= 1
      const entry = { root: repo.path, name: repo.displayName, project: null as string | null, outcome: 'unavailable' as Outcome }
      report.projects.push(entry)
      if (this.clock() >= this.deadline) {
        entry.outcome = 'skipped:deferred'
        continue
      }
      try {
        let root: string
        try {
          root = await this.realpath(repo.path)
        } catch {
          entry.outcome = 'skipped:root-missing'
          continue
        }
        entry.root = root
        if (done.has(root)) {
          entry.outcome = 'skipped:duplicate'
          continue
        }
        done.add(root)
        const matches = listed.projects.filter((project) => project.root === root)
        if (matches.length === 0) {
          entry.outcome = 'skipped:no-inbox-project'
          continue
        }
        if (matches.length > 1) {
          entry.outcome = 'skipped:ambiguous-project'
          continue
        }
        const project = matches[0]!
        entry.project = project.id
        if (project.mergedInto !== null) {
          entry.outcome = 'skipped:combined'
          continue
        }
        entry.outcome = await this.project(project, root, repo.repoIcon)
      } catch (error) {
        entry.outcome = error instanceof OutOfTime ? 'skipped:deferred' : 'unavailable'
      }
    }
  }

  /** The time one Inbox call may take; throws once the pass is out of time. */
  private timeout(): number {
    const left = this.deadline - this.clock()
    if (left <= 0) throw new OutOfTime('The picture pass ran out of time.')
    return Math.max(1, Math.min(CALL_MS, left))
  }

  private async put(id: string, record: ProjectRecord | null): Promise<void> {
    const state = this.state!
    if (record === null) delete state.projects[id]
    else {
      if (!(id in state.projects) && Object.keys(state.projects).length >= MAX_STATE_ROWS) {
        throw new Error('The picture record is full.')
      }
      state.projects[id] = record
    }
    // Durable before the caller goes on: the next step may cross to the Inbox.
    await this.deps.store.set(PresentationSync.storeKey(this.deps.inbox.key), state as unknown as Json)
  }

  private async project(current: InboxProjectRow, root: string, icon: unknown): Promise<Outcome> {
    const { inbox } = this.deps
    const id = current.id
    const record = this.state!.projects[id] ?? null
    if (record?.status === 'override') return 'override'
    const marker = markerOf(current)
    if (record?.status === 'pending') return this.settle(id, record, root, current, marker)

    if (record !== null) {
      // A picture changed or removed since this plugin set it is the person's from now on.
      if (record.root !== root || record.marker !== marker) {
        await this.put(id, { status: 'override', root })
        return 'override'
      }
    } else if (marker !== null) {
      // A picture this plugin did not set: never touched.
      await this.put(id, { status: 'override', root })
      return 'override'
    }
    const wanted = picture(icon)
    if (!wanted.ok) return `skipped:${wanted.reason}`
    if (record !== null && record.digest === wanted.picture.digest) return 'unchanged'

    // Read again just before the write: stock offers no compare-and-set.
    const fresh = await inbox.projectList(this.timeout())
    const again = fresh.projects.find((project) => project.id === id)
    if (!again || again.root !== root || again.mergedInto !== null || markerOf(again) !== marker) return 'skipped:changed'
    const timeoutMs = this.timeout()
    await this.put(id, {
      status: 'pending',
      root,
      digest: wanted.picture.digest,
      before: record === null ? null : { digest: record.digest, marker: record.marker }
    })
    let answer: InboxProjectRow | null
    try {
      answer = await inbox.setProjectPicture(id, wanted.picture.url, fresh.serverSession, timeoutMs)
    } catch (error) {
      if (error instanceof InboxRefused) {
        // Stock refuses before it saves anything (409: the Inbox restarted under this read).
        await this.put(id, record)
        return error.status === 409 ? 'skipped:inbox-restarted' : 'skipped:refused'
      }
      // The answer is lost: it may have landed. Stays pending, settled later by reading.
      return 'unavailable'
    }
    const landed = answer === null ? null : markerOf(answer)
    if (answer === null || answer.id !== id || answer.root !== root || landed === null) return 'unavailable'
    await this.put(id, { status: 'owned', root, digest: wanted.picture.digest, marker: landed })
    return 'set'
  }

  /**
   * An earlier write whose answer was lost. Never posted again: the project's marker says whether
   * any picture was set since, and the picture's bytes say whether it is the one this plugin sent.
   */
  private async settle(
    id: string,
    record: Extract<ProjectRecord, { status: 'pending' }>,
    root: string,
    current: InboxProjectRow,
    marker: number | null
  ): Promise<Outcome> {
    if (record.root !== root) {
      await this.put(id, { status: 'override', root })
      return 'override'
    }
    const before = record.before?.marker ?? null
    if (marker !== null && marker === before) {
      // Stock gives every set picture a new marker: nothing landed, and the picture is still ours.
      await this.put(id, { status: 'owned', root, digest: record.before!.digest, marker })
      return 'unchanged'
    }
    if (marker === null) {
      // No picture: the write never landed, or the person removed it. Either way, theirs to decide.
      await this.put(id, { status: 'override', root })
      return 'override'
    }
    const bytes = await this.deps.inbox.projectPicture(current.id, this.timeout())
    if (bytes !== null && sha256Hex(bytes) === record.digest) {
      await this.put(id, { status: 'owned', root, digest: record.digest, marker })
      return 'set'
    }
    await this.put(id, { status: 'override', root })
    return 'override'
  }
}
