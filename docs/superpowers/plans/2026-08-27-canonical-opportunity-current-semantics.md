# Canonical Opportunity Current Semantics Implementation Plan

**Date:** 2026-08-27

**Status:** Implemented and fully validated in the uncommitted feature branch; production migration and HVAC repair not applied

## 1. Preserve the approved baseline

- Verify repository root and exact `main`/`origin/main` SHA `2638aaf4ee590839b77fb2cb6d0e0ad72455c5a6`.
- Record the existing merge-tool modified/untracked manifest and confirm staging is empty.
- Create `codex/canonical-merge-superseded-semantics` from unchanged `main` without stashing, resetting, cleaning, restoring, or losing any existing working-tree byte.

## 2. Add storage contract tests first

- Prove historical lookup returns a superseded row.
- Prove current get/list/alias lookup accepts only exact `active` status.
- Implement equivalent SQLite and Supabase methods.
- Preserve the historical methods without global filtering.

## 3. Move identity and manual-link authority to current methods

- Test an alias owned only by a superseded row fails closed without mutation or replacement creation.
- Test semantic matching never selects a superseded high-similarity candidate.
- Test active manual linking remains unchanged.
- Test explicit superseded manual linking returns 409 before mutation and does not redirect.
- Guard alias mutation transactionally in SQLite and the Supabase alias RPC.
- Replace automatic and manual keep-distinct create-then-link sequences with one provider-equivalent opportunity-plus-alias acquisition boundary; include keep-distinct exception resolution in the same transaction/RPC.
- Exercise real overlapping SQLite connections and prove exactly one active owner, one alias owner set, no aliasless active loser, and an accurate manual conflict.

## 4. Guard CRM/CIM and Stage 2

- Test manual CRM creation, CRM preflight, and atomic CRM linkage reject superseded authority while historical CRM rows remain readable.
- Close precheck-to-mutation races by checking active status inside the SQLite submission insert transaction and a dedicated Supabase submission-and-activity RPC.
- Require the atomic canonical-link primitive for Deal Hunter CRM synchronization, reload its versioned submission result before ordinary field mutation, and forbid canonical linkage in the generic update operation.
- Test recipient overrides and claim primitives reject non-active IDs without erasing historical records.
- Preserve recipient-override ownership across upsert conflicts so an active incoming owner cannot rewrite historical override evidence.
- Test Stage 2 evidence ignores superseded IDs while historical reviews remain readable.
- Add an independent active-canonical check to the final Stage 2 authorization boundary.

## 5. Guard scores and current triage

- Test score/evidence history survives supersession.
- Require active canonical rows in current score detail and queue queries.
- Join/filter in the database before count and pagination.
- Make eligibility reconciliation intersect with active opportunity IDs so it cannot reactivate a superseded row.
- Guard machine score writes and operator decisions transactionally.
- Preserve all scoring, triage, and full-backfill policy inputs.

## 6. Add function-only Supabase parity migration

- First add a failing contract test for the absent migration.
- Replace only functions; make no structural schema or policy change.
- Preserve every existing RPC signature.
- Lock and revalidate active opportunity status inside CRM linkage, claims, alias linkage, score writes, and eligibility reconciliation.
- Filter current triage before database pagination.
- Add narrow service-role RPCs for atomic submission insertion, no-resurrection opportunity upsert, opportunity-plus-alias acquisition, recipient-override, and operator-decision parity.
- Mirror the definitions in `supabase/schema.sql` without applying the migration.

## 7. Remove the merge structural blocker only after proof

- Remove skip declarations from the nine existing apply acceptance tests and observe their blocker failure.
- Remove the unconditional CLI/service/storage blocker and mark the reviewed plan structurally safe.
- Keep every approval, alias, checksum, backup, pause, confirmation, actor, reason, dependency, and transaction-time drift gate.
- Run the full merge suite and require zero skips.

## 8. Close final independent review findings

- Make explicit Stage 2 review identity authoritative and reserve deal-key fallback for reviews with no stored canonical ID.
- Remove every bounded raw-row alias-owner decision, validate dangling owners separately, and keep historical/current provider parity.
- Add the atomic create-plus-alias boundary and service-role-only function-only Supabase RPC.
- Derive and check a complete relationship inventory from the current SQLite schema; reject unclassified future relationship columns at dry run, backup reconstruction, and live apply.
- Put restrictive recipient suppression counts in `preservedOperationalState`, leave suppression rows untouched, and block separately on current Stage 2 grant authority.
- Bump only the merge plan schema to v2 so old review checksums cannot be reused.

## 9. Document and validate

- Publish the complete caller matrix.
- Update the merge design and runbook to record that the structural conflict is resolved in code but no production operation occurred.
- Run focused identity, CRM/CIM, Stage 2, score, triage, SQLite, Supabase, full-backfill, and merge tests under Node 22.23.2.
- Run `git diff --check` and full `npm run check` under Node 22.23.2.
- Count and explain every remaining skip; require zero merge-blocker skips.
- Audit the diff for historical-data filtering, direct-ID bypasses, provider mismatch, resurrection, Stage 2 bypass, generic reparenting, automation changes, and unrelated parser/scoring changes.
- Leave the complete implementation uncommitted and unstaged.

## 10. Validation record

All SQLite-backed and repository validation used Node `22.23.2`.

- Expanded focused current-authority, merge, CRM/CIM, scoring, triage, and provider-security matrix: 297 passed, 0 failed, 0 skipped.
- Full deterministic follow-up evaluation: 51 passed; adapter-fault evaluation: 24 passed.
- Full Node suite: 728 passed, 0 failed, 0 skipped.
- UI suite: 125 passed across 20 files.
- Production build and nine-route prerender completed successfully.
- The first sandboxed full run encountered 20 local-loopback-only `EPERM` failures; the identical complete command was rerun with loopback permission and passed end to end.

The validation used only isolated test fixtures and local build output. It did not access production, apply the function-only Supabase migration, or execute the HVAC repair.
