// Baileys adapter (baileys@7.0.0-rc14). Every Baileys-specific call lives here; see docs/implementation-notes.md.
import { chmodSync, mkdirSync } from 'node:fs'
import makeWASocket, {
  generateMessageIDV2, isJidBroadcast, isJidMetaAI, isJidNewsletter, makeCacheableSignalKeyStore, useMultiFileAuthState
} from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { backoffMs, classifyDisconnect, extractText, getMeIds, normalizeUpsert, toEpochSeconds } from './wa-normalize.js'

const HISTORY_PER_CHAT = 50

export function createBaileysLogger () {
  return pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' }, pino.destination(2))
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
 * @param {(verdict: object) => void} [options.onFatal]  the transport stopped and will not reconnect
 * @param {Function} [options.createSocket]  injectable for tests; defaults to the real Baileys socket
 */
export function createWhatsAppTransport ({ config, store, onMessage, onReady, onFatal, logger = console, createSocket = createBaileysSocket }) {
  const baileysLogger = createBaileysLogger()
  const history = new Map() // chatId → [{id, fromMe, text, timestamp, raw}]
  let sock
  let meIds = []
  let selfChatJid = config.whatsapp?.selfChatJid ?? null
  let connected = false
  let stopped = false
  let announced = false
  let attempts = 0
  let reconnectTimer
  let watchdogTimer

  const remember = raw => {
    const chatId = raw?.key?.remoteJid
    if (!chatId || !raw.key.id) return
    const list = history.get(chatId) ?? []
    if (list.some(item => item.id === raw.key.id)) return
    const { text } = extractText(raw.message)
    list.push({ id: raw.key.id, fromMe: Boolean(raw.key.fromMe), text, timestamp: toEpochSeconds(raw.messageTimestamp), raw })
    list.sort((a, b) => a.timestamp - b.timestamp)
    history.set(chatId, list.slice(-HISTORY_PER_CHAT))
  }
  const findRaw = key => history.get(key.remoteJid)?.find(item => item.id === key.id)?.raw

  const armWatchdog = () => {
    clearTimeout(watchdogTimer)
    // Baileys #2810: the socket can look open while messages.upsert never fires. No catch-up signal → recreate.
    watchdogTimer = setTimeout(() => {
      logger.warn('[whatsapp] no receivedPendingNotifications after connect; recreating the socket (#2810 watchdog)')
      sock?.end(new Error('caught-up watchdog'))
    }, config.whatsapp?.caughtUpWatchdogMs ?? 180_000)
  }

  const handleConnection = ({ connection, lastDisconnect, qr, receivedPendingNotifications }) => {
    if (qr) renderQr(qr)
    if (connection === 'open') {
      connected = true
      attempts = 0
      meIds = getMeIds(sock.user)
      selfChatJid ??= meIds[0]
      // First connect ever: start from now so history sync and old offline messages never trigger replies.
      if (!store.lastProcessedTs) store.advanceLastProcessedTs(Math.floor(Date.now() / 1000))
      logger.log(`[whatsapp] connected as ${meIds.join(' / ')}; self-chat target ${selfChatJid}`)
      armWatchdog()
      if (!announced) { announced = true; onReady?.() }
    }
    if (receivedPendingNotifications === true) clearTimeout(watchdogTimer)
    if (connection === 'close') {
      connected = false
      clearTimeout(watchdogTimer)
      if (stopped) return
      const error = lastDisconnect?.error
      const verdict = classifyDisconnect(error?.output?.statusCode, error?.message)
      logger.warn(`[whatsapp] connection closed: ${verdict.reason}`)
      if (verdict.action === 'stop') { stopped = true; onFatal?.(verdict); return }
      attempts++
      if (attempts > (config.whatsapp?.maxReconnectAttempts ?? 10)) {
        stopped = true
        onFatal?.({ action: 'stop', reason: 'too_many_reconnects', advice: `Gave up after ${attempts - 1} reconnect attempts; last: ${verdict.reason}.` })
        return
      }
      reconnectTimer = setTimeout(connect, verdict.action === 'recreate_now' ? 0 : backoffMs(attempts))
    }
  }

  const handleUpsert = async ({ messages, type }) => {
    for (const raw of messages) {
      remember(raw)
      const normalized = normalizeUpsert(raw, { type, meIds })
      if (normalized.skip === 'ciphertext') {
        sock.requestPlaceholderResend(raw.key).catch(error => logger.warn(`[whatsapp] placeholder resend failed: ${error.message}`))
        continue
      }
      if (normalized.skip) continue
      // The phone's own form of the self-chat JID (PN vs LID is unverified) is the best target for notices.
      if (normalized.message.isSelfChat && !config.whatsapp?.selfChatJid) selfChatJid = normalized.message.chatId
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
      attempts++
      reconnectTimer = setTimeout(connect, backoffMs(attempts))
      return
    }
    sock.ev.on('connection.update', handleConnection)
    sock.ev.on('messages.upsert', handleUpsert)
    sock.ev.on('messaging-history.set', ({ messages = [] }) => { for (const raw of messages) remember(raw) })
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
    sendToSelf (text, options) {
      if (!selfChatJid) throw new Error('self-chat JID unknown (not connected yet)')
      return send(selfChatJid, text, options)
    },
    async markRead (messages) {
      const keys = messages.map(message => message.raw?.key).filter(Boolean)
      if (keys.length > 0 && sock && connected) await sock.readMessages(keys)
    },
    getHistory (chatId, limit) {
      return (history.get(chatId) ?? []).filter(item => item.text).slice(-limit).map(({ id, fromMe, text, timestamp }) => ({ id, fromMe, text, timestamp }))
    },
    generateId: () => generateMessageIDV2(sock?.user?.id)
  }
}
