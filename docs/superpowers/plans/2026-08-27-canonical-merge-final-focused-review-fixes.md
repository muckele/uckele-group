# Canonical Merge Final Focused Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix only the remaining Supabase alias-lock-order deadlock and the ten inaccurate canonical-merge relationship-inventory scanner-path claims, with regression evidence and no operational action.

**Architecture:** All Supabase functions that participate in the canonical alias advisory-lock protocol will acquire the complete sorted alias-key lock set before discovering owners or locking any canonical opportunity row. Relationship inventory entries will explicitly distinguish material paths from conceptual classifications and named independent safety gates; production validation will resolve material paths against the real inspection/plan shape and reject unknown conceptual or gate classifications.

**Tech Stack:** PostgreSQL 16/17 PL/pgSQL, Node.js 22.23.2, `node:test`, SQLite via `better-sqlite3`, Docker only for a disposable local PostgreSQL concurrency check.

**Spec:** `/Users/Matt/.codex/attachments/264d644d-ff0a-4020-8443-dcdbe647b12d/pasted-text.txt`

## Global Constraints

- Preserve the existing dirty worktree exactly except for the two scoped findings; do not reset, clean, restore, stash, checkout, or discard any existing change.
- Do not stage, commit, push, deploy, access production, apply a production migration, execute the HVAC repair, modify the Blair opportunity, enable Stage 2, send outreach, or run follow-ups.
- Keep `supabase/migrations/20260827120000_canonical_opportunity_current_semantics.sql` function-only and mirror the final RPC definitions in `supabase/schema.sql`.
- Preserve atomic create + alias acquisition + optional exception resolution, service-role-only execution, current-only authority, complete alias ownership conflict behavior, history, the exact approved tuple and aliases, all plan-v2 identity fields, and all nine merge-apply tests.
- Use Node.js 22.23.2 for JavaScript tests and verification.
- The user-selected checkout is intentionally not replaced with a new worktree because its complete dirty state is part of the review input.
- Do not commit: the requested handoff terminates at a verified recommendation to stage and commit.

---

### Task 1: Establish the lock-participant matrix and reproduce M1

**Files:**
- Test: `test/supabaseSecurity.test.js`
- Inspect: `supabase/migrations/20260827120000_canonical_opportunity_current_semantics.sql`
- Inspect: `supabase/schema.sql`
- Inspect: `server/storage/supabase.js`

**Interfaces:**
- Consumes: current SQL function definitions and Supabase RPC callers.
- Produces: an explicit matrix of alias mutation, canonical alias advisory locks, canonical opportunity row locks, and required order for every relevant current RPC.

- [ ] **Step 1: Extract complete current function bodies and classify each alias writer and opportunity-locking authority function.**

  The matrix must include `upsert_deal_hunter_opportunity`, `create_deal_hunter_opportunity_with_aliases`, both CIM claim functions, `link_deal_hunter_opportunity_aliases`, `apply_deal_hunter_cim_identity_repair`, CRM linking, score writes/reconciliation, recipient override, and manual operator decisions. Only functions that both use the `deal-hunter-opportunity-alias:` advisory namespace and lock canonical opportunity rows participate in the cross-resource order.

- [ ] **Step 2: Write a failing SQL contract test.**

  Add a function-body extractor in `test/supabaseSecurity.test.js`. For both the current-semantics migration and fresh schema, assert that every participating function acquires its complete, distinct, `alias_key`-sorted advisory lock set before the first `FOR UPDATE` of `public.deal_hunter_opportunities`. Assert the participant set is exactly atomic create and link, so adding a future participant without extending the matrix fails closed.

- [ ] **Step 3: Run the focused test with Node.js 22.23.2 and verify RED.**

  Run:
  ```bash
  PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/supabaseSecurity.test.js
  ```

  Expected: failure identifying `link_deal_hunter_opportunity_aliases` because its canonical opportunity `FOR UPDATE` precedes the canonical alias advisory lock.

---

### Task 2: Make the Supabase alias/opportunity lock protocol globally consistent

**Files:**
- Modify: `supabase/migrations/20260827120000_canonical_opportunity_current_semantics.sql`
- Modify: `supabase/schema.sql`
- Test: `test/supabaseSecurity.test.js`

**Interfaces:**
- Consumes: the Task 1 lock matrix and existing RPC signatures/result shapes.
- Produces: identical current migration/fresh-schema definitions with alias locks before canonical opportunity row locks.

- [ ] **Step 1: Validate and deterministically lock the complete alias-key set in the link RPC.**

  Reject empty alias keys before locking, then iterate `SELECT DISTINCT ... AS alias_key ... ORDER BY alias_key` and acquire `pg_advisory_xact_lock(hashtextextended('deal-hunter-opportunity-alias:' || v_alias_key, 0))`.

- [ ] **Step 2: Discover complete owners, determine every relevant opportunity ID, and lock rows in sorted order.**

  Include the requested target and every observed alias owner, lock all existing `deal_hunter_opportunities` rows by sorted `opportunity_id`, revalidate the target is active, reject dangling owners, then re-run the complete conflict query before mutation. Preserve the existing conflict response keys and normal return shape.

- [ ] **Step 3: Document the canonical lock-order contract next to both participating RPCs.**

  The concise SQL comment must state: complete distinct alias keys in sorted order; canonical alias advisory locks; owner discovery; sorted canonical opportunity row locks; revalidation; mutation.

- [ ] **Step 4: Mirror the exact link implementation and comments in the fresh schema.**

  Do not change tables, columns, indexes, types, status values, scoring semantics, RLS, grants, or signatures.

- [ ] **Step 5: Run the focused security test and verify GREEN.**

  Run the Task 1 command and require zero failures/skips.

- [ ] **Step 6: Run a real disposable PostgreSQL concurrency regression.**

  Start a disposable local PostgreSQL container from an already-present image, load the fresh schema, and use two independent `dblink` sessions plus an advisory-lock barrier to force atomic create and link to contend on the same alias and opportunity. Require both actual RPC calls to complete without `deadlock detected`, verify the alias owner/postconditions, then stop the disposable container. Do not download anything or touch production.

---

### Task 3: Reclassify the ten non-material relationship inventory entries

**Files:**
- Modify: `server/repairs/canonicalOpportunityMerge.js`
- Test: `test/canonicalOpportunityMergeRepair.test.js`

**Interfaces:**
- Consumes: the actual dry-run inspection/plan shape and existing apply safety gates.
- Produces: explicit enforcement metadata, known independent-gate identifiers, and a validator callable by the plan builder and tests.

- [ ] **Step 1: Write failing enforcement-model tests.**

  Add tests that require all material scanner paths to resolve against a real dry-run plan; a fake material path to fail; a conceptual entry without an explicit enforcement class to fail; an unknown independent gate to fail; a valid independent gate to pass; and exactly the five `deal_hunter_automation_settings` plus five `deal_hunter_cim_safety_settings` entries to be classified as independent gates without pretending to be material paths. Assert the inventory remains exactly 224 entries.

- [ ] **Step 2: Run the focused merge-repair test and verify RED.**

  Run:
  ```bash
  PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH node --test test/canonicalOpportunityMergeRepair.test.js
  ```

  Expected: failure because enforcement metadata, known gates, and path validation do not yet exist and the ten entries still advertise nonexistent material paths.

- [ ] **Step 3: Add the minimal enforcement taxonomy and validation.**

  Define frozen enforcement classes for material scanner paths, independent gates, approval preconditions, and explicit exclusions. Define real independent gate identifiers for automation-inert policy/state verification and the persisted global CIM outreach pause. Export a validator that resolves material paths with own-property checks, validates known conceptual namespaces, requires known independent gates, and rejects all unclassified entries.

- [ ] **Step 4: Correct only the ten inaccurate settings entries.**

  Give all five automation-settings entries the automation-inert independent gate and all five CIM-safety-settings entries the persisted-outreach-pause independent gate. They must have no material `scannerPath`. Preserve table/column/category/reason/authority-effect values and all 214 other table/column inventory identities.

- [ ] **Step 5: Enforce the inventory model when plans and replay manifests are validated.**

  Validate against the actual `inspection` during plan construction and against the stored plan during replay validation. This makes nonexistent material paths and unknown conceptual classifications fail closed in production, not only in tests.

- [ ] **Step 6: Run the focused merge-repair test and verify GREEN.**

  Require all existing tests, including nine apply tests, to pass with zero skips.

- [ ] **Step 7: Record metadata impact.**

  Recompute and report entry count, category counts, and inventory checksum before/after. Confirm plan schema remains v2, approved tuple/aliases/IDs are unchanged, and checksum change is a natural result of corrected inventory metadata.

---

### Task 4: Verify the complete scoped patch and review it independently

**Files:**
- Verify all files changed by Tasks 1–3.
- Do not modify unrelated files.

**Interfaces:**
- Consumes: green focused tests and the exact user acceptance criteria.
- Produces: fresh verification evidence and the required 25-item final report.

- [ ] **Step 1: Run focused regression tests with Node.js 22.23.2.**

  Run the SQL-security and canonical-merge-repair test files together and require zero failures/skips.

- [ ] **Step 2: Run repository checks.**

  Run `git diff --check` and `npm run check` under Node.js 22.23.2. Read complete output and require zero failures/skips.

- [ ] **Step 3: Perform the required final searches and invariants.**

  Re-audit all alias mutation/advisory/row-lock functions, migration-vs-schema parity, service-only grants, function-only migration shape, relationship paths/classes/gates, inventory count/checksum, plan-v2 identity, exact approved tuple and aliases, nine merge-apply tests, Blair absence, and empty staging area.

- [ ] **Step 4: Request a read-only independent code review.**

  Give the reviewer only the two findings, this plan, and the scoped working-tree diff. Address any Critical or Important issue within scope, then rerun affected verification.

- [ ] **Step 5: Produce the exact 25-item final report.**

  End with either `SAFE TO STAGE AND COMMIT` or `FIX SPECIFIC FINDINGS BEFORE COMMIT`. Report disposable PostgreSQL evidence or the remaining deployment validation if it could not run. Do not stage or commit.
