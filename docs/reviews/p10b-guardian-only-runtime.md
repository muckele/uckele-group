# P10B guardian-only offline integration

The stopped configuration diagnostic demonstrated update acknowledgement, settlement, exact baseline restoration and local private cleanup. It performed zero starts. The next runtime milestone is one inert parent/guardian demonstration on the existing isolated target. This document and the implementation authorize no live run, new credential, image build/push, provider call, email, production change or spending.

## Frozen guardian contract

- Recipe `p10b-owner-guardian-only-recipe-v1`; bundle `p10b-guardian-only-bundle-v1`; session `p10b-guardian-only-session-v1`; approval `p10b-guardian-only-approval-v1`.
- Operation `guardian-only`, qualificationAllowed=false, productionReady=false, globalAutomationPaused=true.
- Existing app `uckele-group-p10b`, Machine `0803730bd1d7e8`, volume `vol_vwnkpex1k3yx9dnv`, ewr/shared CPU/512 MB; no resources are created.
- One inert `demo` phase, at most one five-minute start and two stopped `skip_launch` updates including conditionally eligible baseline restoration. No `prepare` packet or worker/SQLite/listener is run. Both guest processes ignore app secrets.
- Original one-hour session deadline, unchanged guest cutoff, zero authorized local image builds or pushes. Image evidence's historical build/push counts remain one; they do not authorize new work.
- Retained guest source `c4944a46ac362cdcd002e077d5533b4b0843b1d0`; image `sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc`.
- Separate host native artifact SHA256 `cf6db6a84f6d2b8e091784af4f8f67bdb07786368bf6447a8655a50e9a6b240f`, bound as `files.guardianNative`. Legacy and diagnostic native pins remain separate.

The owner launcher displays these limits and requires `APPROVE ONE GUARDIAN START <exact session digest>`. A previous diagnostic or two-phase approval cannot authorize this mode. A fresh packet, source/native/image bindings, original deadlines, fresh baseline/price/permission evidence and separate owner approval are still required before any future live setup.

## Admission and update safety

Existing archives are inspected read-only. Their archive/attempt/prior intent, terminal, verification and directory identities remain bound and unchanged. Fresh owner and independent stopped-baseline proofs create new exclusive session-bound admission records; historicalCleanupVerified remains false. A current active reservation, changed record, stale initial proof or consumed session refuses. Guardian admission must be verified within 120 seconds before the first operator intent; coherent archive inspection continues through the original session deadline. Diagnostic admission retains its 120-second limit.

A mutation intent without a verified acknowledgement/settlement/readback is a durable hold. A later GET showing a known candidate cannot turn an unacknowledged POST into restoration authority. The host controller rejects retries, later phases, start and automatic restoration after ambiguity. Its hold survives controller reconstruction from evidence.

The guardian native client independently permits one candidate POST followed only by an eligible baseline POST. It requires a successful bounded exact-version WAIT and matching stopped readback. Unknown acknowledgements, response loss, failed WAIT/readback, concurrent version/configuration changes and deadlines hold. The native transport uses a direct single SDK request with replay/retry disabled. A failed legacy native POST also latches a no-further-writes hold.

## Process and cleanup ordering

The independent observer attaches before the sole start. The existing primary controller is killed only after bound readiness. Success requires a single terminal guardian record, independent observer survival, normal whole-Machine exit, no restart, bounded metadata cadence and verified stopped state within 30 seconds and the original cutoff. Uncertain guest stop does not trigger an emergency host stop or another start.

The same native transport must preserve its acknowledged update state through restoration. All phase processes and observer descendants are reaped first. The guardian-only phase checkpoint permits exactly that root-owned live native transport reservation to remain: an opaque in-process lease binds the session digest, private directory, original exclusive marker identity and direct child lifetime. Every other pending descendant still blocks restoration. Generic `assertReaped` and private cleanup have no exception. After restoration or failure, the native transport is closed/reaped and ordinary full cleanup is mandatory. There is no journal, parent-supplied replacement acknowledgement or fresh-native restoration escape.

## Offline verification

Regression tests first reproduced the missing guardian admission/contract and unacknowledged-update restoration. Focused tests cover archive immutability and tampering, fresh admission and lifetime, one-start/zero-preparation authority, exact native lease isolation, terminal reporting and private cleanup.

`test/p10bGuardianRuntimeTransport.test.js` composes the real host operator, stdio bridge, native policy and official SDK against a loopback fake HTTP server. It exercises success, committed response loss, request timeout, wrong WAIT/readback, uncertain stop, pending descendant and ambiguous restoration. Guest observation/start are stubbed external boundaries; this does not establish real Fly guest timing. CI runs this suite with a locally compiled test-only transport. Existing real local process/SQLite/replay/startup/late-work tests continue to gate the broader qualification implementation.

Full offline verification and independent review of the exact final source are required before commit/push. No diagnostic or offline result promotes a mailbox lifecycle claim. After a separately approved successful guardian demonstration, zero-send application preparation is a later milestone. A real one-email qualification remains separately approved with fresh provider identity evidence and frozen sender `P10B Sender <sender@p10b-e2e.uckelegroup.com>` and recipient `mathew@uckelegroup.com`.
