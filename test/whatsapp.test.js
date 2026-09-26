// The Baileys adapter against a fake socket: event handling, reconnect table, watchdog and send options.
// No network: createSocket is injected, so no real Baileys socket is ever created.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Store } from '../src/store.js'
import { createWhatsAppTransport } from '../src/transport/whatsapp.js'
import { makeConfig, sleep, tempDir } from './helpers.js'

const OWNER_PN = '6281111111111@s.whatsapp.net'
const OWNER_LID = '99887766554433@lid'
const CUSTOMER = '6282222222222@s.whatsapp.net'
const silent = { log () {}, warn () {}, error () {} }
const nowSeconds = () => Math.floor(Date.now() / 1000)

function fakeSockets () {
  const sockets = []
  async function createSocket () {
    const ev = new EventEmitter()
    const sock = {
      ev,
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

function setup (t, whatsapp = {}) {
  const dir = tempDir(t)
  const config = makeConfig({ whatsapp: { caughtUpWatchdogMs: 60_000, ...whatsapp } }, dir)
  const store = new Store(dir)
  const { sockets, createSocket } = fakeSockets()
  const received = []
  const fatal = []
  let ready = 0
  const transport = createWhatsAppTransport({
    config, store, logger: silent, createSocket,
    onMessage: async message => { received.push(message) },
    onReady: () => { ready++ },
    onFatal: verdict => { fatal.push(verdict) }
  })
  t.after(() => transport.stop())
  const emit = (event, payload) => sockets.at(-1).ev.emit(event, payload)
  return { store, transport, sockets, received, fatal, emit, ready: () => ready }
}

const open = emit => emit('connection.update', { connection: 'open' })
const closeWith = (emit, statusCode, message = 'closed') => emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) } })
const raw = (remoteJid, message, extra = {}) => ({ key: { remoteJid, id: `ID${Math.random()}`, fromMe: false }, message, messageTimestamp: nowSeconds(), pushName: 'Sari', ...extra })

test('first open seeds lastProcessedTs and announces once; 515 recreates immediately', async t => {
  const { store, transport, sockets, emit, ready } = setup(t)
  await transport.start()
  assert.equal(store.lastProcessedTs, 0)
  open(emit)
  assert.ok(Math.abs(store.lastProcessedTs - nowSeconds()) <= 1)
  closeWith(emit, 515, 'restart required')
  await sleep(10)
  assert.equal(sockets.length, 2)
  open(emit)
  assert.equal(ready(), 1)
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

  assert.deepEqual(transport.getHistory(CUSTOMER, 10).map(item => [item.fromMe, item.text]), [[false, 'jam buka?'], [false, 'ini?'], [true, 'Buka 08.00'], [true, 'ok']])
  await transport.markRead([{ raw: text }])
  assert.deepEqual(sockets[0].read, [text.key])
  assert.equal(typeof transport.generateId(), 'string')
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

test('stop codes: 401 and 440 stop without reconnecting', async t => {
  for (const [code, reason] of [[401, 'logged_out'], [440, 'connection_replaced']]) {
    const { transport, sockets, fatal, emit } = setup(t)
    await transport.start()
    open(emit)
    closeWith(emit, code)
    await sleep(10)
    assert.deepEqual(fatal.map(verdict => verdict.reason), [reason])
    assert.equal(sockets.length, 1)
    await assert.rejects(transport.send(CUSTOMER, 'x'), /not connected/)
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
