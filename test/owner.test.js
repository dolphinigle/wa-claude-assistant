import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createOwnerCommands, formatContact, formatDraftNotice, parseCommand } from '../src/owner.js'
import { Store } from '../src/store.js'
import { makeConfig, tempDir } from './helpers.js'

test('parseCommand', () => {
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand('🤖 /ok 1'), null)
  assert.deepEqual(parseCommand('/ok 3'), { name: 'ok', draftId: 3 })
  assert.deepEqual(parseCommand(' /OK 3 '), { name: 'ok', draftId: 3 })
  assert.deepEqual(parseCommand('/no 12'), { name: 'no', draftId: 12 })
  assert.deepEqual(parseCommand('/edit 4 Siap kak,\nbesok ya'), { name: 'edit', draftId: 4, body: 'Siap kak,\nbesok ya' })
  assert.deepEqual(parseCommand('/edit 4'), { name: 'usage', usage: '/edit N <text>' })
  assert.deepEqual(parseCommand('/ok x'), { name: 'usage', usage: '/ok N' })
  assert.deepEqual(parseCommand('/mute Budi Santoso'), { name: 'mute', target: 'Budi Santoso' })
  assert.deepEqual(parseCommand('/pause'), { name: 'pause' })
  assert.equal(parseCommand('/frobnicate').name, 'unknown')
})

function setup (t, { mode = 'live', sendResult, sendDelayMs = 0 } = {}) {
  let clock = Date.UTC(2026, 8, 26, 3, 0)
  const now = () => clock
  const store = new Store(tempDir(t), { now })
  const config = makeConfig({ mode })
  const sends = []
  const gate = {
    async sendToCustomer (chatId, text, meta) {
      sends.push({ chatId, text, meta })
      if (sendDelayMs) await new Promise(resolve => setTimeout(resolve, sendDelayMs))
      if (sendResult) return sendResult
      return mode === 'live' ? { sent: true, id: 'X' } : { sent: false, shadow: true }
    }
  }
  const owner = createOwnerCommands({ config, store, gate, now })
  const draft = store.createDraft({ chatId: 'a@s.whatsapp.net', contactName: 'Alice', excerpt: 'custom cake?', draft: 'Baik Kak, saya cek dulu.', reason: 'custom order' })
  store.updateChat('a@s.whatsapp.net', { name: 'Alice' })
  return { store, owner, sends, draft, advance: ms => { clock += ms }, now }
}

test('/ok sends the draft through the gate and resolves it', async t => {
  const { store, owner, sends, draft } = setup(t)
  const reply = await owner.handle(`/ok ${draft.id}`)
  assert.match(reply, /Sent to Alice/)
  assert.deepEqual(sends.map(send => [send.chatId, send.text]), [['a@s.whatsapp.net', 'Baik Kak, saya cek dulu.']])
  assert.equal(store.getDraft(draft.id).status, 'approved')
  assert.match(await owner.handle(`/ok ${draft.id}`), /already approved/)
  assert.equal(sends.length, 1)
})

test('/edit sends the owner text; /no discards without sending', async t => {
  const { store, owner, sends, draft } = setup(t)
  await owner.handle(`/edit ${draft.id} Bisa kak, 350rb ya`)
  assert.equal(sends[0].text, 'Bisa kak, 350rb ya')
  assert.equal(store.getDraft(draft.id).status, 'edited')

  const second = store.createDraft({ chatId: 'b@s.whatsapp.net', contactName: 'Bob', draft: 'x', reason: 'r' })
  assert.match(await owner.handle(`/no ${second.id}`), /Discarded/)
  assert.equal(store.getDraft(second.id).status, 'rejected')
  assert.equal(sends.length, 1)
})

test('two commands for the same draft while its send is in flight send it once', async t => {
  const { store, owner, sends, draft } = setup(t, { sendDelayMs: 30 })
  const replies = await Promise.all([owner.handle(`/ok ${draft.id}`), owner.handle(`/edit ${draft.id} teks lain`), owner.handle(`/no ${draft.id}`)])
  assert.equal(sends.length, 1)
  assert.match(replies[0], /Sent to/)
  assert.match(replies[1], /being sent/)
  assert.match(replies[2], /being sent/)
  assert.equal(store.getDraft(draft.id).status, 'approved')
})

test('shadow mode: /ok is recorded but the gate reports nothing sent', async t => {
  const { store, owner, draft } = setup(t, { mode: 'shadow' })
  assert.match(await owner.handle(`/ok ${draft.id}`), /\[SHADOW\].*Would send to Alice/s)
  assert.equal(store.getDraft(draft.id).status, 'approved_shadow')
})

test('resolving a thanks draft closes the chat as of the thanks; resolving any other draft does not', async t => {
  const { store, owner, draft, advance, now } = setup(t)
  const thanks = lastMessageAt => store.createDraft({ chatId: 'b@s.whatsapp.net', contactName: 'Bob', excerpt: 'ok makasih kak', draft: 'Sama-sama, Kak 🙏', closing: true, lastMessageAt })
  await owner.handle(`/ok ${draft.id}`)
  assert.equal(store.chat('a@s.whatsapp.net').lastClosingAt, undefined)
  for (const command of ['/no', '/ok', '/edit']) {
    advance(60 * 60_000)
    const { id } = thanks(now() - 20 * 60_000)
    advance(5 * 60_000) // the owner gets to it later: what our side sent meanwhile stays newer than the closing
    await owner.handle(`${command} ${id}${command === '/edit' ? ' Sama-sama ya Kak' : ''}`)
    assert.equal(store.chat('b@s.whatsapp.net').lastClosingAt, now() - 25 * 60_000, command)
  }
  const { id } = thanks(now() - 2 * 60 * 60_000)
  await owner.handle(`/no ${id}`)
  assert.equal(store.chat('b@s.whatsapp.net').lastClosingAt, now() - 25 * 60_000, 'an older thanks never moves it back')
})

test('shadow mode: approving a thanks draft closes the chat like a send would', async t => {
  const { store, owner, now } = setup(t, { mode: 'shadow' })
  const { id } = store.createDraft({ chatId: 'b@s.whatsapp.net', contactName: 'Bob', draft: 'Sama-sama, Kak 🙏', closing: true })
  await owner.handle(`/ok ${id}`)
  assert.equal(store.chat('b@s.whatsapp.net').lastClosingAt, now())
})

test('a failed send keeps the draft pending', async t => {
  const { store, owner, draft } = setup(t, { sendResult: { sent: false, error: 'not connected' } })
  assert.match(await owner.handle(`/ok ${draft.id}`), /failed \(not connected\)/)
  assert.equal(store.getDraft(draft.id).status, 'pending')
})

test('drafts expire after 24 h; unknown ids and replayed commands are refused', async t => {
  const { store, owner, sends, draft, advance, now } = setup(t)
  assert.match(await owner.handle('/ok 999'), /No draft #999/)
  assert.match(await owner.handle(`/ok ${draft.id}`, { timestampMs: now() - 5 * 60_000 }), /newer than this command/)
  advance(24 * 60 * 60 * 1000)
  assert.match(await owner.handle(`/ok ${draft.id}`), /already expired/)
  assert.equal(store.getDraft(draft.id).status, 'expired')
  assert.equal(sends.length, 0)
})

test('/pause /resume /mute /unmute /status /help', async t => {
  const { store, owner, draft } = setup(t)
  await owner.handle('/pause')
  assert.equal(store.paused, true)
  assert.match(await owner.handle('/status'), /Auto-reply: PAUSED/)
  await owner.handle('/resume')
  assert.equal(store.paused, false)

  assert.match(await owner.handle('/mute alice'), /Muted Alice/)
  assert.equal(store.chat('a@s.whatsapp.net').muted, true)
  assert.match(await owner.handle(`/unmute ${draft.id}`), /Unmuted Alice/)
  assert.equal(store.chat('a@s.whatsapp.net').muted, false)
  assert.match(await owner.handle('/mute nobody'), /No chat matches/)

  const status = await owner.handle('/status')
  assert.match(status, /Mode: live/)
  assert.match(status, new RegExp(`#${draft.id} Alice`))
  assert.match(await owner.handle('/help'), /\/edit N <text>/)
  assert.match(await owner.handle('/what'), /Unknown command/)
})

test('a pushName is never enough: labels carry the number and a shared name must be picked by number', async t => {
  const { store, owner } = setup(t)
  const REAL = '6281111111111@s.whatsapp.net'
  const STRANGER = '123456789012345@lid'
  store.updateChat(REAL, { name: 'Budi Santoso' })
  store.updateChat(STRANGER, { name: 'Budi', chatIdAlt: '6289999999999@s.whatsapp.net' })
  assert.equal(formatContact(STRANGER, store.existingChat(STRANGER)), 'Budi (+6289999999999)')
  assert.equal(formatContact('55555@lid', { name: 'Mama' }), 'Mama (55555@lid)', 'no phone known: the JID, never the name alone')

  const ambiguous = await owner.handle('/mute Budi')
  assert.match(ambiguous, /matches Budi Santoso \(\+6281111111111\), Budi \(\+6289999999999\); use the number/)
  assert.equal(store.chat(REAL).muted, false)
  assert.equal(store.chat(STRANGER).muted, false)
  assert.match(await owner.handle('/mute 0811-1111-1111'), /Muted Budi Santoso \(\+6281111111111\)/)
  assert.equal(store.chat(REAL).muted, true)
  assert.match(await owner.handle('/mute +62 899 9999 9999'), /Muted Budi \(\+6289999999999\)/, 'a LID chat is found by its phone alt')
  assert.equal(store.chat(STRANGER).muted, true)

  // The same person on both addressing forms is one chat, not an ambiguous match; an unmute clears both records.
  store.updateChat('6289999999999@s.whatsapp.net', { name: 'Budi', muted: true })
  assert.match(await owner.handle('/unmute 0899-9999-9999'), /Unmuted Budi \(\+6289999999999\)/)
  assert.deepEqual([store.chat(STRANGER).muted, store.chat('6289999999999@s.whatsapp.net').muted], [false, false])
  assert.match(await owner.handle('/mute 0899-9999-9999'), /Muted Budi \(\+6289999999999\)/)
  assert.match(await owner.handle('/mute Budi'), /matches .*; use the number/, 'another Budi still makes the name ambiguous')
})

test('one notice format: id, name, excerpt, summary, draft, reason, held gates and hints', () => {
  const notice = formatDraftNotice({ id: 7, contactName: 'Sari', excerpt: 'sudah transfer', draft: 'Baik Kak', reason: 'payment issue', summary: 'transfer not confirmed', policyReasons: ['decision:escalate'] })
  assert.equal(notice, [
    '🤖 📝 DRAFT #7 · Sari',
    'They wrote: "sudah transfer"',
    'Summary: transfer not confirmed',
    'Draft:\nBaik Kak',
    'Why: payment issue',
    'Reply: /ok 7 · /edit 7 <text> · /no 7'
  ].join('\n'))
  const held = formatDraftNotice({ id: 8, contactName: 'X', excerpt: 'e', draft: '', reason: 'r', policyReasons: ['decision:answer', 'guard:unsupported_amount:1', 'paused'] })
  assert.ok(!held.includes('/ok 8'))
  assert.match(held, /Not auto-sent: guard:unsupported_amount:1, paused/)
})

test('a pending draft saved by the four-category version still works with /ok and /status', async t => {
  const dir = tempDir(t)
  const createdAt = Date.UTC(2026, 8, 26, 2, 0)
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    draftCounter: 1,
    drafts: { 1: { id: 1, status: 'pending', createdAt, chatId: 'a@s.whatsapp.net', contactName: 'Alice (+62811)', action: 'escalate', category: 'important', excerpt: 'sudah transfer', draft: 'Baik Kak, saya cek dulu.', reason: 'payment', summary: 'paid', policyReasons: ['category:important'], messageIds: ['M1'], lastMessageAt: createdAt } },
    chats: { 'a@s.whatsapp.net': { name: 'Alice', muted: false, takeoverUntil: 0, autoSendTimes: [], lastDisclosureAt: 0, shadowDisclosureAt: 0 } }
  }))
  const store = new Store(dir, { now: () => createdAt + 60_000 })
  const sends = []
  const gate = { async sendToCustomer (chatId, text) { sends.push([chatId, text]); return { sent: true, id: 'X' } } }
  const owner = createOwnerCommands({ config: makeConfig({ mode: 'live' }), store, gate, now: () => createdAt + 60_000 })
  assert.match(await owner.handle('/status'), /Pending drafts: #1 Alice/)
  assert.match(await owner.handle('/ok 1'), /Sent to Alice/)
  assert.deepEqual(sends, [['a@s.whatsapp.net', 'Baik Kak, saya cek dulu.']])
  assert.equal(store.createDraft({ chatId: 'b' }).id, 2)
})
