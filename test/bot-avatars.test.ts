// A bot's own picture as Orca has it (src/bot-avatars.ts) and the PNG shrinking it needs
// (src/png.ts), against throwaway bot homes and a throwaway copy of an app's asset folder holding
// invented mascots. Never reads the real Orca, unless ORCA_LIVE_CLI is set (then only its mascots).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BotAvatars, mascotSvg, orcaAssetFolders, UPLOAD_SIDE } from '../src/bot-avatars'
import { decodePng, encodePng, shrinkPng } from '../src/png'
import { MAX_PICTURE_BYTES } from '../src/presentation'
import { tempDir } from './fakes'

/** An invented mascot in Orca's layered shape: its tile colour and rim filled in by Orca, a blur. */
const mascot = (body: string) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><filter id="b"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
  '<g id="bg"><rect width="128" height="128" style="fill:var(--avatar-bg,#b3dbf4)"/></g>' +
  `<g id="rim" style="opacity:var(--avatar-rim,0)"><path d="M0 0h8v8z" fill="#fff"/></g><g id="body"><path d="${body}" filter="url(#b)" fill="#222"/></g></svg>`

async function setup() {
  const root = await tempDir('bot-avatars-')
  const assets = join(root, 'Resources', 'app.asar.unpacked', 'out', 'renderer', 'assets')
  await mkdir(assets, { recursive: true })
  await writeFile(join(assets, 'Q7-aB3_dE9x.svg'), mascot('M10 10h20v20z'))
  await writeFile(join(assets, 'W4-Zz00yY11.svg'), mascot('M40 40h20v20z'))
  await writeFile(join(assets, 'Q7-cut-Ab12Cd34.webp'), 'not a mascot')
  await writeFile(join(assets, 'index-Ab12Cd34.js'), 'not a mascot')
  const avatars = new BotAvatars({ assetFolders: () => [join(root, 'missing'), assets] })
  /** A bot's home as Orca writes it: `bot.json` and, for an upload, `avatar.png`. */
  const bot = async (folder: string, json: Record<string, unknown>, png?: Uint8Array) => {
    const home = join(root, 'bots', folder)
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'bot.json'), JSON.stringify({ id: `id-${folder}`, agent: 'claude', members: [], ...json }, null, 2))
    if (png) await writeFile(join(home, 'avatar.png'), png)
    return { name: String(json.name), home }
  }
  return { root, assets, avatars, bot }
}

const text = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8')

/** A noisy square RGBA picture: barely compresses, as a photo does not. */
function photo(side: number): Uint8Array {
  return encodePng({ width: side, height: side, pixels: new Uint8Array(randomBytes(side * side * 4)).map((value, index) => (index % 4 === 3 ? 255 : value)) })
}

test('a mascot is read from the installed app, with Orca’s own default colour, and two bots differ', async () => {
  const t = await setup()
  const ferry = await t.avatars.picture(await t.bot('ferry', { name: 'Ferry', avatar: 'mascot:Q7' }))
  const tug = await t.avatars.picture(await t.bot('tug', { name: 'Tug', avatar: 'mascot:W4' }))
  assert.ok(ferry.ok && tug.ok)
  assert.equal(ferry.picture.type, 'image/svg+xml')
  const svg = text(ferry.picture.url)
  assert.match(svg, /<rect width="128" height="128" fill="#b3dbf4"\/>/)
  assert.match(svg, /<g id="rim" opacity="0">/)
  assert.doesNotMatch(svg, /var\(|style=/)
  assert.notEqual(ferry.picture.digest, tug.picture.digest)
})

test('a picture changed in Orca is read again; a removed, renamed or other bot’s home gives none', async () => {
  const t = await setup()
  const ferry = await t.bot('ferry', { name: 'Ferry', avatar: 'mascot:Q7' })
  const first = await t.avatars.picture(ferry)
  await t.bot('ferry', { name: 'Ferry', avatar: 'mascot:W4' })
  const second = await t.avatars.picture(ferry)
  assert.ok(first.ok && second.ok)
  assert.notEqual(first.picture.digest, second.picture.digest)
  // Renamed in Orca: `worktree ps` names the new name, and so does `bot.json` once Orca has written it.
  await t.bot('ferry', { name: 'Old Ferry', avatar: 'mascot:W4' })
  assert.deepEqual(await t.avatars.picture(ferry), { ok: false, reason: 'another-bot' })
  const renamed = await t.avatars.picture({ name: '  Old   Ferry ', home: ferry.home })
  assert.ok(renamed.ok && renamed.picture.digest === second.picture.digest)
  assert.deepEqual(await t.avatars.picture({ name: 'Gone', home: join(t.root, 'bots', 'gone') }), { ok: false, reason: 'bot-file-missing' })
  // Only a folder of a bots folder is a bot's home.
  await mkdir(join(t.root, 'work'), { recursive: true })
  await writeFile(join(t.root, 'work', 'bot.json'), JSON.stringify({ name: 'Ferry', avatar: 'mascot:Q7' }))
  assert.deepEqual(await t.avatars.picture({ name: 'Ferry', home: join(t.root, 'work') }), { ok: false, reason: 'not-a-bot-home' })
})

test('a bot file reached through a link is not read', async () => {
  const t = await setup()
  const real = await t.bot('real', { name: 'Ferry', avatar: 'mascot:Q7' })
  const home = join(t.root, 'bots', 'linked')
  await mkdir(home, { recursive: true })
  await symlink(join(real.home, 'bot.json'), join(home, 'bot.json'))
  assert.deepEqual(await t.avatars.picture({ name: 'Ferry', home }), { ok: false, reason: 'bot-file-not-a-file' })
})

test('no picture, or a mascot this Orca does not ship, is the bot’s initial on a tile, as Orca shows it', async () => {
  const t = await setup()
  const none = await t.avatars.picture(await t.bot('ferry', { name: 'ferry', avatar: null }))
  const unknown = await t.avatars.picture(await t.bot('tug', { name: 'Tug', avatar: 'mascot:Z9' }))
  assert.ok(none.ok && unknown.ok)
  assert.match(text(none.picture.url), />F<\/text><\/svg>$/)
  assert.match(text(unknown.picture.url), />T<\/text><\/svg>$/)
  // Without the app's mascots at all, a mascot is not guessed at: the chat keeps its agent's mark.
  const bare = new BotAvatars({ assetFolders: () => [join(t.root, 'missing')] })
  assert.deepEqual(await bare.picture(await t.bot('wave', { name: 'Wave', avatar: 'mascot:Q7' })), { ok: false, reason: 'no-mascots' })
})

test('an emoji from before mascots is drawn; one that is not an emoji is not', async () => {
  const t = await setup()
  const emoji = await t.avatars.picture(await t.bot('ferry', { name: 'Ferry', avatar: '⛴️' }))
  assert.ok(emoji.ok)
  assert.match(text(emoji.picture.url), /<text [^>]*>⛴️<\/text>/)
  assert.deepEqual(await t.avatars.picture(await t.bot('tug', { name: 'Tug', avatar: 'x'.repeat(100) })), { ok: false, reason: 'bad-emoji' })
  assert.deepEqual(await t.avatars.picture(await t.bot('odd', { name: 'Odd', avatar: 7 })), { ok: false, reason: 'unknown-avatar' })
})

test('an uploaded picture is shrunk to fit what the Inbox keeps, and a new upload is read again', async () => {
  const t = await setup()
  const big = photo(600)
  assert.ok(big.byteLength > MAX_PICTURE_BYTES, 'the upload is more than the Inbox takes')
  const ferry = await t.bot('ferry', { name: 'Ferry', avatar: 'upload:00aa11bb22cc33dd' }, big)
  const first = await t.avatars.picture(ferry)
  assert.ok(first.ok)
  assert.equal(first.picture.type, 'image/png')
  const shrunk = decodePng(Buffer.from(first.picture.url.slice('data:image/png;base64,'.length), 'base64'))
  assert.deepEqual([shrunk?.width, shrunk?.height], [UPLOAD_SIDE, UPLOAD_SIDE])
  await t.bot('ferry', { name: 'Ferry', avatar: 'upload:44ee55ff66aa77bb' }, photo(512))
  const second = await t.avatars.picture(ferry)
  assert.ok(second.ok && second.picture.digest !== first.picture.digest)
  // Not a PNG, or gone: none.
  await t.bot('ferry', { name: 'Ferry', avatar: 'upload:8899' }, Buffer.from('<svg/>'))
  assert.deepEqual(await t.avatars.picture(ferry), { ok: false, reason: 'upload-not-png' })
  const tug = await t.bot('tug', { name: 'Tug', avatar: 'upload:8899' })
  assert.deepEqual(await t.avatars.picture(tug), { ok: false, reason: 'upload-missing' })
})

test('a mascot that is not a plain picture is refused', () => {
  assert.ok(mascotSvg(mascot('M0 0h1z')))
  assert.equal(mascotSvg(mascot('M0 0h1z').replace('<g id="body">', '<g id="body"><script>alert(1)</script>')), null)
  assert.equal(mascotSvg(mascot('M0 0h1z').replace('<g id="body">', '<g id="body"><image href="https://example.com/x.png"/>')), null)
  assert.equal(mascotSvg(mascot('M0 0h1z').replace('fill:var(--avatar-bg,#b3dbf4)', 'background:url(https://example.com/x)')), null)
  assert.equal(mascotSvg(mascot('M0 0h1z').replace('var(--avatar-rim,0)', 'var(--other)')), null)
})

test('the app’s asset folder is found from the CLI the worker runs', () => {
  assert.deepEqual(orcaAssetFolders(['/opt/Orca/resources/bin/orca'], undefined), ['/opt/Orca/resources/app.asar.unpacked/out/renderer/assets'])
  assert.deepEqual(orcaAssetFolders(['/opt/Orca/orca', '/opt/Orca/resources/app.asar/out/cli/index.js'], undefined), ['/opt/Orca/resources/app.asar.unpacked/out/renderer/assets'])
  assert.deepEqual(orcaAssetFolders(['/opt/Orca/orca', '/opt/Orca/resources/app.asar.unpacked/out/cli/index.js'], '/opt/Orca/resources'), ['/opt/Orca/resources/app.asar.unpacked/out/renderer/assets'])
  assert.deepEqual(orcaAssetFolders(null, undefined), [])
})

test('PNGs: what is written reads back, colours average by their alpha, and an unsupported PNG is not read', () => {
  const pixels = new Uint8Array([255, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255])
  const two = encodePng({ width: 2, height: 2, pixels })
  assert.deepEqual(decodePng(two), { width: 2, height: 2, pixels })
  // The transparent white pixel does not tint the average.
  assert.deepEqual([...decodePng(shrinkPng(two, 1)!)!.pixels], [85, 0, 170, 191])
  // A wide picture keeps its centre square.
  const wide = encodePng({ width: 3, height: 1, pixels: new Uint8Array([0, 0, 0, 255, 9, 9, 9, 255, 0, 0, 0, 255]) })
  assert.deepEqual([...decodePng(shrinkPng(wide, 8)!)!.pixels], [9, 9, 9, 255])
  // 16 bits per channel: not read.
  const deep = Buffer.from(two)
  deep[24] = 16
  assert.equal(decodePng(deep), null)
  assert.equal(shrinkPng(Buffer.from('not a png'), 8), null)
})

const LIVE = (process.env.ORCA_LIVE_CLI ?? '').trim()
test('live Orca: every mascot the installed app ships reads as a safe picture', { skip: LIVE ? false : 'set ORCA_LIVE_CLI to run' }, () => {
  const folder = orcaAssetFolders([LIVE]).find((path) => existsSync(path))
  assert.ok(folder, 'the app’s asset folder is found')
  const files = readdirSync(folder).filter((name) => /^[A-Z][0-9]{1,2}-[A-Za-z0-9_-]{8}\.svg$/.test(name))
  assert.ok(files.length > 0, 'the app ships mascots')
  for (const name of files) assert.ok(mascotSvg(readFileSync(join(folder, name), 'utf8')), name)
  process.stderr.write(`live Orca: ${files.length} mascot(s) read\n`)
})
