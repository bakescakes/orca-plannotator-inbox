// The launcher's wrapper, as a library and as the real child process an agent would start.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ORCA_NOTE, agentName, annotate, enrich, nativeSession, workerDelivers } from '../bin/inbox-mcp.mjs'

const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))
const SESSION = 'codex_1b491d4a_6f38'
const CHAT = { ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1' }
const FIELDS = { send_message: ['agent_host', 'agent_session', 'agent_name'], read_thread: ['agent_session'], search: [] }
const context = (delivering = true) => ({ session: SESSION, name: 'Codex', delivering: () => delivering, fieldsOf: (tool) => FIELDS[tool] ?? [] })
const call = (name, args, meta) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }), ...(meta ? { _meta: meta } : {}) } })

test('only a local native Orca chat is treated as one', () => {
  assert.equal(nativeSession(CHAT), SESSION)
  assert.equal(nativeSession({ ...CHAT, ORCA_AGENT_SESSION_ID: `orca_session_id:${SESSION}` }), SESSION)
  assert.equal(nativeSession({ ORCA_AGENT_SESSION_ID: SESSION }), null, 'a terminal agent')
  assert.equal(nativeSession({}), null)
  assert.equal(nativeSession({ ...CHAT, SSH_CONNECTION: '1.2.3.4 22' }), null)
  assert.equal(nativeSession({ ...CHAT, ORCA_ENVIRONMENT: 'paired-host' }), null)
  assert.equal(nativeSession({ ...CHAT, ORCA_AGENT_SESSION_ID: 'bad id' }), null)
  assert.equal(agentName({ ORCA_AGENT_SESSION_ID: 'claude_abc' }), 'Claude')
  assert.equal(agentName({ ORCA_AGENT_SESSION_ID: 'mystery_abc' }), null)
})

test('the chat becomes the author of what it sends', () => {
  const message = call('send_message', { body: 'Hello' })
  const result = enrich(message, context())
  assert.equal(result.changed, true)
  assert.equal(result.authored, true)
  assert.deepEqual(message.params.arguments, { body: 'Hello', agent_host: 'orca', agent_session: SESSION, agent_name: 'Codex' })
  assert.deepEqual(message.params._meta, { 'ai.plannotator/inbox-wakes': true })
})

test('an agent that names its own host, as Plannotator’s connect prompt tells it to, still sends as the chat', () => {
  const message = call('send_message', { body: 'Hi', agent_host: 'codex', agent_name: 'Codex (work)', agent_session: 'thread-123', idempotency_key: 'plannotator-inbox-connect-v1-codex' }, { progressToken: 7 })
  enrich(message, context())
  assert.equal(message.params.arguments.agent_host, 'orca')
  assert.equal(message.params.arguments.agent_session, SESSION)
  assert.equal(message.params.arguments.agent_name, 'Codex (work)', 'its own name is kept')
  assert.equal(message.params.arguments.idempotency_key, 'plannotator-inbox-connect-v1-codex')
  assert.deepEqual(message.params._meta, { progressToken: 7, 'ai.plannotator/inbox-wakes': true })
})

test('reading tools get the session only when none was given; tools without identity are untouched', () => {
  const mine = call('read_thread', {})
  enrich(mine, context())
  assert.deepEqual(mine.params.arguments, { agent_session: SESSION })
  assert.equal(mine.params._meta, undefined)

  const other = call('read_thread', { agent_session: 'another', thread_id: 't' })
  assert.equal(enrich(other, context()).changed, false)
  assert.deepEqual(other.params.arguments, { agent_session: 'another', thread_id: 't' })

  const search = call('search', { query: 'x' })
  assert.equal(enrich(search, context()).changed, false)
  assert.deepEqual(search, call('search', { query: 'x' }))
})

test('while the plugin is not delivering, the call is Plannotator’s own', () => {
  const message = call('send_message', { body: 'Hello', agent_host: 'codex' })
  const result = enrich(message, context(false))
  assert.deepEqual(result, { changed: false, authored: false })
  assert.deepEqual(message, call('send_message', { body: 'Hello', agent_host: 'codex' }))
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

// A stand-in for `plannotator inbox mcp`: answers each request with what it received.
const SERVER = `
import { createInterface } from 'node:readline'
const tools = [
  { name: 'send_message', inputSchema: { type: 'object', properties: { body: {}, agent_host: {}, agent_session: {}, agent_name: {}, project_path: {} } } },
  { name: 'new_tool', inputSchema: { type: 'object', properties: { agent_host: {}, agent_session: {} } } },
  { name: 'search', inputSchema: { type: 'object', properties: { query: {} } } }
]
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result = { echo: message.params ?? null, argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }
  if (message.method === 'initialize') result = { instructions: 'stock instructions', serverInfo: { name: 'plannotator-inbox' } }
  if (message.method === 'tools/list') result = { tools }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
}
`

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'orca-plannotator-wrap-'))
  const shared = join(root, 'shared')
  const data = join(root, 'data')
  mkdirSync(shared)
  mkdirSync(data)
  writeFileSync(join(root, 'server.mjs'), SERVER)
  // The wrapper removes ELECTRON_RUN_AS_NODE for its child; this stand-in needs it back to run as Node.
  const windows = process.platform === 'win32'
  const bin = join(root, windows ? 'plannotator.cmd' : 'plannotator')
  writeFileSync(
    bin,
    windows
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${join(root, 'server.mjs')}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${join(root, 'server.mjs')}' "$@"\n`
  )
  chmodSync(bin, 0o755)
  return { root, shared, data, bin }
}

/** Starts the wrapper and sends the lines one at a time, as a client does: each request waits for its answer. */
function converse(env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let expected = 0
    const pending = [...lines]
    const answered = () => out.split('\n').filter(Boolean).length
    const next = () => {
      if (answered() < expected) return
      const line = pending.shift()
      if (line === undefined) return child.stdin.end()
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

test('in an Orca chat, a real run fills the identity from the server’s own tool list and registers the chat', async () => {
  const box = sandbox()
  writeFileSync(join(box.shared, 'state.json'), JSON.stringify({ v: 1, at: Date.now(), dataDir: box.data, delivering: true }))
  const { answers } = await converse(
    { ...CHAT, PLANNOTATOR_BIN: box.bin, ORCA_PLANNOTATOR_HOME: box.shared, PLANNOTATOR_DATA_DIR: box.data, PLANNOTATOR_CWD: '/work/project' },
    [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      call('send_message', { body: 'Hello', project_path: '/another/repo' }),
      { ...call('new_tool', {}), id: 2 },
      { ...call('search', { query: 'x' }), id: 3 }
    ]
  )
  assert.equal(answers[0].result.instructions, `stock instructions\n\n${ORCA_NOTE}`)
  assert.equal(answers[1].result.tools.length, 3, 'the tool list passes through')
  const sent = answers.find((answer) => answer.id === 1 && answer.result.echo)
  assert.deepEqual(sent.result.echo.arguments, { body: 'Hello', project_path: '/another/repo', agent_host: 'orca', agent_session: SESSION, agent_name: 'Codex' })
  assert.equal(sent.result.echo._meta['ai.plannotator/inbox-wakes'], true)
  assert.deepEqual(sent.result.argv, ['inbox', 'mcp'])
  assert.equal(sent.result.electron, '1', 'set by the stand-in itself; the wrapper passes none on')
  const added = answers.find((answer) => answer.id === 2)
  assert.deepEqual(added.result.echo.arguments, { agent_host: 'orca', agent_session: SESSION }, 'a tool Plannotator adds later needs no change here')
  assert.deepEqual(answers.find((answer) => answer.id === 3).result.echo.arguments, { query: 'x' })

  const registration = JSON.parse(readFileSync(join(box.shared, 'sessions', `${SESSION}.json`), 'utf8'))
  assert.equal(registration.session, SESSION)
  assert.equal(registration.projectPath, '/work/project', 'the chat\u2019s own folder, not the message\u2019s')
  assert.equal(registration.dataDir, box.data)
})

test('outside an Orca chat it is Plannotator’s server, byte for byte', async () => {
  const box = sandbox()
  writeFileSync(join(box.shared, 'state.json'), JSON.stringify({ v: 1, at: Date.now(), dataDir: box.data, delivering: true }))
  const odd = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_message","arguments":{"body":"spaced  out"}}}'
  const { raw, answers } = await converse({ PLANNOTATOR_BIN: box.bin, ORCA_PLANNOTATOR_HOME: box.shared, PLANNOTATOR_DATA_DIR: box.data }, [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    odd
  ])
  assert.equal(answers[0].result.instructions, 'stock instructions')
  assert.deepEqual(answers[1].result.echo.arguments, { body: 'spaced  out' })
  assert.ok(raw.endsWith('\n'))
  assert.equal(existsSync(join(box.shared, 'sessions')), false)
})

test('in an Orca chat with the plugin not delivering, nothing is changed or registered', async () => {
  const box = sandbox()
  const { answers } = await converse({ ...CHAT, PLANNOTATOR_BIN: box.bin, ORCA_PLANNOTATOR_HOME: box.shared, PLANNOTATOR_DATA_DIR: box.data }, [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    call('send_message', { body: 'Hello', agent_host: 'codex' })
  ])
  assert.equal(answers[0].result.instructions, 'stock instructions')
  assert.deepEqual(answers[1].result.echo.arguments, { body: 'Hello', agent_host: 'codex' })
  assert.equal(existsSync(join(box.shared, 'sessions')), false)
})

test('without Plannotator installed it says so and exits', async () => {
  const box = sandbox()
  await assert.rejects(converse({ PATH: join(box.root, 'nowhere'), HOME: box.root, USERPROFILE: box.root, LOCALAPPDATA: box.root, PLANNOTATOR_BIN: '' }, []), /Plannotator is not installed/)
})
