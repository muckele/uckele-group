# Guardian proof failure, 2026-10-16

The owner-approved session
`01effe48b2442a1675ac8a99a713ff0dba663955bca0a04f66b6b30fd395880c`
failed at `demo-execution-proof`. Its public evidence separately verifies
normal Machine shutdown before the cutoff, acknowledged exact baseline
restoration, settled mutations, client reaping and private authentication
cleanup. Those safety facts do not establish successful readiness or deliberate
controller-loss proof. The consumed packet and all original evidence remain
preserved. The owner reported revoking the matching new token at 17:25:36 UTC;
there was no authenticated recheck.

## What is known

The real primary recorded a start attempt at 17:17:40.354 UTC. Independent
metadata first showed started at 17:17:42.549 UTC. There is no retained host
readiness receipt. The parent deliberately terminates the primary only after
receiving and checking that receipt, so deliberate controller loss was never
proved. A generic primary exit or the parent's 15-second readiness timeout
enters the same failed execution-proof stage. The old primary catch and command
adapter discarded the distinguishing stage and command outcome. It is impossible
to recover whether the original cause was command timeout, nonzero start/SSH,
invalid JSON, native readback or another primary failure from these artifacts.

Six observer log polls failed. The catch discarded whether each was a command
failure, framing failure or completion deadline. The observer correctly latched
failure and finished with `normalCompletion=false`. The bounded log command is
allowed 700 ms after the initial 5000 ms attachment read; no retained evidence
establishes which of those budgets, output parsing or external behavior caused
the six failures. They cannot be described as confirmed network timeouts.

All 397 metadata observations were retained. There was one response gap over
the 1000 ms proof limit: 17:19:28.447 to 17:19:29.531 UTC, or 1084 ms. Requests
were 751 ms apart; response latency rose from 92 to 425 ms. Therefore
`751 + 425 - 92 = 1084`, even though both reads completed within 700 ms and the
request gap stayed below 1000 ms. A 750 ms cadence and 700 ms per-read timeout
cannot guarantee one-second response spacing. This is a measurement-margin
limitation; it is not evidence that the guest failed to shut down. It remains
a valid disqualifying gap under the frozen contract.

The one admitted guardian exit record reports normal child exit at
17:21:37.427 UTC. The normal Machine exit event is 17:21:38.465 UTC and the
first subsequent stopped response is 17:21:39.131 UTC, 1704 ms after child exit.
The frozen cutoff was 17:22:36.399 UTC. No requested stop, OOM or restart was
observed. The observer stayed through 17:22:36.958 UTC. Exact sealed baseline
configuration and image were restored at 17:22:39.342 UTC; session/auth/owner
terminal closure completed by 17:22:39.379 UTC. The runtime auth closure explicitly
verifies cleanup and reaping; the wrapper's generic `!success` uncertainty flag
is not a contrary private-directory observation.

## Offline reproduction and minimal change

Pure replay of the original trace through the actual verifier returns failure
without synthesizing missing readiness or kill facts. The retained guest
readiness/guardian sources are byte-identical between guest commit `c4944a46`
and host commit `1c46c5cd`; there is no evidence for a guest source-drift fix.

The change retains only closed diagnostic facts:

- Bounded local commands distinguish timeout, nonzero/signal, output limit and
  private-output rejection, with timeout and reaping facts; output, argv,
  environment, messages and stderr remain excluded. Only internally branded
  errors are admitted; arbitrary error getters are not inspected.
- The primary publishes its bound last stage and safe native/command facts
  before failing. The parent records exit-before-readiness versus its existing
  readiness timeout, without claiming a deliberate kill.
- Observer log errors distinguish command, framing and completion stages while
  keeping their sticky failed verdict.

Regression tests run the actual primary CLI control flow in a VM with explicit
synthetic external modules and run actual owned local Node command failures.
They reproduce the previously indistinguishable failure branches, keep one
start and the original 10000/5000/15000/700 ms budgets, and check safe diagnostic
retention. Existing malformed-log, slow-poll and observation-boundary cases stay
failed. VM boundary simulation is not successful production SSH evidence.

No cadence, timeout, native binary, guest source/image, 1000 ms threshold,
restoration gate or runtime authority is changed. No new owner packet, live
retry, credential or authenticated check is authorized. The original primary
and log-poll subtypes remain unknown. Raising the threshold would not repair
missing readiness/controller-loss or failed log reads; any future measurement
design change needs its own evidence and review. Keep `productionReady=false`
and global automation paused.
