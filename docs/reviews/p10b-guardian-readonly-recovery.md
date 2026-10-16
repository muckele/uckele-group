# Guardian read-only recovery failure

The owner-approved session `11e67850915c10e75c129327d3310ac7152daf541675534691173edcaa2f222e`
closed unsuccessfully at `recovery-baseline-read` on 2026-10-16 at
14:56:25.905 UTC. Its public closure verifies local client reaping and private
authentication cleanup. Execution had not reached an update, start, guardian
demonstration or restoration. The last successful preflight baseline was
14:54:02.014 UTC; there is no post-attempt stopped-state observation. The owner
subsequently reported revoking the matching token; this was not authenticated
again. The consumed packet and its evidence must remain preserved.

## Reproduced cause and diagnostic loss

The retained native initializes the guardian's stopped-update policy only when
`readOnly` is false. Only that policy emits `observation` and `settlement`
response fields. Its read-only recovery and observer services instead emit the
basic machine/error envelope. JavaScript incorrectly required an observation
for every guardian response, including read-only GETs. Therefore a valid machine
response, HTTP rejection, request timeout or connection failure became
`bridge-protocol`. The session CLI then discarded the branded, safe request
failure and retained only the stage. The original HTTP outcome cannot be
recovered from those public records; successful preflight does not establish it.

The bridge now selects the response envelope by service mode while preserving
guardian request limits, read-only POST rejection and strict mutation-mode
observation/settlement validation. The CLI retains only the existing branded
failure's code, method and timeout in its authentication closure. Arbitrary
error fields, messages, stacks, response bodies and headers are excluded. The
production native code, binary and checksum are unchanged.

## Specific missing coverage and limits

The previous eight composed guardian cases began with the mutation service and
mocked the demonstration. The host CLI completion fixture used `--run`, bypassing
the `--execute` recovery GET; native lock tests initialized without issuing a
GET. None composed the JavaScript bridge with the native read-only response.

New cases run the existing same-source Go test transport, real native service,
SDK request builder and JavaScript bridge against loopback HTTP: success, 401,
403, timeout, connection loss and invalid output. They also check no POST or
over-budget GET dispatch, local reaping/private cleanup, typed CLI diagnostic
retention and rejection of malformed envelopes. These cases execute in the
existing native-offline CI job. The unmodified eight mutation cases still check
acknowledgement, WAIT, readback, one-start limits and uncertain-result holds.

This establishes compatibility of the read-only response protocol under the
existing fake HTTP boundary. It does **not** establish the exact production
executable's successful HTTPS authentication/request path, current Fly state,
real guest shutdown timing or the demonstration's survival of controller loss.
The one-second GET budget is unchanged and may fail on real network latency.
The native basic envelope still classifies all HTTP rejections as `http-failed`;
it cannot expose an exact status or diagnose TLS from the old attempt.

No live retry, new credential, replacement owner packet or owner run is part of
this repair. Any future run needs a separately reviewed current host binding,
fresh prerequisites and separate owner approval. `productionReady=false`;
global automation remains paused. No preparation, provider or email authority
is added.
