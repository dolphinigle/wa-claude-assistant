// `npm run export`: the Borma demo's read-only snapshot from BigQuery (bq CLI) → data/borma/catalog.json and
// stores.json. data/ is gitignored: no company data is committed. Prints counts only.
// The best sellers of the last 30 days per store (product_stats_daily, no order rows), with every store's selling
// price, the current promo price and a stock status; only customer-facing fields (docs: the scout's data spec). The
// category and its parent ("MAKANAN KECIL > KERIPIK") let a search for "snack" find products whose titles don't say
// it; the page URL (shop/product/{id}/{slug}, solui PRODUCT_DETAIL in the monorepo) is kept only for what is sold online.
// --top=N best sellers per store (default 300), --dry-run prints the bytes each query would scan and exits.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { runBq } from '../src/bq.js'
import { loadConfig } from '../src/config.js'
import { writeFileAtomic } from '../src/store.js'

const argValue = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const top = Number(argValue('top') ?? 300)
const dryRun = process.argv.includes('--dry-run')
if (!Number.isInteger(top) || top < 1 || top > 2000) throw new Error('--top must be a whole number from 1 to 2000')

const config = loadConfig()
const projectId = config.borma?.projectId ?? 'solvent-staging'
const outDir = path.join(config.paths.data, 'borma')

// Tables that exist only as a CDC ledger need the latest row per id, and no deleted one.
const latest = (table, columns = '*') => `(SELECT ${columns} FROM \`solvent-staging.${table}\` WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY datastream_metadata.source_timestamp DESC, datastream_metadata.change_sequence_number DESC) = 1
    AND datastream_metadata.change_type != 'DELETE')`

// Visible to customers: active, public, a public category, not age-walled (settings.AGE_WALLED_CATEGORY_IDS), priced.
// The promo price follows promo_product_line_calculator for per-unit discounts; a promo every n units only shows as a
// note. Stock is a status, never the count (business data): weighed goods (upc 19xxxxx) count grams.
const CATALOG_SQL = `
WITH cat AS ${latest('production_append_public.catalogue_category', 'id, path, depth, name, is_public, ancestors_are_public, datastream_metadata')},
ppl AS ${latest('production_append_public.promo_promoproductline', 'id, promo_id, type, discount_type, discount_amount, discount_fraction, discount_price, discount_quantity_multiples, datastream_metadata')},
promo AS ${latest('production_append_public.promo_promo', 'id, name, name_id, date_end, datastream_metadata')},
priced AS (
  SELECT p.id product_id, p.title, p.slug, TRIM(CONCAT(COALESCE(CONCAT(parent.name, ' > '), ''), c.name)) category, ps.facility_id, ps.price price_normal,
    CASE WHEN ppl.type = 'discount' AND ppl.discount_quantity_multiples < 2 AND ppl.discount_type = 'fixed_price' THEN GREATEST(0, ppl.discount_price)
         WHEN ppl.type = 'discount' AND ppl.discount_quantity_multiples < 2 AND ppl.discount_type = 'calculated'
           THEN GREATEST(0, ps.price - (LEAST(ppl.discount_amount, ps.price) + (ps.price - LEAST(ppl.discount_amount, ps.price)) * ppl.discount_fraction))
         ELSE ps.price END price_now,
    IF(ppl.type = 'discount', COALESCE(NULLIF(pr.name_id, ''), pr.name), NULL) promo_name,
    IF(ppl.type = 'discount', pr.date_end, NULL) promo_ends,
    IF(ppl.type = 'discount' AND ppl.discount_quantity_multiples >= 2, ppl.discount_quantity_multiples, NULL) promo_every_n,
    (NOT p.is_offline_only AND p.price_sell_online_id = ps.id) sold_online,
    (LENGTH(p.upc) = 7 AND STARTS_WITH(p.upc, '19')) is_weighed
  FROM \`solvent-staging.production_merge_public.catalogue_product\` p
  JOIN \`solvent-staging.production_merge_public.price_sell_pricesell\` ps ON ps.product_id = p.id
  JOIN cat c ON c.id = p.main_category_id
  LEFT JOIN cat parent ON parent.depth = c.depth - 1 AND parent.depth > 1 AND STARTS_WITH(c.path, parent.path)
  LEFT JOIN ppl ON ppl.id = ps.promo_product_line_active_id
  LEFT JOIN promo pr ON pr.id = ppl.promo_id
  WHERE p.is_active AND p.is_public AND ps.price > 0 AND c.is_public AND c.ancestors_are_public
    AND p.main_category_id NOT IN (17, 115, 117, 145, 931, 932, 933, 934)
),
sales AS (
  SELECT product_id, facility_id, SUM(sales_order_count) orders_30d
  FROM \`solvent-staging.production_statistics.product_stats_daily\`
  WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Jakarta'), INTERVAL 30 DAY)
  GROUP BY 1, 2 HAVING orders_30d > 0
),
chosen AS (
  SELECT DISTINCT product_id FROM (
    SELECT pr.product_id, pr.facility_id, s.orders_30d FROM priced pr JOIN sales s USING (product_id, facility_id)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY pr.facility_id ORDER BY s.orders_30d DESC, pr.product_id) <= @top)
)
SELECT pr.product_id, pr.title, pr.slug, pr.category, pr.facility_id, CAST(pr.price_normal AS FLOAT64) price_normal, CAST(pr.price_now AS FLOAT64) price_now,
  pr.promo_name, FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', pr.promo_ends, 'Asia/Jakarta') promo_ends, pr.promo_every_n, pr.sold_online, pr.is_weighed,
  COALESCE(s.orders_30d, 0) orders_30d,
  CASE WHEN inv.product_id IS NULL THEN 'unknown'
       WHEN inv.quantity_available <= 0 THEN 'habis'
       WHEN inv.quantity_available <= IF(pr.is_weighed, 1000, 5) THEN 'sedikit'
       ELSE 'tersedia' END stock
FROM priced pr
JOIN chosen USING (product_id)
LEFT JOIN sales s USING (product_id, facility_id)
LEFT JOIN \`solvent-staging.production_merge_public.inventory_inventoryfacility\` inv ON inv.product_id = pr.product_id AND inv.facility_id = pr.facility_id
ORDER BY pr.product_id, pr.facility_id`

// How old the stock is: the CDC merge runs 15-30 min behind the shop.
const STOCK_AS_OF_SQL = `SELECT FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', TIMESTAMP_MILLIS(MAX(datastream_metadata.source_timestamp)), 'Asia/Jakarta') stock_as_of
FROM \`solvent-staging.production_merge_public.inventory_inventoryfacility\``

const STORES_SQL = `
SELECT f.id, f.code, f.name, m.title_in_tables store_name, m.address_in_tables address
FROM \`solvent-staging.production_merge_public.facility_facility\` f
LEFT JOIN ${latest('production_append_public.facility_facilitymeta')} m ON m.facility_id = f.id
ORDER BY f.id`

const queries = [
  { name: 'catalog', sql: CATALOG_SQL, params: { top }, maxRows: 20 * top + 100 },
  { name: 'stockAsOf', sql: STOCK_AS_OF_SQL, maxRows: 1 },
  { name: 'stores', sql: STORES_SQL, maxRows: 100 }
]

const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`
const results = {}
for (const query of queries) {
  const dry = await runBq({ ...query, projectId, dryRun: true })
  if (!dry.ok) throw new Error(`${query.name} dry run failed: ${dry.error}`)
  console.log(`${query.name}: dry run ${mb(dry.bytes)}`)
  if (dryRun) continue
  const started = Date.now()
  const result = await runBq({ ...query, projectId, timeoutMs: 180_000 })
  if (!result.ok) throw new Error(`${query.name} failed: ${result.error}`)
  results[query.name] = result.rows
  console.log(`${query.name}: ${result.rows.length} row(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}
if (dryRun) process.exit(0)

const exportedAt = new Date().toISOString()
const stockAsOf = results.stockAsOf[0]?.stock_as_of ?? null
const stores = results.stores.map(row => ({
  id: Number(row.id),
  code: row.code,
  // The name customers see (facility_facilitymeta); the internal name (Dago, Kopo) says which area it is in.
  name: row.store_name || `Borma ${row.name}`,
  area: row.name,
  address: row.address ?? null
}))

// Size and unit sit only in the title ("INDOMIE GORENG SPECIAL 85 GR"): the last number with a unit is the size.
const SIZE = /(\d+(?:[.,]\d+)?)\s?(KG|GR|GRM|GRAM|G|MG|ML|LTR|LT|L|CC|PCS|PC|S|SHEETS?|LBR|M|CM)(?![A-Z])/gi
const sizeOf = title => [...String(title).matchAll(SIZE)].map(match => `${match[1]} ${match[2].toUpperCase()}`).at(-1) ?? null
const number = value => Math.round(Number(value) * 100) / 100
// bq's JSON gives every value as a string: "false" is truthy.
const yes = value => value === true || value === 'true'

const products = new Map()
for (const row of results.catalog) {
  const id = Number(row.product_id)
  if (!products.has(id)) {
    products.set(id, {
      id,
      title: row.title,
      category: row.category ?? null,
      size: yes(row.is_weighed) ? '1 KG' : sizeOf(row.title),
      // Weighed goods are priced per gram: shown per kg.
      unit: yes(row.is_weighed) ? 'kg' : null,
      url: null,
      orders30d: 0,
      stores: []
    })
  }
  const product = products.get(id)
  const perUnit = yes(row.is_weighed) ? 1000 : 1
  const priceNow = Math.round(number(row.price_now) * perUnit)
  const priceNormal = Math.round(number(row.price_normal) * perUnit)
  if (yes(row.sold_online) && row.slug) product.url = `https://www.bormadago.com/shop/product/${id}/${row.slug}`
  product.orders30d += Number(row.orders_30d ?? 0)
  product.stores.push({
    storeId: Number(row.facility_id),
    price: priceNow,
    ...(priceNow < priceNormal && { normalPrice: priceNormal, promo: row.promo_name ?? 'promo', promoEnds: row.promo_ends ?? null }),
    ...(row.promo_every_n && { promoEveryN: Number(row.promo_every_n), promo: row.promo_name ?? 'promo', promoEnds: row.promo_ends ?? null }),
    stock: row.stock
  })
}
const catalog = {
  exportedAt,
  stockAsOf,
  source: 'BigQuery solvent-staging (production_merge_public, production_statistics); read-only export',
  topPerStore: top,
  products: [...products.values()].sort((a, b) => b.orders30d - a.orders30d)
}

mkdirSync(outDir, { recursive: true, mode: 0o700 })
writeFileAtomic(path.join(outDir, 'catalog.json'), `${JSON.stringify(catalog)}\n`)
writeFileAtomic(path.join(outDir, 'stores.json'), `${JSON.stringify({ exportedAt, stores }, null, 1)}\n`)

const perStore = stores.map(store => {
  const rows = catalog.products.flatMap(product => product.stores.filter(entry => entry.storeId === store.id))
  const count = kind => rows.filter(entry => entry.stock === kind).length
  return `${store.area}: ${rows.length} priced (tersedia ${count('tersedia')}, sedikit ${count('sedikit')}, habis ${count('habis')}, unknown ${count('unknown')}, promo ${rows.filter(entry => entry.normalPrice).length})`
})
console.log(`\nwrote ${path.relative(config.rootDir, outDir)}/catalog.json: ${catalog.products.length} products (top ${top} per store), ${catalog.products.filter(product => product.url).length} sold online, ${catalog.products.filter(product => product.unit === 'kg').length} weighed`)
for (const line of perStore) console.log(`  ${line}`)
console.log(`wrote ${path.relative(config.rootDir, outDir)}/stores.json: ${stores.length} stores`)
console.log(`exported ${exportedAt}, stock as of ${stockAsOf} WIB`)
