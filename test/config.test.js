import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
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
