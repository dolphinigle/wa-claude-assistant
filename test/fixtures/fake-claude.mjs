#!/usr/bin/env node
// Stand-in for the `claude` binary in unit tests. It reads stdin like the real CLI and picks a scenario from a
// "SCENARIO:<name>" marker inside the message text, since the wrapper's env and argv are fixed.
import { writeFileSync } from 'node:fs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = Buffer.concat(chunks).toString('utf8')
const scenario = input.match(/SCENARIO:([a-z_]+)/)?.[1] ?? 'success'
const out = event => process.stdout.write(`${JSON.stringify(event)}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const init = {
  type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['StructuredOutput'], mcp_servers: [], skills: [], slash_commands: [],
  apiKeySource: 'none', model: 'claude-haiku-fake', claude_code_version: '0.0.0-fake'
}
const rateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', resetsAt: 1790419800, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1790419800 }, seven_day: { utilization: 0.24, resetsAt: 1790913600 } } }
}
const triage = { category: 'simple', confidence: 0.95, reply: 'Kami buka Senin–Sabtu pukul 08.00–17.00 WIB.', reason: 'hours question', facts_used: ['F1'], summary: 'asks opening hours' }
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.002, duration_ms: 1234, result: JSON.stringify(triage), structured_output: triage, ...extra })

switch (scenario) {
  case 'success':
    out(init); out(rateLimit); out({ type: 'assistant', message: { content: [] } }); out(result())
    break
  case 'echo':
    out(init); out(rateLimit)
    out(result({ structured_output: { ...triage, reply: input, reason: JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }) } }))
    break
  case 'slow': {
    const startedAt = Date.now()
    await sleep(150)
    out(init); out(rateLimit); out(result({ structured_output: { ...triage, reason: JSON.stringify({ startedAt, endedAt: Date.now() }) } }))
    break
  }
  case 'is_error':
    out(init); out({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'API Error: 500' })
    break
  case 'missing_structured':
    out(init); out(rateLimit); out({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: false, terminal_reason: 'structured_output_retry_exhausted' })
    break
  case 'invalid_output':
    out(init); out(rateLimit); out(result({ structured_output: { category: 'maybe', confidence: 2, reply: 'x' } }))
    break
  case 'bad_init_tools':
    out({ ...init, tools: ['StructuredOutput', 'Bash'] })
    await sleep(5000) // the wrapper must kill us long before this
    out(result())
    break
  case 'bad_init_apikey':
    out({ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }); out(rateLimit); out(result())
    break
  case 'nonzero_exit':
    out(init); out(rateLimit); out(result())
    process.exitCode = 3
    break
  case 'not_logged_in':
    out(init); out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    process.exitCode = 1
    break
  case 'timeout':
    out(init)
    setInterval(() => {}, 1000)
    break
  case 'garbage':
    process.stdout.write('this is not json\n')
    out(init); out(rateLimit)
    process.stdout.write(JSON.stringify(result())) // final line without a newline
    break
  case 'write_sandbox':
    writeFileSync('leaked.txt', 'x')
    out(init); out(rateLimit); out(result())
    break
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`)
    process.exitCode = 2
}
