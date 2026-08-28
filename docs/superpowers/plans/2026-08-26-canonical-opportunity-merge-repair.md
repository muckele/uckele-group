# Canonical Opportunity Merge Repair Implementation Plan

> **Status: structural safeguard resolved by the separately approved 2026-08-27 current-authority phase.** The implementation is apply-capable in the uncommitted feature branch, and the nine original apply acceptance tests are enabled and passing. No production repair or Supabase migration was executed.

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Design and, only if every safeguard can be satisfied without crossing scope boundaries, add a dry-run-first, SQLite-only, checked-in-approval repair command. The intended mutation would atomically move the three approved BusinessesForSale aliases to the reviewed survivor, supersede but preserve the losing row, resolve the exact identity exception, and write a uniquely typed audit manifest.

**Architecture:** Keep authorization and deterministic plan construction in a small pure repair module shared by the service and SQLite transaction. The service owns provider and operator gates plus verified-backup handling. SQLite owns exhaustive inspection and the atomic mutation. Standalone dry run uses a fingerprint-stable private copy of the active WAL-mode database instead of ordinary migrating application startup, validates the complete repair schema, and opens only that copy read-only/query-only. The separately approved current-authority contract makes all acquisition paths exact-active, so the merge plan can assert the structural invariant without an unconditional apply blocker.

**Tech stack:** Node.js 22.23.2, ECMAScript modules, `better-sqlite3`, `node:test`, existing backup and canonical-identity services.

**Design specification:** `docs/superpowers/specs/2026-08-26-canonical-opportunity-merge-repair-design.md`

**Global execution constraints:** Do not stage, commit, push, deploy, connect to production, or run this repair on production. All SQLite-backed commands use `/Users/Matt/.nvm/versions/node/v22.23.2/bin/node` or an npm process with `/Users/Matt/.nvm/versions/node/v22.23.2/bin` first on `PATH`.

---

## Task 1: Freeze the incident approval and red tests for dry-run planning

**Files:**

- Create: `server/repairs/canonicalOpportunityMerge.js`
- Create: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Add the exact approved fixture in the test

Create isolated SQLite fixture helpers that insert:

- the exact survivor and superseded IDs;
- identical approved HVAC opportunity snapshots;
- the exact 12 alias rows from the design specification, with 3 on the losing ID and 9 on the survivor;
- the exact open exception and candidate pair;
- no scores, CRM, CIM, communications, events, activities, or claims;
- a deterministic actor, reason, and time.

Use a temporary database per test. Keep its path available so exceptional dependent rows and rollback triggers can be inserted through a separate `better-sqlite3` connection.

### Step 2: Write failing approval/provider/dry-run tests

Add tests proving:

- the exact approved tuple and 12 alias ownership entries are exported and immutable;
- reversed or otherwise incorrect survivor tuple is refused;
- `supabase`, missing, and unknown storage providers are refused even in dry-run mode;
- a valid SQLite dry run returns 12 exact observed aliases, 3 exact moves, zero dependents, a typed manifest ID, and a 64-character checksum;
- two identical dry runs with the same actor/reason/state return the same checksum;
- dry run writes nothing to the configured SQLite database or its sidecars, including no startup migration/backfill, manifest, or pause change.

### Step 3: Run the focused test and observe RED

Run:

```bash
/Users/Matt/.nvm/versions/node/v22.23.2/bin/node --test test/canonicalOpportunityMergeRepair.test.js
```

Expected: failure because the pure repair module/service/storage inspection APIs do not exist.

### Step 4: Implement only the pure approval/plan primitives

In `server/repairs/canonicalOpportunityMerge.js`:

- export repair type/schema constants;
- export the exact confirmation phrase;
- export a deeply frozen descriptor containing the exact tuple, approved facts, all 12 alias ownership tuples, and the 3 approved current source observation fixtures;
- expose exact tuple lookup that rejects all unapproved runtime tuples;
- provide stable recursive JSON serialization and SHA-256 helpers;
- provide canonical alias-key construction from type/value;
- provide pure normalization and exact-set comparison helpers;
- provide deterministic manifest ID generation under `canonical-opportunity-merge:v1:<tuple-digest>`;
- provide pure plan construction from a normalized SQLite inspection, actor, and reason.

Do not add mutation logic or change identity behavior.

### Step 5: Run the focused test

Run the same Node 22 command. Expected: approval-unit assertions pass; dry-run integration assertions remain RED until Tasks 2–3.

---

## Task 2: Add read-only SQLite inspection and exact drift detection

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Expand failing dry-run drift tests

Add subtests proving dry-run refusal when:

- either opportunity is missing, non-active, or already carries supersession metadata;
- the exception is missing, resolved, has a changed reason, or has a changed candidate set;
- an approved alias disappears;
- an additional alias appears on either approved ID;
- an approved alias changes owner;
- a third opportunity owns the same `(alias_type, alias_value)` through a different malformed `alias_key`;
- approved business facts drift;
- a manifest exists at the deterministic key without the exact canonical-merge type/schema/tuple/checksum contract.

Run only these tests with Node 22 and confirm they fail for the missing inspection behavior.

### Step 2: Implement the internal inspection helper

Add a private synchronous `inspectCanonicalOpportunityMergeState(database, approval)` helper in `server/storage/sqlite.js`. It must:

- query both opportunity rows and the exact exception;
- query every alias owned by either ID;
- query all global rows matching each approved `(alias_type, alias_value)` rather than trusting `alias_key` uniqueness;
- normalize JSON columns with existing helpers;
- query the deterministic manifest ID and all canonical-merge typed manifests for uniqueness checks;
- collect, but never mutate, the full state needed by the pure plan builder.

Expose `inspectDealHunterCanonicalOpportunityMerge({ approval, actor, reason })` only on SQLite storage. It passes the raw inspection to the pure plan builder and returns the checked plan/checksum.

The CLI dry-run adapter must not construct ordinary application storage. It must fingerprint and copy a stable database-plus-WAL view to a private temporary directory, leave the configured database/WAL/SHM files byte-identical, open only the copy with `readonly`, `fileMustExist`, and `query_only`, run `quick_check`, and validate every required repair table/column before inspection. A rollback-journal source, non-WAL database, unstable copy, missing table, or missing required column is a refusal rather than a migration.

### Step 3: Implement exact opportunity/exception/alias validation in the pure builder

The plan builder must fail closed on every drift case above. Full normalized opportunity, exception, and alias rows belong in the checksummed plan. Alias authorization compares exact owner/type/value sets; full alias row metadata is also checksummed so a post-dry-run metadata change produces a stale checksum even when ownership stays authorized.

### Step 4: Run the focused test

Run:

```bash
/Users/Matt/.nvm/versions/node/v22.23.2/bin/node --test --test-name-pattern='dry run|approval|provider|alias|exception|manifest collision' test/canonicalOpportunityMergeRepair.test.js
```

Expected: all selected dry-run and drift tests pass, with no writes.

---

## Task 3: Enforce zero unexpected dependent state on both IDs

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/repairs/canonicalOpportunityMerge.js`
- Modify: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Add failing dependent-state tests

Add parameterized or focused cases for both survivor and losing IDs covering:

- `deal_hunter_opportunity_scores` and `deal_hunter_score_evidence`;
- `contact_submissions` and `deal_hunter_crm_imports`;
- `deal_hunter_crm_reconciliation_items`;
- `deal_hunter_cim_requests` and `deal_hunter_cim_reviews`;
- `crm_communications`;
- `email_events`;
- `crm_activity_events`;
- `deal_hunter_cim_opportunity_claims`;
- `deal_hunter_cim_recipient_claims`;
- `deal_hunter_cim_recipient_overrides`;
- `deal_hunter_cim_stage2_decisions`;
- indirect matches by approved deal key, listing URL/identity, linked submission/request/communication, and bounded JSON metadata reference.

Each inserted row must cause dry-run refusal. Tests must also prove no reparenting or deletion occurs.

### Step 2: Run selected tests and observe RED

Run:

```bash
/Users/Matt/.nvm/versions/node/v22.23.2/bin/node --test --test-name-pattern='dependent|score|CRM|CIM|communication|claim' test/canonicalOpportunityMergeRepair.test.js
```

Expected: failures until the scanner is complete.

### Step 3: Implement the bounded dependent scanner

Inside the SQLite inspection helper:

- derive the exact approved opportunity IDs, deal keys, listing URLs, listing IDs/source identities, and alias keys;
- collect direct matches by `opportunity_id`/`deal_hunter_opportunity_id`;
- collect indirect matches through deal key, listing identity/URL, submission ID, CIM request ID, communication ID, and bounded metadata text references;
- include stable row IDs and per-category counts in sorted inspection output;
- exclude only the exact open exception and expected alias rows because they are the repair subject;
- treat every other match on either canonical ID as unexpected.

The pure builder requires every dependent category to be empty. It never creates a reparent plan.

### Step 4: Run selected and complete focused tests

Expected: all zero-dependent cases pass for both IDs, and the fixture with no dependents still yields the original checksum deterministically.

---

## Task 4: Add the service boundary and apply preconditions

**Files:**

- Create: `server/services/canonicalOpportunityMergeRepair.js`
- Modify: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Write failing service-gate tests

Test `runCanonicalOpportunityMergeRepair` for:

- dry-run default and exact tuple lookup;
- non-empty actor and meaningful human reason for dry run and apply;
- SQLite-only refusal before storage inspection;
- apply refusal without `apply: true` semantics where appropriate;
- wrong confirmation phrase;
- missing/wrong/stale expected plan checksum;
- missing, failed, malformed, or non-SQLite backup verification evidence;
- outreach not paused;
- exact successful gate handoff to the SQLite transaction.

Use application-consistent temporary SQLite snapshots plus synthetic manifest wrappers matching `verifyBackupBundle`; do not create, inspect, or verify a production backup in tests. The snapshot is re-hashed, rejects unverified SQLite sidecars, is loaded into a private in-memory/query-only database without touching the verified bundle, and is plan-bound and pause-epoch-bound by the repair service/storage path.

### Step 2: Run and observe RED

Run the service-gate tests under Node 22.

### Step 3: Implement the service

The service must:

- resolve only a checked-in descriptor from the exact runtime tuple;
- require `storage.provider === 'sqlite'` for both modes;
- normalize and bound actor/reason without changing their reviewed meaning;
- call read-only SQLite inspection for dry run;
- for apply, validate exact phrase, checksum form, and verified SQLite backup result before calling storage mutation;
- pass a bounded backup evidence summary to storage;
- never pause/unpause outreach and never expose a provider-neutral fallback.

The storage transaction remains the authority for the apply-time pause read and fresh checksum comparison.

### Step 4: Run selected tests

Expected: all service-gate tests pass; successful apply remains RED pending Task 5.

---

## Task 5: Implement the single atomic SQLite merge transaction

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/repairs/canonicalOpportunityMerge.js`
- Modify: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Write failing successful-apply assertions

Prove one valid apply:

- updates ownership of exactly the 3 approved BusinessesForSale aliases;
- keeps all 9 survivor aliases unchanged;
- leaves exactly 12 approved aliases owned by the survivor and zero aliases on the loser;
- preserves both opportunity rows;
- leaves survivor `active`;
- marks loser `superseded` and preserves existing metadata while adding the exact merge audit object;
- resolves only the exact exception with actor, reason, decision, timestamp, survivor, superseded ID, and checksum;
- writes exactly one manifest;
- stores `mode`/`repairType`/schema/tuple under the canonical-merge namespace;
- stores exact moved aliases and bounded verified-backup evidence;
- does not change the outreach pause.

### Step 2: Run and observe RED

Run only the successful-apply test under Node 22.

### Step 3: Implement the transaction in SQLite

Add `applyDealHunterCanonicalOpportunityMerge(...)` using `database.transaction(...).immediate()`:

1. Read and require the global pause row inside the transaction.
2. Check deterministic manifest-key collisions/idempotency before pre-merge validation.
3. Re-inspect transaction-visible state and rebuild the complete plan with the shared pure builder.
4. Compare the fresh checksum to the caller's expected checksum using exact equality.
5. Update only the 3 approved alias rows with `WHERE alias_key = ? AND opportunity_id = ?`, requiring one changed row each.
6. Re-query every approved type/value globally; require exactly one row and the survivor owner. Require zero aliases on the losing ID.
7. Require the survivor to remain active and both primary submission links to remain empty.
8. Update only the losing opportunity status/metadata, preserving all unrelated metadata.
9. Resolve only the exact exception from its expected open version/state.
10. Insert—not upsert—the typed manifest under its deterministic key.
11. Re-read final state and return it.

Any row-count mismatch or postcondition throws and rolls back.

### Step 4: Run the successful-apply test

Expected: pass.

### Step 5: Add and run the rollback test

Create a temporary SQLite trigger that raises an abort on the exception update, after aliases have been updated in transaction order. Apply must reject. Verify all 12 original alias owners, both active statuses/metadata, open exception, absent manifest, and unchanged pause.

Expected: pass, proving whole-transaction rollback without a production test hook.

---

## Task 6: Prove resolution safety and unchanged ordinary behavior

**Files:**

- Modify: `test/canonicalOpportunityMergeRepair.test.js`
- Test only, no change: `server/services/cimOpportunityIdentity.js`
- Test only, no change: `server/services/dealHunter.js`

### Step 1: Add failing normal-resolution regression

Using the unchanged `resolveDealHunterOpportunity`, test after apply that:

- the BizBuySell fixture resolves to the survivor through exact alias;
- the BusinessesForSale fixture resolves to the survivor through exact alias;
- the DealStream fixture resolves to the survivor through exact alias;
- the deduplicated union fixture resolves to the survivor through exact alias;
- none resolves to the losing ID;
- an alias-free/synthetic semantically compatible input cannot uniquely resolve to the losing row (it remains fail-closed/ambiguous because both reviewed snapshots are identical);
- zero aliases remain capable of exact resolution to the losing row.

The tests must compare the identity source files to the baseline diff or otherwise assert they were not edited.

### Step 2: Add current-path inspection assertions

Exercise the storage lookups used by identity operations and Stage 2 evidence:

- deal-key alias evidence maps only to survivor;
- exact opportunity lookup retains the loser solely as `superseded` audit history;
- there are no reviews, decisions, claims, requests, or communications carrying the loser ID;
- current HVAC candidates produced from the approved source fixtures carry only survivor ID.

### Step 3: Run focused and existing identity tests

Run:

```bash
/Users/Matt/.nvm/versions/node/v22.23.2/bin/node --test test/canonicalOpportunityMergeRepair.test.js test/cimOpportunityIdentity.test.js
```

Expected: pass without modifying the ordinary resolver.

---

## Task 7: Add typed-manifest idempotency and collision handling

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/repairs/canonicalOpportunityMerge.js`
- Modify: `test/canonicalOpportunityMergeRepair.test.js`

### Step 1: Add failing idempotency tests

Prove:

- an identical second apply with every required gate returns `alreadyApplied: true` and performs no write;
- the manifest row, opportunity timestamps/metadata, exception, aliases, and pause are byte-for-byte unchanged on replay;
- a different actor/reason plan checksum fails;
- an arbitrary stale checksum fails;
- a validly typed manifest whose final database state drifted fails rather than claiming idempotency;
- wrong repair type/schema/tuple at the deterministic key fails as a collision;
- another canonical-merge row for the same tuple under a noncanonical key fails uniqueness validation.

### Step 2: Implement exact replay validation

Before normal pre-merge inspection, the transaction may return idempotent only after validating:

- all apply gates were supplied;
- the existing row is unambiguously `canonical-opportunity-merge` with schema v1;
- deterministic key, approved tuple, actor/reason plan identity, and checksum match;
- survivor is active;
- loser is superseded into that survivor with matching checksum;
- exception has the exact completed decision;
- all 12 aliases have exactly one owner, the survivor;
- all dependent-state categories remain zero.

No timestamp or audit field may be refreshed during replay.

### Step 3: Run idempotency/collision tests

Expected: pass.

---

## Task 8: Add the dry-run-first CLI and operator runbook

**Files:**

- Create: `scripts/repair-canonical-opportunity-merge.js`
- Modify: `package.json`
- Create: `docs/canonical-opportunity-merge-repair.md`
- Modify: `test/canonicalOpportunityMergeRepair.test.js` if argument parsing is factored for unit testing

### Step 1: Add failing CLI parsing/contract tests where practical

Cover:

- dry-run default;
- required tuple, actor, and reason;
- `--apply` as the only apply switch;
- `--expected-plan-checksum`, `--backup`, and `--confirm` required for apply;
- structured nonzero refusal on missing/wrong inputs;
- non-SQLite refusal before backup/mutation;
- no implicit actor in either mode.

### Step 2: Implement the command

Add npm script:

```json
"cim:canonical-merge": "node scripts/repair-canonical-opportunity-merge.js"
```

The script:

- loads environment/config only through existing application entry points;
- reads active provider configuration without constructing storage;
- for dry run, constructs only the incident-specific private-snapshot read-only adapter and closes/removes it in `finally`;
- for apply, verifies every operator gate and the reviewed backup before constructing writable storage;
- verifies `--backup` with `verifyBackupBundle` only for apply;
- passes the complete verification result, not a caller-provided boolean;
- prints the plan/result as formatted JSON;
- prints a concise prefixed error and exits nonzero on refusal;
- never creates a backup, pauses/unpauses outreach, deploys, or retries apply.

### Step 3: Write the runbook

Document the exact later procedure:

1. Independently review/approve a checked-in descriptor.
2. Confirm SQLite provider and keep production untouched during code review.
3. Run dry run with exact tuple/actor/reason.
4. Review opportunities, exact alias owners, zero dependents, mutation list, manifest ID, and checksum.
5. Obtain separate apply authorization.
6. Pause global CIM outreach outside the tool.
7. Create and independently verify a fresh application-consistent backup.
8. Apply once with exact checksum, phrase, actor, reason, and backup path.
9. Do not retry an ambiguous outcome.
10. Audit final alias ownership, both opportunity rows, exception, manifest, zero dependents, resolver results, and full-backfill readiness.
11. Do not automatically unpause; require a separate operational decision.

State explicitly that the command is not a bypass for resolver/full-backfill guards.

### Step 4: Run focused tests and lint the new files

Run the focused Node 22 suite, then:

```bash
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH npm run lint
```

Expected: pass.

Full-process tests must additionally prove that dry run leaves a standalone SQLite file and its directory unchanged, reads committed state still present in a live WAL without changing the source database/WAL/SHM bytes, refuses schema drift without migrating, and that invalid `--apply` input exits before writable storage startup.

---

## Task 9: Run focused regressions, complete validation, and inspect the uncommitted diff

**Files:**

- Verify all modified files; do not create a commit.

### Step 1: Run focused identity/storage/repair tests under Node 22

Run:

```bash
/Users/Matt/.nvm/versions/node/v22.23.2/bin/node --test \
  test/canonicalOpportunityMergeRepair.test.js \
  test/cimOpportunityIdentity.test.js \
  test/cimIdentityRepair.test.js
```

Add the existing authoritative full-backfill/score reconciliation test files identified by test-name search, then run them under the same runtime. Every selected test must pass.

### Step 2: Confirm prohibited behavior files are unchanged

Inspect `git diff --name-only` and exact diffs. There must be no behavioral edits to ordinary resolver, deduplication, parser, scoring, current-triage, full-backfill gate, CRM/CIM automation, Stage 2/3, follow-up, or Daily Deal Hunter code.

### Step 3: Run whitespace validation

Run:

```bash
git diff --check
```

Expected: exit 0.

### Step 4: Run the full repository check under Node 22

Run:

```bash
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH npm run check
```

Expected for the apply-capable implementation: eval, lint, all Node tests with zero canonical-merge blocker skips, UI tests, and build pass. The original apply-success, idempotency, post-apply, drift, and rollback acceptance tests must all execute.

### Step 5: Review safety and Git state

Run:

```bash
git status --short --branch
git diff --stat
git diff -- package.json server/repairs/canonicalOpportunityMerge.js server/services/canonicalOpportunityMergeRepair.js server/storage/sqlite.js scripts/repair-canonical-opportunity-merge.js test/canonicalOpportunityMergeRepair.test.js docs/canonical-opportunity-merge-repair.md docs/superpowers/specs/2026-08-26-canonical-opportunity-merge-repair-design.md docs/superpowers/plans/2026-08-26-canonical-opportunity-merge-repair.md
```

Confirm all changes are intentional and uncommitted; staging is empty.

### Step 6: Request an independent read-only code review

Request review of the complete uncommitted diff against baseline `2638aaf4ee590839b77fb2cb6d0e0ad72455c5a6`, prioritizing transaction atomicity, exact alias-set enforcement, dependent-state completeness, manifest typing/collision safety, idempotency, provider refusal, and resolver invariants. Address Critical/Important findings test-first, then rerun the affected and full validation commands.

### Step 7: Final handoff

Report all 16 items required by the task: root cause, files, architecture, dry run, apply gates, transaction/supersession/manifest semantics, drift/idempotency, tests and results (including skips), Git state, conditional later production procedure, and independent-review readiness. Explicitly distinguish implementation readiness from production authorization and state that nothing was staged, committed, pushed, deployed, run against production, migrated remotely, or applied.

---

## Structural blocker resolution and validation

The original review identified three counterpaths: semantic enumeration could include a superseded row, manual exception linking could select it directly, and Stage 2 current evidence could admit it. The separately approved 2026-08-27 phase resolved those paths through an explicit exact-active current-authority contract in both providers, without changing historical getters or identity/scoring policy.

The follow-on implementation additionally audits and guards direct current-authority callers for resolver/manual linking, CRM/CIM linkage, claims, Stage 2 final authorization, score/current-triage reconciliation, and operator decisions. The function-only Supabase migration keeps existing signatures compatible, performs current-triage filtering/counting before pagination, and adds atomic active-status checks to the affected RPCs.

The repair's unconditional structural blocker and its nine skip annotations were removed only after the current-authority regressions existed. The focused merge suite now executes all original apply-success, resolver-after-apply, idempotency, replay, drift, and rollback cases with zero skips. The expanded focused current-authority/merge matrix passed 229 tests with 0 failures and 0 skips under Node 22.23.2; the full Node suite passed 698 tests with 0 failures and 0 skips, the 125-test UI suite passed, and the production build completed.

These results establish implementation readiness for independent read-only review. They do not authorize production access, application of the Supabase migration, or execution of the HVAC repair; each remains outside this task.
