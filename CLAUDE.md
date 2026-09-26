# CLAUDE.md — wa-claude-assistant

**Experimental personal prototype, not production.** A local Node service links to the owner's **own** WhatsApp as a
linked device (Baileys) and, for each incoming 1:1 text, asks Sonnet through the official `claude -p` CLI (the owner's
subscription) to `answer` or `escalate`. Answers auto-send only when every gate passes; everything else becomes a
draft in the owner's "Message yourself" chat.

- **Working document:** issue #1 (`gh issue view 1`). Keep it current by editing its **body**, not by adding comments.
- **Spec for users:** `README.md`. **Verified library/CLI facts:** `docs/implementation-notes.md`.
- **Evidence and sources:** `docs/research.md` (a 2026-09-26 snapshot; don't rewrite it, add dated notes instead).

## Hard boundaries

- **Never pair or connect to WhatsApp yourself.** `npm run pair` and `npm start` are the owner's (they need the phone).
  Transport tests use the injected fake socket in `test/whatsapp.test.js`.
- **Claude backend = the official `claude` binary**, spawned by `src/brain/claude.js`. Never read or copy OAuth tokens
  or `~/.claude` credentials, and never call claude.ai endpoints. Switching to an API key is an env change and an owner decision.
- **No ban evasion** (anti-detection, fingerprint spoofing), no bulk or outbound messaging, no messages to new
  contacts, no groups.
- **Real Claude calls only via `npm run selftest` (1 call) and `npm run eval` (20 calls).** They spend the owner's
  subscription quota, which is shared with their day job. Say how many calls you used.
- Downloads and clones go to `~/copilot/research/wa-claude-assistant/`, never `/tmp` (it is RAM on this machine). Delete them when done.

## Owner decisions (don't relitigate)

| Topic | Decision |
|---|---|
| Decision shape | Binary `answer` / `escalate`; no categories, no self-rated confidence |
| Model | `sonnet`, thinking off (`claude.maxThinkingTokens: 0`) |
| Auto-send | `answer` **and** every gate passes; any gate failure → draft that names the gate |
| Default mode | `shadow`; live is `{"mode":"live"}` in `config.local.json` |
| AI disclosure | On, first auto-send per 12 h session (Anthropic AUP); approved drafts carry no marker |
| Tone and facts | `knowledge.md`: `## Voice` for tone, `## Facts` is the only ground truth, `## Never` for hard rules |
| WhatsApp client | Baileys `7.0.0-rc14`, exact pin. Switch triggers are in `docs/implementation-notes.md` |
| Thanks | Never auto-answered; skipped only after a closing this session, drafted otherwise (2026-09-26) |

Ask the owner before changing **what gets auto-sent, drafted, or silently skipped**. Mechanical work needs no plan
confirmation here: just do it and report.

## Invariants (breaking one is a bug)

- **One send gate.** Every customer-bound message goes through `sendToCustomer()` in `src/assistant.js`, which enforces
  shadow mode and the blocklist. Owner notices go through `sendToOwner()`, start with 🤖, and are recorded as bot-sent **before** sending.
- **Untrusted text reaches Claude only on stdin**, XML-escaped. Never put it in argv. Spawn without a shell, with a
  minimal env (no inherited `ANTHROPIC_API_KEY`).
- **Isolation assertions fail closed** on every call: `tools == ["StructuredOutput"]`, no MCP, `apiKeySource: "none"`.
- **`policy.decide()` is pure.** A triage failure or a malformed decision → escalate, never auto-send.
- **Owner commands** come only from the owner's own `/` messages in self-chat: not bot-sent, not forwarded.
- **Each message id is processed once**, and history or backlog never auto-sends.

## Commands

| Command | What |
|---|---|
| `npm test` | Unit tests; no network, fake claude binary, fake socket |
| `npm run dev -- --fake-brain` | Offline console REPL (`alice: hi`, `me@alice: …`, `me: /ok 1`) |
| `npm run selftest` | 1 real call: prints isolation + quota, PASS/FAIL |
| `npm run eval` | 20 fixtures through real Claude + guards + policy → `eval/last-run.{md,json}` |
| `npm run eval -- --rescore=eval/last-run.json` | Re-apply current guards/policy to saved results, 0 calls |
| `npm run eval -- --only=id1,id2` | Subset → `eval/last-run-partial.*` |

**Eval rule:**
- A prompt, knowledge, model or thinking change needs a full `npm run eval`. A guards or policy change needs `--rescore`.
- Hard gate: **0 forbidden auto-sends and 0 skipped escalations**.
- Update `eval/last-run.md` and the README eval section after a run.

## Known weak spot

The social "thanks" path was the weak spot: every review round found bugs there, including an exponential-time matcher.
The owner-approved simplification is done (a thanks never auto-sends); the review fixes after `2a0c9b7` are **under
review**. What is left of the path, all of it load-bearing:
- `isThanks` in `src/guards.js` chooses skip vs draft, and whether an `/ok` or `/edit` text counts as the closing
  reply; `thanksAgrees` says whether a thanks carries an `ok`/`iya`/👍 (then it may be a yes). Deliberately narrow: a
  missed thanks costs a draft, a false match silently drops a real message after a closing. When in doubt, leave a
  phrase out.
- `isSocialMessage`, its fail-closed twin `socialWithoutQuestion` (a thanks, goodbye or yes anywhere in a message that
  asks nothing) and the `thanks_back` reply check in `checkReply` hold any auto-answer to a thanks, a goodbye or a yes,
  whatever it cites. Deliberately broad: a miss auto-sends a promise. When in doubt, add a phrase. Don't delete them as
  leftovers of the old path.
- `closedThisSession` in `src/policy.js` skips a thanks only after a closing this session (`lastClosingAt`, dated by
  the thanks) with nothing new since. It reads the history, the closing reply's message id (`store.closingReplies`),
  our last word on either addressing form (`lastOursAt`: `lastSentAt`, `ownerRepliedAt`) and the customer's untriaged
  content on either form (`lastUntriagedAt`, from the transport's `onUntriaged`). After a `/no`, a shadow `/ok` or a
  restart it skips only a thanks that does not agree; a quote skips only when it is of the closing reply (by id).

## Working style

- **Ultracode sessions:** use workflows for substantive work. The pattern that worked: one implementer → review
  lenses → one skeptic per finding (defaults to refuted) → one fixer → eval. It is saved as `.claude/workflows/review-fix.js`
  (`args: {context, lenses?, maxRounds?, evalBudget?}`). Run coding agents one at a time, since they share the working tree.
- **Skills** in `.claude/skills/` (copied from br-monorepo): `planning`, `external-research`. Use them for anything
  that depends on Baileys, WhatsApp or Anthropic policy facts, which change often; re-verify before relying on `docs/research.md`.
- **Code:** plain JavaScript ESM, Node 22, `node:test`, no build step, no TypeScript. Keep modules single-purpose and
  match the surrounding comment density: comments say *why*.
- **Git:** Conventional Commits with a lowercase description. Commit to `main` and push. Personal repo, no PR ceremony.
- **Reports to the owner:** terse, with numbers. Tests passed, eval results, Claude calls used, and what is unverified.
