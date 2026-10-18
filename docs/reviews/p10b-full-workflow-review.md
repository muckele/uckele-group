# October 17 failed demonstration: full offline workflow review

The consumed guardian-only attempt remains failed. This review completes the
relevant owner/admission, runtime/observer and settlement/shutdown source review
at baseline `e104102152d3656bd5df5b7a455f350fb98f037b`, followed by corrections
and independent patch review. It grants no live authority. Production remains
unready, qualification remains disallowed and global automation remains paused.

## Current offline handoff — October 18, 2026

UG engineering has resumed at the original Mac paths; no repository/worktree
migration occurred. PR76 remains an open draft. The runtime/probe implementation
head is `3ccfcec562e1278811c35741b83a67b7ea181cb8`. Fresh GitHub queries
reconfirmed [CI39071965198](https://github.com/muckele/uckele-group/actions/runs/39071965198)
as successful, including both literal-source-commit assertions. This is a
reconfirmation of that recorded run, not a newly executed live test.

The later reviewed [stopped-log probe](../p10b-stopped-log-probe.md) implements
the read-only transport path proposed by the historical review below. It has
its own approval and native executable, exactly two baseline GETs and two log
GETs, zero starts/updates, and an original 30-second aggregate bound. All log
text is discarded. Its implementation and artifact reviews are complete; it
has not been run against Fly. The historical failed attempt remains failed.

On October 18, a bounded fresh offline regression at that implementation head
passed **224 tests, zero failures/skips**, using the preserved reviewed native
artifacts, synthetic inputs, owned localhost boundaries and an isolated
environment without inherited credentials. Coverage includes probe authority,
replay/deadline/cleanup, concrete qualification runtime, inbound restrictions,
observer failures and guest shutdown. The original native artifact hashes were
rechecked; no native rebuild or new operational package was needed. The
internal disk was above the existing 11 GiB floor before testing. Storage work
remains paused; these results do not authorize cleanup or migration.

The smallest unfinished mailbox gate is a **separately approved live stopped
read-only probe**, with current public baseline/access bindings and a fresh,
bounded private credential/approval. The old live token is expired and must
not be reused. Do not generate a replacement token or an expiring operational
package under the current engineering authorization. Probe success cannot
approve a start, runtime/preparation window, provider call or email. The later
runtime and one-email gates remain separate, with the frozen sender/recipient
below and all readiness/automation hard-offs retained.

MVP-FL-05's integrated synthetic owner walkthrough and owner acceptance are
separate roadmap evidence levels; mailbox safety tests do not establish owner
pilot completion, deployed behavior or live material receipt. No new feature,
permission, deployment, production change or live operation is part of this
handoff correction.

## Proven failure, contributors and unknowns

The original host was `fa8b1f4a2fa8b05f9f9c3c66e18210cb384e477e`;
session digest was
`a1045595a21e7d6307749112203e803dee61ed8bba78b4f462fee3f6052ddb25`.
All 39 archived public files were rehashed against their preserved copy index
and original public files. No credential, private output or live record was read.

- Start intent: 18:20:50.124 UTC; pre-start checkpoint: 18:20:50.546.
  Primary failed at 18:20:57.692 with a typed 5000 ms readiness-command
  timeout, SIGKILL and verified command reaping. This proves the old inner
  cutoff fired; it does not prove how soon real SSH would have succeeded.
  The prior shared 15-second readiness correction removed that premature
  independent allowance while reserving cleanup/publication time.
- Metadata produced 28 successful samples, then failed its 29th read.
  Last reply was 18:20:53.772; next failure was 18:20:53.894. The next serial
  dispatch was no earlier than 18:20:53.797, leaving about 97 ms, which does
  not support attributing this failure to the 700 ms native timeout. Its
  exception category was not retained. HTTP, protocol/projection, process
  and other causes cannot now be distinguished. New typed diagnostics
  preserve future closed error categories without private output.
- Log polling produced 395 polls, including 38 command-stage 700 ms timeouts.
  Successful polls ranged from 373 to 709 ms, median 624 ms including
  scheduling/cleanup. Four error receipts (polls 41, 223, 300, 365) temporarily
  reported clientsReaped=false; final observer cleanup verified reaping.
  These repeated timeouts independently disqualify proof. They are an
  unresolved transport availability problem, not fixed by a readiness budget.
- Guardian exit code zero, eventual stopped settlement, exact acknowledged
  baseline restoration and positive private cleanup are separate safety
  outcomes. They cannot promote failed continuous observation into success.
  There was one start intent, two stopped updates and zero host-stop calls.
  The owner-terminal receipt proves its finalizer ran; returned shell prompt
  additionally proves the foreground command returned, not continuous stop.

The recipe pins Fly CLI 0.4.87 while the native SDK sources bind flyctl
0.4.115/fly-go 0.11.3. This mixed dependency boundary is explicit; no evidence
establishes it as an incompatibility or historical cause. No binary, image,
native artifact or lockfile was changed or regenerated for this review.

## Findings and corrections

| Severity | Finding | Correction and evidence |
| --- | --- | --- |
| P1 | Detached primary survived owner IPC loss after readiness; observer lacked active parent cancellation. | Existing IPC now acts as a local lifetime lease, established before async work. Loss/termination cancels local work, forbids later start/readiness admission, clears primary idle interval, drains owned commands and observer sampling, and preserves failed proof. Actual OS rehearsal reproduced the old orphan and verifies corrected exit/group absence. |
| P1 | A command with unverified retirement could be followed by another launch. | Process manager permanently closes launch admission on uncertainty while retaining cleanup. Late positive absence can complete cleanup but cannot reopen admission. Observer stops new log work after unverified reaping. Synthetic EPERM/timeout and late-reap regressions cover both states. |
| P2 | Launcher interruption after spawn or during settlement could abandon its own group. | POSIX termination masking covers ownership bookkeeping and bounded settlement; child restores the original mask before exec. Actual HUP/INT/QUIT/TERM probes cover spawn return, selector setup and repeated settlement interruption, with positive owned-group absence and unchanged child mask. |
| P2 | Wall-clock rollback or repeated exhausted quota could prolong observer work. | Once-anchored monotonic elapsed bounds supplement existing wall bindings, with distinct original metadata and log final tails. Quota exhaustion and cancellation terminate failed; abortable waits clear timers/listeners. Existing timing, read caps and proof gates are unchanged. |
| P2 gap | Repeated historical log timeouts and unknown metadata failure. | Public timing replay remains failed and ends at the first unverified command reap. Typed future diagnostics and slow/hung offline rehearsal improve attribution; live availability is not established. No timeout/gap/failure gate was relaxed. |
| Low | Guardian documentation described successful production HTTPS path as future. | Chronology now records successful historical candidate/rollback operations within the failed demonstration, retaining offline/live evidence distinctions. |

Lease listeners are removed after normal observer completion and primary
failure, allowing natural OS exit even while parent IPC remains connected.
On primary owner loss during native initialization, that existing bounded
initialization (at most 10 seconds) and native reaping (at most one second)
finish before the main path ends; no later
GET/start is admitted. An earlier failure receipt can conservatively retain
nativeReapVerified=null rather than inventing later proof.

Abrupt root termination may still retain a private-auth cleanup hold and skip
remote settlement/restoration. Local child cancellation does not grant host
stop, retry or restoration authority. The guest guardian's original cutoff
and separate evidence/recovery requirements remain necessary. A hold is not
permission to delete private evidence or claim successful closure.

## Full workflow coverage and limits

| Path | Reviewed / exercised | Boundary still synthetic or unknown |
| --- | --- | --- |
| Owner setup, TTY, public issuance/import, exact consent | Binding, private console, original expiry, one-shot entry and signal race; Python tests and actual owned signal probes | Credential identity remains owner-attested; no real credential generated/read |
| Source/native/image/Fly/price/baseline and archive admission | Coherent snapshots, immutable identities, freshness, tamper/replay denial, independent verifier and exclusive admission | No refreshed live baseline/price/access/package |
| Primary start through readiness | Actual production CLI via external-module fixture; real one-second start and six-second partial SSH, malformed/partial/hung response, old intent, timeout, parent loss, IPC natural exit and positive descendant absence | No Fly start, SSH, remote guest or real auth |
| Observer complete loop and proof | Metadata failure categories; sanitized historical timing replay; wall rollback, quota, aborted real waits, failed reaping, final cadence/tails, framing, ambiguity/OOM/restart/exit proof | Native/log network latency and uninterrupted provider coverage unproven |
| Observer CLI lease closure | Actual CLI with real IPC/timers/FDs; success/failure/disconnect/SIGTERM naturally exit after synthetic local cleanup | Transport loop separately tested with fake boundaries |
| Native and stopped updates | Fixed endpoint/request/no retry, sticky ambiguity, ack/version WAIT/readback, stateful transport lease, restoration admission | Optional fake-HTTP native coverage runs in CI; no local artifact rebuild |
| Guest cutoff and stop arbitration | Original wall/monotonic cutoff after host loss/blocked app, once-only terminal arbitration, bounded stop verification and inclusive read cap | Whole-Machine provider shutdown and billing are not guaranteed |
| Full qualification path | Existing separate preparation/qualification, inbound/replay/background retry/startup/late-work guards, actual fixture SQLite/listener closure, permission withdrawal/artifact-before-stop ordering | Guardian-only has no application worker/SQLite and cannot grant mailbox authority |
| Final cleanup | Owned group absence, native closure, preserved uncertain reservations, private-dir cleanup gate and historical positive auth closure | Abrupt root loss may retain hold; no private/live cleanup attempted here |

Independent reviewers covered complete relevant paths, not only changed lines.
No additional Critical/High/Medium defect was confirmed in settlement,
restoration, authority withdrawal, artifact publication or SQLite shutdown.
Offline tests use only owned synthetic processes, SQLite fixtures and localhost
servers, with external network denied. Native CI complements those tests; no
single fixture proves the real provider lifecycle.

## Historical remaining decision at this review point

Offline code safety and deterministic integration can be verified, but the
next live attempt cannot be predicted to pass. The 38 log timeouts still need
a narrowly scoped, separately approved fixed-target read-only transport timing
diagnostic against the stopped isolated Machine, or a separately reviewed log
acquisition design decision. No such diagnostic or design change is authorized
or performed here. Do not widen 700 ms polls or proof gaps to manufacture green.

Keep `uckele-group-p10b`, Machine `0803730bd1d7e8`, volume
`vol_vwnkpex1k3yx9dnv` stopped. A future proposal needs fresh reviewed exact
source/native/image, baseline, price, access and session bindings plus separate
owner approval. No expiring owner package should be generated in advance.
Sender remains `P10B Sender <sender@p10b-e2e.uckelegroup.com>`; eventual recipient
is `mathew@uckelegroup.com`. One email requires its own future approval.
No merge, deployment, provider action, credential use, email or production
change was part of this work.
