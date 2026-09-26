// PURE routing decision. Claude either answers or escalates. An answer is auto-sent only if every gate passes; a
// failed gate escalates it instead, with the gates as reasons for the owner. Shadow mode is not decided here: the send
// gate in assistant.js turns an approved send into a notice.

const QUOTA_OK_STATUSES = new Set(['allowed', 'allowed_warning'])

/**
 * @param {{ok: boolean, triage?: object, error?: string}} result  brain.triage() output
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {{ok: boolean, reasons: string[]}} [ctx.guard]  guards.checkReply() output for the reply
 * @param {boolean} ctx.paused
 * @param {{muted?: boolean, blocked?: boolean, blocklistUnchecked?: boolean, takeoverUntil?: number}} ctx.chat
 * @param {number} ctx.now  epoch ms
 * @param {number} ctx.chatAutoSendsLastHour
 * @param {number} ctx.autoSendsLastDay
 * @param {{status?: string, fiveHourUtilization?: number, sevenDayUtilization?: number}} [ctx.rateLimit]
 * @param {boolean} ctx.isBacklog
 * @returns {{action: 'auto_send'|'escalate', reasons: string[]}}
 */
export function decide (result, ctx) {
  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { decision } = result.triage
  if (decision !== 'answer') return { action: 'escalate', reasons: [`decision:${decision}`] }

  const { config, chat = {}, rateLimit } = ctx
  const blockers = []
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
