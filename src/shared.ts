// The one folder the worker and the MCP launcher share (`~/.orca-plannotator-inbox`):
//   inbox-mcp(.cmd)   what agent configs run; starts inbox-mcp.mjs with Orca's own Node
//   inbox-mcp.mjs     copied from the plugin's bin/ on every start, so it updates with the plugin
//   state.json        the worker's heartbeat: "replies for this Inbox are being delivered"
//   sessions/*.json   written by the launcher: which Orca chats use the Inbox
// Agent configs point here and not into the plugin's own folder because Orca replaces that folder
// on every plugin update.
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSession, isRecord } from './util'

export const HEARTBEAT_MS = 15_000
const REGISTRATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_REGISTRATIONS = 512

export type Registration = { session: string; raw: string; projectPath: string | null; dataDir: string | null; at: number }
export type Heartbeat = { v: 1; pid: number; at: number; dataDir: string; delivering: boolean }

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, path)
}

/** POSIX single-quoting: the only character that needs care inside '…' is the quote itself. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function launcherName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'inbox-mcp.cmd' : 'inbox-mcp'
}

export function launcherPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dir, launcherName(platform))
}

/** `node` is the binary that runs the wrapper: Orca's own, in Node mode, so nobody needs Node installed. */
export function launcherScript(dir: string, node: string, platform: NodeJS.Platform = process.platform): string {
  const script = join(dir, 'inbox-mcp.mjs')
  if (platform === 'win32') {
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${script}" %*\r\n`
  }
  return [
    '#!/bin/sh',
    '# Plannotator\'s own stdio server (`plannotator inbox mcp`), started so that replies come back to Orca chats.',
    '# Written by the Plannotator Inbox plugin for Orca and rewritten when Orca starts. Already connected: change nothing.',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(node)} ${shellQuote(script)} "$@"`,
    ''
  ].join('\n')
}

/** Puts the launcher and the wrapper in place. Safe to repeat; a running agent keeps the copy it started with. */
export async function installShared(dir: string, wrapperSource: string, node: string = process.execPath): Promise<string> {
  await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 })
  const wrapper = join(dir, 'inbox-mcp.mjs')
  const temporary = `${wrapper}.${process.pid}.tmp`
  await copyFile(wrapperSource, temporary)
  await rename(temporary, wrapper)
  const launcher = launcherPath(dir)
  const script = launcherScript(dir, node)
  const current = await readFile(launcher, 'utf8').catch(() => null)
  if (current !== script) await writeAtomic(launcher, script, 0o755)
  if (process.platform !== 'win32') await chmod(launcher, 0o755)
  return launcher
}

export async function writeHeartbeat(dir: string, heartbeat: Omit<Heartbeat, 'v' | 'pid'>): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeAtomic(join(dir, 'state.json'), `${JSON.stringify({ v: 1, pid: process.pid, ...heartbeat })}\n`, 0o600)
}

/** The chats that registered through the launcher. Unreadable and very old files are removed. */
export async function readRegistrations(dir: string, now: number = Date.now()): Promise<Registration[]> {
  const folder = join(dir, 'sessions')
  let names: string[]
  try {
    names = await readdir(folder)
  } catch {
    return []
  }
  const found: Registration[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRATIONS)) {
    const path = join(folder, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 16_384) throw new Error('not a registration')
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const session = isRecord(parsed) ? canonicalSession(parsed.session) : null
      if (!isRecord(parsed) || !session || `${session}.json` !== name) throw new Error('not a registration')
      const at = typeof parsed.at === 'number' ? parsed.at : info.mtimeMs
      if (now - at > REGISTRATION_MAX_AGE_MS) throw new Error('expired')
      found.push({
        session,
        raw: typeof parsed.raw === 'string' && canonicalSession(parsed.raw) === session ? parsed.raw : session,
        projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : null,
        dataDir: typeof parsed.dataDir === 'string' ? parsed.dataDir : null,
        at
      })
    } catch {
      await rm(path, { force: true }).catch(() => undefined)
    }
  }
  return found
}
