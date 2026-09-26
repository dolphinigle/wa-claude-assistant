// Deterministic keyword brain for the offline console demo (`npm run dev -- --fake-brain`). Same contract as
// createClaudeBrain().triage, no network, no Claude.

const RULES = [
  { pattern: /transfer|bayar|payment|refund|darurat|emergency|urgent|penting|kecewa|angry/i, decision: 'escalate', reply: 'Baik Kak, pesannya sudah saya terima. Saya cek dulu ya.', facts: [] },
  { pattern: /menang|hadiah|undian|prize|winner|klik link|promo/i, decision: 'escalate', reply: '', facts: [] },
  { pattern: /^(?:(?:ok+|oke|sip|siap|makasih|terima kasih|thanks?|thank you|kak)\b[\s,.!]*)+[\p{Emoji}\s.!]*$/iu, decision: 'answer', reply: 'Sama-sama, Kak 🙏', facts: [] },
  { pattern: /jam|buka|open|hours/i, decision: 'answer', reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB, Minggu tutup ya Kak.', facts: ['F1'] },
  { pattern: /alamat|address|lokasi|where/i, decision: 'answer', reply: 'Alamat kami di Jl. Contoh Raya No. 12, Coblong, Bandung ya Kak.', facts: ['F2'] },
  { pattern: /brownies/i, decision: 'answer', reply: 'Brownies panggang loyang 20x20 cm harganya Rp 85.000 ya Kak.', facts: ['F5'] }
]

export function createFakeBrain ({ delayMs = 300 } = {}) {
  return {
    name: 'fake-keyword-brain',
    async triage ({ messages }) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      const text = messages.map(message => message.text).join('\n')
      const rule = RULES.find(candidate => candidate.pattern.test(text.trim()))
      const triage = rule
        ? { decision: rule.decision, reply: rule.reply, facts_used: rule.facts, reason: `fake brain matched ${rule.pattern}`, summary: text.slice(0, 80) }
        : { decision: 'escalate', reply: 'Terima kasih Kak, saya cek dulu ya.', facts_used: [], reason: 'fake brain: no rule matched', summary: text.slice(0, 80) }
      return { ok: true, triage, rateLimit: { status: 'allowed', fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }, meta: { durationMs: delayMs, model: 'fake' } }
    }
  }
}
