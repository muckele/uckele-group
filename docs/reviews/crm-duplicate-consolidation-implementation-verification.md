# CRM duplicate-consolidation implementation verification

Date: 2026-09-20  
Runtime: Node v22.23.2, npm 10.9.8  
Original implementation head characterized: `e2e6d8097188ee0603f90895a14d134031ed194d`  
Original runtime baseline: `cec88c5a37a5dc433896ee5fd737d606691a3f31`  
Task 10 test/fix head before this record: `dcfb4cf81575c64a4c826e4fb4d011b004ba9c7c`  

## Verdict and boundary

The isolated implementation passes the complete local Task 10 acceptance matrix after three Task 10 commits. Two commits repair regressions exposed by the required controlled baseline comparison; one commit adds the three narrow tests required by the approved plan. No production system, production database, deployed service, provider, live CRM source, reconciliation job, Stage 2 activation, automation setting, backup/snapshot, production preview, or production apply was accessed or changed.

The owner instruction for this run explicitly supersedes the plan's PR/CI step: no push or pull request was performed. Exact-head independent whole-branch review, push, PR attachment, and hosted CI remain root-managed gates.

## Controlled baseline comparison

### Method

Two isolated local clones were checked out detached and left unmodified:

- `/private/tmp/uckele-p7-task10-baseline` at `cec88c5a37a5dc433896ee5fd737d606691a3f31`;
- `/private/tmp/uckele-p7-task10-current` at `e2e6d8097188ee0603f90895a14d134031ed194d`.

Both used the same Node binary (`/Users/Matt/.nvm/versions/node/v22.23.2/bin/node`), npm 10.9.8, lockfile SHA-256 `6a2946ebf91d7090d980cbaac9c5d4a53adb3a2c80ed8a1d23e498e730ce0a0e`, `npm ci`, environment, `npm test` command, and localhost-listener permission. Both lockfile installs added 538 packages and audited 539 packages. The restricted-sandbox characterization was discarded as product evidence because loopback listeners were denied with `EPERM`; the identical-permission reruns below are authoritative.

| Run ID | Revision | Result | Complete log | SHA-256 |
| --- | --- | --- | --- | --- |
| T10-CHR-BASE | `cec88c5a37a5dc433896ee5fd737d606691a3f31` | 1,700 tests; 1,697 pass; 0 fail; 3 skip | `/private/tmp/uckele-p7-task10-baseline-npm-test-escalated.log` | `558ad5ae5f41c855b6ce54aa040a1ed420397a640832cb3dcff3bc84fece9880` |
| T10-CHR-CURRENT | `e2e6d8097188ee0603f90895a14d134031ed194d` | 2,029 tests; 1,858 pass; 168 fail; 3 skip | `/private/tmp/uckele-p7-task10-current-npm-test-escalated.log` | `7b02fc80de4d1d03d88e47fbd3de7a5b93ab98541da09f5bdaf7693c2e962ac2` |

The baseline failure set is empty. The current failure set contains exactly 168 `not ok` identities. The normalized identity artifacts are:

- baseline: `/private/tmp/uckele-p7-task10-baseline-failure-identities.txt`, empty-file SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- current: `/private/tmp/uckele-p7-task10-current-failure-identities.txt`, SHA-256 `fb28ddcbf8577583aeeadfda9d18d21684fb8c6d06c6d8307850752dc3001b13`.

All failures were confined to these nine files: `dealHunterCrmIntegrityF02Repair.test.js`, `dealHunterCrmIntegrityF02Repair2.test.js`, `dealHunterCrmIntegrityF02Repair2Safety.test.js`, `dealHunterCrmIntegrityF02Repair3Safety.test.js`, `emailCommunicationLifecycle.test.js`, `dealHunterFollowUps.test.js`, `leadLifecycle.test.js`, `dealHunterScoring.test.js`, and `dealOsImport.test.js`.

The exact error categories in the complete output were:

| Signature/category | Count | Meaning |
| --- | ---: | --- |
| `UNSUPPORTED_TARGET_TRIGGER:contact_submissions:` naming both supersession guards | 24 | Primary F-02 inspector refusals; the legacy inspectors classified the two reviewed supersession triggers as hostile. |
| `Apply refused: a reviewed F-02 approval manifest is required.` | 19 | Cascade after the corresponding preview/inspection refusal. |
| `Apply refused: a reviewed F-02 Repair2 approval manifest is required.` | 22 | Cascade after the corresponding preview/inspection refusal. |
| `Apply refused: a reviewed F-02 Repair3 approval manifest is required.` | 22 | Cascade after the corresponding preview/inspection refusal. |
| `storage.assertCrmSubmissionWritable is not a function` | 11 | Older service-unit storage doubles did not expose the new central assertion. |
| Multiline assertion failures | 101 | Assertions downstream of the two root causes, including subtest-parent accounting. |
| Parent/subtest summaries and undefined-plan cascades | 12 | Nested TAP accounting/cascades already included in the 168 exact `not ok` identities. |

Counts in the signature table are diagnostic occurrences and overlap nested TAP accounting; the exact failure-set cardinality is the 168-line identity artifact, not the sum of diagnostic occurrences.

### Root cause, introduction, and fixes

Automated bisection with retained focused reproductions identified:

1. `519edce0ac499ba14133ee0b28040ccef5761f83` as the first bad commit for the F-02 repair suites. That commit correctly added two supersession triggers, but the three older repair inspectors treated every trigger on their target tables as unsupported. Commit `caf12c0932ba346b715b7aa1fe126c79d5b04215` (`fix: preserve CRM repair trigger compatibility`) centralizes trigger classification and permits only the exact reviewed SQL digests for those two triggers. Same-name SQL drift and every unknown trigger remain fail closed. The focused four-file result is 196/196.
2. `057da654b738aa689976f8d1d076ad048b738e14` as the first bad commit for the writer-service unit suites. Production correctly called `assertCrmSubmissionWritable`; five older test doubles omitted that contract. Commit `e66445f2ce0dee56c31c4093be6f202db6aef9d0` (`test: restore supersession writer test doubles`) adds only no-op assertion methods to those bounded doubles. The focused five-file result is 78/78.

A fresh post-fix full run before adding the three acceptance tests was 2,029 tests, 2,026 pass, 0 fail, 3 skip (`/private/tmp/uckele-p7-task10-postfix-npm-test.log`, SHA-256 `4ceb42095f6eb596c689e630f42249f9affc16c64861ddbe27b95f90a844f7c6`).

## Deferred coverage decisions

All three previously deferred items are explicit requirements in the approved implementation plan, so commit `dcfb4cf81575c64a4c826e4fb4d011b004ba9c7c` adds only the missing tests/fixture:

- exact pre-supersession upgrade: `test/fixtures/preSupersessionStartupSchema.sql` is the empty startup schema captured from baseline `cec88c5...` under Node v22.23.2. It contains 42 tables, 102 indexes, and 2 triggers; it contains no supersession object. Fixture SHA-256: `f5f1386354014769a9fd58a3dd34e2817f3558c19b140360b17989796b1bc407`;
- opportunity-primary INSERT: a separate raw-SQL INSERT regression proves the active loser is rejected and no opportunity row is inserted, independently of the existing UPDATE regression;
- exact authority maximum: independent contact and active-supersession tests prove complete, non-null revision authority at exactly 5,000 rows; the existing 5,001 cases continue to refuse with `complete: false` and `revision: null`.

The focused test run is 71/71 with lint and `git diff --check` clean.

## Exhaustive writer and authority inventory

The static review covered every `assertCrmSubmissionWritable`, every `assertCrmSubmissionWritableInTransaction`, every mutation of `contact_submissions`, CRM activity, communications, email outbox, CIM requests/imports, recommendations, follow-up state, secure uploads/documents, Command Center state, reconciliation linkage, source repair, Stage 2 primary authority, opportunity primary assignment, and every cached `submission_id` path under `server/`. A service check gives early typed refusal; the listed SQLite check is the race-closing authority in the same transaction as its mutation. Read-only/terminal replay exceptions are stated explicitly.

| Mutation or authority path | Service guard / ordering | SQLite or schema guard | Race and test evidence |
| --- | --- | --- | --- |
| Submission workflow update | `updateSubmissionWorkflow` calls central assertion before load/change. | `updateSubmission` and `updateSubmissionIfCurrent` assert inside their immediate transaction. | Concurrent activation is caught at storage; `crmSubmissionSupersessionGuard.test.js`, writer matrix. |
| Archive and restore | `archiveLead` / `restoreLead` assert before state work. | Common `mutateWithCrmActivityTransaction` checks activity owner and mutated submission in one transaction. | No submission/activity partial write; lead lifecycle and writer matrix. |
| Permanent dashboard deletion | `deleteDashboardSubmission` asserts before historical lookup. | `deleteSubmission` asserts inside the delete transaction; relation FK/trigger also forbids referenced contact deletion. | Concurrent activation refuses; guard/storage suites. |
| Ordinary CRM activity | `recordCrmActivity` asserts before insert. | `insertCrmActivityEvent` asserts in the insert transaction. | Historical rows remain readable; post-activation activity is unchanged/refused in read-through and writer tests. |
| Activity plus business mutation | `commitCrmActivityMutation` asserts the activity owner. | `mutateWithCrmActivityTransaction` checks both activity and actual mutated submission before `update_submission`, `archive_submission`, or `dismiss_deal_hunter_opportunity`. | One transaction, all-table digest equality on refusal. |
| Recommendation generation | `generateCrmFollowUpRecommendation` asserts before context/AI/provider work. | Insert, supersede, and update recommendation methods assert in their write transactions. | Zero provider calls and no recommendation change for loser; recommendation/writer suites. |
| Recommendation dismissal | `dismissCrmFollowUpRecommendation` asserts before optimistic version check. | Recommendation update and common activity transaction recheck. | Concurrent activation refuses before durable outcome/activity. |
| Email suppression create/lift | `createAdminEmailSuppression` and `liftAdminEmailSuppression` assert before mutation. | Common activity transaction rechecks the submission. | No suppression/activity drift; follow-up/writer suites. |
| Follow-up preview/send command | Preview and both new/replayed nonterminal send paths assert. Exact terminal command/outbox replay is returned before the assertion. | Email-command transaction checks the submission before communication/outbox/activity writes. | Nonterminal race closes atomically; exact terminal replay remains idempotent. |
| Email outbox worker | `processCrmEmailOutbox` returns established terminal states first, otherwise asserts before claiming/provider work. | `claimCrmEmailOutbox` asserts only for claimable `queued`, `retryable_failed`, or `sending` states in the claim transaction. | Active loser produces zero provider calls; terminal replay preserved. |
| Manual communication | `createManualCommunication` and `createCommunicationWithActivity` assert before construction. | `insertCrmCommunication` and the common activity transaction assert in-transaction. | No communication/activity partial write; communication/writer suites. |
| Communication assignment/reparent | `assignUnassignedCommunication` asserts the target submission. | `updateCrmCommunication` checks both existing and target owner IDs in the same transaction. | Prevents reparenting from or to a loser under concurrent activation. |
| Provider inbound/lifecycle communication | Provider ingestion has no trusted service-level submission command to pre-authorize. | Communication insert/update checks the resolved existing/target submission in the transaction. | Storage boundary is authoritative for untrusted events; email lifecycle and communication storage suites. |
| Secure upload request creation | `createSecureUploadRequest` asserts before token/email/filesystem effects. | `insertSecureUploadRequest` asserts in the insert transaction. | Full database, filesystem, and provider snapshots remain equal for loser. |
| Public token upload/finalization | HTTP entry asserts the request owner before recovering stale state; `uploadSecureDocuments` asserts again before file/write work. | Reset, stale claim, upload-request update, document insert, and associated recommendation mutation are guarded in their transactions. | Deterministic stale-claim race and real HTTP/file evidence in writer/document suites. |
| Upload revoke | Exact already-revoked result is returned idempotently; nonterminal `revokeSecureUploadRequest` asserts. | Upload-request update asserts the stored owner in-transaction. | Terminal replay is preserved; mutable loser request refuses. |
| Secure document delete | `deleteSecureDocument` asserts the document owner. | `deleteSecureDocument` storage transaction rechecks owner before delete/recommendation supersede. | No database/filesystem drift on refusal. |
| Acquisition Command Center record change | `updateAcquisitionCommandCenterRecord` asserts before command construction. | Common activity/submission transaction rechecks before business and activity writes. | Loser refusal and survivor control are covered in Command Center/writer suites. |
| Broker Materials prepare/approve | Both entry points assert the current primary; an existing durable approval result returns before a new assertion/write. | Downstream CIM claim/upsert, communication, and activity boundaries recheck. | Preparation drift, replay, zero-provider loser cases, and survivor control are covered. |
| Manual CIM follow-up start/stop | Entry points assert current owner after stable-route validation; exact already-stopped replay returns without mutation. | Start/stop transactions assert expected submission, then verify request/submission versions and route before write/activity. | Same-transaction CAS; correct terminal replay exact, reparented route refuses. |
| Manual CIM follow-up prepare/approve/execute | Prepare/execute paths assert before eligibility/provider work; approval validates stable durable route before reconciliation/replay, then asserts nonterminal authority. | Due-claim transaction and CIM request/communication writers recheck. | Provider-accepted replay is not retransmitted; loser races produce zero provider calls. |
| Explicit approved/direct CIM send | Approved Broker Materials execution asserts current canonical primary; direct signed-snapshot send reloads and asserts current primary before source review. | CIM request claim/upsert plus communication/activity writers assert inside transactions. | Reviewed-to-current primary drift refuses before source bookkeeping or provider work. |
| Corrected-recipient retry | Asserts original durable request owner before retry eligibility or provider work. | CIM claim/upsert and communication transactions recheck the owner. | Loser and survivor controls in bulk-CIM/writer suites. |
| Legacy CIM due follow-up | Execution asserts request owner before provider work. | Due claim transaction checks stored owner before state change. | No claim/provider effect for loser; Task 6 matrix and follow-up suites. |
| High-fit CRM sync | Fresh v2 match authority is reviewed; cached `submission_id` is centrally asserted before reuse. | `claimDealHunterCrmImport` checks existing and proposed cached owner in one transaction; final link uses `BEGIN IMMEDIATE`, recomputes complete authority, verifies revision, asserts selected row, then links. | Failed/stale cached loser and insert/reversal-after-review races refuse; unchanged survivor links once. |
| Deal OS reconciliation apply | Preview is read-only; apply preflights every cached import owner before creating run/item bookkeeping and centrally asserts cached IDs. | Import claim/update checks source and target IDs in one transaction; final CRM link uses the v2 authority transaction. | Cached loser refuses with zero run/item rows; archive-after-final-review race refuses without partial link. |
| Direct source-field repair | Preview deliberately remains read-only. `repairDealHunterCrmSourceFields` asserts only for `apply: true` before source mutation. | Final contact/activity writes pass through guarded submission/common activity transactions. | Loser apply preserves the all-application-table digest; preview remains pure. |
| Cached CRM import bookkeeping | High-fit/reconciliation services validate every loaded cached owner. | `claimDealHunterCrmImport` guards existing/new/collision rows; `updateDealHunterCrmImport` guards both current and replacement `submission_id`. | Covers failed, stale-pending, collision, and reparent races. |
| Final CRM match/link authority | Services require a complete v2 revision derived from ordered contacts plus active supersessions. | `linkDealHunterCrmSubmissionIfAuthorityCurrent` recomputes authority in `BEGIN IMMEDIATE`, compares revision, asserts writability, active opportunity, ownership, uniqueness, then updates. | Active relation insert/reversal or unrelated CRM mutation invalidates stale review; loser can never be selected. |
| Opportunity canonical primary assignment | Callers use reviewed current opportunity authority; no loser redirect/substitution occurs. | INSERT and UPDATE triggers reject any active loser as `primary_submission_id`; supersession insertion requires the survivor already be primary. | Separate raw INSERT and UPDATE regressions; active relation prevents owner/primary invalidation. |
| Opportunity Pass/archive mutation | `dismissDealHunterOpportunity` routes the linked primary through guarded atomic activity mutation. | Pass transaction checks explicit command ID, current primary, and archived submission before opportunity/submission/activity changes. | Primary and command races refuse with no partial archive. |
| Stage 2 final send authority | `authorizeCimStage2SendBoundary` requires `primarySubmissionWritable === true`; it never maps a loser to a survivor. | `getCimStage2SubmissionAuthority` reads current opportunity and active-loser evidence in one immediate snapshot. | Deterministic final-boundary race is read-only, all-table equal, zero provider calls; survivor-primary control succeeds. |
| Canonical opportunity merge | Service remains governed by its exact reviewed plan/backup/receipt gates. | Inspection and final transaction require zero active or reversed supersession rows on either scoped opportunity; complete rows are scanned. | Scoped history blocks before mutation; unrelated active/reversed history and receipts remain byte-identical through successful merge. |
| Supersession/receipt repair itself | No ordinary business route invokes apply or reversal. Preview is read-only and the CLI defaults to preview. | Exact four-write transaction, CAS, required-schema/reference inventory, immutable receipt triggers, relation triggers, rollback and postconditions. | Repair/safety/CLI suites; no generic merge or reverse surface exists. |

Supabase deliberately has no partial parity: every supersession/authority/link method refuses before querying or mutating. This is covered by the storage, guard, authority, and writer suites.

## Local acceptance results

All commands below ran in the isolated implementation worktree under Node v22.23.2 after a fresh `npm ci`.

| Run ID | Command/group | Exact result | Log SHA-256 |
| --- | --- | --- | --- |
| T10-SUPER | Required supersession, guard, projection, read-through, writers, duplicate review, repair/safety, CLI command | 290/290 pass | `067542f7064738e4fffcf382efe581bf41cf981df82ce3dec041096ccdd6c452` |
| T10-AUTH | PR19 authority binding, ambiguity/dedupe, generic CRM audit | 48/48 pass | `4141e7684af0255b7e9e831bce6b7155f08f748edae58d63a4633dc90242552b` |
| T10-6A | Canonical merge 6A + opportunity facts + supersession storage | 247/247 pass | `2c4e91590b59921835f9d593356e152ae4edbecaf9ddbf9d7b78c4977b8c7345` |
| T10-UI-FOCUSED | Four required UI duplicate-review/read-through files | 4 files, 22/22 pass | `033029e6fefd502b32503add33b7f605a17964940a9bcb842558cb2f0d82d38b` |
| T10-CI | `npm ci` | 538 packages installed; lockfile honored | `162add7776daa198fa9a3162a6e0e13ec2ecf82c78a21d785ee0f347d1d13374` |
| T10-AUDIT | `npm audit --omit=dev` | 0 production vulnerabilities | `6d8c5c8f3d7684adb070417bd608d01ae90aa3dc26a65af03ffda4955f38d9a3` |
| T10-LINT | `npm run lint` | pass, zero warnings | `cfd01654217f2215fbd95e5c533a2438436cc165d47c851dd69cdccce151ed64` |
| T10-SERVER | `npm test` | 2,032 tests; 2,029 pass; 0 fail; 3 skip | `752de8a263329c2c87ee8e8dae16e5b074fb116b6ed6e3e130019c83fdddb2db` |
| T10-UI | `npm run test:ui` | 25 files, 240/240 pass | `54fec5d8de4de5a126fb6b29701e603198e41cb8909cd6bf99188dcd79821766` |
| T10-BUILD | `npm run build` | pass; 9 public routes pre-rendered | `5172896b9b40e9d6f252434462daabac12cd412eec88c8aedb02561dfc0cdadb` |
| T10-BROWSER | `npm run test:browser` | Chromium 35/35 pass | `fc5f32aa6340820e4225b5f28f8c76f97e3fb144bc5f63f748c0480692842670` |
| T10-DIFF | `git diff --check` | pass, no output | n/a |

The first restricted `npm audit` attempt could not resolve `registry.npmjs.org`; the required network-authorized retry is T10-AUDIT and returned 0 vulnerabilities. Local-listener suites were run with test-only loopback permission. No external application or production endpoint was contacted.

## Disposable SQLite acceptance evidence

T10-SUPER uses a fresh disposable SQLite database and proves in one bounded acceptance flow:

- the reviewed descriptor freezes only the two approved, separate Pooler and Berlin pairs; no transitive grouping occurs;
- each loser maps only to its approved survivor and the two canonical opportunities remain separate;
- original contact rows and all historical activity/email/communication/upload/document rows remain intact and are directly readable;
- active lists, counts, queues, Command Center, matcher, reconciliation, recommendations, high-fit, Broker/CIM, and Stage 2 enumerate the survivor once and omit the loser;
- every direct loser writer produces the typed `CRM_SUBMISSION_SUPERSEDED` refusal before durable/provider effects;
- the Berlin legacy import mutation is exact, preserves `opportunity_id = NULL`, and leaves every other import row unchanged;
- first apply reports exactly four mutations: two relation inserts, one Berlin import CAS update, and one immutable receipt insert;
- exact replay reports `verified-prior-apply`, `applied: false`, `mutationCount: 0`, deep-equal state, and a byte-identical receipt;
- injected failure after each of the four writes and during postconditions rolls back the complete transaction;
- generic-upsert, direct UPDATE, and direct DELETE cannot mutate the consolidation receipt, while an ordinary non-consolidation manifest remains mutable;
- logical reversal requires a distinct bound immutable receipt and preserves the original apply receipt byte-for-byte;
- supersession audit returns `{ ok: true, violationCount: 0, violations: [] }`;
- the generic CRM audit findings and ownership health are unchanged; only its existing active read-through count decreases by the superseded loser;
- `PRAGMA quick_check` is exactly `ok` and `PRAGMA foreign_key_check` returns zero rows;
- the `contact_submissions` digest remains equal to the reviewed artifact;
- Supabase refusal occurs before partial authority or mutation.

T10-6A additionally proves the canonical-merge boundary: active or reversed supersession history on either proposed canonical ID blocks inspection/apply before mutation; unrelated active and reversed history does not block and survives successful canonical merge byte-for-byte; the supersession table is required schema; and transaction failure rolls back aliases, opportunities, exception state, and manifest.

## Final branch/diff safety review

- Schema evolution remains the single idempotent startup-DDL path in `server/storage/sqlite.js`; there is no added migration runner or untracked migration mechanism.
- The supersession table, indexes, relation triggers, canonical-primary INSERT/UPDATE triggers, and mode-scoped consolidation-receipt UPDATE/DELETE guards are installed together by startup DDL.
- `package-lock.json` is unchanged from the original runtime baseline. `package.json` changes only by adding the preview-default `crm:duplicate-consolidation` script; no dependency changed.
- The generic CRM integrity-audit implementation was not semantically changed for supersession. Supersession has its own audit.
- Non-consolidation manifest lifecycle behavior remains unchanged and is explicitly tested.
- Static search finds reversal representation only in schema/audit/canonical-inventory code. There is no reverse route, UI control, service, package command, preview flag, or ordinary writer API.
- No production artifact, database, backup, snapshot, preview/apply output, contact detail, message body, credential, secret, or protected artifact content is included in this record.
- The only Task 10 runtime change is the exact-digest F-02 trigger compatibility fix. The remaining Task 10 changes are test-double restoration, narrow plan-required acceptance tests, the exact historical schema fixture, and this verification record.

## Task 10 commits before this record

- `caf12c0932ba346b715b7aa1fe126c79d5b04215` — `fix: preserve CRM repair trigger compatibility`
- `e66445f2ce0dee56c31c4093be6f202db6aef9d0` — `test: restore supersession writer test doubles`
- `dcfb4cf81575c64a4c826e4fb4d011b004ba9c7c` — `test: close CRM consolidation acceptance gaps`

No deployment or production gate is authorized by these results. The next permitted action is independent whole-branch review at the exact final local head.
