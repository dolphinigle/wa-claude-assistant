// Borma demo (owner request 2026-09-30): Claude never types a URL. It writes link tags, and this renders each one
// into an exact page of www.bormadago.com built from our own export, so every link a customer gets is one we made:
//   [[cari: minyak goreng]]  the shop's search for 1-5 plain words (letters, digits, spaces)
//   [[produk: 32613]]        a product's page, only for a product of the export that is sold online
//   [[kategori: 1528]]       a category's page, only for a category of the export
//   [[promo]]                the promo list; [[promo: 8179]] one advertised promo of the export
// A tag that cannot become one of these (an unknown id, a search with other characters) is dropped without a trace,
// never guessed. The routes are the shop's own (solui, ts/libs/*/feature-shell, checked 2026-09-30): product/list?q=,
// product/:productId/:slug, category/detail/:categoryId/:slug, promo/list, promo/detail/:promoId. The guards accept
// exactly the URLs rendered here (allowedUrls): a URL Claude wrote itself stays unsupported.

const SHOP = 'https://www.bormadago.com/shop'
// Anything between double brackets on one line is a tag; what it holds is checked below. The prompt shows tags as
// code, so backticks Claude copies around one go with it.
const TAG = /`?\[\[([^[\]\n]*)\]\]`?/g
const PARTS = /^\s*(\p{L}+)\s*(?::\s*(.*?))?\s*$/u
const KINDS = { cari: 'cari', search: 'cari', produk: 'produk', product: 'produk', kategori: 'kategori', category: 'kategori', promo: 'promo' }
const SEARCH_WORDS = /^[a-z0-9]+(?: [a-z0-9]+){0,4}$/
const ID = /^\d{1,9}$/
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
// Stands in for a dropped tag while its line is tidied.
const GONE = '\u0000'

const fold = text => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

const indexes = new WeakMap()
/** The export's pages by id: products sold online, categories with a slug, advertised promos. */
function linkIndex (catalog) {
  if (!catalog || typeof catalog !== 'object') return { products: new Map(), categories: new Map(), promos: new Set() }
  if (!indexes.has(catalog)) {
    const products = new Map()
    const promos = new Set()
    for (const product of catalog.products ?? []) {
      // The export builds the URL only for what is sold online; any other value is not ours.
      if (typeof product.url === 'string' && product.url.startsWith(`${SHOP}/product/${product.id}/`)) products.set(String(product.id), product.url)
      for (const entry of product.stores ?? []) if (entry.promoId) promos.add(String(entry.promoId))
    }
    const categories = new Map((catalog.categories ?? []).filter(category => SLUG.test(String(category.slug ?? '')))
      .map(category => [String(category.id), `${SHOP}/category/detail/${category.id}/${category.slug}`]))
    indexes.set(catalog, { products, categories, promos })
  }
  return indexes.get(catalog)
}

/** The URL a tag's inside stands for, or undefined. */
function urlFor (inside, index) {
  const [, rawKind, rawValue] = PARTS.exec(inside) ?? []
  const kind = KINDS[fold(rawKind ?? '')]
  const value = rawValue === undefined ? '' : fold(rawValue).replace(/^["'“”‘’](.*)["'“”‘’]$/u, '$1').trim()
  if (kind === 'cari') return SEARCH_WORDS.test(value) ? `${SHOP}/product/list?q=${encodeURIComponent(value)}` : undefined
  if (kind === 'promo' && value === '') return `${SHOP}/promo/list`
  if (!ID.test(value)) return undefined
  const id = String(Number(value))
  if (kind === 'produk') return index.products.get(id)
  if (kind === 'kategori') return index.categories.get(id)
  if (kind === 'promo') return index.promos.has(id) ? `${SHOP}/promo/detail/${id}` : undefined
  return undefined
}

/**
 * A line that lost a tag, tidied: "Semua hasil gula: [[cari: gula!]]" goes whole (a lead-in without a digit, now
 * pointing at nothing), "- Gulaku Rp 17.500 [[produk: 9]]" keeps its product, "(link: )" and stray spaces go. A line
 * left without a letter or digit goes too. Returns undefined for a line to remove.
 */
function tidyLine (line) {
  const leadIn = /^([^\n]*):[ \t]*\u0000[\s\u0000.,;!?]*$/.exec(line)
  if (leadIn && !/\d/.test(leadIn[1]) && !/https?:\/\//.test(leadIn[1])) return undefined
  const indent = /^[ \t]*/.exec(line)[0]
  const tidied = indent + line.replace(/[ \t]*\u0000/g, '')
    .replace(/\((?:[^()\p{L}\p{N}]*|\s*link\s*:?\s*)\)/giu, '')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+([,.;:!?)])/g, '$1')
    .replace(/[ \t]*[:=→–—-]+[ \t]*$/u, '')
    .trim()
  return /[\p{L}\p{N}]/u.test(tidied) ? tidied : undefined
}

/**
 * @param {string} text  Claude's reply
 * @param {{catalog?: {products?: object[], categories?: object[]}}} [options]  the Borma export (lookup.catalog())
 * @returns {{text: string, urls: string[], dropped: string[]}}  `urls`: every URL rendered, for the guards;
 *   `dropped`: the tags left out, as written, for the log
 */
export function renderLinks (text, { catalog } = {}) {
  const index = linkIndex(catalog)
  const urls = []
  const dropped = []
  let removed = false
  const lines = String(text ?? '').split('\n').map(line => {
    let lost = false
    const rendered = line.replace(TAG, (tag, inside, offset, whole) => {
      const url = urlFor(inside, index)
      if (!url) {
        dropped.push(tag)
        lost = true
        return GONE
      }
      urls.push(url)
      // Never glued to a word ("Rp 3.500https://…" reads as one token, to the customer's app and to the guards).
      const before = offset > 0 && !/[\s(]/.test(whole[offset - 1]) ? ' ' : ''
      const after = /[\p{L}\p{N}]/u.test(whole[offset + tag.length] ?? '') ? ' ' : ''
      return `${before}${url}${after}`
    })
    if (!lost) return rendered
    const tidied = tidyLine(rendered)
    if (tidied === undefined) removed = true
    return tidied
  }).filter(line => line !== undefined)
  let out = lines.join('\n')
  if (removed) out = out.replace(/\n{3,}/g, '\n\n').trim()
  return { text: out, urls: [...new Set(urls)], dropped }
}

/**
 * A triage result with its reply's tags rendered, and the URLs for the guards. The holding reply is left as written:
 * it must stay link-free, and a tag left in it fails its guard (a placeholder).
 */
export function renderTriageLinks (result, { catalog } = {}) {
  const triage = result?.triage
  if (typeof triage?.reply !== 'string') return { result, urls: [], dropped: [] }
  const { text, urls, dropped } = renderLinks(triage.reply, { catalog })
  return { result: { ...result, triage: { ...triage, reply: text } }, urls, dropped }
}
