// The Cloud API adapter over a real local http server (ephemeral port) with a fake fetch: webhook verification,
// signatures, normalization, the owner's chat and the 24 h window. No network beyond 127.0.0.1.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import net from 'node:net'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { Store } from '../src/store.js'
import { createCloudApiTransport } from '../src/transport/cloud-api.js'
import { createFakeBrain, knowledge, makeConfig, sleep, tempDir } from './helpers.js'

const SECRET = 'test-app-secret'
const TOKEN = 'TEST-ACCESS-TOKEN'
const PHONE_ID = '106540352242922'
const OWNER = '6281111111111'
const CUSTOMER = '6282222222222'
const CUSTOMER_CHAT = `${CUSTOMER}@s.whatsapp.net`
const OWNER_CHAT = `${OWNER}@s.whatsapp.net`
const silent = { log () {}, warn () {}, error () {} }

/** Answers like the Graph API: a wamid per message, success for a read receipt; `replies` queues other answers. */
function fakeGraph () {
  const calls = []
  const replies = []
  let counter = 0
  async function fetchImpl (url, init) {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    const reply = replies.shift()
    if (reply) return Response.json(reply.body, { status: reply.status })
    if (body.text?.body.length > 4096) return Response.json({ error: { message: '(#100) Invalid parameter', code: 100 } }, { status: 400 })
    if (body.status === 'read') return Response.json({ success: true })
    return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.OUT${++counter}` }] })
  }
  return { calls, replies, fetchImpl, texts: () => calls.filter(call => call.body.type === 'text').map(call => call.body) }
}

async function setup (t, { withAssistant = false, config: overrides = {} } = {}) {
  const dir = tempDir(t)
  const config = makeConfig({
    mode: 'live',
    debounceMs: 10,
    transport: 'cloud-api',
    cloudApi: { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: SECRET, verifyToken: 'verify-me', ownerNumber: '0811-1111-1111', port: 0, webhookPath: '/webhook', graphVersion: 'v26.0' },
    ...overrides
  }, dir)
  const store = new Store(dir, { logger: silent })
  const graph = fakeGraph()
  const received = []
  const untriaged = []
  const fatal = []
  const failedNotices = []
  let assistant
  const transport = createCloudApiTransport({
    config, store, logger: silent, fetchImpl: graph.fetchImpl,
    // As src/main.js wires it: any owner message is the moment to deliver the outbox.
    onMessage: async message => {
      received.push(message)
      if (!assistant) return
      await assistant.handleMessage(message)
      if (message.isSelfChat && message.fromMe) await assistant.flushOwnerOutbox()
    },
    onUntriaged: item => { untriaged.push(item) },
    onFatal: verdict => { fatal.push(verdict) },
    onSelfSendFailed: text => { failedNotices.push(text) }
  })
  const brain = createFakeBrain()
  if (withAssistant) assistant = createAssistant({ config, store, brain, transport, knowledge, logger: silent })
  await transport.start()
  t.after(async () => { await assistant?.stop(); await transport.stop() })
  const url = `http://127.0.0.1:${transport.address().port}/webhook`
  return { store, graph, transport, assistant, brain, received, untriaged, fatal, failedNotices, url }
}

const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
async function post (url, payload, { signature } = {}) {
  const body = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json' }
  if (signature !== null) headers['X-Hub-Signature-256'] = signature ?? sign(body)
  return (await fetch(url, { method: 'POST', headers, body })).status
}
const webhook = ({ messages, statuses, contacts, phoneNumberId = PHONE_ID }) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId }, ...(contacts && { contacts }), ...(messages && { messages }), ...(statuses && { statuses }) } }] }]
})
let counter = 0
const inbound = (from, fields) => ({ from, id: `wamid.IN${++counter}`, timestamp: String(Math.floor(Date.now() / 1000)), ...fields })
const text = (from, body, extra = {}) => inbound(from, { type: 'text', text: { body }, ...extra })
const until = async (condition, timeoutMs = 2000) => {
  const end = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(5)
  }
}

test('Meta\'s verification GET gets the challenge back only with the right verify token', async t => {
  const { url } = await setup(t)
  const get = query => fetch(`${url}?${new URLSearchParams(query)}`)
  const ok = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'text/plain')
  assert.equal(await ok.text(), '1158201444')
  assert.equal((await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status, 403)
  assert.equal((await get({ 'hub.verify_token': 'verify-me', 'hub.challenge': '1' })).status, 403)
  assert.equal((await fetch(url.replace('/webhook', '/other'))).status, 404)
})

test('a malformed request path gets a 400 and the webhook keeps answering', async t => {
  const { url, transport } = await setup(t)
  // `GET //` made `new URL` throw in the request listener, which ended the whole process (webhook-security-r1-1).
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(transport.address().port, '127.0.0.1', () => socket.end('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
    let reply = ''
    socket.on('data', chunk => { reply += chunk })
    socket.on('end', () => resolve(reply.split('\r\n')[0]))
    socket.on('error', reject)
  })
  assert.equal(status, 'HTTP/1.1 400 Bad Request')
  const verify = await fetch(`${url}?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' })}`)
  assert.equal(await verify.text(), '42')
})

test('a POST with a wrong or missing signature is refused with 401 and nothing is delivered', async t => {
  const { url, received, graph } = await setup(t)
  const payload = webhook({ messages: [text(CUSTOMER, 'jam berapa buka?')] })
  assert.equal(await post(url, payload, { signature: sign(JSON.stringify(payload), 'another-secret') }), 401)
  assert.equal(await post(url, payload, { signature: null }), 401)
  assert.equal(await post(url, payload, { signature: 'sha256=' }), 401)
  await sleep(30)
  assert.deepEqual([received.length, graph.calls.length], [0, 0])
})

test('a signed text message arrives in the transport shape; another number of the app is ignored', async t => {
  const { url, received, transport } = await setup(t)
  const message = text(CUSTOMER, 'jam berapa buka?')
  const payload = webhook({ contacts: [{ profile: { name: 'Sari' }, wa_id: CUSTOMER }], messages: [message] })
  assert.equal(await post(url, payload), 200)
  await until(() => received.length === 1)
  const { raw, ...shape } = received[0]
  assert.deepEqual(shape, {
    id: message.id, chatId: CUSTOMER_CHAT, chatIdAlt: undefined, fromMe: false, isSelfChat: false, senderName: 'Sari',
    text: 'jam berapa buka?', timestamp: Number(message.timestamp), kind: 'notify', quotedId: undefined, quotedText: undefined,
    attachment: undefined, isForwarded: false
  })
  assert.equal(raw.id, message.id)
  assert.deepEqual(transport.getHistory(CUSTOMER_CHAT, 5).map(item => item.text), ['jam berapa buka?'])
  assert.equal(await post(url, webhook({ messages: [text(CUSTOMER, 'halo')], phoneNumberId: '999' })), 200)
  await sleep(30)
  assert.equal(received.length, 1)
})

test('a captioned photo is a message with an attachment; a voice note or sticker is untriaged; forwards and buttons are read', async t => {
  const { url, received, untriaged } = await setup(t)
  const photo = inbound(CUSTOMER, { type: 'image', image: { caption: 'sudah transfer ya', mime_type: 'image/jpeg', id: '1003383421387256' } })
  const voice = inbound(CUSTOMER, { type: 'audio', audio: { mime_type: 'audio/ogg', id: '1' } })
  const sticker = inbound(CUSTOMER, { type: 'sticker', sticker: { mime_type: 'image/webp', id: '2' } })
  const forwarded = text(CUSTOMER, '/pause', { context: { forwarded: true } })
  const button = inbound(CUSTOMER, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'cancel-button', title: 'Cancel' } } })
  assert.equal(await post(url, webhook({ messages: [photo, voice, sticker, forwarded, button] })), 200)
  await until(() => received.length === 3 && untriaged.length === 2)
  assert.deepEqual(received.map(message => [message.text, message.attachment, message.isForwarded]), [
    ['sudah transfer ya', 'image', false], ['/pause', undefined, true], ['Cancel', undefined, false]
  ])
  assert.deepEqual(untriaged.map(item => [item.id, item.chatId, item.attachment]), [[voice.id, CUSTOMER_CHAT, 'audio'], [sticker.id, CUSTOMER_CHAT, 'sticker']])
})

test('a quoted reply carries quotedId, and the quoted text when it quotes one of our messages', async t => {
  const { url, received, transport } = await setup(t)
  const { id } = await transport.send(CUSTOMER_CHAT, 'Kami buka jam 8 ya Kak')
  await post(url, webhook({ messages: [text(CUSTOMER, 'oke kak', { context: { from: '15550783881', id } }), text(CUSTOMER, 'yang ini?', { context: { from: CUSTOMER, id: 'wamid.UNKNOWN' } })] }))
  await until(() => received.length === 2)
  assert.deepEqual(received.map(message => [message.quotedId, message.quotedText]), [[id, 'Kami buka jam 8 ya Kak'], ['wamid.UNKNOWN', '']])
})

test('send() posts a text without link preview, quotes by wamid and returns Meta\'s id; errors never show the token', async t => {
  const { graph, transport, fatal } = await setup(t)
  const sent = await transport.send(CUSTOMER_CHAT, 'Lihat https://example.com', { quotedRaw: { id: 'wamid.Q1' } })
  assert.deepEqual(sent, { id: 'wamid.OUT1' })
  assert.equal(graph.calls[0].url, `https://graph.facebook.com/v26.0/${PHONE_ID}/messages`)
  assert.equal(graph.calls[0].headers.Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(graph.calls[0].body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: CUSTOMER, type: 'text',
    text: { body: 'Lihat https://example.com', preview_url: false }, context: { message_id: 'wamid.Q1' }
  })
  await transport.send(CUSTOMER_CHAT, 'tanpa kutipan')
  assert.equal(graph.calls[1].body.context, undefined)

  graph.replies.push({ status: 400, body: { error: { message: `(#131030) Recipient not in allowed list for ${TOKEN}`, code: 131030 } } })
  await assert.rejects(transport.send(CUSTOMER_CHAT, 'x'), error => error.notSent === true && error.code === 131030 && !error.message.includes(TOKEN))
  assert.equal(fatal.length, 0)
  graph.replies.push({ status: 401, body: { error: { message: 'Error validating access token: Session has expired', code: 190 } } })
  await assert.rejects(transport.send(CUSTOMER_CHAT, 'x'), /code 190/)
  assert.deepEqual(fatal.map(verdict => verdict.reason), ['access_token_rejected'])
})

test('markRead posts one read receipt per message', async t => {
  const { graph, transport } = await setup(t)
  await transport.markRead([{ id: 'wamid.A', raw: { id: 'wamid.A' } }, { id: 'wamid.B' }])
  assert.deepEqual(graph.calls.map(call => call.body), [
    { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.A' },
    { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.B' }
  ])
})

test('the owner\'s number is "Message yourself": its own /commands run, forwarded ones do not, nothing is triaged', async t => {
  const { url, received, graph, store, brain } = await setup(t, { withAssistant: true })
  await post(url, webhook({ messages: [text(OWNER, '/help')] }))
  await until(() => graph.texts().length === 1)
  assert.deepEqual([received[0].chatId, received[0].isSelfChat, received[0].fromMe], [OWNER_CHAT, true, true])
  const [reply] = graph.texts()
  assert.equal(reply.to, OWNER)
  assert.match(reply.text.body, /^🤖 Commands/)
  assert.equal(store.isSentByBot('wamid.OUT1'), true, 'the id Meta returned is recorded as bot-sent')

  await post(url, webhook({ messages: [text(OWNER, '/pause', { context: { forwarded: true } })] }))
  await until(() => graph.texts().length === 2)
  assert.equal(store.paused, false)
  assert.match(graph.texts()[1].text.body, /Ignored a forwarded message/)
  assert.equal(brain.calls.length, 0)
})

test('a notice outside the owner\'s 24 h window waits in the outbox and goes out with the owner\'s next message', async t => {
  const { url, graph, store, assistant, failedNotices } = await setup(t, { withAssistant: true })
  // The owner never wrote to the business number: the notice is kept, nothing is posted to Meta.
  const outcome = await assistant.announce('🤖 Assistant online')
  assert.deepEqual([outcome.sent, outcome.queued, store.ownerOutbox.length, graph.calls.length], [false, true, 1, 0])

  await post(url, webhook({ messages: [text(OWNER, 'hai')] }))
  await until(() => store.ownerOutbox.length === 0)
  assert.equal(graph.texts().length, 1)
  assert.match(graph.texts()[0].text.body, /Delayed notice[\s\S]*Assistant online/)

  // Inside the window, Meta refusing it (131047) keeps it too.
  graph.replies.push({ status: 400, body: { error: { message: '(#131047) Re-engagement message', code: 131047 } } })
  assert.equal((await assistant.announce('🤖 second')).queued, true)
  assert.equal(store.ownerOutbox.length, 1)

  // Accepted, then reported failed by a status webhook: handed back to be queued (src/main.js).
  const { id } = await assistant.announce('🤖 third')
  await post(url, webhook({ statuses: [{ id, status: 'failed', timestamp: '1751142888', recipient_id: OWNER, errors: [{ code: 131047, title: 'Re-engagement message' }] }] }))
  await until(() => failedNotices.length === 1)
  assert.match(failedNotices[0], /third/)
})

test('an owner notice over Meta\'s 4096 characters is clipped, so it cannot block the outbox behind it', async t => {
  const { url, graph, store, assistant } = await setup(t, { withAssistant: true })
  // Refused whole, it stayed at the head of the outbox and every notice behind it waited for good (webhook-security-r1-2).
  await assistant.announce(`🤖 Draft #1\n${'😀'.repeat(3000)}`)
  await assistant.announce('🤖 Draft #2')
  assert.equal(store.ownerOutbox.length, 2)
  await post(url, webhook({ messages: [text(OWNER, 'hai')] }))
  await until(() => store.ownerOutbox.length === 0)
  const [long, short] = graph.texts().map(body => body.text.body)
  assert.ok(long.length <= 4096, `${long.length} characters`)
  assert.match(long, /^🤖 ⏳ Delayed notice[\s\S]*Draft #1\n😀[\s\S]*😀\n… \(cut here: WhatsApp allows 4096 characters per message\)$/u)
  assert.match(short, /Draft #2$/)
})

test('a customer question is answered through the Graph API, quoting it, and marked read', async t => {
  const { url, graph, store } = await setup(t, { withAssistant: true })
  const question = text(CUSTOMER, 'Kak jam berapa buka?')
  await post(url, webhook({ contacts: [{ profile: { name: 'Sari' }, wa_id: CUSTOMER }], messages: [question] }))
  await until(() => graph.calls.some(call => call.body.status === 'read'))
  const [reply] = graph.texts().filter(body => body.to === CUSTOMER)
  assert.deepEqual([reply.context, reply.text.preview_url], [{ message_id: question.id }, false])
  assert.match(reply.text.body, /^🤖 Kami buka/)
  assert.ok(graph.calls.find(call => call.body.status === 'read').body.message_id === question.id)
  assert.equal(store.isSentByBot('wamid.OUT1'), true)
})
