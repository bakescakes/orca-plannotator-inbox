import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMBIGUOUS, Courier } from '../src/courier'
import { buildEnvelope, MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES_STDIN, MAX_ENVELOPE_BYTES_WINDOWS } from '../src/envelope'
import { InboxClient } from '../src/inbox'
import { Ledger } from '../src/ledger'
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findProfile, OrcaCli, OrcaContractError, PromptKinds, parseInventory, promptKindOf } from '../src/orca-cli'
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

// ---------------------------------------------------------------------------------------------
// A bot's chats: the same address and the same send; Orca puts its own payload on the mail

const BOT = 'Lighthouse Keeper'

test('a reply reaches a bot’s chat, and is acknowledged once the chat has it, though Orca replaced the payload', async () => {
  const t = await setup()
  t.orca.state.bots.set(SESSION, BOT)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  assert.equal(t.ledger.get(t.key('msg_1'))?.state, 'accepted')
  const sent = t.orca.state.mail[0]!
  assert.equal(sent.to_handle, `orca_session_id:${SESSION}`, 'the chat’s own address, never another chat')
  assert.ok(JSON.parse(sent.payload).botRequest, 'Orca’s own record of the request')
  // Held (a chat whose last turn failed) or not yet read: on the way, never acknowledged.
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'queued')
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
  t.orca.deliverAll()
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)

  // Only Orca's bot record stands in for the payload; any other payload is still not this mail.
  const cli = new OrcaCli({ command: ['orca'], exec: t.orca.exec })
  const envelope = buildEnvelope(t.inbox.key, SESSION, reply('msg_1'))
  const message = { id: 'm', from_handle: 'plannotator-inbox', to_handle: `orca_session_id:${SESSION}`, body: envelope.body }
  assert.equal(cli.checkedMessage({ ...message, payload: sent.payload }, envelope).id, 'm')
  for (const payload of ['{"other":{}}', '{"botRequest":"text"}', 'not json', '']) {
    assert.throws(() => cli.checkedMessage({ ...message, payload }, envelope), OrcaContractError, payload)
  }
  assert.throws(() => cli.checkedMessage({ ...message, payload: sent.payload, body: 'another reply' }, envelope), OrcaContractError)
})

test('a lost answer from a bot’s chat is settled from Orca’s receipt, not by sending again', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.bots.set(SESSION, BOT)
  t.orca.state.sendFault = 'answer-lost'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.orca.sends().length, 1)
})

test('in a bot’s mailbox, only mail with this exact text settles a doubt', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.bots.set(SESSION, BOT)
  t.orca.state.sendFault = 'dropped'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  const envelope = buildEnvelope(t.inbox.key, SESSION, reply('msg_1'))
  const botPayload = JSON.stringify({ botRequest: { kind: 'status' } })
  // Another reply's mail to the same bot, from the plugin: not this one.
  t.orca.state.mail.push({ id: 'mail_other', from_handle: 'plannotator-inbox', to_handle: `orca_session_id:${SESSION}`, subject: envelope.subject, body: 'another reply', payload: botPayload, delivered_at: '2026-01-01T00:00:00Z' })
  t.advance(60_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, AMBIGUOUS)
  t.orca.state.mail.push({ id: 'mail_late', from_handle: 'plannotator-inbox', to_handle: `orca_session_id:${SESSION}`, subject: envelope.subject, body: envelope.body, payload: botPayload, delivered_at: '2026-01-01T00:00:00Z' })
  t.advance(60_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(t.ledger.get(t.key('msg_1'))?.message, 'mail_late')
  assert.equal(t.orca.sends().length, 1)
})

test('a refusal Orca documents as having no effect is held for a person in plain words, and Send again works', async () => {
  const cases: [string, string, RegExp][] = [
    ['session_caller_not_live', 'Chat claude_x has ended: its chat was closed. No message was sent.', /^This chat has ended in Orca \(it was closed\), so the reply was not sent\./],
    ['session_caller_unknown', 'No such session.', /^Orca has no such chat on this computer/],
    ['bots_disabled', 'Bots are off on this computer, so do the work yourself.', /^This chat is a bot’s, and bots are switched off in Orca, so the reply was not sent\. Switch bots on in Orca, then press Send again\.$/],
    ['session_caller_host_boundary', 'Session identity is same-host only.', /^Orca refused this reply and nothing was sent: Session identity is same-host only\. It is still in the Inbox\.$/]
  ]
  for (const [code, message, words] of cases) {
    const t = await setup({ deliverAtOnce: true })
    t.orca.state.bots.set(SESSION, BOT)
    t.orca.state.refusal = { code, message }
    assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked', code)
    assert.match(t.ledger.get(t.key('msg_1'))?.error ?? '', words)
    assert.equal(t.orca.state.mail.length, 0)
    assert.equal(t.inboxFake.state.acknowledged.length, 0, 'never reported as delivered')
    // Nothing is read back or sent again by itself.
    t.advance(60_000)
    assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
    assert.equal(t.orca.sends().length, 1)
    t.orca.state.refusal = null
    assert.equal(await t.courier.retry(t.key('msg_1')), true)
    assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
    assert.equal(t.orca.state.mail.length, 1)
  }
})

test('a refusal under a general code (a paused bot) is never taken for a delivery, nor sent twice', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.bots.set(SESSION, BOT)
  t.orca.state.refusal = { code: 'runtime_error', message: `${BOT} is paused, so do the work yourself or tell the asker to try again once its owner unpauses it.` }
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(t.ledger.get(t.key('msg_1'))?.error, AMBIGUOUS)
  t.advance(60_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(t.orca.sends().length, 1)
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
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

test('on Windows a mail fits one command line, so a shorter reply already points at the thread', () => {
  const short = buildEnvelope('k'.repeat(64), SESSION, reply('msg_1', { body: 'word '.repeat(1000) }), 'win32')
  assert.match(short.body, /word word/)
  const long = buildEnvelope('k'.repeat(64), SESSION, reply('msg_1', { body: 'x'.repeat(40_000) }), 'win32')
  assert.match(long.body, /too long to include here/)
  // Quoting can double an argument; twice the whole mail still leaves room in Windows' 32,767 characters.
  for (const envelope of [short, long]) {
    assert.ok(2 * (Buffer.byteLength(envelope.body) + Buffer.byteLength(envelope.payload) + Buffer.byteLength(envelope.subject)) <= 2 * MAX_ENVELOPE_BYTES_WINDOWS)
  }
  assert.ok(2 * MAX_ENVELOPE_BYTES_WINDOWS < 32_767 - 2000)
  assert.match(buildEnvelope('k'.repeat(64), SESSION, reply('msg_1', { body: 'x'.repeat(40_000) }), 'darwin').body, /x{40000}/)
})

test('the subject says what arrived, then the thread: Orca shows it beside a sender it calls "an agent"', () => {
  const subject = (overrides: Record<string, unknown>): string => buildEnvelope('k'.repeat(64), SESSION, reply('msg_s', overrides as never)).subject
  assert.equal(subject({}), 'Inbox reply: Ship it?')
  assert.equal(subject({ subject: '  Ship\n it?  ' }), 'Inbox reply: Ship it?')
  // An unnamed thread: no title is made up for it.
  assert.equal(subject({ subject: null }), 'Inbox reply')
  assert.equal(subject({ type: 'message', subject: null }), 'Inbox message')
  assert.equal(subject({ type: 'message', new_thread: true }), 'Inbox message: Ship it?')
  assert.equal(subject({ type: 'message', handoff: { from: 'Codex' } }), 'Inbox thread handed to you: Ship it?')
  assert.equal(subject({ handed_away: true }), 'Inbox thread handed on: Ship it?')
  assert.equal(subject({ tagged: true }), 'Inbox tag: Ship it?')
  assert.equal(subject({ reask: true }), 'Inbox ask again: Ship it?')
  assert.equal(subject({ ack_of: 'msg_question' }), 'Inbox reaction: Ship it?')
  assert.equal(subject({ subject: 'x'.repeat(1000) }).length, 300)
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
  assert.equal(sessions.get('claude_a')?.bot, null)
  // A bot's home names its chats as the bot's; a workspace only nested under a bot does not.
  const pane = (session: string) => `structured-agent-session-${session}:00000000-0000-4000-8000-000000000009`
  const listed = parseInventory({
    worktrees: [
      { path: '/bots/one', hostId: 'local', workspaceKind: 'folder-workspace', repoId: 'folder-workspace:group1', bot: ' Lighthouse  Keeper ', botHome: true, agents: [{ paneKey: pane('home'), agentType: 'claude', conversationName: 'Lighthouse Keeper' }] },
      { path: '/w/taken', hostId: 'local', bot: 'Lighthouse Keeper', agents: [{ paneKey: pane('nested'), agentType: 'codex' }] },
      { path: '/bots/two', hostId: 'local', bot: 42, botHome: true, agents: [{ paneKey: pane('odd') }] }
    ]
  })
  assert.deepEqual([...listed.values()].map((chat) => [chat.session, chat.bot, chat.workspacePath]), [
    ['home', 'Lighthouse Keeper', '/bots/one'],
    ['nested', null, '/w/taken'],
    ['odd', null, '/bots/two']
  ])
  assert.throws(() => parseInventory({ worktrees: [], truncated: true }))
  assert.throws(() => parseInventory({ panes: [] }))
})

test('a blocked or lead-waiting chat is read from the listing, a child’s wait is not', () => {
  const pane = (n: number) => `structured-agent-session-chat_${n}:00000000-0000-4000-8000-00000000000${n}`
  // The fields Orca 1.4.266 lists for a native chat's status.
  const sessions = parseInventory({
    worktrees: [
      {
        path: '/w',
        hostId: 'local',
        agents: [
          { paneKey: pane(1), state: 'blocked', mainAgent: { state: 'blocked', stateStartedAt: 1700000000000 }, stateStartedAt: 1700000000000 },
          { paneKey: pane(2), state: 'waiting', mainAgent: { state: 'waiting', stateStartedAt: 1700000001000 }, stateStartedAt: 1700000001000 },
          { paneKey: pane(3), state: 'waiting', mainAgent: { state: 'working', stateStartedAt: 1700000002000 }, stateStartedAt: 1700000002000 },
          { paneKey: pane(4), state: 'working', mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1 } },
          { paneKey: pane(5), state: 'done', stateStartedAt: 'soon' },
          { paneKey: pane(6), state: 'waiting' }
        ]
      }
    ]
  })
  assert.deepEqual(
    [...sessions.values()].map((chat) => [chat.session, chat.waiting, chat.stateStartedAt, chat.busy]),
    [
      ['chat_1', 'blocked', 1700000000000, false],
      ['chat_2', 'lead-waiting', 1700000001000, false],
      ['chat_3', null, 1700000002000, false],
      ['chat_4', null, null, true],
      ['chat_5', null, null, false],
      ['chat_6', null, null, false]
    ]
  )
})

test('the kind of a prompt comes from the chat’s pending entries, never its words', async () => {
  const words = 'Allow `rm -rf build`? (private words of the conversation)'
  const orca = fakeOrca({ sessions: [SESSION] })
  const cli = new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} })
  const read = (entries: Record<string, unknown>[]) => {
    orca.state.entries.set(SESSION, entries)
    return cli.pendingPromptKind(SESSION)
  }
  const said = { kind: 'message', role: 'assistant', text: words }
  assert.equal(await read([said, { kind: 'approval', text: words, pending: true }]), 'permission')
  assert.equal(await read([said, { kind: 'question', text: words, pending: true }]), 'question')
  // Both at once: the permission, which the turn cannot pass without.
  assert.equal(await read([{ kind: 'question', text: words, pending: true }, { kind: 'approval', text: words, pending: true }]), 'permission')
  // Answered prompts, and anything that is not a prompt, are not a wait.
  assert.equal(await read([said, { kind: 'approval', text: words, pending: false }, { kind: 'tool', name: 'Bash', pending: true }]), null)
  assert.equal(await read([]), null)
  const call = orca.state.calls.at(-1)!
  assert.deepEqual(call, ['agent', 'read', '--id', `orca_session_id:${SESSION}`, '--limit', '10'])
  // A chat Orca does not know, and an Orca without `agent read`, give no kind; neither throws.
  assert.equal(await cli.pendingPromptKind('claude_unknown_chat'), null)
  orca.state.agentRead = false
  assert.equal(await read([{ kind: 'approval', text: words, pending: true }]), null)
  // An answer of another shape is no kind.
  assert.equal(promptKindOf({ entries: 'approval' }), null)
  assert.equal(promptKindOf(null), null)
  assert.equal(promptKindOf({ entries: [{ kind: 'approval', pending: 'yes' }] }), null)

  // Once per wait: a kind found stands until the chat's state starts again; none found is read again later.
  let clock = 1_000_000
  let reads = 0
  const kinds = new PromptKinds(() => clock)
  let answer: 'permission' | 'question' | null = 'permission'
  const reader = { pendingPromptKind: async () => (reads++, answer) }
  assert.equal(await kinds.kindOf(reader, SESSION, 500), 'permission')
  clock += 120_000
  assert.equal(await kinds.kindOf(reader, SESSION, 500), 'permission')
  assert.equal(reads, 1)
  answer = null
  assert.equal(await kinds.kindOf(reader, SESSION, 900), null, 'a new wait is read again')
  assert.equal(await kinds.kindOf(reader, SESSION, 900), null)
  assert.equal(reads, 2)
  answer = 'question'
  clock += 60_000
  assert.equal(await kinds.kindOf(reader, SESSION, 900), 'question', 'none found is read again after a minute')
  assert.equal(reads, 3)
  // Two asking at once share one read.
  const shared = await Promise.all([kinds.kindOf(reader, 'claude_other', 1), kinds.kindOf(reader, 'claude_other', 1)])
  assert.deepEqual(shared, ['question', 'question'])
  assert.equal(reads, 4)
  // A reader that fails is no kind.
  assert.equal(await kinds.kindOf({ pendingPromptKind: () => Promise.reject(new Error('down')) }, 'claude_third', 1), null)
})

test('the reply goes to Orca through standard input, never on the command line', async () => {
  const t = await setup({ deliverAtOnce: true })
  const words = 'Yes, ship it. Private words that must not show in the process list.'
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1', { body: words })), 'acknowledged')
  const [send] = t.orca.sends()
  assert.ok(send)
  assert.equal(send[send.indexOf('--body-file') + 1], '-')
  assert.ok(!send.includes('--body'))
  assert.ok(!send.some((arg) => arg.includes('Private words')), 'the words are not an argument')
  assert.match(t.orca.state.stdin[0] ?? '', /Private words that must not show/)
  assert.equal(t.orca.state.mail[0]!.body, t.orca.state.stdin[0])
})

test('a reply of 300 KB reaches the chat whole where Orca takes the body through standard input', async () => {
  const t = await setup({ deliverAtOnce: true })
  const words = `${'Line of the person’s reply, with "quotes" and \\ backslashes.\n'.repeat(5000)}end`
  assert.ok(Buffer.byteLength(words) > 300_000)
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1', { body: words })), 'acknowledged')
  const mail = t.orca.state.mail[0]!
  assert.ok(mail.body.includes(`\n\n${words}\n\n`), 'the words arrive as written')
  assert.doesNotMatch(mail.body, /too long to include here/)
  // Measured as JSON, as Orca's CLI counts it on its way to the app, it stays well inside 1 MiB.
  assert.ok(Buffer.byteLength(JSON.stringify(mail.body)) <= MAX_ENVELOPE_BYTES_STDIN)
  assert.ok(MAX_ENVELOPE_BYTES_STDIN * 2 <= 1024 * 1024)
  // Longer than that still wakes the chat, and points at the thread.
  const huge = buildEnvelope('k'.repeat(64), SESSION, reply('msg_2', { body: 'x'.repeat(600_000) }), 'darwin', 'stdin')
  assert.match(huge.body, /too long to include here/)
})

test('an Orca without --body-file gets the reply on the command line, and is asked only once', async () => {
  const t = await setup({ deliverAtOnce: true })
  t.orca.state.bodyFile = false
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'acknowledged')
  assert.equal(await t.courier.deliver(t.inbox, ROUTE, reply('msg_2', { body: 'x'.repeat(70_000) })), 'acknowledged')
  const sends = t.orca.sends()
  assert.equal(sends.length, 2)
  assert.ok(sends.every((args) => args.includes('--body') && !args.includes('--body-file')))
  assert.equal(t.orca.state.schemaReads, 1, 'the answer is remembered')
  assert.match(t.orca.state.mail[0]!.body, /Yes, ship it\./)
  // On the command line the old limit holds: a long reply points at the thread.
  assert.match(t.orca.state.mail[1]!.body, /too long to include here/)
})

test('when Orca refuses --body-file after all, the same request goes once more on the command line', async () => {
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const cli = new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} })
  assert.equal(await cli.takesBodyFile(), true)
  // The schema said yes, but this CLI's argument check does not know the flag.
  orca.state.bodyFile = false
  const envelope = buildEnvelope('k'.repeat(64), SESSION, reply('msg_1'))
  const message = await cli.send(envelope, 'request-1')
  assert.equal(message.body, envelope.body)
  const sends = orca.sends()
  assert.equal(sends.length, 2)
  assert.ok(sends[0]!.includes('--body-file'))
  assert.ok(sends[1]!.includes('--body') && !sends[1]!.includes('--body-file'))
  assert.ok(sends.every((args) => args[args.indexOf('--retry-request') + 1] === 'request-1'), 'one request, never a second one')
  assert.equal(orca.state.mail.length, 1)
  // Remembered: the next send goes straight to the command line.
  await cli.send(buildEnvelope('k'.repeat(64), SESSION, reply('msg_2')), 'request-2')
  assert.equal(orca.sends().length, 3)
  assert.equal(await cli.takesBodyFile(), false)
})

test('a reply too long for an Orca without --body-file is held for a person, in words, and nothing is sent', async () => {
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const inboxFake = fakeInbox()
  const inbox = new InboxClient('/data/plannotator', { fetch: inboxFake.fetch, readRegistry: inboxFake.readRegistry })
  const ledger = new Ledger(memoryStore())
  await ledger.load()
  const cli = new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} })
  const courier = new Courier(cli, ledger)
  const words = 'x'.repeat(200_000)
  // The schema said yes, so the reply was frozen at its full length; then the flag is refused.
  assert.equal(await cli.takesBodyFile(), true)
  orca.state.bodyFile = false
  assert.equal(await courier.deliver(inbox, ROUTE, reply('msg_1', { body: words })), 'blocked')
  const row = ledger.get(Ledger.key(inbox.key, 'msg_1', SESSION))!
  assert.match(row.error ?? '', /too long for this Orca’s command line.*nothing was sent.*Update Orca/)
  assert.equal(orca.state.mail.length, 0)
  assert.ok(!orca.sends().some((args) => args.includes('--body')), 'never put on a command line that cannot hold it')
  assert.equal(inboxFake.state.acknowledged.length, 0)
})

test('a reply Orca refuses outright, before sending, is held for a person in Orca’s words', async () => {
  const t = await setup({ deliverAtOnce: true })
  const exec = t.orca.exec
  const cli = new OrcaCli({
    command: ['orca'],
    env: {},
    exec: async (file, args, options) =>
      args.includes('send')
        ? {
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              error: { code: 'invalid_argument', message: 'The serialized runtime request exceeds the 1048576-byte local transport limit. Shorten the request before retrying.', data: { requestSent: false } }
            })
          }
        : exec(file, args, options)
  })
  const courier = new Courier(cli, t.ledger)
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked')
  assert.equal(
    t.ledger.get(t.key('msg_1'))?.error,
    'Orca refused this reply and nothing was sent: The serialized runtime request exceeds the 1048576-byte local transport limit. Shorten the request before retrying. It is still in the Inbox.'
  )
  assert.equal(await courier.deliver(t.inbox, ROUTE, reply('msg_1')), 'blocked', 'not tried again every few seconds')
  assert.equal(t.inboxFake.state.acknowledged.length, 0)
})

test('the body reaches a real program’s standard input whole, and is not in its arguments', async () => {
  const folder = await tempDir()
  const script = join(folder, 'orca-cli.cjs')
  // A stand-in for Orca's CLI as a real process: its schema, and a send that reads --body-file -.
  await writeFile(
    script,
    `const args = process.argv.slice(2)
if (args[0] === 'agent-context') {
  console.log(JSON.stringify({ schemaVersion: 1, commands: [{ command: 'orchestration send', flags: ['body', 'body-file'] }] }))
} else {
  const value = (name) => args[args.indexOf(name) + 1]
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
    const body = value('--body-file') === '-' ? Buffer.concat(chunks).toString('utf8') : value('--body')
    const message = { id: 'mail_1', from_handle: value('--from'), to_handle: value('--to'), subject: value('--subject'), body, payload: value('--payload'), argvBytes: Buffer.byteLength(args.join(' ')) }
    console.log(JSON.stringify({ ok: true, result: { message } }))
  })
}
`
  )
  const cli = new OrcaCli({ command: [process.execPath, script], env: { PATH: process.env.PATH } })
  const words = `${'ünïcødé and plain words; '.repeat(13_000)}end`
  assert.ok(Buffer.byteLength(words) > 300_000)
  const envelope = buildEnvelope('k'.repeat(64), SESSION, reply('msg_1', { body: words }), process.platform, 'stdin')
  const message = await cli.send(envelope, 'request-1')
  assert.equal(message.body, envelope.body)
  assert.ok(message.body.includes(words))
  assert.ok((message.argvBytes as number) < 2000, 'the command line holds no words')
})
