# CLAUDE.md — wa-claude-assistant

**Experimental personal prototype, not production.** A local Node service links to the owner's **own** WhatsApp as a
linked device (Baileys) and, for each incoming 1:1 text, asks Sonnet through the official `claude -p` CLI (the owner's
subscription) to `answer` or `escalate`. Answers auto-send only when every gate passes; everything else becomes a
draft in the owner's "Message yourself" chat.

- **Working document:** issue #1 (`gh issue view 1`). Keep it current by editing its **body**, not by adding comments.
- **Spec for users:** `README.md`. **Verified library/CLI facts:** `docs/implementation-notes.md`.
- **Evidence and sources:** `docs/research.md` (a 2026-09-26 snapshot; don't rewrite it, add dated notes instead).
- **For other projects:** `docs/building-on-this.md` (seams, recipe, real data) and `docs/reference-guide.md` record everything learned (verified facts, design and why, what
  reviews kept finding, live results). The owner wants it complete: update it whenever something is learned or changed.

## Hard boundaries

- **Never pair or connect to WhatsApp yourself.** `npm run pair` and `npm start` are the owner's (they need the phone).
  Transport tests use the injected fake socket in `test/whatsapp.test.js`. Only exception: the owner asks in the session
  for a live test, as on 2026-09-27 (live for one friend who knows, via `allowChats`); subagents never connect.
- **Claude backend = the official `claude` binary**, spawned by `src/brain/claude.js`. Never read or copy OAuth tokens
  or `~/.claude` credentials, and never call claude.ai endpoints. Switching to an API key is an owner decision, and more than an env change: the `apiKeySource: "none"` assertion and the quota gate both fail closed under a key.
- **No ban evasion** (anti-detection, fingerprint spoofing), no bulk or outbound messaging, no messages to new
  contacts, no groups.
- **Real Claude calls only via `npm run selftest` (1 call) and `npm run eval` (24 calls).** They spend the owner's
  subscription quota, which is shared with their day job. Say how many calls you used.
- Downloads and clones go to `~/copilot/research/wa-claude-assistant/`, never `/tmp` (it is RAM on this machine). Delete them when done.

## Owner decisions (don't relitigate)

| Topic | Decision |
|---|---|
| Decision shape | Binary `answer` / `escalate`; no categories, no self-rated confidence |
| Model | `sonnet`, thinking off (`claude.maxThinkingTokens: 0`) |
| Auto-send | `answer` **and** the customer's message asks something **and** every gate passes (an answer citing no fact passes only if it just asks: a `?`, nothing concrete, no yes up front, 2026-09-27); anything else → draft that names the reason (`no_question` or the gate) (2026-09-27) |
| Default mode | `shadow`; live is `{"mode":"live"}` in `config.local.json` |
| AI disclosure | On, first auto-send per 12 h session (Anthropic AUP), as a 🤖 prefix only (2026-09-27); an escalation placeholder that starts with 🤖 counts as it; approved drafts carry no marker |
| Escalation placeholder | An escalated customer Claude flags `customer_waiting` gets the fixed `🤖 Halo Kak, tunggu sebentar ya 🙏` (`🤖 Hi! One moment please 🙏` in English), once per open-draft period; a customer's greeting alone counts as waiting. Never family or friends, spam, manipulation (`tag_like`), a thanks, a text without words, backlog, or a paused, muted, blocked, taken-over or capped chat; none when `autoSend.enabled` is false (drafts only = nothing automated) (2026-09-27) |
| Tone and facts | `knowledge.md`: `## Voice` for tone, `## Facts` is the only ground truth, `## Never` for hard rules |
| WhatsApp client | Baileys `7.0.0-rc14`, exact pin. Switch triggers are in `docs/implementation-notes.md` |
| Thanks | Never auto-answered (it asks nothing); skipped only after a closing this session, drafted otherwise (2026-09-26) |
| Greeting reply | A waiting customer's greeting alone that opens the conversation gets the fixed `greetingReply.text` (`Halo Kak, ada yang bisa saya bantu? 🙏`) as an auto-send, once per session, through the non-Claude gates; `greetingReply.enabled: false` turns it off (2026-09-27) |
| Demo mode | Opt-in `"demo": {"enabled": true}` in `config.local.json`, only with a non-empty `allowChats`: Claude answers like CS and may invent what the facts don't give (`prompts/triage-demo.md`); guards skip the facts checks but `demo_payment_detail` holds bank, account and transfer details; no `no_question` hold; per-chat cap `demo.maxPerChatPerHour`. The eval forces it off (2026-09-27) |
| Borma demo | Branch `borma-demo`: `knowledge.md` is Borma's (the bakery is `eval/knowledge.md`, used by the eval and tests); `"borma": {"enabled": true}` adds per-message catalog, store and own-order facts (README "Borma demo"). In demo mode prices must still come from the cited facts (2026-09-28) |
| Trying it live | `allowChats` in `config.local.json`: only the listed chats are handled, every other chat is untouched (2026-09-27) |

Ask the owner before changing **what gets auto-sent, drafted, or silently skipped**. Mechanical work needs no plan
confirmation here: just do it and report.

## Invariants (breaking one is a bug)

- **One send gate.** Every customer-bound message goes through `sendToCustomer()` in `src/assistant.js`, which enforces
  shadow mode, the blocklist and `allowChats`. Owner notices go through `sendToOwner()`, start with 🤖, and are recorded as bot-sent **before** sending.
- **Untrusted text reaches Claude only on stdin**, XML-escaped. Never put it in argv. Spawn without a shell, with a
  minimal env (no inherited `ANTHROPIC_API_KEY`).
- **Isolation assertions fail closed** on every call: `tools == ["StructuredOutput"]`, no MCP, `apiKeySource: "none"`.
- **`policy.decide()` is pure.** A triage failure or a malformed decision → escalate, never auto-send.
- **Owner commands** come only from the owner's own `/` messages in self-chat: not bot-sent, not forwarded.
- **Each message id is processed once**, and history or backlog never auto-sends and never gets a placeholder.
- **No link previews.** `send()` in `src/transport/whatsapp.js` passes `linkPreview: null`: otherwise Baileys fetches
  URLs in outgoing text from this machine, and notices quote customers' and spammers' links.
- **Key material never reaches a log.** libsignal's session dumps are redacted before the console
  (`src/transport/redact-signal-logs.js`); read the bot's logs through a filter, never raw.

## Commands

| Command | What |
|---|---|
| `npm test` | Unit tests; no network, fake claude binary, fake socket |
| `npm run dev -- --fake-brain` | Offline console REPL (`alice: hi`, `me@alice: …`, `me: /ok 1`) |
| `npm run selftest` | 1 real call: prints isolation + quota, PASS/FAIL |
| `npm run eval` | 24 fixtures through real Claude + guards + policy → `eval/last-run.{md,json}` |
| `npm run eval -- --rescore=eval/last-run.json` | Re-apply current guards/policy to saved results, 0 calls |
| `npm run eval -- --only=id1,id2` | Subset → `eval/last-run-partial.*` |
| `npm run export` | Borma demo (this branch): read-only BigQuery export → `data/borma/` (~155 MB scanned) |
| `npm run eval -- --borma` | `eval/fixtures-borma.json` (5 calls) against `knowledge.md` + the export → `data/borma/` |

**Eval rule:**
- A prompt, knowledge, model or thinking change needs a full `npm run eval`. A guards or policy change needs `--rescore`.
- Hard gate: **0 forbidden auto-sends, 0 skipped escalations and 0 forbidden placeholders**. Also read "FORBIDDEN cases
  Claude flagged `customer_waiting`": the policy's backstops hide Claude's misses from the gate.
- `npm run eval` reads `config.local.json` too; the harness raises `contextMessages` to the fixtures' histories.
- Update `eval/last-run.md` and the README eval section after a run.

## Known weak spot

Word matching on customer text decides three things, and every review round has found cases it gets wrong (the old
thanks path even had an exponential-time matcher). Both are deliberately fail-closed; keep them that way.
- **Auto-send:** `asksSomething` in `src/guards.js` (`no_question` in `decide()`, right after the decision). A message
  asks if it has a `?` (links left out), a question word or phrase, a request word with something to request in its
  clause (not after `saya`/`I`, not negated), or a tag question (`gak`, `belum`, `kan` …) at a clause's end. A missed
  question costs a draft; a false one only hands the answer to the other gates (Claude's decision, the facts-only
  guards). When in doubt, leave a word out; it must stay false on every `isThanks` text (tested). It replaced
  `isSocialMessage`, `socialWithoutQuestion`, `thanks_back` and `thanks_not_auto_sent`: don't bring them back.
- **Silent skip:** `isThanks`/`thanksAgrees` in `src/guards.js` and `closedThisSession` in `src/policy.js` skip a thanks
  only after a closing this session (`lastClosingAt`, dated by the thanks) with nothing new since: the history, the
  closing reply's message id (`store.closingReplies`), our last word on either addressing form (`lastOursAt`), the
  customer's untriaged content (`lastUntriagedAt`: captionless files, pins, stubs, stickers, reactions, missed calls)
  and newest non-thanks message (`lastOpenedAt`) on either form. A false match drops a real message: keep the
  vocabulary narrow.
- **Placeholder:** Claude's `customer_waiting` decides it; the policy only ever withholds it (`placeholderWithheld`:
  `isLooseThanks`, no letter or digit, `tag_like` on the text and its quotes). `isLooseThanks` may read loosely (a false
  match only withholds a fixed text) but must never widen the skip, which keeps the narrow `isThanks`. With no chat
  history, a family member's bare "Halo" looks like a customer's and gets the placeholder.
- Ten review rounds on 2026-09-26/27 (after `2a0c9b7`) confirmed and fixed or deferred 86 findings; the loop never ran
  dry (mostly word-list edge cases). The last round's fixes (`dd9361b`..`c2aade9`) are unreviewed.

## Working style

- **Keep it light (owner, 2026-09-27): this is a prototype.** One implementer with its own tests, then at most one
  review round when the change touches what reaches a customer; prefer `--rescore` and `--only=` eval subsets over full
  runs. Don't polish docs or chase word-list edge cases.
- **Ultracode sessions:** use workflows for substantive work. The pattern that worked: one implementer → review
  lenses → one skeptic per finding (defaults to refuted) → one fixer → eval. It is saved as `.claude/workflows/review-fix.js`
  (`args: {context, lenses?, maxRounds?, evalBudget?}`). Run coding agents one at a time, since they share the working tree.
- **Skills** in `.claude/skills/` (copied from br-monorepo): `planning`, `external-research`. Use them for anything
  that depends on Baileys, WhatsApp or Anthropic policy facts, which change often; re-verify before relying on `docs/research.md`.
- **Code:** plain JavaScript ESM, Node 22, `node:test`, no build step, no TypeScript. Keep modules single-purpose and
  match the surrounding comment density: comments say *why*.
- **Git:** Conventional Commits with a lowercase description. Commit to `main` and push. Personal repo, no PR ceremony.
- **Reports to the owner:** terse, with numbers. Tests passed, eval results, Claude calls used, and what is unverified.
