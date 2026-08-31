# Deal Hunter scoring and operator triage

Phase 3A turns Deal Hunter scoring into a durable, explainable operator decision system. It is decision support. It sends nothing, drafts nothing, and decides nothing on its own.

## What the score is, and is not

`fitScore` is the `deal-hunter-fit-v2.1` score. Phase 3A did not change the acquisition scoring philosophy; it recorded the one already in production. Phase 3A.1 corrected which keyword occurrences count (see [Semantic matching](#semantic-matching)) without touching a single weight, threshold, band, cap or gate. An optional ledger is threaded through the existing scorer and observes each rule as it fires, so the number in the queue is the number the scorer computed, by construction rather than by approximation. A 506-case frozen corpus asserts this case by case.

A future scoring philosophy change must ship under a new rules version. It must not be called `deal-hunter-fit-v2`.

Three readings are kept separate and are never combined into one number:

| Reading | Meaning |
| --- | --- |
| `fitScore` (0–100) | How well the listing matches the acquisition profile. |
| `confidence` (low/medium/high) | How much evidence the sources actually supplied, from `completenessScore`. |
| `gates` | Hard disqualifiers. A gated listing can never be actionable regardless of score. |

A high score with low confidence is a research task, not a contact task. That is why confidence is a separate column and a separate sort key rather than a discount applied to the score.

## Dimensions

Every point, cap, and gate is attributed to one of seven dimensions. These describe the existing v2 rules; they are not a new weighting.

| Dimension | Covers |
| --- | --- |
| Financial fit | Profit band, profit multiple, implied multiple, asking-price band, financing signals. |
| Revenue durability | Recurring, contracted, and repeat revenue; commercial customer mix. |
| Demand resilience | Recession resistance and resistance to automation of the operating work. |
| Transferability | Management depth versus owner dependence. |
| Operating profile | Capital intensity and asset burden. |
| Concentration and quality risk | Customer concentration and financial-quality risk language. |
| Strategic and geographic fit | Search-theme match, business age, target geography, category exclusions. |

Each dimension reports a verdict: `supported`, `mixed`, `negative`, or `absent`.

## Semantic matching

Keyword families are matched by a bounded deterministic matcher rather than plain substring search. A term still matches wherever it matched before **unless** a documented rule suppresses that occurrence, and a term still counts if any one of its occurrences survives.

| Suppression reason | Meaning | Example |
| --- | --- | --- |
| `negated-positive` | A negator precedes a positive term | "no recurring revenue" |
| `negated-risk` | A negator precedes a risk term | "no customer accounts for more than 10%" |
| `favorable-qualifier` | A favorable word directly qualifies a risk term | "low customer concentration" |
| `adverse-context` | The positive term sits in an adverse clause | "losing maintenance contracts" |
| `future-or-conditional` | A plan rather than a current fact | "plans to add service agreements" |
| `historical-only` | A past state rather than a current one | "formerly had maintenance contracts" |
| `longer-phrase-precedence` | A longer opposite-polarity phrase owns the span | "low customer concentration" over "customer concentration" |

**Negation scope is bounded to the clause.** It stops at sentence punctuation, at a semicolon, at an adversative conjunction (`but`, `however`, `although`, `yet`), and after six tokens. `not only` is treated as emphasis, not negation. A `non-` prefix suppresses the term it negates, while a hyphenated keyword such as `non-discretionary` still scores as itself.

**Category gates are deliberately excluded from suppression.** Falsely suppressing a gate would admit a disqualified listing; a false gate is merely reviewable. The expensive error is the one that is prevented.

**One documented limitation:** negation does not model English coordination, so a positive term sharing a clause with an earlier negator is conservatively withheld. Breaking the window on `and` would fix "revenue is no longer declining and maintenance contracts renew annually" but would wrongly accept "no maintenance contracts and recurring revenue", where negation legitimately distributes. Withholding credit is the safe direction, and a sentence break recovers the positive.

Suppressed occurrences are recorded on the score result, so an operator can see why a listing that mentions a term did not score for it.

## The absent-evidence rule

There is exactly one rule, and it is enforced by tests:

> **Absent evidence never deducts points.** It may cap the achievable score, which bounds upside without asserting a negative, and it always lowers completeness and confidence. Only observed negative evidence deducts points.

A listing that says nothing about management is `absent` and capped. A listing that states the owner performs all sales is `negative` and deducted. The second scores below the first, and a test asserts that ordering. The same distinction holds for concentration, capex, and recurring revenue: missing information is never treated as a bad answer.

Unknown annual profit is the clearest case: it caps the listing below high fit and lowers confidence, but deducts nothing, because "not disclosed" is not "unprofitable".

## Gates

Gates are hard disqualifiers, not large deductions: an excluded category, a franchise listing. A gated opportunity keeps its dimension values so you can see why it looked attractive, but it never surfaces as actionable and never appears in a working view. The gate reason is persisted and shown in the drawer.

## Evidence classes

Every scoring contribution is traceable to a persisted evidence row naming the rule and the source behind it. A dimension explanation is reconstructable from those rows alone.

| Class | Meaning | Affects the score |
| --- | --- | --- |
| `observed` | Read straight from a source field. | Yes |
| `calculated` | Derived deterministically from observed values. | Yes |
| `heuristic` | Matched the profile keyword lists against the listing narrative. | Yes |
| `missing` | The source did not supply an expected field. | Confidence only |
| `contradicted` | Two sources disagree materially; the canonical value was preserved. | Confidence and visibility only |
| `inferred` | Reserved for a future model-assisted phase. | **Phase 3A never produces this class.** |

Contradictions come from the existing `fieldConflicts` work and surface as evidence, as confidence reasons, and as a queue filter. They do not silently move the score.

## Fingerprints and rescoring

Two digests answer two different questions:

| Digest | Covers | Answers |
| --- | --- | --- |
| `score_fingerprint` | scoring inputs **plus** every version, including the matcher version | "does this row have the same scoring-input/version identity?" |
| `semantic_digest` | what the score concludes: score, status, confidence, completeness, eligibility, gates, caps, per-dimension contribution and verdict, missing evidence, and reviewer-visible contradiction field/canonical/observed values — and **no** version or observation-provenance field | "are the persisted conclusions and core evidence still current, and should a human look again?" |

`score_fingerprint` is a digest of the normalized inputs that can actually change a score, plus the engine, rules, profile, completeness-policy, and semantic-matcher versions.

It deliberately **excludes** observation bookkeeping — first seen, last seen, `isNew`, generated notes, per-run metadata, and fields such as `netMargin` that no scoring branch reads. The semantic digest likewise excludes evidence provenance such as `observedAt`, source observation timestamps, source record IDs, source names, and listing-observation metadata. Including volatile timestamps in either digest would make every opportunity look permanently changed.

Normal persistence currentness requires the fingerprint, semantic conclusions,
and engine/rules/profile/completeness-policy versions to match the fresh
deterministic result. The only compatibility form is a contradiction-bearing
v111 semantic digest: it is considered semantically equivalent only when one
batched evidence read proves that its persisted contradiction
field/canonical/observed values exactly match the fresh core. There is no
per-opportunity evidence lookup.

An operator-reviewed equivalent v111 row is left byte-for-byte alone so changing
digest encoding cannot manufacture review staleness. An unreviewed equivalent
row is migrated once as a silent version-only rewrite, which gives strict
post-refresh digest convergence without an activity event. A same-count
contradiction value change is not equivalent: it remains a semantic/evidence
write and becomes changed-since-review when applicable.

If an operator-reviewed equivalent v111 row later needs an otherwise
version-only rewrite, the machine updates its fingerprint and versions while
retaining the exact legacy semantic digest the operator acknowledged. That
preserves the existing reviewed-semantic-digest contract without allowing stale
core contradiction evidence.

Only a current row is skipped completely: no score write, no evidence
replacement, no activity event, and `scored_at` does not move. A rules, engine,
profile, or completeness-policy version bump forces a rescore rather than
serving a score computed under retired policy. A same-fingerprint semantic
change — for example, stale contradiction evidence — also forces a normal
non-force rewrite.

When a score changes, the score row and all of its evidence are replaced together — one SQLite transaction, one Supabase security-definer function — so evidence can never describe a superseded fingerprint.

For recovery audits, compare deterministic **core evidence** separately from full provenance. Core evidence includes dimensions, rule IDs, evidence classes, fields, values, observed contradiction values, and terms. A core mismatch means persisted scoring evidence is stale. A full-provenance-only mismatch may simply mean a source was observed again under a new row ID or timestamp; it is expected observation churn and does not by itself require a score rewrite.

## Where scoring runs

- After a Deal OS import, over the listings that import produced.
- After a full backfill review.
- On explicit admin refresh: `POST /api/admin/deal-hunter/scores/refresh`.

Scoring never runs on page load. Acquisition Inbox and Opportunity View read persisted rows only, so opening the Inbox, paging or filtering the queue, and opening an opportunity cannot trigger a rebuild or refresh a source.

A refresh is bounded and resumable. Pass `opportunityIds` to scope it. A failure on one opportunity is recorded and the batch continues, so a retry redoes only what did not land. Forcing a rebuild of every score requires typing `REBUILD ALL SCORES`.

## Scoring versions and what a bump does

| | Value |
| --- | --- |
| Previous rules version | `deal-hunter-fit-v2` |
| Current rules version | `deal-hunter-fit-v2.1` |
| Semantic matcher version | `deal-semantic-matcher-v1` |

A rules bump stales every stored `score_fingerprint`, so every opportunity is rescored. That is intended: a score computed under retired semantics must not be served as current. What is **not** intended is treating that rewrite as something a human must re-review.

`changed_since_review` therefore compares `reviewed_semantic_digest` against `semantic_digest` — conclusions against conclusions. A rescore that reproduces the same conclusions is a **version-only rewrite**: the row is updated, no `opportunity.rescored` event is emitted, and the operator's review stands. Rows reviewed before digests existed fall back to the previous fingerprint comparison.

Before any broad rescore, run the preview (`POST /api/admin/deal-hunter/scores/refresh/preview`). It writes nothing and reports newly scored, unchanged, version-only, semantic change, score/classification/gate change, evidence-only change, high-fit and watchlist movement both ways, newly gated and gates lifted, and how many operator-prioritized and reviewed rows are affected. Execute only once those counts look right.

**Rollback:** v2.1 is additive in storage terms — two nullable columns and a corrected matcher. Reverting the code returns scoring to v2 semantics; stored rows keep their `rules_version`, so a row's provenance is always legible. The demonstrated v2 false positives would return.

## Machine ownership versus operator ownership

| Owner | Fields |
| --- | --- |
| Deal Hunter | fit score, dimensions, confidence, completeness, gates, evidence, scoring versions, fingerprint, semantic digest, scored-at |
| Operator | priority, note, reviewed-at, reviewed-by, reviewed-fingerprint, reviewed-semantic-digest |

These are written by two separate storage operations with disjoint column lists. The machine write **throws** if its payload carries any operator-owned key; the operator write cannot reach a scoring column at all. There is no generic upsert spanning both. An import, reconciliation, CRM sync, rescore, forced refresh, or retry therefore cannot erase a human decision, and tests assert that across every one of those paths.

### There is no numeric score override

An operator sets **priority** — `urgent`, `high`, `normal`, `watch` — rather than rewriting the machine's number. "Machine says 71, operator says urgent" stays legible; an artificial 83 would not. The machine score keeps updating underneath a priority, and the queue shows the divergence rather than resolving it.

## Acquisition Inbox and triage views

`/admin/deal-hunter` opens **Inbox** as the default daily decision surface. Start in **Needs Review**, which presents the authoritative persisted current opportunity set in acquisition-priority order. Open an opportunity in the right-side Opportunity View to inspect financials, broker/seller facts, evidence, source provenance, CRM/CIM context, and history without leaving or resetting the queue.

**Operations** is the separate administrative surface for source review, Deal OS import, score refresh/backfill, diagnostics, daily email, CIM/follow-up controls, and other explicitly triggered work. Merely browsing Inbox or Opportunity View does not run scoring, import data, refresh sources, send a CIM request, activate Stage 2, or send outreach.

Pursue and Watch acknowledge the current semantic score state and set operator-owned priority while leaving the machine score unchanged. Pass uses the durable disposition path, records a reason and optional note, and remains visible in the Passed view and history. Verified operator facts are stored separately from source observations, outrank lower-authority source/CRM claims, and survive later source refreshes; the lower-authority claims remain visible as provenance.

Views are derived from state that already exists. No new workflow state machine was introduced.

| View | Derivation |
| --- | --- |
| Needs review | Never reviewed, or `reviewed_semantic_digest` differs from `semantic_digest`; legacy reviews without a semantic digest fall back to fingerprint comparison. |
| High priority | High-fit listings, plus anything the operator marked `urgent` or `high`. |
| Watchlist | The existing 60–74 band, plus anything marked `watch`. |
| Low confidence | `confidence = low`, or the sources contradict each other. |
| Passed | The existing `deal_hunter_dispositions` record. |
| All current | Every nondismissed opportunity with a persisted current score. |

Working views exclude dismissed and gated listings. **Changed since reviewed** is derived from the semantic digest the operator acknowledged, with the same legacy fingerprint fallback, rather than stored as its own flag. A version-only or volatile-provenance-only rewrite therefore does not manufacture human review work.

Dismissal remains owned by the existing disposition mechanism, and acquisition progress remains owned by the command center's pipeline stage. Triage does not duplicate either.

Needs Review defaults to acquisition-priority order: urgent/high operator priority; high-fit opportunities that are new or materially changed; fit score; confidence; observation freshness; and a deterministic final tie-breaker. Other views retain their explicit selected sort. The final key means pagination stays stable when rows tie.

## Audit trail

- `opportunity.rescored` — emitted when human-relevant score conclusions or core contradiction evidence change. Carries a change kind, previous and new score, both fingerprints, confidence, rules version, and the dimensions whose contribution changed. Numerical changes say the score moved; evidence-only changes truthfully say evidence changed while the fit score remained constant. Version-only and volatile-provenance-only rewrites emit nothing.
- `opportunity.triaged` — emitted when an operator sets priority, adds a note, or marks an opportunity reviewed.

Both attach to the opportunity's linked CRM record. A sourced opportunity with no CRM record has nothing to attach to; its score row and fingerprint are the audit trail in that case.

## What Phase 3A intentionally does not do

- **No model calls.** There are no prompts, no provider configuration, and no key requirement. Scoring, triage, evidence, and overrides all work at full fidelity with no model provider configured. The `inferred` evidence class exists in the schema so a later phase adds no migration, but nothing in Phase 3A can produce it.
- **No growth-opportunity score.** A broker listing contains no reliable growth evidence, so scoring one would be speculation presented as measurement. Record a growth thesis in the operator note instead.
- **No outreach.** No drafting, no sending, no cadences, no Gmail, no scheduling. Triage decides what deserves attention; contacting a broker remains the existing, separately governed CIM flow.
- **No autonomous decisions.** Nothing is dismissed, advanced, or contacted without an operator acting.

## Operating checklist

1. Use **Deal Hunter → Operations** only when you intentionally need source review, Deal OS import, or a full backfill. Those explicit operations score affected listings; opening Inbox does not.
2. Open **Deal Hunter → Inbox → Needs Review** and work the acquisition-priority queue.
3. Open **Opportunity View** to inspect Score & Evidence, source provenance, financials, contacts, missing information, CRM/CIM context, and history before acting.
4. Choose **Pursue** or **Watch** to acknowledge the current semantic score state and set operator priority. The machine score stays unchanged, and neither action sends a CIM request or activates Stage 2.
5. Add or correct a verified operator fact when direct information outranks a source claim. Later source refreshes remain visible but cannot overwrite the verified value.
6. Choose **Pass**, enter the reason and optional note, and confirm. The opportunity leaves active daily triage but remains available in **Passed** with its original score and disposition history.
