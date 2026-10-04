# P8-03 On-Demand Scanner: Offline Handoff

**State:** design, synthetic integration, and dependent offline operability bundle only; not configured, deployed, or active

**Dependency:** PR55 reviewed head `55d6d8e20ce2c9267ec7d9a22e6ca6f3c66e1810`

## What exists in this phase

The application can model one globally leased scan job on the existing P8 attachment lifecycle. Protocol helpers sign a short-lived exact attachment identity; an unwired adapter can perform a generation-fenced start/admit/upload/stop lifecycle through injected interfaces; a single-task worker can validate the request, require fresh scanner evidence, create and safely remove one ephemeral copy, and return a signed result; and a ClamAV adapter implements bounded `INSTREAM` framing over an injected Unix-socket connector only.

All exercised control/HTTP seams, authentication keys, scanner responses, signature evidence, and attachment bytes are synthetic. The dependent P8-04 bundle adds a filesystem replay implementation, a one-shot worker/file-descriptor entrypoint, a real local Unix-socket connector, and concrete policy adapters over injected Fly-control and HTTP-exchange seams. There is still no default provider implementation, credential lookup, Machine ID, hostname, certificate pin, or runtime registration. `secureDocuments.cimAttachmentIntake.enabled` and `.scannerReady` remain literal `false` values with no environment activation path.

The Supabase SQL under `docs/operations/sql/` is a rollback-only review proposal. It is not in `supabase/migrations`, is not reflected in the deployed schema, and must not be applied from this branch. Fresh disposable SQLite test databases contain the offline fields; existing deployed databases are not upgraded.

## Intended later runtime shape

Subject to separate approval, the bounded concept is one stopped Fly Machine using `shared-cpu-1x` with 4 GB memory, one persistent volume used for ClamAV signatures and crash-durable replay metadata, and one ClamAV daemon reachable only through a local Unix-domain socket. The application would own the Fly control-plane credential. The worker would not.

The application would atomically claim the one P8 scan slot, acquire an initially stopped provider generation, start that exact generation, send only the authenticated envelope, wait for authenticated worker admission, and then open the already verified quarantine descriptor for upload. Stop would be attempted only by the matching database request generation and provider generation. The worker would handle one task and exit. A provider that cannot prove fenced start/stop ownership is not acceptable for activation.

The future Unix connector must derive a stable peer/generation identity from the local endpoint/process generation and return it for every connection. The worker requires exact identity equality across pre-scan health, the scan stream, and post-scan health; version text alone is not sufficient identity evidence.

No ClamD TCP listener is permitted. Activation evidence must show that TCP is disabled and that the Unix socket owner/mode admit only the worker process.

## Fail-closed operator states

- `scan_unavailable`: transport, scanner, signature, or Machine lifecycle could not prove a verdict; retry is bounded.
- `scan_ambiguous`: output, replay, binding, cleanup, or signature continuity was uncertain; retry is bounded.
- `scan_lease_expired`: an owned attempt crashed or exceeded its lease; it consumes that attempt and observes the normal delay.
- `unsafe`: a definite malware match; never publish. Cleanup uncertainty does not weaken this verdict.
- `scan_verdict_expired`: a clean verdict expired before owner approval; explicitly rescan if an attempt remains.
- `retry_exhausted`: attempt three failed or its clean verdict expired; owner/operator review is required.

Quarantine retention stays `hold`. None of these states deletes quarantine, vault, signature-volume, or user data. Startup cleanup may remove only individually authenticated expired task copies beneath the worker ephemeral root. Unknown or unverifiable entries make the worker unavailable.

## Approvals required before any live action

The owner must separately approve all of the following, in this order:

1. The exact reviewed branch/head and a production migration/rollback plan for lifecycle fields, constraints, partial index, RPCs, publication-expiry guard, SQLite compatibility, database-time semantics, and conversion of legacy clean rows with null verdict expiry into non-publishable rescan/HOLD state.
2. Fly organization, app, region, exact image digest/provenance, Machine ID, `shared-cpu-1x`/4 GB size, stopped-by-default behavior, provider generation-fencing proof, and a monthly spend ceiling.
3. Signature-volume region, size, encryption, backup/restore policy, retention, I/O expectations, and failure handling.
4. ClamAV version/build provenance, image contents, Unix socket path/ownership/mode, disabled TCP proof, signature source, refresh schedule, and maximum accepted signature age.
5. Creation and minimum scopes of the Fly control-plane credential and the dedicated app/worker protocol secret; storage locations, direction-derived subkeys, bounded rotation overlap, revocation, and incident procedure.
6. Private encrypted host-pinned transport, DNS/TLS/firewall policy, redirect prohibition, admission-before-body handshake, maximum payload/deadlines, and certificate rotation.
7. Crash-durable atomic replay/admission storage on the worker volume, entry cap/expiry, restart epoch behavior, and orphan inspection/alerting.
8. Logs, metrics, alerts, privacy review, operator identities, retry/recovery commands, unsafe-file response, and cost/runaway-Machine alerts. Logs must exclude bytes, filenames, provider IDs, hashes, paths, signatures, tokens, and raw scanner output.
9. The synthetic benchmark below and explicit acceptance of measured startup, resource, storage, reliability, and cost results.
10. A limited non-user canary using approved synthetic fixtures, followed by a separately approved real-attachment canary and data-handling review.
11. Deliberate runtime wiring and only then separate activation of scanner readiness and intake. No environment variable alone may activate either gate.

## Later eight-job live-smoke proposal

Run only after fresh action-time approval of approvals 1–9, the exact reviewed head, resource target, cost ceiling, fixtures, cleanup targets, and stop conditions. Use generated non-user files and an approved harmless antivirus test fixture; do not use broker email, provider downloads, or real attachments. This phase grants no smoke permission.

The smoke is exactly eight jobs, not 284 cases: cold/warm clean 1 KiB, cold/warm clean 8 MiB, one approved harmless unsafe fixture, one stale-signature refusal, one replay/conflict job, and one timeout/owned-cleanup/owned-stop job. Record for each applicable job:

- provider start request to generation-owned running state;
- worker admission latency and rejection behavior;
- signature database version, age, refresh duration, and volume I/O;
- authenticated upload throughput and total bytes;
- ClamAV scan latency, CPU, and peak RSS;
- root filesystem and persistent volume growth before/after cleanup;
- signed-result latency and replay behavior;
- stop request latency, generation ownership, final stopped state, and any uncertain stop;
- forced timeout/abort, crash-after-copy, crash-after-scan, cleanup refusal, and restart-orphan behavior; and
- provider-billed runtime granularity plus volume/rootfs/signature-transfer charges.

The final timeout/owned-cleanup/owned-stop job is one top-level acceptance job with distinct
timeout/recovery, crash-after-copy/recovery, crash-after-scan/recovery, and cleanup-refusal/recovery
exchanges. Crash acceptance requires both an expected benchmark-only image and proof that the exact
owned Machine generation stopped; a generic disconnect is insufficient. The crash images terminate
only through injected lifecycle seams after an authenticated exact copy or a completed scanner call.
Cleanup refusal uses the existing injected cleanup seam and must return signed
`ambiguous`/`cleanup_uncertain` with retained cleanup status, never clean. Every recovery waits until
the preceding authenticated request expires before removing its HMAC-owned orphan.

These modes are packaged only in separately named benchmark image targets with immutable entrypoint
selection. The normal HTTP worker rejects all `CIM_SCAN_BENCHMARK_*` environment values, and no
request field, header, listener route, production startup registration, or runtime activation flag
selects a fault. Offline doubles cover the state transitions; they do not qualify an image or grant
live execution. A later live orchestrator must select each reviewed benchmark image externally and
retain the control-plane stop evidence for that exact phase. The caller exposes an injected target
resolver and fail-closed preflight for that integration: all eight phase targets must be present,
each fault/recovery pair must name the same exact Machine and app (preserving its orphan state), all
recoveries must use the reviewed normal image digest, and the three fault phases must use distinct
reviewed fault-image digests. The standalone CLI intentionally supplies no resolver, so this
composite scenario stops before its first Machine composition until an approved live orchestrator
provides that exact mapping; the other seven scenarios retain their single reviewed target.

Project monthly cost from measured provider billing for 0, 1, 10, and 25 running hours, including persistent storage and signature refresh overhead. The prior $1–$3/month figure is not a guarantee; it was a provisional estimate assuming about 10 running hours and remains unaccepted until this smoke supplies actual startup, root filesystem, signature, compute, and storage costs.

Permanent volume deletion or any other unrecoverable data deletion is never preapproved by this runbook. It requires action-time approval naming the exact target.

## Current prohibitions

Do not create or start a Fly resource; create/configure credentials; pull/build an image; install or contact ClamAV; download signatures; open a real socket/network connection; transfer real attachment bytes; call Resend, email, or AI; apply either schema proposal; activate intake/scanner gates; merge; deploy; or purge any user data from this phase.
