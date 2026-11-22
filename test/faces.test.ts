// Agent icons: each Orca chat gets the mark of the agent it runs, only on the Orca build, and never
// over a face a person chose.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { FaceSync, faceFor, type FaceEntry, type FacesAvatars, type FacesInbox } from '../src/faces'
import { InboxRefused } from '../src/inbox'
import type { PictureResult } from '../src/presentation'
import { memoryStore } from './fakes'

function inbox(options: { features?: string[]; faces?: Record<string, FaceEntry>; serverSession?: string | null; icons?: boolean } = {}) {
  const faces: Record<string, FaceEntry> = { ...(options.faces ?? {}) }
  const sets: Array<{ agent: string; face: string; serverSession: string }> = []
  /** Every picture kept for agents, as its data URL, in order. */
  const icons: string[] = []
  const api: FacesInbox = {
    orcaFeatures: async () => options.features ?? ['mark-faces'],
    agentFaces: async () => ({ serverSession: options.serverSession === undefined ? 'run-1' : options.serverSession, faces: structuredClone(faces) }),
    setAgentFace: async (agent, face, serverSession) => {
      sets.push({ agent, face, serverSession })
      faces[agent] = { face, sessions: [] }
    },
    keepAgentPicture: async (picture) => {
      // An Inbox from before pictures for agents answers the route as unknown.
      if (options.icons === false) throw new InboxRefused(404, 'The Inbox refused /api/inbox/agent-icons: not_found')
      icons.push(picture)
      return digestOf(picture)
    }
  }
  return { api, faces, sets, icons }
}

function digestOf(url: string): string {
  return createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).digest('hex')
}

/** A bot's picture as Orca has it now, by the bot's name (invented SVGs); a name not here has none. */
function avatars(pictures: Record<string, string | null>) {
  const reads: string[] = []
  const api: FacesAvatars = {
    picture: async (bot): Promise<PictureResult> => {
      reads.push(bot.name)
      const svg = pictures[bot.name]
      if (!svg) return { ok: false, reason: 'no-mascots' }
      const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      return { ok: true, picture: { url, digest: digestOf(url), type: 'image/svg+xml' } }
    }
  }
  return { api, pictures, reads }
}

const HARBOR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456"/></svg>'
const LANTERN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#abcdef"/></svg>'
const own = (svg: string) => `own:${createHash('sha256').update(svg).digest('hex')}`

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

test('a bot’s chat shows the bot’s own picture; two bots of one agent differ, and an ordinary chat keeps its mark', async () => {
  const t = inbox()
  const a = avatars({ Harbor: HARBOR, Lantern: LANTERN })
  const sync = new FaceSync({ inbox: t.api, store: memoryStore(), avatars: a.api })
  const chats = [
    { agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } },
    { agent: 'claude_l', session: 'claude_l', provider: 'claude', bot: { name: 'Lantern', home: '/bots/lantern' } },
    { agent: 'claude_p', session: 'claude_p', provider: 'claude', bot: null }
  ]
  assert.deepEqual(await sync.tick(chats), { ok: true, set: 3 })
  assert.deepEqual(t.sets, [
    { agent: 'claude_h', face: own(HARBOR), serverSession: 'run-1' },
    { agent: 'claude_l', face: own(LANTERN), serverSession: 'run-1' },
    { agent: 'claude_p', face: 'mark:claude-code', serverSession: 'run-1' }
  ])
  assert.equal(t.icons.length, 2, 'each picture is given to the Inbox before a face names it')
  assert.deepEqual(a.reads, ['Harbor', 'Lantern'], 'only the bots’ chats are read for a picture')
  assert.deepEqual(await sync.tick(chats), { ok: true, set: 0 }, 'nothing is written twice')
  assert.equal(t.icons.length, 2)
})

test('a bot’s new picture in Orca replaces the one this plugin set, and a face a person chose stays', async () => {
  const t = inbox()
  const a = avatars({ Harbor: HARBOR, Lantern: LANTERN })
  const store = memoryStore()
  const chats = [
    { agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } },
    { agent: 'claude_l', session: 'claude_l', provider: 'claude', bot: { name: 'Lantern', home: '/bots/lantern' } }
  ]
  await new FaceSync({ inbox: t.api, store, avatars: a.api }).tick(chats)
  t.faces.claude_l = { face: 'glass-teal', sessions: [] } // the person's own choice in the picker
  a.pictures.Harbor = LANTERN
  a.pictures.Lantern = HARBOR
  assert.deepEqual(await new FaceSync({ inbox: t.api, store, avatars: a.api }).tick(chats), { ok: true, set: 1 })
  assert.deepEqual(t.sets.at(-1), { agent: 'claude_h', face: own(LANTERN), serverSession: 'run-1' })
  assert.equal(t.faces.claude_l?.face, 'glass-teal')
})

test('a bot’s chat whose picture cannot be shown, or that is no longer a bot’s, has its agent’s mark', async () => {
  const t = inbox()
  const a = avatars({ Harbor: HARBOR })
  const store = memoryStore()
  const sync = new FaceSync({ inbox: t.api, store, avatars: a.api })
  const harbor = { agent: 'codex_h', session: 'codex_h', provider: 'codex', bot: { name: 'Harbor', home: '/bots/harbor' } }
  const unread = { agent: 'claude_u', session: 'claude_u', provider: 'claude', bot: { name: 'Unread', home: '/bots/unread' } }
  await sync.tick([harbor, unread])
  assert.equal(t.faces.claude_u?.face, 'mark:claude-code')
  assert.equal(t.faces.codex_h?.face, own(HARBOR))
  // The bot is removed in Orca: its chat is no longer in a bot's home.
  await sync.tick([{ ...harbor, bot: null }])
  assert.equal(t.faces.codex_h?.face, 'mark:codex')
})

test('an Inbox that keeps no pictures for agents gives a bot’s chat its agent’s mark', async () => {
  const t = inbox({ icons: false })
  const sync = new FaceSync({ inbox: t.api, store: memoryStore(), avatars: avatars({ Harbor: HARBOR }).api })
  assert.deepEqual(await sync.tick([{ agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } }]), { ok: true, set: 1 })
  assert.deepEqual(t.sets, [{ agent: 'claude_h', face: 'mark:claude-code', serverSession: 'run-1' }])
})

test('standard Plannotator is sent no bot picture, and no bot’s files are read for it', async () => {
  const t = inbox({ features: [] })
  const a = avatars({ Harbor: HARBOR })
  const report = await new FaceSync({ inbox: t.api, store: memoryStore(), avatars: a.api }).tick([{ agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } }])
  assert.equal(report.set, 0)
  assert.deepEqual([t.sets, t.icons, a.reads], [[], [], []])
})

test('an Inbox that restarted under the pass is not given the agent’s mark instead; the next pass tries again', async () => {
  const t = inbox()
  t.api.keepAgentPicture = async () => {
    throw new InboxRefused(409, 'The Inbox refused /api/inbox/agent-icons: session_mismatch')
  }
  const report = await new FaceSync({ inbox: t.api, store: memoryStore(), avatars: avatars({ Harbor: HARBOR }).api }).tick([
    { agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } }
  ])
  assert.equal(report.ok, false)
  assert.deepEqual(t.sets, [])
})

test('a person’s “Agent” stays when the bot’s picture changes, or cannot be read and the mark would do', async () => {
  const t = inbox()
  const a = avatars({ Harbor: HARBOR, Lantern: LANTERN })
  const store = memoryStore()
  const harbor = { agent: 'claude_h', session: 'claude_h', provider: 'claude', bot: { name: 'Harbor', home: '/bots/harbor' } }
  const lantern = { agent: 'claude_l', session: 'claude_l', provider: 'claude', bot: { name: 'Lantern', home: '/bots/lantern' } }
  await new FaceSync({ inbox: t.api, store, avatars: a.api }).tick([harbor, lantern])
  assert.equal(t.sets.length, 2)
  // "Agent" in the picker: an unnamed agent's entry goes; a named one keeps `agent` beside its name.
  delete t.faces.claude_h
  t.faces.claude_l = { face: 'agent', sessions: [] }
  a.pictures.Harbor = LANTERN
  a.pictures.Lantern = null
  assert.deepEqual(await new FaceSync({ inbox: t.api, store, avatars: a.api }).tick([harbor, lantern]), { ok: true, set: 0 })
  assert.equal(t.sets.length, 2)
  assert.equal(t.faces.claude_h, undefined)
  assert.equal(t.faces.claude_l?.face, 'agent')
})

test('a chat named before this plugin set it a face gets one; so does one this plugin has forgotten', async () => {
  const t = inbox({ faces: { claude_n: { face: 'agent', sessions: [] } } })
  const store = memoryStore()
  await store.set('faces.v1', { v: 1, set: { claude_x: 'mark:codex' } })
  const report = await new FaceSync({ inbox: t.api, store }).tick([
    { agent: 'claude_n', session: 'claude_n', provider: 'claude' },
    { agent: 'claude_f', session: 'claude_f', provider: 'claude' }
  ])
  assert.deepEqual(report, { ok: true, set: 2 })
  assert.deepEqual(t.sets.map((item) => [item.agent, item.face]), [['claude_n', 'mark:claude-code'], ['claude_f', 'mark:claude-code']])
})

test('what this plugin set is kept to a bound, forgetting old chats first and never one Orca has now', async () => {
  const t = inbox()
  const store = memoryStore()
  // A live chat set long ago (the oldest entry), whose person since chose "Agent", then 500 chats that are gone.
  const old: Record<string, string> = { claude_live: 'mark:claude-code' }
  for (let i = 0; i < 500; i++) old[`gone_${i}`] = 'mark:codex'
  await store.set('faces.v1', { v: 1, set: old })
  const live = { agent: 'claude_live', session: 'claude_live', provider: 'claude' }
  assert.deepEqual(await new FaceSync({ inbox: t.api, store }).tick([live, { agent: 'claude_new', session: 'claude_new', provider: 'claude' }]), { ok: true, set: 1 })
  const saved = (await store.get('faces.v1')) as { set: Record<string, string> }
  const agents = Object.keys(saved.set)
  assert.equal(agents.length, 500)
  assert.ok(agents.includes('claude_live') && agents.includes('claude_new'))
  assert.ok(!agents.includes('gone_0') && !agents.includes('gone_1') && agents.includes('gone_2'))
  // The live chat's reset still holds.
  assert.deepEqual(await new FaceSync({ inbox: t.api, store }).tick([live]), { ok: true, set: 0 })
  assert.deepEqual(t.sets.map((item) => item.agent), ['claude_new'])
})
