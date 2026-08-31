# Corrective Task 1 — Current Operator Fact Write Boundary

## Status

Implemented and verified locally.

## Scope and starting state

- Worktree: `/Users/Matt/Documents/uckele-group-acquisition-inbox-v1`
- Branch: `codex/acquisition-inbox-v1`
- Required starting commit: `0112c275ed92e2171e682d9a39d3acabcd33f534`
- Starting worktree: clean.

The scope is limited to new/current `source=operator` fact persistence. It
does not change fact precedence, scoring, canonical identity, source refresh,
CIM, Stage 2, or outreach behavior.

## Root cause evidence

The high-level `setOperatorOpportunityFact` and
`setCurrentOperatorOpportunityFact` services already normalize fields, values,
actors, notes, and verification booleans. The direct storage paths did not:

- SQLite `insertCurrentDealHunterOpportunityFact` and
  `upsertDealHunterOpportunityFact` inserted raw fact objects and used
  `fact.verified ? 1 : 0`, so a string such as `'false'` became verified.
- Supabase's corresponding adapter methods serialized raw fields and used
  `Boolean(fact.verified)`, with the same truthy-coercion issue.
- The current-authority RPC only locked the active canonical opportunity and
  inserted the supplied row. The fact table had no operator-field/bound/source
  constraint, so direct RPC calls could bypass the application service.
- Existing fact history has no need to be deleted or rewritten. The new
  Supabase check is therefore `NOT VALID` on forward migration: historical rows
  remain as they are, while every subsequent insert or update is checked.

## RED evidence (before production changes)

Command:

```sh
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test test/dealHunterOpportunityFacts.test.js
```

Result: 22 passing, 2 failing. Both new direct-boundary tests failed with the
expected executable symptom, not a setup error:

```text
not ok 7 - direct SQLite current operator-fact storage rejects every hostile probe atomically
error: 'Missing expected rejection: unsupported field'

not ok 8 - direct Supabase current operator-fact adapter rejects every hostile probe before RPC
error: 'Missing expected rejection: unsupported field'
```

That failure proves the pre-change direct SQLite and Supabase provider paths
accepted an unsupported operator fact when the high-level service was bypassed.

## Implementation

- Added `normalizeOperatorOpportunityFactRecord`, the shared strict direct
  storage validator. It requires the exact Phase 1 allowlist, trimmed bounded
  IDs (240), canonical opportunity IDs (200), values (4,000), actors (200),
  notes (4,000), exact `source=operator`, a real boolean verification state,
  valid timestamps, and rejects unsupported metadata.
- Routed both SQLite write methods and both Supabase adapter write methods
  through that validator. Rejected adapter writes reach no RPC.
- Added SQLite fresh-schema `CHECK` and insert/update triggers so already
  initialized SQLite files receive the same boundary without table rebuild.
- Added Supabase fresh-schema constraint plus forward migration
  `20260830180000_operator_fact_storage_boundary.sql`. The migration uses a
  `NOT VALID` constraint to retain legacy/provider rows while enforcing every
  new or updated write.
- Replaced both Supabase fact RPC definitions in the forward migration with
  server-side `p_source is distinct from 'operator'` guards. The table
  constraint enforces the remaining allowlist and scalar bounds even for a
  caller that bypasses the JavaScript adapter.
- Preserved `security definer`, `set search_path = public`, and service-role
  function grants/revocations for both RPCs.

## Provider/RPC contract

Both current insert and direct upsert are now valid only for a new operator
fact meeting this contract:

- field is exactly one of the approved 13 operator fields;
- source is exactly `operator`;
- fact ID is 1–240 trimmed characters; opportunity ID is 1–200 trimmed
  characters; value is 1–4,000 trimmed characters; actor is 1–200 trimmed
  characters; note is null or 1–4,000 trimmed characters;
- `verified` is a boolean; JavaScript strings/numbers are rejected rather than
  truthily coerced;
- arbitrary metadata is not a fact-table channel and is rejected.

The Supabase adapter rejects invalid data before invoking either RPC. The RPCs
also reject source spoofing server-side; their table constraint rejects bad
fields and scalar bounds on any direct server-side call.

## Migration and fresh-schema parity

- Fresh SQLite uses the same strict `CHECK`; triggers apply it to existing
  SQLite tables without rewriting rows.
- Fresh Supabase schema contains the same allowlist and bounds.
- Forward Supabase migration adds the constraint as `NOT VALID`, retaining
  existing legacy/provider history. PostgreSQL still enforces a `NOT VALID`
  constraint for all new/updated rows.
- The migration redefines both fact RPCs with source guards, search-path
  hardening, and service-role-only privilege statements. The dedicated parity
  test compares both RPC definitions with the fresh schema and asserts every
  scalar bound and the `NOT VALID` upgrade behavior.

## Tests and checks

Focused GREEN command:

```sh
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test test/dealHunterOpportunityFacts.test.js
```

Result: **25 passing, 0 failing.** The hostile matrix tests both direct current
inserts and direct upserts through SQLite and the Supabase adapter. It covers
unsupported field, 250-character ID, 6,000-character value, arbitrary source,
empty actor, 5,000-character note, truthy verification, and oversized metadata;
SQLite additionally proves each rejected write leaves no persisted row.

Relevant provider/schema parity command:

```sh
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH \
  node --test test/dealHunterOpportunityFacts.test.js \
  test/dealHunterSourceImport.test.js test/supabaseSecurity.test.js \
  test/sqliteAuthMigration.test.js
```

Result: **39 passing, 0 failing.**

Additional checks:

```sh
PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH npm run lint
git diff --check
```

Result: lint exited 0; `git diff --check` exited 0.

## Files changed

- `server/services/dealHunterOpportunityFacts.js`
- `server/storage/sqlite.js`
- `server/storage/supabase.js`
- `supabase/schema.sql`
- `supabase/migrations/20260830180000_operator_fact_storage_boundary.sql`
- `test/dealHunterOpportunityFacts.test.js`

## Self-review

- Reviewed the full task diff and confirmed no scoring, canonical identity,
  source ingestion, CIM, Stage 2, outreach, or precedence code changed.
- Checked that rejected direct writes are atomic in SQLite and do not invoke the
  Supabase adapter RPC.
- Checked that both new/redefined RPCs retain `security definer`, pinned
  search path, public/anon/authenticated revocation, and service-role-only
  execution.
- Checked forward/fresh parity and retained-history behavior explicitly.

## Commit

`f231e941079a81b3c0546c2953748aa380dd478f` — `Enforce operator fact storage boundaries`

## Concerns

No known functional concerns. A local Postgres/Supabase runtime was not
available in this isolated worktree, so Supabase server behavior is covered by
the adapter's executable hostile matrix plus migration/fresh-schema RPC and
constraint parity tests rather than a live database invocation.
