// Delivers one Inbox reply to one Orca chat, exactly once as far as both sides can prove:
//   prepared -> sending -> accepted -> acknowledged
// Each step is saved before the next process is asked to do anything. A lost answer is settled by
// reading (Orca's request receipt, then the chat's mailbox), never by sending again; when reading
// cannot settle it the delivery is blocked for a person to decide.
//
// Before a reply is first sent, and again whenever a prepared reply is about to be sent, its thread
// is read from the Inbox and the reply must prove it belongs to this chat (see `judgeSource`). A
// reply that fails is never sent and never acknowledged: it is recorded as rejected, with a reason.
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { EnvelopeError, buildEnvelope } from './envelope'
import { InboxRefused, InboxUnavailable, type InboxClient, type InboxCommand, type ThreadSource } from './inbox'
import { Ledger, type Delivery } from './ledger'
import { OrcaContractError, OrcaNotRun, OrcaRefused, OrcaTooLong, isBotRequestPayload, type MailMessage, type OrcaCli } from './orca-cli'
import { KeyedQueue, canonicalSession, errorText, isRecord } from './util'

export type Outcome = 'acknowledged' | 'queued' | 'deferred' | 'blocked' | 'rejected' | 'ignored'
/**
 * The chat a reply goes to. `roots` are the chat's own folders (its worktree, its repository root,
 * the folder its agent runs in), when known: a reply's thread must belong to one of them.
 */
export type Route = { session: string; raw: string; roots?: readonly string[] }
/** What the checks on a reply's source found. */
export type Verdict = { kind: 'deliver' } | { kind: 'early' } | { kind: 'refuse'; reason: string }

export const AMBIGUOUS = 'It is not known whether Orca received this reply, so it was not sent again.'
const RECONCILE_AFTER_MS = 30_000
/** How far up a thread's `reply_to` chain a reply may be from what proves its chat. */
export const MAX_HOPS = 64

export const REFUSED = {
  gone: 'The Inbox no longer holds this reply, so it was not delivered.',
  threadGone: 'The Inbox no longer holds this reply’s thread, so it was not delivered.',
  notPerson: 'This item was not written by a person in the Inbox, so it was not delivered.',
  noTime: 'This reply has no readable time, so it was not delivered.',
  project: 'This reply’s thread belongs to a different project than this chat, so it was not delivered.',
  recipient: 'Nothing in this reply’s thread shows it is meant for this chat, so it was not delivered.'
} as const

/** Orca refused these exact arguments before sending anything, in its own words where it gave them. */
export function refusedText(error: OrcaRefused): string {
  const words = (error.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return `Orca refused this reply and nothing was sent${words ? `: ${words.replace(/\.$/, '')}` : ` (${error.code})`}. It is still in the Inbox.`
}

/**
 * Refusals Orca passes through under their own code and documents as having no effect: the chat a
 * reply is addressed to is not there to take it, or it is a bot's chat while bots are switched off.
 * Nothing was stored, so the reply waits for a person instead of being read back as "not known".
 */
const NO_EFFECT: Record<string, string> = {
  session_caller_not_live: 'This chat has ended in Orca (it was closed), so the reply was not sent. It is still in the Inbox.',
  session_caller_unknown: 'Orca has no such chat on this computer, so the reply was not sent. It is still in the Inbox.',
  bots_disabled: 'This chat is a bot’s, and bots are switched off in Orca, so the reply was not sent. Switch bots on in Orca, then press Send again.'
}

/** Orca's words for a refusal that had no effect, or null when the refusal is not one of those. */
export function noEffectText(error: OrcaRefused): string | null {
  if (Object.hasOwn(NO_EFFECT, error.code)) return NO_EFFECT[error.code]!
  return error.code.startsWith('session_caller_') ? refusedText(error) : null
}

/** A path with links resolved; the path itself when it cannot be (it does not exist here). */
export async function realOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/** An ISO time with an explicit zone, as the Inbox writes them; null for anything else. */
function parseTime(value: string | null): number | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T[^ ]+(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/**
 * Whether one reply may be delivered to one chat, from its thread as the Inbox holds it: the reply
 * must be a message a person wrote; written before the activation boundary it is ignored; the thread must belong to one of
 * the chat's folders when those are known (`threadRoot` and `roots` are real paths); and following
 * `reply_to` (at most MAX_HOPS messages) must reach either an explicit addressee that is this Orca
 * chat, or an agent message this same Orca chat wrote. Titles and folders never choose a chat.
 */
export function judgeSource(
  source: Pick<ThreadSource, 'messages'>,
  replyId: string,
  session: string,
  options: { boundary?: number | null; threadRoot?: string; roots?: readonly string[] } = {}
): Verdict {
  const item = source.messages.get(replyId)
  if (!item) return { kind: 'refuse', reason: REFUSED.gone }
  if (item.author.kind !== 'person') return { kind: 'refuse', reason: REFUSED.notPerson }
  if (options.boundary !== undefined && options.boundary !== null) {
    const at = parseTime(item.createdAt)
    if (at === null) return { kind: 'refuse', reason: REFUSED.noTime }
    if (at < options.boundary) return { kind: 'early' }
  }
  if (options.roots && options.roots.length > 0 && (options.threadRoot === undefined || !options.roots.includes(options.threadRoot))) {
    return { kind: 'refuse', reason: REFUSED.project }
  }
  const mine = (value: string | null): boolean => canonicalSession(value) === session
  let current = item
  const seen = new Set<string>()
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    // An explicit addressee decides, whoever wrote the message.
    if (current.to !== null) {
      if (current.to.host === 'orca' && mine(current.to.session)) return { kind: 'deliver' }
      break
    }
    // The first agent up the chain is the one that asked.
    if (current.author.kind === 'agent') {
      if (current.author.host === 'orca' && mine(current.author.session)) return { kind: 'deliver' }
      break
    }
    const parent = current.replyTo === null ? undefined : source.messages.get(current.replyTo)
    if (!parent) break
    current = parent
  }
  return { kind: 'refuse', reason: REFUSED.recipient }
}

export class Courier {
  private readonly queue = new KeyedQueue()
  private readonly orca: OrcaCli
  private readonly ledger: Ledger
  private readonly now: () => number
  private readonly boundary: ((inboxKey: string) => number | null) | null

  /**
   * `boundary` gives the activation time for an Inbox: replies written before it are ignored, and
   * while it returns null nothing is sent. Without it (tests of delivery alone) no time is checked.
   */
  constructor(orca: OrcaCli, ledger: Ledger, now: () => number = Date.now, boundary: ((inboxKey: string) => number | null) | null = null) {
    this.orca = orca
    this.ledger = ledger
    this.now = now
    this.boundary = boundary
  }

  /** One session's deliveries run one at a time, so retries and restarts never overlap. */
  deliver(inbox: InboxClient, route: Route, command: InboxCommand): Promise<Outcome> {
    return this.queue.run(route.session, () => this.step(inbox, route, command))
  }

  /** A person chose to send a blocked reply again: a new request id, back to the start. */
  async retry(key: string): Promise<boolean> {
    const row = this.ledger.get(key)
    if (!row || row.state !== 'blocked') return false
    if ((await this.ledger.envelope(key)) === null) return false
    await this.ledger.update(key, { state: 'prepared', request: randomUUID(), message: null, mailbox: null })
    return true
  }

  private async step(inbox: InboxClient, route: Route, command: InboxCommand): Promise<Outcome> {
    const key = Ledger.key(inbox.key, command.id, route.session)
    const fields = {
      session: route.session,
      replyId: command.id,
      threadId: command.thread_id,
      subject: typeof command.subject === 'string' ? command.subject : null
    }
    let row = this.ledger.get(key)
    let verified = false
    if (row === null) {
      // Nothing is recorded until the source is known: a thread that cannot be read now is read again next time.
      const verdict = await this.verify(inbox, route, command)
      if (verdict === null) return 'deferred'
      if (verdict.kind === 'early') {
        await this.ledger.ignore(key, fields)
        return 'ignored'
      }
      if (verdict.kind === 'refuse') {
        await this.ledger.reject(key, fields, verdict.reason)
        return 'rejected'
      }
      verified = true
      try {
        // A long reply fits in one mail only where this Orca takes the body through standard input.
        const carrier = (await this.orca.takesBodyFile()) ? 'stdin' : 'argv'
        const envelope = buildEnvelope(inbox.key, route.session, command, process.platform, carrier)
        row = await this.ledger.create(key, fields, envelope)
      } catch (error) {
        if (!(error instanceof EnvelopeError)) throw error
        await this.ledger.reject(key, fields, error.message)
        return 'rejected'
      }
    }
    if (row.state === 'rejected') return 'rejected'
    if (row.state === 'ignored') return 'ignored'
    if (row.state === 'acknowledged') {
      // The Inbox restarted before it saved the acknowledgement: tell it again.
      await this.acknowledge(inbox, route, command, key)
      return 'acknowledged'
    }
    const envelope = await this.ledger.envelope(key)
    if (envelope === null) {
      await this.ledger.update(key, { state: 'blocked', error: 'The saved text of this reply is missing, so it cannot be sent or matched.' })
      return 'blocked'
    }
    if (row.state === 'blocked') {
      if (row.error !== AMBIGUOUS || this.now() - row.updated < RECONCILE_AFTER_MS) return 'blocked'
      // A late receipt can settle an earlier doubt. Only the reading branch below runs: never a second send.
      row = await this.ledger.update(key, { state: 'sending' })
    }
    if (row.state === 'prepared' && !verified) {
      // Resumed after a restart, a deferral or a person's retry: the person may have deleted or
      // redirected the reply meanwhile, so its source is checked again before anything is sent.
      const verdict = await this.verify(inbox, route, command)
      if (verdict === null) return 'deferred'
      if (verdict.kind === 'early') {
        await this.ledger.update(key, { state: 'ignored' })
        return 'ignored'
      }
      if (verdict.kind === 'refuse') {
        await this.ledger.update(key, { state: 'rejected', error: verdict.reason })
        return 'rejected'
      }
    }
    if (row.state === 'prepared') {
      row = await this.ledger.update(key, { state: 'sending' })
      try {
        const message = await this.orca.send(envelope, row.request)
        row = await this.ledger.update(key, { state: 'accepted', message: message.id, mailbox: message.to_handle })
      } catch (error) {
        // Nothing was sent, and the same request would be refused again: a person decides, instead
        // of a retry every few seconds that can never work. Send again reuses the same words.
        if (error instanceof OrcaTooLong) {
          await this.ledger.update(key, { state: 'blocked', error: error.message })
          return 'blocked'
        }
        if (error instanceof OrcaRefused && error.notSent && error.code === 'invalid_argument') {
          await this.ledger.update(key, { state: 'blocked', error: refusedText(error) })
          return 'blocked'
        }
        const refused = error instanceof OrcaRefused ? noEffectText(error) : null
        if (refused !== null) {
          await this.ledger.update(key, { state: 'blocked', error: refused })
          return 'blocked'
        }
        if (error instanceof OrcaNotRun || (error instanceof OrcaRefused && error.notSent)) {
          await this.ledger.update(key, { state: 'prepared', error: 'Orca did not take the reply yet; it will be tried again.' })
          return 'deferred'
        }
        // Anything else may have landed: fall through and find out by reading.
      }
    }
    if (row.state === 'sending') row = await this.reconcile(key, row, envelope)
    if (row.state === 'accepted') return this.confirm(inbox, route, command, key, row)
    return row.state === 'blocked' ? 'blocked' : 'queued'
  }

  /**
   * Reads the reply's thread and judges its source. Null means "not now": the Inbox cannot be read
   * at the moment, or the activation boundary is not known yet; the reply is looked at again later
   * and nothing is sent meanwhile. A thread the Inbox answers in an unknown shape throws, so the
   * chat's poll says what is wrong; that is never a rejection either.
   */
  private async verify(inbox: InboxClient, route: Route, command: InboxCommand): Promise<Verdict | null> {
    let boundary: number | null | undefined
    if (this.boundary) {
      boundary = this.boundary(inbox.key)
      if (boundary === null) return null
    }
    let source: ThreadSource
    try {
      source = await inbox.thread(command.thread_id)
    } catch (error) {
      if (error instanceof InboxUnavailable) return null
      if (error instanceof InboxRefused && error.status === 404) return { kind: 'refuse', reason: REFUSED.threadGone }
      throw error
    }
    const roots = route.roots && route.roots.length > 0 ? await Promise.all(route.roots.map(realOrSelf)) : undefined
    return judgeSource(source, command.id, route.session, { boundary, roots, threadRoot: await realOrSelf(isAbsolute(source.root) ? resolve(source.root) : source.root) })
  }

  private async reconcile(key: string, row: Delivery, envelope: NonNullable<Awaited<ReturnType<Ledger['envelope']>>>): Promise<Delivery> {
    try {
      const receipt = await this.orca.receipt(row.request, envelope)
      if (receipt) return this.ledger.update(key, { state: 'accepted', message: receipt.id, mailbox: receipt.to_handle })
    } catch (error) {
      if (error instanceof OrcaContractError) {
        return this.ledger.update(key, { state: 'blocked', error: 'Orca holds a receipt that does not match this reply.' })
      }
      throw error
    }
    // No receipt: look for this exact mail in the chat's own mailbox, without consuming anything. In a
    // bot's chat Orca keeps its own payload in place of this one, so there the exact body decides.
    const mail = (await this.orca.mailbox(`orca_session_id:${envelope.session}`)).filter(
      (message) =>
        message.from_handle === this.orca.sender &&
        (message.payload === envelope.payload || (isBotRequestPayload(message.payload) && message.body === envelope.body))
    )
    if (mail.length === 1) return this.ledger.update(key, { state: 'accepted', message: mail[0]!.id, mailbox: mail[0]!.to_handle })
    return this.ledger.update(key, { state: 'blocked', error: AMBIGUOUS })
  }

  private async confirm(inbox: InboxClient, route: Route, command: InboxCommand, key: string, row: Delivery): Promise<Outcome> {
    // Orca's receipt means queued, not read. Only the mailbox says when the chat actually got it, so
    // while Orca cannot show the mailbox the reply stays on the way: the Inbox is never told a reply
    // arrived on less than that.
    let mail: MailMessage | undefined
    try {
      mail = (await this.orca.mailbox(row.mailbox ?? `orca_session_id:${route.session}`)).find((message) => message.id === row.message)
    } catch (error) {
      if (!(error instanceof OrcaRefused || error instanceof OrcaContractError)) throw error
      return 'queued'
    }
    if (typeof mail?.delivered_at !== 'string' || mail.delivered_at === '') return 'queued'
    await this.acknowledge(inbox, route, command, key)
    return 'acknowledged'
  }

  private async acknowledge(inbox: InboxClient, route: Route, command: InboxCommand, key: string): Promise<void> {
    try {
      await inbox.acknowledge(route.raw, command.id)
    } catch (error) {
      // The person deleted the reply or its thread meanwhile: nothing is left to acknowledge.
      if (!(error instanceof InboxRefused) || (error.status !== 404 && error.status !== 422)) throw error
      await this.ledger.update(key, { state: 'acknowledged', error: `The Inbox no longer holds this reply (${errorText(error)}).` })
      return
    }
    if (this.ledger.get(key)?.state !== 'acknowledged') await this.ledger.update(key, { state: 'acknowledged' })
  }
}
