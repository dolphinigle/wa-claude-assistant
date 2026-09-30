// Borma demo: the running bot keeps its shop data fresh (owner request 2026-09-30: a tester's answer gave yesterday's
// stock time). At start when data/borma/catalog.json is older than `borma.refreshHours`, then every
// `borma.refreshHours`, it runs the read-only export (scripts/export-borma.js, `npm run export`) as a child process,
// spawned without a shell, and swaps the new catalog and stores into the lookup. A failure keeps the data the bot has
// and logs a warning, never more; one refresh runs at a time.
import { spawn as nodeSpawn } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { loadBormaData } from './lookup.js'

const HOUR_MS = 60 * 60 * 1000
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000 // three queries of up to 3 min each, and their dry runs
const KILL_GRACE_MS = 1000

// The export needs only what bq needs (src/bq.js builds its own env from these): no Claude or other secrets.
const exportEnv = (parentEnv = process.env) => ({
  HOME: parentEnv.HOME,
  PATH: parentEnv.PATH,
  LANG: 'C.UTF-8',
  ...Object.fromEntries(Object.entries(parentEnv).filter(([key]) => key.startsWith('CLOUDSDK_')))
})

// What went wrong, in one line: the thrown Error's message, not node's stack or the source line it prints first.
const firstError = text => {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean)
  return (lines.find(line => /^\w*Error\b/.test(line)) ?? lines.at(-1) ?? '').slice(0, 300)
}

/**
 * Runs `node scripts/export-borma.js` in its own process group (a timeout or `signal` also stops its bq children).
 * Resolves `{ok: true, summary}` (the export's last line) or `{ok: false, error}`; never throws.
 */
export function runExport ({ rootDir, timeoutMs = EXPORT_TIMEOUT_MS, signal, spawn = nodeSpawn }) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ ok: false, error: 'stopped' })
    let child
    try {
      child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'export-borma.js')], { cwd: rootDir, env: exportEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (error) {
      resolve({ ok: false, error: `spawn_failed: ${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, KILL_GRACE_MS).unref?.()
    }
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => { stop(); finish({ ok: false, error: 'stopped' }) }
    const timer = setTimeout(() => { stop(); finish({ ok: false, error: 'timeout' }) }, timeoutMs)
    signal?.addEventListener('abort', onAbort)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    child.on('error', error => finish({ ok: false, error: `spawn_failed: ${error.message}` }))
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: `exit_${code}: ${firstError(stderr || stdout)}` })
      finish({ ok: true, summary: stdout.trim().split('\n').at(-1) ?? '' })
    })
  })
}

/**
 * @param {object} deps
 * @param {{rootDir: string, borma?: {refreshHours?: number}}} deps.config
 * @param {{reload: Function}} deps.lookup  createLookup()'s
 * @param {string} deps.dataDir  the directory whose borma/ the lookup was loaded from
 * @param {Function} [deps.run]  ({rootDir, signal}) → Promise<{ok, summary?, error?}>; runExport by default
 * @param {Function} [deps.load]  (dataDir) → {catalog, stores}; loadBormaData by default
 * @returns {{start: Function, stop: Function, refresh: () => Promise<boolean>}}
 */
export function createBormaRefresher ({ config, lookup, dataDir, run = runExport, load = loadBormaData, stat = statSync, now = () => Date.now(), logger = console, timers = globalThis }) {
  const everyMs = Number(config.borma?.refreshHours ?? 6) * HOUR_MS
  const catalogFile = path.join(dataDir, 'borma', 'catalog.json')
  let running = null
  let timer = null
  let stopped = false
  const abort = new AbortController()

  /** Resolves true when fresh data is in the lookup; a call while one runs gets that one. */
  function refresh () {
    if (running) return running
    running = (async () => {
      const result = await run({ rootDir: config.rootDir, signal: abort.signal })
      if (stopped) return false
      if (!result.ok) {
        logger.warn(`[borma] data refresh failed (${result.error}); keeping the data loaded before`)
        return false
      }
      try {
        lookup.reload(load(dataDir))
      } catch (error) {
        logger.warn(`[borma] data refresh wrote files that could not be loaded (${error.message}); keeping the data loaded before`)
        return false
      }
      logger.log(`[borma] data refreshed: ${result.summary}`)
      return true
    })().catch(error => {
      logger.warn(`[borma] data refresh failed (${error.message}); keeping the data loaded before`)
      return false
    }).finally(() => { running = null })
    return running
  }

  const ageMs = () => {
    try { return now() - stat(catalogFile).mtimeMs } catch { return Infinity }
  }

  return {
    refresh,
    /** `borma.refreshHours` 0 turns it off. */
    start () {
      if (!(everyMs > 0)) return
      if (ageMs() > everyMs) refresh()
      timer = timers.setInterval(() => { refresh() }, everyMs)
      timer?.unref?.()
    },
    stop () {
      stopped = true
      if (timer) timers.clearInterval(timer)
      abort.abort()
    }
  }
}
