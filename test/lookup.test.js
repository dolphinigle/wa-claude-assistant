import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { buildUserTurn } from '../src/brain/prompt.js'
import { checkReply, guardTriage } from '../src/guards.js'
import { buildIndex, createLookup, matchProducts, phoneFromChatIds, withLookup } from '../src/lookup.js'
import { Store } from '../src/store.js'
import { createFakeBrain, createFakeTransport, incoming, knowledge, makeConfig, tempDir, triageResult } from './helpers.js'

// A small stand-in for data/borma/catalog.json (never in git): real title shapes, made-up prices.
const product = (id, title, orders30d, stores) => ({ id, title, size: null, unit: null, url: `https://www.bormadago.com/shop/product/${id}/p-${id}`, orders30d, stores })
const both = (dago, kopo, stock = 'tersedia') => [{ storeId: 1, price: dago, stock }, { storeId: 2, price: kopo, stock }]
const CATALOG = {
  stockAsOf: '2026-09-28 17:04',
  products: [
    product(1, 'INDOMIE GORENG SPECIAL 85 GR', 900, both(3500, 3400)),
    product(2, 'INDOMIE SOTO 70 GR', 500, both(3200, 3100)),
    product(3, 'ULTRA MILK UHT FULL CREAM 1000 ML', 400, both(19800, 19500)),
    product(4, 'ULTRA MILK UHT COKELAT 250 ML', 300, [{ storeId: 1, price: 6500, normalPrice: 7200, promo: 'HEMAT SUSU', promoEnds: '2026-09-30 21:30', stock: 'sedikit' }]),
    product(5, 'ROMA SARI GANDUM SUSU & COKLAT 108 GR', 800, both(9900, 9800)),
    product(6, 'FRISIAN FLAG SUSU KENTAL MANIS BIGBRO 535 GR', 700, both(14500, 14200, 'habis')),
    product(7, 'SEDAAP MIE GORENG 90 GR', 850, both(3300, 3300)),
    product(8, 'AQUA AIR MINERAL 600 ML', 950, both(3500, 3500))
  ]
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

test('lookup facts: products with prices per store, promo, stock time and link, then the stores; F ids the guards know', async () => {
  const { lookup, calls } = bormaLookup()
  const found = await lookup.forBurst({ text: 'ada susu ultra kak?' })
  assert.deepEqual([...found.facts.keys()], ['F100', 'F101', 'F102', 'F103', 'F401', 'F402'])
  assert.match(found.facts.get('F100'), /^Produk ULTRA MILK UHT COKELAT 250 ML: Borma Dago Rp 6\.500 \(promo HEMAT SUSU s\.d\. 30-09-2026 21\.30 WIB; harga normal Rp 7\.200\), stok sedikit/)
  assert.equal(found.facts.get('F101'), 'Produk ULTRA MILK UHT FULL CREAM 1000 ML: Borma Dago Rp 19.800, stok tersedia; Borma Fashion (Kopo) Rp 19.500, stok tersedia (stok per 28-09-2026 17.04 WIB). Beli online di www.bormadago.com, link produk: https://www.bormadago.com/shop/product/3/p-3')
  assert.equal(found.lines[0], `[F100] ${found.facts.get('F100')}`)
  assert.deepEqual(calls, [], 'not an order question: no order lookup')
})

test('suggestions: on promo and in stock first, habis everywhere last but still there; "promo apa aja?" lists the promos in stock', async () => {
  const { lookup } = bormaLookup()
  const titles = found => [...found.facts].filter(([id]) => id < 'F400').map(([, fact]) => fact.match(/^Produk (.+?):/)[1])
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

test('a product not sold online says so instead of a link; the recent conversation\'s products follow the message\'s own', async () => {
  const offline = createLookup({ config: { borma: { enabled: true, orders: false } }, stores: STORES, catalog: { products: [{ ...CATALOG.products[0], url: null }, CATALOG.products[2]] } })
  assert.match((await offline.forBurst({ text: 'indomie goreng ada?' })).facts.get('F100'), /Borma Fashion \(Kopo\) Rp 3\.400, stok tersedia\. Tidak dijual online di www\.bormadago\.com: hanya di toko\.$/)

  const { lookup } = bormaLookup()
  const found = await lookup.forBurst({ text: 'sama aqua 600 ml 2 ya kak', recentTexts: ['mau pesan indomie goreng 5 bungkus', 'Baik Kak, Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago. Link: https://www.bormadago.com/shop/product/1/p-1'] })
  assert.match(found.facts.get('F100'), /^Produk AQUA AIR MINERAL 600 ML:/)
  assert.match(found.facts.get('F101'), /^Produk INDOMIE GORENG SPECIAL 85 GR:/)
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

test('a product link from the facts passes the guards; a made-up one is held, in demo mode too', async () => {
  const found = await bormaLookup().lookup.forBurst({ text: 'harga indomie goreng berapa?' })
  const perCall = withLookup(knowledge, found)
  const reply = 'Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago ya Kak. Bisa beli online di sini: https://www.bormadago.com/shop/product/1/p-1.'
  assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall }), { ok: true, reasons: [] })
  const madeUp = reply.replace('/1/p-1', '/1/indomie-goreng')
  assert.deepEqual(checkReply({ reply: madeUp, factsUsed: ['F100'] }, { knowledge: perCall }).reasons, ['unsupported_url:bormadago.com/shop/product/1/indomie-goreng'])
  const demo = { demo: true, demoPrices: true }
  assert.deepEqual(checkReply({ reply, factsUsed: ['F100'] }, { knowledge: perCall, ...demo }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: madeUp, factsUsed: ['F100'] }, { knowledge: perCall, ...demo }).reasons, ['demo_unsupported_url:bormadago.com/shop/product/1/indomie-goreng'])
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
  const perCall = withLookup(knowledge, found)
  const identifiers = { words: ['irvan', 'bormadago'], paths: [] } // privateIdentifiers() of irvan@bormadago.com
  const reply = 'Ultra Milk UHT Full Cream 1000 ml ada di Borma Dago, Rp 19.800 ya Kak. Bisa juga beli online di www.bormadago.com.'
  assert.deepEqual(checkReply({ reply, factsUsed: ['F101'] }, { knowledge: perCall, privateIdentifiers: identifiers }), { ok: true, reasons: [] })
  assert.deepEqual(checkReply({ reply: `${reply} Hubungi irvan ya.`, factsUsed: ['F101'] }, { knowledge: perCall, privateIdentifiers: identifiers }).reasons, ['private_detail'])
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
