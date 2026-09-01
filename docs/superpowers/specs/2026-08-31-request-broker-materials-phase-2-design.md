# Request Broker Materials — Phase 2 Design

**Status:** Proposed implementation specification; all product-design sections approved in chat

**Date:** 2026-08-31

**Repository baseline inspected:** `origin/main` at `c3043b3dca68701e6d1d9918544681d8ba5d3872`

**Implementation status:** Not implemented by this specification

## 1. Purpose

Phase 2 adds a human-reviewed **Request Broker Materials** workflow to the Phase 1 Acquisition Inbox Opportunity Drawer.

An administrator who has explicitly chosen **Pursue** may:

1. Open one compact Broker Materials card inside the Opportunity Drawer.
2. Prepare a side-effect-free, server-generated request using current canonical opportunity and broker-contact authority.
3. Review the exact recipient, provenance, sender, greeting, subject, and body.
4. Adjust only the recipient selection and greeting within the approved authority rules.
5. Explicitly select **Approve & Send**.
6. Cross the existing durable CIM execution boundary exactly once.
7. Reload authoritative Opportunity Detail and display the existing request, delivery, communication, and reply lifecycle.

The user-facing name is **Request Broker Materials**. The existing internal request type remains `cim_request`.

Phase 2 is a per-opportunity adapter in the existing Opportunity Drawer. It is not a second outreach system.

## 2. Explicit non-goals

Phase 2 does not add:

- Automatic broker outreach.
- Stage 2 eligibility changes or Stage 2 activation changes.
- Follow-up generation, scheduling, copy, controls, or automation.
- A draft table or durable preparation record.
- A parallel CIM request table.
- A new request lifecycle enum.
- A new provider integration.
- A new outbox.
- A second communication-persistence path.
- A second canonical-claim or idempotency implementation.
- A second suppression or cadence implementation.
- A second reconciliation system.
- A new user or administrator identity model.
- Free-form subject or body editing.
- A wizard, nested modal, second drawer, or separate Phase 2 workspace.
- An automatic pipeline mutation during preparation.
- A frontend-derived durable request or delivery state.
- A “send again” action after sent, ambiguous, or replied outcomes.

Preparation must not create or mutate any of the following:

- CIM request
- Canonical opportunity send claim
- Recipient claim
- CRM communication
- Outbox entry
- Pipeline state
- Provider state
- Follow-up state
- Source import
- Opportunity score
- Opportunity facts

After approval, existing downstream projections may derive existing pipeline state from the durable CIM request. Phase 2 itself does not write a parallel pipeline transition.

## 3. Approach 1 architecture

Phase 2 uses **Approach 1: a per-opportunity adapter inside the Opportunity Drawer**.

```text
Acquisition Inbox
  -> Opportunity Drawer
      -> Broker Materials card
          -> side-effect-free preparation adapter
          -> exact signed review artifact
          -> explicit Approve & Send
              -> existing durable CIM execution service
                  -> existing canonical and recipient claims
                  -> existing request and communication persistence
                  -> existing recipient cadence and suppression policy
                  -> existing global pause and provider-readiness policy
                  -> existing provider execution
                  -> existing ambiguity and reconciliation behavior
              -> authoritative Opportunity Detail reload
                  -> existing CIM lifecycle and communication history
```

The Phase 2 adapter owns contract translation, preparation signing, administrator-principal binding, and UI-facing error mapping. It does not own sending policy or durable execution.

### 3.1 Component boundaries

| Component | Responsibility |
|---|---|
| Acquisition Inbox | Opens the current canonical opportunity and owns authoritative detail reloads. |
| Opportunity Drawer | Hosts the compact Broker Materials card and existing Pursue / Watch / Pass controls. |
| Broker Materials card | Displays derived state, selects an authoritative contact, edits greeting, reviews exact copy, and submits explicit approval. |
| Preparation service | Reads current authority, derives manual Stage 1 warnings/blockers, resolves contact references, builds exact copy, and signs a short-lived artifact without durable writes. |
| Approval adapter | Verifies the signed transport contract and current authenticated administrator principal, then calls the existing durable CIM execution boundary once. |
| Existing durable CIM service | Owns all final policy checks, claims, idempotency, persistence, provider work, ambiguity, retries, and reconciliation. |
| Opportunity Detail projection | Returns authoritative opportunity, contacts, request status, delivery status, communications, and reply state after every mutation or status check. |

## 4. Terminology and existing lifecycle

- **Manual Stage 1:** A human explicitly Pursues, prepares, reviews, and approves one initial broker-materials request.
- **Automated / Stage 2:** Existing stricter automation eligibility and durable Stage 2 authorization. This specification does not relax it.
- **Preparation:** A side-effect-free read and short-lived signed artifact. It is not a request or draft.
- **Durable result:** An existing CIM request/communication now owns the opportunity, regardless of whether its lifecycle is sent, failed, ambiguous, or a delivery issue.
- **Warning:** Information shown for human judgment that does not block manual Stage 1 preparation or sending.
- **Preparation blocker:** A condition that prevents creation of an approvable exact proposal.
- **Send-only blocker:** A condition that permits review but prevents final sending.
- **Contact reference:** A server-generated opaque reference to a current authoritative contact. It is never an array position or raw email.

Phase 2 preserves the existing request lifecycle vocabulary, including existing `status`, `request_state`, `delivery_state`, and `follow_up_state` values. No `phase2Status` or equivalent field is introduced.

## 5. Pursue requirement

Only a current, actionable opportunity that has been explicitly **Pursued** may produce an approvable manual Stage 1 preparation.

Phase 1 already maps the Pursue action through:

```text
POST /api/admin/deal-hunter/triage/:opportunityId/action
{ action: "pursue" }
```

to the current operator-decision representation (`priority: high`, marked reviewed). Phase 2 reuses that server-owned decision; it does not add a second Pursue flag.

For Phase 2, the server derives Pursued from the current Phase 1 action semantics, including:

- Current canonical opportunity exists.
- Current operator decision represents Pursue.
- Review is current rather than changed since the Pursue decision.
- Opportunity is not Passed/dismissed.
- Opportunity is not removed or otherwise non-actionable.

Watch does not authorize preparation. Pass removes preparation and shows the existing disposition. The browser never submits a boolean such as `isPursued` as authority.

## 6. Manual Stage 1 policy versus automated policy

The current shared CIM eligibility code hard-blocks a score below 75 and missing annual-profit data. Phase 2 requires a minimal policy split.

```text
manual_stage_1
automated
```

The policy is selected internally by the server entry point. It is not a client field.

| Condition | Manual Stage 1 | Automated / Stage 2 |
|---|---|---|
| Explicit Pursue | Required | Does not replace Stage 2 authorization |
| Current canonical authority | Required | Required |
| Score below 75 | Warning | Existing hard blocker remains |
| Annual profit incomplete | Warning | Existing hard blocker remains |
| Human review and approval | Required | Existing Stage 2 behavior unchanged |

The safest implementation is a structured eligibility result with shared common gates and policy-specific threshold handling. Existing automated callers keep the strict policy as their default.

The manual policy must be used by the existing durable CIM execution service at final approval. The adapter may call the same evaluator to explain the UI, but the adapter's earlier result is not final sending authority.

### 6.1 Manual warnings

Presentation warning codes:

```text
below_automated_cim_score_threshold
annual_profit_incomplete
```

Warnings:

- Appear near Opportunity context.
- State that automated eligibility remains stricter.
- Do not disable preparation.
- Do not disable Approve & Send.
- Are included in the signed warning context.
- May become stale if their displayed value changes.

A warning-context change returns `preparation_stale`; it never becomes a new hard manual Stage 1 score/profit blocker.

## 7. Derived eligibility and blocker model

No durable eligibility enum is added. The server returns or derives:

```ts
{
  existingRequest,
  preparationBlockers,
  sendBlockers,
  warnings,
  recipientOptions
}
```

The presentation branches are:

```text
existingRequest present
  -> existing-request lifecycle card

else preparationBlockers non-empty
  -> visible Blocked card

else
  -> Ready to prepare
```

After preparation:

```text
valid administrator-bound preparation
and no current send-only blocker
  -> Approve & Send enabled
```

### 7.1 Preparation blockers

Preparation is unavailable when any of these conditions applies:

- Opportunity is not explicitly Pursued.
- Canonical opportunity ID is missing.
- Canonical current authority is ambiguous or unavailable.
- Opportunity is superseded, non-current, removed, Passed, dismissed, or otherwise non-actionable.
- Required source authority cannot establish current opportunity truth.
- Current required authority cannot resolve the canonical opportunity.
- No usable authoritative broker recipient exists.
- Selected contact reference is invalid, stale, unresolvable, or not current.
- Linked CRM ownership is archived or otherwise blocked by the existing durable path.
- Existing request/history storage cannot be read well enough to rule out an existing owner.
- An existing durable request or active request claim already owns the canonical opportunity or a known alias.

Low score and incomplete annual profit are not in this list for manual Stage 1.

A mutable deal key is not durable identity. A deal-key or alias change may invalidate an old preparation, but a fresh preparation remains allowed when canonical authority is unambiguous. The server resolves the current tracking alias from canonical authority. A client-supplied deal key is never required by the new preparation or approval contract.

### 7.2 Send-only blockers

These conditions permit harmless preparation/review but disable sending:

- Global CIM outreach pause.
- Recipient cadence cap.
- Active recipient suppression.
- Provider not production-ready or unavailable.
- Administrator write authorization unavailable.
- Another current send claim is in progress.
- A temporary final authority/readiness condition prevents the existing service from proceeding.

Send-only blockers are explanatory previews only until the existing durable CIM service evaluates them at approval time.

### 7.3 Global pause

Global pause does not block preparation. The card displays **Ready · Sending paused**, permits exact review, and disables Approve & Send. The existing durable service remains the final pause authority.

## 8. Recipient authority

A recipient is usable when it is a syntactically valid current address with one of these provenances:

| Provenance | Additional operator verification required? | Authority requirement |
|---|---:|---|
| Current trusted structured source | No | Contact is attached to the current canonical opportunity through admitted current source authority. |
| Current CRM contact | No | Contact belongs to the current, non-archived CRM record linked to the canonical opportunity. |
| Previously operator-verified fact | No additional verification | Current `broker_email` operator fact has `verified: true`. |
| Brand-new manual email | Yes | Must be saved through the existing verified opportunity-fact flow before preparation. |
| Unverified manual email | Yes | Not selectable; show Add / Verify Broker Email. |

The contact resolver must not treat an unverified operator fact as usable merely because operator facts have normal effective-fact precedence.

### 8.1 Stable opaque contact references

Every selectable option has a server-generated `recipientContactRef`.

The reference must be:

- Opaque to the frontend.
- Bound to canonical opportunity ID.
- Bound to contact provenance.
- Bound to the current authoritative contact identity.
- Stable across array reordering and rerenders.
- Revalidated during preparation and final durable execution.
- Non-forgeable by the browser.

It must not be:

- An array index.
- The email address.
- A frontend UUID.
- A display name.
- A client-constructed concatenation.

Preferred underlying identities:

- Operator fact: existing fact ID.
- CRM: existing submission/contact authority plus broker-email field identity.
- Structured source: source ID, stable source record ID, field identity, and current authority revision.

When a trusted source does not expose a standalone contact ID, the server may issue a signed deterministic reference over canonical opportunity ID, source ID, source record ID, normalized email, provenance, and authority revision. This does not require a new contacts table.

Changing or removing the authoritative contact makes an old reference stale. The new current contact receives a new current reference.

### 8.2 Missing email

The Broker Materials card remains visible but blocked. It provides an active **Add / Verify Broker Email** route to the existing verified-fact flow.

The operator must:

1. Enter the new email as `broker_email`.
2. Explicitly verify and save it through the existing fact route.
3. Reload authoritative Opportunity Detail.
4. Prepare a fresh request using the resulting server contact reference.

The preparation endpoint never accepts a raw replacement email.

### 8.3 Multiple contacts

The server may choose a recipient automatically only when:

- Exactly one usable current contact exists; or
- One contact is explicitly primary in its trusted source or CRM authority.

The server must not infer a primary contact from array order, recency alone, domain, name similarity, or an arbitrary provenance ranking.

When multiple usable contacts exist without an explicit primary, preparation returns `recipient_selection_required` with the options and no approvable token. The administrator selects a contact reference and prepares again.

## 9. Side-effect-free preparation contract

### 9.1 Route

Add a canonical opportunity route adjacent to current triage routes:

```text
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/prepare
```

The route uses existing `requireAdminAccess` so viewers can receive a permitted preview-only representation. Only an administrator receives approval authority.

### 9.2 Input

```ts
type PrepareBrokerMaterialsInput = {
  recipientContactRef?: string;
  greeting?: string;
};
```

The route rejects unknown fields. It does not accept:

- Raw email
- Subject
- Body
- Sender
- Deal key
- Score
- Annual profit
- Eligibility booleans
- Pause, cadence, or suppression overrides
- Follow-up settings
- Pipeline fields

### 9.3 Greeting rules

The greeting is the only editable message text.

- Plain text only.
- One logical line.
- Trim leading/trailing whitespace.
- Reject CR, LF, null, and control characters.
- Maximum 120 characters.
- Never interpret as HTML.

Default greeting:

```text
explicit structured firstName exists -> “Hi {firstName},”
otherwise -> “Hello,”
```

The server does not parse or guess a first name from an arbitrary display name.

### 9.4 Preparation behavior

Preparation may:

- Read current canonical opportunity, score, source observations, facts, CRM linkage, requests, contacts, pause state, cadence, suppression, and provider readiness.
- Resolve authoritative contact references.
- Evaluate explanatory blockers and warnings through shared read-only evaluators.
- Build exact message copy.
- Compute deterministic prospective request/communication identifiers already used by the durable service, without claiming or persisting them.
- Generate an in-memory signed artifact.

Preparation must not:

- Call `buildDailyDealReview` if doing so performs imports, scoring, reconciliation, or writes.
- Persist source observations.
- Record metrics that mutate safety state.
- Consume a cadence override.
- Claim an opportunity or recipient.
- Create a request or communication.
- Call the provider.
- Schedule a follow-up.

### 9.5 Administrator response

```ts
type PrepareBrokerMaterialsResponse = {
  success: true;
  previewOnly: false;
  preparationToken: string;
  proposalDigest: string;
  preparedAt: string;
  expiresAt: string;
  review: {
    opportunity: {
      canonicalOpportunityId: string;
      displayName: string;
      sourceLabel: string;
      listingUrl?: string;
      pursued: true;
      current: true;
      score?: number;
      automatedScoreThreshold: number;
      annualProfit?: number;
    };
    recipient: {
      contactRef: string;
      displayName?: string;
      email: string;
      provenance: RecipientProvenance;
    };
    sender: {
      displayName: string;
      email: string;
      replyTo?: string;
    };
    message: {
      requestType: "cim_request";
      channel: "email";
      greeting: string;
      subject: string;
      body: string;
    };
  };
  recipientOptions: RecipientOption[];
  warnings: ManualStage1Warning[];
  sendBlockers: PresentationBlocker[];
};
```

`message.body` is the complete exact plain-text body, including greeting. Subject and body are read-only.

The provider HTML is generated from the same canonical structured copy and is included in the signed proposal. Automated tests must prove that manual Stage 1 HTML contains no substantive text absent from the reviewed plain-text body.

### 9.6 Viewer response

A viewer may receive generated copy only when existing read permissions allow it. The response is preview-only:

```ts
type ViewerBrokerMaterialsPreview = {
  success: true;
  previewOnly: true;
  review: BrokerMaterialsReview;
  recipientOptions: ReadonlyRecipientOption[];
  warnings: ManualStage1Warning[];
  sendBlockers: [{ code: "administrator_required"; message: string }];
};
```

The viewer response omits:

- `preparationToken`
- `proposalDigest`
- Any approval nonce
- Any transferable approval authority

Recipient and greeting controls are read-only in viewer mode. An administrator must open the opportunity and prepare a new artifact bound to the administrator principal.

If multiple contacts require an administrator's explicit selection, the viewer may inspect their provenance but does not receive an exact message preview or choose an approval recipient. Preview-only copy is available to a viewer only when current authority identifies one recipient without inference.

## 10. Message generation

Phase 2 reuses `buildDealHunterCimRequestEmail` as the message-copy source, extended narrowly to support the approved greeting and exact approved-copy seam.

The existing user-facing subject and body remain server-owned. Phase 2 does not add free-form editing or follow-up language.

Because the existing request ID is deterministic from canonical opportunity ID and recipient, preparation may calculate the same prospective request ID and reply-to address without creating a durable request. Approval must prove the durable service resolved the same identifiers before sending.

Add an explicit template version, for example:

```text
deal-hunter-cim-manual-stage1-v1
```

Changing the template version invalidates outstanding preparations.

## 11. Signed preparation and proposal digest

Phase 2 reuses `signPayload`, `verifySignedPayload`, and `sha256` from `server/utils/security.js` and the existing server secret boundary. It does not add a token database.

### 11.1 Expiration

The maximum lifetime is 15 minutes:

```text
expiresAt = preparedAt + 15 minutes
```

If required source authority expires sooner, use the earlier time. Expiration creates no request and no failed lifecycle. It requires regeneration.

### 11.2 Principal binding

The token binds to `session.principal_id` from the existing admin session. It does not create a new user identity.

Only `role === "admin"` may receive an approvable token or call approval. Viewer principal IDs never receive approval authority.

Audit display may continue using the existing session username, while the security binding uses the stable principal ID.

### 11.3 Signed claims

```ts
type SignedBrokerMaterialsPreparation = {
  typ: "deal-hunter-broker-materials-preparation";
  version: 1;
  intent: "manual_stage_1";
  requestType: "cim_request";

  administratorPrincipalId: string;
  canonicalOpportunityId: string;
  authorityRevision: string;
  aliasResolutionFingerprint: string;

  prospectiveRequestId: string;
  recipientContactRef: string;
  recipientEmail: string;
  recipientProvenanceFingerprint: string;

  senderEmail: string;
  senderDisplayName: string;
  replyTo?: string;
  greeting: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  templateVersion: string;

  warningContext: ManualStage1WarningContext[];
  proposalDigest: string;
  nonce: string;
  preparedAt: string;
  exp: number;
};
```

### 11.4 Proposal digest

The digest is:

```text
sha256(stableCanonicalJson(approvalBoundPayload))
```

The approval-bound payload includes:

- Canonical opportunity ID
- Current authority revision
- Relevant alias/deal-key resolution fingerprint
- Prospective deterministic request identity
- Contact reference, email, and provenance fingerprint
- Sender and reply-to
- Greeting
- Subject
- Exact text and HTML
- Template version
- Displayed score/profit warning codes and values

## 12. Material staleness

An outstanding preparation becomes `preparation_stale` when any approval-bound material fact changes:

- Token expires.
- Authenticated administrator principal differs.
- Opportunity is no longer current or Pursued.
- Opportunity is Passed, dismissed, removed, or becomes non-actionable.
- Canonical identity becomes ambiguous.
- Current source authority changes materially or cannot be revalidated.
- Relevant alias/deal-key resolution changes.
- Selected contact reference no longer resolves.
- Recipient email or provenance changes.
- CRM ownership becomes archived.
- Sender or reply-to changes.
- Greeting, subject, text, HTML, or template version changes.
- Score/profit warning context changes.

A mutable deal-key/alias change is not a permanent blocker when canonical authority remains unambiguous. It invalidates the old preparation and permits a fresh one.

If another durable request or canonical claim owns the opportunity, existing-request ownership takes precedence over staleness: discard the preparation and return or reload the existing lifecycle. Use a conflict only when the current owner cannot yet be resolved safely.

Global pause, cadence, suppression, and provider readiness do not change the copy. They disable sending but do not require regeneration while the token remains otherwise valid.

## 13. Approval contract

### 13.1 Route

```text
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/approve
```

This route uses existing `requireAdmin`, not `requireAdminAccess`.

### 13.2 Input

```ts
type ApproveBrokerMaterialsInput = {
  preparationToken: string;
  approvedProposalDigest: string;
};
```

The route rejects recipient, greeting, subject, body, deal key, policy, or override fields. The authenticated session supplies `principal_id`, username, and role.

### 13.3 Adapter responsibility

The approval adapter performs only:

1. Strict input parsing.
2. Signature/version/expiration verification.
3. Principal-ID and route opportunity-ID binding.
4. Digest equality verification.
5. Translation of signed claims into the existing CIM service's approved-message input.
6. One call across the existing durable CIM execution boundary.
7. Translation of the existing service result into the drawer API response.

It does not independently reimplement currentness, duplicate ownership, cadence, suppression, pause, provider readiness, durable claims, persistence, ambiguity, or reconciliation.

Shared evaluators may be called during preparation to explain likely blockers. The existing durable CIM execution service remains final authority at approval.

## 14. Existing durable CIM execution seam

The current durable executor is the private `sendCimRequestForScoredDeal` flow reached by `sendDealHunterCimRequest`. It already owns:

- Global outreach gate
- Canonical identity resolution
- Required-source revalidation
- Current recipient policy
- Existing request lookup across canonical ID and aliases
- Recipient claim
- Canonical opportunity claim
- Request claim
- CRM submission linkage
- Communication persistence before provider work
- Provider execution through `sendPreparedMessage`
- Definite failure persistence
- Ambiguous outcome persistence
- Accepted-communication reconciliation without retransmission
- Final policy rechecks before provider work
- Corrected-recipient safeguards

Phase 2 must extend this existing executor rather than create another sending service.

### 14.1 Approved message seam

The minimal service extension accepts a validated approved manual Stage 1 proposal at the existing message-construction seam:

```text
existing automated/default message builder --+
existing legacy manual snapshot ------------+--> existing durable CIM executor
approved Phase 2 exact proposal ------------+
```

The executor still creates the deterministic request and communication identities, claims them, persists the communication, and calls the provider. For Phase 2, it verifies that those resolved identities and the persisted copy equal the approved proposal.

The adapter must not call `sendPreparedMessage`, `createCommunicationWithActivity`, or storage claim functions directly.

### 14.2 Manual policy inside the executor

The durable executor receives an internal manual Stage 1 policy marker from its trusted server caller. It uses the shared evaluator that demotes low score and incomplete annual profit to warnings. Automated and legacy Stage 2 callers retain strict policy.

The client cannot select the policy.

### 14.3 No Phase 2 follow-up scheduling

The Phase 2 approved initial request must not schedule a follow-up.

Within the existing executor, manual Stage 1 approval sets existing fields to their existing unscheduled representation:

```text
next_follow_up_at = null
follow_up_state = 'not-scheduled'
```

No new follow-up state is introduced. Existing requests created by older flows are not rewritten. A retry or corrected-recipient send descended from a Phase 2 request preserves its no-follow-up policy unless a future Phase 3 feature explicitly authorizes follow-ups.

## 15. Durable-result response

If a durable CIM request or communication exists, the adapter must return an unmistakable durable result even when the lifecycle is `failed`, `ambiguous`, `delivery_issue`, or another non-success outcome.

```ts
type DurableApprovalResponse = {
  success: true;
  canonicalOpportunityId: string;
  durableResult: {
    cimRequest: ExistingCimRequestProjection;
  };
};
```

`success: true` means the approval command reached a durable request result; it does not mean provider delivery succeeded. Delivery meaning comes exclusively from the existing request projection.

Any existing service result containing a durable request is normalized into this envelope instead of an unstructured HTTP 5xx that could invite browser retransmission.

The presence of `durableResult` permanently consumes the browser's preparation. The frontend never restores Approve & Send for it.

Pre-claim contract or policy errors return no `durableResult`.

## 16. Response and error behavior

| Domain result | API/UI behavior |
|---|---|
| Durable pending/sent/logged/failed/ambiguous/delivery_issue/responded request | Return `durableResult`; discard preparation; reload authoritative detail. |
| Same approval already processed | Return the existing durable result idempotently. |
| Another request owns canonical opportunity | Return or identify existing request; discard preparation; reload existing lifecycle. |
| Expired/materially changed proposal | `preparation_stale`; discard token; reload; offer Regenerate if still eligible. |
| Warning context changed | `preparation_stale`; fresh preparation remains manually eligible. |
| Global pause/cadence/suppression/readiness | Preserve preview only when server confirms it remains current; disable send; reload blockers. |
| Invalid payload/signature/principal mismatch | Reject before durable execution; no provider call. |
| Definite pre-claim infrastructure failure | Reload authoritative detail before allowing another attempt. |
| No browser response | Lock in Checking; no automatic retry; authoritative refresh required. |

Existing domain reason codes should be passed through when stable. Phase 2 may group them for presentation but does not add durable lifecycle states.

## 17. Timeout and unknown client outcome

If approval times out, the connection drops, or the browser loses the response:

1. Do not retry automatically.
2. Do not restore Approve & Send.
3. Lock the card in **Checking**.
4. Reload authoritative Opportunity Detail by canonical opportunity ID.
5. Let existing request/idempotency/reconciliation state determine the next action.

If refresh fails, show **Check Again**, not **Try Sending Again**.

If no request is immediately visible, the browser still does not infer that no provider work occurred. Approval becomes available again only after the existing server boundary establishes a definite safe pre-attempt outcome.

## 18. Reconciliation ownership

Existing CIM, communication, delivery-event, and reply services own all reconciliation:

- Provider acceptance
- Delivery confirmation or delay
- Bounce/failure/complaint/suppression
- Reply association
- Accepted communication reconciliation without retransmission
- Ambiguous provider outcomes
- Corrected-recipient retry eligibility

The Phase 2 adapter does not poll the provider, write delivery state, ingest webhooks, or create a reconciliation job.

A viewer's **Check Request Status** performs only the existing GET of authoritative Opportunity Detail/history. It does not invoke a reconciliation mutation. Any existing reconciliation operation retains its current authorization boundary.

## 19. Authoritative Opportunity Detail refresh

The existing route remains the authoritative reload:

```text
GET /api/admin/deal-hunter/triage/:opportunityId
```

Extend `getTriageOpportunityDetail` to return a richer Broker Materials projection using existing data:

- Current canonical opportunity and decision
- Preparation blockers
- Send-only blockers for explanation
- Manual Stage 1 warnings
- Stable recipient options and provenance
- Existing CIM request projection with existing lifecycle fields
- Current communication history
- Reply state
- Corrected-recipient/retry eligibility or routes

After every approval attempt:

- Durable result: discard preparation and reload.
- Existing-request conflict: discard preparation and reload.
- Stale preparation: discard preparation and reload.
- Send-only blocker: reload blockers; retain review only when explicitly still valid.
- Unknown outcome: lock and reload before any action.

The browser does not append a communication, advance pipeline, or infer sent/delivery/reply state locally.

## 20. Existing-request lifecycle CTAs

Once a durable request owns the opportunity, no new initial preparation is offered.

| Existing lifecycle | Primary CTA |
|---|---|
| Pending/claimed | **View Request Status**; Sending indicator while current |
| Sent/provider accepted | **View Sent Request** |
| Delivered | **View Request Status** |
| Development-only logged | **View Logged Request** |
| Definite failure before acceptance | **Review & Retry Saved Request**, only if existing service permits |
| Bounce/post-acceptance failure/suppression/complaint | **Correct Recipient** when existing safeguards permit; otherwise **Review Delivery Issue** |
| Ambiguous | **Review Ambiguous Result**; no resend/retry |
| Replied | **View Broker Reply** |

There is no generic **Send Again** action after sent, delivered, ambiguous, or replied.

## 21. Corrected-recipient and retry integration

Phase 2 does not replace `retryDealHunterCimRequestWithCorrectedRecipient` or the existing retry UI/history.

- Definite pre-acceptance failure retries the exact saved communication through existing idempotent behavior.
- Post-acceptance delivery issues use existing corrected-recipient safeguards.
- Corrected recipient must be different from the failed address.
- A known signed contact may be selected under existing policy.
- A new manual address requires confirmation and an override reason under existing policy, and Phase 2's preferred initial-request UX remains Add / Verify Broker Email first.
- Duplicate accepted request protection remains authoritative.
- Ambiguous outcomes are not retransmitted.
- Existing retry/correction flows recheck current pause, cadence, suppression, identity, and provider boundaries.

No retry creates a second Phase 2 initial preparation.

## 22. Broker Materials card

Place one compact **Broker Materials** card immediately below the existing Pursue / Watch / Pass controls in `OpportunityDrawer`'s Overview section.

The collapsed card contains:

- Heading
- One textual status badge
- One sentence
- One primary CTA or remediation
- Optional details disclosure

It owns current action/status summary. The existing CRM/CIM section continues to own durable communication and audit history without duplicating the same summary.

### 22.1 Derived presentations

| Presentation | Badge | Primary action |
|---|---|---|
| Ready | Ready | Request Broker Materials |
| Blocked | Blocked | Pursue, Add / Verify Broker Email, Refresh, or View Requirements |
| Prepared | Prepared | Review Prepared Request / Approve & Send inside expanded card |
| Sending | Sending/Pending | Disabled Sending… or View Request Status |
| Checking | Checking | Check Again only when authoritative reload fails |
| Sent | Sent/Delivered/Logged | View Sent Request / View Request Status |
| Delivery Issue | Failed/Delivery Issue | Retry Saved Request, Correct Recipient, or Review Delivery Issue |
| Ambiguous | Ambiguous | Review Ambiguous Result |
| Replied | Replied | View Broker Reply |

These are UI presentations derived from existing data, not stored status values.

### 22.2 Inline expanded review

The expanded card shows, in order:

1. Opportunity context
2. Manual Stage 1 warnings
3. Recipient selector and provenance
4. Sender
5. Greeting control
6. Read-only subject
7. Read-only complete body
8. Send-only blockers
9. Expiration
10. Explicit approval

There is no stepper or nested dialog.

### 22.3 Recipient changes

Changing recipient contact reference:

- Immediately disables approval.
- Discards the current token from active approval state.
- Requests a new side-effect-free preparation.
- Replaces the complete proposal atomically.
- Keeps focus on the selector and announces completion politely.

### 22.4 Greeting changes

When greeting differs from the signed greeting:

- Mark preview out of date.
- Disable approval.
- Show **Update Preview**.
- Keep the old body visible but clearly stale.
- Do not request on every keystroke.

Enter in the greeting field invokes Update Preview only. It never sends.

### 22.5 Stale/expired presentation

Remove active approval authority, retain the old copy for orientation, show **Preparation out of date**, and provide **Regenerate Request**. Regeneration is explicit; it does not silently restore approval.

## 23. Loading, Sending, and Checking

### Preparing

- Expand immediately.
- Show compact skeleton rows and “Preparing broker materials…”.
- Do not use sending language.

### Sending

- Lock button synchronously before the request.
- Lock contact/greeting controls.
- Keep exact reviewed copy visible.
- Show “Submitting the approved request…”.
- Do not show Sent before authoritative refresh.

### Checking

- Used for unknown browser outcome or authoritative refresh in progress.
- Approve & Send is absent.
- No automatic retry.
- Failed refresh shows **Check Again** and explicit “Do not resend until status is available.”

## 24. Desktop and mobile behavior

### Desktop

- Preserve existing Opportunity Drawer width (`sm:max-w-3xl`) and scroll container.
- Use a single-column review flow.
- Full-width contact, greeting, subject, and body.
- Keep approval in normal card flow.
- Avoid nested scrollbars.

### Mobile

- Preserve the current full-height drawer.
- Full-width controls and wrapping provenance.
- One vertical reading order.
- Only the Prepared final approval area becomes sticky.
- Sticky area includes safe-area padding, separator, exact recipient, and a full-width Approve & Send button.
- Add bottom content padding so the sticky action obscures nothing.
- When the software keyboard is open, the sticky action must not cover greeting or Update Preview.
- Sticky approval is absent for Ready, Blocked, Sent, Delivery Issue, Ambiguous, and Replied.

Global pause may leave the sticky button disabled with the visible reason.

## 25. Keyboard, focus, and screen-reader behavior

### Keyboard

- Logical Tab order follows rendered reading order.
- Enter in greeting updates preview only.
- Approve & Send is not a default form submit.
- Space/Enter activates sending only when the approval button itself has focus.
- Escape closes an open contact menu before the drawer.
- Existing drawer focus trap and return-to-trigger behavior remain.

### Focus

- After preparation, move to the expanded review heading.
- Recipient regeneration keeps focus on the selector.
- Greeting regeneration keeps focus at the update control/input.
- Send error caused by operator action moves focus to its alert.
- Authoritative lifecycle refresh moves focus to the Broker Materials status heading.
- Collapse returns focus to the disclosure button.
- Background webhook refresh does not steal focus.

### Screen readers

- Card is a labeled region.
- Disclosure uses `aria-expanded` and `aria-controls`.
- Loading uses `aria-busy`.
- One stable polite live region announces Preparing, Updated, Sending, Checking, and authoritative status.
- New blocking errors use `role="alert"` where appropriate.
- Warning and blocker headings use explicit text, not color alone.
- Recipient provenance is associated with the selector via `aria-describedby`.
- Subject/body are read-only, not disabled, and remain copyable.
- Ambiguous state explicitly announces “Do not send another request.”

## 26. Accidental-submission prevention

- Approve & Send appears only after a complete administrator-bound preparation renders.
- The card itself is not a send target.
- Exact recipient appears immediately above final approval.
- The button includes the word Send.
- Dirty greeting, recipient change, loading, stale/expired token, blocker, or sending state disables/removes approval.
- The first activation locks synchronously.
- Repeated pointer, keyboard, or mutation activation cannot submit concurrently.
- Enter in other controls cannot submit.
- Unknown outcome enters Checking and never immediately restores approval.
- No second confirmation modal is added.

## 27. Viewer/read-only behavior

Viewer access reuses existing `requireAdminAccess` and existing data-visibility policy.

Viewers may:

- View current lifecycle and history.
- View recipient/provenance where already permitted.
- View generated copy only through a preview-only response if existing permissions allow it.
- Reload authoritative Opportunity Detail/history through **Check Request Status**.

Viewers may not:

- Receive a preparation token, proposal digest, or approval nonce.
- Approve or send.
- Select an approval recipient or edit an approval greeting.
- Add/verify facts.
- Retry or correct recipient.
- Invoke provider reconciliation or any durable-state mutation under a Check Status label.

An administrator must create a separate administrator-principal-bound preparation before sending.

## 28. Phase 3 follow-up boundary

Phase 2 sends one initial, explicitly approved broker-materials request and stops.

Phase 3, if separately designed and approved, may address:

- Whether manual Stage 1 requests enter a follow-up sequence.
- Follow-up number, timing, cadence, and maximum count.
- Follow-up copy and human review.
- Automatic versus manual follow-up authorization.
- Stop rules beyond existing reply/delivery behavior.
- Follow-up UI in the Opportunity Drawer.
- Stage 2/3 interaction and activation policy.

Phase 2 must not pre-authorize those decisions. New Phase 2 requests store no scheduled follow-up. Existing historical follow-up records remain visible and unchanged.

## 29. Repository implementation map

### Existing modules to reuse or extend

| Path | Existing responsibility | Phase 2 change |
|---|---|---|
| `src/components/admin/AcquisitionInbox.jsx` | Phase 1 queue, canonical detail loading, Pursue/Watch/Pass mutations, fact saves, focus return | Add preparation/approval callbacks and reuse `loadDetail` for every authoritative refresh. Preserve mutation guards and read-only behavior. |
| `src/components/admin/OpportunityDrawer.jsx` | Full-height responsive Opportunity Drawer, sections, Phase 1 actions, verified facts, focus trap | Insert one Broker Materials card below Overview actions. Pass existing detail/read-only/pending/focus semantics through. |
| `server/app.js` | Admin/viewer route authorization and Deal Hunter routes | Add prepare and approve routes adjacent to triage routes. Prepare uses `requireAdminAccess`; approve uses `requireAdmin`. Pass existing `session.principal_id` and username. |
| `server/services/auth.js` | Existing admin session, role, and stable `principal_id` | Reuse unchanged. Do not add identity storage. |
| `server/services/dealHunterTriage.js` | Current canonical Opportunity Detail projection | Extend `getTriageOpportunityDetail` with Broker Materials projection, stable contact options, and complete existing lifecycle fields needed by the card. |
| `server/services/dealHunterOpportunityFacts.js` | Current source/CRM/operator fact authority and verified operator facts | Reuse fact IDs and provenance. Ensure unverified operator email is not selectable. Reuse `setCurrentOperatorOpportunityFact` for Add / Verify Broker Email. |
| `server/services/dealHunter.js` | Current CIM eligibility/status, direct route, private durable executor, claims, persistence, ambiguity, reconciliation, corrected-recipient retry | Refactor eligibility to policy-aware structured output; add trusted approved-message/manual policy input to the existing durable executor; return durable request outcomes clearly; disable follow-up scheduling for Phase 2 requests. Do not fork the executor. |
| `server/services/cimOpportunityIdentity.js` | Canonical identity resolution, global pause, recipient policy/cadence, claims policy | Reuse for explanatory reads and final durable enforcement. Do not duplicate policy in the adapter. |
| `server/services/delivery.js` | `buildDealHunterCimRequestEmail`, deterministic provider envelope, `sendPreparedMessage`, reply-to | Reuse message builder/provider path; narrowly support greeting and approved exact copy while preserving tracking/idempotency. |
| `server/services/communications.js` | Outbound communication normalization and persistence | Reuse unchanged through the durable CIM executor. Adapter must not call it directly. |
| `server/services/emailReadiness.js` | Provider/readiness projection | Reuse for explanatory send blocker and existing durable final check. |
| `server/services/emailEvents.js` | Delivery/reply event ingestion and canonical reply handling | Reuse unchanged. |
| `server/storage/sqlite.js` and `server/storage/supabase.js` | Existing request, recipient, opportunity, communication, and session persistence/claims | Reuse existing APIs. Approval audit goes in existing request/communication metadata; no new draft/contact table or required schema migration is expected. |
| `test-ui/AcquisitionInbox.test.jsx` and `test-ui/OpportunityDrawer.test.jsx` | Phase 1 queue/drawer behavior, mutation safety, accessibility | Extend with Phase 2 integration and refresh behavior. |
| `test/cimCommunicationLifecycle.test.js`, `test/dealHunterBulkCim.test.js`, `test/cimOpportunityIdentity.test.js` | Existing durable send, pause/cadence, ambiguity, retry, identity behavior | Add regression coverage proving Phase 2 reaches the same boundaries without retransmission or Stage 2 relaxation. |
| `test/httpDealHunterTriageActions.test.js` and triage detail tests | Canonical action/detail routes and current authority | Extend route/detail contracts and viewer/admin authorization cases. |

### Smallest likely new modules

1. `server/services/dealHunterBrokerMaterials.js`
   - Manual Stage 1 preparation projection.
   - Stable contact-reference issue/resolve logic.
   - Side-effect-free preview generation.
   - Preparation token and proposal digest issue/verify.
   - Thin approval adapter that delegates once to the exported existing CIM execution seam.

2. `src/components/admin/BrokerMaterialsCard.jsx`
   - Compact/expanded card, recipient/greeting review, loading/stale/checking behavior, lifecycle CTAs, responsive sticky approval, and accessibility semantics.

3. `test/dealHunterBrokerMaterials.test.js`
   - Focused service/route contract tests, side-effect assertions, token binding/staleness, viewer preview, manual policy, durable-result normalization, and timeout-safe results.

4. `test-ui/BrokerMaterialsCard.test.jsx`
   - Focused interaction/accessibility tests. Integration assertions remain in existing Acquisition Inbox and Opportunity Drawer tests.

No new database table, migration, provider service, or reconciliation module is planned.

## 30. Testing strategy

### Service and route tests

- Prepare is side-effect free with spies on every request/claim/communication/provider/follow-up mutation.
- Viewer response never includes token, digest, nonce, or approval capability.
- Admin token binds existing `principal_id` and rejects a different principal.
- Contact references survive ordering changes and reject stale/provenance-changed contacts.
- Trusted source and CRM contacts do not require operator verification.
- New manual emails remain blocked until saved verified.
- Multiple contacts require explicit selection unless authority marks one primary.
- Low score and missing annual profit are warnings for manual Stage 1 and blockers for automated policy.
- Deal-key/alias changes produce stale preparation but allow a fresh canonical preparation.
- Token expires at 15 minutes.
- Every material change produces `preparation_stale`.
- Approval cannot submit client recipient/subject/body overrides.
- Approval calls the existing durable executor exactly once.
- Durable failed/ambiguous/delivery-issue outcomes return `durableResult`.
- Idempotent repeat returns existing request and does not call provider twice.
- Unknown outcome cannot be interpreted as safe retry.
- Phase 2 request schedules no follow-up.
- Automated/Stage 2 eligibility and scheduling behavior remain unchanged.

### UI tests

- Ready, Blocked, Prepared, Sending, Checking, Sent, Delivery Issue, Ambiguous, and Replied presentations.
- Global pause permits preparation and disables send.
- Warnings do not disable send; blockers do.
- Recipient change and greeting change invalidate active approval.
- Enter in greeting updates preview and never sends.
- Double activation sends one request.
- Durable result always exits Prepared.
- Timeout enters Checking and no approval button returns before authoritative refresh.
- Viewer has preview-only/no approval and Check Status performs GET detail only.
- Correct focus movement, live-region announcements, labels, described-by provenance, and no color-only meaning.
- Mobile sticky final action does not obscure content or greeting keyboard interaction.

### Regression tests

- Existing direct CIM route.
- Existing bulk approval queue.
- Existing Stage 2 automation and strict thresholds.
- Existing global pause, cadence, suppression, and provider readiness.
- Existing canonical/recipient/request claims.
- Existing ambiguous non-retransmission.
- Existing corrected-recipient behavior.
- Existing delivery webhook and reply reconciliation.
- Existing Acquisition Inbox Phase 1 decisions and verified facts.

## 31. Phase 2 acceptance criteria

Phase 2 is complete only when all of the following are true.

### Eligibility and policy

- [ ] Request Broker Materials is visible in the Opportunity Drawer.
- [ ] Only a current, actionable, explicitly Pursued opportunity can receive an approvable preparation.
- [ ] Watch and Pass do not authorize preparation.
- [ ] Low score and incomplete annual profit are visible warnings, not manual Stage 1 blockers.
- [ ] Automated/Stage 2 thresholds remain unchanged.
- [ ] Canonical opportunity ID is durable identity; client deal key is not required.
- [ ] Mutable alias/deal-key change can stale but cannot permanently block a fresh unambiguous canonical preparation.

### Recipient authority

- [ ] Current trusted-source and current CRM emails are usable without extra operator verification.
- [ ] A new manually entered email is unusable until saved as a verified operator fact.
- [ ] Every selectable contact uses a stable opaque server reference.
- [ ] No array position or raw email acts as contact identity.
- [ ] Multiple contacts without explicit primary require selection.
- [ ] Provenance is visible for every option.

### Preparation and approval

- [ ] Preparation performs no durable write, claim, provider call, pipeline change, or follow-up scheduling.
- [ ] Subject/body are server-generated and read-only.
- [ ] Greeting is the only editable message text.
- [ ] Recipient/greeting change regenerates the entire signed proposal.
- [ ] Token is bound to existing admin `principal_id`, canonical opportunity, exact proposal, warning context, and contact provenance.
- [ ] Viewer receives no approvable token or digest.
- [ ] Token lifetime is at most 15 minutes.
- [ ] Material change returns `preparation_stale` and requires fresh review.
- [ ] Explicit Approve & Send is the only way to enter durable execution.

### Durable execution and safety

- [ ] Approval delegates once to the existing CIM executor.
- [ ] Adapter does not implement claims, cadence, suppression, pause, provider readiness, communication persistence, ambiguity, or reconciliation.
- [ ] Existing final checks remain authoritative.
- [ ] Existing request/communication persistence occurs before provider work as currently designed.
- [ ] Durable `failed`, `ambiguous`, `delivery_issue`, and other outcomes return unmistakable `durableResult`.
- [ ] Duplicate approval cannot call the provider twice.
- [ ] Ambiguous outcome cannot be retransmitted.
- [ ] Unknown browser outcome enters Checking and reloads authority before any next action.
- [ ] Phase 2 initial requests schedule no follow-up.

### Drawer and accessibility

- [ ] One compact card uses progressive disclosure; no wizard/modal/second drawer.
- [ ] All required lifecycle presentations and CTAs derive from existing status vocabulary.
- [ ] Global pause permits review and visibly disables final send.
- [ ] Authoritative Opportunity Detail reload occurs after every approval outcome.
- [ ] No optimistic sent, delivery, reply, communication, or pipeline state is created by the frontend.
- [ ] Desktop and mobile layouts match existing Phase 1 visual language.
- [ ] Mobile Prepared state has a non-obscuring sticky final approval action.
- [ ] Keyboard, focus trap, focus return, live regions, labels, provenance descriptions, and alert semantics pass automated and manual accessibility checks.
- [ ] Enter outside the approval button cannot send.
- [ ] Viewer status check is a read-only detail reload and cannot invoke reconciliation mutation.

### Lifecycle integration

- [ ] Existing request replaces initial preparation controls.
- [ ] Definite pre-acceptance failure routes to existing saved retry when allowed.
- [ ] Post-acceptance delivery issue routes to existing correction/review behavior.
- [ ] Ambiguous and replied states expose no new initial send.
- [ ] Existing communication/reply history remains authoritative.

## 32. Engineering estimate — Phase 2 only

Estimated effort for one engineer familiar with this repository: **9–12 engineering days**, approximately **two focused calendar weeks**, excluding external deployment approval or waiting for production provider/webhook observations.

| Workstream | Estimate |
|---|---:|
| Manual policy, contact authority, detail projection, side-effect-free preparation, signing | 2–3 days |
| Existing durable executor seam, exact approved message, no-follow-up policy, durable-result mapping | 2.5–3.5 days |
| Broker Materials card, Acquisition Inbox wiring, responsive/accessibility behavior | 2.5–3.5 days |
| Integrated regression, browser/mobile verification, ambiguity/timeout hardening | 1.5–2 days |

The primary implementation risk is the size and coupling of `server/services/dealHunter.js`, especially preserving every existing direct, bulk, automated, retry, and reconciliation path while adding one trusted approved-message input. The estimate assumes no new database schema is required.

## 33. Recommended commit decomposition

Use four independently testable commits.

### Commit 1 — Manual preparation domain and canonical projection

- Add policy-aware structured eligibility.
- Add recipient authority resolution and stable contact references.
- Add side-effect-free preparation service and 15-minute signing.
- Extend Opportunity Detail projection.
- Add prepare route, including viewer preview-only behavior.
- Add focused backend tests proving zero durable side effects.

### Commit 2 — Approved proposal through existing durable CIM executor

- Add the approved exact-message input at the existing executor seam.
- Bind existing administrator principal.
- Preserve existing claims/persistence/policy/provider/reconciliation ownership.
- Add manual no-follow-up policy.
- Add approve route and durable-result normalization.
- Add idempotency, failed/ambiguous, stale, and automated-policy regression tests.

### Commit 3 — Broker Materials card and authoritative drawer integration

- Add the compact/expanded card.
- Wire prepare, regenerate, approve, and authoritative detail reload through Acquisition Inbox.
- Add warnings/blockers, contact provenance, greeting update, lifecycle CTAs, global pause, and viewer behavior.
- Add focused UI and integration tests.

### Commit 4 — Responsive, accessibility, timeout, and full regression hardening

- Complete mobile sticky approval and keyboard viewport behavior.
- Verify focus, live regions, screen-reader semantics, and accidental-submission guards.
- Add unknown-outcome/Checking tests and browser coverage.
- Run full server, UI, browser, lint, and build verification.

## 34. Remaining product decisions

No remaining product decision requires approval before implementation planning.

Implementation details such as the exact opaque contact-reference encoding, internal helper names, and whether focused test cases live in one or two new test files are engineering choices constrained by this specification. They must not alter the approved behavior or create new product scope.
