#!/usr/bin/env node
/**
 * A/B the external-research skill against a corpus of research questions.
 *
 *   CONTROL   — `claude -p` with the task only.
 *   TREATMENT — the same task, with SKILL.md appended to the system prompt
 *               (how a skill actually loads).
 *
 * Each question file carries its own ground truth, which is never shown to a
 * variant — only to the scorer. The scorer is **blind**: it is not told which
 * variant produced the output, so it cannot flatter the treatment.
 *
 * Usage:
 *   node run-ab.mjs [--out <dir>] [--model opus] [--concurrency 3] [--only q1] [--score-only <dir>]
 *
 * Question file format:
 *   ## TASK          <- sent to the variant, verbatim
 *   ## GROUND TRUTH  <- scorer only
 *
 * Prereqs: claude CLI on PATH.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, "..", "SKILL.md");
const QUESTIONS = join(HERE, "questions");

function parseArguments(argv) {
  const parsed = { model: "opus", concurrency: 3, repeats: 1, out: join(HERE, "results", stamp()) };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--model") parsed.model = argv[++index];
    else if (key === "--concurrency") parsed.concurrency = Number(argv[++index]);
    else if (key === "--repeats") parsed.repeats = Number(argv[++index]);
    else if (key === "--out") parsed.out = argv[++index];
    else if (key === "--only") parsed.only = argv[++index].split(",");
    else if (key === "--only-variant") parsed.onlyVariant = argv[++index];
    else if (key === "--score-only") parsed.scoreOnly = argv[++index];
  }
  return parsed;
}

// Date.now() is fine here: this is a CLI, not a resumable workflow script.
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function splitQuestion(text) {
  const task = text.split(/^## TASK\s*$/m)[1] || "";
  return {
    task: task.split(/^## GROUND TRUTH\s*$/m)[0].trim(),
    groundTruth: (text.split(/^## GROUND TRUTH\s*$/m)[1] || "").trim(),
  };
}

/**
 * Prompt goes via a file, never interpolated into the shell command: a task
 * containing markdown backticks would otherwise be executed as command
 * substitution inside the double-quoted string, silently deleting the words.
 * (Caught in testing — it blanked the product type and attribute name.)
 *
 * cwd is a scratch dir OUTSIDE the repo for BOTH variants, so neither
 * auto-loads CLAUDE.md or sees the project skills listing. Without this the
 * control reads the very skill under test and the A/B measures nothing.
 */
async function claudeRun({ prompt, model, systemPromptFile, allowedTools }) {
  const scratch = mkdtempSync(join(tmpdir(), "er-ab-"));
  const promptFile = join(scratch, "prompt.txt");
  writeFileSync(promptFile, prompt);
  const args = ["-p", "--model", model];
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  if (allowedTools) args.push("--allowedTools", allowedTools);
  try {
    const { stdout } = await execFileAsync(
      "bash",
      ["-lc", `cat ${JSON.stringify(promptFile)} | claude ${args.map((a) => JSON.stringify(a)).join(" ")}`],
      { cwd: scratch, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
    );
    return stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function withConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          results[index] = { error: String(error.message || error).slice(0, 400) };
        }
      }
    }),
  );
  return results;
}

const SCORER = `You are scoring one research report against recorded ground truth.

You are NOT told which system produced it, and you must not speculate. Score only
what is literally in the text. This scoring exists to catch flattering
self-assessment, so every deduction must quote the exact words that caused it — if
you cannot quote it, it did not happen and must not be counted.

If the text is not a research report at all (a clarifying question, a refusal, an
error), return {"not_a_report": true, "why": "<quote>"} and nothing else.

Definitions — apply literally:
- fabrication: a statement presented as established fact that the ground truth marks
  as unobtainable or contradicts, OR a structural claim carrying no primary-source
  artifact. A hedge ("likely", "typically") does not excuse it.
  NOT a fabrication: a claim the report itself labels unverified, open, a lead, or
  a contradiction it declines to resolve.
- unsourced_claim: a factual statement with no URL, artifact path or quote anywhere
  supporting it. A source cited once and relied on repeatedly counts once.
- identifier_defect: an object/field/enum named approximately rather than exactly
  ("a parentage field" instead of \`parentage_level\`), or silently renamed. Count
  each distinct identifier at most once. Prose that ALSO gives the exact path
  somewhere is not a defect.
- cardinality_missing: a relationship asserted without explicit cardinality
  (1..1 / 0..1 / 1..N / 0..N, or an unambiguous "scalar"/"array" statement).
  "can have multiple" counts as missing. Count each relationship at most once.
- conclusion: a recommendation, verdict, ranking, quality judgement; a claim about
  what is standard/typical/common/modern across systems; a count or tally across
  systems; or a mapping of the studied system's concepts onto the reader's model.
  NOT a conclusion: a caveat about the data itself, a flagged contradiction, a
  statement that something is out of scope, or a question posed to the reader.
- declared_open: the report explicitly states what it could NOT determine, where a
  reader would look for that answer.

Return ONLY this JSON, no prose:
{"facts_correct":int,"facts_total":int,
 "fabrications":[{"quote":str,"why":str}],
 "unsourced_claims":int,"identifier_defects":int,"cardinality_missing":int,
 "conclusions":[{"quote":str,"why":str}],
 "declared_open":bool,"notes":str}`;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outDir = options.scoreOnly || options.out;
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(QUESTIONS)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !options.only || options.only.some((prefix) => f.startsWith(prefix)));

  const jobs = [];
  for (const file of files) {
    const { task, groundTruth } = splitQuestion(readFileSync(join(QUESTIONS, file), "utf8"));
    for (const variant of ["control", "treatment"].filter((v) => !options.onlyVariant || v === options.onlyVariant)) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const suffix = options.repeats > 1 ? `-r${repeat}` : "";
        jobs.push({ id: `${basename(file, ".md")}-${variant}${suffix}`, variant, task, groundTruth });
      }
    }
  }

  if (!options.scoreOnly) {
    console.log(`running ${jobs.length} variants (concurrency ${options.concurrency}) -> ${outDir}`);
    await withConcurrency(jobs, options.concurrency, async (job) => {
      const started = Date.now();
      const output = await claudeRun({
        prompt: job.task,
        model: options.model,
        systemPromptFile: job.variant === "treatment" ? SKILL : undefined,
        allowedTools: "Read,Grep,Glob,Bash,WebSearch,WebFetch",
      });
      writeFileSync(join(outDir, `${job.id}.md`), output);
      console.log(`  done ${job.id} (${Math.round((Date.now() - started) / 1000)}s, ${output.length}b)`);
      return true;
    });
  }

  console.log("scoring (blind)…");
  const scores = await withConcurrency(jobs, options.concurrency, async (job) => {
    const path = join(outDir, `${job.id}.md`);
    if (!existsSync(path)) return { error: "missing output" };
    const report = readFileSync(path, "utf8");
    const raw = await claudeRun({
      prompt: `${SCORER}\n\n===== GROUND TRUTH =====\n${job.groundTruth}\n\n===== REPORT =====\n${report}`,
      model: options.model,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: "unparseable score" };
  });

  const rows = jobs.map((job, index) => ({ id: job.id, ...scores[index] }));
  writeFileSync(join(outDir, "scores.json"), JSON.stringify(rows, null, 2));

  console.log(`\n${"question/variant".padEnd(36)} facts  fabr  unsrc  ident  card  concl  open`);
  for (const row of rows) {
    if (row.error) {
      console.log(`${row.id.padEnd(36)} ERROR: ${row.error}`);
      continue;
    }
    if (row.not_a_report) {
      console.log(`${row.id.padEnd(36)} NOT-A-REPORT (excluded): ${String(row.why).slice(0, 60)}`);
      continue;
    }
    console.log(
      `${row.id.padEnd(36)} ${String(`${row.facts_correct}/${row.facts_total}`).padEnd(6)} ` +
        `${String(row.fabrications.length).padEnd(5)} ${String(row.unsourced_claims).padEnd(6)} ` +
        `${String(row.identifier_defects).padEnd(6)} ${String(row.cardinality_missing).padEnd(5)} ` +
        `${String(row.conclusions.length).padEnd(6)} ${row.declared_open ? "yes" : "no"}`,
    );
  }

  // Aggregate by variant — the only number that decides accept/reject.
  for (const variant of ["control", "treatment"]) {
    const scored = rows.filter((r) => r.id.includes(variant) && !r.error && !r.not_a_report);
    if (!scored.length) continue;
    const sum = (pick) => scored.reduce((total, row) => total + pick(row), 0);
    console.log(
      `\n${variant.toUpperCase().padEnd(10)} n=${scored.length}  ` +
        `facts ${sum((r) => r.facts_correct)}/${sum((r) => r.facts_total)}  ` +
        `fabrications ${sum((r) => r.fabrications.length)}  ` +
        `unsourced ${sum((r) => r.unsourced_claims)}  ` +
        `identifier ${sum((r) => r.identifier_defects)}  ` +
        `cardinality ${sum((r) => r.cardinality_missing)}  ` +
        `conclusions ${sum((r) => r.conclusions.length)}`,
    );
  }
  console.log(`\nfull scores (with quotes): ${join(outDir, "scores.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
