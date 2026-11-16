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
