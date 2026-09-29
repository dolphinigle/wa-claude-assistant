// Builds the stdin user turn. Everything a contact wrote is escaped so it cannot close or open our tags.

const MAX_MESSAGE_CHARS = 4000
const MAX_HISTORY_CHARS = 1000
const MAX_NAME_CHARS = 60

export function escapeText (text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttribute (text) {
  return escapeText(text).replace(/"/g, '&quot;').replace(/[\r\n\t]+/g, ' ')
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)} …[truncated]` : text)

export function formatLocalTime (epochSeconds, timeZone = 'Asia/Jakarta', { withWeekday = false } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochSeconds * 1000)).map(part => [part.type, part.value]))
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
  return withWeekday ? `${parts.weekday} ${stamp}` : stamp
}

// Our attribute, never the sender's text: a caption cannot claim or hide a file. Claude cannot see the file itself.
const attachmentAttribute = items => {
  const kinds = [...new Set(items.map(item => item.attachment).filter(Boolean))]
  return kinds.length > 0 ? ` attachment="${escapeAttribute(kinds.join(' '))}"` : ''
}

// A reply names what it replies to: "iya kak" under an older question answers that question. The sender's app supplies
// the quote, so it is escaped like their text.
const quotedLine = message => (message.quotedText ? `<quoted>${escapeText(truncate(String(message.quotedText), MAX_HISTORY_CHARS))}</quoted>\n` : '')

/**
 * The earlier messages Claude may see: only those of the last `maxAgeMinutes` before the burst (0 = no age limit).
 * Owner request (2026-09-29): an older message may be another topic, or a tester's personal chat, so it is left out
 * entirely; `contextMessages` still caps the count (buildUserTurn).
 * @param {{timestamp: number}[]} history  oldest first, epoch seconds
 * @param {{since: number, maxAgeMinutes?: number}} options  `since`: the burst's first message, epoch seconds
 */
export function recentHistory (history, { since, maxAgeMinutes = 0 }) {
  if (!(maxAgeMinutes > 0)) return history
  const from = since - maxAgeMinutes * 60
  return history.filter(item => Number(item.timestamp) >= from)
}

/**
 * @param {object} input
 * @param {{name?: string}} input.chat
 * @param {{fromMe: boolean, text: string, timestamp: number, attachment?: string}[]} input.history  older messages, oldest first
 * @param {{text: string, timestamp: number, attachment?: string, quotedText?: string}[]} input.messages  the debounced burst to triage, oldest first
 * @param {number} input.now  epoch seconds
 * @param {{lines: string[], notes: string[]}} [input.lookup]  the Borma demo's facts for this burst (src/lookup.js): our
 *   own data, so trusted, in its own block before the history; escaped all the same
 */
export function buildUserTurn ({ chat = {}, history = [], messages, now, timeZone = 'Asia/Jakarta', contextMessages = 8, lookup }) {
  if (!messages?.length) throw new Error('buildUserTurn needs at least one message')
  const lines = [`now: ${formatLocalTime(now, timeZone, { withWeekday: true })} (${timeZone})`]
  const looked = [...(lookup?.lines ?? []), ...(lookup?.notes ?? []).map(note => `note: ${note}`)]
  if (looked.length > 0) lines.push('<lookup>', ...looked.map(escapeText), '</lookup>')

  const recent = contextMessages > 0 ? history.slice(-contextMessages) : []
  if (recent.length === 0) {
    lines.push('<history>(no earlier messages)</history>')
  } else {
    lines.push('<history>')
    for (const item of recent) {
      const role = item.fromMe ? 'owner' : 'customer'
      lines.push(`<msg role="${role}" time="${formatLocalTime(item.timestamp, timeZone)}"${attachmentAttribute([item])}>`)
      lines.push(escapeText(truncate(String(item.text ?? ''), MAX_HISTORY_CHARS)))
      lines.push('</msg>')
    }
    lines.push('</history>')
  }

  const name = escapeAttribute(truncate(String(chat.name ?? 'unknown'), MAX_NAME_CHARS))
  const last = messages[messages.length - 1]
  lines.push(`<message from="customer" name="${name}" time="${formatLocalTime(last.timestamp ?? now, timeZone)}"${attachmentAttribute(messages)}>`)
  const parts = []
  let budget = MAX_MESSAGE_CHARS // for the burst's text together, quotes aside
  for (const message of messages) {
    const text = String(message.text ?? '')
    const room = Math.max(budget, 0)
    parts.push(quotedLine(message) + escapeText(truncate(text, room)))
    if (text.length > room) break
    budget = room - text.length - 1
  }
  lines.push(parts.join('\n'))
  lines.push('</message>')
  return `${lines.join('\n')}\n`
}
