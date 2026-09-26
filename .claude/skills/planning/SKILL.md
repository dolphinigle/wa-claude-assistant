---
name: planning
description: How to plan before any non-trivial change — the explore → plan → verify loop every persona runs, whether the change is code, a migration, a deploy, a refactor, or an investigation. Use this when starting a feature, designing a system, scoping a multi-step or multi-file change, breaking work into PRs, planning an ops/deploy task, whenever the root CLAUDE.md "Confirm plan before coding" gate fires, or when a draft plan needs the independent agent plan-review loop before human confirmation. Applies to the main loop and to coder/reviewer/deploy agents alike.
---

> **Copied from br-monorepo (`base` branch) on 2026-09-26.** Its references to `py/mono`, `ts/`, `coder-py`/`coder-ts`, the plan-confirmation gate and `#nnnn` issues belong to that repo; here, read them as examples and apply the method to this prototype (see `CLAUDE.md`).

# Planning

Planning is not writing a document — it is a loop that turns an ambiguous request into a verifiable change without solving the wrong problem. Every persona runs it: the main loop before delegating, `coder-py`/`coder-ts` before implementing, the reviewer before reviewing, `push-to-master` before deploying.

```
Explore → Plan → plan-review loop (§6, main loop only) → (confirm) → Implement → Verify → Commit
```

The root `CLAUDE.md` "Confirm plan before coding" section is the **gate** (when planning is mandatory and when to skip). This skill is the **method** (how to do each phase well). Don't restate the gate here — obey it.

Most of the concrete guidance below uses **code** as the running example (files, call sites, migrations) because that's the common case — but the moves are general. Planning a deploy, a data migration, an investigation, or a doc? Same loop: find the analog, read the conventions, verify the source of truth, map the full surface of what's affected, and end with a check.

## 0. Plan, or skip?

The gate above decides *whether* planning is mandatory; this section is how to calibrate *how much*. Planning has real overhead — scale it to blast radius.

- **A one-sentence diff needs no plan** — but a "small" change isn't always one sentence: a *rename* only skips if the symbol is genuinely local; once it's a shared field/type/enum it's a multi-call-site change (§1), not a skip.
- **The more files, unknowns, and unfamiliar code involved, the more a plan earns its cost.**

When unsure, plan. A wrong PR + re-review + revert costs far more than one planning pass (see CLAUDE.md #9830).

## 1. Explore first

Never plan against assumptions. Read before you design.

- **Find the closest analog first** (CLAUDE.md principle #4) — the sibling module or parallel feature you'll mirror. Cite it. New code should read like whoever wrote the surrounding code.
- **Cross-check, don't assume** — confirm what already exists before proposing something new. Half of "new" work is already in the repo.
- **Read the conventions before designing, not after review bounces.** Ground the plan in the project's own rules: root `CLAUDE.md`, the stack instructions (`.claude/instructions/python-backend.md` / `typescript.md`), and the relevant subdir `CLAUDE.md` (`py/mono` / `ts`). These pin naming, layering, the LIFT file structure, the precedent-grep / "review pitfalls" rules, and test conventions. Read the ones that apply to what you're touching — a plan that fights a documented convention is rework waiting to happen. (The subdir `CLAUDE.md` + its `@`-imported instructions auto-load when you work in that tree, but confirm you actually have the latest version in context before you commit to a design — don't plan from memory of how the conventions used to read.)
- **High-level items: establish the industry standard first, from credible sources only.** When the plan hinges on a high-level choice (architecture pattern, process, security posture, business practice), research how the problem is conventionally solved *before* designing, and support every external claim in the plan with a citation (link + one-line relevance) to a credible source. "Person/blog X said Y" is not evidence of a standard; a load-bearing claim needs **two independent** credible sources.
  - **Scope — this applies only to choices the repo has no analog for.** Where repo precedent already settles the question, the analog *is* the evidence (see the analog-first bullet above) and no external citation is required. When precedent and the industry standard genuinely conflict, precedent still wins for the change at hand, but **surface the conflict** in the plan as a named out-of-scope note (CLAUDE.md principle #5) instead of silently re-deciding.
  - **Tier 1 — authoritative, cite freely:** peer-reviewed research and research-university publications (Harvard, Stanford, MIT, ACM/IEEE, …); official standards bodies (ISO, NIST, IETF RFCs, W3C, OWASP); primary vendor docs *for how that vendor's own product works*; government/regulatory sources (BI, OJK, BPS, …).
  - **Tier 2 — credible practitioner, attribute explicitly:** first-party engineering accounts by major organizations about *their own* systems (Google SRE book, AWS/Stripe engineering blogs, on-the-record conference talks); analyst/consulting research with disclosed methodology (Gartner, McKinsey — non-sponsored only); books from recognized technical publishers; edited-but-not-peer-reviewed outlets (HBR sits here despite the Harvard name). Usable when Tier 1 is silent — frame as "X's account of X's practice", never as *the* standard.
  - **Tier 3 — not credible, never sole support:** individual blogs/Medium/Substack, social posts (X/LinkedIn/Reddit/HN/Quora), SEO listicles, content farms, vendor marketing. Wikipedia is a pointer to its primary sources, not a citation.
  - **Collecting the data itself — see the `external-research` skill.** The tiers above decide *which sources count*; that skill covers getting exact facts out of them — named objects, fields, relationships and cardinality, each proven by a primary artifact and confirmed by a second independent route, with a hard rule that a fact is either verified or explicitly not collected yet (no hedged middle). Read it before researching how an outside system works.
  - **Self-promotion guard:** no source is credible for a claim that advances its own commercial interest. Vendor docs prove *how the product works*, never *that it's the right or leading choice*; discard vendor-commissioned studies, sponsored analyst reports, and benchmarks published by a participant. For "which tool/approach is standard" questions, every cited source must be independent of every option being compared.
- **Verify the source of truth before building on it.** When the feature hinges on an entity relationship ("products supplied by X", "the price for Y"), the first table or field you find that looks right is often a **cache, a denormalized copy, or a nullable default** — not the authoritative record. Confirm which one is canonical (check what's `PROTECT`ed, what's backfilled, what's nullable, what the comments say) before designing on top of it. A plan built on the wrong source of truth is elegant and wrong — the worst kind, because it looks done. This check is not optional just because the tidy option is tempting.
- **Map the full change surface — the #1 planning failure is missing a call site.** Before listing files, run an actual repo-wide search (the Grep tool, not memory) for *every* place that reads, branches on, or constructs the thing you're changing (the field, type, enum value, function, endpoint), and build the files list directly from that search output — if you wrote the file list from recollection instead of from a search you just ran, you skipped this step and the plan is unverified. A plan that touches a model but misses the serializer, the migration, the search index, the one view that orders the queryset, or the place that switches on the old enum is a plan that ships a half-built feature. Your file list must include: the core change, **every downstream call site that must change**, **the tests**, and **the test fixtures/factories/`test_utils`** those tests need. Conciseness applies to the plan's prose — never to the change surface.
- **But the file list is "files that change", not "files that exist".** For each call site you find, decide: does it *change*, or does it *inherit the change for free*? Code that reads through a central function (a calculator, a serializer base, a queryset manager) usually needs **no edit** — note "basket/feed inherit via the calculator, no change" rather than padding them into the list. And a whole separate concern — frontend, another service, a follow-up feature — belongs in **Out of scope as a named follow-up**, never as a backend file you'll edit. Over-listing is its own failure: a coder handed files that don't need touching wastes effort and risks needless churn. Aim for a list where every path genuinely changes.
- **Protect context** — broad codebase sweeps belong in a subagent (`Explore` / `general-purpose`), which reads many files and returns only the conclusion. Context degrades as it fills; don't burn the main window on reads you can delegate. Delegating exploration does not mean exploring less — the subagent still owes you the full call-site map.

## 2. Resolve ambiguity before committing to an approach

If scope or behavior is genuinely unclear, **ask — don't guess** (CLAUDE.md principle #3). Use `AskUserQuestion` to surface the hard parts (edge cases, tradeoffs, what's out of scope) the user may not have stated. One round-trip is cheap; an invented requirement is not. Don't ask what the code or a sensible default already answers.

When you *do* proceed without asking (a subagent often can't ask; sometimes a default is clearly right), **state each assumption and the default you picked** — e.g. "assuming CSV not XLSX; assuming sync import." This keeps the plan executable and makes a wrong assumption cheap to spot and correct, instead of silently baking it in.

But not every unknown is a cheap default. **Separate peripheral assumptions from core-correctness ones.** File format, sync-vs-async, naming — fine to default and note. But which table is authoritative, what a field actually means, whether an invariant holds — those are *correctness* questions: **verify them in the code, don't paper over them with a stated "assumption."** Labelling a load-bearing guess as an "assumption" doesn't make it safe; it just hides a likely bug behind tidy formatting.

## 3. Generate options for non-trivial decisions

For any real design choice, sketch 2-3 approaches with tradeoffs, then commit to one with a reason:

```
Option A: new service — clean separation, but adds a moving part
Option B: extend existing service — simpler, but risks doing too much
Choice: B — the behavior is part of that service's existing responsibility
```

Fix problems at the root (CLAUDE.md principle #5): if a value or query already exists, reference it — don't copy it into the plan.

## 4. Make the plan implementable

A plan someone has to guess at isn't a plan. Be concrete enough to execute without re-deciding.

- ❌ "Handle errors appropriately" / "create a service for X"
- ✅ "On unresolved `thingId`: log warning, return `None`. On unresolved `tempId`: raise `ValueError`."
- ✅ "Add `XService.do_a(input: str) -> Result` and `do_b() -> None`; inject `YService`."

## 5. Plan structure

A plan — inline for a small change, written to a file (`plan.md` / the issue / `SPEC.md`) for anything a fresh context will execute — covers:

1. **Problem** — what we're solving, 1-2 sentences, opening with the **original ask quoted verbatim** (the user's words / the issue title — not your paraphrase; a paraphrase is already one step of drift). This quote is the plan's **anchor**: the §6 reviewer and the §8 checkpoints both compare against it, not against your framing.
2. **Design decisions** — the non-obvious choices and why.
3. **Files changed** — table: path · create/modify · what changes. Complete, per §1's change-surface map: core + every call site + tests + test fixtures. If a row in this table surprises a reviewer ("why does this touch the search index?"), good — that's the call site a shallower plan would have missed.
4. **Todos** — ordered, the sequence to implement in.
5. **Out of scope** — what we're consciously *not* doing. This is a **fence, not a suggestion**: subproblems discovered mid-implementation get *added here* as named follow-ups (or a new issue) unless they block the stated goal — never silently absorbed into the diff. "Fix it properly" (CLAUDE.md principle #5) means fix the root of *the problem you were asked to solve*; an adjacent problem gets flagged, not annexed.
6. **Verification** — the concrete check that proves it works (see §8).
7. **Risks / rollback** — what could break, how to back out.

A good written plan is **self-contained**: it names the files and interfaces, states what's out of scope, and ends with the verification step — so a clean session (or a `coder-*` agent) can execute it without re-exploring.

## 6. Plan-review loop — an independent agent checks the plan before the human sees it

Whenever the confirm-plan gate fires, the draft plan does **not** go straight to the human — first loop it through a **fresh, independent reviewer agent** (the `coder-review-loop` idea, applied to the plan instead of the diff). The author has already convinced itself; an agent that didn't do the exploration is the cheapest way to catch the missed call site, the wrong source of truth, the unimplementable step, or a plan solving a *different problem* than asked — *before* anything is built.

**Main loop only.** Coder subagents can't spawn agents (their "never spawns agents" boundary), so they **skip this section** — the dispatcher settles their approach and scope before delegating (the coder still checks it against the code — its Hard-stop stop point 0), and the coder-review-loop reviews their diff after. The rest of this skill applies to them in full.

```
Draft plan (§5) → Agent(Plan): review → findings? → revise → SendMessage(same reviewer): re-review
                                     → NO ISSUES → present to human (§7 / confirm gate)
```

1. **Spawn a fresh `Plan` agent** with `model: opus` (read-only — it can search and read but not edit). `Plan` is a built-in agent with no frontmatter file in this repo, so this pin is the *only* thing binding plan-review to opus — without it a session running a cheaper tier silently downgrades the reviewer. Give it the draft plan **verbatim**, the **original ask verbatim** (the user's message / a pointer to the source issue, not exploration notes — the ask's *problem* is the requirement and a fix it proposes is the user's hypothesis; without it the reviewer can only check the plan against the quote the author *chose*), plus the prompt below. Don't summarize the plan for it, don't include your exploration notes, reasoning or suspicions — it must re-derive its confidence from the repo, not inherit yours. A question that names the answer you expect is reasoning: to get a spot checked, name the spot, not the verdict.
2. **Reviewer returns a verdict**: a numbered findings list (each: what's wrong · where · why it matters), or a verdict line containing `NO ISSUES`. **Judge the verdict from that line, don't string-match the whole reply** — built-in agent personas append their own epilogues (the `Plan` agent always ends with a "Critical Files" list), so the response is never *exactly* `NO ISSUES`.
3. **Findings → revise the plan yourself** — re-run the searches, re-read the code; fix the plan at the root, don't just append caveats. Then `SendMessage` the **same reviewer** ("Plan revised: <what changed>. Re-review.") so it keeps its prior findings in context and verifies the revision's shape, not a fresh surface.
4. **Iterate until the verdict is `NO ISSUES`. Cap: 3 review rounds.** If findings remain after 3 rounds, stop looping and present the plan to the human **with the unresolved findings quoted** — never silently dropped. Unbounded author↔reviewer ping-pong is the known failure mode; the cap is the backstop.
5. **Judgment calls exit early.** A finding that is really a scope/product/design decision (two valid approaches, disputed requirement, a step-0 answer that departs from the ask's proposed fix or says the work isn't worth doing) goes straight to the human alongside the plan — don't spend rounds arguing it with the reviewer. Same principle as the coder loop's ESCALATE: no number of mechanical revisions resolves a decision that isn't the agents' to make.

Reviewer prompt template:

```
Review this implementation plan adversarially. You did not write it — verify it against the
repo, not against its own prose.
0. Before reading the plan's design, work out how you would solve the ask's *problem* — any fix
   the ask itself proposes is one hypothesis, not a requirement — and whether, with the repo as
   it is today, it is worth doing at all. Then read the plan and report every place your answer
   is materially better (simpler, does less, or does nothing). A plan can pass every check
   below and still be the wrong plan; this is the check that catches it.
Then check, by actually searching/reading (Grep/Read), that:
1. The plan solves the ORIGINAL ASK supplied above — not a nearby, larger, or more
   interesting problem. Compare the plan's Problem-line quote against the supplied ask (and
   the source issue when one exists): a missing, truncated, or paraphrased quote is itself a
   finding. Flag (a) anything the plan does that was not asked, (b) anything asked that the
   plan omits — including an unstated departure from a fix the ask proposes (a stated,
   reasoned departure is fine; step 0 may even recommend one).
2. The change surface is complete — search for every consumer of the thing being changed
   (field/type/enum/function/endpoint); flag any call site, test, fixture/factory the files
   list misses, and any listed file that doesn't actually need to change.
3. The plan builds on the authoritative source of truth, not a cache/denormalized copy/
   nullable default — check PROTECT/backfill/comments on the entities it relies on.
4. Each step is implementable without re-deciding (no "handle errors appropriately").
5. The verification step is concrete and runnable, and named test cases exist.
6. Nothing contradicts root CLAUDE.md, the stack instructions, or the subdir CLAUDE.md
   conventions (naming, layering, file structure, test rules).
7. Out-of-scope items are named, not silently missing.
8. Every external claim (industry standard, best practice, benchmark) is cited to a credible
   source per §1's tiers — no "X said Y" hearsay, and no source supporting a claim in its
   own commercial interest (self-promotion guard). Judge the tier from the source's identity
   (publisher/domain); do NOT fetch the citations. Skip this check when the choice follows a
   repo analog — precedent needs no citation.
Report ONLY findings that would change the plan — a numbered list (what · where · why it
matters), or exactly "NO ISSUES" if none. Do not restyle the plan or raise nice-to-haves.
```

State the loop when you run it and announce rounds (`plan-review round 2/3: 1 finding left`) so the human can interrupt. The reviewer's `NO ISSUES` clears the plan for *presentation* — the human confirm gate still decides whether it gets implemented.

## 7. Present structural plans as a component diagram

A wall of prose is the wrong format for a human to approve a design *with moving parts* — they want to *see* the shape, not read it. **When the change adds or restructures components** — a new service, new wiring between modules, a refactor that moves responsibilities — present the plan as a **Mermaid diagram of components and how they connect**.

**Scope it to where it pays off.** The diagram earns its keep when a reviewer needs the box-and-arrow shape to approve. For non-trivial-but-*linear* work — a contained bug fix, a batched data migration, a single-field cap, a serializer tweak — the value is in the file-list/todos (§5), not a picture; keep the prose summary and **skip the diagram**. A component graph of a one-component change is ceremony, not signal.

- **Format:** Mermaid `flowchart` — text, diffable, renders natively on GitHub. Declare nodes and edges (`A[Serializer] --> B[Calculator]`) and let GitHub lay it out. No ASCII hand-drawing, no image tooling. The ` ```mermaid ` block must be the **top-level fence** in any posted body — never nested inside another code fence, or GitHub renders it as raw text.
- **What it must show:** the proposed components, **their relationships to the existing components** they attach to or extend, and **what is reusable** — make new-vs-existing obvious (a highlighted node or a subgraph) so the reader sees at a glance what's added versus reused.
- **Keep it readable — a diagram that renders as a wall of tiny text is worse than prose.** GitHub auto-scales the diagram to the page width, so node count and label length drive text size:
  - **≤ ~8 nodes per diagram**, labels ≤ ~3 words, minimal `<br/>`. A node label is a *name*, not an explanation — no sentences inside nodes; explanation goes in the bullets under the diagram.
  - **Too big for one picture? Split it into multiple smaller diagrams**, one per concern (e.g. request flow vs. data model, or one per phase), each ≤ ~8 nodes. Two readable pictures beat one unreadable mega-graph — never compensate by shrinking labels or cramming.
  - Any `classDef` **must set an explicit `color:`** — e.g. `classDef new fill:#a5d6a7,stroke:#1b5e20,color:#000;`. A fill without a text color is unreadable in one of GitHub's two themes.
- **Where to put it** — Mermaid does **not** render in the terminal chat, only on GitHub, so the render surface depends on whether an issue already exists:
  - **Source issue already exists** → comment the diagram on it and open it (`gh issue view <n> --web`, degrades to printing the URL on a headless box).
  - **No source issue** (chat-originated work) → render it **inline in chat**. The source is readable and the human can paste it into any renderer. **Don't `gh issue create` just to host a diagram** — manufacturing an issue per ad-hoc plan is issue-tracker noise and the round-trips cut against the token-efficiency ethos.
- **Carry it into the PR.** The reviewer's surface is the *PR*, not the source issue — so the same diagram belongs in the eventual PR body (the `pr-description` skill embeds it). Author it once at plan time, reuse it at review time, so reviewers get the glance-and-approve benefit without hunting back to the issue.
- **Diagram-first, minimal prose.** Lead with the Mermaid block, then **at most three bullets** (problem · key decision · out of scope). Humans are lazy — they approve from the picture; the detailed file-list/todos (§5) can stay in chat.
- **Approval still happens in chat.** The diagram is a render surface, not a second gate — reject / request-changes / approve as before.

## 8. Verification is part of the plan, not an afterthought

Every plan ends with a check Claude can run and read: a test, a build, a lint, a script that diffs output, a screenshot compared to a design. If you can't name how you'll verify it, you don't understand the change yet — and you shouldn't ship it.

- Write/update tests **alongside** the change (CLAUDE.md build/test rule) — name the cases in the plan.
- **Verify against the anchor, not just the plan** — the plan itself can drift, and checking the diff only against the plan validates the drift:
  - Re-read the §5 anchor at each **checkpoint**: before presenting the plan, after each review/fix round, and immediately after any context compaction.
  - Compaction keeps only a *paraphrase* of the goal — write the anchor somewhere durable (the plan file or the source issue) *before* it's needed, especially for an inline plan on work that may outlive one context window.
  - Before declaring done, answer: *does the deliverable do what was asked?* and *what does it do that was not asked?* Unasked work is justified in one line *as blocking the stated goal* (the §5 fence) or removed.
- After implementing, have a **fresh perspective check the diff against the plan and the anchor** (the post-implementation counterpart of §6's plan-review loop) — the `/code-review` skill, or a subagent prompted to find gaps that affect correctness or the stated requirements (not style), plus the two drift questions above. A reviewer asked for gaps will always find some; don't chase non-correctness findings into over-engineering.

## 9. Break large work into PRs

Define PR boundaries so each is independently reviewable and doesn't break `main`:

```
PR 1: infrastructure (models, schemas, base services)
PR 2: core logic
PR 3: integration (wire into existing flow / UI)
```

For the PR write-up itself, use the `pr-description` skill. For promoting through dev → master, use `push-to-master`. Don't duplicate their content into the plan.

## Anti-patterns

- **Jumping to code** — skipping explore/plan on a change that needed it produces a plausible diff for the wrong problem.
- **Goal drift** — a chain of locally-reasonable hops (fix A → exposes B → refactor C) ending with a deliverable far from the ask; recency beats the goal unless you re-read the anchor at the §8 checkpoints.
- **Scope annexation** — absorbing an adjacent discovered problem into the diff instead of adding it to Out of scope as a named follow-up (§5).
- **Infinite exploration** — "investigate X" with no scope reads hundreds of files and fills context. Scope it, or delegate to a subagent.
- **Vague plan** — "handle errors" is not a plan (see §4).
- **Trust-then-verify gap** — a plan with no runnable check is a guess. Add one (§8).
- **Ignoring existing patterns** — designing without finding the analog first (§1).
- **Hearsay-backed plan** — supporting a high-level choice with "X said Y" from a non-credible source, or with a vendor's claims about its own product (§1 tiers + self-promotion guard).
- **Self-certified plan** — (main loop) presenting a gated plan to the human without running the plan-review loop (§6), or contaminating the reviewer with your own exploration notes so it rubber-stamps instead of re-deriving.
- **Prose-only design** — presenting a *component-restructuring* plan as text the human must read instead of a diagram they can glance at (§7).
- **Unreadable diagram** — one mega-graph with sentence-length node labels rendering as tiny text; split into multiple ≤8-node diagrams instead (§7).
- **Diagram ceremony** — forcing a box-and-arrow picture (or worse, creating an issue to host one) onto a *linear* change where the file-list is the real plan (§7).
- **One giant PR** — un-reviewable; split it (§9).
