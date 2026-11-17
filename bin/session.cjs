// Native chat operations the Inbox's Start, Stop and Resume need and Orca's public CLI does not
// offer. Started by the plugin's worker the way bin/reveal.cjs is: Orca's own executable in Node
// mode, so the runtime client, request schemas and fingerprint code it loads are that same Orca's:
//
//   <orca executable> session.cjs <app>/app.asar.unpacked/out   < {"action":"...", ...}
//
// A fixed list of operations, each checked against what Orca says it supports before anything is
// asked of it. No arbitrary request, no conversation read beyond one history page, no message:
//   support        agentSession.createSupport: can this agent open as a chat in this workspace?
//                  Also says whether this Orca's CLI takes --model and --effort.
//   session-proof  session.tabs.list: the chat's own tab, for a new chat that has no activity yet.
//   prepare-stop   agentSession.history (one page): the exact Stop request, without sending it.
//   stop           agentSession.cancel with exactly that prepared request, if nothing changed.
//   continue       agentSession.continueInterrupted for one interrupted turn.
// This is an internal Orca interface. Anything unexpected ends with
// {"ok":false,"error":...,"code":...} and exit code 1. `code` is "unsupported" when this Orca does
// not offer the operation (nothing was asked of it), "changed" when the chat moved on between
// preparing and sending a Stop (nothing was sent), "refused" when Orca answered a request with an
// error, and "failed" otherwise (for Stop and Continue: it is not known whether Orca acted).
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SESSION = /^[A-Za-z0-9_-]{1,160}$/
const OPERATION = /^\d{13}-[0-9a-f]{32}$/
const AGENTS = ['claude', 'codex', 'opencode', 'opencode2']
const MAX_ANSWER = 1024 * 1024
// Where Orca has kept these files; the first that exists wins.
const FILES = {
  client: [['cli', 'runtime', 'client.js'], ['cli', 'runtime-client.js']],
  params: [
    ['shared', 'rpc-contract', 'structured-agent-session', 'structured-agent-session-params.js'],
    ['shared', 'rpc-contract', 'structured-agent-session-params.js']
  ],
  continueParams: [
    ['shared', 'rpc-contract', 'structured-agent-session', 'structured-agent-session-continue-params.js'],
    ['shared', 'rpc-contract', 'structured-agent-session-continue-params.js']
  ],
  tabParams: [
    ['shared', 'rpc-contract', 'session-tabs', 'session-tabs-schemas-params.js'],
    ['shared', 'rpc-contract', 'session-tabs-schemas-params.js']
  ],
  projection: [['shared', 'agent-session', 'view', 'structured-agent-session-projection.js']],
  mutation: [
    ['shared', 'agent-session', 'lifecycle', 'operations', 'structured-agent-session-mutation.js'],
    ['shared', 'agent-session', 'lifecycle', 'structured-agent-session-mutation.js']
  ],
  launchSpec: [['cli', 'specs', 'agent-launch.js']]
}
const NEEDS = {
  support: ['agent-session.structured.v1', 'agent.launch.v2', 'agent.launch.replay-required.v1', 'agent.launch.local-presentation.v1', 'agent.launch.surface.v1'],
  'session-proof': ['agent-session.structured.v1'],
  'prepare-stop': ['agent-session.structured.v1', 'agent-session.conversation-stop.v1', 'agent-session.prompt-cancel.v1', 'agent-session.repeated-stop.v1'],
  stop: ['agent-session.structured.v1', 'agent-session.conversation-stop.v1', 'agent-session.prompt-cancel.v1', 'agent-session.repeated-stop.v1'],
  continue: ['agent-session.structured.v1', 'agent-session.continue-interrupted.v1']
}

class Unsupported extends Error {}
/** Checked before anything was asked of Orca, and it no longer matches: nothing was sent. */
class Changed extends Error {}
class Refused extends Error {}

function finish(answer, code) {
  process.stdout.write(JSON.stringify(answer), () => process.exit(code))
}

function load(out, name) {
  for (const parts of FILES[name]) {
    const file = path.join(out, ...parts)
    try {
      if (fs.statSync(file).isFile()) return require(file)
    } catch {}
  }
  throw new Unsupported(`Orca files not found (${name})`)
}

/** True when everything given survives a schema's parse unchanged (nothing dropped or rewritten). */
function retains(given, parsed) {
  if (given === null || typeof given !== 'object') return given === parsed
  if (Array.isArray(given)) return Array.isArray(parsed) && given.length === parsed.length && given.every((item, i) => retains(item, parsed[i]))
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(given).every((key) => Object.hasOwn(parsed, key) && retains(given[key], parsed[key]))
}

function checked(schema, params) {
  if (typeof schema?.safeParse !== 'function') throw new Unsupported('request schema not found')
  const parsed = schema.safeParse(params)
  if (!parsed.success || !retains(params, parsed.data)) throw new Unsupported('request schema changed')
  return parsed.data
}

function small(response) {
  if (Buffer.byteLength(JSON.stringify(response) ?? '') > MAX_ANSWER) throw new Error('Orca answered too much')
  return response
}

/** The Stop fingerprint must be computed exactly as this Orca checks it; a known vector proves it. */
function fingerprintOf(mutation) {
  const fingerprint = mutation.structuredAgentSessionPayloadFingerprint
  const vector = { method: 'agentSession.cancel', sessionId: 'test_session', fields: {} }
  const expected = crypto.createHash('sha256').update('{"fields":{},"method":"agentSession.cancel","sessionId":"test_session"}').digest('hex')
  if (typeof fingerprint !== 'function' || fingerprint(vector) !== expected) throw new Unsupported('Stop fingerprint changed')
  return (sessionId) => fingerprint({ method: 'agentSession.cancel', sessionId, fields: {} })
}

async function run(input, out) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(NEEDS, input.action)) throw new Error('unsupported operation')
  const { RuntimeClient } = load(out, 'client')
  if (typeof RuntimeClient !== 'function') throw new Unsupported('runtime client not found')
  // This user's local Orca only: no pairing code, no remote environment.
  const client = new RuntimeClient(undefined, 12_000, null, null)
  if (client.isRemote !== false) throw new Error('remote Orca refused')
  const status = small(await client.call('status.get', {}))
  if (!status || status.ok !== true || !Array.isArray(status.result?.capabilities)) throw new Error('Orca status unavailable')
  for (const capability of NEEDS[input.action]) {
    if (!status.result.capabilities.includes(capability)) throw new Unsupported(`Orca lacks ${capability}`)
  }
  const ask = async (method, params) => {
    let response
    try {
      response = small(await client.call(method, params))
    } catch (error) {
      // Orca answered with an error: it refused this request. Anything else (a lost connection,
      // a timeout) leaves it unknown whether Orca acted.
      const answered = error && typeof error === 'object' && error.response && error.response.ok === false
      if (!answered) throw error
      const code = typeof error.response.error?.code === 'string' ? error.response.error.code.slice(0, 80) : 'error'
      throw new Refused(`Orca refused ${method} (${code})`)
    }
    if (!response || response.ok !== true || response.result?.ok === false) throw new Refused(`Orca refused ${method}`)
    return response
  }

  if (input.action === 'support') {
    if (!AGENTS.includes(input.agent) || typeof input.worktree !== 'string' || !input.worktree || input.worktree.length > 4096) throw new Error('invalid launch target')
    const { CreateSupportParams } = load(out, 'params')
    const response = await ask('agentSession.createSupport', checked(CreateSupportParams, { agent: input.agent, worktree: input.worktree }))
    if (typeof response.result?.supported !== 'boolean') throw new Error('create-support answer changed')
    // Whether the CLI that ships with this Orca takes a model and an effort for `agent launch`.
    let flags = []
    try {
      const specs = load(out, 'launchSpec').AGENT_LAUNCH_COMMAND_SPECS
      const spec = Array.isArray(specs) ? specs.find((entry) => Array.isArray(entry?.path) && entry.path.join(' ') === 'agent launch') : null
      flags = Array.isArray(spec?.allowedFlags) ? spec.allowedFlags : []
    } catch {}
    return { supported: response.result.supported, model: flags.includes('model'), effort: flags.includes('effort') }
  }

  const sessionId = input.sessionId
  if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) throw new Error('invalid session id')

  if (input.action === 'session-proof') {
    // A new chat has no activity row yet. This reads the exact workspace's tabs; it reveals,
    // starts and sends nothing.
    if (!AGENTS.includes(input.agent) || typeof input.worktree !== 'string' || !input.worktree || input.worktree.length > 4096) throw new Error('invalid proof target')
    if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 4096) throw new Error('invalid proof target')
    const { WorktreeTabSelector } = load(out, 'tabParams')
    const response = await ask('session.tabs.list', checked(WorktreeTabSelector, { worktree: input.worktree }))
    const result = response.result
    if (result?.worktree !== input.workspaceId || !Array.isArray(result.tabs) || result.tabs.length > 1000) throw new Error('the workspace answered for another workspace')
    const rows = result.tabs.filter((row) => row?.type === 'agent-session' && row.sessionId === sessionId)
    if (rows.length !== 1 || rows[0].agent !== input.agent) throw new Error('the chat tab is absent, listed twice, or another agent')
    const projection = load(out, 'projection')
    const tabId = projection.structuredAgentSessionTabId?.(sessionId)
    const pane = projection.structuredAgentSessionPaneKey?.(tabId, sessionId)
    if (tabId !== `structured-agent-session-${sessionId}` || typeof pane !== 'string' || !new RegExp(`^${tabId}:[0-9a-fA-F-]{36}$`).test(pane)) {
      throw new Unsupported('chat pane naming changed')
    }
    return { sessionId, agent: input.agent, workspaceId: input.workspaceId, tabId, pane }
  }

  if (input.action === 'continue') {
    if (typeof input.turnItemId !== 'string' || input.turnItemId.length < 1 || input.turnItemId.length > 1024) throw new Error('invalid interrupted turn')
    const { ContinueInterruptedParams } = load(out, 'continueParams')
    // Orca rechecks that exact interrupted turn itself; it cannot continue another one.
    const params = checked(ContinueInterruptedParams, { sessionId, turnItemId: input.turnItemId })
    return (await ask('agentSession.continueInterrupted', params)).result ?? {}
  }

  // prepare-stop and stop: the conversation's current fence, from one history page.
  const params = load(out, 'params')
  const fingerprint = fingerprintOf(load(out, 'mutation'))
  if (typeof params.CancelParams?.safeParse !== 'function') throw new Unsupported('request schema not found')
  const history = await ask('agentSession.history', checked(params.HistoryParams, { sessionId, direction: 'tail', limit: 1 }))
  const page = history.result?.page
  if (page?.sessionId !== sessionId || !page.epoch || !Number.isSafeInteger(page.fence) || page.fence < 1) throw new Error('the chat’s history did not say where it is')
  const signature = { epoch: page.epoch, fence: page.fence, liveCursor: page.liveCursor ?? null }
  if (input.action === 'prepare-stop') {
    if (typeof input.operationId !== 'string' || !OPERATION.test(input.operationId)) throw new Error('invalid stop operation')
    const request = { envelope: { sessionId, clientOperationId: input.operationId, expectedRuntimeFence: page.fence, payloadFingerprint: fingerprint(sessionId) } }
    checked(params.CancelParams, request)
    return { signature, params: request }
  }
  const prepared = input.prepared
  if (!prepared || JSON.stringify(prepared.signature) !== JSON.stringify(signature)) throw new Changed('the chat changed before Stop; nothing was sent')
  const envelope = prepared.params?.envelope
  if (
    Object.keys(prepared.params ?? {}).some((key) => key !== 'envelope') ||
    envelope?.sessionId !== sessionId ||
    !OPERATION.test(envelope.clientOperationId ?? '') ||
    envelope.expectedRuntimeFence !== page.fence ||
    envelope.payloadFingerprint !== fingerprint(sessionId)
  ) {
    throw new Changed('the Stop request changed; nothing was sent')
  }
  return (await ask('agentSession.cancel', checked(params.CancelParams, prepared.params))).result ?? {}
}

module.exports = { run, retains }

if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (Buffer.byteLength(input) > 16384) finish({ ok: false, error: 'request too large', code: 'failed' }, 2)
  })
  process.stdin.on('end', async () => {
    try {
      const out = process.argv[2]
      if (typeof out !== 'string' || !path.isAbsolute(out)) throw new Unsupported('no Orca app folder')
      const result = await run(JSON.parse(input), out)
      finish({ ok: true, result }, 0)
    } catch (error) {
      const message = error && typeof error.message === 'string' ? error.message : 'unknown error'
      const code = error instanceof Unsupported ? 'unsupported' : error instanceof Changed ? 'changed' : error instanceof Refused ? 'refused' : 'failed'
      finish({ ok: false, error: message.slice(0, 300), code }, 1)
    }
  })
}
