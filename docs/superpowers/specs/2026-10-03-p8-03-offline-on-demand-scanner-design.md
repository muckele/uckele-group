# P8-03 Offline On-Demand Scanner Integration

**Status:** Owner-approved offline design; PR56 implementation independently reviewed; dependent routine operability bundle pending full review

**Date:** 2026-10-03

**Depends on:** PR55 reviewed head `55d6d8e20ce2c9267ec7d9a22e6ca6f3c66e1810`

**Deployed base:** `e16f370aa8b33e58f61cf9c67ac44e4982c65c33`

## Objective

Extend the P8 secure attachment lifecycle with one bounded, authenticated app-to-worker scan protocol and an on-demand worker adapter. The deliverable is offline source, additive local schema fixtures, and synthetic tests only. It does not create, start, or contact a Fly Machine; create or configure credentials; install or contact ClamAV; download signatures or images; transmit real attachment bytes; apply a production migration; merge; deploy; or activate intake or scanning.

The future runtime concept is one stopped Fly `shared-cpu-1x` Machine with 4 GB memory, a persistent signature volume, and ClamAV reachable only through a local Unix-domain socket. The application wakes the Machine for one bounded job, transfers the exact quarantined object through an authenticated private transport, accepts only a fresh hash-bound result, and requests stop in a `finally` path. The cost is deliberately uncommitted: the earlier $1–$3/month figure is only a provisional assumption at 10 running hours. Startup, root filesystem, signature refresh, volume, and actual compute costs require a separately approved synthetic and then provider benchmark.

## Non-negotiable boundaries

1. PR55 remains intact. This phase is a dependent branch and draft PR.
2. The existing `secure_attachment_ingestions` row is the job and verdict authority. There is no generic queue, scheduler, webhook, or second attachment lifecycle.
3. Intake and scanner readiness remain hard-disabled in runtime configuration. No environment variable or provider selection may enable this integration.
4. Production source contains no default transport, credential lookup, Machine identifier, scanner endpoint, or configured scanner instance. Every adapter dependency is explicitly injected.
5. Authentication keys used by tests are synthetic process-local bytes. No persistent access credential is created or configured.
6. Attachment bytes remain private: no HTTP download route, log, parser, renderer, AI call, email call, provider fetch, or public URL is introduced.
7. ClamAV is addressed only by an absolute Unix socket path. TCP host/port configuration and unauthenticated ClamD TCP are rejected by construction.
8. The worker creates at most one task-local ephemeral copy, verifies its size and SHA-256 while writing, scans that exact file, and removes only that task-generated file and empty task directory using ownership evidence. It never purges quarantine, vault, signature-volume, or user data.
9. Stale signatures, unhealthy scanner state, transport uncertainty, timeout, malformed response, replay conflict, ambiguous scanner output, expired request/result, hash/size mismatch, lost lease, or stop uncertainty all fail closed and never produce a clean durable verdict.
10. Owner approval and vault publication continue to use the P8 checks. A clean scan does not itself approve, publish, infer business identity, or satisfy `materialsReceived`.

## Trust boundaries and assets

The application trusts only its current P8 lifecycle row and the SHA-256/size re-read from the root-owned quarantine object. The application-to-worker transport, request/result envelopes, worker clock, scanner output, signature metadata, file paths, and streamed bytes are untrusted until validated.

The worker trusts only an explicitly injected authentication key resolver, replay store, signature-health reader, Unix-socket scanner adapter, clock, and task root. The dependent offline operability bundle adds a filesystem-backed replay store and real local Unix-socket connector; all provider control, HTTP exchange, keys, signature evidence, and verdicts exercised by tests remain deterministic synthetic inputs. Runtime wiring still requires separate approval.

Protected assets are quarantined attachment bytes, existing vault bytes, lifecycle authority, authentication material, signature storage, machine spend, and owner approval authority. Logs and errors contain bounded identifiers/status only; they exclude bytes, names, provider IDs, paths, hashes, signatures, keys, and raw scanner output.

## Existing lifecycle extension

P8 remains authoritative. This phase adds only scan-claim evidence to `secure_attachment_ingestions`:

- `lifecycle_status='scanning'` while one request owns a bounded lease;
- `scan_request_id`, `scan_job_owner`, `scan_requested_at`, and `scan_lease_expires_at` for compare-and-set ownership;
- `scan_completed_at`, `scan_signature_version`, `scan_signature_updated_at`, and `scan_verdict_expires_at` for accepted verdict freshness.

The storage interface exposes dedicated atomic `claimCimAttachmentScan`, `completeCimAttachmentScan`, and `expireCimAttachmentScanLease` operations. They are not implemented through the existing status-only update helper. Claim atomically validates eligibility, due time, global capacity, current attempt count, and status; increments the attempt; and writes request ID, owner, attempt, and lease as one transaction/RPC. Completion predicates on the exact intake ID, request ID, job owner, attempt, and unexpired lease. Expiry predicates on the same fields plus `lease_expires_at <= now`, finalizes that attempt as unavailable, and applies the normal retry delay. Every failure after claim uses the same exact-request completion operation, so no error path can silently strand or overwrite another owner.

Only one lifecycle row may be `scanning` at a time. SQLite and PostgreSQL enforce this with a unique partial index on a constant expression, keeping the single global scan slot inside the P8 lifecycle rather than adding a queue or coordinator. A claim transaction first expires at most the one overdue global lease, then attempts a new claim; a non-overdue owner blocks every other intake before bytes are opened. An expired attempt is not immediately retried: it consumes its attempt and observes the existing 15-minute/2-hour schedule. Attempt three always finalizes to HOLD. A late result from an expired or replaced request is rejected.

The existing three-attempt ceiling remains the total attempt bound. Each successful claim consumes one attempt. `unavailable` and `ambiguous` outcomes use the existing 15-minute then 2-hour retry schedule; attempt three enters HOLD with `retry_exhausted`. A crashed `scanning` lease is recoverable only after expiry and still consumes its claimed attempt. No automatic retry or scheduler is added.

Clean verdicts have a short, explicit publication validity window. The authoritative decision is an atomic `awaiting-owner-approval -> publishing` claim: storage requires `scan_verdict_expires_at > approved_at` while freezing owner/business/type intent. The final vault transaction rechecks that the frozen `owner_approved_at` preceded the frozen verdict expiry; it may resume the same crash-safe publication after wall-clock expiry, but it may not create or repurpose an approval after expiry. If a clean verdict expires before approval, an exact transition preserves prior engine/signature/completion evidence, moves the row to `scan-unavailable` with `hold_reason='scan_verdict_expired'`, and permits a separately invoked rescan only when attempts remain. Expiry after attempt three enters terminal `retry_exhausted`. No evidence or bytes are purged.

An upgraded legacy clean row with no verdict expiry is treated as expired, not grandfathered. It cannot publish and may enter the same bounded rescan path when attempts remain. Authoritative completion validates bounded engine/signature/digest/freshness evidence before storage can commit `clean` or `unsafe`. The PostgreSQL proposal derives claim, completion, expiry, and approval decisions from database time; the local SQLite implementation accepts only canonical times and bounded leases from the same trusted application process.

Existing SQLite databases would need an explicit transactional table-rebuild upgrade because the PR55 CHECK constraint does not contain `scanning`. In this phase, that rebuild is only a non-runtime proposal exercised against disposable temporary fixture databases beginning from the exact PR55 table; it cannot run against an existing deployed database. Tests preserve rows/foreign keys/indexes and exercise rollback on failure. PostgreSQL parity is likewise documented as an unapplied proposal fixture outside the production migration directory. This phase does not modify `supabase/schema.sql`, add a production migration, or invoke either proposal.

## Protocol v1

The canonical protocol identifier is `uckele.cim-scan.v1`. Canonical JSON serialization uses a fixed field order and rejects additional fields, floats, unsafe integers, unbounded text, non-UTC timestamps, invalid UUIDs, and unsupported MIME types.

### Request envelope

The authenticated request contains:

- protocol, request ID, lifecycle intake ID, attempt number, and bounded job owner;
- issued-at, request-expires-at, and lifecycle-lease-expires-at UTC timestamps with a maximum five-minute envelope lifetime and bounded clock skew; request expiry must be no later than lease expiry;
- attachment SHA-256, exact byte count, and detected MIME type;
- maximum accepted bytes and maximum worker duration, both at or below compiled protocol ceilings;
- authentication key ID, algorithm `hmac-sha256`, and signature over the canonical unsigned request.

The byte stream is outside the JSON envelope but is bound by the authenticated SHA-256 and size. Authentication, expiry, replay claim, signature health, and capacity checks occur before the stream is opened.

### Result envelope

The authenticated result contains:

- the canonical request digest plus the same protocol, request ID, intake ID, attempt number, job owner, attachment SHA-256, size, MIME type, and effective limits;
- outcome `clean`, `unsafe`, `unavailable`, or `ambiguous`;
- bounded reason code, scanner engine/version, signature version, and signature-updated timestamp;
- scanned-at and result-expires-at timestamps; and
- authentication key ID, algorithm, and signature over the canonical unsigned result.

The application verifies the result signature, request digest, and exact request/attachment binding before interpreting the outcome. A clean result is accepted only when pre-scan health, the scan session, and post-scan health came from the same connector-provided Unix peer/generation identity, both health snapshots were healthy, engine/signature identities agreed, signatures were within the compiled freshness window at scan time, the result is unexpired at receipt, the scan time falls inside the request/lease window and no later than authenticated `issuedAt + maxDurationMs`, and all identities match exactly. Future-dated health/signature timestamps fail closed. Human-readable scanner text is never accepted as authority or persisted.

### Authentication and replay

Protocol helpers accept a key resolver; they never read process environment or files. Offline tests use fixed synthetic keys. Request and result MACs use distinct domain prefixes and direction-derived HMAC subkeys. Parsers cap raw UTF-8 bytes before JSON parsing, require the exact canonical wire representation (thereby rejecting duplicate keys, alternate field order, and insignificant whitespace), reject unknown fields, and compute the request digest over the exact canonical unsigned request. Future activation requires a dedicated minimum-scope secret, globally unique request IDs, bounded old/new-key overlap, explicit signing-key selection, and rotation procedure approved separately.

The worker replay store atomically claims `(keyId, requestId)` with the canonical request digest until request expiry. The same ID with another digest is a conflict. A duplicate completed request may return only the previously signed, unexpired result for the same digest; in-flight or outcome-unknown duplicates return `ambiguous` without consuming bytes. Replay storage is bounded by expiry and a compiled maximum entry count. The dependent P8-04 implementation uses one private filesystem SQLite file with full-synchronous, zero-wait immediate transactions and deadline-bounded lock retries. It stores only protocol identifiers, digests, timestamps, and signed results—never attachment bytes or provider metadata. Live volume selection, backup/recovery, monitoring, and mount permissions remain activation prerequisites.

## App adapter and Machine lifecycle

`createOnDemandScannerAdapter` implements the existing injected P8 scanner interface after extending that seam to receive the claimed intake/request/owner/attempt/lease context and an already opened quarantine file handle. The application opens the quarantine object once with no-follow semantics, verifies `fstat`, size, and SHA-256 from that descriptor, rewinds it, and streams that same descriptor so a path cannot be swapped between verification and transfer. The adapter receives explicit protocol authentication, a transport, clock, limits, and claim context. It builds a request for that exact identity, asks the transport to run one job, verifies the response, and returns the bounded P8 outcome plus dynamic engine/signature/binding evidence; static adapter `name/version` never substitutes for result evidence.

`createFlyMachineScanTransport` is an unwired provider-specific adapter over injected `machineController` and two-phase `requestClient` interfaces. It accepts the database claim request ID as its session generation, requires an initially stopped Machine, acquires an exact provider generation/fencing token, starts only that session, and may send or stop only while both tokens still match. A late `finally` from a lost generation cannot stop a newer session. If the provider cannot prove generation-fenced stop semantics, live activation remains blocked; this phase does not add a broader coordinator.

The request client first sends only the signed bounded envelope and waits for explicit worker admission. The HTTP contract requires host-pinned encrypted private transport with redirects forbidden and an `Expect: 100-continue`-equivalent handshake. Only the admitted upload handle receives the lazy quarantine stream factory. P8-04 implements this policy and bounded streaming over an injected HTTP exchange seam, with no default socket/network implementation, endpoint, or pin. The app derives one app-local monotonic deadline from its durable UTC lease for acquire, start, admission, upload, response, and stop; monotonic values never cross the machine boundary. After bounded UTC-skew validation, the worker derives its own local monotonic deadline from the minimum of request expiry, lifecycle lease expiry, and maximum worker duration for admission, upload, scan, response, and cleanup. Every timeout aborts or closes its iterator/socket/request/controller operation rather than merely racing a promise. The app/database still reject completion after the exact durable lease expires. Response bytes and total elapsed time are capped. Stop failure or uncertain Machine state converts a clean result to `unavailable`; a verified unsafe result remains unsafe while the operational incident is recorded separately.

Only synthetic injected control/HTTP seams exercise this code in this phase. No network request is made.

## Single-task worker

`runOnDemandScanTask` accepts one envelope and one lazy byte-stream factory. It performs, in order:

1. strict request parsing, authentication, time/limit validation, a process-global one-task admission lock, and replay claim;
2. pre-scan scanner health and signature freshness validation from the injected Unix-socket scanner;
3. creation of a random task directory below a validated non-symlink ephemeral root, mode `0700`;
4. creation of an authenticated owner marker and one `attachment.bin` file, mode `0600`;
5. bounded streaming with deadline, exact size, and SHA-256 verification;
6. scan through the injected Unix-socket-only ClamAV adapter;
7. post-scan health validation against the same daemon/engine/signature identity and mapping exact scanner output to a staged bounded outcome;
8. cleanup of the owned file, marker, and empty task directory; and
9. only after cleanup, signing and atomically completing the replay record with the final result.

Cleanup uses `lstat`/`realpath` checks, a root-beneath check, exact expected names, and an HMAC owner marker whose expected request identity comes from authenticated state. It unlinks individual regular files and removes only the empty task directory; it never recursively removes a path and never follows symlinks. Cleanup refusal downgrades a staged clean result to `ambiguous`, retains evidence for operator review, and never broadens the target. A verified unsafe verdict remains unsafe even when cleanup fails; cleanup uncertainty is recorded as a separate bounded incident. If the process crashes before replay completion, replay remains in-flight/ambiguous and can never expose the staged clean result.

At startup, the worker performs a bounded inspection of the ephemeral root. It cleans only individually verified, authenticated task-owned entries whose request has expired, subject to the same non-recursive rules. Unknown, excessive, malformed, symlinked, or unverifiable entries make the worker unavailable and require operator review, preventing crash orphans from silently exhausting disk or triggering broad cleanup.

The ClamAV adapter accepts only an absolute Unix socket path and an injected Unix connector. Every connected session must expose a stable, bounded peer/generation identity; health and scan results return it so the worker can require pre/scan/post equality. It sends exact `zINSTREAM\0`, frames each chunk with a four-byte big-endian length below the compiled ClamD limit, sends a zero-length terminator, and accepts one NUL-terminated terminal: anchored `stream: OK`, `stream: <bounded-name> FOUND`, or `stream: <bounded-error> ERROR`. Multiple terminals, truncated data, unexpected labels/tokens, non-terminated output, or protocol noise are `ambiguous`. Connection, abort, timeout, and anchored scanner errors are `unavailable`. Caps abort and close the stream/socket. No TCP connector exists.

The worker process is designed to handle one task and exit. Machine stop remains an app-side provider responsibility because the worker must not hold a Fly control-plane credential.

## Bounded limits

Compiled ceilings, tightened per injected call but never relaxed, are:

- attachment bytes: existing secure-document per-file maximum, currently 8 MiB;
- request JSON: 16 KiB;
- result JSON: 16 KiB;
- request lifetime: 5 minutes;
- startup wait: at most 60 seconds and always bounded by the shared deadline;
- worker scan: at most 90 seconds and always bounded by the shared deadline;
- end-to-end durable UTC lease: 4 minutes, converted independently to app-local and worker-local monotonic budgets;
- result transport validity: no later than both request expiry and lease expiry;
- clean publication validity: 24 hours;
- one worker task and one ClamAV stream at a time;
- response/scanner text: 4 KiB; and
- replay entries: 10,000 before fail-closed capacity rejection.

Tests use smaller limits where useful. These values are implementation safety ceilings, not production sizing evidence.

## Outcome mapping

| Condition | Protocol result | P8 state / hold |
|---|---|---|
| Exact clean result, fresh signatures, valid bindings | `clean` | `awaiting-owner-approval` with verdict expiry |
| Exact malware match | `unsafe` | terminal `unsafe` / `unsafe` |
| Scanner/signature/start/stop/transport unavailable | `unavailable` | retryable `scan-unavailable`, then `retry_exhausted` |
| Conflicting replay, malformed/multiple scanner terminals, binding uncertainty, clean-copy cleanup uncertainty | `ambiguous` | stored as `scan_status='unavailable'`, retryable `scan-unavailable` / `scan_ambiguous`, then `retry_exhausted` |
| Expired request or response, stale signature database | no clean authority | `scan-unavailable` with bounded reason |
| Lost/replaced lease or late result | ignored/rejected | current lifecycle remains authoritative |
| Clean verdict expired before approval | no publication | `scan-unavailable` / `scan_verdict_expired` when attempts remain; `retry_exhausted` after attempt three |

## Synthetic verification and later benchmark

Offline tests must prove authentication-before-bytes, canonical signature rejection, replay conflict/idempotency, two-intake global-slot races, lease expiry/recovery, late-result rejection, generation-fenced stop, exact descriptor/hash/size/request-digest/result binding, pre/post signature freshness, all four outcomes, request/result/verdict expiry, expired-publication recovery, hard byte/time/response caps with active abort, exact Unix-socket-only ClamAV framing, malformed output handling, startup orphan refusal, task-copy cleanup ownership, stop-in-finally behavior, and unchanged P8 approval/materials authority.

A later separately approved smoke is exactly eight synthetic jobs, not 284 cases, and should use an approved harmless antivirus fixture or generated non-user bytes only. It records cold/warm Machine start latency, signature readiness time and age, scan latency at 1 KiB and 8 MiB, peak memory/CPU, root filesystem growth, volume size/I/O, replay/conflict behavior, timeout/owned cleanup/owned stop, stop latency/reliability, billed runtime granularity, and monthly cost at 0/1/10/25 running hours. It must not claim the provisional $1–$3/month estimate as a guarantee. This phase grants no live-smoke permission.

## Activation approvals still required

Before any live resource or byte is used, the owner must separately approve:

1. exact Fly organization/app/region, Machine image digest, `shared-cpu-1x`/4 GB size, stopped-by-default policy, auto-start/auto-stop behavior, and spend ceiling;
2. persistent signature volume region/size/encryption/backup/retention and signature refresh source/schedule/freshness threshold;
3. ClamAV version, image/build provenance, Unix socket path/permissions, and disabled TCP listener proof;
4. creation, storage, direction-derived key rotation overlap, revocation, and least-privilege scope of app/worker protocol authentication and any Fly control-plane credential;
5. private encrypted host-pinned transport/DNS/TLS/firewall policy, admission-before-body handshake, redirect prohibition, and provider generation-fenced start/stop proof;
6. production migration and rollback for additive lifecycle fields/constraints;
7. crash-durable atomic replay/admission authority, logging, metrics, alerting, replay retention, orphan handling, incident response, and operator runbook;
8. synthetic benchmark execution and measured cost/latency acceptance;
9. limited non-user canary, then any real attachment canary with explicit data-handling approval; and
10. separate runtime wiring plus deliberate intake/scanner gate activation.

## Non-goals

No generic job system, provider attachment download, live credentials, Fly resource, paid spend, image pull, scanner/signature installation, real byte transfer, OCR/AI/fact extraction, UI expansion, automatic owner decision, automatic purge, production migration, merge, deploy, or activation is part of this phase.
