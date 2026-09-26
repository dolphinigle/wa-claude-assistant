// The one place that talks to Claude: the locked `claude -p` command from docs/implementation-notes.md.
// Untrusted text reaches the child only through stdin; argv carries trusted flags, the prompt path and the schema.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../store.js'
import { buildUserTurn } from './prompt.js'

export const CATEGORIES = ['simple', 'complex', 'important', 'ignore']
const KILL_GRACE_MS = 5000
const EXIT_DRAIN_MS = 1000
const MAX_STDERR_CHARS = 4000

export function buildArgs ({ model, systemPromptFile, schemaJson }) {
  return [
    '-p', '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--setting-sources', '', '--strict-mcp-config',
    '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt-file', systemPromptFile,
    '--json-schema', schemaJson
  ]
}

// Explicit and minimal: nothing else from process.env is inherited, so ANTHROPIC_API_KEY can never switch billing.
export function buildEnv ({ maxStructuredOutputRetries }, parentEnv = process.env) {
  return {
    HOME: parentEnv.HOME,
    PATH: parentEnv.PATH,
    LANG: 'C.UTF-8',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    MAX_THINKING_TOKENS: '0',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1',
    MAX_STRUCTURED_OUTPUT_RETRIES: String(maxStructuredOutputRetries)
  }
}

const isEmptyArray = value => Array.isArray(value) && value.length === 0

/**
 * Returns the list of isolation violations in a system/init event; empty means isolated. Fails closed: a field the
 * CLI stops reporting (renamed or moved by an update) is a violation, not a pass.
 */
export function checkInit (init) {
  const violations = []
  if (!Array.isArray(init.tools) || init.tools.length !== 1 || init.tools[0] !== 'StructuredOutput') violations.push(`tools=${JSON.stringify(init.tools)}`)
  for (const field of ['mcp_servers', 'skills', 'slash_commands']) {
    if (!isEmptyArray(init[field])) violations.push(`${field}=${JSON.stringify(init[field])}`)
  }
  // Only the CLI's own plugins (agents-md, telemetry) may load; anything from a marketplace or a directory is out.
  if (!Array.isArray(init.plugins) || !init.plugins.every(plugin => /@builtin$/.test(plugin?.source ?? ''))) violations.push(`plugins=${JSON.stringify(init.plugins)}`)
  if (typeof init.claude_code_version !== 'string' || !init.claude_code_version) violations.push(`claude_code_version=${JSON.stringify(init.claude_code_version)}`)
  if (init.apiKeySource !== 'none') violations.push(`apiKeySource=${JSON.stringify(init.apiKeySource)}`)
  return violations
}

/** Our own check of the structured output, so a schema drift in the CLI can never reach the policy. */
export function validateTriage (value) {
  const errors = []
  if (value === null || typeof value !== 'object') return ['not an object']
  if (!CATEGORIES.includes(value.category)) errors.push('category')
  if (typeof value.confidence !== 'number' || !(value.confidence >= 0 && value.confidence <= 1)) errors.push('confidence')
  for (const key of ['reply', 'reason', 'summary']) if (typeof value[key] !== 'string') errors.push(key)
  if (!Array.isArray(value.facts_used) || !value.facts_used.every(id => typeof id === 'string')) errors.push('facts_used')
  return errors
}

export function parseRateLimit (info) {
  if (!info) return undefined
  return {
    status: info.status,
    fiveHourUtilization: info.unifiedWindows?.five_hour?.utilization,
    sevenDayUtilization: info.unifiedWindows?.seven_day?.utilization,
    resetsAt: info.resetsAt
  }
}

function createLimiter (concurrency) {
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= concurrency || waiting.length === 0) return
    active++
    const { task, resolve, reject } = waiting.shift()
    task().then(resolve, reject).finally(() => { active--; next() })
  }
  const limit = task => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next() })
  /** Settles every queued task with `settle()` instead of running it. */
  limit.drain = settle => { for (const { resolve } of waiting.splice(0)) resolve(settle()) }
  return limit
}

/**
 * Renders prompts/triage-system.md with the knowledge injected; returns the written file path. The name is the
 * content's hash and the write is atomic: `npm start`, selftest and eval share data/, and a selftest after editing
 * knowledge.md must not change (or half-write) the prompt the running bot's guards were built against.
 */
export function renderSystemPrompt ({ promptsDir, outDir, knowledgeText }) {
  const template = readFileSync(path.join(promptsDir, 'triage-system.md'), 'utf8')
  if (!template.includes('{{KNOWLEDGE}}')) throw new Error('triage-system.md must contain {{KNOWLEDGE}}')
  const prompt = template.replace('{{KNOWLEDGE}}', () => knowledgeText)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const file = path.join(outDir, `triage-system.${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}.txt`)
  writeFileAtomic(file, prompt)
  return file
}

/**
 * @returns {{ triage: (input: {chat, history, messages}) => Promise<{ok: boolean, triage?: object, error?: string, rateLimit?: object, meta: object}> }}
 */
export function createClaudeBrain ({ config, knowledge, spawn = nodeSpawn, now = () => Date.now(), logger = console, killGraceMs = KILL_GRACE_MS }) {
  const claude = config.claude
  const dataDir = config.paths.data
  const sandboxDir = path.join(dataDir, 'claude-sandbox')
  mkdirSync(sandboxDir, { recursive: true, mode: 0o700 })
  const systemPromptFile = renderSystemPrompt({ promptsDir: config.paths.prompts, outDir: path.join(dataDir, 'prompt'), knowledgeText: knowledge.promptText })
  const schemaJson = JSON.stringify(JSON.parse(readFileSync(path.join(config.paths.prompts, 'triage-schema.json'), 'utf8')))
  const args = buildArgs({ model: claude.model, systemPromptFile, schemaJson })
  const limit = createLimiter(Math.max(1, claude.concurrency ?? 1))
  const running = new Set() // kill functions of the calls whose child is alive
  let closed = false
  // A result nobody will act on; the message stays in the assistant's inbox and is triaged after the restart.
  const shuttingDown = () => ({ ok: false, error: 'shutting_down', meta: { durationMs: 0 } })

  function run (stdinText) {
    return new Promise(resolve => {
      if (closed) {
        resolve(shuttingDown())
        return
      }
      const startedAt = now()
      const meta = { startedAt }
      let init
      let result
      let rateLimit
      let stdoutBuffer = ''
      let stderr = ''
      let failure
      let settled = false
      let killTimer
      let forceTimer
      let drainTimer

      // A non-empty sandbox means something wrote into Claude's cwd; refuse rather than let it be read.
      const leftovers = readdirSync(sandboxDir)
      if (leftovers.length > 0) {
        resolve({ ok: false, error: `sandbox_not_empty: ${leftovers.slice(0, 5).join(', ')}`, meta: { durationMs: 0 } })
        return
      }

      let child
      try {
        // Its own process group: a timeout or shutdown then also reaches whatever it started (a wrapper script that
        // does not exec, a helper process), which would otherwise keep stdout open and the call pending.
        child = spawn(claude.bin, args, { cwd: sandboxDir, env: buildEnv(claude), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true })
      } catch (error) {
        resolve({ ok: false, error: `spawn_failed: ${error.message}`, meta: { durationMs: 0 } })
        return
      }

      const signalGroup = signal => {
        try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} }
      }
      // Settles without waiting for 'close', which needs every holder of the pipes (descendants included) to exit.
      const abandon = (exitCode = child.exitCode, signal = child.signalCode ?? 'SIGKILL') => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(exitCode, signal)
      }
      const kill = reason => {
        failure ??= reason
        if (settled) return
        signalGroup('SIGTERM')
        killTimer ??= setTimeout(() => {
          signalGroup('SIGKILL')
          forceTimer = setTimeout(abandon, EXIT_DRAIN_MS) // held by a process outside the group
        }, killGraceMs)
      }
      running.add(kill)
      const timeout = setTimeout(() => kill('timeout'), claude.timeoutMs)

      const handleLine = line => {
        if (!line.trim()) return
        let event
        try { event = JSON.parse(line) } catch { return }
        if (!event || typeof event !== 'object') return // e.g. a bare `null` line
        if (event.type === 'system' && event.subtype === 'init') {
          init = event
          meta.model = event.model
          meta.claudeCodeVersion = event.claude_code_version
          const violations = checkInit(event)
          if (violations.length > 0) kill(`isolation_assertion_failed: ${violations.join('; ')}`)
        } else if (event.type === 'rate_limit_event') {
          rateLimit = parseRateLimit(event.rate_limit_info)
        } else if (event.type === 'result') {
          result = event
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdoutBuffer += chunk
        let newline
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newline)
          stdoutBuffer = stdoutBuffer.slice(newline + 1) // before handling, so a line is never handled twice
          handleLine(line)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length) })
      // EPIPE when the child dies before reading stdin is reported through 'close'; don't crash on it.
      child.stdin.on('error', () => {})

      const settle = (exitCode, signal) => {
        if (stdoutBuffer) handleLine(stdoutBuffer)
        Object.assign(meta, {
          durationMs: now() - startedAt,
          exitCode,
          signal,
          costUsd: result?.total_cost_usd,
          apiDurationMs: result?.duration_ms,
          numTurns: result?.num_turns
        })
        const resultText = typeof result?.result === 'string' ? result.result : ''
        let error = failure
        // Only on failure: a successful reply may legitimately quote a customer saying "not logged in".
        const failed = exitCode !== 0 || !result || result.is_error !== false
        if (!error && failed && /not logged in/i.test(`${resultText}\n${stderr}`)) error = 'not_logged_in'
        if (!error && exitCode !== 0) error = `exit_${exitCode ?? signal}`
        if (!error && !init) error = 'no_init_event'
        if (!error && !result) error = 'no_result_event'
        if (!error && result.is_error !== false) error = `is_error: ${result.terminal_reason ?? result.subtype ?? ''} ${resultText.slice(0, 200)}`.trim()
        if (!error && (result.structured_output === undefined || result.structured_output === null)) error = 'missing_structured_output'
        if (!error) {
          const invalid = validateTriage(result.structured_output)
          if (invalid.length > 0) error = `invalid_structured_output: ${invalid.join(', ')}`
        }
        if (error) {
          if (stderr.trim()) meta.stderr = stderr.trim().slice(0, 500)
          logger.warn?.(`[claude] triage failed: ${error}`)
          resolve({ ok: false, error, rateLimit, meta })
          return
        }
        resolve({ ok: true, triage: result.structured_output, rateLimit, meta })
      }

      // Must always resolve: an unsettled triage would also hold its limiter slot forever.
      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        running.delete(kill)
        for (const timer of [timeout, killTimer, forceTimer, drainTimer]) clearTimeout(timer)
        try {
          settle(exitCode, signal)
        } catch (error) {
          resolve({ ok: false, error: `internal: ${error.message}`, rateLimit, meta })
        }
      }

      child.on('error', error => { failure ??= `spawn_failed: ${error.message}`; finish(null, null) })
      // The child exited but something it started still holds its stdout: stop that and settle with what was read.
      child.on('exit', (code, signal) => {
        drainTimer = setTimeout(() => { signalGroup('SIGKILL'); abandon(code, signal) }, EXIT_DRAIN_MS)
      })
      child.on('close', (code, signal) => finish(code, signal))
      child.stdin.end(stdinText)
    })
  }

  return {
    name: `claude-cli:${claude.model}`,
    systemPromptFile,
    sandboxDir,
    async triage ({ chat, history = [], messages }) {
      const stdinText = buildUserTurn({
        chat,
        history,
        messages,
        now: Math.floor(now() / 1000),
        timeZone: config.timezone,
        contextMessages: config.contextMessages
      })
      if (closed) return shuttingDown()
      return limit(() => run(stdinText))
    },
    /** Shutdown: queued calls never spawn, running ones are killed; every triage() resolves with an error. */
    close () {
      closed = true
      limit.drain(shuttingDown)
      for (const kill of running) kill('shutting_down')
    }
  }
}
