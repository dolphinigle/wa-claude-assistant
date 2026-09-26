import assert from 'node:assert/strict'
import fs, { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { mock, test } from 'node:test'
import { deepMerge } from '../src/config.js'
import { Store, writeFileAtomic } from '../src/store.js'
import { tempDir } from './helpers.js'

test('state survives a restart', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.markProcessed('A')
  store.markSentByBot('B')
  store.markClosingReply('R')
  store.addToInbox({ id: 'Q', chatId: 'c', text: 'iya kak', quotedText: 'Mau diantar Sabtu kak?', quotedId: 'O1', timestamp: 1 })
  store.seedHistoryFloor(1000)
  store.seedHistoryFloor(2000)
  store.setPaused(true, 5000)
  const draft = store.createDraft({ chatId: 'c', contactName: 'C', draft: 'x' })
  store.updateChat('c', { muted: true, name: 'C' })

  const reloaded = new Store(dir)
  assert.ok(reloaded.hasProcessed('A'))
  assert.ok(reloaded.isSentByBot('B'))
  assert.ok(reloaded.isClosingReply('R') && !reloaded.isClosingReply('B'), 'closing replies are told apart from other bot sends')
  assert.deepEqual([reloaded.inboxMessages()[0].quotedText, reloaded.inboxMessages()[0].quotedId], ['Mau diantar Sabtu kak?', 'O1'], 'a recovered message keeps what it replied to')
  assert.equal(reloaded.historyFloorTs, 1000, 'the floor is set once')
  assert.equal(reloaded.paused, true)
  assert.equal(reloaded.pauseChangedAt, 5000)
  assert.equal(reloaded.getDraft(draft.id).status, 'pending')
  assert.equal(reloaded.chat('c').muted, true)
  assert.equal(reloaded.createDraft({ chatId: 'c' }).id, draft.id + 1, 'draft counter persists')
})

test('writes leave no temp files and use a private mode', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  for (let index = 0; index < 50; index++) store.markProcessed(`id${index}`)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  assert.doesNotThrow(() => JSON.parse(readFileSync(store.file, 'utf8')))
  assert.equal(statSync(store.file).mode & 0o777, 0o600)
})

test('a stray temp file from an earlier crash is never read', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.seedHistoryFloor(42)
  writeFileSync(path.join(dir, 'state.json.999.1.tmp'), '{"historyFloorTs": 7, "trunc')
  assert.equal(new Store(dir).historyFloorTs, 42)
})

test('a write that fails halfway leaves the previous state.json intact and removes its temp file', t => {
  const dir = tempDir(t)
  const store = new Store(dir)
  store.seedHistoryFloor(42)
  const realWriteSync = fs.writeSync
  // Named imports of node:fs only see a mock after syncBuiltinESMExports().
  mock.method(fs, 'writeSync', (fd, contents) => { realWriteSync(fd, String(contents).slice(0, 10)); throw new Error('ENOSPC: no space left') })
  syncBuiltinESMExports()
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports() })
  assert.throws(() => store.setPaused(true), /ENOSPC/)
  mock.restoreAll()
  syncBuiltinESMExports()
  const reloaded = new Store(dir)
  assert.equal(reloaded.historyFloorTs, 42)
  assert.equal(reloaded.paused, false)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
})

test('a corrupt state file is moved aside and state starts fresh', t => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'state.json'), '{not json')
  const store = new Store(dir, { logger: { error () {} } })
  assert.equal(store.historyFloorTs, 0)
  assert.ok(readdirSync(dir).some(name => name.startsWith('state.json.corrupt-')))
})

test('a legacy lastProcessedTs becomes the history floor', t => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastProcessedTs: 1234, paused: true }))
  const store = new Store(dir)
  assert.equal(store.historyFloorTs, 1234)
  assert.equal(store.state.lastProcessedTs, undefined)
  assert.equal(store.paused, true)
})

test('writeFileAtomic replaces content in one step', t => {
  const file = path.join(tempDir(t), 'x.json')
  writeFileAtomic(file, 'one')
  writeFileAtomic(file, 'two')
  assert.equal(readFileSync(file, 'utf8'), 'two')
})

test('bounded id sets drop the oldest entries', t => {
  const store = new Store(tempDir(t), { limits: { sentByBot: 5, processed: 3, closingReplies: 2 } })
  for (let index = 0; index < 8; index++) { store.markSentByBot(`S${index}`); store.markProcessed(`P${index}`); store.markClosingReply(`R${index}`) }
  assert.deepEqual(store.state.closingReplies, ['R6', 'R7'])
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

test('a failed send gives its slot back, per chat and per day', t => {
  const store = new Store(tempDir(t), { now: () => 1_000_000_000 })
  store.recordAutoSend('a')
  const failed = store.recordAutoSend('a')
  assert.deepEqual([store.countChatAutoSends('a', 60 * 60 * 1000), store.countAutoSends(60 * 60 * 1000)], [2, 2])
  store.releaseAutoSend('a', failed)
  assert.deepEqual([store.countChatAutoSends('a', 60 * 60 * 1000), store.countAutoSends(60 * 60 * 1000)], [1, 1])
})

test('a state file from before closing replies loads: the old autoReplies go, pending drafts of either kind stay', t => {
  const dir = tempDir(t)
  const drafts = {
    1: { id: 1, status: 'pending', createdAt: 1, chatId: 'a', draft: 'Sama-sama, Kak 🙏', closing: true, lastMessageAt: 1 },
    2: { id: 2, status: 'pending', createdAt: 2, chatId: 'b', draft: 'Baik Kak', closing: false }
  }
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, draftCounter: 2, drafts, chats: { a: { lastClosingAt: 5 } }, autoReplies: ['R1'], sentByBot: ['R1'] }))
  const store = new Store(dir)
  assert.equal('autoReplies' in store.state, false)
  assert.deepEqual(store.state.closingReplies, [])
  assert.equal(store.isClosingReply('R1'), false, 'an old auto-reply is no closing reply')
  assert.ok(store.isSentByBot('R1'))
  assert.deepEqual(store.pendingDrafts().map(draft => [draft.id, draft.closing]), [[1, true], [2, false]])
  store.markClosingReply('X')
  assert.equal(new Store(dir).isClosingReply('X'), true)
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

test('drafts: an owner reply at a given time cancels only the drafts it answered', t => {
  let clock = 5000
  const store = new Store(tempDir(t), { now: () => clock })
  const answered = store.createDraft({ chatId: 'a', lastMessageAt: 1000 })
  const newer = store.createDraft({ chatId: 'a', lastMessageAt: 3000 })
  const legacy = store.createDraft({ chatId: 'a' }) // no lastMessageAt: createdAt (5000) bounds its messages
  assert.deepEqual(store.cancelChatDrafts('a', 'owner_replied', { answeredAt: 2000 }).map(draft => draft.id), [answered.id])
  assert.deepEqual(store.cancelChatDrafts('a', 'owner_replied', { answeredAt: 5000 }).map(draft => draft.id), [newer.id, legacy.id])
})

test('linked chats: a PN and a LID record are linked through the alt either one saved', t => {
  const store = new Store(tempDir(t))
  store.updateChat('111@lid', { chatIdAlt: '62811@s.whatsapp.net' })
  store.updateChat('222@lid', {})
  assert.deepEqual(store.linkedChatIds('62811@s.whatsapp.net').sort(), ['111@lid', '62811@s.whatsapp.net'])
  assert.deepEqual(store.linkedChatIds('111@lid').sort(), ['111@lid', '62811@s.whatsapp.net'])
  assert.deepEqual(store.linkedChatIds('62822@s.whatsapp.net', '222@lid').sort(), ['222@lid', '62822@s.whatsapp.net'])
  assert.deepEqual(store.linkedChatIds('333@lid'), ['333@lid'])
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
