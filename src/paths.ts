// Where things live. Mirrors Plannotator's own data-dir rule so both sides open the same Inbox.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export type Env = Record<string, string | undefined>

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/**
 * Plannotator's data folder: an explicit setting, then `PLANNOTATOR_DATA_DIR`, then
 * `~/.plannotator`, then `$XDG_DATA_HOME/plannotator` when only that one exists.
 */
export function resolveDataDir(setting: string | undefined, env: Env, home: string = homedir()): string {
  const explicit = (setting ?? '').trim() || (env.PLANNOTATOR_DATA_DIR ?? '').trim()
  if (explicit) return resolve(expandHome(explicit, home))
  const dotFolder = join(home, '.plannotator')
  const xdgHome = (env.XDG_DATA_HOME ?? '').trim()
  if (!existsSync(dotFolder) && xdgHome && isAbsolute(xdgHome)) {
    const xdg = join(xdgHome, 'plannotator')
    if (existsSync(xdg)) return xdg
  }
  return dotFolder
}

/**
 * The folder the worker and the MCP launcher share. It has to be a fixed place: agent
 * configs point at the launcher in it, and they must keep working when the plugin updates
 * (Orca replaces the plugin's own folder on every update).
 */
export function sharedDir(env: Env, home: string = homedir()): string {
  const override = (env.ORCA_PLANNOTATOR_HOME ?? '').trim()
  return override ? resolve(expandHome(override, home)) : join(home, '.orca-plannotator-inbox')
}
