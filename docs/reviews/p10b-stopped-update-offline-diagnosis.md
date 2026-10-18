# Consumed stopped-update attempt: offline diagnosis

The 2026-10-15 owner attempt stopped at `demo-stopped-update`. It did not establish runtime or mailbox qualification. Its original source (`88159cfecde3c44933ed277485977c0140db541b`), released package and receipts remain immutable. Matching token retirement was owner-reported at 19:39:32 UTC; this work performs no auth readback or live operation.

## Proven defects and correction

`guardedUpdate` omitted the POST deadline, inheriting the adapter's 1000 ms metadata default. It now supplies 10000 ms, within the existing native limit. An actual official-SDK regression with the complete public failed config and frozen current version reproduces failure at 1000 ms and success at 10000 ms with a 1100 ms synthetic response delay. Mutation still has one attempt; the existing session cutoff, exact config/version, stopped-state readback and replay guard remain in force.

The operator catch discarded all six validated native failure categories. It now preserves only a typed, closed diagnostic: schema version, enumerated code, GET/POST method and bounded timeout. Native messages, stacks, response bodies, headers and stderr are excluded. Local protocol, bridge timeout and bridge termination failures have separate closed categories. Invalid local timeout values reject before dispatch or consuming a POST allowance. HTTP failures remain status-agnostic under the retained protocol.

This is a host-only correction. Native production source, protocol, retained binary pin, candidate image and guest implementation do not change. HTTP status support would require a separate atomic native rebuild, review, pin and protocol change; it is deferred.

## Integration evidence and limits

The thin offline test runs actual stopped-update control → JavaScript adapter → compiled native test service → official SDK → test-only fake HTTP. It uses synthetic authentication and the complete retained public configuration, with only guest-window timestamps retimed, plus the retained current version. The test helper is compiled from `_test.go` and cannot be linked into the production helper. It never loads owner SDK authentication. CI compiles and explicitly runs this test separately from normal native tests.

Cases cover delayed success beyond one second reaching exact stopped config readback; definite HTTP rejection; and uncertain request timeout. Each consumes one mutation intent, rejects replay, creates no start intent, verifies native process reap and cleans the synthetic auth context only after reap. Full operator regressions separately prove each native category survives into terminal failed-update evidence without raw exception text. Existing full-flow, cleanup ordering, one-shot stop and shutdown tests remain required.

The historical 1.316-second update-intent-to-closure interval is consistent with a one-second timeout plus overhead. The historical cause cannot be recovered because the diagnostic was discarded. A timed-out mutation may have been accepted remotely; the recorded baseline readback is a point-in-time observation. This change neither retries nor renews the consumed attempt.

## Independent assessment of the testing approach

Fresh review found that the prior owner-runner and operator success fixtures fabricated downstream results, the stopped-update fake responded immediately, and the SDK test used an empty config. Those component tests did not establish compatibility across the composed request path. The added vertical slice closes that specific offline gap without introducing a cloud simulator or another production architecture.

Keep isolation, explicit authority, credential protection, exact targets/configuration, bounded runtime/spend, no duplicate mutations, preserved evidence and positive cleanup/stop. Extra packets and attestations do not substitute for testing real library boundaries. Do not call another owner run ready based on aggregate test counts or this timeout correction alone.

The next decision is whether a separately authorized no-email runtime demonstration is proportionate after reviewing this patch and its evidence. No new credential, package, owner Terminal step or live attempt is requested here. Real API acceptance/latency, platform logs and guardian observation, guest exit-to-stopped convergence and no-email preparation remain empirical. A no-email demonstration is a prerequisite; later delivery, reply and reconciliation for one message require separate approval. No automatic progression follows from offline success.

Production readiness remains false and global automation paused. No merge, deployment, Machine operation, provider call or email is authorized by this diagnosis.
