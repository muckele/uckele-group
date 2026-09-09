# Uckele Group / Deal Hunter Phase 4: Daily Deal Hunter Digest

**Status:** Human approved; implementation remains limited to explicitly authorized plan tasks

**Date:** 2026-09-04

**Repository baseline:** `origin/main` at `ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8`

**Production baseline supplied by the release owner:** Fly release 116; SQLite at `/data/uckele-group.sqlite`; central CIM outreach paused; CIM follow-ups disabled; effective automation Stage 1; automation paused; Stage 2 scheduler disabled

**Scope:** Architectural design only. No production system, provider, configuration, database, or recipient was accessed while producing this specification.

## 1. Goal / non-goals

### Goal

Phase 4 delivers one reliable internal morning briefing that tells an administrator what deserves attention in the current Deal Hunter Acquisition Inbox. At 08:00 in `America/Los_Angeles`, one existing daily runner must produce exactly one of two mutually exclusive results for that Pacific date:

1. a concise normal digest built from the current, server-authoritative Acquisition Inbox; or
2. an action-required source-health alert with no opportunity recommendations when required source authority is not trustworthy.

The email and the existing admin experience consume the same pure, bounded projection. The email is informational and action-orienting. It never grants authority to mutate an opportunity or contact anyone outside the configured internal recipient.

### Non-goals

Phase 4 does not:

- add a scoring algorithm, second acquisition queue, investment memo, AI-authored prose, portfolio analytics, or generic notification center;
- add Slack, SMS, broadcast, or broker/prospect communication;
- Pursue, Watch, Pass, write CRM state, change an opportunity stage, request broker materials, start or approve follow-ups, or run Stage 2;
- reinterpret or reopen Phase 1, Phase 2, or Phase 3 behavior except at a concrete source-authority, UI-safety, or provider-idempotency seam required by this digest;
- add a second daily scheduler or a second date-claim namespace;
- add a new manual-send control;
- require the global CIM outreach pause to be lifted;
- enable follow-ups, Stage 2, or any other broker transmission path;
- expose the effective internal recipient, rendered email, provider credentials, raw source URLs, or stack traces in browser responses or logs; or
- authorize implementation, deployment, a production configuration change, a real email, a push, or a pull request.

## 2. Existing architecture reused

### Repository audit

The repository is a Node/Express application with React/Vite administration surfaces and interchangeable SQLite and Supabase/PostgreSQL storage adapters. A clean baseline run under Node.js `v22.23.2` completed 1,210 server tests with 1,209 passing, zero failing, and one skipped. The host's Node 24 runtime exhibited a local `better-sqlite3` cleanup/ABI failure, so Phase 4 implementation and verification must use Node 22.23.2, which satisfies the repository's `>=20.19.0` engine declaration.

The following existing seams are authoritative and will be reused:

| Concern | Current owner | Reuse decision |
| --- | --- | --- |
| Daily timer and process guard | `server/services/dealHunterScheduler.js` | Keep one scheduler and its `inFlight`, retry interval, and per-date sent guard. |
| Startup registration | `server/index.js` | Keep the one call to `startDealHunterDailyEmailScheduler()`. Do not register another daily runner. |
| Configuration | `server/config.js` and current deployment environment | Keep the existing Daily Deal Hunter enabled, recipient, time, timezone, interval, marker, and cron-secret concepts. |
| Durable date claim | `scheduled_job_runs` through both storage adapters | Keep the canonical job row and strengthen it with token-fenced transitions. |
| Local completion marker | `server/services/dealHunterScheduler.js` | Keep `/data/deal-hunter-daily-email/<date>.json` as recovery evidence, not primary authority. |
| Required/optional source health | `server/services/acquisitionCommandCenter.js` | Reuse its required-primary versus optional-supplemental classifications and bounded issues. |
| Canonical current opportunities and scoring | `server/services/dealHunterScoreStore.js`, canonical opportunity/source-observation tables, and storage reconciliation | Reuse the existing full-backfill, fingerprint-gated machine score refresh and current-eligibility reconciliation. |
| Acquisition Inbox ranking and row projection | `server/services/dealHunterTriage.js` and `list_deal_hunter_opportunity_scores` | Reuse the `needs-review` view, `acquisition-priority` order, summary, and public row fields. |
| Provider transport | `server/services/delivery.js` | Reuse the narrow prepared-message transport and Resend adapter after daily mail receives the same ambiguity-safe classification as CIM mail. |
| Provider lifecycle history | `server/services/emailEvents.js` and `email_events` | Reuse signed, replay-safe Resend events and durable provider message IDs. |
| Operations visibility | `server/services/operations.js` and `src/components/admin/OperationsCenter.jsx` | Reuse scheduled-job and source-health panels, with daily metadata sanitized before it reaches the browser. |
| In-app home | `src/components/admin/AcquisitionInbox.jsx` | Add a small morning-briefing/source-authority panel to the existing page. |
| Authentication | existing admin/viewer session middleware | Keep read access for administrators and viewers, mutation/send access for administrators only, and keep magic-link issuance separate. |

### What the existing daily sender does today

The existing runner is a useful precursor, not a complete Phase 4 implementation:

- `server/index.js` starts it once with the other independent schedulers.
- It checks the configured IANA timezone every minute, becomes due at or after the configured wall-clock time, and derives a `YYYY-MM-DD` date key in that timezone.
- It currently runs on every calendar date; there is no weekday check.
- It uses `daily-deal-hunter-email:<date>` in `scheduled_job_runs`, a same-process `inFlight` guard, a one-hour stale-pending threshold, a 30-minute process-local retry throttle, `email_events`, and a date marker.
- It currently sends either a broad internal review or a required-source alert.
- A completed alert already blocks a later normal email for that date.
- The administrator route and optional secret-authenticated cron route call the same claimed runner; neither accepts a recipient, subject, or body.

It does not yet satisfy Phase 4 because:

- normal content is built from legacy `buildDailyDealReview` buckets rather than the Acquisition Inbox projection and includes CRM/CIM automation preview material outside the concise MVP;
- any non-`failed` result is treated as completed, so an `ambiguous` result would be incorrectly completed;
- thrown Resend errors are classified as ambiguous only for CIM kinds; Daily Deal Hunter errors are presently classified as retryable failures;
- local send tracking is best-effort and occurs after provider acceptance;
- SQLite completion is not claim-token fenced;
- the Supabase reclaim increments the attempt count in a second unfenced operation;
- a stale worker can complete after another worker has reclaimed the job;
- the 30-minute failure delay is process-local and can be bypassed by restart or another trigger;
- a stale `pending` row does not distinguish a safe pre-provider crash from an unknown post-provider boundary;
- the current source-alert CTA uses `?view=source-review`, but the deployed dashboard routes the source-review workspace under `?view=operations`; Phase 4 must use the existing, working Operations URL;
- the legacy normal email may persist seen-deal history after sending; Phase 4 must not use that as digest authority; and
- current tests cover overlap, failed retry, alert/digest exclusivity, in-progress retry, and post-acceptance bookkeeping failure, but not the full DST, stale-worker, ambiguous-provider, provider-reconciliation, and SQLite/Supabase parity matrix.

### Architecture options

| Option | Shape | Strengths | Costs/risks | Decision |
| --- | --- | --- | --- | --- |
| **A. Extend the existing scheduler and claim with a dedicated digest service** | One timer, one job key, one job row. A pure digest projection is prepared and stored in job metadata; transport and reconciliation are strengthened. | Lowest duplicate risk, least startup/config change, preserves current operations, no new table, straightforward UI reuse. | Requires careful state transitions in an existing generic job primitive and a narrow score-refresh mode that cannot write CRM activity. | **Recommended.** |
| **B. Add a separate Daily Digest scheduler sharing durable primitives** | New startup registration and timer; old runner retained or retired. | Can isolate new code initially. | Creates two due-date authorities and a migration/cutover problem; an accidental dual enablement can race; more configuration and observability. | Rejected. |
| **C. Persist a first-class daily projection artifact, then let email and UI consume it** | New daily projection table/record and separate delivery step. | Strong replay and exact email/UI snapshot consistency; good long-term analytics. | New schema, retention/privacy policy, another lifecycle, and a path toward a generic notification product. Excessive for one bounded daily email. | Rejected for MVP. |

The selected design is Option A with one limited idea from C: the exact bounded prepared projection/envelope is persisted inside the existing date-keyed `scheduled_job_runs.metadata`. It is not a new table, queue, scheduler, or product.

## 3. Locked product decisions

- The product is named **Daily Deal Hunter Digest**.
- It is an internal administrator email, not CRM, broker, CIM, prospect, or follow-up communication.
- The automatic target is 08:00 `America/Los_Angeles`.
- The recipient is the server-resolved effective Daily Deal Hunter internal recipient. No real address appears in documentation or tests.
- A Pacific date can complete once, with either a normal digest or a required-source action alert.
- A completed alert prevents a recovered source from producing a normal digest on the same date.
- The required Sheet/source is primary authority. Deal OS is optional supplemental context. Airtable remains retired.
- The normal digest is a projection of canonical opportunity currentness, the Acquisition Inbox queue, current fit/scoring, source evidence, and lifecycle state.
- Phase 4 adds no new score or ranking policy.
- Digest preparation may refresh existing machine-owned source observations, fingerprints, scores, and current-triage eligibility through the existing authoritative full-backfill path. It may write source-health snapshots and digest execution evidence. It may not write operator decisions, CRM submissions/activities, dispositions, lifecycle stages, CIM requests, follow-up state, or Stage 2 state.
- The implementation must add an explicit `recordActivity: false`/equivalent internal mode to the existing score refresh and prove it cannot create CRM activity. The default behavior for existing callers remains unchanged.
- The central CIM pause, follow-up disabled state, Stage 1 effective state, automation pause, and Stage 2 scheduler disabled state remain unchanged and are not inputs to internal-digest authorization.
- The supplied production runtime pause state is authoritative for this plan. The checked-in `fly.toml` currently describes a different `DEAL_HUNTER_CIM_OUTREACH_PAUSED` value; Phase 4 planning does not change that file. The release checklist must verify the live central pause remains `true` and must stop on a mismatch.
- No new manual run control is added. Existing admin and cron triggers may remain only as zero-payload triggers into the same state machine; they never get a distinct idempotency identity or content authority.

## 4. Normal digest content

### Subject and framing

The deterministic subject is:

```text
Daily Deal Hunter — <needs-review count> to review — <Pacific YYYY-MM-DD>
```

The body includes:

1. **Business date and as-of time:** the Pacific date, projection generation timestamp, and score/source freshness timestamp.
2. **Source authority banner:** required Sheet healthy; optional Deal OS healthy or a bounded warning that it was excluded.
3. **Current Acquisition Inbox counts:** `needsReview`, `highPriority`, `watchlist`, `lowConfidence`, and `currentOpportunities`, using the existing server summary after the authoritative refresh.
4. **Top five current items needing review:** the first five rows from the existing `needs-review` view in `acquisition-priority` order.
5. **Per-opportunity fields:** name, state, fit score, score status, confidence, operator priority, unreviewed/changed-since-review signal, top deterministic strength, top deterministic concern, current CRM status, current CIM/materials status, and observation freshness.
6. **Links:** one primary link to `/admin/deal-hunter` and one secondary link to `/admin/deal-hunter?view=operations`. Per-row deep links are not part of MVP because the current Acquisition Inbox does not accept an opportunity query parameter.

The top-five limit and bounded strings keep the email useful and predictable. Empty queues still send a normal digest when required source authority is healthy; they show zero counts and “No current items need review.”

The email does not include broker/seller email addresses, phone numbers, operator notes, arbitrary source text, raw URLs other than validated application/listing links, financial fields whose current source provenance is not explicit in the queue row, removal recommendations, criteria tuning, CRM synchronization counts, CIM approval actions, follow-up recommendations, automation capacity, or AI prose.

### Existing ranking, unchanged

The existing `acquisition-priority` order is reused exactly:

1. operator priority `urgent` or `high` first;
2. high-fit and unreviewed/changed items next;
3. fit score descending;
4. confidence `high`, then `medium`, then `low`;
5. observation freshness descending; and
6. canonical opportunity ID ascending as the stable tie-breaker.

No Phase 4 weight, blended score, email-specific sort, or reranking is allowed.

## 5. Required-source alert content

When current required-source authority is blocking, the prepared result type is `required-source-alert`. Its subject is:

```text
ACTION REQUIRED — Deal Hunter source health — <Pacific YYYY-MM-DD>
```

The alert contains only:

- Pacific business date and checked time;
- a bounded, safely normalized list of blocking source-health issue titles and messages;
- the required source display name and a coarse status such as unavailable, empty, suspiciously incomplete, identity-incomplete, or scoring refresh failed;
- the latest known successful normal-digest date if locally available;
- a statement that no opportunity recommendations were generated and no CRM/CIM/follow-up/Stage 2 work ran; and
- a link to the existing Deal Hunter Operations/source-review surface at `/admin/deal-hunter?view=operations`.

It must not contain queue counts, opportunity names, scores, recommendations, financial data, contact data, raw CSV/source URLs, secrets, stack traces, or stale Deal OS rows. An optional Deal OS warning may appear only as a secondary bounded status; it cannot obscure the required issue.

Provider acceptance of this alert completes the canonical job row for the date. Later source recovery returns `already-completed`; it cannot prepare or send a normal digest.

## 6. Optional Deal OS degradation behavior

Deal OS remains `optional-supplemental`. Missing, stale, malformed, or unavailable Deal OS data does not make the required-source gate fail when the required Sheet remains trustworthy.

For a normal digest under optional degradation:

- source collection uses the current existing rule that a stale/unavailable Deal OS import contributes zero deals;
- the existing authoritative full-backfill refresh reconciles `current_triage_eligible` from the resulting current canonical set, which prevents Deal OS-only stale rows from remaining in the digest queue;
- machine scores are refreshed through the existing score authority from the admitted current input, with fingerprint skips for unchanged rows;
- the email and in-app projection display one bounded amber warning;
- optional Deal OS rows and optional-only fields are not copied into the digest; and
- Deal OS import/reconciliation controls remain unavailable until a fresh import satisfies their existing authority.

Primary-backed Acquisition Inbox review remains usable. Existing server authority, not React, determines whether a particular CRM/CIM action is allowed. Phase 4 does not relax any existing action gate.

## 7. Current opportunity selection/currentness

The digest runner obtains current authority in this order:

1. invoke the existing full-backfill source/scoring path, not the legacy recent/fallback email buckets;
2. require a complete, identity-resolved, trustworthy required Sheet set;
3. exclude stale/unavailable Deal OS input using existing source collection policy;
4. refresh only machine-owned score/evidence rows using the existing scoring engine and fingerprint gates;
5. reconcile `current_triage_eligible` from the complete authoritative set;
6. suppress CRM activity emission for this internal machine refresh while preserving the default for every existing caller; and
7. query `listTriageQueue({ view: 'needs-review', sort: 'acquisition-priority', direction: 'desc' })` and its summary.

An opportunity is current for the digest only when the storage query already requires:

- `deal_hunter_opportunity_scores.current_triage_eligible = true`;
- a joined canonical opportunity with `status = active`; and
- no current dismissal for the needs-review view.

The runner fails closed to the source alert when the full-backfill proof is incomplete, identity admission is deferred, the score refresh is partial/failed, current-eligibility reconciliation fails, or the queue cannot be read. It never falls back to the previous email's opportunity content or an in-memory second ranking.

This refresh may update source observations, machine score/evidence rows, and current eligibility. Storage ownership boundaries must prove that operator priority/note/review acknowledgement and CRM/lifecycle state cannot change. The digest then remains a projection of the refreshed existing Acquisition Inbox, not a parallel queue.

## 8. Scheduling/timezone contract

The automatic runner remains the existing in-process scheduler and becomes due when the wall clock in the IANA zone `America/Los_Angeles` is at or after 08:00 for the current date. It never converts “08:00” to a fixed UTC hour and never reads the host's local timezone.

At each tick:

```text
Pacific date = Intl.DateTimeFormat(..., { timeZone: "America/Los_Angeles" }) -> YYYY-MM-DD
due = Pacific hour/minute >= 08:00
job key = "daily-deal-hunter-email:" + Pacific date
```

If the application starts or recovers after 08:00, it attempts that date once, subject to the durable state. Before 08:00 it does nothing. A process restart, DST offset change, or another trigger does not change the date identity.

08:00 is outside the spring-forward gap and fall-back overlap. The UTC instant legitimately changes between PST and PDT:

- 08:00 PST is 16:00 UTC;
- 08:00 PDT is 15:00 UTC.

### Calendar-day schedule decision

The Daily Deal Hunter Digest runs every calendar day at 08:00 `America/Los_Angeles`, including Saturday and Sunday. “Pacific business date” means the timezone-local Pacific calendar date. The MVP does not skip holidays and must not add a weekday or holiday-calendar rule.

## 9. Recipient authority

The server resolves the recipient once from the existing effective configuration:

```text
DEAL_HUNTER_EMAIL_RECIPIENT, otherwise ADMIN_EMAIL
```

The resolved value must be a valid, nonempty internal email when the daily feature is enabled in production. The send service does not fall through at call time to a lead, broker, submission, viewer, request-body, or client-supplied address.

The immutable prepared envelope records the resolved recipient so a definitive-failure retry sends the exact same Resend payload. Browser and Operations projections expose only `recipientConfigured: true/false` and, if operationally necessary, a one-way recipient fingerprint; they do not expose the address.

The admin magic-link flow continues to accept only an identity authorized by the authentication service and uses `kind: admin-magic-link`. The Daily Digest uses `kind: daily-deal-hunter` and has no token or login semantics. They share only the low-level provider transport.

## 10. Email/provider contract

Production Daily Digest transmission requires `DELIVERY_PROVIDER=resend`, the existing Resend API key and verified sender, the effective internal recipient, and the signed webhook secret. The console provider remains valid only for development/test and records `development-only`, never production completion. EmailJS and Formspree fail closed before a Daily Digest network call because they cannot provide the required acceptance identity and idempotency boundary.

The digest builder creates an immutable prepared envelope containing only server-owned:

- `kind`, recipient, sender, subject, text, HTML, and application links;
- deterministic idempotency key;
- bounded tags;
- notification type; and
- a SHA-256 payload digest.

Required Resend tags are:

```text
source=daily-deal-hunter
business_date=YYYY-MM-DD
notification=normal-digest | required-source-alert
```

Resend documents that tags are returned in webhook events, that `email.sent` means the API request was accepted, and that idempotency keys suppress repeated identical requests for 24 hours. Phase 4 uses those guarantees as evidence but does not blindly POST again after an unknown outcome. See the official [idempotency-key documentation](https://resend.com/docs/dashboard/emails/idempotency-keys), [tag documentation](https://resend.com/docs/dashboard/emails/tags), [email.sent event](https://resend.com/docs/webhooks/emails/sent), and [webhook delivery semantics](https://resend.com/docs/webhooks/introduction).

## 11. Idempotency identity

The only logical and provider idempotency identity is:

```text
daily-deal-hunter-email:<Pacific YYYY-MM-DD>
```

It is used for:

- `scheduled_job_runs.job_key`;
- Resend `Idempotency-Key`;
- the date marker identity;
- a bounded email-event tracking field; and
- structured operational logs.

Normal and alert messages do not get different keys. Trigger source, process ID, attempt number, recipient, provider, and notification type do not alter the key. A failed pre-acceptance attempt may reuse the same key only with the exact persisted payload. An ambiguous attempt cannot create a new key or message.

## 12. Claim/retry/stale recovery

### Durable state machine

`scheduled_job_runs.status` and bounded metadata represent:

| Status | Meaning | Automatically claimable? |
| --- | --- | --- |
| `pending` | One token-owning worker is collecting authority or has durably prepared the immutable envelope; no provider boundary has been crossed. | Only after one hour stale, or by the current owner. |
| `transmitting` | The owner durably crossed the provider-call boundary. Acceptance may be unknown. | Never. Reconciliation only. |
| `failed` | A definitive pre-acceptance failure occurred. Metadata contains `nextRetryAt`; a prepared envelope is preserved if a provider request was made and rejected. | At or after the durable 30-minute retry time. |
| `ambiguous` | Provider acceptance cannot be proved or disproved after the reconciliation window. | Never. Reconciliation only. |
| `completed` | Exactly one normal digest or source alert has durable acceptance/development evidence. | Never. |

The existing generic claim method gains a random claim token. Every prepare, provider-boundary, failure, ambiguity, and completion transition must compare the current job key, expected status, and expected claim token in one atomic storage operation. A stale old worker therefore cannot overwrite a reclaimed worker.

The one-hour stale rule applies only to `pending`, where no provider boundary has been crossed. A reclaimed worker:

- preserves an already prepared immutable envelope and payload digest;
- creates a new claim token and increments `attempt_count` atomically; and
- rebuilds the projection only when no provider request and no prepared envelope exist.

The 30-minute retry interval is persisted as `metadata.nextRetryAt`, not just held in memory. Process restart, admin trigger, and external cron cannot bypass it. A definitive provider failure preserves the exact envelope; the retry uses the same job key and payload.

## 13. Provider ambiguity/reconciliation

The provider boundary is explicit:

1. persist the exact envelope and payload digest while `pending`;
2. atomically transition the token-owned row to `transmitting` before the network call;
3. call Resend once;
4. on an accepted response with provider email ID, immediately write the local marker, then token-fence database completion and record the local email event;
5. on a definitive non-acceptance response, transition to `failed` with a durable 30-minute retry time; and
6. on timeout, connection reset, response-parse failure after a successful status, missing provider ID, `concurrent_idempotent_requests`, or process death across the boundary, leave `transmitting` and reconcile. Never call the send endpoint again automatically.

Reconciliation checks, in order:

1. a valid same-date marker containing the matching job key/payload digest/provider ID;
2. local `email_events` with the exact business-date/source tags and provider ID;
3. signed, replay-safe Resend `email.sent` or later lifecycle events carrying the exact tags; and
4. a bounded, read-only Resend sent-email lookup, filtering candidates by the prepared recipient, subject, time window, and then retrieving candidates to require exact tags. Subject or recipient alone is never acceptance proof.

Exactly one matching provider identity completes the row and writes/repairs the marker. Zero matches after the one-hour reconciliation window changes `transmitting` to `ambiguous`; multiple matches also become `ambiguous` and produce a high-severity operational issue. A later signed webhook or exact provider lookup may reconcile `ambiguous` to `completed`. No automated or manual browser action retransmits an ambiguous result.

This is deliberately stricter than Resend's 24-hour identical-payload retry feature. The idempotency key remains defense in depth, not authority to blind-retry an unknown outcome.

## 14. Persistent marker/history

### Database authority

The completed `scheduled_job_runs` row is the primary one-result-per-date authority. It stores:

- job key/name, timestamps, status, trigger, and attempt count;
- notification type and Pacific date/timezone;
- claim/provider-boundary timestamps;
- payload digest and bounded projection counts;
- provider name and provider message ID;
- definitive/ambiguous error category and bounded message; and
- reconciliation source and timestamp.

The immutable envelope may remain inside server-only metadata for exact failed retry, but must be stripped from Operations/API output.

### Marker

The marker is stored at:

```text
/data/deal-hunter-daily-email/<Pacific YYYY-MM-DD>.json
```

It is written atomically through a temporary file plus rename and contains no address or body: job key, date, notification type, payload digest, provider ID, accepted/completed timestamp, and marker version. A marker can reconcile a noncompleted database row after post-acceptance database failure. A missing marker never causes resend when the database says `completed`.

### Email events

Local acceptance creates an `email_events` entry with `source=daily-deal-hunter`, provider message ID, notification type, business date, and job key. Signed webhooks remain idempotent by `svix-id`/event key and may arrive more than once or out of order. The scheduled job's terminal acceptance is monotonic; a later bounce/complaint updates email history/Operations but does not reopen the date or authorize another digest.

## 15. Admin/in-app projection

The smallest natural integration is a **Morning briefing** panel at the top of the existing Acquisition Inbox, above filters and rows. There is no new route, page, navigation item, or notification center.

The server adds a bounded `dailyDigest` projection to the existing triage GET response. The pure projector used by email also produces this object from queue/source/job inputs; React only renders it.

The projection contains:

```text
businessDate
generatedAt
status: ready | optional-warning | action-required | unavailable
notificationType
sourceAuthority: requiredHealthy, blockingIssues[], optionalWarnings[]
summary or null
topOpportunities[] or []
job: status, attemptCount, completedAt, notificationType
actionsAllowed
```

Behavior:

- required healthy, Deal OS healthy: show the counts and top current items;
- required healthy, Deal OS stale/unavailable: show the same usable primary-backed summary with one amber warning;
- required blocking: show a prominent red action-required panel, set summary to `null`, top opportunities to `[]`, identify the source issue, label any underlying persisted rows as last-known/untrusted, and disable decision/materials/follow-up mutation controls through server-projected authority;
- projection unavailable: fail closed like required blocking and link to Operations.

The existing queue can remain visible as explicitly last-known data for diagnosis, but must not appear as a trustworthy recommendation. Server mutation endpoints that need current source authority must recheck the same server policy; a browser boolean is not authorization.

No manual “Run Daily Digest” control is added. The existing legacy admin send control may remain during MVP only because it is already administrator-only, accepts no content/recipient input, and enters the same canonical claim. It must display `already-completed`, `retry-not-due`, `in-progress`, or `ambiguous` precisely and cannot bypass the state machine.

## 16. Admin/viewer authorization

| Capability | Administrator | Viewer | Public/unauthenticated |
| --- | --- | --- | --- |
| Read Acquisition Inbox morning briefing | Yes | Yes | No |
| Read sanitized daily job/source status | Yes | Yes | No |
| Use existing admin claimed-run endpoint | Yes, server-owned zero payload | No | No |
| Use secret external cron trigger | No session required; valid server secret only | No | No |
| Supply recipient/subject/body | No | No | No |
| Reconcile via signed provider webhook | Signed provider only | No | No |
| Read immutable envelope/provider credentials | No browser role | No | No |
| Mutate opportunities when required authority blocks | No | No | No |

Route IDs and request bodies are untrusted routing inputs. The digest projection, recipient, content, ranking, notification type, key, and send eligibility are recomputed or loaded from server-owned durable state.

## 17. Storage/SQLite/Supabase impact

### Existing structures are sufficient

No new table or column is required. Phase 4 reuses:

- `scheduled_job_runs` for the canonical state, immutable envelope, token, retry time, provider ID, and bounded result metadata;
- `email_events` for local/provider lifecycle history;
- source-health snapshots and the existing local source snapshot;
- canonical opportunity, source-observation, score/evidence, disposition, and triage eligibility structures; and
- the local date marker directory.

`crm_email_outbox` is not reused because it requires a CRM submission/version and owns follow-up mutations. `crm_communications` is not used as the digest outbox because its product semantics and Supabase delivery-state constraints are CRM communication oriented. Coupling an internal system briefing to either would create precisely the broker/CRM crossover Phase 4 forbids.

### SQLite

SQLite uses one conditional `UPDATE`/transaction per claim and transition. Token/status predicates, attempt increment, metadata preservation, stale cutoff, retry cutoff, and result return occur atomically. Existing backup-job callers remain compatible.

### Supabase/PostgreSQL

The existing Supabase insert/conditional-update claim is close but not parity-safe because the attempt increment is a second operation and completion is unfenced. A service-role-only function migration adds:

```text
claim_scheduled_job
transition_scheduled_job
```

These functions operate on the existing table, use row locking/conditional predicates, preserve immutable metadata, increment attempts atomically, and return the normalized row/reason. Execute privileges are revoked from `public`, `anon`, and `authenticated` and granted only to `service_role`.

This is an additive database-function migration, not schema expansion: no table, column, index, trigger, or row backfill is required. `supabase/schema.sql` receives the same definitions for fresh environments. If implementation discovers a table/column is necessary, Task 2 must stop for a new design decision before altering schema.

## 18. Configuration

No new environment variable is required. Reuse:

```text
DEAL_HUNTER_DAILY_EMAIL_ENABLED
DEAL_HUNTER_EMAIL_RECIPIENT (fallback: ADMIN_EMAIL)
DEAL_HUNTER_DAILY_EMAIL_TIME=08:00
DEAL_HUNTER_DAILY_EMAIL_TIMEZONE=America/Los_Angeles
DEAL_HUNTER_DAILY_EMAIL_CHECK_INTERVAL_MS=60000
DEAL_HUNTER_DAILY_EMAIL_RETRY_INTERVAL_MS=1800000
DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR=/data/deal-hunter-daily-email
DEAL_HUNTER_CRON_SECRET (only if the existing external trigger is used)
DELIVERY_PROVIDER=resend
RESEND_API_KEY
RESEND_FROM_EMAIL
RESEND_WEBHOOK_SECRET or EMAIL_WEBHOOK_SECRET
PUBLIC_SITE_URL
```

Production validation when the digest is enabled must require a valid IANA timezone, exact valid 24-hour time, positive intervals, valid effective internal recipient, Resend provider/key/from address, signed webhook secret, and writable marker parent on readiness/smoke checks.

The current checked-in schedule and marker path already match Phase 4. Planning and documentation commits do not alter `server/config.js`, `fly.toml`, secrets, or runtime flags. CIM pause/follow-up/automation flags are neither changed nor consulted to authorize the internal email.

## 19. Observability/logging

Structured log fields are:

```text
jobKey, pacificDate, phase, status, attemptCount, trigger,
notificationType, payloadDigestPrefix, provider, providerMessageId,
reconciliationSource, durationMs, errorCategory
```

Logs never include the recipient, email text/HTML, source URLs, provider request payload, API key, raw exception stack in normal output, broker data, or operator notes.

Operations shows:

- today's daily result state and notification type;
- started/completed/retry/reconciliation times;
- attempt count and stale/ambiguous status;
- provider ID only to administrators if existing policy permits, otherwise a bounded suffix/fingerprint;
- marker present/missing/mismatch;
- required and optional source status;
- failed/ambiguous counts; and
- a bounded error category/message.

`server/services/operations.js` must sanitize every scheduled-job metadata object. Immutable envelopes are server-only even for authenticated viewers. An ambiguous job is high severity. A pending job older than one hour is warning/recoverable. A failed job before `nextRetryAt` is scheduled-retry, not a duplicate-send alarm.

## 20. Failure modes

| Scenario | Required behavior |
| --- | --- |
| Claim already `completed` | Return `already-completed`; no source refresh, preparation, provider call, or marker rewrite unless marker repair is explicitly needed from stored proof. |
| Claim currently active `pending` | Return `in-progress`; same-process and cross-process duplicates do no work. |
| `pending` older than one hour | Atomically reclaim with a new token; stale worker is fenced; reuse prepared envelope if present. |
| Required source unavailable/untrustworthy | Prepare one source alert with no opportunity content; acceptance completes date. |
| Optional Deal OS unavailable/stale | Refresh from required primary input, exclude optional rows/context, include bounded warning, and send normal digest. |
| Queue/score refresh cannot establish current authority | Treat as action-required source/data-authority alert with no opportunity content. |
| Definitive provider failure | Persist `failed`, exact envelope, bounded error, and `nextRetryAt=failedAt+30m`; no completion marker; retry same key/payload when due. |
| Provider ambiguous/unknown | Keep `transmitting`, reconcile only; after one hour unresolved, set `ambiguous`; never retransmit. |
| Crash before provider-boundary transition | Row remains `pending`; recover after one hour. |
| Crash after `transmitting` but before the network call | Conservatively ambiguous after reconciliation window; this may miss the day's email but cannot duplicate it. |
| Crash after provider accepts, before response | Signed webhook/provider lookup finds exact tags and ID; complete without send. If proof never arrives, remain ambiguous. |
| Crash after response, before DB completion | Marker/provider event/job metadata reconcile completion; no resend. |
| Application restart | Read DB first, then marker/events/provider as needed. Process-local guards are optimizations only. |
| Same-date duplicate scheduler/admin/cron invocation | Same job key; one token owner; every other trigger returns current state. |
| Source alert accepted, source later healthy | Completed alert remains the only result; no normal digest. |
| Marker exists but DB is incomplete | Validate marker job key/date/digest/provider ID, then reconcile DB; invalid marker raises Operations issue and never alone authorizes a send. |
| DB completed but marker missing | Do not send; repair marker from completed DB evidence. |
| Webhook duplicate/out of order | Idempotent event insert and monotonic reconciliation; later lifecycle state cannot reopen date. |
| Application link/source string malformed | Drop or normalize the field; never interpolate unsafe schemes or unbounded raw text. |

Safety takes precedence over guaranteed delivery: an unresolved provider-boundary crash can produce no email for a date, but never a blind second email.

## 21. DST/time tests

Tests must use explicit UTC instants and `America/Los_Angeles`, never the machine timezone:

- winter PST: 2026-01-15 07:59/08:00/08:01 Pacific map to 15:59/16:00/16:01 UTC;
- summer PDT: 2026-07-15 07:59/08:00/08:01 Pacific map to 14:59/15:00/15:01 UTC;
- spring transition date 2026-03-08: due exactly once at 15:00 UTC (08:00 PDT), despite the missing 02:00 hour;
- fall transition date 2026-11-01: due exactly once at 16:00 UTC (08:00 PST), despite the repeated 01:00 hour;
- a restart at 10:00 Pacific still targets that Pacific date;
- instants straddling Pacific midnight produce different job keys;
- a date completed before an offset transition remains completed after it;
- invalid IANA zone and invalid `HH:MM` fail configuration validation; and
- calendar-day behavior has explicit Saturday and Sunday tests proving each date is due at 08:00 Pacific with no weekday or holiday skip.

## 22. Security/safety invariants

1. Recipient, subject, body, ranking, result type, and provider key are server-owned.
2. No route accepts arbitrary email content or recipient for the digest.
3. Viewer sessions cannot trigger or mutate a digest.
4. Public callers cannot trigger a digest; the existing cron path requires its server secret.
5. A browser cannot turn a source alert into a normal digest or vice versa.
6. Normal content is produced only after current required authority and queue refresh succeed.
7. Required failure returns no opportunity recommendation content.
8. Optional stale Deal OS input contributes no candidate or content.
9. Digest preparation/transmission cannot call CRM sync, CIM send, follow-up execution, Stage 2, or operator-decision methods.
10. Score refresh for digest cannot emit CRM activity and cannot write operator-owned fields.
11. CIM safety flags remain unchanged and are not a prerequisite for internal mail.
12. One date key can have one completed result.
13. Ambiguous provider outcomes never retransmit.
14. Only exact marker/event/provider identity can reconcile acceptance.
15. Prepared envelope and effective recipient never appear in API/Operations responses.
16. Source errors, subjects, names, strengths, and concerns are bounded and HTML escaped.
17. Application/listing links permit only valid `http`/`https`, with app links derived from configured origin.
18. Tests use fakes and reserved/example recipients; no provider network call or production data is permitted.

## 23. Rollout plan

Rollout is a later, separately authorized operation:

1. complete the five implementation tasks and focused review after each;
2. verify all focused tests, full server/UI suites, lint, build, migration-security tests, and doc checks on Node 22.23.2;
3. review the exact source/config/migration diff and reconfirm no Phase 1–3 behavior was broadened;
4. back up and verify the production SQLite database before deployment;
5. verify runtime safety state still has central CIM outreach paused, CIM follow-ups disabled, Stage 1 effective, automation paused, and Stage 2 scheduler disabled; stop on any mismatch;
6. verify the existing effective internal recipient without printing it, Resend readiness, signed webhook, `/data` persistence, and marker-directory writability;
7. deploy in a window before 08:00 Pacific only after release-owner approval; do not use a real manual test send as part of deployment;
8. observe the next naturally scheduled date and verify the one-result evidence chain; and
9. if rollback is required, disable only the Daily Digest through separately approved configuration or roll back the application. Never delete the job row, marker, provider event, or email history, and never alter CIM safety flags as a digest rollback step.

Supabase is not the supplied production backend, but its additive service-role functions must be applied and verified in any environment that uses that adapter before enabling the digest there.

## 24. Production smoke strategy

The production smoke is read-mostly and uses the first separately authorized natural scheduled run:

### Before 08:00 Pacific

- verify release SHA and Fly release number;
- verify SQLite integrity and backup evidence;
- verify the five supplied CIM/follow-up/automation safety values without changing them;
- verify effective recipient presence as a boolean/fingerprint only;
- verify Resend outbound and signed-webhook readiness;
- verify there is no completed row/marker for the chosen Pacific date;
- verify exactly one daily scheduler registration in startup logs; and
- verify Acquisition Inbox/source health loads without triggering a send.

### At/after 08:00 Pacific

- observe exactly one claim for `daily-deal-hunter-email:<date>`;
- confirm either normal or alert was selected, never both;
- confirm one provider ID (or the expected no-network development state outside production);
- confirm the completed DB row and same-date marker agree;
- confirm the signed `email.sent` event carries the business-date/source/notification tags;
- confirm a duplicate tick, admin trigger, and optional cron trigger return already completed without provider work; these can be exercised with injected/fake runners before production and observed from ordinary repeated ticks in production;
- confirm the Acquisition Inbox morning briefing reflects the same notification type and source status; and
- confirm CRM/CIM/follow-up/Stage 2 audit counts did not change because of the digest.

Do not send an extra smoke email. If the first outcome is ambiguous, stop, preserve evidence, reconcile by marker/webhook/provider identity, and do not retry the provider send.

## 25. Explicit prohibited scope

Implementation and rollout must not:

- add another scheduler, date key, worker queue, outbox table, projection table, or notification center;
- add a new table or column without returning for design approval;
- add AI, new score/rank logic, financial analysis, investment recommendations, or unbounded prose;
- use CRM communications/outbox as the internal digest queue;
- send to a broker, seller, prospect, submission contact, viewer, or request-supplied address;
- add a browser recipient/subject/body editor;
- add a new manual Run Daily Digest button;
- automatically Pursue, Watch, Pass, sync CRM, alter stage, request materials, start/approve follow-ups, or run Stage 2;
- enable or unpause any Phase 3/CIM automation setting;
- change production secrets/configuration as part of code implementation;
- blind-retry an ambiguous provider result, change its idempotency key, or rebuild its payload;
- count a bounce, open, click, or delivery event as permission for a second same-date result;
- expose immutable envelope content through Operations;
- use server-local time, fixed UTC offsets, or a hidden weekday/holiday policy;
- upgrade dependencies or reformat unrelated code; or
- deploy, push, create a PR, access production, or send a real email without separate authorization.

## 26. Acceptance criteria

Phase 4 implementation is acceptable only when all of the following are true:

- one existing scheduler registration owns the 08:00 Pacific cadence;
- PST, PDT, both 2026 DST transition dates, delayed startup, midnight, and approved weekend semantics pass deterministic tests;
- every trigger derives `daily-deal-hunter-email:<Pacific YYYY-MM-DD>`;
- one atomic token-owning claim wins across concurrent SQLite/Supabase workers;
- an old worker cannot prepare, fail, or complete after reclaim;
- active pending, one-hour stale pending, durable 30-minute failed retry, transmitting, ambiguous, and completed states behave as specified;
- normal and alert outcomes share one key and are mutually exclusive;
- required blocking prepares only the bounded action alert;
- optional Deal OS degradation permits a normal primary-backed digest, shows a warning, and excludes stale optional candidates/context;
- the authoritative full-backfill refresh uses the existing score engine, does not write CRM activity/operator state, and establishes current eligibility before projection;
- normal counts and top five rows exactly match the post-refresh Acquisition Inbox authority and ranking;
- the normal email contains only the approved bounded fields and working admin links;
- recipient and content remain server-owned and absent from request bodies;
- production daily mail fails closed unless Resend and signed reconciliation are ready;
- the exact immutable envelope is persisted before provider work;
- definitive provider failure can retry the same envelope/key no earlier than 30 minutes;
- ambiguous provider outcomes make zero further send calls and can complete only from exact marker/event/provider evidence;
- provider ID is durable in the job row/history and the marker agrees;
- signed webhook replay/out-of-order events are idempotent and monotonic;
- required-failure, optional-warning, ready, unavailable, and completed job states render correctly in Acquisition Inbox for admin and viewer;
- viewer and unauthenticated triggers fail; administrators cannot supply recipient/content;
- Operations redacts envelope/recipient and surfaces failed/ambiguous/mismatched evidence;
- central CIM pause, follow-up, Stage 1, automation-pause, and Stage 2 settings are unchanged;
- SQLite and Supabase focused tests, full server/UI tests, browser acceptance, lint, build, and `git diff --check` pass under Node 22.23.2; and
- the release smoke confirms one natural result and zero CRM/CIM/follow-up/Stage 2 side effects.

### Self-review record

The specification was reviewed against the requested contradiction, authority, crash, timezone, and production-safety checks. The review produced these explicit corrections:

- **Duplicated authority:** legacy email buckets were rejected; both email and UI use a pure projection over the refreshed Acquisition Inbox query.
- **Optional-data leakage:** the design requires full-backfill current-eligibility reconciliation with stale Deal OS excluded and omits provenance-ambiguous financial fields from email.
- **Hidden CRM write:** the existing score refresh emits CRM activity for linked opportunities; the design requires a tested no-CRM-activity mode for the digest while preserving existing caller defaults.
- **Duplicate-send window:** `transmitting` is nonreclaimable; only `pending` can be stale-recovered. A token fences every transition.
- **Crash before provider:** stale pending recovers after one hour. A crash after the boundary but before the call is intentionally treated as ambiguous rather than assumed safe.
- **Crash after acceptance:** exact marker, local event, signed webhook, or provider identity reconciles without a send.
- **Payload drift:** the prepared envelope is durable and reused on definitive failure; source recovery cannot silently turn an attempted alert into a digest under the same provider key.
- **Timezone ambiguity:** the IANA wall-clock/date conversion and concrete PST/PDT/DST instants are specified. Human approval locks every-calendar-day behavior, including Saturday and Sunday, with no holiday skipping in MVP.
- **Production safety:** internal-digest authority is structurally independent of CIM flags, while rollout explicitly verifies and preserves the supplied pause posture.
- **Storage parity:** no new table/column is needed; the Supabase gap is closed by additive, service-role-only functions over the existing table.
- **Sensitive metadata:** Operations must redact the prepared envelope and effective recipient.
- **Overbroad MVP:** no generic notification center, per-row deep-link feature, AI prose, financial analysis, new manual control, or separate scheduler remains in scope.

No unresolved contradiction remains. The approved schedule runs every calendar day, including Saturday and Sunday, at 08:00 `America/Los_Angeles`; the Pacific business date is the timezone-local calendar date and the MVP does not skip holidays.
