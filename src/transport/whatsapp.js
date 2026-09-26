// Baileys adapter (baileys@7.0.0-rc14). Every Baileys-specific call lives here; see docs/implementation-notes.md.
import { chmodSync, mkdirSync } from 'node:fs'
import makeWASocket, {
  generateMessageIDV2, isJidBroadcast, isJidMetaAI, isJidNewsletter, isLidUser, isPnUser, jidNormalizedUser,
  makeCacheableSignalKeyStore, useMultiFileAuthState
} from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { parseCommand } from '../owner.js'
import { attachmentKind, backoffMs, classifyDisconnect, extractText, getMeIds, isCiphertextStub, isSelfChatJid, normalizeUpsert, toEpochSeconds } from './wa-normalize.js'

const HISTORY_PER_CHAT = 50
const MAX_META_AI_IDS = 500
const OFFLINE_LOG_EVERY = 10

export function createBaileysLogger () {
  return pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' }, pino.destination(2))
}

const isKnownCommand = text => {
  const command = parseCommand(text)
  return Boolean(command) && command.name !== 'unknown'
}

export function renderQr (qr) {
  console.log('\nScan with WhatsApp on your phone: Settings → Linked devices → Link a device')
  qrcode.generate(qr, { small: true })
}

/** The socket with the settings the notes lock in: no online presence, no full history, default browser. */
export async function createBaileysSocket ({ authDir, logger, getMessage }) {
  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  chmodSync(authDir, 0o700)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage,
    shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid) || isJidMetaAI(jid)
  })
  sock.ev.on('creds.update', saveCreds)
  return sock
}

/**
 * @param {object} options
 * @param {(message: object) => Promise<void>} options.onMessage  normalized customer/self-chat messages
 * @param {() => void} [options.onReady]  first successful connection of this process
 * @param {(info: {outageMs: number}) => void} [options.onConnected]  every successful (re)connection, e.g. to re-send
 *   failed notices; `outageMs` is how long WhatsApp was unreachable before it (0 on the first connection)
 * @param {(verdict: object) => void} [options.onFatal]  the transport stopped and will not reconnect
 * @param {Function} [options.createSocket]  injectable for tests; defaults to the real Baileys socket
 */
export function createWhatsAppTransport ({ config, store, onMessage, onReady, onConnected, onFatal, logger = console, createSocket = createBaileysSocket }) {
  const baileysLogger = createBaileysLogger()
  const history = new Map() // chatId → [{id, fromMe, text, timestamp, raw}]
  const metaAiIds = new Set() // ids of the owner's own Meta AI prompts (see connect())
  let sock
  let meIds = []
  let selfChatJid = config.whatsapp?.selfChatJid ?? null
  let connected = false
  let stopped = false
  let announced = false
  let failures = 0 // closes since the last stable connection: sets the backoff
  let flaps = 0 // connections that opened and dropped again before becoming stable: capped by maxReconnectAttempts
  let downSince = null
  let reconnectTimer
  let watchdogTimer

  const remember = raw => {
    const chatId = raw?.key?.remoteJid
    if (!chatId || !raw.key.id) return
    const list = history.get(chatId) ?? []
    const known = list.findIndex(item => item.id === raw.key.id)
    if (known !== -1) {
      // A ciphertext stub is stored first; the decrypted resend with the same id replaces it.
      if (list[known].raw?.message || !raw.message) return
      list.splice(known, 1)
    }
    const { text, contentType } = extractText(raw.message)
    // A message nobody could read yet is content like a file Claude cannot see ('other'): a thanks after it is never
    // skipped as a closing, even if its resend never comes.
    const attachment = isCiphertextStub(raw) ? 'other' : attachmentKind(contentType)
    list.push({ id: raw.key.id, fromMe: Boolean(raw.key.fromMe), text, attachment, timestamp: toEpochSeconds(raw.messageTimestamp), raw })
    list.sort((a, b) => a.timestamp - b.timestamp)
    history.set(chatId, list.slice(-HISTORY_PER_CHAT))
  }
  const findRaw = key => history.get(key.remoteJid)?.find(item => item.id === key.id)?.raw

  // Contacts with a username arrive as LID without a PN alt (#2742), yet the blocklist matches phone numbers; Baileys'
  // mapping store may still know the number. getPNForLID is a local lookup (getLIDForPN can query WhatsApp: unused).
  // A mapping to an own JID is Baileys mislearning from the owner's replies, never the contact's number.
  async function resolvePhoneJid (chatId) {
    if (!isLidUser(chatId)) return undefined
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(chatId)
      const jid = pn ? jidNormalizedUser(pn) : ''
      return isPnUser(jid) && !isSelfChatJid(jid, meIds) ? jid : undefined
    } catch (error) {
      logger.warn(`[whatsapp] LID→PN lookup failed: ${error.message}`)
      return undefined
    }
  }

  const learnMapping = ({ lid, pn } = {}) => {
    const pair = [lid, pn].filter(Boolean).map(jidNormalizedUser)
    const lidJid = pair.find(isLidUser)
    const pnJid = pair.find(isPnUser)
    if (!lidJid || !pnJid || pair.some(jid => isSelfChatJid(jid, meIds))) return
    store.linkAlt(lidJid, pnJid)
    store.linkAlt(pnJid, lidJid)
  }

  const setIdentity = user => {
    const ids = getMeIds(user)
    if (ids.length === 0) return
    meIds = ids
    selfChatJid ??= meIds[0]
  }

  // Baileys #2810: the socket can look open while messages.upsert never fires. No catch-up signal → recreate.
  const armWatchdog = socket => {
    clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => {
      logger.warn('[whatsapp] no receivedPendingNotifications after connect; recreating the socket (#2810 watchdog)')
      socket.end(new Error('caught-up watchdog'))
    }, config.whatsapp?.caughtUpWatchdogMs ?? 180_000)
  }

  // The cap is for open-then-drop loops (#2810 watchdog, a session WhatsApp keeps closing). A socket that never
  // opens is a network outage: retried forever at the capped backoff, because giving up would end the process.
  function scheduleReconnect (verdict, session) {
    failures++
    downSince ??= Date.now()
    if (session?.opened && !session.stable) flaps++
    const maxFlaps = config.whatsapp?.maxReconnectAttempts ?? 10
    if (flaps > maxFlaps) {
      stopped = true
      onFatal?.({ action: 'stop', reason: 'too_many_reconnects', advice: `Gave up after ${maxFlaps} connections in a row opened and dropped again; last: ${verdict.reason}.` })
      return
    }
    const delayMs = verdict.action === 'recreate_now' ? 0 : backoffMs(failures)
    if (!session?.opened && failures % OFFLINE_LOG_EVERY === 0) logger.warn(`[whatsapp] still offline after ${failures} attempts (last: ${verdict.reason}); retrying every ${delayMs / 1000} s`)
    reconnectTimer = setTimeout(connect, delayMs)
  }

  // Catch-up can be signalled before 'open' (Baileys flushes the offline backlog while it still awaits its post-login
  // round trips), so each socket remembers it; otherwise 'open' would arm a watchdog that nothing disarms.
  const handleConnection = (socket, session) => ({ connection, lastDisconnect, qr, receivedPendingNotifications }) => {
    if (socket !== sock) return // late events of a socket that was already replaced
    if (qr) renderQr(qr)
    if (receivedPendingNotifications === true) {
      session.caughtUp = true
      clearTimeout(watchdogTimer)
    }
    if (connection === 'open') {
      connected = true
      session.opened = true
      const outageMs = downSince === null ? 0 : Date.now() - downSince
      downSince = null
      setIdentity(socket.user)
      logger.log(`[whatsapp] connected as ${meIds.join(' / ')}; self-chat target ${selfChatJid}`)
      if (!session.caughtUp) armWatchdog(socket)
      if (!announced) { announced = true; onReady?.() }
      onConnected?.({ outageMs })
    }
    // Only a connection that stayed up resets the counters, so open-then-close loops still reach the cap.
    if (connected && session.caughtUp && !session.stableTimer) {
      session.stableTimer = setTimeout(() => { session.stable = true; failures = 0; flaps = 0 }, config.whatsapp?.stableConnectionMs ?? 120_000)
      session.stableTimer.unref?.()
    }
    if (connection === 'close') {
      connected = false
      clearTimeout(watchdogTimer)
      clearTimeout(session.stableTimer)
      if (stopped) return
      const error = lastDisconnect?.error
      const verdict = classifyDisconnect(error?.output?.statusCode, error?.message)
      logger.warn(`[whatsapp] connection closed: ${verdict.reason}`)
      if (verdict.action === 'stop') { stopped = true; onFatal?.(verdict); return }
      scheduleReconnect(verdict, session)
    }
  }

  const handleUpsert = async ({ messages, type, requestId }) => {
    for (const raw of messages) {
      if (metaAiIds.has(raw?.key?.id)) continue
      remember(raw)
      // A placeholder-resend answer (requestId) is a replay with the original timestamp, not a live message.
      const normalized = normalizeUpsert(raw, { type: requestId ? 'append' : type, meIds })
      if (normalized.skip === 'ciphertext') {
        // Past maxAge the assistant would skip the message anyway; don't ask the phone for it.
        const ageMs = Date.now() - toEpochSeconds(raw.messageTimestamp) * 1000
        if (ageMs <= config.backlog.maxAgeMinutes * 60_000) {
          sock.requestPlaceholderResend(raw.key).catch(error => logger.warn(`[whatsapp] placeholder resend failed: ${error.message}`))
        }
        continue
      }
      if (normalized.skip) continue
      // The phone's own form of the self-chat JID (PN vs LID is unverified) is the best target for notices. Only a
      // real command counts, so other traffic on an own JID cannot re-point the notices.
      const { message } = normalized
      message.chatIdAlt ??= await resolvePhoneJid(message.chatId)
      if (message.fromMe && !message.isForwarded && isSelfChatJid(message.chatId, meIds) && !config.whatsapp?.selfChatJid && isKnownCommand(message.text)) selfChatJid = message.chatId
      try {
        await onMessage(normalized.message)
      } catch (error) {
        logger.error(`[whatsapp] message handler failed: ${error.stack ?? error.message}`)
      }
    }
  }

  async function connect () {
    if (stopped) return
    try {
      sock = await createSocket({ authDir: config.paths.auth, logger: baileysLogger, getMessage: async key => findRaw(key)?.message })
    } catch (error) {
      logger.error(`[whatsapp] socket setup failed: ${error.message}`)
      scheduleReconnect({ action: 'recreate_backoff', reason: 'socket_setup_failed' })
      return
    }
    // Before any event: the offline backlog can be flushed before 'open'. First connect ever starts the history
    // floor at now, so history sync and old offline messages never trigger replies. Linked creds already know us.
    store.seedHistoryFloor(Math.floor(Date.now() / 1000))
    setIdentity(sock.user)
    // The owner's own prompts to Meta AI arrive with the own JID as remoteJid and look exactly like self-chat
    // (#2822); only the stanza's @bot recipient tells them apart, and Baileys drops it from the key.
    sock.ws?.on?.('CB:message', node => {
      if (!isJidMetaAI(node?.attrs?.recipient) || !node.attrs.id) return
      metaAiIds.add(node.attrs.id)
      if (metaAiIds.size > MAX_META_AI_IDS) metaAiIds.delete(metaAiIds.values().next().value)
    })
    sock.ev.on('connection.update', handleConnection(sock, { caughtUp: false, opened: false, stable: false, stableTimer: undefined }))
    sock.ev.on('messages.upsert', handleUpsert)
    sock.ev.on('messaging-history.set', ({ messages = [], lidPnMappings = [] }) => {
      for (const raw of messages) remember(raw)
      for (const mapping of lidPnMappings) learnMapping(mapping)
    })
    sock.ev.on('lid-mapping.update', learnMapping)
  }

  async function send (chatId, text, { quotedRaw, messageId } = {}) {
    if (!sock || !connected) throw new Error('whatsapp not connected')
    const options = {}
    if (messageId) options.messageId = messageId
    // Quoted media replies don't render on mobile (#2739): only quote text messages.
    if (quotedRaw && (quotedRaw.message?.conversation || quotedRaw.message?.extendedTextMessage)) options.quoted = quotedRaw
    const sent = await sock.sendMessage(chatId, { text }, options)
    if (sent) remember(sent)
    return { id: sent?.key?.id ?? messageId }
  }

  return {
    name: 'whatsapp',
    start: connect,
    async stop () {
      stopped = true
      clearTimeout(reconnectTimer)
      clearTimeout(watchdogTimer)
      // end(), never logout(): logout would unlink the device.
      try { await sock?.end(undefined) } catch {}
    },
    send,
    // Notices carry other customers' texts and numbers: they may only ever go to one of the owner's own JIDs.
    sendToSelf (text, options) {
      if (!selfChatJid) throw new Error('self-chat JID unknown (not connected yet)')
      if (!isSelfChatJid(selfChatJid, meIds)) throw new Error(`self-chat target ${selfChatJid} is not one of the own JIDs (${meIds.join(', ') || 'unknown'}); refusing to send a notice there`)
      return send(selfChatJid, text, options)
    },
    async markRead (messages) {
      const keys = messages.map(message => message.raw?.key).filter(Boolean)
      if (keys.length > 0 && sock && connected) await sock.readMessages(keys)
    },
    // A photo without a caption, a location pin, a contact card or an undecryptable message stays in: a thanks after
    // one is not a closing.
    getHistory (chatId, limit) {
      return (history.get(chatId) ?? []).filter(item => item.text || item.attachment).slice(-limit)
        .map(({ id, fromMe, text, attachment, timestamp }) => ({ id, fromMe, text: text ?? '', attachment, timestamp }))
    },
    generateId: () => generateMessageIDV2(sock?.user?.id)
  }
}
