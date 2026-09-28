// Read-only BigQuery through the `bq` CLI (Borma demo): spawned without a shell, with an args array, like
// src/brain/claude.js spawns claude. Values reach the SQL only as query parameters, never spliced into it.
import { spawn as nodeSpawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 20_000_000
const KILL_GRACE_MS = 1000

// The CLI's own configuration and credentials (gcloud) live under HOME; nothing else from the environment is needed.
const bqEnv = (parentEnv = process.env) => ({
  HOME: parentEnv.HOME,
  PATH: parentEnv.PATH,
  LANG: 'C.UTF-8',
  ...Object.fromEntries(Object.entries(parentEnv).filter(([key]) => key.startsWith('CLOUDSDK_')))
})

/** `--parameter` flags for scalar STRING or INT64 parameters. */
export function parameterFlags (params = {}) {
  return Object.entries(params).map(([name, value]) => {
    if (!/^\w+$/.test(name)) throw new Error(`bad parameter name ${name}`)
    if (Number.isInteger(value)) return `--parameter=${name}:INT64:${value}`
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`parameter ${name} must be a one-line string or an integer`)
    return `--parameter=${name}:STRING:${value}`
  })
}

export function buildBqArgs ({ sql, params, projectId, maxRows = 1000, dryRun = false }) {
  return [
    '--headless', '--quiet', '--format=json', `--project_id=${projectId}`,
    'query', '--use_legacy_sql=false', `--max_rows=${maxRows}`, ...(dryRun ? ['--dry_run'] : []),
    ...parameterFlags(params),
    sql
  ]
}

/**
 * Runs one query. Resolves `{ok: true, rows}` (or `{ok: true, bytes}` for a dry run), or `{ok: false, error}`: never
 * throws, so a caller in the message path can fall back to no facts.
 */
export function runBq ({ sql, params = {}, projectId, maxRows, dryRun = false, timeoutMs = 60_000, bin = 'bq', spawn = nodeSpawn }) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, buildBqArgs({ sql, params, projectId, maxRows, dryRun }), { env: bqEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (error) {
      resolve({ ok: false, error: `spawn_failed: ${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, KILL_GRACE_MS).unref?.()
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk })
    child.on('error', error => finish({ ok: false, error: `spawn_failed: ${error.message}` }))
    child.on('close', code => {
      // bq writes its errors to stdout too; only the first line goes into the error, never whole rows.
      if (code !== 0) return finish({ ok: false, error: `exit_${code}: ${(stderr || stdout).trim().split('\n')[0].slice(0, 300)}` })
      try {
        const parsed = JSON.parse(stdout.trim() || '[]')
        if (dryRun) return finish({ ok: true, bytes: Number(parsed.statistics?.totalBytesProcessed ?? NaN) })
        finish({ ok: true, rows: Array.isArray(parsed) ? parsed : [] })
      } catch (error) {
        finish({ ok: false, error: `bad_output: ${error.message}` })
      }
    })
  })
}
