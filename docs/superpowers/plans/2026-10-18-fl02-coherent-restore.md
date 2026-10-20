# FL02 coherent restore for review

Base: reviewed FL05 commit `6d28a05a258f46dbee72c1ce8b155e56d6fcd125`.
Separate branch/stacked PR; PR76 and PR77 source heads remain unchanged.

The approved roadmap FL02 requires coherent restore-for-review, exact retained
reason/detail/history, historical/source-loss coverage, and no resumed mail or
erased caps. The preserved FL05 failure demonstrates CRM status returning to
review while canonical Pass remains active.

## Contract

- One storage transaction restores an archived CRM record and its exact current
  linked canonical Pass dispositions, then appends one restore audit event.
- Re-derive canonical/CRM ownership inside the transaction; reject ambiguous,
  stale, historical/superseded or conflicting linkage rather than guessing.
  Do not require a currently eligible score or healthy external source to restore
  retained review state. A standalone CRM archive can still be restored.
- Keep prior archive reason/note/timestamps, disposition identity/history and
  owner decision history. Remove only current Pass authority for that canonical
  lifecycle; unrelated diligence decisions and unrelated dispositions stay intact.
- Restore does not resubscribe, issue permission, alter opt-outs/suppressions,
  reopen campaign/enrollment, erase capacity/caps, or schedule work. CRM follow-up
  remains completed and next_action_at remains null.
- Require current CRM version/archived state; a repeated restore returns a
  conflict with no new audit or other write. Existing authenticated owner-only
  HTTP authorization and origin protection remain in force.
- SQLite and PostgreSQL have the same atomic semantics. SQL changes remain
  reviewable source plus disposable synthetic fixtures; no project database or
  live migration is applied. No data/storage migration is performed.
- Reconcile retained CRM deal-key claims against exact alias/score ownership,
  including historical ineligible scores. The PostgreSQL primitive requires read
  committed isolation before acquiring the existing terminal and table locks;
  older caller snapshots cannot substitute for current identity authority.

## Validation and handoff

1. Promote original FL05 canonical-restore assertion to a required failing check;
   add direct service/storage regressions before implementation.
2. Add the smallest lifecycle storage primitive using existing audit and lock
   conventions; cover rollback, stale/raced ownership, authorization, repeated
   restore, historical eligibility, suppression/permission/cap preservation.
3. Run backend and real-browser regressions and available disposable PostgreSQL
   parity checks, independent review, then commit/push and exact-head CI.
4. Report remaining owner-pilot/live acceptance separately. No merge/deploy/send.

Local Docker is unresponsive to bounded read-only inspection. Enabled PostgreSQL
fresh-schema, pinned-base upgrade, actual concurrent alias-writer and stale
snapshot regressions are therefore required hosted CI gates. CI fetches history
for the exact upgrade baseline and checks out/asserts the literal PR head.

The preserved original browser assertion failed before this fix and passes with
the atomic SQLite implementation. Reload also verifies the restored opportunity
returns to All active and is absent from Passed. Rollback, repeat/stale requests,
identity conflicts, authorization and unchanged stopped outreach authority have
focused regression coverage. Full owner-pilot adoption remains separate.
