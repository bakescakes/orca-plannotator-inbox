// Start, Open, Stop and Resume from the Inbox, inside a real Orca with the real Orca build of
// Plannotator. A second, windowless Orca with its own throwaway profile and home installs this
// plugin from a folder, as in-app.test.ts does; the Orca build comes from a release server on
// 127.0.0.1 (test/release-fakes.mjs). Then, in order:
//
//  1. The installed worker writes the bridge files, and the Orca build is installed from the
//     release server and recorded in `<shared>/plannotator/current.json`.
//  2. A real native chat sends through the launcher with no PLANNOTATOR_BIN: the Inbox that starts
//     is the Orca build in Orca mode, and a person's reply reaches the chat's Orca mailbox.
//  3. Start: the person starts Claude Code in the test project from New message, exactly as the
//     Inbox window sends it. The bridge records the launch, a new real Orca chat exists in the
//     project's workspace, the Inbox lists it as started under host `orca`, the message that started
//     it reaches the new chat's mailbox once, and asking again starts no second chat.
//  4. Open: the run line's Open answers ok.
//  5. Stop and Resume, as far as a chat whose agent is not signed in allows (see the step).
//  6. The started chat's icon: `mark:claude-code` under the id the Inbox lists that agent by.
//
// Runs only when ORCA_INAPP_CLI names the `orca` CLI inside the Orca.app to start,
// ORCA_BUILD_E2E_BIN an Orca build of Plannotator for this computer, and `claude` is installed (Orca
// needs an agent program to open a chat). It never touches the default Orca profile, the real Inbox
// or any agent's settings, and the chat's agent is not signed in.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../src/util'
import { mcpClient, tempDir, until } from './fakes'
// @ts-expect-error a plain module without types, shared with the updater's own tests
import { releaseServer } from './release-fakes.mjs'

const text = (name: string): string => (process.env[name] ?? '').trim()
const CLI = text('ORCA_INAPP_CLI')
const BUILD = text('ORCA_BUILD_E2E_BIN')
const CLAUDE = text('PATH')
  .split(delimiter)
  .filter(Boolean)
  .map((folder) => join(folder, 'claude'))
  .find((candidate) => existsSync(candidate))
const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const CHAT_VARIABLES = ['ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_USER_DATA_PATH', 'ORCA_CLI_COMMAND', 'ORCA_TERMINAL_HANDLE']
const skip =
  !CLI || !BUILD ? 'set ORCA_INAPP_CLI and ORCA_BUILD_E2E_BIN to run' : !CLAUDE ? 'needs `claude` on PATH' : process.platform === 'win32' ? 'not run on Windows yet' : false

type Answer = { ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string; data?: Record<string, unknown> } }
type Mail = { from_handle?: string; body?: string; delivered_at?: string | null }
type Json = Record<string, unknown>

function note(line: string): void {
  process.stderr.write(`[in-app-build] ${line}\n`)
}

/** `until`, returning what was waited for. */
async function found<T>(look: () => Promise<T | null | undefined>, what: string, timeoutMs: number): Promise<T> {
  let value: T | null | undefined
  await until(async () => (value = await look()) != null, what, timeoutMs)
  return value as T
}

function versionOf(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(binary, ['--version'], { env, timeout: 30_000 }, (error, stdout) => {
      const version = /\d+\.\d+\.\d+/.exec(String(stdout))?.[0]
      if (error || !version) reject(new Error(`the Orca build did not say its version: ${error?.message ?? stdout}`))
      else resolve(version)
    })
  )
}

test('inside a real Orca with the Orca build: Start, Open, Stop and Resume from the Inbox', { skip, timeout: 900_000 }, async () => {
  const root = await realpath(await tempDir('orca-plannotator-inapp-build-'))
  const profile = join(root, 'profile')
  const home = join(profile, 'home')
  const bin = join(home, '.local', 'bin')
  const project = join(root, 'project')
  const copy = join(root, 'plugin')
  const dataDir = join(home, '.plannotator')
  const shared = join(home, '.orca-plannotator-inbox')
  await mkdir(bin, { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(copy, { recursive: true })
  const version = await versionOf(BUILD, { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR, PLANNOTATOR_DATA_DIR: dataDir })
  const releases = await releaseServer([{ version, build: 'orca.1', bytes: readFileSync(BUILD) }])
  const chatEnvDir = join(root, 'chat-env')
  await mkdir(chatEnvDir, { recursive: true })
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  // The chat's agent, as Orca starts it: note the chat's Orca variables, then be the real program.
  await writeFile(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'if [ -n "${ORCA_AGENT_SESSION_ID:-}" ]; then',
      `  target=${quoted(chatEnvDir)}/"$ORCA_AGENT_SESSION_ID"`,
      `  for name in ${CHAT_VARIABLES.join(' ')}; do eval "value=\\\${$name-}"; printf '%s=%s\\n' "$name" "$value"; done > "$target.$$.tmp" && mv "$target.$$.tmp" "$target"`,
      'fi',
      `exec ${quoted(await realpath(CLAUDE!))} "$@"`,
      ''
    ].join('\n')
  )
  await chmod(join(bin, 'claude'), 0o755)
  // Orca asks a login shell for PATH and that shell's order wins: it lists the system folders first
  // (Homebrew's among them, where an installed `claude` may be), then what it inherited. So this
  // folder is put first the way a person would do it, in the shell's own profile.
  for (const name of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) await writeFile(join(home, name), `export PATH=${quoted(bin)}:"$PATH"\n`)
  for (const name of ['orca-plugin.json', 'package.json', 'README.md', 'src', 'bin']) await cp(join(PLUGIN, name), join(copy, name), { recursive: true })

  // Orca gives a plugin's worker only a short list of variables (PATH, HOME, TMPDIR, …), so a release
  // server named here does not reach the worker's updater. The worker's routine check is marked as
  // just done, so it does not look on GitHub while this test runs; the build is installed below by
  // the same updater the worker and the Inbox's Update button run.
  await mkdir(join(shared, 'plannotator'), { recursive: true, mode: 0o700 })
  await writeFile(join(shared, 'plannotator', 'check.json'), JSON.stringify({ v: 1, lastAttempt: Date.now(), failures: 0, lastError: null, lastErrorAt: 0, latestKnown: null }), { mode: 0o600 })

  const env = {
    PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: home,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    ORCA_E2E_USER_DATA_DIR: profile,
    ORCA_USER_DATA_PATH: profile,
    ORCA_E2E_HEADLESS: '1',
    ORCA_PLANNOTATOR_RELEASES: releases.base
  } as NodeJS.ProcessEnv
  const plannotatorEnv = { ...env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_AUTO_UPDATE: '0', PLANNOTATOR_BROWSER: 'none' }
  const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(file, args, { env: options.env ?? env, cwd: options.cwd ?? root, timeout: options.timeoutMs ?? 90_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) =>
        resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    )
  const orca = async (...args: string[]): Promise<Answer> => {
    const out = (await run(CLI, [...args, '--json'])).stdout
    try {
      return JSON.parse(out) as Answer
    } catch {
      throw new Error(`orca ${args.join(' ')} answered: ${out.slice(0, 400)}`)
    }
  }

  await run('git', ['init', '-q', '-b', 'trial', project])
  await run('git', ['-c', 'user.name=trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: project })

  /** The chats Orca lists in the project's workspace, by session id, with the agent each one runs. */
  const chatsInProject = async (): Promise<Map<string, string | null>> => {
    const listed = (await orca('worktree', 'ps', '--limit', '1000')).result
    const chats = new Map<string, string | null>()
    for (const tree of Array.isArray(listed?.worktrees) ? listed.worktrees : []) {
      if (!isRecord(tree) || typeof tree.path !== 'string' || (await realpath(tree.path).catch(() => tree.path)) !== project) continue
      for (const agent of Array.isArray(tree.agents) ? tree.agents : []) {
        const match = isRecord(agent) && typeof agent.paneKey === 'string' ? /^structured-agent-session-([A-Za-z0-9_-]+):/.exec(agent.paneKey) : null
        if (match) chats.set(match[1]!, typeof agent.agentType === 'string' ? agent.agentType : null)
      }
    }
    return chats
  }
  /**
   * The chat tabs Orca's runtime has in one workspace (`session.tabs.list`), by session id with their
   * agent. Unlike `worktree ps`, this lists a chat that has had no turn yet.
   */
  const app = CLI.slice(0, CLI.indexOf('.app/') + 4)
  const tabsIn = async (worktree: string): Promise<Map<string, string>> => {
    const out = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'out')
    const script = [
      `const { RuntimeClient } = require(${JSON.stringify(join(out, 'cli', 'runtime', 'client.js'))})`,
      'new RuntimeClient(undefined, 12000, null, null)',
      `  .call('session.tabs.list', { worktree: ${JSON.stringify(worktree)} })`,
      '  .then((answer) => process.stdout.write(JSON.stringify(answer), () => process.exit(0)), (error) => process.stdout.write(JSON.stringify({ ok: false, error: String(error) }), () => process.exit(1)))'
    ].join('\n')
    const answered = await run(join(app, 'Contents', 'MacOS', 'Orca'), ['-e', script], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
    const parsed = JSON.parse(answered.stdout || '{}') as { ok?: boolean; result?: { tabs?: Json[] } }
    assert.equal(parsed.ok, true, answered.stdout.slice(0, 600))
    const tabs = new Map<string, string>()
    for (const tab of parsed.result?.tabs ?? []) if (tab.type === 'agent-session' && typeof tab.sessionId === 'string') tabs.set(tab.sessionId, String(tab.agent))
    return tabs
  }
  const mailOf = async (session: string): Promise<Mail[]> => {
    const box = await orca('orchestration', 'inbox', '--terminal', `orca_session_id:${session}`, '--full')
    return ((box.result?.messages as Mail[] | undefined) ?? []).filter((message) => message.from_handle === 'plannotator-inbox')
  }

  const started = Date.now()
  const serve = spawn(CLI, ['serve', '--no-pairing', '--bind', '127.0.0.1', '--json'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let serveLog = ''
  serve.stdout.on('data', (chunk: Buffer) => (serveLog += chunk.toString('utf8')))
  serve.stderr.on('data', (chunk: Buffer) => (serveLog += chunk.toString('utf8')))
  let agent: ReturnType<typeof spawn> | null = null
  let agentErr = ''
  try {
    await until(() => serveLog.includes('orca_server_ready'), 'the second Orca to start', 90_000)
    const orcaVersion = ((await orca('status')).result?.runtime as { appVersion?: string } | undefined)?.appVersion
    const asked = await orca('plugin', 'install', copy)
    assert.equal(asked.error?.code, 'approval_required', JSON.stringify(asked).slice(0, 400))
    const installed = await orca('plugin', 'install', copy, '--approve', String(asked.error?.data?.approvalFingerprint))
    assert.equal(installed.ok, true, JSON.stringify(installed).slice(0, 600))
    assert.equal((await orca('repo', 'add', '--path', project, '--kind', 'git')).ok, true)

    // ---------------------------------------------------------------------------------------
    // 1. The worker: delivering, the bridge files, and the Orca build installed.
    const state = async (): Promise<{ at: number; delivering: boolean } | null> => (existsSync(join(shared, 'state.json')) ? JSON.parse(await readFile(join(shared, 'state.json'), 'utf8')) : null)
    await until(async () => { const now = await state(); return now !== null && now.at >= started && now.delivering === true }, 'the installed worker to say it delivers', 60_000)
    const bridgeDir = join(shared, 'bridge')
    await until(() => existsSync(join(bridgeDir, 'config.json')) && existsSync(join(bridgeDir, 'navigation.json')) && existsSync(join(bridgeDir, 'link-key')), 'the bridge files', 30_000)
    const config = JSON.parse(await readFile(join(bridgeDir, 'config.json'), 'utf8')) as { canonicalDataDir: string; mcpCommand: string[]; upgradeCommand: string[] }
    assert.equal(config.canonicalDataDir, dataDir)
    assert.deepEqual(config.mcpCommand, [join(shared, 'inbox-mcp')])
    assert.ok(config.upgradeCommand.length === 1 && existsSync(config.upgradeCommand[0]!), JSON.stringify(config))
    assert.equal(releases.downloads(), 0, 'the worker did not reach the release server through Orca')
    // The updater exactly as the Inbox's Update button starts it (config.json's upgradeCommand).
    const updated = await run(config.upgradeCommand[0]!, ['--version', version], { env: { PATH: env.PATH, HOME: home, TMPDIR: env.TMPDIR, ORCA_PLANNOTATOR_RELEASES: releases.base } as NodeJS.ProcessEnv, timeoutMs: 300_000 })
    const said = JSON.parse(updated.stdout.trim().split('\n').pop() ?? '{}') as { ok?: boolean; detail?: string }
    assert.equal(said.ok, true, `${updated.stdout}\n${updated.stderr}`)
    assert.equal(releases.downloads(), 1)
    const current = JSON.parse(await readFile(join(shared, 'plannotator', 'current.json'), 'utf8')) as { version: string; build: string }
    assert.equal(current.version, version)
    assert.equal(current.build, 'orca.1')
    {
      // Orca gives its plugin worker only PATH, HOME, TMPDIR and a few more: the one process of this
      // Orca without the release address is the worker's host.
      const all = (await run('/bin/ps', ['-A', '-ww', '-E', '-o', 'pid=,command='])).stdout.split('\n').filter((line) => line.includes(`HOME=${home}`))
      const without = all.filter((line) => !line.includes('ORCA_PLANNOTATOR_RELEASES='))
      note(`processes of this Orca: ${all.length}; without the release address: ${JSON.stringify(without.map((line) => (line.includes('plugin-host-entry') ? 'the plugin worker host' : line.slice(0, 200))))}`)
    }
    note(`1: worker delivering, bridge files written, Orca build ${version} (orca.1) installed`)

    const keyHex = (await readFile(join(bridgeDir, 'link-key'))).toString('hex')
    const bridge = async (path: string, body?: Json): Promise<{ status: number; body: Json }> => {
      const { port } = JSON.parse(await readFile(join(bridgeDir, 'navigation.json'), 'utf8')) as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${keyHex}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
      return { status: response.status, body: (await response.json()) as Json }
    }

    // ---------------------------------------------------------------------------------------
    // 2. A real native chat sends through the launcher, with no PLANNOTATOR_BIN.
    const launched = await orca('agent', 'launch', '--agent', 'claude', '--worktree', `path:${project}`, '--surface', 'chat', '--prompt', 'Automated test: no action needed.')
    const outcome = launched.result?.outcome
    assert.ok(isRecord(outcome) && outcome.kind === 'structured' && typeof outcome.sessionId === 'string', JSON.stringify(launched).slice(0, 600))
    const asker = outcome.sessionId as string
    await until(() => existsSync(join(chatEnvDir, asker)), 'Orca to start the chat’s agent', 60_000)
    const chatEnv: Record<string, string> = {}
    for (const line of (await readFile(join(chatEnvDir, asker), 'utf8')).split('\n')) {
      const at = line.indexOf('=')
      if (at > 0 && line.slice(at + 1) !== '') chatEnv[line.slice(0, at)] = line.slice(at + 1)
    }
    assert.equal(chatEnv.ORCA_AGENT_SESSION_ID, asker)
    agent = spawn(join(shared, 'inbox-mcp'), [], { cwd: project, env: { ...plannotatorEnv, ...chatEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
    agent.stderr!.on('data', (chunk: Buffer) => (agentErr += chunk.toString('utf8')))
    const mcp = mcpClient(agent as never)
    const hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orca-plannotator-inapp-build', version: '0' } })
    assert.match(String(hello.instructions), /In this Orca chat you are already connected/)
    mcp.notify('notifications/initialized')
    await mcp.request('tools/list')
    const sent = JSON.stringify(await mcp.request('tools/call', { name: 'send_message', arguments: { subject: `In-app build trial ${asker}`, body: 'Trial question: reply with any word.', agent_host: 'claude-code', agent_name: 'Claude' } }))
    const messageId = /msg_[A-Za-z0-9_]+/.exec(sent)?.[0]
    assert.ok(messageId, sent)

    const registry = JSON.parse(await readFile(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string }
    const origin = `http://127.0.0.1:${registry.port}`
    const same = { 'content-type': 'application/json', origin }
    const inbox = async (path: string, body?: Json): Promise<{ status: number; body: Json }> => {
      const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: same, ...(body ? { body: JSON.stringify(body) } : {}) })
      const raw = await response.text()
      let parsed: Json = {}
      try {
        parsed = JSON.parse(raw) as Json
      } catch {
        parsed = { raw: raw.slice(0, 600) }
      }
      return { status: response.status, body: parsed }
    }
    const card = (await inbox('/api/inbox/orca')).body as { mode?: string; features?: string[] }
    assert.equal(card.mode, 'orca', JSON.stringify(card))
    const health = (await inbox('/api/inbox/health')).body as { serverSession: string; version: string }
    assert.equal(health.version, version, 'the Inbox that started is the installed Orca build')
    const serverSession = health.serverSession
    const answered = await inbox(`/api/inbox/messages/${messageId}/reply`, { serverSession, idempotency_key: `inapp-build-${asker}`, words: 'Pineapple.' })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    let mail: Mail[] = []
    await until(async () => { mail = await mailOf(asker); return mail.length > 0 && Boolean(mail[0]?.delivered_at) }, 'the reply in the chat’s Orca mailbox', 90_000)
    assert.equal(mail.length, 1)
    assert.match(mail[0]!.body!, /Pineapple\./)
    note(`2: the Inbox is the Orca build ${health.version} in Orca mode; the reply reached ${asker}`)

    // ---------------------------------------------------------------------------------------
    // 3. Start from the Inbox: New message → Start Claude Code in the test project.
    const firstThread = (await inbox(`/api/inbox/threads/${messageId}`)).body as { thread?: { project?: { id?: string; root?: string } } }
    const projectId = firstThread.thread?.project?.id
    assert.ok(typeof projectId === 'string', JSON.stringify(firstThread).slice(0, 600))
    assert.equal(firstThread.thread?.project?.root, project)
    const catalog = (await bridge('/api/lifecycle/catalog')).body as { workspaces?: { folder: string; selector: string; workspaceId: string }[] }
    const workspace = catalog.workspaces?.find((row) => row.folder === project)
    assert.ok(workspace, `the bridge offers the project's workspace: ${JSON.stringify(catalog).slice(0, 1500)}`)
    const before = await tabsIn(workspace.selector)
    assert.ok(before.has(asker), 'the tab list shows the first chat')
    note(`chat tabs in the project before Start: ${JSON.stringify([...before])}`)
    const compose = (await inbox('/api/inbox/sessions')).body as { launch?: unknown }
    note(`compose launch block: ${JSON.stringify(compose.launch).slice(0, 1500)}`)

    const startWords = `Inbox start trial ${Date.now()}: no action needed.`
    const send = { serverSession, idempotency_key: `inapp-build-start-${asker}`, to: { launch: { agent: 'claude-code', project_id: projectId } }, body: startWords }
    const sentStart = await inbox('/api/inbox/messages', send)
    note(`start answered ${sentStart.status}: ${JSON.stringify(sentStart.body).slice(0, 1200)}`)
    assert.equal(sentStart.status, 200, JSON.stringify(sentStart.body))
    const threadId = String(sentStart.body.thread_id)
    const launchId = String((sentStart.body.launch as Json | undefined)?.id)
    assert.match(launchId, /^lch_/)

    type Root = { id: string; thread_id: string; to?: { host: string; session: string }; launch?: { id: string; session_ref: string | null; error?: { text?: string } } }
    const rootOf = async (): Promise<Root> => {
      const thread = (await inbox(`/api/inbox/threads/${threadId}`)).body as { thread?: { messages?: Root[] } }
      return thread.thread!.messages!.find((message) => message.id === threadId)!
    }
    const settled = await found(async () => { const now = await rootOf(); return now.launch?.session_ref || now.launch?.error ? now : null }, 'the launch to settle', 120_000)
    note(`launch settled: ${JSON.stringify(settled).slice(0, 1500)}`)
    assert.ok(!settled.launch?.error, JSON.stringify(settled.launch))
    const session = settled.launch!.session_ref!
    assert.equal(settled.to?.host, 'orca')
    assert.equal(settled.to?.session, session)

    // The bridge got `start` and records exactly one launch that owns the new chat.
    const owner = await bridge(`/api/lifecycle/status?session=${encodeURIComponent(session)}`)
    note(`bridge status: ${JSON.stringify(owner.body)}`)
    assert.deepEqual(owner.body, { ok: true, version: 1, session, complete: true, launches: [{ launchId, state: 'created', session }] })
    // A new real Orca chat in the project's workspace, running Claude, and only one.
    const after = await tabsIn(workspace.selector)
    assert.equal(before.has(session), false)
    assert.equal(after.get(session), 'claude')
    assert.equal(after.size, before.size + 1, 'exactly one new chat')
    const ownedRow = ((await bridge('/api/lifecycle/catalog')).body.sessions as Record<string, Json>)[session]
    assert.equal(ownedRow?.workspaceId, workspace.workspaceId, 'the bridge shows the chat it owns, in that workspace')
    // `worktree ps` lists a chat only once it has had a turn, so the new chat is not in it yet.
    note(`worktree ps lists the new chat: ${(await chatsInProject()).has(session)}`)

    // The Inbox lists it as started, under host `orca`, by its launch id.
    const listed = async (): Promise<Json | null> => {
      const list = (await inbox('/api/inbox/threads?archived=exclude')).body as { agents?: { agents?: Json[] }[] }
      return (list.agents?.[0]?.agents ?? []).find((row) => row.id === launchId) ?? null
    }
    const row = await found(listed, 'the started agent in the Inbox’s agent list', 30_000)
    note(`agent row: ${JSON.stringify(row)}`)
    assert.equal(row.host, 'orca')
    assert.equal(row.session, session)
    assert.equal((row.launch as Json | undefined)?.started, true)

    // The message that started it reaches the new chat's mailbox, once.
    let startMail: Mail[] = []
    await until(async () => { startMail = await mailOf(session); return startMail.length > 0 && Boolean(startMail[0]?.delivered_at) }, 'the starting message in the new chat’s Orca mailbox', 120_000)
    assert.equal(startMail.length, 1)
    assert.ok(startMail[0]!.body!.includes(startWords), startMail[0]!.body)

    // Asking again starts no second chat: the same Send, the run line's Try again, and the
    // bridge's own Try again for that launch.
    const replay = await inbox('/api/inbox/messages', send)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.replayed, true)
    assert.equal(replay.body.thread_id, threadId)
    const retried = await inbox(`/api/inbox/launch/${launchId}/retry`, { serverSession })
    note(`retry answered ${retried.status}: ${JSON.stringify(retried.body).slice(0, 400)}`)
    assert.notEqual(retried.status, 200, 'a launch that started is not started again')
    const again = await bridge('/api/lifecycle/start', { launchId, threadId, messageId: threadId, provider: 'claude-code', folder: project, ownerAction: true, reconcile: true })
    note(`bridge start again: ${JSON.stringify(again.body)}`)
    assert.equal(again.body.ok, true)
    assert.equal(again.body.session, session)
    assert.equal(again.body.replayed, true)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.deepEqual([...(await tabsIn(workspace.selector)).keys()].sort(), [...after.keys()].sort(), 'still exactly one new chat')
    assert.equal((await mailOf(session)).length, 1, 'the starting message was delivered once')
    note(`3: started ${session} for ${launchId}; one chat, one delivery`)

    // ---------------------------------------------------------------------------------------
    // 4. Open: the run line's "Open in Orca". The bridge brings the chat forward (its tab, or its
    //    workspace when Orca cannot bring the tab forward in a windowless Orca).
    const pluginLines = async (): Promise<string[]> => {
      const logs = JSON.parse((await run(CLI, ['plugin', 'logs', 'local.plannotator-inbox', '--json'])).stdout || '{}') as { result?: { lines?: { line: string }[] } }
      return (logs.result?.lines ?? []).map((line) => line.line)
    }
    /** The nth line the bridge logged for one kind of action (`lifecycle: <kind> …`). */
    const lifecycleLine = (kind: string, nth: number): Promise<string> =>
      found(async () => (await pluginLines()).filter((line) => line.startsWith(`lifecycle: ${kind} `))[nth] ?? null, `the bridge's ${kind} (${nth + 1})`, 60_000)
    const ownedNow = async (): Promise<Json> => ((await bridge('/api/lifecycle/catalog')).body.sessions as Record<string, Json>)[session] ?? {}
    const opened = await inbox(`/api/inbox/launch/${launchId}/open`, { serverSession })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    assert.deepEqual(opened.body, { ok: true, openedIn: 'orca' })
    const openLine = await lifecycleLine('open', 0)
    assert.match(openLine, /^lifecycle: open done \((chat|workspace)\)$/)
    note(`4: Open answered ok (${openLine})`)

    // ---------------------------------------------------------------------------------------
    // 5. Stop and Resume. The starting message gave the chat a turn (its agent, not signed in,
    //    fails it), and Orca accepts a Stop for it: the bridge sends Orca's own Stop and the chat
    //    holds replies. A repeated Stop is accepted as well. The person's reply after the Stop
    //    resumes it: the Inbox calls Resume, and the reply reaches the chat, once.
    const stopped = await inbox(`/api/inbox/launch/${launchId}/stop`, { serverSession })
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    const stopRun = stopped.body.run as Json
    assert.equal(stopRun.state, 'stopped')
    assert.equal(stopRun.stopped_by_person, true)
    assert.equal(stopRun.open_in, 'orca')
    assert.equal(await lifecycleLine('stop', 0), 'lifecycle: stop done', 'Orca stopped the chat')
    const held = await ownedNow()
    assert.equal(held.stopped, true, JSON.stringify(held))
    assert.equal(held.state, 'stopped')

    const stoppedAgain = await inbox(`/api/inbox/launch/${launchId}/stop`, { serverSession })
    assert.equal(stoppedAgain.status, 200, JSON.stringify(stoppedAgain.body))
    assert.equal((stoppedAgain.body.run as Json).state, 'stopped')
    assert.equal(await lifecycleLine('stop', 1), 'lifecycle: stop done', 'a repeated Stop is accepted')
    assert.equal((await mailOf(session)).length, 1, 'a Stop sends the chat nothing')

    const resumeWords = `Reply after the Stop ${Date.now()}.`
    const resumed = await inbox(`/api/inbox/messages/${threadId}/reply`, { serverSession, idempotency_key: `inapp-build-resume-${session}`, words: resumeWords })
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
    assert.deepEqual((resumed.body.reply as Json).to, { host: 'orca', session })
    assert.equal(await lifecycleLine('resume', 0), 'lifecycle: resume done', 'the Inbox asked the bridge to resume the chat')
    let resumedMail: Mail[] = []
    await until(async () => { resumedMail = await mailOf(session); return resumedMail.length >= 2 && resumedMail.every((mail) => Boolean(mail.delivered_at)) }, 'the reply after the Stop in the chat’s mailbox', 120_000)
    assert.equal(resumedMail.length, 2)
    assert.equal(resumedMail.filter((mail) => mail.body!.includes(resumeWords)).length, 1)
    const going = await ownedNow()
    assert.equal(going.stopped, false, JSON.stringify(going))
    note(`5: Stop done twice, nothing sent; the reply after it resumed the chat and was delivered once (now ${JSON.stringify(going.state)})`)

    // ---------------------------------------------------------------------------------------
    // 6. The icon.
    const faces = await found(
      async () => {
        const answer = (await inbox('/api/inbox/agent-faces')).body as { faces?: Record<string, { face: string }> }
        return answer.faces?.[launchId]?.face === 'mark:claude-code' ? answer : null
      },
      'the started chat’s agent icon',
      150_000
    ).catch(async (error) => {
      note(`faces: ${JSON.stringify((await inbox('/api/inbox/agent-faces')).body).slice(0, 1500)}`)
      throw error
    })
    // The Inbox lists a launched agent by its launch id: the face is filed there, not under the session.
    assert.equal(faces.faces?.[session], undefined)
    assert.equal(row.id, launchId)
    const last = await found(listed, 'the started agent in the Inbox’s agent list', 30_000)
    assert.equal(last.host, 'orca')
    assert.equal(last.session, session)
    note(`6: the started chat shows mark:claude-code under ${launchId}`)
    process.stderr.write(`in-app-build passed: Orca ${orcaVersion}, Orca build of Plannotator ${version}\n`)
  } catch (error) {
    const logs = await run(CLI, ['plugin', 'logs', 'local.plannotator-inbox', '--json'])
    process.stderr.write(`second Orca said:\n${serveLog.slice(-3000)}\nthe plugin logged:\n${logs.stdout.slice(-6000)}\nlauncher stderr:\n${agentErr.slice(-3000)}\n`)
    const logDir = join(dataDir, 'inbox')
    for (const name of existsSync(logDir) ? await readdir(logDir) : []) {
      if (name.endsWith('.log')) process.stderr.write(`--- ${name}\n${(await readFile(join(logDir, name), 'utf8')).slice(-4000)}\n`)
    }
    throw error
  } finally {
    agent?.stdin?.end()
    await run(BUILD, ['inbox', 'stop'], { env: plannotatorEnv })
    const gone = new Promise<void>((resolve) => serve.once('exit', () => resolve()))
    serve.kill('SIGINT')
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 20_000))])
    if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL')
    await releases.close()
  }
})
