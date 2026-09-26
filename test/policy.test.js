import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationState, decide } from '../src/policy.js'
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

const THANKS = { decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: [] }
const DISCLOSURE = makeConfig().disclosure.text
const customer = text => ({ fromMe: false, text })
const ours = text => ({ fromMe: true, text })
const closingContext = (history, chat = {}) => ({ ...baseContext(), incomingText: 'ok makasih kak 🙏', history, chat: { ...baseContext().chat, ...chat } })

test('conversationState reads the chat from the newest message back, passing over the customer\'s thanks', () => {
  assert.equal(conversationState([]), undefined)
  assert.equal(conversationState([customer('jam buka?'), ours('Buka 08.00–17.00 ya Kak.')]), 'answered')
  assert.equal(conversationState([customer('Kak tolong dikirim hari ini ya'), customer('🙏')]), 'waiting')
  assert.equal(conversationState([customer('makasih kak'), { fromMe: false, text: '', attachment: 'image' }]), 'waiting', 'an unseen photo waits')
  assert.equal(conversationState([customer('brownies berapa?'), ours('Rp 85.000 ya Kak, mau pesan berapa?')]), 'question')
  assert.equal(conversationState([customer('ok makasih kak'), ours('Sama-sama, Kak 🙏'), customer('🙏'), customer('siap kak')]), 'closed')
  assert.equal(conversationState([customer('makasih'), ours(`${DISCLOSURE}\n\nSama-sama, Kak 🙏`)], { disclosureText: DISCLOSURE }), 'closed', 'the AI disclosure is not part of the closing')
})

test('a closing after a closing is skipped, whatever the other gates say', () => {
  for (const ctx of [
    closingContext([customer('ok makasih kak'), ours('Sama-sama, Kak 🙏')]),
    closingContext([customer('jam buka?'), ours('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - 60 * 60 * 1000 }) // one per session
  ]) {
    ctx.paused = true
    ctx.chatAutoSendsLastHour = 3
    assert.deepEqual(decide(triageResult(THANKS), ctx), { action: 'skip', reasons: ['decision:answer', 'closing_already_sent'] })
  }
  const nextSession = closingContext([customer('jam buka?'), ours('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - 13 * 60 * 60 * 1000 })
  assert.equal(decide(triageResult(THANKS), nextSession).action, 'auto_send')
})

test('after our own closing, a thanks is skipped whatever Claude made of it; the once-per-session limit needs an answer', () => {
  const closed = closingContext([customer('ok makasih kak'), ours('Sama-sama, Kak 🙏')])
  for (const result of [triageResult({ decision: 'escalate', reply: '🙏' }), { ok: false, error: 'timeout' }]) {
    assert.equal(decide(result, closed).action, 'skip')
  }
  assert.deepEqual(decide(triageResult({ decision: 'escalate', reply: '🙏' }), closed).reasons, ['decision:escalate', 'closing_already_sent'])
  const sameSession = closingContext([customer('jam buka?'), ours('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - 60 * 1000 })
  assert.equal(decide(triageResult({ ...THANKS, decision: 'escalate' }), sameSession).action, 'escalate', 'Claude\'s escalation stands there')
  const question = { ...closed, incomingText: 'ok, kalau besok bisa?' }
  assert.equal(decide(triageResult({ decision: 'escalate' }), question).action, 'escalate', 'a new question after a closing is not skipped')
})

test('a closing is held while something in the chat still waits for the owner', () => {
  const held = (history, chat) => decide(triageResult(THANKS), closingContext(history, chat)).reasons
  assert.deepEqual(held([customer('Kak tolong pesanan saya dikirim hari ini ya, buat acara nanti malam')]), ['decision:answer', 'unanswered_message'])
  assert.deepEqual(held([customer('brownies berapa?'), ours('Rp 85.000 ya Kak, mau pesan berapa?')]), ['decision:answer', 'answers_owner_question'])
  assert.deepEqual(held([], { openDraft: true }), ['decision:answer', 'open_draft'])
  assert.deepEqual(held([ours('Sama-sama, Kak 🙏')], { openDraft: true }), ['decision:answer', 'open_draft'], 'an open draft is never skipped')
  const factual = { ...baseContext(), incomingText: 'jam buka?', history: [customer('Kak saya sudah transfer')], chat: { ...baseContext().chat, openDraft: true } }
  assert.equal(decide(triageResult(ANSWER_HOURS), factual).action, 'auto_send', 'an answer from the facts is not held by an earlier open question')
})

test('an attachment holds any answer: Claude only saw the caption', () => {
  for (const triage of [THANKS, ANSWER_HOURS]) {
    const ctx = { ...closingContext([ours('Sama-sama, Kak 🙏')]), attachments: ['image'] }
    assert.deepEqual(decide(triageResult(triage), ctx).reasons, ['decision:answer', 'attachment:image'])
  }
})

test('a closing uses no per-chat slot; the daily cap still counts it', () => {
  const ctx = closingContext([customer('jam buka?'), ours('Buka 08.00–17.00 ya Kak.')])
  ctx.chatAutoSendsLastHour = 3
  assert.equal(decide(triageResult(THANKS), ctx).action, 'auto_send')
  ctx.autoSendsLastDay = 30
  assert.deepEqual(decide(triageResult(THANKS), ctx).reasons, ['decision:answer', 'daily_rate_limit'])
})
