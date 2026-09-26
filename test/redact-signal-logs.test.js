// libsignal logs whole session records (private ratchet keys) to the console; they must never reach the output.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactSignalSessions } from '../src/transport/redact-signal-logs.js'
import { createBaileysLogger } from '../src/transport/whatsapp.js'

const fakeConsole = () => {
  const lines = []
  const target = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) target[method] = (...args) => lines.push([method, ...args])
  return { target, lines }
}
// The shape printed live on 2026-09-27 by session_record.js ("Closing session:", session).
const session = () => ({
  _chains: { abc: { chainKey: { key: Buffer.from('secret-chain') }, chainType: 2, messageKeys: {} } },
  registrationId: 1,
  currentRatchet: { ephemeralKeyPair: { pubKey: Buffer.alloc(33, 5), privKey: Buffer.from('private-key') }, rootKey: Buffer.from('root') },
  indexInfo: { baseKey: Buffer.alloc(33, 7), closed: -1 }
})

test('a session record passed to any console method is replaced, the message text is kept', () => {
  const { target, lines } = fakeConsole()
  redactSignalSessions(target)
  target.info('Closing session:', session())
  target.warn('Session already closed', session())
  target.info('Removing old closed session:', { indexInfo: { closed: 1 } })
  assert.deepEqual(lines, [
    ['info', 'Closing session:', '[signal session redacted]'],
    ['warn', 'Session already closed', '[signal session redacted]'],
    ['info', 'Removing old closed session:', '[signal session redacted]']
  ])
  assert.ok(!JSON.stringify(lines).includes('private-key'))
})

test('a record nested in an object or array, or a bare private key, is replaced too', () => {
  const { target, lines } = fakeConsole()
  redactSignalSessions(target)
  target.info('record:', { sessions: { abc: session() } })
  target.info('list:', [session()])
  target.warn('pair:', { keyPair: { privKey: Buffer.from('private-key') } })
  assert.ok(!JSON.stringify(lines).includes('private-key'))
  assert.equal(lines.filter(line => line[2] === '[signal session redacted]').length, 3)
})

test('the Baileys logger keeps a history-sync notice to its progress fields at any level', async () => {
  const chunks = []
  const destination = { write: chunk => { chunks.push(String(chunk)) } }
  const logger = createBaileysLogger({ level: 'info', destination })
  const histNotification = { mediaKey: Buffer.from('history-media-key'), directPath: '/v/t62/secret', fileSha256: Buffer.from('h'), syncType: 2, chunkOrder: 1, progress: 40, initialHistBootstrapInlinePayload: Buffer.from('chats') }
  logger.info({ histNotification, process: true, id: 'x' }, 'got history notification')
  const out = chunks.join('')
  assert.ok(out.includes('"syncType":2') && out.includes('"progress":40'))
  assert.ok(!/mediaKey|directPath|secret|InlinePayload/.test(out), out)
})

test('other arguments pass through unchanged, and installing twice wraps once', () => {
  const { target, lines } = fakeConsole()
  redactSignalSessions(target)
  redactSignalSessions(target)
  const error = new Error('boom')
  target.log('[whatsapp] connected', { id: 'x' }, 3, null, error)
  assert.deepEqual(lines, [['log', '[whatsapp] connected', { id: 'x' }, 3, null, error]])
})

test('the WhatsApp transport installs it on the real console as soon as it is imported', () => {
  const seen = []
  const write = process.stdout.write
  process.stdout.write = chunk => { seen.push(String(chunk)); return true } // below the console: what a log file gets
  try { console.info('Closing session:', session()) } finally { process.stdout.write = write }
  assert.ok(seen.join('').includes('[signal session redacted]'))
  assert.ok(!seen.join('').includes('private-key'))
})
