import os from 'node:os'

// Deterministic checks on a reply before it may be auto-sent. They do not judge meaning; they make sure every
// concrete detail (number, price, time, duration, percentage, phone, URL, email) is copied from the facts the reply
// cites in `facts_used`, so a model slip becomes a draft instead of a wrong promise. When unsure they fail, which
// only means the owner sees a draft.

const THOUSANDS = /^\d{1,3}(?:[.,]\d{3})+$/
const MULTIPLIERS = { rb: 1e3, ribu: 1e3, k: 1e3, jt: 1e6, juta: 1e6 }
const DURATION_UNITS = {
  detik: 's', dtk: 's', second: 's', seconds: 's', sec: 's', secs: 's',
  menit: 'min', mnt: 'min', minute: 'min', minutes: 'min', min: 'min', mins: 'min',
  jam: 'h', jm: 'h', hour: 'h', hours: 'h', hr: 'h', hrs: 'h',
  hari: 'd', day: 'd', days: 'd',
  minggu: 'w', mgg: 'w', pekan: 'w', week: 'w', weeks: 'w', wk: 'w', wks: 'w',
  bulan: 'mo', bln: 'mo', month: 'mo', months: 'mo',
  tahun: 'y', thn: 'y', year: 'y', years: 'y', yr: 'y', yrs: 'y'
}
const DAY_PARTS = { pagi: 'am', siang: 'noon', sore: 'pm', malam: 'night' }

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
// Any label.label token with an alphabetic TLD: failing closed beats keeping a list of TLDs up to date.
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/[^\s<>()]*)?/gi
const PHONE = /(?<![\w])(?:\+|0)\d[\d -]{7,}\d(?![\w])/g
const CLOCK = /(?<![\d.,:])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d])(?:\s?([ap])\.?m\b\.?)?/gi
const HOUR_AMPM = /(?<![\d.,:])(1[0-2]|0?[1-9])\s?([ap])\.?m\b\.?/gi
const HOUR_DAY_PART = /(?<![\d.,:])(?:\b(?:jam|pukul)\s*)?(\d{1,2})\s*(pagi|siang|sore|malam)\b/gi // jam 1 siang, 5 sore
const HOUR_BARE = /\b(?:jam|pukul)\s*(\d{1,2})(?!\d|[.,:]\d)/gi // jam 8: 08.00 or 20.00
const DURATION = new RegExp(`(?<![\\d.,])(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(DURATION_UNITS).join('|')})\\b`, 'gi')
const PERCENT = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:%|persen\b|percent\b)/gi
const MONEY_PREFIX = /(?:\brp\.?|\bidr)\s*(\d[\d.,]*\d|\d)(?:\s*(rb|ribu|k|jt|juta)\b)?/gi
const MONEY_SUFFIX = /(?<![\d.,])(\d[\d.,]*\d|\d)\s*(rb|ribu|k|jt|juta)\b/gi
const THOUSANDS_NUMBER = /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![\d])/g
// A number with a word that is not a known unit ("3 loyang", "3 fortnight") carries that word as its unit: it must
// appear with the same word in the cited facts. Words that only connect a bare number to the sentence are not units.
const QUANTITY = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(\p{L}+)(?![\p{L}\p{N}])/gu
const NOT_UNITS = new Set('ya yah kak kakak dan atau sampai hingga sd s x to and or until till dengan untuk ke di dari wib wita wit'.split(' '))
const NUMBER = /\d+(?:[.,]\d+)?/g
// "buka 8 sampai 5" may reuse the hour of a cited opening time as a bare number, but only next to a time word.
const TIME_WORDS = /\b(?:jam|pukul|buka|tutup|open|opens|close|closes|closed|wib|wita|wit)\b/i

// Numbers written as words carry no digits for the checks above ("seratus ribu", "seminggu", "one hundred"), so any
// such word must also appear in the cited facts. Common words like "satu" (salah satu) or "one" just mean a draft.
const NUMBER_WORDS = new Set(('nol satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas seratus seribu sejuta ' +
  'setengah seperempat sepertiga seperdua separuh separo lusin selusin sepasang ' +
  'sedetik semenit sejam sehari seminggu sepekan sebulan setahun zero one two three four five six seven eight nine ' +
  'ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy ' +
  'eighty ninety hundred thousand million dozen half quarter third fourth fifth once twice thrice double triple couple pair').split(' '))
const NUMBER_WORD_ENDINGS = /(?:belas|puluh|ratus|ribu|juta|miliar)(?:an)?$/ // duabelas, limapuluh, ratusan
const ORDINAL = /^ke(?:satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas|seratus|seribu)(?:nya)?$/ // kedua, ketiganya
const isNumberWord = word => NUMBER_WORDS.has(word) || NUMBER_WORD_ENDINGS.test(word) || ORDINAL.test(word)

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

function dayPartToMinutes (hour, dayPart) {
  let h = Number(hour)
  const part = DAY_PARTS[dayPart.toLowerCase()]
  if (part === 'am' && h === 12) h = 0
  if (part === 'noon' && h < 11) h += 12 // jam 1 siang = 13.00, jam 11/12 siang as is
  if ((part === 'pm' || part === 'night') && h < 12) h += 12
  if (part === 'night' && h === 12) h = 0
  return h * 60
}

/** The two readings of an hour without a day part ("jam 5": 05.00 or 17.00). */
const hourReadings = hour => [(hour % 24) * 60, ((hour % 12) + 12) * 60]

const normalizeUrl = url => url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,!?;:)\]/]+$/, '')
const normalizePhone = phone => phone.replace(/\D/g, '').replace(/^0/, '62')

/** NFKC turns fullwidth and other compatibility digits into ASCII; zero-width characters could split terms. */
export const normalizeText = input => String(input ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '')

/** Extracts concrete details from text. Matched spans are blanked so later passes don't double count. */
export function extractDetails (input) {
  let text = normalizeText(input)
  const details = { urls: [], emails: [], phones: [], times: [], hours: [], durations: [], percents: [], amounts: [], quantities: [], numbers: [], numberWords: [], otherDigits: false }
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
  take(HOUR_DAY_PART, (_, hour, dayPart) => { details.times.push(dayPartToMinutes(hour, dayPart)) })
  take(HOUR_BARE, (_, hour) => { details.hours.push(Number(hour)) })
  take(DURATION, (_, amount, unit) => { details.durations.push(`${parseDecimal(amount)} ${DURATION_UNITS[unit.toLowerCase()]}`) })
  take(PERCENT, (_, amount) => { details.percents.push(parseDecimal(amount)) })
  take(MONEY_PREFIX, (_, amount, unit) => { details.amounts.push(Math.round(parseDecimal(amount) * (MULTIPLIERS[unit?.toLowerCase()] ?? 1))) })
  take(MONEY_SUFFIX, (_, amount, unit) => { details.amounts.push(Math.round(parseDecimal(amount) * MULTIPLIERS[unit.toLowerCase()])) })
  take(THOUSANDS_NUMBER, amount => { details.amounts.push(parseDecimal(amount)) })
  take(QUANTITY, (_, amount, word) => {
    const unit = word.toLowerCase()
    if (NOT_UNITS.has(unit)) return false // left for the bare-number pass
    details.quantities.push(`${parseDecimal(amount)} ${unit}`)
  })
  take(NUMBER, number => { details.numbers.push(parseDecimal(number)) })
  details.numberWords = (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter(isNumberWord)
  details.otherDigits = /\p{Nd}/u.test(text) // digits of other scripts (٣, ३, …): nothing above can check them
  return details
}

const allowListCache = new WeakMap()
const factId = id => String(id).replace(/[[\]\s]/g, '').toUpperCase()

/**
 * What an auto-reply may mention: details found in the facts it cites (all of `## Facts` when `factIds` is not
 * given), plus harmless equivalents. A number from one fact does not license the same number anywhere else.
 */
export function buildAllowList (knowledge, factIds) {
  const ids = factIds === undefined ? undefined : [...new Set(factIds.map(factId))].filter(id => knowledge.facts.has(id)).sort()
  const key = ids ? ids.join(',') : '*'
  if (!allowListCache.has(knowledge)) allowListCache.set(knowledge, new Map())
  const cache = allowListCache.get(knowledge)
  if (cache.has(key)) return cache.get(key)

  // Fact ids ([F1], [F2], ...) are labels, not facts: their digits must not whitelist numbers.
  const factsText = ids ? ids.map(id => knowledge.facts.get(id)).join('\n') : knowledge.factsText.replace(/\[F\d+\]/gi, ' ')
  const details = extractDetails(factsText)
  const times = new Set([...details.times, ...details.hours.flatMap(hourReadings)])
  // Kinds stay apart: the 3 of "3 hari" or the 50 of "50%" never licenses a bare 3 or 50 ("minimal 3 loyang").
  const hourNumbers = new Set()
  for (const minutes of times) {
    const hour = Math.floor(minutes / 60)
    hourNumbers.add(hour) // "buka 8" for 08.00
    if (hour > 12) hourNumbers.add(hour - 12) // "sampai 5" for 17.00
  }
  const allow = {
    urls: new Set(details.urls),
    emails: new Set(details.emails),
    phones: new Set(details.phones),
    times,
    durations: new Set(details.durations),
    percents: new Set(details.percents),
    amounts: new Set(details.amounts),
    quantities: new Set(details.quantities),
    numbers: new Set(details.numbers),
    hourNumbers,
    numberWords: new Set(details.numberWords),
    factsLower: normalizeText(factsText).toLowerCase()
  }
  cache.set(key, allow)
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

// Two matchers on the customer's message, with opposite safe directions. Both match whole phrases from a vocabulary,
// so a word that only makes sense inside a phrase never counts alone: "no good" and "oh no" are not a thanks.
// - isThanks chooses the skip: a thanks right after a closing gets no reply and no notice (policy.js). It is narrow,
//   since a missed thanks only becomes a draft while a false match could drop a real message.
// - isSocialMessage holds the answer: whatever it cites, no answer to a thanks, a goodbye or a yes alone is auto-sent
//   (checkReply). It is broad, since a false match only becomes a draft while a miss could auto-send a promise: it
//   has no size limit, and it takes any text emoticon and laughter ("iya kak :D", "makasih kak hehe").
//
// isThanks needs a thanks or goodbye; an acknowledgement ("ok", "iya", "siap") or a 👍 may only go with one, since
// alone it can be a yes to something our side asked. Greetings are not in it: "Selamat pagi kak" opens a
// conversation, and "makasih kak, selamat siang" is a draft too. Neither is anything that can agree to, arrange or ask
// for something: "no problem", "anytime", "see you", "sampai jumpa", "hati-hati" (a warning too), "lagi" (more),
// "dong", or a bare "welcome".
const HONORIFICS = 'kak ka kakak mas mbak bu ibu pak bapak sis gan dear min'.split(' ')
const HAVE_A_NICE = ['nice', 'great', 'good', 'lovely'].flatMap(adjective => ['day', 'weekend', 'evening', 'night'].map(time => `have a ${adjective} ${time}`))
const THANKS_PHRASES = {
  closings: ['terima kasih kembali', 'terima kasih', 'terimakasih', 'makasih', 'makasi', 'mksh', 'trims', 'tengkyu', 'thx', 'tq', 'ty',
    'thank you too', 'thank you', 'thankyou', 'thanks', 'cheers', 'sama sama', 'you re welcome', 'youre welcome', 'you are welcome',
    'goodbye', 'good bye', 'bye', 'dadah', 'take care', 'good night', 'selamat tidur', 'sehat selalu', 'semoga harinya menyenangkan',
    ...HAVE_A_NICE, 'all the best', 'best wishes'],
  // Only next to a closing: "ok makasih kak", "siap, terima kasih", "great, thanks".
  acknowledgements: ['ok', 'oke', 'okay', 'okey', 'okee', 'oce', 'sip', 'siap', 'baik', 'noted', 'mantap', 'mantab', 'iya', 'yes', 'yup',
    'yep', 'alright', 'got it', 'understood', 'paham', 'great', 'nice', 'good', 'perfect', 'cool', 'lovely'],
  fillers: [...HONORIFICS, 'ya', 'yaa', 'deh', 'nih', 'juga', 'banyak', 'again', 'so much', 'very much', 'a lot', 'for your help',
    'for the help', 'for the info', 'infonya', 'you too', 'oh', 'oo', 'wah', 'and']
}
// Words that only answer a thanks. Claude's reply is held by them whatever the customer wrote, however the thanks was
// spelled (checkReply); "Terima kasih sudah menghubungi kami" opens ordinary answers, so a plain thanks is not one. The
// openers also answer a request ("No problem, kami kirim besok"), so only a reply that starts with one is held.
// isSocialMessage takes both lists too, so the customer's side never knows fewer of them than the reply's side.
const THANKS_BACK_PHRASES = ['sama sama', 'sama 2', 'terima kasih kembali', 'terimakasih kembali', 'makasih kembali', 'terima kasih juga',
  'makasih juga', 'thank you too', 'thanks too', 'you re welcome', 'you are welcome', 'your welcome', 'you re very welcome',
  'you re most welcome', 'you re so welcome', 'you are very welcome', 'you are most welcome', 'my pleasure', 'senang bisa membantu',
  'senang dapat membantu', 'senang membantu', 'glad to help', 'glad i could help', 'glad we could help', 'happy to help']
const THANKS_BACK_OPENERS = ['kembali kasih', 'no problem', 'no worries', 'anytime'] // "kami kembali kasih kabar" is no thanks-back

// isSocialMessage takes all of that, plus what agrees to, arranges or asks for something ("no problem", "see you", a
// yes alone: "iya kak", "boleh", "please", "lanjut", "👍"; "makasih, ditunggu ya"), greetings next to any of it, other
// spellings of a thanks, laughter, and repeated letters folded ("makasihh kakk"). A greeting alone is not social:
// "Selamat pagi kak" is answered like any other message.
const SOCIAL_PHRASES = {
  closings: [...THANKS_PHRASES.closings, ...THANKS_BACK_PHRASES, ...THANKS_BACK_OPENERS, 'thank', 'thank u', 'thanks u', 'thank s', 'thx u',
    'tks', 'mks', 'mksi', 'mksih', 'maksih', 'mkasih', 'makaseh', 'makaci', 'trimakasih', 'trima kasih', 'trmksh', 'trmks', 'tysm',
    'hatur nuhun', 'nuhun', 'matur nuwun', 'suwun', 'welcome', 'appreciated', 'much appreciated', 'appreciate it', 'i appreciate it',
    'see you', 'sampai jumpa', 'sampai ketemu', 'hati hati', 'you too'],
  acknowledgements: [...THANKS_PHRASES.acknowledgements, 'ya', 'yaa', 'y', 'yoi', 'sure', 'boleh', 'mau', 'bisa', 'setuju', 'deal',
    'sounds good', 'of course', 'mantul', 'please', 'pls', 'plz', 'jadi', 'fix', 'lanjut', 'gas', 'udah', 'sudah', 'yaudah', 'yasudah'],
  greetings: ['selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam', 'pagi', 'siang', 'sore', 'malam', 'good morning',
    'good afternoon', 'good evening', 'halo', 'hallo', 'hai', 'hi', 'hello', 'hey', 'salam'],
  fillers: [...THANKS_PHRASES.fillers.filter(phrase => !['ya', 'yaa', 'you too'].includes(phrase)), 'dong', 'lagi', 'soon', 'wow', 'banget',
    'bgt', 'sekali', 'ditunggu', 'dibantu', 'atas', 'bantuannya', 'informasinya', 'sangat', 'membantu', 'haha']
}

/**
 * A vocabulary: each phrase, its words folded by `fold` and joined by one space, maps to the bit of its kind. A phrase
 * listed (or folded) under two kinds would take the kind listed last, silently: it throws instead.
 */
function vocabulary (lists, fold = word => word) {
  const kinds = Object.fromEntries(Object.keys(lists).map((kind, index) => [kind, 1 << index]))
  const phrases = new Map()
  for (const [kind, list] of Object.entries(lists)) {
    for (const phrase of list.map(entry => entry.split(' ').map(fold).join(' '))) {
      if (phrases.has(phrase) && phrases.get(phrase) !== kinds[kind]) throw new Error(`guards: "${phrase}" is listed under two kinds`)
      phrases.set(phrase, kinds[kind])
    }
  }
  return { kinds, phrases, fold, longest: Math.max(...[...phrases.keys()].map(phrase => phrase.split(' ').length)) }
}
const THANKS_VOCABULARY = vocabulary(THANKS_PHRASES)
// Laughter is spelled a hundred ways (hehe, wkwkwk, ahahah, kwkw, lol): matched by its shape, it becomes the one filler
// "haha". Two syllables at least, so "hi" and "hai" stay greetings.
const LAUGHTER = /^(?:[aeiou]?(?:h[aeiou]){2,}h?|k?(?:wk)+w?|lol|xd)$/u
const SOCIAL_VOCABULARY = vocabulary(SOCIAL_PHRASES, word => {
  const folded = word.replace(/(\p{L})\1+/gu, '$1') // makasihh, kakk, okee
  return LAUGHTER.test(folded) ? 'haha' : folded
})

/**
 * The kinds of phrases each way of splitting the words into phrases of the vocabulary uses, as bitmasks; empty if
 * they do not split. Built from the last word back, one pass with a fixed look-ahead and at most one entry per
 * combination of kinds at each word: linear time and no recursion however long the message is (a recursive split was
 * exponential on "good bye" × 40 + "x", which also splits as "good" + "bye").
 */
function splitKinds (words, { phrases, longest, fold }) {
  const folded = words.map(fold)
  const splits = Array.from({ length: folded.length + 1 }, () => new Set()) // splits[i]: the kinds of words[i..]
  splits[folded.length].add(0)
  for (let start = folded.length - 1; start >= 0; start--) {
    for (let length = 1; length <= Math.min(longest, folded.length - start); length++) {
      const kind = splits[start + length].size > 0 ? phrases.get(folded.slice(start, start + length).join(' ')) : undefined
      if (kind) for (const rest of splits[start + length]) splits[start].add(rest | kind)
    }
  }
  return [...splits[0]]
}

// Emoji that can only be friendly. Any other one (😡, 👎, 💩) or bare punctuation ("!!!") is no thanks; 👍 and 👌
// agree to something, so like "ok" they only go with a thanks.
const FRIENDLY_EMOJI = new Set([...'🙏😊🙂☺😀😁😄🤗🥰😍❤♥💕💖✨🌸'])
const AGREEING_EMOJI = new Set([...'👍👌🙌👏'])
const EMOJI = /[\p{Extended_Pictographic}\p{So}]/gu
const EMOJI_PARTS = /[\p{Emoji_Modifier}︎️]/gu // skin tones and presentation selectors: 🙏🏽, ❤️
// Text smileys that are friendly; every other symbol ("ok :(", "-_-", "T_T") is not plain punctuation.
const SMILEYS = /[:;=]-?(?:[)\]]|[dp](?!\p{L}))|\^_?\^|<3/gu
// Every text emoticon, friendly or not, for isSocialMessage: next to a yes, ":D", ":p", ":v", "xD", ":(", ":3" or "<3"
// still leaves a yes, and their letters and digits must not read as content.
const EMOTICONS = /[:;=]['-]?(?:[()[\]/\\|*3]|[dpvo](?![\p{L}\p{N}]))|\^_*\^|<3|(?<![\p{L}\p{N}])(?:x-?d|-_+-|t_+t)(?![\p{L}\p{N}])/gu
const PUNCTUATION = /[\s.,!~'’‘"“”–—-]/gu

// A thanks is short: a longer message is content, whatever its words, and a spammed one is rejected before any pass
// over it. (isSocialMessage has no such limit: there a longer message of social words only is still social.)
const MAX_THANKS_CHARS = 300
const MAX_THANKS_TOKENS = 16

/**
 * The customer only thanks or says goodbye: a thanks or goodbye phrase, with at most acknowledgements, honorifics and
 * softeners around it, or friendly emoji and no words at all ("🙏"). No question, no digits, no symbol but punctuation,
 * friendly or agreeing emoji and friendly smileys, at most 16 words and emoji in at most 300 characters.
 */
export function isThanks (input) {
  if (String(input ?? '').length > MAX_THANKS_CHARS) return false
  const text = normalizeText(input).toLowerCase().replace(SMILEYS, ' ')
  if (/[?¿]/.test(text) || /\p{N}/u.test(text)) return false
  if (text.replace(/\p{L}+/gu, '').replace(EMOJI, '').replace(EMOJI_PARTS, '').replace(PUNCTUATION, '') !== '') return false
  const words = text.match(/\p{L}+/gu) ?? []
  const emoji = text.match(EMOJI) ?? []
  if (words.length + emoji.length > MAX_THANKS_TOKENS) return false
  if (words.length === 0) return emoji.length > 0 && emoji.every(symbol => FRIENDLY_EMOJI.has(symbol))
  const { closings } = THANKS_VOCABULARY.kinds
  return emoji.every(symbol => FRIENDLY_EMOJI.has(symbol) || AGREEING_EMOJI.has(symbol)) &&
    splitKinds(words, THANKS_VOCABULARY).some(kinds => kinds & closings)
}

/**
 * The customer's words are only social: a thanks, a goodbye or a yes, with honorifics, softeners, laughter and maybe a
 * greeting around it, or emoji with no greeting ("👍", "kak 🙏"). Any emoji, emoticon, symbol or question mark may go
 * with it; a digit or a word outside the vocabulary is content. However long it is: a burst of thanks is still social,
 * and the split is linear.
 */
export function isSocialMessage (input) {
  const text = normalizeText(input).toLowerCase().replace(EMOTICONS, ' ')
  if (/\p{N}/u.test(text)) return false
  const words = text.match(/\p{L}+/gu) ?? []
  const emoji = text.match(EMOJI) ?? []
  const { closings, acknowledgements, greetings } = SOCIAL_VOCABULARY.kinds
  return splitKinds(words, SOCIAL_VOCABULARY).some(kinds => (kinds & (closings | acknowledgements)) !== 0 ||
    (emoji.length > 0 && (kinds & greetings) === 0))
}

// Words are joined by any run of non-letters, none included: "sama-sama", "sama2", "you’re", "youre".
const phrasePattern = phrase => phrase.replace(/ /g, '[^\\p{L}\\p{N}]*')
const THANKS_BACK = new RegExp(`(?<![\\p{L}\\p{N}])(?:${THANKS_BACK_PHRASES.map(phrasePattern).join('|')})(?![\\p{L}\\p{N}])|` +
  `^[^\\p{L}\\p{N}]*(?:${THANKS_BACK_OPENERS.map(phrasePattern).join('|')})(?![\\p{L}\\p{N}])`, 'iu')

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Indonesian attaches affixes to the very words the list is about (diskonnya, direfund, digratiskan, jaminan), and
// chat spelling doubles letters (gratiss); a term matches with those, still not inside unrelated words (freezer).
const TERM_PREFIX = '(?:di|ter|ber|be|ke|se|per|me(?:ng|ny|m|n)?|pe(?:ng|ny|m|n)?)?'
const TERM_SUFFIX = '(?:nya|kan|an|i|lah|kah|pun|s|es|ed|ing){0,2}'
const termPattern = term => term.trim().split(/\s+/)
  .map(word => [...word].map(char => (/\p{L}/u.test(char) ? `${escapeRegExp(char)}+` : escapeRegExp(char))).join(''))
  .join('\\s+')
export const containsTerm = (haystack, term) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${TERM_PREFIX}${termPattern(term)}${TERM_SUFFIX}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)

const localUsername = () => { try { return os.userInfo().username } catch { return undefined } }

const alphanumeric = text => text.replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The CLI adds an environment block to Claude's context that no flag removes: the working directory (with the local
 * username), the OS and the Claude account's email. A reply must never carry the username, HOME, the app's
 * directories or `guards.ownerIdentifiers` (e.g. that email: its local part and domain name are checked on their own,
 * so "name [at] domain [dot] com" is caught too).
 */
export function privateIdentifiers (config = {}, { username = localUsername(), home = process.env.HOME } = {}) {
  const words = new Set(username ? [alphanumeric(username.toLowerCase())] : [])
  for (const identifier of config.guards?.ownerIdentifiers ?? []) {
    const [local, domain = ''] = String(identifier).toLowerCase().split('@')
    const labels = domain.split('.').filter(Boolean)
    for (const part of [local, ...labels.slice(0, -1)]) words.add(alphanumeric(part)) // the TLD alone says nothing
  }
  const paths = [home, config.rootDir, config.paths?.data].filter(path => path && path.length > 1).map(path => path.toLowerCase())
  return { words: [...words].filter(word => word.length >= 3), paths: [...new Set(paths)] }
}

/** The identifiers a text mentions: as a word, and one of 6+ characters also with spaces or symbols inside it. */
export function findPrivateDetails (text, { words = [], paths = [] } = {}) {
  const lower = normalizeText(text).toLowerCase()
  const tokens = new Set(lower.match(/[\p{L}\p{N}]+/gu) ?? [])
  const collapsed = alphanumeric(lower)
  return [
    ...paths.filter(path => lower.includes(path)),
    ...words.filter(word => tokens.has(word) || (word.length >= 6 && collapsed.includes(word)))
  ]
}

/**
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkReply ({ reply, factsUsed, incomingText }, { knowledge, maxReplyChars = 600, sensitiveTerms = [], privateIdentifiers: identifiers }) {
  const reasons = []
  const text = normalizeText(reply).trim()
  if (!text) return { ok: false, reasons: ['empty_reply'] }
  if (text.length > maxReplyChars) reasons.push(`too_long:${text.length}>${maxReplyChars}`)
  if (/\[F\d+\]/i.test(text)) reasons.push('fact_id_in_reply')
  else if (PLACEHOLDERS.some(pattern => pattern.test(text))) reasons.push('placeholder')

  // Every auto-reply is backed by facts, so a thanks-back, which cites none, only ever goes out as a draft. A fact cited
  // on a purely social message only licenses a claim or a promise nobody asked for ("besok kami kirim ya" to an "iya
  // kak" that may agree to something our side offered): held too. So is a reply that answers a thanks in its own words,
  // however the customer spelled the thanks.
  const cited = Array.isArray(factsUsed) ? factsUsed : []
  if (cited.length === 0) reasons.push('no_facts_used')
  else {
    if (incomingText !== undefined && isSocialMessage(incomingText)) reasons.push('social_message_answered_with_facts')
    const unknown = cited.filter(id => !knowledge.facts.has(factId(id)))
    if (unknown.length > 0) reasons.push(`unknown_fact:${unknown.join(',')}`)
  }
  if (THANKS_BACK.test(text)) reasons.push('thanks_back')

  const allow = buildAllowList(knowledge, cited)
  const details = extractDetails(text)
  const check = (kind, values, allowed) => {
    const missing = [...new Set(values.filter(value => !allowed.has(value)))]
    if (missing.length > 0) reasons.push(`unsupported_${kind}:${missing.join(',')}`)
  }
  const clock = minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
  check('url', details.urls, allow.urls)
  check('email', details.emails, allow.emails)
  check('phone', details.phones, allow.phones)
  check('time', [...details.times.map(clock), ...details.hours.filter(hour => !hourReadings(hour).some(minutes => allow.times.has(minutes))).map(hour => `jam ${hour}`)],
    new Set([...allow.times].map(clock)))
  check('duration', details.durations, allow.durations)
  check('percent', details.percents, allow.percents)
  check('amount', details.amounts, allow.amounts)
  check('quantity', details.quantities, allow.quantities)
  check('number', details.numbers, TIME_WORDS.test(text) ? new Set([...allow.numbers, ...allow.hourNumbers]) : allow.numbers)
  check('number_word', details.numberWords, allow.numberWords)
  if (details.otherDigits) reasons.push('non_ascii_digits')

  for (const term of sensitiveTerms) {
    if (containsTerm(text, term) && !containsTerm(allow.factsLower, term)) reasons.push(`sensitive_term:${term}`)
  }
  // No value in the reason: it lands in the audit log and in eval reports.
  if (findPrivateDetails(text, identifiers).length > 0) reasons.push('private_detail')

  // Voice says mirror the sender's language; an auto-reply in the other language goes to the owner instead.
  if (incomingText !== undefined) {
    const incoming = detectLanguage(incomingText)
    const replied = detectLanguage(text)
    if (incoming !== 'unknown' && replied !== 'unknown' && incoming !== replied) reasons.push(`language_mismatch:${incoming}->${replied}`)
  }
  return { ok: reasons.length === 0, reasons }
}

const identifiersCache = new WeakMap()
export const privateIdentifiersFor = config => {
  if (!identifiersCache.has(config)) identifiersCache.set(config, privateIdentifiers(config))
  return identifiersCache.get(config)
}

/** Guards for a triage result: only an "answer" can be auto-sent, so only it is checked. */
export function guardTriage (triage, { knowledge, config, incomingText }) {
  if (triage?.decision !== 'answer') return undefined
  return checkReply({ reply: triage.reply, factsUsed: triage.facts_used, incomingText }, { knowledge, ...config.guards, privateIdentifiers: privateIdentifiersFor(config) })
}
