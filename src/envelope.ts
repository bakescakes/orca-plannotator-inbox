// Turns one Inbox command into the mail Orca delivers to the chat. The text follows the shape
// Plannotator's own connections use (its `inboxWakeText`): `Plannotator Inbox: <title> (<reply id>)`,
// how to answer, the thread, the person's words, the closing line. That is the shape its agent
// guide teaches agents to expect. A plain reply in an unnamed thread has no title on purpose:
// Plannotator sends none, and its own connections then say `a reply`, as this does.
import type { InboxCommand } from './inbox'
import type { Envelope } from './ledger'
import { ID, byteLength } from './util'

/** A mail passed as command arguments (an Orca without `--body-file`): well inside every platform's limit. */
export const MAX_ENVELOPE_BYTES = 64_000
/**
 * Windows allows 32,767 characters for a whole command line, and quoting an argument can double
 * it. So a mail there is at most this many bytes, which leaves room for both and for the rest of
 * the command.
 */
export const MAX_ENVELOPE_BYTES_WINDOWS = 14_000
/**
 * A mail whose body goes through standard input (`--body-file -`). Orca's CLI refuses a request
 * larger than 1 MiB on its way to the app (`MAX_LOCAL_RUNTIME_RPC_MESSAGE_BYTES`), counted as
 * JSON, so the mail is measured as JSON too and kept to half of that.
 */
export const MAX_ENVELOPE_BYTES_STDIN = 512_000
/** How the body reaches Orca: on the command line, or through standard input. */
export type Carrier = 'argv' | 'stdin'

/** The most a mail may hold on one command line on this platform. */
export function argvLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? MAX_ENVELOPE_BYTES_WINDOWS : MAX_ENVELOPE_BYTES
}
export const SENDER = 'plannotator-inbox'
const CLOSING = '[for context: read_thread (opt: set limit) or search · help: plannotator inbox --help]'
const ANSWER = 'When they need to hear back, answer in the same thread: Plannotator Inbox send_message with reply_to set to the id in parentheses on the line above.'
/** The fields the mail's own lines already carry. Everything else the Inbox sends is passed along as data. */
const CARRIED = new Set(['type', 'id', 'thread_id', 'reply_to', 'subject', 'body', 'url'])
const MAX_CONTEXT_BYTES = 6000

export class EnvelopeError extends Error {}

function oneLine(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text || fallback
}

function instruction(command: InboxCommand): string {
  if (command.handed_away) return 'The person handed this Plannotator Inbox thread to another session. Stop work on it; nothing here needs an answer.'
  if (command.handoff) return `The person handed you this Plannotator Inbox thread: it is yours now. Read it first with read_thread. ${ANSWER}`
  if (command.tagged) return `The person tagged you in a Plannotator Inbox thread that another session owns. Their reply follows as they wrote it; read the thread first and answer only what is addressed to you. ${ANSWER}`
  if (command.reask === true) return `The person asked, from the Plannotator Inbox, for the open questions and action items in this thread to be asked again, together in one new message. ${ANSWER}`
  if (typeof command.ack_of === 'string' && command.ack_of !== '') return 'The person reacted to your message in the Plannotator Inbox. Nothing here needs an answer.'
  if (command.type === 'message') {
    return command.new_thread === true
      ? `The person started a new thread with you in the Plannotator Inbox: an idea or a request of their own, not an answer to something you asked. Their message follows as they wrote it. Say how you will handle it before you start. ${ANSWER}`
      : `The person wrote to you from the Plannotator Inbox. Their message follows as they wrote it. ${ANSWER}`
  }
  return `This is a user reply from the Plannotator Inbox. Their reply follows as they wrote it: it is their answer to you. ${ANSWER}`
}

/**
 * Deterministic for the same command and session, except `url`, which is why the result is frozen
 * in the ledger. `carrier` is how this Orca takes the body (`OrcaCli.takesBodyFile`).
 */
export function buildEnvelope(
  inboxKey: string,
  session: string,
  command: InboxCommand,
  platform: NodeJS.Platform = process.platform,
  carrier: Carrier = 'argv'
): Envelope {
  const limit = carrier === 'stdin' ? MAX_ENVELOPE_BYTES_STDIN : argvLimit(platform)
  // Through standard input the mail travels as JSON, where a quote or a line break takes two bytes.
  const size = carrier === 'stdin' ? (text: string): number => byteLength(JSON.stringify(text)) : byteLength
  if (!ID.test(command.id) || !ID.test(command.thread_id)) throw new EnvelopeError('The reply has no usable id.')
  const title = oneLine(command.subject, command.type === 'message' ? 'a message' : 'a reply')
  if (title.length > 1000) throw new EnvelopeError('The thread title is too long to deliver.')
  const url = typeof command.url === 'string' && command.url.length <= 2000 ? command.url : ''
  // Whatever else Plannotator says about this reply (a hand-off, a tag, open questions, steps, and
  // anything a later version adds) goes along as it came, so an update never loses information here.
  const context: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(command)) {
    if (!CARRIED.has(field) && value !== undefined && value !== null && value !== false) context[field] = value
  }
  const hasContext = Object.keys(context).length > 0
  const contextJson = JSON.stringify(context)
  const lines = [
    `Plannotator Inbox: ${title} (${command.id})`,
    instruction(command),
    `[Thread ${command.thread_id}]${url ? ` ${url}` : ''}`
  ]
  if (hasContext) {
    lines.push(
      byteLength(contextJson) <= Math.min(MAX_CONTEXT_BYTES, limit / 4)
        ? `Context: ${contextJson}`
        : `Context: more came with this (${Object.keys(context).join(', ')}); read the thread with read_thread for it.`
    )
  }
  const head = lines.join('\n')
  let body = `${head}\n\n${command.body}\n\n${CLOSING}`
  // Too long for one mail: the wake still arrives, and the agent reads the words from the Inbox.
  if (size(body) > limit - 2000) {
    body = `${head}\n\nTheir reply is too long to include here. Read it now with read_thread (thread_id ${command.thread_id}, message_id ${command.id}).\n\n${CLOSING}`
  }
  const payload = JSON.stringify({
    sender: SENDER,
    version: 1,
    inbox: inboxKey.slice(0, 16),
    replyId: command.id,
    threadId: command.thread_id,
    replyTo: typeof command.reply_to === 'string' ? command.reply_to : null,
    session
  })
  const envelope = { session, subject: `Plannotator: ${title}`.slice(0, 300), body, payload }
  if (size(envelope.body) + size(envelope.payload) + size(envelope.subject) > limit) {
    throw new EnvelopeError('The reply cannot be fitted into one Orca mail.')
  }
  return envelope
}
