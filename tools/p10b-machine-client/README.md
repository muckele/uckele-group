# Fixed P10B native Machine client

Build and test offline with Go 1.26.9:

```sh
go test ./...
go build -o /tmp/p10b-machine-client .
```

The tests inject request/HTTP boundaries or use the official SDK with a synthetic
opaque token and a fake HTTP client. They never call `loadClient`, authenticate,
contact Fly, or inspect the normal credential store. Module versions and checksums
are pinned in go.mod/go.sum.

The binary's only entry point is `--serve`. It first receives a bounded exact
public-session initialization packet on stdin, then closed JSON request frames.
Normal Fly config and its official SDK retain opaque authentication inside this
native process. The parent never receives authorization headers or token strings.
No login, refresh, metrics, proxy, retry wrapper, shell, redirect or arbitrary URL
is used. Its only API target is the fixed isolated Machine. `POST` requires
`skip_launch:true`, the caller's frozen `current_version`, and one of the exact
baseline/derived public configurations. Observer instances admit `GET` only.

Only the approved public Machine/config/image/lifecycle projection crosses
stdout. Raw API errors, unexpected fields and private values are discarded.
Failures retain a closed reason; the Node wrapper separately retains OS child
status and proves local termination within its bounded reap interval.

Do not invoke the normal bootstrap until a separately approved live session,
image prerequisite, owner-authentication coverage and positive recovery proof
have passed. Compiling this helper grants no Machine or email authority.

The separately compiled `p10b_stopped_diagnostic` mode has only the
`--serve-stopped-update-diagnostic` entry point and accepts the v2 zero-start
session with `recoveryPolicy=acknowledged-only-nonrunning-v1`. It permits one
candidate POST and at most one eligible baseline POST. Each successful update
must acknowledge the exact configuration and new version. Diagnostic-only IPC
`WAIT` accepts only `{version}` and becomes a single GET to the fixed Machine's
`/wait` endpoint with `state=settled`, that acknowledged version and a bounded
timeout. It has no retry wrapper. Only a closed successful nonrunning settlement
followed by a fresh exact current-version/configuration GET can admit restoration.
WAIT and readback share one immutable ten-second window; a delayed read cannot
renew it. Initial admission remains stopped; post-update created or stopped is
allowed. Failed/unknown writes, failed settlement, drift or expired observation
hold further mutation permanently. Later visibility cannot authorize recovery
from an ambiguous request. Recovery then needs separate approval.
