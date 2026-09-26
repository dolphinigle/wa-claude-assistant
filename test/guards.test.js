import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowList, checkReply, containsTerm, detectLanguage, extractDetails, findPrivateDetails, guardTriage, isSocialMessage, isThanks, privateIdentifiers, privateIdentifiersFor, socialWithoutQuestion, thanksAgrees } from '../src/guards.js'
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

const reply = (text, factsUsed, incomingText) => checkReply({ reply: text, factsUsed, incomingText }, { knowledge, ...guards })

test('a reply without facts never passes, and a thanks-back is held by its own words: a thanks is only ever drafted', () => {
  for (const [incoming, text] of [
    ['ok makasih kak 🙏', 'Sama-sama, Kak 🙏'],
    ['thanks!', "You're welcome! Have a nice day."],
    ['🙏', 'Terima kasih juga, Kak ❤️'],
    [undefined, 'Sama-sama Kak']
  ]) {
    assert.deepEqual(reply(text, [], incoming), { ok: false, reasons: ['no_facts_used', 'thanks_back'] }, `${incoming} → ${text}`)
    assert.deepEqual(reply(text, undefined, incoming).reasons, ['no_facts_used', 'thanks_back'], 'facts_used missing')
  }
  // Citing a fact changes nothing, however the customer spelled the thanks: no matcher knows every spelling.
  for (const incoming of ['makasih kak', 'makasihh kak', 'tq bgt kak', 'hatur nuhun', 'makasih kak, kuenya enak banget', undefined]) {
    assert.ok(reply('Sama-sama Kak, ditunggu pesanan berikutnya ya 🙏', ['F13'], incoming).reasons.includes('thanks_back'), incoming)
  }
  for (const text of ['sama2 kak', 'Sama - sama', "You’re welcome!", 'youre welcome', 'Terima kasih kembali, Kak', 'Makasih juga kak', 'My pleasure!']) {
    assert.ok(reply(text, ['F1']).reasons.includes('thanks_back'), text)
  }
  // Ordinary answers open with a plain thanks.
  assert.deepEqual(reply('Terima kasih sudah menghubungi kami, Kak. Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', ['F1']), { ok: true, reasons: [] })
  assert.deepEqual(reply('Thanks for asking! We are at Jl. Contoh Raya No. 12, Coblong, Bandung.', ['F2']), { ok: true, reasons: [] })
})

test('the thanks-back backstop knows every thanks-back the customer side lists (send-path-r2-2)', () => {
  const hours = ' Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.'
  for (const opening of ['Senang bisa membantu, Kak!', 'Senang membantu Kak 🙏', 'Kembali kasih, Kak!', "You're very welcome!", 'You are most welcome.',
    'Your welcome kak!', 'Happy to help!', 'Glad I could help!', 'No problem!', 'No worries, Kak.', 'Anytime!']) {
    assert.deepEqual(reply(opening + hours, ['F1'], 'Terima kasih atas bantuannya'), { ok: false, reasons: ['social_message_answered_with_facts', 'thanks_back'] }, opening)
    assert.deepEqual(reply(opening + hours, ['F1']).reasons, ['thanks_back'], `${opening}, whatever the customer wrote`)
  }
  // "No problem" and "kembali kasih" only as the opening: inside an answer they mean something else.
  for (const text of ['Nanti kami kembali kasih kabar ya Kak.' + hours, 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB, no problem kalau datang sore.']) {
    assert.deepEqual(reply(text, ['F1']), { ok: true, reasons: [] }, text)
  }
})

test('an answer to a thanks, a goodbye or a yes alone is held whatever it cites: a fact there licenses a promise nobody asked for', () => {
  for (const [incoming, text, facts] of [
    ['ok kak', 'Siap kak, sudah kami catat pesanannya ya', ['F13']],
    ['iya kak', 'Baik Kak, dikirim pakai GoSend ya, ongkir dibayar pembeli.', ['F3']],
    ['oke kak 👍', 'Baik Kak, dikirim pakai GoSend ya, ongkir dibayar pembeli.', ['F3']],
    ['siap kak', 'Siap kak, besok kami kirim ya', ['F3']],
    ['👍', 'Siap kak, besok kami kirim ya', ['F3']],
    ['makasih kak, selamat siang', 'Siap kak, besok kami kirim ya', ['F3']],
    ['makasih kak, sampai jumpa', 'Siap kak, besok kami kirim ya', ['F3']],
    ['thanks, see you!', 'See you soon at our kitchen!', ['F2']],
    ['no problem kak', 'Siap kak, besok kami kirim ya', ['F3']],
    ['makasihh kakk', 'Siap kak, besok kami kirim ya', ['F3']],
    ['thank u kak', 'Siap kak, besok kami kirim ya', ['F3']],
    ['tks kak 🙏', 'Siap kak, besok kami kirim ya', ['F3']],
    ['boleh kak', 'Siap kak, besok kami kirim ya', ['F3']],
    ['makasih kak, ditunggu ya', 'Siap kak, besok kami kirim ya', ['F3']]
  ]) {
    assert.deepEqual(reply(text, facts, incoming), { ok: false, reasons: ['social_message_answered_with_facts'] }, incoming)
  }
  assert.deepEqual(reply('Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', ['F1'], 'ok kak, jam buka?'), { ok: true, reasons: [] })
  assert.deepEqual(reply('Selamat pagi Kak! Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', ['F1'], 'Selamat pagi kak'), { ok: true, reasons: [] },
    'a greeting alone is answered like any message')
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

test('isSocialMessage: every thanks, and also a goodbye or a yes alone, other spellings, and a greeting next to one', () => {
  for (const text of [...THANKS_EXAMPLES, 'ok', 'oke kak', 'iya kak', 'ya kak', 'siap kak 👍', 'sip 👌', 'noted', 'boleh kak', 'mau kak', '👍', '😡😡',
    'kak 🙏', 'makasih kak, selamat siang', 'halo, thanks', 'thanks, see you!', 'sampai jumpa lagi kak', 'no problem kak', 'anytime',
    'makasihh kakk', 'okee siapp', 'thankss', 'tks kak', 'thank u kak', 'trimakasih kak', 'hatur nuhun', 'ok kak sore ya', 'ok kak?', 'ok :(',
    'makasih kak, ditunggu ya', 'makasih 🙏🙏 mantul kak']) {
    assert.equal(isSocialMessage(text), true, text)
  }
  // A greeting alone opens a conversation; a digit or a word outside the vocabulary is content.
  for (const text of ['Selamat pagi kak', 'halo kak', 'pagi kak 🙏', 'hai 😊', 'kak', 'wah', ':)', '', '...', 'ok 2 loyang', 'dibantu kak',
    'iya kak, dikirim besok ya', 'no good', 'jam berapa buka?', 'hehe', 'hi', 'kami kembali kasih kabar', 'ok '.repeat(300) + 'tolong refund', undefined]) {
    assert.equal(isSocialMessage(text), false, String(text))
  }
})

test('isSocialMessage: laughter, text emoticons and the common ways to say yes or thanks (send-path-r2-1, consistency-r2-1)', () => {
  for (const text of ['makasih kak hehe', 'makasih kak hehe 🙏', 'iya kak hehe', 'iya kak wkwk', 'ok kak wkwkwk', 'haha oke kak makasih',
    'ahahah siap kak', 'ok lol', 'oke kak :D', 'ok kak xD', 'iya kak :D', 'ok kak :p', 'siap kak :v', 'iya kak <3', 'oke kak :3', 'ok kak :(',
    'makasih :D', 'makasih;p', 'makasih kak <3', 'Yes please', 'ya udah kak', 'yaudah kak', 'jadi kak', 'fix kak', 'oke lanjut', 'gas kak',
    'sudah kak', "thank's kak", 'thx u', 'mksi kak', 'trmksh kak', 'Terima kasih atas bantuannya', 'Terima kasih atas infonya kak',
    'makasih kak sangat membantu', 'Thanks, much appreciated!', 'senang bisa membantu kak', 'kembali kasih kak', 'your welcome']) {
    assert.equal(isSocialMessage(text), true, text)
  }
  // Everything isThanks takes is social too, smileys included: the broad matcher never knows less than the narrow one.
  for (const text of [...THANKS_EXAMPLES, 'makasih :D', 'makasih;p', 'makasih kak <3', 'makasih kak :)']) {
    if (isThanks(text)) assert.equal(isSocialMessage(text), true, text)
  }
})

test('isSocialMessage has no size limit: a burst of thanks or a spammed one is still social (send-path-r2-4)', () => {
  const burst = ['Makasih banyak ya kak ' + '🙏'.repeat(10), 'iya kak siap ' + '👍'.repeat(5), 'makasih ya kak ' + '❤️'.repeat(10)].join('\n')
  for (const text of [burst, 'Makasih kak ' + '🙏'.repeat(30), 'makasih 🙏'.repeat(40), 'ok '.repeat(31), 'makasih kak '.repeat(100)]) {
    assert.equal(isThanks(text), false, 'too long for the skip')
    assert.equal(isSocialMessage(text), true, 'held all the same')
  }
  assert.deepEqual(reply('Siap Kak, ditunggu pesanannya ya. Pesan paling lambat 2 hari sebelumnya.', ['F9'], burst).reasons, ['social_message_answered_with_facts'])
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

test('isThanks: a long message is no thanks and costs little to reject; isSocialMessage scans it in linear time', () => {
  assert.equal(isThanks('good bye '.repeat(8)), true, '16 words may still be a thanks')
  assert.equal(isThanks('good bye '.repeat(8) + 'kak'), false, '17 are not')
  assert.equal(isThanks('🙏'.repeat(17)), false)
  // [text, isSocialMessage]: a recursive split was exponential on "good bye" × n + "x".
  const adversarial = [['good bye '.repeat(5000) + 'x', false], ['makasih '.repeat(5000), true], ['ok '.repeat(20000), true],
    ['ok '.repeat(12000) + 'tolong refund ke rekening saya', false], ['good bye '.repeat(7) + 'x', false], ['good bye '.repeat(14) + 'x', false],
    ['🙏'.repeat(20000), true], ['hehe '.repeat(13000), false], ['makasih kak :D '.repeat(4300), true]]
  let started = performance.now()
  for (let round = 0; round < 50; round++) {
    for (const [text] of adversarial) assert.equal(isThanks(text), false, `${text.length} chars`)
  }
  assert.ok(performance.now() - started < 1000, `isThanks: ${Math.round(performance.now() - started)} ms`)
  started = performance.now()
  for (let round = 0; round < 5; round++) {
    for (const [text, social] of adversarial) assert.equal(isSocialMessage(text), social, `${text.length} chars`)
  }
  assert.ok(performance.now() - started < 1000, `isSocialMessage: ${Math.round(performance.now() - started)} ms`)
})

test('thanksAgrees: a thanks that reads as one only with an acknowledgement or 👍 may be a yes (skip-safety-r3-2)', () => {
  for (const text of ['iya kak makasih', '👍 makasih kak', 'ok siap, makasih', 'perfect, thanks', 'Great, thanks!', 'ok makasih kak', 'oh ok, makasih kak', 'makasih kak 👌']) {
    assert.deepEqual([isThanks(text), thanksAgrees(text)], [true, true], text)
  }
  for (const text of ['makasih kak 🙏', 'makasih ya kak', 'good bye', 'thanks, you too!', 'have a nice day kak', '🙏', 'wah makasih banyak kak']) {
    assert.deepEqual([isThanks(text), thanksAgrees(text)], [true, false], text)
  }
  for (const text of ['iya kak', '👍', 'jam buka?', undefined]) assert.equal(thanksAgrees(text), false, String(text))
})

test('socialWithoutQuestion: any thanks, goodbye or yes in a message that asks nothing, whatever other words come with it (send-path-r3-1, send-path-r3-2)', () => {
  const held = ['makasih bang', 'makasih mba', 'makasih kaka', 'makasih kk', 'makasih om', 'thanks bro', 'makasih bos', 'Makasih kak, semangat',
    'thanks so much, have a good one', 'Sama2 kak, makasih juga 🙏', 'Oke kak siap, saya tunggu 🙏', 'iya kak betul', 'gapapa kak', 'siap bos',
    'ok kk', 'okeh kak', 'ok kak nanti saya ke sana', 'siap kak ditunggu kabarnya', 'nggak apa-apa kak', 'ga apa2 kak', '👍 besok ya',
    'minta alamatnya kak, makasih']
  for (const text of held) {
    assert.equal(socialWithoutQuestion(text), true, text)
    assert.deepEqual(reply('Siap Kak, ditunggu ya. Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', ['F1'], text).reasons.filter(reason => !reason.startsWith('language')),
      ['social_message_answered_with_facts'], text)
  }
  // A question, with a thanks or not; requests and orders whose only yes-words are as common in them; a greeting's words.
  for (const text of ['makasih, jam buka berapa?', 'Kak brownies berapa ya? Makasih', 'Kak alamatnya dimana ya, makasih', 'ok kak, jam buka?',
    'thanks, where is the shop', 'Boleh minta alamatnya kak', 'Kak saya sudah transfer ya', 'mau pesan brownies ya kak', 'Good morning, I would like the address',
    'Selamat pagi kak', 'Halo kak, tokonya buka jam berapa aja ya?', '', undefined]) {
    assert.equal(socialWithoutQuestion(text), false, String(text))
  }
  assert.deepEqual(reply('Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', ['F1'], 'makasih bang, buka jam berapa?'), { ok: true, reasons: [] })
})

test('isSocialMessage: a doubling 2 and more honorifics (send-path-r3-1)', () => {
  for (const text of ['sama2 kak', 'Sama2 kak, makasih juga 🙏', 'makasih2 kak', 'makasih bang', 'thanks bro', 'ok kk', 'siap bos', 'gapapa kak', 'iya kak betul']) {
    assert.equal(isSocialMessage(text), true, text)
  }
  for (const text of ['ok 2 loyang', 'sama 2 loyang', 'jam2 buka']) assert.equal(isSocialMessage(text), false, text)
})

test('socialWithoutQuestion scans a long message in linear time', () => {
  const adversarial = ['good bye '.repeat(5000) + 'x', 'ok '.repeat(20000), 'x '.repeat(20000) + 'berapa', 'nggak apa '.repeat(5000), 'sama2 '.repeat(10000)]
  const started = performance.now()
  for (let round = 0; round < 5; round++) for (const text of adversarial) socialWithoutQuestion(text)
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
  assert.deepEqual(guardTriage({ decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts_used: [] }, { knowledge, config, incomingText: 'ok makasih kak 🙏' }).reasons, ['no_facts_used', 'thanks_back'])
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
