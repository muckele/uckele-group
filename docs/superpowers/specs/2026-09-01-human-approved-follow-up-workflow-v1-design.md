# Deal Hunter MVP Phase 3: Human-Approved Follow-Up Workflow v1

**Status:** Formal product design specification

**Date:** 2026-09-01

**Production baseline inspected:** merge `89a10c5cd68777b8bd4858ad43aa3613ea41ed0e`, Fly release `v114`

**Scope:** Product and engineering design only. This document is not an implementation plan and does not authorize implementation or deployment.

## 1. Purpose

Phase 3 adds a persistent, bounded broker-material follow-up sequence to the existing Deal Hunter CIM request workflow. An administrator explicitly enrolls one canonical, provider-accepted CIM request. The server calculates each due date. When a follow-up is due, a human reviews the exact server-owned message and explicitly approves that one transmission. The existing durable CIM executor then persists and sends the exact communication, reconciles provider outcomes, updates authoritative request/history state, and, after durable provider acceptance, schedules the next due date.

The governing invariant is:

> Scheduling may be automatic after explicit enrollment. Transmission may never be automatic for a Phase 3 operator-approved sequence. Every Follow-Up 1–5 requires a fresh, principal-bound review and approval.

The product label is **Start Follow-Up Sequence**. The permanent termination action is **Stop Follow-Ups**.

## 2. Non-goals

Phase 3 does not:

- change or reopen the deployed Phase 2 initial-request workflow;
- enable Stage 2 or Stage 3 automation;
- enable the automatic CIM follow-up scheduler;
- create an unlimited campaign engine or Follow-Up 6+;
- introduce automatic sending, early sending, batch approval, reusable approval, or approval-by-due-date;
- introduce snooze, skip, one-step pause, custom rescheduling, restart, or re-enrollment after Stop Follow-Ups;
- add holiday calendars;
- permit arbitrary recipient, subject, or body edits;
- use the generic CRM Follow-Ups Workspace/outbox as the Phase 3 sender;
- add a Phase 3 pipeline stage or duplicate communication history;
- rewrite or bulk-enroll historical requests;
- add a table or column unless implementation inspection disproves the current storage assessment.

## 3. Relationship to Phase 2 and production safety

Phase 2 remains the authority for a human-approved initial broker-material request. Its `metadata.manualApproval` audit remains immutable. Phase 2 requests intentionally persist:

```text
next_follow_up_at = null
follow_up_state = "not-scheduled"
metadata.manualApproval.followUpPolicy = "none"
```

Phase 3 does not reinterpret those records. A new, explicit enrollment mutation adds a separate `metadata.manualFollowUp` marker and schedules Follow-Up 1. The Phase 2 marker remains intact as the audit of the initial send; the Phase 3 marker is the later authority for the follow-up sequence.

Production remains closed throughout Phase 3 development and initial deployment:

- central CIM outreach pause remains authoritative;
- effective automation stage remains Stage 1;
- Stage 2 remains disabled;
- automatic initial transmission remains blocked;
- `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED` remains `false`;
- no scheduler or Operations action gains authority to send a marked Phase 3 follow-up.

The human-approved endpoint calls the existing durable executor seam independently of the automatic-runner enable flag. It still enforces the central pause, readiness, recipient cadence, weekday/window, claims, suppressions, and every terminal-state check.

## 4. Selected architecture

Phase 3 is an approval adapter over the existing canonical CIM request, deterministic message builder, communication identity, claims, provider idempotency, send, event, and reconciliation machinery.

The selected architecture has four boundaries:

1. **Sequence authority and projection** loads the canonical request and related acquisition state, validates enrollment/terminal conditions, calculates due dates, and projects UI states.
2. **Side-effect-free preparation** renders the exact proposed follow-up and signs all material authority into a short-lived, principal-bound proposal.
3. **Approval and durable execution** is entered only through the explicit administrator Approve Follow-Up endpoint. That endpoint verifies the proposal, revalidates current authority, and invokes the existing single-request durable follow-up executor with a trusted approved-message context. The executor claims the exact due touch, persists the exact communication, performs the final safety check, and calls the existing provider seam.
4. **Atomic finalization and reconciliation** establishes provider acceptance exactly once, increments `follow_up_count` exactly once, and either schedules the next due date or closes the sequence.

Two alternatives remain rejected:

- Computing due dates for every old accepted request without explicit enrollment would silently reinterpret Phase 2 and historical state.
- Sending through the generic CRM Follow-Ups Workspace would create a parallel outbox, different cadence/message semantics, and a manual-takeover path that stops the CIM sequence. It remains available for later human CRM communication, not Phase 3 execution.

## 5. Sequence enrollment

### 5.1 Action and permissions

Only an administrator may select **Start Follow-Up Sequence**. A viewer sees status but receives no enrollment control.

The command targets one request ID under one canonical opportunity. Both identifiers are untrusted routing inputs; the server resolves current canonical authority and confirms that the request is the canonical request for that opportunity.

### 5.2 Eligibility

Enrollment requires all of the following:

- the canonical opportunity and linked CRM submission are current and resolvable;
- the target CIM request exists, belongs to that opportunity, and is the canonical conversation owner;
- durable provider acceptance of the initial or most recent counted touch is established by authoritative request/communication evidence;
- the request has no unresolved ambiguous transport outcome;
- `follow_up_count` is an integer from 0 through 4;
- `follow_up_state` and `next_follow_up_at` do not already represent an active legacy or Phase 3 sequence;
- the request was not permanently stopped and has not completed five accepted follow-ups;
- no reply, materials-received state, Pass/dismissal, archive, opt-out, complaint, suppression, terminal unsafe delivery state, or inappropriate diligence/LOI advancement exists;
- no conflicting canonical request owns an active sequence.

An accepted request with a historical nonzero count may be explicitly enrolled only if the exact most recent accepted follow-up communication and acceptance timestamp can be established. This is an operator choice, not a migration. A legacy request that is already scheduled is not converted in place.

`logged`/development-only state is not durable provider acceptance and is not production enrollment authority.

### 5.3 Durable effect

Enrollment is one atomic compare-and-set mutation with its CRM activity. It:

- revalidates the request and linked submission versions;
- calculates Follow-Up `follow_up_count + 1` from the actual provider-acceptance timestamp of the immediately preceding touch;
- sets `next_follow_up_at` to the calculated due instant;
- sets `follow_up_state = "scheduled"`;
- preserves `follow_up_count`, `last_follow_up_at`, the request, and every communication;
- merges an audited marker into existing request metadata;
- records one existing CRM/CIM activity such as `cim.manual-follow-ups-enrolled`.

It creates no communication, provider call, transmission claim, recipient claim, outbox item, or follow-up count increment.

The marker is conceptually:

```json
{
  "manualFollowUp": {
    "version": "deal-hunter-manual-follow-up-v1",
    "mode": "operator-approved",
    "maximumFollowUps": 5,
    "cadencePolicy": "accepted-local-date-plus-2-weekend-forward-0900-pt-v1",
    "enrolledAt": "<ISO instant>",
    "enrolledBy": "<administrator principal/username>"
  }
}
```

The metadata may later add `stoppedAt`, `stoppedBy`, and `stopReason`, or completion audit fields. It must not replace `metadata.manualApproval` or unrelated metadata.

## 6. Sequence size, numbering, and count semantics

The sequence has at most five accepted follow-ups:

```text
Initial request → Follow-Up 1 → Follow-Up 2 → Follow-Up 3 → Follow-Up 4 → Follow-Up 5 → complete
```

For an enrolled request:

```text
current follow-up number = follow_up_count + 1
```

while `follow_up_count < 5` and the sequence remains active.

`follow_up_count` counts only follow-ups whose provider acceptance is durably established. It does not count preparation, opening review, clicking approval, communication persistence, provider-call start, definitive rejection, or unresolved ambiguity. Development-only logging is not a Phase 3 accepted touch.

Examples:

- Follow-Up 1 definitively fails before acceptance: count remains 0; retry is still Follow-Up 1.
- Follow-Up 1 is accepted or later reconciled as accepted: count becomes 1 exactly once; Follow-Up 2 may be scheduled.
- Follow-Up 5 is accepted: count becomes 5, `next_follow_up_at = null`, and the sequence is complete.

No input or configuration can produce Follow-Up 6 for a marked Phase 3 request. The marker’s server-owned maximum of 5 is authoritative; a browser cannot submit a maximum.

## 7. Exact cadence formula

The Phase 3 cadence is a versioned server policy, not the legacy `[48, 72, 96]` duration sequence.

Given the durable provider-acceptance instant of the immediately preceding touch:

1. Convert that instant to its calendar date in `America/Los_Angeles`.
2. Add two Gregorian calendar days to that local date.
3. If the resulting date is Saturday, advance two days to Monday.
4. If the resulting date is Sunday, advance one day to Monday.
5. Construct 9:00 AM on the resulting date in `America/Los_Angeles`.
6. Persist the corresponding UTC ISO instant in `next_follow_up_at`.

The time of day of the prior acceptance is discarded after selecting its Pacific calendar date. The implementation must use timezone-aware calendar arithmetic, not add 48 elapsed hours and then round. Nine o’clock is unambiguous across Pacific daylight-saving transitions.

### 7.1 Weekday matrix

| Previous accepted touch, Pacific date | +2 calendar-day target | Rollover | Next due |
|---|---|---|---|
| Monday | Wednesday | none | Wednesday, 9:00 AM PT |
| Tuesday | Thursday | none | Thursday, 9:00 AM PT |
| Wednesday | Friday | none | Friday, 9:00 AM PT |
| Thursday | Saturday | Saturday → Monday | Monday, 9:00 AM PT |
| Friday | Sunday | Sunday → Monday | Monday, 9:00 AM PT |

Defensive behavior for legacy/reconciled weekend acceptance is deterministic: Saturday anchors Monday; Sunday anchors Tuesday. Normal Phase 3 transmission remains Monday–Friday only.

This is not two complete business days. Friday acceptance becomes Monday due, not Tuesday.

### 7.2 Acceptance timestamp authority

For a synchronous provider acceptance, the server captures an acceptance instant when the provider returns accepted, and uses the same instant for communication delivery state and request finalization. It must not use preparation time, approval-click time, runner-start time, or a timestamp captured before the provider call.

For reconciliation, the authoritative communication/provider event acceptance timestamp is the anchor. If only an accepted communication can establish the outcome, use its durable acceptance-state timestamp according to the existing proof ordering.

## 8. Automatic next-date scheduling

After a Follow-Up N acceptance is durably established, the atomic finalizer:

1. verifies that the deterministic communication represents N and has not already been counted;
2. increments `follow_up_count` exactly once;
3. sets `last_follow_up_at` to the accepted instant;
4. appends/merges the accepted attempt in existing follow-up metadata without duplicating acceptance;
5. re-evaluates terminal state;
6. if N < 5 and the sequence is still active, calculates and persists N+1’s due instant and keeps `follow_up_state = "scheduled"`;
7. if N = 5, clears `next_follow_up_at` and sets `follow_up_state = "completed"`;
8. records the existing CIM activity convention;
9. creates no communication or claim for N+1 and performs no N+1 provider call.

Automatic scheduling is allowed while the global pause is active. Reconciliation also continues while paused. The pause blocks provider work, not authoritative state repair.

## 9. No automatic sending and the runner hard boundary

The automatic runner may list a due marked request, but due is not authorization. The runner never accepts, verifies, forwards, or consumes a human approval artifact.

At the earliest per-request authorization boundary, before request claim, recipient claim, communication creation, activity creation, or provider work:

```text
if metadata.manualFollowUp.mode == "operator-approved"
then return approval-required and skip
```

This condition is unconditional. The automatic runner has no code path by which an approval artifact can convert a marked request into an authorized transmission. It reports/skips the request as `approval-required` with zero request transmission claims, recipient claims, send-attempt communications, send-attempt activities, or provider calls.

Only the explicit administrator Phase 3 Approve Follow-Up endpoint may verify a signed approval artifact. After verification and current-authority revalidation, that endpoint alone may invoke the existing single-request durable follow-up executor for a marked request.

This remains true if someone enables `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED`, invokes Operations → Run Follow-Ups, changes cadence configuration, or changes scheduler configuration.

The production flag remains false. The hard boundary is defense in depth and must be tested with the flag true.

Legacy, unmarked automatically scheduled requests retain their historical policy and behavior. Phase 3 does not bulk-mark or reinterpret them.

## 10. Due, future, overdue, and review state

No new durable `due` or `overdue` enum is introduced. The detail projection derives state from the manual marker, `follow_up_count`, `next_follow_up_at`, current Pacific time, exact communication state, and terminal authority.

| Authority | Projected label/action |
|---|---|
| no marker and no active legacy sequence | Follow-ups not scheduled; administrator may see Start Follow-Up Sequence if eligible |
| active marker, future due | Follow-Up X of 5 scheduled · date/time; Stop Follow-Ups |
| current time equals/exceeds due | Follow-Up X of 5 due; Review Follow-Up; Stop Follow-Ups |
| due date is in the past | Follow-Up X of 5 overdue; Review Follow-Up; Stop Follow-Ups |
| prepared review open in this client | Reviewing Follow-Up X of 5 |
| exact attempt definitively failed | Follow-Up X of 5 failed; Review Retry |
| unresolved provider outcome | Outcome unresolved; Check Status; no resend action |
| count 5 | 5 of 5 follow-ups sent · Sequence complete |
| operator stop | Follow-Ups stopped |
| reply/materials/other terminal authority | Closed · reason |

“Under review,” “due,” and “overdue” are projections. Closing review changes nothing durable.

### 10.1 Early-send prevention

Before `next_follow_up_at`, the UI does not show Review Follow-Up and the preparation endpoint returns a fail-closed not-due conflict. The approval endpoint independently compares current time with the signed and current due timestamp. There is no early-send override.

Due means eligible for review/send consideration, not guaranteed transmission. Recipient cadence, send window, readiness, pause, suppression, and terminal state remain independently authoritative.

## 11. Terminal and blocking conditions

The following conditions close or block the sequence:

| Condition | Durable/projected result | Retry/override |
|---|---|---|
| authoritative broker reply, including brief or out-of-office | stop immediately; clear schedule; Closed · Broker replied | no Phase 3 continuation |
| explicit opt-out, complaint, or global suppression | permanent stop; clear schedule | no Phase 3 override |
| Pass/dismissal | stop; clear schedule; invalidate preparation | restore does not restart |
| CRM archive | stop; clear schedule | restore does not restart |
| acquisition materials received | stop; clear schedule | later CRM work only |
| diligence/LOI advancement where broker-material outreach is no longer next | stop; clear schedule | later CRM work only |
| bounced/failed/complained/suppressed recipient | stop ordinary sequence | corrected-recipient workflow where allowed |
| delayed delivery | temporarily block send; retain due/overdue | clears when authoritative state clears |
| unresolved ambiguous/unknown transport | stop scheduling and prohibit resend | reconciliation/manual investigation only |
| Stop Follow-Ups | permanent stopped state | no restart/re-enrollment |
| count reaches 5 | completed; no next schedule | no Follow-Up 6 |
| temporary cadence/window/readiness/pause blocker | retain original due timestamp and show blocker | review/send when it clears |

Terminal and safety authority is checked at enrollment, projection where appropriate, preparation, approval revalidation, durable claim, immediately before the provider boundary, and automatic-runner authorization.

### 11.1 Reply

Any authoritative inbound event routed to the canonical request stops the sequence. Content is not classified for usefulness. Out-of-office and “will send later” replies still stop Phase 3; a human may continue through ordinary CRM tools.

### 11.2 Pass, dismissal, and archive

Existing atomic Pass/archive behavior that clears CIM schedules remains authoritative. Restoring an opportunity or CRM submission does not recreate a schedule or remove a stop marker. Any prepared token becomes stale because its request/submission authority no longer matches.

### 11.3 Suppression, complaint, and opt-out

Use existing recipient-global suppression and delivery-event authority. Phase 3 supplies no suppression, complaint, opt-out, pause, or cadence override. An initial-contact cadence override is neither presented nor consumed for a Phase 3 follow-up.

## 12. Shared acquisition-materials predicate

The current Command Center stage derivation treats `documents.length > 0` as `docs-received`. That is too broad for an outreach stop because an unrelated document could terminate a valid broker-material sequence.

Phase 3 requires one semantically narrow shared predicate, implemented outside the Command Center and reused by both the Command Center and follow-up authority. Conceptually:

```text
evaluateAcquisitionMaterialsState({ submission, secureDocuments, latestUploadRequest })
→ { materialsReceived, advancedBeyondBrokerOutreach, evidenceCodes }
```

`materialsReceived` is true only for authoritative evidence such as:

- a nonempty prospectus/CIM URL;
- a completed broker-material delivery/upload request;
- a diligence checklist item explicitly marking CIM, teaser, financial package, P&L, tax returns, or balance sheet received;
- a secure document whose controlled document type or bounded filename metadata identifies a CIM, confidential information memorandum, teaser, offering memorandum/prospectus, financial package/financial statements, P&L, tax return, or balance sheet;
- an explicit existing diligence state such as `cim-received`, `financial-review`, or `lender-review` where materials necessarily have arrived.

An arbitrary secure document, generic note, NDA-only file, or freeform memo containing a coincidental word is insufficient by itself. `advancedBeyondBrokerOutreach` covers `loi-candidate` and other explicit existing pipeline/diligence authority where asking the broker for initial materials is no longer the next action.

The Command Center must use this shared result instead of `documents.length > 0` for `docs-received`. Follow-up projection and every send boundary use the same result. This is a targeted correctness extraction, not a new document subsystem.

## 13. Delivery and corrected-recipient behavior

- Initial provider accepted: enrollment may be available.
- Delivered: healthy.
- Accepted without delivery webhook: enrollment/review is allowed with an explicit warning because provider acceptance is the cadence anchor.
- Delayed: review may remain visible, but approval/send is blocked until the delay clears.
- Bounced, failed, complained, or suppressed: ordinary sequence stops.
- Ambiguous/unknown: no send and no retry until reconciliation establishes a definite result.

An existing accepted conversation is never redirected merely because a different current broker email appears. Recipient is locked to the durable request/communication recipient.

If the existing corrected-recipient flow creates and establishes an appropriate new durable request, that request starts `not-scheduled` with no copied schedule or Phase 3 marker. It requires its own Start Follow-Up Sequence action. The original request/history remains preserved.

## 14. Recipient cadence, transmission day/window, readiness, and pause

The due date does not supersede recipient policy. At preparation and immediately before provider work, enforce the existing recipient 24-hour cap, 30-day cap, suppression, and recipient-claim safety. If temporarily blocked, keep the original due timestamp; the item remains due/overdue.

Phase 3 transmissions occur Monday–Friday only and within the existing configured send window, currently 08:00–17:00 Pacific. The 9:00 AM due time prevents a first on-date send before 9:00; an overdue touch on a later weekday may be sent whenever the ordinary transmission window allows.

While the central CIM outreach pause is active:

- enrollment, scheduling, status, side-effect-free review, Stop Follow-Ups, inbound processing, and reconciliation remain allowed;
- Approve & Send and provider transmission are blocked;
- no drawer pause override is exposed.

The final authorization check defines the provider boundary. A pause/stop/terminal event committed before that boundary prevents the call. A provider call already authorized and in flight cannot be unsent; its result is reconciled, and the new terminal authority prevents every later touch.

## 15. Follow-Up 1–5 copy and message behavior

### 15.1 Common rules

Every follow-up continues the established conversation identity and uses:

```text
Subject: Re: CIM / NDA request for <business>
```

The server owns subject, text, HTML, template version, sender, reply-to, business details, and signature. Subject and body are read-only and selectable/copyable. The recipient is the durable accepted conversation recipient and cannot be changed from review.

The only editable text is the greeting:

- one required plain-text line;
- maximum 120 characters;
- no control characters or `<`/`>`;
- default from the best trusted existing conversation/contact first-name context, otherwise `Hello,`;
- changing it invalidates the current preview and requires Update Preview;
- Enter updates preview and never sends.

The message builder must accept a trusted server-only greeting option analogous to Phase 2. Browser text never bypasses parsing or becomes unsafely interpolated.

### 15.2 Copy progression

Existing deterministic intent for Follow-Ups 1–3 remains, subject to the trusted greeting extension. Follow-Ups 4 and 5 get distinct deterministic branches; `followUpNumber >= 3` must no longer collapse all later touches into Follow-Up 3 copy.

Follow-Up 4 intent: concise, courteous status check. Ask whether the opportunity remains active and request the CIM, teaser, NDA process, offering materials, or the correct next step. Do not repeat buyer claims or escalate urgency.

Candidate server-owned body intent:

> I wanted to follow up once more regarding `<business>`. If the opportunity is still active, I would appreciate the CIM, teaser, offering materials, or the next step in the NDA process. If the process has moved forward or the materials are not available, a brief status update would be helpful.

Follow-Up 5 intent: respectful close-the-loop note. Make one final materials/status request and make nonresponse easy without pressure.

Candidate server-owned body intent:

> I am checking in one final time regarding `<business>`. If the opportunity remains available, please send the CIM, teaser, offering materials, or let me know the NDA process. If it is no longer active or the process has moved on, no further action is needed and I will close the loop. Thank you for your time.

Final implementation copy may follow existing paragraph/HTML conventions, but its material meaning must match these intents, avoid unverified claims, remain non-aggressive, and preserve applicable compliance/opt-out behavior.

### 15.3 Retry exception

A definitive-failure retry must retransmit the exact persisted communication, not regenerate different content under the same identity. Therefore Review Retry displays the persisted recipient, greeting, subject, text, and HTML as read-only. Greeting editability applies to the first preparation of a follow-up number, not to an exact retry. Changing retry copy would require a new logical communication, which is deferred from MVP.

## 16. Deterministic identity and exact persistence

For Follow-Up N, N ∈ 1…5:

```text
communication ID = sha256("crm-communication:<request-id>:follow-up:<N>")
provider idempotency key = "deal-hunter-cim-<normalized-request-id>-follow-up-<N>"
```

The existing `buildCimEmailIdempotencyKey` pattern already supports arbitrary positive N and remains unchanged. Tracking/tag identity includes request ID, opportunity ID, submission ID, communication ID, and follow-up number.

Before any provider call, the executor persists exactly one outbound CIM communication with exact recipient, sender, reply-to, subject, text, sanitized HTML, template version, deterministic IDs, follow-up number, and bounded manual-approval audit. The generic CRM follow-up outbox is not used.

If the deterministic communication already exists:

- accepted proof triggers reconciliation without retransmission;
- a definitive failed state enters exact Review Retry;
- an ambiguous state exposes status/reconciliation only;
- a mismatched request/submission/recipient/body identity fails closed.

## 17. Side-effect-free preparation

Preparation may read canonical opportunity, request, request version, linked submission, disposition, prior communications, provider/delivery/reply state, shared materials state, suppression, cadence, pause, readiness, claims, due time, count, marker, and sender configuration. It may render and sign an in-memory review.

Preparation must not claim a request/recipient, create or update communication/activity/request state, change a due date, increment a count, consume an override, call the provider, create an outbox item, or schedule a retry.

Preparation is available only when the touch is due/overdue or in exact definitive-failure retry mode. A pause/cadence/delay/readiness blocker may be shown as a current send blocker without preventing safe review. Terminal, ambiguity, not-due, missing-authority, stopped, or completed state blocks preparation.

Viewer preparation is preview-only under existing visibility policy and returns no token or digest.

## 18. Signed proposal

Use a new Phase 3 token type/version and the Phase 2 15-minute principal-bound lifetime unless a shorter existing authority expiry applies. The signed payload binds at least:

- administrator principal ID;
- canonical opportunity ID;
- CIM request ID and request `updated_at`/authority revision;
- linked submission ID and authority/version;
- sequence marker version/mode/cadence/max and stop state;
- follow-up number and current `follow_up_count`;
- current `next_follow_up_at` and due eligibility;
- durable recipient and recipient provenance/conversation authority;
- initial communication identity;
- most recent relevant communication identity/version;
- existing deterministic communication state for retry/reconciliation;
- request, delivery, reply, materials, Pass/dismiss/archive, suppression/complaint, and relevant safety authority digests;
- sender display name/email and reply-to;
- greeting, subject, exact text, exact HTML, and template version;
- deterministic communication ID and provider idempotency key;
- whether the operation is first attempt or exact retry;
- proposal digest, prepared time, expiration, and nonce.

The public review omits signatures, raw metadata, provider payloads, and sensitive authority internals.

## 19. Approval contract and material staleness

The approval request body contains only:

```json
{
  "preparationToken": "<signed token>",
  "approvedProposalDigest": "<sha256 digest>"
}
```

Opportunity/request path parameters select a route but confer no authority. The browser does not submit follow-up number, count, recipient, message, sender, cadence, maximum, due time, suppression/pause override, provider identity, retry mode, or policy.

Approval verifies signature, type/version, expiration, principal, route binding, and digest before loading current authority. It reproduces the exact proposal or exact persisted retry communication and compares all material authority. Any change to canonical identity, request/submission version, count/number, due timestamp, recipient, prior communication, sender/reply-to, copy/template, reply/materials/Pass/archive/suppression/delivery/stop state, maximum, or deterministic identity requires re-preparation or closes the workflow.

Once approval is submitted, the client synchronously locks the action and discards its authority after the response/unknown outcome. Server replay can only converge on the same deterministic communication; it cannot authorize a different touch. A changed request version makes the old artifact stale. A retry requires a fresh proposal.

## 20. Durable executor seam

The existing single-request follow-up processor is refactored into one policy-aware durable executor, not duplicated, with two strictly separated callers:

- the automatic runner may invoke it only for unmarked legacy requests under existing legacy runner policy;
- the explicit administrator Phase 3 Approve Follow-Up endpoint may invoke it for a marked request only after verifying the signed proposal and reproducing a trusted exact approved-message context.

The automatic runner checks the marker before invoking the executor. It cannot accept an approval token/digest and cannot call the marked-request executor path under any condition. The durable executor does not itself expose signed-artifact verification to the scheduler/runner; signed-artifact verification belongs exclusively to the administrator approval service.

For the approved path, the executor order is:

1. receive the already verified, server-trusted approved-message context from the administrator approval service;
2. load and revalidate all authority and due state;
3. obtain a Phase 3-specific atomic request claim matching request version, marker, count, number, due timestamp, and active submission;
4. obtain the existing recipient claim;
5. render/reproduce the exact proposal and persist or load the deterministic communication;
6. reconcile if accepted proof already exists;
7. renew/revalidate the claim and reload terminal/material/pause/cadence/readiness authority;
8. if any authority changed, perform no provider call and durably preserve/close state without fabricating a provider failure;
9. call the existing prepared-message provider seam once using the persisted communication and existing idempotency key;
10. update the existing communication lifecycle;
11. atomically finalize or reconcile request state, count, activity, and next schedule;
12. release the recipient claim.

No frontend lock or in-memory lock is durable authority. Existing in-process single-flight remains an optimization only.

## 21. Atomic storage operations

Phase 3 requires equivalent SQLite and Supabase primitives. Names may follow repository conventions, but semantics are fixed.

### 21.1 Start Follow-Up Sequence

Atomic compare-and-set on request/submission authority. Requires expected request version and eligible unscheduled state; writes marker, schedule, state, and one activity together. It must not overwrite a concurrent reply, stop, archive, Pass, or active sequence.

### 21.2 Stop Follow-Ups

Atomic mutation that writes `follow_up_state = "stopped"`, clears `next_follow_up_at`, merges actor/time/optional bounded reason into `metadata.manualFollowUp`, and records one activity while preserving count/history. It invalidates open preparation through the request version.

Stop wins if it linearizes before the executor’s final provider authorization. If provider authorization is already in flight, Stop returns/enters authoritative Checking rather than claiming the email was cancelled; reconciliation records the actual result and prevents future touches.

### 21.3 Claim approved follow-up

A new/extended claim must require expected request version, manual marker, exact count/number, exact due timestamp, due-now condition, eligible status, and active submission. It may enter existing `follow_up_pending`; it creates no communication. The legacy automatic claim cannot by itself authorize a marked request.

### 21.4 Finalize accepted follow-up

An idempotent atomic finalizer locks current request/submission and identifies acceptance by deterministic communication ID + follow-up number. If not already counted, it increments once, stores acceptance, and schedules/finishes according to current terminal authority. If already counted, it returns the current record without another increment/activity. It preserves a concurrent reply/stop/archive and never reopens scheduling.

### 21.5 Finalize definitive failure/ambiguity

A definitive pre-acceptance failure keeps the original due timestamp, count, and number; sets existing failure vocabulary and exact retry eligibility; and schedules no automatic retry. Ambiguity clears the next schedule, enters existing ambiguous/stopped vocabulary, and permits only reconciliation/status.

### 21.6 Database migration assessment

No table or column schema change is expected. Existing request columns, metadata JSON, communications, activities, and claims are sufficient.

A **database-function migration is required** for Supabase because current RPCs do not atomically enforce Phase 3 marker/version/count/due approval claims or idempotent accepted finalization. The migration should extend `mutate_communications_with_crm_activity` with bounded Phase 3 operations and/or add narrowly named service-role-only RPCs. It must update `supabase/schema.sql`, revoke public/anon/authenticated execution, and grant only `service_role`, matching existing security posture.

SQLite receives equivalent immediate transactions in `server/storage/sqlite.js`. `server/storage/supabase.js` receives matching adapters and normalization. This distinction must be reported accurately: database-function migration yes; table/column migration no.

## 22. Definite failure, retry, ambiguity, and reconciliation

### 22.1 Definitive provider failure

If the exact communication exists and the provider definitively rejects before acceptance:

- count does not change;
- N remains current;
- no N+1 schedule is created;
- original due remains due/overdue;
- communication ID and provider idempotency key remain unchanged;
- UI shows Review Retry;
- retry uses the persisted exact communication and requires fresh review/approval/current checks;
- no automatic retry occurs.

### 22.2 Ambiguous result

No retransmission is permitted. Clear the active schedule according to existing stopped/ambiguous semantics, retain count, and show Outcome unresolved / Check Status. Do not show Retry, Send Again, or regeneration as a resend shortcut. Check Status is read-only.

If reconciliation later proves acceptance, count it exactly once and schedule the next touch if still allowed. If investigation establishes a definitive rejection, the state may move to exact Review Retry. Until one of those authorities exists, it remains no-resend.

### 22.3 Accepted-message reconciliation

If the provider accepted but communication/request/activity persistence partly failed, use the existing accepted-communication proof and deterministic identity. Never retransmit. The idempotent finalizer establishes the count, accepted timestamp, next due/completion, and activity exactly once while preserving any newer reply/stop/archive. Reconciliation remains allowed while pause is active.

### 22.4 Sequence completion

Sequence completion occurs only when Follow-Up 5 is durably accepted or an earlier terminal condition closes the workflow. Five accepted follow-ups set `follow_up_count = 5`, `follow_up_state = "completed"`, and `next_follow_up_at = null`. Completion creates no Follow-Up 6 communication, claim, or due date and does not delete the request or its history.

## 23. Duplicate approval, concurrency, and unknown client outcome

Double-click, browser replay, multiple tabs, two administrators, automatic-runner discovery, and retry races yield at most one provider call through:

- synchronous browser approval lock;
- principal-bound proposal and request-version staleness;
- deterministic communication ID;
- deterministic provider idempotency key;
- atomic request claim;
- recipient claim;
- exact communication lookup;
- idempotent acceptance finalization/reconciliation.

If the browser loses the approval response:

- do not retry automatically;
- invalidate the local approval token;
- reload authoritative opportunity detail;
- show Checking;
- Check Again performs GET/read-only status only;
- an accepted/failed/ambiguous communication determines the next action.

No Phase 3 idempotency table is added.

## 24. Race-safety matrix

| Race | Required result |
|---|---|
| reply/materials/Pass/archive/suppression/complaint after preparation, before approval | request version/authority mismatch; approval fails closed; schedule is cleared/closed where existing event mutation applies |
| same events after approval, before claim | Phase 3 claim CAS fails; zero communication/provider work |
| same events after communication persistence, before provider | final revalidation/claim renewal fails; zero provider calls; exact not-attempted communication remains auditable; sequence closes |
| global pause or cadence block in those windows | approval or final gate defers; original due retained; no provider call |
| Stop while review is open | atomic stop changes request version; old token fails; no provider call |
| another administrator approves same touch | one claim/communication/call; other result converges to current state or locked/checking |
| automatic runner discovers marked due request | unconditional `approval-required`/skip before invoking the marked-request executor path; zero claims, send-attempt communication/activity, or provider work; the runner cannot accept an approval artifact |
| definitive provider failure | count unchanged; same-number exact Review Retry; no automatic retry |
| ambiguous provider result | no schedule/no resend; reconciliation only |
| provider acceptance plus request/activity failure | accepted communication proof; reconcile without retransmission; count/schedule exactly once |
| provider acceptance and reply/stop finalize concurrently | accepted touch may be counted once, but terminal authority wins for scheduling; no later touch |

The final provider authorization is the linearization point for pause/stop/terminal races. State committed before it prevents the call. State arriving after an already-authorized external call cannot revoke that call, but it prevents all future sends and accepted outcome is reconciled honestly.

## 25. Opportunity Detail projection

Extend `brokerMaterials.existingRequest` (or a nested bounded `followUps` projection) with:

- enrolled/manual marker boolean and public policy version;
- maximum 5;
- accepted `followUpCount`;
- derived current number;
- next due timestamp;
- projected `not-enrolled`, `scheduled`, `due`, `overdue`, `retry`, `ambiguous`, `completed`, `stopped`, or `closed` state;
- completion/stopped reason safe for display;
- initial and prior accepted timestamps;
- current deterministic follow-up communication summary if present;
- exact retry eligibility;
- preparation blockers and current send blockers separately;
- reply/materials/Pass/archive terminal reason;
- cadence, delayed-delivery, readiness, transmission-window, and global-pause state.

Do not expose raw request metadata, provider response payloads, signatures/tokens, internal safety digests, or approval claims.

## 26. Broker Materials card and UI flow

Phase 3 stays inside the existing Broker Materials card in the Opportunity Drawer. Add a bounded **Follow-Ups** subcomponent after the initial-request lifecycle; do not duplicate the full CRM/CIM history.

Core states:

- **Not enrolled:** “Follow-ups are not scheduled.” + Start Follow-Up Sequence for an eligible administrator.
- **Future:** “Follow-Up X of 5 scheduled” + Pacific date/time + Stop Follow-Ups.
- **Due/overdue:** Review Follow-Up + Stop Follow-Ups.
- **Review:** opportunity context; durable recipient; initial request and prior touch timestamps; exact sender/subject/body; controlled greeting; warnings/blockers; expiration; Approve & Send Follow-Up.
- **Accepted:** “X of 5 follow-ups sent” + next scheduled due.
- **Failed:** Review Retry with exact persisted content.
- **Ambiguous:** Outcome unresolved / Check Status, explicit no-resend explanation.
- **Complete/stopped/closed:** durable final reason and no mutation controls except safe status/history navigation.

Stop Follow-Ups requires confirmation. An optional plain-text reason is allowed, trimmed to 240 characters; omission never blocks Stop. No restart is offered.

## 27. Mobile, keyboard, accessibility, and focus

Reuse the hardened Phase 2 pattern:

- full-width drawer on small screens and stacked review content;
- sticky mobile approval only for a valid prepared administrator proposal;
- safe-area padding and non-obscured controls/content;
- exact recipient adjacent to final action;
- Enter in greeting updates preview only; no Enter-to-send path;
- synchronous duplicate lock before async work;
- focus moves to review heading after successful preparation;
- failed preparation/regeneration focuses the alert;
- successful preview update preserves greeting/context focus;
- approval/unknown outcome moves focus to authoritative lifecycle/checking status;
- background detail refresh preserves valid focus and does not collapse an active review unnecessarily;
- stable polite live region for scheduled/due/sending/checking/result transitions;
- ambiguous state explicitly announces that resend is unavailable;
- all buttons have explicit `type="button"` unless genuinely submitting a form;
- subject/body remain keyboard-selectable and copyable.

## 28. Viewer behavior

A viewer may see sequence progress, scheduled date, due/overdue/completed/stopped state, safe blockers, permitted prior communication, preview-only follow-up under existing policy, and read-only authoritative status.

A viewer may not enroll, stop, edit greeting, receive token/digest, approve/send, retry, correct recipient, create claims, or trigger reconciliation through Check Status. Viewer routes remain read-only even if UI controls are bypassed.

## 29. CRM/CIM history

- Enrollment/scheduling: one existing CRM/CIM activity; no communication.
- Preparation: no durable history.
- Approved send: one exact existing CIM communication; the pre-provider persistence activity remains the existing audit convention.
- Provider events: update the same communication/request lifecycle.
- Stop: one activity.
- Reply: existing inbound communication/activity.
- Materials: existing document/pipeline activity/evidence.
- Acceptance scheduling: request/activity update according to current lifecycle convention, without an N+1 communication.

Do not create a generic CRM follow-up outbox duplicate, a second communication for the same logical send, or a Phase 3 history model.

## 30. Acquisition Command Center

No new pipeline stage is added. Follow-Up 1–5 is workflow detail.

Existing stages remain:

```text
cim-requested → broker-replied → docs-received → diligence → loi-candidate
```

The Command Center adopts the shared narrow acquisition-materials predicate. Merely having any document no longer implies `docs-received`; explicit diligence advancement remains authoritative according to existing stage precedence.

## 31. Historical compatibility

- Phase 2 manual requests remain unscheduled until explicit enrollment.
- Other historical unscheduled requests remain unscheduled.
- Unmarked legacy automatically scheduled requests retain legacy cadence/max semantics.
- Historical `follow_up_count` values are not rewritten.
- Historical completed/stopped requests are not reopened.
- Corrected-recipient requests do not inherit a prior marker/schedule.
- The legacy automatic configuration may retain its default max of 3 and `[48,72,96]` policy; a marked Phase 3 request selects the fixed five-touch/manual cadence policy inside the same executor.
- Old incident/history documentation describing three-touch sequences remains historical evidence and is not rewritten as though it described Phase 3.

## 32. Repository implementation map

This map is based on the immutable production merge, not the dirty working tree.

### 32.1 Reuse unchanged

- `server/utils/security.js`: signing, verification, canonical JSON, safe compare, and SHA-256 primitives.
- `server/services/delivery.js` `buildCimEmailIdempotencyKey`: already parameterizes request ID + arbitrary positive follow-up number.
- `server/services/communications.js`: exact outbound communication model, communication/activity persistence, lifecycle update conventions.
- `server/services/cimOpportunityIdentity.js`: canonical identity, recipient cadence/caps, recipient claim, suppression, transmission window, and central pause authority.
- Existing reply alias/event routing and email event lifecycle.
- Existing deterministic communication lookup, accepted proof, and provider prepared-message seam in `server/services/dealHunter.js`.
- Existing Pass/archive atomic schedule clearing and corrected-recipient workflow.
- `server/services/emailReadiness.js` readiness authority.
- Existing CRM/CIM history projection/rendering, including `CimRequestHistory` and communications history.
- Existing Opportunity Drawer, Phase 2 mobile/focus/unknown-outcome interaction patterns, and authenticated read/admin role separation.
- Existing request columns, metadata JSON, communications, activities, and recipient/request claims.

### 32.2 Narrow extensions

- `server/services/dealHunter.js`: factor the follow-up processor into a policy-aware executor; add manual-marker runner guard; use accepted-instant cadence; add final materials/terminal gate; prohibit initial override consumption; make failure retry human-only; make acceptance finalization idempotent/policy-aware.
- `server/services/delivery.js`: trusted greeting support for follow-ups; distinct deterministic branches/template version for 4 and 5; exact retry from persisted content.
- `server/services/dealHunterBrokerMaterials.js`: expose richer request/follow-up projection or delegate to the new manual-follow-up service; reuse Phase 2 token/input patterns.
- `server/services/dealHunterTriage.js`: include bounded follow-up projection in existing detail.
- `server/app.js`: add authenticated start/stop/prepare/approve routes; approval/admin mutation routes require full admin.
- `src/components/admin/BrokerMaterialsCard.jsx`: host the Follow-Ups section and preserve initial-request lifecycle.
- `src/components/admin/OpportunityDrawer.jsx` and `AcquisitionInbox.jsx`: wire Phase 3 state/actions and authoritative reload/unknown-outcome behavior.
- `server/services/acquisitionCommandCenter.js`: consume shared materials predicate instead of `documents.length > 0`.
- `server/storage/sqlite.js`, `server/storage/supabase.js`, and `supabase/schema.sql`: add parity primitives/RPC normalization.

### 32.3 Every production-code assumption tied to the current three-follow-up CIM policy

| Location | Existing assumption | Phase 3 treatment |
|---|---|---|
| `server/config.js` `dealHunter.cimFollowUp.maxCount` default | legacy max 3 | retain as legacy automatic policy; marked Phase 3 policy fixes max at 5 |
| `server/config.js` `DEAL_HUNTER_CIM_FOLLOW_UP_DELAYS_HOURS` default | `[48,72,96]` | retain for legacy; marked Phase 3 uses versioned calendar cadence |
| `server/services/dealHunter.js` `getCimFollowUpSettings` fallback | max 3 and `[48,72,96]` | retain legacy fallback; executor selects marker policy explicitly |
| `server/services/dealHunter.js` `nextCimFollowUpAt` | elapsed-hour sequence indexed by count and settings max | generalize policy input; use Phase 3 calendar function for marked requests |
| `server/services/dealHunter.js` max check/finalization | executor uses global settings max | use selected request policy; 5 only for marked requests |
| `server/services/delivery.js` `followUpNumber >= 3` | all touches 3+ reuse Follow-Up 3 copy | explicit 1, 2, 3, 4, 5 deterministic branches; reject out-of-range marked values |

The generic CRM Follow-Ups product has separate `maxTouches || 3` and `[48,72,96]` defaults in `server/services/followUpEmail.js`, `followUpRecommendations.js`, generic config, evaluation scripts, and its tests. Those do not cap the Deal Hunter CIM sequence and must not be changed for Phase 3.

Historical docs describing three-follow-up behavior remain historical. New Phase 3 documentation supersedes them only for marked operator-approved sequences.

### 32.4 Tests containing the three-touch CIM assumption

- `test/dealHunterFollowUps.test.js`: settings max 3, `[48,72,96]`, three cadence assertions, count-3 completion.
- `test/delivery.test.js`: iterates `[1,2,3]` for deterministic message coverage.
- `test/cimCommunicationLifecycle.test.js`: synthetic CIM follow-up settings with max 3 in lifecycle fixtures.

Extend these with marked Phase 3 cases; do not globally rewrite legacy expectations. Generic Follow-Ups tests using max 3 are out of Phase 3 scope.

### 32.5 Smallest new modules

1. `server/services/dealHunterManualFollowUps.js`: Phase 3 constants, cadence, marker/policy selection, authority/projection, strict inputs, enrollment/stop, preparation/approval, and approved-executor adapter. If this grows, keep pure cadence/projection helpers in the same module initially rather than creating a framework.
2. `server/services/acquisitionMaterials.js`: narrow shared materials/advanced-outreach predicate consumed by Command Center and manual follow-ups.
3. `src/components/admin/BrokerMaterialsFollowUps.jsx`: bounded UI state/review subsection, leaving `BrokerMaterialsCard` responsible for the overall initial-request card.

No second sequence executor, outbox service, history service, or campaign framework is introduced.

### 32.6 Recommended route surface

```text
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/start
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/stop
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/prepare
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/approve
```

Start accepts an empty strict body. Stop accepts only optional `reason`. Prepare accepts only optional `greeting`; retry preparation ignores edits and reproduces persisted content. Approve accepts only token + digest. Existing opportunity-detail GET is the status endpoint.

### 32.7 SQLite operations

Add immediate transactions/adapters for:

- enroll manual follow-up sequence with activity and expected version;
- stop manual follow-ups with activity and expected/current authority;
- claim exact approved follow-up using marker/count/due/version;
- finalize definitive failure/ambiguity without advancing count;
- idempotently finalize/reconcile provider acceptance and next scheduling with activity.

Existing communication insert/update and recipient claims are reused.

### 32.8 Supabase operations and migration

Add equivalent service-role-only RPC behavior, either as bounded new operations in `mutate_communications_with_crm_activity` plus a dedicated claim/finalizer or narrowly named RPCs. Update the Supabase adapter and schema snapshot. A database-function migration is required. No table/column migration is expected.

### 32.9 Tests to extend rather than replace

- `test/dealHunterFollowUps.test.js`: all weekday cadence, weekend rollover, 9:00 Pacific/DST, max 5, legacy policy separation, runner approval-required zero-side-effect guard.
- `test/delivery.test.js`: copy/identity/tags for 1–5, trusted greeting, out-of-range defense, no internal claims, exact retry.
- `test/dealHunterBrokerMaterials.test.js`: follow-up projection, authority, pause/cadence/material/delivery blockers.
- new focused `test/dealHunterManualFollowUps.test.js`: strict inputs, tokens, staleness, enrollment/stop/preparation/approval, retry, principal binding.
- `test/cimCommunicationLifecycle.test.js` and `test/emailCommunicationLifecycle.test.js`: claims, duplicate approvals, exact communication, ambiguous/accepted reconciliation, reply/suppression races.
- storage parity tests and `test/supabaseSecurity.test.js`: atomic operations, RPC grants, no schema expansion.
- `test/acquisitionCommandCenter.test.js`: narrow shared materials semantics and unchanged pipeline stages.
- `test/httpDealHunterTriageActions.test.js`: roles, strict bodies, status codes, approve body contract.
- `test-ui/BrokerMaterialsCard.test.jsx`, `OpportunityDrawer.test.jsx`, and `AcquisitionInbox.test.jsx`: all states, admin/viewer, mobile sticky, greeting refresh, no early send, Stop, unknown outcome, focus/live-region behavior.
- `test-ui/CimRequestHistory.test.jsx`: Follow-Up 4/5 labels and exact communication visibility if current generic rendering is insufficient.

## 33. Acceptance criteria

### 33.1 Enrollment and compatibility

- An accepted Phase 2 request remains unscheduled until an administrator explicitly starts the sequence.
- Enrollment creates no communication, claim, outbox, provider call, or count change.
- Enrollment persists the marker, correct first due, state, and one activity atomically in SQLite and Supabase.
- Ineligible, terminal, already scheduled, stopped, ambiguous, missing-acceptance, or count-5 requests cannot enroll.
- Existing unmarked legacy schedules/cadence remain unchanged.

### 33.2 Cadence and maximum

- Monday→Wednesday, Tuesday→Thursday, Wednesday→Friday, Thursday→Monday, and Friday→Monday are all tested.
- Every due is 9:00 AM America/Los_Angeles, independent of prior acceptance time.
- DST-boundary cases persist the correct UTC instant.
- The anchor is the immediately prior durable provider acceptance.
- Accepted touches schedule automatically through Follow-Up 5; acceptance of 5 completes; 6 cannot be built, claimed, or sent.

### 33.3 Human approval invariant

- No due date, scheduler, Operations run, feature flag, config change, or supplied approval artifact can cause the automatic runner to send a marked request.
- Automatic discovery unconditionally returns approval-required/skip with zero request transmission claims, recipient claims, send-attempt communications, send-attempt activities, or provider calls.
- Only the explicit administrator Approve Follow-Up endpoint verifies signed approval artifacts and invokes the marked-request durable executor path.
- Before due, no Review action appears and both prepare/approve fail closed.
- Every successful provider call traces to a current, principal-bound, unexpired exact approval.

### 33.4 Message and identity

- Recipient is locked; subject/body are server-owned/read-only; greeting is the only first-attempt edit.
- Greeting staleness requires Update Preview; Enter never sends.
- Follow-Ups 4/5 have deterministic distinct copy and preserve the subject/thread/idempotency conventions.
- Each N uses one deterministic communication and provider key; exact retry reuses both and the persisted exact content.

### 33.5 Count, failure, and reconciliation

- Preparation, approval click, communication insert, provider start, and definitive failure do not increment count.
- Provider acceptance/reconciliation increments exactly once.
- Definitive failure remains on N and requires Review Retry; no auto retry or N+1 schedule.
- Ambiguity exposes no resend and schedules nothing until resolved.
- Provider acceptance plus persistence failure reconciles without retransmission and schedules/finishes exactly once.

### 33.6 Stops and races

- Reply, materials, Pass, archive, suppression/complaint/opt-out, terminal delivery, advanced pipeline, Stop, and max count prevent future sends.
- The shared materials predicate does not stop on an arbitrary document.
- Delayed/cadence/pause/window/readiness blockers retain due/overdue rather than moving the due date.
- Stop is permanent and preserves count/history.
- All listed prepare/approval/claim/pre-provider races fail closed or reconcile without retransmission.
- Duplicate/concurrent approvals produce at most one provider call.

### 33.7 UI, roles, and history

- Broker Materials displays not-enrolled, future, due, overdue, review, retry, ambiguous, accepted-next, complete, stopped, and terminal-closed states.
- Viewer receives no mutation controls or approval authority.
- Mobile sticky action, focus recovery, live regions, unknown outcome, and keyboard behavior match Phase 2 safety.
- Scheduling/Stop use activity; sending uses one exact CIM communication; no generic outbox or duplicate history appears.

### 33.8 Storage and production gates

- SQLite and Supabase behavior is parity-tested.
- Supabase RPCs remain service-role-only.
- No table/column change exists unless a later implementation discovery is raised for product/engineering review.
- Automatic follow-up flag remains false, global pause remains enforceable at the provider boundary, and automation stage remains Stage 1 for deployment.

## 34. Explicit deferred scope

- holidays and brokerage-specific calendars;
- Follow-Up 6+, unlimited sequences, campaign analytics, A/B copy, or adaptive cadence;
- early send, schedule editing, snooze, skip, restart, or re-enrollment;
- batch enrollment or batch approval;
- arbitrary recipient correction inside an accepted conversation;
- subject/body editing or changed-copy retry under the same identity;
- automatic retries or automated ambiguity resolution;
- Phase 3 pause/cadence/suppression override;
- new acquisition pipeline stage;
- generic Follow-Ups Workspace integration or outbox duplication;
- proactive due notifications, a new due queue, or a new dashboard counter beyond the Opportunity Drawer;
- holiday-aware “business day” language;
- migration of historical requests into the marker.

## 35. Engineering estimate

Estimated implementation effort is **13–17 focused engineering days**, excluding production observation time and any unrelated release work:

| Area | Estimate |
|---|---:|
| Shared materials predicate, Phase 3 policy/cadence/projection, 4/5 copy | 2–3 days |
| Atomic SQLite/Supabase operations and database-function migration | 3–4 days |
| Signed preparation/approval, executor guard/refactor, retries/reconciliation/races | 4–5 days |
| Routes, Broker Materials UI, mobile/accessibility/viewer wiring | 2–3 days |
| Cross-provider, service, HTTP, UI, regression, and release-gate verification | 2 days |

Risk is concentrated in concurrency/finalization and the shared materials authority, not in rendering Follow-Ups 4/5.

## 36. Recommended bounded implementation decomposition

This is a delivery decomposition, not an implementation plan. Keep it to four independently testable commits/tasks:

1. **Phase 3 policy and acquisition authority:** shared narrow acquisition-materials predicate; Phase 3 marker/policy; exact +2-calendar-day/weekend-rollover/09:00 PT cadence; follow-up numbering 1–5; deterministic communication/idempotency identities; explicit Follow-Up 4/5 message branches; due/overdue/status projections; pure/unit tests. No routes or durable sending.
2. **Atomic persistence and provider parity:** SQLite Start Sequence atomic mutation; SQLite Stop Follow-Ups atomic mutation; SQLite accepted-follow-up finalization plus next-date scheduling; equivalent Supabase service-role RPC/function behavior; required database-function migration; concurrency/conflict/idempotency/provider-parity tests. No UI and no human approval route.
3. **Human review and durable follow-up execution:** Start/Stop/Prepare/Approve services and HTTP routes; principal-bound signed preparation; exact greeting/subject/body behavior; early-send prevention; material-staleness revalidation; automatic-runner unconditional approval-required boundary for manual sequences; trusted approved-message seam into the existing follow-up executor; exact retry after definitive pre-acceptance failure; ambiguity/no-retransmission; accepted-message reconciliation; and current stop-condition/race checks. No frontend.
4. **Broker Materials UI and final Phase 3 acceptance:** Follow-Ups subsection in the existing Broker Materials card; Start Follow-Up Sequence; future scheduled/due/overdue/completed/stopped states; Review Follow-Up; Stop Follow-Ups; exact preview/greeting update/Approve & Send Follow-Up; Checking/unknown-client-outcome; viewer/read-only behavior; mobile sticky approval; accessibility/focus; browser acceptance; and full regression/build/provider-parity verification.

Each task must preserve a working closed-production boundary and may be reviewed independently.

## 37. Remaining product decisions

No product decision is currently required to proceed to implementation planning. The locked brief resolves maximum count, cadence, weekday behavior, due time, enrollment, approval, automatic-send prohibition, Stop semantics, and editability.

The candidate wording for Follow-Ups 4 and 5 is intentionally implementation-polishable within the fixed intent and safety constraints. That is copy review, not a blocking product architecture decision.
