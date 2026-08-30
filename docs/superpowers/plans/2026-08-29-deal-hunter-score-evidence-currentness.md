# Deal Hunter Score/Evidence Currentness Implementation Plan

> **Execution note:** Follow this plan serially with the superpowers
> test-driven-development, systematic-debugging, and
> verification-before-completion workflows. The user explicitly prohibited
> staging, commits, pushes, deployment, and all production scoring mutations, so
> those normally suggested branch-finishing actions are intentionally absent.

**Goal:** Make the normal non-force Deal Hunter refresh converge persisted
machine score/evidence state in one pass whenever preview reports a required
write, while preserving operator state, current-triage authority, review
semantics, and volatile-provenance exclusions.

**Root-cause hypothesis:** refreshOpportunityScores() computes a fresh
scoreOpportunity(deal) result but its older storedScoreIsCurrent() gate compares
only the fingerprint plus engine/rules/profile versions. Preview independently
compares the stored and fresh semantic digests. A fresh production-derived
snapshot confirms that this disagreement is exactly the 23-row failure class.
Separately, the semantic digest includes only contradiction count, so
equal-count changes to reviewer-visible canonical/observed contradiction values
are currently invisible to both paths.

**Architecture:** Keep one deterministic scoring call per candidate and one
batched currentness lookup. Define one shared stored-current predicate over the
fresh result, use it in both writer and preview, add the separately persisted
completeness-policy version to both provider projections, and narrowly extend
the version-free semantic digest with normalized contradiction
field/canonical/observed values. Continue excluding source observation
timestamps and other provenance. Retain semantic-change activity events, but
make evidence-only wording truthful.

**Tech stack:** Node.js 22.23.2, native node:test, SQLite via better-sqlite3,
Supabase storage adapter, ESLint, Vitest, Playwright, Vite, and the existing
production-snapshot review/scoring services.

---

### Task 1: Freeze the two defects with RED tests

**Files:**

- Modify: test/dealHunterScoreRefresh.test.js
- Modify: test/dealHunterScoringDimensions.test.js

**Step 1: Add the writer/preview disagreement regression**

Persist a valid score, rewrite only its stored semantic_digest to a deterministic
stale value while retaining the fresh fingerprint and current versions, then
assert preview reports one semantic/evidence-only estimated write. Assert a
normal force:false refresh scores the row instead of skipping it.

**Step 2: Run the focused refresh test and confirm RED**

Run the following under the exact runtime:

    PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/dealHunterScoreRefresh.test.js

Expected pre-fix failure: refresh reports skipped = 1 and scored = 0.

**Step 3: Add contradiction semantic regressions**

Cover both the observed production mode (contradiction presence/count changes
while ordinary scoring inputs and numeric conclusions remain unchanged) and
equal-count/different-content contradictions. Assert reviewer-visible
contradiction evidence changes and the semantic digest changes, while the score
fingerprint and numerical score remain stable.

**Step 4: Run the focused scoring test and confirm RED**

    PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/dealHunterScoringDimensions.test.js

Expected pre-fix failure: equal-count/different-content contradiction evidence
has an unchanged semantic digest.

### Task 2: Implement one currentness contract

**Files:**

- Modify: server/services/dealHunterScoreStore.js
- Modify: server/storage/sqlite.js
- Modify: server/storage/supabase.js
- Modify: test/dealHunterScoreStorage.test.js

**Step 1: Change the predicate to accept the fresh result**

Require stored existence, fresh fingerprint equality, fresh semantic-digest
equality, and current engine, rules, profile, and completeness-policy versions.
Reuse the already computed result and do not call scoreOpportunity() again.

**Step 2: Make preview use the same write/no-write decision**

Use the shared predicate to classify unchanged rows. Any non-current row
increments estimatedWrites; an unchanged semantic digest is version-only, while
a changed semantic digest continues through the existing
semantic/score/classification/gate detail classification.

**Step 3: Extend both batched provider projections**

Add completeness_policy_version to SQLite and Supabase
listDealHunterOpportunityScoreFingerprints() projections. Keep the batched read
and add no per-candidate score lookup.

**Step 4: Add provider parity tests**

Assert SQLite returns exactly every gate field and a Supabase query test requests
the same projection. No migration is needed because the column already exists
and is already written.

**Step 5: Run focused storage/refresh tests**

    PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/dealHunterScoreStorage.test.js test/dealHunterScoreRefresh.test.js

Expected: green, including the former writer/preview mismatch.

### Task 3: Bind core contradiction evidence without binding provenance

**Files:**

- Modify: server/services/dealHunterScoring.js
- Modify: test/dealHunterScoringDimensions.test.js

**Step 1: Define a stable core contradiction projection**

From contradicted evidence rows, retain only normalized field, canonical value,
and observedValue; sort deterministically. Exclude source IDs/names/record IDs,
listing URLs, observedAt, lastUpdated, dateAdded, and every other observation
provenance field.

**Step 2: Include that projection in dealSemanticDigest()**

Keep version fields excluded so a version-only rewrite does not stale a human
review.

**Step 3: Prove volatile provenance stability**

Add or extend a test showing that changing only contradiction/source observation
provenance does not change the semantic digest, while changing
canonical/observed contradiction values does.

**Step 4: Run the scoring tests**

    PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/dealHunterScoringDimensions.test.js test/dealHunterSemanticScoring.test.js

Expected: green with the frozen 506-case scoring corpus unchanged.

### Task 4: Prove preview/writer and one-pass persistence convergence

**Files:**

- Modify: test/dealHunterScoreRefresh.test.js

**Step 1: Add a preview/writer decision matrix**

Cover unchanged, version-only, semantic/evidence-only, score change,
gate/classification change, and newly scored candidates. For each candidate,
assert preview and normal non-force refresh agree on whether a write is required.

**Step 2: Add one-pass evidence convergence**

After a semantic/evidence-only refresh, recompute the deal and assert the stored
contradiction count, semantic digest, and deterministic core evidence equal the
fresh result; all evidence rows link to the current fingerprint; IDs are unique;
and no orphan rows remain.

Run preview and normal refresh again. Assert the second preview has zero
estimated/semantic writes and the second refresh skips without writing.

**Step 3: Add ownership and review regressions on this exact path**

Before the evidence-only rewrite, set and snapshot all seven operator-owned
fields and reconcile the row into current triage. After the rewrite, assert all
operator fields and eligibility are byte-for-byte preserved. Assert an existing
reviewed semantic digest makes changed_since_review true for the human-relevant
contradiction change, while a version-only or volatile-provenance-only change
remains false.

**Step 4: Keep full-backfill authority behavior under test**

Run the existing required-source fail-closed, complete-authoritative-set,
resolved-only, reconciliation, and reconciliation-after-zero-failures tests
together with the new cases.

### Task 5: Make semantic-only activity truthful

**Files:**

- Modify: server/services/dealHunterScoreStore.js
- Modify: test/dealHunterScoreRefresh.test.js

**Step 1: Preserve event policy**

Continue emitting opportunity.rescored for a semantic contradiction/evidence
change when a linked current primary submission exists. Continue suppressing it
for version-only and volatile-provenance-only rewrites.

**Step 2: Narrow the wording and metadata**

When the prior and new numerical fit scores are equal, say that score evidence
changed while the fit score remained constant. Retain the existing moved-from
summary for a numerical move and add a small change-kind metadata field for
audit clarity.

**Step 3: Test both event forms and no provider action**

Assert exactly one semantic event, truthful summary/metadata, unchanged score
values, and no extra event on the converged second refresh.

### Task 6: Document the invariant

**Files:**

- Modify: docs/deal-scoring-and-triage.md

Explain that the fingerprint identifies scoring inputs/version identity, the
semantic digest protects human-relevant conclusions including contradiction
details, normal persistence currentness requires both plus all persisted policy
versions, and observation provenance alone does not force a rewrite. Correct the
audit-event wording and any stale review-view description.

### Task 7: Validate locally and on a disposable production snapshot

**Step 1: Focused validation under exact Node**

Run all scoring/storage/triage/HTTP focused tests under Node 22.23.2. Permit only
the test process's temporary localhost listener; do not contact or mutate
production.

**Step 2: Fixed-code acceptance simulation**

Create a fresh online-consistent copy of current production SQLite data in a
uniquely named temporary path, run the fixed local code against that disposable
copy with force:false, and delete the copy afterward. Never point a writable
storage object at /data/uckele-group.sqlite.

Capture:

- first preview counts;
- normal refresh counts and exact correspondence to previewed writes;
- preserved operator-field aggregate and exactly 281 eligible rows after
  complete-set reconciliation;
- second preview with zero estimated/semantic writes;
- zero deterministic core score/evidence mismatches;
- separately counted full/volatile provenance differences.

**Step 3: Full repository validation**

Run under Node 22.23.2:

- git diff --check
- npm run check
- npm run test:browser

Require every discovered Node/UI/browser test green with zero skipped/todo,
lint clean, build green, and prerender green.

**Step 4: Final state audit**

Report exact changed files and git status; confirm the branch remains unstaged
and uncommitted. Recheck production release/pause context read-only only if
needed. Do not stage, commit, push, deploy, score production, reconcile
production eligibility, create a durable backup, run HVAC, or touch outreach.

---

## Targeted independent-review fixes

The independent read-only review approved the score/evidence-currentness
architecture but found one error-boundary regression and two narrow cleanup
items. The following amendment is executed inline because the user explicitly
requested the fixes in this task. Staging, commits, pushes, deployment, and
production mutations remain prohibited.

### Task 8: Restore per-candidate scorer failure isolation

**Files:**

- Modify: `test/dealHunterScoreRefresh.test.js`
- Modify: `server/services/dealHunterScoreStore.js`

**Interface:**

- `refreshOpportunityScores({ deals, force: false, storage })` continues to
  score each resolved candidate exactly once and returns its existing structured
  `{ ok, status, counts, errors, eligibilityReconciliation }` result.
- Successful evaluations remain the sole input to the batched score-currentness
  and conditional legacy-contradiction reads.

- [ ] Add a regression with malformed `fieldConflicts: [null]` beside a valid
  resolved candidate. Instrument the storage boundary and require a resolved
  `207`, one structured scoring failure, one valid write, one batched
  currentness read over the valid ID, no legacy-evidence read when unnecessary,
  no malformed write, and no eligibility reconciliation.
- [ ] Run `PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/dealHunterScoreRefresh.test.js` and verify the current eager evaluation rejects instead of returning the expected result.
- [ ] Replace the eager `scoped.map(scoreOpportunity)` with a first pass that
  calls the scorer once per candidate inside an individual `try/catch`, records
  normalized scoring errors immediately, and retains only successful
  `{ deal, result }` entries.
- [ ] Batch-load score currentness using only successful opportunity IDs, then
  retain the existing conditional batched legacy-contradiction read and
  per-write error boundary. Reconcile eligibility only when the combined scorer
  and persistence failure count is zero.
- [ ] Re-run the focused refresh suite and require the new regression plus the
  existing write-failure/resume and reconciliation-after-zero-failures cases to
  pass.

### Task 9: Canonicalize contradiction values to persisted reviewer-visible text

**Files:**

- Modify: `test/dealHunterScoringDimensions.test.js`
- Modify: `test/dealHunterScoreRefresh.test.js`
- Modify: `server/services/dealHunterScoring.js`
- Modify: `server/services/dealHunterScoreStore.js`

**Interface:**

- Export `canonicalDealHunterContradictionValue(value)` from the scoring module.
  It returns `null` for `null`/`undefined`; otherwise it returns the whitespace-
  normalized `String(value)`, matching SQLite text serialization and
  Supabase's JSONB `->>` insertion into text columns.
- Both new semantic-digest contradiction tuples and legacy persisted-core
  signatures use that exact canonicalizer.

- [ ] Add a scorer regression requiring numeric and equivalent numeric-string
  contradiction values to have the same semantic digest and hand-derived core
  tuple, while a genuinely different string value changes the digest.
- [ ] Add a persistence regression that stores numeric contradiction evidence,
  reviews it, recomputes with equivalent strings, and requires preview zero,
  refresh skip, no new activity event, and `changed_since_review=false`; then
  require `"530000"` to preview and persist a genuine semantic change.
- [ ] Run both focused test files and verify the numeric/string expectations
  fail against the type-sensitive digest.
- [ ] Implement the shared text-or-null canonicalizer in the scoring module and
  use it in both digest construction and legacy stored-evidence comparison.
- [ ] Re-run the two focused suites and all legacy-v111 compatibility cases.

### Task 10: Comment correction, disposable acceptance, and full verification

**Files:**

- Modify: `server/services/dealHunterScoreStore.js`

- [ ] Update the `emitRescoreEvent()` comment to describe human-relevant score
  conclusions or core-evidence changes; do not alter behavior.
- [ ] Run the six scoring/storage/triage suites under Node 22.23.2 and require
  zero failures, skips, or todos.
- [ ] Capture a fresh online-consistent, read-only-derived production SQLite
  snapshot. Run fixed preview, one normal `force:false` refresh only on the
  disposable copy, a second preview, and the deterministic core/full-provenance
  audit. Delete all disposable artifacts afterward.
- [ ] Run `git diff --check`, `npm run check`, and `npm run test:browser` under
  Node 22.23.2. Require Node/UI/browser/evaluation/lint/build/prerender green.
- [ ] Recheck the exact unstaged Git scope and production release/pause only via
  read-only observation. Do not stage, commit, push, deploy, score production,
  reconcile production eligibility, create a backup, run HVAC, or touch
  outreach.
