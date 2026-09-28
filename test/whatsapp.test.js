// The Baileys adapter against a fake socket: event handling, reconnect table, watchdog and send options.
// No network: createSocket is injected, so no real Baileys socket is ever created.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WAMessageStubType } from 'baileys'
import { createAssistant } from '../src/assistant.js'
import { closedThisSession } from '../src/policy.js'
import { Store } from '../src/store.js'
import { createWhatsAppTransport } from '../src/transport/whatsapp.js'
import { createFakeBrain, knowledge, makeConfig, sleep, tempDir } from './helpers.js'

const OWNER_PN = '6281111111111@s.whatsapp.net'
const OWNER_LID = '99887766554433@lid'
const CUSTOMER = '6282222222222@s.whatsapp.net'
const silent = { log () {}, warn () {}, error () {} }
const nowSeconds = () => Math.floor(Date.now() / 1000)

function fakeSockets (lidToPn = {}) {
  const sockets = []
  async function createSocket () {
    const ev = new EventEmitter()
    const sock = {
      ev,
      ws: new EventEmitter(),
      signalRepository: { lidMapping: { async getPNForLID (lid) { return lidToPn[lid] ?? null } } },
      user: { id: '6281111111111:7@s.whatsapp.net', lid: '99887766554433:7@lid' },
      sent: [],
      read: [],
      resends: [],
      ended: [],
      async sendMessage (jid, content, options) {
        this.sent.push({ jid, content, options })
        return { key: { remoteJid: jid, id: options.messageId ?? 'GENERATED', fromMe: true }, message: { conversation: content.text }, messageTimestamp: nowSeconds() }
      },
      async readMessages (keys) { this.read.push(...keys) },
      async requestPlaceholderResend (key) { this.resends.push(key) },
      async end (error) {
        this.ended.push(error)
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error } })
      }
    }
    sockets.push(sock)
    return sock
  }
  return { sockets, createSocket }
}

function setup (t, whatsapp = {}, { lidToPn } = {}) {
  const dir = tempDir(t)
  const config = makeConfig({ whatsapp: { caughtUpWatchdogMs: 60_000, ...whatsapp } }, dir)
  const store = new Store(dir)
  const { sockets, createSocket } = fakeSockets(lidToPn)
  const received = []
  const untriaged = []
  const fatal = []
  let ready = 0
  const connections = []
  const transport = createWhatsAppTransport({
    config, store, logger: silent, createSocket,
    onMessage: async message => { received.push(message) },
    onUntriaged: item => { untriaged.push(item) },
    onReady: () => { ready++ },
    onConnected: info => { connections.push(info) },
    onFatal: verdict => { fatal.push(verdict) }
  })
  t.after(() => transport.stop())
  const emit = (event, payload) => sockets.at(-1).ev.emit(event, payload)
  return { store, transport, sockets, received, untriaged, fatal, emit, ready: () => ready, connections: () => connections.length, outages: () => connections.map(info => info.outageMs) }
}

const open = emit => emit('connection.update', { connection: 'open' })
const closeWith = (emit, statusCode, message = 'closed') => emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) } })
const raw = (remoteJid, message, extra = {}) => ({ key: { remoteJid, id: `ID${Math.random()}`, fromMe: false }, message, messageTimestamp: nowSeconds(), pushName: 'Sari', ...extra })

test('first open seeds the history floor and announces once; 515 recreates immediately', async t => {
  const { store, transport, sockets, emit, ready, connections } = setup(t)
  await transport.start()
  open(emit)
  assert.ok(Math.abs(store.historyFloorTs - nowSeconds()) <= 1)
  closeWith(emit, 515, 'restart required')
  await sleep(10)
  assert.equal(sockets.length, 2)
  open(emit)
  assert.equal(ready(), 1)
  assert.equal(connections(), 2, 'every reconnect is reported, so queued notices can be re-sent')
})

test('upserts: customer text and self-chat commands pass, groups are dropped, ciphertext asks for a resend', async t => {
  const { transport, sockets, received, emit } = setup(t)
  await transport.start()
  open(emit)
  const cipher = { key: { remoteJid: CUSTOMER, id: 'CIPHER', fromMe: false }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() }
  emit('messages.upsert', {
    type: 'notify',
    messages: [
      raw(CUSTOMER, { conversation: 'jam buka?' }),
      raw('120363000000000000@g.us', { conversation: 'grup' }, { key: { remoteJid: '120363000000000000@g.us', id: 'G', participant: CUSTOMER } }),
      cipher,
      raw(OWNER_PN, { conversation: '/status' }, { key: { remoteJid: OWNER_PN, id: 'SELF', fromMe: true } })
    ]
  })
  await sleep(10)
  assert.deepEqual(received.map(message => [message.chatId, message.text, message.isSelfChat]), [[CUSTOMER, 'jam buka?', false], [OWNER_PN, '/status', true]])
  assert.deepEqual(sockets[0].resends.map(key => key.id), ['CIPHER'])
})

test('send: pre-generated message id, quotes text only, history and markRead', async t => {
  const { transport, sockets, emit } = setup(t)
  await transport.start()
  open(emit)
  const text = raw(CUSTOMER, { conversation: 'jam buka?' })
  const image = raw(CUSTOMER, { imageMessage: { caption: 'ini?' } })
  emit('messages.upsert', { type: 'notify', messages: [text, image] })
  await sleep(5)

  const sent = await transport.send(CUSTOMER, 'Buka 08.00', { quotedRaw: text, messageId: 'BOT1' })
  assert.equal(sent.id, 'BOT1')
  assert.deepEqual(sockets[0].sent[0].options, { messageId: 'BOT1', quoted: text })
  await transport.send(CUSTOMER, 'ok', { quotedRaw: image, messageId: 'BOT2' })
  assert.deepEqual(sockets[0].sent[1].options, { messageId: 'BOT2' }, 'quoted media replies do not render on mobile')

  assert.deepEqual(transport.getHistory(CUSTOMER, 10).map(item => [item.fromMe, item.text, item.attachment]), [[false, 'jam buka?', undefined], [false, 'ini?', 'image'], [true, 'Buka 08.00', undefined], [true, 'ok', undefined]])
  // Our message is kept under the id we generated, which the echo carries too: that id marks a closing reply.
  emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: CUSTOMER, id: 'BOT1', fromMe: true }, message: { conversation: 'Buka 08.00' }, messageTimestamp: nowSeconds() }] })
  await sleep(5)
  assert.deepEqual(transport.getHistory(CUSTOMER, 10).filter(item => item.fromMe).map(item => item.id), ['BOT1', 'BOT2'])
  emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { imageMessage: { mimetype: 'image/jpeg' } }), raw(CUSTOMER, { stickerMessage: {} })] })
  await sleep(5)
  assert.deepEqual(transport.getHistory(CUSTOMER, 1).map(item => [item.text, item.attachment]), [['', 'image']], 'a photo without a caption stays in the history; a sticker does not')
  emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { locationMessage: { degreesLatitude: -6.9, degreesLongitude: 107.6 } }), raw(CUSTOMER, { contactMessage: { displayName: 'Budi' } }), raw(CUSTOMER, { reactionMessage: { text: '👍' } })] })
  await sleep(5)
  assert.deepEqual(transport.getHistory(CUSTOMER, 2).map(item => [item.text, item.attachment]), [['', 'location'], ['', 'contact']], 'so do a location pin and a contact card; a reaction does not')
  await transport.markRead([{ raw: text }])
  assert.deepEqual(sockets[0].read, [text.key])
  assert.equal(typeof transport.generateId(), 'string')
})

// Baileys fetches any URL in outgoing text to build a preview unless linkPreview is set (rc14 generateWAMessageContent):
// that fetch would reveal this machine's IP to the owner of a customer's or spammer's link that a notice quotes.
test('every send carries linkPreview: null, so Baileys never fetches a link: replies, quotes, notices, placeholders, auto-replies', async t => {
  const { transport, sockets, emit } = setup(t)
  await transport.start()
  open(emit)
  const question = raw(CUSTOMER, { conversation: 'lokasinya di https://maps.app.goo.gl/abc?g_st=iw ya?' })
  emit('messages.upsert', { type: 'notify', messages: [question] })
  await sleep(5)
  await transport.send(CUSTOMER, 'Cek https://example.com ya Kak', { quotedRaw: question, messageId: 'Q1' })
  await transport.send(CUSTOMER, 'www.example.com')
  await transport.sendToSelf('🤖 📝 DRAFT #1\nThey wrote: "klik bit.ly/klaim-hadiah"', { messageId: 'N1' })
  assert.deepEqual(sockets[0].sent.map(item => item.content), [
    { text: 'Cek https://example.com ya Kak', linkPreview: null },
    { text: 'www.example.com', linkPreview: null },
    { text: '🤖 📝 DRAFT #1\nThey wrote: "klik bit.ly/klaim-hadiah"', linkPreview: null }
  ])

  // Wired as src/main.js wires them: the placeholder, an auto-reply and every notice go through the same send().
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 5, whatsapp: { caughtUpWatchdogMs: 60_000 } }, dir)
  const store = new Store(dir, { logger: silent })
  const { sockets: wired, createSocket } = fakeSockets()
  const brain = createFakeBrain(({ messages }) => (/jam/.test(messages[0].text)
    ? { ok: true, triage: { decision: 'answer', reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', facts_used: ['F1'], reason: 'hours', summary: 'hours', customer_waiting: true }, rateLimit: { status: 'allowed', fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }, meta: {} }
    : { ok: true, triage: { decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.', facts_used: [], reason: 'custom', summary: 'custom cake, see https://example.com/ref', customer_waiting: true, holding_reply: 'Baik Kak Sari, pertanyaan soal kue custom-nya saya teruskan ke pemilik ya 🙏' }, meta: {} }))
  let assistant
  const whatsapp = createWhatsAppTransport({ config, store, logger: silent, createSocket, onMessage: message => assistant.handleMessage(message) })
  assistant = createAssistant({ config, store, brain, transport: whatsapp, knowledge, logger: silent })
  t.after(async () => { await assistant.stop(); await whatsapp.stop() })
  await whatsapp.start()
  wired[0].ev.emit('connection.update', { connection: 'open' })
  wired[0].ev.emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { conversation: 'bisa kue custom kayak https://example.com/ref?' })] })
  await sleep(20)
  await assistant.idle()
  wired[0].ev.emit('messages.upsert', { type: 'notify', messages: [raw('6283333333333@s.whatsapp.net', { conversation: 'jam berapa buka kak?' })] })
  await sleep(20)
  await assistant.idle()
  const sent = wired[0].sent.map(item => [item.jid, item.content.text.split('\n')[0]])
  assert.deepEqual(sent, [
    [CUSTOMER, '🤖 Baik Kak Sari, pertanyaan soal kue custom-nya saya teruskan ke pemilik ya 🙏'],
    [OWNER_PN, '🤖 📝 DRAFT #1 · Sari (+6282222222222)'],
    ['6283333333333@s.whatsapp.net', '🤖 Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.'],
    [OWNER_PN, '🤖 ✅ Auto-replied to Sari (+6283333333333): "Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak."']
  ], 'the placeholder, its notice, an auto-reply and its notice')
  assert.ok(wired[0].sent.every(item => Object.keys(item.content).join() === 'text,linkPreview' && item.content.linkPreview === null))
})

test('self-chat target: own PN first, then the JID the owner actually types on', async t => {
  const { transport, sockets, emit } = setup(t)
  await transport.start()
  open(emit)
  await transport.sendToSelf('🤖 hi', { messageId: 'N1' })
  assert.equal(sockets[0].sent[0].jid, OWNER_PN)
  emit('messages.upsert', { type: 'notify', messages: [raw(OWNER_LID, { conversation: '/help' }, { key: { remoteJid: OWNER_LID, id: 'L1', fromMe: true } })] })
  await sleep(5)
  await transport.sendToSelf('🤖 again', { messageId: 'N2' })
  assert.equal(sockets[0].sent[1].jid, OWNER_LID)
})

test('an owner command typed in a customer chat (own PN as alt) is a takeover and never moves the notices there', async t => {
  const { transport, sockets, received, emit } = setup(t)
  await transport.start()
  open(emit)
  const inCustomerChat = (id, text) => raw('55555@lid', { conversation: text }, { key: { remoteJid: '55555@lid', remoteJidAlt: '6281111111111:3@s.whatsapp.net', id, fromMe: true } })
  emit('messages.upsert', { type: 'notify', messages: [inCustomerChat('R1', 'bentar ya kak'), inCustomerChat('R2', '/status')] })
  await sleep(5)
  assert.deepEqual(received.map(message => [message.id, message.isSelfChat, message.chatIdAlt]), [['R1', false, undefined], ['R2', false, undefined]])
  await transport.sendToSelf('🤖 notice', { messageId: 'N1' })
  assert.equal(sockets[0].sent[0].jid, OWNER_PN)
})

test('a forwarded /command in self-chat does not re-point the notices', async t => {
  const { transport, sockets, emit } = setup(t)
  await transport.start()
  open(emit)
  emit('messages.upsert', { type: 'notify', messages: [raw(OWNER_LID, { extendedTextMessage: { text: '/help', contextInfo: { isForwarded: true } } }, { key: { remoteJid: OWNER_LID, id: 'F1', fromMe: true } })] })
  await sleep(5)
  await transport.sendToSelf('🤖 hi', { messageId: 'N1' })
  assert.equal(sockets[0].sent[0].jid, OWNER_PN)
})

test('sendToSelf refuses a target that is not an own JID', async t => {
  const { transport, sockets, emit } = setup(t, { selfChatJid: CUSTOMER })
  await transport.start()
  open(emit)
  assert.throws(() => transport.sendToSelf('🤖 notice', { messageId: 'N1' }), /not one of the own JIDs/)
  assert.deepEqual(sockets[0].sent, [])
})

test('a LID chat without a PN alt gets its number from the local LID mapping, never an own number', async t => {
  const lidToPn = { '123456789012345@lid': '6281234567890:0@s.whatsapp.net', '555555555555555@lid': '6281111111111:0@s.whatsapp.net' }
  const { store, transport, received, emit } = setup(t, {}, { lidToPn })
  await transport.start()
  open(emit)
  emit('messages.upsert', {
    type: 'notify',
    messages: [
      raw('123456789012345@lid', { conversation: 'jam buka?' }),
      raw('555555555555555@lid', { conversation: 'halo' }),
      raw('777777777777777@lid', { conversation: 'halo' })
    ]
  })
  await sleep(5)
  assert.deepEqual(received.map(message => message.chatIdAlt), ['6281234567890@s.whatsapp.net', undefined, undefined])

  // Mappings WhatsApp sends later are saved on known chats that have no alt yet.
  store.updateChat('777777777777777@lid', {})
  emit('lid-mapping.update', { lid: '777777777777777@lid', pn: '6287777777777@s.whatsapp.net' })
  emit('messaging-history.set', { messages: [], lidPnMappings: [{ lid: '888@lid', pn: '6288888888888@s.whatsapp.net' }] })
  emit('lid-mapping.update', { lid: '999@lid', pn: OWNER_PN })
  assert.equal(store.existingChat('777777777777777@lid').chatIdAlt, '6287777777777@s.whatsapp.net')
  assert.equal(store.existingChat('888@lid'), undefined, 'unknown chats get no record')
})

test('stop codes: 401 and 440 stop without reconnecting', async t => {
  for (const [code, reason] of [[401, 'logged_out'], [440, 'connection_replaced']]) {
    const { transport, sockets, fatal, emit } = setup(t)
    await transport.start()
    open(emit)
    closeWith(emit, code)
    await sleep(10)
    assert.deepEqual(fatal.map(verdict => verdict.reason), [reason])
    assert.equal(sockets.length, 1)
    // Nothing went out, and the error says so: the send gate may let the next escalation try its placeholder again.
    await assert.rejects(transport.send(CUSTOMER, 'x'), error => /not connected/.test(error.message) && error.notSent === true)
  }
})

test('watchdog recreates the socket when pending notifications never arrive', async t => {
  const { transport, sockets, emit } = setup(t, { caughtUpWatchdogMs: 20 })
  await transport.start()
  open(emit)
  await sleep(60)
  assert.equal(sockets[0].ended.length, 1)
  assert.match(sockets[0].ended[0].message, /watchdog/)
})

test('receivedPendingNotifications disarms the watchdog', async t => {
  const { transport, sockets, emit } = setup(t, { caughtUpWatchdogMs: 20 })
  await transport.start()
  open(emit)
  emit('connection.update', { receivedPendingNotifications: true })
  await sleep(60)
  assert.equal(sockets[0].ended.length, 0)
})

test('an owner voice note in a customer chat reaches the assistant as a takeover', async t => {
  const { transport, received, emit } = setup(t)
  await transport.start()
  open(emit)
  emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { audioMessage: { ptt: true } }, { key: { remoteJid: CUSTOMER, id: 'VOICE', fromMe: true } })] })
  await sleep(5)
  assert.deepEqual(received.map(message => [message.id, message.fromMe, message.isSelfChat]), [['VOICE', true, false]])
})

test('the owner\'s own Meta AI prompts are dropped and never re-point the self-chat target', async t => {
  const { transport, sockets, received, emit } = setup(t)
  await transport.start()
  open(emit)
  sockets[0].ws.emit('CB:message', { tag: 'message', attrs: { id: 'MA1', from: OWNER_LID, recipient: '867051314767696@bot' } })
  emit('messages.upsert', { type: 'notify', messages: [raw(OWNER_LID, { conversation: '/help' }, { key: { remoteJid: OWNER_LID, id: 'MA1', fromMe: true } })] })
  emit('messages.upsert', { type: 'notify', messages: [raw(OWNER_LID, { conversation: '/imagine kucing' }, { key: { remoteJid: OWNER_LID, id: 'MA2', fromMe: true } })] })
  await sleep(5)
  assert.deepEqual(received.map(message => message.id), ['MA2'], 'only the stanza with an @bot recipient is known to be Meta AI')
  await transport.sendToSelf('🤖 hi', { messageId: 'N1' })
  assert.equal(sockets[0].sent[0].jid, OWNER_PN, 'an unknown /command does not move the notices')
})

test('a customer\'s content that is never triaged is reported with its chat and time, stickers and reactions too; our own files are not', async t => {
  const { transport, received, untriaged, emit } = setup(t)
  await transport.start()
  open(emit)
  const LID = '123456789012345@lid'
  const photo = raw(LID, { imageMessage: { mimetype: 'image/jpeg' } }, { key: { remoteJid: LID, remoteJidAlt: CUSTOMER, id: 'IMG1', fromMe: false } })
  const stub = { key: { remoteJid: CUSTOMER, id: 'X1', fromMe: false }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() }
  const sticker = raw(CUSTOMER, { stickerMessage: {} }, { key: { remoteJid: CUSTOMER, id: 'ST1', fromMe: false } })
  const reaction = raw(CUSTOMER, { reactionMessage: { text: '👍', key: { id: 'IMG1' } } }, { key: { remoteJid: CUSTOMER, id: 'RE1', fromMe: false } })
  emit('messages.upsert', {
    type: 'notify',
    messages: [photo, stub, sticker, reaction,
      raw(CUSTOMER, { imageMessage: { caption: 'ini kak' } }), raw(CUSTOMER, { imageMessage: {} }, { key: { remoteJid: CUSTOMER, id: 'OWN1', fromMe: true } })]
  })
  await sleep(5)
  assert.deepEqual(untriaged.map(item => [item.id, item.chatId, item.chatIdAlt, item.attachment, item.timestamp]),
    [['IMG1', LID, CUSTOMER, 'image', photo.messageTimestamp], ['X1', CUSTOMER, undefined, 'other', stub.messageTimestamp],
      ['ST1', CUSTOMER, undefined, 'sticker', sticker.messageTimestamp], ['RE1', CUSTOMER, undefined, 'reaction', reaction.messageTimestamp]])
  assert.ok(!transport.getHistory(CUSTOMER, 10).some(item => ['ST1', 'RE1'].includes(item.id)), 'a sticker or a reaction stays out of the history Claude sees')
  assert.deepEqual(received.map(message => message.text), ['ini kak', ''], 'the captioned photo is triaged; the owner\'s own photo starts a takeover')
})

test('a customer\'s call offer is reported as untriaged, with its phone number for a LID; group calls, other statuses and our own are not (skip-safety-r3-3)', async t => {
  const LID = '123456789012345@lid'
  const { transport, untriaged, emit } = setup(t, {}, { lidToPn: { [LID]: CUSTOMER } })
  await transport.start()
  open(emit)
  const date = new Date(1790400000 * 1000)
  const call = (chatId, extra = {}) => ({ chatId, from: chatId, id: `CALL${Math.random()}`, date, offline: false, status: 'offer', isVideo: false, isGroup: false, ...extra })
  emit('call', [call('6282222222222:12@s.whatsapp.net')])
  emit('call', [call(`${LID.split('@')[0]}:3@lid`, { isVideo: true })])
  emit('call', [call(CUSTOMER, { status: 'terminate' })])
  emit('call', [call(CUSTOMER, { isGroup: true, groupJid: '120363000000000000@g.us' })])
  emit('call', [call(OWNER_PN)])
  emit('call', [call('120363000000000000@g.us')])
  await sleep(5)
  assert.deepEqual(untriaged.map(item => [item.chatId, item.chatIdAlt, item.attachment, item.timestamp]),
    [[CUSTOMER, undefined, 'call', 1790400000], [LID, CUSTOMER, 'call', 1790400000]])
})

test('an untriaged file on a LID chat with no alt gets its phone number from the local LID mapping', async t => {
  const LID = '123456789012345@lid'
  const { transport, untriaged, emit } = setup(t, {}, { lidToPn: { [LID]: CUSTOMER } })
  await transport.start()
  open(emit)
  emit('messages.upsert', { type: 'notify', messages: [raw(LID, { locationMessage: { degreesLatitude: -6.9 } }, { key: { remoteJid: LID, id: 'PIN1', fromMe: false } })] })
  await sleep(5)
  assert.deepEqual(untriaged.map(item => [item.chatId, item.chatIdAlt, item.attachment]), [[LID, CUSTOMER, 'location']])
})

test('a decrypted resend replaces its ciphertext stub in the history', async t => {
  const { transport, received, emit } = setup(t)
  await transport.start()
  open(emit)
  const stub = { key: { remoteJid: CUSTOMER, id: 'X1', fromMe: false }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() }
  emit('messages.upsert', { type: 'notify', messages: [stub] })
  emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { conversation: 'ada stok beras 5kg?' }, { key: { remoteJid: CUSTOMER, id: 'X1', fromMe: false } })] })
  await sleep(5)
  assert.deepEqual(received.map(message => message.text), ['ada stok beras 5kg?'])
  assert.deepEqual(transport.getHistory(CUSTOMER, 10).map(item => item.text), ['ada stok beras 5kg?'])
})

test('an undecryptable message stays in the history until its resend comes: a thanks after it is not skipped', async t => {
  const { transport, emit } = setup(t)
  await transport.start()
  open(emit)
  const thanks = raw(CUSTOMER, { conversation: 'ok makasih kak' }, { messageTimestamp: nowSeconds() - 60 })
  const stub = { key: { remoteJid: CUSTOMER, id: 'X1', fromMe: false }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() }
  emit('messages.upsert', { type: 'notify', messages: [thanks, stub] })
  await sleep(5)
  const history = transport.getHistory(CUSTOMER, 10)
  assert.deepEqual(history.map(item => [item.id, item.text, item.attachment]), [[thanks.key.id, 'ok makasih kak', undefined], ['X1', '', 'other']])
  assert.equal(closedThisSession(history, { lastClosingAt: thanks.messageTimestamp * 1000 }), false, 'something came in after the closed thanks')
  emit('messages.upsert', { type: 'notify', messages: [raw(CUSTOMER, { conversation: 'kak pesanan saya kurang 1' }, { key: { remoteJid: CUSTOMER, id: 'X1', fromMe: false } })] })
  await sleep(5)
  assert.deepEqual(transport.getHistory(CUSTOMER, 10).map(item => [item.text, item.attachment]), [['ok makasih kak', undefined], ['kak pesanan saya kurang 1', undefined]])
})

test('a placeholder-resend answer is a replay; stubs past maxAge are not re-requested', async t => {
  const { transport, sockets, received, emit } = setup(t)
  await transport.start()
  open(emit)
  const stub = (id, ageSeconds) => ({ key: { remoteJid: CUSTOMER, id, fromMe: false }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() - ageSeconds })
  emit('messages.upsert', { type: 'append', messages: [stub('OLD', 150 * 60), stub('NEW', 5 * 60)] })
  emit('messages.upsert', { type: 'notify', requestId: 'PDO1', messages: [raw(CUSTOMER, { conversation: 'jam berapa buka?' }, { key: { remoteJid: CUSTOMER, id: 'NEW', fromMe: false } })] })
  await sleep(5)
  assert.deepEqual(sockets[0].resends.map(key => key.id), ['NEW'])
  assert.deepEqual(received.map(message => [message.id, message.kind]), [['NEW', 'append']])
})

test('catch-up signalled before open: no watchdog, so a healthy socket is not recycled', async t => {
  const { transport, sockets, emit } = setup(t, { caughtUpWatchdogMs: 20 })
  await transport.start()
  emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false })
  emit('connection.update', { receivedPendingNotifications: true })
  open(emit)
  await sleep(60)
  assert.equal(sockets.length, 1)
  assert.deepEqual(sockets[0].ended, [])
})

test('the offline flush before open already sees the own ids and the history floor', async t => {
  const { store, transport, received, emit } = setup(t)
  await transport.start()
  assert.ok(store.historyFloorTs > 0, 'seeded when the socket is created')
  emit('messages.upsert', { type: 'append', messages: [raw(OWNER_PN, { conversation: '/status' }, { key: { remoteJid: OWNER_PN, id: 'EARLY', fromMe: true } })] })
  await sleep(5)
  assert.deepEqual(received.map(message => [message.id, message.isSelfChat]), [['EARLY', true]])
})

test('open-then-close loops still give up after maxReconnectAttempts', async t => {
  const { transport, sockets, fatal, emit } = setup(t, { maxReconnectAttempts: 2 })
  await transport.start()
  for (let cycle = 0; cycle < 3; cycle++) {
    open(emit)
    emit('connection.update', { receivedPendingNotifications: true })
    closeWith(emit, 515, 'restart required')
    await sleep(10)
  }
  assert.deepEqual(fatal.map(verdict => verdict.reason), ['too_many_reconnects'])
  assert.equal(sockets.length, 3)
})

test('a network outage is retried past maxReconnectAttempts and reported when the connection is back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const { transport, sockets, fatal, emit, outages } = setup(t, { maxReconnectAttempts: 2, stableConnectionMs: 1000 })
  await transport.start()
  open(emit)
  emit('connection.update', { receivedPendingNotifications: true })
  t.mock.timers.tick(1000) // stable
  closeWith(emit, 408, 'Connection was lost')
  // Router reboot: every new socket fails at once, like Baileys' mapped ws error (ENOTFOUND → 408), never opening.
  for (let attempt = 0; attempt < 15; attempt++) {
    t.mock.timers.tick(60_000)
    await flush()
    closeWith(emit, 408, 'WebSocket Error (getaddrinfo ENOTFOUND web.whatsapp.com)')
  }
  assert.deepEqual(fatal, [], 'no give-up while nothing ever opened')
  assert.equal(sockets.length, 16)
  t.mock.timers.tick(60_000)
  await flush()
  open(emit)
  assert.deepEqual(outages(), [0, 16 * 60_000])

  // The cap still applies to connections that open and drop again before becoming stable.
  for (let cycle = 0; cycle < 3; cycle++) {
    closeWith(emit, 428, 'Connection Closed')
    t.mock.timers.tick(60_000)
    await flush()
    open(emit)
  }
  assert.deepEqual(fatal.map(verdict => verdict.reason), ['too_many_reconnects'])
})

test('a connection that stayed up resets the reconnect counter', async t => {
  const { transport, sockets, fatal, emit } = setup(t, { maxReconnectAttempts: 1, stableConnectionMs: 20 })
  await transport.start()
  for (let cycle = 0; cycle < 3; cycle++) {
    open(emit)
    emit('connection.update', { receivedPendingNotifications: true })
    await sleep(40)
    closeWith(emit, 515, 'restart required')
    await sleep(10)
  }
  assert.deepEqual(fatal, [])
  assert.equal(sockets.length, 4)
})

test('allowChats end to end: the listed contact is found through WhatsApp\'s LID mapping; nothing is asked, sent or kept for any other chat', async t => {
  const LID = '123456789012345@lid'
  const OTHER_LID = '777777777777777@lid'
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 5, allowChats: ['081234567890'], whatsapp: { caughtUpWatchdogMs: 60_000 } }, dir)
  const store = new Store(dir, { logger: silent })
  store.updateChat(OTHER_LID, {}) // a record from before the list was set, which a mapping would otherwise update
  const { sockets, createSocket } = fakeSockets({ [LID]: '6281234567890:0@s.whatsapp.net' })
  const brain = createFakeBrain()
  let assistant
  // Wired as src/main.js wires them.
  const transport = createWhatsAppTransport({
    config, store, logger: silent, createSocket,
    onMessage: message => assistant.handleMessage(message),
    onUntriaged: item => assistant.noteUntriaged(item)
  })
  assistant = createAssistant({ config, store, brain, transport, knowledge, logger: silent })
  t.after(async () => { await assistant.stop(); await transport.stop() })
  await transport.start()
  const emit = (event, payload) => sockets.at(-1).ev.emit(event, payload)
  open(emit)

  const stub = (remoteJid, id, fromMe = false) => ({ key: { remoteJid, id, fromMe }, message: null, messageStubType: 2, messageTimestamp: nowSeconds() })
  const other = (id, message, fromMe = false) => raw(CUSTOMER, message, { key: { remoteJid: CUSTOMER, id, fromMe } })
  emit('messages.upsert', {
    type: 'notify',
    messages: [
      raw(LID, { conversation: 'jam buka?' }, { key: { remoteJid: LID, id: 'L1', fromMe: false } }), // no PN alt on the message
      stub(LID, 'L2'),
      other('C1', { conversation: 'jam buka?' }),
      other('C2', { imageMessage: { mimetype: 'image/jpeg' } }),
      stub(CUSTOMER, 'C3'),
      other('C4', { conversation: 'bentar ya' }, true),
      stub(OWNER_PN, 'S1', true)
    ]
  })
  emit('lid-mapping.update', { lid: OTHER_LID, pn: '6287777777777@s.whatsapp.net' })
  await sleep(10)
  await assistant.idle()

  assert.deepEqual(brain.calls.map(call => call.messages.map(message => message.id)), [['L1']])
  assert.deepEqual(sockets[0].sent.map(item => item.jid), [LID, OWNER_PN], 'the auto-reply and its notice only')
  assert.deepEqual(sockets[0].read.map(key => key.id), ['L1'])
  assert.deepEqual(sockets[0].resends.map(key => key.id), ['L2', 'S1'], 'the phone is asked for the listed chat and "Message yourself" only')
  assert.equal(store.existingChat(LID).chatIdAlt, '6281234567890@s.whatsapp.net')
  assert.equal(store.existingChat(CUSTOMER), undefined)
  assert.equal(store.existingChat(OTHER_LID).chatIdAlt, undefined, 'the mapping of an unlisted chat is not saved')
  const state = readFileSync(store.file, 'utf8')
  assert.ok(!state.includes('6282222222222') && !state.includes('6287777777777') && !/"C\d"/.test(state))
  const skips = readFileSync(store.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'skip_not_allowed')
  assert.deepEqual(skips.map(({ ts, ...entry }) => entry), Array(4).fill({ event: 'skip_not_allowed', chatId: CUSTOMER }), 'the text, the photo, the stub and the owner\'s reply')
})

test('a sticker, reaction, edit or missed call after a discarded thanks holds the next thanks: drafted, not skipped (skip-safety-r1-2, skip-safety-r3-3)', async t => {
  const respond = input => {
    const text = input.messages.map(message => message.text).join(' ')
    return /makasih/.test(text) ? { ok: true, triage: { decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: [], reason: 'thanks' }, meta: {} }
      : { ok: true, triage: { decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.', facts_used: [], reason: 'ask' }, meta: {} }
  }
  for (const variant of ['sticker', 'reaction', 'edit', 'missed call', 'call ended early', 'none']) {
    const dir = tempDir(t)
    const config = makeConfig({ mode: 'live', debounceMs: 5, whatsapp: { caughtUpWatchdogMs: 60_000 } }, dir)
    const store = new Store(dir, { logger: silent })
    const { sockets, createSocket } = fakeSockets()
    const brain = createFakeBrain(respond)
    let assistant
    const transport = createWhatsAppTransport({
      config, store, logger: silent, createSocket,
      onMessage: message => assistant.handleMessage(message),
      onUntriaged: item => assistant.noteUntriaged(item)
    })
    assistant = createAssistant({ config, store, brain, transport, knowledge, logger: silent })
    t.after(async () => { await assistant.stop(); await transport.stop() })
    await transport.start()
    const emit = (event, payload) => sockets.at(-1).ev.emit(event, payload)
    open(emit)
    const base = nowSeconds()
    const step = async (...messages) => { emit('messages.upsert', { type: 'notify', messages }); await sleep(10); await assistant.idle() }
    const customer = (id, message, seconds) => raw(CUSTOMER, message, { key: { remoteJid: CUSTOMER, id, fromMe: false }, messageTimestamp: base + seconds })
    const owner = text => raw(OWNER_PN, { conversation: text }, { key: { remoteJid: OWNER_PN, id: `CMD${Math.random()}`, fromMe: true } })

    await step(customer('Q1', { conversation: 'kak brownies bisa dikirim' }, 0))
    await step(owner('/edit 1 Bisa kak, mau diantar besok sore'))
    const offer = sockets[0].sent.find(item => item.jid === CUSTOMER)
    await step(customer('T1', { conversation: 'makasih kak' }, 60))
    await step(owner('/no 2'))
    const sign = {
      sticker: { stickerMessage: {} },
      reaction: { reactionMessage: { text: '👍', key: { remoteJid: CUSTOMER, id: offer.options.messageId, fromMe: true } } },
      edit: { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'Q1' }, editedMessage: { conversation: 'kak brownies bisa dikirim besok?' } } } } }
    }[variant]
    if (sign) await step(customer('S1', sign, 120))
    // As Baileys rc14 reports a call that rang out, and the offer of one the customer ended first.
    const caller = '6282222222222:12@s.whatsapp.net'
    if (variant === 'missed call') {
      await step({ key: { remoteJid: caller, id: 'CALL1', fromMe: false }, message: null, messageStubType: WAMessageStubType.CALL_MISSED_VOICE, messageTimestamp: base + 120 })
    }
    if (variant === 'call ended early') {
      emit('call', [{ chatId: caller, from: caller, id: 'CALL2', date: new Date((base + 120) * 1000), offline: false, status: 'offer', isVideo: false, isGroup: false }])
      await sleep(10)
    }
    await step(customer('T2', { conversation: 'makasih kak 🙏' }, 180))
    const drafted = store.pendingDrafts().map(draft => draft.excerpt)
    assert.deepEqual(drafted, variant === 'none' ? [] : ['makasih kak 🙏'], variant)
  }
})
