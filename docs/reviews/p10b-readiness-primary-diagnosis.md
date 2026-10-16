# Readiness and primary termination: offline diagnosis

The preserved owner run at host commit `1c46c5cd` remains failed. Its
actual-start artifact at17:17:40.354UTC follows successful native baseline
readback, exact instance/config checks and native reap in that source. Native
baseline failure therefore does not explain the later missing host readiness.
The observer independently sees started at17:17:42.549UTC. Start command
completion, SSH/public guest readiness, JSON parsing, IPC delivery and parent
publication were not separately retained, so their original outcomes remain
unknown. Guest/source/image changes are not justified by this evidence.

## Distinct evidence paths

The parent receives readiness, writes its receipt, checks its binding, terminates
the primary, checks exact SIGKILL/reap, probes the observer, then reads and proves
the observer trace. Observer completion/log/metadata failures cannot directly
reject the earlier readiness race. Missing final demo proof alone does not
mean the primary failed: observer failure after verified termination used to
discard that verified fact too. Missing parent readiness can also reflect
publication failure after successful primary parsing/IPC, rather than primary
failure. No artifact proves that happened in the original run.

Controlled tests run the actual primary CLI source with synthetic native/Fly
modules, then pass its actual emitted readiness into the concrete parent:

| Controlled failure | Evidence retained by the correction | Full proof |
| --- | --- | --- |
| Start/SSH or JSON failure | Existing typed primary failure; parent exit-before-readiness | Failed |
| Asynchronous IPC send failure | Parsed-readiness digest checkpoint and caught IPC-stage failure | Failed |
| Primary checkpoint or parent readiness publication failure | Exact publication stage; no termination claim | Failed |
| Already-reaped primary or wrong/uncertain terminal outcome | Refusal before a verified termination receipt | Failed |
| Observer exit or missing output after verified SIGKILL | Independent termination receipt plus observer-completion failure | Failed |

Local Node characterization confirms that sending on a closed IPC channel
without a callback emits an asynchronous process error outside try/catch.
Supplying a callback reports the failure there. The old optional fire-and-forget
send could therefore bypass the primary's failure artifact. This is a
reproduced failure mechanism, not an attribution of the original live failure.
The test's explicit parent-side disconnect also did not emit ChildProcess.close
in the pinned runtime; that narrow probe checks OS exit and drained stdout
separately. Production process ownership/close behavior is unchanged. A separate
real owned local IPC primary verifies actual SIGKILL, absent process group and
retained termination facts after observer failure.

## Small correction and unchanged limits

The primary retains only session/window/readiness digests and a parsed flag
before IPC. It awaits the existing send callback and catches submission errors;
the callback is not proof that the parent received or accepted readiness. The
parent's independent received-readiness artifact remains necessary.

The parent preserves its bound primary PID, intent time, verified terminal and
reap fact before consulting the observer. It rejects an already-reaped/exited
primary before claiming deliberate termination. Later failure stages are
retained without serializing error messages, output, argv, environment or stderr.
Independent review reproduced OS exit before close/reap while a same-group
descendant retained stderr. Both Node exit-code and signal-code fields now
reject that stale primary and retain its bounded terminal fact. Real local
process regressions cover normal and SIGKILL exits in this interval. A leader's
OS exit still does not prove complete group absence or permit a positive reap
receipt; settlement retains ownership of the group.
Neither new receipt is accepted as standalone guardian proof. Evidence
publication failure remains fail-closed; unavailable storage cannot be repaired
or retrospectively reconstructed by another receipt.

There is still one start, the same10000ms start/5000ms SSH/15000ms parent readiness
budgets, the same native and process reap guards, independent observer and
strict inclusive1000ms measurement limit. No guest, native artifact, image,
operation permission, restoration or qualification gate changes.

## Timing recommendation

Keep serial200ms/native500ms as an inactive test-only prototype. It improves
synthetic continuity for25 historical latency retimings and all346 constant
80–425ms cases, but loses availability for501–700ms native requests and uses
about2.33 times the metadata reads. Future latency and rate-limit effects are
unknown. It does not fix the independent primary start/SSH/IPC/publication
paths or recover missing live provenance. Adopting its tighter timeout or extra
load is not justified merely to make the failed sequence pass. Any different
timing or process-finalization architecture remains a separate proposal.

No new owner packet, credential, live attempt, Fly/provider call, build, email,
production change, merge or spending is part of this diagnosis. Keep
`productionReady=false` and global automation paused.
