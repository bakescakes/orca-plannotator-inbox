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
  ],
  build: { mode: 'orca-build', version: '0.28.66', build: 'orca.1', latestKnown: { version: '0.28.66', build: 'orca.1' }, lastError: null, updating: false, phase: 'ready', detail: null },
  server: 'orca'
}

export default defineCheck({
  fresh: {},
  ready: { storage: { 'preview.status': ready } },
  // The Orca build is installed but the running Inbox is still standard Plannotator.
  restart: { storage: { 'preview.status': { ...ready, server: 'stock' } } },
  // An update did not work: the reason is shown, and the build in use stays.
  updateFailed: {
    storage: {
      'preview.status': {
        ...ready,
        build: {
          ...ready.build,
          latestKnown: { version: '0.28.67', build: 'orca.1' },
          lastError: 'The new build did not start, so Plannotator 0.28.66 (orca.1) is still in use.',
          phase: 'rolled-back'
        }
      }
    }
  },
  noBuild: {
    storage: {
      'preview.status': {
        ...ready,
        server: 'stock',
        build: { mode: 'stock', version: null, build: null, latestKnown: null, lastError: 'The list of Orca builds could not be read (no connection).', updating: false, phase: null, detail: null }
      }
    }
  },
  // Every agent Plannotator found: the plugin's own three, then the rest through Plannotator's connector.
  manyAgents: {
    storage: {
      'preview.status': {
        ...ready,
        agents: [
          ...ready.agents,
          { agent: 'opencode', name: 'OpenCode', state: 'connected', detail: 'New OpenCode chats in Orca reach the Inbox as Orca chats.' },
          { agent: 'gemini', name: 'Gemini CLI', state: 'connected', detail: 'Connected through this plugin’s launcher.' },
          { agent: 'qwen', name: 'Qwen Code', state: 'plannotator', detail: 'Runs Plannotator directly: messages arrive, but replies do not come back into Orca chats.' },
          { agent: 'cursor', name: 'Cursor', state: 'manual', detail: 'Add the server in Cursor’s MCP settings.' },
          { agent: 'amp', name: 'Amp', state: 'off', detail: 'Turned off in Plannotator’s Settings.' },
          { agent: 'pi', name: 'Pi', state: 'builtin', detail: 'Plannotator’s own plugin for Pi reaches the Inbox.' },
          { agent: 'kiro', name: 'Kiro', state: 'absent', detail: 'Not connected yet.' }
        ]
      }
    }
  },
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
  }
})
