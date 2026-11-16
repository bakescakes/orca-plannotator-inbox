// The worker as Orca runs it: `activate(orca)` over the test kit's host, with the machine replaced.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mockHost, mountWorker } from 'orca/testing'
import * as main from '../src/worker'
import { deactivate, start, type Runtime } from '../src/worker'
import { launcherPath } from '../src/shared'
import { fakeInbox, fakeOrca, reply, tempDir, until } from './fakes'

const SESSION = 'claude_1b491d4a_6f38'
const CAPABILITIES = ['storage:own', 'settings:own', 'notifications:show']

async function machine(settings: Record<string, string | boolean> = {}) {
  const root = await tempDir()
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const dataDir = join(root, 'data')
  await mkdir(join(home, '.codex'), { recursive: true })
  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const inbox = fakeInbox()
  await inbox.writeRegistry(dataDir)
  const opened: string[] = []
  const runtime: Partial<Runtime> = {
    env: { PATH: '/nowhere' },
    home,
    sharedDir: shared,
    wrapperSource: fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url)),
    preview: false,
    engine: { exec: orca.exec, fetch: inbox.fetch, locateCli: () => ['orca'], tickMs: 30, legacyConfig: null },
    connect: { find: () => null },
    openInbox: async (dir) => {
      opened.push(dir)
      return { ok: true, message: 'The Inbox is open.' }
    }
  }
  const host = mockHost({ capabilities: CAPABILITIES, settings: { enabled: true, notifyBlocked: true, dataDir, orcaCliPath: '', ...settings } })
  const worker = await mountWorker({ default: (api) => start(api, runtime), deactivate }, { host, commands: ['inbox.open', 'inbox.status', 'agents.connect', 'agents.disconnect'] })
  return { root, home, shared, dataDir, orca, inbox, host, worker, opened }
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
    assert.deepEqual(status.agents.map((agent) => [agent.agent, agent.state]), [['claude', 'missing'], ['codex', 'absent']])
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
    assert.match(String(await t.worker.command('agents.disconnect')), /Codex is disconnected/)
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

test('under the test kit the real worker touches nothing and shows what a scenario stored', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, storage: { 'preview.status': { phase: 'ready', headline: 'Ready', detail: null } } })
  const worker = await mountWorker(main, { host, commands: ['inbox.open', 'inbox.status', 'agents.connect', 'agents.disconnect'] })
  const status = await worker.request('status.get', {})
  assert.equal(status.phase, 'ready')
  assert.deepEqual(status.sessions, [])
  assert.equal((await worker.request('agents.connect', {})).ok, false)
  assert.equal(host.callsOf('statusBar.update').length, 0)
  await worker.deactivate()
})
