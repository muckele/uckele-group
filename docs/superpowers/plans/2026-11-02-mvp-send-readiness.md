# MVP Send Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everything except the provider-dependent send runners ready for MVP. That covers automatic-Pursue hardening, business-day cadence v3, state-derived timezones, a one-email-system-per-deal guard, and a logged daily Sheet sync that triggers automatic Pursue.

**Architecture:** These are small extensions of existing modules: the score store, `autoPursue.js`, `cimCampaignPolicy.js` and `pursueCimCadence.js`, `opportunityTimezone.js`, the legacy send chokepoints in `dealHunter.js`, and the scheduler pattern in `dealHunterScheduler.js`. Each persistence change lands in SQLite and Supabase together (migration plus byte-identical `supabase/schema.sql` copy).

**Tech Stack:** Node 22 ESM, Express 4, better-sqlite3, Supabase/Postgres (RPCs, migrations), React 18 + Vite, `node --test`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-mvp-send-readiness-design.md`

## Global Constraints

- Node 22: `. "$HOME/.nvm/nvm.sh"; nvm use 22` before any npm/node command.
- Backend tests: `node --test test/<file>.test.js`; full backend run with `npm test`. UI tests: `npx vitest run test-ui/<file>.test.jsx`. These need the Bash sandbox disabled. If Vitest stalls, run `pkill -f vitest`.
- Lint: `npm run lint`. Build: `npm run build`.
- Never stop or kill anything on port 4173: it belongs to the owner's other project. Browser suite only with `PLAYWRIGHT_PORT=4273 npm run test:browser`.
- No change may send email, enable a capability, change `fly.toml`, or change any production default. New env flag `DEAL_HUNTER_SHEET_SYNC_ENABLED` defaults to false.
- Every new Supabase migration file goes in `supabase/migrations/` with a timestamp after `20261102120000`. Function bodies are copied byte-identically into `supabase/schema.sql`.
- Exact strings:
  - Cadence versions: `deal-hunter-cim-cadence-v3` and `deal-hunter-cim-cadence-v2`.
  - Timezone resolver: `target-state-v1`; evidence type `target-state`; actor `system-timezone-resolver`.
  - Refusal codes: `pursue_owns_opportunity`, `pursue_authority_unavailable`.
  - Daily job: name `deal-hunter-sheet-sync`, key `deal-hunter-sheet-sync:<YYYY-MM-DD>`.
  - Legacy refusal copy: "This deal is in a SIM request campaign — manage it from the drawer."
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Fail closed everywhere: an unreadable authority means no email and no automatic decision.

## Review Focus

1. **A follow-up computed on Friday afternoon local time but accepted after midnight UTC.** The business-day step must use the accepted **local** date in the campaign zone, not the UTC date. Task 3 adds a test with an acceptance at 2026-11-06T23:30 America/Los_Angeles, which is Saturday in UTC. Expected next due: Tuesday 2026-11-10 08:00 local.
2. **A deal pursued by the owner while a legacy send is mid-flight.** The legacy post-claim re-check must catch it. Task 5's race test pins this.
3. **A sheet sync that succeeds on retry after an earlier failed attempt the same day.** Automatic Pursue must run once, on the successful attempt, and never twice. Task 6 pins this.
4. **A state field holding a full name with odd spacing or case, such as `"  new   york "`.** It must resolve to America/New_York. Task 4 pins this.
5. **The owner's Supabase install with historical `owner_decision_events` rows.** The new CHECK must not silently drop or rewrite them: the migration verifies first and raises if any row violates. Task 1's Postgres test pins this.

---

### Task 1: Automatic-Pursue hardening (backend)

Spec §6 items 1, 2, 4 and 5.

**Files:**
- Modify: `server/services/dealHunterScoreStore.js` (`refreshOpportunityScores` result)
- Modify: `server/services/autoPursue.js` (`runAutoPursue`, `evaluateBlocker`, out-of-date handling)
- Modify: `server/services/dealCriteriaProfile.js:35` (truncation)
- Modify: `server/storage/sqlite.js` (decision-events index)
- Create: `supabase/migrations/20261102130000_mvp_send_readiness_guards.sql`
- Modify: `supabase/schema.sql`
- Test: `test/autoPursue.test.js`, `test/dealCriteriaProfile.test.js`, `test/autoPursuePostgres.test.js` (gated)

**Interfaces:**
- Produces:
  - `refreshOpportunityScores(...)` result gains `currentFingerprints: Record<string, string>`, keyed by opportunity id, for every candidate considered (scored, unchanged or version-only).
  - On the `scoringDeferred` early return it is `{}`.
- Produces:
  - `runAutoPursue({ storage, now, triggeredBy, clock, currentFingerprints = null })`.
  - In modes `canary` and `active`, a row whose `currentFingerprints?.[id]` is missing or `!== row.score_fingerprint` gets blocker `criteria_stale`.
  - In `shadow` mode the same blocker is recorded.
  - In `off` mode, existing behavior is unchanged.

- [ ] **Step 1: Write failing tests** in `test/autoPursue.test.js`:
  - `canary run without currentFingerprints blocks every auto row with criteria_stale`
  - `canary run with matching fingerprint Pursues the row`
  - `canary run with mismatched fingerprint blocks with criteria_stale and records no decision`
  - `shadow run with mismatched fingerprint records criteria_stale blocker`
  - `row stored under an older criteria profile version shows criteria_out_of_date and clears after rescore at current version`
  - `blocker is not rewritten when unchanged`: spy on the storage blocker writer and assert one write across two identical runs.

  In `test/dealCriteriaProfile.test.js`:
  - `observed text truncation keeps a surrogate pair whole`: build a location of 199 `a` plus `😀` plus `bbb`. Assert observed equals 199 `a` + `😀`, i.e. `Array.from(observed).length === 200`, and that no lone surrogate exists: `!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(observed)`.

  Add a refresh test (where the existing score-store tests live, found with `grep -ln refreshOpportunityScores test/`): `refreshOpportunityScores returns currentFingerprints for scored and unchanged candidates`.
- [ ] **Step 2: Run them, expect FAIL.** `node --test test/autoPursue.test.js test/dealCriteriaProfile.test.js`
- [ ] **Step 3: Implement.**
  - Add `currentFingerprints` to the refresh result.
  - Add the `currentFingerprints` param and the mode-dependent check in `evaluateBlocker`. Keep `autoPursueCriteriaStale` as a second condition.
  - Make `criteria_out_of_date` reachable for stale-version rows. The runner must evaluate rows of any version among the candidates it already lists. Write blockers only when they differ from the stored value.
  - Truncate by code points.
- [ ] **Step 4: Database guards.** Write the migration.
  1. A `DO` block that raises `exception 'owner_decision_events has rows violating policy guard'` if any row has `policy_version not in ('owner-decision-v1','auto-pursue-v1')`, or has `policy_version = 'auto-pursue-v1'` with actor `<> 'automation-auto-pursue'` or action `<> 'pursue'`. Read the column names from `20261102120000_best_first_deal_list.sql` and the base table migration.
  2. `alter table ... add constraint deal_hunter_owner_decision_events_policy_version_check check (...)` and `..._auto_pursue_actor_check`.
  3. `create index if not exists idx_deal_hunter_owner_decision_events_opportunity_created on deal_hunter_owner_decision_events (opportunity_id, created_at desc)`.

  Mirror it in `supabase/schema.sql`. Add the same index (`CREATE INDEX IF NOT EXISTS`, same name) in the SQLite schema in `server/storage/sqlite.js`.

  In `test/autoPursuePostgres.test.js` (gated), add `rejects auto-pursue-v1 decision event with a non-automation actor`.
- [ ] **Step 5: Run.**
  - `node --test test/autoPursue.test.js test/dealCriteriaProfile.test.js test/httpAutoPursue.test.js test/autoPursueEvidence.test.js`: PASS.
  - `npm test`: 0 failures.
  - The gated Postgres test runs only if its env var is set. Note in the report whether it ran.
- [ ] **Step 6: Commit** `feat: harden automatic Pursue before canary`.

### Task 2: Stop automatic SIM requests from the inbox

Spec §6 item 3.

**Files:**
- Modify: `server/services/autoPursue.js` (`getAutoPursueStatus`)
- Modify: storage adapters only if needed: reuse the decision-events query used for the daily cap (`countOwnerDecisionsByPolicy`'s sibling). Add `listOwnerDecisionsByPolicy({ policyVersion, since, until })` to both adapters if no list form exists.
- Modify: `src/components/admin/AcquisitionInbox.jsx` ("Pursuing automatically" group header)
- Test: `test/httpAutoPursue.test.js`, `test-ui/AcquisitionInbox.test.jsx`

**Interfaces:**
- Consumes: `ownerBusinessDateBounds(date)` from `autoPursue.js`.
- Produces: `getAutoPursueStatus(...)` result gains `todayPursued: Array<{ opportunityId: string, name: string }>`. These are decisions with `policy_version = 'auto-pursue-v1'` inside today's owner business-date bounds, newest first, max 10. The name comes from the opportunity's canonical name, falling back to the opportunity id.

- [ ] **Step 1: Failing tests.**
  - HTTP: `GET /api/admin/deal-hunter/auto-pursue includes todayPursued for today's automatic decisions only`. Seed one today and one yesterday, and assert only today's appears.
  - Vitest:
    - `Pursuing automatically header lists today's automatic SIM requests with Stop buttons`.
    - `Stop SIM request confirms then POSTs to cim-release/stop`. Assert the confirm text "Stop the SIM request to <name>? No more emails will be sent." and a POST to `/api/admin/deal-hunter/triage/<id>/cim-release/stop` with the body shape the drawer's existing stop sends (read `onCimReleaseStop` callers).
    - `Stop buttons are hidden for viewers`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Refresh the inbox status after a stop.
- [ ] **Step 4: Run.** `node --test test/httpAutoPursue.test.js`, then `npx vitest run test-ui/AcquisitionInbox.test.jsx`: PASS. Then `npm run lint`.
- [ ] **Step 5: Commit** `feat: stop today's automatic SIM requests from the inbox`.

### Task 3: Cadence v3 (business-day follow-ups)

Spec §2.

**Files:**
- Modify: `server/services/cimCampaignPolicy.js`:
  - add `CIM_CADENCE_POLICY_VERSION_V2 = 'deal-hunter-cim-cadence-v2'`, `CIM_CADENCE_POLICY_VERSION_V3 = 'deal-hunter-cim-cadence-v3'` and `SUPPORTED_CIM_CADENCE_POLICY_VERSIONS`;
  - `CIM_CADENCE_POLICY_VERSION` becomes v3, meaning "stamped on new acceptances".
- Modify: `server/services/pursueCimCadence.js` (dispatch on the campaign's stamped version)
- Modify: `server/storage/pursueCimSqliteTransitions.js` (literals near lines 1307, 2059, 2085, 2957, 3021: accept both versions)
- Create: `supabase/migrations/20261102140000_pursue_cim_cadence_v3.sql` (replace `pursue_cim_validate_accepted_cadence_v1` with a v3 branch, and accept both versions in every function that compares the cadence literal; `grep -n "cadence-v2" supabase/migrations/*.sql` lists them)
- Modify: `supabase/schema.sql`
- Test: `test/pursueCimAutopilotPolicy.test.js`, `test/pursueCimCadenceProjection.test.js`, `test/pursueCimAutopilotPostgres.test.js` (gated)

**Interfaces:**
- Produces:
  - `calculateNextCimSlot({ policyVersion, cadencePolicyVersion, timezone, kind, readyAt, priorAcceptedAt, priorOutcome, expiryAt, sendTime })`.
  - `cadencePolicyVersion` is required when `kind !== 'initial'`. Any value not in `SUPPORTED_CIM_CADENCE_POLICY_VERSIONS` throws `Unknown CIM cadence policy.`.
  - The returned slot's `cadencePolicyVersion` echoes the version used.
- Produces: `calculateCampaignExpiry(...)` stamps `cadencePolicyVersion: CIM_CADENCE_POLICY_VERSION`, now v3.
- v3 rule: every follow-up is due at the accepted local date + 2 Mon–Fri days, at `sendTime`. The `weekday-follow-up` slot key is `business:YYYY-MM-DD`.

- [ ] **Step 1: Failing tests** in `test/pursueCimAutopilotPolicy.test.js`, all in America/Los_Angeles unless stated:
  - `v3 follow-up-2 accepted Thursday 2026-11-05 10:00 is due Monday 2026-11-09 08:00`
  - `v3 weekday-follow-up accepted Friday 2026-11-06 09:00 is due Tuesday 2026-11-10 08:00 with slot key business:2026-11-10`
  - `v3 uses local date for late-Friday acceptance (2026-11-06T23:30 local) → Tuesday 2026-11-10 08:00`
  - `v3 never schedules Saturday or Sunday across a full 28-day sequence`. Loop from initial acceptance Monday 2026-11-02 09:00, feeding each due time back as the accepted time until null. Assert every `dueLocal` weekday is Mon–Fri, and the count is 9 or 10 (the exact number the loop produces gets asserted after one manual check).
  - `v3 spring-forward in America/New_York keeps 08:00 local`: acceptance Thursday 2027-03-11.
  - `v3 in America/Phoenix has no DST shift`.
  - `v3 returns null at or after expiry`.
  - `v2-stamped campaign keeps v2 calendar-day dates and calendar: slot keys`.
  - `unknown cadencePolicyVersion throws`.
  - `missing cadencePolicyVersion for a follow-up throws`.

  In `test/pursueCimCadenceProjection.test.js`:
  - `derivation dispatches on the campaign expiry_derivation cadence version`
  - `new acceptance stamps deal-hunter-cim-cadence-v3`
- [ ] **Step 2: Run, expect FAIL.** `node --test test/pursueCimAutopilotPolicy.test.js test/pursueCimCadenceProjection.test.js`
- [ ] **Step 3: Implement JS.** Reuse the existing business-day loop inside `scheduledFollowUpInstant` for all v3 ordinals. Replace the hard-coded cadence literals in SQLite transitions with `SUPPORTED_CIM_CADENCE_POLICY_VERSIONS.includes(...)`.
- [ ] **Step 4: Implement SQL.** Write the migration, branching on the stamped version and using the same `isodow between 1 and 5` loop for v3. Mirror byte-identically into `schema.sql`. In the gated Postgres test, add `v3 accepted cadence validates in Postgres for the Thursday→Monday case`.
- [ ] **Step 5: Run all cadence consumers.** Run:
  ```
  node --test test/pursueCimAutopilotPolicy.test.js test/pursueCimCadenceProjection.test.js test/pursueCimFollowUpPreparation.test.js test/pursueCimAutopilotStorage.test.js test/pursueCimAutopilotService.test.js test/pursueCimControlledMailboxHarness.test.js
  ```
  Expect PASS. The harness test needs a clean git tree, so commit first if it complains. Then `npm test`: 0 failures. Existing v2 fixtures must keep passing. Where a test asserted a weekend v2 date for a *new* acceptance, it must now stamp v2 explicitly or expect v3. State which in the report.
- [ ] **Step 6: Commit** `feat: business-day follow-up cadence v3`.

### Task 4: Timezone from state, and the owner picker

Spec §3.

**Files:**
- Modify: `server/services/dealCriteriaProfile.js`: export `stateNameCodes` (frozen) and a `targetStatesIn(text): string[]` helper used by both modules. Criteria behavior must not change.
- Modify: `server/services/opportunityTimezone.js`:
  - `resolveLocationTimezone({ state, location })`;
  - `TIMEZONE_RESOLVER_VERSION = 'target-state-v1'`;
  - `TARGET_STATE_TIMEZONES` (frozen: NY/NJ/CT → America/New_York, CA/NV → America/Los_Angeles, AZ → America/Phoenix);
  - `TIMEZONE_EXCEPTIONS` (NV: west wendover, jackpot; AZ: navajo, window rock, tuba city, kayenta, chinle);
  - `TIMEZONE_DATASET_DIGEST` = sha256 hex of `JSON.stringify({ zones: TARGET_STATE_TIMEZONES, exceptions: TIMEZONE_EXCEPTIONS })`.
- Modify: `server/services/opportunityTimezoneRevision.js`: add `appendDerivedOpportunityTimezoneRevision({ storage, opportunityId, state, location, now })`, returning `{ written: boolean, reason: string }`.
- Modify: `server/services/pursueCimEnrollment.js`: call the writer before reading enrollment authority. Read `state`/`location` from the opportunity's current score row via the existing storage read used for criteria; add a narrow read if none exists. Swallow and log writer errors.
- Modify: `src/components/admin/OpportunityDrawer.jsx` (`CimReleaseCard`: timezone picker)
- Test: `test/pursueCimAutopilotPolicy.test.js` (resolver), `test/pursueCimTimezoneCommand.test.js` (writer), `test/pursueCimAutopilotService.test.js` (enrollment), `test-ui/OpportunityDrawer.test.jsx`

**Interfaces:**
- `resolveLocationTimezone` returns `{ eligible: true, ianaTimezone, state, resolverVersion: 'target-state-v1' }`, or `{ eligible: false, reasonCode: 'timezone_ambiguous' | 'timezone_missing', resolverVersion: 'target-state-v1' }`.
- `resolveOpportunityTimezone` keeps its signature. Its `location` input now goes through the real resolver, so update the existing `{state:'CA'}` → `timezone_ambiguous` test to expect a derived America/Los_Angeles result.
- The writer appends `state='derived'`, `evidence_type='target-state'`, `evidence_id='target-state:<CODE>'` and `actor='system-timezone-resolver'` through the existing `storage.appendOpportunityTimezoneRevision`. Check the Supabase RPC for an evidence-type allowlist (`grep -n "evidenceType" supabase/migrations/2026092912*.sql supabase/migrations/20260925120000_pursue_cim_autopilot.sql`). If one exists, add `target-state` in a new migration, mirrored in `schema.sql`.

- [ ] **Step 1: Failing tests.**
  - Resolver:
    - six states by code;
    - six by full name, including `"  new   york "`;
    - state only in location text (`"Scottsdale, Arizona"`);
    - disagreement (`state:'CA'`, location `"Reno, NV"` → Pacific both, but still `timezone_ambiguous` because the states differ);
    - `"West Wendover, NV"` → ambiguous;
    - `"Window Rock, AZ"` → ambiguous;
    - `state:'TX'` → missing;
    - empty → missing.
  - Writer:
    - writes a derived row with the exact fields;
    - `no-op when latest revision is verified`;
    - `no-op when latest is derived`;
    - `no-op on identical evidence digest`;
    - `stale revision conflict re-reads once then returns written:false`.
  - Enrollment:
    - `pursue of an AZ deal with no timezone revision enrolls with derived America/Phoenix`;
    - `pursue of a West Wendover deal reports timezone_ambiguous`.
  - Vitest:
    - `timezone picker shows only when timezone authority is missing or ambiguous`;
    - `picker confirms then POSTs operator-verified body`. Assert `evidenceType:'operator-verified'`, `evidenceId:'owner-drawer'`, `expectedPriorRevision`, and a UUID `idempotencyKey`;
    - `409 shows Timezone changed elsewhere — reload and try again.`;
    - `picker hidden in read-only mode`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.**
  - `node --test test/pursueCimAutopilotPolicy.test.js test/pursueCimTimezoneCommand.test.js test/pursueCimAutopilotService.test.js test/dealCriteriaProfile.test.js test/autoPursue.test.js`, then `npx vitest run test-ui/OpportunityDrawer.test.jsx`: PASS.
  - Then `npm test` and `npm run lint`.
- [ ] **Step 5: Commit** `feat: derive send timezone from target state and let the owner set it`.

### Task 5: One email system per deal (legacy guard)

Spec §4.

**Files:**
- Create: `server/services/pursueOwnership.js` exporting `async function readPursueOwnership({ storage, opportunityId }): Promise<{ owned: boolean, reason: 'pursue_owns_opportunity' | 'pursue_authority_unavailable' | null }>`.
  - `owned` is true when `projection.decision?.action === 'pursue'`, or `projection.enrollment` is non-null, or `projection.campaign` is non-null in any state.
  - A throw or non-object projection returns `{ owned: true, reason: 'pursue_authority_unavailable' }`.
  - Verify the decision object's action field name against `readPursueCimProjection` in `pursueCimSqliteTransitions.js:359` and the Supabase RPC.
- Modify: `server/services/dealHunter.js`:
  - `sendCimRequestForScoredDeal` (~9577): re-check after `claimDealHunterCimOpportunity` succeeds and before any provider call. On `owned`, release or abandon the claim exactly as the nearest existing post-claim refusal does, and throw or return that path's refusal shape with `code` = reason and `status` 409.
  - `executeDealHunterCimFollowUpRequest` (~7287): check before send.
  - `runDealHunterCimFollowUps` (~11115): mark skipped with that reason.
  - `runCimStage2Automation` (~9234): skip claimed candidates with that reason in run items.
- Modify: `server/app.js`: map the refusal codes to HTTP 409 `{ error: 'This deal is in a SIM request campaign — manage it from the drawer.', code }` on the legacy routes (`cim-request`, `cim-requests/send-ready` per-item results, `cim-requests/:id/retry`, broker-materials `approve`, the manual follow-up `approve`).
- Modify: the admin UI components that render those routes' errors (`DealHunterWorkspace.jsx`, broker-materials card, follow-ups) only if they don't already show `error` text verbatim.
- Test: create `test/pursueOwnershipGuard.test.js`; extend `test/cimStage2Compliance.test.js` or the Stage 2 runner test.

- [ ] **Step 1: Failing tests** in `test/pursueOwnershipGuard.test.js`, using the existing legacy-send test fixtures and a fake provider that counts calls (find the pattern with `grep -ln "sendCimRequestForScoredDeal\|sendDealHunterCimRequest" test/`):
  - `readPursueOwnership: pursue decision, enrollment, ended campaign → owned; watch decision only → not owned; throw → pursue_authority_unavailable`
  - `legacy owner send refuses a pursued deal with 409 pursue_owns_opportunity and zero provider calls`
  - `legacy owner send proceeds for an unpursued deal`
  - `legacy follow-up runner skips a pursued deal with reason pursue_owns_opportunity`
  - `Stage 2 skips a pursued candidate`
  - `race: Pursue decision recorded after legacy pre-checks but before claim is caught by the post-claim re-check`. Inject the decision from a storage hook on `claimDealHunterCimOpportunity`, then assert zero provider calls and the legacy claim released.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.**
  - `node --test test/pursueOwnershipGuard.test.js test/cimStage2Compliance.test.js test/cimStage2Storage.test.js`, plus any legacy send/follow-up tests found in Step 1, then `npm test` and `npm run lint`.
  - If UI changed, run `npx vitest run test-ui/DealHunterWorkspace.test.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/BrokerMaterialsFollowUps.test.jsx`.
- [ ] **Step 5: Commit** `feat: keep legacy outreach off deals in a SIM request campaign`.

### Task 6: Daily Sheet sync, then automatic Pursue

Spec §5.

**Files:**
- Modify: `server/config.js`: `dealHunter.sheetSync = { enabled: env DEAL_HUNTER_SHEET_SYNC_ENABLED === 'true', runAt: '07:30', timezone: 'America/Los_Angeles', retryIntervalMs: 1800000, retryUntil: '12:00', checkIntervalMs: 60000 }`.
- Create: `server/services/dealHunterSheetSync.js` exporting `runDealHunterSheetSync({ storage, now, triggeredBy, refresh = refreshOpportunityScores, autoPursue = runAutoPursue })`. It returns `{ ok, sheets, scoredCount, groupCounts, requiredSourcesHealthy, autoPursue }`.
  - `sheets` comes from the refresh result's review sources where `sourceId` starts with `sheet-`: `{ sourceId, fetched, rowCount, error: String(error).slice(0, 300) | null, durationMs }`. If the source object carries no duration, time the refresh call as a whole and record it once as `durationMs` on the result rather than per sheet. Note this in the report.
  - `groupCounts` comes from the stored score rows after refresh, counted by `criteria_group`.
- Modify: `server/services/dealHunterScheduler.js`: `startDealHunterSheetSyncScheduler({ storage, config, now = () => new Date(), setTimer, clearTimer, run = runDealHunterSheetSync })`, modeled on `startDealHunterDailyEmailScheduler` (line 524) and its claim/transition/complete use of `scheduled_job_runs`.
  - Weekdays only, in the configured zone.
  - First attempt at or after `runAt`.
  - A failed run is retried after `retryIntervalMs` while before `retryUntil`.
  - A completed date never re-runs.
  - Returns `{ stop }`.
- Modify: `server/index.js`: register it.
- Modify: `server/services/operations.js`: make sure `sanitizeScheduledJob` passes the sheet-sync metadata through (sheets, groupCounts, autoPursue). If it already passes metadata generically, only add a test.
- Test: `test/dealHunterScheduler.test.js`, create `test/dealHunterSheetSync.test.js`, `test/operations.test.js`

**Interfaces:**
- Consumes:
  - `refreshOpportunityScores` result `currentFingerprints` (Task 1);
  - `runAutoPursue({ ..., currentFingerprints })` (Task 1).

- [ ] **Step 1: Failing tests.**
  - `test/dealHunterSheetSync.test.js`, with injected `refresh` and `autoPursue` fakes:
    - `healthy sync calls autoPursue once with currentFingerprints and triggeredBy sheet-sync`
    - `unhealthy required sheet records autoPursue skipped required_source_failed and ok false`
    - `scoringDeferred refresh records ok false`
    - `autoPursue throw is recorded and sync stays ok`
    - `sheet error text is capped at 300 chars`
  - `test/dealHunterScheduler.test.js`, with a fake clock and fake timers:
    - `sheet sync does not run before 07:30 PT`
    - `runs at 07:30 PT on a weekday`
    - `does not run on Saturday`
    - `does not run twice on the same date, including after scheduler restart`
    - `failed run retries after 30 minutes and stops after 12:00 PT`
    - `retry success after failure calls autoPursue exactly once that day`
    - `disabled flag starts no timer`
  - `test/operations.test.js`: `job history shows deal-hunter-sheet-sync metadata`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `node --test test/dealHunterSheetSync.test.js test/dealHunterScheduler.test.js test/operations.test.js`: PASS. Then `npm test` and `npm run lint`.
- [ ] **Step 5: Commit** `feat: logged daily Sheet sync that triggers automatic Pursue`.

---

## Final verification (controller, after Task 6)

`npm test`, `npx vitest run`, `npm run lint`, `npm run build`, the gated Postgres suites (if env available), and `PLAYWRIGHT_PORT=4273 npm run test:browser`. Then the whole-branch review.
