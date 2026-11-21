import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, type EngineDeps, type EngineSettings, type EngineStatus } from '../src/engine'
import { Lifecycle, inboxSource, type NativeRun } from '../src/lifecycle'
import { OrcaCli, PromptKinds } from '../src/orca-cli'
import { agentMessage, fakeInbox, fakeLifecycleOrca, fakeNative, fakeOrca, launchThread, memoryStore, personMessage, reply, tempDir, threadAnswer, until } from './fakes'
import { isRecord } from '../src/util'

const SESSION = 'claude_1b491d4a_6f38'

async function setup(options: { sessions?: string[]; register?: string[]; settings?: Partial<EngineSettings>; inboxRan?: boolean; deps?: (inbox: ReturnType<typeof fakeInbox>) => Partial<EngineDeps> } = {}) {
  const root = await tempDir()
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const dataDir = join(root, 'data')
  await mkdir(join(shared, 'sessions'), { recursive: true })
  await mkdir(home, { recursive: true })
  const orca = fakeOrca({ sessions: options.sessions ?? [SESSION], deliverAtOnce: true })
  const inbox = fakeInbox()
  if (options.inboxRan !== false) await inbox.writeRegistry(dataDir)
  const register = async (session: string, at = Date.now()): Promise<void> => {
    await writeFile(join(shared, 'sessions', `${session}.json`), JSON.stringify({ v: 1, session, raw: session, projectPath: '/work/project', dataDir, at }))
  }
  for (const session of options.register ?? [SESSION]) await register(session)
  const statuses: EngineStatus[] = []
  const settings: EngineSettings = { enabled: true, dataDir, orcaCliPath: '', ...options.settings }
  const engine = new Engine({
    settings: async () => settings,
    store: memoryStore(),
    env: { PATH: '/bin' },
    home,
    sharedDir: shared,
    log: () => undefined,
    onStatus: (status) => statuses.push(status),
    exec: orca.exec,
    fetch: inbox.fetch,
    locateCli: () => ['orca'],
    tickMs: 30,
    ...options.deps?.(inbox)
  })
  const heartbeat = async (): Promise<{ delivering: boolean; dataDir: string }> => JSON.parse(await readFile(join(shared, 'state.json'), 'utf8'))
  return { root, home, shared, dataDir, orca, inbox, engine, statuses, settings, register, heartbeat }
}

test('a reply for a registered open chat is delivered and acknowledged', async () => {
  const t = await setup()
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement')
    assert.equal(t.orca.sends().length, 1)
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'ready')
    assert.deepEqual(status.sessions.map((chat) => chat.session), [SESSION])
    assert.equal(status.counts.delivered, 1)
    assert.equal((await t.heartbeat()).delivering, true)
    const poll = t.inbox.state.polls[0]!
    assert.equal(poll.host, 'orca')
    assert.equal(poll.session, SESSION)
    assert.equal(poll.project_path, '/work/project')
  } finally {
    await t.engine.stop()
  }
  assert.equal((await t.heartbeat()).delivering, false, 'stopping says so')
})

test('a bot’s chat is listened for and named as the bot’s; chosen projects count its home like any folder', async () => {
  const logs: string[] = []
  const t = await setup({ register: [], deps: () => ({ log: (line: string) => logs.push(line) }) })
  t.orca.state.bots.set(SESSION, 'Lighthouse Keeper')
  // As the launcher registers a chat in a bot's home: the home is its project.
  await writeFile(join(t.shared, 'sessions', `${SESSION}.json`), JSON.stringify({ v: 1, session: SESSION, raw: SESSION, projectPath: '/bots/home-1', dataDir: t.dataDir, at: Date.now() }))
  t.inbox.state.root = '/bots/home-1'
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement')
    const status = await t.engine.refresh()
    assert.deepEqual(
      status.sessions.map((chat) => [chat.session, chat.title, chat.bot]),
      [[SESSION, 'Chat 1', 'Lighthouse Keeper (Claude bot)']]
    )
    assert.ok(logs.includes('listening for replies to a bot’s chat: Lighthouse Keeper (Claude bot)'), logs.join('\n'))
    assert.equal(t.orca.state.mail[0]?.to_handle, `orca_session_id:${SESSION}`)

    // A reply that needs a person says which bot it is for.
    t.orca.state.refusal = { code: 'bots_disabled', message: 'Bots are off on this computer.' }
    t.inbox.state.queue.set(SESSION, [reply('msg_2')])
    await until(async () => (await t.engine.refresh()).blocked.length === 1, 'the refusal to be held')
    const held = (await t.engine.refresh()).blocked[0]!
    assert.equal(held.bot, 'Lighthouse Keeper (Claude bot)')
    assert.match(held.error ?? '', /bots are switched off in Orca/)

    // A bot's home is not inside a chosen project folder unless it is listed, as for any chat.
    t.settings.projects = ['/work/project']
    const limited = await t.engine.refresh()
    assert.deepEqual(limited.sessions, [])
    assert.match(limited.detail ?? '', /1 chat\(s\) outside the chosen projects/)
    t.settings.projects = ['/work/project', '/bots']
    assert.deepEqual((await t.engine.refresh()).sessions.map((chat) => chat.bot), ['Lighthouse Keeper (Claude bot)'])
  } finally {
    await t.engine.stop()
  }
})

test('a chat that is not open in Orca is not polled, so the Inbox does not show it as connected', async () => {
  const t = await setup({ sessions: [], register: [SESSION] })
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'ready')
    assert.deepEqual(status.sessions, [])
    assert.equal(t.inbox.state.polls.length, 0)
    assert.match(status.detail ?? '', /not in Orca’s list of open chats/)
  } finally {
    await t.engine.stop()
  }
})

test('chats that wrote before are found from the Inbox’s own thread list', async () => {
  const t = await setup({ register: [] })
  t.inbox.state.threads = {
    projects: [{ id: 'p1', root: '/work/project' }],
    sections: [{ threads: [{ id: 'thr_1', project_id: 'p1', author: { kind: 'agent', host: 'orca', session: SESSION } }, { id: 'thr_2', author: { kind: 'agent', host: 'codex', session: 'codex_x' } }] }]
  }
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement')
    assert.deepEqual([...new Set(t.inbox.state.polls.map((poll) => poll.session))], [SESSION])
  } finally {
    await t.engine.stop()
  }
})

test('a chat that wrote under both spellings of its id gets the replies from both queues', async () => {
  const t = await setup({ register: [] })
  const prefixed = `orca_session_id:${SESSION}`
  t.inbox.state.threads = {
    projects: [],
    sections: [{ threads: [{ id: 'thr_1', author: { kind: 'agent', host: 'orca', session: SESSION } }, { id: 'thr_2', author: { kind: 'agent', host: 'orca', session: prefixed } }] }]
  }
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.inbox.state.queue.set(prefixed, [reply('msg_2', { thread_id: 'thr_2' })])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 2, 'both acknowledgements')
    assert.deepEqual(
      t.inbox.state.acknowledged.map((ack) => `${ack.session} ${ack.id}`).sort(),
      [`${SESSION} msg_1`, `${prefixed} msg_2`].sort(),
      'each reply is acknowledged in the queue it came from'
    )
    assert.equal(t.orca.sends().length, 2)
    assert.deepEqual((await t.engine.refresh()).sessions.map((chat) => chat.session), [SESSION], 'still one chat')
  } finally {
    await t.engine.stop()
  }
})

test('switched off: nothing is polled and agents are not told replies arrive by themselves', async () => {
  const t = await setup({ settings: { enabled: false } })
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'off')
    assert.equal(t.inbox.state.polls.length, 0)
    assert.equal(t.orca.state.calls.length, 0)
    assert.equal((await t.heartbeat()).delivering, false)
  } finally {
    await t.engine.stop()
  }
})

test('a worker that is not delivering leaves another profile’s live heartbeat alone', async () => {
  const t = await setup({ settings: { enabled: false } })
  // A second Orca profile under the same account: its worker is another process and it delivers.
  const theirs = (at: number) => writeFile(join(t.shared, 'state.json'), JSON.stringify({ v: 1, pid: process.pid + 1, at, dataDir: t.dataDir, delivering: true }))
  await theirs(Date.now())
  t.engine.start()
  try {
    assert.equal((await t.engine.refresh()).phase, 'off')
    assert.equal((await t.heartbeat()).delivering, true, 'still the other worker’s word')
    // That worker is gone: its heartbeat is no longer renewed, and this one says what is true now.
    await theirs(Date.now() - 5 * 60_000)
    await t.engine.refresh()
    assert.equal((await t.heartbeat()).delivering, false)
  } finally {
    await t.engine.stop()
  }
})

test('a stopped Inbox still counts as deliverable: the chat’s first message starts it', async () => {
  const t = await setup()
  t.inbox.state.up = false
  t.engine.start()
  try {
    assert.equal((await t.engine.refresh()).phase, 'inbox-stopped')
    assert.equal((await t.heartbeat()).delivering, true)
    t.inbox.state.up = true
    t.inbox.state.queue.set(SESSION, [reply('msg_1')])
    await until(() => t.inbox.state.acknowledged.length === 1, 'delivery after the Inbox came up')
  } finally {
    await t.engine.stop()
  }
})

test('an Inbox that never ran here is reported, and still deliverable once Orca answers', async () => {
  const t = await setup({ inboxRan: false })
  t.engine.start()
  try {
    assert.equal((await t.engine.refresh()).phase, 'no-plannotator')
    assert.equal((await t.heartbeat()).delivering, true)
  } finally {
    await t.engine.stop()
  }
})

test('when Orca’s CLI does not answer, delivery pauses and says so', async () => {
  const t = await setup()
  t.orca.state.reachable = false
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'no-orca')
    assert.equal(t.inbox.state.polls.length, 0)
    assert.equal((await t.heartbeat()).delivering, false)
  } finally {
    await t.engine.stop()
  }
})

test('if Orca starts naming chats differently, nothing is polled and the status says why', async () => {
  const t = await setup()
  t.orca.state.inventoryShape = 'renamed'
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.deepEqual(status.sessions, [])
    assert.equal(t.inbox.state.polls.length, 0)
    assert.match(status.detail ?? '', /not in Orca’s list of open chats/)
  } finally {
    await t.engine.stop()
  }
})

test('a registration for another Inbox is ignored', async () => {
  const t = await setup({ register: [] })
  await writeFile(join(t.shared, 'sessions', `${SESSION}.json`), JSON.stringify({ v: 1, session: SESSION, raw: SESSION, dataDir: join(t.root, 'elsewhere'), at: Date.now() }))
  t.engine.start()
  try {
    assert.deepEqual((await t.engine.refresh()).sessions, [])
    assert.equal(t.inbox.state.polls.length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('a Stop pressed while a reply is being prepared waits for it, and nothing reaches the chat after the Stop', async () => {
  // The bridge's side, as the worker wires it: a chat the Inbox started, its Stop, and the delivery gate.
  const lifeOrca = fakeLifecycleOrca()
  const native = fakeNative(lifeOrca)
  const lifeInbox = fakeInbox()
  const LAUNCH = { id: 'launch_1', agent: 'codex', folder: '/work/project' }
  lifeInbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', LAUNCH))
  let ids = 0
  const life = new Lifecycle({
    store: memoryStore(),
    cli: () => new OrcaCli({ command: ['orca'], exec: lifeOrca.exec, env: {} }),
    source: () => inboxSource('/data', { fetch: lifeInbox.fetch, readRegistry: lifeInbox.readRegistry }),
    projects: () => [],
    deliveryState: () => 'unknown',
    native: native.run as NativeRun,
    reveal: async (session) => ({ ok: true, sessionId: session, workspaceId: 'wt1' }),
    log: () => undefined,
    now: () => 1_800_000_000_000,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  })
  const started = await life.handle('start', { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', ownerAction: true })
  const chat = String(started.session)
  // The reply was written before the Stop, so once the chat is stopped it is held.
  const held = reply('msg_held', { thread_id: 'thr_held', to: { host: 'orca', session: chat } } as never)
  lifeInbox.state.details.set('thr_held', threadAnswer('thr_held', '/work/project', [personMessage('msg_held', null)]))

  // The courier's read of the reply's thread waits until the test lets it go.
  let release!: () => void
  const paused = new Promise<void>((resolve) => (release = resolve))
  let reads = 0
  const t = await setup({
    sessions: [chat],
    register: [chat],
    deps: (inbox) => ({
      gate: (session, item) => life.deliveryAllowed(session, item),
      exclusive: (session, task) => life.exclusive(session, task),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/api/inbox/threads/thr_held') {
          reads += 1
          await paused
        }
        return inbox.fetch(input, init)
      }) as typeof fetch
    })
  })
  t.inbox.state.queue.set(chat, [held])
  t.engine.start()
  try {
    await until(() => reads === 1, 'the courier reading the reply’s thread')
    let stopped = false
    const stopping = life.handle('stop', { launchId: 'launch_1', session: chat, ownerAction: true, actionId: '11111111-1111-4111-8111-000000000001' }).then((answer) => {
      stopped = true
      return answer
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(stopped, false, 'the Stop waits for the delivery that already passed the gate')
    release()
    assert.equal((await stopping).ok, true)
    const sentBeforeStop = t.orca.sends().length
    const ackedBeforeStop = t.inbox.state.acknowledged.length
    // Give the poll time to hand the reply back and try again.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(t.orca.sends().length, sentBeforeStop, 'nothing is sent to the chat after its Stop completed')
    assert.equal(t.inbox.state.acknowledged.length, ackedBeforeStop, 'nothing is acknowledged after its Stop completed')
  } finally {
    release()
    await t.engine.stop()
  }
})

test('a reply that waited behind another action is not sent once its chat is no longer listened for', async () => {
  // The per-chat step is busy (a Resume or an Open holds it) while the reply waits its turn.
  let release!: () => void
  const busy = new Promise<void>((resolve) => (release = resolve))
  let waiting = 0
  const t = await setup({
    deps: () => ({
      exclusive: async (_session, task) => {
        waiting += 1
        await busy
        return task()
      }
    })
  })
  t.inbox.state.queue.set(SESSION, [reply('msg_late')])
  t.engine.start()
  try {
    await until(() => waiting === 1, 'the reply waiting for its chat’s turn')
    // Delivery ends for the chat while the reply still waits.
    const stopping = t.engine.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await stopping
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(t.orca.sends().length, 0, 'nothing is sent for a route that was stopped while the reply waited')
    assert.equal(t.inbox.state.acknowledged.length, 0, 'and nothing is acknowledged')
  } finally {
    release()
    await t.engine.stop()
  }
})

test('a Stop on one chat does not wait for a delivery to another', async () => {
  const lifeOrca = fakeLifecycleOrca()
  const native = fakeNative(lifeOrca)
  const lifeInbox = fakeInbox()
  lifeInbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', { id: 'launch_1', agent: 'codex', folder: '/work/project' }))
  let ids = 0
  const life = new Lifecycle({
    store: memoryStore(),
    cli: () => new OrcaCli({ command: ['orca'], exec: lifeOrca.exec, env: {} }),
    source: () => inboxSource('/data', { fetch: lifeInbox.fetch, readRegistry: lifeInbox.readRegistry }),
    projects: () => [],
    deliveryState: () => 'unknown',
    native: native.run as NativeRun,
    reveal: async (session) => ({ ok: true, sessionId: session, workspaceId: 'wt1' }),
    log: () => undefined,
    now: () => 1_800_000_000_000,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  })
  const started = await life.handle('start', { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', ownerAction: true })
  const chat = String(started.session)
  let release!: () => void
  const paused = new Promise<void>((resolve) => (release = resolve))
  try {
    // Another chat's delivery holds its own section; this chat's Stop goes ahead.
    void life.exclusive(SESSION, () => paused)
    const answer = await Promise.race([
      life.handle('stop', { launchId: 'launch_1', session: chat, ownerAction: true, actionId: '11111111-1111-4111-8111-000000000002' }),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 2000))
    ])
    assert.notEqual(answer, 'waited')
    assert.equal((answer as { ok: boolean }).ok, true)
  } finally {
    release()
  }
})

test('the Orca build’s delivery check never reports a later reply delivered on the strength of the launch message', async () => {
  const t = await setup()
  const launch = { launchId: 'launch_1', threadId: 'thr_1', messageId: 'msg_launch' }
  assert.equal(t.engine.launchDeliveryState(SESSION, { ...launch, replyId: null }), 'unknown', 'nothing is known before the engine runs')
  t.inbox.state.queue.set(SESSION, [reply('msg_launch')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the launch message acknowledged')
    // Named, a reply is answered for exactly.
    assert.equal(t.engine.launchDeliveryState(SESSION, { ...launch, replyId: 'msg_launch' }), 'acknowledged')
    assert.equal(t.engine.launchDeliveryState(SESSION, { ...launch, replyId: 'msg_later' }), 'unknown', 'a reply not seen yet')
    // Published Orca builds ask without naming the reply: the one being delivered now is a later
    // reply the worker has not seen, so the launch message's receipt says nothing about it.
    assert.equal(t.engine.launchDeliveryState(SESSION, { ...launch, replyId: null }), 'queued', 'held in the Inbox for the courier, which listens for this chat')
    assert.equal(t.engine.launchDeliveryState('claude_not_listened', { ...launch, replyId: null }), 'unknown', 'a chat no one listens for')
  } finally {
    await t.engine.stop()
  }
})

// ---------------------------------------------------------------------------------------------
// Telling the Inbox when a chat waits on the person (Plannotator 0.29.1 `blocked`)

/** A chat at a prompt, as Orca 1.4.266 lists it. */
const BLOCKED = { state: 'blocked', mainAgent: { state: 'blocked' }, stateStartedAt: 1_700_000_000_000 }
/** Words a real chat's prompt holds; they must never leave the plugin's parse of `agent read`. */
const PROMPT_WORDS = 'Allow running the migration on the live database? (private words)'
const PERMISSION = [
  { kind: 'message', role: 'assistant', text: 'Next I will run the migration.' },
  { kind: 'approval', text: PROMPT_WORDS, pending: true }
]
const QUESTION = [{ kind: 'question', text: PROMPT_WORDS, pending: true }]
const promptReads = (orca: ReturnType<typeof fakeOrca>) => orca.state.calls.filter((args) => args[0] === 'agent' && args[1] === 'read')

test('a chat waiting on a permission says so on every poll', async () => {
  const logs: string[] = []
  const t = await setup({ deps: () => ({ log: (line: string) => logs.push(line) }) })
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, PERMISSION)
  t.engine.start()
  try {
    // The first look starts the read of the chat's prompt; when it lands, the Inbox is told at once.
    await until(() => t.inbox.state.events.length === 1, 'the word, as soon as the read lands', 15_000)
    const event = t.inbox.state.events[0]!
    assert.deepEqual(event.blocked, { kind: 'permission' })
    const after = t.inbox.state.polls.length
    await until(() => t.inbox.state.polls.length >= after + 4, 'later polls', 15_000)
    // One poll may have been built just before the look; every one after it says so.
    const polls = t.inbox.state.polls.slice(after + 1)
    for (const poll of polls) {
      assert.deepEqual(poll.blocked, { kind: 'permission' })
      assert.equal(poll.busy, false, 'the chat’s busy flag is what it was')
      assert.equal(poll.blocked_at, event.blocked_at, 'the same word keeps the time it was decided')
    }
    assert.equal(t.inbox.state.events.length, 1, 'nothing changed since, so no other event')
    assert.ok(!JSON.stringify([t.inbox.state.polls, logs, await t.engine.refresh()]).includes('private words'), 'the prompt’s words go nowhere')
  } finally {
    await t.engine.stop()
  }
})

test('a cleared prompt is withdrawn at once with a state event', async () => {
  const t = await setup()
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, QUESTION)
  t.engine.start()
  try {
    await until(() => t.inbox.state.polls.some((poll) => isRecord(poll.blocked)), 'a poll that says the chat waits', 15_000)
    const said = t.inbox.state.polls.find((poll) => isRecord(poll.blocked))!
    assert.deepEqual(said.blocked, { kind: 'question' })
    // The person answers in Orca.
    const before = t.inbox.state.events.length
    t.orca.state.rows.delete(SESSION)
    await t.engine.refresh()
    await until(() => t.inbox.state.events.length === before + 1, 'the state event', 15_000)
    const event = t.inbox.state.events[before]!
    assert.equal(event.host, 'orca')
    assert.equal(event.session, SESSION)
    assert.equal(event.type, 'state')
    assert.ok(!('blocked' in event), 'no word: the Inbox drops it')
    assert.ok(!('busy' in event), 'the event leaves the chat’s busy flag alone')
    assert.ok((event.blocked_at as number) > (said.blocked_at as number), 'newer than every poll that said it')
    const after = t.inbox.state.polls.length
    await until(() => t.inbox.state.polls.length >= after + 3, 'later polls', 15_000)
    // One poll may have been built just before the look; every one after it says nothing.
    for (const poll of t.inbox.state.polls.slice(after + 1)) {
      assert.ok(!('blocked' in poll))
      assert.equal(poll.blocked_at, event.blocked_at)
    }
    await t.engine.refresh()
    assert.equal(t.inbox.state.events.length, before + 1, 'said once')
  } finally {
    await t.engine.stop()
  }
})

test('a long wait is said again before the Inbox forgets it', async () => {
  let clock = Date.now()
  const t = await setup({ deps: () => ({ now: () => clock }) })
  // Held as a real Inbox holds a poll: nothing arrives, so only the look can say it again.
  t.inbox.state.holdMs = 60_000
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, PERMISSION)
  t.engine.start()
  try {
    await until(() => t.inbox.state.polls.length === 1, 'the first poll', 15_000)
    // The read lands after the first poll was sent, so the word goes in a state event.
    await until(() => t.inbox.state.events.length === 1, 'the word, once read', 15_000)
    const said = t.inbox.state.events[0]!
    assert.deepEqual(said.blocked, { kind: 'permission' })
    clock += 19_000
    await t.engine.refresh()
    assert.equal(t.inbox.state.events.length, 1, 'said 19 s ago: not yet')
    clock += 1_000
    await t.engine.refresh()
    await until(() => t.inbox.state.events.length === 2, 'the word said again', 15_000)
    assert.deepEqual(t.inbox.state.events[1]!.blocked, { kind: 'permission' })
    assert.equal(t.inbox.state.events[1]!.blocked_at, said.blocked_at, 'the same word, so the same time')
    clock += 10_000
    await t.engine.refresh()
    assert.equal(t.inbox.state.events.length, 2)
    clock += 10_000
    await t.engine.refresh()
    await until(() => t.inbox.state.events.length === 3, 'said again 20 s later', 15_000)
    assert.equal(t.inbox.state.polls.length, 1, 'the held poll was left alone')
  } finally {
    await t.engine.stop()
  }
})

test('a chat’s prompt is read once per wait, not every look', async () => {
  const t = await setup()
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, PERMISSION)
  t.engine.start()
  try {
    await until(() => t.inbox.state.polls.some((poll) => isRecord(poll.blocked)), 'a poll that says the chat waits', 15_000)
    for (let i = 0; i < 3; i++) await t.engine.refresh()
    assert.equal(promptReads(t.orca).length, 1)
    assert.deepEqual(promptReads(t.orca)[0], ['agent', 'read', '--id', `orca_session_id:${SESSION}`, '--limit', '10'])
    // The chat went on, then stopped at another prompt: a new wait, read again.
    t.orca.state.rows.set(SESSION, { ...BLOCKED, stateStartedAt: BLOCKED.stateStartedAt + 60_000 })
    t.orca.state.entries.set(SESSION, QUESTION)
    await t.engine.refresh()
    await until(() => t.inbox.state.events.some((event) => isRecord(event.blocked) && event.blocked.kind === 'question'), 'the new word', 15_000)
    await t.engine.refresh()
    assert.equal(promptReads(t.orca).length, 2)
  } finally {
    await t.engine.stop()
  }
})

test('an Orca that cannot read a chat sends no kind rather than a guess', async () => {
  for (const scenario of ['no agent read', 'nothing pending', 'a child waits'] as const) {
    const t = await setup()
    t.orca.state.rows.set(SESSION, scenario === 'a child waits' ? { state: 'waiting', mainAgent: { state: 'working' }, stateStartedAt: 1 } : BLOCKED)
    t.orca.state.entries.set(SESSION, scenario === 'nothing pending' ? [{ kind: 'approval', text: PROMPT_WORDS, pending: false }] : PERMISSION)
    t.orca.state.agentRead = scenario !== 'no agent read'
    t.engine.start()
    try {
      await until(() => t.inbox.state.polls.length >= 2, 'two polls', 15_000)
      await t.engine.refresh()
      for (const poll of t.inbox.state.polls) assert.ok(!('blocked' in poll), scenario)
      assert.equal(t.inbox.state.events.length, 0, scenario)
      assert.equal(promptReads(t.orca).length, scenario === 'a child waits' ? 0 : 1, scenario)
    } finally {
      await t.engine.stop()
    }
  }
  // A question the chat's own turn asked and does not wait on is said without reading the chat.
  const t = await setup()
  t.orca.state.rows.set(SESSION, { state: 'waiting', mainAgent: { state: 'waiting' }, stateStartedAt: 1 })
  t.engine.start()
  try {
    await until(() => t.inbox.state.polls.some((poll) => isRecord(poll.blocked)), 'a poll that says the chat waits', 15_000)
    assert.deepEqual(t.inbox.state.polls.find((poll) => isRecord(poll.blocked))!.blocked, { kind: 'question' })
    assert.equal(promptReads(t.orca).length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('a reply to a chat waiting on a prompt is still sent and stays on the way', async () => {
  const t = await setup()
  // Orca holds a chat's mail while a prompt is up.
  t.orca.state.deliverAtOnce = false
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, PERMISSION)
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.orca.sends().length === 1, 'the reply sent to Orca', 15_000)
    await until(() => t.engine.deliveryState(SESSION, 'msg_1') === 'queued', 'Orca took it', 15_000)
    assert.equal(t.inbox.state.acknowledged.length, 0, 'not delivered until the chat takes it')
    assert.ok(t.inbox.state.polls.every((poll) => poll.busy === false))
    await until(() => isRecord(t.inbox.state.polls.at(-1)?.blocked), 'a poll that says the chat waits', 15_000)
    assert.deepEqual(t.inbox.state.polls.at(-1)!.blocked, { kind: 'permission' })
    // The person answers in Orca; the chat takes its mail, and only then is the Inbox told.
    t.orca.state.rows.delete(SESSION)
    t.orca.deliverAll()
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement', 15_000)
    assert.equal(t.orca.sends().length, 1, 'sent once')
  } finally {
    await t.engine.stop()
  }
})

test('a read of a chat’s prompt that does not answer holds up no poll and no reply, for that chat or another', { timeout: 60_000 }, async () => {
  const OTHER = 'claude_2c5a0e1f_7a49'
  // Looks a minute apart: what happens in between is the polls' own doing, or the read's.
  const t = await setup({ sessions: [SESSION, OTHER], register: [SESSION, OTHER], deps: () => ({ tickMs: 60_000 }) })
  t.orca.state.rows.set(SESSION, BLOCKED)
  t.orca.state.entries.set(SESSION, PERMISSION)
  // Orca's `agent read` answers in up to 12 s; this one answers only when the test says.
  let answer = (): void => undefined
  const answered = new Promise<void>((resolve) => (answer = resolve))
  t.orca.state.readGate = () => answered
  t.engine.start()
  try {
    // The first look began delivering (so a person's reply from now on is not one from before the
    // plugin ran) and started the read; both chats are polled while it is out.
    await until(() => promptReads(t.orca).length === 1 && [SESSION, OTHER].every((chat) => t.inbox.state.polls.some((poll) => poll.session === chat)), 'both chats polled while the read is out', 15_000)
    // The person answers both chats now; the other one asked in a thread of its own.
    t.inbox.state.queue.set(SESSION, [reply('msg_blocked')])
    t.inbox.state.details.set('thr_other', threadAnswer('thr_other', '/work/project', [agentMessage('msg_asked', OTHER), personMessage('msg_other', 'msg_asked')]))
    t.inbox.state.queue.set(OTHER, [reply('msg_other', { thread_id: 'thr_other', reply_to: 'msg_asked', url: 'http://127.0.0.1:4999/#/thread/thr_other' })])
    await until(() => t.inbox.state.acknowledged.length === 2, 'both replies delivered while the read is out', 15_000)
    assert.deepEqual(t.inbox.state.acknowledged.map((ack) => ack.id).sort(), ['msg_blocked', 'msg_other'])
    assert.ok(t.inbox.state.polls.every((poll) => !('blocked' in poll)), 'no word until the read lands')
    assert.equal(promptReads(t.orca).length, 1)
    // When it lands, the Inbox is told at once, not at the next look a minute later.
    answer()
    await until(() => t.inbox.state.events.length === 1, 'the word once read', 15_000)
    assert.deepEqual(t.inbox.state.events[0]!.blocked, { kind: 'permission' })
    assert.equal(t.inbox.state.events[0]!.session, SESSION)
  } finally {
    answer()
    await t.engine.stop()
  }
})

test('a blocked episode costs one read of the chat, shared by delivery and the catalog', async () => {
  // As the worker wires them: the engine and the bridge's catalog share one set of prompt kinds.
  const prompts = new PromptKinds()
  const lifeOrca = fakeLifecycleOrca()
  const native = fakeNative(lifeOrca)
  const lifeInbox = fakeInbox()
  lifeInbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', { id: 'launch_1', agent: 'codex', folder: '/work/project' }))
  let ids = 0
  const life = new Lifecycle({
    store: memoryStore(),
    cli: () => new OrcaCli({ command: ['orca'], exec: lifeOrca.exec, env: {} }),
    source: () => inboxSource('/data', { fetch: lifeInbox.fetch, readRegistry: lifeInbox.readRegistry }),
    projects: () => [],
    deliveryState: () => 'unknown',
    prompts,
    native: native.run as NativeRun,
    reveal: async (session) => ({ ok: true, sessionId: session, workspaceId: 'wt1' }),
    log: () => undefined,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  })
  const started = await life.handle('start', { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', ownerAction: true })
  const chat = String(started.session)
  // Both stand-ins list the same chat at the same prompt, as the one real Orca would.
  lifeOrca.state.listed.set(chat, { ...BLOCKED, agentType: 'codex' })
  lifeOrca.state.entries.set(chat, PERMISSION)
  const t = await setup({ sessions: [chat], register: [chat], deps: () => ({ prompts }) })
  t.orca.state.rows.set(chat, BLOCKED)
  t.orca.state.entries.set(chat, PERMISSION)
  const reads = () => promptReads(t.orca).length + lifeOrca.state.calls.filter((args) => args[0] === 'agent' && args[1] === 'read').length
  t.engine.start()
  try {
    await until(() => t.inbox.state.polls.some((poll) => isRecord(poll.blocked)), 'a poll that says the chat waits', 15_000)
    assert.equal(((await life.handle('catalog')).sessions as Record<string, Record<string, unknown>>)[chat]!.waiting, 'permission')
    await t.engine.refresh()
    assert.equal(((await life.handle('catalog')).sessions as Record<string, Record<string, unknown>>)[chat]!.waiting, 'permission')
    assert.equal(reads(), 1)
  } finally {
    await t.engine.stop()
  }
})
