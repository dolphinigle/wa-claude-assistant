import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowList, checkReply, detectLanguage, extractDetails, guardTriage } from '../src/guards.js'
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
  assert.deepEqual(extractDetails('loyang 20x20, 3 hari').numbers, [20, 20, 3])
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
    ['Kami buka tanggal 25 Desember', 'unsupported_number:25'],
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

test('guardTriage only checks simple replies', () => {
  const config = makeConfig()
  assert.equal(guardTriage({ category: 'complex', reply: 'Rp 1' }, { knowledge, config }), undefined)
  assert.equal(guardTriage({ category: 'simple', reply: 'Rp 1', facts_used: ['F5'] }, { knowledge, config }).ok, false)
})
