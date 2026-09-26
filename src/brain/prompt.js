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

/**
 * @param {object} input
 * @param {{name?: string}} input.chat
 * @param {{fromMe: boolean, text: string, timestamp: number}[]} input.history  older messages, oldest first
 * @param {{text: string, timestamp: number}[]} input.messages  the debounced burst to triage, oldest first
 * @param {number} input.now  epoch seconds
 */
export function buildUserTurn ({ chat = {}, history = [], messages, now, timeZone = 'Asia/Jakarta', contextMessages = 8 }) {
  if (!messages?.length) throw new Error('buildUserTurn needs at least one message')
  const lines = [`now: ${formatLocalTime(now, timeZone, { withWeekday: true })} (${timeZone})`]

  const recent = contextMessages > 0 ? history.slice(-contextMessages) : []
  if (recent.length === 0) {
    lines.push('<history>(no earlier messages)</history>')
  } else {
    lines.push('<history>')
    for (const item of recent) {
      const role = item.fromMe ? 'owner' : 'customer'
      lines.push(`<msg role="${role}" time="${formatLocalTime(item.timestamp, timeZone)}">`)
      lines.push(escapeText(truncate(String(item.text ?? ''), MAX_HISTORY_CHARS)))
      lines.push('</msg>')
    }
    lines.push('</history>')
  }

  const name = escapeAttribute(truncate(String(chat.name ?? 'unknown'), MAX_NAME_CHARS))
  const last = messages[messages.length - 1]
  lines.push(`<message from="customer" name="${name}" time="${formatLocalTime(last.timestamp ?? now, timeZone)}">`)
  lines.push(escapeText(truncate(messages.map(message => String(message.text ?? '')).join('\n'), MAX_MESSAGE_CHARS)))
  lines.push('</message>')
  return `${lines.join('\n')}\n`
}
