// Brings one exact native chat tab forward in the running Orca. Started by the plugin's worker
// with Orca's own executable in Node mode (ELECTRON_RUN_AS_NODE=1), so the code it loads is the
// runtime client and request schema of that same Orca:
//
//   <orca executable> reveal.cjs <app>/app.asar.unpacked/out   < {"sessionId":"..."}
//
// It makes exactly one request, `agentSession.reveal`, after checking that Orca says it supports
// it. No other request, no conversation read, no message. This is an internal Orca interface:
// anything unexpected ends with {"ok":false,"error":...} and exit code 1, and the worker falls
// back to opening the workspace through the public CLI.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const SESSION = /^[A-Za-z0-9_-]{1,160}$/
const CAPABILITIES = ['agent-session.structured.v1', 'agent-session.structured.reveal.v1']
// Where Orca has kept these files; the first that exists wins.
const CLIENTS = [['cli', 'runtime', 'client.js'], ['cli', 'runtime-client.js']]
const SCHEMAS = [
  ['shared', 'rpc-contract', 'structured-agent-session', 'structured-agent-session-params.js'],
  ['shared', 'rpc-contract', 'structured-agent-session-params.js']
]

function finish(answer, code) {
  process.stdout.write(JSON.stringify(answer), () => process.exit(code))
}

function first(out, candidates) {
  for (const parts of candidates) {
    const file = path.join(out, ...parts)
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {}
  }
  throw new Error('Orca files not found')
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (Buffer.byteLength(input) > 2048) finish({ ok: false, error: 'request too large' }, 2)
})
process.stdin.on('end', async () => {
  try {
    const out = process.argv[2]
    if (typeof out !== 'string' || !path.isAbsolute(out)) throw new Error('no Orca app folder')
    const request = JSON.parse(input)
    if (!request || typeof request.sessionId !== 'string' || !SESSION.test(request.sessionId)) throw new Error('invalid session id')
    const { RuntimeClient } = require(first(out, CLIENTS))
    const { RevealParams } = require(first(out, SCHEMAS))
    if (typeof RuntimeClient !== 'function' || typeof RevealParams?.safeParse !== 'function') throw new Error('reveal interface not found')
    const params = { sessionId: request.sessionId }
    const parsed = RevealParams.safeParse(params)
    if (!parsed.success || parsed.data.sessionId !== params.sessionId) throw new Error('reveal schema changed')
    // This user's local Orca only: no pairing code, no remote environment.
    const client = new RuntimeClient(undefined, 12_000, null, null)
    if (client.isRemote !== false) throw new Error('remote Orca refused')
    const status = await client.call('status.get', {})
    if (!status || status.ok !== true) throw new Error('Orca status unavailable')
    const capabilities = status.result && status.result.capabilities
    for (const capability of CAPABILITIES) {
      if (!Array.isArray(capabilities) || !capabilities.includes(capability)) throw new Error(`Orca lacks ${capability}`)
    }
    if (request.checkOnly === true) return finish({ ok: true, compatible: true }, 0)
    const response = await client.call('agentSession.reveal', params)
    const result = response && response.result
    if (!response || response.ok !== true || !result || result.ok === false) throw new Error('Orca refused to reveal the chat')
    if (result.sessionId !== params.sessionId || typeof result.workspaceId !== 'string') throw new Error('Orca revealed another chat')
    finish({ ok: true, result: { sessionId: result.sessionId, workspaceId: result.workspaceId } }, 0)
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : 'unknown error'
    finish({ ok: false, error: message.slice(0, 300) }, 1)
  }
})
