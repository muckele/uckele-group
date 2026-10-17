# Bounded ancillary native read attempts

Stopped-update verification permits at most 100 readback GET attempts per
admitted update, in addition to its existing ten-second settlement deadline.
The counter is consumed before each readback dispatch. An exact stopped result
on attempt100 can succeed if the original time/identity/configuration checks
also pass. Exhaustion throws without a verified update receipt, preserving the
existing uncertain-mutation hold; replay or controller reconstruction cannot
authorize another update/restoration from that hold.

Guardian-only settlement permits at most 441 GET attempts for its one admitted
phase. Its counter belongs to the existing boundary object and survives repeated
settlement calls. Failed reads consume attempts. An eligible stopped result on
read441 can succeed; otherwise exhaustion returns unverified settlement and
blocks restoration through the existing operator gate. The settlement receipt
retains the attempt count, limit and exhaustion flag. There is no extra final
read, replacement connection, new phase or quota renewal on failure.

These caps bound the two loops even if the wall clock fails to advance or moves
backward within an otherwise admitted session. Original deadlines, cadence,
admission, exact acknowledged-update/WAIT/readback requirements, descendant
reaping and private-authentication cleanup remain mandatory. The two-phase
no-email settlement path is unchanged; the 100-read update bound applies to
the shared update verifier.

The observer's700ms native timeout,250ms bridge allowance, inclusive1000ms
request/reply gap limit,3011 metadata attempts and410 log-command bounds are
unchanged. These are local call-site limits, not a global HTTP-request counter,
a provider billing cap, or emergency host-stop authority. Fly CLI internal
requests, other APIs and ongoing retained resource charges are not covered by
the new counters. Keep productionReady=false and global automation paused.

Offline regressions cover the final allowed success, refused extra attempts,
nonadvancing/backward clocks, failed reads, retained update holds/replay denial,
settlement re-entry, and unchanged existing deadline/normal-path checks. No
live qualification, owner package, credential, authentication, provider call,
spending, email, image build/push, merge or deployment is authorized here.
