// What the worker sees of the Orca build of Plannotator: its record, status, when the updater runs,
// and which Plannotator "Open Inbox" starts.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BuildStore, CHECK_EVERY_MS, installUpdater, readCurrentBuild, storePaths, type UpdaterResult } from '../src/build-store'
import { upgradeCommand } from '../src/shared'
import { tempDir } from './fakes'

const POSIX = process.platform !== 'win32'
const NAME = POSIX ? 'plannotator' : 'plannotator.exe'

async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  await chmod(path, 0o600)
}

async function box() {
  const root = await realpath(await tempDir('orca-plannotator-store-'))
  const shared = join(root, 'shared')
  const data = join(root, 'data')
  await mkdir(shared, { recursive: true, mode: 0o700 })
  await mkdir(data, { recursive: true })
  const binary = join(shared, 'plannotator', 'versions', '0.28.66-orca.1', NAME)
  const install = async (): Promise<void> => {
    await mkdir(join(binary, '..'), { recursive: true, mode: 0o700 })
    await writeFile(binary, '#!/bin/sh\necho plannotator 0.28.66\n', { mode: 0o755 })
    await chmod(binary, 0o755)
    const size = (await stat(binary)).size
    await privateJson(storePaths(shared).current, { v: 1, version: '0.28.66', build: 'orca.1', path: binary, sha256: 'e'.repeat(64), size, installedAt: 5 })
  }
  return { root, shared, data, binary, install }
}

test('the updater and its launcher are installed beside the MCP launcher', async () => {
  const b = await box()
  const source = join(b.root, 'updater.mjs')
  await writeFile(source, '// updater\n')
  const command = await installUpdater(b.shared, { source, pluginVersion: '0.2.0', node: '/opt/Orca/orca' })
  assert.equal(await readFile(join(b.shared, 'plannotator-update.mjs'), 'utf8'), '// updater\n')
  assert.deepEqual(JSON.parse(await readFile(join(b.shared, 'plannotator-update.json'), 'utf8')), { v: 1, pluginVersion: '0.2.0' })
  if (POSIX) {
    assert.deepEqual(command, [join(b.shared, 'plannotator-update')])
    const script = await readFile(join(b.shared, 'plannotator-update'), 'utf8')
    assert.match(script, /^#!\/bin\/sh\n/)
    assert.ok(script.includes(`ELECTRON_RUN_AS_NODE=1 exec '/opt/Orca/orca' '${join(b.shared, 'plannotator-update.mjs')}' "$@"`))
    assert.equal((await stat(join(b.shared, 'plannotator-update'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(b.shared, 'plannotator-update.json'))).mode & 0o777, 0o600)
  }
  // Windows starts a .cmd only through cmd.exe; the Inbox starts the command without a shell.
  assert.deepEqual(upgradeCommand('C:\\Users\\a b\\.orca-plannotator-inbox', 'win32', { SystemRoot: 'C:\\Windows' }).slice(0, 3), ['C:\\Windows\\System32\\cmd.exe', '/d', '/c'])
  assert.match(upgradeCommand('C:\\Users\\a b\\.orca-plannotator-inbox', 'win32', {})[3]!, /plannotator-update\.cmd$/)
})

test('status: stock without a valid build, the build when one is recorded, and the newest failure', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const b = await box()
  const store = new BuildStore({ sharedDir: b.shared, env: {}, home: b.root })
  assert.deepEqual(await store.status(), { mode: 'stock', version: null, build: null, latestKnown: null, lastError: null, updating: false, phase: null, detail: null })
  await b.install()
  assert.deepEqual(await readCurrentBuild(b.shared), { v: 1, version: '0.28.66', build: 'orca.1', path: b.binary, sha256: 'e'.repeat(64), size: (await stat(b.binary)).size, installedAt: 5 })
  const status = await store.status()
  assert.deepEqual([status.mode, status.version, status.build], ['orca-build', '0.28.66', 'orca.1'])

  // The Inbox's own Update button ran the updater, and it failed.
  await privateJson(storePaths(b.shared).state, { phase: 'failed', version: '0.28.67', at: Date.now() / 1000, detail: 'No Orca build of Plannotator 0.28.67 has been published yet, so the Orca build of Plannotator 0.28.66 stays in use.' })
  assert.match((await store.status()).lastError ?? '', /0\.28\.67 has been published yet/)
  assert.equal((await store.status()).phase, 'failed')
  await chmod(b.binary, 0o777)
  assert.equal((await store.status()).mode, 'stock', 'a build others can change is not used')
})

test('ensure runs the updater at most every 6 hours, longer after failures, and at once when asked', async () => {
  const b = await box()
  let now = 1_000_000_000_000
  const runs: string[][] = []
  let answer: UpdaterResult = { ok: true, installed: true, version: '0.28.66', build: 'orca.1', latest: { version: '0.28.66', build: 'orca.1' }, detail: 'in use' }
  const store = new BuildStore({
    sharedDir: b.shared,
    env: {},
    home: b.root,
    now: () => now,
    runUpdater: async (args) => {
      runs.push(args)
      return answer
    }
  })
  const first = await store.ensure()
  assert.deepEqual(runs, [[]])
  assert.deepEqual(first.latestKnown, { version: '0.28.66', build: 'orca.1' })
  assert.equal(first.updating, false)
  now += CHECK_EVERY_MS - 1
  await store.ensure()
  assert.equal(runs.length, 1, 'not yet')
  now += 1
  answer = { ok: false, version: '0.28.67', detail: 'GitHub answered 503 for index.json. Stock Plannotator stays in use.' }
  const failed = await store.ensure()
  assert.equal(runs.length, 2)
  assert.match(failed.lastError ?? '', /503/)
  assert.deepEqual(failed.latestKnown, { version: '0.28.66', build: 'orca.1' }, 'kept from the last good look')
  now += CHECK_EVERY_MS
  await store.ensure()
  assert.equal(runs.length, 2, 'one failure doubles the wait')
  now += CHECK_EVERY_MS
  await store.ensure()
  assert.equal(runs.length, 3)
  await store.ensure({ force: true })
  assert.equal(runs.length, 4, 'a person asked')
  answer = { ok: true, installed: false, latest: { version: '0.28.67', build: 'orca.1' }, detail: 'already the newest' }
  now += 100 * CHECK_EVERY_MS
  const ok = await store.ensure()
  assert.equal(ok.lastError, null)
  assert.deepEqual(ok.latestKnown, { version: '0.28.67', build: 'orca.1' })
  // Two calls at once share one run.
  now += CHECK_EVERY_MS
  await Promise.all([store.ensure(), store.ensure()])
  assert.equal(runs.length, 6)
})

test('a run in progress elsewhere counts as updating and is not started again', async () => {
  const b = await box()
  await privateJson(storePaths(b.shared).lock, { pid: process.pid, at: Date.now() })
  let runs = 0
  const store = new BuildStore({ sharedDir: b.shared, env: {}, home: b.root, runUpdater: async () => ((runs += 1), { ok: true, detail: '' }) })
  assert.equal((await store.ensure({ force: true })).updating, true)
  assert.equal(runs, 0)
})

test('"updating" is an updater at work, not a look that starts none', async () => {
  const b = await box()
  const now = 10 * CHECK_EVERY_MS
  const during: boolean[] = []
  const after: Promise<boolean>[] = []
  const store: BuildStore = new BuildStore({
    sharedDir: b.shared,
    env: {},
    home: b.root,
    now: () => now,
    runUpdater: async () => {
      during.push((await store.status()).updating)
      return { ok: false, detail: 'It did not work.' }
    },
    // Called once the updater has ended, while the look is still writing down what it learned.
    log: () => void after.push(store.status().then((status) => status.updating))
  })
  await store.ensure()
  assert.deepEqual(during, [true], 'while the updater runs')
  assert.deepEqual(await Promise.all(after), [false], 'the updater has ended')
  // A look that is not due starts no updater, so nothing read meanwhile says "updating".
  const looks = [store.ensure(), store.status(), store.status()] as const
  const [, first, second] = await Promise.all(looks)
  assert.deepEqual([first.updating, second.updating], [false, false])
  // The Inbox restart is an updater run too.
  const restarting: boolean[] = []
  const restarter: BuildStore = new BuildStore({ sharedDir: b.shared, env: {}, home: b.root, runUpdater: async () => (restarting.push((await restarter.status()).updating), { ok: true, detail: 'restarted' }) })
  await restarter.restartInbox()
  assert.deepEqual(restarting, [true])
  assert.equal((await restarter.status()).updating, false)
})

test('the real updater runs from the shared folder and its outcome is kept', async () => {
  const b = await box()
  await installUpdater(b.shared, { pluginVersion: '0.2.0' })
  // A release server that is not there: the updater fails in one sentence and nothing changes.
  const store = new BuildStore({ sharedDir: b.shared, env: { ...process.env, ORCA_PLANNOTATOR_RELEASES: 'http://127.0.0.1:9/none', ELECTRON_RUN_AS_NODE: undefined }, home: b.root })
  const status = await store.ensure()
  assert.equal(status.mode, 'stock')
  assert.match(status.lastError ?? '', /could not be downloaded.*[Ss]tock Plannotator stays in use/)
  assert.equal((await store.restartInbox()).message, 'No Orca build of Plannotator is installed yet, so the Inbox stays as it is.')
})

test('Open Inbox starts the build in Orca mode only when the launcher would', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const b = await box()
  const stock = join(b.root, 'bin', 'plannotator')
  await mkdir(join(stock, '..'), { recursive: true })
  await writeFile(stock, '#!/bin/sh\n', { mode: 0o755 })
  const calls: { binary: string; args: string[]; env: Record<string, string | undefined> }[] = []
  const store = new BuildStore({
    sharedDir: b.shared,
    env: { PATH: join(b.root, 'bin'), ELECTRON_RUN_AS_NODE: '1' },
    home: b.root,
    exec: async (binary, args, env) => (calls.push({ binary, args, env }), { ok: true, stdout: 'http://localhost:4000/\n', error: null })
  })
  assert.deepEqual(await store.openInbox(b.data, false), { ok: true, message: 'The Inbox is open at http://localhost:4000/' })
  assert.equal(calls[0]!.binary, stock)
  assert.deepEqual(calls[0]!.args, ['inbox', '--open'])
  assert.equal(calls[0]!.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(calls[0]!.env.PLANNOTATOR_ORCA_MODE, undefined)

  await b.install()
  await privateJson(storePaths(b.shared).config, { canonicalDataDir: b.data })
  await writeFile(storePaths(b.shared).heartbeat, JSON.stringify({ v: 1, pid: 1, at: Date.now(), dataDir: b.data, delivering: true }))
  await store.openInbox(b.data, false)
  assert.equal(calls[1]!.binary, b.binary)
  assert.equal(calls[1]!.env.PLANNOTATOR_ORCA_MODE, '1')
  assert.equal(calls[1]!.env.PLANNOTATOR_ORCA_CONFIG, storePaths(b.shared).config)
  assert.equal(calls[1]!.env.PLANNOTATOR_DATA_DIR, b.data)

  const chosen = new BuildStore({ sharedDir: b.shared, env: { PLANNOTATOR_BIN: stock }, home: b.root, exec: async (binary) => (calls.push({ binary, args: [], env: {} }), { ok: false, stdout: '', error: 'exit 1' }) })
  assert.deepEqual(await chosen.openInbox(b.data, false), { ok: false, message: 'Plannotator could not open the Inbox (exit 1).' })
  assert.equal(calls[2]!.binary, stock, 'a PLANNOTATOR_BIN the person set wins')
})

test('the Inbox server is told apart: Orca mode, stock, or not running', async () => {
  const b = await box()
  const answers: Record<string, [number, string]> = {}
  const store = new BuildStore({
    sharedDir: b.shared,
    env: {},
    home: b.root,
    fetch: (async (input: RequestInfo | URL) => {
      const answer = answers[new URL(String(input)).pathname]
      if (!answer) throw new TypeError('fetch failed')
      return new Response(answer[1], { status: answer[0] })
    }) as typeof fetch
  })
  assert.equal(await store.serverMode(b.data), 'stopped')
  await privateJson(join(b.data, 'inbox', 'inbox.json'), { port: 4321, token: 't', version: '0.28.66' })
  assert.equal(await store.serverMode(b.data), 'stopped')
  answers['/api/inbox/health'] = [200, '{"ok":true}']
  answers['/api/inbox/orca'] = [404, '{"error":"Orca mode is off."}']
  assert.equal(await store.serverMode(b.data), 'stock')
  answers['/api/inbox/orca'] = [200, '{"version":1,"mode":"orca"}']
  assert.equal(await store.serverMode(b.data), 'orca')
})

test('restarting the Inbox reports the updater’s own sentence', async () => {
  const b = await box()
  const seen: string[][] = []
  const store = new BuildStore({ sharedDir: b.shared, env: {}, home: b.root, runUpdater: async (args) => (seen.push(args), { ok: true, detail: 'The Inbox runs on the Orca build of Plannotator 0.28.66.' }) })
  assert.deepEqual(await store.restartInbox(), { ok: true, message: 'The Inbox runs on the Orca build of Plannotator 0.28.66.' })
  assert.deepEqual(seen, [['--restart']])
})
