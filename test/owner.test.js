import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOwnerCommands, formatDraftNotice, parseCommand } from '../src/owner.js'
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
  const draft = store.createDraft({ chatId: 'a@s.whatsapp.net', contactName: 'Alice', action: 'draft', excerpt: 'custom cake?', draft: 'Baik Kak, saya cek dulu.', reason: 'custom order' })
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
  assert.match(await owner.handle('/mute nobody'), /No chat named/)

  const status = await owner.handle('/status')
  assert.match(status, /Mode: live/)
  assert.match(status, new RegExp(`#${draft.id} Alice`))
  assert.match(await owner.handle('/help'), /\/edit N <text>/)
  assert.match(await owner.handle('/what'), /Unknown command/)
})

test('draft notice has id, name, excerpt, draft, reason and hints', () => {
  const notice = formatDraftNotice({ id: 7, contactName: 'Sari', action: 'escalate', excerpt: 'sudah transfer', draft: 'Baik Kak', reason: 'payment issue', summary: 'transfer not confirmed', policyReasons: ['category:important'] })
  assert.match(notice, /^🤖 🚨 URGENT #7 · Sari/)
  for (const part of ['They wrote: "sudah transfer"', 'Draft:\nBaik Kak', 'Why: payment issue', '/ok 7', '/edit 7 <text>', '/no 7']) assert.ok(notice.includes(part), part)
  const empty = formatDraftNotice({ id: 8, contactName: 'X', action: 'draft', excerpt: 'e', draft: '', reason: 'r', policyReasons: ['category:simple', 'guard:unsupported_amount:1'] })
  assert.ok(!empty.includes('/ok 8'))
  assert.match(empty, /Not auto-sent: guard:unsupported_amount:1/)
})
