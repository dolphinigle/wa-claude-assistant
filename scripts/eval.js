// `npm run eval`: every fixture through the REAL brain (claude -p) + guards + policy, evaluated as if live.
// The number that matters is FORBIDDEN cases that would have auto-sent; it must be 0.
// Each fixture is one claude call. --only=id1,id2 re-runs a subset (written to last-run-partial.*).
// --rescore=eval/last-run.json re-applies the CURRENT guards and policy to saved triage results: no claude calls.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClaudeBrain, DECISIONS } from '../src/brain/claude.js'
import { loadConfig, ROOT_DIR } from '../src/config.js'
import { guardTriage } from '../src/guards.js'
import { loadKnowledge } from '../src/knowledge.js'
import { excerpt } from '../src/owner.js'
import { decide } from '../src/policy.js'

const argValue = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const only = argValue('only') ? new Set(argValue('only').split(',')) : null
const rescoreFile = argValue('rescore')
const saved = rescoreFile ? JSON.parse(readFileSync(path.resolve(rescoreFile), 'utf8')) : null
const selected = id => (saved ? saved.results.some(item => item.id === id) : !only || only.has(id))
const fixtures = JSON.parse(readFileSync(path.join(ROOT_DIR, 'eval', 'fixtures.json'), 'utf8')).filter(fixture => selected(fixture.id))
if (fixtures.length === 0) throw new Error('no fixtures selected')
const badFixture = fixtures.find(fixture => !DECISIONS.includes(fixture.expect) || !['allowed', 'forbidden'].includes(fixture.autoSend))
if (badFixture) throw new Error(`fixture ${badFixture.id}: expect must be one of ${DECISIONS.join('/')} and autoSend allowed/forbidden`)
// Results saved before the binary decision have no `decision`; rescoring them would report every case as escalated.
if (saved?.results.some(item => item.result.triage && !('decision' in item.result.triage))) throw new Error(`${rescoreFile} predates the answer/escalate schema; run npm run eval instead`)

const config = loadConfig()
const knowledge = loadKnowledge(config.paths.knowledge)
const startedAt = saved ? new Date(saved.runAt) : new Date()
const baseName = saved ? path.basename(rescoreFile, '.json') : only ? 'last-run-partial' : 'last-run'
const outDir = saved ? path.dirname(path.resolve(rescoreFile)) : path.join(ROOT_DIR, 'eval')
// History one minute apart, or `minutesAgo` for an older message (a closing from yesterday); `autoReply` marks the
// bot's own replies. The same ages go to Claude and, at scoring time, to the policy.
const timedHistory = (fixture, nowSeconds) =>
  (fixture.history ?? []).map((item, index, all) => ({ ...item, timestamp: nowSeconds - 60 * (item.minutesAgo ?? all.length - index) }))

async function collect () {
  const brain = createClaudeBrain({ config, knowledge })
  const nowSeconds = Math.floor(Date.now() / 1000)
  console.log(`eval: ${fixtures.length} fixture(s), ${fixtures.length} claude call(s), concurrency ${config.claude.concurrency}, model ${config.claude.model}\n`)
  return Promise.all(fixtures.map(async fixture => {
    const result = await brain.triage({ chat: { name: fixture.name }, history: timedHistory(fixture, nowSeconds), messages: [{ text: fixture.text, timestamp: nowSeconds }] })
    return { id: fixture.id, result }
  }))
}

const results = saved ? saved.results : await collect()
if (saved) console.log(`rescore: ${results.length} saved triage result(s) from ${rescoreFile}, current guards and policy, no claude calls\n`)
else writeFileSync(path.join(outDir, `${baseName}.json`), `${JSON.stringify({ runAt: startedAt.toISOString(), results }, null, 1)}\n`)

const rows = fixtures.map(fixture => {
  const { result } = results.find(item => item.id === fixture.id)
  const guard = guardTriage(result.triage, { knowledge, config, incomingText: fixture.text })
  // A quiet day with no open drafts: only the triage, the guards, the fixture's history and the quota can stop an
  // auto-send (or skip a thanks that follows a closing).
  const now = Date.now()
  const decision = decide(result, {
    config,
    guard,
    incomingText: fixture.text,
    attachments: [],
    quoted: [],
    history: timedHistory(fixture, Math.floor(now / 1000)),
    paused: false,
    chat: { muted: false, blocked: false, takeoverUntil: 0, openDrafts: [], lastClosingAt: 0 },
    now,
    chatAutoSendsLastHour: 0,
    autoSendsLastDay: 0,
    rateLimit: result.rateLimit,
    isBacklog: false
  })
  const got = result.triage?.decision ?? `ERROR(${result.error})`
  const row = {
    fixture,
    result,
    guard,
    decision,
    got,
    decisionOk: got === fixture.expect,
    forbiddenAutoSend: fixture.autoSend === 'forbidden' && decision.action === 'auto_send',
    allowedAutoSend: fixture.autoSend === 'allowed' && decision.action === 'auto_send'
  }
  console.log(`${row.forbiddenAutoSend ? '✗ FORBIDDEN AUTO-SEND' : row.decisionOk ? '✓' : '·'} ${fixture.id}: ${got} → ${decision.action}`)
  return row
})

const total = rows.length
const decisionCorrect = rows.filter(row => row.decisionOk).length
const forbidden = rows.filter(row => row.forbiddenAutoSend)
const allowedExpected = rows.filter(row => row.fixture.autoSend === 'allowed').length
const allowedActual = rows.filter(row => row.allowedAutoSend).length
const errors = rows.filter(row => !row.result.ok)
const latencies = rows.map(row => row.result.meta?.durationMs).filter(Number.isFinite)
const avgLatency = latencies.length ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) : 0
const maxLatency = latencies.length ? Math.max(...latencies) : 0
const thinking = config.claude.maxThinkingTokens === 0 ? 'off' : config.claude.maxThinkingTokens === null ? 'CLI default' : `MAX_THINKING_TOKENS=${config.claude.maxThinkingTokens}`
const cost = rows.reduce((sum, row) => sum + (row.result.meta?.costUsd ?? 0), 0)
const firstMeta = rows.find(row => row.result.meta?.model)?.result.meta ?? {}
const lastRate = rows.map(row => row.result.rateLimit).filter(Boolean).at(-1)

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const gateReasons = row => row.decision.reasons.filter(reason => !reason.startsWith('decision:') && reason !== 'all_gates_passed')
const table = [
  '| # | fixture | expected | got | auto-send | action | gates that held an answer | latency |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((row, index) => `| ${index + 1} | ${row.fixture.id} | ${row.fixture.expect} | ${row.decisionOk ? '' : '✗ '}${cell(row.got)} | ${row.fixture.autoSend} | ${row.forbiddenAutoSend ? '**AUTO_SEND (violation)**' : row.decision.action} | ${cell(gateReasons(row).join(', '))} | ${((row.result.meta?.durationMs ?? 0) / 1000).toFixed(1)} s |`)
]
const summary = [
  `- Decision accuracy: **${decisionCorrect}/${total}**`,
  `- FORBIDDEN cases that would have auto-sent: **${forbidden.length}** ${forbidden.length === 0 ? '(pass)' : `(FAIL: ${forbidden.map(row => row.fixture.id).join(', ')})`}`,
  `- ALLOWED cases that did auto-send: **${allowedActual}/${allowedExpected}** (a miss is safe: it becomes a draft)`,
  `- Skipped (a thanks after our own closing: no reply, no draft): ${rows.filter(row => row.decision.action === 'skip').length}`,
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
  `- decision ${row.got}, facts_used ${JSON.stringify(row.result.triage?.facts_used ?? [])}`,
  `- action **${row.decision.action}**; reasons: ${row.decision.reasons.join(', ')}`,
  row.guard ? `- guards: ${row.guard.ok ? 'pass' : row.guard.reasons.join(', ')}` : '- guards: not run (escalated)',
  `- reply: ${cell(row.result.triage?.reply || '(empty)')}`,
  `- reason: ${cell(row.result.triage?.reason ?? row.result.error)}`,
  `- summary: ${cell(row.result.triage?.summary ?? '-')}`,
  ''
].join('\n'))

const report = [
  baseName === 'last-run' ? '# Eval: last full run' : '# Eval: partial re-run',
  '',
  ...(saved ? [`> Rescored ${new Date().toISOString()} with the current guards and policy from the saved triage results (no new claude calls).`, ''] : []),
  `Run ${startedAt.toISOString()}${baseName === 'last-run' ? '' : ` (subset: ${fixtures.map(fixture => fixture.id).join(', ')})`} · model \`${firstMeta.model ?? config.claude.model}\` (alias \`${config.claude.model}\`, thinking ${thinking}) · claude ${firstMeta.claudeCodeVersion ?? '?'} · ${total} ${saved ? 'saved' : 'real'} \`claude -p\` results from \`src/brain/claude.js\`, then \`guards.js\` and \`policy.js\` evaluated as live mode on a fresh chat (quota limit ${config.quota.maxFiveHourUtilization}).`,
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
const outFile = `${baseName}.md`
writeFileSync(path.join(outDir, outFile), `${report}\n`)
console.log(`\n${summary.join('\n').replace(/\*\*/g, '')}\n\nwrote ${path.relative(ROOT_DIR, path.join(outDir, outFile))}`)
process.exit(forbidden.length === 0 ? 0 : 1)
