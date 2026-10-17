# Readiness budget and observer diagnostics, 2026-10-17

The one-shot guardian demonstration at host revision
`fa8b1f4a2fa8b05f9f9c3c66e18210cb384e477e`, session
`a1045595a21e7d6307749112203e803dee61ed8bba78b4f462fee3f6052ddb25`,
failed. Its primary retained a `readiness-command` timeout at 5000 ms with
command clients reaped. The observer retained 28 successful metadata samples
before a metadata-read/sampling failure and finished abnormally. It also
recorded 38 command-stage log-read timeouts at 700 ms. The underlying SSH/log transport causes and the discarded metadata error category remain unknown.
Continuous coverage, normal whole-Machine exit and timed convergence remain
unproved. Increasing an inner allowance does not prove that this attempt
would have succeeded.

Distinct public settlement/restoration receipts verify stopped state, exact
sealed baseline restoration and settled mutations. The runtime auth closure
verifies direct/client reaping and temporary credential-file cleanup. There
was one start intent, two stopped-update intents and no host-stop call. The
owner-terminal receipt records finalization at 18:25:48.394 UTC. It is written
after private input closure and environment removal in the launcher's final
cleanup block, followed by return to its caller. It is not a separate OS-exit
receipt; a returned foreground shell prompt additionally confirms the launcher
command returned. Historical uncertain/private evidence remains preserved.

## Correction

Both parent and primary now derive one absolute readiness cutoff from the
existing immutable demo start intent's `at + 15000 ms`. The intent must have
exactly `at` and `window`, a canonical nonfuture timestamp within the frozen
window, a matching complete window and positive remaining time. A missing,
malformed, mismatched or exhausted intent cannot launch another primary or
Machine command. No new renewable deadline or approval field is introduced.

Launch, native initialization, Machine start and SSH consume that same
remaining budget. Machine start retains its 10000 ms maximum. SSH uses only
the remainder minus 2000 ms: 1500 ms for existing owned-command termination
and another 500 ms for public evidence/IPC. IPC acknowledgement is itself
bounded by the smaller of 500 ms and the remaining cutoff. Evidence or
callback work crossing the cutoff fails; it cannot reconstruct success.

The parent schedules its timer once before launch. Parent and primary also
retain monotonic elapsed deadlines derived from their initial remaining time,
and check the minimum of wall and monotonic remainders. This prevents a
backward wall-clock change, stalled launch or queued message beating an
overdue timer from extending admission. Cutoff equality fails. Only the
parent's separately received readiness, binding checks and verified owned
primary termination can advance guardian proof.

Observer read errors now retain only the existing typed
`publicP10bNativeFailure` facts: closed version, code, method and timeout.
Unknown, spoofed and target-mismatch errors retain `null`. Messages, stacks,
response bodies, argv, environment and credentials are never copied. Sampling
still stops on failure, health remains failed and proof still rejects the
trace. The original metadata cause cannot be recovered retrospectively.

## Offline regression scope

Tests execute the actual primary script with stubbed external boundaries and
compose its emitted IPC into the concrete parent. They cover a six-second SSH
response within the existing total allowance, reduced remainder after launch/
initialization/start, reserved cleanup time, uncertain reaping, invalid/stale
intent, exact and overdue cutoffs, delayed publication/IPC, missing IPC
acknowledgement, and stalled launch plus wall-clock rollback. Existing owned
process tests retain real local OS exit/group-reap verification.

Observer tests cover typed timeout, HTTP and bridge failures; arbitrary and
spoofed errors; target mismatch; secret canaries; sticky failed health and no
sampling resumption. Existing observer timing, quota and proof tests retain
their original limits. The broader offline P10B suite uses synthetic SQLite
fixtures and localhost listeners with all external network denied. A default
sandbox run exposed `listen EPERM` for those existing listeners; validation
requires the explicit localhost-only sandbox, not weaker application checks.

The composed preparation/separate-qualification fixture also failed identically
at the unchanged parent revision on Saturday October17. Synthetic preparation
advanced its effective time to Monday, while qualification reused Saturday's
configuration evidence. The existing24h freshness check correctly rejected it.
The separate offline qualification now supplies fresh synthetic configuration
evidence at its own effective time. Production freshness and authority checks
are unchanged; this fixture correction grants no live qualification authority.

No guest image, native executable, observer timing/quota, one-shot authority,
stop/restoration ordering, qualification permission or production setting
changes. `productionReady=false`, `qualificationAllowed=false` and global
automation paused remain required. No live retry, provider call, email,
credential access, token revocation, build, deployment or merge is authorized
by this correction. Any later live proposal needs a fresh reviewed host-bound
package and exact separate owner approval; the consumed attempt stays failed.
