#!/usr/bin/env node
// Plannotator Inbox MCP for Orca chats.
//
// Runs Plannotator's own stdio MCP server (`plannotator inbox mcp`) and passes everything through.
// Inside a native Orca chat it adds the one thing Plannotator cannot know: that the caller is the
// Orca chat `ORCA_AGENT_SESSION_ID`. With that, the person's reply is routed back to this chat by
// the Plannotator Inbox plugin for Orca. Outside an Orca chat it changes nothing at all.
//
// The chat's identity is not taken on trust from the environment: Orca's own CLI, run with the
// chat's environment, must say that this exact session is live (`orca status --json`), and Orca's
// workspace list says which repository and worktree the chat works in. Until that proof is in
// hand, or when it cannot be had, this is plain Plannotator: nothing is rewritten.
//
// Which identity fields a tool takes is read from the server's own `tools/list` answer, so a
// Plannotator update that adds, renames or removes tools needs no change here.
//
// Plannotator's own guide and its "Copy connect prompt" tell an agent on the stdio server to pass
// its own `agent_host`, and to register `plannotator inbox mcp` unless a server "that runs this
// command" is already set up. Both would take an Orca chat off this path, so in an Orca chat the
// chat is always the author, and the server's instructions say that it is already connected. A
// call that names another chat as `agent_session`, or a project folder that is not this chat's,
// is refused rather than rewritten.
//
// When the Orca build of Plannotator is installed (bin/plannotator-update.mjs), Orca's bridge config
// is in place and the plugin delivers for this Inbox, that build runs instead of the `plannotator`
// on PATH, in its Orca mode. A `PLANNOTATOR_BIN` the person set always wins.
// Plain JavaScript, Node builtins only: it is copied out of the plugin and run by a launcher.
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WAKES_META = 'ai.plannotator/inbox-wakes'
const WORKING_FOLDER_META = 'ai.plannotator/working-folder'
const IDENTITY_FIELDS = ['agent_host', 'agent_session', 'agent_name']
/** Everything this launcher may fill in; which of them a tool takes comes from the server. */
const ROUTING_FIELDS = [...IDENTITY_FIELDS, 'project_path']
/** Plannotator 0.28.x, used only until the server has listed its tools. */
const FALLBACK_FIELDS = {
  send_message: ROUTING_FIELDS,
  submit_guide: ROUTING_FIELDS,
  thread_pulls: ROUTING_FIELDS,
  card: ROUTING_FIELDS,
  steps: IDENTITY_FIELDS,
  read_thread: ['agent_session', 'project_path'],
  search: ['project_path']
}
/** The tools whose post can wake the chat, and the only ones that get the working folder. */
const MESSAGE_TOOLS = new Set(['send_message', 'submit_guide'])
/** On these a `project_path` is what to look in, not who is asking, so it is not checked. */
const QUERY_TOOLS = new Set(['read_thread', 'search'])
const PARSE_LIMIT = 64 * 1024 * 1024
/** The worker writes its heartbeat every 10 s; one slow look at Orca must not make it look gone. */
const HEARTBEAT_FRESH_MS = 90_000
/** The registration is rewritten this often while the chat keeps sending, so the worker can drop old ones. */
const REGISTER_EVERY_MS = 5 * 60_000
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** How Orca names a native chat's pane: `structured-agent-session-<session id>:<uuid>`. */
const CHAT_PANE = /^structured-agent-session-([A-Za-z0-9_-]{1,160}):[0-9a-fA-F-]{36}$/

/** Orca resolves the caller through its session host, which may take up to 10 s to come up. */
const PROOF_TIMEOUT_MS = 12_000
/** A proven caller is looked at again this often, in the background. */
const PROOF_RECHECK_MS = 60_000
/** After a failed proof, the next attempt waits this long. */
const PROOF_RETRY_MS = 15_000
/** How long the server's first answer may wait for the proof before it goes out unannotated. */
const INIT_WAIT_MS = 5_000
const CLI_OUTPUT_LIMIT = 16 * 1024 * 1024

const LINK_MARKER = '<!-- plannotator-orca-session-link:v1 -->'
const LINK_PRESENT = /\[Open in Orca\]\(http:\/\/127\.0\.0\.1:[0-9]+\/open\//
const NAVIGATION_FRESH_MS = 45_000

const RECEIPT_MAX = 4096
const RECEIPT_BYTES = 64 * 1024
const RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const RECEIPT_NAME = /^[0-9a-f]{64}\.json$/

/** What agents read when a call is refused. Nothing was sent in each case. */
export const REFUSALS = {
  session:
    'Not sent: this call names an agent_session that is not this Orca chat. Leave agent_session unset (this chat is filled in as the author, so the reply comes back here) and send it again.',
  project: (roots) =>
    `Not sent: project_path is not this Orca chat's project. Leave project_path unset to use this chat's own project, or use one of: ${roots.join(', ')}.`,
  key: 'Not sent: this idempotency_key was already used by another Orca chat. Leave idempotency_key unset, or choose a new one, and send it again.',
  receipts: (dir) =>
    `Not sent: the Plannotator Inbox launcher for Orca could not record this call safely, so a retry might have posted it twice. Make sure ${dir} is a private folder that you own and can write to, then send it again.`
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const posix = process.platform !== 'win32'
const myUid = typeof process.getuid === 'function' ? process.getuid() : null

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
  const remote = ['ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING', 'SSH_CONNECTION', 'SSH_CLIENT', 'WSL_DISTRO_NAME']
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
  const dotFolder = join(home, '.plannotator')
  const xdgHome = (env.XDG_DATA_HOME ?? '').trim()
  if (!existsSync(dotFolder) && xdgHome && isAbsolute(xdgHome) && existsSync(join(xdgHome, 'plannotator'))) return join(xdgHome, 'plannotator')
  return dotFolder
}

/** The launcher's own folder: the worker's heartbeat, the link key, the receipts. */
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

/** A path as compared: real, and without case on Windows. */
function samePathKey(path) {
  const found = real(path)
  return posix ? found : found.toLowerCase()
}

function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
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

/**
 * The Orca CLI that answers for this chat. Orca names it in `ORCA_CLI_COMMAND` for a native chat;
 * when that is set, nothing else is used. Without it (an agent that passes on only some of its
 * environment), the CLI bundled beside the Orca binary this launcher runs under, then PATH.
 */
export function findOrcaCli(env, execPath = process.execPath) {
  const explicit = (env.ORCA_CLI_COMMAND ?? '').trim()
  if (explicit) return isAbsolute(explicit) && existsSync(explicit) ? explicit : null
  const names = process.platform === 'win32' ? ['orca.exe', 'orca.cmd'] : ['orca']
  const folders = [
    resolve(dirname(execPath), '..', 'Resources', 'bin'),
    resolve(dirname(execPath), 'resources', 'bin'),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean)
  ]
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** The worker's heartbeat, while it says it is delivering replies; otherwise null. */
function workerState(shared, now = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(join(shared, 'state.json'), 'utf8'))
    const delivering =
      isRecord(state) &&
      state.delivering === true &&
      typeof state.at === 'number' &&
      Math.abs(now - state.at) <= HEARTBEAT_FRESH_MS &&
      typeof state.dataDir === 'string' &&
      state.dataDir !== ''
    return delivering ? state : null
  } catch {
    return null
  }
}

/** The Inbox folder the plugin's worker says it is delivering replies for, or null while it is not. */
export function workerInbox(shared, now = Date.now()) {
  return workerState(shared, now)?.dataDir ?? null
}

/** True while the plugin's worker says it is delivering replies for this Inbox. */
export function workerDelivers(shared, inboxDir, now = Date.now()) {
  const served = workerInbox(shared, now)
  return served !== null && real(served) === real(inboxDir)
}

/** The folders the person limited the plugin to, from the heartbeat; null for "everywhere". */
export function workerProjects(shared, now = Date.now()) {
  const projects = workerState(shared, now)?.projects
  return Array.isArray(projects) && projects.length > 0 ? projects : null
}

/** Whether one of the chat's folders is one of `projects` or inside one. No list: everywhere. */
export function withinProjects(roots, projects) {
  if (!Array.isArray(projects) || projects.length === 0) return true
  const folders = projects.filter(absolutePath).map(samePathKey)
  return roots.some((root) => {
    const path = samePathKey(root)
    return folders.some((folder) => {
      const inside = relative(folder, path)
      return inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))
    })
  })
}

// ---------------------------------------------------------------------------------------------
// The Orca build of Plannotator (bin/plannotator-update.mjs installs it)

const BUILD_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const BUILD_ID = /^orca\.\d{1,6}$/

/**
 * The installed Orca build `<shared>/plannotator/current.json` names, or null. Only a record that
 * belongs to this user alone, naming a plain file exactly at `versions/<version>-<build>/` inside
 * the store, owned by this user, not writable by others, with the recorded size. (Its SHA-256 was
 * checked when it was installed.)
 */
export function currentBuild(shared, platform = process.platform) {
  try {
    const record = JSON.parse(readPrivate(join(shared, 'plannotator', 'current.json'), 4096).toString('utf8'))
    if (!isRecord(record) || record.v !== 1) return null
    const { version, build, path, size, sha256 } = record
    if (typeof version !== 'string' || !BUILD_VERSION.test(version) || typeof build !== 'string' || !BUILD_ID.test(build)) return null
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null
    if (!absolutePath(path)) return null
    const versions = join(shared, 'plannotator', 'versions')
    const expected = join(versions, `${version}-${build}`, platform === 'win32' ? 'plannotator.exe' : 'plannotator')
    const key = (value) => (platform === 'win32' ? value.toLowerCase() : value)
    if (key(resolve(path)) !== key(resolve(expected))) return null
    if (lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink()) return null
    const within = relative(realpathSync(versions), realpathSync(path))
    if (within === '' || within === '..' || isAbsolute(within) || within.startsWith(`..${sep}`)) return null
    const info = lstatSync(path)
    if (!info.isFile() || info.size !== size) return null
    if (posix && ((myUid !== null && info.uid !== myUid) || (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0)) return null
    return { version, build, path }
  } catch {
    return null
  }
}

/** Orca's bridge config for Plannotator's Orca mode, when it is there and private (Plannotator insists); else null. */
export function orcaConfig(shared) {
  const path = join(shared, 'bridge', 'config.json')
  try {
    readPrivate(path, 64 * 1024)
    return path
  } catch {
    return null
  }
}

/**
 * The Orca build to run instead of stock Plannotator, and what to add to its environment, or null
 * to run exactly what runs today. Only when the person has not chosen a binary (`PLANNOTATOR_BIN`),
 * a build is installed, Orca's bridge config is in place, and the worker delivers for this Inbox.
 */
export function orcaBuildFor(env, shared, inboxDir, now = Date.now()) {
  if ((env.PLANNOTATOR_BIN ?? '').trim() !== '') return null
  const build = currentBuild(shared)
  if (!build) return null
  const config = orcaConfig(shared)
  if (!config || !workerDelivers(shared, inboxDir, now)) return null
  return { binary: build.path, version: build.version, env: { PLANNOTATOR_ORCA_MODE: '1', PLANNOTATOR_ORCA_CONFIG: config } }
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

// ---------------------------------------------------------------------------------------------
// Caller proof

/** Runs the Orca CLI once and returns its JSON answer, or null for anything else. */
export function runCli(binary, args, env, timeoutMs = PROOF_TIMEOUT_MS) {
  return new Promise((done) => {
    let child
    try {
      child = start(binary, args, { env, stdio: ['ignore', 'pipe', 'ignore'], cwd: parse(process.cwd()).root, windowsHide: true })
    } catch {
      return done(null)
    }
    const chunks = []
    let size = 0
    let finished = false
    const finish = (value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > CLI_OUTPUT_LIMIT) {
        child.kill('SIGKILL')
        finish(null)
      } else chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) return finish(null)
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
  })
}

const answered = (value) => (isRecord(value) && value.ok === true && isRecord(value.result) ? value.result : null)

function paneSession(agent) {
  if (!isRecord(agent) || typeof agent.paneKey !== 'string') return null
  const match = CHAT_PANE.exec(agent.paneKey)
  if (match) return canonicalSession(match[1])
  // A host that names its rows' sessions directly; still only a native chat's pane.
  return agent.paneKey.startsWith('structured-agent-session-') ? canonicalSession(agent.orcaSessionId) : null
}

/**
 * Reads the three CLI answers into the chat's proven folders, or null.
 * `status`: this exact session is live. `worktree ps`: the one local workspace that runs it.
 * `repo list`: that workspace's repository root (a folder workspace is its own root).
 */
export function readProof(session, status, worktrees, repos) {
  const state = answered(status)
  if (!state || !isRecord(state.runtime) || state.runtime.reachable !== true) return null
  const caller = state.caller
  if (!isRecord(caller) || caller.live !== true || canonicalSession(caller.orcaSessionId) !== session) return null
  const listing = answered(worktrees)
  if (!listing || !Array.isArray(listing.worktrees) || listing.truncated === true) return null
  const rows = listing.worktrees.filter((tree) => isRecord(tree) && Array.isArray(tree.agents) && tree.agents.some((agent) => paneSession(agent) === session))
  if (rows.length !== 1) return null
  const row = rows[0]
  // A chat on a paired or SSH host is not a local native chat.
  if ((row.hostId !== undefined && row.hostId !== null && row.hostId !== 'local') || !absolutePath(row.path)) return null
  const registry = answered(repos)
  if (!registry || !Array.isArray(registry.repos)) return null
  let project = row.path
  const repo = registry.repos.find((entry) => isRecord(entry) && typeof row.repoId === 'string' && entry.id === row.repoId)
  if (repo) {
    const remote = (repo.connectionId ?? null) !== null || ![undefined, null, 'local'].includes(repo.executionHostId)
    if (remote || !absolutePath(repo.path)) return null
    project = repo.path
  }
  return { session, project, working: row.path, roots: [...new Set([project, row.path])] }
}

/** Asks Orca, with the chat's own environment, who this caller is and where it works. */
export async function proveCaller(session, binary, env, run = runCli) {
  if (!binary) return null
  const [status, worktrees, repos] = await Promise.all([
    run(binary, ['status', '--json', '--environment', 'local'], env),
    run(binary, ['worktree', 'ps', '--limit', '1000', '--environment', 'local', '--json'], env),
    run(binary, ['repo', 'list', '--environment', 'local', '--json'], env)
  ])
  return readProof(session, status, worktrees, repos)
}

/** Keeps one proof for the process: looked at again in the background, tried again after a failure. */
export function createProver(prove, clock = Date.now) {
  let value = null
  let at = 0
  let tried = -Infinity
  let pending = null
  const run = () => {
    tried = clock()
    pending = Promise.resolve()
      .then(prove)
      .catch(() => null)
      .then((result) => {
        value = isRecord(result) ? result : null
        at = clock()
        pending = null
        return value
      })
    return pending
  }
  const current = () => {
    const now = clock()
    if (value) {
      if (now - at > PROOF_RECHECK_MS && !pending) run()
      return Promise.resolve(value)
    }
    if (pending) return pending
    return now - tried >= PROOF_RETRY_MS ? run() : Promise.resolve(null)
  }
  return {
    current,
    /** The proof, waiting at most `ms` for one in progress. */
    within: (ms) =>
      new Promise((done) => {
        const timer = setTimeout(() => done(value), ms)
        current().then((result) => {
          clearTimeout(timer)
          done(result)
        })
      })
  }
}

function inRoots(path, proof) {
  if (!absolutePath(path)) return false
  if (proof.roots.includes(path)) return true
  const key = samePathKey(path)
  return proof.roots.some((root) => samePathKey(root) === key)
}

// ---------------------------------------------------------------------------------------------
// "Open in Orca" footer

/** False when the end of `body` is inside an unclosed `:::question` block or code fence. */
export function outsideBlocks(body) {
  let question = false
  let fence = null
  for (const line of body.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (match) {
      const [, mark, rest] = match
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length && rest.trim() === '') fence = null
      continue
    }
    if (fence !== null) continue
    if (/^\s*:::question(?:-multi|-text)?(?:\s+.*)?$/.test(line)) {
      if (question) return false
      question = true
    } else if (/^\s*:::\s*$/.test(line)) {
      question = false
    }
  }
  return !question && fence === null
}

/** A small file only this user can read and write, not a link; throws otherwise. */
function readPrivate(path, maximum) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('a link')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('not a file')
    if (posix && ((myUid !== null && info.uid !== myUid) || (info.mode & 0o077) !== 0)) throw new Error('not private')
    if (info.size > maximum) throw new Error('too large')
    const buffer = Buffer.alloc(maximum + 1)
    const length = readSync(fd, buffer, 0, maximum + 1, 0)
    if (length > maximum) throw new Error('too large')
    return buffer.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

/** The signed `/open/<token>` path for one chat. */
export function linkToken(keyHex, session) {
  const payload = Buffer.from(JSON.stringify({ v: 1, session, tab: `structured-agent-session-${session}` }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(payload).digest('hex')
  return `${payload}.${signature}`
}

/** The footer that opens this chat in Orca, or null while the worker's link service is not there. */
export function linkFooter(shared, session, now = Date.now()) {
  try {
    const key = readPrivate(join(shared, 'link-key'), 65).toString('latin1')
    if (!/^[0-9a-f]{64}\n$/.test(key)) return null
    const navigation = JSON.parse(readPrivate(join(shared, 'navigation.json'), 4096).toString('utf8'))
    if (
      !isRecord(navigation) ||
      navigation.v !== 1 ||
      !Number.isInteger(navigation.port) ||
      navigation.port < 1 ||
      navigation.port > 65535 ||
      !Number.isInteger(navigation.pid) ||
      navigation.pid < 1 ||
      typeof navigation.at !== 'number' ||
      !Number.isFinite(navigation.at) ||
      now - navigation.at > NAVIGATION_FRESH_MS ||
      navigation.at - now > 5_000
    ) {
      return null
    }
    return `\n\n${LINK_MARKER}\n[Open in Orca](http://127.0.0.1:${navigation.port}/open/${linkToken(key.slice(0, 64), session)})\n`
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Receipts: a retried call goes out exactly as the first one did

class ReceiptError extends Error {}
class ForeignKey extends Error {}

/** JSON with object keys in order, so equal arguments give equal digests. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const digestOf = (value) => createHash('sha256').update(stableJson(value)).digest('hex')

function receiptsFolder(shared) {
  const folder = join(shared, 'receipts')
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const info = lstatSync(folder)
    if (!info.isDirectory()) throw new Error('not a folder')
    if (posix && ((myUid !== null && info.uid !== myUid) || (info.mode & 0o022) !== 0)) throw new Error('not private')
    return folder
  } catch {
    throw new ReceiptError()
  }
}

function readReceipt(path) {
  let raw
  try {
    raw = readPrivate(path, RECEIPT_BYTES)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new ReceiptError()
  }
  try {
    const record = JSON.parse(raw.toString('utf8'))
    if (isRecord(record) && record.v === 1 && typeof record.session === 'string' && typeof record.digest === 'string' && isRecord(record.snapshot)) return record
  } catch {
    // Fall through: a receipt that cannot be read cannot vouch for a retry.
  }
  throw new ReceiptError()
}

/** Removes stale temporary files and, when full, receipts older than the age limit, oldest first. */
function prune(folder, now) {
  const names = readdirSync(folder)
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    try {
      if (now - lstatSync(join(folder, name)).mtimeMs > 60 * 60 * 1000) unlinkSync(join(folder, name))
    } catch {
      // Another launcher's file, gone already.
    }
  }
  const receipts = names.filter((name) => RECEIPT_NAME.test(name))
  if (receipts.length < RECEIPT_MAX) return
  const old = []
  for (const name of receipts) {
    try {
      const time = lstatSync(join(folder, name)).mtimeMs
      if (now - time > RECEIPT_MAX_AGE_MS) old.push({ name, time })
    } catch {
      // Gone already.
    }
  }
  old.sort((a, b) => a.time - b.time)
  let count = receipts.length
  for (const { name } of old) {
    if (count < RECEIPT_MAX) break
    try {
      unlinkSync(join(folder, name))
      count -= 1
    } catch {
      // Gone already.
    }
  }
  if (count >= RECEIPT_MAX) throw new ReceiptError()
}

/** Writes a receipt durably unless one is already there; returns whichever receipt holds. */
function writeReceipt(folder, name, record, now) {
  const target = join(folder, `${name}.json`)
  const text = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(text) > RECEIPT_BYTES) throw new ReceiptError()
  const temporary = join(folder, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    prune(folder, now)
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      // A link never replaces a receipt another launcher wrote first.
      linkSync(temporary, target)
    } catch (error) {
      if (error && error.code === 'EEXIST') return readReceipt(target)
      if (existsSync(target)) return readReceipt(target)
      renameSync(temporary, target)
    }
    return record
  } catch (error) {
    if (error instanceof ReceiptError) throw error
    throw new ReceiptError()
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Already moved or never written.
    }
  }
}

/**
 * Receipts under `<shared>/receipts/`. `freeze` returns what the first sending of these exact
 * arguments added (filled fields, footer, working folder), building it only the first time.
 * Without an `idempotency_key` the receipt belongs to this chat alone; with one, the key belongs
 * to the chat that used it first, and another chat using it is refused.
 */
export function receipts(shared, scope, clock = Date.now) {
  return {
    folder: join(shared, 'receipts'),
    freeze(tool, args, session, build) {
      const folder = receiptsFolder(shared)
      const now = clock()
      const digest = digestOf(['arguments-v1', scope, tool, args])
      if (typeof args.idempotency_key === 'string') {
        const keyed = digestOf(['key-v1', scope, tool, args.idempotency_key])
        let held = readReceipt(join(folder, `${keyed}.json`))
        if (!held) held = writeReceipt(folder, keyed, { v: 1, session, digest, snapshot: build(), at: now }, now)
        if (held.session !== session) throw new ForeignKey()
        if (held.digest === digest) return held.snapshot
        // The same key with other words: Plannotator judges that; the words get their own receipt.
      }
      const scoped = digestOf(['session-v1', scope, session, tool, args])
      const held = readReceipt(join(folder, `${scoped}.json`)) ?? writeReceipt(folder, scoped, { v: 1, session, digest, snapshot: build(), at: now }, now)
      if (held.session !== session) throw new ForeignKey()
      return held.snapshot
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The rewrite

const UNTOUCHED = { changed: false, authored: false }

function mutates(tool, args) {
  return (
    MESSAGE_TOOLS.has(tool) ||
    tool === 'steps' ||
    (tool === 'card' && args.op !== 'list') ||
    (tool === 'thread_pulls' && ('add' in args || 'remove' in args))
  )
}

function validSnapshot(snapshot, tool) {
  if (!isRecord(snapshot) || !isRecord(snapshot.fields)) return false
  for (const [key, value] of Object.entries(snapshot.fields)) {
    if (!ROUTING_FIELDS.includes(key) || typeof value !== 'string' || value.length > 4096) return false
  }
  if (snapshot.footer !== null && (tool !== 'send_message' || typeof snapshot.footer !== 'string' || snapshot.footer.length > 8192)) return false
  if (snapshot.working !== null && !absolutePath(snapshot.working)) return false
  return true
}

/**
 * Makes this Orca chat the author of one `tools/call` request, in place. Returns what it did, or
 * `{ refusal }` with the words to answer the call with when it must not be sent.
 *
 * Only while the plugin's worker delivers replies and Orca has proven the caller (`context.proof`):
 * otherwise the call goes out exactly as the agent wrote it, and Plannotator's own identity and
 * wake rules apply. On a tool that writes (it takes `agent_host`), the chat is the author even
 * when the agent named another host, because that is what Plannotator's guide tells it to do on a
 * plain stdio server; the agent's own `agent_name` is kept. A different `agent_session`, or a
 * `project_path` outside the chat's own folders, is refused.
 */
export function enrich(message, context) {
  const params = message.params
  if (!isRecord(params) || typeof params.name !== 'string') return UNTOUCHED
  if (params.arguments !== undefined && !isRecord(params.arguments)) return UNTOUCHED
  const proof = context.proof
  if (!isRecord(proof) || !context.delivering()) return UNTOUCHED
  const tool = params.name
  const fields = context.fieldsOf(tool)
  const args = params.arguments ?? {}
  const ownMeta = isRecord(params._meta) ? params._meta : null
  const claimedWake = ownMeta !== null && WAKES_META in ownMeta
  if (fields.length === 0) {
    // No identity here, but a wake claim is this connection's to make, never the agent's.
    if (!claimedWake) return UNTOUCHED
    const { [WAKES_META]: _dropped, ...rest } = ownMeta
    params._meta = rest
    return { changed: true, authored: false }
  }
  const authored = fields.includes('agent_host')
  const askingAboutOther = !authored && args.agent_session !== undefined && canonicalSession(args.agent_session) !== proof.session
  if (authored && args.agent_session != null && canonicalSession(args.agent_session) !== proof.session) return { refusal: REFUSALS.session }
  const explicitProject = args.project_path != null
  if (fields.includes('project_path') && !QUERY_TOOLS.has(tool) && explicitProject && !inRoots(args.project_path, proof)) {
    return { refusal: REFUSALS.project(proof.roots) }
  }

  const build = () => {
    const filled = {}
    if (authored) {
      if (args.agent_host !== 'orca') filled.agent_host = 'orca'
      if (args.agent_session == null) filled.agent_session = proof.session
      const named = typeof args.agent_host === 'string' ? args.agent_host.trim() : ''
      const hasName = typeof args.agent_name === 'string' && args.agent_name.trim() !== ''
      const name = context.name ?? (named && named !== 'orca' ? named : null)
      if (fields.includes('agent_name') && !hasName && name) filled.agent_name = name
    } else if (fields.includes('agent_session') && args.agent_session === undefined) {
      // A reading tool: "mine" means this chat, unless the agent asked about another session.
      filled.agent_session = proof.session
    }
    if (fields.includes('project_path') && !explicitProject && !askingAboutOther && !(tool === 'search' && args.all_projects === true)) {
      filled.project_path = proof.project
    }
    let footer = null
    const body = args.body
    if (tool === 'send_message' && typeof body === 'string' && !body.includes(LINK_MARKER) && !LINK_PRESENT.test(body) && outsideBlocks(body)) {
      footer = context.footer ? context.footer(proof.session) : null
    }
    const working = MESSAGE_TOOLS.has(tool) && !explicitProject && proof.working !== proof.project ? proof.working : null
    return { fields: filled, footer, working }
  }

  let snapshot
  try {
    snapshot = context.freeze && mutates(tool, args) ? context.freeze(tool, args, proof.session, build) : build()
  } catch (error) {
    if (error instanceof ForeignKey) return { refusal: REFUSALS.key }
    return { refusal: REFUSALS.receipts(context.receiptsFolder ?? 'the launcher folder') }
  }
  if (!validSnapshot(snapshot, tool)) return { refusal: REFUSALS.receipts(context.receiptsFolder ?? 'the launcher folder') }

  const combined = { ...args, ...snapshot.fields }
  if (snapshot.footer) combined.body = `${args.body}${snapshot.footer}`
  if (authored && (combined.agent_host !== 'orca' || canonicalSession(combined.agent_session) !== proof.session)) return { refusal: REFUSALS.key }

  const meta = { ...(ownMeta ?? {}) }
  delete meta[WAKES_META]
  if (snapshot.working && !(WORKING_FOLDER_META in meta)) meta[WORKING_FOLDER_META] = snapshot.working
  // Tells Plannotator this connection wakes the chat, so its answer says "the reply arrives by itself".
  const project = combined.project_path ?? proof.project
  if (MESSAGE_TOOLS.has(tool) && canonicalSession(combined.agent_session) === proof.session && inRoots(project, proof)) meta[WAKES_META] = true

  const argsChanged = Object.keys(snapshot.fields).length > 0 || Boolean(snapshot.footer)
  const metaChanged = stableJson(meta) !== stableJson(ownMeta ?? {})
  if (argsChanged) params.arguments = combined
  if (metaChanged) params._meta = meta
  return { changed: argsChanged || metaChanged, authored, raw: combined.agent_session }
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

/** A tool error answer for a call that was not sent. */
export function refusalAnswer(id, text) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }
}

// ---------------------------------------------------------------------------------------------
// The pipes

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

const isPromise = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function'

/**
 * Copies `source` to `destination`. With `transform`, line by line: it returns the line to write,
 * null to write nothing, or a promise of either. Lines keep their order, and each goes out in
 * one write, so a line written from elsewhere never lands inside one.
 */
function pump(source, destination, transform, endDestination = true) {
  const write = (buffer) => {
    if (!destination.write(buffer)) {
      source.pause()
      destination.once('drain', () => source.resume())
    }
  }
  if (!transform) {
    source.on('data', write)
    if (endDestination) source.on('end', () => destination.end())
    return
  }
  const newline = Buffer.from('\n')
  const emit = (out) => {
    if (out) write(Buffer.concat([out, newline], out.length + 1))
  }
  const apply = (line) => {
    try {
      return transform(line)
    } catch {
      return line
    }
  }
  let tail = Promise.resolve()
  let waiting = 0
  const settle = (out, line) => Promise.resolve(out).then(emit, () => emit(line))
  source.on(
    'data',
    lineReader((line) => {
      if (waiting === 0) {
        const out = apply(line)
        if (!isPromise(out)) return emit(out)
        waiting += 1
        tail = settle(out, line).finally(() => (waiting -= 1))
        return
      }
      waiting += 1
      tail = tail.then(() => settle(apply(line), line)).finally(() => (waiting -= 1))
    })
  )
  if (endDestination) source.on('end', () => tail.then(() => destination.end()))
}

/**
 * Starts a program. Windows runs a `.cmd` or `.bat` only through its command interpreter, which
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
  // The Orca build, in Orca mode, while the plugin delivers for this Inbox; otherwise what runs today.
  // Whichever server starts the Inbox first decides its mode, so this holds outside Orca chats too.
  const orcaBuild = orcaBuildFor(env, shared, dataDir(childEnv))
  if (orcaBuild) Object.assign(childEnv, orcaBuild.env)
  const binary = orcaBuild?.binary ?? findPlannotator(env)
  if (!binary) {
    process.stderr.write('Plannotator is not installed (no `plannotator` on PATH or in ~/.local/bin). Install it from https://plannotator.ai, then restart this agent.\n')
    process.exit(1)
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
  const cli = findOrcaCli(env)
  const prover = createProver(() => proveCaller(session, cli, childEnv))
  const store = receipts(shared, real(inboxDir))
  const schemas = new Map()
  const listRequests = new Set()
  const initRequests = new Set()
  let registeredAt = 0
  const context = {
    name: agentName(env),
    delivering: () => workerDelivers(shared, inboxDir),
    fieldsOf: (tool) => schemas.get(tool) ?? FALLBACK_FIELDS[tool] ?? [],
    footer: (id) => linkFooter(shared, id),
    freeze: store.freeze,
    receiptsFolder: store.folder
  }
  /** The proof, when it also falls inside the folders the plugin is limited to. */
  const usable = (proof) => (proof && withinProjects(proof.roots, workerProjects(shared)) ? proof : null)
  // Asked at once, so the answer is usually in before the agent's first call. While the plugin is
  // not delivering, Orca is not asked at all.
  if (context.delivering()) prover.current()

  const handleCall = (message, line, proof) => {
    const result = enrich(message, { ...context, proof: usable(proof) })
    if (result.refusal) {
      // Nothing goes to Plannotator; the agent gets the reason as the call's answer.
      if (message.id !== undefined) process.stdout.write(`${JSON.stringify(refusalAnswer(message.id, result.refusal))}\n`)
      return null
    }
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
    // While the plugin is not delivering there is nothing to prove: Plannotator's own call.
    if (!context.delivering()) return line
    return prover.current().then((proof) => handleCall(message, line, proof))
  })

  pump(child.stdout, process.stdout, (line) => {
    if ((listRequests.size === 0 && initRequests.size === 0) || line.length > PARSE_LIMIT) return line
    try {
      const message = JSON.parse(line.toString('utf8'))
      if (isRecord(message) && initRequests.has(message.id)) {
        initRequests.delete(message.id)
        // Only while the plugin delivers for a proven chat; otherwise this is plain Plannotator and says nothing extra.
        if (!context.delivering()) return line
        return prover.within(INIT_WAIT_MS).then((proof) => (usable(proof) && annotate(message) ? Buffer.from(JSON.stringify(message), 'utf8') : line))
      }
      if (isRecord(message) && listRequests.has(message.id)) {
        listRequests.delete(message.id)
        const tools = isRecord(message.result) && Array.isArray(message.result.tools) ? message.result.tools : []
        for (const tool of tools) {
          if (!isRecord(tool) || typeof tool.name !== 'string') continue
          const properties = isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
          schemas.set(tool.name, ROUTING_FIELDS.filter((field) => field in properties))
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
