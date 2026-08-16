# Deal Hunter scoring and operator triage

Phase 3A turns Deal Hunter scoring into a durable, explainable operator decision system. It is decision support. It sends nothing, drafts nothing, and decides nothing on its own.

## What the score is, and is not

`fitScore` is the `deal-hunter-fit-v2` score. Phase 3A did not change the acquisition scoring philosophy; it recorded the one already in production. An optional ledger is threaded through the existing scorer and observes each rule as it fires, so the number in the queue is the number the scorer computed, by construction rather than by approximation. A 506-case frozen corpus asserts this case by case.

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

`score_fingerprint` is a digest of the normalized inputs that can actually change a score, plus the engine, rules, profile, and completeness-policy versions.

It deliberately **excludes** observation bookkeeping — first seen, last seen, `isNew`, generated notes, per-run metadata, and fields such as `netMargin` that no scoring branch reads. Including volatile timestamps in a digest is what previously made the reconciliation preview classify every unchanged record as a write; the same mistake here would make every opportunity look permanently changed.

When the fingerprint and every version match what is stored, the opportunity is skipped completely: no score write, no evidence replacement, no activity event, and `scored_at` does not move. A rules, engine, or profile version bump forces a rescore rather than serving a score computed under retired rules.

When a score changes, the score row and all of its evidence are replaced together — one SQLite transaction, one Supabase security-definer function — so evidence can never describe a superseded fingerprint.

## Where scoring runs

- After a Deal OS import, over the listings that import produced.
- After a full backfill review.
- On explicit admin refresh: `POST /api/admin/deal-hunter/scores/refresh`.

Scoring never runs on page load. The triage queue reads persisted rows only, so opening the workspace or paging through it cannot trigger a rebuild.

A refresh is bounded and resumable. Pass `opportunityIds` to scope it. A failure on one opportunity is recorded and the batch continues, so a retry redoes only what did not land. Forcing a rebuild of every score requires typing `REBUILD ALL SCORES`.

## Machine ownership versus operator ownership

| Owner | Fields |
| --- | --- |
| Deal Hunter | fit score, dimensions, confidence, completeness, gates, evidence, scoring versions, fingerprint, scored-at |
| Operator | priority, note, reviewed-at, reviewed-by, reviewed-fingerprint |

These are written by two separate storage operations with disjoint column lists. The machine write **throws** if its payload carries any operator-owned key; the operator write cannot reach a scoring column at all. There is no generic upsert spanning both. An import, reconciliation, CRM sync, rescore, forced refresh, or retry therefore cannot erase a human decision, and tests assert that across every one of those paths.

### There is no numeric score override

An operator sets **priority** — `urgent`, `high`, `normal`, `watch` — rather than rewriting the machine's number. "Machine says 71, operator says urgent" stays legible; an artificial 83 would not. The machine score keeps updating underneath a priority, and the queue shows the divergence rather than resolving it.

## Triage views

Views are derived from state that already exists. No new workflow state machine was introduced.

| View | Derivation |
| --- | --- |
| Needs review | Never reviewed, or `reviewed_fingerprint` differs from `score_fingerprint`. |
| High priority | High-fit listings, plus anything the operator marked `urgent` or `high`. |
| Watchlist | The existing 60–74 band, plus anything marked `watch`. |
| Low confidence | `confidence = low`, or the sources contradict each other. |
| Dismissed | The existing `deal_hunter_dispositions` record. |
| All scored | Everything with a persisted score. |

Working views exclude dismissed and gated listings. **Changed since reviewed** is derived from the fingerprint the operator acknowledged, not stored as its own flag, so it can never drift out of step with the score.

Dismissal remains owned by the existing disposition mechanism, and acquisition progress remains owned by the command center's pipeline stage. Triage does not duplicate either.

Default sort is fit score descending, then confidence, then opportunity id. The final key means pagination stays stable when rows tie.

## Audit trail

- `opportunity.rescored` — emitted only when a score actually moved. Carries previous and new score, both fingerprints, confidence, rules version, and the dimensions whose contribution changed. A fingerprint-identical refresh emits nothing.
- `opportunity.triaged` — emitted when an operator sets priority, adds a note, or marks an opportunity reviewed.

Both attach to the opportunity's linked CRM record. A sourced opportunity with no CRM record has nothing to attach to; its score row and fingerprint are the audit trail in that case.

## What Phase 3A intentionally does not do

- **No model calls.** There are no prompts, no provider configuration, and no key requirement. Scoring, triage, evidence, and overrides all work at full fidelity with no model provider configured. The `inferred` evidence class exists in the schema so a later phase adds no migration, but nothing in Phase 3A can produce it.
- **No growth-opportunity score.** A broker listing contains no reliable growth evidence, so scoring one would be speculation presented as measurement. Record a growth thesis in the operator note instead.
- **No outreach.** No drafting, no sending, no cadences, no Gmail, no scheduling. Triage decides what deserves attention; contacting a broker remains the existing, separately governed CIM flow.
- **No autonomous decisions.** Nothing is dismissed, advanced, or contacted without an operator acting.

## Operating checklist

1. Import a Deal OS export or run a full backfill. Both score the affected listings automatically.
2. Open **Deal Hunter → Triage** and work **Needs review**.
3. Use **Why this score** to check the evidence before acting, especially where confidence is low or fields are missing.
4. Set priority where your judgment differs from the machine's. The score stays as it was.
5. Mark reviewed. The opportunity leaves the queue until its inputs actually change.
6. Dismiss through the existing disposition action, not by lowering a score.
