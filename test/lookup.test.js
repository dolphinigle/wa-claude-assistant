import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { buildUserTurn } from '../src/brain/prompt.js'
import { ROOT_DIR } from '../src/config.js'
import { checkReply, guardTriage } from '../src/guards.js'
import { parseKnowledge } from '../src/knowledge.js'
import { renderLinks } from '../src/links.js'
import { buildIndex, createLookup, itemPhrases, matchProducts, phoneFromChatIds, withLookup } from '../src/lookup.js'
import { Store } from '../src/store.js'
import { createFakeBrain, createFakeTransport, incoming, knowledge, makeConfig, tempDir, triageResult } from './helpers.js'

// The Borma demo's own knowledge.md (this branch): its facts name the shop's domain.
const bormaKnowledge = parseKnowledge(readFileSync(path.join(ROOT_DIR, 'knowledge.md'), 'utf8'))
const titleOf = fact => fact.match(/^Produk (.+?) \(id \d+/)[1]

// A small stand-in for data/borma/catalog.json (never in git): real title shapes, made-up prices.
const product = (id, title, orders30d, stores) => ({ id, title, size: null, unit: null, url: `https://www.bormadago.com/shop/product/${id}/p-${id}`, orders30d, stores })
const both = (dago, kopo, stock = 'tersedia') => [{ storeId: 1, price: dago, stock }, { storeId: 2, price: kopo, stock }]
const CATALOG = {
  stockAsOf: '2026-09-28 17:04',
  products: [
    product(1, 'INDOMIE GORENG SPECIAL 85 GR', 900, both(3500, 3400)),
    product(2, 'INDOMIE SOTO 70 GR', 500, both(3200, 3100)),
    product(3, 'ULTRA MILK UHT FULL CREAM 1000 ML', 400, both(19800, 19500)),
    { ...product(4, 'ULTRA MILK UHT COKELAT 250 ML', 300, [{ storeId: 1, price: 6500, normalPrice: 7200, promo: 'HEMAT SUSU', promoEnds: '2026-09-30 21:30', promoId: 8179, stock: 'sedikit' }]), categoryIds: [12, 120] },
    product(5, 'ROMA SARI GANDUM SUSU & COKLAT 108 GR', 800, both(9900, 9800)),
    product(6, 'FRISIAN FLAG SUSU KENTAL MANIS BIGBRO 535 GR', 700, both(14500, 14200, 'habis')),
    product(7, 'SEDAAP MIE GORENG 90 GR', 850, both(3300, 3300)),
    product(8, 'AQUA AIR MINERAL 600 ML', 950, both(3500, 3500))
  ],
  categories: [{ id: 12, name: 'MINUMAN', slug: 'minuman' }, { id: 120, name: 'SUSU UHT', slug: 'susu-uht' }]
}
const STORES = [
  { id: 1, name: 'Borma Dago', area: 'Dago', address: 'Jl. Ir. H. Juanda 348. Telp (022) 2504601 BANDUNG' },
  { id: 2, name: 'Borma Fashion', area: 'Kopo', address: 'Jl. Kopo Sayati 102. Telp (022) 5400448 BANDUNG' }
]
const ORDER_ROW = { number: '250927000123', status: 'In shipping', created: '27-09-2026 14.05', total: '125000', shipping: '15000', shipping_code: 'biteship:grab:instant', facility_id: '1', last_event_type: '1', last_event_at: '27-09-2026 15.10', matched_users: '1' }
const PN = '6281234567890@s.whatsapp.net'
const LID = '123456789012345@lid'
const silent = { log () {}, warn () {}, error () {} }

function bormaLookup ({ queryOrders = async () => ({ ok: true, rows: [ORDER_ROW] }), borma = {} } = {}) {
  const calls = []
  const lookup = createLookup({
    config: { borma: { enabled: true, orders: true, orderTimeoutMs: 8000, orderCacheMs: 60_000, ...borma } },
    catalog: CATALOG,
    stores: STORES,
    queryOrders: phone => { calls.push(phone); return queryOrders(phone) }
  })
  return { lookup, calls }
}

test('product matching: "harga indomie berapa" finds the Indomies, best seller first; "ada susu ultra?" finds Ultra Milk first', () => {
  const index = buildIndex(CATALOG.products)
  assert.deepEqual(matchProducts(index, 'harga indomie berapa').map(item => item.id), [1, 2])
  // "SUSU" is in fewer titles than "ULTRA", but a title with both words (susu = milk) ranks first.
  assert.deepEqual(matchProducts(index, 'ada susu ultra?').slice(0, 2).map(item => item.id), [3, 4])
  assert.deepEqual(matchProducts(index, 'Kak, ÍNDOMIÉ soto ada?').map(item => item.id)[0], 2, 'case and diacritics do not matter')
  assert.deepEqual(matchProducts(index, 'halo kak, ada yang bisa dibantu?'), [], 'chat words name no product')
  assert.deepEqual(matchProducts(index, '85'), [], 'a number alone names no product')
})

test('lookup facts: products with their ids, prices per store, promo, stock time and categories, then the stores; F ids the guards know; no URL', async () => {
  const { lookup, calls } = bormaLookup()
  const found = await lookup.forBurst({ text: 'ada susu ultra kak?' })
  assert.deepEqual([...found.facts.keys()], ['F100', 'F101', 'F102', 'F103', 'F401', 'F402'])
  assert.equal(found.facts.get('F100'), 'Produk ULTRA MILK UHT COKELAT 250 ML (id 4, dijual online): Borma Dago Rp 6.500 (promo HEMAT SUSU s.d. 30-09-2026 21.30 WIB, promo id 8179; harga normal Rp 7.200), stok sedikit (stok per 28-09-2026 17.04 WIB). Kategori MINUMAN (id 12) > SUSU UHT (id 120).')
  assert.equal(found.facts.get('F101'), 'Produk ULTRA MILK UHT FULL CREAM 1000 ML (id 3, dijual online): Borma Dago Rp 19.800, stok tersedia; Borma Fashion (Kopo) Rp 19.500, stok tersedia (stok per 28-09-2026 17.04 WIB).')
  assert.ok(!found.lines.some(line => /https?:|www\./.test(line)), 'links are Claude\'s tags, rendered after the triage (src/links.js)')
  assert.equal(found.lines[0], `[F100] ${found.facts.get('F100')}`)
  assert.deepEqual(calls, [], 'not an order question: no order lookup')
})

test('suggestions: on promo and in stock first, habis everywhere last but still there; "promo apa aja?" lists the promos in stock', async () => {
  const { lookup } = bormaLookup()
  const titles = found => [...found.facts].filter(([, fact]) => fact.startsWith('Produk ')).map(([, fact]) => titleOf(fact))
  // By relevance alone the habis Frisian Flag (a better seller) would come before Roma; it goes last instead.
  assert.deepEqual(titles(await lookup.forBurst({ text: 'ada susu?' })), ['ULTRA MILK UHT COKELAT 250 ML', 'ROMA SARI GANDUM SUSU & COKLAT 108 GR',
    'ULTRA MILK UHT FULL CREAM 1000 ML', 'FRISIAN FLAG SUSU KENTAL MANIS BIGBRO 535 GR'])
  assert.ok([...(await lookup.forBurst({ text: 'susu kental manis frisian flag ada?' })).facts.values()].some(fact => /^Produk FRISIAN FLAG .* stok habis/.test(fact)), 'asked by name: still answered')
  assert.deepEqual(titles(await lookup.forBurst({ text: 'promo apa aja kak?' })), ['ULTRA MILK UHT COKELAT 250 ML'])
  // A search by category: no title says "snack".
  const snack = createLookup({ config: { borma: { enabled: true, orders: false } }, stores: STORES,
    catalog: { products: [{ ...CATALOG.products[4], category: 'MAKANAN KECIL > COOKIES, BISKUIT DAN LAIN LAIN' }, { ...CATALOG.products[7], category: 'MINUMAN > AIR MINERAL' }, product(9, 'CHITATO SAPI PANGGANG 65 GR', 100, both(8500, 8500))].map(item => ({ ...item, category: item.category ?? 'MAKANAN KECIL > KACANG DAN SNACK LAINNYA' })) } })
  assert.deepEqual(titles(await snack.forBurst({ text: 'cari snack dong' })), ['CHITATO SAPI PANGGANG 65 GR'])
})

test('a product not sold online says so; the recent conversation\'s products follow the message\'s own', async () => {
  const offline = createLookup({ config: { borma: { enabled: true, orders: false } }, stores: STORES, catalog: { products: [{ ...CATALOG.products[0], url: null }, CATALOG.products[2]] } })
  assert.match((await offline.forBurst({ text: 'indomie goreng ada?' })).facts.get('F100'), /^Produk INDOMIE GORENG SPECIAL 85 GR \(id 1, hanya di toko, tidak dijual online\): /)

  const { lookup } = bormaLookup()
  const found = await lookup.forBurst({ text: 'sama aqua 600 ml 2 ya kak', recentTexts: ['mau pesan indomie goreng 5 bungkus', 'Baik Kak, Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago. Link: https://www.bormadago.com/shop/product/1/p-1'] })
  assert.match(found.facts.get('F100'), /^Produk AQUA AIR MINERAL 600 ML \(id 8,/)
  assert.match(found.facts.get('F101'), /^Produk INDOMIE GORENG SPECIAL 85 GR \(id 1,/)
  assert.deepEqual(found.summary, { products: 1, recentProducts: 3, stores: 2 })
})

test('orders are looked up only for an order question, only with the chat\'s own number, never one written in the message', async t => {
  const { lookup, calls } = bormaLookup()
  const dir = tempDir(t)
  const store = new Store(dir, { logger: silent })
  const brain = createFakeBrain(() => triageResult({ decision: 'escalate', reply: 'Baik Kak, saya cek dulu ya.' }))
  const transport = createFakeTransport()
  const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 5 }, dir), store, brain, transport, knowledge, lookup, logger: silent })
  t.after(() => assistant.stop())
  const deliver = async message => { await assistant.handleMessage(message); await assistant.idle() }

  await deliver(incoming(PN, 'kak pesanan saya sudah dikirim belum? nomor saya 081299998888'))
  assert.deepEqual(calls, ['+6281234567890'])
  const turn = brain.calls[0].lookup
  assert.deepEqual([...turn.facts.keys()], ['F900', 'F901'])
  assert.match(turn.facts.get('F901'), /^Pesanan 250927000123 \(dibuat 27-09-2026 14\.05 WIB, Borma Dago\): status Sedang Dikirim/)

  await deliver(incoming(PN, 'harga indomie berapa kak'))
  assert.deepEqual(calls, ['+6281234567890'], 'not an order question')

  await deliver(incoming(LID, 'paket saya kok belum datang ya kak, ini nomor saya 081299998888'))
  assert.deepEqual(calls, ['+6281234567890'], 'a LID chat whose number is unknown: no lookup, and never the typed number')
  assert.deepEqual(brain.calls.at(-1).lookup.notes, ['This chat\'s WhatsApp number is not known, so the sender\'s orders could not be looked up.'])

  await deliver(incoming('987654321098765@lid', 'status pesanan saya gimana kak?', { chatIdAlt: '6285555555555@s.whatsapp.net' }))
  assert.deepEqual(calls, ['+6281234567890', '+6285555555555'], 'a LID chat with its own number from WhatsApp')
})

test('the order lookup: cached per number for a minute; a failure or a slow query gives a note, never a crash', async () => {
  const { lookup, calls } = bormaLookup()
  await lookup.forBurst({ text: 'status pesanan?', phone: '+6281234567890' })
  await lookup.forBurst({ text: 'sudah dikirim?', phone: '+6281234567890' })
  assert.equal(calls.length, 1)

  const slow = bormaLookup({ queryOrders: () => new Promise(() => {}), borma: { orderTimeoutMs: 20 } })
  const found = await slow.lookup.forBurst({ text: 'pesanan saya sampai kapan?', phone: '+6281234567890' })
  assert.deepEqual(found.summary.orders, 'failed:timeout')
  assert.deepEqual(found.notes, ['The sender\'s orders could not be looked up right now.'])
  assert.ok(![...found.facts.keys()].some(id => id.startsWith('F9')))

  const broken = bormaLookup({ queryOrders: async () => { throw new Error('bq exploded') } })
  assert.equal((await broken.lookup.forBurst({ text: 'resi paket?', phone: '+6281234567890' })).summary.orders, 'failed:bq exploded')
})

test('a phone comes only from a PN JID of the chat', () => {
  assert.equal(phoneFromChatIds(['6281234567890@s.whatsapp.net']), '+6281234567890')
  assert.equal(phoneFromChatIds([LID, '6281234567890@s.whatsapp.net']), '+6281234567890')
  assert.equal(phoneFromChatIds([LID]), undefined)
  assert.equal(phoneFromChatIds(['14155550100@s.whatsapp.net', 'alice@console']), undefined, 'not Indonesian, not a phone')
})

test('lookup facts pass the guards: a price from a cited lookup fact passes, an invented one fails; demo mode checks prices too', async () => {
  const { lookup } = bormaLookup()
  const found = await lookup.forBurst({ text: 'harga indomie goreng berapa?' })
  const perCall = withLookup(knowledge, found)
  const guards = { maxReplyChars: 600, sensitiveTerms: ['promo', 'diskon'] }
  const reply = 'Indomie Goreng Special 85 gr harganya Rp 3.500 di Borma Dago dan Rp 3.400 di Borma Fashion (Kopo) ya Kak.'
  assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall, ...guards }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: reply.replace('3.500', '3.000'), factsUsed: ['F100'] }, { knowledge: perCall, ...guards }).reasons, ['unsupported_amount:3000'])
  assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge, ...guards }).reasons.slice(0, 1), ['unknown_fact:F100'], 'without the lookup the id is unknown')

  const demo = { ...guards, demo: true, demoPrices: true }
  assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall, ...demo }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: 'Indomie lagi promo Rp 2.900 ya Kak, diskon 10%!', factsUsed: [] }, { knowledge: perCall, ...demo }).reasons, ['demo_unsupported_amount:2900,10%'])
  assert.deepEqual(checkReply({ reply: 'Indomie lagi promo Rp 2.900 ya Kak!', factsUsed: [] }, { knowledge: perCall, ...guards, demo: true }).reasons, [], 'demo without Borma data still invents')

  // The sender's own order number is in the facts: not an invented account number.
  const orders = await bormaLookup().lookup.forBurst({ text: 'status pesanan saya?', phone: '+6281234567890' })
  const orderReply = 'Pesanan 250927000123 sedang dikirim dengan Grab Express, Kak. Totalnya Rp 125.000.'
  assert.deepEqual(checkReply({ reply: orderReply, factsUsed: ['F901'] }, { knowledge: withLookup(knowledge, orders), ...demo }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: orderReply.replace('250927000123', '250927000999'), factsUsed: ['F901'] }, { knowledge: withLookup(knowledge, orders), ...demo }).reasons,
    ['demo_payment_detail'])
})

test('a link rendered from a tag passes the guards; a URL Claude wrote itself is held, the shop\'s or any other, in demo mode too', async () => {
  const found = await bormaLookup().lookup.forBurst({ text: 'harga indomie goreng berapa?' })
  const perCall = withLookup(knowledge, found)
  const { text: reply, urls } = renderLinks('Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago ya Kak. Bisa beli online di sini: [[produk: 1]].\nSemua indomie: [[cari: indomie]]', { catalog: CATALOG })
  assert.equal(reply, 'Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago ya Kak. Bisa beli online di sini: https://www.bormadago.com/shop/product/1/p-1.\nSemua indomie: https://www.bormadago.com/shop/product/list?q=indomie')
  const demo = { demo: true, demoPrices: true }
  for (const mode of [{}, demo]) {
    const url = mode.demo ? 'demo_unsupported_url' : 'unsupported_url'
    assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall, ...mode, allowedUrls: urls }), { ok: true, reasons: [] })
    assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall, ...mode }).reasons,
      [`${url}:bormadago.com/shop/product/1/p-1,bormadago.com/shop/product/list?q=indomie`], 'the same links typed by Claude: not ours')
    const invented = `${reply} Atau https://www.bormadago.com/shop/product/1/indomie-goreng dan tokopedia.com/borma`
    assert.deepEqual(checkReply({ reply: invented, factsUsed: ['F100'] }, { knowledge: perCall, ...mode, allowedUrls: urls }).reasons,
      [`${url}:bormadago.com/shop/product/1/indomie-goreng,tokopedia.com/borma`])
  }
  // guardTriage passes them on; a tag left unrendered is a placeholder.
  const config = makeConfig({ borma: { enabled: true } })
  assert.deepEqual(guardTriage({ decision: 'answer', reply, facts_used: ['F100'] }, { knowledge: perCall, config, allowedUrls: urls }), { ok: true, reasons: [] })
  assert.deepEqual(guardTriage({ decision: 'answer', reply: 'Indomie Rp 3.500 ya Kak [[produk: 1]]', facts_used: ['F100'] }, { knowledge: perCall, config }).reasons, ['placeholder'])
})

test('demo mode: an order summary\'s line totals and total pass when computed from the cited prices and stated quantities', async () => {
  const { lookup } = bormaLookup()
  const found = await lookup.forBurst({ text: 'mau pesan indomie goreng 5 sama aqua 600 ml 2' })
  const perCall = withLookup(knowledge, found)
  const cited = [...found.facts.keys()].filter(id => id < 'F400')
  const demo = { knowledge: perCall, demo: true, demoPrices: true }
  const summary = total => `Baik Kak Rina, ini ringkasan pesanannya:
• 5 x Indomie Goreng Special 85 gr @ Rp 3.500 = Rp 17.500
• 2 x Aqua Air Mineral 600 ml @ Rp 3.500 = Rp 7.000
Total: Rp ${total} (belum termasuk ongkir)
Ambil sendiri di Borma Dago. Apakah sudah benar, Kak?`
  assert.deepEqual(checkReply({ reply: summary('24.500'), factsUsed: cited }, demo), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: summary('25.500'), factsUsed: cited }, demo).reasons, ['demo_unsupported_amount:25500'], 'a wrong sum')
  assert.deepEqual(checkReply({ reply: summary('24.500'), factsUsed: [] }, demo).reasons, ['demo_unsupported_amount:3500,17500,7000,24500'], 'prices from no cited fact')
  assert.deepEqual(checkReply({ reply: 'Totalnya Rp 24.500 ya Kak (5 Indomie Rp 3.500 dan 2 Aqua Rp 3.500).', factsUsed: cited }, demo).reasons, ['demo_unsupported_amount:24500'], 'items run together on one line')
})

test('the shop\'s own domain in the facts is not the owner\'s private detail; the rest of the owner\'s email still is', async () => {
  const found = await bormaLookup().lookup.forBurst({ text: 'ada susu ultra?' })
  const perCall = withLookup(bormaKnowledge, found)
  const identifiers = { words: ['irvan', 'bormadago'], paths: [] } // privateIdentifiers() of irvan@bormadago.com
  const { text: reply, urls } = renderLinks('Ultra Milk UHT Full Cream 1000 ml ada di Borma Dago, Rp 19.800 ya Kak: [[produk: 3]]. Bisa juga beli online di www.bormadago.com.', { catalog: CATALOG })
  assert.deepEqual(checkReply({ reply, factsUsed: ['F101', 'F2'] }, { knowledge: perCall, privateIdentifiers: identifiers, allowedUrls: urls }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: `${reply} Hubungi irvan ya.`, factsUsed: ['F101', 'F2'] }, { knowledge: perCall, privateIdentifiers: identifiers, allowedUrls: urls }).reasons, ['private_detail'])
  assert.deepEqual(checkReply({ reply: 'Halo Kak, dari Borma Dago ya?', factsUsed: [] }, { knowledge, privateIdentifiers: identifiers }).reasons, ['private_detail'], 'not in these facts: private')
})

test('borma off (the default): no lookup reaches Claude or the guards, and the user turn has no lookup block', async t => {
  assert.equal(makeConfig().borma.enabled, false)
  const dir = tempDir(t)
  const brain = createFakeBrain()
  const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 5 }, dir), store: new Store(dir, { logger: silent }), brain, transport: createFakeTransport(), knowledge, logger: silent })
  t.after(() => assistant.stop())
  await assistant.handleMessage(incoming(PN, 'kak pesanan saya sudah dikirim? jam berapa buka?'))
  await assistant.idle()
  assert.equal(brain.calls.length, 1)
  assert.ok(!('lookup' in brain.calls[0]))
  const NOW = Date.UTC(2026, 8, 28, 10) / 1000
  assert.ok(!buildUserTurn({ messages: [{ text: 'hi', timestamp: NOW }], now: NOW }).includes('<lookup>'))
  const triage = { decision: 'answer', reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB ya Kak.', facts_used: ['F1'] }
  assert.deepEqual(guardTriage(triage, { knowledge, config: makeConfig({ demo: { enabled: true } }), incomingText: 'buka jam berapa?' }), { ok: true, reasons: [] }, 'demo prices are checked only with Borma data')
})

test('the lookup block: trusted and before the history, escaped all the same', () => {
  const NOW = Date.UTC(2026, 8, 28, 10) / 1000
  const turn = buildUserTurn({
    messages: [{ text: 'ada susu?', timestamp: NOW }],
    history: [{ fromMe: false, text: 'halo', timestamp: NOW - 60 }],
    lookup: { lines: ['[F100] Produk ROMA SARI GANDUM SUSU & COKLAT 108 GR: Borma Dago Rp 9.900'], notes: ['No order facts.'] },
    now: NOW
  })
  assert.match(turn, /^now: [^\n]+\n<lookup>\n\[F100\] Produk ROMA SARI GANDUM SUSU &amp; COKLAT 108 GR: Borma Dago Rp 9\.900\nnote: No order facts\.\n<\/lookup>\n<history>\n/)
})

test('no search or promo links in the lookup (Claude writes [[cari: …]] and [[promo]]): an unmatched search gets a note', async () => {
  const lookup = createLookup({ config: { borma: { enabled: true, orders: false } }, catalog: { products: [], stockAsOf: '2026-09-29T08:00:00Z' }, stores: [] })
  const beras = await lookup.forBurst({ text: 'ada beras organik kak?' })
  assert.equal(beras.facts.size, 0)
  assert.deepEqual(beras.notes, ['No product in the shop\'s catalog snapshot matches this message: its prices and stock are unknown.'])
  assert.equal((await lookup.forBurst({ text: 'promo apa aja?' })).facts.size, 0)
  assert.equal((await lookup.forBurst({ text: 'makasih kak' })).facts.size, 0)
})

// Live 2026-09-30: "Perlu minyak 5 liter dan gula" searched for "perlu minyak liter gula", and "liter" matched a dish
// soap and a water bottle.
test('several items: each item its own best matches, and a note for the one the catalog lacks', async () => {
  assert.deepEqual(itemPhrases('Perlu minyak 5 liter dan gula, adanya apa saja?'), [['minyak', '5'], ['gula']])
  assert.deepEqual(itemPhrases('mau pesan indomie goreng 10 bungkus sama aqua 600 ml 6 botol'), [['indomie', 'goreng', '10'], ['aqua', '600', '6']])
  assert.deepEqual(itemPhrases('susu ultra 1,5 liter + roti & keju\nteh'), [['susu', 'ultra', '1,5'], ['roti'], ['keju'], ['teh']], 'a decimal comma is no break')
  assert.deepEqual(itemPhrases('Sama tisu 1'), [['tisu', '1']])
  assert.deepEqual(itemPhrases('ada beras organik atau beras merah kak?'), [['beras', 'organik'], ['beras', 'merah']], 'alternatives too')
  const products = [
    product(10, 'MINYAK GORENG SUNCO POUCH 2 LT', 900, both(44800, 44700)),
    product(11, 'MINYAK GORENG SOVIA POUCH 1.8 LITER', 800, both(38800, 38800)),
    product(12, 'SANIA POUCH 1.8 LITER', 700, both(39200, 39200)),
    product(13, 'MAMA LEMON JERUK NIPIS REFILL 1.5 LITER', 990, both(20600, 20600)),
    product(14, 'GULAKU KUNING 1 KG', 600, both(17500, 17500)),
    product(15, 'GULAKU PUTIH 1 KG', 500, both(17500, 17500)),
    product(16, 'TEH PUCUK LESS SUGAR 350 ML', 995, [{ storeId: 1, price: 3400, normalPrice: 3600, promo: 'HEMAT', stock: 'tersedia' }]),
    product(17, 'CIMORY UHT ZERO SUGAR 225 ML', 980, both(6400, 6400))
  ].map(item => ({ ...item, category: /MINYAK|SANIA/.test(item.title) ? 'MINYAK > MINYAK GORENG' : /GULA/.test(item.title) ? 'GULA & PEMANIS > GULA PASIR' : /MAMA/.test(item.title) ? 'SABUN > SABUN CUCI PIRING' : 'MINUMAN' }))
  const lookup = createLookup({ config: { borma: { enabled: true, orders: false, maxProducts: 6 } }, catalog: { products }, stores: STORES })
  const found = await lookup.forBurst({ text: 'Perlu minyak 5 liter dan gula, adanya apa saja?' })
  assert.deepEqual([...found.facts.keys()].filter(id => id >= 'F200' && id < 'F400'), [], 'no search facts')
  const titles = [...found.facts.values()].filter(fact => fact.startsWith('Produk ')).map(titleOf)
  // 3 per item: the oils whose title and category say it first, then the sugars; no dish soap, no "LESS SUGAR" tea on
  // promo ahead of the sugars.
  assert.deepEqual(titles, ['MINYAK GORENG SUNCO POUCH 2 LT', 'MINYAK GORENG SOVIA POUCH 1.8 LITER', 'SANIA POUCH 1.8 LITER', 'GULAKU KUNING 1 KG', 'GULAKU PUTIH 1 KG', 'TEH PUCUK LESS SUGAR 350 ML'])
  const kulkas = await lookup.forBurst({ text: 'ada minyak dan kulkas?' })
  assert.deepEqual(kulkas.notes, ['No product in the shop\'s catalog snapshot matches "kulkas": its prices and stock are unknown.'])
})

test('reload swaps in a fresh export', async () => {
  const lookup = createLookup({ config: { borma: { enabled: true, orders: false } }, catalog: CATALOG, stores: STORES })
  assert.match((await lookup.forBurst({ text: 'harga indomie goreng?' })).facts.get('F100'), /Rp 3\.500.*stok per 28-09-2026 17\.04 WIB/)
  lookup.reload({ catalog: { ...CATALOG, stockAsOf: '2026-09-30 15:51', products: CATALOG.products.map(item => item.id === 1 ? { ...item, stores: both(3600, 3400) } : item) }, stores: STORES })
  assert.match((await lookup.forBurst({ text: 'harga indomie goreng?' })).facts.get('F100'), /Rp 3\.600.*stok per 30-09-2026 15\.51 WIB/)
})
