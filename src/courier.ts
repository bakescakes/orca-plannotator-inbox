// Delivers one Inbox reply to one Orca chat, exactly once as far as both sides can prove:
//   prepared -> sending -> accepted -> acknowledged
// Each step is saved before the next process is asked to do anything. A lost answer is settled by
// reading (Orca's request receipt, then the chat's mailbox), never by sending again; when reading
// cannot settle it the delivery is blocked for a person to decide.
import { randomUUID } from 'node:crypto'
import { EnvelopeError, buildEnvelope } from './envelope'
import { InboxRefused, type InboxClient, type InboxCommand } from './inbox'
import { Ledger, type Delivery } from './ledger'
import { OrcaContractError, OrcaNotRun, OrcaRefused, type OrcaCli } from './orca-cli'
import { KeyedQueue, errorText } from './util'

export type Outcome = 'acknowledged' | 'queued' | 'deferred' | 'blocked' | 'rejected'
export type Route = { session: string; raw: string }

export const AMBIGUOUS = 'It is not known whether Orca received this reply, so it was not sent again.'
const RECONCILE_AFTER_MS = 30_000
/** When Orca can no longer show whether a chat received its mail, its own send receipt is the proof. */
const UNCONFIRMED_AFTER_MS = 120_000
const UNCONFIRMED_AFTER_FAILURES = 3

export class Courier {
  private readonly queue = new KeyedQueue()
  private readonly confirmFailures = new Map<string, number>()
  private readonly orca: OrcaCli
  private readonly ledger: Ledger
  private readonly now: () => number

  constructor(orca: OrcaCli, ledger: Ledger, now: () => number = Date.now) {
    this.orca = orca
    this.ledger = ledger
    this.now = now
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
    // Orca's receipt means queued, not read. The mailbox says when the chat actually got it.
    let delivered = false
    try {
      const mail = (await this.orca.mailbox(row.mailbox ?? `orca_session_id:${route.session}`)).find(
        (message) => message.id === row.message
      )
      delivered = typeof mail?.delivered_at === 'string' && mail.delivered_at !== ''
      this.confirmFailures.delete(key)
    } catch (error) {
      if (!(error instanceof OrcaRefused || error instanceof OrcaContractError)) throw error
      const failures = (this.confirmFailures.get(key) ?? 0) + 1
      this.confirmFailures.set(key, failures)
      if (failures < UNCONFIRMED_AFTER_FAILURES || this.now() - row.updated < UNCONFIRMED_AFTER_MS) return 'queued'
      delivered = true
    }
    if (!delivered) return 'queued'
    await this.acknowledge(inbox, route, command, key)
    this.confirmFailures.delete(key)
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
