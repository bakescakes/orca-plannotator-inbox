// "Connect agents": points Claude Code and Codex at the launcher, so their Orca chats reach the
// Inbox as Orca chats. Orca plugins cannot contribute MCP servers yet, so this writes the one
// `plannotator-inbox` entry each agent reads at user level, and can put back what it replaced.
//
// It never touches an entry it does not recognise: only a missing entry, its own entry, or
// Plannotator's plain `plannotator inbox mcp` entry (which it remembers and restores).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import type { KeyValue } from './ledger'
import type { Env } from './paths'
import type { ActionResult, AgentLink } from './protocol'
import { errorText, isRecord, type Json } from './util'

export const SERVER = 'plannotator-inbox'
/** What a Codex MCP server may read from the chat's environment; Codex passes nothing else. */
export const CODEX_ENV_VARS = [
  'ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING',
  'SSH_CONNECTION', 'SSH_CLIENT', 'WSL_DISTRO_NAME', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_BIN', 'PLANNOTATOR_CWD',
  'XDG_DATA_HOME', 'ORCA_PLANNOTATOR_HOME'
]
/** Read by people and by agents told to "connect yourself": it says this entry already is the connection. */
const MARK =
  '# Plannotator\'s own stdio server (`plannotator inbox mcp`), started through the Plannotator Inbox plugin for Orca so replies\n' +
  '# come back to Orca chats. Already connected: change nothing. The plugin\'s "Disconnect agents" command removes it.'
const CLAUDE_ORIGINAL = 'connect.claude.original'
const CODEX_ORIGINAL = 'connect.codex.original'

export type RunCli = (file: string, args: string[], env: Env) => Promise<{ code: number; output: string }>
export type ConnectDeps = {
  home: string
  env: Env
  /** Absolute path of the launcher in the shared folder. */
  launcher: string
  store: KeyValue
  run?: RunCli
  /** Finds an agent's own CLI; null when it is not installed. */
  find?: (name: string) => string | null
}

const defaultRun: RunCli = (file, args, env) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { env: env as NodeJS.ProcessEnv, timeout: 20_000, cwd: '/', windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
      })
    } catch (error) {
      // Windows refuses to start a `.cmd` (an npm-installed CLI) this way; the caller then edits the settings file itself.
      resolve({ code: 1, output: error instanceof Error ? error.message : String(error) })
    }
  })

export function findOnPath(name: string, env: Env, home: string): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  const folders = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const folder of folders) {
    for (const candidate of names) {
      if (existsSync(join(folder, candidate))) return join(folder, candidate)
    }
  }
  return null
}

function cliEnv(env: Env): Env {
  const clean: Env = { ...env }
  // The worker is Orca's binary in Node mode; an agent CLI started from it must not inherit that.
  delete clean.ELECTRON_RUN_AS_NODE
  return clean
}

function isPlannotatorCommand(command: unknown, args: unknown): boolean {
  if (typeof command !== 'string' || !Array.isArray(args)) return false
  const name = basename(command).toLowerCase().replace(/\.(exe|cmd)$/, '')
  return name === 'plannotator' && args.length >= 2 && args[0] === 'inbox' && args[1] === 'mcp'
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const mode = await stat(path).then((info) => info.mode & 0o777, () => 0o600)
  const temporary = `${path}.${process.pid}.orca-plannotator.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, path)
}

// ---------------------------------------------------------------- Claude Code

function claudeConfig(deps: ConnectDeps): string {
  const dir = (deps.env.CLAUDE_CONFIG_DIR ?? '').trim()
  return dir ? join(dir, '.claude.json') : join(deps.home, '.claude.json')
}

async function readClaude(deps: ConnectDeps): Promise<{ config: Record<string, unknown>; entry: unknown; signature: string } | null> {
  const path = claudeConfig(deps)
  let text: string
  let info
  try {
    info = await stat(path)
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const config: unknown = JSON.parse(text)
  if (!isRecord(config)) throw new Error('Claude Code’s settings file has an unknown shape.')
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {}
  return { config, entry: servers[SERVER], signature: `${info.mtimeMs}:${info.size}` }
}

async function hasPlannotatorClaudePlugin(deps: ConnectDeps): Promise<boolean> {
  try {
    const dir = (deps.env.CLAUDE_CONFIG_DIR ?? '').trim() || join(deps.home, '.claude')
    const installed: unknown = JSON.parse(await readFile(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'))
    const plugins = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {}
    return Object.entries(plugins).some(([name, value]) => /^plannotator@/.test(name) && (!Array.isArray(value) || value.length > 0))
  } catch {
    return false
  }
}

export async function claudeLink(deps: ConnectDeps): Promise<AgentLink> {
  const link = (state: AgentLink['state'], detail: string): AgentLink => ({ agent: 'claude', name: 'Claude Code', state, detail })
  let current
  try {
    current = await readClaude(deps)
  } catch (error) {
    return link('other', errorText(error))
  }
  const entry = current?.entry
  if (isRecord(entry) && entry.command === deps.launcher) return link('connected', 'New Claude chats in Orca reach the Inbox as Orca chats.')
  if (entry !== undefined) {
    if (isRecord(entry) && isPlannotatorCommand(entry.command, entry.args ?? [])) {
      return link('plannotator', 'Runs Plannotator directly: messages arrive, but replies do not come back into Orca chats.')
    }
    return link('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
  }
  if (await hasPlannotatorClaudePlugin(deps)) return link('builtin', 'Plannotator’s own Claude Code plugin is installed and already handles Orca chats.')
  if (current === null && (deps.find ?? ((name) => findOnPath(name, deps.env, deps.home)))('claude') === null) {
    return link('missing', 'Claude Code was not found on this computer.')
  }
  return link('absent', 'Not connected yet.')
}

async function setClaudeEntry(deps: ConnectDeps, entry: Json | null): Promise<void> {
  const cli = (deps.find ?? ((name) => findOnPath(name, deps.env, deps.home)))('claude')
  if (cli) {
    // Claude Code's own command knows where its settings live and locks the file while it writes.
    const run = deps.run ?? defaultRun
    const env = cliEnv(deps.env)
    const removed = await run(cli, ['mcp', 'remove', '--scope', 'user', SERVER], env)
    if (entry === null) {
      if (removed.code === 0) return
    } else {
      const added = await run(cli, ['mcp', 'add-json', '--scope', 'user', SERVER, JSON.stringify(entry)], env)
      if (added.code === 0) return
    }
    // Fall through: check what the file says, and edit it directly when the command did not do it.
    const now = await readClaude(deps).catch(() => null)
    if (entry === null ? now?.entry === undefined : JSON.stringify(now?.entry) === JSON.stringify(entry)) return
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readClaude(deps)
    const config = current?.config ?? {}
    const servers = { ...(isRecord(config.mcpServers) ? config.mcpServers : {}) }
    if (entry === null) delete servers[SERVER]
    else servers[SERVER] = entry
    const next = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`
    // Claude Code rewrites this file often. Write only if it has not changed since it was read.
    const path = claudeConfig(deps)
    const before = await stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => null)
    if (current !== null && before !== current.signature) continue
    await writeAtomic(path, next)
    return
  }
  throw new Error('Claude Code’s settings kept changing; nothing was written. Try again.')
}

export async function connectClaude(deps: ConnectDeps): Promise<ActionResult> {
  const link = await claudeLink(deps)
  if (link.state === 'connected') return { ok: true, message: 'Claude Code is already connected.' }
  if (link.state === 'builtin' || link.state === 'missing' || link.state === 'other') return { ok: link.state !== 'other', message: `Claude Code: ${link.detail}` }
  // What the earlier Plannotator entry set for its server (which Inbox, which binary) still applies:
  // the launcher starts the same server and reads the same variables.
  const env: Record<string, string> = {}
  if (link.state === 'plannotator') {
    const current = await readClaude(deps)
    await deps.store.set(CLAUDE_ORIGINAL, current!.entry as Json)
    const entry = isRecord(current!.entry) ? current!.entry : {}
    for (const [name, value] of Object.entries(isRecord(entry.env) ? entry.env : {})) {
      if (typeof value === 'string') env[name] = value
    }
    // The launcher looks for Plannotator itself; a binary that entry named by its full path is the one to run.
    if (typeof entry.command === 'string' && isAbsolute(entry.command) && !env.PLANNOTATOR_BIN) env.PLANNOTATOR_BIN = entry.command
  }
  await setClaudeEntry(deps, { type: 'stdio', command: deps.launcher, args: [], env })
  return { ok: true, message: 'Claude Code is connected. It applies to chats started from now on.' }
}

export async function disconnectClaude(deps: ConnectDeps): Promise<ActionResult> {
  const link = await claudeLink(deps)
  if (link.state !== 'connected') return { ok: true, message: 'Claude Code was not connected by this plugin.' }
  const original = await deps.store.get(CLAUDE_ORIGINAL)
  await setClaudeEntry(deps, isRecord(original) ? (original as Json) : null)
  await deps.store.delete(CLAUDE_ORIGINAL)
  return { ok: true, message: isRecord(original) ? 'Claude Code is back on its earlier Plannotator entry.' : 'Claude Code is disconnected.' }
}

// ---------------------------------------------------------------------- Codex

function codexConfig(deps: ConnectDeps): string {
  const dir = (deps.env.CODEX_HOME ?? '').trim()
  return join(dir || join(deps.home, '.codex'), 'config.toml')
}

type TomlBlock = { key: string; start: number; end: number }

/** `[a."b-c".d]` -> `a.b-c.d`; null for a line that is not a table header. */
function headerKey(line: string): string | null {
  const match = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line)
  if (!match) return null
  return match[1]!
    .split('.')
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .join('.')
}

/**
 * The file's tables as line ranges. Only what is needed to move whole tables around: it knows
 * table headers and multi-line strings (so a `[...]` line inside one is not taken for a header),
 * and nothing else about TOML.
 */
export function tomlBlocks(lines: string[]): TomlBlock[] {
  const blocks: TomlBlock[] = []
  let open: string | null = null
  let current: TomlBlock | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (open === null) {
      const key = /^\s*\[\[/.test(line) ? `[[${index}]]` : headerKey(line)
      if (key !== null) {
        if (current) current.end = index
        current = { key, start: index, end: lines.length }
        blocks.push(current)
        continue
      }
    }
    // Count the multi-line string delimiters on this line to know whether one is open after it.
    let rest = line
    for (;;) {
      if (open !== null) {
        const close = rest.indexOf(open)
        if (close === -1) break
        rest = rest.slice(close + 3)
        open = null
        continue
      }
      const comment = rest.indexOf('#')
      const double = rest.indexOf('"""')
      const single = rest.indexOf("'''")
      const next = [double, single].filter((at) => at !== -1).sort((a, b) => a - b)[0]
      if (next === undefined || (comment !== -1 && comment < next)) break
      open = rest.slice(next, next + 3)
      rest = rest.slice(next + 3)
    }
  }
  return blocks
}

const TABLE = `mcp_servers.${SERVER}`
const isOurs = (key: string): boolean => key === TABLE || key.startsWith(`${TABLE}.`)

type CodexView = { lines: string[]; blocks: TomlBlock[]; own: TomlBlock[]; text: string; inline: boolean }

async function readCodex(deps: ConnectDeps): Promise<CodexView | null> {
  let text: string
  try {
    text = await readFile(codexConfig(deps), 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const blocks = tomlBlocks(lines)
  const own = blocks.filter((block) => isOurs(block.key))
  // The same server written another way (an inline table, a dotted key such as `plannotator-inbox.command`
  // under `[mcp_servers]`): not something to edit by hand here, and adding a table would declare it twice.
  const outside = lines.filter((_, index) => !own.some((block) => index >= block.start && index < block.end))
  const inline = outside.some((line) => /^\s*(?:mcp_servers\s*[.=]|["']?plannotator-inbox["']?\s*[.=])/.test(line) && line.includes(SERVER))
  return { lines, blocks, own, text, inline }
}

function ownText(view: CodexView): string {
  return view.own.map((block) => view.lines.slice(block.start, block.end).join('\n').trimEnd()).join('\n\n')
}

function tomlString(source: string, name: string): unknown {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(source)
  if (!match) return undefined
  try {
    // Basic strings and arrays of them read as JSON; anything fancier is simply "not recognised".
    return JSON.parse(match[1]!)
  } catch {
    return match[1]
  }
}

export async function codexLink(deps: ConnectDeps): Promise<AgentLink> {
  const link = (state: AgentLink['state'], detail: string): AgentLink => ({ agent: 'codex', name: 'Codex', state, detail })
  const view = await readCodex(deps)
  if (view === null) {
    const installed = existsSync(join(codexConfig(deps), '..')) || (deps.find ?? ((name) => findOnPath(name, deps.env, deps.home)))('codex') !== null
    return installed ? link('absent', 'Not connected yet.') : link('missing', 'Codex was not found on this computer.')
  }
  if (view.inline) return link('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
  if (view.own.length === 0) return link('absent', 'Not connected yet.')
  const main = view.own.filter((block) => block.key === TABLE)
  const source = ownText(view)
  const command = tomlString(source, 'command')
  if (main.length === 1 && command === deps.launcher) return link('connected', 'New Codex chats in Orca reach the Inbox as Orca chats.')
  if (main.length === 1 && view.own.length === 1 && isPlannotatorCommand(command, tomlString(source, 'args') ?? [])) {
    return link('plannotator', 'Runs Plannotator directly: messages arrive, but replies do not come back into Orca chats.')
  }
  return link('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
}

/** `env` is the earlier entry's own `env = { … }` line, kept as it was written. */
export function codexBlock(launcher: string, env: string | null = null): string {
  return [
    `[${TABLE}]`,
    MARK,
    `command = ${JSON.stringify(launcher)}`,
    'args = []',
    `env_vars = ${JSON.stringify(CODEX_ENV_VARS)}`,
    ...(env ? [env] : [])
  ].join('\n')
}

async function rewriteCodex(deps: ConnectDeps, view: CodexView | null, add: string | null): Promise<void> {
  const path = codexConfig(deps)
  let kept = view ? view.lines.filter((_, index) => !view.own.some((block) => index >= block.start && index < block.end)) : []
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept = kept.slice(0, -1)
  const parts = [kept.join('\n'), add ?? ''].filter((part) => part !== '')
  if (view) await copyFile(path, `${path}.before-orca-plannotator-inbox`).catch(() => undefined)
  await writeAtomic(path, `${parts.join('\n\n')}\n`)
}

export async function connectCodex(deps: ConnectDeps): Promise<ActionResult> {
  const link = await codexLink(deps)
  if (link.state === 'connected') return { ok: true, message: 'Codex is already connected.' }
  if (link.state === 'missing' || link.state === 'other') return { ok: link.state === 'missing', message: `Codex: ${link.detail}` }
  const view = await readCodex(deps)
  let env: string | null = null
  if (link.state === 'plannotator' && view) {
    const original = ownText(view)
    await deps.store.set(CODEX_ORIGINAL, original)
    // What that entry set for its server (which Inbox, which binary) still applies to the launcher.
    env = original.split('\n').find((line) => /^\s*env\s*=\s*\{.*\}\s*(?:#.*)?$/.test(line))?.trim() ?? null
    // The launcher looks for Plannotator itself; a binary that entry named by its full path is the one to run.
    const command = tomlString(original, 'command')
    if (typeof command === 'string' && isAbsolute(command) && !/\bPLANNOTATOR_BIN\b/.test(env ?? '')) {
      const binary = `PLANNOTATOR_BIN = ${JSON.stringify(command)}`
      env = env === null ? `env = { ${binary} }` : env.replace(/\{\s*(\})?/, (_all, empty) => (empty ? `{ ${binary} }` : `{ ${binary}, `))
    }
  }
  await rewriteCodex(deps, view, codexBlock(deps.launcher, env))
  return { ok: true, message: 'Codex is connected. It applies to chats started from now on.' }
}

export async function disconnectCodex(deps: ConnectDeps): Promise<ActionResult> {
  const link = await codexLink(deps)
  if (link.state !== 'connected') return { ok: true, message: 'Codex was not connected by this plugin.' }
  const original = await deps.store.get(CODEX_ORIGINAL)
  await rewriteCodex(deps, await readCodex(deps), typeof original === 'string' && original !== '' ? original : null)
  await deps.store.delete(CODEX_ORIGINAL)
  return { ok: true, message: typeof original === 'string' && original !== '' ? 'Codex is back on its earlier Plannotator entry.' : 'Codex is disconnected.' }
}

// -------------------------------------------------------------------- together

export async function agentLinks(deps: ConnectDeps): Promise<AgentLink[]> {
  return Promise.all([claudeLink(deps), codexLink(deps)])
}

async function each(
  agent: 'claude' | 'codex' | undefined,
  claude: () => Promise<ActionResult>,
  codex: () => Promise<ActionResult>
): Promise<ActionResult> {
  const results: ActionResult[] = []
  for (const [name, action] of [['claude', claude], ['codex', codex]] as const) {
    if (agent !== undefined && agent !== name) continue
    try {
      results.push(await action())
    } catch (error) {
      results.push({ ok: false, message: `${name === 'claude' ? 'Claude Code' : 'Codex'}: ${errorText(error)}` })
    }
  }
  return { ok: results.every((result) => result.ok), message: results.map((result) => result.message).join(' ') }
}

export function connectAgents(deps: ConnectDeps, agent?: 'claude' | 'codex'): Promise<ActionResult> {
  return each(agent, () => connectClaude(deps), () => connectCodex(deps))
}

export function disconnectAgents(deps: ConnectDeps, agent?: 'claude' | 'codex'): Promise<ActionResult> {
  return each(agent, () => disconnectClaude(deps), () => disconnectCodex(deps))
}
