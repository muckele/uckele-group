# Master Codex prompt: implement and safely deploy CIM Automation Stage 2

Use this prompt from the repository root:

`/Users/Matt/Documents/uckele-group`

---

You are implementing Phase 2 of Uckele Group's Deal Hunter CIM initial-outreach automation. Work autonomously through repository research, implementation, testing, iterative review/fix loops, Git publication, and a guarded production deployment of the new code. Do not stop after writing a plan or presenting a patch.

This prompt authorizes you to:

- modify the application, tests, additive migrations, configuration examples, and documentation needed for a production-safe Stage 2 implementation;
- create and verify a fresh production backup before an additive production migration or deployment;
- deploy the completed, reviewed Phase 2 code to the existing Fly application while Stage 2 transmission remains unable to contact brokers;
- add only the intended files, commit them, push the current feature branch, and deploy the reviewed commit;
- run read-only production readiness, identity, lifecycle, source-policy, and Stage 2 evidence checks;
- use mocked provider delivery in tests.

This prompt does **not** authorize you to:

- send any real broker email;
- manufacture, import, duplicate, or lower the requirements for human review evidence;
- classify an automated decision as a human review;
- enable CIM follow-ups;
- widen any recipient, daily, or rolling cap;
- activate Stage 2 broker transmission merely because code was deployed;
- use an internal test recipient without a fresh, explicit authorization naming that exact address;
- alter or resolve production identity exceptions, apply a CIM identity repair, or change historical request linkage;
- delete or rewrite historical requests, communications, lifecycle events, approvals, or audit evidence;
- expose secrets, recipient addresses, email bodies, reply aliases, headers, cookies, or unrestricted production records.

If the Phase 2 code is ready but the real review or release gates are not, deploy the inert/shadow-capable code, leave broker transmission disabled, and report the exact remaining gates. Do not lower a gate to force the label “effective Stage 2.”

## Current repository and production baseline

Re-verify these facts before editing; treat them as the expected starting point, not as permission to overwrite newer changes:

- Repository: `/Users/Matt/Documents/uckele-group`
- Current branch at prompt creation: `codex/cim-automation-approval-workflow`
- Current release commit at prompt creation: `a1d7151` (`Unpause manual Stage 1 CIM outreach`)
- Fly application: `uckele-group`
- Fly release at prompt creation: 96
- Storage: single-machine SQLite on the mounted `/data` volume
- Manual Stage 1 initial CIM outreach is live.
- Configuration and persisted central CIM outreach pauses are both `false`.
- CIM follow-ups are `false` and must remain disabled.
- Configured and effective CIM automation stages are both 1.
- The automation-only emergency pause is currently clear, but engage it before deploying Phase 2 code.
- Global recipient caps are 1 logical CIM touch per rolling 24 hours and 4 logical CIM touches per rolling 30 days.
- The accepted operating window is 08:00–17:00 `America/Los_Angeles`, weekdays only.
- Accepted CIM automation source coverage is the SMB Deal Hunter Google Sheet only. Airtable is disabled. A Deal OS import or any additional source must not silently enter the Stage 2 cohort.
- Reply tracking has passed a controlled end-to-end test.
- Production identity health was clean: zero duplicate active sequences, zero unresolved identity exceptions, zero missing links, zero safely repairable linkage mismatches, and zero linkage mismatches.
- One known historical recipient is already over the accepted rolling cap. That is a historical exception, not permission for another touch.
- The release identity baseline was 10 CIM requests, 9 canonical groups, and 96 raw lifecycle events representing 34 logical/distinct-provider CIM messages.
- Production Stage 2 evidence at prompt creation was only:
  - 9 distinct human-reviewed deals;
  - 9 approved and 0 rejected;
  - 0 recipient edits;
  - 10 CIM requests;
  - 9 deliveries;
  - 0 bounces, complaints, or provider failures;
  - 1 reply;
  - 0 classified positive response outcomes.
- The existing minimum is 25 human reviews. Therefore, at least 16 additional **genuine** human decisions are required before the existing evidence gate can pass. Do not fabricate them, count mutable aliases twice, seed production with fixtures, or lower the minimum.

At prompt creation the worktree also contained unrelated, pre-existing untracked documentation files. Inspect `git status --short` and preserve every unrelated change or file. Never stage them merely because they are present.

## Research conclusions that the implementation must address

Stage 2 is partially implemented already. Do not replace working safety controls without evidence. Preserve and extend the canonical identity, signed-snapshot, durable communication, provider idempotency, recipient claim, opportunity claim, suppression, archive, pause, and lifecycle reconciliation boundaries.

The current implementation has the following material gaps:

1. **Stage 2 readiness is only a count.** `getCimAutomationStatus()` currently treats 25 distinct `deal_key` reviews as sufficient. It does not require canonical identity, Stage 2 rule-cohort accuracy, unchanged-recipient approval, adverse-event health, verified reply readiness, source policy, compliance readiness, current backup/audit evidence, or an explicit release-owner activation.

2. **Review evidence uses mutable `deal_key`.** Fingerprint-to-URL transitions or other aliases can inflate the evidence count. Readiness must count the latest valid human decision per immutable canonical `opportunity_id`, with ambiguous or unlinked evidence excluded.

3. **Automatic broker outreach is a hidden side effect of the daily summary email.** `sendDailyDealHunterReview()` both sends the internal daily review email and, at higher stages, can contact brokers. The admin “send daily review” action and external daily-email endpoint therefore become broker-send triggers. Phase 2 automation must be a separate, explicitly named, durably claimed job. Sending or retrying an internal summary must never contact a broker.

4. **There is no Stage 2 shadow/canary activation model.** A configuration stage plus the evidence count is enough to make the existing run path live. Implement distinct `off`, `shadow`, `canary`, and `active` modes, or an equivalently explicit fail-closed model. A code deployment must default to no automatic provider calls.

5. **There is no durable release-owner Stage 2 acceptance.** Persist accountable activation evidence: actor, timestamp, reason, accepted rule/config hash, accepted evidence snapshot/checksum, approved source policy, window, caps, canary limit, and backup/audit references. An environment variable alone is not durable authorization.

6. **Initial automation lacks a server-enforced operating window.** The daily scheduler normally runs at a configured time, but an authenticated or external invocation can occur at other times. Enforce the Pacific weekday window inside the Stage 2 run and immediately before provider work. Do not rely only on scheduler timing.

7. **The daily cap uses a UTC date prefix.** Stage 2 operating-day calculations must use `America/Los_Angeles`, including DST. Count logical, provider-accepted initial messages according to a documented policy. Do not use raw lifecycle rows. Be conservative around pending/ambiguous provider outcomes.

8. **Source health is broad rather than Stage 2-specific.** A healthy Deal OS export or an additional Sheet can silently enter the automated cohort. Require an explicit source allowlist and verify each candidate's provenance. The production default must allow only the accepted SMB Deal Hunter Sheet source identifier. Unexpected, mixed, stale, incomplete, capped, or warning-bearing coverage must block that candidate or the entire run according to a documented fail-closed rule.

9. **“Named broker” is not actually required.** A non-generic mailbox local part is not equivalent to a verified named contact. Stage 2 must require a source-provided broker/contact name and an exact source-provided direct address. Never infer, scrape, construct, or guess an address.

10. **Stage 2 selection evidence is not durable before sending.** The existing automation review row is written after a successful send, and exceptions are mostly ephemeral response/email data. Persist a bounded automation run and one decision record per considered candidate before provider work, including canonical opportunity, rule version, source policy/version, snapshot digest, decision, reasons, and claim/idempotency identity. Update outcomes append-only or with audited state transitions.

11. **The private send boundary verifies a server-signed snapshot but not a durable Stage 2 authorization decision.** The server signing its own selected object is not sufficient evidence that all Stage 2 gates passed. Require a valid, unconsumed Stage 2 decision/claim bound to the canonical opportunity, exact recipient, snapshot digest, rule/config hash, run, and activation record. Re-check all mutable safety gates immediately before the provider call.

12. **Two cap concepts conflict.** `maximumBrokerContacts30Days` defaults to 3, while the accepted canonical recipient cap is 4; the evaluator currently prefers the canonical cap and also rejects any Stage 2 recipient with prior outreach. Define and display the authoritative semantics. Recommended Phase 2 policy: retain the global 1/24-hour and 4/30-day backstops, retain the more conservative Stage 2 “no prior outreach to this recipient” rule for automatic initials, and start with a total canary limit of 1 automatic initial per Pacific business day. Remove, rename, or explicitly enforce any misleading redundant cap.

13. **Readiness metrics are not lifecycle-precise.** The current metric path can use a bounded general event list and subject matching, and a request may be counted delivered because any provider ID in its sequence delivered. Stage 2 gates must use canonical request/communication associations and distinguish the initial message from follow-ups and raw duplicate webhook events.

14. **The Operations UI overstates readiness.** “Needs 25 reviewed requests” is not a sufficient readiness explanation. Show every independent gate, observed value, required value, reason, evidence timestamp, shadow results, canary usage, pause/activation state, and safe next action without exposing recipient details.

15. **Configured Stage 3 can currently fall back into live Stage 2 based only on 25 reviews.** Every path that could yield effective Stage 2 must require the same explicit Stage 2 activation and safety gates. Stage 3 configuration must not bypass Stage 2 authorization.

16. **Compliance and sender authentication are not part of CIM automation readiness.** Automated cold B2B outreach increases risk. Treat CIM outreach conservatively unless qualified counsel/release ownership records a different reviewed classification. Require accurate sender/subject information, a valid physical postal address, an explicit reply-based opt-out instruction in text and HTML, operational global suppression, and recorded sender-domain authentication readiness. Do not claim that the code itself supplies legal advice.

17. **Provider idempotency is necessary but time-bounded.** Resend idempotency keys currently prevent repeats for 24 hours. Preserve the application's permanent communication/request identity and reconciliation as the durable protection beyond the provider window. Never generate a new idempotency identity for an ambiguous retry.

18. **Webhook delivery is at-least-once and unordered.** Continue deduplicating signed events by provider event identity and ordering lifecycle facts by provider occurrence time. Stage 2 metrics and stops must remain correct under replay and out-of-order delivery.

Primary references to retain in the implementation/runbook:

- Resend idempotency keys: <https://resend.com/docs/dashboard/emails/idempotency-keys>
- Resend webhook delivery/replay behavior: <https://resend.com/docs/webhooks/introduction>
- FTC CAN-SPAM business guide: <https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>
- Gmail sender guidelines: <https://support.google.com/mail/answer/81126>

## Required end state

Deliver a production-deployed Phase 2 implementation with these properties:

### 1. Stage model and activation

Expose separate concepts rather than one ambiguous stage number:

- `configuredStage`: desired maximum code path, 1–3;
- `evidenceStage`: highest stage supported by valid canonical human evidence and operational gates;
- `activationMode`: `off`, `shadow`, `canary`, or `active`;
- `effectiveStage`: the stage allowed to perform provider work after evidence, activation, pause, source, window, compliance, and readiness checks;
- `automaticTransmissionAllowed`: explicit boolean with blocker codes;
- `stage2Readiness`: a list/map of stable machine-readable gates.

Recommended semantics:

- Stage 1 remains the manual production default.
- `shadow` runs the exact Stage 2 evaluator and persists decisions but performs no provider work.
- `canary` can send at most 1 automatic initial per Pacific business day and only after explicit release-owner activation.
- `active` may use the separately reviewed daily automatic-initial cap, but must never exceed global recipient caps or the configured maximum. Do not move from canary to active in this task without new release-owner authorization.
- A pause, stale/withdrawn activation, failed readiness gate, source-policy mismatch, or out-of-window invocation yields no automatic provider work.
- Manual Stage 1 initial requests remain available unless the central all-outreach pause is active.
- CIM follow-ups remain disabled and are not changed by Stage 2.

Persist activation separately from the emergency pause. The pause must always win. Activation must be invalidated or blocked when its accepted rule/config hash no longer matches runtime policy.

Implement an explicit full-admin activation endpoint or protected CLI/service operation with:

- an exact confirmation phrase;
- mode restricted to the supported transitions;
- accountable actor and substantive reason;
- accepted evidence/checksum and generated-at timestamp;
- backup reference and verification evidence;
- dry-run identity audit reference/checksum;
- rule/config/source-policy hash;
- accepted caps and Pacific window;
- append-only admin audit events.

Do not expose a casual one-click “enable Stage 2” control. The UI may prepare the exact confirmation workflow, but it must make the consequences and blockers explicit.

### 2. Canonical human evidence

Make Stage 2 evidence immutable, deduplicated, and policy-specific:

- Associate new human review decisions with `opportunity_id`, current primary submission when available, signed snapshot digest, evidence version, Stage 2 rule version, source-policy version/hash, source identifiers, actor, actor role, and decision time.
- Count the latest valid human approval/rejection per canonical opportunity, not per mutable deal key.
- Link legacy review evidence only when an existing canonical alias makes the relationship deterministic. Exclude ambiguous or missing links from readiness; do not guess.
- Automated decisions and automated post-send audit rows must never increment the human-review gate.
- Repeated human decisions for one opportunity count once, using the latest valid decision, while preserving the full history.
- Evidence produced under a materially different rule/source policy must not silently qualify a new policy. Surface it as historical/incompatible.
- Do not backfill actor, role, or approval facts that are not supported by existing evidence.

At minimum retain the existing floor of 25 valid canonical human decisions. Add a Stage 2 cohort-quality gate that measures how often the exact trusted-rule cohort was approved **without recipient correction**. Use conservative configurable defaults and document them. A recommended starting point is:

- at least 25 valid canonical human decisions overall;
- at least 10 human-reviewed opportunities that the current Stage 2 rules would have considered eligible;
- at least 95% unchanged-recipient approval within that eligible cohort;
- zero known duplicate/identity/incorrect-recipient decisions within the eligible cohort unless explicitly adjudicated and excluded with audit evidence;
- zero unresolved identity exceptions or safely repairable linkage mismatches;
- no unreviewed complaint, bounce, failure, or explicit opt-out in the current release-readiness window.

If repository evidence suggests a statistically or operationally better formulation, implement it only if it is at least as conservative, explain it in the runbook, and keep thresholds configurable with safe lower bounds. Never change the existing production count from 9 by fixtures or migrations.

### 3. Trusted Stage 2 candidate policy

Version and hash the trusted rules. A Stage 2 candidate must satisfy every rule at evaluation and again at the final send boundary where applicable:

- score at least 90; do not reduce the Stage 2 production threshold to the manual 75+ threshold;
- canonical identity resolved with no open identity exception;
- exact opportunity has no prior or active CIM sequence;
- exact recipient has no prior Stage 2-eligible outreach under the conservative first-contact rule;
- global 1/24-hour and 4/30-day logical-touch caps allow the recipient;
- no pending recipient or opportunity claim;
- no global suppression, bounce, complaint, failure stop, explicit opt-out, or ambiguous reply state;
- CRM record is not archived, permanently deleted, or concurrently entering a lifecycle transition;
- listing has an original URL and stable provider/source identity evidence;
- candidate is not a duplicate or same-name ambiguity;
- source review is fresh, complete, and free of blocking coverage warnings;
- candidate provenance is exclusively within the accepted SMB Deal Hunter Sheet allowlist;
- broker/contact name is source-provided and non-empty;
- recipient address is exact, source-provided, syntactically valid, and not a generic mailbox;
- industry matches the versioned trusted list;
- geography is within the versioned target states;
- annual profit is within the accepted profile range;
- profit multiple is present and no greater than the accepted maximum;
- exact snapshot, recipient, rule hash, source hash, and activation record are bound to a durable unused decision claim;
- automation-only pause and central outreach pause are both clear;
- current time is a permitted Pacific weekday/window;
- Stage 2 canary/daily capacity remains;
- storage, canonical identity, outbound provider, inbound reply, suppression, and compliance readiness are healthy.

Return stable blocker codes plus human-readable explanations. Store recipient references as privacy-safe hashes in aggregate operational evidence; retain actual recipient data only where the existing protected request/communication model requires it.

### 4. Decouple the Stage 2 job

Refactor so these operations are independent:

- source review/preview;
- internal daily Deal Hunter summary email;
- manual Stage 1 CIM approval/send;
- Stage 2 shadow evaluation;
- Stage 2 automatic initial transmission;
- CIM follow-up processing.

`sendDailyDealHunterReview()` and `/api/admin/deal-hunter/send` must never contact a broker as a side effect. Preserve the internal summary email behavior and its existing daily job identity.

Create a separately named Stage 2 runner and durable scheduled-job identity. Requirements:

- one claimed run identity per Pacific business date and mode/policy version;
- safe concurrent invocation from scheduler/admin/external trigger;
- explicit shadow-only invocation that never calls the provider;
- canary/active invocation only when activation and every gate pass;
- window and weekday evaluation inside the runner and immediately before provider work;
- deterministic ordering of eligible candidates;
- durable run record before candidate evaluation completes;
- durable decision/claim before each attempted send;
- bounded candidate and exception storage;
- aggregate, privacy-safe Operations output;
- exact per-candidate audit visible only to full admins;
- provider results reconciled without generating a new permanent message identity.

An admin action must be clearly labeled “Run Stage 2 shadow evaluation” or “Run Stage 2 canary,” never “Send daily review.” External routes must use separate authorization and idempotent job identities.

### 5. Durable data and migrations

Use additive migrations only. Extend existing tables when that is safer, or add dedicated tables for:

- Stage 2 activation/acceptance records;
- automation runs;
- automation candidate decisions/claims;
- canonical review-evidence linkage and policy versions.

Minimum guarantees:

- unique run identity;
- unique decision identity bound to run + canonical opportunity + rule/config hash;
- one active automatic initial claim per canonical opportunity;
- exact recipient/snapshot digest binding;
- monotonic/audited state transitions;
- no destructive rewrite of historical reviews;
- privacy-safe bounded metadata;
- SQLite and Supabase parity;
- service-role-only Supabase access/RLS posture matching other protected operational tables;
- indexes for run date, mode/status, opportunity, decision, and evidence lookup;
- idempotent startup migration for SQLite;
- a forward Supabase migration and updated canonical schema;
- storage availability included in `/api/ready` or the Stage 2 readiness gate so missing migration fails closed.

Do not apply any data repair under this prompt. Deterministic legacy evidence linking may be previewed and migrated only if it is additive, unambiguous, independently tested, and does not change historical CIM request identity. Otherwise exclude legacy rows and report them.

### 6. Idempotency, claims, and final send boundary

Keep the existing prepared-communication-before-provider pattern. Preserve deterministic CIM request/communication/provider idempotency identities.

At the final provider boundary, transactionally or with existing fenced claims:

1. load the current activation and require the accepted policy hash;
2. re-read the durable Stage 2 run/decision claim;
3. verify the canonical opportunity and recipient bindings;
4. verify the exact signed snapshot digest and expiry;
5. re-check source-policy provenance and current source snapshot identity;
6. re-check central and automation pauses;
7. re-check Stage 2 mode, evidence, readiness, window, and capacity;
8. re-check archive/dismissal/lifecycle state;
9. re-check canonical prior sequence and opportunity claim;
10. re-check global suppression, reply/adverse states, recipient claim, and rolling caps;
11. persist/reuse the exact prepared communication;
12. send using the same permanent application idempotency identity;
13. store provider acceptance or a precise ambiguous/failure state;
14. finalize the run/decision/request evidence without losing a provider-accepted result if a later write fails.

Never automatically retry an ambiguous provider outcome with a new request, communication, or idempotency key. Reconcile first. Resend's provider key lasts 24 hours, but application identity must prevent duplicates indefinitely.

### 7. Window and volume policy

Add explicit Stage 2 initial-automation settings rather than accidentally borrowing the follow-up enablement flag:

- timezone: `America/Los_Angeles`;
- start: `08:00`;
- end: `17:00`;
- weekdays only: `true`;
- canary automatic-initial cap: 1 per Pacific business day;
- active automatic-initial cap: configurable, but do not set above the currently reviewed production value without release-owner acceptance;
- global recipient caps: 1/24 hours and 4/30 days;
- follow-ups remain independently disabled.

Use DST-safe zoned-date helpers and test both PST and PDT. The end time is exclusive. Out-of-window work must remain eligible for a later permitted run without acquiring a provider-send claim. Count a provider-ambiguous pending initial conservatively against capacity until reconciled.

### 8. Compliance and sender readiness

Do not provide a legal conclusion. Implement a conservative technical gate and clearly label the required business/legal acceptance.

Before Stage 2 automatic transmission can be activated, require:

- accurate From, Reply-To, and subject behavior;
- a reviewed, non-deceptive description/disclosure of the message's acquisition-outreach purpose, including any commercial-message identification required by the accepted compliance classification; never label cold acquisition outreach as transactional merely to bypass controls;
- a configured valid physical postal address rendered in both HTML and plain text;
- a clear reply-based opt-out instruction in both HTML and plain text, such as replying “unsubscribe” or “stop”;
- verified inbound parsing that converts a current, unquoted opt-out into a global suppression;
- immediate suppression enforcement that comfortably satisfies any applicable opt-out deadline and remains effective across every outreach feature;
- suppression checked immediately before every automatic initial;
- SPF/DKIM readiness and DMARC review/attestation for the actual From domain;
- TLS/provider readiness;
- a recorded accountable compliance/release acceptance for the Stage 2 message classification and copy;
- count-only complaint, bounce, failure, opt-out, and reply monitoring.

Do not expose the mailing address as a secret if it is intended to be in every outbound message, but do not invent one. If it is not configured, Stage 2 remains blocked. Manual Stage 1 behavior should not be silently changed without tests and a documented release decision; if shared copy is changed, show the exact diff and validate both variants.

### 9. Operations and Deal Hunter UI

Update the full-admin UI so the release owner can understand Stage 2 without reading logs:

- configured, evidence, and effective stages;
- activation mode and whether automatic transmission is allowed;
- automation-only and central pause states;
- legitimate canonical human-review progress, including the current remaining count;
- compatible and incompatible evidence counts;
- Stage 2 cohort count and unchanged-approval quality;
- every readiness gate with stable status/reason;
- accepted rule/source/config hash and activation actor/time;
- current Pacific window and whether it is open;
- canary/daily capacity and usage;
- latest shadow run counts: considered, eligible, blocked by reason, would-send;
- latest live run counts: attempted, accepted, reconciled, failed, ambiguous, deferred;
- identity exceptions, duplicates, link mismatches, recipients at cap, and cap deferrals;
- count-only deliveries, replies, complaints, bounces, failures, and opt-outs;
- safe next action.

Viewer/read-only roles receive aggregate, body-free, address-free status and cannot activate, pause/resume, run a canary, or inspect protected decision details. Full admins may inspect exact candidates and evidence, but UI lists must remain bounded and paginated.

Add explicit confirmation language for canary/activation and make clear that Stage 2 sends an email without per-opportunity approval.

### 10. Audit and monitoring

Extend or add a read-only, privacy-safe Stage 2 readiness/audit command. It must not fetch unrestricted production records or transmit mail. Report:

- configured/evidence/effective stages and activation mode;
- all gate results and hashes;
- canonical human-review count and remaining evidence;
- Stage 2 cohort quality;
- source policy and unexpected-source counts;
- shadow/canary run summaries;
- duplicate active sequences and identity exceptions;
- missing/safely repairable links and linkage mismatches;
- cap excesses and deferrals;
- logical initial messages versus raw lifecycle events;
- adverse/reply/opt-out counts;
- run/decision/request/communication linkage mismatches;
- safely replayable versus ambiguous provider states;
- migration/storage health.

Use hashes or opaque references for recipients. Never print addresses, message bodies, aliases, headers, secrets, cookies, or unrestricted row lists.

Update the existing `uckele-cim-safety-monitor` only after production deployment and only so its expected baseline matches the actual released mode. Keep it read-only. In shadow mode it must hold on any automatic provider send. In canary mode it must hold on sends beyond the accepted daily/candidate/cap policy, missing decision evidence, follow-up enablement, Stage 3 drift, source widening, identity regressions, readiness failure, or adverse/reply events requiring review.

## Test requirements

Start with focused tests while implementing, then run the full suite. Add regression coverage for at least the following:

### Readiness and evidence

- 9 valid production-like human reviews do not make Stage 2 evidence-ready.
- Configured Stage 2 remains effective Stage 1/off when evidence or activation is missing.
- Configured Stage 3 cannot fall into Stage 2 without Stage 2 activation.
- 25 mutable deal-key aliases for fewer canonical opportunities do not pass.
- repeated decisions for one opportunity count once and latest wins.
- automated reviews never count as human evidence.
- ambiguous/unlinked/incompatible-policy reviews do not count.
- qualifying canonical review evidence passes only when every independent gate passes.
- recipient-edit/cohort-quality/adverse-event gates fail closed.
- changed policy/source hash invalidates activation.

### Source and candidate policy

- only the accepted SMB Sheet source is eligible by default;
- a healthy Deal OS import, Airtable source, second Sheet, mixed provenance, coverage warning, stale result, incomplete result, or source failure cannot silently automate;
- score 89 is blocked and score 90 is evaluated;
- missing broker name is blocked;
- generic mailbox is blocked;
- guessed/constructed recipient is impossible;
- missing URL, identity ambiguity, duplicate, prior opportunity sequence, prior recipient outreach, archive/dismissal, suppression, cap, pending claim, and adverse/reply states are blocked;
- trusted industry, geography, profit, and multiple rules are versioned and enforced.

### Job separation and modes

- source review never calls the provider;
- internal daily summary send/retry never calls a broker provider path;
- Stage 2 shadow persists bounded decisions and performs zero provider work;
- Stage 2 canary uses a separate durable job and cannot exceed one automatic initial per Pacific business day;
- duplicate/concurrent scheduler, admin, and external invocations share a claim and do not double-send;
- off/paused/not-activated modes perform zero provider work;
- an automation pause engaged between candidates stops the remaining candidates;
- the central pause engaged immediately before provider work wins;
- follow-ups remain disabled and unaffected.

### Time and caps

- before-window, at-start, just-before-end, at-end, after-window, weekend, PST, PDT, and DST-transition behavior;
- out-of-window work is deferred without consuming a send claim;
- Pacific business-day canary accounting, not UTC date-prefix accounting;
- raw webhook duplication does not inflate caps or volume;
- ambiguous/pending provider outcomes conservatively consume capacity;
- accepted global 1/24-hour and 4/30-day caps always win;
- known historical cap excess cannot receive an automatic initial.

### Durable authorization and provider safety

- final send rejects missing, stale, consumed, wrong-run, wrong-opportunity, wrong-recipient, wrong-snapshot, wrong-policy, or wrong-activation decisions;
- exact prepared copy is stored before provider work;
- provider retries reuse the exact communication and permanent idempotency identity;
- retries after the provider's 24-hour idempotency window remain application-deduplicated;
- ambiguous provider acceptance reconciles before retry;
- post-provider persistence failure does not create a second message;
- webhook replay and out-of-order events remain idempotent and lifecycle-correct;
- request, communication, automation decision, and activation evidence remain linked.

### Compliance, API, UI, and access

- physical postal address and opt-out text appear in text and HTML for Stage 2-eligible copy;
- missing compliance configuration blocks automatic transmission;
- current unquoted “stop”/“unsubscribe” creates a global suppression; quoted historical text does not;
- full-admin-only activation/run endpoints reject viewer and unauthenticated access;
- exact confirmation, actor, reason, evidence, backup, and audit references are required;
- Operations shows all gates and does not claim readiness based only on 25 reviews;
- viewer data is aggregate and privacy-safe;
- routes and lists remain bounded;
- startup/readiness fails closed when required Stage 2 storage is absent.

### Migration parity

- clean SQLite startup creates the new schema;
- an existing production-shaped SQLite database migrates additively without changing historical rows;
- restart is idempotent;
- Supabase migration includes indexes, RLS, revoked public/anon/authenticated privileges, and service-role access;
- canonical schema and forward migration stay in sync.

Do not weaken assertions merely to make tests pass. Mock provider calls. A real internal delivery test requires separate explicit authorization after all code reviews and production deployment.

## Required implementation loop

Maintain a living plan. Work in small, complete vertical slices. For each slice:

1. inspect the exact callers, storage contracts, migrations, UI consumers, and tests before editing;
2. write or update a failing regression test that expresses the intended safety property;
3. implement the smallest coherent change;
4. run the focused tests;
5. inspect the diff for fail-open behavior, hidden provider calls, privacy leaks, migration divergence, and unrelated edits;
6. fix every issue found;
7. repeat until the slice is green and internally consistent.

Suggested slices:

1. canonical review evidence and readiness gate model;
2. activation/run/decision storage and additive migrations;
3. source allowlist and versioned candidate policy;
4. decoupled shadow/canary runner and Pacific window/cap accounting;
5. final-boundary authorization and durable reconciliation;
6. compliance/readiness integration;
7. API, Operations UI, audit command, monitoring/runbook;
8. deployment configuration with automatic transmission still off.

If a test exposes a pre-existing Stage 2 safety defect adjacent to the work, fix it in scope and document it. Do not refactor unrelated product areas.

## Mandatory review/fix loop before Git publication

After implementation and the full verification suite are green, perform this exact sequence:

### Code review 1

Review the complete branch diff as if you did not write it. Inspect for:

- duplicate-send or ambiguous-retry paths;
- bypasses around activation, source, identity, suppression, pause, window, cap, archive, or claim gates;
- race conditions and partial-failure states;
- review evidence inflation or mutable identity;
- daily-summary/automatic-send coupling;
- raw-event versus logical-message mistakes;
- incorrect Pacific/DST calculations;
- unsafe migration/backfill assumptions;
- provider/webhook idempotency errors;
- privacy or authorization leaks;
- misleading UI readiness;
- missing rollback/monitoring controls;
- tests that prove implementation details but not safety outcomes.

Classify findings by severity. Fix every actionable P0, P1, and P2 finding and every correctness/security/privacy issue regardless of label. Add regression tests, rerun focused tests, then rerun the full suite.

### Code review 2

Perform a second clean-slate review of the new complete diff after the first fixes. Do not merely confirm that review 1 findings were edited. Re-run the threat/race/failure analysis from entrypoints to provider boundary and from webhook to lifecycle metrics.

If review 2 finds anything actionable:

1. fix it;
2. add or strengthen regression coverage;
3. rerun focused and full checks;
4. perform another clean-slate review.

Continue the review → fix → test → fresh review loop until the latest review has **no actionable findings**. Only then proceed to staging, commit, push, or deployment. Report the clean review explicitly.

## Verification commands

Discover the exact scripts from `package.json`, but at minimum run:

```bash
npm run eval:follow-ups
npm run lint
npm test
npm run test:ui
npm run build
git diff --check
```

Also run focused Stage 2, CIM lifecycle, identity, scheduler, storage, webhook, authorization, Operations, migration/security, and browser/UI tests. Run `npm run cim:identity:audit` only in dry-run mode for production. Never use `--apply` under this prompt.

If a command fails, investigate and fix the cause. Do not omit or reclassify a failure as unrelated without concrete evidence. Preserve user-owned changes.

## Git requirements

Do not stage anything until:

- all intended tests/checks pass;
- the latest full code review has no actionable findings;
- the diff contains no secrets, production recipient data, protected resolution manifests, generated backups, temporary artifacts, or unrelated changes;
- additive migrations and canonical schemas match;
- documentation describes the shadow/canary rollout and rollback.

Then:

1. show `git status --short` and review the complete intended diff;
2. stage only the Phase 2 files by explicit path;
3. verify the staged diff;
4. commit with a precise message such as `Harden CIM Stage 2 automation rollout`;
5. push the current `codex/` branch;
6. report the commit and branch.

Do not stage the pre-existing master prompt files, this Stage 2 master prompt, or any unrelated file unless the user explicitly asks to version that exact prompt/file and the staged diff is intentional.

## Guarded production deployment

Deploy the reviewed Phase 2 code, not live Stage 2 broker transmission.

### Pre-deployment

1. Confirm the pushed commit equals the reviewed local commit.
2. Capture privacy-safe production baselines:
   - `/api/ready`;
   - Fly release/machine health;
   - both central outreach pause controls;
   - automation-only pause;
   - configured/effective stage and activation mode;
   - follow-up enabled state;
   - source-policy state;
   - identity audit counts;
   - canonical human-review evidence;
   - logical CIM messages and raw lifecycle counts;
   - count-only recent send/delivery/reply/complaint/bounce/failure/opt-out events.
3. Set the production automation-only pause to `true` with an accountable deployment actor and reason. Do not set or clear the all-outreach pause unless a separate migration risk requires it and the release owner authorizes the impact on manual Stage 1.
4. Verify automatic provider work is blocked while manual Stage 1 and inbound webhooks retain their intended behavior.
5. Create a fresh application-consistent production backup and verify its checksum/bundle. Record privacy-safe backup evidence.
6. Keep `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=false`.
7. Keep live Stage 2 transmission disabled: activation `off` or `shadow`, canary false, and no automatic provider permission.

### Deploy

1. Deploy the exact reviewed commit to `uckele-group` using the repository's Fly workflow.
2. Allow the additive SQLite startup migration to run. If production has changed to Supabase, apply the forward migration using the repository's approved managed-backup procedure before starting code.
3. Do not flip Stage 2 live configuration during the code deploy.

### Post-deployment verification

Require all of the following:

- Fly machine healthy and stable;
- `/api/ready` healthy for configuration, storage, and document vault;
- new Stage 2 storage/migration health present;
- inbound signed webhook processing and verified reply readiness remain healthy;
- follow-ups remain disabled;
- automatic provider permission remains false;
- manual Stage 1 behavior remains correctly gated;
- default activation mode performs no automatic broker sends;
- dry-run CIM identity audit remains clean;
- no duplicate active sequence, identity exception, missing/safely repairable link, or linkage mismatch appears;
- historical cap exception does not increase;
- logical/raw lifecycle counts do not show an unauthorized send;
- Stage 2 audit reports the real evidence count, expected initially to remain 9 unless legitimate human work occurred after this prompt was created;
- internal daily summary can be sent only if already operationally due/authorized and cannot trigger broker outreach;
- Stage 2 shadow evaluation can run without provider calls and produces bounded durable evidence;
- Operations displays accurate blocker reasons and privacy-safe counts.

Use a mocked provider for the deployed functional test if the application supports it safely without changing production-wide delivery. Otherwise stop at read-only/shadow verification. Do not send to a real internal address unless the user separately authorizes one exact address for this new test.

### Activation is a separate release decision

After the code deploy, do **not** clear the automation-only pause into a sending mode until all of these are true:

- at least 25 legitimate canonical human decisions exist;
- Stage 2 eligible-cohort quality passes;
- identity, linkage, migration, storage, source, sender, suppression, compliance, reply, adverse-event, window, and cap gates pass;
- shadow results have been deliberately reviewed against human decisions;
- release owner accepts the exact trusted-rule version/hash, Sheet-only policy, score 90 threshold, no-prior-recipient rule, 1/day Pacific canary, 1/24-hour and 4/30-day global caps, copy/compliance posture, window, audit, and backup;
- that acceptance is persisted through the protected activation workflow;
- a fresh explicit authorization exists for any controlled real-recipient test.

If those gates are satisfied and the release owner explicitly authorizes activation in the active task, enable only `canary`, keep the total automatic-initial cap at 1 per Pacific business day, keep follow-ups disabled, and verify with count-only monitoring. Otherwise leave activation in `off` or `shadow` and automation paused, while manual Stage 1 remains available.

Do not advance to unrestricted `active` mode or Stage 3 under this prompt.

## Rollback and incident behavior

On any readiness failure, unexpected provider call, duplicate or ambiguous send, missing decision evidence, source widening, cap/window violation, identity regression, complaint, bounce, explicit opt-out, or unreviewed reply:

1. engage the automation-only pause immediately;
2. if the issue can affect manual/follow-up paths, engage the central all-outreach pause;
3. keep inbound webhooks and reconciliation available;
4. do not delete requests, communications, decisions, runs, provider IDs, lifecycle events, or activation evidence;
5. do not retry an ambiguous provider outcome with a new identity;
6. preserve logs and count-only incident evidence without exposing content or addresses;
7. run the dry-run identity and Stage 2 audits;
8. roll back application code only if compatible with the additive schema and retained evidence;
9. use a compensating, audited procedure rather than destructive data reversal;
10. request the exact human decision required.

## Final handoff format

Lead with the outcome. Report:

- what Phase 2 code was implemented;
- the important safety architecture and any deliberate deviations from this prompt;
- every test/check result;
- code review 1 findings and fixes;
- code review 2 (or later) clean result;
- migrations added and production migration result;
- backup reference/checksum evidence without exposing secrets;
- commit, branch, push, Fly release, and readiness result;
- configured/evidence/effective stages and activation mode;
- real canonical human-review count and exact remaining gap;
- shadow/canary status and whether any provider call occurred;
- both central pause controls, automation-only pause, and follow-up state;
- caps, Pacific window, source allowlist, sender/compliance readiness;
- identity, linkage, logical-message, raw-event, reply, adverse-event, and cap-deferral count summaries;
- whether manual Stage 1 remains available;
- the exact human decisions still required before canary activation.

Never claim “effective Stage 2” when production evidence or activation does not support it. Never treat successful code deployment as authorization to email brokers.
