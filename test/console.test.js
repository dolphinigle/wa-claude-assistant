import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { createFakeBrain } from '../src/brain/fake.js'
import { Store } from '../src/store.js'
import { createConsoleTransport, parseConsoleLine, SELF_CHAT_ID } from '../src/transport/console.js'
import { knowledge, makeConfig, sleep, tempDir } from './helpers.js'

test('parseConsoleLine', () => {
  assert.deepEqual(parseConsoleLine('alice: jam buka?'), { chatId: 'alice@console', fromMe: false, isSelfChat: false, senderName: 'alice', text: 'jam buka?' })
  assert.deepEqual(parseConsoleLine('me@alice: bentar ya'), { chatId: 'alice@console', fromMe: true, isSelfChat: false, text: 'bentar ya' })
  assert.deepEqual(parseConsoleLine('me: /ok 1'), { chatId: SELF_CHAT_ID, fromMe: true, isSelfChat: true, text: '/ok 1' })
  assert.deepEqual(parseConsoleLine('quit'), { command: 'quit' })
  assert.deepEqual(parseConsoleLine('???'), { command: 'unparsed' })
  assert.equal(parseConsoleLine('   '), null)
})

test('console REPL end to end with the keyword brain: echoes are loop-guarded, /ok works', async t => {
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 5 }, dir)
  const store = new Store(dir)
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', chunk => { printed += chunk })
  let assistant
  const transport = createConsoleTransport({ onMessage: message => assistant.handleMessage(message), input, output })
  assistant = createAssistant({ config, store, brain: createFakeBrain({ delayMs: 1 }), transport, knowledge, logger: { log () {}, warn () {}, error () {} } })
  t.after(async () => { await assistant.stop(); await transport.stop() })
  await transport.start()

  const settle = async () => { for (let round = 0; round < 5; round++) { await sleep(20); await assistant.idle() } }
  input.write('alice: jam berapa buka?\n')
  await settle()
  input.write('bob: bisa bikin kue custom?\n')
  await settle()
  input.write('me: /ok 1\n')
  await settle()
  input.write('carol: ok makasih kak\n')
  await settle()
  input.write('me: /ok 2\n')
  await settle()
  input.write('carol: 🙏\n')
  await settle()

  assert.match(printed, /── to alice ──\n {2}│ 🤖 Kami buka/)
  assert.match(printed, /── to bob ──\n {2}│ 🤖 Tunggu sebentar ya Kak 🙏\n[\s\S]*📝 DRAFT #1 · bob \(bob@console\)\n {2}│ They wrote: "bisa bikin kue custom\?"\n {2}│ ↩️ They got: 🤖 Tunggu sebentar ya Kak 🙏/,
    'a waiting customer hears something before the owner is told')
  assert.match(printed, /── to bob ──\n {2}│ Terima kasih Kak, saya cek dulu ya\./)
  assert.match(printed, /✅ Sent to bob \(bob@console\) \(draft #1\)/)
  assert.match(printed, /📝 DRAFT #2 · carol \(carol@console\)[\s\S]*Not auto-sent: no_question/, 'a thanks asks nothing: never auto-sent')
  assert.match(printed, /── to carol ──\n {2}│ Sama-sama, Kak 🙏\n/, 'the approved thanks-back goes out without the AI marker')
  assert.doesNotMatch(printed, /DRAFT #3/, 'the 🙏 after it is skipped: its echo marked the closing')
  assert.equal(store.chat('alice@console').takeoverUntil, 0, 'the echo of the auto-reply did not look like the owner typing')
})

test('console REPL with allowChats: only the listed contact is handled; "Message yourself" still is', async t => {
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 5, allowChats: ['alice@console'] }, dir)
  const store = new Store(dir)
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', chunk => { printed += chunk })
  let assistant
  const transport = createConsoleTransport({ onMessage: message => assistant.handleMessage(message), input, output })
  assistant = createAssistant({ config, store, brain: createFakeBrain({ delayMs: 1 }), transport, knowledge, logger: { log () {}, warn () {}, error () {} } })
  t.after(async () => { await assistant.stop(); await transport.stop() })
  await transport.start()

  const settle = async () => { for (let round = 0; round < 5; round++) { await sleep(20); await assistant.idle() } }
  for (const line of ['bob: saya sudah transfer, tolong dicek', 'me@bob: bentar ya', 'alice: jam berapa buka?', 'me: /status']) {
    input.write(`${line}\n`)
    await settle()
  }

  assert.match(printed, /── to alice ──\n {2}│ 🤖 Kami buka/)
  assert.doesNotMatch(printed, /DRAFT|── to bob ──|You replied to bob/, 'bob gets no draft, no reply, no takeover')
  assert.match(printed, /Only these chats \(allowChats\): alice@console/)
  assert.equal(store.existingChat('bob@console'), undefined)
})
