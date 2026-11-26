// The plugin's sidebar panel: what is connected, which chats are listening, and anything that
// needs a person. No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { ActionResult, AgentLink, BuildInfo, Phase, ServerMode, Status } from './protocol'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const status = atom<Status | null>(null)
const notice = atom<ActionResult | null>(null)
const busy = atom(false)

const PHASE_TONE: Record<Phase, Tone> = {
  ready: 'success',
  off: 'neutral',
  'inbox-stopped': 'neutral',
  'no-plannotator': 'warning',
  'no-orca': 'warning',
  problem: 'danger'
}
const LINK_LABEL: Record<AgentLink['state'], string> = {
  connected: 'Connected',
  builtin: 'Built in',
  plannotator: 'No replies to Orca',
  other: 'Own setup',
  off: 'Off',
  manual: 'By hand',
  absent: 'Not connected',
  missing: 'Not installed'
}
const LINK_TONE: Record<AgentLink['state'], Tone> = {
  connected: 'success',
  builtin: 'success',
  plannotator: 'warning',
  other: 'neutral',
  off: 'neutral',
  manual: 'neutral',
  absent: 'warning',
  missing: 'neutral'
}

async function act(run: () => Promise<ActionResult>): Promise<void> {
  if (read(busy)) return
  set(busy, true)
  try {
    set(notice, await run())
  } catch (error) {
    set(notice, { ok: false, message: error instanceof Error ? error.message : 'That did not work.' })
  } finally {
    set(busy, false)
  }
}

async function refresh(): Promise<void> {
  set(status, await plugin.request('status.get', { fresh: true }))
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('status.changed', (next) => set(status, next)))
  void plugin
    .request('status.get', {})
    .then((first) => set(status, first))
    .catch(() => set(notice, { ok: false, message: 'The plugin’s worker did not answer. Reload the plugin from Orca’s plugin list.' }))
}

function Agents({ agents }: { agents: readonly AgentLink[] }) {
  const canConnect = agents.some((agent) => agent.state === 'absent' || agent.state === 'plannotator')
  const canDisconnect = agents.some((agent) => agent.state === 'connected')
  return (
    <Card title="Agents" description="Which agents send to the Inbox as Orca chats, so replies come back to the chat that asked.">
      <Stack gap="sm">
        {agents.map((agent) => (
          <Stack gap="xs">
            <Row justify="between" align="center">
              <Text weight="medium">{agent.name}</Text>
              <Badge tone={LINK_TONE[agent.state]}>{LINK_LABEL[agent.state]}</Badge>
            </Row>
            <Text muted size="xs">{agent.detail}</Text>
          </Stack>
        ))}
        <Row gap="xs" wrap>
          {canConnect ? (
            <Button icon="plug" disabled={read(busy)} onPress={() => act(() => plugin.request('agents.connect', {}))}>
              Connect agents
            </Button>
          ) : null}
          {canDisconnect ? (
            <Button variant="ghost" disabled={read(busy)} onPress={() => act(() => plugin.request('agents.disconnect', {}))}>
              Disconnect
            </Button>
          ) : null}
        </Row>
        {canConnect ? (
          <Text muted size="xs">
            Connecting adds one `plannotator-inbox` server to each agent's own settings: Claude Code, Codex and OpenCode by this plugin, every other agent by Plannotator. It applies to chats started afterwards.
          </Text>
        ) : null}
      </Stack>
    </Card>
  )
}

// The same two sentences as src/build-words.ts (the worker's status text): the panel imports only types.

/**
 * The Plannotator installed here has no Orca build in use yet: a wait, said plainly, never a failure.
 * The Inbox then runs that Plannotator. (With an Orca build still in use: no Plannotator is installed
 * here, and the build follows the newest release by itself.)
 */
function waitingLine(build: BuildInfo): string {
  const waiting = build.waiting!
  if (build.mode === 'orca-build') return `Plannotator ${waiting.version} is out. Its Orca build is not published yet; the Orca build of ${build.version} stays in use and updates by itself when it is.`
  // The updater's own sentence says why when a published build could not be used.
  if (build.detail?.startsWith(`Plannotator ${waiting.version} is in use`)) return build.detail
  return `Plannotator ${waiting.version} is in use. Its Orca build is not published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are missing until it is; the Inbox moves to it by itself.`
}

/** A reduced build: what it lacks, in one line. */
function reducedLine(reduced: NonNullable<BuildInfo['reduced']>): string {
  const words = reduced.lacks
  const what = words.length === 0 ? `some Orca changes (${reduced.omitted.join(', ')})` : words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `This build lacks ${what}. The full build installs by itself when it is published.`
}

/** The Orca build of Plannotator: which one is in use, and anything about it that needs a person. */
function Build({ build, server }: { build: BuildInfo; server: ServerMode | undefined }) {
  const inUse = build.mode === 'orca-build'
  const newer = build.latestKnown && (build.latestKnown.version !== build.version || build.latestKnown.build !== build.build) ? build.latestKnown : null
  return (
    <Card
      title="Plannotator for Orca"
      description="Plannotator with Orca support added: the Inbox can start, stop and resume Orca chats and shows each agent's icon. This plugin downloads it and keeps it up to date."
    >
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Text weight="medium">{inUse ? `Plannotator ${build.version} (${build.build})` : 'Standard Plannotator'}</Text>
          <Badge tone={inUse ? 'success' : 'neutral'}>{build.updating ? 'Updating' : inUse ? 'Installed' : 'Not installed'}</Badge>
        </Row>
        {build.updating ? <Text muted size="xs">{build.detail ?? 'Downloading and checking the Orca build…'}</Text> : null}
        {!build.updating && newer ? (
          <Text muted size="xs">
            Plannotator {newer.version} ({newer.build}) is available. It installs by itself, or from the Inbox's own Update button.
          </Text>
        ) : null}
        {build.waiting ? <Text muted size="xs">{waitingLine(build)}</Text> : null}
        {inUse && build.reduced ? <Text muted size="xs">{reducedLine(build.reduced)}</Text> : null}
        {!build.updating && build.lastError ? <Callout tone="warning">{build.lastError}</Callout> : null}
        {inUse && build.moving ? (
          <Callout tone="neutral">The Inbox started on standard Plannotator; moving it to the Orca build…</Callout>
        ) : inUse && server === 'stock' ? (
          <Callout tone="neutral">The Inbox that is running now is standard Plannotator. Restart it to use the Orca build; nothing saved is lost.</Callout>
        ) : null}
        <Row gap="xs" wrap>
          {inUse && server === 'stock' && !build.moving ? (
            <Button icon="refresh" disabled={read(busy)} onPress={() => act(() => plugin.request('inbox.restartOnBuild'))}>
              Restart Inbox
            </Button>
          ) : null}
          <Button variant="ghost" disabled={read(busy) || build.updating} onPress={() => act(() => plugin.request('build.check'))}>
            Check for a new build
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

/**
 * A new install, before anything is downloaded: the one question about the Orca build. The words say
 * what it is and that nothing of the person's own is replaced.
 */
function AskBuild() {
  return (
    <Card
      title="Start and stop Orca chats from the Inbox"
      description="This uses the Orca build of Plannotator: the same Plannotator release you have, with a few small changes so the Inbox can work with Orca chats. Your own Plannotator and your Inbox stay as they are."
    >
      <Stack gap="sm">
        <Row gap="xs" wrap>
          <Button disabled={read(busy)} onPress={() => act(() => plugin.request('build.choose', { use: true }))}>
            Use it
          </Button>
          <Button variant="ghost" disabled={read(busy)} onPress={() => act(() => plugin.request('build.choose', { use: false }))}>
            Not now
          </Button>
        </Row>
        <Text muted size="xs">Replies reach your chats either way. You can change this in Settings.</Text>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const current = read(status)
  const message = read(notice)
  if (current === null) {
    return (
      <Stack gap="md">
        <Heading>Plannotator Inbox</Heading>
        {message ? <Callout tone="danger">{message.message}</Callout> : <Text muted>Looking…</Text>}
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Plannotator Inbox</Heading>
        <Badge tone={PHASE_TONE[current.phase]}>{current.headline}</Badge>
      </Row>
      {current.detail ? (
        <Callout tone={current.phase === 'ready' ? 'neutral' : PHASE_TONE[current.phase]}>{current.detail}</Callout>
      ) : null}
      <Row gap="xs" wrap>
        <Button icon="open-external" disabled={read(busy)} onPress={() => act(() => plugin.request('inbox.open'))}>
          Open Inbox
        </Button>
        <Button variant="ghost" icon="refresh" onPress={refresh}>
          Refresh
        </Button>
      </Row>
      {message ? <Callout tone={message.ok ? 'success' : 'warning'}>{message.message}</Callout> : null}

      {current.blocked.length > 0 ? (
        <Card title="Needs you" description="Orca did not take or did not confirm these replies, and none was sent a second time. They are still in the Inbox.">
          <Stack gap="sm">
            {current.blocked.map((row) => (
              <Stack gap="xs">
                <Text weight="medium" truncate>{row.subject ?? 'A reply'}</Text>
                {row.bot ? <Text muted size="xs" truncate>To {row.bot}</Text> : null}
                <Text muted size="xs">
                  {row.error ?? 'Not confirmed.'} <RelativeTime at={row.updated} muted />
                </Text>
                <Row>
                  <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => act(() => plugin.request('delivery.retry', { key: row.key }))}>
                    Send again
                  </Button>
                </Row>
              </Stack>
            ))}
          </Stack>
        </Card>
      ) : null}

      {(current.rejected ?? []).length > 0 ? (
        <Card title="Not delivered" description="These replies did not pass the checks that tie a reply to one chat, so no chat was woken. They are still in the Inbox.">
          <Stack gap="sm">
            {(current.rejected ?? []).map((row) => (
              <Stack gap="xs">
                <Text weight="medium" truncate>{row.subject ?? 'A reply'}</Text>
                {row.bot ? <Text muted size="xs" truncate>To {row.bot}</Text> : null}
                <Text muted size="xs">
                  {row.error ?? 'Not delivered.'} <RelativeTime at={row.updated} muted />
                </Text>
              </Stack>
            ))}
          </Stack>
        </Card>
      ) : null}

      <Card title="Chats listening" description="Orca chats on this computer whose Inbox replies arrive by themselves.">
        {current.sessions.length === 0 ? (
          <EmptyState icon="bell" title="No chats yet" description="A chat starts listening with its first Inbox message." />
        ) : (
          <List label="Chats listening">
            {current.sessions.map((chat) => (
              <ListItem
                icon="agent"
                title={chat.title ?? chat.session}
                description={[chat.bot ?? chat.provider, chat.listening ? null : 'not listening', chat.note].filter(Boolean).join(' · ') || undefined}
              />
            ))}
          </List>
        )}
      </Card>

      {current.agents.length > 0 ? <Agents agents={current.agents} /> : null}

      {current.askBuild ? <AskBuild /> : current.build ? <Build build={current.build} server={current.server} /> : null}

      <KeyValue
        label="Details"
        items={[
          { label: 'Plannotator', value: current.inbox.version ?? 'not running' },
          { label: 'Orca', value: current.orca.version ?? 'unknown' },
          { label: 'Inbox data', value: current.inbox.dataDir, code: true },
          { label: 'Projects', value: (current.projects ?? []).length > 0 ? (current.projects ?? []).join(', ') : 'All' },
          { label: 'Replies delivered', value: current.counts.delivered },
          { label: 'On the way', value: current.counts.inFlight },
          { label: 'Not delivered', value: current.counts.rejected ?? 0 }
        ]}
      />
    </Stack>
  )
}
