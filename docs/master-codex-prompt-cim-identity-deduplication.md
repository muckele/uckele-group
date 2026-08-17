# Master Codex prompt: prevent duplicate CIM sequences and repair email lifecycle history

Use the prompt below in a fresh Codex task rooted at this repository.

---

You are working in the existing Uckele Group repository. Implement and verify a production-safe fix for duplicate Deal Hunter CIM outreach caused by changing opportunity identities, incomplete recipient-level cadence enforcement, misleading raw lifecycle rendering, and historical CRM linkage drift.

Work through the implementation completely: inspect the current repository and production-safe interfaces, design additive storage changes, implement the server and admin UI changes, add both SQLite and Supabase migrations, build a dry-run-first repair tool, update tests and operational documentation, run the proportionate closure suite, and provide a deployment and rollback runbook. Do not stop at a plan.

## Safety and authorization boundary

This is an implementation task in the local repository. It does not authorize sending any email, changing any provider configuration, mutating production records, running a repair with `--apply`, enabling automation, or deploying. Provider calls in tests and reproductions must be faked or fail closed before the network.

Production inspection, if available, must be read-only and redacted in outputs. Never print API keys, email bodies, reply aliases, raw headers, cookies, session tokens, or unrestricted recipient lists. Do not weaken current authentication, source-health gates, signed approval snapshots, durable communication persistence, suppressions, claim leases, provider idempotency, inbound-reply checks, archive guards, or corrected-recipient safeguards.

Preserve unrelated worktree changes. At the time this prompt was written, `fly.toml` had an intentional local change enabling the fail-closed CIM follow-up scheduler, and several other master prompt files were untracked. Do not overwrite, stage, commit, delete, or reformat unrelated files.

## Confirmed incident and current-state evidence

The incident was investigated on August 12, 2026. Treat these facts as the regression target, but use synthetic values in committed tests.

### Confirmed transmission evidence

For one broker recipient and one repeated subject family, the production database contains:

- three persisted `deal_hunter_cim_requests` under three distinct `deal_key` values;
- 12 distinct non-empty provider message IDs returned by Resend;
- a signed webhook `email.sent` event for each of the 12 provider message IDs;
- a signed webhook `email.delivered` event for each of the 12 provider message IDs;
- three sequences, each consisting of one initial CIM request and three follow-ups;
- no active or scheduled follow-up remaining for those requests; every sequence is complete and `next_follow_up_at` is null.

Resend defines `email.sent` as a successful API request for which it will attempt delivery, and `email.delivered` as successful delivery to the recipient's mail server. Therefore, the durable evidence establishes at least 12 accepted and mail-server-delivered messages. The production API key is intentionally send-only, so `GET /emails/:id` returns a restricted-key 401 and cannot be used for a second provider lookup. Do not broaden the key merely for this fix. Relevant official documentation:

- https://resend.com/docs/webhooks/event-types
- https://resend.com/docs/webhooks/emails/delivered
- https://resend.com/docs/api-reference/emails/list-emails
- https://resend.com/docs/dashboard/emails/idempotency-keys

There is an older request timestamp predating the first retained provider event. Do not claim that exactly 12 messages were the only possible historical transmissions. The precise defensible statement is: **12 distinct Resend messages are confirmed delivered by retained provider IDs and signed webhooks.** Preserve that wording in incident documentation.

### Identity transition that caused duplicate outreach

One underlying listing initially had no listing URL, so Deal Hunter assigned a fingerprint key derived from normalized name, location, asking price, and profit. The same listing later acquired a canonical BizBuySell URL and therefore received a new URL-based `deal_key`.

The old fingerprint opportunity and the later URL opportunity matched on all of the following high-confidence attributes:

- normalized business name;
- normalized broker recipient;
- location;
- asking price;
- revenue;
- profit;
- source history.

The system did not retain the fingerprint as an alias of the URL-based opportunity. It treated the URL identity as new and allowed a second four-touch sequence.

A second BizBuySell URL used the same generic title, revenue, and broker but had a different listing ID, geography, asking price, and profit. It is evidence of a distinct opportunity and must **not** be merged merely because its name and broker match.

The fix must distinguish these cases:

1. same opportunity evolving from fingerprint to URL identity: automatically link when evidence is exact/high-confidence and non-conflicting;
2. distinct listings handled by the same broker: keep separate opportunities, while still applying recipient-level cadence and batch safeguards;
3. ambiguous similarity: do not auto-merge and do not send; surface a reviewable identity exception.

### Current-code reproduction

A credential-free reproduction against the current code succeeded with this sequence:

1. Review a synthetic high-fit listing with no URL. Its key begins with `fingerprint:`.
2. Insert a completed request for that fingerprint key and recipient.
3. Review the same synthetic listing again after adding a BizBuySell URL, with the same normalized name, recipient, location, asking price, revenue, and profit.
4. Its key now begins with `url:`.
5. The current review reports `cimRequest.canRequest === true`.
6. A signed bulk selection reaches the private send path, persists a second request, and prepares a second outbound communication.
7. Missing provider credentials prevent the external call in the reproduction.

This proves the core defect remains present in the current branch. Add this as a permanent regression test using repository-local fixtures and no real provider call.

### Live exposure at investigation time

The live source was not actively resending the known incident on August 12, 2026:

- both current URL-based listings were recognized as `sent`;
- the source review was healthy;
- the live review reported zero CIM-ready opportunities;
- the three historical sequences were complete;
- no known request for that recipient had `next_follow_up_at` set.

The defect is latent: it reappears when a listing gains or changes identity, or when equivalent source rows arrive under unlinked keys.

### Timeline amplification

The CRM activity timeline currently renders raw email lifecycle events as independent rows. One real message typically produces:

1. a local tracked `email.sent` event when Resend accepts the API request;
2. a signed Resend `email.sent` webhook event;
3. a signed Resend `email.delivered` webhook event.

The screenshot showed 21 activity rows, but those rows represented seven distinct provider message IDs. Durable raw events are valuable and must remain stored. The UI needs to group them into one logical message lifecycle, with an optional expandable audit trail.

### Out-of-hours follow-ups

Some confirmed follow-ups were sent around 12:47 a.m. Pacific. Current CIM follow-up policy checks weekdays in the configured timezone but has no send-window start or end. The generic CRM follow-up system has a send window, but Deal Hunter CIM follow-ups do not. Add a separate, explicit CIM follow-up business-hours window and enforce it server-side.

## Current weaknesses to inspect before editing

Verify the current line numbers rather than assuming they remain exact. The known weak boundaries are:

- `server/services/dealHunter.js`
  - `buildDailyDealReview` loads CIM requests only for current `dealKey` values;
  - `attachCimRequestStatus` maps requests by exact deal key and exact deal-key/recipient pairs;
  - `sendCimRequestForScoredDeal` rechecks only requests returned for the current deal key;
  - `buildCimRequestId` hashes the mutable `dealKey` and recipient;
  - CRM import lookup prioritizes current listing URL and current deal key but retains no durable alias graph;
  - follow-up selection and claims are request-scoped rather than canonical-opportunity-scoped;
  - `isCimFollowUpSendDay` enforces weekdays only.
- `server/services/cimAutomation.js`
  - Stage 2 considers prior recipient outreach;
  - Stage 1 manual/direct/bulk paths do not receive the same recipient guard;
  - the configured 30-day broker cap counts requests/initials, not all accepted outbound touches;
  - automation checks are advisory unless the private send boundary repeats them.
- `server/services/delivery.js`
  - Resend idempotency keys are derived from request IDs;
  - request IDs change when `dealKey` changes;
  - Resend retains an idempotency key for only 24 hours, so provider idempotency cannot replace durable application identity and policy checks.
- `server/services/emailEvents.js`
  - a local `sent` event and signed webhook lifecycle events are all intentionally persisted.
- `src/components/admin/DealActivityTimeline.jsx`
  - every raw activity row is displayed separately;
  - there is no logical-message grouping by `communicationId` or provider `messageId`.
- SQLite and Supabase storage/migrations
  - historical request, communication, activity, and CRM submission links can disagree after identities evolve;
  - duplicate CRM records can exist for fingerprint and URL representations of one listing.

## Required outcomes

Implement all of the following as one coherent fix.

### 1. Add a stable canonical opportunity identity and alias model

Create an additive, server-owned canonical identity model that survives source and URL evolution. A reasonable design is a `deal_hunter_opportunities` table plus a `deal_hunter_opportunity_aliases` table, but adapt naming to repository conventions if an equivalent design is clearer.

The canonical opportunity record must have an immutable `opportunity_id`. Aliases must support at least:

- canonical listing URL identity;
- stable source record ID when supplied by a trusted source;
- historical `deal_key` values;
- conservative fingerprint signatures;
- source-specific identities.

Each alias should retain enough provenance to audit why it was linked: alias type/value, source, first/last observed timestamps, evidence version, resolution method, confidence state, and actor when manually resolved. Alias values must be uniquely constrained where appropriate.

Add nullable `opportunity_id` references and indexes to CIM requests, CRM import bookkeeping, and any other authoritative records needed to make final-send decisions and repair linkage. Preserve backward compatibility while migrations/backfill are incomplete.

Implement equivalent additive migrations for both SQLite and Supabase. SQLite must migrate automatically according to current repository conventions. Supabase must use committed SQL migrations, service-role isolation, appropriate indexes/constraints, and no broadened client policies.

### 2. Use conservative deterministic identity resolution

Centralize identity resolution in a tested service rather than duplicating comparisons across review, CRM import, and send paths.

Resolution order should prefer exact evidence:

1. existing alias match;
2. canonical listing URL/listing ID match;
3. trusted stable source ID match;
4. a high-confidence fingerprint transition with non-conflicting evidence;
5. ambiguous/manual-review outcome;
6. genuinely new canonical opportunity.

Normalize URLs safely: lower-case hosts, remove tracking-only query parameters/fragments, normalize trailing separators, retain the provider's stable listing ID, and never accept unsafe protocols. Test slug changes where a stable listing ID remains the same.

For a fingerprint-to-URL transition, permit automatic linking only when a conservative set of fields agrees and no material field conflicts. At minimum consider normalized recipient, normalized name, source history, geography, asking price, revenue, and profit. Define explicit numeric normalization/tolerance rules and version them. Same name plus same broker is not enough. Same subject is not enough. Do not merge two URLs with different provider listing IDs solely because other text overlaps.

When evidence is ambiguous, create a durable identity exception and block new outreach. Expose the exception to a full administrator with a comparison of safe fields and a deliberate resolution action. Manual resolution must require confirmation, a reason, actor, timestamp, and audit activity. Viewers remain read-only.

### 3. Enforce identity at the private send boundary

Review and UI checks are not sufficient. Every initial CIM send entry point must re-resolve the canonical opportunity immediately before claiming/persisting/transmitting:

- direct single send;
- bulk approved send;
- automated Stage 2/Stage 3 send;
- corrected-recipient retry, without weakening its current restrictions;
- any legacy or cron-accessible initial-send path.

At the final boundary:

- resolve the canonical opportunity from current server-fetched source data and signed approval evidence;
- load accepted, delivered, pending, claimed, responded, stopped, and terminal request history across every alias for that opportunity;
- block duplicate first contact when any alias already owns an accepted/completed request;
- block or reconcile a recent in-progress request under any alias;
- use canonical `opportunity_id` for the application lock, durable request identity, communication identity, and new idempotency-key derivation;
- preserve old request IDs and provider IDs for historical records;
- repeat source-health, archive, suppression, recipient, snapshot, and identity checks atomically as late as practical;
- fail closed if canonical identity storage or comparison fails.

Provider idempotency remains defense in depth. Continue sending an `Idempotency-Key`, but do not rely on Resend's 24-hour retention to prevent cross-day or cross-alias duplicate outreach.

Add race tests showing that concurrent fingerprint and URL representations cannot create two request claims or two prepared communications for one canonical opportunity.

### 4. Add recipient-level cadence and batch safeguards across all stages

The same broker may legitimately represent several distinct opportunities, so do not merge opportunities based only on recipient. Instead, introduce a separate recipient policy that covers all CIM outreach stages and all canonical opportunities.

The policy must:

- count accepted outbound logical messages, not raw lifecycle rows;
- include initials and follow-ups;
- deduplicate counts by communication ID or provider message ID;
- apply at preview/review time for visibility and again at the private send/follow-up boundary for authority;
- apply to manual Stage 1, bulk, automated stages, scheduler runs, and manual “Run Follow-Ups” actions;
- prevent multiple initial sends to one recipient in the same bulk operation by default;
- prevent automation from overriding recipient limits;
- support a conservative configurable rolling 24-hour and 30-day touch cap;
- make configuration explicit in `.env.example`, deployment documentation, validation, Operations readiness, and `fly.toml` only after a human selects production values;
- never normalize invalid values into permissive passing values.

If a full administrator may override a recipient cap for two demonstrably distinct opportunities, the override must be server-authoritative, per-opportunity, explicitly confirmed, reasoned, time-bounded if appropriate, and audited. A signed queue snapshot alone is not an override. Viewers and automation cannot override. An override for one initial must not silently authorize its future follow-ups; each subsequent touch remains subject to policy unless the reviewed policy explicitly and safely says otherwise.

Add an operations kill switch such as `DEAL_HUNTER_CIM_OUTREACH_PAUSED` that blocks all new initial and follow-up transmissions—manual, bulk, automated, scheduled, and admin-triggered—while preserving read-only review, preview, history, inbound reply processing, reconciliations, and safe lifecycle updates. This must be separate from the existing staged-automation pause, which does not cover manual sends or follow-ups.

### 5. Enforce a CIM follow-up send window

Add explicit Deal Hunter CIM follow-up settings, for example:

- `DEAL_HUNTER_CIM_FOLLOW_UP_SEND_WINDOW_START=08:00`
- `DEAL_HUNTER_CIM_FOLLOW_UP_SEND_WINDOW_END=17:00`
- existing `DEAL_HUNTER_CIM_FOLLOW_UP_TIMEZONE`

Use repository time-window helpers if they are correct and shared safely. The scheduler and admin-triggered run must not transmit outside the allowed local window. They should return a deferred result and retain/reschedule due work without consuming a touch or claim.

Test:

- before, within, and after the window;
- weekday and weekend combinations;
- DST transitions in `America/Los_Angeles`;
- invalid window values fail configuration validation;
- an out-of-window manual run performs no provider call;
- delayed work remains eligible at the next valid window.

Do not describe `next_follow_up_at` as an exact guaranteed delivery time; it is the earliest eligible time subject to safety gates, caps, source/reply state, and the send window.

### 6. Keep one active sequence per canonical opportunity

The follow-up scheduler must reason over canonical opportunity identity, not only request ID.

Before every follow-up:

- check whether another request alias for the same canonical opportunity has responded, bounced, complained, failed permanently, been suppressed, been archived, been manually taken over, or is already active;
- check the global recipient policy;
- ensure at most one active sequence owns the next touch;
- stop or quarantine duplicate active sequences without deleting them;
- retain immutable evidence of why a sequence was selected, stopped, or deferred.

An exact inbound reply tied to any alias/request for the canonical opportunity must stop all active automated sequences for that canonical opportunity. Do not stop unrelated opportunities merely because the broker address is shared, unless the message is an explicit global opt-out, complaint, hard bounce policy event, or global suppression.

### 7. Correct CRM and activity linkage without erasing history

Use canonical opportunity identity to prevent future duplicate CRM records and to link requests, communications, replies, documents, and activities to the correct CRM submission.

Requirements:

- one canonical opportunity may designate one primary CRM submission;
- legacy duplicate submissions remain auditable;
- do not hard-delete duplicate submissions or email events;
- do not silently combine two distinct provider listing IDs;
- use explicit link/alias metadata or an additive relationship table rather than rewriting history opaquely;
- new activity should resolve through request/communication/opportunity ownership rather than a mutable or stale submission ID;
- ambiguous historical linkage must remain in a review queue instead of being guessed;
- archive/duplicate disposition, if offered, must be reversible and audited;
- retain exact provider message IDs, communication IDs, event IDs, timestamps, bodies, and lifecycle evidence.

### 8. Group logical email lifecycles in the CRM timeline

Keep every raw durable activity and email event in storage. Change the display projection so one actual message is one timeline item.

Group with this preference:

1. canonical communication ID;
2. provider plus provider message ID;
3. a safe fallback only when identity is truly exact;
4. otherwise leave the event ungrouped.

Never group different non-empty provider message IDs merely because recipient, subject, or timestamp match. Never hide replies, complaints, bounces, suppressions, or failures.

For each logical message show:

- action/kind: initial CIM request, follow-up number when known, generic CRM email, or reply;
- current lifecycle state using a documented precedence such as complained/suppressed, bounced/failed, replied, delivered, delayed, sent/accepted, queued;
- recipient display appropriate to the protected admin context;
- accepted/sent time and latest lifecycle time;
- correct canonical opportunity/CRM record;
- an expandable “provider and audit events” list containing the retained local acceptance and webhook events.

The Email filter should report both logical message count and raw lifecycle event count when useful. A local acceptance row plus Resend `sent` plus Resend `delivered` must render as one delivered logical message with three expandable audit events. Events with blank identifiers must remain visible and must not collapse accidentally.

Prefer a server-side tested projection if several consumers need the grouping; a UI-only grouping helper is acceptable only if the API already returns all safe identity fields consistently and no other consumer will keep miscounting raw rows. Do not alter operational metrics to count raw lifecycle rows as messages.

### 9. Build a dry-run-first, reversible historical audit and repair tool

Create a dedicated script or service command using repository conventions. It must default to read-only dry run. Production mutation must require an unmistakable explicit `--apply` plus a confirmation value, a verified backup, and a healthy storage check. Never apply it automatically during ordinary server startup.

The dry run must identify, with bounded/redacted output:

- multiple requests resolving to one canonical opportunity;
- multiple active sequences for one canonical opportunity;
- recipients exceeding logical touch caps;
- fingerprint-to-URL transition candidates;
- distinct listings that share a name/recipient but conflict materially;
- duplicate CRM submissions;
- request, communication, email-event, and activity submission-link mismatches;
- raw lifecycle event counts versus distinct logical/provider-message counts;
- ambiguous cases requiring manual review.

The apply mode must:

- run in bounded transactions;
- create canonical opportunity and alias links;
- backfill `opportunity_id` only where evidence is exact or approved;
- stop/quarantine duplicate active sequences before any future send;
- correct safe relationship links while preserving original IDs and evidence;
- never delete provider/webhook events or exact stored correspondence;
- emit explicit audited repair activities;
- write a reconciliation manifest with before/after identifiers, evidence version, timestamp, actor, and checksum;
- support a documented rollback or compensating-repair procedure;
- be idempotent so rerunning the same manifest produces no additional changes.

Include a synthetic fixture representing:

- one fingerprint record and its matching later URL record;
- a second distinct URL record with the same title and broker but different listing ID, geography, asking price, and profit;
- three raw lifecycle events for each logical message;
- intentionally drifted CRM submission links.

The fixture must prove that repair links the fingerprint and matching URL, keeps the second URL distinct, preserves all provider events, produces the correct logical message count, and never sends email.

Do not bake production recipient addresses or private email contents into tests. Use `example.test` addresses and synthetic listings.

### 10. Add Operations visibility and safe administrator resolution

Operations and relevant Deal Hunter views should expose count-only/bounded status for:

- central CIM outreach pause;
- canonical identity storage health;
- unresolved identity exceptions;
- duplicate active sequence count;
- recipient-cap deferrals/blocks;
- out-of-window deferrals;
- historical linkage mismatches;
- last audit/repair dry run and apply result, without message bodies;
- logical messages versus lifecycle events where the distinction matters.

The CIM approval queue must clearly label:

- previously contacted canonical opportunity;
- recipient recently contacted for another opportunity;
- identity ambiguous—manual resolution required;
- touch cap reached;
- outreach globally paused;
- source review incomplete.

Buttons must remain disabled server-side and client-side when blocked. UI state is explanatory, never authoritative.

## Tests and acceptance criteria

Add focused tests before or alongside implementation, then run broader closure gates.

### Canonical identity regression tests

- A high-fit fingerprint listing with a completed request later gains a listing URL with matching name, recipient, location, asking price, revenue, profit, and source evidence. It resolves to the existing canonical opportunity, is not CIM-ready, creates no second request/communication, and makes no provider call.
- A URL slug changes but the provider listing ID remains the same. It keeps one canonical opportunity.
- Two different provider listing IDs share title and recipient but have conflicting geography/economics. They remain distinct.
- Same title and broker without enough other evidence becomes ambiguous and blocks outreach.
- Alias resolution behaves identically in SQLite and Supabase storage adapters.
- Legacy records without `opportunity_id` fail closed or resolve safely during the compatibility window.

### Send-boundary and race tests

- Direct, bulk, and automatic initial sends all recheck canonical identity.
- A stale signed snapshot cannot bypass a newly discovered alias/request.
- Concurrent fingerprint and URL sends result in one durable claim, one prepared communication, and at most one provider invocation.
- Different recipients for the same opportunity remain subject to the current corrected-recipient and alternate-contact rules and cannot create duplicate first contact.
- Provider acceptance followed by a persistence failure reconciles without retransmission under the new canonical IDs.
- Existing Resend idempotency and communication reconciliation tests continue to pass.

### Recipient policy tests

- Same bulk selection includes two distinct opportunities for one broker: the conservative default blocks/deconflicts the second initial and explains why.
- Manual Stage 1 cannot bypass rolling caps.
- Automation cannot override caps.
- Accepted initials and follow-ups count once each despite local `sent`, webhook `sent`, and webhook `delivered` rows.
- Failed-before-provider attempts do not count as accepted touches.
- Complaints, hard bounces, explicit opt-outs, and global suppressions still stop all applicable outreach.
- A permitted administrator override is scoped, confirmed, reasoned, audited, and cannot be replayed for another opportunity.

### Follow-up scheduling tests

- One active sequence per canonical opportunity.
- An exact reply for one alias stops all sequences for that canonical opportunity but not an unrelated opportunity at the same broker.
- Recipient touch cap blocks/defer follow-up before claim or provider work.
- Send window and weekday rules are both enforced in the configured timezone.
- The central kill switch blocks scheduler, admin run, direct send, bulk send, and automation before provider work.

### Timeline tests

- One local `email.sent`, one webhook `email.sent`, and one webhook `email.delivered` with the same message identity render as one delivered logical email and three expandable audit events.
- Two different provider message IDs with the same subject and near-identical timestamps remain two logical emails.
- Reply, bounce, complaint, delayed, failure, and suppression precedence is correct and visible.
- Blank-ID legacy events remain separately visible.
- Filter counts distinguish logical emails from lifecycle events.
- Sensitive metadata redaction remains intact.

### Repair tests

- Dry run never mutates.
- Apply requires explicit confirmation and verified backup evidence.
- The synthetic incident fixture repairs only the matching fingerprint/URL pair.
- Apply is idempotent.
- Failure rolls back the bounded transaction or produces an unambiguous resumable manifest.
- Raw provider events and stored communication contents are unchanged.
- Ambiguous cases are reported, not guessed.

### Existing closure gates

Use the bundled Node runtime expected by this workspace if the shell Node version is incompatible with `better-sqlite3`. Run, at minimum:

- the new focused identity/send/repair/timeline tests;
- existing Deal Hunter scoring, bulk CIM, lifecycle, scheduler, follow-up, webhook replay, communications, storage, operations, configuration, and admin auth tests;
- relevant admin UI tests, especially Deal Hunter, CIM history, Operations, communications, and activity timeline;
- `npm run lint`;
- `npm run build`;
- the full backend and UI suites once the focused tests pass;
- relevant Playwright admin tests if the environment supports them without sending external email.

Do not weaken assertions, add arbitrary sleeps, broaden timeouts without evidence, skip safety tests, swallow errors, or make tests pass by disabling the feature under test.

## Deployment and incident runbook requirements

Update the backend, deployment, and follow-up operations documentation. Include this safe rollout order:

1. Take and verify a production backup.
2. Enable the central CIM outreach pause before migration/repair.
3. Deploy code with outreach still paused.
4. Apply additive SQLite/Supabase migrations.
5. Run storage/readiness checks.
6. Run the historical audit in dry-run mode.
7. Review exact, distinct, and ambiguous identity groups with counts and redacted evidence.
8. Run the repair only with explicit authorization and a reconciliation manifest.
9. Rerun dry run and verify zero unsafe duplicate active sequences/link mismatches.
10. Verify current source review, approval queue, timeline grouping, recipient caps, and send-window behavior with provider calls disabled or restricted internal tests.
11. Unpause only after a release owner accepts the audit and readiness state.
12. Monitor identity exceptions, cap blocks, duplicate sequence count, complaints, bounces, replies, and logical send volume.

Document rollback/containment:

- immediately pause all CIM outreach;
- leave inbound webhook processing active;
- do not delete requests or provider events;
- restore storage only under the existing verified recovery procedure;
- use the repair manifest for compensating relationship updates;
- do not retry an ambiguous provider outcome with a new idempotency identity.

Add a concise incident note stating:

- 12 distinct Resend messages are confirmed delivered by retained provider IDs and signed webhooks;
- raw timeline rows amplified the display because each message generated multiple lifecycle events;
- one fingerprint-to-URL transition caused a duplicate four-touch sequence;
- another similar listing was materially distinct and must remain separate;
- current live rows were complete and not actively scheduled at the time of investigation;
- current code reproduced the identity-transition defect before this fix;
- provider retrieval was unavailable because the production key is correctly send-only.

## Non-goals

- Do not delete or rewrite historical email bodies or provider events.
- Do not merge opportunities based only on title, subject, or broker address.
- Do not replace deterministic identity resolution with an AI model.
- Do not change the 75+ score eligibility rule as part of this task.
- Do not automatically enable higher CIM automation stages.
- Do not enable generic CRM follow-up email or optional AI enrichment.
- Do not create a second email provider integration.
- Do not broaden the Resend API key.
- Do not make production repair or deployment part of ordinary application startup.
- Do not hide raw lifecycle evidence merely to make the timeline look smaller.

## Expected handoff

Finish with:

- a concise root-cause summary;
- files and additive migrations changed;
- the canonical identity and ambiguity rules implemented;
- send paths and scheduler boundaries protected;
- recipient caps and override rules;
- timeline grouping behavior;
- repair dry-run/apply and rollback commands;
- exact tests/builds run and results;
- any remaining external/manual rollout steps;
- explicit confirmation that no real email was sent and no production repair/deployment occurred during implementation.

The work is complete only when the current fingerprint-to-URL reproduction is permanently prevented at the private send boundary, distinct same-broker listings remain distinct, recipient volume is bounded across all touches, out-of-hours follow-ups are deferred, the timeline shows one logical item per actual message without erasing audit data, and historical repair is safe, reviewable, idempotent, and reversible.

---
