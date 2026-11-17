// The launcher and the Orca build of Plannotator: which Plannotator it starts, and with what.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { currentBuild, orcaBuildFor, orcaConfig } from '../bin/inbox-mcp.mjs'
import { writePrivateJson } from '../bin/plannotator-update.mjs'
import { tempRoot } from './release-fakes.mjs'

const WRAPPER = fileURLToPath(new URL('../bin/inbox-mcp.mjs', import.meta.url))
const POSIX = process.platform !== 'win32'
const NAME = POSIX ? 'plannotator' : 'plannotator.exe'

// A stand-in `plannotator inbox mcp` that says which binary it is and what it was given.
const SERVER = `
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  const result = { who: process.env.STAND_IN, argv: process.argv.slice(2), orcaMode: process.env.PLANNOTATOR_ORCA_MODE ?? null, orcaConfig: process.env.PLANNOTATOR_ORCA_CONFIG ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
}
`

function standIn(path, who) {
  mkdirSync(join(path, '..'), { recursive: true })
  const script = `${path}.mjs`
  writeFileSync(script, SERVER)
  writeFileSync(path, `#!/bin/sh\nSTAND_IN='${who}' ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function box({ build = true, config = true, delivering = true } = {}) {
  const root = tempRoot('orca-plannotator-launch-')
  const shared = join(root, 'shared')
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  mkdirSync(shared, { recursive: true, mode: 0o700 })
  const stock = standIn(join(root, 'bin', 'plannotator'), 'stock')
  const binary = join(shared, 'plannotator', 'versions', '0.28.66-orca.1', NAME)
  const record = { v: 1, version: '0.28.66', build: 'orca.1', path: binary, sha256: 'd'.repeat(64), size: 0, installedAt: 1 }
  if (build) {
    standIn(binary, 'build')
    record.size = statSync(binary).size
    writePrivateJson(join(shared, 'plannotator', 'current.json'), record)
  }
  if (config) writePrivateJson(join(shared, 'bridge', 'config.json'), { canonicalDataDir: data })
  if (delivering) writeFileSync(join(shared, 'state.json'), JSON.stringify({ v: 1, pid: 1, at: Date.now(), dataDir: data, delivering: true }))
  const env = { PATH: join(root, 'bin'), HOME: root, PLANNOTATOR_DATA_DIR: data, ORCA_PLANNOTATOR_HOME: shared }
  return { root, shared, data, stock, binary, record, env }
}

function ask(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.split('\n')[0]).result) : reject(new Error(`exit ${code}: ${err}`))))
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
  })
}

const skip = POSIX ? false : 'the stand-in binaries are POSIX shell scripts'

test('the build is used only when the person chose no binary, Orca’s config is there and the plugin delivers', { skip }, () => {
  const b = box()
  assert.deepEqual(orcaBuildFor(b.env, b.shared, b.data), {
    binary: b.binary,
    version: '0.28.66',
    env: { PLANNOTATOR_ORCA_MODE: '1', PLANNOTATOR_ORCA_CONFIG: join(b.shared, 'bridge', 'config.json') }
  })
  assert.equal(orcaBuildFor({ ...b.env, PLANNOTATOR_BIN: b.stock }, b.shared, b.data), null, 'a PLANNOTATOR_BIN wins')
  assert.equal(orcaBuildFor(b.env, b.shared, join(b.root, 'other-inbox')), null, 'the plugin delivers for another Inbox')
  assert.equal(orcaBuildFor(b.env, box({ config: false }).shared, b.data), null)
  const quiet = box({ delivering: false })
  assert.equal(orcaBuildFor(quiet.env, quiet.shared, quiet.data), null)
  const none = box({ build: false })
  assert.equal(orcaBuildFor(none.env, none.shared, none.data), null)
  chmodSync(join(b.shared, 'bridge', 'config.json'), 0o644)
  assert.equal(orcaConfig(b.shared), null, 'a config others can read is not used (Plannotator refuses it too)')
})

test('a current.json is trusted only for a private record of a plain file in the store, with its size', { skip }, () => {
  const b = box()
  assert.deepEqual(currentBuild(b.shared), { version: '0.28.66', build: 'orca.1', path: b.binary })
  const write = (record) => writePrivateJson(join(b.shared, 'plannotator', 'current.json'), { ...b.record, ...record })
  write({ size: b.record.size + 1 })
  assert.equal(currentBuild(b.shared), null, 'size')
  write({ path: b.stock })
  assert.equal(currentBuild(b.shared), null, 'outside the store')
  write({ path: join(b.shared, 'plannotator', 'versions', '0.28.66-orca.1', '..', '..', '..', 'x', NAME) })
  assert.equal(currentBuild(b.shared), null, 'climbing out')
  write({ build: 'orca.1/../../x' })
  assert.equal(currentBuild(b.shared), null)
  write({})
  chmodSync(b.binary, 0o775)
  assert.equal(currentBuild(b.shared), null, 'writable by the group')
  chmodSync(b.binary, 0o755)
  chmodSync(join(b.shared, 'plannotator', 'current.json'), 0o644)
  assert.equal(currentBuild(b.shared), null, 'a record others can read')

  const linked = box()
  const elsewhere = standIn(join(linked.root, 'elsewhere', NAME), 'elsewhere')
  const folder = join(linked.shared, 'plannotator', 'versions', '0.28.66-orca.2')
  mkdirSync(folder)
  symlinkSync(elsewhere, join(folder, NAME))
  writePrivateJson(join(linked.shared, 'plannotator', 'current.json'), { ...linked.record, build: 'orca.2', path: join(folder, NAME), size: statSync(elsewhere).size })
  assert.equal(currentBuild(linked.shared), null, 'a link')
})

test('a real run starts the build in Orca mode, and otherwise exactly the Plannotator it started before', { skip }, async () => {
  const b = box()
  const built = await ask(b.env)
  assert.equal(built.who, 'build')
  assert.deepEqual(built.argv, ['inbox', 'mcp'])
  assert.equal(built.orcaMode, '1')
  assert.equal(built.orcaConfig, join(b.shared, 'bridge', 'config.json'))

  const chosen = await ask({ ...b.env, PLANNOTATOR_BIN: b.stock })
  assert.deepEqual([chosen.who, chosen.orcaMode, chosen.orcaConfig], ['stock', null, null], 'the person’s PLANNOTATOR_BIN')

  writeFileSync(join(b.shared, 'state.json'), JSON.stringify({ v: 1, pid: 1, at: Date.now(), dataDir: b.data, delivering: false }))
  const quiet = await ask(b.env)
  assert.deepEqual([quiet.who, quiet.orcaMode], ['stock', null], 'the plugin not delivering')

  const none = box({ build: false })
  assert.equal((await ask(none.env)).who, 'stock')

  // No stock Plannotator at all: the build alone is enough.
  const only = box()
  const { PATH: _path, ...rest } = only.env
  assert.equal((await ask({ ...rest, PATH: join(only.root, 'nowhere') })).who, 'build')
})
