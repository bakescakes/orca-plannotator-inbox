// "Connect agents": points Claude Code, Codex and OpenCode at the launcher, so their Orca chats
// reach the Inbox as Orca chats. Orca plugins cannot contribute MCP servers yet, so this writes the
// one `plannotator-inbox` entry each agent reads at user level, and can put back what it replaced.
//
// It never touches an entry it does not recognise: only a missing entry, its own entry, or
// Plannotator's plain `plannotator inbox mcp` entry (which it remembers and restores). It never
// restarts or signals an agent, and never writes Antigravity's (`~/.gemini`) settings: stock
// Plannotator connects Antigravity itself.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { KeyValue } from './ledger'
import type { Env } from './paths'
import type { ActionResult, AgentId, AgentLink } from './protocol'
import { errorText, isRecord, type Json } from './util'

export const SERVER = 'plannotator-inbox'
/**
 * What a Codex MCP server may read from the chat's environment; Codex passes nothing else. Names
 * only: the values stay in the chat's own environment. Orca sets the first six for a native chat
 * (structured-session-child-env.ts), and blanks the three remote selectors after them.
 */
export const CODEX_ENV_VARS = [
  'ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_USER_DATA_PATH',
  'ORCA_CLI_COMMAND', 'ORCA_TERMINAL_HANDLE', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING',
  'SSH_CONNECTION', 'SSH_CLIENT', 'WSL_DISTRO_NAME', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_BIN', 'PLANNOTATOR_CWD',
  'XDG_DATA_HOME', 'ORCA_PLANNOTATOR_HOME'
]
/** Read by people and by agents told to "connect yourself": it says this entry already is the connection. */
const MARK =
  '# Plannotator\'s own stdio server (`plannotator inbox mcp`), started through the Plannotator Inbox plugin for Orca so replies\n' +
  '# come back to Orca chats. Already connected: change nothing. The plugin\'s "Disconnect agents" command removes it.'
const CLAUDE_ORIGINAL = 'connect.claude.original'
const CODEX_ORIGINAL = 'connect.codex.original'
const OPENCODE_ORIGINAL = 'connect.opencode.original'

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
  /** Called right before a settings file is checked one last time and replaced; tests change the file here. */
  beforeWrite?: (path: string) => Promise<void>
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

/**
 * Replaces a settings file only if it still holds exactly what the change was made from (`before`,
 * null for a file that did not exist), so an edit made meanwhile by the agent or a person is never lost.
 */
async function writeChecked(deps: ConnectDeps, name: string, path: string, before: string | null, next: string): Promise<void> {
  await deps.beforeWrite?.(path)
  const now = await readFile(path, 'utf8').catch(() => null)
  if (now !== before) throw new Error(`${name}’s settings changed while this was writing them; nothing was written. Try again.`)
  await writeAtomic(path, next)
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

/**
 * Codex's state, and whether its entry is this plugin's own. An own entry written by an earlier
 * version (an `env_vars` list missing names Codex must now pass) reads as `absent`, the state the
 * panel offers "Connect agents" for; Connect then updates that list in place.
 */
async function codexState(deps: ConnectDeps): Promise<{ link: AgentLink; view: CodexView | null; ours: boolean; outdated: boolean }> {
  const view = await readCodex(deps)
  const result = (state: AgentLink['state'], detail: string, ours = false, outdated = false) =>
    ({ link: { agent: 'codex', name: 'Codex', state, detail } as AgentLink, view, ours, outdated })
  if (view === null) {
    const installed = existsSync(join(codexConfig(deps), '..')) || (deps.find ?? ((name) => findOnPath(name, deps.env, deps.home)))('codex') !== null
    return installed ? result('absent', 'Not connected yet.') : result('missing', 'Codex was not found on this computer.')
  }
  if (view.inline) return result('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
  if (view.own.length === 0) return result('absent', 'Not connected yet.')
  const main = view.own.filter((block) => block.key === TABLE)
  const source = ownText(view)
  const command = tomlString(source, 'command')
  if (main.length === 1 && command === deps.launcher) {
    const listed = tomlString(source, 'env_vars')
    // A list written some other way (over several lines, say) is not judged: it was edited by hand.
    if (listed === undefined || (Array.isArray(listed) && CODEX_ENV_VARS.some((name) => !listed.includes(name)))) {
      return result('absent', 'Connected by an earlier version of this plugin, which does not pass Codex everything an Orca chat needs. Connect again to update it.', true, true)
    }
    return result('connected', 'New Codex chats in Orca reach the Inbox as Orca chats.', true)
  }
  if (main.length === 1 && view.own.length === 1 && isPlannotatorCommand(command, tomlString(source, 'args') ?? [])) {
    return result('plannotator', 'Runs Plannotator directly: messages arrive, but replies do not come back into Orca chats.')
  }
  return result('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
}

export async function codexLink(deps: ConnectDeps): Promise<AgentLink> {
  return (await codexState(deps)).link
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
  await writeChecked(deps, 'Codex', path, view ? view.text : null, `${parts.join('\n\n')}\n`)
}

/** Brings an own entry's `env_vars` up to `CODEX_ENV_VARS`, changing that one line and nothing else. */
async function upgradeCodex(deps: ConnectDeps, view: CodexView): Promise<void> {
  const main = view.own.find((block) => block.key === TABLE)!
  const lines = [...view.lines]
  const at = lines.findIndex((line, index) => index >= main.start && index < main.end && /^\s*env_vars\s*=/.test(line))
  const listed = at === -1 ? [] : (tomlString(lines[at]!, 'env_vars') as string[])
  // The current list, then any name someone added by hand.
  const line = `env_vars = ${JSON.stringify([...CODEX_ENV_VARS, ...listed.filter((name) => !CODEX_ENV_VARS.includes(name))])}`
  if (at !== -1) lines[at] = line
  else {
    const after = lines.findIndex((text, index) => index >= main.start && index < main.end && /^\s*(?:args|command)\s*=/.test(text))
    lines.splice((after === -1 ? main.start : after) + 1, 0, line)
  }
  const path = codexConfig(deps)
  await copyFile(path, `${path}.before-orca-plannotator-inbox`).catch(() => undefined)
  await writeChecked(deps, 'Codex', path, view.text, lines.join('\n'))
}

export async function connectCodex(deps: ConnectDeps): Promise<ActionResult> {
  const { link, view, outdated } = await codexState(deps)
  if (link.state === 'connected') return { ok: true, message: 'Codex is already connected.' }
  if (link.state === 'missing' || link.state === 'other') return { ok: link.state === 'missing', message: `Codex: ${link.detail}` }
  if (outdated && view) {
    await upgradeCodex(deps, view)
    return { ok: true, message: 'Codex’s connection is updated. It applies to chats started from now on.' }
  }
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
  const { view, ours } = await codexState(deps)
  if (!ours) return { ok: true, message: 'Codex was not connected by this plugin.' }
  const original = await deps.store.get(CODEX_ORIGINAL)
  await rewriteCodex(deps, view, typeof original === 'string' && original !== '' ? original : null)
  await deps.store.delete(CODEX_ORIGINAL)
  return { ok: true, message: typeof original === 'string' && original !== '' ? 'Codex is back on its earlier Plannotator entry.' : 'Codex is disconnected.' }
}

// ------------------------------------------------------------------- OpenCode
//
// Orca runs OpenCode as a native chat (`opencode acp`). Its global settings are JSON with comments
// in `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, as stock
// Plannotator reads them (packages/server/inbox-agents.ts `openCodeConfigDir`). The server is one
// member of `mcp`: `{ "type": "local", "command": [argv], "enabled": true, "environment": {…} }`,
// the shape stock Plannotator tells people to add (packages/inbox/harnesses.ts `hostMcpSnippet`).
// Stock never creates or edits these files ("may be JSONC and per project"), so neither does this
// when there is none: OpenCode without a settings file is `missing`.

/** Global settings files OpenCode reads, in the order it merges them (a later one wins). */
const OPENCODE_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'] as const
/** The ones this edits; `config.json` is OpenCode's older name, read here only to see a server it declares. */
const OPENCODE_WRITABLE = new Set<string>(['opencode.json', 'opencode.jsonc'])
const JSONC_MAX = 2 * 1024 * 1024

function openCodeDir(deps: ConnectDeps): string {
  const named = (name: string): string | null => {
    let value = (deps.env[name] ?? '').trim()
    if (value === '~' || value.startsWith('~/')) value = join(deps.home, value.slice(1))
    return value && isAbsolute(value) ? value : null
  }
  return named('OPENCODE_CONFIG_DIR') ?? join(named('XDG_CONFIG_HOME') ?? join(deps.home, '.config'), 'opencode')
}

type JsoncMember = { keyStart: number; start: number; end: number }
type JsoncDoc = { text: string; value: Record<string, unknown>; members: Map<string, JsoncMember>; spans: Map<string, { start: number; end: number }> }
const pathKey = (path: readonly (string | number)[]): string => JSON.stringify(path)

/**
 * JSON with comments and trailing commas, as OpenCode reads it, with where every value and object
 * member sits in the text, so an edit can change one member and leave every other byte alone.
 * A duplicate key is refused rather than guessing which one OpenCode uses.
 */
export function parseJsonc(text: string): JsoncDoc {
  if (Buffer.byteLength(text, 'utf8') > JSONC_MAX) throw new Error('the settings file is too large to edit safely')
  const spans = new Map<string, { start: number; end: number }>()
  const members = new Map<string, JsoncMember>()
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (what: string): never => {
    throw new Error(`the settings file is not valid JSON with comments (${what} at offset ${i})`)
  }
  const skip = (): void => {
    for (;;) {
      if (/\s/.test(text[i] ?? '')) i += 1
      else if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i)
        i = end === -1 ? text.length : end
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2)
        if (end === -1) fail('an unclosed comment')
        i = end + 2
      } else return
    }
  }
  const string = (): string => {
    const start = i
    i += 1
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail('an unclosed string')
    i += 1
    try {
      return JSON.parse(text.slice(start, i)) as string
    } catch {
      return fail('a bad string')
    }
  }
  const value = (path: (string | number)[]): unknown => {
    skip()
    const start = i
    let result: unknown
    if (text[i] === '{') {
      const object: Record<string, unknown> = {}
      i += 1
      skip()
      while (text[i] !== '}') {
        if (text[i] !== '"') fail('a missing key')
        const keyStart = i
        const key = string()
        if (Object.prototype.hasOwnProperty.call(object, key)) fail(`a duplicate key "${key}"`)
        skip()
        if (text[i] !== ':') fail('a missing colon')
        i += 1
        Object.defineProperty(object, key, { value: value([...path, key]), enumerable: true, writable: true, configurable: true })
        const span = spans.get(pathKey([...path, key]))!
        members.set(pathKey([...path, key]), { keyStart, start: span.start, end: span.end })
        skip()
        if (text[i] === ',') {
          i += 1
          skip()
        } else if (text[i] !== '}') fail('a missing comma')
      }
      i += 1
      result = object
    } else if (text[i] === '[') {
      const array: unknown[] = []
      i += 1
      skip()
      while (text[i] !== ']') {
        array.push(value([...path, array.length]))
        skip()
        if (text[i] === ',') {
          i += 1
          skip()
        } else if (text[i] !== ']') fail('a missing comma')
      }
      i += 1
      result = array
    } else if (text[i] === '"') {
      result = string()
    } else {
      const literal = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
      literal.lastIndex = i
      const match = literal.exec(text)
      if (!match) fail('an unexpected character')
      i += match![0].length
      result = JSON.parse(match![0])
    }
    spans.set(pathKey(path), { start, end: i })
    return result
  }
  const root = value([])
  skip()
  if (i !== text.length) fail('text after the end')
  if (!isRecord(root)) throw new Error('the settings file is not a JSON object')
  return { text, value: root, members, spans }
}

type Edit = { start: number; end: number; text: string }

/** Applies edits and proves the result means exactly `expected`: nothing but the one entry changed. */
function applyEdits(doc: JsoncDoc, edits: Edit[], expected: Record<string, unknown>): string {
  let text = doc.text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  if (!isDeepStrictEqual(parseJsonc(text).value, expected)) throw new Error('the change would have touched more than the `plannotator-inbox` entry; nothing was written')
  return text
}

/** The indentation of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))![0]
}

/** Text that adds `"key": value` as the first member of the object at `objectStart`, in the file's own indentation. */
function insertion(doc: JsoncDoc, objectStart: number, objectEnd: number, empty: boolean, key: string, value: Json): Edit {
  const outer = indentAt(doc.text, objectStart)
  const unit = /\n([ \t]+)"/.exec(doc.text)?.[1] ?? '  '
  const inner = outer + unit
  const body = JSON.stringify(value, null, unit).replace(/\n/g, `\n${inner}`)
  const text = `\n${inner}${JSON.stringify(key)}: ${body}${empty ? `\n${outer}` : ','}`
  // An empty object's blank inside (`{ }`) is replaced; one holding only comments keeps them after the new member.
  const blank = empty && /^\{\s*\}$/.test(doc.text.slice(objectStart, objectEnd))
  return { start: objectStart + 1, end: blank ? objectEnd - 1 : objectStart + 1, text }
}

/** Cuts one member with its comma and its line, keeping every other byte. */
function removal(doc: JsoncDoc, path: string[]): Edit {
  const member = doc.members.get(pathKey(path))!
  let start = member.keyStart
  let end = member.end
  const after = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*,/.exec(doc.text.slice(end))
  if (after) end += after[0].length
  else {
    const before = /,(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/.exec(doc.text.slice(0, start))
    if (before) start -= before[0].length
  }
  // The member's own line goes with it when nothing else is on it.
  const lineStart = doc.text.lastIndexOf('\n', start - 1)
  if (lineStart !== -1 && /^[ \t]*$/.test(doc.text.slice(lineStart + 1, start)) && after) start = lineStart
  return { start, end, text: '' }
}

type OpenCodeFile = { name: string; path: string; doc: JsoncDoc | null; error: string | null }
type OpenCodeView = { files: OpenCodeFile[]; withEntry: OpenCodeFile[]; target: OpenCodeFile | null }

async function readOpenCode(deps: ConnectDeps): Promise<OpenCodeView> {
  const dir = openCodeDir(deps)
  const files: OpenCodeFile[] = []
  for (const name of OPENCODE_FILES) {
    const path = join(dir, name)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    try {
      files.push({ name, path, doc: parseJsonc(text), error: null })
    } catch (error) {
      files.push({ name, path, doc: null, error: errorText(error) })
    }
  }
  const withEntry = files.filter((file) => file.doc && isRecord(file.doc.value.mcp) && Object.prototype.hasOwnProperty.call(file.doc.value.mcp, SERVER))
  // A new entry goes in the file OpenCode reads last, so it is the one that counts.
  const writable = files.filter((file) => OPENCODE_WRITABLE.has(file.name))
  return { files, withEntry, target: writable[writable.length - 1] ?? null }
}

function openCodeEntry(file: OpenCodeFile): Record<string, unknown> | null {
  const mcp = file.doc!.value.mcp as Record<string, unknown>
  return isRecord(mcp[SERVER]) ? (mcp[SERVER] as Record<string, unknown>) : null
}

const isOurOpenCode = (entry: Record<string, unknown> | null, launcher: string): boolean =>
  !!entry && entry.type === 'local' && Array.isArray(entry.command) && entry.command.length === 1 && entry.command[0] === launcher

const isPlannotatorOpenCode = (entry: Record<string, unknown> | null): boolean =>
  !!entry && entry.type === 'local' && Array.isArray(entry.command) && isPlannotatorCommand(entry.command[0], entry.command.slice(1)) && entry.command.length === 3

async function openCodeState(deps: ConnectDeps): Promise<{ link: AgentLink; view: OpenCodeView }> {
  const view = await readOpenCode(deps)
  const result = (state: AgentLink['state'], detail: string) => ({ link: { agent: 'opencode', name: 'OpenCode', state, detail } as AgentLink, view })
  const broken = view.files.find((file) => file.error !== null)
  if (broken) return result('other', `${broken.path}: ${broken.error}. This plugin leaves it alone.`)
  if (view.withEntry.length > 1) return result('other', 'Declares `plannotator-inbox` in more than one settings file, which this plugin leaves alone.')
  const holder = view.withEntry[0]
  if (holder) {
    const entry = openCodeEntry(holder)
    if (OPENCODE_WRITABLE.has(holder.name) && isOurOpenCode(entry, deps.launcher)) return result('connected', 'New OpenCode chats in Orca reach the Inbox as Orca chats.')
    if (OPENCODE_WRITABLE.has(holder.name) && isPlannotatorOpenCode(entry)) {
      return result('plannotator', 'Runs Plannotator directly: messages arrive, but replies do not come back into Orca chats.')
    }
    return result('other', 'Has its own `plannotator-inbox` server, which this plugin leaves alone.')
  }
  if (view.target) {
    if (view.target.doc!.value.mcp !== undefined && !isRecord(view.target.doc!.value.mcp)) {
      return result('other', `${view.target.path}: its \`mcp\` is not an object. This plugin leaves it alone.`)
    }
    return result('absent', 'Not connected yet.')
  }
  const installed = (deps.find ?? ((name) => findOnPath(name, deps.env, deps.home)))
  const where = join(openCodeDir(deps), 'opencode.json')
  return installed('opencode') !== null || installed('opencode2') !== null
    ? result('missing', `OpenCode has no settings file. Create ${where} (it may hold just {}) to connect it.`)
    : result('missing', 'OpenCode was not found on this computer.')
}

export async function openCodeLink(deps: ConnectDeps): Promise<AgentLink> {
  return (await openCodeState(deps)).link
}

/**
 * What Connect remembers: where it wrote; the earlier entry's exact text (`original`), or the text it
 * added (`added`, with the blank text it stood in for, `replaced`), so Disconnect can give the bytes back.
 */
type OpenCodeRecord = { path: string; original: string | null; added: string | null; replaced: string }

async function writeOpenCode(deps: ConnectDeps, file: OpenCodeFile, next: string): Promise<void> {
  // A dotfile manager's symlink stays a symlink: the file it points at is the one replaced.
  const path = await realpath(file.path).catch(() => file.path)
  const backup = `${file.path}.before-orca-plannotator-inbox`
  if (!existsSync(backup)) await copyFile(path, backup)
  await writeChecked(deps, 'OpenCode', path, file.doc!.text, next)
}

export async function connectOpenCode(deps: ConnectDeps): Promise<ActionResult> {
  const { link, view } = await openCodeState(deps)
  if (link.state === 'connected') return { ok: true, message: 'OpenCode is already connected.' }
  if (link.state === 'missing' || link.state === 'other') return { ok: link.state === 'missing', message: `OpenCode: ${link.detail}` }
  const entry: Record<string, Json> = { type: 'local', command: [deps.launcher], enabled: true }
  if (link.state === 'plannotator') {
    const file = view.withEntry[0]!
    const doc = file.doc!
    const old = openCodeEntry(file)!
    // What that entry set for its server (which Inbox, which binary) still applies to the launcher.
    const environment: Record<string, string> = {}
    for (const [name, value] of Object.entries(isRecord(old.environment) ? old.environment : {})) {
      if (typeof value === 'string') environment[name] = value
    }
    const binary = (old.command as string[])[0]!
    if (isAbsolute(binary) && !environment.PLANNOTATOR_BIN) environment.PLANNOTATOR_BIN = binary
    if (Object.keys(environment).length > 0) entry.environment = environment
    const span = doc.spans.get(pathKey(['mcp', SERVER]))!
    const expected = structuredClone(doc.value) as Record<string, unknown>
    ;(expected.mcp as Record<string, unknown>)[SERVER] = entry
    const next = applyEdits(doc, [{ start: span.start, end: span.end, text: JSON.stringify(entry) }], expected)
    const record: OpenCodeRecord = { path: file.path, original: doc.text.slice(span.start, span.end), added: null, replaced: '' }
    await deps.store.set(OPENCODE_ORIGINAL, record as unknown as Json)
    await writeOpenCode(deps, file, next)
    return { ok: true, message: 'OpenCode is connected. It applies to chats started from now on.' }
  }
  const file = view.target!
  const doc = file.doc!
  const expected = structuredClone(doc.value) as Record<string, unknown>
  const mcp = isRecord(doc.value.mcp) ? doc.value.mcp : null
  const span = doc.spans.get(pathKey(mcp ? ['mcp'] : []))!
  const edit = mcp
    ? insertion(doc, span.start, span.end, Object.keys(mcp).length === 0, SERVER, entry)
    : insertion(doc, span.start, span.end, Object.keys(doc.value).length === 0, 'mcp', { [SERVER]: entry })
  expected.mcp = { ...(mcp ?? {}), [SERVER]: entry }
  const next = applyEdits(doc, [edit], expected)
  const record: OpenCodeRecord = { path: file.path, original: null, added: edit.text, replaced: doc.text.slice(edit.start, edit.end) }
  await deps.store.set(OPENCODE_ORIGINAL, record as unknown as Json)
  await writeOpenCode(deps, file, next)
  return { ok: true, message: 'OpenCode is connected. It applies to chats started from now on.' }
}

export async function disconnectOpenCode(deps: ConnectDeps): Promise<ActionResult> {
  const { link, view } = await openCodeState(deps)
  if (link.state !== 'connected') return { ok: true, message: 'OpenCode was not connected by this plugin.' }
  const file = view.withEntry[0]!
  const doc = file.doc!
  const saved = await deps.store.get(OPENCODE_ORIGINAL)
  const record = isRecord(saved) && saved.path === file.path ? (saved as unknown as OpenCodeRecord) : null
  const expected = structuredClone(doc.value) as Record<string, unknown>
  const mcp = expected.mcp as Record<string, unknown>
  let next: string
  if (record?.original) {
    // Plannotator's own entry goes back exactly as it was written.
    const span = doc.spans.get(pathKey(['mcp', SERVER]))!
    mcp[SERVER] = parseJsonc(`{"v":${record.original}}`).value.v
    next = applyEdits(doc, [{ start: span.start, end: span.end, text: record.original }], expected)
  } else {
    delete mcp[SERVER]
    // Where the text Connect added is still there, once and untouched, taking it out gives the file back byte for byte.
    const added = record?.added ?? null
    const at = added ? doc.text.indexOf(added) : -1
    const exact = added !== null && at !== -1 && doc.text.indexOf(added, at + 1) === -1
    const restore: Edit[] = exact ? [{ start: at, end: at + added!.length, text: record!.replaced }] : []
    // Connect added `mcp` itself: it goes too, unless something else was put in it since.
    const addedMcp = exact && /^\s*"mcp":/.test(added!)
    if (addedMcp && Object.keys(mcp).length === 0) delete expected.mcp
    if (exact && (!addedMcp || Object.keys(mcp).length === 0)) next = applyEdits(doc, restore, expected)
    else next = applyEdits(doc, [removal(doc, ['mcp', SERVER])], expected)
  }
  await writeOpenCode(deps, file, next)
  await deps.store.delete(OPENCODE_ORIGINAL)
  return { ok: true, message: record?.original ? 'OpenCode is back on its earlier Plannotator entry.' : 'OpenCode is disconnected.' }
}

// -------------------------------------------------------------------- together

export async function agentLinks(deps: ConnectDeps): Promise<AgentLink[]> {
  return Promise.all([claudeLink(deps), codexLink(deps), openCodeLink(deps)])
}

const AGENTS: readonly { id: AgentId; name: string; connect: (deps: ConnectDeps) => Promise<ActionResult>; disconnect: (deps: ConnectDeps) => Promise<ActionResult> }[] = [
  { id: 'claude', name: 'Claude Code', connect: connectClaude, disconnect: disconnectClaude },
  { id: 'codex', name: 'Codex', connect: connectCodex, disconnect: disconnectCodex },
  { id: 'opencode', name: 'OpenCode', connect: connectOpenCode, disconnect: disconnectOpenCode }
]

async function each(deps: ConnectDeps, agent: AgentId | undefined, which: 'connect' | 'disconnect'): Promise<ActionResult> {
  const results: ActionResult[] = []
  for (const entry of AGENTS) {
    if (agent !== undefined && agent !== entry.id) continue
    try {
      results.push(await entry[which](deps))
    } catch (error) {
      results.push({ ok: false, message: `${entry.name}: ${errorText(error)}` })
    }
  }
  return { ok: results.every((result) => result.ok), message: results.map((result) => result.message).join(' ') }
}

export function connectAgents(deps: ConnectDeps, agent?: AgentId): Promise<ActionResult> {
  return each(deps, agent, 'connect')
}

export function disconnectAgents(deps: ConnectDeps, agent?: AgentId): Promise<ActionResult> {
  return each(deps, agent, 'disconnect')
}
