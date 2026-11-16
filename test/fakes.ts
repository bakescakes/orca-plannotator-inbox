// Stand-ins for the two programs the plugin talks to, at the same boundaries the real ones sit:
// Orca's CLI (argv in, one JSON document out) and the Plannotator Inbox (loopback HTTP).
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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

export function fakeOrca(options: { sessions?: string[]; deliverAtOnce?: boolean } = {}) {
  const state = {
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
    inventoryShape: 'current' as 'current' | 'renamed'
  }
  const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
  const refuse = (code: string, data?: unknown) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code, data } }) })
  const option = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? ''
  const exec: Exec = async (_file, argv, execOptions) => {
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
        conversationName: `Chat ${index + 1}`
      }))
      return ok({ worktrees: [{ path: '/work/project', hostId: null, agents }, { path: '/remote', hostId: 'ssh-1', agents: [] }], truncated: false })
    }
    if (command === 'orchestration send') {
      const request = option(args, '--retry-request')
      if (state.sendFault === 'not-sent') return refuse('consumer_fenced', { requestSent: false })
      if (state.sendFault === 'dropped') return { code: 1, stdout: '' }
      let message = state.requests.get(request)
      if (!message) {
        message = {
          id: `mail_${state.mail.length + 1}`,
          from_handle: option(args, '--from'),
          to_handle: option(args, '--to'),
          subject: option(args, '--subject'),
          body: option(args, '--body'),
          payload: option(args, '--payload'),
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

export function reply(id: string, overrides: Partial<InboxCommand> = {}): InboxCommand {
  return {
    type: 'reply',
    id,
    thread_id: 'thr_1',
    reply_to: 'msg_question',
    subject: 'Ship it?',
    body: 'Yes, ship it.',
    url: 'http://127.0.0.1:4999/#/thread/thr_1',
    ...overrides
  } as InboxCommand
}

/** A loopback Inbox as `fetch` sees it. `queue` holds what each session is still owed. */
export function fakeInbox() {
  const state = {
    token: 'token-1',
    up: true,
    queue: new Map<string, unknown[]>(),
    acknowledged: [] as { session: string; id: string }[],
    polls: [] as Record<string, unknown>[],
    threads: { projects: [] as unknown[], sections: [] as unknown[] },
    ackStatus: 200
  }
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!state.up) throw new TypeError('fetch failed')
    const path = new URL(String(input)).pathname
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (path === '/api/inbox/health') return json(200, { ok: true, app: 'plannotator-inbox', version: '0.28.66', serverSession: 'boot-1' })
    if (path === '/api/inbox/threads') return json(200, state.threads)
    if (headers.authorization !== `Bearer ${state.token}`) return json(401, { code: 'unauthorized' })
    if (path === '/api/inbox/bridge/poll') {
      state.polls.push(body)
      const waiting = state.queue.get(String(body.session)) ?? []
      if (waiting.length === 0) {
        // A real poll is held open; a short hold keeps the tests fast and still yields.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      }
      return json(200, { commands: state.queue.get(String(body.session)) ?? [] })
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
