# CRM Duplicate Consolidation Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL:
> Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** One durable active CRM representation for each approved canonical opportunity while preserving every original record and historical relationship.

**Architecture:** Add a SQLite-only, durable `crm_submission_supersessions` relation whose invariants are enforced by constraints, indexes, triggers, and one immediate transaction. Centralize loser-write refusal behind one typed storage/service authority contract. Make existing active projections supersession-aware without creating a second CRM model; keep direct historical detail readable and combine histories at read time with `originSubmissionId`. Upgrade CRM match authority to v2 by hashing the complete contact-submission snapshot together with the complete active-supersession snapshot, canonicalizing loser candidates to survivors, and rechecking both inside the final SQLite transaction. Add a read-only duplicate-review projection and an incident-bounded, default-preview repair whose only future apply is the two approved supersession inserts, one Berlin import CAS update, and one storage-enforced append-only receipt.

**Tech stack:** Node.js, Express, React/Vite, `better-sqlite3`, existing storage/service patterns, Node test runner, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-crm-duplicate-consolidation-design.md` at approved commit `108fa677e0ecebd28190b1642862d13b7a20fcbb`, parent/baseline `cec88c5a37a5dc433896ee5fd737d606691a3f31`.

## Global constraints

The following safety language is copied from the approved specification and remains binding on every task:

> This document is design and read-only dry-run planning only. No cleanup, reconciliation, repair, source change, score backfill, identity resolution, CIM or broker send, follow-up transmission, Stage 2 activation, automation change, deployment, or production business-data mutation is authorized or performed.

> Pooler and Berlin must never be merged with each other by this repair, by a duplicate-report projection, or by transitive closure.

> No historical timestamp, sender/recipient evidence, delivery state, document reference, source observation, or financial observation is rewritten.

> Every business writer must resolve or guard supersession at its storage/service boundary. Frontend filtering is not authority.

> The safe default is refusal. Read-level canonicalization for matching/search is allowed because it does not mutate business state and produces one explicit survivor. Business mutations are never silently redirected.

> Preview is the default and performs zero business mutation.

> This must not become a general CRM rewrite.

Additional approved boundaries:

- Preserve both `contact_submissions` rows byte-for-byte during the incident apply. Do not use Archive, Pass, delete, or history reparenting as consolidation.
- Keep activity, legacy email, communication, CIM, recommendation, document, upload, scheduled-job, audit, prior-manifest, score, alias, and source-observation records on their original rows. Historical read-through must retain `originSubmissionId`.
- Leave all loser workflow values, both survivor overdue values, and the stale Pooler recommendation unchanged. Losers disappear through active projection semantics; survivor workflow cleanup is deferred.
- Keep Pooler opportunity `opp_683681c2-bd49-4c46-be4f-6d969143d907` and Berlin opportunity `opp_9b18427d-5fb5-4f92-be31-d92b810061b3` distinct.
- Implement current production behavior for SQLite only. Every Supabase supersession operation must fail closed with `CRM_SUPERSESSION_UNAVAILABLE`; do not imply Supabase parity.
- Do not change the semantic contract of `auditDealHunterCrmIntegrity`; supersession has a separate typed audit.
- The checked-in approval descriptor is the only authority for the two incident pairs. Do not accept arbitrary pair IDs from CLI or HTTP input.
- Reversal is a separately versioned, separately reviewed repair. It is not exposed as an ordinary service method, admin route, UI action, or incident CLI mode.
- No task below authorizes production access, deployment, preview execution against production, production apply, CRM reconciliation, sending, or automation changes.

## Verified repository map and implementation boundaries

The approved design branch is clean at `108fa677e0ecebd28190b1642862d13b7a20fcbb`; its parent is `cec88c5a37a5dc433896ee5fd737d606691a3f31`, and that commit changes exactly the approved specification. The repository has no separate SQLite migration runner. `createSqliteStorage(config)` in `server/storage/sqlite.js` owns idempotent startup DDL, so the schema task must extend that existing DDL after `deal_hunter_cim_repair_manifests` exists and prove upgrade behavior against an existing database.

| Area | Existing code to extend | Existing behavior that must remain |
|---|---|---|
| Storage selection | `server/storage/index.js` | Provider selection remains unchanged. |
| SQLite DDL and CRUD | `server/storage/sqlite.js` — `createSqliteStorage`, `readDealHunterCrmMatchAuthority`, `linkDealHunterCrmSubmissionIfAuthorityCurrent`, `listSubmissions`, `listFollowUpSubmissions`, `getSummary`, `getSubmissionStrict`, `updateSubmission`, `updateSubmissionIfCurrent`, `deleteSubmission`, `mutateWithCrmActivityTransaction`, `passDealHunterOpportunity` | One database, synchronous SQLite transactions, final link under `BEGIN IMMEDIATE`, existing lifecycle/concurrency checks. |
| Optional provider | `server/storage/supabase.js` | Existing CRM behavior remains; new supersession capabilities refuse before any remote query or write. |
| Submission services | `server/services/submissions.js` — `listDashboardSubmissions`, `getDashboardSubmission`, `listDashboardFollowUps`, `updateSubmissionWorkflow`, `deleteDashboardSubmission`, `createManualSubmission`, `enrichSubmission`, `enrichSubmissions` | Direct historical detail remains available; normal active lists remain the source for the admin CRM. |
| Lifecycle | `server/services/leadLifecycle.js` — `archiveLead`, `restoreLead`, `dismissDealHunterOpportunity`, `restoreDealHunterOpportunity` | Archive, restore, and Pass keep their present meaning and never stand in for supersession. |
| Activity/history | `server/services/activity.js` — `recordCrmActivity`, `commitCrmActivityMutation`, `listCrmActivity`, `projectCrmActivityTimeline` | Stored event ownership is not rewritten. |
| Follow-up | `server/services/followUpWorkspace.js`, `server/services/followUpEmail.js`, `server/services/followUpRecommendations.js` | Historical reads stay available; direct loser actions fail before durable side effects. |
| Communications | `server/services/communications.js` — `createManualCommunication`, `assignUnassignedCommunication` | No communication or outbox row is created for a loser. |
| Documents | `server/services/documentVault.js` — `createSecureUploadRequest`, `getSecureUploadContext`, `uploadSecureDocuments`, `revokeSecureUploadRequest`, `deleteSecureDocument` | Historical reads remain; new or destructive loser actions refuse. |
| Command Center | `server/services/acquisitionCommandCenter.js` — `getAcquisitionCommandCenter`, `updateAcquisitionCommandCenterRecord` | The list derives from active submissions; direct loser mutation refuses. |
| Deal Hunter | `server/services/dealHunter.js` — matching helpers, `findExistingDealHunterSubmission`, `linkDealHunterOpportunitySubmission`, `previewDealOsCrmReconciliation`, `executeDealOsCrmReconciliation`, `syncDealHunterHighFitsToCrm`, CIM execution/retry/send functions, `runCimStage2Automation`, `repairDealHunterCrmSourceFields`, `auditDealHunterCrmIntegrity` | PR #19 ambiguity/final-boundary behavior stays fail-closed; generic integrity audit is unchanged. |
| CIM final boundary | `server/services/cimAutomation.js` — `authorizeCimStage2SendBoundary` | Final authorization still requires current canonical primary and additionally rejects an active loser. |
| Broker/manual CIM | `server/services/dealHunterBrokerMaterials.js`, `server/services/dealHunterManualFollowUps.js` | Preparation, approval, claim, and send remain distinct stages; loser use refuses before the first state change. |
| Opportunity facts | `server/services/dealHunterOpportunityFacts.js` | Opportunity-owned source observations remain valid; direct loser field repair refuses. |
| HTTP | `server/app.js` — admin submission, activity, communication, document, follow-up, Command Center, reconciliation, sync, and CIM routes; `handleAppError` | Authentication stays unchanged. Only the two explicitly safe supersession errors gain typed public projections. |
| Admin UI | `src/pages/DashboardPage.jsx`, `src/components/admin/CrmNavigation.jsx`, `src/components/admin/DealActivityTimeline.jsx`, `src/components/admin/CrmCommunications.jsx`, `src/components/admin/FollowUpsWorkspace.jsx` | No bulk merge action. Existing `/admin/crm/:submissionId` deep links remain valid. |
| Repair pattern | `server/repairs/canonicalOpportunityMerge.js`, `server/services/canonicalOpportunityMergeRepair.js`, `scripts/repair-canonical-opportunity-merge.js`, `test/canonicalOpportunityMergeRepair.test.js` | Reuse canonical JSON, checksum, inventory, backup-verification, receipt, idempotency, and transaction patterns only—not canonical-merge business semantics. |
| Receipt table | `deal_hunter_cim_repair_manifests` DDL and accessors in both storage adapters | The schema has no CIM-only `CHECK` constraint, so a namespaced receipt fits. The current SQLite `upsertDealHunterCimRepairManifest` is intentionally mutable for existing modes, so consolidation receipts require mode-scoped UPDATE/DELETE refusal triggers in addition to direct incident insertion and exact replay/collision validation. |
| Authority tests | `test/dealHunterCrmMatchAuthorityBinding.test.js`, `test/dealHunterCrmMatchAmbiguity.test.js` | Preserve the 5,000-contact bound, typed incomplete result, exact-match ambiguity rules, and last-boundary transactional recheck. |

### Stable supersession interfaces used throughout this plan

Create `server/services/crmSubmissionSupersession.js` with these exports and use the same names in every task:

```text
export const CRM_SUBMISSION_SUPERSEDED = 'CRM_SUBMISSION_SUPERSEDED';
export const CRM_SUPERSESSION_UNAVAILABLE = 'CRM_SUPERSESSION_UNAVAILABLE';
CrmSubmissionSupersededError extends Error
CrmSupersessionUnavailableError extends Error
getCrmSubmissionSupersessionContext({ storage, submissionId }) -> Promise<CrmSubmissionSupersessionContext>
assertCrmSubmissionWritable({ storage, submissionId }) -> Promise<void>
projectCrmSupersessionHttpError(error) -> PublicHttpError | null
```

The storage adapters expose:

```js
getCrmSubmissionSupersessionContext(submissionId)
listActiveCrmSubmissionSupersessions({ submissionIds = [], opportunityIds = [], limit = 5000 })
assertCrmSubmissionWritable(submissionId)
auditCrmSubmissionSupersessions()
```

`getCrmSubmissionSupersessionContext` returns a bounded, privacy-safe shape:

```js
{
  requestedSubmissionId,
  canonicalSubmissionId,
  opportunityId,
  isSuperseded,
  relation,
  supersededSubmissions,
  historySubmissionIds
}
```

For a loser, `canonicalSubmissionId` is the survivor but `getDashboardSubmission` still returns the requested historical row. For a survivor, `historySubmissionIds` contains the survivor plus directly superseded rows. V1 forbids chains, so this is never recursive.

## Task 1: Supersession domain contract, SQLite schema, and provider capability

**Files:**

- Create: `server/services/crmSubmissionSupersession.js`
- Modify: `server/storage/sqlite.js`
- Modify: `server/storage/supabase.js`
- Create: `test/crmSubmissionSupersessionStorage.test.js`
- Create: `test/crmSubmissionSupersessionGuard.test.js`

### 1.1 Write the failing storage-contract tests

- [ ] In `test/crmSubmissionSupersessionStorage.test.js`, create a disposable SQLite database through the real `createSqliteStorage` adapter and seed two submissions, one active opportunity whose primary is the survivor, and an append-only applied receipt. Assert that a valid active relation can be inserted only through a test-only transaction fixture that executes the same SQL contract planned for the incident apply.
- [ ] Add separate test cases for: duplicate active loser; `loser === survivor`; missing survivor; missing loser; missing opportunity; inactive opportunity; opportunity primary not survivor; survivor conflicting direct/metadata owner; loser conflicting direct/metadata owner; loser primary elsewhere; active survivor already an active loser; active loser already an active survivor; attempted two-node cycle; attempted multi-node chain; receipt missing; receipt digest mismatch; mutation of immutable tuple/approval/repair fields; physical relation delete; contact delete; opportunity delete; receipt delete; and direct assignment of an active loser as an opportunity primary.
- [ ] Add receipt-immutability cases using the real SQLite adapter: insert one `mode = 'crm-duplicate-consolidation'` receipt; read it back and use it to satisfy a valid supersession relation; call `upsertDealHunterCimRepairManifest` with the same ID but changed `status`, `checksum`, and `manifest` and require rejection with the original row byte-identical; issue direct SQL `UPDATE` and `DELETE` statements for that receipt and require both to fail; then prove the same generic upsert and existing lifecycle behavior remain unchanged for a non-consolidation repair-manifest fixture.
- [ ] Add upgrade coverage that first creates a pre-supersession database through a fixture matching the current startup schema, reopens it with `createSqliteStorage`, and asserts the new table, indexes, triggers, and existing rows are intact.
- [ ] In `test/crmSubmissionSupersessionGuard.test.js`, assert the SQLite methods return the stable context shape, `auditCrmSubmissionSupersessions()` reports zero violations for a valid relation, and each Supabase method throws `CRM_SUPERSESSION_UNAVAILABLE` without invoking the Supabase client.
- [ ] Run:

  ```bash
  node --test test/crmSubmissionSupersessionStorage.test.js test/crmSubmissionSupersessionGuard.test.js
  ```

  Expected RED: imports or methods are missing, the supersession table does not exist, and the current generic manifest upsert can rewrite a consolidation-mode receipt. No test may pass by bypassing `createSqliteStorage`.

### 1.2 Implement the smallest durable schema and domain contract

- [ ] Add the approved table columns and checks verbatim to the idempotent startup DDL in `server/storage/sqlite.js`, after `deal_hunter_cim_repair_manifests` is defined. Add `idx_crm_submission_supersessions_survivor`, `idx_crm_submission_supersessions_opportunity`, and partial unique `uq_crm_submission_supersessions_active_loser`.
- [ ] Add `trg_crm_duplicate_consolidation_receipt_no_update` and `trg_crm_duplicate_consolidation_receipt_no_delete` on `deal_hunter_cim_repair_manifests`. Each trigger fires only when `OLD.mode = 'crm-duplicate-consolidation'` and aborts every UPDATE or DELETE, regardless of whether it comes from `upsertDealHunterCimRepairManifest`, direct SQL, or a future storage caller. Do not change update/delete semantics for any other manifest mode.
- [ ] Add triggers with explicit names and one responsibility each:
  - `trg_crm_submission_supersessions_validate_insert`: require an applied `crm-duplicate-consolidation` receipt with the same manifest ID/digest, validate existing rows, active opportunity, canonical primary, compatible direct-or-metadata owners, and loser-not-primary.
  - `trg_crm_submission_supersessions_no_active_chain_insert` and `trg_crm_submission_supersessions_no_active_chain_update`: reject either endpoint participating in the opposite active role. Because all active paths are length one, this prevents chains and cycles rather than merely detecting a two-row cycle.
  - `trg_crm_submission_supersessions_immutable_update`: forbid changes to ID, tuple, creation, approval, reason, original repair, digest, and metadata fields.
  - `trg_crm_submission_supersessions_reverse_only`: allow only `active -> reversed`, require reversal time/actor/reason/manifest, and require a matching applied reverse receipt; reject `reversed -> active` and repeated reversal.
  - `trg_crm_submission_supersessions_no_delete`: forbid physical deletion.
  - `trg_crm_submission_supersessions_guard_contact_owner_update`: prevent direct or metadata owner changes that invalidate an active tuple.
  - `trg_crm_submission_supersessions_guard_opportunity_update`: prevent deactivation, primary change, or ID change that invalidates an active tuple.
  - `trg_deal_hunter_opportunities_reject_superseded_primary_insert` and `trg_deal_hunter_opportunities_reject_superseded_primary_update`: reject an active loser as primary.
- [ ] Keep the `ON DELETE RESTRICT` foreign keys to both contacts, opportunity, apply receipt, and reversal receipt. Do not add cascade behavior.
- [ ] In `crmSubmissionSupersession.js`, implement typed errors with safe fields `code`, `status`, `submissionId`, `survivorSubmissionId`, and `opportunityId`. `CrmSubmissionSupersededError` is 409; `CrmSupersessionUnavailableError` is 503.
- [ ] In SQLite, implement the four stable methods with deterministic `ORDER BY`, parsed metadata ownership, and bounds. `assertCrmSubmissionWritable` executes inside the caller's active transaction when called from a transactional storage method.
- [ ] In Supabase, make all four methods throw `CrmSupersessionUnavailableError` before issuing a provider query. Do not add table or RPC assumptions.

### 1.3 Prove GREEN and protect neighboring storage behavior

- [ ] Run the focused command and require all cases green:

  ```bash
  node --test test/crmSubmissionSupersessionStorage.test.js test/crmSubmissionSupersessionGuard.test.js
  ```

- [ ] Run neighboring storage/schema suites:

  ```bash
  node --test test/sqliteAuthMigration.test.js test/contactSubmission.test.js test/canonicalOpportunityCurrentSemantics.test.js test/supabaseSecurity.test.js
  ```

- [ ] Run `git diff --check`, review only the five files named above, and verify no business-data seed escaped a disposable database.
- [ ] Inspect the DDL and tests together: the first consolidation receipt INSERT must succeed, every later UPDATE/DELETE of that row must fail, a supersession FK/read must still succeed, and at least one non-consolidation manifest update must retain its existing behavior.
- [ ] Commit:

  ```bash
  git add server/services/crmSubmissionSupersession.js server/storage/sqlite.js server/storage/supabase.js test/crmSubmissionSupersessionStorage.test.js test/crmSubmissionSupersessionGuard.test.js
  git commit -m "feat: add durable CRM submission supersession contract"
  ```

## Task 2: Central loser-write refusal and core lifecycle paths

**Files:**

- Modify: `server/services/crmSubmissionSupersession.js`
- Modify: `server/storage/sqlite.js`
- Modify: `server/services/submissions.js`
- Modify: `server/services/leadLifecycle.js`
- Modify: `server/app.js`
- Modify: `test/crmSubmissionSupersessionGuard.test.js`
- Modify: `test/submissions.test.js`
- Modify: `test/leadLifecycle.test.js`
- Modify: `test/dealHunterAtomicPass.test.js`
- Modify: `test/httpApp.test.js`

### 2.1 Write failing core-writer tests

- [ ] Add real-SQLite tests that create one active supersession and call `updateSubmissionWorkflow`, `archiveLead`, `restoreLead`, `deleteDashboardSubmission`, and `storage.passDealHunterOpportunity` with the loser. Each must reject with `CRM_SUBMISSION_SUPERSEDED` and return survivor/opportunity references; compare before/after raw hashes for both contacts, dispositions, activity, cleanup jobs, and opportunity primary.
- [ ] Add direct adapter tests proving `updateSubmission`, `updateSubmissionIfCurrent`, `deleteSubmission`, and the submission-mutating arms of `mutateWithCrmActivityTransaction` cannot bypass the guard even when called without an HTTP route.
- [ ] In `test/httpApp.test.js`, authenticate through the normal test app and prove PATCH, archive, restore, Pass, and DELETE return 409 with this exact public shape and no internal message or stack:

  ```json
  {
    "success": false,
    "code": "CRM_SUBMISSION_SUPERSEDED",
    "error": "This CRM record is historical and cannot be changed.",
    "submissionId": "loser-id",
    "survivorSubmissionId": "survivor-id",
    "opportunityId": "opportunity-id"
  }
  ```

- [ ] Prove a Supabase-backed request returns 503 `CRM_SUPERSESSION_UNAVAILABLE` and performs no mutation call. Prove unrelated 4xx/5xx errors retain the current generic `handleAppError` response.
- [ ] Run:

  ```bash
  node --test test/crmSubmissionSupersessionGuard.test.js test/submissions.test.js test/leadLifecycle.test.js test/dealHunterAtomicPass.test.js test/httpApp.test.js
  ```

  Expected RED: existing services/storage mutate or attempt to mutate the loser, and the HTTP handler hides the domain code.

### 2.2 Put one reusable authority check at the write boundary

- [ ] Implement `assertCrmSubmissionWritable({ storage, submissionId })` as a thin call to the provider method; it must not redirect to the survivor and must not infer authority from frontend state.
- [ ] Call the central guard at the start of `updateSubmissionWorkflow`, `archiveLead`, `restoreLead`, and `deleteDashboardSubmission`. Preserve existing not-found and optimistic-concurrency behavior after the supersession check.
- [ ] In `server/storage/sqlite.js`, invoke the same internal SQL assertion within every transaction that mutates or deletes a contact row. This storage-layer check closes direct-adapter and lookup-to-write races; service checks remain useful for early, typed refusal.
- [ ] In `passDealHunterOpportunity`, check both the explicitly linked/primary submission and any submission the transaction would archive before writing the disposition or opportunity.
- [ ] Implement `projectCrmSupersessionHttpError(error)` as a strict allowlist for exactly the two typed errors. In `handleAppError`, call it before the generic projection. Do not expose arbitrary `error.message`, metadata, SQL, or unknown codes.

### 2.3 Prove GREEN, regress lifecycle behavior, and commit

- [ ] Run the focused command from 2.1 and require all before/after hashes unchanged for refusals.
- [ ] Run:

  ```bash
  node --test test/submissionConcurrency.test.js test/documentVault.test.js test/cimCommunicationLifecycle.test.js test/http.test.js test/app.test.js
  ```

- [ ] Run `git diff --check`; review that all write authority flows through the stable guard and no route contains its own SQL supersession test.
- [ ] Commit:

  ```bash
  git add server/services/crmSubmissionSupersession.js server/storage/sqlite.js server/services/submissions.js server/services/leadLifecycle.js server/app.js test/crmSubmissionSupersessionGuard.test.js test/submissions.test.js test/leadLifecycle.test.js test/dealHunterAtomicPass.test.js test/httpApp.test.js
  git commit -m "feat: refuse core CRM writes to superseded records"
  ```

## Task 3: Supersession-aware active CRM projections

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/services/submissions.js`
- Modify: `server/services/acquisitionCommandCenter.js`
- Create: `test/crmSubmissionSupersessionProjection.test.js`
- Modify: `test/submissions.test.js`
- Modify: `test/acquisitionCommandCenter.test.js`
- Modify: `test/followUpStorage.test.js`
- Modify: `test/pagination.test.js`

### 3.1 Write failing active-projection tests

- [ ] Seed a survivor/loser relation where both contacts otherwise satisfy list, search, overdue, and Command Center filters. Assert `listDashboardSubmissions`, text search, pagination totals, `listDashboardFollowUps`, `getSummary`, and `getAcquisitionCommandCenter` return the survivor exactly once and never the loser.
- [ ] Add controls proving an unsuperseded historical-looking row remains visible and `getSubmissionStrict(loserId)` remains directly readable.
- [ ] Add a boundary case with a reversed relation: the former loser returns to active projections only after a separately seeded valid reversal receipt and legal `active -> reversed` transition.
- [ ] Run:

  ```bash
  node --test test/crmSubmissionSupersessionProjection.test.js test/submissions.test.js test/acquisitionCommandCenter.test.js test/followUpStorage.test.js test/pagination.test.js
  ```

  Expected RED: active lists, totals, and queues still include both rows.

### 3.2 Centralize the active-row SQL predicate

- [ ] Add one internal SQLite helper that emits an alias-qualified predicate equivalent to:

  ```sql
  NOT EXISTS (
    SELECT 1
    FROM crm_submission_supersessions AS active_supersession
    WHERE active_supersession.superseded_submission_id = submissions.id
      AND active_supersession.status = 'active'
  )
  ```

  The helper accepts only known internal aliases; it never accepts request input.
- [ ] Apply the helper in `listSubmissions`, its count query, `listFollowUpSubmissions`, and `getSummary`. Preserve every existing lifecycle filter, sort, cursor, and pagination bound.
- [ ] Keep `getSubmission`/`getSubmissionStrict` unfiltered for historical deep links. `getAcquisitionCommandCenter` needs no parallel filter once it consumes the corrected `listSubmissions`, but add an assertion/test documenting that dependency.
- [ ] Do not describe the list and count queries as a single SQL snapshot. They are separate statements and must both carry the same active predicate.

### 3.3 Prove GREEN and commit

- [ ] Run the focused command from 3.1.
- [ ] Run:

  ```bash
  node --test test/contactSubmission.test.js test/submissionConcurrency.test.js test/followUpRecommendations.test.js test/dealHunterTriage.test.js
  ```

- [ ] Review query plans in the projection test with `EXPLAIN QUERY PLAN` and require use of `uq_crm_submission_supersessions_active_loser` or an equivalent indexed lookup for the anti-join.
- [ ] Run `git diff --check`, then commit:

  ```bash
  git add server/storage/sqlite.js server/services/submissions.js server/services/acquisitionCommandCenter.js test/crmSubmissionSupersessionProjection.test.js test/submissions.test.js test/acquisitionCommandCenter.test.js test/followUpStorage.test.js test/pagination.test.js
  git commit -m "feat: exclude superseded CRM records from active projections"
  ```

## Task 4: Historical detail and provenance-preserving read-through

**Files:**

- Modify: `server/services/submissions.js`
- Modify: `server/services/activity.js`
- Modify: `server/services/communications.js`
- Modify: `server/services/documentVault.js`
- Modify: `server/app.js`
- Modify: `src/pages/DashboardPage.jsx`
- Modify: `src/components/admin/DealActivityTimeline.jsx`
- Modify: `src/components/admin/CrmCommunications.jsx`
- Create: `test/crmSubmissionSupersessionReadThrough.test.js`
- Modify: `test/activityTimelineProjection.test.js`
- Modify: `test/crmCommunications.test.js`
- Modify: `test/documentVault.test.js`
- Modify: `test-ui/CrmRecordCard.test.jsx`
- Modify: `test-ui/DealActivityTimeline.test.jsx`
- Modify: `test-ui/CrmCommunications.test.jsx`

### 4.1 Write failing read-through and UI tests

- [ ] Create pair fixtures with distinct notes, activity events, legacy email events, communications, closed upload requests, and documents on survivor and loser. Assert a loser detail request returns the loser's unchanged row plus `supersession` containing survivor/opportunity/reason/approval/repair references and a safe survivor URL.
- [ ] Assert a survivor detail/timeline/read-only communication/document request unions the direct pair's histories, orders them by the existing timestamp/tie-break rules, and attaches `originSubmissionId` to every projected item. Compare stored rows before/after to prove no `submission_id` changes.
- [ ] Assert the loser deep link still returns 200 and the survivor link is `/admin/crm/<survivor-id>`; no mutation control is enabled on the loser card.
- [ ] In UI tests, require a superseded banner, survivor link, and provenance label only when an item originated on a different submission. Preserve existing rendering for ordinary records.
- [ ] Run:

  ```bash
  node --test test/crmSubmissionSupersessionReadThrough.test.js test/activityTimelineProjection.test.js test/crmCommunications.test.js test/documentVault.test.js
  npx vitest run test-ui/CrmRecordCard.test.jsx test-ui/DealActivityTimeline.test.jsx test-ui/CrmCommunications.test.jsx
  ```

  Expected RED: detail responses have no supersession shape and history endpoints read only one submission ID.

### 4.2 Implement bounded read-through without reparenting

- [ ] Extend `getDashboardSubmission` to call `getCrmSubmissionSupersessionContext`; retain the requested row as `submission` and attach the context separately.
- [ ] Extend `listCrmActivity`/`projectCrmActivityTimeline`, communication reads, and document/upload reads to accept the context's bounded `historySubmissionIds`. Add `originSubmissionId` from the stored foreign key before projection; never overwrite the projected canonical/display submission ID silently.
- [ ] Keep all create/update/delete methods on one explicit submission and subject to Task 2/6 guards. Read-through IDs are never reused as a write fan-out.
- [ ] Add the banner/link in `CrmRecordCard` within `DashboardPage.jsx`, and provenance labels in `DealActivityTimeline` and `CrmCommunications`. Do not add a merge, reverse, clean-up, resend, or bulk-action control.

### 4.3 Prove GREEN and commit

- [ ] Run both focused commands from 4.1.
- [ ] Run:

  ```bash
  node --test test/activity.test.js test/emailCommunicationLifecycle.test.js test/httpApp.test.js
  npx vitest run test-ui/DashboardCommunicationsIntegration.test.jsx test-ui/FollowUpsWorkspace.test.jsx
  ```

- [ ] Review raw fixture hashes to ensure histories stayed on original IDs; run `git diff --check`.
- [ ] Commit:

  ```bash
  git add server/services/submissions.js server/services/activity.js server/services/communications.js server/services/documentVault.js server/app.js src/pages/DashboardPage.jsx src/components/admin/DealActivityTimeline.jsx src/components/admin/CrmCommunications.jsx test/crmSubmissionSupersessionReadThrough.test.js test/activityTimelineProjection.test.js test/crmCommunications.test.js test/documentVault.test.js test-ui/CrmRecordCard.test.jsx test-ui/DealActivityTimeline.test.jsx test-ui/CrmCommunications.test.jsx
  git commit -m "feat: read superseded CRM history through its survivor"
  ```

## Task 5: CRM match-authority v2 and transactional final-link binding

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/storage/supabase.js`
- Modify: `server/services/dealHunter.js`
- Modify: `test/dealHunterCrmMatchAuthorityBinding.test.js`
- Modify: `test/dealHunterCrmMatchAmbiguity.test.js`
- Modify: `test/dealHunterDeduplication.test.js`

### 5.1 Write failing v2 authority and candidate tests

- [ ] In `test/dealHunterCrmMatchAuthorityBinding.test.js`, retain every PR #19 final-boundary test and add cases that insert or legally reverse a supersession after the last service lookup but before `linkDealHunterCrmSubmissionIfAuthorityCurrent`. Instrument the real SQLite adapter at the same lookup-to-link boundary used by current tests. Assert `CRM_MATCH_AUTHORITY_CHANGED`, no contact link, no opportunity-primary change, no CRM import change, and no CIM/outbox/provider side effect.
- [ ] Assert the authority response version is `deal-hunter-crm-match-authority-v2`, includes `submissionCount`, `supersessionCount`, the complete ordered active relation projection, and a revision that changes when any active tuple/approval/digest changes or a relation is reversed.
- [ ] Prove the existing contact bound remains exactly 5,000 and add an independent 5,000-active-supersession bound. A 5,001st row in either complete set must return the existing fail-closed incomplete classification; it must not truncate and hash a prefix.
- [ ] In `test/dealHunterCrmMatchAmbiguity.test.js`, add cases where exact evidence names a loser, two evidence paths name loser and survivor, and multiple losers could canonicalize to the same survivor. The selected candidate must be the survivor once, with evidence origins retained; deduplication happens after canonicalization. Two different final survivors remain ambiguous.
- [ ] Add an adversarial storage call selecting a loser directly. The final immediate transaction must reject it even when the supplied v2 revision was current when read.
- [ ] Retain a successful unchanged-state control that links the survivor through the real adapter.
- [ ] Run:

  ```bash
  node --test test/dealHunterCrmMatchAuthorityBinding.test.js test/dealHunterCrmMatchAmbiguity.test.js test/dealHunterDeduplication.test.js
  ```

  Expected RED: the current authority is v1/contact-only, candidates do not resolve through supersession, and final link does not reject an active loser.

### 5.2 Implement the combined authority and canonicalization contract

- [ ] In `server/storage/sqlite.js`, replace the v1 payload with a deterministic v2 payload containing every column of every `contact_submissions` row sorted by ID and every column of every active `crm_submission_supersessions` row sorted by ID. Continue reading inside one deferred SQLite transaction; describe this as one SQLite read transaction, not as one SQL statement.
- [ ] Keep `dealHunterCrmMatchAuthoritySnapshot` deterministic and private. Return only the bounded public result needed by the service while hashing the full raw values internally.
- [ ] In `dealHunter.js`, build a loser-to-survivor map from the authority snapshot. Update `listCompleteDealHunterCrmCandidates`, `dealHunterCrmMatchResult`, `selectedDealHunterCrmSubmission`, `assertDealHunterCrmMatchStable`, and `validatedCachedDealHunterCrmSubmission` so evidence is evaluated against its origin row, then the candidate ID is canonicalized, then candidates are deduplicated by final survivor ID, then uniqueness is decided.
- [ ] Do not collapse Pooler and Berlin or any two distinct final survivor IDs. Do not use transitive closure; active chains are invalid schema state.
- [ ] In `linkDealHunterCrmSubmissionIfAuthorityCurrent`, retain `BEGIN IMMEDIATE`, recompute v2 inside that transaction, compare the expected revision, reject an active loser, recheck lifecycle/ownership/primary/competing-link conditions on the survivor, and only then link.
- [ ] Keep Supabase fail-closed. Its v2 read/link entry points return `CRM_MATCH_LOOKUP_INCOMPLETE` caused by `CRM_SUPERSESSION_UNAVAILABLE` before attempting a partial contact-only decision.

### 5.3 Prove GREEN and preserve PR #19 behavior

- [ ] Run the focused command from 5.1 and inspect every existing PR #19 test result, not only the new test names.
- [ ] Run:

  ```bash
  node --test test/dealOsImport.test.js test/dealHunterCrmReconciliation.test.js test/dealHunterBulkCim.test.js test/cimOpportunityIdentity.test.js
  ```

- [ ] Run `git diff --check`; inspect the revision serializer to ensure no locale-dependent sort, timestamps, filesystem paths, or truncated rows enter the hash.
- [ ] Commit:

  ```bash
  git add server/storage/sqlite.js server/storage/supabase.js server/services/dealHunter.js test/dealHunterCrmMatchAuthorityBinding.test.js test/dealHunterCrmMatchAmbiguity.test.js test/dealHunterDeduplication.test.js
  git commit -m "feat: bind CRM match authority to supersession state"
  ```

## Task 6: Remaining business-writer safety

**Files:**

- Modify: `server/storage/sqlite.js`
- Modify: `server/services/activity.js`
- Modify: `server/services/followUpWorkspace.js`
- Modify: `server/services/followUpEmail.js`
- Modify: `server/services/followUpRecommendations.js`
- Modify: `server/services/communications.js`
- Modify: `server/services/documentVault.js`
- Modify: `server/services/acquisitionCommandCenter.js`
- Modify: `server/services/dealHunterBrokerMaterials.js`
- Modify: `server/services/dealHunterManualFollowUps.js`
- Modify: `server/services/dealHunterOpportunityFacts.js`
- Modify: `server/services/cimAutomation.js`
- Modify: `server/services/dealHunter.js`
- Create: `test/crmSubmissionSupersessionWriters.test.js`
- Modify: `test/followUpEmail.test.js`
- Modify: `test/followUpRecommendations.test.js`
- Modify: `test/crmCommunications.test.js`
- Modify: `test/documentVault.test.js`
- Modify: `test/acquisitionCommandCenter.test.js`
- Modify: `test/dealHunterBrokerMaterials.test.js`
- Modify: `test/dealHunterManualFollowUps.test.js`
- Modify: `test/dealHunterCrmReconciliation.test.js`
- Modify: `test/dealHunterBulkCim.test.js`
- Modify: `test/dealHunterOpportunityFacts.test.js`
- Modify: `test/cimAutomation.test.js`

### 6.1 Write a refusal matrix before changing writers

- [ ] Build `test/crmSubmissionSupersessionWriters.test.js` around the real SQLite adapter and one active relation. Invoke each supported path with the loser: `recordCrmActivity`; follow-up dismiss/preview/send/outbox processing; recommendation generation; manual communication and assignment; secure upload request/token/finalization/revocation/document deletion; Command Center update; broker-material prepare/approve; manual CIM follow-up prepare/approve/start/stop; corrected-recipient retry; explicit CIM request execution/send; reconciliation preview/apply; high-fit sync with a cached loser claim; direct source-field repair; and Stage 2 final authorization.
- [ ] For every case, snapshot and compare the relevant tables. Require no contact, activity, communication, outbox, email, recommendation, upload, document, CIM request/claim, reconciliation, import, disposition, source, opportunity, alias, or job mutation. Stub the provider with a call counter and require zero calls.
- [ ] Add enumeration controls proving recommendations, follow-up queues, broker/CIM candidates, reconciliation candidates, sync candidates, and Stage 2 candidates omit losers while leaving survivors eligible under their existing rules.
- [ ] Add one valid survivor control per subsystem so refusal is not implemented by disabling the feature.
- [ ] Run:

  ```bash
  node --test test/crmSubmissionSupersessionWriters.test.js
  ```

  Expected RED: at least one downstream path reaches a durable write or provider boundary without the central assertion.

### 6.2 Apply the central guard at each authority boundary

- [ ] Call `assertCrmSubmissionWritable` before the first mutation/claim/provider effect in each service named above. Do not silently replace the loser ID with the survivor for business writes.
- [ ] Put equivalent checks inside the relevant `mutateWithCrmActivityTransaction`, outbox/claim, CIM claim, upload finalization, and reconciliation apply transactions so service lookup-to-write races fail atomically.
- [ ] Let read-only preview/search paths resolve loser evidence to the survivor only where the approved table says canonicalization is allowed. Explicit commands carrying a loser ID refuse.
- [ ] In `authorizeCimStage2SendBoundary`, verify the current primary is not an active loser in the same final authorization transaction/snapshot used by the existing send guard.
- [ ] In `repairDealHunterCrmSourceFields`, allow opportunity-owned fact work to continue, but reject any direct contact update whose target is a loser. Do not alter source observations.
- [ ] Preserve all existing state-machine errors and idempotency. Supersession refusal precedes creation/claim/send but does not reinterpret terminal historical state.

### 6.3 Prove GREEN subsystem by subsystem

- [ ] Run the matrix and focused neighboring suites:

  ```bash
  node --test test/crmSubmissionSupersessionWriters.test.js test/followUpEmail.test.js test/followUpRecommendations.test.js test/crmCommunications.test.js test/documentVault.test.js
  node --test test/acquisitionCommandCenter.test.js test/dealHunterBrokerMaterials.test.js test/dealHunterManualFollowUps.test.js test/dealHunterCrmReconciliation.test.js
  node --test test/dealHunterBulkCim.test.js test/dealHunterOpportunityFacts.test.js test/cimAutomation.test.js test/cimStage2Compliance.test.js test/cimStage2Storage.test.js
  ```

- [ ] Search all storage/service references to `submission_id`, `submissionId`, `primary_submission_id`, outbox creation, CIM claims, and provider sends. For every business writer, document in the test matrix which central service and transactional guard covers it.
- [ ] Run `git diff --check`; verify no generic audit logic changed and no send path redirects a loser.
- [ ] Commit:

  ```bash
  git add server/storage/sqlite.js server/services/activity.js server/services/followUpWorkspace.js server/services/followUpEmail.js server/services/followUpRecommendations.js server/services/communications.js server/services/documentVault.js server/services/acquisitionCommandCenter.js server/services/dealHunterBrokerMaterials.js server/services/dealHunterManualFollowUps.js server/services/dealHunterOpportunityFacts.js server/services/cimAutomation.js server/services/dealHunter.js test/crmSubmissionSupersessionWriters.test.js test/followUpEmail.test.js test/followUpRecommendations.test.js test/crmCommunications.test.js test/documentVault.test.js test/acquisitionCommandCenter.test.js test/dealHunterBrokerMaterials.test.js test/dealHunterManualFollowUps.test.js test/dealHunterCrmReconciliation.test.js test/dealHunterBulkCim.test.js test/dealHunterOpportunityFacts.test.js test/cimAutomation.test.js
  git commit -m "feat: enforce supersession across CRM business writers"
  ```

## Task 7: Read-only CRM duplicate-review projection

**Files:**

- Create: `server/services/crmDuplicateReview.js`
- Modify: `server/app.js`
- Create: `src/components/admin/CrmDuplicateReview.jsx`
- Modify: `src/pages/DashboardPage.jsx`
- Create: `test/crmDuplicateReview.test.js`
- Create: `test-ui/CrmDuplicateReview.test.jsx`
- Modify: `test/httpApp.test.js`

### 7.1 Write failing pair-classification tests

- [ ] Define and test a normalized pair key `(lowerSubmissionId, higherSubmissionId)` and the exact categories `resolved/superseded`, `confirmed-duplicate`, `strong-candidate`, `uncertain`, and `keep-distinct`.
- [ ] Test both approved relations as `resolved/superseded` after apply-state fixtures and as `confirmed-duplicate` from the checked-in incident descriptor before apply. Prove Pooler and Berlin never form a pair with each other and no transitive group is emitted.
- [ ] Add representative `strong-candidate` exact stable-listing evidence, `uncertain` conflicting/insufficient evidence, and an in-code owner-reviewed `keep-distinct` rule required to prevent the known Pooler/Berlin cross-pair. Include evidence hashes/categories and blockers, never contact text, email bodies, note text, document paths, or raw metadata.
- [ ] Add bounds: more than 5,000 submissions or more than 10,000 normalized candidate pairs fails closed with a typed incomplete report; no prefix result is presented as complete.
- [ ] Test authenticated `GET /api/admin/crm-duplicates` and the minimal component. Require category sections, evidence labels, resolved survivor links, and no merge/reverse/apply/bulk action.
- [ ] Run:

  ```bash
  node --test test/crmDuplicateReview.test.js test/httpApp.test.js
  npx vitest run test-ui/CrmDuplicateReview.test.jsx
  ```

  Expected RED: the service, route, and component do not exist.

### 7.2 Implement one bounded read projection

- [ ] Export `buildCrmDuplicateReview({ submissions, supersessions, approvedPairs, keepDistinctPairs })` and `getCrmDuplicateReview({ storage })` from `crmDuplicateReview.js`. Candidate generation uses stable identity tokens already produced by Deal Hunter matching helpers; it does not invent financial equivalence or relabel `Annual Profit`.
- [ ] Classify each normalized pair independently. Never compute connected components, transitive closure, or automatic survivor selection for unapproved candidates.
- [ ] Derive `resolved/superseded` only from durable active relations. The two approved tuples may be `confirmed-duplicate` from the immutable descriptor before relations exist. V1 does not add a decision table.
- [ ] Add authenticated read-only `GET /api/admin/crm-duplicates`. Render `CrmDuplicateReview` within the existing CRM section in `DashboardPage.jsx`; provide only navigation to existing detail pages.
- [ ] Keep `auditDealHunterCrmIntegrity` untouched. This report neither changes `safeToReconcile` nor writes owner decisions.

### 7.3 Prove GREEN and commit

- [ ] Run both focused commands from 7.1.
- [ ] Run:

  ```bash
  node --test test/dealHunterCrmIntegrityAudit.test.js test/dealHunterCrmMatchAmbiguity.test.js
  npx vitest run test-ui/CrmNavigation.test.jsx test-ui/CrmRecordCard.test.jsx
  ```

- [ ] Run `git diff --check`; verify the route is GET-only and the component contains no mutation handler.
- [ ] Commit:

  ```bash
  git add server/services/crmDuplicateReview.js server/app.js src/components/admin/CrmDuplicateReview.jsx src/pages/DashboardPage.jsx test/crmDuplicateReview.test.js test-ui/CrmDuplicateReview.test.jsx test/httpApp.test.js
  git commit -m "feat: add read-only CRM duplicate review"
  ```

## Task 8: Incident-bounded preview/apply repair

**Files:**

- Create: `server/repairs/crmDuplicateConsolidation.js`
- Create: `server/services/crmDuplicateConsolidationRepair.js`
- Modify: `server/storage/sqlite.js`
- Create: `test/crmDuplicateConsolidationRepair.test.js`
- Create: `test/crmDuplicateConsolidationRepairSafety.test.js`
- Create: `test/fixtures/crmDuplicateConsolidationReferenceSchema.sql`

### 8.1 Write failing descriptor, preview, apply, and safety tests

- [ ] In `crmDuplicateConsolidationRepair.test.js`, assert the descriptor exports exactly:
  - repair version `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`;
  - type `crm-duplicate-consolidation`;
  - approval/plan/manifest schemas from the spec;
  - exact confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`;
  - Pooler tuple `opp_683681c2-bd49-4c46-be4f-6d969143d907`, survivor `daa9ea12-786f-4769-b702-d9309525c455`, loser `b36a4b33-d35c-4e8d-b6c3-b6301030a92b`, listing `costar:2516010`;
  - Berlin tuple `opp_9b18427d-5fb5-4f92-be31-d92b810061b3`, survivor `0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da`, loser `8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3`, listing `costar:2436873`;
  - Berlin import `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8` moving loser to survivor while `opportunity_id` remains `NULL`.
- [ ] Prove runtime IDs cannot add, remove, swap, or cross the two tuples. Pooler and Berlin remain distinct under every descriptor permutation test.
- [ ] Test preview on a disposable production-shaped database opened `readonly: true`, `fileMustExist: true`, with `PRAGMA query_only = ON`. Require one consistent SQLite read transaction, exact schema/reference inventory, privacy-safe values, all-column raw row hashes, recovery/safety inputs, deterministic canonical plan, and stable lowercase SHA-256. Compare the entire database logical digest before/after.
- [ ] Using `crmDuplicateConsolidationReferenceSchema.sql`, add an unknown relationship-like column/table reference and require a blocker. Add blockers for changed tuple/primary/owner/listing/financial label/value, unclassified reference, active writer, unsafe outbound control, nonterminal loser communication/outbox/CIM/recommendation/upload/reconciliation/cleanup state, and any raw-row drift.
- [ ] Test apply argument refusal for missing/wrong apply flag, artifact, manifest ID, checksum, tuple, database/schema/raw digest, backup path/manifest/SHA, Fly release, tooling SHA, actor, reason, or confirmation.
- [ ] Test exact apply in the real SQLite adapter. Instrument update counts and logical digests: exactly two supersession INSERTs, one CAS update to the Berlin import, and one direct append-only receipt INSERT commit together. Require zero mutations to every prohibited table listed under “Business-data mutation ledger” below.
- [ ] Inject failure after each of the four writes and during postconditions; every case must roll back all four. Test stale Berlin CAS and receipt collision separately.
- [ ] Test exact replay byte-validates the existing consolidation receipt and returns `verified-prior-apply` with zero writes and without calling `upsertDealHunterCimRepairManifest`, issuing receipt UPDATE SQL, or changing any receipt field; satisfied state without the exact receipt, partial state, or conflicting receipt refuses.
- [ ] After first apply, attempt to rewrite the receipt through `upsertDealHunterCimRepairManifest` with changed status/checksum/manifest and through direct SQL UPDATE/DELETE. Require storage-level rejection and byte-identical receipt state. Repeat the same generic upsert lifecycle with a non-consolidation manifest and require its existing mutable semantics to remain unchanged.
- [ ] Model logical reversal with a distinct receipt ID/row whose protected mode remains `crm-duplicate-consolidation` and whose separately versioned manifest identifies the reverse operation. Assert reversal references that new append-only receipt and never updates, repurposes, or deletes the original apply receipt.
- [ ] Test separate supersession audit, generic CRM audit unchanged and clean, `PRAGMA quick_check = ok`, and zero foreign-key violations.
- [ ] Run:

  ```bash
  node --test test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js
  ```

  Expected RED: descriptor, preview service, inspection methods, and apply transaction do not exist.

### 8.2 Implement deterministic preview and one atomic apply

- [ ] In `server/repairs/crmDuplicateConsolidation.js`, export the immutable descriptor, canonical JSON serializer, digest helpers, pair/reference classifiers, expected mutation ledger, and manifest validator. Accept operator facts (actor, reason, release, tooling, checkpoint) only as reviewed inputs; never accept substitute pair IDs.
- [ ] In `crmDuplicateConsolidationRepair.js`, export:

  ```js
  previewCrmDuplicateConsolidation({ storage, actor, reason, executionRelease, toolingRevision, recoveryCheckpoint })
  verifyCrmDuplicateConsolidationReviewedArtifact({ artifact, expectedPlanChecksum, expectedManifestId })
  applyCrmDuplicateConsolidation({ storage, reviewedArtifact, expectedPlanChecksum, expectedManifestId, backup, actor, reason, executionRelease, toolingRevision, confirmation })
  ```

- [ ] Add SQLite `inspectCrmDuplicateConsolidation`, `verifyCrmDuplicateConsolidationBackupPlan`, and `applyCrmDuplicateConsolidation`. Inspection discovers all direct and embedded references, classifies each, fingerprints every protected raw row, and records unknown relationship-like schema as a blocker.
- [ ] `applyCrmDuplicateConsolidation` begins `BEGIN IMMEDIATE`, recomputes the complete plan, compares canonical manifest bytes/checksum, validates safety/backup/current rows, directly inserts the receipt exactly once, inserts the two relations, CAS-updates only the Berlin import, runs postconditions, and commits once. Receipt insertion precedes relation insertion because the relation FK requires it; any later error rolls it back. After commit, the Task 1 mode-scoped triggers make that consolidation receipt database-level append-only by refusing UPDATE and DELETE from every caller.
- [ ] Do not call mutable `upsertDealHunterCimRepairManifest`. On replay, read and byte-validate every stored field of the exact receipt, return `verified-prior-apply`, and perform zero writes. A collision or byte difference refuses. The combination of direct INSERT plus exact replay validation in this incident path and SQLite UPDATE/DELETE refusal for `mode = 'crm-duplicate-consolidation'` enforces append-only behavior.
- [ ] Preserve Berlin `opportunity_id = NULL`, record bounded prior-owner provenance in the approved receipt/import metadata, and CAS the exact prior raw digest and submission ID. Do not touch either Pooler import.
- [ ] Return only `repair-required`, `verified-prior-apply`, or typed refusal states defined by the service. Do not auto-retry an ambiguous apply result.

### 8.3 Business-data mutation ledger

The first valid apply must report exactly four changed rows:

1. Pooler `crm_submission_supersessions` insert.
2. Berlin `crm_submission_supersessions` insert.
3. Berlin `deal_hunter_crm_imports` update for `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8`.
4. One `deal_hunter_cim_repair_manifests` receipt insert.

Tests must require zero row or raw-hash changes in `contact_submissions`, `crm_activity_events`, `email_events`, `crm_communications`, `crm_email_outbox`, `deal_hunter_cim_requests`, CIM claim tables, `crm_follow_up_recommendations`, secure upload/document tables, dispositions, canonical opportunities, aliases, scores, score evidence, source observations, reconciliation runs/items, scheduled jobs, cleanup jobs, and all unrelated tables. DDL created by the earlier deployment is not counted as an apply mutation.

The immutable receipt is still one of the four first-apply rows. Creating UPDATE/DELETE triggers during the earlier schema deployment does not add a business-data mutation, exact replay does not update the receipt, and a future logical reversal inserts a separate reversal receipt rather than changing this apply receipt.

### 8.4 Prove GREEN and commit

- [ ] Run the focused command from 8.1.
- [ ] Run existing incident-repair and audit suites to prove pattern reuse did not alter their semantics:

  ```bash
  node --test test/canonicalOpportunityMergeRepair.test.js test/dealHunterCrmIntegrityAudit.test.js test/dealHunterCrmIntegrityF02Repair2.test.js test/dealHunterCrmIntegrityF02Repair3.test.js
  ```

- [ ] Run `git diff --check`; inspect for arbitrary pair arguments, generic repair abstractions, calls to mutable receipt upsert, receipt UPDATE/DELETE attempts, broad immutability changes to other manifest modes, or changes to the generic audit. None are allowed.
- [ ] Commit:

  ```bash
  git add server/repairs/crmDuplicateConsolidation.js server/services/crmDuplicateConsolidationRepair.js server/storage/sqlite.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/fixtures/crmDuplicateConsolidationReferenceSchema.sql
  git commit -m "feat: add bounded CRM duplicate consolidation repair"
  ```

## Task 9: Operator CLI and runbook for later, separately authorized gates

**Files:**

- Create: `scripts/repair-crm-duplicate-consolidation.js`
- Modify: `package.json`
- Create: `docs/crm-duplicate-consolidation-repair.md`
- Create: `test/crmDuplicateConsolidationCli.test.js`

### 9.1 Write failing CLI contract tests

- [ ] Spawn the CLI against disposable databases. With no mode flag, require preview mode, read-only/file-must-exist/query-only evidence, JSON on stdout, diagnostics on stderr, and zero business mutation.
- [ ] Assert the CLI has no survivor, loser, opportunity, pair-list, reverse, cleanup, reconciliation, send, or generic SQL argument.
- [ ] Assert `--apply` refuses unless all reviewed-artifact arguments and exact confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1` are present. Ensure no command builder prints or suggests a production apply invocation during preview.
- [ ] Assert stdout is exactly one parseable JSON document so an operator can redirect it byte-for-byte. Require secrets, contact fields, bodies, notes, document paths, and raw metadata to be absent.
- [ ] Assert the package script invokes the CLI with no `--apply` default.
- [ ] Run:

  ```bash
  node --test test/crmDuplicateConsolidationCli.test.js
  ```

  Expected RED: script, package command, and runbook do not exist.

### 9.2 Implement a preview-default operator surface

- [ ] Parse only these apply-related inputs: `--apply`, `--actor`, `--reason`, `--execution-release`, `--tooling-revision`, `--reviewed-manifest`, `--expected-plan-checksum`, `--manifest-id`, `--backup-path`, `--backup-manifest-id`, `--backup-sha256`, and `--confirm`. The database path comes from the established storage configuration, not an arbitrary pair selector.
- [ ] In preview mode, open the existing database read-only with file existence required, set query-only, invoke `previewCrmDuplicateConsolidation`, and write its canonical JSON once to stdout. Never persist a preview receipt.
- [ ] In apply mode, verify the reviewed artifact bytes and every required argument before opening a writable storage boundary; then delegate to the atomic service. Do not implement reverse in this CLI.
- [ ] Add package script:

  ```json
  "crm:duplicate-consolidation": "node scripts/repair-crm-duplicate-consolidation.js"
  ```

- [ ] In `docs/crm-duplicate-consolidation-repair.md`, document schemas, exact approved IDs, preview artifact verification, backup prerequisites, typed refusal states, exact confirmation text, expected four-row ledger, verified-prior-apply behavior, no-auto-retry rule, separate audit, and the separated production sequence below. State prominently that the runbook is not production authorization.

### 9.3 Prove GREEN and commit

- [ ] Run:

  ```bash
  node --test test/crmDuplicateConsolidationCli.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js
  ```

- [ ] Run the CLI preview against a disposable fixture and independently hash/reparse captured stdout. Confirm its database logical digest is unchanged.
- [ ] Run `git diff --check`; inspect `package.json` to ensure no dependency or unrelated script change.
- [ ] Commit:

  ```bash
  git add scripts/repair-crm-duplicate-consolidation.js package.json docs/crm-duplicate-consolidation-repair.md test/crmDuplicateConsolidationCli.test.js
  git commit -m "feat: add CRM consolidation operator runbook"
  ```

## Task 10: Full regression, static inventory, and acceptance evidence

**Files:**

- Modify only if a real coverage gap is found: tests created or named in Tasks 1–9
- Create: `docs/reviews/crm-duplicate-consolidation-implementation-verification.md`

### 10.1 Run targeted acceptance tests

- [ ] Run the complete supersession/repair set:

  ```bash
  node --test test/crmSubmissionSupersessionStorage.test.js test/crmSubmissionSupersessionGuard.test.js test/crmSubmissionSupersessionProjection.test.js test/crmSubmissionSupersessionReadThrough.test.js test/crmSubmissionSupersessionWriters.test.js test/crmDuplicateReview.test.js test/crmDuplicateConsolidationRepair.test.js test/crmDuplicateConsolidationRepairSafety.test.js test/crmDuplicateConsolidationCli.test.js
  ```

- [ ] Run the exact PR #19 authority suites and CRM audit:

  ```bash
  node --test test/dealHunterCrmMatchAuthorityBinding.test.js test/dealHunterCrmMatchAmbiguity.test.js test/dealHunterCrmIntegrityAudit.test.js
  ```

- [ ] Run UI acceptance:

  ```bash
  npx vitest run test-ui/CrmDuplicateReview.test.jsx test-ui/CrmRecordCard.test.jsx test-ui/DealActivityTimeline.test.jsx test-ui/CrmCommunications.test.jsx
  ```

### 10.2 Run repository gates

- [ ] Install from the lockfile using the repository's approved Node version, then run:

  ```bash
  npm ci
  npm audit --omit=dev
  npm run lint
  npm test
  npm run test:ui
  npm run build
  npm run test:browser
  ```

- [ ] Run `git diff --check` and require a clean worktree after the verification document commit.
- [ ] Open or update the implementation PR, push the final branch head, and wait for `.github/workflows/ci.yml` on that exact 40-character SHA. Require the `validate` job to pass `npm ci`, production dependency audit, lint, server tests, UI tests, build, Chromium installation, and browser tests. Record the PR number, run ID, head SHA, and conclusion in the verification document; do not merge or deploy.

### 10.3 Perform static coverage and safety review

- [ ] Search all code paths that mutate `contact_submissions`, create/claim/send communications or CIM requests, change recommendations/follow-up state, mutate documents/uploads, apply reconciliation, change canonical primary, or use cached submission IDs. Map each to the central service guard plus a same-transaction storage guard where a race is possible. Record this matrix in `docs/reviews/crm-duplicate-consolidation-implementation-verification.md`.
- [ ] Record evidence for every acceptance statement:
  - Pooler loser maps only to approved Pooler survivor.
  - Berlin loser maps only to approved Berlin survivor.
  - Pooler and Berlin remain separate canonical opportunities.
  - All original contact and history rows remain intact and directly readable.
  - Active lists, counts, queues, Command Center, matcher, reconciliation, recommendations, and Stage 2 count one survivor and no loser.
  - All direct loser writers return the typed refusal before durable or provider side effects.
  - Match authority changes on active supersession insert/reversal and final link cannot select a loser.
  - The Berlin legacy import mutation is exact and preserves `opportunity_id = NULL`.
  - First apply is exactly four rows; repeat apply is zero rows; all injected failures roll back.
  - The consolidation receipt is inserted once, remains usable by the supersession relation, and rejects generic-upsert, direct-SQL UPDATE, and direct-SQL DELETE mutation attempts while non-consolidation manifest behavior remains unchanged.
  - Exact replay byte-validates rather than updates the apply receipt, and logical reversal uses a distinct immutable reversal receipt.
  - Generic CRM audit output is unchanged; supersession audit passes.
  - SQLite `quick_check` is `ok`; foreign-key check returns zero rows.
  - Supabase refuses before partial authority or mutation.
  - No reverse operation is reachable from normal routes, UI, package preview command, or ordinary writer APIs.
- [ ] Confirm the verification document contains test/run IDs and SHA-256 values but no production data, contact details, message bodies, secrets, or artifact contents.

### 10.4 Review final diff and commit verification evidence

- [ ] Compare the complete branch to the approved implementation base. Confirm there is one startup-DDL/schema change containing both the supersession schema and mode-scoped receipt UPDATE/DELETE guards, no separate untracked migration mechanism, no dependency change, no generic audit semantic change, no production artifact, no change to non-consolidation manifest mutability, and no unrelated cleanup.
- [ ] If a test reveals a runtime defect, return to the owning task, add a focused RED test, implement the smallest fix, rerun that task's focused and neighboring suites, and make a separate fix commit. Do not bury runtime changes in this verification-document commit.
- [ ] Commit only the verification record:

  ```bash
  git add docs/reviews/crm-duplicate-consolidation-implementation-verification.md
  git commit -m "docs: record CRM consolidation implementation verification"
  ```

## Migration and deployment boundary

This repository's SQLite schema evolves through idempotent startup DDL in `createSqliteStorage`; there is no separate migration runner to invent for this work. The future code PR therefore carries one reviewed startup-DDL addition containing the supersession schema and the two consolidation-receipt immutability triggers. A disposable copy of the previous schema must prove upgrade safety in Task 1. The runtime must be deployed before any incident preview because the deployed process and database need the new table, triggers, v2 authority, guards, and read projections.

These are separate owner gates and must not be combined in one task or one Codex run:

1. **Code/migration implementation in isolation.** Execute Tasks 1–10 in a clean worktree/branch, obtain exact-head CI, and stop for independent code and schema review. No production access.
2. **Merge/deploy under new authorization.** Merge the reviewed exact head and deploy that exact revision through the established single-machine Fly procedure. Verify health, readiness, same volume, SQLite integrity, outbound fail-closed controls, and deployed revision. Do not run repair preview during deploy.
3. **Fresh pre-repair recovery checkpoint under new authorization.** After the new code/startup DDL has run and before production preview/apply, create and independently verify a new application-consistent current-format backup and Fly volume snapshot. The September 17 pre-migration backup/snapshot are historical recovery evidence, not sufficient current apply authority.
4. **Production preview only under new authorization.** Re-verify writers and safety controls, invoke the default read-only CLI once, retain stdout verbatim, hash and independently reread it, and prove the business-state digest is unchanged. Do not pass `--apply` or construct an apply command.
5. **Owner review of the exact preview.** Independently review blockers, schema/reference inventory, raw-row digests, exact four-row plan, plan checksum, manifest ID, release/tooling identities, and fresh checkpoint. A successful preview is not apply authority.
6. **Production apply under separate explicit authorization and confirmation.** Bind the exact reviewed artifact/checksum/checkpoint/release/tooling identity, execute once, and stop on refusal or ambiguity. No automatic retry.
7. **Post-apply verification.** Prove exactly four changed business rows, all protected-table digests unchanged, no send/provider effect, both audits correct, active projections/read-through correct, `quick_check = ok`, and zero FK violations. This gate does not authorize workflow cleanup or reconciliation.

## Logical reversal boundary

The schema permits only a separately authorized `active -> reversed` transition with a matching new append-only reverse receipt. The normal implementation exposes no reverse service, route, component, package script, or flag. A future reverse plan would have to bind and byte-validate the immutable original apply receipt/current digests, prove no post-apply business write relied on the relation, insert a distinct receipt whose mode remains `crm-duplicate-consolidation` and whose separately versioned manifest identifies the reverse operation, CAS-reverse both relations to reference that new receipt, CAS-restore the Berlin import's exact pre-apply metadata/timestamp/submission ID, and commit once. Both receipt rows are protected by the same mode-scoped UPDATE/DELETE triggers; reversal must never update, repurpose, or delete the original apply receipt. Backup or Fly-snapshot restore remains a disaster operation requiring a distinct owner-approved recovery plan.

## Explicitly deferred owner-workflow items

The implementation must not include:

- clearing Pooler survivor overdue `next_action_at` or follow-up state;
- clearing Berlin survivor overdue `next_action_at` or follow-up state;
- dismissing, accepting, superseding, or regenerating the stale Pooler recommendation;
- deciding whether Pooler and Berlin represent one business;
- broad cleanup or consolidation of other duplicate candidates;
- a general CRM redesign or arbitrary-record merge tool;
- Supabase table/RPC/schema parity;
- persistent keep-distinct/candidate decision storage;
- scoring/profile changes;
- financial metric redesign or relabeling `Annual Profit`;
- CRM reconciliation, source mutation, CIM/broker/follow-up sending, Stage 2 activation, or automation changes.

## Requirements-to-task traceability

| Approved requirement | Owning task(s) |
|---|---|
| Durable table, indexes, trigger invariants, delete restriction, chain/cycle prevention, legal reversal state | 1 |
| Consolidation receipt inserted once and protected from generic-upsert/direct-SQL UPDATE or DELETE without changing other manifest modes | 1, 8, 10 |
| Central typed loser-write refusal and HTTP projection | 2, 6 |
| Active CRM/search/count/follow-up/Command Center projection | 3 |
| Direct historical detail, combined history, `originSubmissionId`, minimal banner/link | 4 |
| Match authority v2, 5,000 bounds, canonicalize then dedupe, final `BEGIN IMMEDIATE` validation | 5 |
| All remaining writers, sends, claims, documents, reconciliation, sync, facts, Stage 2 | 6 |
| Read-only pair report, no transitive grouping, no bulk merge, generic audit unchanged | 7 |
| Exact approval descriptor, exhaustive reference classifier, preview purity, four-row transaction, idempotency/rollback | 8 |
| Preview-default CLI, exact confirmation, runbook, no arbitrary pair arguments | 9 |
| Full regression, static writer inventory, quick/FK checks, Supabase refusal, acceptance evidence | 10 |
| Fresh post-deploy checkpoint, separately authorized preview/review/apply | Migration and deployment boundary |
| Non-ordinary logical reversal | Task 1 and logical reversal boundary |

## Plan self-review checklist

- [x] Every approved design section maps to a task or an explicit boundary above.
- [x] Every implementation task starts with an exact failing test command and expected RED reason, then names the smallest implementation, GREEN command, neighboring regressions, diff review, and commit.
- [x] Stable function/type names are consistent across storage, service, HTTP, repair, CLI, and tests.
- [x] No task authorizes production access, mutation, deploy, preview, apply, restore, reconciliation, or transmission.
- [x] The schema deployment, fresh recovery checkpoint, preview, owner review, apply, and post-apply verification are separate gates.
- [x] The first future apply remains exactly two supersession inserts, one Berlin import CAS update, and one receipt insert.
- [x] `contact_submissions` and every protected history/business table have zero apply mutations.
- [x] Pooler and Berlin remain separate and cannot merge through candidate transitivity.
- [x] Supabase remains fail-closed before partial reads or writes.
- [x] Every business writer has an identified central guard path and race-sensitive storage recheck.
- [x] Active filtering uses the shared indexed SQLite anti-join rather than frontend hiding.
- [x] PR #19 ambiguity, bounds, and final-link semantics remain covered.
- [x] Generic CRM integrity audit semantics remain unchanged; supersession has its own audit.
- [x] Receipt reuse is namespaced; first apply uses direct INSERT, exact replay byte-validates with zero writes, and mode-scoped SQLite triggers reject every later UPDATE/DELETE while non-consolidation manifest behavior remains unchanged.
- [x] Logical reversal creates a distinct append-only reverse receipt and never updates, repurposes, or deletes the immutable original apply receipt.
- [x] Reversal is representable but not callable as an ordinary operator action.
- [x] Deferred owner-workflow items are absent from implementation tasks.
- [x] The plan contains no unfinished-marker tokens, empty interface bodies, or generic arbitrary-pair operation.
