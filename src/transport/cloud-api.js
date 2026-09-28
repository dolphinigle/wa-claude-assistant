// Official WhatsApp Cloud API adapter: Meta's webhook in (node:http), the Graph API out (fetch). Same contract as the
// Baileys transport (docs/building-on-this.md, "The seams"). Payloads and rules checked 2026-09-28 against:
//   https://developers.facebook.com/docs/graph-api/changelog  (v26.0 is the latest version, released 2026-07-29)
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
//     (GET hub.mode/hub.verify_token/hub.challenge; X-Hub-Signature-256 = sha256=HMAC-SHA256(body, app secret))
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/
//     (payloads up to 3 MB; Meta retries a failed delivery for up to 7 days)
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text
//     (and …/image, …/interactive, …/button, …/status)
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api
//     (send a text, context.message_id, mark as read)
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes  (190, 131047, …)
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
//     (`from` may be omitted for a user with a username)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { phoneEntry } from '../chat-lists.js'

export const DEFAULT_GRAPH_VERSION = 'v26.0'
const MAX_BODY_BYTES = 4 * 1024 * 1024 // Meta's payloads are up to 3 MB
const FETCH_TIMEOUT_MS = 10_000
const HISTORY_PER_CHAT = 50
const MAX_SELF_SENDS = 200
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000
// Meta counts the window from its own receipt of the user's message; a send close to the edge can still land outside.
const WINDOW_MARGIN_MS = 5 * 60 * 1000
const OUT_OF_WINDOW = 131047

// Files reach Claude only by their caption, as on Baileys (wa-normalize.js). Stickers and reactions are no content for
// the history, but like a file they are never triaged and must hold a thanks after them.
const ATTACHMENT_KINDS = { image: 'image', video: 'video', document: 'document', audio: 'audio', location: 'location', contacts: 'contact', order: 'other', unsupported: 'other', unknown: 'other' }
const SIGN_KINDS = { sticker: 'sticker', reaction: 'reaction' }
const TEXT_TYPES = new Set(['text', 'interactive', 'button'])
const IGNORED_TYPES = new Set(['system', 'request_welcome', 'ephemeral'])

export const jidForPhone = digits => `${digits}@s.whatsapp.net`

/** `sha256=<hex>` over the raw body with the app secret, compared in constant time. */
export function verifySignature (rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=') || !appSecret) return false
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'))
  const given = Buffer.from(header.slice('sha256='.length).toLowerCase())
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

const textOf = raw => {
  switch (raw.type) {
    case 'text': return raw.text?.body
    case 'image': case 'video': case 'document': return raw[raw.type]?.caption
    case 'interactive': return raw.interactive?.button_reply?.title ?? raw.interactive?.list_reply?.title
    case 'button': return raw.button?.text
    default: return undefined
  }
}

/**
 * One webhook `messages[]` entry → `{message}`, `{untriaged}` or `{skip}`. The owner's number is "Message yourself":
 * isSelfChat and fromMe, so only its own typed `/` messages are commands, as on Baileys.
 * @param {{names: Map<string, string>, ownerDigits: string, quotedTextFor: (chatId: string, id: string) => string|undefined}} context
 */
export function normalizeCloudMessage (raw, { names, ownerDigits, quotedTextFor = () => undefined }) {
  if (!raw?.id || !raw.type) return { skip: 'no_id' }
  // A user with a username may come without a phone number (BSUID only); allowChats and the blocklist match numbers.
  if (!/^[1-9]\d{5,}$/.test(String(raw.from ?? ''))) return { skip: 'no_phone', id: raw.id }
  if (IGNORED_TYPES.has(raw.type)) return { skip: raw.type, id: raw.id }
  const chatId = jidForPhone(raw.from)
  const isOwner = raw.from === ownerDigits
  const timestamp = Number(raw.timestamp) || 0
  const text = textOf(raw)?.trim() ? textOf(raw) : undefined
  // Any type this list does not know is content Claude cannot see, like a file.
  const attachment = ATTACHMENT_KINDS[raw.type] ?? (TEXT_TYPES.has(raw.type) || SIGN_KINDS[raw.type] ? undefined : 'other')
  const quotedId = raw.context?.id || undefined
  if (!text) {
    const kind = attachment ?? SIGN_KINDS[raw.type]
    if (isOwner || !kind) return { skip: 'no_text', id: raw.id }
    return { untriaged: { id: raw.id, chatId, chatIdAlt: undefined, timestamp, attachment: kind }, attachment }
  }
  return {
    message: {
      id: raw.id,
      chatId,
      chatIdAlt: undefined,
      fromMe: isOwner,
      isSelfChat: isOwner,
      senderName: names.get(raw.from) ?? undefined,
      text,
      timestamp,
      kind: 'notify',
      quotedId,
      quotedText: quotedId ? quotedTextFor(chatId, quotedId) ?? '' : undefined,
      attachment,
      isForwarded: Boolean(raw.context?.forwarded || raw.context?.frequently_forwarded), // never an owner command
      raw
    }
  }
}

/**
 * @param {object} options  as createWhatsAppTransport, plus:
 * @param {(text: string) => void} [options.onSelfSendFailed]  a notice Meta accepted but then reported failed
 * @param {typeof fetch} [options.fetchImpl]  injectable for tests
 */
export function createCloudApiTransport ({ config, store, onMessage, onUntriaged, onReady, onConnected, onFatal, onSelfSendFailed, logger = console, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const cloud = config.cloudApi ?? {}
  const phoneNumberId = String(cloud.phoneNumberId)
  const ownerDigits = phoneEntry(cloud.ownerNumber ?? '')
  const ownerChatId = jidForPhone(ownerDigits)
  const webhookPath = cloud.webhookPath ?? '/webhook'
  const messagesUrl = `https://graph.facebook.com/${cloud.graphVersion ?? DEFAULT_GRAPH_VERSION}/${phoneNumberId}/messages`
  const history = new Map() // chatId → [{id, fromMe, text, attachment, timestamp}]
  const lastInboundAt = new Map() // chatId → epoch ms, for the 24 h window
  const selfSends = new Map() // our notice ids → text, to keep a notice Meta reports failed after accepting it
  let server
  let processing = Promise.resolve()
  let fatal = false
  let warnedOtherNumber = false

  const redact = text => String(text ?? '').replaceAll(cloud.accessToken || '\u0000', '[token]')
  const remember = (chatId, item) => {
    const list = (history.get(chatId) ?? []).filter(known => known.id !== item.id)
    list.push(item)
    history.set(chatId, list.slice(-HISTORY_PER_CHAT))
  }
  const quotedTextFor = (chatId, id) => history.get(chatId)?.find(item => item.id === id)?.text
  const windowOpen = at => now() - at < SERVICE_WINDOW_MS - WINDOW_MARGIN_MS
  const notSent = message => Object.assign(new Error(message), { notSent: true })

  async function graph (body) {
    if (fatal) throw notSent('Cloud API access token rejected; renew it and restart')
    let response
    try {
      response = await fetchImpl(messagesUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (error) {
      // No answer: the request may still have been delivered, so no `notSent` and no retry here.
      throw new Error(`Graph API request failed: ${error.name === 'TimeoutError' ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : redact(error.message)}`)
    }
    const data = await response.json().catch(() => ({}))
    if (response.ok) return data
    const code = data?.error?.code
    const error = Object.assign(new Error(`Graph API ${response.status}${code ? ` (code ${code})` : ''}: ${redact(data?.error?.message ?? response.statusText)}`), { code, status: response.status })
    if (response.status < 500) error.notSent = true // Meta refused it
    if (response.status === 401 || code === 190) {
      fatal = true
      onFatal?.({ action: 'stop', reason: 'access_token_rejected', advice: 'The Cloud API access token is invalid or expired (a temporary token from API Setup lasts about 24 h). Put a new one, or a system-user token, in config.local.json cloudApi.accessToken and restart.' })
    }
    throw error
  }

  async function send (chatId, text, { quotedRaw } = {}) {
    const to = chatId.split('@')[0]
    if (!/^\d+$/.test(to)) throw notSent(`not a phone-number chat: ${chatId}`)
    // WhatsApp refuses free-form messages outside 24 h of the recipient's last message (131047), sometimes only later
    // in a status webhook; a known closed window is refused here, before anything goes out. For the owner an unknown
    // time counts as closed: the notice waits in the outbox for the owner's next message instead of being lost.
    const isOwner = chatId === ownerChatId
    const last = isOwner ? store.ownerLastMessageAt : Math.max(lastInboundAt.get(chatId) ?? 0, store.existingChat(chatId)?.lastReceivedAt ?? 0)
    if ((isOwner || last > 0) && !windowOpen(last)) {
      throw Object.assign(notSent(`outside WhatsApp's 24 h window: ${isOwner ? 'you have' : 'they have'} not written to the business number for 24 h`), { code: OUT_OF_WINDOW })
    }
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false } }
    if (typeof quotedRaw?.id === 'string' && quotedRaw.id.startsWith('wamid.')) body.context = { message_id: quotedRaw.id }
    const data = await graph(body)
    const id = data?.messages?.[0]?.id
    if (id) remember(chatId, { id, fromMe: true, text, timestamp: Math.floor(now() / 1000) })
    return { id }
  }

  function handleStatus (status) {
    if (status?.status !== 'failed') return
    const code = status.errors?.[0]?.code
    logger.warn(`[cloud-api] a sent message failed: code ${code ?? 'unknown'}`) // no number, no text: the log is plain
    const text = selfSends.get(status.id)
    if (text === undefined) return
    selfSends.delete(status.id)
    try { onSelfSendFailed?.(text) } catch (error) { logger.error(`[cloud-api] failed-notice handler: ${error.message}`) }
  }

  async function handleInbound (raw, names) {
    // Any message opens the 24 h window, a sticker from the owner too.
    const at = Math.min((Number(raw?.timestamp) || 0) * 1000, now())
    if (raw?.from === ownerDigits) store.setOwnerLastMessageAt(at)
    else if (raw?.from) lastInboundAt.set(jidForPhone(raw.from), Math.max(lastInboundAt.get(jidForPhone(raw.from)) ?? 0, at))
    const normalized = normalizeCloudMessage(raw, { names, ownerDigits, quotedTextFor })
    if (normalized.skip === 'no_phone') logger.warn('[cloud-api] skipped a message without a phone number (a WhatsApp username user); not supported yet')
    if (normalized.skip) return
    const item = normalized.message ?? normalized.untriaged
    if (item.chatId !== ownerChatId && (normalized.message?.text || normalized.attachment)) {
      remember(item.chatId, { id: item.id, fromMe: false, text: normalized.message?.text, attachment: normalized.message?.attachment ?? normalized.attachment, timestamp: item.timestamp })
    }
    if (normalized.untriaged) {
      try { onUntriaged?.(normalized.untriaged) } catch (error) { logger.error(`[cloud-api] untriaged handler failed: ${error.stack ?? error.message}`) }
      return
    }
    try {
      await onMessage(normalized.message)
    } catch (error) {
      logger.error(`[cloud-api] message handler failed: ${error.stack ?? error.message}`)
    }
  }

  async function processPayload (payload) {
    if (payload?.object !== 'whatsapp_business_account') return
    for (const entry of payload.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'messages') continue
        const value = change.value ?? {}
        // One app can hold several numbers (the test number, later a real one): only ours is handled.
        if (value.metadata?.phone_number_id && String(value.metadata.phone_number_id) !== phoneNumberId) {
          if (!warnedOtherNumber) logger.warn('[cloud-api] ignoring webhooks for another phone number id of this app')
          warnedOtherNumber = true
          continue
        }
        for (const status of value.statuses ?? []) handleStatus(status)
        const names = new Map((value.contacts ?? []).map(contact => [contact?.wa_id, contact?.profile?.name]))
        for (const raw of value.messages ?? []) await handleInbound(raw, names)
      }
    }
  }

  function handleRequest (req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== webhookPath) return res.writeHead(404).end()
    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && sameSecret(url.searchParams.get('hub.verify_token'), cloud.verifyToken)
      if (!ok) return res.writeHead(403).end()
      logger.log('[cloud-api] Meta verified the webhook')
      return res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }).end(url.searchParams.get('hub.challenge') ?? '')
    }
    if (req.method !== 'POST') return res.writeHead(405).end()
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return res.writeHead(413, { Connection: 'close' }).end()
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { res.writeHead(413, { Connection: 'close' }).end(); req.destroy() } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return
      const rawBody = Buffer.concat(chunks)
      if (!verifySignature(rawBody, req.headers['x-hub-signature-256'], cloud.appSecret)) {
        logger.warn('[cloud-api] rejected a webhook POST with a missing or wrong signature')
        return res.writeHead(401).end()
      }
      let payload
      try { payload = JSON.parse(rawBody.toString('utf8')) } catch { return res.writeHead(400).end() }
      res.writeHead(200).end()
      // Meta wants its 200 fast; one payload at a time keeps a chat's messages in order.
      processing = processing.then(() => processPayload(payload)).catch(error => logger.error(`[cloud-api] webhook processing failed: ${error.stack ?? error.message}`))
    })
    req.on('error', () => {})
  }

  return {
    name: 'cloud-api',
    async start () {
      // First start ever: anything Meta still retries from before it is history, never handled (as on Baileys).
      store.seedHistoryFloor(Math.floor(now() / 1000))
      server = http.createServer(handleRequest)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        // Loopback only: the tunnel reaches it from this machine, the LAN never does.
        server.listen(cloud.port ?? 3000, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      logger.log(`[cloud-api] webhook listening on http://127.0.0.1:${server.address().port}${webhookPath}`)
      if (!windowOpen(store.ownerLastMessageAt)) {
        logger.log('[cloud-api] You have not written to the business number in the last 24 h, so WhatsApp will not deliver notices to you yet: they wait in the outbox until you send it any message (e.g. /status).')
      }
      onReady?.()
      onConnected?.({ outageMs: 0 })
    },
    async stop () {
      if (server) {
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(() => resolve()))
      }
      await processing
    },
    address: () => server?.address(),
    send,
    // Notices carry other customers' texts and numbers: only ever to the owner's number.
    async sendToSelf (text, options) {
      const sent = await send(ownerChatId, text, options)
      if (sent.id) {
        selfSends.set(sent.id, text)
        if (selfSends.size > MAX_SELF_SENDS) selfSends.delete(selfSends.keys().next().value)
      }
      return sent
    },
    async markRead (messages) {
      for (const message of messages) {
        const id = message.raw?.id ?? message.id
        if (typeof id === 'string' && id.startsWith('wamid.')) await graph({ messaging_product: 'whatsapp', status: 'read', message_id: id })
      }
    },
    getHistory (chatId, limit) {
      return (history.get(chatId) ?? []).filter(item => item.text || item.attachment).slice(-limit)
        .map(({ id, fromMe, text, attachment, timestamp }) => ({ id, fromMe, text: text ?? '', attachment, timestamp }))
    },
    // Meta picks the message id; the assistant marks the returned one as bot-sent (there are no echoes anyway).
    generateId: () => undefined
  }
}
