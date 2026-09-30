import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createBormaRefresher, runExport } from '../src/borma-refresh.js'

const HOUR_MS = 3_600_000
const NOW = Date.UTC(2026, 8, 30, 9)
const DATA = { catalog: { products: [], stockAsOf: '2026-09-30 15:51' }, stores: [] }

function setup ({ ageHours = 7, refreshHours = 6, run = async () => ({ ok: true, summary: 'exported …, stock as of 2026-09-30 15:51 WIB' }), load = () => DATA } = {}) {
  const reloads = []
  const runs = []
  const logs = { log: [], warn: [] }
  const intervals = []
  const refresher = createBormaRefresher({
    config: { rootDir: '/repo', borma: { enabled: true, refreshHours } },
    lookup: { reload: data => reloads.push(data) },
    dataDir: '/repo/data',
    run: options => { runs.push(options); return run(options) },
    load,
    stat: file => { assert.equal(file, '/repo/data/borma/catalog.json'); if (ageHours === null) throw new Error('ENOENT'); return { mtimeMs: NOW - ageHours * HOUR_MS } },
    now: () => NOW,
    logger: { log: text => logs.log.push(text), warn: text => logs.warn.push(text) },
    timers: { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval: id => { intervals[id - 1].cleared = true } }
  })
  return { refresher, reloads, runs, logs, intervals }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('borma refresh: at start only when the export is older than refreshHours, then every refreshHours; the lookup gets the new data', async () => {
  const stale = setup({ ageHours: 7 })
  stale.refresher.start()
  await settle()
  assert.deepEqual([stale.runs.length, stale.reloads, stale.intervals.map(item => item.ms)], [1, [DATA], [6 * HOUR_MS]])
  assert.equal(stale.runs[0].rootDir, '/repo')
  assert.deepEqual(stale.logs.log, ['[borma] data refreshed: exported …, stock as of 2026-09-30 15:51 WIB'])
  stale.intervals[0].fn()
  await settle()
  assert.deepEqual([stale.runs.length, stale.reloads.length], [2, 2], 'the interval refreshes again')

  const fresh = setup({ ageHours: 1 })
  fresh.refresher.start()
  await settle()
  assert.deepEqual([fresh.runs.length, fresh.intervals.length], [0, 1], 'fresh at start: only the interval')
  const missing = setup({ ageHours: null })
  missing.refresher.start()
  await settle()
  assert.equal(missing.runs.length, 1, 'no file: refresh')

  const off = setup({ refreshHours: 0 })
  off.refresher.start()
  assert.deepEqual([off.runs.length, off.intervals.length], [0, 0], 'refreshHours 0: never')
  stale.refresher.stop()
  assert.equal(stale.intervals[0].cleared, true)
})

test('borma refresh: a failed export or unreadable files keep the old data with a warning, never a throw', async () => {
  const failed = setup({ run: async () => ({ ok: false, error: 'exit_1: Error: catalog failed: exit_1: Access Denied' }) })
  assert.equal(await failed.refresher.refresh(), false)
  assert.deepEqual([failed.reloads, failed.logs.warn], [[], ['[borma] data refresh failed (exit_1: Error: catalog failed: exit_1: Access Denied); keeping the data loaded before']])

  const thrown = setup({ run: async () => { throw new Error('boom') } })
  assert.equal(await thrown.refresher.refresh(), false)
  assert.match(thrown.logs.warn[0], /boom/)

  const unreadable = setup({ load: () => { throw new Error('Unexpected end of JSON input') } })
  assert.equal(await unreadable.refresher.refresh(), false)
  assert.deepEqual(unreadable.reloads, [])
  assert.match(unreadable.logs.warn[0], /could not be loaded \(Unexpected end of JSON input\)/)
})

test('borma refresh: one at a time; a refresh asked for while one runs joins it; stop aborts the running export', async () => {
  let finish
  const { refresher, runs, reloads } = setup({ run: () => new Promise(resolve => { finish = resolve }) })
  const first = refresher.refresh()
  const second = refresher.refresh()
  assert.equal(first, second)
  assert.equal(runs.length, 1)
  finish({ ok: true, summary: 'done' })
  assert.deepEqual([await first, reloads.length], [true, 1])
  refresher.refresh()
  assert.equal(runs.length, 2, 'the next one runs once the first is done')
  refresher.stop()
  assert.equal(runs[1].signal.aborted, true)
  finish({ ok: false, error: 'stopped' })
  assert.equal(reloads.length, 1)
})

// A fake child process: the real runExport spawns `node scripts/export-borma.js` without a shell.
function fakeSpawn (script) {
  const calls = []
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options })
    const child = new EventEmitter()
    child.pid = 999999999
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { child.killed = true }
    setImmediate(() => script(child))
    return child
  }
  return { spawn, calls }
}

test('runExport: node on the export script, no shell, no secrets in its env; the last line on success, the error line on failure', async () => {
  process.env.ANTHROPIC_API_KEY_TEST_ONLY = 'x'
  const ok = fakeSpawn(child => { child.stdout.end('catalog: 852 row(s)\nexported 2026-09-30T09:07:22Z, stock as of 2026-09-30 15:51 WIB\n'); child.emit('close', 0) })
  assert.deepEqual(await runExport({ rootDir: '/repo', spawn: ok.spawn }), { ok: true, summary: 'exported 2026-09-30T09:07:22Z, stock as of 2026-09-30 15:51 WIB' })
  const [call] = ok.calls
  assert.deepEqual([call.bin, call.args, call.options.shell, call.options.cwd], [process.execPath, ['/repo/scripts/export-borma.js'], false, '/repo'])
  assert.deepEqual(Object.keys(call.options.env).filter(key => !key.startsWith('CLOUDSDK_')).sort(), ['HOME', 'LANG', 'PATH'])
  delete process.env.ANTHROPIC_API_KEY_TEST_ONLY

  const failed = fakeSpawn(child => { child.stderr.end('file:///repo/scripts/export-borma.js:120\n  throw new Error(...)\n        ^\n\nError: catalog failed: timeout\n    at file:///repo/x.js:1:1\n'); child.emit('close', 1) })
  assert.deepEqual(await runExport({ rootDir: '/repo', spawn: failed.spawn }), { ok: false, error: 'exit_1: Error: catalog failed: timeout' })

  const hung = fakeSpawn(() => {})
  assert.deepEqual(await runExport({ rootDir: '/repo', spawn: hung.spawn, timeoutMs: 20 }), { ok: false, error: 'timeout' })
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await runExport({ rootDir: '/repo', spawn: hung.spawn, signal: aborted.signal }), { ok: false, error: 'stopped' })
})
