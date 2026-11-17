// "Open in Orca" links. Nothing here touches the real machine or a real Orca: a temporary shared
// folder, a listener on loopback, a stand-in CLI, and a stand-in reveal (or the real helper run
// with this Node against stand-in Orca files).
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  confirmPage,
  helperReveal,
  LINK_KEY_FILE,
  loadLinkKey,
  NAVIGATION_FILE,
  NavigationKeyError,
  openChat,
  parseToken,
  REVEAL_HELPER,
  revealRuntime,
  runHelper,
  signLink,
  signToken,
  startNavigation,
  type HelperRun,
  type Navigation,
  type NavigationCli,
  type NavigationDeps,
  type RevealResult
} from '../src/navigation'
import { OrcaCli, parseNavigationTargets, type NavigationTarget } from '../src/orca-cli'
import { fakeOrca, tempDir, until } from './fakes'

const SESSION = 'codex_native1'
const KEY = 'ab'.repeat(32)
const POSIX = process.platform !== 'win32'

// ---------------------------------------------------------------------------------------------
// Stand-ins

function fakeCli(rows: NavigationTarget[] = [{ session: SESSION, worktreeId: 'repo::/project', selector: 'id:repo::/project', folder: false }]) {
  const state = {
    rows,
    /** Replaces the list after this many reads (to simulate a change between reveal and activate). */
    afterReads: null as null | { count: number; rows: NavigationTarget[] },
    reads: 0,
    activated: [] as string[],
    activateFails: false
  }
  const cli: NavigationCli = {
    navigationTargets: async () => {
      state.reads += 1
      if (state.afterReads && state.reads > state.afterReads.count) return structuredClone(state.afterReads.rows)
      return structuredClone(state.rows)
    },
    activateWorktree: async (selector) => {
      if (state.activateFails) throw new Error('refused')
      state.activated.push(selector)
      return selector.replace(/^id:/, '')
    }
  }
  return { state, cli }
}

function fakeReveal(answer: (session: string) => RevealResult = (session) => ({ ok: true, sessionId: session, workspaceId: 'repo::/project' })) {
  const calls: string[] = []
  const reveal = async (session: string): Promise<RevealResult> => {
    calls.push(session)
    return answer(session)
  }
  return { calls, reveal }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function fetchLocal(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...options.headers }
    if (options.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(options.body))
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, setHost: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const CLICK = { 'Sec-Fetch-User': '?1', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' }

async function listener(overrides: Partial<NavigationDeps> = {}) {
  const dir = join(await tempDir('orca-nav-'), 'shared')
  const orca = fakeCli()
  const revealer = fakeReveal()
  const logs: string[] = []
  const base: NavigationDeps = { sharedDir: dir, cli: () => orca.cli, reveal: revealer.reveal, log: (line) => logs.push(line), ...overrides }
  const nav = await startNavigation(base)
  const url = nav.link(SESSION)
  const path = new URL(url).pathname
  const token = path.slice('/open/'.length)
  return { dir, orca, revealer, logs, nav, url, path, token, base }
}

// ---------------------------------------------------------------------------------------------
// Tokens

test('a token names one chat, is signed with the shared key, and survives a round trip', () => {
  const link = signLink(KEY, 41234, SESSION)
  const token = link.slice('http://127.0.0.1:41234/open/'.length)
  assert.ok(link.startsWith('http://127.0.0.1:41234/open/'))
  const [payload, sig] = token.split('.') as [string, string]
  assert.equal(Buffer.from(payload, 'base64url').toString('utf8'), JSON.stringify({ v: 1, session: SESSION, tab: `structured-agent-session-${SESSION}` }))
  assert.match(sig, /^[0-9a-f]{64}$/)
  assert.deepEqual(parseToken(KEY, token), { session: SESSION, tab: `structured-agent-session-${SESSION}` })
  // Orca's mail-address prefix is not part of a link.
  assert.equal(signToken(KEY, `orca_session_id:${SESSION}`), token)
  assert.throws(() => signToken(KEY, 'not a session'))
  assert.throws(() => signLink(KEY, 0, SESSION))
})

test('tampered, foreign and malformed tokens are refused', () => {
  const token = signToken(KEY, SESSION)
  const [payload, sig] = token.split('.') as [string, string]
  const flip = (text: string, at: number) => text.slice(0, at) + (text[at] === 'a' ? 'b' : 'a') + text.slice(at + 1)
  const forged = (claim: unknown) => {
    const body = Buffer.from(JSON.stringify(claim)).toString('base64url')
    return `${body}.${signToken(KEY, SESSION).split('.')[1]}`
  }
  const resigned = (claim: unknown) => {
    // Correctly signed, but the claim itself is wrong.
    const body = Buffer.from(JSON.stringify(claim)).toString('base64url')
    return `${body}.${createHmac('sha256', Buffer.from(KEY, 'hex')).update(body).digest('hex')}`
  }
  for (const bad of [
    `${payload}.${flip(sig, 5)}`,
    `${flip(payload, 3)}.${sig}`,
    `${payload}.${sig.toUpperCase()}`,
    `${payload}.${sig}x`,
    `${payload}${sig}`,
    `${payload}.${sig}?x=1`,
    '',
    'a'.repeat(800),
    forged({ v: 1, session: 'other', tab: 'structured-agent-session-other' }),
    resigned({ v: 2, session: SESSION, tab: `structured-agent-session-${SESSION}` }),
    resigned({ v: 1, session: SESSION, tab: 'structured-agent-session-other' }),
    resigned({ v: 1, session: SESSION, tab: `structured-agent-session-${SESSION}`, extra: 1 }),
    resigned({ v: 1, session: 'orca_session_id:x', tab: 'structured-agent-session-orca_session_id:x' }),
    resigned({ v: '1', session: SESSION, tab: `structured-agent-session-${SESSION}` }),
    resigned([1, SESSION])
  ]) {
    assert.equal(parseToken(KEY, bad), null, bad)
  }
  assert.equal(parseToken('cd'.repeat(32), token), null, 'another key')
  assert.equal(parseToken('not-a-key', token), null)
})

// ---------------------------------------------------------------------------------------------
// The shared files

test('the link key is created once, owner-only, and kept across restarts', async () => {
  const dir = await tempDir('orca-nav-')
  const key = await loadLinkKey(dir, { randomBytes: () => Buffer.alloc(32, 7) })
  assert.equal(key, '07'.repeat(32))
  assert.equal(await readFile(join(dir, LINK_KEY_FILE), 'utf8'), `${'07'.repeat(32)}\n`)
  if (POSIX) assert.equal((await stat(join(dir, LINK_KEY_FILE))).mode & 0o777, 0o600)
  assert.equal(await loadLinkKey(dir, { randomBytes: () => Buffer.alloc(32, 9) }), key, 'never rotated')
})

test('a key file that is readable by others, a symlink, foreign or malformed is refused, not replaced', { skip: !POSIX }, async () => {
  const dir = await tempDir('orca-nav-')
  const file = join(dir, LINK_KEY_FILE)
  await writeFile(file, `${KEY}\n`, { mode: 0o600 })
  await chmod(file, 0o644)
  await assert.rejects(loadLinkKey(dir), NavigationKeyError)
  assert.equal(await readFile(file, 'utf8'), `${KEY}\n`, 'left as it was')

  await chmod(file, 0o600)
  assert.equal(await loadLinkKey(dir), KEY)
  await assert.rejects(loadLinkKey(dir, { uid: (process.getuid?.() ?? 0) + 1 }), NavigationKeyError, 'someone else’s file')

  const elsewhere = await tempDir('orca-nav-')
  const linked = join(elsewhere, LINK_KEY_FILE)
  await writeFile(join(elsewhere, 'real-key'), `${KEY}\n`, { mode: 0o600 })
  await symlink(join(elsewhere, 'real-key'), linked)
  await assert.rejects(loadLinkKey(elsewhere), NavigationKeyError)
  assert.ok((await lstat(linked)).isSymbolicLink())

  const third = await tempDir('orca-nav-')
  await writeFile(join(third, LINK_KEY_FILE), 'X'.repeat(64), { mode: 0o600 })
  await assert.rejects(loadLinkKey(third), NavigationKeyError)
  const fourth = await tempDir('orca-nav-')
  await mkdir(join(fourth, LINK_KEY_FILE))
  await assert.rejects(loadLinkKey(fourth), NavigationKeyError)
})

test('a listener refuses to start on an unsafe key', { skip: !POSIX }, async () => {
  const dir = await tempDir('orca-nav-')
  await writeFile(join(dir, LINK_KEY_FILE), `${KEY}\n`, { mode: 0o644 })
  await chmod(join(dir, LINK_KEY_FILE), 0o644)
  await assert.rejects(startNavigation({ sharedDir: dir, cli: () => null, log: () => undefined }), NavigationKeyError)
})

test('navigation.json says where the listener is, is renewed, and is removed on stop', async () => {
  let now = 1_000
  const t = await listener({ now: () => now, pid: 4242, heartbeatMs: 20 })
  try {
    const file = join(t.dir, NAVIGATION_FILE)
    const first = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(first, { v: 1, port: t.nav.port, pid: 4242, at: 1_000 })
    if (POSIX) assert.equal((await stat(file)).mode & 0o777, 0o600)
    now = 2_000
    await until(async () => JSON.parse(await readFile(file, 'utf8')).at === 2_000, 'a renewed navigation.json')
    assert.equal((await fetchLocal(t.nav.port, '/health')).body, '{"ok":true}')
  } finally {
    await t.nav.stop()
  }
  await assert.rejects(readFile(join(t.dir, NAVIGATION_FILE), 'utf8'))
})

test('the key and the port survive a restart, so links already handed out keep working', async () => {
  const t = await listener()
  const port = t.nav.port
  await t.nav.stop()
  // A crash leaves navigation.json behind; the next start reads it.
  await writeFile(join(t.dir, NAVIGATION_FILE), JSON.stringify({ v: 1, port, pid: 1, at: 1 }), { mode: 0o600 })
  const again = await startNavigation(t.base)
  try {
    assert.equal(again.port, port)
    assert.equal(again.link(SESSION), t.url)
    const reply = await fetchLocal(again.port, t.path, { headers: CLICK })
    assert.equal(reply.status, 200)
  } finally {
    await again.stop()
  }
})

test('a taken port gives a new one instead of failing', async () => {
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const taken = (blocker.address() as { port: number }).port
  const dir = await tempDir('orca-nav-')
  await writeFile(join(dir, NAVIGATION_FILE), JSON.stringify({ v: 1, port: taken, pid: 1, at: 1 }))
  const logs: string[] = []
  const nav = await startNavigation({ sharedDir: dir, cli: () => null, log: (line) => logs.push(line) })
  try {
    assert.notEqual(nav.port, taken)
    assert.equal(JSON.parse(await readFile(join(dir, NAVIGATION_FILE), 'utf8')).port, nav.port)
    assert.ok(logs.some((line) => line.includes('is taken')))
  } finally {
    await nav.stop()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test('stop leaves navigation.json alone when another listener has taken it over', async () => {
  const t = await listener()
  await writeFile(join(t.dir, NAVIGATION_FILE), JSON.stringify({ v: 1, port: 1, pid: 99999999, at: 1 }))
  await t.nav.stop()
  assert.equal(JSON.parse(await readFile(join(t.dir, NAVIGATION_FILE), 'utf8')).pid, 99999999)
})

// ---------------------------------------------------------------------------------------------
// Requests

test('a link preview or a plain fetch gets a button and opens nothing', async () => {
  const t = await listener()
  try {
    const reply = await fetchLocal(t.nav.port, t.path)
    assert.equal(reply.status, 200)
    assert.match(reply.body, /<button type=submit autofocus>Open the chat<\/button>/)
    assert.match(reply.body, /<form method=post action=\/open>/)
    assert.ok(reply.body.includes(`value="${t.token}"`))
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.equal(reply.headers['x-content-type-options'], 'nosniff')
    assert.equal(reply.headers['referrer-policy'], 'no-referrer')
    assert.match(String(reply.headers['content-security-policy']), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/)
    // Half a click (no user activation, or not a navigation) is still a preview.
    await fetchLocal(t.nav.port, t.path, { headers: { 'Sec-Fetch-Mode': 'navigate' } })
    await fetchLocal(t.nav.port, t.path, { headers: { 'Sec-Fetch-User': '?1', 'Sec-Fetch-Mode': 'no-cors' } })
    assert.deepEqual(t.revealer.calls, [])
    assert.equal(t.orca.state.reads, 0)
    assert.deepEqual(t.orca.state.activated, [])
  } finally {
    await t.nav.stop()
  }
})

test('the page escapes what it shows', () => {
  const html = confirmPage('"><script>alert(1)</script>')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&#34;&#62;&#60;script&#62;'))
})

test('a person clicking the link opens the exact chat, then its workspace', async () => {
  const t = await listener()
  try {
    const reply = await fetchLocal(t.nav.port, t.path, { headers: CLICK })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /Opened the chat\./)
    assert.deepEqual(t.revealer.calls, [SESSION])
    assert.deepEqual(t.orca.state.activated, ['id:repo::/project'])
    assert.equal(t.orca.state.reads, 2, 'the list is read again before the workspace is opened')
    // localhost is the same listener.
    const local = await fetchLocal(t.nav.port, t.path, { headers: { ...CLICK, Host: `localhost:${t.nav.port}` } })
    assert.equal(local.status, 200)
  } finally {
    await t.nav.stop()
  }
})

test('any other Host is refused before anything else is looked at', async () => {
  const t = await listener()
  try {
    for (const host of ['attacker.example', `attacker.example:${t.nav.port}`, `127.0.0.1:${t.nav.port + 1}`, '127.0.0.1', `[::1]:${t.nav.port}`]) {
      const reply = await fetchLocal(t.nav.port, t.path, { headers: { ...CLICK, Host: host } })
      assert.equal(reply.status, 403, host)
      assert.doesNotMatch(reply.body, /form/)
    }
    const health = await fetchLocal(t.nav.port, '/health', { headers: { Host: 'attacker.example' } })
    assert.equal(health.status, 403)
    assert.deepEqual(t.revealer.calls, [])
    assert.deepEqual(t.orca.state.activated, [])
  } finally {
    await t.nav.stop()
  }
})

test('a tampered link opens nothing, and there are no other routes', async () => {
  const t = await listener()
  try {
    assert.equal((await fetchLocal(t.nav.port, `${t.path}x`, { headers: CLICK })).status, 404)
    assert.equal((await fetchLocal(t.nav.port, `${t.path}?a=1`, { headers: CLICK })).status, 404)
    assert.equal((await fetchLocal(t.nav.port, '/')).status, 404)
    assert.equal((await fetchLocal(t.nav.port, '/api/link?session=codex_native1')).status, 404)
    assert.equal((await fetchLocal(t.nav.port, '/health.json')).status, 404)
    assert.equal((await fetchLocal(t.nav.port, '/health', { method: 'POST', body: '' })).status, 405)
    const health = await fetchLocal(t.nav.port, '/health')
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.body), { ok: true })
    assert.deepEqual(t.revealer.calls, [])
  } finally {
    await t.nav.stop()
  }
})

test('the button’s POST opens the chat only from the listener’s own origin', async () => {
  const t = await listener()
  const form = new URLSearchParams({ token: t.token }).toString()
  const post = (headers: Record<string, string>, body = form) =>
    fetchLocal(t.nav.port, '/open', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body })
  try {
    assert.equal((await post({})).status, 403, 'no Origin')
    assert.equal((await post({ Origin: 'http://attacker.example' })).status, 403)
    assert.equal((await post({ Origin: 'null' })).status, 403)
    assert.equal((await post({ Origin: `http://127.0.0.1:${t.nav.port + 1}` })).status, 403)
    assert.equal((await post({ Origin: `http://localhost:${t.nav.port}` })).status, 403, 'Origin must match the Host it was sent to')
    assert.equal((await post({ Origin: `http://127.0.0.1:${t.nav.port}`, 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await post({ Origin: `http://127.0.0.1:${t.nav.port}` }, `${form}&token=${t.token}`)).status, 400)
    assert.equal((await post({ Origin: `http://127.0.0.1:${t.nav.port}` }, 'token=nope')).status, 400)
    assert.deepEqual(t.revealer.calls, [])

    const reply = await post({ Origin: `http://127.0.0.1:${t.nav.port}` })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /Opened the chat\./)
    assert.deepEqual(t.revealer.calls, [SESSION])
  } finally {
    await t.nav.stop()
  }
})

test('one chat is opened at a time', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const t = await listener({
    reveal: async (session) => {
      await gate
      return { ok: true, sessionId: session, workspaceId: 'repo::/project' }
    }
  })
  try {
    const first = fetchLocal(t.nav.port, t.path, { headers: CLICK })
    await until(() => t.orca.state.reads === 1, 'the first click to start')
    const second = await fetchLocal(t.nav.port, t.path, { headers: CLICK })
    assert.equal(second.status, 409)
    assert.match(second.body, /already opening/)
    release()
    assert.equal((await first).status, 200)
    assert.deepEqual(t.orca.state.activated, ['id:repo::/project'])
  } finally {
    await t.nav.stop()
  }
})

test('a chat Orca no longer lists says so, and nothing is opened', async () => {
  const t = await listener()
  try {
    t.orca.state.rows = []
    const reply = await fetchLocal(t.nav.port, t.path, { headers: CLICK })
    assert.equal(reply.status, 404)
    assert.match(reply.body, /This chat is no longer open in Orca\./)
    assert.deepEqual(t.revealer.calls, [])
    assert.deepEqual(t.orca.state.activated, [])
  } finally {
    await t.nav.stop()
  }
})

// ---------------------------------------------------------------------------------------------
// Opening, step by step

const ROW: NavigationTarget = { session: SESSION, worktreeId: 'repo::/project', selector: 'id:repo::/project', folder: false }

test('a chat listed twice, or in a folder workspace, is not opened', async () => {
  for (const rows of [[ROW, { ...ROW, worktreeId: 'repo::/other', selector: 'id:repo::/other' }], [{ ...ROW, folder: true }]]) {
    const orca = fakeCli(rows)
    const revealer = fakeReveal()
    assert.equal(await openChat(SESSION, { cli: () => orca.cli, reveal: revealer.reveal, log: () => undefined }), 'unsupported')
    assert.deepEqual(revealer.calls, [])
    assert.deepEqual(orca.state.activated, [])
  }
})

test('when the chat tab cannot be brought forward, its workspace is opened instead', async () => {
  for (const answer of [
    (): RevealResult => ({ ok: false, reason: 'unsupported Orca layout' }),
    (): RevealResult => ({ ok: true, sessionId: 'another', workspaceId: 'repo::/project' }),
    (): RevealResult => ({ ok: true, sessionId: SESSION, workspaceId: 'repo::/elsewhere' }),
    (): RevealResult => {
      throw new Error('boom')
    }
  ]) {
    const orca = fakeCli()
    const logs: string[] = []
    const outcome = await openChat(SESSION, { cli: () => orca.cli, reveal: fakeReveal(answer).reveal, log: (line) => logs.push(line) })
    assert.equal(outcome, 'workspace')
    assert.deepEqual(orca.state.activated, ['id:repo::/project'])
    assert.ok(logs.some((line) => line.includes('could not bring the chat tab forward')))
  }
  const t = await listener({ reveal: async () => ({ ok: false, reason: 'no' }) })
  try {
    const reply = await fetchLocal(t.nav.port, t.path, { headers: CLICK })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /Opened the workspace; Orca could not bring the chat itself forward\./)
  } finally {
    await t.nav.stop()
  }
})

test('a chat that moves or disappears between the reveal and the activation is not followed', async () => {
  for (const after of [[{ ...ROW, worktreeId: 'repo::/moved', selector: 'id:repo::/moved' }], [], [ROW, ROW], [{ ...ROW, folder: true }]]) {
    const orca = fakeCli()
    orca.state.afterReads = { count: 1, rows: after }
    const outcome = await openChat(SESSION, { cli: () => orca.cli, reveal: fakeReveal().reveal, log: () => undefined })
    assert.equal(outcome, 'moved')
    assert.deepEqual(orca.state.activated, [])
  }
  const orca = fakeCli()
  orca.state.afterReads = { count: 1, rows: [] }
  const failedReveal = fakeReveal(() => ({ ok: false, reason: 'no' }))
  assert.equal(await openChat(SESSION, { cli: () => orca.cli, reveal: failedReveal.reveal, log: () => undefined }), 'gone')
  assert.deepEqual(orca.state.activated, [])
})

test('Orca being unreachable is reported plainly', async () => {
  assert.equal(await openChat(SESSION, { cli: () => null, reveal: fakeReveal().reveal, log: () => undefined }), 'failed')
  const orca = fakeCli()
  orca.cli.navigationTargets = async () => {
    throw new Error('runtime unavailable')
  }
  assert.equal(await openChat(SESSION, { cli: () => orca.cli, reveal: fakeReveal().reveal, log: () => undefined }), 'failed')
  const refusing = fakeCli()
  refusing.state.activateFails = true
  assert.equal(await openChat(SESSION, { cli: () => refusing.cli, reveal: fakeReveal(() => ({ ok: false, reason: 'no' })).reveal, log: () => undefined }), 'failed')
  const revealedOnly = fakeCli()
  revealedOnly.state.activateFails = true
  assert.equal(await openChat(SESSION, { cli: () => revealedOnly.cli, reveal: fakeReveal().reveal, log: () => undefined }), 'chat', 'the chat is already in front')
})

// ---------------------------------------------------------------------------------------------
// Orca's CLI

test('worktree ps rows become navigation targets with an exact selector', () => {
  const pane = (session: string, n = 0) => `structured-agent-session-${session}:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const targets = parseNavigationTargets({
    truncated: false,
    worktrees: [
      { worktreeId: 'repo::/project', workspaceKind: 'git', hostId: null, agents: [{ paneKey: pane('a') }, { paneKey: 'terminal:1' }] },
      { worktreeId: 'folder:f1', workspaceKind: 'folder-workspace', agents: [{ paneKey: pane('b') }] },
      { worktreeId: 'repo::/remote', hostId: 'ssh-1', agents: [{ paneKey: pane('c') }] },
      { worktreeId: 'repo::/two', hostId: 'local', agents: [{ paneKey: pane('a', 1) }] },
      { agents: [{ paneKey: pane('d') }] }
    ]
  })
  assert.deepEqual(targets, [
    { session: 'a', worktreeId: 'repo::/project', selector: 'id:repo::/project', folder: false },
    { session: 'b', worktreeId: 'folder:f1', selector: 'id:folder:f1', folder: true },
    { session: 'a', worktreeId: 'repo::/two', selector: 'id:repo::/two', folder: false }
  ])
  assert.throws(() => parseNavigationTargets({ worktrees: [], truncated: true }))
  assert.throws(() => parseNavigationTargets({}))
})

test('OrcaCli opens a workspace with the public command and says how to start a helper', async () => {
  const orca = fakeOrca()
  const calls: string[][] = []
  const cli = new OrcaCli({
    command: ['/app/Orca', '/app/out/cli/index.js'],
    env: { PATH: '/bin', ORCA_AGENT_SESSION_ID: 'x', NODE_OPTIONS: '--inspect' },
    profile: '/profile',
    exec: async (file, argv, options) => {
      calls.push(argv)
      if (argv.includes('activate')) return { code: 0, stdout: JSON.stringify({ ok: true, result: { worktreeId: 'repo::/project' } }) }
      return orca.exec(file, argv, options)
    }
  })
  assert.equal(await cli.activateWorktree('id:repo::/project'), 'repo::/project')
  assert.deepEqual(calls[0], ['/app/out/cli/index.js', 'worktree', 'activate', '--worktree', 'id:repo::/project', '--environment', 'local', '--json'])
  const launch = cli.launchInfo()
  assert.deepEqual(launch.command, ['/app/Orca', '/app/out/cli/index.js'])
  assert.equal(launch.env.ORCA_USER_DATA_PATH, '/profile')
  assert.equal(launch.env.ORCA_AGENT_SESSION_ID, undefined)
  assert.equal(launch.env.NODE_OPTIONS, undefined)
})

// ---------------------------------------------------------------------------------------------
// The reveal helper

test('the helper’s Orca is found from the CLI on each platform, or not at all', () => {
  const have = (...paths: string[]) => (path: string) => paths.includes(path)
  const mac = '/Apps/Orca.app/Contents'
  assert.deepEqual(
    revealRuntime(['/usr/local/bin/orca'], {
      platform: 'darwin',
      realpath: () => `${mac}/Resources/bin/orca`,
      exists: have(`${mac}/MacOS/Orca`, `${mac}/Resources/app.asar.unpacked/out/cli`, `${mac}/Resources/app.asar.unpacked/out/shared`)
    }),
    { executable: `${mac}/MacOS/Orca`, outDir: `${mac}/Resources/app.asar.unpacked/out` }
  )
  const out = `${mac}/Resources/app.asar.unpacked/out`
  assert.deepEqual(
    revealRuntime([`${mac}/MacOS/Orca`, `${out}/cli/index.js`], { platform: 'darwin', exists: have(`${mac}/MacOS/Orca`, `${out}/cli`, `${out}/shared`) }),
    { executable: `${mac}/MacOS/Orca`, outDir: out }
  )
  const win = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca'
  assert.deepEqual(
    revealRuntime([`${win}\\resources\\bin\\orca.exe`], {
      platform: 'win32',
      realpath: (path) => path,
      exists: have(`${win}\\Orca.exe`, `${win}\\resources\\app.asar.unpacked\\out\\cli`, `${win}\\resources\\app.asar.unpacked\\out\\shared`)
    }),
    { executable: `${win}\\Orca.exe`, outDir: `${win}\\resources\\app.asar.unpacked\\out` }
  )
  const linux = '/opt/Orca'
  assert.deepEqual(
    revealRuntime(['/usr/bin/orca-ide'], {
      platform: 'linux',
      realpath: () => `${linux}/resources/bin/orca-ide`,
      exists: have(`${linux}/orca-ide`, `${linux}/resources/app.asar.unpacked/out/cli`, `${linux}/resources/app.asar.unpacked/out/shared`)
    }),
    { executable: `${linux}/orca-ide`, outDir: `${linux}/resources/app.asar.unpacked/out` }
  )
  // An `orca` on PATH that is not Orca's launcher, a missing app folder, or an odd command.
  assert.equal(revealRuntime(['/usr/local/bin/orca'], { platform: 'darwin', realpath: (path) => path, exists: () => true }), null)
  assert.equal(revealRuntime(['/usr/local/bin/orca'], { platform: 'darwin', realpath: () => `${mac}/Resources/bin/orca`, exists: have(`${mac}/MacOS/Orca`) }), null)
  assert.equal(revealRuntime(['node', 'script.js', 'x'], { exists: () => true }), null)
  assert.equal(revealRuntime(['/x/orca'], { realpath: () => { throw new Error('ENOENT') }, exists: () => true }), null)
})

test('the helper runs with Orca’s executable in Node mode, the same profile, and no NODE_OPTIONS', async () => {
  const runs: { file: string; args: string[]; env: Record<string, string | undefined>; input: string }[] = []
  let answer = { code: 0, stdout: JSON.stringify({ ok: true, result: { sessionId: SESSION, workspaceId: 'repo::/project' } }) }
  const run: HelperRun = async (file, args, options) => {
    runs.push({ file, args, env: options.env, input: options.input })
    return answer
  }
  const cli: NavigationCli = {
    navigationTargets: async () => [],
    activateWorktree: async () => null,
    launchInfo: () => ({ command: ['/app/Orca', '/app/out/cli/index.js'], env: { ORCA_USER_DATA_PATH: '/profile', NODE_OPTIONS: '--require x' } })
  }
  const reveal = helperReveal({ run, runtime: () => ({ executable: '/app/Orca', outDir: '/app/out' }) })
  assert.deepEqual(await reveal(SESSION, cli), { ok: true, sessionId: SESSION, workspaceId: 'repo::/project' })
  assert.equal(runs[0]!.file, '/app/Orca')
  assert.deepEqual(runs[0]!.args, [REVEAL_HELPER, '/app/out'])
  assert.equal(runs[0]!.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(runs[0]!.env.ORCA_USER_DATA_PATH, '/profile')
  assert.ok(!('NODE_OPTIONS' in runs[0]!.env))
  assert.deepEqual(JSON.parse(runs[0]!.input), { sessionId: SESSION })

  answer = { code: 1, stdout: JSON.stringify({ ok: false, error: 'Orca lacks agent-session.structured.reveal.v1' }) }
  assert.deepEqual(await reveal(SESSION, cli), { ok: false, reason: 'Orca lacks agent-session.structured.reveal.v1' })
  answer = { code: 0, stdout: 'not json' }
  assert.equal((await reveal(SESSION, cli)).ok, false)
  answer = { code: 0, stdout: JSON.stringify({ ok: true, result: {} }) }
  assert.equal((await reveal(SESSION, cli)).ok, false)
  const throwing = helperReveal({ run: async () => { throw new Error('the helper took too long') }, runtime: () => ({ executable: '/a', outDir: '/b' }) })
  assert.deepEqual(await throwing(SESSION, cli), { ok: false, reason: 'the helper took too long' })
  assert.deepEqual(await helperReveal({ run, runtime: () => null })(SESSION, cli), { ok: false, reason: 'unsupported Orca layout' })
  assert.equal((await reveal(SESSION, { navigationTargets: async () => [], activateWorktree: async () => null })).ok, false)
})

/** Stand-in Orca app files, shaped like the real `app.asar.unpacked/out`, for the real helper. */
async function fakeOrcaApp(behaviour: { capabilities?: readonly string[]; reveal?: unknown; schemaRejects?: boolean; noClient?: boolean }) {
  const out = join(await tempDir('orca-nav-app-'), 'out')
  await mkdir(join(out, 'cli', 'runtime'), { recursive: true })
  await mkdir(join(out, 'shared', 'rpc-contract', 'structured-agent-session'), { recursive: true })
  if (!behaviour.noClient) {
    await writeFile(
      join(out, 'cli', 'runtime', 'client.js'),
      `'use strict'
const fs = require('node:fs')
class RuntimeClient {
  constructor(userDataPath, timeout, pairing, environment) { this.args = [userDataPath, timeout, pairing, environment] }
  get isRemote() { return this.args[2] !== null || this.args[3] !== null }
  async call(method, params) {
    fs.appendFileSync(${JSON.stringify(join(out, 'calls.log'))}, JSON.stringify({ method, params, profile: process.env.ORCA_USER_DATA_PATH }) + '\\n')
    if (method === 'status.get') return { ok: true, result: { capabilities: ${JSON.stringify(behaviour.capabilities ?? ['agent-session.structured.v1', 'agent-session.structured.reveal.v1'])} } }
    if (method === 'agentSession.reveal') return { ok: true, result: ${JSON.stringify(behaviour.reveal ?? null)} ?? { ok: true, sessionId: params.sessionId, workspaceId: 'repo::/project', agent: 'codex', readable: true } }
    throw new Error('unexpected ' + method)
  }
}
exports.RuntimeClient = RuntimeClient
`
    )
  }
  await writeFile(
    join(out, 'shared', 'rpc-contract', 'structured-agent-session', 'structured-agent-session-params.js'),
    `'use strict'
exports.RevealParams = { safeParse: (value) => (${behaviour.schemaRejects ? 'true' : 'false'} ? { success: false } : { success: true, data: value }) }
`
  )
  const calls = async (): Promise<{ method: string; params: unknown; profile?: string }[]> =>
    (await readFile(join(out, 'calls.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { out, calls }
}

test('the real helper asks for exactly one reveal after checking capabilities and the schema', async () => {
  const app = await fakeOrcaApp({})
  const cli: NavigationCli = {
    navigationTargets: async () => [],
    activateWorktree: async () => null,
    launchInfo: () => ({ command: [process.execPath, join(app.out, 'cli', 'index.js')], env: { ...process.env, ORCA_USER_DATA_PATH: '/the/profile' } })
  }
  const reveal = helperReveal({ runtime: () => ({ executable: process.execPath, outDir: app.out }) })
  assert.deepEqual(await reveal(SESSION, cli), { ok: true, sessionId: SESSION, workspaceId: 'repo::/project' })
  assert.deepEqual(await app.calls(), [
    { method: 'status.get', params: {}, profile: '/the/profile' },
    { method: 'agentSession.reveal', params: { sessionId: SESSION }, profile: '/the/profile' }
  ])

  for (const [behaviour, why] of [
    [{ capabilities: ['agent-session.structured.v1'] }, /agent-session\.structured\.reveal\.v1/],
    [{ reveal: { ok: true, sessionId: 'another', workspaceId: 'repo::/project' } }, /another chat/],
    [{ reveal: { ok: false, refusal: { code: 'agent_session_not_found' } } }, /refused/],
    [{ schemaRejects: true }, /schema changed/],
    [{ noClient: true }, /not found/]
  ] as const) {
    const other = await fakeOrcaApp(behaviour)
    const result = await helperReveal({ runtime: () => ({ executable: process.execPath, outDir: other.out }) })(SESSION, cli)
    assert.equal(result.ok, false)
    assert.match((result as { reason: string }).reason, why)
    if ('capabilities' in behaviour || 'schemaRejects' in behaviour) {
      assert.ok(!(await other.calls()).some((call) => call.method === 'agentSession.reveal'), 'nothing is revealed')
    }
  }
})

test('the helper refuses bad input and a runaway helper is stopped', async () => {
  const app = await fakeOrcaApp({})
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const bad = await runHelper(process.execPath, [REVEAL_HELPER, app.out], { env, input: JSON.stringify({ sessionId: 'a b' }), timeoutMs: 10_000 })
  assert.equal(bad.code, 1)
  assert.match(JSON.parse(bad.stdout).error, /invalid session id/)
  const relative = await runHelper(process.execPath, [REVEAL_HELPER, 'out'], { env, input: JSON.stringify({ sessionId: SESSION }), timeoutMs: 10_000 })
  assert.equal(relative.code, 1)
  assert.deepEqual(await app.calls(), [])
  await assert.rejects(runHelper(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { env, input: '', timeoutMs: 200 }), /too long/)
})
