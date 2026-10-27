# One hosted UG image qualification

Third execution candidate, **not approved and not dispatched**.
The original one-run grant was consumed by run40567282005 attempt1, which stopped
before the application build at the cgroup membership detector. Its cleanup and
failure receipts remain unchanged. No application/image qualification passed.
The second run40568987891 completed build/export, failed provenance qualification,
and reported unverified cleanup after a volume-delete timeout. Its exact archive
was not uploaded or retained as a GitHub artifact; neither its full structure nor
verified owned temporary-file cleanup can be reconstructed from the returned logs.
Reuse the reviewed October21 source/OCI/provenance verifier. Application source
remains `f22738d22ee33ed3f30df448fdcbebbad396d91a`, tree
`8d436f7a7db338157d791bc64396bbfdb4cd4747`; no product/configuration change.

Install exactly the sealed helper files at `release-tools/ug-image/` and the
selected workflow at `.github/workflows/ug-image-once.yml` on an operator commit
based on accepted source. Push only branch `codex/ug-image-oci-binding-20261027` and,
only after fresh approval, create tag `ug-ui-image-f22738d-20261027-attempt3` at that exact
reviewed operator commit. The branch alone is not a trigger; existing CI only
triggers main pushes/PRs. No PR/main merge/default-branch installation.
First read the tag, run list and source/seal bindings; any prior/uncertain trigger
stops. Only a creation event and `run_attempt==1` admit. No tag force/replacement,
rerun, automatic retry or fallback backend. This is not a server-enforced forever
single-use lock; the operator must preserve the consumed-grant record.

## Exact operation and bounds

One **standard public-repository Ubuntu24.04 x64 VM**, not a paid/larger runner.
Public visibility/repository1196769573 and source/tree/recipe/lock are checked
again. No package/dependency/tool installation on the host; use existing Docker,
Skopeo, Python, sudo and pinned checkout action. Normal Dockerfile apt/npm
downloads inside the build are necessary public dependencies. Build children
receive a clean task-owned HOME/Docker config and no token/provider environment.

The first step establishes one monotonic **20-minute total deadline**, including
checkout, setup, build, validation, optional publication, receipts and cleanup.
Build/OCI export ends within minute15. Work stops by minute19, reserving the last
minute for independent owned cleanup. No helper gets a deadline beyond the shared
window. Existing guard output caps remain512KiB log/metadata/receipt and512MiB OCI
archive; Git archive/extraction remains20MiB/1000files. No hosted artifact/cache
upload. The job summary is bounded64KiB and contains no credential/data contents.

Require **29GiB actual free**, preserve **20GiB free**, stop at sampled **8GiB
growth**; Docker state and runner output must be on the same proven filesystem.
Require fresh `MemAvailable>=5GiB`. Do not remove preinstalled files, lower floors
or assume the runner's advertised14GB SSD proves availability. Stop before builder
creation on failed admission. These are sampled growth/floor guards, not a hard
storage quota or reservation. The existing helper does not install a cgroup.

Create one task-named standard Docker-container BuildKit builder, version tag
`moby/buildkit:v0.31.1`, record actual resolved image ID. It is a **privileged
container inside the disposable GitHub VM**, with2CPU,4GiB RAM,4GiB total RAM+swap,
restart=no. Actual inspect and private cgroup namespace/root kernel values must
agree (`memory.max=4294967296`, `memory.swap.max=0`, `cpu.max=200000 100000`).
The cgroup mount root must remain `/`. Process membership may be exactly `0::/`
or `0::/init`: BuildKit v0.31.1's default startup moves processes into its `init`
child to enable nested controllers. Limits are still read from the private
enclosing namespace root, never from that child or a guessed host limit. All
other paths, missing/extra metadata and changed/unlimited counters fail closed.
The upstream [resource monitor](https://raw.githubusercontent.com/moby/buildkit/v0.31.1/executor/resources/monitor.go)
and [image default](https://raw.githubusercontent.com/moby/buildkit/v0.31.1/Dockerfile)
explain this layout; the original run's exact five-field payload is a regression fixture.
All worker cgroups are beneath that private enclosing namespace; a host/unknown
namespace or missing control is a stop. No per-RUN cap is substituted. Ordinary
source/build inputs cannot request extra entitlements; the accepted Dockerfile is
unchanged. Builder state remains in its task-owned VM Docker volume.

A separate ancestor owner/watchdog runs before mutations. It samples disk/deadline
while fixed-operation children run, adopts escaped CLI helpers using process-local
subreaper semantics, uses pidfds for adopted-helper termination, and requires ECHILD
plus a fresh descendant snapshot. No global process, kernel, Docker or security
settings change. Docker cleanup revalidates exact ID plus the random owner nonce;
it never broad-signals/deletes by name alone. Ambiguous orphan volumes are retained
and fail the receipt. Existing local Mac apps/originals/SanDisk files are untouched.
If the one owned volume delete times out, do not repeat it: one fresh exact-name
absence read may reconcile that outcome, followed by the existing final volume
absence read. Present/unreadable state still fails closed and preserves temporary
files. Builder-container absence is recorded separately. No deadline is increased.
The smoke start is persisted before container creation; the independent ancestor
stops a stalled workload by90seconds and reserves30seconds for verified smoke
removal. Only the ancestor retires that lease after its own fresh absence check.
If Docker/ownership cannot be verified within120seconds, report failed/uncertain
cleanup; never claim the bound passed merely because the child returned.

## Image identity and entrypoint qualification

Validate source graph/bytes/modes and OCI blob/descriptor/provenance/source/base
bindings. Existing Skopeo imports the runnable linux/amd64 leaf into the ephemeral
Docker store. Require the imported **config digest and every uncompressed rootfs
diffID** to match the verified OCI. Keep original OCI/index/attestation bytes for
any optional GHCR copy; import conversion is not a rebuild. Resolved base material
is recorded; floating Node base does not imply bit-reproducibility.

The OCI export has a task-local image name (no registry push), explicitly uses
`mode=max,version=v0.2`, and fixes `BUILDX_METADATA_PROVENANCE=max` in the clean
child environment. This supplies image-bound subjects and matches the verifier's
existing full v0.2 schema; reduced/unequal provenance remains rejected. BuildKit's
[writer and index path](https://raw.githubusercontent.com/moby/buildkit/v0.31.1/exporter/containerimage/writer.go)
omit a top-level config-digest annotation for an attested index, and its
[subject construction](https://raw.githubusercontent.com/moby/buildkit/v0.31.1/exporter/attestation/make.go)
needs an image name. Require exactly one export root; its digest, size and media
type must match exporter metadata. Verified blob hashes bind that index to its
sole linux/amd64 manifest and config. A supplied config-digest metadata key must
still match; an absent key is supported only for that verified OCI index chain.
The config digest is never guessed from the index digest. Full provenance,
source files/modes, build arguments, base materials and import identity remain
checked. Buildx's [metadata provenance conversion](https://raw.githubusercontent.com/docker/buildx/v0.38.0/build/provenance.go)
and [default reduced mode](https://raw.githubusercontent.com/docker/buildx/v0.38.0/util/confutil/metadata.go)
are explicit compatibility inputs, not substitutes for attestation verification.
Failure receipts add only bounded digest/type/count structure and completed
admission evidence (each<=16KiB), inside existing output/receipt/storage caps;
they expose no provenance contents, subject names, credentials or application data.

Use the image's unchanged CMD `node server/index.js` and inherited Node
`docker-entrypoint.sh`. Verify actual image and container env/command/mounts first.
One fresh **network-none**, read-only-root, capability-dropped,
no-new-privileges fixture, no real mounts/socket/devices/ports/host namespaces.
**120seconds includes startup, native/assets probes, graceful exit and verified
container removal**. Limits:512MiB RAM and total RAM+swap,2CPU,128PIDs;
`/tmp`240MiB,tmpfs `/dev/shm`1MiB,log<=1MiB,receipt<=1MiB,ancillary<=13MiB,
aggregate<=256MiB. Logs rotate at the stricter512KiB setting. Fixed Node sampling
counts tmp/shm/dev logical and allocated usage and checks writable destinations.
The sealed read-only metadata helper uses existing `sudo -n /usr/bin/python3`
solely to count this nonce-bound container's root-owned Docker metadata/log files;
it prints sizes only, changes no permission/setting, and never reads other
containers. Missing access or accounting fails. No root operator or privileged
smoke container is used.

All database/vault/backup/marker paths lie on the new tmpfs. Explicit synthetic
secrets and `example.test` values only. Existing outbound jobs/AI/provider flags
are disabled. Three unavoidable maintenance registrations and startup auth/document
cleanup remain intact on empty fixture data. **Not all schedulers are disabled.**
No periodic15minute/1hour/6hour callback or real-provider behavior is qualified.
Do not force/accelerate callbacks or add product switches. Readiness/listener checks
do not claim absence of measured network attempts.

Exactly four loopback GETs: `/api/ready`, `/`, the HTML's packaged JS and CSS.
Record actual Node/ABI/OS/architecture, better-sqlite3 version/native binary SHA,
SQLite version/query, empty maintenance queues, asset SHA/size, fixture/scratch
effects and graceful SIGTERM/exit0. No app/database executes during offline tests.

## Retention, permissions and explicit fallback

The retention variant requests exactly **`contents:read`, `packages:write`** from
the job-scoped `GITHUB_TOKEN`, only exposed to the fixed owner/publisher step.
No PAT, saved secret, production credential, OIDC/cloud role, visibility/ACL or
repository settings change. Checkout does not persist credentials. Source build
and app workers never inherit the token; registry login receives it through stdin
into a disposable owned auth file after the fixture has exited/been removed.

Candidate destination is the **verified private** repository-associated
package `ghcr.io/muckele/ug-ui-verification`, unique tag `f22738d-run-<runID>`.
Before copying, bounded fresh API reads must prove private visibility, owner and
UG repository association, accessible version list and unused tag. Check privacy
again immediately before/after upload and compare exact registry root digest.
Never use application bytes to discover package privacy, change visibility, push
to an existing public/unassociated package, overwrite a tag or substitute a registry.
Concurrent owner visibility changes are not atomically locked by these API reads.

If the package is absent (API404), create only a fixed **inert OCI bootstrap**:
empty rootfs/layers, no application source, no environment/credential/data content,
logical payload<=8KiB plus counted filesystem metadata. It uses no Docker build
or runtime and the same approved temporary token, deadline and resource envelope.
Its unique `privacy-bootstrap-<runID>-<nonce>` tag and exact manifest digest are
recorded before copying. A task nonce in the inert config makes the version
digest unique too; cleanup requires its tag set to contain only that owned tag.
Official documented default privacy is not treated as
proof: actual subsequent metadata must establish private visibility, owner and
UG repository association **before the candidate copy starts**. A403, unexpected
visibility/association or unavailable proof stops, leaving at most the inert
object and bounded evidence. Never change ACL/visibility or obtain a new credential.
After candidate digest/privacy verification, delete only the exact bootstrap
version matched by unique tag and manifest digest; verify its absence. Workflow
publication grants package-admin association under GitHub's documented model;
unavailable delete authority or an uncertain response is reported, not expanded or
retried. Retained image identity is preserved separately if only this cleanup fails.

If private package/access cannot be established, no candidate is uploaded.
Preserve the completed build/test evidence, report retention blocked and
mark the overall requested retained-image result incomplete. The separate
build/test-only workflow variant requests only `contents:read` and performs no
package API/login/upload. It must not be silently substituted for an approval
requiring retention. Its ephemeral image disappears with verified task cleanup/VM
teardown. This is an offered narrower result, not a new execution grant.

GHCR currently charges$0 for container storage/bandwidth, and standard Actions
compute is free for the freshly verified public repo. Avoid paid Actions artifacts,
caches and larger runners entirely. Private GHCR retention persists for release
decision; do not claim automatic expiration or a lifetime price guarantee. Recheck
current policy before the sole run. External private pull/transfer to Fly is a
later unresolved gate: current local token lacks `read:packages`; no new credential
is created here and no deployment/pull access is inferred from publication.

Current private-package existence/access and actual runner disk/cgroup/import/
native/entrypoint behavior remain runtime unknowns, not offline test passes.
Any guard, source/schema/digest drift, permission/cost requirement or uncertain
publication/cleanup stops. No extra live recovery rehearsal is required.

Sources: [standard runner pricing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[GHCR pricing](https://docs.github.com/en/billing/concepts/product-billing/github-packages),
[GHCR privacy/authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Docker builder limits](https://docs.docker.com/build/builders/drivers/docker-container/),
[existing runner tools](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).
