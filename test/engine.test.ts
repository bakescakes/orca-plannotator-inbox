import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, type EngineSettings, type EngineStatus } from '../src/engine'
import { fakeInbox, fakeOrca, memoryStore, reply, tempDir, until } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'

async function setup(options: { sessions?: string[]; register?: string[]; settings?: Partial<EngineSettings>; inboxRan?: boolean } = {}) {
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
    legacyConfig: join(home, 'legacy.json')
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

test('it stands by while the adapter it replaces is alive for the same Inbox', async () => {
  const t = await setup()
  const stateDir = join(t.home, 'legacy-state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(t.home, 'legacy.json'), JSON.stringify({ stateDir, dataDirs: [t.dataDir] }))
  await writeFile(join(stateDir, 'status.json'), JSON.stringify({ version: 1, at: new Date().toISOString() }))
  t.engine.start()
  try {
    assert.equal((await t.engine.refresh()).phase, 'standby')
    assert.equal(t.inbox.state.polls.length, 0)
    assert.equal((await t.heartbeat()).delivering, false)
    // The adapter stopped: its status goes stale and the plugin takes over.
    await writeFile(join(stateDir, 'status.json'), JSON.stringify({ version: 1, at: new Date(Date.now() - 10 * 60_000).toISOString() }))
    assert.equal((await t.engine.refresh()).phase, 'ready')
    // What the adapter had already put in the chat's mailbox is finished, not sent a second time.
    t.orca.state.mail.push({
      id: 'mail_theirs',
      from_handle: 'plannotator-orca-adapter',
      to_handle: `orca_session_id:${SESSION}`,
      subject: 'Plannotator: Ship it?',
      body: 'Plannotator Inbox item',
      payload: JSON.stringify({ adapter: 'plannotator-orca-adapter', version: 1, replyId: 'msg_1', nativeSessionId: SESSION }),
      delivered_at: '2026-01-01T00:00:00Z'
    })
    t.inbox.state.queue.set(SESSION, [reply('msg_1')])
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement')
    assert.equal(t.orca.sends().length, 0)
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
