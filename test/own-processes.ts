// The in-app tests start a second Orca from a real Orca app, with a throwaway profile. Stopping the
// CLI that started it does not always stop the app, its helpers or its crash reporter (the crash
// reporter runs on its own, outside the CLI's process group). This stops exactly what a test left
// behind: the processes whose command line names the test's own throwaway folder, which Orca passes
// to everything it starts for that profile (`--user-data-dir=`, `--database=`, `--socket`). Never by
// name, so an Orca with any other profile, the person's own among them, is never touched.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The processes (other than this one and its parent) whose command line names something inside `folder`. */
export async function processesIn(folder: string): Promise<number[]> {
  if (process.platform === 'win32') return []
  const temporary = await realpath(tmpdir())
  const own = await realpath(folder)
  const inside = relative(temporary, own)
  // Only a folder of its own inside the system's temporary folder: never a home, a profile or a root.
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${own} is not a throwaway folder inside ${temporary}.`)
  const mark = `${own}${sep}`
  const listing = await new Promise<string>((resolve, reject) =>
    execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  )
  const found: number[] = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match || !match[2]!.includes(mark)) continue
    const pid = Number(match[1])
    if (pid !== process.pid && pid !== process.ppid) found.push(pid)
  }
  return found
}

/**
 * Stops what the test left running in `folder` (see above): asks each to stop, waits up to `waitMs`,
 * then ends what is left, read again so a pid let go of meanwhile is not signalled. Resolves the pids
 * it found.
 */
export async function stopProcessesIn(folder: string, waitMs = 10_000): Promise<number[]> {
  const found = await processesIn(folder)
  for (const pid of found) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Gone already.
    }
  }
  const deadline = Date.now() + waitMs
  while (found.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  if (found.some(alive)) {
    const still = new Set(await processesIn(folder))
    for (const pid of found) {
      if (!still.has(pid)) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return found
}
