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
  - Canonical restore is **FAILED**: CRM Restore leaves the canonical Pass in force.
    Full FL02/FL05 release acceptance remains blocked on the separate lifecycle slice.
- [ ] Run applicable checks and resolve independent review findings.
- [ ] Commit, push, open a separate draft PR and verify exact-head hosted CI.
- [ ] Human owner-reviewed walkthrough/adoption acceptance (separate, still pending).
