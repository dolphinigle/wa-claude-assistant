---
name: external-research
description: How to collect precise, unbiased, fully verified data about how an external system, product or standard actually works — its objects, fields, relationships and cardinality — with no guesswork and no conclusions drawn. Use when a decision depends on something outside this repo (a marketplace, platform, competitor, vendor product, standards body or regulation), when finding out what other systems actually do before a design choice, when a page or API refuses to load and you need a legitimate way in, or when writing an issue, plan or design doc that cites outside sources.
---

> **Copied from br-monorepo (`base` branch) on 2026-09-26.** Its references to `py/mono`, `ts/`, `coder-py`/`coder-ts`, the plan-confirmation gate and `#nnnn` issues belong to that repo; here, read them as examples and apply the method to this prototype (see `CLAUDE.md`).

# Collecting data about external systems

Companion to the `planning` skill, which owns **source credibility** (Tier 1/2/3, the self-promotion guard). Do not restate that here.

> **This skill collects data. It does not answer the question.**
>
> The deliverable is a precise, unbiased record of how the system works — named objects, named fields, relationships with cardinality, rules quoted verbatim — each proven by a primary artifact and confirmed by a second independent route. Whoever holds the decision reads that record and draws the conclusion. **You supply the evidence; you do not supply the verdict.**

Guessing is not a weaker form of researching; it is the opposite of it. And a conclusion smuggled into a data set is worse than a wrong number, because it silently makes the decision for the person who thought they were reading facts.

## 1. In scope and out of scope

| Collect this — data | Never write this — conclusion |
|---|---|
| What the system does, exactly | What we should do |
| Field names, types, allowed values, constraints | Which option this "supports" or "argues for" |
| Relationships and cardinality | Whether the approach is good, clean, modern, or a mistake |
| Rules quoted verbatim | "The industry standard is X" · "most platforms do X" |
| Per-system rows, each independently verified | Counts, trends or distributions across systems |
| The system's own vocabulary | A mapping of their concepts onto ours |
| What a source says, attributed | What a source "really means" |

**Why the last three are conclusions, not data:**

- **Counting requires classifying**, and classifying is a judgment: whether a given platform "has a separate axis object" often depends on how you read it. A count launders those judgments into a number that looks like a measurement. Record the per-system facts and let the reader count.
- **Mapping their model onto ours** imports an interpretation. Record that they call it `parentage_level`; do not record that "this is their version of our parent product" unless the vendor says so, in which case quote them.
- **"What it really means"** is where an unverifiable claim enters wearing a factual voice.

If something genuinely must be flagged for the decision-maker, put it in a clearly separated **Observations for the reader** section, phrased as a question, never folded into the data.

**When the task itself asks for the verdict.** Requests routinely arrive as *"which is the industry standard, and which should we adopt?"* Collect the data, and answer the verdict half in **one line**:

> Out of scope for a data collection — below is what each system does; the choice is yours.

Then stop. Do not soften it into a hedged recommendation (*"if your goal is X, then Y"*, *"the evidence points toward…"*), do not rank the systems, do not characterise the difference as fundamental or superficial, and do not answer it by implication in a closing paragraph.

**The shapes a conclusion actually takes.** These are the leaks measured under this skill — they read as factual, which is why they survive:

| Leak | Why it is a conclusion | Instead |
|---|---|---|
| *"**Both systems** expose a per-product axis object"* · *"Neither is purely X"* | A similarity or difference asserted across the sample. Calling both things "a per-product axis object" is a classification judgement — the same move as a tally, at n=2 | Give each system its own row with its own identifiers. The reader sees the similarity |
| *"So **the complete list is not a single list**"* | A headline that re-characterises the system rather than quoting it | Quote the parameter or condition that made you think so |
| *"With the credential this is **a five-minute read**"* | An effort or quality judgement about work not performed | State the route and what it would settle |
| *"**Do not cite** this as X"* · *"must be read together with Y"* | A currency or provenance finding turned into an instruction. The finding is exactly right; the imperative mood is not | Give it as data — *"Amd 1:2022 replaces text in clauses 5.5.1 and 5.5.2.2 [artifact]"* — and let the reader draw the caution |

## 2. The precision bar

The record is structured, not prose. Prose is where hedges hide.

```
OBJECTS
  <ExactName>   what it is · identified by <field> · created by <mechanism>

RELATIONSHIPS
  <A> --1..N--> <B>   via <field>, required
  <B> --0..1--> <C>   via <field>, optional

FIELDS
  <object>.<field> : <type>   constraint / allowed values   [artifact + location]

RULES (verbatim)
  "<exact quote>"   [artifact + location]

EXAMPLES — one real instance per object, never invented
  <ExactName>   <the instance, as the system emitted or published it>
                [artifact + how it was obtained: searched / GET <url> / vendor sample]
```

- **Identifiers verbatim.** Exactly as the system spells them. Never "a parentage field" when it is `parentage_level`; never paraphrase an enum value or tidy up its casing.
- **Cardinality explicit.** `1..1`, `0..1`, `1..N`, `0..N` — never "can have multiple".
- **Enumerations captured or declared uncaptured.** *"A closed list"* is not data. Either the values, or `enumerated, N values, not collected`.
- **Constraints quoted, not summarised.** "Required" and "required unless `<other>` is set" are different facts.
- **Every object carries a real example.** One concrete instance — a response body, a record, a rendered page, a published sample — for each object in the record. A schema tells you the shape; only an instance tells you what actually goes in the fields, and which of two similar identifiers is which. Two legitimate ways to get one, both recorded with the route:
  - **Search for it** — the vendor's own docs, sample payloads, test fixtures, published data files. Quote it as printed.
  - **GET it** — call the endpoint, fetch the page, read the file, and capture what came back (§9 when it needs a browser).

  **The instance must be an instance of that object** — not of an artifact that merely mentions it. A change-log row naming a product type is an instance of a change-log row. A title pattern, a template and a schema fragment are shapes, which is exactly what an example exists to *not* be. If what you have is the schema again, you have no example.

  An object you cannot produce a single instance of is a shape you read about, not one you observed: keep the fields in VERIFIED if the artifact proves them, and put `no instance retrieved` against the object with the route that would produce one. **Never construct the example yourself** — see §7. If a real instance carries a secret, a credential or personal data, **redact the value and say it is redacted**; a redaction is data, a substituted value is a fabrication.
- **No field is filtered out for looking unimportant.** Collect every field the question touches, including ones that cut against whatever answer seems to be forming. Deciding a field doesn't matter is a conclusion.
- **Reproduce whole tables, whole enums, whole lists.** When a rule lives in a table or an enumerated set, give **every** row or value, or state plainly which you left out and why. Quoting the subset that matches the shape you found is a biased sample at row level, and it is the single most damaging thing measured under this skill: a collection printed 4 of a refund table's 7 rows and called them "verbatim" — the 3 it dropped were the ones contradicting its own headline, and the same document printed 1 of an enum's 6 entries as "quoted as printed".
- **Quote to the end of the clause.** Truncate and you can reverse the meaning: *"the claim code cannot be cancelled"* became a hard rule only by cutting *"…and charges will be deducted from your prepaid balance. If you need to cancel refunds past this timeframe please reach out to our operations team."* Mark every elision with an ellipsis, and check that nothing after it qualifies what you kept. Watch particularly for a leading *"Unless otherwise stated,"* and a trailing parenthetical.
- **One quote, one artifact.** A joint citation on a single quoted string misattributes the text and fabricates a second route. Where two sources say something similar, quote each separately — they usually differ, and the difference is data.
- **Every line names the artifact that proves it.** A line with no artifact is not data. That includes cardinality rows, which are the ones most often left uncited.
- **A diagram is part of the record, not an illustration of it.** Every node is an object that has a section; every edge names the artifact that proves the relationship; no node contains a value that was not retrieved. Diagrams are where unsourced claims hide most comfortably — a picture reads as a summary of evidence even when nothing behind it was collected. (Observed: a Mermaid diagram carried an invented example value and an edge asserting a relationship between two systems that no artifact connected.)

Template: [assets/fact-base-template.md](assets/fact-base-template.md).

## 3. Staying unbiased while collecting

- **Fix the sample before collecting.** When several systems are being examined, write down which ones and why *first*, with the inclusion criterion. Then report **every** member — including the ones that don't fit the emerging pattern, and the ones you couldn't finish. **With a single system the sample is the surface set** — which markets, locales, API versions, product lines and document families are in scope, and which are deliberately out. Skip this and the gaps become incidental instead of structural: a study meaning to cover three markets silently ended up covering two, because nothing had been written down to notice.
- **Go looking for the counter-case on purpose.** For each expected shape, spend a search actively trying to find a system or artifact that contradicts it, and record what that search returned — including "nothing found". Only collecting confirmations produces a data set that is individually true and collectively misleading.
- **Collect the whole local structure**, not just the part that bears on the question. The adjacent field you skipped is usually the one that changes the reading.
- **Do not stop because you have enough.** Stop when the questions are answered or blocked. "Enough to support the expected answer" is the definition of a biased sample.
- **Record the system's own words** for its own concepts, in its own language, and keep the original alongside any translation.

## 4. Two lists, and nothing in between

| List | Admission rule |
|---|---|
| **VERIFIED** | Primary artifact (§5 S1–S3) + exact quote or fragment + **an independent second confirmation** (§6) |
| **OPEN** | Everything else — not yet collected, blocked, contradictory, unreachable. Each row names **what would settle it** |

No "probable", no "likely", no confidence score. A confidence label on an unverified claim is how a guess gets into a design document wearing a disguise. **If it is not verified, it goes in OPEN and stays out of the record.**

**And no third mark.** "Single-route", "partially verified", "one source but solid" are the same disguise wearing a tidier badge — a fact with one route is an OPEN row naming the second route that would close it. (Observed: a collection invented a 🔸 single-route tier, and every claim parked there turned out to be wrong or incomplete when a second route was finally tried.)

Collection is finished when every question is in VERIFIED, or in OPEN with a reason and the route that would close it. **OPEN rows are not failure** — they are the honest edge of the data, and the thing to escalate.

## 5. Where the data actually is

| | Source | Use |
|---|---|---|
| **S1** | The system's own machine-readable artifact — schema, OpenAPI spec, source code, published data file, official repo | Primary. Best possible |
| **S2** | The system's own developer/reference documentation | Primary |
| **S3** | The system's own help/policy pages | Primary, but often simplified — prefer S1/S2 for structure |
| **S4** | The system's behaviour, observed directly (§9) | Primary for behaviour; the usual independent confirmation of S1/S2 |
| **S5** | Third-party mirror, integration vendor doc, an SDK wrapping the system | **A lead, never data.** Use it to locate the S1 artifact, then cite that |
| **S6** | Blog, forum, SEO article | A lead at most |

**Provenance, recorded per artifact:** `P0` the vendor's own domain or repo · `P1` vendor-published via a traceable redistribution · `P2` a third party asserts vendor origin, unverifiable · `P3` origin unknown.

**P2 and P3 never enter VERIFIED.** They point at the real artifact. Two agreeing copies are one source, not two.

**A local file is not a source.** A prior research corpus, a saved schema dump, an earlier issue or a note in this repo carries **whatever provenance it had when it was written** — usually unrecorded, sometimes since retracted. Being on disk and easy to read is not evidence. Treat it as a lead telling you which artifact to re-fetch; it never enters VERIFIED under its own name. (Observed in testing: a local corpus file was cited for a claim the issue that produced it had already retracted as false.)

## 6. Double-check: two independent routes

Every VERIFIED fact is confirmed twice, by routes that could have disagreed.

**Independent:** the published schema **and** a live response · the reference doc **and** observed behaviour · the vendor's doc **and** the vendor's own SDK source · the specification **and** a conformance test or published example.

**Not independent** — one route wearing two hats: two mirrors of the same file · a doc and an article summarising it · the same artifact read twice · two integration guides both copying the vendor · **a generated artifact and the spec it was generated from** (an SDK whose header says `Generated by: openapi-generator` cannot disagree with its own generator) · **two pages of one doc set**, or the same boilerplate published under two locales.

**Both routes must prove the same proposition.** A second artifact establishing an *adjacent* fact is not a confirmation. Split every compound claim into atomic ones and mark each on its own routes — "X is a live product type in 22 marketplaces **and** its variation theme is Y" is two claims, each with one route, not one claim with two.

**Count independence, not routes.** "✅ 4 routes" is worth nothing if two of them are the same source; write down what each route is and how it could have contradicted the other.

When the routes disagree, **record both in OPEN as a contradiction.** Do not pick the tidier one. A contradiction between a vendor's own artifacts usually means the real answer is conditional — and the condition is the fact you were trying to collect. **A contradiction you noticed while collecting belongs in the record's OPEN section**, not only in the working notes where you found it — a caveat that lives in the raw material and is dropped from the summary has been resolved by preference.

## 7. No guesswork — the moves that are banned

Each has produced a false "fact" in this repo:

- **Interpolating across cases.** Verified for one product type / market / version says nothing about another. Collect each, or leave the rest OPEN.
- **Writing the example instead of retrieving it.** A hand-built payload that satisfies the schema is the most dangerous fabrication in the record, because an instance *looks* like observation. Every example is quoted from the vendor or captured from a real response. If none was obtained, the object says `no instance retrieved`.
- **Reasoning from what would make sense.** How a competent engineer would have built it is not evidence of how it was built.
- **Filling from a summary.** A secondary source stating a structural detail is a lead. Find it in S1/S2 or leave it OPEN.
- **Completing a partial artifact.** Read half a schema, record half a schema.
- **Asserting absence.** *"There is no such field"* about an artifact you never obtained is a fabrication exactly like inventing one. Absence is only reportable for an artifact you actually read — name it — otherwise the answer is OPEN. **Report the instrument with the absence**, because absence is a property of your search as much as of the file: state the pattern, the artifact and its size, as in *"a case-insensitive search of all 226,555 bytes of `ordersV0.json` for `giftcard|gift card|gift_card` returns one hit."* Then attack your own pattern — that exact search missed `GiftCertificate`, which occurred four times, and the celebrated "exactly one hit" was a fact about the regex. Before recording any absence, list the vendor's synonyms for the thing and search for each.
- **Computing a number and attributing it.** A published *"12% don't"* is not a source for *"88% do"*. This covers counts **you** compute by tallying rows or classifying entries inside one artifact: "appears in 22 marketplace rows of the July change list" is data; "is a live product type in 22 marketplaces" is your inference wearing the vendor's voice. Record the rows; let the reader count.
- **Carrying a number between documents.** Re-read it at the origin, or attribute it to that document and its date.
- **Inferring through a block.** See §10 — the largest single source of false facts.

## 8. Where the corpus lives — never `/tmp`

An instrument needs the artifact on disk: you cannot state a byte count or a hit count for something you
streamed and dropped. So collection downloads real volume — a vendor's XSD registry ran to 42 MB, one SDL
dump to 10 MB, a PIM tarball to 72 MB. **Put all of it in `~/copilot/research/<topic-slug>/`.**

**`/tmp` on this machine is `tmpfs` — RAM, not disk.** A collection that writes its corpus there is holding
the machine's memory. Measured 2026-09-01: one run reached **5.8 GB of a 14 GB machine**, a single platform's
corpus accounting for 1.8 GB of it, and the session died mid-collection. Every completed measurement in that
run was correct; it still lost the ones in flight.

```bash
CORPUS=~/copilot/research/amazon-catalogue-2026-09   # one dir per collection
mkdir -p "$CORPUS"
curl -s --compressed "$URL" -o "$CORPUS/FoodAndBeverages.xsd"
stat -c%s "$CORPUS/FoodAndBeverages.xsd"             # the byte count your instrument cites
```

- **Never `git clone` into the repo working tree.** It surfaces as untracked files and gets committed by
  accident. Clone into the corpus dir.
- **`curl --compressed`, and measure the decompressed file**, not the transfer. A vendor CDN serving a
  gzipped `.xsd` will otherwise give you a byte count 13× too small — and that number ends up in an
  instrument, where it is wrong and looks precise.
- **Say where the corpus is** in your record, so the next reader can re-run your greps. Delete it when the
  collection is published, or state that you left it.

## 9. Collecting behaviour with a real browser

Many systems serve nothing useful to a plain HTTP fetch — the page is assembled by JavaScript, or the client is screened. A real browser collects what a person would see, and is often the independent second route for a schema fact.

**Legitimate:** pages a person could open normally, a handful at a time, to answer a specific question, where terms and `robots.txt` do not forbid it.
**Not legitimate:** bulk extraction, working around a paywall, or anything behind a login you were not given — **ask the human for credentials instead of routing around the wall.**

```bash
# Rendered HTML
NODE_PATH=$(npm root -g) node .claude/skills/external-research/scripts/fetch-page.cjs \
  "https://example.com/product/123" ~/copilot/research/<topic>/page.html

# Visible text, after a specific element exists
NODE_PATH=$(npm root -g) node .claude/skills/external-research/scripts/fetch-page.cjs \
  "https://example.com/product/123" ~/copilot/research/<topic>/page.txt --text --wait "#productTitle"

# Content injected after load, with no selector you can name yet
NODE_PATH=$(npm root -g) node .claude/skills/external-research/scripts/fetch-page.cjs \
  "https://example.com/help/article" ~/copilot/research/<topic>/a.txt --text --settle 6000

# Reuse a profile a human logged into interactively (--headed the first time)
NODE_PATH=$(npm root -g) node .claude/skills/external-research/scripts/fetch-page.cjs \
  "https://example.com/account" ~/copilot/research/<topic>/acct.html --profile ~/.cache/research-profile
```

`NODE_PATH=$(npm root -g)` resolves the global `playwright`; no `node_modules` symlink needed. On a missing-browser error, run `npx playwright install chromium` once.

## 10. A block collects nothing — say so and route around it

When a source will not load, **no data was collected**. That is the whole finding. It is never "probably says X".

**A block is a claim, and it is the claim most likely to be wrong.** "Auth-gated", "login-walled", "not published" almost always mean *one route failed*. Before writing a block down, spend real effort against it: the vendor's CDN (`images-*`, `m.media-*` paths often serve schemas, XSDs, style guides and workbooks with no auth), a different marketplace or locale of the same page, an archived capture of the origin, a regulatory filing, the vendor's own SDK or model repo, a public example inside a schema, a sibling doc page linked from one you already read. Record the attempts and their count. **Under audit, 12 of 13 rows recorded as blocked in one collection were closed without a single credential** — including one whose "no workaround exists, escalate to a human" was answered by a page linked from a page that collection had already fetched, and one "requires credentials" schema that the vendor published as a typed XSD on its CDN.

State the missing data as *data* — "the modern JSON schema was not obtained" — never as a judgement about whether it matters. Whether a gap is important is the reader's decision, and answering it for them is a conclusion (§1).

| Symptom | What it means | Next route |
|---|---|---|
| 403, or a captcha/challenge page | The system refused this client | Real browser (§9); or find where the vendor also publishes the artifact |
| 404 | This URL is wrong or gone. **Check whether the error page is generic** — many vendors serve one friendly 404 for every bad URL | Find the correct URL; never conclude the resource does not exist |
| Login wall | Credentials needed | **Ask the human.** Never paraphrase what is probably behind it |
| Near-empty HTML, JS-injected content | Needs a browser, **and often needs to wait after load** | §9 — `--settle <ms>`. A browser that captures at `domcontentloaded` can still return the empty shell; reading that as "the page has no content" is the same error as reading a soft 404 as absence. (Observed: a vendor help page returned 676 bytes of text at load and 3,295 after settling.) |
| Expiring/presigned URL, auth-only API | Authentication needed | Ask the human; decide together whether it is worth obtaining |
| 429 | Rate limited | Back off, retry, say so |
| **200 with an error page** (a "soft 404") | The URL is wrong; the status code lied | Find the correct URL. `fetch-page.cjs` reports this as `SOFT_404` — trusting the 200 is how "the vendor does not publish this" gets written down |
| Cross-host redirect not followed by the fetch tool | The vendor moved hosts | Re-request the redirect target explicitly, or use the browser, which follows it |

```
OPEN — <question>
  blocked: <url> — <symptom> — <what it would have proven> — <route tried next>
```

## 11. Currency and negative results

**Check the mechanism is current** before it enters VERIFIED — deprecation notices, changelogs, "applies to version" banners, successor APIs. A deprecated mechanism is a fact about the past; label it with the version or dates it applied to.

**A negative result is data** when it is genuinely established: *"searched N ways, artifact is not published anywhere public"* belongs in VERIFIED if the searches are recorded. It never licenses filling the gap.

## 12. Numbers measured from our own systems

Same bar, easier to miss because the data feels trustworthy. Every measured number carries **the query, the table or dataset, and the date**. A number copied from an earlier document is not a measurement — re-run it, or attribute it to that document and its date.

*Why this is here:* catalogue figures were restated across issues without re-measurement and were wrong by 10–16% by the time a decision leaned on them (#10966's appendix versus #10778).

## 13. Anti-patterns

Every row happened in this repo, in the research behind #10778.

| Anti-pattern | What it looked like |
|---|---|
| **Inferring through a block** | Every fetch blocked; confident claims about the vendor's schema published anyway |
| **Laundering a lead into a fact** | A schema from an unrelated third-party repo cited as the vendor's own |
| **Arithmetic attribution** | A published *"12% don't"* restated as *"88% do"* and credited to the publisher |
| **The sourceless number** | A specific numeric limit stated for a platform; no source existed |
| **Resolving a contradiction by preference** | Two of the vendor's own artifacts disagreed; one was quietly chosen |
| **Interpolating across cases** | A rule verified for one product type asserted for another |
| **Counting as evidence** | Systems sorted into two buckets and the tally presented as a finding, with the classification judgments invisible |
| **Building on a dead mechanism** | An argument rested on a marketplace feature that had been deprecated |
| **Gap-filling** | An artifact provably absent from public sources; conclusions written as though it had been read |

## 14. Done when

- [ ] The record contains **no recommendation, no verdict, no characterisation** of what the data means
- [ ] Every question is in **VERIFIED** or **OPEN** — nothing hedged in prose
- [ ] Every VERIFIED fact names its primary artifact, quotes the exact fragment, and cites **two independent routes**
- [ ] Every object, field and enum value is written exactly as the system spells it; every relationship states cardinality
- [ ] **Every object carries one real example** — an instance *of that object*, quoted from the vendor or captured from a real response, with the route recorded — or says `no instance retrieved` and what would produce one. No example was written by hand, including inside diagrams
- [ ] Every table, enum and list is reproduced whole, or names the rows left out and why; every quote runs to the end of its clause, with elisions marked
- [ ] Every ✅ names two routes that prove **the same proposition** and could have contradicted each other — no generated-from-spec artifact, no two pages of one doc set, no same text in two locales
- [ ] Every diagram node has a section; every diagram edge names its artifact
- [ ] Every block was attacked with several named routes before being recorded, and states the absent data rather than judging its importance
- [ ] Every absence names the artifact, its size and the search pattern — and the vendor's synonyms were searched too
- [ ] The sample was fixed before collection, and every member is reported — including inconvenient and unfinished ones
- [ ] A deliberate search for counter-evidence was run and its result recorded
- [ ] No P2/P3 artifact supports a VERIFIED fact
- [ ] Every OPEN row states what would settle it and the route tried
- [ ] Every mechanism relied on was checked as current
- [ ] Every number was read at its origin; measured numbers carry query + dataset + date

## 15. A worked sample

**#10994 — "How Amazon models gift cards"** is the reference implementation of this skill: questions and sample fixed up front, blocks attacked and reported with attempt counts, one real retrieved example per object, diagrams whose every edge names an artifact, contradictions left unresolved in OPEN, and a section recording what its own first revision got wrong.

Read its **§9** first. Every rule added to this skill after the first draft exists because that revision broke it — and its defects (a table quoted at 4 of 7 rows, an enum at 1 of 6, an invented diagram node, a truncated quote that reversed its own meaning, a blocked row that was one unauthenticated fetch from closing) are the failure modes to expect in your own draft.
