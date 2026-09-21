# Confirmed CRM Duplicate Consolidation Design

**Date:** 2026-09-17

**Status:** Design complete; owner approval required before an implementation plan, runtime code, migration, deployment, preview execution, or apply

**Design version:** `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`

**Repository and production baseline:** Git `cec88c5a37a5dc433896ee5fd737d606691a3f31`, Fly release `v125`, SQLite `/data/uckele-group.sqlite`

## 1. Purpose and hard boundary

Design the smallest durable, auditable consolidation of exactly two confirmed historical CRM duplicate pairs. The design must leave one active CRM representation per canonical opportunity, preserve every original row and its truthful historical relationships, prevent the losing row from independently authorizing future work, and keep Pooler and Berlin as distinct canonical opportunities.

This document is design and read-only dry-run planning only. No cleanup, reconciliation, repair, source change, score backfill, identity resolution, CIM or broker send, follow-up transmission, Stage 2 activation, automation change, deployment, or production business-data mutation is authorized or performed.

The two repair units are:

| Pair | Canonical opportunity | Proposed survivor | Proposed superseded row | Retained listing identity |
|---|---|---|---|---|
| Pooler, Georgia | `opp_683681c2-bd49-4c46-be4f-6d969143d907` | `daa9ea12-786f-4769-b702-d9309525c455` | `b36a4b33-d35c-4e8d-b6c3-b6301030a92b` | `costar:2516010` |
| Berlin Township, New Jersey | `opp_9b18427d-5fb5-4f92-be31-d92b810061b3` | `0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da` | `8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3` | `costar:2436873` |

Pooler and Berlin must never be merged with each other by this repair, by a duplicate-report projection, or by transitive closure.

## 2. Evidence basis and current-state verdict

The production inventory was generated at `2026-09-17T20:04:18.505Z` and its identity/alias subset was re-read at `2026-09-17T20:13:35.146Z` through a SQLite connection opened with `readonly: true`, `fileMustExist: true`, and `PRAGMA query_only = ON`. The inventory omitted contact fields, message bodies, raw metadata objects, document names and paths, credentials, secrets, and unrelated rows. A schema-derived scan checked every application table and text column for the four submission IDs.

The generic CRM audit was rerun read-only at `2026-09-17T20:05:58.424Z`:

- `ok: true`;
- `safeToReconcile: true`;
- imports `32`, opportunities `482`, audited submissions `30`;
- ownership collisions, duplicate primaries, identity mismatches, name mismatches, active tombstones, and missing links: all `0`.

The approved recovery artifacts still exist:

- application backup `/data/backups/backup-2026-09-17T17-48-01-242Z-5ead31fc`, manifest `5ead31fc-fba2-40d8-9a42-2f8c91c16c93`, database SHA-256 `66f816e3e9b5162810d440c51934c83783ee2dc3635c6b50009122eda33a0087`, manifest v2, SQLite provider, backup `quick_check = ok`, and zero backup foreign-key violations;
- Fly snapshot `vs_l8M4RX4qL8wU9zJZBPJA51J`, status `created`, created `2026-09-17T17:50:36Z`, digest `ef487503683696ceabc9d0a040c02fd66a724e1300ac2ed34e511cff230d5fe3`.

There is no material drift from the prior diagnosis. Both canonical opportunities remain active, both expected survivors remain their canonical primaries, both losing rows remain active-looking but unowned, historical email/activity state remains split, and only the Berlin loser retains an operational CRM-import claim that requires reparenting.

## 3. Verified four-record inventory

### 3.1 Pooler pair

Both rows resolve to the same public listing identity and have identical financial observations and broker-identity fingerprints.

| Field | Survivor candidate `daa9…c455` | Superseded candidate `b36a…a92b` |
|---|---|---|
| Status | `review` | `review` |
| Created | `2026-06-16T17:15:06.598Z` | `2026-07-22T15:00:21.834Z` |
| Updated | `2026-08-14T19:48:38.951Z` | `2026-08-12T15:00:37.008Z` |
| Direct `deal_hunter_opportunity_id` | `NULL` | `NULL` |
| Metadata owner | `opp_683681c2-bd49-4c46-be4f-6d969143d907` | `NULL` |
| Canonical primary | yes | no |
| Listing identity | `costar:2516010` | `costar:2516010` |
| Listing URL | `https://www.bizbuysell.com/business-opportunity/20-year-hvac-company-w-strong-earnings-and-track-record/2516010/` | same |
| Listing URL SHA-256 | `1f85a5222bb35fdff5a9725b4e81d31aee3ce8b383f7dd3e9d08e321f011cd6d` | same |
| Source ID / mode | `sheet-0` / `csv` | `sheet-0` / `csv` |
| Historical external row ID | `107` | `105` |
| Current source observation | `sheet-row:178`, observed `2026-06-10` | represented through the same canonical opportunity |
| Asking price | `$1,580,000` | `$1,580,000` |
| Revenue | `$3,535,760` | `$3,535,760` |
| Stored `ttm_ebitda` value | `$535,397` | `$535,397` |
| Original source label/value | `Annual Profit` / `$535,397` | `Annual Profit` / `$535,397` |
| Financial period | unknown | unknown |
| Broker identity fingerprint | `45d1b07ba49c3a76ca22e75cd2f54e31c27ed5f386ff8aa4c24a9a1b4df697e6` | same |
| Submission deal key | URL listing key for `2516010`; SHA-256 `13b31f675b161e075b70528d7ea5b53100d087d6fae2ff7e9cdb727c851131c4` | same |
| Listing aliases | 2, both normalize to `costar:2516010`; SHA-256 `1f85a5222bb35fdff5a9725b4e81d31aee3ce8b383f7dd3e9d08e321f011cd6d`, `9a334a060039d8ad73f610d0b62a1ca5c64ce67cdc65f955b6ed3ad323a4a0b5` | 0 |
| Identity aliases | 2, both normalize to `costar:2516010`; SHA-256 `5edf4f9deec12d2c610e9bfbd50d21a594ed8e923b099b9181bfe40ef557de73`, `a1717e7061510bee4a4b5ced857a903f9b4f9134a1aa22739c06847696bbd5e2` | 0 |
| Deal-key aliases | 1; SHA-256 `64e384b693ac3993a92f4cf3b99b982cde286f40f5a253423ec8938cfc076436` | 0 |
| Priority | `urgent` | `urgent` |
| `next_action_at` | `2026-06-17T17:15:06.598Z` | `2026-07-23T15:00:21.834Z` |
| `follow_up_state` | `needs-response` | `needs-response` |
| Acquisition-command metadata | absent | absent |
| Diligence metadata | absent | absent |
| Nonempty scalar notes field / activity note events | 1 / 0 | 1 / 0 |
| Generated note present | yes | yes |

Pooler relationship state:

| Relationship | Survivor | Loser | Current interpretation |
|---|---:|---:|---|
| CRM activity events | 27 | 40 | Historical provenance is split and truthful |
| Legacy email events | 9 | 21 | Historical provider evidence is split; retain on origin |
| Unified `crm_communications` | 0 | 0 | Nothing to reparent |
| CRM outbox | 0 | 0 | No send authority to move |
| CIM requests | 2 | 0 | Both survivor requests are `sent`, provider accepted, and follow-up `completed` after three follow-ups |
| Follow-up recommendations | 2 | 0 | One survivor recommendation is superseded; one is still `current` but expired in August |
| CRM import claims | 2 | 0 | Both already identify the survivor; one is the preserved legacy claim with `opportunity_id = NULL` |
| Reconciliation items | 0 | 0 | None |
| Secure upload requests/documents | 0 / 0 | 0 / 0 | None |
| Dispositions | 0 | 0 | None |
| Prospect discoveries/cleanup jobs | 0 / 0 | 0 / 0 | None |
| Embedded scheduled-job references | 8 | 19 | Historical job evidence; leave unchanged |
| Repair-manifest references | 1 | 1 | Same applied historical CIM identity-repair receipt; leave unchanged |

Exact Pooler operational IDs:

- CIM requests `b272125b030c6d097808fa82126b6afa0799fda456fc3465be51a0f0cea7a52e` and `aba23259c8a36685199482500aff468493221c0ff844966c2f6b9c148d72ad01`: each `status = sent`, `request_state = provider_accepted`, `delivery_state = accepted`, `follow_up_state = completed`, `follow_up_count = 3`, and no next follow-up;
- recommendations `49e8541d-3463-44e9-b032-02563b47317f` (`superseded`) and `a169ba9c-6b96-41f1-a18b-5c8521ebdc54` (`current`, expired `2026-08-16T03:30:00.000Z`);
- CRM imports `cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31` (`submission_id = daa9…c455`, `opportunity_id = NULL`) and `fa231f927904b40a3ef6fd762f37b7830e9aab92c013d39ed740f51e3c84bfd0` (`submission_id = daa9…c455`, canonical opportunity set).

### 3.2 Berlin pair

Both rows carry identical financial observations and broker-identity fingerprints. The survivor has the current listing aliases and canonical ownership; the older loser lacks a listing URL but its durable fingerprint deal key, broker fingerprint, financial tuple, geography, and later canonical evidence establish the confirmed duplicate relationship.

| Field | Survivor candidate `0f5f…d1da` | Superseded candidate `8cbd…afd3` |
|---|---|---|
| Status | `review` | `review` |
| Created | `2026-07-22T15:00:21.819Z` | `2026-07-21T15:00:37.569Z` |
| Updated | `2026-08-14T19:48:38.945Z` | `2026-07-21T15:00:37.569Z` |
| Direct `deal_hunter_opportunity_id` | `NULL` | `NULL` |
| Metadata owner | `opp_9b18427d-5fb5-4f92-be31-d92b810061b3` | `NULL` |
| Canonical primary | yes | no |
| Listing identity | `costar:2436873` | no stored URL; confirmed by fingerprint/source evidence |
| Retained listing URL | `https://www.bizbuysell.com/business-opportunity/20-year-hvac-company-w-strong-earnings-and-track-record/2436873/` | absent on the historical row |
| Survivor URL SHA-256 | `53366948f80dbdbd817549cb048d5712ae89af0d9a591cd805067b16043a3049` | SHA-256 of empty value |
| Source ID / mode | `sheet-0` / `csv`, plus Deal OS source evidence | `sheet-0` / `csv` |
| Historical external row ID | `44` | `18` |
| Current source observation | `sheet-row:115`, observed `2026-07-14` | represented through the same canonical opportunity |
| Asking price | `$1,400,000` | `$1,400,000` |
| Revenue | `$3,535,760` | `$3,535,760` |
| Stored `ttm_ebitda` value | `$490,070` | `$490,070` |
| Original source label/value | `Annual Profit` / `$490,070` | `Annual Profit` / `$490,070` |
| Financial period | unknown | unknown |
| Broker identity fingerprint | `5a8e8bf6033551dd356ad234f1d21d717c43ce861ce2a0652302c6245cda8a62` | same |
| Submission deal key | URL listing key for `2436873`; SHA-256 `672effefb48b1156797cd5b5a2ef7a800dfb31bdf0c05cf7ff204c2b1b4b29b3` | fingerprint key for the Berlin financial/geography tuple; SHA-256 `3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733` |
| Listing aliases | 2, both normalize to `costar:2436873`; SHA-256 `53366948f80dbdbd817549cb048d5712ae89af0d9a591cd805067b16043a3049`, `c336313932c81ebd81b387f08520d4cf4d7bb11e5385ad335060248b40a568ba` | 0 |
| Identity aliases | 2, both normalize to `costar:2436873`; SHA-256 `56023b04ddcfbc101252562237892651ef36f006b6841cb2f3007d494b3cbcdd`, `50794bf1a6386f04aec104c4b886fa2bc06dc172a4bd54b60ad597d78bfda345` | 0 |
| Deal-key aliases | 2; SHA-256 `3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733`, `284ce8817c1b5b826c13b3d8bd815900a9964e7f04763b5ff83da8fe865c5d2e` | 0 |
| Priority | `urgent` | `urgent` |
| `next_action_at` | `2026-07-23T15:00:21.819Z` | `2026-07-22T15:00:37.569Z` |
| `follow_up_state` | `needs-response` | `needs-response` |
| Acquisition-command metadata | absent | absent |
| Diligence metadata | absent | absent |
| Nonempty scalar notes field / activity note events | 1 / 0 | 1 / 0 |
| Generated note present | yes | yes |

Berlin relationship state:

| Relationship | Survivor | Loser | Current interpretation |
|---|---:|---:|---|
| CRM activity events | 27 | 7 | Historical provenance is split and truthful |
| Legacy email events | 0 | 6 | All Berlin legacy email evidence is on the loser; retain on origin and read through |
| Unified `crm_communications` | 0 | 0 | Nothing to reparent |
| CRM outbox | 0 | 0 | No send authority to move |
| CIM requests | 1 | 0 | Survivor request is `sent`, provider accepted, follow-up `completed` after three follow-ups |
| Follow-up recommendations | 0 | 0 | None |
| CRM import claims | 1 | 1 | Loser holds legacy import `508bc…ea8`; survivor holds canonical import `4e207…7ad` |
| Reconciliation items | 0 | 0 | None |
| Secure upload requests/documents | 0 / 0 | 0 / 0 | None |
| Dispositions | 0 | 0 | None |
| Prospect discoveries/cleanup jobs | 0 / 0 | 0 / 0 | None |
| Embedded scheduled-job references | 20 | 1 | Historical job evidence; leave unchanged |
| Repair-manifest references | 1 | 0 | Historical receipt remains on the survivor only |

Exact Berlin operational IDs:

- CIM request `42fefa5e5de8bba6676bf97ccb49a2c5364a469dc6da57b4af6ff9087141bede`: `status = sent`, `request_state = provider_accepted`, `delivery_state = accepted`, `follow_up_state = completed`, `follow_up_count = 3`, and no next follow-up;
- CRM import `4e2075ca935de95f09a80bdcdc51ac513c9ab5864f384d20f7ad123f139357ad` is survivor-bound with the canonical opportunity set;
- CRM import `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8` is loser-bound with `opportunity_id = NULL`; this is the single operational relationship proposed for reparenting.

### 3.3 Other discovered references

The schema-derived scan additionally found six `admin_audit_events.path` references, one embedded submission reference in `crm_activity_events.metadata`, 27 scheduled-job metadata references across the four rows, and one historical repair manifest that mentions three of the four rows. These are immutable or historical evidence, not active ownership. They remain unchanged and are included in the future preview's classified relationship inventory and digest.

No references were found in `crm_communications`, `crm_email_outbox`, secure documents, secure upload requests, dispositions, reconciliation items, prospect discoveries, or secure-document cleanup jobs.

## 4. Survivor recommendations

### 4.1 Pooler

Recommend `daa9ea12-786f-4769-b702-d9309525c455` as survivor and `b36a4b33-d35c-4e8d-b6c3-b6301030a92b` as superseded.

Confidence: **high**.

The survivor is the current primary of the active canonical opportunity, carries the correct metadata owner, contains the current alias/source aggregation, owns both CRM-import claims, owns both completed CIM request histories, and is already the authority selected by the PR #19 canonical-primary path. Keeping it minimizes mutation. Selecting the loser would require moving canonical primary/ownership, two import claims, two CIM requests, recommendations, and more authority state, while making the canonical record less complete.

A destructive "keep only the survivor row" operation would lose the loser's 40 activity events, 21 email events, 19 scheduled-job references, note, and historical timestamps. A destructive "keep only the loser row" operation would additionally discard or rewrite the survivor's canonical ownership, 27 activity events, 9 email events, two CIM requests, two recommendations, two import claims, eight scheduled-job references, and current alias/source evidence. The recommended relation retains both sides, so neither loss occurs.

### 4.2 Berlin

Recommend `0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da` as survivor and `8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3` as superseded.

Confidence: **high**.

The survivor is the current primary, carries the metadata owner, owns current listing and identity aliases, aggregates Sheet and Deal OS evidence, owns the completed CIM request, and owns the canonical CRM-import claim. The loser contributes historical activity, email evidence, a generated note, and one legacy import claim, all of which can be preserved without making it active. Selecting the loser would require reversing current canonical authority and moving substantially more state.

A destructive "keep only the survivor row" operation would lose the loser's seven activity events, six email events, legacy import claim, scheduled-job reference, note, and historical timestamps. A destructive "keep only the loser row" operation would discard or rewrite the survivor's canonical ownership, 27 activity events, completed CIM request, canonical import, 20 scheduled-job references, note, and current alias/source evidence. The recommended relation preserves both histories and reparents only the one operational legacy import claim.

No current fact makes either recommended survivor unsafe. Owner approval is still required for the exact two survivor/loser tuples and for the explicit decision to leave survivor workflow state unchanged.

## 5. Architecture alternatives

### 5.1 Approach A — dedicated durable supersession relation — recommended

Add one explicit `crm_submission_supersessions` table. Each active row declares one historical CRM submission superseded by one surviving submission under one canonical opportunity and one reviewed repair manifest. Ordinary active projections exclude the loser; direct reads retain it and resolve its survivor; combined timelines read through without rewriting historical rows; writers refuse a loser with a typed blocker.

This is the smallest approach that provides relational uniqueness, deletion restrictions, cycle prevention, auditable owner approval, safe future matching, and a reversible logical state. Existing contact metadata cannot provide those invariants. The existing `deal_hunter_cim_repair_manifests` table can be reused for the append-only repair receipt because it already supports typed, namespaced repair manifests, but it is not an operational supersession index.

### 5.2 Approach B — reparent dependencies but leave both CRM rows active — reject

This would still produce duplicate cards, duplicate overdue queues, ambiguous candidate sets outside the canonical-primary shortcut, two mutable workflow surfaces, and potential independent outbound authority. Reparenting all historical events would also falsify provenance and create unnecessary mutations. It does not solve the durable semantic problem.

### 5.3 Approach C — Archive Lead, Pass, or delete — reject

- Archive Lead records a lifecycle action, not a duplicate-identity resolution, and could misstate why the row became inactive.
- Pass records an acquisition decision that was never made and could affect deal triage or reporting.
- Delete destroys the losing CRM row and currently cascades or nulls related history in application code. It is incompatible with evidence preservation and rollback.

None is an acceptable substitute for explicit supersession.

## 6. Durable supersession schema

A schema migration is required. Proposed SQLite table:

```sql
CREATE TABLE crm_submission_supersessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
  survivor_submission_id TEXT NOT NULL,
  superseded_submission_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code = 'confirmed-duplicate'),
  reason_text TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  repair_version TEXT NOT NULL,
  repair_manifest_id TEXT NOT NULL,
  repair_digest TEXT NOT NULL,
  reversed_at TEXT,
  reversed_by TEXT,
  reversal_reason TEXT,
  reversal_manifest_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  CHECK (survivor_submission_id <> superseded_submission_id),
  CHECK (
    (status = 'active' AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_manifest_id IS NULL)
    OR
    (status = 'reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_manifest_id IS NOT NULL)
  ),
  FOREIGN KEY (survivor_submission_id) REFERENCES contact_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (superseded_submission_id) REFERENCES contact_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE RESTRICT,
  FOREIGN KEY (repair_manifest_id) REFERENCES deal_hunter_cim_repair_manifests(id) ON DELETE RESTRICT,
  FOREIGN KEY (reversal_manifest_id) REFERENCES deal_hunter_cim_repair_manifests(id) ON DELETE RESTRICT
);

CREATE INDEX idx_crm_submission_supersessions_survivor
  ON crm_submission_supersessions(survivor_submission_id, status);
CREATE INDEX idx_crm_submission_supersessions_opportunity
  ON crm_submission_supersessions(opportunity_id, status);
CREATE UNIQUE INDEX uq_crm_submission_supersessions_active_loser
  ON crm_submission_supersessions(superseded_submission_id)
  WHERE status = 'active';
```

Required trigger/application invariants:

1. Core tuple, approval, reason, original repair fields, and `repair_digest` are immutable after insert. The digest is the lowercase SHA-256 of the exact reviewed canonical plan; `repair_manifest_id` identifies the matching append-only receipt.
2. The only ordinary transition is `active -> reversed` through a separately versioned reverse repair; physical delete is forbidden.
3. A submission may be the superseded member of at most one active mapping. Reversed mappings remain immutable history, while the deterministic tuple ID prevents replay of the same mapping.
4. V1 forbids chains: an active survivor cannot itself be an active loser, and an active loser cannot be an active survivor. A future consolidation must use a separately reviewed flatten repair that atomically reverses affected active mappings and inserts direct mappings to the final survivor; ordinary writers cannot create that state.
5. These rules prevent cycles as well as one loser mapping to two survivors.
6. Both submissions must exist; the opportunity must be active; its primary must equal the proposed survivor; and the survivor's direct-or-metadata owner must resolve to that opportunity without conflict.
7. The loser must not be a primary of any canonical opportunity and must not declare a conflicting direct or metadata owner.
8. Deletes of either CRM row, the opportunity, or the receipt are restricted while a supersession row exists.
9. IDs are deterministic: `crm-submission-supersession:v1:<sha256(canonical tuple)>`.
10. Metadata may contain only bounded audit data, never copied email bodies, notes, contacts, or documents.

Production is SQLite. The incident repair must be SQLite-only. The optional Supabase adapter must fail closed with a typed `CRM_SUPERSESSION_UNAVAILABLE` response until separately reviewed table/RPC parity exists; SQLite evidence must not be described as Supabase evidence.

### 6.1 Canonical-opportunity merge interaction — owner-approved addendum

`crm_submission_supersessions` is immutable historical and canonical authority. An ordinary canonical-opportunity merge must inspect every supersession row whose `opportunity_id` equals either the proposed canonical survivor opportunity or the proposed canonical superseded opportunity. The inspection includes both `status = 'active'` and `status = 'reversed'`; it must not filter by status.

If any scoped supersession row exists, the canonical-opportunity merge must fail closed before mutation. A reversed relation is no longer operationally active, but its immutable historical tuple and receipts still establish a canonical-history boundary that ordinary merge is not authorized to reinterpret. Supersession rows whose `opportunity_id` belongs only to unrelated opportunities do not block the merge, subject to every existing merge gate.

The canonical-opportunity merge relationship inventory must classify the implemented supersession schema explicitly:

| Column | Category | Enforcement | Scanner path |
|---|---|---|---|
| `crm_submission_supersessions.opportunity_id` | `BLOCKING_ENTITY_DEPENDENCY` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |
| `crm_submission_supersessions.survivor_submission_id` | `REDUNDANT_THROUGH_SCANNED_PARENT` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |
| `crm_submission_supersessions.superseded_submission_id` | `REDUNDANT_THROUGH_SCANNED_PARENT` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |
| `crm_submission_supersessions.repair_manifest_id` | `REDUNDANT_THROUGH_SCANNED_PARENT` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |
| `crm_submission_supersessions.reversal_manifest_id` | `REDUNDANT_THROUGH_SCANNED_PARENT` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |
| `crm_submission_supersessions.metadata` | `REDUNDANT_THROUGH_SCANNED_PARENT` | `MATERIAL_SCANNER_PATH` | `dependentState.records.crmSubmissionSupersessions` |

The scanner selects the complete supersession row through `opportunity_id`, so the remaining relationship-like fields are redundant through that parent scanner rather than independently queried identities. `status` is selected as part of the complete row and is never used to exclude reversed history. No relationship-like supersession column may remain unclassified. Malformed or unclassified supersession schema, or any inability to inspect supersession state completely, blocks the canonical merge.

Ordinary canonical-opportunity merge must never retarget, rewrite, migrate, or reinterpret a supersession. It must not modify `opportunity_id`, `survivor_submission_id`, `superseded_submission_id`, `repair_manifest_id`, `reversal_manifest_id`, `status`, `metadata`, or either endpoint. It must not rewrite an existing `crm-duplicate-consolidation` apply receipt or reversal receipt. Retargeting either opportunity would make those immutable historical tuples and receipts ambiguous, so V1 refuses instead of transforming them.

This is intentionally conservative V1 policy. A future business case that combines canonical-opportunity merge with existing CRM supersession history requires a new, explicit, separately owner-reviewed combined repair that explains the complete transformation and receipt truthfulness. Neither existing repair may generalize itself to perform that operation implicitly.

## 7. Active CRM and read-through semantics

An active CRM submission is a row for which no `status = 'active'` supersession names it as `superseded_submission_id`, in addition to existing lifecycle filters. This is a storage/service contract, not a frontend hide.

After consolidation:

- only the survivor appears as an active acquisition card, search result, Command Center record, or next-action item;
- counts and overdue queues count the survivor once;
- matcher candidates are canonicalized through the active supersession map and deduplicated by final survivor ID before uniqueness is decided;
- the CRM match-authority revision becomes v2 and hashes both the complete `contact_submissions` snapshot and complete active supersession snapshot;
- the final SQLite link transaction re-reads that combined authority, rejects a superseded selected row, and validates that the final survivor remains current;
- direct navigation to a loser returns the immutable historical record with `superseded`, survivor ID, opportunity ID, reason, approval/repair reference, and a safe link to the survivor;
- a survivor timeline unions events from survivor and loser while preserving `originSubmissionId` on every event; it does not change stored `submission_id` values;
- future Sheet sync and Deal OS reconciliation use the survivor. They never silently mutate a loser;
- duplicate review reports both pairs as `resolved/superseded` and no longer as unresolved candidates;
- the existing generic CRM integrity audit remains semantically unchanged and must continue to report `ok: true` and `safeToReconcile: true`. Supersession integrity is checked by a separate typed audit/repair postcondition so duplicate review does not redefine generic reconciliation safety.

## 8. Relationship-preservation matrix

| Relationship | Policy | V1 detail |
|---|---|---|
| `contact_submissions` | SUPERSEDE | Keep both rows byte-for-byte; add one durable relation per loser. Do not Archive, Pass, or delete. |
| `crm_activity_events` | RETAIN ON ORIGINAL WITH READ-THROUGH | Preserve 101 events on their original rows. Timeline union labels origin. |
| Legacy `email_events` | RETAIN ON ORIGINAL WITH READ-THROUGH | Preserve all 36 provider events and original timestamps/message evidence. |
| `crm_communications` | RETAIN ON ORIGINAL WITH READ-THROUGH | Current count is zero. Future historical rows stay on origin; nonterminal send state on a loser blocks apply. |
| `crm_email_outbox` | BLOCKED / OWNER DECISION NEEDED if nonterminal | Current count is zero. Any pending, claimed, failed-ambiguous, or sendable loser outbox row blocks apply. Terminal history stays on origin. |
| `deal_hunter_cim_requests` | RETAIN ON ORIGINAL WITH READ-THROUGH | Three requests are on survivors and completed. Never restart or move them. Any loser or nonterminal request blocks apply. |
| CIM follow-up state | LEAVE UNCHANGED | Completed request histories remain completed. Loser submission workflow fields are excluded from active queues by supersession rather than rewritten. |
| `crm_follow_up_recommendations` | RETAIN ON ORIGINAL WITH READ-THROUGH | Two Pooler survivor recommendations stay unchanged. Any current/actionable loser recommendation blocks apply. |
| Secure documents | RETAIN ON ORIGINAL WITH READ-THROUGH | Current count zero. Existing files would remain on origin; contents and paths are never copied. |
| Secure upload requests | RETAIN ON ORIGINAL WITH READ-THROUGH / BLOCK if active | Current count zero. Open/uploading loser requests block apply; historical closed requests stay on origin. |
| Dispositions | LEAVE UNCHANGED | Current count zero. Do not synthesize Pass or Archive. |
| Notes/generated notes | RETAIN ON ORIGINAL WITH READ-THROUGH | All four generated-note-bearing rows stay intact. No note content is copied or rewritten. |
| `next_action_at` / `follow_up_state` | LEAVE UNCHANGED | Active projections ignore loser fields. Survivor stale state is a separate owner decision. |
| `metadata.acquisitionCommand` | LEAVE UNCHANGED | Absent on all four. Future loser mutations refuse. |
| `metadata.diligence` | LEAVE UNCHANGED | Absent on all four. Future loser mutations refuse. |
| Deal Hunter CRM import claims | REPARENT TO SURVIVOR only where operationally necessary | Update Berlin import `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8` from loser to survivor; preserve `opportunity_id = NULL` and original provenance. Pooler claims already target survivor. |
| `deal_hunter_opportunities.primary_submission_id` | LEAVE UNCHANGED | Both already identify the proposed survivors. |
| `contact_submissions.deal_hunter_opportunity_id` | LEAVE UNCHANGED | All four are `NULL`; do not introduce redundant ownership mutations. |
| `metadata.dealHunter.opportunityId` | LEAVE UNCHANGED | Present only and correctly on survivors. The relation supplies loser resolution. |
| Source observations | LEAVE UNCHANGED | Opportunity-owned immutable/projection evidence stays on the distinct canonical opportunity. |
| Opportunity aliases | LEAVE UNCHANGED | Existing aliases remain with their current canonical opportunity. |
| Reconciliation items/runs | LEAVE UNCHANGED / BLOCK if nonterminal | Current scoped item count zero. Historical plans are evidence, not rewrite targets. |
| Admin audit events | LEAVE UNCHANGED | Preserve exact historical paths/actions. |
| Scheduled-job metadata | LEAVE UNCHANGED | Preserve all embedded historical references. |
| Existing repair manifests | LEAVE UNCHANGED | Preserve the prior applied CIM identity receipt. |
| New repair receipt | COPY WITH PROVENANCE | Insert one append-only, typed manifest for both approved repair units. |
| Prospect discoveries / cleanup jobs | LEAVE UNCHANGED / BLOCK if active | Current counts zero. Any active operational loser dependency blocks apply. |

No historical timestamp, sender/recipient evidence, delivery state, document reference, source observation, or financial observation is rewritten.

## 9. Historical email, CIM, and workflow policy

Pooler has 21 loser email events plus 9 survivor email events. Berlin has 6 loser email events and none on the survivor. These records must remain on their original submission IDs. The combined survivor timeline is a read projection that labels origin; it is not reparenting.

All three CIM requests are already on survivors, provider accepted, and follow-up completed. They remain completed and are never restarted. No unified `crm_communications` or CRM outbox record currently exists for either pair.

All four contact rows still say `needs-response` with overdue `next_action_at` values. The losers' overdue states are duplicate residue for active-projection purposes and disappear from active queues through supersession, without rewriting history. The survivors' overdue states may represent stale residue or real unfinished owner work. V1 must leave them unchanged and show one explicit post-repair owner-review item per survivor. Clearing them is not part of duplicate consolidation and requires separate owner judgment.

The current Pooler survivor recommendation `a169ba9c-6b96-41f1-a18b-5c8521ebdc54` is still `current` although it expired in August; the earlier recommendation is already superseded. V1 does not accept, dismiss, supersede, or regenerate either recommendation. Their cleanup is separate from duplicate identity.

## 10. Financial provenance policy

The contact column named `ttm_ebitda` is a historical storage projection, not proof that the source reported EBITDA. For both pairs, the raw source label was `Annual Profit`; period was not supplied. The repair therefore records and preserves:

- source and source-record ID;
- observation date;
- original label `Annual Profit`;
- original value;
- stored projection field/value;
- stated period when present, otherwise `unknown`;
- every conflicting observation, if one appears before preview/apply.

`Annual Profit`, EBITDA, SDE, Cash Flow, and generic Profit remain distinct metric labels. Survivor selection does not choose a financial observation as current, and no source observation or contact financial field is updated. Any new disagreement between pair members or canonical source observations blocks the plan for owner review rather than being resolved automatically.

## 11. Writer-safety policy

Every business writer must resolve or guard supersession at its storage/service boundary. Frontend filtering is not authority.

| Writer/path | V1 policy for a superseded row |
|---|---|
| CRM PATCH/update | Refuse `409 CRM_SUBMISSION_SUPERSEDED`; return survivor/opportunity references for operator navigation. No silent redirect. |
| Archive Lead | Refuse; archive is a different lifecycle assertion. |
| Pass/disposition | Refuse; pass is an acquisition decision. |
| Delete | Refuse; FK restrictions and service guard preserve evidence. |
| Follow-up workflow and recommendation generation | Exclude losers from candidates; direct loser invocation refuses. Historical reads remain allowed. |
| Manual email | Refuse before outbox/communication creation. |
| Broker-material CIM | Refuse before preparation, approval, claim, request, or send. |
| Corrected-recipient retry | Refuse on loser; no request is silently rebound. |
| Deal OS reconciliation | Preview canonicalizes through the durable survivor; explicit loser writes refuse. Apply must bind its own authority snapshot. |
| High-fit CRM sync | Matcher maps/deduplicates candidates to survivor; cached loser import conflicts refuse unless the reviewed repair has reparented the claim. |
| Source-field repair | Opportunity-owned source observations remain allowed through the canonical opportunity; direct loser field writes refuse. |
| Command Center update | Loser excluded from active records; direct loser update refuses. |
| Secure upload request/document actions | Historical reads allowed. New request, token issuance, upload finalization, revocation, or document mutation on loser refuses. Active loser upload state blocks consolidation. |
| Document actions | Read-through allowed; delete/move/rebind on loser refuses outside a separate approved repair. |
| Stage 2 and automatic paths | Candidate enumeration excludes losers; final authorization checks current canonical primary and no active supersession. |
| Historical administration | Read, inspect, export, and audit are allowed; business mutation is not. Logical reversal uses a separate repair. |

The safe default is refusal. Read-level canonicalization for matching/search is allowed because it does not mutate business state and produces one explicit survivor. Business mutations are never silently redirected.

## 12. Versioned repair operation

Repair type: `crm-duplicate-consolidation`

Approval schema: `crm-duplicate-consolidation-approval-v1`

Plan schema: `crm-duplicate-consolidation-plan-v1`

Manifest schema: `crm-duplicate-consolidation-manifest-v1`

Repair version: `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`

Confirmation text:

```text
APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1
```

The checked-in approval descriptor contains exactly the two pair tuples in section 1. Arbitrary runtime IDs cannot authorize another pair.

The repair may reuse stable canonical JSON, hashing, schema-inventory, manifest, and transaction patterns from existing incident repairs, but must not reuse F-02 Repair2/Repair3 or canonical-opportunity merge business semantics. It is SQLite-only and receives an explicit storage/inspection boundary.

### 12.1 Preview contract

Preview is the default and performs zero business mutation. It must:

1. open the existing database read-only, require the file to exist, enable `query_only`, and take one consistent SQLite read snapshot;
2. assert the exact provider, schema, table/column inventory, pair tuples, canonical primary/ownership, aliases, listing identities, financial provenance, and recovery references;
3. discover every direct and embedded reference to either submission, both canonical opportunities, involved CIM/import/communication IDs, and pair aliases;
4. classify every relationship as mutated, retained/read-through, explicitly irrelevant, or blocking; any unclassified relationship-like schema column is a blocker;
5. include selected privacy-safe values plus raw-row SHA-256 fingerprints so apply protects every column without exposing bodies, contacts, documents, or raw metadata;
6. show every proposed mutation and every intentionally untouched relationship;
7. compute exact row counts and invariants;
8. emit a deterministic canonical plan and SHA-256 checksum. Generated time and filesystem path are outside the checksum; approval tuple, actor, reason, raw-row digests, schema digest, recovery references, and expected mutation set are inside it;
9. write stdout only to the operator-selected artifact path; never persist a preview manifest to the business database;
10. fail closed on drift, active writers, nonterminal loser send/upload/reconciliation state, current Stage 2 activation, changed safety controls, or an unknown reference.

### 12.2 Apply contract — future and separately authorized

Apply must require all of:

- `--apply`;
- exact manifest ID and exact reviewed artifact path;
- exact lowercase plan checksum;
- exact two survivor/loser/opportunity tuples;
- exact database/schema/current-row digests from preview;
- exact backup manifest/path/SHA-256 and Fly release/tooling SHA;
- actor and reason matching the reviewed plan;
- exact confirmation text;
- durable outreach and automation pauses, scheduler disabled, follow-ups disabled, no Stage 2 activation, no active writer;
- no state drift since preview.

Apply begins one `BEGIN IMMEDIATE` transaction, recomputes the complete plan, compares its checksum and manifest byte-for-byte with the reviewed artifact, inserts the final typed repair receipt, inserts both supersession rows, performs the one Berlin import CAS update, runs all postconditions, and commits once. Any mismatch rolls back everything. No auto-retry follows an ambiguous failure.

Idempotency outcomes are:

- first execution: exact four-row mutation and receipt;
- exact receipt, exact active supersessions, exact Berlin import state, and all postconditions: `verified-prior-apply`, zero mutation;
- independently satisfied state without the exact receipt: refusal;
- partial or conflicting receipt/state: refusal.

Manifest ID: `crm-duplicate-consolidation:v1:<sha256(canonical approved tuple)>`.

## 13. Read-only hypothetical mutation plan

No preview tool exists yet, so this is a design-time hypothetical plan rather than apply authority. It has no executable checksum and cannot authorize production mutation.

### 13.1 Pooler plan

| Table / relationship | Record | Current value | Proposed value | Action | Reason / provenance | Expected rows | Invariant | Reversible |
|---|---|---|---|---|---|---:|---|---|
| `crm_submission_supersessions` | deterministic Pooler relation | absent | active loser `b36a…a92b` -> survivor `daa9…c455`, canonical `opp_683…d907` | INSERT | Durable identity resolution; row history remains intact | 1 | Survivor is active canonical primary; loser is not any primary; no chain/cycle | yes, logical reverse only |
| `contact_submissions` | `daa9…c455`, `b36a…a92b` | both `review`; survivor metadata-owned; loser unowned | unchanged | LEAVE | Preserve all fields, notes, timestamps, and workflow provenance | 0 | Raw digests unchanged | n/a |
| `crm_activity_events` | 27 survivor + 40 loser | split historical events | unchanged, combined by read-through | RETAIN | Truthful origin preserved | 0 | counts/digests unchanged | n/a |
| `email_events` | 9 survivor + 21 loser | split provider evidence | unchanged, combined by read-through | RETAIN | Sender/provider history remains truthful | 0 | counts/digests unchanged | n/a |
| `deal_hunter_cim_requests` | two survivor requests | both completed after 3 follow-ups | unchanged | RETAIN | Never restart completed follow-ups | 0 | both remain survivor-bound/completed | n/a |
| `crm_follow_up_recommendations` | two survivor rows | one superseded; one stale current | unchanged | RETAIN / OWNER REVIEW | Recommendation cleanup is separate | 0 | IDs/statuses unchanged | n/a |
| `deal_hunter_crm_imports` | `cde045…e31`, `fa231f…fd0` | both already survivor-bound; legacy claim keeps `opportunity_id = NULL` | unchanged | LEAVE | No operational loser claim exists | 0 | exact claims unchanged | n/a |
| all other classified references | scheduled jobs, audit, prior manifest | historical references | unchanged | RETAIN | Audit evidence | 0 | counts/digests unchanged | n/a |

Pooler summary:

- survivor: `daa9ea12-786f-4769-b702-d9309525c455`;
- loser: `b36a4b33-d35c-4e8d-b6c3-b6301030a92b`;
- pair-specific mutations: **1 row**;
- retained historical direct references: 40 loser activity events, 21 loser email events, 19 scheduled-job references, one prior repair-manifest reference, plus the untouched loser row/note;
- active-card effect: two active-looking rows become one active card;
- workflow effect: loser overdue state is excluded, survivor overdue state remains once for owner review.

### 13.2 Berlin plan

| Table / relationship | Record | Current value | Proposed value | Action | Reason / provenance | Expected rows | Invariant | Reversible |
|---|---|---|---|---|---|---:|---|---|
| `crm_submission_supersessions` | deterministic Berlin relation | absent | active loser `8cbd…afd3` -> survivor `0f5f…d1da`, canonical `opp_9b184…61b3` | INSERT | Durable identity resolution; row history remains intact | 1 | Survivor is active canonical primary; loser is not any primary; no chain/cycle | yes, logical reverse only |
| `deal_hunter_crm_imports` | `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8` | `submission_id = 8cbd…afd3`, `opportunity_id = NULL` | `submission_id = 0f5f…d1da`; keep `opportunity_id = NULL`; add bounded provenance metadata and new `updated_at` | REPARENT TO SURVIVOR with CAS | Removes cached loser authority while preserving legacy claim semantics and original owner in receipt/metadata | 1 | Exact prior raw digest; canonical import `4e207…7ad` remains unchanged | yes, CAS reverse |
| `contact_submissions` | `0f5f…d1da`, `8cbd…afd3` | both `review`; survivor metadata-owned; loser unowned | unchanged | LEAVE | Preserve notes, timestamps, and workflow provenance | 0 | Raw digests unchanged | n/a |
| `crm_activity_events` | 27 survivor + 7 loser | split historical events | unchanged, combined by read-through | RETAIN | Truthful origin preserved | 0 | counts/digests unchanged | n/a |
| `email_events` | 0 survivor + 6 loser | all legacy provider evidence on loser | unchanged, shown via read-through | RETAIN | Reparenting would falsify history | 0 | count/digest unchanged | n/a |
| `deal_hunter_cim_requests` | one survivor request | completed after 3 follow-ups | unchanged | RETAIN | Never restart completed follow-up | 0 | remains survivor-bound/completed | n/a |
| all other classified references | scheduled jobs and prior manifest | historical references | unchanged | RETAIN | Audit evidence | 0 | counts/digests unchanged | n/a |

Berlin summary:

- survivor: `0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da`;
- loser: `8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3`;
- pair-specific mutations: **2 rows**;
- retained historical direct references: 7 loser activity events, 6 loser email events, one scheduled-job reference, plus the untouched loser row/note;
- active-card effect: two active-looking rows become one active card;
- workflow effect: loser overdue state is excluded, survivor overdue state remains once for owner review.

### 13.3 Global receipt and exact count

Insert one append-only row in `deal_hunter_cim_repair_manifests` with mode `crm-duplicate-consolidation`, status `applied`, exact approval tuple, plan checksum, backup/snapshot references, release/tooling revision, actor/reason, mutation counts, before/after digests, and postconditions.

Expected apply mutations: **4 rows total**:

1. Pooler supersession insert;
2. Berlin supersession insert;
3. Berlin legacy CRM-import update;
4. global repair-manifest insert.

Expected `contact_submissions`, activity, email, communication, CIM request, recommendation, document, disposition, canonical opportunity, alias, score, and source-observation mutations: **0**.

The schema migration is a separate, pre-apply deployment change and is not counted as a business-data mutation.

## 14. Post-apply acceptance criteria

Pooler:

- exactly one active CRM representation;
- `daa9…c455` remains primary for `opp_683…d907`;
- `b36a…a92b` has one active durable supersession to that survivor;
- all 67 activity events across the pair and all 30 email events remain available with original provenance;
- two completed CIM requests remain completed and survivor-bound;
- no duplicate actionable next step.

Berlin:

- exactly one active CRM representation;
- `0f5f…d1da` remains primary for `opp_9b184…61b3`;
- `8cbd…afd3` has one active durable supersession to that survivor;
- all 34 activity events and 6 email events remain available with original provenance;
- legacy import `508bc…ea8` points to the survivor while retaining `opportunity_id = NULL` and repair provenance;
- the completed CIM request remains completed and survivor-bound;
- no duplicate actionable next step.

Global:

- no Pooler/Berlin canonical merge;
- no lost or rewritten submission, note, email, activity, document, CIM request, recommendation, score, alias, or source observation;
- no orphaned request, new CIM request, restarted follow-up, provider call, outbox send, or transmission;
- direct/metadata ownership remains consistent;
- match authority resolves each listing only to its survivor and final-link CAS is supersession-aware;
- all active projections and writers honor supersession;
- generic CRM audit stays `ok: true` and `safeToReconcile: true`;
- supersession-specific audit passes;
- `PRAGMA quick_check = ok` and `foreign_key_check = 0`;
- duplicate projection reports both pairs `resolved/superseded`;
- exactly four apply-row mutations and no others.

## 15. Rollback design

### 15.1 Logical reverse repair

A deterministic reverse is possible only if no post-apply active business write has depended on either supersession and the exact apply receipt/state remains current. It requires a separately reviewed reverse manifest and checksum, current raw-row digests, original apply manifest, actor/reason, backup reference, exact confirmation, and the same safety pauses.

The reverse transaction:

1. CAS-updates both supersession rows from `active` to `reversed`, recording reversal time/actor/reason/manifest;
2. CAS-restores Berlin import `508bc…ea8` to `submission_id = 8cbd…afd3`, restores its exact pre-apply metadata and `updated_at`, and keeps `opportunity_id = NULL`;
3. inserts an append-only reverse receipt;
4. revalidates all invariants and commits once.

The schema and original apply receipt remain. Historical events never moved, so they need no reversal. External messages or owner actions that occur after apply are not reversible; their existence blocks logical reverse and requires owner review.

### 15.2 Disaster rollback

- Use application backup manifest `5ead31fc-fba2-40d8-9a42-2f8c91c16c93` only for a database-level incident where bounded logical reverse cannot restore integrity. It would revert every database change after `2026-09-17T17:48:01.242Z`, not just this repair.
- Use Fly snapshot `vs_l8M4RX4qL8wU9zJZBPJA51J` only for a volume-level disaster involving database and/or other volume state. It has a wider blast radius and the same intervening-change loss concern.

Either restore requires separate owner authorization, stopped writers, an explicit loss-window decision, a new recovery plan, and full integrity/health/outbound verification. This design does not authorize restore.

## 16. Wider duplicate-review projection

Provide a separate read-only `CRM duplicate review` service/report. It does not change the generic integrity audit or `safeToReconcile`, and never mutates CRM.

Each row is one normalized pair `(lower_submission_id, higher_submission_id)`—never a transitive merge group—and includes:

- category: `confirmed-duplicate`, `strong-candidate`, `uncertain`, `keep-distinct`, or `resolved/superseded`;
- corroborating evidence categories and hashes;
- conflicting evidence categories and hashes;
- current canonical opportunity/primary relationship;
- active supersession, if any;
- durable owner decision reference, actor, reason, evidence version/digest, and time where available;
- current blocker set.

The two V1 pairs derive `resolved/superseded` from the active supersession table and therefore disappear from unresolved queues. A later optional `crm_duplicate_pair_decisions` table may persist `keep-distinct` and reviewed candidate decisions using normalized pair uniqueness. It is not required for V1 repair and must not be bundled into the minimum migration.

## 17. Minimum future implementation scope

### MUST HAVE

- one SQLite schema migration/startup DDL for `crm_submission_supersessions`, indexes, immutability/deletion/chain-cycle guards;
- explicit SQLite storage methods for read resolution, active filtering, supersession-aware authority snapshot, and one atomic incident apply transaction;
- Supabase adapter fail-closed contract; no claim of production parity;
- PR #19 match authority upgraded to include supersession state and final-link validation;
- central service guard used by CRM update/archive/pass/delete, communications/outbox, follow-up, CIM/broker materials, corrected retry, Command Center, secure uploads/documents, reconciliation, high-fit sync, source repair, recommendations, and Stage 2 paths;
- active CRM/search/queue/Command Center queries that exclude losers;
- historical deep-link and timeline read-through with origin provenance;
- incident constants/approval descriptor, preview/apply service, operator CLI, typed manifest, and operator runbook;
- targeted UI banner/link for a superseded direct record and resolved status in duplicate review;
- exhaustive schema relationship classifier plus tests for unknown future columns;
- unit/integration tests for preview purity, exact four-row apply, drift refusal, idempotency, rollback, cycle/chain prevention, writer refusal, active projections, matcher behavior, timeline provenance, financial labels, generic audit stability, SQLite quick/FK checks, and zero sends/provider calls;
- production sequence designed separately: reviewed migration/code PR, exact-head CI, controlled deploy, fresh current backup/checkpoint if authorized, production preview only, owner review, then separately authorized apply.

Likely files are confined to `server/repairs/`, a new duplicate-consolidation service, `server/storage/sqlite.js`, the Supabase fail-closed adapter, `server/services/dealHunter.js`, central submission/workflow/document/Command Center guards, `server/app.js`, focused admin components, one operator script, package script, runbook, and tests. Exact files belong in the later implementation plan, not this design task.

### LATER / OPTIONAL

- full Supabase schema/RPC parity;
- durable `keep-distinct`/candidate decision table;
- richer duplicate-review UI and evidence comparison;
- administrative logical-reverse UI rather than operator CLI;
- generalized consolidation of future pairs. Every future pair still requires explicit owner-reviewed evidence and approval.

This must not become a general CRM rewrite.

## 18. Owner decisions required

Before any implementation plan:

1. Approve the dedicated-table architecture and migration boundary.
2. Approve Pooler survivor `daa9…c455` and loser `b36a…a92b`.
3. Approve Berlin survivor `0f5f…d1da` and loser `8cbd…afd3`.
4. Approve exact apply scope: two supersession inserts, one Berlin import update, one receipt insert, and no contact/history/canonical/source mutation.
5. Approve leaving all loser workflow fields and both survivor overdue states unchanged, with losers excluded by projection and survivor cleanup deferred.
6. Approve preserving the stale Pooler survivor recommendation unchanged for separate review.
7. Approve SQLite-only repair with Supabase fail-closed until separate parity work.
8. If the design is accepted, separately authorize an implementation plan. That approval would still not authorize deployment, preview, or apply.

## 19. Self-review and safety conclusion

- Pooler and Berlin are independent repair units; no canonical merge between them is implied.
- Every discovered direct or embedded relationship has a preservation/mutation/blocking policy.
- Historical email, activity, CIM, job, audit, note, and repair provenance remains on its original row.
- `Annual Profit` is not relabeled EBITDA, SDE, Cash Flow, or generic Profit.
- No Archive, Pass, or delete action represents consolidation.
- Future writers cannot independently act on an active loser.
- Preview and apply are separate; apply binds the exact reviewed artifact/checksum and fails on drift.
- Logical and disaster rollback are defined.
- Current backup and snapshot were only read-verified, not created or restored.
- Ordinary canonical-opportunity merge fails closed when either merge subject has active or reversed CRM supersession history, while unrelated supersessions do not block it; no supersession tuple or receipt is retargeted or rewritten.
- Production business mutation, cleanup execution, transmission, deployment, and reconciliation: none.

## Task 9 owner-approved checkpoint-evidence correction

Task 9's preview and separately authorized apply use exactly one explicit `--checkpoint-evidence <path>` as the operator-supplied recovery-checkpoint source. The file has the exact `crm-duplicate-consolidation-checkpoint-v1` envelope and the complete Task 8 recovery-checkpoint domain; direct checkpoint environment inputs are not part of the contract. One pure shared validator enforces exact keys, types, bounds, identifiers, hashes, canonical UTC timestamp ordering, backup and snapshot integrity/status, and release/tooling bindings without a wall-clock TTL.

Apply must independently validate the bounded UTF-8 JSON checkpoint file and the reviewed artifact's nested checkpoint, canonicalize and hash both, prove exact equality, and validate all non-database operator facts and exact confirmation before writable SQLite storage is constructed. Preview requires the same evidence file but retains Task 8's read-only, file-existing, query-only, consistent-snapshot boundary. This correction changes neither the two approved pairs nor the four-row mutation ledger and grants no production authority.
