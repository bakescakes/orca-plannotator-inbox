// The Orca side for real: this plugin's CLI calls against a running Orca. The other tests use a
// stand-in for Orca's CLI, so this is the one that says whether an Orca update changed a shape.
//
//   ORCA_LIVE_CLI=<path to the orca CLI>          read-only checks (status, chat list, receipts)
//   ORCA_LIVE_SESSION=<a native chat's session>   also reads that chat's mailbox
//   ORCA_LIVE_SEND=1                              also sends that chat one clearly-marked test mail
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { buildEnvelope } from '../src/envelope'
import { OrcaCli } from '../src/orca-cli'
import { canonicalSession } from '../src/util'
import { reply } from './fakes'

const CLI = (process.env.ORCA_LIVE_CLI ?? '').trim()
const SESSION = canonicalSession((process.env.ORCA_LIVE_SESSION ?? '').trim())
const skip = CLI ? false : 'set ORCA_LIVE_CLI to run'
const orca = (): OrcaCli => new OrcaCli({ command: [CLI] })

test('live Orca: status and the list of native chats read as expected', { skip }, async () => {
  const version = await orca().version()
  assert.match(String(version), /^\d+\.\d+\.\d+/)
  const chats = await orca().inventory()
  process.stderr.write(`live Orca ${version}: ${chats.size} native chat(s) listed\n`)
  if (SESSION) assert.ok(chats.has(SESSION), 'the given chat is listed as an open native chat')
})

test('live Orca: an unknown request has no receipt, and a mailbox reads without consuming', { skip }, async () => {
  const envelope = buildEnvelope('0'.repeat(64), SESSION ?? 'none', reply('msg_live'))
  assert.equal(await orca().receipt(randomUUID(), envelope), null)
  if (SESSION) assert.ok(Array.isArray(await orca().mailbox(`orca_session_id:${SESSION}`)))
})

test('live Orca: one mail is queued once, has a receipt, and shows in the chat’s mailbox', { skip: skip || (SESSION && process.env.ORCA_LIVE_SEND === '1' ? false : 'set ORCA_LIVE_SESSION and ORCA_LIVE_SEND=1 to run') }, async () => {
  const cli = orca()
  const id = `msg_livetest_${Date.now()}`
  const envelope = buildEnvelope('0'.repeat(64), SESSION!, reply(id, { subject: 'plugin live test', body: 'This is an automated test mail from the Plannotator Inbox plugin for Orca. Nothing to do; no answer needed.' }))
  const request = randomUUID()
  const first = await cli.send(envelope, request)
  const again = await cli.send(envelope, request)
  assert.equal(again.id, first.id, 'the same request id replays the first result')
  const receipt = await cli.receipt(request, envelope)
  assert.equal(receipt?.id, first.id)
  const inBox = (await cli.mailbox(first.to_handle)).filter((mail) => mail.payload === envelope.payload)
  assert.equal(inBox.length, 1, 'exactly one mail')
  assert.equal(inBox[0]!.from_handle, 'plannotator-inbox')
  process.stderr.write(`live Orca: mail ${first.id} queued to ${first.to_handle}\n`)
})
