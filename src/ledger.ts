// The delivery record. Each reply gets one row before anything leaves this process, with the
// request id Orca will see: a crash, a lost answer or a restart then resumes the same request
// instead of sending the reply twice. Kept in the plugin's own Orca storage, which survives
// plugin and Orca updates.
import { randomUUID } from 'node:crypto'
import { isRecord, sha256, type Json } from './util'

/** The slice of Orca's `StorageApi` the ledger needs. */
export type KeyValue = {
  get(key: string): Promise<unknown>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
}

export type DeliveryState =
  | 'prepared' // recorded; not handed to Orca yet
  | 'sending' // handed to Orca; the answer is not known yet
  | 'accepted' // Orca queued it for the chat
  | 'acknowledged' // the chat received it and the Inbox was told
  | 'blocked' // needs a person: it may or may not have been sent
  | 'rejected' // the Inbox handed over something that cannot be delivered, or a reply whose source failed its checks
  | 'ignored' // written before the plugin was first activated for this Inbox: never delivered, not a problem

export type Delivery = {
  request: string
  state: DeliveryState
  session: string
  replyId: string
  threadId: string | null
  subject: string | null
  message: string | null
  mailbox: string | null
  error: string | null
  updated: number
}
export type Envelope = { session: string; subject: string; body: string; payload: string }
type SettledFields = { session: string; replyId: string; threadId?: string | null; subject?: string | null }

const LEDGER_KEY = 'ledger.v1'
const MAX_ROWS = 300
const KEEP_SETTLED_MS = 14 * 24 * 60 * 60 * 1000
const ACTIVATION_KEY = 'activation.v1'
const STATES: readonly string[] = ['prepared', 'sending', 'accepted', 'acknowledged', 'blocked', 'rejected', 'ignored'] satisfies DeliveryState[]
const SETTLED: ReadonlySet<DeliveryState> = new Set(['acknowledged', 'rejected', 'ignored'])

function parseDelivery(value: unknown): Delivery | null {
  if (!isRecord(value)) return null
  const { request, state, session, replyId, updated } = value
  if (typeof request !== 'string' || typeof state !== 'string' || typeof session !== 'string') return null
  if (typeof replyId !== 'string' || typeof updated !== 'number') return null
  if (!STATES.includes(state)) return null
  const text = (field: unknown): string | null => (typeof field === 'string' ? field : null)
  return {
    request,
    state: state as DeliveryState,
    session,
    replyId,
    threadId: text(value.threadId),
    subject: text(value.subject),
    message: text(value.message),
    mailbox: text(value.mailbox),
    error: text(value.error),
    updated
  }
}

export class Ledger {
  private rows = new Map<string, Delivery>()
  private loaded = false
  private writing: Promise<void> = Promise.resolve()
  private readonly store: KeyValue
  private readonly now: () => number

  constructor(store: KeyValue, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  /** Throws when the saved ledger cannot be read: delivering without it could send twice. */
  async load(): Promise<void> {
    const saved = await this.store.get(LEDGER_KEY)
    this.rows = new Map()
    if (saved !== null && saved !== undefined) {
      if (!isRecord(saved)) throw new Error('The saved delivery record is unreadable.')
      for (const [key, value] of Object.entries(saved)) {
        const row = parseDelivery(value)
        if (!row) throw new Error('The saved delivery record has an unknown entry.')
        this.rows.set(key, row)
      }
    }
    this.loaded = true
  }

  static key(inboxKey: string, replyId: string, session: string): string {
    return `${inboxKey.slice(0, 16)}:${replyId}:${session}`
  }

  private envelopeKey(key: string): string {
    return `envelope.${sha256(key).slice(0, 40)}`
  }

  get(key: string): Delivery | null {
    this.assertLoaded()
    const row = this.rows.get(key)
    return row ? { ...row } : null
  }

  all(): Array<Delivery & { key: string }> {
    this.assertLoaded()
    return [...this.rows.entries()].map(([key, row]) => ({ key, ...row }))
  }

  counts(): Record<DeliveryState, number> {
    const counts: Record<DeliveryState, number> = { prepared: 0, sending: 0, accepted: 0, acknowledged: 0, blocked: 0, rejected: 0, ignored: 0 }
    for (const row of this.rows.values()) counts[row.state] += 1
    return counts
  }

  /** Records a new delivery and its frozen envelope; returns the existing row when there is one. */
  async create(key: string, fields: { session: string; replyId: string; threadId: string | null; subject: string | null }, envelope: Envelope): Promise<Delivery> {
    this.assertLoaded()
    const existing = this.rows.get(key)
    if (existing) return { ...existing }
    // The envelope is saved first: a row always has the exact text it will send.
    await this.store.set(this.envelopeKey(key), envelope)
    const row: Delivery = {
      request: randomUUID(),
      state: 'prepared',
      session: fields.session,
      replyId: fields.replyId,
      threadId: fields.threadId,
      subject: fields.subject ? fields.subject.slice(0, 120) : null,
      message: null,
      mailbox: null,
      error: null,
      updated: this.now()
    }
    this.rows.set(key, row)
    await this.save()
    return { ...row }
  }

  /** Records something the Inbox handed over that can never be delivered, so it is not retried forever. */
  async reject(key: string, fields: SettledFields, error: string): Promise<void> {
    await this.settle(key, fields, 'rejected', error)
  }

  /** Records a reply that is never this plugin's to deliver (written before it was activated), so it is not looked at again. */
  async ignore(key: string, fields: SettledFields): Promise<void> {
    await this.settle(key, fields, 'ignored', null)
  }

  private async settle(key: string, fields: SettledFields, state: 'rejected' | 'ignored', error: string | null): Promise<void> {
    this.assertLoaded()
    if (this.rows.has(key)) return
    this.rows.set(key, {
      request: randomUUID(),
      state,
      session: fields.session,
      replyId: fields.replyId,
      threadId: fields.threadId ?? null,
      subject: fields.subject ? fields.subject.slice(0, 120) : null,
      message: null,
      mailbox: null,
      error,
      updated: this.now()
    })
    await this.save()
  }

  async envelope(key: string): Promise<Envelope | null> {
    const saved = await this.store.get(this.envelopeKey(key))
    if (!isRecord(saved)) return null
    const { session, subject, body, payload } = saved
    if (typeof session !== 'string' || typeof subject !== 'string' || typeof body !== 'string' || typeof payload !== 'string') return null
    return { session, subject, body, payload }
  }

  /** Durable before it returns: the caller crosses a process boundary next. */
  async update(key: string, change: Partial<Pick<Delivery, 'state' | 'message' | 'mailbox' | 'error' | 'request'>>): Promise<Delivery> {
    this.assertLoaded()
    const row = this.rows.get(key)
    if (!row) throw new Error('No delivery is recorded under that key.')
    const next: Delivery = { ...row, ...change, error: change.error === undefined ? null : change.error, updated: this.now() }
    this.rows.set(key, next)
    await this.save()
    if (SETTLED.has(next.state)) await this.store.delete(this.envelopeKey(key)).catch(() => undefined)
    return { ...next }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('The delivery record is not loaded.')
  }

  private prune(): string[] {
    const removed: string[] = []
    const cutoff = this.now() - KEEP_SETTLED_MS
    for (const [key, row] of this.rows) {
      if (SETTLED.has(row.state) && row.updated < cutoff) removed.push(key)
    }
    // Over the cap, the oldest settled rows go first; rows still in flight or blocked are never dropped.
    if (this.rows.size - removed.length > MAX_ROWS) {
      const settled = [...this.rows.entries()]
        .filter(([key, row]) => SETTLED.has(row.state) && !removed.includes(key))
        .sort((a, b) => a[1].updated - b[1].updated)
      for (const [key] of settled) {
        if (this.rows.size - removed.length <= MAX_ROWS) break
        removed.push(key)
      }
    }
    for (const key of removed) this.rows.delete(key)
    return removed
  }

  private save(): Promise<void> {
    const write = this.writing.then(async () => {
      this.prune()
      await this.store.set(LEDGER_KEY, Object.fromEntries(this.rows) as unknown as Json)
    })
    this.writing = write.catch(() => undefined)
    return write
  }
}

/**
 * When this plugin was first activated for each Inbox (ms since the epoch), kept in the plugin's own
 * storage beside the ledger. Replies written before it are never delivered: installing the plugin
 * must not wake a chat with old, unanswered history. A boundary is set once and never moves.
 */
export class Activation {
  private readonly store: KeyValue
  private readonly now: () => number
  private at: Map<string, number> | null = null

  constructor(store: KeyValue, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  /** The boundary for one Inbox, or null while it is not known (nothing is delivered then). */
  get(inboxKey: string): number | null {
    return this.at?.get(inboxKey) ?? null
  }

  /**
   * Sets the boundary for one Inbox the first time, and returns it. Throws when the saved boundaries
   * cannot be read or written: delivering without a boundary could wake old replies.
   */
  async ensure(inboxKey: string): Promise<number> {
    if (this.at === null) {
      const saved = await this.store.get(ACTIVATION_KEY)
      const at = new Map<string, number>()
      if (saved !== null && saved !== undefined) {
        if (!isRecord(saved)) throw new Error('The saved activation time is unreadable.')
        for (const [key, value] of Object.entries(saved)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('The saved activation time is unreadable.')
          at.set(key, value)
        }
      }
      this.at = at
    }
    const current = this.at.get(inboxKey)
    const next = current ?? this.now()
    if (next !== current) {
      const updated = new Map(this.at).set(inboxKey, next)
      await this.store.set(ACTIVATION_KEY, Object.fromEntries(updated))
      this.at = updated
    }
    return next
  }
}
