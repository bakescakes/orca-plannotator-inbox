// The worker as Orca runs it: `activate(orca)` over the test kit's host, with the machine replaced.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mockHost, mountWorker } from 'orca/testing'
import * as main from '../src/worker'
import { deactivate, readProjects, start, type Runtime } from '../src/worker'
import type { UpdaterResult } from '../src/build-store'
import { inboxTurnedOn } from '../src/inbox'
import { launcherPath, updaterLauncherName } from '../src/shared'
import { fakeInbox, fakeOrca, reply, tempDir, until } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'
const CAPABILITIES = ['storage:own', 'settings:own', 'notifications:show']

async function machine(settings: Record<string, string | boolean> = {}, existing?: string) {
  const root = existing ?? (await tempDir())
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const dataDir = join(root, 'data')
  await mkdir(join(home, '.codex'), { recursive: true })
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const inbox = fakeInbox()
  await inbox.writeRegistry(dataDir)
  const opened: string[] = []
  /** What "Open Inbox" does besides being recorded: nothing, unless a test says. */
  const onOpen: { run: ((dir: string) => Promise<void>) | null; answer: { ok: boolean; message: string } } = { run: null, answer: { ok: true, message: 'The Inbox is open.' } }
  const updaterRuns: string[][] = []
  const updater: { next: UpdaterResult | null } = { next: null }
  const runtime: Partial<Runtime> = {
    env: { PATH: '/nowhere' },
    home,
    sharedDir: shared,
    wrapperSource: fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url)),
    preview: false,
    engine: { exec: orca.exec, fetch: inbox.fetch, locateCli: () => ['orca'], tickMs: 30 },
    connect: { find: () => null },
    openInbox: async (dir) => {
      opened.push(dir)
      await onOpen.run?.(dir)
      return onOpen.answer
    },
    builds: {
      runUpdater: async (args) => {
        updaterRuns.push(args)
        return updater.next ?? { ok: true, detail: 'Nothing to do.', latest: null }
      }
    }
  }
  const host = mockHost({ capabilities: CAPABILITIES, settings: { enabled: true, notifyBlocked: true, dataDir, orcaCliPath: '', ...settings } })
  const worker = await mountWorker({ default: (api) => start(api, runtime), deactivate }, { host, commands: ['inbox.open', 'inbox.status', 'agents.connect', 'agents.disconnect', 'inbox.restartOnBuild', 'build.check'] })
  return { root, home, shared, dataDir, orca, inbox, host, worker, opened, onOpen, updaterRuns, updater }
}

test('on start it installs the launcher, and a registered chat gets its reply', async () => {
  const t = await machine()
  try {
    const launcher = await readFile(launcherPath(t.shared), 'utf8')
    if (process.platform === 'win32') {
      assert.ok(launcher.includes(`set ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${join(t.shared, 'inbox-mcp.mjs')}" %*`), launcher)
    } else {
      assert.match(launcher, /^#!\/bin\/sh\n/)
      assert.ok(launcher.includes(`ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${join(t.shared, 'inbox-mcp.mjs')}' "$@"`))
    }
    assert.match(await readFile(join(t.shared, 'inbox-mcp.mjs'), 'utf8'), /plannotator/)

    await writeFile(join(t.shared, 'sessions', `${SESSION}.json`), JSON.stringify({ v: 1, session: SESSION, raw: SESSION, dataDir: t.dataDir, at: Date.now() }))
    t.inbox.state.queue.set(SESSION, [reply('msg_1')])
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement')

    const status = await t.worker.request('status.get', { fresh: true })
    assert.equal(status.phase, 'ready')
    assert.equal(status.counts.delivered, 1)
    assert.deepEqual(status.agents.map((agent) => [agent.agent, agent.state]), [['claude', 'missing'], ['codex', 'absent'], ['opencode', 'missing']])
    assert.ok(t.worker.posts.some((post) => post.event === 'status.changed'))
    assert.ok(t.host.callsOf('statusBar.update').length >= 1)
    assert.match(String(await t.worker.command('inbox.status')), /Plannotator Inbox: Ready/)
    assert.deepEqual(t.worker.refusals, [])
  } finally {
    await t.worker.deactivate()
  }
})

test('connecting agents happens only when asked, and shows in the status', async () => {
  const t = await machine()
  try {
    await assert.rejects(readFile(join(t.home, '.codex', 'config.toml'), 'utf8'), 'nothing is written on start')
    const result = await t.worker.request('agents.connect', {})
    assert.equal(result.ok, true)
    assert.ok((await readFile(join(t.home, '.codex', 'config.toml'), 'utf8')).includes(JSON.stringify(launcherPath(t.shared))))
    const status = await t.worker.request('status.get', {})
    assert.equal(status.agents.find((agent) => agent.agent === 'codex')?.state, 'connected')
    assert.equal(String(await t.worker.command('agents.disconnect')), 'Disconnected Codex.')
  } finally {
    await t.worker.deactivate()
  }
})

test('with the Orca build’s agent route, every agent found is listed and connected through it', async () => {
  const t = await machine()
  try {
    t.inbox.state.features = ['agents']
    t.inbox.state.orcaAgents = [
      { id: 'codex', label: 'Codex', detected: true, state: 'absent', reason: null, path: null },
      { id: 'gemini', label: 'Gemini CLI', detected: true, state: 'absent', reason: null, path: null },
      { id: 'amp', label: 'Amp', detected: false, state: 'absent', reason: null, path: null }
    ]
    const before = await t.worker.request('status.get', { fresh: true })
    assert.deepEqual(before.agents.map((agent) => [agent.agent, agent.state]), [['claude', 'missing'], ['codex', 'absent'], ['opencode', 'missing'], ['gemini', 'absent']])

    const result = await t.worker.request('agents.connect', {})
    assert.deepEqual(result, { ok: true, message: 'Connected Codex and Gemini CLI. It applies to chats started from now on.' })
    const after = await t.worker.request('status.get', {})
    assert.equal(after.agents.find((agent) => agent.agent === 'gemini')?.state, 'connected')
    assert.match(String(await t.worker.command('inbox.status')), /Gemini CLI: Connected through this plugin’s launcher\./)

    // The Inbox stops: the list stays as it was last read.
    t.inbox.state.up = false
    const stale = await t.worker.request('status.get', { fresh: true })
    assert.equal(stale.agents.find((agent) => agent.agent === 'gemini')?.state, 'connected')
    assert.equal(String(await t.worker.command('agents.disconnect')), 'Disconnected Codex. Other agents are left as they are while the Inbox is not running.')
    assert.ok(t.inbox.state.agentCalls.filter((call) => call.method === 'POST').length === 1)
  } finally {
    await t.worker.deactivate()
  }
})

test('opening the Inbox uses the configured data folder', async () => {
  const t = await machine()
  try {
    assert.deepEqual(await t.worker.request('inbox.open'), { ok: true, message: 'The Inbox is open.' })
    assert.deepEqual(t.opened, [t.dataDir])
    assert.equal(await t.worker.command('inbox.open'), 'The Inbox is open.')
  } finally {
    await t.worker.deactivate()
  }
})

test('whether Plannotator has the Inbox on is read by its own rule, never written', async () => {
  const dir = await tempDir()
  const mark = join(dir, 'inbox', 'turned-on')
  assert.equal(await inboxTurnedOn(dir), false, 'never ran here: off')
  await mkdir(join(dir, 'inbox'))
  await writeFile(join(dir, 'inbox', 'inbox.json'), '{}')
  assert.equal(await inboxTurnedOn(dir), true, 'an Inbox ran here before the mark: on')
  await writeFile(mark, '{"on":false}')
  assert.equal(await inboxTurnedOn(dir), false, 'the mark says off')
  await writeFile(mark, '{"on":true,"by":"command","at":"2026-11-20T00:00:00.000Z"}\n')
  await rm(join(dir, 'inbox', 'inbox.json'))
  assert.equal(await inboxTurnedOn(dir), true, 'the mark says on')
  await writeFile(mark, 'not json')
  assert.equal(await inboxTurnedOn(dir), true, 'a mark that cannot be read keeps it on')
  assert.equal(await readFile(mark, 'utf8'), 'not json', 'nothing is written')
})

test('Connect turns on an Inbox Plannotator has off, through Plannotator’s own command; Disconnect never does', async () => {
  const t = await machine()
  try {
    // Plannotator never ran here: no mark, no inbox.json. Its own `inbox --open` (Open Inbox) writes both.
    await rm(join(t.dataDir, 'inbox', 'inbox.json'))
    t.onOpen.run = async (dir) => {
      await writeFile(join(dir, 'inbox', 'turned-on'), '{"on":true,"by":"command"}\n')
      await t.inbox.writeRegistry(dir)
    }
    await t.worker.request('agents.disconnect', {})
    assert.deepEqual(t.opened, [], 'Disconnect does not turn the Inbox on')

    const result = await t.worker.request('agents.connect', {})
    assert.deepEqual(t.opened, [t.dataDir])
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /^The Inbox was off on this computer, so Plannotator turned it on\. The Inbox is open\. Connected Codex\./)
    assert.doesNotMatch(result.message, /once the Inbox runs/, 'the other agents were connected through the Inbox it started')

    // On now: Connect again opens nothing.
    assert.equal((await t.worker.request('agents.connect', {})).ok, true)
    assert.deepEqual(t.opened, [t.dataDir])
  } finally {
    await t.worker.deactivate()
  }
})

test('when Plannotator cannot turn the Inbox on, Connect still connects and says why', async () => {
  const t = await machine()
  try {
    await rm(join(t.dataDir, 'inbox', 'inbox.json'))
    t.onOpen.answer = { ok: false, message: 'Plannotator was not found. Install it from https://plannotator.ai, then run `plannotator inbox` once.' }
    const result = await t.worker.request('agents.connect', {})
    assert.equal(result.ok, false)
    assert.match(result.message, /^The Inbox is off on this computer and was not turned on: Plannotator was not found\./)
    assert.ok((await readFile(join(t.home, '.codex', 'config.toml'), 'utf8')).includes(JSON.stringify(launcherPath(t.shared))), 'Codex is connected all the same')
  } finally {
    await t.worker.deactivate()
  }
})

test('a blocked reply notifies once and can be sent again from the panel', async () => {
  const t = await machine()
  try {
    await writeFile(join(t.shared, 'sessions', `${SESSION}.json`), JSON.stringify({ v: 1, session: SESSION, raw: SESSION, dataDir: t.dataDir, at: Date.now() }))
    await t.worker.request('status.get', { fresh: true })
    t.orca.state.sendFault = 'dropped'
    t.inbox.state.queue.set(SESSION, [reply('msg_1')])
    await until(async () => (await t.worker.request('status.get', {})).blocked.length === 1, 'the blocked reply')
    await until(() => t.host.callsOf('notifications.show').length === 1, 'the notification')
    const [blocked] = (await t.worker.request('status.get', {})).blocked
    assert.equal(blocked!.subject, 'Ship it?')

    t.orca.state.sendFault = null
    assert.deepEqual(await t.worker.request('delivery.retry', { key: blocked!.key }), { ok: true, message: 'Sending it again.' })
    await until(() => t.inbox.state.acknowledged.length === 1, 'the acknowledgement', 30_000)
    assert.equal(t.host.callsOf('notifications.show').length, 1)
    assert.equal((await t.worker.request('delivery.retry', { key: blocked!.key })).ok, false)
  } finally {
    await t.worker.deactivate()
  }
})

test('"Open in Orca" links listen while the setting is on, and stop with the worker', async () => {
  const on = await machine()
  try {
    const record = JSON.parse(await readFile(join(on.shared, 'navigation.json'), 'utf8')) as Record<string, unknown>
    assert.equal(record.v, 1)
    assert.ok(Number.isInteger(record.port) && (record.port as number) > 0)
    assert.match(await readFile(join(on.shared, 'link-key'), 'utf8'), /^[0-9a-f]{64}\n$/)
    const page = await fetch(`http://127.0.0.1:${String(record.port)}/open/not-a-token`)
    assert.ok(page.status >= 400, 'an unsigned link opens nothing')
    await page.arrayBuffer()
  } finally {
    await on.worker.deactivate()
  }
  await assert.rejects(stat(join(on.shared, 'navigation.json')), 'the record goes when the listener stops')

  const off = await machine({ links: false })
  try {
    await assert.rejects(stat(join(off.shared, 'navigation.json')), 'no listener, so the launcher adds no link')
  } finally {
    await off.worker.deactivate()
  }
})

test('the project list setting is read one folder per line and limits the chats served', async () => {
  assert.deepEqual(readProjects(' ~/code/a \n/work/b, /work/c\n\n~', '/home/me'), [join('/home/me', 'code/a'), '/work/b', '/work/c', '/home/me'])
  assert.deepEqual(readProjects('', '/home/me'), [])
  assert.deepEqual(readProjects(undefined, '/home/me'), [])

  const root = await realpath(await tempDir())
  const t = await machine({ projects: `${join(root, 'chosen')}\n` })
  try {
    const status = await t.worker.request('status.get', { fresh: true })
    assert.deepEqual(status.projects, [join(root, 'chosen')])
    assert.match(String(await t.worker.command('inbox.status')), /Only these projects: /)
    const heartbeat = JSON.parse(await readFile(join(t.shared, 'state.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(heartbeat.projects, [join(root, 'chosen')])
  } finally {
    await t.worker.deactivate()
  }
})

test('under the test kit the real worker touches nothing and shows what a scenario stored', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, storage: { 'preview.status': { phase: 'ready', headline: 'Ready', detail: null } } })
  const worker = await mountWorker(main, { host, commands: ['inbox.open', 'inbox.status', 'agents.connect', 'agents.disconnect', 'inbox.restartOnBuild', 'build.check'] })
  const status = await worker.request('status.get', {})
  assert.equal(status.phase, 'ready')
  assert.deepEqual(status.sessions, [])
  assert.equal((await worker.request('agents.connect', {})).ok, false)
  assert.equal(host.callsOf('statusBar.update').length, 0)
  await worker.deactivate()
})

test('the Orca build: the updater is installed, runs once at start, and its state shows in the status', async () => {
  const t = await machine()
  try {
    await stat(join(t.shared, updaterLauncherName(process.platform)))
    await stat(join(t.shared, 'plannotator-update.mjs'))
    await until(() => t.updaterRuns.length >= 1, 'the first look for an Orca build')
    assert.deepEqual(t.updaterRuns[0], [])

    const status = await t.worker.request('status.get', { fresh: true })
    assert.equal(status.build?.mode, 'stock', 'no build is installed, so agents use the Plannotator on this computer')
    assert.equal(status.server, 'stock', 'the running Inbox does not answer as an Orca build')
    assert.match(String(await t.worker.command('inbox.status')), /Standard Plannotator \(no Orca build installed\)/)

    // The wait between looks (6 hours) holds: more status looks do not run the updater again.
    await t.worker.request('status.get', { fresh: true })
    assert.equal(t.updaterRuns.length, 1)

    // "Check for a new build" skips the wait, and a failure is shown, not hidden.
    t.updater.next = { ok: false, detail: 'The list of Orca builds could not be read.' }
    const checked = await t.worker.request('build.check')
    assert.deepEqual(checked, { ok: false, message: 'The list of Orca builds could not be read.' })
    assert.equal(t.updaterRuns.length, 2)
    assert.equal((await t.worker.request('status.get', { fresh: true })).build?.lastError, 'The list of Orca builds could not be read.')

    // A newer Plannotator with no Orca build yet: "Check" answers with the wait, not a failure.
    const waitingFile = join(t.shared, 'plannotator', 'waiting.json')
    await mkdir(join(waitingFile, '..'), { recursive: true, mode: 0o700 })
    await writeFile(waitingFile, JSON.stringify({ v: 1, version: '0.28.67', since: Date.now(), checkedAt: Date.now() }), { mode: 0o600 })
    await chmod(waitingFile, 0o600)
    t.updater.next = { ok: true, installed: false, waiting: { version: '0.28.67' }, detail: 'Plannotator 0.28.67 is out.' }
    const waited = 'Plannotator 0.28.67 is in use. Its Orca build is not published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are missing until it is; the Inbox moves to it by itself.'
    assert.deepEqual(await t.worker.request('build.check'), { ok: true, message: waited })
    assert.deepEqual(t.updaterRuns.at(-1), ['--again'], 'it follows the Plannotator installed here and names no release; a person asked, so nothing is left for later')
    const waiting = (await t.worker.request('status.get', { fresh: true })).build
    assert.deepEqual([waiting?.waiting?.version, waiting?.lastError], ['0.28.67', null])
    assert.ok(String(await t.worker.command('inbox.status')).includes(waited))

    t.updater.next = { ok: true, detail: 'The Inbox now runs the Orca build.' }
    assert.deepEqual(await t.worker.request('inbox.restartOnBuild'), { ok: true, message: 'The Inbox now runs the Orca build.' })
    assert.deepEqual(t.updaterRuns.at(-1), ['--restart'])
    assert.deepEqual(t.worker.refusals, [])
  } finally {
    await t.worker.deactivate()
  }
})

test('with the Orca build switched off, nothing is downloaded and the status says nothing about it', async () => {
  const t = await machine({ orcaBuild: false })
  try {
    const status = await t.worker.request('status.get', { fresh: true })
    assert.equal(status.build, undefined)
    assert.equal(status.server, undefined)
    assert.equal((await t.worker.request('build.check')).ok, false)
    assert.deepEqual(t.updaterRuns, [])
  } finally {
    await t.worker.deactivate()
  }
})

test('the bridge: config.json names this Inbox, the launcher and the update command; switching the Orca build off removes it', async () => {
  const t = await machine()
  try {
    const file = join(t.shared, 'bridge', 'config.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(config.v, 1)
    assert.equal(config.canonicalDataDir, t.dataDir)
    assert.deepEqual(config.dataDirs, [t.dataDir])
    assert.equal(config.stateDir, join(t.shared, 'bridge'))
    assert.deepEqual(config.mcpCommand, [launcherPath(t.shared)])
    assert.equal(config.upgradeCommand.at(-1), join(t.shared, updaterLauncherName(process.platform)))
    assert.equal(config.upgradeStateFile, join(t.shared, 'bridge', 'upgrade-state.json'))
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)

    const record = JSON.parse(await readFile(join(t.shared, 'bridge', 'navigation.json'), 'utf8'))
    assert.equal(record.version, 1)
    assert.equal(record.pid, process.pid)
    const key = await readFile(join(t.shared, 'bridge', 'link-key'))
    assert.equal(key.length, 32)
    const health = await fetch(`http://127.0.0.1:${record.port}/api/health`, { headers: { authorization: `Bearer ${key.toString('hex')}` } })
    assert.equal(health.status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${record.port}/api/health`)).status, 401)


    // Stopping with Orca leaves config.json (the launcher looks at the worker's heartbeat instead);
    // the listener's record goes.
    await t.worker.deactivate()
    await stat(file)
    await assert.rejects(stat(join(t.shared, 'bridge', 'navigation.json')))

    // The same computer with the Orca build switched off: no config file, so nothing starts Plannotator in Orca mode.
    const off = await machine({ orcaBuild: false }, t.root)
    try {
      await assert.rejects(stat(file))
      await assert.rejects(stat(join(t.shared, 'bridge', 'navigation.json')))
    } finally {
      await off.worker.deactivate()
    }
  } finally {
    await t.worker.deactivate().catch(() => undefined)
  }
})
