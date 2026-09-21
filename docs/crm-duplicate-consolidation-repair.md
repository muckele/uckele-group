# CRM Duplicate Consolidation Repair Runbook

> **This runbook is not production authorization.** It does not authorize deployment, production access, a production preview, apply, retry, restore, reconciliation, cleanup, workflow changes, automation changes, or any send. Each production gate below requires its own explicit owner authorization. A successful preview is evidence for review, never authority to apply.

## Scope and immutable incident

This operator surface is SQLite-only and implements repair version `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`. It has no runtime pair selector, reverse mode, cleanup mode, reconciliation mode, sending mode, or generic SQL option. Pooler and Berlin remain separate canonical opportunities.

The checked-in approval descriptor fixes exactly these pairs:

| Pair | Canonical opportunity | Survivor | Historical superseded row | Listing identity |
|---|---|---|---|---|
| Pooler | `opp_683681c2-bd49-4c46-be4f-6d969143d907` | `daa9ea12-786f-4769-b702-d9309525c455` | `b36a4b33-d35c-4e8d-b6c3-b6301030a92b` | `costar:2516010` |
| Berlin | `opp_9b18427d-5fb5-4f92-be31-d92b810061b3` | `0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da` | `8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3` | `costar:2436873` |

The only approved operational reparent is Berlin CRM import `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8`, from the Berlin historical row to the Berlin survivor while its `opportunity_id` stays `NULL`.

The versioned schemas are:

- approval: `crm-duplicate-consolidation-approval-v1`;
- plan: `crm-duplicate-consolidation-plan-v1`;
- manifest: `crm-duplicate-consolidation-manifest-v1`;
- repair type: `crm-duplicate-consolidation`.

## Operator command and inputs

The package command is preview-only by default:

```text
npm run crm:duplicate-consolidation -- <reviewed operator facts>
```

It reads the database location only from the established application storage configuration (`STORAGE_PROVIDER=sqlite` and `SQLITE_PATH`). There is no database-path CLI option and no arbitrary record selector.

Both preview and a later separately authorized apply require the operator facts `--actor`, `--reason`, `--execution-release`, `--tooling-revision`, `--backup-path`, `--backup-manifest-id`, `--backup-sha256`, and exactly one explicit `--checkpoint-evidence <path>`. The reason must be at least 20 characters, the tooling revision must be an exact lowercase Git/SHA identifier, and the backup digest must be an exact lowercase SHA-256.

The checkpoint-evidence file is the sole operator-supplied checkpoint source. The CLI never reads checkpoint facts from environment variables and never mixes the file with fallback facts. The file may contain ordinary JSON whitespace and property ordering, but must be an existing readable regular UTF-8 JSON file, nonempty, and no larger than 64 KiB. Its exact envelope is:

```json
{
  "schema": "crm-duplicate-consolidation-checkpoint-v1",
  "checkpoint": {
    "backupPath": "/absolute/path/to/verified-backup.sqlite",
    "backupManifestId": "verified-backup-manifest-id",
    "backupSha256": "lowercase-64-character-sha256",
    "backupProvider": "sqlite",
    "backupStatus": "verified",
    "backupQuickCheck": "ok",
    "backupForeignKeyViolationCount": 0,
    "flySnapshotId": "verified-fly-snapshot-id",
    "flySnapshotDigest": "lowercase-64-character-sha256",
    "flySnapshotStatus": "created",
    "flyRelease": "exact-deployed-release",
    "toolingRevision": "exact-lowercase-40-to-64-character-sha",
    "createdAt": "2026-09-19T17:00:00.000Z",
    "verifiedAt": "2026-09-19T17:00:00.000Z"
  }
}
```

Those are the only permitted top-level and checkpoint keys. All values are strictly typed and bounded. Timestamps must be canonical UTC ISO values with milliseconds, and `createdAt` must not follow `verifiedAt`; there is no wall-clock TTL. The backup status, SQLite `quick_check`, zero foreign-key violations, snapshot status, release, tooling revision, hashes, identifiers, and the three backup CLI assertions must all match. After validation, the CLI canonicalizes this envelope and binds its SHA-256 digest to the preview and reviewed apply.

Do not put credentials, tokens, contacts, message bodies, notes, document contents, arbitrary environment dumps, raw metadata, or secrets in the checkpoint file or any operator fact. The file must not contain secondary file references that an operator expects the CLI to follow; it follows none.

## Preview artifact procedure

Only after the production-preview gate has been separately authorized:

1. Confirm the exact deployed release and tooling revision, the new current-format application backup and Fly volume snapshot, and all outbound/scheduler/follow-up pauses.
2. Set only the established database configuration, and prepare the bounded checkpoint-evidence file above as a restricted local file. Do not export checkpoint facts as environment variables.
3. Run the package command without an apply mode flag and include `--checkpoint-evidence <path>`. Redirect stdout directly to a new restricted artifact file. Diagnostics are written only to stderr.
4. Hash the captured bytes independently with SHA-256 and parse the captured file independently as one JSON document.
5. Confirm the artifact reports `mode: "preview"`, `applied: false`, and connection evidence `readonly: true`, `fileMustExist: true`, `queryOnly: true`, and `consistentReadTransaction: true`.
6. Independently prove the database logical digest did not change.
7. Review every blocker, relationship/reference classification, raw-row digest, safety fact, exact mutation ledger, `manifestId`, and `planChecksum`.

The CLI writes exactly one canonical JSON document to stdout without a trailing newline. Preserve those bytes verbatim: adding whitespace or reformatting makes the artifact invalid. Preview never writes a repair receipt and never prints or constructs an apply command.

## Backup and safety prerequisites

The September 17 historical backup and volume snapshot are recovery evidence only. They are not sufficient apply authority. After the reviewed code is deployed and startup DDL is verified, create and independently verify a fresh application-consistent SQLite backup and Fly volume snapshot before production preview.

Before preview and again before any separately authorized apply, require all of the following:

- exact SQLite provider and database identity;
- application backup path, manifest ID, lowercase SHA-256, creation time, and independent verification time;
- Fly snapshot ID and lowercase digest;
- deployed release and tooling SHA;
- no active writer;
- durable CRM outreach pause, follow-ups disabled, scheduler disabled, and no current Stage 2 activation;
- no nonterminal or prohibited loser operational state;
- complete expected schema, indexes, triggers, relationship inventory, and raw-row digests.

The apply service independently reopens and verifies the backup against the reviewed plan, uses a single-use storage capability, rechecks the live schema and state under `BEGIN IMMEDIATE`, and fails closed on drift.

## Reviewed artifact and apply gate

An apply is a later and separately authorized operation. It additionally requires all of these exact CLI inputs before writable storage is opened:

- `--apply`;
- `--reviewed-manifest` naming the byte-for-byte canonical preview artifact;
- `--expected-plan-checksum` with the reviewed lowercase SHA-256;
- `--manifest-id` with the reviewed fixed-incident manifest ID;
- the same actor, reason, execution release, tooling revision, backup path, backup manifest ID, and backup SHA-256 recorded in the artifact;
- the same explicitly supplied `--checkpoint-evidence <path>` whose independently validated canonical value and digest exactly match the reviewed artifact checkpoint;
- `--confirm APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1`.

The CLI first validates the evidence file and its complete nested domain, then reads and byte-validates the reviewed artifact, independently validates the artifact checkpoint, compares the two canonical checkpoint representations and digests, and validates the fixed incident, canonical JSON, checksum, manifest ID, operator facts, backup facts, and exact confirmation. Any failure keeps writable-storage construction at zero. Only after all of those checks pass can it open the established writable SQLite storage and delegate to the Task 8 atomic service. Do not normalize, pretty-print, recreate, or edit the reviewed artifact.

This runbook deliberately contains no ready-to-run production apply command. The owner must authorize the exact reviewed artifact and the exact operation separately; preview output alone is not authorization.

## Exact mutation ledger and outcomes

The first valid apply commits exactly four changed business rows in one transaction:

1. insert the Pooler `crm_submission_supersessions` relation;
2. insert the Berlin `crm_submission_supersessions` relation;
3. CAS-update only Berlin legacy import `508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8`;
4. insert one append-only `deal_hunter_cim_repair_manifests` receipt.

It mutates zero contact rows, activity/email/communication history, CIM requests, recommendations, documents/uploads, dispositions, opportunities, aliases, scores/evidence, source observations, reconciliation records, jobs, cleanup records, Pooler imports, or unrelated rows. It sends nothing and makes no provider call.

The expected service outcomes are:

- `repair-required` with `applied: true` for the first exact four-row commit;
- `verified-prior-apply` with `applied: false` and zero mutations only when the exact immutable receipt and complete final state byte-validate;
- typed refusal for drift, partial state, independently satisfied state without the exact receipt, collision, missing authority, or unsafe state.

The principal typed refusal is `CRM_DUPLICATE_CONSOLIDATION_REFUSED`. Storage/schema constraints may also refuse invalid supersession state. Treat every refusal as a stop condition. Never reinterpret a refusal as partial success.

## No automatic retry, audit, and post-apply evidence

Never automatically retry an apply that returns an error, times out, loses its terminal, or has an ambiguous result. Preserve stdout/stderr and the exact inputs, stop writers, and inspect through separately authorized read-only verification. A repeat invocation is permitted only under explicit owner direction and succeeds only as byte-validated `verified-prior-apply`; it never updates the original receipt.

Post-apply verification is a separate gate. Require:

- exact four-row mutation accounting and protected-table digests unchanged;
- the separate CRM supersession audit clean;
- the existing generic CRM integrity audit semantically unchanged and clean;
- `PRAGMA quick_check = ok` and zero `foreign_key_check` rows;
- Pooler and Berlin still distinct, each active projection showing one survivor;
- direct historical rows and combined history still readable with origin provenance;
- no outbox, send, provider, reconciliation, cleanup, or workflow side effect.

Logical reversal is not supported by this CLI. It requires a separately versioned, reviewed, authorized repair with a distinct append-only receipt. Disaster restore also requires a separate recovery plan and explicit loss-window decision.

## Separated production gates

Do not combine these gates:

1. implement and review code/schema in isolation; obtain exact-head CI;
2. separately authorize merge and deploy of that exact revision; verify health, readiness, volume, SQLite integrity, outbound controls, and deployed SHA—without preview;
3. separately authorize and verify a fresh post-deploy application backup and Fly snapshot;
4. separately authorize one default read-only production preview; capture/hash/reparse stdout and prove zero mutation;
5. perform independent owner review of the exact artifact, blockers, inventory, digests, four-row ledger, release/tooling identities, and checkpoint;
6. separately and explicitly authorize one apply bound to that exact artifact/checksum/checkpoint/release/tooling identity and exact confirmation;
7. perform separately gated post-apply verification.

None of these gates authorizes overdue-workflow cleanup, recommendation cleanup, reconciliation, source mutation, sending, Stage 2 activation, automation changes, reverse, restore, or general duplicate consolidation.

## V2 correction is the current operator contract

The UG-P7-01J source-shape and runtime-safety addendum supersedes the earlier V1 artifact assumptions in this runbook. It does not change the approved pairs or the four-row mutation ledger.

Current versioned values are:

- repair `UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2`;
- plan `crm-duplicate-consolidation-plan-v2`;
- manifest `crm-duplicate-consolidation-manifest-v2`;
- approval `crm-duplicate-consolidation-approval-v1`;
- checkpoint `crm-duplicate-consolidation-checkpoint-v1`;
- confirmation `APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2`.

Never use the V1 confirmation shown in the historical section above. Corrected code refuses V1 artifacts, V1 confirmation, missing/corrupt/unknown runtime-safety authority, and reviewed/current authority mismatch before writable storage construction; it does not upgrade an old artifact.

Preview requires four independent safe facts: the durable global CIM pause, the durable `cim-initial-outreach` automation pause, disabled effective follow-ups, and disabled effective automation scheduling. The two selected environment representations must be absent/empty defaults or recognized false tokens and must agree with the effective config. Malformed explicit values refuse. The plan binds exact source identifiers, normalized values, durable-row digests, and the complete authority digest.

For apply, the CLI first compares current config-only facts with reviewed config-only facts. It then uses a short-lived read-only, file-existing, query-only transaction to compare the complete current authority. That connection closes before the writable factory is called. The writable instance captures the same config/environment facts; the service checks them again; and the SQLite `BEGIN IMMEDIATE` transaction re-reads both durable rows and compares complete authority before checking an existing receipt or writing. Exact replay therefore also requires current safe authority and never rewrites its receipt.

The backup proves database state only. Backup reconstruction uses the reviewed config facts as explicitly external authority and re-reads the two durable rows from the backup. It must not be described as proof of live process configuration or global writer quiescence.

The raw Berlin deal-key preimage and its retained evidence are not CLI inputs and must never be copied into a reviewed artifact, repository fixture, log, PR comment, CI secret, or operator command. Ordinary CI deliberately uses synthetic data and must refuse the fixed production digest. Merge readiness additionally requires the privacy-reviewed external restricted acceptance gate against a disposable SQLite database. A passing hosted CI run without that attestation is insufficient.

The restricted gate is a code-verification operation only. It does not authorize or constitute production preview/apply. Production remains split into the seven separate gates above, including a new deployment/checkpoint, exact read-only production preview, independent artifact review, and a separate explicit apply authorization.

## Apply-output privacy correction

The stronger UG-P7-01M recovery gate discovered that the historical restricted harness had not exercised a successful apply through the operator CLI. When that real boundary was exercised, the CLI serialized the repair service's intentionally rich internal result, including postcondition rows, to stdout. The historical acceptance package remains retained as evidence that the stronger gate failed closed, but its earlier CLI-output privacy conclusion is superseded by this correction.

`runCrmDuplicateConsolidationCli` now establishes a structurally closed output boundary for successful apply and verified replay. Its stdout result contains only:

```text
status
mode
applied
mutationCount
manifestId
planChecksum
integrity.valid
integrity.quickCheck
integrity.foreignKeyViolationCount
```

The projector accepts only the two expected apply statuses, enforces their exact applied/mutation-count combinations, binds the returned manifest ID and plan checksum to the reviewed CLI inputs, and requires successful SQLite integrity fields. Malformed internal results fail with a static error. Unknown current or future internal properties are omitted by construction; there is no raw/debug escape hatch. Preview output and all storage, service, transaction, receipt, checkpoint, authority, and four-row mutation semantics are unchanged.

The public regression first failed because a clearly synthetic restricted sentinel survived into successful apply and replay stdout. After the fix, the focused repair/CLI suite passed 202/202, including exact allowlist shape, plain/Base64/hex/URI absence, unknown nested-property exclusion, stderr privacy, malformed-result refusal, and exact manifest/checksum binding.

At code candidate `849d51b4a4e4a3e50cf527302e26afd20b3dbf75`, an independently reviewed external harness (SHA-256 `d2b402837462dc05be5832af83945c90515f04262ab358a91c904ab49c2fb2ca`) then spawned the real CLI for preview, first apply, and verified replay against retained evidence reconstructed only into disposable local SQLite. Its report (SHA-256 `c8baf9f93cd44f2847d8049bbedafc927d2c566e1922bb41352b76135cefffdb`) recorded exact four-row first apply, zero-write/equal-digest replay, five complete rollback cases, immutable receipt refusal, three intended identity-drift refusals, zero-write authority/race refusals, clean SQLite and both audits, and no restricted value or reversible encoding in CLI stdout, stderr, new Git material, or the report. The fixed Berlin preimage was absolutely absent from tracked Git content. No production system was accessed.
