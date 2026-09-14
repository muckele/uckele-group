# Deal Hunter CRM integrity F-02 Repair3

Repair3 is the separately versioned `UG-P6-CLOSURE-F02-REPAIR3` successor at the reviewed main baseline `39d23f1d50c138acf24f8603a2f258852e3f116e` (Fly v123). This is code and local tests only. No production dry-run, apply, reconciliation, deployment, merge, source mutation, automation change, or outbound action is authorized by this implementation. It does not establish F-02 closure or MVP acceptance.

## Why a successor is necessary

V1 required a direct collision-submission owner even though its pinned raw row had a NULL direct owner and the correct metadata owner. Repair2 corrected that relationship predicate, retaining conflict, wrong-owner, and missing-owner refusals. It also reviewed the legitimate increase from 475 to 476 opportunities and retained strict whole-row fingerprints.

Repair2 then safely refused at v123 solely because two non-mutated context opportunity hashes changed. Historical diagnosis established that each row changed only in `updated_at`. The September 14 Daily Digest (`daily-deal-hunter-email:2026-09-14`, started `2026-09-14T15:00:43.325Z`) invoked score refresh and full-backfill review. Exact-alias identity resolution called opportunity upsert; `opportunityRecord()` supplied a fresh timestamp, which SQLite persisted even when all meaningful values were unchanged. Score fingerprint comparison independently skipped unchanged score writes. The same timestamp-refresh pattern recurred across days. Repinning raw hashes would therefore predictably refuse again. The authenticated normal review GET remains read-only after F-01; the full-backfill workflow explains this separate drift.

Repair3 preserves v1, Repair2, the generic CRM integrity audit, and `server/services/dealHunter.js` byte-for-byte. It reuses the unchanged v1 raw SHA-256 and deterministic checksum helpers and the unchanged backup verifier and generic audit. Its service and CLI are versioned siblings of Repair2; there is no generic repair framework or canonicalization change.

## Historical projection authority

The bounded [diagnostic attestation](../test/fixtures/dealHunterCrmIntegrityF02Repair3DiagnosticAttestation.json) records read-only historical evidence from exactly two rows in the retained verified bundles:

- `/data/backups/backup-2026-09-14T10-38-34-370Z-90d965dd`, manifest ID `90d965dd-1f0a-44e6-bd03-baa7c3a34455`, database SHA-256 `805c44efa56c55650b00b2cdb688312a8b0f47f85731466b813fff1ffcf2f04c`.
- `/data/backups/backup-2026-09-14T17-18-02-783Z-6ae4b1f6`, manifest ID `6ae4b1f6-b384-4770-9760-04921532404c`, database SHA-256 `967fb311cab35ae3e6143fe4e2d6e4afd391dcfe9beade9c96832d16167d63a1`.

Both bundles were verified current-format manifest v2 with successful SQLite quick checks. The original RED tests used explicitly synthetic SQLite rows matching the diagnosed column order, IDs, and timestamp-change shape. They characterized Repair2 volatility and failed because Repair3 did not yet exist; those synthetic tests did not validate actual historical row bytes.

After implementation, a separate narrow historical validation streamed the actual four authorized rows (the two named IDs from each named backup) in memory through the implemented v1/Repair2 raw fingerprint helpers and Repair3 context projection helpers. Each backup connection used `readonly: true`, `fileMustExist: true`, and `PRAGMA query_only = ON`. This validation passed: exact `SELECT *` property order matched, only `updated_at` differed, raw metadata bytes were equal, historical raw hashes matched Repair2 authority, later raw hashes differed, and both versions produced their pinned Repair3 projection hash. Raw rows were not retained (`rawRowsRetained: false`).

The hash-level attestation records that post-implementation validation separately from synthetic RED. Committed tests assert its bounded scope, helper identities, results, deterministic checksum, and binding to the immutable contract. They do not re-query backups or reconstruct historical raw rows from hashes. No raw production rows or unrelated business data are committed.

| Context | Historical raw SHA-256 | Later raw SHA-256 | Same projection SHA-256 for both observations |
| --- | --- | --- | --- |
| Collision `opp_683681c2-bd49-4c46-be4f-6d969143d907` | `a538b0ecd23b17a00a20bd6499de6ec922ec7aaeed4311aa84521c5eb668743e` | `c00302dcd3436861149419a6f3df655c95d984353c40879b959851466ccdabd3` | `e1f8e123556493101a6c9407d3df40c9034a181917c60cc0b1dd27d68581add3` |
| Brake `opp_5ae93328-11e3-49de-b3f1-d28d4e76242e` | `7049798420b1a7bb5a6f027a5cbed6a707fa25a96599a754b56ddea47d3053e8` | `f37f3fb4f97ae2da490a9842a19b845116896118d9ad8e8d6cc6ff0322509d63` | `7be900911fb0192da9d89fd1bc089eca774a8a735b4fd3a6c37661807248b3e0` |

The collision timestamp advanced from `2026-09-13T15:00:39.347Z` to `2026-09-14T15:00:49.165Z`; Brake advanced from `2026-09-13T19:29:59.123Z` to `2026-09-14T15:00:49.563Z`. Each changed-fields set is exactly `["updated_at"]`. Attestation checksum: `f8eb391f4dcefc1d3c9cae70618e3bb36a949d30c368b6cbb78b1efcd0209802`.

## Projection boundary

`excluded field: updated_at ONLY`

Only `collisionOpportunity` and `reviewedUnrelatedOpportunity` use context projection authority. The helper clones the raw SQLite `SELECT *` object, deletes exactly its top-level `updated_at`, then hashes `JSON.stringify(projection)` with SHA-256. SQLite schema-column insertion order is preserved. Every other top-level column remains protected, including any future column returned by `SELECT *`.

The currently protected columns, in serialization order, are `opportunity_id`, `created_at`, `canonical_name`, `canonical_recipient`, `canonical_location`, `primary_submission_id`, `identity_version`, `status`, and `metadata`. The entire raw serialized metadata string remains byte-sensitive: it is never parsed or recanonicalized for fingerprinting. Listing/source identity, last observed deal key, last observed listing URL, JSON whitespace, and nested timestamps remain protected.

The seven other authority rows retain their exact Repair2 raw `SELECT *` SHA-256 values: legacy collision import, retained URL import, collision submission, backlink opportunity, backlink import, backlink submission, and managed-name submission. This includes all three mutation targets. No runtime flag selects rows, ignored fields, projection behavior, fingerprints, counts, or mutation values.

## Exact mutation boundary

1. `deal_hunter_crm_imports`, ID `cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31`, field `opportunity_id`: `opp_683681c2-bd49-4c46-be4f-6d969143d907` → `NULL`.
2. `contact_submissions`, ID `1245f55a-9496-4628-9cbe-d23e53b791a1`, field `deal_hunter_opportunity_id`: `NULL` → `opp_repair_6b75b5d5c825431d2bea921450f50c37`.
3. `contact_submissions`, ID `8e910798-9ac4-4d10-9c0f-9402feb9403a`, field `company`: `Profitable Senior Independence Support With Virtual Family Connection For Sale` → `Lawn And Landscape Maintenance Company For Sale`.

`collision submission mutation: NONE`

Collision submission `daa9ea12-786f-4769-b702-d9309525c455` remains unchanged. There is no fourth mutation. Neither context opportunity is updated, nor are opportunity primaries, metadata, aliases, identities, scores, source observations, identity exceptions, tombstones, or reconciliation state. No outbound action is performed.

## Preserved safety architecture

The exact generic-audit preflight remains 32 imports, 476 opportunities, 30 audited submissions, one ownership collision, one managed-name mismatch, one backlink mismatch, zero duplicate primaries, identity mismatches, or active tombstones, `safeToReconcile: false`, and `ok: false`. After the three mutations, the same totals must remain, all violation counts must be zero, and both booleans must be true. Those booleans do not authorize reconciliation.

The exact collision claimant set, primary submission, direct-or-metadata owner with no conflict, backlink relationships, managed-name authority, and Brake name/listing identity/null-primary/zero-import relationships are unchanged. All immutable IDs and before/after values are fixed in the Repair3 contract.

Dry-run opens only an existing SQLite file read-only, enables and verifies `query_only`, and does not initialize storage. Apply requires an exact reviewed plan checksum, approval manifest, execution identity, confirmation, and verified current-format SQLite backup created no earlier than the reviewed preflight. It validates backup bytes against the verified manifest, rejects sidecars and foreign-key violations, and independently reproduces the reviewed snapshot.

The writable connection enables foreign keys before `BEGIN IMMEDIATE`, repeats the entire preflight inside the transaction, performs three one-row compare-and-set updates, verifies the exact clean generic audit and all-table masked logical digest, checks foreign keys, and commits. Every failure rolls back. A repeated apply on the exact corrected state performs zero writes. Receipts retain actual raw before/after row hashes and a deterministic checksum.

The context projection applies only to incident authority comparisons. The all-table logical digest still protects `updated_at` on both context rows. If a context timestamp advances after a reviewed dry-run, the old manifest and backup cannot be applied: the current snapshot must be reviewed again. This preserves snapshot reproduction and stale-approval refusal while allowing a fresh dry-run to accept historically proven timestamp-only context drift.

## Versioned future operator interface

Repair3 uses incident `UG-P6-CLOSURE-F02-REPAIR3`, confirmation `APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02-REPAIR3`, plan schema `deal-hunter-crm-integrity-f02-repair3-plan-v1`, approval schema `deal-hunter-crm-integrity-f02-repair3-approval-v1`, and receipt schema `deal-hunter-crm-integrity-f02-repair3-receipt-v1`. Repair2 manifests, receipts, and confirmation do not grant Repair3 authority.

Only after separately authorized deployment and production inspection, a future dry-run has this command shape:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02-repair3.js \
  --actor "APPROVED OPERATOR" \
  --reason "OWNER-APPROVED REASON OF AT LEAST TWENTY CHARACTERS" \
  --execution-release "EXACT DEPLOYED RELEASE" \
  --tooling-revision "EXACT_DEPLOYED_40_CHARACTER_GIT_REVISION"
```

Retain and independently review that output. A later separately authorized apply additionally requires `--apply`, `--expected-plan-checksum`, `--reviewed-manifest`, `--backup`, and the exact `--confirm APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02-REPAIR3`. `--prior-receipt` can distinguish verified prior execution from independently satisfied state. Any unreviewed non-timestamp authority drift or count/relationship drift requires diagnosis; do not edit authority to force acceptance.

## Local verification scope

The Repair3 tests begin with Repair2 volatility characterization and RED missing-projection behavior, then exercise both context projections, every protected top-level field, nested metadata identity, all seven strict raw guards, the complete refusal matrix, exact three-cell apply, all-table preservation, backup verification and reproduction, CAS and postcondition rollback, final FK rollback, manifest tampering, execution identity, provider checks, zero-write repeats, and the versioned CLI. Regression tests cover historical repair tools, generic audit, backups, reconciliation safety, and canonical opportunities. Full repository and browser gates are reported separately by the controller before commit and PR creation.
