// Stand-ins for the two programs the plugin talks to, at the same boundaries the real ones sit:
// Orca's CLI (argv in, one JSON document out) and the Plannotator Inbox (loopback HTTP).
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboxCommand } from '../src/inbox'
import type { KeyValue } from '../src/ledger'
import type { Exec } from '../src/orca-cli'
import type { Json } from '../src/util'

export function memoryStore(initial: Record<string, Json> = {}): KeyValue & { data: Map<string, Json> } {
  const data = new Map<string, Json>(Object.entries(initial))
  return {
    data,
    get: async (key) => (data.has(key) ? structuredClone(data.get(key)) : null),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key)
  }
}

export async function tempDir(prefix = 'orca-plannotator-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * The chat's agent in the in-app tests: a `claude` on the throwaway PATH that notes the variables Orca
 * gave the chat into `chatEnvDir`, then runs the real program with its own empty settings folder and a
 * made-up key. Orca closes a chat whose Claude says it is not signed in, so the agent has a key, but
 * not anyone's: its model address is `modelUrl` (see `refusingModel`), so its turns fail at once and
 * nothing leaves this computer.
 */
export function chatAgentScript(input: { claude: string; chatEnvDir: string; configDir: string; modelUrl: string; variables: readonly string[] }): string {
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  return [
    '#!/bin/sh',
    'if [ -n "${ORCA_AGENT_SESSION_ID:-}" ]; then',
    `  target=${quoted(input.chatEnvDir)}/"$ORCA_AGENT_SESSION_ID"`,
    `  for name in ${input.variables.join(' ')}; do eval "value=\\\${$name-}"; printf '%s=%s\\n' "$name" "$value"; done > "$target.$$.tmp" && mv "$target.$$.tmp" "$target"`,
    'fi',
    `CLAUDE_CONFIG_DIR=${quoted(input.configDir)} ANTHROPIC_API_KEY=${quoted(FAKE_MODEL_KEY)} ANTHROPIC_BASE_URL=${quoted(input.modelUrl)} \\`,
    `  DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 exec ${quoted(input.claude)} "$@"`,
    ''
  ].join('\n')
}

/** The made-up key `chatAgentScript` gives the chat's agent; `refusingModel` turns it away. */
export const FAKE_MODEL_KEY = 'not-a-real-key-orca-plannotator-test'

/** A model address on 127.0.0.1 that answers every request as an unknown key, so the agent does not retry. */
export async function refusingModel(): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Mail = { id: string; from_handle: string; to_handle: string; subject: string; body: string; payload: string; delivered_at: string | null }
export type SendFault =
  | null
  | 'not-sent' // Orca says nothing was sent
  | 'answer-lost' // the mail is queued but the answer never arrives
  | 'dropped' // nothing is queued and the answer never arrives

/**
 * `bodyFile`: whether this Orca's `orchestration send` takes `--body-file` (1.4.265 and later; the
 * default). Without it, its command schema lacks the flag and its argument check refuses it, as an
 * older Orca does.
 */
export function fakeOrca(options: { sessions?: string[]; deliverAtOnce?: boolean; bodyFile?: boolean } = {}) {
  const state = {
    bodyFile: options.bodyFile ?? true,
    /** What each send read from standard input (undefined: nothing was written to it). */
    stdin: [] as (string | undefined)[],
    /** How many times the command schema (`agent-context`) was read. */
    schemaReads: 0,
    sessions: new Set(options.sessions ?? []),
    busy: new Set<string>(),
    mail: [] as Mail[],
    requests: new Map<string, Mail>(),
    calls: [] as string[][],
    envs: [] as Record<string, string | undefined>[],
    sendFault: null as SendFault,
    deliverAtOnce: options.deliverAtOnce ?? false,
    reachable: true,
    mailboxDown: false,
    inventoryShape: 'current' as 'current' | 'renamed',
    /** The one local worktree every chat is in, and Orca's repositories (`repo list`). */
    worktreePath: '/work/project',
    repoId: 'repo_1' as string | null,
    repos: [{ id: 'repo_1', path: '/work/project' }] as { id: string; path: string }[],
    reposDown: false,
    /**
     * Chats that are a bot's, by session, with the bot's name. As Orca does, `worktree ps` lists them
     * in the bot's home (a folder workspace marked `botHome`), and mail to one keeps its sender,
     * address and body but carries Orca's own record of the request as its payload.
     */
    bots: new Map<string, string>(),
    /** A bot's home folder, by the bot's name, in place of `/bots/home-<n>`. */
    homes: new Map<string, string>(),
    /** Orca refuses every send with this error, having stored nothing (as for a closed chat or a paused bot). */
    refusal: null as null | { code: string; message: string },
    /**
     * A chat's own status row, by session, in place of `working`/`idle`: `state`, the lead's `mainAgent`
     * and when the state began (`stateStartedAt`), as Orca 1.4.266 lists them.
     */
    rows: new Map<string, { state: string; mainAgent?: { state: string }; stateStartedAt?: number }>(),
    /**
     * What `agent read` answers for a chat: its newest entries, with the words a real chat would hold. A
     * chat not here has none; `agentRead: false` is an Orca without the command.
     */
    entries: new Map<string, Record<string, unknown>[]>(),
    agentRead: true,
    /** When set, each `agent read` answers only once what this returns settles: a slow (or never answering) read. */
    readGate: null as null | ((session: string) => Promise<void>)
  }
  const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
  const refuse = (code: string, data?: unknown) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code, data } }) })
  const option = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? ''
  const exec: Exec = async (_file, argv, execOptions) => {
    if (argv[0] === 'agent-context') {
      // A local read of the command schema: no `--environment`, and no `{ ok, result }` wrapper.
      state.schemaReads += 1
      const flags = ['help', 'json', 'environment', 'to', 'from', 'subject', 'body', ...(state.bodyFile ? ['body-file'] : []), 'type', 'payload', 'retry-request']
      return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, commandCount: 1, commands: [{ command: 'orchestration send', path: ['orchestration', 'send'], flags }] }) }
    }
    const args = argv.slice(0, -3) // `--environment local --json`
    state.calls.push(args)
    state.envs.push(execOptions.env)
    const command = args.slice(0, 2).join(' ')
    if (args[0] === 'status') return ok({ runtime: { reachable: state.reachable, appVersion: '1.4.300' } })
    if (command === 'worktree ps') {
      const agents = [...state.sessions].map((session, index) => ({
        paneKey:
          state.inventoryShape === 'current'
            ? `structured-agent-session-${session}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
            : `chat:${session}`,
        state: state.busy.has(session) ? 'working' : 'idle',
        agentType: 'claude',
        conversationName: `Chat ${index + 1}`,
        ...state.rows.get(session)
      }))
      const plain = agents.filter((_agent, index) => !state.bots.has([...state.sessions][index]!))
      const local = { path: state.worktreePath, hostId: null, agents: plain, ...(state.repoId ? { repoId: state.repoId } : {}) }
      // Each bot's home, recorded from a real `worktree ps`: its repoId names a project group, not a repository.
      const homes = [...new Set(state.bots.values())].map((bot, index) => ({
        path: state.homes.get(bot) ?? `/bots/home-${index + 1}`,
        worktreeId: `folder:home-${index + 1}`,
        workspaceKind: 'folder-workspace',
        repo: 'Bots',
        repoId: 'folder-workspace:group-1',
        hostId: 'local',
        bot,
        botHome: true,
        agents: agents.filter((_agent, at) => state.bots.get([...state.sessions][at]!) === bot)
      }))
      return ok({ worktrees: [local, ...homes, { path: '/remote', hostId: 'ssh-1', agents: [] }], truncated: false })
    }
    if (command === 'agent read') {
      if (!state.agentRead) return refuse('invalid_argument', { suggestions: ['list', 'show'] })
      const session = option(args, '--id').replace(/^orca_session_id:/, '')
      if (state.readGate) await state.readGate(session)
      if (!state.sessions.has(session)) return refuse('agent_unknown')
      return ok({ orcaSessionId: session, kind: 'chat', agent: 'claude', source: 'chat', entries: state.entries.get(session) ?? [], limited: false })
    }
    if (command === 'repo list') {
      if (state.reposDown) return refuse('runtime_unavailable')
      return ok({ repos: state.repos })
    }
    if (command === 'orchestration send') {
      if (args.includes('--body-file') && !state.bodyFile) {
        // An older Orca's argument check, before it connects to the app: nothing is sent.
        return {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: 'invalid_argument', message: 'Unknown flag --body-file for command: orchestration send', data: { validFlags: ['body', 'from', 'subject', 'to'], suggestions: ['body'] } }
          })
        }
      }
      state.stdin.push(execOptions.input)
      const body = args.includes('--body-file') ? (option(args, '--body-file') === '-' ? (execOptions.input ?? '') : `<file ${option(args, '--body-file')}>`) : option(args, '--body')
      const request = option(args, '--retry-request')
      if (state.sendFault === 'not-sent') return refuse('consumer_fenced', { requestSent: false })
      if (state.sendFault === 'dropped') return { code: 1, stdout: '' }
      if (state.refusal) return { code: 1, stdout: JSON.stringify({ ok: false, error: state.refusal }) }
      let message = state.requests.get(request)
      if (!message) {
        const to = option(args, '--to')
        const bot = state.bots.get(to.replace(/^orca_session_id:/, ''))
        const id = `mail_${state.mail.length + 1}`
        message = {
          id,
          from_handle: option(args, '--from'),
          to_handle: to,
          subject: option(args, '--subject'),
          body,
          payload: bot
            ? JSON.stringify({ botRequest: { from: 'your owner', for: 'your owner', kind: 'status: for your information; there is no job to take and nothing to answer', next: `Use it in your own work if it bears on it (${id}).` } })
            : option(args, '--payload'),
          delivered_at: state.deliverAtOnce ? '2026-01-01T00:00:00Z' : null
        }
        state.mail.push(message)
        state.requests.set(request, message)
      }
      if (state.sendFault === 'answer-lost') return { code: 1, stdout: '' }
      return ok({ message })
    }
    if (command === 'orchestration request-show') {
      const message = state.requests.get(option(args, '--request'))
      return ok(message ? { state: 'completed', receipt: { message } } : { state: 'unknown' })
    }
    if (command === 'orchestration inbox') {
      if (state.mailboxDown) return refuse('runtime_unavailable')
      return ok({ messages: state.mail.filter((message) => message.to_handle === option(args, '--terminal')) })
    }
    return refuse('unknown_command')
  }
  return {
    state,
    exec,
    sends: () => state.calls.filter((args) => args.slice(0, 2).join(' ') === 'orchestration send'),
    deliverAll: () => {
      for (const message of state.mail) message.delivered_at ??= '2026-01-01T00:00:00Z'
    }
  }
}

/** Every reply made with `reply()`, by id: the fake Inbox's threads hold them unless a test says otherwise. */
const REPLIES = new Map<string, InboxCommand>()

export function reply(id: string, overrides: Partial<InboxCommand> = {}): InboxCommand {
  const command = {
    type: 'reply',
    id,
    thread_id: 'thr_1',
    reply_to: 'msg_question',
    subject: 'Ship it?',
    body: 'Yes, ship it.',
    url: 'http://127.0.0.1:4999/#/thread/thr_1',
    ...overrides
  } as InboxCommand
  REPLIES.set(id, command)
  return command
}

export const DEFAULT_ASKER = 'claude_1b491d4a_6f38'

/** A message as `GET /api/inbox/threads/<id>` serves it. */
export type WireMessage = {
  id: string
  reply_to: string | null
  author: { kind: 'person' } | { kind: 'agent'; host: string | null; session: string | null; name?: string | null }
  created_at: string
  to?: { host: string; session: string } | null
}

export function agentMessage(id: string, session: string, overrides: Partial<WireMessage> = {}): WireMessage {
  return { id, reply_to: null, author: { kind: 'agent', host: 'orca', session, name: 'Claude' }, created_at: '2020-01-01T00:00:00.000Z', ...overrides }
}

export function personMessage(id: string, replyTo: string | null, overrides: Partial<WireMessage> = {}): WireMessage {
  return { id, reply_to: replyTo, author: { kind: 'person' }, created_at: new Date().toISOString(), ...overrides }
}

/** A thread read's answer, as the stock Inbox shapes it (only the fields the plugin reads, plus a few it ignores). */
export function threadAnswer(threadId: string, root: string, messages: WireMessage[]): Record<string, unknown> {
  return {
    serverSession: 'boot-1',
    cursor: 1,
    thread: {
      thread_id: threadId,
      project: { id: 'p1', key: 'project-abc123', name: 'project', root, created_at: '2020-01-01T00:00:00.000Z' },
      subject: 'Ship it?',
      thread_name: null,
      resolved_at: null,
      messages: messages.map((message) => ({ project_id: 'p1', thread_id: threadId, subject: null, body: 'words', resolved_at: null, idempotency_key: null, ...message }))
    },
    row: null
  }
}

/** A loopback Inbox as `fetch` sees it. `queue` holds what each session is still owed. */
export function fakeInbox(options: { asker?: string; root?: string } = {}) {
  const state = {
    token: 'token-1',
    up: true,
    /** The health answer's `serverSession`: a new one is a new start of the Inbox. */
    serverSession: 'boot-1',
    queue: new Map<string, unknown[]>(),
    acknowledged: [] as { session: string; id: string }[],
    polls: [] as Record<string, unknown>[],
    threads: { projects: [] as unknown[], sections: [] as unknown[] },
    ackStatus: 200,
    /** Every `state` event (`POST /api/inbox/bridge/event` with `type: "state"`), as sent. */
    events: [] as Record<string, unknown>[],
    /** How long an empty poll is held open (a real one up to 25 s); short by default to keep tests fast. */
    holdMs: 15,
    /**
     * `GET /api/inbox/threads/<id>`: an answer set here is served as it is; otherwise the thread is
     * made from every `reply()` in it, each a person's reply (written now) to an agent question by
     * `asker` in `root`.
     */
    details: new Map<string, unknown>(),
    asker: options.asker ?? DEFAULT_ASKER,
    root: options.root ?? '/work/project',
    threadStatus: 200,
    threadReads: [] as string[],
    /** `GET /api/inbox/orca`'s features; null: standard Plannotator (no such route). */
    features: null as string[] | null,
    /** The Orca build's agent rows (`/api/inbox/control/orca-agents`); null: no such route. */
    orcaAgents: null as Record<string, unknown>[] | null,
    /** What a POST to that route answers besides `agents`; `changed` defaults to the ids it moved. */
    orcaAnswer: null as null | ((body: Record<string, unknown>) => Record<string, unknown>),
    /** Standard Plannotator's agent rows (`GET /api/inbox/agents`); null: no such route. */
    stockAgents: null as Record<string, unknown>[] | null,
    /** Standard Plannotator's `connect` report (`POST /api/inbox/control/connect`). */
    stockReport: { added: [], already: [], failed: [], foreign: [], manual: [], unfinished: [], claude_code: false, first: false, at: '' } as Record<string, unknown>,
    /** Every request to the agent routes, with whether it carried the token and an Origin. */
    agentCalls: [] as { method: string; path: string; body: Record<string, unknown>; token: boolean; origin: boolean }[],
    /** Each agent's face (`/api/inbox/agent-faces`), and the pictures kept for agents (`/api/inbox/agent-icons`, by SHA-256). */
    agentFaces: {} as Record<string, { face: string; sessions: string[] }>,
    agentPictures: new Map<string, Uint8Array>()
  }
  const synthesized = (threadId: string): Record<string, unknown> | null => {
    const replies = [...REPLIES.values()].filter((command) => command.thread_id === threadId)
    if (replies.length === 0) return null
    const messages: WireMessage[] = []
    for (const parent of new Set(replies.map((command) => command.reply_to))) {
      if (typeof parent === 'string' && !REPLIES.has(parent)) messages.push(agentMessage(parent, state.asker))
    }
    for (const command of replies) {
      const to = (command as { to?: WireMessage['to'] }).to
      messages.push(personMessage(command.id, typeof command.reply_to === 'string' ? command.reply_to : null, to ? { to } : {}))
    }
    return threadAnswer(threadId, state.root, messages)
  }
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!state.up) throw new TypeError('fetch failed')
    const path = new URL(String(input)).pathname
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (path === '/api/inbox/health') return json(200, { ok: true, app: 'plannotator-inbox', version: '0.28.66', serverSession: state.serverSession })
    if (path === '/api/inbox/threads') return json(200, state.threads)
    if (path === '/api/inbox/agent-faces' && (init?.method ?? 'GET') === 'GET') return json(200, { faces: state.agentFaces, rev: 1 })
    const method = init?.method ?? 'GET'
    const agentRoute = ['/api/inbox/orca', '/api/inbox/agents', '/api/inbox/control/orca-agents', '/api/inbox/control/connect'].includes(path)
    if (agentRoute) {
      const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
      state.agentCalls.push({ method, path, body, token: lower.authorization === `Bearer ${state.token}`, origin: 'origin' in lower })
    }
    if (path === '/api/inbox/orca') return state.features ? json(200, { mode: 'orca', features: state.features }) : json(404, { code: 'not_found' })
    if (path === '/api/inbox/agents' && method === 'GET') return state.stockAgents ? json(200, { agents: state.stockAgents, records: {}, last_report: null, connecting: false }) : json(404, { code: 'not_found' })
    const thread = /^\/api\/inbox\/threads\/([^/]+)$/.exec(path)
    if (thread && (init?.method ?? 'GET') === 'GET') {
      const threadId = decodeURIComponent(thread[1]!)
      state.threadReads.push(threadId)
      if (state.threadStatus !== 200) return json(state.threadStatus, { error: 'failed', code: 'internal' })
      const answer = state.details.has(threadId) ? state.details.get(threadId) : synthesized(threadId)
      return answer ? json(200, answer) : json(404, { error: 'No such thread.', code: 'thread_not_found' })
    }
    if (headers.authorization !== `Bearer ${state.token}`) return json(401, { code: 'unauthorized' })
    if (path === '/api/inbox/bridge/poll') {
      state.polls.push(body)
      const waiting = state.queue.get(String(body.session)) ?? []
      if (waiting.length === 0) {
        // A real poll is held open; a short hold keeps the tests fast and still yields.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, state.holdMs)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      }
      return json(200, { commands: state.queue.get(String(body.session)) ?? [] })
    }
    if (path === '/api/inbox/control/orca-agents' && state.orcaAgents) {
      if (method === 'GET') return json(200, { v: 1, agents: state.orcaAgents })
      const except = new Set(Array.isArray(body.except) ? (body.except as string[]) : [])
      const changed: string[] = []
      for (const row of state.orcaAgents) {
        if (except.has(String(row.id)) || !row.detected) continue
        if (body.action === 'connect' && (row.state === 'absent' || row.state === 'plannotator')) {
          row.state = 'orca'
          changed.push(String(row.id))
        } else if (body.action === 'disconnect' && row.state === 'orca') {
          row.state = 'absent'
          changed.push(String(row.id))
        }
      }
      return json(200, { v: 1, agents: state.orcaAgents, changed, problems: [], ...(state.orcaAnswer?.(body) ?? {}) })
    }
    if (path === '/api/inbox/control/connect' && method === 'POST') return json(200, { connect: state.stockReport })
    if (path === '/api/inbox/agent-faces' && method === 'POST') {
      if (body.serverSession !== state.serverSession) return json(409, { code: 'session_mismatch' })
      state.agentFaces[String(body.agent)] = { face: String(body.face), sessions: [] }
      return json(200, { faces: state.agentFaces, rev: 1 })
    }
    if (path === '/api/inbox/agent-icons' && method === 'POST') {
      if (body.serverSession !== state.serverSession) return json(409, { code: 'session_mismatch' })
      const data = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.picture))
      if (!data) return json(400, { code: 'validation_error' })
      const bytes = new Uint8Array(Buffer.from(data[1]!, 'base64'))
      const id = createHash('sha256').update(bytes).digest('hex')
      state.agentPictures.set(id, bytes)
      return json(200, { icon: { id, type: 'image/png', at: 1 }, faces: state.agentFaces, rev: 1, icons: [] })
    }
    if (path === '/api/inbox/bridge/event' && body.type === 'state') {
      state.events.push(body)
      return json(200, { ok: true })
    }
    if (path === '/api/inbox/bridge/event') {
      if (state.ackStatus !== 200) return json(state.ackStatus, { code: 'message_not_found' })
      const session = String(body.session)
      state.acknowledged.push({ session, id: String(body.id) })
      state.queue.set(session, (state.queue.get(session) ?? []).filter((item) => (item as { id?: string }).id !== body.id))
      return json(200, { ok: true })
    }
    return json(404, { code: 'not_found' })
  }) as typeof fetch
  const registry = (): string => JSON.stringify({ v: 1, pid: 1, port: 4999, url: 'http://127.0.0.1:4999', version: '0.28.66', token: state.token })
  return {
    state,
    fetch: fetchImpl,
    readRegistry: async (): Promise<string | null> => registry(),
    /** Writes the registry where a real Inbox keeps it, owner-only. */
    writeRegistry: async (dataDir: string): Promise<void> => {
      await mkdir(join(dataDir, 'inbox'), { recursive: true })
      await writeFile(join(dataDir, 'inbox', 'inbox.json'), registry(), { mode: 0o600 })
    }
  }
}

/** A minimal MCP client over the launcher, as an agent's host would be. */
export function mcpClient(child: ChildProcessWithoutNullStreams) {
  let buffer = ''
  let nextId = 1
  const waiting = new Map<number, (message: Record<string, unknown>) => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end === -1) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === 'number') waiting.get(message.id)?.(message)
    }
  })
  return {
    notify: (method: string): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    request: (method: string, params: unknown = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 60_000)
        waiting.set(id, (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
          else resolve(message.result as Record<string, unknown>)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
  }
}

type WindowProject = { id: string; root: string; picture?: unknown; merged_into?: string }

/**
 * The stock Inbox's window routes for project pictures, as `fetch` sees them, with stock's rules:
 * a POST with an Origin of another host is refused (403), a `serverSession` that is present and not
 * this run's is refused (409) and saves nothing, a data URL over 800 000 characters or not an image
 * is refused (400), and a set picture's marker is when it was set, never the same twice.
 * `faultAfterSave: 'lost'` saves the picture and then loses the answer. Any request to a host other
 * than 127.0.0.1 is recorded in `foreign` and fails.
 */
export function fakeInboxWindow() {
  const state = {
    serverSession: 'boot-1',
    up: true,
    clock: 1_000,
    projects: new Map<string, WindowProject>(),
    uploads: new Map<string, Uint8Array>(),
    calls: [] as { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> }[],
    foreign: [] as string[],
    faultAfterSave: null as null | 'lost',
    /** Runs before each request is answered, to change things under the plugin. */
    before: null as null | ((method: string, path: string) => void)
  }
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const image = (bytes: Uint8Array): boolean => {
    const head = Buffer.from(bytes.subarray(0, 12))
    return (
      head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1')) ||
      (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') ||
      Buffer.from(bytes).toString('utf8').trimStart().replace(/^<\?xml[^>]*>\s*/, '').startsWith('<svg')
    )
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.hostname !== '127.0.0.1') {
      state.foreign.push(url.href)
      throw new TypeError('fetch failed')
    }
    if (!state.up) throw new TypeError('fetch failed')
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    state.calls.push({ method, path: url.pathname, body, headers })
    state.before?.(method, url.pathname)
    if (method === 'POST' && headers.origin && new URL(headers.origin).host !== url.host) return json(403, { code: 'cross_origin' })
    if (url.pathname === '/api/inbox/projects' && method === 'GET') {
      return json(200, { serverSession: state.serverSession, cursor: 1, projects: [...state.projects.values()].map((p) => ({ ...p, threads: 0, unread: 0 })) })
    }
    const match = /^\/api\/inbox\/projects\/([A-Za-z0-9_]+)\/picture$/.exec(url.pathname)
    if (match) {
      const project = state.projects.get(match[1]!)
      if (!project) return json(404, { code: 'project_not_found' })
      if (method === 'GET') {
        const bytes = state.uploads.get(project.id)
        return bytes ? new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': 'image/png' } }) : json(404, { code: 'no_picture' })
      }
      if (typeof body?.serverSession === 'string' && body.serverSession !== state.serverSession) return json(409, { code: 'session_mismatch' })
      const given = typeof body?.picture === 'string' ? body.picture : ''
      if (given.length > 800_000) return json(400, { code: 'validation_error' })
      const data = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(given)
      const bytes = data ? new Uint8Array(Buffer.from(data[1]!, 'base64')) : null
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 || !image(bytes)) return json(400, { code: 'validation_error' })
      state.uploads.set(project.id, bytes)
      state.clock = Math.max(state.clock + 1, typeof project.picture === 'number' ? project.picture + 1 : 0)
      project.picture = state.clock
      if (state.faultAfterSave === 'lost') throw new TypeError('fetch failed')
      return json(200, { project: { ...project, threads: 0 } })
    }
    return json(404, { code: 'not_found' })
  }) as typeof fetch
  const registry = (): string => JSON.stringify({ v: 1, pid: 1, port: 4999, url: 'http://127.0.0.1:4999', version: '0.28.66', token: 'token-1' })
  return {
    state,
    fetch: fetchImpl,
    readRegistry: async (): Promise<string | null> => registry(),
    writes: () => state.calls.filter((call) => call.method === 'POST'),
    addProject: (id: string, root: string, extra: Partial<WindowProject> = {}): void => void state.projects.set(id, { id, root, ...extra })
  }
}

// ---------------------------------------------------------------------------------------------
// Start, Stop and Resume from the Inbox (src/lifecycle.ts, src/bridge.ts)

/** A launch root as the Inbox serves it: a person's message that carries the launch. */
export function launchThread(
  threadId: string,
  root: string,
  launch: Record<string, unknown>,
  extra: WireMessage[] = []
): Record<string, unknown> {
  const message = { ...personMessage(threadId, null), launch } as WireMessage
  return threadAnswer(threadId, root, [message, ...extra])
}

/**
 * Orca's CLI for workspaces, chats and launches, as `Exec` sees it. One local workspace
 * (`wt1` at `/work/project`, repository `repo_1`), plus an archived one and one on another host.
 * `agent launch` replays an operation id it has seen; `launchFault` loses the answer after making
 * the chat (`lost`), refuses before making anything (`refused`), or makes a terminal (`terminal`).
 */
export function fakeLifecycleOrca() {
  const state = {
    folder: '/work/project',
    workspaceId: 'wt1',
    selector: 'id:wt1',
    repos: [{ id: 'repo_1', path: '/work/project', displayName: 'Project' }] as Record<string, unknown>[],
    /** Chats Orca lists with activity: session → { state, agentType, workspaceId, mainAgent, stateStartedAt }. */
    listed: new Map<string, { state: string; agentType: string; workspaceId?: string; mainAgent?: { state: string }; stateStartedAt?: number }>(),
    /** What `agent read` answers for a chat: its newest entries. A chat not here has none. */
    entries: new Map<string, Record<string, unknown>[]>(),
    /** When set, each `agent read` answers only once what this returns settles: a slow (or never answering) read. */
    readGate: null as null | ((session: string) => Promise<void>),
    /** Chats made by `agent launch`, by operation id. */
    operations: new Map<string, string>(),
    created: 0,
    launchFault: null as null | 'lost' | 'refused' | 'terminal',
    calls: [] as string[][],
    activated: [] as string[],
    truncated: false
  }
  const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
  const option = (args: string[], name: string): string | null => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : null)
  const exec: Exec = async (_file, argv) => {
    const args = argv.slice(0, -3)
    state.calls.push(args)
    const command = args.slice(0, 2).join(' ')
    if (command === 'worktree ps') {
      const agents = (workspaceId: string) =>
        [...state.listed.entries()]
          .filter(([, chat]) => (chat.workspaceId ?? state.workspaceId) === workspaceId)
          .map(([session, chat], index) => ({
            paneKey: `structured-agent-session-${session}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            state: chat.state,
            agentType: chat.agentType,
            ...(chat.mainAgent ? { mainAgent: chat.mainAgent } : {}),
            ...(chat.stateStartedAt ? { stateStartedAt: chat.stateStartedAt } : {})
          }))
      return ok({
        truncated: state.truncated,
        worktrees: [
          { worktreeId: state.workspaceId, repoId: 'repo_1', repo: 'project', displayName: 'main', path: state.folder, hostId: 'local', isArchived: false, address: { environment: 'local', worktree: state.selector }, agents: agents(state.workspaceId) },
          { worktreeId: 'wt2', repoId: 'repo_1', path: '/work/project-other', hostId: 'local', isArchived: false, address: { environment: 'local', worktree: 'id:wt2' }, agents: agents('wt2') },
          { worktreeId: 'wt-old', repoId: 'repo_1', path: '/work/archived', hostId: 'local', isArchived: true, agents: [] },
          { worktreeId: 'wt-remote', repoId: 'repo_1', path: '/remote/project', hostId: 'ssh-1', agents: [] }
        ]
      })
    }
    if (command === 'repo list') return ok({ repos: state.repos })
    if (command === 'agent read') {
      const session = (option(args, '--id') ?? '').replace(/^orca_session_id:/, '')
      if (state.readGate) await state.readGate(session)
      return ok({ orcaSessionId: session, kind: 'chat', agent: 'codex', source: 'chat', entries: state.entries.get(session) ?? [], limited: false })
    }
    if (command === 'agent launch') {
      const operation = option(args, '--retry-launch') ?? ''
      if (state.launchFault === 'refused') return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'invalid_argument' } }) }
      let session = state.operations.get(operation)
      if (!session) {
        state.created += 1
        session = `native_${state.created}`
        state.operations.set(operation, session)
      }
      if (state.launchFault === 'lost') return { code: 1, stdout: '' }
      if (state.launchFault === 'terminal') return ok({ worktreeId: state.workspaceId, outcome: { kind: 'terminal', handle: 'term_1' } })
      return ok({ worktreeId: state.workspaceId, outcome: { kind: 'structured', sessionId: session, handle: 'h' }, operationId: operation })
    }
    if (command === 'worktree activate') {
      const selector = option(args, '--worktree') ?? ''
      state.activated.push(selector)
      return ok({ worktreeId: selector.replace(/^id:/, '') })
    }
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'unknown_command' } }) }
  }
  return { state, exec, launches: () => state.calls.filter((args) => args.slice(0, 2).join(' ') === 'agent launch') }
}

type NativeCall = { action: string; body: Record<string, unknown> }
/**
 * bin/session.cjs as the lifecycle sees it. Every chat made by `orca` has a tab (`tabs`), so a new
 * chat can be proven; `answers` replaces what one operation says.
 */
export function fakeNative(orca: ReturnType<typeof fakeLifecycleOrca>) {
  const state = {
    calls: [] as NativeCall[],
    answers: new Map<string, { ok: true; result: Record<string, unknown> } | { ok: false; reason: string; started: boolean; code: string | null }>(),
    tabs: null as null | Map<string, string>,
    fence: 1
  }
  const run = async (action: string, body: Record<string, unknown>) => {
    state.calls.push({ action, body: structuredClone(body) })
    const fixed = state.answers.get(action)
    if (fixed) return structuredClone(fixed)
    if (action === 'support') return { ok: true as const, result: { supported: true, model: true, effort: true } }
    if (action === 'session-proof') {
      const tabs = state.tabs ?? new Map([...orca.state.operations.values()].map((session) => [session, 'codex']))
      const session = String(body.sessionId)
      if (tabs.get(session) !== body.agent || body.workspaceId !== orca.state.workspaceId) return { ok: false as const, reason: 'the chat tab is absent', started: true, code: 'failed' }
      const tabId = `structured-agent-session-${session}`
      return { ok: true as const, result: { sessionId: session, agent: body.agent, workspaceId: body.workspaceId, tabId, pane: `${tabId}:00000000-0000-4000-8000-000000000001` } }
    }
    if (action === 'prepare-stop') {
      const signature = { epoch: 'e1', fence: state.fence, liveCursor: null }
      return { ok: true as const, result: { signature, params: { envelope: { sessionId: body.sessionId, clientOperationId: body.operationId, expectedRuntimeFence: state.fence, payloadFingerprint: 'f'.repeat(64) } } } }
    }
    if (action === 'stop') return { ok: true as const, result: { ok: true, stopped: true } }
    if (action === 'continue') return { ok: true as const, result: { ok: true } }
    return { ok: false as const, reason: 'unknown', started: true, code: 'failed' }
  }
  return { state, run, actions: () => state.calls.map((call) => call.action) }
}
