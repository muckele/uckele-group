# FL05 local backend owner walkthrough

Base: main `63f082bf6a0797694a5d8cbb8c4f60296a800fc5`.
Roadmap: `docs/roadmap/2026-09-22-uckele-group-fresh-lead-mvp-roadmap-addendum.md`, MVP-FL-05.

## Acceptance

- Run the built UI against real Express routes, real password/session authentication,
  and a fresh SQLite fixture. Do not fulfill or mock administrative API responses.
- Seed fresh high-fit, older high-fit, new low-fit, unknown-age, material-update,
  archived/reimported, and broker-response/materials cases with synthetic data only.
- Prove fact edits survive reload, exact Pass reason/note can be found in archive,
  CRM Restore is explicit and leaves outreach stopped, and Pursue exposes an
  honest prerequisite/waiting state. Record canonical restore separately: the
  existing CRM Restore currently leaves the canonical Pass in force. This blocks
  full FL02/FL05 release acceptance and belongs in a dedicated lifecycle slice.
- Check desktop and mobile rendering, keyboard focus, console health and overflow;
  record actual navigation timings as observations rather than owner usability claims.
- Launch with an allowlisted environment and private temporary HOME/data paths.
  Deny external network access at test boundaries; never load server/index.js,
  schedulers, dotenv, provider credentials or an existing database. Keep outreach
  and automation paused. No live permission is issued or consumed.
- Preserve failure evidence and code revision outside the checkout. Run applicable
  checks, obtain independent review, then commit/push a separate project branch/PR.

## Sequence

1. RED tests for environment isolation; implement a small isolated runner.
2. Seed representative fixtures and exercise one integrated owner journey plus
   mobile/read-only coverage against the real backend.
3. Resolve observed routine defects, validate local checks, independent review.
4. Commit/push and verify hosted CI; report owner-reviewed pilot/deployed/live
   acceptance separately as still pending.

This slice does not change production architecture or mailbox qualification.
PR76 and its stopped-machine gate remain separate. A human owner walkthrough is
still required before FL05 adoption acceptance can be marked complete.

## Observed failures and scope

- Fixed: native browser focus escaped when Pursue disabled the active control;
  restore guarded modal focus after pending settlement.
- Fixed: modern owner Pass collapsed a custom reason to `other`; preserve its
  already bounded text in the existing command/storage contract. Legacy category
  APIs remain separate.
- Fixed test fixture: the FL04C restart test injected October 8 execution time but
  seeded due dates from today's wall clock. Seed that fixture from its injected
  instant so the intended immutable-renewal assertion actually executes.
- **FAILED release criterion: coherent canonical restore.** Existing CRM Restore
  (`POST /api/admin/submissions/:id/restore`) changes CRM status to review and
  leaves follow-up completed/unscheduled, but the linked canonical disposition
  remains dismissed. The separate disposition-restore API reverses only that
  record. Do not compose these non-atomic APIs here. The smallest follow-up is a
  dedicated FL02 lifecycle transaction restoring the exact current linked
  canonical+CRM records, with stale/supersession/replay/rollback coverage, retained
  reason/note/audit/caps, and no reopened campaign, permission or scheduled work.
  Preserve SQLite/Postgres parity. Full FL02/FL05 acceptance stays incomplete.
- Archived/reimported coverage here is a seeded archived record re-observed under
  the same identity with discovery retained, not a complete importer lifecycle.

Local validation uses Chromium at 1440×1000 and 390×844, synthetic eight-opportunity
fixtures and offline fallback fonts. Timings are individual local automation
observations; they do not measure a human owner's task time or population-scale
performance. Deployed/live/owner-pilot acceptance is not established.
