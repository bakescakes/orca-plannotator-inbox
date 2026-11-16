// Small shared helpers. Node builtins only: the plugin ships with no dependencies and no build step.
import { createHash } from 'node:crypto'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Orca's native chat id, as Orca injects it (`ORCA_AGENT_SESSION_ID`). */
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** Plannotator message and thread ids. */
export const ID = /^[A-Za-z0-9_-]{1,160}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The bare session id; `orca_session_id:` is Orca's mail-address prefix for the same id. */
export function canonicalSession(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const bare = value.startsWith('orca_session_id:') ? value.slice('orca_session_id:'.length) : value
  return SESSION.test(bare) ? bare : null
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Runs tasks that share a key one at a time, in order. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    this.tails.set(key, settled)
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key)
    })
    return next
  }
}
