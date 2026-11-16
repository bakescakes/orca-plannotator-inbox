import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  agentLinks,
  claudeLink,
  CODEX_ENV_VARS,
  codexBlock,
  codexLink,
  connectAgents,
  connectClaude,
  connectCodex,
  connectOpenCode,
  disconnectAgents,
  disconnectClaude,
  disconnectCodex,
  disconnectOpenCode,
  openCodeLink,
  parseJsonc,
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
  const custom = `${CODEX_BASE}\n[mcp_servers.plannotator-inbox]\ncommand = "python3"\nargs = ["/opt/other/mcp.py"]\n\n[other]\nx = 1\n\n[mcp_servers.plannotator-inbox.env]\nPLANNOTATOR_DATA_DIR = "/data"\n`
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

  const custom = { mcpServers: { 'plannotator-inbox': { type: 'stdio', command: 'python3', args: ['/opt/other/mcp.py'] } } }
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

// ------------------------------------------------- Codex: the chat's environment, by name only

/** The Codex table version 0.1.1 of this plugin wrote, before Codex was given the chat's spawn token and Orca. */
const OLD_CODEX_BLOCK = codexBlock(LAUNCHER).replace(
  /^env_vars = .*$/m,
  'env_vars = ["ORCA_AGENT_SESSION_ID","ORCA_STRUCTURED_SESSION","ORCA_ENVIRONMENT","ORCA_PAIRING_CODE","ORCA_REMOTE_PAIRING","SSH_CONNECTION","SSH_CLIENT","WSL_DISTRO_NAME","PLANNOTATOR_DATA_DIR","PLANNOTATOR_BIN","PLANNOTATOR_CWD","XDG_DATA_HOME","ORCA_PLANNOTATOR_HOME"]'
)
const SECRETS = { ORCA_AGENT_SESSION_ID: 'session-value-4711', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-token-value-0815', ORCA_USER_DATA_PATH: '/user-data-value' }

test('codex: the chat variables Orca sets are passed by name, never by value', async () => {
  const t = await setup({ env: { PATH: '/nowhere', ...SECRETS } })
  await writeFile(t.codex, CODEX_BASE)
  await connectCodex(t.deps)
  const written = await readFile(t.codex, 'utf8')
  const listed = JSON.parse(/^env_vars = (.*)$/m.exec(written)![1]!) as string[]
  for (const name of ['ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_USER_DATA_PATH', 'ORCA_CLI_COMMAND',
    'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING', 'ORCA_TERMINAL_HANDLE', 'PLANNOTATOR_DATA_DIR']) {
    assert.ok(listed.includes(name), name)
  }
  assert.deepEqual(listed, CODEX_ENV_VARS)
  for (const value of Object.values(SECRETS)) assert.ok(!written.includes(value), value)
})

test('codex: an entry an earlier version wrote is recognised and its list updated in place', async () => {
  const stock = `[mcp_servers.plannotator-inbox]\ncommand = "/Users/someone/.local/bin/plannotator"\nargs = ["inbox", "mcp"]`
  const before = `${CODEX_BASE}\n# my own note about the inbox\n${OLD_CODEX_BLOCK}\nenv = { PLANNOTATOR_BIN = "/Users/someone/.local/bin/plannotator" }\nstartup_timeout_sec = 30\n\n# trusted\n[projects."/x"]\ntrust_level = "trusted"\n`
  const t = await setup({ env: { PATH: '/nowhere', ...SECRETS }, store: memoryStore({ 'connect.codex.original': stock }) })
  await writeFile(t.codex, before)
  const link = await codexLink(t.deps)
  assert.equal(link.state, 'absent', 'the panel offers Connect for it')
  assert.match(link.detail, /earlier version of this plugin/)

  const result = await connectCodex(t.deps)
  assert.deepEqual(result, { ok: true, message: 'Codex’s connection is updated. It applies to chats started from now on.' })
  const after = await readFile(t.codex, 'utf8')
  assert.equal(after, before.replace(/^env_vars = .*$/m, `env_vars = ${JSON.stringify(CODEX_ENV_VARS)}`), 'only the env_vars line changed')
  for (const value of Object.values(SECRETS)) assert.ok(!after.includes(value))
  assert.equal(await readFile(`${t.codex}.before-orca-plannotator-inbox`, 'utf8'), before)
  assert.equal((await codexLink(t.deps)).state, 'connected')
  assert.equal((await connectCodex(t.deps)).message, 'Codex is already connected.')

  // What the first Connect replaced is still what Disconnect puts back.
  await disconnectCodex(t.deps)
  const restored = await readFile(t.codex, 'utf8')
  assert.ok(restored.includes(stock))
  assert.ok(!restored.includes(LAUNCHER))
  assert.ok(restored.includes('[projects."/x"]\ntrust_level = "trusted"'))
})

test('codex: an outdated own entry can be disconnected without updating it first', async () => {
  const t = await setup()
  await writeFile(t.codex, `${CODEX_BASE}\n${OLD_CODEX_BLOCK}\n`)
  assert.equal((await disconnectCodex(t.deps)).message, 'Codex is disconnected.')
  assert.equal(await readFile(t.codex, 'utf8'), CODEX_BASE)
})

test('codex: a change made between reading and writing is never overwritten', async () => {
  const edited = `${CODEX_BASE}\n[mcp_servers.someone-else]\ncommand = "x"\n`
  const t = await setup({ beforeWrite: async (path) => writeFile(path, edited) })
  await writeFile(t.codex, CODEX_BASE)
  const result = await connectAgents(t.deps, 'codex')
  assert.equal(result.ok, false)
  assert.match(result.message, /^Codex: Codex’s settings changed while this was writing them; nothing was written\. Try again\.$/)
  assert.equal(await readFile(t.codex, 'utf8'), edited)
})

// --------------------------------------------------------------------------- OpenCode

async function openCodeSetup(overrides: Partial<ConnectDeps> = {}) {
  const t = await setup({ find: (name) => (name === 'opencode' ? '/bin/opencode' : null), ...overrides })
  const dir = join(t.home, '.config', 'opencode')
  await mkdir(dir, { recursive: true })
  return { ...t, dir, json: join(dir, 'opencode.json'), jsonc: join(dir, 'opencode.jsonc') }
}

const OURS = { type: 'local', command: [LAUNCHER], enabled: true }

test('jsonc: comments, trailing commas and strings that look like comments are read; duplicate keys are refused', () => {
  const doc = parseJsonc('﻿{\n  // a "comment" { with braces\n  "a": "http://x/*y*/", /* b */ "b": [1, 2,],\n}\n')
  assert.deepEqual(doc.value, { a: 'http://x/*y*/', b: [1, 2] })
  assert.throws(() => parseJsonc('{"a": 1, "a": 2}'), /duplicate key "a"/)
  assert.throws(() => parseJsonc('{"a": 1 /* open'), /unclosed comment/)
  assert.throws(() => parseJsonc('[]'), /not a JSON object/)
})

test('opencode: connect adds one entry to opencode.json and disconnect gives the file back byte for byte', async () => {
  const t = await openCodeSetup({ env: { PATH: '/nowhere', ...SECRETS } })
  const before = `{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/claude",\n  "mcp": {\n    "paper": { "type": "remote", "url": "http://127.0.0.1:1/mcp" }\n  }\n}\n`
  await writeFile(t.json, before)
  assert.equal((await openCodeLink(t.deps)).state, 'absent')
  assert.deepEqual(await connectOpenCode(t.deps), { ok: true, message: 'OpenCode is connected. It applies to chats started from now on.' })
  const after = await readFile(t.json, 'utf8')
  const parsed = JSON.parse(after)
  assert.deepEqual(parsed.mcp['plannotator-inbox'], OURS)
  assert.deepEqual(parsed.mcp.paper, { type: 'remote', url: 'http://127.0.0.1:1/mcp' })
  assert.equal(parsed.model, 'anthropic/claude')
  for (const value of Object.values(SECRETS)) assert.ok(!after.includes(value))
  assert.ok(after.includes('  "mcp": {\n    "plannotator-inbox": {\n      "type": "local",'), 'written in the file’s own indentation')
  assert.equal(await readFile(`${t.json}.before-orca-plannotator-inbox`, 'utf8'), before)
  assert.equal((await openCodeLink(t.deps)).state, 'connected')
  assert.equal((await connectOpenCode(t.deps)).message, 'OpenCode is already connected.')
  assert.equal(await readFile(t.json, 'utf8'), after)

  assert.equal((await disconnectOpenCode(t.deps)).message, 'OpenCode is disconnected.')
  assert.equal(await readFile(t.json, 'utf8'), before)
  assert.equal((await openCodeLink(t.deps)).state, 'absent')
})

test('opencode: a JSONC file keeps every comment, and an `mcp` Connect added goes again', async () => {
  const t = await openCodeSetup()
  const before = `// my opencode settings\n{\n\t"model": "x", // the model I like\n\t/* plugins */\n\t"plugin": ["a",],\n}\n`
  await writeFile(t.jsonc, before)
  await connectOpenCode(t.deps)
  const after = await readFile(t.jsonc, 'utf8')
  for (const comment of ['// my opencode settings', '// the model I like', '/* plugins */']) assert.ok(after.includes(comment), comment)
  assert.deepEqual(parseJsonc(after).value, { mcp: { 'plannotator-inbox': OURS }, model: 'x', plugin: ['a'] })
  assert.ok(after.includes('\n\t"mcp": {\n\t\t"plannotator-inbox": {'), 'tabs, as the file uses')
  await disconnectOpenCode(t.deps)
  assert.equal(await readFile(t.jsonc, 'utf8'), before)
})

test('opencode: with opencode.json and opencode.jsonc, the entry goes in the one OpenCode reads last', async () => {
  const t = await openCodeSetup()
  await writeFile(t.json, '{}\n')
  await writeFile(t.jsonc, '{ "mcp": {} }\n')
  await connectOpenCode(t.deps)
  assert.equal(await readFile(t.json, 'utf8'), '{}\n')
  assert.deepEqual(parseJsonc(await readFile(t.jsonc, 'utf8')).value, { mcp: { 'plannotator-inbox': OURS } })
  await disconnectOpenCode(t.deps)
  assert.equal(await readFile(t.jsonc, 'utf8'), '{ "mcp": {} }\n')
})

test('opencode: when the added text was edited around, disconnect still cuts only the entry', async () => {
  const t = await openCodeSetup()
  await writeFile(t.json, '{\n  "mcp": {\n    "a": { "type": "local", "command": ["a"] }\n  }\n}\n')
  await connectOpenCode(t.deps)
  // Someone reformats the entry Connect added.
  const edited = (await readFile(t.json, 'utf8')).replace(/"plannotator-inbox": \{[\s\S]*?\n {4}\}/, `"plannotator-inbox": ${JSON.stringify(OURS)}`)
  await writeFile(t.json, edited)
  assert.equal((await openCodeLink(t.deps)).state, 'connected')
  await disconnectOpenCode(t.deps)
  assert.equal(await readFile(t.json, 'utf8'), '{\n  "mcp": {\n    "a": { "type": "local", "command": ["a"] }\n  }\n}\n')
})

test('opencode: Plannotator’s plain entry is replaced and put back byte for byte', async () => {
  const t = await openCodeSetup()
  const stock = `{\n      // added by hand\n      "type": "local",\n      "command": ["/Users/someone/.local/bin/plannotator", "inbox", "mcp"],\n      "environment": { "PLANNOTATOR_DATA_DIR": "/data/inbox" },\n      "enabled": true,\n    }`
  const before = `{\n  "mcp": {\n    "plannotator-inbox": ${stock},\n    "b": { "type": "remote", "url": "http://x" }\n  }\n}\n`
  await writeFile(t.jsonc, before)
  assert.equal((await openCodeLink(t.deps)).state, 'plannotator')
  await connectOpenCode(t.deps)
  assert.equal((await openCodeLink(t.deps)).state, 'connected')
  const entry = (parseJsonc(await readFile(t.jsonc, 'utf8')).value.mcp as Record<string, unknown>)['plannotator-inbox']
  assert.deepEqual(entry, { ...OURS, environment: { PLANNOTATOR_DATA_DIR: '/data/inbox', PLANNOTATOR_BIN: '/Users/someone/.local/bin/plannotator' } },
    'the launcher runs the binary that entry ran and opens the Inbox it opened')
  assert.equal((await disconnectOpenCode(t.deps)).message, 'OpenCode is back on its earlier Plannotator entry.')
  assert.equal(await readFile(t.jsonc, 'utf8'), before)
})

test('opencode: an entry this plugin does not recognise is never touched', async () => {
  for (const [name, text] of [
    ['opencode.json', '{ "mcp": { "plannotator-inbox": { "type": "local", "command": ["python3", "/opt/other/mcp.py"] } } }\n'],
    ['opencode.json', '{ "mcp": { "plannotator-inbox": { "type": "remote", "url": "http://127.0.0.1:19432/mcp" } } }\n'],
    ['config.json', `{ "mcp": { "plannotator-inbox": { "type": "local", "command": ["${LAUNCHER}"] } } }\n`],
    ['opencode.json', '{ "mcp": [] }\n'],
    ['opencode.json', '{ "mcp": {}, "mcp": {} }\n'],
    ['opencode.json', '{ "unfinished": \n']
  ] as const) {
    const t = await openCodeSetup()
    await writeFile(join(t.dir, name), text)
    if (name === 'config.json') await writeFile(t.json, '{}\n')
    assert.equal((await openCodeLink(t.deps)).state, 'other', text)
    assert.equal((await connectOpenCode(t.deps)).ok, false)
    assert.equal((await disconnectOpenCode(t.deps)).ok, true)
    assert.equal(await readFile(join(t.dir, name), 'utf8'), text)
    if (name === 'config.json') assert.equal(await readFile(t.json, 'utf8'), '{}\n')
  }
})

test('opencode: a change made between reading and writing is never overwritten', async () => {
  const t = await openCodeSetup({ beforeWrite: async (path) => writeFile(path, '{ "model": "changed meanwhile" }\n') })
  await writeFile(t.json, '{}\n')
  const result = await connectAgents(t.deps, 'opencode')
  assert.deepEqual(result, { ok: false, message: 'OpenCode: OpenCode’s settings changed while this was writing them; nothing was written. Try again.' })
  assert.equal(await readFile(t.json, 'utf8'), '{ "model": "changed meanwhile" }\n')
})

test('opencode: missing without a settings file, and nothing is created (stock Plannotator never creates one either)', async () => {
  const absent = await setup()
  assert.deepEqual(await openCodeLink(absent.deps), { agent: 'opencode', name: 'OpenCode', state: 'missing', detail: 'OpenCode was not found on this computer.' })

  const t = await setup({ find: (name) => (name === 'opencode2' ? '/bin/opencode2' : null) })
  const link = await openCodeLink(t.deps)
  assert.equal(link.state, 'missing')
  assert.match(link.detail, /has no settings file\. Create .*\.config[\\/]opencode[\\/]opencode\.json/)
  assert.equal((await connectOpenCode(t.deps)).ok, true)
  assert.equal(existsSync(join(t.home, '.config')), false)
})

test('opencode: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, name the settings folder', async () => {
  const t = await setup()
  const xdg = join(t.home, 'xdg')
  await mkdir(join(xdg, 'opencode'), { recursive: true })
  await writeFile(join(xdg, 'opencode', 'opencode.json'), '{}')
  const viaXdg = { ...t.deps, env: { XDG_CONFIG_HOME: xdg } }
  await connectOpenCode(viaXdg)
  assert.equal((await openCodeLink(viaXdg)).state, 'connected')

  const own = join(t.home, 'own')
  await mkdir(own)
  await writeFile(join(own, 'opencode.jsonc'), '{}')
  const viaDir = { ...t.deps, env: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: own } }
  assert.equal((await openCodeLink(viaDir)).state, 'absent')
})

test('all agents together, and nothing is ever written for Antigravity', async () => {
  const t = await openCodeSetup()
  await writeFile(t.codex, CODEX_BASE)
  await writeFile(t.json, '{}\n')
  assert.deepEqual((await agentLinks(t.deps)).map((link) => [link.agent, link.state]), [['claude', 'missing'], ['codex', 'absent'], ['opencode', 'absent']])
  const result = await connectAgents(t.deps)
  assert.equal(result.ok, true)
  assert.match(result.message, /Codex is connected.*OpenCode is connected/)
  assert.equal(existsSync(join(t.home, '.gemini')), false)
  assert.equal((await disconnectAgents(t.deps)).ok, true)
  assert.equal(await readFile(t.json, 'utf8'), '{}\n')
  assert.equal(existsSync(join(t.home, '.gemini')), false)
})
