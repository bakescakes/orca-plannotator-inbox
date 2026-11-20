// The Orca build's updater, against a stand-in GitHub release server on 127.0.0.1 and stand-in
// Plannotator binaries, in throwaway folders. The end-to-end part at the bottom uses a real
// Plannotator binary (PLANNOTATOR_E2E_BIN) as the "Orca build".
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  LIMITS,
  compareVersions,
  lockHolder,
  parseArgs,
  pickBuild,
  readIndex,
  readManifest,
  readRecord,
  source,
  takeLock,
  update,
  restartInbox,
  validRecord,
  writePrivateJson
} from '../bin/plannotator-update.mjs'
import { ASSET, KEY, fakeBinary, installFake, readJson, releaseServer, runProgram, sha256, tempRoot } from './release-fakes.mjs'

const UPDATER = fileURLToPath(new URL('../bin/plannotator-update.mjs', import.meta.url))
const POSIX = process.platform !== 'win32'
const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'].includes(KEY)
const STAND_IN = !POSIX ? 'the stand-in Plannotator is a POSIX shell script' : !SUPPORTED ? `no Orca build for ${KEY}` : false
const BINARY = (process.env.PLANNOTATOR_E2E_BIN ?? '').trim()
const NAME = POSIX ? 'plannotator' : 'plannotator.exe'
LIMITS.healthMs = 4000

/** A shared folder with Orca's bridge config, a data folder, and an environment pointing at `server`. */
function box(server, { config = true, stock = null } = {}) {
  const root = tempRoot()
  const shared = join(root, 'shared')
  const data = join(root, 'data')
  const home = join(root, 'home')
  for (const folder of [shared, data, home]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (config) writePrivateJson(join(shared, 'bridge', 'config.json'), { canonicalDataDir: data, stateDir: shared })
  writePrivateJson(join(shared, 'plannotator-update.json'), { v: 1, pluginVersion: '0.2.0' })
  const env = {
    PATH: join(root, 'nowhere'),
    HOME: home,
    PLANNOTATOR_DATA_DIR: data,
    ORCA_PLANNOTATOR_RELEASES: server?.base ?? '',
    ...(stock ? { PLANNOTATOR_BIN: stock } : {})
  }
  const run = (options = {}) => update({ shared, env, home, pluginVersion: '0.2.0', ...options })
  const state = () => readJson(join(shared, 'bridge', 'upgrade-state.json'))
  const current = () => (existsSync(join(shared, 'plannotator', 'current.json')) ? readJson(join(shared, 'plannotator', 'current.json')) : null)
  const versions = () => readdirSync(join(shared, 'plannotator', 'versions')).sort()
  const health = async () => {
    const entry = readJson(join(data, 'inbox', 'inbox.json'))
    return (await fetch(`http://127.0.0.1:${entry.port}/api/inbox/health`, { signal: AbortSignal.timeout(3000) })).json()
  }
  return { root, shared, data, home, env, run, state, current, versions, health }
}

const stopInbox = (binary, env) => runProgram(binary, ['inbox', 'stop'], { ...env, ELECTRON_RUN_AS_NODE: '' }, 30_000)

test('versions, the index and the manifest are read strictly', () => {
  assert.ok(compareVersions('0.28.10', '0.28.9') > 0)
  assert.equal(compareVersions('0.28.66', '0.28.66'), 0)
  const index = readIndex({
    v: 1,
    latest: { plannotator: '0.28.66', build: 'orca.2', tag: 'plannotator-0.28.66-orca.2' },
    builds: [
      { plannotator: '0.28.65', build: 'orca.9', tag: 'plannotator-0.28.65-orca.9' },
      { plannotator: '0.28.66', build: 'orca.1', tag: 'plannotator-0.28.66-orca.1' },
      { plannotator: '0.28.66', build: 'orca.10', tag: 'plannotator-0.28.66-orca.10' },
      { plannotator: '0.28.67', build: 'orca.1', tag: 'wrong-tag' },
      { plannotator: '../x', build: 'orca.1', tag: 'plannotator-../x-orca.1' }
    ]
  })
  assert.deepEqual(pickBuild(index, '0.28.66'), { plannotator: '0.28.66', build: 'orca.10', tag: 'plannotator-0.28.66-orca.10' }, 'the newest build of that version')
  assert.equal(pickBuild(index, '0.28.67'), null, 'an entry whose tag does not match is not a build')
  assert.equal(pickBuild(index, null).build, 'orca.2', 'no version: the index’s own latest')
  assert.throws(() => readIndex({ v: 2 }), /update the plugin/)

  const ref = { plannotator: '0.28.66', build: 'orca.1', tag: 'plannotator-0.28.66-orca.1' }
  const good = { v: 1, plannotator: '0.28.66', build: 'orca.1', pluginMin: '0.2.0', assets: { 'linux-x64': { name: 'plannotator-orca-linux-x64', sha256: 'a'.repeat(64), size: 10 } } }
  assert.deepEqual(readManifest(good, ref, 'linux-x64').asset, { name: 'plannotator-orca-linux-x64', sha256: 'a'.repeat(64), size: 10 })
  assert.equal(readManifest(good, ref, 'darwin-arm64').asset, null, 'a missing platform')
  assert.throws(() => readManifest({ ...good, build: 'orca.2' }, ref, 'linux-x64'), /another build/)
  assert.throws(() => readManifest({ ...good, assets: { 'linux-x64': { ...good.assets['linux-x64'], name: '../evil' } } }, ref, 'linux-x64'), /shape/)
  assert.throws(() => readManifest({ ...good, assets: { 'linux-x64': { ...good.assets['linux-x64'], size: 500 * 1024 * 1024 } } }, ref, 'linux-x64'), /shape/)
  assert.throws(() => readManifest({ ...good, pluginMin: undefined }, ref, 'linux-x64'), /which plugin/)
  assert.deepEqual([readManifest(good, ref, 'linux-x64').features, readManifest(good, ref, 'linux-x64').omitted], [null, null], 'a manifest without the lists')
  const lists = readManifest({ ...good, features: ['agents', 'agents', 'update-state'], omitted: ['mark-faces'] }, ref, 'linux-x64')
  assert.deepEqual([lists.features, lists.omitted], [['agents', 'update-state'], ['mark-faces']])
  assert.equal(readManifest({ ...good, omitted: 'mark-faces' }, ref, 'linux-x64').omitted, null, 'not a list: ignored')
  assert.equal(readManifest({ ...good, omitted: ['../x'] }, ref, 'linux-x64').omitted, null, 'not plain names: ignored')
})

test('only GitHub, or a loopback test server, is a source; arguments are checked', () => {
  assert.deepEqual(source({}).hosts, ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
  assert.equal(source({}).base, 'https://github.com/bakescakes/orca-plannotator-inbox/releases/download')
  assert.equal(source({ ORCA_PLANNOTATOR_RELEASES: 'http://127.0.0.1:9/x/' }).base, 'http://127.0.0.1:9/x')
  assert.throws(() => source({ ORCA_PLANNOTATOR_RELEASES: 'https://example.com/' }), /127\.0\.0\.1/)
  assert.throws(() => source({ ORCA_PLANNOTATOR_RELEASES: 'http://localhost:9/' }), /127\.0\.0\.1/)
  assert.deepEqual(parseArgs(['--version', '0.28.66']), { version: '0.28.66', restart: false, again: false, sharedDir: null })
  assert.equal(parseArgs(['--again']).again, true)
  assert.throws(() => parseArgs(['--version', '0.28']), /--version takes/)
  assert.throws(() => parseArgs(['--version', '0.28.66', '--restart']), /does not go/)
  assert.throws(() => parseArgs(['--nope']), /Unknown option/)
})

test('a record is trusted only for a private file at its own place in the store, with its size', { skip: STAND_IN }, () => {
  const root = tempRoot()
  const shared = join(root, 'shared')
  const path = join(shared, 'plannotator', 'versions', '0.28.66-orca.1', NAME)
  installFake(path)
  const size = statSync(path).size
  const record = { v: 1, version: '0.28.66', build: 'orca.1', path, sha256: 'b'.repeat(64), size, installedAt: 1 }
  assert.ok(validRecord(record, shared))
  assert.equal(validRecord({ ...record, size: size + 1 }, shared), null, 'size')
  assert.equal(validRecord({ ...record, build: 'orca.2' }, shared), null, 'not where its build says')
  assert.equal(validRecord({ ...record, path: join(root, 'elsewhere', NAME) }, shared), null, 'outside the store')
  assert.equal(validRecord({ ...record, version: '../../x' }, shared), null)
  writePrivateJson(join(shared, 'plannotator', 'current.json'), record)
  assert.ok(readRecord(join(shared, 'plannotator', 'current.json'), shared))
  chmodSync(join(shared, 'plannotator', 'current.json'), 0o644)
  assert.equal(readRecord(join(shared, 'plannotator', 'current.json'), shared), null, 'a record others can read')
})

test('installs the newest build, checks it, records it, and keeps only the one before it', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') }])
  const b = box(server)
  try {
    server.faults.redirect.set('plannotator-0.28.66-orca.1', '/cdn/plannotator-0.28.66-orca.1/' + ASSET)
    const first = await b.run()
    assert.equal(first.ok, true, first.detail)
    assert.equal(first.installed, true)
    assert.deepEqual(first.latest, { version: '0.28.66', build: 'orca.1' })
    const record = b.current()
    assert.equal(record.path, join(b.shared, 'plannotator', 'versions', '0.28.66-orca.1', NAME))
    assert.equal(record.sha256, sha256(fakeBinary('good', '0.28.66')))
    assert.equal(statSync(join(b.shared, 'plannotator', 'current.json')).mode & 0o777, 0o600)
    assert.equal(statSync(record.path).mode & 0o777, 0o755)
    assert.equal(b.state().phase, 'ready')
    assert.equal(statSync(join(b.shared, 'bridge', 'upgrade-state.json')).mode & 0o777, 0o600)
    assert.equal(typeof b.state().at, 'number')
    assert.ok(Math.abs(b.state().at - Date.now() / 1000) < 60, 'seconds, not milliseconds')

    // The same build again: nothing downloaded.
    const again = await b.run({ version: '0.28.66' })
    assert.equal(again.installed, false)
    assert.match(again.detail, /already the newest/)
    assert.equal(server.downloads(), 2, 'one redirect and one download, from the first run only')

    server.publish({ version: '0.28.66', build: 'orca.2', bytes: fakeBinary('good', '0.28.66', 'orca.2') })
    server.publish({ version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67') })
    assert.equal((await b.run({ version: '0.28.66' })).build, 'orca.2', 'the newest build of that version')
    const newest = await b.run()
    assert.equal(newest.version, '0.28.67', newest.detail)
    assert.deepEqual(b.versions(), ['0.28.66-orca.2', '0.28.67-orca.1'], 'the build in use and the one before it')
    assert.equal(readJson(join(b.shared, 'plannotator', 'previous.json')).build, 'orca.2')
    const older = await b.run({ version: '0.28.66' })
    assert.equal(older.ok, false)
    assert.match(older.detail, /older than the 0\.28\.67 in use/)
  } finally {
    await server.close()
  }
})

test('a release with no Orca build yet is a wait, not a failure, and what runs stays', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const b = box(server)
  const waiting = () => (existsSync(join(b.shared, 'plannotator', 'waiting.json')) ? readJson(join(b.shared, 'plannotator', 'waiting.json')) : null)
  try {
    const none = await b.run({ version: '0.28.67' })
    assert.equal(none.ok, true, none.detail)
    assert.equal(none.installed, false)
    assert.deepEqual(none.waiting, { version: '0.28.67' })
    assert.equal(none.detail, 'Plannotator 0.28.67 is out. Its Orca build is not published yet; stock Plannotator stays in use until it is.')
    assert.deepEqual({ phase: b.state().phase, version: b.state().version, detail: b.state().detail }, { phase: 'ready', version: undefined, detail: none.detail }, 'not failed, and no version: the Inbox shows the release as available')
    assert.equal(waiting().version, '0.28.67')
    assert.equal(statSync(join(b.shared, 'plannotator', 'waiting.json')).mode & 0o777, 0o600)

    // The newest build that is published installs; the wait for 0.28.67 goes on, with its first time kept.
    const since = waiting().since
    assert.equal((await b.run()).installed, true)
    const after = await b.run({ version: '0.28.67' })
    assert.equal(after.ok, true)
    assert.equal(after.detail, 'Plannotator 0.28.67 is out. Its Orca build is not published yet; the Orca build of Plannotator 0.28.66 stays in use and updates by itself when it is.')
    assert.deepEqual([b.state().phase, b.state().version], ['ready', '0.28.66'])
    assert.equal(waiting().since, since)
    assert.equal(b.current().version, '0.28.66', 'what runs stays')

    // No index at all: a wait when a version is named, and still the old sentence when none is.
    server.faults.noIndex = true
    assert.equal((await b.run({ version: '0.28.67' })).ok, true)
    assert.match((await b.run()).detail, /No Orca build of Plannotator has been published yet/)
    server.faults.noIndex = false

    // Its build is published: it installs and the wait is over.
    server.publish({ version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67') })
    const done = await b.run({ version: '0.28.67' })
    assert.equal(done.installed, true, done.detail)
    assert.equal(done.version, '0.28.67')
    assert.equal(waiting(), null)
    assert.equal(b.state().phase, 'ready')
  } finally {
    await server.close()
  }
})

test('a version older than the newest build but missing from the index is still a failure', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.68', build: 'orca.1', bytes: fakeBinary('good', '0.28.68') }])
  const b = box(server)
  try {
    const missing = await b.run({ version: '0.28.67' })
    assert.equal(missing.ok, false)
    assert.equal(missing.detail, 'No Orca build of Plannotator 0.28.67 has been published yet, so stock Plannotator stays in use.')
    assert.equal(b.state().phase, 'failed')
    assert.equal(existsSync(join(b.shared, 'plannotator', 'waiting.json')), false)
  } finally {
    await server.close()
  }
})

test('a release waited for that never gets a build: the build of a later release ends the wait', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const b = box(server)
  const waitingFile = join(b.shared, 'plannotator', 'waiting.json')
  try {
    assert.equal((await b.run()).installed, true)
    assert.deepEqual((await b.run({ version: '0.28.67' })).waiting, { version: '0.28.67' })
    // 0.28.67 is skipped: only 0.28.68 gets a build. The same question, asked again, installs it.
    server.publish({ version: '0.28.68', build: 'orca.1', bytes: fakeBinary('good', '0.28.68') })
    const later = await b.run({ version: '0.28.67' })
    assert.equal(later.ok, true, later.detail)
    assert.equal(later.installed, true, later.detail)
    assert.equal(later.version, '0.28.68')
    assert.equal(b.current().version, '0.28.68')
    assert.equal(existsSync(waitingFile), false, 'the wait is over')
    assert.deepEqual([b.state().phase, b.state().version], ['ready', '0.28.68'])
  } finally {
    await server.close()
  }
})

const ORCA_MODE = (b) => ({ ...b.env, PLANNOTATOR_ORCA_MODE: '1', PLANNOTATOR_ORCA_CONFIG: join(b.shared, 'bridge', 'config.json') })
const versionOf = async (binary, env) => /\d+\.\d+\.\d+/.exec((await runProgram(binary, ['--version'], env)).stdout)?.[0]

test('the Inbox asks for a newer release: Plannotator updates itself, and the Inbox moves onto that release’s Orca build', { skip: STAND_IN }, async () => {
  const server = await releaseServer([
    { version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') },
    { version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67') }
  ])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  const seen = join(b.root, 'update-seen.json')
  Object.assign(b.env, { FAKE_UPDATE_TO: '0.28.67', FAKE_UPDATE_SEEN: seen })
  try {
    // Nothing asked: the build of the Plannotator installed here, not the newest one published.
    const first = await b.run()
    assert.equal(first.installed, true, first.detail)
    assert.equal(b.current().version, '0.28.66')
    assert.equal(existsSync(seen), false, 'Plannotator is never asked to update by a routine look')
    await runProgram(b.current().path, ['inbox', '--background'], ORCA_MODE(b))
    const before = await b.health()
    assert.equal(before.orcaMode, '1')

    const moved = await b.run({ version: '0.28.67' })
    assert.equal(moved.ok, true, moved.detail)
    assert.equal(moved.installed, true)
    assert.equal(moved.version, '0.28.67')
    assert.deepEqual(readJson(seen), { dataDir: b.data, orcaMode: null }, 'Plannotator’s own updater ran for the Inbox’s data folder, outside Orca mode')
    assert.equal(await versionOf(stock, b.env), '0.28.67')
    const after = await b.health()
    assert.equal(after.self, b.current().path, 'the Inbox runs the Orca build of the new release')
    assert.equal(after.version, '0.28.67')
    assert.equal(after.orcaMode, '1')
    assert.notEqual(after.pid, before.pid)
    assert.deepEqual([b.state().phase, b.state().version], ['ready', '0.28.67'])

    // Asked again for a release that is installed: Plannotator is not asked to update.
    rmSync(seen)
    assert.match((await b.run({ version: '0.28.67' })).detail, /already the newest/)
    assert.equal(existsSync(seen), false)
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('a release with no Orca build yet: the Inbox runs the Plannotator installed here, and moves to the build when it is published', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  Object.assign(b.env, { FAKE_UPDATE_TO: '0.28.67' })
  const waitingFile = join(b.shared, 'plannotator', 'waiting.json')
  try {
    assert.equal((await b.run()).installed, true)
    const old = b.current()
    await runProgram(old.path, ['inbox', '--background'], ORCA_MODE(b))
    const before = await b.health()

    const plain = await b.run({ version: '0.28.67' })
    assert.equal(plain.ok, true, plain.detail)
    assert.equal(plain.plain, true)
    assert.equal(plain.restarted, true)
    assert.deepEqual(plain.waiting, { version: '0.28.67' })
    assert.equal(
      plain.detail,
      'Plannotator 0.28.67 is in use. Its Orca build is not published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are missing until it is; the Inbox moves to it by itself.'
    )
    assert.equal(b.current(), null, 'the launcher starts the Plannotator installed here')
    assert.equal(readJson(join(b.shared, 'plannotator', 'previous.json')).version, '0.28.66')
    assert.ok(existsSync(old.path), 'the older build stays on disk')
    const now = await b.health()
    assert.equal(now.self, stock)
    assert.equal(now.version, '0.28.67')
    assert.equal(now.orcaMode, null)
    assert.notEqual(now.pid, before.pid)
    assert.deepEqual([b.state().phase, b.state().version, b.state().detail], ['ready', '0.28.67', plain.detail])
    assert.equal(readJson(waitingFile).version, '0.28.67')

    // Looked again, still no build: nothing is restarted.
    const still = await b.run()
    assert.equal(still.plain, true, still.detail)
    assert.equal(still.restarted, false)
    assert.equal((await b.health()).pid, now.pid)

    // Plannotator is updated again under the plain Inbox (in a terminal), still with no build: the
    // Inbox moves to that release, so what is said to be in use is what runs.
    installFake(stock, 'good', '0.28.68')
    const next = await b.run()
    assert.deepEqual([next.plain, next.restarted, next.waiting], [true, true, { version: '0.28.68' }], next.detail)
    const moved = await b.health()
    assert.deepEqual([moved.version, moved.orcaMode], ['0.28.68', null])
    assert.notEqual(moved.pid, now.pid)
    assert.equal((await b.run()).restarted, false, 'and is then left alone')
    assert.equal((await b.health()).pid, moved.pid)

    // Its build is published: it installs, the Inbox moves onto it in Orca mode, and the wait is over.
    server.publish({ version: '0.28.68', build: 'orca.1', bytes: fakeBinary('good', '0.28.68') })
    const done = await b.run()
    assert.equal(done.installed, true, done.detail)
    assert.equal(done.restarted, true)
    const last = await b.health()
    assert.equal(last.self, b.current().path)
    assert.equal(last.orcaMode, '1')
    assert.equal(existsSync(waitingFile), false)
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('Plannotator’s own update fails: nothing changes, and its own words say why', { skip: STAND_IN }, async () => {
  const server = await releaseServer([
    { version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') },
    { version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67') }
  ])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  Object.assign(b.env, { FAKE_UPDATE_TO: '0.28.67', FAKE_UPDATE_FAIL: '1' })
  try {
    // With no build in use yet, and with one.
    for (const staying of ['stock Plannotator', 'the Orca build of Plannotator 0.28.66']) {
      const failed = await b.run({ version: '0.28.67' })
      assert.equal(failed.ok, false)
      assert.equal(
        failed.detail,
        `Plannotator’s own update to 0.28.67 did not finish (Couldn't download the update. 0.28.66 is still installed and works. Try again later: plannotator update), so ${staying} stays in use.`
      )
      assert.equal(b.state().phase, 'failed')
      assert.equal(await versionOf(stock, b.env), '0.28.66')
      assert.equal(existsSync(join(b.shared, 'plannotator', 'waiting.json')), false)
      if (staying === 'stock Plannotator') {
        assert.equal(b.current(), null)
        assert.equal((await b.run()).installed, true)
      } else assert.equal(b.current().version, '0.28.66')
    }
  } finally {
    await server.close()
  }
})

test('an update made outside the Inbox is followed; an older Plannotator never takes the Inbox back; a build that cannot be used leaves Plannotator plain', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  const waitingFile = join(b.shared, 'plannotator', 'waiting.json')
  try {
    assert.equal((await b.run()).installed, true)

    // An older Plannotator than the build in use: the build stays.
    installFake(stock, 'good', '0.28.65')
    const kept = await b.run()
    assert.equal(kept.ok, true)
    assert.equal(kept.detail, 'The Orca build of Plannotator 0.28.66 stays in use; the Plannotator installed here is 0.28.65, an older release.')
    assert.equal(b.current().version, '0.28.66')

    // A person updated Plannotator in a terminal; its release has no Orca build yet. No Inbox runs: nothing restarts.
    installFake(stock, 'good', '0.28.67')
    const plain = await b.run()
    assert.equal(plain.plain, true, plain.detail)
    assert.equal(plain.restarted, false)
    assert.equal(b.current(), null)
    assert.equal(readJson(waitingFile).version, '0.28.67')

    // Its build is published but does not start: Plannotator stays plain, the reason is said, and it is tried again.
    server.publish({ version: '0.28.67', build: 'orca.1', bytes: fakeBinary('nosmoke', '0.28.67') })
    const broken = await b.run()
    assert.equal(broken.ok, true, broken.detail)
    assert.equal(broken.plain, true)
    const said =
      'Plannotator 0.28.67 is in use without its Orca additions. The downloaded Plannotator 0.28.67 failed to start (exit 1), so it was not used. The plugin tries that build again later, and takes a newer one as soon as it is published.'
    assert.equal(broken.detail, said)
    assert.equal(b.current(), null)
    assert.equal(readJson(waitingFile).version, '0.28.67')
    assert.deepEqual([readJson(waitingFile).tried.tag, readJson(waitingFile).tried.failures], ['plannotator-0.28.67-orca.1', 1])

    // The worker's next looks leave that build alone: no second download of what cannot work.
    const fetched = server.downloads()
    const again = await b.run()
    assert.deepEqual([again.ok, again.plain, again.detail], [true, true, said])
    assert.equal(server.downloads(), fetched, 'not downloaded again')
    // A person who asks has it tried at once, and so does the end of its wait (six hours, then twelve).
    assert.equal((await b.run({ again: true })).plain, true)
    assert.equal(server.downloads(), fetched + 1)
    assert.equal(readJson(waitingFile).tried.failures, 2)
    await b.run({ clock: () => Date.now() + 7 * 60 * 60 * 1000 })
    assert.equal(server.downloads(), fetched + 1, 'the second wait is twelve hours')
    await b.run({ clock: () => Date.now() + 13 * 60 * 60 * 1000 })
    assert.equal(server.downloads(), fetched + 2)

    // A build that starts replaces it, at once: it is another build than the one left alone.
    server.publish({ version: '0.28.67', build: 'orca.2', bytes: fakeBinary('good', '0.28.67') })
    const done = await b.run()
    assert.equal(done.installed, true, done.detail)
    assert.equal(b.current().build, 'orca.2')
    assert.equal(existsSync(waitingFile), false)
  } finally {
    await server.close()
  }
})

test('Plannotator’s own update offers nothing newer: said so; a build that needs a newer plugin: Plannotator runs plain and nothing promises a retry', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good', '0.28.66') }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  try {
    assert.equal((await b.run()).installed, true)
    // The Inbox names a release Plannotator's own updater does not offer (it ends well and installs nothing).
    const none = await b.run({ version: '0.28.67' })
    assert.equal(none.ok, false)
    assert.equal(none.detail, 'Plannotator’s own update found nothing newer than 0.28.66 to install, so the Orca build of Plannotator 0.28.66 stays in use.')
    assert.equal(b.current().version, '0.28.66')

    installFake(stock, 'good', '0.28.67')
    server.publish({ version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67'), manifest: (m) => ({ ...m, pluginMin: '9.0.0' }) })
    const old = await b.run()
    assert.equal(old.plain, true, old.detail)
    assert.equal(
      old.detail,
      'Plannotator 0.28.67 is in use without its Orca additions. The Orca build of Plannotator 0.28.67 needs version 9.0.0 of the Plannotator Inbox plugin; update the plugin first.'
    )
    assert.equal(readJson(join(b.shared, 'plannotator', 'waiting.json')).tried, undefined)
    assert.equal(server.downloads(), 1, 'nothing was downloaded for it')
  } finally {
    await server.close()
  }
})

test('a real failure of the build waited for is still a failure, and ends the wait', { skip: STAND_IN }, async () => {
  const bytes = fakeBinary('good', '0.28.67')
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const b = box(server)
  try {
    assert.equal((await b.run()).installed, true)
    assert.equal((await b.run({ version: '0.28.67' })).waiting?.version, '0.28.67')
    server.publish({ version: '0.28.67', build: 'orca.1', bytes, manifest: (m) => ({ ...m, assets: { [KEY]: { ...m.assets[KEY], sha256: 'c'.repeat(64) } } }) })
    const bad = await b.run({ version: '0.28.67' })
    assert.equal(bad.ok, false)
    assert.match(bad.detail, /does not match the checksum.*Orca build of Plannotator 0\.28\.66 stays in use/)
    assert.deepEqual([b.state().phase, b.state().version], ['failed', '0.28.67'])
    assert.equal(existsSync(join(b.shared, 'plannotator', 'waiting.json')), false, 'the build is published: no longer a wait')
    assert.equal(b.current().version, '0.28.66')
  } finally {
    await server.close()
  }
})

test('a reduced build is installed and says what it leaves out; the full build of the same version replaces it', { skip: STAND_IN }, async () => {
  const reduced = (m) => ({ ...m, features: ['agents', 'update-state', 'update-detail'], omitted: ['mark-faces', 'launch-hosts'] })
  const server = await releaseServer([{ version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.67'), manifest: reduced }])
  const b = box(server)
  try {
    const first = await b.run({ version: '0.28.67' })
    assert.equal(first.installed, true, first.detail)
    assert.deepEqual([b.current().build, b.current().features, b.current().omitted], ['orca.1', ['agents', 'update-state', 'update-detail'], ['mark-faces', 'launch-hosts']])
    assert.ok(readRecord(join(b.shared, 'plannotator', 'current.json'), b.shared).omitted, 'the record with its lists is trusted')

    server.publish({ version: '0.28.67', build: 'orca.2', bytes: fakeBinary('good', '0.28.67', 'orca.2'), manifest: (m) => ({ ...m, features: ['mark-faces', 'launch-hosts', 'agents', 'update-state', 'update-detail'], omitted: [] }) })
    const full = await b.run({ version: '0.28.67' })
    assert.equal(full.installed, true, full.detail)
    assert.equal(b.current().build, 'orca.2')
    assert.deepEqual(b.current().omitted, [])
    assert.deepEqual(b.versions(), ['0.28.67-orca.1', '0.28.67-orca.2'])
    assert.equal((await b.run()).installed, false, 'already the newest')
  } finally {
    await server.close()
  }
})

test('a wrong checksum, a wrong size, a missing platform, a cut download or a foreign redirect installs nothing', { skip: STAND_IN }, async () => {
  const bytes = fakeBinary()
  const server = await releaseServer([
    { version: '0.28.66', build: 'orca.1', bytes, manifest: (m) => ({ ...m, assets: { [KEY]: { ...m.assets[KEY], sha256: 'c'.repeat(64) } } }) },
    { version: '0.28.67', build: 'orca.1', bytes, manifest: (m) => ({ ...m, assets: { [KEY]: { ...m.assets[KEY], size: bytes.length + 1 } } }) },
    { version: '0.28.68', build: 'orca.1', bytes, asset: false },
    { version: '0.28.69', build: 'orca.1', bytes },
    { version: '0.28.70', build: 'orca.1', bytes },
    { version: '0.28.71', build: 'orca.1', bytes, manifest: (m) => ({ ...m, pluginMin: '9.0.0' }) }
  ])
  const b = box(server)
  try {
    server.faults.truncate.add('plannotator-0.28.69-orca.1')
    server.faults.redirect.set('plannotator-0.28.70-orca.1', `${server.base.replace('127.0.0.1', 'localhost')}/cdn/plannotator-0.28.70-orca.1/${ASSET}`)
    const cases = [
      ['0.28.66', /does not match the checksum/],
      ['0.28.67', /has \d+ bytes, not the \d+ the release lists/],
      ['0.28.68', new RegExp(`has no file for ${KEY}`)],
      ['0.28.69', /download failed|bytes, not the/],
      ['0.28.70', /not GitHub/],
      ['0.28.71', /needs version 9\.0\.0 of the Plannotator Inbox plugin/]
    ]
    for (const [version, why] of cases) {
      const result = await b.run({ version })
      assert.equal(result.ok, false, version)
      assert.match(result.detail, why, `${version}: ${result.detail}`)
      assert.match(result.detail, /[Ss]tock Plannotator stays in use/, version)
      assert.equal(b.state().phase, 'failed')
      assert.equal(b.current(), null, `${version}: nothing recorded`)
      assert.deepEqual(existsSync(join(b.shared, 'plannotator', 'versions')) ? b.versions() : [], [], `${version}: nothing left behind`)
    }
  } finally {
    await server.close()
  }
})

test('a build that does not start is not used', { skip: STAND_IN }, async () => {
  const server = await releaseServer([
    { version: '0.28.66', build: 'orca.1', bytes: fakeBinary('nosmoke') },
    { version: '0.28.67', build: 'orca.1', bytes: fakeBinary('good', '0.28.99') }
  ])
  const b = box(server)
  try {
    assert.match((await b.run({ version: '0.28.66' })).detail, /Plannotator 0\.28\.66 failed to start/)
    assert.match((await b.run({ version: '0.28.67' })).detail, /reported another version/)
    assert.equal(b.current(), null)
  } finally {
    await server.close()
  }
})

test('a running Inbox moves onto the new build in Orca mode; one that does not answer is rolled back', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('good') }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  try {
    await runProgram(stock, ['inbox', '--background'], b.env)
    const before = await b.health()
    assert.equal(before.self, stock)

    const moved = await b.run()
    assert.equal(moved.ok, true, moved.detail)
    assert.equal(moved.restarted, true)
    assert.match(moved.detail, /the Inbox was restarted on it/)
    const after = await b.health()
    assert.equal(after.self, b.current().path, 'the Inbox runs the Orca build')
    assert.notEqual(after.pid, before.pid)
    assert.equal(after.orcaMode, '1')
    assert.equal(after.orcaConfig, join(b.shared, 'bridge', 'config.json'))

    // A build that stops the Inbox and never answers: the build before it comes back.
    server.publish({ version: '0.28.66', build: 'orca.2', bytes: fakeBinary('dead') })
    const result = await runProgram(process.execPath, [UPDATER, '--version', '0.28.66'], { ...b.env, ORCA_PLANNOTATOR_HOME: b.shared, ELECTRON_RUN_AS_NODE: '1' })
    // The CLI waits the full 30 seconds; the run above used the shorter test wait, so this one is slow on purpose.
    const outcome = JSON.parse(result.stdout.trim().split('\n').pop())
    assert.equal(result.code, 2, result.stdout)
    assert.equal(outcome.rolledBack, true)
    assert.equal(b.state().phase, 'rolled-back')
    assert.match(b.state().detail, /did not answer within 30 seconds after the restart, so the Orca build of Plannotator 0\.28\.66 was put back/)
    assert.equal(b.current().build, 'orca.1')
    const back = await b.health()
    assert.equal(back.self, b.current().path)
    assert.equal(back.orcaMode, '1')
    assert.ok(existsSync(stock), 'stock Plannotator is never removed')
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('without a previous build a failed restart goes back to stock Plannotator', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary('dead') }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  try {
    await runProgram(stock, ['inbox', '--background'], b.env)
    const result = await b.run()
    assert.equal(result.rolledBack, true, result.detail)
    assert.match(result.detail, /so stock Plannotator was put back/)
    assert.equal(b.current(), null)
    assert.equal((await b.health()).self, stock)
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('without Orca’s bridge config, or with no Inbox running, the running Inbox is left alone', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock, config: false })
  try {
    await runProgram(stock, ['inbox', '--background'], b.env)
    const pid = (await b.health()).pid
    const result = await b.run()
    assert.equal(result.ok, true)
    assert.equal(result.restarted, false)
    assert.equal((await b.health()).pid, pid)
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('two runs never overlap, and a lock whose run is gone is taken over', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const b = box(server)
  try {
    server.faults.delayMs = 1500
    const env = { ...b.env, ORCA_PLANNOTATOR_HOME: b.shared, ELECTRON_RUN_AS_NODE: '1' }
    const [one, two] = await Promise.all([runProgram(process.execPath, [UPDATER], env), runProgram(process.execPath, [UPDATER], env)])
    const outcomes = [one, two].map((run) => JSON.parse(run.stdout.trim().split('\n').pop()))
    assert.deepEqual([one.code, two.code], [0, 0])
    assert.equal(outcomes.filter((outcome) => outcome.busy).length, 1, JSON.stringify(outcomes))
    assert.equal(outcomes.filter((outcome) => outcome.installed).length, 1)
    assert.equal(server.downloads(), 1)
    assert.equal(b.state().phase, 'ready')

    // A lock left by a run that is gone.
    writeFileSync(join(b.shared, 'plannotator', 'update.lock'), JSON.stringify({ pid: 2 ** 22 - 3, at: Date.now() }))
    assert.equal(lockHolder(b.shared), null)
    const release = takeLock(b.shared)
    assert.ok(release)
    assert.equal(takeLock(b.shared), null, 'held now')
    release()
    assert.equal(existsSync(join(b.shared, 'plannotator', 'update.lock')), false)
  } finally {
    await server.close()
  }
})

test('the update lock is looked at and changed by one run at a time', () => {
  const shared = join(tempRoot(), 'shared')
  const lock = join(shared, 'plannotator', 'update.lock')
  const gate = `${lock}.gate`
  const gone = 2 ** 22 - 3
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
  mkdirSync(join(shared, 'plannotator'), { recursive: true })
  const tries = LIMITS.gateTries
  LIMITS.gateTries = 5
  try {
    // Another run is at the lock right now (its gate is there and it is alive). The lock it is
    // looking at was left by a run that is gone; this run does not take it from under it.
    writeFileSync(lock, JSON.stringify({ pid: gone, at: Date.now() }))
    writeFileSync(gate, JSON.stringify({ pid: process.pid, id: 'another-run' }))
    assert.equal(takeLock(shared), null)
    assert.equal(read(lock).pid, gone, 'the lock is as the other run found it')
    assert.equal(read(gate).id, 'another-run')
    // A gate another run has just made and not yet written is not mistaken for an old one.
    writeFileSync(gate, '')
    assert.equal(takeLock(shared), null)
    assert.equal(readFileSync(gate, 'utf8'), '')
    assert.equal(read(lock).pid, gone)
    // An empty gate that has been there for long is cleared, and so is one whose run is gone.
    utimesSync(gate, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000))
    const first = takeLock(shared)
    assert.ok(first)
    assert.equal(existsSync(gate), false)
    assert.equal(read(lock).pid, process.pid)
    assert.equal(takeLock(shared), null, 'held now')
    first()
    assert.equal(existsSync(lock), false)
    writeFileSync(gate, JSON.stringify({ pid: gone, id: 'dead-run' }))
    const second = takeLock(shared)
    assert.ok(second)
    assert.equal(existsSync(gate), false)
    // A run gives back only its own lock.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), id: 'a-later-run' }))
    second()
    assert.equal(read(lock).id, 'a-later-run')
    assert.deepEqual(readdirSync(join(shared, 'plannotator')), ['update.lock'], 'nothing else is left behind')
  } finally {
    LIMITS.gateTries = tries
  }
})

test('many runs starting at once over a lock left behind: exactly one takes it', async () => {
  const root = tempRoot()
  const shared = join(root, 'shared')
  const lock = join(shared, 'plannotator', 'update.lock')
  mkdirSync(join(shared, 'plannotator'), { recursive: true })
  const script = join(root, 'contender.mjs')
  // Each waits at the line until all are there, tries once, says what it got, and the one that
  // took the lock keeps it until every other has tried.
  writeFileSync(
    script,
    [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `import { takeLock } from ${JSON.stringify(pathToFileURL(UPDATER).href)}`,
      'const [shared, marks, name] = process.argv.slice(2)',
      "writeFileSync(`${marks}/ready.${name}`, '')",
      'while (!existsSync(`${marks}/go`)) {}',
      'const release = takeLock(shared)',
      "writeFileSync(`${marks}/tried.${name}`, release ? 'took' : 'busy')",
      'if (release) {',
      '  const wait = () => (existsSync(`${marks}/all-tried`) ? release() : setTimeout(wait, 10))',
      '  wait()',
      '}',
      ''
    ].join('\n')
  )
  const count = (marks, prefix) => readdirSync(marks).filter((name) => name.startsWith(prefix)).length
  const when = async (condition) => {
    for (let waited = 0; !condition(); waited += 10) {
      assert.ok(waited < 60_000, 'the contenders got there')
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  // Left by a run that is gone; left empty; and no lock at all.
  for (const left of [JSON.stringify({ pid: 2 ** 22 - 3, at: Date.now() }), '', null]) {
    const marks = tempRoot()
    if (left === null) rmSync(lock, { force: true })
    else writeFileSync(lock, left)
    const runs = Array.from({ length: 8 }, (_, index) => runProgram(process.execPath, [script, shared, marks, String(index)], { ...process.env, ELECTRON_RUN_AS_NODE: '1' }))
    await when(() => count(marks, 'ready.') === 8)
    writeFileSync(join(marks, 'go'), '')
    await when(() => count(marks, 'tried.') === 8)
    const got = readdirSync(marks).filter((name) => name.startsWith('tried.')).map((name) => readFileSync(join(marks, name), 'utf8'))
    writeFileSync(join(marks, 'all-tried'), '')
    const ended = await Promise.all(runs)
    assert.deepEqual(ended.map((run) => run.code), Array(8).fill(0), ended.map((run) => run.stderr).join('\n'))
    assert.equal(got.filter((answer) => answer === 'took').length, 1, JSON.stringify(got))
    assert.deepEqual(readdirSync(join(shared, 'plannotator')), [], 'given back, and nothing else left behind')
  }
})

test('--restart moves a stock Inbox onto the installed build in Orca mode', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  try {
    assert.match((await restartInbox({ shared: b.shared, env: b.env, home: b.home })).detail, /No Orca build of Plannotator is installed yet/)
    await b.run()
    await runProgram(stock, ['inbox', '--background'], b.env)
    assert.equal((await b.health()).self, stock)
    const result = await restartInbox({ shared: b.shared, env: b.env, home: b.home })
    assert.equal(result.ok, true, result.detail)
    const health = await b.health()
    assert.equal(health.self, b.current().path)
    assert.equal(health.orcaMode, '1')
  } finally {
    await stopInbox(stock, b.env)
    await server.close()
  }
})

test('--restart where Plannotator has the Inbox off says so, and starts nothing', { skip: STAND_IN }, async () => {
  const server = await releaseServer([{ version: '0.28.66', build: 'orca.1', bytes: fakeBinary() }])
  const stock = installFake(join(tempRoot(), 'stock', 'plannotator'))
  const b = box(server, { stock })
  try {
    await b.run()
    // Never ran here: no mark and no inbox.json. Plannotator's own `inbox restart` would refuse.
    const result = await restartInbox({ shared: b.shared, env: b.env, home: b.home })
    assert.deepEqual([result.ok, result.detail], [false, 'The Inbox is off on this computer, so it was not restarted. Open Inbox turns it on.'])
    assert.equal(existsSync(join(b.data, 'inbox', 'inbox.json')), false, 'nothing started')
  } finally {
    await server.close()
  }
})

// --- With a real Plannotator ---------------------------------------------------------------------

test(
  'a real Plannotator Inbox moves onto a downloaded build with its data, and a broken build is rolled back',
  { skip: !BINARY ? 'set PLANNOTATOR_E2E_BIN to run' : STAND_IN },
  async () => {
    LIMITS.healthMs = 30_000
    const bytes = readFileSync(BINARY)
    const server = await releaseServer()
    const root = tempRoot('orca-plannotator-update-e2e-')
    const stock = join(root, 'stock', 'plannotator')
    mkdirSync(join(root, 'stock'))
    copyFileSync(BINARY, stock)
    const b = box(server, { stock })
    const env = { ...b.env, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_AUTO_UPDATE: '0', PLANNOTATOR_BROWSER: 'none' }
    const version = (await runProgram(stock, ['--version'], env)).stdout.match(/\d+\.\d+\.\d+/)[0]
    server.publish({ version, build: 'orca.1', bytes })
    try {
      // A person's start: from 0.29.1 it turns the Inbox on, and `--background` and `inbox call` refuse until one has.
      assert.equal((await runProgram(stock, ['inbox', '--open'], env)).code, 0)
      const kept = await runProgram(stock, ['inbox', 'call', '--session', 'e2e-session', 'send_message', JSON.stringify({ body: 'Kept across the update', project_path: root })], env)
      assert.equal(kept.code, 0, kept.stderr)
      const before = await b.health()

      const moved = await update({ shared: b.shared, env, home: b.home, pluginVersion: '0.2.0', version })
      assert.equal(moved.ok, true, moved.detail)
      assert.equal(moved.restarted, true)
      const after = await b.health()
      assert.notEqual(after.pid, before.pid)
      assert.equal(after.version, version)
      const ps = await runProgram('/bin/ps', ['-o', 'comm=', '-p', String(after.pid)], env)
      assert.equal(ps.stdout.trim(), b.current().path, 'the Inbox process is the downloaded build')
      const entry = readJson(join(b.data, 'inbox', 'inbox.json'))
      const threads = await (await fetch(`http://127.0.0.1:${entry.port}/api/inbox/threads`)).text()
      assert.match(threads, /Kept across the update/)

      // A build that passes its check but cannot restart the Inbox: the build before it comes back.
      server.publish({ version, build: 'orca.2', bytes: Buffer.from(`#!/bin/sh\n[ "$1" = --version ] && { echo "plannotator ${version}"; exit 0; }\nexit 1\n`) })
      const broken = await update({ shared: b.shared, env, home: b.home, pluginVersion: '0.2.0', version })
      assert.equal(broken.rolledBack, true, broken.detail)
      assert.equal(b.current().build, 'orca.1')
      const back = await b.health()
      const comm = await runProgram('/bin/ps', ['-o', 'comm=', '-p', String(back.pid)], env)
      assert.equal(comm.stdout.trim(), b.current().path)
      const entryBack = readJson(join(b.data, 'inbox', 'inbox.json'))
      assert.match(await (await fetch(`http://127.0.0.1:${entryBack.port}/api/inbox/threads`)).text(), /Kept across the update/)
      process.stderr.write(`updater e2e passed against Plannotator ${version}\n`)
    } finally {
      LIMITS.healthMs = 4000
      await stopInbox(stock, env)
      await server.close()
    }
  }
)
