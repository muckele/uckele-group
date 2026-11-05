# Canonical Opportunity Merge Repair Runbook

> **Implementation status:** Apply-capable and ready for independent read-only review in the uncommitted feature branch. The separately approved current-authority phase closed the superseded-row structural gap in SQLite and Supabase, and all nine original merge-apply acceptance tests are enabled and passing. This task did not execute the repair, apply the Supabase migration, access production, or authorize a production apply window.

## Purpose and authorization boundary

`npm run cim:canonical-merge` is an operator-only, incident-specific repair command for a canonical Deal Hunter opportunity split that has already received an independent human identity decision. It is not an automatic merge heuristic and it must not be used to bypass the ordinary canonical resolver, current-triage policy, or full-backfill authority gate.

The checked-in approvals are intentionally incident-specific. The historical HVAC approval accepts only this exact tuple:

- identity exception: `8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571`
- survivor: `opp_cd57a315-feaf-4158-a02e-4bdde97a922e`
- superseded duplicate: `opp_c92d0c73-6a47-4fed-b528-6f310745e448`

The September 11 Garage Door approval is selected only with `--incident garage-door-2026-09-11`; it does not accept tuple overrides:

- identity exception: `9b0502e83bb7deee1791b87169873a00a8565c61c76f7ba47699618d4af500df`
- survivor: `opp_e0237cfb-5d23-43ab-a2f6-c3e66ce188f6`
- superseded duplicate: `opp_a8289b2f-4be2-4a34-81d1-21b046b2f615`
- alias move: only `fingerprint-v1:a4088c416937e7a58de28ca885e22500be3234a556d7a808281bf4c4ddc50454`

The November 2 Precision Carbon approval is selected only with `--incident precision-carbon-2026-11-02`; it does not accept tuple overrides. Its full runbook is in [Precision Carbon incident (pair-scoped)](#precision-carbon-incident-pair-scoped) below.

The command refuses every other incident or tuple. Each checked-in descriptor fixes the complete expected alias keys, values, and owners; the Garage approval also fixes every deterministic alias row ID. A missing, added, changed, duplicated, or third-party-owned alias refuses both dry run and apply.

The Garage approval was the first exception to the historical zero-dependency precondition; the pair-scoped Precision Carbon approval below is the second. It permits exactly 49 loser observations, 168 survivor observations, 45 colliding observation keys, one survivor score, 12 survivor score-evidence rows, and three matching seen-history rows. The plan records full-row deterministic digests for each preserved owner set and for seen history. Those rows remain attached to their existing owners and receive no writes. All CRM, CIM, operator-fact, disposition, communication, email, source-health, and scheduled-job relationship categories remain exact-zero blockers.

This tool is SQLite-only. It refuses every other active storage provider before backup verification or repair execution. The service requires explicitly supplied storage and never starts ordinary application storage implicitly. Do not adapt this command to a remote provider during an incident.

## What the repair may change

In one immediate SQLite transaction, the approved apply may:

1. Move only the three approved BusinessesForSale aliases from the losing ID to the survivor.
2. Leave all nine existing survivor aliases in place.
3. Mark the losing opportunity `superseded` while retaining the row and all existing metadata.
4. Add explicit, checksummed `canonicalOpportunityMerge` audit metadata to that losing row.
5. Resolve only the approved identity exception with the actor, reason, decision, timestamp, survivor, losing ID, and plan checksum.
6. Insert one namespaced, typed `canonical-opportunity-merge-manifest-v1` record under its deterministic manifest key.

The repair never deletes either opportunity and never generically reparents scores, score evidence, current-triage state, source observations, CRM records, CIM records, communications, provider events, activities, claims, follow-up state, or historical identity evidence. Except for the exact Garage preservation topology above, any blocking entity-dependent state on or indirectly associated with either approved ID causes a refusal. Recipient-global suppression is deliberately different: it remains restrictive operational state, is reported only by counts, and is never removed, rewritten, or treated as entity ownership.

## Preconditions

Do not begin an apply procedure until all of the following are true:

- The checked-in approval descriptor and implementation have received independent code review.
- A separate operator has authorized this exact survivor decision and apply window.
- The deployed code exactly matches the independently reviewed release.
- The active storage provider is confirmed to be SQLite.
- No one is simultaneously editing the relevant opportunities, aliases, exception, or dependent state.
- Global CIM outreach can remain paused through apply and the complete post-apply audit.
- A fresh application-consistent backup can be created and independently verified.

Dry run is read-only and does not require the outreach pause or a backup. It does not invoke the normal SQLite storage factory, migrations, or backfills. Instead it fingerprints a stable WAL-mode database-plus-WAL view, copies that view to a private temporary directory, and inspects only the copy with SQLite `readonly`, `fileMustExist`, `query_only`, and `quick_check`. The configured database and its WAL/SHM files remain untouched. Missing required repair schema, an active rollback journal, a non-WAL source, or source changes during capture cause a refusal rather than an implicit schema change. Actor and reason are nevertheless mandatory; there is no implicit audit identity.

The dry-run result includes `applyBlocked: false`, an empty `applyBlockers` array, and the deterministic proposed plan/checksum for review. That only describes implementation readiness: a successful dry run is not production authorization, and every independent apply gate below remains mandatory.

## 1. Independently review the checked-in approval

Before any production command, compare the checked-in approval descriptor with the independently authorized incident evidence. Review:

- the exact exception, survivor, and losing IDs;
- the business snapshot facts;
- all twelve alias type/value/owner tuples;
- the exact three planned alias moves;
- the source-observation resolver postconditions;
- every zero blocking-entity-dependency category;
- the `canonical-opportunity-merge-plan-v2` relationship-inventory schema, digest, four classification counts, count-only preserved suppression state, and zero current authority-granting Stage 2 activations;
- the deterministic manifest namespace and schema.

Stop if the approved evidence is incomplete or the intended decision differs in any way. Do not edit the descriptor during the apply window to accommodate drift.

### Production-derived legacy relationship schema contract

The v1 relationship inventory contains 328 entries. Its reviewed classification counts are 166 blocking entity dependencies, 68 relationships redundant through a scanned parent, 54 preserved global/recipient operational fields, and 40 explicit exclusions. Enforcement counts are 278 material scanner paths, 10 independent gates, 12 approval preconditions, and 28 explicit exclusions. The current inventory checksum is `024ae57efda4abe6f53c341601f76f13b6177cd4a485ed45fc5dcf87dcb0d4a8`.

Historical SQLite installations can retain three relationship-bearing tables that a fresh current schema does not create. Their seven relationship-like columns use the same inventory and enforcement machinery as every current-schema entry:

| Column | Classification | Enforcement |
| --- | --- | --- |
| `admin_magic_links_legacy_v1.email` | explicitly irrelevant/excluded authentication audit identity | `excluded.adminAuthentication` |
| `deal_hunter_candidates.run_id` | redundant through the scanned legacy candidate row | `dependentState.records.legacyDealHunterCandidates` |
| `deal_hunter_candidates.source_url` | blocking entity dependency | `dependentState.records.legacyDealHunterCandidates` |
| `prospect_discoveries.run_id` | redundant through the submission-linked discovery row | `dependentState.records.linkedCrmState` |
| `prospect_discoveries.source_id` | redundant through the submission-linked discovery row | `dependentState.records.linkedCrmState` |
| `prospect_discoveries.submission_id` | blocking entity dependency | `dependentState.records.linkedCrmState` |
| `prospect_discoveries.website_url` | redundant through the submission-linked discovery row | `dependentState.records.linkedCrmState` |

These tables are marked `optional-legacy`: a table may be absent, but its schema is strict when present. Every classified relationship column must exist, and any new unclassified relationship-like column still refuses the repair. Schema validation uses SQLite's complete `pragma_table_xinfo` view, so ordinary columns (`hidden=0`), virtual-table implementation columns (`hidden=1`), virtual generated columns (`hidden=2`), and stored generated columns (`hidden=3`) all pass through the same fail-closed relationship classifier. This is a table-presence contract, not a validator exception for particular table or column names.

The legacy candidate scanner projects only `id` and `source_url`, compares both sides with the same canonical listing-URL normalization used by the approved HVAC listing evidence, and never uses substring matching. Its dependent-state result contains the exact match count and at most 50 opaque candidate identifiers; it never contains URLs, candidate payloads, broker/contact fields, or source text. Any match is blocking.

Retired prospect discovery relevance remains mediated solely by `submission_id`. Run, provider-source, and website fields are subordinate data on a submission-linked row. An unlinked retired discovery does not become a blocker merely because `website_url` resembles or equals an approved listing URL.

The schema-only regression overlay in `test/fixtures/production-derived-legacy-relationship-schema.sql` contains no rows or production values. Tests compose it with the repository-created current schema, require exactly the seven additional relationship-bearing columns above, and prove both complete classification and fail-closed future drift. `canonical-opportunity-merge-plan-v2` remains unchanged; because the inventory digest is part of the plan, every plan checksum generated before this inventory revision is stale and must not be preserved or reused.

## 2. Run the read-only dry run

Use Node 22 and the exact deployed environment. Supply a real accountable actor and a specific, reviewed human reason:

```bash
npm run cim:canonical-merge -- \
  --exception-id 8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571 \
  --survivor-id opp_cd57a315-feaf-4158-a02e-4bdde97a922e \
  --superseded-id opp_c92d0c73-6a47-4fed-b528-6f310745e448 \
  --actor '<accountable-operator>' \
  --reason '<specific independently reviewed merge reason>'
```

Omitting `--apply` is what makes this a dry run. There is no separate mutation default or apply alias.

Capture the formatted JSON output in the incident record. Do not treat a failed or partially captured invocation as approval to apply.

For the Garage Door incident, select the immutable approval rather than supplying IDs:

```bash
npm run cim:canonical-merge -- \
  --incident garage-door-2026-09-11 \
  --actor '<accountable-operator>' \
  --reason '<specific independently reviewed Garage Door merge reason>'
```

Review its `preservedIncidentState` counts, observation collision count, stable seen-history IDs/timestamps, row digests, empty historical exception candidate array, and alias-derived expected owners. A nonempty candidate array or any changed count/digest requires a new reviewed plan; the command does not repair the diagnostics candidate-array defect.

## 3. Review the exact dry-run plan

Two people should review the output against the checked-in approval. At minimum, verify:

- `mode` is `dry-run` and `applied` is `false`;
- both opportunity snapshots still match the approved facts and both are active;
- the identity exception is pristine, open, and contains exactly the two approved candidates;
- `observedAliases` contains exactly twelve rows with the approved owners;
- `globalAliasOwnership` proves each alias type/value has exactly one owner and no third-party owner;
- `aliasMoves` contains only the three approved BusinessesForSale aliases;
- every blocking `dependentState` count is zero for both IDs and alias-derived references;
- `relationshipInventory` matches the reviewed 231-entry v1 inventory digest and classifies the current and optional-legacy relationship-bearing schema into all four documented categories;
- `dependentState.counts.legacyDealHunterCandidates` is zero; any nonzero count represents a canonical-normalized legacy source-URL match and is a blocker;
- `preservedOperationalState.emailSuppressions` contains only deterministic resolution and integer counts (never a raw address or suppression row), and its restrictive presence is not a blocker;
- `authorityGrantingOperationalState.stage2Activations.activeCount` is zero;
- survivor remains active and loser becomes superseded in the mutation description;
- resolver safety expects all approved observations to resolve to the survivor and zero aliases to remain on the loser;
- the manifest ID is in the `canonical-opportunity-merge:v1:<digest>` namespace;
- the 64-character `planChecksum` is recorded exactly.

Any drift is a stop condition. A future relationship-like SQLite column that is not in the checked-in inventory refuses planning instead of being silently ignored. Do not broaden the alias list, add reparenting, edit dependent records, remove a suppression, close the exception manually, or produce a new approval during the same apply attempt.

## 4. Obtain separate apply authorization

Dry-run success does not authorize mutation. Record a separate approval that names:

- the exact tuple;
- the survivor decision;
- the exact plan checksum;
- the actor and reason used to create that checksum;
- the planned backup and pause procedure;
- the apply window and post-apply auditor.

Changing the actor or reason changes the plan checksum and requires a new dry run and review.

## 5. Pause global CIM outreach outside this tool

Use the existing operations control to pause global CIM outreach. Confirm the persisted global pause is active before apply.

The repair command does not pause outreach and never unpauses it. It checks the pause before entering the service apply path and rechecks it inside the same immediate SQLite transaction that performs the repair.

If the pause is absent or changes before the transaction, apply refuses.

## 6. Create and independently verify a fresh backup

Create a fresh application-consistent SQLite backup using the existing backup operation. Do this after the outreach pause and as close to apply as operationally practical:

```bash
npm run backup:create
```

Independently verify the resulting bundle and retain its absolute bundle path:

```bash
npm run backup:verify -- --bundle '<absolute-backup-bundle-path>'
```

The apply command resolves the exact bundle path, runs `verifyBackupBundle` before opening writable production storage, and passes that same resolved path into the repair service. The service deliberately runs the production `verifyBackupBundle` implementation again against that exact path and derives every database path, size, SHA-256, timestamp, provider, and manifest-version field from its own fresh result. Caller-supplied verification booleans or manifest metadata are not backup authority.

The service then re-hashes the verified database snapshot, refuses any unverified SQLite WAL/SHM/rollback-journal sidecar, loads a private in-memory/query-only image without creating or changing bundle files, runs SQLite `quick_check`, reconstructs the exact reviewed pre-merge plan, and requires the snapshot to contain the same active outreach-pause epoch as the live database. The bundle creation time must not predate that pause. A valid but unrelated, older, swapped, unpaused, or plan-mismatched backup is refused.

Stop if verification is not unequivocally successful. Do not have this repair command create a replacement backup.

## 7. Separately authorized future apply procedure — not executed in this task

Do not run this section merely because the implementation is apply-capable. It is the exact future operational procedure for a separate, explicitly authorized production window after independent review of this complete uncommitted change set. The current task grants no production access or repair-execution authority.

Use the exact reviewed checksum, the same actor and reason that produced it, the verified bundle path, and this exact confirmation phrase:

```text
MERGE opp_c92d0c73-6a47-4fed-b528-6f310745e448 INTO opp_cd57a315-feaf-4158-a02e-4bdde97a922e FOR EXCEPTION 8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571
```

The separately approved future apply command would be:

```bash
npm run cim:canonical-merge -- \
  --exception-id 8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571 \
  --survivor-id opp_cd57a315-feaf-4158-a02e-4bdde97a922e \
  --superseded-id opp_c92d0c73-6a47-4fed-b528-6f310745e448 \
  --actor '<same-accountable-operator>' \
  --reason '<same-specific-reviewed-reason>' \
  --apply \
  --expected-plan-checksum '<exact-reviewed-64-character-checksum>' \
  --backup '<absolute-verified-backup-bundle-path>' \
  --confirm 'MERGE opp_c92d0c73-6a47-4fed-b528-6f310745e448 INTO opp_cd57a315-feaf-4158-a02e-4bdde97a922e FOR EXCEPTION 8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571'
```

The transaction re-reads every dry-run invariant—including the current relationship schema inventory, preserved-state counts, and absence of current Stage 2 grant authority—and recomputes the full plan checksum before it mutates anything. It moves aliases first, verifies that every approved source observation can resolve only to the survivor, and only then marks the losing row superseded. Any error rolls back aliases, opportunities, exception state, and manifest insertion together.

Do not automatically retry an ambiguous or interrupted result. Preserve logs and inspect the deterministic manifest and final database state first. A confirmed identical completed apply returns `alreadyApplied: true` without writes, but that behavior is an audit aid—not permission to retry blindly.

## 8. Perform the post-apply audit while outreach remains paused

This section is conditional on a later independent production authorization and a successful apply; neither occurred in this task.

Keep outreach paused and independently verify all of the following:

- The survivor exists and remains `active`.
- The losing opportunity still exists, is `superseded`, and identifies the exact survivor in its merge metadata.
- All unrelated losing-row metadata remains intact.
- Exactly twelve approved aliases exist and every one is owned only by the survivor.
- The losing opportunity owns zero aliases.
- No approved alias type/value has a duplicate or third-party owner.
- The exact exception is `resolved` with the approved actor, reason, decision, tuple, timestamp, and checksum.
- Exactly one manifest exists in the canonical merge namespace at the deterministic key.
- The manifest row, embedded manifest, and metadata all identify `canonical-opportunity-merge` and `canonical-opportunity-merge-manifest-v1`.
- The manifest contains the reviewed checksum, exact three alias moves, tuple, actor, reason, timestamp, and bounded verified-backup evidence.
- Every blocking dependent-state category remains zero; nothing was deleted or reparented.
- Any pre-existing recipient-global suppression row remains byte-for-byte unchanged and continues to restrict outreach.
- Read-only evidence confirms BizBuySell, BusinessesForSale, DealStream, and the deduplicated HVAC observation resolve through approved durable aliases only to the survivor. Do not use a writeful production resolver invocation merely as an audit probe.
- An identity input without approved durable alias evidence cannot select the superseded row.
- The authoritative full-backfill identity invariant and its separate authority gate remain unchanged and healthy.

Run the same dry-run command immediately after completion, before any normal source observation is allowed to add identity evidence. A valid unchanged completed repair reports `alreadyApplied: true` and performs no write. Any malformed manifest or final-state mismatch fails rather than claiming idempotency. In particular, the ordinary resolver currently normalizes the DealStream observation into a thirteenth `listing-url` alias on the survivor; that is safe ownership-wise but is still an appearance outside the exact twelve-row approval, so a later repair replay must fail closed and require audit rather than claim idempotency.

## 9. Unpause only through a separate operational decision

The merge repair never changes the pause setting. Do not automatically unpause after a successful transaction.

Unpause only after the complete audit is recorded, normal full-backfill readiness is independently confirmed, and a separate authorized operator decides outreach may resume. This command is not evidence that current-triage eligibility, full-backfill authority, CRM/CIM automation, or sending gates may be bypassed.

## Refusal and escalation rules

Stop and escalate for independent investigation if any of these occurs:

- active provider is not SQLite;
- tuple is not the checked-in approved tuple;
- alias set or owner differs by even one row;
- a third-party owner or duplicate alias type/value exists;
- opportunity facts or exception state drifted;
- any blocking entity-dependent state is nonzero;
- any current authority-granting Stage 2 activation exists;
- any current relationship-like SQLite column is absent from the checked-in inventory;
- an untyped, malformed, colliding, or duplicate typed manifest exists;
- backup verification fails;
- outreach is not globally paused for apply;
- recomputed checksum differs;
- transaction outcome is ambiguous;
- post-apply resolver, manifest, or final-state audit fails.

Do not repair those conditions by weakening this tool, editing production state by hand, or adding generic reparenting during the incident.

## Precision Carbon incident (pair-scoped)

Identity exception `0cfa01f1fb4666903281f0c8d2b2da00027b307446a266c5adba7e0192343f56` (`conflicting-canonical-aliases`, opened 2026-11-02): "Precision Carbon & Graphite Manufacturer" is listed on BizBuySell (Alameda, CA, listing 2561135) and DealStream (Hayward, CA). The app created one deal per listing on 2026-10-31. Since 2026-11-02 the Sheet presents both listings as one row, and that row's aliases belong to both deals. The owner confirmed it is one business.

### Survivor rule

The checked-in descriptor keeps the earliest-created deal and retires the later one:

- **Kept:** `opp_8cc53064-bf61-4d2f-9862-2694c2773e0e` (BizBuySell, created 15:00:32.916Z).
- **Retired:** `opp_910e6860-deea-4e3d-bcf2-20c6e0a0fc92` (DealStream, 15:00:38.304Z).

Neither deal has owner review, Pursue, CIM campaign, CRM, or operator state that would favor the later row. Keeping the earliest row keeps the deal's first-discovery time, discovery evidence, and digest history continuous. Here it is also the deal that holds the broker recipient, the BizBuySell listing id, and the fingerprint alias; the DealStream deal has no recipient. The rule is recorded as `survivorRule: 'earliest-created'` in the descriptor and re-checked against both deals' `created_at` on every run.

The descriptor values come from the owner-approved read-only production capture of 2026-11-05:

- exact ids, plus 5 survivor aliases and 4 duplicate aliases with deterministic ids;
- per-deal identity facts;
- 1 score per deal, with 12 and 13 evidence rows;
- 22 and 17 source observations;
- 5 bound freshness rows per deal, plus 40 deferred rows at capture time;
- 2 pending safety events, 2 audit rows, and 1 baseline CRM revision per deal;
- zero global sending authority;
- an exception candidate list of `[]`, the same shape Garage had.

The two listings were written up separately, so recipient, description, and location equality are not required. Each deal's facts are pinned exactly instead, and a recipient appearing on the duplicate later refuses.

### What is different about this approval

The descriptor declares `dependentPolicy: 'pair-scoped-preservation-v1'`. The HVAC and Garage approvals are unchanged and keep their historical behavior.

- **Pursue CIM authority is scanned for this pair only.** Historical approvals refuse on any row anywhere in the Pursue CIM tables. That is no longer workable now that Pursue runs for other deals. This approval refuses on every row tied to the pair, whether directly or through its campaigns, conversations, and transmissions. That covers decisions, enrollments, timezone revisions, stage events, campaigns, touches, transmissions, reservations, terminal events, live authorizations, Gmail reply messages, and claims (`opportunityClaims`, `recipientClaims`).
- **Global sending authority still refuses.** Dry run and apply stop if any of these exist:
  - a current CIM capability activation in a mode other than off or shadow;
  - an unexpired, unconsumed, unwithdrawn live-provider authorization;
  - a current automatic-Pursue activation in a mode other than off or shadow;
  - the `live_sending` send control switched on.

  The plan records these as `authorityGrantingOperationalState.pursueCimAuthority`, and every count must be zero.
- **Preserved in place, never written.** Each category is pinned by exact count per deal plus a full-row SHA-256 digest:
  - both score rows and their score evidence (1 score and 12–13 evidence rows per deal);
  - pending, unconsumed, outcome-free CIM safety events;
  - their `safety-emitted` audit rows that carry no campaign, conversation, touch, transmission, activation, or authorization link;
  - the null-owner revision-1 CRM ownership baselines;
  - source observations, seen history, and freshness evidence.

  Any other safety, audit, or ownership row for the pair refuses: consumed or non-pending safety events, transition audit rows, and nonbaseline ownership revisions. Audit rows also count as the pair's when their campaign, conversation, touch, transmission, or authorization belongs to the pair, or when their metadata names either deal.

  Safety events are *payload*-immutable. The CIM safety consumer can later set their status, for example to no-op. A status change between dry run and apply changes the digest, and apply refuses. The superseded deal's score row is safe to leave. Every Inbox, triage, digest, disposition, and current-score read joins `deal_hunter_opportunities.status = 'active'`, and the next eligibility reconciliation clears its `current_triage_eligible` flag.
- **Some preservation-only counts are pinned by the reviewed plan.** Three counts are pinned in the reviewed plan, not in source: deferred freshness evidence, the source-observation collision count, and seen history. These rows are never written, and the plan pins them by digest. Every blocking category stays an exact count in source.
- **Deferred freshness evidence is pinned by the reviewed plan.** While the exception is open, every daily Sheet run defers this business's freshness evidence to the exception: the rows have a null current deal and carry the exception id. That count therefore grows daily, and the descriptor leaves it to the plan (`unboundCount: null`). The dry-run plan records the exact count and digest. The plan checksum binds apply to that review, and apply re-reads both inside its transaction. **A daily Sheet run between dry run and apply makes the checksum stale, and apply refuses.** In that case, rerun the dry run and have the owner review it again.
- **Checked-in guard rails.** At module load, every descriptor passes a structural check:
  - a plan-pinned `null` count is allowed only on a pair-scoped approval, and only for the three preservation-only counts above;
  - a pair-scoped approval must pin every preserved category, carry its own confirmation and a shell-safe approved reason, and record its survivor rule;
  - the survivor rule is re-checked against both deals' `created_at` on every dry run and apply.
- **Exact resolution reason.** The exception is resolved with the owner-approved reason checked into the descriptor (`approvedResolutionReason`). Any other `--reason` refuses. For pair-scoped approvals only, the resolution also writes `resolvedOpportunityId: <survivor>`, the same key a manual link writes. That gives the merge the same freshness semantics as a link: if a listing's earliest accepted evidence was deferred to this exception, the next accepted Sheet run binds that first discovery to the survivor. Both Precision Carbon listings were accepted before the exception opened, so their deferred rows simply stay attached to the resolved exception as history. A test covers this on the production-shaped fixture.
- **The dry run prints every change.** Output field `changes.writes` lists every write the apply would make:
  - the alias owner reassignments, with alias keys;
  - the duplicate's status change from `active` to `superseded`;
  - the exception resolution, with actor, reason, and `resolvedOpportunityId`;
  - the manifest insert.

  `changes.deletes` is `0`. `changes.unchanged.preservedWithoutWrites` lists each preserved category's per-deal counts.

### Production runbook

Every step that touches production needs the owner's explicit OK, asked for one step at a time. The pull request does not authorize any of them. Run commands on the `uckele-group` Fly app with Node 22.

1. **Deploy** the reviewed release (owner OK).
2. **Dry run** (read-only, owner OK). It copies a stable WAL snapshot to a private temporary directory and inspects only the copy. Run it after the day's 15:00Z Sheet run has finished:

   ```bash
   fly ssh console -a uckele-group -C "cd /app && npm run cim:canonical-merge -- --incident precision-carbon-2026-11-02 --actor '<owner name or email>' --reason 'Owner confirmed the BizBuySell (Alameda, CA, listing 2561135) and DealStream (Hayward, CA) Precision Carbon & Graphite Manufacturer listings are the same business listed on two sites; keep the earliest-created deal and retire the duplicate.'"
   ```

   The owner reviews `changes`, `planChecksum`, `plan.dependentState.counts`, `plan.preservedIncidentState`, and `plan.authorityGrantingOperationalState`. Any refusal or drift is a stop. Never edit the descriptor during the window.

   The capture did not measure three counts, so the plan sets them and the owner checks each:
   - `plan.preservedIncidentState.historicalIdentityEvidence`: the count and record ids, expected 0 or a few seen-history rows for these two listing URLs;
   - `plan.preservedIncidentState.sourceObservations.collisionCount`;
   - `plan.preservedIncidentState.freshnessEvidence.unbound.count`: 40 on 2026-11-05, plus 10 for each daily Sheet run since.

   An unexpected value is a stop.
3. **Pause CIM outreach** with the existing operations control (owner OK) and confirm the persisted pause.
4. **Snapshot the volume** `vol_rnzyd1xde6oqq0kr` (owner OK) with `fly volumes snapshots create vol_rnzyd1xde6oqq0kr -a uckele-group`. Then create and verify the application backup the apply requires:

   ```bash
   fly ssh console -a uckele-group -C "cd /app && npm run backup:create"
   fly ssh console -a uckele-group -C "cd /app && npm run backup:verify -- --bundle '<absolute-bundle-path>'"
   ```

5. **Apply** (owner OK, before the next 15:00Z Sheet run). Use the same actor and reason, the exact reviewed checksum, and the verified bundle path:

   ```bash
   fly ssh console -a uckele-group -C "cd /app && npm run cim:canonical-merge -- --incident precision-carbon-2026-11-02 --actor '<same actor>' --reason '<same approved reason>' --apply --expected-plan-checksum '<reviewed checksum>' --backup '<absolute-bundle-path>' --confirm 'MERGE opp_910e6860-deea-4e3d-bcf2-20c6e0a0fc92 INTO opp_8cc53064-bf61-4d2f-9862-2694c2773e0e FOR EXCEPTION 0cfa01f1fb4666903281f0c8d2b2da00027b307446a266c5adba7e0192343f56'"
   ```

   The exact confirmation phrase is:

   ```text
   MERGE opp_910e6860-deea-4e3d-bcf2-20c6e0a0fc92 INTO opp_8cc53064-bf61-4d2f-9862-2694c2773e0e FOR EXCEPTION 0cfa01f1fb4666903281f0c8d2b2da00027b307446a266c5adba7e0192343f56
   ```
6. **Post-apply check.** Immediately, and before the next Sheet run, rerun the step 2 dry run. This check only works inside that window. The next Sheet run writes new evidence for the survivor, and a later safety-consumer run marks the pending events no-op. Either changes the preserved rows, after which a replay correctly refuses to call itself idempotent. It must report `alreadyApplied: true` with no writes. In Deal Hunter's review, the Precision Carbon identity exception is gone, and only the survivor appears after the next scoring run.
7. **Unpause outreach** only as a separate owner decision.

If the dry run refuses because of authority that can send email, the owner decides whether to switch that authority off for the window. The merge tool never changes those switches.

### Review UI

Deal Hunter's identity-exception panel marks a `conflicting-canonical-aliases` exception as **Same business on two deals — needs a merge**. It shows no Link or Keep distinct buttons, because the resolve route refuses both while two deals own the listing's aliases. The route returns `409` with `code: 'IDENTITY_EXCEPTION_REQUIRES_MERGE'`, and no identity change is applied. The panel decides this from live alias ownership, with the same two-or-more-owners check the route uses, not from the stored reason. A `conflicting-canonical-aliases` exception whose aliases now have one owner or none keeps its normal buttons. When a checked-in descriptor covers the exception, the panel names the incident, shows which deal is kept and which is retired, and prints the full read-only dry-run command, including the approved reason. Otherwise it says no merge has been prepared yet. The app deliberately has no one-click merge button. The merge needs a reviewed dry run, a verified backup, and paused outreach, and none of that belongs behind a web button.
