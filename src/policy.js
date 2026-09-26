// PURE routing decision. Claude either answers or escalates. An answer is auto-sent only if every gate passes; a
// failed gate escalates it instead, with the gates as reasons for the owner. A thanks is never auto-answered: Claude's
// thanks-back is only a draft. The one exception to "everything reaches the owner" is a thanks right after a closing
// this session: it is skipped, since another "sama-sama" or another draft only adds volume. Shadow mode is not decided
// here: the send gate in assistant.js turns an approved send into a notice.
import { isThanks, normalizeText } from './guards.js'

const QUOTA_OK_STATUSES = new Set(['allowed', 'allowed_warning'])
const HOUR_MS = 60 * 60 * 1000

/**
 * Whether a closing this session still stands, read from the newest message back. A closing is a thanks the owner
 * dealt with (its draft sent, edited or discarded, shadow included); `lastClosingAt` is when that thanks arrived.
 * - anything but a thanks from the customer (a question, an "iya", a file) is new: not closed
 * - the customer's own thanks since are passed over
 * - our message sent as that closing (`closing`: the owner's /ok or /edit of the thanks draft, when it is itself only a
 *   thanks-back) is the last word: closed
 * - any other message of ours (the owner's or the bot's) is closed only if it came before the thanks the owner dealt
 *   with (a /no, a shadow /ok); one sent after it, or of unknown age, is new
 * - so is `lastOursAt` after that thanks: the history holds one addressing form since the last start, but our side
 *   may have written on the other one, or before a restart
 * - a history that ends before any message of ours (a restart empties it) leaves the recorded closing standing
 * @param {{fromMe: boolean, text?: string, attachment?: string, timestamp?: number, closing?: boolean}[]} history
 *   oldest first; timestamps in epoch seconds
 * @param {{lastClosingAt?: number, sessionStart?: number, lastOursAt?: number}} [options]  epoch ms; `lastOursAt`:
 *   when our side last wrote to this contact on either form, closings left out (assistant.js)
 */
export function closedThisSession (history = [], { lastClosingAt = 0, sessionStart = 0, lastOursAt = 0 } = {}) {
  if (!(lastClosingAt > sessionStart)) return false
  if (lastOursAt >= lastClosingAt) return false
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index]
    if (!item.fromMe) {
      if (item.attachment || !isThanks(item.text)) return false
      continue
    }
    if (item.closing) return true
    return Number.isFinite(item.timestamp) && lastClosingAt > item.timestamp * 1000
  }
  return true
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
 * @param {object[]} [ctx.history]  earlier messages of the chat, oldest first (see closedThisSession)
 * @param {boolean} ctx.paused
 * @param {{muted?: boolean, blocked?: boolean, blocklistUnchecked?: boolean, takeoverUntil?: number, lastClosingAt?: number, lastOursAt?: number}} ctx.chat
 *   `lastClosingAt`: when the last thanks the owner dealt with arrived; `lastOursAt`: see closedThisSession
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
  const sessionMs = (config.disclosure?.sessionGapHours ?? 12) * HOUR_MS
  const thanks = ctx.incomingText !== undefined && isThanks(ctx.incomingText)
  // A thanks quoting an earlier message answers that message, not our side's last one.
  const lastOurs = history.findLast(item => item.fromMe)
  const quotesEarlier = (ctx.quoted ?? []).some(text => !lastOurs || flatText(text) !== flatText(lastOurs.text))

  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { decision } = result.triage
  // A thanks after a closing needs nothing from anyone, whatever Claude made of it.
  if (thanks && attachments.length === 0 && !quotesEarlier &&
    closedThisSession(history, { lastClosingAt: chat.lastClosingAt, sessionStart: ctx.now - sessionMs, lastOursAt: chat.lastOursAt })) {
    return { action: 'skip', reasons: [`decision:${decision}`, 'closing_already_sent'] }
  }
  if (decision !== 'answer') return { action: 'escalate', reasons: [`decision:${decision}`] }

  const held = attachments.map(kind => `attachment:${kind}`) // Claude cannot see it: a payment proof?
  // Whatever it cites and whatever the other gates say: the notice leads with this one reason instead of listing
  // gates that would not have mattered (a thanks-back cites no fact, so the guards always refuse it).
  if (thanks) return { action: 'escalate', reasons: ['decision:answer', 'thanks_not_auto_sent', ...held] }

  const blockers = [...held]
  if (!config.autoSend?.enabled) blockers.push('auto_send_disabled')
  if (!ctx.guard) blockers.push('guards_not_run')
  else if (!ctx.guard.ok) blockers.push(...ctx.guard.reasons.map(reason => `guard:${reason}`))
  if (ctx.paused) blockers.push('paused')
  if (chat.blocked) blockers.push('blocked')
  if (chat.blocklistUnchecked) blockers.push('blocklist_unchecked') // phone number unknown, cannot rule the blocklist out
  if (chat.muted) blockers.push('muted')
  if (chat.takeoverUntil && chat.takeoverUntil > ctx.now) blockers.push('human_takeover')
  if (ctx.chatAutoSendsLastHour >= config.autoSend.maxPerChatPerHour) blockers.push('chat_rate_limit')
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
