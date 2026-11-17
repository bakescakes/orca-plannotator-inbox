import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mockHost, mount } from 'orca/testing'
import * as panel from '../src/panel'
import type { Status } from '../src/protocol'

const READY: Status = {
  at: 1_700_000_000_000,
  phase: 'ready',
  headline: 'Ready',
  detail: null,
  inbox: { dataDir: '/Users/someone/.plannotator', version: '0.28.66', url: 'http://127.0.0.1:4999' },
  orca: { version: '1.4.261' },
  sessions: [{ session: 'claude_abc', title: 'Fix the importer', provider: 'claude', listening: true, note: null }],
  counts: { inFlight: 0, delivered: 12, blocked: 0 },
  blocked: [],
  agents: [
    { agent: 'claude', name: 'Claude Code', state: 'builtin', detail: 'Plannotator’s own Claude Code plugin is installed and already handles Orca chats.' },
    { agent: 'codex', name: 'Codex', state: 'absent', detail: 'Not connected yet.' }
  ]
}

test('shows what is connected and connects agents on request', async () => {
  let status = READY
  const connected: unknown[] = []
  const host = mockHost({
    requests: {
      'status.get': () => status,
      'agents.connect': (input) => {
        connected.push(input)
        return { ok: true, message: 'Codex is connected. It applies to chats started from now on.' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Ready' }))
  assert.ok(view.find({ type: 'ListItem', label: 'Fix the importer' }))
  assert.ok(view.find({ text: 'Not connected' }))
  assert.equal(view.find({ text: 'Disconnect' }), null)

  await view.press({ text: 'Connect agents' })
  assert.deepEqual(connected, [{}])
  assert.ok(view.find({ text: 'Codex is connected. It applies to chats started from now on.' }))

  // The worker posts the new state: nothing left to connect, so the button goes.
  status = { ...READY, agents: [READY.agents[0]!, { agent: 'codex', name: 'Codex', state: 'connected', detail: 'New Codex chats in Orca reach the Inbox as Orca chats.' }] }
  await view.post('status.changed', status)
  assert.equal(view.find({ text: 'Connect agents' }), null)
  assert.ok(view.find({ text: 'Disconnect' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('lists every agent, one row each, and offers Connect for one Plannotator runs directly', async () => {
  const agents: Status['agents'] = [
    { agent: 'claude', name: 'Claude Code', state: 'connected', detail: 'New Claude chats in Orca reach the Inbox as Orca chats.' },
    { agent: 'gemini', name: 'Gemini CLI', state: 'plannotator', detail: 'Connected by Plannotator. Replies come back into Orca chats once the Orca build runs the Inbox and you connect again.' },
    { agent: 'cursor', name: 'Cursor', state: 'manual', detail: 'Add the server in Cursor’s MCP settings.' },
    { agent: 'amp', name: 'Amp', state: 'off', detail: 'Turned off in Plannotator’s Settings.' }
  ]
  const disconnected: unknown[] = []
  const host = mockHost({
    requests: {
      'status.get': () => ({ ...READY, agents }),
      'agents.disconnect': (input) => {
        disconnected.push(input)
        return { ok: true, message: 'Disconnected Claude Code.' }
      }
    }
  })
  const view = await mount(panel, { host })
  for (const text of ['Gemini CLI', 'No replies to Orca', 'Cursor', 'By hand', 'Add the server in Cursor’s MCP settings.', 'Amp', 'Off']) assert.ok(view.find({ text }), text)
  assert.ok(view.find({ text: 'Connect agents' }), 'Gemini CLI can be connected through the launcher')
  await view.press({ text: 'Disconnect' })
  assert.deepEqual(disconnected, [{}])
  assert.ok(view.find({ text: 'Disconnected Claude Code.' }))

  // Only states Connect cannot change: no button.
  await view.post('status.changed', { ...READY, agents: agents.filter((agent) => agent.state === 'manual' || agent.state === 'off') })
  assert.equal(view.find({ text: 'Connect agents' }), null)
  assert.equal(view.find({ text: 'Disconnect' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a blocked reply can be sent again', async () => {
  const retried: unknown[] = []
  const host = mockHost({
    requests: {
      'status.get': () => ({
        ...READY,
        counts: { inFlight: 0, delivered: 12, blocked: 1 },
        blocked: [{ key: 'k1', subject: 'Ship it?', session: 'claude_abc', error: 'It is not known whether Orca received this reply, so it was not sent again.', updated: 1_700_000_000_000 }]
      }),
      'delivery.retry': (input) => {
        retried.push(input)
        return { ok: true, message: 'Sending it again.' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Ship it?' }))
  await view.press({ text: 'Send again' })
  assert.deepEqual(retried, [{ key: 'k1' }])
  assert.ok(view.find({ text: 'Sending it again.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('says why when delivery is not possible', async () => {
  const host = mockHost({
    requests: {
      'status.get': () => ({ ...READY, phase: 'no-plannotator', headline: 'Plannotator Inbox not found', detail: 'The Plannotator Inbox has not run on this computer yet.', sessions: [], inbox: { ...READY.inbox, version: null } })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Plannotator Inbox not found' }))
  assert.ok(view.find({ text: 'The Plannotator Inbox has not run on this computer yet.' }))
  assert.ok(view.find({ type: 'EmptyState', label: 'No chats yet' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a release with no Orca build yet is a wait, a real failure is a warning, and a reduced build says what it lacks', async () => {
  const build: NonNullable<Status['build']> = {
    mode: 'orca-build',
    version: '0.28.66',
    build: 'orca.1',
    latestKnown: { version: '0.28.66', build: 'orca.1' },
    lastError: null,
    updating: false,
    phase: 'ready',
    detail: null,
    waiting: { version: '0.28.67', since: 1_700_000_000_000 },
    reduced: null
  }
  let status: Status = { ...READY, build, server: 'orca' }
  const host = mockHost({ requests: { 'status.get': () => status } })
  const view = await mount(panel, { host })
  const waiting = 'Plannotator 0.28.67 is out. Its Orca build is not published yet; the Orca build of 0.28.66 stays in use and updates by itself when it is.'
  assert.ok(view.find({ text: waiting }))
  assert.ok(view.find({ text: 'Installed' }))
  assert.equal(view.find({ type: 'Callout' }), null, 'waiting is not a warning')

  // The Plannotator installed here in use while its Orca build is not published.
  await view.post('status.changed', { ...status, build: { ...build, mode: 'stock', version: null, build: null } })
  assert.ok(view.find({ text: 'Plannotator 0.28.67 is in use. Its Orca build is not published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are missing until it is; the Inbox moves to it by itself.' }))
  assert.equal(view.find({ type: 'Callout' }), null)

  // Its build is published and could not be used: the updater's own sentence says why.
  const unused = 'Plannotator 0.28.67 is in use without its Orca additions. The downloaded Plannotator 0.28.67 failed to start (exit 1), so it was not used. The plugin tries again by itself.'
  await view.post('status.changed', { ...status, build: { ...build, mode: 'stock', version: null, build: null, detail: unused } })
  assert.ok(view.find({ text: unused }))

  // A real failure is still one.
  const failure = 'The download does not match the checksum the release lists, so it was not used. The Orca build of Plannotator 0.28.66 stays in use.'
  await view.post('status.changed', { ...status, build: { ...build, waiting: null, lastError: failure } })
  assert.ok(view.find({ type: 'Callout', text: failure }) ?? view.find({ text: failure }))
  assert.equal(view.find({ text: waiting }), null)

  // A reduced build of 0.28.67, then the full one.
  const reduced = { ...build, version: '0.28.67', waiting: null, reduced: { lacks: ['per-agent icons', 'starting and stopping chats from the Inbox'], omitted: ['mark-faces', 'launch-hosts'] } }
  status = { ...status, build: reduced }
  await view.post('status.changed', status)
  assert.ok(view.find({ text: 'This build lacks per-agent icons and starting and stopping chats from the Inbox. The full build installs by itself when it is published.' }))
  await view.post('status.changed', { ...status, build: { ...reduced, build: 'orca.2', reduced: null } })
  assert.equal(view.find({ text: /This build lacks/ }), null)
  assert.ok(view.find({ text: 'Plannotator 0.28.67 (orca.2)' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
