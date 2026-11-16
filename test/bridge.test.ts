// The bridge the Orca build of Plannotator calls: its owner-only files, its listener's checks, and
// each route's answers in the shapes Plannotator accepts. Orca and the Inbox are stand-ins.
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { BRIDGE_HEARTBEAT_MS, BridgeFileError, bridgeConfigFile, bridgeHealth, ensureBridgeDir, loadBridgeKey, startBridge, type Bridge, type BridgeConfig } from '../src/bridge'
import type { EngineStatus } from '../src/engine'
import type { DeliveryVerdict, NativeRun } from '../src/lifecycle'
import { OrcaCli } from '../src/orca-cli'
import { fakeInbox, fakeLifecycleOrca, fakeNative, launchThread, memoryStore, tempDir, until } from './fakes'

const KEY = Buffer.alloc(32, 0xab)
const BEARER = `Bearer ${KEY.toString('hex')}`
// Windows has no owner-only file modes; the bridge skips those checks there.
const POSIX = process.platform !== 'win32'
const LAUNCH = { id: 'launch_1', agent: 'codex', folder: '/work/project' }
const START = { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', ownerAction: true }

function engineStatus(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    at: 1_800_000_000_000,
    phase: 'ready',
    headline: '',
    detail: null,
    inbox: { dataDir: '/data', version: null, url: null },
    orca: { version: null },
    sessions: [{ session: 's1', title: null, provider: null, listening: true, note: null }],
    counts: { inFlight: 2, delivered: 5, blocked: 0, rejected: 0 },
    blocked: [],
    rejected: [],
    projects: [],
    ...overrides
  }
}

const bridges: Bridge[] = []
async function setup(options: { config?: Partial<BridgeConfig>; port?: number; heartbeatMs?: number; pid?: number } = {}) {
  const shared = await tempDir('orca-bridge-')
  const orca = fakeLifecycleOrca()
  const native = fakeNative(orca)
  const inbox = fakeInbox()
  inbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', LAUNCH))
  const state = { status: engineStatus(), verdict: 'acknowledged' as DeliveryVerdict, clock: 1_800_000_010_000, logs: [] as string[] }
  const config: BridgeConfig = { dataDir: '/data', launcher: join(shared, 'inbox-mcp'), upgradeCommand: null, projects: [], ...options.config }
  const bridge = await startBridge({
    sharedDir: shared,
    config,
    cli: () => new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} }),
    store: memoryStore(),
    status: () => state.status,
    deliveryState: () => state.verdict,
    log: (message) => void state.logs.push(message),
    now: () => state.clock,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    port: options.port,
    heartbeatMs: options.heartbeatMs,
    pid: options.pid,
    native: native.run as NativeRun,
    reveal: async (session) => ({ ok: true, sessionId: session, workspaceId: 'wt1' }),
    inbox: { fetch: inbox.fetch, readRegistry: inbox.readRegistry }
  })
  bridges.push(bridge)
  return { shared, dir: join(shared, 'bridge'), orca, native, inbox, state, bridge }
}

test.afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
function call(port: number, path: string, options: { method?: string; host?: string; auth?: string | null; body?: string | Buffer; type?: string | null; length?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Host: options.host ?? `127.0.0.1:${port}` }
    if (options.auth !== null) headers.Authorization = options.auth ?? BEARER
    if (options.body !== undefined) {
      if (options.type !== null) headers['Content-Type'] = options.type ?? 'application/json'
      headers['Content-Length'] = options.length ?? Buffer.byteLength(options.body)
    }
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}
const post = (port: number, route: string, body: unknown) => call(port, `/api/lifecycle/${route}`, { body: JSON.stringify(body) })

// What the Orca build of Plannotator requires of each answer before it uses it.
const plannotator = {
  health: (body: Record<string, unknown>) =>
    body.version === 1 && ['ready', 'waiting', 'error'].includes(String(body.level)) && typeof body.fresh === 'boolean' && ['connected', 'conversations', 'delivered', 'waiting', 'blocked'].every((name) => Number.isSafeInteger(body[name])),
  catalog: (body: Record<string, unknown>) =>
    body.ok === true && Array.isArray(body.workspaces) && Array.isArray(body.providers) && typeof body.sessions === 'object' && body.sessions !== null && !Array.isArray(body.sessions) && Array.isArray(body.projects) && (body.projects as unknown[]).length <= 1000 &&
    (body.projects as { root: unknown; name: unknown }[]).every((project) => typeof project.root === 'string' && isAbsolute(project.root) && project.root.length <= 4096 && typeof project.name === 'string' && project.name.length >= 1 && project.name.length <= 200),
  started: (body: Record<string, unknown>) => body.ok === true && typeof body.session === 'string' && body.ref === body.session,
  owned: (body: Record<string, unknown>, session: string) => {
    const launches = Array.isArray(body.launches) ? (body.launches as Record<string, unknown>[]) : []
    return body.ok === true && body.version === 1 && body.complete === true && launches.length === 1 && launches[0]!.session === session && launches[0]!.state === 'created'
  },
  /** A POST refusal Plannotator shows in words: status 200 and `{ok:false,text}`. */
  refusal: (answer: Answer) => answer.status === 200 && answer.body.ok === false && typeof answer.body.text === 'string' && (answer.body.text as string).length > 0
}

test('the bridge files are owner-only and in the fixed shapes', async () => {
  const t = await setup({ config: { upgradeCommand: ['/opt/update'] } })
  if (POSIX) {
    assert.equal((await lstat(t.dir)).mode & 0o777, 0o700)
    for (const name of ['link-key', 'navigation.json', 'config.json']) assert.equal((await lstat(join(t.dir, name))).mode & 0o777, 0o600, name)
  }
  assert.deepEqual(await readFile(join(t.dir, 'link-key')), KEY)
  assert.deepEqual(JSON.parse(await readFile(join(t.dir, 'navigation.json'), 'utf8')), { version: 1, port: t.bridge.port, pid: process.pid, at: t.state.clock })
  assert.deepEqual(JSON.parse(await readFile(join(t.dir, 'config.json'), 'utf8')), {
    v: 1,
    canonicalDataDir: resolve('/data'),
    dataDirs: [resolve('/data')],
    stateDir: t.dir,
    mcpCommand: [join(t.shared, 'inbox-mcp')],
    upgradeCommand: ['/opt/update'],
    upgradeStateFile: join(t.dir, 'upgrade-state.json'),
    upgradeBackoffMs: 21_600_000
  })
  assert.deepEqual(bridgeConfigFile('/s', { dataDir: '/d/../e', launcher: '/l', upgradeCommand: null, projects: [] }).upgradeCommand, [])
  assert.equal(bridgeConfigFile('/s', { dataDir: '/d/../e', launcher: '/l', upgradeCommand: null, projects: [] }).canonicalDataDir, resolve('/e'))

  await t.bridge.configure({ dataDir: '/other', launcher: join(t.shared, 'inbox-mcp'), upgradeCommand: null, projects: [] })
  const changed = JSON.parse(await readFile(join(t.dir, 'config.json'), 'utf8'))
  assert.deepEqual([changed.canonicalDataDir, changed.upgradeCommand], [resolve('/other'), []])
  await assert.rejects(t.bridge.configure({ dataDir: 'relative', launcher: '/l', upgradeCommand: null, projects: [] }), BridgeFileError)

  await t.bridge.stop()
  await assert.rejects(lstat(join(t.dir, 'navigation.json')), /ENOENT/)
  assert.deepEqual(await readFile(join(t.dir, 'link-key')), KEY, 'the key is kept')
})

test('a bridge key that is not exactly 32 private bytes of this user is refused, never replaced', async () => {
  const dir = await ensureBridgeDir(await tempDir('orca-bridge-key-'))
  const created = await loadBridgeKey(dir)
  assert.equal(created.length, 32)
  assert.deepEqual(await loadBridgeKey(dir), created, 'created once')
  if (POSIX) {
    await chmod(join(dir, 'link-key'), 0o644)
    await assert.rejects(loadBridgeKey(dir), /read by others/)
    await chmod(join(dir, 'link-key'), 0o600)
    await assert.rejects(loadBridgeKey(dir, { uid: (process.getuid?.() ?? 0) + 1 }), /someone else/)
  }
  await writeFile(join(dir, 'link-key'), Buffer.alloc(31))
  await assert.rejects(loadBridgeKey(dir), /not a bridge key/)
  assert.equal((await readFile(join(dir, 'link-key'))).length, 31)
  await rm(join(dir, 'link-key'))
  const target = join(dir, 'elsewhere')
  await writeFile(target, Buffer.alloc(32), { mode: 0o600 })
  await symlink(target, join(dir, 'link-key'))
  await assert.rejects(loadBridgeKey(dir), /not a regular file/)
  await assert.rejects(loadBridgeKey(dir, { randomBytes: () => Buffer.alloc(16) }), BridgeFileError)

  const parent = await tempDir('orca-bridge-dir-')
  await writeFile(join(parent, 'bridge'), 'x')
  await assert.rejects(ensureBridgeDir(parent), /not a folder/)
  const loose = await tempDir('orca-bridge-loose-')
  await mkdir(join(loose, 'bridge'), { mode: 0o755 })
  await chmod(join(loose, 'bridge'), 0o755)
  await ensureBridgeDir(loose)
  assert.equal((await lstat(join(loose, 'bridge'))).mode & 0o777, 0o700)
})

test('only this computer’s own address and the bearer key are answered', async () => {
  const t = await setup()
  const port = t.bridge.port
  assert.equal((await call(port, '/api/health')).status, 200)
  assert.equal((await call(port, '/api/health', { host: `localhost:${port}` })).status, 200)
  for (const host of ['evil.example', `127.0.0.1:${port + 1}`, `localhost`, `attacker.test:${port}`, `0.0.0.0:${port}`]) {
    const answer = await call(port, '/api/health', { host })
    assert.equal(answer.status, 403, host)
    assert.equal(answer.body.ok, false)
  }
  for (const auth of [null, '', 'Bearer', `Bearer ${KEY.toString('hex').toUpperCase()}`, `Bearer ${KEY.toString('hex')}0`, `bearer ${KEY.toString('hex')}`, `Basic ${KEY.toString('hex')}`]) {
    assert.equal((await call(port, '/api/health', { auth })).status, 401, String(auth))
    assert.equal((await call(port, '/api/lifecycle/start', { auth, body: JSON.stringify(START) })).status, 401)
  }
  assert.equal(t.orca.state.calls.length, 0, 'nothing reached Orca without the key')
  // A wrong Host is refused before the key is even looked at.
  assert.equal((await call(port, '/api/health', { host: 'evil.example', auth: null })).status, 403)

  const answer = await call(port, '/api/health')
  assert.equal(answer.headers['access-control-allow-origin'], undefined)
  assert.equal(answer.headers.connection, 'close')
  assert.equal(answer.headers['cache-control'], 'no-store')
  assert.equal(answer.headers['x-content-type-options'], 'nosniff')
  assert.match(String(answer.headers['content-type']), /^application\/json/)
})

test('unknown paths, wrong methods, non-JSON, queries and oversized bodies are refused', async () => {
  const t = await setup()
  const port = t.bridge.port
  assert.equal((await call(port, '/api/other')).status, 404)
  assert.equal((await call(port, '/api/lifecycle/start/')).status, 404)
  assert.equal((await call(port, '/api/health', { method: 'POST', body: '{}' })).status, 405)
  assert.equal((await call(port, '/api/lifecycle/start')).status, 405)
  assert.equal((await call(port, '/api/lifecycle/catalog', { method: 'DELETE' })).status, 405)
  assert.equal((await call(port, '/api/lifecycle/start', { body: JSON.stringify(START), type: 'text/plain' })).status, 415)
  assert.equal((await call(port, '/api/lifecycle/start', { body: JSON.stringify(START), type: null })).status, 415)
  assert.equal((await call(port, '/api/lifecycle/start?x=1', { body: JSON.stringify(START) })).status, 400)
  assert.equal((await call(port, '/api/lifecycle/start', { body: '[1]' })).status, 400)
  assert.equal((await call(port, '/api/lifecycle/start', { body: 'not json' })).status, 400)
  const big = JSON.stringify({ ...START, pad: 'x'.repeat(70 * 1024) })
  const oversized = await call(port, '/api/lifecycle/start', { body: big }).catch(() => null)
  assert.ok(oversized === null || oversized.status === 400)
  assert.equal((await call(port, '/api/health?x=1')).status, 400)
  assert.equal((await call(port, '/api/lifecycle/catalog?x=1')).status, 400)
  assert.equal((await call(port, '/api/lifecycle/status?session=a&session=b')).status, 400)
  assert.equal((await call(port, '/api/lifecycle/status?other=a')).status, 400)
  assert.equal((await call(port, '/api/lifecycle/status?session=a%20b')).status, 400)
  assert.equal(t.orca.state.created, 0)
})

test('health follows the engine: ready, waiting and error', async () => {
  const now = 1_800_000_010_000
  assert.deepEqual(bridgeHealth(engineStatus(), now), { version: 1, level: 'ready', fresh: true, connected: 1, conversations: 1, delivered: 5, waiting: 2, blocked: 0 })
  assert.equal(bridgeHealth(engineStatus({ at: now - 60_000 }), now).level, 'waiting')
  assert.equal(bridgeHealth(engineStatus({ at: now - 60_000 }), now).fresh, false)
  assert.equal(bridgeHealth(engineStatus({ phase: 'no-orca' }), now).level, 'waiting')
  assert.equal(bridgeHealth(engineStatus({ sessions: [] }), now).level, 'waiting')
  assert.equal(bridgeHealth(engineStatus({ sessions: [{ session: 's1', title: null, provider: null, listening: false, note: null }] }), now).level, 'waiting')
  assert.equal(bridgeHealth(engineStatus({ counts: { inFlight: 0, delivered: 0, blocked: 1, rejected: 0 } }), now).level, 'error')

  const t = await setup()
  const answer = await call(t.bridge.port, '/api/health')
  assert.equal(answer.status, 200)
  assert.ok(plannotator.health(answer.body), JSON.stringify(answer.body))
  assert.equal(answer.body.level, 'ready')
  t.state.status = engineStatus({ counts: { inFlight: 0, delivered: 0, blocked: 3, rejected: 0 } })
  assert.equal((await call(t.bridge.port, '/api/health')).body.level, 'error')
})

test('each route answers in the shape Plannotator accepts, and refusals carry words', async () => {
  const t = await setup()
  const port = t.bridge.port
  const catalog = await call(port, '/api/lifecycle/catalog')
  assert.equal(catalog.status, 200)
  assert.ok(plannotator.catalog(catalog.body), JSON.stringify(catalog.body))
  assert.deepEqual(catalog.body.projects, [{ root: '/work/project', name: 'Project' }])

  const started = await post(port, 'start', START)
  assert.ok(plannotator.started(started.body), JSON.stringify(started.body))
  const session = String(started.body.session)
  const status = await call(port, `/api/lifecycle/status?session=${session}`)
  assert.ok(plannotator.owned(status.body, session), JSON.stringify(status.body))
  assert.equal((await call(port, '/api/lifecycle/status')).status, 200)

  const action = (id: number, extra: Record<string, unknown> = {}) => ({ launchId: 'launch_1', session, ownerAction: true, actionId: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`, ...extra })
  const stop = await post(port, 'stop', action(1))
  assert.equal(stop.body.ok, true, JSON.stringify(stop.body))
  const resumed = await post(port, 'resume', action(2, { deliver: true }))
  assert.deepEqual(resumed.body, { ok: true, session, state: 'acknowledged' })
  const opened = await post(port, 'open', action(3))
  assert.deepEqual(opened.body, { ok: true, session, opened: 'chat' })

  // Refusals: status 200 and words, so Plannotator shows them.
  assert.ok(plannotator.refusal(await post(port, 'start', { ...START, provider: 'gemini' })))
  assert.ok(plannotator.refusal(await post(port, 'stop', action(4, { launchId: 'launch_other' }))))
  assert.ok(plannotator.refusal(await post(port, 'resume', action(5, { session: 'never_owned' }))))
  assert.ok(plannotator.refusal(await post(port, 'open', action(6, { ownerAction: false }))))
  assert.equal((await post(port, 'nonsense', {})).status, 404)
  assert.equal(t.orca.state.created, 1)

  // A broken record: a GET says why with 409; a POST in words with 200.
  t.native.state.answers.set('prepare-stop', { ok: false, reason: 'Orca lacks agent-session.conversation-stop.v1', started: true, code: 'unsupported' })
  const unsupported = await post(port, 'stop', action(7))
  assert.ok(plannotator.refusal(unsupported))
  assert.deepEqual(Object.keys(unsupported.body).sort(), ['ok', 'text'])
})

test('a repeated request replays its recorded result over the bridge', async () => {
  const t = await setup()
  const port = t.bridge.port
  const first = await post(port, 'start', START)
  const second = await post(port, 'start', START)
  assert.equal(second.body.session, first.body.session)
  assert.equal(second.body.replayed, true)
  const stop = { launchId: 'launch_1', session: first.body.session, ownerAction: true, actionId: '22222222-2222-4222-8222-222222222222' }
  const once = await post(port, 'stop', stop)
  const again = await post(port, 'stop', stop)
  assert.deepEqual(again.body, once.body)
  assert.equal(t.native.state.calls.filter((entry) => entry.action === 'stop').length, 1)
  assert.equal(t.orca.launches().length, 1)
})

test('a GET whose answer is not known in time says so; an unreadable record answers 409', async () => {
  const base = {
    config: { dataDir: '/data', launcher: '/l', upgradeCommand: null, projects: [] },
    status: () => engineStatus(),
    deliveryState: () => 'unknown' as const,
    log: () => undefined,
    randomBytes: (size: number) => Buffer.alloc(size, 0xab)
  }
  const broken = await startBridge({ ...base, sharedDir: await tempDir('orca-bridge-broken-'), cli: () => null, store: memoryStore({ 'lifecycle.v1': { launches: { broken: 1 }, actions: {} } }) })
  bridges.push(broken)
  const answer = await call(broken.port, '/api/lifecycle/catalog')
  assert.equal(answer.status, 409)
  assert.equal(answer.body.ok, false)
  assert.equal(typeof answer.body.text, 'string')
  assert.ok(plannotator.refusal(await post(broken.port, 'start', START)))

  // Orca's CLI hangs: the read answers 503 before Plannotator's own 5 s limit.
  const slow = await startBridge({ ...base, sharedDir: await tempDir('orca-bridge-slow-'), cli: () => new Promise(() => undefined), store: memoryStore() })
  bridges.push(slow)
  const started = Date.now()
  const late = await call(slow.port, '/api/lifecycle/catalog')
  assert.equal(late.status, 503)
  assert.ok(Date.now() - started < 5_000)
})

test('navigation.json is renewed while listening and never put back after stop', async () => {
  const t = await setup({ heartbeatMs: 20 })
  const file = join(t.dir, 'navigation.json')
  const first = JSON.parse(await readFile(file, 'utf8')).at as number
  t.state.clock += 1000
  await until(async () => JSON.parse(await readFile(file, 'utf8')).at > first, 'a renewed navigation.json')
  assert.ok(BRIDGE_HEARTBEAT_MS <= 15_000)
  // Stop while renewals are firing: none may recreate the file afterwards.
  await t.bridge.stop()
  await assert.rejects(lstat(file), /ENOENT/)
  await new Promise((resolve) => setTimeout(resolve, 120))
  await assert.rejects(lstat(file), /ENOENT/)
  await t.bridge.stop()
  await assert.rejects(call(t.bridge.port, '/api/health'))
})

test('stop leaves another listener’s navigation.json alone', async () => {
  const t = await setup()
  const file = join(t.dir, 'navigation.json')
  await writeFile(file, JSON.stringify({ version: 1, port: t.bridge.port, pid: 999_999, at: 1 }), { mode: 0o600 })
  await t.bridge.stop()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, 999_999)
})

test('a restarted bridge listens on its recorded port, and on another when that one is taken', async () => {
  const first = await setup()
  const port = first.bridge.port
  // Simulate a stop that did not clean up: put the record back.
  await first.bridge.stop()
  await writeFile(join(first.dir, 'navigation.json'), JSON.stringify({ version: 1, port, pid: 1, at: 1 }), { mode: 0o600 })
  const again = await startBridge({
    sharedDir: first.shared,
    config: { dataDir: '/data', launcher: '/l', upgradeCommand: null, projects: [] },
    cli: () => null,
    store: memoryStore(),
    status: () => engineStatus(),
    deliveryState: () => 'unknown',
    log: () => undefined
  })
  bridges.push(again)
  assert.equal(again.port, port)
  assert.deepEqual(await readFile(join(first.dir, 'link-key')), KEY, 'the same key')
  await again.stop()

  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port }, resolve))
  try {
    const moved = await setup({ port })
    assert.notEqual(moved.bridge.port, port)
    assert.ok(moved.state.logs.some((line) => line.includes('is taken')))
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test('with no Orca CLI the routes refuse in words and health still answers', async () => {
  const shared = await tempDir('orca-bridge-nocli-')
  const bridge = await startBridge({
    sharedDir: shared,
    config: { dataDir: '/data', launcher: '/l', upgradeCommand: null, projects: [] },
    cli: () => null,
    store: memoryStore(),
    status: () => engineStatus({ phase: 'no-orca' }),
    deliveryState: () => 'unknown',
    log: () => undefined,
    randomBytes: (size) => Buffer.alloc(size, 0xab)
  })
  bridges.push(bridge)
  assert.equal((await call(bridge.port, '/api/health')).body.level, 'waiting')
  assert.ok(plannotator.refusal(await post(bridge.port, 'start', START)))
  assert.equal((await call(bridge.port, '/api/lifecycle/catalog')).status, 409)
})
