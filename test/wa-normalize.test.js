import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WAMessageStubType } from 'baileys'
import { backoffMs, classifyDisconnect, classifyJid, getMeIds, isSelfChatJid, normalizeUpsert, toEpochSeconds } from '../src/transport/wa-normalize.js'

const ME = { id: '6281111111111:7@s.whatsapp.net', lid: '99887766554433:7@lid', name: 'Owner' }
const meIds = getMeIds(ME)
const CUSTOMER = '6282222222222@s.whatsapp.net'

// Shapes as Baileys 7 emits them in messages.upsert (key, message, messageTimestamp, pushName).
const wa = (message, key = {}, extra = {}) => ({
  key: { remoteJid: CUSTOMER, fromMe: false, id: '3EB0A1B2C3D4E5F6', ...key },
  message,
  messageTimestamp: 1790400000,
  pushName: 'Sari',
  ...extra
})

test('own ids cover PN and LID, device suffix stripped', () => {
  assert.deepEqual(meIds, ['6281111111111@s.whatsapp.net', '99887766554433@lid'])
  assert.deepEqual(getMeIds(undefined), [])
})

test('jid classification follows the notes order', () => {
  assert.equal(classifyJid('status@broadcast'), 'status')
  assert.equal(classifyJid('1700000000@broadcast'), 'broadcast')
  assert.equal(classifyJid('120363111111111111@newsletter'), 'newsletter')
  assert.equal(classifyJid('867051314767696@bot'), 'meta_ai')
  assert.equal(classifyJid('120363000000000000@g.us'), 'group')
  assert.equal(classifyJid(CUSTOMER), 'direct')
  assert.equal(classifyJid('123456789012345@lid'), 'direct')
  assert.equal(classifyJid('13135550002@c.us'), 'other')
  assert.equal(classifyJid(undefined), 'missing')
})

test('plain conversation', () => {
  const { message } = normalizeUpsert(wa({ conversation: 'Kak, buka jam berapa?' }), { type: 'notify', meIds })
  assert.deepEqual({ ...message, raw: undefined }, {
    id: '3EB0A1B2C3D4E5F6', chatId: CUSTOMER, chatIdAlt: undefined, fromMe: false, isSelfChat: false, senderName: 'Sari',
    text: 'Kak, buka jam berapa?', timestamp: 1790400000, kind: 'notify', quotedText: undefined, contentType: 'conversation', raw: undefined
  })
})

test('extendedTextMessage with a quoted message and LID addressing with PN alt', () => {
  const raw = wa({
    extendedTextMessage: { text: 'yang ini kak', contextInfo: { stanzaId: 'ABC', participant: '123@lid', quotedMessage: { conversation: 'Brownies 85rb' } } }
  }, { remoteJid: '123456789012345@lid', remoteJidAlt: CUSTOMER, addressingMode: 'lid' })
  const { message } = normalizeUpsert(raw, { type: 'append', meIds })
  assert.equal(message.text, 'yang ini kak')
  assert.equal(message.quotedText, 'Brownies 85rb')
  assert.equal(message.chatId, '123456789012345@lid', 'state is keyed by remoteJid exactly as received')
  assert.equal(message.chatIdAlt, CUSTOMER)
  assert.equal(message.kind, 'append')
})

test('ephemeral, viewOnce and document-with-caption wrappers are unwrapped', () => {
  assert.equal(normalizeUpsert(wa({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hilang' } } } }), { type: 'notify', meIds }).message.text, 'hilang')
  const viewOnce = normalizeUpsert(wa({ viewOnceMessageV2: { message: { imageMessage: { caption: 'lihat ini' } } } }), { type: 'notify', meIds }).message
  assert.equal(viewOnce.text, 'lihat ini')
  assert.equal(viewOnce.contentType, 'imageMessage')
  assert.equal(normalizeUpsert(wa({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'invoice' } } } }), { type: 'notify', meIds }).message.text, 'invoice')
  assert.equal(normalizeUpsert(wa({ videoMessage: { caption: 'video kue' } }), { type: 'notify', meIds }).message.text, 'video kue')
})

test('skips: status, broadcast list, group, newsletter, Meta AI, non-text, reactions, protocol, ciphertext', () => {
  const skip = (raw, type = 'notify') => normalizeUpsert(raw, { type, meIds }).skip
  assert.equal(skip(wa({ conversation: 'status' }, { remoteJid: 'status@broadcast', participant: CUSTOMER })), 'status')
  assert.equal(skip(wa({ conversation: 'bc' }, { remoteJid: '1700000000@broadcast' })), 'broadcast')
  assert.equal(skip(wa({ conversation: 'grup' }, { remoteJid: '120363000000000000@g.us', participant: CUSTOMER })), 'group')
  assert.equal(skip(wa({ conversation: 'news' }, { remoteJid: '120363111111111111@newsletter' })), 'newsletter')
  assert.equal(skip(wa({ conversation: 'hi' }, { remoteJid: '867051314767696@bot' })), 'meta_ai')
  assert.equal(skip(wa({ imageMessage: { mimetype: 'image/jpeg' } })), 'no_text')
  assert.equal(skip(wa({ stickerMessage: {} })), 'no_text')
  assert.equal(skip(wa({ reactionMessage: { text: '👍', key: { id: 'X' } } })), 'not_real')
  assert.equal(skip(wa({ protocolMessage: { type: 0, key: { id: 'X' } } })), 'not_real')
  assert.equal(skip(wa(null, {}, { messageStubType: WAMessageStubType.CIPHERTEXT })), 'ciphertext')
  assert.equal(skip({ message: { conversation: 'x' } }), 'no_key')
  assert.equal(skip(wa({ conversation: '   ' })), 'no_text')
})

test('self-chat is detected via PN and via LID (device suffixes ignored)', () => {
  const viaPn = normalizeUpsert(wa({ conversation: '/ok 1' }, { remoteJid: '6281111111111@s.whatsapp.net', fromMe: true }), { type: 'notify', meIds }).message
  assert.equal(viaPn.isSelfChat, true)
  assert.equal(viaPn.fromMe, true)
  const viaLid = normalizeUpsert(wa({ conversation: '/status' }, { remoteJid: '99887766554433@lid', fromMe: true }), { type: 'notify', meIds }).message
  assert.equal(viaLid.isSelfChat, true)
  const viaAlt = normalizeUpsert(wa({ conversation: '/status' }, { remoteJid: '55555@lid', remoteJidAlt: '6281111111111:3@s.whatsapp.net', fromMe: true }), { type: 'notify', meIds }).message
  assert.equal(viaAlt.isSelfChat, true)
  assert.equal(isSelfChatJid(CUSTOMER, meIds), false)
  assert.equal(isSelfChatJid('120363000000000000@g.us', meIds), false)
  assert.equal(isSelfChatJid(undefined, meIds), false)
})

test('a fromMe message in a customer chat is kept (human takeover signal)', () => {
  const { message } = normalizeUpsert(wa({ conversation: 'bentar ya kak' }, { fromMe: true }), { type: 'notify', meIds })
  assert.equal(message.fromMe, true)
  assert.equal(message.isSelfChat, false)
})

test('timestamps: number, Long-like and string', () => {
  assert.equal(toEpochSeconds(5), 5)
  assert.equal(toEpochSeconds({ toNumber: () => 7 }), 7)
  assert.equal(toEpochSeconds('9'), 9)
  assert.equal(toEpochSeconds(undefined), 0)
})

test('disconnect table', () => {
  assert.equal(classifyDisconnect(401).action, 'stop')
  assert.match(classifyDisconnect(401).advice, /rm -rf auth/)
  assert.equal(classifyDisconnect(515).action, 'recreate_now')
  assert.equal(classifyDisconnect(440).action, 'stop')
  assert.equal(classifyDisconnect(405).action, 'stop')
  assert.equal(classifyDisconnect(403).action, 'stop')
  assert.equal(classifyDisconnect(408, 'QR refs attempts ended').action, 'stop')
  for (const code of [408, 428, 500, 503, 411, undefined]) assert.equal(classifyDisconnect(code).action, 'recreate_backoff', String(code))
  assert.deepEqual([1, 2, 3, 7, 20].map(backoffMs), [1000, 2000, 4000, 60000, 60000])
})
