// Pure helpers for the Baileys transport: JID classification, message normalization and disconnect handling.
// No socket, no network, so everything here is unit-testable with plain message objects.
import {
  areJidsSameUser, getContentType, isJidBroadcast, isJidGroup, isJidMetaAI, isJidNewsletter, isJidStatusBroadcast,
  isLidUser, isPnUser, isRealMessage, jidNormalizedUser, normalizeMessageContent, WAMessageStubType
} from 'baileys'

/** Filter order from docs/implementation-notes.md: status before broadcast (status@broadcast matches both). */
export function classifyJid (jid) {
  if (!jid) return 'missing'
  if (isJidStatusBroadcast(jid)) return 'status'
  if (isJidBroadcast(jid)) return 'broadcast'
  if (isJidNewsletter(jid)) return 'newsletter'
  if (isJidMetaAI(jid)) return 'meta_ai'
  if (isJidGroup(jid)) return 'group'
  if (isPnUser(jid) || isLidUser(jid)) return 'direct'
  return 'other'
}

export function extractText (message) {
  const content = normalizeMessageContent(message)
  if (!content) return { text: undefined, contentType: undefined, quotedText: undefined, isForwarded: false }
  const text = content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ??
    content.videoMessage?.caption ?? content.documentMessage?.caption
  const contentType = getContentType(content)
  const contextInfo = typeof content[contentType] === 'object' ? content[contentType]?.contextInfo : undefined
  const quotedText = contextInfo?.quotedMessage ? extractText(contextInfo.quotedMessage).text : undefined
  const isForwarded = Boolean(contextInfo?.isForwarded || contextInfo?.forwardingScore > 0)
  return { text: text ?? undefined, contentType, quotedText: quotedText ?? undefined, isForwarded }
}

// What nobody but the owner can see: files, of which only the caption reaches Claude, and content without text (a
// location pin, a contact card, a poll), which is never triaged but must still hold a thanks after it. Anything not
// named here is 'other'. Text, stickers, reactions and protocol messages are not such content.
const ATTACHMENT_KINDS = {
  imageMessage: 'image', videoMessage: 'video', ptvMessage: 'video', documentMessage: 'document', audioMessage: 'audio',
  locationMessage: 'location', liveLocationMessage: 'location', contactMessage: 'contact', contactsArrayMessage: 'contact',
  pollCreationMessage: 'poll', pollCreationMessageV2: 'poll', pollCreationMessageV3: 'poll', pollCreationMessageV4: 'poll',
  pollCreationMessageV5: 'poll', eventMessage: 'event'
}
const NOT_ATTACHMENTS = new Set(['conversation', 'extendedTextMessage', 'protocolMessage', 'reactionMessage', 'encReactionMessage',
  'stickerMessage', 'lottieStickerMessage', 'stickerSyncRmrMessage', 'stickerPackMessage', 'pollUpdateMessage', 'encEventResponseMessage',
  'keepInChatMessage', 'pinInChatMessage', 'senderKeyDistributionMessage', 'fastRatchetKeySenderKeyDistributionMessage',
  'placeholderMessage', 'secretEncryptedMessage', 'encCommentMessage', 'albumMessage'])

/** 'image' | 'video' | 'document' | 'audio' | 'location' | 'contact' | 'poll' | 'event' | 'other', or undefined for text. */
export const attachmentKind = contentType => (!contentType || NOT_ATTACHMENTS.has(contentType) ? undefined : ATTACHMENT_KINDS[contentType] ?? 'other')

export function toEpochSeconds (timestamp) {
  if (timestamp === null || timestamp === undefined) return 0
  if (typeof timestamp === 'number') return timestamp
  if (typeof timestamp.toNumber === 'function') return timestamp.toNumber() // protobuf Long
  return Number(timestamp) || 0
}

/** Own ids in both addressing forms; areJidsSameUser() is false for PN vs LID, so both are needed. */
export function getMeIds (user) {
  if (!user?.id) return []
  return [jidNormalizedUser(user.id), user.lid && jidNormalizedUser(user.lid)].filter(Boolean)
}

export function isSelfChatJid (jid, meIds) {
  return Boolean(jid) && !isJidGroup(jid) && meIds.some(me => areJidsSameUser(jid, me))
}

/**
 * One messages.upsert entry → `{message}` or `{skip: reason}`.
 * @param {object} raw  a WAMessage
 * @param {{type: 'notify'|'append', meIds: string[]}} context
 */
export function normalizeUpsert (raw, { type, meIds }) {
  const key = raw?.key
  if (!key?.remoteJid || !key.id) return { skip: 'no_key' }
  const jidKind = classifyJid(key.remoteJid)
  if (jidKind !== 'direct') return { skip: jidKind, id: key.id }
  // remoteJid only: Baileys fills remoteJidAlt from sender_pn/sender_lid first, so on the owner's replies in a
  // customer chat the alt can be the owner's own JID. An own JID is never the chat's other form, so it is dropped.
  const isSelfChat = isSelfChatJid(key.remoteJid, meIds)
  const chatIdAlt = key.remoteJidAlt && !isSelfChatJid(key.remoteJidAlt, meIds) ? key.remoteJidAlt : undefined
  const isCiphertext = !raw.message && raw.messageStubType === WAMessageStubType.CIPHERTEXT
  const { text, contentType, quotedText, isForwarded } = extractText(raw.message)
  const message = {
    id: key.id,
    chatId: key.remoteJid,
    chatIdAlt,
    fromMe: Boolean(key.fromMe),
    isSelfChat,
    senderName: raw.pushName ?? undefined,
    text: text ?? '',
    timestamp: toEpochSeconds(raw.messageTimestamp),
    kind: type === 'notify' ? 'notify' : 'append',
    quotedText,
    contentType,
    attachment: attachmentKind(contentType), // a caption ("makasih kak") can come with a payment proof
    isForwarded, // someone else's words: never an owner command, even in "Message yourself"
    raw
  }
  // Anything the owner sends in a customer chat (voice note, sticker, reaction, even one we cannot decrypt) is a
  // human reply and must start the takeover, so it is kept before the text-only filters below.
  if (key.fromMe && !isSelfChat && (contentType || isCiphertext)) return { message }
  if (isCiphertext) return { skip: 'ciphertext', id: key.id }
  if (!isRealMessage(raw)) return { skip: 'not_real', id: key.id }
  if (!text?.trim()) return { skip: 'no_text', id: key.id, contentType }
  return { message }
}

/**
 * What to do when the socket closes, from the status code table in docs/implementation-notes.md.
 * @returns {{action: 'stop'|'recreate_now'|'recreate_backoff', reason: string, advice?: string}}
 */
export function classifyDisconnect (statusCode, errorMessage = '') {
  switch (statusCode) {
    case 401:
      return { action: 'stop', reason: 'logged_out', advice: 'The session was logged out. Delete the auth/ directory (rm -rf auth) and run `npm run pair` to link again.' }
    case 403:
      return { action: 'stop', reason: 'forbidden', advice: 'WhatsApp refused the session (403). The account may be restricted; check the phone before retrying.' }
    case 405:
      return { action: 'stop', reason: 'client_too_old', advice: 'WhatsApp rejected the client version (405). Do not loop: wait for a Baileys release and re-check the pin.' }
    case 440:
      return { action: 'stop', reason: 'connection_replaced', advice: 'Another client replaced this session (440). Not reconnecting; make sure only one copy runs.' }
    case 515:
      return { action: 'recreate_now', reason: 'restart_required' }
    case 408:
      if (/QR refs attempts ended/i.test(errorMessage)) return { action: 'stop', reason: 'qr_expired', advice: 'The QR code expired without being scanned. Run `npm run pair` again.' }
      return { action: 'recreate_backoff', reason: 'timed_out' }
    default:
      return { action: 'recreate_backoff', reason: statusCode ? `status_${statusCode}` : 'unknown' }
  }
}

export const backoffMs = attempt => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))
