# Canonical Opportunity Current-vs-Historical Semantics Design

**Date:** 2026-08-27

**Status:** Implemented in the uncommitted working tree; production migration and HVAC repair not applied

## 1. Objective

Establish one explicit invariant throughout Deal Hunter:

> A canonical opportunity with `status = 'superseded'` remains readable as history, but only an opportunity with exactly `status = 'active'` may supply new identity, CRM/CIM, claim, Stage 2, scoring, triage, or acquisition authority.

This design removes the structural blocker from the separately approved HVAC canonical-merge repair only after the invariant is enforced and proven. It does not change resolver similarity, alias generation, parsing, scoring policy, automation configuration, or full-backfill authority.

## 2. Storage contract

The existing methods remain explicitly historical:

- `getDealHunterOpportunity`
- `listDealHunterOpportunities`
- `findDealHunterOpportunityByAliases`

They may return active or superseded rows and remain suitable for audit, repair, manifest replay, historical CRM/CIM inspection, and preserved evidence.

Both SQLite and Supabase expose an equivalent current contract:

- `getCurrentDealHunterOpportunity`
- `listCurrentDealHunterOpportunities`
- `findCurrentDealHunterOpportunityByAliases`

Every current method requires exactly `status = 'active'`. There is no fallback that treats an unknown status as current.

Historical and current alias lookup evaluate the complete normalized alias-key set before choosing an owner. SQLite chunks the complete input and enumerates every distinct owner without a raw-row limit. Supabase walks deterministic pages for both historical and current lookup until every matching alias row has been examined. Both providers then load owner rows separately, so a dangling owner cannot disappear through a join. Multiple aliases from one owner cannot hide a later owner, and multiple-owner, missing-owner, and sole-non-current outcomes remain distinct.

An alias whose sole historical owner is non-active is not treated as absent. Current alias lookup raises a typed non-current conflict carrying the historical owner ID. That distinction prevents automatic creation of a replacement opportunity and prevents resurrection of the historical owner.

## 3. Identity resolution

Automatic resolution uses current methods for exact aliases, conflict recovery, and semantic candidate enumeration. Caller-supplied semantic candidates are also restricted to active rows.

The outcomes are:

- an alias moved to an active survivor resolves to the survivor;
- an alias still owned only by a superseded row creates a fail-closed identity exception with reason `non-current-canonical-alias`;
- a superseded row cannot win semantic similarity;
- a superseded row is never updated back to active;
- ordinary ambiguity behavior and similarity thresholds remain unchanged.

Deal Hunter identity attachment loads only the current candidate set. Historical aliases and opportunities remain available through the historical storage methods.

New automatic opportunity creation is not a create-then-link sequence. SQLite resolves the stable alias set, inserts when ownerless, and acquires all aliases in one immediate transaction. Supabase performs the equivalent work in one service-role RPC under sorted per-alias advisory locks. A concurrent caller receives the sole current owner; no losing active aliasless proposal is inserted.

## 4. Manual identity behavior

Manual linking by explicit opportunity ID performs both a historical lookup and a current lookup before mutation.

- Active target: existing behavior continues.
- Historical row exists but is non-current: return HTTP-style status 409 before alias or exception mutation.
- Unknown target: retain the existing not-found behavior.

When audited merge metadata names `mergedInto` and that successor is active, the refusal may return `successorOpportunityId` as operator context. It never changes the requested target and never redirects or mutates implicitly.

SQLite alias mutation primitives and the Supabase alias-link RPC independently revalidate active target status inside the mutation transaction.

Manual keep-distinct uses the same atomic creation boundary and includes pristine-open identity-exception resolution in that transaction/RPC. A competing winner leaves the losing proposal uninserted and the losing call returns a conflict. A keep-distinct request without a usable stable alias is refused before any mutation.

## 5. CRM and CIM authority

Current CRM/CIM paths require active authority:

- manual CRM creation rejects a superseded canonical ID before submission creation;
- manual CRM creation revalidates and locks active canonical status inside the same SQLite transaction or dedicated Supabase function that inserts the submission and its activity;
- CRM preflight ignores a superseded opportunity's historical primary submission as current authority;
- SQLite CRM linkage and the existing Supabase linkage RPC lock and reject a non-active opportunity before either side is updated;
- Deal Hunter CRM synchronization requires the atomic linkage primitive, establishes ownership before applying ordinary CRM field changes, reloads the link-advanced submission version, and compare-and-swap updates against that fresh version; generic submission updates cannot carry canonical linkage;
- recipient-override creation rejects non-active targets, with transactional storage enforcement;
- recipient-override upsert rejects an ID already owned by another canonical opportunity and cannot rewrite a historical override through an active incoming owner;
- an override created while active ceases to be returned as active authority after supersession;
- opportunity and recipient claim creation atomically return `opportunity-not-current` for non-active IDs.

Historical submissions, imports, requests, reviews, communications, activities, email events, claims, and overrides are not reparented or deleted.

## 6. Stage 2

Stage 2 current evidence includes only active opportunities and aliases owned by active opportunities. An empty current set is authoritative. A nonblank stored review opportunity ID is authoritative provenance: an active ID is used, while a superseded or missing ID is classified unlinked and never falls through to a moved deal-key alias or `mergedInto`. Deterministic deal-key fallback remains available only to genuinely legacy reviews that stored no canonical ID.

Historical reviews, decisions, runs, activations, requests, communications, and outcomes remain readable.

Final Stage 2 send authorization independently calls the current opportunity getter and requires the returned row to match the deal ID with `status = 'active'`. This check is in addition to run, activation, policy, claim, recipient, snapshot, source, capacity, and window validation.

## 7. Score and current-triage semantics

Score rows and evidence are historical records. They are not deleted when an opportunity is superseded.

Current score detail and queue listing require both:

- `current_triage_eligible = true`; and
- an inner-joined canonical opportunity with `status = 'active'`.

Filtering and counting happen in the database before sorting and pagination for both providers. Eligibility reconciliation intersects the supplied complete set with active canonical rows and therefore deactivates, but never reactivates, superseded opportunities. Machine score writes and operator decisions also revalidate active status inside their SQLite transaction or Supabase RPC.

The scoring rules, weights, bands, caps, versions, full-backfill authority conditions, and current-set selection policy are unchanged.

## 8. Supabase migration

`20260827120000_canonical_opportunity_current_semantics.sql` is function-only. It creates or replaces functions and updates execution grants; it does not create, alter, or drop a table, column, type, status, threshold, or policy.

Existing RPC signatures remain unchanged for:

- `mutate_with_crm_activity`
- `claim_deal_hunter_cim_opportunity`
- `claim_deal_hunter_cim_recipient`
- `link_deal_hunter_opportunity_aliases`
- `link_deal_hunter_crm_submission`
- `write_deal_hunter_opportunity_score`
- `reconcile_deal_hunter_current_score_eligibility`
- `list_deal_hunter_opportunity_scores`

Five new service-role-only functions provide atomic parity for operations that previously used direct table writes:

- `insert_submission_with_crm_activity(jsonb, jsonb)` locks exact active canonical status, when supplied, inside the submission-and-activity insert transaction;
- `upsert_deal_hunter_opportunity(jsonb)` preserves an existing non-active row byte-for-byte instead of allowing an observation race to resurrect or rewrite it;
- `create_deal_hunter_opportunity_with_aliases(jsonb, jsonb, text, jsonb)` takes a deterministic complete alias-lock set and atomically returns the current owner or creates the opportunity plus aliases; its optional exception input resolves manual keep-distinct in the same transaction;
- `upsert_deal_hunter_cim_recipient_override(jsonb)` preserves override ownership across conflict updates;
- `set_deal_hunter_opportunity_operator_decision(text, jsonb)`

The migration is checked in but must not be applied as part of this implementation task.

## 9. Merge integration

The merge plan now uses `canonical-opportunity-merge-plan-v2`, records `resolutionSafety.structuralInvariantSatisfied = true`, and includes a deterministic digest/count summary of the complete checked-in SQLite relationship inventory. Every detected relationship-like current-schema column is classified exactly once as blocking, redundant through a scanned parent, preserved global/recipient operational state, or explicitly excluded with a reason. An unclassified future relationship-like column refuses dry run, backup reconstruction, and the live apply transaction.

Entity-dependent rows remain zero-required. Recipient-global `email_suppressions` are instead surfaced as count-only restrictive `preservedOperationalState`; no address, suppression row, owner, or status is rewritten, and a valid suppression alone is not a blocker. Current Stage 2 activation is surfaced separately as authority-granting state and fails closed. The inventory/preserved-state additions deliberately change the plan checksum, so pre-v2 checksums are stale.

No other gate changed. Apply still requires the exact checked-in approval tuple and alias ownership set, actor, reason, exact confirmation, exact plan checksum, independently verified application-consistent SQLite backup, active global CIM pause, zero blocking entity-dependent state on both IDs, zero current Stage 2 grant authority, classified current relationship schema, and transaction-time revalidation.

The nine original apply-dependent acceptance tests are enabled unchanged in scope. They prove exact alias movement, supersession with historical retention, typed manifest persistence, survivor-only HVAC resolution, idempotency, replay drift refusal, backup/audit tamper refusal, apply-time drift refusal, and complete rollback after injected failure.

## 10. Scope exclusions

This phase does not:

- special-case or resolve Blair, Pennsylvania ambiguity;
- alter similarity thresholds, parsers, fingerprints, or alias-generation rules;
- change scoring policy or full-backfill authority;
- change automation stages, thresholds, activation, schedules, pauses, or delivery settings;
- reparent scores, CRM, CIM, communications, activities, claims, or other historical state;
- apply the Supabase migration;
- execute the HVAC merge repair;
- access or modify production.
