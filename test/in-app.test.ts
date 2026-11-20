// The whole thing inside a real Orca: a second, windowless Orca with its own throwaway profile and
// home installs this plugin the way a user would, opens a real native chat, and the installed
// worker delivers a real Plannotator reply into it. Nothing here is a stand-in except the agent's
// side of the conversation, which this test plays through the launcher (the chat's own agent is
// not signed in inside a throwaway home, and does not need to be). The launcher only acts for a chat
// Orca itself vouches for, so it is run with the variables Orca really gave that chat's agent: the
// `claude` on the throwaway PATH notes them down before it runs the real one.
//
// With ORCA_INAPP_CLI_BEFORE and/or PLANNOTATOR_E2E_BIN_BEFORE it is also an update test: the
// older programs run first, then the newer ones take over the same profile and the same Inbox
// data, with nothing installed or connected again, and a second reply must still arrive.
//
// Runs only when ORCA_INAPP_CLI names the `orca` CLI inside the Orca.app to start, and
// PLANNOTATOR_E2E_BIN a `plannotator` binary, and `claude` is installed (Orca needs an agent
// program to open a chat). It never touches the default Orca profile, the real Inbox or any
// agent's settings. The ORCA_E2E_* variables are Orca's own test switches for a disposable profile.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRecord } from '../src/util'
import { mcpClient, tempDir, until } from './fakes'

const text = (name: string): string => (process.env[name] ?? '').trim()
const CLI = text('ORCA_INAPP_CLI')
const BINARY = text('PLANNOTATOR_E2E_BIN')
const CLI_BEFORE = text('ORCA_INAPP_CLI_BEFORE')
const BINARY_BEFORE = text('PLANNOTATOR_E2E_BIN_BEFORE')
const CLAUDE = text('PATH')
  .split(delimiter)
  .filter(Boolean)
  .map((folder) => join(folder, 'claude'))
  .find((candidate) => existsSync(candidate))
const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
/** What Orca gives a native chat's agent, and Connect passes on to the launcher. */
const CHAT_VARIABLES = ['ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_USER_DATA_PATH', 'ORCA_CLI_COMMAND', 'ORCA_TERMINAL_HANDLE']
const skip = !CLI || !BINARY ? 'set ORCA_INAPP_CLI and PLANNOTATOR_E2E_BIN to run' : !CLAUDE ? 'needs `claude` on PATH' : false

type Answer = { ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string; data?: Record<string, unknown> } }
type Mail = { from_handle?: string; body?: string; delivered_at?: string | null }

test('inside a real Orca: installed from a folder, a chat’s reply is delivered, and again after both programs update', { skip, timeout: 420_000 }, async () => {
  const root = await realpath(await tempDir('orca-plannotator-inapp-'))
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
  // The chat's agent, as Orca starts it: note the chat's Orca variables, then be the real program.
  const chatEnvDir = join(root, 'chat-env')
  await mkdir(chatEnvDir, { recursive: true })
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  await writeFile(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'if [ -n "${ORCA_AGENT_SESSION_ID:-}" ]; then',
      `  target=${quoted(chatEnvDir)}/"$ORCA_AGENT_SESSION_ID"`,
      `  for name in ${CHAT_VARIABLES.join(' ')}; do eval "value=\\\${$name-}"; printf '%s=%s\\n' "$name" "$value"; done > "$target.$$.tmp" && mv "$target.$$.tmp" "$target"`,
      'fi',
      // Its own empty settings folder: the chat's agent is signed out here on every computer, so this
      // test never talks to a model with someone's account, and runs the same everywhere.
      `CLAUDE_CONFIG_DIR=${quoted(join(root, 'claude-config'))} exec ${quoted(await realpath(CLAUDE!))} "$@"`,
      ''
    ].join('\n')
  )
  await chmod(join(bin, 'claude'), 0o755)
  // Orca asks a login shell for PATH and that shell's order wins: it lists the system folders first
  // (Homebrew's among them, where an installed `claude` may be), then what it inherited. So this
  // folder is put first the way a person would do it, in the shell's own profile.
  for (const name of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) await writeFile(join(home, name), `export PATH=${quoted(bin)}:"$PATH"\n`)
  // What a published repository holds: no node_modules, no generated typings.
  for (const name of ['orca-plugin.json', 'package.json', 'README.md', 'src', 'bin']) await cp(join(PLUGIN, name), join(copy, name), { recursive: true })

  const env = {
    PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: home,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    ORCA_E2E_USER_DATA_DIR: profile,
    ORCA_USER_DATA_PATH: profile,
    ORCA_E2E_HEADLESS: '1'
  } as NodeJS.ProcessEnv
  // This test is the plugin with the Plannotator a person installed, so "Use the Orca build of Plannotator" is
  // switched off the way Orca's Settings stores it. Left on, the worker downloads the published build and
  // restarts the Inbox on it halfway through (test/in-app-build.test.ts is the test of that).
  await mkdir(join(profile, 'plugins-data', 'local.plannotator-inbox'), { recursive: true })
  await writeFile(join(profile, 'plugins-data', 'local.plannotator-inbox', 'settings.json'), JSON.stringify({ orcaBuild: false }))
  const plannotatorEnv = { ...env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_AUTO_UPDATE: '0', PLANNOTATOR_BROWSER: 'none' }
  const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> =>
    new Promise((resolve) => execFile(file, args, { env: options.env ?? env, cwd: options.cwd ?? root, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout))))

  await run('git', ['init', '-q', '-b', 'trial', project])
  await run('git', ['-c', 'user.name=trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: project })

  /** One run of one Orca and one Plannotator on the shared profile: a chat asks, the person answers, the reply arrives. */
  const stage = async (cli: string, plannotator: string, first: boolean): Promise<string> => {
    const orca = async (...args: string[]): Promise<Answer> => {
      const out = await run(cli, [...args, '--json'])
      try {
        return JSON.parse(out) as Answer
      } catch {
        throw new Error(`orca ${args.join(' ')} answered: ${out.slice(0, 400)}`)
      }
    }
    const started = Date.now()
    const serve = spawn(cli, ['serve', '--no-pairing', '--bind', '127.0.0.1', '--json'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let serveLog = ''
    serve.stdout.on('data', (chunk: Buffer) => (serveLog += chunk.toString('utf8')))
    serve.stderr.on('data', (chunk: Buffer) => (serveLog += chunk.toString('utf8')))
    let agent: ReturnType<typeof spawn> | null = null
    let lastPoll = ''
    try {
      await until(() => serveLog.includes('orca_server_ready'), 'the second Orca to start', 90_000)
      const version = ((await orca('status')).result?.runtime as { appVersion?: string } | undefined)?.appVersion

      if (first) {
        // Installing asks for approval of exactly these files and this access; grant it, in this profile only.
        const asked = await orca('plugin', 'install', copy)
        assert.equal(asked.error?.code, 'approval_required', JSON.stringify(asked).slice(0, 400))
        const installed = await orca('plugin', 'install', copy, '--approve', String(asked.error?.data?.approvalFingerprint))
        assert.equal(installed.ok, true, JSON.stringify(installed).slice(0, 600))
        assert.equal((await orca('repo', 'add', '--path', project, '--kind', 'git')).ok, true)
        // The person's one setup step: from 0.29.1 the Inbox is off, with no tools for any chat, until a person
        // runs `plannotator inbox` once. It stays on across the update (its data folder says it ran).
        await run(plannotator, ['inbox', '--open'], { env: plannotatorEnv })
      }

      // The worker starts by itself with Orca, writes the launcher for this Orca and says it can deliver.
      const state = async (): Promise<{ at: number; delivering: boolean } | null> => (existsSync(join(shared, 'state.json')) ? JSON.parse(await readFile(join(shared, 'state.json'), 'utf8')) : null)
      await until(async () => { const now = await state(); return now !== null && now.at >= started && now.delivering === true }, 'the installed worker to say it delivers', 60_000)
      const plugins = (await orca('plugin', 'list')).result?.plugins as { pluginKey: string; status: string }[]
      assert.equal(plugins.find((plugin) => plugin.pluginKey.endsWith('plannotator-inbox'))?.status, 'running')
      const launcher = await readFile(join(shared, 'inbox-mcp'), 'utf8')
      const app = await realpath(cli.slice(0, cli.indexOf('.app/') + 4))
      assert.ok(launcher.includes(`${app}/`), `the launcher runs this Orca’s own program:\n${launcher}`)

      // A real native chat. Its agent is not signed in here; the chat exists all the same.
      const launched = await orca('agent', 'launch', '--agent', 'claude', '--worktree', `path:${project}`, '--surface', 'chat', '--prompt', 'Automated test: no action needed.')
      const outcome = launched.result?.outcome
      assert.ok(isRecord(outcome) && outcome.kind === 'structured' && typeof outcome.sessionId === 'string', JSON.stringify(launched).slice(0, 600))
      const session = outcome.sessionId as string

      // The agent's side: the launcher exactly as the chat's agent would run it.
      await until(() => existsSync(join(chatEnvDir, session)), 'Orca to start the chat’s agent', 60_000)
      const chatEnv: Record<string, string> = {}
      for (const line of (await readFile(join(chatEnvDir, session), 'utf8')).split('\n')) {
        const at = line.indexOf('=')
        if (at > 0 && line.slice(at + 1) !== '') chatEnv[line.slice(0, at)] = line.slice(at + 1)
      }
      assert.equal(chatEnv.ORCA_AGENT_SESSION_ID, session)
      assert.ok(chatEnv.ORCA_CLI_COMMAND, `Orca names its CLI to a chat: ${Object.keys(chatEnv).join(', ')}`)
      agent = spawn(join(shared, 'inbox-mcp'), [], { cwd: project, env: { ...plannotatorEnv, PLANNOTATOR_BIN: plannotator, ...chatEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
      const mcp = mcpClient(agent as never)
      const hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orca-plannotator-inapp', version: '0' } })
      assert.match(String(hello.instructions), /In this Orca chat you are already connected/)
      mcp.notify('notifications/initialized')
      await mcp.request('tools/list')
      const sent = JSON.stringify(await mcp.request('tools/call', { name: 'send_message', arguments: { subject: `In-app trial ${session}`, body: 'Trial question: reply with any word.', agent_host: 'claude-code', agent_name: 'Claude' } }))
      const messageId = /msg_[A-Za-z0-9_]+/.exec(sent)?.[0]
      assert.ok(messageId, sent)
      assert.match(sent, /by itself/i)

      // The person answers in the Inbox.
      const registry = JSON.parse(await readFile(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string }
      const origin = `http://127.0.0.1:${registry.port}`
      const health = (await (await fetch(`${origin}/api/inbox/health`)).json()) as { serverSession: string; version: string }
      const answered = await fetch(`${origin}/api/inbox/messages/${messageId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `inapp-${session}`, words: 'Pineapple.' })
      })
      assert.equal(answered.status, 200, await answered.clone().text())
      const replyId = ((await answered.json()) as { reply: { id: string } }).reply.id

      // The installed worker sends it through this Orca to that chat, once, and Orca hands it over.
      let mail: Mail[] = []
      lastPoll = ''
      await until(
        async () => {
          const box = await orca('orchestration', 'inbox', '--terminal', `orca_session_id:${session}`, '--full')
          mail = ((box.result?.messages as Mail[] | undefined) ?? []).filter((message) => message.from_handle === 'plannotator-inbox')
          return mail.length > 0 && Boolean(mail[0]?.delivered_at)
        },
        'the reply in the chat’s Orca mailbox',
        60_000
      )
      assert.equal(mail.length, 1)
      assert.ok(mail[0]!.body!.startsWith(`Plannotator Inbox: a reply (${replyId})\n`), mail[0]!.body)
      assert.match(mail[0]!.body!, /Pineapple\./)

      // And the Inbox is told, so it stops offering the reply.
      await until(
        async () => {
          const again = await fetch(`${origin}/api/inbox/bridge/poll`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${registry.token}` },
            body: JSON.stringify({ host: 'orca', session, waitMs: 0 })
          })
          // An answer without `commands` is an error; asked again until the time is up.
          lastPoll = `${again.status} ${(await again.clone().text()).slice(0, 600)}`
          const { commands } = (await again.json()) as { commands?: unknown[] }
          return Array.isArray(commands) && commands.length === 0
        },
        'the acknowledgement',
        30_000
      )

      // The message the chat sent ends with a signed link, and that link opens the chat in this Orca.
      const thread = await (await fetch(`${origin}/api/inbox/threads/${messageId}`)).text()
      const link = /\[Open in Orca\]\((http:\/\/127\.0\.0\.1:(\d+)\/open\/([A-Za-z0-9_.-]+))\)/.exec(thread)
      assert.ok(link, `the sent message carries an Open in Orca link: ${thread.slice(0, 600)}`)
      const [, address, port, token] = link
      const preview = await fetch(address!)
      assert.equal(preview.status, 200)
      assert.match(await preview.text(), /<form/, 'a fetch that is not a click only gets the button')
      const clicked = await fetch(`http://127.0.0.1:${port}/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${port}` },
        body: `token=${encodeURIComponent(token!)}`
      })
      const page = await clicked.text()
      assert.equal(clicked.status, 200, page)
      const how = /Opened the chat/.test(page) ? 'the chat tab' : 'the workspace'
      return `Orca ${version}, Plannotator ${health.version} (link opened ${how})`
    } catch (error) {
      const logs = await run(cli, ['plugin', 'logs', 'local.plannotator-inbox', '--json'])
      const seen = await readdir(chatEnvDir).catch(() => [] as string[])
      const agentSays = await run(join(bin, 'claude'), ['--version'])
      process.stderr.write(`the Inbox last answered the test’s poll: ${lastPoll || 'not asked'}\nsecond Orca said:\n${serveLog.slice(-12_000)}\nthe plugin logged:\n${logs.slice(0, 3000)}\nchats whose agent started: ${JSON.stringify(seen)}\nthe agent program (${await realpath(CLAUDE!)}) says: ${agentSays.trim() || 'nothing'}\n`)
      throw error
    } finally {
      agent?.stdin?.end()
      await run(plannotator, ['inbox', 'stop'], { env: plannotatorEnv })
      const gone = new Promise<void>((resolve) => serve.once('exit', () => resolve()))
      serve.kill('SIGINT')
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 20_000))])
      if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL')
      // Something Orca started (a catalog fetch, its crash reporter) can outlive it and hold these
      // pipes open, which would keep this test file running after it passed.
      serve.stdout?.destroy()
      serve.stderr?.destroy()
      agent?.stdout?.destroy()
      agent?.stderr?.destroy()
      // Stopping says so, so an agent is not told replies arrive while nothing delivers.
      const last = existsSync(join(shared, 'state.json')) ? JSON.parse(await readFile(join(shared, 'state.json'), 'utf8')) : null
      if (last && serve.signalCode !== 'SIGKILL') assert.equal(last.delivering, false, 'the worker says it stopped delivering')
    }
  }

  const updating = CLI_BEFORE !== '' || BINARY_BEFORE !== ''
  const passed: string[] = []
  if (updating) passed.push(await stage(CLI_BEFORE || CLI, BINARY_BEFORE || BINARY, true))
  passed.push(await stage(CLI, BINARY, !updating))
  process.stderr.write(`in-app passed: ${passed.join(' → then, same profile and Inbox data, ')}\n`)
})
