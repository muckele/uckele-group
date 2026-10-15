# Stopped-update-only diagnostic: offline implementation, execution held

This implements the separately approved preparation of a narrower diagnostic.
It does not grant permission to run it, qualify a mailbox or send email. No new
live package, credential, authenticated observation or Machine operation is
created by this change. The original failed request's response was not retained;
its cause remains unknown. Fake HTTP tests cannot recover that response.

## Proposed future live scope

The only target is app `uckele-group-p10b`, Machine `0803730bd1d7e8`, volume
`vol_vwnkpex1k3yx9dnv`, region `ewr`. The Machine must remain stopped. Retain
source `c4944a46ac362cdcd002e077d5533b4b0843b1d0`, candidate image
`sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc`
and baseline image
`sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629`.

A distinct recipe, session, approval, CLI, native initialization protocol and
native build tag enforce zero starts, no qualification continuation, no build or
image push, no provider calls, no email and no production action. The complete
public configuration and initial instance version come from a fresh approved
read-only preflight. The diagnostic config matches the retained watchdog update
shape, with new nonce/times, frozen sender and all provider/automation switches
off. Configuration data does not authorize execution of its guest processes.

The write budget is one diagnostic POST plus at most one separate conditional
baseline restoration POST, maximum two POSTs total. Every POST has
`skip_launch=true`, an exact observed `current_version` and a 10-second request
deadline. There is no mutation retry. The native service independently requires
an immediately preceding stopped GET of the correct configuration/version and
enforces diagnostic→baseline write order. A restoration is allowed only after
observing the exact stopped diagnostic config with a new instance version.
Observation windows are at most 10 seconds, each GET at most one second and
clamped to the remaining window. Post-await and pre-dispatch checks preserve
admission and strict cutoffs. The host operation has a 120-second maximum from
CLI entry; the concrete approval retains its original 15-minute cutoff.

Only numeric HTTP status (or null), a closed failure category, monotonic request
elapsed time and the dispatch observation cross the native diagnostic boundary.
Dispatch means the local HTTP client's `Do` was entered; it does not prove server
acceptance. Headers, raw bodies/errors, private stderr and authentication are
excluded. Public Machine config/version projections and their digests are
recorded separately. Durable intent precedes each write. Replays remain held.

## Uncertainty and local closure

Timeout, malformed protocol and transport failure can leave a remote update
pending. Seeing the old stopped baseline during bounded polling does not settle
that uncertainty. The controller records `mutationUncertain=true`, holds and
never repeats the diagnostic request. A server may commit after local clients
are reaped and the private credential directory is cleaned. Tests explicitly
keep the fake server alive and prove this late-commit case. Cleanup success is
local evidence; it is never remote cancellation or settlement evidence.

If an exact stopped diagnostic version becomes visible within the bound, one
baseline-only CAS restoration may run. Success requires the restoration's
successful response, a newly versioned stopped baseline observation, verified
native reap and private cleanup. A failed primary request remains a failed
primary request even when restoration succeeds. An unsuccessful or ambiguous
restoration holds. Unknown state/config/version, withdrawn admission, timeout or
cleanup uncertainty also holds. No automatic stop/start or additional write is
available to resolve a hold; any incident handling needs separate authority.

## Future prerequisites and owner decisions

A later, separately approved package must bind this reviewed clean host commit,
the separately compiled diagnostic executable SHA, retained legacy preflight
native SHA and all other executable/public evidence hashes. The diagnostic
native pin is
`992be4e7b7c62d44157fcf47f4966084fec5f08dcad972669821743102b7d997`
for the reviewed Go1.26.9 Darwin arm64 build with
`-tags p10b_stopped_diagnostic -trimpath -buildvcs=false`. The legacy executable
pin is unchanged. Other platforms require separately reviewed binaries/bindings.
No concrete future recipe or wrapper is generated here.

Preserve existing consumed packages and pending/uncertain admission evidence.
Fresh original public issuance receipts, identity/secret-name metadata, public
price evidence, stopped baseline/version and retained registry manifest evidence
must pass the existing preflight. Independent baseline and archived-reservation
verification must pass before constructing the mutation client. Recovery
archival preserves historical bytes and never asserts historical cleanup.

The owner separately reviews recipe-bound private setup consent, operates the
reviewed issuance wrapper once, reviews the combined public receipt attestation
and supplies the matching opaque app credential once through hidden TTY input.
The launcher does not issue credentials or capture creator output. After
preflight clients are reaped and its private context is cleaned, it seals the
exact stopped-only session. Final permission is the distinct phrase
`APPROVE STOPPED UPDATE <session digest>`. The launcher cannot substitute the
broader no-email session or its approval phrase. Original receipt timestamps,
expiry, source binding and cutoff remain unchanged across this journey.

Separate approval to prepare this implementation is not approval for those live
steps. Any future approval must explicitly accept the maximum two stopped-only
POSTs and possible unresolved late remote mutation. Public receipts and opaque
credential selection remain owner attestations. A later mailbox test and its
single email require their own approval. The eventual frozen identity remains
`P10B Sender <sender@p10b-e2e.uckelegroup.com>` to
`mathew@uckelegroup.com`. `productionReady=false`; global automation stays paused.

## Offline verification boundary

Tests cover the real owner TTY, actual public receipt import/attestation,
preflight validation/session sealing and private cleanup; external issuance and
execution are explicit synthetic boundaries. Separate CLI tests compose the real
recovery gate/controller with fake external processes. Native initialization
negative tests reject widened authority before calling even the injected
factory. IPC tests use real owned local children and malformed/private canaries.
Composed controller→native→official SDK→loopback fake HTTP tests cover delayed
success, numeric rejection, timeout with in-window visibility/restoration and
remote commit after observation cutoff/local cleanup. They exercise the full
frozen configuration and SDK request path without contacting Fly or a provider.
CI runs both Go tags, the composed transport tests and the diagnostic owner TTY
regressions alongside the existing complete checks.
