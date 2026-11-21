// What the worker sees of the Orca build of Plannotator: its record, status, when the updater runs,
// and which Plannotator "Open Inbox" starts.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BuildStore, CHECK_EVERY_MS, FEATURE_WORDS, PLAIN_RESTART_WAIT_MS, WAITING_CHECK_MS, installUpdater, readCurrentBuild, reducedOf, storePaths, type UpdaterResult } from '../src/build-store'
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
  assert.deepEqual(await store.status(), { mode: 'stock', version: null, build: null, latestKnown: null, lastError: null, updating: false, phase: null, detail: null, waiting: null, reduced: null, moving: false })
  await b.install()
  assert.deepEqual(await readCurrentBuild(b.shared), { v: 1, version: '0.28.66', build: 'orca.1', path: b.binary, sha256: 'e'.repeat(64), size: (await stat(b.binary)).size, installedAt: 5 })
  const status = await store.status()
  assert.deepEqual([status.mode, status.version, status.build], ['orca-build', '0.28.66', 'orca.1'])

  // An updater before 0.3.0 wrote a release with no Orca build yet as a failure: it is a wait.
  const at = Date.now() / 1000
  await privateJson(storePaths(b.shared).state, { phase: 'failed', version: '0.28.67', at, detail: 'No Orca build of Plannotator 0.28.67 has been published yet, so the Orca build of Plannotator 0.28.66 stays in use.' })
  const older = await store.status()
  assert.equal(older.lastError, null)
  assert.deepEqual(older.waiting, { version: '0.28.67', since: at * 1000 })
  // The Inbox's own Update button ran the updater, and it failed.
  await privateJson(storePaths(b.shared).state, { phase: 'failed', version: '0.28.67', at, detail: 'The download does not match the checksum the release lists, so it was not used. The Orca build of Plannotator 0.28.66 stays in use.' })
  assert.match((await store.status()).lastError ?? '', /does not match the checksum/)
  assert.equal((await store.status()).waiting, null)
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
  assert.deepEqual(runs[3], ['--again'], 'and a build left alone after a failure is tried again')
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

test('while a release has no Orca build yet, or the build in use is reduced, the updater looks every 15 minutes', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const b = await box()
  await b.install()
  let now = 1_000_000_000_000
  const runs: string[][] = []
  let answer: UpdaterResult = { ok: true, installed: false, detail: 'already the newest' }
  const store = new BuildStore({ sharedDir: b.shared, env: {}, home: b.root, now: () => now, runUpdater: async (args) => (runs.push(args), answer) })
  await store.ensure()
  assert.deepEqual(runs, [[]])
  const waiting = { v: 1, version: '0.28.67', since: now, checkedAt: now }
  await privateJson(join(storePaths(b.shared).store, 'waiting.json'), waiting)
  await privateJson(storePaths(b.shared).state, { phase: 'ready', version: '0.28.66', at: now / 1000, detail: 'Plannotator 0.28.67 is out. Its Orca build is not published yet; the Orca build of Plannotator 0.28.66 stays in use and updates by itself when it is.' })
  const status = await store.status()
  assert.deepEqual([status.waiting, status.lastError, status.mode], [{ version: '0.28.67', since: now }, null, 'orca-build'])
  now += WAITING_CHECK_MS - 1
  await store.ensure()
  assert.equal(runs.length, 1, 'not yet')
  now += 1
  await store.ensure()
  assert.deepEqual(runs[1], [], 'it follows the Plannotator installed here and names no release')
  now += WAITING_CHECK_MS
  await store.ensure()
  assert.equal(runs.length, 3)

  // A real failure while waiting: back to the 6-hour wait, doubled.
  answer = { ok: false, version: '0.28.67', detail: 'The download does not match the checksum the release lists, so it was not used. The Orca build of Plannotator 0.28.66 stays in use.' }
  now += WAITING_CHECK_MS
  assert.match((await store.ensure()).lastError ?? '', /checksum/)
  assert.equal(runs.length, 4)
  now += WAITING_CHECK_MS
  await store.ensure()
  assert.equal(runs.length, 4, 'a failure is not retried every 15 minutes')
  now += 2 * CHECK_EVERY_MS
  answer = { ok: true, installed: false, waiting: { version: '0.28.67' }, detail: 'waiting' }
  await store.ensure()
  assert.equal(runs.length, 5)
  now += WAITING_CHECK_MS
  await store.ensure()
  assert.equal(runs.length, 6, 'a good run brings the 15 minutes back')

  // A waited-for release older than the build in use (left behind) is no wait.
  await privateJson(join(storePaths(b.shared).store, 'waiting.json'), { ...waiting, version: '0.28.60' })
  assert.equal((await store.status()).waiting, null)
  now += WAITING_CHECK_MS
  await store.ensure()
  assert.equal(runs.length, 6, 'no wait and a full build: 6 hours')

  // A reduced build in use: 15 minutes, for the newest build (a full one of the same version).
  const record = JSON.parse(await readFile(storePaths(b.shared).current, 'utf8'))
  await privateJson(storePaths(b.shared).current, { ...record, features: ['agents', 'update-state', 'update-detail'], omitted: ['mark-faces', 'launch-hosts'] })
  const reduced = await store.status()
  assert.deepEqual(reduced.reduced, { lacks: ['per-agent icons', 'starting and stopping chats from the Inbox'], omitted: ['mark-faces', 'launch-hosts'] })
  await store.ensure()
  assert.deepEqual(runs[6], [])
})

test('a reduced build is told by what its manifest leaves out', () => {
  assert.equal(reducedOf(null), null)
  assert.equal(reducedOf({}), null, 'a manifest without the lists is a full build')
  assert.equal(reducedOf({ features: ['agents'], omitted: [] }), null)
  assert.deepEqual(reducedOf({ features: ['mark-faces', 'launch-hosts', 'agents'], omitted: ['update-state', 'update-detail'] }), { lacks: ['update progress in the Inbox'], omitted: ['update-state', 'update-detail'] })
  assert.deepEqual(reducedOf({ omitted: ['something-new'] }), { lacks: [], omitted: ['something-new'] }, 'no feature list: what is omitted, as named')
  assert.deepEqual(Object.keys(FEATURE_WORDS).sort(), ['agents', 'launch-hosts', 'mark-faces', 'update-detail', 'update-state'])
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

test('a Plannotator that changed is followed at once; the first look only notes it', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const b = await box()
  await b.install()
  let now = 1_000_000_000_000
  const runs: string[][] = []
  const stock = join(b.root, 'bin', 'plannotator')
  await mkdir(join(stock, '..'), { recursive: true })
  await writeFile(stock, '#!/bin/sh\necho plannotator 0.28.66\n', { mode: 0o755 })
  /** Run once, while the updater works. */
  let during: (() => Promise<void>) | null = null
  const store = new BuildStore({
    sharedDir: b.shared,
    env: { PATH: join(b.root, 'bin') },
    home: b.root,
    now: () => now,
    runUpdater: async (args) => {
      runs.push(args)
      await during?.()
      during = null
      return { ok: true, installed: false, detail: 'already the newest' }
    }
  })
  await store.ensure()
  assert.equal(runs.length, 1)
  now += 60_000
  await store.ensure()
  assert.equal(runs.length, 1, 'nothing changed: the 6 hours hold')

  // Plannotator updated itself (or a person did): the next look follows it, once.
  await writeFile(stock, '#!/bin/sh\necho plannotator 0.28.67\n# a longer file\n', { mode: 0o755 })
  now += 60_000
  await store.ensure()
  assert.deepEqual(runs, [[], []], 'followed at once, naming no release')
  now += 60_000
  await store.ensure()
  assert.equal(runs.length, 2)

  // Plannotator changes again while a run works: that run followed the older one, so the next look runs again.
  during = () => writeFile(stock, '#!/bin/sh\necho plannotator 0.28.68\n# a longer file still\n', { mode: 0o755 })
  await store.ensure({ force: true })
  assert.equal(runs.length, 3)
  now += 60_000
  await store.ensure()
  assert.equal(runs.length, 4, 'the change made during the run is followed')
  now += 60_000
  await store.ensure()
  assert.equal(runs.length, 4)

  // A check file from before this was noted: the first look writes it down and starts nothing.
  const check = JSON.parse(await readFile(storePaths(b.shared).check, 'utf8'))
  assert.match(check.stock, /bin\/plannotator:\d+:\d+$/)
  await privateJson(storePaths(b.shared).check, { ...check, stock: undefined })
  now += 60_000
  await store.ensure()
  assert.equal(runs.length, 4)
  assert.equal(JSON.parse(await readFile(storePaths(b.shared).check, 'utf8')).stock, check.stock)
})

test('the real updater runs from the shared folder and its outcome is kept', async () => {
  const b = await box()
  await installUpdater(b.shared, { pluginVersion: '0.2.0' })
  // A release server that is not there: the updater fails in one sentence and nothing changes.
  // No Plannotator on this PATH or in this home (the updater reads HOME itself): it must never find the one installed on the computer running the test.
  const store = new BuildStore({ sharedDir: b.shared, env: { ...process.env, PATH: join(b.root, 'nowhere'), HOME: b.root, USERPROFILE: b.root, LOCALAPPDATA: undefined, PLANNOTATOR_BIN: undefined, ORCA_PLANNOTATOR_RELEASES: 'http://127.0.0.1:9/none', ELECTRON_RUN_AS_NODE: undefined }, home: b.root })
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

// --- A standard Inbox while the build is in use (after a login) -----------------------------------

const MOVE = ['--restart', '--if-plain']
const MOVED = 'The Inbox started on standard Plannotator 0.28.66 (pid 7); restarted it on the Orca build 0.28.66 (orca.1).'

/**
 * Everything the move of a standard Inbox needs: the build in use, Orca's bridge config, a worker that
 * delivers for the data folder, and a running Inbox that answers as `inbox.mode` with `inbox.session`.
 */
async function plainBox() {
  const b = await box()
  let now = 1_000_000_000_000
  const inbox: { mode: 'stock' | 'orca' | 'stopped'; session: string } = { mode: 'stock', session: 'boot-1' }
  const runs: string[][] = []
  const logs: string[] = []
  const updater: { answer: UpdaterResult; during: (() => Promise<void>) | null } = { answer: { ok: true, restarted: true, detail: MOVED }, during: null }
  const stock = join(b.root, 'bin', 'plannotator')
  await mkdir(join(stock, '..'), { recursive: true })
  await writeFile(stock, '#!/bin/sh\necho plannotator 0.28.66\n', { mode: 0o755 })
  await b.install()
  await privateJson(storePaths(b.shared).config, { canonicalDataDir: b.data })
  await privateJson(join(b.data, 'inbox', 'inbox.json'), { port: 4321, token: 't', version: '0.28.66' })
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (inbox.mode === 'stopped') throw new TypeError('fetch failed')
    if (path === '/api/inbox/orca') return inbox.mode === 'orca' ? new Response('{"version":1,"mode":"orca"}') : new Response('{"code":"not_found"}', { status: 404 })
    if (path === '/api/inbox/health') return new Response(JSON.stringify({ ok: true, version: '0.28.66', serverSession: inbox.session, pid: 7 }))
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const make = (): BuildStore =>
    new BuildStore({
      sharedDir: b.shared,
      env: { PATH: join(b.root, 'bin') },
      home: b.root,
      now: () => now,
      fetch: fetchImpl,
      log: (message) => void logs.push(message),
      runUpdater: async (args) => {
        runs.push(args)
        await updater.during?.()
        return updater.answer
      }
    })
  /** The worker's heartbeat, fresh as of now. */
  const deliver = (): Promise<void> => writeFile(storePaths(b.shared).heartbeat, JSON.stringify({ v: 1, pid: 1, at: now, dataDir: b.data, delivering: true }))
  /** A minute later, the worker delivering, one look. */
  const look = async (store: BuildStore) => {
    now += 60_000
    await deliver()
    return store.followRunning(b.data)
  }
  const moves = (): number => runs.filter((args) => args.join(' ') === MOVE.join(' ')).length
  return { ...b, inbox, runs, logs, updater, stock, make, deliver, look, moves, at: () => now, advance: (ms: number) => void (now += ms) }
}

test('a standard Inbox found while its release’s build is in use is restarted once, and a new one after the next login again', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const t = await plainBox()
  const store = t.make()
  const seen: { moving: boolean; updating: boolean }[] = []
  let started = 0
  t.updater.during = async () => void seen.push(await store.status().then(({ moving, updating }) => ({ moving, updating })))
  await t.deliver()
  const first = await store.followRunning(t.data, () => void (started += 1))
  assert.deepEqual([first.ran, first.result?.detail], [true, MOVED])
  assert.deepEqual(t.runs, [MOVE])
  assert.deepEqual([started, seen], [1, [{ moving: true, updating: false }]], 'the panel says it is moving, not updating')
  assert.equal((await store.status()).moving, false)
  assert.deepEqual(t.logs, [MOVED])

  // The same Inbox on every look after (say the move did not take): never again, not even after a routine look or a worker restart.
  for (let i = 0; i < 3; i += 1) assert.equal((await t.look(store)).ran, false)
  t.advance(CHECK_EVERY_MS)
  t.updater.answer = { ok: true, installed: false, version: '0.28.66', build: 'orca.1', detail: 'The Orca build of Plannotator 0.28.66 (orca.1) is already the newest, and it stays in use.' }
  await store.ensure()
  t.updater.answer = { ok: true, restarted: true, detail: MOVED }
  assert.equal((await t.look(store)).ran, false)
  assert.equal((await t.look(t.make())).ran, false)
  assert.equal(t.moves(), 1)

  // The next login: another start of a standard Inbox.
  t.inbox.session = 'boot-2'
  assert.equal((await t.look(store)).ran, true)
  assert.equal(t.moves(), 2)

  // Bounded: at most three a day.
  t.inbox.session = 'boot-3'
  assert.equal((await t.look(store)).ran, true)
  t.inbox.session = 'boot-4'
  assert.equal((await t.look(store)).ran, false, 'three in a day')
  t.advance(24 * 60 * 60 * 1000)
  assert.equal((await t.look(store)).ran, true)
  assert.equal(t.moves(), 4)

  // An answer that left the Inbox alone (the updater found it of another release) is no failure and counts as no try.
  t.updater.answer = { ok: true, restarted: false, detail: 'The Inbox was left as it is: it runs Plannotator 0.28.65, not 0.28.66, the release of the Orca build.' }
  t.inbox.session = 'boot-5'
  assert.equal((await t.look(store)).ran, true)
  assert.equal((await store.status()).lastError, null)
  assert.deepEqual(JSON.parse(await readFile(storePaths(t.shared).check, 'utf8')).plainRestart.tries.length, 1, 'only the try of the last day')
})

test('a failed automatic restart waits before trying again, and says why', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const t = await plainBox()
  const store = t.make()
  const failed = 'The Orca build of Plannotator 0.28.66 did not answer within 30 seconds, so the Inbox runs on stock Plannotator again.'
  t.updater.answer = { ok: false, detail: failed }
  assert.equal((await t.look(store)).ran, true)
  const status = await store.status()
  assert.deepEqual([status.lastError, status.mode], [failed, 'orca-build'], 'the panel shows it, with Restart')
  assert.deepEqual(t.logs, [failed])

  // The fall back to stock Plannotator started the Inbox again: another session, and still no second try for six hours.
  t.inbox.session = 'boot-2'
  assert.equal((await t.look(store)).ran, false)
  t.advance(PLAIN_RESTART_WAIT_MS - 3 * 60_000)
  assert.equal((await t.look(store)).ran, false)
  t.advance(60_000)
  assert.equal((await t.look(store)).ran, true)
  assert.equal(t.moves(), 2)

  // A Plannotator that changed ends the wait at once.
  t.inbox.session = 'boot-3'
  assert.equal((await t.look(store)).ran, false)
  await writeFile(t.stock, '#!/bin/sh\necho plannotator 0.28.66\n# reinstalled\n', { mode: 0o755 })
  assert.equal((await t.look(store)).ran, true)

  // Three tries in a day are the most, failed or not. A day later, a move that works clears the failure it showed.
  t.updater.answer = { ok: true, restarted: true, detail: MOVED }
  t.inbox.session = 'boot-4'
  t.advance(PLAIN_RESTART_WAIT_MS)
  assert.equal((await t.look(store)).ran, false)
  t.advance(24 * 60 * 60 * 1000)
  assert.equal((await t.look(store)).ran, true)
  assert.equal((await store.status()).lastError, null)
})

test('nothing is restarted while waiting for a newer release, while updating, before the worker delivers, or without a standard Inbox', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const t = await plainBox()
  const store = t.make()
  const nothing = async (why: string): Promise<void> => assert.equal((await t.look(store)).ran, false, why)

  // Waiting for a release with no Orca build yet.
  const waiting = join(storePaths(t.shared).store, 'waiting.json')
  await privateJson(waiting, { v: 1, version: '0.28.67', since: t.at(), checkedAt: t.at() })
  await nothing('waiting for a newer release')
  await rm(waiting)

  // An updater at work elsewhere (the Inbox's own Update button).
  await privateJson(storePaths(t.shared).lock, { pid: process.pid, at: t.at() + 60_000 })
  await nothing('updating')
  await rm(storePaths(t.shared).lock)

  // The worker does not deliver: an old heartbeat, or none for this Inbox.
  t.advance(60_000)
  await writeFile(storePaths(t.shared).heartbeat, JSON.stringify({ v: 1, pid: 1, at: t.at() - 10 * 60_000, dataDir: t.data, delivering: true }))
  assert.equal((await store.followRunning(t.data)).ran, false, 'before the worker delivers')
  await writeFile(storePaths(t.shared).heartbeat, JSON.stringify({ v: 1, pid: 1, at: t.at(), dataDir: t.data, delivering: false }))
  assert.equal((await store.followRunning(t.data)).ran, false, 'not delivering')

  // No bridge config, so Plannotator's Orca mode cannot be set up.
  const config = await readFile(storePaths(t.shared).config, 'utf8')
  await rm(storePaths(t.shared).config)
  await nothing('no bridge config')
  await privateJson(storePaths(t.shared).config, JSON.parse(config))

  // The Inbox is on the build, or not running.
  t.inbox.mode = 'orca'
  await nothing('already on the build')
  t.inbox.mode = 'stopped'
  await nothing('stopped')
  t.inbox.mode = 'stock'

  // No build in use.
  const current = await readFile(storePaths(t.shared).current, 'utf8')
  await rm(storePaths(t.shared).current)
  await nothing('no build')
  await privateJson(storePaths(t.shared).current, JSON.parse(current))
  assert.deepEqual(t.runs, [])

  // With all of it in place, it is.
  assert.equal((await t.look(store)).ran, true)
})

test('a restart a person asked for that fails holds the worker’s own move back, and shows why', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const t = await plainBox()
  const store = t.make()
  const failed =
    'The Orca build of Plannotator 0.28.66 (orca.1) is already the newest, and it stays in use. The Inbox was running standard Plannotator. The Orca build of Plannotator 0.28.66 did not answer within 30 seconds, so the Inbox runs on stock Plannotator again.'
  t.updater.answer = { ok: true, installed: false, restarted: false, restartFailed: true, version: '0.28.66', build: 'orca.1', detail: failed }
  await t.deliver()
  const checked = await store.ensure({ force: true })
  assert.deepEqual(t.runs, [['--again']], 'Check now acts at once')
  assert.equal(checked.lastError, failed, 'the panel shows it, with Restart')
  assert.ok(t.logs.includes(`Orca build of Plannotator: ${failed}`))

  // The fall back to stock Plannotator started the Inbox again: the worker does not restart it again at once.
  t.inbox.session = 'boot-2'
  assert.equal((await t.look(store)).ran, false)
  t.advance(PLAIN_RESTART_WAIT_MS)
  t.updater.answer = { ok: true, restarted: true, detail: MOVED }
  assert.equal((await t.look(store)).ran, true, 'after the wait')
  assert.equal((await store.status()).lastError, null)
})

test('restarts a person asked for count toward the three a day of the worker’s own moves', { skip: POSIX ? false : 'POSIX file modes' }, async () => {
  const t = await plainBox()
  const store = t.make()
  await t.deliver()
  // Check now, twice, moved a standard Inbox; then Restart did.
  t.updater.answer = { ok: true, installed: false, restarted: true, version: '0.28.66', build: 'orca.1', detail: 'The Orca build of Plannotator 0.28.66 (orca.1) is already the newest. The Inbox was running standard Plannotator and was restarted on it.' }
  await store.ensure({ force: true })
  t.advance(60_000)
  await store.ensure({ force: true })
  t.updater.answer = { ok: true, restarted: true, version: '0.28.66', build: 'orca.1', detail: 'The Inbox runs on the Orca build of Plannotator 0.28.66.' }
  assert.equal((await store.restartInbox()).ok, true, 'a person’s Restart is never held back')
  assert.deepEqual(t.runs, [['--again'], ['--again'], ['--restart']])

  // Three in a day: the next standard Inbox waits for tomorrow.
  t.updater.answer = { ok: true, restarted: true, detail: MOVED }
  t.inbox.session = 'boot-2'
  assert.equal((await t.look(store)).ran, false)
  t.advance(24 * 60 * 60 * 1000)
  assert.equal((await t.look(store)).ran, true)

  // A routine look that moved nothing (or a new build installed and restarted on) is no such try.
  t.updater.answer = { ok: true, installed: true, restarted: true, version: '0.28.66', build: 'orca.2', detail: 'The Orca build of Plannotator 0.28.66 (orca.2) is in use, and the Inbox was restarted on it.' }
  t.advance(CHECK_EVERY_MS)
  await store.ensure()
  assert.equal(JSON.parse(await readFile(storePaths(t.shared).check, 'utf8')).plainRestart.tries.length, 1)
})
