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

- exact pre-supersession upgrade: `test/fixtures/preSupersessionStartupSchema.sql` is the empty startup schema captured from baseline `cec88c5...` under Node v22.23.2. It contains 42 tables, 102 indexes, and 2 triggers; it contains no supersession object. Fixture SHA-256: `aebfa63ad280f319ac03c9f6e470d6c754561bc726bed6be287202ada3bae564`;
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

## 2026-09-21 coordinated V2 repair correction verification

This section is the current verification record for repair planning and execution. It supersedes the V1 source-shape and runtime-safety assumptions above without rewriting the historical Task 1–10 record. The durable supersession schema, approval schema, checkpoint envelope, and four-row incident scope are unchanged; the repair plan, manifest, confirmation, manifest namespace, retained-evidence predicate, and runtime-safety authority are V2.

### Approved authority and implementation identity

- Approved source-shape/runtime-safety addendum SHA-256: `32973350304fd1e1ef5c1f4f0a9caab36cd293d0536d360af6155c935ae7b29a`.
- Restricted raw-evidence artifact SHA-256: `e5a1e4e8383b03176485ed06a3aa98210e30da426289ff979830b19246a2e808`; the artifact remains outside Git with mode `0600`.
- Sanitized evidence summary SHA-256: `5355e90d7fc4e43d64593019e19268e538b9baa1d42a2c6079470a5864986fa0`.
- Starting PR #20 head: `477b2cacd5699aef5f74f9ac2e14ce72dc923283`.
- Reviewed runtime/documentation candidate: `d350fc9b2588f0cdea4e4bc34c7f8abc620137ea`.
- Correction commits through that candidate:
  - `8e84d2e8294ddd020809a31c61b0c7f3a3f7621b` — V2 contracts and faithful retained-source predicates;
  - `5803df5c90b96cfb5dc99f57697997b8b65bd212` — four-source runtime-safety authority and execution-stage binding;
  - `cab45c53b9c95ef6e655ec87ea66005e95b163d6` — supported retained URL identity aliases;
  - `d350fc9b2588f0cdea4e4bc34c7f8abc620137ea` — V2 design, plan, and runbook record.

The V2 delta through the reviewed candidate changes 12 files with 1,418 additions and 741 deletions. It introduces no dependency, schema, migration, generic CRM-integrity audit, UI, deployment, or production-configuration change.

### Corrected source shape and V2 boundary

- Pooler marketplace authority may come from its retained supported listing URL with no manufactured aliases. Primary URL, listing aliases, and identity aliases are inspected independently; malformed, unsupported, and conflicting identity-bearing inputs remain blockers even when another input is valid.
- Berlin remains fixed to the approved opportunity, survivor, loser, legacy import, and canonical import identifiers. Its duplicate must retain the exact scalar `sheet-0` / `csv` / external ID `18` source pointers, the approved raw UTF-8 deal-key digest, the documented missing URL/alias shape, no canonical ownership, and corroborating survivor alias/import evidence. The raw deal-key preimage is neither stored nor logged by the repository.
- Financial authority comes from the retained `metadata.dealHunter.raw["Annual Profit"]` value plus the stored projections. The former synthetic `financialProvenance` object is not required or created.
- The canonical retained import binds the durable `opportunity_id` column to the approved opportunity, requires metadata `opportunityId` to remain absent, and binds the normalized survivor listing identity and source fields. The legacy import remains unowned with its exact retained source/deal-key evidence.
- The approval schema remains `crm-duplicate-consolidation-approval-v1` and the checkpoint envelope remains `crm-duplicate-consolidation-checkpoint-v1` by design. The active repair contract is `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2`, plan `crm-duplicate-consolidation-plan-v2`, manifest `crm-duplicate-consolidation-manifest-v2`, confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2`, and manifest namespace `crm-duplicate-consolidation:v2:`. V1 plans, manifests, and confirmation refuse before writable storage construction.

### Four-source safety authority and execution flow

The deterministic authority binds exactly two durable SQLite facts and two effective configuration facts:

1. `deal_hunter_cim_safety_settings/global/outreach_paused = true`;
2. `deal_hunter_automation_settings/cim-initial-outreach/paused = true`;
3. `dealHunter.cimFollowUp.enabled = false`;
4. `dealHunter.cimAutomation.schedulerEnabled = false`.

Durable facts include raw-row digests. Configuration facts include their source paths, environment-variable identities, normalized booleans, and validated lexical representation. The repair first compares current configuration-only authority to reviewed configuration-only authority, then compares the complete current four-source authority to the complete reviewed authority. It never compares a configuration-only digest to a complete digest or hashes a digest into itself.

Repair-specific validation accepts the application's supported true/false tokens and legitimate absent/empty false defaults, but refuses malformed explicit tokens, unsafe true values, incomplete effective configuration, or lexical/effective disagreement. This does not alter application-wide boolean parsing or impose repair authority on unrelated storage callers.

Preview uses a file-existing, query-only, read-only connection and one consistent snapshot. Backup reconstruction combines backup-observed durable rows only with reviewed configuration facts; it does not claim the backup proves live configuration. Apply revalidates the same selected configuration and current durable rows before any writable constructor call, passes that same configuration/environment to writable storage, and independently rebuilds complete authority inside `BEGIN IMMEDIATE` before receipt lookup or any repair write. Replay performs the current safety inspection before `verified-prior-apply` and validates the exact corrected state rather than rerunning a pre-apply candidate predicate.

### Public and restricted coverage

Public tests use clearly labeled synthetic identity data for parsing, hashing, type boundaries, URL-only Pooler handling, malformed/conflicting evidence, raw Annual Profit authority, fixed-digest refusal, V2/V1 artifact boundaries, configuration normalization, durable/config comparison, CLI/checkpoint behavior, and zero-writable-open preflight refusal. Exact positive Berlin identity, first apply, replay, rollback, receipt immutability, and the transaction race remain in the mandatory restricted gate. No public skip substitutes for that gate.

Fresh public verification under Node v22.23.2 at the reviewed candidate:

| Gate | Result |
| --- | --- |
| `npm ci` | 538 packages installed from the lockfile |
| `npm audit --omit=dev` | 0 production vulnerabilities |
| `npm run lint` | pass; zero warnings |
| `npm test` | 2,017 tests; 2,014 pass; 0 fail; 3 intentional skips |
| `npm run test:ui` | 25 files; 240/240 pass |
| `npm run build` | pass; 9 public routes pre-rendered |
| `npm run test:browser` | Chromium 35/35 pass |
| focused repair/CLI/identity/supersession/authority/canonical-merge/F-02 matrix | 679/679 pass |
| `git diff --check` | pass |

The first sandboxed full server run was unable to bind loopback ports and reported `EPERM` for listener-based tests. The authorized local-loopback rerun above passed with zero failures; this was an execution-environment restriction, not an application assertion failure.

The external mode-`0600` harness (SHA-256 `536fdab9183ba325b41598714eeb44e93e09405396f2d9af1fe64720e7edf073`) imported the real CLI, service, repair, generic audit, read-only adapter, and `createSqliteStorage` implementation. Against the retained exact evidence and disposable SQLite databases, its reviewed-candidate report (SHA-256 `c2a073092695187de77c29f00d9cb2749459c48ebd544fd3b613e93290544e3`) recorded:

- read-only preview with zero blockers and identical before/after logical digests;
- exactly four first-apply mutations, affecting only `crm_submission_supersessions`, `deal_hunter_crm_imports`, and `deal_hunter_cim_repair_manifests`;
- zero protected-table changes;
- zero-write `verified-prior-apply` replay with equal state digest;
- immutable receipt UPDATE and DELETE refusal with unchanged receipt digest;
- complete rollback after mutation 1, 2, 3, 4, and postconditions;
- intended blockers for deal-key, source-pointer, and canonical-import identity drift, with zero writes;
- current durable and configuration safety drift refusal with zero writes;
- zero writable opens for configuration and durable preflight mismatch;
- a post-preflight transaction safety race with one writable open, zero repair writes, zero relations, and zero receipts;
- `PRAGMA quick_check = ok`, zero foreign-key violations, a clean supersession audit, and unchanged generic CRM audit semantics (`ok: true`, `safeToReconcile: true`).

The retained report is external because it is tied to restricted evidence. Final exact-head restricted identity, artifact hashes, and hosted-CI links belong in the PR/handoff so another documentation commit does not invalidate the recorded final head.

### Privacy and independent review

The V2-delta privacy scan covered plain text plus Base64, hexadecimal, and URI encodings of 27 retained identity-bearing values. It found no nonpublic value or reversible encoding in Git. The only matches were the already approved public literal `costar:2436873` in two evidence classifications. The restricted report records `restrictedValuePublished: false`; public tests contain no Berlin loser deal-key preimage.

An independent read-only review covered the complete source-shape correction, fixed incident scope, Berlin proof, listing evidence behavior, real Annual Profit source, retained-import semantics, four-source authority, equivalent digest comparisons, lexical/config handoff, backup/runtime separation, zero-writable-open preflight, transaction recheck, state-independent replay, V2/V1 boundary, restricted harness authenticity/privacy, public/restricted coverage mapping, and unchanged supersession protections. It reviewed exact candidate `d350fc9b2588f0cdea4e4bc34c7f8abc620137ea`, ran 184/184 focused V2 tests, inspected the restricted proof, made no changes, and returned PASS with P0/P1/P2/P3 all zero.

These results authorize no production action. No production preview/apply, database access, reconciliation, provider transmission, merge, deployment, Stage 2 change, or automation change occurred. A later production operation still requires separate owner authorization, current operational quiescence checks, a freshly reviewed artifact, and the established production checkpoint gates.

## 2026-09-21 CLI apply-output privacy correction

The later UG-P7-01M recovery gate strengthened the restricted acceptance composition by invoking successful apply through the real operator CLI. That stronger gate exposed a P1 boundary defect: `runCrmDuplicateConsolidationCli` returned the service's rich internal apply result and `main()` serialized it to stdout, including internal postcondition row data. The previously retained acceptance remains valid historical evidence for the checks it actually ran, and its failed recovery package demonstrates the stronger gate stopped safely; its earlier CLI-output privacy conclusion is superseded here.

The correction is confined to `scripts/repair-crm-duplicate-consolidation.js` and its public CLI tests. Successful apply and `verified-prior-apply` replay now return only `status`, `mode`, `applied`, `mutationCount`, `manifestId`, `planChecksum`, and the three-field `integrity` object. The pure projector has no spread, fallback, raw/debug mode, or interpolated failure. It strictly validates status, mode, applied/mutation-count consistency, exact reviewed manifest/checksum binding, and successful integrity. Preview, service/storage internals, schema, transaction, receipt, fixed incident authority, confirmation, checkpoint, and four-write ledger are unchanged.

TDD evidence at code candidate `849d51b4a4e4a3e50cf527302e26afd20b3dbf75`:

- RED: successful synthetic first apply and replay exited normally but exposed `UG_P7_SYNTHETIC_RESTRICTED_SENTINEL_NOT_PRODUCTION` through stdout;
- GREEN: 202/202 focused repair/CLI tests passed with exact safe schemas, no plain/Base64/hex/URI sentinel in stdout or stderr, structural exclusion of an unknown nested internal property, strict malformed-result refusal, and exact manifest/checksum binding;
- independent read-only review returned PASS with P0/P1/P2/P3 all zero.

The independently reviewed external harness (mode `0600`, SHA-256 `d2b402837462dc05be5832af83945c90515f04262ab358a91c904ab49c2fb2ca`) used the actual CLI subprocess, repair service and contract, read-only SQLite adapter, `createSqliteStorage`, fixed incident constants, and retained evidence in disposable local databases. The machine-readable report (mode `0600`, SHA-256 `c8baf9f93cd44f2847d8049bbedafc927d2c566e1922bb41352b76135cefffdb`) passed with:

- exact four-row database-derived mutation ledger and zero protected-table changes;
- Berlin legacy import `opportunity_id` remaining `NULL`;
- real CLI replay returning `verified-prior-apply`, zero mutations, and an equal all-table digest;
- receipt UPDATE/DELETE refusal and unchanged digest;
- rollback after writes 1–4 and final postcondition failure, each with zero committed repair writes;
- intended deal-key, source-pointer, and canonical-import drift refusal with zero writes;
- configuration/durable/V1/incomplete-V2 preflight refusal plus a transaction-race refusal with zero committed repair writes;
- `quick_check = ok`, zero foreign-key violations, clean supersession audit, and unchanged generic audit (`ok: true`, `safeToReconcile: true`);
- zero restricted or reversibly encoded values in preview/apply/replay stdout or stderr, zero matches in new Git blobs, zero fixed-preimage matches in tracked Git, and zero report matches.

The retained raw evidence was reused locally; no new production capture or any production database access occurred. This verification authorizes no production preview/apply, merge, deployment, reconciliation, or transmission. Final exact-head full-suite, restricted-package, archive-readback, and hosted-CI identities are recorded in the PR/handoff after the documentation commit so this record does not recursively invalidate them.

## 2026-09-22 V3 row-authority implementation verification (pre-Task 11)

This addendum records the public and focused evidence available before the final exact-head restricted gate. It supersedes V2 as the current repair artifact contract without rewriting the historical V1/V2 results above. The approved Pooler/Berlin tuple, Berlin import CAS, four-source runtime-safety authority, checkpoint envelope, immutable receipt, and four-write ledger are unchanged. The V3 policy binds exactly `analytics_events` and `contact_rate_limit_events` as row-content exclusions; full schema and required-object inspection still includes both. Row inspection, authoritative digests/counts, protected-table row comparison, and row-level reference inventory cover all other application tables. Both excluded tables must exist; new tables default to row-authoritative. There is no runtime exclusion override.

The active repair version is `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3`, with plan `crm-duplicate-consolidation-plan-v3`, manifest `crm-duplicate-consolidation-manifest-v3`, namespace `crm-duplicate-consolidation:v3:`, and confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3`. Approval remains `crm-duplicate-consolidation-approval-v1`; checkpoint schema remains `crm-duplicate-consolidation-checkpoint-v1`. V1/V2 reviewed artifacts and confirmations refuse rather than silently upgrading. V3 uses `database.authorityLogicalDigest`, `database.authorityTotalRows`, and `authorityTableDigests`; `schema.digest` remains the complete all-table schema authority. The first exact apply is still two supersession inserts, one Berlin legacy-import CAS update, and one append-only receipt insert; exact verified replay writes nothing. The CLI's safe apply/replay stdout projection remains the closed status/mode/applied/mutationCount/manifestId/planChecksum/integrity allowlist, with no service-internal rows.

Sanitized production evidence motivating the correction recorded 137/105 `analytics_events`/`contact_rate_limit_events` rows in the immutable backup versus 140/107 live. The complete schema hash and fixed target raw-row hashes matched across backup and live; the two named operational row digests alone differed. The authorized production preview never ran. This is evidence of V2 row-authority granularity, not evidence of a completed V3 preview or apply. The corrected v126 checkpoint, backup, and snapshot are historical-only for V3. A fresh post-deploy checkpoint binding a new application-consistent backup, Fly snapshot, deployed release, and tooling SHA is required before any separately authorized production V3 preview.

Completed pre-Task 11 public/focused results under Node v22.23.2 include the Task 8 CLI file at 161/161 pass, its V3/version/privacy-focused run at 17/17 pass, and the permissioned full server suite at 2,107 pass, 0 fail, 3 skipped (2,110 total). After Task 9's explicit checked-in Berlin-digest/raw Annual Profit/unknown-period regression, its five-file focused suite passed 278/278; supporting generic-audit, supersession, and canonical-merge suites passed; and the permissioned full server suite passed 2,108, failed 0, skipped 3 (2,111 total). `npm run lint` and `git diff --check` passed in those task runs. Public synthetic fixtures intentionally refuse the positive fixed Berlin identity; these results do not substitute for exact-identity restricted acceptance. The earlier intermediate private Task 6/7 checks were not the final documentation-inclusive exact-head gate.

Mandatory restricted exact-evidence acceptance remains a subsequent release gate and is not claimed by this repository record. The final exact-head restricted harness, report, package, and archive identities remain outside Git for the Task 11 owner handoff or later separately authorized implementation PR metadata. That gate must separately prove real-CLI read-only preview before/after equality, first-apply four-write accounting, zero-write replay after controlled volatile growth, drift refusal, rollback, receipt immutability, SQLite/audit health, and privacy against retained exact evidence in disposable SQLite. This paragraph is a pending requirement, not an acceptance result.

No production access, preview, apply, deployment, backup, snapshot, reconciliation, provider send, or automation change is authorized by this documentation commit. Production sequencing remains separately authorized V3 deployment and fresh checkpoint, then read-only preview, independent owner review of the exact artifact, a separate explicit apply authorization, and post-apply verification. There is no ready-to-run production apply command or restricted preimage in this record.
