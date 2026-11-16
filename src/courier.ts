// Delivers one Inbox reply to one Orca chat, exactly once as far as both sides can prove:
//   prepared -> sending -> accepted -> acknowledged
// Each step is saved before the next process is asked to do anything. A lost answer is settled by
// reading (Orca's request receipt, then the chat's mailbox), never by sending again; when reading
// cannot settle it the delivery is blocked for a person to decide.
import { randomUUID } from 'node:crypto'
import { EnvelopeError, buildEnvelope } from './envelope'
import { InboxRefused, type InboxClient, type InboxCommand } from './inbox'
import { Ledger, type Delivery } from './ledger'
import { OrcaContractError, OrcaNotRun, OrcaRefused, type MailMessage, type OrcaCli } from './orca-cli'
import { KeyedQueue, errorText, isRecord } from './util'

export type Outcome = 'acknowledged' | 'queued' | 'deferred' | 'blocked' | 'rejected'
export type Route = { session: string; raw: string }

export const AMBIGUOUS = 'It is not known whether Orca received this reply, so it was not sent again.'
const RECONCILE_AFTER_MS = 30_000

/** The reply a mail's payload says it carries; this plugin and the adapter it replaces both name it `replyId`. */
function replyIdOf(payload: unknown): string | null {
  try {
    const parsed: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload
    return isRecord(parsed) && typeof parsed.replyId === 'string' ? parsed.replyId : null
  } catch {
    return null
  }
}

export class Courier {
  private readonly queue = new KeyedQueue()
  private readonly orca: OrcaCli
  private readonly ledger: Ledger
  private readonly now: () => number
  private readonly earlier: () => string | null

  /** `earlier` names the sender of an adapter that delivered for this Inbox before and has stopped, if any. */
  constructor(orca: OrcaCli, ledger: Ledger, now: () => number = Date.now, earlier: () => string | null = () => null) {
    this.orca = orca
    this.ledger = ledger
    this.now = now
    this.earlier = earlier
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
    let row = this.ledger.get(key)
    if (row === null) {
      // The adapter that delivered here before may have put this very reply in the chat's mailbox and
      // stopped before it told the Inbox. Its mail is then the delivery, and nothing is sent again.
      // Read before anything is recorded: if Orca cannot say, this reply is looked at afresh next time.
      const earlier = this.earlier()
      const theirs = earlier
        ? (await this.orca.mailbox(`orca_session_id:${route.session}`)).find(
            (mail) => mail.from_handle === earlier && replyIdOf(mail.payload) === command.id
          )
        : undefined
      try {
        const envelope = buildEnvelope(inbox.key, route.session, command)
        row = await this.ledger.create(
          key,
          {
            session: route.session,
            replyId: command.id,
            threadId: command.thread_id,
            subject: typeof command.subject === 'string' ? command.subject : null
          },
          envelope
        )
      } catch (error) {
        if (!(error instanceof EnvelopeError)) throw error
        await this.ledger.reject(key, { session: route.session, replyId: command.id }, error.message)
        return 'rejected'
      }
      if (theirs) row = await this.ledger.update(key, { state: 'accepted', message: theirs.id, mailbox: theirs.to_handle })
    }
    if (row.state === 'rejected') return 'rejected'
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
    if (row.state === 'prepared') {
      row = await this.ledger.update(key, { state: 'sending' })
      try {
        const message = await this.orca.send(envelope, row.request)
        row = await this.ledger.update(key, { state: 'accepted', message: message.id, mailbox: message.to_handle })
      } catch (error) {
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
    // No receipt: look for this exact mail in the chat's own mailbox, without consuming anything.
    const mail = (await this.orca.mailbox(`orca_session_id:${envelope.session}`)).filter(
      (message) => message.from_handle === this.orca.sender && message.payload === envelope.payload
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
