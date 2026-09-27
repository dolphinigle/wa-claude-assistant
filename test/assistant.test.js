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
  assert.equal(sent.text, `🤖 ${ANSWER_HOURS.reply}`, 'the disclosure is one icon in front of the reply')
  assert.deepEqual(sent.quotedRaw, message.raw)
  assert.deepEqual(transport.read, [message.id])
  assert.match(transport.toSelf()[0], /^🤖 ✅ Auto-replied to [^\n]+: "Kami buka/)
  assert.ok(!transport.toSelf()[0].includes('\n'), 'the auto-reply notice is one line')
  assert.ok(store.isSentByBot(sent.id), 'the customer send is loop-guarded')
  assert.equal(store.countChatAutoSends(ALICE, 3_600_000), 1)
})

test('contextMessages 0 gives Claude and the policy no earlier messages at all', async t => {
  const { transport, brain, assistant } = setup(t, { config: { contextMessages: 0 } })
  const ts = Math.floor(Date.now() / 1000)
  transport.remember({ id: 'OLD1', chatId: ALICE, fromMe: true, text: 'van, nanti aku tes ya', timestamp: ts - 60 })
  transport.remember({ id: 'OLD2', chatId: ALICE, fromMe: false, text: 'oke', timestamp: ts - 30 })
  // Not remembered first: the transport's newest item is an older message, as when the batch is missing from it.
  await assistant.handleMessage(incoming(ALICE, 'Kak jam berapa buka?'))
  await assistant.idle()
  assert.deepEqual(brain.calls[0].history, [])
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
  const disclosed = transport.toCustomer().map(item => item.text.startsWith('🤖 '))
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
  assert.deepEqual(await assistant.gate.sendToCustomer(ALICE, 'hi'), { sent: false, notSent: true, error: 'chat is blocklisted' })
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
  assert.ok(!transport.toCustomer().some(item => item.text.includes('🤖')), 'approved drafts carry no AI marker')
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
    [['decision:answer', 'no_question'], true],
    [['decision:answer', 'guard:no_facts_used'], false]
  ])
  assert.match(transport.toSelf()[0], /📝 DRAFT #1 .*\nDraft:\nSama-sama, Kak 🙏\n.*\nNot auto-sent: no_question\nReply: \/ok 1/s)
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
  assert.deepEqual([reasons(1), store.getDraft(1).closing], [['decision:answer', 'no_question'], true])
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
  assert.deepEqual(reasons(2), ['decision:answer', 'no_question'], 'an "iya" may answer something: drafted')
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
  await command('/edit 1 Sama-sama kak, sehat selalu ya')
  assert.ok(store.isClosingReply(transport.toCustomer().at(-1).id), 'the edited text is the closing when it only thanks back')
  await say(ALICE, '🙏')

  await say(BOB, 'jam buka kak?')
  await say(BOB, 'ok makasih kak')
  await command('/no 2')
  await say(BOB, 'makasih ya kak 🙏')
  assert.deepEqual(skipped(), [[ALICE, '🙏', 'closing_already_sent'], [BOB, 'makasih ya kak 🙏', 'closing_already_sent']])
  assert.deepEqual(store.pendingDrafts(), [])
})

test('a thanks draft sent with a question or an offer closes nothing: a yes with a thanks after it is drafted', async t => {
  // Claude's own thanks-back may offer something too; /ok sends it as written.
  const offer = 'Sama-sama Kak 🙏 Mau sekalian dipesankan untuk Sabtu'
  const respond = input => (input.messages.some(message => message.text === 'ok makasih kak') ? triageResult({ decision: 'answer', reply: offer }) : thanksBack(input))
  for (const [approve, answer] of [
    ['/edit 1 Sama-sama kak! Mau sekalian kami siapkan 2 loyang untuk Sabtu?', 'iya kak, makasih 🙏'],
    ['/edit 1 Sama-sama Kak! Tulisan di tartnya "Happy Birthday Rina", sudah benar', 'ok siap makasih'],
    ['/ok 1', '👍 makasih']
  ]) {
    const { transport, store, say, command, skipped } = chatSetup(t, { respond })
    await say(ALICE, 'jam berapa buka kak?')
    await say(ALICE, 'ok makasih kak')
    await command(approve)
    const sent = transport.toCustomer().at(-1)
    assert.equal(store.isClosingReply(sent.id), false, `${approve}: not a closing, it asks for more`)
    await say(ALICE, answer)
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], [answer]], approve)
    assert.equal(transport.toCustomer().length, 2, 'the hours answer and the approved reply')
  }
})

test('our side writing on the other addressing form, or before a restart, reopens a closed chat', async t => {
  const LID = '123456789012345@lid'
  for (const reopen of ['owner on the other form', 'bot on the other form', 'restart']) {
    const { transport, store, deliver, advance, stamp, say, command, skipped } = chatSetup(t)
    await say(LID, 'jam berapa buka kak?', { chatIdAlt: ALICE }) // links the two records
    await say(ALICE, 'ok makasih kak')
    await command('/no 1')
    if (reopen === 'owner on the other form') {
      await deliver({ id: 'OWNER1', chatId: LID, fromMe: true, isSelfChat: false, text: 'Kak, alamat kirimnya masih yang kemarin?', ...stamp(), kind: 'notify' })
      advance(31 * 60_000)
    } else {
      await say(reopen === 'restart' ? ALICE : LID, 'kak brownies bisa dikirim?', { chatIdAlt: reopen === 'restart' ? undefined : ALICE })
      await command('/edit 2 Bisa kak, mau dikirim besok pagi?')
      if (reopen === 'restart') transport.history.clear()
    }
    await say(ALICE, 'iya kak makasih')
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['iya kak makasih']], reopen)
  }
})

test('an answer to a thanks the narrow matcher misses, or to a yes alone, is never auto-sent, whatever fact it cites: it asks nothing', async t => {
  const respond = input => {
    const text = input.messages.map(message => message.text).join(' ')
    if (/Coblong/.test(text)) return triageResult({ decision: 'escalate', reply: 'Bisa Kak. Mau saya kirim besok pagi pakai GoSend?' })
    if (/makasih/.test(text)) return triageResult({ decision: 'answer', reply: 'Sama-sama Kak, sampai jumpa 🙏', facts_used: ['F13'] })
    return triageResult({ decision: 'answer', reply: 'Baik Kak, dikirim pakai GoSend ya, ongkir dibayar pembeli.', facts_used: ['F3'] })
  }
  const { transport, store, say, command, reasons } = chatSetup(t, { respond })
  await say(ALICE, 'makasih kak, sampai jumpa')
  await say(BOB, 'makasihh kak')
  assert.deepEqual([reasons(1), reasons(2)], [['decision:answer', 'no_question'], ['decision:answer', 'no_question']])
  // A yes to the owner's approved offer: Claude's answer would promise a delivery nobody confirmed.
  await say(ALICE, 'Kak brownies bisa dikirim ke Coblong?')
  await command('/ok 3')
  for (const text of ['iya kak', 'oke kak 👍', 'siap kak']) await say(ALICE, text)
  assert.deepEqual([4, 5, 6].map(reasons), Array(3).fill(['decision:answer', 'no_question']))
  assert.deepEqual(transport.toCustomer().map(item => item.text), ['Bisa Kak. Mau saya kirim besok pagi pakai GoSend?'])
  assert.equal(store.pendingDrafts().length, 5)
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
  assert.deepEqual([reasons(2), reasons(3)], [['decision:answer', 'no_question'], ['decision:answer', 'no_question']])
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
  assert.deepEqual(reasons(3), ['decision:answer', 'no_question'], 'what our side sent after the thanks is newer than its closing')

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
    ['makasih kak', ['decision:answer', 'no_question']], // after a location pin nobody answered
    ['🙏', ['decision:answer', 'no_question']], // quoting an older message
    ['[image] 🙏', ['decision:answer', 'no_question', 'attachment:image']],
    ['makasih banyak kak', ['triage_failed:timeout']],
    ['🙏', ['decision:answer', 'no_question']] // after the owner's own words on the phone
  ])
  assert.equal(store.getDraft(7).closing, false, 'a thanks with a file closes nothing')
})

test('the customer writing something new on the other addressing form, or before a restart, reopens a closed chat (skip-safety-r3-1)', async t => {
  const LID = '123456789012345@lid'
  for (const where of ['same form', 'other form', 'restart']) {
    for (const second of ['/no 2', 'pending']) {
      const { transport, store, say, command, skipped } = chatSetup(t)
      await say(ALICE, 'jam berapa buka kak?', { chatIdAlt: LID })
      await say(ALICE, 'makasih kak', { chatIdAlt: LID })
      await command('/no 1')
      await say(where === 'other form' ? LID : ALICE, 'kak kuenya kurang satu ya, tolong dicek', { chatIdAlt: where === 'other form' ? ALICE : LID })
      if (second !== 'pending') await command(second)
      if (where === 'restart') transport.history.clear()
      await say(ALICE, 'makasih kak 🙏', { chatIdAlt: LID })
      assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt).at(-1)], [[], 'makasih kak 🙏'], `${where}, ${second}`)
    }
  }
})

test('live /ok or /edit after a photo, voice note or pin came in while the thanks draft waited: the next thanks is drafted (skip-safety-r2-1)', async t => {
  for (const approve of ['/ok 1', '/edit 1 Sama-sama kak, sehat selalu 🙏']) {
    for (const attachment of ['image', 'audio', 'location', 'other']) {
      const { transport, store, advance, stamp, say, command, skipped } = chatSetup(t)
      await say(ALICE, 'jam berapa buka kak?')
      await say(ALICE, 'ok makasih kak')
      advance(20_000)
      transport.remember({ id: 'IMG1', chatId: ALICE, fromMe: false, text: '', attachment, ...stamp() }) // never triaged, only remembered
      await command(approve)
      assert.ok(store.isClosingReply(transport.toCustomer().at(-1).id), `${approve}: sent as the closing`)
      await say(ALICE, '🙏')
      assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['🙏']], `${approve}, ${attachment}`)
    }
  }
})

test('untriaged content on the other addressing form, or before a restart, is never skipped over (consistency-r2-2)', async t => {
  const LID = '123456789012345@lid'
  for (const where of ['other form', 'restart']) {
    const { transport, store, assistant, advance, stamp, say, command, skipped } = chatSetup(t)
    await say(ALICE, 'jam berapa buka kak?', { chatIdAlt: LID })
    await say(ALICE, 'ok makasih kak', { chatIdAlt: LID })
    await command('/no 1')
    advance(20_000)
    // As the WhatsApp transport reports a captionless photo: remembered in its own chat's history, and noted.
    const photo = { id: 'IMG1', chatId: where === 'other form' ? LID : ALICE, chatIdAlt: where === 'other form' ? ALICE : undefined, ...stamp(), attachment: 'image' }
    transport.remember({ ...photo, fromMe: false, text: '' })
    assistant.noteUntriaged(photo)
    if (where === 'restart') transport.history.clear()
    await say(ALICE, 'makasih kak 🙏')
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['makasih kak 🙏']], where)
  }
})

test('a thanks quoting our older photo or voice note after a closing is drafted (skip-safety-r2-2)', async t => {
  const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net' })
  for (const quotedMessage of [{ imageMessage: { mimetype: 'image/jpeg' } }, { audioMessage: { ptt: true } }, { locationMessage: { degreesLatitude: -6.9 } }]) {
    const { store, deliver, advance, stamp, say, command, skipped } = chatSetup(t)
    await deliver({ id: 'P1', chatId: ALICE, fromMe: true, isSelfChat: false, text: '', attachment: 'image', ...stamp(), kind: 'notify' })
    advance(31 * 60_000)
    await say(ALICE, 'ok makasih kak')
    await command('/ok 1')
    advance(60_000)
    const raw = { key: { remoteJid: ALICE, id: `Q${Math.random()}`, fromMe: false }, message: { extendedTextMessage: { text: 'ok makasih kak 👍', contextInfo: { stanzaId: 'P1', quotedMessage } } }, messageTimestamp: stamp().timestamp, pushName: 'Sari' }
    await deliver(normalizeUpsert(raw, { type: 'notify', meIds }).message)
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['ok makasih kak 👍']], Object.keys(quotedMessage)[0])
  }
})

test('a yes or a thanks with laughter, an emoticon or another spelling, answered with a fact, is never auto-sent (send-path-r2-1, consistency-r2-1)', async t => {
  const respond = input => {
    const text = input.messages.map(message => message.text).join(' ')
    if (/Coblong/.test(text)) return triageResult({ decision: 'escalate', reply: 'Bisa Kak. Mau dikirim pakai GoSend?' })
    return triageResult({ decision: 'answer', reply: 'Baik Kak, dikirim pakai GoSend ya, ongkir dibayar pembeli.', facts_used: ['F3'] })
  }
  const { transport, store, say, command, reasons } = chatSetup(t, { respond })
  await say(ALICE, 'Kak brownies bisa dikirim ke Coblong?')
  await command('/ok 1')
  const texts = ['iya kak hehe', 'iya kak :D', 'ok kak :p', 'siap kak :v', 'iya kak <3', 'Yes please', 'makasih kak hehe 🙏', 'Terima kasih atas bantuannya']
  for (const text of texts) await say(ALICE, text)
  assert.deepEqual(texts.map((_, index) => reasons(index + 2)), Array(texts.length).fill(['decision:answer', 'no_question']))
  assert.deepEqual(transport.toCustomer().map(item => item.text), ['Bisa Kak. Mau dikirim pakai GoSend?'])
  assert.equal(store.pendingDrafts().length, texts.length)
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
  assert.deepEqual(reasons(2), ['decision:answer', 'no_question'], 'a greeting asks nothing: its answer is held')
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
  assert.deepEqual(store.getDraft(1).policyReasons, ['decision:answer', 'no_question', 'attachment:image'])
  assert.equal(store.getDraft(1).closing, false)
  assert.match(transport.toSelf().at(-1), /They wrote: "\[image\] makasih kak 🙏"/)
})

test('after a /no or a shadow /ok of a thanks, a yes with a thanks may answer our question before it: drafted; a plain thanks is skipped (skip-safety-r3-2)', async t => {
  for (const mode of ['live', 'shadow']) {
    for (const text of ['iya kak makasih', '👍 makasih kak', 'ok siap, makasih', 'perfect, thanks', 'makasih kak 🙏']) {
      const { store, deliver, advance, stamp, say, command, skipped } = chatSetup(t, { config: { mode } })
      if (mode === 'live') {
        await say(ALICE, 'kak brownies bisa dikirim')
        await command('/edit 1 Bisa kak, mau diantar jam 5 sore')
      } else {
        // Shadow sends nothing to the chat: the owner asked on the phone, and the takeover window passed.
        await deliver({ id: 'OWNER1', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'Bisa kak, mau diantar jam 5 sore', ...stamp(), kind: 'notify' })
        advance(31 * 60_000)
      }
      await say(ALICE, 'makasih kak')
      const thanksDraft = store.pendingDrafts().at(-1)
      assert.equal(thanksDraft.closing, true)
      await command(`${mode === 'live' ? '/no' : '/ok'} ${thanksDraft.id}`)
      await say(ALICE, text)
      const expected = text === 'makasih kak 🙏' ? [[[ALICE, text, 'closing_already_sent']], []] : [[], [text]]
      assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], expected, `${mode}: ${text}`)
    }
  }
})

test('after a /no or a shadow /ok of a thanks, a "ya" with a thanks, alone or as a burst, is drafted: it may be the yes to our offer (skip-safety-r1-1)', async t => {
  for (const mode of ['live', 'shadow']) {
    for (const burst of [['ya kak, makasih'], ['ya deh makasih kak'], ['ya', 'makasih kak']]) {
      const { store, transport, brain, assistant, deliver, advance, stamp, say, command, skipped } = chatSetup(t, { config: { mode, debounceMs: 100 } })
      if (mode === 'live') {
        await say(ALICE, 'kak brownies bisa dikirim')
        await command('/edit 1 Bisa kak, mau diantar besok sore')
      } else {
        await deliver({ id: 'OWNER1', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'Bisa kak, mau diantar besok sore', ...stamp(), kind: 'notify' })
        advance(31 * 60_000)
      }
      await say(ALICE, 'makasih kak')
      await command(`${mode === 'live' ? '/no' : '/ok'} ${store.pendingDrafts().at(-1).id}`)
      advance(60_000)
      for (const text of burst) {
        const message = incoming(ALICE, text, stamp())
        transport.remember(message)
        await assistant.handleMessage(message)
      }
      await assistant.idle()
      assert.equal(brain.calls.at(-1).messages.length, burst.length, 'triaged as one burst')
      assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], [burst.join(' / ')]], `${mode}: ${burst}`)
    }
  }
})

test('with the local clock behind WhatsApp\'s, a reply sent after a thanks still counts as newer: the next thanks is drafted (skip-safety-r1-3)', async t => {
  const SKEW_MS = 90_000 // WhatsApp's clock runs this far ahead of the local one
  for (const flow of ['/edit of the thanks draft', '/ok of an older draft, then /no of the thanks']) {
    const { store, advance, now, deliver, command, skipped } = chatSetup(t)
    const say = async text => { advance(60_000); await deliver(incoming(ALICE, text, { timestamp: Math.floor((now() + SKEW_MS) / 1000) })) }
    if (flow === '/edit of the thanks draft') {
      await say('makasih kak')
      await command('/edit 1 Sama-sama kak! Mau sekalian pesan untuk Sabtu?') // asks something: not a closing reply
    } else {
      await say('kak brownies bisa dikirim')
      await say('makasih kak')
      await command('/ok 1')
      await command('/no 2')
    }
    await say('makasih kak 🙏')
    assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['makasih kak 🙏']], flow)
  }
})

test('a thanks quoting our question from before a discarded thanks is drafted: only a quote of our closing reply is skipped (skip-safety-r3-1)', async t => {
  const { transport, store, say, command, skipped } = chatSetup(t)
  await say(ALICE, 'kak brownies bisa dikirim')
  await command('/edit 1 Bisa kak, mau diantar jam 5 sore?')
  const question = transport.toCustomer().at(-1)
  await say(ALICE, 'makasih kak')
  await command('/no 2')
  await say(ALICE, 'makasih kak 🙏', { quotedId: question.id, quotedText: question.text })
  assert.deepEqual([skipped(), store.pendingDrafts().map(draft => draft.excerpt)], [[], ['makasih kak 🙏']])
})

test('a thanks or a yes that asks nothing is never auto-answered, whatever its words; a question with a thanks still is (send-path-r3-1, send-path-r3-2)', async t => {
  // Claude slips: it cites a fact on a message that only thanks or agrees.
  const respond = input => {
    const text = input.messages.map(message => message.text).join(' ')
    if (/dimana/.test(text)) return triageResult({ decision: 'answer', reply: 'Alamat kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', facts_used: ['F2'] })
    if (/berapa/.test(text)) return triageResult(ANSWER_HOURS)
    if (/makasih|thanks|sama2/i.test(text)) return triageResult({ decision: 'answer', reply: 'Terima kasih, Kak 🙏 Pemesanan berikutnya bisa lewat chat WhatsApp ini ya.', facts_used: ['F13'] })
    return triageResult({ decision: 'answer', reply: 'Siap Kak, ditunggu ya. Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', facts_used: ['F1'] })
  }
  const { transport, store, say } = chatSetup(t, { respond })
  const held = ['makasih bang', 'makasih mba', 'makasih kk', 'thanks bro', 'Makasih kak, semangat', 'thanks so much, have a good one', 'Sama2 kak, makasih juga 🙏',
    'Oke kak siap, saya tunggu 🙏', 'iya kak betul', 'gapapa kak', 'siap bos', 'ok kk', 'okeh kak', 'ok kak nanti saya ke sana', 'siap kak ditunggu kabarnya']
  // One chat each: the hourly cap must not be what holds them.
  const chatOf = index => `62855500000${String(index).padStart(2, '0')}@s.whatsapp.net`
  for (const [index, text] of held.entries()) await say(chatOf(index), text)
  assert.deepEqual(transport.toCustomer(), [])
  for (const [index, text] of held.entries()) {
    assert.deepEqual(store.getDraft(index + 1).policyReasons, ['decision:answer', 'no_question'], text)
  }
  for (const text of ['makasih bang, buka jam berapa?', 'Kak alamatnya dimana ya, makasih']) await say(BOB, text)
  assert.equal(transport.toCustomer().length, 2, 'a question is answered, thanks or not')
})

test('a draft from a LID chat whose number is unknown shows the blocklist hint, a thanks or an escalation too (consistency-r3-1)', async t => {
  const { transport, deliver } = setup(t, { config: { blocklist: ['081234567890'] } })
  const LID = '123456789012345@lid'
  for (const text of ['makasih kak 🙏', 'kak saya sudah transfer']) {
    await deliver(incoming(LID, text, { senderName: 'Mama' }))
    assert.match(transport.toSelf().at(-1), /add "123456789012345@lid" to blocklist/, text)
  }
  assert.equal(transport.toCustomer().length, 0)
})

// --- allowChats: a live test with one contact leaves every other chat alone ---------------------------------------

const LUKI = '6281293850000@s.whatsapp.net'
const onlyLuki = () => ({ config: { allowChats: ['081293850000'] } })
/** Whether data/state.json holds `what` anywhere. */
const stateMentions = (store, what) => readFileSync(store.file, 'utf8').includes(what)
const notAllowedSkips = audit => audit().filter(entry => entry.event === 'skip_not_allowed').map(({ ts, ...entry }) => entry)

test('allowChats: the listed chat is answered and drafted as today; another chat gets no Claude call, draft, notice, read receipt or record, and no text in the audit', async t => {
  const { transport, deliver, owner, brain, store, audit } = setup(t, onlyLuki())
  await deliver(incoming(LUKI, 'Kak jam berapa buka?'))
  await deliver(incoming(LUKI, 'bisa kue custom unicorn?'))
  await owner('/ok 1')
  assert.equal(brain.calls.length, 2)
  assert.deepEqual(transport.toCustomer().map(item => [item.chatId, item.text.endsWith(ANSWER_HOURS.reply)]), [[LUKI, true], [LUKI, false]], 'auto-answered, then the draft sent by /ok')
  const before = { self: transport.toSelf().length, read: transport.read.length }

  const bob = [incoming(BOB, 'Kak jam berapa buka?'), incoming(BOB, 'saya sudah transfer, tolong dicek', { attachment: 'image' })]
  for (const message of bob) await deliver(message)
  assert.equal(brain.calls.length, 2, 'no Claude call')
  assert.deepEqual([transport.toCustomer().length, transport.toSelf().length, transport.read.length, store.pendingDrafts().length], [2, before.self, before.read, 0])
  assert.equal(store.existingChat(BOB), undefined, 'no chat record')
  assert.deepEqual(store.inboxMessages(), [])
  assert.ok(!stateMentions(store, '6283333333333') && !bob.some(message => stateMentions(store, `"${message.id}"`)), 'state.json keeps nothing of that chat, not even its message ids')
  assert.deepEqual(notAllowedSkips(audit), [{ event: 'skip_not_allowed', chatId: BOB }, { event: 'skip_not_allowed', chatId: BOB }])
  assert.ok(!readFileSync(store.auditFile, 'utf8').includes('transfer'), 'never the text')
})

test('allowChats: the owner\'s own reply in another chat starts no takeover and writes nothing, nor does a photo there', async t => {
  const { transport, deliver, assistant, store, config, audit, now } = setup(t)
  const CAROL = '6284444444444@s.whatsapp.net'
  await deliver(incoming(BOB, 'bisa kue custom?')) // a draft and a chat record from before the list was set
  config.allowChats = ['081293850000']
  const record = structuredClone(store.existingChat(BOB))
  const notices = transport.toSelf().length
  const mine = (id, chatId) => ({ id, chatId, fromMe: true, isSelfChat: false, text: 'bisa kak, sebentar ya', timestamp: Math.floor(now() / 1000), kind: 'notify' })
  await deliver(mine('OWN1', BOB))
  await deliver(mine('OWN2', CAROL))
  assistant.noteUntriaged({ id: 'IMG1', chatId: BOB, timestamp: Math.floor(now() / 1000), attachment: 'image' }) // as the transport reports it
  await assistant.idle()
  assert.equal(store.getDraft(1).status, 'pending', 'no takeover cancelled the draft')
  assert.deepEqual(store.existingChat(BOB), record, 'no ownerRepliedAt, takeoverUntil or lastUntriagedAt')
  assert.equal(store.existingChat(CAROL), undefined)
  assert.equal(transport.toSelf().length, notices, 'no notice')
  assert.ok(!audit().some(entry => entry.event === 'human_takeover'))
  assert.deepEqual(notAllowedSkips(audit).map(entry => entry.chatId), [BOB, CAROL, BOB])
})

test('allowChats: "Message yourself" still takes every command, and /status shows the list', async t => {
  const { transport, owner, store } = setup(t, onlyLuki())
  await owner('/status')
  assert.match(transport.toSelf().at(-1), /\nOnly these chats \(allowChats\): 081293850000\n/)
  await owner('/pause')
  assert.equal(store.paused, true)
  const unlisted = setup(t)
  await unlisted.owner('/status')
  assert.doesNotMatch(unlisted.transport.toSelf().at(-1), /allowChats/, 'without the list, /status is as before')
})

test('allowChats: a LID chat matches through its alt or its linked PN record; one with no known number is ignored and the audit names the LID', async t => {
  const { transport, deliver, brain, store, config, audit, now } = setup(t, { config: { allowChats: ['+62 812-3456-7890'] } })
  const LID = '123456789012345@lid'
  const PN = '6281234567890@s.whatsapp.net'
  const live = () => ({ timestamp: Math.floor(now() / 1000) })
  await deliver(incoming(LID, 'jam buka?', { chatIdAlt: PN, ...live() })) // the alt the message carried
  await deliver(incoming(LID, 'buka hari minggu?', live())) // no alt: the one the chat record kept
  assert.equal(brain.calls.length, 2)
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [LID, LID])
  await deliver({ id: 'OWN1', chatId: PN, fromMe: true, isSelfChat: false, text: 'bentar ya kak', ...live(), kind: 'notify' })
  assert.ok(store.chat(LID).takeoverUntil > now(), 'the owner\'s reply on the PN form is a takeover of the LID chat')

  const UNKNOWN = '999999999999999@lid'
  await deliver(incoming(UNKNOWN, 'jam buka?', live()))
  assert.equal(brain.calls.length, 2, 'fail closed: no number, so it cannot be the listed one')
  assert.equal(store.existingChat(UNKNOWN), undefined)
  assert.deepEqual(notAllowedSkips(audit), [{ event: 'skip_not_allowed', chatId: UNKNOWN }])
  config.allowChats.push(UNKNOWN) // what the owner does after reading that line
  await deliver(incoming(UNKNOWN, 'jam buka?', live()))
  assert.equal(brain.calls.length, 3)
})

test('allowChats: the owner\'s reply on a LID of unknown number holds the bot back once the listed contact writes on either form (send-path-r2-4)', async t => {
  for (const customerOn of ['PN, with the LID as alt', 'the LID, with the PN as alt']) {
    const { transport, assistant, brain, store, advance, now, audit } = setup(t, { config: { allowChats: ['082222222222'] } })
    const LID = '111111@lid'
    const meIds = getMeIds({ id: '6281111111111:7@s.whatsapp.net' })
    // The echo of the owner's phone reply carries the owner's own number as its alt, which is dropped: no known number.
    const { message: reply } = normalizeUpsert({ key: { remoteJid: LID, remoteJidAlt: '6281111111111@s.whatsapp.net', id: 'OWN1', fromMe: true },
      message: { conversation: 'bisa kak, sebentar ya' }, messageTimestamp: Math.floor(now() / 1000) }, { type: 'notify', meIds })
    assert.equal(reply.chatIdAlt, undefined)
    await assistant.handleMessage(reply)
    assert.deepEqual([store.existingChat(LID), audit().filter(entry => entry.event === 'skip_not_allowed').length], [undefined, 1], `${customerOn}: nothing written yet`)

    advance(60 * 1000)
    const question = customerOn.startsWith('PN')
      ? incoming(ALICE, 'kak jam berapa buka?', { chatIdAlt: LID, timestamp: Math.floor(now() / 1000) })
      : incoming(LID, 'kak jam berapa buka?', { chatIdAlt: ALICE, timestamp: Math.floor(now() / 1000) })
    await assistant.handleMessage(question)
    await assistant.idle()
    assert.deepEqual([brain.calls.length, transport.toCustomer().length], [0, 0], `${customerOn}: the owner is mid-conversation`)
    assert.ok(store.chat(ALICE).takeoverUntil > now() && store.chat(LID).takeoverUntil > now(), customerOn)
    assert.equal(store.chat(LID).ownerRepliedAt, reply.timestamp * 1000, customerOn)
  }
})

test('allowChats: the owner\'s reply on a LID whose number is known and not listed is not held (send-path-r2-4)', async t => {
  const { transport, deliver, assistant, brain, store, config, now } = setup(t)
  const LID = '222222@lid'
  await deliver(incoming(LID, 'halo kak', { chatIdAlt: BOB, timestamp: Math.floor(now() / 1000) })) // links Bob's two forms
  config.allowChats = ['082222222222']
  const calls = brain.calls.length
  await assistant.handleMessage({ id: 'OWN1', chatId: LID, fromMe: true, isSelfChat: false, text: 'iya kak', timestamp: Math.floor(now() / 1000), kind: 'notify' })
  config.allowChats.push('083333333333') // Bob listed later: the reply was never held, so no takeover shows up
  await deliver(incoming(BOB, 'kak jam berapa buka?', { chatIdAlt: LID, timestamp: Math.floor(now() / 1000) }))
  assert.equal(brain.calls.length, calls + 1)
  assert.equal(transport.toCustomer().length, 1)
  assert.equal(store.chat(BOB).takeoverUntil ?? 0, 0)
})

test('allowChats: the send gate refuses another chat, so /ok or /edit of a draft from before the list leaves it pending', async t => {
  for (const mode of ['live', 'shadow']) {
    const { transport, deliver, owner, assistant, store, config, audit } = setup(t, { config: { mode } })
    await deliver(incoming(BOB, 'bisa kue custom?'))
    config.allowChats = ['081293850000'] // set before a restart
    const record = structuredClone(store.existingChat(BOB))
    await owner('/ok 1')
    assert.match(transport.toSelf().at(-1), /Sending draft #1 failed \(chat is not in allowChats\)\. It is still pending\./, mode)
    await owner('/edit 1 bisa kak')
    assert.deepEqual(transport.toCustomer(), [], mode)
    assert.equal(store.getDraft(1).status, 'pending', mode)
    assert.deepEqual(store.existingChat(BOB), record, `${mode}: not even lastSentAt`)
    assert.deepEqual(await assistant.gate.sendToCustomer(BOB, 'halo'), { sent: false, notSent: true, error: 'chat is not in allowChats' }, mode)
    assert.deepEqual(audit().filter(entry => entry.event === 'send_refused_not_allowed').map(entry => entry.source), ['approved', 'edited', undefined], mode)
  }
})

test('allowChats: messages of another chat left in the inbox before a restart are dropped, never triaged or listed', async t => {
  const { assistant, store, brain, transport, audit, now } = setup(t, onlyLuki())
  const nowSeconds = Math.floor(now() / 1000)
  const bob = incoming(BOB, 'bisa kue custom?', { timestamp: nowSeconds - 60 })
  const oldBob = incoming(BOB, 'halo kak, masih buka?', { timestamp: nowSeconds - 3 * 3600 })
  const luki = incoming(LUKI, 'bisa kue custom?', { timestamp: nowSeconds - 60 })
  for (const message of [bob, oldBob, luki]) store.addToInbox(message)
  assistant.recoverInbox()
  await assistant.idle()
  assert.deepEqual(brain.calls.map(call => call.messages.map(message => message.id)), [[luki.id]])
  assert.ok(!transport.toSelf().some(text => text.includes('6283333333333') || text.includes('masih buka')), 'not listed as a message to answer yourself')
  assert.deepEqual(store.inboxMessages(), [])
  assert.deepEqual(audit().find(entry => entry.event === 'inbox_recovered').notAllowed, [oldBob.id, bob.id])
})

// --- the escalation placeholder (owner decision 2026-09-27) ---------------------------------------------------------

const PLACEHOLDER_ID = '🤖 Halo Kak, tunggu sebentar ya 🙏'
const PLACEHOLDER_EN = '🤖 Hi! One moment please 🙏'
// A custom cake or a complaint is a waiting customer; the rest as byKeyword (whose escalations say nothing about it).
const waiting = input => {
  const text = input.messages.map(message => message.text).join(' ')
  if (/kue|cake|kecewa/i.test(text)) return triageResult({ decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.', summary: 'custom order', customer_waiting: true })
  return byKeyword(input)
}
function placeholderSetup (t, options = {}) {
  const env = setup(t, { respond: waiting, ...options })
  const stamp = () => ({ timestamp: Math.floor(env.now() / 1000) })
  const say = async (chatId, text, extra = {}) => { env.advance(60_000); await env.deliver(incoming(chatId, text, { ...stamp(), ...extra })) }
  const placeholders = () => env.transport.toCustomer().filter(item => item.text === PLACEHOLDER_ID || item.text === PLACEHOLDER_EN)
  const withheld = () => env.audit().filter(entry => entry.event === 'decision' && entry.action === 'escalate').map(entry => entry.placeholderWithheld)
  return { ...env, stamp, say, placeholders, withheld }
}

test('placeholder: a waiting customer\'s escalation gets one after its draft, in their language, unquoted, unread, counted in the caps', async t => {
  const { transport, store, say, placeholders, audit } = placeholderSetup(t)
  const send = transport.send.bind(transport)
  const draftsAtSend = []
  transport.send = async (chatId, text, options) => {
    if (chatId !== 'self') draftsAtSend.push(store.pendingDrafts().map(draft => draft.id))
    return send(chatId, text, options)
  }
  await say(ALICE, 'Kak bisa pesan kue custom unicorn untuk Sabtu?', { raw: { key: { id: 'raw' } } })
  await say(BOB, 'Can you make a unicorn cake for 40 people next Saturday? How much would it be?')
  assert.deepEqual(transport.toCustomer().map(item => [item.chatId, item.text, item.quotedRaw]), [[ALICE, PLACEHOLDER_ID, undefined], [BOB, PLACEHOLDER_EN, undefined]])
  assert.deepEqual(draftsAtSend, [[1], [1, 2]], 'each went out once its draft existed')
  assert.deepEqual(transport.read, [], 'the owner has not seen the message: no blue ticks')
  assert.deepEqual([store.countChatAutoSends(ALICE, 3_600_000), store.countAutoSends(24 * 3_600_000)], [1, 2])
  assert.ok(placeholders().every(item => store.isSentByBot(item.id)), 'loop-guarded')
  const notices = transport.toSelf()
  assert.match(notices[0], /^🤖 📝 DRAFT #1 .*\nThey wrote: "Kak bisa pesan kue custom unicorn untuk Sabtu\?"\n↩️ They got: 🤖 Halo Kak, tunggu sebentar ya 🙏\nSummary:/)
  assert.match(notices[1], /\n↩️ They got: 🤖 Hi! One moment please 🙏\n/)
  assert.deepEqual(store.getDraft(1).placeholder, { text: PLACEHOLDER_ID, status: 'sent', at: store.getDraft(1).placeholder.at })
  assert.deepEqual(audit().filter(entry => entry.event === 'sent_to_customer').map(entry => [entry.source, entry.draftId]), [['placeholder', 1], ['placeholder', 2]])
  assert.ok(!notices.join('\n').includes('customer_not_waiting'), 'why one was withheld goes to the audit, not the notice')
})

// Owner decision (2026-09-27, live test: a customer's "Hai" met silence while its draft waited): a customer's greeting
// alone waits for the owner. Family's greeting should not, but only the prompt keeps Claude's flag off for it: this fake
// brain sets the flag by name, and no eval fixture has a family greeting yet (consistency-r1-4).
test('placeholder: a customer\'s greeting gets exactly one, the new text; a greeting Claude flags not waiting gets none and its notice shows none', async t => {
  const respond = input => {
    if (input.chat.name === 'Mama') return triageResult({ decision: 'escalate', reply: 'Pagi juga, Ma', summary: 'greeting from mom', customer_waiting: false })
    return triageResult({ decision: 'escalate', reply: 'Halo Kak, ada yang bisa dibantu?', summary: 'customer greeting', customer_waiting: true })
  }
  const { transport, store, say, placeholders, withheld } = placeholderSetup(t, { respond })
  const MAMA = '6284444444444@s.whatsapp.net'
  store.updateChat(MAMA, { name: 'Mama' })
  await say(ALICE, 'Hai')
  await say(ALICE, 'Halo kak')
  await say(MAMA, 'Pagi kak', { senderName: 'Mama' })
  assert.deepEqual(placeholders().map(item => [item.chatId, item.text]), [[ALICE, '🤖 Halo Kak, tunggu sebentar ya 🙏']], 'one per open-draft period, none for Mama')
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [ALICE], 'nothing else reached anyone')
  assert.deepEqual(withheld(), [[], ['placeholder_already_sent'], ['customer_not_waiting']])
  assert.match(transport.toSelf()[0], /^🤖 📝 DRAFT #1 .*\nThey wrote: "Hai"\n↩️ They got: 🤖 Halo Kak, tunggu sebentar ya 🙏\n/)
  assert.doesNotMatch(transport.toSelf()[2], /↩️/, 'the notice for Mama says nothing went out')
})

test('placeholder: a greeting too short to tell its language gets the language of Claude\'s draft, Indonesian when neither tells (correctness-r2-3)', async t => {
  const replies = { 'Hi!': 'Hi! How can I help you?', 'Good morning': 'Good morning! What can I do for you?', Hai: 'Halo Kak, ada yang bisa dibantu?', Hello: '' }
  const respond = input => triageResult({ decision: 'escalate', reply: replies[input.messages[0].text], summary: 'customer greeting', customer_waiting: true })
  const { owner, say, placeholders, advance } = placeholderSetup(t, { respond })
  for (const [index, text] of Object.keys(replies).entries()) {
    await say(ALICE, text)
    await owner(`/no ${index + 1}`) // ends the open-draft period, so the next greeting gets one again
    advance(3_600_000) // and clears the hourly cap
  }
  assert.deepEqual(placeholders().map(item => item.text), [PLACEHOLDER_EN, PLACEHOLDER_EN, PLACEHOLDER_ID, PLACEHOLDER_ID])
})

test('placeholder: drafts only (autoSend.enabled false) sends a customer nothing automated; /ok still sends the draft', async t => {
  // Both customers wait: only the switch holds the placeholder, and the answer too.
  const respond = input => (/jam/.test(input.messages[0].text) ? triageResult({ ...ANSWER_HOURS, customer_waiting: true }) : waiting(input))
  const { transport, owner, say, placeholders, withheld, audit } = placeholderSetup(t, { respond, config: { autoSend: { enabled: false } } })
  await say(ALICE, 'Kak bisa pesan kue custom unicorn untuk Sabtu?')
  await say(BOB, 'jam berapa buka kak?')
  assert.deepEqual([placeholders(), transport.toCustomer()], [[], []])
  assert.deepEqual(withheld(), [['auto_send_disabled'], ['auto_send_disabled']])
  assert.deepEqual(audit().filter(entry => entry.event === 'decision').map(entry => entry.reasons), [['decision:escalate'], ['decision:answer', 'auto_send_disabled']])
  assert.ok(transport.toSelf().every(text => !text.includes('↩️')))
  await owner('/ok 1')
  assert.deepEqual(transport.toCustomer().map(item => [item.chatId, item.text]), [[ALICE, 'Baik Kak, saya cek dulu ya.']], 'the owner\'s approved draft, no marker')
})

test('placeholder: one per open draft; after /ok or /no a new escalation gets one again', async t => {
  const { owner, say, placeholders, withheld } = placeholderSetup(t)
  await say(ALICE, 'bisa kue custom unicorn?')
  await say(ALICE, 'kue ulang tahun 3 tingkat juga bisa?')
  assert.equal(placeholders().length, 1, 'the second escalation meets the first draft still open')
  await owner('/no 1')
  await say(ALICE, 'kue tart 2 tingkat bisa?')
  assert.equal(placeholders().length, 1, 'draft #2, from while the placeholder stood, is still open: the customer is still told to wait')
  await owner('/ok 2')
  await owner('/no 3')
  await say(ALICE, 'kue ulang tahun lagi bisa kak?')
  assert.equal(placeholders().length, 2, 'nothing open: a new one')
  assert.deepEqual(withheld(), [[], ['placeholder_already_sent'], ['placeholder_already_sent'], []])
  await owner('/no 4')
  await say(ALICE, 'kue ulang tahun 2 tingkat bisa kak?')
  assert.equal(placeholders().length, 3, 'after /no too')
})

test('placeholder: none for customer_waiting false or missing, a thanks, a triage failure, while paused, or with placeholder.enabled false', async t => {
  const respond = input => {
    const text = input.messages.map(message => message.text).join(' ')
    if (/makasih/.test(text)) return triageResult({ decision: 'escalate', reply: 'Sama-sama Kak', customer_waiting: true })
    if (/mama/.test(text)) return triageResult({ decision: 'escalate', reply: 'Iya ma', customer_waiting: false })
    return waiting(input)
  }
  const { transport, owner, say, withheld, store } = placeholderSetup(t, { respond })
  await say(ALICE, 'nak, ini mama. papa masuk IGD')
  await say(BOB, 'saya sudah transfer') // byKeyword: no customer_waiting at all
  await say('6284444444444@s.whatsapp.net', 'makasih kak 🙏')
  await say('6285555555555@s.whatsapp.net', 'crash please')
  await owner('/pause')
  await say('6286666666666@s.whatsapp.net', 'bisa kue custom?')
  await owner('/resume')
  const off = placeholderSetup(t, { respond, config: { placeholder: { enabled: false } } })
  await off.say(ALICE, 'bisa kue custom?')
  assert.deepEqual([transport.toCustomer(), off.transport.toCustomer()], [[], []])
  assert.deepEqual(withheld(), [['customer_not_waiting'], ['customer_not_waiting'], ['thanks'], ['triage_failed'], ['paused']])
  assert.deepEqual(off.withheld(), [['placeholder_disabled']])
  assert.ok(store.pendingDrafts().every(draft => !draft.placeholder))
})

test('placeholder: none for backlog, a muted, blocked or blocklist-unchecked chat, over a cap, or during a takeover', async t => {
  const { transport, store, config, brain, assistant, say, deliver, withheld, now } = placeholderSetup(t, { config: { autoSend: { maxPerChatPerHour: 1 }, blocklist: ['081234567890'] } })
  store.seedHistoryFloor(Math.floor(now() / 1000) - 3600)
  await deliver(incoming(ALICE, 'bisa kue custom?', { kind: 'append', timestamp: Math.floor(now() / 1000) - 10 * 60 }))
  store.updateChat(BOB, { muted: true })
  await say(BOB, 'kue tart bisa?')
  await say('123456789012345@lid', 'bisa kue custom?')
  // Blocked after the message was accepted: the policy sees it at routing time.
  const release = brain.hold()
  await assistant.handleMessage(incoming('6287777777777@s.whatsapp.net', 'bisa kue custom?', { timestamp: Math.floor(now() / 1000) }))
  config.blocklist = ['081234567890', '087777777777']
  release()
  await assistant.idle()
  // The hourly cap: an auto-reply took the chat's one slot.
  await say(LUKI, 'jam berapa buka kak?')
  await say(LUKI, 'bisa kue custom?')
  assert.deepEqual(withheld(), [['backlog'], ['muted'], ['blocklist_unchecked'], ['blocked'], ['chat_rate_limit']])
  assert.deepEqual(transport.toCustomer().map(item => item.chatId), [LUKI], 'only the auto-reply')

  // During a takeover nothing is even triaged.
  const calls = brain.calls.length
  await deliver(incoming(LUKI, 'bentar ya kak', { fromMe: true, timestamp: Math.floor(now() / 1000) }))
  await say(LUKI, 'bisa kue ulang tahun?')
  assert.deepEqual([brain.calls.length, transport.toCustomer().length], [calls, 1])
})

test('placeholder: the send gate refuses a chat outside allowChats; a failed send leaves no trace but the audit', async t => {
  const { transport, store, config, brain, assistant, say, placeholders, audit, now } = placeholderSetup(t)
  const release = brain.hold()
  await assistant.handleMessage(incoming(ALICE, 'bisa kue custom?', { timestamp: Math.floor(now() / 1000) }))
  config.allowChats = [BOB]
  release()
  await assistant.idle()
  config.allowChats = []
  transport.down = true
  await say(BOB, 'bisa kue custom?')
  transport.down = false
  assert.deepEqual(placeholders(), [])
  assert.deepEqual(audit().filter(entry => entry.source === 'placeholder').map(entry => entry.event), ['send_refused_not_allowed', 'send_failed'])
  assert.deepEqual([store.getDraft(1).placeholder, store.getDraft(2).placeholder], [undefined, undefined])
  assert.deepEqual([store.countAutoSends(24 * 3_600_000), store.chat(BOB).lastDisclosureAt], [0, 0], 'the cap slot is given back, no disclosure counted')
  assert.ok(!transport.toSelf().some(text => text.includes('↩️')), 'the notices say nothing went out')
  await say(BOB, 'kue tart bisa?')
  assert.equal(placeholders().length, 1, 'the next escalation may try again')
})

test('placeholder: shadow mode records it and sends nothing; the notice says it would have', async t => {
  const { transport, store, say, audit } = placeholderSetup(t, { config: { mode: 'shadow' } })
  await say(ALICE, 'bisa kue custom?')
  assert.deepEqual(transport.toCustomer(), [])
  assert.match(transport.toSelf()[0], /\n↩️ \[SHADOW\] would have sent: 🤖 Halo Kak, tunggu sebentar ya 🙏\n/)
  assert.equal(store.getDraft(1).placeholder.status, 'shadow')
  assert.deepEqual(audit().filter(entry => entry.event === 'shadow_send_suppressed').map(entry => [entry.source, entry.text]), [['placeholder', PLACEHOLDER_ID]])
  assert.equal(store.countChatAutoSends(ALICE, 3_600_000), 1, 'counted, as shadow auto-replies are')
  assert.ok(store.chat(ALICE).shadowDisclosureAt > 0 && store.chat(ALICE).lastDisclosureAt === 0)
})

test('placeholder: it is the session\'s AI disclosure, its echo starts no takeover, and a thanks after it is not skipped', async t => {
  const { transport, store, deliver, owner, say, stamp, audit } = placeholderSetup(t)
  await say(ALICE, 'makasih kak')
  await owner('/no 1') // a closing
  await say(ALICE, 'bisa kue custom?')
  const [sent] = transport.toCustomer()
  assert.equal(sent.text, PLACEHOLDER_ID)
  await deliver({ id: sent.id, chatId: ALICE, fromMe: true, isSelfChat: false, text: sent.text, ...stamp(), kind: 'notify' })
  assert.deepEqual([store.chat(ALICE).takeoverUntil, store.getDraft(2).status], [0, 'pending'], 'the echo is ours, not the owner typing')
  assert.ok(store.chat(ALICE).lastSentAt > store.chat(ALICE).lastClosingAt, 'our side\'s newest word, after the closing')
  await say(ALICE, 'jam berapa buka kak?')
  assert.equal(transport.toCustomer().at(-1).text, ANSWER_HOURS.reply, 'no 🤖 prefix: the placeholder disclosed this session')
  await say(ALICE, 'makasih kak 🙏')
  assert.deepEqual(audit().filter(entry => entry.event === 'decision').map(entry => entry.action), ['escalate', 'escalate', 'auto_send', 'escalate'], 'drafted, not skipped')
  assert.deepEqual(store.pendingDrafts().map(draft => draft.excerpt), ['bisa kue custom?', 'makasih kak 🙏'])
})

test('placeholder: a draft already open when it went out carries its period on after /no or /ok of that draft (send-path-r1-1)', async t => {
  for (const command of ['/no 2', '/ok 2']) {
    const { owner, say, store, placeholders, withheld } = placeholderSetup(t)
    await say(ALICE, 'ok kak, nanti saya kabari lagi') // escalated, waits for nothing: a draft with no placeholder
    await say(ALICE, 'bisa kue custom unicorn?')
    await owner(command)
    await say(ALICE, 'kue tart 2 tingkat juga bisa?')
    assert.deepEqual([placeholders().length, store.pendingDrafts().map(draft => draft.id)], [1, [1, 3]], `${command}: draft #1 was open all along`)
    assert.deepEqual(withheld(), [['customer_not_waiting'], [], ['placeholder_already_sent']], command)
    await owner('/no 1')
    await owner('/no 3')
    await say(ALICE, 'kue ulang tahun lagi bisa kak?')
    assert.equal(placeholders().length, 2, `${command}: nothing open, a new period`)
  }
})

test('placeholder: a send that certainly failed takes the drafts that joined its period out of it (send-path-r1-4)', async t => {
  const { transport, store, assistant, say, stamp, advance, placeholders, withheld } = placeholderSetup(t)
  const send = transport.send.bind(transport)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  transport.send = async (chatId, text, options) => {
    if (chatId === ALICE && first) {
      first = false
      await gate
      throw Object.assign(new Error('whatsapp not connected'), { notSent: true })
    }
    return send(chatId, text, options)
  }
  advance(60_000)
  await assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', stamp()))
  await waitFor(() => store.getDraft(1)?.placeholder?.status === 'sending')
  advance(60_000)
  await assistant.handleMessage(incoming(ALICE, 'kue tart 2 tingkat juga bisa?', stamp()))
  await waitFor(() => store.getDraft(2))
  assert.equal(store.getDraft(2).placeholderCovered, 1, 'triaged while the placeholder was in flight')
  release()
  await assistant.idle()
  assert.deepEqual([store.getDraft(1).placeholder, store.getDraft(2).placeholderCovered, store.countChatAutoSends(ALICE, 3_600_000)], [undefined, undefined, 0])
  await say(ALICE, 'kue ulang tahun juga bisa kak?')
  assert.deepEqual(withheld(), [[], ['placeholder_already_sent'], []])
  assert.equal(placeholders().length, 1, 'the customer got none, so the next escalation sends one')
})

test('placeholder: a send that failed in flight may have been delivered, so its period and cap slot stand (correctness-r1-1)', async t => {
  const { transport, store, say, placeholders, withheld } = placeholderSetup(t)
  const send = transport.send.bind(transport)
  transport.send = async (chatId, text, options) => {
    const sent = await send(chatId, text, options)
    if (text === PLACEHOLDER_ID) throw new Error('Timed Out') // Baileys: the frame went out, its write callback was late
    return sent
  }
  await say(ALICE, 'bisa kue custom unicorn?')
  await say(ALICE, 'kue ulang tahun 3 tingkat juga bisa?')
  assert.equal(placeholders().length, 1, 'delivered once, and not again while draft #1 is open')
  assert.deepEqual(withheld(), [[], ['placeholder_already_sent']])
  assert.deepEqual([store.getDraft(1).placeholder.status, store.countChatAutoSends(ALICE, 3_600_000), store.chat(ALICE).lastDisclosureAt ?? 0], ['unknown', 1, 0],
    'the cap slot stands; it is no disclosure, since it may not have arrived')
  assert.match(transport.toSelf()[0], /\n↩️ They may have got \(the send failed\): 🤖 Halo Kak, tunggu sebentar ya 🙏\n/)
})

test('placeholder: a send cut off by a forced exit is announced after the restart as possibly received, and not drafted again (correctness-r1-5)', async t => {
  const dir = tempDir(t)
  let clock = Date.now()
  const now = () => clock
  const start = transport => {
    const store = new Store(dir, { now, logger: silent })
    const brain = createFakeBrain(waiting)
    const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 10 }, dir), store, brain, transport, knowledge, now, logger: silent })
    return { store, brain, assistant }
  }
  const hung = createFakeTransport({ now })
  const send = hung.send.bind(hung)
  hung.send = async (chatId, text, options) => (text === PLACEHOLDER_ID ? new Promise(() => {}) : send(chatId, text, options))
  const first = start(hung)
  await first.assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', { timestamp: Math.floor(clock / 1000) }))
  await waitFor(() => first.store.getDraft(1)?.placeholder?.status === 'sending')
  // A second Ctrl-C exits at once (main.js): the first instance is left as it is, its state.json as last saved.
  assert.deepEqual([hung.toSelf(), first.store.inboxMessages().length], [[], 1], 'no notice yet, the message still in the inbox')

  const transport = createFakeTransport({ now })
  const second = start(transport)
  t.after(() => second.assistant.stop())
  second.assistant.recoverInbox()
  await second.assistant.idle()
  assert.equal(second.brain.calls.length, 0, 'its draft is complete: not triaged again')
  assert.deepEqual(second.store.inboxMessages(), [])
  assert.deepEqual([second.store.pendingDrafts().map(draft => draft.id), second.store.getDraft(1).placeholder.status], [[1], 'unknown'])
  const notices = transport.toSelf()
  assert.equal(notices.length, 1)
  assert.match(notices[0], /^🤖 📝 DRAFT #1 .*\nThey wrote: "bisa kue custom unicorn\?"\n↩️ They may have got \(the send failed\): 🤖 Halo Kak, tunggu sebentar ya 🙏\n[\s\S]*\nReply: \/ok 1 /)
  // Its period stands, as for any send that failed in flight: the next escalation gets none.
  clock += 60_000
  await second.assistant.handleMessage(incoming(ALICE, 'kue ulang tahun 3 tingkat juga bisa?', { timestamp: Math.floor(clock / 1000) }))
  await second.assistant.idle()
  assert.deepEqual([transport.toCustomer(), second.store.getDraft(2).placeholderCovered], [[], 1])
})

test('placeholder: a draft notice cut off by a forced exit after the placeholder went out is announced after the restart, and not drafted again (correctness-r2-4)', async t => {
  const dir = tempDir(t)
  let clock = Date.now()
  const now = () => clock
  const start = transport => {
    const store = new Store(dir, { now, logger: silent })
    const brain = createFakeBrain(waiting)
    const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 10 }, dir), store, brain, transport, knowledge, now, logger: silent })
    return { store, brain, assistant }
  }
  const hung = createFakeTransport({ now })
  hung.sendToSelf = () => new Promise(() => {})
  const first = start(hung)
  await first.assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', { timestamp: Math.floor(clock / 1000) }))
  await waitFor(() => first.store.getDraft(1)?.placeholder?.status === 'sent')
  assert.deepEqual([hung.toCustomer().map(item => item.text), first.store.inboxMessages().length], [[PLACEHOLDER_ID], 1], 'the customer got it; the message is still in the inbox')

  const transport = createFakeTransport({ now })
  const second = start(transport)
  t.after(() => second.assistant.stop())
  second.assistant.recoverInbox()
  await second.assistant.idle()
  assert.equal(second.brain.calls.length, 0, 'its draft is complete: not triaged again')
  assert.deepEqual(second.store.inboxMessages(), [])
  assert.deepEqual([second.store.pendingDrafts().map(draft => draft.id), second.store.getDraft(1).placeholder.status], [[1], 'sent'])
  const notices = transport.toSelf()
  assert.equal(notices.length, 1)
  assert.match(notices[0], /^🤖 📝 DRAFT #1 .*\nThey wrote: "bisa kue custom unicorn\?"\n↩️ They got: 🤖 Halo Kak, tunggu sebentar ya 🙏\n[\s\S]*\nReply: \/ok 1 /)
  assert.deepEqual(transport.toCustomer(), [])
})

test('restart: a draft without a placeholder whose notice was cut off is announced, not drafted again', async t => {
  const dir = tempDir(t)
  const now = () => 1_800_000_000_000
  const start = transport => {
    const store = new Store(dir, { now, logger: silent })
    const brain = createFakeBrain(byKeyword)
    const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 10 }, dir), store, brain, transport, knowledge, now, logger: silent })
    return { store, brain, assistant }
  }
  const hung = createFakeTransport({ now })
  hung.sendToSelf = () => new Promise(() => {})
  const first = start(hung)
  await first.assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', { timestamp: Math.floor(now() / 1000) }))
  await waitFor(() => first.store.pendingDrafts().length === 1)
  assert.equal(first.store.inboxMessages().length, 1)

  const transport = createFakeTransport({ now })
  const second = start(transport)
  t.after(() => second.assistant.stop())
  second.assistant.recoverInbox()
  await second.assistant.idle()
  assert.deepEqual([second.brain.calls.length, second.store.inboxMessages(), second.store.pendingDrafts().map(draft => draft.id)], [0, [], [1]])
  assert.deepEqual(transport.toSelf().map(text => text.split('\n')[0]), [`🤖 📝 DRAFT #1 · ${second.store.getDraft(1).contactName}`])
})

test('placeholder: when your reply on the phone cancels the draft while its placeholder goes out, no /ok is offered (send-path-r1-5)', async t => {
  const { transport, store, assistant, stamp, advance } = placeholderSetup(t)
  const send = transport.send.bind(transport)
  let release
  const gate = new Promise(resolve => { release = resolve })
  transport.send = async (chatId, text, options) => {
    if (text === PLACEHOLDER_ID) await gate
    return send(chatId, text, options)
  }
  advance(60_000)
  await assistant.handleMessage(incoming(ALICE, 'bisa kue custom unicorn?', stamp()))
  await waitFor(() => store.getDraft(1)?.placeholder?.status === 'sending')
  await assistant.handleMessage({ id: 'PHONE1', chatId: ALICE, fromMe: true, isSelfChat: false, text: 'bisa kak', ...stamp(), kind: 'notify' })
  release()
  await assistant.idle()
  const notices = transport.toSelf()
  assert.equal(store.getDraft(1).status, 'cancelled')
  assert.equal(notices.length, 2)
  assert.match(notices[0], /You replied to .+ yourself: cancelled draft #1\./)
  assert.match(notices[1], /^🤖 📝 Draft #1 · .+ is cancelled\. ↩️ They got: 🤖 Halo Kak, tunggu sebentar ya 🙏$/)
})
