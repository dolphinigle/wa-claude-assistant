# Implementation notes (from research synthesis, 2026-09-26)

Source: research workflow wf_1a2b7091-e96; see docs/research.md for evidence and sources.

## WhatsApp client decision

Pick: npm package `baileys`, pinned to exactly 7.0.0-rc14 (ESM, Node 22.15). The published tarballs of `baileys` and `@whiskeysockets/baileys` differ only in package name.

Why:
- Measured on this machine [ran]:
  - Time to QR: Baileys 0.88–1.05 s (skeptic re-run 0.98 s) vs whatsapp-web.js 7.1–13.7 s (median 7.2 s).
  - Memory: 114–133 MiB RSS in one process vs 0.49–0.52 GB PSS (1.2 GB summed RSS) for node plus about 11 Chrome processes.
  - Install: 59 MB / 72 packages / 9.3 s vs 86 MB / 193 packages plus a 626 MB browser download.
- API fit after pairing. Per source and docs, Baileys covers all five needs without patches:
  - receive text: messages.upsert, both 'notify' and 'append'
  - recent context: own store plus sock.fetchMessageHistory
  - self-chat detection: sock.user.id / sock.user.lid with areJidsSameUser
  - send/quote: sendMessage(jid,{text},{quoted:m}) returns the key, usable as a loop guard
  - skip groups/status: isJidGroup / isJidStatusBroadcast / isJidBroadcast / isJidNewsletter / isJidMetaAI
- whatsapp-web.js 1.34.7 is broken on today's WhatsApp Web on exactly those paths, because MsgKey._serialized was renamed to '$1' (confirmed on live WhatsApp Web 2.3000.1048557256):
  - reply/getQuotedMessage fail
  - getChats/getChatById throw 'r: r'
  - fetchMessages throws 't: t' (root cause unverified)
  - sendMessage returns undefined
  - Fix PRs have been unmerged for about 10 weeks, and the patches are untested live.
- Maintenance: both are weak. Baileys has no MEMBER/OWNER activity since 2026-08-05. whatsapp-web.js has no main merge since 2026-07-27, although a collaborator approved a media fix on 2026-09-25.
- Baileys' weakness sits in one step, and it can be tested first: new-device pairing has been reported broken since 2026-07-28 (#2737, companion_reg_refresh unhandled; fix PR #2765 unmerged, with 1 independent success report). whatsapp-web.js pairs through WhatsApp Web's own code, but that is untested (#201919 reports 'ready' never firing).

Go/no-go gate: the user performs one manual pairing on rc14.

Switch to whatsapp-web.js (pinned 1.34.7 plus the #201901/#201840 local patches) if any of these happen:
1. Pairing fails on rc14 AND on rc14 + PR #2765 pinned by commit SHA.
2. After pairing, messages.upsert repeatedly stops firing (#2810), or 405/408 loops persist with no upstream release.
3. whatsapp-web.js ships a release that merges the $1/MsgKey fix and #201919 is resolved.

Baileys v8's auth migration is not a trigger: keep rc14 pinned.


## Baileys API notes

PACKAGE AND IMPORTS
- package.json has "type":"module" and "baileys":"7.0.0-rc14" (exact pin; npm 'latest' is this RC). Node must be ≥20; require('baileys') works only on Node ≥22.12 via require(esm).
- Import: `import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, getContentType, isRealMessage, isJidGroup, isJidStatusBroadcast, isJidBroadcast, isJidNewsletter, isJidMetaAI, isLidUser, isPnUser, jidNormalizedUser, areJidsSameUser, getKeyAuthor, WAMessageStubType, proto } from 'baileys'`.

SOCKET
- `const {state, saveCreds} = await useMultiFileAuthState(AUTH_DIR)`
- `makeWASocket({ auth:{creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys, logger)}, logger, markOnlineOnConnect:false, syncFullHistory:false, getMessage: async key => store.get(key.remoteJid+':'+key.id)?.message, shouldIgnoreJid: jid => isJidBroadcast(jid)||isJidNewsletter(jid)||isJidMetaAI(jid) })`
- `sock.ev.on('creds.update', saveCreds)`
- Defaults are markOnlineOnConnect=TRUE (this stops phone push notifications) and syncFullHistory=TRUE. Set both to false explicitly.
- Keep the default browser ['Mac OS','Chrome','14.4.1']. A Desktop preset plus syncFullHistory gets closed with 428 before the QR: WIN32 on rc14, and DARWIN per the #2741 matrix.
- Version: the FAQ recommends the bundled default [2,3000,1043857760]. fetchLatestBaileysVersion() currently returns the same value.
- Keep the default shouldSyncHistoryMessage. Disabling all history sync breaks the LID-mapping bootstrap (the source logs DANGER).
- AUTH_DIR: mode 0700, outside git. Never pass it or debug logs to claude (SECURITY.md).

CONNECTION
- Event: connection.update {connection, lastDisconnect, qr, receivedPendingNotifications}.
- Render `qr` yourself; printQRInTerminal is deprecated. The first QR ref lasts 60 s, later ones 20 s. When refs run out the socket closes with 408 'QR refs attempts ended'.
- There is no built-in reconnect. Recreate the socket on close unless the code is 401. Status codes are at lastDisconnect.error.output.statusCode:
  - 401 loggedOut → alert, stop, wipe AUTH_DIR, manual re-pair
  - 515 restartRequired right after the scan → normal, recreate
  - 440 connectionReplaced → do not fight it
  - 405 → stale version: stop and alert
  - 408 / 428 / 500 / 503 / 411 → recreate with backoff
- Treat the socket as caught up only after receivedPendingNotifications:true. Use that as a watchdog for #2810: if it never arrives, recreate.
- sock.requestPairingCode may also be broken (#2832).

INGEST: messages.upsert {messages, type:'notify'|'append', requestId}
- Offline backlog arrives as 'append'. Process it when the message is !fromMe, isRealMessage, and messageTimestamp >= the persisted history floor (set once, on the first connection; a watermark moved by live traffic drops offline messages still queued behind it).
- Placeholder-resend answers (requestId) and retries arrive as 'notify' with the ORIGINAL timestamp: gate backlog on message age, not on the upsert type.
- The bot's own sends echo back as 'append' with fromMe (emitOwnEvents=true). Skip any key.id in sentByBot.
- Dedupe every message by key.id (#2822: Meta AI messages mimic self-chat and are redelivered every ~7 min).
- Ciphertext stub: `!m.message && m.messageStubType===WAMessageStubType.CIPHERTEXT` → sock.requestPlaceholderResend(m.key), only while the message is younger than backlog.maxAgeMinutes.
- Edits and revokes arrive as messages.update, not as upserts.
- Filter order: isJidStatusBroadcast before isJidBroadcast (status@broadcast matches both), then isJidNewsletter, isJidMetaAI (@bot), and isJidGroup (skip in v1).
- Text: `const c = normalizeMessageContent(m.message)`, then `c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? c?.documentMessage?.caption`. Use getContentType(c) for the type. Do not use extractMessageContent for type detection.
- Quoted message: c.extendedTextMessage.contextInfo {stanzaId, participant, quotedMessage}.
- Key fields: remoteJid, remoteJidAlt (DMs), participant, participantAlt (groups), fromMe, id, addressingMode 'lid'|'pn', remoteJidUsername.
- Sender name: m.pushName.
- Contacts with a WhatsApp username arrive as @lid with no alt (#2742).
- Key all state by remoteJid exactly as received, and reply to that same JID. Store the PN alt for display only.

SELF-CHAT
- `const me = [jidNormalizedUser(sock.user.id), sock.user.lid && jidNormalizedUser(sock.user.lid)].filter(Boolean)`
- `isSelfChat = !isJidGroup(jid) && me.some(x => areJidsSameUser(jid, x))`. areJidsSameUser returns false for PN vs LID, so check both.
- The user's typing in self-chat arrives as 'notify' with fromMe. Act only on a command prefix such as /ok n, /edit n <text>, /no n.
- A fromMe 'notify' in a customer chat means the user replied from the phone: cancel that chat's pending draft.
- Unverified: whether the self-chat remoteJid is the own PN or the own LID, and whether sending to jidNormalizedUser(sock.user.id) lands in 'Message yourself'.

SEND
- `const sent = await sock.sendMessage(remoteJid, {text}, {quoted: m}); sentByBot.add(sent.key.id)`. Quote only text messages; quoted media replies do not render on mobile (#2739).
- Typing: sock.sendPresenceUpdate('composing', jid) expires after ~10 s, so repeat it while Claude runs, then send 'paused'.
- sock.readMessages([m.key]) sends blue ticks when the privacy setting is 'all'. Call it only after an auto-reply; never for drafted or escalated chats. There is no whole-chat mark-read.
- Never call chatModify with guessed lastMessages; the docs say it can log out all devices.

CONTEXT
- There is no makeInMemoryStore in v7. Keep a rolling Map/SQLite store keyed `${remoteJid}:${id}`, filled from messages.upsert (both types) and messaging-history.set {chats, contacts, messages, lidPnMappings, syncType}.
- On demand: sock.fetchMessageHistory(50, oldestKnown.key, oldestKnown.messageTimestamp). The result arrives through messaging-history.set with syncType ON_DEMAND. It needs an anchor message and a reachable phone.

LID/PN
- sock.signalRepository.lidMapping.getLIDForPN / getPNForLID. getPNForLID works only for pairs already cached. Event: 'lid-mapping.update'.

PAIRING FALLBACK
- If the unpatched pairing fails, use a git dependency on PR #2765 pinned by commit SHA. Review the diff first; it is a supply-chain risk.

REUSABLE FILES
- ~/copilot/research/wa-claude-assistant/exp-baileys/probe.mjs: stops at QR and deletes auth; never renders the QR.
- ~/copilot/research/wa-claude-assistant/exp-baileys/helpers-check.mjs


## Locked `claude -p` invocation

cd "$EMPTY_DIR" && env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 MAX_THINKING_TOKENS=0 ENABLE_CLAUDEAI_MCP_SERVERS=false DISABLE_AUTOUPDATER=1 MAX_STRUCTURED_OUTPUT_RETRIES=2 claude -p --model haiku --output-format stream-json --verbose --safe-mode --setting-sources "" --strict-mcp-config --tools "" --disallowedTools "mcp__*" --disable-slash-commands --no-session-persistence --system-prompt-file "$PROMPT_DIR/triage-system.txt" --json-schema "$(cat "$PROMPT_DIR/triage-schema.json")" < message.txt

The untrusted text goes ONLY on stdin, as `<message from=".." name="..">\n{text}\n</message>`, with & and < escaped in both the text and the attributes.

From Node: spawn('claude', ARGS, {cwd: EMPTY_DIR, env: {HOME, PATH, LANG:'C.UTF-8', CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1', MAX_THINKING_TOKENS:'0', ENABLE_CLAUDEAI_MCP_SERVERS:'false', DISABLE_AUTOUPDATER:'1', MAX_STRUCTURED_OUTPUT_RETRIES:'2'}, stdio:['pipe','pipe','pipe']}), no shell, then child.stdin.end(wrapped), with a 60 s SIGTERM timeout (exit 143).

Schema: {"type":"object","properties":{"category":{"type":"string","enum":["simple","complex","important","ignore"]},"confidence":{"type":"number","minimum":0,"maximum":1},"reply":{"type":"string"},"reason":{"type":"string"}},"required":["category","confidence","reply","reason"],"additionalProperties":false}

Parse stdout as JSON lines:
- system/init: assert tools==['StructuredOutput'], mcp_servers/skills/slash_commands==[], apiKeySource=='none'; log claude_code_version and model.
- rate_limit_event.rate_limit_info: status, unifiedWindows.five_hour.utilization, unifiedWindows.seven_day.utilization, resetsAt.
- result: ok = exitCode===0 && is_error===false && structured_output present.

Verified 4 of 4 by the synthesizer on 2026-09-26 with v2.1.283. Inputs: ~/copilot/research/wa-claude-assistant/synth-claude/{run-locked.sh,triage-system.txt,triage-schema.json}.


## Claude caveats

- `--bare` refuses the subscription login ('Not logged in · Please run /login'). headless.md says --bare 'will become the default for -p in a future release', and the CLI auto-updates almost daily (2.1.280→2.1.283 between 09-22 and 09-26, with 4 versions kept). A future update can therefore break the pipeline. Assert init.claude_code_version and alert on 'Not logged in'. DISABLE_AUTOUPDATER=1 only covers the child process; interactive sessions still update the shared binary.
- Success = exit code 0 AND is_error===false AND structured_output present. Errors come back as is_error:true with subtype 'success' (bad model: api_error_status 404; --bare: not logged in). On error_max_structured_output_retries the `result` key is absent, not null. stop_reason is 'tool_use' on success.
- MAX_STRUCTURED_OUTPUT_RETRIES counts total attempts (default 5 = 1 attempt + 4 retries). The lock uses 2.
- Never put the WhatsApp text in argv. It gets parsed as CLI flags ('--version' printed the version), it is visible in ps, and a single argv string is capped at 131072 bytes. An argv prompt with an open, empty stdin also adds a 3 s wait. Stdin is capped at 10 MB per the docs.
- --safe-mode is documented only as a troubleshooting flag. It is kept as an extra layer on top of the documented CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. Without either one, auto memory leaks (run B: canary leaked, 574 tokens). The built-in plugins agents-md and telemetry still load. Enforce the init assertions on every call.
- ENABLE_CLAUDEAI_MCP_SERVERS=false and --disallowedTools 'mcp__*' are documented and were included in the 4 verified runs, but neither was tested on its own.
- An ANTHROPIC_API_KEY in the environment silently switches -p to API billing ('always used when present'). Spawn with an explicit minimal env.
- Quota is shared with the user's own Claude/Claude Code use across 5-hour and weekly windows, whose size is unpublished (utilization was 0.42 / 0.24 during the tests). Only stream-json emits rate_limit_event. The -p output when the limit is exhausted has not been observed. total_cost_usd ($0.0020–0.0036 per locked call) is a list-price client estimate, not billing.
- Latency: 4.5–7.8 s wall-clock for the locked command, of which about 2.1–2.4 s is fixed spawn overhead (1.7–2.9 s across all runs; 5.1 s once on a loaded machine). n≤4 per config gives no p95. Keep a queue with concurrency ≤2 (2 concurrent calls were verified).
- The 'haiku' alias floats; it resolved to claude-haiku-4-5-20251001 on 2026-09-26. With thinking on (the default), haiku was not faster than sonnet 5. MAX_THINKING_TOKENS=0 gave 0 thinking tokens on haiku (4/4, synth).
- Prompt-injection coverage is small: the injection fixture was categorized correctly 7/7 (researcher) plus 1/1 (synth), and the escaped tag-breakout 1/1. Keep --tools '' so no actions are possible, auto-send only 'simple' above a confidence threshold, and keep a human path.
- Drafts can over-promise: the V3 'complex' draft committed to a follow-up the owner never agreed to. 'complex' and 'important' must stay drafts that the owner approves.
- Policy: the Consumer Terms bar 'automated or non-human means, whether through a bot, script' except via an API key or explicit permission, and the limits 'assume ordinary, individual usage'. No official ruling covers an always-on personal bot. The paused move of -p onto a separate credit could resume. Keep the backend behind one function so it can be swapped to an API key.
- Anthropic AUP: an external-facing interactive AI agent 'must disclose to users that they are interacting with AI … at a minimum at the beginning of each chat session'. Put a disclosure in the first auto-reply of each chat session.
- --json-schema treats the 'format' keyword as an annotation and does not enforce it. An invalid schema fails before any API call, with exit 1, empty stdout and the error on stderr.


## Unresolved (need live pairing or later work)

- Go/no-go: does QR pairing complete on unpatched Baileys rc14 with the default Mac OS/Chrome preset? If not, does it complete with PR #2765? This needs one user-performed pairing; the research was not allowed to pair.
- Self-chat id form under LID addressing: is key.remoteJid the own PN or the own LID, and does sendMessage to jidNormalizedUser(sock.user.id) land in 'Message yourself'?
- Does a message posted by the linked device to self-chat trigger a push notification on the phone? If not, escalations are silent.
- Does sock.readMessages() from the linked device clear the unread badge on the phone?
- What exact claude -p JSON and exit code come back when the subscription 5-hour or weekly limit is exhausted, and what share of the window does one triage call use?
- Does Anthropic consider an always-on personal WhatsApp auto-responder 'ordinary, individual usage'? No official page says; ask support, or switch to an API key.
- Would a long-lived --input-format stream-json claude process remove the ~2 s per-call spawn cost while keeping per-message isolation? Untested.
- Neither ENABLE_CLAUDEAI_MCP_SERVERS=false nor --disallowedTools 'mcp__*' was tested on its own; both were only in the verified bundle.
- Memory and CPU after pairing and initial history sync are unmeasured for both libraries.
- Will Baileys merge #2765 / #2825 and cut rc15 before v8's auth-format change? Will whatsapp-web.js merge the $1/MsgKey fix (#201901 / #201840)?
- Do contacts with WhatsApp usernames (@lid with no PN alt, #2742) reach messages.upsert at all?
- Is Business App Terms restriction (g) new in the 2026-09-23 revision? Is Meta Business Agent officially available in Indonesia? Only press sources say so. What are the PP 33/2026 effective dates? Sources give 15 vs 16 Jan 2027.
- Two Meta pricing pages conflict on what happens without a payment method. The non-template doc (2026-08-25) says delivery stops from 10-01. The pricing doc (2026-09-10) says the 1,000/month free tier is still delivered.
- Leftover artifacts not deleted: ~/copilot/research/wa-claude-assistant/{exp-baileys 59M, exp-wwebjs 86M, claude-exp, claude-skeptic, synth-claude, synth-meta, terms-risk 14M, risk-skeptic, skeptic-baileys 11M, claude-leaktest/.claude}, plus ~/.claude/projects/-home-irvan-copilot-research-wa-claude-assistant-claude-leaktest/ (a canary MEMORY.md and a session transcript; the earlier rm was permission-denied). No processes left; checked with ps.
- The new repo ~/copilot/wa-claude-assistant (remote github.com/dolphinigle/wa-claude-assistant, no commits yet) now has an untracked docs/research.md. It was not committed, per instructions.