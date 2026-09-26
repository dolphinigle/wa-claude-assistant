import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardTriage } from '../src/guards.js'
import { closedThisSession, decide } from '../src/policy.js'
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
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const SESSION_START = NOW - 12 * HOUR_MS
const at = minutesAgo => Math.floor((NOW - minutesAgo * MINUTE_MS) / 1000)
let messageCounter = 0
const customer = (text, minutesAgo, extra = {}) => ({ id: `C${++messageCounter}`, fromMe: false, text, timestamp: at(minutesAgo), ...extra })
const ours = (text, minutesAgo, extra = {}) => ({ id: `O${++messageCounter}`, fromMe: true, text, timestamp: at(minutesAgo), ...extra })

// Our answer 40 min ago, the customer's thanks 30 min ago; that thanks was then dealt with: `lastClosingAt` is its time.
const ANSWERED = [customer('jam buka kak?', 41), ours('Buka 08.00–17.00 ya Kak.', 40)]
const THANKED = [...ANSWERED, customer('ok makasih kak', 30)]
const CLOSED_AT = at(30) * 1000
const closed = (history, lastClosingAt = CLOSED_AT) => closedThisSession(history, { lastClosingAt, sessionStart: SESSION_START })
const thanksContext = (history, chat = {}, extra = {}) =>
  ({ ...baseContext(), incomingText: 'makasih kak 🙏', history, chat: { ...baseContext().chat, lastClosingAt: CLOSED_AT, ...chat }, ...extra })
const SKIP = reasons => ({ action: 'skip', reasons })

test('closedThisSession: the owner dealt with a thanks this session, and nothing but thanks came after it', () => {
  assert.equal(closed(THANKED), true, 'the thanks draft was discarded (/no) or approved in shadow: our answer came before it')
  assert.equal(closed([...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })]), true, '/ok or /edit sent this closing')
  assert.equal(closed([...THANKED, ours('Sama-sama kak, sehat selalu ya', 20, { closing: true })]), true, 'the owner\'s own words of thanks')
  assert.equal(closed([...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true }), customer('🙏', 10), customer('thanks kak', 5)]), true, 'thanks after it are passed over')
  assert.equal(closed([]), true, 'a restart empties the history: the recorded closing stands')
  assert.equal(closed([customer('makasih kak', 30), customer('🙏', 20)]), true, 'so does a history of thanks only')
})

test('closedThisSession: no closing this session, or something new since', () => {
  assert.equal(closed(THANKED, 0), false, 'no closing recorded')
  assert.equal(closed(THANKED, SESSION_START), false, 'a closing from an earlier session')
  assert.equal(closed([], SESSION_START - HOUR_MS), false)
  assert.equal(closed(ANSWERED, at(50) * 1000), false, 'our answer came after the thanks that was closed')
  assert.equal(closed([...THANKED, ours('Mau diantar besok kak?', 20)]), false, 'our side said something after the thanks')
  assert.equal(closed([...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true }), ours('Oh ya kak, besok libur', 10)]), false, 'and after the closing')
  assert.equal(closed([...ANSWERED, ours('Siap kak', 35, { timestamp: undefined }), customer('ok makasih kak', 30)]), false, 'ours of unknown age is new')
  assert.equal(closed([...THANKED, customer('iya kak', 20)]), false, 'an "iya" is no thanks')
  assert.equal(closed([...THANKED, customer('jam tutup?', 20)]), false)
  assert.equal(closed([...THANKED, customer('', 20, { attachment: 'image' })]), false, 'a photo is new')
  assert.equal(closed([...THANKED, customer('makasih kak 🙏', 20, { attachment: 'location' })]), false, 'even with a thanks for a caption')
  assert.equal(closed([ours('Sama-sama, Kak 🙏', 25, { closing: true }), customer('kak saya sudah transfer', 20)]), false)
})

test('closedThisSession: our side wrote after the thanks where this history does not show it (the other addressing form, a restart)', () => {
  const closedWith = (history, lastOursAt) => closedThisSession(history, { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START, lastOursAt })
  for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
    assert.equal(closedWith(history, at(10) * 1000), false, 'the owner on the phone, or a send, after the thanks')
    assert.equal(closedWith(history, CLOSED_AT), false, 'in the same second: unknown order, so new')
    assert.equal(closedWith(history, at(40) * 1000), true, 'before the thanks: the closing stands')
  }
})

test('a thanks after a closing this session is skipped, whatever Claude decided and whatever the gates say', () => {
  for (const triage of [THANKS, { decision: 'escalate', reply: '🙏' }, { ...THANKS, facts_used: ['F1'] }]) {
    for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
      const ctx = thanksContext(history)
      ctx.paused = true
      ctx.chatAutoSendsLastHour = 3
      assert.deepEqual(decide(triageResult(triage), ctx), SKIP([`decision:${triage.decision}`, 'closing_already_sent']))
    }
  }
  const quotingOurLast = thanksContext([...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], {}, { quoted: ['Sama-sama,  Kak 🙏'] })
  assert.equal(decide(triageResult(THANKS), quotingOurLast).action, 'skip', 'quoting our last message is fine')
})

test('a thanks is never auto-sent: it is a draft that leads with thanks_not_auto_sent', () => {
  const drafted = { action: 'escalate', reasons: ['decision:answer', 'thanks_not_auto_sent'] }
  // Every gate open, and the reply cites a fact the guards accept.
  const facts = { ...THANKS, facts_used: ['F1'] }
  const open = incomingText => ({ ...baseContext(), incomingText })
  for (const incomingText of ['ok makasih kak 🙏', 'thanks!', '🙏', 'Terima kasih kembali kak', 'bye']) {
    assert.deepEqual(decide(triageResult(facts), open(incomingText)), drafted, incomingText)
    assert.deepEqual(decide(triageResult(THANKS), open(incomingText)), drafted, incomingText)
  }
  // The guards refuse it too, but the notice leads with the policy's one reason.
  const guard = guardTriage(facts, { knowledge, config, incomingText: 'makasih kak' })
  assert.deepEqual(guard.reasons, ['social_message_answered_with_facts', 'thanks_back'])
  assert.deepEqual(decide(triageResult(facts), { ...open('makasih kak'), guard }), drafted)
  assert.deepEqual(decide(triageResult(THANKS), { ...open('makasih kak 🙏'), attachments: ['image'] }).reasons, ['decision:answer', 'thanks_not_auto_sent', 'attachment:image'])
  assert.deepEqual(decide(triageResult({ decision: 'escalate' }), open('makasih kak')), { action: 'escalate', reasons: ['decision:escalate'] }, 'Claude\'s escalation stands')
})

test('an answer that cites no fact never auto-sends', () => {
  for (const incomingText of ['halo kak', 'iya kak', 'ok', 'jam buka?']) {
    const reply = { decision: 'answer', reply: 'Siap Kak 🙏', facts_used: [] }
    const guard = guardTriage(reply, { knowledge, config, incomingText })
    const decision = decide(triageResult(reply), { ...baseContext(), incomingText, guard })
    assert.deepEqual(decision, { action: 'escalate', reasons: ['decision:answer', 'guard:no_facts_used'] }, incomingText)
  }
})

test('drafted, not skipped: an open draft, an acknowledgement, a greeting, a quote, a file, something new, another session, a failed triage', () => {
  const escalated = ctx => decide(triageResult({ decision: 'escalate', reply: 'Baik Kak' }), ctx)
  const expectDraft = (ctx, note) => assert.deepEqual(escalated(ctx), { action: 'escalate', reasons: ['decision:escalate'] }, note)

  // Another draft of the chat is open and nothing was closed: the thanks is drafted too.
  const transfer = customer('kak saya sudah transfer ya', 20)
  expectDraft(thanksContext([transfer], { lastClosingAt: 0 }), 'a thanks while a draft is open')
  expectDraft(thanksContext([...THANKED, transfer]), 'a thanks after a new question, with a closing before it')
  // Acknowledgements and greetings after a closing may answer something or open a conversation.
  const afterClosing = [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })]
  for (const incomingText of ['iya kak', 'ok', 'siap kak', '👍', 'Selamat pagi kak', 'halo kak', 'makasih kak, selamat siang', 'oh no', 'ok :(', '😡']) {
    expectDraft(thanksContext(afterClosing, {}, { incomingText }), incomingText)
  }
  expectDraft(thanksContext(afterClosing, {}, { quoted: ['Mau diantar Sabtu kak?'] }), 'a thanks that quotes an older message')
  expectDraft(thanksContext([], {}, { quoted: ['Sama-sama, Kak 🙏'] }), 'a quote with no history to compare it to')
  expectDraft(thanksContext(afterClosing, {}, { attachments: ['image'] }), 'a thanks with a photo')
  expectDraft(thanksContext([...afterClosing, ours('Oh ya kak, besok kami libur', 10)]), 'our side said something new after the closing')
  expectDraft(thanksContext(afterClosing, { lastClosingAt: NOW - 13 * HOUR_MS }), 'a closing from an earlier session')
  assert.deepEqual(decide({ ok: false, error: 'isolation_assertion_failed' }, thanksContext(afterClosing)), { action: 'escalate', reasons: ['triage_failed:isolation_assertion_failed'] },
    'a failed triage is escalated, before any skip')
})

test('an attachment holds any answer: Claude only saw the caption', () => {
  const ctx = { ...baseContext(), incomingText: 'jam buka?', attachments: ['image'] }
  assert.deepEqual(decide(triageResult(ANSWER_HOURS), ctx).reasons, ['decision:answer', 'attachment:image'])
})
