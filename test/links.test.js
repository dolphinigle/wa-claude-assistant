import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { renderLinks, renderTriageLinks } from '../src/links.js'
import { createLookup } from '../src/lookup.js'
import { Store } from '../src/store.js'
import { createFakeBrain, createFakeTransport, incoming, knowledge, makeConfig, tempDir, triageResult } from './helpers.js'

const SHOP = 'https://www.bormadago.com/shop'
// A small stand-in for data/borma/catalog.json: product 2 is not sold online (no url).
const CATALOG = {
  stockAsOf: '2026-09-30 15:51',
  products: [
    { id: 1, title: 'INDOMIE GORENG SPECIAL 85 GR', url: `${SHOP}/product/1/indomie-goreng-special-85-gr`, orders30d: 900, categoryIds: [15, 60], stores: [{ storeId: 1, price: 3500, stock: 'tersedia' }] },
    { id: 2, title: 'TELUR AYAM NEGERI CURAH', url: null, orders30d: 800, stores: [{ storeId: 1, price: 27000, stock: 'tersedia' }] },
    { id: 3, title: 'MONTISS FACIAL TISSUE 200 SHEETS', url: `${SHOP}/product/3/montis-facial-tissue`, orders30d: 700, stores: [{ storeId: 1, price: 11500, normalPrice: 20300, promo: 'CUT PRICE', promoId: 8179, stock: 'tersedia' }] }
  ],
  categories: [{ id: 15, name: 'MAKANAN & BAHAN MAKANAN', slug: 'makanan-bahan-makanan' }, { id: 60, name: 'MI INSTAN', slug: 'mi-instan' }]
}
const STORES = [{ id: 1, name: 'Borma Dago', area: 'Dago', address: 'Jl. Ir. H. Juanda 348' }]
const render = text => renderLinks(text, { catalog: CATALOG })

test('each tag becomes the shop\'s exact page: search words encoded, product, category and promo pages from the export', () => {
  const { text, urls, dropped } = render('Indomie Rp 3.500 [[produk: 1]]\nSemua mi instan: [[kategori: 60]]\nCari: [[cari: gula pasir]]\nPromo: [[promo]] dan [[promo: 8179]]')
  assert.equal(text, `Indomie Rp 3.500 ${SHOP}/product/1/indomie-goreng-special-85-gr\nSemua mi instan: ${SHOP}/category/detail/60/mi-instan\n` +
    `Cari: ${SHOP}/product/list?q=gula%20pasir\nPromo: ${SHOP}/promo/list dan ${SHOP}/promo/detail/8179`)
  assert.deepEqual(urls, [`${SHOP}/product/1/indomie-goreng-special-85-gr`, `${SHOP}/category/detail/60/mi-instan`, `${SHOP}/product/list?q=gula%20pasir`, `${SHOP}/promo/list`, `${SHOP}/promo/detail/8179`])
  assert.deepEqual(dropped, [])
})

test('tags are read loosely: case, spacing, English names, quotes and backticks around them', () => {
  assert.equal(render('[[Cari:Minyak  Goreng]]').text, `${SHOP}/product/list?q=minyak%20goreng`)
  assert.equal(render('[[ PRODUK : 01 ]]').text, `${SHOP}/product/1/indomie-goreng-special-85-gr`)
  assert.equal(render('[[search: "pringles"]] [[product:1]] [[Promo]]').text, `${SHOP}/product/list?q=pringles ${SHOP}/product/1/indomie-goreng-special-85-gr ${SHOP}/promo/list`)
  assert.equal(render('Cek `[[cari: gula]]` ya').text, `Cek ${SHOP}/product/list?q=gula ya`)
  assert.equal(render('[[cari: crème brûlée 2]]').text, `${SHOP}/product/list?q=creme%20brulee%202`, 'diacritics folded, digits kept')
})

test('a rendered link is never glued to a word, before or after it', () => {
  assert.equal(render('Rp 3.500[[produk: 1]]ya').text, `Rp 3.500 ${SHOP}/product/1/indomie-goreng-special-85-gr ya`)
  assert.equal(render('link:[[cari: gula]], atau (lihat [[promo]])').text, `link: ${SHOP}/product/list?q=gula, atau (lihat ${SHOP}/promo/list)`)
})

test('a tag that cannot be a real page is dropped without a trace, never guessed', () => {
  const cases = [
    ['- Telur ayam Rp 27.000 [[produk: 2]]', '- Telur ayam Rp 27.000', 'not sold online'],
    ['- Indomie Rp 3.500 [[produk: 999]]', '- Indomie Rp 3.500', 'not in the export'],
    ['Lihat [[kategori: 77]] ya Kak', 'Lihat ya Kak', 'an unknown category'],
    ['Promo tisu (link: [[promo: 1234]]) ya', 'Promo tisu ya', 'a promo without a page'],
    ['Cek [[cari: minyak-goreng]]!', 'Cek!', 'a hyphen'],
    ['Cek [[cari: a b c d e f]]', 'Cek', 'six words'],
    ['Cek [[cari: <script>]] [[link: x]] [[cari:]] [[produk: abc]]', 'Cek', 'markup, an unknown kind, an empty search, a non-numeric id'],
    ['Minyak ada Kak.\n\nSemua gula: [[cari: gula?]]\n\nMau yang mana?', 'Minyak ada Kak.\n\nMau yang mana?', 'a lead-in line pointing at nothing goes whole'],
    ['Semua hasil: [[cari: x!]]', '', 'nothing left'],
    ['Oke Kak\n[[produk: 999]]', 'Oke Kak', 'a line of only the tag']
  ]
  for (const [input, expected, why] of cases) {
    const { text, urls, dropped } = render(input)
    assert.equal(text, expected, why)
    assert.deepEqual(urls, [], why)
    assert.ok(dropped.length > 0, why)
  }
  const mixed = render('Semua minyak: [[cari: minyak goreng]], gula: [[cari: gula!!]]')
  assert.equal(mixed.text, `Semua minyak: ${SHOP}/product/list?q=minyak%20goreng, gula`, 'a line with a rendered link stays')
  assert.deepEqual(mixed.dropped, ['[[cari: gula!!]]'])
  assert.equal(render('Tanpa link, Kak.\n\n\nSampai jumpa').text, 'Tanpa link, Kak.\n\n\nSampai jumpa', 'a text without tags is untouched')
  assert.equal(render('Harga [[produk: 1').text, 'Harga [[produk: 1', 'no closing brackets: left for the guards (a placeholder)')
  assert.equal(renderLinks('[[produk: 1]] [[kategori: 60]] [[promo: 8179]] [[cari: gula]]').text, `${SHOP}/product/list?q=gula`, 'no export: only the search')
})

test('renderTriageLinks renders the reply only: the holding reply stays as Claude wrote it', () => {
  const result = triageResult({ decision: 'escalate', reply: 'Indomie [[produk: 1]]', holding_reply: 'Baik Kak [[cari: gula]]' })
  const { result: rendered, urls, dropped } = renderTriageLinks(result, { catalog: CATALOG })
  assert.equal(rendered.triage.reply, `Indomie ${SHOP}/product/1/indomie-goreng-special-85-gr`)
  assert.equal(rendered.triage.holding_reply, 'Baik Kak [[cari: gula]]')
  assert.deepEqual([urls.length, dropped], [1, []])
  assert.equal(result.triage.reply, 'Indomie [[produk: 1]]', 'the triage result is not changed in place')
  const failed = { ok: false, error: 'timeout', meta: {} }
  assert.equal(renderTriageLinks(failed, { catalog: CATALOG }).result, failed)
})

function setup (t, respond) {
  const dir = tempDir(t)
  const config = makeConfig({ mode: 'live', debounceMs: 10, borma: { enabled: true, orders: false } }, dir)
  const store = new Store(dir, { logger: { log () {}, warn () {}, error () {} } })
  const transport = createFakeTransport()
  const lookup = createLookup({ config, catalog: CATALOG, stores: STORES })
  const assistant = createAssistant({ config, store, brain: createFakeBrain(respond), transport, knowledge, lookup, logger: { log () {}, warn () {}, error () {} } })
  t.after(() => assistant.stop())
  const deliver = async message => { transport.remember(message); await assistant.handleMessage(message); await assistant.idle() }
  const owner = text => deliver({ id: `OWN${Math.random()}`, chatId: 'self', fromMe: true, isSelfChat: true, text, timestamp: Math.floor(Date.now() / 1000), kind: 'notify' })
  const audit = () => readFileSync(store.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { transport, deliver, owner, audit }
}
const CUSTOMER = '6282222222222@s.whatsapp.net'
const TAGGED = 'Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago ya Kak [[produk: 1]]\nSemua indomie: [[cari: indomie goreng]]'
const RENDERED = `Indomie Goreng Special 85 gr Rp 3.500 di Borma Dago ya Kak ${SHOP}/product/1/indomie-goreng-special-85-gr\nSemua indomie: ${SHOP}/product/list?q=indomie%20goreng`

test('the assistant renders the tags before the guards: the customer gets the real links, and the log counts them', async t => {
  const { transport, deliver, audit } = setup(t, () => triageResult({ decision: 'answer', reply: TAGGED, facts_used: ['F100'] }))
  await deliver(incoming(CUSTOMER, 'harga indomie goreng berapa kak?'))
  assert.deepEqual(transport.toCustomer().map(item => item.text), [`🤖 ${RENDERED}`])
  const decision = audit().find(entry => entry.event === 'decision')
  assert.equal(decision.reply, RENDERED)
  assert.deepEqual(decision.links, { rendered: 2, dropped: [] })
})

test('a URL Claude typed itself is held, even the shop\'s own page', async t => {
  const reply = `Indomie Goreng Special 85 gr Rp 3.500 ya Kak ${SHOP}/product/1/indomie-goreng-special-85-gr`
  const { transport, deliver, audit } = setup(t, () => triageResult({ decision: 'answer', reply, facts_used: ['F100'] }))
  await deliver(incoming(CUSTOMER, 'harga indomie goreng berapa kak?'))
  assert.deepEqual(transport.toCustomer(), [])
  assert.deepEqual(audit().find(entry => entry.event === 'decision').guard.reasons, ['unsupported_url:bormadago.com/shop/product/1/indomie-goreng-special-85-gr'])
})

test('the owner\'s draft carries the rendered links, so /ok sends them; a tag in the holding reply withholds it', async t => {
  const { transport, deliver, owner } = setup(t, () => triageResult({ decision: 'escalate', reply: TAGGED, facts_used: ['F100'], customer_waiting: true, holding_reply: 'Baik Kak, cek [[cari: indomie]] ya' }))
  await deliver(incoming(CUSTOMER, 'harga indomie goreng berapa kak? bisa transfer?'))
  assert.deepEqual(transport.toCustomer(), [], 'no placeholder: its guard holds the tag')
  assert.ok(transport.toSelf().some(text => text.includes('📝 DRAFT #1') && text.includes(`${SHOP}/product/list?q=indomie%20goreng`) && !text.includes('[[')))
  await owner('/ok 1')
  assert.deepEqual(transport.toCustomer().map(item => item.text), [RENDERED])
})
