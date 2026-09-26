# Pursue → CIM Autopilot Implementation Plan

> **For the later implementation owner:** Use `superpowers:executing-plans` with one implementation owner, focused commits, fresh verification, and one independent reviewer of the completed outcome. The checkboxes are execution tracking, not repeated owner-approval gates. Production migration, deployment, flag changes, provider calls, pause changes, and live activation remain separate owner-authorized work.

**Goal:** Make a new post-cutover `Pursue` decision durably enroll one canonical opportunity in one policy-versioned CIM campaign, prepare and send at most one initial broker-materials request in the first safe opportunity-local window, stop from fresh terminal authority, and expose honest action-required state. Preserve historical and legacy work as readable and inert. Follow-ups and same-broker batching remain separately disabled FL-04C work.

**Architecture:** Add campaign authorities beside `deal_hunter_cim_requests`; do not evolve the legacy request row into the new lifecycle. Reuse canonical identity, FL-01 freshness, CRM ownership, broker-materials authority, materials detection, signed inbound events, and communication storage. Add immutable owner decisions, pursuit enrollments, campaign generations, timezone revisions, logical touch slots, conversations, immutable transmissions/membership, terminal revisions, import safety events, capability activations, and exact live-provider authorizations. All CIM writers converge on one default-deny provider boundary. The final-gate transaction consumes the only provider invocation authority before the socket; provider-pending work is reconciliation-only forever.

**Tech stack:** Node.js ESM, better-sqlite3, Supabase/PostgreSQL SQL and security-definer RPCs, React/Vite, `node:test`, Vitest, Playwright Chromium, the built-in `Intl.DateTimeFormat` IANA timezone implementation, the existing Resend delivery adapter, and the existing signed webhook path.

**Approved spec:** `docs/superpowers/specs/2026-09-24-pursue-cim-autopilot-design.md`, merged unchanged at `5d747dbafa74183b88b549403f2e8f1b1ab529c6`, SHA-256 `1821b8bd39fd5bbded71bd915ead023367ea274e9412a3b3dd25e589dbd96aa3`. The spec's runtime baseline is `b068696d485b4e34caf71a84f52debd8f0a0a8cb`, tree `2849726e2a331bca2cbd758fb4a8328bdf2d481a`; the merge adds only the approved 1,309-line spec. Keep the spec bytes unchanged.

## Global constraints and investigated baseline

- This plan was prepared on branch `codex/pursue-cim-autopilot-plan` at commit `5d747dbafa74183b88b549403f2e8f1b1ab529c6`, tree `531f597595ce2e7d4008b40b1576b3cf000fa5f7`; local `origin/main` was the same commit. Before implementation, fetch and compare main. A runtime change after the investigated baseline requires a compatibility review, not blind cherry-picking.
- Owner-supplied release context says production remains on runtime commit `b068696d485b4e34caf71a84f52debd8f0a0a8cb` and PR #28 was documentation-only with successful CI. This planning task did not access or verify production, create a PR, or deploy anything.
- The current worktree had no `node_modules`; Node `v24.19.0` and npm `11.17.0` were available. No dependency, migration, server, provider, production, or test environment was changed during planning.
- The current direct/manual, bulk, Stage 2, legacy scheduled follow-up, and operator-approved follow-up services ultimately reach `sendPreparedMessage`; `delivery.js` also exposes CIM convenience senders that call its private `sendMessage` directly. The current path persists communication evidence and handles ambiguous outcomes conservatively, but does not have the spec's distinct, consumed, non-retryable provider-pending authority. Put the default-deny protected-kind check in the private `sendMessage` path so neither public entry can bypass it, and do not relabel the existing `pending` request state as proof of the new protocol.
- `deal_hunter_cim_requests` stays intact for legacy reads, inbound correlation, audit, and later retirement metrics. New Pursue work never inserts a lifecycle row there and new scheduler code never claims it.
- Source imports may append canonical/freshness evidence and an import-safety event. They may cause a stop/review/no-op through the safety consumer, but may never create an enrollment, campaign, touch, transmission, cadence advance, or provider call.
- Preserve the existing exact canonical resolver, alias/exception model, FL-01 admitted-source boundaries, canonical CRM ownership/supersession checks, `evaluateAcquisitionMaterialsState`, signed contact-reference approach, signed webhook verification, communication/event retention, suppression, and central pause.
- The existing opportunity-detail GET currently passes `reconcileAcceptedManualFollowUps: session.role === 'admin'`. Repository inspection shows that path only reads an already accepted legacy manual-follow-up communication and calls `finalizeDealHunterApprovedFollowUp`; it accepts no sender and makes no provider call. Package 6B therefore contains any later legacy writer at the private `sendMessage` boundary, and the new canary projection/final gate must never use this GET as authority. Package 7C still removes the write-on-read and moves reconciliation to an explicit internal command/job, but it may land immediately after first-canary proof so long as every new campaign/release read is side-effect-free and 7C completes before broad owner rollout.
- Canonical intake safety, Pursue enrollment, FL-04B initial transmission, FL-04C follow-up, and FL-04C batching use five distinct durable capability activations with dependency edges `fl04a-safety → fl04b-enrollment → fl04b-initial → fl04c-followup → fl04c-batch`. Every capability is absent/off after migration. Environment configuration may make a capability harder-off, never turn it on without durable activation. Campaign allocation requires enrollment authority; claim/provider work additionally requires initial authority.
- The checked-in default and deployment examples are not proof of effective production pause state: `.env.example` defaults the central pause on, `server/config.js` defaults it off, and `fly.toml` currently declares it off for an older manual flow. Before any shadow or live stage, inspect the effective durable and runtime pause independently. This plan does not infer or change production state.
- No UI exposes Retry, Send Again, or Regenerate for provider-pending, ambiguous, or definitive-failure work. A definitive failure requires the explicit reviewed-new-generation command.
- Do not introduce a second CRM, a generic workflow engine, a raw source-event lake, a third storage provider, or a remote timezone service.

## Repository reality and reuse decisions

| Area | Reuse unchanged | Adapt | New durable authority |
| --- | --- | --- | --- |
| Canonical intake | `cimOpportunityIdentity.js`, aliases, identity exceptions, FL-01 freshness evidence/source observations | Emit bounded safety events at admitted Sheet/Deal OS commit and consume them outside the import transaction | `deal_hunter_cim_safety_events` |
| Owner intent | Existing admin auth/CSRF and triage action route | Keep the score-row priority/review fields as a compatibility projection | Immutable owner decision event and pursuit enrollment |
| Recipient authority | `loadBrokerMaterialsAuthority`, opaque signed contact references, recipient candidates, canonical CRM match/supersession rules | Extract a side-effect-free authority snapshot/digest builder used by enrollment and final gate | Recipient permission revision/digest on campaign and activation; no client email authority |
| CRM | Existing `deal_hunter_crm_imports`, exact canonical owner reuse, communication/history tables | Run CRM reuse/create after the decision commits; fail campaign creation closed on ambiguity/supersession | Campaign-to-submission ownership revision and immutable transmission membership |
| Materials/terminal state | `evaluateAcquisitionMaterialsState`, dispositions, archive, suppression, identity exceptions, source health/freshness | One terminal-authority writer and one direct final-gate reader | Terminal events and campaign/conversation revision counters |
| Time | `Intl.DateTimeFormat` | Opportunity-local wall-clock resolver/roller with injected clock and versioned location resolver | Append-only timezone revision selected by campaign |
| Outbound evidence | `crm_communications`, `crm_email_outbox`, provider identities, Resend error classification | Create exact communication/outbox in the transmission transaction; stop using outbox retry semantics for new CIM | Touch, transmission, membership, provider-pending/invocation authority |
| Inbound | Signed webhook verification, replay-safe event keys, reply aliases, RFC message IDs | Resolve conversation/transmission first; sender-only matches create review candidates only | Conversation-level reply terminal event and member campaign stops |
| Rollout | Stage 2 activation evidence/hash ideas and provider-call accounting | Generalize the pattern; do not reuse Stage 2 tables as new campaign authority | Capability activation and exact live-provider authorization |
| UI | `AcquisitionInbox.jsx`, `OpportunityDrawer.jsx`, existing Pursue/Watch/Pass controls | Show decision/enrollment/campaign/initial status and action-required reasons; remove GET reconciliation | No new client-owned workflow state |

## Planned file and interface map

| Responsibility | Existing/planned files | Required boundary |
| --- | --- | --- |
| Pure policy, timezone, cadence, identifiers | Create `server/services/cimCampaignPolicy.js`; create `server/services/opportunityTimezone.js`; add selected versioned resolver data under `server/data/` | Pure deterministic functions; no storage/provider access; explicit IANA fact wins; ambiguous/missing location fails closed |
| Enrollment and campaign orchestration | Create `server/services/cimCampaigns.js`; modify `server/services/dealHunterTriage.js`, `server/services/dealHunterBrokerMaterials.js`, `server/app.js` | Persist decision first; then CRM/recipient/timezone/campaign orchestration; idempotent results |
| Final gate and provider boundary | Create `server/services/cimProviderBoundary.js`; modify `server/services/delivery.js`, `server/services/dealHunter.js`, `server/services/dealHunterManualFollowUps.js`, `server/services/followUpEmail.js`, `server/services/cimAutomation.js` | Classify protected work from durable CIM ownership as well as message kind; every protected request needs an exact live authorization; unrelated non-CIM email is unchanged |
| Safety and inbound terminal propagation | Create `server/services/cimCampaignSafety.js`; modify `server/services/emailEvents.js`, admitted import services, and callers of `acquisitionMaterials.js` | Append/consume bounded safety events; exact conversation/thread evidence first; no campaign creation |
| Scheduling/reconciliation/operations | Create `server/services/cimCampaignScheduler.js`; modify `server/services/dealHunterScheduler.js` and existing operations composition points | FL-04B claims initial slots only; provider-pending/ambiguous recovery performs zero provider calls |
| Provider profiles/config | Modify `server/config.js` and delivery/inbound/reconciliation composition | Server-owned production versus controlled-mailbox profile resolution; the mailbox process cannot resolve production credential names; ordinary daily/non-CIM delivery remains outside the CIM boundary |
| SQLite | Modify `server/storage/sqlite.js` | Additive schema, `BEGIN IMMEDIATE`, uniqueness/CAS, normalized outcomes |
| PostgreSQL | Create `supabase/migrations/20260925120000_pursue_cim_autopilot.sql`; modify `supabase/schema.sql`, `server/storage/supabase.js` | Equivalent checks/indexes/RPC transitions, fixed search path, RLS, service-role only |
| Admin projection | Modify `src/components/admin/AcquisitionInbox.jsx`, `src/components/admin/OpportunityDrawer.jsx` | Honest lifecycle/action-required display; no raw token/digest/provider payload leakage |
| Tests | Create focused files named below; extend existing identity, lifecycle, webhook, UI, and browser suites | Provider-backed parity precedes UI mocks; deterministic clocks/provider fakes; real multiprocess SQLite and disposable PostgreSQL races |

The storage adapters must expose equivalent normalized methods and result reasons:

~~~text
recordOwnerDecision(command)
  -> { applied, replay, conflict, decision, enrollment }
materializePursuitCampaign(command)
  -> { applied, existing, actionRequired, campaign, initialTouch }
appendCimSafetyEvents(run)
consumeCimSafetyEvents({ safetyRunId, limit })
  -> { stopped, reviewRequired, noOp, pending }
appendCimTerminalEvent(command)
  -> { applied, campaignRevision, conversationRevision, cancelledTouchIds }
appendOpportunityTimezoneRevision(command)
  -> { applied, replay, staleRevision, timezoneRevision }
claimDueCimTouch(command)
  -> { claimed, alreadyOwned, staleAuthority, terminal, conflict, touch }
prepareCimTransmission(command)
  -> { prepared, existing, payloadConflict, terminal, transmission }
authorizeCimProviderPending(command)
  -> { authorized, blockedReason, transmission, ephemeralBoundaryToken }
enterCimProviderSeam(command)
  -> { entered, alreadyEntered, unauthorized }
finalizeCimTransmission(command)
  -> { applied, existing, conflict, transmission, nextTouch }
reconcileCimTransmission(command)
  -> { applied, unchanged, conflict, transmission } // never invokes provider
readPursueCimProjection({ opportunityId })
  -> { decision, enrollment, campaign, initialTouch, transmission, legacySummary, actions }
~~~

`ephemeralBoundaryToken` is returned by the service wrapper only, not a serializable storage row or API response. SQLite/Postgres methods may return the stored nonce digest; the wrapper retains the raw nonce only in the winning process.

## Additive data contract

Use bounded text, explicit state checks, FKs with `RESTRICT` for retained evidence, no cascade from mutable projections into lifecycle evidence, row versions on mutable authorities, and immutable-payload triggers where stated. PostgreSQL tables have RLS enabled, no public/anon/authenticated privileges, service-role grants only, and security-definer RPCs with `search_path = ''` and fully qualified names.

| Table | Essential columns and constraints |
| --- | --- |
| `deal_hunter_owner_decision_events` | `id`, unique `idempotency_key`, immutable `request_digest`, `opportunity_id`, `action` (`pursue/watch/pass`), actor, expected/observed discovery and material revisions, optional selected contact-reference digest, policy version, `created_at`. Same key/same digest replays; same key/different digest rejects. UPDATE/DELETE forbidden. |
| `deal_hunter_pursuit_enrollments` | Deterministic `id`, unique `decision_event_id`, `opportunity_id`, state (`queued/waiting-on-eligibility/campaign-created/action-required/superseded`), reason, authority digest, created/updated timestamps, row version. Unique current nonsuperseded enrollment per opportunity. Historical decisions are not backfilled. |
| `deal_hunter_opportunity_timezone_revisions` | `opportunity_id`, monotone `revision`, state (`verified/derived/missing/ambiguous`), nullable IANA zone, evidence/source type, evidence digest, resolver version/dataset digest, actor, `created_at`; unique `(opportunity_id, revision)`. Append only. |
| `deal_hunter_cim_campaigns` | Deterministic `id`, `opportunity_id`, unique `(opportunity_id, generation)`, enrollment/decision IDs, policy/template/permission versions and digests, canonical/CRM/recipient/freshness/timezone authority revisions, conversation ID, state/reason, initial accepted time, local expiry and derivation metadata, terminal revision, row version, timestamps. Partial unique active campaign per opportunity. |
| `deal_hunter_broker_conversations` | Deterministic recipient-authority identity, protected recipient address/fingerprint, sender/reply policy, unique reply-alias token digest, RFC thread key, state, terminal revision, batching policy version, row version. It groups communication only; it never merges opportunity identity. |
| `deal_hunter_cim_campaign_touches` | Deterministic ID from campaign/policy/logical slot; unique `(campaign_id, logical_slot)`, kind/ordinal, due instant/local derivation, timezone revision, state, claim token digest/owner/lease, transmission ID, outcome, row version. Accepted finalization may derive one dormant next slot before FL-04C; claiming, preparing, or sending any follow-up requires the separate FL-04C activation. |
| `deal_hunter_cim_transmissions` | Deterministic ID, conversation ID, sorted membership digest, positive pre-provider preparation generation with unique `(conversation_id, member_digest, preparation_generation)`, immutable payload version/digest and protected exact addressing/copy fields, unique provider idempotency key, unique CRM communication/outbox IDs, state (`prepared/final-gate-blocked/provider-pending/accepted/definitive-failure/ambiguous/cancelled-before-provider`), release state (`ordinary/awaiting-live-authorization/authorized`), final-gate authority digest/revisions, invocation-authority count constrained to `0..1`, authorization time, boundary nonce digest, seam-entered time, provider identity/result, row version. Payload/address/membership are immutable once prepared; a changed authority cancels and rebuilds a new audited identity before provider-pending. Preparation generation may advance under the locked member touches only after the prior memberships are cancelled and only while no provider-pending/accepted/definitive/ambiguous identity exists. |
| `deal_hunter_cim_transmission_touches` | `(transmission_id, touch_id)` PK, opportunity/campaign IDs, display ordinal, cancellation state/reason. A partial unique index allows one non-cancelled transmission membership per touch. No cloned provider identity. |
| `deal_hunter_cim_terminal_events` | Deterministic event ID, scope (`campaign/conversation`), scope ID, unique revision, reason/evidence type/evidence ID, observed time, actor/source, metadata digest. Append only; payload contains no message bodies or source secrets. |
| `deal_hunter_cim_safety_events` | Deterministic ID from `safety_run_id + opportunity_id + event_type + evidence_id`, source/import identity, canonical identity/exception revision, type, status (`pending/stopped/review-required/no-op`), outcome evidence/revision and timestamps. Unique emission and one terminal consumer outcome. |
| `deal_hunter_cim_audit_events` | Deterministic event ID, event type, opportunity/campaign/conversation/touch/transmission/activation/authorization references, prior/next state, reason code, authority/payload digest, actor/source, occurred time, bounded redacted metadata. Append-only trigger. Claim/release, preparation/membership, final-gate decision, provider-pending/seam/finalization, activation/authorization, and reconciliation transactions append here atomically. |
| `deal_hunter_cim_capability_activations` | ID, capability (`fl04a-safety/fl04b-enrollment/fl04b-initial/fl04c-followup/fl04c-batch`), mode (`off/shadow/mailbox/canary/active`), status (`current/superseded/withdrawn`), prerequisite activation/evidence IDs and hashes, policy/config hashes, exact cohort/permission basis and revision, actor/reason/confirmation, expiry, caps, provider profile, timestamps. Partial unique current row per capability. Migration creates none. |
| `deal_hunter_cim_live_provider_authorizations` | ID, activation ID/capability, exact writer path, exact already-persisted transmission ID, payload and recipient authority digests, provider profile, maximum calls constrained to one, issued/expiry/consumed/withdrawn timestamps, actor/reason. Exact current row required whenever protected CIM work reaches the provider boundary while the environment's central pause is off. |

Also add bounded foreign-key references from the new transmission to the existing `crm_communications` and `crm_email_outbox` rows. Do not add a foreign key from a legacy request to a new campaign or an automatic backfill trigger. Keep existing provider IDs, messages, aliases, incident repair receipts, and legacy rows byte-for-byte when untouched.

### Exact persisted states and legal transitions

The storage providers reject unlisted transitions; service code does not emulate them with read-then-write. Versioned PostgreSQL RPCs and matching SQLite immediate transactions enforce transition, row version, terminal revision, and audit append together. Immutability triggers reject UPDATE/DELETE of owner, safety, terminal, and audit events and reject transmission payload/membership mutation after preparation.

| Authority | States | Legal transitions and uniqueness meaning |
| --- | --- | --- |
| Enrollment | `queued`, `waiting-on-eligibility`, `campaign-created`, `action-required`, `superseded` | `queued → waiting-on-eligibility/campaign-created/action-required/superseded`; `waiting-on-eligibility → queued/campaign-created/action-required/superseded`; `campaign-created/action-required → superseded` only through a terminal owner/reviewed-generation command. One nonsuperseded enrollment per current Pursue decision; a later decision supersedes the projection, never rewrites the event. |
| Campaign | `queued`, `waiting-on-eligibility`, `initial-pending`, `active-follow-up`, `action-required`, `responded`, `materials-received`, `stopped`, `expired`, `provider-ambiguous` | `queued → waiting-on-eligibility/initial-pending/action-required/stopped`; `waiting-on-eligibility → queued/initial-pending/action-required/stopped`; `initial-pending → active-follow-up/action-required/responded/materials-received/stopped/provider-ambiguous`; `active-follow-up → active-follow-up/action-required/responded/materials-received/stopped/expired/provider-ambiguous`; a safe pre-provider resolution may move `action-required → queued/waiting-on-eligibility/initial-pending`, otherwise only to responded/materials-received/stopped; exact reconciliation may move `provider-ambiguous → active-follow-up/action-required/responded/materials-received/stopped`. `responded/materials-received/stopped/expired` do not transition within a generation. The partial unique active predicate is the other six states. Definitive rejection projects `action-required/provider_definitive_failure`; only the reviewed command stops it and allocates another generation. |
| Conversation | `open`, `reply-review-required`, `responded`, `stopped`, `provider-ambiguous`, `closed` | `open → reply-review-required/responded/stopped/provider-ambiguous/closed`; review may move `reply-review-required → responded/stopped/open`; exact reconciliation may move `provider-ambiguous → open/responded/stopped`; terminal authority prevents reopening without an explicit reviewed conversation action. |
| Touch | `scheduled`, `claimed`, `provider-pending`, `accepted`, `definitive-failure`, `ambiguous`, `cancelled-before-provider` | `scheduled → claimed/cancelled-before-provider`; recoverable `claimed → scheduled`; `claimed → provider-pending/cancelled-before-provider`; `provider-pending → accepted/definitive-failure/ambiguous`; exact reconciliation may resolve `ambiguous` to accepted or definitive failure without another call. No transition leaves accepted/definitive-failure/cancelled. |
| Transmission | `prepared`, `final-gate-blocked`, `provider-pending`, `accepted`, `definitive-failure`, `ambiguous`, `cancelled-before-provider` | `prepared → final-gate-blocked/provider-pending/cancelled-before-provider`; `final-gate-blocked → cancelled-before-provider`; `provider-pending → accepted/definitive-failure/ambiguous`; exact reconciliation may resolve `ambiguous` without a call. Release state may move `ordinary → awaiting-live-authorization → authorized`; payload drift cancels rather than moving authorized work back. |
| Safety event | `pending`, `stopped`, `review-required`, `no-op` | One CAS from pending to a terminal outcome; retry returns it. |
| Capability activation | `current`, `superseded`, `withdrawn` | New activation supersedes the locked current row for the same capability; withdrawal is terminal. A child activation stores and validates the accepted current prerequisite activation IDs/hashes. |
| Live authorization | `issued`, `consumed`, `withdrawn`, `expired` projection from timestamps | Exact already-persisted transmission only; issued may become consumed, withdrawn, or expired once. Consumption is in the provider-pending transaction. |

### Deterministic identities

Use length-framed canonical JSON and SHA-256; never concatenate ambiguous raw strings.

~~~text
enrollmentId    = sha256("pursuit-enrollment:v1", decisionEventId)
campaignId      = sha256("cim-campaign:v1", opportunityId, generation, campaignPolicyVersion)
touchId         = sha256("cim-touch:v1", campaignId, logicalSlot, cadencePolicyVersion)
conversationId  = sha256("cim-conversation:v1", recipientAuthorityFingerprint, senderPolicyVersion)
transmissionId  = sha256("cim-transmission:v1", policyVersion, recipientAuthorityFingerprint,
                         sortedTouchIds, preparationGeneration, payloadVersion, payloadDigest)
communicationId = sha256("crm-communication:cim-autopilot:v1", transmissionId)
outboxId        = sha256("crm-outbox:cim-autopilot:v1", transmissionId)
providerKey     = sha256("cim-provider:v1", transmissionId, payloadDigest)
~~~

The request digest covers action, opportunity, expected freshness pair, selected contact-reference digest, and client idempotency key. The payload digest covers exact from/to/reply-to, subject, text, sanitized HTML, tags, sorted membership, and template version. Same-generation replay requires the same digest. A changed prepared payload first cancels the old membership, atomically allocates the next preparation generation under all member-touch locks, and derives new transmission/communication/outbox/provider identities. This is permitted only before provider-pending; provider-pending, accepted, definitive-failure, or ambiguous work can never obtain another transmission identity within that campaign generation.

## State and transaction protocols

### Pursue

1. The existing protected `POST /api/admin/deal-hunter/triage/:opportunityId/action` requires a client UUID idempotency key and expected FL-01 revisions for all `pursue`, `watch`, and `pass` actions. It accepts only opportunity ID, action, expected revisions, optional opaque server-issued contact reference for Pursue, and bounded reason/note fields. It accepts no recipient address, CRM ID, campaign ID, timezone, due time, copy, or policy version.
2. Under one storage transaction in the selected SQLite/PostgreSQL adapter, re-read active canonical identity/freshness and persist the immutable owner decision. Pursue also creates its deterministic enrollment; Watch/Pass atomically update their compatibility projection/disposition, increment terminal authority, cancel pre-provider work, and append audit evidence. Return the stored result on same-key/same-digest replay and reject same-key/different-digest for every action. A different key for the same current Pursue returns existing authority. Racing Watch/Pass versus the final gate is resolved by the shared locked terminal revision.
3. After that commit, load current broker-materials/recipient/materials/legacy/CRM/timezone/permission authority. Missing or conflicted authority updates enrollment to `action-required`; it never erases Pursue.
4. Reuse or create the exact canonical CRM owner through existing import-claim/supersession rules. CRM ambiguity, a superseded loser, or a prior accepted/ambiguous legacy/new request blocks campaign creation.
5. Atomically allocate generation 1, conversation, campaign, and initial slot. Historical Pursue rows remain unenrolled. The separate protected historical-canary command requires an exact current canary activation and one selected opportunity. The reviewed-new-generation command locks and terminalizes the old definitive-failure generation before allocating new identities.

### Timezone and cadence

- `opportunityTimezone.js` validates IANA names by constructing `Intl.DateTimeFormat`; explicit verified IANA evidence wins. A versioned checked-in postal/city/state resolver may derive a zone only from sufficiently specific evidence and records its dataset version/digest. State-only multi-zone results are ambiguous. Until a resolver dataset is selected and reviewed, derived resolution is disabled and only explicit verified IANA facts are eligible.
- Add a protected admin command `POST /api/admin/deal-hunter/triage/:opportunityId/timezone` backed by `appendOpportunityTimezoneRevision`. It accepts a validated IANA zone, bounded evidence type/ID and note, actor from the session, expected prior timezone revision, and client idempotency key; it never edits a prior revision. A derived revision is written only by the versioned resolver with its exact input/dataset digest. A correction after claim increments the revision, appends audit evidence, terminalizes/cancels prepared pre-provider work, and makes the final gate reject the stale revision.
- Tests cover California/Los Angeles, New York/New York, Phoenix/Arizona without DST drift, at least one multi-zone-state postal/city split, missing/ambiguous evidence, and correction after claim.
- Policy v1 is weekdays, 08:00 inclusive to 17:00 exclusive local time. Initial readiness rolls forward. Follow-up anchors are prior provider acceptance plus 48/72/96 elapsed hours, then window roll. Accepted finalization always derives exactly one dormant next-slot identity through the later-weekday/21-local-calendar-day policy; no follow-up slot may be claimed, prepared, or sent before FL-04C activation.
- For nonexistent spring-forward local time choose the earliest valid instant after the gap; for repeated fall-back local time choose the earlier instant. Persist local input, zone, offset choice, policy version, and resulting instant.
- Provider ambiguity creates no next slot. A claimed slot at or after expiry is terminalized, not sent.

### Protected-work classifier and writer inventory

The default-deny check lives in the private `delivery.js` `sendMessage` function immediately before provider selection/fetch. `message.kind` is one signal, not the authority. A message is protected CIM work when any server-owned durable or envelope evidence names a new campaign/transmission, a legacy `cim_request_id`, a CIM reply/tag/tracking identity, or a known CIM writer path. For `crm-follow-up`, the boundary loads the referenced communication/outbox and treats `cim_request_id` or `metadata.manualTakeover` as protected. A client cannot clear protection by omitting a tag. Conflicting classification is protected-and-blocked, not ordinary email.

The scenario 58/80 matrix invokes every current and planned path independently: direct/admin initial (`sendDealHunterCimRequest`), bulk/legacy automatic initial, Stage 2 initial, broker-materials manual initial, legacy scheduled follow-up, operator-approved follow-up, CRM manual takeover (`sendCrmFollowUpEmail`/`processCrmEmailOutbox` with `cim_request_id`), exported CIM delivery convenience senders, new initial, new follow-up, and batch. Each test asserts whether it was rejected before seam entry or admitted by its one exact authorization. Ordinary CRM follow-up without any CIM ownership and daily/submission/admin/system email remain outside this CIM-specific boundary.

### Complete final-gate contract

`authorizeCimProviderPending` returns stable normalized reason codes in both adapters. For batches every predicate applies to every member; one failure cancels the prepared batch before provider work.

| Reason code | Fresh authoritative read |
| --- | --- |
| `owner_decision_not_pursue` | Latest immutable owner decision and nonsuperseded enrollment still authorize Pursue/current generation |
| `identity_not_current` / `identity_ambiguous` | Active canonical opportunity, aliases, identity exceptions, and campaign identity revision |
| `required_source_unhealthy` / `source_absent` / `freshness_changed` | Required-source health/presence plus FL-01 discovery state/revisions/evidence directly, not a delayed projection |
| `crm_owner_changed` / `crm_superseded` | Exact canonical submission and current ownership/supersession revision |
| `recipient_authority_changed` | Opaque contact authority ID, normalized fingerprint/address, provenance, authority revision, and conversation recipient |
| `contact_permission_invalid` | Current permission policy/version, evidence or cohort digest, permission revision, scope, and nonexpired prerequisite activation |
| `timezone_invalid` / `timezone_changed` | Exact append-only timezone revision/evidence and valid IANA zone |
| `not_due` / `window_closed` / `expired` | Exact due instant has arrived, current opportunity-local weekday 08:00–17:00 window is open, and local 21-day expiry has not arrived |
| `terminal_authority_changed` | Campaign and conversation terminal revisions plus reply/materials/advanced-diligence/Watch/Pass/stop/archive evidence |
| `recipient_suppressed` / `unsafe_delivery` | Global suppression, unsubscribe, complaint, hard bounce, and terminal/unsafe delivery evidence |
| `lifecycle_conflict` | No conflicting accepted/ambiguous/provider-pending legacy request, new touch/transmission, communication, outbox, or provider identity |
| `communication_changed` / `outbox_changed` | Exact immutable communication, outbox state/version, transmission links, and reconcile-only policy still match preparation |
| `payload_changed` | Exact from/to/reply-to/subject/text/HTML/tags/template and sorted membership digest |
| `sender_not_ready` / `inbound_not_ready` / `reconciliation_not_ready` | Current provider/sender authentication attestation, signed inbound readiness, and provider reconciliation readiness required by the activation |
| `safety_ceiling` / `cohort_not_allowed` | Current conversation/recipient abuse controls, provider-transmission caps, cohort, and deferral policy |
| `central_pause` / `capability_inactive` / `live_authorization_invalid` | Durable global pause epoch, hard-off config, exact current activation chain, exact unexpired transmission authorization, writer path, provider profile, and one-call cap |

The provider-pending transaction locks/CASes these mutable authorities in a documented order and stores their revisions/digest. `enterCimProviderSeam` is another single storage transaction that locks and reads `deal_hunter_cim_safety_settings(id='global')`, the consumed live authorization, transmission, and seam marker before its CAS. A durable pause committed first wins and yields zero calls. Immediately after an unambiguous CAS winner and immediately before the network call, the boundary rechecks the environment hard-off configuration; a hard-off performs zero calls. A durable pause committed after seam entry is an audited narrow in-flight race, like terminal evidence committed after provider-pending; it stops later work and triggers containment but cannot recall an already admitted socket call.

### Initial claim, prepare, final gate, and provider invocation

1. The FL-04B scheduler lists only due `initial` touches whose exact capability activation is current, unexpired, and mode-appropriate. Shadow computes and records would-claim/would-send evidence without mutating claim/transmission/provider state.
2. `claimDueCimTouch` uses SQLite `BEGIN IMMEDIATE` or PostgreSQL row locks/CAS plus uniqueness. A lease is recoverable only before an immutable provider-pending transition. Reclaim retains the same touch ID.
3. Reload authority and build exact copy through the adapted broker-materials builder. `prepareCimTransmission` inserts the immutable transmission, membership, one CRM communication, and one outbox row in one transaction. New CIM outbox metadata marks `retryPolicy: reconcile-only-after-provider-pending`; generic outbox workers must not claim it.
4. Immediately before provider work, `authorizeCimProviderPending` locks/CASes every member campaign, conversation, touch, transmission, and exact live authorization. It directly re-reads canonical identity/exception, current required-source health and presence, FL-01 discovery/material revisions, Pass/Watch/archive, CRM ownership, recipient/contact-permission authority, suppression, materials/advanced diligence, timezone revision, expiry, central pause, capability activation, cohort/caps, copy/payload digest, and inbound terminal revisions. Delayed projections cannot weaken these reads.
5. If any member fails, cancel/block the prepared transmission before provider work, cancel its active memberships, append reasons, release still-safe slots for deterministic rebuild, and perform zero provider calls. A single-member FL-04B transmission becomes action-required where the reason is not transient.
6. If all pass, the same transaction changes transmission and touches to `provider-pending`, records validated revisions/digest, sets invocation-authority count from 0 to 1, records authorization time, consumes the exact live authorization, and stores only a one-way digest of a random boundary nonce. The raw nonce and winning claim token remain only in the original in-memory execution. An ambiguous commit/result from this transaction authorizes zero provider calls; reconciliation first determines whether provider-pending committed, and recovery still never invokes if it did.
7. The execution immediately calls `sendPreparedMessage(message, { cimProviderAuthorization })`. Inside `delivery.js`, the private `sendMessage` function runs the durable protected-work classifier and delegates every protected request to `cimProviderBoundary.js`, covering prepared messages, CIM convenience senders, and CIM-linked `crm-follow-up` outbox work. The boundary revalidates its environment's central pause, exact writer path/profile/transmission/payload/recipient digests and performs one CAS from `provider_seam_entered_at IS NULL` using the raw nonce. Only an unambiguous CAS-winner response calls Resend; an ambiguous seam-entry result performs zero provider calls. All legacy/manual/direct/scheduled/nonselected paths lack the exact nonce/authorization and stop before fetch. Unrelated non-CIM email is unchanged.
8. If the process dies after step 6, the raw nonce is lost and recovery never invokes. If it dies after seam entry or during/after fetch, recovery never invokes. Accepted, definitive-rejection, and ambiguous finalization are idempotent. Timeout, reset, uncertain HTTP, parse failure, missing provider ID, or persistence uncertainty preserves provider-pending/ambiguous and reconciliation-only status. Provider idempotency is defense in depth, never retry authority.
9. Acceptance anchors the campaign and creates exactly one deterministic dormant next slot. The slot remains nonclaimable until FL-04C is separately active. Definitive rejection terminalizes the touch and sets `action-required/provider_definitive_failure`; ordinary Pursue cannot restart it.

### Terminal and inbound authority

- Every terminal writer appends one event and increments the locked campaign/conversation terminal revision while cancelling all untransmitted slots. Replays return the existing event. Pass/Watch use the same transaction as their existing disposition/projection mutation.
- A signed reply alias or RFC provider/thread relation resolves conversation/transmission first and immediately stops the conversation before content retrieval/classification. Content-fetch failure cannot delay the stop.
- A sender-only email, even with one apparent active campaign, creates an unassigned/review candidate and never auto-stops a campaign. Ambiguous same-broker inbound fails closed.
- Verified materials satisfy only the identified opportunity; advanced diligence stops every untransmitted touch for that campaign. Unclear batch attachments stop the conversation pending review without assigning materials to all members.
- An event committed after provider-pending records a narrow in-flight race and stops later touches; it cannot recall the already consumed invocation authority.

### Real-canary prepare, hold, authorize, and resume

The real canary never races an owner review against a scheduler loop:

1. With the durable central pause active and a current exact canary activation, a release-owner `prepare-only` command claims the selected initial touch, persists the immutable `prepared` transmission, membership, communication, and outbox, sets release state `awaiting-live-authorization`, appends audit evidence, and releases it into a nonclaimable hold. It performs no final gate and has no invocation authority.
2. The UI/release report renders the exact bounded copy, addressing, membership, authority digests, candidate transmission ID, and expiry from those persisted rows. The owner reviews this immutable artifact, not a recomputed preview.
3. A separate release-owner command issues/withdraws an expiring live authorization with an FK to that existing transmission and exact payload/recipient/writer/profile digests. Any payload or authority drift cancels the prepared transmission and authorization before provider-pending; it cannot edit or rebind them.
4. After the separately audited production-pause transition, `resume-authorized` reacquires serialization for that exact held transmission, confirms release state/authorization, runs the complete fresh final gate, and either cancels safely or performs the one provider-pending transition. It may not build another payload.
5. Authorization expiry/withdrawal returns the held touch to action-required/cancelled-before-provider with audit evidence and zero calls. These are separate authenticated-admin endpoints requiring an exact confirmation phrase, named accountable actor, and current release-owner authorization evidence; the ordinary scheduler, triage actions, and legacy admin send routes cannot consume a canary hold.

## Work packages

Each package is intended to be a roughly 1–3 hour reviewable unit for an experienced owner with the relevant fixtures available. Estimates exclude waiting for external permission/copy decisions and hosted CI. Do not run the complete suite after every package; use focused RED/GREEN commands and the checkpoints below.

### Package 0: Freeze contracts and build the red acceptance harness (1–2h)

**Dependencies:** Current-main comparison; approved spec. **Outcome:** Test names, deterministic clocks, provider counters, and stage labels exist before production logic.

- [ ] Create `test/pursueCimAutopilotPolicy.test.js`, `test/pursueCimAutopilotStorage.test.js`, `test/pursueCimAutopilotPostgres.test.js`, `test/pursueCimAutopilotService.test.js`, `test/pursueCimProviderBoundary.test.js`, `test/pursueCimInbound.test.js`, and `test/fixtures/pursueCimSqliteWorker.js` with scenario IDs in test names.
- [ ] Add an injectable clock/nonce/provider fake. The fake records seam entries separately from provider calls and can crash at each protocol boundary.
- [ ] Add the August no-URL → URL incident transition plus materially distinct lookalike fixture from `docs/cim-identity-incident-2026-08-12.md`.
- [ ] Run focused RED tests and require missing-contract failures, not environment/import failures.

**Focused command:** `node --test test/pursueCimAutopilotPolicy.test.js test/pursueCimAutopilotStorage.test.js test/pursueCimAutopilotService.test.js test/pursueCimProviderBoundary.test.js test/pursueCimInbound.test.js`

**Commit:** `test: define pursue CIM autopilot contracts`

### Package 1A: Additive schema and constraint contract (2–3h)

**Dependencies:** Package 0. **Outcome:** The new authorities, exact states, constraints, immutability, indexes, RLS, and grants exist with no enabled capability.

- [ ] Add the tables/indexes/triggers above to `server/storage/sqlite.js`, the new migration, and `supabase/schema.sql`; add schema/catalog tests before transition code.
- [ ] Prove fresh schema and upgrade from the pre-migration schema; verify partial uniqueness, active predicates, transition checks, immutable-payload/audit guards, FK behavior, RLS/grants, and fixed search paths.
- [ ] Prove migration inserts no activation, changes no pause/settings row, backfills no decision/enrollment/campaign, and preserves old aliases/communications/provider IDs/incident receipts byte-for-byte.

**Commit:** `feat: add inert pursue CIM campaign schema`

### Package 1B: SQLite transition adapter and audit parity (2–3h)

**Dependencies:** Package 1A. **Outcome:** SQLite immediate transactions implement the normalized interfaces and append the required audit event atomically.

- [ ] Add normalization plus decision/enrollment, timezone revision, campaign allocation, claim, preparation, terminal, provider-pending, seam, finalization, activation, authorization, safety, and audit transactions.
- [ ] Test legal/illegal state transitions, same-key replay/conflict, rollback injection, stale row/terminal revisions, and all uniqueness barriers against real SQLite.

**Focused command:** `node --test test/pursueCimAutopilotStorage.test.js`

**Commit:** `feat: add SQLite CIM campaign transitions`

### Package 1C: PostgreSQL RPC, migration, and transition parity (2–3h)

**Dependencies:** Packages 1A–1B. **Outcome:** PostgreSQL returns the same normalized transition and security outcomes as SQLite.

- [ ] Add versioned security-definer RPCs for every Package 1B transition with fully qualified names, row locks/CAS, role tests, and transactional audit append.
- [ ] Run fresh and upgrade disposable PostgreSQL databases and compare normalized outcomes with SQLite.

**Focused command:** `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/pursueCimAutopilotPostgres.test.js`

**Commit:** `feat: add PostgreSQL CIM campaign parity`

### Package 1D: Exact pre-feature binary compatibility (1–2h)

**Dependencies:** Package 1C. It may proceed after or alongside Packages 2–7, but must pass before any production-shaped deployment, Checkpoint B, or real-canary readiness. **Outcome:** The actual rollback version tolerates the additive SQLite/PostgreSQL schema and never treats new rows as legacy work.

- [ ] Build/run the exact pre-feature commit `b068696d485b4e34caf71a84f52debd8f0a0a8cb` from a separate temporary worktree/artifact against disposable SQLite and PostgreSQL databases upgraded by the new migration.
- [ ] With durable/config pause proven active, execute startup/schema initialization, legacy reads, direct/cron scheduler discovery, and inbound recording; assert it neither schedules nor deserializes new campaign rows as legacy requests. Record old commit/tree, schema hash, commands, and row fingerprints in release evidence. A current-code mock with methods disabled is insufficient.

**Commit:** `test: prove old-version CIM campaign compatibility`

References to the storage foundation below mean Packages 1A–1C. Package 1D is a separately named, absolute deployment/rollback gate; deferring its execution does not make it optional, and any failure blocks deployment and canary work.

### Package 2: Canonical intake safety outbox and August regression (2–3h)

**Dependencies:** Packages 1A–1C; FL-01 admitted writer knowledge. **Outcome:** Imports can stop/review existing outreach but can never create/advance it.

- [ ] Extend admitted complete Sheet and Deal OS commits to append deterministic bounded `deal_hunter_cim_safety_events` using their accepted run IDs; do not call campaign orchestration in the import transaction.
- [ ] Implement the idempotent safety consumer in `cimCampaignSafety.js`; outcomes are stop, review-required, no-op, or still-pending with run-level accounting. Event emission itself is inert; shadow evaluates without terminal mutation, and stop/review consumption requires a current `fl04a-safety` activation.
- [ ] Have the final gate directly read current identity exceptions/source health/freshness so consumer lag cannot authorize a send.
- [ ] Extend `test/dealHunterSourceImport.test.js`, `test/dealHunterBulkCim.test.js`, and canonical identity tests for scenarios 1–12, including concurrent Sheet/Deal OS convergence and the August transition.
- [ ] Assert import result fields `outreachCreated === 0`, `touchesScheduled === 0`, no provider calls, and no enrollment/campaign/touch/transmission row changes except permitted terminalization.

**Focused command:** `node --test test/dealHunterSourceImport.test.js test/dealHunterBulkCim.test.js test/canonicalOpportunityCurrentSemantics.test.js test/pursueCimAutopilotService.test.js`

**Commit:** `feat: make canonical intake campaign-safe`

### Package 3: Timezone authority and pure cadence policy (2–3h)

**Dependencies:** Packages 1A–1C; selected resolver dataset only for derived-zone eligibility. **Outcome:** Deterministic local scheduling and action-required behavior exist without enabling any scheduler.

- [ ] Implement IANA validation, explicit verified timezone revisions, versioned resolver adapter, local-window roll, DST gap/repetition behavior, accepted-at anchors, and local-calendar expiry in the two pure policy files.
- [ ] Check in only the selected resolver's bounded generated mapping plus provenance/license/version/digest; do not add a runtime network call. If selection is not complete, keep derived resolution disabled and make explicit verified IANA facts the only eligible source.
- [ ] Implement the protected, idempotent `appendOpportunityTimezoneRevision` command/API for explicit evidence and the server-owned derived writer for resolver evidence. Persist the selected revision on campaigns; any correction increments authority and invalidates prepared/claimed work at final gate.
- [ ] Cover the pure timezone/cadence portions of scenarios 26–36, including multi-timezone states and no derived next instant on ambiguity; Package 6D covers slot persistence/finalization.

**Focused command:** `node --test test/pursueCimAutopilotPolicy.test.js`

**Commit:** `feat: add opportunity-local CIM cadence policy`

### Package 4A: Immutable owner commands and compatibility projections (2–3h)

**Dependencies:** Packages 1A–1C and 3. **Outcome:** Pursue/Watch/Pass have one idempotent, revision-bound event contract before any campaign orchestration.

- [ ] Extend the triage action route/service with required idempotency key and expected revisions for Pursue/Watch/Pass. Persist every immutable owner event; Pursue creates queued enrollment, while Watch/Pass atomically update compatibility projection/disposition, terminal revision, cancellations, and audit evidence.
- [ ] Add same-key replay/conflict, concurrent duplicate commands, and Watch/Pass-versus-pre-provider transition tests in both adapters; preserve old Pass semantics.

**Focused command:** `node --test test/dealHunterTriage.test.js test/dealHunterAtomicPass.test.js test/httpDealHunterTriageActions.test.js test/pursueCimAutopilotService.test.js`

**Commit:** `feat: persist idempotent acquisition owner commands`

### Package 4B: Recipient/CRM authority and ordinary campaign allocation (2–3h)

**Dependencies:** Package 4A. **Outcome:** A current Pursue either creates one ordinary initial-pending campaign or lands in honest action-required state, with zero provider work.

- [ ] Extract a pure current-authority snapshot/digest from `dealHunterBrokerMaterials.js`; keep signed contact references opportunity-, provenance-, revision-, and expiry-bound.
- [ ] Reuse exact canonical CRM owner/import claims; block ambiguity and superseded losers. Reuse recipient candidates, suppression, existing materials predicate, and prior provider-accepted/ambiguous detection.
- [ ] Require a current `fl04b-enrollment` activation and accepted `fl04a-safety` prerequisite, then allocate campaign generation, conversation, and deterministic initial slot atomically. Initial claim/provider work remains impossible without separate `fl04b-initial` activation.
- [ ] Cover ordinary Pursue/recipient/CRM scenarios 13–22 and the prior-accepted blocker half of scenario 25 in service/storage/API tests; Package 4A owns Watch/Pass scenario 24 and deferred Package 4C owns scenario 23 plus the reviewed-restart half of scenario 25.

**Focused command:** `node --test test/pursueCimAutopilotService.test.js test/dealHunterBrokerMaterials.test.js test/httpDealHunterTriageActions.test.js`

**Commit:** `feat: allocate Pursue CIM campaigns`

### Deferred Package 4C: Historical-canary and reviewed-new-generation commands (1–2h)

**Dependencies:** Packages 4B, 6C, and 7B plus successful first-real-canary evidence; complete before either action is exposed or used. **Outcome:** Historical enrollment and post-definitive-failure restart are explicit, separately authorized commands with new identities.

- [ ] Add historical-canary and reviewed-new-generation admin commands behind exact activations/confirmation/evidence. Neither is an ordinary Pursue replay; both use current recipient/CRM/timezone/terminal authority.
- [ ] Prove historical rows remain inert, exact canary scope creates one generation, and restart atomically stops the old generation before allocating the next.
- [ ] Until this package lands, historical Pursues remain inert and definitive failure remains terminal/action-required. No replay, retry, restart, or ordinary new-Pursue command may substitute for either reviewed action.

**Commit:** `feat: add reviewed CIM generation commands`

References to the ordinary new-Pursue path below mean Packages 4A–4B. Package 4C is named explicitly wherever its post-canary historical/restart actions are required.

### Package 5: Initial-touch claim and immutable transmission preparation (2–3h)

**Dependencies:** Packages 1A–1C, 3, and 4A–4B. **Outcome:** One logical initial touch for an ordinary new post-cutover Pursue can be claimed and prepared exactly once without reaching a provider.

- [ ] Implement initial-only due selection requiring the current `fl04b-initial` activation and its accepted enrollment prerequisite, claim/reclaim before provider-pending, deterministic transmission/membership, and same-payload replay.
- [ ] Create the exact existing CRM communication and outbox rows in the preparation transaction. Mark new CIM outbox rows so generic retry workers cannot claim them.
- [ ] Enforce payload/address/reply-to/tag/membership digest coverage and one active transmission membership per touch.
- [ ] Add real two-process SQLite and two-transaction PostgreSQL races for campaign generation and touch claim; normalize winner/loser results.
- [ ] Cover scenarios 37–40, 45, 47, and preparation portions of 48. Keep provider-call count zero.

**Focused commands:** `node --test test/pursueCimAutopilotStorage.test.js`; `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/pursueCimAutopilotPostgres.test.js`

**Commit:** `feat: prepare immutable CIM initial transmissions`

### Package 6A: Fresh final gate and consumed provider-pending authority (2–3h)

**Dependencies:** Package 5; current central pause remains on in every normal fixture. **Outcome:** The complete gate atomically records one consumed invocation authority or a stable block reason.

- [ ] Implement the complete predicate table, lock/CAS order, normalized outcomes, transactional audit append, provider-pending nonce digest, and ambiguous-commit zero-call behavior in both adapters.
- [ ] Add race barriers for owner/terminal/source/permission/timezone/window/pause/readiness/communication/outbox/payload changes between selection, claim, preparation, and gate.

**Commit:** `feat: add fresh CIM final gate`

### Package 6B: Default-deny provider seam and current writer convergence (2–3h)

**Dependencies:** Package 6A. **Outcome:** Every current or planned CIM-owned writer stops at one common seam without its exact authorization.

- [ ] Add the durable protected-work classifier, ephemeral nonce verification, atomic durable-pause/seam-entry CAS, environment hard-off check, and exact profile/path/work/payload checks inside private `sendMessage`.
- [ ] Route and individually test direct/admin, bulk/legacy automatic, Stage 2, broker-materials manual initial, legacy scheduled follow-up, operator-approved follow-up, CRM manual takeover outbox, exported CIM delivery convenience, new initial, new follow-up, and batch paths. Legacy/current paths get no live authorization by default; unrelated CRM/daily/application email remains unchanged.
- [ ] Cover scenario 58/80's complete path matrix and activation dependency negatives, including `fl04b-enrollment` being unable to send and `fl04b-initial` being unable to authorize follow-up.

**Focused command:** `node --test test/pursueCimProviderBoundary.test.js test/delivery.test.js test/followUpEmail.test.js test/cimCommunicationLifecycle.test.js`

**Commit:** `feat: default deny every CIM provider path`

### Package 6C: Provider outcome finalization, reconciliation, and crash matrix (2–3h)

**Dependencies:** Package 6B. **Outcome:** Accepted, definitive, pending, and ambiguous work finalize idempotently; recovery adds zero calls.

- [ ] Add crash injection after claim, preparation, provider-pending, seam entry, provider invocation, response, and finalization. Assert observed calls are 0 or 1 as specified and recovery adds zero.
- [ ] Add accepted/definitive/ambiguous finalization and exact reconciliation. Multiple provider IDs are high-severity ambiguity; never pick one.
- [ ] Cover scenarios 41–47, the definitive-failure/terminal half of scenario 48, scenarios 70–73, and 78 with SQLite/PostgreSQL parity. Deferred Package 4C owns scenario 48's reviewed-new-generation half; scenario 44's signed-webhook half completes in Package 7A.

**Focused command:** `node --test test/pursueCimProviderBoundary.test.js test/cimCommunicationLifecycle.test.js test/dealHunterScheduler.test.js test/followUpEmail.test.js`

**Commit:** `feat: reconcile CIM outcomes without retransmission`

### Package 6D: Dormant accepted-at follow-up slot chain (1–2h)

**Dependencies:** Packages 3 and 6C. **Outcome:** Finalization derives the exact next slot once for acceptance-scenario proof, while follow-up claim/provider work remains structurally disabled.

- [ ] Materialize follow-up-1/2/3 and later eligible weekday slot identities only from the prior accepted instant and stop at local expiry. Direct storage/service fixtures may advance synthetic accepted evidence to prove the chain; ambiguity creates none.
- [ ] Leave every derived follow-up nonclaimable unless a separate current `fl04c-followup` activation and prerequisite chain exists. FL-04B and mailbox initial activation cannot claim or send it.
- [ ] Prove scenarios 30–36 and 43 in SQLite/PostgreSQL/service tests before controlled mailbox; mailbox verifies its next slot is inert.

**Commit:** `feat: derive dormant CIM follow-up slots`

References to Package 6 below mean 6A–6D are complete.

### Package 7A: Conversation-first signed inbound (2–3h)

**Dependencies:** Packages 4A–4B and 6A–6D. **Outcome:** Exact reply evidence stops the conversation before content retrieval; weak sender evidence never auto-stops.

- [ ] Extend reply aliases/tags/communication metadata with conversation/transmission identity and protected membership references.
- [ ] Resolve signed alias or RFC thread/provider evidence before content fetch; append conversation terminal/audit events and stop later slots. Sender-only matches remain unassigned/review-required.
- [ ] Extend signed replay/out-of-order, content-fetch failure, same-broker unrelated, and ambiguous inbound fixtures for scenarios 44 and 54–56.

**Focused command:** `node --test test/pursueCimInbound.test.js test/emailWebhookReplay.test.js test/emailCommunicationLifecycle.test.js`

**Commit:** `feat: stop CIM conversations from exact inbound`

### Package 7B: Terminal-writer convergence and mandatory races (2–3h)

**Dependencies:** Package 7A. **Outcome:** Materials, diligence, suppression, unsafe delivery, identity ambiguity, archive, Watch, Pass, and explicit stop share atomic terminal revisions.

- [ ] Route every terminal writer through the common storage transition while retaining its existing domain evidence. Watch/Pass use the all-action idempotency contract.
- [ ] Test each writer racing the final gate in SQLite/PostgreSQL; a terminal commit first means zero provider calls, and a commit after provider-pending records the narrow in-flight race and stops later work.
- [ ] Cover scenarios 24 and 49–53, 57–58.

**Commit:** `feat: converge CIM terminal authority writers`

### Deferred Package 7C: Pure detail projection and explicit reconciliation (1–2h)

**Dependencies:** Packages 7A–7B and successful first-real-canary evidence; complete immediately after that proof or before broad Autopilot owner rollout, whichever comes first. **Outcome:** Legacy/new lifecycle reads are side-effect-free and reconciliation has a named internal writer path.

- [ ] Remove reconciliation from detail GET and add an explicit internal reconciliation entry point/job. Project legacy and new lifecycle together without mutating either.
- [ ] Extend broker-materials, detail, and read-only database-fingerprint tests; include all new business/audit tables in the fingerprint set.
- [ ] Preserve the pre-7C canary constraint: every new campaign, release-report, provider, and final-gate read is side-effect-free; the current detail GET is never canary authority; and Package 6B contains any legacy/manual/scheduled writer before provider access.

**Focused command:** `node --test test/dealHunterReviewReadOnly.test.js test/dealHunterTriageDetail.test.js test/dealHunterBrokerMaterials.test.js`

**Commit:** `refactor: make CIM campaign projections read only`

References to first-canary terminal handling below mean Packages 7A–7B. Package 7C is named explicitly for the post-canary read-path cleanup and broad-rollout gate.

### Package 8A: Canary-minimal projection and operator visibility (1–2h)

**Dependencies:** Packages 4A–4B, 5, 6A–6D, and 7A–7B. **Outcome:** A bounded server projection/release report, with minimal reuse of the existing Inbox/Drawer where useful, exposes enough durable state to select, review, authorize, observe, and stop one new post-cutover initial canary without offering an unsafe action.

- [ ] Reuse the normal Pursue control and bounded server projection to show queued/action-required state, canonical opportunity, selected recipient/contact authority, timezone authority, exact blocker/status, and an explicit stop action.
- [ ] Render the exact persisted held initial transmission/copy and immutable addressing/membership/expiry from the release report; never recompute a preview or make the current detail GET authoritative.
- [ ] Never render raw signed references after use, nonces, permission evidence, message bodies in telemetry, provider payloads, or a retry/resend/restart action for pending, ambiguous, or definitive-failure work.
- [ ] Add focused service/HTTP and minimal mounted UI/browser evidence for this canary flow without requiring full legacy/new lifecycle presentation.

**Focused commands:** `node --test test/pursueCimAutopilotService.test.js test/httpDealHunterTriageActions.test.js`; `npm run test:ui -- test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx`; after build, the canary-minimal cases in `npm run test:browser -- test-browser/pursue-cim-autopilot.spec.js`

**Commit:** `feat: show CIM canary release state`

### Deferred Package 8B: Full owner lifecycle UI (1–2h)

**Dependencies:** Packages 4C, 7C, and 8A; complete before broad normal Autopilot owner rollout. FL-04C-specific follow-up UI remains owned by Package 11. **Outcome:** The mounted Inbox/detail explains the complete legacy/new initial lifecycle and exposes only separately permissioned historical/restart actions.

- [ ] Show provider lifecycle, campaign generation/policy, terminal reasons, legacy classification, and the complete queued/initial-pending/action-required/provider-pending/accepted/ambiguous/definitive-failure/terminal presentation.
- [ ] Expose historical/restart commands only when the corresponding Package 4C server action reports current permission; never expose retry, send-again, or regenerate for pending/ambiguous/failure work.
- [ ] Complete mounted Vitest and Playwright coverage for the full lifecycle without creating a second frontend store or redesigning the Inbox.

**Focused commands:** `npm run test:ui -- test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx`; after build, the full-lifecycle cases in `npm run test:browser -- test-browser/pursue-cim-autopilot.spec.js`

**Commit:** `feat: show full Pursue CIM lifecycle`

### Checkpoint A: Synthetic/adversarial FL-04A/B candidate

**Dependencies:** Packages 0, 1A–1C, 2–3, 4A–4B, 5, 6A–6D, 7A–7B, and 8A on one unchanged candidate. Packages 1D, 4C, 7C, and 8B are not prerequisites for this local/synthetic gate. **Gate:** No provider-capable environment and central pause on.

- [ ] Run every first-canary-applicable portion of scenarios 1–58, 68–73, and 78–80 without a real mailbox; provider fake must report zero network calls in shadow/dry-run. Scenario 23 and the reviewed-restart halves of 25/48 remain mapped to Package 4C; scenario 77 remains mapped to Package 1D; full projection/UI evidence remains mapped to 7C/8B rather than disappearing.
- [ ] Run SQLite multiprocess and disposable PostgreSQL parity, migration-upgrade, crash, replay, and new-projection read-only checks. Package 1D owns the exact old-version binary check before production-shaped deployment; Package 7C owns the existing legacy detail-GET cleanup before broad owner rollout.
- [ ] Inspect the provider path inventory and prove every protected writer is default-denied without an exact envelope.
- [ ] Stop for review if one provider call lacks a committed transmission/communication/outbox authority, if one provider-pending item can be re-invoked, or if import creates/advances outreach.

### Package 9: Shadow evidence, operational accounting, and automatic containment (2–3h)

**Dependencies:** Checkpoint A. **Outcome:** FL-04A and FL-04B shadow runs are explainable, provider-inert, and capable of self-pausing on invariants.

- [ ] Add bounded operations projections/counters from spec section 20: decisions/enrollments, states/reasons, slots, transmissions, gate blocks, timezone/contact-permission failures, legacy classifications/writer invocations, provider-pending age, activation expiry, and provider-boundary accepts/rejects.
- [ ] Add alerts/containment for duplicate provider identities, missing durable authority, multiple active campaigns, duplicate accepted touch, active identity ambiguity, unexpected legacy invocation, reply/materials-before-gate followed by provider call, invalid timezone, expired activation, missing exact envelope, inbound/reconciliation readiness loss, and any shadow provider call.
- [ ] Add a read-only shadow runner that records would-enroll/would-claim/would-send decisions without creating campaign/touch/transmission rows and with provider calls structurally unavailable.
- [ ] Produce a release-evidence command/report with candidate commit/tree, policy/config hashes, scenario results, provider-call count, and capability/pause state. Do not include recipient addresses or copy.

**Focused command:** `node --test test/pursueCimAutopilotService.test.js test/pursueCimProviderBoundary.test.js test/operations.test.js`

**Commit:** `feat: add inert CIM autopilot shadow evidence`

### Package 10A: Structurally isolated mailbox profile/config (1–2h)

**Dependencies:** Package 9; a separate non-production process/database with distinct authenticated mailbox credentials/domain and exactly one allowed test recipient. **Outcome:** The mailbox process cannot resolve or route to the production provider identity.

- [ ] Add a server-owned profile resolver in `server/config.js` and delivery/inbound/reconciliation composition whose mailbox branch reads only distinct mailbox credential/sender/domain/webhook/reconciliation configuration names and cannot resolve production credential names.
- [ ] Bind activation, live authorization, reply alias, signed inbound, and reconciliation evidence to that profile. Enforce exactly one owner-controlled recipient allowlist entry before provider-pending.
- [ ] Prove substituting the production profile, credential namespace, recipient, domain, or webhook secret fails before provider-pending. The production process, database, configuration, credentials, and central pause remain untouched and active.

**Commit:** `feat: isolate the CIM controlled-mailbox profile`

### Package 10B: Controlled-mailbox plumbing evidence (1–2h)

**Dependencies:** Package 10A, external provider/contact-permission record, approved copy, and authenticated test sender/inbound profile. **Outcome:** One isolated initial transmission and signed inbound lifecycle prove the protocol with zero production-profile calls.

- [ ] Inspect and time-bound the isolated process's local hard-off/durable pause transition, then perform exactly one real outbound transmission to the one allowlisted controlled recipient. Record the real provider acceptance/message identity and signed sent/delivered ingestion when the provider emits those events.
- [ ] Send one real reply carrying the exact campaign/conversation evidence, prove it terminalizes future automated outreach, then deliberately run the later scheduler/final gate and observe zero additional provider calls. Verify the deterministic next slot is derived once but remains nonclaimable/provider-inert because FL-04C is off.
- [ ] Prove the mailbox process cannot resolve production provider configuration/credentials and that production central pause/state remains untouched. Record scenario 74 evidence with exact candidate, config/policy hashes, redacted provider IDs, exactly one provider call, and zero production-profile calls.
- [ ] Treat a real materials attachment as optional evidence when cheap and safe; it is not a blocker once the real reply hard-stop proves signed inbound association and terminalization.
- [ ] Keep definitive rejection, provider ambiguity, crash boundaries, response loss, activation expiry, timezone/window edges, replay/reordering mechanics, concurrency, and rollback state transitions in the deterministic fake/disposable suites. Do not manufacture provider failures for live coverage.

**Commit:** `test: prove isolated CIM initial lifecycle`

### Package 10C: Rollback and release-evidence rehearsal (1–2h)

**Dependencies:** Packages 10B and 1D. **Outcome:** Pause, expiry, withdrawal, rollback, inbound retention, and evidence capture are rehearsed without production access; exact old-version compatibility has already passed as an absolute deployment gate.

- [ ] Rehearse local pause restoration, activation/authorization expiry and withdrawal, code rollback to the exact old artifact, and current-version return against the disposable/copy database.
- [ ] Prove inbound/reconciliation evidence remains retained, old code ignores new rows, provider-pending is never retried, and the evidence packet records candidate/config/policy/schema hashes and commands.

**Commit:** `test: rehearse CIM campaign rollback evidence`

References to Package 10 below mean 10A–10C are complete.

### Checkpoint B: Owner authorization packet for one real canary

**Dependencies:** Packages 1D and 10A–10C, Checkpoint A/P9 evidence, and all external prerequisites. **This checkpoint prepares evidence; it does not authorize or execute production changes.**

- [ ] Confirm P8-00 provider/contact basis for the exact selected opportunity, approved initial copy/footer/opt-out treatment, current sender authentication, signed inbound health, storage/reconciliation health, canonical/CRM uniqueness, and selected explicit/derived timezone evidence.
- [ ] Independently inspect the effective production central pause and every capability activation. Resolve the checked-in config discrepancy with observed evidence; do not infer state from `fly.toml`.
- [ ] Use the prepare-only command under pause to persist and owner-review one immutable held transmission/communication/outbox, then issue an exact expiring authorization naming that existing opportunity, campaign, transmission, payload, writer path, recipient-authority digest, production provider profile, and maximum one call. Exercise payload drift, expiry, withdrawal, and resume rejection before the real transition. FL-04C remains off.
- [ ] Rehearse immediate containment: restore central pause, withdraw authorization, stop claims/scheduler, keep inbound/reconciliation on, and preserve evidence.
- [ ] Require explicit audited release-owner authorization for the time-bounded production pause transition. Execute scenarios 75 and 80 only in separately authorized release work; restore the pause as part of completion.

### Deferred Package 11: Activate FL-04C follow-up claiming, sending, and owner UI (3–4h)

**Dependencies:** Package 6D, successful real FL-04B canary evidence, and separate FL-04C follow-up activation. **Outcome:** The already-proven accepted-at slot chain becomes claimable under the same one-shot provider protocol; no batching yet.

- [ ] Admit follow-up slot claiming only when the exact `fl04c-followup` activation names the current accepted `fl04b-initial` prerequisite and policy/evidence hashes.
- [ ] Reuse the same preparation, complete final gate, provider-pending, inbound stop, and reconciliation protocols for the dormant slot identities. Do not adapt the legacy scheduler.
- [ ] Add the generalized follow-up lifecycle UI only with this separately activated capability; it must not expose retry/send-again for provider-pending, ambiguous, or definitive-failure work.
- [ ] Prove scenarios 30–36, 41–58, 68–74, and follow-up portions of 80 in controlled mailbox before any bounded pilot.

### Deferred Package 12: FL-04C same-broker batching (2–3h)

**Dependencies:** Package 11 controlled-mailbox evidence; separate batching activation. **Outcome:** Compatible overlapping touches share one transmission/provider identity while campaigns remain separate.

- [ ] Deterministically group by conversation, recipient authority, local window, sender/reply/template/policy compatibility, bounded coalescing interval, size, and safety ceiling.
- [ ] Cancel an immutable prepared batch if any member fails final gate; rebuild a deterministic safe subset before provider-pending. Never mutate membership after provider-pending.
- [ ] Project one communication under every member without cloning it. Apply conversation-wide reply stop and opportunity-specific materials outcomes.
- [ ] Prove scenarios 59–67 and the batch portion of 80 in controlled mailbox.

### Deferred Checkpoint C: Bounded FL-04C pilot

**Dependencies:** Packages 11–12, controlled-mailbox acceptance, successful FL-04B canary, extended scenario 80 evidence, and separate owner activations for follow-up and batching. Keep the central pause and exact live envelopes authoritative. This plan does not authorize the pilot.

## Acceptance-scenario coverage matrix

Every spec scenario has an owning layer, focused evidence, and package. `PG` means disposable PostgreSQL/Supabase parity; `SQ` means real SQLite; `Svc` means service/API with deterministic clock/provider fake; `UI` means mounted Vitest; `Browser` means Playwright; `Mailbox` means isolated real-provider evidence; `Release` means separately authorized real-canary evidence.

| # | Scenario shorthand | Required layer/evidence | Owner |
| ---: | --- | --- | --- |
| 1 | No-URL Sheet repeat | SQ/PG admitted import: one canonical ID, two observations | P2 |
| 2 | Later URL keeps fingerprint alias | SQ/PG canonical resolver + August fixture | P2 |
| 3 | Concurrent Sheet/Deal OS convergence | SQ multiprocess + PG concurrent transactions; one ID or one exception | P2 |
| 4 | Materially conflicting lookalike distinct | Identity regression from incident fixture | P2 |
| 5 | Exact syndicated ID merges | Canonical resolver/storage parity | P2 |
| 6 | Insufficient evidence ambiguity | Import + safety event; no campaign effects | P2 |
| 7 | Passed re-import remains Passed | Real admitted import + disposition assertion | P2 |
| 8 | Archived CRM re-import inert | Import/CRM owner assertion | P2 |
| 9 | Active campaign re-import evidence-only | Safety consumer + row fingerprint diff | P2 |
| 10 | Receipt equations and safety run | SQ/PG run accounting to terminal/pending outcomes | P2/P9 |
| 11 | All import paths create zero outreach | Provider counter + lifecycle table fingerprints | P2 |
| 12 | August transition cannot create three generations | Incident fixture + generation uniqueness | P2/P4B |
| 13 | Decision precedes orchestration | Inject CRM failure; decision/enrollment survive | P4A/P4B |
| 14 | Missing recipient action-required | Svc/storage, zero transmission/provider | P4B |
| 15 | Multiple recipients need opaque ref | Broker-authority/API negative and positive tests | P4B |
| 16 | Stale/changed contact ref rejected | Signed ref revision/provenance test | P4B |
| 17 | Exact canonical CRM owner reused | Existing CRM match + new campaign assertion | P4B |
| 18 | CRM ambiguity/superseded loser blocks | Existing supersession fixtures + zero provider | P4B |
| 19 | Two rapid identical Pursues | SQ/PG race: one decision/enrollment/generation | P4A/P4B |
| 20 | Same key/different payload rejects | Storage/API digest conflict | P4A/P4B |
| 21 | New key/current Pursue returns existing | Storage/API idempotency result | P4A/P4B |
| 22 | Historical Pursue remains unenrolled | Upgrade fixture/table fingerprints | P1A/P4B |
| 23 | Historical canary exact activation | Svc activation/cohort + one generation; deferred until after first canary | P4C |
| 24 | Watch/Pass atomically stops/cancels | SQ/PG transition + existing Pass tests | P4A/P7B |
| 25 | Prior accepted request blocks/reviewed restart only | P4B proves the blocker; deferred P4C proves the separately reviewed restart | P4B/P4C |
| 26 | CA/NY/AZ IANA behavior | Pure clock tests, including Phoenix DST | P3 |
| 27 | Missing/ambiguous timezone blocks claim | Policy + claim/final-gate tests | P3/P6 |
| 28 | Initial window roll | Pure clock table tests | P3 |
| 29 | Weekend to Monday | Pure clock table tests | P3 |
| 30 | Follow-up 1 accepted+48h | Pure policy + dormant accepted finalization | P3/P6D |
| 31 | Follow-up 2 accepted+72h | Pure policy + dormant synthetic accepted chain | P3/P6D |
| 32 | Follow-up 3 accepted+96h | Pure policy + dormant synthetic accepted chain | P3/P6D |
| 33 | Later weekday deterministic slots | Pure policy + dormant slot storage | P3/P6D |
| 34 | DST gap/repetition | Pure instant/local derivation fixtures | P3 |
| 35 | 21-local-day expiry | Policy + dormant materialization/claim boundary | P3/P6D |
| 36 | Ambiguity creates no next slot | Finalization/policy assertion | P3/P6D |
| 37 | SQLite campaign race | Two worker processes, one generation | P4B/P5 |
| 38 | PostgreSQL slot race | Concurrent transactions, normalized winner | P5 |
| 39 | Pre-transmission lease reclaim | SQ/PG clock/claim test, same touch ID | P5 |
| 40 | Post-preparation crash keeps payload | Restart/replay digest assertion | P5 |
| 41 | Post-provider-pending pre-seam crash | Crash injection; 0 calls; recovery adds 0 | P6 |
| 42 | During/after invocation crash | Fake holds/throws; at most 1; recovery adds 0 | P6 |
| 43 | Accepted finalization anchors once | SQ/PG idempotent finalization and dormant next slot | P6C/P6D |
| 44 | Signed replay/out-of-order | Webhook fixtures + finalization revision | P6/P7 |
| 45 | Key with changed exact payload fails | Digest mutation table, zero provider | P5/P6 |
| 46 | Multiple provider IDs ambiguous | Reconciliation test + containment alert | P6/P9 |
| 47 | Legacy stale claim cannot authorize | Boundary negative test | P5/P6 |
| 48 | Definitive failure/reviewed generation | P6C proves terminal failure; deferred P4C proves the reviewed new generation | P6C/P4C |
| 49 | Reply after selection before gate | Barrier race; terminal rev wins; 0 provider | P6/P7 |
| 50 | Materials after claim before gate | Barrier race; direct materials read; 0 provider | P6/P7 |
| 51 | Pass/Watch/archive/etc. drift | Parameterized final-gate blockers, 0 calls | P6 |
| 52 | Source/freshness drift | Direct authority reads despite delayed consumer | P2/P6 |
| 53 | Permission/cohort drift | Parameterized activation/revision tests | P6 |
| 54 | Reply alias stops before content | Fetch failure after signed alias; terminal persisted | P7 |
| 55 | Same-broker sender-only does not stop | Inbound unassigned/review test | P7 |
| 56 | Ambiguous broker inbound fails closed | Inbound fixture, review-required | P7 |
| 57 | Advanced diligence stops all unsent | Materials predicate + terminal writer | P7 |
| 58 | Central pause blocks every path, including CRM CIM manual takeover; inbound works | Full writer-path matrix + signed inbound | P6B/P7A |
| 59 | Five opportunities remain five campaigns | Storage/service controlled fixture | P12 |
| 60 | Overlap batches to one call | Deterministic batch + provider counter | P12 |
| 61 | One communication visible to every member | Projection/storage FK/membership test | P12 |
| 62 | Ineligible member cancels/rebuilds subset | Final-gate barrier + deterministic rebuild | P12 |
| 63 | Size overflow bounded batches | Pure partition/property cases | P12 |
| 64 | Safety ceiling defers, does not discard | Scheduler/accounting test | P12 |
| 65 | Shared alias stops conversation | Signed inbound controlled fixture | P12 |
| 66 | Labeled materials satisfy one member | Materials classification/member test | P12 |
| 67 | Unclear attachment stops/reviews | Inbound/materials controlled fixture | P12 |
| 68 | Legacy policy classifications distinct | Classifier tests first; full legacy/new projection after canary | P1A–P1C/P7C |
| 69 | Legacy accepted/ambiguous blocks campaign | Enrollment authority fixture | P4B |
| 70 | Migration changes no activation/pause | Upgrade DB fingerprints | P1A |
| 71 | FL-04A shadow zero calls | Shadow report + unreachable provider fake | P9 |
| 72 | FL-04B cannot authorize follow-ups | Five-capability dependency/path negative tests | P6B/P6D/P9 |
| 73 | FL-04C cannot bypass central pause | Boundary negative tests | P6/P12 |
| 74 | Isolated mailbox full initial lifecycle | One real isolated outbound, provider identity/events, exact reply hard-stop, later zero calls; failure/crash edges remain synthetic | P10B |
| 75 | One real canary exact selection/expiry | Prepare/hold/owner-authorize/resume plus separately authorized release evidence | Checkpoint B |
| 76 | Rollback pause preserves inbound/reconcile | Disposable rollback rehearsal | P10C |
| 77 | Old version ignores new campaigns | Old-code/additive-schema fixture and rehearsal | P1D/P10C |
| 78 | Unknown policy is inert | Adapter/service/boundary negative test | P6/P7 |
| 79 | Untouched evidence byte-for-byte | Pre/post upgrade checksums and row dumps | P1A/P1D |
| 80 | Only exact selected canary reaches seam | Full writer matrix including CIM-linked CRM manual takeover; Mailbox then Release | P6B/P10/Checkpoint B |

## Critical path, prerequisites, and estimates

These are implementation-owner estimates, not calendar promises. They assume the repository fixtures are healthy and exclude external approval latency. The ranges are dependency-accounted revisions of the original plan: they remove P4C, P7C, and P8B from first-canary work; narrow live-mailbox evidence; and move P1D later without removing it from canary readiness.

| Milestone | Required packages/checkpoints | Engineering critical path | External prerequisites |
| --- | --- | ---: | --- |
| Local/synthetic production-shaped FL-04A/B shadow | P0, P1A–P1C, P2–P3, P4A–P4B, P5, P6A–P6D, P7A–P7B, P8A, Checkpoint A, P9 | ~34–45 hours | None locally; any deployed production-shaped observation additionally requires P1D and deployment authority |
| Isolated controlled mailbox | Shadow + P1D + P10A–P10C | ~38–53 hours | P8-00/contact basis for test, approved copy, isolated authenticated sender/inbound credentials/domain, one allowed recipient |
| One real initial canary readiness | Controlled mailbox + Checkpoint B | ~41–58 engineering hours plus separately authorized release work | One new post-cutover permission-approved opportunity, production sender/inbound/reconciliation health, timezone authority, owner copy acceptance, current pause inspection, audited time-bounded pause change, rollback authority |
| Deferred post-canary owner workflows | P4C + P7C + P8B | +3–6 hours before those commands/broad owner rollout | Successful first canary; separate authorization before historical/restart use |
| FL-04C follow-up activation | Successful canary + P11 | +3–4 hours implementation, then mailbox evidence | Separate follow-up activation and extended scenario 80 |
| FL-04C batching activation | Follow-up proof + P12 + Checkpoint C | +2–3 hours implementation, then mailbox evidence | Separate batching activation, bounded cohort, owner approval |

The exact first-canary path is P0; P1A–P1C; P2–P3; P4A–P4B; P5; P6A–P6D; P7A–P7B; P8A; Checkpoint A; P9; P10A–P10C; P1D before any production-shaped deployment and as a prerequisite of P10C/Checkpoint B; then Checkpoint B. It selects one **new post-cutover Pursue** and retains only the dormant, nonclaimable FL-04C slot derivation from Package 6D. P4C, P7C, and P8B move after first-canary proof; deterministic provider-failure/crash/edge evidence stays in synthetic/disposable suites instead of being repeated live. The revised ~41–58-hour readiness range preserves safety, dual-provider parity, inbound hard-stop, containment, isolated-mailbox plumbing, exact rollback compatibility, and the release gate; repository evidence still does not support a credible 16–28-hour estimate. Do not recover schedule by adapting the legacy follow-up scheduler, treating Stage 2 activation as campaign authority, using provider idempotency as retry permission, weakening test/provider parity, or letting an import enroll work.

## Verification gates

### Per-package discipline

1. Add the named RED case and confirm it fails for the intended missing contract.
2. Implement the smallest package boundary.
3. Run focused tests to green for both storage providers where state/constraints are involved.
4. Inspect `git diff --check`, package-scoped diff, schema/RPC grants, and generated data provenance.
5. Commit one coherent unit. Do not amend unrelated user work.

### Candidate gate after Checkpoint A/P9

On one unchanged commit, run:

~~~bash
npm run check
DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/pursueCimAutopilotPostgres.test.js
npm run test:browser -- test-browser/pursue-cim-autopilot.spec.js
~~~

Also run the full scenario manifest for the activated stage, SQLite multiprocess race/crash suite, migration from the prior schema, and provider-path inventory. Hosted PR CI, if separately authorized, must independently pass its audit/lint/node/UI/build/browser gates. Diagnose real failures; do not waive them as flaky without evidence.

### Risk checkpoints that stop progression

- More than one provider identity for one transmission, one touch accepted twice, or one opportunity with two active campaign generations.
- A provider seam entry without committed transmission, communication, outbox, final-gate revisions, consumed invocation authority, and exact live authorization.
- Any path able to invoke again after provider-pending, including lease expiry, restart, manual click, generic outbox retry, or Stage 2 reconciliation.
- An import or any new campaign/release read creates or advances outreach; the canary relies on the existing detail GET as authority; or the bounded pre-7C legacy reconciliation path does anything beyond finalizing existing accepted evidence. Package 7C still makes the entire detail GET side-effect-free before broad owner rollout.
- SQLite/PostgreSQL disagreement in uniqueness, race result, state transition, or normalized error.
- Reply/materials/Pass/source/permission/timezone/pause commits before the final gate but provider call count is nonzero.
- Shadow/dry-run touches a provider; controlled mailbox can resolve production credentials/profile; nonselected path reaches the seam.
- Effective central pause/activation state cannot be independently demonstrated, signed inbound or reconciliation is unhealthy, or external permission/copy/timezone evidence is absent.

## Rollout and rollback runbook boundary

Implementation and merge do not activate anything. A later authorized release follows these stages:

1. Verify backup/recovery evidence, exact candidate commit/tree, migrations, storage health, signed inbound, reconciliation, canonical intake, CRM ownership, effective central/capability pause, and successful Package 1D execution against the exact rollback artifact.
2. Only after Package 1D passes, apply additive schema with every new capability absent/off and central pause active. Run compatibility/readiness checks; no backfill. A Package 1D failure blocks deployment absolutely even when Packages 2–10 are otherwise complete.
3. Deploy dual-compatible code. Confirm every legacy/new protected CIM path is default-denied and ordinary non-CIM email still works.
4. Activate FL-04A shadow only; then FL-04B shadow only. Require zero provider calls and accepted scenario evidence.
5. In the separate non-production mailbox process/database, activate the structurally isolated profile for one test recipient and perform its separately audited local-pause transition. Keep the production process, configuration, credentials, database, and central pause unchanged.
6. Only after Checkpoint B authorization, issue one expiring exact canary envelope and perform the audited, time-bounded production pause transition. Restore pause immediately after the one transmission or any failure.
7. Observe provider identity, signed events, reply/materials stop, ambiguity age, legacy invocation attempts, and every boundary rejection. Follow-ups and batching remain off.

Rollback/containment is pause-first and evidence-preserving:

- Restore/confirm central pause, withdraw current live authorizations and capability activations, and stop new claims. Keep signed inbound/event storage and reconciliation available.
- Do not delete campaigns/touches/transmissions, clear provider-pending, rewrite idempotency keys, reopen slots, or retry ambiguity.
- Application rollback to the old version is allowed only after central pause is proven active. The additive schema is retained; old code ignores new rows and does not schedule them. Old inbound code continues retaining signed events in existing tables; new campaign projection may lag until the current version returns, which is safe because all provider work is paused.
- If schema defects require a forward repair, use a new additive migration. Do not drop retained lifecycle tables as an operational rollback.
- Preserve provider-pending/ambiguous rows for reconciliation and incident review. A missed message is preferable to a duplicate.

## External prerequisites and settled non-questions

No product or architecture decision needs reopening. These activation inputs remain external and fail closed when absent:

- documented provider/contact-permission basis for the exact use and cohort;
- owner-approved initial/follow-up/batch copy and footer/opt-out treatment;
- authenticated sender and signed inbound/reconciliation health for the selected provider profile;
- a selected, licensed, versioned location-to-IANA resolver before derived timezone authority is used (explicit verified IANA facts remain eligible without it); and
- explicit release-owner authorization for any production pause change or provider use.

This plan authorizes documentation and later implementation work only. It does not authorize dependency installation in production, database migration, deployment, source import, credential change, capability activation, central-pause change, provider call, controlled-mailbox send, or real canary.
