# Deal Hunter CRM integrity F-02 repair

This command is an incident-specific repair tool for `UG-P6-CLOSURE-F02`. It is not a general CRM editing command and does not authorize production access or mutation.

The diagnostic evidence came from release 120 at revision `1af79c5ff93dae3dbeeb0173cfdc6d59d5b29109`. The repair tool was implemented later. A future production operation must separately approve the exact deployed tooling release and Git revision, refresh the production preflight, create and verify a fresh application backup, approve the resulting checksum, authorize apply, and decide whether a restart is appropriate.

## Fixed repair boundary

The tool can make only these three compare-and-set changes:

1. Set `deal_hunter_crm_imports.opportunity_id` to `NULL` for import `cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31`, only when its current value is `opp_683681c2-bd49-4c46-be4f-6d969143d907`.
2. Set `contact_submissions.deal_hunter_opportunity_id` to `opp_repair_6b75b5d5c825431d2bea921450f50c37` for submission `1245f55a-9496-4628-9cbe-d23e53b791a1`, only when its current value is `NULL`.
3. Set `contact_submissions.company` to `Lawn And Landscape Maintenance Company For Sale` for submission `8e910798-9ac4-4d10-9c0f-9402feb9403a`, only when its current value is `Profitable Senior Independence Support With Virtual Family Connection For Sale`.

It cannot accept record IDs, fields, before-values, or replacement values from the command line. It does not delete or merge rows, execute reconciliation, create import work, enqueue messages, create a database receipt, initialize storage, migrate schema, change journal mode, create a backup, retry an uncertain result, or restart the application.

## Evidence contracts

Raw authority rows use the diagnostic fingerprint algorithm exactly:

```text
SHA-256(JSON.stringify(rawRowFromSELECTStar))
```

The row comes directly from `SELECT *`. SQLite schema-column order is preserved. The tool does not normalize, redact, key-sort, or convert the row before hashing.

The plan checksum is separate. It hashes recursively key-sorted JSON and binds the incident, three mutations, authority relationships and fingerprints, diagnostic global guards, evidence release and revision, execution release and tooling revision, actor, reason, confirmation phrase, postconditions, and preconditions. Runtime timestamps and database, backup, manifest, and receipt paths are excluded from the checksum.

The preflight also binds a masked logical database digest. The digest covers every row in every application table while replacing only the three authorized cells with fixed placeholders. It therefore remains equal across the intended repair but detects changes to other cells or table contents between review, backup, and apply.

## Connection and state behavior

Dry run is the default. It opens the configured existing SQLite file with `readonly: true` and `fileMustExist: true`, enables `PRAGMA query_only = ON`, verifies `query_only = 1`, and performs no durable database write. It never calls `getStorage()` or `createSqliteStorage()`.

The result is one of:

- `repair-required`: every diagnosed unsafe-state value, relationship, fingerprint, and global guard matches.
- `already-satisfied`: the exact corrected state matches, but no valid external receipt proves execution by this tool.
- `verified-prior-apply`: the corrected state and a retained receipt match the incident, plan checksum, execution identity, and post-state fingerprints.
- `refused`: the provider, schema, trigger, field state, authority fingerprint, relationship, audit count, or another precondition differs.

Apply uses a dedicated writable existing-file connection without initialization. It enables and verifies foreign-key enforcement before `BEGIN IMMEDIATE`, rechecks the complete preflight inside that transaction, runs three prepared one-row compare-and-set updates, verifies the real CRM integrity audit and `PRAGMA foreign_key_check`, compares the masked logical digest, and commits only when every postcondition passes. Any failure rolls back the entire transaction. The tool does not retry.

## Future dry run

Production dry run is not authorized by the local implementation checkpoint. After separate authorization and deployment, run the deployed command using its exact release and full 40-character Git revision:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02.js \
  --actor "APPROVED OPERATOR" \
  --reason "OWNER-APPROVED REASON OF AT LEAST TWENTY CHARACTERS" \
  --execution-release "EXACT DEPLOYED RELEASE" \
  --tooling-revision "EXACT_DEPLOYED_40_CHARACTER_GIT_REVISION" \
  > f02-reviewed-dry-run.json
```

The database path and provider come only from normal application configuration. Confirm that the bounded output says `repair-required`, that all diagnostic counts and fingerprints match, and that no blocker is present. Retain the complete JSON as the approval manifest in the owner-controlled change record. The CLI accepts that complete dry-run output directly during apply.

A different release, tooling revision, fingerprint, count, relationship, or state requires a new diagnosis and owner review. Do not replace authority values or weaken guards.

## Future backup and apply

Production backup creation and apply are separate approvals. After the reviewed dry run, create an application backup through the existing approved backup procedure. The repair command does not create one.

Apply requires a version 2 current-format SQLite bundle that passes the existing `verifyBackupBundle` contract, SHA-256 validation, `quick_check`, and foreign-key verification. The backup must postdate the reviewed preflight, and its embedded database must reproduce the exact reviewed unsafe state and plan checksum through a separate read-only/query-only connection.

After those approvals, the future apply shape is:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02.js \
  --actor "APPROVED OPERATOR" \
  --reason "OWNER-APPROVED REASON OF AT LEAST TWENTY CHARACTERS" \
  --execution-release "EXACT DEPLOYED RELEASE" \
  --tooling-revision "EXACT_DEPLOYED_40_CHARACTER_GIT_REVISION" \
  --apply \
  --expected-plan-checksum "OWNER_REVIEWED_64_CHARACTER_SHA256" \
  --reviewed-manifest f02-reviewed-dry-run.json \
  --backup "/approved/current/application-backup-bundle" \
  --confirm APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02 \
  > f02-execution-receipt.json
```

Retain the complete apply output outside the application database. It contains bounded operational evidence: incident, checksum, execution identity, backup manifest identity/checksum, before/after fingerprints, mutation count, audit counts, and completion time. It contains no raw rows, contact PII, message bodies, secrets, or unrelated CRM payloads.

To verify provenance later without writing, pass the retained complete output to a separately authorized dry run:

```bash
node scripts/repair-deal-hunter-crm-integrity-f02.js \
  --actor "SAME APPROVED OPERATOR" \
  --reason "SAME OWNER-APPROVED REASON USED BY THE PLAN" \
  --execution-release "SAME EXACT EXECUTION RELEASE" \
  --tooling-revision "SAME EXACT TOOLING REVISION" \
  --prior-receipt f02-execution-receipt.json
```

Correct values without a matching receipt remain `already-satisfied`; they are never reported as proof of a prior apply.

## Startup and cached health

The repair command does not initialize or restart ordinary storage. A later normal startup is a separate operational event. Disposable tests establish that after the collision is removed, ordinary `createSqliteStorage()` startup creates the pre-existing `idx_deal_hunter_crm_imports_unique_opportunity` index and a newly constructed storage instance caches healthy canonical ownership. The fixture test separately proves startup changes no rows and does not recreate the released historical claim.

Those fixture observations do not authorize or perform a production restart. Production dry run, backup creation, repair apply, restart, integration, and deployment each remain separately gated.
