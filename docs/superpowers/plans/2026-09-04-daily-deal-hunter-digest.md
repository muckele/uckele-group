# Uckele Group / Deal Hunter Phase 4: Daily Deal Hunter Digest Implementation Plan

> **For implementation workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement exactly one top-level task per implementation run. Use `superpowers:test-driven-development` for that task and `superpowers:verification-before-completion` before returning its commit. Stop after the task commit for one focused human/code review. The Phase 4 design, including the calendar-day schedule, is human approved.

**Goal:** Deliver one reliable, server-owned internal briefing at 08:00 `America/Los_Angeles` that produces either a concise current Acquisition Inbox digest or a bounded required-source action alert, with exactly one completed result per Pacific date and no CRM/CIM/follow-up/Stage 2 side effects.

**Architecture:** Extend the one existing Daily Deal Hunter scheduler and `scheduled_job_runs` identity. A dedicated service refreshes only existing machine-owned acquisition authority, projects the existing Acquisition Inbox summary/order, and durably prepares one immutable email envelope in the date-keyed job metadata. Token-fenced SQLite/Supabase transitions separate safe stale-pending recovery from a nonretransmittable provider boundary. Marker, local event, signed webhook, and bounded provider lookup reconcile acceptance. The same pure projection renders a small panel in the existing Acquisition Inbox.

**Tech stack:** Node.js 22.23.2, Express, ES modules, SQLite/`better-sqlite3`, Supabase/PostgreSQL RPCs, React, Vitest/Testing Library, Node test runner, Playwright, Vite, Resend.

**Approved design:** `docs/superpowers/specs/2026-09-04-daily-deal-hunter-digest-design.md` at planning commit `9ed2272`. Human approval includes operation every calendar day, Saturday and Sunday included, at 08:00 `America/Los_Angeles`, with no holiday skipping in MVP.

**Planning base:** `ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8` on branch `codex/daily-deal-hunter-phase-4` in `/Users/Matt/Documents/uckele-group-phase4-daily-digest`.

## Mandatory implementation preflight

Do not use `/Users/Matt/Documents/uckele-group`; it was intentionally left untouched because it contains unrelated user-owned changes. Continue only in the isolated Phase 4 worktree. The approved Pacific business date is the `America/Los_Angeles` timezone-local calendar date, including Saturday and Sunday.

```sh
cd /Users/Matt/Documents/uckele-group-phase4-daily-digest
git status --short --branch
git rev-parse ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8^{commit}
git merge-base --is-ancestor ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8 HEAD
git log -2 --oneline
git ls-files --unmerged
```

Require all of the following before editing:

- branch is `codex/daily-deal-hunter-phase-4`;
- base commit is an ancestor;
- specification commit `9ed2272` and this plan's commit are present;
- no unmerged paths;
- no unexplained source/config/package/migration changes; and
- the approved weekend decision is recorded in the task handoff.

Use Node.js 22.23.2 for every install, test, lint, build, and browser command. The planning baseline passed under this runtime; Node 24 produced a local `better-sqlite3` cleanup/ABI failure.

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm ci
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm test
```

Expected baseline: 1,210 server tests, 1,209 pass, zero fail, one skip. Stop and report any different baseline before attributing a failure to Phase 4.

## Global delivery constraints

- Implement Tasks 1–5 sequentially on this branch. Exactly one task is implemented and committed per implementation run.
- Run the named RED tests before production changes for that task. Capture the expected assertion/module/API failures. Then make the minimum GREEN change.
- After each task, inspect the full task diff, run its focused verification, run `git diff --check`, commit only the expected files, and stop for one focused review.
- A focused review may produce one narrow repair commit when it identifies a reproducible defect. Do not use repair work to add scope or refactor unrelated code.
- Do not start the next task while a review finding remains open.
- Do not deploy, push, merge, create a PR, access production, call the live Resend API, send a real email, mutate a production database, or change a production secret/configuration.
- Never disable the central CIM pause, enable Phase 3 follow-ups, change effective Stage 1, unpause automation, or enable the Stage 2 scheduler.
- Preserve existing Phase 1–3 request/communication/follow-up behavior unless the task names a concrete Phase 4 safety dependency.
- Do not add a second timer, scheduler registration, queue, table, column, notification page, manual-send control, recipient editor, AI prose, score rule, or email-specific ranking.
- Keep the existing canonical identity exactly `daily-deal-hunter-email:<Pacific YYYY-MM-DD>`.
- Keep one completed result, normal or alert, for each Pacific date.
- Only `pending` can be reclaimed after one hour. `transmitting` and `ambiguous` can reconcile but never retransmit.
- A definitive provider failure retries no earlier than 30 minutes and uses the same persisted envelope and idempotency key.
- All provider tests use injected fakes and example/reserved recipients.
- No task may edit `fly.toml` or a lockfile. A dependency change is not expected; stop before one.
- No table/column is expected. Task 2 may add only the named service-role Supabase functions. Stop for design review before any other schema change.

## Locked implementation contracts

### Date, job, and result

```text
timezone: America/Los_Angeles
automatic due time: 08:00
job name: daily-deal-hunter-email
job key / Resend key: daily-deal-hunter-email:<Pacific YYYY-MM-DD>
marker: <configured marker dir>/<Pacific YYYY-MM-DD>.json
normal type: normal-digest
alert type: required-source-alert
top opportunity limit: 5
```

### Job state machine

```text
absent -> pending(claimed/prepared) -> transmitting -> completed
                                  \-> failed -> pending after durable 30m cutoff
                                  \-> ambiguous -> completed only by reconciliation
pending older than 1h -> pending with a new fenced claim token
completed -> completed forever for that date
```

`transmitting` is entered atomically before the provider call. A crash immediately after that transition is ambiguous even if no HTTP request actually left the process. This conservative loss window is intentional.

### Normal projection

Reuse the existing `needs-review` view, summary, and `acquisition-priority` order. Include only:

- business date and timestamps;
- required/optional source status;
- `needsReview`, `highPriority`, `watchlist`, `lowConfidence`, `currentOpportunities`;
- top five `name`, `state`, `fitScore`, `scoreStatus`, `confidence`, `operatorPriority`, review-change signal, `topStrength`, `topConcern`, `workflow.crmStatus`, `workflow.cimStatus`, and `observationFreshness`; and
- links to `/admin/deal-hunter` and `/admin/deal-hunter?view=operations`.

Do not include recipient/contact data, operator notes, provenance-ambiguous financial fields, CRM sync/CIM automation counts, removal recommendations, or AI prose.

### Source gate

- Any blocking required-source/identity/score/current-eligibility/queue authority failure returns an alert projection with `summary: null` and `topOpportunities: []`.
- Optional Deal OS issues have `affectsHealth: false`, remain a bounded warning, and do not block a normal primary-backed projection.
- A stale/unavailable Deal OS contributes no candidate or context to the full-backfill score/eligibility refresh.
- Alert acceptance completes the date and prevents a later normal result.

### Provider and reconciliation

- Production Daily Digest requires Resend and a signed webhook secret.
- `source=daily-deal-hunter`, `business_date=YYYY-MM-DD`, and `notification=<type>` tags are mandatory.
- Network/timeout/accepted-response-parse/missing-ID/concurrent-idempotency uncertainty is `ambiguous`, never `failed`.
- Nonacceptance with an authoritative provider response is a definitive failure.
- Acceptance proof requires exact job/date/payload/tag/provider identity, never subject alone.
- Operations/browser responses redact the effective recipient and immutable envelope.

---

## Task 1 — Authoritative source, score, and Acquisition Inbox projection

**Target active implementation time:** 4–6 hours, excluding human review wait.

**Commit message:** `Add Phase 4 digest authority projection`

### Exact expected files

Create:

- `server/services/dailyDealHunterDigest.js`
- `test/dailyDealHunterDigest.test.js`

Modify:

- `server/services/dealHunterScoreStore.js`
- `test/dealHunterScoreRefresh.test.js`

No React, route, provider, scheduler, config, storage-adapter, schema, or deployment file belongs in this task.

### Step 1: Add RED projection tests

Create `test/dailyDealHunterDigest.test.js` with injected source-refresh, source-health, and triage dependencies. Add these exact test names:

- `daily digest projection uses the Acquisition Inbox summary and exact acquisition-priority order`
- `daily digest projection returns at most five allowlisted current opportunities`
- `daily digest projection omits contact data operator notes financials and arbitrary fields`
- `required source failure returns one bounded action-required projection with no opportunity content`
- `identity score or queue authority failure returns action-required with no stale fallback`
- `optional stale Deal OS keeps the primary-backed projection usable and emits one bounded warning`
- `empty healthy Acquisition Inbox produces a normal zero-count digest`
- `daily digest authority never calls CRM CIM follow-up Stage 2 or operator mutation methods`

The RED command must fail because the module/exports do not exist:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dailyDealHunterDigest.test.js
```

### Step 2: Add RED score-refresh ownership tests

Extend `test/dealHunterScoreRefresh.test.js` with:

- `daily digest score refresh returns the authoritative full-backfill review`
- `daily digest score refresh suppresses CRM activity without suppressing machine score writes`
- `daily digest score refresh preserves operator priority note and review acknowledgement`
- `existing score refresh callers still emit CRM activity by default`
- `stale Deal OS contributes no refreshed score or current eligibility when required Sheet is healthy`

Run only those tests by name pattern and confirm the missing option/result failures:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test --test-name-pattern='daily digest|existing score refresh callers|stale Deal OS contributes' test/dealHunterScoreRefresh.test.js
```

### Step 3: Add the narrow score-refresh mode

In `server/services/dealHunterScoreStore.js`:

1. add an explicit option such as `recordActivity = true` to `refreshOpportunityScores`;
2. preserve `true` as the default for all existing callers;
3. retain the authoritative `review` returned by `collectScoredOpportunities` and include its bounded object in the result;
4. when `recordActivity` is `false`, skip only `emitRescoreEvent`; do not skip canonical source observation, score/evidence, fingerprint, or current-eligibility work;
5. do not expose a caller-supplied shortcut that can claim a complete authoritative set without the existing full-backfill checks; and
6. keep partial failure behavior fail-closed so eligibility is not reconciled from an incomplete set.

Do not modify scoring weights, rules, fingerprints, semantic digests, or operator ownership.

### Step 4: Implement the pure bounded digest projection

In `server/services/dailyDealHunterDigest.js`, export small testable functions:

```js
export const DAILY_DEAL_HUNTER_DIGEST_VERSION = 'daily-deal-hunter-digest-v1';
export const DAILY_DEAL_HUNTER_TOP_LIMIT = 5;

export function projectDailyDealHunterDigest({
  businessDate,
  generatedAt,
  sourceHealth,
  scoreRefresh,
  queue,
  job,
});

export async function buildCurrentDailyDealHunterDigest({
  businessDate,
  storage,
  refreshScores,
  readSourceHealth,
  readTriageQueue,
});
```

Implementation order:

1. call the existing full-backfill score refresh with `recordActivity: false`;
2. construct/persist source health from the exact returned review;
3. classify blocking issues on the server; optional issues with `affectsHealth === false` are warnings only;
4. fail to an alert projection on required/identity/refresh/current-eligibility/read failure;
5. only on success, call the existing triage reader with `view='needs-review'`, `sort='acquisition-priority'`, `direction='desc'`, `page=1`, `pageSize=5`;
6. copy the approved summary fields and per-row allowlist only;
7. normalize and bound every string; and
8. derive only the two existing admin URLs from configured `PUBLIC_SITE_URL`/server origin.

Do not build HTML, send email, claim a job, write seen history, or add an HTTP route in Task 1.

### Step 5: Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dailyDealHunterDigest.test.js test/dealHunterScoreRefresh.test.js test/dealHunterTriage.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
```

### Step 6: Diff, commit, and review boundary

Confirm the diff contains only the four expected files. Commit with the exact task commit message, then stop.

Focused review questions:

- Does the runner reuse the full authoritative score/currentness path rather than form a second queue?
- Can the no-activity mode write any CRM, operator, disposition, lifecycle, CIM, or follow-up state?
- Does optional stale Deal OS disappear from candidates and context?
- Can any failure leak stale recommendations?
- Does the projection exactly preserve existing queue order and fields?

### Prohibited in Task 1

No scheduler/provider/storage transition, HTML email, React, route, config, migration, new ranking, deep-link feature, or production work.

---

## Task 2 — Atomic scheduled-job claims and token-fenced transitions

**Target active implementation time:** 5–7 hours, excluding human review wait.

**Commit message:** `Fence Phase 4 scheduled job transitions`

### Exact expected files

Create:

- `supabase/migrations/20260904120000_daily_digest_scheduled_job_fencing.sql`

Modify:

- `server/storage/sqlite.js`
- `server/storage/supabase.js`
- `supabase/schema.sql`
- `test/scheduledJobs.test.js`
- `test/supabaseSecurity.test.js`

No scheduler, delivery, webhook, React, route, config, or deployment file belongs in this task. No table, column, index, trigger, or data backfill is allowed.

### Step 1: Add RED SQLite state-machine tests

Extend `test/scheduledJobs.test.js` with these exact names:

- `scheduled job claim returns one token owner across ten concurrent attempts`
- `fresh pending scheduled job cannot be reclaimed`
- `pending scheduled job older than one hour is reclaimed with a new token`
- `stale worker cannot transition a job after a new owner reclaims it`
- `failed scheduled job cannot retry before durable nextRetryAt`
- `failed scheduled job retries at nextRetryAt and preserves its immutable envelope`
- `transmitting and ambiguous scheduled jobs can never be claimed`
- `completed scheduled job can never change notification type or be reclaimed`
- `token-fenced transition atomically changes status metadata provider id and timestamps`
- `legacy backup scheduled job callers remain compatible`

RED command:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/scheduledJobs.test.js
```

### Step 2: Add RED Supabase function/security tests

Extend `test/supabaseSecurity.test.js` with:

- `scheduled job claim function atomically fences stale failed and completed states`
- `scheduled job transition function requires expected status and claim token`
- `scheduled job functions preserve immutable prepared metadata and increment attempts atomically`
- `scheduled job functions are service-role-only`
- `scheduled job fencing migration adds no table or column`

RED command:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test --test-name-pattern='scheduled job' test/supabaseSecurity.test.js
```

### Step 3: Implement the adapter contract

Both adapters must expose equivalent normalized behavior:

```js
storage.claimScheduledJob({
  jobKey,
  jobName,
  triggeredBy,
  claimToken,
  nowIso,
  staleBefore,
  retryDueAt,
  metadata,
});

storage.transitionScheduledJob({
  jobKey,
  claimToken,
  expectedStatuses,
  status,
  nowIso,
  providerMessageId,
  lastError,
  metadataPatch,
  completedAt,
});
```

Return:

```js
{
  applied: Boolean,
  reason: 'claimed' | 'active' | 'retry-not-due' | 'not-owner' |
    'wrong-state' | 'completed' | 'missing',
  run: Object | null,
}
```

Required semantics:

1. insert absent rows as `pending`, `attempt_count=1`, and the supplied token;
2. reclaim only failed rows whose persisted `nextRetryAt` is due or pending rows at/before `staleBefore`;
3. never claim `transmitting`, `ambiguous`, or `completed`;
4. merge volatile metadata without replacing `preparedEnvelope`, `payloadDigest`, first-prepared time, date, or notification type;
5. increment attempt count in the same transaction/locked function that wins reclaim;
6. require matching token and expected status for every daily transition;
7. make `completed` monotonic;
8. return the current row on a rejected transition; and
9. preserve existing `completeScheduledJob` behavior for non-Phase-4 callers, but the Daily Digest must not use its unfenced form.

### Step 4: Implement SQLite atomically

Use existing transactions and conditional SQL. Validate and bound status/token/metadata before SQL. Ensure JSON merge cannot let incoming volatile metadata replace immutable prepared fields. Do not use read-then-unconditional-write.

### Step 5: Implement Supabase atomically

Add and mirror these functions in the migration and `supabase/schema.sql`:

```text
public.claim_scheduled_job
public.transition_scheduled_job
```

Use row locking or one conditional statement per transition, perform attempt increments inside the function, return a reason and row, and treat metadata as server-owned JSONB. Revoke all execution from `public`, `anon`, and `authenticated`; grant only `service_role`. Update `server/storage/supabase.js` to call the functions rather than reproduce a multi-request claim.

### Step 6: Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/scheduledJobs.test.js test/supabaseSecurity.test.js test/backups.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
```

Inspect SQL manually for privilege, search-path, row-lock, status, token, retry, stale, and immutable-metadata behavior.

### Step 7: Diff, commit, and review boundary

Confirm only the six expected files changed. Commit and stop.

Focused review questions:

- Can two Supabase workers both receive `claimed`?
- Can an old token complete after reclaim?
- Can restart bypass `nextRetryAt`?
- Can `transmitting`, `ambiguous`, or `completed` be reclaimed?
- Did the migration add anything beyond two service-role functions?
- Did generic backup behavior regress?

### Prohibited in Task 2

No table/column/index/trigger, no email logic, no scheduler, no HTTP/UI, no provider call, and no production migration execution.

---

## Task 3 — One scheduler, immutable email execution, and ambiguity reconciliation

**Target active implementation time:** 7–10 hours, excluding human review wait.

**Commit message:** `Execute Phase 4 daily digest safely`

### Exact expected files

Create:

- `server/services/dailyDealHunterReconciliation.js`
- `test/dailyDealHunterReconciliation.test.js`

Modify:

- `server/services/dealHunterScheduler.js`
- `server/services/dailyDealHunterDigest.js`
- `server/services/delivery.js`
- `server/services/emailEvents.js`
- `server/services/dealHunter.js`
- `server/config.js`
- `server/app.js`
- `test/dealHunterScheduler.test.js`
- `test/delivery.test.js`
- `test/emailCommunicationLifecycle.test.js`
- `test/config.test.js`
- `test/httpApp.test.js`

`server/index.js` must remain unchanged: its existing single scheduler registration is the correct one. No React, Operations UI, package, lockfile, `fly.toml`, or schema file belongs in this task.

### Step 1: Add RED time/scheduler/execution tests

Extend `test/dealHunterScheduler.test.js` with:

- `daily scheduler is due at 08:00 Pacific in winter PST`
- `daily scheduler is due at 08:00 Pacific in summer PDT`
- `daily scheduler remains one-date once-only across the spring DST transition`
- `daily scheduler remains one-date once-only across the fall DST transition`
- `daily scheduler derives different keys across Pacific midnight`
- `daily scheduler applies the approved weekend decision explicitly`
- `duplicate scheduler admin and cron triggers make one provider call`
- `completed source alert prevents a normal digest after same-date source recovery`
- `fresh pending returns in-progress and stale pending reuses its prepared envelope`
- `definitive failure retries the exact envelope no earlier than thirty minutes`
- `ambiguous provider outcome never makes a second provider call`
- `crash before provider boundary recovers after one hour`
- `crash after provider boundary remains reconciliation-only`
- `crash after provider acceptance reconciles from marker without resend`
- `completed database row prevents resend when marker is missing`
- `marker mismatch never authorizes completion or transmission`

RED command:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterScheduler.test.js
```

### Step 2: Add RED transport/rendering tests

Extend `test/delivery.test.js` with:

- `daily digest normal email renders only the approved projection fields`
- `daily digest source alert renders no opportunity counts names or recommendations`
- `daily digest uses deterministic key and exact source business-date notification tags`
- `daily digest fails closed before network on EmailJS Formspree and production console`
- `daily digest Resend timeout is ambiguous`
- `daily digest accepted response without provider id is ambiguous`
- `daily digest authoritative nonacceptance is definitive failure`
- `daily digest renderer bounds and escapes source issues strengths and concerns`

Use a fake fetcher; never use network.

### Step 3: Add RED reconciliation/webhook tests

Create `test/dailyDealHunterReconciliation.test.js`:

- `matching marker reconciles provider acceptance without a send`
- `matching local email event reconciles provider acceptance without a send`
- `signed email sent webhook tags reconcile the exact daily date`
- `webhook for another source date or payload cannot complete the job`
- `bounded provider lookup requires exactly matching retrieved tags`
- `zero provider matches becomes ambiguous after the reconciliation window`
- `multiple provider matches remain ambiguous and raise an operations issue`
- `late exact provider proof moves ambiguous to completed monotonically`
- `bounce complaint and out-of-order delivery never reopen a completed date`

Extend `test/emailCommunicationLifecycle.test.js` with the signed-webhook integration case. Run:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dailyDealHunterReconciliation.test.js test/emailCommunicationLifecycle.test.js
```

### Step 4: Add RED configuration and route tests

Extend `test/config.test.js`:

- `enabled production daily digest requires Resend recipient sender and signed webhook`
- `daily digest config accepts 08:00 America Los Angeles and rejects invalid wall time or zone`
- `daily digest enablement is independent of every CIM follow-up and Stage 2 flag`

Extend `test/httpApp.test.js`:

- `viewer and unauthenticated callers cannot trigger daily digest`
- `daily digest admin route rejects recipient subject body and unknown input`
- `daily digest cron route requires secret enforces due time and accepts no content`
- `daily digest routes return completed active retry-not-due failed and ambiguous states precisely`

### Step 5: Build deterministic server-owned envelopes

In `server/services/dailyDealHunterDigest.js`:

1. add pure normal and alert text/HTML builders over Task 1's projection;
2. resolve the effective recipient from config only;
3. include exact tags, job key, notification type, version, and payload digest;
4. use existing branded-email and escaping helpers where safe;
5. persist no seen history and call no CIM/CRM method; and
6. return one immutable object suitable for exact failed retry.

In `server/services/dealHunter.js`, retire the scheduler's use of `sendDailyDealHunterReview` in favor of the new projection/envelope service. Do not change CIM/follow-up exports or behavior. Leave compatibility code only if a verified caller still needs it; do not keep two active daily email authorities.

### Step 6: Strengthen the provider seam

In `server/services/delivery.js`:

1. route the prepared daily envelope through the narrow prepared-message seam;
2. add `daily-deal-hunter` to the set requiring Resend acceptance identity/idempotency safety;
3. fail closed before network for ineligible production providers;
4. classify thrown/timeout/connection/parse/missing-ID/concurrent-key outcomes as ambiguous;
5. classify only authoritative nonacceptance as definitive failure;
6. return bounded error category, provider, and provider ID; and
7. avoid best-effort tracking as the only acceptance record—the scheduler/reconciler owns durable result state.

Do not change admin magic-link token logic, CIM authorization, or follow-up authorization.

### Step 7: Implement marker and provider reconciliation

In `server/services/dailyDealHunterReconciliation.js`:

- centralize marker path/validation/atomic temp-file rename;
- expose reconciliation from marker, local event, signed webhook, and injected Resend read-only client;
- bound sent-email listing/time window/candidate retrieval;
- require exact source/date/notification tags and prepared recipient/subject/payload identity where available;
- complete with Task 2's token/status-fenced transition;
- allow late exact proof to move `ambiguous` to `completed` without send; and
- return sanitized reason/status data.

In `server/services/emailEvents.js`, after signature verification and replay-safe event insertion, pass only exact Daily Deal Hunter outbound-tag events to the reconciliation service. Do not create a generic webhook-triggered scheduler or let tags supply recipient/content.

### Step 8: Replace the scheduler's execution path

In `server/services/dealHunterScheduler.js`:

1. keep `startDealHunterDailyEmailScheduler` and the existing startup registration;
2. derive Pacific date/due from the configured IANA zone;
3. reconcile before attempting a claim;
4. create a random claim token and use Task 2 storage methods;
5. build/persist the projection and exact envelope while `pending`;
6. transition to `transmitting` before the single provider call;
7. on acceptance, atomically write marker, then complete the database row and local event with provider ID;
8. on definitive failure, persist failed state and `nextRetryAt=+30m` without a marker;
9. on ambiguity, reconcile only and never mark completed/failed;
10. repair missing marker from completed DB evidence;
11. preserve same-process `inFlight`, same-date sent set, and tick interval as optimization only; and
12. return precise states to scheduler/admin/cron callers.

The secret-authenticated cron trigger must obey automatic due time. The existing administrator run may remain an explicit same-date override because it already exists, but it accepts `{}` only and cannot bypass claims, retry cutoff, ambiguity, or completion.

### Step 9: Production-readiness validation and strict routes

In `server/config.js`, add the enabled-production requirements without adding variables. In `server/app.js`, strict-allowlist the two existing trigger bodies and map states to stable HTTP results without exposing envelope/recipient. Do not add endpoints.

### Step 10: Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dailyDealHunterDigest.test.js test/dailyDealHunterReconciliation.test.js test/dealHunterScheduler.test.js test/delivery.test.js test/emailCommunicationLifecycle.test.js test/config.test.js test/httpApp.test.js test/scheduledJobs.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
```

### Step 11: Diff, commit, and review boundary

Confirm only expected files changed, `server/index.js` has no diff, and no test made a network call. Commit and stop.

Focused review questions:

- Is there exactly one scheduler and one job key?
- Can any ambiguous or provider-boundary crash issue a second POST?
- Is failed retry same-key/same-payload and durably delayed?
- Can an alert ever include opportunity content or later coexist with a normal result?
- Are marker, event, webhook, and provider identities exact enough to avoid false reconciliation?
- Did magic-link, CRM, CIM, follow-up, and Stage 2 behavior remain structurally separate?

### Prohibited in Task 3

No UI/Operations work, no new route, no second scheduler, no schema, no actual provider request, no production config, no generic notification infrastructure, and no Phase 1–3 behavior expansion.

---

## Task 4 — Acquisition Inbox briefing, authority gating, and sanitized Operations

**Target active implementation time:** 4–6 hours, excluding human review wait.

**Commit message:** `Show Phase 4 briefing in Acquisition Inbox`

### Exact expected files

Create:

- `test-browser/admin-phase4-digest.spec.js`

Modify:

- `server/services/dealHunterTriage.js`
- `server/services/operations.js`
- `src/components/admin/AcquisitionInbox.jsx`
- `src/components/admin/OperationsCenter.jsx`
- `test/dealHunterTriage.test.js`
- `test/operations.test.js`
- `test/httpApp.test.js`
- `test-ui/AcquisitionInbox.test.jsx`

No legacy `DealHunterWorkspace`, dashboard navigation, scheduler, provider, config, package, lockfile, `fly.toml`, or schema change belongs in this task.

### Step 1: Add RED server projection and sanitization tests

Extend `test/dealHunterTriage.test.js`:

- `triage response includes the bounded server-owned morning briefing projection`
- `required source failure returns null briefing summary no recommendations and actions disallowed`
- `optional stale Deal OS returns warning with primary-backed briefing and actions allowed`
- `triage decision mutation rechecks required source authority server-side`
- `viewer projection contains no recipient envelope provider secret or operator note`

Extend `test/operations.test.js`:

- `operations sanitizes daily digest envelope and recipient from every scheduled job`
- `operations surfaces daily completed alert failed retry pending stale and ambiguous states`
- `operations reports marker mismatch without exposing marker content`

Extend `test/httpApp.test.js`:

- `required source authority blocks direct Acquisition Inbox decision mutation`
- `optional Deal OS warning does not block a current primary-backed decision`
- `viewer can read but cannot mutate the Daily Digest briefing`

Run and capture RED:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterTriage.test.js test/operations.test.js test/httpApp.test.js
```

### Step 2: Add RED React tests

Extend `test-ui/AcquisitionInbox.test.jsx`:

- `Acquisition Inbox renders the ready morning briefing above filters`
- `Acquisition Inbox renders one bounded optional Deal OS warning and usable primary summary`
- `Acquisition Inbox renders prominent required-source action and hides trusted recommendations`
- `required-source state labels persisted rows last-known and disables decision controls`
- `viewer sees briefing but no mutation or send control`
- `briefing error fails closed and links to Operations`
- `briefing announces asynchronous source status accessibly without stealing focus`

RED command:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin ./node_modules/.bin/vitest run test-ui/AcquisitionInbox.test.jsx
```

### Step 3: Attach the shared projection to triage

In `server/services/dealHunterTriage.js`:

1. use Task 1's pure projector over the already loaded queue/source/job data;
2. return `dailyDigest` with only the spec's bounded fields;
3. return a server-owned `actionsAllowed` decision;
4. fail closed when required source authority/projection is unavailable;
5. recheck required source authority in Pursue/Watch/Pass mutations rather than trusting the browser boolean; and
6. preserve optional-warning behavior because Deal OS is supplemental.

Do not change the queue's filters, order, scoring, pagination, or row schema outside the explicit `dailyDigest` addition.

### Step 4: Sanitize and summarize Operations

In `server/services/operations.js`:

- sanitize scheduled jobs before returning them;
- remove prepared envelope, address, body, HTML, headers, raw provider response, and source URLs recursively;
- return bounded daily state, dates, notification type, attempt count, retry time, provider-ID policy, marker status, reconciliation source, and error category; and
- count ambiguous daily jobs as high-severity attention.

In `src/components/admin/OperationsCenter.jsx`, render a small Daily Deal Hunter status card within existing scheduler/source sections. Do not add a new Operations action or notification page.

### Step 5: Render the existing Acquisition Inbox integration

In `src/components/admin/AcquisitionInbox.jsx`:

- place **Morning briefing** above queue filters;
- render ready counts and top items from `dailyDigest`, not client recomputation;
- render one amber optional warning while leaving current primary-backed review usable;
- render prominent red required action with no trusted summary/top items;
- label underlying persisted queue rows as last-known and pass the server action gate into controls;
- keep viewer behavior read-only;
- link to the two existing admin URLs; and
- preserve focus, abort, stale-response, loading, empty, pagination, drawer, and accessibility behavior.

Do not add a manual send/run/preview button.

### Step 6: Browser acceptance

In `test-browser/admin-phase4-digest.spec.js`, use local seeded/fake data only and cover:

1. administrator sees ready briefing at desktop and mobile widths;
2. optional warning leaves primary-backed Inbox usable;
3. required failure removes trusted recommendations and disables actions;
4. viewer sees the briefing with no mutation/send control;
5. Operations shows sanitized result state; and
6. no page load or click causes a provider request, score refresh, CRM mutation, CIM send, follow-up, or Stage 2 run.

### Step 7: Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterTriage.test.js test/operations.test.js test/httpApp.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin ./node_modules/.bin/vitest run test-ui/AcquisitionInbox.test.jsx
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin ./node_modules/.bin/playwright test test-browser/admin-phase4-digest.spec.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
```

### Step 8: Diff, commit, and review boundary

Confirm only the nine expected files changed. Commit and stop.

Focused review questions:

- Does React only render server authority?
- Are required versus optional failures visually and semantically distinct?
- Can direct HTTP mutation bypass the required-source gate?
- Does optional Deal OS degradation preserve primary-backed use?
- Can any envelope/recipient leak through Operations?
- Did the task avoid a new send control or notification product?

### Prohibited in Task 4

No provider/scheduler/config/schema work, no new navigation or generic notifications, no changed queue ranking, no legacy workspace refactor, no real email, and no production access.

---

## Task 5 — Documentation, full non-production acceptance, and release handoff

**Target active implementation time:** 2–3 hours, excluding human review and the later production observation window.

**Commit message:** `Document Phase 4 digest operations`

### Exact expected files

Modify:

- `README.md`
- `docs/backend-setup.md`
- `docs/deployment.md`

Do not change production code, tests, config, packages, lockfiles, `fly.toml`, migrations, or generated artifacts in this task. If full verification reveals a defect, stop and return it to the owning task for a narrow repair commit; do not repair it inside the docs task.

### Step 1: Record the documentation gap before editing

Run these read-only checks and confirm the existing text does not yet describe the final Phase 4 state machine and smoke gate completely:

```sh
rg -n 'transmitting|ambiguous|nextRetryAt|business_date|Morning briefing|one completed result' README.md docs/backend-setup.md docs/deployment.md
rg -n 'Daily Deal Hunter|scheduled_job_runs|deal-hunter-daily-email' README.md docs/backend-setup.md docs/deployment.md
```

### Step 2: Update operator/developer documentation

Document:

- exact 08:00 Pacific IANA semantics and approved weekend behavior;
- canonical date key and normal-versus-alert exclusivity;
- required/optional source behavior and normal email field limits;
- `pending`, `transmitting`, `failed`, `ambiguous`, and `completed` meanings;
- one-hour pending recovery and durable 30-minute definitive-failure retry;
- no retry after ambiguity and exact reconciliation evidence;
- marker location and DB/history authority;
- effective internal recipient naming without any real address;
- Resend/signed webhook requirement and tags;
- Acquisition Inbox and Operations behavior;
- server/UI authorization boundaries;
- exact no-CRM/CIM/follow-up/Stage 2 guarantees;
- SQLite backup/readiness and Supabase function migration steps;
- rollback without evidence deletion; and
- the spec's production smoke strategy, explicitly prohibiting an extra test email.

Correct the legacy source-alert URL from `?view=source-review` to the working `?view=operations` wherever it is documented. Do not change `fly.toml` or a runtime value.

### Step 3: Full non-production acceptance

Run in this order:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run eval:follow-ups
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm test
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run test:ui
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run test:browser
git diff --check
git status --short
```

Also inspect:

```sh
git diff ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8...HEAD -- server/index.js fly.toml package.json package-lock.json
git diff --stat ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8...HEAD
git log --oneline --decorate ba4a73f78ba1213373b46e6c5ac6aa6b6caa50a8..HEAD
```

Expected:

- `server/index.js` still has one Daily Deal Hunter scheduler registration;
- `fly.toml`, packages, and lockfile are unchanged;
- no live provider/network fixture exists;
- only the one allowed Supabase function migration changed schema assets;
- all test/lint/build/browser checks pass; and
- each task has its own reviewed commit.

### Step 4: Prepare but do not execute the release handoff

Return a release checklist that requires separate authorization for backup, deployment, configuration inspection/change, production access, and the first natural 08:00 observation. Include stop conditions for:

- release/base mismatch;
- central CIM pause not `true`;
- follow-ups enabled;
- effective stage not 1, automation not paused, or Stage 2 scheduler enabled;
- missing/invalid internal recipient;
- Resend/webhook not ready;
- SQLite integrity/backup failure;
- marker directory not durable/writable;
- more than one scheduler registration;
- an existing same-date completion; or
- any ambiguous/multiple provider identity.

Do not deploy or send from this task.

### Step 5: Diff, commit, and final review boundary

Confirm the task diff is documentation-only. Commit and stop for final whole-phase review.

Final review questions:

- Does the implementation satisfy every specification acceptance criterion?
- Is there exactly one result identity and one scheduler?
- Do crash/ambiguity behavior and provider evidence eliminate blind retransmission?
- Is the current Acquisition Inbox the only recommendation authority?
- Are all Phase 1–3 safety flags and authorization boundaries unchanged?
- Is the release checklist executable without leaking recipient/secret data or sending an extra smoke email?

### Prohibited in Task 5

No bug fix hidden in docs work, no source/config/migration change, no deployment, no production check, no provider call, no email, no push, and no PR.

---

## Estimated implementation effort

| Task | Active engineering time |
| --- | ---: |
| Task 1 — authority projection | 4–6 hours |
| Task 2 — atomic storage/fencing | 5–7 hours |
| Task 3 — scheduler/provider/reconciliation | 7–10 hours |
| Task 4 — admin/Operations UI | 4–6 hours |
| Task 5 — docs/full acceptance | 2–3 hours |
| **Total** | **22–32 active hours** |

The estimate excludes human review wait, production authorization, deployment, and waiting for the first natural 08:00 Pacific result. The work should span multiple bounded implementation/review cycles, not one giant autonomous run.

## Final implementation completion gate

After Task 5's commit and focused review, do not deploy. Return:

- all task and repair commit SHAs;
- exact verification results;
- full diff/stat and prohibited-scope audit;
- SQLite/Supabase parity evidence;
- one-scheduler evidence;
- DST/weekend decision evidence;
- provider ambiguity/reconciliation evidence;
- admin/viewer/browser evidence;
- confirmation no real email or production access occurred;
- confirmation CIM/follow-up/Stage 2 safety state was not changed; and
- the separately authorized production rollout/smoke checklist.

Human approval is then required for any deployment or production observation.
