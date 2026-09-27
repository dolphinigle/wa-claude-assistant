import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardTriage } from '../src/guards.js'
import { closedThisSession, decide } from '../src/policy.js'
import { ANSWER_HOURS, knowledge, makeConfig, okRateLimit, triageResult } from './helpers.js'

const config = makeConfig()
const NOW = Date.UTC(2026, 8, 26, 3, 0)
// The routing part of a decision; the placeholder part has its own tests below.
const route = (result, ctx) => {
  const { action, reasons } = decide(result, ctx)
  return { action, reasons }
}
const baseContext = () => ({
  config,
  incomingText: 'Kak, jam berapa buka?',
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
  assert.deepEqual(route(triageResult(ANSWER_HOURS), baseContext()), { action: 'auto_send', reasons: ['decision:answer', 'all_gates_passed'] })
})

test('escalate always escalates, whatever the gates say', () => {
  const ctx = baseContext()
  ctx.paused = true
  ctx.rateLimit = undefined
  assert.deepEqual(route(triageResult({ decision: 'escalate' }), ctx), { action: 'escalate', reasons: ['decision:escalate'] })
  assert.deepEqual(route(triageResult({ decision: 'escalate' }), baseContext()).action, 'escalate')
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
// A plain thanks ("makasih kak 🙏"); `agrees` is tested on its own below.
const closed = (history, lastClosingAt = CLOSED_AT, agrees = false) => closedThisSession(history, { lastClosingAt, sessionStart: SESSION_START, agrees })
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
  const closedWith = (history, lastOursAt) => closedThisSession(history, { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START, lastOursAt, agrees: false })
  for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
    assert.equal(closedWith(history, at(10) * 1000), false, 'the owner on the phone, or a send, after the thanks')
    assert.equal(closedWith(history, CLOSED_AT), false, 'in the same second: unknown order, so new')
    assert.equal(closedWith(history, at(40) * 1000), true, 'before the thanks: the closing stands')
  }
})

test('closedThisSession: what the customer sent after the closed thanks is new, even where our closing reply came later (skip-safety-r2-1)', () => {
  const reply = ours('Sama-sama, Kak 🙏', 20, { closing: true })
  for (const attachment of ['image', 'audio', 'location', 'other']) {
    assert.equal(closed([...THANKED, customer('', 29, { attachment }), reply]), false, `${attachment} while the thanks draft waited`)
  }
  assert.equal(closed([...THANKED, customer('', 30, { attachment: 'image' }), reply]), false, 'a file in the thanks\' own second: order unknown')
  assert.equal(closed([...THANKED, customer('kak saya sudah transfer', 25), reply]), false, 'a question the draft never showed')
  assert.equal(closed([...THANKED, customer('', 29, { attachment: 'image', timestamp: undefined }), reply]), false, 'a file of unknown age')
  // What came before the thanks, or with it, was part of the thanks the owner dealt with.
  assert.equal(closed([customer('', 35, { attachment: 'image' }), customer('jam buka?', 33), ours('Buka 08.00 ya', 32), customer('ok makasih kak', 30), reply]), true)
  assert.equal(closed([...ANSWERED, customer('makasih kak', 30), customer('👍', 30), reply]), true, 'a burst: its 👍 is from the thanks\' second')
  assert.equal(closed([...THANKED, customer('🙏', 25), reply]), true, 'a thanks while it waited is passed over')
})

test('closedThisSession: untriaged content on either form or before a restart is new from the closed thanks on (consistency-r2-2)', () => {
  const closedWith = (history, lastUntriagedAt) => closedThisSession(history, { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START, lastUntriagedAt, agrees: false })
  for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
    assert.equal(closedWith(history, at(10) * 1000), false, 'a photo after the thanks, which this history does not show')
    assert.equal(closedWith(history, CLOSED_AT), false, 'in the same second: unknown order, so new')
    assert.equal(closedWith(history, at(40) * 1000), true, 'before the thanks: the closing stands')
  }
  assert.equal(decide(triageResult(THANKS), thanksContext([], { lastUntriagedAt: at(10) * 1000 })).action, 'escalate', 'decide passes it on')
})

test('closedThisSession: a customer message that was no thanks, on either form or before a restart, is new from the closed thanks on (skip-safety-r3-1)', () => {
  const closedWith = (history, lastOpenedAt) => closedThisSession(history, { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START, lastOpenedAt, agrees: false })
  for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
    assert.equal(closedWith(history, at(10) * 1000), false, 'a question after the thanks, which this history does not show')
    assert.equal(closedWith(history, CLOSED_AT), false, 'in the same second: unknown order, so new')
    assert.equal(closedWith(history, at(41) * 1000), true, 'the question before the thanks: the closing stands')
  }
  assert.equal(decide(triageResult(THANKS), thanksContext([], { lastOpenedAt: at(10) * 1000 })).action, 'escalate', 'decide passes it on')
})

test('a thanks that agrees closes only after our closing reply: after a /no, a shadow /ok or a restart it may be a yes (skip-safety-r3-2)', () => {
  const question = ours('Bisa kak, mau diantar jam 5 sore?', 40)
  const asked = [customer('kak brownies bisa diantar besok?', 41), question, customer('makasih kak', 30)]
  const agreeing = (history, lastClosingAt = CLOSED_AT) => closed(history, lastClosingAt, true)
  assert.equal(agreeing(asked), false, 'our question came before the thanks the owner discarded')
  assert.equal(agreeing([]), false, 'a restart: what it could agree to is unknown')
  assert.equal(agreeing([customer('makasih kak', 30)]), false, 'a history of thanks only')
  assert.equal(agreeing([...asked, ours('Sama-sama, Kak 🙏', 20, { closing: true })]), true, 'our closing reply asked nothing')
  assert.equal(closed(asked), true, 'a plain thanks is still skipped')
  assert.equal(closedThisSession(asked, { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START }), false, 'unset: it agrees')
  // decide reads it from the message.
  for (const incomingText of ['iya kak makasih', '👍 makasih kak', 'ok siap, makasih', 'perfect, thanks']) {
    assert.deepEqual(route(triageResult(THANKS), thanksContext(asked, {}, { incomingText })), { action: 'escalate', reasons: ['decision:answer', 'no_question'] }, incomingText)
  }
  assert.equal(decide(triageResult(THANKS), thanksContext(asked)).action, 'skip', 'makasih kak 🙏')
})

test('a "ya" before the thanks is a yes: after a /no, a shadow /ok or a restart it is drafted, a trailing "ya" is not (skip-safety-r1-1)', () => {
  const asked = [customer('kak brownies bisa diantar besok?', 41), ours('Bisa kak, mau diantar jam 5 sore?', 40), customer('makasih kak', 30)]
  for (const incomingText of ['ya makasih', 'ya kak, makasih', 'yaa makasih', 'ya deh makasih kak', 'Ya, terima kasih banyak kak', 'ya\nmakasih kak']) {
    for (const history of [asked, []]) {
      assert.deepEqual(route(triageResult(THANKS), thanksContext(history, {}, { incomingText })), { action: 'escalate', reasons: ['decision:answer', 'no_question'] },
        `${incomingText} (${history.length ? 'after a /no' : 'after a restart'})`)
    }
  }
  for (const incomingText of ['makasih ya kak', 'terima kasih ya']) assert.equal(decide(triageResult(THANKS), thanksContext(asked, {}, { incomingText })).action, 'skip', incomingText)
})

test('a thanks quoting our message is skipped only when that message is our closing reply (skip-safety-r3-1)', () => {
  const question = ours('Bisa kak, mau diantar jam 5 sore?', 40)
  const asked = [customer('kak brownies bisa diantar besok?', 41), question, customer('makasih kak', 30)]
  const escalated = { action: 'escalate', reasons: ['decision:answer', 'no_question'] }
  for (const quote of [{ id: question.id, text: question.text }, { text: question.text }, question.text]) {
    assert.deepEqual(route(triageResult(THANKS), thanksContext(asked, {}, { quoted: [quote] })), escalated, JSON.stringify(quote))
  }
  assert.deepEqual(route(triageResult({ decision: 'escalate' }), thanksContext(asked, {}, { quoted: [question.text] })), { action: 'escalate', reasons: ['decision:escalate'] })
  const reply = ours('Sama-sama, Kak 🙏', 20, { closing: true })
  assert.equal(decide(triageResult(THANKS), thanksContext([...asked, reply], {}, { quoted: [{ id: reply.id, text: reply.text }] })).action, 'skip', 'our closing reply')
})

test('a thanks quoting an older message without text is drafted: quotes are told apart by id (skip-safety-r2-2)', () => {
  const photo = ours('', 45, { attachment: 'image' })
  const reply = ours('Sama-sama, Kak 🙏', 20, { closing: true })
  const history = [photo, ...THANKED, reply]
  const escalated = { action: 'escalate', reasons: ['decision:answer', 'no_question'] }
  assert.deepEqual(route(triageResult(THANKS), thanksContext(history, {}, { quoted: [{ id: photo.id, text: '' }] })), escalated, 'our older photo, by id')
  assert.deepEqual(route(triageResult(THANKS), thanksContext(history, {}, { quoted: [{ text: '' }] })), escalated, 'no id: an empty text is not our last')
  const photoLast = [...THANKED, ours('', 25, { attachment: 'image' }), ours('', 24, { attachment: 'image', closing: true })]
  assert.deepEqual(route(triageResult(THANKS), thanksContext(photoLast, {}, { quoted: [{ id: photoLast.at(-2).id, text: '' }] })), escalated,
    'two photos with no text: the id says which one')
  assert.equal(decide(triageResult(THANKS), thanksContext(history, {}, { quoted: [{ id: reply.id, text: reply.text }] })).action, 'skip', 'our last message, by id')
})

test('a thanks after a closing this session is skipped, whatever Claude decided and whatever the gates say', () => {
  for (const triage of [THANKS, { decision: 'escalate', reply: '🙏' }, { ...THANKS, facts_used: ['F1'] }]) {
    for (const history of [THANKED, [...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], []]) {
      const ctx = thanksContext(history)
      ctx.paused = true
      ctx.chatAutoSendsLastHour = 3
      assert.deepEqual(route(triageResult(triage), ctx), SKIP([`decision:${triage.decision}`, 'closing_already_sent']))
    }
  }
  const quotingOurLast = thanksContext([...THANKED, ours('Sama-sama, Kak 🙏', 20, { closing: true })], {}, { quoted: ['Sama-sama,  Kak 🙏'] })
  assert.equal(decide(triageResult(THANKS), quotingOurLast).action, 'skip', 'quoting our last message is fine')
})

test('an answer to a message that asks nothing is never auto-sent, whatever it cites: a draft that leads with no_question', () => {
  const drafted = { action: 'escalate', reasons: ['decision:answer', 'no_question'] }
  // Every gate open, and the reply cites a fact the guards accept.
  const facts = { decision: 'answer', reply: 'Siap Kak, ditunggu ya. Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', facts_used: ['F1'] }
  const open = incomingText => ({ ...baseContext(), incomingText })
  for (const incomingText of ['iya kak', 'ok', '👍', 'makasih bang', 'sama2 kak', 'gapapa', 'betul', 'saya tunggu', 'ok kk', 'siap bos',
    'saya mau ambil besok', 'makasih infonya kak', 'ok makasih kak 🙏', 'thanks!', '🙏', 'Terima kasih kembali kak', 'bye', 'Selamat pagi kak']) {
    assert.deepEqual(route(triageResult(facts), open(incomingText)), drafted, incomingText)
    assert.deepEqual(route(triageResult(THANKS), open(incomingText)), drafted, incomingText)
  }
  assert.deepEqual(route(triageResult(facts), { ...baseContext(), incomingText: undefined }), drafted, 'no text: it asks nothing')
  assert.deepEqual(route(triageResult(THANKS), { ...open('makasih kak 🙏'), attachments: ['image'] }).reasons, ['decision:answer', 'no_question', 'attachment:image'])
  assert.deepEqual(route(triageResult({ decision: 'escalate' }), open('makasih kak')), { action: 'escalate', reasons: ['decision:escalate'] }, 'Claude\'s escalation stands')
})

test('a fact-cited answer to a yes with "kok", a spelled-out "no problem" or a shared link is a draft (send-path-r1-1, send-path-r1-2, send-path-r1-3)', () => {
  const delivery = { decision: 'answer', reply: 'Baik Kak, pengiriman dalam Kota Bandung pakai kurir instan (GoSend atau GrabExpress), ongkir dibayar pembeli ya.', facts_used: ['F3'] }
  const deposit = { decision: 'answer', reply: 'Baik Kak, pesanan dianggap masuk setelah DP 50% ya.', facts_used: ['F10'] }
  for (const [triage, incomingText] of [
    [delivery, 'boleh kok kak'], [delivery, 'bisa kok kak'], [delivery, 'gapapa kok kak'], [delivery, 'udah sampai kok kak, makasih'],
    [deposit, 'ga napa kak'], [deposit, 'gak knp kak'], [deposit, 'nggak kenapa kak'], [deposit, 'tidak mengapa kak'],
    [delivery, 'Kak kirim ke sini ya https://maps.app.goo.gl/AbC123xyz?g_st=iw'], [delivery, 'ok makasih kak https://maps.app.goo.gl/AbC123xyz?g_st=iw'],
    [delivery, 'Kak aku mau yang ini https://shopee.co.id/product/123?smtt=0.0.9']
  ]) {
    const guard = guardTriage(triage, { knowledge, config, incomingText })
    assert.deepEqual(guard, { ok: true, reasons: [] }, `${incomingText}: the guards alone would let it out`)
    assert.deepEqual(route(triageResult(triage), { ...baseContext(), incomingText, guard }), { action: 'escalate', reasons: ['decision:answer', 'no_question'] }, incomingText)
  }
})

test('a fact-cited answer to a no, an emphatic or English yes, or a closing with a question word in it is a draft (send-path-r2-1, send-path-r2-2, send-path-r2-3)', () => {
  const hours = { decision: 'answer', reply: 'Sama-sama, Kak 🙏 Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya.', facts_used: ['F1'] }
  const preorder = { decision: 'answer', reply: 'Siap, Kak. Pesan paling lambat 2 hari sebelumnya ya.', facts_used: ['F9'] }
  const hoursEn = { decision: 'answer', reply: "You're welcome! We're open Monday–Saturday 08.00–17.00 WIB.", facts_used: ['F1'] }
  for (const [triage, incomingText] of [
    [hours, 'tidak ada, terima kasih'], [hours, 'Makasih kak, ga ada lagi kok'], [hours, 'gak ada kak, makasih'], [hours, 'nggak ada kak, makasih banyak'],
    [hours, 'makasih kak udah dibantu, ga ada lagi'], [hours, 'gak bisa kak'],
    [preorder, 'boleh banget kak'], [preorder, 'bisa bgt kak'], [preorder, 'iya boleh bgt kak makasih'], [preorder, 'masih ada kak makasih'],
    [hoursEn, 'that would be great, thanks'], [hoursEn, 'yes please do'], [hoursEn, 'thank you, that is it'], [hoursEn, 'ok that is it for now, thanks'],
    [hoursEn, 'I would like to thank you for the fast delivery'], [hours, 'makasih kak, nanti saya kabari mau yang mana']
  ]) {
    const guard = guardTriage(triage, { knowledge, config, incomingText })
    assert.deepEqual(guard, { ok: true, reasons: [] }, `${incomingText}: the guards alone would let it out`)
    assert.deepEqual(route(triageResult(triage), { ...baseContext(), incomingText, guard }), { action: 'escalate', reasons: ['decision:answer', 'no_question'] }, incomingText)
  }
})

test('a fact-cited answer to an apology, a "maybe", a deferral, a one-word yes, a statement with "ada" or an English plan is a draft (send-path-r3-1..4)', () => {
  const order = { decision: 'answer', reply: 'Sama-sama Kak! Pemesanan bisa langsung lewat chat ini ya.', facts_used: ['F13'] }
  const delivery = { decision: 'answer', reply: 'Baik Kak, pengiriman dalam Kota Bandung pakai kurir instan (GoSend atau GrabExpress), ongkir dibayar pembeli ya.', facts_used: ['F3'] }
  const deposit = { decision: 'answer', reply: 'Siap Kak, pesanan dianggap masuk setelah DP 50% ya.', facts_used: ['F10'] }
  const hours = { decision: 'answer', reply: 'Siap Kak, kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya.', facts_used: ['F1'] }
  const cash = { decision: 'answer', reply: 'Sure! Cash on pick-up is fine.', facts_used: ['F4'] }
  for (const [triage, incomingText] of [
    [order, 'makasih kak, siapa tau nanti order lagi'], [order, 'makasih kak, maaf ya banyak tanya'], [order, 'oke kak, nanti saya tanya lagi'],
    [delivery, 'ok kak, gimana kakak aja'], [deposit, 'yaudah boleh kak'], [deposit, 'ywdh boleh'], [deposit, 'boleh kak lanjut'], [deposit, 'ok gas kak boleh'],
    [order, 'makasih kak, nanti kalau ada apa-apa saya hubungi lagi'], [hours, 'iya kak, besok ada yang ambil'], [hours, 'makasih kak, udah ada yang jemput'],
    [cash, 'thanks, I will pay when I pick up'], [cash, 'ok, I will transfer when I get home']
  ]) {
    const guard = guardTriage(triage, { knowledge, config, incomingText })
    assert.deepEqual(guard, { ok: true, reasons: [] }, `${incomingText}: the guards alone would let it out`)
    assert.deepEqual(route(triageResult(triage), { ...baseContext(), incomingText, guard }), { action: 'escalate', reasons: ['decision:answer', 'no_question'] }, incomingText)
  }
})

test('an answer to a message that asks something goes on to the other gates, a burst where one message asks too', () => {
  const autoSent = { action: 'auto_send', reasons: ['decision:answer', 'all_gates_passed'] }
  const open = incomingText => ({ ...baseContext(), incomingText })
  for (const incomingText of ['Halo kak, tokonya buka jam berapa aja ya?', "Hi! Where is your shop located? I'd like to pick up my order.",
    'Kak, brownies panggang harganya berapa ya?', 'jam berapa buka kak', 'alamatnya dimana', 'where are you located', 'tokonya buka gak kak',
    'makasih kak, jam berapa tutup?', 'ok makasih kak\njam tutupnya jam berapa']) {
    assert.deepEqual(route(triageResult(ANSWER_HOURS), open(incomingText)), autoSent, incomingText)
  }
  const ctx = { ...open('jam berapa buka kak'), guard: { ok: false, reasons: ['unsupported_time:21:00'] } }
  assert.deepEqual(route(triageResult(ANSWER_HOURS), ctx), { action: 'escalate', reasons: ['decision:answer', 'guard:unsupported_time:21:00'] }, 'the other gates still hold it')
})

test('an answer that cites no fact never auto-sends', () => {
  for (const incomingText of ['jam buka?', 'alamatnya dimana kak', 'where is the shop', 'makasih, bisa kirim ke Jakarta?']) {
    const reply = { decision: 'answer', reply: 'Siap Kak 🙏', facts_used: [] }
    const guard = guardTriage(reply, { knowledge, config, incomingText })
    const decision = route(triageResult(reply), { ...baseContext(), incomingText, guard })
    assert.deepEqual(decision, { action: 'escalate', reasons: ['decision:answer', 'guard:no_facts_used'] }, incomingText)
  }
})

test('drafted, not skipped: an open draft, an acknowledgement, a greeting, a quote, a file, something new, another session, a failed triage', () => {
  const escalated = ctx => route(triageResult({ decision: 'escalate', reply: 'Baik Kak' }), ctx)
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
  assert.deepEqual(route({ ok: false, error: 'isolation_assertion_failed' }, thanksContext(afterClosing)), { action: 'escalate', reasons: ['triage_failed:isolation_assertion_failed'] },
    'a failed triage is escalated, before any skip')
})

test('an attachment holds any answer: Claude only saw the caption', () => {
  const ctx = { ...baseContext(), incomingText: 'jam buka?', attachments: ['image'] }
  assert.deepEqual(route(triageResult(ANSWER_HOURS), ctx).reasons, ['decision:answer', 'attachment:image'])
})

// --- the escalation placeholder (owner decision 2026-09-27) ---------------------------------------------------------

const WAITING = { decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.', customer_waiting: true }
const waitingContext = () => ({ ...baseContext(), incomingText: 'Kak ada cheesecake nggak? Harganya berapa?' })

test('placeholder: a customer Claude says is waiting gets one on an escalation, also on an answer a gate held', () => {
  assert.deepEqual(decide(triageResult(WAITING), waitingContext()), { action: 'escalate', reasons: ['decision:escalate'], placeholder: true, placeholderWithheld: [] })
  const held = { ...waitingContext(), incomingText: 'jam berapa buka kak?', guard: { ok: false, reasons: ['unsupported_time:21:00'] } }
  assert.equal(decide(triageResult({ ...ANSWER_HOURS, customer_waiting: true }), held).placeholder, true, 'the owner answers it instead: the customer waits')
  assert.deepEqual(decide(triageResult({ ...ANSWER_HOURS, customer_waiting: true }), { ...waitingContext(), incomingText: 'jam berapa buka kak?' }),
    { action: 'auto_send', reasons: ['decision:answer', 'all_gates_passed'], placeholder: false, placeholderWithheld: [] }, 'an auto-reply is the answer itself')
})

test('placeholder: none unless customer_waiting is exactly true, and none on a failed triage', () => {
  for (const customerWaiting of [false, undefined, 'true', 1, null]) {
    const decision = decide(triageResult({ ...WAITING, customer_waiting: customerWaiting }), waitingContext())
    assert.deepEqual([decision.placeholder, decision.placeholderWithheld], [false, ['customer_not_waiting']], String(customerWaiting))
  }
  for (const result of [{ ok: false, error: 'timeout' }, { ok: true }, undefined]) {
    const decision = decide(result, waitingContext())
    assert.deepEqual([decision.action, decision.placeholder, decision.placeholderWithheld], ['escalate', false, ['triage_failed']])
  }
})

// Each row breaks exactly one condition; a waiting customer's escalation then gets no placeholder, and the audit says why.
const withholders = [
  ['placeholder_disabled', ctx => { ctx.config = makeConfig({ placeholder: { enabled: false } }) }],
  ['thanks', ctx => { ctx.incomingText = 'makasih kak 🙏' }],
  ['paused', ctx => { ctx.paused = true }],
  ['muted', ctx => { ctx.chat.muted = true }],
  ['blocked', ctx => { ctx.chat.blocked = true }],
  ['blocklist_unchecked', ctx => { ctx.chat.blocklistUnchecked = true }],
  ['human_takeover', ctx => { ctx.chat.takeoverUntil = NOW + 60_000 }],
  ['chat_rate_limit', ctx => { ctx.chatAutoSendsLastHour = 3 }],
  ['daily_rate_limit', ctx => { ctx.autoSendsLastDay = 30 }],
  ['backlog', ctx => { ctx.isBacklog = true; ctx.config = makeConfig({ backlog: { autoSend: true } }) }],
  ['placeholder_already_sent', ctx => { ctx.chat.placeholderSent = true }]
]

for (const [reason, mutate] of withholders) {
  test(`placeholder: none when ${reason}`, () => {
    const ctx = waitingContext()
    ctx.chat = { ...ctx.chat }
    mutate(ctx)
    const decision = decide(triageResult(WAITING), ctx)
    assert.deepEqual([decision.action, decision.placeholder, decision.placeholderWithheld], ['escalate', false, [reason]])
  })
}

test('placeholder: a skip never gets one, whatever Claude says', () => {
  const decision = decide(triageResult(WAITING), thanksContext(THANKED))
  assert.deepEqual([decision.action, decision.placeholder], ['skip', false])
})

test('placeholder: it is our side\'s message, so a thanks after it is not skipped as if nothing came after the closing', () => {
  const placeholder = ours('🤖 Tunggu sebentar ya Kak 🙏', 20)
  assert.equal(closed([...THANKED, placeholder]), false, 'in the history')
  assert.equal(closedThisSession([...THANKED], { lastClosingAt: CLOSED_AT, sessionStart: SESSION_START, lastOursAt: at(20) * 1000, agrees: false }), false,
    'or only on the record (lastSentAt), on the other addressing form or before a restart')
  assert.equal(decide(triageResult(THANKS), thanksContext([...THANKED, placeholder])).action, 'escalate')
})
