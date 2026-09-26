# Fact base — <system> · <topic>

**Questions, each stated so a source could prove it wrong:**

1. <…>
2. <…>

**Sample — fixed before collecting.** Which systems/artifacts are in scope and why.
Every member gets reported below, including inconvenient and unfinished ones.

| In scope | Why | Status |
|---|---|---|

> **This document contains data only.** No recommendation, no verdict, no
> characterisation of what the data means, no counts or trends across systems.
> The reader draws the conclusion.

---

## VERIFIED

Admission: primary artifact (S1–S3) + exact quote or fragment + **two independent
routes** that could have disagreed.

### Objects

| Object | What it is | Identified by | Created by |
|---|---|---|---|
| `<ExactName>` | | `<field>` | |

### Examples — one real instance per object

Quoted from the vendor or captured from a real response. **Never written by hand**
— a constructed payload looks like observation and is not. An object with no
instance says so, and names what would produce one. Redacted secrets stay marked
as redacted; a substituted value is a fabrication.

| Object | Instance | How it was obtained | Artifact |
|---|---|---|---|
| `<ExactName>` | *(paste it — response body, record, published sample)* | searched · `GET <url>` · vendor sample | |
| `<ExactName>` | `no instance retrieved` | — | *what would produce one* |

### Relationships

| From | Cardinality | To | Via field | Required? |
|---|---|---|---|---|
| `<A>` | `1..N` | `<B>` | `<field>` | required |

### Fields

Every field the questions touch — including ones that cut against the shape that
seems to be emerging. Omitting a field for looking unimportant is a judgment.

| Object.field | Type | Constraint / allowed values | Artifact |
|---|---|---|---|
| `<obj>.<field>` | | *(values, or "enumerated, N values, not collected")* | |

### Rules (verbatim)

| Quote | Artifact |
|---|---|

### Evidence

| # | Fact | Route 1 (artifact + quote) | Route 2 — independent | Retrieved | Prov. |
|---|---|---|---|---|---|
| 1 | | | | | P0 |

Provenance: `P0` vendor's own domain/repo · `P1` vendor-published, traceable redistribution · `P2` third party asserts vendor origin · `P3` unknown.
**P2/P3 never appear here** — they are leads pointing at the P0/P1 artifact.

---

## OPEN

Not yet collected. Each row names what would settle it. The honest edge of the
data, and the thing to escalate — not a failure.

| # | Question | Why still open | What would settle it | Route tried |
|---|---|---|---|---|

### Blocked

```
OPEN — <question>
  blocked: <url> — <symptom> — <what it would have proven> — <route tried next>
```

### Contradictions — reported, never resolved by preference

| Question | Source A says (quote) | Source B says (quote) | Why it matters |
|---|---|---|---|

### Counter-evidence search

Run deliberately against whatever shape the data seems to be forming. Record the
result even when it is "nothing found".

| Shape tested against | How it was searched | Result |
|---|---|---|

### Negative results

Searched for and genuinely not found — data, when the searches are recorded.

| Looked for | Searches run | Outcome |
|---|---|---|

---

## Needs a human

Credentials, an account, or a purchase that would close an OPEN row — with what it
would settle, so the cost is a decision rather than an assumption.

| OPEN row | What is needed | What it would settle |
|---|---|---|

---

## Observations for the reader

Optional, and **kept out of the data above**. Phrased as questions, never as
findings or recommendations.

- <e.g. "Field X is required here but optional in the sibling artifact — worth a look?">
