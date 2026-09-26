// Config lists that name chats (`blocklist`, `allowChats`). Entries are JIDs or phone numbers (08…, 62…, +62…);
// pushNames are not accepted because senders choose them. One person can reach the assistant as two chats (PN and
// LID): an entry names both, through the alt JID a message carried, WhatsApp's LID mapping, or the chat records
// linked by it (store.linkedChatIds).
import { jidUser } from './owner.js'

/**
 * The digits of a phone-number entry (0812… → 62812…), or undefined for a JID entry. The trunk 0 is dropped after
 * the country code too ("+62 0812…", "+62 (0)812…" → 62812…): no number starts with 620, since 62 is Indonesia and
 * an Indonesian number never starts with 0 (consistency-r3-1).
 */
export const phoneEntry = entry => {
  const value = String(entry).trim()
  const digits = value.replace(/\D/g, '').replace(/^0/, '62').replace(/^620/, '62')
  return !value.includes('@') && digits.length >= 6 ? digits : undefined
}

// A JID entry is matched as written, so it must be in the form WhatsApp gives a 1:1 chat: "6281…@s.whatsapp.net" (no
// leading 0 or +, no trunk 0 after 62, no ":device"), "…@lid", or an `npm run dev` contact ("alice@console").
// "0812…@s.whatsapp.net", "620812…@s.whatsapp.net", "…@c.us", "…@S.WHATSAPP.NET" or "Mama@rumah" would never match
// (skip-safety-r2-2, consistency-r2-1, consistency-r3-1).
const JID_ENTRY = /^(?:(?!620)[1-9]\d{5,}@s\.whatsapp\.net|\d+@lid|[a-z0-9_.-]+@console)$/

/** An entry that can name a chat at all; anything else would silently match nothing. */
export const isChatEntry = entry => typeof entry === 'string' && (JID_ENTRY.test(entry.trim()) || phoneEntry(entry) !== undefined)

/** Whether an entry of `list` names the chat on either of its addressing forms. Never creates a chat record. */
export function listNamesChat (list, store, chatId, chatIdAlt) {
  const ids = store.linkedChatIds(chatId, chatIdAlt)
  const users = ids.map(jidUser)
  return (list ?? []).some(entry => ids.includes(String(entry).trim()) || users.includes(phoneEntry(entry)))
}

/**
 * With `allowChats` set, only the chats it names are handled; an empty list handles every chat. A LID chat whose
 * phone number is unknown cannot match a phone-number entry, so it is not allowed (fail closed) until its number is
 * known or its LID is listed. "Message yourself" is not a chat this applies to: callers let it through first.
 */
export const isAllowedChat = (config, store, chatId, chatIdAlt) =>
  !(config.allowChats?.length > 0) || listNamesChat(config.allowChats, store, chatId, chatIdAlt)
