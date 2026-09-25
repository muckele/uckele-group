# Pursue → CIM Autopilot + Canonical Intake Safety

**Status:** Final design specification for owner review

**Date:** 2026-09-24

**Baseline commit:** `b068696d485b4e34caf71a84f52debd8f0a0a8cb`

**Baseline tree:** `2849726e2a331bca2cbd758fb4a8328bdf2d481a`

**Baseline deployment:** owner-confirmed production v129 at the same revision and tree

**Delivery state at design time:** central CIM outreach pause and staged-automation pause remain active

**Work-package shape:** FL-04A Canonical Intake Safety → FL-04B Pursue Autopilot Initial Request → FL-04C Follow-Ups and Same-Broker Batching

**Document type:** architecture and product contract only; this is not an implementation plan

## 1. Executive decision

`Pursue` becomes a durable intent to take the next safe acquisition action. When all required authority is present, that action is enrollment in a new, policy-versioned CIM outreach campaign and preparation of the initial broker-materials request for the first eligible local sending window. When authority is missing or conflicted, `Pursue` still persists, but the opportunity moves to an explicit action-required state and performs no provider work.

The design is additive and fail closed:

1. Existing canonical opportunity, alias, source-observation, freshness-evidence, identity-exception, CRM, communication, suppression, signed-inbound, and delivery seams remain the foundation.
2. A new campaign model separates the acquisition decision from campaign state, logical cadence slots, actual provider transmissions, and shared broker conversations.
3. One active campaign generation is permitted per canonical opportunity. A repeat click, restart, process retry, scheduler overlap, or source re-import cannot create a second generation or a second transmission for a logical slot.
4. A broker conversation may group several campaign generations for a single recipient and carry one batch transmission, but it never merges or aliases the underlying opportunities.
5. Every outbound attempt persists its exact immutable payload, recipient authority, logical slots, CRM communication, and provider idempotency identity before crossing the provider boundary.
6. A provider-ambiguous or provider-pending result is non-retransmittable. Reconciliation may prove acceptance or definitive rejection; elapsed leases, restarts, or operator clicks may not create a new identity and try again.
7. The final send gate uses fresh authority and blocks on reply, materials received, advanced diligence, Watch, Pass, stop, archive, suppression, identity ambiguity, recipient drift, timezone ambiguity, expired campaign, invalid local window, pause, unreadiness, or provider uncertainty.
8. Historical `Pursue` decisions and legacy CIM requests are readable but inert. They are not silently enrolled, backfilled to the new cadence, or unpaused.
9. FL-04A, FL-04B, and FL-04C have separate durable activation controls. All ship disabled and paused. No production deployment, migration, flag change, provider call, or unpause is authorized by this specification.

This design intentionally does not extend the current `deal_hunter_cim_requests` row into an even larger mixed campaign/send record. That row remains the legacy lifecycle authority. New work uses an additive model with compatibility projections, allowing old and new behavior to coexist without silently rewriting history.

## 2. Problem statement

The current repository already contains substantial safety work:

- canonical opportunity IDs and durable aliases;
- exact and conservative high-confidence cross-source matching;
- ambiguity exceptions that block rather than guess;
- freshness and source-observation evidence from FL-01;
- manual broker-materials authority reconstruction, signed previews, and approval-time revalidation;
- canonical CRM ownership and duplicate/supersession guards;
- durable CRM communications and outbox identities;
- Resend idempotency and signed webhook processing;
- request-specific inbound reply aliases and RFC message threading;
- reply, materials, archive, Pass, suppression, delivery, and advanced-diligence terminal checks;
- central and staged-automation pauses; and
- shadow/canary activation evidence.

Those pieces do not yet form the requested product. Today `Pursue` records priority and review state, while the owner must separately prepare and approve a manual initial request. Campaign state and provider attempt state are mixed in `deal_hunter_cim_requests`; automatic legacy cadence is three follow-ups with a global Pacific timezone; the operator-approved cadence is a different five-touch Pacific policy; and the recipient claim serializes all work for one email address. Reusing those semantics unchanged would either preserve the manual gap, suppress legitimate same-broker opportunities, or create an unsafe migration from old campaigns to a new policy.

The target is a coherent owner workflow in which:

- daily imports continuously enrich one canonical opportunity registry;
- `Pursue` is the single owner decision that advances an eligible opportunity;
- the system creates exactly one active campaign generation per canonical opportunity;
- initial and follow-up touches are deterministic, durable, locally timed, and terminal-state aware;
- multiple legitimate requests to one broker are batched without collapsing opportunity identity; and
- the owner can always see whether the next action is queued, blocked, sent, awaiting reply, satisfied by materials, stopped, expired, or unresolved.

## 3. Scope, non-goals, and boundary

### 3.1 In scope

- The FL-04A/B/C product and architecture contract.
- The canonical identity and import guarantees required before outreach.
- `Pursue`, `Watch`, and `Pass` semantics while a campaign exists.
- New campaign, logical-touch, immutable-transmission, conversation, and terminal-authority concepts.
- Exactly-once logical slot behavior under clicks, jobs, restarts, crashes, and overlapping processes.
- Initial request and follow-up cadence through the 21-calendar-day campaign boundary.
- Opportunity-local IANA timezone authority and no-fallback behavior.
- Same-broker batching without identity merging.
- CRM linkage, inbound reply association, materials association, owner-visible state, observability, audit, migration coexistence, rollout gates, rollback, and test strategy.
- Required SQLite and PostgreSQL/Supabase behavioral parity.

### 3.2 Out of scope

- An implementation task list, file-by-file plan, estimates, or coding sequence.
- Any code, schema migration, deployment, live provider call, production validation, data repair, flag mutation, or unpause.
- Native Gmail integration, automatic document extraction, or a provider switch.
- Resolving provider/contact-permission policy under P8-00. That remains a prerequisite to any live-contact stage.
- Reopening or rerunning the August 2026 identity incident repair.
- Weak or probabilistic identity merging merely to increase automation coverage.
- Automatic historical enrollment, campaign copy regeneration after provider uncertainty, or a resend button.
- Treating a publicly visible broker address as contact permission.

### 3.3 Product boundary

The campaign begins with a new post-cutover `Pursue` decision or a separately authorized historical canary enrollment. It ends on reply, verified materials, advanced diligence, Watch, Pass, explicit stop, CRM archive, suppression, unsafe delivery, provider ambiguity requiring investigation, or expiry 21 local calendar days after initial provider acceptance. Later diligence, document analysis, underwriting, lender work, and LOI workflow remain downstream acquisition capabilities.

## 4. Baseline evidence and authority

This design was derived from the owner-confirmed production baseline and the repository at the exact matching tree.

### 4.1 Baseline facts

- `HEAD` is `b068696d485b4e34caf71a84f52debd8f0a0a8cb` and its tree is `2849726e2a331bca2cbd758fb4a8328bdf2d481a`.
- The owner identifies production v129 as this same revision and tree.
- The owner states the durable global CIM outreach and staged-automation pauses are active.
- `docs/operations/current-system-baseline.md` describes an older v127 repair baseline. It remains useful incident history but is not the deployment authority for this work package.
- The optional owner source package is absent from this checkout; the locked decisions in this work package therefore govern wherever older roadmap language differs.

### 4.2 Repository authority reused by this design

| Existing authority | Current responsibility | Decision here |
|---|---|---|
| `cimOpportunityIdentity.js` | URL normalization, listing identities, canonical aliases, conservative evidence comparison, ambiguity exceptions, canonical resolution | Reuse as the only admission boundary; extend contracts only where new evidence types require it |
| FL-01 opportunity/source/freshness storage | Canonical opportunity projection, append-only freshness evidence, current source observations | Reuse; imports never authorize outreach |
| `dealHunterBrokerMaterials.js` | Fresh authority reconstruction, recipient provenance, signed exact preview, approval-time revalidation | Reuse recipient, sender, copy, and blocker derivation; replace per-request manual approval as the normal post-`Pursue` orchestrator |
| CRM canonical ownership and supersession guards | One current CRM owner per canonical opportunity; explicit ambiguity and archived state | Reuse; no send may bypass these guards |
| `acquisitionMaterials.js` | Narrow evidence-backed materials and advanced-diligence predicate | Reuse as the materials terminal authority |
| `crm_communications` and `crm_email_outbox` | Immutable communication identity, exact bodies and addresses, delivery lifecycle, idempotency, provider evidence | Reuse and link from new transmissions |
| `delivery.js` | Resend protected-identity delivery and ambiguous-outcome classification | Reuse as the only live provider seam |
| signed Resend webhook and communication ingestion | Replay-safe event storage, reply alias/RFC assignment, content retrieval, opt-out suppression | Reuse; add campaign/conversation association before any new live stage |
| central CIM outreach pause | Blocks all CIM provider work while leaving review, inbound, and reconciliation available | Preserve as the highest-priority global transmission gate |
| Stage 2 shadow/canary activation | Durable evidence, policy hashes, source checks, provider-call accounting | Reuse activation patterns; do not inherit its score/source cohort as `Pursue` eligibility |
| legacy CIM requests and manual follow-ups | Historical request/provider/follow-up truth under old policies | Preserve read-only compatibility and existing disabled behavior; never silently convert |

### 4.3 Safety incident constraint

The August 2026 incident confirmed twelve retained provider messages across three independently created four-touch sequences after a listing without a URL later acquired a URL and was treated as new. The durable correction is canonical opportunity identity plus retained aliases, not a recipient cap or same-name match. This design therefore treats opportunity identity, campaign generation, and logical touch identity as independent constraints:

- identity prevents one real listing from becoming several opportunities;
- campaign uniqueness prevents one opportunity from owning several active sequences; and
- touch/transmission uniqueness prevents one campaign slot from crossing the provider boundary more than once.

Recipient grouping and batching improve broker experience but are not deduplication substitutes.

## 5. Architecture alternatives

### 5.1 Selected: additive campaign and transmission model

Create new logical authorities for enrollment, campaign generations, conversations, campaign touch slots, immutable transmissions, and terminal revisions. Retain existing canonical and CRM primitives. Project legacy and new lifecycles together for reads, while writes route by explicit policy version.

This costs more up-front modeling than adding fields to `deal_hunter_cim_requests`, but it gives campaign state, cadence slots, actual provider calls, and broker grouping independent identities. It also permits a clean fail-closed migration and eventual legacy retirement.

### 5.2 Rejected: extend `deal_hunter_cim_requests` in place

Adding generation, batch, expanded cadence, and more states to the legacy row would preserve fewer tables, but that row already combines request, provider, delivery, reply, and follow-up state. In-place evolution would make old rows look eligible for new policy, complicate ambiguous-outcome semantics, and preserve the one-recipient claim as an accidental product rule. It is rejected.

### 5.3 Rejected: one campaign per broker conversation

Grouping every opportunity for one broker into a single campaign would make batching simple but would collapse separate listings, source aliases, decisions, materials outcomes, CRM ownership, and terminal reasons. It is precisely the identity mistake this system must avoid. It is rejected.

### 5.4 Rejected: keep `Pursue` manual and automate only follow-ups

This would leave the owner with two separate decisions for one intended action and make initial and follow-up safety use different lifecycle authorities. It is rejected because `Pursue` is explicitly the authorization to take the next safe step, subject to gates.

## 6. Capability map and dependency direction

| Capability | Owns | Depends on | Must not depend on |
|---|---|---|---|
| C1 Canonical intake | Opportunity admission, aliases, ambiguity, source/freshness evidence | Source adapters and identity rules | Campaign or provider state |
| C2 Owner decisions | Pursue/Watch/Pass event and current decision projection | C1, source health, shown revisions | Delivery provider |
| C3 CRM authority | One current CRM record and canonical submission relationship | C1 | Campaign cadence |
| C4 Pursuit enrollment | Idempotent conversion of a new Pursue decision into an enrollment and eligibility projection | C1–C3, recipient/timezone/materials authority | Scheduler or provider call |
| C5 Campaign lifecycle | Per-opportunity generation, policy, state, terminal revision | C4 | Shared broker identity as an opportunity identity |
| C6 Broker conversations | Recipient-scoped communication grouping and reply thread | C5, verified recipient authority | Canonical opportunity merging |
| C7 Cadence and logical slots | Deterministic initial/follow-up slots and due instants | C5, timezone authority, prior acceptance | Provider-specific retry behavior |
| C8 Immutable transmissions | Exact payload, slot membership, communication, outbox, idempotency identity | C6–C7, final gate | Source imports as authorization |
| C9 Inbound and materials | Reply/material assignment, terminal updates, review-required ambiguity | Signed webhooks, communications, C3/C5/C6 | Sender-email-only campaign assignment or terminal changes |
| C10 Activation and operations | Pause, flags, stage evidence, metrics, audit, rollback | C1–C9 health | Implicit deployment or historical state |
| C11 Owner UI | Read-only projection and explicit commands | C1–C10 APIs | Read-triggered reconciliation or provider work |

Dependency direction is one way:

```text
source adapters
  -> canonical intake
  -> owner decision
  -> CRM + enrollment authority
  -> campaign + conversation
  -> cadence slots
  -> immutable transmission
  -> final send gate
  -> provider seam

signed inbound + materials evidence
  -> terminal authority revision
  -> final send gate and owner projection
```

Imports may change canonical evidence and freshness. They may never create an enrollment, campaign, logical slot, transmission, or provider call.

## 7. Invariants

The following are non-negotiable design invariants.

### 7.1 Identity and intake

1. One real opportunity has one immutable canonical opportunity ID.
2. Every accepted source identity is retained as an alias even when stronger evidence appears later.
3. A later URL or listing ID enriches the existing opportunity; it does not replace the older fingerprint alias.
4. Exact alias matches link deterministically. Conservative high-confidence transitions may link only when material evidence agrees. Unresolved similarity, competing plausible candidates, alias conflict, or insufficient durable identity becomes an ambiguity exception. Evidence that proves material distinction is an explicit no-match and may create a separate opportunity when the observation has its own durable stable alias.
5. Same title, broker, revenue, or recipient alone never proves identity.
6. One source row may map to only one canonical opportunity at a time; one canonical opportunity may have many source observations.
7. Re-importing an archived, Passed, Watched, Pursued, or active-campaign opportunity preserves that workflow state.
8. Identity ambiguity blocks enrollment and every send boundary.

### 7.2 Decision and campaign

1. A `Pursue` decision is durable even when downstream work cannot proceed.
2. One canonical opportunity has at most one nonterminal campaign generation.
3. A repeated `Pursue` with the same decision intent returns the existing decision/enrollment/campaign projection.
4. A stopped, expired, or definitively failed campaign never restarts in place. Any permitted restart is an explicit new generation with a new owner intent and complete audit.
5. Reply, verified materials, advanced diligence, Pass, Watch, stop, archive, suppression, unsafe delivery, or provider ambiguity dominates scheduled work.
6. Historical Pursues are not enrollments.

### 7.3 Touch and provider

1. A logical cadence slot is unique within a campaign generation.
2. A slot can be carried by at most one non-cancelled immutable transmission.
3. A provider transmission has one persisted payload digest and one idempotency key bound to that payload.
4. Reusing an idempotency key with different recipient, subject, body, reply alias, tags, or slot membership is rejected before provider work.
5. A transmission in `provider-pending`, `accepted`, or `ambiguous` is never automatically invoked again.
6. An expired claim lease permits another worker to inspect or reconcile. It does not permit another provider call.
7. Definitive failure does not silently reuse a cadence slot. Another attempt requires the explicit reviewed command, a stopped old campaign, and a distinct audited campaign generation with entirely new identities.
8. Every provider invocation has a previously committed CRM communication and outbox/transmission record.

### 7.4 Conversation and batching

1. A conversation groups communication with one verified recipient authority; it is not an opportunity identity.
2. One batch transmission may satisfy one due slot from each of several distinct campaigns.
3. Every batch line item retains its opportunity ID, campaign ID, slot ID, source display facts, and CRM relationship.
4. A reply to a shared conversation stops automatic follow-up for every active campaign in that conversation pending classification. It does not merge the campaigns.
5. Materials are satisfied per opportunity, not per recipient or conversation.

### 7.5 Activation

1. Central pause overrides every capability flag, activation record, admin route, scheduler, and manual path.
2. Inbound processing and reconciliation remain available while outbound is paused.
3. A deploy or migration never changes paused or activation state.
4. A capability cannot activate until all capabilities it depends on have current accepted evidence.
5. Shadow and dry-run modes report `providerCalls: 0` and enforce it structurally.
6. Whenever the production central pause is intentionally inactive, the shared CIM provider boundary remains default-deny and requires a current durable live-provider authorization envelope for the exact path, opportunity/campaign/transmission, policy, cohort, and expiry.
7. Legacy automatic, legacy manual initial, legacy manual follow-up, direct/admin-triggered, new initial, new follow-up, and batch paths all prove that envelope at the same boundary. An old manual approval is provider-inert unless it is the exact separately authorized live work.

## 8. Canonical intake contract — FL-04A

### 8.1 Admission flow

Every admitted Google Sheet row, Deal OS import row, future connector record, or controlled manual observation follows one service boundary:

1. Normalize the source identity and listing URL using the existing canonical normalizers.
2. Derive all available aliases, including the conservative no-URL fingerprint when its evidence requirements are satisfied.
3. Resolve exact aliases.
4. If no exact alias resolves, compare only the conservative material evidence already accepted by the canonical identity policy.
5. If exactly one high-confidence transition exists and no material distinction exists, link the observation and every newly derived alias to that opportunity.
6. If multiple plausible candidates, unresolved similarity, alias conflict, or insufficient durable identity exists, persist an identity exception and block automated admission/outreach for the affected observation.
7. If every candidate comparison is materially distinct and the observation has its own durable stable alias, treat it as a proven separate listing and atomically create a separate canonical opportunity. Material distinction is not itself an ambiguity.
8. If no candidate exists, atomically create the canonical opportunity, aliases, source observations, and freshness evidence. An observation without sufficient durable identity remains blocked rather than receiving a weak synthetic identity.

The admission transaction must rely on database uniqueness and compare-and-set behavior, not in-process locks. Concurrent Sheet and Deal OS imports of the same listing must converge to one opportunity or a durable ambiguity; neither process may independently create a campaign.

### 8.2 Repeat and cross-source imports

- The same source record in the same import run is idempotent.
- A later import is a distinct freshness observation but resolves to the same canonical opportunity.
- A new URL, listing ID, or source ID becomes an additional alias.
- Cross-source records merge only through exact aliases or the conservative transition policy.
- Operator workflow, CRM ownership, campaign state, and historical communications remain attached to the canonical opportunity.
- A record that reappears after source disappearance is a source-state change, not a new opportunity.
- A record reappearing after CRM archive or Pass remains archived/Passed until an explicit owner action changes it.

### 8.3 Import result semantics

Every daily or manual import returns metric families with stable, unambiguous meanings. The families are separate dimensions; a row that exact-matches an opportunity may also update its projection and CRM record.

| Family | Metrics and equation |
|---|---|
| Validation rows | `sourceRows = acceptedRows + rejectedRows` |
| Accepted-row deduplication | `acceptedRows = uniqueAcceptedSourceIdentities + withinImportDuplicateRows` |
| Identity disposition rows | `uniqueAcceptedSourceIdentities = exactMatchRows + transitionMatchRows + newOpportunitySourceRows + identityReviewRows` |
| Distinct canonical projection | For distinct affected opportunity IDs: `affectedCanonicalOpportunities = createdCanonicalOpportunities + updatedCanonicalOpportunities + unchangedCanonicalOpportunities + preservedInertCanonicalOpportunities` |
| CRM projection | Distinct canonical opportunities reported independently as `crmCreated`, `crmUpdated`, `crmUnchanged`, or `crmBlocked` |
| Outreach | `outreachCreated = 0`, `touchesScheduled = 0`, and `providerCalls = 0` for the import operation |
| Immediate safety emission | The import receipt reports `safetyRunId`, `safetyAsOf`, and `safetyEventsEmitted`; it does not claim asynchronous consumption is complete |
| Downstream campaign safety status | A query by `safetyRunId` reports `safetyEventsEmitted = campaignSafetyStops + campaignSafetyReviewRequired + campaignSafetyNoOp + campaignSafetyProjectionPending` as of its timestamp; `NoOp` means no active campaign required a safety transition |

FL-04A commits canonical identity evidence, exceptions, and a durable safety event/outbox record. It does not directly mutate a campaign. The downstream terminal-authority capability consumes that event and records exactly one stop, review-required, or no-op outcome; an unconsumed event remains pending. It may stop or mark an existing campaign action-required. The final send gate also reads current identity exceptions directly, so delayed projection cannot permit a send. Identity-safety propagation may stop outreach; it can never create an enrollment or campaign, create/claim a slot, create a transmission, advance cadence, or call the provider.

The UI must not label a matched or refreshed row as a new deal. Import summaries expose identity review separately from row rejection so operators do not repeatedly re-import ambiguity.

### 8.4 FL-04A activation boundary

FL-04A may be validated with synthetic rows and production-shaped local data while all outbound pauses remain active. Its acceptance is canonical intake convergence and accurate import outcomes, not any campaign or provider behavior.

## 9. Owner decision and Pursue enrollment — FL-04B

### 9.1 Command semantics

The existing protected triage action remains the owner-facing command surface. Its contract evolves so `Pursue` means “record this decision and take the next safe step.” The command includes:

- canonical opportunity ID;
- expected score/freshness/identity revision shown to the owner;
- action (`pursue`, `watch`, or `pass`);
- an idempotency key bound to opportunity, action, actor, and shown revision; and
- optional explicit recipient contact reference when more than one verified candidate exists.

The server owns all other facts. It does not accept client-supplied email bodies, campaign IDs, policy versions, CRM IDs, timezone, eligibility, due time, or provider identity.

### 9.2 Atomic decision behavior

The decision transaction:

1. rechecks required source authority and shown revisions;
2. persists an immutable owner-decision event and updates the current decision projection;
3. creates or returns one pursuit enrollment keyed by that decision event;
4. records a bounded enrollment state and reason codes; and
5. commits before any CRM, scheduler, or provider work.

If the request is replayed with the same idempotency key and payload, the same result is returned. The same key with different action, opportunity, revision, or recipient selection is a conflict. A different key for an already-current equivalent Pursue returns the existing enrollment rather than creating another generation.

### 9.3 Eligibility authority

Enrollment reconstructs current server-side authority using the existing broker-materials loader and terminal predicates. To create a campaign, all of the following must be true:

- canonical identity is resolved and no open identity exception applies;
- the opportunity is current, not removed, not Passed, not Watched, and not CRM archived;
- the Pursue decision remains the current owner decision;
- one verified recipient authority is selected and has not drifted;
- the selected recipient and contact basis match a current approved P8-00 contact-permission policy/cohort, with durable policy hash, evidence/basis revision, and activation scope;
- canonical CRM ownership is unique or can be idempotently created/linked;
- materials are not already received and diligence has not advanced;
- no reply, opt-out, complaint, hard bounce, suppression, or unsafe terminal delivery exists;
- no legacy request or new campaign is active, provider-pending, accepted without terminal resolution, or ambiguous for this opportunity;
- for ordinary automatic enrollment, no prior provider-accepted CIM request or campaign exists for this opportunity; any reviewed restart must use the separate new-generation command and may not be inferred from another Pursue click;
- an authoritative opportunity-local IANA timezone and its evidence exist;
- the campaign policy version and required activation capability exist; and
- the global pause remains a later provider gate even when campaign creation is allowed.

Score may remain visible as a warning and ranking signal. A current owner `Pursue` is the acquisition authorization; the old automatic Stage 2 score threshold and Sheet-only cohort do not override it. Source health, identity, CRM, recipient, compliance, and terminal-state gates still do.

### 9.4 Outcomes

`Pursue` always returns one of these owner-visible projections:

- `queued`: decision persisted; orchestration has not yet completed;
- `waiting-on-eligibility`: a transient authority such as source freshness or activation is not ready;
- `initial-pending`: campaign exists and its initial slot is waiting for an eligible local window;
- `action-required`: decision persists but a bounded owner/admin resolution is required;
- `active-follow-up`: an initial transmission is accepted and a later slot is scheduled;
- `responded`, `materials-received`, `stopped`, `expired`, or `provider-ambiguous`: terminal or intervention state.

No downstream failure rolls back the owner decision. CRM or campaign creation failure leaves the enrollment action-required with retryable orchestration where safe; it does not cross the provider boundary.

### 9.5 Watch and Pass

`Watch` and `Pass` are terminal outbound authorities for the current campaign. Their decision transaction increments terminal authority before scheduled work can claim or send:

- `Watch` stops automation and retains the opportunity for owner monitoring.
- `Pass` stops automation and records the existing canonical disposition semantics.
- Both cancel all pre-provider slots and transmissions.
- Neither deletes communications, campaign rows, provider evidence, aliases, or source observations.
- A later `Pursue` is a new owner decision, but it does not by itself restart prior outreach. If a previous provider-accepted request or campaign exists, the decision remains action-required until the separate reviewed new-generation command is used, restart policy allows it, and no reply/materials/suppression/ambiguous provider authority makes outreach permanently or currently unsafe.

## 10. New durable domain model

The following are logical contracts and recommended storage names. An approved implementation plan may refine column layout without weakening identity, uniqueness, or state semantics.

### 10.1 `deal_hunter_pursuit_enrollments`

One row per immutable owner Pursue decision event.

Required authority:

- enrollment ID and decision-event ID;
- opportunity ID;
- actor and decision timestamp;
- expected and observed identity/freshness/score revisions;
- optional selected contact reference, never a trusted raw client email;
- state (`queued`, `waiting-on-eligibility`, `campaign-created`, `action-required`, `superseded`);
- bounded reason codes and authority digest;
- created/updated timestamps and row version.

Unique constraints bind one enrollment to one decision event. Enrollment rows are never repurposed for another opportunity or generation.

### 10.2 `deal_hunter_cim_campaigns`

One row per canonical opportunity, recipient authority, and campaign generation.

Required authority:

- campaign ID;
- opportunity ID and positive generation number;
- pursuit enrollment ID;
- immutable policy version;
- selected recipient authority ID, normalized recipient fingerprint, provenance code, and authority revision;
- contact-permission policy hash/version, evidence or cohort-basis digest, permission revision, and activation scope;
- canonical CRM submission ID and ownership revision;
- source/freshness authority digest and the policy-relevant source/freshness revisions observed at enrollment;
- authoritative IANA timezone, timezone evidence type/ID, and timezone authority revision;
- state and terminal reason;
- initial provider acceptance instant;
- local expiry instant and derivation metadata;
- terminal authority revision;
- conversation ID when grouped;
- created/updated timestamps and row version.

Constraints:

- unique `(opportunity_id, generation)`;
- at most one nonterminal campaign per opportunity;
- generation is allocated atomically from durable history;
- recipient and policy are immutable after a transmission enters `provider-pending`;
- no accepted or ambiguous legacy request may coexist with a newly active campaign for the same opportunity.

Campaign states are:

- `queued`;
- `waiting-on-eligibility`;
- `initial-pending`;
- `active-follow-up`;
- `action-required`;
- `responded`;
- `materials-received`;
- `stopped`;
- `expired`; and
- `provider-ambiguous`.

Campaign-state semantics are explicit:

| State | Active for unique constraint | Slot/provider behavior | New generation | Allowed next states |
|---|---|---|---|---|
| `queued` | Yes | No claim or provider work; enrollment orchestration may create the initial slot after authority succeeds | Blocked | `waiting-on-eligibility`, `initial-pending`, `action-required`, `stopped` |
| `waiting-on-eligibility` | Yes | No claim or provider work | Blocked | `queued`, `initial-pending`, `action-required`, `stopped` |
| `initial-pending` | Yes | Initial slot may be created/claimed/transmitted when due and gated | Blocked | `active-follow-up`, `action-required`, `responded`, `materials-received`, `stopped`, `provider-ambiguous` |
| `active-follow-up` | Yes | Eligible follow-up slots may be created/claimed/transmitted | Blocked | `active-follow-up`, `action-required`, `responded`, `materials-received`, `stopped`, `expired`, `provider-ambiguous` |
| `action-required` | Yes | No claim or provider work | Blocked until reviewed resolution | A safe pre-provider issue may return to `queued`, `waiting-on-eligibility`, or `initial-pending`; otherwise `responded`, `materials-received`, or `stopped` |
| `provider-ambiguous` | Yes, safety-locked | Reconciliation only; no slot creation, claim, or provider work | Blocked | Only exact reconciliation may move to `active-follow-up`, `action-required`, `responded`, `materials-received`, or `stopped` |
| `responded` | No; terminal | No slot or provider work | Blocked by reply authority | None within the generation |
| `materials-received` | No; terminal | No slot or provider work | Blocked by materials authority | None within the generation |
| `stopped` | No; terminal | No slot or provider work | Automatic restart blocked; explicit reviewed new-generation command may proceed if all current authorities allow | None within the generation |
| `expired` | No; terminal | No slot or provider work | Automatic restart blocked; explicit reviewed new-generation command may proceed if all current authorities allow | None within the generation |

`reply-review-required` is a conversation state. Affected campaigns use `action-required` with reason `reply_review_required`. A definitive provider rejection projects the campaign to `action-required` with reason `provider_definitive_failure`; the failed slot is never reused. If the owner later authorizes another attempt, the old campaign first transitions to `stopped` and the separate reviewed command allocates a new generation and new identities.

### 10.3 `deal_hunter_broker_conversations`

A conversation is a communication boundary for one verified broker recipient authority. It may contain one or many campaigns.

Required authority:

- conversation ID;
- recipient authority ID/fingerprint and immutable normalized address stored under existing privacy controls;
- reply alias token/digest and CRM thread key;
- state (`open`, `reply-review-required`, `responded`, `stopped`, `provider-ambiguous`, `closed`);
- terminal authority revision;
- batching policy version;
- created/updated timestamps and row version.

Conversation membership is explicit and time-bounded. Sharing a broker email never changes opportunity aliases or canonical IDs.

### 10.4 `deal_hunter_cim_campaign_touches`

A touch is a logical cadence slot for exactly one campaign.

Required authority:

- touch ID, campaign ID, and slot key;
- ordinal and kind (`initial`, `follow-up-1`, `follow-up-2`, `follow-up-3`, `weekday-follow-up`);
- raw due instant, window-adjusted due instant, and timezone revision;
- state;
- claim token/digest, claim owner, claimed timestamp, and row version;
- transmission ID when assigned;
- accepted, failed, ambiguous, or cancelled timestamp;
- bounded outcome and terminal reason.

The deterministic touch identity is derived from campaign ID and slot key. Unique `(campaign_id, slot_key)` is the primary duplicate barrier. A weekday slot key contains the opportunity-local calendar date, not the scheduler run time.

Touch states are:

- `scheduled`;
- `claimed`;
- `provider-pending`;
- `accepted`;
- `definitive-failure`;
- `ambiguous`; and
- `cancelled-before-provider`.

`claimed` is safely recoverable only while no provider-pending transition exists. `provider-pending` is deliberately not lease-retryable.

### 10.5 `deal_hunter_cim_transmissions`

A transmission is one exact provider request. It may carry one touch or a batch of touches for the same recipient conversation.

Required authority:

- deterministic transmission ID;
- conversation ID;
- immutable sorted member-touch digest;
- exact recipient/from/reply-to/subject/text/HTML/tags digest and bounded policy metadata;
- CRM communication ID and outbox ID;
- provider idempotency key;
- state (`prepared`, `final-gate-blocked`, `provider-pending`, `accepted`, `definitive-failure`, `ambiguous`, `cancelled-before-provider`);
- provider/message/evidence IDs and timestamps;
- final-gate authority digest and terminal revisions;
- invocation-authority count, fixed at zero or one, and `provider_invocation_authorized_at`; this records consumption of the only permitted call authority, not proof that a socket call occurred;
- created/updated timestamps and row version.

The exact message body remains in the existing protected CRM communication, not duplicated into broad operational logs. The transmission stores the binding digest and references.

The deterministic transmission identity is a hash of the policy version, recipient authority, immutable sorted touch IDs, and payload version. The provider idempotency key is derived from the transmission ID and payload digest. A database uniqueness constraint covers both IDs.

### 10.6 `deal_hunter_cim_transmission_touches`

This join binds each transmitted line item to its campaign slot.

- unique active association per touch;
- immutable opportunity/campaign/touch references;
- display/order metadata sufficient to explain the batch without serving as identity;
- cancellation state for a pre-provider batch rebuild.

If a final gate invalidates one member before provider work, the whole prepared transmission is cancelled because its persisted body can no longer be sent. Eligible members return to `scheduled`, terminal members stop, and a new subset transmission may be prepared. The old immutable payload and cancellation reason remain auditable.

### 10.7 Terminal authority projection

Each opportunity campaign and broker conversation has a monotonically increasing terminal authority revision. Reply, materials, advanced diligence, Watch, Pass, stop, archive, suppression, identity ambiguity, and unsafe delivery writers update the applicable state and increment this revision in the same transaction as their durable evidence.

The sender records the revisions it validated. The final provider-pending transition succeeds only if those revisions and every other claimed authority still match.

## 11. Cadence and time semantics

### 11.1 Policy version

New campaigns use a new immutable policy marker such as `deal-hunter-cim-autopilot-v1`. Legacy automatic and operator-approved markers remain distinct and must not be accepted as this policy.

The new cadence is:

1. initial request at the first eligible local sending instant after campaign readiness;
2. follow-up 1 at initial provider acceptance plus 48 elapsed hours, rolled forward into an eligible local window;
3. follow-up 2 at follow-up 1 provider acceptance plus 72 elapsed hours, rolled forward;
4. follow-up 3 at follow-up 2 provider acceptance plus 96 elapsed hours, rolled forward;
5. after follow-up 3, one follow-up on each subsequent eligible local weekday at the configured campaign send time; and
6. no touch at or after campaign expiry.

Only an accepted provider outcome anchors the next touch. Delivery, open, click, delayed, or scheduler time does not replace the acceptance anchor. Ambiguity schedules nothing.

### 11.2 Eligible local window

The campaign window is Monday through Friday, 08:00 inclusive to 17:00 exclusive in the opportunity's authoritative local IANA timezone.

- A due instant inside the window remains due at that instant.
- A due instant before 08:00 rolls to 08:00 that local date.
- A due instant at or after 17:00 rolls to 08:00 the next eligible weekday.
- A weekend due instant rolls to 08:00 Monday, subject to configured holiday behavior if a later approved policy adds it. No holiday calendar is inferred in v1.
- The initial request follows the same window.
- Scheduler delay does not create a second slot; it claims the already deterministic due slot.

### 11.3 Campaign expiry

Expiry is 21 local calendar days after the initial provider acceptance. Compute it by projecting the acceptance instant into the campaign timezone, adding 21 calendar dates while preserving the local wall-clock time, and converting the result back to an instant under that IANA zone's offset rules. If a daylight-saving transition makes that wall-clock time nonexistent, use the earliest valid instant after the gap; if it is repeated, use the earlier occurrence. Persist both the result and the derivation metadata.

At or after expiry:

- no slot may be claimed or sent;
- untransmitted slots become `cancelled-before-provider` with reason `campaign_expired`;
- the campaign becomes `expired`; and
- later provider lifecycle events update history but do not reopen the campaign.

### 11.4 Timezone authority

No global Pacific fallback is permitted for a new campaign.

Authority precedence is:

1. a current operator-verified IANA timezone fact scoped to the canonical opportunity;
2. a structured source timezone with retained provenance;
3. a deterministic timezone derived from sufficiently specific structured location such as postal code or city/state using a versioned resolver; or
4. action-required `timezone_ambiguous` or `timezone_missing`.

A state alone is insufficient when it spans timezones unless a versioned business rule resolves the specific location without ambiguity. The evidence ID, resolver version, IANA value, and revision are stored on the campaign.

Before the first accepted transmission, a changed timezone authority recomputes untransmitted slots. After initial acceptance, the campaign retains its audit timezone, but any verified correction must stop scheduling and require explicit review rather than silently moving due instants.

## 12. Exactly-once and concurrency design

“Exactly once” here means one logical campaign generation and at most one provider invocation identity for each immutable logical slot set. No distributed system can prove that a remote provider did not accept a request when the response is lost; the safe outcome for that uncertainty is `ambiguous`, never automatic retry.

### 12.1 Database barriers

Correctness relies on durable constraints and compare-and-set transitions in both SQLite and PostgreSQL/Supabase:

- unique owner decision idempotency key plus request digest;
- unique enrollment per Pursue decision;
- unique campaign `(opportunity_id, generation)`;
- at most one active campaign per opportunity;
- unique touch `(campaign_id, slot_key)`;
- one non-cancelled transmission membership per touch;
- unique transmission ID;
- unique provider idempotency key;
- unique CRM communication and outbox idempotency identities;
- unique provider message evidence where already enforced; and
- row-version/expected-state predicates on every claim and terminal transition.

In-process mutexes may reduce contention but never establish correctness.

### 12.2 Claim protocol

1. The scheduler reads due `scheduled` slots in bounded order.
2. A transaction locks/CASes candidate rows, rechecks campaign and conversation terminal revisions, and marks the selected slots `claimed` with a token.
3. The worker constructs the exact single or batch payload from fresh authority.
4. One transaction inserts the immutable transmission, transmission membership, CRM communication, and outbox records, and binds each claimed slot to that transmission.
5. A fresh final-gate transaction locks or CASes every affected campaign, conversation, and slot, rechecks all authority, records the authority digest, changes the transmission and slots to `provider-pending`, sets the invocation-authority count to one, and records `provider_invocation_authorized_at`. This consumes the one permitted invocation authority even if the process crashes before opening a socket.
6. Only the original in-memory execution holding the winning claim token may proceed directly from that commit to the provider seam. No recovery process may invoke the provider for an already consumed provider-pending identity.
7. The response or error durably transitions transmission, communication, outbox, slots, campaigns, and next schedule using accepted, definitive-failure, or ambiguous semantics.

A process crash in steps 1–3 can release/reclaim a lease because no immutable provider-pending transmission exists. A crash after step 5 is reconciliation-only. The persisted marker cannot distinguish “authorized but socket not opened” from “provider invoked but response not recorded,” so the next process must add zero provider calls even if no provider ID is present. A missed touch is safer than a duplicate.

### 12.3 Provider outcomes

| Outcome | Durable treatment | Future provider work |
|---|---|---|
| Accepted with provider ID | Mark transmission and member slots accepted exactly once; anchor next cadence | Next distinct slot only |
| Definitive pre-acceptance rejection | Mark definitive failure; no automatic same-slot retry | Explicit reviewed new generation only |
| Crash after provider-pending but before the provider seam | Preserve provider-pending; durable call authority is consumed even though observed provider calls may be zero | Reconciliation only; recovery adds zero calls |
| Timeout, connection reset, ambiguous HTTP, parse failure, missing provider ID, or crash during/after invocation | Mark or preserve ambiguous/provider-pending; observed provider calls may be one | Reconciliation only; recovery adds zero calls |
| Signed webhook later proves exact acceptance | Reconcile the same transmission to accepted | Next distinct slot if still eligible |
| Exact bounded evidence proves definitive rejection | Reconcile to definitive failure | Still no silent same-slot retry |
| Multiple provider identities match | High-severity ambiguous conflict | No send |

The provider's idempotency feature is a defense in depth, not permission to repeat the call. The local state machine remains no-retry after provider-pending.

A prepared transmission cancelled or blocked before `provider-pending` may be revalidated or safely rebuilt for the same logical slot because invocation authority was never consumed; the cancelled payload remains audited and only one non-cancelled membership may exist. A definitive provider result is different: its slot is terminal, the campaign becomes `action-required/provider_definitive_failure`, and only the reviewed new-generation command can authorize later outreach.

### 12.4 Mandatory reply race

If the scheduler selects a slot and a reply is persisted before the final send gate:

1. inbound processing writes the communication/reply evidence;
2. the applicable conversation becomes `responded` or `reply-review-required`, and affected campaigns become `responded` or `action-required/reply_review_required`;
3. terminal authority revision increments;
4. the final gate's expected revision no longer matches;
5. the prepared transmission becomes `final-gate-blocked` or `cancelled-before-provider`; and
6. provider call count is zero.

The provider-pending transition and terminal-revision comparison are atomic. An inbound event that commits after provider-pending cannot recall a provider request already authorized; it stops all later slots and is reported as a narrow in-flight race.

### 12.5 Overlapping processes

SQLite uses a bounded immediate write transaction plus uniqueness/CAS. PostgreSQL uses row-level locking/CAS and the same uniqueness constraints; advisory locks may reduce contention but are not the sole guard. The two adapters must return equivalent normalized results for winner, already-owned, stale-authority, terminal, provider-pending, and conflict outcomes.

## 13. Final send gate

Immediately before the atomic transition to `provider-pending`, the server reloads authoritative state. Every member campaign in a batch must pass.

The gate rejects provider work when any of the following is true:

- central CIM outreach pause is active;
- the shared CIM provider boundary lacks a current default-deny live-provider authorization envelope for this exact writer path, opportunity/campaign/transmission, policy, cohort, and expiry;
- the capability-specific activation is absent, expired, wrong-policy, or not in its authorized stage;
- delivery provider, sender, signed webhook, inbound receiving, or required reconciliation readiness is unhealthy;
- campaign, conversation, touch, transmission, communication, or outbox state/revision differs from the claim;
- current decision is no longer Pursue;
- Watch, Pass, stop, archive, source removal requiring review, or CRM supersession applies;
- canonical identity is missing, changed incompatibly, or ambiguous;
- required source authority is unhealthy, current-source evidence is absent, discovery remains pending, or a policy-relevant source/freshness revision differs from the enrollment digest;
- recipient address, contact reference, provenance, authority revision, sender, reply-to, subject/body digest, or batch membership differs;
- contact-permission policy/evidence is missing, expired, changed, outside the activated cohort, or no longer matches this recipient and contact basis;
- a prior legacy/new request, campaign, touch, communication, outbox, or provider identity conflicts;
- reply, unsubscribe, complaint, hard bounce, suppression, or unsafe delivery applies;
- materials are received or diligence has advanced;
- timezone is missing/ambiguous/corrected after acceptance;
- current instant is outside the eligible local window;
- due instant has not arrived or campaign has expired;
- recipient/conversation abuse controls require deferral;
- any member of an immutable batch has become ineligible; or
- exact provider outcome is already pending, accepted, or ambiguous.

The gate returns stable reason codes and zero provider work. It never repairs authority by guessing and never mutates a client-supplied payload into compliance.

## 14. Same-broker batching — FL-04C

### 14.1 Product behavior

Five legitimate opportunities with the same broker may all be Pursued on the same day. They remain five opportunities, five CRM relationships, five enrollments, five campaign generations, and five initial logical slots. The system should prefer one well-structured broker email over five separate emails when their eligible windows overlap.

The batch message:

- addresses one verified recipient;
- uses one conversation-specific reply alias;
- identifies each opportunity clearly without exposing internal IDs;
- makes one materials request per opportunity in an unambiguous ordered section;
- retains a machine-readable signed mapping in protected tags/metadata within provider limits;
- has one immutable transmission and CRM communication; and
- links each campaign slot through transmission membership.

### 14.2 Grouping rules

Slots may batch only when all have:

- the same normalized verified recipient authority;
- overlapping eligible local windows at the dispatch instant;
- compatible sender/reply policy and template version;
- no final-gate blocker;
- no prior provider-pending transmission; and
- enough bounded content size to remain within message and provider limits.

Batch size and payload size are bounded. Overflow forms another deterministic batch without dropping opportunities. Batching waits only for a short, configured coalescing interval inside the eligible local window; it cannot delay an opportunity past its next safe window or expiry.

### 14.3 Recipient safety controls

The current one-recipient claim and low logical-touch caps must not become a rule that discards legitimate opportunities. In the new model:

- the recipient/conversation lock serializes preparation and provider calls, not campaign existence;
- safety limits count actual provider transmissions, not opportunity line items;
- batching is the primary mechanism for reducing same-broker volume;
- a safety ceiling defers to a later eligible window and shows the reason; it does not mark opportunities ineligible;
- suppressions, opt-outs, complaints, hard bounces, and provider permission remain hard stops; and
- a release owner may lower activation caps during canary without changing campaign identity or policy.

### 14.4 Reply semantics for a batch

A signed reply alias or RFC reply to a batch conversation stops automatic follow-up for every active campaign in that conversation before content classification. The inbound communication is attached to the conversation and all candidate campaign IDs, but opportunity-level outcomes remain separate:

- an explicit response/material attachment for one listing marks that campaign responded/materials-received;
- an explicit response covering several marks each identified campaign;
- a general broker reply marks all conversation campaigns responded;
- an unclear but likely relevant reply leaves the conversation `reply-review-required` and all affected campaigns `action-required/reply_review_required`; and
- unrelated email from the same broker, without an exact alias/thread/tag signal, does not auto-stop or auto-assign.

Automatic follow-up does not resume merely because an operator classified a reply as relevant to only one item. Any resume for another item is an explicit reviewed action against that campaign and must not reuse an old slot/transmission identity.

## 15. Inbound, materials, and terminal authority

### 15.1 Correlation order

Inbound assignment is deterministic and conservative:

1. exact signed conversation/request reply alias;
2. exact provider message/thread identity;
3. exact RFC `In-Reply-To` or `References` parent;
4. exact protected campaign/transmission tags from a signed provider event;
5. explicit valid canonical CRM submission identity; then

6. sender-email matching only as a bounded candidate for operator review.

Sender email alone never assigns an inbound message to a campaign, changes terminal reply state, or stops outreach, even when exactly one campaign currently exists for that sender. Automatic terminal association requires an exact signed reply alias, exact provider/RFC thread evidence, exact protected campaign/transmission tag, or another independently validated campaign-specific token. A sender match may help rank a review queue and nothing more.

Signed webhook replay is idempotent. Event storage and terminal-authority changes are monotonic; an older event cannot reopen outreach.

### 15.2 Reply state

Reply evidence is stored before content retrieval completes. A valid reply alias is sufficient to stop outreach even if the provider content fetch fails and retries later. This preserves the current safe behavior.

For new campaigns, the reply writer atomically:

- inserts/reuses the inbound event and communication;
- assigns the conversation and exact candidate campaigns;
- increments terminal authority;
- cancels all scheduled/claimed pre-provider slots;
- sets applicable campaigns to `responded` or action-required review; and
- records bounded CRM activity.

### 15.3 Materials state

The existing `evaluateAcquisitionMaterialsState` predicate remains the only generic materials/advanced-diligence authority. A verified prospectus URL, completed relevant upload request, checklist evidence, secure material document, or accepted pipeline/diligence stage may satisfy it.

New campaign integration adds explicit provenance from an inbound communication or upload to the canonical opportunity. For a shared broker conversation:

- materials are evaluated for each opportunity;
- exact listing labels, upload tokens, conversation sections, or operator verification establish assignment;
- likely materials with unclear opportunity assignment stop the affected conversation and create action-required review;
- no attachment is copied to every opportunity merely because the broker is shared; and
- materials received for one opportunity do not merge or complete the others.

### 15.4 Other terminal writers

The following writers must call the same campaign terminal-authority service rather than setting disconnected flags:

- Watch and Pass;
- CRM archive and canonical CRM supersession;
- explicit campaign stop;
- email opt-out, unsubscribe, complaint, hard bounce, or provider suppression;
- materials and advanced-diligence transitions;
- identity ambiguity/conflict discovered after enrollment;
- corrected recipient/timezone authority that invalidates an accepted campaign contract; and
- provider ambiguity.

## 16. CRM relationship

### 16.1 One canonical CRM owner

`Pursue` must ensure or link exactly one current CRM submission for the canonical opportunity through the existing canonical ownership and supersession guards. A title/email lookup does not establish ownership. CRM ambiguity leaves enrollment action-required and performs no provider work.

The campaign stores the canonical submission ID and ownership revision. Every final send revalidates that it has not become an archived loser or been superseded.

### 16.2 Communications

Every outbound transmission creates one immutable CRM communication before provider work. A batch communication references its conversation and includes protected membership references to each campaign/opportunity. Owner-facing CRM history can show the one email under each linked opportunity without cloning the provider message or body into several independently mutable communications.

Inbound messages belong primarily to a conversation/thread and secondarily to one or more classified opportunities. The UI must distinguish:

- one shared broker message linked to several opportunities;
- separate materials outcomes per opportunity; and
- unassigned/review-required inbound content.

### 16.3 Read paths

GET/detail/list operations are read-only projections. They must not reconcile, claim, start, stop, or send as a side effect. Reconciliation uses explicit internal jobs or protected commands and retains no-send semantics.

## 17. API and UI contract

### 17.1 Command APIs

The exact route names may remain compatible with the existing app, but the semantic boundaries are:

- `POST` owner decision: Pursue, Watch, or Pass with expected revisions and idempotency key.
- `POST` explicit campaign stop: campaign ID, expected version, bounded reason.
- `POST` reviewed new generation: only for a terminal campaign when restart rules permit it; never exposed as Retry/Resend.
- `POST` historical canary enrollment: separately protected release-owner action with exact opportunity selection and activation evidence.
- internal scheduler claim/finalize commands: server-owned inputs only.
- internal signed inbound/reconciliation commands: exact provider evidence only.

Commands return current authoritative projections, not raw claim tokens, secrets, provider payloads, recipient lists, or internal email bodies.

### 17.2 Query projections

Opportunity detail exposes:

- owner decision and timestamp;
- canonical identity and source freshness summary;
- recipient readiness with redacted provenance, not a raw address for non-admin viewers;
- CRM link/ambiguity;
- campaign generation, policy, state, and bounded reason;
- local timezone and next eligible local action;
- touch timeline and provider outcome without resend controls;
- broker conversation/batch membership;
- reply/materials/advanced-diligence terminal evidence;
- provider ambiguity and reconciliation-only instruction; and
- activation/paused status.

Queue rows expose only scan-ready state such as `Initial pending`, `Follow-up due`, `Action required`, `Reply received`, `Materials received`, `Stopped`, `Expired`, or `Outcome unresolved`.

### 17.3 Owner interaction

- A successful Pursue immediately changes the owner decision even if campaign orchestration is queued.
- If recipient choice is ambiguous, the owner is asked to choose among server-issued opaque contact references.
- “Immediate” means the next eligible opportunity-local window after safety gates, not necessarily synchronous provider work during the click.
- No UI displays `Retry`, `Send Again`, or `Regenerate` for a provider-pending or ambiguous transmission.
- “Check status” is read-only reconciliation status.
- A new generation action is clearly distinguished from retrying an old transmission and shows prior campaign history.
- Batch history makes clear that one broker email covered several separate opportunities.

### 17.4 Stable reason codes

At minimum, action-required and gate responses distinguish:

- `identity_ambiguous`, `identity_unavailable`;
- `source_authority_unhealthy`, `freshness_changed`;
- `crm_missing`, `crm_ambiguous`, `crm_archived`, `crm_superseded`;
- `recipient_missing`, `recipient_ambiguous`, `recipient_changed`, `recipient_suppressed`;
- `contact_permission_missing`, `contact_permission_expired`, `contact_permission_changed`, `contact_permission_outside_cohort`;
- `timezone_missing`, `timezone_ambiguous`, `timezone_changed`;
- `materials_received`, `advanced_diligence`, `reply_received`;
- `watch_selected`, `pass_selected`, `campaign_stopped`, `campaign_expired`;
- `legacy_request_active`, `active_campaign_exists`;
- `outside_send_window`, `safety_deferred`;
- `outreach_paused`, `live_provider_not_authorized`, `capability_disabled`, `provider_not_ready`;
- `provider_pending`, `provider_ambiguous`, `provider_definitive_failure`; and
- `stale_command`, `payload_conflict`, `concurrent_winner`.

## 18. Legacy policy convergence and migration safety

### 18.1 Classification

Every request/campaign read is explicitly classified:

- `legacy-auto` — old three-follow-up automatic policy;
- `legacy-operator-approved` — old five-follow-up manual approval policy;
- `autopilot-v1` — this design; or
- `unknown-policy` — action-required and never scheduled.

Mode alone is insufficient. The exact policy version and durable marker must match.

### 18.2 Coexistence

- Existing tables and rows remain intact.
- New schema is additive and nullable from the perspective of old read paths.
- Compatibility projections combine legacy and new history for the owner without allowing one writer to mutate the other's lifecycle.
- Existing automatic follow-up remains disabled and centrally paused.
- Existing operator-approved campaigns retain their current explicit/manual semantics; they are not promoted into autopilot.
- New enrollment checks legacy rows for active, accepted, pending, or ambiguous authority and blocks a conflicting campaign.
- Historical provider IDs, bodies, communications, webhooks, claims, aliases, repair receipts, and audit events are never deleted or rewritten.

### 18.3 Historical Pursue decisions

Existing high-priority/reviewed records that represented old `Pursue` are displayed as `Historical Pursue — not enrolled`. The migration does not create enrollment rows, CRM records, campaigns, slots, conversations, transmissions, or provider work for them.

A release owner may select one historical opportunity for a controlled canary only through the separately protected historical-enrollment command after revalidating all current authority. That creates a new enrollment and generation with explicit canary provenance.

### 18.4 Expand/contract sequence

This specification authorizes no migration, but any later approved implementation must follow expand/contract discipline:

1. expand with new tables/constraints/read adapters while all capabilities remain disabled;
2. prove SQLite/PostgreSQL parity and legacy readability;
3. enable synthetic writes only;
4. enable new Pursue enrollment without provider calls;
5. enable bounded initial-send canary;
6. enable follow-ups, then batching, each separately;
7. observe zero legacy writer use and no active legacy scheduling for an agreed window; and
8. retire legacy code only under a separate owner-approved plan with rollback evidence.

No step infers the next step's authorization.

### 18.5 Retirement candidates

After safe replacement and measured zero use, a later plan may retire:

- the legacy automatic 48/72/96 three-follow-up scheduler and its stale-claim retry path;
- the operator-approved follow-up cadence as the normal path for new Pursues;
- recipient-wide claim semantics that block unrelated opportunities rather than serializing transmissions;
- separate prepare/approve as the routine post-Pursue flow, while retaining preview/audit services; and
- read-side reconciliation effects in opportunity detail.

They are not removed by this work package and remain disabled or compatibility-only until explicit retirement approval.

## 19. Rollout and activation

### 19.1 Capability flags and durable activation

Use separate default-off capabilities:

- canonical intake enforcement/reporting;
- Pursue enrollment;
- initial autopilot transmission;
- follow-up scheduling/transmission; and
- same-broker batching.

Durable activation records bind mode, campaign policy hash, contact-permission policy hash/evidence revision, allowed recipient/contact-basis cohort, expiry, actor, confirmation text, and prerequisite evidence. The final gate proves the current campaign still matches that exact permission scope. Environment configuration may impose a harder off switch but cannot independently authorize live work.

Separately, the shared production CIM provider boundary requires a durable live-provider authorization envelope whenever the global pause is off. The envelope is default-deny and names the exact admitted writer path and immutable work identity. It covers every legacy and new CIM provider path, including legacy automatic, legacy manual initial, legacy manual follow-up, direct/admin-triggered, new initial, new follow-up, and batch sends. A syntactically valid legacy approval, stale activation, or enabled scheduler remains provider-inert unless it matches an explicit live envelope. Ordinary non-CIM application email is outside this CIM-specific boundary and retains its existing authority.

The central CIM outreach pause remains active through schema deployment, synthetic validation, shadow, and controlled mailbox stages. Removing it is a separate explicit owner action after all live prerequisites pass.

### 19.2 Work-package stages

#### FL-04A — Canonical Intake Safety

- canonical convergence across repeat and cross-source imports;
- ambiguity review and archive-state preservation;
- accurate import result semantics;
- no campaign or provider work.

#### FL-04B — Pursue Autopilot Initial Request

- durable Pursue enrollment and action-required states;
- unique campaign generation;
- CRM/recipient/timezone authority;
- immutable initial transmission and final gate;
- no automatic follow-ups until FL-04C is separately accepted.

#### FL-04C — Follow-Ups and Same-Broker Batching

- accepted-at cadence through 21 local calendar days;
- terminal-authority scheduler behavior;
- broker conversations and batch transmissions;
- recipient safety controls that defer/group rather than discard opportunities.

### 19.3 Evidence ladder

Each capability advances through these stages independently:

1. **Synthetic unit/integration:** local deterministic clocks, fake provider seam, real SQLite constraints, disposable PostgreSQL parity where available.
2. **Shadow/dry-run:** production-shaped reads and persisted decisions where safe; zero CRM/provider mutation beyond explicitly synthetic/local stores; `providerCalls: 0`.
3. **Controlled mailbox:** a structurally isolated non-production provider account/configuration restricted to owner-controlled recipient addresses, with exact signed webhooks, reply race, materials classification, restart, and ambiguity drills. It cannot invoke the production CIM provider path, and the production central pause remains active with no exception.
4. **One real canary:** exactly one current, permission-approved opportunity selected by the release owner; one initial transmission maximum; follow-ups and batching remain off.
5. **Bounded pilot:** small daily transmission cap, current policy hash, short activation expiry, live observability, automatic pause on invariant breach.

P8-00 provider/contact permission, sender authentication, signed webhook readiness, durable storage, canonical intake health, CRM uniqueness, and current pause/rollback controls are prerequisites to stages 4 and 5. A real canary cannot bypass an active production central pause. It requires a separate explicit, time-bounded, audited owner action to change that pause and a default-deny live-provider envelope admitting only the exact canary transmission. Every other legacy, manual, direct, scheduled, initial, follow-up, and batch path remains provider-inert even if it possesses older approval state. Restoring the central pause is part of canary completion and incident containment.

### 19.4 Promotion gates

Promotion requires all of the following for the capability being advanced:

- full automated suite and database parity green;
- no identity ambiguity in the selected cohort;
- no legacy active/ambiguous conflict;
- current sender/provider/inbound readiness;
- deterministic payload and idempotency proof;
- concurrency and crash-boundary evidence;
- opportunity-local timezone proof;
- reply/materials race proof;
- zero unexpected provider calls in earlier stages;
- current activation and pause evidence;
- owner review of copy, permission, cohort, caps, and rollback; and
- an immutable release/activation audit record.

### 19.5 Rollback

Rollback is operationally simple and data preserving:

1. set the central outreach pause;
2. disable the affected capability activation;
3. leave inbound processing and reconciliation active;
4. stop schedulers from claiming new slots;
5. preserve every enrollment, campaign, slot, transmission, communication, event, provider ID, and ambiguity;
6. reconcile provider-pending/ambiguous work without retransmission; and
7. if necessary, run the previous application against the additive schema, with new rows visible only through compatibility-safe reads.

Rollback never deletes a campaign, reopens a cadence slot, clears provider-pending, rewrites an idempotency key, or re-enables a legacy scheduler.

## 20. Observability and audit

### 20.1 Required durable events

Record bounded, append-only audit for:

- source admission and identity resolution method;
- identity ambiguity creation/resolution;
- owner decisions and idempotent replays;
- enrollment state changes and reason codes;
- campaign generation and policy selection;
- recipient/contact-permission/source-freshness/timezone/CRM authority selection and revision changes;
- touch creation, claim, release, cancellation, and due calculation;
- batch formation and membership;
- final-gate decision and authority digest;
- provider-pending, accepted, definitive-failure, and ambiguous transitions;
- signed inbound/reply/material assignment and terminal revision;
- pause, activation, live-provider authorization envelope, canary, and rollback actions; and
- reconciliation evidence and result.

Do not place raw message bodies, attachments, full recipient addresses, secrets, claim tokens, signed previews, or provider payloads in general logs.

### 20.2 Metrics

At minimum:

- canonical match/new/ambiguity counts by source and rule version;
- active campaign count by state/policy/generation;
- action-required counts by reason;
- scheduled/claimed/provider-pending/accepted/failed/ambiguous touches;
- provider calls and accepted transmissions by capability stage;
- duplicate-prevention conflicts and concurrent winners;
- final-gate block counts by reason;
- reply/materials stop latency;
- batch size, opportunities per transmission, and transmissions per recipient window;
- timezone missing/ambiguous/corrected counts;
- contact-permission missing/expired/changed/outside-cohort counts;
- legacy active/ambiguous rows and legacy writer invocation count;
- oldest provider-pending/ambiguous age;
- central/capability pause and activation expiry; and
- live-provider authorization accepts/rejects by writer path, with no sensitive payload data.

### 20.3 Alerts and automatic containment

High-severity conditions automatically preserve evidence and pause the affected capability or all CIM outreach:

- more than one provider identity for one transmission;
- provider call without committed transmission/communication/outbox authority;
- more than one active campaign for an opportunity;
- more than one accepted transmission for a logical touch;
- alias collision or identity ambiguity in an active campaign;
- unexpected legacy scheduler/provider invocation;
- reply or materials persisted before final gate followed by a provider call;
- invalid/missing timezone on a claimed touch;
- activation expired but provider work attempted;
- any CIM provider path reaches the provider seam without an exact current live-provider authorization envelope while the global pause is off;
- signed inbound or reconciliation readiness loss during a live pilot; or
- observed provider calls in shadow/dry-run.

## 21. Failure-mode behavior

| Failure | Required result |
|---|---|
| Two rapid Pursue clicks | One decision/enrollment/campaign; second response reports existing authority |
| Two scheduler processes claim one slot | One durable winner; loser performs zero provider work |
| Process dies after claim but before immutable transmission | Safe lease recovery; same touch identity |
| Process dies after transmission persistence but before provider-pending | Revalidate same immutable transmission or cancel before provider; no new payload identity without reason |
| Process dies after provider-pending but before opening a socket | The one invocation authority is already consumed; observed provider calls may be zero; recovery adds zero calls |
| Process dies during/after provider invocation before result persistence | Observed provider calls may be one; preserve pending/ambiguous and recovery adds zero calls |
| Provider accepts but response is lost | Ambiguous until exact signed/provider evidence reconciles acceptance |
| Provider returns definitive rejection | Definitive failure; no silent retry or schedule anchor |
| Reply persists after scheduler selection | Terminal revision blocks final gate; zero provider calls |
| Reply persists after provider-pending | Stop later slots; record narrow in-flight race |
| Materials arrive for one item in batch | Stop/satisfy that campaign; shared reply stops remaining automation pending classification |
| Generic email arrives from broker with five opportunities | Unassigned/review-required unless exact alias/thread evidence exists |
| Recipient authority changes before initial send | Cancel prepared payload; action-required/reprepare with new digest |
| Recipient authority changes after acceptance | Stop campaign; explicit reviewed new generation if policy permits |
| Timezone missing or ambiguous | Action-required; no fallback, claim, or send |
| Source re-import finds active campaign | Enrich canonical evidence only; do not create/advance campaign |
| Archived or Passed listing reappears | Preserve inert state and report it |
| Identity ambiguity appears after enrollment | Stop/cancel before provider; action-required |
| Batch member fails final gate | Cancel whole prepared batch; rebuild from still-eligible slots before provider |
| Safety ceiling reached | Defer/group; do not discard opportunities |
| Central pause active | Zero provider calls from every path; inbound/reconciliation continue |
| Central pause explicitly off for one canary | Shared default-deny CIM boundary admits only the exact live-provider envelope; all legacy/manual/direct/nonselected paths perform zero provider work |
| Old application version runs during rollback | Additive schema tolerated; new campaigns remain paused and are not treated as legacy requests |

## 22. Test strategy and acceptance scenarios

Tests use deterministic clocks and provider fakes for normal CI, real SQLite transactions for local concurrency, and disposable PostgreSQL/Supabase for parity-critical transitions. Controlled mailbox and real-canary tests are separate release evidence, not ordinary CI.

### 22.1 Canonical identity and daily intake

1. A no-URL Sheet listing imported twice creates one opportunity and two freshness observations.
2. The same listing later gains a URL; its old fingerprint alias and new URL/listing aliases resolve to one opportunity.
3. Concurrent Sheet and Deal OS admission converges to one canonical opportunity or one durable ambiguity.
4. Same title, broker, and revenue with materially conflicting geography and separate durable aliases creates two canonical IDs with no open ambiguity exception.
5. Exact syndicated listing IDs across sources merge and retain both source aliases.
6. Insufficient cross-source evidence creates review-required ambiguity and no campaign effects.
7. Re-imported Passed opportunity remains Passed.
8. Re-imported archived CRM opportunity remains archived and outreach-inert.
9. Re-imported active campaign opportunity updates source evidence only.
10. Import receipt equations reconcile validation, deduplication, identity, canonical, and CRM families; its `safetyRunId` status eventually reconciles every emitted event to stop, review-required, no-op, or pending as of the reported timestamp.
11. Every import and downstream safety-consumer path asserts zero enrollments, campaigns, slots, transmissions, and provider calls created or advanced; only stop/review terminal transitions are permitted, and the import reports `outreachCreated === 0` and `touchesScheduled === 0`.
12. The August incident transition fixture produces one opportunity and cannot create three campaign generations.

### 22.2 Pursue enrollment and CRM

13. Pursue persists the decision before CRM/campaign orchestration and returns queued/initial-pending.
14. Missing recipient persists Pursue and returns action-required without a campaign transmission.
15. Multiple verified recipient candidates require an opaque server-issued contact reference.
16. Stale contact reference or changed provenance is rejected.
17. CRM exact canonical owner is reused.
18. CRM ambiguity or superseded loser blocks campaign creation/provider work.
19. Two rapid identical Pursue commands create one enrollment and one generation.
20. Same idempotency key with different payload is rejected.
21. A new idempotency key for the same current Pursue returns existing authority.
22. Historical Pursue rows remain not-enrolled after schema/read upgrade.
23. Explicit historical canary enrollment requires exact activation and creates only one new generation.
24. Watch or Pass atomically terminalizes the active campaign and cancels untransmitted slots.
25. An opportunity with any prior provider-accepted request persists a new Pursue as action-required and cannot restart without the explicit reviewed new-generation command.

### 22.3 Timezone and cadence

26. California opportunity uses `America/Los_Angeles`; New York uses `America/New_York`; Arizona uses `America/Phoenix` without DST drift.
27. Missing or ambiguous timezone blocks initial and follow-up claims.
28. Initial readiness before 08:00 rolls to 08:00 local; after 17:00 rolls to next weekday.
29. Friday/weekend due times roll to Monday 08:00 local.
30. Follow-up 1 derives from initial accepted-at plus 48 elapsed hours, then window roll.
31. Follow-up 2 derives from follow-up 1 accepted-at plus 72 hours.
32. Follow-up 3 derives from follow-up 2 accepted-at plus 96 hours.
33. Post-follow-up-3 creates one deterministic slot per subsequent eligible local weekday.
34. DST spring gap and fall repetition follow the specified resolution rules.
35. No slot is claimed or sent at/after the 21-local-calendar-day expiry.
36. Provider ambiguity creates no next slot.

### 22.4 Concurrency and exactly-once

37. Two SQLite processes racing a campaign generation produce one winner.
38. Two PostgreSQL transactions racing the same slot produce one winner with normalized parity.
39. Claim lease expiry before transmission persistence safely reclaims the same touch.
40. Crash after immutable transmission persistence never creates a different payload under the same idempotency key.
41. Crash after provider-pending but before the provider seam may leave observed provider calls at zero; recovery performs zero additional calls and reconciliation remains the only path.
42. Crash during or after provider invocation but before durable response may leave observed provider calls at one; recovery performs zero additional calls and reconciliation remains the only path.
43. Accepted result finalization is idempotent and anchors the next slot once.
44. Signed webhook replay/out-of-order events do not duplicate acceptance or reopen state.
45. A key reused with changed body, recipient, reply-to, tag, or batch membership fails before provider work.
46. Multiple matching provider IDs produce high-severity ambiguity and no resend.
47. Legacy stale-claim behavior cannot authorize an autopilot touch.
48. Definitive rejection terminalizes the slot and projects `action-required/provider_definitive_failure`; ordinary Pursue cannot restart it, and only the reviewed command stops the old generation and atomically allocates the next generation with new identities.

### 22.5 Terminal authority and mandatory race

49. Scheduler selects a due slot, reply persists, final gate runs, and provider call count is zero.
50. Materials persist between claim and final gate; provider call count is zero.
51. Pass, Watch, archive, suppression, identity ambiguity, recipient drift, timezone drift, or pause between claim and gate each yields zero provider calls.
52. Required-source health failure, current-source absence, discovery-pending state, or a policy-relevant freshness revision change between claim and gate each yields zero provider calls; delayed downstream projection cannot weaken the direct final-gate read.
53. Contact-permission policy expiry, evidence revision change, contact-basis mismatch, or cohort removal between claim and gate each yields zero provider calls.
54. Valid reply alias stops outreach before content retrieval succeeds.
55. Unrelated same-broker email without exact correlation does not auto-stop a campaign, even when it is the broker's only current campaign; sender matching creates at most a review candidate.
56. Ambiguous same-broker inbound is review-required and fails closed.
57. Advanced diligence stops every untransmitted slot.
58. Central pause blocks direct, scheduled, admin-triggered, canary, and batch provider paths while inbound remains functional.

### 22.6 Same-broker batching

59. Five distinct opportunities for one broker remain five canonical IDs, campaigns, and initial slots.
60. Eligible overlapping slots create one batch transmission and one provider call.
61. Batch communication is visible from every member opportunity without cloning provider identity.
62. One ineligible member before final gate cancels the immutable batch; a safe subset is rebuilt and sent once.
63. Payload-size overflow produces deterministic bounded batches without dropping a slot.
64. Recipient safety ceiling defers excess transmissions rather than marking opportunities ineligible.
65. Reply to the shared alias stops every active conversation campaign pending classification.
66. Materials clearly labeled for one opportunity satisfy only that opportunity.
67. Unclear attachments stop and create review-required state without assigning them to all opportunities.

### 22.7 Legacy, rollout, and rollback

68. Legacy automatic, legacy operator-approved, autopilot, and unknown policies classify distinctly.
69. Existing legacy accepted/ambiguous request blocks a new campaign for the opportunity.
70. Deploying additive schema changes no pause or activation state.
71. FL-04A synthetic/shadow runs report zero provider calls.
72. FL-04B initial capability cannot authorize follow-ups.
73. FL-04C follow-up activation cannot bypass central pause.
74. Isolated controlled-mailbox configuration accepts one transmission, ingests signed sent/delivered/reply events idempotently, stops later slots, and cannot reach the production CIM provider path.
75. One-real-canary activation admits exactly the selected permission-approved opportunity, requires an explicit audited production-pause transition, and expires as configured.
76. Rollback pause stops new claims while preserving inbound and reconciliation.
77. Old-version compatibility reads do not treat new campaign rows as legacy requests or schedule them.
78. Unknown policy/version is action-required and provider-inert.
79. All migrations and state adapters preserve communications, aliases, provider IDs, and incident repair receipts byte-for-byte where untouched.
80. With the production pause explicitly changed for a canary, legacy automatic, legacy manual initial, legacy manual follow-up, direct/admin, nonselected new initial, follow-up, and batch invocations all stop at the default-deny provider boundary; only the exact selected canary transmission reaches the provider seam once.

### 22.8 Acceptance criteria

FL-04A is acceptable when scenarios 1–12 and parity/migration checks pass with zero outreach side effects.

FL-04B is acceptable for controlled mailbox when scenarios 13–58 and 68–74 pass, the production central pause remains active, the mailbox/provider path is structurally isolated from production and recipient-restricted, and provider/contact permission is documented.

FL-04B is acceptable for one real canary only after controlled-mailbox evidence, owner copy review, P8-00 acceptance, signed inbound readiness, exact cohort activation, rollback rehearsal, one-transmission cap, and scenarios 75 and 80 prove the default-deny live-provider boundary.

FL-04C is acceptable for controlled mailbox when scenarios 26–67 and 68–74 pass. It is acceptable for a bounded pilot only after FL-04B real-canary evidence, scenario 80 is extended to the bounded cohort, and separate follow-up/batching owner activation.

## 23. Security and privacy

- All owner commands remain behind existing protected admin authorization and CSRF/session controls.
- Provider webhooks require existing signature verification and replay-safe event identity.
- Client inputs never supply trusted recipient addresses, email bodies, CRM ownership, timezone, due times, campaign policy, provider IDs, or gate results.
- Recipient addresses and message bodies remain in existing protected storage and role-scoped projections; general telemetry uses redacted provenance, fingerprints, counts, and suffixes only where operationally necessary.
- Signed contact references and preparation artifacts are short-lived, opportunity-bound, authority-revision-bound, and digest-bound.
- Batch metadata includes only bounded provider-safe identifiers/tags; internal IDs are not placed in visible message copy.
- Logs and audit events exclude secrets, session tokens, claim tokens, signed artifacts, raw provider payloads, attachments, and arbitrary source metadata.
- Suppression and explicit opt-out dominate every campaign and conversation.
- Any production provider use still requires the separate provider/contact-permission determination.

## 24. Reuse, adapt, add, and retire map

### 24.1 Reuse unchanged in principle

- Canonical URL/listing normalization, alias storage, evidence comparison, and ambiguity exceptions.
- FL-01 source observations, freshness evidence, and canonical opportunity projection.
- Canonical CRM ownership and supersession checks.
- Acquisition materials predicate.
- CRM communication lifecycle, signed inbound webhook storage, RFC threading, and opt-out suppression.
- Resend protected-identity provider seam and ambiguous-outcome classification.
- Global outreach pause and read-only reconciliation posture.
- Stage 2 concepts of durable activation, policy hash, shadow evidence, and provider-call accounting.

### 24.2 Adapt behind stable boundaries

- Broker-materials authority loader becomes campaign enrollment/final-gate input.
- Signed preview/contact-reference logic supports owner recipient selection and immutable autopilot payload construction.
- Inbound assignment targets conversation and campaigns before falling back to CRM submission review.
- Triage action response includes enrollment/campaign projection.
- Opportunity detail becomes a pure read projection across legacy and new lifecycles.
- Recipient claims become short-lived transmission serialization, not a ban on several opportunities.
- Operational caps count provider transmissions and defer/group safely.

### 24.3 Add

- Pursuit enrollment authority.
- Campaign generations and terminal revisions.
- Opportunity-local timezone authority contract.
- Logical campaign touch slots.
- Immutable single/batch transmissions and membership.
- Broker conversation grouping.
- Final send-gate service shared by initial and follow-up transmissions.
- New policy-specific scheduler and reconciliation projection.
- Capability-specific activation and owner-visible action-required reasons.

### 24.4 Retire only after measured replacement

- Legacy automatic follow-up scheduler and stale provider-attempt reclaim semantics.
- Manual approval as the default after a new Pursue.
- Mixed campaign/provider state in `deal_hunter_cim_requests` for new work.
- Recipient-wide exclusion as a product policy.
- Any detail GET path that mutates lifecycle state.

## 25. Decisions settled by this specification

1. **Campaign model:** additive, generation-based, per canonical opportunity.
2. **Pursue meaning:** durable owner intent plus next safe action, not merely a priority label.
3. **Initial send timing:** first eligible opportunity-local weekday window after readiness.
4. **Follow-up anchor:** prior provider acceptance, never scheduler or delivery time.
5. **Timezone:** evidence-backed IANA zone per opportunity; no Pacific fallback.
6. **Expiry:** 21 local calendar days after initial acceptance.
7. **Exactly once:** unique logical slots, immutable persisted transmissions, one consumed invocation authority at provider-pending, and zero provider invocations by recovery; ambiguity means reconcile only.
8. **Same broker:** batch communication, separate opportunity/campaign identity.
9. **Replies:** exact conversation/thread evidence first; shared reply stops all campaigns in that conversation pending classification.
10. **Materials:** evaluated and satisfied per opportunity.
11. **Historical data:** readable and inert; no silent enrollment or cadence migration.
12. **Imports:** update canonical evidence only; never authorize outreach.
13. **Rollout:** FL-04A, B, and C separately disabled, evidenced, and activated.
14. **Legacy retirement:** later, measured, and owner-approved; not part of this specification's execution.

## 26. Consequential unresolved questions and external prerequisites

No unresolved product or architecture question blocks an implementation plan. The owner-supplied decisions are sufficient to define identity, cadence, state, batching, migration, and rollout behavior.

The following are external activation prerequisites, not design ambiguities:

- P8-00 must document that the chosen provider and recipient-contact basis permit the exact live broker inquiry use.
- The release owner must approve final initial/follow-up/batch copy and any required opt-out/footer content.
- The isolated controlled-mailbox sender/inbound path must be authenticated and healthy before that stage; production sender authentication, signed inbound receiving, and reconciliation health must be current before any real-contact stage.
- A versioned location-to-IANA dataset/resolver must be selected and tested before campaigns can rely on derived timezone authority; until then, only explicit verified IANA facts are eligible.

If any prerequisite is absent, the correct state is action-required or capability-disabled with zero provider work.

## 27. Verification standard for the future implementation

A future implementation may be called complete only when:

- the exact baseline and migration ancestry are verified;
- SQLite and disposable PostgreSQL/Supabase tests demonstrate equivalent constraints and transitions;
- the full repository check/lint/test/build/browser suite passes under the supported Node runtime;
- all acceptance scenarios applicable to the activated stage pass with fresh output;
- shadow/dry-run provider calls are proven zero;
- controlled mailbox evidence covers acceptance, replay, reply, materials, ambiguity, crash, restart, and local-time behavior;
- no unrelated repository changes are included;
- central and capability pause states are independently inspected before and after deployment; and
- production activation remains a separate, explicit owner decision.

This document stops at the design boundary. It neither authorizes nor begins an implementation plan.
