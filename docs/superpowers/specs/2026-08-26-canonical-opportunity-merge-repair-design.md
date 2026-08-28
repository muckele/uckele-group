# Canonical Opportunity Merge Repair Design

**Date:** 2026-08-26

**Status:** Apply-capable implementation complete in the uncommitted feature branch; repair not executed

**Repository baseline:** `2638aaf4ee590839b77fb2cb6d0e0ad72455c5a6` (`main` = `origin/main`)

**Production release context:** v109 (not modified by this work)

## 1. Purpose

Implement one operator-only, incident-specific repair path for a confirmed historical split in canonical Deal Hunter opportunity identity. The repair moves an explicitly approved alias set from one canonical opportunity to another, preserves the losing opportunity as a superseded audit row, resolves the existing identity exception, and records a typed durable manifest.

This is not a new merge heuristic and is not part of normal identity resolution. A future repair requires a new checked-in approval descriptor and code review; runtime input alone can never authorize an arbitrary pair.

The implementation and tests are local only. This work must not stage, commit, push, deploy, access live production, or apply the repair to production.

### 1.1 Structural stop condition resolved by the approved follow-on phase

Implementation review originally found three ordinary paths that admitted superseded rows: semantic enumeration, explicit manual linking, and Stage 2 current evidence. The separately approved 2026-08-27 follow-on phase established explicit historical and exact-active storage contracts in both providers and moved current authority boundaries to the latter.

The resolved design is specified in `2026-08-27-canonical-opportunity-current-semantics-design.md` and its complete caller classification is in `docs/canonical-opportunity-current-semantics-caller-matrix.md`. Historical getters remain unfiltered; current getters require exactly `status = 'active'`. The resolver excludes superseded semantic candidates and fails closed on a historical alias owner, manual linking rejects before mutation, and Stage 2 current evidence and final authorization independently require active canonical status.

The merge plan now records the structural invariant as satisfied with no blockers. The unconditional CLI/service/storage stop was removed only after the new regressions passed. The repair remains dry-run by default and no production repair or Supabase migration was executed.

## 2. Non-goals and hard boundaries

This change must not alter:

- canonical identity matching or semantic matching rules;
- deduplication thresholds or decisions;
- source parsing, URL normalization, or source-row handling;
- scoring rules, score bands/weights/caps/versions, full-backfill authority, or current-set selection policy;
- the authoritative full-backfill identity gate;
- CRM synchronization or reconciliation behavior;
- CIM request creation, delivery, Stage 2, Stage 3, or follow-ups;
- communication, activity, or provider-event behavior;
- Daily Deal Hunter behavior;
- automatic alias creation or ordinary exception resolution;
- Supabase repair mutation behavior. The separately approved exact-active current-authority phase adds only provider-parity function definitions and current-read behavior; it adds no table, column, status value, threshold, policy, or remote repair path.

The repair does not delete either canonical opportunity and does not generically reparent any dependent data. Any blocking entity-dependent state on either canonical ID is an error. Restrictive recipient-global suppression is preserved in place and represented separately as count-only operational state; current Stage 2 activation is authority-granting and fails closed.

## 3. Checked-in approval descriptor

The service owns a checked-in, immutable approval descriptor. The command must match its exception, survivor, and superseded IDs exactly before it may inspect or mutate repair state.

### 3.1 Approved tuple

| Field | Approved value |
|---|---|
| Repair type | `canonical-opportunity-merge` |
| Approval schema | `canonical-opportunity-merge-approval-v1` |
| Exception ID | `8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571` |
| Survivor ID | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| Superseded ID | `opp_c92d0c73-6a47-4fed-b528-6f310745e448` |
| Expected initial status of both opportunities | `active` |
| Expected exception status | `open` |
| Expected exception reason | `conflicting-canonical-aliases` |
| Expected identity evidence version | `cim-opportunity-v1` |

### 3.2 Exact approved alias ownership set

The approval descriptor contains the following exact set of `(aliasType, aliasValue, opportunityId)` tuples. Alias row metadata may be included in a plan snapshot, but authorization to move an alias is determined only by an exact tuple in this list.

The superseded ID must own exactly these three aliases:

| Alias type | Alias value | Approved owner |
|---|---|---|
| `deal-key` | `url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx` | `opp_c92d0c73-6a47-4fed-b528-6f310745e448` |
| `listing-url` | `https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx` | `opp_c92d0c73-6a47-4fed-b528-6f310745e448` |
| `source-identity` | `url:us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx` | `opp_c92d0c73-6a47-4fed-b528-6f310745e448` |

The survivor must own exactly these nine aliases:

| Alias type | Alias value | Approved owner |
|---|---|---|
| `deal-key` | `url:https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `deal-key` | `url:https://www.dealstream.com/d/biz-sale/hvac/acarj0` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `fingerprint-v1` | `0985c4d3eff0153a0793694edbd20f73682a223d2c37830abbc7dfde77256657` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `fingerprint-v1` | `388ed3db60b28f9fb0d12b547549e9513846f06c894356f6c72bff7a50ebdd43` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `listing-id` | `costar:2542991` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `listing-id` | `dealstream:/d/biz-sale/hvac/acarj0` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `listing-url` | `https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `source-identity` | `url:bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |
| `source-identity` | `url:dealstream.com/d/biz-sale/hvac/acarj0` | `opp_cd57a315-feaf-4158-a02e-4bdde97a922e` |

Dry run and apply both compare the entire current alias set on each approved ID to this descriptor. They also query every approved `(aliasType, aliasValue)` globally. They fail if:

- an approved alias is missing;
- either ID owns an additional alias;
- an alias changed owner;
- an approved alias has no owner;
- an approved alias has more than one owner, including a third-party owner;
- any alias planned for movement is not one of the three approved superseded-owner aliases.

No newly discovered alias is automatically added to the plan.

### 3.3 Approved business-evidence facts

Both initial opportunity snapshots must remain compatible with these reviewed facts:

- canonical name: `High Earning HVAC, Plumbing, & Sheet Metal Business and Real Estate!`;
- canonical location: `Las Vegas, Clark, NV, US`;
- normalized city/county/state/country: `las vegas` / `clark` / `nv` / `us`;
- asking price: `5000000`;
- annual revenue: `4500000`;
- annual profit/SDE: `500000`;
- normalized identity name: `high earning hvac plumbing and sheet metal business and real estate`;
- normalized description length: `498`;
- recipient evidence is present;
- identity version is `cim-opportunity-v1`;
- observed stable listing IDs include `costar:2542991` and `dealstream:/d/biz-sale/hvac/acarj0`;
- observed canonical listing URL is the normalized BizBuySell URL in the approved alias set.

Compatibility is checked against these decisive facts rather than requiring byte-for-byte equality of unrelated metadata. The full normalized database snapshots are still included in the dry-run plan; therefore any database change that remains compatible changes the plan checksum and must be reviewed again before apply.

The two rows must also continue to agree exactly with each other on canonical recipient, normalized recipient evidence, normalized description content, normalized location evidence, and source-ID evidence. This pairwise check prevents same-length description or broker drift from being treated as compatible merely because the high-level numeric facts still match.

## 4. Provider boundary

The command and service are SQLite-only for this incident.

- The service checks the active storage object's explicit `provider` value.
- Any value other than exactly `sqlite`, including `supabase`, missing, or unknown, is refused before plan generation or mutation.
- Only SQLite storage exposes the incident transaction method.
- There is no Supabase fallback, SQL generation, or provider-neutral mutation path.
- The service requires its storage object to be supplied explicitly; it does not call ordinary application storage startup as a default side effect.
- The standalone dry run reads the configured SQLite path through an incident-specific snapshot inspector and never calls the normal migrating storage factory.

All SQLite-backed tests and final validation run with repository-compatible Node 22.

## 5. Interface and default behavior

The command is a narrow script exposed through one npm script. Proposed invocation:

```text
npm run cim:canonical-merge -- \
  --exception-id <id> \
  --survivor-id <id> \
  --superseded-id <id> \
  --actor <accountable-operator> \
  --reason <human-reviewed-reason>
```

This is always a dry run unless `--apply` is present.

Dry run requires:

- the exact checked-in tuple;
- a non-empty actor;
- a non-empty human reason.

Apply additionally requires all of:

- `--apply`;
- the exact checked-in approval tuple;
- `--expected-plan-checksum <sha256>` matching a fresh in-transaction plan;
- verified application-consistent SQLite backup evidence;
- the global/general CIM outreach pause active;
- the exact confirmation phrase;
- actor;
- reason.

There is no override flag for any gate. Apply proceeds only when every listed gate and the transaction-time drift checks succeed.

The confirmation phrase is:

```text
MERGE opp_c92d0c73-6a47-4fed-b528-6f310745e448 INTO opp_cd57a315-feaf-4158-a02e-4bdde97a922e FOR EXCEPTION 8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571
```

The command never pauses or unpauses outreach. It observes the global pause at apply time and refuses if the pause is not already active.

## 6. Dry-run plan

Dry run is read-only. It constructs a deterministic plan that includes:

- repair and approval schema versions;
- exact approved tuple;
- actor and reason;
- complete normalized survivor and superseded opportunity snapshots;
- complete normalized exception snapshot;
- exact current aliases for both IDs, sorted by type/value/owner;
- global ownership observations for every approved alias key;
- exactly the three alias ownership updates to perform;
- dependent-state scan results for both IDs;
- resolver/current-path postcondition checks to run after apply;
- supersession update preview;
- exception-resolution update preview;
- typed manifest identity and payload preview.

Generated timestamps, backup paths, and other nondeterministic values are excluded from the checksum input. The checksum is SHA-256 over a stable, canonical JSON encoding of the plan input. The rendered plan may include a generation timestamp outside the checksummed object.

Dry run performs no `INSERT`, `UPDATE`, `DELETE`, DDL, migration, backfill, pause change, manifest write, or backup creation against the configured database. It first requires an existing WAL-mode SQLite file, fingerprints the database and WAL before and after copying, and retries or refuses if either changes during capture. It opens only the resulting private temporary snapshot with `readonly`, `fileMustExist`, and `query_only`, runs `quick_check`, and validates an explicit table/column contract for every repair scan. Missing schema is a refusal; it is never filled in by startup DDL. The temporary snapshot is removed on success and failure. Full-process regressions prove both a standalone database and a live database with committed WAL state retain byte-identical database/WAL/SHM files and an unchanged source-directory file set.

## 7. Drift and dependent-state checks

Both dry run and the in-transaction apply re-check every invariant.

### 7.1 Opportunity and exception checks

- Both IDs exist exactly once.
- Both are distinct and have status `active` before first apply.
- Neither has supersession metadata before first apply.
- The exception exists, is `open`, has reason `conflicting-canonical-aliases`, and names exactly these two candidates without additions or omissions (candidate order is irrelevant).
- The exception has not already been resolved or repurposed.
- Approved business facts still match.

### 7.2 Classified relationship-state contract

The v2 plan distinguishes blocking entity dependencies from three other explicit current-schema classifications: relationships redundant through a scanned parent, preserved global/recipient operational state, and intentionally excluded fields with documented reasons. A schema-derived inventory guard refuses any future relationship-like table column until it is classified. This check runs during read-only planning, backup-plan reconstruction, and again inside the live apply transaction.

Only blocking entity dependencies are required to be zero. `email_suppressions` matching the deterministic approved recipient are reported by count under `preservedOperationalState`, without raw addresses, and are never changed. Current Stage 2 activation is reported under separate authority-granting state and blocks planning. These additions use `canonical-opportunity-merge-plan-v2`; earlier plan checksums cannot authorize apply.

Both IDs must have zero unexpected blocking direct and indirectly reachable state at dry-run and apply time. The blocking scan covers, at minimum:

- persisted opportunity scores, current-triage rows, and score evidence;
- CRM submissions linked by canonical opportunity ID or approved alias-derived deal key/listing URL;
- Deal Hunter CRM imports and reconciliation items;
- CIM requests and reviews;
- CRM communications and their opportunity/submission/request linkage;
- email provider events reachable from affected submissions, communications, requests, or opportunity metadata;
- CRM activity events reachable from affected opportunity/submission/request/communication state;
- active or historical opportunity claims, recipient claims, recipient overrides, and Stage 2 decisions tied to either ID or its affected aliases;
- follow-up state and any other canonical-ID-bearing or alias-derived dependent record discovered in the traced SQLite schema.

The implementation records per-category counts and stable identifiers in the plan. Any nonzero blocking result fails closed. Preserved operational counts use their separate section and policy above. The repair does not reparent, rewrite, or delete either class of state.

### 7.3 Alias checks

The exact ownership checks in section 3.2 apply before checksum generation and again inside the apply transaction. A unique index is not treated as sufficient evidence: the query result itself must show exactly one approved owner per alias key and no third owner.

## 8. Normal resolution and current-opportunity safety

The ordinary resolver's matching rules, thresholds, parsers, and alias generation remain unchanged. Its candidate and direct-identity authority now use the explicit current-active contract. Before the losing row may be marked superseded, the implementation establishes both (a) the incident-scoped postconditions below and (b) the structural rule that all normal identity-resolution/current-opportunity paths reject or exclude superseded rows.

The approved source observations are the three source records for the BizBuySell, BusinessesForSale, and DealStream URLs in the approved alias set. Their deduplicated current candidate carries the three deal-key URLs, the three normalized source identities, the CoStar and DealStream listing IDs, the normalized BizBuySell listing URL, and fingerprint `388ed3db60b28f9fb0d12b547549e9513846f06c894356f6c72bff7a50ebdd43`. Post-mutation validation, still inside the transaction, verifies:

- all 12 approved alias keys resolve to the survivor;
- zero aliases remain owned by the superseded ID;
- none of those alias keys resolves to any third ID;
- the exact-alias lookup used by the ordinary resolver maps every approved current observation's durable aliases to the survivor only;
- no alias/current-opportunity lookup used by the repair postcondition returns the losing ID for those observations.

The current-active contract closes the three counterpaths recorded in section 1.1. The enabled post-commit regression proves all approved HVAC observations resolve only to the survivor, direct historical lookup retains the loser, current lookup rejects it, and semantic fallback never admits the superseded row as a candidate.

## 9. Apply transaction

Apply uses one SQLite immediate transaction. Section 8 is now satisfied in the implementation, so the intended order is:

1. Validate the active provider is SQLite and validate non-storage gates (approval tuple, actor, reason, confirmation phrase, verified backup evidence).
2. Begin the SQLite transaction.
3. Re-read the global CIM outreach pause from SQLite and require it to be active.
4. Check for an existing typed manifest and handle only a valid identical completed repair as idempotent.
5. Rebuild the complete dry-run plan from transaction-visible state.
6. Require its checksum to equal `--expected-plan-checksum` exactly.
7. Update ownership of only the three approved BusinessesForSale alias rows.
8. Verify all approved alias ownership and normal-resolution postconditions.
9. Mark the losing opportunity `superseded` and merge audited supersession fields into its existing metadata without deleting unrelated metadata.
10. Resolve the exact exception with actor, reason, decision, timestamp, survivor, superseded ID, and plan checksum.
11. Insert the typed manifest.
12. Re-read and verify final state, then commit.

Any thrown error rolls back alias ownership, opportunity status/metadata, exception resolution, and manifest insertion together.

The superseded opportunity remains stored. The survivor remains `active`. The repair does not copy the losing opportunity's snapshot into the survivor because the reviewed snapshots already agree and the approved operation is identity ownership repair, not content reconciliation.

## 10. Supersession metadata

The losing opportunity keeps its existing metadata and receives an auditable object equivalent to:

```json
{
  "canonicalOpportunityMerge": {
    "repairType": "canonical-opportunity-merge",
    "schemaVersion": 1,
    "mergedInto": "opp_cd57a315-feaf-4158-a02e-4bdde97a922e",
    "supersededOpportunityId": "opp_c92d0c73-6a47-4fed-b528-6f310745e448",
    "exceptionId": "8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571",
    "actor": "<actor>",
    "reason": "<reason>",
    "planChecksum": "<sha256>",
    "supersededAt": "<ISO-8601 timestamp>"
  }
}
```

## 11. Typed manifest and collision safety

The existing `deal_hunter_cim_repair_manifests` table may be reused only under this explicit typed contract:

- `id` uses the reserved namespace `canonical-opportunity-merge:v1:` followed by a deterministic digest of the approved tuple. Historical CIM repair IDs use another namespace, so keys cannot collide by construction.
- the table's `mode` column is set to `canonical-opportunity-merge`, not a generic CIM repair mode;
- both `manifest` and `metadata` JSON contain `repairType: "canonical-opportunity-merge"`, schema version, exact tuple, and plan checksum;
- the completed status is explicit and the stored manifest includes exact moved aliases, actor, reason, timestamps, verified backup evidence summary, and final-state observations.

If a row already exists at the deterministic manifest ID, the service must parse and validate its type, schema version, tuple, status, and checksum before treating it as this repair. An untyped row, malformed row, historical CIM repair row, different tuple, incomplete status, or different checksum is a hard collision/error. It is never overwritten or interpreted heuristically.

This contract makes reuse unambiguous. If implementation discovers that the deployed table semantics cannot enforce these checks, it must stop and report rather than overload the table.

## 12. Backup evidence

Apply consumes the repository's existing application-consistent backup-verification result. It must establish at least:

- backup manifest provider is SQLite;
- backup verification succeeded;
- database artifact and digest in the manifest were verified;
- the database artifact is re-hashed immediately before it is opened for repair-plan reconstruction;
- unverified `-wal`, `-shm`, or rollback-journal sidecars are absent;
- plan reconstruction uses a private in-memory/query-only image and never creates or changes files inside the verified bundle;
- the backup reconstructs the exact reviewed pre-merge plan checksum;
- the backup contains the same active outreach-pause epoch as the live database and was created no earlier than that pause;
- backup evidence is explicit and available for audit.

The manifest would store a bounded evidence summary (manifest identity, verified digest, created/verified timestamps, matched plan checksum, pause epoch, and verification status), not database contents. A missing, malformed, non-SQLite, stale, swapped, pre-pause, or plan-mismatched backup refuses apply.

## 13. Idempotency

Idempotency is manifest-led and exact:

- A repeated apply with the same approved tuple and exact completed plan checksum returns `already-applied` with the stored result and performs no writes.
- The service first validates that the stored typed manifest and current final state agree: survivor active, loser superseded into that survivor, exception resolved as that decision, all approved aliases owned only by survivor, and no unexpected dependent state.
- A different checksum, different actor/reason plan, stale tuple, malformed manifest, or final-state drift fails.
- A dry run after completion reports the already-applied state without trying to reconstruct a pre-merge plan.

Idempotency does not permit a caller to bypass confirmation, backup, pause, actor, reason, tuple, or checksum gates for an apply invocation.

## 14. Error model

Errors are explicit and fail closed. Stable categories include:

- unsupported storage provider;
- unapproved tuple;
- missing actor or reason;
- opportunity missing or status/snapshot drift;
- exception missing or drifted;
- exact alias-set or ownership drift;
- third-party alias ownership;
- unexpected dependent state;
- invalid or missing backup evidence;
- outreach not paused;
- wrong confirmation phrase;
- missing, wrong, or stale checksum;
- manifest collision/type mismatch;
- transaction/postcondition failure.

The CLI exits nonzero for refusal or failure and prints structured JSON suitable for operator review. It must not print secrets or database contents beyond the bounded plan evidence.

## 15. Test strategy

Implementation is test-first. SQLite-backed tests run on Node 22 and use isolated temporary databases. Production data and production endpoints are never used.

Focused coverage proves:

1. Dry run returns the exact 12-alias ownership set, exactly 3 moves, and a stable checksum.
2. Dry run writes nothing, including no manifest.
3. Correct apply moves exactly the 3 approved aliases.
4. Losing opportunity remains stored and is marked `superseded` with `mergedInto` audit metadata.
5. Survivor remains active.
6. Exception is resolved with the approved decision, actor, reason, IDs, timestamp, and checksum.
7. A typed, uniquely keyed canonical-merge manifest is persisted.
8. A third-party owner for an approved alias causes refusal.
9. A newly appearing score/evidence/current-triage row on either ID causes refusal.
10. Newly appearing CRM state on either ID or its alias-derived identity causes refusal.
11. Newly appearing CIM, communication, email-event, or activity state causes refusal.
12. Active/dependent claim state causes refusal.
13. Exception candidate/status/reason drift causes refusal.
14. Alias appearance, disappearance, owner change, duplicate/third owner, or metadata/set drift causes refusal.
15. An incorrect or reversed survivor tuple is unapproved and refused.
16. Wrong confirmation phrase causes refusal.
17. Missing or invalid backup evidence causes refusal.
18. Outreach not paused causes refusal.
19. Missing, wrong, or stale plan checksum causes refusal.
20. A failure injected after alias mutation rolls back every mutation.
21. An identical second apply is explicit and write-free/idempotent; a different checksum fails.
22. Existing normal canonical resolution remains unchanged, and all approved post-merge HVAC observations resolve only to the survivor.
23. Existing authoritative full-backfill identity invariant and its fail-closed behavior remain unchanged.
24. Any non-SQLite provider is refused before dry run or apply.
25. A manifest row with the same deterministic key but absent/wrong repair type is refused as a collision.
26. Unexpected dependent state on the survivor is refused just as it is on the losing ID.

Existing identity, historical CIM repair, storage, and authoritative-backfill regressions are rerun alongside the focused repair suite.

## 16. Operator runbook requirements

Documentation must state:

- this command is only for a checked-in, independently approved descriptor;
- dry run is mandatory before any later production apply;
- review includes exact tuple, all alias owners, zero dependents, planned changes, and checksum;
- a fresh application-consistent verified SQLite backup is required;
- the general CIM outreach pause must already be active;
- separate apply authorization is required;
- apply requires the exact checksum, phrase, actor, and reason;
- post-apply audit verifies alias ownership, supersession, exception, manifest, zero dependents, and existing resolver behavior;
- the tool never automatically unpauses outreach;
- the tool must never be used to bypass the ordinary canonical identity or full-backfill guards.

## 17. Acceptance criteria

The implementation is ready for independent code review as an apply-capable repair only when:

- the checked-in descriptor contains all 12 exact alias ownership tuples above;
- dry run and apply enforce every gate in this specification;
- ordinary identity/current-authority behavior changes are limited to the approved exact-active boundary, with matching SQLite/Supabase semantics and no threshold/parser/scoring-policy/full-backfill changes;
- all focused and regression tests pass under Node 22;
- `git diff --check` passes;
- `npm run check` passes under Node 22;
- the working tree contains only intentional, uncommitted implementation/specification/runbook changes;
- no production access or mutation occurred.

The structural criteria are met in the uncommitted implementation: all nine original apply-success/idempotency/drift/rollback acceptance tests are enabled and the focused merge suite passes with zero skips. Production execution still requires a separate operational decision and is outside this implementation task.
