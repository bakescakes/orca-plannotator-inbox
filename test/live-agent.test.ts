// A real, signed-in agent in a real Orca chat, end to end: the agent sends through the launcher,
// the person answers in a real Plannotator Inbox, the plugin's engine delivers through the real
// Orca CLI, and the agent, woken by the reply, answers it in the same thread.
//
// This starts a new Claude chat in your own Orca and spends a few model turns, so it runs only
// when asked for:
//
//   ORCA_LIVE_CLI=<path to the orca CLI>
//   ORCA_LIVE_AGENT_WORKTREE=<a workspace folder open in that Orca>
//   PLANNOTATOR_E2E_BIN=<a plannotator binary>
//   ORCA_LIVE_AGENT_MODEL=<model id>               optional; a small model is enough
//
// It writes `.mcp.json` and `.claude/settings.local.json` into that folder for the length of the
// test (and refuses to start if either exists), so the new chat gets one extra, separately named
// Inbox server that points at a throwaway Inbox. Your own Inbox and agent settings are not used.
// The plugin does not need to be loaded in that Orca: the engine runs here.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Engine } from '../src/engine'
import { OrcaCli } from '../src/orca-cli'
import { installShared, launcherPath } from '../src/shared'
import { canonicalSession, isRecord } from '../src/util'
import { memoryStore, tempDir, until } from './fakes'

const CLI = (process.env.ORCA_LIVE_CLI ?? '').trim()
const WORKTREE = (process.env.ORCA_LIVE_AGENT_WORKTREE ?? '').trim()
const BINARY = (process.env.PLANNOTATOR_E2E_BIN ?? '').trim()
const MODEL = (process.env.ORCA_LIVE_AGENT_MODEL ?? 'claude-sonnet-5-5').trim()
const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))
const SERVER = 'plannotator-inbox-trial'
const TOOL = `mcp__${SERVER}__send_message`

async function holds(folder: string, words: string): Promise<boolean> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      if (await holds(path, words)) return true
    } else if (entry.isFile() && (await stat(path)).size < 64 * 1024 * 1024) {
      if ((await readFile(path)).includes(words)) return true
    }
  }
  return false
}

test('live agent: a signed-in Orca chat asks, is answered, is woken by the reply and answers it', { skip: CLI && WORKTREE && BINARY ? false : 'set ORCA_LIVE_CLI, ORCA_LIVE_AGENT_WORKTREE and PLANNOTATOR_E2E_BIN to run', timeout: 600_000 }, async () => {
  const mcpFile = join(WORKTREE, '.mcp.json')
  const settingsFile = join(WORKTREE, '.claude', 'settings.local.json')
  assert.ok(!existsSync(mcpFile) && !existsSync(settingsFile), 'the folder already has a .mcp.json or .claude/settings.local.json; this test will not replace them')

  const root = await realpath(await tempDir('orca-plannotator-agent-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const dataDir = join(home, '.plannotator')
  await mkdir(home, { recursive: true })
  await installShared(shared, WRAPPER)
  const plannotatorEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_AUTO_UPDATE: '0',
    PLANNOTATOR_BROWSER: 'none'
  }

  const cli = new OrcaCli({ command: [CLI] })
  const engine = new Engine({
    settings: async () => ({ enabled: true, dataDir, orcaCliPath: '' }),
    store: memoryStore(),
    env: process.env as Record<string, string | undefined>,
    home,
    sharedDir: shared,
    log: () => undefined,
    onStatus: () => undefined,
    locateCli: () => [CLI],
    tickMs: 1000,
  })
  try {
    await mkdir(join(WORKTREE, '.claude'), { recursive: true })
    await writeFile(mcpFile, `${JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', command: launcherPath(shared), args: [], env: { ...plannotatorEnv, PLANNOTATOR_BIN: BINARY, ORCA_PLANNOTATOR_HOME: shared } } } }, null, 2)}\n`)
    await writeFile(settingsFile, `${JSON.stringify({ enableAllProjectMcpServers: true, permissions: { allow: [TOOL] } }, null, 2)}\n`)
    engine.start()
    await until(async () => existsSync(join(shared, 'state.json')) && JSON.parse(await readFile(join(shared, 'state.json'), 'utf8')).delivering === true, 'the engine to say it delivers', 30_000)

    const prompt = [
      'This is an automated connection test. Do exactly the steps below and nothing else: no other tools, no skills, no file changes, no questions.',
      `Step 1: call the tool ${TOOL} once, with subject "Live agent trial" and body "Trial question: reply with any word." Leave agent_host and agent_session unset.`,
      'Step 2: end your turn.',
      `Step 3: when a message arrives that starts with "Plannotator Inbox:", call ${TOOL} once more, with reply_to set to the id in parentheses on that first line, and body "RECEIVED: " followed by the person's words. Then stop.`
    ].join('\n')
    const launched = await cli.call(['agent', 'launch', '--agent', 'claude', '--worktree', `path:${WORKTREE}`, '--surface', 'chat', '--model', MODEL, '--prompt', prompt], 120_000)
    const outcome = launched.outcome
    assert.ok(isRecord(outcome) && outcome.kind === 'structured' && typeof outcome.sessionId === 'string', JSON.stringify(launched).slice(0, 600))
    const session = canonicalSession(outcome.sessionId as string)!

    // The agent's first message starts the throwaway Inbox and makes the chat known.
    await until(() => engine.status().sessions.some((chat) => chat.session === session), 'the agent’s first Inbox message', 240_000)
    const registry = JSON.parse(await readFile(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string }
    const origin = `http://127.0.0.1:${registry.port}`
    const threads = JSON.stringify(await (await fetch(`${origin}/api/inbox/threads`)).json())
    assert.ok(threads.includes('"host":"orca"') && threads.includes(session), 'the Inbox holds the message as written by the Orca chat')
    const messageId = /msg_[A-Za-z0-9_]+/.exec(threads)?.[0]
    assert.ok(messageId, threads.slice(0, 600))

    // The person answers in the Inbox.
    const health = (await (await fetch(`${origin}/api/inbox/health`)).json()) as { serverSession: string; version: string }
    const answered = await fetch(`${origin}/api/inbox/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `agent-${session}`, words: 'Pineapple.' })
    })
    assert.equal(answered.status, 200, await answered.clone().text())

    // Delivered through Orca and acknowledged; then the agent, woken by it, answers in the thread.
    await until(() => engine.status().counts.delivered === 1, 'the delivery and its acknowledgement', 120_000)
    await until(() => holds(dataDir, 'RECEIVED: Pineapple'), 'the agent’s answer to the reply', 240_000)
    process.stderr.write(`live agent passed: Orca ${await cli.version()}, Plannotator ${health.version}, chat ${session}\n`)
  } finally {
    await engine.stop()
    await rm(mcpFile, { force: true })
    await rm(settingsFile, { force: true })
    await new Promise<void>((resolve) => execFile(BINARY, ['inbox', 'stop'], { env: plannotatorEnv as NodeJS.ProcessEnv, timeout: 20_000 }, () => resolve()))
  }
})
