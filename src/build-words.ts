// What the Orca build's state says to a person, for the worker's status text. src/panel.tsx keeps
// the same two sentences itself (the panel imports only types).
import type { BuildInfo } from './protocol'

/**
 * The Plannotator installed here has no Orca build in use yet: a wait, said plainly, never a failure.
 * The Inbox then runs that Plannotator. (With an Orca build still in use: no Plannotator is installed
 * here, and the build follows the newest release by itself.)
 */
export function waitingLine(build: BuildInfo): string {
  const waiting = build.waiting!
  if (build.mode === 'orca-build') return `Plannotator ${waiting.version} is out. Its Orca build is not published yet; the Orca build of ${build.version} stays in use and updates by itself when it is.`
  // The updater's own sentence says why when a published build could not be used.
  if (build.detail?.startsWith(`Plannotator ${waiting.version} is in use`)) return build.detail
  return `Plannotator ${waiting.version} is in use. Its Orca build is not published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are missing until it is; the Inbox moves to it by itself.`
}

/** A reduced build: what it lacks, in one line. */
export function reducedLine(reduced: NonNullable<BuildInfo['reduced']>): string {
  const words = reduced.lacks
  const what = words.length === 0 ? `some Orca changes (${reduced.omitted.join(', ')})` : words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `This build lacks ${what}. The full build installs by itself when it is published.`
}
