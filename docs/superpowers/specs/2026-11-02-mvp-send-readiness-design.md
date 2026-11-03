# MVP Send Readiness (provider-independent) — Design

Date: 2026-11-02
Branch: `codex/mvp-send-readiness`, stacked on `codex/best-first-deal-list` (PR #84). The PR targets #84's branch until #84 merges, then retargets `main`.

## 1. Purpose

The owner's MVP is: the best deals that meet the owner's criteria rise to the top, 90+ deals get a SIM request automatically, 75–89 deals get one on a single owner click, and follow-ups run until the broker replies. PR #84 delivered ranking and the Request SIM decision. Sending itself waits on an owner decision about the email provider and contact-permission basis (P8-00). This design covers everything that does **not** depend on that decision, so that once a provider is chosen only the send runners remain.

Owner decisions captured in conversation (2026-11-02):

- Follow-ups run every 2 business days until the 28-day campaign expiry (about 9 follow-ups), stopping on reply or materials.
- Sections 1–4 below were approved as presented in chat.

Out of scope: production send runners (initial and follow-up), provider choice, P10B qualification, email copy, deploys, enabling any production flag, merging PRs, retiring the legacy outreach system.

## 2. Send timing: cadence v3

### 2.1 Rule

`deal-hunter-cim-cadence-v3` (new constant in `server/services/cimCampaignPolicy.js`; `deal-hunter-cim-cadence-v2` stays exported and supported):

- `initial`: unchanged (ready time rolled into Mon–Fri 08:00–<17:00 local).
- Every follow-up (`follow-up-1`, `follow-up-2`, `follow-up-3`, then repeating `weekday-follow-up`): the prior touch's provider-accepted **local date** plus 2 business days (Mon–Fri), at the campaign send time (default `08:00`). Saturday and Sunday never count and never receive a send.
- Expiry unchanged: initial accepted local wall-clock + 28 calendar days. A touch whose due time is at or after expiry is not scheduled.
- No holiday calendar.
- Touch kinds and the touch-table CHECK are unchanged. Under v3 the repeating `weekday-follow-up` slot key is `business:YYYY-MM-DD` (v2 keeps `calendar:YYYY-MM-DD`). Other kinds keep their v2 slot keys.

### 2.2 Version selection

A campaign's cadence version is fixed when its initial touch is accepted: `calculateCampaignExpiry` stamps `expiry_derivation.cadencePolicyVersion`. After this ships, new acceptances stamp v3. A campaign whose `expiry_derivation` already names v2 keeps v2 for its whole life. Follow-up derivation (`deriveAcceptedCimCadence` in `pursueCimCadence.js`) reads the campaign's stamped version and dispatches to the matching rule. `calculateNextCimSlot` takes an explicit `cadencePolicyVersion` for every non-initial kind and throws `Unknown CIM cadence policy.` for any value other than v2 or v3. It never defaults silently.

### 2.3 Database parity

The Postgres validator `pursue_cim_validate_accepted_cadence_v1` re-derives due dates. A new migration replaces it (same name and signature) with a branch for v3, and accepts both versions wherever it compares `cadencePolicyVersion`. `supabase/schema.sql` gets byte-identical copies. SQLite transitions in `pursueCimSqliteTransitions.js` that hard-code the v2 literal accept both versions. Hard-coded literals are replaced by the exported constants or a shared `SUPPORTED_CIM_CADENCE_POLICY_VERSIONS` list.

### 2.4 Tests

- v3 skips weekends for every follow-up ordinal, including the repeating ones.
- A Thursday or Friday acceptance lands on the next Monday or Tuesday.
- DST transitions in America/Los_Angeles and America/New_York; no DST in America/Phoenix.
- Expiry cutoff: no touch at or after day 28.
- A v2-stamped campaign still produces v2 dates and slot keys.
- An unknown version throws.
- The gated Postgres suite asserts the JS and SQL derivations agree for the v3 sequence.

## 3. Send timing: timezone from state

### 3.1 Resolver

`resolveLocationTimezone({ state, location })` in `server/services/opportunityTimezone.js` replaces the disabled stub. The resolver version is `target-state-v1`, and `TIMEZONE_DATASET_DIGEST` becomes the sha256 of the canonical JSON of the mapping below.

| State | IANA zone |
|---|---|
| NY, NJ, CT | America/New_York |
| CA, NV | America/Los_Angeles |
| AZ | America/Phoenix |

- **State input.** The `state` field (2-letter code or full name, using the same state-name map as `dealCriteriaProfile.js`, moved to a shared export) and any target state named in the `location` text.
- **Eligible.** Exactly one target state is identified across both inputs, and no exception matches. The result is `{ eligible: true, ianaTimezone, resolverVersion: 'target-state-v1' }`.
- **`timezone_ambiguous`:**
  - `state` and `location` name different states;
  - the location text matches an exception (case-insensitive):
    - NV: `west wendover`, `jackpot`;
    - AZ: `navajo`, `window rock`, `tuba city`, `kayenta`, `chinle`.
- **`timezone_missing`:** no state is identifiable, or the state is outside the six.

### 3.2 Writing a derived revision

New server-only writer `appendDerivedOpportunityTimezoneRevision({ storage, opportunityId, state, location, now })` in `server/services/opportunityTimezoneRevision.js`. It appends a `deal_hunter_opportunity_timezone_revisions` row with:

- `state='derived'` and the resolver's zone;
- `evidence_type='target-state'`;
- `evidence_id` = `target-state:<STATE>`;
- `evidence_digest` = `timezoneEvidenceDigest` of the normalized inputs;
- `resolver_version='target-state-v1'`, the new dataset digest, and `actor='system-timezone-resolver'`.

It writes nothing when:

- the latest revision is `verified` or `derived`;
- the resolver is not eligible;
- the latest revision already carries the same evidence digest (this keeps it idempotent).

It uses the existing optimistic `expectedPriorRevision` guard. On a stale-revision conflict it re-reads once and then gives up quietly. Both stores must accept `evidence_type='target-state'`, via a migration if a CHECK constrains it.

**Call site:** Pursue enrollment (`pursueCimEnrollment.js`), immediately before it reads enrollment authority. It uses the opportunity's current score row (`state`, `location`). A failure to derive is never an error. Enrollment proceeds exactly as today and reports `timezone_missing` or `timezone_ambiguous`.

An owner-verified revision always wins: the writer never runs over one, and a later owner revision supersedes a derived one through the existing revision ordering.

### 3.3 Owner timezone picker

`OpportunityDrawer.jsx` gains a small "Set timezone" control inside the CIM release card. It shows only when `release.timezoneAuthority` is missing or ambiguous, and never in read-only mode.

- **Zone choices:**
  - America/New_York
  - America/Chicago
  - America/Denver
  - America/Phoenix
  - America/Los_Angeles
- **Confirm step.** One click asks "Use <zone> for this deal's send times?".
- **Request.** On confirm it calls the existing `POST /api/admin/deal-hunter/triage/:opportunityId/timezone` with:
  - `evidenceType: 'operator-verified'` and `evidenceId: 'owner-drawer'`;
  - `expectedPriorRevision` set to the current revision;
  - a fresh UUID `idempotencyKey`.
- **Afterwards.** It reloads the release. A 409 shows "Timezone changed elsewhere — reload and try again."

### 3.4 Tests

- **Resolver:** each of the six states by code and by full name; state found in location only; state/location disagreement; each exception; out-of-scope state; empty inputs.
- **Writer:**
  - writes a derived row;
  - no-op over verified, over derived, and on the same evidence;
  - stale conflict handled.
- **Enrollment:** a fresh AZ deal enrolls with a derived Phoenix zone, and a Wendover deal reports `timezone_ambiguous`.
- **UI (Vitest):** the picker appears only for missing/ambiguous, sends the expected body, and handles 409.

## 4. One email system per deal

### 4.1 Guard

A Pursue claim on an opportunity is any of:

- a latest owner decision with action `pursue`;
- a current enrollment;
- a campaign in any state.

These are read via `storage.readPursueCimProjection({ opportunityId })`. A legacy send must refuse when a claim exists.

- **Legacy initial sends.** `sendCimRequestForScoredDeal` (`server/services/dealHunter.js`) re-checks after it has acquired the legacy opportunity claim (`claimDealHunterCimOpportunity`) and before any provider call.
  - If a claim exists, it releases or abandons the legacy claim the way existing refusals do, and fails with code `pursue_owns_opportunity`.
  - If the projection read fails, it fails closed with `pursue_authority_unavailable`.
  - Checking after the claim closes the race with a concurrent Request SIM. Pursue's existing send-time check already refuses when a legacy claim exists, so whichever side claims first wins and the other refuses.
- **Legacy follow-ups.** `executeDealHunterCimFollowUpRequest` performs the same check before sending. `runDealHunterCimFollowUps` reports such requests as skipped with reason `pursue_owns_opportunity` instead of attempting them.
- **Stage 2 automation.** Candidate selection in `runCimStage2Automation` skips claimed opportunities, with reason `pursue_owns_opportunity` in run items.
- **No other changes.** Nothing is deleted, no legacy flag changes, and the legacy system keeps working for unpursued deals.

### 4.2 Owner-visible message

Routes that surface the refusal return HTTP 409 with code `pursue_owns_opportunity`. The admin UI shows: "This deal is in a SIM request campaign — manage it from the drawer." The refusal is not shown as a generic failure.

### 4.3 Tests

- For each of the three paths, a pursued deal is refused and an unpursued deal proceeds.
- An ended campaign still refuses.
- A projection read failure refuses.
- **Race test:** a Pursue decision recorded between the legacy pre-check and the provider call is caught by the post-claim re-check, and no provider call happens.

## 5. Daily Sheet sync, then automatic Pursue

### 5.1 Job

New module `server/services/dealHunterSheetSync.js` exports `runDealHunterSheetSync({ storage, now, triggeredBy })`.

1. **Sync.** Call `refreshOpportunityScores` with the same review mode the daily digest uses (`full-backfill`), so sheet import, freshness writes and scoring are the existing code paths.
2. **Build a result:**
   - `sheets`: one entry per configured sheet, `{ sourceId, fetched, rowCount, error (≤300 chars), durationMs }`;
   - `scoredCount`;
   - `groupCounts` (rows per criteria group after the sync);
   - `requiredSourcesHealthy`.
3. **Automatic Pursue.** If every required sheet fetched and scoring was not deferred, call `runAutoPursue({ storage, now, triggeredBy: 'sheet-sync', currentFingerprints })`, passing the refresh result's map (§6.1).
   - Record `{ runKey, status, mode }`, or the error text if it threw. An automatic Pursue failure does not fail the sync.
   - Otherwise record `autoPursue: { skipped: 'required_source_failed' }`.

### 5.2 Scheduler

`startDealHunterSheetSyncScheduler` in `server/services/dealHunterScheduler.js`, registered in `server/index.js`. It is modeled on the daily digest scheduler.

- **Config:** `dealHunter.sheetSync` = `{ enabled, runAt: '07:30', timezone: 'America/Los_Angeles', retryIntervalMs: 1800000, retryUntil: '12:00', checkIntervalMs: 60000 }`.
- **Enabling:** `enabled` comes from `DEAL_HUNTER_SHEET_SYNC_ENABLED`, default **false**. `fly.toml` is not changed.
- **When it runs:** Monday–Friday only, local to the configured timezone. The first attempt is at or after `runAt`.
- **Claiming:** one claim per business date in `scheduled_job_runs`, with job name `deal-hunter-sheet-sync` and key `deal-hunter-sheet-sync:<YYYY-MM-DD>`. It uses `claimScheduledJob` / `transitionScheduledJob` / `completeScheduledJob`, and stores the result as metadata.
- **Retries:** a sync with unhealthy required sources, or one that throws, is marked failed. It is retried every `retryIntervalMs` until `retryUntil`, and not after. A completed date never re-runs.
- **Visibility:** runs appear in Operations → Job history automatically. The job-history projection shows per-sheet status and the automatic Pursue outcome.
- **Daily digest:** unchanged.

### 5.3 Tests

These use a fake clock and an injected runner.

- Fires at 07:30 PT on a weekday and not on a weekend.
- No double run on the same date, including across a scheduler restart.
- Retries after failure until noon, then stops.
- Disabled when the flag is off.
- Automatic Pursue is called only when required sheets are healthy, and the skip reason is recorded otherwise.
- An automatic Pursue throw is recorded without failing the sync.
- The operations projection shows the sheet metadata.

## 6. Pre-canary hardening (parked from PR #84)

1. **Stale facts by fingerprint.**
   - A score fingerprint is computed by the scorer from the deal as built from live sources. It cannot be recomputed from stored rows alone.
   - `refreshOpportunityScores` therefore adds `currentFingerprints: { [opportunityId]: fingerprint }` to its result, covering every candidate it considered (scored or already current).
   - `runAutoPursue` accepts an optional `currentFingerprints`. In `canary` and `active` modes, a row may be Pursued only when that map was supplied and its entry equals the row's stored `score_fingerprint`. A missing map, a missing entry or a mismatch blocks with `criteria_stale`.
   - Shadow mode records the same blocker, which makes it visible during shadow runs.
   - The daily job (§5) supplies the map from the refresh it just ran. A run without a fresh refresh (for example the existing cron route) therefore cannot take an automatic decision.
   - The existing time and material-revision check stays as a second condition.
2. **Safe truncation.** `observed` text in criteria results is truncated by code points (`Array.from(text).slice(0, 200).join('')`), never inside a surrogate pair.
3. **Stop from the inbox.**
   - `GET /api/admin/deal-hunter/auto-pursue` adds `todayPursued: [{ opportunityId, name }]`, the opportunities with an `auto-pursue-v1` decision on today's owner business date.
   - The "Pursuing automatically" group header lists them, each with a "Stop SIM request" button.
   - The button confirms first ("Stop the SIM request to <name>? No more emails will be sent.") and then calls the existing `POST /api/admin/deal-hunter/triage/:opportunityId/cim-release/stop`.
   - The button is hidden for viewers.
4. **Database guards.**
   - **Supabase.** `deal_hunter_owner_decision_events.policy_version` is CHECK-constrained to `owner-decision-v1` or `auto-pursue-v1`. A second CHECK requires actor `automation-auto-pursue` and action `pursue` when the policy is `auto-pursue-v1`.
     - The migration verifies existing rows first.
     - If any existing row violates the constraints, the migration fails with a clear message rather than adding `NOT VALID`.
   - **Both stores.** An index on decision events `(opportunity_id, created_at)`.
5. **Out-of-date rows.** Score rows whose `criteria_profile_version` is not current show blocker `criteria_out_of_date`. The blocker clears when the row is rescored at the current version. It is written only when it changes, so inbox cursors are not invalidated needlessly.

Tests:

- a state change after scoring blocks with `criteria_stale`;
- an emoji at character 200 is kept whole;
- `todayPursued` and the stop button, both API and Vitest;
- the gated Postgres suite rejects an `auto-pursue-v1` event with the wrong actor;
- an out-of-date row shows `criteria_out_of_date`, and the blocker clears after a rescore.

## 7. Failure behavior

Every new check fails closed: no email and no automatic decision. The only cost is that work waits for the next run or for the owner. Nothing in this design sends email, enables a capability, or changes production configuration.

## 8. Release notes (for the eventual deploy, owner-run)

- Apply the new Supabase migrations before deploying the app.
- To start the daily job, set `DEAL_HUNTER_SHEET_SYNC_ENABLED=true`. Automatic Pursue stays in whatever mode the owner set (default off).
- Timezones for target-state deals are now derived automatically when a deal is pursued. The owner can override any of them from the drawer.

## 9. Delivery

One branch, one PR, tasks in this order, each implemented by a sub-agent and reviewed before the next (the plan may split a section across tasks):

1. Hardening (§6)
2. Cadence v3 (§2)
3. Timezone (§3)
4. Legacy guard (§4)
5. Daily job (§5)

Verification before the PR: backend tests, UI tests, lint, build, the gated Postgres suites, and the browser suite on `PLAYWRIGHT_PORT=4273`.
