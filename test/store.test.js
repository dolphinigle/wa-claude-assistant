import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { deepMerge } from '../src/config.js'
import { Store, writeFileAtomic } from '../src/store.js'
import { tempDir } from './helpers.js'

test('state survives a restart', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.markProcessed('A')
  store.markSentByBot('B')
  store.advanceLastProcessedTs(1000)
  store.setPaused(true)
  const draft = store.createDraft({ chatId: 'c', contactName: 'C', draft: 'x' })
  store.updateChat('c', { muted: true, name: 'C' })

  const reloaded = new Store(dir)
  assert.ok(reloaded.hasProcessed('A'))
  assert.ok(reloaded.isSentByBot('B'))
  assert.equal(reloaded.lastProcessedTs, 1000)
  assert.equal(reloaded.paused, true)
  assert.equal(reloaded.getDraft(draft.id).status, 'pending')
  assert.equal(reloaded.chat('c').muted, true)
  assert.equal(reloaded.createDraft({ chatId: 'c' }).id, draft.id + 1, 'draft counter persists')
})

test('writes are atomic: temp file + rename, no leftovers, private mode', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  for (let index = 0; index < 50; index++) store.markProcessed(`id${index}`)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  assert.doesNotThrow(() => JSON.parse(readFileSync(store.file, 'utf8')))
  assert.equal(statSync(store.file).mode & 0o777, 0o600)
})

test('a crash mid-write (stray temp file) leaves the previous state intact', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.advanceLastProcessedTs(42)
  writeFileSync(path.join(dir, 'state.json.999.1.tmp'), '{"lastProcessedTs": 7, "trunc')
  assert.equal(new Store(dir).lastProcessedTs, 42)
})

test('a corrupt state file is moved aside and state starts fresh', t => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'state.json'), '{not json')
  const store = new Store(dir, { logger: { error () {} } })
  assert.equal(store.lastProcessedTs, 0)
  assert.ok(readdirSync(dir).some(name => name.startsWith('state.json.corrupt-')))
})

test('writeFileAtomic replaces content in one step', t => {
  const file = path.join(tempDir(t), 'x.json')
  writeFileAtomic(file, 'one')
  writeFileAtomic(file, 'two')
  assert.equal(readFileSync(file, 'utf8'), 'two')
})

test('bounded id sets drop the oldest entries', t => {
  const store = new Store(tempDir(t), { limits: { sentByBot: 5, processed: 3 } })
  for (let index = 0; index < 8; index++) { store.markSentByBot(`S${index}`); store.markProcessed(`P${index}`) }
  assert.equal(store.state.sentByBot.length, 5)
  assert.ok(!store.isSentByBot('S2') && store.isSentByBot('S3') && store.isSentByBot('S7'))
  assert.deepEqual(store.state.processed, ['P5', 'P6', 'P7'])
  assert.ok(!store.hasProcessed('P4'))
})

test('auto-send counters use rolling windows', t => {
  let clock = 1_000_000_000
  const store = new Store(tempDir(t), { now: () => clock })
  store.recordAutoSend('a')
  clock += 30 * 60 * 1000
  store.recordAutoSend('a')
  store.recordAutoSend('b')
  assert.equal(store.countChatAutoSends('a', 60 * 60 * 1000), 2)
  clock += 31 * 60 * 1000
  assert.equal(store.countChatAutoSends('a', 60 * 60 * 1000), 1)
  assert.equal(store.countAutoSends(24 * 60 * 60 * 1000), 3)
  clock += 24 * 60 * 60 * 1000
  assert.equal(store.countAutoSends(24 * 60 * 60 * 1000), 0)
})

test('drafts: cancel per chat, expire by age', t => {
  let clock = 0
  const store = new Store(tempDir(t), { now: () => clock })
  const a = store.createDraft({ chatId: 'a' })
  const b = store.createDraft({ chatId: 'b' })
  assert.deepEqual(store.cancelChatDrafts('a', 'owner_replied').map(draft => draft.id), [a.id])
  clock = 24 * 60 * 60 * 1000
  assert.deepEqual(store.expireDrafts(24 * 60 * 60 * 1000).map(draft => draft.id), [b.id])
  assert.equal(store.pendingDrafts().length, 0)
})

test('audit log is append-only JSON lines', t => {
  const store = new Store(tempDir(t))
  store.audit('one', { a: 1 })
  store.audit('two')
  const lines = readFileSync(store.auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.event), ['one', 'two'])
  assert.ok(existsSync(store.auditFile))
})

test('config deepMerge: objects merge, arrays and scalars replace', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, list: [1, 2], mode: 'shadow' }, { a: { c: 3 }, list: [9], mode: 'live' }), { a: { b: 1, c: 3 }, list: [9], mode: 'live' })
})
