import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkExistingLink } from '../src/pair.js'

test('pair refuses to connect on an existing link unless forced: it would consume the offline queue', () => {
  assert.deepEqual(checkExistingLink({ alreadyLinked: false, force: false, authDir: '/a' }), { proceed: true })
  const refused = checkExistingLink({ alreadyLinked: true, force: false, authDir: '/a' })
  assert.equal(refused.proceed, false)
  assert.match(refused.message, /already linked[\s\S]*npm start[\s\S]*--force/)
  const forced = checkExistingLink({ alreadyLinked: true, force: true, authDir: '/a' })
  assert.equal(forced.proceed, true)
  assert.match(forced.warning, /will not be triaged/)
})
