// Every agent Plannotator supports: the Inbox routes that list and connect them, and how their
// answers merge with the plugin's own writer for Claude Code, Codex and OpenCode.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { allAgentLinks, connectAllAgents, disconnectAllAgents, linkFromRow, otherAgentLinks, type AgentInbox, type ConnectDeps } from '../src/connect'
import { InboxClient, InboxContractError, InboxUnavailable, parseOrcaAgentRow, parseStockAgentRow, type InboxAgentRow } from '../src/inbox'
import type { AgentLink } from '../src/protocol'
import { fakeInbox, memoryStore, tempDir } from './fakes'

const LAUNCHER = '/Users/someone/.orca-plannotator-inbox/inbox-mcp'
const OWN = ['claude-code', 'codex', 'opencode']

const row = (id: string, label: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, label, detected: true, state, reason: null, path: null, ...extra
})

function client(inbox: ReturnType<typeof fakeInbox>): InboxClient {
  return new InboxClient('/data', { fetch: inbox.fetch, readRegistry: inbox.readRegistry })
}

async function home(): Promise<{ deps: ConnectDeps; codex: string }> {
  const dir = await tempDir()
  await mkdir(join(dir, '.codex'), { recursive: true })
  return { deps: { home: dir, env: { PATH: '/nowhere' }, launcher: LAUNCHER, store: memoryStore(), find: () => null }, codex: join(dir, '.codex', 'config.toml') }
}

// ------------------------------------------------------------------------------- the client

test('client: the Orca build’s list is read with the token, without an Origin, and parsed defensively', async () => {
  const inbox = fakeInbox()
  inbox.state.features = ['agents']
  inbox.state.orcaAgents = [
    row('gemini', 'Gemini CLI', 'orca'),
    row('qwen', 'Qwen Code', 'a-state-from-the-future', { reason: 'x'.repeat(2000) }),
    row('cursor', 'Cursor\nIDE', 'manual', { reason: 'Add it in Cursor’s MCP settings.', path: '~/.cursor/mcp.json' }),
    { id: 'no good id!', label: 'Bad', detected: true, state: 'orca' },
    'not a row' as unknown as Record<string, unknown>,
    row('gemini', 'Gemini again', 'absent')
  ]
  const rows = await client(inbox).orcaAgents()
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['gemini', 'orca'], ['qwen', 'other'], ['cursor', 'manual']], 'an unknown state reads as other; bad rows and a second row for one id are dropped')
  assert.equal(rows[1]!.reason!.length, 500, 'a long reason is cut')
  assert.equal(rows[2]!.label, 'Cursor IDE', 'control characters are flattened')
  assert.equal(rows[2]!.path, '~/.cursor/mcp.json')
  const [call] = inbox.state.agentCalls.filter((c) => c.path === '/api/inbox/control/orca-agents')
  assert.deepEqual([call!.method, call!.token, call!.origin], ['GET', true, false])

  inbox.state.orcaAgents = Array.from({ length: 500 }, (_, index) => row(`agent${index}`, `Agent ${index}`, 'absent'))
  assert.equal((await client(inbox).orcaAgents()).length, 64, 'the number of rows is capped')
})

test('client: an answer of the wrong shape is a contract error', async () => {
  for (const answer of [{ v: 2, agents: [] }, { v: 1, agents: {} }, { v: 1 }]) {
    const fetchImpl = (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch
    const inbox = fakeInbox()
    await assert.rejects(new InboxClient('/data', { fetch: fetchImpl, readRegistry: inbox.readRegistry }).orcaAgents(), InboxContractError, JSON.stringify(answer))
  }
  const fetchImpl = (async () => new Response(JSON.stringify({ v: 1, agents: 'no', changed: [], problems: [] }), { status: 200 })) as typeof fetch
  await assert.rejects(new InboxClient('/data', { fetch: fetchImpl, readRegistry: fakeInbox().readRegistry }).orcaAgentsAction('connect', OWN), InboxContractError)
})

test('client: a connect posts the action and the agents to leave alone, and reads changes and problems', async () => {
  const inbox = fakeInbox()
  inbox.state.orcaAgents = [row('gemini', 'Gemini CLI', 'absent'), row('codex', 'Codex', 'absent')]
  inbox.state.orcaAnswer = () => ({ problems: [{ agent: 'kiro', reason: 'Kiro’s settings are not JSON.' }, { agent: 7, reason: 'dropped' }], skipped: 'nonsense' })
  const answer = await client(inbox).orcaAgentsAction('connect', OWN)
  assert.deepEqual(answer.changed, ['gemini'])
  assert.deepEqual(answer.problems, [{ agent: 'kiro', reason: 'Kiro’s settings are not JSON.' }])
  assert.equal(answer.skipped, null)
  const [call] = inbox.state.agentCalls.filter((c) => c.method === 'POST')
  assert.deepEqual(call!.body, { action: 'connect', except: OWN })
  assert.deepEqual([call!.token, call!.origin], [true, false])
})

test('client: standard Plannotator’s rows and connect report read in the Orca build’s words', async () => {
  const stock = (id: string, kind: string, state: string, reason: string | null = null) => ({ id, label: id.toUpperCase(), detected: true, reach: { kind, on: true, state, path: null, locked: false, reason } })
  const cases: [Record<string, unknown>, string][] = [
    [stock('gemini', 'mcp', 'connected'), 'plannotator'],
    [stock('pi', 'tool', 'connected'), 'tool'],
    [stock('amp', 'mcp', 'off'), 'off'],
    [stock('cline', 'mcp', 'foreign'), 'other'],
    [stock('cursor', 'manual', 'manual', 'Copy it by hand.'), 'manual'],
    [stock('kiro', 'mcp', 'not_connected'), 'absent'],
    [stock('qwen', 'mcp', 'unreadable', 'Not JSON.'), 'unreadable'],
    [stock('hermes', 'mcp', 'something-new'), 'other']
  ]
  for (const [value, state] of cases) assert.equal(parseStockAgentRow(value)?.state, state, JSON.stringify(value))
  assert.equal(parseStockAgentRow(stock('cursor', 'manual', 'manual', 'Copy it by hand.'))?.reason, 'Copy it by hand.')
  assert.equal(parseStockAgentRow({ label: 'no id' }), null)
  assert.equal(parseOrcaAgentRow({ id: 'x', state: 'orca' })?.label, 'x', 'a missing label is the id')

  const inbox = fakeInbox()
  inbox.state.stockAgents = cases.map(([value]) => value)
  assert.equal((await client(inbox).stockAgents()).length, cases.length)
  assert.deepEqual(inbox.state.agentCalls.at(-1), { method: 'GET', path: '/api/inbox/agents', body: {}, token: false, origin: false })

  inbox.state.stockReport = { added: ['gemini', 'codex'], failed: [{ agent: 'kiro', reason: 'Timed out.', path: null }], manual_why: [{ agent: 'cursor', why: 'Cursor has no CLI to add it.' }], skipped: 'env' }
  const report = await client(inbox).stockConnect()
  assert.deepEqual(report, { changed: ['gemini', 'codex'], problems: [{ agent: 'kiro', reason: 'Timed out.' }], manual: [{ agent: 'cursor', reason: 'Cursor has no CLI to add it.' }], skipped: 'env' })
  const post = inbox.state.agentCalls.at(-1)!
  assert.deepEqual([post.method, post.path, post.token, post.origin], ['POST', '/api/inbox/control/connect', true, false])
})

// ------------------------------------------------------------------------------ the list

test('status list: the three, then every other agent found; agents not on this computer are not listed', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const inbox = fakeInbox()
  inbox.state.features = ['agents']
  inbox.state.orcaAgents = [
    row('claude-code', 'Claude Code', 'absent'),
    row('codex', 'Codex', 'orca'),
    row('gemini', 'Gemini CLI', 'orca'),
    row('cursor', 'Cursor', 'manual', { reason: 'Add it in Cursor’s MCP settings.' }),
    row('amp', 'Amp', 'absent', { detected: false }),
    row('kiro', 'Kiro', 'unreadable', { reason: 'Not JSON.' })
  ]
  const links = await allAgentLinks(deps, client(inbox))
  assert.deepEqual(links.map((link) => [link.agent, link.state]), [
    ['claude', 'missing'], ['codex', 'absent'], ['opencode', 'missing'],
    ['gemini', 'connected'], ['cursor', 'manual'], ['kiro', 'other']
  ])
  assert.equal(links.find((link) => link.agent === 'cursor')!.detail, 'Add it in Cursor’s MCP settings.')
  assert.equal(links.find((link) => link.agent === 'kiro')!.detail, 'Its settings cannot be read: Not JSON.')
  assert.ok(inbox.state.agentCalls.every((call) => call.method === 'GET'), 'a status look only reads')

  // The Inbox stops answering: the other agents of the last good read stand.
  inbox.state.up = false
  assert.deepEqual((await allAgentLinks(deps, client(inbox), links)).map((link) => link.agent), links.map((link) => link.agent))
  // It never answered: only the three.
  assert.deepEqual((await allAgentLinks(deps, client(inbox))).map((link) => link.agent), ['claude', 'codex', 'opencode'])
})

test('status list: standard Plannotator’s own connections show as not replying to Orca chats; a Plannotator without the list adds none', async () => {
  const inbox = fakeInbox()
  inbox.state.stockAgents = [
    { id: 'gemini', label: 'Gemini CLI', detected: true, reach: { kind: 'mcp', state: 'connected', path: null, reason: null } },
    { id: 'opencode', label: 'OpenCode', detected: true, reach: { kind: 'tool', state: 'connected', path: null, reason: null } }
  ]
  const links = await otherAgentLinks(client(inbox))
  assert.deepEqual(links.map((link) => [link.agent, link.state]), [['gemini', 'plannotator']])
  assert.match(links[0]!.detail, /Connected by Plannotator\. Replies come back into Orca chats once the Orca build runs the Inbox/)

  inbox.state.stockAgents = null
  assert.deepEqual(await otherAgentLinks(client(inbox)), [])
})

test('linkFromRow: each state becomes one the panel knows', () => {
  const states: [InboxAgentRow['state'], AgentLink['state']][] = [
    ['orca', 'connected'], ['plannotator', 'plannotator'], ['tool', 'builtin'], ['off', 'off'],
    ['other', 'other'], ['manual', 'manual'], ['absent', 'absent'], ['unreadable', 'other']
  ]
  for (const [from, to] of states) {
    const link = linkFromRow({ id: 'x', label: 'X', detected: true, state: from, reason: null, path: null }, 'orca')
    assert.equal(link.state, to, from)
    assert.ok(link.detail.length > 0)
  }
})

// ----------------------------------------------------------------------------- the merge

test('connect with the Orca build: the three first, then the route, in one short message', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const inbox = fakeInbox()
  inbox.state.features = ['agents', 'faces']
  inbox.state.orcaAgents = [row('codex', 'Codex', 'absent'), row('gemini', 'Gemini CLI', 'absent'), row('qwen', 'Qwen Code', 'plannotator'), row('cursor', 'Cursor', 'manual')]
  inbox.state.orcaAnswer = () => ({ problems: [{ agent: 'kiro', reason: 'Kiro’s settings are not JSON' }, { agent: 'cline', reason: 'Kiro’s settings are not JSON' }, { agent: 'codex', reason: 'not ours to say' }] })
  inbox.state.orcaAgents.push(row('kiro', 'Kiro', 'unreadable'), row('cline', 'Cline', 'unreadable'))
  const result = await connectAllAgents(deps, client(inbox))
  assert.deepEqual(result, {
    ok: false,
    message: 'Connected Codex, Gemini CLI and Qwen Code. It applies to chats started from now on. Kiro and Cline: Kiro’s settings are not JSON.'
  })
  assert.ok((await readFile(codex, 'utf8')).includes(LAUNCHER), 'Codex by the plugin’s own writer')
  assert.equal(inbox.state.orcaAgents.find((r) => r.id === 'codex')!.state, 'absent', 'the route left Codex alone')
  const post = inbox.state.agentCalls.find((call) => call.method === 'POST')!
  assert.deepEqual(post.body, { action: 'connect', except: OWN })

  // Nothing left to do.
  inbox.state.orcaAnswer = null
  assert.deepEqual(await connectAllAgents(deps, client(inbox)), { ok: true, message: 'Every agent found is already connected.' })

  // Disconnect: the three, then the route's disconnect.
  assert.deepEqual(await disconnectAllAgents(deps, client(inbox)), { ok: true, message: 'Disconnected Codex, Gemini CLI and Qwen Code.' })
  assert.equal(await readFile(codex, 'utf8'), '\n')
  assert.equal(inbox.state.agentCalls.filter((call) => call.method === 'POST').at(-1)!.body.action, 'disconnect')
})

test('connect with standard Plannotator: the three, then Plannotator connects the rest its own way', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const inbox = fakeInbox()
  inbox.state.stockReport = {
    added: ['gemini', 'codex'],
    failed: [{ agent: 'kiro', reason: 'Timed out', path: null }],
    manual_why: [{ agent: 'cursor', why: 'Cursor has no CLI to add it.' }, { agent: 'opencode', why: 'not shown' }]
  }
  const known: AgentLink[] = [{ agent: 'gemini', name: 'Gemini CLI', state: 'absent', detail: '' }, { agent: 'cursor', name: 'Cursor', state: 'manual', detail: '' }]
  const after: AgentLink[] = [{ ...known[0]!, state: 'plannotator' }, known[1]!]
  const result = await connectAllAgents(deps, client(inbox), { known })
  assert.deepEqual(result, {
    ok: false,
    message:
      'Connected Codex. It applies to chats started from now on. kiro: Timed out. Cursor: Cursor has no CLI to add it. ' +
      'Plannotator connected Gemini CLI its own way: replies to it come back into Orca chats once the Orca build runs the Inbox and you connect again.'
  })
  assert.ok(!inbox.state.agentCalls.some((call) => call.path === '/api/inbox/control/orca-agents'), 'no Orca build route was asked for')

  const off = await disconnectAllAgents(deps, client(inbox), { known: after })
  assert.equal(off.ok, true)
  assert.equal(off.message, 'Disconnected Codex. Other agents keep the entries standard Plannotator wrote for them; turn those off in Plannotator’s Settings.')
  assert.equal(inbox.state.agentCalls.filter((call) => call.method === 'POST').length, 1, 'disconnect asks standard Plannotator nothing')
  // With no such entry known, nothing is said about them.
  assert.deepEqual(await disconnectAllAgents(deps, client(inbox), { known }), { ok: true, message: 'Nothing was connected by this plugin.' })
})

test('connect with an Orca build from before the agents route: its own connect writes the launcher, and says what waits', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const inbox = fakeInbox()
  inbox.state.features = ['mark-faces', 'launch-hosts']
  inbox.state.stockReport = { added: ['cursor'], failed: [], manual_why: [] }
  const known: AgentLink[] = [{ agent: 'cursor', name: 'Cursor', state: 'absent', detail: '' }, { agent: 'antigravity', name: 'Antigravity', state: 'plannotator', detail: '' }]
  const result = await connectAllAgents(deps, client(inbox), { known })
  assert.deepEqual(result, {
    ok: true,
    message:
      'Connected Codex and Cursor. It applies to chats started from now on. ' +
      'The Orca build in use is older than this plugin, or a reduced one without moving agents: an agent that already ran Plannotator directly is moved to the launcher when you connect again once a full build is in use.'
  })
  assert.ok(!inbox.state.agentCalls.some((call) => call.path === '/api/inbox/control/orca-agents'), 'the route this build lacks was not asked for')
  const off = await disconnectAllAgents(deps, client(inbox), { known })
  assert.match(off.message, /older than this plugin, or a reduced one without moving agents\. Disconnect again once a full build is in use\./)
})

test('connect while the Inbox is down: the three, and a word about the rest', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const inbox = fakeInbox()
  inbox.state.up = false
  const result = await connectAllAgents(deps, client(inbox))
  assert.deepEqual(result, { ok: true, message: 'Connected Codex. It applies to chats started from now on. The other agents are connected once the Inbox runs: open it, then connect again.' })
  assert.deepEqual(await disconnectAllAgents(deps, null), { ok: true, message: 'Disconnected Codex. Other agents are left as they are while the Inbox is not running.' })
  assert.equal(existsSync(join(deps.home, '.gemini')), false)
})

test('a route that fails or answers nonsense is one problem; one named agent skips the Inbox', async () => {
  const { deps, codex } = await home()
  await writeFile(codex, '')
  const broken: AgentInbox = {
    orcaFeatures: async () => ['agents'],
    orcaAgents: async () => [],
    orcaAgentsAction: async () => {
      throw new InboxContractError('The Inbox answered the agent connect in an unknown version.')
    },
    stockAgents: async () => [],
    stockConnect: async () => ({ changed: [], problems: [], manual: [], skipped: null })
  }
  const result = await connectAllAgents(deps, broken)
  assert.deepEqual(result, { ok: false, message: 'Connected Codex. It applies to chats started from now on. Other agents: The Inbox answered the agent connect in an unknown version.' })

  let asked = 0
  const counting: AgentInbox = { ...broken, orcaFeatures: async () => (asked++, ['agents']) }
  assert.deepEqual(await disconnectAllAgents(deps, counting, { agent: 'codex' }), { ok: true, message: 'Disconnected Codex.' })
  assert.equal(asked, 0)

  const skipped: AgentInbox = { ...broken, orcaAgentsAction: async () => ({ agents: [], changed: [], problems: [], skipped: 'env' }) }
  assert.match((await connectAllAgents(deps, skipped)).message, /PLANNOTATOR_INBOX_CONNECT=0/)

  // The built route answers 503 { error } when the Orca config cannot be used: said, not taken for a stopped Inbox.
  const inbox = fakeInbox()
  inbox.state.features = ['agents']
  inbox.state.orcaAgents = []
  const realFetch = inbox.fetch
  const fetch503 = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === '/api/inbox/control/orca-agents' && init?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'The Orca config can’t be used: no mcpCommand.' }), { status: 503 })
      : realFetch(input, init)) as typeof fetch
  const via503 = new InboxClient('/data', { fetch: fetch503, readRegistry: inbox.readRegistry })
  assert.equal((await connectAllAgents(deps, via503)).ok, false)
  assert.match((await connectAllAgents(deps, via503)).message, /Other agents: The Plannotator Inbox failed \(503\): The Orca config can’t be used: no mcpCommand\./)
  assert.ok(!(await disconnectAllAgents(deps, via503)).message.includes('not running'))

  const down: AgentInbox = { ...broken, orcaFeatures: async () => { throw new InboxUnavailable('The Plannotator Inbox is not answering.') } }
  assert.match((await connectAllAgents(deps, down)).message, /once the Inbox runs/)
})
