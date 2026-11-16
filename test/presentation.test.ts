// Project pictures and agent faces (src/presentation.ts), against a fake of the stock Inbox's window
// routes at the fetch boundary. No real Inbox, no network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InboxClient } from '../src/inbox'
import { OrcaCli, parseRepoList, type OrcaRepo } from '../src/orca-cli'
import { MAX_ITEMS, MAX_PICTURE_BYTES, PresentationSync, picture, svgIsSafe, type PresentationChat } from '../src/presentation'
import { fakeInboxWindow, memoryStore } from './fakes'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])
const png = (bytes: Buffer = PNG) => ({ type: 'image', src: `data:image/png;base64,${bytes.toString('base64')}`, source: 'upload' })
const svg = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`

function setup() {
  const win = fakeInboxWindow()
  win.addProject('prj_test', '/project')
  const inbox = new InboxClient('/data/plannotator', { fetch: win.fetch, readRegistry: win.readRegistry })
  const store = memoryStore()
  const saves: string[] = []
  const set = store.set
  store.set = async (key, value) => {
    saves.push(key)
    return set(key, value)
  }
  const t = {
    win,
    inbox,
    store,
    saves,
    now: 0,
    repos: [{ path: '/project', displayName: 'project', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true }] as OrcaRepo[],
    realpaths: new Map<string, string>(),
    sync: null as unknown as PresentationSync,
    restart: () => {
      t.sync = new PresentationSync({
        inbox,
        repos: async () => t.repos,
        store,
        clock: () => t.now,
        realpath: async (path) => t.realpaths.get(path) ?? path
      })
    },
    record: async () => ((await store.get(PresentationSync.storeKey(inbox.key))) as { projects: Record<string, { status: string }> } | null)?.projects.prj_test ?? null,
    outcome: async (chats: PresentationChat[] = []) => {
      const report = await t.sync.tick(chats)
      assert.equal(report.ok, true, report.reason ?? '')
      return report.projects.find((p) => p.project === 'prj_test')?.outcome
    }
  }
  t.restart()
  return t
}

// test_project_upload_and_unchanged_no_writes_or_receipt_rewrite
test('a matching project gets its picture once, then stays unchanged with no writes', async () => {
  const t = setup()
  assert.equal(await t.outcome(), 'set')
  const [post] = t.win.writes()
  assert.equal(post!.path, '/api/inbox/projects/prj_test/picture')
  assert.equal(post!.body!.serverSession, 'boot-1')
  assert.match(String(post!.body!.picture), /^data:image\/svg\+xml;base64,/)
  // The window gate: no Origin, so stock's same-origin check passes as for any local program.
  assert.equal(post!.headers.origin, undefined)
  assert.equal(t.win.state.projects.get('prj_test')!.picture, 1001)

  t.saves.length = 0
  assert.equal(await t.outcome(), 'unchanged')
  assert.equal(t.win.writes().length, 1)
  assert.deepEqual(t.saves, [])
})

// test_owned_project_follows_new_native_icon
test('a picture this plugin set follows a new Orca icon', async () => {
  const t = setup()
  await t.outcome()
  t.repos[0]!.repoIcon = png()
  assert.equal(await t.outcome(), 'set')
  assert.equal(t.win.writes().length, 2)
  assert.deepEqual(Buffer.from(t.win.state.uploads.get('prj_test')!), PNG)
})

// test_initial_project_custom_picture_preserved
test('a picture the person set first is an override, kept even after they remove it', async () => {
  const t = setup()
  t.win.state.projects.get('prj_test')!.picture = 88
  assert.equal(await t.outcome(), 'override')
  delete t.win.state.projects.get('prj_test')!.picture
  assert.equal(await t.outcome(), 'override')
  assert.deepEqual(t.win.writes(), [])
})

// test_project_user_removal_and_later_upload_remain_preserved
test('a picture changed or removed by hand after ours becomes an override and stays one', async () => {
  for (const change of ['changed', 'removed'] as const) {
    const t = setup()
    await t.outcome()
    const project = t.win.state.projects.get('prj_test')!
    if (change === 'changed') project.picture = 5000
    else delete project.picture
    assert.equal(await t.outcome(), 'override', change)
    t.repos[0]!.repoIcon = png()
    project.picture = 6000
    assert.equal(await t.outcome(), 'override', change)
    assert.equal(t.win.writes().length, 1, change)
  }
})

// test_project_root_or_unknown_id_never_retargets
test('only a project whose root is exactly the repository’s real path is touched', async () => {
  const t = setup()
  t.repos = [
    { path: '/elsewhere', displayName: 'x', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/project/sub', displayName: 'y', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/project', displayName: 'remote', repoIcon: { type: 'emoji', emoji: '🎬' }, local: false }
  ]
  const report = await t.sync.tick()
  assert.deepEqual(report.projects.map((p) => p.outcome), ['skipped:no-inbox-project', 'skipped:no-inbox-project'])
  assert.deepEqual(t.win.writes(), [])

  // A symlink to the root is the same folder.
  t.repos = [{ path: '/link-to-project', displayName: 'p', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true }]
  t.realpaths.set('/link-to-project', '/project')
  assert.equal(await t.outcome(), 'set')
  // A root that cannot be resolved is skipped.
  t.realpaths.clear()
  t.sync = new PresentationSync({ inbox: t.inbox, repos: async () => t.repos, store: t.store, realpath: async () => Promise.reject(new Error('ENOENT')) })
  assert.equal((await t.sync.tick()).projects[0]!.outcome, 'skipped:root-missing')
})

test('combined, ambiguous and duplicate projects are left alone', async () => {
  const t = setup()
  t.win.addProject('prj_other', '/other', { merged_into: 'prj_test' })
  t.win.addProject('prj_twin_a', '/twin')
  t.win.addProject('prj_twin_b', '/twin')
  t.repos = [
    { path: '/other', displayName: null, repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/twin', displayName: null, repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/project', displayName: null, repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/project', displayName: null, repoIcon: { type: 'emoji', emoji: '⚠️' }, local: true }
  ]
  const report = await t.sync.tick()
  assert.deepEqual(report.projects.map((p) => p.outcome), ['skipped:combined', 'skipped:ambiguous-project', 'set', 'skipped:duplicate'])
  assert.equal(t.win.writes().length, 1)
})

// test_project_ambiguity_survives_restart_without_replay
test('a write whose answer was lost is never posted again; reading its bytes settles it', async () => {
  const t = setup()
  t.win.state.faultAfterSave = 'lost'
  assert.equal(await t.outcome(), 'unavailable')
  assert.equal((await t.record())!.status, 'pending')
  t.win.state.faultAfterSave = null
  t.restart()
  assert.equal(await t.outcome(), 'set')
  assert.equal(t.win.writes().length, 1)
  assert.ok(t.win.state.calls.some((call) => call.method === 'GET' && call.path === '/api/inbox/projects/prj_test/picture'))
  assert.equal((await t.record())!.status, 'owned')
  assert.equal(await t.outcome(), 'unchanged')
  assert.equal(t.win.writes().length, 1)
})

test('a lost write followed by the person’s own picture becomes an override', async () => {
  const t = setup()
  t.win.state.faultAfterSave = 'lost'
  await t.outcome()
  t.win.state.faultAfterSave = null
  t.win.state.uploads.set('prj_test', new Uint8Array(PNG))
  t.win.state.projects.get('prj_test')!.picture = 9999
  t.restart()
  assert.equal(await t.outcome(), 'override')
  assert.equal(t.win.writes().length, 1)
})

test('a pending first write with no picture now is the person’s to decide: override, no post', async () => {
  const t = setup()
  t.win.state.before = (method) => {
    if (method === 'POST') throw new Error('connection cut before the Inbox saw it')
  }
  assert.equal(await t.outcome(), 'unavailable')
  t.win.state.before = null
  assert.equal(await t.outcome(), 'override')
  assert.equal(await t.outcome(), 'override')
  assert.equal(t.win.state.uploads.size, 0)
})

test('a pending change that never landed over our own picture is recovered by reading, then retried', async () => {
  const t = setup()
  await t.outcome()
  t.repos[0]!.repoIcon = png()
  t.win.state.before = (method) => {
    if (method === 'POST') throw new Error('cut')
  }
  assert.equal(await t.outcome(), 'unavailable')
  t.win.state.before = null
  const posts = t.win.writes().length
  assert.equal(await t.outcome(), 'unchanged')
  assert.equal(t.win.writes().length, posts)
  assert.equal(await t.outcome(), 'set')
})

// test_project_rechecks_user_change_before_post
test('the project is read again just before the write; a change in between stops it', async () => {
  const t = setup()
  let reads = 0
  t.win.state.before = (method, path) => {
    if (method === 'GET' && path === '/api/inbox/projects' && ++reads === 2) t.win.state.projects.get('prj_test')!.picture = 700
  }
  assert.equal(await t.outcome(), 'skipped:changed')
  assert.deepEqual(t.win.writes(), [])
  t.win.state.before = null
  assert.equal(await t.outcome(), 'override')
  assert.deepEqual(t.win.writes(), [])
})

test('a restarted Inbox refuses the old serverSession (409): nothing saved, retried next pass', async () => {
  const t = setup()
  t.win.state.before = (method) => {
    if (method === 'POST') t.win.state.serverSession = 'boot-2'
  }
  assert.equal(await t.outcome(), 'skipped:inbox-restarted')
  assert.equal(await t.record(), null)
  assert.equal(t.win.state.uploads.size, 0)
  t.win.state.before = null
  assert.equal(await t.outcome(), 'set')
  assert.equal(t.win.writes().at(-1)!.body!.serverSession, 'boot-2')
})

test('a write is never sent when its intent cannot be saved first', async () => {
  const t = setup()
  t.store.set = async () => Promise.reject(new Error('disk full'))
  assert.equal(await t.outcome(), 'unavailable')
  assert.deepEqual(t.win.writes(), [])
})

// test_unknown_project_picture_marker_fails_closed
test('a picture marker in an unknown shape is left alone', async () => {
  const t = setup()
  t.win.state.projects.get('prj_test')!.picture = { newer: 1 }
  assert.equal(await t.outcome(), 'unavailable')
  assert.deepEqual(t.win.writes(), [])
})

test('a remote icon URL is never fetched, and a lucide icon is not drawn', async () => {
  const t = setup()
  for (const icon of [
    { type: 'image', src: 'https://avatars.githubusercontent.com/someone.png?size=64', source: 'github' },
    { type: 'image', src: 'https://www.google.com/s2/favicons?domain=example.com&sz=64', source: 'favicon' }
  ]) {
    t.repos[0]!.repoIcon = icon
    assert.equal(await t.outcome(), 'skipped:remote-image')
  }
  t.repos[0]!.repoIcon = { type: 'lucide', name: 'Rocket' }
  assert.equal(await t.outcome(), 'skipped:lucide-icon')
  t.repos[0]!.repoIcon = null
  assert.equal(await t.outcome(), 'skipped:no-icon')
  assert.deepEqual(t.win.state.foreign, [])
  assert.deepEqual(t.win.writes(), [])
})

// test_safe_emoji_is_escaped_and_network_paths_refused, test_image_and_batch_bounds
test('pictures: inline only, at most 512 KB, of the type their bytes prove', () => {
  const emoji = picture({ type: 'emoji', emoji: '<&🎬' })
  assert.ok(emoji.ok)
  assert.match(Buffer.from(emoji.picture.url.split(',')[1]!, 'base64').toString(), /&lt;&amp;🎬/)
  const ok = picture(png())
  assert.ok(ok.ok && ok.picture.type === 'image/png')

  const big = Buffer.concat([PNG, Buffer.alloc(MAX_PICTURE_BYTES)])
  const cases: Array<[unknown, string]> = [
    [{ type: 'image', src: `data:image/png;base64,${big.toString('base64')}` }, 'too-big'],
    [{ type: 'image', src: `data:image/jpeg;base64,${PNG.toString('base64')}` }, 'wrong-type'],
    [{ type: 'image', src: `data:image/png;base64,${Buffer.from('GIF89a....').toString('base64')}` }, 'wrong-type'],
    [{ type: 'image', src: `data:image/bmp;base64,${PNG.toString('base64')}` }, 'wrong-type'],
    [{ type: 'image', src: 'data:image/png;base64,not*base64' }, 'wrong-type'],
    [{ type: 'image', src: 'data:image/png;base64,' }, 'wrong-type'],
    [{ type: 'image', src: 'file:///etc/passwd' }, 'remote-image'],
    [{ type: 'image', src: '/tmp/a.png' }, 'remote-image'],
    [{ type: 'emoji', emoji: '' }, 'bad-emoji'],
    [{ type: 'emoji', emoji: 'x'.repeat(40) }, 'bad-emoji'],
    [{ type: 'emoji', emoji: 'a\u0007' }, 'bad-emoji'],
    [{ type: 'mystery' }, 'unknown-icon'],
    ['🎬', 'unknown-icon']
  ]
  for (const [icon, reason] of cases) {
    const result = picture(icon)
    assert.equal(result.ok, false, JSON.stringify(icon).slice(0, 80))
    assert.equal(!result.ok && result.reason, reason, JSON.stringify(icon).slice(0, 80))
  }
})

// test_svg_scripts_external_resources_and_entities_refused
test('SVG: scripts, external resources, styles, handlers and entities are refused', () => {
  const unsafe = [
    '<svg><script>alert(1)</script></svg>',
    '<svg><image href="https://example.com"/></svg>',
    '<svg><use xlink:href="#a"/></svg>',
    '<!DOCTYPE svg [<!ENTITY a "abc">]><svg>&a;</svg>',
    '<svg>&a;</svg>',
    '<svg onload="alert(1)"/>',
    '<svg><rect style="fill:red"/></svg>',
    '<svg><style>rect{}</style></svg>',
    '<svg><rect fill="url(https://example.com/x)"/></svg>',
    '<svg><rect fill="url(x)"/></svg>',
    '<svg><rect fill="&#x6A;avascript:alert(1)"/></svg>',
    '<svg><rect fill="//example.com/a"/></svg>',
    '<svg><foreignObject/></svg>',
    '<svg><a/></svg>',
    '<svg><![CDATA[x]]></svg>',
    '<svg><?php x ?></svg>',
    '<svg><rect a="1" a="2"/></svg>',
    '<svg></svg><svg></svg>',
    'text<svg></svg>',
    '<svg><g></svg>',
    '<svg><g>',
    '<rect/>',
    '<svg><!-- open',
    '<svg><rect fill=red/></svg>'
  ]
  for (const text of unsafe) {
    assert.equal(svgIsSafe(Buffer.from(text)), false, text)
    const result = picture({ type: 'image', src: svg(text) })
    assert.equal(!result.ok && result.reason, 'unsafe-svg', text)
  }
  assert.equal(svgIsSafe(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e])), false, 'not UTF-8')
  const safe =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- a mark -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
    '<title>A &amp; B</title><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
    '<g clip-path="url(#c)"><rect fill="url(#g)" width="24" height="24"/><text x="1">&#127916;</text></g></svg>\n'
  assert.equal(svgIsSafe(Buffer.from(safe)), true)
  assert.ok(picture({ type: 'image', src: svg(safe) }).ok)
})

// test_time_budget_defers_remaining_items_without_writes
test('a pass stops at its time budget; the rest wait, unwritten', async () => {
  const t = setup()
  t.win.addProject('prj_two', '/two')
  t.repos.push({ path: '/two', displayName: 'two', repoIcon: { type: 'emoji', emoji: '🎟️' }, local: true })
  t.win.state.before = (method) => {
    if (method === 'POST') t.now += 6000
  }
  const report = await t.sync.tick()
  assert.deepEqual(report.projects.map((p) => p.outcome), ['set', 'skipped:deferred'])
  assert.equal(t.win.writes().length, 1)
  assert.equal(report.tookMs, 6000)
})

test('a pass out of time before its first read reports that and writes nothing', async () => {
  const t = setup()
  t.sync = new PresentationSync({ inbox: t.inbox, repos: async () => ((t.now += 10_000), t.repos), store: t.store, clock: () => t.now })
  const report = await t.sync.tick()
  assert.equal(report.ok, false)
  assert.match(report.reason!, /out of time/)
  assert.deepEqual(t.win.writes(), [])
})

// test_image_and_batch_bounds (the batch half)
test('at most 200 items per pass, the chats’ own repositories first', async () => {
  const t = setup()
  const many = Array.from({ length: 250 }, (_, i) => ({ path: `/repo-${i}`, displayName: null, repoIcon: null, local: true }))
  t.repos = [...many, { path: '/project', displayName: 'project', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true }]
  let report = await t.sync.tick()
  assert.equal(report.projects.length, MAX_ITEMS)
  assert.equal(report.omitted, 51)
  assert.deepEqual(t.win.writes(), [])

  report = await t.sync.tick([{ session: 'chat_1', provider: 'claude', repoRoot: '/project' }])
  assert.equal(report.projects.length + report.agents.length, MAX_ITEMS)
  assert.equal(report.projects[0]!.outcome, 'set')
})

test('nothing escapes tick: every failure is a quiet report', async () => {
  const t = setup()
  t.win.state.up = false
  let report = await t.sync.tick()
  assert.equal(report.ok, false)
  assert.match(report.reason!, /not answering/)

  t.win.state.up = true
  t.sync = new PresentationSync({ inbox: t.inbox, repos: async () => Promise.reject(new Error('Orca is not reachable')), store: t.store })
  report = await t.sync.tick()
  assert.equal(report.ok, false)

  const broken = memoryStore()
  broken.get = async () => Promise.reject(new Error('storage gone'))
  t.sync = new PresentationSync({ inbox: t.inbox, repos: async () => t.repos, store: broken })
  assert.equal((await t.sync.tick()).ok, false)

  t.sync = new PresentationSync({ inbox: { key: 'k' } as never, repos: async () => t.repos, store: memoryStore() })
  assert.equal((await t.sync.tick(null as never)).ok, false)
  assert.deepEqual(t.win.writes(), [])
})

// test_corrupt_or_unsafe_state_fails_closed, test_private_durable_receipts_and_inbox_binding
test('an unreadable record, or one of another Inbox, stops the pass before any Inbox call', async () => {
  for (const saved of ['broken', { v: 1, inbox: 'another-inbox', projects: {} }, { v: 1, inbox: '', projects: { prj_test: { status: 'mystery', root: '/project' } } }]) {
    const t = setup()
    if (typeof saved === 'object' && saved.inbox === '') saved.inbox = t.inbox.key
    await t.store.set(PresentationSync.storeKey(t.inbox.key), saved as never)
    const report = await t.sync.tick()
    assert.equal(report.ok, false)
    assert.deepEqual(t.win.state.calls, [])
  }
})

test('two passes never overlap', async () => {
  const t = setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  t.sync = new PresentationSync({ inbox: t.inbox, repos: async () => (await gate, t.repos), store: t.store, clock: () => t.now })
  const first = t.sync.tick()
  assert.equal((await t.sync.tick()).reason, 'busy')
  release()
  assert.equal((await first).ok, true)
})

// test_agent_actual_provider_mark_native_api_and_host_unchanged, test_initial_custom_or_linked_agent_face_and_name_preserved
test('native chats keep their faces and names: stock has no provider mark a face can name', async () => {
  const t = setup()
  const chats = [
    { session: 'claude_1', provider: 'claude', repoRoot: '/project' },
    { session: 'codex_1', provider: 'codex', repoRoot: null },
    { session: 'opencode_1', provider: 'opencode', repoRoot: null },
    { session: 'codex_1', provider: 'codex', repoRoot: null },
    { session: 'not a session', provider: 'claude', repoRoot: null }
  ]
  const report = await t.sync.tick(chats)
  assert.deepEqual(
    report.agents.map((a) => `${a.session}:${a.outcome}`),
    ['claude_1:skipped:no-stock-mark', 'codex_1:skipped:no-stock-mark', 'opencode_1:skipped:no-stock-mark', 'codex_1:skipped:duplicate']
  )
  assert.equal(t.win.state.calls.some((call) => call.path.includes('agent-')), false)
  assert.equal(t.win.writes().every((call) => !('host' in call.body!) && !('face' in call.body!) && !('name' in call.body!)), true)
})

test('orca repo list: path and repoIcon come through; remote repositories are marked', async () => {
  const listed = {
    repos: [
      { id: 'r1', path: '/project', displayName: 'project', repoIcon: { type: 'emoji', emoji: '🎬' }, connectionId: null },
      { id: 'r2', path: '/remote', displayName: 'remote', repoIcon: null, connectionId: 'ssh-1' },
      { id: 'r3', path: '/runtime', displayName: 'rt', executionHostId: 'runtime:abc' },
      { id: 'r4', displayName: 'no path' }
    ]
  }
  assert.deepEqual(parseRepoList(listed), [
    { path: '/project', displayName: 'project', repoIcon: { type: 'emoji', emoji: '🎬' }, local: true },
    { path: '/remote', displayName: 'remote', repoIcon: null, local: false },
    { path: '/runtime', displayName: 'rt', repoIcon: null, local: false }
  ])
  assert.throws(() => parseRepoList({ repositories: [] }), /unknown shape/)

  const calls: string[][] = []
  const cli = new OrcaCli({
    command: ['orca'],
    exec: async (_file, args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ ok: true, result: listed }) }
    },
    env: {}
  })
  assert.equal((await cli.repoList()).length, 3)
  assert.deepEqual(calls[0], ['repo', 'list', '--environment', 'local', '--json'])
})
