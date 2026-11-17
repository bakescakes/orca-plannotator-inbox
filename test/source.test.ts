// Where a reply came from, checked before it is sent.
import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Courier, MAX_HOPS, REFUSED, judgeSource } from '../src/courier'
import { InboxClient, InboxContractError, type ThreadMessage } from '../src/inbox'
import { Ledger } from '../src/ledger'
import { OrcaCli } from '../src/orca-cli'
import { agentMessage, fakeInbox, fakeOrca, memoryStore, personMessage, reply, tempDir, threadAnswer, type WireMessage } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'
const OTHER = 'codex_0f9e8d7c_aaaa'
const ROUTE = { session: SESSION, raw: SESSION }
const HOUR = 60 * 60 * 1000

async function setup(options: { boundary?: number | null | 'none' } = {}) {
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const inboxFake = fakeInbox()
  const inbox = new InboxClient('/data/plannotator', { fetch: inboxFake.fetch, readRegistry: inboxFake.readRegistry })
  const store = memoryStore()
  const ledger = new Ledger(store)
  await ledger.load()
  const cli = new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} })
  const boundary = options.boundary === undefined ? Date.now() - HOUR : options.boundary
  const courier = new Courier(cli, ledger, Date.now, boundary === 'none' ? null : () => boundary)
  const key = (id: string) => Ledger.key(inbox.key, id, SESSION)
  /** Serves thread `thr_1` with exactly these messages. */
  const thread = (messages: WireMessage[], root = '/work/project') => inboxFake.state.details.set('thr_1', threadAnswer('thr_1', root, messages))
  const nothingLeft = () => {
    assert.equal(orca.sends().length, 0, 'nothing was sent')
    assert.equal(inboxFake.state.acknowledged.length, 0, 'nothing was acknowledged')
  }
  return { orca, inboxFake, inbox, store, ledger, courier, key, thread, nothingLeft }
}

/** A thread's messages as the plugin reads them, for the pure checks. */
function messages(list: WireMessage[]): Map<string, ThreadMessage> {
  return new Map(
    list.map((message) => [
      message.id,
      {
        id: message.id,
        replyTo: message.reply_to,
        author: message.author.kind === 'agent' ? { kind: 'agent', host: message.author.host, session: message.author.session } : { kind: 'person', host: null, session: null },
        to: message.to ? { host: message.to.host, session: message.to.session } : null,
        createdAt: message.created_at
      }
    ])
  )
}

test('a person’s reply to this chat’s own question is delivered', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
  assert.deepEqual(t.inboxFake.state.threadReads, ['thr_1'])
})

test('an item an agent wrote is never delivered as a reply', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION), agentMessage('msg_1', OTHER, { reply_to: 'msg_question' })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  const row = t.ledger.get(t.key('msg_1'))!
  assert.equal(row.state, 'rejected')
  assert.equal(row.error, REFUSED.notPerson)
  assert.equal(row.threadId, 'thr_1')
  assert.equal(row.subject, 'Ship it?')
  t.nothingLeft()
  // Settled once: not read or judged again.
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  assert.equal(t.inboxFake.state.threadReads.length, 1)
})

test('a reply that is no longer in its thread is not delivered', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION)])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, REFUSED.gone)
  t.nothingLeft()
})

test('a reply to another chat’s question is not delivered to this one', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', OTHER), personMessage('msg_1', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, REFUSED.recipient)
  t.nothingLeft()
})

test('the same session id from another host is not this Orca chat', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION, { author: { kind: 'agent', host: 'claude-code', session: SESSION } }), personMessage('msg_1', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  t.nothingLeft()
})

test('both spellings of this chat’s id count as this chat', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', `orca_session_id:${SESSION}`), personMessage('msg_1', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  const prefixed = { session: SESSION, raw: `orca_session_id:${SESSION}` }
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_2', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, prefixed, reply('msg_2')), 'acknowledged')
  assert.equal(t.orca.sends().length, 2)
})

test('an explicit redirect decides: to this chat it is delivered, to another chat it is not', async () => {
  const t = await setup()
  // The asking chat ended; the person handed the reply to this chat.
  t.thread([agentMessage('msg_question', OTHER), personMessage('msg_1', 'msg_question', { to: { host: 'orca', session: `orca_session_id:${SESSION}` } })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  // This chat asked, but the person handed the reply to another session: that one gets it.
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_2', 'msg_question', { to: { host: 'orca', session: OTHER } })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_2')), 'rejected')
  // A New message to this chat (it answers nothing).
  t.thread([personMessage('msg_3', null, { to: { host: 'orca', session: SESSION } })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_3', { type: 'message', reply_to: null } as never)), 'acknowledged')
  // Addressed to this session id, but on another host.
  t.thread([personMessage('msg_4', null, { to: { host: 'codex', session: SESSION } })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_4', { type: 'message', reply_to: null } as never)), 'rejected')
  assert.equal(t.orca.sends().length, 2)
})

test('the chain is followed through the person’s own earlier messages, at most 64 messages', () => {
  const chain = (people: number): Map<string, ThreadMessage> => {
    const list: WireMessage[] = [agentMessage('msg_question', SESSION)]
    let parent = 'msg_question'
    for (let index = people; index >= 1; index -= 1) {
      const id = index === 1 ? 'msg_1' : `msg_p${index}`
      list.push(personMessage(id, parent))
      parent = id
    }
    return messages(list)
  }
  // The reply is the first message looked at; the asking agent may be the 64th.
  assert.deepEqual(judgeSource({ messages: chain(MAX_HOPS - 1) }, 'msg_1', SESSION), { kind: 'deliver' })
  assert.deepEqual(judgeSource({ messages: chain(MAX_HOPS) }, 'msg_1', SESSION), { kind: 'refuse', reason: REFUSED.recipient })
  // A loop in reply_to ends the walk instead of running forever.
  const loop = messages([personMessage('msg_1', 'msg_2'), personMessage('msg_2', 'msg_1')])
  assert.deepEqual(judgeSource({ messages: loop }, 'msg_1', SESSION), { kind: 'refuse', reason: REFUSED.recipient })
  // The first agent up the chain is the one that asked: an earlier question by this chat does not count.
  const handed = messages([agentMessage('msg_a', SESSION), agentMessage('msg_b', OTHER, { reply_to: 'msg_a' }), personMessage('msg_1', 'msg_b')])
  assert.equal(judgeSource({ messages: handed }, 'msg_1', SESSION).kind, 'refuse')
})

test('a thread too long to prove is refused through the courier too', async () => {
  const t = await setup()
  const list: WireMessage[] = [agentMessage('msg_question', SESSION)]
  let parent = 'msg_question'
  for (let index = 0; index < MAX_HOPS; index += 1) {
    const id = index === MAX_HOPS - 1 ? 'msg_1' : `msg_p${index}`
    list.push(personMessage(id, parent))
    parent = id
  }
  t.thread(list)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  t.nothingLeft()
})

test('a thread in another project than the chat’s folders is refused; the same folder through a link is not', async () => {
  const t = await setup()
  const root = await tempDir()
  const project = join(root, 'project')
  await mkdir(project)
  await symlink(project, join(root, 'link'))
  const route = { ...ROUTE, roots: [join(root, 'link')] }
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')], join(root, 'elsewhere'))
  assert.equal(await t.courier.deliver(t.inbox, route, reply('msg_1')), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, REFUSED.project)
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_2', 'msg_question')], project)
  assert.equal(await t.courier.deliver(t.inbox, route, reply('msg_2')), 'acknowledged')
  // A folder whose name only starts the same is another folder.
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_3', 'msg_question')], `${project}2`)
  assert.equal(await t.courier.deliver(t.inbox, route, reply('msg_3')), 'rejected')
  // When the chat's folders are not known, the thread's project is not checked.
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_4', 'msg_question')], '/somewhere/else')
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_4')), 'acknowledged')
})

test('a thread that cannot be read now is read again later, never refused', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')])
  for (const fault of ['5xx', 'down', '401'] as const) {
    if (fault === '5xx') t.inboxFake.state.threadStatus = 503
    if (fault === 'down') t.inboxFake.state.up = false
    if (fault === '401') t.inboxFake.state.threadStatus = 401
    assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'deferred', fault)
    assert.equal(t.ledger.get(t.key('msg_1')), null, 'nothing is recorded')
    t.inboxFake.state.threadStatus = 200
    t.inboxFake.state.up = true
  }
  t.nothingLeft()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
})

test('a thread answered in an unknown shape stops the poll with a reason, and nothing is recorded', async () => {
  const t = await setup()
  t.inboxFake.state.details.set('thr_1', { thread: { messages: 'not a list' } })
  await assert.rejects(t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), InboxContractError)
  t.inboxFake.state.details.set('thr_1', threadAnswer('thr_1', '/work/project', [agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question'), personMessage('msg_1', 'msg_question')]))
  await assert.rejects(t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), /same id/)
  assert.equal(t.ledger.get(t.key('msg_1')), null)
  t.nothingLeft()
})

test('a thread the Inbox no longer holds is refused', async () => {
  const t = await setup()
  t.inboxFake.state.details.set('thr_gone', null) // deleted: the Inbox answers 404 thread_not_found
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1', { thread_id: 'thr_gone' })), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, REFUSED.threadGone)
  // Any other refusal (an Inbox without this route, say) is not taken as "gone".
  t.inboxFake.state.threadStatus = 404
  await assert.rejects(t.courier.deliver(t.inbox, ROUTE, reply('msg_2')), InboxContractError)
  assert.equal(t.ledger.get(t.key('msg_2')), null)
  t.nothingLeft()
})

test('a prepared reply is checked again before it is sent', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')])
  t.orca.state.sendFault = 'not-sent'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'deferred')
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'prepared')
  assert.equal(t.inboxFake.state.threadReads.length, 1)
  t.orca.state.sendFault = null

  // While the thread cannot be read, the prepared reply waits: not sent, not refused.
  t.inboxFake.state.threadStatus = 502
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'deferred')
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'prepared')
  t.inboxFake.state.threadStatus = 200

  // Meanwhile the person handed the reply to another chat: it is not sent here.
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question', { to: { host: 'orca', session: OTHER } })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'rejected')
  assert.equal(await t.ledger.envelope(t.key('msg_1')), null, 'the frozen text is dropped')
  assert.equal(t.orca.state.mail.length, 0)
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
})

test('a blocked reply a person sends again is checked again first', async () => {
  const t = await setup()
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')])
  t.orca.state.sendFault = 'dropped'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  t.orca.state.sendFault = null
  assert.equal(await t.courier.retry(t.key('msg_1')), true)
  // The person deleted the reply before pressing Send again.
  t.thread([agentMessage('msg_question', SESSION)])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'rejected')
  assert.equal(t.orca.sends().length, 1, 'only the first, lost send')
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
})

test('a reply written before activation is ignored once and not looked at again', async () => {
  const t = await setup({ boundary: Date.now() })
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question', { created_at: new Date(Date.now() - HOUR).toISOString() })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'ignored')
  const row = t.ledger.get(t.key('msg_1'))!
  assert.equal(row.state, 'ignored')
  assert.equal(row.error, null, 'not a problem')
  assert.equal(t.ledger.counts().ignored, 1)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'ignored')
  assert.equal(t.inboxFake.state.threadReads.length, 1, 'read once')
  t.nothingLeft()
  // Pre-boundary wins over every other check: an old reply in another project is ignored, not refused.
  t.thread([agentMessage('msg_question', OTHER), personMessage('msg_2', 'msg_question', { created_at: '2020-01-01T00:00:00Z' })])
  assert.equal(await t.courier.deliver(t.inbox, { ...ROUTE, roots: ['/x'] }, reply('msg_2')), 'ignored')
  // A reply with no readable time is refused, not guessed at.
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_3', 'msg_question', { created_at: 'yesterday' })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_3')), 'rejected')
  assert.equal(t.ledger.get(t.key('msg_3'))?.error, REFUSED.noTime)
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_4', 'msg_question', { created_at: '2099-01-01T00:00:00' })])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_4')), 'rejected', 'a time without a zone is not readable')
  t.nothingLeft()
})

test('until the activation time is known nothing is sent or recorded', async () => {
  const t = await setup({ boundary: null })
  t.thread([agentMessage('msg_question', SESSION), personMessage('msg_1', 'msg_question')])
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'deferred')
  assert.equal(t.ledger.get(t.key('msg_1')), null)
  assert.equal(t.inboxFake.state.threadReads.length, 0)
  t.nothingLeft()
})
