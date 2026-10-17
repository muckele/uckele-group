# Stopped log probe (code-only release)

This dedicated executable accepts only `--serve-stopped-log-probe`, built with
`-tags p10b_stopped_log_probe`. Existing runtime and stopped-update executable
pins remain unchanged. The CLI is `node scripts/run-p10b-stopped-log-probe.js`;
`--help` is inert. A release without a reviewed native checksum fails closed.
No credential or operational approval/profile has been created by this work.

Future activation needs separate human approval for this read-only operation,
reviewed clean host commit and probe artifact, retained public original baseline
(instance/config/image), canonical owner-only (0700) evidence directory, and a fresh
closed probe profile plus its own digest-bound approval. The exact 30-second
window begins before intent/auth/spawn; requests must dispatch and finish before
its 27-second cutoff. Approval preparation cannot renew the execution budget.
An opaque app credential is accepted only after durable nonce consumption. It
is kept in memory in an empty owner-only (0700) private context; no normal account
configuration, keychain, token creation/refresh/discharge or CLI is used.
The pinned transitive goimports initializer can create empty platform cache
directories inside this isolated HOME; no cache files or normal-home state are
used. Positive owned reap precedes removal of this private context. Credential
creation remains a separately approved future setup action.

The owned native process performs exactly:

1. Original stopped baseline GET (1 second).
2. First single-request log GET (5 seconds).
3. Steady single-request log GET (700 milliseconds).
4. Original stopped baseline GET again (1 second).

There are zero Machine starts, configuration updates, provider calls or emails.
Any failure ends all further reads, including the after-baseline read. The
first and steady reads are predeclared samples, never failure retries. Both
baseline samples must independently match the original instance/config/image,
region `ewr`, frozen volume and hard-off flags. Two samples do not prove continuous
stopped state between them. No runtime session/window or permission is created.

All returned application/guardian log text and cursors are discarded, even a
crafted empty-window-digest guardian event. `providerBatchEmpty` describes only
the validated provider data array: an empty array is true; a nonempty array
whose text is all discarded is false. Neither value proves guardian execution,
historical completeness, future latency or readiness for a runtime test.

A durable nonce-keyed exclusive intent binds the directory and probe digest
before authentication/spawn. Existing intent or terminal evidence blocks all
replay, concurrent invocation and changed-digest reuse of that nonce. Evidence
is retained after every failure and never automatically deleted or rearmed.
Only one owned native process is used, with cached bounded positive reap and
private-context cleanup before a positive returned receipt. An uncertain reap
retains the private context and permanently blocks success.

Retained terminal evidence always has `success:false, publicationVerified:false`:
it contains non-authoritative attempt facts because a file cannot attest its
own completed fsync. The returned public receipt alone may report success after
terminal fsync and an original-expiry check. A late or failed fsync cannot leave
a durable positive receipt. Public failures never include remote bodies,
headers, credentials, application text or raw exception messages.

This probe is independent of existing owner inventory/preflight. That inventory
uses broader SDK/CLI paths that can perform configuration/cache/refresh work;
it has not become refresh-free and is not redesigned here. Any future setup
approval must describe those housekeeping effects separately. A probe success
cannot approve or launch a runtime test. `productionReady=false`, qualification
is disallowed and global automation remains paused. No operational package or
credential is generated until separately approved.
