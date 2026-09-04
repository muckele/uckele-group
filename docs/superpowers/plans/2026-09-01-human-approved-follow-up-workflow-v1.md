# Deal Hunter Phase 3 Human-Approved Follow-Up Workflow v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement exactly one top-level task per implementation run. Use `superpowers:test-driven-development` for that task and `superpowers:verification-before-completion` before returning its commit. Stop after the task commit so it can receive one focused review.

**Goal:** Add an explicitly enrolled, five-touch maximum broker-material follow-up sequence in which every transmission is prepared for human review and can be sent only by a fresh administrator approval through the existing durable CIM executor.

**Architecture:** Phase 3 adds a pure policy/acquisition-authority layer, provider-parity atomic storage primitives, and an administrator-only signed preparation/approval adapter around the existing single-request CIM follow-up executor. Marked `operator-approved` requests are an unconditional hard stop in the automatic runner; only the explicit Approve Follow-Up endpoint can verify a proposal and enter the marked-request executor path. The existing opportunity-detail response gains a bounded projection consumed by a Follow-Ups subsection in the Phase 2 Broker Materials card.

**Tech Stack:** Node.js 22.23.2, Express, ES modules, SQLite/`better-sqlite3`, Supabase/PostgreSQL RPCs, React 19, Vitest/Testing Library, Node test runner, Playwright, Vite.

**Spec:** `docs/superpowers/specs/2026-09-01-human-approved-follow-up-workflow-v1-design.md`, including the strengthening commit `f0bd945` after the original formal-spec commit `305dedf`.

## Planning-base correction and mandatory execution preflight

This planning checkout is a stale, dirty development branch. It does not contain deployed Phase 2 files such as `server/services/dealHunterBrokerMaterials.js` and `src/components/admin/BrokerMaterialsCard.jsx`, while production merge `89a10c5cd68777b8bd4858ad43aa3613ea41ed0e` does. The missing Phase 2 files are an implementation-map correction, not permission to recreate them.

Do not implement any Phase 3 task in the current checkout. Before Task 1, create an isolated worktree from the then-current local `main`, require that `main` is a descendant of `89a10c5`, and bring the two specification commits plus the planning commit containing this file onto that Phase 3 branch. Use the exact planning-commit SHA returned by the planning handoff.

```sh
git fetch --all --prune
git merge-base --is-ancestor 89a10c5cd68777b8bd4858ad43aa3613ea41ed0e main
git worktree add -b codex/deal-hunter-phase-3 /private/tmp/uckele-deal-hunter-phase-3 main
cd /private/tmp/uckele-deal-hunter-phase-3
git cherry-pick 305dedf f0bd945
git cherry-pick "$(git log --all -1 --format=%H -- docs/superpowers/plans/2026-09-01-human-approved-follow-up-workflow-v1.md)"
test -f server/services/dealHunterBrokerMaterials.js
test -f src/components/admin/BrokerMaterialsCard.jsx
git status --short
```

Before running the final cherry-pick, compare the SHA printed in the planning handoff with the SHA selected by the `git log` expression; they must match. If `main` is not a descendant of `89a10c5`, either required Phase 2 file is absent, or those planning SHAs differ, stop and report the baseline mismatch before editing.

## Global constraints

- Run Tasks 1, 2, 3, and 4 sequentially on the same isolated Phase 3 branch. Exactly one top-level task is implemented and committed per implementation run.
- Every task follows RED → GREEN: add the named focused tests, run the exact RED command and capture the expected failures, make the minimum in-scope implementation, then run the focused GREEN commands.
- After each task commit, stop and return its SHA for exactly one focused review against that task's contract and prohibited scope. Do not create or maintain standing reviewer loops.
- If that focused review reports actual, reproducible findings, permit one narrow repair run and one repair commit for those findings. Re-run the task's focused verification. Do not use a repair run to add product scope, refactor unrelated code, or reopen reviewed decisions. If no actual finding exists, make no repair commit.
- After Task 4 and its focused review/optional repair, perform one final whole-phase acceptance pass. The final pass verifies; it does not become a fifth feature task.
- Use Node.js v22.23.2 for every install, test, lint, and build command. The host's newer Node can fail the checked-in `better-sqlite3` ABI for environmental reasons.
- Do not deploy, push, merge to `main`, change Fly services/secrets, enable `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED`, unpause outreach, change Stage 1/2/3 activation, run production schedulers, or make a live provider call.
- Preserve Phase 2 `metadata.manualApproval`, the initial-request workflow, central pause, recipient cadence, readiness, weekday/window, suppression, complaint, reply, Pass/archive, and canonical-identity authority.
- Preserve unmarked legacy automatic follow-ups and their existing maximum/delay policy. Do not bulk-mark, rewrite, enroll, or reinterpret historical requests.
- A marked request is one where `metadata.manualFollowUp.mode === "operator-approved"`. The automatic runner must return `approval-required` before a request transmission claim, recipient claim, send-attempt communication, send-attempt activity, or provider call. The runner must have no input or dependency that accepts, verifies, forwards, or consumes a human approval artifact.
- Only the explicit administrator Approve Follow-Up endpoint may verify a Phase 3 signed preparation and call the marked-request durable executor seam. Enabling flags, Operations → Run Follow-Ups, scheduler changes, and cadence configuration can never bypass this boundary.
- Keep `follow_up_count` as accepted-follow-ups-only. Preparation, approval clicks, claims, communication persistence, provider-call start, definitive rejection, ambiguity, and development logging do not increment it.
- No Follow-Up 6 may be projected, prepared, claimed, persisted, sent, reconciled into a new schedule, or built through configuration/input.
- Preparation is read-only. It may not claim, mutate request/activity/communication state, call a provider, consume an override, create an outbox item, or alter a due date.
- Retry after definitive pre-acceptance failure uses the exact persisted communication and deterministic provider key. Ambiguous/unknown results cannot retransmit; accepted proof reconciles without a new provider call.
- No new table or column is expected. A service-role-only Supabase database-function migration is expected in Task 2. If Task 2 inspection proves any table or column creation/alteration is required, stop before implementing Task 2 and report the evidence and proposed schema change for a new product decision.
- All HTTP bodies are strict allowlists: Start `{}`, Stop `{ reason? }`, Prepare `{ greeting? }`, Approve `{ preparationToken, approvedProposalDigest }`. Route IDs select resources but never confer authority.
- Avoid dependency upgrades and broad formatting/refactors. Preserve unrelated user changes.

Run all commands with this prefix:

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

For readability, commands below show that prefix in full.

## Locked public contracts

### Pure Phase 3 policy and acquisition authority

Create `server/services/acquisitionMaterials.js` with:

```js
export function evaluateAcquisitionMaterialsState({
  submission = {},
  secureDocuments = [],
  latestUploadRequest = null,
} = {}) {
  // Returns only public, deterministic authority.
  return {
    materialsReceived: false,
    advancedBeyondBrokerOutreach: false,
    evidenceCodes: [],
  };
}
```

Create `server/services/dealHunterManualFollowUpPolicy.js` with these exports:

```js
export const MANUAL_FOLLOW_UP_VERSION = 'deal-hunter-manual-follow-up-v1';
export const MANUAL_FOLLOW_UP_MODE = 'operator-approved';
export const MANUAL_FOLLOW_UP_MAXIMUM = 5;
export const MANUAL_FOLLOW_UP_CADENCE = 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1';

export function buildManualFollowUpMarker({ enrolledAt, enrolledBy });
export function isOperatorApprovedFollowUpRequest(request);
export function getManualFollowUpNumber(request);
export function nextManualFollowUpAt(acceptedAt);
export function buildManualFollowUpCommunicationId({ requestId, followUpNumber });
export function projectManualFollowUpState({ request, communications, authority, now });
```

`nextManualFollowUpAt` returns an ISO UTC instant calculated from the preceding accepted touch's `America/Los_Angeles` calendar date: add two calendar days, roll Saturday/Sunday forward to Monday, then choose 09:00 Pacific. It does not add 48 elapsed hours. Invalid inputs fail closed.

`buildManualFollowUpCommunicationId` exactly implements:

```text
sha256("crm-communication:<request-id>:follow-up:<N>")
```

for integer `N` in 1…5 and rejects everything else. The existing provider idempotency key remains:

```text
deal-hunter-cim-<normalized-request-id>-follow-up-<N>
```

### Storage provider contract

Both storage adapters must expose equivalent methods and normalized results:

```js
storage.startDealHunterManualFollowUps({
  requestId,
  expectedRequestUpdatedAt,
  expectedSubmissionId,
  expectedSubmissionUpdatedAt,
  marker,
  nextFollowUpAt,
  activity,
});

storage.stopDealHunterManualFollowUps({
  requestId,
  expectedRequestUpdatedAt,
  expectedSubmissionId,
  expectedSubmissionUpdatedAt,
  stoppedAt,
  stoppedBy,
  reason,
  activity,
});

storage.claimDealHunterApprovedFollowUp({
  requestId,
  expectedRequestUpdatedAt,
  expectedSubmissionId,
  expectedSubmissionUpdatedAt,
  expectedFollowUpCount,
  expectedFollowUpNumber,
  expectedNextFollowUpAt,
  claimedAt,
});

storage.finalizeDealHunterApprovedFollowUp({
  requestId,
  expectedRequestUpdatedAt,
  expectedSubmissionId,
  expectedFollowUpNumber,
  expectedCommunicationId,
  outcome,
  acceptedAt,
  nextFollowUpAt,
  activity,
});
```

Each method returns:

```js
{
  applied: Boolean,
  reason: String,
  request: Object | null,
  activity: Object | null,
  alreadyFinalized: Boolean,
}
```

Allowed finalization outcomes are `accepted`, `definitive-failure`, and `ambiguous`. Accepted increments exactly once and schedules the next touch or completes 5. Definitive failure preserves the count/number/original due for exact human-approved retry. Ambiguity clears the active schedule and permits reconciliation/status only. Concurrent reply, materials, Stop, Pass, archive, suppression, complaint, or accepted proof must never be overwritten.

The Supabase functions are service-role-only and named:

```text
start_deal_hunter_manual_follow_ups
stop_deal_hunter_manual_follow_ups
claim_deal_hunter_approved_follow_up
finalize_deal_hunter_approved_follow_up
```

### HTTP contract

```text
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/start
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/stop
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/prepare
POST /api/admin/deal-hunter/triage/:opportunityId/broker-materials/follow-ups/:requestId/approve
```

The existing opportunity-detail GET is the status/check-again endpoint. Do not add a mutation for status polling.

### Review contract

The Phase 3 signed proposal type is `deal-hunter-manual-follow-up-proposal-v1`, is bound to the authenticated administrator principal and exact opportunity/request/submission/material authority described in the spec, and expires in at most 15 minutes. Approve receives only:

```json
{
  "preparationToken": "<signed token>",
  "approvedProposalDigest": "<sha256 digest>"
}
```

The automatic runner receives neither field and never calls proposal verification.

---

## Task 1 — Phase 3 policy and acquisition authority

**Target Codex wall-clock:** 2.5–4 hours, including RED/GREEN work, task verification, handoff preparation, one focused review, and at most one narrow repair if the review finds an actual defect. Human waiting time is excluded.

**Commit message:** `Add Phase 3 follow-up policy authority`

### Exact expected files

Create:

- `server/services/acquisitionMaterials.js`
- `server/services/dealHunterManualFollowUpPolicy.js`
- `test/acquisitionMaterials.test.js`
- `test/dealHunterManualFollowUpPolicy.test.js`

Modify:

- `server/services/acquisitionCommandCenter.js`
- `server/services/dealHunterBrokerMaterials.js`
- `server/services/delivery.js`
- `test/acquisitionCommandCenter.test.js`
- `test/dealHunterBrokerMaterials.test.js`
- `test/delivery.test.js`

No other production file is expected. If implementation proves another file is needed, stop and explain the exact contract that cannot be satisfied by this list before editing it.

### Exact RED tests

Add these exact `node:test` names:

`test/acquisitionMaterials.test.js`

- `acquisition materials ignores unrelated secure documents`
- `acquisition materials accepts canonical CIM teaser offering memorandum and completed broker upload evidence`
- `acquisition materials reports diligence or LOI advancement separately from materials receipt`
- `acquisition materials evidence codes are stable bounded and contain no raw document metadata`

`test/dealHunterManualFollowUpPolicy.test.js`

- `manual follow-up marker is fixed to operator-approved version cadence and maximum five`
- `manual follow-up cadence uses Pacific calendar dates across PST PDT and weekend rollover`
- `manual follow-up cadence maps Monday through Friday acceptance to Wednesday Thursday Friday Monday Monday at 09:00 Pacific`
- `manual follow-up cadence handles defensive Saturday and Sunday acceptance deterministically`
- `manual follow-up numbering accepts only one through five and never projects six`
- `manual follow-up communication identity is deterministic and distinct for one through five`
- `manual follow-up projection distinguishes not-enrolled scheduled due overdue retry ambiguous completed stopped and closed`
- `manual follow-up projection separates preparation blockers from current send blockers`

Extend existing suites with these exact names:

- `acquisition command center uses shared acquisition materials authority instead of documents length`
- `broker materials detail exposes bounded public manual follow-up projection without raw metadata`
- `CIM follow-up copy has explicit distinct branches for four and five`
- `CIM follow-up builder accepts a trusted greeting for one through five and rejects out of range`
- `CIM follow-up idempotency keys are stable and distinct for one through five`

The cadence test must include fixed expected UTC values, including DST boundaries:

```js
assert.equal(nextManualFollowUpAt('2026-01-05T18:30:00.000Z'), '2026-01-07T17:00:00.000Z');
assert.equal(nextManualFollowUpAt('2026-07-06T17:30:00.000Z'), '2026-07-08T16:00:00.000Z');
assert.equal(nextManualFollowUpAt('2026-03-06T20:00:00.000Z'), '2026-03-09T16:00:00.000Z');
assert.equal(nextManualFollowUpAt('2026-10-30T20:00:00.000Z'), '2026-11-02T17:00:00.000Z');
```

The runner and storage are not touched in this task; these are pure authority, projection, identity, and message-builder tests.

### RED command

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/acquisitionMaterials.test.js test/dealHunterManualFollowUpPolicy.test.js test/acquisitionCommandCenter.test.js test/dealHunterBrokerMaterials.test.js test/delivery.test.js
```

Expected RED evidence: missing new modules/exports, Command Center still treating any document as materials, projection absent, and existing `followUpNumber >= 3` copy collapsing 4/5. Do not accept syntax/configuration failures as meaningful RED evidence.

### Implementation steps

- [ ] Extract the semantically narrow predicate into `acquisitionMaterials.js`. Recognize only existing canonical acquisition-material evidence: CIM/confidential information memorandum, teaser, offering memorandum/offering materials, data-room/broker-material classifications, or a completed broker-material upload request. Ignore unrelated secure documents. Return bounded evidence codes and a separate `advancedBeyondBrokerOutreach` boolean.
- [ ] Replace the Command Center's `documents.length > 0` stage/readiness shortcut with `evaluateAcquisitionMaterialsState`. Keep its public pipeline vocabulary unchanged.
- [ ] Implement fixed marker constants, marker construction, marked-request detection, 1–5 numbering, deterministic communication identity, and timezone-aware cadence in `dealHunterManualFollowUpPolicy.js`.
- [ ] Implement a pure bounded projection from request/communication/authority inputs. Derive due/overdue from `now`; do not persist those labels. Terminal authority wins over scheduling. Ambiguity removes resend. Definitive failure exposes exact retry only. Count 5 projects completed and never number 6.
- [ ] Delegate the bounded `brokerMaterials.existingRequest.followUps` projection from `dealHunterBrokerMaterials.js` without exposing raw metadata, signatures, tokens, provider payloads, or claims.
- [ ] Make `delivery.js` validate integer follow-up numbers 1…5 for Phase 3 callers, accept the trusted server-only greeting option, keep established copy for 1–3, and add distinct deterministic 4/5 branches matching the spec's fixed intent. Preserve subject/thread, sender, reply-to, tracking, sanitization, and applicable opt-out behavior.
- [ ] Keep `buildCimEmailIdempotencyKey` behavior stable and prove 1…5 uniqueness. Do not introduce another provider-key format.

### Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/acquisitionMaterials.test.js test/dealHunterManualFollowUpPolicy.test.js test/acquisitionCommandCenter.test.js test/dealHunterBrokerMaterials.test.js test/delivery.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build
git diff --check
```

### Commit boundary

```sh
git add server/services/acquisitionMaterials.js server/services/dealHunterManualFollowUpPolicy.js server/services/acquisitionCommandCenter.js server/services/dealHunterBrokerMaterials.js server/services/delivery.js test/acquisitionMaterials.test.js test/dealHunterManualFollowUpPolicy.test.js test/acquisitionCommandCenter.test.js test/dealHunterBrokerMaterials.test.js test/delivery.test.js
git commit -m "Add Phase 3 follow-up policy authority"
```

Stop and return the task commit for one focused review of policy/cadence/material authority/copy/projection only.

### Prohibited scope

- No HTTP routes, signed tokens, Start/Stop/Prepare/Approve mutations, storage transaction, RPC, provider call, or runner refactor.
- No UI changes.
- No new durable status enum, table, column, dependency, campaign abstraction, holiday calendar, or configurable maximum/cadence.
- No reinterpretation of unmarked legacy requests.

---

## Task 2 — Atomic persistence and SQLite/Supabase provider parity

**Target Codex wall-clock:** 4–6 hours, including schema assessment, RED/GREEN work, task verification, handoff preparation, one focused review, and at most one narrow repair if warranted. Human waiting time is excluded.

**Commit message:** `Add atomic Phase 3 follow-up persistence`

### Mandatory schema stop gate

Before writing a test or implementation, inspect `server/storage/sqlite.js`, `server/storage/supabase.js`, `supabase/schema.sql`, current migrations, CIM request columns/metadata, communications, claims, and activities. Record evidence that existing columns plus JSON metadata can represent marker, stop audit, count, due, accepted/failure/ambiguous state, deterministic communication, and activity.

```sh
rg -n "cim_requests|follow_up_count|follow_up_state|next_follow_up_at|last_follow_up_at|metadata|claim_deal_hunter_cim_follow_up_request|mutate_communications_with_crm_activity" server/storage/sqlite.js server/storage/supabase.js supabase/schema.sql supabase/migrations
```

If any `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `DROP`, type change, or new index is required for Phase 3 correctness, stop before implementation and report: the missing invariant, the exact proposed DDL, why JSON/existing columns cannot satisfy it, SQLite/Supabase impact, and migration/backfill risk. A new/updated PostgreSQL function is allowed and required; a table/column migration is not pre-approved.

### Exact expected files

Create:

- `supabase/migrations/20260901120000_deal_hunter_manual_follow_up_atomicity.sql`
- `test/dealHunterManualFollowUpStorage.test.js`

Modify:

- `server/storage/sqlite.js`
- `server/storage/supabase.js`
- `supabase/schema.sql`
- `test/communicationsStorage.test.js`
- `test/supabaseSecurity.test.js`

No UI, route, approval-service, runner, delivery, table, or column file is expected.

### Exact RED tests

Add these exact `node:test` names:

`test/dealHunterManualFollowUpStorage.test.js`

- `SQLite manual follow-up start atomically writes marker schedule and one activity`
- `SQLite manual follow-up start compare-and-set loses to reply pass archive materials and existing sequence`
- `SQLite manual follow-up stop atomically clears schedule preserves count and history and records bounded audit`
- `SQLite approved follow-up claim requires marker request version count number due timestamp due-now and active submission`
- `SQLite legacy automatic claim cannot authorize an operator-approved request`
- `SQLite accepted finalization increments once schedules two through five and completes five without six`
- `SQLite accepted finalization is idempotent by communication identity and preserves concurrent terminal authority`
- `SQLite definitive failure preserves count number exact communication and original due without automatic retry`
- `SQLite ambiguity clears the schedule and cannot become retry without reconciliation authority`
- `SQLite concurrent start stop approval finalization and accepted reconciliation converge without duplicate activity or count`
- `SQLite and Supabase manual follow-up adapters normalize equivalent results`

Extend `test/communicationsStorage.test.js` with:

- `accepted manual follow-up reconciliation is exactly once across communication request and activity state`
- `reply stop pass archive and materials terminal mutations never reopen a manual schedule`

Extend `test/supabaseSecurity.test.js` with:

- `manual follow-up RPC migration changes functions only and adds no table or column`
- `manual follow-up RPCs revoke public anon and authenticated and grant service_role only`
- `manual follow-up RPCs enforce marker count due version active submission and idempotent finalization`

The parity test must invoke both adapters through the four locked storage method names and compare `{ applied, reason, request, activity, alreadyFinalized }` after normalization; do not merely search source strings.

### RED command

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterManualFollowUpStorage.test.js test/communicationsStorage.test.js test/supabaseSecurity.test.js
```

Expected RED evidence: the four storage methods and four service-role RPCs do not exist. Reject failures caused only by a missing local database/runtime as RED; focused tests must use the repository's existing isolated SQLite and Supabase adapter/fake-RPC patterns.

### Implementation steps

- [ ] Add four `better-sqlite3` immediate transactions matching the locked storage contract. Start and Stop update the request plus one CRM/CIM activity in the same transaction. Claim performs no communication/activity/provider work. Finalize locks current request/submission authority and returns a normalized idempotent result.
- [ ] Make Start compare-and-set the exact request/submission versions and eligible unscheduled state. Merge `metadata.manualFollowUp`; never replace `metadata.manualApproval` or unrelated metadata.
- [ ] Make Stop permanent: `follow_up_state = "stopped"`, `next_follow_up_at = null`, count/history preserved, bounded optional reason stored with actor/time, one activity. A later restore must not remove the marker or recreate a schedule.
- [ ] Make the approved claim require the manual marker, exact request/submission version, count, number, due timestamp, due-now, active submission, and terminal eligibility. Explicitly reject marked requests in the legacy automatic claim primitive as storage-level defense in depth.
- [ ] Make accepted finalization identify a touch by deterministic communication ID plus follow-up number, increment at most once, use the supplied authoritative `acceptedAt`, schedule with the already-tested Task 1 cadence, complete five, and preserve newer terminal authority. Do not schedule six.
- [ ] Encode definitive-failure and ambiguity semantics without inventing an automatic retry. Keep the original due for definitive failure; clear scheduling for ambiguity.
- [ ] Add the four PostgreSQL functions to `supabase/schema.sql` and the timestamped function-only migration. Lock relevant request/submission rows, validate the same predicates, merge bounded JSON, write activity atomically where required, and return normalized fields.
- [ ] Revoke function execution from `public`, `anon`, and `authenticated`; grant only `service_role`. Match existing `SECURITY DEFINER`, `search_path`, and ownership conventions.
- [ ] Add matching `server/storage/supabase.js` adapters and normalization. Do not emulate atomicity through multiple client round trips.
- [ ] Exercise simultaneous Start/Stop/claim/finalize/reconcile attempts and prove one linearized result, exactly-once count/activity, and terminal-state dominance.

### Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterManualFollowUpStorage.test.js test/communicationsStorage.test.js test/supabaseSecurity.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
git diff --check
if git diff --unified=0 -- supabase/schema.sql supabase/migrations/20260901120000_deal_hunter_manual_follow_up_atomicity.sql | rg -q "^\+.*(CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP TABLE|DROP COLUMN)"; then exit 1; fi
```

The last command must produce no matching DDL. If it does, the task violated the mandatory stop gate.

### Commit boundary

```sh
git add server/storage/sqlite.js server/storage/supabase.js supabase/schema.sql supabase/migrations/20260901120000_deal_hunter_manual_follow_up_atomicity.sql test/dealHunterManualFollowUpStorage.test.js test/communicationsStorage.test.js test/supabaseSecurity.test.js
git commit -m "Add atomic Phase 3 follow-up persistence"
```

Stop and return the task commit for one focused review of atomicity, concurrency, idempotency, provider parity, and grants only.

### Prohibited scope

- No table, column, index, type, destructive, or data-backfill migration.
- No HTTP route, token verification, human approval service, executor/provider call, or UI.
- No relaxation of legacy storage predicates or public RPC grants.
- No general storage rewrite or transaction framework.

---

## Task 3 — Human review and durable follow-up execution

**Target Codex wall-clock:** 5–7.5 hours, including RED/GREEN work, task verification, handoff preparation, one focused review, and at most one narrow repair if warranted. Human waiting time is excluded.

**Commit message:** `Add human-approved Phase 3 follow-up execution`

### Exact expected files

Create:

- `server/services/dealHunterManualFollowUps.js`
- `test/dealHunterManualFollowUps.test.js`
- `test/httpDealHunterManualFollowUps.test.js`

Modify:

- `server/services/dealHunter.js`
- `server/services/dealHunterBrokerMaterials.js`
- `server/services/dealHunterTriage.js`
- `server/app.js`
- `test/dealHunterFollowUps.test.js`
- `test/dealHunterBrokerMaterials.test.js`
- `test/dealHunterTriageDetail.test.js`
- `test/cimCommunicationLifecycle.test.js`
- `test/emailCommunicationLifecycle.test.js`

Task 1 policy/delivery and Task 2 storage files may be changed only by the single allowed repair for a concrete contract defect discovered by Task 3 RED tests; otherwise they are consumed, not expanded. No frontend file is expected.

### Exact RED tests

Add these exact `node:test` names:

`test/dealHunterManualFollowUps.test.js`

- `Start Follow-Up Sequence requires administrator canonical request accepted proof and strict empty input`
- `Start Follow-Up Sequence atomically enrolls without claim communication activity duplication or provider work`
- `Start Follow-Up Sequence rejects reply materials pass archive suppression ambiguity active legacy schedule stopped and count five`
- `Stop Follow-Ups requires administrator accepts only bounded reason and permanently invalidates open preparation`
- `Prepare Follow-Up is side-effect-free principal-bound expires in fifteen minutes and returns no authority to viewers`
- `Prepare Follow-Up rejects early terminal ambiguous stopped completed and missing-authority states`
- `Prepare Follow-Up exposes pause cadence readiness and delivery blockers without creating authority`
- `Approve Follow-Up accepts only token and digest and independently rejects early send`
- `Approve Follow-Up rejects stale request submission count due recipient copy sender materials reply stop pass archive suppression and delivery authority`
- `Approve Follow-Up reproduces the exact signed greeting subject text html template communication id and provider key`
- `definitive failure retry prepares exact persisted read-only content and uses a fresh approval`
- `ambiguous follow-up permits status and reconciliation but never retransmission`
- `accepted follow-up reconciliation increments and schedules exactly once without retransmission`
- `duplicate approval two administrators and multiple tabs converge on one communication and one provider call`
- `stop reply materials and pass races before final provider authorization yield zero provider calls`
- `provider acceptance racing stop or reply counts once but schedules no later touch`

`test/httpDealHunterManualFollowUps.test.js`

- `manual follow-up routes require authenticated administrator mutation authority`
- `manual follow-up routes bind canonical opportunity and request instead of trusting path ids`
- `manual follow-up Start body accepts no keys Stop accepts only reason Prepare only greeting and Approve only token and digest`
- `manual follow-up Approve route is the only route that verifies a signed proposal`
- `manual follow-up status uses opportunity detail GET and adds no status mutation`
- `operations Run Follow-Ups rejects approval artifacts and cannot route them to manual approval`

Extend existing suites with these exact names:

- `automatic runner returns approval-required for operator-approved requests before every claim communication activity and provider seam`
- `automatic runner hard boundary holds with follow-up flag enabled Operations invocation and changed cadence settings`
- `automatic runner has no approval token digest verifier or marked executor input path`
- `unmarked legacy runner retains existing delays maximum and executor behavior`
- `manual approval enters the existing single-request durable executor only through trusted approved context`
- `manual executor persists exact communication before provider call and performs final terminal revalidation`
- `manual follow-up never consumes initial-contact cadence override`
- `opportunity detail projects authoritative Phase 3 follow-up status and blockers`
- `communication lifecycle renders Follow-Up four and five and reconciles accepted proof without duplicate send`

The unconditional runner test must instrument every forbidden seam and assert zero calls:

```js
const forbidden = {
  requestClaim: 0,
  recipientClaim: 0,
  communicationWrite: 0,
  activityWrite: 0,
  providerCall: 0,
  proposalVerify: 0,
};

const result = await runDealHunterCimFollowUps({
  storage: dueMarkedRequestStorageThatCounts(forbidden),
  now: new Date('2026-09-01T18:00:00.000Z'),
  settings: { enabled: true, delaysHours: [1], maximumFollowUps: 99 },
});

assert.equal(result.results[0].status, 'approval-required');
assert.deepEqual(forbidden, {
  requestClaim: 0,
  recipientClaim: 0,
  communicationWrite: 0,
  activityWrite: 0,
  providerCall: 0,
  proposalVerify: 0,
});
```

Adapt the fixture keys to existing suite helpers, but preserve all six zero assertions and the enabled/misconfigured settings.

### RED command

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterManualFollowUps.test.js test/httpDealHunterManualFollowUps.test.js test/dealHunterFollowUps.test.js test/dealHunterBrokerMaterials.test.js test/dealHunterTriageDetail.test.js test/cimCommunicationLifecycle.test.js test/emailCommunicationLifecycle.test.js
```

Expected RED evidence: missing service/routes/token type, runner not yet applying the marked hard boundary, and the private single-request processor not yet accepting a trusted approved context. Do not implement UI to satisfy any RED assertion.

### Implementation steps

- [ ] Implement strict Start/Stop/Prepare/Approve parsers and an authority loader in `dealHunterManualFollowUps.js`, reusing Phase 2 authentication, canonical request ownership, accepted-proof ordering, sender/readiness, principal-bound token primitives, and safe public review conventions.
- [ ] Start revalidates every enrollment predicate, anchors Follow-Up `count + 1` to the authoritative preceding acceptance timestamp, calls the Task 2 atomic Start method, and creates no claim/communication/provider work.
- [ ] Stop calls the Task 2 atomic Stop method, permanently clears scheduling, preserves count/history, and invalidates open preparations via request version. Handle in-flight provider uncertainty honestly as Checking.
- [ ] Prepare is entirely read-only. It permits only due/overdue first attempt or exact definitive-failure retry, returns blockers separately, signs `deal-hunter-manual-follow-up-proposal-v1`, binds every material field in spec section 18, omits token/digest for viewers, and never exposes raw metadata/provider payloads.
- [ ] First-attempt preparation accepts one parsed greeting line of at most 120 characters with no controls or angle brackets. Retry ignores edits and reproduces persisted recipient/greeting/subject/text/HTML/template/version/identities as read-only.
- [ ] Approve verifies signature, proposal type/version, expiry, principal, route binding, and digest before loading current authority. It independently revalidates due-now and every material authority field, reproduces exact message bytes/identities, and passes a server-trusted approved-message context to the executor. No other function verifies the artifact.
- [ ] Factor `processCimFollowUpRequest` into an exported/testable policy-aware durable executor without duplicating its persistence, claim, send, event, accepted-proof, or reconciliation logic. Its marked mode accepts only a trusted in-memory context supplied by `approveDealHunterManualFollowUp`; it does not accept a signed token or digest.
- [ ] Put the runner's marker check at the earliest per-request boundary before invoking the executor. For any `metadata.manualFollowUp.mode === "operator-approved"`, return `approval-required`. Do not pass a context, token, verifier, or provider seam through this branch. Keep this unconditional regardless of enabled flag/Operations/cadence/scheduler settings.
- [ ] The approved executor loads/revalidates, obtains the Phase 3 request claim and existing recipient claim, persists/loads exact deterministic communication, reconciles accepted proof, renews/revalidates immediately before provider authorization, calls the existing prepared-message provider seam once, updates communication lifecycle, and calls Task 2 finalization. Always release recipient claim.
- [ ] Preserve count/due on definitive failure for exact fresh-review retry. Clear schedule and prohibit resend for ambiguity. Reconcile accepted communication exactly once while paused and without provider work.
- [ ] Add the four Express routes with exact administrator middleware, canonical route/service binding, strict bodies, status mapping, size/error handling, and no client-supplied policy/message/recipient fields. The existing detail GET remains Check Status.
- [ ] Add the bounded projection to `dealHunterTriage.js` and preserve the Phase 2 `brokerMaterials` contract.
- [ ] Prove initial-contact cadence override remains unavailable/unused for follow-ups and all existing unmarked legacy tests remain green.

### Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterManualFollowUps.test.js test/httpDealHunterManualFollowUps.test.js test/dealHunterFollowUps.test.js test/dealHunterBrokerMaterials.test.js test/dealHunterTriageDetail.test.js test/cimCommunicationLifecycle.test.js test/emailCommunicationLifecycle.test.js
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build
git diff --check
```

### Commit boundary

```sh
git add server/services/dealHunterManualFollowUps.js server/services/dealHunter.js server/services/dealHunterBrokerMaterials.js server/services/dealHunterTriage.js server/app.js test/dealHunterManualFollowUps.test.js test/httpDealHunterManualFollowUps.test.js test/dealHunterFollowUps.test.js test/dealHunterBrokerMaterials.test.js test/dealHunterTriageDetail.test.js test/cimCommunicationLifecycle.test.js test/emailCommunicationLifecycle.test.js
git commit -m "Add human-approved Phase 3 follow-up execution"
```

If a concrete Task 3 test required a narrow repair in a Task 1/2 file, stage that file explicitly and document the violated locked contract in the commit handoff. Stop and return the task commit for one focused review of authority, hard runner boundary, durable executor ordering, routes, retry/ambiguity/reconciliation, and races only.

### Prohibited scope

- No React/UI/browser files.
- No runner verification or consumption of approval artifacts, under any condition.
- No second send pipeline, generic CRM outbox, provider polling loop, automatic retry, early-send override, initial-contact cadence override, or client-owned message/recipient/cadence/maximum.
- No duplicate durable executor or weakening of Phase 2/legacy behavior.
- No new schema table/column or activation/config change.

---

## Task 4 — UI integration and final acceptance

**Target Codex wall-clock:** 4–6.5 hours, including RED/GREEN UI work, browser/full-regression verification, task handoff, one focused review, at most one narrow repair if warranted, and the final whole-phase acceptance pass. Human waiting time is excluded.

**Commit message:** `Complete Phase 3 follow-up review experience`

### Exact expected files

Create:

- `src/components/admin/BrokerMaterialsFollowUps.jsx`
- `test-ui/BrokerMaterialsFollowUps.test.jsx`

Modify:

- `src/components/admin/BrokerMaterialsCard.jsx`
- `src/components/admin/OpportunityDrawer.jsx`
- `src/components/admin/AcquisitionInbox.jsx`
- `src/components/admin/CimRequestHistory.jsx`
- `test-ui/BrokerMaterialsCard.test.jsx`
- `test-ui/OpportunityDrawer.test.jsx`
- `test-ui/AcquisitionInbox.test.jsx`
- `test-ui/CimRequestHistory.test.jsx`
- `test-browser/admin-phase16.spec.js`

Backend changes are prohibited except one narrow repair for an actual Task 4 acceptance finding against the already locked HTTP/projection contract. Do not add a second UI workspace.

### Exact RED tests

Add these exact Vitest names:

`test-ui/BrokerMaterialsFollowUps.test.jsx`

- `renders not-enrolled scheduled due overdue accepted-next completed stopped and terminal-closed states`
- `administrator can start and stop while viewer receives no mutation controls or approval authority`
- `due review displays durable recipient sender subject selectable body prior touch and exact follow-up number`
- `greeting is the only editable first-attempt field and Enter updates preview without sending`
- `changed greeting invalidates approval until Update Preview returns a fresh proposal`
- `Approve and Send locks synchronously discards authority and reloads authoritative detail`
- `definitive failure Review Retry displays exact persisted read-only content`
- `ambiguous unknown outcome shows Checking and Check Again without retry or resend`
- `future due has no Review action and exposes no early-send override`
- `pause cadence readiness and delivery blockers are clear and never expose overrides`
- `focus moves intentionally for start stop prepare update approve failure and close transitions`
- `one stable live region announces preparing updated sending checking and final status once`

Extend existing Vitest suites with these exact names:

- `Broker Materials card places Follow-Ups after the initial request lifecycle without duplicating history`
- `Opportunity Drawer preserves Escape order contact menu then review then drawer`
- `Acquisition Inbox refreshes Phase 3 detail without background focus theft`
- `CIM Request History renders deterministic Follow-Up four and five communications`
- `viewer never receives preparation token digest greeting editor approve retry stop or start controls`

Extend `test-browser/admin-phase16.spec.js` with these exact Playwright titles:

- `Phase 3 admin completes start future due review update preview approve and next schedule lifecycle`
- `Phase 3 automatic runner action cannot send a marked due follow-up`
- `Phase 3 viewer is read-only and never receives approval artifacts`
- `Phase 3 unknown approval outcome checks authoritative status without retransmission`
- `Phase 3 definitive failure retries exact persisted communication after fresh review`
- `Phase 3 mobile drawer keeps review actions reachable above keyboard and sticky controls do not obscure content`
- `Phase 3 keyboard flow never sends on Enter and preserves Escape and focus restoration`
- `Phase 3 Follow-Up five completes with no Follow-Up six control request or communication`

The browser fixture must assert exact request bodies and route counts. The automatic-runner scenario must verify the provider stub received zero marked follow-up calls even when the Operations action runs.

### RED commands

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run test-ui/BrokerMaterialsFollowUps.test.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/OpportunityDrawer.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/CimRequestHistory.test.jsx
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npx playwright test test-browser/admin-phase16.spec.js --grep "Phase 3"
```

Expected RED evidence: the Follow-Ups component and controls do not exist and the Phase 1/2 browser fixture lacks stateful Phase 3 endpoints. Resolve environment/config failures before treating the feature tests as RED.

### Implementation steps

- [ ] Add `BrokerMaterialsFollowUps` immediately after the initial-request lifecycle in the existing Broker Materials card. Render only server projection; never reconstruct authority, due dates, number, recipient, retry mode, or blockers in the browser.
- [ ] Render all locked states: not-enrolled, scheduled, due, overdue, review, accepted-next, definitive failure/retry, ambiguity/checking, completed, stopped, and terminal closed.
- [ ] Implement strict Start `{}`, Stop `{ reason? }`, Prepare `{ greeting? }`, and Approve `{ preparationToken, approvedProposalDigest }` calls. Do not cache or place approval authority in URLs, persistent storage, logs, history rows, or viewer state.
- [ ] In first-attempt review, make recipient/sender/subject/body read-only and selectable; greeting alone is editable. A greeting edit invalidates the current proposal. Enter invokes Update Preview, never Approve. Approval is an explicit button and never the form default.
- [ ] In retry review, show exact persisted content entirely read-only and obtain a fresh proposal. Do not provide regenerate/edit/resend shortcuts.
- [ ] Lock approval synchronously, discard token/digest after response or unknown outcome, reload opportunity detail, show Checking when uncertain, and make Check Again a GET-only refresh. Never automatically replay Approve.
- [ ] Admin gets eligible actions; viewer gets status/history only and never receives token/digest/edit/start/stop/approve/retry/reconciliation mutation controls.
- [ ] Add intentional focus movement for user-triggered transitions, no background-refresh focus movement, one stable live region, nonduplicated announcements, keyboard guards, and existing Escape ordering.
- [ ] Preserve mobile drawer scroll/keyboard behavior and keep sticky controls from obscuring review content. Reuse existing responsive patterns; do not redesign the drawer.
- [ ] Extend history rendering only as needed for generic exact Follow-Up 4/5 communications; do not duplicate the full history inside the subsection.
- [ ] Extend the existing `admin-phase16` stateful route audit with exact Phase 3 endpoint bodies, lifecycle mutations, failure/ambiguity/status, admin/viewer access, runner zero-call evidence, and desktop/mobile keyboard/focus checks.

### Focused GREEN verification

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run test-ui/BrokerMaterialsFollowUps.test.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/OpportunityDrawer.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/CimRequestHistory.test.jsx
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npx playwright test test-browser/admin-phase16.spec.js --grep "Phase 3"
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build
git diff --check
```

### Commit boundary

```sh
git add src/components/admin/BrokerMaterialsFollowUps.jsx src/components/admin/BrokerMaterialsCard.jsx src/components/admin/OpportunityDrawer.jsx src/components/admin/AcquisitionInbox.jsx src/components/admin/CimRequestHistory.jsx test-ui/BrokerMaterialsFollowUps.test.jsx test-ui/BrokerMaterialsCard.test.jsx test-ui/OpportunityDrawer.test.jsx test-ui/AcquisitionInbox.test.jsx test-ui/CimRequestHistory.test.jsx test-browser/admin-phase16.spec.js
git commit -m "Complete Phase 3 follow-up review experience"
```

Stop and return the task commit for one focused review of all UI states, admin/viewer authority, exact request bodies, unknown outcome, accessibility, responsive behavior, and browser evidence only.

### Prohibited scope

- No alternate Follow-Ups workspace, full history duplication, responsive redesign, generic form framework, browser-side authority, or client-generated copy/dates/identity.
- No Send Again for ambiguity, auto-replay after unknown outcome, editable retry, early-send override, viewer mutation, raw token/digest display, or Follow-Up 6.
- No backend expansion except the single narrow repair rule above.
- No activation, deployment, merge, push, or live provider exercise.

---

## Final whole-phase acceptance pass

Run this only after Task 4's focused review and optional single repair are complete. Do not change product scope during acceptance.

### Static contract audit

- [ ] Compare the complete Phase 3 branch diff to every acceptance criterion and race in the formal spec.
- [ ] Confirm the four-task boundary: Task 1 policy/acquisition authority; Task 2 atomic provider parity; Task 3 human review/durable execution; Task 4 UI/final acceptance.
- [ ] Trace the runner from discovery through per-request dispatch and prove the marked check precedes executor invocation and all six forbidden seams. Search for any runner-facing token/digest/verifier parameter and require none.
- [ ] Trace the Approve route and prove it is the only signed-proposal verifier and the only caller that enters the marked durable executor path.
- [ ] Trace preparation and prove every reachable dependency is read-only.
- [ ] Trace provider ordering: exact communication persistence, claim renewal/final authority check, provider call, lifecycle, atomic finalization.
- [ ] Confirm exact-retry reuse, ambiguity no-resend, accepted-proof reconciliation, terminal-state dominance, count exactly once, and no 6.
- [ ] Inspect SQLite/Supabase parity, RPC grants, and the migration diff; confirm no table/column/index/type/backfill change.
- [ ] Confirm central pause/Stage 1 and disabled production flag remain unchanged and no deployment/config file changed.

### Exact final verification commands

```sh
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run check
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run test:browser
/usr/bin/env PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin node --test test/dealHunterManualFollowUpPolicy.test.js test/dealHunterManualFollowUpStorage.test.js test/dealHunterManualFollowUps.test.js test/httpDealHunterManualFollowUps.test.js test/dealHunterFollowUps.test.js test/cimCommunicationLifecycle.test.js test/emailCommunicationLifecycle.test.js test/supabaseSecurity.test.js
git diff --check
if git diff 89a10c5cd68777b8bd4858ad43aa3613ea41ed0e...HEAD -- supabase/schema.sql supabase/migrations | rg -q "^\+.*(CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP TABLE|DROP COLUMN)"; then exit 1; fi
git diff 89a10c5cd68777b8bd4858ad43aa3613ea41ed0e...HEAD -- fly.toml Dockerfile package.json package-lock.json
```

Record exact pass counts, task/review/repair commit SHAs, and any environment-only caveat. The last deployment/config diff must be empty unless an unrelated baseline change is explicitly identified; do not fix or deploy it in this phase.

## Execution timing summary

| Task | Included work | Codex wall-clock |
|---|---|---:|
| Task 1 | Policy, acquisition authority, cadence, identities, copy 1–5, projections, focused review, possible one repair | 2.5–4 hours |
| Task 2 | Schema stop-gate inspection, SQLite/PostgreSQL atomic functions, parity/concurrency/idempotency, focused review, possible one repair | 4–6 hours |
| Task 3 | Start/Stop/Prepare/Approve, signed authority, unconditional runner guard, durable executor, failure/ambiguity/reconciliation/races, focused review, possible one repair | 5–7.5 hours |
| Task 4 | Complete UI states, access/accessibility/mobile/browser work, focused review, possible one repair, final whole-phase acceptance | 4–6.5 hours |
| **Total active Codex wall-clock** | Excludes human review wait, approvals, deployment, and production observation | **15.5–24 hours** |

## Four-run completion rule

The implementation sequence is fixed:

1. Phase 3 policy and acquisition authority.
2. Atomic persistence and SQLite/Supabase provider parity.
3. Human review and durable follow-up execution.
4. UI integration and final acceptance.

Do not combine tasks, start the next task in the same implementation run, or replace focused task review with a standing reviewer loop. Phase 3 remains inactive after all four tasks until a separate production-activation decision explicitly authorizes deployment and configuration changes.
