// Orchestrator: dedupe, loop guard, takeover, debounce, triage, policy, and the ONE send gate.
import { findPrivateDetails, guardTriage, isThanks, privateIdentifiersFor } from './guards.js'
import { BOT_PREFIX, createOwnerCommands, excerpt, formatClock, formatContact, formatDraftNotice, jidUser } from './owner.js'
import { decide } from './policy.js'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const EXPIRY_SWEEP_MS = 10 * MINUTE_MS
const DEFAULT_LIVE_WINDOW_MINUTES = 2

/**
 * @param {object} deps
 * @param {{triage: Function}} deps.brain
 * @param {{send: Function, sendToSelf: Function, markRead?: Function, getHistory?: Function, generateId?: Function}} deps.transport
 */
export function createAssistant ({ config, store, brain, transport, knowledge, now = () => Date.now(), logger = console }) {
  const chats = new Map() // chatId → {pending: message[], timer, generation}
  const work = new Set()
  let stopped = false
  let flushingOutbox = false

  const track = promise => {
    work.add(promise)
    promise.catch(error => logger.error(`[assistant] ${error.stack ?? error.message}`)).finally(() => work.delete(promise))
    return promise
  }
  const runtime = chatId => {
    if (!chats.has(chatId)) chats.set(chatId, { pending: [], timer: null, generation: 0 })
    return chats.get(chatId)
  }
  const contactName = chatId => store.chat(chatId).name ?? chatId.split('@')[0] // what Claude sees
  const contactLabel = chatId => formatContact(chatId, store.existingChat(chatId)) // what the owner sees
  // A burst as the owner sees it: a file is named, since only its caption reaches Claude.
  const describe = batch => batch.map(message => (message.attachment ? `[${message.attachment}] ${message.text}`.trim() : message.text)).join(' / ')
  // The owner's reply can arrive on the other addressing form of the customer's chat (PN vs LID), so takeover state
  // is read across both records. So are the per-person gates: a mute, a closing and the hourly cap.
  const linkedChats = (chatId, chatIdAlt) => store.linkedChatIds(chatId, chatIdAlt).map(id => store.existingChat(id)).filter(Boolean)
  const takeoverUntil = chatId => Math.max(0, ...linkedChats(chatId).map(chat => chat.takeoverUntil ?? 0))
  const ownerRepliedAt = (chatId, chatIdAlt) => Math.max(0, ...linkedChats(chatId, chatIdAlt).map(chat => chat.ownerRepliedAt ?? 0))
  const lastClosingAt = chatId => Math.max(0, ...linkedChats(chatId).map(chat => chat.lastClosingAt ?? 0))
  // Our side's last word on either form, kept across restarts: the owner on the phone, or any send but a closing.
  const lastOursAt = chatId => Math.max(0, ...linkedChats(chatId).flatMap(chat => [chat.ownerRepliedAt ?? 0, chat.lastSentAt ?? 0]))
  const lastUntriagedAt = chatId => Math.max(0, ...linkedChats(chatId).map(chat => chat.lastUntriagedAt ?? 0))
  const chatAutoSendsLastHour = chatId => store.linkedChatIds(chatId).reduce((sum, id) => sum + store.countChatAutoSends(id, HOUR_MS), 0)
  /** Epoch ms of a burst's newest message: a closing is dated by the thanks it closes, not by when it was handled. */
  const lastMessageAt = batch => Math.max(...batch.map(message => message.timestamp)) * 1000

  // Entries are JIDs or phone numbers (08…, 62…, +62…); pushNames are not accepted because senders choose them.
  // A LID chat's phone number is known only from an alt JID (its messages, or WhatsApp's LID mapping), which is kept
  // on the chat record.
  const phoneEntry = entry => {
    const value = String(entry).trim()
    const digits = value.replace(/\D/g, '').replace(/^0/, '62')
    return !value.includes('@') && digits.length >= 6 ? digits : undefined
  }
  function isBlocked (chatId, chatIdAlt) {
    const ids = store.linkedChatIds(chatId, chatIdAlt)
    const users = ids.map(jidUser)
    return (config.blocklist ?? []).some(entry => ids.includes(String(entry).trim()) || users.includes(phoneEntry(entry)))
  }
  /** A LID chat with no known phone number cannot be matched against phone-number entries: fail closed (drafts). */
  const blocklistUnchecked = chatId => chatId.endsWith('@lid') &&
    !store.linkedChatIds(chatId).some(id => id.endsWith('@s.whatsapp.net')) &&
    (config.blocklist ?? []).some(phoneEntry)
  const openDrafts = chatId => {
    const chatIds = store.linkedChatIds(chatId)
    return store.pendingDrafts().filter(draft => chatIds.includes(draft.chatId))
  }

  // --- the send gate: every outgoing message passes through one of these two functions ------------------------

  /** A notice that fails (socket reconnecting) is kept in the store's outbox and re-sent later, never dropped. */
  async function sendToOwner (text, { queueOnFailure = true } = {}) {
    const body = text.startsWith(BOT_PREFIX) ? text : `${BOT_PREFIX} ${text}`
    const messageId = transport.generateId?.()
    if (messageId) store.markSentByBot(messageId)
    try {
      const sent = await transport.sendToSelf(body, { messageId })
      store.markSentByBot(sent?.id)
      if (queueOnFailure && store.ownerOutbox.length > 0) track(flushOwnerOutbox()) // sending works again
      return { sent: true, id: sent?.id }
    } catch (error) {
      logger.error(`[assistant] self-chat notice failed: ${error.message}`)
      store.audit('owner_notice_failed', { error: error.message, queued: queueOnFailure })
      if (queueOnFailure) {
        const dropped = store.queueOwnerNotice(body)
        if (dropped) store.audit('owner_notice_dropped', { text: excerpt(dropped.text, 300) })
      }
      return { sent: false, queued: queueOnFailure, error: error.message }
    }
  }

  /** Re-sends queued notices oldest first, marked as delayed; stops at the first failure (still offline). */
  async function flushOwnerOutbox () {
    if (flushingOutbox || stopped) return
    flushingOutbox = true
    try {
      for (const notice of [...store.ownerOutbox]) {
        const original = notice.text.startsWith(BOT_PREFIX) ? notice.text.slice(BOT_PREFIX.length).trimStart() : notice.text
        const outcome = await sendToOwner(`${BOT_PREFIX} ⏳ Delayed notice from ${formatClock(notice.queuedAt, config.timezone)}:\n${original}`, { queueOnFailure: false })
        if (!outcome.sent) return
        store.removeOwnerNotice(notice.id)
      }
    } finally {
      flushingOutbox = false
    }
  }

  /**
   * The only path to a customer. Shadow mode stops here. `closingReply`: the owner's /ok or /edit of a thanks draft.
   * If its text is itself only a thanks-back, its message id marks the chat closed for the thanks after it (policy.js).
   * Anything else, and anything more ("Sama-sama kak! Mau sekalian pesan untuk Sabtu?"), is our side's newest word,
   * recorded as `lastSentAt` (in shadow too, as live would send it): an "iya makasih" after it may answer it.
   */
  async function sendToCustomer (chatId, text, { quotedRaw, source, draftId, closingReply = false } = {}) {
    if (!chatId || !text?.trim()) return { sent: false, error: 'nothing to send' }
    if (isBlocked(chatId)) {
      store.audit('send_refused_blocked', { chatId, source })
      return { sent: false, error: 'chat is blocklisted' }
    }
    const closing = closingReply && isThanks(text)
    if (!closing) store.updateChat(chatId, { lastSentAt: now() }) // before sending: one that fails only costs a draft
    if (config.mode !== 'live') {
      store.audit('shadow_send_suppressed', { chatId, source, draftId, text })
      return { sent: false, shadow: true }
    }
    // Marked before sending: the echo can arrive before send() resolves, and a send that throws may still have been
    // delivered. The transport sends under this id (Baileys: the key.id of the message, of its echo and of the result
    // the history keeps); the returned id is marked too, for a transport that picks its own.
    const messageId = transport.generateId?.()
    if (messageId) store.markSentByBot(messageId)
    if (messageId && closing) store.markClosingReply(messageId)
    try {
      const sent = await transport.send(chatId, text, { quotedRaw, messageId })
      store.markSentByBot(sent?.id)
      if (closing) store.markClosingReply(sent?.id)
      store.audit('sent_to_customer', { chatId, source, draftId, id: sent?.id, text })
      return { sent: true, id: sent?.id }
    } catch (error) {
      store.audit('send_failed', { chatId, source, draftId, error: error.message })
      return { sent: false, error: error.message }
    }
  }

  const gate = { sendToCustomer, sendToOwner }
  const owner = createOwnerCommands({ config, store, gate, now })

  // --- inbound ---------------------------------------------------------------------------------------------------

  // Also while stopping: WhatsApp has already sent the delivery receipt and will not deliver a message again, so an
  // accepted message goes to the inbox (triaged on the next start) instead of being dropped.
  async function handleMessage (message) {
    if (!message?.id || !message.chatId) return
    if (store.isSentByBot(message.id)) return // loop guard: our own sends echo back as fromMe
    if (stopped && message.isSelfChat) {
      if (message.fromMe && message.text.trim().startsWith('/')) store.audit('owner_command_during_shutdown', { id: message.id, text: excerpt(message.text, 120) })
      return
    }
    if (store.hasProcessed(message.id)) return
    store.markProcessed(message.id)
    sweepExpiredDrafts()

    // Age decides, not the upsert type: placeholder resends and retries of old messages arrive as 'notify'.
    const ageMs = now() - message.timestamp * 1000
    const isBacklog = message.kind === 'append' || ageMs > (config.backlog.liveWindowMinutes ?? DEFAULT_LIVE_WINDOW_MINUTES) * MINUTE_MS
    if (message.isSelfChat) return handleSelfChat(message, isBacklog)
    if (isBlocked(message.chatId, message.chatIdAlt)) {
      store.audit('skip_blocked', { chatId: message.chatId })
      return
    }
    if (message.fromMe) return startTakeover(message)

    // Only a contact's own message carries its alt JID; on the owner's messages the alt can be the owner's own number.
    if (message.chatIdAlt && store.existingChat(message.chatId)?.chatIdAlt !== message.chatIdAlt) store.updateChat(message.chatId, { chatIdAlt: message.chatIdAlt })
    if (message.senderName) store.updateChat(message.chatId, { name: message.senderName })
    if (message.timestamp < store.historyFloorTs) {
      store.audit('skip_before_history_floor', { chatId: message.chatId, id: message.id })
      return
    }
    // Backlog can deliver the owner's answer before the question it answers.
    if (message.timestamp * 1000 <= ownerRepliedAt(message.chatId, message.chatIdAlt)) {
      store.audit('skip_answered_by_owner', { chatId: message.chatId, id: message.id })
      return
    }
    if (ageMs > config.backlog.maxAgeMinutes * MINUTE_MS) {
      store.audit('skip_backlog_too_old', { chatId: message.chatId, id: message.id, kind: message.kind, ageMinutes: Math.round(ageMs / MINUTE_MS) })
      return
    }
    const accepted = { ...message, isBacklog }
    store.addToInbox(accepted)
    if (!stopped) enqueue(accepted)
  }

  /**
   * Content from a customer that is never triaged (a photo without a caption, a location pin, a contact card, a message
   * that could not be decrypted yet) reaches the owner only on the phone. Its time is kept on the chat record, so a
   * thanks after it is never skipped, even on the other addressing form or after a restart (policy.js).
   */
  function noteUntriaged ({ chatId, chatIdAlt, timestamp } = {}) {
    if (!chatId || !(timestamp > 0)) return
    const at = timestamp * 1000
    const chat = store.chat(chatId)
    store.updateChat(chatId, {
      lastUntriagedAt: Math.max(chat.lastUntriagedAt ?? 0, at),
      ...(chatIdAlt && { chatIdAlt }) // the contact's own message, like handleMessage's
    })
  }

  async function handleSelfChat (message, isBacklog) {
    // Only the owner's own typing counts; the bot's notices are already dropped by the loop guard.
    if (!message.fromMe || !message.text.trim().startsWith('/')) return
    if (message.timestamp < store.historyFloorTs) return // typed before the bot was ever linked
    // A customer's "/edit 7 <bank details>" forwarded here as a note is not the owner typing a command.
    if (message.isForwarded) {
      store.audit('owner_command_forwarded_ignored', { id: message.id, text: excerpt(message.text, 120) })
      await sendToOwner(`${BOT_PREFIX} Ignored a forwarded message that starts with "/": only commands you type here yourself count.`)
      return
    }
    // A late command carries its own time so it cannot approve a newer draft or undo a newer /pause. Live commands
    // go without it: the local clock may be skewed against WhatsApp's by more than the replay slack.
    const reply = await owner.handle(message.text, { timestampMs: isBacklog ? message.timestamp * 1000 : undefined })
    if (reply) await sendToOwner(reply)
  }

  /**
   * An owner reply answers everything the customer wrote before it, however old the reply is (backlog after the bot
   * was down); only the takeover window, which silences the bot for newer messages too, depends on its age.
   */
  async function startTakeover (message) {
    const repliedAt = message.timestamp * 1000
    const until = repliedAt + config.humanTakeoverMinutes * MINUTE_MS
    const active = until > now()
    const chatIds = store.linkedChatIds(message.chatId, message.chatIdAlt)
    const cancelled = []
    for (const chatId of chatIds) {
      const chat = store.chat(chatId)
      store.updateChat(chatId, {
        ownerRepliedAt: Math.max(chat.ownerRepliedAt ?? 0, repliedAt),
        ...(active && { takeoverUntil: Math.max(chat.takeoverUntil ?? 0, until) })
      })
      dropAnswered(chatId, active ? Infinity : repliedAt)
      cancelled.push(...store.cancelChatDrafts(chatId, 'owner_replied', active ? {} : { answeredAt: repliedAt }))
    }
    store.audit('human_takeover', { chatId: message.chatId, chatIds, repliedAt, until: active ? until : null, cancelledDrafts: cancelled.map(draft => draft.id) })
    if (cancelled.length === 0) return
    const drafts = `draft ${cancelled.map(draft => `#${draft.id}`).join(', ')}`
    await sendToOwner(active
      ? `${BOT_PREFIX} You replied to ${contactLabel(message.chatId)} yourself: cancelled ${drafts}. The bot stays out of that chat for ${config.humanTakeoverMinutes} min.`
      : `${BOT_PREFIX} You had already replied to ${contactLabel(message.chatId)} at ${formatClock(repliedAt, config.timezone)}: cancelled ${drafts}.`)
  }

  /** Drops queued messages sent up to `answeredAt` and discards an in-flight triage; newer ones are re-triaged. */
  function dropAnswered (chatId, answeredAt) {
    const state = runtime(chatId)
    const answered = state.pending.filter(pending => pending.timestamp * 1000 <= answeredAt)
    if (answered.length === 0) return
    state.generation++
    store.removeFromInbox(answered.map(pending => pending.id))
    state.pending = state.pending.filter(pending => !answered.includes(pending))
    clearTimeout(state.timer)
    state.timer = null
    if (state.pending.length > 0) scheduleTriage(chatId)
  }

  function enqueue (message) {
    const state = runtime(message.chatId)
    state.pending.push(message)
    state.generation++ // a triage already in flight for this chat is now stale
    scheduleTriage(message.chatId)
  }

  function scheduleTriage (chatId) {
    if (stopped) return // still in the inbox: recoverInbox triages it on the next start
    const state = runtime(chatId)
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      track(triageChat(chatId))
    }, config.debounceMs)
  }

  async function triageChat (chatId) {
    const state = runtime(chatId)
    if (stopped || state.pending.length === 0) return
    if (takeoverUntil(chatId) > now()) {
      store.audit('skip_during_takeover', { chatId, ids: state.pending.map(message => message.id) })
      store.removeFromInbox(state.pending.map(message => message.id))
      state.pending = []
      return
    }
    const generation = state.generation
    const batch = state.pending.slice()
    const batchIds = new Set(batch.map(message => message.id))
    const history = (transport.getHistory?.(chatId, config.contextMessages + batch.length) ?? [])
      .filter(item => (item.text || item.attachment) && !batchIds.has(item.id))
      .slice(-config.contextMessages)

    let result
    try {
      result = await brain.triage({ chat: { name: contactName(chatId) }, history, messages: batch })
    } catch (error) {
      result = { ok: false, error: `brain_threw: ${error.message}`, meta: {} }
    }
    noteClaudeVersion(result.meta?.claudeCodeVersion)
    if (stopped) return
    if (generation !== state.generation) {
      store.audit('triage_discarded_stale', { chatId, ids: [...batchIds] })
      return
    }
    state.pending = state.pending.filter(message => !batchIds.has(message.id))
    if (result.rateLimit) store.setLastRateLimit(result.rateLimit)
    try {
      await route(chatId, batch, history, result, generation)
    } catch (error) {
      // A bug in the checks must not drop the customer's message with the inbox entry: it becomes a draft.
      logger.error(`[assistant] routing failed: ${error.stack ?? error.message}`)
      store.audit('route_failed', { chatId, ids: [...batchIds], error: error.message })
      await postDraft(chatId, batch, result, { action: 'escalate', reasons: ['route_failed'] }, false)
    } finally {
      store.removeFromInbox([...batchIds])
    }
  }

  // The CLI auto-updates almost daily through the shared binary, and an update can change what the init assertions
  // see; the owner is told once per change so selftest/eval get re-run (docs/implementation-notes.md).
  function noteClaudeVersion (version) {
    const previous = store.claudeCodeVersion
    if (!version || version === previous) return
    store.setClaudeCodeVersion(version)
    if (!previous) return
    store.audit('claude_version_changed', { from: previous, to: version })
    track(sendToOwner(`${BOT_PREFIX} ℹ️ The claude CLI updated itself from ${previous} to ${version}. Run \`npm run selftest\` (and \`npm run eval\`) to re-check isolation and triage.`))
  }

  /**
   * Messages accepted before a restart or crash but never routed (dedupe state is already on disk, so WhatsApp will
   * not deliver them again): triage them again as backlog (drafts only), or list them for the owner if too old.
   */
  function recoverInbox () {
    const unfinished = store.inboxMessages()
    if (unfinished.length === 0) return
    const maxAgeMs = config.backlog.maxAgeMinutes * MINUTE_MS
    const blocked = unfinished.filter(message => isBlocked(message.chatId, message.chatIdAlt)) // blocklist changed
    const answered = unfinished.filter(message => !blocked.includes(message) && message.timestamp * 1000 <= ownerRepliedAt(message.chatId, message.chatIdAlt))
    const done = [...blocked, ...answered]
    const tooOld = unfinished.filter(message => !done.includes(message) && now() - message.timestamp * 1000 > maxAgeMs)
    const retry = unfinished.filter(message => !done.includes(message) && !tooOld.includes(message))
    store.removeFromInbox([...done, ...tooOld].map(message => message.id))
    for (const message of retry) enqueue({ ...message, isBacklog: true })
    const ids = list => list.map(message => message.id)
    store.audit('inbox_recovered', { retried: ids(retry), tooOld: ids(tooOld), blocked: ids(blocked), answeredByOwner: ids(answered) })
    if (tooOld.length === 0) return
    const lines = tooOld.map(message => `• ${contactLabel(message.chatId)}: "${excerpt(describe([message]), 120)}"`)
    track(sendToOwner(`${BOT_PREFIX} ⚠️ ${tooOld.length} message(s) arrived before the assistant stopped and were never triaged. Please answer them yourself:\n${lines.join('\n')}`))
  }

  async function route (chatId, batch, history, result, generation) {
    const triage = result.triage
    const incomingText = batch.map(message => message.text).join('\n')
    const attachments = [...new Set(batch.map(message => message.attachment).filter(Boolean))]
    // A thanks without a file: however the owner resolves its draft, that closes the chat for the session (owner.js).
    const closing = attachments.length === 0 && isThanks(incomingText)
    const guard = guardTriage(triage, { knowledge, config, incomingText })
    const decision = decide(result, {
      config,
      guard,
      incomingText,
      attachments,
      quoted: batch.filter(message => message.quotedId || message.quotedText !== undefined)
        .map(message => ({ id: message.quotedId, text: message.quotedText ?? '' })),
      history: history.map(item => (item.fromMe ? { ...item, closing: store.isClosingReply(item.id) } : item)),
      paused: store.paused,
      chat: {
        muted: linkedChats(chatId).some(record => record.muted),
        blocked: isBlocked(chatId),
        blocklistUnchecked: blocklistUnchecked(chatId),
        takeoverUntil: takeoverUntil(chatId),
        lastClosingAt: lastClosingAt(chatId),
        lastOursAt: lastOursAt(chatId),
        lastUntriagedAt: lastUntriagedAt(chatId)
      },
      now: now(),
      chatAutoSendsLastHour: chatAutoSendsLastHour(chatId),
      autoSendsLastDay: store.countAutoSends(DAY_MS),
      rateLimit: result.rateLimit,
      isBacklog: batch.some(message => message.isBacklog)
    })
    store.audit('decision', {
      chatId,
      ids: batch.map(message => message.id),
      text: excerpt(describe(batch), 300),
      ok: result.ok,
      error: result.error,
      decision: triage?.decision,
      factsUsed: triage?.facts_used,
      reply: triage?.reply,
      guard,
      action: decision.action,
      reasons: decision.reasons,
      mode: config.mode,
      rateLimit: result.rateLimit,
      meta: result.meta
    })

    if (decision.action === 'auto_send') return autoSend(chatId, batch, triage, decision, generation, closing)
    if (decision.action === 'skip') return // a thanks that adds nothing: no reply, no draft, no blue ticks
    return postDraft(chatId, batch, result, decision, closing)
  }

  async function autoSend (chatId, batch, triage, decision, generation, closing) {
    const state = runtime(chatId)
    if (generation !== state.generation) return // the owner started typing or new messages arrived meanwhile
    const live = config.mode === 'live'
    const disclosureKey = live ? 'lastDisclosureAt' : 'shadowDisclosureAt'
    const chat = store.chat(chatId)
    const needsDisclosure = config.disclosure?.enabled && now() - (chat[disclosureKey] ?? 0) > config.disclosure.sessionGapHours * HOUR_MS
    const text = needsDisclosure ? `${config.disclosure.text}\n\n${triage.reply}` : triage.reply
    const last = batch[batch.length - 1]

    // Counted before the first await, so another chat's triage finishing during this send sees the slot as taken.
    // Counted in shadow too, so shadow mode shows what the rate limits would do.
    const slot = store.recordAutoSend(chatId)
    const outcome = await sendToCustomer(chatId, text, { quotedRaw: last.raw, source: 'auto_send' })
    if (!outcome.sent && !outcome.shadow) {
      store.releaseAutoSend(chatId, slot)
      const reasons = [...decision.reasons.filter(reason => reason !== 'all_gates_passed'), `send_failed:${outcome.error}`]
      return postDraft(chatId, batch, { ok: true, triage }, { action: 'escalate', reasons }, closing)
    }
    if (needsDisclosure) store.updateChat(chatId, { [disclosureKey]: now() })
    if (outcome.sent) await markReadUnlessOpen(chatId, batch)
    const name = contactLabel(chatId)
    if (outcome.shadow) {
      await sendToOwner(`${BOT_PREFIX} [SHADOW] Would auto-reply to ${name}\nThey wrote: "${excerpt(describe(batch))}"\nReply:\n${text}`)
    } else if (config.notifyOwnerOnAutoSend) {
      await sendToOwner(`${BOT_PREFIX} ✅ Auto-replied to ${name}\nThey wrote: "${excerpt(describe(batch))}"\nReply:\n${triage.reply}`)
    }
  }

  /** Blue ticks say "seen": never while a draft of this chat is still waiting for the owner. */
  async function markReadUnlessOpen (chatId, batch) {
    const open = openDrafts(chatId)
    if (open.length > 0) {
      store.audit('mark_read_skipped', { chatId, ids: batch.map(message => message.id), openDrafts: open.map(draft => draft.id) })
      return
    }
    try { await transport.markRead?.(batch) } catch (error) { logger.warn(`[assistant] markRead failed: ${error.message}`) }
  }

  /** Every escalation, whether Claude chose it or a gate stopped its answer, is a draft for /ok, /edit or /no. */
  async function postDraft (chatId, batch, result, decision, closing) {
    const triage = result.triage
    const draft = store.createDraft({
      chatId,
      contactName: contactLabel(chatId),
      excerpt: excerpt(describe(batch)),
      draft: triage?.reply?.trim() ?? '',
      reason: triage?.reason ?? `Triage failed (${result.error}); nothing was sent.`,
      summary: triage?.summary,
      policyReasons: decision.reasons,
      messageIds: batch.map(message => message.id),
      lastMessageAt: lastMessageAt(batch), // an owner reply after it answers it; a resolved closing is dated by it
      closing,
      privateDetails: findPrivateDetails(triage?.reply ?? '', privateIdentifiersFor(config))
    })
    const notice = await sendToOwner(formatDraftNotice(draft))
    if (!notice.sent) logger.error(`[assistant] draft #${draft.id} could not be posted to self-chat yet; queued for when WhatsApp is back`)
  }

  function sweepExpiredDrafts () {
    const expired = store.expireDrafts((config.draftTtlHours ?? 24) * HOUR_MS)
    if (expired.length > 0) store.audit('drafts_expired', { ids: expired.map(draft => draft.id) })
  }
  const sweeper = setInterval(() => {
    sweepExpiredDrafts()
    if (store.ownerOutbox.length > 0) track(flushOwnerOutbox())
  }, EXPIRY_SWEEP_MS)
  sweeper.unref?.()

  return {
    handleMessage,
    noteUntriaged,
    flushOwnerOutbox,
    recoverInbox,
    gate,
    owner,
    /** Resolves when no debounce timer is pending and no triage/send is running (for tests and shutdown). */
    async idle () {
      for (;;) {
        const waiting = [...chats.values()].some(state => state.timer)
        if (!waiting && work.size === 0) return
        if (work.size > 0) await Promise.allSettled([...work])
        else await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
    async stop () {
      stopped = true
      clearInterval(sweeper)
      for (const state of chats.values()) { clearTimeout(state.timer); state.timer = null }
      await Promise.allSettled([...work])
    },
    announce: text => sendToOwner(text)
  }
}
