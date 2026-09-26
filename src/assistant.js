// Orchestrator: dedupe, loop guard, takeover, debounce, triage, policy, and the ONE send gate.
import { guardTriage } from './guards.js'
import { BOT_PREFIX, createOwnerCommands, excerpt, formatClock, formatDraftNotice } from './owner.js'
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
  const contactName = chatId => store.chat(chatId).name ?? chatId.split('@')[0]

  // Entries are JIDs or phone numbers (08…, 62…, +62…); pushNames are not accepted because senders choose them.
  function isBlocked (chatId, chatIdAlt) {
    const ids = [chatId, chatIdAlt].filter(Boolean)
    const users = ids.map(id => id.split('@')[0].split(':')[0])
    return (config.blocklist ?? []).some(entry => {
      const value = String(entry).trim()
      if (ids.includes(value)) return true
      const digits = value.replace(/\D/g, '').replace(/^0/, '62')
      return digits.length >= 6 && !value.includes('@') && users.includes(digits)
    })
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

  /** The only path to a customer. Shadow mode stops here. */
  async function sendToCustomer (chatId, text, { quotedRaw, source, draftId } = {}) {
    if (!chatId || !text?.trim()) return { sent: false, error: 'nothing to send' }
    if (isBlocked(chatId)) {
      store.audit('send_refused_blocked', { chatId, source })
      return { sent: false, error: 'chat is blocklisted' }
    }
    if (config.mode !== 'live') {
      store.audit('shadow_send_suppressed', { chatId, source, draftId, text })
      return { sent: false, shadow: true }
    }
    const messageId = transport.generateId?.()
    if (messageId) store.markSentByBot(messageId) // before sending: the echo can arrive before send() resolves
    try {
      const sent = await transport.send(chatId, text, { quotedRaw, messageId })
      store.markSentByBot(sent?.id)
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

  async function handleMessage (message) {
    if (stopped || !message?.id || !message.chatId) return
    if (store.isSentByBot(message.id)) return // loop guard: our own sends echo back as fromMe
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

    if (message.senderName) store.updateChat(message.chatId, { name: message.senderName })
    if (message.timestamp < store.historyFloorTs) {
      store.audit('skip_before_history_floor', { chatId: message.chatId, id: message.id })
      return
    }
    if (ageMs > config.backlog.maxAgeMinutes * MINUTE_MS) {
      store.audit('skip_backlog_too_old', { chatId: message.chatId, id: message.id, kind: message.kind, ageMinutes: Math.round(ageMs / MINUTE_MS) })
      return
    }
    enqueue({ ...message, isBacklog })
  }

  async function handleSelfChat (message, isBacklog) {
    // Only the owner's own typing counts; the bot's notices are already dropped by the loop guard.
    if (!message.fromMe || !message.text.trim().startsWith('/')) return
    if (message.timestamp < store.historyFloorTs) return // typed before the bot was ever linked
    // A late command carries its own time so it cannot approve a newer draft or undo a newer /pause. Live commands
    // go without it: the local clock may be skewed against WhatsApp's by more than the replay slack.
    const reply = await owner.handle(message.text, { timestampMs: isBacklog ? message.timestamp * 1000 : undefined })
    if (reply) await sendToOwner(reply)
  }

  async function startTakeover (message) {
    const until = message.timestamp * 1000 + config.humanTakeoverMinutes * MINUTE_MS
    if (until <= now()) return // an old reply of the owner's (backlog), nothing to take over
    const chat = store.chat(message.chatId)
    store.updateChat(message.chatId, { takeoverUntil: Math.max(chat.takeoverUntil ?? 0, until) })
    const state = runtime(message.chatId)
    state.generation++ // discards any in-flight triage for this chat
    state.pending = []
    clearTimeout(state.timer)
    state.timer = null
    const cancelled = store.cancelChatDrafts(message.chatId, 'owner_replied')
    store.audit('human_takeover', { chatId: message.chatId, until, cancelledDrafts: cancelled.map(draft => draft.id) })
    if (cancelled.length > 0) {
      await sendToOwner(`${BOT_PREFIX} You replied to ${contactName(message.chatId)} yourself: cancelled draft ${cancelled.map(draft => `#${draft.id}`).join(', ')}. The bot stays out of that chat for ${config.humanTakeoverMinutes} min.`)
    }
  }

  function enqueue (message) {
    const state = runtime(message.chatId)
    state.pending.push(message)
    state.generation++ // a triage already in flight for this chat is now stale
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      track(triageChat(message.chatId))
    }, config.debounceMs)
  }

  async function triageChat (chatId) {
    const state = runtime(chatId)
    if (stopped || state.pending.length === 0) return
    const chat = store.chat(chatId)
    if (chat.takeoverUntil > now()) {
      store.audit('skip_during_takeover', { chatId, ids: state.pending.map(message => message.id) })
      state.pending = []
      return
    }
    const generation = state.generation
    const batch = state.pending.slice()
    const batchIds = new Set(batch.map(message => message.id))
    const history = (transport.getHistory?.(chatId, config.contextMessages + batch.length) ?? [])
      .filter(item => item.text && !batchIds.has(item.id))
      .slice(-config.contextMessages)

    let result
    try {
      result = await brain.triage({ chat: { name: contactName(chatId) }, history, messages: batch })
    } catch (error) {
      result = { ok: false, error: `brain_threw: ${error.message}`, meta: {} }
    }
    if (stopped) return
    if (generation !== state.generation) {
      store.audit('triage_discarded_stale', { chatId, ids: [...batchIds] })
      return
    }
    state.pending = state.pending.filter(message => !batchIds.has(message.id))
    if (result.rateLimit) store.setLastRateLimit(result.rateLimit)
    await route(chatId, batch, result, generation)
  }

  async function route (chatId, batch, result, generation) {
    const triage = result.triage
    const chat = store.chat(chatId)
    const guard = guardTriage(triage, { knowledge, config, incomingText: batch.map(message => message.text).join('\n') })
    const decision = decide(result, {
      config,
      guard,
      paused: store.paused,
      chat: { muted: chat.muted, blocked: isBlocked(chatId), takeoverUntil: chat.takeoverUntil },
      now: now(),
      chatAutoSendsLastHour: store.countChatAutoSends(chatId, HOUR_MS),
      autoSendsLastDay: store.countAutoSends(DAY_MS),
      rateLimit: result.rateLimit,
      isBacklog: batch.some(message => message.isBacklog)
    })
    store.audit('decision', {
      chatId,
      ids: batch.map(message => message.id),
      text: excerpt(batch.map(message => message.text).join(' / '), 300),
      ok: result.ok,
      error: result.error,
      category: triage?.category,
      confidence: triage?.confidence,
      factsUsed: triage?.facts_used,
      reply: triage?.reply,
      guard,
      action: decision.action,
      reasons: decision.reasons,
      mode: config.mode,
      rateLimit: result.rateLimit,
      meta: result.meta
    })

    if (decision.action === 'ignore') return
    if (decision.action === 'auto_send') return autoSend(chatId, batch, triage, decision, generation)
    return postDraft(chatId, batch, result, decision)
  }

  async function autoSend (chatId, batch, triage, decision, generation) {
    const state = runtime(chatId)
    if (generation !== state.generation) return // the owner started typing or new messages arrived meanwhile
    const live = config.mode === 'live'
    const disclosureKey = live ? 'lastDisclosureAt' : 'shadowDisclosureAt'
    const chat = store.chat(chatId)
    const needsDisclosure = config.disclosure?.enabled && now() - (chat[disclosureKey] ?? 0) > config.disclosure.sessionGapHours * HOUR_MS
    const text = needsDisclosure ? `${config.disclosure.text}\n\n${triage.reply}` : triage.reply
    const last = batch[batch.length - 1]

    const outcome = await sendToCustomer(chatId, text, { quotedRaw: last.raw, source: 'auto_send' })
    if (!outcome.sent && !outcome.shadow) {
      return postDraft(chatId, batch, { ok: true, triage }, { action: 'escalate', reasons: [...decision.reasons, `send_failed:${outcome.error}`] })
    }
    if (needsDisclosure) store.updateChat(chatId, { [disclosureKey]: now() })
    store.recordAutoSend(chatId) // counted in shadow too, so shadow mode shows what the rate limits would do
    if (outcome.sent) {
      try { await transport.markRead?.(batch) } catch (error) { logger.warn(`[assistant] markRead failed: ${error.message}`) }
    }
    const name = contactName(chatId)
    if (outcome.shadow) {
      await sendToOwner(`${BOT_PREFIX} [SHADOW] Would auto-reply to ${name}\nThey wrote: "${excerpt(batch.map(message => message.text).join(' / '))}"\nReply:\n${text}`)
    } else if (config.notifyOwnerOnAutoSend) {
      await sendToOwner(`${BOT_PREFIX} ✅ Auto-replied to ${name}\nThey wrote: "${excerpt(batch.map(message => message.text).join(' / '))}"\nReply:\n${triage.reply}`)
    }
  }

  async function postDraft (chatId, batch, result, decision) {
    const triage = result.triage
    const draft = store.createDraft({
      chatId,
      contactName: contactName(chatId),
      action: decision.action,
      category: triage?.category ?? 'error',
      excerpt: excerpt(batch.map(message => message.text).join(' / ')),
      draft: triage?.reply?.trim() ?? '',
      reason: triage?.reason ?? `Triage failed (${result.error}); nothing was sent.`,
      summary: triage?.summary,
      policyReasons: decision.reasons,
      messageIds: batch.map(message => message.id)
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
    flushOwnerOutbox,
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
