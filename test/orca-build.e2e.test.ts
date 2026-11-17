// End to end with the real Orca build of Plannotator: the worker as Orca runs it (bridge, build
// store, engine), the real updater, the real launcher and the real Inbox. Two things are stand-ins:
// Orca's CLI, and GitHub's release host (a server on 127.0.0.1 that serves the binary you name).
//
// What it proves, in order: the worker downloads, checks and installs the build; an agent's launcher
// then starts Plannotator in Orca mode; a person's reply reaches the chat; the chat shows its agent's
// icon; the panel's Connect and Disconnect move Cursor and Antigravity onto the launcher and back,
// through the build's agent route; and an update that cannot work is shown with its reason, in the
// Inbox and in the panel, while the build in use keeps running.
//
// Runs only when ORCA_BUILD_E2E_BIN names an Orca build for this computer (`plannotator/build.mjs`
// makes one). It uses a throwaway HOME and data folder, and a PATH with no agent on it, so the
// Inbox's connector finds only the agents this test makes in that HOME. The Connect step stops
// before it changes anything unless the running Inbox has that HOME.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mockHost, mountWorker } from 'orca/testing'
import { deactivate, start, type Runtime } from '../src/worker'
import { launcherPath } from '../src/shared'
import { fakeOrca, mcpClient, tempDir, until } from './fakes'
// @ts-expect-error a plain module without types, shared with the updater's own tests
import { releaseServer } from './release-fakes.mjs'

const BINARY = (process.env.ORCA_BUILD_E2E_BIN ?? '').trim()
const SESSION = 'claude_b0b0b0b0_2222'
const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))

/** `until`, returning what was waited for. */
async function found<T>(look: () => Promise<T | null | undefined>, what: string, timeoutMs: number): Promise<T> {
  let value: T | null | undefined
  await until(async () => (value = await look()) != null, what, timeoutMs)
  return value as T
}

function versionOf(binary: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(binary, ['--version'], { timeout: 30_000 }, (error, stdout) => {
      const version = /\d+\.\d+\.\d+/.exec(String(stdout))?.[0]
      if (error || !version) reject(new Error(`the Orca build did not say its version: ${error?.message ?? stdout}`))
      else resolve(version)
    })
  )
}

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
  const bin = join(root, 'orca')
  await writeFile(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${script}' "$@"\n`)
  await chmod(bin, 0o755)
  return bin
}

/** The HOME a running process of this user was started with, from `ps` (only that one variable is read). */
function homeOf(pid: number): Promise<string | null> {
  return new Promise((resolve) =>
    execFile('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : (/(?:^|\s)HOME=(\S+)/.exec(String(stdout))?.[1] ?? null))
    )
  )
}

const skip = !BINARY ? 'set ORCA_BUILD_E2E_BIN to run' : process.platform === 'win32' ? 'not run on Windows yet' : false

test('the real Orca build: installed, run in Orca mode, replies delivered, agent icon set, a failed update shown', { skip, timeout: 600_000 }, async () => {
  const version = await versionOf(BINARY)
  const bytes = readFileSync(BINARY)
  const releases = await releaseServer([{ version, build: 'orca.1', bytes }])
  const root = await realpath(await tempDir('orca-plannotator-build-e2e-'))
  const home = join(root, 'home')
  const shared = join(root, 'shared')
  const project = join(root, 'project')
  const dataDir = join(home, '.plannotator')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  const base = {
    HOME: home,
    // No agent CLI is on this PATH: the connector run by Connect may only find what this test made.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    // Gemini CLI would otherwise count the ~/.gemini made for Antigravity as its own folder.
    GEMINI_CLI_HOME: join(root, 'no-gemini-cli'),
    TMPDIR: process.env.TMPDIR,
    ORCA_PLANNOTATOR_HOME: shared,
    ORCA_PLANNOTATOR_RELEASES: releases.base,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_AUTO_UPDATE: '0',
    PLANNOTATOR_BROWSER: 'none'
  }

  const orca = fakeOrca({ sessions: [SESSION], deliverAtOnce: true })
  const runtime: Partial<Runtime> = {
    env: base,
    home,
    sharedDir: shared,
    wrapperSource: WRAPPER,
    preview: false,
    engine: { exec: orca.exec, locateCli: () => ['orca'], tickMs: 250 },
    connect: { find: () => null }
  }
  const host = mockHost({ capabilities: ['storage:own', 'settings:own', 'notifications:show'], settings: { enabled: true, notifyBlocked: false, links: false, dataDir, orcaCliPath: '' } })
  const worker = await mountWorker(
    { default: (api) => start(api, runtime), deactivate },
    { host, commands: ['inbox.open', 'inbox.status', 'agents.connect', 'agents.disconnect', 'inbox.restartOnBuild', 'build.check'] }
  )
  const status = () => worker.request('status.get', { fresh: true })
  let child: ReturnType<typeof spawn> | null = null
  let stderr = ''
  try {
    // 1. The worker installs the build by itself: downloaded, size and checksum checked, run once.
    await until(async () => (await status()).build?.mode === 'orca-build', 'the Orca build to be installed', 180_000)
    const installed = (await status()).build!
    assert.equal(installed.version, version)
    assert.equal(installed.build, 'orca.1')
    assert.equal(installed.lastError, null)
    assert.equal(releases.downloads(), 1)

    // 2. An agent's launcher, with no PLANNOTATOR_BIN: it runs the Orca build, in Orca mode.
    const orcaCli = await orcaStandIn(root, project)
    child = spawn(launcherPath(shared), [], {
      cwd: project,
      env: { ...base, PLANNOTATOR_CWD: project, ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1', ORCA_CLI_COMMAND: orcaCli } as NodeJS.ProcessEnv
    })
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const mcp = mcpClient(child as Parameters<typeof mcpClient>[0])
    const hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orca-build-e2e', version: '0' } })
    assert.match(String(hello.instructions), /In this Orca chat you are already connected/)
    mcp.notify('notifications/initialized')
    const sent = await mcp.request('tools/call', { name: 'send_message', arguments: { subject: 'Ship the importer?', body: 'Shall I ship the importer today?', agent_host: 'claude-code', agent_name: 'Claude' } })
    const text = JSON.stringify(sent)
    assert.notEqual(sent.isError, true, text)
    const messageId = /msg_[A-Za-z0-9_]+/.exec(text)?.[0]
    assert.ok(messageId, `a message id in ${text}`)

    await until(async () => (await status()).sessions.some((chat) => chat.session === SESSION), 'the chat to be listened for', 60_000)
    const registry = JSON.parse(await readFile(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string; pid: number }
    const origin = `http://127.0.0.1:${registry.port}`
    const same = { 'content-type': 'application/json', origin }
    const card = (await (await fetch(`${origin}/api/inbox/orca`, { headers: same })).json()) as { mode?: string; features?: string[] }
    assert.equal(card.mode, 'orca', JSON.stringify(card))
    assert.ok(card.features?.includes('mark-faces'), JSON.stringify(card))
    assert.equal((await status()).server, 'orca', 'the panel knows the Inbox runs the Orca build')

    // 3. The person answers; the reply reaches the chat once and the Inbox is told.
    const health = (await (await fetch(`${origin}/api/inbox/health`)).json()) as { serverSession: string; version: string }
    assert.equal(health.version, version)
    const answered = await fetch(`${origin}/api/inbox/messages/${messageId}/reply`, {
      method: 'POST',
      headers: same,
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: 'build-e2e-1', words: 'Yes, ship it today.' })
    })
    assert.equal(answered.status, 200, await answered.clone().text())
    await until(() => orca.state.mail.length === 1, 'the Orca mail', 60_000)
    assert.match(orca.state.mail[0]!.body, /Yes, ship it today\./)
    await until(async () => (await status()).counts.delivered === 1, 'the acknowledgement', 60_000)

    // 4. The chat is drawn as the agent it runs.
    const faces = await found(
      async () => {
        const answer = (await (await fetch(`${origin}/api/inbox/agent-faces`, { headers: same })).json()) as { faces?: Record<string, { face: string }> }
        return answer.faces?.[SESSION]?.face === 'mark:claude-code' ? answer : null
      },
      'the chat’s agent icon',
      90_000
    )
    assert.ok(faces)

    // 5. Connect and Disconnect, through the panel's own requests, on the real files in the throwaway HOME.
    //    First: nothing here may reach the real home folder.
    const realHome = await realpath(homedir())
    const scratch = await realpath(tmpdir())
    assert.ok(home.startsWith(`${scratch}/`) && home !== realHome && !home.startsWith(`${realHome}/`), `the test HOME ${home} is a throwaway one`)
    assert.equal(await homeOf(registry.pid), home, 'the running Inbox must have the throwaway HOME; stopping before anything is connected')
    const launcher = launcherPath(shared)
    const cursorFile = join(home, '.cursor', 'mcp.json')
    const antigravityFile = join(home, '.gemini', 'config', 'mcp_config.json')
    await mkdir(join(home, '.cursor'))
    // `antigravity` is the App's data folder (INBOX_ANTIGRAVITY_DATA_DIRS): it makes Antigravity found.
    await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true })
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    const ownPlannotator = join(root, 'elsewhere', 'plannotator')
    await mkdir(join(root, 'elsewhere'))
    await writeFile(ownPlannotator, '#!/bin/sh\nexit 1\n')
    await chmod(ownPlannotator, 0o755)
    const original = {
      mcpServers: {
        paper: { command: '/bin/echo', args: ['paper'] },
        'plannotator-inbox': { command: ownPlannotator, args: ['inbox', 'mcp'] }
      }
    }
    await writeFile(antigravityFile, `${JSON.stringify(original, null, 2)}\n`)
    const stateOf = async (): Promise<Record<string, string>> =>
      Object.fromEntries((await status()).agents.map((agent) => [agent.agent, agent.state]))
    /** The file's `plannotator-inbox` entry; undefined when there is none (or no file: Disconnect removes one Connect created). */
    const entryOf = async (file: string): Promise<{ command?: string; args?: string[] } | undefined> => {
      const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
      return text === null ? undefined : (JSON.parse(text) as { mcpServers?: Record<string, { command?: string; args?: string[] }> }).mcpServers?.['plannotator-inbox']
    }
    // The entry written only in the throwaway HOME is what the Inbox reads: the same HOME again.
    const atFirst = await stateOf()
    assert.equal(atFirst.antigravity, 'plannotator', JSON.stringify(atFirst))
    assert.equal(atFirst.cursor, 'absent', JSON.stringify(atFirst))

    const connected = await worker.request('agents.connect', {})
    assert.equal(connected.ok, true, connected.message)
    assert.match(connected.message, /Cursor/)
    if (!card.features?.includes('agents')) {
      // An Orca build from before the agents route: its own connect writes the launcher for an agent
      // with no entry, and leaves an entry that runs Plannotator directly until the build has updated.
      assert.equal((await entryOf(cursorFile))?.command, launcher)
      assert.deepEqual(JSON.parse(await readFile(antigravityFile, 'utf8')), original, 'an older build leaves the entry alone')
      assert.match(connected.message, /older than this plugin/)
      process.stderr.write(`connect (Orca build without the agents route): ${connected.message}\n`)
    } else {
    assert.match(connected.message, /Antigravity/)
    const cursorEntry = await entryOf(cursorFile)
    assert.equal(cursorEntry?.command, launcher, JSON.stringify(cursorEntry))
    assert.deepEqual(cursorEntry?.args ?? [], [])
    const antigravityEntry = await entryOf(antigravityFile)
    assert.equal(antigravityEntry?.command, launcher, JSON.stringify(antigravityEntry))
    assert.deepEqual((JSON.parse(await readFile(antigravityFile, 'utf8')) as typeof original).mcpServers.paper, original.mcpServers.paper)
    const on = await stateOf()
    assert.deepEqual([on.cursor, on.antigravity], ['connected', 'connected'], JSON.stringify(on))

    const disconnected = await worker.request('agents.disconnect', {})
    assert.equal(disconnected.ok, true, disconnected.message)
    assert.deepEqual(JSON.parse(await readFile(antigravityFile, 'utf8')), original, 'Antigravity’s own entry is back')
    assert.equal(await entryOf(cursorFile), undefined, 'Cursor’s entry is gone')
    const off = await stateOf()
    assert.deepEqual([off.cursor, off.antigravity], ['absent', 'plannotator'], JSON.stringify(off))

    const again = await worker.request('agents.connect', {})
    assert.equal(again.ok, true, again.message)
    assert.equal((await entryOf(cursorFile))?.command, launcher)
    assert.equal((await entryOf(antigravityFile))?.command, launcher)
    const onAgain = await stateOf()
    assert.deepEqual([onAgain.cursor, onAgain.antigravity], ['connected', 'connected'], JSON.stringify(onAgain))
    process.stderr.write(`connect: ${connected.message}\ndisconnect: ${disconnected.message}\nconnect again: ${again.message}\n`)
    }

    // 6. A newer build that cannot work (it reports another version). The check fails with a reason,
    //    the Inbox shows that reason, and the build in use keeps running.
    releases.publish({ version: '99.0.0', build: 'orca.1', bytes })
    const checked = await worker.request('build.check')
    const afterCheck = await found(async () => {
      const now = (await status()).build
      return now && now.lastError && !now.updating ? now : null
    }, 'the failed update to be reported', 180_000)
    assert.match(afterCheck.lastError!, /99\.0\.0/, JSON.stringify([checked, afterCheck]))
    assert.equal(afterCheck.version, version, 'the build in use is unchanged')
    const shown = await found(
      async () => {
        const details = (await (await fetch(`${origin}/api/inbox/update`, { headers: same })).json()) as { update?: { state?: string } | null; failure?: { detail?: string } }
        return details.update?.state === 'failed' && typeof details.failure?.detail === 'string' ? details : null
      },
      'the Inbox to show the failed update',
      30_000
    )
    assert.match(shown.failure!.detail!, /99\.0\.0/)

    // "Try again" in the Inbox runs the plugin's updater, which fails the same way, visibly.
    const before = releases.downloads()
    const retried = (await (await fetch(`${origin}/api/inbox/update`, { method: 'POST', headers: same, body: JSON.stringify({ serverSession: health.serverSession }) })).json()) as { ok?: boolean; version?: string }
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(retried.version, '99.0.0')
    await until(() => releases.downloads() > before, 'the Inbox’s Update button to run the updater', 120_000)
    await until(
      async () => {
        const details = (await (await fetch(`${origin}/api/inbox/update`, { headers: same })).json()) as { update?: { state?: string } | null }
        return details.update?.state === 'failed'
      },
      'the second failure to show',
      180_000
    )
    const still = (await (await fetch(`${origin}/api/inbox/health`)).json()) as { version: string; serverSession: string }
    assert.equal(still.version, version)
    assert.equal(still.serverSession, health.serverSession, 'the Inbox was not restarted for a build that cannot work')
    process.stderr.write(`orca-build e2e passed against the Orca build of Plannotator ${version}\n`)
  } catch (error) {
    if (stderr) process.stderr.write(`launcher stderr:\n${stderr}\n`)
    throw error
  } finally {
    child?.stdin?.end()
    await worker.deactivate().catch(() => undefined)
    await new Promise<void>((resolve) => execFile(BINARY, ['inbox', 'stop'], { env: base as NodeJS.ProcessEnv, timeout: 20_000 }, () => resolve()))
    await releases.close()
  }
})
