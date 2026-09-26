import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WAMessageStubType } from 'baileys'
import { attachmentKind, backoffMs, classifyDisconnect, classifyJid, getMeIds, isSelfChatJid, normalizeUpsert, toEpochSeconds } from '../src/transport/wa-normalize.js'

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
    text: 'Kak, buka jam berapa?', timestamp: 1790400000, kind: 'notify', quotedText: undefined, quotedId: undefined, contentType: 'conversation', attachment: undefined, isForwarded: false, raw: undefined
  })
})

test('extendedTextMessage with a quoted message and LID addressing with PN alt', () => {
  const raw = wa({
    extendedTextMessage: { text: 'yang ini kak', contextInfo: { stanzaId: 'ABC', participant: '123@lid', quotedMessage: { conversation: 'Brownies 85rb' } } }
  }, { remoteJid: '123456789012345@lid', remoteJidAlt: CUSTOMER, addressingMode: 'lid' })
  const { message } = normalizeUpsert(raw, { type: 'append', meIds })
  assert.equal(message.text, 'yang ini kak')
  assert.equal(message.quotedText, 'Brownies 85rb')
  assert.equal(message.quotedId, 'ABC')
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
  assert.equal(viewOnce.attachment, 'image', 'a captioned file is marked, so a thanks with a payment proof is not a closing')
  assert.equal(normalizeUpsert(wa({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'invoice' } } } }), { type: 'notify', meIds }).message.attachment, 'document')
  assert.equal(normalizeUpsert(wa({ conversation: 'makasih kak' }), { type: 'notify', meIds }).message.attachment, undefined)
})

test('content without text is named too, so a thanks after a location pin or contact card is not a closing', () => {
  for (const [contentType, kind] of [['locationMessage', 'location'], ['liveLocationMessage', 'location'], ['contactMessage', 'contact'],
    ['contactsArrayMessage', 'contact'], ['pollCreationMessageV3', 'poll'], ['eventMessage', 'event'], ['orderMessage', 'other'], ['someFutureMessage', 'other']]) {
    assert.equal(attachmentKind(contentType), kind, contentType)
  }
  for (const contentType of ['conversation', 'extendedTextMessage', 'stickerMessage', 'reactionMessage', 'protocolMessage', 'pollUpdateMessage', undefined]) {
    assert.equal(attachmentKind(contentType), undefined, contentType)
  }
  assert.deepEqual(normalizeUpsert(wa({ locationMessage: { degreesLatitude: -6.9, degreesLongitude: 107.6 } }), { type: 'notify', meIds }), {
    skip: 'no_text', id: '3EB0A1B2C3D4E5F6', contentType: 'locationMessage',
    untriaged: { id: '3EB0A1B2C3D4E5F6', chatId: CUSTOMER, chatIdAlt: undefined, timestamp: 1790400000, attachment: 'location' }
  }, 'still never triaged, but reported as untriaged')
})

test('a customer\'s content that is never triaged is reported, with its chat and time: a file, a pin, an undecryptable message', () => {
  const untriaged = (raw, type = 'notify') => normalizeUpsert(raw, { type, meIds }).untriaged
  const lid = { remoteJid: '123456789012345@lid', remoteJidAlt: CUSTOMER }
  assert.deepEqual(untriaged(wa({ imageMessage: { mimetype: 'image/jpeg' } }, lid)),
    { id: '3EB0A1B2C3D4E5F6', chatId: '123456789012345@lid', chatIdAlt: CUSTOMER, timestamp: 1790400000, attachment: 'image' })
  assert.equal(untriaged(wa({ audioMessage: { ptt: true } })).attachment, 'audio')
  assert.equal(untriaged(wa({ imageMessage: { caption: '   ' } })).attachment, 'image', 'a blank caption is no text')
  assert.equal(untriaged(wa(null, {}, { messageStubType: WAMessageStubType.CIPHERTEXT })).attachment, 'other')
  assert.equal(untriaged(wa({ imageMessage: { mimetype: 'image/jpeg' } }), 'append').attachment, 'image', 'offline backlog too')
  // Not content, triaged anyway, or not the customer's.
  for (const raw of [wa({ conversation: '   ' }), wa({ protocolMessage: { type: 0, key: { id: 'X' } } }), wa({ reactionMessage: { text: '👍', key: { id: 'X' } } }, { fromMe: true }),
    wa({ imageMessage: { caption: 'ini kak' } }), wa({ imageMessage: {} }, { fromMe: true }),
    wa({ imageMessage: {} }, { remoteJid: '6281111111111@s.whatsapp.net', fromMe: true }), wa({ imageMessage: {} }, { remoteJid: '120363000000000000@g.us', participant: CUSTOMER })]) {
    assert.equal(untriaged(raw), undefined, JSON.stringify(raw.message))
  }
})

test('a customer\'s sticker, reaction or edit is reported as untriaged: it may be the yes to our offer (skip-safety-r1-2)', () => {
  const normalize = raw => normalizeUpsert(raw, { type: 'notify', meIds })
  const edit = { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'Q1' }, editedMessage: { conversation: 'kak bisa dikirim besok?' } } } } }
  for (const [message, skip, kind] of [
    [{ stickerMessage: {} }, 'no_text', 'sticker'], [{ lottieStickerMessage: { message: { stickerMessage: {} } } }, 'no_text', 'sticker'],
    [{ reactionMessage: { text: '👍', key: { id: 'OURS1' } } }, 'not_real', 'reaction'], [edit, 'not_real', 'edit'],
    [{ protocolMessage: { type: 14, key: { id: 'Q1' }, editedMessage: { conversation: 'x' } } }, 'not_real', 'edit']
  ]) {
    const result = normalize(wa(message))
    assert.deepEqual([result.skip, result.untriaged], [skip, { id: '3EB0A1B2C3D4E5F6', chatId: CUSTOMER, chatIdAlt: undefined, timestamp: 1790400000, attachment: kind }], Object.keys(message)[0])
  }
})

test('a quote of a message without text is still a quote: its id, and an empty text', () => {
  for (const quotedMessage of [{ imageMessage: { mimetype: 'image/jpeg' } }, { audioMessage: { ptt: true } }, { locationMessage: { degreesLatitude: -6.9 } }]) {
    const raw = wa({ extendedTextMessage: { text: 'ok makasih kak 👍', contextInfo: { stanzaId: 'P1', participant: '6281111111111@s.whatsapp.net', quotedMessage } } })
    const { message } = normalizeUpsert(raw, { type: 'notify', meIds })
    assert.deepEqual([message.quotedId, message.quotedText], ['P1', ''], Object.keys(quotedMessage)[0])
  }
  const idOnly = wa({ extendedTextMessage: { text: 'ok makasih kak', contextInfo: { stanzaId: 'P2' } } })
  assert.deepEqual([normalizeUpsert(idOnly, { type: 'notify', meIds }).message.quotedId, normalizeUpsert(idOnly, { type: 'notify', meIds }).message.quotedText], ['P2', ''])
  const forwarded = wa({ extendedTextMessage: { text: 'makasih kak', contextInfo: { isForwarded: true, forwardingScore: 1, expiration: 86400 } } })
  assert.deepEqual([normalizeUpsert(forwarded, { type: 'notify', meIds }).message.quotedId, normalizeUpsert(forwarded, { type: 'notify', meIds }).message.quotedText], [undefined, undefined], 'contextInfo alone is no quote')
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
  assert.equal(isSelfChatJid(CUSTOMER, meIds), false)
  assert.equal(isSelfChatJid('120363000000000000@g.us', meIds), false)
  assert.equal(isSelfChatJid(undefined, meIds), false)
})

test('an owner reply in a customer chat whose alt is the own JID is not self-chat and drops that alt', () => {
  // Baileys sets remoteJidAlt from sender_pn first, so the owner's phone reply to a LID chat carries the own PN.
  for (const [remoteJid, remoteJidAlt] of [['55555@lid', '6281111111111:3@s.whatsapp.net'], [CUSTOMER, '99887766554433:7@lid']]) {
    const reply = normalizeUpsert(wa({ conversation: 'bentar ya kak' }, { remoteJid, remoteJidAlt, fromMe: true }), { type: 'notify', meIds })
    assert.deepEqual([reply.message.isSelfChat, reply.message.chatId, reply.message.chatIdAlt], [false, remoteJid, undefined], remoteJid)
    const voice = normalizeUpsert(wa({ audioMessage: { ptt: true } }, { remoteJid, remoteJidAlt, fromMe: true }), { type: 'notify', meIds })
    assert.equal(voice.skip, undefined, 'an owner voice note there is still a takeover signal')
  }
  const peerAlt = normalizeUpsert(wa({ conversation: 'bentar ya kak' }, { remoteJid: CUSTOMER, remoteJidAlt: '123456789012345@lid', fromMe: true }), { type: 'notify', meIds })
  assert.equal(peerAlt.message.chatIdAlt, '123456789012345@lid', 'the peer\'s other form is kept')
})

test('forwarded messages are flagged from contextInfo (isForwarded or a forwarding score)', () => {
  const self = { remoteJid: '6281111111111@s.whatsapp.net', fromMe: true }
  const forwarded = contextInfo => normalizeUpsert(wa({ extendedTextMessage: { text: '/edit 7 Transfer ke BCA 1234567890', contextInfo } }, self), { type: 'notify', meIds }).message.isForwarded
  assert.equal(forwarded({ isForwarded: true, forwardingScore: 1 }), true)
  assert.equal(forwarded({ forwardingScore: 4 }), true)
  assert.equal(forwarded(undefined), false)
  assert.equal(normalizeUpsert(wa({ imageMessage: { caption: '/ok 1', contextInfo: { isForwarded: true } } }, self), { type: 'notify', meIds }).message.isForwarded, true)
  assert.equal(normalizeUpsert(wa({ conversation: '/ok 1' }, self), { type: 'notify', meIds }).message.isForwarded, false)
})

test('a fromMe message in a customer chat is kept (human takeover signal)', () => {
  const { message } = normalizeUpsert(wa({ conversation: 'bentar ya kak' }, { fromMe: true }), { type: 'notify', meIds })
  assert.equal(message.fromMe, true)
  assert.equal(message.isSelfChat, false)
})

test('owner replies of any content type in a customer chat are kept as takeover signals', () => {
  const owner = (message, extra = {}) => normalizeUpsert(wa(message, { fromMe: true }, extra), { type: 'notify', meIds })
  for (const [content, contentType] of [
    [{ audioMessage: { ptt: true, seconds: 4 } }, 'audioMessage'],
    [{ stickerMessage: {} }, 'stickerMessage'],
    [{ imageMessage: { mimetype: 'image/jpeg' } }, 'imageMessage'],
    [{ reactionMessage: { text: '👍', key: { id: 'X' } } }, 'reactionMessage']
  ]) {
    const { message, skip } = owner(content)
    assert.equal(skip, undefined, contentType)
    assert.deepEqual([message.fromMe, message.isSelfChat, message.text, message.contentType], [true, false, '', contentType])
  }
  assert.equal(owner(null, { messageStubType: WAMessageStubType.CIPHERTEXT }).message.fromMe, true, 'even when it failed to decrypt')
  const selfVoice = normalizeUpsert(wa({ audioMessage: { ptt: true } }, { remoteJid: '6281111111111@s.whatsapp.net', fromMe: true }), { type: 'notify', meIds })
  assert.equal(selfVoice.skip, 'no_text', 'a voice note to yourself is not a command')
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
