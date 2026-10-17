# P10B single-request log reader

Mathew approved this code-only replacement after the pinned CLI source showed
that `logs --no-tail` repeats empty reads and retries errors. The approval covers
implementation and independent offline tests. It includes no credential,
provider/Machine request, deployment, email, spending or new operational packet.
The isolated Machine/volume stay stopped; productionReady and qualificationAllowed
remain false, and global automation stays paused.

## Contract

The checksum-bound default native executable adds a distinct `--serve-logs`
mode, running as a separate observer-owned process from Machine metadata. Pure
session/config validation runs before its authentication constructor. The
constructor reads only opaque inherited scoped input and uses the pinned official
SDK's `Transport` and log-specific `BubblegumHeader` selection internally.
No header or normalized credential crosses IPC. Normal CLI config, retrying
SDK helpers, refresh/discharge, metrics and agent startup are absent from this path.

The only target is
`GET https://api.fly.io/api/v1/apps/uckele-group-p10b/logs?instance=0803730bd1d7e8&next_token=`.
One admitted operation issues one HTTP request. The transport disables proxy,
redirect following, compression, keepalive and HTTP/2. There is no retry, cursor
follow, streaming fallback or caller-supplied endpoint. A valid status-200 JSON
envelope with an explicit data array, including empty, completes. Missing/null
data, malformed/trailing/duplicate JSON, unexpected encodings and response bounds
fail closed. Headers are capped at 16 KiB, body and IPC at 128 KiB, provider rows
at 2048 and admitted guardian rows at 128 per response.

Only the existing closed public guardian exit event bound to exact window,
Machine and region survives native projection. Event formatting is regenerated;
original provider timestamp bytes alone preserve nanosecond precision. Raw app
text, provider error bodies, response headers and cursors never cross IPC. JS
validates closed ready/response/observation/record schemas again and rejects
duplicate or unsolicited complete/partial frames and credential echoes.

Log initialization uses a distinct readonly init; GET request frames contain only
id, method and timeoutMs. IDs increase and at most 410 requests are admitted.
The first bound is 5000 ms; later bounds are 700 ms including bridge IPC and
validation, without the metadata bridge's extra 250 ms. Every deadline also
respects the original session and stopAt+750 wall/monotonic cutoff. Late callbacks
cannot renew a deadline. Native status errors, transport errors and timeouts carry
only closed status/elapsed/dispatch facts. If the parent total deadline wins,
bridge-timeout correctly retains unknown dispatch/status. Any failure is terminal.

The observer samples metadata independently during log initialization/requests.
Cleanup ownership starts with the first native child. Failure or cancellation of
the second reader still reaps the first. Metadata, log and ordinary process reaps
start together within the existing shared 3000 ms cleanup interval; nativeReaped
means both readers positively reaped. One uncertain/throwing/hanging reap prevents
positive proof and retains durable private authentication holds. Cleanup is cached;
late closure cannot upgrade an uncertain receipt. All existing cadence, immutable
permission, guardian and whole-Machine proof requirements remain in force.

## Evidence and limits

Offline native tests use the actual restricted HTTP transport against local TLS,
the official SDK with synthetic input, fixed production request construction and
test-only loopback routing. JS tests exercise real native stdio, empty/application/
guardian responses, status errors, redirect denial, connection loss, response
bounds, malformed envelopes, slow headers/body and independent metadata while
logs are slow. Observer fixtures cover replay, late work, partial initialization,
deadline/cancellation and aggregate cleanup. The exact-head CI job builds the
native test executable and requires the composition suite; ordinary missing-fixture
skips do not count as executed integration evidence.

This change removes the confirmed CLI abstraction mismatch. It cannot recover
the historical discarded causes or guarantee endpoint permissions, latency,
retention/completeness, guest readiness or future live success. It returns one
batch, with no claim to complete retained history. The consumed live attempt
remains failed. Separate explicit approval and fresh exact prerequisites would
be needed for any future live operation; this code creates no new operational
owner package and grants no email authority.

## Official source basis

- [Pinned SDK GetAppLogs and log header selection](https://github.com/superfly/fly-go/blob/v0.11.3/resource_logs.go)
- [Pinned SDK direct Transport](https://github.com/superfly/fly-go/blob/v0.11.3/client.go)
- [Pinned SDK token header normalization](https://github.com/superfly/fly-go/blob/v0.11.3/tokens/tokens.go)
- [Pinned SDK retrying HTTP helper, deliberately bypassed](https://github.com/superfly/fly-go/blob/v0.11.3/http.go)

Historical evidence and former native artifacts remain preserved. New native
pins are bound separately after independent source review and an offline build
from frozen clean source; no old session or artifact is silently reused.
