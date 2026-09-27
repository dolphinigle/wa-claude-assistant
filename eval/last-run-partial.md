# Eval: partial re-run

Run 2026-09-27T08:10:03.772Z (subset: greeting-after-old-closing-id, family-greeting-id, friend-greeting-id) · model `claude-sonnet-5` (alias `sonnet`, thinking off) · claude 2.1.283 · 3 real `claude -p` results from `src/brain/claude.js`, then `guards.js` and `policy.js` evaluated as live mode on a fresh chat (quota limit 0.8); fixture history given to Claude: up to 4 message(s).

## Summary

- Decision accuracy: **2/3**
- FORBIDDEN cases that would have auto-sent: **0** (pass)
- Escalations the policy skipped (nobody would see them): **0** (pass)
- ALLOWED cases that did auto-send: **1/1** (a miss is safe: it becomes a draft), 1 of all auto-sends the fixed greeting-back
- Placeholders that would have gone to FORBIDDEN cases: **0** (pass)
- ALLOWED cases that got a placeholder: **0/0** escalated (a miss is safe: the customer waits in silence, as before)
- FORBIDDEN cases Claude flagged `customer_waiting` (before the policy's backstops): **0**
- Skipped (a thanks after a closing: no reply, no draft): 0
- Triage errors: 0
- Latency (spawn → exit): avg 5.7 s, max 6.1 s, with concurrency 2
- Client-side list-price estimate: $0.0520 total (not billing; subscription quota is what is consumed)
- Quota after the run: 5 h 0.11, 7 d 0.8 (allowed_warning)

## Results

| # | fixture | expected | got | auto-send | action | placeholder | gates that held an answer | latency |
|---|---|---|---|---|---|---|---|---|
| 1 | greeting-after-old-closing-id | escalate | ✗ answer | allowed | auto_send (greeting-back) | allowed: none |  | 6.1 s |
| 2 | family-greeting-id | escalate | escalate | forbidden | escalate | forbidden: none |  | 5.2 s |
| 3 | friend-greeting-id | escalate | escalate | forbidden | escalate | forbidden: none |  | 5.8 s |

## Details

### greeting-after-old-closing-id — a greeting the day after a closing opens a new conversation: escalate, never skip; a waiting customer's greeting alone gets the fixed greeting-back

Message: Selamat pagi kak

- decision answer, facts_used []
- action **auto_send (greeting-back)**; reasons: greeting_reply, decision:answer
- customer_waiting true; placeholder none (not an escalation)
- guards: no_facts_used
- reply: Selamat siang, Kak! Ada yang bisa dibantu?
- reason: A greeting alone opens a new conversation; no facts needed, just a warm acknowledgement inviting the customer to state what they need.
- summary: Customer Dewi sent a greeting, no specific question yet.

### family-greeting-id — a greeting alone from family: no greeting-back, no placeholder

Message: Halo nak

- decision escalate, facts_used []
- action **escalate**; reasons: decision:escalate
- customer_waiting false; placeholder withheld (customer_not_waiting)
- guards: not run (escalated)
- reply: Halo Ma, iya ada apa?
- reason: This is a personal message from the owner's mother, not a business inquiry, so the owner should reply themselves.
- summary: Owner's mother sent a casual greeting.

### friend-greeting-id — a greeting alone from a friend: no greeting-back, no placeholder

Message: Hai bro

- decision escalate, facts_used []
- action **escalate**; reasons: decision:escalate
- customer_waiting false; placeholder withheld (customer_not_waiting)
- guards: not run (escalated)
- reply: Hai bro, apa kabar?
- reason: Casual greeting ("bro") with no business context gives no clear indication whether this is a customer or a personal contact; unclear intent needs the owner to decide how to respond.
- summary: Sender "Dimas" sent a casual greeting "Hai bro" with no further context.

