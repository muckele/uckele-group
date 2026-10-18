# Conservative stopped diagnostic implementation plan

> **For agentic workers:** Execute the approved correction in this session, with independent review before commit/push.

**Goal:** Restore automatically only on a fully acknowledged and verified diagnostic branch; preserve uncertainty for separately approved recovery.

**Architecture:** Controller and native client each latch successful acknowledgement and exact returned version. A diagnostic-only WAIT maps to one bounded version-scoped settled GET, followed by a fresh exact current-version/config GET. Post-update states may be created or stopped; initial admission remains stopped.

**Tech stack:** Existing Node.js controller/IPC, Go native SDK request builder, Python owner handoff, offline loopback HTTP tests.

**Spec:** Owner-approved recovery change recorded in the delegation; `docs/reviews/p10b-stopped-update-only-diagnostic.md` describes the resulting contract.

## Global constraints

- Offline only; no live Fly, preflight, token reads, provider, email, merge or deploy.
- Exact isolated target; zero starts; skip_launch=true; one diagnostic plus at most one eligible restoration POST; no retry/replay.
- POST10s; observation10s; operation120s; original approval15min; productionReady=false; global automation paused.
- Uncertain primary never authorizes automatic restoration, including after late candidate visibility or settlement. Uncertain restoration never retries.
- Preserve immutable prior packages and all evidence. New consent versions invalidate prior contracts.

## Review focus

- Success-shaped but wrong config/version or late response must not acknowledge a mutation.
- A settled old version must not authorize a current-version mutation.
- Running, transient, failed and drifted current state must close restoration admission.
- IPC errors/unknown dispatch must remain uncertain through cleanup and replay.
- Consent, executable pin and final package must match the corrected source.

## Task1: Native gate and protocol

Files: tools/p10b-machine-client/{main.go,stopped_diagnostic.go,*diagnostic*test.go}.

- [x] Add failing tests for independent acknowledgement, WAIT binding, created, timeout/loss/unusable output and replay denial; record red.
- [x] Add diagnostic-only WAIT with strict version body, exact GET wait route/query, timeout1000..9000ms and closed settlement output.
- [x] Latch valid POST acknowledgement; require successful WAIT plus fresh exact observation before restoration; keep initial stopped requirement.
- [ ] Run both native build-tag suites offline; retain red/green evidence.

## Task2: Controller, consent and composed boundary

Files: server/services/p10b{StoppedUpdateDiagnostic,StoppedUpdateContract,NativeMachineClient,OwnerPreflight,HostAuthentication,StoppedUpdateCli}.js; scripts/run-p10b-owner-handoff.py; associated tests; diagnostic runbook.

- [x] Write failing controller and real controller→native→SDK→loopback cases for acknowledged created/stopped, ambiguity then candidate, settlement mismatch, drift, rejection and uncertain restoration; record red.
- [x] Add session/approval v2 and mandatory acknowledged-only recovery policy; update preflight and explicit owner consent wording.
- [x] Controller captures exact valid returned version; only acknowledged branch can WAIT/readback/restore; verify restoration similarly. Preserve bounded observation/deadline/admission checks and cleanup.
- [x] Bridge accepts only narrow WAIT/settlement frame for diagnostic mode; legacy path unchanged.
- [ ] Run targeted tests, full server suite, Python handoff suites and required repository checks.

## Task3: Review and delivery

- [ ] Independent source review; fix findings with tests; verify final native binary/hash pin.
- [ ] Commit reviewed changes, push branch, verify exact-head CI without merge/deploy.
- [ ] Assemble a new passive held package with exact source/binary/consent, offline evidence and revised recovery contract; preserve old package.
- [ ] Independently review package agreement; report commit, tests, remaining blockers and exact owner live-decision requirements.
