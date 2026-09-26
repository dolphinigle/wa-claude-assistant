export const meta = {
  name: 'review-fix',
  description: 'Adversarial review of recent changes: lenses find, one skeptic per finding refutes, one fixer fixes; loop until dry or maxRounds',
  whenToUse: 'After a substantive change to this repo. args: {context: "what changed + commit range", lenses?: [{key, prompt}], maxRounds?: 2, evalBudget?: 20}',
  phases: [
    { title: 'Review', detail: 'one read-only reviewer per lens' },
    { title: 'Verify', detail: 'one skeptic per finding, defaults to refuted' },
    { title: 'Fix', detail: 'one fixer per round, regression test per finding' },
  ],
}

// Used for the 5 review rounds on 2026-09-26 (issue #1); every round found real bugs, so don't skip Verify.
const A = args || {}
const CONTEXT = A.context || 'Review the most recent commits on main (git log -10).'
const MAX_ROUNDS = A.maxRounds || 2
const EVAL_BUDGET = A.evalBudget ?? 20
const LENSES = A.lenses || [
  { key: 'correctness', prompt: 'Lens: correctness of the changed code and its callers. Loops, dedupe, self-chat and owner-command auth, notify vs append/backlog, takeover, debounce, LID/PN addressing, crash or silent drop on unexpected input. Run npm test.' },
  { key: 'send-path', prompt: 'Lens: can any path reach a customer when it should not (shadow, guards, pause/mute/blocklist, takeover, rate, quota, backlog, attachments, triage failure, malformed decision)? Can any path drop a message the owner should see (no reply and no draft)? Try concrete inputs via unit calls or `npm run dev -- --fake-brain` fed on stdin.' },
  { key: 'robustness', prompt: 'Lens: src/brain/claude.js against the locked command in docs/implementation-notes.md (argv, env, stdin, init assertions, timeouts, queue), store atomicity and bounds, and whether tests assert behavior rather than restate the code.' },
]
const BOUNDS = `Read CLAUDE.md first and obey its hard boundaries (no pairing, no WhatsApp connection, real claude calls only via npm scripts, no push unless told). Context: ${CONTEXT}`

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' },
  title: { type: 'string' }, failure_scenario: { type: 'string' }, suggested_fix: { type: 'string' } },
  required: ['id', 'severity', 'file', 'title', 'failure_scenario', 'suggested_fix'] } } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, evidence: { type: 'string' }, adjusted_severity: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['real', 'evidence'] }
const FIX = { type: 'object', properties: {
  fixed: { type: 'array', items: { type: 'string' } },
  skipped: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
  tests: { type: 'object', properties: { passed: { type: 'number' }, failed: { type: 'number' } }, required: ['passed', 'failed'] },
  eval_rerun: { type: 'string' }, commits: { type: 'array', items: { type: 'string' } } },
  required: ['fixed', 'skipped', 'tests', 'commits'] }

const rounds = []
const fixed = []
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const prior = fixed.length ? `\nAlready fixed this run (re-report only if the fix is wrong):\n${fixed.map(t => '- ' + t).join('\n')}` : ''
  const verified = await pipeline(
    LENSES,
    l => agent(`${BOUNDS}\nRead-only adversarial reviewer: no edits, no commits. ${l.prompt}\nOnly real defects with a concrete failure scenario. Ids "${l.key}-r${round}-<n>".${prior}`,
      { label: `review:${l.key}:r${round}`, phase: 'Review', schema: FINDINGS }),
    r => r ? parallel(r.findings.map(f => () =>
      agent(`${BOUNDS}\nRead-only. Try to REFUTE this finding; reproduce cheaply if you can (throwaway files under ~/copilot/research/wa-claude-assistant/verify/, delete after). real=true only if it happens with the current code; default false if uncertain. Owner decisions listed in CLAUDE.md are not bugs.\nFinding: ${JSON.stringify(f)}`,
        { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT })
        .then(v => v && v.real ? { ...f, severity: v.adjusted_severity || f.severity, evidence: v.evidence } : null)))
      .then(xs => xs.filter(Boolean)) : [],
  )
  const confirmed = verified.flat().filter(Boolean)
  log(`round ${round}: ${confirmed.length} confirmed (${confirmed.filter(f => f.severity === 'high').length} high)`)
  if (!confirmed.length) { rounds.push({ round, confirmed: [] }); break }
  const fix = await agent(`${BOUNDS}\nFixer. Fix these verified findings at the root, simplest fix first, one regression test each; npm test green. Follow the CLAUDE.md eval rule (full eval budget: ${EVAL_BUDGET} claude calls; guards/policy-only changes use --rescore). Skip anything that needs an owner decision and say why. Commit locally; do not push.\nFindings:\n${JSON.stringify(confirmed, null, 1)}`,
    { label: `fixer:r${round}`, phase: 'Fix', schema: FIX })
  confirmed.forEach(f => fixed.push(`${f.id}: ${f.title}`))
  rounds.push({ round, confirmed: confirmed.map(f => ({ id: f.id, severity: f.severity, title: f.title })), fix })
}
if (rounds.length === MAX_ROUNDS && rounds[MAX_ROUNDS - 1].confirmed.length) log('stopped at maxRounds: the last fixer\'s commits are unreviewed')
return { rounds }
