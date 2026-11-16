// End to end against a real, unmodified Plannotator: the launcher, exactly as an agent's settings
// run it, in front of the real `plannotator inbox mcp`, the real Inbox on loopback, and the plugin's engine. Only Orca is a
// stand-in (its CLI contract is covered by courier.test.ts): the engine's, and the CLI the launcher
// asks to prove the chat (`status`, `worktree ps`, `repo list`), as a small script. This is the test that says whether
// a Plannotator update broke the plugin, so CI runs it against the newest release.
//
// Runs only when PLANNOTATOR_E2E_BIN names a `plannotator` binary. It uses a throwaway HOME, so
// the Inbox it starts never sees, or writes to, the real one or any agent's settings.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Engine } from '../src/engine'
import { installShared } from '../src/shared'
import { fakeOrca, mcpClient, memoryStore, tempDir, until } from './fakes'

const BINARY = (process.env.PLANNOTATOR_E2E_BIN ?? '').trim()
const SESSION = 'claude_e2e0000_1111'
const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))

/** Orca's CLI as the launcher sees it: this chat is live and works in `project`. */
async function orcaStandIn(root: string, project: string): Promise<string> {
  const ok = (result: unknown) => JSON.stringify({ ok: true, result })
  const answers = {
    status: ok({ runtime: { reachable: true }, caller: { orcaSessionId: SESSION, live: true } }),
    worktrees: ok({ worktrees: [{ path: project, repoId: 'repo-1', hostId: null, agents: [{ paneKey: `structured-agent-session-${SESSION}:00000000-0000-4000-8000-000000000001` }] }], truncated: false }),
    repos: ok({ repos: [{ id: 'repo-1', path: project, connectionId: null }] })
  }
  const script = join(root, 'orca-cli.mjs')
  await writeFile(
    script,
    [
      `const answers = ${JSON.stringify(answers)}`,
      'const [a, b] = process.argv.slice(2)',
      "const answer = a === 'status' ? answers.status : a === 'worktree' && b === 'ps' ? answers.worktrees : a === 'repo' && b === 'list' ? answers.repos : null",
      "process.stdout.write(answer ?? '{\"ok\":false}')",
      'process.exitCode = answer ? 0 : 1',
      ''
    ].join('\n')
  )
  const windows = process.platform === 'win32'
  const bin = join(root, windows ? 'orca.cmd' : 'orca')
  await writeFile(
    bin,
    windows
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${script}' "$@"\n`
  )
  await chmod(bin, 0o755)
  return bin
}

test('a real Plannotator Inbox: an Orca chat sends, the person replies, the reply reaches the chat', { skip: BINARY ? false : 'set PLANNOTATOR_E2E_BIN to run' }, async () => {
  const root = await realpath(await tempDir('orca-plannotator-e2e-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const project = join(root, 'project')
  const dataDir = join(home, '.plannotator')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  // Windows programs need a few of the system's own variables to start; the home stays the throwaway one.
  const system =
    process.platform === 'win32'
      ? {
          ...Object.fromEntries(['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'].map((key) => [key, process.env[key]])),
          USERPROFILE: home,
          APPDATA: join(home, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(home, 'AppData', 'Local')
        }
      : {}
  const base = {
    ...system,
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_AUTO_UPDATE: '0',
    PLANNOTATOR_BROWSER: 'none'
  }

  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const engine = new Engine({
    settings: async () => ({ enabled: true, dataDir, orcaCliPath: '' }),
    store: memoryStore(),
    env: { PATH: process.env.PATH },
    home,
    sharedDir: shared,
    log: () => undefined,
    onStatus: () => undefined,
    exec: orca.exec,
    locateCli: () => ['orca'],
    tickMs: 250,
  })
  const launcher = await installShared(shared, WRAPPER)
  const orcaCli = await orcaStandIn(root, project)
  engine.start()

  // A `.cmd` starts only through Windows' command interpreter, which is also how an agent's host runs it.
  const viaShell = process.platform === 'win32'
  const child = spawn(viaShell ? (process.env.ComSpec ?? 'cmd.exe') : launcher, viaShell ? ['/d', '/s', '/c', `""${launcher}""`] : [], {
    cwd: project,
    windowsVerbatimArguments: viaShell,
    env: { ...base, PLANNOTATOR_BIN: BINARY, ORCA_PLANNOTATOR_HOME: shared, PLANNOTATOR_CWD: project, ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1', ORCA_CLI_COMMAND: orcaCli }
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const mcp = mcpClient(child)
  try {
    // Before the Inbox has ever run here, the plugin already says it will deliver.
    await until(async () => existsSync(join(shared, 'state.json')) && JSON.parse(await readFile(join(shared, 'state.json'), 'utf8')).delivering === true, 'the worker heartbeat')
    assert.equal(engine.status().phase, 'no-plannotator')

    const hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orca-plannotator-e2e', version: '0' } })
    assert.match(String(hello.instructions), /Plannotator Inbox/, 'Plannotator’s own instructions')
    assert.match(String(hello.instructions), /In this Orca chat you are already connected/)
    mcp.notify('notifications/initialized')

    const listed = (await mcp.request('tools/list')) as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }
    const send = listed.tools.find((tool) => tool.name === 'send_message')
    assert.ok(send, 'Plannotator still has send_message')
    for (const field of ['agent_host', 'agent_session', 'agent_name', 'body']) assert.ok(field in send.inputSchema.properties, `send_message takes ${field}`)

    // The agent follows Plannotator's guide and names its own host; the chat is the author anyway.
    const sent = await mcp.request('tools/call', { name: 'send_message', arguments: { subject: 'Ship the importer?', body: 'Shall I ship the importer today?', agent_host: 'claude-code', agent_name: 'Claude' } })
    const text = JSON.stringify(sent)
    assert.notEqual(sent.isError, true, text)
    const messageId = /msg_[A-Za-z0-9_]+/.exec(text)?.[0]
    assert.ok(messageId, `a message id in ${text}`)
    assert.match(text, /by itself/i, 'Plannotator tells the agent the reply arrives by itself')

    // The message started the Inbox; the engine finds it and starts listening for this chat.
    await until(() => engine.status().sessions.some((chat) => chat.session === SESSION), 'the chat to be listened for', 30_000)
    const registry = JSON.parse(await readFile(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string }
    const origin = `http://127.0.0.1:${registry.port}`
    const threads = JSON.stringify(await (await fetch(`${origin}/api/inbox/threads`)).json())
    assert.ok(threads.includes('"host":"orca"') && threads.includes(SESSION), 'the Inbox holds the message as written by the Orca chat')
    // Windows may spell the folder differently (case, separators); the launcher's own tests cover the value there.
    if (process.platform !== 'win32') assert.ok(threads.includes(JSON.stringify(project).slice(1, -1)), 'in the project Orca says the chat works in')

    // The person answers in the Inbox window.
    const health = (await (await fetch(`${origin}/api/inbox/health`)).json()) as { serverSession: string; version: string }
    const answered = await fetch(`${origin}/api/inbox/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: 'e2e-1', words: 'Yes, ship it today.' })
    })
    assert.equal(answered.status, 200, await answered.clone().text())
    const replyId = ((await answered.json()) as { reply: { id: string } }).reply.id

    // It arrives in the chat's Orca mailbox, once, in the shape Plannotator's guide teaches.
    await until(() => orca.state.mail.length === 1, 'the Orca mail', 30_000)
    const mail = orca.state.mail[0]!
    assert.equal(mail.to_handle, `orca_session_id:${SESSION}`)
    // A plain reply in an unnamed thread carries no title: Plannotator sends none and its own connections say "a reply".
    assert.ok(mail.body.startsWith(`Plannotator Inbox: a reply (${replyId})\n`), mail.body)
    assert.ok(mail.body.includes(`[Thread ${messageId}]`) || /\[Thread msg_[A-Za-z0-9_]+\]/.test(mail.body), mail.body)
    assert.match(mail.body, /Yes, ship it today\./)

    // And the Inbox is told, so it stops offering the reply.
    await until(() => engine.status().counts.delivered === 1, 'the acknowledgement', 30_000)
    const again = await fetch(`${origin}/api/inbox/bridge/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${registry.token}` },
      body: JSON.stringify({ host: 'orca', session: SESSION, waitMs: 0 })
    })
    assert.deepEqual(((await again.json()) as { commands: unknown[] }).commands, [])
    assert.equal(orca.sends().length, 1)
    process.stderr.write(`e2e passed against Plannotator ${health.version}\n`)
  } catch (error) {
    if (stderr) process.stderr.write(`wrapper stderr:\n${stderr}\n`)
    throw error
  } finally {
    child.stdin.end()
    await engine.stop()
    await new Promise<void>((resolve) => execFile(BINARY, ['inbox', 'stop'], { env: base as NodeJS.ProcessEnv, timeout: 20_000 }, () => resolve()))
  }
})
