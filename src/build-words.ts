// What the Orca build's state says to a person, for the worker's status text. src/panel.tsx keeps
// the same two sentences itself (the panel imports only types).
import type { BuildInfo } from './protocol'

/** A newer Plannotator with no Orca build yet: a wait, said plainly, never a failure. */
export function waitingLine(build: BuildInfo): string {
  const waiting = build.waiting!
  return build.mode === 'orca-build'
    ? `Plannotator ${waiting.version} is out. Its Orca build is not published yet; the Orca build of ${build.version} stays in use and updates by itself when it is.`
    : `Plannotator ${waiting.version} is out. Its Orca build is not published yet; it installs by itself when it is.`
}

/** A reduced build: what it lacks, in one line. */
export function reducedLine(reduced: NonNullable<BuildInfo['reduced']>): string {
  const words = reduced.lacks
  const what = words.length === 0 ? `some Orca changes (${reduced.omitted.join(', ')})` : words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `This build lacks ${what}. The full build installs by itself when it is published.`
}
