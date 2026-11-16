import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  claudeLink,
  codexBlock,
  codexLink,
  connectAgents,
  connectClaude,
  connectCodex,
  disconnectAgents,
  disconnectClaude,
  disconnectCodex,
  tomlBlocks,
  type ConnectDeps,
  type RunCli
} from '../src/connect'
import { memoryStore, tempDir } from './fakes'

const LAUNCHER = '/Users/someone/.orca-plannotator-inbox/inbox-mcp'

async function setup(overrides: Partial<ConnectDeps> = {}) {
  const home = await tempDir()
  await mkdir(join(home, '.codex'), { recursive: true })
  const deps: ConnectDeps = { home, env: { PATH: '/nowhere' }, launcher: LAUNCHER, store: memoryStore(), find: () => null, ...overrides }
  const codex = join(home, '.codex', 'config.toml')
  const claude = join(home, '.claude.json')
  return { home, deps, codex, claude }
}

const CODEX_BASE = `model = "gpt-6"
developer_instructions = """
Keep this.
[mcp_servers.plannotator-inbox]
command = "inside a string, not a table"
"""

[features]
hooks = true

[mcp_servers.other]
command = "uvx"
args = ["thing"]
`

test('toml tables are found, and a header inside a multi-line string is not one', () => {
  const keys = tomlBlocks(CODEX_BASE.split('\n')).map((block) => block.key)
  assert.deepEqual(keys, ['features', 'mcp_servers.other'])
  assert.deepEqual(tomlBlocks(['[mcp_servers."plannotator-inbox".env] # note', 'A = "1"']).map((block) => block.key), ['mcp_servers.plannotator-inbox.env'])
})

test('codex: connect adds one table and disconnect removes exactly it', async () => {
  const t = await setup()
  await writeFile(t.codex, CODEX_BASE)
  assert.equal((await codexLink(t.deps)).state, 'absent')
  assert.equal((await connectCodex(t.deps)).ok, true)
  const connected = await readFile(t.codex, 'utf8')
  assert.ok(connected.startsWith(CODEX_BASE.trimEnd()))
  assert.match(connected, /\[mcp_servers\.plannotator-inbox\]\n# Plannotator's own stdio server/)
  assert.ok(connected.includes(`command = "${LAUNCHER}"`))
  assert.match(connected, /env_vars = \[.*"ORCA_AGENT_SESSION_ID".*"ORCA_STRUCTURED_SESSION"/)
  assert.equal((await codexLink(t.deps)).state, 'connected')
  assert.equal((await connectCodex(t.deps)).message, 'Codex is already connected.')
  assert.equal(await readFile(t.codex, 'utf8'), connected)

  assert.equal((await disconnectCodex(t.deps)).ok, true)
  assert.equal(await readFile(t.codex, 'utf8'), CODEX_BASE)
  assert.equal(await readFile(`${t.codex}.before-orca-plannotator-inbox`, 'utf8'), connected)
})

test('codex: Plannotator’s plain entry is replaced and put back', async () => {
  const t = await setup()
  const stock = `[mcp_servers.plannotator-inbox]\ncommand = "/Users/someone/.local/bin/plannotator"\nargs = ["inbox", "mcp"]\nenv = { PLANNOTATOR_DATA_DIR = "/data/inbox" }`
  await writeFile(t.codex, `${CODEX_BASE}\n${stock}\n\n[projects."/x"]\ntrust_level = "trusted"\n`)
  assert.equal((await codexLink(t.deps)).state, 'plannotator')
  await connectCodex(t.deps)
  const connected = await readFile(t.codex, 'utf8')
  assert.ok(!connected.includes('command = "/Users/someone/.local/bin/plannotator"'))
  assert.ok(
    connected.includes(`${codexBlock(LAUNCHER)}\nenv = { PLANNOTATOR_BIN = "/Users/someone/.local/bin/plannotator", PLANNOTATOR_DATA_DIR = "/data/inbox" }\n`),
    'the launcher runs the binary that entry ran and opens the Inbox it opened'
  )
  assert.ok(connected.includes('[projects."/x"]\ntrust_level = "trusted"'))
  assert.equal((await codexLink(t.deps)).state, 'connected')
  await disconnectCodex(t.deps)
  const restored = await readFile(t.codex, 'utf8')
  assert.ok(restored.includes(stock))
  assert.ok(!restored.includes(LAUNCHER))
  assert.equal((await codexLink(t.deps)).state, 'plannotator')
})

test('codex: an entry this plugin does not recognise is never touched', async () => {
  const t = await setup()
  const custom = `${CODEX_BASE}\n[mcp_servers.plannotator-inbox]\ncommand = "python3"\nargs = ["/opt/adapter/mcp.py"]\n\n[other]\nx = 1\n\n[mcp_servers.plannotator-inbox.env]\nPLANNOTATOR_DATA_DIR = "/data"\n`
  await writeFile(t.codex, custom)
  assert.equal((await codexLink(t.deps)).state, 'other')
  assert.equal((await connectCodex(t.deps)).ok, false)
  assert.equal((await disconnectCodex(t.deps)).ok, true)
  assert.equal(await readFile(t.codex, 'utf8'), custom)

  await writeFile(t.codex, 'mcp_servers = { plannotator-inbox = { command = "x" } }\n')
  assert.equal((await codexLink(t.deps)).state, 'other')
})

test('codex: the server written with dotted keys or as an inline table is left alone', async () => {
  for (const custom of [
    `${CODEX_BASE}\n[mcp_servers]\nplannotator-inbox.command = "custom-mcp"\nplannotator-inbox.args = []\n`,
    `${CODEX_BASE}\n[mcp_servers]\n"plannotator-inbox" = { command = "custom-mcp" }\n`,
    `mcp_servers.plannotator-inbox.command = "custom-mcp"\n${CODEX_BASE}\n`
  ]) {
    const t = await setup()
    await writeFile(t.codex, custom)
    assert.equal((await codexLink(t.deps)).state, 'other', custom)
    assert.equal((await connectCodex(t.deps)).ok, false)
    assert.equal(await readFile(t.codex, 'utf8'), custom, 'adding a table would declare the server twice')
  }
})

test('codex: missing when it is not installed, and a first config is created when it is', async () => {
  const bare = await tempDir()
  const deps: ConnectDeps = { home: bare, env: {}, launcher: LAUNCHER, store: memoryStore(), find: () => null }
  assert.equal((await codexLink(deps)).state, 'missing')
  assert.equal((await connectCodex(deps)).ok, true)

  const t = await setup()
  assert.equal((await codexLink(t.deps)).state, 'absent')
  await connectCodex(t.deps)
  assert.equal((await codexLink(t.deps)).state, 'connected')
})

test('claude: the entry is written beside everything else and removed again', async () => {
  const t = await setup()
  const original = { numStartups: 7, mcpServers: { paper: { type: 'stdio', command: '/bin/paper', args: ['mcp'] } }, projects: { '/x': { a: 1 } } }
  await writeFile(t.claude, JSON.stringify(original, null, 2))
  assert.equal((await claudeLink(t.deps)).state, 'absent')
  assert.equal((await connectClaude(t.deps)).ok, true)
  const written = JSON.parse(await readFile(t.claude, 'utf8'))
  assert.deepEqual(written.mcpServers['plannotator-inbox'], { type: 'stdio', command: LAUNCHER, args: [], env: {} })
  assert.deepEqual(written.mcpServers.paper, original.mcpServers.paper)
  assert.deepEqual(written.projects, original.projects)
  assert.equal((await claudeLink(t.deps)).state, 'connected')
  await disconnectClaude(t.deps)
  assert.deepEqual(JSON.parse(await readFile(t.claude, 'utf8')), original)
})

test('claude: Plannotator’s plain entry is replaced and put back; other entries are left alone', async () => {
  const t = await setup()
  const stock = { type: 'stdio', command: '/Users/someone/.local/bin/plannotator', args: ['inbox', 'mcp'], env: { PLANNOTATOR_DATA_DIR: '/data/inbox' } }
  await writeFile(t.claude, JSON.stringify({ mcpServers: { 'plannotator-inbox': stock } }))
  assert.equal((await claudeLink(t.deps)).state, 'plannotator')
  await connectClaude(t.deps)
  assert.equal((await claudeLink(t.deps)).state, 'connected')
  assert.deepEqual(
    JSON.parse(await readFile(t.claude, 'utf8')).mcpServers['plannotator-inbox'],
    { type: 'stdio', command: LAUNCHER, args: [], env: { PLANNOTATOR_DATA_DIR: '/data/inbox', PLANNOTATOR_BIN: '/Users/someone/.local/bin/plannotator' } },
    'the launcher runs the binary that entry ran and opens the Inbox it opened'
  )
  await disconnectClaude(t.deps)
  assert.deepEqual(JSON.parse(await readFile(t.claude, 'utf8')).mcpServers['plannotator-inbox'], stock)

  const custom = { mcpServers: { 'plannotator-inbox': { type: 'stdio', command: 'python3', args: ['/opt/adapter/mcp.py'] } } }
  await writeFile(t.claude, JSON.stringify(custom))
  assert.equal((await claudeLink(t.deps)).state, 'other')
  assert.equal((await connectClaude(t.deps)).ok, false)
  assert.deepEqual(JSON.parse(await readFile(t.claude, 'utf8')), custom)
})

test('claude: Plannotator’s own Claude Code plugin already covers Orca chats', async () => {
  const t = await setup()
  await writeFile(t.claude, JSON.stringify({ mcpServers: {} }))
  await mkdir(join(t.home, '.claude', 'plugins'), { recursive: true })
  await writeFile(join(t.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'plannotator@plannotator': [{ version: '0.28.66' }] } }))
  assert.equal((await claudeLink(t.deps)).state, 'builtin')
  assert.equal((await connectClaude(t.deps)).ok, true)
  assert.deepEqual(JSON.parse(await readFile(t.claude, 'utf8')), { mcpServers: {} })
})

test('claude: its own command line is used when it is installed', async () => {
  const calls: string[][] = []
  let t: Awaited<ReturnType<typeof setup>>
  const run: RunCli = async (_file, args, env) => {
    calls.push(args)
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    const config = JSON.parse(await readFile(t.claude, 'utf8'))
    if (args[1] === 'remove') delete config.mcpServers[args[4]!]
    if (args[1] === 'add-json') config.mcpServers[args[4]!] = JSON.parse(args[5]!)
    await writeFile(t.claude, JSON.stringify(config))
    return { code: 0, output: '' }
  }
  t = await setup({ run, find: (name) => (name === 'claude' ? '/bin/claude' : null), env: { ELECTRON_RUN_AS_NODE: '1' } })
  await writeFile(t.claude, JSON.stringify({ mcpServers: {} }))
  await connectClaude(t.deps)
  assert.deepEqual(calls.map((args) => args.slice(0, 5)), [
    ['mcp', 'remove', '--scope', 'user', 'plannotator-inbox'],
    ['mcp', 'add-json', '--scope', 'user', 'plannotator-inbox']
  ])
  assert.equal((await claudeLink(t.deps)).state, 'connected')
})

test('both agents at once, and one that is missing does not fail the other', async () => {
  const t = await setup()
  await writeFile(t.codex, CODEX_BASE)
  const result = await connectAgents(t.deps)
  assert.equal(result.ok, true)
  assert.match(result.message, /Claude Code was not found/)
  assert.match(result.message, /Codex is connected/)
  assert.equal((await disconnectAgents(t.deps)).ok, true)
  assert.equal(await readFile(t.codex, 'utf8'), CODEX_BASE)
})
