// PURE routing decision. Claude either answers or escalates. An answer is auto-sent only if every gate passes; a
// failed gate escalates it instead, with the gates as reasons for the owner. The one exception is a social closing
// that follows a closing already sent: it is skipped, since nothing is waiting and a second "sama-sama" only adds
// volume. Shadow mode is not decided here: the send gate in assistant.js turns an approved send into a notice.
import { isSocialMessage, isSocialReply } from './guards.js'

const QUOTA_OK_STATUSES = new Set(['allowed', 'allowed_warning'])
const HOUR_MS = 60 * 60 * 1000

/**
 * Where the chat stands before the new messages, read from the newest one back; the customer's own thanks and 👍 are
 * passed over. 'waiting': a customer message nobody has answered (an attachment counts: nobody has seen it);
 * 'question': our side's last message asked something, so an "ok" answers it; 'closed': our side's last message was
 * itself a closing; 'answered': our side replied; undefined: no history. Our side is the owner and the bot alike.
 * @param {{fromMe: boolean, text?: string, attachment?: string}[]} history  oldest first
 */
export function conversationState (history = [], { disclosureText } = {}) {
  for (const item of [...history].reverse()) {
    const text = String(item.text ?? '')
    if (!item.fromMe) {
      if (item.attachment || !isSocialMessage(text)) return 'waiting'
      continue
    }
    const own = disclosureText && text.startsWith(disclosureText) ? text.slice(disclosureText.length) : text
    if (/[?¿]/.test(own)) return 'question'
    return isSocialReply(own) ? 'closed' : 'answered'
  }
  return undefined
}

/** Claude answers a purely social message without a fact: a thanks answered with a thanks. */
export const isClosing = (triage, incomingText) =>
  triage?.decision === 'answer' && !(triage.facts_used?.length > 0) && incomingText !== undefined && isSocialMessage(incomingText)

/**
 * @param {{ok: boolean, triage?: object, error?: string}} result  brain.triage() output
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {{ok: boolean, reasons: string[]}} [ctx.guard]  guards.checkReply() output for the reply
 * @param {string} [ctx.incomingText]  the new messages' text, joined
 * @param {string[]} [ctx.attachments]  kinds of the files attached to the new messages (image, video, …)
 * @param {object[]} [ctx.history]  earlier messages of the chat, oldest first (see conversationState)
 * @param {boolean} ctx.paused
 * @param {{muted?: boolean, blocked?: boolean, blocklistUnchecked?: boolean, takeoverUntil?: number, openDraft?: boolean, lastClosingAt?: number}} ctx.chat
 * @param {number} ctx.now  epoch ms
 * @param {number} ctx.chatAutoSendsLastHour
 * @param {number} ctx.autoSendsLastDay
 * @param {{status?: string, fiveHourUtilization?: number, sevenDayUtilization?: number}} [ctx.rateLimit]
 * @param {boolean} ctx.isBacklog
 * @returns {{action: 'auto_send'|'escalate'|'skip', reasons: string[]}}
 */
export function decide (result, ctx) {
  const { config, chat = {}, rateLimit } = ctx
  const conversation = conversationState(ctx.history, { disclosureText: config.disclosure?.text })
  const attachments = ctx.attachments ?? []
  // A thanks or 🙏 after our side's own closing needs nothing from anyone, whatever Claude made of it.
  const socialMessage = ctx.incomingText !== undefined && isSocialMessage(ctx.incomingText)
  if (socialMessage && conversation === 'closed' && attachments.length === 0 && !chat.openDraft) {
    return { action: 'skip', reasons: [`decision:${result?.triage?.decision ?? 'none'}`, 'closing_already_sent'] }
  }

  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { decision } = result.triage
  if (decision !== 'answer') return { action: 'escalate', reasons: [`decision:${decision}`] }

  // The prompt's "nothing is still waiting" for a closing is checked here too, and one closing per session is enough.
  const closing = isClosing(result.triage, ctx.incomingText)
  const held = attachments.map(kind => `attachment:${kind}`) // Claude cannot see it: a payment proof?
  if (closing) {
    if (chat.openDraft) held.push('open_draft')
    if (conversation === 'waiting') held.push('unanswered_message')
    if (conversation === 'question') held.push('answers_owner_question')
    const sessionMs = (config.disclosure?.sessionGapHours ?? 12) * HOUR_MS
    if (held.length === 0 && ctx.now - (chat.lastClosingAt ?? 0) < sessionMs) {
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
