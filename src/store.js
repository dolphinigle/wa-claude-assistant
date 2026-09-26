// Persistent state in data/state.json (atomic temp+rename) and an append-only audit log in data/audit.jsonl.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

const MAX_SENT_BY_BOT = 2000
const MAX_PROCESSED = 5000
const MAX_CLOSING_REPLIES = 2000
const MAX_AUTO_SEND_LOG = 500
const MAX_OWNER_OUTBOX = 50
const DAY_MS = 24 * 60 * 60 * 1000

const emptyState = () => ({
  version: 1,
  paused: false,
  draftCounter: 0,
  drafts: {},
  chats: {},
  sentByBot: [],
  closingReplies: [],
  processed: [],
  autoSendLog: [],
  historyFloorTs: 0,
  pauseChangedAt: 0,
  ownerOutbox: [],
  ownerNoticeCounter: 0,
  inbox: {},
  claudeCodeVersion: null,
  lastRateLimit: null
})

/** Temp file + fsync + rename: `file` holds either the old or the new contents, never a partial write. */
export function writeFileAtomic (file, contents) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    try {
      writeSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export class Store {
  constructor (dataDir, { now = () => Date.now(), logger = console, limits = {} } = {}) {
    this.dataDir = dataDir
    this.limits = { sentByBot: MAX_SENT_BY_BOT, processed: MAX_PROCESSED, closingReplies: MAX_CLOSING_REPLIES, ...limits }
    this.file = path.join(dataDir, 'state.json')
    this.auditFile = path.join(dataDir, 'audit.jsonl')
    this.now = now
    this.logger = logger
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.state = this.#load()
    this.sentByBotSet = new Set(this.state.sentByBot)
    this.closingReplySet = new Set(this.state.closingReplies)
    this.processedSet = new Set(this.state.processed)
  }

  #load () {
    if (!existsSync(this.file)) return emptyState()
    try {
      // autoReplies: the bot's own replies, kept while it could auto-send a closing (until 2026-09-26); nothing reads them.
      const { lastProcessedTs, autoReplies, ...saved } = JSON.parse(readFileSync(this.file, 'utf8'))
      // Before the floor existed, a watermark moved with live traffic; it is still a valid (later) floor.
      return { ...emptyState(), historyFloorTs: lastProcessedTs ?? 0, ...saved }
    } catch (error) {
      // Keep the unreadable file for inspection and start fresh; historyFloorTs=0 makes the transport re-seed it.
      const aside = `${this.file}.corrupt-${this.now()}`
      renameSync(this.file, aside)
      this.logger.error?.(`[store] ${this.file} unreadable (${error.message}); moved to ${aside}`)
      return emptyState()
    }
  }

  save () {
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 1))
  }

  audit (event, data = {}) {
    appendFileSync(this.auditFile, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...data })}\n`, { mode: 0o600 })
  }

  // --- ids -----------------------------------------------------------------

  #remember (list, set, id, max) {
    if (!id || set.has(id)) return
    set.add(id)
    list.push(id)
    while (list.length > max) set.delete(list.shift())
  }

  isSentByBot (id) { return this.sentByBotSet.has(id) }
  markSentByBot (id) { this.#remember(this.state.sentByBot, this.sentByBotSet, id, this.limits.sentByBot); this.save() }

  /**
   * Our messages sent by the owner's /ok or /edit of a thanks draft whose text is itself only a thanks-back: a thanks
   * after one, with nothing else in between, is skipped. Message ids are unique across chats, so this holds on both
   * addressing forms (PN and LID) of a contact.
   */
  isClosingReply (id) { return this.closingReplySet.has(id) }
  markClosingReply (id) { this.#remember(this.state.closingReplies, this.closingReplySet, id, this.limits.closingReplies); this.save() }

  hasProcessed (id) { return this.processedSet.has(id) }
  markProcessed (id) { this.#remember(this.state.processed, this.processedSet, id, this.limits.processed); this.save() }

  /**
   * Epoch seconds of the very first connection: anything older is history and never handled. Set once and never
   * moved by traffic, so a live message cannot hide older backlog; duplicates are the processed-id set's job.
   */
  get historyFloorTs () { return this.state.historyFloorTs }
  seedHistoryFloor (ts) {
    if (!this.state.historyFloorTs) { this.state.historyFloorTs = ts; this.save() }
  }

  // --- flags ---------------------------------------------------------------

  get paused () { return this.state.paused }
  /** `at` (epoch ms) is when the owner typed the command, so a replayed older /pause or /resume can be refused. */
  get pauseChangedAt () { return this.state.pauseChangedAt }
  setPaused (paused, at = this.now()) { Object.assign(this.state, { paused, pauseChangedAt: at }); this.save() }

  get claudeCodeVersion () { return this.state.claudeCodeVersion }
  setClaudeCodeVersion (version) { this.state.claudeCodeVersion = version; this.save() }

  get lastRateLimit () { return this.state.lastRateLimit }
  setLastRateLimit (rateLimit) {
    if (!rateLimit) return
    this.state.lastRateLimit = { ...rateLimit, seenAt: this.now() }
    this.save()
  }

  // --- chats ---------------------------------------------------------------

  chat (chatId) {
    this.state.chats[chatId] ??= { name: null, muted: false, takeoverUntil: 0, autoSendTimes: [], lastDisclosureAt: 0, shadowDisclosureAt: 0 }
    return this.state.chats[chatId]
  }

  /** Like chat(), but never creates a record. */
  existingChat (chatId) { return this.state.chats[chatId] }

  updateChat (chatId, patch) {
    Object.assign(this.chat(chatId), patch)
    this.save()
    return this.chat(chatId)
  }

  /**
   * One person can reach the assistant under both addressing forms (PN and LID), as two chat records linked only
   * by the alt JID each has seen: returns the given ids, their saved alts, and every record whose alt is one of them.
   */
  linkedChatIds (chatId, chatIdAlt) {
    const ids = new Set([chatId, chatIdAlt].filter(Boolean))
    for (const id of [...ids]) {
      const alt = this.existingChat(id)?.chatIdAlt
      if (alt) ids.add(alt)
    }
    for (const [id, chat] of Object.entries(this.state.chats)) {
      if (chat.chatIdAlt && ids.has(chat.chatIdAlt)) ids.add(id)
    }
    return [...ids]
  }

  /** Saves the other addressing form of a known chat that has none yet (from WhatsApp's LID↔PN mapping). */
  linkAlt (chatId, chatIdAlt) {
    const chat = this.existingChat(chatId)
    if (!chat || chat.chatIdAlt || !chatIdAlt || chatIdAlt === chatId) return
    chat.chatIdAlt = chatIdAlt
    this.save()
  }

  /** Chats whose saved name contains the query (case-insensitive); an exact name gets no preference. */
  findChatsByName (query) {
    const needle = query.trim().toLowerCase()
    return Object.entries(this.state.chats).filter(([, chat]) => chat.name?.toLowerCase().includes(needle)).map(([chatId]) => chatId)
  }

  /** Returns the recorded time, which releaseAutoSend() takes to give the slot back when the send fails. */
  recordAutoSend (chatId) {
    const at = this.now()
    const chat = this.chat(chatId)
    chat.autoSendTimes = [...chat.autoSendTimes.filter(ts => at - ts < DAY_MS), at]
    this.state.autoSendLog = [...this.state.autoSendLog.filter(ts => at - ts < DAY_MS), at].slice(-MAX_AUTO_SEND_LOG)
    this.save()
    return at
  }

  releaseAutoSend (chatId, at) {
    const withoutOne = list => { const index = list.lastIndexOf(at); return index === -1 ? list : list.toSpliced(index, 1) }
    const chat = this.chat(chatId)
    chat.autoSendTimes = withoutOne(chat.autoSendTimes)
    this.state.autoSendLog = withoutOne(this.state.autoSendLog)
    this.save()
  }

  countChatAutoSends (chatId, windowMs) {
    const at = this.now()
    return (this.existingChat(chatId)?.autoSendTimes ?? []).filter(ts => at - ts < windowMs).length
  }

  countAutoSends (windowMs) {
    const at = this.now()
    return this.state.autoSendLog.filter(ts => at - ts < windowMs).length
  }

  // --- inbound messages accepted but not routed yet --------------------------

  /** Kept until triage has decided, so a restart or crash between accepting and routing cannot lose it silently. */
  addToInbox ({ id, chatId, chatIdAlt, senderName, text, attachment, quotedText, quotedId, timestamp, kind, isBacklog }) {
    this.state.inbox[id] = { id, chatId, chatIdAlt, senderName, text, attachment, quotedText, quotedId, timestamp, kind, isBacklog, acceptedAt: this.now() }
    this.save()
  }

  removeFromInbox (ids) {
    const present = ids.filter(id => id in this.state.inbox)
    for (const id of present) delete this.state.inbox[id]
    if (present.length > 0) this.save()
  }

  inboxMessages () { return Object.values(this.state.inbox).sort((a, b) => a.timestamp - b.timestamp) }

  // --- owner notices that could not be delivered ---------------------------

  get ownerOutbox () { return this.state.ownerOutbox }

  /** Keeps a notice that failed to send (socket reconnecting) until it can be re-sent; returns a dropped one. */
  queueOwnerNotice (text) {
    this.state.ownerOutbox.push({ id: ++this.state.ownerNoticeCounter, text, queuedAt: this.now() })
    const dropped = this.state.ownerOutbox.length > MAX_OWNER_OUTBOX ? this.state.ownerOutbox.shift() : undefined
    this.save()
    return dropped
  }

  removeOwnerNotice (id) {
    this.state.ownerOutbox = this.state.ownerOutbox.filter(notice => notice.id !== id)
    this.save()
  }

  // --- drafts --------------------------------------------------------------

  createDraft (draft) {
    const id = ++this.state.draftCounter
    this.state.drafts[id] = { id, status: 'pending', createdAt: this.now(), ...draft }
    this.save()
    return this.state.drafts[id]
  }

  getDraft (id) { return this.state.drafts[id] }

  pendingDrafts () { return Object.values(this.state.drafts).filter(draft => draft.status === 'pending') }

  resolveDraft (id, status, extra = {}) {
    const draft = this.state.drafts[id]
    if (!draft) return undefined
    Object.assign(draft, { status, resolvedAt: this.now(), ...extra })
    this.save()
    return draft
  }

  /** With `answeredAt` (epoch ms), only drafts whose newest message is not newer than it. */
  cancelChatDrafts (chatId, reason, { answeredAt } = {}) {
    // Drafts saved before lastMessageAt existed were created after all of their messages.
    const answered = draft => answeredAt === undefined || (draft.lastMessageAt ?? draft.createdAt) <= answeredAt
    const cancelled = this.pendingDrafts().filter(draft => draft.chatId === chatId && answered(draft))
    for (const draft of cancelled) Object.assign(draft, { status: 'cancelled', resolvedAt: this.now(), cancelReason: reason })
    if (cancelled.length > 0) this.save()
    return cancelled
  }

  /** Marks drafts older than `ttlMs` expired and forgets resolved drafts older than a week. */
  expireDrafts (ttlMs) {
    const at = this.now()
    const expired = this.pendingDrafts().filter(draft => at - draft.createdAt >= ttlMs)
    for (const draft of expired) Object.assign(draft, { status: 'expired', resolvedAt: at })
    let forgotten = 0
    for (const [id, draft] of Object.entries(this.state.drafts)) {
      if (draft.status !== 'pending' && at - (draft.resolvedAt ?? draft.createdAt) > 7 * DAY_MS) { delete this.state.drafts[id]; forgotten++ }
    }
    if (expired.length > 0 || forgotten > 0) this.save()
    return expired
  }
}
