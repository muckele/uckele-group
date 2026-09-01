# Request Broker Materials Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement **one top-level task only per run**, then stop and return the commit for one focused review. Use superpowers:test-driven-development during that task and superpowers:verification-before-completion before claiming it is done. Do not run all four tasks autonomously and do not add a standing subagent/reviewer loop.

**Goal:** Add the explicitly human-approved, manual Stage 1 Request Broker Materials flow to the existing Phase 1 Opportunity Drawer while preserving the existing CIM executor as the only durable send boundary.

**Architecture:** A new read-only Broker Materials service derives current canonical authority, contacts, warnings, blockers, exact server-owned copy, and a short-lived administrator-bound signed proposal. The existing Deal Hunter CIM executor gains one trusted approved-message/manual-policy input at its current message-construction seam and continues to own final currentness, policy, claims, persistence, provider work, ambiguity, retry, and reconciliation. The frontend renders one state-derived card and reloads authoritative Opportunity Detail after every mutation or uncertain outcome.

**Tech Stack:** Node.js ESM and Express; SQLite and Supabase storage adapters; React 18, Tailwind, Testing Library/Vitest; Node test runner; Playwright.

**Spec:** docs/superpowers/specs/2026-08-31-request-broker-materials-phase-2-design.md

**Planning base:** origin/main at c3043b3dca68701e6d1d9918544681d8ba5d3872, with approved design commit 20d907f292784b8367eb86700598069660a0fa44 cherry-picked onto codex/request-broker-materials-phase-2.

## Global constraints and execution protocol

- Execute exactly one numbered task per implementation run. Each task must end in its own green commit and return for one focused review before the next task begins.
- Follow RED → GREEN → refactor for every behavior. Run the named focused tests and observe the requested new assertions fail for the intended reason before changing production code.
- Keep diffs local to the exact files named by the active task. If a nearby file proves necessary, stop and explain the evidence before broadening the task.
- Do not add a database table, migration, durable draft, contact table, new provider service, new reconciliation service, new lifecycle enum, or new pipeline state.
- **Schema stop condition:** if an implementation appears to require any schema or migration change, stop the task immediately and return the missing durable requirement and the existing APIs that cannot satisfy it. Do not improvise a schema.
- Preparation is read-only. It must not import, score, reconcile, write metrics, consume overrides, claim identities, persist a request or communication, call a provider, change pipeline state, or schedule follow-up.
- The approval adapter verifies the transport contract and crosses the existing durable CIM boundary exactly once. It must not claim, persist, send, retry, poll, or reconcile on its own.
- Canonical opportunity ID is the durable route identity. Neither route accepts a client deal key, raw recipient email, message copy, policy marker, readiness override, or follow-up option.
- Existing automated/direct/bulk/Stage 2 callers retain the strict automated eligibility default and their present scheduling behavior.
- Manual Stage 1 requests use only the existing unscheduled representation: next_follow_up_at = null and follow_up_state = not-scheduled.
- The browser never invents sent, delivered, failed, replied, communication, or pipeline state. It consumes the authoritative detail projection.
- Preserve the existing Opportunity Drawer width, full-height behavior, focus trap, Escape handling, and focus return.
- No wizard, modal, nested drawer, second confirmation, free-form subject/body editor, or automatic approval retry.
- No dependency upgrades, audit fixes, speculative refactors, deployment, push, or Phase 3 follow-up work.

## Verified repository facts that constrain the implementation

1. getTriageOpportunityDetail is already a read-only persisted-authority path. In contrast, resolveDealHunterOpportunity upserts canonical identity, aliases, or exceptions. Preparation must therefore use current storage reads and must not call the resolver; final durable execution continues to use the resolver.
2. getEffectiveOpportunityFacts intentionally lets an operator fact outrank CRM/source facts even when the operator fact is unverified. Recipient authority must inspect the raw current operator fact and require verified === true rather than trusting the effective broker_email alone.
3. buildDealHunterCimRequestEmail is the existing copy source, buildCimRequestId is deterministic from canonical opportunity ID plus normalized recipient, and sendCimRequestForScoredDeal is the current private durable executor. Move/reuse these seams; do not duplicate their algorithms.
4. The current executor checks global pause, identity, cadence, suppression, claims, persistence, provider outcome, ambiguity, and reconciliation. It does not currently call getEmailReadiness as a distinct final manual/direct readiness gate. Phase 2 therefore adds a narrow final readiness check only for the trusted manual_stage_1 branch while leaving legacy and Stage 2 behavior unchanged.
5. SQLite and Supabase already persist every required durable entity and claim. They expose a read-only opportunity-claim getter but no read-only recipient-claim getter. Add method parity only; no table or column change is required.
6. Current Opportunity Detail reduces CIM requests to id/status/updatedAt. The card needs a bounded projection of existing request_state, delivery_state, follow_up_state, timestamps, reply/delivery meaning, and existing retry/correction capability. Do not expose raw request metadata or provider payloads.
7. The admitted current source-observation rows already carry source_id, stable source_record_id, field identity, value, observed_at, and updated_at. They can support signed deterministic contact references without a contact table. Manual Stage 1 must not silently inherit the stricter Stage 2 Sheet-only cohort policy.
8. The known-green baseline uses Node v22.23.2. The shell's Node v24 native better-sqlite3 cleanup crashed after otherwise passing tests; the same checkout passed all 953 server tests with Node v22.

## Shared contracts to preserve across tasks

### Eligibility result

~~~ts
type CimEligibilityPolicy = "automated" | "manual_stage_1";

type CimEligibilityResult = {
  eligible: boolean;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{
    code:
      | "below_automated_cim_score_threshold"
      | "annual_profit_incomplete";
    message: string;
    value: number | null;
    automatedThreshold?: number;
  }>;
};
~~~

The evaluator defaults to automated. Common identity, removal/actionability, and recipient-validity failures remain blockers. Deal-key absence, score below 75, and incomplete annual profit retain existing automated behavior. For manual_stage_1, a mutable deal key is not required and score/profit become signed warnings.

### Opportunity Detail Broker Materials projection

~~~ts
type BrokerMaterialsProjection = {
  existingRequest: null | ExistingCimRequestProjection;
  pursued: boolean;
  preparationBlockers: PresentationBlocker[];
  sendBlockers: PresentationBlocker[];
  warnings: ManualStage1Warning[];
  recipientOptions: ReadonlyRecipientOption[];
};
~~~

ExistingCimRequestProjection must use existing vocabulary and bounded fields only: id, status, requestState, deliveryState, followUpState, recipient display, subject, created/updated/requested/provider-accepted/delivered/responded timestamps, provider-safe error summary, and existing retry/correction capability or route hints. It must not contain raw metadata, provider response bodies, secrets, signatures, or approval claims.

### Preparation service

~~~ts
prepareDealHunterBrokerMaterials({
  opportunityId,
  recipientContactRef,
  greeting,
  session: { principal_id, role, username },
  storage,
  now
}) -> PrepareBrokerMaterialsResponse | ViewerBrokerMaterialsPreview
~~~

Preparation uses config.admin.sessionSecret with the existing signPayload/verifySignedPayload boundary, stableCanonicalJson for the proposal digest, and an expiration no later than 15 minutes or earlier required-authority expiry.

### Trusted durable boundary

~~~ts
executeApprovedDealHunterCimRequest({
  approvedProposal,
  requestedBy,
  administratorPrincipalId,
  storage
}) -> ExistingCimServiceResult
~~~

Only the server-side approval adapter may call this export. The approved proposal contains the verified signed fields; it does not accept browser-authored recipient/copy/policy values. Internally it calls the existing sendCimRequestForScoredDeal flow, not a fork.

### HTTP contracts

~~~text
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/prepare
body: { recipientContactRef?: string, greeting?: string }
auth: requireAdminAccess

POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/approve
body: { preparationToken: string, approvedProposalDigest: string }
auth: requireAdmin
~~~

Both routes reject unknown keys. Approval never accepts recipient, greeting, sender, subject, body, deal key, policy, override, readiness, follow-up, or pipeline fields.

---

## Task 1: Manual preparation domain, contact authority, and canonical detail projection

**Target duration:** 90–120 minutes

**Commit:** Add Phase 2 broker materials preparation

### Exact files

Create:

- server/services/dealHunterBrokerMaterials.js
- test/dealHunterBrokerMaterials.test.js

Modify:

- server/utils/security.js
- server/services/dealHunter.js
- server/services/delivery.js
- server/services/dealHunterTriage.js
- server/app.js
- server/storage/sqlite.js
- server/storage/supabase.js
- test/delivery.test.js
- test/dealHunterTriageDetail.test.js
- test/httpDealHunterTriageActions.test.js
- test/canonicalOpportunityCurrentSemantics.test.js

Do not modify any frontend file in this task.

### Consumes

- getDealHunterOpportunity, getDealHunterOpportunityScore, listDealHunterOpportunityAliases, listDealHunterOpportunityFacts, listDealHunterOpportunitySourceObservations, getSubmission, listCrmCommunications, list/get Deal Hunter CIM request methods, getDealHunterCimOpportunityClaim, active suppression, recipient cadence, global pause, and email readiness.
- Existing Phase 1 Pursue representation: operator_priority high, reviewed current, changed_since_review false, not dismissed/removed/non-current.
- Existing fact IDs, CRM submission ID and broker_email field identity, and source_id/source_record_id/field/current authority revision.
- buildDealHunterCimRequestEmail copy, deterministic CIM request identity algorithm, reply-to construction, getEmailReadiness, signPayload, verifySignedPayload, and sha256.

### Produces

- evaluateDealHunterCimEligibility with automated default and manual_stage_1 warnings.
- buildDealHunterCimRequestId as the single exported deterministic request-ID helper used by existing and new paths.
- BROKER_MATERIALS_TEMPLATE_VERSION = deal-hunter-cim-manual-stage1-v1.
- stableCanonicalJson in server/utils/security.js for recursively sorted object keys while preserving array order and JSON primitive semantics.
- Stable signed recipientContactRef values bound to canonical opportunity ID, provenance identity, normalized email, and authority revision.
- Read-only loadBrokerMaterialsAuthority/projectDealHunterBrokerMaterials helpers.
- prepareDealHunterBrokerMaterials and strict preparation input parsing.
- brokerMaterials on authoritative Opportunity Detail.
- A viewer-safe preview response and administrator-bound token/digest response.
- getDealHunterCimRecipientClaim method parity in SQLite and Supabase, backed by the existing table.

### RED tests to write first

In test/dealHunterBrokerMaterials.test.js, add named tests that initially fail because the service does not exist:

1. manual Stage 1 turns score below 75 and missing annual profit into the two exact warnings while automated policy retains the existing blockers.
2. preparation requires current explicit Pursue and rejects Watch, Pass, changed-since-review, removed, superseded, ambiguous, and missing required authority.
3. trusted current source, non-archived linked CRM, and verified operator broker emails are selectable; an unverified operator email is not selectable even when it is the effective fact.
4. contact references are opaque, stable across option reordering, bound to canonical opportunity/provenance/authority revision, and stale after source, CRM, or fact identity changes.
5. multiple usable contacts without explicit primary return recipient_selection_required and no token; exactly one or an authority-marked primary can be selected without array-order inference.
6. greeting accepts one trimmed plain-text line of at most 120 characters; rejects CR, LF, null/control characters, HTML interpretation, and unknown request fields.
7. administrator preparation binds principal_id, route opportunity, exact recipient/sender/reply-to/greeting/subject/text/HTML/template/warning context, has exp no more than 15 minutes, and produces sha256(stableCanonicalJson(approvalBoundPayload)).
8. viewer preparation omits token, digest, nonce, and approval capability; multiple-contact viewer state exposes provenance but no exact copy selected by inference.
9. preparation performs zero durable side effects: wrap every request/claim/communication/activity/fact/source/provider/follow-up/safety-metric mutation with fail-on-call spies and compare relevant SQLite row counts before/after.
10. global pause, cadence, suppression, provider readiness, and another current recipient claim appear only as sendBlockers and do not prevent exact preparation.
11. mutable deal-key/alias absence does not block a fresh canonical manual preparation, while a changed alias fingerprint invalidates an old authority revision.
12. the signed proposal never exposes a raw secret and uses epoch-millisecond exp compatible with verifySignedPayload.

In test/delivery.test.js, add RED tests:

1. manual Stage 1 accepts only the validated greeting option and returns the explicit template version.
2. normalized visible HTML text contains no substantive phrase absent from the reviewed subject plus complete plain-text body; adjust preheader/title/CTA text for this branch as needed without changing automated Stage 2 copy.
3. existing default and automation-stage-2 message snapshots remain unchanged when no manual template/greeting option is supplied.

In test/dealHunterTriageDetail.test.js, add RED tests:

1. brokerMaterials derives Pursued/current/blockers/warnings/options from persisted current authority without importing or rescoring.
2. existing request projection includes bounded status/requestState/deliveryState/followUpState/timestamps/reply/retry meaning and excludes raw metadata/provider payload/secrets.
3. provider event row order does not alter the authoritative projected lifecycle.

In test/httpDealHunterTriageActions.test.js, add RED tests:

1. admin can prepare by canonical opportunity ID with only recipientContactRef/greeting and receives a principal-bound token.
2. viewer receives previewOnly with no transferable approval fields.
3. unauthenticated access is rejected and unknown/raw email/copy/policy/deal-key fields are rejected before service work.
4. preparation leaves requests, claims, communications, activities, source observations, facts, score review, and pipeline-linked submission state unchanged.

In test/canonicalOpportunityCurrentSemantics.test.js, add RED storage-parity assertions beside the existing canonical opportunity/recipient claim coverage:

1. getDealHunterCimRecipientClaim returns the current existing claim by normalized recipient in SQLite.
2. the Supabase adapter issues the equivalent read-only lookup shape and does not mutate or delete the claim.

### Exact RED command

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterBrokerMaterials.test.js test/delivery.test.js test/dealHunterTriageDetail.test.js test/httpDealHunterTriageActions.test.js test/canonicalOpportunityCurrentSemantics.test.js
~~~

Confirm the new tests fail for missing exports/routes/projections, not fixture or environment errors.

### Minimal implementation steps

1. Add stableCanonicalJson to server/utils/security.js. Sort keys at every plain-object level, preserve array order, reject or consistently serialize unsupported values, and keep signPayload/verifySignedPayload unchanged.
2. Move the existing deterministic request-ID expression into one exported buildDealHunterCimRequestId helper. Update all existing call sites to use it; do not maintain two versions.
3. Replace the single-string unavailable-reason implementation with evaluateDealHunterCimEligibility. Keep automated as the default and map its first blocker back into the existing reason/status presentation so direct, bulk, and automation behavior does not change.
4. Extend buildDealHunterCimRequestEmail narrowly with a trusted manual templateVersion/greeting option. Default calls must produce existing copy. The manual branch must build text and HTML from the same structured fields and return exact templateVersion.
5. In dealHunterBrokerMaterials.js, load canonical current opportunity, current score, aliases, source observations, raw operator facts, linked CRM record, existing requests/claims, pause/cadence/suppression, and readiness through read-only methods only. Never call buildDailyDealReview, resolveDealHunterOpportunity, a safety-metric writer, or any mutation.
6. Derive Pursued solely from Phase 1 persisted semantics. Treat current admitted source-observation identity as manual structured-source authority; do not reuse Stage 2 allowedSourceIds as a new manual product rule.
7. Build contact candidates from source broker_email observations, current non-archived linked CRM broker_email, and verified current operator broker_email facts. Deduplicate equal normalized addresses for display without discarding provenance. Auto-select only exactly one option or an explicit authority primary.
8. Issue a deterministic signed recipientContactRef. Operator identity uses fact ID; CRM uses submission ID plus broker-email field identity; source uses source ID, source record ID, field identity, normalized email, and authority revision. Re-resolve the signed claims against the current read-only authority.
9. Compute authorityRevision and aliasResolutionFingerprint from bounded material current fields only. Include opportunity identity/status/version, current score semantic/fingerprint and warning inputs, required authority identity, contact provenance, sender/reply-to/template version, and relevant alias resolution. Do not include volatile presentation ordering.
10. Build the exact review and approval-bound payload, compute proposalDigest with stableCanonicalJson, add a cryptographic nonce, bind admin principal_id, sign it, and cap exp at 15 minutes. For viewers, build only the allowed preview and strip all approval authority.
11. Add getDealHunterCimRecipientClaim to both storage adapters using the existing deal_hunter_cim_recipient_claims table/query conventions.
12. Extend getTriageOpportunityDetail with brokerMaterials and the bounded existing-request lifecycle projection. Keep raw metadata and provider internals server-side.
13. Add the strict prepare route adjacent to current triage routes with requireAdminAccess and pass the existing session principal_id, role, and username.

### GREEN verification

Run the focused command again, then:

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterBulkCim.test.js test/cimAutomation.test.js test/cimStage2Compliance.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
~~~

All focused tests must pass. The legacy policy regression must prove low score/profit remain hard automated blockers and Stage 2 copy is unchanged.

### Commit boundary

Stage only the Task 1 files listed above. Inspect the staged diff for mutation calls inside preparation and for raw metadata in the projection.

~~~sh
git add server/services/dealHunterBrokerMaterials.js server/utils/security.js server/services/dealHunter.js server/services/delivery.js server/services/dealHunterTriage.js server/app.js server/storage/sqlite.js server/storage/supabase.js test/dealHunterBrokerMaterials.test.js test/delivery.test.js test/dealHunterTriageDetail.test.js test/httpDealHunterTriageActions.test.js test/canonicalOpportunityCurrentSemantics.test.js
git commit -m "Add Phase 2 broker materials preparation"
~~~

Stop and return the commit for one focused review.

### Prohibited scope

- No approval route or provider execution.
- No claim, request, communication, activity, fact, source, score, pipeline, metric, or follow-up write during preparation.
- No raw email accepted as selection authority.
- No trust in unverified effective broker_email.
- No Stage 2 policy relaxation.
- No schema/migration.
- No frontend changes.

---

## Task 2: Route the approved exact proposal through the existing durable CIM executor

**Target duration:** 105–120 minutes

**Commit:** Route approved broker materials through CIM executor

### Exact files

Modify:

- server/services/dealHunterBrokerMaterials.js
- server/services/dealHunter.js
- server/app.js
- test/dealHunterBrokerMaterials.test.js
- test/cimCommunicationLifecycle.test.js
- test/dealHunterBulkCim.test.js
- test/cimAutomation.test.js
- test/cimStage2Compliance.test.js
- test/httpDealHunterTriageActions.test.js

Modify server/services/delivery.js or test/delivery.test.js only if the approved-copy equality assertion exposes a defect in the Task 1 message envelope. Do not otherwise revisit copy.

### Consumes

- Task 1 signed preparation, proposal digest, authority/contact revalidation, manual eligibility evaluator, exact message envelope, deterministic request ID, and preparation response.
- Existing sendCimRequestForScoredDeal sequence, identity resolution, existing-request lookup, recipient/opportunity/request claims, CRM linkage, communication persistence, sendPreparedMessage, ambiguity handling, accepted-communication reconciliation, retry, suppression, cadence, global pause, and Stage 2 authorization.
- Existing getEmailReadiness for the manual branch's final send-only readiness check.

### Produces

- Strict approveDealHunterBrokerMaterials adapter.
- Exported trusted executeApprovedDealHunterCimRequest entry that invokes the existing private executor once.
- Approved-message/manual_stage_1 input at the current renderedMessage seam.
- Exact persisted approved recipient, sender/reply-to, subject, text, HTML, templateVersion, prospective request ID, and communication idempotency relationship.
- Existing unscheduled fields plus an internal/manual audit marker in existing request/communication metadata so reconciliation and corrected-recipient descendants preserve no-follow-up policy.
- DurableApprovalResponse normalization whenever an existing CIM request/communication owns the result.
- POST approve route using requireAdmin.

### RED tests to write first

Extend test/dealHunterBrokerMaterials.test.js:

1. approval rejects missing/unknown fields, invalid signature, wrong typ/version/intent, expired token, wrong route opportunity, wrong administrator principal_id, and mismatched approvedProposalDigest before crossing the executor.
2. approval rejects browser recipient/greeting/subject/body/deal-key/policy/override/readiness/follow-up fields.
3. each material authority change returns preparation_stale: current/Pursued/actionability, source authority, alias fingerprint, selected contact/provenance, sender/reply-to, template, exact copy, and warning values.
4. an existing durable owner wins over staleness and returns/reloads that lifecycle without a new send.
5. the adapter calls the injected durable boundary exactly once with only verified signed claims and authenticated audit identity.
6. failed, ambiguous, delivery_issue, pending, sent/logged, and responded service results containing a request normalize to success: true plus durableResult; a durable lifecycle is never flattened into an unsafe generic 5xx.
7. a pre-claim contract/policy failure has no durableResult and preserves only a still-current preview where explicitly allowed.

Extend test/cimCommunicationLifecycle.test.js:

1. a manual approved proposal traverses the existing identity, cadence, suppression, opportunity/recipient/request claims, CRM link, communication-before-provider, and provider path once.
2. the persisted communication and provider envelope equal the signed approved to/replyTo/subject/text/HTML exactly; executor-resolved request and communication identities equal the proposal.
3. low score and missing profit remain sendable only through the internal manual marker after explicit Pursue/approval; browser policy input and legacy direct calls cannot select it.
4. final global pause, recipient cadence, suppression, another live claim, archived CRM owner, changed current authority, and provider readiness block before provider work at the existing boundary.
5. provider failure after durable creation returns durableResult failed; timeout after dispatch returns durableResult ambiguous and cannot be retransmitted.
6. repeat approval returns the existing deterministic request and makes zero additional provider calls.
7. manual initial request persists next_follow_up_at null and follow_up_state not-scheduled even when global follow-up configuration is enabled.
8. accepted-communication reconciliation, definite retry, and corrected-recipient descendants of a Phase 2 request preserve the no-follow-up metadata/policy.

Extend test/dealHunterBulkCim.test.js:

1. direct and bulk legacy snapshots still use automated eligibility/default copy.
2. existing bulk alternate-recipient and approved-copy behavior remains unchanged.
3. global pause and duplicate ownership still block at the same durable boundaries.

Extend test/cimAutomation.test.js and test/cimStage2Compliance.test.js:

1. Stage 2 remains score 90/current trusted cohort/activation gated and cannot pass manual_stage_1.
2. Stage 2 automatic copy and compliance content remain unchanged.
3. Stage 2 requests retain their existing follow-up scheduling behavior; only the signed Phase 2 manual intent is unscheduled.

Extend test/httpDealHunterTriageActions.test.js:

1. administrator approval accepts only preparationToken plus approvedProposalDigest and passes the authenticated principal_id/username to the adapter.
2. viewer and unauthenticated approval are rejected before durable execution.
3. recipient/greeting/subject/body/deal-key/policy/override/readiness/follow-up keys are rejected, while durable request results return the normalized success envelope and authoritative canonical ID.

### Exact RED command

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterBrokerMaterials.test.js test/cimCommunicationLifecycle.test.js test/dealHunterBulkCim.test.js test/cimAutomation.test.js test/cimStage2Compliance.test.js test/httpDealHunterTriageActions.test.js
~~~

Confirm failures point to the missing approval boundary/manual branch and not Task 1 regressions.

### Minimal implementation steps

1. Add strict approve input parsing and verifySignedPayload checks for typ, version, intent, requestType, exp, route canonical opportunity ID, authenticated admin principal_id, and safe digest equality.
2. Recompute stableCanonicalJson digest from the signed approval-bound claims; never trust only the separately submitted digest string.
3. Re-resolve current authority/contact and warning context with the Task 1 read-only helper. Return preparation_stale for material drift, except return a resolved existing durable owner when one already exists.
4. Export executeApprovedDealHunterCimRequest as a trusted wrapper around sendCimRequestForScoredDeal. Do not copy its body or expose a generic client-selectable policy argument.
5. Add one internal manualApproval object to the executor. It carries verified exact message fields, contact/provenance/authority binding, principal ID, proposal digest, template version, and followUpPolicy none.
6. At final execution, retain existing canonical/source/current recipient checks and call evaluateDealHunterCimEligibility with manual_stage_1 only when the trusted manualApproval object is present. All other callers use automated.
7. Recheck global pause and getEmailReadiness for the manual branch before claims/provider work. Keep cadence, suppression, active claims, archived ownership, duplicate ownership, and ambiguity in their existing executor locations.
8. At the current renderedMessage assignment, choose the approved exact envelope only after asserting the executor-resolved canonical ID, normalized recipient, prospective request ID, communication ID/idempotency relationship, sender/reply-to, template version, and copy match the signed proposal. A mismatch fails before provider work.
9. Persist the exact approved communication through createCommunicationWithActivity before sendPreparedMessage exactly as the existing flow does. The adapter never calls either function.
10. Teach buildCimRequestRecord and accepted-communication reconciliation to derive existing unscheduled fields from the trusted Phase 2 audit metadata. Preserve that marker through retry/corrected-recipient descendants. Do not rewrite historical requests or introduce a new state.
11. Normalize any executor result containing a durable request into DurableApprovalResponse regardless of provider lifecycle meaning. For unknown browser outcomes, rely on deterministic ownership and authoritative detail rather than retransmission.
12. Add the approve route adjacent to prepare with requireAdmin, authenticated principal/username, strict body, stable domain-to-HTTP mapping, and no client override fields.

### GREEN verification

Run the RED command until green, then:

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/cimOpportunityIdentity.test.js test/dealHunterTriageDetail.test.js test/httpDealHunterTriageActions.test.js test/emailCommunicationLifecycle.test.js test/emailWebhookReplay.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
~~~

Inspect the provider spy counts for every failure/ambiguity/idempotency test. No test may infer idempotency only from response text.

### Commit boundary

~~~sh
git add server/services/dealHunterBrokerMaterials.js server/services/dealHunter.js server/app.js test/dealHunterBrokerMaterials.test.js test/cimCommunicationLifecycle.test.js test/dealHunterBulkCim.test.js test/cimAutomation.test.js test/cimStage2Compliance.test.js test/httpDealHunterTriageActions.test.js
git add server/services/delivery.js test/delivery.test.js
git commit -m "Route approved broker materials through CIM executor"
~~~

Stage the delivery files only if they were actually needed and explain why in the task handoff. Stop and return the commit for one focused review.

### Prohibited scope

- No second executor, provider wrapper, retry loop, reconciliation job, or direct adapter storage/provider call.
- No client-selectable manual policy.
- No optimistic success based on provider status.
- No generic retry of ambiguous or unknown outcomes.
- No follow-up scheduling for Phase 2.
- No change to Stage 2 eligibility, activation, copy, or scheduling.
- No schema/migration.
- No frontend changes.

---

## Task 3: Broker Materials card and authoritative drawer integration

**Target duration:** 90–120 minutes

**Commit:** Add Broker Materials drawer workflow

### Exact files

Create:

- src/components/admin/BrokerMaterialsCard.jsx
- test-ui/BrokerMaterialsCard.test.jsx

Modify:

- src/components/admin/OpportunityDrawer.jsx
- src/components/admin/AcquisitionInbox.jsx
- test-ui/OpportunityDrawer.test.jsx
- test-ui/AcquisitionInbox.test.jsx

Do not modify backend files in this task.

### Consumes

- Opportunity Detail brokerMaterials and cimSummary projections.
- Prepare response review, recipientOptions, warnings, sendBlockers, preparationToken, proposalDigest, preparedAt, expiresAt, and previewOnly.
- Approval DurableApprovalResponse and stable error codes including preparation_stale.
- Existing AcquisitionInbox loadDetail(opportunityId, { preserveData }), AbortController/generation/selection guards, mutation guard style, viewer readOnly prop, drawer focusGuardRef, and fact save callback.
- Existing OpportunityDrawer Overview action location and CRM/CIM history ownership.

### Produces

- One Broker Materials card immediately below Pursue/Watch/Pass.
- Ready, Blocked, Prepared, Sending, Checking, Sent, Delivery Issue, Ambiguous, and Replied presentations derived from existing API fields.
- Inline progressive disclosure review in the exact spec order.
- Prepare, recipient-regenerate, greeting-regenerate, approve, stale-regenerate, and read-only Check Status callbacks.
- Authoritative detail reload after every approval result/error/unknown outcome.
- A separate broker-materials pending lock that prevents double activation without blocking unrelated Phase 1 display behavior.

### Presentation mapping

| Source authority | Presentation | Primary action |
|---|---|---|
| existingRequest responded/reply timestamp | Replied | View Broker Reply |
| existingRequest ambiguous | Ambiguous | Review Ambiguous Result |
| existingRequest post-acceptance failure/bounce/suppression/complaint | Delivery Issue | Correct Recipient or Review Delivery Issue from existing capability |
| existingRequest definite pre-acceptance failure | Delivery Issue | Review & Retry Saved Request only when existing capability permits |
| existingRequest provider accepted/sent/delivered/logged | Sent | View Sent Request or View Request Status |
| existingRequest pending/claimed | Sending | Disabled Sending… or View Request Status |
| client approval outcome unknown or authoritative reload pending | Checking | No send; Check Again only after reload failure |
| active current preparation | Prepared | Review Prepared Request; Approve & Send only when clean/admin/no blocker |
| preparationBlockers non-empty | Blocked | Server-supplied remediation |
| otherwise | Ready | Request Broker Materials |

The table is UI derivation only. Do not persist these presentation names.

### RED tests to write first

In test-ui/BrokerMaterialsCard.test.jsx:

1. collapsed Ready/Blocked/existing-lifecycle states show one textual badge, one sentence, one appropriate primary action, and no duplicate CRM/CIM history summary.
2. Prepared expands in this order: opportunity, warnings, recipient/provenance, sender, greeting, read-only subject, complete read-only body, send blockers, expiration, approval.
3. warnings do not disable approval; send blockers do. Global pause still permits preparation/review.
4. multiple recipients require selection; changing recipient immediately removes active approval, calls prepare with contactRef only, replaces the whole proposal atomically, keeps selector focus, and announces Updated.
5. editing greeting leaves old copy visibly stale, disables approval, and exposes Update Preview; no request occurs per keystroke.
6. Enter in greeting invokes Update Preview only and never invokes approve. Enter elsewhere and clicking the card never sends.
7. first approval activation synchronously locks; repeated click/Space/Enter invokes onApprove once.
8. durableResult permanently consumes preparation and shows authoritative lifecycle after reload.
9. preparation_stale removes authority, retains old copy for orientation, and shows Regenerate Request.
10. viewer sees preview-only/read-only controls, no token/digest/send/retry/correction controls, and Check Request Status calls only read-only reload.
11. labeled region, disclosure aria-expanded/aria-controls, aria-busy, stable polite live region, alert semantics, provenance aria-describedby, copyable readOnly subject/body, and textual non-color status are present.

In test-ui/AcquisitionInbox.test.jsx:

1. prepare POST uses canonical selected opportunity route and only recipientContactRef/greeting, then stores the complete returned proposal.
2. approve POST uses only preparationToken/approvedProposalDigest, synchronously locks duplicate activation, and always calls authoritative loadDetail.
3. durable result, existing owner, stale, send blocker, definite pre-claim error, rejected fetch, timeout/AbortError, and detail reload failure each follow the spec transition.
4. unknown approval outcome enters Checking, never automatically retries, never restores approval from local state, and Check Again performs GET detail only.
5. late prepare/approve/detail responses for a previously selected opportunity cannot update the current drawer.
6. viewer cannot invoke preparation mutation requiring approval or approve; existing Phase 1 viewer/fact guards remain intact.

In test-ui/OpportunityDrawer.test.jsx:

1. Broker Materials card appears immediately below the Overview decision controls and before Strength/Concern sections.
2. existing Pursue/Watch/Pass, verified fact, focus trap, Escape, close, scroll, and focus-return behavior remains unchanged.
3. durable communication/history remains in the existing CRM/CIM section rather than duplicated in the card.

### Exact RED command

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm exec -- vitest run test-ui/BrokerMaterialsCard.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx
~~~

Confirm failures identify the missing card/callback state machine.

### Minimal implementation steps

1. Create BrokerMaterialsCard as a controlled component. Accept authoritative projection, transient preparation, pending/checking/error state, readOnly, and callbacks. Keep HTTP and durable inference out of the component.
2. Implement one deterministic presentation selector with existing lifecycle precedence. Once existingRequest is present, initial preparation controls disappear.
3. Render the compact labeled region and inline disclosure. Use server-provided warnings/blockers/provenance and exact review copy; do not reconstruct policy or message text.
4. Keep an active preparation immutable. Recipient change clears token/digest immediately and asks for a fresh complete response. Greeting editing stores a draft, marks old copy stale, and regenerates only on Update Preview.
5. Make approval a type=button control and lock it synchronously before awaiting. Keep exact reviewed copy visible while Sending.
6. In AcquisitionInbox, add narrowly separate prepare/approve transient state and refs. Reuse the selected-ID generation/AbortController defenses already used by loadDetail.
7. POST only the approved contracts. After every approval response or error, call loadDetail with canonical ID and preserve the Checking lock until authority is known.
8. For no response/timeout, do not call approve again. Show Checking; a failed refresh yields Check Again wired only to GET detail.
9. For durableResult, owner conflict, or preparation_stale, discard active authority before reload. Preserve review for a still-current send-only blocker only when the server explicitly says it is safe.
10. Pass the card into OpportunityDrawer immediately below DetailActions and pass focusGuardRef/readOnly semantics through. Keep CRM/CIM history where it is.
11. On Add / Verify Broker Email, route focus to the existing broker_email verified fact field; saving continues through onSaveFact and authoritative detail reload.

### GREEN verification

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm exec -- vitest run test-ui/BrokerMaterialsCard.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run test:ui
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
~~~

Manually inspect the test DOM for a single approval button, a single status live region, and no nested form default submit.

### Commit boundary

~~~sh
git add src/components/admin/BrokerMaterialsCard.jsx src/components/admin/OpportunityDrawer.jsx src/components/admin/AcquisitionInbox.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/OpportunityDrawer.test.jsx test-ui/AcquisitionInbox.test.jsx
git commit -m "Add Broker Materials drawer workflow"
~~~

Stop and return the commit for one focused review.

### Prohibited scope

- No backend/domain/storage edits.
- No copied policy, contact trust, message generation, or lifecycle persistence logic in React.
- No optimistic sent/delivered/replied state.
- No automatic approval retry or generic Send Again.
- No modal, wizard, nested drawer, or second confirmation.
- No free-form subject/body.

---

## Task 4: Responsive, accessibility, timeout, and full-regression hardening

**Target duration:** 90–120 minutes

**Commit:** Harden Phase 2 broker materials workflow

### Exact files

Modify:

- src/components/admin/BrokerMaterialsCard.jsx
- src/components/admin/OpportunityDrawer.jsx
- src/components/admin/AcquisitionInbox.jsx
- test-ui/BrokerMaterialsCard.test.jsx
- test-ui/OpportunityDrawer.test.jsx
- test-ui/AcquisitionInbox.test.jsx
- test-browser/admin-phase16.spec.js

Modify a backend test from Tasks 1–2 only if the full regression exposes a missing assertion for already-planned behavior. Do not add backend product scope.

### Consumes

- Green Task 1–3 service, route, and card contracts.
- Existing Phase 1 Playwright fixture and route-audit harness in test-browser/admin-phase16.spec.js.
- Existing sm:max-w-3xl drawer, full-height mobile layout, focus trap, focus return, and authoritative Phase 1 route mocks.

### Produces

- Mobile Prepared-only sticky final approval with safe-area padding and non-obscuring content spacing.
- Keyboard viewport behavior that does not cover greeting or Update Preview.
- Final focus/live-region behavior for prepare, regenerate, send, checking, error, and authoritative lifecycle refresh.
- Phase 2 browser acceptance coverage layered onto the existing Phase 1 fixture and request audit.
- Final full server/UI/browser/lint/build verification evidence.

### RED tests to write first

Extend test-ui/BrokerMaterialsCard.test.jsx and integration tests:

1. sticky approval exists only for mobile Prepared state, includes exact recipient and full-width Approve & Send, and is absent for every other presentation.
2. global pause may render the sticky action disabled with a textual reason.
3. sticky bottom padding/safe-area classes prevent content occlusion and focus/scroll handling keeps greeting and Update Preview visible.
4. post-prepare focus moves to review heading; recipient regeneration keeps selector focus; greeting regeneration keeps update/input focus; operator error moves to alert; authoritative lifecycle refresh moves to card status heading; collapse returns to disclosure.
5. background status refresh does not steal focus.
6. Escape closes an open native/custom contact menu before the drawer; existing drawer Escape behavior remains.
7. ambiguous state explicitly announces Do not send another request and exposes no retry/send.

Extend test-browser/admin-phase16.spec.js using the existing Phase 1 fixture rather than a parallel fake app:

1. add brokerMaterials to detail fixtures and stateful prepare/approve handlers; the route audit must reject raw email/copy/policy/deal-key fields and unexpected provider/reconciliation routes.
2. desktop admin Pursues, prepares, reviews exact recipient/provenance/sender/greeting/subject/body, updates greeting without sending, explicitly approves once, and reloads into the existing durable lifecycle.
3. low score/profit warnings remain visible but do not disable approval; a send-only pause does disable send without preventing review.
4. multiple contacts require explicit contactRef selection and regeneration; unverified new fact remains blocked until saved through the existing fact route.
5. unknown approval response enters Checking, performs authoritative GET, exposes no send/retry, and Check Again after GET failure remains read-only.
6. viewer sees permitted preview/lifecycle but no approval authority or mutation.
7. mobile viewport shows Prepared sticky action without covering greeting/body, preserves full-height drawer, and prevents Enter in greeting from sending.
8. Phase 1 Pursue/Watch/Pass, facts, close/focus, and exact request-audit acceptance remain green.

### Exact RED commands

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm exec -- vitest run test-ui/BrokerMaterialsCard.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm exec -- playwright test test-browser/admin-phase16.spec.js --grep "Request Broker Materials"
~~~

Confirm the browser failures are the new missing fixture/workflow behavior and not a broken Phase 1 fixture.

### Minimal implementation steps

1. Add Prepared-only mobile sticky markup/classes using the existing Tailwind breakpoints, env(safe-area-inset-bottom), separator, exact recipient, and full-width button. Add matching bottom padding only while sticky.
2. Add focus refs and explicit focus decisions for user-initiated transitions. Never focus on background refresh.
3. Preserve one stable live region; announce Preparing, Updated, Sending, Checking, and final authoritative status without duplicating content.
4. Complete keyboard guards: approval is never form-default, Enter in greeting only updates, repeated activation is locked, and Escape ordering respects contact menu then drawer.
5. Extend the existing Phase 1 browser fixture with stateful broker-materials authority. Keep the route audit strict and assert request bodies exactly.
6. Exercise desktop admin, viewer, unknown outcome, lifecycle, and mobile keyboard/sticky cases. Reuse the existing drawer and Phase 1 decisions in the same acceptance environment.
7. Run full verification. Fix only defects within the approved Phase 2 or regression scope. If a failure implies schema/product expansion, stop under the global stop condition.

### GREEN verification

Run the focused RED commands until green, then run the complete Phase 2 and repository gates:

~~~sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run check
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run test:browser
git diff --check
~~~

The final whole-phase evidence must include:

- all server tests green;
- all UI tests green;
- complete Playwright suite green at desktop and configured mobile coverage;
- ESLint green with zero warnings;
- production build and prerender green;
- no duplicate provider call in approval/idempotency/ambiguity scenarios;
- Phase 1 direct, bulk, Stage 2, retry, reconciliation, drawer, facts, and browser acceptance green;
- git diff --check clean;
- no migration/schema/provider/reconciliation module added.

### Commit boundary

~~~sh
git add src/components/admin/BrokerMaterialsCard.jsx src/components/admin/OpportunityDrawer.jsx src/components/admin/AcquisitionInbox.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/OpportunityDrawer.test.jsx test-ui/AcquisitionInbox.test.jsx test-browser/admin-phase16.spec.js
git commit -m "Harden Phase 2 broker materials workflow"
~~~

If a backend regression test was necessarily adjusted, stage it explicitly and name the already-approved behavior it proves. Stop and return the commit for one focused review.

### Prohibited scope

- No new product state or responsive redesign outside the existing drawer/card.
- No broad CSS refactor.
- No provider polling, reconciliation mutation, or browser retry.
- No relaxation of route audit, accessibility semantics, or Phase 1 acceptance.
- No schema/migration, dependency upgrade, deployment, or push.

---

## Final phase review after all four task commits

After Task 4 is reviewed, perform one final whole-phase review without adding product scope:

1. Compare the four-commit diff to every acceptance item in the design spec.
2. Confirm each route body is allowlisted and every approval authority comes from authenticated session plus verified signed claims.
3. Trace one preparation call and prove every reachable dependency is read-only.
4. Trace one approval call and prove it crosses the existing durable executor once, persists exact communication before provider work, and cannot retransmit an ambiguous outcome.
5. Trace automated/direct/bulk/Stage 2 paths and prove they retain automated policy and existing scheduling.
6. Inspect SQLite/Supabase parity and confirm there is no schema diff.
7. Re-run npm run check, npm run test:browser, and git diff --check under Node v22.23.2.
8. Record exact pass counts and any environment-only caveat. Do not merge, push, deploy, or start Phase 3 without a separate instruction.

## Expected execution estimate

| Task | Codex wall-clock |
|---|---:|
| Task 1 — preparation domain/projection | 90–120 minutes |
| Task 2 — durable approved-message seam | 105–120 minutes |
| Task 3 — card/drawer integration | 90–120 minutes |
| Task 4 — responsive/browser/regression hardening | 90–120 minutes |
| Focused reviews and final whole-phase verification | 90–150 minutes |
| **Total active Codex wall-clock** | **7.75–10.5 hours** |

The estimate excludes time waiting for human review between the four required gated runs and excludes deployment/provider observation.
