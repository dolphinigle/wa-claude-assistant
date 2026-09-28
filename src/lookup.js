// Borma demo (config `borma.enabled`): per burst, the facts Claude gets from the shop's own data, the "Real data"
// recipe of docs/building-on-this.md. Products and stores come from the read-only export in data/borma/ (`npm run
// export`); the sender's own online orders from a live read-only BigQuery query keyed by the chat's WhatsApp number,
// never by a number written in a message. Each fact has an F id the guards understand: F100+ products, 400 + store id
// for stores, F900 the order summary and F901+ orders. They go to Claude in a trusted <lookup> block (prompt.js) and
// to the guards as extra facts (withLookup), so every price and number of an answer is checked against them.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { runBq } from './bq.js'

const PRODUCT_BASE = 100
const STORE_BASE = 400
const ORDER_BASE = 900
const MAX_ORDERS = 5

// Case- and diacritic-insensitive words and numbers: "85gr" is "85" and "gr", as titles write "85 GR".
const fold = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
export const words = text => fold(text).match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? []
const stem = word => (word.length > 5 && word.endsWith('nya') ? word.slice(0, -3) : word) // indomienya

// Chat words that never name a product, and title words that name none on their own (sizes, packs).
const STOPWORDS = new Set(('ada adakah apa apakah atau aja ya yaa yah kak kaka kakak ka kk min mimin admin gan sis bang mas mbak bu pak ' +
  'harga harganya hargana berapa brp brapa berapaan mau pengen ingin beli membeli pesan order cari nyari tanya nanya info minta tolong mohon ' +
  'bisa boleh dong deh sih nih tuh lah kah pun yang yg ini itu di ke dari dan dengan sama untuk buat utk ga gak nggak ngga enggak tidak tdk ' +
  'masih msh sudah udah belum blm stok stock ready ready ada tersedia habis kosong sekarang skrg hari besok kalau kalo klo saya aku sy gue gw ' +
  'kami kita halo hai hi hello pagi siang sore malam selamat terima kasih makasih thanks thank please the a an is are do does you have any ' +
  'how much price of for and or with in at toko cabang borma dago kopo fashion online jual dijual punya ' +
  'gr g gram kg ml l lt ltr pcs pc s x isi pack pak dus box btl botol sachet').split(' '))
// A customer writes "susu" where the title says "MILK".
const SYNONYMS = {
  susu: ['milk'], milk: ['susu'], coklat: ['cokelat', 'choco', 'chocolate'], cokelat: ['coklat', 'choco', 'chocolate'],
  mie: ['mi', 'noodle', 'noodles'], mi: ['mie'], telur: ['telor', 'egg', 'eggs'], telor: ['telur'], kopi: ['coffee'], teh: ['tea'],
  gula: ['sugar'], beras: ['rice'], minyak: ['oil'], sabun: ['soap'], roti: ['bread'], keju: ['cheese'], ayam: ['chicken'],
  stroberi: ['strawberry'], strawberry: ['stroberi'], air: ['water'], tisu: ['tissue'], tissue: ['tisu']
}

/** The words of each product title. */
export function buildIndex (products) {
  const docs = products.map(product => ({ product, words: [...new Set(words(product.title))] }))
  return { docs }
}

/**
 * The products a message names, best first: each query word (or a synonym, or a word it starts, from 4 letters)
 * found in a title adds that word's weight, log(n / titles it is in). Ties go to the better seller. A number counts
 * only with a word ("indomie 85"), never alone.
 */
export function matchProducts (index, text, limit = 10) {
  const query = [...new Set(words(text).map(stem).filter(word => !STOPWORDS.has(word)))]
  if (query.length === 0) return []
  const n = index.docs.length
  const hits = query.map(word => {
    const variants = [word, ...(SYNONYMS[word] ?? [])]
    const matched = new Set()
    index.docs.forEach((doc, position) => {
      if (doc.words.some(title => variants.some(variant => title === variant || (variant.length >= 4 && /[a-z]/.test(variant) && title.startsWith(variant))))) matched.add(position)
    })
    return { word, matched, weight: matched.size ? Math.log(1 + n / matched.size) : 0, isNumber: /^\d/.test(word) }
  })
  const scored = []
  index.docs.forEach((doc, position) => {
    const found = hits.filter(hit => hit.matched.has(position))
    if (!found.some(hit => !hit.isNumber)) return
    scored.push({ product: doc.product, score: found.reduce((sum, hit) => sum + hit.weight, 0) })
  })
  return scored.sort((a, b) => b.score - a.score || (b.product.orders30d ?? 0) - (a.product.orders30d ?? 0)).slice(0, limit).map(item => item.product)
}

// When a message is about a store, a place or stock, the stores go with it; a product question gets them too.
const STORE_WORDS = /\b(?:toko|cabang|alamat|alamatnya|lokasi|lokasinya|dimana|mana|where|address|store|branch|buka|tutup|jam|open|close|dago|kopo|stok|stock|ready|tersedia|habis|kosong|ambil|pickup)\b/i
// An order question: only then are the sender's orders looked up. A false match costs one small query.
const ORDER_WORDS = /\b(?:pesanan\w*|pesenan\w*|orderan\w*|order|orderku|status|kirim|dikirim|terkirim|pengiriman|sampai|sampe|nyampe|nyampai|resi|paket\w*|datang|dateng|kurir|diantar|antar|diambil|batal|dibatalkan|cancel|checkout|belanjaan\w*)\b/i
export const isOrderQuestion = text => ORDER_WORDS.test(fold(text))
// Asks about a product: then a message that names none of the catalog's gets a note saying so.
const PRODUCT_QUESTION = /\b(?:harga\w*|berapa|brp|ada|stok|stock|ready|jual|dijual|beli|price|promo|diskon)\b/

/**
 * The sender's phone number in the database's format (+628…), from the chat's own addressing forms only: a PN JID
 * ("628…@s.whatsapp.net") among `chatIds` (the chat, the alt JID its messages carried, or linked records). A LID
 * whose number is not known gives none; so does a number that is not Indonesian.
 */
export function phoneFromChatIds (chatIds = []) {
  for (const id of chatIds) {
    const match = /^(62\d{8,13})@s\.whatsapp\.net$/.exec(String(id ?? ''))
    if (match) return `+${match[1]}`
  }
  return undefined
}

const rupiah = amount => `Rp ${Math.round(Number(amount)).toLocaleString('id-ID')}`
// "2026-09-30 21:30" (Asia/Jakarta) → "30-09-2026 21.30", the way the guards read a date and a clock time.
const localStamp = stamp => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(stamp ?? ''))
  return match ? `${match[3]}-${match[2]}-${match[1]} ${match[4]}.${match[5]}` : ''
}
const STOCK_LABELS = { tersedia: 'stok tersedia', sedikit: 'stok sedikit', habis: 'stok habis', unknown: 'stok belum diketahui' }
const storeLabel = store => (store.area && !fold(store.name).includes(fold(store.area)) ? `${store.name} (${store.area})` : store.name)

export function productFact (product, storesById, stockAsOf) {
  const unit = product.unit ? ` per ${product.unit}` : ''
  const perStore = product.stores.map(entry => {
    const store = storesById.get(entry.storeId)
    let price = `${rupiah(entry.price)}${unit}`
    if (entry.normalPrice) price += ` (promo ${entry.promo}${entry.promoEnds ? ` s.d. ${localStamp(entry.promoEnds)} WIB` : ''}; harga normal ${rupiah(entry.normalPrice)}${unit})`
    if (entry.promoEveryN) price += ` (promo ${entry.promo} berlaku per kelipatan ${entry.promoEveryN})`
    return `${store ? storeLabel(store) : `toko ${entry.storeId}`} ${price}, ${STOCK_LABELS[entry.stock] ?? STOCK_LABELS.unknown}`
  })
  const asOf = stockAsOf ? ` (stok per ${localStamp(stockAsOf)} WIB)` : ''
  return `Produk ${product.title}: ${perStore.join('; ')}${asOf}.${product.url ? ` Beli online di www.bormadago.com: ${product.url}` : ''}`
}

export const storeFact = store => `Toko ${storeLabel(store)}: ${store.address ?? 'alamat belum ada di data'}.`

// Order statuses in the customer app's Indonesian (ts/assets/i18n/order/id.json), with what each means for the
// customer; shipping events by type id (order_shippingeventtype). No note, courier or payment id ever goes in.
const STATUS_LABELS = {
  'Ready for payment': 'Siap untuk Pembayaran (pembayaran belum selesai)',
  'Awaiting payment': 'Menunggu Pembayaran (pembayaran belum diterima)',
  'Payment failure': 'Pembayaran Gagal (pembayaran tidak selesai tepat waktu)',
  Paid: 'Sudah Dibayar (pesanan sedang disiapkan)',
  'Ready for shipping': 'Siap untuk Dikirim (pesanan sudah dikemas)',
  'Awaiting shipping': 'Menunggu Pengiriman (menunggu kurir, atau siap diambil bila ambil sendiri)',
  'In shipping': 'Sedang Dikirim (pesanan sedang dibawa kurir)',
  'Shipping failure': 'Pengiriman Gagal',
  Complete: 'Selesai',
  Cancelled: 'Batal'
}
const SHIPPING_LABELS = {
  'self-pickup': 'ambil sendiri di toko',
  'biteship:grab:instant': 'dikirim dengan Grab Express',
  'biteship:grab:instant_car': 'dikirim dengan Grab Car Express',
  'biteship:lalamove:mpv': 'dikirim dengan Lalamove MPV',
  'biteship:lalamove:van': 'dikirim dengan Lalamove Van',
  'biteship:lalamove:truck': 'dikirim dengan Lalamove Truk Boks'
}
const EVENT_LABELS = { 1: 'kurir sudah dipesan', 2: 'pemesanan kurir dimulai', 4: 'pesanan siap diambil' }

export function orderFacts (rows, storesById) {
  const facts = [[`F${ORDER_BASE}`, rows.length === 0
    ? 'Tidak ada pesanan online (bormadago.com) dengan nomor WhatsApp pengirim ini dalam 30 hari terakhir. Belanja di kasir toko tidak tercatat per nomor WhatsApp.'
    : `Pesanan online (bormadago.com) dengan nomor WhatsApp pengirim ini dalam 30 hari terakhir: ${rows.length === MAX_ORDERS ? `${MAX_ORDERS} terbaru` : `${rows.length} pesanan`}. Belanja di kasir toko tidak tercatat per nomor WhatsApp.`]]
  rows.forEach((row, index) => {
    const store = storesById.get(Number(row.facility_id))
    const shipping = Number(row.shipping) > 0 ? `, termasuk ongkir ${rupiah(row.shipping)}` : ''
    const event = EVENT_LABELS[Number(row.last_event_type)]
    facts.push([`F${ORDER_BASE + 1 + index}`, `Pesanan ${row.number} (dibuat ${row.created} WIB${store ? `, ${storeLabel(store)}` : ''}): status ${STATUS_LABELS[row.status] ?? row.status}. ` +
      `Total ${rupiah(row.total)}${shipping}. ${SHIPPING_LABELS[row.shipping_code] ?? 'pengiriman: lihat detail pesanan'}` +
      `${event && row.last_event_at ? `; update pengiriman terakhir: ${event} ${row.last_event_at} WIB` : ''}. ` +
      `Detail: https://www.bormadago.com/shop/order/detail/${row.number}`])
  })
  return facts
}

// The sender's own recent online orders. The user row is deduped first (auth_user is a CDC ledger: a number the user
// has since changed must not match), staff accounts never match (in-store orders belong to cashiers), and only
// Online orders count. The date_paid_cache predicate prunes order_order's partitions (556 MB without it).
const LATEST = alias => `QUALIFY ROW_NUMBER() OVER (PARTITION BY ${alias}id ORDER BY ${alias}datastream_metadata.source_timestamp DESC, ${alias}datastream_metadata.change_sequence_number DESC) = 1`
export const ORDERS_SQL = `
WITH u AS (
  SELECT id FROM (
    SELECT id, phone_number, is_staff, datastream_metadata.change_type ct FROM \`solvent-staging.production_append_public.auth_user\` WHERE TRUE ${LATEST('')})
  WHERE ct != 'DELETE' AND NOT is_staff AND phone_number IN (@p1, @p2, @p3)
),
o AS (
  SELECT o.id, o.number, o.status, o.date_created, o.total_incl_tax, o.shipping_incl_tax, o.shipping_code, o.facility_zone_id
  FROM \`solvent-staging.production_merge_public.order_order\` o JOIN u ON u.id = o.user_id
  WHERE o.platform = 'Online'
    AND o.date_created >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    AND (o.date_paid_cache >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) OR o.date_paid_cache IS NULL)
  QUALIFY ROW_NUMBER() OVER (ORDER BY o.date_created DESC) <= ${MAX_ORDERS}
),
ev AS (
  SELECT order_id, ARRAY_AGG(STRUCT(event_type_id, date_created) ORDER BY date_created DESC LIMIT 1)[OFFSET(0)] last_event
  FROM (
    SELECT se.order_id, se.event_type_id, se.date_created, se.datastream_metadata.change_type ct
    FROM \`solvent-staging.production_append_public.order_shippingevent\` se JOIN o ON o.id = se.order_id WHERE TRUE ${LATEST('se.')})
  WHERE ct != 'DELETE' GROUP BY order_id
)
SELECT o.number, o.status, FORMAT_TIMESTAMP('%d-%m-%Y %H.%M', o.date_created, 'Asia/Jakarta') created,
  CAST(o.total_incl_tax AS FLOAT64) total, CAST(o.shipping_incl_tax AS FLOAT64) shipping, o.shipping_code, fz.facility_id,
  ev.last_event.event_type_id last_event_type, FORMAT_TIMESTAMP('%d-%m-%Y %H.%M', ev.last_event.date_created, 'Asia/Jakarta') last_event_at,
  (SELECT COUNT(*) FROM u) matched_users
FROM o
LEFT JOIN \`solvent-staging.production_merge_public.facility_facilityzone\` fz ON fz.id = o.facility_zone_id
LEFT JOIN ev ON ev.order_id = o.id
ORDER BY o.date_created DESC`

/** The number in every format the database could hold it (all 16,611 real ones are +628…; the others cost nothing). */
export const phoneParams = phone => ({ p1: phone, p2: phone.slice(1), p3: `0${phone.slice(3)}` })

export function loadBormaData (dataDir) {
  const dir = path.join(dataDir, 'borma')
  const files = ['catalog.json', 'stores.json'].map(name => path.join(dir, name))
  const missing = files.filter(file => !existsSync(file))
  if (missing.length > 0) throw new Error(`borma.enabled is true but ${missing.join(', ')} is missing: run \`npm run export\` first`)
  const [catalog, { stores }] = files.map(file => JSON.parse(readFileSync(file, 'utf8')))
  return { catalog, stores }
}

/**
 * @param {object} deps
 * @param {{products: object[], stockAsOf?: string}} deps.catalog
 * @param {{id: number, name: string, area?: string, address?: string}[]} deps.stores
 * @param {Function} [deps.queryOrders]  (phone) → Promise<{ok, rows?, error?}>; the live bq query by default
 * @returns {{forBurst: (input: {text: string, historyText?: string, phone?: string}) => Promise<{facts: Map, lines: string[], notes: string[], summary: object}>}}
 */
export function createLookup ({ config, catalog, stores, queryOrders, now = () => Date.now() }) {
  const settings = config.borma ?? {}
  const index = buildIndex(catalog.products)
  const storesById = new Map(stores.map(store => [store.id, store]))
  const timeoutMs = settings.orderTimeoutMs ?? 8000
  const cacheMs = settings.orderCacheMs ?? 60_000
  // Product ids run from F100 and must stay below the stores' F400.
  const maxProducts = Math.min(Math.max(Number(settings.maxProducts) || 10, 1), 50)
  const runOrders = queryOrders ?? (phone => runBq({ sql: ORDERS_SQL, params: phoneParams(phone), projectId: settings.projectId ?? 'solvent-staging', maxRows: MAX_ORDERS, timeoutMs }))
  const cache = new Map() // phone → {at, promise}: one query per number per minute, also while one is in flight

  function ordersFor (phone) {
    for (const [key, entry] of cache) if (now() - entry.at > cacheMs) cache.delete(key)
    if (!cache.has(phone)) {
      // A timeout here too (runBq has its own): an injected or stuck query must not hold the customer's triage.
      let timer
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs + 500) })
      const promise = Promise.race([Promise.resolve().then(() => runOrders(phone)), timeout])
        .catch(error => ({ ok: false, error: error.message }))
        .then(result => {
          clearTimeout(timer)
          if (!result.ok) cache.delete(phone) // a failure is not remembered: the next message tries again
          return result
        })
      cache.set(phone, { at: now(), promise })
    }
    return cache.get(phone).promise
  }

  async function forBurst ({ text, historyText = '', phone }) {
    const facts = []
    const notes = []
    const summary = {}
    // A follow-up ("yang 1 liter berapa?") names no product: the customer's recent messages may.
    let products = matchProducts(index, text, maxProducts)
    if (products.length === 0 && historyText) products = matchProducts(index, historyText, maxProducts)
    products.forEach((product, position) => facts.push([`F${PRODUCT_BASE + position}`, productFact(product, storesById, catalog.stockAsOf)]))
    summary.products = products.length
    if (products.length === 0 && PRODUCT_QUESTION.test(fold(text))) notes.push('No product in the shop\'s catalog snapshot matches this message: its prices and stock are unknown.')
    if (products.length > 0 || STORE_WORDS.test(fold(text))) {
      for (const store of stores) facts.push([`F${STORE_BASE + store.id}`, storeFact(store)])
      summary.stores = stores.length
    }
    if (settings.orders !== false && isOrderQuestion(text)) {
      if (!phone) {
        notes.push('This chat\'s WhatsApp number is not known, so the sender\'s orders could not be looked up.')
        summary.orders = 'no_phone'
      } else {
        const result = await ordersFor(phone)
        const rows = result.ok ? result.rows : []
        if (!result.ok || rows.some(row => Number(row.matched_users) > 1)) {
          notes.push('The sender\'s orders could not be looked up right now.')
          summary.orders = `failed:${result.ok ? 'ambiguous_phone' : result.error}`
        } else {
          facts.push(...orderFacts(rows, storesById))
          summary.orders = rows.length
        }
      }
    }
    return {
      facts: new Map(facts),
      lines: facts.map(([id, fact]) => `[${id}] ${fact}`),
      notes,
      summary
    }
  }

  return { forBurst }
}

/** The knowledge the guards check one burst's answer against: knowledge.md's facts plus that burst's lookup facts. */
export function withLookup (knowledge, lookup) {
  if (!lookup || lookup.facts.size === 0) return knowledge
  return {
    ...knowledge,
    factsText: [knowledge.factsText, ...lookup.lines].join('\n'),
    facts: new Map([...knowledge.facts, ...lookup.facts])
  }
}
