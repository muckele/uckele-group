# FL-04C Atomic Follow-Up Preparation

- [x] Record the approved state contract and compatibility approach.
- [x] Write RED service, SQLite concurrency/lifecycle, and PostgreSQL parity tests.
- [x] Implement additive reservation schema and lifecycle constraints.
- [x] Implement atomic SQLite and PostgreSQL reserve-and-prepare transitions.
- [x] Implement exact immutable-preparation renewal after lease expiry.
- [x] Implement dormant injected service composition with zero transport surface.
- [x] Pass focused tests and lint.
- [x] Complete independent review and resolve required findings.
- [x] Pass full applicable checks serially.
  - Exact clean-head serial server pass: 111 files, 2,684 tests, 2,674 passed,
    10 declared PostgreSQL skips, and zero failures. The previously blocked P10B
    clean-checkout file passed 71/71 on the commit.
  - Disposable PostgreSQL integration passed 18/18 against both fresh and fully
    migrated upgrade databases, including actual service-role preparation and
    renewal capacity branches. The suite cleanup hook removed its uniquely named,
    network-isolated container; a read-only Docker check found no leftover test
    containers.
  - Follow-up evaluation passed 75 deterministic fixtures and 24 adapter-fault
    fixtures. UI tests passed 277/277. Full lint, focused lint, production build,
    and `git diff --check` passed.
- [x] Commit, push, open stacked draft PR 74 on PR 73, and verify exact-head CI.

# FL-05 backend-connected synthetic owner walkthrough

Plan: `docs/superpowers/plans/2026-10-18-fl05-backend-owner-walkthrough.md`.

- [x] Establish roadmap acceptance and preserve the separate mailbox approval gate.
- [x] RED/GREEN environment-isolation tests and fresh local fixture runner.
- [x] Complete bounded backend-connected desktop/mobile/viewer checks and preserve observations.
  - Original canonical restore assertion **FAILED** and was preserved for FL02.
    The separate FL02 slice below promotes it to a required passing regression.
- [x] Run applicable checks and resolve independent review findings.
- [x] Commit, push, open draft PR77 and verify exact-head hosted CI on
  `6d28a05a258f46dbee72c1ce8b155e56d6fcd125` (run `39171279872`).
- [ ] Human owner-reviewed walkthrough/adoption acceptance (separate, still pending).

# FL-02 coherent CRM/canonical restore

Plan: `docs/superpowers/plans/2026-10-18-fl02-coherent-restore.md`.

- [x] Preserve service/browser RED evidence and establish roadmap restore contract.
- [x] Implement one atomic restore primitive in SQLite and PostgreSQL source,
  reconciling exact retained identity and preserving stopped outreach/history.
- [x] Pass local focused lifecycle, rollback, authorization, repeat/identity,
  UI and backend-connected browser regressions.
- [ ] Complete independent final review, commit/push a separate stacked draft PR,
  and verify exact-head CI including actual fresh/upgrade PostgreSQL and races.
  Docker is unresponsive locally; enabled PostgreSQL checks remain required CI.
- [ ] Human owner adoption and release acceptance (no merge/deploy/live send).
