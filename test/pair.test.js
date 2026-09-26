import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant } from '../src/assistant.js'
import { checkExistingLink, seedHistoryFloorOnPairing } from '../src/pair.js'
import { Store } from '../src/store.js'
import { createFakeBrain, createFakeTransport, incoming, knowledge, makeConfig, tempDir } from './helpers.js'

test('pair refuses to connect on an existing link unless forced: it would consume the offline queue', () => {
  assert.deepEqual(checkExistingLink({ alreadyLinked: false, force: false, authDir: '/a' }), { proceed: true })
  const refused = checkExistingLink({ alreadyLinked: true, force: false, authDir: '/a' })
  assert.equal(refused.proceed, false)
  assert.match(refused.message, /already linked[\s\S]*npm start[\s\S]*--force/)
  const forced = checkExistingLink({ alreadyLinked: true, force: true, authDir: '/a' })
  assert.equal(forced.proceed, true)
  assert.match(forced.warning, /will not be triaged/)
})

test('pairing seeds the history floor, so a message queued before the first npm start is still drafted', async t => {
  const dir = tempDir(t)
  const pairedAt = Date.now() - 6 * 60 * 1000
  assert.equal(seedHistoryFloorOnPairing(dir, pairedAt), Math.floor(pairedAt / 1000))
  assert.equal(seedHistoryFloorOnPairing(dir, Date.now()), Math.floor(pairedAt / 1000), 'set once, like the transport')

  // npm start six minutes later: the transport's own seed is a no-op now.
  const store = new Store(dir, { logger: { error () {} } })
  store.seedHistoryFloor(Math.floor(Date.now() / 1000))
  const brain = createFakeBrain()
  const transport = createFakeTransport()
  const assistant = createAssistant({ config: makeConfig({ mode: 'live', debounceMs: 10 }, dir), store, brain, transport, knowledge, logger: { log () {}, warn () {}, error () {} } })
  t.after(() => assistant.stop())
  await assistant.handleMessage(incoming('6282222222222@s.whatsapp.net', 'jam buka?', { kind: 'append', timestamp: Math.floor((pairedAt + 3 * 60 * 1000) / 1000) }))
  await assistant.idle()
  assert.equal(brain.calls.length, 1)
  assert.match(transport.toSelf()[0], /📝 DRAFT #1/)
})
