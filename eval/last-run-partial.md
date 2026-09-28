# Eval: partial re-run

Run 2026-09-28T12:37:37.843Z (subset: greeting-after-old-closing-id, friend-greeting-id) · model `claude-sonnet-5` (alias `sonnet`, thinking off) · claude 2.1.283 · 2 real `claude -p` results from `src/brain/claude.js`, then `guards.js` and `policy.js` evaluated as live mode on a fresh chat (quota limit 0.8); fixture history given to Claude: up to 4 message(s).

## Summary

- Decision accuracy: **1/2**
- FORBIDDEN cases that would have auto-sent: **0** (pass)
- Escalations the policy skipped (nobody would see them): **0** (pass)
- ALLOWED cases that did auto-send: **1/1** (a miss is safe: it becomes a draft), 1 of all auto-sends a greeting-back
- Placeholders that would have gone to FORBIDDEN cases: **0** (pass)
- ALLOWED cases that got a placeholder: **0/0** escalated (a miss is safe: the customer waits in silence, as before)
- FORBIDDEN cases Claude flagged `customer_waiting` (before the policy's backstops): **0**
- Holding replies on escalations Claude flagged waiting: 0/0 written, **0** passed the guard, 0 distinct
- Skipped (a thanks after a closing: no reply, no draft): 0
- Triage errors: 0
- Latency (spawn → exit): avg 5.6 s, max 5.9 s, with concurrency 2
- Client-side list-price estimate: $0.0554 total (not billing; subscription quota is what is consumed)
- Quota after the run: 5 h 0.23, 7 d 0.06 (allowed)

## Results

| # | fixture | expected | got | auto-send | action | placeholder | gates that held an answer | latency |
|---|---|---|---|---|---|---|---|---|
| 1 | greeting-after-old-closing-id | escalate | ✗ answer | allowed | auto_send (greeting-back) | allowed: none |  | 5.3 s |
| 2 | friend-greeting-id | escalate | escalate | forbidden | escalate | forbidden: none |  | 5.9 s |

## Details

### greeting-after-old-closing-id — a greeting the day after a closing opens a new conversation: escalate, never skip; a waiting customer's greeting alone gets the fixed greeting-back

Message: Selamat pagi kak

- decision answer, facts_used []
- action **auto_send (greeting-back)**; reasons: greeting_reply, decision:answer
- customer_waiting true; placeholder none (not an escalation)
- guards: pass
- reply: Pagi juga Kak Dewi, ada yang bisa dibantu?
- greeting-back check: pass
- holding_reply: Pagi Kak Dewi, terima kasih sudah menyapa, ada yang bisa dibantu ya 🙏 (guard: pass)
- reason: A new greeting from a business customer opens a conversation; the previous thread was already closed with a social exchange, so this is a fresh greeting that can be answered with a greeting-back and open question.
- summary: Customer Dewi says good morning, opening a new conversation.

### friend-greeting-id — a greeting alone from a friend: no greeting-back, no placeholder

Message: Hai bro

- decision escalate, facts_used []
- action **escalate**; reasons: decision:escalate
- customer_waiting false; placeholder withheld (customer_not_waiting)
- guards: not run (escalated)
- reply: Hai bro!
- greeting-back check: no_facts_used
- holding_reply: (empty)
- reason: Greeting only, using a casual/buddy term ('bro') that suggests a personal contact rather than a business customer, so the owner should decide how to respond.
- summary: Dimas sent a casual greeting ('Hai bro') with no other content.

