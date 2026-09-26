// Config lists that name chats (`blocklist`, `allowChats`). Entries are JIDs or phone numbers (08…, 62…, +62…);
// pushNames are not accepted because senders choose them. One person can reach the assistant as two chats (PN and
// LID): an entry names both, through the alt JID a message carried, WhatsApp's LID mapping, or the chat records
// linked by it (store.linkedChatIds).
import { jidUser } from './owner.js'

/** The digits of a phone-number entry (0812… → 62812…), or undefined for a JID entry. */
export const phoneEntry = entry => {
  const value = String(entry).trim()
  const digits = value.replace(/\D/g, '').replace(/^0/, '62')
  return !value.includes('@') && digits.length >= 6 ? digits : undefined
}

/** An entry that can name a chat at all; anything else would silently match nothing. */
export const isChatEntry = entry => typeof entry === 'string' && (entry.trim().includes('@') || phoneEntry(entry) !== undefined)

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
