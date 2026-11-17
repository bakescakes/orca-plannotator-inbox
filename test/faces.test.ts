// Agent icons: each Orca chat gets the mark of the agent it runs, only on the Orca build, and never
// over a face a person chose.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FaceSync, faceFor, type FaceEntry, type FacesInbox } from '../src/faces'
import { memoryStore } from './fakes'

function inbox(options: { features?: string[]; faces?: Record<string, FaceEntry>; serverSession?: string | null } = {}) {
  const faces: Record<string, FaceEntry> = { ...(options.faces ?? {}) }
  const sets: Array<{ agent: string; face: string; serverSession: string }> = []
  const api: FacesInbox = {
    orcaFeatures: async () => options.features ?? ['mark-faces'],
    agentFaces: async () => ({ serverSession: options.serverSession === undefined ? 'run-1' : options.serverSession, faces: structuredClone(faces) }),
    setAgentFace: async (agent, face, serverSession) => {
      sets.push({ agent, face, serverSession })
      faces[agent] = { face, sessions: [] }
    }
  }
  return { api, faces, sets }
}

test('every Orca agent id maps to a mark; ids that cannot name a host map to none', () => {
  assert.equal(faceFor('claude'), 'mark:claude-code')
  assert.equal(faceFor('codex'), 'mark:codex')
  assert.equal(faceFor('opencode2'), 'mark:opencode')
  assert.equal(faceFor('opencode'), 'mark:opencode')
  for (const id of ['pi', 'cursor', 'grok', 'antigravity', 'copilot', 'kimi', 'omp', 'gemini']) assert.equal(faceFor(id), `mark:${id}`)
  assert.equal(faceFor(null), null)
  assert.equal(faceFor('Bad Id'), null)
  assert.equal(faceFor('../x'), null)
})

test('each chat gets its agent’s mark once, with the run’s server session', async () => {
  const t = inbox()
  const sync = new FaceSync({ inbox: t.api, store: memoryStore() })
  const chats = [
    { agent: 'claude_1', session: 'claude_1', provider: 'claude' },
    { agent: 'launch-9', session: 'codex_2', provider: 'codex' },
    { agent: 'x_3', session: 'x_3', provider: null }
  ]
  assert.deepEqual(await sync.tick(chats), { ok: true, set: 2 })
  assert.deepEqual(t.sets, [
    { agent: 'claude_1', face: 'mark:claude-code', serverSession: 'run-1' },
    { agent: 'launch-9', face: 'mark:codex', serverSession: 'run-1' }
  ])
  assert.deepEqual(await sync.tick(chats), { ok: true, set: 0 }, 'nothing is written twice')
  assert.equal(t.sets.length, 2)
})

test('a face a person chose is kept, also when it is filed under another id of the same chat', async () => {
  const t = inbox({
    faces: {
      claude_1: { face: 'glass-blue', sessions: [] },
      'launch-9': { face: 'own:' + 'a'.repeat(64), sessions: ['codex_2'] }
    }
  })
  const sync = new FaceSync({ inbox: t.api, store: memoryStore() })
  const report = await sync.tick([
    { agent: 'claude_1', session: 'claude_1', provider: 'claude' },
    { agent: 'codex_2', session: 'codex_2', provider: 'codex' }
  ])
  assert.deepEqual(report, { ok: true, set: 0 })
  assert.deepEqual(t.sets, [])
})

test('when a person puts the agent’s own mark back, the plugin does not set its mark again', async () => {
  const t = inbox()
  const store = memoryStore()
  const sync = new FaceSync({ inbox: t.api, store })
  const chats = [{ agent: 'claude_1', session: 'claude_1', provider: 'claude' }]
  await sync.tick(chats)
  delete t.faces.claude_1 // "Agent" in the picker: the entry goes
  assert.deepEqual(await new FaceSync({ inbox: t.api, store }).tick(chats), { ok: true, set: 0 })
  assert.equal(t.sets.length, 1)
})

test('standard Plannotator is never sent a mark face', async () => {
  const t = inbox({ features: [] })
  const report = await new FaceSync({ inbox: t.api, store: memoryStore() }).tick([{ agent: 'claude_1', session: 'claude_1', provider: 'claude' }])
  assert.equal(report.set, 0)
  assert.deepEqual(t.sets, [])
})

test('a failure is reported, never thrown, and nothing is remembered as set', async () => {
  const t = inbox()
  t.api.setAgentFace = async () => {
    throw new Error('refused')
  }
  const store = memoryStore()
  const report = await new FaceSync({ inbox: t.api, store }).tick([{ agent: 'claude_1', session: 'claude_1', provider: 'claude' }])
  assert.deepEqual(report, { ok: false, set: 0, reason: 'refused' })
  assert.equal(await store.get('faces.v1'), null)
})
