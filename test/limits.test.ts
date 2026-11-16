// The engine's limits: the activation boundary (kept once per Inbox), the chosen projects, and what the heartbeat tells the launcher about them.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Engine, isInside, resolveProjects, type EngineSettings, type EngineStatus } from '../src/engine'
import type { Json } from '../src/util'
import { agentMessage, fakeInbox, fakeOrca, memoryStore, personMessage, reply, tempDir, threadAnswer, until } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'
const HOUR = 60 * 60 * 1000

async function setup(options: { settings?: Partial<EngineSettings>; store?: ReturnType<typeof memoryStore>; worktree?: string; repo?: string | null } = {}) {
  const root = await realpath(await tempDir())
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const dataDir = join(root, 'data')
  await mkdir(join(shared, 'sessions'), { recursive: true })
  await mkdir(home, { recursive: true })
  const worktree = options.worktree ?? '/work/project'
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  orca.state.worktreePath = worktree
  if (options.repo === null) orca.state.repoId = null
  else orca.state.repos = [{ id: 'repo_1', path: options.repo ?? worktree }]
  const inbox = fakeInbox({ root: options.repo ?? worktree })
  await inbox.writeRegistry(dataDir)
  await writeFile(join(shared, 'sessions', `${SESSION}.json`), JSON.stringify({ v: 1, session: SESSION, raw: SESSION, projectPath: worktree, dataDir, at: Date.now() }))
  const statuses: EngineStatus[] = []
  const settings: EngineSettings = { enabled: true, dataDir, orcaCliPath: '', ...options.settings }
  const store = options.store ?? memoryStore()
  const engine = new Engine({
    settings: async () => settings,
    store,
    env: { PATH: '/bin' },
    home,
    sharedDir: shared,
    log: () => undefined,
    onStatus: (status) => statuses.push(status),
    exec: orca.exec,
    fetch: inbox.fetch,
    locateCli: () => ['orca'],
    tickMs: 30,
  })
  const heartbeat = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(shared, 'state.json'), 'utf8'))
  const activation = (): Record<string, number> => (store.data.get('activation.v1') ?? {}) as Record<string, number>
  return { root, home, shared, dataDir, orca, inbox, engine, statuses, settings, store, heartbeat, activation }
}

test('the activation time is kept once per Inbox and never moves later', async () => {
  const store = memoryStore()
  const before = Date.now()
  const first = await setup({ store })
  first.engine.start()
  let kept: number
  try {
    await first.engine.refresh()
    const saved = Object.values(first.activation())
    assert.equal(saved.length, 1)
    kept = saved[0]!
    assert.ok(kept >= before && kept <= Date.now())
  } finally {
    await first.engine.stop()
  }
  // A restart later (same plugin storage, same Inbox key) keeps the first time.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await setup({ store, settings: { dataDir: first.dataDir } })
  second.engine.start()
  try {
    await second.engine.refresh()
    assert.deepEqual(Object.values(second.activation()), [kept])
  } finally {
    await second.engine.stop()
  }
  // An unreadable saved time stops delivery rather than guessing one.
  const broken = await setup({ store: memoryStore({ 'activation.v1': 'garbage' as Json }) })
  broken.engine.start()
  try {
    assert.equal((await broken.engine.refresh()).phase, 'problem')
    assert.equal((await broken.heartbeat()).delivering, false)
  } finally {
    await broken.engine.stop()
  }
})

test('replies written before activation are ignored: not delivered, not acknowledged, not a problem', async () => {
  const t = await setup()
  t.engine.start()
  try {
    await t.engine.refresh()
    t.inbox.state.details.set(
      'thr_old',
      threadAnswer('thr_old', '/work/project', [agentMessage('msg_question', SESSION), personMessage('msg_old', 'msg_question', { created_at: new Date(Date.now() - HOUR).toISOString() })])
    )
    t.inbox.state.queue.set(SESSION, [reply('msg_old', { thread_id: 'thr_old' }), reply('msg_new')])
    await until(() => t.inbox.state.acknowledged.length === 1, 'the new reply')
    assert.deepEqual(t.inbox.state.acknowledged.map((ack) => ack.id), ['msg_new'])
    assert.equal(t.orca.sends().length, 1)
    const status = await t.engine.refresh()
    assert.equal(status.counts.blocked, 0)
    assert.equal(status.counts.rejected, 0)
    assert.deepEqual(status.rejected, [])
    assert.equal(status.counts.inFlight, 0)
  } finally {
    await t.engine.stop()
  }
})

test('a rejected reply shows in the status with its reason and is never acknowledged', async () => {
  const t = await setup()
  // Stamped after the engine's activation time, which is only set once it starts: a reply written
  // before that is ignored, not rejected.
  const later = new Date(Date.now() + 60_000).toISOString()
  t.inbox.state.details.set('thr_1', threadAnswer('thr_1', '/work/project', [agentMessage('msg_question', 'codex_someone_else'), personMessage('msg_1', 'msg_question', { created_at: later })]))
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(async () => (await t.engine.refresh()).counts.rejected === 1, 'the rejection')
    const status = t.engine.status()
    assert.equal(status.rejected.length, 1)
    assert.equal(status.rejected[0]!.subject, 'Ship it?')
    assert.match(status.rejected[0]!.error ?? '', /meant for this chat/)
    assert.equal(status.counts.blocked, 0)
    assert.equal(t.inbox.state.acknowledged.length, 0)
    assert.equal(t.orca.sends().length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('the thread of a reply must be in one of the chat’s own folders', async () => {
  const t = await setup()
  t.inbox.state.root = '/another/project'
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(async () => (await t.engine.refresh()).counts.rejected === 1, 'the rejection')
    assert.match(t.engine.status().rejected[0]!.error ?? '', /different project/)
    assert.equal(t.orca.sends().length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('a folder is inside another only along whole path segments', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
  assert.equal(isInside('/a/b/', '/a/b/c'), true)
  assert.equal(isInside('/', '/anything'), true)
  // Windows: either slash separates folders.
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\c', '\\'), true)
  assert.equal(isInside('C:\\a\\b', 'C:/a/b/c', '\\'), true)
  assert.equal(isInside('C:/a/b', 'C:\\a\\bc', '\\'), false)
  assert.equal(isInside('C:\\a\\b', 'C:\\a', '\\'), false)
})

test('chosen project folders are resolved to real absolute paths', async () => {
  const root = await realpath(await tempDir())
  await mkdir(join(root, 'proj'))
  await symlink(join(root, 'proj'), join(root, 'link'))
  assert.deepEqual(await resolveProjects(undefined), [])
  assert.deepEqual(await resolveProjects([]), [])
  assert.deepEqual(await resolveProjects(['  ', 7]), [])
  assert.deepEqual(await resolveProjects([join(root, 'link'), `${join(root, 'proj')}/`, 'relative/path']), [join(root, 'proj')])
  assert.equal(await resolveProjects(['relative/only']), null)
  assert.deepEqual(await resolveProjects([join(root, 'missing', '..', 'gone')]), [join(root, 'gone')])
})

async function folders() {
  const base = await realpath(await tempDir())
  for (const name of ['proj', 'projX', 'proj/wt', 'worktrees/feature']) await mkdir(join(base, name), { recursive: true })
  await symlink(join(base, 'proj'), join(base, 'proj-link'))
  return base
}

test('limited to chosen projects: a chat in one of them, or inside one, is served', async () => {
  const base = await folders()
  const t = await setup({ worktree: join(base, 'proj', 'wt'), settings: { projects: [join(base, 'proj-link')] } })
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the reply')
    const status = await t.engine.refresh()
    assert.deepEqual(status.projects, [join(base, 'proj')])
    assert.deepEqual(status.sessions.map((chat) => chat.session), [SESSION])
  } finally {
    await t.engine.stop()
  }
})

test('limited to chosen projects: a worktree elsewhere is served when its repository root is chosen', async () => {
  const base = await folders()
  const t = await setup({ worktree: join(base, 'worktrees', 'feature'), repo: join(base, 'proj'), settings: { projects: [join(base, 'proj')] } })
  t.inbox.state.root = join(base, 'worktrees', 'feature')
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    await until(() => t.inbox.state.acknowledged.length === 1, 'the reply')
  } finally {
    await t.engine.stop()
  }
})

test('limited to chosen projects: a chat in a folder that only starts the same is not served', async () => {
  const base = await folders()
  const t = await setup({ worktree: join(base, 'projX'), settings: { projects: [join(base, 'proj')] } })
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'ready')
    assert.deepEqual(status.sessions, [])
    assert.match(status.detail ?? '', /outside the chosen projects/)
    assert.equal(t.inbox.state.polls.length, 0, 'not polled, so the Inbox does not show it as connected')
    assert.equal(t.orca.sends().length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('limited to chosen projects: when Orca cannot list its repositories, only the worktree path counts', async () => {
  const base = await folders()
  const t = await setup({ worktree: join(base, 'worktrees', 'feature'), repo: join(base, 'proj'), settings: { projects: [join(base, 'proj')] } })
  t.orca.state.reposDown = true
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.deepEqual(status.sessions, [])
    assert.equal(t.inbox.state.polls.length, 0)
  } finally {
    await t.engine.stop()
  }
})

test('limited to chosen projects that are all unusable: nothing is served', async () => {
  const t = await setup({ settings: { projects: ['relative/folder'] } })
  t.inbox.state.queue.set(SESSION, [reply('msg_1')])
  t.engine.start()
  try {
    const status = await t.engine.refresh()
    assert.equal(status.phase, 'problem')
    assert.match(status.detail ?? '', /absolute path/)
    assert.equal(t.inbox.state.polls.length, 0)
    assert.equal((await t.heartbeat()).delivering, false)
  } finally {
    await t.engine.stop()
  }
})

test('the heartbeat names the chosen projects as real paths, and leaves the field out for every project', async () => {
  const base = await folders()
  const limited = await setup({ worktree: join(base, 'proj'), settings: { projects: [join(base, 'proj-link'), join(base, 'projX')] } })
  limited.engine.start()
  try {
    await limited.engine.refresh()
    const beat = await limited.heartbeat()
    assert.deepEqual(beat.projects, [join(base, 'proj'), join(base, 'projX')])
    assert.equal(beat.delivering, true)
  } finally {
    await limited.engine.stop()
  }
  assert.deepEqual((await limited.heartbeat()).projects, [join(base, 'proj'), join(base, 'projX')], 'still said when stopping')

  const every = await setup()
  every.engine.start()
  try {
    await every.engine.refresh()
    const beat = await every.heartbeat()
    assert.equal('projects' in beat, false)
    assert.equal(beat.delivering, true)
    assert.deepEqual((await every.engine.refresh()).projects, [])
  } finally {
    await every.engine.stop()
  }
})
