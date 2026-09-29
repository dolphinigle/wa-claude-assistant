// `npm run eval`: every fixture through the REAL brain (claude -p) + guards + policy, evaluated as if live.
// The numbers that matter are FORBIDDEN cases that would have auto-sent, escalations the policy skipped, and placeholders
// ("🤖 " + Claude's holding reply) that would have gone to a FORBIDDEN case (family, spam, a thanks …); all must be 0.
// Claude's greeting-back to a greeting alone is an auto-send like any other. The report lists every holding reply
// Claude wrote, whether it passed its guard, and how many were distinct (owner decision 2026-09-28: no fixed texts).
// Each fixture is one claude call. --only=id1,id2 re-runs a subset (written to last-run-partial.*).
// --rescore=eval/last-run.json re-applies the CURRENT guards and policy to saved triage results: no claude calls.
// The fixtures are written against the made-up bakery in eval/knowledge.md, whatever knowledge.md holds.
// --borma runs eval/fixtures-borma.json against knowledge.md and the Borma export's catalog lookup (no order lookup);
// its reports hold real shop data, so they go to data/borma/ (gitignored), not eval/. A Borma fixture with `demo: true`
// runs as the testers see it: demo prompt, demo guards and policy (the order and suggestion flows exist only there).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClaudeBrain, DECISIONS } from '../src/brain/claude.js'
import { loadConfig, ROOT_DIR } from '../src/config.js'
import { guardGreeting, guardHolding, guardTriage } from '../src/guards.js'
import { loadKnowledge } from '../src/knowledge.js'
import { createLookup, loadBormaData, withLookup } from '../src/lookup.js'
import { excerpt } from '../src/owner.js'
import { decide } from '../src/policy.js'

const argValue = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const only = argValue('only') ? new Set(argValue('only').split(',')) : null
const rescoreFile = argValue('rescore')
const saved = rescoreFile ? JSON.parse(readFileSync(path.resolve(rescoreFile), 'utf8')) : null
const selected = id => (saved ? saved.results.some(item => item.id === id) : !only || only.has(id))
const borma = process.argv.includes('--borma') || Boolean(saved?.borma)
const fixtures = JSON.parse(readFileSync(path.join(ROOT_DIR, 'eval', borma ? 'fixtures-borma.json' : 'fixtures.json'), 'utf8')).filter(fixture => selected(fixture.id))
if (fixtures.length === 0) throw new Error('no fixtures selected')
const badFixture = fixtures.find(fixture => !DECISIONS.includes(fixture.expect) || !['allowed', 'forbidden'].includes(fixture.autoSend) ||
  !['allowed', 'forbidden'].includes(fixture.placeholder) ||
  !['boolean', 'undefined'].includes(typeof fixture.skipOk) || !['number', 'undefined'].includes(typeof fixture.closingMinutesAgo) ||
  !['boolean', 'undefined'].includes(typeof fixture.demo) || (fixture.demo && !borma))
if (badFixture) throw new Error(`fixture ${badFixture.id}: expect must be one of ${DECISIONS.join('/')}, autoSend and placeholder allowed/forbidden, skipOk and demo booleans (demo only with --borma) and closingMinutesAgo a number if set`)
// Results saved before the binary decision have no `decision`; rescoring them would report every case as escalated.
if (saved?.results.some(item => item.result.triage && !('decision' in item.result.triage))) throw new Error(`${rescoreFile} predates the answer/escalate schema; run npm run eval instead`)
// Results saved before customer_waiting existed count as "not waiting": no placeholder is ever sent, which is safe but says nothing.
const predatesPlaceholder = Boolean(saved?.results.some(item => item.result.triage && !('customer_waiting' in item.result.triage)))
if (predatesPlaceholder) console.warn(`${rescoreFile} predates customer_waiting: every placeholder counts as withheld\n`)
// Results saved before holding_reply existed have none: no placeholder can go out (holding_reply:empty).
const predatesHolding = Boolean(saved?.results.some(item => item.result.triage && !('holding_reply' in item.result.triage)))
if (predatesHolding) console.warn(`${rescoreFile} predates holding_reply: every placeholder counts as withheld (holding_reply:empty)\n`)

const config = loadConfig()
// config.local.json may cut the history for a live test (contextMessages 0); the fixtures' histories must still reach
// Claude, or the fixtures that depend on them test nothing.
const historyNeeded = Math.max(...fixtures.map(fixture => fixture.history?.length ?? 0))
if (!saved && config.contextMessages < historyNeeded) {
  console.warn(`eval: contextMessages ${config.contextMessages} (config.local.json) would hide the fixtures' histories; using ${historyNeeded}\n`)
  config.contextMessages = historyNeeded
}
// Nor may it switch off what the hard gates test: with auto-replies or the placeholder off, every row passes its gate
// without testing anything (consistency-r1-3).
for (const [name, section] of [['autoSend', config.autoSend], ['placeholder', config.placeholder], ['greetingReply', config.greetingReply]]) {
  if (section.enabled === true) continue
  console.warn(`eval: ${name}.enabled ${section.enabled} (config.local.json) would make its gate test nothing; using true\n`)
  section.enabled = true
}
// The fixtures hold the real rules: demo mode answers on purpose what they expect escalated.
if (config.demo.enabled) {
  console.warn('eval: demo.enabled true (config.local.json) invents answers the fixtures expect escalated; using false\n')
  config.demo.enabled = false
}
const knowledge = loadKnowledge(borma ? config.paths.knowledge : path.join(ROOT_DIR, 'eval', 'knowledge.md'))
// The catalog and stores only: an eval has no chat, so no phone and no order lookup. The guards run as in the demo's
// strict mode (demo off, forced above), with the lookup's facts added.
if (borma) config.borma = { ...config.borma, enabled: true, orders: false }
const lookup = borma && !saved ? createLookup({ config, ...loadBormaData(config.paths.data) }) : undefined
// The testers' demo mode, for the fixtures that ask for it (their guards and policy too).
const demoConfig = { ...config, demo: { ...config.demo, enabled: true } }
const configFor = fixture => (fixture.demo ? demoConfig : config)
const startedAt = saved ? new Date(saved.runAt) : new Date()
const baseName = saved ? path.basename(rescoreFile, '.json') : `${borma ? 'borma-' : ''}${only ? 'last-run-partial' : 'last-run'}`
const outDir = saved ? path.dirname(path.resolve(rescoreFile)) : borma ? path.join(config.paths.data, 'borma') : path.join(ROOT_DIR, 'eval')
mkdirSync(outDir, { recursive: true })
// History one minute apart, or `minutesAgo` for an older message (a closing from yesterday); `closing` marks our reply
// sent as the owner's /ok of a thanks draft, and `closingMinutesAgo` is when the thanks it closed arrived. The same ages
// go to Claude and, at scoring time, to the policy; Claude never sees the `closing` flags.
const timedHistory = (fixture, nowSeconds) =>
  (fixture.history ?? []).map((item, index, all) => ({ ...item, timestamp: nowSeconds - 60 * (item.minutesAgo ?? all.length - index) }))

async function collect () {
  const brain = createClaudeBrain({ config, knowledge })
  const demoBrain = fixtures.some(fixture => fixture.demo) ? createClaudeBrain({ config: demoConfig, knowledge }) : undefined
  const nowSeconds = Math.floor(Date.now() / 1000)
  console.log(`eval: ${fixtures.length} fixture(s), ${fixtures.length} claude call(s), concurrency ${config.claude.concurrency}, model ${config.claude.model}\n`)
  return Promise.all(fixtures.map(async fixture => {
    // As live: the recent conversation's products too (an order summary names them several messages on).
    const found = lookup ? await lookup.forBurst({ text: fixture.text, recentTexts: (fixture.history ?? []).map(item => item.text) }) : undefined
    const result = await (fixture.demo ? demoBrain : brain).triage({ chat: { name: fixture.name }, history: timedHistory(fixture, nowSeconds), messages: [{ text: fixture.text, timestamp: nowSeconds }], lookup: found })
    return { id: fixture.id, result, ...(found && { lookup: { facts: [...found.facts], lines: found.lines, notes: found.notes } }) }
  }))
}

const results = saved ? saved.results : await collect()
if (saved) console.log(`rescore: ${results.length} saved triage result(s) from ${rescoreFile}, current guards and policy, no claude calls\n`)
else writeFileSync(path.join(outDir, `${baseName}.json`), `${JSON.stringify({ runAt: startedAt.toISOString(), contextMessages: config.contextMessages, ...(borma && { borma: true }), results }, null, 1)}\n`)
// How much of each fixture's history Claude was given in the run whose results these are (unknown in older saves).
const contextMessages = saved ? saved.contextMessages : config.contextMessages
const historyNote = contextMessages === undefined ? 'fixture history given to Claude: not recorded'
  : `fixture history given to Claude: up to ${contextMessages} message(s)${contextMessages < historyNeeded ? ` (**less than the ${historyNeeded} the fixtures have: those fixtures ran without their history**)` : ''}`

const rows = fixtures.map(fixture => {
  const { result, lookup: looked } = results.find(item => item.id === fixture.id)
  const found = looked && { ...looked, facts: new Map(looked.facts) }
  const config = configFor(fixture)
  const guard = guardTriage(result.triage, { knowledge: withLookup(knowledge, found), config, incomingText: fixture.text })
  const holdingGuard = guardHolding(result.triage, { knowledge: withLookup(knowledge, found), config, incomingText: fixture.text })
  const greetingGuard = guardGreeting(result.triage, { knowledge: withLookup(knowledge, found), config, incomingText: fixture.text })
  // A quiet day: only the triage, the guards, the fixture's history and closing, and the quota can stop an auto-send
  // (or skip a thanks that follows a closing).
  const now = Date.now()
  const decision = decide(result, {
    config,
    guard,
    holdingGuard,
    greetingGuard,
    incomingText: fixture.text,
    attachments: [],
    quoted: [],
    history: timedHistory(fixture, Math.floor(now / 1000)),
    paused: false,
    chat: { muted: false, blocked: false, takeoverUntil: 0, lastClosingAt: fixture.closingMinutesAgo === undefined ? 0 : now - fixture.closingMinutesAgo * 60_000 },
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
    holdingGuard,
    greetingGuard,
    decision,
    got,
    decisionOk: got === fixture.expect,
    forbiddenAutoSend: fixture.autoSend === 'forbidden' && decision.action === 'auto_send',
    // A skip reaches nobody: an escalation it swallows is lost unless the fixture says a skip is fine there.
    skippedEscalation: fixture.expect === 'escalate' && decision.action === 'skip' && !fixture.skipOk,
    allowedAutoSend: fixture.autoSend === 'allowed' && decision.action === 'auto_send',
    // A placeholder tells the sender to wait for the owner: never to family, friends, spam, manipulation or a thanks.
    forbiddenPlaceholder: fixture.placeholder === 'forbidden' && decision.placeholder,
    allowedPlaceholder: fixture.placeholder === 'allowed' && decision.placeholder
  }
  const mark = row.forbiddenAutoSend ? '✗ FORBIDDEN AUTO-SEND' : row.skippedEscalation ? '✗ SKIPPED ESCALATION' : row.forbiddenPlaceholder ? '✗ FORBIDDEN PLACEHOLDER' : row.decisionOk ? '✓' : '·'
  console.log(`${mark} ${fixture.id}: ${got} → ${decision.action}${decision.greeting ? ' (greeting-back)' : ''}${decision.placeholder ? ' + placeholder' : ''}`)
  return row
})

const total = rows.length
const decisionCorrect = rows.filter(row => row.decisionOk).length
const forbidden = rows.filter(row => row.forbiddenAutoSend)
const skippedEscalations = rows.filter(row => row.skippedEscalation)
const allowedExpected = rows.filter(row => row.fixture.autoSend === 'allowed').length
const allowedActual = rows.filter(row => row.allowedAutoSend).length
const greetingBacks = rows.filter(row => row.decision.greeting).length
const forbiddenPlaceholders = rows.filter(row => row.forbiddenPlaceholder)
// The policy's own backstops (a thanks, no_words, tag_like) hide what Claude said: this shows whether the prompt keeps
// customer_waiting false on the FORBIDDEN cases by itself.
const flaggedForbidden = rows.filter(row => row.fixture.placeholder === 'forbidden' && row.result.triage?.customer_waiting === true)
// An allowed case that auto-sends gets its answer instead: only its escalation should get a placeholder.
const placeholdersExpected = rows.filter(row => row.fixture.placeholder === 'allowed' && row.decision.action === 'escalate').length
const placeholdersActual = rows.filter(row => row.allowedPlaceholder).length
// Escalations Claude flagged waiting: each should carry a holding reply for this sender that passes its guard.
const waitingEscalations = rows.filter(row => row.decision.action === 'escalate' && row.result.triage?.customer_waiting === true)
const holdingTexts = waitingEscalations.map(row => row.result.triage.holding_reply?.trim()).filter(Boolean)
const holdingPassed = waitingEscalations.filter(row => row.holdingGuard?.ok).length
const errors = rows.filter(row => !row.result.ok)
const latencies = rows.map(row => row.result.meta?.durationMs).filter(Number.isFinite)
const avgLatency = latencies.length ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length) : 0
const maxLatency = latencies.length ? Math.max(...latencies) : 0
const thinking = config.claude.maxThinkingTokens === 0 ? 'off' : config.claude.maxThinkingTokens === null ? 'CLI default' : `MAX_THINKING_TOKENS=${config.claude.maxThinkingTokens}`
const cost = rows.reduce((sum, row) => sum + (row.result.meta?.costUsd ?? 0), 0)
const firstMeta = rows.find(row => row.result.meta?.model)?.result.meta ?? {}
const lastRate = rows.map(row => row.result.rateLimit).filter(Boolean).at(-1)

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const gateReasons = row => row.decision.reasons.filter(reason => !reason.startsWith('decision:') && reason !== 'all_gates_passed' && reason !== 'greeting_reply')
const actionCell = row => `${row.decision.action}${row.decision.greeting ? ' (greeting-back)' : ''}`
const placeholderCell = row => `${row.fixture.placeholder}: ${row.forbiddenPlaceholder ? '**SENT (violation)**' : row.decision.placeholder ? 'sent' : 'none'}`
const table = [
  '| # | fixture | expected | got | auto-send | action | placeholder | gates that held an answer | latency |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row, index) => `| ${index + 1} | ${row.fixture.id} | ${row.fixture.expect} | ${row.decisionOk ? '' : '✗ '}${cell(row.got)} | ${row.fixture.autoSend} | ${row.forbiddenAutoSend ? `**${actionCell(row).toUpperCase()} (violation)**` : row.skippedEscalation ? '**SKIP (violation)**' : actionCell(row)} | ${placeholderCell(row)} | ${cell(gateReasons(row).join(', '))} | ${((row.result.meta?.durationMs ?? 0) / 1000).toFixed(1)} s |`)
]
const summary = [
  `- Decision accuracy: **${decisionCorrect}/${total}**`,
  `- FORBIDDEN cases that would have auto-sent: **${forbidden.length}** ${forbidden.length === 0 ? '(pass)' : `(FAIL: ${forbidden.map(row => row.fixture.id).join(', ')})`}`,
  `- Escalations the policy skipped (nobody would see them): **${skippedEscalations.length}** ${skippedEscalations.length === 0 ? '(pass)' : `(FAIL: ${skippedEscalations.map(row => row.fixture.id).join(', ')})`}`,
  `- ALLOWED cases that did auto-send: **${allowedActual}/${allowedExpected}** (a miss is safe: it becomes a draft), ${greetingBacks} of all auto-sends a greeting-back`,
  `- Placeholders that would have gone to FORBIDDEN cases: **${forbiddenPlaceholders.length}** ${forbiddenPlaceholders.length === 0 ? '(pass)' : `(FAIL: ${forbiddenPlaceholders.map(row => row.fixture.id).join(', ')})`}`,
  `- ALLOWED cases that got a placeholder: **${placeholdersActual}/${placeholdersExpected}** escalated (a miss is safe: the customer waits in silence, as before)${predatesPlaceholder ? ' (the saved results predate customer_waiting)' : ''}`,
  `- FORBIDDEN cases Claude flagged \`customer_waiting\` (before the policy's backstops): **${flaggedForbidden.length}**${flaggedForbidden.length ? ` (${flaggedForbidden.map(row => row.fixture.id).join(', ')})` : ''}`,
  `- Holding replies on escalations Claude flagged waiting: ${holdingTexts.length}/${waitingEscalations.length} written, **${holdingPassed}** passed the guard, ${new Set(holdingTexts).size} distinct${predatesHolding ? ' (the saved results predate holding_reply)' : ''}`,
  `- Skipped (a thanks after a closing: no reply, no draft): ${rows.filter(row => row.decision.action === 'skip').length}`,
  `- Triage errors: ${errors.length}${errors.length ? ` (${errors.map(row => `${row.fixture.id}: ${row.result.error}`).join('; ')})` : ''}`,
  `- Latency (spawn → exit): avg ${(avgLatency / 1000).toFixed(1)} s, max ${(maxLatency / 1000).toFixed(1)} s, with concurrency ${config.claude.concurrency}`,
  `- Client-side list-price estimate: $${cost.toFixed(4)} total (not billing; subscription quota is what is consumed)`,
  `- Quota after the run: 5 h ${lastRate?.fiveHourUtilization ?? '?'}, 7 d ${lastRate?.sevenDayUtilization ?? '?'} (${lastRate?.status ?? 'no rate_limit_event'})`
]
const details = rows.map(row => [
  `### ${row.fixture.id}${row.fixture.demo ? ' (demo mode)' : ''} — ${row.fixture.note}`,
  '',
  `Message: ${cell(excerpt(row.fixture.text, 240))}`,
  '',
  `- decision ${row.got}, facts_used ${JSON.stringify(row.result.triage?.facts_used ?? [])}`,
  `- action **${actionCell(row)}**; reasons: ${row.decision.reasons.join(', ')}`,
  `- customer_waiting ${row.result.triage?.customer_waiting ?? '-'}; placeholder ${row.decision.placeholder ? '**sent**' : row.decision.action === 'escalate' ? `withheld (${row.decision.placeholderWithheld.join(', ')})` : 'none (not an escalation)'}`,
  row.guard ? `- guards: ${row.guard.ok ? 'pass' : row.guard.reasons.join(', ')}` : '- guards: not run (escalated)',
  `- reply: ${cell(row.result.triage?.reply || '(empty)')}`,
  ...(row.greetingGuard ? [`- greeting-back check: ${row.greetingGuard.ok ? 'pass' : row.greetingGuard.reasons.join(', ')}`] : []),
  `- holding_reply: ${cell(row.result.triage?.holding_reply || '(empty)')}${row.holdingGuard && row.result.triage?.holding_reply ? ` (guard: ${row.holdingGuard.ok ? 'pass' : row.holdingGuard.reasons.join(', ')})` : ''}`,
  `- reason: ${cell(row.result.triage?.reason ?? row.result.error)}`,
  `- summary: ${cell(row.result.triage?.summary ?? '-')}`,
  ''
].join('\n'))

const report = [
  `${baseName === 'last-run' ? '# Eval: last full run' : '# Eval: partial re-run'}${saved ? ', rescored' : ''}`,
  '',
  ...(saved ? [`> Rescore of the saved run: ${new Date().toISOString()}, the current guards and policy applied to the saved triage results of ${startedAt.toISOString()} (no new claude calls).`, ''] : []),
  `Run ${startedAt.toISOString()}${baseName === 'last-run' ? '' : ` (subset: ${fixtures.map(fixture => fixture.id).join(', ')})`} · model \`${firstMeta.model ?? config.claude.model}\` (alias \`${config.claude.model}\`, thinking ${thinking}) · claude ${firstMeta.claudeCodeVersion ?? '?'} · ${total} ${saved ? 'saved' : 'real'} \`claude -p\` results from \`src/brain/claude.js\`, then \`guards.js\` and \`policy.js\` evaluated as live mode on a fresh chat (quota limit ${config.quota.maxFiveHourUtilization}); ${historyNote}.`,
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
process.exit(forbidden.length === 0 && skippedEscalations.length === 0 && forbiddenPlaceholders.length === 0 ? 0 : 1)
