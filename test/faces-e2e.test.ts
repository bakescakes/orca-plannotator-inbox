// Bot pictures against a real Plannotator Inbox: `BotAvatars`, `FaceSync` and the real `InboxClient`
// give invented bots' chats their pictures through the Inbox's own routes, and the Inbox then lists
// each chat's face as `own:<sha256>` and serves those bytes back.
//
//   PLANNOTATOR_FACES_BIN=<a plannotator binary>
//
// With the Orca build (it reports `mark-faces`) every form of Orca picture is checked; with standard
// Plannotator, that nothing is sent and no bot is read. The Inbox runs in a throwaway HOME on a port
// of its own, with update checks off, and is stopped at the end. Mascots come from the installed
// Orca when one is found (read only), else from invented ones.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BotAvatars, orcaAssetFolders, type BotRef } from '../src/bot-avatars'
import { FaceSync, type FaceChat, type FacesAvatars } from '../src/faces'
import { InboxClient } from '../src/inbox'
import { encodePng } from '../src/png'
import { MAX_PICTURE_BYTES } from '../src/presentation'
import { memoryStore, tempDir, until } from './fakes'

const BINARY = (process.env.PLANNOTATOR_FACES_BIN ?? '').trim()
const MASCOT = /^([A-Z][0-9]{1,2})-[A-Za-z0-9_-]{8}\.svg$/

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A noisy square RGBA picture: barely compresses, as a photo does not. */
function photo(side: number): Uint8Array {
  const pixels = new Uint8Array(side * side * 4)
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256)
  return encodePng({ width: side, height: side, pixels })
}

/** The installed Orca's mascot folder and two of its ids, or invented ones in `root`. */
async function mascots(root: string): Promise<{ folder: string; ids: [string, string, string]; installed: boolean }> {
  const cli = (process.env.ORCA_LIVE_CLI ?? '').trim() || '/Applications/Orca.app/Contents/Resources/bin/orca'
  for (const folder of orcaAssetFolders([cli])) {
    if (!existsSync(folder)) continue
    const ids = readdirSync(folder).map((name) => MASCOT.exec(name)?.[1]).filter((id): id is string => !!id)
    if (ids.length >= 3) return { folder, ids: [ids[0]!, ids[1]!, ids[2]!], installed: true }
  }
  const folder = join(root, 'assets')
  await mkdir(folder, { recursive: true })
  for (const [id, fill] of [['Q7', '#123456'], ['W4', '#654321'], ['K8', '#abcdef']]) {
    await writeFile(join(folder, `${id}-aB3_dE9x.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" style="fill:var(--avatar-bg,#b3dbf4)"/><path d="M1 1h4v4z" fill="${fill}"/></svg>`)
  }
  return { folder, ids: ['Q7', 'W4', 'K8'], installed: false }
}

test('a real Inbox takes each bot picture, lists the chat’s face as own:<sha256> and serves the same bytes', { skip: BINARY ? false : 'set PLANNOTATOR_FACES_BIN to run', timeout: 180_000 }, async () => {
  const root = await realpath(await tempDir('orca-plannotator-faces-'))
  const home = join(root, 'home')
  const dataDir = join(home, '.plannotator')
  await mkdir(join(root, 'tmp'), { recursive: true })
  await mkdir(home, { recursive: true })
  // The Orca build is in Orca mode only with an owner-only config naming this Inbox, as the plugin
  // writes it; no updater is named. Standard Plannotator ignores both.
  const config = join(root, 'orca-config.json')
  await writeFile(config, JSON.stringify({ v: 1, canonicalDataDir: dataDir, dataDirs: [dataDir], stateDir: join(root, 'state'), mcpCommand: [BINARY], upgradeCommand: null, upgradeStateFile: null, upgradeBackoffMs: null }), { mode: 0o600 })
  const env = {
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    PATH: '/usr/bin:/bin',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_AUTO_UPDATE: '0',
    PLANNOTATOR_BROWSER: 'none',
    // Plannotator's own guard: it refuses to start with the real home, and writes no login item.
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_ORCA_MODE: '1',
    PLANNOTATOR_ORCA_CONFIG: config
  }
  // `--no-open` turns the Inbox on in this home (0.29.1 and later) and runs it here.
  const child = spawn(BINARY, ['inbox', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const inbox = new InboxClient(dataDir)
  try {
    await until(async () => (await inbox.health().catch(() => null))?.serverSession != null, `the Inbox to answer (${output})`, 60_000)
    const features = await inbox.orcaFeatures()
    const { folder, ids, installed } = await mascots(root)
    process.stderr.write(`faces e2e: Plannotator ${(await inbox.health()).version}, features [${features.join(', ')}], mascots ${installed ? 'from the installed Orca' : 'invented'} (${ids.slice(0, 2).join(', ')})\n`)

    const bots = join(root, 'bots')
    const bot = async (folderName: string, name: string, avatar: string | null, png?: Uint8Array): Promise<BotRef> => {
      const botHome = join(bots, folderName)
      await mkdir(botHome, { recursive: true })
      await writeFile(join(botHome, 'bot.json'), JSON.stringify({ id: `id-${folderName}`, name, agent: 'claude', avatar, members: [] }, null, 2))
      if (png) await writeFile(join(botHome, 'avatar.png'), png)
      return { name, home: botHome }
    }
    const upload = photo(600)
    assert.ok(upload.byteLength > MAX_PICTURE_BYTES, 'the uploaded picture is more than the Inbox keeps')
    const chats: FaceChat[] = [
      { agent: 'orca-ferry', session: 'orca-ferry', provider: 'claude', bot: await bot('ferry', 'Ferry', `mascot:${ids[0]}`) },
      { agent: 'orca-tug', session: 'orca-tug', provider: 'claude', bot: await bot('tug', 'Tug', `mascot:${ids[1]}`) },
      { agent: 'orca-photo', session: 'orca-photo', provider: 'claude', bot: await bot('photo', 'Photo', 'upload:00aa11bb22cc33dd', upload) },
      { agent: 'orca-emoji', session: 'orca-emoji', provider: 'codex', bot: await bot('emoji', 'Emoji', '⛴️') },
      { agent: 'orca-plain', session: 'orca-plain', provider: 'claude', bot: await bot('plain', 'Plain', null) },
      { agent: 'orca-chat', session: 'orca-chat', provider: 'claude', bot: null }
    ]
    const real = new BotAvatars({ assetFolders: () => [folder] })
    const reads: string[] = []
    const avatars: FacesAvatars = { picture: (ref) => (reads.push(ref.name), real.picture(ref)) }
    const store = memoryStore()
    const sync = () => new FaceSync({ inbox, store, avatars }).tick(chats)

    if (!features.includes('mark-faces')) {
      // Standard Plannotator: nothing is sent, and no bot is read.
      assert.deepEqual(await sync(), { ok: true, set: 0, reason: 'standard Plannotator' })
      assert.deepEqual(reads, [])
      const listed = await inbox.agentFaces()
      assert.deepEqual(listed.faces, {})
      process.stderr.write('faces e2e: standard Plannotator: no face set, no picture sent, no bot read\n')
      return
    }

    const pictures = new Map<string, { digest: string; type: string; bytes: Uint8Array }>()
    for (const chat of chats) {
      if (!chat.bot) continue
      const result = await real.picture(chat.bot)
      assert.ok(result.ok, `${chat.bot.name}: ${result.ok ? '' : result.reason}`)
      const bytes = Buffer.from(result.picture.url.slice(result.picture.url.indexOf(',') + 1), 'base64')
      pictures.set(chat.agent, { digest: result.picture.digest, type: result.picture.type, bytes })
      // 1. The real route keeps it, under the id that is its bytes' SHA-256.
      const { serverSession } = await inbox.agentFaces()
      assert.equal(await inbox.keepAgentPicture(result.picture.url, serverSession!), result.picture.digest, chat.bot.name)
    }
    assert.equal(new Set([...pictures.values()].map((item) => item.digest)).size, pictures.size, 'every bot looks different')

    // 2. One pass sets every face; the Inbox lists them and serves each picture's own bytes.
    assert.deepEqual(await sync(), { ok: true, set: 6 })
    const listed = await inbox.agentFaces()
    const registry = (await inbox.registry())!
    for (const chat of chats) {
      const want = pictures.get(chat.agent)
      assert.equal(listed.faces[chat.agent]?.face, want ? `own:${want.digest}` : 'mark:claude-code', chat.agent)
      if (!want) continue
      const served = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/agent-icons/${want.digest}`)
      assert.equal(served.status, 200, chat.agent)
      const bytes = new Uint8Array(await served.arrayBuffer())
      // 3. Kept exactly as sent: a mascot's SVG is not rewritten or refused.
      assert.equal(sha(bytes), want.digest, chat.agent)
      assert.equal(served.headers.get('content-type'), want.type, chat.agent)
      process.stderr.write(`faces e2e: ${chat.bot!.name}: ${want.type}, ${bytes.byteLength} bytes kept and served as sent; face own:${want.digest.slice(0, 12)}…\n`)
    }

    // 4. Nothing is written twice; a new picture in Orca is written; a person's own choice stays.
    assert.deepEqual(await sync(), { ok: true, set: 0 })
    await bot('ferry', 'Ferry', `mascot:${ids[2]}`)
    const changed = await real.picture(chats[0]!.bot!)
    assert.ok(changed.ok && changed.picture.digest !== pictures.get('orca-ferry')!.digest)
    const { serverSession } = await inbox.agentFaces()
    const chose = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/agent-faces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${registry.token}` },
      body: JSON.stringify({ agent: 'orca-tug', face: 'glass-teal', serverSession })
    })
    assert.equal(chose.status, 200, 'a person picks a face for the bot’s chat')
    await bot('tug', 'Tug', `mascot:${ids[2]}`)
    assert.deepEqual(await sync(), { ok: true, set: 1 })
    const after = await inbox.agentFaces()
    assert.equal(after.faces['orca-ferry']?.face, `own:${changed.picture.digest}`)
    assert.equal(after.faces['orca-tug']?.face, 'glass-teal')
    process.stderr.write('faces e2e: second pass wrote nothing; a new mascot was written; a person’s face stayed\n')
  } finally {
    await new Promise<void>((resolve) => execFile(BINARY, ['inbox', 'stop'], { env, timeout: 20_000 }, () => resolve()))
    const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))])
    if (!stopped) {
      child.kill('SIGTERM')
      await exited
    }
  }
})
