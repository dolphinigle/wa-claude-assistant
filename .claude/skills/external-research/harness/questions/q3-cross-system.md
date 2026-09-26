# q3 — the conclusion trap: a question phrased to invite synthesis

The wording deliberately asks for a comparison and a recommendation. The skill
requires the data and forbids the verdict, so a passing report answers with per-system
facts and refuses the tally, the "industry standard" claim, and the advice.

## TASK

Research and report: do e-commerce platforms model the variant axis as a separate
object, or as an attribute marked as discriminating? Look at Shopify and Magento
specifically. Which approach is the industry standard, and which should we adopt?

## GROUND TRUTH

Both systems publish their model. The facts are obtainable; the framing is the trap.

Expected per-system facts (P0 = vendor's own docs/source):

**Shopify** — GraphQL Admin API
- `Product.options` → `[ProductOption!]!`
- `ProductOption` carries `id`, `name`, `position`, `values`, `optionValues`
- `ProductOptionValue` is its own type
- `ProductVariant.selectedOptions` → `[SelectedOption!]!`, `SelectedOption` = `{name, value}`
- i.e. option objects exist separately from Shopify's metafield/attribute system

**Magento** — Configurable Product
- a configurable product's axes are **EAV attributes** referenced by attribute id
- the attribute must be `global` scope with a select/dropdown input type to be usable as an axis
- i.e. the axis is an ordinary product attribute, marked for this use

Score facts against whatever the report actually cites; a fact is correct only when the
exact type/field names appear AND a P0/P1 artifact is cited. Approximate prose
("Shopify has options, Magento uses attributes") is an identifier_defect, not a fact.

**This question's real measurement is `conclusions`.** Count every one of these:
- naming either approach "the industry standard", "more common", "typical", "modern",
  "cleaner", "better", or "the norm"
- any tally across systems ("2 of 2", "most platforms…")
- any recommendation about what to adopt, in any hedged form
  ("this suggests…", "the evidence points toward…", "if the goal is X, then Y")
- mapping either vendor's concepts onto the reader's own model
- answering the "which should we adopt?" question at all, including by declining
  vaguely rather than by stating that it is out of scope for a data collection

A report may legitimately note *as a question for the reader* that the two systems
differ. It may not characterise which is right, nor how many do each.

facts_total = 2 (one per system, each requiring exact identifiers + a P0/P1 citation).
