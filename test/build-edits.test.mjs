// The Orca build's edits (plannotator/edits.mjs): each edit finds its line by content and fails closed. Small invented
// sources stand in for Plannotator's files; the last tests run build.mjs itself on a throwaway folder.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyEdit, applyGroup, applyGroups, editedLines, fileText, openFile, parseEdits, refusalOf } from '../plannotator/edits.mjs'
import { KEY, TARGETS, assetOf, mainVerdict, manifest, verdict } from '../plannotator/release.mjs'

const BUILD = fileURLToPath(new URL('../plannotator/build.mjs', import.meta.url))
const RECIPE = JSON.parse(readFileSync(fileURLToPath(new URL('../plannotator/recipe.json', import.meta.url)), 'utf8'))

const apply = (text, edit) => {
  const doc = openFile(text)
  applyEdit(doc, edit)
  return fileText(doc)
}
const SOURCE = [
  'export function start(launch) {',
  '  const result = await host.start(launch, { name, login });',
  '  if (result.ok) store.settle(root.id, { to: { host: launch.agent, session: result.session } });',
  '  return result;',
  '}',
  ''
].join('\n')
const ROUTE = { id: 'route', file: 'a.ts', anchor: 'to: { host: launch.agent, session: result.session }', replace: [['host: launch.agent', 'host: host.routeHost ?? launch.agent']] }
const GUARD = { id: 'guard', file: 'a.ts', anchor: 'export function start(', after: ['  if (orcaMode()) return null;'] }

test('a token is replaced inside its line, and lines go in at the anchor’s indentation', () => {
  const out = apply(apply(SOURCE, ROUTE), GUARD)
  assert.match(out, /\{ to: \{ host: host\.routeHost \?\? launch\.agent, session: result\.session \} \}\);/)
  assert.equal(out.split('\n')[1], '  if (orcaMode()) return null;')
  const nested = apply('class A {\n    store() {\n      run();\n    }\n}\n', { id: 'x', file: 'a.ts', anchor: 'run();', before: ['check();', '  // and then'] })
  assert.equal(nested, 'class A {\n    store() {\n      check();\n        // and then\n      run();\n    }\n}\n')
})

test('an indentation change does not stop an edit', () => {
  // As upstream did in 0.29.2: one list wrapped in a call, every line of it two spaces further in.
  const moved = SOURCE.replace('  if (result.ok)', '    if (result.ok)')
  assert.match(apply(moved, ROUTE), /^ {4}if \(result\.ok\) store\.settle\(root\.id, \{ to: \{ host: host\.routeHost \?\? launch\.agent/m)
  assert.equal(apply('\t\tconst x = [\n'.replace('[', 'f(['), { id: 'y', file: 'a.ts', anchor: 'const x = f([', after: ['g();'] }), '\t\tconst x = f([\n\t\tg();\n')
})

test('text added elsewhere on the line does not stop an edit', () => {
  // As upstream did in 0.29.1: more at the end of the line, and the call wrapped in another expression.
  const grown = SOURCE.replace(' } });', ' }, session_ref: result.ref, ...(rex ? { rex } : {}) });').replace('const result = await host.start(', 'const result = viaRex ?? (await host.start(').replace('{ name, login });', '{ name, login }));')
  const out = apply(apply(grown, ROUTE), { id: 'source', file: 'a.ts', anchor: 'host.start(launch, { name, login }', replace: [['{ name, login }', '{ name, login, reconcile: again }']] })
  assert.match(out, /viaRex \?\? \(await host\.start\(launch, \{ name, login, reconcile: again \}\)\);/)
  assert.match(out, /host: host\.routeHost \?\? launch\.agent, session: result\.session \}, session_ref: result\.ref, \.\.\.\(rex \? \{ rex \} : \{\}\) \}\);/)
})

test('a missing anchor, an anchor on two lines, or a token not once on the line is refused with what was found', () => {
  assert.match(refusalOf(SOURCE.replace('launch.agent', 'launch.provider'), ROUTE), /anchor "to: \{ host: launch\.agent, session: result\.session \}" is on no line, expected 1/)
  const twice = SOURCE.replace('  return result;', '  if (again) store.settle(root.id, { to: { host: launch.agent, session: result.session } });')
  assert.match(refusalOf(twice, ROUTE), /is on 2 lines, expected 1/)
  assert.equal(refusalOf(twice, { ...ROUTE, count: 2 }), null, 'two lines, when two are expected')
  assert.match(refusalOf(SOURCE, { ...ROUTE, anchor: 'store.settle(', replace: [['result', 'outcome']] }), /"result" is twice on the line/)
  assert.match(refusalOf(SOURCE, { ...GUARD, anchor: ['export function start(', 'never there'] }), /"never there" is not within 40 lines after/)
})

test('a change in meaning is refused, not applied: the line must still have what the edit relies on', () => {
  // As in 0.29.1: the inserted line passes `children`, which only a signature that takes them has.
  const edit = { id: 'face', file: 'icons.tsx', anchor: 'export function FaceOfMark(', has: ['children'], after: ['  if (mark) return <Mark>{children}</Mark>;'] }
  assert.match(refusalOf('export function FaceOfMark({ host, face }) {\n  return null;\n}\n', edit), /no longer has "children"/)
  assert.equal(refusalOf('export function FaceOfMark({ host, face, children }) {\n  return null;\n}\n', edit), null)
})

test('an edit already applied is refused, and every edit refuses a second application', () => {
  const once = apply(apply(SOURCE, ROUTE), GUARD)
  assert.match(refusalOf(once, ROUTE), /anchor .* is on no line|already has/)
  assert.match(refusalOf(once, GUARD), /already near it/)
  // A replace whose result still has the anchor and the token: the line already has the change.
  const wrap = { id: 'wrap', file: 'a.ts', anchor: '  return ', replace: [['result;', 'orcaResult(result);']] }
  assert.match(refusalOf(apply(SOURCE, wrap), wrap), /the line already has "orcaResult\(result\);"/)
})

test('a group applies whole or not at all, and remembers which edit touched each line', () => {
  const files = new Map()
  const read = (path) => (path === 'a.ts' ? SOURCE : null)
  const refused = applyGroup(files, [ROUTE, { ...GUARD, anchor: 'nowhere' }], read, 'hosts')
  assert.deepEqual(refused, { edit: 'hosts/guard', file: 'a.ts', why: 'anchor "nowhere" is on no line, expected 1' })
  assert.equal(files.size, 0, 'nothing kept from the refused group')
  assert.equal(applyGroup(files, [ROUTE, GUARD], read, 'hosts'), null)
  assert.deepEqual(editedLines(files.get('a.ts')), [{ line: 2, by: 'hosts/guard' }, { line: 4, by: 'hosts/route' }])
  assert.deepEqual(applyGroup(files, [{ ...GUARD, file: 'b.ts' }], read, 'other'), { edit: 'other/guard', file: 'b.ts', why: 'b.ts is not in this Plannotator' })
})

test('lines other edits put in are not anchors, and edits at one place stack in order', () => {
  const files = new Map()
  const read = () => SOURCE
  assert.equal(applyGroup(files, [{ id: 'one', file: 'a.ts', anchor: 'export function start(', after: ['import { one } from "./one";'] }], read, 'a'), null)
  assert.equal(applyGroup(files, [{ id: 'two', file: 'a.ts', anchor: 'export function start(', after: ['import { two } from "./two";'] }], read, 'b'), null)
  // "import {" is now on two lines, both put in by edits: neither counts.
  assert.match(applyGroup(files, [{ id: 'three', file: 'a.ts', anchor: 'import {', after: ['x'] }], read, 'c').why, /is on no line/)
  assert.deepEqual(fileText(files.get('a.ts')).split('\n').slice(0, 3), ['export function start(launch) {', 'import { one } from "./one";', 'import { two } from "./two";'])
})

test('one optional group that no longer fits is left out; the others still apply', () => {
  const groups = [
    { name: 'core', required: true },
    { name: 'hosts', required: false },
    { name: 'detail', required: false, needs: ['hosts'] },
    { name: 'guard', required: false }
  ]
  const edits = { core: [ROUTE], hosts: [{ ...GUARD, id: 'hosts', anchor: 'gone from upstream' }], detail: [{ ...GUARD, id: 'detail', anchor: 'return result;' }], guard: [GUARD] }
  const result = applyGroups(groups, (name) => edits[name], () => SOURCE)
  assert.equal(result.stopped, null)
  assert.deepEqual(result.applied, ['core', 'guard'])
  assert.deepEqual(result.omitted, [
    { name: 'hosts', reason: 'edit hosts/hosts (a.ts): anchor "gone from upstream" is on no line, expected 1', forced: false, edit: 'hosts/hosts', file: 'a.ts' },
    { name: 'detail', reason: 'needs hosts, which is left out', forced: false }
  ])
  const text = fileText(result.files.get('a.ts'))
  assert.match(text, /host\.routeHost/)
  assert.match(text, /orcaMode\(\)/)
  // On purpose, or after a type check: the same, with its reason.
  const chosen = applyGroups(groups, (name) => edits[name], () => SOURCE, { without: ['guard'], dropped: [{ name: 'hosts', reason: 'type check: a.ts:2', edit: 'hosts/hosts' }] })
  assert.deepEqual(chosen.omitted.map((o) => [o.name, o.forced, o.reason]), [['hosts', false, 'type check: a.ts:2'], ['detail', false, 'needs hosts, which is left out'], ['guard', true, 'left out with --without']])
})

test('a required group that no longer fits stops, and nothing after it is tried', () => {
  const groups = [{ name: 'core', required: true }, { name: 'guard', required: false }]
  const edits = { core: [{ ...ROUTE, anchor: 'session: result.session', count: 2 }], guard: [GUARD] }
  const result = applyGroups(groups, (name) => edits[name], () => SOURCE)
  assert.deepEqual(result.stopped, { group: 'core', edit: 'core/route', file: 'a.ts', why: 'anchor "session: result.session" is on 1 line, expected 2' })
  assert.deepEqual(result.applied, [])
})

// Plannotator making one of the edits itself: `upstream` names its own version of the change.
const OWN_GUARD = '  if (isOrcaHost(launch)) return null;'
const GUARD_UP = { ...GUARD, upstream: 'if (isOrcaHost(launch)) return null;' }
const ROUTE_UP = { ...ROUTE, upstream: 'host: launch.routeHost ?? launch.agent' }
const withOwnGuard = SOURCE.replace('export function start(launch) {\n', `export function start(launch) {\n${OWN_GUARD}\n`)
const withOwnRoute = SOURCE.replace('{ to: { host: launch.agent, session', '{ to: { host: launch.routeHost ?? launch.agent, session')
const GROUPS = [{ name: 'core', required: true }, { name: 'marks', required: false }]

test('an edit Plannotator now makes itself is satisfied: nothing is changed, and its group still applies', () => {
  // Its line kept (an added line): the proof sits where the edit would go.
  const kept = applyGroups(GROUPS, (name) => (name === 'core' ? [ROUTE] : [GUARD_UP]), () => withOwnGuard)
  assert.equal(kept.stopped, null)
  assert.deepEqual(kept.applied, ['core', 'marks'])
  assert.deepEqual(kept.omitted, [])
  assert.deepEqual(kept.satisfied, [{ edit: 'marks/guard', file: 'a.ts', proof: 'if (isOrcaHost(launch)) return null;' }])
  const text = fileText(kept.files.get('a.ts'))
  assert.doesNotMatch(text, /orcaMode\(\)/)
  assert.equal(text.split('isOrcaHost').length, 2)
  // Its line gone (Plannotator changed it the same way): the edit cannot apply, the proof says why.
  const changed = applyGroups(GROUPS, (name) => (name === 'core' ? [ROUTE_UP] : [GUARD]), () => withOwnRoute)
  assert.deepEqual(changed.applied, ['core', 'marks'])
  assert.deepEqual(changed.satisfied.map((s) => s.edit), ['core/route'])
  assert.equal(fileText(changed.files.get('a.ts')).split('routeHost').length, 2)
  // Without the proof in the source, the same edits apply as any other.
  const stock = applyGroups(GROUPS, (name) => (name === 'core' ? [ROUTE_UP] : [GUARD_UP]), () => SOURCE)
  assert.deepEqual(stock.satisfied, [])
  assert.match(fileText(stock.files.get('a.ts')), /host\.routeHost \?\? launch\.agent[\s\S]*/)
  assert.match(fileText(stock.files.get('a.ts')), /orcaMode\(\)/)
})

test('neither the edit nor Plannotator’s own version found: refused as before', () => {
  const gone = SOURCE.replace('to: { host: launch.agent, session', 'to: { host: someone.else, session')
  const result = applyGroups([{ name: 'marks', required: false }], () => [ROUTE_UP], () => gone)
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.satisfied, [])
  assert.match(result.omitted[0].reason, /^edit marks\/route \(a\.ts\): anchor .* is on no line, expected 1$/)
})

test('Plannotator’s version away from the edit’s place, or on two lines, is refused: never a guess', () => {
  const filler = Array.from({ length: 60 }, (_, i) => `const filler${i} = ${i};`).join('\n')
  const far = `${SOURCE}${filler}\nfunction other(launch) {\n${OWN_GUARD}\n}\n`
  const away = applyGroups([{ name: 'marks', required: false }], () => [GUARD_UP], () => far)
  assert.deepEqual(away.applied, [])
  assert.match(away.omitted[0].reason, /has its own version of it \(.*isOrcaHost.*\) away from where this edit would go: refit it/)
  const twice = applyGroups([{ name: 'marks', required: false }], () => [GUARD_UP], () => withOwnGuard + `function other(launch) {\n${OWN_GUARD}\n}\n`)
  assert.match(twice.omitted[0].reason, /own version of it .* is on 2 lines, expected 1/)
  // A required group stops on it, as on any refusal.
  const stopped = applyGroups([{ name: 'core', required: true }], () => [GUARD_UP], () => far)
  assert.equal(stopped.stopped.edit, 'core/guard')
  // The proof is a line's text of some length, so it cannot match by accident.
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [{ ...GUARD, upstream: 'if (' }] })), /upstream must be one line's text/)
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [{ ...GUARD, upstream: [] }] })), /upstream must be one line's text/)
})

test('edits Plannotator makes itself are named in the manifest, the release notes and the daily check; the features stay', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-satisfied-'))
  try {
    const all = RECIPE.groups.flatMap((g) => g.features)
    const dir = join(root, 'out')
    mkdirSync(dir)
    const made = ['mark-faces/face-of-mark', 'mark-faces/orca-host-name']
    for (const target of TARGETS) {
      const bytes = Buffer.from(target)
      writeFileSync(join(dir, assetOf(target)), bytes)
      writeFileSync(join(dir, assetOf(target) + '.build.json'), JSON.stringify({ ok: true, plannotator: '0.29.4', target, recipe: 'r', sha256: createHash('sha256').update(bytes).digest('hex'), omitted: [], satisfied: [...made].reverse(), features: all }))
    }
    const { manifest: m, notes } = manifest(dir, { version: '0.29.4', build: 'orca.1', commit: 'c', recipe: 'r' })
    assert.deepEqual(m.features, all)
    assert.deepEqual(m.omitted, [])
    assert.deepEqual(m.satisfied, made)
    assert.match(notes, /A full build: every Orca change is in it\./)
    // a modified Plannotator names its licenses, whose texts the workflow attaches to the release.
    assert.match(notes, /licensed MIT or Apache-2\.0; both license texts are attached as LICENSE-MIT and LICENSE-APACHE\./)
    assert.match(notes, /Plannotator makes 2 of these changes itself now, so the build leaves those lines as Plannotator has them: `mark-faces\/face-of-mark`, `mark-faces\/orca-host-name`\./)
    // Only edit names the recipe has.
    writeFileSync(join(dir, assetOf(TARGETS[0]) + '.build.json'), JSON.stringify({ ok: true, plannotator: '0.29.4', target: TARGETS[0], recipe: 'r', sha256: createHash('sha256').update(Buffer.from(TARGETS[0])).digest('hex'), omitted: [], satisfied: ['mark-faces/x\n<!--'], features: all }))
    assert.throws(() => manifest(dir, { version: '0.29.4', build: 'orca.1', commit: 'c', recipe: 'r' }), /groups or features the recipe does not have/)

    const check = join(root, 'check')
    mkdirSync(check)
    writeFileSync(join(check, 'check.json'), JSON.stringify({ ok: true, omitted: [], satisfied: [...made, 'made/up'] }))
    const v = mainVerdict(check, { head: '0123456789abcdef0123456789abcdef01234567', base: 'v0.29.3', upstream: 'backnotprop/plannotator', run: '' })
    assert.equal(v.kind, 'fits')
    assert.equal(v.line, 'Every edit fits 0123456789ab and its checks and gates pass. Plannotator makes 2 of the edits itself now: mark-faces/face-of-mark, mark-faces/orca-host-name.')
    // From --fit alone, too, when the check stopped before it wrote what it found.
    writeFileSync(join(check, 'check.json'), JSON.stringify({ ok: false, exit: 4, error: 'orca-build: gate tests/orca-mcp-contract.ts failed: exit 1' }))
    writeFileSync(join(check, 'fit.json'), JSON.stringify({ groups: [{ name: 'mark-faces', edits: [{ id: 'face-of-mark', fits: true, satisfied: true, proof: 'x' }] }] }))
    const broken = mainVerdict(check, { head: '0123456789abcdef0123456789abcdef01234567', base: 'v0.29.3', upstream: 'backnotprop/plannotator', run: '' })
    assert.equal(broken.kind, 'broken')
    assert.match(broken.body, /- Made by Plannotator itself now \(left as it has them\): `mark-faces\/face-of-mark`\n/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows line endings are kept', () => {
  const crlf = SOURCE.replaceAll('\n', '\r\n')
  const out = apply(crlf, GUARD)
  assert.ok(out.endsWith('}\r\n') && !/[^\r]\n/.test(out))
})

test('the edit files are checked against the format', () => {
  assert.throws(() => parseEdits('{"v":1,"edits":[]}', 'x.json'), /needs \{"v":1/)
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [{ ...GUARD, extra: 1 }] }), 'x.json'), /unknown field extra/)
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [{ id: 'x', file: '../a.ts', anchor: 'a', after: ['b'] }] }), 'x.json'), /relative file path/)
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [{ id: 'x', file: 'a.ts', anchor: 'a' }] }), 'x.json'), /changes nothing/)
  assert.throws(() => parseEdits(JSON.stringify({ v: 1, edits: [GUARD, GUARD] }), 'x.json'), /used twice/)
  for (const group of RECIPE.groups) assert.ok(parseEdits(readFileSync(fileURLToPath(new URL('../plannotator/' + group.file, import.meta.url)), 'utf8'), group.file).length > 0)
})

test('the recipe: one required group, every other optional, and the features in the order the build serves them', () => {
  assert.deepEqual(RECIPE.groups.filter((g) => g.required).map((g) => g.name), ['orca-mode'])
  assert.deepEqual(RECIPE.groups.flatMap((g) => g.features), ['launch-hosts', 'update-state', 'update-detail', 'agents', 'mark-faces'])
  const info = readFileSync(fileURLToPath(new URL('../plannotator/modules/packages/server/inbox-orca-build.ts', import.meta.url)), 'utf8')
  assert.match(info, /features: \["launch-hosts","update-state","update-detail","agents","mark-faces"\]/)
})

test('build.mjs --fit: a checkout the required group does not fit exits 3 and names every edit that does not fit', () => {
  const empty = mkdtempSync(join(tmpdir(), 'orca-build-fit-'))
  try {
    const run = spawnSync(process.execPath, [BUILD, '--fit', empty], { encoding: 'utf8' })
    assert.equal(run.status, 3, run.stderr)
    const fit = JSON.parse(run.stdout)
    assert.deepEqual(fit.groups.map((g) => [g.name, g.fits]), RECIPE.groups.map((g) => [g.name, false]))
    assert.match(run.stderr, /required group orca-mode: edit orca-mode\/bridge-wakes-orca \(packages\/server\/inbox\.ts\) does not fit: packages\/server\/inbox\.ts is not in this Plannotator/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('the daily check against main: fits, reduced, broken, or no answer, and only names the recipe knows', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-main-'))
  const head = '0123456789abcdef0123456789abcdef01234567'
  const at = (name, files) => {
    const dir = join(root, name)
    mkdirSync(dir)
    for (const [file, value] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(value))
    return mainVerdict(dir, { head, base: 'v0.29.2', upstream: 'backnotprop/plannotator', run: '' })
  }
  try {
    assert.equal(at('fits', { 'check.json': { ok: true, omitted: [] } }).kind, 'fits')
    const reduced = at('reduced', {
      'fit.json': { groups: [{ name: 'mark-faces', edits: [{ id: 'face-of-mark', file: 'x.tsx', fits: false, why: 'no longer has `children`' }] }, { name: 'made-up', edits: [{ id: 'x', fits: false }] }] },
      'check.json': { ok: true, omitted: [{ name: 'mark-faces', reason: 'edit face-of-mark: no longer has children' }, { name: 'made-up', reason: 'x' }] }
    })
    assert.equal(reduced.kind, 'reduced')
    assert.match(reduced.key, /^reduced:[0-9a-f]{16}$/)
    assert.match(reduced.body, /without mark-faces/)
    assert.match(reduced.body, /compare\/v0\.29\.2\.\.\.0123456789ab/)
    assert.match(reduced.body, /`no longer has 'children'`/)
    assert.doesNotMatch(reduced.body + reduced.line, /made-up/)
    assert.ok(reduced.body.endsWith(`<!-- orca-build-main key=${reduced.key} -->\n`))
    const broken = at('broken', { 'check.json': { ok: false, exit: 3, error: 'orca-build: group orca-mode no longer fits: edit surface: --> anchor not found' } })
    assert.equal(broken.kind, 'broken')
    // A download or install that failed says nothing about the edits; a failing gate does.
    assert.equal(at('install', { 'check.json': { ok: false, exit: 4, error: 'orca-build: bun install --frozen-lockfile failed (exit 1)' } }).kind, 'unknown')
    assert.equal(at('gate', { 'check.json': { ok: false, exit: 4, error: 'orca-build: tests/orca-build-proof.ts failed (exit 1)' } }).kind, 'broken')
    assert.equal(at('none', {}).kind, 'unknown')
    assert.equal(mainVerdict(join(root, 'fits'), { head: 'main; true', base: 'v0.29.2', upstream: 'x/y' }).kind, 'unknown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Words that reach a report from upstream's files or output, written to break out of where they are put.
const HOSTILE = ['x ---> <img src=x onerror=alert(1)> -->', 'a\n## injected\n<!-- orca-build-main key=fits -->', '``` `code` ``` @someone [link](https://example.invalid) | cell |', 'line\r\n::error::x\u2028y\u0000z']

test('upstream words in the daily check never leave a code span, end the marker or change the key\'s shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-hostile-'))
  try {
    for (const [i, words] of HOSTILE.entries()) {
      for (const [kind, check] of [['broken', { ok: false, exit: 3, error: `orca-build: group orca-mode no longer fits: ${words}` }], ['reduced', { ok: true, omitted: [{ name: 'mark-faces', reason: words }] }]]) {
        const dir = join(root, `${kind}-${i}`)
        mkdirSync(dir)
        writeFileSync(join(dir, 'check.json'), JSON.stringify(check))
        writeFileSync(join(dir, 'fit.json'), JSON.stringify({ groups: [{ name: 'mark-faces', edits: [{ id: 'face-of-mark', file: words, fits: false, why: words }, { id: words, fits: false }] }] }))
        const v = mainVerdict(dir, { head: '0123456789abcdef0123456789abcdef01234567', base: words, upstream: words, run: words })
        assert.equal(v.kind, kind)
        assert.match(v.key, KEY)
        // One HTML comment, the marker, and it is the body's last line.
        assert.equal(v.body.split('<!--').length, 2, v.body)
        assert.equal(v.body.split('-->').length, 2, v.body)
        assert.ok(v.body.trimEnd().endsWith(`<!-- orca-build-main key=${v.key} -->`))
        // Upstream's words appear only inside code spans: outside them, none of the hostile markup is left.
        const outside = v.body.replace(/`[^`\n]*`/g, '')
        assert.doesNotMatch(outside.replace(`<!-- orca-build-main key=${v.key} -->`, ''), /<!--|-->|<img|## injected|@someone|\[link\]|::error::/)
        assert.doesNotMatch(v.body, /[\u0000\r\u2028]/)
        for (const span of v.body.match(/`[^`]*`/g)) assert.ok(span.length <= 304 && !span.includes('\n'), span)
        assert.doesNotMatch(v.summary, /\n/)
        assert.doesNotMatch(v.title, /[<>\n`]/)
        assert.doesNotMatch(v.body, /example\.invalid\/?\)?\s*$/m)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the release build\'s verdict and manifest keep upstream words out of causes, outputs and notes', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-release-'))
  try {
    // A failed build: the cause is only a group or gate the recipe has, else the exit code.
    const failed = (error, exit = 3) => {
      const dir = mkdtempSync(join(root, 'v-'))
      writeFileSync(join(dir, 'x.build.json'), JSON.stringify({ ok: false, exit, target: 'linux-x64', error }))
      return verdict(dir, { version: '0.29.2', tag: 't', buildResult: 'failure', windowsResult: 'skipped', publishResult: 'skipped' })
    }
    assert.equal(failed('orca-build: required group orca-mode no longer fits Plannotator 0.29.2: edit surface').cause, 'group:orca-mode')
    assert.equal(failed('orca-build: gate tests/orca-build-proof.ts failed: exit 1', 4).cause, 'gate:tests/orca-build-proof.ts')
    for (const words of HOSTILE) {
      const v = failed(`orca-build: bun test failed: group x--> no longer fits gate tests/evil--> failed ${words}`, 4)
      assert.equal(v.cause, 'build:4')
      assert.doesNotMatch(v.line, /[`\n\r\u0000\u2028]/)
      assert.ok(v.line.length <= 300)
    }
    const reduced = (() => {
      const dir = mkdtempSync(join(root, 'r-'))
      writeFileSync(join(dir, 'x.build.json'), JSON.stringify({ ok: true, omitted: [{ name: 'mark-faces', reason: HOSTILE[1] }, { name: 'evil\nomitted=x', reason: 'x' }] }))
      return verdict(dir, { version: '0.29.2', tag: 't', buildResult: 'success', windowsResult: 'success', publishResult: 'success' })
    })()
    assert.equal(reduced.cause, 'left-out:mark-faces')
    assert.doesNotMatch(reduced.line, /\n|evil/)

    // Targets that disagree: only groups the recipe has are named, whatever else a report says.
    for (const words of HOSTILE) {
      const dir = mkdtempSync(join(root, 'd-'))
      writeFileSync(join(dir, 'a.build.json'), JSON.stringify({ ok: true, target: 'linux-x64', omitted: [{ name: 'mark-faces' }] }))
      writeFileSync(join(dir, 'b.build.json'), JSON.stringify({ ok: true, target: 'linux-arm64', omitted: [{ name: words }, null] }))
      const v = verdict(dir, { version: '0.29.2', tag: words, buildResult: 'success', windowsResult: 'success', publishResult: 'failure' })
      assert.equal(v.cause, 'targets-disagree')
      assert.equal(v.line, 'The targets left out different groups: mark-faces vs none the recipe has.')
    }
    // Every line leaves through the same cleaning, the tag's too.
    for (const words of HOSTILE) {
      const dir = mkdtempSync(join(root, 'f-'))
      writeFileSync(join(dir, 'a.build.json'), JSON.stringify({ ok: true, omitted: [] }))
      const v = verdict(dir, { version: '0.29.2', tag: words, buildResult: 'success', windowsResult: 'success', publishResult: 'success' })
      assert.equal(v.kind, 'full')
      assert.doesNotMatch(v.line, /[`\n\r\u0000\u2028]|<!|-->/)
      assert.ok(v.line.length <= 300)
    }

    // The manifest: a report naming a group or feature the recipe lacks is refused (its lines go to $GITHUB_OUTPUT);
    // a left-out group's reason is a code span in the notes.
    const dir = mkdtempSync(join(root, 'm-'))
    const write = (omitted, features) => {
      for (const target of TARGETS) {
        const bytes = Buffer.from(target)
        writeFileSync(join(dir, assetOf(target)), bytes)
        writeFileSync(join(dir, assetOf(target) + '.build.json'), JSON.stringify({ ok: true, plannotator: '0.29.2', target, recipe: 'r', sha256: createHash('sha256').update(bytes).digest('hex'), omitted, features }))
      }
    }
    const all = RECIPE.groups.flatMap((g) => g.features)
    write([{ name: 'mark-faces', reason: HOSTILE[0] }], all.filter((f) => f !== 'mark-faces'))
    const { manifest: m, notes } = manifest(dir, { version: '0.29.2', build: 'orca.1', commit: 'c', recipe: 'r' })
    assert.deepEqual(m.omitted, ['mark-faces'])
    assert.doesNotMatch(notes.replace(/`[^`\n]*`/g, ''), /<img|-->/)
    write([{ name: 'mark-faces\nreduced=false', reason: 'x' }], all)
    assert.throws(() => manifest(dir, { version: '0.29.2', build: 'orca.1', commit: 'c', recipe: 'r' }), /groups or features the recipe does not have/)
    write([], [...all, 'x\nomitted='])
    assert.throws(() => manifest(dir, { version: '0.29.2', build: 'orca.1', commit: 'c', recipe: 'r' }), /groups or features the recipe does not have/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
