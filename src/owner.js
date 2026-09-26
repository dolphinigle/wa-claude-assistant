// Owner commands typed in the "Message yourself" chat, and the notices the bot posts there.

export const BOT_PREFIX = '🤖'
const HOUR_MS = 60 * 60 * 1000
const EXCERPT_CHARS = 200
const REPLAY_SLACK_MS = 60 * 1000

export const HELP_TEXT = `${BOT_PREFIX} Commands (type them here, in "Message yourself"):
/ok N — send draft N as written
/edit N <text> — send your text instead of draft N
/no N — discard draft N
/pause — stop all auto-replies (drafts still arrive)
/resume — allow auto-replies again
/status — mode, pending drafts, counters, quota
/mute <N|number|name> — never auto-reply in that chat (N = a draft number)
/unmute <N|number|name> — undo /mute
/help — this list`

export const excerpt = (text, max = EXCERPT_CHARS) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The user part of a JID, without the device suffix: 6281234567890 for 6281234567890:3@s.whatsapp.net. */
export const jidUser = jid => jid.split('@')[0].split(':')[0]

/**
 * "Name (+62…)" for notices. The name is the sender's own pushName, which anyone can set to "Mama" or a real
 * customer's name, so the number is always shown next to it (the JID when only a LID is known).
 */
export function formatContact (chatId, { name, chatIdAlt } = {}) {
  const phoneJid = [chatId, chatIdAlt].find(jid => jid?.endsWith('@s.whatsapp.net'))
  const number = phoneJid ? `+${jidUser(phoneJid)}` : chatId
  return name ? `${name} (${number})` : number
}

/** Parses "/cmd ..." into {name, draftId?, body?, target?}; returns null for anything that is not a command. */
export function parseCommand (input) {
  const text = String(input ?? '').trim()
  if (!text.startsWith('/')) return null
  const match = text.match(/^\/([a-z]+)\b[ \t]*([\s\S]*)$/i)
  if (!match) return { name: 'unknown', raw: text }
  const name = match[1].toLowerCase()
  const rest = match[2].trim()
  switch (name) {
    case 'ok':
    case 'no': {
      const id = rest.match(/^(\d+)$/)
      return id ? { name, draftId: Number(id[1]) } : { name: 'usage', usage: `/${name} N` }
    }
    case 'edit': {
      const parts = rest.match(/^(\d+)\s+([\s\S]+)$/)
      return parts ? { name, draftId: Number(parts[1]), body: parts[2].trim() } : { name: 'usage', usage: '/edit N <text>' }
    }
    case 'mute':
    case 'unmute':
      return rest ? { name, target: rest } : { name: 'usage', usage: `/${name} <N|number|name>` }
    case 'pause':
    case 'resume':
    case 'status':
    case 'help':
      return { name }
    default:
      return { name: 'unknown', raw: text }
  }
}

/** One format for every escalation: Claude's summary and reason say why it needs the owner, the gates why an answer was held. */
export function formatDraftNotice (draft) {
  const lines = [`${BOT_PREFIX} 📝 DRAFT #${draft.id} · ${draft.contactName}`, `They wrote: "${draft.excerpt}"`]
  if (draft.summary) lines.push(`Summary: ${draft.summary}`)
  lines.push(draft.draft ? `Draft:\n${draft.draft}` : 'Draft: (none, write your own)')
  if (draft.privateDetails?.length > 0) lines.push(`⚠️ Check before /ok: the draft mentions your own account or machine details (${draft.privateDetails.join(', ')}).`)
  lines.push(`Why: ${draft.reason}`)
  const blockers = (draft.policyReasons ?? []).filter(reason => !reason.startsWith('decision:'))
  if (blockers.length > 0) lines.push(`Not auto-sent: ${blockers.join(', ')}`)
  if (blockers.includes('blocklist_unchecked')) lines.push(`Number unknown, so the blocklist cannot match it by phone number. To exclude this contact, add "${draft.chatId}" to blocklist.`)
  lines.push(draft.draft ? `Reply: /ok ${draft.id} · /edit ${draft.id} <text> · /no ${draft.id}` : `Reply: /edit ${draft.id} <text> · /no ${draft.id}`)
  return lines.join('\n')
}

export const formatClock = (epochMs, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epochMs))
const percent = value => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '?')

/**
 * @param {object} deps
 * @param {{sendToCustomer: Function}} deps.gate  the assistant's single send gate
 */
export function createOwnerCommands ({ config, store, gate, now = () => Date.now() }) {
  const ttlMs = (config.draftTtlHours ?? 24) * HOUR_MS
  const chatName = chatId => formatContact(chatId, store.existingChat(chatId))
  // Drafts whose send is in flight: two self-chat commands run concurrently (Baileys does not await listeners).
  const sending = new Set()

  function pendingDraft (id, commandTimestampMs) {
    const draft = store.getDraft(id)
    if (!draft) return { error: `No draft #${id}.` }
    // A replayed "/ok 3" from history must not approve a newer draft that reuses the number (1 min clock slack).
    if (commandTimestampMs && draft.createdAt > commandTimestampMs + REPLAY_SLACK_MS) return { error: `Draft #${id} is newer than this command; ignored.` }
    if (draft.status === 'pending' && now() - draft.createdAt >= ttlMs) store.resolveDraft(id, 'expired')
    if (draft.status !== 'pending') return { error: `Draft #${id} is already ${draft.status}.` }
    if (sending.has(draft.id)) return { error: `Draft #${id} is being sent right now.` }
    return { draft }
  }

  async function sendDraft (draft, text, status) {
    sending.add(draft.id) // claimed before the first await
    let outcome
    try {
      outcome = await gate.sendToCustomer(draft.chatId, text, { source: status, draftId: draft.id })
    } finally {
      sending.delete(draft.id)
    }
    if (outcome.shadow) {
      store.resolveDraft(draft.id, `${status}_shadow`, { sentText: text })
      return `${BOT_PREFIX} [SHADOW] Draft #${draft.id} approved. Would send to ${draft.contactName}:\n${text}`
    }
    if (!outcome.sent) return `${BOT_PREFIX} ⚠️ Sending draft #${draft.id} failed (${outcome.error}). It is still pending.`
    store.resolveDraft(draft.id, status, { sentText: text })
    return `${BOT_PREFIX} ✅ Sent to ${draft.contactName} (draft #${draft.id}).`
  }

  function resolveTarget (target) {
    if (/^\d{1,6}$/.test(target)) {
      const draft = store.getDraft(Number(target))
      return draft ? { chatId: draft.chatId } : { error: `No draft #${target}.` }
    }
    if (target.includes('@')) return store.existingChat(target) ? { chatId: target } : { error: `No chat ${target}.` }
    const digits = target.replace(/[\s+().-]/g, '')
    const matches = /^\d{7,}$/.test(digits)
      ? Object.keys(store.state.chats).filter(chatId => [chatId, store.existingChat(chatId).chatIdAlt].some(jid => jid && jidUser(jid) === digits.replace(/^0/, '62')))
      : store.findChatsByName(target)
    if (matches.length === 0) return { error: `No chat matches "${target}".` }
    // Names are chosen by the senders, so two chats sharing one must be told apart by number or draft number.
    if (matches.length > 1) return { error: `"${target}" matches ${matches.map(chatName).join(', ')}; use the number or a draft number.` }
    return { chatId: matches[0] }
  }

  function status () {
    const pending = store.pendingDrafts()
    const at = now()
    const chats = Object.entries(store.state.chats)
    const takeovers = chats.filter(([, chat]) => chat.takeoverUntil > at).map(([id, chat]) => `${chatName(id)} (until ${formatClock(chat.takeoverUntil, config.timezone)})`)
    const muted = chats.filter(([, chat]) => chat.muted).map(([id]) => chatName(id))
    const quota = store.lastRateLimit
    const autoSend = !config.autoSend.enabled ? 'disabled in config' : store.paused ? 'PAUSED' : 'on'
    return [
      `${BOT_PREFIX} Status`,
      `Mode: ${config.mode === 'live' ? 'live' : 'shadow (nothing is sent to customers)'}`,
      `Auto-reply: ${autoSend}`,
      `Pending drafts: ${pending.length === 0 ? 'none' : pending.map(draft => `#${draft.id} ${draft.contactName}`).join(', ')}`,
      `Auto-replies in the last 24 h: ${store.countAutoSends(24 * HOUR_MS)}/${config.autoSend.maxPerDay}`,
      `Claude quota: 5 h ${percent(quota?.fiveHourUtilization)}, 7 d ${percent(quota?.sevenDayUtilization)} (${quota?.status ?? 'not seen yet'})`,
      `Human takeover: ${takeovers.length ? takeovers.join(', ') : 'none'}`,
      `Muted: ${muted.length ? muted.join(', ') : 'none'}`
    ].join('\n')
  }

  /**
   * @param {string} text  the owner's message
   * @param {{timestampMs?: number}} [context]  set for late (backlog) commands only; live ones use now()
   * @returns {Promise<string|null>} the reply to post in self-chat (null: not a command)
   */
  async function handle (text, { timestampMs } = {}) {
    const command = parseCommand(text)
    if (!command) return null
    store.audit('owner_command', { command: command.name, draftId: command.draftId, target: command.target })
    switch (command.name) {
      case 'ok': {
        const { draft, error } = pendingDraft(command.draftId, timestampMs)
        if (error) return `${BOT_PREFIX} ${error}`
        if (!draft.draft) return `${BOT_PREFIX} Draft #${draft.id} has no text. Use /edit ${draft.id} <text>.`
        return sendDraft(draft, draft.draft, 'approved')
      }
      case 'edit': {
        const { draft, error } = pendingDraft(command.draftId, timestampMs)
        if (error) return `${BOT_PREFIX} ${error}`
        return sendDraft(draft, command.body, 'edited')
      }
      case 'no': {
        const { draft, error } = pendingDraft(command.draftId, timestampMs)
        if (error) return `${BOT_PREFIX} ${error}`
        store.resolveDraft(draft.id, 'rejected')
        return `${BOT_PREFIX} 🗑️ Discarded draft #${draft.id} (${draft.contactName}).`
      }
      case 'pause':
      case 'resume':
        if (timestampMs && timestampMs < store.pauseChangedAt) return `${BOT_PREFIX} Ignored a late /${command.name} typed before your last /pause or /resume.`
        store.setPaused(command.name === 'pause', timestampMs ?? now())
        if (command.name === 'pause') return `${BOT_PREFIX} ⏸️ Auto-replies paused. Drafts still come here. /resume to undo.`
        return `${BOT_PREFIX} ▶️ Auto-replies resumed${config.mode === 'live' ? '' : ' (shadow mode: still nothing is sent to customers)'}.`
      case 'status':
        return status()
      case 'mute':
      case 'unmute': {
        const { chatId, error } = resolveTarget(command.target)
        if (error) return `${BOT_PREFIX} ${error}`
        store.updateChat(chatId, { muted: command.name === 'mute' })
        return command.name === 'mute'
          ? `${BOT_PREFIX} 🔇 Muted ${chatName(chatId)}: no auto-replies there; drafts still come here.`
          : `${BOT_PREFIX} 🔈 Unmuted ${chatName(chatId)}.`
      }
      case 'help':
        return HELP_TEXT
      case 'usage':
        return `${BOT_PREFIX} Usage: ${command.usage}`
      default:
        return `${BOT_PREFIX} Unknown command. ${HELP_TEXT.split('\n').slice(1).map(line => line.split(' — ')[0]).join(' ')}`
    }
  }

  return { handle, status }
}
