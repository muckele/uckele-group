# Deal Review Speedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the 7:30 AM sheet sync and 8:00 AM digest from freezing the server, by removing the near-quadratic work in the deal review build without changing any result.

**Architecture:** Three independent hot spots, each fixed in place: index lookups instead of full scans in the sheet snapshot replacement, compute per-listing match features once per dedupe run instead of once per pair, and look up identity candidates by exact name instead of comparing against every active opportunity. A local before/after harness proves the database ends identical.

**Tech Stack:** Node 22 ESM, better-sqlite3, node:test.

**Spec:** The approved design, agreed in chat on 2026-11-09 ("Approve, build it"). Root cause measured locally: at 5,000 rows the dedupe is 33-47% of CPU, the snapshot replacement 25-31%, and the identity full scan 24% of the day-1 sync.

## Global Constraints

- **Identical results:** dedupe groups, identity decisions and exceptions, opportunity rows, aliases, source observations, freshness evidence, CIM safety events, fingerprints and scores must be identical before and after for the same input. Not "close": identical.
- **No new behaviour:** no new logs, flags, settings, schema changes or migrations.
- **Scope:** don't touch Postgres/Supabase storage. The Postgres path is not deployed (`fly.toml` uses SQLite).
- **Tests:** `. "$HOME/.nvm/nvm.sh"; nvm use 22` first. Run node tests with `node --test <file>`. Never kill vitest or node processes globally.
- **Error copy:** keep every existing error message verbatim. In particular, `Admitted safety run exceeds its bounded reader.` must still throw at the same count (10,000 events in one safety run).

## Review Focus

1. **A record ID that maps to two opportunities:** `currentByRecord` is keyed by record and field, so a record can have rows for two opportunity IDs. The replacement lookup must return the same row the old `find` returned: the first-inserted key's current value.
2. **Objects changed after their features are cached:** a cache keyed by object must never outlive a mutation of that object. Verify `mergeSyndicatedDeals` and its callers don't mutate either argument, or scope the cache to one `dedupeDeals` call.
3. **Identity name prefilter:** it's only valid if every path that uses a comparison requires `nameMatch`. Check every consumer of `comparisons`, including stored exception evidence, before filtering.
4. **Snapshot names from metadata:** `opportunitySnapshot` prefers `metadata.identitySnapshot.name`, which may be stored unnormalized or missing on older rows. The name index must use exactly the value the comparison uses.
5. **Safety-event cap across calls:** the per-run counter must count events written earlier in the same run, including rows from a previous attempt of the same run ID, exactly as `COUNT(*)` did.

---

### Task 1: Before/after equivalence harness (scratch, not committed)

**Files:**
- Create: `$S/profile/equivalence.mjs`, where `$S` is the session scratchpad.

**Interfaces:**
- Produces: `node equivalence.mjs --db <sqlite> --out <json>`. It writes a canonical JSON dump of the tables listed below, with volatile columns normalized. A plain `diff` of two dumps is the proof.

- [ ] **Step 1:** Dump these tables, sorted by a stable natural key:
  - `deal_hunter_opportunities`
  - `deal_hunter_opportunity_aliases`, or the actual alias table name
  - `deal_hunter_opportunity_source_observations`
  - `deal_hunter_freshness_evidence`
  - `deal_hunter_cim_safety_events`
  - `deal_hunter_cim_audit_events`
  - `deal_hunter_identity_exceptions`
  - the score/fingerprint tables `refreshOpportunityScores` writes
- [ ] **Step 2:** Normalize timestamps, run IDs and anything derived from them, such as `fl01:` hashes and `cim-source:` digests. Map each distinct value to a placeholder by order of first appearance, so the structure still has to match.
- [ ] **Step 3:** Use the existing `repro.mjs` from a `git archive` export. Run `seed,sync,digest` on `fx/2000`, then `sync,digest` on `fx/2000-day1`, once for `origin/main` and once for the branch, and dump both. The dumps must be byte-identical. Repeat on `fx/300`.

### Task 2: Snapshot replacement without full scans

**Files:**
- Modify: `server/storage/sqlite.js`:
  - `replaceAdmittedCompleteGoogleSheetSourceSnapshot` (about lines 14423-14821)
  - `appendAdmittedImportSafety` (about lines 151-196)
- Test: `test/dealHunterSnapshotReplacementScale.test.js` (new)

- [ ] **Step 1: Write failing tests:**
  - **(a) Scale test:** a complete-sheet snapshot of 3,000 records, replaced twice with one changed record the second time, finishes the second replacement within a generous bound. Pick the bound so that `origin/main` fails it locally, and record both timings in the report.
  - **(b) Behaviour test:** a record ID observed under two opportunity IDs keeps the old lookup semantics.
  - **(c) Cap test:** the safety cap still throws `Admitted safety run exceeds its bounded reader.` when a run would write event 10,001.
  - Build fixtures through the same storage API the existing sheet-sync tests use. Find them with `grep -l replaceAdmittedCompleteGoogleSheetSourceSnapshot test/`.
- [ ] **Step 2:** Run the tests and confirm (a) fails on the unmodified code.
- [ ] **Step 3: Implement:**
  - Build `firstRowByRecordId` once by iterating `currentByRecord.values()` in order and keeping the first row per `source_record_id`. This replaces the `find` at line 14563.
  - Hoist every `database.prepare(...)` inside the record, observation and removal loops to a single prepared statement created once per transaction.
  - In `appendAdmittedImportSafety`, take an optional `safetyCounts` Map, keyed by `safetyRunId`. Seed it from one `COUNT(*)` the first time each run ID is seen, increment it on each insert, and compare against 10,000 as before. Pass one Map per transaction from both call sites in this function, and leave other callers unchanged.
  - Skip the observation upsert when the existing row (from the `current` read) already has identical values for every column the upsert would write. The `ON CONFLICT` branch's `updated_at` and `observed_at` writes count as changes, so compare exactly what the statement would store. If that makes the skip rarely apply, drop it and say so in the report.
- [ ] **Step 4:** Run the new test, `test/dealHunterSheetSync*.test.js`, and every test file that mentions `replaceAdmittedCompleteGoogleSheetSourceSnapshot` or `appendAdmittedImportSafety`. All must pass.
- [ ] **Step 5:** Commit: `perf: replace full scans in the sheet snapshot save with lookups`.

### Task 3: Dedupe computes each listing's match features once

**Files:**
- Modify: `server/services/dealHunter.js`:
  - `syndicatedMatchDecision` (about line 3024)
  - `dedupeDeals` (about line 3212)
  - `tokenSimilarity` and `tokenContainment`, plus helpers they call
- Test: `test/dealHunterDedupeScale.test.js` (new)

- [ ] **Step 1: Write failing tests:**
  - **(a) Golden test:** `dedupeDeals` on a deterministic seeded 600-deal fixture with planted syndicated duplicates (same name, description, state and financials on a different URL) returns exactly the output of the pre-change code. Generate the expected output with `origin/main`'s `dedupeDeals`, store its sha256 and the group sizes in the test, and say in the test how to regenerate it.
  - **(b) Scale test:** 4,000 deals finish within a bound that `origin/main` fails locally.
- [ ] **Step 2:** Run the tests and confirm (b) fails on the unmodified code.
- [ ] **Step 3: Implement:**
  - Split `syndicatedMatchDecision` into a feature step, `matchFeatures(record)`, and a comparison step that consumes two feature objects. The feature step computes the identity aliases, normalized name and description text, and the name and description token sets that `tokenSimilarity` and `tokenContainment` need.
  - In `dedupeDeals`, cache features in a `WeakMap` created inside the call.
  - Keep `syndicatedMatchDecision(left, right)` as a wrapper with the same signature and output for any other caller.
  - Results, including every `evidence` number and the `toFixed(4)` rounding, must be identical.
- [ ] **Step 4:** Run the new test and every test file that imports from `server/services/dealHunter.js`. All must pass.
- [ ] **Step 5:** Commit: `perf: compute each listing's match features once per dedupe run`.

### Task 4: Identity matching looks up candidates by exact name

**Files:**
- Modify: `server/services/cimOpportunityIdentity.js`: `compareCimOpportunityEvidence` (about line 240) and the resolver around line 505, plus its caller in the sheet sync if it calls `listCurrentDealHunterOpportunities` once per listing.
- Test: `test/cimOpportunityIdentityScale.test.js` (new)

- [ ] **Step 1: Write failing tests:**
  - **(a) Behaviour tests:** for automatic, ambiguous, multiple-automatic and no-match cases, the resolver returns the same status, resolution, candidates (in order) and evidence as before.
  - **(b) Scale test:** resolving 1,000 new listings against 5,000 active opportunities finishes within a bound that `origin/main` fails locally.
- [ ] **Step 2:** Run the tests and confirm (b) fails on the unmodified code.
- [ ] **Step 3: Implement:**
  - Compute `identitySnapshot(deal)` once per resolve.
  - Build an index from `opportunitySnapshot(opportunity).name` to active opportunities, in their original order, so candidate order is preserved. Compare only against the entry for the listing's own snapshot name.
  - This is valid only because both `automatic` and `ambiguous` require `nameMatch`, meaning both names are non-empty and equal. Confirm no other consumer reads non-matching comparisons. If one does, stop and report instead.
  - Cache the index for the duration of one sync run if the caller resolves many listings against the same opportunity list. Invalidate it whenever an opportunity is created or updated during the run, or don't cache across listings at all.
  - Keep `compareCimOpportunityEvidence`'s signature and output.
- [ ] **Step 4:** Run the new test and every test file mentioning `cimOpportunityIdentity` or `resolveCimOpportunity`. All must pass.
- [ ] **Step 5:** Commit: `perf: match new listings against same-name deals only`.

### Task 5: Prove it and re-profile (controller)

- [ ] Equivalence harness: the dumps from `origin/main` and the branch are identical at 300 and 2,000 rows (day 0 and day 1).
- [ ] Re-profile with `run-series.sh` at 2,000 and 5,000 rows. Record wall time and CPU per job against the baseline (2,000 rows: 10.5 s steady / 14.9 s day 1; 5,000 rows: 45-47 s / 73.5 s).
- [ ] Whole-branch review on the most capable model, fix, re-review, then all suites green on a clean export.
