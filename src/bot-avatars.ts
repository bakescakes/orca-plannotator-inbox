// An Orca bot's own picture, for its chats' icon in the Inbox (src/faces.ts sends it). Read from Orca
// at run time on every pass, so a new picture in Orca follows within a minute; nothing of Orca's
// artwork is kept in this plugin.
//
// Where it is read: neither Orca's CLI (`bot list`, `worktree ps`) nor the plugin host names a bot's
// picture. Orca writes it, with the bot's id and name, to `bot.json` in the bot's home whenever it
// changes, so that file is read, and an uploaded picture's `avatar.png` beside it. No other file
// of the home is ever opened. The forms, as Orca reads them (`parseBotAvatar`):
//
//   mascot:<id>   one of the mascots that ship with Orca: its SVG, read from the installed app
//   upload:<v>    a square PNG the person gave the bot: averaged down to 128 px
//   null or ''    no picture: Orca shows the bot's initial on a tile, and so does this
//   anything else an emoji (from before mascots): drawn as Orca draws a repository's emoji
//
// A mascot's tile colour is kept only in Orca's own store, which this does not read, so a mascot
// shows on its own sky blue. Whatever cannot be read or shown gives no picture, and the chat keeps
// its agent's ordinary mark.
import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isPng, shrinkPng } from './png'
import { escapeXml, MAX_PICTURE_BYTES, picture, svgIsSafe, type Picture, type PictureResult } from './presentation'
import { isRecord } from './util'

/** A bot's chat: the bot's name as `worktree ps` gives it, and its home folder. */
export type BotRef = { name: string; home: string }

/** Orca's mascots are `<letter><digit>` ids; a built file is `<id>-<8-character hash>.svg`. */
const MASCOT_ID = /^[A-Z][0-9]{1,2}$/
const MASCOT_FILE = /^([A-Z][0-9]{1,2})-[A-Za-z0-9_-]{8}\.svg$/
/** A mascot's blur, beside the elements every picture may use. */
const MASCOT_ELEMENTS: ReadonlySet<string> = new Set(['filter', 'feGaussianBlur'])
/** What a mascot's `style` may say, moved to an attribute of the same name. */
const STYLE_PROPERTIES: ReadonlySet<string> = new Set(['fill', 'opacity', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width'])
const MAX_BOT_FILE = 64 * 1024
const MAX_MASCOT_FILE = 256 * 1024
/** Orca's own limit for an uploaded picture. */
const MAX_UPLOAD = 2 * 1024 * 1024
export const UPLOAD_SIDE = 128
const MAX_CACHED = 50

/**
 * Where an installed Orca keeps its renderer's files as real files (`app.asar.unpacked`), found from
 * the CLI the worker runs: the CLI entry beside them (`out/cli/index.js`), or `<resources>/bin/orca`.
 */
export function orcaAssetFolders(command: readonly string[] | null, resourcesPath = (process as { resourcesPath?: string }).resourcesPath): string[] {
  const folders: string[] = []
  const cli = command && command.length > 0 ? command[command.length - 1]! : null
  if (cli && isAbsolute(cli)) {
    let real = cli
    try {
      real = realpathSync(cli)
    } catch {
      // Not there: the path as given.
    }
    if (basename(real) === 'index.js' && basename(dirname(real)) === 'cli') {
      folders.push(join(dirname(dirname(real)).replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked'), 'renderer', 'assets'))
    } else {
      folders.push(resolve(dirname(real), '..', 'app.asar.unpacked', 'out', 'renderer', 'assets'))
    }
  }
  if (resourcesPath && isAbsolute(resourcesPath)) folders.push(join(resourcesPath, 'app.asar.unpacked', 'out', 'renderer', 'assets'))
  return [...new Set(folders)]
}

function asPicture(bytes: Uint8Array, type: string): Picture {
  return { url: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`, digest: createHash('sha256').update(bytes).digest('hex'), type }
}

/** The bot's initial on a tile, as Orca shows a bot without a picture. */
export function initialTile(name: string): Picture {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? '?'
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#8fa3b8"/>' +
    `<text x="32" y="43" text-anchor="middle" font-family="system-ui, sans-serif" font-size="30" font-weight="600" fill="#ffffff">${escapeXml(letter)}</text></svg>`
  return asPicture(Buffer.from(svg, 'utf8'), 'image/svg+xml')
}

/**
 * A mascot's SVG as the Inbox can take it: the two values Orca fills in from the bot's colour get
 * the mascot's own defaults (Orca's `recolorMascotSvg` does the same with the colour), and each
 * `style` becomes attributes. Null when what is left is not a safe picture.
 */
export function mascotSvg(text: string): Uint8Array | null {
  const filled = text.replace(/var\(\s*--avatar-[a-z-]+\s*,\s*([^()]*?)\s*\)/g, '$1')
  if (filled.includes('var(')) return null
  const flat = filled.replace(/\sstyle\s*=\s*"([^"]*)"/g, (whole, declarations: string) => {
    const attributes: string[] = []
    for (const part of declarations.split(';').map((item) => item.trim()).filter(Boolean)) {
      const match = /^([a-z-]+)\s*:\s*([#A-Za-z0-9.%\s-]+)$/.exec(part)
      if (!match || !STYLE_PROPERTIES.has(match[1]!)) return whole
      attributes.push(` ${match[1]}="${match[2]!.trim()}"`)
    }
    return attributes.join('')
  })
  const bytes = Buffer.from(flat, 'utf8')
  return bytes.byteLength <= MAX_PICTURE_BYTES && svgIsSafe(bytes, MASCOT_ELEMENTS) ? bytes : null
}

type Read = { ok: true; bytes: Uint8Array; size: number; mtimeMs: number } | { ok: false; reason: 'missing' | 'not-a-file' | 'too-big' }

/** One file, never through a link, at most `max` bytes. `key` sees its size and time first: a hit is not read. */
async function readFile(path: string, max: number, hit?: (size: number, mtimeMs: number) => boolean): Promise<Read | { ok: true; cached: true }> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'not-a-file' : 'missing' }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
    if (stat.size > max) return { ok: false, reason: 'too-big' }
    if (hit?.(stat.size, stat.mtimeMs)) return { ok: true, cached: true }
    const bytes = await handle.readFile()
    if (bytes.byteLength > max) return { ok: false, reason: 'too-big' }
    return { ok: true, bytes, size: stat.size, mtimeMs: stat.mtimeMs }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The same spacing rule `worktree ps` names are read with (`homeBot`). */
function botName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export class BotAvatars {
  private readonly cache = new Map<string, PictureResult>()

  constructor(private readonly deps: { assetFolders: () => readonly string[] }) {}

  /** The bot's picture as Orca shows it now, or why there is none. Never throws. */
  async picture(bot: BotRef): Promise<PictureResult> {
    try {
      return await this.read(bot)
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
  }

  private remember(key: string, result: PictureResult): PictureResult {
    this.cache.delete(key)
    this.cache.set(key, result)
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED) break
      this.cache.delete(oldest)
    }
    return result
  }

  private async read(bot: BotRef): Promise<PictureResult> {
    const { home } = bot
    // A bot's home is a folder of Orca's bots folder (`.../bots/<folder>`); nothing else is opened.
    if (!isAbsolute(home) || basename(dirname(home)) !== 'bots') return { ok: false, reason: 'not-a-bot-home' }
    const file = await readFile(join(home, 'bot.json'), MAX_BOT_FILE)
    if (!file.ok) return { ok: false, reason: `bot-file-${file.reason}` }
    if (!('bytes' in file)) return { ok: false, reason: 'unreadable' }
    let saved: unknown
    try {
      saved = JSON.parse(Buffer.from(file.bytes).toString('utf8'))
    } catch {
      return { ok: false, reason: 'bot-file-unreadable' }
    }
    if (!isRecord(saved) || typeof saved.name !== 'string') return { ok: false, reason: 'bot-file-unreadable' }
    // The home of the bot Orca names, as Orca last wrote it: a rename not yet written waits for the next pass.
    if (botName(saved.name) !== botName(bot.name)) return { ok: false, reason: 'another-bot' }
    const avatar = saved.avatar
    if (avatar === null || avatar === undefined || avatar === '') return { ok: true, picture: initialTile(saved.name) }
    if (typeof avatar !== 'string') return { ok: false, reason: 'unknown-avatar' }
    if (avatar.startsWith('mascot:')) {
      const id = avatar.slice('mascot:'.length)
      // Orca shows its initial for a mascot it does not have (one from a newer Orca).
      if (!MASCOT_ID.test(id)) return { ok: true, picture: initialTile(saved.name) }
      const mascot = await this.mascot(id)
      return mascot === 'unknown' ? { ok: true, picture: initialTile(saved.name) } : mascot
    }
    if (avatar.startsWith('upload:')) {
      const version = avatar.slice('upload:'.length)
      if (version === '') return { ok: true, picture: initialTile(saved.name) }
      return this.upload(home, version)
    }
    return picture({ type: 'emoji', emoji: avatar })
  }

  /** The installed Orca's mascot, 'unknown' when this Orca ships mascots but not that one. */
  private async mascot(id: string): Promise<PictureResult | 'unknown'> {
    for (const folder of this.deps.assetFolders()) {
      let names: string[]
      try {
        names = await readdir(folder)
      } catch {
        continue
      }
      const mascots = names.filter((name) => MASCOT_FILE.test(name))
      if (mascots.length === 0) continue
      const mine = mascots.filter((name) => MASCOT_FILE.exec(name)![1] === id)
      if (mine.length === 0) return 'unknown'
      if (mine.length > 1) return { ok: false, reason: 'mascot-ambiguous' }
      // The file's name carries a hash of its contents: one read per file.
      const path = join(folder, mine[0]!)
      const cached = this.cache.get(`mascot:${path}`)
      if (cached) return this.remember(`mascot:${path}`, cached)
      const file = await readFile(path, MAX_MASCOT_FILE)
      if (!file.ok || !('bytes' in file)) return { ok: false, reason: 'mascot-unreadable' }
      const svg = mascotSvg(Buffer.from(file.bytes).toString('utf8'))
      return this.remember(`mascot:${path}`, svg ? { ok: true, picture: asPicture(svg, 'image/svg+xml') } : { ok: false, reason: 'mascot-unsafe' })
    }
    return { ok: false, reason: 'no-mascots' }
  }

  private async upload(home: string, version: string): Promise<PictureResult> {
    const path = join(home, 'avatar.png')
    let key = ''
    const file = await readFile(path, MAX_UPLOAD, (size, mtimeMs) => {
      key = `upload:${path}:${version}:${size}:${mtimeMs}`
      return this.cache.has(key)
    })
    if (!file.ok) return { ok: false, reason: `upload-${file.reason}` }
    if (!('bytes' in file)) return this.remember(key, this.cache.get(key)!)
    if (!isPng(file.bytes)) return this.remember(key, { ok: false, reason: 'upload-not-png' })
    const small = shrinkPng(file.bytes, UPLOAD_SIDE) ?? (file.bytes.byteLength <= MAX_PICTURE_BYTES ? file.bytes : null)
    return this.remember(key, small ? { ok: true, picture: asPicture(small, 'image/png') } : { ok: false, reason: 'upload-unreadable' })
  }
}
