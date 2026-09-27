// PURE routing decision. Claude either answers or escalates. An answer is auto-sent only if the customer's message asks
// something and every gate passes; otherwise it is escalated, with the reasons for the owner. So a thanks, a yes or any
// other message that asks nothing is never auto-answered: Claude's thanks-back is only a draft. The one exception to
// "everything reaches the owner" is a thanks right after a closing this session: it is skipped, since another
// "sama-sama" or another draft only adds volume. Shadow mode is not decided here: the send gate in assistant.js turns
// an approved send into a notice.
// An escalation also says whether the customer gets a short fixed placeholder ("🤖 Tunggu sebentar ya Kak 🙏", owner
// decision 2026-09-27), so a waiting customer does not wait in silence; see placeholderWithheld.
import { asksSomething, isLooseThanks, isThanks, normalizeText, thanksAgrees } from './guards.js'

const QUOTA_OK_STATUSES = new Set(['allowed', 'allowed_warning'])
const HOUR_MS = 60 * 60 * 1000

/**
 * Whether a closing this session still stands, read from the newest message back. A closing is a thanks the owner
 * dealt with (its draft sent, edited or discarded, shadow included); `lastClosingAt` is when that thanks arrived.
 * - anything but a thanks from the customer (a question, an "iya", a file) is new: not closed
 * - so is anything but a thanks the customer sent after the thanks the owner dealt with, wherever it sits: the owner's
 *   closing reply, sent later, must not hide a photo that came while the draft waited (the draft never showed it)
 * - so is `lastUntriagedAt` from that thanks on: content that is never triaged (a photo without a caption, a pin, a
 *   message that could not be decrypted) on either form, or before a restart, which the history does not show
 * - and so is `lastOpenedAt` from that thanks on: a triaged message that was not a file-free thanks, on either form,
 *   or before a restart (skip-safety-r3-1)
 * - the customer's own thanks since are passed over
 * - our message sent as that closing (`closing`: the owner's /ok or /edit of the thanks draft, when it is itself only a
 *   thanks-back) is the last word: closed
 * - any other message of ours (the owner's or the bot's) is closed only if it came before the thanks the owner dealt
 *   with (a /no, a shadow /ok), and only for a new thanks that agrees to nothing: an "iya makasih" or a "👍 thanks"
 *   (`agrees`) may be the yes to that message, which a /no answered nothing to. One sent after that thanks, or of
 *   unknown age, is new
 * - so is `lastOursAt` after that thanks: the history holds one addressing form since the last start, but our side
 *   may have written on the other one, or before a restart
 * - a history that ends before any message of ours (a restart empties it) leaves the recorded closing standing, for a
 *   new thanks that agrees to nothing: what it could agree to is unknown
 * @param {{fromMe: boolean, text?: string, attachment?: string, timestamp?: number, closing?: boolean}[]} history
 *   oldest first; timestamps in epoch seconds
 * @param {{lastClosingAt?: number, sessionStart?: number, lastOursAt?: number, lastUntriagedAt?: number, lastOpenedAt?: number, agrees?: boolean}} [options]
 *   epoch ms; `lastOursAt`: when our side last wrote to this contact on either form, closings left out;
 *   `lastUntriagedAt`: when the customer last sent content that is never triaged, on either form (assistant.js);
 *   `lastOpenedAt`: when the customer's newest triaged burst that was not a file-free thanks arrived, on either form;
 *   `agrees`: the new thanks comes with an acknowledgement or an agreeing emoji (guards.thanksAgrees; unset: it does)
 */
export function closedThisSession (history = [], { lastClosingAt = 0, sessionStart = 0, lastOursAt = 0, lastUntriagedAt = 0, lastOpenedAt = 0, agrees = true } = {}) {
  if (!(lastClosingAt > sessionStart)) return false
  if (lastOursAt >= lastClosingAt) return false
  if (lastUntriagedAt >= lastClosingAt) return false
  if (lastOpenedAt >= lastClosingAt) return false
  // A file never joins a triaged burst, so one from the thanks' own second may still be newer; a text from that second
  // belongs to the burst the owner dealt with. Unknown age is new.
  const newerFile = item => !(item.timestamp * 1000 < lastClosingAt)
  const newerText = item => !(item.timestamp * 1000 <= lastClosingAt)
  if (history.some(item => !item.fromMe && (item.attachment ? newerFile(item) : newerText(item) && !isThanks(item.text)))) return false
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index]
    if (!item.fromMe) {
      if (item.attachment || !isThanks(item.text)) return false
      continue
    }
    if (item.closing) return true
    return !agrees && Number.isFinite(item.timestamp) && lastClosingAt > item.timestamp * 1000
  }
  return !agrees
}

const flatText = text => normalizeText(text).replace(/\s+/g, ' ').trim()

/**
 * @param {{ok: boolean, triage?: object, error?: string}} result  brain.triage() output
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {{ok: boolean, reasons: string[]}} [ctx.guard]  guards.checkReply() output for the reply
 * @param {string} [ctx.incomingText]  the new messages' text, joined; unset, it asks nothing
 * @param {string[]} [ctx.attachments]  kinds of the files attached to the new messages (image, video, …)
 * @param {(string|{id?: string, text?: string})[]} [ctx.quoted]  the earlier messages the new ones reply to (WhatsApp
 *   quotes): their ids where known, and their texts ('' for a photo, a voice note or a pin)
 * @param {object[]} [ctx.history]  earlier messages of the chat, oldest first (see closedThisSession)
 * @param {boolean} ctx.paused
 * @param {{muted?: boolean, blocked?: boolean, blocklistUnchecked?: boolean, takeoverUntil?: number, lastClosingAt?: number, lastOursAt?: number, lastUntriagedAt?: number, lastOpenedAt?: number, placeholderSent?: boolean}} ctx.chat
 *   `lastClosingAt`: when the last thanks the owner dealt with arrived; `lastOursAt`, `lastUntriagedAt`, `lastOpenedAt`:
 *   see closedThisSession; `placeholderSent`: the contact got a placeholder and has had an open draft ever since
 * @param {number} ctx.now  epoch ms
 * @param {number} ctx.chatAutoSendsLastHour
 * @param {number} ctx.autoSendsLastDay
 * @param {{status?: string, fiveHourUtilization?: number, sevenDayUtilization?: number}} [ctx.rateLimit]
 * @param {boolean} ctx.isBacklog
 * @returns {{action: 'auto_send'|'escalate'|'skip', reasons: string[], placeholder: boolean, placeholderWithheld: string[]}}
 *   `placeholder`: send the customer the fixed placeholder (escalations only); `placeholderWithheld`: why an escalation
 *   gets none, for the audit
 */
export function decide (result, ctx) {
  const routed = route(result, ctx)
  if (routed.action !== 'escalate') return { ...routed, placeholder: false, placeholderWithheld: [] }
  const withheld = placeholderWithheld(result, ctx)
  return { ...routed, placeholder: withheld.length === 0, placeholderWithheld: withheld }
}

/** The gates on the chat and on volume that hold any automatic message to it: an answer or a placeholder. */
function chatBlockers (ctx) {
  const { config, chat = {} } = ctx
  const blockers = []
  if (ctx.paused) blockers.push('paused')
  if (chat.blocked) blockers.push('blocked')
  if (chat.blocklistUnchecked) blockers.push('blocklist_unchecked') // phone number unknown, cannot rule the blocklist out
  if (chat.muted) blockers.push('muted')
  if (chat.takeoverUntil && chat.takeoverUntil > ctx.now) blockers.push('human_takeover')
  if (ctx.chatAutoSendsLastHour >= config.autoSend.maxPerChatPerHour) blockers.push('chat_rate_limit')
  if (ctx.autoSendsLastDay >= config.autoSend.maxPerDay) blockers.push('daily_rate_limit')
  return blockers
}

/**
 * Why an escalation gets no placeholder; empty means it gets one. Only Claude's `customer_waiting: true` (a customer
 * waiting for the owner: not family, friends, spam, a scam or a manipulation attempt) lets one out, since a family
 * emergency must never get "tunggu sebentar". A thanks never gets one, whatever Claude says: it waits for nothing. It
 * is read loosely here (isLooseThanks: "makasih bgt kak", "thank u"), since a false match only withholds a fixed text.
 * Nor does a text without a letter or digit (😡😡, 🙏, ?) that comes without a file: it does not say what the sender wants.
 * Backlog never does: it comes late, and the owner may have answered it on the phone meanwhile. One placeholder covers
 * every escalation while a draft whose customer got one is open (`chat.placeholderSent`); it counts toward the caps.
 */
function placeholderWithheld (result, ctx) {
  if (!result?.ok || !result.triage) return ['triage_failed']
  const { config, chat = {} } = ctx
  const withheld = []
  if (config.placeholder?.enabled !== true) withheld.push('placeholder_disabled')
  if (result.triage.customer_waiting !== true) withheld.push('customer_not_waiting')
  if (ctx.incomingText !== undefined && isLooseThanks(ctx.incomingText)) withheld.push('thanks')
  if ((ctx.attachments ?? []).length === 0 && !/[\p{L}\p{N}]/u.test(ctx.incomingText ?? '')) withheld.push('no_words')
  withheld.push(...chatBlockers(ctx))
  if (ctx.isBacklog) withheld.push('backlog')
  if (chat.placeholderSent) withheld.push('placeholder_already_sent')
  return withheld
}

/** answer → auto_send or escalate, escalate, or skip (see the top of this file). */
function route (result, ctx) {
  const { config, chat = {}, rateLimit } = ctx
  const history = ctx.history ?? []
  const attachments = ctx.attachments ?? []
  const sessionMs = (config.disclosure?.sessionGapHours ?? 12) * HOUR_MS
  const thanks = ctx.incomingText !== undefined && isThanks(ctx.incomingText)
  // A thanks quoting a message answers that message. Only our closing reply itself (the thanks-back the owner's /ok or
  // /edit sent) asks nothing: a quote of any other message, our question before a thanks the owner discarded
  // included, may be a yes to it. Ids tell two messages apart even when neither has text (an older photo of ours
  // quoted after our closing); texts are the fallback.
  const lastOurs = history.findLast(item => item.fromMe)
  const quotesEarlier = (ctx.quoted ?? []).map(quote => (typeof quote === 'string' ? { text: quote } : quote ?? {}))
    .some(({ id, text }) => !lastOurs?.closing || (id && lastOurs.id ? id !== lastOurs.id : flatText(text) !== flatText(lastOurs.text)))

  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { decision } = result.triage
  // A thanks after a closing needs nothing from anyone, whatever Claude made of it.
  if (thanks && attachments.length === 0 && !quotesEarlier &&
    closedThisSession(history, {
      lastClosingAt: chat.lastClosingAt,
      sessionStart: ctx.now - sessionMs,
      lastOursAt: chat.lastOursAt,
      lastUntriagedAt: chat.lastUntriagedAt,
      lastOpenedAt: chat.lastOpenedAt,
      agrees: thanksAgrees(ctx.incomingText)
    })) {
    return { action: 'skip', reasons: [`decision:${decision}`, 'closing_already_sent'] }
  }
  if (decision !== 'answer') return { action: 'escalate', reasons: [`decision:${decision}`] }

  const held = attachments.map(kind => `attachment:${kind}`) // Claude cannot see it: a payment proof?
  // Owner decision (2026-09-27): whatever it cites and whatever the other gates say, an answer to a message that asks
  // nothing is a draft. The notice leads with this one reason instead of listing gates that would not have mattered.
  if (!asksSomething(ctx.incomingText)) return { action: 'escalate', reasons: ['decision:answer', 'no_question', ...held] }

  const blockers = [...held]
  if (!config.autoSend?.enabled) blockers.push('auto_send_disabled')
  if (!ctx.guard) blockers.push('guards_not_run')
  else if (!ctx.guard.ok) blockers.push(...ctx.guard.reasons.map(reason => `guard:${reason}`))
  blockers.push(...chatBlockers(ctx))
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
