import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardTriage } from '../src/guards.js'
import { conversationState, decide } from '../src/policy.js'
import { ANSWER_HOURS, knowledge, makeConfig, okRateLimit, triageResult } from './helpers.js'

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
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const SESSION_START = NOW - 12 * HOUR_MS
const at = minutesAgo => Math.floor((NOW - minutesAgo * MINUTE_MS) / 1000)
let messageCounter = 0
const customer = (text, extra = {}) => ({ id: `C${++messageCounter}`, fromMe: false, text, timestamp: at(10), ...extra })
const bot = (text, extra = {}) => ({ id: `B${++messageCounter}`, fromMe: true, text, autoReply: true, timestamp: at(5), ...extra }) // an auto-reply
const owner = (text, extra = {}) => ({ id: `O${++messageCounter}`, fromMe: true, text, timestamp: at(5), ...extra }) // typed or approved
const closingContext = (history, chat = {}, extra = {}) => ({ ...baseContext(), incomingText: 'ok makasih kak 🙏', history, chat: { ...baseContext().chat, ...chat }, ...extra })
const state = (history, options = {}) => conversationState(history, { sessionStart: SESSION_START, ...options }).state
const PRICE_ANSWERED = [customer('Brownies panggang berapa kak?'), bot('Rp 85.000 ya Kak, loyang 20x20 cm.')]
const CLOSED_YESTERDAY = [customer('jam berapa buka kak?'), bot('Buka 08.00–17.00 ya Kak.'), customer('ok makasih kak'), bot('Sama-sama, Kak 🙏', { timestamp: at(20 * 60) })]

test('conversationState reads the chat from the newest message back, passing over the customer\'s thanks', () => {
  assert.deepEqual(conversationState([]), { state: undefined })
  assert.equal(state([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')]), 'answered')
  assert.equal(state([customer('Kak tolong dikirim hari ini ya'), customer('🙏')]), 'waiting')
  assert.deepEqual(conversationState([customer('makasih kak'), customer('', { attachment: 'image' })]), { state: 'waiting', attachment: 'image' }, 'an unseen photo waits')
  assert.deepEqual(conversationState([...PRICE_ANSWERED, customer('', { attachment: 'location' })]), { state: 'waiting', attachment: 'location' }, 'so does a location pin')
  assert.equal(state([customer('brownies berapa?'), bot('Rp 85.000 ya Kak, mau pesan berapa?')]), 'question')
  assert.equal(state([customer('ok makasih kak'), bot('Sama-sama, Kak 🙏'), customer('🙏'), customer('siap kak')]), 'closed')
  assert.equal(state([customer('makasih'), bot(`${DISCLOSURE}\n\nSama-sama, Kak 🙏`)], { disclosureText: DISCLOSURE }), 'closed', 'the AI disclosure is not part of the closing')
})

test('conversationState: a closing ends only its own session, and a greeting is not passed over', () => {
  assert.equal(state(CLOSED_YESTERDAY), 'answered', 'yesterday\'s closing does not close today\'s chat')
  assert.equal(state([customer('makasih'), bot('Sama-sama, Kak 🙏', { timestamp: undefined })]), 'answered', 'nor does one of unknown age')
  assert.equal(state([customer('makasih'), bot('Sama-sama, Kak 🙏'), customer('Selamat pagi kak')]), 'waiting', 'a greeting waits for an answer')
  assert.equal(state([customer('ok '.repeat(12000))]), 'waiting', 'a spammed "ok" in the history is read, not a stack overflow')
})

test('conversationState: whose words our side\'s last message are, a closing handled after it, and open drafts', () => {
  assert.equal(state([customer('Mau pesan brownies 2 loyang kak'), owner('Jadi total 2 loyang Rp 170.000 ya kak, diambil Sabtu')]), 'owner', 'no "?", but the owner\'s words')
  const answered = [customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.', { timestamp: at(30) }), customer('ok makasih kak')]
  assert.equal(state(answered, { closingHandledAt: NOW - MINUTE_MS }), 'closed', 'the owner resolved the thanks draft after our answer')
  assert.equal(state(answered, { closingHandledAt: NOW - HOUR_MS }), 'answered', 'a closing handled before our answer does not count')
  assert.equal(state([owner('Mau diantar Sabtu kak?', { timestamp: at(30) }), customer('iya kak')], { closingHandledAt: NOW - MINUTE_MS }), 'closed')

  const transfer = customer('Kak saya sudah transfer')
  const drafts = [{ messageIds: [transfer.id] }]
  assert.equal(state([transfer, customer('makasih kak')], { openDrafts: drafts }), 'drafted')
  assert.equal(state([customer('makasih kak')], { openDrafts: drafts }), 'drafted', 'also when the history does not reach the draft')
  assert.deepEqual(conversationState([transfer, customer('', { attachment: 'image' })], { openDrafts: drafts }), { state: 'waiting', attachment: 'image' }, 'a photo after the draft is not in it')
  assert.equal(state([transfer, customer('jam tutup?'), bot('Tutup 17.00 ya Kak.')], { openDrafts: drafts }), 'answered')
})

test('a thanks after a closing this session is skipped, whatever the other gates say', () => {
  for (const ctx of [
    closingContext([customer('ok makasih kak'), bot('Sama-sama, Kak 🙏')]),
    closingContext([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - HOUR_MS }) // one per session
  ]) {
    ctx.paused = true
    ctx.chatAutoSendsLastHour = 3
    assert.deepEqual(decide(triageResult(THANKS), ctx), { action: 'skip', reasons: ['decision:answer', 'closing_already_sent'] })
  }
  const nextSession = closingContext([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - 13 * HOUR_MS })
  assert.equal(decide(triageResult(THANKS), nextSession).action, 'auto_send')
})

test('after our own closing a thanks is skipped whatever Claude decided, but a failed triage is escalated', () => {
  const closed = closingContext([customer('ok makasih kak'), bot('Sama-sama, Kak 🙏')])
  assert.deepEqual(decide(triageResult({ decision: 'escalate', reply: '🙏' }), closed), { action: 'skip', reasons: ['decision:escalate', 'closing_already_sent'] })
  assert.deepEqual(decide({ ok: false, error: 'isolation_assertion_failed' }, closed), { action: 'escalate', reasons: ['triage_failed:isolation_assertion_failed'] })
  // A closing earlier this session, then a new answer: Claude's escalation of the next "ok" stands.
  const sameSession = closingContext([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - HOUR_MS })
  assert.equal(decide(triageResult({ ...THANKS, decision: 'escalate' }), sameSession).action, 'escalate', 'Claude\'s escalation stands there')
  const question = { ...closed, incomingText: 'ok, kalau besok bisa?' }
  assert.equal(decide(triageResult({ decision: 'escalate' }), question).action, 'escalate', 'a new question after a closing is not skipped')
})

test('a greeting after a closing, and anything after yesterday\'s closing, gets Claude\'s decision', () => {
  const yesterday = { lastClosingAt: NOW - 20 * HOUR_MS }
  for (const incomingText of ['Selamat pagi kak', 'halo kak', 'hai', 'hello', 'good morning', 'pagi kak', 'selamat malam kak', 'Pagi kak 🙏', 'oh no', 'no good', 'ok :(']) {
    for (const history of [CLOSED_YESTERDAY, [customer('ok makasih kak'), bot('Sama-sama, Kak 🙏')]]) {
      const ctx = closingContext(history, yesterday, { incomingText })
      assert.deepEqual(decide(triageResult({ decision: 'escalate' }), ctx), { action: 'escalate', reasons: ['decision:escalate'] }, incomingText)
      assert.equal(decide({ ok: false, error: 'timeout' }, ctx).action, 'escalate', incomingText)
    }
  }
  const thanksToday = closingContext(CLOSED_YESTERDAY, yesterday, { incomingText: 'makasih kak' })
  assert.equal(decide(triageResult(THANKS), thanksToday).action, 'auto_send', 'a new session may have its own closing')
  // A greeting answered with a reply the guards refuse is escalated, never dropped by the once-per-session limit.
  const greeting = closingContext([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')], { lastClosingAt: NOW - HOUR_MS }, { incomingText: 'halo kak', guard: { ok: false, reasons: ['no_facts_used'] } })
  assert.deepEqual(decide(triageResult({ decision: 'answer', reply: 'Halo Kak 🙏' }), greeting), { action: 'escalate', reasons: ['decision:answer', 'guard:no_facts_used'] })
})

test('a closing is held while something in the chat still waits for the owner', () => {
  const held = (history, chat, extra) => decide(triageResult(THANKS), closingContext(history, chat, extra)).reasons
  assert.deepEqual(held([customer('Kak tolong pesanan saya dikirim hari ini ya, buat acara nanti malam')]), ['decision:answer', 'unanswered_message'])
  assert.deepEqual(held([...PRICE_ANSWERED, customer('', { attachment: 'location' })]), ['decision:answer', 'unanswered_attachment:location'])
  assert.deepEqual(held([customer('brownies berapa?'), bot('Rp 85.000 ya Kak, mau pesan berapa?')]), ['decision:answer', 'answers_owner_question'])
  assert.deepEqual(held([customer('Mau pesan brownies 2 loyang kak'), owner('Jadi total 2 loyang Rp 170.000 ya kak, diambil Sabtu')], {}, { incomingText: 'ok kak' }),
    ['decision:answer', 'answers_owner_message'], 'an "ok" to what the owner wrote is the owner\'s to answer')

  const laterAnswer = [owner('Mau diantar Sabtu kak?', { timestamp: at(60) }), customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')]
  assert.deepEqual(held(laterAnswer, {}, { incomingText: 'iya kak', quoted: ['Mau diantar Sabtu kak?'] }), ['decision:answer', 'quotes_earlier_message'])
  assert.deepEqual(held(laterAnswer, {}, { incomingText: 'ok makasih kak', quoted: ['Buka  08.00–17.00 ya Kak.'] }), ['decision:answer', 'all_gates_passed'], 'quoting our last message is fine')
  assert.deepEqual(held([customer('ok makasih kak'), bot('Sama-sama, Kak 🙏')], {}, { incomingText: 'iya kak', quoted: ['Mau diantar Sabtu kak?'] }),
    ['decision:answer', 'quotes_earlier_message'], 'nor is a reply to an earlier question skipped after a closing')

  const transfer = customer('Kak saya sudah transfer')
  assert.deepEqual(held([transfer, customer('jam tutup?'), bot('Tutup 17.00 ya Kak.')], { openDrafts: [{ messageIds: [transfer.id] }] }), ['decision:answer', 'open_draft'])
  const factual = { ...baseContext(), incomingText: 'jam buka?', history: [transfer], chat: { ...baseContext().chat, openDrafts: [{ messageIds: [transfer.id] }] } }
  assert.equal(decide(triageResult(ANSWER_HOURS), factual).action, 'auto_send', 'an answer from the facts is not held by an earlier open question')
})

test('a thanks while an open draft already holds the chat is skipped, not drafted again', () => {
  const transfer = customer('kak saya sudah transfer ya')
  const openDrafts = [{ messageIds: [transfer.id] }]
  for (const [history, triage] of [
    [[transfer], THANKS],
    [[transfer, customer('makasih kak'), customer('🙏')], { decision: 'escalate', reply: '🙏' }],
    [[], THANKS]
  ]) assert.deepEqual(decide(triageResult(triage), closingContext(history, { openDrafts })), { action: 'skip', reasons: [`decision:${triage.decision}`, 'open_draft'] })
  assert.equal(decide(triageResult(THANKS), closingContext([bot('Sama-sama, Kak 🙏')], { openDrafts })).action, 'skip', 'after our closing too')

  const pickup = customer('kak pesanan saya bisa diambil hari ini? pagi atau sore?')
  const choice = closingContext([pickup], { openDrafts: [{ messageIds: [pickup.id] }] }, { incomingText: 'ok kak sore ya' })
  assert.deepEqual(decide(triageResult({ decision: 'escalate' }), choice), { action: 'escalate', reasons: ['decision:escalate'] }, 'an "ok" that picks a time is new')

  const photo = closingContext([transfer], { openDrafts }, { attachments: ['image'] })
  assert.deepEqual(decide(triageResult(THANKS), photo).reasons, ['decision:answer', 'attachment:image', 'open_draft'], 'a file is new: it is drafted')
  const pin = closingContext([transfer, customer('', { attachment: 'location' })], { openDrafts })
  assert.deepEqual(decide(triageResult(THANKS), pin).reasons, ['decision:answer', 'open_draft', 'unanswered_attachment:location'])
})

test('an answer to a thanks is a closing whatever facts it cites: the guards refuse the facts, the holds still apply', () => {
  const run = (incomingText, triage, history = PRICE_ANSWERED, chat = {}) => {
    const guard = guardTriage(triage, { knowledge, config, incomingText })
    return decide(triageResult(triage), closingContext(history, chat, { incomingText, guard }))
  }
  const withFacts = (reply, facts) => ({ decision: 'answer', reply, facts_used: facts })
  for (const [incomingText, triage] of [
    ['ok makasih kak 🙏', withFacts('Sama-sama kak, besok kami kirim ya', ['F3'])],
    ['thanks!', withFacts("Thanks! We're open now", ['F1'])],
    ['makasih kak', withFacts('Sama-sama kak, pesanannya pasti kami siapkan tepat waktu ya', ['F9'])],
    ['ok kak', withFacts('Siap kak, sudah kami catat pesanannya ya', ['F13'])]
  ]) {
    const decision = run(incomingText, triage)
    assert.equal(decision.action, 'escalate', incomingText)
    assert.ok(decision.reasons.includes('guard:social_message_answered_with_facts'), `${incomingText}: ${decision.reasons}`)
  }
  const promise = withFacts('Siap kak, sudah kami catat pesanannya ya', ['F13'])
  assert.ok(run('makasih kak 🙏', promise, [customer('tolong dikirim hari ini')]).reasons.includes('unanswered_message'))
  assert.ok(run('iya kak', withFacts('Baik kak, sudah termasuk tulisan nama ya', ['F8']), [owner('Mau pakai tulisan nama di tartnya kak?')]).reasons.includes('answers_owner_question'))
  const facts = withFacts('Sama-sama kak, semua kue dibuat sesuai pesanan ya', ['F9'])
  assert.equal(run('makasih kak', facts, PRICE_ANSWERED, { lastClosingAt: NOW - 1000 }).action, 'skip', 'a closing sent after our answer closed the chat')
  assert.deepEqual(run('makasih kak', facts, PRICE_ANSWERED, { lastClosingAt: NOW - HOUR_MS }), { action: 'escalate', reasons: ['decision:answer', 'guard:social_message_answered_with_facts'] },
    'the once-per-session limit drops only a reply the guards accept')
})

test('an attachment holds any answer: Claude only saw the caption', () => {
  for (const triage of [THANKS, ANSWER_HOURS]) {
    const ctx = { ...closingContext([bot('Sama-sama, Kak 🙏')]), attachments: ['image'] }
    assert.deepEqual(decide(triageResult(triage), ctx).reasons, ['decision:answer', 'attachment:image'])
  }
})

test('a closing uses no per-chat slot; the daily cap still counts it', () => {
  const ctx = closingContext([customer('jam buka?'), bot('Buka 08.00–17.00 ya Kak.')])
  ctx.chatAutoSendsLastHour = 3
  assert.equal(decide(triageResult(THANKS), ctx).action, 'auto_send')
  ctx.autoSendsLastDay = 30
  assert.deepEqual(decide(triageResult(THANKS), ctx).reasons, ['decision:answer', 'daily_rate_limit'])
})
