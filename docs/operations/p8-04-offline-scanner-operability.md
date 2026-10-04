# P8-04 Offline Scanner Operability Bundle

**State:** reviewed-source candidate with immutable source locks and one successful local `linux/amd64` image build at commit `488269a9609d06b889135c92526c93bd64cf1c33`; that image was later run only in the separately approved local smoke. The current source healthcheck correction is not built or image-qualified, the image was not pushed, and no live resource is configured.

**Depends on:** PR56 exact head `04ac67e69dbd2cb60e3fa3b5a0897a2673cf321f`, which depends on PR55 exact head `55d6d8e20ce2c9267ec7d9a22e6ca6f3c66e1810`

## Bounded completion in this follow-up

This branch closes routine operability gaps without changing the approved architecture:

- `createFilesystemCimReplayStore` stores claim and result authority in one private SQLite file beneath an explicit absolute root. Full-synchronous immediate transactions make expiry pruning, cap admission, claim publication, and result completion atomic across independently constructed writers; an interrupted transaction rolls back on reopen, and the shared abort signal and monotonic deadline are rechecked before commit. Claims survive restart as in-flight authority, completed unexpired results replay byte-for-byte, digest conflicts fail before body access, expired rows are removed transactionally, and the 10,000-entry compiled ceiling fails closed.
- `run-cim-scan-worker.js` is a one-task file-descriptor entrypoint. It requires private request, attachment, and key files plus explicit replay/ephemeral roots and an absolute ClamAV Unix socket. It has no TCP scanner option, no credential lookup, no provider controller, and no daemon loop.
- `createNodeClamavUnixConnector` accepts only a real non-symlink Unix socket and binds the session identity to the socket device/inode before and after connect.
- `createFlyMachineController` and `createPinnedHttpScanRequestClient` are concrete policy adapters over injected control and HTTP exchange seams. There is no default network implementation, credential source, Fly application/machine selection, certificate pin, or runtime registration. The control seam must supply atomic `start-if-owned` and `stop-if-owned` behavior; a plain read-then-stop implementation is not sufficient.
- `createFlyMachinesApiClient` is an inert low-level client for exact Machine inspect, lease acquire/release, start, wait, and stop calls. Every identity, credential, response cap, deadline, abort signal, lease TTL, lease nonce, wait target, and stop choice is explicit; its HTTP transport is injected, successful responses are streamed under a hard cap, non-success response streams are aborted and cancelled without being read, provider failures are not retried, and provider or credential text is not reflected into errors. It does not choose lease renewal or ownership policy, map provider leases into `start-if-owned`/`stop-if-owned`, read environment variables, use a global network default, or register itself with runtime startup.
- `createFlyMachineLeaseController` maps that low-level client into the existing Machine-controller seam for one fixed 240-second lease per scan. It never renews or reacquires. The lease nonce is the provider fence, every mutation carries that nonce, and each API deadline is the earlier of the caller's durable-lease-derived monotonic deadline and a local monotonic deadline calculated from the provider's actual returned `expires_at` at receipt. An expired, missing, or replaced nonce permits no further mutation; an ambiguous stop is attempted once and is never followed by release.
- `createNodePinnedHttpsExchange` supplies the existing two-phase request client with an injected Node HTTPS request implementation. It accepts only the exact `https://<machine-id>.vm.<scanner-app>.internal/v1/cim-scan` endpoint, uses that exact hostname as SNI, retains normal CA and hostname verification, adds one explicit SPKI SHA-256 pin, sends headers before body, and exposes no default network transport or pin-rotation framework. Deadlines and aborts actively destroy the request. The worker HTTPS server, certificate/key provisioning, same-organization 6PN proof, and runtime composition are not part of this source chunk.
- `containers/cim-scan-worker/` defines the intended one-shot package and a ClamD configuration with only `LocalSocket /run/clamav/clamd.sock`. It does not refresh or download signatures.
- The source package overrides the base image's TCP `localhost:3310` healthcheck with a bounded exact `zPING`/`PONG` probe of that same real Unix socket. It validates the endpoint type and device/inode across connect. After entrypoint readiness succeeds, a four-second bounded dwell covers Docker's one-second start-period cadence plus its three-second health timeout before the one-shot scan starts. This is readiness only; the worker still performs authoritative pre/post-scan VERSION, signature freshness, and daemon-identity checks.
- `npm run cim:scan:synthetic` runs exactly seven local cases. All scanner/controller/network outcomes are synthetic protocol behavior. The fake EICAR verdict is an injected unsafe result over harmless generated bytes; it is not EICAR content and does not demonstrate real antivirus detection.

## Immutable source pin and reviewed local build

The package keeps the official source tags and locks them to immutable multi-platform index digests. `source-lock.json` records the required `linux/amd64` platform and its resolved platform manifests:

- `node:22-alpine`: index `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`; `linux/amd64` manifest `sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8`.
- `clamav/clamav:1.4.6_base`: index `sha256:90effb795234e6a93b070310a4bab5a58d93d94b9a077a09ce2229947679782b`; `linux/amd64` manifest `sha256:58d9b21b5694a1f5b3a136e4f2e4fc6b463fce88635737e16f8cb9ee9455a199`.

On 2026-10-03, official Docker Hub metadata matched all four values immediately before one independently reviewed build from commit `488269a9609d06b889135c92526c93bd64cf1c33`. The build explicitly selected `linux/amd64`, completed in 17 seconds, and produced local image ID `sha256:a627fd2427bace7d3f90820fede5f5ab5e1dfb842de6e0600e35196703a800ac` at 323,454,785 bytes. The checked-in `package-lock.json` installed 158 production packages with no compiler fallback and zero reported audit vulnerabilities. Physical Docker storage increased by approximately 630.5 MiB during the monitored build window.

The image was inspected without executing it. It remained local and unpushed, has no registry repo digest, and was not used to start ClamAV, refresh or download signatures, scan a file, or exercise EICAR. This local image ID is evidence for that exact local artifact only; it is not a deployable registry identity.

The later bounded local smoke used that exact image and proved the real one-shot scan path, but also exposed an inherited-healthcheck mismatch: the base script probed TCP `localhost:3310`, while the checked-in configuration intentionally exposes only `/run/clamav/clamd.sock`. All scan results remained valid and every job exited zero, but Docker retained `unhealthy` status. The current source replaces that mismatched probe; because no second build or container execution was authorized, the existing image ID does not contain or verify this correction.

## Exact bounded healthcheck requalification

Do not call a corrected image verified until a separately approved requalification does all of the following once, with no automatic retry:

1. Build one `linux/amd64` image from the exact independently reviewed correction commit, using the same immutable Node and ClamAV source locks. Bound the combined build and verification window to 20 minutes and 2 GiB additional physical Docker storage, with an operator stop before 1.8 GiB; do not prune, change Docker settings, or disturb unrelated containers.
2. Inspect without running to record the new image ID, `linux/amd64` platform, source-lock provenance, and the overridden Unix-socket `HEALTHCHECK`. Stop on a digest, platform, dependency, compiler/toolchain, or unexpected-download mismatch.
3. If the retained official signature volume is still within the compiled 24-hour freshness window, run exactly one generated clean 1 KiB one-shot job from the new image with `--network none`, 1 CPU, 4 GiB RAM with no additional swap, 256 PIDs, and the existing 90-second worker limit. Do not run EICAR. If signatures are stale, stop and seek separate approval for one official FreshClam refresh rather than downloading automatically.
4. Observe and preserve proof that the owned container reaches Docker `healthy` through the Unix-socket probe before it exits zero, returns a correctly bound signed `clean` result, cleans its owned task copy, uses no network, and leaves unrelated Docker state unchanged. Retain the new image, owned exited container, existing signature volume, and redacted evidence; deletion remains separately approval-gated.

Source tests alone prove the replacement probe's exact Unix-socket protocol, stalled-peer deadline, device/inode replacement rejection, Containerfile selection, and entrypoint readiness-before-dwell-before-worker ordering. They do not prove the health status or scheduler timing of an image that has not been rebuilt and run.

## Seven-case local protocol harness

The local harness covers:

1. clean 1 KiB generated bytes;
2. clean 8 MiB generated bytes;
3. an injected fake EICAR/unsafe verdict over harmless bytes;
4. stale-signature refusal before body open;
5. independent hash and size mismatch refusal;
6. exact replay plus conflicting replay with no second/conflicting body open; and
7. timeout with active stream abort, expired owned task-copy cleanup on the next task, and generation-owned stop simulation.

The harness does not contact ClamAV, Fly, Docker, a registry, email, storage providers, or any production endpoint. It uses no user or real attachment bytes.

## Still unwired and inactive

The application gates remain literal false values. Nothing imports these adapters into production startup. No production migration or proposal SQL is applied. The lease controller and pinned HTTPS exchange are not composed into the application, and no worker HTTPS server, concrete request implementation, credential, key file, certificate pin, machine identity, signature volume, signature updater, alert, or runtime endpoint is configured. The successful local build changes none of those runtime gates.

The next live phase remains blocked on action-time approval of the exact reviewed head; an exact registry image identity and publication path; proof that the existing `uckele-group` caller and future scanner app share the intended Fly organization/6PN; Fly app, region, Machine size, and spend ceiling; volume and signature lifecycle; credentials and certificate/key provisioning; the worker HTTPS server and composition; production migration and rollback; monitoring; and the data-handling plan. The runtime target must remain `linux/amd64` unless a separately reviewed ClamAV source supplies another architecture.

Any permanent volume deletion or other unrecoverable data deletion requires a new action-time approval naming the exact target. This bundle grants no blanket future deletion preapproval.

If a later live smoke is approved, it is exactly eight bounded synthetic jobs, not a 284-case run. Its exact fixtures, expected outcomes, resource target, cost ceiling, cleanup targets, and stop conditions must be approved at that time. There is no live-smoke permission in this phase.
