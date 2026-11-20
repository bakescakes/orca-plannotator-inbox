import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, type EngineDeps, type EngineSettings, type EngineStatus } from '../src/engine'
import { Lifecycle, inboxSource, type NativeRun } from '../src/lifecycle'
import { OrcaCli } from '../src/orca-cli'
import { fakeInbox, fakeLifecycleOrca, fakeNative, fakeOrca, launchThread, memoryStore, personMessage, reply, tempDir, threadAnswer, until } from './fakes'

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
