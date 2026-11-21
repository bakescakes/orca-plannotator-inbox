// Start, Stop, Resume and Open from the Inbox. Nothing here touches a real Orca or Inbox: Orca's CLI
// is a stand-in behind the real OrcaCli, bin/session.cjs is a stand-in runner (and, at the end, the
// real script against stand-in Orca files), and the Inbox is a stand-in fetch.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Lifecycle, LifecycleError, SESSION_HELPER, encoded, helperNative, inboxSource, type DeliveryVerdict, type NativeRun, type OwnedSession } from '../src/lifecycle'
import { OrcaCli, PromptKinds, parseLifecycleInventory } from '../src/orca-cli'
import { runHelper } from '../src/navigation'
import { fakeInbox, fakeLifecycleOrca, fakeNative, launchThread, memoryStore, personMessage, tempDir } from './fakes'

const LAUNCH = { id: 'launch_1', agent: 'codex', folder: '/work/project' }
const START = { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', ownerAction: true }

function setup(options: { projects?: string[] | null; launch?: Record<string, unknown> } = {}) {
  const orca = fakeLifecycleOrca()
  const native = fakeNative(orca)
  const inbox = fakeInbox()
  inbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', options.launch ?? LAUNCH))
  const store = memoryStore()
  const registered: OwnedSession[] = []
  const reveals: string[] = []
  const state = { verdict: 'queued' as DeliveryVerdict, projects: options.projects === undefined ? ([] as string[] | null) : options.projects, clock: 1_800_000_000_000 }
  let ids = 0
  const life = new Lifecycle({
    store,
    cli: () => new OrcaCli({ command: ['orca'], exec: orca.exec, env: {} }),
    source: () => inboxSource('/data', { fetch: inbox.fetch, readRegistry: inbox.readRegistry }),
    projects: () => state.projects,
    deliveryState: () => state.verdict,
    register: (owned) => void registered.push(owned),
    native: native.run as NativeRun,
    reveal: async (session) => {
      reveals.push(session)
      return { ok: true, sessionId: session, workspaceId: 'wt1' }
    },
    log: () => undefined,
    now: () => state.clock,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  })
  const action = (session: string, extra: Record<string, unknown> = {}) => ({ launchId: 'launch_1', session, ownerAction: true, actionId: `11111111-1111-4111-8111-${String(++ids).padStart(12, '0')}`, ...extra })
  return { orca, native, inbox, store, registered, reveals, state, life, action }
}

/** What the Orca build of Plannotator requires of `status?session=` before it acts on a chat. */
function ownedPerPlannotator(status: Record<string, unknown>, session: string, launchId?: string): boolean {
  const launches = status.ok === true && status.version === 1 && status.session === session && status.complete === true && Array.isArray(status.launches) ? status.launches : []
  const first = launches[0] as Record<string, unknown> | undefined
  return launches.length === 1 && first?.session === session && first?.state === 'created' && typeof first?.launchId === 'string' && (launchId === undefined || first.launchId === launchId)
}

test('a launch is recorded before Orca is asked, starts one chat, and a repeat replays it', async () => {
  const t = setup()
  let seenDuringLaunch: unknown = null
  const exec = t.orca.exec
  t.orca.exec = async (file, argv, options) => {
    if (argv[0] === 'agent') seenDuringLaunch = structuredClone(await t.store.get('lifecycle.v1'))
    return exec(file, argv, options)
  }
  const life = new Lifecycle({ ...(t.life as unknown as { deps: ConstructorParameters<typeof Lifecycle>[0] }).deps, cli: () => new OrcaCli({ command: ['orca'], exec: t.orca.exec, env: {} }) })
  const first = await life.handle('start', START)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.session, 'native_1')
  assert.equal(first.ref, first.session)
  assert.equal(first.initialDelivery, 'courier-pending')
  const recorded = Object.values((seenDuringLaunch as { launches: Record<string, { state: string; operation: string }> }).launches)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.state, 'in-flight')
  assert.equal(recorded[0]!.operation, first.operationId)
  const launch = t.orca.launches()[0]!
  assert.deepEqual(launch.slice(0, 8), ['agent', 'launch', '--agent', 'codex', '--worktree', 'id:wt1', '--surface', 'chat'])
  assert.equal(launch[launch.indexOf('--retry-launch') + 1], first.operationId)
  assert.match(String(first.operationId), /^\d{13}-[0-9a-f]{32}$/)
  assert.ok(!launch.includes('--prompt'))
  assert.deepEqual(t.native.actions().slice(0, 1), ['support'])

  const again = await life.handle('start', START)
  assert.equal(again.ok, true)
  assert.equal(again.replayed, true)
  assert.equal(again.session, 'native_1')
  assert.equal(t.orca.state.created, 1)
  assert.equal(t.orca.launches().length, 1)
  assert.equal(t.registered.length, 2)
  assert.equal(t.registered[0]!.session, 'native_1')
  assert.equal(t.registered[0]!.launchId, 'launch_1')
})

test('a new chat with no activity is proven by its own tab; the catalog shows it, then its activity', async () => {
  const t = setup()
  await t.life.handle('start', START)
  assert.equal(t.registered[0]!.proof, 'tab')
  assert.equal(t.registered[0]!.busy, null)
  const proof = t.native.state.calls.find((call) => call.action === 'session-proof')!
  assert.deepEqual(proof.body, { sessionId: 'native_1', agent: 'codex', worktree: 'id:wt1', workspaceId: 'wt1' })
  const catalog = await t.life.handle('catalog')
  assert.deepEqual((catalog.sessions as Record<string, unknown>).native_1, { busy: null, state: 'unknown', stopped: false, workspaceId: 'wt1' })

  t.orca.state.listed.set('native_1', { state: 'working', agentType: 'codex' })
  const before = t.native.state.calls.length
  const busy = await t.life.handle('catalog')
  assert.deepEqual((busy.sessions as Record<string, unknown>).native_1, { busy: true, state: 'working', stopped: false, workspaceId: 'wt1' })
  assert.equal(t.native.state.calls.length, before, 'a listed chat needs no tab proof')
})

test('the catalog says a launched chat waits on a permission, and nothing when it does not', async () => {
  const t = setup()
  // As the worker wires it: the prompt kinds reply delivery reads too.
  const life = new Lifecycle({ ...(t.life as unknown as { deps: ConstructorParameters<typeof Lifecycle>[0] }).deps, prompts: new PromptKinds(() => t.state.clock) })
  await life.handle('start', START)
  const row = async (): Promise<unknown> => ((await life.handle('catalog')).sessions as Record<string, unknown>).native_1
  t.orca.state.listed.set('native_1', { state: 'blocked', agentType: 'codex', mainAgent: { state: 'blocked' }, stateStartedAt: 1_700_000_000_000 })
  t.orca.state.entries.set('native_1', [{ kind: 'message', role: 'assistant', text: 'Next, the migration.' }, { kind: 'approval', text: 'Allow the migration? (private words)', pending: true }])
  assert.deepEqual(await row(), { busy: false, state: 'waiting', stopped: false, workspaceId: 'wt1', waiting: 'permission' })
  assert.ok(!JSON.stringify(await life.handle('catalog')).includes('private words'), 'the prompt’s words go nowhere')
  // Working, or done, it waits on nothing: the row is what it always was.
  t.orca.state.listed.set('native_1', { state: 'working', agentType: 'codex', mainAgent: { state: 'working' }, stateStartedAt: 1_700_000_060_000 })
  assert.deepEqual(await row(), { busy: true, state: 'working', stopped: false, workspaceId: 'wt1' })
  t.orca.state.listed.set('native_1', { state: 'done', agentType: 'codex', mainAgent: { state: 'done' }, stateStartedAt: 1_700_000_120_000 })
  assert.deepEqual(await row(), { busy: false, state: 'waiting', stopped: false, workspaceId: 'wt1' })
  // Without the prompt kinds (or an Orca CLI that cannot read a chat), a blocked chat's row is unchanged.
  t.orca.state.listed.set('native_1', { state: 'blocked', agentType: 'codex', mainAgent: { state: 'blocked' }, stateStartedAt: 1_700_000_180_000 })
  assert.deepEqual(((await t.life.handle('catalog')).sessions as Record<string, unknown>).native_1, { busy: false, state: 'waiting', stopped: false, workspaceId: 'wt1' })
})

test('a question is not offered as a permission', async () => {
  const t = setup()
  const life = new Lifecycle({ ...(t.life as unknown as { deps: ConstructorParameters<typeof Lifecycle>[0] }).deps, prompts: new PromptKinds(() => t.state.clock) })
  await life.handle('start', START)
  t.orca.state.listed.set('native_1', { state: 'blocked', agentType: 'codex', mainAgent: { state: 'blocked' }, stateStartedAt: 1_700_000_000_000 })
  t.orca.state.entries.set('native_1', [{ kind: 'question', text: 'Which branch? (private words)', pending: true }])
  assert.deepEqual(((await life.handle('catalog')).sessions as Record<string, unknown>).native_1, { busy: false, state: 'waiting', stopped: false, workspaceId: 'wt1' })
  // A question the chat's own turn asked (not a prompt in the chat) is not read and not offered either.
  t.orca.state.listed.set('native_1', { state: 'waiting', agentType: 'codex', mainAgent: { state: 'waiting' }, stateStartedAt: 1_700_000_060_000 })
  assert.deepEqual(((await life.handle('catalog')).sessions as Record<string, unknown>).native_1, { busy: false, state: 'waiting', stopped: false, workspaceId: 'wt1' })
  assert.equal(t.orca.state.calls.filter((args) => args[0] === 'agent' && args[1] === 'read').length, 1)
})

test('the catalog has the shape the Inbox reads: workspaces, providers, sessions and projects', async () => {
  const t = setup()
  const catalog = await t.life.handle('catalog')
  assert.equal(catalog.ok, true)
  assert.equal(catalog.version, 1)
  assert.deepEqual(catalog.workspaces, [{ folder: '/work/project', project: '/work/project', selector: 'id:wt1', workspaceId: 'wt1', workspaceKind: null, name: 'main' }, { folder: '/work/project-other', project: '/work/project', selector: 'id:wt2', workspaceId: 'wt2', workspaceKind: null, name: 'project-other' }])
  assert.deepEqual((catalog.providers as { id: string }[]).map((provider) => provider.id), ['codex', 'claude-code', 'opencode'])
  assert.deepEqual(catalog.projects, [{ root: '/work/project', name: 'Project' }])
  assert.deepEqual(catalog.sessions, {})
  assert.equal(t.orca.state.created, 0)
})

test('"Only these projects" limits where chats start and which projects are listed', async () => {
  const t = setup({ projects: ['/elsewhere'] })
  const catalog = await t.life.handle('catalog')
  assert.deepEqual(catalog.workspaces, [])
  assert.deepEqual(catalog.projects, [])
  await assert.rejects(t.life.handle('start', START), LifecycleError)
  t.state.projects = null // the setting names folders but none is usable
  assert.deepEqual((await t.life.handle('catalog')).workspaces, [])
  t.state.projects = ['/work']
  assert.equal(((await t.life.handle('catalog')).workspaces as unknown[]).length, 2)
  assert.equal((await t.life.handle('start', START)).ok, true)
})

test('only a person’s unchanged launch in an exact workspace can start a chat', async () => {
  const cases: [string, Record<string, unknown> | null, Record<string, unknown>][] = [
    ['another person-less author', { ...LAUNCH }, { author: { kind: 'agent', host: 'orca', session: 'x' } }],
    ['a deleted launch', { ...LAUNCH, deleted_at: '2026-01-01T00:00:00Z' }, {}],
    ['a scratch launch', { ...LAUNCH, scratch: true }, {}],
    ['another launch id', { ...LAUNCH, id: 'launch_other' }, {}],
    ['another agent', { ...LAUNCH, agent: 'claude-code' }, {}],
    ['another folder', { ...LAUNCH, folder: '/work/project-other' }, {}],
    ['a changed model', { ...LAUNCH, model: 'gpt-x' }, {}],
    ['no launch at all', null, {}]
  ]
  for (const [why, launch, override] of cases) {
    const t = setup()
    const thread = launchThread('thr_launch', '/work/project', launch ?? {}) as { thread: { messages: Record<string, unknown>[] } }
    if (launch === null) delete thread.thread.messages[0]!.launch
    Object.assign(thread.thread.messages[0]!, override)
    t.inbox.state.details.set('thr_launch', thread)
    await assert.rejects(t.life.handle('start', START), LifecycleError, why)
    assert.equal(t.orca.state.created, 0, why)
  }
  const t = setup()
  for (const body of [
    { ...START, ownerAction: false },
    { ...START, provider: 'gemini' },
    { ...START, provider: '__proto__' },
    { ...START, effort: 'high' },
    { ...START, model: 'bad model' },
    { ...START, launchId: 'a b' },
    { ...START, folder: 'relative/path' },
    { ...START, folder: '/work/nowhere' },
    { ...START, folder: '/work/archived' }
  ]) {
    await assert.rejects(t.life.handle('start', body), LifecycleError, JSON.stringify(body))
  }
  // A thread whose project does not hold the workspace.
  t.inbox.state.details.set('thr_launch', launchThread('thr_launch', '/somewhere/else', LAUNCH))
  await assert.rejects(t.life.handle('start', START), /does not hold that workspace/)
  assert.equal(t.orca.state.created, 0)
})

test('a person’s reply that starts a new agent owns its launch; an agent’s reply never does', async () => {
  const reply = { launchId: 'launch_2', threadId: 'thr_launch', messageId: 'msg_reply_1', provider: 'codex', folder: '/work/project', ownerAction: true }
  const launch = { id: 'launch_2', agent: 'codex', folder: '/work/project' }
  const t = setup()
  t.inbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', LAUNCH, [{ ...personMessage('msg_reply_1', 'thr_launch'), launch } as never]))
  const started = await t.life.handle('start', reply)
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(t.orca.state.created, 1)
  assert.equal(t.registered[0]?.messageId, 'msg_reply_1')

  const other = setup()
  other.inbox.state.details.set(
    'thr_launch',
    launchThread('thr_launch', '/work/project', LAUNCH, [{ ...personMessage('msg_reply_1', 'thr_launch', { author: { kind: 'agent', host: 'orca', session: 'x' } }), launch } as never])
  )
  await assert.rejects(other.life.handle('start', reply), /Only a launch a person made/)
  // A message of another thread is not found in this one.
  await assert.rejects(other.life.handle('start', { ...reply, messageId: 'msg_elsewhere' }), /missing or listed twice/)
  assert.equal(other.orca.state.created, 0)
})

test('a model and effort from the launch are passed to Orca, and refused when this Orca cannot take them', async () => {
  const t = setup({ launch: { ...LAUNCH, model: 'gpt-model', effort: 'low' } })
  const body = { ...START, model: 'gpt-model', effort: 'low' }
  assert.equal((await t.life.handle('start', body)).ok, true)
  const args = t.orca.launches()[0]!
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-model')
  assert.equal(args[args.indexOf('--effort') + 1], 'low')
  await assert.rejects(t.life.handle('start', { ...body, model: 'different' }), LifecycleError)
  assert.equal(t.orca.state.created, 1)

  const old = setup({ launch: { ...LAUNCH, model: 'gpt-model' } })
  old.native.state.answers.set('support', { ok: true, result: { supported: true, model: false, effort: false } })
  const refused = await old.life.handle('start', { ...START, model: 'gpt-model' })
  assert.equal(refused.ok, false)
  assert.match(String(refused.text), /chosen model/)
  assert.equal(old.orca.launches().length, 0)

  const none = setup()
  none.native.state.answers.set('support', { ok: false, reason: 'Orca lacks agent.launch.v2', started: true, code: 'unsupported' })
  const unsupported = await none.life.handle('start', START)
  assert.equal(unsupported.ok, false)
  assert.match(String(unsupported.text), /cannot start a chat from the Inbox \(Orca lacks agent\.launch\.v2\)/)
  assert.equal(none.orca.launches().length, 0)
  assert.equal(await none.store.get('lifecycle.v1'), null, 'nothing is recorded for a launch Orca cannot do')
})

test('a lost launch answer is never repeated as a new launch; Try again reconciles the same operation', async () => {
  const t = setup()
  t.orca.state.launchFault = 'lost'
  const first = await t.life.handle('start', START)
  assert.equal(first.ok, false)
  assert.equal(first.blocked, true)
  assert.match(String(first.text), /never started/)
  const plain = await t.life.handle('start', START)
  assert.equal(plain.blocked, true, 'a repeat without reconcile asks Orca nothing')
  assert.equal(t.orca.launches().length, 1)
  t.orca.state.launchFault = null
  const reconciled = await t.life.handle('start', { ...START, reconcile: true })
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled))
  assert.equal(reconciled.operationId, first.operationId)
  assert.equal(t.orca.state.created, 1)
  const [one, two] = t.orca.launches()
  assert.equal(one![one!.indexOf('--retry-launch') + 1], two![two!.indexOf('--retry-launch') + 1])
  assert.equal((await t.life.handle('start', { ...START, reconcile: true })).replayed, true)
  assert.equal(t.orca.state.created, 1)
})

test('a launch recorded but never sent (the worker stopped) is reconciled with its own operation id', async () => {
  const t = setup()
  t.store.data.set('lifecycle.v1', {
    launches: {
      [`${inboxSource('/data').key}:launch_1`]: {
        request: { launchId: 'launch_1', threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', project: '/work/project', selector: 'id:wt1', workspaceId: 'wt1', nativeAgent: 'codex' },
        operation: '1700000000000-0123456789abcdef0123456789abcdef',
        state: 'in-flight',
        result: { operationId: '1700000000000-0123456789abcdef0123456789abcdef' },
        updated: 1
      }
    },
    actions: {}
  })
  assert.equal((await t.life.handle('start', START)).blocked, true)
  const recovered = await t.life.handle('start', { ...START, reconcile: true })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.operationId, '1700000000000-0123456789abcdef0123456789abcdef')
  assert.equal(t.orca.launches().length, 1)
  assert.equal(t.native.actions().includes('support'), false, 'a recorded launch is not re-checked; it is reconciled')
})

test('a terminal (or another workspace) is kept as Orca made it and never taken for a chat', async () => {
  const t = setup()
  t.orca.state.launchFault = 'terminal'
  const first = await t.life.handle('start', START)
  assert.equal(first.ok, false)
  assert.equal(first.blocked, true)
  assert.deepEqual(await t.life.ownedSessions(), [])
  assert.equal((await t.life.handle('start', { ...START, reconcile: true })).blocked, true)
  assert.equal(t.orca.launches().length, 1)
})

test('one launch has one live attempt at a time', async () => {
  const t = setup()
  let release: (() => void) | null = null
  const exec = t.orca.exec
  t.orca.exec = async (file, argv, options) => {
    if (argv[0] === 'agent') await new Promise<void>((resolve) => (release = resolve))
    return exec(file, argv, options)
  }
  const life = new Lifecycle({ ...(t.life as unknown as { deps: ConstructorParameters<typeof Lifecycle>[0] }).deps, cli: () => new OrcaCli({ command: ['orca'], exec: t.orca.exec, env: {} }) })
  const first = life.handle('start', START)
  while (release === null) await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await life.handle('start', { ...START, reconcile: true })
  assert.equal(second.blocked, true)
  assert.equal(second.state, 'in-flight')
  ;(release as unknown as () => void)()
  assert.equal((await first).ok, true)
  assert.equal(t.orca.state.created, 1)
})

test('status names the one launch that owns a chat, in the shape the Inbox requires', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  const status = await t.life.handle('status', { session })
  assert.ok(ownedPerPlannotator(status, String(session), 'launch_1'), JSON.stringify(status))
  assert.deepEqual(status.launches, [{ launchId: 'launch_1', state: 'created', session }])
  const other = await t.life.handle('status', { session: 'never_owned' })
  assert.equal(ownedPerPlannotator(other, 'never_owned'), false)
  assert.deepEqual(other, { ok: true, version: 1, session: 'never_owned', complete: true, launches: [] })
  await assert.rejects(t.life.handle('status', { session: 'a b' }), LifecycleError)
  await assert.rejects(t.life.handle('status', { session: 'x', more: 1 }), LifecycleError)
  const recent = await t.life.handle('status', {})
  assert.deepEqual(recent.launches, [{ launchId: 'launch_1', state: 'created', session }])
})

test('a chat two launches name is not acted on, and status says the list is incomplete past two', async () => {
  const t = setup()
  const key = inboxSource('/data').key
  const row = (launchId: string) => ({
    request: { launchId, threadId: 'thr_launch', messageId: 'thr_launch', provider: 'codex', folder: '/work/project', project: '/work/project', selector: 'id:wt1', workspaceId: 'wt1', nativeAgent: 'codex' },
    operation: '1700000000000-0123456789abcdef0123456789abcdef',
    state: 'created',
    result: { session: 'shared_chat' },
    updated: 1
  })
  t.store.data.set('lifecycle.v1', { launches: { [`${key}:launch_1`]: row('launch_1'), [`${key}:launch_2`]: row('launch_2') }, actions: {} })
  t.orca.state.listed.set('shared_chat', { state: 'idle', agentType: 'codex' })
  const status = await t.life.handle('status', { session: 'shared_chat' })
  assert.equal(status.complete, true)
  assert.equal((status.launches as unknown[]).length, 2)
  assert.equal(ownedPerPlannotator(status, 'shared_chat'), false)
  await assert.rejects(t.life.handle('stop', t.action('shared_chat')), /More than one launch/)
  assert.equal(t.native.actions().length, 0)
  assert.equal(await t.life.deliveryAllowed('shared_chat', { id: 'msg_1', threadId: 'thr_launch' }), false)

  const three = setup()
  three.store.data.set('lifecycle.v1', { launches: { [`${key}:launch_1`]: row('launch_1'), [`${key}:launch_2`]: row('launch_2'), [`${key}:launch_3`]: row('launch_3') }, actions: {} })
  const incomplete = await three.life.handle('status', { session: 'shared_chat' })
  assert.equal(incomplete.complete, false)
  assert.equal((incomplete.launches as unknown[]).length, 2)
})

test('Stop prepares the exact request, records it, sends it once, and a repeat replays the result', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  t.orca.state.listed.set(String(session), { state: 'working', agentType: 'codex' })
  const stop = t.action(String(session))
  const first = await t.life.handle('stop', stop)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(t.native.actions().slice(-2), ['prepare-stop', 'stop'])
  const prepare = t.native.state.calls.at(-2)!
  assert.match(String(prepare.body.operationId), new RegExp(`^${t.state.clock}-[0-9a-f]{32}$`))
  assert.equal(String(prepare.body.operationId).slice(14), stop.actionId.replaceAll('-', ''))
  assert.deepEqual(t.native.state.calls.at(-1)!.body.prepared, { signature: { epoch: 'e1', fence: 1, liveCursor: null }, params: { envelope: { sessionId: session, clientOperationId: prepare.body.operationId, expectedRuntimeFence: 1, payloadFingerprint: 'f'.repeat(64) } } })
  const calls = t.native.state.calls.length
  assert.deepEqual(await t.life.handle('stop', stop), first)
  assert.equal(t.native.state.calls.length, calls, 'a repeated action id is never sent again')
  await assert.rejects(t.life.handle('stop', { ...stop, extra: 1 }), /already names another request/)
  await assert.rejects(t.life.handle('stop', { ...stop, actionId: 'not-a-uuid' }), /stable action id/)
  t.orca.state.listed.set(String(session), { state: 'idle', agentType: 'codex' })
  const catalog = await t.life.handle('catalog')
  assert.deepEqual((catalog.sessions as Record<string, unknown>)[String(session)], { busy: false, state: 'stopped', stopped: true, workspaceId: 'wt1' })
})

test('a Stop whose result is unknown is not repeated; one Orca cannot do says so and changes nothing', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  t.native.state.answers.set('stop', { ok: false, reason: 'the helper took too long', started: true, code: null })
  const unknown = t.action(String(session))
  const first = await t.life.handle('stop', unknown)
  assert.equal(first.ok, false)
  assert.equal(first.blocked, true)
  const sent = t.native.state.calls.filter((call) => call.action === 'stop').length
  assert.equal((await t.life.handle('stop', unknown)).blocked, true)
  assert.equal(t.native.state.calls.filter((call) => call.action === 'stop').length, sent)

  const old = setup()
  const { session: chat } = await old.life.handle('start', START)
  old.native.state.answers.set('prepare-stop', { ok: false, reason: 'Orca lacks agent-session.conversation-stop.v1', started: true, code: 'unsupported' })
  const refused = await old.life.handle('stop', old.action(String(chat)))
  assert.deepEqual(Object.keys(refused).sort(), ['ok', 'text'])
  assert.equal(refused.ok, false)
  assert.match(String(refused.text), /does not let the Inbox stop a chat/)
  assert.ok(!old.native.actions().includes('stop'))
  assert.equal((await old.life.handle('catalog')).sessions && ((await old.life.handle('catalog')).sessions as Record<string, { stopped: boolean }>)[String(chat)]!.stopped, false)

  // Orca refused the Stop itself: nothing stopped, so replies are not held.
  const refusing = setup()
  const { session: third } = await refusing.life.handle('start', START)
  refusing.native.state.answers.set('stop', { ok: false, reason: 'Orca refused agentSession.cancel (agent_session_fence_mismatch)', started: true, code: 'refused' })
  const no = await refusing.life.handle('stop', refusing.action(String(third)))
  assert.equal(no.ok, false)
  assert.match(String(no.text), /did not stop the chat/)
  assert.equal(await refusing.life.deliveryAllowed(String(third), { id: 'msg_any', threadId: 'thr_launch' }), true)
})

test('Stop, Resume and Open act only on a chat this exact launch owns', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  t.orca.state.listed.set(String(session), { state: 'idle', agentType: 'codex' })
  for (const name of ['stop', 'resume', 'open']) {
    await assert.rejects(t.life.handle(name, t.action(String(session), { launchId: 'launch_other' })), LifecycleError, name)
    await assert.rejects(t.life.handle(name, t.action('never_owned')), LifecycleError, name)
    await assert.rejects(t.life.handle(name, t.action(String(session), { ownerAction: false })), LifecycleError, name)
  }
  // The chat moved to another workspace: it is not this launch's any more.
  t.orca.state.listed.set(String(session), { state: 'idle', agentType: 'codex', workspaceId: 'wt2' })
  await assert.rejects(t.life.handle('stop', t.action(String(session))), /no longer in its workspace/)
  assert.ok(!t.native.actions().some((name) => ['prepare-stop', 'stop', 'continue'].includes(name)))
  assert.deepEqual(t.reveals, [])
})

test('a Stop holds older replies; a person’s new reply goes through and resumes the chat', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  const chat = String(session)
  assert.equal(await t.life.deliveryAllowed('never_owned', { id: 'msg_x', threadId: 'thr_launch' }), true, 'a chat no launch owns is not judged here')
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_x', threadId: 'thr_launch' }), true)
  assert.equal((await t.life.handle('stop', t.action(chat))).ok, true)
  const stoppedAt = t.state.clock
  t.inbox.state.details.set(
    'thr_launch',
    launchThread('thr_launch', '/work/project', LAUNCH, [
      personMessage('msg_old', 'thr_launch', { created_at: new Date(stoppedAt - 1000).toISOString() }),
      personMessage('msg_new', 'thr_launch', { created_at: new Date(stoppedAt + 1000).toISOString() })
    ])
  )
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_old', threadId: 'thr_launch' }), false)
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_missing', threadId: 'thr_launch' }), false)
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_new', threadId: 'thr_launch' }), true)
  const catalog = await t.life.handle('catalog')
  assert.equal((catalog.sessions as Record<string, { stopped: boolean }>)[chat]!.stopped, false)
  // The chat runs again, so the reply that was held goes along.
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_old', threadId: 'thr_launch' }), true)
  // A second Stop after it holds both again.
  t.state.clock = stoppedAt + 5000
  assert.equal((await t.life.handle('stop', t.action(chat))).ok, true)
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_new', threadId: 'thr_launch' }), false)
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_old', threadId: 'thr_launch' }), false)
})

test('Resume clears a Stop, starts nothing, and reports delivery truthfully', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  const chat = String(session)
  await t.life.handle('stop', t.action(chat))
  // A reply the person wrote before the Stop is held while the chat is stopped.
  t.inbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', LAUNCH, [personMessage('msg_held', 'thr_launch', { created_at: new Date(t.state.clock - 1000).toISOString() })]))
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_held', threadId: 'thr_launch' }), false)
  t.state.clock += 1000
  const resumed = await t.life.handle('resume', t.action(chat))
  assert.deepEqual(resumed, { ok: true, session: chat, retained: true, initialDelivery: 'courier-pending' })
  assert.equal(t.orca.state.created, 1)
  assert.equal(((await t.life.handle('catalog')).sessions as Record<string, { stopped: boolean }>)[chat]!.stopped, false)
  // The person pressed Resume: the held reply is delivered, as the Inbox now shows the chat running.
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_held', threadId: 'thr_launch' }), true)
  assert.deepEqual(await t.life.handle('resume', t.action(chat, { deliver: true })), { ok: true, session: chat, state: 'queued' })
  t.state.verdict = 'acknowledged'
  assert.deepEqual(await t.life.handle('resume', t.action(chat, { deliver: true })), { ok: true, session: chat, state: 'acknowledged' })
  t.state.verdict = 'unknown'
  const unknown = await t.life.handle('resume', t.action(chat, { deliver: true }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.state, 'unknown')
  assert.equal(typeof unknown.text, 'string')
  // Continuing an interrupted turn goes through Orca once per action id.
  const turn = t.action(chat, { turnItemId: 'turn_1' })
  assert.equal((await t.life.handle('resume', turn)).ok, true)
  assert.equal((await t.life.handle('resume', turn)).ok, true)
  assert.deepEqual(t.native.state.calls.filter((call) => call.action === 'continue').map((call) => call.body), [{ sessionId: chat, turnItemId: 'turn_1' }])
})

test('a launch is forgotten only after the person deleted it in the Inbox; the chat stays in Orca', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  const chat = String(session)
  await assert.rejects(t.life.handle('resume', t.action(chat, { removeAssociation: true })), /Only deleting the launch/)
  t.inbox.state.details.set('thr_launch', launchThread('thr_launch', '/work/project', { ...LAUNCH, deleted_at: '2026-01-01T00:00:00Z' }))
  assert.deepEqual(await t.life.handle('resume', t.action(chat, { removeAssociation: true })), { ok: true, retainedNativeHistory: true })
  assert.deepEqual(await t.life.ownedSessions(), [])
  assert.equal(ownedPerPlannotator(await t.life.handle('status', { session: chat }), chat), false)
  assert.equal(await t.life.deliveryAllowed(chat, { id: 'msg_x', threadId: 'thr_launch' }), false)
  assert.equal(t.orca.state.created, 1)
})

test('Open brings the owned chat forward, then its exact workspace', async () => {
  const t = setup()
  const { session } = await t.life.handle('start', START)
  const chat = String(session)
  // A new chat (no activity yet): its tab, then the workspace by its selector.
  assert.deepEqual(await t.life.handle('open', t.action(chat)), { ok: true, session: chat, opened: 'chat' })
  assert.deepEqual(t.orca.state.activated, ['id:wt1'])
  t.orca.state.listed.set(chat, { state: 'idle', agentType: 'codex' })
  assert.deepEqual(await t.life.handle('open', t.action(chat)), { ok: true, session: chat, opened: 'chat' })
  assert.deepEqual(t.reveals, [chat, chat])
  assert.deepEqual(t.orca.state.activated, ['id:wt1', 'id:wt1'])
})

test('an unreadable ownership record stops everything rather than starting a second chat', async () => {
  const t = setup()
  t.store.data.set('lifecycle.v1', { launches: { x: { nonsense: true } }, actions: {} })
  await assert.rejects(t.life.handle('start', START), /unknown entry/)
  await assert.rejects(t.life.handle('catalog'), /unknown entry/)
  assert.equal(t.orca.state.calls.length, 0)
  await assert.rejects(t.life.handle('nonsense'), /Unsupported/)
  await assert.rejects(t.life.handle('start', { pad: 'x'.repeat(9000) }), /Invalid lifecycle request/)
})

test('requests compare by content, whatever the key order', () => {
  assert.equal(encoded({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}')
  assert.equal(encoded({ a: undefined, b: null }), '{"b":null}')
})

test('worktree ps and repo list become workspaces and chats; a partial list is refused', () => {
  const inventory = parseLifecycleInventory(
    {
      worktrees: [
        { worktreeId: 'w1', repoId: 'r1', path: '/p', hostId: 'local', address: { environment: 'local', worktree: 'path:/p' }, agents: [{ paneKey: 'structured-agent-session-s1:00000000-0000-4000-8000-000000000000', state: 'working', agentType: 'claude' }] },
        { worktreeId: 'w2', repoId: 'r1', path: '/q', agents: [{ paneKey: 'structured-agent-session-s1:00000000-0000-4000-8000-000000000001', state: 'idle', agentType: 'claude' }] },
        { worktreeId: 'w3', repoId: 'r1', path: '/r', address: { environment: 'env-2', worktree: 'x' }, agents: [] },
        { worktreeId: 'w4', repoId: 'unknown', path: '/s', agents: [] }
      ]
    },
    { repos: [{ id: 'r1', path: '/p', displayName: '' }, { id: 'r2', path: '/ssh', connectionId: 'c1' }] }
  )
  assert.deepEqual(inventory.workspaces.map((row) => [row.workspaceId, row.selector]), [['w1', 'path:/p'], ['w2', 'id:w2']])
  assert.equal(inventory.sessions.size, 0, 'a chat listed twice is left out')
  assert.deepEqual(inventory.repos, [{ path: '/p', name: 'p' }])
  assert.throws(() => parseLifecycleInventory({ worktrees: [], truncated: true }, { repos: [] }), /only part/)
})

test('a bot’s home is never offered as a place to start a chat; a workspace only under a bot is', () => {
  const inventory = parseLifecycleInventory(
    {
      worktrees: [
        // As a real `worktree ps` lists a bot's home: a folder workspace in the "Bots" project group.
        { worktreeId: 'folder:home1', repoId: 'folder-workspace:group1', repo: 'Bots', workspaceKind: 'folder-workspace', path: '/bots/one', hostId: 'local', bot: 'Lighthouse Keeper', botHome: true, agents: [{ paneKey: 'structured-agent-session-b1:00000000-0000-4000-8000-000000000000', state: 'idle', agentType: 'claude' }] },
        // The same, should Orca ever list the group as a repository.
        { worktreeId: 'folder:home2', repoId: 'r1', workspaceKind: 'folder-workspace', path: '/bots/two', hostId: 'local', bot: 'Ferry', botHome: true, agents: [] },
        { worktreeId: 'w5', repoId: 'r1', path: '/p/taken', hostId: 'local', bot: 'Ferry', agents: [] }
      ]
    },
    { repos: [{ id: 'r1', path: '/p', displayName: 'p' }] }
  )
  assert.deepEqual(inventory.workspaces.map((row) => row.workspaceId), ['w5'])
  assert.deepEqual([...inventory.sessions.keys()], ['b1'], 'the bot’s chat itself is still known to Stop and Resume')
})

// ---------------------------------------------------------------------------------------------
// The real bin/session.cjs, against stand-in Orca files shaped like `app.asar.unpacked/out`.

async function fakeOrcaApp(behaviour: { capabilities?: string[]; cancel?: 'ok' | 'refuse' | 'lost'; fence?: number } = {}) {
  const out = join(await tempDir('orca-session-app-'), 'out')
  const log = join(out, 'calls.log')
  const dirs = ['cli/runtime', 'cli/specs', 'shared/rpc-contract/structured-agent-session', 'shared/rpc-contract/session-tabs', 'shared/agent-session/view', 'shared/agent-session/lifecycle/operations']
  for (const dir of dirs) await mkdir(join(out, dir), { recursive: true })
  const capabilities = behaviour.capabilities ?? [
    'agent-session.structured.v1',
    'agent.launch.v2',
    'agent.launch.replay-required.v1',
    'agent.launch.local-presentation.v1',
    'agent.launch.surface.v1',
    'agent-session.conversation-stop.v1',
    'agent-session.prompt-cancel.v1',
    'agent-session.repeated-stop.v1',
    'agent-session.continue-interrupted.v1'
  ]
  await writeFile(
    join(out, 'cli/runtime/client.js'),
    `'use strict'
const fs = require('node:fs')
class RuntimeClient {
  constructor(userDataPath, timeout, pairing, environment) { this.args = [userDataPath, timeout, pairing, environment] }
  get isRemote() { return this.args[2] !== null || this.args[3] !== null }
  async call(method, params) {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, params }) + '\\n')
    if (method === 'status.get') return { ok: true, result: { capabilities: ${JSON.stringify(capabilities)} } }
    if (method === 'agentSession.createSupport') return { ok: true, result: { supported: true } }
    if (method === 'session.tabs.list') return { ok: true, result: { worktree: 'wt1', tabs: [{ type: 'agent-session', sessionId: 's1', agent: 'codex' }] }, _meta: { runtimeId: 'rt1' } }
    if (method === 'agentSession.history') return { ok: true, result: { page: { sessionId: params.sessionId, epoch: 'e1', fence: ${behaviour.fence ?? 4}, liveCursor: 'c9' } } }
    if (method === 'agentSession.cancel') {
      if (${JSON.stringify(behaviour.cancel ?? 'ok')} === 'refuse') { const e = new Error('refused'); e.response = { ok: false, error: { code: 'agent_session_fence_mismatch' } }; throw e }
      if (${JSON.stringify(behaviour.cancel ?? 'ok')} === 'lost') throw new Error('socket hang up')
      return { ok: true, result: { ok: true } }
    }
    if (method === 'agentSession.continueInterrupted') return { ok: true, result: { ok: true, continued: true } }
    throw new Error('unexpected ' + method)
  }
}
exports.RuntimeClient = RuntimeClient
`
  )
  const schema = `{ safeParse: (value) => ({ success: true, data: value }) }`
  await writeFile(
    join(out, 'shared/rpc-contract/structured-agent-session/structured-agent-session-params.js'),
    `exports.CreateSupportParams = ${schema}; exports.HistoryParams = ${schema}; exports.CancelParams = ${schema}; exports.RevealParams = ${schema}\n`
  )
  await writeFile(join(out, 'shared/rpc-contract/structured-agent-session/structured-agent-session-continue-params.js'), `exports.ContinueInterruptedParams = ${schema}\n`)
  await writeFile(join(out, 'shared/rpc-contract/session-tabs/session-tabs-schemas-params.js'), `exports.WorktreeTabSelector = ${schema}\n`)
  await writeFile(
    join(out, 'shared/agent-session/view/structured-agent-session-projection.js'),
    `exports.structuredAgentSessionTabId = (s) => 'structured-agent-session-' + s
exports.structuredAgentSessionPaneKey = (tab, s) => tab + ':00000000-0000-4000-8000-000000000001'\n`
  )
  // The same canonical sha256 Orca computes.
  await writeFile(
    join(out, 'shared/agent-session/lifecycle/operations/structured-agent-session-mutation.js'),
    `const c = require('node:crypto')
exports.structuredAgentSessionPayloadFingerprint = (i) => c.createHash('sha256').update(JSON.stringify({ fields: i.fields, method: i.method, sessionId: i.sessionId })).digest('hex')\n`
  )
  await writeFile(join(out, 'cli/specs/agent-launch.js'), `exports.AGENT_LAUNCH_COMMAND_SPECS = [{ path: ['agent', 'launch'], allowedFlags: ['agent', 'worktree', 'model', 'effort', 'surface', 'retry-launch'] }]\n`)
  const calls = async (): Promise<{ method: string; params: Record<string, unknown> }[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { out, calls }
}

test('the real session helper checks capabilities, then asks for exactly the one operation', async () => {
  const app = await fakeOrcaApp()
  const cli = { launchInfo: () => ({ command: [process.execPath, join(app.out, 'cli', 'index.js')], env: { ...process.env } }) }
  const native = helperNative({ runtime: () => ({ executable: process.execPath, outDir: app.out }) })
  const run = (action: Parameters<NativeRun>[0], body: Record<string, unknown>) => native(action, body as never, cli as never)

  assert.deepEqual(await run('support', { agent: 'codex', worktree: 'id:wt1' }), { ok: true, result: { supported: true, model: true, effort: true } })
  const proof = await run('session-proof', { sessionId: 's1', agent: 'codex', worktree: 'id:wt1', workspaceId: 'wt1' })
  assert.deepEqual(proof, { ok: true, result: { sessionId: 's1', agent: 'codex', workspaceId: 'wt1', tabId: 'structured-agent-session-s1', pane: 'structured-agent-session-s1:00000000-0000-4000-8000-000000000001' } })
  const prepared = await run('prepare-stop', { sessionId: 's1', operationId: '1800000000000-0123456789abcdef0123456789abcdef' })
  assert.equal(prepared.ok, true)
  const envelope = (prepared as unknown as { result: { params: { envelope: Record<string, unknown> } } }).result.params.envelope
  assert.equal(envelope.expectedRuntimeFence, 4)
  assert.equal(envelope.clientOperationId, '1800000000000-0123456789abcdef0123456789abcdef')
  assert.match(String(envelope.payloadFingerprint), /^[0-9a-f]{64}$/)
  assert.ok(!(await app.calls()).some((call) => call.method === 'agentSession.cancel'), 'preparing sends nothing')
  const stopped = await run('stop', { sessionId: 's1', prepared: (prepared as { result: Record<string, unknown> }).result })
  assert.deepEqual(stopped, { ok: true, result: { ok: true } })
  const cancels = (await app.calls()).filter((call) => call.method === 'agentSession.cancel')
  assert.deepEqual(cancels.map((call) => call.params), [{ envelope }])
  assert.deepEqual(await run('continue', { sessionId: 's1', turnItemId: 'turn_1' }), { ok: true, result: { ok: true, continued: true } })

  // The chat moved on between preparing and sending: nothing is sent.
  const moved = await fakeOrcaApp({ fence: 5 })
  const movedNative = helperNative({ runtime: () => ({ executable: process.execPath, outDir: moved.out }) })
  const late = await movedNative('stop', { sessionId: 's1', prepared: (prepared as { result: Record<string, unknown> }).result } as never, cli as never)
  assert.equal(late.ok, false)
  assert.equal((late as { code: string }).code, 'changed')
  assert.ok(!(await moved.calls()).some((call) => call.method === 'agentSession.cancel'))

  // An Orca without Stop: unsupported, before anything but status.
  const old = await fakeOrcaApp({ capabilities: ['agent-session.structured.v1'] })
  const oldNative = helperNative({ runtime: () => ({ executable: process.execPath, outDir: old.out }) })
  const refused = await oldNative('prepare-stop', { sessionId: 's1', operationId: '1800000000000-0123456789abcdef0123456789abcdef' }, cli as never)
  assert.equal(refused.ok, false)
  assert.equal((refused as { code: string }).code, 'unsupported')
  assert.deepEqual((await old.calls()).map((call) => call.method), ['status.get'])

  // Orca answering the Stop with an error is a refusal; a lost answer is unknown.
  for (const [cancel, code] of [['refuse', 'refused'], ['lost', 'failed']] as const) {
    const other = await fakeOrcaApp({ cancel })
    const otherNative = helperNative({ runtime: () => ({ executable: process.execPath, outDir: other.out }) })
    const ready = await otherNative('prepare-stop', { sessionId: 's1', operationId: '1800000000000-0123456789abcdef0123456789abcdef' }, cli as never)
    const answer = await otherNative('stop', { sessionId: 's1', prepared: (ready as { result: Record<string, unknown> }).result } as never, cli as never)
    assert.equal((answer as { code: string }).code, code)
  }

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const bad = await runHelper(process.execPath, [SESSION_HELPER, app.out], { env, input: JSON.stringify({ action: 'shell', sessionId: 's1' }), timeoutMs: 10_000 })
  assert.equal(bad.code, 1)
  assert.match(JSON.parse(bad.stdout).error, /unsupported operation/)
})
