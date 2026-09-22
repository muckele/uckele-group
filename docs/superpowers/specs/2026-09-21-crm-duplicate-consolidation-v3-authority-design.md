# CRM Duplicate Consolidation V3 Row-Authority Design

**Date:** 2026-09-21
**Status:** Proposed written spec for owner review; no implementation or production authorization
**Starting code:** main at 005c410d8f66b51e353cd58e9b6f9a059b7a8eeb
**Production context:** Fly v126 runs V2; no duplicate-consolidation preview, apply, supersession relation, or receipt has occurred.

## Context and decision

The approved repair is still the fixed Pooler and Berlin duplicate incident described by the existing V1 design and corrected V2 implementation. V3 changes only the granularity of database **row-content authority**: rows in exactly analytics_events and contact_rate_limit_events do not determine the reviewed repair plan. Their schemas remain authoritative. Every other V2 incident, business-data, source, safety, checkpoint, transaction, and privacy guard remains in force.

This is an architectural spec, not an implementation plan. It authorizes no code change, production read, preview, apply, backup, snapshot, deployment, reconciliation, or send. The owner must review this written spec before an implementation plan is written.

## Production evidence

The authorized UG-P7-01Q-R2 operation stopped **before** its one permitted preview. A verified immutable post-deploy backup and a live read-only V2 inspection agreed on the complete schema digest, fixed Pooler and Berlin target-row digests, the Berlin legacy import, current repair state, four-source runtime-safety authority, and every incident-specific raw-row digest. Both inspections had no blockers and proved read-only, existing-file, query-only, consistent-transaction connections.

| Plan-bound fact | Live | Immutable backup |
| --- | --- | --- |
| Whole-database logical digest | 9df7162d5582fd941ebe2ce10441ecb83c3e6fb956eb0521a35734b07ffb459d | feccc5f8956b86d7a2bd91cce1a24e8dec42f1cdc9be1e8bbe0ceed48f2fefa6 |
| Complete schema digest | 7efec6c18e25a81f3dbe1d3db1929da1d93f5d662440a3de5454681090c98d42 | same |
| All-application-table row count | 20,151 | 20,146 |
| analytics_events rows | 140 | 137 |
| contact_rate_limit_events rows | 107 | 105 |

Those were the only differing table row digests; all fixed target raw-row digests matched. The evidence establishes a V2 authority-granularity conflict, not a failed preview or a production incident. It does not prove the source of each new row beyond the two identified operational tables. Replacing the backup alone would not solve the contract: normal traffic can change those rows again during preview, human review, or apply.

## Problem and goals

V2 constructs rowsByTable, tableDigests, database.logicalDigest, and database.totalRows from **every** application table. It also scans every TEXT column's rows for incident references. These values enter the checksummed plan. Backup reconstruction and the live BEGIN IMMEDIATE reinspection demand the same whole-database digest and plan checksum; postconditions and replay compare protected table digests. Consequently, ordinary telemetry or contact rate-limit writes invalidate repair authority despite not changing the incident.

V3 must:

1. Preserve the exact Pooler/Berlin pairs, separate canonical opportunities, positive identity predicates, owner/primary/import relationships, and four-row mutation ledger.
2. Preserve every V2 business/CRM/source/safety/schema guard except the stated two-table row-content authority rule.
3. Permit row insert, update, or delete activity in only analytics_events and contact_rate_limit_events across backup, preview, review, apply, postconditions, and replay.
4. Refuse row drift in every other application table, including unrelated business or operational tables.
5. Refuse schema drift in every table, including the two row-excluded tables.
6. Bind a closed, deterministic, checked-in policy into the V3 plan checksum. There is no runtime, CLI, environment, database-metadata, wildcard, regex, prefix, or inferred exclusion mechanism.
7. Retain distinct deployment, recovery checkpoint, preview, owner review, apply, and post-apply verification gates.

## Non-goals

V3 does not generalize duplicate consolidation or add pair selectors, cleanup modes, arbitrary SQL, Supabase parity, receipt migration, reconciliation, outbound automation, CRM audit redefinition, or weaker CRM writer guards. It does not change the fixed survivor decisions, Annual Profit source semantics, Berlin raw identity predicate, four-source runtime safety, immutable receipt, or exact mutation scope. No email, outbox, job, recommendation, source, CRM, CIM, opportunity, alias, score, or repair table is row-excluded. This spec does not authorize production preview or apply.

## Alternatives considered

**Repeated fresh checkpoints** are not the primary solution. They may temporarily align V2 digests, but ordinary telemetry and rate-limit writes can stale another backup before human review or apply.

**Maintenance-window shutdown of all writers** is not the selected authority model. It is operationally fragile, creates unnecessarily broad downtime, and conflicts with the deliberate preview-to-review-to-apply interval. It remains a separately authorized emergency operational option, not a substitute for sound repair authority.

**Incident-only row authority** would remove protections for unrelated but potentially relevant business, source, safety, and communication state. V3 retains whole-relevant-database authority instead.

**Configurable ignored tables** are rejected. Operator-supplied, environment, CLI, database, pattern, or category exclusions could change authority without changing reviewed code.

## Fixed incident and mutation boundary

The approval tuple stays fixed:

| Pair | Opportunity | Survivor | Superseded submission | Listing identity |
| --- | --- | --- | --- | --- |
| Pooler | opp_683681c2-bd49-4c46-be4f-6d969143d907 | daa9ea12-786f-4769-b702-d9309525c455 | b36a4b33-d35c-4e8d-b6c3-b6301030a92b | costar:2516010 |
| Berlin | opp_9b18427d-5fb5-4f92-be31-d92b810061b3 | 0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da | 8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3 | costar:2436873 |

Berlin legacy import 508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8 is the only import update: its submission moves from the Berlin superseded row to the survivor by CAS, while opportunity_id remains NULL. Pooler imports and all contact rows remain unchanged. The first apply still has exactly four changed rows: two crm_submission_supersessions inserts, that one Berlin import update, and one append-only deal_hunter_cim_repair_manifests receipt insert. Replay changes zero rows.

The V2-supported Pooler listing URL alone can establish costar:2516010 if no malformed or conflicting listing representation exists. Berlin retains its exact positive predicate, including fixed raw UTF-8 deal-key SHA-256 3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733, scalar sheet-0/csv/18 pointers, survivor alias corroboration, approved primary/owner state, and legacy/canonical import authority. The raw deal-key preimage stays outside Git and ordinary CI. Source authority remains metadata.dealHunter.raw["Annual Profit"]; its unknown period is not invented, and historical ttm_ebitda storage is not relabeled authoritative EBITDA.

## V3 version and artifact boundary

| Contract | V3 value |
| --- | --- |
| Repair type | crm-duplicate-consolidation |
| Approval schema | crm-duplicate-consolidation-approval-v1 |
| Checkpoint schema | crm-duplicate-consolidation-checkpoint-v1 |
| Plan schema | crm-duplicate-consolidation-plan-v3 |
| Manifest schema | crm-duplicate-consolidation-manifest-v3 |
| Repair version | UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3 |
| Confirmation | APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3 |
| Manifest namespace | crm-duplicate-consolidation:v3: |

The manifest ID remains the namespaced digest of the exact checked-in approval tuple; that tuple includes the V3 repair version, so its identity changes without changing pair membership. The receipt mode and database-level append-only protections remain the current duplicate-consolidation mode. There is no production V1 or V2 duplicate-consolidation receipt to migrate.

V3 artifact validation requires every V3 version field, exact manifest namespace, exact policy object below, canonical artifact bytes, correct plan checksum, fixed tuple, exact operator/checkpoint facts, and the existing four-source authority before constructing writable storage. V1 and V2 plans, manifests, confirmations, or artifacts without the V3 policy refuse; neither is upgraded or interpreted as V3. An unexpected old-version production receipt is a stop requiring separate owner review, not a migration path.

## Closed row-authority policy

The single checked-in immutable constant is the sorted array:

~~~json
["analytics_events", "contact_rate_limit_events"]
~~~

V3 binds this exact object inside the canonical checksummed plan:

~~~json
{
  "schema": "crm-duplicate-consolidation-row-authority-v1",
  "policy": "schema-bound-row-content-excluded",
  "excludedRowTables": [
    "analytics_events",
    "contact_rate_limit_events"
  ]
}
~~~

Call the plan field rowAuthority. Its validator checks exact keys, exact string values, exact two-element order, and equality to the compiled immutable constant; a recomputed checksum cannot legitimize a changed policy. There is no override or fallback. Both named tables must exist in the complete schema inventory. Every new or unknown table is authoritative by default and therefore subject to the row bound, full row digest, reference scan, and protected-table checks.

Current analytics_events holds telemetry id, created_at, event_name, path, referrer_host, UTM, and placement fields. Current contact_rate_limit_events holds id, bucket, and created_at. Their repository writers insert/prune event or bucket records; neither table owns submissions, opportunities, imports, aliases, CIM requests, communications, source authority, supersession relations, or repair receipts. Their row contents do not decide the two duplicates or safe repair. This is a finding about the current schemas and callers, not a permanent classification: a future code change assigning either table business authority must separately revise and review this policy.

## Schema authority and database-state shape

Schema inspection continues to enumerate **all** non-SQLite application tables. The existing complete schema digest remains canonicalJsonSha256 of the complete table schema inventory plus required-object inventory. Every table, including both row-excluded tables, contributes its name, CREATE TABLE SQL digest, table_info column details (cid, name, type, nullability, default, primary-key position), and existing required index/trigger checks. The two excluded tables must be present. A backup/live or reviewed/current schema difference in either excluded table refuses exactly as it does for any other table; no row exclusion is a schema exclusion. Existing unclassified relationship-like schema-column refusal continues across the complete schema.

Row-content inspection selects and hashes rows only for **authoritative tables**: all enumerated application tables minus the exact two policy names. It neither COUNTs nor SELECTs every excluded row to construct V3 authority. The existing 250,000-row inspection bound applies to the sum of authoritative rows only. Excluded rows do not affect that bound, the plan, or the plan checksum. There is no additional unbounded scan or new arbitrary limit.

The V3 inspection and plan use explicit names:

- database.authorityLogicalDigest: canonical digest of rowsByAuthoritativeTable;
- database.authorityTotalRows: sum of authoritative row counts;
- authorityTableDigests: a name-keyed rowCount/digest map for every authoritative table, with neither excluded table present;
- database.quickCheck and database.foreignKeyViolationCount: existing SQLite integrity outcomes;
- schema.digest: the complete, all-table schema digest.

Do not reuse V2's database.logicalDigest, database.totalRows, or tableDigests names with changed meanings. The V3 validator requires the new shape and rejects legacy fields. The all-table SQLite integrity checks continue to fail closed; the two current excluded schemas have no foreign-key ownership of the incident. A new table is never inferred to be volatile.

## Reference inventory

V2's crmDuplicateConsolidationReferenceInventory scans every TEXT column's rows and binds matchedRowCount, matchedRowsDigest, matchedIdentifiersDigest, classification, policies, and blockers into the plan. V3 retains that exact matching/classification behavior for **every authoritative table**. It derives incident tokens from the same approved identifiers and scoped authoritative submission/alias evidence.

The scanner does not load or scan rows of analytics_events or contact_rate_limit_events. It emits **no row-level reference-inventory entries** for those two tables, including their TEXT columns; their presence and column shapes are instead visible in the complete schema inventory and rowAuthority policy. No volatile row content, count, matched-row digest, matched-identifier digest, or positive-reference blocker enters the plan. An incident-like token in analytics path or rate-limit bucket therefore does not become repair row authority. The same token in any authoritative unclassified TEXT surface retains V2's positive-reference blocker. Unknown table schemas and columns still receive the existing complete schema check; unknown table rows remain authoritative and scanned.

## Plan and backup behavior

Apart from the explicitly replaced row-authority fields, the V3 checksummed plan binds the same repair type/version, approval tuple, actor/reason, release/tooling revision, recovery-checkpoint facts, complete schema digest, required objects, authoritative database digest/count and table digests, authoritative relationship inventory, reference identifiers, exact incident raw rows, safety state, complete four-source runtime-safety authority, current pair and Berlin import state, unchanged mutation-table digests, and exact four-row ledger. The two excluded tables contribute **schema authority only**.

The backup verifier retains V2's regular-file, stable-identity, SHA-256, sidecar refusal, in-memory query-only SQLite, checkpoint, and single-use verification capability checks. It reconstructs the **same V3 plan** from the immutable backup and uses the reviewed config authority only as external runtime facts, while reading durable safety rows from the backup. It compares plan checksum, authoritative database digest, complete schema digest, and the plan-bound fields. Different analytics or rate-limit rows in backup and live do not change those values. Any authoritative row or schema difference still refuses; there is no fuzzy match or operational-table category exception. A backup alone never proves current process configuration or global writer quiescence.

## Preview

Preview remains the default CLI mode and uses only an existing SQLite file opened read-only, fileMustExist, query_only, and one consistent read transaction. It emits a V3 canonical artifact and creates no repair receipt or business write. It retains exact checkpoint and operator-fact validation, fixed-pair predicates, blockers, and zero-mutation proof. No retry or automatic checkpoint replacement is introduced. Analytics/rate-limit row activity alone before or after preview does not change its V3 plan authority; all other relevant drift still does.

## Apply transaction

V3 remains SQLite-only; Supabase continues to refuse this repair. The CLI and service first reject wrong-version artifacts, policy, confirmation, checkpoint, actor/reason, release/tooling, manifest/checksum, and current config/safety authority before writable storage construction, as V2 does. The backup verification capability remains fresh, single-use, file-bound, and short-lived.

Inside BEGIN IMMEDIATE, V3 rebuilds the exact same authoritative inspection and checksummed plan against live SQLite. It compares the reviewed plan checksum, authoritative database digest, complete schema digest, exact raw target rows, pair/owner/primary/import state, reference inventory, unchanged mutation-table digests, current four-source safety, and all other V2 CAS conditions before the first repair write. The four sources remain global durable CIM outreach pause, durable cim-initial-outreach automation pause, disabled effective follow-ups, and disabled effective scheduler with their strict raw-environment representations. Existing active-writer and current Stage 2 blockers also remain. Changes only in the two excluded tables do not invalidate these comparisons. Any authoritative row, schema, target, source, identity, or safety drift refuses before mutation. The only SQL business writes remain the exact four approved rows, with the Berlin import's exact raw-digest and column CAS and the existing transaction rollback semantics.

## Postconditions and replay

The three approved mutation tables remain special, **not** volatile exclusions: crm_submission_supersessions, deal_hunter_crm_imports, and deal_hunter_cim_repair_manifests. Their approved changes, unchanged-other-row digests, exact receipt bytes, CAS, required triggers, and postconditions retain V2 protections.

After the first apply, V3 compares every **authoritative protected table** digest against the reviewed plan, excluding only the same three approved mutation tables from this generic protected-table loop. analytics_events and contact_rate_limit_events are absent from authorityTableDigests and thus from row-content equality checks. The complete schema digest and required-object inventory must still match after the transaction. These exclusions do not grant the repair permission to write those tables: the fixed SQL ledger contains no such statement, and real-adapter tests must prove exactly four changed business rows and zero repair-origin writes to the volatile tables.

Replay remains zero-write. Before returning verified-prior-apply it validates current four-source safety; independently recomputes and compares complete all-table schema authority (without trying to reuse a pre-apply plan against the already-applied mutation rows); byte-validates the immutable receipt and exact completed supersession/legacy-import state; and checks all current authoritative protected-table digests. The two volatile tables may grow or prune without invalidating replay. Drift in any authoritative protected table, schema, receipt, or completed incident state refuses. Receipt UPDATE and DELETE remain impossible under the existing mode-scoped triggers.

## Failure behavior

V3 refuses an unknown, missing, reordered, or modified rowAuthority object; a third excluded table; either excluded table missing from expected schema; schema drift in either excluded table; any authoritative row or target drift; source/identity/ownership drift; current runtime-safety drift; checkpoint or backup mismatch; V1/V2 artifacts or confirmations; and incomplete/corrupt V3 authority. Validation of untrusted artifacts and CLI arguments must fail before writable storage construction. There is no compatibility fallback to V2 and no weakened manual override. Any ambiguous apply result remains a stop, not an automatic retry.

## Required test matrix

These are **42 distinct required scenarios**, grouped by boundary. Ordinary CI uses synthetic identity evidence; exact positive Berlin evidence remains external.

### Pure contracts (1–7)

1. The V3 policy contains exactly analytics_events and contact_rate_limit_events.
2. Its ordering and canonical checksum representation are deterministic.
3. A third exclusion refuses even with a recomputed plan checksum.
4. A V1 or V2 artifact refuses before writable storage opens.
5. A V1 or V2 confirmation refuses before writable storage opens.
6. A V3 artifact missing rowAuthority refuses.
7. A modified or malformed V3 policy refuses.

### Database and schema authority (8–16)

8. Identical live and backup databases produce the same V3 authority digest and checksum.
9. Analytics-only row growth leaves V3 authority unchanged.
10. Rate-limit-only row growth leaves V3 authority unchanged.
11. Growth in both excluded tables leaves V3 authority unchanged.
12. A changed row in a representative authoritative table changes authority and refuses.
13. A newly added row in an unrelated authoritative table refuses.
14. An analytics_events schema change refuses.
15. A contact_rate_limit_events schema change refuses.
16. A new application table defaults to authoritative and changes V3 plan semantics.

### Reference inventory (17–20)

17. Volatile-table row changes leave reference inventory unchanged.
18. Incident-like text in analytics path or contact rate-limit bucket does not become row authority.
19. The same token in an authoritative unclassified TEXT column produces the existing blocker.
20. Existing classified business-reference paths retain their V2 classifications and digests.

### Backup and reviewed interval (21–24)

21. Backup/live analytics-only row differences reproduce the reviewed V3 plan.
22. Backup/live rate-limit-only row differences reproduce it.
23. Any authoritative-table row difference makes backup reconstruction refuse.
24. Any schema difference, including in an excluded table, makes it refuse.

### Apply (25–30)

25. Volatile writes between backup and preview do not invalidate V3 authority.
26. Volatile writes between preview and apply do not invalidate apply.
27. An authoritative write between preview and apply refuses before mutation.
28. Target-row drift refuses before mutation.
29. Runtime-safety drift refuses before mutation.
30. Exact first apply still commits only four approved rows, with no volatile-table repair write.

### Postconditions and replay (31–35)

31. Volatile activity in the reviewed interval does not fail protected-table postconditions.
32. Authoritative protected-table drift still rolls back or refuses.
33. Replay after volatile growth succeeds with zero writes.
34. Replay after authoritative-table drift refuses with zero writes.
35. Receipt UPDATE and DELETE remain impossible.

### Regression (36–42)

36. Pooler URL-only listing evidence remains accepted.
37. Berlin's exact positive identity predicate remains required.
38. Raw Annual Profit source semantics and unknown period remain unchanged.
39. All four runtime-safety sources and lexical/config checks remain unchanged.
40. Generic CRM integrity audit semantics remain unchanged.
41. Supersession audit remains clean.
42. Supabase remains fail closed.

Tests must additionally assert missing excluded tables refuse, authoritative row bound behavior, old/new plan-field shape, exact artifact/CLI namespace, schema preservation in replay, and zero mutable receipt behavior. These assertions can share the 42 scenarios but cannot be skipped.

## Restricted exact-evidence acceptance

A future implementation must rerun the mandatory external restricted gate against the final code and retained production identity on **disposable local SQLite**, without placing raw preimages in Git, ordinary CI, logs, or reviewed artifacts. It must prove the fixed Pooler/Berlin incident, synthetic growth in each excluded table without V3 checksum change, exact four-row first apply, zero-write replay after volatile growth, complete rollback, unchanged audits and SQLite integrity, and plain/Base64/hex/URI privacy cleanliness. It must also preserve all V2 exact-source and four-source safety tests. No digest override, cryptographic mock, or descriptor substitution is allowed. Hosted CI alone does not replace this gate.

## Production rollout gates

No production duplicate-consolidation receipt currently exists; V3 needs no V2 receipt migration. V3 nevertheless changes executable repair semantics and tooling revision. The corrected v126 checkpoint and its backup/snapshot are **historical-only for V3** and cannot authorize a V3 preview or apply.

Only after implementation, independent review, merge, and exact-revision deployment may an owner separately authorize a new post-deploy recovery checkpoint with a new application-consistent backup, Fly snapshot, deployed release, and tooling SHA. Then the gates restart: separately authorized read-only V3 preview, exact-artifact independent review, separately authorized V3 apply, and post-apply verification. No stage is implied by this spec or by a successful earlier stage.

## Open questions

None required before implementation planning. The excluded tables, plan shape, schema and reference treatment, version boundary, backup/preview/apply/replay behavior, safety contract, and production gate separation are fixed above. The next decision is owner review of this written spec; writing an implementation plan is not authorized yet.
