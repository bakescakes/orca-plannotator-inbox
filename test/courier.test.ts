import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMBIGUOUS, Courier } from '../src/courier'
import { buildEnvelope, MAX_ENVELOPE_BYTES } from '../src/envelope'
import { InboxClient } from '../src/inbox'
import { Ledger } from '../src/ledger'
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findProfile, OrcaCli, parseInventory } from '../src/orca-cli'
import { fakeInbox, fakeOrca, memoryStore, reply, tempDir } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'
const ROUTE = { session: SESSION, raw: SESSION }

async function setup(options: { deliverAtOnce?: boolean } = {}) {
  const orca = fakeOrca({ sessions: [SESSION], ...options })
  const inboxFake = fakeInbox()
  const inbox = new InboxClient('/data/plannotator', { fetch: inboxFake.fetch, readRegistry: inboxFake.readRegistry })
  const store = memoryStore()
  let now = 1_000_000
  const ledger = new Ledger(store, () => now)
  await ledger.load()
  const cli = new OrcaCli({ command: ['orca'], exec: orca.exec, env: { PATH: '/bin', ORCA_AGENT_SESSION_ID: 'someone_else', NODE_OPTIONS: '--inspect' } })
  const courier = new Courier(cli, ledger, () => now)
  const key = (id: string) => Ledger.key(inbox.key, id, SESSION)
  return { orca, inboxFake, inbox, store, ledger, courier, key, advance: (ms: number) => (now += ms) }
}

test('a reply is sent once, and acknowledged only after the chat received it', async () => {
  const t = await setup()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
  t.orca.deliverAll()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
  assert.deepEqual(t.inboxFake.state.acknowledged, [{ session: SESSION, id: 'msg_1' }])
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'acknowledged')

  const sent = t.orca.state.mail[0]!
  assert.equal(sent.to_handle, `orca_session_id:${SESSION}`)
  assert.equal(sent.from_handle, 'plannotator-inbox')
  assert.match(sent.body, /^Plannotator Inbox: Ship it\? \(msg_1\)\n/)
  assert.match(sent.body, /Yes, ship it\./)
})

test('the plugin speaks to Orca as itself, never with an agent identity', async () => {
  const t = await setup()
  await t.courier.deliver(t.inbox, ROUTE, reply('msg_1'))
  for (const env of t.orca.state.envs) {
    assert.equal(env.ORCA_AGENT_SESSION_ID, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  }
})

test('a plugin installed in a second Orca profile asks that profile’s Orca', async () => {
  const profile = await realpath(await tempDir())
  const root = join(profile, 'plugins', 'someone.plannotator-inbox', '0123abcd')
  const worker = join(root, 'src', 'worker.ts')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(worker, '')
  assert.equal(findProfile(worker), null, 'nothing of Orca’s is in that folder')
  await writeFile(join(profile, 'plugins', 'plugins.lock.json'), '{}')
  assert.equal(findProfile(worker), profile, 'found before Orca has written its runtime file')

  // Only Orca's own layout counts: a development folder below some profile-looking folder does not.
  const deeper = join(root, 'nested', 'src', 'worker.ts')
  await mkdir(join(root, 'nested', 'src'), { recursive: true })
  await writeFile(deeper, '')
  assert.equal(findProfile(deeper), null)
  const elsewhere = join(await tempDir(), 'src', 'worker.ts')
  assert.equal(findProfile(elsewhere), null, 'a development folder uses the default')
  // A profile someone else could write to is not trusted with the person's replies.
  if (process.platform !== 'win32') {
    await chmod(profile, 0o777)
    assert.equal(findProfile(worker), null)
    await chmod(profile, 0o700)
    assert.equal(findProfile(worker), profile)
  }

  const orca = fakeOrca()
  await new OrcaCli({ command: ['orca'], exec: orca.exec, env: { ORCA_USER_DATA_PATH: '/not/this', ORCA_AGENT_SESSION_ID: 'x' }, profile }).call(['status'])
  assert.equal(orca.state.envs[0]?.ORCA_USER_DATA_PATH, profile)
  assert.equal(orca.state.envs[0]?.ORCA_AGENT_SESSION_ID, undefined)
})

test('a reply the earlier adapter already put in the chat’s mailbox is not sent again', async () => {
  const t = await setup()
  const courier = new Courier(new OrcaCli({ command: ['orca'], exec: t.orca.exec, env: {} }), t.ledger, () => 1_000_000, () => 'plannotator-orca-adapter')
  // The adapter queued msg_1 for this chat and stopped before it told the Inbox.
  t.orca.state.mail.push({
    id: 'mail_theirs',
    from_handle: 'plannotator-orca-adapter',
    to_handle: `orca_session_id:${SESSION}`,
    subject: 'Plannotator: Ship it?',
    body: 'Plannotator Inbox item',
    payload: JSON.stringify({ adapter: 'plannotator-orca-adapter', version: 1, replyId: 'msg_1', nativeSessionId: SESSION }),
    delivered_at: null
  })
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  assert.equal(t.ledger.get(t.key('msg_1'))?.message, 'mail_theirs')
  t.orca.deliverAll()
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.deepEqual(t.inboxFake.state.acknowledged, [{ session: SESSION, id: 'msg_1' }])
  // A reply the adapter never queued is this plugin's to send.
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_2')), 'queued')
  assert.deepEqual(t.orca.sends().map((args) => args[args.indexOf('--from') + 1]), ['plannotator-inbox'])

  // While Orca cannot show the mailbox, nothing is recorded or sent.
  t.orca.state.mailboxDown = true
  await assert.rejects(courier.deliver(t.inbox, ROUTE, reply('msg_3')))
  assert.equal(t.ledger.get(t.key('msg_3')), null)
  assert.equal(t.orca.sends().length, 1)
})

test('while Orca cannot show the mailbox, a queued reply stays on the way and is never acknowledged on trust', async () => {
  const t = await setup()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  t.orca.state.mailboxDown = true
  for (let attempt = 0; attempt < 5; attempt += 1) {
    t.advance(60_000)
    assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  }
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'accepted')
  t.orca.state.mailboxDown = false
  t.orca.deliverAll()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
})

test('a lost answer is settled from Orca’s receipt, not by sending again', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.sendFault = 'answer-lost'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
  assert.equal(t.orca.state.mail.length, 1)
})

test('when Orca says nothing was sent, the same request is tried again later', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.sendFault = 'not-sent'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'deferred')
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'prepared')
  const request = t.ledger.get(t.key('msg_1'))!.request
  t.orca.state.sendFault = null
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  const sends = t.orca.sends()
  assert.equal(sends.length, 2)
  assert.ok(sends.every((args) => args.includes(request)))
})

test('an unknown outcome blocks instead of sending twice, until a person retries', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.sendFault = 'dropped'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, AMBIGUOUS)
  t.orca.state.sendFault = null
  t.advance(60_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(t.orca.sends().length, 1, 'no second send without a person')

  const before = t.ledger.get(t.key('msg_1'))!.request
  assert.equal(await t.courier.retry(t.key('msg_1')), true)
  assert.notEqual(t.ledger.get(t.key('msg_1'))!.request, before)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.state.mail.length, 1)
})

test('a blocked doubt clears by itself when the mail turns up in the chat’s mailbox', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.sendFault = 'dropped'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  // The send did land after all, but Orca kept no receipt for the request.
  const envelope = buildEnvelope(t.inbox.key, SESSION, reply('msg_1'))
  t.orca.state.mail.push({ id: 'mail_late', from_handle: 'plannotator-inbox', to_handle: `orca_session_id:${SESSION}`, ...envelope, delivered_at: '2026-01-01T00:00:00Z' })
  t.advance(60_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
})

test('a restart resumes from the saved record', async () => {
  const t = await setup()
  await t.courier.deliver(t.inbox, ROUTE, reply('msg_1'))
  const ledger = new Ledger(t.store)
  await ledger.load()
  const cli = new OrcaCli({ command: ['orca'], exec: t.orca.exec, env: {} })
  const courier = new Courier(cli, ledger)
  t.orca.deliverAll()
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
})

test('something that cannot be delivered is rejected once, not retried forever', async () => {
  const t = await setup()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1', { subject: 'x'.repeat(1001) })), 'rejected')
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1', { subject: 'x'.repeat(1001) })), 'rejected')
  assert.equal(t.orca.sends().length, 0)
})

test('a reply the person deleted meanwhile counts as settled', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.inboxFake.state.ackStatus = 404
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.match(t.ledger.get(t.key('msg_1'))?.error ?? '', /no longer holds/)
})

test('a very long reply still wakes the chat and points at the thread', () => {
  const envelope = buildEnvelope('k'.repeat(64), SESSION, reply('msg_1', { body: 'word '.repeat(40_000) }))
  assert.ok(Buffer.byteLength(envelope.body) < MAX_ENVELOPE_BYTES)
  assert.match(envelope.body, /too long to include here/)
  assert.match(envelope.body, /read_thread \(thread_id thr_1, message_id msg_1\)/)
})

test('what else the person did travels with the reply', () => {
  const handoff = buildEnvelope('k'.repeat(64), SESSION, reply('msg_2', { type: 'message', handoff: { from: 'Codex' }, name_thread: true, added_in_a_later_plannotator: { n: 1 }, tidy: false } as never))
  assert.match(handoff.body, /handed you this Plannotator Inbox thread/)
  assert.ok(handoff.body.includes('Context: {"handoff":{"from":"Codex"},"name_thread":true,"added_in_a_later_plannotator":{"n":1}}'), handoff.body)
  const plain = buildEnvelope('k'.repeat(64), SESSION, reply('msg_3', { subject: null } as never))
  assert.ok(plain.body.startsWith('Plannotator Inbox: a reply (msg_3)\n'))
  assert.ok(!plain.body.includes('Context:'))
  const huge = buildEnvelope('k'.repeat(64), SESSION, reply('msg_4', { context: { blob: 'x'.repeat(9000) } } as never))
  assert.match(huge.body, /Context: more came with this \(context\)/)
})

test('only open native chats on this computer are listed', () => {
  const sessions = parseInventory({
    worktrees: [
      {
        path: '/w',
        hostId: null,
        agents: [
          { paneKey: 'structured-agent-session-claude_a:00000000-0000-4000-8000-000000000001', state: 'working', agentType: 'claude' },
          { paneKey: 'terminal-7', state: 'idle' },
          { paneKey: 'structured-agent-session-dup:00000000-0000-4000-8000-000000000002' },
          { paneKey: 'structured-agent-session-dup:00000000-0000-4000-8000-000000000003' }
        ]
      },
      { path: '/r', hostId: 'ssh-1', agents: [{ paneKey: 'structured-agent-session-remote:00000000-0000-4000-8000-000000000004' }] }
    ]
  })
  assert.deepEqual([...sessions.keys()], ['claude_a'])
  assert.equal(sessions.get('claude_a')?.busy, true)
  assert.throws(() => parseInventory({ worktrees: [], truncated: true }))
  assert.throws(() => parseInventory({ panes: [] }))
})
