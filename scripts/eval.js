// `npm run eval`: every fixture through the REAL brain (claude -p) + guards + policy, evaluated as if live.
// The number that matters is FORBIDDEN cases that would have auto-sent; it must be 0.
// Each fixture is one claude call. Use --only=id1,id2 to re-run a subset.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClaudeBrain } from '../src/brain/claude.js'
import { loadConfig, ROOT_DIR } from '../src/config.js'
import { guardTriage } from '../src/guards.js'
import { loadKnowledge } from '../src/knowledge.js'
import { excerpt } from '../src/owner.js'
import { decide } from '../src/policy.js'

const onlyArg = process.argv.find(arg => arg.startsWith('--only='))
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null
const fixtures = JSON.parse(readFileSync(path.join(ROOT_DIR, 'eval', 'fixtures.json'), 'utf8')).filter(fixture => !only || only.has(fixture.id))
if (fixtures.length === 0) throw new Error('no fixtures selected')

const config = loadConfig()
const knowledge = loadKnowledge(config.paths.knowledge)
const brain = createClaudeBrain({ config, knowledge })
const startedAt = new Date()
const nowSeconds = Math.floor(Date.now() / 1000)

console.log(`eval: ${fixtures.length} fixture(s), ${fixtures.length} claude call(s), concurrency ${config.claude.concurrency}, model ${config.claude.model}\n`)

const rows = await Promise.all(fixtures.map(async fixture => {
  const history = (fixture.history ?? []).map((item, index, all) => ({ ...item, timestamp: nowSeconds - 60 * (all.length - index) }))
  const result = await brain.triage({ chat: { name: fixture.name }, history, messages: [{ text: fixture.text, timestamp: nowSeconds }] })
  const guard = guardTriage(result.triage, { knowledge, config })
  // A fresh chat on a quiet day: only the triage, the guards and the quota can stop an auto-send.
  const decision = decide(result, {
    config,
    guard,
    paused: false,
    chat: { muted: false, blocked: false, takeoverUntil: 0 },
    now: Date.now(),
    chatAutoSendsLastHour: 0,
    autoSendsLastDay: 0,
    rateLimit: result.rateLimit,
    isBacklog: false
  })
  const category = result.triage?.category ?? `ERROR(${result.error})`
  const row = {
    fixture,
    result,
    guard,
    decision,
    category,
    categoryOk: fixture.expect.includes(category),
    forbiddenAutoSend: fixture.autoSend === 'forbidden' && decision.action === 'auto_send',
    allowedAutoSend: fixture.autoSend === 'allowed' && decision.action === 'auto_send'
  }
  console.log(`${row.forbiddenAutoSend ? '✗ FORBIDDEN AUTO-SEND' : row.categoryOk ? '✓' : '·'} ${fixture.id}: ${category} (${result.triage?.confidence ?? '-'}) → ${decision.action}`)
  return row
}))

const total = rows.length
const categoryCorrect = rows.filter(row => row.categoryOk).length
const forbidden = rows.filter(row => row.forbiddenAutoSend)
const allowedExpected = rows.filter(row => row.fixture.autoSend === 'allowed').length
const allowedActual = rows.filter(row => row.allowedAutoSend).length
const errors = rows.filter(row => !row.result.ok)
const latencies = rows.map(row => row.result.meta?.durationMs).filter(Number.isFinite)
const avgLatency = latencies.length ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) : 0
const maxLatency = latencies.length ? Math.max(...latencies) : 0
const cost = rows.reduce((sum, row) => sum + (row.result.meta?.costUsd ?? 0), 0)
const firstMeta = rows.find(row => row.result.meta?.model)?.result.meta ?? {}
const lastRate = rows.map(row => row.result.rateLimit).filter(Boolean).at(-1)

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const table = [
  '| # | fixture | expected | got | conf | auto-send | action | why not auto / guard | latency |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row, index) => `| ${index + 1} | ${row.fixture.id} | ${row.fixture.expect.join(' or ')} | ${row.categoryOk ? '' : '✗ '}${cell(row.category)} | ${row.result.triage?.confidence ?? '-'} | ${row.fixture.autoSend} | ${row.forbiddenAutoSend ? '**AUTO_SEND (violation)**' : row.decision.action} | ${cell(row.decision.reasons.filter(reason => !reason.startsWith('category:')).join(', '))} | ${((row.result.meta?.durationMs ?? 0) / 1000).toFixed(1)} s |`)
]
const summary = [
  `- Category accuracy: **${categoryCorrect}/${total}**`,
  `- FORBIDDEN cases that would have auto-sent: **${forbidden.length}** ${forbidden.length === 0 ? '(pass)' : `(FAIL: ${forbidden.map(row => row.fixture.id).join(', ')})`}`,
  `- ALLOWED cases that did auto-send: **${allowedActual}/${allowedExpected}** (a miss is safe: it becomes a draft)`,
  `- Triage errors: ${errors.length}${errors.length ? ` (${errors.map(row => `${row.fixture.id}: ${row.result.error}`).join('; ')})` : ''}`,
  `- Latency (spawn → exit): avg ${(avgLatency / 1000).toFixed(1)} s, max ${(maxLatency / 1000).toFixed(1)} s, with concurrency ${config.claude.concurrency}`,
  `- Client-side list-price estimate: $${cost.toFixed(4)} total (not billing; subscription quota is what is consumed)`,
  `- Quota after the run: 5 h ${lastRate?.fiveHourUtilization ?? '?'}, 7 d ${lastRate?.sevenDayUtilization ?? '?'} (${lastRate?.status ?? 'no rate_limit_event'})`
]
const details = rows.map(row => [
  `### ${row.fixture.id} — ${row.fixture.note}`,
  '',
  `Message: ${cell(excerpt(row.fixture.text, 240))}`,
  '',
  `- category ${row.category}, confidence ${row.result.triage?.confidence ?? '-'}, facts_used ${JSON.stringify(row.result.triage?.facts_used ?? [])}`,
  `- action **${row.decision.action}**; reasons: ${row.decision.reasons.join(', ')}`,
  row.guard ? `- guards: ${row.guard.ok ? 'pass' : row.guard.reasons.join(', ')}` : '- guards: not run (not simple)',
  `- reply: ${cell(row.result.triage?.reply || '(empty)')}`,
  `- reason: ${cell(row.result.triage?.reason ?? row.result.error)}`,
  ''
].join('\n'))

const report = [
  only ? '# Eval: partial re-run' : '# Eval: last full run',
  '',
  `Run ${startedAt.toISOString()}${only ? ` (subset: ${[...only].join(', ')})` : ''} · model \`${firstMeta.model ?? config.claude.model}\` · claude ${firstMeta.claudeCodeVersion ?? '?'} · ${total} real \`claude -p\` calls through \`src/brain/claude.js\`, then \`guards.js\` and \`policy.js\` evaluated as live mode on a fresh chat (min confidence ${config.autoSend.minConfidence}, quota limit ${config.quota.maxFiveHourUtilization}).`,
  '',
  '## Summary',
  '',
  ...summary,
  '',
  '## Results',
  '',
  ...table,
  '',
  '## Details',
  '',
  ...details
].join('\n')

// A subset re-run must not overwrite the last full run.
const outFile = only ? 'last-run-partial.md' : 'last-run.md'
writeFileSync(path.join(ROOT_DIR, 'eval', outFile), `${report}\n`)
console.log(`\n${summary.join('\n').replace(/\*\*/g, '')}\n\nwrote eval/${outFile}`)
process.exit(forbidden.length === 0 ? 0 : 1)
