// The launcher's wrapper, as a library and as the real child process an agent would start.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ORCA_NOTE,
  REFUSALS,
  agentName,
  annotate,
  createProver,
  enrich,
  linkFooter,
  nativeSession,
  outsideBlocks,
  readProof,
  receipts,
  withinProjects,
  workerDelivers
} from '../bin/inbox-mcp.mjs'

const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))
const POSIX = process.platform !== 'win32'
const SESSION = 'codex_1b491d4a_6f38'
const OTHER = 'claude_99999999_0000'
const CHAT = { ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1' }
const ROUTING = ['agent_host', 'agent_session', 'agent_name', 'project_path']
const FIELDS = {
  send_message: ROUTING,
  submit_guide: ROUTING,
  card: ROUTING,
  read_thread: ['agent_session'],
  search: []
}
/** Plannotator's current read and search tools, which also take a project. */
const SCOPED = { ...FIELDS, read_thread: ['agent_session', 'project_path'], search: ['project_path'] }
const REPO = '/work/repo'
const WORKTREE = '/work/repo-worktrees/feature'
const PROOF = { session: SESSION, project: REPO, working: WORKTREE, roots: [REPO, WORKTREE] }
const MARKER = '<!-- plannotator-orca-session-link:v1 -->'
const FOOTER = `\n\n${MARKER}\n[Open in Orca](http://127.0.0.1:4242/open/x.y)\n`
const context = (overrides = {}) => ({
  name: 'Codex',
  proof: PROOF,
  delivering: () => true,
  fieldsOf: (tool) => FIELDS[tool] ?? [],
  footer: () => FOOTER,
  ...overrides
})
const call = (name, args, meta) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }), ...(meta ? { _meta: meta } : {}) } })
const WAKE = 'ai.plannotator/inbox-wakes'
const WORKING = 'ai.plannotator/working-folder'

test('only a local native Orca chat is treated as one', () => {
  assert.equal(nativeSession(CHAT), SESSION)
  assert.equal(nativeSession({ ...CHAT, ORCA_AGENT_SESSION_ID: `orca_session_id:${SESSION}` }), SESSION)
  assert.equal(nativeSession({ ORCA_AGENT_SESSION_ID: SESSION }), null, 'a terminal agent')
  assert.equal(nativeSession({}), null)
  assert.equal(nativeSession({ ...CHAT, SSH_CONNECTION: '1.2.3.4 22' }), null)
  assert.equal(nativeSession({ ...CHAT, WSL_DISTRO_NAME: 'Ubuntu' }), null)
  assert.equal(nativeSession({ ...CHAT, ORCA_PAIRING_CODE: 'abc' }), null)
  assert.equal(nativeSession({ ...CHAT, ORCA_ENVIRONMENT: 'paired-host' }), null)
  assert.equal(nativeSession({ ...CHAT, ORCA_AGENT_SESSION_ID: 'bad id' }), null)
  assert.equal(agentName({ ORCA_AGENT_SESSION_ID: 'claude_abc' }), 'Claude')
  assert.equal(agentName({ ORCA_AGENT_SESSION_ID: 'mystery_abc' }), null)
})

test('the proven chat becomes the author, with its project and working folder', () => {
  const message = call('send_message', { body: 'Hello' })
  const result = enrich(message, context())
  assert.equal(result.changed, true)
  assert.equal(result.authored, true)
  assert.deepEqual(message.params.arguments, { body: `Hello${FOOTER}`, agent_host: 'orca', agent_session: SESSION, agent_name: 'Codex', project_path: REPO })
  assert.deepEqual(message.params._meta, { [WORKING]: WORKTREE, [WAKE]: true })
})

test('the working folder is sent only when it differs from the repository root, and never with an explicit project', () => {
  const same = call('send_message', { body: 'Hi' })
  enrich(same, context({ proof: { ...PROOF, working: REPO, roots: [REPO] } }))
  assert.deepEqual(same.params._meta, { [WAKE]: true })
  const explicit = call('submit_guide', { body: 'Guide', project_path: WORKTREE })
  enrich(explicit, context())
  assert.equal(explicit.params.arguments.project_path, WORKTREE)
  assert.deepEqual(explicit.params._meta, { [WAKE]: true })
  const own = call('send_message', { body: 'Hi' }, { [WORKING]: '/agent/said' })
  enrich(own, context())
  assert.equal(own.params._meta[WORKING], '/agent/said', 'the agent’s own working folder is kept')
})

test('an agent that names its own host, as Plannotator’s connect prompt tells it to, still sends as the chat', () => {
  const message = call('send_message', { body: 'Hi', agent_host: 'codex', agent_name: 'Codex (work)', idempotency_key: 'plannotator-inbox-connect-v1-codex' }, { progressToken: 7 })
  enrich(message, context({ footer: () => null }))
  assert.equal(message.params.arguments.agent_host, 'orca')
  assert.equal(message.params.arguments.agent_session, SESSION)
  assert.equal(message.params.arguments.agent_name, 'Codex (work)', 'its own name is kept')
  assert.equal(message.params.arguments.idempotency_key, 'plannotator-inbox-connect-v1-codex')
  assert.deepEqual(message.params._meta, { progressToken: 7, [WORKING]: WORKTREE, [WAKE]: true })
})

test('a call that names another session is refused, not rewritten; both spellings of this chat are accepted', () => {
  for (const named of [OTHER, 'thread-123', `orca_session_id:${OTHER}`, '', 42]) {
    const message = call('send_message', { body: 'Hi', agent_session: named })
    const before = structuredClone(message)
    assert.deepEqual(enrich(message, context()), { refusal: REFUSALS.session }, String(named))
    assert.deepEqual(message, before, 'nothing changed')
  }
  const spelled = call('send_message', { body: 'Hi', agent_session: `orca_session_id:${SESSION}` })
  enrich(spelled, context())
  assert.equal(spelled.params.arguments.agent_session, `orca_session_id:${SESSION}`, 'the agent’s spelling is kept')
  assert.equal(spelled.params._meta[WAKE], true)
})

test('a project that is not one of the chat’s folders is refused; a query’s project is only a scope', () => {
  for (const project of ['/another/repo', '/work/repo-other', '/work', 'relative/path', 7]) {
    const message = call('send_message', { body: 'Hi', project_path: project })
    const answer = enrich(message, context())
    assert.ok(answer.refusal, String(project))
    assert.match(answer.refusal, /project_path is not this Orca chat's project/)
    assert.ok(answer.refusal.includes(REPO) && answer.refusal.includes(WORKTREE), 'it names the chat’s own folders')
  }
  const card = call('card', { op: 'add', project_path: '/another/repo' })
  assert.ok(enrich(card, context({ freeze: undefined })).refusal)

  const scoped = context({ fieldsOf: (tool) => SCOPED[tool] ?? [] })
  const read = call('read_thread', { project_path: '/another/repo' })
  enrich(read, scoped)
  assert.deepEqual(read.params.arguments, { project_path: '/another/repo', agent_session: SESSION })
  const search = call('search', { query: 'x', project_path: '/another/repo' })
  assert.equal(enrich(search, scoped).changed, false)
})

test('reading tools get the session and project only when none was given; tools without identity are untouched', () => {
  const mine = call('read_thread', {})
  enrich(mine, context())
  assert.deepEqual(mine.params.arguments, { agent_session: SESSION })
  assert.equal(mine.params._meta, undefined)

  const withProject = context({ fieldsOf: (tool) => SCOPED[tool] ?? [] })
  const scoped = call('read_thread', {})
  enrich(scoped, withProject)
  assert.deepEqual(scoped.params.arguments, { agent_session: SESSION, project_path: REPO })
  assert.equal(scoped.params._meta, undefined, 'reading never wakes and has no working folder')

  const other = call('read_thread', { agent_session: 'another', thread_id: 't' })
  assert.equal(enrich(other, withProject).changed, false, 'asking about another session is allowed')
  assert.deepEqual(other.params.arguments, { agent_session: 'another', thread_id: 't' })

  const everywhere = call('search', { query: 'x', all_projects: true })
  assert.equal(enrich(everywhere, withProject).changed, false)
  const here = call('search', { query: 'x' })
  enrich(here, withProject)
  assert.deepEqual(here.params.arguments, { query: 'x', project_path: REPO })

  const search = call('search', { query: 'x' })
  assert.equal(enrich(search, context()).changed, false)
  assert.deepEqual(search, call('search', { query: 'x' }))
})

test('a wake claim from the agent is always removed; only messages wake', () => {
  const plain = call('search', { query: 'x' }, { [WAKE]: true, keep: 1 })
  assert.equal(enrich(plain, context()).changed, true)
  assert.deepEqual(plain.params._meta, { keep: 1 })
  const reading = call('read_thread', {}, { [WAKE]: true })
  enrich(reading, context())
  assert.deepEqual(reading.params._meta, {})
  const card = call('card', { op: 'add' }, { [WAKE]: true })
  enrich(card, context())
  assert.equal(card.params.arguments.agent_host, 'orca')
  assert.equal(card.params._meta[WAKE], undefined, 'a card does not wake the chat')
})

test('without proof, or while the plugin is not delivering, the call is Plannotator’s own', () => {
  for (const ctx of [context({ proof: null }), context({ delivering: () => false })]) {
    const message = call('send_message', { body: 'Hello', agent_host: 'codex', agent_session: OTHER, project_path: '/x' }, { [WAKE]: true })
    assert.deepEqual(enrich(message, ctx), { changed: false, authored: false })
    assert.deepEqual(message, call('send_message', { body: 'Hello', agent_host: 'codex', agent_session: OTHER, project_path: '/x' }, { [WAKE]: true }))
  }
})

test('the footer goes only where the person can see it, and never twice', () => {
  const footed = (body) => {
    const message = call('send_message', { body })
    enrich(message, context())
    return message.params.arguments.body
  }
  assert.equal(footed('Plain.'), `Plain.${FOOTER}`)
  assert.equal(footed(':::question\nChoose?\n- [ ] A\n:::'), `:::question\nChoose?\n- [ ] A\n:::${FOOTER}`)
  assert.equal(footed('```markdown\n:::question\nexample\n```\nProse.'), `\`\`\`markdown\n:::question\nexample\n\`\`\`\nProse.${FOOTER}`)
  for (const body of [':::question\nUnclosed?', ':::question-multi pick\nA', '```js\nopen code', '~~~\ncode', '````\n```\nstill open', ':::question\nNested\n:::question\nx\n:::', `Done.${FOOTER}`, 'See [Open in Orca](http://127.0.0.1:9/open/abc)']) {
    assert.equal(footed(body), body, body)
  }
  assert.equal(outsideBlocks('a\r\n```\r\nb\r\n```\r\n'), true)
  const guide = call('submit_guide', { body: 'Guide' })
  enrich(guide, context())
  assert.equal(guide.params.arguments.body, 'Guide', 'only send_message gets a footer')
})

// --- Files the worker keeps in the launcher folder ---------------------------------------------

const KEY = 'a1'.repeat(32)
function linkFolder({ key = `${KEY}\n`, navigation = { v: 1, port: 4321, pid: 99, at: Date.now() } } = {}) {
  const shared = mkdtempSync(join(tmpdir(), 'orca-plannotator-link-'))
  if (key !== null) writeFileSync(join(shared, 'link-key'), key, { mode: 0o600 })
  if (navigation !== null) writeFileSync(join(shared, 'navigation.json'), typeof navigation === 'string' ? navigation : JSON.stringify(navigation), { mode: 0o600 })
  return shared
}

test('the footer’s link is signed with the worker’s key for exactly this chat', () => {
  const footer = linkFooter(linkFolder(), SESSION)
  const match = /^\n\n<!-- plannotator-orca-session-link:v1 -->\n\[Open in Orca\]\(http:\/\/127\.0\.0\.1:4321\/open\/([A-Za-z0-9_-]+)\.([0-9a-f]{64})\)\n$/.exec(footer ?? '')
  assert.ok(match, footer)
  const [, payload, signature] = match
  assert.equal(signature, createHmac('sha256', Buffer.from(KEY, 'hex')).update(payload).digest('hex'))
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), { v: 1, session: SESSION, tab: `structured-agent-session-${SESSION}` })
})

test('a missing, stale, malformed or unsafe link file gives no footer', () => {
  const now = Date.now()
  assert.equal(linkFooter(linkFolder({ key: null }), SESSION), null, 'no key')
  assert.equal(linkFooter(linkFolder({ navigation: null }), SESSION), null, 'no navigation')
  assert.equal(linkFooter(linkFolder({ navigation: { v: 1, port: 4321, pid: 9, at: now - 46_000 } }), SESSION), null, 'stale')
  assert.equal(linkFooter(linkFolder({ navigation: { v: 1, port: 4321, pid: 9, at: now - 40_000 } }), SESSION) !== null, true, 'fresh enough')
  assert.equal(linkFooter(linkFolder({ navigation: { v: 2, port: 4321, pid: 9, at: now } }), SESSION), null, 'version')
  assert.equal(linkFooter(linkFolder({ navigation: { v: 1, port: 70000, pid: 9, at: now } }), SESSION), null, 'port')
  assert.equal(linkFooter(linkFolder({ navigation: { v: 1, port: '4321', pid: 9, at: now } }), SESSION), null, 'port type')
  assert.equal(linkFooter(linkFolder({ navigation: 'not json' }), SESSION), null, 'not JSON')
  assert.equal(linkFooter(linkFolder({ key: KEY }), SESSION), null, 'no newline')
  assert.equal(linkFooter(linkFolder({ key: `${KEY.toUpperCase()}\n` }), SESSION), null, 'upper case')
  assert.equal(linkFooter(linkFolder({ key: `${KEY}\n\n` }), SESSION), null, 'extra bytes')
  if (POSIX) {
    const shared = linkFolder()
    chmodSync(join(shared, 'link-key'), 0o644)
    assert.equal(linkFooter(shared, SESSION), null, 'readable by others')
    const linked = linkFolder({ key: null })
    const elsewhere = linkFolder()
    symlinkSync(join(elsewhere, 'link-key'), join(linked, 'link-key'))
    assert.equal(linkFooter(linked, SESSION), null, 'a symbolic link')
    const open = linkFolder()
    chmodSync(join(open, 'navigation.json'), 0o640)
    assert.equal(linkFooter(open, SESSION), null, 'navigation readable by the group')
  }
  const folder = linkFolder({ key: null })
  mkdirSync(join(folder, 'link-key'))
  assert.equal(linkFooter(folder, SESSION), null, 'a folder')
})

test('the projects limit compares real folders, not text prefixes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-plannotator-projects-')))
  for (const name of ['a/b/inner', 'a/bc', 'x']) mkdirSync(join(root, name), { recursive: true })
  const ab = join(root, 'a', 'b')
  assert.equal(withinProjects([ab], null), true, 'no limit')
  assert.equal(withinProjects([ab], []), true, 'an empty list is no limit')
  assert.equal(withinProjects([ab], [ab]), true)
  assert.equal(withinProjects([join(ab, 'inner')], [ab]), true, 'inside')
  assert.equal(withinProjects([join(root, 'a', 'bc')], [ab]), false, '/a/b is not /a/bc')
  assert.equal(withinProjects([join(root, 'a')], [ab]), false, 'a parent is not inside')
  assert.equal(withinProjects([join(root, 'x'), join(ab, 'inner')], [ab]), true, 'any of the chat’s folders')
  assert.equal(withinProjects([ab], ['relative', 3]), false, 'nothing usable in the list')
  if (POSIX) {
    symlinkSync(ab, join(root, 'alias'))
    assert.equal(withinProjects([join(ab, 'inner')], [join(root, 'alias')]), true, 'through a link')
  }
})

// --- Receipts -----------------------------------------------------------------------------------

test('a retried message goes out byte for byte as the first, even after the link has changed', () => {
  const shared = mkdtempSync(join(tmpdir(), 'orca-plannotator-receipts-'))
  const store = receipts(shared, '/inbox')
  let port = 1000
  const ctx = context({ footer: () => `\n\n${MARKER}\n[Open in Orca](http://127.0.0.1:${(port += 1)}/open/t)\n`, freeze: store.freeze })
  const send = () => {
    const message = call('send_message', { body: 'Same words.' })
    enrich(message, ctx)
    return JSON.stringify(message.params.arguments)
  }
  const first = send()
  assert.equal(send(), first)
  assert.match(first, /127\.0\.0\.1:1001/)
  const missing = context({ footer: () => null, freeze: store.freeze })
  const noLink = call('send_message', { body: 'Sent while the link was down.' })
  enrich(noLink, missing)
  const retry = call('send_message', { body: 'Sent while the link was down.' })
  enrich(retry, ctx)
  assert.deepEqual(retry.params.arguments, noLink.params.arguments, 'a missing link is frozen too')

  // Another chat sending the same words is its own message.
  const other = call('send_message', { body: 'Same words.' })
  enrich(other, context({ proof: { ...PROOF, session: OTHER }, footer: () => null, freeze: store.freeze }))
  assert.equal(other.params.arguments.agent_session, OTHER)
  assert.equal(other.params.arguments.body, 'Same words.')

  const files = readdirSync(join(shared, 'receipts'))
  assert.ok(files.length >= 3 && files.every((name) => /^[0-9a-f]{64}\.json$/.test(name)), files.join())
  if (POSIX) {
    assert.equal(statSync(join(shared, 'receipts')).mode & 0o777, 0o700)
    for (const name of files) assert.equal(statSync(join(shared, 'receipts', name)).mode & 0o777, 0o600)
  }
})

test('an idempotency key another chat used is refused; the same chat retries it', () => {
  const shared = mkdtempSync(join(tmpdir(), 'orca-plannotator-receipts-'))
  const store = receipts(shared, '/inbox')
  const args = { body: 'Hello', idempotency_key: 'k-1' }
  const first = call('send_message', { ...args })
  enrich(first, context({ freeze: store.freeze }))
  const again = call('send_message', { ...args })
  enrich(again, context({ freeze: store.freeze, footer: () => null }))
  assert.deepEqual(again.params.arguments, first.params.arguments)
  const foreign = call('send_message', { ...args })
  assert.deepEqual(enrich(foreign, context({ proof: { ...PROOF, session: OTHER }, freeze: store.freeze })), { refusal: REFUSALS.key })
  const otherInbox = call('send_message', { ...args })
  assert.equal(enrich(otherInbox, context({ proof: { ...PROOF, session: OTHER }, freeze: receipts(shared, '/another-inbox').freeze })).changed, true, 'keys are per Inbox')
})

test('when receipts cannot be written, the message is refused instead of risking a double post', () => {
  const shared = mkdtempSync(join(tmpdir(), 'orca-plannotator-receipts-'))
  writeFileSync(join(shared, 'receipts'), 'not a folder')
  const store = receipts(shared, '/inbox')
  const message = call('send_message', { body: 'Hello' })
  const answer = enrich(message, context({ freeze: store.freeze, receiptsFolder: store.folder }))
  assert.equal(answer.refusal, REFUSALS.receipts(store.folder))
  assert.deepEqual(message, call('send_message', { body: 'Hello' }))
  // Reading needs no receipt.
  const read = call('read_thread', {})
  assert.equal(enrich(read, context({ freeze: store.freeze })).changed, true)

  const broken = mkdtempSync(join(tmpdir(), 'orca-plannotator-receipts-'))
  const good = receipts(broken, '/inbox')
  enrich(call('send_message', { body: 'Hello' }), context({ freeze: good.freeze }))
  for (const name of readdirSync(join(broken, 'receipts'))) writeFileSync(join(broken, 'receipts', name), '{not json', { mode: 0o600 })
  assert.ok(enrich(call('send_message', { body: 'Hello' }), context({ freeze: good.freeze })).refusal, 'an unreadable receipt cannot vouch for a retry')
})

// --- Proof --------------------------------------------------------------------------------------

const ok = (result) => ({ ok: true, result })
const statusOf = (session, live = true) => ok({ runtime: { reachable: true }, caller: { orcaSessionId: session, live } })
const pane = (session) => `structured-agent-session-${session}:00000000-0000-4000-8000-000000000001`
const listing = (rows) => ok({ worktrees: rows, truncated: false })
const row = (path, sessions, extra = {}) => ({ path, repoId: 'repo-1', hostId: null, agents: sessions.map((session) => ({ paneKey: pane(session) })), ...extra })
const repoList = (path = REPO) => ok({ repos: [{ id: 'repo-1', path, connectionId: null }] })

test('the proof needs this exact live session in one local workspace', () => {
  assert.deepEqual(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [SESSION])]), repoList()), PROOF)
  assert.deepEqual(readProof(SESSION, statusOf(`orca_session_id:${SESSION}`), listing([row(REPO, [SESSION])]), repoList()), { session: SESSION, project: REPO, working: REPO, roots: [REPO] })
  assert.deepEqual(readProof(SESSION, statusOf(SESSION), listing([row('/folder', [SESSION], { repoId: 'folder-9' })]), repoList()).roots, ['/folder'], 'a folder workspace is its own root')
  assert.equal(readProof(SESSION, statusOf(SESSION, false), listing([row(WORKTREE, [SESSION])]), repoList()), null, 'not live')
  assert.equal(readProof(SESSION, statusOf(OTHER), listing([row(WORKTREE, [SESSION])]), repoList()), null, 'another caller')
  assert.equal(readProof(SESSION, ok({ runtime: { reachable: true } }), listing([row(WORKTREE, [SESSION])]), repoList()), null, 'no caller')
  assert.equal(readProof(SESSION, { ok: false }, listing([row(WORKTREE, [SESSION])]), repoList()), null)
  assert.equal(readProof(SESSION, null, listing([row(WORKTREE, [SESSION])]), repoList()), null)
  assert.equal(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [OTHER])]), repoList()), null, 'not in any workspace')
  assert.equal(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [SESSION]), row(REPO, [SESSION])]), repoList()), null, 'listed twice')
  assert.equal(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [SESSION], { hostId: 'ssh-1' })]), repoList()), null, 'a remote host')
  assert.equal(readProof(SESSION, statusOf(SESSION), ok({ worktrees: [row(WORKTREE, [SESSION])], truncated: true }), repoList()), null, 'a partial list')
  assert.equal(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [SESSION])]), ok({ repos: [{ id: 'repo-1', path: REPO, connectionId: 'ssh' }] })), null, 'a remote repository')
  assert.equal(readProof(SESSION, statusOf(SESSION), listing([row(WORKTREE, [SESSION])]), null), null, 'no repository list')
})

test('a proof is kept, looked at again in the background, and tried again after a failure', async () => {
  let now = 0
  let answers = [PROOF, null, PROOF]
  let asked = 0
  const prover = createProver(async () => {
    asked += 1
    return answers.shift()
  }, () => now)
  assert.deepEqual(await prover.current(), PROOF)
  now = 30_000
  assert.deepEqual(await prover.current(), PROOF)
  assert.equal(asked, 1, 'cached')
  now = 61_000
  assert.deepEqual(await prover.current(), PROOF, 'the old proof serves while it is looked at again')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(asked, 2)
  assert.equal(await prover.current(), null, 'the new look failed')
  now = 70_000
  assert.equal(await prover.current(), null, 'not asked again at once')
  assert.equal(asked, 2)
  now = 77_000
  assert.deepEqual(await prover.current(), PROOF)
  assert.equal(asked, 3)
})

test('the heartbeat must be fresh, delivering, and for the same Inbox', () => {
  const shared = mkdtempSync(join(tmpdir(), 'orca-plannotator-'))
  const data = mkdtempSync(join(tmpdir(), 'orca-plannotator-data-'))
  const write = (state) => writeFileSync(join(shared, 'state.json'), JSON.stringify(state))
  assert.equal(workerDelivers(shared, data), false, 'no heartbeat')
  write({ v: 1, at: Date.now(), dataDir: data, delivering: true })
  assert.equal(workerDelivers(shared, data), true)
  write({ v: 1, at: Date.now() - 5 * 60_000, dataDir: data, delivering: true })
  assert.equal(workerDelivers(shared, data), false, 'stale')
  write({ v: 1, at: Date.now(), dataDir: data, delivering: false })
  assert.equal(workerDelivers(shared, data), false, 'not delivering')
  write({ v: 1, at: Date.now(), dataDir: join(data, 'other'), delivering: true })
  assert.equal(workerDelivers(shared, data), false, 'another Inbox')
})

test('the server’s own instructions gain the Orca note', () => {
  const message = { id: 0, result: { instructions: 'Plannotator Inbox: a local window.\n', capabilities: {} } }
  assert.equal(annotate(message), true)
  assert.equal(message.result.instructions, `Plannotator Inbox: a local window.\n\n${ORCA_NOTE}`)
  assert.match(ORCA_NOTE, /already connected/)
  assert.match(ORCA_NOTE, /change nothing/)
})

test('an answer with no instructions of its own (Plannotator with the Inbox off) gets no Orca note', () => {
  // Plannotator 0.29.1's `inbox mcp` while the Inbox is off: no instructions, and `tools/list` is empty.
  const off = { id: 0, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plannotator-inbox', version: '1.0.0' } } }
  assert.equal(annotate(off), false)
  assert.equal('instructions' in off.result, false)
})

// --- The real child process ----------------------------------------------------------------------

// A stand-in for `plannotator inbox mcp`: answers each request with what it received.
const SERVER = `
import { createInterface } from 'node:readline'
const tools = [
  { name: 'send_message', inputSchema: { type: 'object', properties: { body: {}, agent_host: {}, agent_session: {}, agent_name: {}, project_path: {}, idempotency_key: {} } } },
  { name: 'new_tool', inputSchema: { type: 'object', properties: { agent_host: {}, agent_session: {} } } },
  { name: 'search', inputSchema: { type: 'object', properties: { query: {} } } }
]
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result = { echo: message.params ?? null, argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null, dataDir: process.env.PLANNOTATOR_DATA_DIR ?? null }
  if (message.method === 'initialize') result = { instructions: 'stock instructions', serverInfo: { name: 'plannotator-inbox' } }
  if (message.method === 'tools/list') result = { tools }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
}
`

// A stand-in for Orca's CLI: answers \`status\`, \`worktree ps\` and \`repo list\` from a file, and logs each run.
const ORCA = `
import { appendFileSync, readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(process.env.ORCA_STANDIN_CONFIG, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(config.log, JSON.stringify({ args, session: process.env.ORCA_AGENT_SESSION_ID ?? null }) + '\\n')
const answer = args[0] === 'status' ? config.status : args[0] === 'worktree' && args[1] === 'ps' ? config.worktrees : args[0] === 'repo' && args[1] === 'list' ? config.repos : null
process.stdout.write(JSON.stringify(answer ?? { ok: false, error: { code: 'unknown_command' } }))
process.exitCode = answer ? 0 : 1
`

function executable(root, name, script) {
  writeFileSync(join(root, `${name}.mjs`), script)
  // The wrapper removes ELECTRON_RUN_AS_NODE for its children; these stand-ins need it back to run as Node.
  const windows = process.platform === 'win32'
  const bin = join(root, windows ? `${name}.cmd` : name)
  writeFileSync(
    bin,
    windows
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${join(root, `${name}.mjs`)}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${join(root, `${name}.mjs`)}' "$@"\n`
  )
  chmodSync(bin, 0o755)
  return bin
}

function sandbox({ live = true, session = SESSION } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-plannotator-wrap-')))
  const shared = join(root, 'shared')
  const data = join(root, 'data')
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktrees', 'feature')
  for (const folder of [shared, data, repo, worktree]) mkdirSync(folder, { recursive: true })
  const bin = executable(root, 'plannotator', SERVER)
  const orca = executable(root, 'orca', ORCA)
  const config = join(root, 'orca.json')
  const log = join(root, 'orca.log')
  writeFileSync(config, JSON.stringify({ log, status: statusOf(session, live), worktrees: listing([row(worktree, [session])]), repos: repoList(repo) }))
  const deliver = (extra = {}) => writeFileSync(join(shared, 'state.json'), JSON.stringify({ v: 1, at: Date.now(), dataDir: data, delivering: true, ...extra }))
  const env = { ...CHAT, PLANNOTATOR_BIN: bin, ORCA_PLANNOTATOR_HOME: shared, PLANNOTATOR_DATA_DIR: data, ORCA_CLI_COMMAND: orca, ORCA_STANDIN_CONFIG: config }
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  return { root, shared, data, repo, worktree, bin, orca, env, deliver, runs }
}

/** Starts the wrapper and sends the lines one at a time, as a client does: each request waits for its answer. */
function converse(env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let expected = 0
    const pending = [...lines]
    const answered = () => out.split('\n').filter(Boolean).length
    const next = () => {
      if (answered() < expected) return
      const line = pending.shift()
      if (line === undefined) return child.stdin.end()
      if (typeof line === 'function') {
        line()
        return next()
      }
      const text = typeof line === 'string' ? line : JSON.stringify(line)
      if (JSON.parse(text).id !== undefined) expected += 1
      child.stdin.write(`${text}\n`)
      next()
    }
    child.stdout.on('data', (chunk) => {
      out += chunk
      next()
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`wrapper exited ${code}: ${err}`))
      resolve({ raw: out, answers: out.split('\n').filter(Boolean).map((line) => JSON.parse(line)) })
    })
    next()
  })
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }
const byId = (answers, id) => answers.find((answer) => answer.id === id)

test('in a proven Orca chat, a real run fills the identity from the server’s own tool list and registers the chat', async () => {
  const box = sandbox()
  box.deliver()
  const { answers } = await converse({ ...box.env, PLANNOTATOR_CWD: '/work/project' }, [
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { ...call('send_message', { body: 'Hello' }), id: 2 },
    { ...call('new_tool', {}), id: 3 },
    { ...call('search', { query: 'x' }), id: 4 }
  ])
  assert.equal(byId(answers, 0).result.instructions, `stock instructions\n\n${ORCA_NOTE}`)
  assert.equal(byId(answers, 1).result.tools.length, 3, 'the tool list passes through')
  const sent = byId(answers, 2)
  assert.deepEqual(sent.result.echo.arguments, { body: 'Hello', agent_host: 'orca', agent_session: SESSION, agent_name: 'Codex', project_path: box.repo })
  assert.equal(sent.result.echo._meta[WAKE], true)
  assert.equal(sent.result.echo._meta[WORKING], box.worktree)
  assert.deepEqual(sent.result.argv, ['inbox', 'mcp'])
  assert.equal(sent.result.electron, '1', 'set by the stand-in itself; the wrapper passes none on')
  assert.deepEqual(byId(answers, 3).result.echo.arguments, { agent_host: 'orca', agent_session: SESSION }, 'a tool Plannotator adds later needs no change here')
  assert.equal(byId(answers, 3).result.echo._meta, undefined, 'and it does not wake the chat')
  assert.deepEqual(byId(answers, 4).result.echo.arguments, { query: 'x' })

  const registration = JSON.parse(readFileSync(join(box.shared, 'sessions', `${SESSION}.json`), 'utf8'))
  assert.equal(registration.session, SESSION)
  assert.equal(registration.projectPath, '/work/project', 'the chat’s own folder, not the message’s')
  assert.equal(registration.dataDir, box.data)

  const runs = box.runs()
  assert.deepEqual(runs.map((run) => run.args).sort(), [
    ['repo', 'list', '--environment', 'local', '--json'],
    ['status', '--json', '--environment', 'local'],
    ['worktree', 'ps', '--limit', '1000', '--environment', 'local', '--json']
  ], 'Orca is asked once for the whole process')
  assert.ok(runs.every((run) => run.session === SESSION), 'with the chat’s own environment')
})

test('a real run refuses another session and another project, and the next call still works', async () => {
  const box = sandbox()
  box.deliver()
  const { answers } = await converse(box.env, [
    INIT,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { ...call('send_message', { body: 'Hi', agent_session: OTHER }), id: 2 },
    { ...call('send_message', { body: 'Hi', project_path: join(box.root, 'elsewhere') }), id: 3 },
    { ...call('send_message', { body: 'Hi', project_path: box.worktree }), id: 4 }
  ])
  assert.deepEqual(byId(answers, 2), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: REFUSALS.session }], isError: true } })
  assert.equal(byId(answers, 3).result.isError, true)
  assert.equal(byId(answers, 3).result.content[0].text, REFUSALS.project([box.repo, box.worktree]))
  assert.equal(byId(answers, 4).result.echo.arguments.project_path, box.worktree)
  assert.equal(answers.length, 5, 'one answer per call')
})

test('without Orca’s proof the chat is plain Plannotator: nothing rewritten, no note, no wake claim', async () => {
  for (const variant of ['missing CLI', 'not live', 'another session']) {
    const box = variant === 'not live' ? sandbox({ live: false }) : variant === 'another session' ? sandbox({ session: OTHER }) : sandbox()
    box.deliver()
    const env = variant === 'missing CLI' ? { ...box.env, ORCA_CLI_COMMAND: join(box.root, 'no-orca-here') } : box.env
    const odd = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_message","arguments":{"body":"spaced  out","agent_session":"x"},"_meta":{"ai.plannotator/inbox-wakes":true}}}'
    const { raw, answers } = await converse(env, [INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, odd])
    assert.equal(byId(answers, 0).result.instructions, 'stock instructions', variant)
    assert.deepEqual(byId(answers, 5).result.echo, JSON.parse(odd).params, variant)
    assert.ok(raw.endsWith('\n'))
    assert.equal(existsSync(join(box.shared, 'sessions')), false, variant)
    assert.equal(existsSync(join(box.shared, 'receipts')), false, variant)
  }
})

test('a chat outside the folders the plugin is limited to is plain Plannotator', async () => {
  const box = sandbox()
  box.deliver({ projects: [join(box.root, 'repo-other')] })
  const lines = [INIT, call('send_message', { body: 'Hello' })]
  const limited = await converse(box.env, lines)
  assert.equal(limited.answers[0].result.instructions, 'stock instructions')
  assert.deepEqual(limited.answers[1].result.echo.arguments, { body: 'Hello' })

  box.deliver({ projects: [box.root] })
  const inside = await converse(box.env, lines)
  assert.equal(inside.answers[1].result.echo.arguments.agent_host, 'orca')
})

test('a real run adds the Open in Orca footer, and a retry is byte for byte the same', async () => {
  const box = sandbox()
  box.deliver()
  writeFileSync(join(box.shared, 'link-key'), `${KEY}\n`, { mode: 0o600 })
  const navigate = (port) => () => writeFileSync(join(box.shared, 'navigation.json'), JSON.stringify({ v: 1, port, pid: 1, at: Date.now() }), { mode: 0o600 })
  navigate(5001)()
  const message = { ...call('send_message', { body: 'Ready for review.' }), id: 7 }
  const { answers } = await converse(box.env, [INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, message, navigate(5002), { ...message, id: 8 }])
  const first = byId(answers, 7).result.echo
  const second = byId(answers, 8).result.echo
  assert.ok(first.arguments.body.startsWith(`Ready for review.\n\n${MARKER}\n[Open in Orca](http://127.0.0.1:5001/open/`), first.arguments.body)
  assert.equal(JSON.stringify(second.arguments), JSON.stringify(first.arguments), 'the retry carries the same footer and fields')

  // A new process (the agent restarted its MCP server) replays the receipt too.
  const later = await converse(box.env, [INIT, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...message, id: 9 }])
  assert.equal(JSON.stringify(byId(later.answers, 9).result.echo.arguments), JSON.stringify(first.arguments))
})

test('a stale or unsafe link leaves the message without a footer, and it is still sent', async () => {
  const box = sandbox()
  box.deliver()
  writeFileSync(join(box.shared, 'link-key'), `${KEY}\n`, { mode: 0o600 })
  writeFileSync(join(box.shared, 'navigation.json'), JSON.stringify({ v: 1, port: 5001, pid: 1, at: Date.now() - 60_000 }), { mode: 0o600 })
  const { answers } = await converse(box.env, [INIT, { ...call('send_message', { body: 'No link.' }), id: 2 }])
  assert.deepEqual(byId(answers, 2).result.echo.arguments.body, 'No link.')
  assert.equal(byId(answers, 2).result.echo.arguments.agent_host, 'orca')
})

test('a real run refuses a message whose receipt cannot be written, then carries on', async () => {
  const box = sandbox()
  box.deliver()
  writeFileSync(join(box.shared, 'receipts'), 'not a folder')
  const { answers } = await converse(box.env, [INIT, { ...call('send_message', { body: 'Hello' }), id: 2 }, { jsonrpc: '2.0', id: 3, method: 'ping' }])
  assert.equal(byId(answers, 2).result.isError, true)
  assert.equal(byId(answers, 2).result.content[0].text, REFUSALS.receipts(join(box.shared, 'receipts')))
  assert.equal(byId(answers, 3).result.echo, null, 'the next request still reaches Plannotator')
})

test('an Orca chat whose environment names no Inbox uses the one the plugin delivers for', async () => {
  const box = sandbox()
  // The plugin's "Plannotator data folder" setting points away from the default, and the worker says so.
  box.deliver()
  const home = { HOME: box.root, USERPROFILE: box.root }
  const lines = [INIT, call('send_message', { body: 'Hello' })]
  const { PLANNOTATOR_DATA_DIR: _unused, ...chatEnv } = box.env
  const chat = await converse({ ...chatEnv, ...home }, lines)
  assert.equal(chat.answers[1].result.dataDir, box.data, 'Plannotator opens the Inbox the worker polls')
  assert.equal(chat.answers[1].result.echo.arguments.agent_host, 'orca', 'and the chat is the author')
  assert.equal(JSON.parse(readFileSync(join(box.shared, 'sessions', `${SESSION}.json`), 'utf8')).dataDir, box.data)

  // A folder the agent's own environment names is never replaced, and outside an Orca chat nothing is added.
  const elsewhere = join(box.root, 'elsewhere')
  const named = await converse({ ...chatEnv, ...home, PLANNOTATOR_DATA_DIR: elsewhere }, lines)
  assert.equal(named.answers[1].result.dataDir, elsewhere)
  assert.equal(named.answers[1].result.echo.arguments.agent_host, undefined)
  const plain = await converse({ ...home, PLANNOTATOR_BIN: box.bin, ORCA_PLANNOTATOR_HOME: box.shared }, lines)
  assert.equal(plain.answers[1].result.dataDir, null)
})

test('outside an Orca chat it is Plannotator’s server, byte for byte, and Orca is never asked', async () => {
  const box = sandbox()
  box.deliver()
  const odd = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_message","arguments":{"body":"spaced  out"},"_meta":{"ai.plannotator/inbox-wakes":true}}}'
  const { ORCA_AGENT_SESSION_ID: _a, ORCA_STRUCTURED_SESSION: _b, ...env } = box.env
  const { raw, answers } = await converse(env, [INIT, odd])
  assert.equal(answers[0].result.instructions, 'stock instructions')
  assert.deepEqual(answers[1].result.echo, JSON.parse(odd).params)
  assert.ok(raw.endsWith('\n'))
  assert.equal(existsSync(join(box.shared, 'sessions')), false)
  assert.deepEqual(box.runs(), [])
})

test('in an Orca chat with the plugin not delivering, nothing is changed or registered, and Orca is not asked', async () => {
  const box = sandbox()
  const { answers } = await converse(box.env, [INIT, call('send_message', { body: 'Hello', agent_host: 'codex' })])
  assert.equal(answers[0].result.instructions, 'stock instructions')
  assert.deepEqual(answers[1].result.echo.arguments, { body: 'Hello', agent_host: 'codex' })
  assert.equal(existsSync(join(box.shared, 'sessions')), false)
  assert.deepEqual(box.runs(), [])
})

test('a frame larger than a pipe buffer passes through whole', async () => {
  const box = sandbox()
  box.deliver()
  const body = 'x'.repeat(3 * 1024 * 1024)
  const { answers } = await converse(box.env, [INIT, { ...call('send_message', { body }), id: 2 }])
  assert.equal(byId(answers, 2).result.echo.arguments.body.length, body.length)
  assert.equal(byId(answers, 2).result.echo.arguments.agent_host, 'orca')
})

test('without Plannotator installed it says so and exits', async () => {
  const box = sandbox()
  await assert.rejects(converse({ PATH: join(box.root, 'nowhere'), HOME: box.root, USERPROFILE: box.root, LOCALAPPDATA: box.root, PLANNOTATOR_BIN: '' }, []), /Plannotator is not installed/)
})
