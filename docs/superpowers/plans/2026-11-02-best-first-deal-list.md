# Best-First Deal List and Automatic Pursue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank the Acquisition Inbox by the owner's must-have criteria and let 90+ deals that meet them be Pursued automatically through the existing Pursue → CIM campaign path.

**Architecture:** A pure criteria module classifies each deal at score time; the group is stored on the score row and read by the fresh-inbox policy to build four new inbox areas. A new auto-Pursue service records the existing `pursue` owner command (with its own actor and policy version) for eligible `auto` deals under a separately activated, capped, warm-up-gated capability. Nothing crosses the provider boundary except through the unchanged campaign final gate.

**Tech Stack:** Node 22 ES modules, Express 4, better-sqlite3 and Supabase (SQL migrations + RPC), React 18 + Vite, `node --test`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-best-first-deal-list-design.md`

## Global Constraints

- Branch `codex/best-first-deal-list` from `origin/main` `f22738d`; every command runs under Node 22.
- Criteria profile version `uckele-criteria-v1`. Profit 300,000–750,000 inclusive; multiple > 0 and ≤ 4.0; states NY, CA, NJ, AZ, NV, CT; review floor 75; automatic floor 90 (code-enforced minimum).
- Trusted industry terms are imported from `server/services/cimAutomation.js` (export the existing `trustedIndustryTerms`, `trustedTargetStates`, `genericMailboxNames` and `containsTrustedIndustryTerm`); do not duplicate the lists.
- Auto-Pursue actor `automation-auto-pursue`; decision policy version `auto-pursue-v1`; owner clicks keep `owner-decision-v1`. The HTTP owner-command route never accepts a policy version from the client.
- Auto-Pursue modes `off | shadow | canary | active`; canary cap 1, active default 3, maximum 10, per owner business date (`ownerBusinessDate` in `dealHunterFreshInboxPolicy.js`).
- Typed confirmations: `SET AUTO PURSUE OFF`, `ACTIVATE AUTO PURSUE SHADOW`, `ACTIVATE AUTO PURSUE CANARY`, `ACTIVATE AUTO PURSUE ACTIVE`.
- Warm-up: ≥ 25 owner decisions (pursue or pass, `owner-decision-v1`), ≥ 10 of them on `auto`-group opportunities, ≥ 95% of those `auto` decisions are pursue with the recipient unchanged.
- Ships with auto-Pursue `off`. No production score refresh, migration apply, activation, deployment, unpause, or provider call is part of this plan.
- No change to: the fit score or its 506-case corpus, campaign cadence, final gate, broker-materials authority, legacy Stage 2 behavior, or the daily digest job (which must never call the auto-Pursue runner).
- UI label for the `pursue` action is **Request SIM**; internal names stay `pursue`/`cim`.
- Every new SQLite table/column is additive (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`) and mirrored by one Supabase migration `supabase/migrations/20261102120000_best_first_deal_list.sql`.

## Review Focus

- **Spelled-out states:** “Phoenix, Arizona” or “New York, NY Metro” must pass geography; a full state name maps to its code. Test in Task 1.
- **Implied multiple:** profit and asking price present but `profitMultiple` missing must compute asking ÷ profit rather than report unknown. Test in Task 1.
- **Owner and runner race:** the owner clicks Request SIM on a deal while the runner is processing it; exactly one Pursue decision results and neither path errors. Test in Task 5.
- **Cap across reruns:** two runs on the same owner business date (including a crash after the first command) never exceed the cap and never duplicate a command. Test in Task 5.
- **Stale criteria after a profile change:** rows with an old `criteria_profile_version` never reach the `auto-pursue` area and show “criteria out of date”. Test in Task 3.

---

### Task 1: Criteria profile module

**Files:**
- Create: `server/services/dealCriteriaProfile.js`
- Modify: `server/services/cimAutomation.js` (export existing `trustedIndustryTerms`, `trustedTargetStates`, `genericMailboxNames`, `containsTrustedIndustryTerm`; no behavior change)
- Test: `test/dealCriteriaProfile.test.js`

**Interfaces:**
- Produces:
  - `DEAL_CRITERIA_PROFILE_VERSION = 'uckele-criteria-v1'`
  - `getDealCriteriaProfile(config = getConfig()) -> { version, minimumAnnualProfit, maximumAnnualProfit, maximumProfitMultiple, targetStates, trustedIndustryTerms, reviewFloor, automaticFloor }` (`automaticFloor` is `Math.max(90, configured)`)
  - `evaluateDealCriteria(deal, { profile } = {}) -> { profileVersion, group: 'below-review'|'near-miss'|'needs-info'|'auto'|'review', mustHaves: [{ id: 'profit'|'multiple'|'geography'|'industry'|'gates', outcome: 'pass'|'fail'|'unknown', observed }], failed: string[], unknown: string[] }`
  - Input fields read: `fitScore` (falls back to `score`), `annualProfit`, `profitMultiple`, `askingPrice`, `location`, `state`, `name`, `industry`, `gates` (array; non-empty means fail).

- [ ] **Step 1: Write the failing tests**

```js
test('profit band edges', () => {
  for (const [profit, outcome] of [[299999, 'fail'], [300000, 'pass'], [750000, 'pass'], [750001, 'fail'], [null, 'unknown'], ['n/a', 'unknown']]) {
    assert.equal(mustHave(evaluateDealCriteria(deal({ annualProfit: profit })), 'profit'), outcome);
  }
});
test('multiple edges and implied multiple', () => {
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 4.0 })), 'multiple'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 4.01 })), 'multiple'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: 0 })), 'multiple'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: null, askingPrice: 1200000, annualProfit: 400000 })), 'multiple'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ profitMultiple: null, askingPrice: null })), 'multiple'), 'unknown');
});
test('geography tokens and full state names', () => {
  for (const [location, outcome] of [['Phoenix, AZ', 'pass'], ['Phoenix, Arizona', 'pass'], ['NYC Metro, NY', 'pass'], ['CAN', 'fail'], ['Austin, TX', 'fail'], ['', 'unknown']]) {
    assert.equal(mustHave(evaluateDealCriteria(deal({ location, state: '' })), 'geography'), outcome, location);
  }
});
test('industry and gates', () => {
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: 'Commercial HVAC' })), 'industry'), 'pass');
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: 'Restaurant', name: 'Taco Spot' })), 'industry'), 'fail');
  assert.equal(mustHave(evaluateDealCriteria(deal({ industry: '', name: '' })), 'industry'), 'unknown');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, gates: [{ ruleId: 'gate.franchise' }] })).group, 'near-miss');
});
test('group precedence', () => {
  assert.equal(evaluateDealCriteria(deal({ fitScore: 74 })).group, 'below-review');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, annualProfit: 900000 })).group, 'near-miss');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 95, annualProfit: null })).group, 'needs-info');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 90 })).group, 'auto');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 89 })).group, 'review');
  assert.equal(evaluateDealCriteria(deal({ fitScore: 75 })).group, 'review');
});
test('automatic floor cannot be configured below 90', () => {
  assert.equal(getDealCriteriaProfile({ dealHunter: { criteria: { automaticFloor: 80 } } }).automaticFloor, 90);
});
```

`deal(overrides)` builds a passing baseline (`fitScore: 92, annualProfit: 450000, profitMultiple: 3.2, location: 'Phoenix, AZ', industry: 'HVAC service', gates: []`); `mustHave(result, id)` returns that entry's outcome.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/dealCriteriaProfile.test.js`
Expected: FAIL, cannot find module `dealCriteriaProfile.js`.

- [ ] **Step 3: Implement the module**

State names map through a fixed table `{ 'NEW YORK': 'NY', CALIFORNIA: 'CA', 'NEW JERSEY': 'NJ', ARIZONA: 'AZ', NEVADA: 'NV', CONNECTICUT: 'CT' }` before the existing token regex; geography reads `location`, then `state`. Numbers go through `Number()` and must be finite to count as present.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/dealCriteriaProfile.test.js test/cimAutomation.test.js`
Expected: PASS (Stage 2 tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/services/dealCriteriaProfile.js server/services/cimAutomation.js test/dealCriteriaProfile.test.js
git commit -m "feat: add owner criteria profile for deal ranking"
```

### Task 2: Store the criteria group at score time

**Files:**
- Modify: `server/services/dealHunterScoreStore.js` (`machineScoreRow` ~line 128, `storedScoreIsCurrent` ~line 110)
- Modify: `server/storage/sqlite.js` (`ensureColumn` block near line 5776)
- Modify: `server/storage/supabase.js` (`writeDealHunterOpportunityScore` ~line 3721 field allowlist, if any)
- Create: `supabase/migrations/20261102120000_best_first_deal_list.sql`
- Test: `test/dealHunterScoreRefresh.test.js`, `test/dealHunterScoringDimensions.test.js` (run only)

**Interfaces:**
- Consumes: `evaluateDealCriteria`, `DEAL_CRITERIA_PROFILE_VERSION` (Task 1).
- Produces: score-row columns `criteria_profile_version TEXT`, `criteria_group TEXT`, `criteria_result TEXT` (JSON `{ mustHaves, failed, unknown }`), written only by the machine score write.

- [ ] **Step 1: Write the failing tests** in `test/dealHunterScoreRefresh.test.js`

```js
test('refresh stores the criteria group and result', async () => {
  // seed one resolved deal with fitScore 92 and passing must-haves, run refreshOpportunityScores
  const row = await storage.getDealHunterOpportunityScore(opportunityId);
  assert.equal(row.criteria_profile_version, 'uckele-criteria-v1');
  assert.equal(row.criteria_group, 'auto');
  assert.deepEqual(JSON.parse(row.criteria_result).failed, []);
});
test('a stale criteria profile version forces a rewrite', async () => {
  // after a refresh, set criteria_profile_version = 'uckele-criteria-v0' directly, refresh again without force
  assert.equal(result.counts.skipped, 0);
  assert.equal((await storage.getDealHunterOpportunityScore(opportunityId)).criteria_profile_version, 'uckele-criteria-v1');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/dealHunterScoreRefresh.test.js`
Expected: FAIL, `criteria_profile_version` undefined.

- [ ] **Step 3: Implement**

Add the three `ensureColumn` calls; in `machineScoreRow` call `evaluateDealCriteria({ ...deal, fitScore: result.fitScore, gates: result.gates })` and write the three fields; add the version equality to `storedScoreIsCurrent`. Migration adds the same three nullable columns to `deal_hunter_opportunity_scores`. If Supabase writes scores through an RPC or explicit column list, extend it in the same migration.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/dealHunterScoreRefresh.test.js test/dealHunterScoreStorage.test.js test/dealHunterScoringDimensions.test.js`
Expected: PASS; the corpus test still reports 506 cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/services/dealHunterScoreStore.js server/storage/sqlite.js server/storage/supabase.js supabase/migrations/20261102120000_best_first_deal_list.sql test/dealHunterScoreRefresh.test.js
git commit -m "feat: persist criteria group with each opportunity score"
```

### Task 3: Criteria areas in the fresh inbox

**Files:**
- Modify: `server/services/dealHunterFreshInboxPolicy.js` (`freshInboxAreaIds`, `buildFreshInboxAreas`)
- Modify: `server/storage/sqlite.js` (`listDealHunterFreshInbox` SELECT ~line 11218) and `server/storage/supabase.js` (`listDealHunterFreshInbox` ~line 3962, plus RPC in the Task 2 migration if candidates come from SQL)
- Modify: `server/services/dealHunterTriage.js` (`publicTriageRow`: add `criteriaGroup`, `criteriaResult`, `criteriaCurrent`, `autoPursueBlocker`)
- Test: `test/dealHunterTriage.test.js`

**Interfaces:**
- Consumes: score columns from Task 2; `auto_pursue_blocker TEXT`, `auto_pursue_checked_at TEXT` score columns (added in this task's `ensureColumn` block and migration; written only by Task 5).
- Produces: areas `auto-pursue`, `your-review`, `needs-info`, `near-miss` in `freshInboxAreaIds`; default `inbox` requests `['action-preview', 'auto-pursue', 'your-review', 'needs-info', 'near-miss']` (replacing `new-important`, which stays available as its own area). Placement rules:
  - `auto-pursue`: `criteria_group === 'auto'`, current profile version, no `auto_pursue_blocker`;
  - `your-review`: `criteria_group === 'review'`, or `auto` with a blocker, or any 75+ row whose `criteria_profile_version` is not current;
  - `needs-info` / `near-miss`: matching group, fit score ≥ 75.
  - Each area sorts with the existing `compareDiscovery`. Rows already excluded by the inbox's decision filters stay excluded.

- [ ] **Step 1: Write the failing tests**

```js
test('default inbox returns the criteria areas in order', () => {
  const result = buildFreshInboxAreas(rows, { area: 'inbox', asOf });
  assert.deepEqual(result.areas.map((a) => a.id), ['action-preview', 'auto-pursue', 'your-review', 'needs-info', 'near-miss']);
});
test('blocked auto rows and stale-version rows go to your-review', () => {
  const result = buildFreshInboxAreas([
    row({ id: 'a', criteria_group: 'auto' }),
    row({ id: 'b', criteria_group: 'auto', auto_pursue_blocker: 'generic_mailbox' }),
    row({ id: 'c', criteria_group: 'auto', criteria_profile_version: 'uckele-criteria-v0' }),
  ], { area: 'inbox', asOf });
  assert.deepEqual(ids(result, 'auto-pursue'), ['a']);
  assert.deepEqual(ids(result, 'your-review').sort(), ['b', 'c']);
});
test('below-review rows appear in no criteria area', () => {
  const result = buildFreshInboxAreas([row({ id: 'd', fit_score: 70, criteria_group: 'below-review' })], { area: 'inbox', asOf });
  for (const id of ['auto-pursue', 'your-review', 'needs-info', 'near-miss']) assert.deepEqual(ids(result, id), []);
});
test('storage inbox rows carry criteria columns', async () => {
  // seed via refreshOpportunityScores, then listDealHunterFreshInbox({ area: 'your-review' })
  assert.ok(page.areas[0].rows.every((r) => 'criteria_group' in r));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/dealHunterTriage.test.js`
Expected: FAIL, unknown area `auto-pursue`.

- [ ] **Step 3: Implement** the area sets, the SELECT additions (`scores.criteria_profile_version, scores.criteria_group, scores.criteria_result, scores.auto_pursue_blocker`), the two blocker columns, and the `publicTriageRow` fields (`criteriaCurrent` is `criteria_profile_version === DEAL_CRITERIA_PROFILE_VERSION`).

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/dealHunterTriage.test.js test/dealHunterFreshInboxPerf.test.js test/httpDealHunterCurrentTriage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/dealHunterFreshInboxPolicy.js server/services/dealHunterTriage.js server/storage/sqlite.js server/storage/supabase.js supabase/migrations/20261102120000_best_first_deal_list.sql test/dealHunterTriage.test.js
git commit -m "feat: group the acquisition inbox by owner criteria"
```

### Task 4: Decision policy version and warm-up evidence

**Files:**
- Modify: `server/services/dealHunterTriage.js` (`recordAcquisitionOwnerCommand`, line 1137)
- Modify: `server/storage/sqlite.js`, `server/storage/supabase.js` (new table + `insertAutoPursueDecisionEvidence`, `listAutoPursueDecisionEvidence`)
- Modify: `supabase/migrations/20261102120000_best_first_deal_list.sql`
- Test: `test/httpDealHunterTriageActions.test.js`, `test/autoPursueEvidence.test.js`

**Interfaces:**
- Produces:
  - `recordAcquisitionOwnerCommand({ ..., decisionPolicyVersion = 'owner-decision-v1' })`: accepts only `'owner-decision-v1'` or `'auto-pursue-v1'`, else 400; passes it as `policyVersion` to `storage.recordOwnerDecision`.
  - Table `deal_hunter_auto_pursue_decision_evidence(decision_event_id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('pursue','pass')), policy_version TEXT NOT NULL, criteria_group TEXT, criteria_profile_version TEXT, recipient_unchanged INTEGER NOT NULL, created_at TEXT NOT NULL)`.
  - `storage.insertAutoPursueDecisionEvidence(row)` (idempotent on `decision_event_id`) and `storage.listAutoPursueDecisionEvidence({ policyVersion }) -> row[]`.
- After a non-replay `pursue` or `pass` success, write one evidence row from the current score row's `criteria_group`/`criteria_profile_version`. `recipient_unchanged` is true when no `recipientContactRef` was given, or when the ref resolves (via `loadBrokerMaterialsAuthority` + `resolveBrokerMaterialsRecipientContactRef`) to the option with the same `provenanceFingerprint` as `recipientOptions[0]` and there is exactly one option. An evidence write failure is logged with `console.warn('[auto-pursue:evidence] ...')` and does not fail the command.

- [ ] **Step 1: Write the failing tests**

```js
test('owner route always records owner-decision-v1', async () => {
  // POST /api/admin/deal-hunter/triage/:id/action with body { action: 'pursue', decisionPolicyVersion: 'auto-pursue-v1', ... }
  assert.equal(lastDecisionEvent().policy_version, 'owner-decision-v1');
});
test('unknown decision policy version is rejected', async () => {
  const result = await recordAcquisitionOwnerCommand({ ...validPursue, decisionPolicyVersion: 'x' });
  assert.equal(result.status, 400);
});
test('pursue and pass write warm-up evidence with the criteria group', async () => {
  await recordAcquisitionOwnerCommand({ ...validPursue });
  const [evidence] = await storage.listAutoPursueDecisionEvidence({ policyVersion: 'owner-decision-v1' });
  assert.equal(evidence.criteria_group, 'auto');
  assert.equal(evidence.recipient_unchanged, 1);
});
test('replayed command writes no second evidence row', async () => { /* same idempotencyKey twice -> length 1 */ });
test('watch writes no evidence', async () => { /* action watch -> length 0 */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/autoPursueEvidence.test.js test/httpDealHunterTriageActions.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** Confirm the HTTP route for `/triage/:opportunityId/action` does not forward `decisionPolicyVersion`. Confirm `pursue_cim_record_owner_decision_v1` (latest in `20261008120000_pursue_cim_terminal_writer_convergence.sql`) stores `p_command.policyVersion` without restricting it to `owner-decision-v1`; if it restricts it, replace the function in the Task 2 migration to also allow `auto-pursue-v1`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/autoPursueEvidence.test.js test/httpDealHunterTriageActions.test.js test/dealHunterTriage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/dealHunterTriage.js server/storage/sqlite.js server/storage/supabase.js supabase/migrations/20261102120000_best_first_deal_list.sql test/autoPursueEvidence.test.js test/httpDealHunterTriageActions.test.js
git commit -m "feat: record decision policy and warm-up evidence for owner commands"
```

### Task 5: Auto-Pursue service

**Files:**
- Create: `server/services/autoPursue.js`
- Modify: `server/storage/sqlite.js`, `server/storage/supabase.js`, `supabase/migrations/20261102120000_best_first_deal_list.sql`, `server/config.js` (`dealHunter.autoPursue.activeDailyCap`, default 3)
- Test: `test/autoPursue.test.js`

**Interfaces:**
- Consumes: Task 3 area `auto-pursue` via `storage.listDealHunterFreshInbox`; Task 4 `recordAcquisitionOwnerCommand({ decisionPolicyVersion: 'auto-pursue-v1' })` and `listAutoPursueDecisionEvidence`; `loadBrokerMaterialsAuthority`; `genericMailboxNames`; `ownerBusinessDate`.
- Produces:
  - Tables `deal_hunter_auto_pursue_activations(id PK, mode CHECK IN ('off','shadow','canary','active'), daily_cap INTEGER NOT NULL, actor, reason, confirmation, status CHECK IN ('current','superseded'), created_at, superseded_at)` and `deal_hunter_auto_pursue_runs(id PK, run_key UNIQUE, business_date, mode, status, commands INTEGER, items TEXT JSON, created_at, completed_at)`; storage methods `getCurrentAutoPursueActivation`, `createAutoPursueActivation` (supersedes current atomically), `claimAutoPursueRun`, `completeAutoPursueRun`, `listAutoPursueRuns({ businessDate })`, `setDealHunterAutoPursueBlockers([{ opportunityId, blocker, checkedAt }])`.
  - `AUTO_PURSUE_CONFIRMATIONS` (values in Global Constraints).
  - `getAutoPursueWarmup({ storage }) -> { totalDecisions, autoDecisions, autoUnchangedRate, ready }`.
  - `getAutoPursueStatus({ storage, now }) -> { mode, dailyCap, todayCommands, warmup, latestRun }`.
  - `setAutoPursueMode({ mode, dailyCap, reason, confirmation, actor, storage }) -> { ok, status, activation }`: 400 on wrong confirmation; 409 for `canary`/`active` while `warmup.ready` is false; `dailyCap` forced to 1 for canary and clamped 1–10 for active.
  - `runAutoPursue({ storage, now, triggeredBy }) -> { ok, mode, businessDate, commands, skipped: [{ opportunityId, reason }], duplicateInvocation }`.
- Run behavior, in order: claim run key `auto-pursue:${businessDate}:${mode}:${sequence}` where `sequence` is the count of completed runs that day (so reruns are allowed but each opportunity's command is deterministic); list `auto-pursue` rows; for each compute blockers (§6.3 of the spec) and write them with `setDealHunterAutoPursueBlockers` in every mode, including `off`; in `off`/`shadow` record no commands; in `canary`/`active` record `pursue` for unblocked rows in area order until `dailyCap - commandsAlreadyRecordedToday` is reached. Commands use actor `automation-auto-pursue`, the single option's `recipientContactRef`, the row's `discovery_revision`/`material_revision`, and an idempotency key derived from `sha256('auto-pursue:' + businessDate + ':' + opportunityId)` formatted as a version-8 UUID. A 409 conflict from the command (owner acted first) counts as skipped with reason `owner_decision_exists`, not an error.

- [ ] **Step 1: Write the failing tests**

```js
test('off and shadow record no commands but refresh blockers', async () => { /* commands 0; generic info@ row has blocker 'generic_mailbox' */ });
test('canary records at most one pursue per business date across reruns', async () => {
  await setMode('canary'); await runAutoPursue({ storage, now }); const second = await runAutoPursue({ storage, now });
  assert.equal(countAutoDecisions(), 1); assert.equal(second.commands, 0);
});
test('active respects the configured cap and the next business date resets it', async () => { /* cap 3 with 5 rows -> 3; next date -> 2 more */ });
test('crash after the first command does not duplicate it', async () => { /* run, delete run row, rerun same date -> still one decision event (replay) */ });
test('each blocker skips the row', async () => {
  // unresolved identity, zero or two recipient options, generic mailbox, prior CIM request, suppression, current Watch
});
test('owner Pursue during the run is reported as owner_decision_exists', async () => { /* owner decision first -> skipped reason */ });
test('canary is refused until warm-up is ready', async () => {
  assert.equal((await setAutoPursueMode({ mode: 'canary', confirmation: 'ACTIVATE AUTO PURSUE CANARY', ...rest })).status, 409);
});
test('warm-up thresholds', async () => {
  // 24 decisions -> not ready; 25 with 9 auto -> not ready; 25 with 10 auto and 1 recipient change (90%) -> not ready; 20/20 unchanged with 25 total -> ready
});
test('wrong confirmation is rejected', async () => { /* status 400 */ });
test('runner never calls the delivery provider', async () => { /* stub provider throws if called; run active */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/autoPursue.test.js`
Expected: FAIL, cannot find module `autoPursue.js`.

- [ ] **Step 3: Implement** the service and storage methods.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/autoPursue.test.js test/autoPursueEvidence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/autoPursue.js server/storage/sqlite.js server/storage/supabase.js server/config.js supabase/migrations/20261102120000_best_first_deal_list.sql test/autoPursue.test.js
git commit -m "feat: add capped, warm-up-gated automatic Pursue runner"
```

### Task 6: Auto-Pursue routes

**Files:**
- Modify: `server/app.js` (near the Stage 2 cron route ~line 1964 and admin Deal Hunter routes)
- Test: `test/httpAutoPursue.test.js`, `test/dailyDealHunterDigest.test.js` (boundary assertion)

**Interfaces:**
- Consumes: Task 5 `runAutoPursue`, `getAutoPursueStatus`, `setAutoPursueMode`.
- Produces:
  - `POST /api/deal-hunter/auto-pursue/run`: `requireDealHunterCron`; returns `{ success, mode, businessDate, commands, skipped, duplicateInvocation }`.
  - `GET /api/admin/deal-hunter/auto-pursue`: `requireAdmin`; returns `getAutoPursueStatus` (read-only admins allowed).
  - `POST /api/admin/deal-hunter/auto-pursue/mode`: `requireAdmin`, rejected for read-only sessions; body `{ mode, dailyCap, reason, confirmation }`; actor from the session.

- [ ] **Step 1: Write the failing tests**

```js
test('cron run requires the cron secret', async () => { /* no header -> 401 */ });
test('admin status is readable and mode change requires a writable admin', async () => { /* read-only POST -> 403 */ });
test('mode change passes confirmation through', async () => { /* wrong -> 400, right shadow -> 200 */ });
test('daily digest job never invokes the auto-Pursue runner', async () => { /* spy on runAutoPursue during the daily job -> 0 calls */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/httpAutoPursue.test.js`
Expected: FAIL, 404.

- [ ] **Step 3: Implement** the three routes, following the existing `asyncRoute` + status/`success` response shape.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/httpAutoPursue.test.js test/dailyDealHunterDigest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.js test/httpAutoPursue.test.js test/dailyDealHunterDigest.test.js
git commit -m "feat: expose automatic Pursue run, status, and mode routes"
```

### Task 7: Inbox UI

**Files:**
- Modify: `src/components/admin/AcquisitionInbox.jsx` (`ActionButtons` line 54, area labels ~line 1192, default inbox sections ~line 1199, view list ~line 1218)
- Test: `test-ui/AcquisitionInbox.test.jsx`; Create: `test-browser/acquisition-criteria-inbox.spec.js`

**Interfaces:**
- Consumes: Task 3 areas and row fields (`criteriaGroup`, `criteriaResult`, `criteriaCurrent`, `autoPursueBlocker`); Task 6 `GET /api/admin/deal-hunter/auto-pursue`.
- Produces, exact copy:
  - Area titles: `Pursuing automatically`, `Your review`, `Needs info`, `Near misses` (collapsed by default with a `Show near misses (N)` toggle).
  - Mode badge on `Pursuing automatically`: `Off — would Pursue`, `Shadow`, `Test`, `On`; with `N of CAP today` when canary or active.
  - Primary action label `Request SIM` (accessible name `Request SIM <context> <name>`); `Watch` and `Pass` unchanged.
  - Criteria line: `Profit $420K ✓ · 3.2× ✓ · AZ ✓ · HVAC ✓`; failed must-haves show the rule, e.g. `Multiple 5.1× (max 4×)`; unknown shows `Profit not disclosed`.
  - Blocked auto rows in Your review show `Not automatic: <reason>`, with reasons mapped from codes: `generic_mailbox` → `only a generic mailbox`, `recipient_not_single` → `no single verified broker`, `prior_outreach` → `this broker or deal was contacted before`, `identity_unresolved` → `identity needs review`, `suppressed` → `the broker opted out or bounced`, `criteria_out_of_date` → `criteria out of date`.
  - Near-miss Request SIM opens a confirm: `This deal misses <must-have>. Request the SIM anyway?` with `Request SIM` / `Cancel`.

- [ ] **Step 1: Write the failing tests** (Vitest)

```js
it('renders the four criteria areas in order with Request SIM', async () => { /* headings order; button name /Request SIM/ */ });
it('collapses near misses until toggled', async () => {});
it('shows the criteria line and the not-automatic reason', async () => {});
it('confirms before requesting on a near miss', async () => { /* cancel -> no POST; confirm -> POST action pursue */ });
it('shows the mode badge and today count', async () => { /* status { mode: 'canary', dailyCap: 1, todayCommands: 1 } -> 'Test' and '1 of 1 today' */ });
it('read-only users see no action buttons', async () => {});
```

Playwright: list → Request SIM on a Your review row → the existing Pursue outcome text appears, against the console delivery provider.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test-ui/AcquisitionInbox.test.jsx` (outside the Bash sandbox)
Expected: FAIL.

- [ ] **Step 3: Implement** the UI changes.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test-ui/AcquisitionInbox.test.jsx` then `npx playwright test test-browser/acquisition-criteria-inbox.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/AcquisitionInbox.jsx test-ui/AcquisitionInbox.test.jsx test-browser/acquisition-criteria-inbox.spec.js
git commit -m "feat: show criteria groups and Request SIM in the acquisition inbox"
```

### Task 8: Full verification

- [ ] **Step 1:** `git diff --check origin/main...HEAD` → no output.
- [ ] **Step 2:** `npm run check` under Node 22 (UI suite outside the Bash sandbox) → zero failures.
- [ ] **Step 3:** `npm run test:browser` → zero failures.
- [ ] **Step 4:** Confirm `git grep -n "auto-pursue" -- server/services/dailyDealHunterDigest.js server/services/dealHunterScheduler.js` returns nothing, and that `.env.example` and `fly.toml` are unchanged.
- [ ] **Step 5:** Report the branch head, commands, and results; do not push, deploy, migrate production, or activate.
