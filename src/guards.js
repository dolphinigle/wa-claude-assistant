// Deterministic checks on a reply before it may be auto-sent. They do not judge meaning; they make sure every
// concrete detail (number, price, time, phone, URL, email) is copied from `## Facts`, so a model slip becomes a
// draft instead of a wrong promise. When unsure they fail, which only means the owner sees a draft.

const THOUSANDS = /^\d{1,3}(?:[.,]\d{3})+$/
const MULTIPLIERS = { rb: 1e3, ribu: 1e3, k: 1e3, jt: 1e6, juta: 1e6 }

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|id|net|org|ly|me|io|co|link|shop|store|site|xyz|app|gl|to)\b(?:\/[^\s<>()]*)?/gi
const PHONE = /(?<![\w])(?:\+|0)\d[\d -]{7,}\d(?![\w])/g
const CLOCK = /(?<![\d.,:])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d])(?:\s?([ap])\.?m\b\.?)?/gi
const HOUR_AMPM = /(?<![\d.,:])(1[0-2]|0?[1-9])\s?([ap])\.?m\b\.?/gi
const MONEY_PREFIX = /(?:\brp\.?|\bidr)\s*(\d[\d.,]*\d|\d)(?:\s*(rb|ribu|k|jt|juta)\b)?/gi
const MONEY_SUFFIX = /(?<![\d.,])(\d[\d.,]*\d|\d)\s*(rb|ribu|k|jt|juta)\b/gi
const THOUSANDS_NUMBER = /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![\d])/g
const NUMBER = /\d+(?:[.,]\d+)?/g

function parseDecimal (text) {
  if (THOUSANDS.test(text)) return Number(text.replace(/[.,]/g, ''))
  return Number(text.replace(',', '.'))
}

function toMinutes (hour, minute, meridiem) {
  let h = Number(hour)
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'p'
    if (pm && h < 12) h += 12
    if (!pm && h === 12) h = 0
  }
  return h * 60 + Number(minute)
}

const normalizeUrl = url => url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,!?;:)\]/]+$/, '')
const normalizePhone = phone => phone.replace(/\D/g, '').replace(/^0/, '62')

/** Extracts concrete details from text. Matched spans are blanked so later passes don't double count. */
export function extractDetails (input) {
  let text = String(input ?? '')
  const details = { urls: [], emails: [], phones: [], times: [], amounts: [], numbers: [] }
  const take = (pattern, handle) => {
    text = text.replace(pattern, (...match) => {
      const keep = handle(...match)
      return keep === false ? match[0] : ' '.repeat(match[0].length)
    })
  }
  take(EMAIL, email => { details.emails.push(email.toLowerCase()) })
  take(URL, url => { details.urls.push(normalizeUrl(url)) })
  take(PHONE, phone => {
    if (phone.replace(/\D/g, '').length < 9) return false
    details.phones.push(normalizePhone(phone))
  })
  take(CLOCK, (_, hour, minute, meridiem) => { details.times.push(toMinutes(hour, minute, meridiem)) })
  take(HOUR_AMPM, (_, hour, meridiem) => { details.times.push(toMinutes(hour, 0, meridiem)) })
  take(MONEY_PREFIX, (_, amount, unit) => { details.amounts.push(Math.round(parseDecimal(amount) * (MULTIPLIERS[unit?.toLowerCase()] ?? 1))) })
  take(MONEY_SUFFIX, (_, amount, unit) => { details.amounts.push(Math.round(parseDecimal(amount) * MULTIPLIERS[unit.toLowerCase()])) })
  take(THOUSANDS_NUMBER, amount => { details.amounts.push(parseDecimal(amount)) })
  take(NUMBER, number => { details.numbers.push(parseDecimal(number)) })
  return details
}

const allowListCache = new WeakMap()

/** What an auto-reply may mention: details found in the `## Facts` section, plus harmless equivalents. */
export function buildAllowList (knowledge) {
  if (allowListCache.has(knowledge)) return allowListCache.get(knowledge)
  // Fact ids ([F1], [F2], ...) are labels, not facts: their digits must not whitelist numbers.
  const details = extractDetails(knowledge.factsText.replace(/\[F\d+\]/gi, ' '))
  const numbers = new Set(details.numbers)
  for (const minutes of details.times) {
    const hour = Math.floor(minutes / 60)
    numbers.add(hour) // "jam 8" for 08.00
    if (hour > 12) numbers.add(hour - 12) // "5 sore" for 17.00
  }
  const allow = {
    urls: new Set(details.urls),
    emails: new Set(details.emails),
    phones: new Set(details.phones),
    times: new Set(details.times),
    amounts: new Set(details.amounts),
    numbers,
    factsLower: knowledge.factsText.toLowerCase()
  }
  allowListCache.set(knowledge, allow)
  return allow
}

const PLACEHOLDERS = [
  /\{\{|\}\}/,
  /\[(?:[A-Z_ ]{3,}|[^\]]*\b(?:nama|name|harga|price|tanggal|date|alamat|address|nomor|number|link|url)\b[^\]]*)\]/i,
  /<[^<>\n]{1,40}>/,
  /\b(?:TODO|TBD|XXX|lorem ipsum)\b/i,
  /_{3,}/
]

// Small function-word lists: enough to tell an Indonesian reply from an English one, nothing more.
const LANGUAGE_WORDS = {
  id: 'yang dan di ke dari ini itu ada tidak nggak gak bisa kami kita saya aku untuk dengan buka tutup harga berapa mau ya sudah belum jam hari pesan kirim terima kasih makasih dong apa gimana bagaimana boleh tolong sampai pukul hanya juga atau karena kalau sama setiap',
  en: 'the and is are we you your our to of for what where when how do does can could would have has open closed price please thanks thank hi hello it in on at from with this that my me i be will yes order pick up located hours'
}
const LANGUAGE_SETS = Object.fromEntries(Object.entries(LANGUAGE_WORDS).map(([language, words]) => [language, new Set(words.split(' '))]))

/** 'id' | 'en' | 'unknown' — only confident when one language clearly dominates. */
export function detectLanguage (text) {
  const words = String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? []
  const count = language => words.filter(word => LANGUAGE_SETS[language].has(word)).length
  const id = count('id')
  const en = count('en')
  if (id + en < 3) return 'unknown'
  if (id >= 2 * en) return 'id'
  if (en >= 2 * id) return 'en'
  return 'unknown'
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const containsTerm = (haystack, term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)

/**
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkReply ({ reply, factsUsed, incomingText }, { knowledge, maxReplyChars = 600, sensitiveTerms = [] }) {
  const reasons = []
  const text = String(reply ?? '').trim()
  if (!text) return { ok: false, reasons: ['empty_reply'] }
  if (text.length > maxReplyChars) reasons.push(`too_long:${text.length}>${maxReplyChars}`)
  if (/\[F\d+\]/i.test(text)) reasons.push('fact_id_in_reply')
  else if (PLACEHOLDERS.some(pattern => pattern.test(text))) reasons.push('placeholder')

  if (!Array.isArray(factsUsed) || factsUsed.length === 0) {
    reasons.push('no_facts_used')
  } else {
    const unknown = factsUsed.filter(id => !knowledge.facts.has(String(id).replace(/[[\]\s]/g, '').toUpperCase()))
    if (unknown.length > 0) reasons.push(`unknown_fact:${unknown.join(',')}`)
  }

  const allow = buildAllowList(knowledge)
  const details = extractDetails(text)
  const check = (kind, values, allowed) => {
    const missing = [...new Set(values.filter(value => !allowed.has(value)))]
    if (missing.length > 0) reasons.push(`unsupported_${kind}:${missing.join(',')}`)
  }
  check('url', details.urls, allow.urls)
  check('email', details.emails, allow.emails)
  check('phone', details.phones, allow.phones)
  check('time', details.times.map(minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`),
    new Set([...allow.times].map(minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`)))
  check('amount', details.amounts, allow.amounts)
  check('number', details.numbers, allow.numbers)

  for (const term of sensitiveTerms) {
    if (containsTerm(text, term) && !containsTerm(allow.factsLower, term)) reasons.push(`sensitive_term:${term}`)
  }

  // Voice says mirror the sender's language; an auto-reply in the other language goes to the owner instead.
  if (incomingText !== undefined) {
    const incoming = detectLanguage(incomingText)
    const replied = detectLanguage(text)
    if (incoming !== 'unknown' && replied !== 'unknown' && incoming !== replied) reasons.push(`language_mismatch:${incoming}->${replied}`)
  }
  return { ok: reasons.length === 0, reasons }
}

/** Guards for a triage result: only a "simple" reply can be auto-sent, so only it is checked. */
export function guardTriage (triage, { knowledge, config, incomingText }) {
  if (triage?.category !== 'simple') return undefined
  return checkReply({ reply: triage.reply, factsUsed: triage.facts_used, incomingText }, { knowledge, ...config.guards })
}
