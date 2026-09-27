import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { isAllowedChat, listNamesChat, phoneEntry } from '../src/chat-lists.js'
import { loadConfig, ROOT_DIR } from '../src/config.js'
import { tempDir } from './helpers.js'

const rootWith = (t, local) => {
  const root = tempDir(t)
  copyFileSync(path.join(ROOT_DIR, 'config.json'), path.join(root, 'config.json'))
  if (local) writeFileSync(path.join(root, 'config.local.json'), JSON.stringify(local))
  return root
}

test('config.local.json is deep-merged over the defaults', t => {
  const config = loadConfig({ rootDir: rootWith(t, { mode: 'live', autoSend: { maxPerDay: 5 } }) })
  assert.equal(config.mode, 'live')
  assert.deepEqual([config.autoSend.maxPerDay, config.autoSend.maxPerChatPerHour], [5, 3])
})

test('a removed safety setting stops the start instead of being ignored', t => {
  assert.throws(() => loadConfig({ rootDir: rootWith(t, { mode: 'live', autoSend: { minConfidence: 0.95 } }) }), /autoSend\.minConfidence is no longer supported/)
  assert.throws(() => loadConfig({ rootDir: rootWith(t), overrides: { mode: 'sideways' } }), /config\.mode/)
})

test('a phone number written with the trunk 0 after +62 names the chat, in the blocklist and in allowChats (consistency-r3-1)', t => {
  const PN = '6281234567890@s.whatsapp.net'
  const store = { linkedChatIds: (chatId, chatIdAlt) => [chatId, chatIdAlt].filter(Boolean) }
  for (const entry of ['+62 0812-3456-7890', '62 (0)812 3456 7890', '0812-3456-7890', '+62 812-3456-7890', '6281234567890']) {
    assert.equal(phoneEntry(entry), '6281234567890', entry)
    assert.equal(listNamesChat([entry], store, PN), true, entry)
    assert.equal(listNamesChat([entry], store, '123456789012345@lid', PN), true, `${entry}: through the LID's alt`)
    assert.equal(isAllowedChat({ allowChats: [entry] }, store, PN), true, entry)
  }
  assert.equal(listNamesChat(['+62 0812-9999-0000'], store, PN), false, 'another number')
})

test('allowChats defaults to every chat and must list JIDs or phone numbers', t => {
  assert.deepEqual(loadConfig({ rootDir: rootWith(t) }).allowChats, [])
  assert.deepEqual(loadConfig({ rootDir: rootWith(t, { allowChats: ['081293850000', '123456789012345@lid'] }) }).allowChats, ['081293850000', '123456789012345@lid'])
  for (const allowChats of ['081293850000', null, [6281293850000], ['Luki'], ['']]) {
    assert.throws(() => loadConfig({ rootDir: rootWith(t, { allowChats }) }), /config\.allowChats must be a list of JIDs or phone numbers/, JSON.stringify(allowChats))
  }
})

test('blocklist must list JIDs or phone numbers too: a string would drop every message, a name would block nothing (consistency-r1-2)', t => {
  assert.deepEqual(loadConfig({ rootDir: rootWith(t) }).blocklist, [])
  assert.deepEqual(loadConfig({ rootDir: rootWith(t, { blocklist: ['081234567890', '123456789012345@lid'] }) }).blocklist, ['081234567890', '123456789012345@lid'])
  for (const blocklist of ['081234567890', null, [6281234567890], ['Mama'], ['']]) {
    assert.throws(() => loadConfig({ rootDir: rootWith(t, { blocklist }) }), /config\.blocklist must be a list of JIDs or phone numbers/, JSON.stringify(blocklist))
  }
})

test('a JID entry must be in a form a chat has, or it would silently match nothing (skip-safety-r2-2, consistency-r2-1, consistency-r3-1)', t => {
  const accepted = ['6281234567890@s.whatsapp.net', ' 6281234567890@s.whatsapp.net ', '123456789012345@lid', 'alice@console', '+62 812-3456-7890',
    '+62 0812-3456-7890']
  const refused = ['081234567890@s.whatsapp.net', '+6281234567890@s.whatsapp.net', '62081234567890@s.whatsapp.net', '6281234567890@c.us',
    '6281234567890:12@s.whatsapp.net', '6281234567890@S.WHATSAPP.NET', 'Mama@rumah', '@lid', 'Alice@console']
  for (const key of ['allowChats', 'blocklist']) {
    assert.deepEqual(loadConfig({ rootDir: rootWith(t, { [key]: accepted }) })[key], accepted, key)
    for (const entry of refused) {
      assert.throws(() => loadConfig({ rootDir: rootWith(t, { [key]: [entry] }) }), new RegExp(`config\\.${key} must be a list of JIDs or phone numbers.*@s\\.whatsapp\\.net`), `${key}: ${entry}`)
    }
  }
})

test('placeholder: on by default with both texts; a malformed setting stops the start instead of reaching customers', t => {
  assert.deepEqual(loadConfig({ rootDir: rootWith(t) }).placeholder, { enabled: true, text: { id: '🤖 Halo Kak, tunggu sebentar ya 🙏', en: '🤖 Hi! One moment please 🙏' } })
  assert.equal(loadConfig({ rootDir: rootWith(t, { placeholder: { enabled: false } }) }).placeholder.enabled, false)
  assert.equal(loadConfig({ rootDir: rootWith(t, { placeholder: { text: { en: '🤖 Just a moment 🙏' } } }) }).placeholder.text.id, '🤖 Halo Kak, tunggu sebentar ya 🙏', 'deep-merged')
  for (const placeholder of [null, false, 'on', { enabled: 'yes' }, { text: null }, { text: { id: '' } }, { text: { en: '   ' } }, { text: { id: 5 } }]) {
    assert.throws(() => loadConfig({ rootDir: rootWith(t, { placeholder }) }), /config\.placeholder must be/, JSON.stringify(placeholder))
  }
})
