# CRM Duplicate Consolidation V3 Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V2 whole-database row authority with V3 whole-relevant-database authority that excludes row contents from exactly analytics_events and contact_rate_limit_events while retaining complete schema authority and every other V2 repair guard.

**Architecture:** Keep the existing fixed-incident repair, SQLite adapter, service, and CLI; change the shared inspection to enumerate every table's schema while selecting rows only from the two-table-complement authoritative set. Bind a closed V3 rowAuthority policy and explicitly named authoritative digests into the canonical plan, then use that same boundary in backup reconstruction, transactional apply, postconditions, and replay. Retain the exact four-write ledger and all independent safety, identity, checkpoint, receipt, and privacy checks.

**Tech Stack:** Node.js 22, ECMAScript modules, better-sqlite3, node:test, existing Uckele Group SQLite repair framework.

**Spec:** docs/superpowers/specs/2026-09-21-crm-duplicate-consolidation-v3-authority-design.md

## Global Constraints

- Start only from design commit `1d5cd59091e4554b7cd8624f64b5222939166c59` (parent/main `005c410d8f66b51e353cd58e9b6f9a059b7a8eeb`); verify the spec SHA-256 `122c7a5442ce9efb6c220a60c71ec22384d0be8a945ff18b959bab26b88de7e3`. Work in an isolated implementation branch; preserve the approved spec and the user's primary checkout.
- The **only** row-content exclusions are `analytics_events` and `contact_rate_limit_events`. Their schemas remain fully authoritative. Every other application table, including a newly introduced table, remains row-authoritative. No CLI, environment, database, wildcard, regex, category, or runtime override exists.
- Exact schemas/versions: approval `crm-duplicate-consolidation-approval-v1`; checkpoint `crm-duplicate-consolidation-checkpoint-v1`; plan `crm-duplicate-consolidation-plan-v3`; manifest `crm-duplicate-consolidation-manifest-v3`; repair `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3`; confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3`; manifest namespace `crm-duplicate-consolidation:v3:`. V1/V2 artifacts and confirmations refuse before writable storage construction; no receipt migration.
- Keep Pooler and Berlin as the two fixed, **separate** opportunities and preserve the approved positive identity, source, direct/metadata ownership, primary, import, and financial predicates. The raw Berlin deal-key preimage stays outside Git, ordinary CI, logs, and reviewed artifacts. `metadata.dealHunter.raw["Annual Profit"]` remains source authority with an unknown period.
- First apply still changes exactly four rows: two `crm_submission_supersessions` inserts, the one Berlin legacy `deal_hunter_crm_imports` CAS update with `opportunity_id = NULL`, and one append-only `deal_hunter_cim_repair_manifests` receipt insert. Contact rows, Pooler imports, excluded volatile rows, and all other business rows are not repair writes. Replay writes zero rows.
- Preserve complete all-table schema/required-object and unclassified relationship-column checks; all-table SQLite `quick_check` and `foreign_key_check`; the authoritative-row bound of 250,000; exact target raw-row/unchanged-mutation-table digests; current active-writer and Stage 2 blockers; the four-source runtime-safety authority and strict lexical/config checks; immutable backup and single-use verification capability; `BEGIN IMMEDIATE`; rollback and receipt immutability; generic CRM audit and supersession audit semantics; SQLite-only refusal for Supabase; and the CLI's closed safe apply/replay output projection.
- The current v126 checkpoint/backup/snapshot is **historical-only for V3**. A new post-V3-deployment checkpoint would require separate owner authorization. This plan and its implementation tests authorize no production access, preview, apply, backup, deploy, reconciliation, communication, or automation change.
- Ordinary CI uses synthetic Berlin identity and must **refuse** the fixed positive digest. Successful fixed-identity preview/apply/replay/rollback is proved only by the retained external restricted gate on disposable local SQLite. No digest override, crypto mock, descriptor substitution, or restricted preimage in Git.
- For each task: write and run its focused RED test first; make the smallest GREEN change; refactor without weakening guards; rerun its focused suite; obtain a fresh reviewer gate on the task diff; make the stated normal commit only after the task is green. Do not amend/rebase/force-push to hide a failed gate. The test snippets below are representative executable additions; the enumerated assertions are mandatory even where several fit one `test()` case.

## Review Focus

1. A third or reordered exclusion with a recomputed checksum might pass an overly permissive validator. Task 1's `V3 policy is closed` test and Task 4's forged-artifact test must refuse it.
2. Excluding rows might accidentally exclude `analytics_events` or `contact_rate_limit_events` schemas. Task 2's schema-drift cases and Task 7's replay schema-drift case must refuse both.
3. The TEXT reference scanner might continue to hash volatile paths/buckets. Task 3's incident-token cases must show no volatile entries while an authoritative unknown TEXT surface still blocks.
4. A V1/V2 artifact or confirmation might reach writable storage. Tasks 1, 4, and 8 must assert refusal with `writableStorageOpenCount === 0` even for checksum-valid forged input.
5. Backup, preview, live `BEGIN IMMEDIATE`, postconditions, and replay might use different row sets. Tasks 5–7 and the final restricted gate must exercise the same volatile-only growth and authoritative-drift cases at every boundary.

---

## File Structure

| File | Responsibility and bounded change |
| --- | --- |
| `server/repairs/crmDuplicateConsolidation.js` | V3 constants; one deeply frozen exclusion policy; strict policy/plan-shape validator; V3 checksummed plan; V3 artifact/manifest identity. Do not change fixed pairs, Berlin digest, source predicates, ledger, or safety algorithms. |
| `server/storage/sqlite.js` | Keep all-table schema inventory; scan rows only for authoritative tables; filter reference inventory; bind V3 inspection shape; update backup/live comparisons and protected-table loops; independently check complete schema in final state/replay. Keep existing exact SQL writes and transaction shape. |
| `server/services/crmDuplicateConsolidationRepair.js` | Preserve preview/read-only and apply/service boundaries; compare V3 backup authority fields; reject old artifacts through the contract validator. |
| `scripts/repair-crm-duplicate-consolidation.js` | Change closed manifest-ID pattern to v3; keep exact confirmation and pre-writable validation via imported constants; retain preview default and safe apply/replay projector. No new flags. |
| `test/crmDuplicateConsolidationV3Contract.test.js` | New focused policy, database/schema, reference, plan-shape, and synthetic parity tests using the real SQLite adapter and exported fixture. |
| `test/crmDuplicateConsolidationV2Contract.test.js` | Preserve V2-origin safety/source tests; update the sole active-version assertion to V3 rather than leaving an obsolete assertion that fails the suite. Its filename records provenance, not a second live V2 contract. |
| `test/crmDuplicateConsolidationRepair.test.js` | Update live-version assertions and existing synthetic fixture/plan assertions; add real-adapter preview/authority checks. The fixture's synthetic Berlin identity must remain intentionally non-authorizing. |
| `test/crmDuplicateConsolidationRepairSafety.test.js` | Update TEXT-column count for the exact two excluded tables; add schema/reference/backup/race/replay negative and restricted-gate companion cases. |
| `test/crmDuplicateConsolidationCli.test.js` | Version/confirmation/refusal/zero-writable-open tests and unchanged output privacy regression. |
| `test/fixtures/crmDuplicateConsolidationReferenceSchema.sql` | Read-only fixture reference; do not edit unless a failing test proves the existing unknown-schema probe cannot express a required V3 case. |
| `docs/crm-duplicate-consolidation-repair.md` | Append V3 current contract and checkpoint warning without erasing V1/V2 provenance. |
| `docs/reviews/crm-duplicate-consolidation-implementation-verification.md` | Append final V3 public/restricted verification record; no raw evidence. |

The current code entry points are `crmDuplicateConsolidationDatabaseState` and `crmDuplicateConsolidationReferenceInventory` in `server/storage/sqlite.js`; `inspectCrmDuplicateConsolidationState` and `inspectCrmDuplicateConsolidation` construct the read-only inspection. `buildCrmDuplicateConsolidationPlan`, `validateCrmDuplicateConsolidationArtifact`, and `crmDuplicateConsolidationManifestId` live in `server/repairs/crmDuplicateConsolidation.js`. `verifyCrmDuplicateConsolidationBackupPlan`, `applyCrmDuplicateConsolidation`, and `crmDuplicateConsolidationFinalState` are SQLite adapter boundaries; the service exports `previewCrmDuplicateConsolidation`, `verifyCrmDuplicateConsolidationReviewedArtifact`, and `applyCrmDuplicateConsolidation`; the CLI exports `runCrmDuplicateConsolidationCli`. Existing public helpers `createFixture`, `rawDatabase`, `logicalSnapshot`, `syntheticReviewedArtifactFixture`, `applyInput`, and fixed fixture constants are exported from `test/crmDuplicateConsolidationRepair.test.js`.

The schema has `analytics_events(id TEXT PRIMARY KEY, created_at, event_name, path, referrer_host, utm_source, utm_medium, utm_campaign, placement)` and `contact_rate_limit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, bucket, created_at)`. `createFixture(t)` creates an application-consistent backup before test mutations. Its Berlin keys are deliberately synthetic, so `previewFixture` refuses; tests may compare inspections or build synthetic plans with the fixture helper, but **must not claim public positive apply or backup-verifier acceptance** from that fixture. The external retained-identity gate owns those positive assertions.

### Stable V3 interfaces for all tasks

Task 1 exports `CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES: readonly string[]`, `CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY: Readonly<{schema:string,policy:string,excludedRowTables:readonly string[]}>`, and `validateCrmDuplicateConsolidationRowAuthority(candidate): typeof CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY` from the repair module. `crmDuplicateConsolidationDatabaseState(database)` stays private and returns `{schema,requiredObjects,schemaDigest,rowsByAuthoritativeTable,authorityTableDigests,authorityLogicalDigest,authorityTotalRows}`. `crmDuplicateConsolidationReferenceInventory(state)` remains private and returns its existing `{entries,identifiers,blockers}` shape. `inspectCrmDuplicateConsolidationState` returns `database: {authorityLogicalDigest,authorityTotalRows,quickCheck,foreignKeyViolationCount}`, `schema`, `authorityTableDigests`, `relationshipInventory`, `referenceIdentifiers`, `rawRows`, `safety`, `runtimeSafetyAuthority`, and `currentState`; it must not return V2 `logicalDigest`, `totalRows`, or `tableDigests` fields. `buildCrmDuplicateConsolidationPlan` preserves its existing argument signature and returns `{manifestId,plan,planChecksum}` with `plan.rowAuthority`, `plan.database`, and `plan.authorityTableDigests`. Backup verification returns `{planChecksum,databaseAuthorityLogicalDigest,schemaDigest}`; the service compares `databaseAuthorityLogicalDigest` to `artifact.plan.database.authorityLogicalDigest`.

## Task 1: Establish V3 contract and closed row-authority policy

**Files:** Modify `server/repairs/crmDuplicateConsolidation.js`, `test/crmDuplicateConsolidationV2Contract.test.js`, `test/crmDuplicateConsolidationRepair.test.js`; create `test/crmDuplicateConsolidationV3Contract.test.js`.

**Interfaces:** Consumes existing `deeplyFreeze`, `stableCanonicalJson`, approval tuple, and artifact validator. Produces the three policy exports above plus V3 constants/manifest namespace for Tasks 2–8. Task 1 may add `rowAuthority` to the otherwise V2-shaped interim plan; Task 4 completes the V3 shape before any whole-branch claim.

- [ ] **Step 1: RED tests.** Add the imports and tests below to the new V3 contract file; change the old active-version assertions in `V2Contract.test.js` and `Repair.test.js` to the exact V3 strings (retain every source/safety assertion). In the V3 file:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
  CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY,
  validateCrmDuplicateConsolidationRowAuthority,
  crmDuplicateConsolidationManifestId,
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
} from '../server/repairs/crmDuplicateConsolidation.js';

test('V3 policy is closed, sorted, deeply frozen, and rejects recomputed-policy variants', () => {
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
    ['analytics_events', 'contact_rate_limit_events']);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES), true);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY), true);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, {
    schema: 'crm-duplicate-consolidation-row-authority-v1',
    policy: 'schema-bound-row-content-excluded',
    excludedRowTables: ['analytics_events', 'contact_rate_limit_events'],
  });
  for (const excludedRowTables of [
    ['contact_rate_limit_events', 'analytics_events'],
    ['analytics_events', 'contact_rate_limit_events', 'email_events'],
    ['analytics_events'],
  ]) {
    assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
      ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, excludedRowTables,
    }), /row.authority.*policy/i);
  }
  assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
    ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, override: true,
  }), /row.authority.*policy/i);
});

test('V3 namespace changes only versioned repair contracts', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA, 'crm-duplicate-consolidation-approval-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA, 'crm-duplicate-consolidation-checkpoint-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.match(crmDuplicateConsolidationManifestId(), /^crm-duplicate-consolidation:v3:[a-f0-9]{64}$/);
});
```

Also import `createFixture`, `syntheticReviewedArtifactFixture`, `canonicalJsonSha256`, and `verifyCrmDuplicateConsolidationReviewedArtifact`; add an artifact test for spec scenarios 4, 6, and 7. The CLI zero-writable-open version of scenario 4 is completed in Task 8.

```js
test('V3 pure validator refuses old or missing policy even with a valid checksum', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  for (const mutate of [
    (item) => { item.repairVersion = 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2'; },
    (item) => { delete item.plan.rowAuthority; },
    (item) => { item.plan.rowAuthority.policy = 'unreviewed'; },
  ]) {
    const candidate = structuredClone(artifact);
    mutate(candidate);
    candidate.planChecksum = canonicalJsonSha256(candidate.plan);
    assert.throws(() => verifyCrmDuplicateConsolidationReviewedArtifact({
      artifact: candidate, expectedPlanChecksum: candidate.planChecksum,
      expectedManifestId: candidate.manifestId,
    }), /version|row.authority.*policy/i);
  }
});
```

- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 policy|V3 namespace|V3 pure validator|V2 repair namespace|descriptor freezes' test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js`. Expect the new import of `CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES` or validator to fail as a missing export, plus old V2 version assertions to fail until updated; the pure policy tests require no database fixture, while the artifact case uses only the disposable synthetic fixture.
- [ ] **Step 3: Minimal GREEN contract.** Change only the active constants and manifest prefix; add this closed validator near `deeplyFreeze`, and call it from `validateCrmDuplicateConsolidationArtifact` after version/checksum checks. `buildCrmDuplicateConsolidationPlan` must include `rowAuthority: CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY` in its plan object so new artifacts carry it; Task 4 will finish shape validation.

```js
export const CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION =
  'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3';
export const CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA =
  'crm-duplicate-consolidation-plan-v3';
export const CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA =
  'crm-duplicate-consolidation-manifest-v3';
export const CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION =
  'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3';
export const CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES = Object.freeze([
  'analytics_events', 'contact_rate_limit_events',
]);
export const CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY = deeplyFreeze({
  schema: 'crm-duplicate-consolidation-row-authority-v1',
  policy: 'schema-bound-row-content-excluded',
  excludedRowTables: CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
});
export function validateCrmDuplicateConsolidationRowAuthority(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || stableCanonicalJson(candidate) !== stableCanonicalJson(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY)) {
    throw new Error('CRM duplicate consolidation row-authority policy is invalid.');
  }
  return CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY;
}
```

In the existing `crmDuplicateConsolidationManifestId()` function replace its return statement with:

```js
return `crm-duplicate-consolidation:v3:${canonicalJsonSha256(crmDuplicateConsolidationApprovalTuple())}`;
```

- [ ] **Step 4: GREEN/refactor/review.** Run the exact Step 2 command; expect pass. Run `node --test test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationV3Contract.test.js`; expect pass, retaining synthetic Berlin refusal. Check `git diff --check`; request a fresh Task 1 diff review for closed policy and unchanged incident tuple; correct findings and rerun tests.
- [ ] **Step 5: Commit.** `git add server/repairs/crmDuplicateConsolidation.js test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'feat(repair): define CRM consolidation V3 authority contract'`.

## Task 2: Build authoritative database-state shape without volatile row reads

**Files:** Modify `server/storage/sqlite.js` and `test/crmDuplicateConsolidationRepair.test.js`; extend `test/crmDuplicateConsolidationV3Contract.test.js`.

**Interfaces:** Consumes Task 1's frozen two-table constant; produces the private state and public inspection fields defined in Stable V3 interfaces. Schema and required-object inventory remain all-table. Task 3 adapts the reference scanner to the new authoritative-only state.

- [ ] **Step 1: RED tests.** Import `Database from 'better-sqlite3'`, `createSqliteCrmDuplicateConsolidationReadOnlyStorage`, `createFixture`, `rawDatabase`, `NOW`, and `POOLER` into the V3 test file. Add a local real-adapter helper and cases like these; use `ALTER TABLE` only on disposable fixture databases. A narrowly scoped `Database.prototype.prepare` observer around one read-only inspection must separately assert zero `COUNT(*)`/`SELECT *` row queries on the two excluded tables, not merely unchanged hashes; restore the original method in `finally` and do not run that test concurrently with another test in the same process.

```js
async function inspect(fixture) {
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config, { environment: {} });
  try { return await storage.inspectCrmDuplicateConsolidation(); }
  finally { storage.close(); }
}
function growVolatile(fixture, { analytics = false, rateLimit = false } = {}) {
  rawDatabase(fixture.sqlitePath, (db) => {
    if (analytics) db.prepare(`INSERT INTO analytics_events
      (id, created_at, event_name, path) VALUES (?, ?, 'page_view', ?)`)
      .run('v3-analytics-event', NOW, '/v3/volatile');
    if (rateLimit) db.prepare(`INSERT INTO contact_rate_limit_events (bucket, created_at)
      VALUES (?, ?)`).run('v3-rate-limit', NOW);
  });
}
test('V3 authoritative digest and count ignore both volatile tables', async (t) => {
  for (const variant of [{ analytics: true }, { rateLimit: true }, { analytics: true, rateLimit: true }]) {
    await t.test(JSON.stringify(variant), async (subtest) => {
      const fixture = await createFixture(subtest);
      const before = await inspect(fixture);
      growVolatile(fixture, variant);
      const after = await inspect(fixture);
      assert.equal(after.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
      assert.equal(after.database.authorityTotalRows, before.database.authorityTotalRows);
      assert.deepEqual(after.authorityTableDigests, before.authorityTableDigests);
      assert.equal(after.schema.digest, before.schema.digest);
      assert.equal(Object.hasOwn(after.authorityTableDigests, 'analytics_events'), false);
      assert.equal(Object.hasOwn(after.authorityTableDigests, 'contact_rate_limit_events'), false);
    });
  }
});
test('V3 schema includes both volatile tables and changes on their DDL', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  assert.ok(before.schema.tables.some((entry) => entry.name === 'analytics_events'));
  assert.ok(before.schema.tables.some((entry) => entry.name === 'contact_rate_limit_events'));
  rawDatabase(fixture.sqlitePath, (db) => db.exec('ALTER TABLE analytics_events ADD COLUMN v3_probe TEXT'));
  assert.notEqual((await inspect(fixture)).schema.digest, before.schema.digest);
});
test('V3 unrelated authoritative row drift changes authority', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  rawDatabase(fixture.sqlitePath, (db) => db.prepare(`UPDATE deal_hunter_opportunities
    SET canonical_name = ? WHERE opportunity_id = ?`).run('changed', POOLER.opportunityId));
  assert.notEqual((await inspect(fixture)).database.authorityLogicalDigest,
    before.database.authorityLogicalDigest);
});
test('V3 inspection prepares no excluded-table row scan', async (t) => {
  const fixture = await createFixture(t);
  const prepared = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function observedPrepare(sql, ...args) {
    prepared.push(String(sql));
    return original.call(this, sql, ...args);
  };
  try { await inspect(fixture); }
  finally { Database.prototype.prepare = original; }
  assert.equal(prepared.some((sql) => /SELECT\s+(?:COUNT\(\*\)[\s\S]*?|\*)\s+FROM\s+"?(?:analytics_events|contact_rate_limit_events)"?/i.test(sql)), false);
});
```

- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 authoritative|V3 schema|V3 unrelated' test/crmDuplicateConsolidationV3Contract.test.js`. Expect missing `authorityLogicalDigest`/`authorityTotalRows` fields and V2 all-row behavior to fail. Add the rate-limit DDL, unrelated-row insert, new-table default, fixed 250,000-row bound, missing excluded-table, and no-excluded-row-SQL assertions **before** changing storage. For the bound, use one recursive-CTE insert of 250,001 rows into a new authoritative synthetic table and require the existing bound error before any `SELECT *` on it; separately insert 250,001 rate-limit rows and require no bound error. This is a disposable local test, not a runtime bound override.
- [ ] **Step 3: Minimal GREEN.** Keep `crmDuplicateConsolidationSchema(database)` and `crmDuplicateConsolidationRequiredObjects(database)` unchanged. In `crmDuplicateConsolidationDatabaseState`, validate both excluded names are present in `schema`; then use this exact table predicate before any row SQL. Map the new V3 database and `authorityTableDigests` names in `inspectCrmDuplicateConsolidationState`. Until Task 3 moves the reference scanner, retain a **private** `rowsByTable: rowsByAuthoritativeTable` alias containing authoritative rows only; until Task 4 switches plan construction, retain a **temporary inspection-only** `tableDigests` alias. Remove both aliases in their named follow-up tasks; no final V3 artifact may carry a legacy field. Import `CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES` into `Repair.test.js` and update its old `first.database.logicalDigest` assertion to `assert.equal(first.database.authorityLogicalDigest, canonicalDigest(Object.fromEntries(Object.entries(before).filter(([name]) => !CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(name)))))`. Keep integrity pragmas and all-table schema digest unchanged.

```js
const schemaNames = new Set(schema.map((table) => table.name));
for (const name of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
  if (!schemaNames.has(name)) throw new Error(`CRM duplicate consolidation required schema table missing: ${name}.`);
}
const authoritativeTables = schema.filter((table) =>
  !CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(table.name));
let authorityTotalRows = 0;
const rowsByAuthoritativeTable = {};
const authorityTableDigests = {};
for (const table of authoritativeTables) {
  const quoted = quoteCrmDuplicateConsolidationIdentifier(table.name);
  const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get()?.count || 0);
  authorityTotalRows += count;
  if (authorityTotalRows > crmDuplicateConsolidationMaximumRows)
    throw new Error('CRM duplicate consolidation inspection row bound exceeded.');
  const rows = database.prepare(`SELECT * FROM ${quoted}`).all().sort((a, b) =>
    compareCrmDuplicateConsolidationText(stableCrmDuplicateConsolidationJson(a), stableCrmDuplicateConsolidationJson(b)));
  rowsByAuthoritativeTable[table.name] = rows;
  authorityTableDigests[table.name] = { rowCount: rows.length, digest: canonicalJsonSha256(rows) };
}
const authorityLogicalDigest = canonicalJsonSha256(rowsByAuthoritativeTable);
```

For the temporary bridge between independently reviewed tasks, the state return also contains `rowsByTable: rowsByAuthoritativeTable`, and the inspection return contains `tableDigests: state.authorityTableDigests`. These aliases contain **no volatile rows**; Task 3 deletes the first and Task 4 deletes the second. Do not export or use them as the final V3 plan shape.

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command and `node --test test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationV3Contract.test.js`; require zero failures before committing. Confirm the SQL trace and schema tests pass. Ask a fresh reviewer to verify no excluded-row SQL, unknown-table default authority, and the private aliases' limited lifetime; rerun the focused suite after fixes.
- [ ] **Step 5: Commit.** `git add server/storage/sqlite.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'feat(repair): scope V3 database row authority'`.

## Task 3: Apply the same boundary to reference inventory

**Files:** Modify `server/storage/sqlite.js`, `test/crmDuplicateConsolidationRepairSafety.test.js`, `test/crmDuplicateConsolidationV3Contract.test.js`.

**Interfaces:** Consumes `rowsByAuthoritativeTable` and the frozen exclusion list. Produces the existing `{entries,identifiers,blockers}` inventory with no row-level entries from the two excluded tables. All authoritative table classifications remain V2-identical.

- [ ] **Step 1: RED tests.** Add to the V3 test file:

```js
test('V3 reference inventory never scans volatile incident tokens', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  rawDatabase(fixture.sqlitePath, (db) => {
    db.prepare(`INSERT INTO analytics_events (id, created_at, event_name, path)
      VALUES ('v3-reference', ?, 'page_view', ?)`).run(NOW, `/${POOLER.supersededSubmissionId}`);
    db.prepare(`INSERT INTO contact_rate_limit_events (bucket, created_at)
      VALUES (?, ?)`).run(POOLER.supersededSubmissionId, NOW);
  });
  const after = await inspect(fixture);
  assert.deepEqual(after.relationshipInventory, before.relationshipInventory);
  assert.deepEqual(after.referenceIdentifiers, before.referenceIdentifiers);
  assert.ok(after.relationshipInventory.every((entry) =>
    !['analytics_events', 'contact_rate_limit_events'].includes(entry.table)));
  assert.equal(after.blockers.some((value) => /analytics_events|contact_rate_limit_events/.test(value)), false);
});
```

Update the existing safety test `preview inventories every application TEXT column` so its expected count excludes exactly the two names; retain its checks for `admin_audit_events`, imports, historical receipts, and scoped identifiers. Add an authoritative unknown TEXT table containing `POOLER.supersededSubmissionId` and assert the existing `unclassified positive incident reference: <table>.<column>` blocker. Retain the existing `test/fixtures/crmDuplicateConsolidationReferenceSchema.sql` relationship-column blocker test unchanged.
- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 reference|preview inventories every application TEXT column|preview blocks a positive incident reference' test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepairSafety.test.js`. Expect the volatile-column inventory/deep-equality assertions to fail under V2's all-table scanner.
- [ ] **Step 3: Minimal GREEN.** In `crmDuplicateConsolidationReferenceTokens`, change `state.rowsByTable.contact_submissions` and `.deal_hunter_opportunity_aliases` to `state.rowsByAuthoritativeTable` (both remain authoritative). In `crmDuplicateConsolidationReferenceInventory`, iterate `state.schema` but `continue` before TEXT-column work when the table name is in the frozen exclusion list; use `state.rowsByAuthoritativeTable[table.name]`. Remove the Task 2 private `rowsByTable` alias. Do not change `findCrmDuplicateConsolidationUnclassifiedSchema(state.schema)` or configured classifications for authoritative tables.

Insert these two statements as the first statements of the existing `for (const table of state.schema)` body, replacing its current `const rows = state.rowsByTable[table.name] || []` line; leave its per-column matching loop intact:

```js
if (CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(table.name)) continue;
const rows = state.rowsByAuthoritativeTable[table.name];
```

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command; expect pass. Run `node --test test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationV3Contract.test.js`; require zero failures. Ask a fresh reviewer to check no volatile row enters `matchedRowCount`, `matchedRowsDigest`, `matchedIdentifiersDigest`, blockers, or checksum, and no unknown authoritative surface loses its blocker.
- [ ] **Step 5: Commit.** `git add server/storage/sqlite.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'feat(repair): scope V3 duplicate reference authority'`.

## Task 4: Build and validate the exact V3 plan/artifact shape

**Files:** Modify `server/repairs/crmDuplicateConsolidation.js`, `server/storage/sqlite.js`, `test/crmDuplicateConsolidationV3Contract.test.js`, `test/crmDuplicateConsolidationRepair.test.js`.

**Interfaces:** Consumes the Task 2 inspection shape and Task 1 policy validator. Produces checksummed `plan.rowAuthority`, explicit V3 database/`authorityTableDigests`, strict V3 artifact validation, and the existing `{manifestId,plan,planChecksum}` return. Approval/checkpoint remain v1.

- [ ] **Step 1: RED tests.** In the V3 test file use `syntheticReviewedArtifactFixture(fixture)` (which deliberately bypasses only synthetic identity blockers) and `canonicalJsonSha256`/`verifyCrmDuplicateConsolidationReviewedArtifact`:

```js
test('V3 plan binds only authoritative rows and rejects checksum-valid policy forgery', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  assert.deepEqual(artifact.plan.rowAuthority, CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY);
  assert.deepEqual(Object.keys(artifact.plan.database).sort(),
    ['authorityLogicalDigest', 'authorityTotalRows', 'foreignKeyViolationCount', 'quickCheck'].sort());
  assert.equal(Object.hasOwn(artifact.plan, 'tableDigests'), false);
  assert.equal(Object.hasOwn(artifact.plan, 'authorityTableDigests'), true);
  for (const excludedRowTables of [
    ['contact_rate_limit_events', 'analytics_events'],
    ['analytics_events', 'contact_rate_limit_events', 'email_events'],
  ]) {
    const forged = structuredClone(artifact);
    forged.plan.rowAuthority.excludedRowTables = excludedRowTables;
    forged.planChecksum = canonicalJsonSha256(forged.plan);
    assert.throws(() => verifyCrmDuplicateConsolidationReviewedArtifact({
      artifact: forged, expectedPlanChecksum: forged.planChecksum,
      expectedManifestId: forged.manifestId,
    }), /row.authority.*policy/i);
  }
});
```

Add independent variants for missing policy, changed policy string/schema, extra key, legacy `database.logicalDigest`/`database.totalRows`/`tableDigests`, missing excluded table in `plan.schema.tables`, mismatched `authorityTableDigests` key set/count, and V1/V2 plan/manifest/version values with recomputed checksum. Assert old artifacts refuse before any storage factory at the CLI boundary in Task 8; the pure artifact validator must already refuse here.
- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 plan binds|V3 plan shape|V3 old artifact' test/crmDuplicateConsolidationV3Contract.test.js`. Expect old `tableDigests` or missing V3 database fields to violate assertions, and forged shape/policy to pass or fail with the wrong guard until strict validation is implemented.
- [ ] **Step 3: Minimal GREEN.** In `buildCrmDuplicateConsolidationPlan`, replace `tableDigests: inspection.tableDigests` with `authorityTableDigests: inspection.authorityTableDigests` and keep `rowAuthority` from Task 1. Remove the temporary Task 2 `inspection.tableDigests` alias. In the artifact validator, after exact version/tuple validation and before return, require exact plan-level repair type/version, approval/plan/manifest schemas, exact policy, database keys, no legacy fields, both excluded schema names, authoritative key set equal to all schema table names minus the two excluded names, `authorityTotalRows` equal to the sum of authoritative row counts, and valid digest shapes. The canonical checksum already covers the policy and all bound fields; do not accept a recomputed checksum as permission to alter the policy.

```js
validateCrmDuplicateConsolidationRowAuthority(artifact.plan?.rowAuthority);
if (artifact.plan?.repairType !== CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE
  || artifact.plan?.repairVersion !== CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION
  || artifact.plan?.approvalSchema !== CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA) {
  throw new Error('Reviewed CRM duplicate consolidation V3 plan version is invalid.');
}
const database = artifact.plan?.database;
if (!database || stableCanonicalJson(Object.keys(database).sort()) !== stableCanonicalJson([
  'authorityLogicalDigest', 'authorityTotalRows', 'quickCheck', 'foreignKeyViolationCount',
].sort()) || Object.hasOwn(artifact.plan, 'tableDigests')) {
  throw new Error('Reviewed CRM duplicate consolidation V3 database authority shape is invalid.');
}
const tableNames = artifact.plan?.schema?.tables?.map((table) => table.name) || [];
for (const name of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
  if (!tableNames.includes(name)) throw new Error(`Reviewed V3 schema lacks ${name}.`);
}
const authoritativeNames = tableNames.filter((name) =>
  !CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(name)).sort();
if (stableCanonicalJson(Object.keys(artifact.plan?.authorityTableDigests || {}).sort())
  !== stableCanonicalJson(authoritativeNames)) {
  throw new Error('Reviewed V3 authoritative table set is invalid.');
}
const digests = authoritativeNames.map((name) => artifact.plan.authorityTableDigests[name]);
if (digests.some((entry) => !entry || !Number.isSafeInteger(entry.rowCount)
  || entry.rowCount < 0 || !/^[a-f0-9]{64}$/.test(String(entry.digest)))) {
  throw new Error('Reviewed V3 authoritative table digest is invalid.');
}
if (!Number.isSafeInteger(database.authorityTotalRows)
  || database.authorityTotalRows !== digests.reduce((sum, entry) => sum + entry.rowCount, 0)
  || !/^[a-f0-9]{64}$/.test(String(database.authorityLogicalDigest))) {
  throw new Error('Reviewed V3 authoritative database digest or count is invalid.');
}
```

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command, then `node --test test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationV2Contract.test.js`; expect pass. Refactor repeated name-set checking into one private validator, not a configurable registry. Ask a fresh reviewer to inspect malformed/checksum-valid V1/V2 and policy cases and absence of any fallback.
- [ ] **Step 5: Commit.** `git add server/repairs/crmDuplicateConsolidation.js server/storage/sqlite.js test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepair.test.js && git commit -m 'feat(repair): bind V3 row authority into reviewed plans'`.

## Task 5: Reproduce V3 authority from an immutable backup

**Files:** Modify `server/storage/sqlite.js`, `server/services/crmDuplicateConsolidationRepair.js`; extend `test/crmDuplicateConsolidationV3Contract.test.js` and `test/crmDuplicateConsolidationRepairSafety.test.js`.

**Interfaces:** Consumes V3 plan/inspection from Tasks 2–4. Produces backup verification `{planChecksum,databaseAuthorityLogicalDigest,schemaDigest}` and the same single-use WeakMap capability. The service's `applyCrmDuplicateConsolidation` consumes that exact shape.

- [ ] **Step 1: RED tests.** Import `path from 'node:path'` into the V3 test file. Use the real read-only adapter to inspect a newly created parity backup as an independent SQLite file (change only `config.storage.sqlitePath` to that new path) and the live fixture after inserting exactly three analytics and two rate-limit rows. Never overwrite `fixture.backupPath`, which is the fixture's original checkpoint backup. The helper `inspect` in Task 2 can accept a config override; do not open the parity backup writable. Compare the two inspections and synthetic planned checksums. Add authoritative-row and excluded-table-schema drift variants that must not match. In the later external restricted harness, use the same counts (`137/105` backup and `140/107` live) with the retained exact identity to call **real** `verifyCrmDuplicateConsolidationBackupPlan`; ordinary synthetic CI cannot pass its fixed Berlin blockers.

```js
test('V3 sanitized 137/105 to 140/107 parity leaves reviewed authority equal', async (t) => {
  const fixture = await createFixture(t);
  const parityBackupPath = path.join(fixture.root, 'v3-parity-backup.sqlite');
  rawDatabase(fixture.sqlitePath, (db) => {
    db.exec('DELETE FROM analytics_events; DELETE FROM contact_rate_limit_events;');
    for (let i = 0; i < 137; i += 1) db.prepare(`INSERT INTO analytics_events
      (id, created_at, event_name, path) VALUES (?, ?, 'page_view', '/fixture')`)
      .run(`a-${i}`, NOW);
    for (let i = 0; i < 105; i += 1) db.prepare(`INSERT INTO contact_rate_limit_events
      (bucket, created_at) VALUES ('fixture', ?)`).run(NOW);
  });
  await fixture.storage.createApplicationBackup(parityBackupPath);
  rawDatabase(fixture.sqlitePath, (db) => {
    for (let i = 137; i < 140; i += 1) db.prepare(`INSERT INTO analytics_events
      (id, created_at, event_name, path) VALUES (?, ?, 'page_view', '/fixture')`)
      .run(`a-${i}`, NOW);
    for (let i = 105; i < 107; i += 1) db.prepare(`INSERT INTO contact_rate_limit_events
      (bucket, created_at) VALUES ('fixture', ?)`).run(NOW);
  });
  const live = await inspect(fixture);
  const backup = await inspect({ ...fixture, config: {
    ...fixture.config, storage: { ...fixture.config.storage, sqlitePath: parityBackupPath },
  } });
  assert.equal(live.database.authorityLogicalDigest, backup.database.authorityLogicalDigest);
  assert.deepEqual(live.authorityTableDigests, backup.authorityTableDigests);
  assert.equal(live.schema.digest, backup.schema.digest);
  assert.equal(live.database.authorityTotalRows, backup.database.authorityTotalRows);
  const counts = (sqlitePath) => rawDatabase(sqlitePath, (db) => ({
    analytics: db.prepare('SELECT COUNT(*) AS count FROM analytics_events').get().count,
    rateLimit: db.prepare('SELECT COUNT(*) AS count FROM contact_rate_limit_events').get().count,
  }), { readonly: true });
  assert.deepEqual(counts(parityBackupPath), { analytics: 137, rateLimit: 105 });
  assert.deepEqual(counts(fixture.sqlitePath), { analytics: 140, rateLimit: 107 });
});
```

- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 sanitized|V3 backup authoritative|V3 backup schema' test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepairSafety.test.js`. Expect V2 all-table digest/field comparisons to fail. Add a public service test with a fake `storage.verifyCrmDuplicateConsolidationBackupPlan` returning only `databaseAuthorityLogicalDigest` and `planChecksum`; it must reach the next service gate rather than reject for missing V2 `databaseLogicalDigest`. The restricted gate's positive backup test stays RED until the real adapter change is made.
- [ ] **Step 3: Minimal GREEN.** In `verifyCrmDuplicateConsolidationBackupPlan` compare `inspection.database.authorityLogicalDigest` with `artifact.plan.database.authorityLogicalDigest`, plus exact V3 plan checksum and complete schema digest. Return `databaseAuthorityLogicalDigest`, not the old key. Change the service's one comparison to that key. Leave file stat/read/stat, SHA, sidecar rejection, `Database(Buffer)`, `query_only`, read transaction, reviewed config fact injection, and WeakMap binding untouched.

```js
if (planned.planChecksum !== artifact.planChecksum
  || inspection.database.authorityLogicalDigest !== artifact.plan.database.authorityLogicalDigest
  || inspection.schema.digest !== artifact.plan.schema.digest) {
  throw new Error('backup does not reproduce the reviewed V3 plan and authoritative database digest');
}
const verification = Object.freeze({
  planChecksum: planned.planChecksum,
  databaseAuthorityLogicalDigest: inspection.database.authorityLogicalDigest,
  schemaDigest: inspection.schema.digest,
});
```

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command; expect pass for public parity/service tests. In the restricted gate, require positive verification with volatile-only differences and refusal with one authoritative-row or schema difference; preserve the exact backup checksum by creating a new disposable test backup after each mutation, never editing a verified backup. Ask a fresh reviewer to check that backup-supplied config is still only reviewed external facts, not claimed live config proof.
- [ ] **Step 5: Commit.** `git add server/storage/sqlite.js server/services/crmDuplicateConsolidationRepair.js test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepairSafety.test.js && git commit -m 'fix(repair): make V3 backup authority ignore volatile rows'`.

## Task 6: Rebuild and compare V3 authority inside BEGIN IMMEDIATE

**Files:** Modify `server/storage/sqlite.js`; extend `test/crmDuplicateConsolidationRepairSafety.test.js`, `test/crmDuplicateConsolidationV3Contract.test.js`.

**Interfaces:** Consumes V3 artifact and single-use backup verification. Produces the existing `repair-required`/typed-refusal result; fixed SQL write ledger and `testHooks` stay unchanged. The external restricted gate supplies positive fixed Berlin evidence for real first apply.

- [ ] **Step 1: RED tests.** Add public read-only authority tests in the V3 contract file for analytics-only, rate-limit-only, both, an authoritative unrelated-row update, and a target raw-row update between two inspections. In the external restricted harness, add real-adapter cases that run preview, then mutate the disposable live database, then invoke the existing `applyCrmDuplicateConsolidation(applyInput(...))`: each volatile-only variant succeeds at exactly four writes; authoritative, target, or durable-safety drift refuses with no repair relation/receipt. A public negative can use the synthetic artifact and assert the live inspection still reports fixed Berlin blockers, never success.

```js
test('V3 target drift remains visible even when volatile activity is ignored', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  growVolatile(fixture, { analytics: true, rateLimit: true });
  rawDatabase(fixture.sqlitePath, (db) => db.prepare(`UPDATE contact_submissions
    SET company = ? WHERE id = ?`).run('changed target', POOLER.survivorSubmissionId));
  const after = await inspect(fixture);
  assert.notEqual(after.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
  assert.notDeepEqual(after.rawRows, before.rawRows);
});
```

- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 target drift|V3 apply authority' test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepairSafety.test.js`; expect any positive transaction-boundary test in the restricted harness to refuse on the still-V2 `logicalDigest` comparison. Do not mark a synthetic public refusal as positive coverage.
- [ ] **Step 3: Minimal GREEN.** In the existing `database.transaction(() => { ... })` in `applyCrmDuplicateConsolidation`, retain the four-source runtime-safety recheck **before** receipt lookup. In the new-apply path, compare `planned.manifestId`, `planned.planChecksum`, `inspection.database.authorityLogicalDigest`, complete `inspection.schema.digest`, and exact `inspection.rawRows` to the artifact; retain every current blocker and exact Berlin CAS. Do not copy a backup/preview digest directly into the transaction without reinspection.

```js
if (planned.manifestId !== artifact.manifestId
  || planned.planChecksum !== artifact.planChecksum
  || inspection.database.authorityLogicalDigest !== artifact.plan.database.authorityLogicalDigest
  || inspection.schema.digest !== artifact.plan.schema.digest
  || stableCrmDuplicateConsolidationJson(inspection.rawRows)
    !== stableCrmDuplicateConsolidationJson(artifact.plan.rawRows)) {
  throw new Error('Apply refused: live raw-row, schema, authoritative database, or reviewed plan drift.');
}
```

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command; then run the Task 6 restricted positive/negative transaction cases with the real adapter. Expect four-row first apply only for volatile drift; zero repair writes for authoritative/target/safety drift. Include a race after CLI read-only safety preflight but before `BEGIN IMMEDIATE` and prove the transaction recheck refuses. Ask a fresh reviewer to confirm the fixed SQL ledger, receipt insertion ordering, CAS, rollback hooks, and safety checks were not weakened.
- [ ] **Step 5: Commit.** `git add server/storage/sqlite.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'fix(repair): enforce V3 authority at apply boundary'`.

## Task 7: Preserve V3 postconditions and zero-write replay

**Files:** Modify `server/storage/sqlite.js`; extend `test/crmDuplicateConsolidationRepairSafety.test.js`, `test/crmDuplicateConsolidationV3Contract.test.js`.

**Interfaces:** Consumes `plan.authorityTableDigests`, `plan.schema.digest`, and the existing final-state/receipt validators. Produces unchanged result schemas with row-content checks over authoritative protected tables only and full schema checks in first-apply postconditions **and** replay.

- [ ] **Step 1: RED tests.** Add public schema/digest tests and restricted real-adapter tests. Restricted sequence: snapshot authoritative digest, target/import raw hashes, relation/receipt counts, and the two volatile counts; preview and first apply; add one analytics row and one rate-limit row; replay; assert `verified-prior-apply`, `applied:false`, `mutationCount:0`, equal authoritative digest/target/import hashes/relation/receipt counts, and diagnostic volatile counts increased. Repeat with an authoritative protected-table update and require zero-write refusal. Independently ALTER each excluded table after first apply and require replay refusal. Keep receipt UPDATE/DELETE attempts and five rollback hooks. Example public pre/post accounting helper:

```js
async function authorityAccounting(fixture) {
  const inspection = await inspect(fixture);
  const counts = rawDatabase(fixture.sqlitePath, (db) => ({
    analytics: db.prepare('SELECT COUNT(*) AS count FROM analytics_events').get().count,
    rateLimit: db.prepare('SELECT COUNT(*) AS count FROM contact_rate_limit_events').get().count,
    relations: db.prepare('SELECT COUNT(*) AS count FROM crm_submission_supersessions').get().count,
    receipts: db.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_repair_manifests
      WHERE mode = 'crm-duplicate-consolidation'`).get().count,
  }), { readonly: true });
  return {
    authorityDigest: inspection.database.authorityLogicalDigest,
    rawRows: inspection.rawRows,
    relations: counts.relations,
    receipts: counts.receipts,
    volatileDiagnostic: { analytics: counts.analytics, rateLimit: counts.rateLimit },
  };
}
```

Do **not** claim an all-table digest is equal after a concurrent volatile insert. The external harness must isolate its test writes from background activity and attribute repair-origin mutations from the exact ledger, while reporting volatile movement separately.
- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 replay|V3 postcondition' test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationRepairSafety.test.js`; expect old `artifact.plan.tableDigests` loops to fail or omit V3 checks. In the restricted gate, volatile growth currently trips V2 replay/postcondition logic, and excluded-table schema drift is not fully compared on replay.
- [ ] **Step 3: Minimal GREEN.** Change both protected-table loops in `applyCrmDuplicateConsolidation` from `artifact.plan.tableDigests` to `artifact.plan.authorityTableDigests`, still skipping only `crm_submission_supersessions`, `deal_hunter_crm_imports`, and `deal_hunter_cim_repair_manifests` because they have specialized exact validation. Add a complete independent current schema comparison in `crmDuplicateConsolidationFinalState`, **before** receipt validation in both first apply and replay; keep `assertCrmDuplicateConsolidationRequiredObjects` and SQLite integrity checks. Never re-run the pre-apply whole plan on already-mutated rows in replay.

```js
const currentSchema = crmDuplicateConsolidationSchema(database);
const currentRequiredObjects = assertCrmDuplicateConsolidationRequiredObjects(
  database, artifact.plan.schema.requiredObjects, 'final-state',
);
if (canonicalJsonSha256({ tables: currentSchema, requiredObjects: currentRequiredObjects })
  !== artifact.plan.schema.digest) {
  throw new Error('CRM duplicate consolidation final-state complete schema drift.');
}
for (const [table, expected] of Object.entries(artifact.plan.authorityTableDigests)) {
  if (['crm_submission_supersessions', 'deal_hunter_crm_imports',
    'deal_hunter_cim_repair_manifests'].includes(table)) continue;
  const rows = database.prepare(`SELECT * FROM ${quoteCrmDuplicateConsolidationIdentifier(table)}`).all()
    .sort((a, b) => compareCrmDuplicateConsolidationText(
      stableCrmDuplicateConsolidationJson(a), stableCrmDuplicateConsolidationJson(b)));
  if (rows.length !== expected.rowCount || canonicalJsonSha256(rows) !== expected.digest)
    throw new Error(`CRM duplicate consolidation protected-table drift: ${table}.`);
}
```

- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command and restricted first-apply/replay/rollback/receipt tests. Expect exactly four first-apply rows, zero replay rows after volatile growth, refusal on authoritative/schema drift, unchanged protected authoritative digest, unchanged target/import hashes after replay, and receipt bytes unchanged. Refactor the two identical loops into a private, narrowly scoped protected-table helper only after tests are green. Ask a fresh reviewer to check mutation-table special handling and schema verification on **both** branches.
- [ ] **Step 5: Commit.** `git add server/storage/sqlite.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'fix(repair): preserve V3 replay across volatile activity'`.

## Task 8: Enforce V3 at the CLI and retain the privacy projector

**Files:** Modify `scripts/repair-crm-duplicate-consolidation.js`; extend `test/crmDuplicateConsolidationCli.test.js`.

**Interfaces:** Consumes V3 constants and pure reviewed-artifact validator. Produces unchanged `runCrmDuplicateConsolidationCli` arguments/output, with the v3 manifest ID pattern and pre-writable V1/V2/policy refusal. No flag or output field is added.

- [ ] **Step 1: RED tests.** Extend the existing `V1 and malformed checksum-valid authority artifacts refuse before any storage construction` table to include V2 plan/manifest/version, missing `rowAuthority`, reordered/third exclusions with recomputed plan checksum, legacy V2 database fields, and the old V2 confirmation. Preserve `readOnlyOpens === 0` and `writableOpens === 0` for malformed artifact cases; for wrong confirmation use `writableOpens === 0`. Add an exact `v3` safe apply-result projector case and retain the existing synthetic restricted sentinel, nested unknown-field, Base64/hex/URI, stderr, and malformed-result tests.

```js
const candidate = structuredClone(artifact);
candidate.plan.rowAuthority.excludedRowTables.push('email_events');
candidate.planChecksum = canonicalJsonSha256(candidate.plan);
fs.writeFileSync(artifactPath, stableCanonicalJson(candidate), { mode: 0o600 });
let writableStorageOpenCount = 0;
await assert.rejects(runCrmDuplicateConsolidationCli({
  argv: applyArgs(fixture, artifactPath, candidate),
  getConfigFn: () => fixture.config,
  createWritableStorageFn: () => {
    writableStorageOpenCount += 1;
    throw new Error('writable storage must not open');
  },
  environment: {},
}), /row.authority.*policy/i);
assert.equal(writableStorageOpenCount, 0);
```

- [ ] **Step 2: Confirm RED.** Run `node --test --test-name-pattern='V3 CLI|V1 and malformed|apply requires every|operator apply and replay stdout' test/crmDuplicateConsolidationCli.test.js`. Expect v3 manifest result projection to refuse under the old `:v2:` regex, and the new V2/policy cases to reveal any missing early guard.
- [ ] **Step 3: Minimal GREEN.** Set the one local `manifestIdPattern` to `/^crm-duplicate-consolidation:v3:[a-f0-9]{64}$/`; use the imported V3 confirmation unchanged in `parseCrmDuplicateConsolidationArgs` and `runCrmDuplicateConsolidationCli`. Keep `loadAndVerifyReviewedArtifact` ahead of `createWritableStorageFn`, the complete checkpoint validator, read-only safety preflight, and `projectCrmDuplicateConsolidationApplyResult`'s fixed allowlist unchanged in shape. Add **no** CLI option for row policy.
- [ ] **Step 4: GREEN/refactor/review.** Run the Step 2 command, then `node --test test/crmDuplicateConsolidationCli.test.js`; expect pass. Search `rg -n 'v2:|V2|--.*exclu|rowAuthority' scripts/repair-crm-duplicate-consolidation.js` and verify only historical/test context remains. Ask a fresh reviewer to check the zero-writable-open and restricted-output/privacy gates.
- [ ] **Step 5: Commit.** `git add scripts/repair-crm-duplicate-consolidation.js test/crmDuplicateConsolidationCli.test.js && git commit -m 'fix(repair): bind CRM consolidation CLI to V3 authority'`.

## Task 9: Prove V2-origin safety remains intact under V3

**Files:** Extend `test/crmDuplicateConsolidationV2Contract.test.js`, `test/crmDuplicateConsolidationRepair.test.js`, `test/crmDuplicateConsolidationRepairSafety.test.js`, `test/crmDuplicateConsolidationCli.test.js`, and `test/crmDuplicateConsolidationV3Contract.test.js` only where coverage is missing. Do not edit product code in this task unless a failing regression proves a specific defect; if so, create a separate focused fix task/commit and fresh review before proceeding.

**Interfaces:** Consumes final V3 code. Produces explicit regression evidence for approved spec scenarios 36–42 and canonical merge compatibility; ordinary CI retains synthetic digest refusal, while restricted acceptance supplies exact positive Berlin evidence.

- [ ] **Step 1: RED coverage audit and tests.** Keep the existing `marketplace inspection accepts approved URL-only evidence`, `financial authority comes from raw Annual Profit`, four-source config/durable tests, supersession audit, CLI privacy projection, and Supabase fail-closed tests. Add an explicit V3 regression test that asserts the checked-in Berlin digest, raw Annual Profit key, and no invented period; combine with an existing real-adapter generic CRM audit fixture and canonical-merge/supersession tests rather than importing private identity into Git. Example:

```js
test('V3 keeps the Berlin fixed digest and raw Annual Profit authority', () => {
  const berlin = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.find((pair) => pair.key === 'berlin');
  assert.equal(berlin.supersededDealKeySha256,
    '3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733');
  assert.equal(berlin.financialLabel, 'Annual Profit');
  assert.equal(Object.hasOwn(berlin, 'financialPeriod'), false);
});
```

- [ ] **Step 2: Confirm RED or coverage gap.** Run `node --test test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationCli.test.js test/crmDuplicateConsolidationV3Contract.test.js`. New tests should fail if any regression remains; if all pass immediately, record which existing test already proved each item, and do not invent a production change just to manufacture RED.
- [ ] **Step 3: GREEN/refactor/review.** Run focused supporting suites for generic audit, supersession, and canonical merge using actual filenames resolved by `rg --files test | rg 'CrmIntegrity|crmSubmissionSupersession|canonicalOpportunityMerge'`; then `npm test`. Expect zero failures, keeping the existing intentional synthetic Berlin refusal. Ask a fresh reviewer to trace seven regressions to assertions and confirm no generic CRM audit, schema, migration, or canonical-merge code was changed by V3.
- [ ] **Step 4: Commit.** `git add test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationCli.test.js test/crmDuplicateConsolidationV3Contract.test.js && git commit -m 'test: prove CRM consolidation V3 preserves V2 safety'`.

## Task 10: Append V3 operator and verification documentation

**Files:** Modify only `docs/crm-duplicate-consolidation-repair.md` and `docs/reviews/crm-duplicate-consolidation-implementation-verification.md`.

**Interfaces:** Consumes final code/test results and exact restricted-gate attestation. Produces a current V3 addendum without rewriting historical V1/V2 provenance or suggesting that this plan authorizes a production operation.

- [ ] **Step 1: RED documentation assertions.** Before editing docs, run `rg -n 'V3|historical-only for V3|analytics_events|contact_rate_limit_events' docs/crm-duplicate-consolidation-repair.md docs/reviews/crm-duplicate-consolidation-implementation-verification.md`; expect missing V3 contract. Add a test or documentation check that both docs contain the exact two names and the V3 plan/manifest/confirmation values, and that the runbook explicitly says the v126 checkpoint is historical-only.
- [ ] **Step 2: GREEN documentation.** Append a `## V3 row-authority correction` section to the runbook and a dated V3 verification section to the review record. State the 137/105 backup versus 140/107 live evidence, matching full schema/target hashes, and that the authorized preview never ran. Explain schema-all/rows-minus-exact-two/reference-minus-exact-two, v3 versions, immutable receipt and four writes, historical-only v126 checkpoint, and the required fresh post-deploy checkpoint. Preserve preview→owner review→separate apply and the CLI's safe output contract; never include a ready-to-run production apply command or restricted preimage.
- [ ] **Step 3: Verify/review.** Rerun the Step 1 documentation check and `git diff --check`; inspect `git diff -- docs/crm-duplicate-consolidation-repair.md docs/reviews/crm-duplicate-consolidation-implementation-verification.md` for privacy, historical wording, and no accidental operational authorization. Ask a fresh reviewer to verify the record matches actual test evidence, not hoped-for results.
- [ ] **Step 4: Commit.** `git add docs/crm-duplicate-consolidation-repair.md docs/reviews/crm-duplicate-consolidation-implementation-verification.md && git commit -m 'docs: document CRM consolidation V3 authority'`.

## Task 11: Final restricted acceptance and whole-branch verification

**Files:** No product change. Retain the external private harness, report, hashes, and archive outside Git; if the verification record needs final observed numbers, make one separate documentation-only commit and rerun all exact-head gates afterward. No production read or write.

**Interfaces:** Consumes the final implementation head, retained exact identity evidence, and the external privacy-reviewed harness. Produces a privacy-safe attestation for owner/independent review. Do not push or open/update a product-code PR until a later execution authorization explicitly permits it.

- [ ] **Step 1: Public gates at Node 22.** Run these exact commands from the isolated implementation worktree, stopping on any failure: `npm ci`; `npm audit --omit=dev`; `npm run lint`; `node --test test/crmDuplicateConsolidationV3Contract.test.js test/crmDuplicateConsolidationV2Contract.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationCli.test.js`; `npm test`; `npm run test:ui`; `npm run build`; `npm run test:browser`; `git diff --check`. Record command, exit status, test count, and exact HEAD. Dependency installation is **only for the later authorized execution gate**, not this plan-writing task.
- [ ] **Step 2: Restricted exact-evidence gate on disposable local SQLite.** Resolve the retained external package through its private manifest and verify the raw-evidence and harness SHA-256 before use. The retained `ug-p7-01n-restricted-acceptance.mjs` accepts `--repository`, `--evidence`, and `--report` but pins an old `TOOLING`/`TREE`/`BASE`/`STARTING_HEAD`; it **cannot** be run unchanged as V3 evidence. Make a separately named private V3 derivative (mode `0600`, outside Git), update those identities to the exact final branch, preserve its real CLI/service/adapter assertions, add the V3 cases, and give the derivative a new SHA-256 and provenance. Assign `V3_HARNESS`, `RETAINED_EVIDENCE`, and `V3_REPORT` to the absolute private paths established and hashed by that package's manifest, then run `node "$V3_HARNESS" --repository "$PWD" --evidence "$RETAINED_EVIDENCE" --report "$V3_REPORT"`. Do not copy raw evidence into Git or logs. Extend the derivative with three independent synthetic volatile-growth cases (analytics only, rate-limit only, both), using retained fixed Berlin identity only inside its private disposable database. Assert equal `authorityLogicalDigest`, `authorityTableDigests`, reference inventory, and `planChecksum` across each pair; a changed authoritative row or schema must refuse.
- [ ] **Step 3: Restricted execution matrix.** Through the **real CLI subprocess, service, read-only adapter, and `createSqliteStorage`** verify read-only preview, immutable backup reproduction, first apply exactly four rows, no repair-origin volatile write, Berlin import still unowned (`opportunity_id = NULL`), zero-write replay after volatile growth, authoritative/schema/safety/identity drift refusal, five rollback hooks (writes 1–4 and final postcondition), immutable receipt UPDATE/DELETE refusal, clean `quick_check`/FK checks, clean supersession audit, and unchanged generic CRM audit. For zero-write comparisons record authoritative digest, target/import raw hashes, relation/receipt counts, and volatile counts separately; do not require an all-table digest to be unchanged after deliberately adding volatile rows.
- [ ] **Step 4: Restricted privacy and provenance.** Scan the actual CLI stdout/stderr, new Git blobs, and private report for every retained sensitive value in plain, Base64, hex, and URI forms. Require zero unapproved matches and no raw preimage in tracked Git. Retain the private report/package/archive in durable owner-reviewable storage with file modes and independent archive readback/checksum; record only privacy-safe paths/hashes and counts in the handoff. A failed access, identity, privacy, or acceptance gate is a stop, never permission to weaken a guard.
- [ ] **Step 5: Whole-branch review and handoff.** Request a fresh independent whole-branch review of the exact final head, including the five Review Focus failures, all 42 spec scenarios, real-adapter/restricted evidence, version boundary, four-write ledger, safety, receipt/replay, privacy, and no production effects. Re-run affected focused/full gates after any normal correction commit. Verify `git diff --check`, exact branch diff and clean worktree; preserve the approved design commit in history. Push/open or update an implementation PR **only if a later owner authorization explicitly permits it**. Stop for owner review; do not merge/deploy/preview/apply production.

## Coverage index and execution stop rule

The approved design's scenarios map as follows: 1–7 → Tasks 1 and 4/8; 8–16 → Task 2 and Task 5 backup parity; 17–20 → Task 3; 21–24 → Task 5; 25–30 → Task 6; 31–35 → Task 7; 36–42 → Task 9. Task 11 repeats the exact positive/transaction/rollback/privacy subset against retained evidence. Additional spec assertions—missing excluded tables, authoritative row bound, exact old/new field shape, replay schema preservation, immutable receipt, and pre-writable refusals—are explicitly assigned above. Every task includes a focused RED/GREEN cycle, a fresh review gate, and a normal commit; no task licenses weaker production authority.

This document is a plan, not authorization to execute it. Owner review of this plan is the next gate.
