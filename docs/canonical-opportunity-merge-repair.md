# Canonical Opportunity Merge Repair Runbook

> **Implementation status:** Apply-capable and ready for independent read-only review in the uncommitted feature branch. The separately approved current-authority phase closed the superseded-row structural gap in SQLite and Supabase, and all nine original merge-apply acceptance tests are enabled and passing. This task did not execute the repair, apply the Supabase migration, access production, or authorize a production apply window.

## Purpose and authorization boundary

`npm run cim:canonical-merge` is an operator-only, incident-specific repair command for a canonical Deal Hunter opportunity split that has already received an independent human identity decision. It is not an automatic merge heuristic and it must not be used to bypass the ordinary canonical resolver, current-triage policy, or full-backfill authority gate.

The only checked-in approval currently accepted is:

- identity exception: `8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571`
- survivor: `opp_cd57a315-feaf-4158-a02e-4bdde97a922e`
- superseded duplicate: `opp_c92d0c73-6a47-4fed-b528-6f310745e448`

The command refuses any other tuple. The checked-in descriptor also fixes the complete expected ownership of all twelve approved aliases, including the three aliases that may move. A missing, added, changed, duplicated, or third-party-owned alias refuses both dry run and apply.

This tool is SQLite-only. It refuses every other active storage provider before backup verification or repair execution. The service requires explicitly supplied storage and never starts ordinary application storage implicitly. Do not adapt this command to a remote provider during an incident.

## What the repair may change

In one immediate SQLite transaction, the approved apply may:

1. Move only the three approved BusinessesForSale aliases from the losing ID to the survivor.
2. Leave all nine existing survivor aliases in place.
3. Mark the losing opportunity `superseded` while retaining the row and all existing metadata.
4. Add explicit, checksummed `canonicalOpportunityMerge` audit metadata to that losing row.
5. Resolve only the approved identity exception with the actor, reason, decision, timestamp, survivor, losing ID, and plan checksum.
6. Insert one namespaced, typed `canonical-opportunity-merge-manifest-v1` record under its deterministic manifest key.

The repair never deletes either opportunity and never generically reparents scores, score evidence, current-triage state, CRM records, CIM records, communications, provider events, activities, claims, follow-up state, or historical identity evidence. Any blocking entity-dependent state on or indirectly associated with either approved ID causes a refusal. Recipient-global suppression is deliberately different: it remains restrictive operational state, is reported only by counts, and is never removed, rewritten, or treated as entity ownership.

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

## 3. Review the exact dry-run plan

Two people should review the output against the checked-in approval. At minimum, verify:

- `mode` is `dry-run` and `applied` is `false`;
- both opportunity snapshots still match the approved facts and both are active;
- the identity exception is pristine, open, and contains exactly the two approved candidates;
- `observedAliases` contains exactly twelve rows with the approved owners;
- `globalAliasOwnership` proves each alias type/value has exactly one owner and no third-party owner;
- `aliasMoves` contains only the three approved BusinessesForSale aliases;
- every blocking `dependentState` count is zero for both IDs and alias-derived references;
- `relationshipInventory` matches the reviewed v1 inventory digest and classifies the current relationship-bearing schema into all four documented categories;
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

The apply command runs `verifyBackupBundle` again and passes its complete verification result into the repair service. A boolean, a database filename, an unverified copy, a non-SQLite manifest, or a malformed/stale evidence object is not accepted backup evidence.

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
