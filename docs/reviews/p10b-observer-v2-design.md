# Bounded observer scheduling and finalization v2

Scope: the owner's explicit code-only observer scheduling/finalization redesign
approval. No live authority, private bindings, credentials, provider calls,
spending, build/image action, merge or deployment. Keep productionReady=false
and global automation paused. The500ms prototype remains excluded.

## Required invariants

Retain the inclusive1000ms request and response gap limit,700ms native request
timeout, existing250ms bridge watchdog allowance, exact Machine/image/config,
independent OS observer, no restart, normal guardian/Machine exit provenance,
fixed guest cutoff and30second stop-convergence gate. Read/clock/budget/log or
reap uncertainty never permits qualification, retries, permission renewal or
host stop. All metadata, including disqualifying rows, remains retained.

## Sampling

Use one existing read-only native transport and one in-flight metadata request.
After each settled response, schedule the next start no earlier than both the
previous start+100ms and response+25ms. The limit is10 metadata starts/second,
with at most3011 attempted reads in a five-minute window plus a bounded1000ms
final-dispatch tail. Actual starts, gaps, call duration and budget are checked;
late wakeups or jumps are failures, not retimestamped observations. A read error
is sticky and does not open another native connection.

The first request at/after stopAt is the final sample. It must start no later
than stopAt+1000ms and early enough to respect session expiry. This replaces
the750ms periodic timer's incidental tail with an explicit final-sample bound
derived from the unchanged evidence limit. It does not extend guest authority,
the fixed stopAt, or the30second parent observation/settlement deadline.
There is no concurrent sentinel reader or additional credential/client.

Do not claim universal successful sampling: a zero-latency reply followed by a
950ms call after the100ms rate floor creates a1050ms reply gap and must fail.
The read cap/rate bounds favor bounded load over hiding that uncertainty.
The historical1084ms trace remains rejected; faster polling alone is not proof.
Typical historical model load is roughly2055–2065 metadata reads, within this
cap; rate-limit acceptability and actual cost remain future live prerequisites.

Log polling retains its existing750ms cadence, first5000ms/steady700ms command
budgets,410-read and128-record caps, framing and sticky failure guards. Metadata
and logs collect concurrently; no busy-loop or unbounded replacement stream.
Abort/drain sampling before cleanup on attachment/publication failure.

## Versioned finalization and admission

Emit a closed v2 policy record bound to window and session expiry. After both
metadata and log collection settle, publish a closed sampling-finished receipt
with actual timestamp, final request/response, exact counts and policy binding.
It must cover through stopAt, remain within1000ms of the final request, and
retain every existing request/response gap and error check.

Then perform local process reap followed by native reap exactly once, bounded
by3000ms, session expiry and stopAt+30000ms. Publish a separate closed
observer-finished receipt only with actual cleanup result/timestamp, sampling
digest and explicit positive process/native reap facts. No receipt may claim
success after its deadline or reuse an acknowledgment as cleanup proof.

Qualification requires both receipts and their bindings. Cleanup no longer
consumes the sampling timestamp's1000ms precision budget, but remains a
separate mandatory bounded gate. This is the explicitly approved finalization
redesign, not backdating completion. The outer launcher still verifies private
authentication cleanup before success. One shared reap promise prevents finally
blocks from repeating cleanup after failure or denial.

Require v2 evidence in concrete host demonstration and preparation admission.
Keep the legacy verifier path unchanged for preserved historical evidence;
legacy evidence cannot satisfy the new concrete runtime's v2 requirement.

## Validation and shipping gate

First demonstrate failing regressions for scheduling, exact1000/1001 boundaries,
rate/read caps, final-read placement, cleanup52ms/uncertainty/timeout, receipt
tampering/missing/late facts and legacy-v2 confusion. Then composed tests execute
actual primary source, concrete parent and observer with stubbed native/Fly
boundaries and owned local processes. Preserve historical counterexamples and
failure ordering; do not promote synthetic success to live readiness.

Independent exact-patch review, full clean-head offline suite/lint and exact-head
CI precede completion/publication claims. No live retry follows automatically.
