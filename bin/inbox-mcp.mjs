#!/usr/bin/env node
// Plannotator Inbox MCP for Orca chats.
//
// Runs Plannotator's own stdio MCP server (`plannotator inbox mcp`) and passes everything through.
// Inside a native Orca chat it adds the one thing Plannotator cannot know: that the caller is the
// Orca chat `ORCA_AGENT_SESSION_ID`. With that, the person's reply is routed back to this chat by
// the Plannotator Inbox plugin for Orca. Outside an Orca chat it changes nothing at all.
//
// Which identity fields a tool takes is read from the server's own `tools/list` answer, so a
// Plannotator update that adds, renames or removes tools needs no change here.
//
// Plannotator's own guide and its "Copy connect prompt" tell an agent on the stdio server to pass
// its own `agent_host`, and to register `plannotator inbox mcp` unless a server "that runs this
// command" is already set up. Both would take an Orca chat off this path, so in an Orca chat the
// chat is always the author, and the server's instructions say that it is already connected.
// Plain JavaScript, Node builtins only: it is copied out of the plugin and run by a launcher.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WAKES_META = 'ai.plannotator/inbox-wakes'
const IDENTITY_FIELDS = ['agent_host', 'agent_session', 'agent_name']
/** Plannotator 0.28.x, used only until the server has listed its tools. */
const FALLBACK_FIELDS = {
  send_message: IDENTITY_FIELDS,
  submit_guide: IDENTITY_FIELDS,
  thread_pulls: IDENTITY_FIELDS,
  card: IDENTITY_FIELDS,
  steps: IDENTITY_FIELDS,
  read_thread: ['agent_session']
}
const PARSE_LIMIT = 64 * 1024 * 1024
/** The worker writes its heartbeat every 10 s; one slow look at Orca must not make it look gone. */
const HEARTBEAT_FRESH_MS = 90_000
/** The registration is rewritten this often while the chat keeps sending, so the worker can drop old ones. */
const REGISTER_EVERY_MS = 5 * 60_000
const SESSION = /^[A-Za-z0-9_-]{1,160}$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

export function canonicalSession(value) {
  if (typeof value !== 'string') return null
  const bare = value.startsWith('orca_session_id:') ? value.slice('orca_session_id:'.length) : value
  return SESSION.test(bare) ? bare : null
}

/** The Orca chat this process runs in, or null: a terminal agent, a remote host, or not Orca at all. */
export function nativeSession(env) {
  const session = canonicalSession((env.ORCA_AGENT_SESSION_ID ?? '').trim())
  if (!session) return null
  // Orca's own marker for a native chat (it tests for "set", so this does too). A terminal agent
  // is not one, and Plannotator's own plugins already reach those.
  if ((env.ORCA_STRUCTURED_SESSION ?? '') === '') return null
  const remote =['ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING', 'SSH_CONNECTION', 'SSH_CLIENT', 'WSL_DISTRO_NAME']
  if (remote.some((key) => (env[key] ?? '') !== '')) return null
  if (!['', 'local'].includes(env.ORCA_ENVIRONMENT ?? '')) return null
  return session
}

/** How the chat's agent is shown in the Inbox. Only what the environment actually says. */
export function agentName(env) {
  if (env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return 'Claude'
  if (env.CODEX_THREAD_ID || env.CODEX_HOME || env.CODEX_MANAGED_BY_NPM) return 'Codex'
  const prefix = /^([a-z]+)[0-9]*_/.exec(env.ORCA_AGENT_SESSION_ID ?? '')?.[1]
  const names = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', gemini: 'Gemini', pi: 'Pi' }
  return (prefix && names[prefix]) || null
}

function expandHome(value, home) {
  if (value === '~') return home
  return value.startsWith('~/') ? join(home, value.slice(2)) : value
}

/** Same rule as Plannotator's own data-dir lookup. */
export function dataDir(env, home = homedir()) {
  const explicit = (env.PLANNOTATOR_DATA_DIR ?? '').trim()
  if (explicit) return resolve(expandHome(explicit, home))
  const legacy = join(home, '.plannotator')
  const xdgHome = (env.XDG_DATA_HOME ?? '').trim()
  if (!existsSync(legacy) && xdgHome && isAbsolute(xdgHome) && existsSync(join(xdgHome, 'plannotator'))) return join(xdgHome, 'plannotator')
  return legacy
}

export function sharedDir(env, home = homedir()) {
  const override = (env.ORCA_PLANNOTATOR_HOME ?? '').trim()
  return override ? resolve(expandHome(override, home)) : join(home, '.orca-plannotator-inbox')
}

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function findPlannotator(env, home = homedir()) {
  const explicit = (env.PLANNOTATOR_BIN ?? '').trim()
  if (explicit && existsSync(explicit)) return explicit
  const names = process.platform === 'win32' ? ['plannotator.exe', 'plannotator.cmd', 'plannotator'] : ['plannotator']
  const folders = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin')]
  if (process.platform === 'win32' && env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'plannotator'))
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** The Inbox folder the plugin's worker says it is delivering replies for, or null while it is not. */
export function workerInbox(shared, now = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(join(shared, 'state.json'), 'utf8'))
    const delivering =
      isRecord(state) &&
      state.delivering === true &&
      typeof state.at === 'number' &&
      Math.abs(now - state.at) <= HEARTBEAT_FRESH_MS &&
      typeof state.dataDir === 'string' &&
      state.dataDir !== ''
    return delivering ? state.dataDir : null
  } catch {
    return null
  }
}

/** True while the plugin's worker says it is delivering replies for this Inbox. */
export function workerDelivers(shared, inboxDir, now = Date.now()) {
  const served = workerInbox(shared, now)
  return served !== null && real(served) === real(inboxDir)
}

/** Tells the worker this chat uses the Inbox, so it listens for its replies before the first one. */
export function registerSession(shared, record) {
  try {
    const folder = join(shared, 'sessions')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const target = join(folder, `${record.session}.json`)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ v: 1, ...record })}\n`, { mode: 0o600 })
    renameSync(temporary, target)
  } catch {
    // Not fatal: the worker also finds sessions from the Inbox's own thread list.
  }
}

const UNTOUCHED = { changed: false, authored: false }

/**
 * Makes this Orca chat the author of one `tools/call` request, in place. Returns what it did.
 *
 * Only while the plugin's worker delivers replies: otherwise the call goes out exactly as the
 * agent wrote it, and Plannotator's own identity and wake rules apply.
 * On a tool that writes (it takes `agent_host`), the chat is the author even when the agent named
 * another host or session, because that is what Plannotator's guide tells it to do on a plain
 * stdio server, and the reply has to come back to this chat. The agent's own `agent_name` is kept.
 */
export function enrich(message, context) {
  const params = message.params
  if (!isRecord(params) || typeof params.name !== 'string') return UNTOUCHED
  if (params.arguments !== undefined && !isRecord(params.arguments)) return UNTOUCHED
  const fields = context.fieldsOf(params.name)
  if (fields.length === 0 || !context.delivering()) return UNTOUCHED
  const args = { ...(params.arguments ?? {}) }
  const authored = fields.includes('agent_host')
  let changed = false
  if (!authored) {
    // A reading tool: "mine" means this chat, unless the agent asked about another session.
    if (fields.includes('agent_session') && args.agent_session === undefined) {
      args.agent_session = context.session
      changed = true
    }
  } else {
    const named = typeof args.agent_host === 'string' ? args.agent_host.trim() : ''
    if (args.agent_host !== 'orca') {
      args.agent_host = 'orca'
      changed = true
    }
    if (canonicalSession(args.agent_session) !== context.session) {
      args.agent_session = context.session
      changed = true
    }
    const hasName = typeof args.agent_name === 'string' && args.agent_name.trim() !== ''
    const name = context.name ?? (named && named !== 'orca' ? named : null)
    if (fields.includes('agent_name') && !hasName && name) {
      args.agent_name = name
      changed = true
    }
    // Tells Plannotator this connection wakes the chat, so its answer says "the reply arrives by itself".
    params._meta = { ...(isRecord(params._meta) ? params._meta : {}), [WAKES_META]: true }
    changed = true
  }
  if (changed) params.arguments = args
  return { changed, authored, raw: args.agent_session }
}

/** Added to the server's own instructions in an Orca chat. */
export const ORCA_NOTE = [
  'In this Orca chat you are already connected to the Plannotator Inbox: this server is Plannotator\'s own (`plannotator inbox mcp`), started by the Plannotator Inbox plugin for Orca.',
  'If you are asked to connect yourself to the Inbox, change nothing and send your message with these tools.',
  'Leave `agent_host` and `agent_session` unset: this chat is filled in as the author, so the person\'s reply comes back to this chat (send_message\'s result says whether it arrives by itself).',
  'Send Inbox messages with these tools, not with the `plannotator` command line, which does not know this chat.'
].join(' ')

/** Appends the Orca note to an `initialize` answer, in place. Returns whether it changed. */
export function annotate(message) {
  if (!isRecord(message.result)) return false
  const own = typeof message.result.instructions === 'string' ? message.result.instructions.trimEnd() : ''
  message.result.instructions = own ? `${own}\n\n${ORCA_NOTE}` : ORCA_NOTE
  return true
}

/** Calls `onLine` with each complete line (without its newline) as a Buffer. */
function lineReader(onLine) {
  let pending = []
  let size = 0
  return (chunk) => {
    let start = 0
    for (;;) {
      const end = chunk.indexOf(0x0a, start)
      if (end === -1) break
      const piece = chunk.subarray(start, end)
      onLine(size === 0 ? piece : Buffer.concat([...pending, piece], size + piece.length))
      pending = []
      size = 0
      start = end + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      pending.push(rest)
      size += rest.length
    }
  }
}

function pump(source, destination, transform, endDestination = true) {
  const write = (buffer) => {
    if (!destination.write(buffer)) {
      source.pause()
      destination.once('drain', () => source.resume())
    }
  }
  if (!transform) {
    source.on('data', write)
  } else {
    const newline = Buffer.from('\n')
    source.on(
      'data',
      lineReader((line) => {
        write(transform(line))
        write(newline)
      })
    )
  }
  if (endDestination) source.on('end', () => destination.end())
}

/**
 * Starts Plannotator. Windows runs a `.cmd` or `.bat` only through its command interpreter, which
 * reads the line again, so such a file gets plain arguments only.
 */
function start(binary, args, options) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return spawn(binary, args, options)
  const parts = [binary, ...args]
  const odd = parts.find((part) => /["%\r\n]/.test(part))
  if (odd !== undefined) throw new Error(`${JSON.stringify(odd)} cannot be passed to a batch file`)
  const line = parts.map((part) => `"${part}"`).join(' ')
  return spawn(options.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
}

export function main(env = process.env) {
  const binary = findPlannotator(env)
  if (!binary) {
    process.stderr.write('Plannotator is not installed (no `plannotator` on PATH or in ~/.local/bin). Install it from https://plannotator.ai, then restart this agent.\n')
    process.exit(1)
  }
  const childEnv = { ...env }
  // The launcher runs this file with Orca's own binary in Node mode; nothing started from here may inherit that.
  delete childEnv.ELECTRON_RUN_AS_NODE
  const session = nativeSession(env)
  const shared = sharedDir(env)
  if (session && (env.PLANNOTATOR_DATA_DIR ?? '').trim() === '') {
    // The plugin's "Plannotator data folder" setting can move the Inbox, and an agent's settings do
    // not know that. An Orca chat whose own environment names no folder uses the one the worker
    // delivers for, so its messages and their replies meet in the same Inbox.
    const served = workerInbox(shared)
    if (served !== null && real(served) !== real(dataDir(env))) childEnv.PLANNOTATOR_DATA_DIR = served
  }
  const failed = (error) => {
    process.stderr.write(`Could not start Plannotator: ${error.message}\n`)
    process.exit(1)
  }
  let child
  try {
    child = start(binary, ['inbox', 'mcp', ...process.argv.slice(2)], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] })
  } catch (error) {
    return failed(error)
  }
  child.on('error', failed)
  // `close`, not `exit`: by then everything the server wrote has been read and passed on.
  child.on('close', (code, signal) => process.stdout.write('', () => process.exit(signal ? 1 : (code ?? 0))))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.stdin.on('error', () => undefined)
  process.stdout.on('error', () => undefined)

  if (!session) {
    // Not an Orca chat: exactly Plannotator's own server, byte for byte.
    pump(process.stdin, child.stdin)
    pump(child.stdout, process.stdout, undefined, false)
    return
  }

  const inboxDir = dataDir(childEnv)
  const schemas = new Map()
  const listRequests = new Set()
  const initRequests = new Set()
  let registeredAt = 0
  const context = {
    session,
    name: agentName(env),
    delivering: () => workerDelivers(shared, inboxDir),
    fieldsOf: (tool) => schemas.get(tool) ?? FALLBACK_FIELDS[tool] ?? []
  }

  pump(process.stdin, child.stdin, (line) => {
    if (line.length > PARSE_LIMIT) return line
    let message
    try {
      message = JSON.parse(line.toString('utf8'))
    } catch {
      return line
    }
    if (!isRecord(message)) return line
    if (message.method === 'tools/list' && message.id !== undefined) listRequests.add(message.id)
    if (message.method === 'initialize' && message.id !== undefined) initRequests.add(message.id)
    if (message.method !== 'tools/call') return line
    const result = enrich(message, context)
    if (result.authored && Date.now() - registeredAt > REGISTER_EVERY_MS) {
      registeredAt = Date.now()
      registerSession(shared, {
        session,
        raw: typeof result.raw === 'string' ? result.raw : session,
        // The chat's own folder, not a message's `project_path`: one message may be about another repository.
        projectPath: env.PLANNOTATOR_CWD || process.cwd(),
        dataDir: inboxDir,
        at: registeredAt
      })
    }
    return result.changed ? Buffer.from(JSON.stringify(message), 'utf8') : line
  })

  pump(child.stdout, process.stdout, (line) => {
    if ((listRequests.size === 0 && initRequests.size === 0) || line.length > PARSE_LIMIT) return line
    try {
      const message = JSON.parse(line.toString('utf8'))
      if (isRecord(message) && initRequests.has(message.id)) {
        initRequests.delete(message.id)
        // Only while the plugin delivers; otherwise this is plain Plannotator and says nothing extra.
        if (context.delivering() && annotate(message)) return Buffer.from(JSON.stringify(message), 'utf8')
      }
      if (isRecord(message) && listRequests.has(message.id)) {
        listRequests.delete(message.id)
        const tools = isRecord(message.result) && Array.isArray(message.result.tools) ? message.result.tools : []
        for (const tool of tools) {
          if (!isRecord(tool) || typeof tool.name !== 'string') continue
          const properties = isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
          schemas.set(tool.name, IDENTITY_FIELDS.filter((field) => field in properties))
        }
      }
    } catch {
      // Not ours to judge: pass it on as it is.
    }
    return line
  }, false)
}

// Run only when started as a program; tests import the functions above.
// A URL's path is not a file path on Windows (`/C:/…`), and Windows paths compare without case.
const invoked = process.argv[1] ? real(process.argv[1]) : ''
const self = real(fileURLToPath(import.meta.url))
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) main()
