# Pinned log acquisition investigation and decision

Baseline: `4800fe50ea1d9dbfc3fe3fd96b8a91f3689bd464`. This bounded offline
investigation preserves the failed October 17 attempt and all monitoring gates.
No live diagnostic is needed to establish the interface mismatch below. No
credential/provider/Machine action, operational package, spending or deployment
was performed. The isolated target remains untouched; productionReady=false,
qualificationAllowed=false and global automation paused remain required.

## Confirmed command semantics

Fly CLI **0.4.87** selects polling alone for `logs --no-tail`, so its NATS stream,
WireGuard setup and two-second NATS overlap are excluded. `--instance` is a
supported alias for machine selection; explicit selection does not list Machines.
[Official command](https://github.com/superfly/flyctl/blob/v0.4.87/internal/command/logs/logs.go#L39-L191).

The polling implementation checks the no-tail return only after a **nonempty**
batch. Empty successes wait 128 ms and retry indefinitely until data or
cancellation; several errors retry with backoff, terminating on the tenth
consecutive error. Cancellation, deadline, authentication and not-found errors
terminate immediately. A nonempty result returns after forwarding its first
batch, without following the returned cursor. Therefore one CLI invocation is
not one finite HTTP snapshot, and an empty HTTP buffer does not yield a normal
empty-command completion. The previous owner-setup description was incorrect.
[Official Poll/backoff](https://github.com/superfly/flyctl/blob/v0.4.87/logs/polling.go#L37-L103).

The CLI pins fly-go **0.9.5**, distinct from the project's native helper SDK.
Its direct log method requests `/api/v1/apps/{app}/logs` with instance/cursor
filters, while the shared HTTP transport can retry temporary errors and 502/503
responses. The CLI adds another retry/empty-read loop. The existing 410-command
quota therefore does not imply 410 HTTP attempts. No claim of complete retained
history or cursor semantics follows from a normally returned first batch.
[Dependency](https://github.com/superfly/flyctl/blob/v0.4.87/go.mod#L78),
[log method](https://github.com/superfly/fly-go/blob/v0.9.5/resource_logs.go#L19-L59),
[HTTP retries](https://github.com/superfly/fly-go/blob/v0.9.5/http.go#L15-L118).

## Lifecycle costs and side effects

A command's allowance covers local initialization, config/cache/lock work,
authentication housekeeping, HTTP attempts, rendering, exit and positive owned
group retirement. Full public stdout can precede process exit; it is not proof
of a completed command. Root's owned reservation uses fsync before spawn and
retirement; these costs were included in public poll elapsed times but formerly
excluded from the timer's prelaunch portion.
[Node close semantics](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html#event-close).

Official preparers inspect private configuration and run session token
monitoring even with an environment token. Environment-origin tokens skip some
file-token organization discovery, but discharge refresh can still occur.
Local log creation/retention can create/delete files in the chosen config
directory. Dirty cache can be saved. Enabled metrics can query/mint a metrics
identity and persist state; the consumed run's private settings were not read,
so these conditional paths are not established historical causes.
[Preparation](https://github.com/superfly/flyctl/blob/v0.4.87/internal/command/command.go#L59-L169),
[token monitoring](https://github.com/superfly/flyctl/blob/v0.4.87/internal/config/tokens.go#L35-L350),
[discharges](https://github.com/superfly/fly-go/blob/v0.9.5/tokens/tokens.go#L307-L364),
[log retention](https://github.com/superfly/flyctl/blob/v0.4.87/internal/logger/logfile/fs.go#L14-L99),
[metrics identity](https://github.com/superfly/flyctl/blob/v0.4.87/internal/metrics/token.go#L15-L81).

No unconditional 500/700 ms startup delay was found. The old-agent one-second
sleep requires an existing agent.pid; its historical presence is unknown.
Explicit update suppression and nonterminal execution exclude normal update
checks; incidents also skip nonterminal output unless forced. Background-task
shutdown allows up to five seconds; it does not always sleep five seconds.
[Conditional old-agent handling](https://github.com/superfly/flyctl/blob/v0.4.87/internal/command/command.go#L436-L482),
[updates](https://github.com/superfly/flyctl/blob/v0.4.87/internal/update/update.go#L34-L48),
[incidents](https://github.com/superfly/flyctl/blob/v0.4.87/internal/incidents/incidents.go#L10-L19),
[CLI finalization](https://github.com/superfly/flyctl/blob/v0.4.87/internal/cli/cli.go#L89-L119).

Twelve actual pinned-binary `logs --help` runs under denied network/private-home
reads used empty isolated HOME/config and no authentication environment. Median
was 93.15 ms, maximum 265.35 ms; even help created private local log/cache
folders. This measures executable/help overhead only: help bypasses authenticated
preparers, HTTP and the log command RunE finalizer; common CLI shutdown/logging
and main Sentry finalization still run. It cannot estimate authenticated costs or
identify any historical timeout. Executable SHA256 remained
`c141d8928f71143667049aac4b922d188a94cb1bccb2121a12c6b8d8b1f9bde0`.

## Historical facts and competing explanations

The preserved JSONL hash is
`a7721152599ef3b860e1c4ece8a185bb95318851b9604f28b450f89105dae46d`.
It records 395 commands and 38 typed 700 ms command timeouts: 34 with SIGKILL and
verified reap, four with unknown terminal facts and initially unverified reap.
Successful poll durations were 373–709 ms, median 624 ms; all-poll median was
630 ms. Ten successful poll publications exceeded 700 ms. Public elapsed included work
outside the old post-launch watchdog, so those observations alone cannot
distinguish excluded overhead from overdue timer delivery.

Starts were serial (minimum completion-to-next-start idle 2 ms), with median
750 ms start cadence. No progressive duration growth appears in coarse
50-command batches. A 700 ms process allowance versus 750 ms cadence leaves
little margin; it is not a 700 ms network-latency measurement. Empty-wait loops,
SDK/CLI retries, HTTP latency, local preparation/finalization and host scheduling
can each cause the same public timeout. No retained phase/output facts separate
them. They remain mechanisms and contributors, not assigned historical causes.

Metadata ended at 18:20:53.894 UTC, primary failed at 18:20:57.692. Of the later
384 polls, 36 timed out over the following 288.5 seconds. Initial metadata/SSH
concurrency cannot explain the persistent failures. Settlement continued with
263 native GET attempts, but their per-request timestamps were not preserved;
settlement/API or general host contention is not ruled out. The metadata
failure's original category remains **unknown**; this review does not infer it
from the separate CLI behavior or timeout pattern.

## Offline reproductions and narrow correction

A standalone standard-library Go harness executes byte-identical upstream
`Poll`/`backoff` bodies with synthetic client/data/error types and a context-aware
pause adapter. All network/private-home reads were denied; no actual Fly/native
project was built. Five cases passed:

| Synthetic response | Observed behavior |
| --- | --- |
| Always empty | Six immediate fake GETs at 0/130/259/388/518/648 ms, cancellation at 702 ms |
| Generic errors | Three attempts at 0/129/386 ms, cancellation at 701 ms |
| Nonempty plus cursor | One attempt, immediate return, cursor not followed |
| Empty then entry | Two attempts separated by 128 ms |
| Unauthorized sentinel | One attempt, immediate error |

This establishes upstream control flow, not real HTTP, SDK retries, credential
refresh, backend retention, response classifiers or provider performance.
Separate real-OS synthetic commands reproduced combined startup/request costs,
complete output followed by a lingering process, and positive group cleanup.
They showed 250 ms startup plus 400 ms work finishing around 696 ms, while
400+400 ms exceeded the watchdog. Complete output at 146 ms followed by a live
leader still timed out around 720 ms, as required.

Those probes also reproduced a routine **deadline strictness defect**: a
synthetic synchronous spawn wrapper blocked 720 ms while its child completed;
the old 700 ms command returned success around 731 ms because its timer began
after launch. A queued successful close could similarly beat an overdue timer.
Regression tests failed for both cases before the correction. Command deadlines
now anchor before owned launch and check actual monotonic completion, including
reservation/retirement. Timer rounding avoids premature submillisecond firing;
late completion still fails independently of timer delivery. No limit increased,
no failed observation is accepted, and no retry was added. This can reject more
late work; it does not make the upstream acquisition faster or resolve the 38
historical failures. Reap uncertainty stays conservative even if later cleanup
positively verifies group absence.

## Material decision still required

The current CLI log boundary cannot promise a completed empty read or exactly
one request. Do not accept killed empty-stdout commands, widen deadlines, drop
failures or claim that synthetic empty-command fixtures establish CLI conformance.
Those fixtures test the abstract observer boundary only.

| Option | Consequence |
| --- | --- |
| Keep CLI no-tail for a separately approved diagnostic | Retain all failure gates and acknowledge empty waiting/hidden retries/startup overhead; availability remains unproved. This is not a reliability fix or a recommendation to rerun. |
| **Recommended: approve a code-only single-request log adapter** | Fixed app/Machine filter, one GET per poll with retries disabled, explicit successful-empty response, bounded body/public guardian filtering, same 700 ms elapsed limit/750 ms cadence/410 cap, sticky failure, monotonic lifetime and owned cleanup. Requires reviewed auth/protocol/endpoint and source/artifact bindings before any live authority. |
| Persistent stream | Requires a separately reviewed attachment/lifetime/cursor/completeness/reconnect model and any new transport/auth side effects. The existing CLI streaming branch adds NATS/fallback behavior, not an automatic solution. |

The recommended adapter changes the current native/CLI transport and
credential-handling surface, including a new fixed endpoint/protocol operation
and artifact binding. That is the smallest material design decision; it was not
implemented under routine branch-fix authority. Approval would be **code and
offline tests only**, with no credential generation/use, live endpoint, Machine
start/update, new spending or owner package. Existing observation and shutdown
requirements remain mandatory.

No stopped live diagnostic is necessary to establish this design mismatch or
choose the offline correction. A new run cannot recover the discarded historical
metadata/log phase facts. Therefore no live approval is requested now. If a
later current-availability measurement is proposed, it must specify fixed-target
request/attempt/time quotas, fresh scoped opaque access, exact source/artifact
bindings, closed public timing/status/empty-count evidence, private cleanup and
all SDK discharge/config/log/cache/metrics side effects; full CLI invocation
cannot be represented as a single side-effect-free GET. A stopped target cannot
establish future startup/SSH or uninterrupted live guardian observation.
