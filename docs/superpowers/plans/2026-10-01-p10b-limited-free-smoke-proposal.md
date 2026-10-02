# P10B Limited Free Outbound Smoke Proposal

> **For agentic workers:** This is a noncanonical proposal for owner review. Do not implement it, configure infrastructure, create credentials, invoke a provider, or send email without the separate permissions listed below.

**Goal:** Add a deliberately incomplete, outbound-only smoke test that combines the existing deterministic local P10B lifecycle coverage with one separately authorized email to `mathew@uckelegroup.com` using separately approved, no-reply limited-smoke copy.

**Architecture:** Preserve the canonical P10B contract and add a separately named, versioned limited-smoke mode. The limited mode must reuse the existing durable prepare, review, authorization, final-gate, provider-pending, finalization, and cleanup path. It may prove one real outbound call and manual receipt, but it may never claim canonical P10B or scenario 74 completion.

**Tech Stack:** Node.js 22, existing SQLite-backed controlled-mailbox harness and provider seam, Resend sending API, deterministic local test doubles, GitHub Actions.

**Spec:** The canonical design and implementation plan remain unchanged: `docs/superpowers/specs/2026-09-24-pursue-cim-autopilot-design.md` and `docs/superpowers/plans/2026-09-25-pursue-cim-autopilot-implementation.md`. This proposal documents a narrower evidence artifact only; it does not amend either canonical document.

**Global constraints:** No deployment, production migration, activation, broker action, webhook, inbound routing, production credential access, or live sending is authorized by this document. A Resend sending-only key restricted to a domain does not restrict recipients at the provider, and the shared account still shares quota, rate limits, suppression state, and reputation.

**Review focus:** Practicality on the current free plan; honest acceptance boundaries; exact maximum-one-send enforcement; ambiguous-outcome handling; cleanup; credential lifetime; shared-account risk; and separation from canonical P10B.

## Owner decision

Approve only if the owner accepts all of the following:

- This produces `p10b-limited-free-smoke-evidence-v1`, not canonical P10B evidence.
- Canonical P10B remains incomplete because no live signed sent/delivered event, signed reply, provider read reconciliation, or structurally isolated provider tenant is exercised.
- Scenario 74 remains incomplete.
- Manual inbox receipt is an observation only. It is not trusted provider evidence, cannot finalize an ambiguous provider result, and cannot authorize a resend.
- One message from `p10b.uckelegroup.com` still consumes shared-team quota and can affect shared reputation or suppression state.
- A compromised domain-scoped sending key can send from that domain to arbitrary recipients during its lifetime. The application allowlist is a defense in the application path, not a provider-side recipient restriction.

Every report and evidence artifact must permanently include:

```json
{
  "evidenceVersion": "p10b-limited-free-smoke-evidence-v1",
  "p10bComplete": false,
  "scenario74Passed": false,
  "signedInboundCovered": false,
  "reconciliationCovered": false,
  "providerTenantIsolated": false
}
```

## What this can and cannot prove

| Claim | Deterministic local tests | One real outbound smoke | Status after success |
|---|---:|---:|---|
| Approved limited-smoke copy and immutable binding | Yes | Yes | Covered |
| Durable authorization and final gate | Yes | Yes | Covered |
| Maximum one application provider-seam entry | Yes | Yes | Covered for this execution path |
| Restart/replay sends zero additional messages | Yes | No second live attempt permitted | Covered deterministically only |
| Cleanup restores hard-off posture | Yes | Evidence recorded after live attempt | Covered for this execution path |
| Real Resend outbound configuration | No | Yes | Covered |
| Inbox receipt by the sole owner recipient | No | Manual observation | Observed, not trusted lifecycle evidence |
| Signed sent/delivered webhook | Test double only | No webhook | Not covered live |
| Signed reply terminalization | Test double only | No inbound routing | Not covered live |
| Provider read reconciliation | Test double only | No read-capable key | Not covered live |
| Structurally isolated provider account | No | Shared account/domain only | Not covered |
| Materials/attachment delivery | No | Excluded | Not covered |
| Canonical P10B / scenario 74 | No | No | Incomplete |

## Proposed future work

### Task 1: Add a separate limited-smoke contract

**Files:**

- Modify: `server/config.js`
- Modify: `server/services/pursueCimControlledMailboxHarness.js`
- Modify: `server/services/pursueCimControlledMailboxTemplate.js`
- Modify: `scripts/run-pursue-cim-controlled-mailbox.js`
- Test: `test/pursueCimControlledMailboxHarness.test.js`

- [ ] Add a distinct mode and artifact version; do not relax or alias `controlled-mailbox-v1`.
- [ ] Use a distinct exact confirmation, such as `EXECUTE P10B LIMITED OUTBOUND SMOKE ONCE`.
- [ ] Require exactly one normalized recipient equal to `mathew@uckelegroup.com` and a From address under `p10b.uckelegroup.com`.
- [ ] Define a distinct immutable limited-smoke template/version that clearly says no reply is requested. Omit the Reply-To header; reject any configured Reply-To or copy that invites a reply because no inbound route exists.
- [ ] Allow prepare to validate a keyless limited tuple: verified sending-domain attestation, exact recipient, isolated nonproduction process/database, and hard-off scheduler/follow-up posture.
- [ ] Require the domain-restricted sending-only key only during the final execution gate, immediately before the provider seam can be entered.
- [ ] Record missing webhook and reconciliation capabilities as expected uncovered blockers. Never reinterpret their absence as canonical readiness.
- [ ] Reuse the existing durable review digest, short-lived authorization, final gate, provider-pending transition, provider seam, outcome finalization, and `finally` cleanup.
- [ ] Refuse report language or machine fields that imply `P10B passed`, `P10B complete`, or scenario 74 success.

### Task 2: Prove the limited contract before provider setup

**Files:**

- Test: `test/pursueCimControlledMailboxHarness.test.js`

- [ ] Write failing regressions before implementation.
- [ ] Prove canonical mode still requires its full readiness tuple and remains byte-for-byte behaviorally unchanged.
- [ ] Prove limited prepare is keyless and rejects any Reply-To, reply invitation, recipient, From-domain, mode/version, digest, database, or configuration drift.
- [ ] Prove limited execute requires the exact key capability only at its final gate and rejects expiry, authorization, key, scope, and post-review drift before provider work.
- [ ] Prove a successful fake-provider execution enters the provider seam exactly once, persists the result, restores pause/hard-off state, and closes authorization/activation.
- [ ] Prove replay, restart, timeout, response loss, crash, and unknown outcomes invoke the provider zero additional times.
- [ ] Prove manual receipt fields cannot change a provider-pending or ambiguous durable result.
- [ ] Prove evidence always carries every permanent incomplete-status field above.
- [ ] Prove the immutable run evidence is written once and a separate post-run attestation is hash-bound to it without modifying it.
- [ ] Run changed-path tests, the repository-required full local checks, and disposable database parity where applicable.
- [ ] Obtain an independent review with no unresolved Critical or Important findings before publication.

### Task 3: Configure the keyless sending-domain boundary

This task requires separate infrastructure permission and must happen only after Task 2 is merged with green exact-main CI.

- [ ] Add and verify only the sending DNS records for `p10b.uckelegroup.com`; do not add inbound MX or webhook infrastructure.
- [ ] Ensure no production `RESEND_*` variables or production database URLs are available to that process.
- [ ] Configure exactly one recipient: `mathew@uckelegroup.com`.
- [ ] Configure no Reply-To and use only the exact approved limited-smoke template, which must not request a reply.
- [ ] Confirm current shared quota is sufficient for one message and that the owner accepts the shared quota/reputation/suppression risk.

Do not create or inject a sending key during this task. Domain verification and scope later require dashboard attestations; they are not trusted lifecycle evidence.

### Task 4: Prepare without sending

This task requires separate prepare-only permission.

- [ ] Start from a fresh isolated SQLite database with the provider, scheduler, and follow-up paths hard-off.
- [ ] Run prepare only. Provider call count must remain zero.
- [ ] Produce private, permission-restricted review and readiness artifacts with secrets redacted.
- [ ] Verify exact limited-smoke template copy, absent Reply-To, exact To/From binding, durable conversation/touch identity, review digest, incomplete-status fields, and zero-call posture.
- [ ] Present the exact digest and redacted review to the owner. Do not issue execution authorization yet.

### Task 5: Execute one outbound call and clean up

This task requires a final, separately authorized one-send permission tied to the exact review digest.

- [ ] Issue a durable authorization with `maximum_calls = 1` and an expiry no more than 15 minutes in the future.
- [ ] Only after the owner approves the exact digest, create a new Resend sending-only key restricted to `p10b.uckelegroup.com` and inject it only into the isolated execution process.
- [ ] Never place the key in Git, a readiness file, review file, evidence file, logs, or command-line arguments.
- [ ] Recheck every final-gate invariant immediately before provider invocation.
- [ ] Use only the existing durable provider-pending seam; do not add a direct sender or bypass durable transitions.
- [ ] Enter the application provider seam at most once. A synchronous accepted response may be finalized through the normal path; do not claim the remote provider saw a request unless the response or provider-side evidence proves it.
- [ ] If the process loses the response, times out, crashes, or cannot prove the outcome, persist/retain ambiguity and do not retry. Manual receipt cannot resolve the durable result.
- [ ] In `finally`, disable the provider path in memory, restore pause, withdraw/close authorization and activation, and verify the hard-off posture.
- [ ] On every return, error, abort, timeout, or interruption after key creation, immediately revoke/delete the Resend key manually and remove it from the isolated environment.
- [ ] Do not delete the durable database or immutable redacted run evidence needed for audit.
- [ ] Record provider-call state as JSON `0`, `1`, or `null` (`null` means unknown); never coerce an uncertain call into zero. Any value other than a proven single successful call leaves the smoke incomplete.

### Task 6: Record manual receipt without elevating trust

- [ ] The owner may report only whether the exact message arrived and when it was observed. Do not put message content or provider identifiers in a public report.
- [ ] Record `manualReceiptObserved`, `manualReceiptObservedAt`, and `manualReceiptObservedBy` separately from trusted lifecycle evidence.
- [ ] Always record `trustedLifecycleEvidence: false` for the manual observation.
- [ ] Do not use manual receipt to change accepted, rejected, ambiguous, or provider-pending state.

### Task 7: Add a hash-bound post-run attestation

The immutable run evidence is written before manual key revocation, secret removal, and receipt observation. Never overwrite or append those later facts to that evidence.

- [ ] Create a separate permission-restricted post-run attestation artifact after cleanup.
- [ ] Bind it to the exact run-evidence SHA-256, review digest, implementation head, database identity, authorization ID, and execution timestamp.
- [ ] Attest the dashboard-observed key domain scope, key revocation time/actor, local-secret removal time/actor, and manual receipt observation fields.
- [ ] Mark provider-dashboard and owner observations as manual attestations, not machine-verified or trusted lifecycle evidence.
- [ ] Refuse to overwrite an existing attestation; corrections must be append-only, separately timestamped attestations bound to the same run-evidence digest.

## Mandatory stop conditions

Stop before any provider invocation if any of these is true:

- The exact head, review digest, immutable message binding, database identity, or configuration changed after review.
- The sending domain is not verified; or, at the final execution gate, the newly created key is not sending-only or its domain restriction is absent.
- The To address is not exactly `mathew@uckelegroup.com` or the From domain is not exactly `p10b.uckelegroup.com`.
- Any production credential, production database URL, production delivery namespace, scheduler, activation, or follow-up path is available or enabled.
- Existing database, review, authorization, or evidence state is unexpected.
- Pause/hard-off posture is absent, authorization exceeds 15 minutes, or `maximum_calls` is not exactly one.
- Readiness claims signed inbound or reconciliation capability that is not actually configured.
- Shared quota is insufficient or the owner has not accepted shared-account risk.
- Cleanup, immediate key revocation, local-secret removal, or the separate post-run attestation cannot be performed and manually verified.
- Tests, independent review, exact-head CI, or exact-main CI have an unresolved failure.

After provider-pending begins, any uncertainty is terminal for this attempt: clean up, preserve evidence, and do not rerun or resend.

## Acceptance evidence

The limited smoke is successful only when all of the following are true:

- Deterministic local lifecycle and negative-path tests are green.
- Independent review has no unresolved Critical or Important findings.
- The exact implementation head and then exact main merge head have green required CI.
- Prepare proves zero provider calls.
- Execution proves exactly one application provider-seam entry and a durable synchronous accepted result; otherwise the result is incomplete or ambiguous with zero retries.
- Immutable run evidence proves provider hard-off, pause restored, and authorization and activation closed.
- A separate artifact bound to the run-evidence digest attests key scope, key revocation, local-secret removal, and any manual receipt observation. These are manual attestations, not trusted lifecycle evidence.
- The redacted evidence contains every permanent incomplete-status field.

Manual receipt may be recorded, but its absence or presence does not change the durable provider result. Even a fully successful limited smoke leaves canonical P10B and scenario 74 incomplete.

## Exact later permissions

No permission implies any later permission.

1. **Implementation permission:** Implement and independently review the limited-smoke mode, run local checks, and open a draft PR. No provider, account, DNS, credential, or sending action.
2. **Merge permission:** After rechecking exact-head CI, mark that PR ready and merge it, then verify exact-main CI. No provider action.
3. **Keyless infrastructure permission:** Add/verify only the `p10b.uckelegroup.com` sending-domain DNS records and configure the keyless isolated test environment. Do not create a key. No webhook, MX, full-access key, production changes, or send.
4. **Prepare permission:** Run the keyless isolated prepare phase and return the exact redacted review and digest. Provider-seam entries must remain zero.
5. **One-send permission:** After approving the exact digest, create and inject a temporary domain-restricted sending-only key, execute once within the 15-minute authorization, then clean up, revoke the key on every exit path, remove the secret, and write the hash-bound post-run attestation. At most one application provider-seam entry; no retry, deployment, migration, activation, inbound setup, or follow-up sending.

If the owner does not grant all five permissions in sequence, the last completed phase is the stopping point.
