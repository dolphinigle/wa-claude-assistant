import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asksSomething, buildAllowList, checkHoldingReply, checkReply, containsTerm, detectLanguage, extractDetails, findPrivateDetails, guardGreeting, guardHolding, guardTriage, isGreetingOnly, isLooseThanks, isThanks, privateIdentifiers, privateIdentifiersFor, thanksAgrees } from '../src/guards.js'
import { parseKnowledge } from '../src/knowledge.js'
import { knowledge, makeConfig } from './helpers.js'

const { guards } = makeConfig()
const check = (reply, factsUsed = ['F1']) => checkReply({ reply, factsUsed }, { knowledge, ...guards })

test('knowledge parsing: fact ids, facts-only section, comments stripped', () => {
  assert.deepEqual([...knowledge.facts.keys()], ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15'])
  assert.ok(!knowledge.promptText.includes('<!--'))
  assert.ok(!knowledge.factsText.includes('## Never'))
  const parsed = parseKnowledge('# X\n## Facts\n- [F1] a 10\n## Never\n- promise 99')
  assert.equal(parsed.facts.get('F1'), 'a 10')
  assert.ok(!parsed.factsText.includes('99'))
})

test('fact id digits do not whitelist numbers', () => {
  const allow = buildAllowList(knowledge)
  assert.ok(!allow.numbers.has(13) && !allow.numbers.has(10) && !allow.numbers.has(4))
})

test('extractDetails normalizes rupiah, times, phones and URLs', () => {
  assert.deepEqual(extractDetails('Rp 25.000, 25rb, Rp25.000,-, IDR 25,000, 1,5 juta, 30k').amounts.sort((a, b) => a - b), [25000, 25000, 25000, 25000, 30000, 1500000])
  assert.deepEqual(extractDetails('08.00–17.00, 8:30 pm, 9 AM').times, [480, 1020, 1230, 540])
  assert.deepEqual(extractDetails('call +62 812-3456-7890 or 0812 3456 7890').phones, ['6281234567890', '6281234567890'])
  assert.deepEqual(extractDetails('see https://Example.com/menu. or bit.ly/abc').urls, ['example.com/menu', 'bit.ly/abc'])
  assert.deepEqual(extractDetails('mail a.b@shop.id').emails, ['a.b@shop.id'])
  assert.deepEqual(extractDetails('loyang 20x20, 3 hari').numbers, [20, 20])
})

test('extractDetails types hours of the day, durations and percentages', () => {
  const details = extractDetails('jam 1 siang, 5 sore, jam 9 malam, jam 8, 2 minggu, 3 days, 24 jam, DP 50%, 10 persen')
  assert.deepEqual(details.times, [780, 1020, 1260])
  assert.deepEqual(details.hours, [8])
  assert.deepEqual(details.durations, ['2 w', '3 d', '24 h'])
  assert.deepEqual(details.percents, [50, 10])
  assert.deepEqual(details.numbers, [])
})

test('a detail must come from a fact the reply cites, and match its kind', () => {
  // Each reply's number exists somewhere in the facts, just not in the fact it cites, or as another kind of detail.
  for (const [reply, facts, reason] of [
    ['Pesanan dianggap masuk setelah DP 20% ya Kak', ['F10'], 'unsupported_percent:20'],
    ['Hari Minggu kami buka jam 1 siang sampai jam 3 sore ya Kak', ['F1'], 'unsupported_time:13:00,15:00'],
    ['Brownies harganya Rp 65.000 ya Kak', ['F5'], 'unsupported_amount:65000'],
    ['Brownies tahan 3 bulan ya Kak', ['F12'], 'unsupported_duration:3 mo'],
    ['Buka sampai jam 9 ya Kak', ['F1'], 'unsupported_time:jam 9']
  ]) {
    const result = check(reply, facts)
    assert.ok(result.reasons.includes(reason), `${reply}: ${result.reasons}`)
  }
  assert.deepEqual(check('Pesan paling lambat 2 hari sebelumnya ya Kak', ['F9']), { ok: true, reasons: [] })
  assert.ok(check('Pesan paling lambat 2 hari sebelumnya ya Kak', ['F1']).reasons.includes('unsupported_duration:2 d'), 'F9 is not cited')
  assert.deepEqual(check('Buka jam 8 sampai jam 5 ya Kak', ['F1']), { ok: true, reasons: [] })
})

test('a duration, percentage or hour in a cited fact never licenses the same bare number or another unit', () => {
  for (const [reply, facts, reason] of [
    ['Brownies tahan 3 pekan di suhu ruang ya Kak.', ['F12'], 'unsupported_duration:3 w'],
    ['Brownies tahan 3 bln di suhu ruang ya Kak.', ['F12'], 'unsupported_duration:3 mo'],
    ['Brownies tahan 3 thn di suhu ruang ya Kak.', ['F12'], 'unsupported_duration:3 y'],
    ['Kue kering tahan 1 thn ya Kak.', ['F12'], 'unsupported_duration:1 y'],
    ['Pesan paling lambat 2 hari sebelumnya ya Kak, minimal 3 loyang.', ['F9'], 'unsupported_quantity:3 loyang'],
    ['Brownies tahan 3 fortnight ya Kak.', ['F12'], 'unsupported_quantity:3 fortnight'],
    ['Minimal 20 loyang ya Kak, Rp 85.000.', ['F5'], 'unsupported_quantity:20 loyang'],
    ['Pesan paling lambat 2 hari sebelumnya, minimal 3 ya Kak.', ['F9'], 'unsupported_number:3'],
    ['DP 50% ya Kak, untuk 50 pesanan.', ['F10'], 'unsupported_quantity:50 pesanan'],
    ['Pesanan minimal 8 ya Kak.', ['F1'], 'unsupported_number:8']
  ]) {
    const result = check(reply, facts)
    assert.ok(result.reasons.includes(reason), `${reply}: ${result.reasons}`)
  }
  assert.deepEqual(check('Buka 8 sampai 5 ya Kak', ['F1']), { ok: true, reasons: [] }, 'an hour next to a time word')
  assert.deepEqual(check('Kue kering tahan 1 bln dalam toples tertutup ya Kak', ['F12']), { ok: true, reasons: [] }, 'a unit abbreviation of the cited duration')
  assert.deepEqual(extractDetails('3 pekan, 2 mgg, 10 detik, 1 thn, 6 bln').durations, ['3 w', '2 w', '10 s', '1 y', '6 mo'])
})

test('numbers without ASCII digits fail closed: words, fullwidth and other scripts', () => {
  for (const [reply, reason] of [
    ['Brownies harganya seratus ribu ya Kak.', 'unsupported_number_word:seratus,ribu'],
    ['Brownies harganya delapan puluh ribu ya Kak', 'unsupported_number_word:delapan,puluh,ribu'],
    ['Brownies Rp ８０.０００ ya Kak.', 'unsupported_amount:80000'],
    ['Hubungi ０８１２３４５６７８９０ ya Kak', 'unsupported_phone:6281234567890'],
    ['Transfer ke BCA satu dua tiga empat lima', 'unsupported_number_word:satu,dua,tiga,empat,lima'],
    ['Brownies tahan seminggu di suhu ruang ya Kak.', 'unsupported_number_word:seminggu'],
    ['Brownies Rp ٨٥ ribu ya Kak', 'non_ascii_digits']
  ]) {
    const result = check(reply, ['F5'])
    assert.equal(result.ok, false, reply)
    assert.ok(result.reasons.includes(reason), `${reply}: ${result.reasons}`)
  }
  const custom = parseKnowledge('## Facts\n- [F1] Kue kering tahan sebulan.\n')
  assert.equal(checkReply({ reply: 'Kue kering tahan sebulan ya Kak', factsUsed: ['F1'] }, { knowledge: custom }).ok, true, 'a number word from the cited fact is fine')
})

test('digit-free fractions, ordinals and multiples, and offer words, fail unless the cited facts have them', () => {
  for (const [reply, facts, reason] of [
    ['Brownies tahan sepekan di suhu ruang ya Kak.', ['F12'], 'unsupported_number_word:sepekan'],
    ['Brownies panggang Rp 85.000 ya Kak, hari ini separuh harga.', ['F5'], 'unsupported_number_word:separuh'],
    ['The brownies are Rp 85.000, and a quarter off if you order twice.', ['F5'], 'unsupported_number_word:quarter,twice'],
    ['The brownies are Rp 85.000, and a quarter off if you order twice.', ['F5'], 'sensitive_term:off'],
    ['Brownies Rp 85.000 ya Kak, pakai voucher bisa lebih hemat.', ['F5'], 'sensitive_term:voucher'],
    ['Brownies Rp 85.000 ya Kak, pakai voucher bisa lebih hemat.', ['F5'], 'sensitive_term:hemat'],
    ['Brownies Rp 85.000 ya Kak, dapat hadiah kue kering juga.', ['F5'], 'sensitive_term:hadiah'],
    ['Brownies Rp 85.000 ya Kak, loyang kedua sepertiga harga.', ['F5'], 'unsupported_number_word:kedua,sepertiga'],
    ['Brownies Rp 85.000, double the size for a couple more days.', ['F5'], 'unsupported_number_word:double,couple']
  ]) {
    const result = check(reply, facts)
    assert.ok(result.reasons.includes(reason), `${reply}: ${result.reasons}`)
  }
})

test('sensitive terms match Indonesian affixes and doubled letters, not unrelated words', () => {
  const terms = makeConfig().guards.sensitiveTerms
  for (const reply of ['ada diskonnya ya Kak', 'bisa direfund ya Kak', 'gratiss ongkir ya Kak', 'ongkirnya digratiskan', 'promonya ada', 'garansinya ada', 'ada potongannya', 'dijamin enak', 'uangnya dikembalikan', 'lagi sale', 'ada cashback']) {
    assert.ok(check(`Brownies Rp 85.000, ${reply}`, ['F5']).reasons.some(reason => reason.startsWith('sensitive_term:')), reply)
  }
  assert.ok(!containsTerm('simpan di freezer ya', 'free'))
  assert.ok(!containsTerm('kue kami dikirim hari ini', 'kembalikan'))
  assert.ok(terms.includes('jamin'))
})

test('a bare domain with any TLD must be in the cited facts', () => {
  for (const reply of ['Pesan di sekararum.online ya Kak', 'Pesan di sekararum.biz ya Kak', 'Cek sekararum.dev/order ya Kak']) {
    assert.ok(check(reply, ['F13']).reasons.some(reason => reason.startsWith('unsupported_url:')), reply)
  }
  assert.deepEqual(check('Kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', ['F2']), { ok: true, reasons: [] }, 'abbreviations are not domains')
})

test('replies built from facts pass', () => {
  for (const [reply, facts] of [
    ['Kami buka Senin–Sabtu pukul 08.00–17.00 WIB, Minggu tutup ya Kak 😊', ['F1']],
    ["We're open Monday to Saturday, 8 AM to 5 PM WIB. Closed on Sundays.", ['F1']],
    ['Buka jam 8 pagi sampai 5 sore ya Kak', ['F1']],
    ['Brownies panggang loyang 20x20 cm harganya Rp 85.000 ya Kak', ['F5']],
    ['Brownies 85rb ya kak', ['F5']],
    ['Alamat kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', ['F2']],
    ['Pesan paling lambat 2 hari sebelumnya, tart 3 hari. DP 50% ya Kak.', ['F9', 'F10']],
    ['Nastar Rp 120.000 per toples 500 gram', ['[F7]']]
  ]) {
    assert.deepEqual(check(reply, facts), { ok: true, reasons: [] }, reply)
  }
})

test('unsupported details fail with a reason', () => {
  const cases = [
    ['Cheesecake harganya Rp 150.000', 'unsupported_amount:150000'],
    ['Kami buka tanggal 25 Desember', 'unsupported_quantity:25 desember'],
    ['Tanggal 25 ya Kak', 'unsupported_number:25'],
    ['Buka sampai 21.00 kak', 'unsupported_time:21:00'],
    ['Hubungi 0812-3456-7890 ya', 'unsupported_phone:6281234567890'],
    ['Cek https://bit.ly/promo', 'unsupported_url:bit.ly/promo'],
    ['Email ke owner@toko.id', 'unsupported_email:owner@toko.id'],
    ['Transfer ke 1234567890 ya', 'unsupported_number:1234567890'],
    ['Bisa diskon kak', 'sensitive_term:diskon'],
    ['Kirim ke rekening saya ya', 'sensitive_term:rekening']
  ]
  for (const [reply, reason] of cases) {
    const result = check(reply)
    assert.equal(result.ok, false, reply)
    assert.ok(result.reasons.includes(reason), `${reply}: ${result.reasons}`)
  }
})

test('structural checks: empty, length, placeholders, fact ids, facts_used', () => {
  assert.deepEqual(check('  '), { ok: false, reasons: ['empty_reply'] })
  assert.ok(check('a'.repeat(601)).reasons.includes('too_long:601>600'))
  assert.ok(check('Halo [NAMA], siap').reasons.includes('placeholder'))
  assert.ok(check('Harga {{price}}').reasons.includes('placeholder'))
  assert.ok(check('Halo <nama pelanggan>').reasons.includes('placeholder'))
  assert.ok(check('Buka Senin–Sabtu [F1]').reasons.includes('fact_id_in_reply'))
  assert.ok(check('Buka Senin–Sabtu', []).reasons.includes('no_facts_used'))
  assert.ok(check('Buka Senin–Sabtu', ['F1', 'F99']).reasons.includes('unknown_fact:F99'))
})

const reply = (text, factsUsed, incomingText) => checkReply({ reply: text, factsUsed, incomingText }, { knowledge, ...guards })

test('a reply without facts passes only when it just asks: a question, nothing concrete, no yes up front', () => {
  for (const text of ['Halo Kak, mau pesan apa, berapa banyak, dan untuk tanggal berapa?', 'Maaf Kak, boleh dijelaskan maksudnya?', 'Hi! What would you like to order?']) {
    assert.deepEqual(reply(text, []), { ok: true, reasons: [] }, text)
  }
  for (const text of ['Siap Kak 🙏', 'Bisa kak, mau dikirim ke mana?', 'Boleh kak, mau pesan apa?', 'Mau diambil besok kak?', 'Buka Senin–Sabtu ya kak?',
    'Mau pesan 2 loyang kak?', 'Harganya Rp 85.000, mau pesan?', 'Cek di contoh.com ya kak?', 'Halo Kak, ada diskon lho, mau?']) {
    assert.ok(!reply(text, []).ok, text)
  }
})

test('a thanks-back without facts never passes: it is only ever drafted', () => {
  for (const [incoming, text] of [
    ['ok makasih kak 🙏', 'Sama-sama, Kak 🙏'],
    ['thanks!', "You're welcome! Have a nice day."],
    ['🙏', 'Terima kasih juga, Kak ❤️'],
    [undefined, 'Sama-sama Kak']
  ]) {
    assert.deepEqual(reply(text, [], incoming), { ok: false, reasons: ['no_facts_used'] }, `${incoming} → ${text}`)
    assert.deepEqual(reply(text, undefined, incoming).reasons, ['no_facts_used'], 'facts_used missing')
  }
  // Ordinary answers open with a plain thanks.
  assert.deepEqual(reply('Terima kasih sudah menghubungi kami, Kak. Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', ['F1']), { ok: true, reasons: [] })
  assert.deepEqual(reply('Thanks for asking! We are at Jl. Contoh Raya No. 12, Coblong, Bandung.', ['F2']), { ok: true, reasons: [] })
})

const THANKS_EXAMPLES = ['ok makasih kak 🙏', 'makasih banyak ya kak', 'Terima kasih', 'terimakasih kak', 'thank you very much', 'thanks a lot!',
  'thank you too', 'thanks, you too!', 'sama-sama kak', "you're welcome", 'Terima kasih kembali kak ❤️', 'bye, thanks', 'good bye',
  'dadah kak', 'take care', 'good night kak', 'have a nice day kak', 'semoga harinya menyenangkan ya kak', 'makasih kak, sehat selalu',
  'siap kak, terima kasih', 'iya makasih ya kak', 'Great, thanks!', 'ok makasih kak 👍', 'makasih:)', 'mksh kak ^^', 'thx', 'tq kak',
  'wah makasih banyak kak 🙏', 'oh ok, makasih kak', 'cheers', 'makasih infonya kak', 'thanks for the help', '  Makasih  Kak!!  ',
  // friendly emoji alone, with skin tones and presentation selectors
  '🙏', '🙏🏽', '🙏🙏🙏', '❤️', '😊', '🥰 🙏']

test('isThanks: a thanks or goodbye, with acknowledgements, honorifics and friendly emoji around it', () => {
  for (const text of THANKS_EXAMPLES) assert.equal(isThanks(text), true, text)
})

test('isThanks: an acknowledgement or 👍 alone, a greeting, a question, digits or any other symbol is no thanks', () => {
  for (const text of [
    // acknowledgements alone can be a yes to something our side asked
    'ok', 'oke kak', 'iya kak', 'siap', 'siap kak', 'baik kak', 'noted', 'yes', 'ya kak', 'sip 👌', '👍', '👍👍', '🙏👍', 'ok 🙏', '🙏 kak',
    // greetings open a conversation, alone or next to a thanks
    'Selamat pagi kak', 'halo kak', 'hai', 'hello', 'hi', 'good morning', 'Pagi kak 🙏', 'makasih kak, selamat siang', 'halo, thanks',
    // phrases that agree to, arrange or ask for something
    'no problem kak', 'no worries', 'anytime', 'welcome', 'my pleasure', 'happy to help', 'you too', 'see you', 'see you soon',
    'sampai jumpa lagi kak', 'hati-hati ya kak', 'makasih lagi dong', 'makasih kak, ditunggu ya', 'thanks, besok ya', 'ok kak sore ya',
    'no thanks', 'wow thanks',
    // friendly words out of their phrase, angry or other emoji, bare punctuation, symbols, digits, questions
    'no good', 'oh no', 'too much', 'so bad', 'kak', 'wah', '😡', '😡😡', '👎', '💩', 'makasih kak 😡', '🔥', '!!!', '...', '', ' ',
    'ok :(', 'ok -_-', 'T_T', 'makasih *kak*', 'ok kak :/', ':)', 'makasih 2 ya', 'sama2 kak', 'makasih kak?', 'thanks¿', '٣ makasih',
    'makasih kak, saya sudah transfer', 'thanks, is it open?', undefined, null
  ]) {
    assert.equal(isThanks(text), false, String(text))
  }
})

test('isThanks: a long message is no thanks and costs little to reject', () => {
  assert.equal(isThanks('good bye '.repeat(8)), true, '16 words may still be a thanks')
  assert.equal(isThanks('good bye '.repeat(8) + 'kak'), false, '17 are not')
  assert.equal(isThanks('🙏'.repeat(17)), false)
  // A recursive split was exponential on "good bye" × n + "x".
  const adversarial = ['good bye '.repeat(5000) + 'x', 'makasih '.repeat(5000), 'ok '.repeat(20000), 'ok '.repeat(12000) + 'tolong refund ke rekening saya',
    'good bye '.repeat(7) + 'x', 'good bye '.repeat(14) + 'x', '🙏'.repeat(20000), 'hehe '.repeat(13000), 'makasih kak :D '.repeat(4300)]
  const started = performance.now()
  for (let round = 0; round < 50; round++) {
    for (const text of adversarial) assert.equal(isThanks(text), false, `${text.length} chars`)
  }
  assert.ok(performance.now() - started < 1000, `isThanks: ${Math.round(performance.now() - started)} ms`)
})

test('thanksAgrees: a thanks that reads as one only with an acknowledgement or 👍 may be a yes (skip-safety-r3-2)', () => {
  for (const text of ['iya kak makasih', '👍 makasih kak', 'ok siap, makasih', 'perfect, thanks', 'Great, thanks!', 'ok makasih kak', 'oh ok, makasih kak', 'makasih kak 👌']) {
    assert.deepEqual([isThanks(text), thanksAgrees(text)], [true, true], text)
  }
  // A "ya" before the thanks says yes (skip-safety-r1-1); after it, it only softens.
  for (const text of ['ya makasih', 'ya kak, makasih', 'yaa makasih', 'ya deh makasih kak', 'Ya, terima kasih banyak kak', 'ya thanks', 'ya\nmakasih kak', 'oh ya, makasih']) {
    assert.deepEqual([isThanks(text), thanksAgrees(text)], [true, true], text)
  }
  for (const text of ['makasih kak 🙏', 'makasih ya kak', 'terima kasih ya', 'makasih kak, sehat selalu ya', 'good bye', 'thanks, you too!', 'have a nice day kak', '🙏', 'wah makasih banyak kak']) {
    assert.deepEqual([isThanks(text), thanksAgrees(text)], [true, false], text)
  }
  for (const text of ['iya kak', '👍', 'jam buka?', undefined]) assert.equal(thanksAgrees(text), false, String(text))
})

// Owner decision 2026-09-27: only an answer to a message that asks something may be auto-sent (policy.js).
const ASKS = ['Halo kak, tokonya buka jam berapa aja ya?', "Hi! Where is your shop located? I'd like to pick up my order.",
  'Kak, brownies panggang harganya berapa ya?', 'jam berapa buka kak', 'alamatnya dimana', 'di mana tokonya', 'where are you located',
  'what time do you open', 'how much is the brownie', 'is it open on sunday', 'I would like the address', 'tell me the price',
  'makasih kak, jam berapa tutup?', 'makasih bang, buka jam berapa', 'jam buka kak？', 'jam ber\u200bapa buka', 'kok belum sampai kak?', 'bisakah dikirim hari ini',
  'mau tanya kak', 'info harga dong kak', 'kak info', 'can you deliver tomorrow',
  // a request word with something to request, not after "saya" or "I"
  'bisa kirim ke Bekasi', 'kirim besok bisa', 'boleh minta alamatnya', 'minta alamatnya kak, makasih', 'tolong kirim besok ya', 'please send the menu',
  // a tag question at the end of a clause, honorifics and particles after it
  'tokonya buka gak kak', 'ready ga', 'masih ada nggak', 'sudah dikirim belum kak', 'buka hari minggu kan ya', 'buka gak, makasih kak',
  // a burst asks if one of its messages does
  'ok makasih kak\njam berapa tutup']
const ASKS_NOTHING = ['iya kak', 'ok', '👍', 'makasih bang', 'sama2 kak', 'Sama2 kak, makasih juga 🙏', 'gapapa', 'gpp kak', 'betul', 'iya kak betul',
  'saya tunggu', 'Oke kak siap, saya tunggu 🙏', 'ok kk', 'siap bos', 'saya mau ambil besok', 'ok kak nanti saya ke sana', 'makasih infonya kak',
  'makasih info nya kak', 'thanks for the info', 'ok makasih kak 🙏', 'Makasih kak, semangat', 'thanks so much, have a good one', 'Selamat pagi kak',
  '👍 besok ya', 'makasih kak, ditunggu ya', 'thanks, see you!', 'no problem kak', 'iya kak hehe', 'oke kak :D', 'Terima kasih atas bantuannya',
  // a request word that only says yes, or a statement after "saya" or "I"
  'boleh kak', 'bisa kak', 'ada kak', 'iya boleh kak', 'tolong ya kak', 'Yes please', 'bisa kak, saya ambil besok', 'saya bisa ambil besok',
  'I can come at 5', 'minta maaf kak', 'mohon maaf ya kak',
  // no tag question: a negation alone, after "saya", or not at the end; "apa" reduplicated or after a negation
  'belum kak', 'gak kak', 'saya belum', 'ga usah kak', 'nggak apa-apa kak', 'ga apa2 kak', 'gak apa kak', 'kapan-kapan mampir kak',
  '', '...', undefined, null]

test('asksSomething: a question mark, a question word, a request with something to request, or a tag question', () => {
  for (const text of ASKS) assert.equal(asksSomething(text), true, text)
  for (const text of ASKS_NOTHING) assert.equal(asksSomething(text), false, String(text))
})

test('asksSomething: no thanks asks anything, so a thanks is never auto-answered', () => {
  for (const text of THANKS_EXAMPLES) assert.equal(asksSomething(text), false, text)
})

test('"kok" stresses a statement: a yes or a thanks with it asks nothing (send-path-r1-1)', () => {
  for (const text of ['bisa kok kak', 'boleh kok kak', 'boleh kok', 'ada kok', 'iya kok kak', 'gapapa kok kak', 'udah sampai kok kak, makasih',
    'makasih kak, mantap kok', 'kok belum sampai kak']) { // a missed question only costs a draft
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['kok belum sampai kak?', 'kok belum sampai, kapan dikirim kak']) assert.equal(asksSomething(text), true, text)
})

test('"no problem" after a negation asks nothing, however it is spelled (send-path-r1-2)', () => {
  for (const text of ['ga napa kak', 'gak knp kak', 'ok kak, nggak knp', 'nggak kenapa kak', 'tidak mengapa kak', 'tdk mengapa', 'nggak kenapa-napa kak',
    'gak ngapain kak']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['kenapa belum sampai', 'knp belum dikirim kak', 'mengapa pesanan saya dibatalkan', 'ga jadi, kenapa ya']) assert.equal(asksSomething(text), true, text)
})

test('a shared link is not a question: its query string and path are left out (send-path-r1-3)', () => {
  for (const text of ['Kak kirim ke sini ya https://maps.app.goo.gl/AbC123xyz?g_st=iw', 'ok makasih kak https://maps.app.goo.gl/AbC123xyz?g_st=iw',
    'Kak aku mau yang ini https://shopee.co.id/product/123?smtt=0.0.9', 'https://www.instagram.com/p/xyz/?igsh=abc', 'ini kak maps.app.goo.gl/AbC?g_st=iw',
    'www.tokopedia.com/toko/apa-aja?extParam=1', 'ini alamatnya (https://maps.app.goo.gl/AbC?g_st=iw)',
    'boleh kak.kirim besok']) { // a bare "kak.kirim" is a missing space, not a link: its clauses stay apart
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['jam berapa buka? https://x.co/a?b=1', 'ini ready gak kak shopee.co.id/product/123?smtt=0', 'https://shopee.co.id/p/1 yang ini ada?']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('a no asks nothing: a request word right after a negation says no (send-path-r2-1)', () => {
  for (const text of ['Makasih kak, ga ada lagi kok', 'tidak ada, terima kasih', 'gak ada kak, makasih', 'nggak ada kak, makasih banyak',
    'tidak ada lagi, terima kasih banyak', 'ga ada pertanyaan lagi kak makasih', 'makasih kak udah dibantu, ga ada lagi', 'udah ga ada kak makasih',
    'gak bisa kak', 'tidak bisa kak', 'nggak ada', 'ga ada kak', 'gak ada', 'gakk ada kak', 'belum bisa kak', 'belum ada kak']) {
    assert.equal(asksSomething(text), false, text)
  }
  // a real "no, can't …?" still has its "?" or its tag
  for (const text of ['gak bisa kirim hari ini ya kak?', 'ga ada yang ukuran kecil kak?', 'masih ada nggak', 'bisa kirim ke Bekasi gak']) assert.equal(asksSomething(text), true, text)
})

test('an emphatic or English yes asks nothing: intensifiers are nothing to request, an English modal asks before its subject (send-path-r2-2)', () => {
  for (const text of ['boleh banget kak', 'boleh bangettt kak', 'bisa bgt', 'boleh bgt kak', 'iya boleh bgt kak makasih', 'wah bisa banget kak, makasih',
    'tentu bisa kak', 'pasti bisa', 'bisa sekali', 'udah bisa kak makasih', 'masih ada kak makasih',
    'that would be great, thanks', 'yes, that would be lovely', 'that would be perfect, thank you', 'yes please do', 'please go ahead', 'can do',
    'sure you can', 'would love that', 'I would like that']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['can you deliver tomorrow', 'could I pay by transfer', 'would it be possible to deliver', 'can u send the menu', 'please send the menu',
    'I would like the address', 'masih bisa pesan untuk besok', 'udah belum kak', 'bisa banget dikirim hari ini kak']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('an English question phrase asks only at the start of a clause; a relative, an exclamation or the customer\'s own plan asks nothing (send-path-r2-3)', () => {
  for (const text of ['thank you, that is it', 'ok that is it for now, thanks', 'I would like to thank you for the fast delivery', "Thanks, that's what I needed",
    'perfect, thats exactly what I was looking for, thanks', 'that is what I needed', 'thanks, I know where it is', "I'll let you know when I'm there",
    'ok kak nanti saya kabari kapan ambilnya', 'makasih kak, nanti saya kabari mau yang mana', 'oke kak, saya pikir-pikir dulu mau yang mana',
    'iya kak nanti saya kasih tau berapa loyang', 'makasih kak, nanti saya info lagi', 'siap kak, info diterima', 'terserah kak apa aja', 'apa aja boleh',
    'kapan aja bisa kak', 'how lovely', 'how nice of you', 'wow thanks, how fast', 'why not, thanks']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['is it open on sunday', 'hi do you deliver to Bekasi', 'ok is it open sunday', 'thanks, are you open tomorrow', 'have you got brownies',
    'tell me the price', 'I want to know when you open', 'saya mau tau jam berapa buka', 'saya mau info harganya', 'saya belum dapat info kapan dikirim',
    'kak saya mau order brownies harganya berapa ya', 'menunya apa aja kak', 'apa aja kak', 'how much is it', 'how long is delivery', 'why not open on sunday']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('an apology for asking, a "maybe" or leaving it to us asks nothing: "tanya" asks only as a request to ask (send-path-r3-1)', () => {
  for (const text of ['makasih kak, maaf ya banyak tanya', 'Makasih kak, maaf banyak nanya 🙏', 'makasih kak udah jawab, maaf nanya terus',
    'oke kak, nanti saya tanya lagi', 'nanti saya tanya suami dulu mau yang mana', 'makasih kak, siapa tau nanti order lagi', 'ok kak, siapa tahu besok jadi',
    'ok kak, gimana kakak aja', 'gimana baiknya aja kak', 'iya kak, gimana enaknya aja', 'makasih kak, gimana nanti aja', 'boleh gimana kakak aja']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['mau tanya kak', 'maaf mau tanya', 'numpang tanya kak', 'boleh nanya', 'sekalian tanya kak', 'tanya dong kak', 'kak, tanya harga brownies',
    'maaf nanya lagi kak, buka jam berapa', 'siapa yang ambil kak', 'gimana kak caranya', 'pembayarannya gimana aja kak', 'gimana baiknya kak']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('the one-word "alright then" and "go ahead" words say yes: a request word with them asks nothing (send-path-r3-2)', () => {
  for (const text of ['yaudah boleh kak', 'yaudah bisa kak', 'yauda boleh', 'ywdh boleh', 'yodah bisa', 'yowes boleh kak', 'yaudahh boleh kak', 'ok gas kak boleh',
    'mangga kak boleh', 'boleh kak lanjut', 'bisa kak lanjut', 'ok kak boleh sekalian', 'yaudah deh boleh', 'yaudah ada kak', 'yaudah tolong ya kak']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['bisa kirim ke Bekasi', 'masih bisa pesan untuk besok', 'lanjut gak kak', 'yaudah bisa kirim besok']) assert.equal(asksSomething(text), true, text)
})

test('"ada" asks where it opens its clause, not in a statement or "someone will" (send-path-r3-3)', () => {
  for (const text of ['makasih kak, nanti kalau ada apa-apa saya hubungi lagi', 'makasih kak, nanti kalo ada apa2 saya chat lagi',
    'oke kak makasih, kalau ada yang kurang jelas nanti saya tanya lagi', 'iya kak, besok ada yang ambil', 'makasih kak, udah ada yang jemput',
    'makasih kak, ada teman yang ambil', 'ok kak, soalnya ada acara', 'iya kak ada yang ambil besok']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['ada brownies kak', 'kak masih ada stok coklat', 'ada yang ukuran kecil kak', 'ga ada yang ukuran kecil kak?', 'masih ada nggak',
    'halo kak, ada kue ulang tahun']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('an English exclamation, relative or the customer\'s own plan asks nothing (send-path-r3-4)', () => {
  for (const text of ['thanks, what a lovely cake', 'wow, what a beautiful cake, thank you!', 'thanks, what a great service', 'thanks for what you did',
    'I love what you made, thank you', 'thanks, I will pay when I pick up', 'ok, I will transfer when I get home', "ok, I'll transfer when I get home",
    'thanks, I will come by when I can', "I'm going to pay when I pick up", "we'll come when it's ready", 'thanks, my brother is the one who will pick it up',
    'thanks, see you when I see you']) {
    assert.equal(asksSomething(text), false, text)
  }
  for (const text of ['when do you open', 'thanks, when do you close', 'what time do you open', 'I want to know when you open', 'what is the price',
    'which one is cheaper', 'can you tell me when you open']) {
    assert.equal(asksSomething(text), true, text)
  }
})

test('"let me know …" asks: three-word phrases are looked up too (consistency-r2-2)', () => {
  for (const text of ['let me know your opening hours', 'let me know the price kak', 'ok, let me know']) assert.equal(asksSomething(text), true, text)
})

test('asksSomething scans a long message once', () => {
  const adversarial = ['good bye '.repeat(5000) + 'x', 'ok '.repeat(20000), 'x '.repeat(20000) + 'berapa', 'bisa boleh '.repeat(10000),
    'kak '.repeat(20000) + 'gak', 'apa '.repeat(20000), 'buka gak kak, '.repeat(5000), '🙏'.repeat(20000), 'saya belum '.repeat(10000),
    // what the URL pattern of the reply checks backtracks on
    'a.'.repeat(40000), 'https://' + 'a.'.repeat(40000), 'a-'.repeat(40000) + '.1', 'x.1'.repeat(25000) + '?', 'ga napa '.repeat(10000),
    // what the clause-start, plan and "apa aja" checks look ahead or back over
    'thank you '.repeat(5000) + 'is it', 'apa aja '.repeat(5000) + 'boleh', 'saya kabari kapan '.repeat(3000), 'gak bisa '.repeat(5000),
    // what the "gimana … aja" and "I will" checks look ahead over
    'gimana kakak kakak '.repeat(5000) + 'aja', 'gimana kakak aja '.repeat(5000), 'i will '.repeat(10000) + 'when']
  const expected = [false, false, true, false, false, false, true, false, false, false, false, false, true, false, true, true, false, false,
    true, false, false]
  // One quadratic pass over one of these takes seconds; two linear rounds of all of them stay far below the budget.
  const started = performance.now()
  for (let round = 0; round < 2; round++) {
    for (const [index, text] of adversarial.entries()) assert.equal(asksSomething(text), expected[index], `${index}: ${text.length} chars`)
  }
  assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`)
})

test('a sensitive term that appears in the facts is allowed', () => {
  const custom = parseKnowledge('## Facts\n- [F1] Gratis ongkir area Coblong.\n')
  assert.equal(checkReply({ reply: 'Gratis ongkir untuk Coblong ya', factsUsed: ['F1'] }, { knowledge: custom, sensitiveTerms: ['gratis'] }).ok, true)
})

test('language detection and the mirror-language guard', () => {
  assert.equal(detectLanguage("Hi! Where is your shop located? I'd like to pick up my order."), 'en')
  assert.equal(detectLanguage('Halo kak, tokonya buka jam berapa aja ya?'), 'id')
  assert.equal(detectLanguage('ok 👍'), 'unknown')
  const indonesianReply = 'Kak, kami berada di Jl. Contoh Raya No. 12, Coblong, Bandung. Ini dapur rumahan untuk pengambilan pesanan.'
  const mismatch = checkReply({ reply: indonesianReply, factsUsed: ['F2'], incomingText: "Hi! Where is your shop located? I'd like to pick up my order." }, { knowledge })
  assert.deepEqual(mismatch.reasons, ['language_mismatch:en->id'])
  assert.equal(checkReply({ reply: indonesianReply, factsUsed: ['F2'], incomingText: 'Alamatnya di mana ya kak?' }, { knowledge }).ok, true)
  assert.equal(checkReply({ reply: 'Hi Kak! We are at Jl. Contoh Raya No. 12, Coblong, Bandung.', factsUsed: ['F2'], incomingText: 'Where is the shop?' }, { knowledge }).ok, true)
})

test('guardTriage only checks answers', () => {
  const config = makeConfig()
  assert.equal(guardTriage({ decision: 'escalate', reply: 'Rp 1' }, { knowledge, config }), undefined)
  assert.equal(guardTriage({ decision: 'answer', reply: 'Rp 1', facts_used: ['F5'] }, { knowledge, config }).ok, false)
  assert.deepEqual(guardTriage({ decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: [] }, { knowledge, config, incomingText: 'ok makasih kak 🙏' }).reasons, ['no_facts_used'])
})

test('replies that carry the owner\'s account or machine details are held; drafts are flagged', () => {
  const config = makeConfig({ guards: { ownerIdentifiers: ['jane.doe@example-shop.co.id'] } }, '/home/janed/app/data')
  const identifiers = privateIdentifiers({ ...config, rootDir: '/home/janed/app' }, { username: 'janed', home: '/home/janed' })
  const held = reply => checkReply({ reply, factsUsed: ['F1'] }, { knowledge, ...guards, privateIdentifiers: identifiers }).reasons
  for (const reply of [
    'Kami buka pukul 08.00–17.00 WIB. Admin: jane.doe [at] example-shop [dot] co [dot] id',
    'Kami buka pukul 08.00–17.00 WIB, hubungi j a n e d o e ya.',
    'Kami buka pukul 08.00–17.00 WIB, data di /home/janed/app/data ya.',
    'Kami buka pukul 08.00–17.00 WIB, admin kami janed.'
  ]) assert.ok(held(reply).includes('private_detail'), reply)
  assert.deepEqual(held('Halo Kak Jane, kami buka pukul 08.00–17.00 WIB, shop kecil ya.'), [], 'parts of the identifiers are not identifiers')
  assert.deepEqual(findPrivateDetails('Kirim ke jane.doe@example-shop.co.id', identifiers), ['janedoe', 'exampleshop'])
  assert.ok(privateIdentifiersFor(config).paths.includes('/home/janed/app/data'), 'guardTriage builds them from the config')
})

test('isLooseThanks: a thanks in a chat spelling too, for the placeholder; nothing more than a thanks', () => {
  for (const text of [...THANKS_EXAMPLES, 'makasih bgt kak 🙏', 'makasiih kak', 'trimakasih kak', 'thank u', 'okee makasiii kak', 'matur nuwun kak',
    'suwun kak', 'hatur nuhun', 'makasih bang', 'thankss a lot', 'mks ya kak']) {
    assert.equal(isLooseThanks(text), true, text)
  }
  for (const text of ['Terima kasih kak, sudah saya transfer', 'makasih kak, bisa kirim besok?', 'thank u, mau pesan 2 loyang', 'oke kak', 'siap kak',
    'matur kak', 'bgt', 'u', 'Selamat pagi kak', '😡😡', `${'makasih bgt '.repeat(30)}`]) {
    assert.equal(isLooseThanks(text), false, text)
  }
})

test('isLooseThanks: a greeting or a well-wish around a thanks, and kk, kaka, kang or teh, still only thank; a greeting alone does not (send-path-r1-2, correctness-r1-2)', () => {
  for (const text of ['makasih kak, selamat siang', 'makasih kak, selamat siang 🙏', 'terima kasih kak, selamat malam 🙏', 'siang kak, makasih ya',
    'pagi kak makasih', 'makasih kak, met siang', 'makasih kak, salam', 'makasih kak, wassalam', 'makasih ya kak, sukses selalu',
    'makasih kak, selamat beraktivitas', 'Halo kak, makasih ya', 'Thank you, good afternoon', 'makasih bgt, have a good day',
    'makasih kk 🙏', 'makasih kaka', 'hatur nuhun kang', 'nuhun teh']) {
    assert.equal(isThanks(text), false, `${text}: the skip stays narrow`)
    assert.equal(isLooseThanks(text), true, text)
  }
  assert.equal(isLooseThanks('thanks, have a good evening'), true, '"good evening" as a greeting does not break up "have a good evening"')
  // The owner's decision (2026-09-27): a customer's greeting alone waits for a reply, so it must not read as a thanks.
  for (const text of ['Selamat pagi kak', 'Selamat siang', 'Pagi kak', 'Halo kak', 'Hai', 'Hi!', 'good morning', 'selamat', 'makasih kak, selamat',
    'semangat kak', 'sukses selalu kak', 'salam kenal kak, mau tanya', 'kk', 'makasih kak, selamat pagi, mau pesan 2 ya']) {
    assert.equal(isLooseThanks(text), false, text)
  }
})

test('isLooseThanks: a thanks with what it is for, a laugh or a done "dibantu" is still only a thanks (send-path-r2-1)', () => {
  for (const text of ['mkasih kak', 'hehe makasih kak', 'wkwk makasih kak', 'hahaha thank u', 'makasih kak udah dibantu 🙏', 'makasih kak sudah dibantu',
    'makasih udah dibantu', 'makasih sudah membantu kak', 'makasih kak udah dijawab', 'makasih atas infonya kak', 'makasih kak atas infonya',
    'terima kasih atas bantuannya', 'terima kasih untuk informasinya', 'thanku kak']) {
    assert.equal(isThanks(text), false, `${text}: the skip stays narrow`)
    assert.equal(isLooseThanks(text), true, text)
  }
  for (const text of ['makasih kak, atas nama Dewi ya', 'makasih, dibalas ya kak', 'makasih kak udah sampai', 'makasih kak udah saya bayar',
    'makasih kak udah', 'sudah dibantu', 'hehe', 'hehe ok kak', 'untuk besok kak makasih', 'ok kak', 'siap kak ditunggu', 'Halo kak']) {
    assert.equal(isLooseThanks(text), false, text)
  }
})

test('isLooseThanks: a "2" repeat, any emoji, "y", "bnyk", "tysm" and what the thanks is for still only thank (send-path-r2-4, correctness-r2-2)', () => {
  for (const text of ['sama2', 'sama2 kak', 'makasih kak, sehat2 selalu 🙏', 'makasih kak sehat2 ya', 'makasih kak 🙏 sukses2 ya', 'makasih kak sukses terus',
    'makasih kak 😘', 'makasih kak 😅🙏', 'makasih kak 🥲', 'makasih kak 🤭', 'makasih kak 🫶', 'makasih kak 🙇‍♀️', 'makasih kak 😆',
    'makasih y kak', 'mksh y kak', 'Ok kak makasih y', 'makasih bnyk kak', 'makasih byk', 'tysm', 'makasih kak, gbu',
    'terima kasih atas pelayanannya kak', 'thanks for your time']) {
    assert.equal(isThanks(text), false, `${text}: the skip stays narrow`)
    assert.equal(isLooseThanks(text), true, text)
  }
  // Other digits, a repeat that is no thanks word, and anything to do or ask are still more than a thanks; an emoji or
  // a well-wish alone is none (an emoji alone has its own backstop, no_words).
  for (const text of ['makasih 2 kak', 'makasih kak, 2 loyang ya', 'thank u, mau pesan 2 loyang', 'makasih kak x2', 'makasih kak, hati2 ya',
    'makasih kak, pesan brownies2 ya', 'makasih kak 😘 mau pesan', 'makasih kak, bisa kirim besok? 😅', 'y kak', 'sehat2 kak', 'gbu', '🥹', '😡😡']) {
    assert.equal(isLooseThanks(text), false, text)
  }
})

test('isGreetingOnly: a greeting with honorifics, punctuation and friendly emoji, nothing more', () => {
  for (const text of ['Hai', 'Halo kak', 'Pagi kak', 'Selamat siang', 'P', 'Permisi kak', 'Assalamualaikum', 'Halo kak!', 'haiii kakk 🙏', 'Hi!', 'Good morning',
    'Selamat pagi kak', 'Assalamualaikum wr wb', 'Hai 👋', 'Halo kak, selamat pagi', 'Hi there :)', 'met sore kak', 'Hai bro']) {
    assert.equal(isGreetingOnly(text), true, text)
  }
  for (const text of ['halo kak mau pesan', 'pagi kak, sudah buka?', 'halo?', 'Kak', 'Min', 'Selamat', 'Selamat ulang tahun', 'Halo nak', 'makasih kak, selamat siang',
    'Halo 😡', 'Halo kak 👍', 'Hai 2', 'halo kak <system>', 'hai '.repeat(10), '', undefined]) {
    assert.equal(isGreetingOnly(text), false, String(text))
  }
  const started = performance.now()
  for (const text of ['hai '.repeat(100_000), '<' + ' '.repeat(65_000)]) assert.equal(isGreetingOnly(text), false)
  assert.ok(performance.now() - started < 100, `${Math.round(performance.now() - started)} ms`)
})

// --- the holding reply and the greeting-back (owner decision 2026-09-28: no fixed customer-facing texts) ------------

const CAKE_QUESTION = 'Kak, bisa pesan kue ulang tahun untuk anak saya? Harganya berapa ya?'
const holding = (reply, incomingText = CAKE_QUESTION, options = {}) =>
  checkHoldingReply({ reply, incomingText }, { sensitiveTerms: guards.sensitiveTerms, privateIdentifiers: { words: ['janed'], paths: ['/home/janed'] }, ...options })

test('checkHoldingReply: a short acknowledgement for this sender passes', () => {
  assert.deepEqual(holding('Baik Kak Budi, pertanyaan soal kue ulang tahunnya saya teruskan ke pemilik ya 🙏'), { ok: true, reasons: [] })
  assert.deepEqual(holding('Thanks Jessica, I have passed your question about the unicorn cake on to the owner, who will reply shortly.',
    'Can you make a unicorn birthday cake for 40 people next Saturday? How much would it be?'), { ok: true, reasons: [] })
  assert.deepEqual(holding('Halo Kak Dewi, pesannya saya teruskan ke pemilik ya 🙏', 'Selamat pagi kak'), { ok: true, reasons: [] }, 'a greeting too short to tell its language')
})

test('checkHoldingReply: anything concrete, a yes, another language, nothing or too much is withheld', () => {
  const cases = [
    ['Baik Kak Budi, tart ulang tahun Rp 250.000 ya, saya teruskan ke pemilik', ['concrete:amounts']],
    ['Baik Kak Budi, besok pemilik balas ya 🙏', ['concrete:day']],
    ['Siap Kak Budi, pertanyaannya saya teruskan ke pemilik ya 🙏', ['yes_opening']],
    ['Baik Kak Budi, lihat katalognya di dapurkue.id ya, saya teruskan ke pemilik', ['concrete:urls']],
    ['Baik Kak Budi, pemilik balas dalam satu jam ya', ['concrete:numberWords']],
    ['Thanks Budi, I have passed your question about the birthday cake on to the owner.', ['language_mismatch:id->en']],
    ['Baik Kak Budi, soal diskonnya saya teruskan ke pemilik ya', ['sensitive_term:diskon']],
    ['Baik Kak Budi, janed akan membalas ya', ['private_detail']],
    ['Baik Kak [NAMA], pertanyaannya saya teruskan ke pemilik ya', ['placeholder']],
    ['Baik Kak Budi, soal [F8] saya teruskan ke pemilik ya', ['fact_id_in_reply', 'concrete:numbers']],
    ['', ['empty']],
    ['   ', ['empty']],
    [undefined, ['empty']],
    ['""', ['no_words']], // Sonnet's "no holding reply" once (eval 2026-09-28)
    ['🙏', ['no_words']],
    [`Baik Kak Budi, ${'pertanyaan soal kue ulang tahunnya '.repeat(6)}saya teruskan ke pemilik ya`, ['too_long:252>200']]
  ]
  for (const [reply, reasons] of cases) assert.deepEqual(holding(reply), { ok: false, reasons }, String(reply))
})

// holding-reply-safety-r1-2: it goes out before the owner has checked the bank (knowledge.md: never confirm a payment).
test('checkHoldingReply: a payment or order status claim is withheld; a thanks for the message or a forward is not one', () => {
  const PAID = 'kak saya sudah transfer ya buat pesanan brownies'
  for (const reply of ['Baik Kak Budi, pembayarannya sudah kami terima, pemilik akan cek ya 🙏', 'Baik Kak Budi, pesanannya sudah kami catat dan akan dikirim ya 🙏',
    'Baik Kak Budi, pembayarannya masuk ya 🙏', 'Terima kasih Kak Budi, konfirmasi transfernya sudah kami terima, pemilik akan segera cek ya 🙏',
    'Baik Kak Budi, brownies-nya siap diambil ya, saya teruskan ke pemilik 🙏']) {
    assert.deepEqual(holding(reply, PAID), { ok: false, reasons: ['status_claim'] }, reply)
  }
  assert.deepEqual(holding('Thanks Budi, your payment has been received and the owner will confirm shortly.', 'hi i already transferred for my brownies order'),
    { ok: false, reasons: ['status_claim'] })
  for (const reply of ['Terima kasih Kak Budi, soal pembayarannya saya teruskan ke pemilik untuk dicek ya 🙏', 'Makasih udah transfer Kak Budi, pemilik akan segera cek ya 🙏',
    'Baik Kak Budi, konfirmasi transfernya sudah saya teruskan ke pemilik ya 🙏', 'Pagi Kak Dewi, terima kasih sudah menyapa, ada yang bisa dibantu ya 🙏']) {
    assert.deepEqual(holding(reply, PAID), { ok: true, reasons: [] }, reply)
  }
})

// holding-reply-safety-r1-3: a follow-up time with no digit and no day name is still a promise.
test('checkHoldingReply: a part of a day, a vague span or a month is concrete; a greeting\'s "pagi" and a name like Mei are not', () => {
  const CUSTOM = 'kak mau pesan kue ulang tahun custom'
  for (const when of ['nanti sore', 'sore ini', 'nanti malam', 'setelah maghrib', 'dalam beberapa menit', 'akhir pekan ini', 'minggu ini', 'awal Mei']) {
    assert.deepEqual(holding(`Baik Kak Budi, soal kue custom-nya pemilik akan membalas ${when} ya 🙏`, CUSTOM), { ok: false, reasons: ['concrete:day'] }, when)
  }
  for (const when of ['this afternoon', 'over the weekend', 'in a few hours', 'within an hour']) {
    assert.deepEqual(holding(`Thanks Budi, the owner will get back to you about the custom cake ${when}.`, 'can i order a custom birthday cake?'),
      { ok: false, reasons: ['concrete:day'] }, when)
  }
  for (const reply of ['Selamat pagi Kak Mei, soal kue custom-nya saya teruskan ke pemilik ya 🙏', 'Selamat malam Kak Juli, pemilik akan segera membalas ya 🙏']) {
    assert.deepEqual(holding(reply, CUSTOM), { ok: true, reasons: [] }, reply)
  }
  assert.deepEqual(guardGreeting({ decision: 'escalate', reply: 'Pagi Kak, pemilik akan membalas nanti sore, ada yang bisa dibantu?', facts_used: [] },
    { knowledge, config: makeConfig(), incomingText: 'Pagi kak' }).reasons, ['no_facts_used'])
})

// holding-reply-safety-r1-4: "Sip" reads as "OK, can do" to a question the owner has not answered.
test('checkHoldingReply: chat yeses and stretched spellings up front are a yes; "Baik" is not', () => {
  const BOGOR = 'kak bisa kirim ke Bogor?'
  for (const opening of ['Sip', 'Sipp', 'Siapp', 'Okee', 'Bisaa', 'Iyaa', 'Noted', 'Beres']) {
    assert.deepEqual(holding(`${opening} Kak Budi, soal pengiriman ke Bogor saya teruskan ke pemilik ya 🙏`, BOGOR), { ok: false, reasons: ['yes_opening'] }, opening)
  }
  for (const opening of ['Yup', 'Yep', 'Of course', 'Absolutely']) {
    assert.deepEqual(holding(`${opening} Budi, I have passed your question about delivery to Bogor on to the owner.`, 'can you deliver to Bogor?'),
      { ok: false, reasons: ['yes_opening'] }, opening)
  }
  assert.deepEqual(holding('Baik Kak Budi, soal pengiriman ke Bogor saya teruskan ke pemilik ya 🙏', BOGOR), { ok: true, reasons: [] })
})

test('guardHolding reads holding_reply from any triage, "" when missing; guardGreeting only checks a greeting alone, against no fact', () => {
  const config = makeConfig()
  assert.equal(guardHolding(undefined, { config, incomingText: 'x' }), undefined)
  assert.deepEqual(guardHolding({ decision: 'escalate', holding_reply: 5 }, { config, incomingText: CAKE_QUESTION }), { ok: false, reasons: ['empty'] })
  assert.deepEqual(guardHolding({ decision: 'answer', holding_reply: 'Baik Kak Budi, pertanyaannya saya teruskan ke pemilik ya 🙏' }, { config, incomingText: CAKE_QUESTION }), { ok: true, reasons: [] })
  const greeting = reply => guardGreeting({ decision: 'escalate', reply, facts_used: ['F1'] }, { knowledge, config, incomingText: 'Selamat pagi kak' })
  assert.equal(guardGreeting({ decision: 'escalate', reply: 'Halo Kak, ada yang bisa dibantu?' }, { knowledge, config, incomingText: 'halo kak mau pesan' }), undefined)
  assert.deepEqual(greeting('Selamat pagi Kak Dewi, ada yang bisa dibantu?'), { ok: true, reasons: [] })
  assert.deepEqual(greeting('Selamat pagi Kak Dewi 🙏').reasons, ['no_facts_used'], 'no question')
  assert.deepEqual(greeting('Siap Kak Dewi, mau pesan apa?').reasons, ['no_facts_used'], 'a yes up front')
  assert.deepEqual(greeting('Pagi Kak, kami buka 08.00–17.00, mau pesan apa?').reasons, ['no_facts_used', 'unsupported_time:8:00,17:00'], 'a cited fact licenses nothing here')
  assert.deepEqual(greeting(`Selamat pagi Kak Dewi, ${'ada yang bisa dibantu, '.repeat(8)}ya?`).reasons, ['too_long:210>200', 'too_many_words:37>12'])
})

// holding-reply-safety-r1-1: Claude sees yesterday's order in the history; its greeting-back must still only greet and ask.
test('guardGreeting: a status claim, a question that is not last or more than 12 words is no greeting-back', () => {
  const config = makeConfig()
  const greeting = reply => guardGreeting({ decision: 'escalate', reply, facts_used: [] }, { knowledge, config, incomingText: 'Pagi kak' })
  for (const reply of ['Pagi juga Kak Rina, ada yang bisa dibantu?', 'Pagi juga Kak Rina, ada yang bisa dibantu? 🙏',
    'Pagi juga Kak Rina, terima kasih sudah menyapa, ada yang bisa dibantu?', 'Selamat pagi Kak Mei, mau pesan kue apa?']) {
    assert.deepEqual(greeting(reply), { ok: true, reasons: [] }, reply)
  }
  const cases = [
    ['Pagi juga Kak Rina, kuenya sudah siap ya, mau diambil kapan?', ['status_claim']],
    ['Pagi Kak Rina, pembayarannya sudah kami terima ya, ada lagi yang bisa dibantu?', ['too_many_words:13>12', 'status_claim']],
    ['Pagi Kak Rina, pesanannya dikirim ya, ada yang bisa dibantu lagi?', ['status_claim']],
    ['Pagi Kak Rina, ada yang bisa dibantu? Kuenya siap diambil', ['question_not_last', 'status_claim']],
    ['Pagi juga Kak Rina, semoga harinya menyenangkan dan lancar semua urusannya, ada yang bisa kami bantu?', ['too_many_words:16>12']]
  ]
  for (const [reply, reasons] of cases) assert.deepEqual(greeting(reply), { ok: false, reasons }, reply)
})
