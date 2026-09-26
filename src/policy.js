// PURE routing decision. Claude either answers or escalates. An answer is auto-sent only if every gate passes; a
// failed gate escalates it instead, with the gates as reasons for the owner. The one exception is a thanks that adds
// nothing: after a closing our side sent or handled this session, or while an open draft already holds the chat, it
// is skipped, since another "sama-sama" or another draft only adds volume. Shadow mode is not decided here: the send
// gate in assistant.js turns an approved send into a notice.
import { isSocialMessage, isSocialReply, normalizeText } from './guards.js'

const QUOTA_OK_STATUSES = new Set(['allowed', 'allowed_warning'])
const HOUR_MS = 60 * 60 * 1000

/**
 * Where the chat stands before the new messages, read from the newest one back; the customer's own thanks and 👍 are
 * passed over. Our side is the owner and the bot alike.
 * - 'drafted': an open draft holds this message and everything before it (also when the history does not reach it)
 * - 'waiting': a customer message nobody has answered; `attachment` names one Claude cannot read (a photo, a
 *   location pin): nobody has seen it
 * - 'closed': our side's last message was a closing, or a closing was handled after it (`closingHandledAt`: sent, or
 *   its draft resolved), within this session (after `sessionStart`)
 * - 'question': our side's last message asked something, so an "ok" answers it
 * - 'owner': our side's last message was not one of the bot's auto-replies (`autoReply`): an "ok" may agree to it
 * - 'answered': the bot's auto-reply, or a closing of an earlier session, was the last word
 * - undefined: no history
 * @param {{id?: string, fromMe: boolean, text?: string, attachment?: string, timestamp?: number, autoReply?: boolean}[]} history
 *   oldest first; timestamps in epoch seconds
 * @param {{disclosureText?: string, openDrafts?: {messageIds?: string[]}[], closingHandledAt?: number, sessionStart?: number}} [options]
 * @returns {{state?: string, attachment?: string}}
 */
export function conversationState (history = [], { disclosureText, openDrafts = [], closingHandledAt = 0, sessionStart = 0 } = {}) {
  const drafted = new Set(openDrafts.flatMap(draft => draft.messageIds ?? []))
  for (const item of [...history].reverse()) {
    if (drafted.has(item.id)) return { state: 'drafted' }
    const text = String(item.text ?? '')
    if (!item.fromMe) {
      if (item.attachment) return { state: 'waiting', attachment: item.attachment }
      if (!isSocialMessage(text)) return { state: 'waiting' }
      continue
    }
    const sentAt = (item.timestamp ?? 0) * 1000 // unknown age: not this session
    const own = disclosureText && text.startsWith(disclosureText) ? text.slice(disclosureText.length) : text
    if (isSocialReply(own)) return { state: sentAt > sessionStart ? 'closed' : 'answered' }
    if (closingHandledAt > sentAt && closingHandledAt > sessionStart) return { state: 'closed' }
    if (/[?¿]/.test(own)) return { state: 'question' }
    return { state: item.autoReply ? 'answered' : 'owner' }
  }
  return { state: openDrafts.length > 0 ? 'drafted' : undefined }
}

const flatText = text => normalizeText(text).replace(/\s+/g, ' ').trim()

/**
 * @param {{ok: boolean, triage?: object, error?: string}} result  brain.triage() output
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {{ok: boolean, reasons: string[]}} [ctx.guard]  guards.checkReply() output for the reply
 * @param {string} [ctx.incomingText]  the new messages' text, joined
 * @param {string[]} [ctx.attachments]  kinds of the files attached to the new messages (image, video, …)
 * @param {string[]} [ctx.quoted]  texts of the earlier messages the new ones reply to (WhatsApp quotes)
 * @param {object[]} [ctx.history]  earlier messages of the chat, oldest first (see conversationState)
 * @param {boolean} ctx.paused
 * @param {{muted?: boolean, blocked?: boolean, blocklistUnchecked?: boolean, takeoverUntil?: number, openDrafts?: {messageIds?: string[]}[], lastClosingAt?: number}} ctx.chat
 *   `openDrafts`: the chat's pending drafts; `lastClosingAt`: when a closing was last sent, or a closing draft resolved
 * @param {number} ctx.now  epoch ms
 * @param {number} ctx.chatAutoSendsLastHour
 * @param {number} ctx.autoSendsLastDay
 * @param {{status?: string, fiveHourUtilization?: number, sevenDayUtilization?: number}} [ctx.rateLimit]
 * @param {boolean} ctx.isBacklog
 * @returns {{action: 'auto_send'|'escalate'|'skip', reasons: string[]}}
 */
export function decide (result, ctx) {
  const { config, chat = {}, rateLimit } = ctx
  const history = ctx.history ?? []
  const attachments = ctx.attachments ?? []
  const openDrafts = chat.openDrafts ?? []
  const sessionMs = (config.disclosure?.sessionGapHours ?? 12) * HOUR_MS
  const { state: conversation, attachment: unseen } = conversationState(history, {
    disclosureText: config.disclosure?.text, openDrafts, closingHandledAt: chat.lastClosingAt, sessionStart: ctx.now - sessionMs
  })
  const socialMessage = ctx.incomingText !== undefined && isSocialMessage(ctx.incomingText)
  // "iya kak" quoting an earlier message answers that message, not our side's last one.
  const lastOurs = history.findLast(item => item.fromMe)
  const quotesEarlier = (ctx.quoted ?? []).some(text => !lastOurs || flatText(text) !== flatText(lastOurs.text))

  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { decision } = result.triage
  // A thanks or 🙏 that adds nothing needs nothing from anyone, whatever Claude made of it.
  if (socialMessage && attachments.length === 0 && !quotesEarlier) {
    if (conversation === 'closed') return { action: 'skip', reasons: [`decision:${decision}`, 'closing_already_sent'] }
    if (conversation === 'drafted') return { action: 'skip', reasons: [`decision:${decision}`, 'open_draft'] }
  }
  if (decision !== 'answer') return { action: 'escalate', reasons: [`decision:${decision}`] }

  // An answer to a thanks is a closing whatever it cites (the guards accept only a thanks-back without facts). The
  // prompt's "nothing is still waiting" is checked here too, and one closing per session is enough.
  const closing = socialMessage
  const held = attachments.map(kind => `attachment:${kind}`) // Claude cannot see it: a payment proof?
  if (closing) {
    if (openDrafts.length > 0) held.push('open_draft')
    if (conversation === 'waiting') held.push(unseen ? `unanswered_attachment:${unseen}` : 'unanswered_message')
    if (conversation === 'question') held.push('answers_owner_question')
    if (conversation === 'owner') held.push('answers_owner_message')
    if (quotesEarlier) held.push('quotes_earlier_message')
    if (held.length === 0 && ctx.guard?.ok && ctx.now - (chat.lastClosingAt ?? 0) < sessionMs) {
      return { action: 'skip', reasons: ['decision:answer', 'closing_already_sent'] }
    }
  }

  const blockers = [...held]
  if (!config.autoSend?.enabled) blockers.push('auto_send_disabled')
  if (!ctx.guard) blockers.push('guards_not_run')
  else if (!ctx.guard.ok) blockers.push(...ctx.guard.reasons.map(reason => `guard:${reason}`))
  if (ctx.paused) blockers.push('paused')
  if (chat.blocked) blockers.push('blocked')
  if (chat.blocklistUnchecked) blockers.push('blocklist_unchecked') // phone number unknown, cannot rule the blocklist out
  if (chat.muted) blockers.push('muted')
  if (chat.takeoverUntil && chat.takeoverUntil > ctx.now) blockers.push('human_takeover')
  // A closing is limited to one per session above instead: it must not use up the chat's slots for real answers.
  if (!closing && ctx.chatAutoSendsLastHour >= config.autoSend.maxPerChatPerHour) blockers.push('chat_rate_limit')
  if (ctx.autoSendsLastDay >= config.autoSend.maxPerDay) blockers.push('daily_rate_limit')
  if (ctx.isBacklog && !config.backlog?.autoSend) blockers.push('backlog')

  // Unknown quota counts as exhausted: the bot shares the owner's subscription windows.
  const quota = config.quota ?? {}
  if (!rateLimit) blockers.push('quota_unknown')
  else {
    if (!QUOTA_OK_STATUSES.has(rateLimit.status)) blockers.push(`quota_status:${rateLimit.status}`)
    if (!(rateLimit.fiveHourUtilization < (quota.maxFiveHourUtilization ?? 0.8))) blockers.push(`quota_five_hour:${rateLimit.fiveHourUtilization}`)
    if (quota.maxSevenDayUtilization !== undefined && !(rateLimit.sevenDayUtilization < quota.maxSevenDayUtilization)) blockers.push(`quota_seven_day:${rateLimit.sevenDayUtilization}`)
  }

  if (blockers.length > 0) return { action: 'escalate', reasons: ['decision:answer', ...blockers] }
  return { action: 'auto_send', reasons: ['decision:answer', 'all_gates_passed'] }
}
