// `orca plugin check` renders the panel once per scenario with the real worker on a mock host.
// Under the test kit the worker never touches the machine; it shows the status stored here.
import { defineCheck } from 'orca/testing'
import type { Status } from './protocol'

const ready: Status = {
  at: 1_700_000_000_000,
  phase: 'ready',
  headline: 'Ready',
  detail: null,
  inbox: { dataDir: '~/.plannotator', version: '0.28.66', url: 'http://127.0.0.1:19432' },
  orca: { version: '1.4.261' },
  sessions: [
    { session: 'claude_1b491d4a', title: 'Fix the importer', provider: 'claude', listening: true, note: null },
    { session: 'codex_77c0d2aa', title: 'Release notes', provider: 'codex', listening: true, note: null }
  ],
  counts: { inFlight: 1, delivered: 42, blocked: 0 },
  blocked: [],
  agents: [
    { agent: 'claude', name: 'Claude Code', state: 'connected', detail: 'New Claude chats in Orca reach the Inbox as Orca chats.' },
    { agent: 'codex', name: 'Codex', state: 'absent', detail: 'Not connected yet.' }
  ]
}

export default defineCheck({
  fresh: {},
  ready: { storage: { 'preview.status': ready } },
  blocked: {
    storage: {
      'preview.status': {
        ...ready,
        counts: { inFlight: 0, delivered: 42, blocked: 1 },
        blocked: [
          { key: 'k1', subject: 'Ship the importer?', session: 'claude_1b491d4a', error: 'It is not known whether Orca received this reply, so it was not sent again.', updated: 1_700_000_000_000 }
        ]
      }
    }
  },
  standby: {
    storage: {
      'preview.status': { ...ready, phase: 'standby', headline: 'Standing by', detail: 'Another adapter already delivers replies for this Inbox.', sessions: [] }
    }
  }
})
