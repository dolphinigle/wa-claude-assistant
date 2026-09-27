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

// A day is a commitment or a claim even without a digit: "besok dikirim ya", "buka Senin–Sabtu".
const DAY_WORDS = /\b(?:besok|lusa|hari ini|malam ini|minggu depan|bulan depan|hari minggu|senin|selasa|rabu|kamis|jum'?at|sabtu|tomorrow|today|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
// A reply without facts may only ask; opening with a yes would agree to whatever was asked ("Siap Kak", "Bisa kak").
const YES_OPENING = /^[^\p{L}]*(?:bisa|boleh|siap|oke?|okay|iya|ya|tentu|pasti|sure|yes|can)\b/iu

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

// isThanks chooses the skip: a thanks right after a closing gets no reply and no notice (policy.js). It matches whole
// phrases from a narrow vocabulary, since a missed thanks only becomes a draft while a false match could drop a real
// message, and a word that only makes sense inside a phrase never counts alone: "no good" and "oh no" are not a thanks.
//
// isThanks needs a thanks or goodbye; an acknowledgement ("ok", "iya", "siap") or a 👍 may only go with one, since
// alone it can be a yes to something our side asked. Greetings are not in it: "Selamat pagi kak" opens a
// conversation, and "makasih kak, selamat siang" is a draft too. Neither is anything that can agree to, arrange or ask
// for something: "no problem", "anytime", "see you", "sampai jumpa", "hati-hati" (a warning too), "lagi" (more),
// "dong", or a bare "welcome".
const foldRepeats = word => String(word ?? '').replace(/(\p{L})\1+/gu, '$1') // chat doubles letters: "bangett", "gakk"
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

/**
 * A vocabulary: each phrase maps to the bit of its kind. A phrase listed under two kinds would take the kind listed
 * last, silently: it throws instead.
 */
function vocabulary (lists) {
  const kinds = Object.fromEntries(Object.keys(lists).map((kind, index) => [kind, 1 << index]))
  const phrases = new Map()
  for (const [kind, list] of Object.entries(lists)) {
    for (const phrase of list) {
      if (phrases.has(phrase) && phrases.get(phrase) !== kinds[kind]) throw new Error(`guards: "${phrase}" is listed under two kinds`)
      phrases.set(phrase, kinds[kind])
    }
  }
  return { kinds, phrases, longest: Math.max(...[...phrases.keys()].map(phrase => phrase.split(' ').length)) }
}
const THANKS_VOCABULARY = vocabulary(THANKS_PHRASES)
const YES_BEFORE_THANKS = new Set(['ya', 'yaa'])

/**
 * The kinds of phrases each way of splitting the words into phrases of the vocabulary uses, as bitmasks; empty if
 * they do not split. Built from the last word back, one pass with a fixed look-ahead and at most one entry per
 * combination of kinds at each word: linear time and no recursion however long the message is (a recursive split was
 * exponential on "good bye" × 40 + "x", which also splits as "good" + "bye").
 */
function splitKinds (words, { phrases, longest }) {
  const splits = Array.from({ length: words.length + 1 }, () => new Set()) // splits[i]: the kinds of words[i..]
  splits[words.length].add(0)
  for (let start = words.length - 1; start >= 0; start--) {
    for (let length = 1; length <= Math.min(longest, words.length - start); length++) {
      const kind = splits[start + length].size > 0 ? phrases.get(words.slice(start, start + length).join(' ')) : undefined
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
const PUNCTUATION = /[\s.,!~'’‘"“”–—-]/gu

// A thanks is short: a longer message is content, whatever its words, and a spammed one is rejected before any pass
// over it.
const MAX_THANKS_CHARS = 300
const MAX_THANKS_TOKENS = 16

/**
 * How the customer thanks, or undefined if they do not only thank or say goodbye: a thanks or goodbye phrase, with at
 * most acknowledgements, honorifics and softeners around it, or friendly emoji and no words at all ("🙏"). No question,
 * no digits, no symbol but punctuation, friendly or agreeing emoji and friendly smileys, at most 16 words and emoji in
 * at most 300 characters. `agrees`: it reads as a thanks only with an acknowledgement or an agreeing emoji in it ("iya
 * makasih", "ok siap, thanks", "👍 makasih"), or a "ya" comes before the thanks ("ya kak, makasih"), so it may also be a
 * yes to something our side asked. `anyEmoji`: any emoji may go with the words (the loose read below).
 */
function readThanks (input, lexicon = THANKS_VOCABULARY, { anyEmoji = false } = {}) {
  if (String(input ?? '').length > MAX_THANKS_CHARS) return undefined
  const text = normalizeText(input).toLowerCase().replace(SMILEYS, ' ')
  if (/[?¿]/.test(text) || /\p{N}/u.test(text)) return undefined
  if (text.replace(/\p{L}+/gu, '').replace(EMOJI, '').replace(EMOJI_PARTS, '').replace(PUNCTUATION, '') !== '') return undefined
  const words = text.match(/\p{L}+/gu) ?? []
  const emoji = text.match(EMOJI) ?? []
  if (words.length + emoji.length > MAX_THANKS_TOKENS) return undefined
  if (words.length === 0) return emoji.length > 0 && emoji.every(symbol => FRIENDLY_EMOJI.has(symbol)) ? { agrees: false } : undefined
  if (!anyEmoji && !emoji.every(symbol => FRIENDLY_EMOJI.has(symbol) || AGREEING_EMOJI.has(symbol))) return undefined
  const { closings, acknowledgements } = lexicon.kinds
  const splits = splitKinds(words, lexicon).filter(kinds => kinds & closings)
  if (splits.length === 0) return undefined
  // A "ya" before the thanks is the Indonesian yes ("ya kak, makasih", "ya deh makasih"); after it, it only softens
  // ("makasih ya kak").
  const startsClosing = index => Array.from({ length: lexicon.longest }, (_, length) => words.slice(index, index + length + 1).join(' '))
    .some(phrase => lexicon.phrases.get(phrase) === closings)
  const yesFirst = words.slice(0, words.findIndex((_, index) => startsClosing(index))).some(word => YES_BEFORE_THANKS.has(word))
  return { agrees: yesFirst || emoji.some(symbol => AGREEING_EMOJI.has(symbol)) || splits.every(kinds => kinds & acknowledgements) }
}

/** The customer only thanks or says goodbye (see readThanks). */
export const isThanks = input => readThanks(input) !== undefined

/** A thanks that also agrees to something ("iya makasih", "👍 thanks"): see readThanks. */
export const thanksAgrees = input => readThanks(input)?.agrees === true

// The escalation placeholder is withheld from a thanks (policy.js), where the error runs the other way: a missed thanks
// tells someone who waits for nothing to wait, and a false match only withholds a fixed text. So there a thanks may
// also be spelled the chat way ("makasiii", "trimakasih", "thank u", "matur nuwun", "makasih bgt kak", send-path-r1-3):
// a word the vocabulary does not know is read without its doubled letters, then as its usual spelling or dropped as a
// softener, and what is left must still be a thanks for readThanks. The skip keeps the narrow isThanks.
// What the thanks is for is dropped too, as whole words ("atas bantuannya", "untuk infonya": "atas nama Dewi" keeps
// "nama Dewi"), and so is laughter ("hehe", "wkwk") and a done "(sudah) dibantu" (send-path-r2-1). A "2" after a word
// repeats it ("sama2", "sehat2", "sukses2"), any emoji may go with the words ("makasih kak 😅", "🥲", "🙇‍♀️"), and a
// "y" is "ya" (send-path-r2-4, correctness-r2-2). Other digits still make it no thanks: "makasih, pesan 2 ya".
const CHAT_THANKS = new Map(Object.entries({
  trimakasih: 'terimakasih', trimakasi: 'terimakasih', terimakasi: 'terimakasih', trmksh: 'terimakasih', trmkasih: 'terimakasih',
  makacih: 'makasih', macih: 'makasih', maci: 'makasih', mksi: 'makasih', mks: 'makasih', mkasih: 'makasih', mkasi: 'makasih',
  mksih: 'makasih', maksih: 'makasih', makaseh: 'makasih', nuwun: 'makasih', suwun: 'makasih', nuhun: 'makasih',
  tks: 'thanks', thanx: 'thanks', thnx: 'thanks', tqvm: 'thanks', tqsm: 'thanks', thanku: 'thank you', thankyu: 'thank you',
  tenkyu: 'tengkyu', tengkiu: 'tengkyu', u: 'you', tysm: 'thanks', thks: 'thanks', bnyk: 'banyak', byk: 'banyak', bnyak: 'banyak'
}))
const CHAT_SOFTENERS = new Set(('matur hatur bgt banget bngt bener sekali bang om dek mba bro sist bos yah y yh gbu ' +
  'atas untuk bantuannya bantuan informasinya responnya jawabannya balasannya pelayanannya pelayanan waktunya').split(' '))
const LAUGHTER = /^(?:(?:h[aeiu]){2,}h?|(?:wk){2,}w?)$/u
// A greeting or a well-wish around a thanks only softens it too ("makasih kak, selamat siang", "pagi kak makasih",
// "makasih ya kak, sukses selalu", "thank you, good afternoon"), and so do more ways to say kak ("kk", "kaka", "kang",
// "teh"). They are phrases, not dropped words: "selamat" and "selalu" belong to closings ("selamat tidur", "sehat
// selalu"), and "good evening" to "have a good evening". A greeting alone ("Selamat pagi kak") still has no closing,
// so it is no thanks and keeps its placeholder (send-path-r1-2, correctness-r1-2).
const GREETING_TIMES = ['pagi', 'siang', 'sore', 'malam', 'malem']
const LOOSE_VOCABULARY = vocabulary({
  ...THANKS_PHRASES,
  fillers: [...THANKS_PHRASES.fillers, 'kk', 'kaka', 'kang', 'teh',
    ...GREETING_TIMES, ...['selamat', 'slamat', 'met'].flatMap(word => [...GREETING_TIMES, 'beraktivitas', 'bekerja', 'istirahat'].map(time => `${word} ${time}`)),
    'good morning', 'good afternoon', 'good evening', 'good day', 'hai', 'halo', 'hallo', 'helo', 'hi', 'hello', 'hey',
    'salam', 'wassalam', 'wasalam', 'assalamualaikum', 'assalamu alaikum', 'wassalamualaikum', 'waalaikumsalam',
    'sukses selalu', 'sukses', 'sukses terus', 'semangat', 'semangat selalu', 'semangat terus', 'sehat', 'god bless', 'god bless you',
    'for your time']
})
// Only once done: "makasih, dibalas ya" may ask for a reply.
const DONE_FOR_US = /(?<!\p{L})(?:sudah|sudh|udah|udh|uda|sdh|dah|telah)\s+(?:di|mem|men|me)?(?:bantu|bantuin|balas|bales|jawab|respon|info|infokan|infoin|kabari|kabarin|layani)(?!\p{L})/gu
const THANKS_WORDS = new Set([...LOOSE_VOCABULARY.phrases.keys()].flatMap(phrase => phrase.split(' ')))
const FOLDED_THANKS_WORDS = new Map()
for (const word of THANKS_WORDS) if (!FOLDED_THANKS_WORDS.has(foldRepeats(word))) FOLDED_THANKS_WORDS.set(foldRepeats(word), word)
const chatSpelling = word => {
  if (THANKS_WORDS.has(word)) return word
  const folded = foldRepeats(word)
  const known = FOLDED_THANKS_WORDS.get(folded) ?? CHAT_THANKS.get(word) ?? CHAT_THANKS.get(folded)
  if (known) return known
  return CHAT_SOFTENERS.has(word) || CHAT_SOFTENERS.has(folded) || LAUGHTER.test(folded) ? '' : word
}

/** The customer only thanks, also in a chat spelling (see above); for the placeholder only, never for the skip. */
const REPEATED = /(?<![\p{L}\p{N}])(\p{L}+)2(?![\p{L}\p{N}])/gu // "sama2" is "sama sama"
export const isLooseThanks = input => isThanks(input) ||
  (String(input ?? '').length <= MAX_THANKS_CHARS &&
    readThanks(normalizeText(input).toLowerCase().replace(REPEATED, '$1 $1').replace(DONE_FOR_US, ' ').replace(/\p{L}+/gu, chatSpelling),
      LOOSE_VOCABULARY, { anyEmoji: true }) !== undefined)

// isGreetingOnly lets the fixed greeting-back out (policy.js, owner decision 2026-09-27): the customer only greets, with
// at most honorifics, punctuation and friendly emoji around it ("Hai", "Halo kak!", "Pagi kak 🙏", "Selamat siang",
// "P", "Permisi kak", "Assalamualaikum"). Strict, since anything more ("halo kak mau pesan", "pagi kak, sudah buka?",
// "halo?") is a message to answer and goes the normal way; a missed greeting only costs a draft. Words are compared
// without their doubled letters ("haiii", "kakk"). "selamat", "met" and "good" count only before a time of day.
const foldAll = list => new Set(list.map(foldRepeats))
const GREETINGS = foldAll(('hai hay hi hei hey halo hallo helo hello p permisi misi punten assalamualaikum assalamu alaikum ' +
  'salam warahmatullahi wabarakatuh wr wb').split(' '))
const GREETING_HOURS = foldAll([...GREETING_TIMES, 'morning', 'afternoon', 'evening'])
const GREETING_OPENERS = foldAll(['selamat', 'slamat', 'met', 'good'])
const GREETING_HONORIFICS = foldAll([...HONORIFICS, ...'kk kaka mba sist bang bro om bos admin teh kang there'.split(' ')])
const GREETING_EMOJI = new Set([...FRIENDLY_EMOJI, '👋'])
const MAX_GREETING_CHARS = 100
const MAX_GREETING_TOKENS = 8

/** The customer only greets (see above). Capped input, one pass over the words. */
export function isGreetingOnly (input) {
  if (String(input ?? '').length > MAX_GREETING_CHARS) return false
  const text = normalizeText(input).toLowerCase().replace(SMILEYS, ' ')
  if (text.replace(/\p{L}+/gu, '').replace(EMOJI, '').replace(EMOJI_PARTS, '').replace(PUNCTUATION, '') !== '') return false // "?", digits, symbols
  const words = (text.match(/\p{L}+/gu) ?? []).map(foldRepeats)
  const emoji = text.match(EMOJI) ?? []
  if (words.length + emoji.length > MAX_GREETING_TOKENS || !emoji.every(symbol => GREETING_EMOJI.has(symbol))) return false
  let greets = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (GREETINGS.has(word) || GREETING_HOURS.has(word)) greets = true
    else if (GREETING_OPENERS.has(word) && GREETING_HOURS.has(words[index + 1])) { greets = true; index++ }
    else if (!GREETING_HONORIFICS.has(word)) return false
  }
  return greets
}

// asksSomething chooses the auto-send (owner decision, 2026-09-27): only an answer to a message that asks something may
// go out on its own. A thanks, a yes, a no, "gapapa", "saya tunggu" or "saya mau ambil besok" asks nothing, so a fact
// cited there only licenses a promise nobody asked for. No list knows every way to thank or agree ("makasih bang",
// "sama2", "betul"), so this one lists what asks instead: a missed question only costs a draft, and a false one only
// puts the answer back on the other gates.
const wordsOf = list => list.split(' ')
// Ask wherever they stand, but see plainFrom and plainQuestion below. Chat questions often have no question mark
// ("buka jam berapa kak"). Not "kok": in chat it mostly stresses a statement ("bisa kok kak", "udah sampai kok,
// makasih"), so it is a particle.
const QUESTION_WORDS = new Set(wordsOf('apa apakah apaan ngapain berapa berapakah brp brapa kapan kapankah kpn dimana dimanakah dmn mana ' +
  'manakah kemana darimana gimana gmn gmana bagaimana bagaimanakah bgmn kenapa knp napa mengapa siapa siapakah kah bisakah ' +
  'bolehkah adakah benarkah betulkah masihkah sudahkah haruskah perlukah mungkinkah maukah ' +
  'what whats when where wheres which who whos whom whose why how hows does'))
// "tanya" asks only as a request to ask: after a wish or a permission ("mau tanya", "boleh nanya", "numpang tanya",
// "sekalian tanya") or opening its clause ("tanya dong kak", "kak, tanya harga"). An apology ("maaf banyak tanya",
// "maaf nanya terus") or the customer's plan ("nanti saya tanya lagi", see TELLS) asks nothing (send-path-r3-1).
const ASK_WORDS = new Set(wordsOf('tanya nanya bertanya'))
const WANTS = new Set(wordsOf('mau mo mw mao pengen pingin pgn ingin boleh blh numpang izin ijin sekalian'))
const ASKING_AGAIN = new Set(wordsOf('terus trus trs mulu melulu'))
// "siapa tau" is "maybe": "siapa tau nanti order lagi" (send-path-r3-1).
const MAYBE_AFTER = new Set(wordsOf('tau tahu tw taw'))
// "gimana kakak aja", "gimana baiknya aja", "gimana nanti aja": the customer leaves it to us (send-path-r3-1).
const HOW = new Set(wordsOf('gimana gmn gmana bagaimana bgmn'))
// An English question puts these first, so they ask only at the start of a clause, after soft words or a greeting
// ("hi, do you deliver", "ok is it open on sunday", "let me know the price"); inside one they state: "thank you, that
// is it" (send-path-r2-3).
const QUESTION_PHRASES = new Set(['do you', 'do i', 'did you', 'is there', 'are there', 'is it', 'are you', 'will you', 'may i', 'tell me',
  'let me know', 'have you', 'should i'])
const LEADS = new Set(wordsOf('hi hello hey hai halo hallo helo also btw so but then or well sorry excuse me'))
// "I would like the address" asks wherever it stands; "I would like that" and "I would like to thank you" do not.
const NOT_WANTED = new Set(wordsOf('that it this them to'))
// Ask only with something to request in their clause, and not after "saya" or "I" or after a no: alone they say yes
// ("bisa kak", "boleh", "ada", "tolong ya", "yes please"), after "I" they state ("saya bisa ambil besok", "I can come
// at 5"), and after a no they say no ("gak ada kak, makasih", "gak bisa kak", "belum ada") (send-path-r2-1).
const REQUEST_WORDS = new Set(wordsOf('bisa bs boleh blh ada minta mohon tolong tlg please pls plz can could would mau pengen pingin ingin'))
// An English request puts its modal before the subject ("can you", "could I", "would it"): "that would be great",
// "can do" and "sure you can" say yes (send-path-r2-2).
const MODALS = new Set(wordsOf('can could would'))
const SUBJECTS = new Set(wordsOf('you u i we it they he she this that these those there someone somebody anyone anybody my your our the a'))
const FIRST_PERSON = new Set(wordsOf('saya sy aku ak gue gw gua kami kita i we'))
// What a clause may hold besides a request word and still only say yes: every word of the thanks vocabulary, more
// honorifics, particles, and an apology ("minta maaf", "mohon maaf").
const SOFT_WORDS = new Set([...Object.values(THANKS_PHRASES).flat().flatMap(phrase => phrase.split(' ')),
  ...wordsOf('kaka kk mba sist bang om bro bos sob bund bunda yah sih dong tuh aja saja lah loh lho kok koq maaf')])
// Words that only make a yes stronger or say "go ahead" are nothing to request either: "boleh banget kak", "bisa bgt",
// "tentu bisa", "udah bisa kak makasih", "masih ada kak", "yes please do", "please go ahead" (send-path-r2-2). They are
// not soft words: "udah belum" is still a tag question.
// The one-word "alright then" (yaudah, ywdh, yowes) and "go ahead" (lanjut, gas, sekalian, mangga) are yes words
// too: "yaudah boleh kak", "boleh kak lanjut", "ok kak boleh sekalian" (send-path-r3-2).
const YES_WORDS = new Set(wordsOf('banget bget bgt sekali tentu pasti udah uda sudah sdh masih do go ahead ' +
  'yaudah yaudh yauda ywdh yawdah yasudah yodah yowes yawes lanjut lanjutkan gas mangga monggo sekalian'))
// "info harga kak" asks; "makasih infonya", "makasih info nya", "thanks for the info", "nanti saya info lagi" and "info
// diterima" do not.
const THANKED_FOR = new Set(wordsOf('the for atas untuk buat your makasih kasih thanks thx tq'))
const RECEIVED = new Set(wordsOf('diterima received'))
// A tag at the end of a clause ("buka gak kak", "sudah sampai belum", "masih ada nggak"), after a word it asks about:
// "belum", "gak kak", "iya kan" and "saya belum" answer.
const NEGATIONS = new Set(wordsOf('gak ga nggak ngga enggak engga nggk ngak gk tidak tdk ndak nda kagak'))
const TAGS = new Set([...NEGATIONS, ...wordsOf('belum blm bukan kan')])
const NOT_YET = new Set([...NEGATIONS, ...wordsOf('belum blm')])
const saysNo = word => NOT_YET.has(word) || NOT_YET.has(foldRepeats(word))
// After a negation these ask nothing: "gak apa", "ga napa", "gak knp", "tidak mengapa", "nggak kenapa-napa" (no
// problem), "gak ngapain" (nothing).
const NO_PROBLEM = new Set(wordsOf('apa napa knp kenapa mengapa ngapain'))
// After the customer's own "I'll tell you" or "I think", or after "terserah" (whatever), a question or request word is
// their plan or their choice: "nanti saya kabari kapan ambilnya", "saya kasih tau berapa loyang", "saya pikir-pikir
// dulu mau yang mana", "I'll let you know when I'm there", "I know where it is", "terserah kak apa aja". Only right
// after "saya", "I", "nanti", "will" …: "saya mau info harganya" and "saya belum dapat info kapan dikirim" still ask
// (send-path-r2-3).
const TELLS = new Set(wordsOf('kabari kabarin kabarkan kasih kasi kasitau info infoin infokan pikir pikirin pikirkan mikir tanya nanya ' +
  'let tell know think decide'))
const TELL_LEADS = new Set([...FIRST_PERSON, ...wordsOf('nanti ntar akan coba ll will')])
// So is anything after an English "I will", "we'll", "I'm going to": "thanks, I will pay when I pick up", "ok, I'll
// transfer when I get home"; "I want to know when you open" still asks (send-path-r3-4).
const PLANNERS = new Set(wordsOf('i we'))
const FUTURE = new Set(wordsOf('will ll shall gonna'))
const BE = new Set(wordsOf('am m are re'))
// A question word used as a relative or an exclamation asks nothing: "that's what I needed", "exactly what I was
// looking for", "thanks for what you did", "I love what you made", "the one who will pick it up", "how lovely", "how
// nice of you", "what a lovely cake", "see you when I see you", "why not", and "apa aja boleh" or "kapan aja bisa"
// (anything is fine).
const RELATIVE_AFTER = new Set(wordsOf('s thats exactly just for love loved like liked one'))
const EXCLAIMS = new Set(wordsOf('lovely nice sweet kind cute cool great wonderful amazing awesome beautiful perfect fast quick helpful'))
const ANY = new Set(wordsOf('aja saja'))
const LEFT_TO_US = new Set([...HONORIFICS, ...wordsOf('kaka kakaknya baiknya enaknya bagusnya maunya nanti ntar')])
// "ada" asks where it opens its clause ("ada brownies kak", "kak, masih ada stok coklat"). Inside one it mostly states
// ("kalau ada apa-apa saya hubungi lagi", "besok ada yang ambil", "soalnya ada acara"), and so does "there is someone"
// ("ada teman yang ambil", "ada yang jemput") (send-path-r3-3).
const STILL = new Set(wordsOf('masih msh masi'))
const SOMEONE = new Set(wordsOf('teman temen tmn orang org saudara sodara adik adek suami istri anak keluarga driver kurir ojol supir sopir'))
const COMES = new Set(wordsOf('ambil ngambil ambilin jemput jemputin datang dateng'))
const PHRASE_STARTS = new Set([...QUESTION_PHRASES].map(phrase => phrase.split(' ')[0]))
// A clause without any of these asks nothing.
const CUES = new Set([...QUESTION_WORDS, ...ASK_WORDS, ...REQUEST_WORDS, ...TAGS, ...PHRASE_STARTS, 'info'])

function clauseAsks (clause) {
  const tokens = clause.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!tokens.some(token => CUES.has(token))) return false // most clauses of a long message: nothing to look at
  const count = tokens.length
  // Linear: which words only say yes, where the leading soft words end, where the customer's plan starts, and what the
  // rest of the clause holds.
  const yes = tokens.map(token => SOFT_WORDS.has(token) || REQUEST_WORDS.has(token) || YES_WORDS.has(token) ||
    (/(\p{L})\1/u.test(token) && YES_WORDS.has(foldRepeats(token))))
  let lead = 0
  while (lead < count && (SOFT_WORDS.has(tokens[lead]) || LEADS.has(tokens[lead]))) lead++
  let plainFrom = count
  for (let index = 0, firstPerson = false; index < count && plainFrom === count; index++) {
    const token = tokens[index]
    if (token === 'terserah' || (firstPerson && TELLS.has(token) && TELL_LEADS.has(tokens[index - 1]))) plainFrom = index
    else if (PLANNERS.has(token) && (FUTURE.has(tokens[index + 1]) || (BE.has(tokens[index + 1]) && ['going', 'gonna'].includes(tokens[index + 2])))) plainFrom = index + 1
    if (FIRST_PERSON.has(token)) firstPerson = true
  }
  const quietFrom = new Uint8Array(count + 1).fill(1) // tokens[i..] only say yes
  const requestFrom = new Uint8Array(count + 1) // tokens[i..] hold a request word
  for (let index = count - 1; index >= 0; index--) {
    quietFrom[index] = quietFrom[index + 1] && (yes[index] || tokens[index] === 'of') ? 1 : 0
    requestFrom[index] = requestFrom[index + 1] || REQUEST_WORDS.has(tokens[index]) ? 1 : 0
  }
  const anyIsFine = index => QUESTION_WORDS.has(tokens[index]) && ANY.has(tokens[index + 1]) && quietFrom[index + 2] && requestFrom[index + 2]
  // "gimana", one to three of "kakak", "baiknya", "nanti" …, then "aja". A fixed look-ahead from each "gimana": linear.
  const leftToUs = new Uint8Array(count)
  for (let index = 0; index < count; index++) {
    if (!HOW.has(tokens[index])) continue
    let end = index + 1
    while (end < count && end <= index + 3 && LEFT_TO_US.has(tokens[end])) end++
    if (end > index + 1 && ANY.has(tokens[end])) leftToUs.fill(1, index, end + 1)
  }
  const other = yes.some((only, index) => !only && !anyIsFine(index) && !leftToUs[index])
  const noProblem = index => NO_PROBLEM.has(tokens[index]) &&
    (NEGATIONS.has(tokens[index - 1]) || (NO_PROBLEM.has(tokens[index - 1]) && NEGATIONS.has(tokens[index - 2])))
  const plainQuestion = (token, index, before, after) =>
    RELATIVE_AFTER.has(before) || (before === 'is' && ['that', 'this', 'it'].includes(tokens[index - 2])) ||
    anyIsFine(index) || leftToUs[index] === 1 || (token === 'siapa' && MAYBE_AFTER.has(after)) ||
    (token === 'what' && (after === 'a' || after === 'an')) || (token === 'when' && (before === 'you' || before === 'u')) ||
    (token === 'how' && EXCLAIMS.has(after) && quietFrom[index + 2]) || (token === 'why' && after === 'not' && quietFrom[index + 2])
  const opensClause = (index, before) => index <= lead || (STILL.has(before) && index - 1 <= lead)
  const statesThere = (after, index) => after === 'apa' || after === 'apa2' || SOMEONE.has(after) || (after === 'yang' && COMES.has(tokens[index + 2]))
  const asks = (token, index) => {
    const before = tokens[index - 1]
    const after = tokens[index + 1]
    if (before === token || after === token) return false // "apa-apa" (anything), "kapan-kapan" (some time), "mana-mana"
    if (index <= lead && PHRASE_STARTS.has(token) &&
      (QUESTION_PHRASES.has(`${token} ${after}`) || QUESTION_PHRASES.has(`${token} ${after} ${tokens[index + 2]}`))) return true
    if (token === 'would' && after === 'like') return !NOT_WANTED.has(tokens[index + 2] ?? 'that')
    if (index >= plainFrom) return false
    if (QUESTION_WORDS.has(token)) return !noProblem(index) && !plainQuestion(token, index, before, after)
    if (ASK_WORDS.has(token)) return WANTS.has(before) || (index <= lead && before !== 'banyak' && !ASKING_AGAIN.has(after))
    if (token === 'info') return after !== 'nya' && !RECEIVED.has(after) && !THANKED_FOR.has(before) && !FIRST_PERSON.has(before)
    if (!REQUEST_WORDS.has(token) || !other || FIRST_PERSON.has(before) || saysNo(before)) return false
    if (token === 'ada') return opensClause(index, before) && !statesThere(after, index)
    return !MODALS.has(token) || SUBJECTS.has(after)
  }
  if (tokens.some(asks)) return true
  let last = count - 1
  while (last > 0 && SOFT_WORDS.has(tokens[last])) last--
  const previous = tokens[last - 1]
  return TAGS.has(tokens[last]) && previous !== undefined && !TAGS.has(previous) && !SOFT_WORDS.has(previous) && !FIRST_PERSON.has(previous)
}

// A shared link is not what the customer asks: its query string ("maps.app.goo.gl/x?g_st=iw", "…?smtt=0.0.9") and
// the words of its path are dropped. A link is a word with "://", or one that starts with "www." or with a domain and a
// "/"; a bare "kak.kirim" is a missing space and stays. Tested per word and anchored, so linear: the URL pattern
// above backtracks quadratically on a long "a.a.a…".
const LINK = /:\/\/|^www\.|^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//
const withoutLinks = text => text.replace(/\S+/g, word => (LINK.test(word) ? ' ' : word))

/**
 * The customer's message asks something: a question mark, a question word, a request word with something to request,
 * or a tag question at the end of a clause, links left out. A burst asks if any of its messages does. Linear time.
 */
export function asksSomething (input) {
  const text = withoutLinks(normalizeText(input).toLowerCase())
  if (/[?¿؟]/.test(text)) return true // NFKC folds the fullwidth ？
  return text.split(/[\n.,!;]+/).some(clauseAsks)
}

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

  const cited = Array.isArray(factsUsed) ? factsUsed : []
  if (cited.length > 0) {
    const unknown = cited.filter(id => !knowledge.facts.has(factId(id)))
    if (unknown.length > 0) reasons.push(`unknown_fact:${unknown.join(',')}`)
  }

  const allow = buildAllowList(knowledge, cited)
  const details = extractDetails(text)
  // Owner decision (2026-09-27, live test): a customer-service reply may cite no fact when it only asks ("Halo Kak, mau
  // pesan apa, berapa banyak, dan untuk tanggal berapa?"): a question, nothing concrete (no number, price, time, link,
  // contact, number word or day) and no yes up front. Everything else without a cited fact is a draft.
  const concrete = Object.values(details).some(value => (Array.isArray(value) ? value.length > 0 : value === true)) || DAY_WORDS.test(text)
  const onlyAsks = /[?¿]/.test(text) && !concrete && !YES_OPENING.test(text)
  if (cited.length === 0 && !onlyAsks) reasons.push('no_facts_used')
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
