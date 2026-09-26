// PURE routing decision. Auto-send needs every gate to pass; anything else becomes a draft for the owner.
// Shadow mode is not decided here: the send gate in assistant.js turns an approved send into a notice.

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
 * @returns {{action: 'auto_send'|'draft'|'escalate'|'ignore', reasons: string[]}}
 */
export function decide (result, ctx) {
  if (!result?.ok || !result.triage) return { action: 'escalate', reasons: [`triage_failed:${result?.error ?? 'unknown'}`] }
  const { category, confidence } = result.triage

  if (category === 'ignore') return { action: 'ignore', reasons: ['category:ignore'] }
  if (category === 'important') return { action: 'escalate', reasons: ['category:important'] }
  if (category !== 'simple') return { action: 'draft', reasons: [`category:${category}`] }

  const { config, chat = {}, rateLimit } = ctx
  const blockers = []
  if (!config.autoSend?.enabled) blockers.push('auto_send_disabled')
  if (!(confidence >= config.autoSend.minConfidence)) blockers.push(`low_confidence:${confidence}<${config.autoSend.minConfidence}`)
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

  if (blockers.length > 0) return { action: 'draft', reasons: ['category:simple', ...blockers] }
  return { action: 'auto_send', reasons: ['category:simple', 'all_gates_passed'] }
}
