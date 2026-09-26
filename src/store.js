// Persistent state in data/state.json (atomic temp+rename) and an append-only audit log in data/audit.jsonl.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import path from 'node:path'

const MAX_SENT_BY_BOT = 2000
const MAX_PROCESSED = 5000
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
  processed: [],
  autoSendLog: [],
  historyFloorTs: 0,
  pauseChangedAt: 0,
  ownerOutbox: [],
  ownerNoticeCounter: 0,
  inbox: {},
  lastRateLimit: null
})

export function writeFileAtomic (file, contents) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

export class Store {
  constructor (dataDir, { now = () => Date.now(), logger = console, limits = {} } = {}) {
    this.dataDir = dataDir
    this.limits = { sentByBot: MAX_SENT_BY_BOT, processed: MAX_PROCESSED, ...limits }
    this.file = path.join(dataDir, 'state.json')
    this.auditFile = path.join(dataDir, 'audit.jsonl')
    this.now = now
    this.logger = logger
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.state = this.#load()
    this.sentByBotSet = new Set(this.state.sentByBot)
    this.processedSet = new Set(this.state.processed)
  }

  #load () {
    if (!existsSync(this.file)) return emptyState()
    try {
      const { lastProcessedTs, ...saved } = JSON.parse(readFileSync(this.file, 'utf8'))
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

  updateChat (chatId, patch) {
    Object.assign(this.chat(chatId), patch)
    this.save()
    return this.chat(chatId)
  }

  /** Chats whose saved name matches (case-insensitive, substring). */
  findChatsByName (query) {
    const needle = query.trim().toLowerCase()
    const all = Object.entries(this.state.chats).filter(([, chat]) => chat.name)
    const exact = all.filter(([, chat]) => chat.name.toLowerCase() === needle)
    return (exact.length > 0 ? exact : all.filter(([, chat]) => chat.name.toLowerCase().includes(needle))).map(([chatId]) => chatId)
  }

  recordAutoSend (chatId) {
    const at = this.now()
    const chat = this.chat(chatId)
    chat.autoSendTimes = [...chat.autoSendTimes.filter(ts => at - ts < DAY_MS), at]
    this.state.autoSendLog = [...this.state.autoSendLog.filter(ts => at - ts < DAY_MS), at].slice(-MAX_AUTO_SEND_LOG)
    this.save()
  }

  countChatAutoSends (chatId, windowMs) {
    const at = this.now()
    return this.chat(chatId).autoSendTimes.filter(ts => at - ts < windowMs).length
  }

  countAutoSends (windowMs) {
    const at = this.now()
    return this.state.autoSendLog.filter(ts => at - ts < windowMs).length
  }

  // --- inbound messages accepted but not routed yet --------------------------

  /** Kept until triage has decided, so a restart or crash between accepting and routing cannot lose it silently. */
  addToInbox ({ id, chatId, chatIdAlt, senderName, text, timestamp, kind, isBacklog }) {
    this.state.inbox[id] = { id, chatId, chatIdAlt, senderName, text, timestamp, kind, isBacklog, acceptedAt: this.now() }
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

  cancelChatDrafts (chatId, reason) {
    const cancelled = this.pendingDrafts().filter(draft => draft.chatId === chatId)
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
