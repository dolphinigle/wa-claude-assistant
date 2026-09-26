import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowList, checkReply, containsTerm, detectLanguage, extractDetails, findPrivateDetails, guardTriage, isSocialMessage, isSocialReply, privateIdentifiers, privateIdentifiersFor } from '../src/guards.js'
import { parseKnowledge } from '../src/knowledge.js'
import { knowledge, makeConfig } from './helpers.js'

const { guards } = makeConfig()
const check = (reply, factsUsed = ['F1']) => checkReply({ reply, factsUsed }, { knowledge, ...guards })

test('knowledge parsing: fact ids, facts-only section, comments stripped', () => {
  assert.deepEqual([...knowledge.facts.keys()], ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13'])
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

test('a reply without facts passes only in a purely social exchange', () => {
  const social = (reply, incomingText) => checkReply({ reply, factsUsed: [], incomingText }, { knowledge, ...guards })
  for (const [incoming, reply] of [
    ['ok makasih kak 🙏', 'Sama-sama, Kak 🙏'],
    ['Siap kak, terima kasih banyak ya', 'Terima kasih kembali, Kak. Semoga harinya menyenangkan 😊'],
    ['thanks!', "You're welcome! Have a nice day."],
    ['👍', 'Sama-sama ya Kak'],
    ['🙏🏽', 'Terima kasih juga, Kak ❤️'],
    ['bye, thanks', 'Thank you too! Take care.'],
    ['makasih kak, selamat siang', 'Sama-sama, Kak. Selamat siang 🙏'], // a greeting may go with a thanks
    ['Thank you so much :)', "You're welcome!"]
  ]) assert.deepEqual(social(reply, incoming), { ok: true, reasons: [] }, `${incoming} → ${reply}`)

  for (const [incoming, reply] of [
    ['ok makasih kak', 'Sama-sama Kak, kami kirim ke Jakarta juga ya'], // a claim without a fact
    ['ok makasih kak', 'Oke kak, siap'], // agrees to whatever was asked before
    ['bisa kirim ke Jakarta?', 'Sama-sama Kak'], // the customer asked something
    ['makasih, besok jam 9 ya', 'Sama-sama Kak'], // and set a time
    ['ok makasih kak', 'Sama-sama Kak, ditunggu jam 9 ya'],
    ['ok makasih kak', 'Sama-sama, gratis ongkir ya'],
    [undefined, 'Sama-sama Kak'], // the customer's text is not known: fail closed
    // yes-answers and promises made of friendly words
    ['makasih kak 🙏', 'Dibantu ya kak 🙏'],
    ['makasih kak', 'Ya kak, ditunggu ya 🙏'],
    ['makasih kak', 'Ya kak'],
    ['thanks', 'We have it! Have a great day.'],
    ['thanks', 'Thank you, we have it for you'],
    ['thanks', 'No problem, see you soon!'],
    ['ok kak siap', 'Ditunggu ya Kak 🙏'], // confirms a pickup nobody approved
    ['ok', 'See you soon!'],
    ['ok kak siap', 'Sampai jumpa lagi ya Kak'],
    ['makasih kak', 'Sama-sama 👍'], // 👍 agrees
    ['🙏', '👍'], // no words at all
    ['🙏', '🙏'],
    // no closing on the customer's side: angry emoji, bare punctuation, a bare honorific, a request
    ['😡', 'Sama-sama, Kak 🙏'],
    ['😡😡', 'Sama-sama ya Kak 🙏'],
    ['👎', 'Sama-sama ya Kak'],
    ['💩 💩', 'Sama-sama Kak'],
    ['makasih kak 😡', 'Sama-sama Kak'],
    ['!!!', 'Sama-sama Kak'],
    ['...', 'Sama-sama Kak'],
    ['', 'Sama-sama Kak'],
    ['kak', 'Sama-sama Kak'],
    ['dibantu ya kak', 'Sama-sama Kak'],
    ['ditunggu ya kak', 'Sama-sama Kak'],
    // a greeting alone opens a conversation, and friendly words out of their phrase complain
    ['Selamat pagi kak', 'Terima kasih, Kak. Selamat pagi 🙏'],
    ['halo kak', 'Sama-sama Kak'],
    ['Pagi kak 🙏', 'Sama-sama Kak 🙏'],
    ['too much', "You're welcome!"],
    ['no good', "You're welcome!"],
    ['ok :(', 'Sama-sama Kak']
  ]) assert.ok(social(reply, incoming).reasons.includes('no_facts_used'), `${incoming} → ${reply}`)
})

test('the customer side is matched as phrases: a greeting alone, or a friendly word out of its phrase, is no thanks', () => {
  for (const text of ['ok makasih kak 🙏', 'makasih banyak ya kak', 'thank you very much', 'thanks a lot!', 'thank you too', 'no problem kak',
    'see you soon', 'sampai jumpa lagi kak', 'hati-hati ya kak', 'oh ok kak', 'good night', 'makasih kak, selamat malam', 'Great, thanks!',
    'ok kak :)', 'makasih:)', 'mksh kak ^^', 'sip 👌', '🙏🏽', 'Terima kasih kembali kak ❤️']) {
    assert.equal(isSocialMessage(text), true, text)
  }
  for (const text of ['Selamat pagi kak', 'halo kak', 'hai', 'hello', 'good morning', 'pagi kak', 'selamat malam kak', 'Pagi kak 🙏', 'halo kak 🙏',
    'no good', 'too much', 'it was too much', 'oh no', 'no no no', 'so bad', 'wow', 'wah', 'ya kak', 'infonya kak', 'selamat ya kak',
    'ok :(', 'ok -_-', 'T_T', 'makasih *kak*', 'ok kak :/']) {
    assert.equal(isSocialMessage(text), false, text)
  }
})

test('a thanks answered with facts fails: nobody asked for them, and a fact licenses a promise', () => {
  const check = (reply, factsUsed, incomingText) => checkReply({ reply, factsUsed, incomingText }, { knowledge, ...guards })
  for (const [incoming, reply, facts] of [
    ['ok makasih kak 🙏', 'Sama-sama kak, besok kami kirim ya', ['F3']],
    ['thanks!', "Thanks! We're open now", ['F1']],
    ['makasih kak', 'Sama-sama kak, pesanannya pasti kami siapkan tepat waktu ya', ['F9']],
    ['ok kak', 'Siap kak, sudah kami catat pesanannya ya', ['F13']],
    ['makasih kak', 'Sama-sama, Kak 🙏', ['F1']]
  ]) assert.ok(check(reply, facts, incoming).reasons.includes('social_message_answered_with_facts'), `${incoming} → ${reply}`)
  assert.deepEqual(check('Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', ['F1'], 'ok kak, jam buka?'), { ok: true, reasons: [] }, 'a question with its thanks is no social message')
})

test('the customer side may acknowledge; the reply side is a closed set of closings', () => {
  assert.equal(isSocialMessage('ok kak siap 👍'), true, 'acknowledgements close the customer\'s message')
  assert.equal(isSocialReply('Oke kak, siap'), false, 'but never the reply')
  assert.equal(isSocialReply('Ya kak, sama-sama'), false, 'a leading yes is not a closing')
  assert.equal(isSocialReply('Sama-sama Kak, semoga harinya menyenangkan ya'), true, '"ya" may soften a head or a wish')
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
  assert.equal(guardTriage({ decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: [] }, { knowledge, config, incomingText: 'ok makasih kak 🙏' }).ok, true)
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
