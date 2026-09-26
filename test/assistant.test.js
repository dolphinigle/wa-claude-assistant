import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { Store } from '../src/store.js'
import { getMeIds, normalizeUpsert } from '../src/transport/wa-normalize.js'
import { createFakeBrain, createFakeTransport, incoming, knowledge, makeConfig, ANSWER_HOURS, sleep, tempDir, triageResult } from './helpers.js'

const ALICE = '6282222222222@s.whatsapp.net'
const BOB = '6283333333333@s.whatsapp.net'
const silent = { log () {}, warn () {}, error () {} }

// Picks the triage by keyword in the combined message text, like a very small model.
const byKeyword = input => {
  const text = input.messages.map(message => message.text).join(' ')
  if (/jam|buka/i.test(text)) return triageResult(ANSWER_HOURS)
  if (/transfer/i.test(text)) return triageResult({ decision: 'escalate', reply: 'Baik Kak, saya cek dulu.', summary: 'says they paid' })
  if (/makasih/i.test(text)) return triageResult({ decision: 'answer', reply: 'Sama-sama, Kak 🙏' })
  if (/cheesecake/i.test(text)) return triageResult({ decision: 'answer', reply: 'Cheesecake Rp 150.000 ya Kak', facts_used: ['F5'] })
  if (/crash/i.test(text)) return { ok: false, error: 'timeout', meta: {} }
  return triageResult({ decision: 'escalate', reply: 'Baik Kak, saya tanyakan dulu ya.' })
}

function setup (t, { config: overrides = {}, respond = byKeyword } = {}) {
  let clock = Date.now()
  const now = () => clock
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 10, ...overrides }, dir)
  const store = new Store(dir, { now, logger: silent })
  const transport = createFakeTransport({ now })
  const brain = createFakeBrain(respond)
  const assistant = createAssistant({ config, store, brain, transport, knowledge, now, logger: silent })
  t.after(() => assistant.stop())
  const deliver = async message => { transport.remember(message); await assistant.handleMessage(message); await assistant.idle() }
  const owner = text => deliver({ id: `OWN${Math.random()}`, chatId: 'self', fromMe: true, isSelfChat: true, text, timestamp: Math.floor(clock / 1000), kind: 'notify' })
  const audit = () => readFileSync(store.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { config, store, transport, brain, assistant, deliver, owner, audit, advance: ms => { clock += ms }, now }
}

const waitFor = async (condition, timeoutMs = 1000) => {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await sleep(2)
  }
}

test('live: an answer is auto-sent with disclosure, quoted, marked read, owner notified', async t => {
  const { transport, deliver, store } = setup(t)
  const message = incoming(ALICE, 'Kak jam berapa buka?', { raw: { key: { id: 'raw' } } })
  await deliver(message)
  const [sent] = transport.toCustomer()
  assert.equal(sent.chatId, ALICE)
  assert.ok(sent.text.startsWith('🤖 Balasan otomatis dari asisten AI'))
  assert.ok(sent.text.endsWith(ANSWER_HOURS.reply))
  assert.deepEqual(sent.quotedRaw, message.raw)
  assert.deepEqual(transport.read, [message.id])
  assert.match(transport.toSelf()[0], /✅ Auto-replied to 6282222222222|✅ Auto-replied to /)
  assert.ok(store.isSentByBot(sent.id), 'the customer send is loop-guarded')
  assert.equal(store.countChatAutoSends(ALICE, 3_600_000), 1)
})

test('an auto-reply is not marked read while the chat still has a draft waiting for the owner', async t => {
  const { transport, deliver, owner, advance, now, audit } = setup(t)
  const live = () => ({ timestamp: Math.floor(now() / 1000) })
  await deliver(incoming(ALICE, 'Saya sudah transfer 2 juta, tolong dicek', live()))
  advance(30_000)
  await deliver(incoming(ALICE, 'jam berapa tutup?', live()))
  assert.equal(transport.toCustomer().length, 1, 'the hours question is still answered')
  assert.deepEqual(transport.read, [])
  assert.ok(audit().some(entry => entry.event === 'mark_read_skipped' && entry.openDrafts.includes(1)))

  await owner('/no 1')
  advance(30_000)
  const last = incoming(ALICE, 'jam berapa buka?', live())
  await deliver(last)
  assert.deepEqual(transport.read, [last.id], 'once nothing is open, auto-replies mark read again')
})

test('disclosure only on the first auto-reply of a session', async t => {
  const { transport, deliver, advance, now } = setup(t)
  const live = () => ({ timestamp: Math.floor(now() / 1000) })
  await deliver(incoming(ALICE, 'jam buka?', live()))
  advance(60 * 60 * 1000)
  await deliver(incoming(ALICE, 'buka hari sabtu juga?', live()))
  advance(13 * 60 * 60 * 1000)
  await deliver(incoming(ALICE, 'jam buka lagi?', live()))
  const disclosed = transport.toCustomer().map(item => item.text.startsWith('🤖 Balasan otomatis'))
  assert.deepEqual(disclosed, [true, false, true])
})

test('shadow mode never sends to a customer, even on /ok', async t => {
  const { transport, deliver, owner, store } = setup(t, { config: { mode: 'shadow' } })
  await deliver(incoming(ALICE, 'jam buka?'))
  await deliver(incoming(BOB, 'bisa bikin kue custom?'))
  await owner('/ok 1')
  await owner('/edit 1 teks saya')
  assert.deepEqual(transport.toCustomer(), [])
  const self = transport.toSelf()
  assert.ok(self.some(text => text.startsWith('🤖 [SHADOW] Would auto-reply')))
  assert.ok(self.some(text => text.includes('📝 DRAFT #1')))
  assert.ok(self.some(text => text.includes('[SHADOW] Draft #1 approved')))
  assert.equal(store.getDraft(1).status, 'approved_shadow')
})

test('debounce combines a burst into one triage', async t => {
  const { brain, assistant, transport } = setup(t, { config: { debounceMs: 40 } })
  await assistant.handleMessage(incoming(ALICE, 'kak'))
  await assistant.handleMessage(incoming(ALICE, 'buka jam berapa?'))
  await assistant.idle()
  assert.equal(brain.calls.length, 1)
  assert.deepEqual(brain.calls[0].messages.map(message => message.text), ['kak', 'buka jam berapa?'])
  assert.equal(transport.toCustomer().length, 1)
})

test('a message arriving during an in-flight triage discards the stale result and re-triages', async t => {
  const { brain, assistant, transport, audit } = setup(t)
  const release = brain.hold()
  await assistant.handleMessage(incoming(ALICE, 'mau pesan kue'))
  await waitFor(() => brain.calls.length === 1)
  await assistant.handleMessage(incoming(ALICE, 'jam berapa buka?'))
  await waitFor(() => brain.calls.length === 2)
  release()
  await assistant.idle()
  assert.deepEqual(brain.calls[1].messages.map(message => message.text), ['mau pesan kue', 'jam berapa buka?'])
  assert.equal(transport.toCustomer().length, 1, 'only the fresh result is acted on')
  assert.equal(transport.toSelf().filter(text => text.includes('DRAFT')).length, 0, 'the stale escalation was dropped')
  assert.ok(audit().some(entry => entry.event === 'triage_discarded_stale'))
})

test('duplicate message ids are processed once', async t => {
  const { brain, deliver } = setup(t)
  const message = incoming(ALICE, 'jam buka?')
  await deliver(message)
  await deliver({ ...message })
  assert.equal(brain.calls.length, 1)
})

test('loop guard: the echo of a bot send is ignored and does not start a takeover', async t => {
  const { transport, deliver, store, brain } = setup(t)
  await deliver(incoming(ALICE, 'jam buka?'))
  const [sent] = transport.toCustomer()
  await deliver({ id: sent.id, chatId: ALICE, fromMe: true, isSelfChat: false, text: sent.text, timestamp: Math.floor(Date.now() / 1000), kind: 'append' })
  for (const notice of transport.sent.filter(item => item.chatId === 'self')) {
    await deliver({ id: notice.id, chatId: 'self', fromMe: true, isSelfChat: true, text: notice.text, timestamp: Math.floor(Date.now() / 1000), kind: 'append' })
  }
  assert.equal(store.chat(ALICE).takeoverUntil, 0)
  assert.equal(brain.calls.length, 1)
})

test('human takeover: owner typing in a customer chat cancels its drafts and silences the bot there', async t => {
  const { transport, deliver, store, brain, advance, now } = setup(t)
  await deliver(incoming(ALICE, 'bisa kue custom unicorn?'))
  assert.equal(store.getDraft(1).status, 'pending')
  await deliver(incoming(ALICE, 'bisa kak, sebentar ya', { fromMe: true, timestamp: Math.floor(now() / 1000) }))
  assert.equal(store.getDraft(1).status, 'cancelled')
  assert.ok(transport.toSelf().some(text => text.includes('cancelled draft #1')))
  assert.ok(store.chat(ALICE).takeoverUntil > now())

  await deliver(incoming(ALICE, 'jam buka?'))
  assert.equal(brain.calls.length, 1, 'no triage during takeover')
  assert.equal(transport.toCustomer().length, 0)

  advance(31 * 60 * 1000)
  await deliver(incoming(ALICE, 'jam buka?', { timestamp: Math.floor(now() / 1000) }))
  assert.equal(transport.toCustomer().length, 1, 'bot resumes after the window')
})

test('takeover during an in-flight triage drops its result', async t => {
  const { brain, assistant, transport, now } = setup(t)
  const release = brain.hold()
  await assistant.handleMessage(incoming(ALICE, 'jam buka?'))
  await waitFor(() => brain.calls.length === 1)
  await assistant.handleMessage(incoming(ALICE, 'saya jawab sendiri', { fromMe: true, timestamp: Math.floor(now() / 1000) }))
  release()
  await assistant.idle()
  assert.equal(transport.toCustomer().length, 0)
})

test('an owner voice note (no text) cancels the in-flight triage and the chat drafts', async t => {
  const { brain, assistant, transport, store, now } = setup(t)
  await assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?'))
  await assistant.idle()
  assert.equal(store.getDraft(1).status, 'pending')
  const release = brain.hold()
  await assistant.handleMessage(incoming(ALICE, 'jam buka?'))
  await waitFor(() => brain.calls.length === 2)
  const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net' })
  const voice = normalizeUpsert({ key: { remoteJid: ALICE, id: 'VOICE1', fromMe: true }, message: { audioMessage: { ptt: true } }, messageTimestamp: Math.floor(now() / 1000) }, { type: 'notify', meIds })
  await assistant.handleMessage(voice.message)
  release()
  await assistant.idle()
  assert.equal(transport.toCustomer().length, 0, 'nothing is auto-sent on top of the owner\'s reply')
  assert.equal(store.getDraft(1).status, 'cancelled')
  assert.ok(store.chat(ALICE).takeoverUntil > now())
})

test('an owner reply in a LID chat carrying the own PN as alt starts a takeover instead of acting as self-chat', async t => {
  const { brain, assistant, transport, store, now } = setup(t)
  const LID = '55555@lid'
  await assistant.handleMessage(incoming(LID, 'bisa kue custom unicorn?'))
  await assistant.idle()
  const release = brain.hold()
  await assistant.handleMessage(incoming(LID, 'jam buka?'))
  await waitFor(() => brain.calls.length === 2)
  const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net', lid: '99887766554433:7@lid' })
  const key = { remoteJid: LID, remoteJidAlt: '6281111111111:7@s.whatsapp.net', fromMe: true }
  for (const [id, text] of [['R1', 'bentar ya kak'], ['R2', '/pause']]) {
    const { message } = normalizeUpsert({ key: { ...key, id }, message: { conversation: text }, messageTimestamp: Math.floor(now() / 1000) }, { type: 'notify', meIds })
    await assistant.handleMessage(message)
  }
  release()
  await assistant.idle()
  assert.equal(transport.toCustomer().length, 0, 'nothing is auto-sent on top of the owner')
  assert.equal(store.getDraft(1).status, 'cancelled')
  assert.ok(store.chat(LID).takeoverUntil > now())
  assert.equal(store.paused, false, 'a /command typed in a customer chat is not an owner command')
})

test('an owner reply older than the takeover window still answers the backlog before it', async t => {
  const { brain, assistant, deliver, transport, store, now, audit } = setup(t, { config: { debounceMs: 300, backlog: { autoSend: true } } })
  const nowSeconds = Math.floor(now() / 1000)
  store.seedHistoryFloor(nowSeconds - 3 * 3600)
  const owner = (id, ageMinutes, chatId = ALICE) => ({ id, chatId, fromMe: true, isSelfChat: false, text: 'masih ada kak', timestamp: nowSeconds - ageMinutes * 60, kind: 'append' })
  // The bot was down 40 min: the question and the owner's phone answer arrive in one backlog flush, in either order.
  for (const message of [
    incoming(ALICE, 'Kak, jam buka masih sama?', { kind: 'append', timestamp: nowSeconds - 40 * 60 }),
    owner('OWN1', 35),
    owner('OWN2', 35, BOB),
    incoming(BOB, 'Kak, jam buka masih sama?', { kind: 'append', timestamp: nowSeconds - 40 * 60 })
  ]) await assistant.handleMessage(message)
  await assistant.idle()
  assert.equal(brain.calls.length, 0, 'neither question is triaged')
  assert.deepEqual([transport.toCustomer(), transport.toSelf(), store.pendingDrafts()], [[], [], []])
  assert.deepEqual([store.chat(ALICE).takeoverUntil, store.chat(BOB).takeoverUntil], [0, 0], 'an old reply starts no takeover')
  assert.ok(audit().some(entry => entry.event === 'skip_answered_by_owner' && entry.chatId === BOB))
  assert.deepEqual(store.inboxMessages(), [])

  // A later question is still triaged.
  await deliver(incoming(ALICE, 'jam buka hari sabtu?', { kind: 'append', timestamp: nowSeconds - 20 * 60 }))
  assert.equal(brain.calls.length, 1)
})

test('an old owner reply cancels drafts it answered and re-triages only what came after it', async t => {
  const { brain, assistant, deliver, transport, store, now } = setup(t)
  const nowSeconds = Math.floor(now() / 1000)
  store.seedHistoryFloor(nowSeconds - 3 * 3600)
  await deliver(incoming(ALICE, 'bisa kue custom?', { kind: 'append', timestamp: nowSeconds - 50 * 60 }))
  assert.equal(store.getDraft(1).status, 'pending')
  await deliver({ id: 'OWN1', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'bisa kak', timestamp: nowSeconds - 45 * 60, kind: 'append' })
  assert.equal(store.getDraft(1).status, 'cancelled')
  assert.match(transport.toSelf().at(-1), /You had already replied to .* at \d\d:\d\d: cancelled draft #1\./)

  const release = brain.hold()
  await assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', { kind: 'append', timestamp: nowSeconds - 44 * 60 }))
  await assistant.handleMessage(incoming(ALICE, 'kalau warna pink?', { kind: 'append', timestamp: nowSeconds - 30 * 60 }))
  await waitFor(() => brain.calls.length === 2)
  await assistant.handleMessage({ id: 'OWN2', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'bisa kak', timestamp: nowSeconds - 40 * 60, kind: 'append' })
  release()
  await assistant.idle()
  assert.deepEqual(brain.calls.at(-1).messages.map(message => message.text), ['kalau warna pink?'], 'the in-flight batch is re-triaged without the answered message')
  assert.deepEqual(store.pendingDrafts().map(draft => draft.excerpt), ['kalau warna pink?'])
})

test('messages recovered after a restart that the owner answered meanwhile are not triaged', async t => {
  const { assistant, store, brain, now } = setup(t)
  const nowSeconds = Math.floor(now() / 1000)
  store.addToInbox(incoming(ALICE, 'bisa kue custom?', { timestamp: nowSeconds - 10 * 60 }))
  store.updateChat(ALICE, { ownerRepliedAt: (nowSeconds - 5 * 60) * 1000 })
  assistant.recoverInbox()
  await assistant.idle()
  assert.equal(brain.calls.length, 0)
  assert.deepEqual(store.inboxMessages(), [])
})

test('an owner reply on the PN form of a LID chat silences the LID chat and cancels its drafts', async t => {
  const { transport, deliver, store, brain, now } = setup(t)
  const LID = '123456789012345@lid'
  const PN = '6282222222222@s.whatsapp.net'
  const live = () => ({ timestamp: Math.floor(now() / 1000) })
  await deliver(incoming(LID, 'bisa kue custom unicorn?', { chatIdAlt: PN, ...live() }))
  assert.equal(store.getDraft(1).status, 'pending')
  // No alt on the owner's copy: the LID record's saved alt links the two.
  await deliver({ id: 'OWN1', chatId: PN, fromMe: true, isSelfChat: false, text: 'bisa kak', ...live(), kind: 'notify' })
  assert.equal(store.getDraft(1).status, 'cancelled')
  await deliver(incoming(LID, 'jam berapa buka?', { chatIdAlt: PN, ...live() }))
  assert.equal(brain.calls.length, 1, 'no triage during the takeover')
  assert.equal(transport.toCustomer().length, 0)

  // The other order: the owner's reply (PN, LID alt) comes before the contact's first LID message.
  const LID2 = '999999999999999@lid'
  const PN2 = '6283333333333@s.whatsapp.net'
  await deliver({ id: 'OWN2', chatId: PN2, chatIdAlt: LID2, fromMe: true, isSelfChat: false, text: 'halo kak', ...live(), kind: 'notify' })
  await deliver(incoming(LID2, 'jam berapa buka?', { ...live() }))
  assert.equal(brain.calls.length, 1)
  assert.equal(transport.toCustomer().length, 0)
})

test('notices that fail while WhatsApp reconnects are queued and re-sent, never dropped', async t => {
  const { transport, deliver, store, assistant } = setup(t)
  transport.down = true
  await deliver(incoming(BOB, 'saya sudah transfer, pesanan saya mana?'))
  await deliver(incoming(ALICE, 'jam buka?'))
  assert.equal(transport.sent.length, 0)
  assert.equal(store.ownerOutbox.length, 2, 'the escalation and the failed auto-reply\'s draft')
  assert.deepEqual(store.getDraft(2).policyReasons, ['decision:answer', 'send_failed:whatsapp not connected'])

  transport.down = false
  await assistant.flushOwnerOutbox()
  const self = transport.toSelf()
  assert.equal(self.length, 2)
  assert.match(self[0], /^🤖 ⏳ Delayed notice from \d\d:\d\d:\n📝 DRAFT #1/)
  assert.match(self[1], /Delayed notice.*\n📝 DRAFT #2.*Not auto-sent: send_failed:whatsapp not connected/s)
  assert.equal(store.ownerOutbox.length, 0)
})

test('a notice that goes through again also flushes the queued ones', async t => {
  const { transport, deliver, owner, store } = setup(t)
  transport.down = true
  await deliver(incoming(BOB, 'saya sudah transfer'))
  transport.down = false
  await owner('/status')
  assert.equal(store.ownerOutbox.length, 0)
  assert.ok(transport.toSelf().some(text => text.includes('Delayed notice') && text.includes('DRAFT #1')))
})

test('messages accepted but not routed before a stop are triaged again after restart, or listed if too old', async t => {
  const dir = tempDir(t)
  let clock = Date.now()
  const now = () => clock
  const start = (debounceMs, respond = byKeyword) => {
    const config = makeConfig({ mode: 'live', debounceMs }, dir)
    const store = new Store(dir, { now, logger: silent })
    const transport = createFakeTransport()
    const brain = createFakeBrain(respond)
    const assistant = createAssistant({ config, store, brain, transport, knowledge, now, logger: silent })
    t.after(() => assistant.stop())
    return { store, transport, brain, assistant }
  }
  const first = start(60_000)
  await first.assistant.handleMessage(incoming(BOB, 'saya sudah transfer, pesanan saya mana?', { timestamp: Math.floor(clock / 1000), attachment: 'image' }))
  await first.assistant.stop() // restart during the debounce

  const second = start(10)
  const release = second.brain.hold()
  second.assistant.recoverInbox()
  await waitFor(() => second.brain.calls.length === 1)
  const stopping = second.assistant.stop() // shutdown kills claude while the triage is in flight
  release()
  await stopping
  assert.equal(second.transport.sent.length, 0)

  const third = start(10)
  third.assistant.recoverInbox()
  await third.assistant.idle()
  assert.deepEqual(third.brain.calls.map(call => call.messages.map(message => [message.text, message.attachment])), [[['saya sudah transfer, pesanan saya mana?', 'image']]], 'the attachment survives the restart')
  assert.match(third.transport.toSelf()[0], /📝 DRAFT #1/)
  assert.deepEqual(third.store.getDraft(1).policyReasons, ['decision:escalate'])
  assert.deepEqual(third.store.inboxMessages(), [])

  await third.assistant.handleMessage(incoming(ALICE, 'bisa kue custom?', { timestamp: Math.floor(clock / 1000) }))
  await third.assistant.stop()
  clock += 2 * 60 * 60 * 1000
  const fourth = start(10)
  fourth.assistant.recoverInbox()
  await fourth.assistant.idle()
  assert.equal(fourth.brain.calls.length, 0)
  assert.match(fourth.transport.toSelf()[0], /⚠️ 1 message\(s\) arrived before the assistant stopped[\s\S]*"bisa kue custom\?"/)
  assert.deepEqual(fourth.store.inboxMessages(), [])
})

test('a message that arrives while shutdown drains is kept in the inbox and triaged after the restart', async t => {
  const dir = tempDir(t)
  const start = () => {
    const config = makeConfig({ mode: 'live', debounceMs: 10 }, dir)
    const store = new Store(dir, { logger: silent })
    const transport = createFakeTransport()
    const brain = createFakeBrain(byKeyword)
    const assistant = createAssistant({ config, store, brain, transport, knowledge, logger: silent })
    t.after(() => assistant.stop())
    return { store, transport, brain, assistant }
  }
  const first = start()
  const release = first.brain.hold()
  await first.assistant.handleMessage(incoming(ALICE, 'bisa kue custom?'))
  await waitFor(() => first.brain.calls.length === 1)
  const stopping = first.assistant.stop()
  await first.assistant.handleMessage(incoming(BOB, 'saya sudah transfer, pesanan saya mana?'))
  await first.assistant.handleMessage({ id: 'CMD1', chatId: 'self', fromMe: true, isSelfChat: true, text: '/pause', timestamp: Math.floor(Date.now() / 1000), kind: 'notify' })
  release()
  await stopping
  assert.equal(first.brain.calls.length, 1, 'nothing new is triaged while stopping')
  assert.equal(first.store.paused, false, 'no owner command runs while stopping')

  const second = start()
  assert.deepEqual(second.store.inboxMessages().map(message => message.text).sort(), ['bisa kue custom?', 'saya sudah transfer, pesanan saya mana?'])
  second.assistant.recoverInbox()
  await second.assistant.idle()
  assert.deepEqual(second.brain.calls.map(call => call.chat.name).sort(), ['6282222222222', '6283333333333'])
  assert.ok(second.transport.toSelf().some(text => /📝 DRAFT #\d.*\nThey wrote: "saya sudah transfer/s.test(text)))
})

test('per-chat and per-day rate limits downgrade to drafts', async t => {
  const { transport, deliver, store } = setup(t, { config: { autoSend: { maxPerChatPerHour: 2, maxPerDay: 3 } } })
  for (let index = 0; index < 3; index++) await deliver(incoming(ALICE, `jam buka? ${index}`))
  assert.equal(transport.toCustomer().length, 2)
  assert.match(transport.toSelf().at(-1), /Not auto-sent: chat_rate_limit/)
  await deliver(incoming(BOB, 'jam buka?'))
  await deliver(incoming('6284444444444@s.whatsapp.net', 'jam buka?'))
  assert.equal(transport.toCustomer().length, 3)
  assert.ok(store.pendingDrafts().some(draft => draft.policyReasons.includes('daily_rate_limit')))
})

test('the daily cap holds when two chats finish triage while a send is still in flight', async t => {
  const respond = async input => {
    if (input.chat.name.startsWith('6283')) await sleep(30) // BOB finishes while ALICE's send is waiting
    return triageResult(ANSWER_HOURS)
  }
  const { transport, assistant, store } = setup(t, { config: { autoSend: { maxPerDay: 1 } }, respond })
  transport.sendDelayMs = 100
  await assistant.handleMessage(incoming(ALICE, 'jam buka kapan ya?'))
  await assistant.handleMessage(incoming(BOB, 'jam buka kapan ya?'))
  await assistant.idle()
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [ALICE])
  assert.equal(store.countAutoSends(24 * 3_600_000), 1)
  assert.ok(store.pendingDrafts().some(draft => draft.chatId === BOB && draft.policyReasons.includes('daily_rate_limit')))
})

test('a failed auto-send gives its rate-limit slot back', async t => {
  const { transport, deliver, store } = setup(t)
  transport.down = true
  await deliver(incoming(ALICE, 'jam buka?'))
  assert.equal(store.countAutoSends(24 * 3_600_000), 0)
  assert.equal(store.countChatAutoSends(ALICE, 3_600_000), 0)
})

test('backlog: old appends are skipped, recent ones are drafted, never auto-sent', async t => {
  const { transport, deliver, store, brain, now } = setup(t)
  store.seedHistoryFloor(Math.floor(now() / 1000) - 3 * 3600)
  const nowSeconds = Math.floor(now() / 1000)
  await deliver(incoming(ALICE, 'jam buka? (sudah diproses)', { kind: 'append', timestamp: nowSeconds - 4 * 3600 }))
  await deliver(incoming(ALICE, 'jam buka? (terlalu lama)', { kind: 'append', timestamp: nowSeconds - 2 * 3600 }))
  assert.equal(brain.calls.length, 0)
  await deliver(incoming(BOB, 'jam buka? (baru)', { kind: 'append', timestamp: nowSeconds - 10 * 60 }))
  assert.equal(brain.calls.length, 1)
  assert.equal(transport.toCustomer().length, 0)
  assert.ok(store.getDraft(1).policyReasons.includes('backlog'))
})

test('an old message redelivered as notify (placeholder resend, retry) is skipped or drafted by its age', async t => {
  const { transport, deliver, store, brain, now, audit } = setup(t)
  const nowSeconds = Math.floor(now() / 1000)
  store.seedHistoryFloor(nowSeconds - 3 * 3600)
  await deliver(incoming(ALICE, 'jam berapa buka?', { kind: 'notify', timestamp: nowSeconds - 150 * 60 }))
  assert.equal(brain.calls.length, 0)
  assert.ok(audit().some(entry => entry.event === 'skip_backlog_too_old' && entry.kind === 'notify'))
  await deliver(incoming(BOB, 'jam berapa buka?', { kind: 'notify', timestamp: nowSeconds - 10 * 60 }))
  assert.equal(brain.calls.length, 1)
  assert.equal(transport.toCustomer().length, 0)
  assert.ok(store.getDraft(1).policyReasons.includes('backlog'))
})

test('a live message does not hide older offline messages, even from the same second', async t => {
  const { deliver, store, brain, now } = setup(t)
  const nowSeconds = Math.floor(now() / 1000)
  store.seedHistoryFloor(nowSeconds - 30 * 60)
  await deliver(incoming(ALICE, 'jam buka? (live)'))
  await deliver(incoming(BOB, 'Halo kak', { kind: 'append', timestamp: nowSeconds - 600 }))
  await deliver(incoming(BOB, 'mau pesan 20 kue untuk besok pagi, bisa?', { kind: 'append', timestamp: nowSeconds - 600 }))
  await deliver(incoming('6284444444444@s.whatsapp.net', 'jam buka? (offline)', { kind: 'append', timestamp: nowSeconds - 900 }))
  assert.deepEqual(brain.calls.map(call => call.messages.map(message => message.text)), [
    ['jam buka? (live)'], ['Halo kak'], ['mau pesan 20 kue untuk besok pagi, bisa?'], ['jam buka? (offline)']
  ])
})

test('a late /resume cannot undo a newer /pause; a late /ok cannot approve a newer draft', async t => {
  const { deliver, owner, store, now } = setup(t)
  await owner('/pause')
  await deliver({ id: 'LATE1', chatId: 'self', fromMe: true, isSelfChat: true, text: '/resume', timestamp: Math.floor(now() / 1000) - 600, kind: 'notify' })
  assert.equal(store.paused, true)
  await deliver(incoming(ALICE, 'bisa kue custom?'))
  await deliver({ id: 'LATE2', chatId: 'self', fromMe: true, isSelfChat: true, text: '/ok 1', timestamp: Math.floor(now() / 1000) - 600, kind: 'notify' })
  assert.equal(store.getDraft(1).status, 'pending')
})

test('the owner is told once when the claude CLI version changes', async t => {
  let version = '2.1.283'
  const { transport, deliver, audit } = setup(t, { respond: () => triageResult({ decision: 'escalate' }, { meta: { claudeCodeVersion: version } }) })
  const versionNotices = () => transport.toSelf().filter(text => text.includes('updated itself'))
  await deliver(incoming(ALICE, 'bisa kue custom?'))
  await deliver(incoming(BOB, 'bisa kue custom?'))
  assert.deepEqual(versionNotices(), [], 'the first version seen is only recorded')
  version = '2.1.290'
  await deliver(incoming(ALICE, 'kalau warna pink?'))
  await deliver(incoming(BOB, 'kalau warna pink?'))
  assert.equal(versionNotices().length, 1)
  assert.match(versionNotices()[0], /updated itself from 2\.1\.283 to 2\.1\.290.*npm run selftest/)
  assert.equal(audit().filter(entry => entry.event === 'claude_version_changed').length, 1)
})

test('groups, status and newsletters never reach the brain (raw Baileys shapes through the normalizer)', async t => {
  const { assistant, brain } = setup(t)
  const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net' })
  for (const remoteJid of ['120363000000000000@g.us', 'status@broadcast', '120363111111111111@newsletter', '867051314767696@bot']) {
    const normalized = normalizeUpsert({ key: { remoteJid, id: `R-${remoteJid}`, fromMe: false, participant: ALICE }, message: { conversation: 'jam buka?' }, messageTimestamp: Math.floor(Date.now() / 1000) }, { type: 'notify', meIds })
    assert.ok(normalized.skip)
    if (normalized.message) await assistant.handleMessage(normalized.message)
  }
  await assistant.idle()
  assert.equal(brain.calls.length, 0)
})

test('blocklisted chats are never triaged, and the gate refuses to send to them', async t => {
  const { brain, deliver, assistant } = setup(t, { config: { blocklist: ['0822-2222-2222'] } })
  await deliver(incoming(ALICE, 'jam buka?'))
  assert.equal(brain.calls.length, 0)
  assert.deepEqual(await assistant.gate.sendToCustomer(ALICE, 'hi'), { sent: false, error: 'chat is blocklisted' })
})

test('a phone-number block also stops /ok to a LID chat, and notices show the number next to the pushName', async t => {
  const { transport, deliver, owner, config, audit } = setup(t)
  const LID = '123456789012345@lid'
  await deliver(incoming(LID, 'bisa kue custom?', { chatIdAlt: '6281234567890@s.whatsapp.net', senderName: 'Mama' }))
  assert.match(transport.toSelf()[0], /📝 DRAFT #1 · Mama \(\+6281234567890\)/)
  config.blocklist = ['081234567890'] // added before a restart
  await owner('/ok 1')
  assert.equal(transport.toCustomer().length, 0)
  assert.match(transport.toSelf().at(-1), /Sending draft #1 failed \(chat is blocklisted\)/)
  assert.ok(audit().some(entry => entry.event === 'send_refused_blocked'))
})

test('a LID chat with no known phone number is drafted, not auto-replied, while the blocklist has phone numbers', async t => {
  const { transport, deliver, config, store } = setup(t, { config: { blocklist: ['081234567890'] } })
  const LID = '123456789012345@lid'
  await deliver(incoming(LID, 'jam buka?', { senderName: 'Mama' }))
  assert.equal(transport.toCustomer().length, 0)
  const notice = transport.toSelf().at(-1)
  assert.match(notice, /📝 DRAFT #1 · Mama \(123456789012345@lid\)/)
  assert.match(notice, /Not auto-sent: blocklist_unchecked/)
  assert.match(notice, /add "123456789012345@lid" to blocklist/)

  // Once the number is known (a PN alt, or WhatsApp's LID mapping), the phone entry matches and blocks it.
  store.linkAlt(LID, '6281234567890@s.whatsapp.net')
  await deliver(incoming(LID, 'jam buka lagi?', { senderName: 'Mama' }))
  assert.equal(store.pendingDrafts().length, 1, 'blocked: not even triaged')
  // With a JID entry, or no phone entries at all, nothing is unchecked.
  config.blocklist = ['999999999999999@lid']
  await deliver(incoming('222222222222222@lid', 'jam buka?'))
  assert.equal(transport.toCustomer().length, 1)
})

test('/ok, /edit and /no from self-chat', async t => {
  const { transport, deliver, owner, store } = setup(t)
  await deliver(incoming(ALICE, 'bisa kue custom?'))
  await deliver(incoming(BOB, 'saya sudah transfer'))
  await deliver(incoming('6284444444444@s.whatsapp.net', 'kue ulang tahun 3 tingkat?'))
  assert.match(transport.toSelf().find(text => text.includes('#2')), /📝 DRAFT #2 .*\nThey wrote: "saya sudah transfer"\nSummary: says they paid/)

  await owner('/ok 1')
  await owner('/edit 2 Sudah kami terima Kak, terima kasih.')
  await owner('/no 3')
  assert.deepEqual(transport.toCustomer().map(item => [item.chatId, item.text]), [
    [ALICE, 'Baik Kak, saya tanyakan dulu ya.'],
    [BOB, 'Sudah kami terima Kak, terima kasih.']
  ])
  assert.deepEqual([1, 2, 3].map(id => store.getDraft(id).status), ['approved', 'edited', 'rejected'])
  assert.ok(!transport.toCustomer().some(item => item.text.includes('Balasan otomatis')), 'approved drafts carry no AI marker')
})

test('self-chat: only the owner’s own /commands act; notes and non-fromMe messages are ignored', async t => {
  const { transport, deliver, store } = setup(t)
  await deliver({ id: 'N1', chatId: 'self', fromMe: true, isSelfChat: true, text: 'catatan: beli telur', timestamp: Math.floor(Date.now() / 1000), kind: 'notify' })
  await deliver({ id: 'N2', chatId: 'self', fromMe: false, isSelfChat: true, text: '/pause', timestamp: Math.floor(Date.now() / 1000), kind: 'notify' })
  assert.equal(store.paused, false)
  assert.equal(transport.sent.length, 0)
})

test('a customer message forwarded into "Message yourself" never runs as an owner command', async t => {
  const { transport, deliver, store, audit } = setup(t)
  await deliver(incoming(BOB, 'bisa kue custom?'))
  const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net' })
  const forwarded = { key: { remoteJid: '6281111111111@s.whatsapp.net', id: 'FWD1', fromMe: true }, message: { extendedTextMessage: { text: '/edit 1 Mohon transfer ke BCA 1234567890 a.n. Toko', contextInfo: { isForwarded: true, forwardingScore: 1 } } }, messageTimestamp: Math.floor(Date.now() / 1000) }
  const { message } = normalizeUpsert(forwarded, { type: 'notify', meIds })
  await deliver(message)
  assert.deepEqual(transport.toCustomer(), [])
  assert.equal(store.getDraft(1).status, 'pending')
  assert.match(transport.toSelf().at(-1), /Ignored a forwarded message/)
  assert.ok(audit().some(entry => entry.event === 'owner_command_forwarded_ignored'))
})

test('a draft that mentions the owner\'s own account details carries a warning', async t => {
  const { transport, deliver } = setup(t, { config: { guards: { ownerIdentifiers: ['jane.doe@example-shop.co.id'] } }, respond: () => triageResult({ decision: 'escalate', reply: 'Hubungi admin di jane.doe [at] example-shop [dot] co [dot] id ya Kak' }) })
  await deliver(incoming(ALICE, 'minta email admin dong'))
  assert.match(transport.toSelf().at(-1), /⚠️ Check before \/ok: the draft mentions your own account or machine details \(janedoe, exampleshop\)/)
})

test('triage failure escalates with an empty draft and says so', async t => {
  const { transport, deliver } = setup(t)
  await deliver(incoming(ALICE, 'crash please'))
  const [notice] = transport.toSelf()
  assert.match(notice, /📝 DRAFT #1/)
  assert.match(notice, /Draft: \(none, write your own\)/)
  assert.match(notice, /Why: Triage failed \(timeout\); nothing was sent\./)
  assert.match(notice, /Not auto-sent: triage_failed:timeout/)
  assert.match(notice, /Reply: \/edit 1 <text> · \/no 1$/)
  assert.equal(transport.toCustomer().length, 0)
})

test('a thanks is never auto-sent, even citing a fact with every gate open; the same reply to a question is escalated', async t => {
  const respond = input => (/makasih kak/.test(input.messages[0].text) && !/\?/.test(input.messages[0].text)
    ? triageResult({ decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: ['F1'] })
    : byKeyword(input))
  const { transport, deliver, store } = setup(t, { respond })
  await deliver(incoming(BOB, 'ok makasih kak'))
  await deliver(incoming(ALICE, 'makasih, bisa kirim ke Jakarta?'))
  assert.deepEqual(transport.toCustomer(), [])
  assert.deepEqual([1, 2].map(id => [store.getDraft(id).policyReasons, store.getDraft(id).closing]), [
    [['decision:answer', 'thanks_not_auto_sent'], true],
    [['decision:answer', 'guard:no_facts_used'], false]
  ])
  assert.match(transport.toSelf()[0], /📝 DRAFT #1 .*\nDraft:\nSama-sama, Kak 🙏\n.*\nNot auto-sent: thanks_not_auto_sent\nReply: \/ok 1/s)
  assert.deepEqual(transport.read, [], 'no blue ticks either')
})

test('a guard failure and /pause escalate an answer, with the gate in the notice', async t => {
  const { transport, deliver, owner } = setup(t)
  await deliver(incoming(ALICE, 'cheesecake ada?'))
  assert.match(transport.toSelf().at(-1), /Not auto-sent: guard:unsupported_amount:150000/)
  await owner('/pause')
  await deliver(incoming(BOB, 'jam buka?'))
  assert.match(transport.toSelf().at(-1), /Not auto-sent: paused/)
  assert.equal(transport.toCustomer().length, 0)
})

test('/mute blocks auto-replies in that chat only', async t => {
  const { transport, deliver, owner } = setup(t)
  await deliver(incoming(ALICE, 'jam buka?', { senderName: 'Alice' }))
  await owner('/mute alice')
  await deliver(incoming(ALICE, 'jam buka lagi?', { senderName: 'Alice' }))
  await deliver(incoming(BOB, 'jam buka?'))
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [ALICE, BOB])
  assert.ok(transport.toSelf().some(text => text.includes('Not auto-sent: muted')))
})

test('a mute holds one contact on both addressing forms, and the number names that contact', async t => {
  const { transport, deliver, owner, store } = setup(t)
  const LID = '123456789012345@lid'
  await deliver(incoming(ALICE, 'jam buka?', { senderName: 'Rina' }))
  await deliver(incoming(LID, 'jam buka hari ini?', { chatIdAlt: ALICE, senderName: 'Rina' }))
  await owner('/mute 0822-2222-2222')
  assert.match(transport.toSelf().at(-1), /Muted Rina \(\+6282222222222\)/, 'not "matches Rina, Rina"')
  await deliver(incoming(LID, 'buka hari sabtu?', { chatIdAlt: ALICE, senderName: 'Rina' }))
  assert.equal(transport.toCustomer().length, 2)
  assert.deepEqual(store.getDraft(1).policyReasons, ['decision:answer', 'muted'])

  await owner('/unmute 0822-2222-2222')
  await deliver(incoming(LID, 'buka hari minggu?', { chatIdAlt: ALICE, senderName: 'Rina' }))
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [ALICE, LID, LID])
})

// Answers every thanks with a thanks, as the prompt tells Claude to; the policy turns it into a draft or a skip.
const thanksBack = input => {
  const text = input.messages.map(message => message.text).join(' ')
  if (/alamat/i.test(text)) return triageResult({ decision: 'answer', reply: 'Alamat kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', facts_used: ['F2'] })
  if (/jam|buka/i.test(text)) return triageResult(ANSWER_HOURS)
  if (/^[\p{L}\p{Extended_Pictographic}\s]+$/u.test(text) && !/tolong|kirim|transfer/i.test(text)) return triageResult({ decision: 'answer', reply: 'Sama-sama, Kak 🙏' })
  return triageResult({ decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.' })
}

/** The setup, with messages stamped by its clock a minute apart, and owner commands half a minute after. */
function chatSetup (t, options) {
  const env = setup(t, { respond: thanksBack, ...options })
  const stamp = () => ({ timestamp: Math.floor(env.now() / 1000) })
  const say = async (chatId, text, extra = {}) => { env.advance(60_000); await env.deliver(incoming(chatId, text, { ...stamp(), ...extra })) }
  const command = async text => { env.advance(30_000); await env.owner(text) }
  const skipped = () => env.audit().filter(entry => entry.event === 'decision' && entry.action === 'skip').map(entry => [entry.chatId, entry.text, entry.reasons.at(-1)])
  const reasons = id => env.store.getDraft(id).policyReasons
  return { ...env, stamp, say, command, skipped, reasons }
}

test('live: /ok of a thanks draft sends it and marks its id; the next thanks is skipped, an acknowledgement is drafted', async t => {
  const { transport, store, say, command, skipped, reasons } = chatSetup(t)
  await say(ALICE, 'jam berapa buka kak?')
  await say(ALICE, 'ok makasih kak')
  assert.deepEqual([reasons(1), store.getDraft(1).closing], [['decision:answer', 'thanks_not_auto_sent'], true])
  await command('/ok 1')
  const closing = transport.toCustomer().at(-1)
  assert.equal(closing.text, 'Sama-sama, Kak 🙏')
  assert.ok(store.isClosingReply(closing.id), 'the sent id is marked')
  assert.ok(transport.getHistory(ALICE, 10).some(item => item.id === closing.id && item.fromMe), 'and it is the id the history holds')

  await say(ALICE, '🙏')
  await say(ALICE, 'makasih ya kak')
  assert.deepEqual(skipped(), [[ALICE, '🙏', 'closing_already_sent'], [ALICE, 'makasih ya kak', 'closing_already_sent']])
  assert.deepEqual(store.pendingDrafts(), [], 'no draft for them')
  await say(ALICE, 'iya kak')
  assert.deepEqual(reasons(2), ['decision:answer', 'guard:no_facts_used'], 'an "iya" may answer something: drafted')
  assert.equal(transport.toCustomer().length, 2, 'the hours answer and the approved closing')
})

test('a closing counts once it is sent: a thanks during the send is drafted, the one after it skipped', async t => {
  const { transport, store, owner, advance, stamp, say, skipped } = chatSetup(t)
  await say(ALICE, 'makasih kak')
  let release
  const held = new Promise(resolve => { release = resolve })
  const send = transport.send.bind(transport)
  transport.send = async (chatId, text, options) => {
    if (chatId === 'self') return send(chatId, text, options)
    transport.remember({ id: options.messageId, chatId, fromMe: true, text, ...stamp() }) // the echo arrives first
    await held
    return send(chatId, text, options)
  }
  advance(30_000)
  const approving = owner('/ok 1')
  await say(ALICE, '🙏')
  assert.deepEqual(store.pendingDrafts().map(draft => [draft.id, draft.excerpt]), [[1, 'makasih kak'], [2, '🙏']], 'nothing is closed while the send may still fail')
  release()
  await approving
  const [echo] = transport.getHistory(ALICE, 10).filter(item => item.fromMe)
  assert.ok(store.isClosingReply(echo.id), 'the echo carries the id generated for the send')
  await say(ALICE, 'makasih ya kak')
  assert.deepEqual(skipped(), [[ALICE, 'makasih ya kak', 'closing_already_sent']])
})

test('an acknowledgement or 👍 alone after a closing is a draft', async t => {
  for (const text of ['ok', 'siap kak', '👍']) {
    const { store, say, command, skipped } = chatSetup(t)
    await say(ALICE, 'makasih kak')
    await command('/ok 1')
    await say(ALICE, text)
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.id)], [[], [2]], text)
  }
})

test('/edit and /no of a thanks draft close the chat as well', async t => {
  const { transport, store, say, command, skipped } = chatSetup(t)
  await say(ALICE, 'makasih kak')
  await command('/edit 1 Sama-sama kak, sampai ketemu Sabtu ya')
  assert.ok(store.isClosingReply(transport.toCustomer().at(-1).id), 'the edited text is the closing, whatever it says')
  await say(ALICE, '🙏')

  await say(BOB, 'jam buka kak?')
  await say(BOB, 'ok makasih kak')
  await command('/no 2')
  await say(BOB, 'makasih ya kak 🙏')
  assert.deepEqual(skipped(), [[ALICE, '🙏', 'closing_already_sent'], [BOB, 'makasih ya kak 🙏', 'closing_already_sent']])
  assert.deepEqual(store.pendingDrafts(), [])
})

test('shadow: a thanks draft approved in shadow closes the chat like a send would', async t => {
  const { transport, store, deliver, advance, stamp, say, command, skipped } = chatSetup(t, { config: { mode: 'shadow' } })
  // The owner answered on the phone; the takeover window passes; the customer thanks.
  await deliver({ id: 'OWNER1', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'Bisa kak, diambil Sabtu ya', ...stamp(), kind: 'notify' })
  advance(31 * 60_000)
  await say(ALICE, 'ok makasih kak')
  await command('/ok 1')
  assert.equal(store.getDraft(1).status, 'approved_shadow')
  await say(ALICE, '🙏')
  assert.deepEqual(skipped(), [[ALICE, '🙏', 'closing_already_sent']])
  assert.deepEqual(transport.toCustomer(), [])
})

test('a thanks while another draft of the chat is open is drafted too, without blue ticks', async t => {
  const { transport, store, say, skipped, reasons } = chatSetup(t)
  await say(ALICE, 'kak saya sudah transfer ya')
  for (const text of ['makasih kak', '🙏']) await say(ALICE, text)
  assert.deepEqual(store.pendingDrafts().map(draft => [draft.id, draft.closing]), [[1, false], [2, true], [3, true]])
  assert.deepEqual([reasons(2), reasons(3)], [['decision:answer', 'thanks_not_auto_sent'], ['decision:answer', 'thanks_not_auto_sent']])
  assert.deepEqual([skipped(), transport.toCustomer(), transport.read], [[], [], []])
})

test('drafted after a closing: our side said something new, a file, a quote of an older message, a failed triage', async t => {
  const respond = input => (input.messages[0].text === 'makasih banyak kak' ? { ok: false, error: 'timeout', meta: {} } : thanksBack(input))
  const { transport, store, deliver, advance, stamp, say, command, skipped, reasons } = chatSetup(t, { respond })
  // Another draft is answered after the thanks draft; then the thanks draft is discarded.
  await say(ALICE, 'ok makasih kak')
  await say(ALICE, 'kak brownies masih ada?')
  await command('/edit 2 Bisa kak, mau kami kirim besok pagi?')
  await command('/no 1')
  await say(ALICE, 'makasih kak 🙏')
  assert.deepEqual(reasons(3), ['decision:answer', 'thanks_not_auto_sent'], 'what our side sent after the thanks is newer than its closing')

  await say(BOB, 'makasih kak')
  await command('/ok 4')
  transport.remember({ id: 'PIN', chatId: BOB, fromMe: false, text: '', attachment: 'location', ...stamp() }) // never triaged, only remembered
  await say(BOB, 'makasih kak')
  await say(BOB, '🙏', { quotedText: 'Mau diantar Sabtu kak?' })
  await say(BOB, '🙏', { attachment: 'image' })

  const CAROL = '6284444444444@s.whatsapp.net'
  await say(CAROL, 'makasih kak')
  await command('/ok 8')
  await say(CAROL, 'makasih banyak kak')
  await deliver({ id: 'OWNER1', chatId: CAROL, fromMe: true, isSelfChat: false, text: 'Oh ya kak, besok kami libur', ...stamp(), kind: 'notify' })
  advance(31 * 60_000)
  await say(CAROL, '🙏')

  assert.deepEqual(skipped(), [])
  assert.deepEqual([5, 6, 7, 9, 10].map(id => [store.getDraft(id).excerpt, reasons(id)]), [
    ['makasih kak', ['decision:answer', 'thanks_not_auto_sent']], // after a location pin nobody answered
    ['🙏', ['decision:answer', 'thanks_not_auto_sent']], // quoting an older message
    ['[image] 🙏', ['decision:answer', 'thanks_not_auto_sent', 'attachment:image']],
    ['makasih banyak kak', ['triage_failed:timeout']],
    ['🙏', ['decision:answer', 'thanks_not_auto_sent']] // after the owner's own words on the phone
  ])
  assert.equal(store.getDraft(7).closing, false, 'a thanks with a file closes nothing')
})

test('a restart empties the history: a closing this session stands, one from an earlier session does not', async t => {
  const { transport, store, advance, say, command, skipped } = chatSetup(t)
  await say(ALICE, 'jam buka kak?')
  await say(ALICE, 'ok makasih kak')
  await command('/ok 1')
  transport.history.clear()
  await say(ALICE, '🙏')
  assert.deepEqual(skipped(), [[ALICE, '🙏', 'closing_already_sent']])
  advance(13 * 3_600_000)
  transport.history.clear()
  await say(ALICE, '🙏')
  assert.deepEqual(store.pendingDrafts().map(draft => [draft.id, draft.excerpt]), [[2, '🙏']])
})

test('a greeting the day after a closing is escalated, not skipped', async t => {
  const { transport, store, advance, say, command, reasons } = chatSetup(t)
  await say(ALICE, 'jam berapa buka kak?')
  await say(ALICE, 'ok makasih kak')
  await command('/ok 1')
  advance(20 * 3_600_000)
  await say(ALICE, 'Selamat pagi kak')
  assert.equal(transport.toCustomer().length, 2)
  assert.deepEqual(reasons(2), ['decision:answer', 'guard:no_facts_used'], 'a thanks-back to a greeting cites no fact')
  assert.match(transport.toSelf().at(-1), /📝 DRAFT #2 .*\nThey wrote: "Selamat pagi kak"/s)
  assert.equal(store.getDraft(2).closing, false)
})

test('a 🙏 after a closing is skipped even when Claude escalates it', async t => {
  const respond = input => (input.messages.some(message => message.text === '🙏') ? triageResult({ decision: 'escalate', reply: '🙏' }) : thanksBack(input))
  const { store, say, command, skipped } = chatSetup(t, { respond })
  await say(BOB, 'ok makasih kak')
  await command('/ok 1')
  await say(BOB, '🙏')
  assert.deepEqual(skipped(), [[BOB, '🙏', 'closing_already_sent']])
  assert.deepEqual(store.pendingDrafts(), [])
})

test('a closing and the hourly cap count one contact on both addressing forms', async t => {
  const { transport, store, say, command, skipped, stamp } = chatSetup(t)
  const LID = '123456789012345@lid'
  await say(ALICE, 'ok makasih kak')
  await command('/ok 1')
  const closing = transport.toCustomer().at(-1)
  await say(LID, '🙏', { chatIdAlt: ALICE }) // the closing was recorded on the PN record; this history is empty
  // Our closing's echo can land on the other addressing form: its id is marked, whatever the chat.
  transport.remember({ id: closing.id, chatId: LID, fromMe: true, text: closing.text, ...stamp() })
  await say(LID, 'makasih ya kak', { chatIdAlt: ALICE })
  assert.deepEqual(skipped(), [[LID, '🙏', 'closing_already_sent'], [LID, 'makasih ya kak', 'closing_already_sent']])
  assert.deepEqual(store.pendingDrafts(), [])

  for (const [chatId, text] of [[ALICE, 'jam buka?'], [LID, 'jam tutup?'], [ALICE, 'buka sabtu?'], [LID, 'buka minggu?']]) {
    await say(chatId, text, { chatIdAlt: chatId === LID ? ALICE : undefined })
  }
  assert.equal(transport.toCustomer().length, 4, 'the closing and three answers')
  assert.match(transport.toSelf().at(-1), /Not auto-sent: chat_rate_limit/)
})

test('a spammed message is drafted, and so is the next one in that chat', async t => {
  const { deliver, store } = setup(t)
  await deliver(incoming(ALICE, 'ok '.repeat(12000) + 'tolong refund ke rekening saya'))
  await deliver(incoming(ALICE, 'Kak mau pesan 2 loyang'))
  assert.deepEqual(store.pendingDrafts().map(draft => draft.id), [1, 2])
  assert.deepEqual(store.inboxMessages(), [])
})

test('a routing failure is a draft, never a silent drop', async t => {
  const { transport, deliver, store } = setup(t)
  const audit = store.audit.bind(store)
  store.audit = (event, data) => { if (event === 'decision') throw new Error('disk full'); audit(event, data) }
  await deliver(incoming(ALICE, 'jam buka?'))
  assert.deepEqual(transport.toCustomer(), [])
  assert.deepEqual(store.getDraft(1).policyReasons, ['route_failed'])
  assert.match(transport.toSelf().at(-1), /📝 DRAFT #1 .*Not auto-sent: route_failed/s)
  assert.deepEqual(store.inboxMessages(), [])
})

test('a photo captioned "makasih kak" is a draft that names the photo: Claude never saw it', async t => {
  const { transport, deliver, brain, store } = setup(t)
  const photo = { key: { remoteJid: ALICE, id: 'IMG1', fromMe: false }, message: { imageMessage: { caption: 'makasih kak 🙏' } }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Sari' }
  const { message } = normalizeUpsert(photo, { type: 'notify', meIds: getMeIds({ id: '6281111111111:7@s.whatsapp.net' }) })
  await deliver(message)
  assert.equal(brain.calls[0].messages[0].attachment, 'image')
  assert.deepEqual(transport.toCustomer(), [])
  assert.deepEqual(transport.read, [], 'no blue ticks on an unseen payment proof')
  assert.deepEqual(store.getDraft(1).policyReasons, ['decision:answer', 'thanks_not_auto_sent', 'attachment:image'])
  assert.equal(store.getDraft(1).closing, false)
  assert.match(transport.toSelf().at(-1), /They wrote: "\[image\] makasih kak 🙏"/)
})
