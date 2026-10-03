# P8-03 Offline On-Demand Scanner Implementation Plan

**Goal:** Add a reviewed, offline-only on-demand scanner protocol and adapter on top of P8 without live wiring or operational action.

**Architecture:** The existing attachment lifecycle atomically leases a single global scan slot to one exact request. A signed, expiring, hash-bound protocol crosses an injected two-phase transport to a one-task worker. The worker requires healthy fresh pre/post scan evidence, writes one bounded task-owned copy, scans only over an injected Unix-socket ClamAV seam, safely cleans only its own ephemeral files before signing the final result, and exits. Provider and scanner fixtures are synthetic; runtime gates stay hard-off.

**Tech stack:** Node.js 22 ESM, `node:test`, built-in crypto/fs/net primitives, existing SQLite/Supabase fixtures, no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-03-p8-03-offline-on-demand-scanner-design.md`

## Global constraints

- Depend exactly on PR55 head `55d6d8e20ce2c9267ec7d9a22e6ca6f3c66e1810`; preserve that branch and publish separately as a dependent draft PR.
- No credentials, resources, spend, downloads, provider/scanner/network calls, real bytes, production migration, merge, deploy, or activation.
- No environment shortcut or default instance can enable intake/scanning, transport, Fly, or ClamAV.
- No permanent user-data purge. Cleanup is limited to task-generated ephemeral copies with ownership evidence.
- Every task uses tests first and preserves existing P8 owner approval, private quarantine, deduplication, and vault authority.

## Task 1: Protocol contract and threat tests

**Files:** `server/services/cimScanProtocol.js`, `test/cimScanProtocol.test.js`

**Dependencies:** None.

**Acceptance criteria:**

- [ ] Raw-byte-capped canonical request/result schemas enforce identities, UTC times, algorithms, fields, byte/time ceilings, request digest, and exact hash/size/MIME/limit bindings; noncanonical or duplicate-key JSON is rejected.
- [ ] HMAC signing/verification uses direction-derived, domain-separated subkeys from injected synthetic keys and timing-safe comparison; no environment/file credential lookup exists.
- [ ] Expired, future, tampered, oversized, extra-field, replay-conflicting, or mismatched envelopes fail before a lazy byte stream opens.

**Verification:**

- [ ] RED then GREEN: `node --test test/cimScanProtocol.test.js`.

## Task 2: Existing lifecycle scan lease

**Files:** `server/services/cimAttachmentIntake.js`, `server/storage/sqlite.js`, `server/storage/supabase.js`, `docs/operations/sql/p8-03-offline-on-demand-scanner-proposal.sql`, `test/cimAttachmentIntake.test.js`, `test/cimAttachmentStorageContract.test.js`, `test/supabaseSecurity.test.js`

**Dependencies:** Task 1.

**Acceptance criteria:**

- [ ] Dedicated transaction/RPC primitives atomically claim, complete, and expire one exact request/owner/attempt/lease; the attempt increment is never a read-modify-write race.
- [ ] A unique partial index on the existing lifecycle enforces one global `scanning` row; expired leases finalize through normal retry timing, two-intake losers do not open bytes, and late/replaced results cannot mutate state.
- [ ] Accepted clean evidence records engine/signature/completion/verdict expiry; ambiguous maps to unavailable plus `scan_ambiguous`; unavailable/expired leases consume the existing bounded retry schedule.
- [ ] Atomic owner approval requires an unexpired clean verdict; final SQLite/Supabase publication rechecks frozen approval-before-expiry, while expired verdicts preserve evidence and rescan only when attempts remain.
- [ ] Disposable SQLite fixture tests exercise a proposed rebuild of the exact PR55 CHECK constraint while preserving rows/indexes/foreign keys; no runtime path can invoke that rebuild against an existing database, `supabase/schema.sql` remains unchanged, and PostgreSQL SQL remains an unapplied proposal fixture.

**Verification:**

- [ ] RED then GREEN: `node --test test/cimAttachmentIntake.test.js test/cimAttachmentStorageContract.test.js test/supabaseSecurity.test.js`.

## Checkpoint A: Protocol and authority

- [ ] Independent design scrutiny finds no unresolved critical/high issue in Tasks 1–2 contracts.
- [ ] Focused tests pass without opening network sockets or using persistent credentials.

## Task 3: Single-task worker and replay authority

**Files:** `server/services/cimScanWorker.js`, `test/cimScanWorker.test.js`, `test/support/cimScanFixtures.js`

**Dependencies:** Task 1.

**Acceptance criteria:**

- [ ] Authentication, expiry, crash-durable activation boundary, global admission, replay, pre-scan signature freshness, orphan inspection, and capacity are checked before the lazy stream is opened.
- [ ] One private task copy is bounded and exact-hash verified; post-scan health is bound to the same daemon/engine/signature identity; results are only signed/replay-completed after cleanup.
- [ ] Cleanup unlinks only authenticated task-owned regular files and an empty task directory; symlinks, path escape, marker mismatch, orphan excess, and cleanup uncertainty fail closed without recursive deletion; verified unsafe remains unsafe.

**Verification:**

- [ ] RED then GREEN: `node --test test/cimScanWorker.test.js`.

## Task 4: Unix-socket-only ClamAV adapter

**Files:** `server/services/clamavUnixSocketScanner.js`, `test/clamavUnixSocketScanner.test.js`, `test/support/cimScanFixtures.js`

**Dependencies:** Task 3 interface.

**Acceptance criteria:**

- [ ] Only an absolute Unix socket path plus injected Unix connector is accepted; host/port/TCP configuration is impossible through the API.
- [ ] Exact `zINSTREAM\0`, four-byte big-endian chunks, zero terminator, total bytes, response bytes, and monotonic deadline are hard-capped with active abort/close.
- [ ] One NUL-terminated `stream: OK`/`stream: ... FOUND` maps deterministically; anchored ERROR is unavailable; malformed/multiple/truncated output is ambiguous.

**Verification:**

- [ ] RED then GREEN: `node --test test/clamavUnixSocketScanner.test.js`.

## Task 5: App adapter and synthetic Fly lifecycle

**Files:** `server/services/onDemandCimScanner.js`, `server/services/flyMachineScanTransport.js`, `test/onDemandCimScanner.test.js`, `test/flyMachineScanTransport.test.js`, `test/support/cimScanFixtures.js`, `test/cimAttachmentStorageContract.test.js`, `test/config.test.js`

**Dependencies:** Tasks 1–4.

**Acceptance criteria:**

- [ ] The adapter extends the P8 scanner seam with exact claimed context and a once-opened no-follow descriptor, then validates request digest and signed dynamic result evidence before returning an outcome.
- [ ] The provider adapter has only injected controller/two-phase client dependencies, requires initial stopped state, converts the authenticated UTC lease into process-local monotonic app/worker deadlines, performs one bounded wake/admit/request/stop lifecycle, and never invokes the lazy stream before admission.
- [ ] Machine send/stop is fenced by database request generation plus injected provider generation; two-intake/late-finally tests prove a non-owner cannot send or stop, and unsupported real fencing remains an activation blocker.
- [ ] Source-contract tests prove no runtime wiring, env activation, default Machine ID/host/token, scanner TCP, network call, or production fake scanner exists.

**Verification:**

- [ ] RED then GREEN: `node --test test/onDemandCimScanner.test.js test/flyMachineScanTransport.test.js test/config.test.js test/cimAttachmentStorageContract.test.js`.

## Checkpoint B: Offline end-to-end integration

- [ ] A synthetic clean job traverses lifecycle claim → signed request → worker → Unix socket fixture → signed response → awaiting owner approval.
- [ ] Stale signatures, timeout, replay conflict, hash mismatch, ambiguity, lease loss, verdict expiry, cleanup refusal, and stop failure remain unpublished and fail closed.
- [ ] Existing owner-approval/vault and `materialsReceived` tests remain unchanged in authority.

## Task 6: Operational design and synthetic benchmark proposal

**Files:** `docs/operations/p8-03-on-demand-scanner-runbook.md`, design/spec updates as needed.

**Dependencies:** Tasks 1–5.

**Acceptance criteria:**

- [ ] Document stopped-Machine/4 GB/Unix-socket/signature-volume concept without creating resources or presenting it as active.
- [ ] List every activation approval, rollback/observability requirement, and exact prohibited current action.
- [ ] Define a synthetic benchmark that measures startup, signature freshness, scan latency/resources, storage, stop reliability, and billed cost without guaranteeing $1–$3/month.

**Verification:**

- [ ] Source review confirms commands are proposals only and contain no credential values or executable activation shortcut.

## Task 7: Full verification, independent review, and dependent draft PR

**Files:** Entire branch diff and existing `.github/workflows/ci.yml`.

**Dependencies:** Tasks 1–6.

**Acceptance criteria:**

- [ ] Focused tests, `npm run eval:follow-ups`, lint, full unit/UI suites, build, dependency audit, and browser suite pass under Node 22.
- [ ] Independent correctness/security review of the exact diff finds no unresolved critical/high issue; findings are fixed and reverified.
- [ ] Reviewed exact head is committed, pushed as a branch dependent on PR55, opened as a draft PR without merging, and hosted CI is recorded exactly.

**Verification:**

- [ ] `npm audit --omit=dev`
- [ ] `npm run check`
- [ ] `npm run test:browser`
- [ ] `git diff --check`
- [ ] `git status --short --branch`
- [ ] Exact PR head SHA and every GitHub Actions check conclusion recorded.

## Stop condition

Stop at the reviewed offline integration. Do not create/configure the worker, volume, image, signatures, credentials, transport, production migration, or gates. Hand off the exact later approvals and synthetic benchmark proposal from the design and runbook.
