import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from '../src/policy.js'
import { ANSWER_HOURS, makeConfig, okRateLimit, triageResult } from './helpers.js'

const config = makeConfig()
const NOW = Date.UTC(2026, 8, 26, 3, 0)
const baseContext = () => ({
  config,
  guard: { ok: true, reasons: [] },
  paused: false,
  chat: { muted: false, blocked: false, takeoverUntil: 0 },
  now: NOW,
  chatAutoSendsLastHour: 0,
  autoSendsLastDay: 0,
  rateLimit: okRateLimit,
  isBacklog: false
})

test('an answer with every gate passing auto-sends', () => {
  assert.deepEqual(decide(triageResult(ANSWER_HOURS), baseContext()), { action: 'auto_send', reasons: ['decision:answer', 'all_gates_passed'] })
})

test('escalate always escalates, whatever the gates say', () => {
  const ctx = baseContext()
  ctx.paused = true
  ctx.rateLimit = undefined
  assert.deepEqual(decide(triageResult({ decision: 'escalate' }), ctx), { action: 'escalate', reasons: ['decision:escalate'] })
  assert.deepEqual(decide(triageResult({ decision: 'escalate' }), baseContext()).action, 'escalate')
})

test('anything but "answer" escalates: an unknown or old-schema decision never auto-sends', () => {
  for (const triage of [{ decision: 'maybe' }, { decision: undefined, category: 'simple', confidence: 1, reply: 'x', facts_used: ['F1'] }]) {
    assert.equal(decide(triageResult(triage), baseContext()).action, 'escalate')
  }
})

test('triage failure fails closed to escalate, never auto-send', () => {
  for (const result of [{ ok: false, error: 'timeout' }, { ok: true }, undefined]) {
    const decision = decide(result, baseContext())
    assert.equal(decision.action, 'escalate')
    assert.match(decision.reasons[0], /^triage_failed/)
  }
})

// Each row breaks exactly one gate; every one must turn an answer into an escalation that names that gate.
const blockers = [
  ['auto_send_disabled', ctx => { ctx.config = makeConfig({ autoSend: { enabled: false } }) }],
  ['guard:unsupported_amount:1', ctx => { ctx.guard = { ok: false, reasons: ['unsupported_amount:1'] } }],
  ['guards_not_run', ctx => { ctx.guard = undefined }],
  ['paused', ctx => { ctx.paused = true }],
  ['muted', ctx => { ctx.chat.muted = true }],
  ['blocked', ctx => { ctx.chat.blocked = true }],
  ['blocklist_unchecked', ctx => { ctx.chat.blocklistUnchecked = true }],
  ['human_takeover', ctx => { ctx.chat.takeoverUntil = NOW + 60_000 }],
  ['chat_rate_limit', ctx => { ctx.chatAutoSendsLastHour = 3 }],
  ['daily_rate_limit', ctx => { ctx.autoSendsLastDay = 30 }],
  ['backlog', ctx => { ctx.isBacklog = true }],
  ['quota_unknown', ctx => { ctx.rateLimit = undefined }],
  ['quota_status:rejected', ctx => { ctx.rateLimit = { ...okRateLimit, status: 'rejected' } }],
  ['quota_five_hour:0.8', ctx => { ctx.rateLimit = { ...okRateLimit, fiveHourUtilization: 0.8 } }],
  ['quota_five_hour:undefined', ctx => { ctx.rateLimit = { status: 'allowed', sevenDayUtilization: 0.1 } }],
  ['quota_seven_day:0.95', ctx => { ctx.rateLimit = { ...okRateLimit, sevenDayUtilization: 0.95 } }]
]

for (const [reason, mutate] of blockers) {
  test(`an answer is escalated when ${reason}`, () => {
    const ctx = baseContext()
    mutate(ctx)
    const decision = decide(triageResult(ANSWER_HOURS), ctx)
    assert.equal(decision.action, 'escalate')
    assert.equal(decision.reasons[0], 'decision:answer')
    assert.ok(decision.reasons.some(item => item.startsWith(reason)), `${decision.reasons} should include ${reason}`)
  })
}

test('an expired takeover window and backlog with autoSend allowed do not block', () => {
  const ctx = baseContext()
  ctx.chat.takeoverUntil = NOW - 1
  ctx.isBacklog = true
  ctx.config = makeConfig({ backlog: { autoSend: true } })
  assert.equal(decide(triageResult(ANSWER_HOURS), ctx).action, 'auto_send')
})

test('allowed_warning quota passes; there is no confidence gate', () => {
  const ctx = baseContext()
  ctx.rateLimit = { ...okRateLimit, status: 'allowed_warning' }
  assert.equal(decide(triageResult(ANSWER_HOURS), ctx).action, 'auto_send')
  assert.equal(config.autoSend.minConfidence, undefined)
})
