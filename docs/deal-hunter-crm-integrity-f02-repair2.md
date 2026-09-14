# Deal Hunter CRM integrity F-02 Repair2

Repair2 is an incident-specific, independently versioned successor for `UG-P6-CLOSURE-F02-REPAIR2`. It does not replace or modify the historical F-02 v1 tool. It is not a general CRM editor and does not itself authorize production access, a production dry run, mutation, reconciliation, restart, deployment, or merge.

The reviewed baseline is Fly release 122 at revision `9fcfe65505348421373242aa304caefb4b30396b`. Repair2 supersedes v1 authority for three documented reasons:

- a legitimate September 13 Daily Digest full-backfill created the unrelated `Brake Specialty Shop` opportunity, advancing the strict opportunity count from 475 to 476;
- an exact-alias source review changed only the collision opportunity's `updated_at`, advancing its raw fingerprint from `f8f3b6cd79a33551f0579642ddcd3a2691ad90e3b5c46afb95cc1eac0fc2d838` to `a538b0ecd23b17a00a20bd6499de6ec922ec7aaeed4311aa84521c5eb668743e`;
- v1 pins collision-submission fingerprint `6b811304f09d44b3737f73b2a479654c4a5c4b45fee4b5e2b6e67542eb674082`, which belongs to a valid direct-`NULL` plus metadata-owner state, but its separate relationship predicate incorrectly requires the direct owner.

## Fixed mutation boundary

Repair2 can make exactly these three one-row compare-and-set changes:

1. Set `deal_hunter_crm_imports.opportunity_id` to `NULL` for import `cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31`, only when its value is `opp_683681c2-bd49-4c46-be4f-6d969143d907`.
2. Set `contact_submissions.deal_hunter_opportunity_id` to `opp_repair_6b75b5d5c825431d2bea921450f50c37` for submission `1245f55a-9496-4628-9cbe-d23e53b791a1`, only when its value is `NULL`.
3. Set `contact_submissions.company` to `Lawn And Landscape Maintenance Company For Sale` for submission `8e910798-9ac4-4d10-9c0f-9402feb9403a`, only when its value is `Profitable Senior Independence Support With Virtual Family Connection For Sale`.

Collision submission mutation: **NONE**. Repair2 does not mutate the collision submission, the collision opportunity, opportunity primaries, metadata, aliases, identities, scores, source observations, exceptions, tombstones, the Brake Specialty Shop opportunity, any other import or submission, or reconciliation data. It does not delete or merge anything.

The CLI accepts no runtime selector for IDs, fields, fingerprints, counts, before-values, or after-values.

## Declared-owner rule

The Repair2-only predicate resolves the collision submission's declared owner from `directOpportunityId || metadataOpportunityId`, but only after explicitly refusing conflicting nonempty values. It accepts direct-empty/metadata-expected, direct-expected/metadata-empty, and both-expected. It refuses a conflict, another resolved owner, or two empty owner fields. The opportunity primary must independently remain the reviewed collision submission; it cannot substitute for a missing declared owner.

This helper is intentionally scoped to Repair2. The generic CRM integrity audit and v1 remain unchanged.

## Immutable authority and guards

The incident contract binds:

- all 32 imports, 476 opportunities, and 30 audited submissions through strict generic-audit guards;
- the exact two-import pre-repair collision claimant set and exact retained-only post-repair set;
- nine raw `SELECT *` SHA-256 row fingerprints, including the current collision opportunity, the historical metadata-only collision submission, and the reviewed unrelated Brake Specialty Shop opportunity;
- the collision primary and declared owner, backlink opportunity/import/submission relationship, managed-name source authority, and Brake Specialty Shop name/listing/empty-primary/zero-import relationship;
- the exact three mutations, current unsafe audit, expected clean audit, evidence provenance, Repair2 confirmation phrase, and execution identity.

Raw row fingerprints are `SHA-256(JSON.stringify(rawRowFromSELECTStar))`; SQLite schema-column property order is part of the contract. Repair2 reuses v1's unchanged raw-fingerprint and deterministic canonical-checksum helpers.

The pre-repair generic audit must be exactly: imports 32, opportunities 476, audited submissions 30, ownership collisions 1, duplicate primaries 0, identity mismatches 0, name mismatches 1, active tombstones 0, backlink mismatches 1, `safeToReconcile: false`, and `ok: false`.

The post-repair audit must retain the first three totals and report zero for all five violation classes, `safeToReconcile: true`, and `ok: true`.

## Dry-run and apply safety

Dry run is the default. It opens only the configured existing SQLite file with `readonly: true` and `fileMustExist: true`, enables and verifies `PRAGMA query_only = ON`, and never initializes storage.

Apply additionally requires the exact retained reviewed manifest and plan checksum, `APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02-REPAIR2`, and a fresh current-format version 2 SQLite backup. The verified backup snapshot must postdate and independently reproduce the reviewed preflight. A writable existing-file connection then enables foreign keys before `BEGIN IMMEDIATE`, rechecks the entire contract, performs three prepared compare-and-set updates, verifies the exact clean generic audit, compares the all-table masked logical digest, runs `PRAGMA foreign_key_check`, and commits. Any failure rolls the transaction back; there is no retry.

The all-table digest replaces only the three authorized cells with a Repair2-specific placeholder. It therefore remains stable across the intended repair while detecting any other row or cell change. Exact before/after fingerprints and a deterministic execution receipt are returned without raw contact rows or message bodies.

## Future operation remains separately gated

This implementation did not run Repair2 against production. A later production dry run, backup, apply, receipt retention, startup, reconciliation decision, and deployment each require independent authorization and review.

After such authorization and deployment, the dry-run command shape is:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02-repair2.js \
  --actor "APPROVED OPERATOR" \
  --reason "OWNER-APPROVED REASON OF AT LEAST TWENTY CHARACTERS" \
  --execution-release "EXACT DEPLOYED RELEASE" \
  --tooling-revision "EXACT_DEPLOYED_40_CHARACTER_GIT_REVISION" \
  > f02-repair2-reviewed-dry-run.json
```

The dry run must be retained and independently reviewed before any apply. A different count, fingerprint, relationship, release, revision, or state requires a new diagnosis and authority review; do not substitute authority values or weaken guards.

Only after separate backup and apply approval would the command shape be:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02-repair2.js \
  --actor "SAME APPROVED OPERATOR" \
  --reason "SAME OWNER-APPROVED REASON" \
  --execution-release "SAME EXACT DEPLOYED RELEASE" \
  --tooling-revision "SAME EXACT TOOLING REVISION" \
  --apply \
  --expected-plan-checksum "OWNER_REVIEWED_64_CHARACTER_SHA256" \
  --reviewed-manifest f02-repair2-reviewed-dry-run.json \
  --backup "/approved/current/application-backup-bundle" \
  --confirm APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02-REPAIR2 \
  > f02-repair2-execution-receipt.json
```

Passing a retained receipt on a later separately authorized dry run can distinguish `verified-prior-apply` from an independently corrected `already-satisfied` state. Neither status authorizes reconciliation or outbound work.
