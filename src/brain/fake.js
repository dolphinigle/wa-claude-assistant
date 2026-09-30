// Deterministic keyword brain for the offline console demo (`npm run dev -- --fake-brain`). Same contract as
// createClaudeBrain().triage, no network, no Claude.

// `waiting`: a customer waiting for the owner (customer_waiting), which lets an escalation's placeholder out, with
// `holding` as its holding reply. Like Claude's, the holding reply and the greeting-back name the sender (owner decision
// 2026-09-28: no fixed customer-facing texts); the other replies are drafts or cite facts.
const RULES = [
  { pattern: /darurat|emergency|urgent|penting/i, decision: 'escalate', reply: 'Iya, aku telepon sekarang ya.', facts: [] },
  { pattern: /transfer|bayar|payment|refund|kecewa|angry/i, decision: 'escalate', reply: 'Baik Kak, pesannya sudah saya terima. Saya cek dulu ya.', facts: [], waiting: true, holding: kak => `Baik ${kak}, soal pembayarannya saya teruskan ke pemilik ya 🙏` },
  { pattern: /menang|hadiah|undian|prize|winner|klik link|promo/i, decision: 'escalate', reply: '', facts: [] },
  { pattern: /custom|pesan|order/i, decision: 'escalate', reply: 'Terima kasih Kak, saya cek dulu ya.', facts: [], waiting: true, holding: kak => `Baik ${kak}, pertanyaan soal pesanannya saya teruskan ke pemilik ya 🙏` },
  { pattern: /^(?:(?:ok+|oke|sip|siap|makasih|terima kasih|thanks?|thank you|kak)\b[\s,.!]*)+[\p{Emoji}\s.!]*$/iu, decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts: [] },
  // A customer's greeting alone waits for the owner (owner decision 2026-09-27); the fake brain cannot tell family apart.
  { pattern: /^(?:(?:hai|halo|hallo|hi|hello|pagi|siang|sore|malam|selamat|kak)\b[\s,.!]*)+[\p{Emoji}\s.!]*$/iu, decision: 'escalate', reply: kak => `Halo ${kak}, ada yang bisa dibantu?`, facts: [], waiting: true, holding: kak => `Halo ${kak}, pesannya saya teruskan ke pemilik ya 🙏` },
  { pattern: /jam|buka|open|hours/i, decision: 'answer', reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB, Minggu tutup ya Kak.', facts: ['F1'] },
  { pattern: /alamat|address|lokasi|where/i, decision: 'answer', reply: 'Alamat kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', facts: ['F2'] },
  { pattern: /brownies/i, decision: 'answer', reply: 'Brownies panggang loyang 20x20 cm harganya Rp 85.000 ya Kak.', facts: ['F5'] }
]

// Borma demo: a price or stock question with a product in the lookup gets that product's first store line.
const lookupRule = (text, lookup) => {
  const product = [...(lookup?.facts ?? [])].find(([id]) => /^F[1-3]\d\d$/.test(id))
  if (!product || !/harga|berapa|brp|ada|stok|ready/i.test(text)) return undefined
  const [, title, stores] = product[1].match(/^Produk (.+?) \(id \d+[^)]*\): (.+)$/) ?? []
  if (!title) return undefined
  return { pattern: 'a lookup product', decision: 'answer', reply: `${title} di ${stores.split(/[;(]/)[0].trim()} ya Kak.`, facts: [product[0]] }
}

/** "Kak Alice" for a name that is one plain word (the console's names), else "Kak": never a number. */
const address = name => {
  const first = String(name ?? '').trim().split(/\s+/)[0]
  return /^\p{L}{2,20}$/u.test(first) ? `Kak ${first[0].toUpperCase()}${first.slice(1)}` : 'Kak'
}

export function createFakeBrain ({ delayMs = 300 } = {}) {
  return {
    name: 'fake-keyword-brain',
    async triage ({ chat, messages, lookup }) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      const text = messages.map(message => message.text).join('\n')
      const kak = address(chat?.name)
      const rule = lookupRule(text, lookup) ?? RULES.find(candidate => candidate.pattern.test(text.trim()))
      const triage = rule
        ? {
            decision: rule.decision,
            reply: typeof rule.reply === 'function' ? rule.reply(kak) : rule.reply,
            facts_used: rule.facts,
            reason: `fake brain matched ${rule.pattern}`,
            summary: text.slice(0, 80),
            customer_waiting: Boolean(rule.waiting),
            holding_reply: rule.holding?.(kak) ?? ''
          }
        : { decision: 'escalate', reply: 'Terima kasih Kak, saya cek dulu ya.', facts_used: [], reason: 'fake brain: no rule matched', summary: text.slice(0, 80), customer_waiting: false, holding_reply: '' }
      return { ok: true, triage, rateLimit: { status: 'allowed', fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }, meta: { durationMs: delayMs, model: 'fake' } }
    }
  }
}
