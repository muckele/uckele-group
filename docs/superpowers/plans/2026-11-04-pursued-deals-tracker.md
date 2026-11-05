# Pursued Deals Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Pursued deals** tab lists every pursued deal at one stage. Gmail replies and bounces show up in a **Broker replies** block in Needs Your Action, with a one-click reply type and an Open-in-Gmail link. The owner can upload the SIM PDF into the vault, which stops follow-ups through the existing materials rule.

**Architecture:**
- Stage is never stored. A pure fold (`server/services/pursuitTracker.js`) computes it from a per-opportunity **bundle**, which both storage adapters return in the same shape. The bundle holds decisions, the latest campaign, Gmail reply rows, CIM-type documents, CRM stages, and owner tracker events.
- Owner actions append to the new immutable table `deal_hunter_pursuit_stage_events`. Writes are serialized by a UNIQUE predecessor chain, SQLite `.immediate()` transactions, and Postgres `FOR UPDATE`.
- The SIM upload streams the PDF straight to the vault under a write-ahead cleanup job. One transaction then inserts a synthetic upload request, the document, the CRM activity and the tracker event, and runs the existing materials convergence: SQLite through a shared helper, Postgres through the existing triggers.

**Tech Stack:** Node 22 ESM, Express, better-sqlite3 plus Supabase/Postgres (RPCs, mirrored in `supabase/schema.sql`), React 18 + Vite, `node --test`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-pursued-deals-tracker-design.md` (revision 3).

**Branch:** `codex/pursued-deals-tracker`, from the same docs commit as PR A (`docs/superpowers/plans/2026-11-04-backup-document-hardlinks.md`). The code doesn't depend on PR A, so the work can run in parallel.
- **Before merging:** merge `origin/main` once PR A has landed.
- **Deploying:** don't deploy this PR until PR A is deployed. The disk reserve assumes documents are hardlinked into backups.

## Global Constraints

- **Sends nothing.** No new code calls a mail provider, the sender, the poller, transmission code or the final gate.
- **Campaign effects.** `reply-type`, `stage` and `acknowledge` never append a terminal event and never touch a campaign. Only the SIM intake changes campaign state, and only through the existing materials convergence (spec §6.3).
- **No email bodies.** No new column, request field or log line holds a body, subject or snippet. `deal_hunter_pursuit_stage_events` has no free-text column.
- **No new npm dependencies.**
- **Unchanged code:** the inbox SQL (`list_deal_hunter_fresh_inbox_v1`, `listDealHunterFreshInbox`), the Command Center mapping, and CRM `metadata`.
- **SQLite and Supabase parity.**
  - Every storage method exists in `server/storage/sqlite.js` and in `server/storage/supabase.js`.
  - DDL and RPCs go into `supabase/migrations/20261105120000_pursuing_tracker.sql`, mirrored verbatim in `supabase/schema.sql`.
  - Every new RPC takes one argument, `p_command jsonb`, is `security definer` with `set search_path = public`, and is executable by `service_role` only. The new table has RLS on and no anon/authenticated grants (as in `20261103120000_gmail_send_runners.sql:45-52`).
- **Fixed values.** Use these exactly:
  - Stage ids, in this order: `cim-requested`, `broker-replied`, `nda-sent`, `cim-received`, `financial-review`, `loi-candidate`, `passed`.
  - Stage labels, in the same order: `SIM requested`, `Broker replied`, `NDA`, `SIM received`, `Reviewing`, `LOI candidate`, `Passed`.
  - Event kinds: `reply-type`, `stage-move`, `sim-intake`, `acknowledge`.
  - Reply types: `nda-requested`, `sim-received`, `not-available`, `question`, `other`.
  - `policy_version`: `pursuit-tracker-v1`.
  - Digest prefix: `pursuit-stage-request:v1`.
  - Predecessor sentinel: `'genesis'`.
  - `SIM_MAX_BYTES = 25 * 1024 * 1024`.
  - Disk reserve: `max(1 GiB, 2 × size of SQLITE_PATH)`.
  - Row cap: 200.
  - Postgres release-report concurrency: 8.
  - Gmail link: `https://mail.google.com/mail/?authuser=<encodeURIComponent(address)>#all/<threadId>`, with `threadId` matching `^[A-Za-z0-9_-]{1,64}$`.
- **Error codes:**
  - `400`: `invalid_stage`, `invalid_reply_type`, `invalid_idempotency_key`, `invalid_file_name`
  - `401`
  - `404`: `not_pursued`
  - `409`: `pursuit_stage_changed`, `idempotency_conflict`, `opportunity_not_active`, `no_crm_record`, `crm_superseded`
  - `411`: `length_required`
  - `413`: `file_too_large`
  - `415`: `pdf_only`
  - `422`: `unknown_reply`, `not_a_pdf`
  - `503`: `upload_capacity`, with `Retry-After: 30`
  - `507`: `storage_full`
- **Copy.** Every owner-facing string is exactly spec §7.1, §7.3 and §7.5, plus "Passed in Deal Hunter" (§5.1), "Status unavailable" (§6.1) and "Merged into another listing" (§9). The UI says "SIM"; code keeps the CIM names.
- **Roles.** Reads use `requireAdminAccess`; writes use `requireAdmin` and return `401` with `{ success: false, error: 'Administrator access is required.' }`. Viewer responses never include `gmailThreadUrl` or `needsAction.replyId`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Environment:**
  - Run `. "$HOME/.nvm/nvm.sh"; nvm use 22` first.
  - `npm run test:ui` and Playwright hang under the Bash sandbox, so run them with the sandbox off.
  - Gated Postgres needs Docker: `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test --test-concurrency=1 test/<x>Postgres.test.js`.

## Review Focus

1. **A PDF that a browser reports as `''` or `application/octet-stream`.** The client still sends `Content-Type: application/pdf`, and the server accepts the file because of its `%PDF-` bytes. Pinned in Task 8, `uploadPursuedSim sends application/pdf for a .pdf file whose type is empty`.
2. **A file name with `%`, emoji or a path.** A malformed escape gets `400 invalid_file_name`. `../../etc/x.pdf` is stored as a sanitized basename inside the request directory. Pinned in Task 7.
3. **An upload while the 03:30 backup is running.** The new file isn't in that bundle's database snapshot, so the bundle stays consistent. Neither the backup nor the upload fails. Pinned in Task 7, `an upload during a backup leaves both consistent`.
4. **Watch after Pursue, then a second Pursue after Restore.** The deal leaves the tab, then comes back at SIM requested, with old tracker events and old replies ignored. Pinned in Task 3.
5. **Two broker replies, then one reply-type click.** Only the reply the owner saw is acknowledged. The later one stays in Broker replies. Pinned in Task 6.

---

### Task 1: Event table and stage-event writes on both adapters

**Files:**
- Create: `supabase/migrations/20261105120000_pursuing_tracker.sql`, `server/storage/pursuitTrackerStorageContract.js`, `test/fixtures/pursuitTrackerScenarios.js`, `test/pursuitTrackerStorage.test.js`, `test/pursuitTrackerStoragePostgres.test.js`
- Modify:
  - `server/storage/sqlite.js`: DDL beside `:4569-4589`; triggers beside `:5054-5065`; methods
  - `server/storage/supabase.js`: methods near `:4314`
  - `supabase/schema.sql`: append
  - `test/fixtures/pursueCimEndToEndFixture.js`: export `createWorld`, `autoPursuedAndSent`, `brokerReplies`, `pollAt`, `sendAt`, `pacific`, `START`, unchanged otherwise
  - `test/fixtures/postgresServiceRoleClient.js`: export `openSession`

**Interfaces:**
- **Produces, from `pursuitTrackerStorageContract.js`:**
  - `PURSUIT_STAGES`, `PURSUIT_EVENT_KINDS`, `PURSUIT_REPLY_TYPES` (frozen arrays of the fixed values).
  - `pursuitStageRequestDigest({ opportunityId, kind, replyType, stage, expectedPreviousEventId, acknowledgedReplyId, actor, idempotencyKey, fileBytes = null, fileSha256 = null }) -> hex64`. It is sha256 over `pursuit-stage-request:v1` and the fields in that order, `stableCanonicalJson`-encoded (`server/utils/security.js`).
  - `validatePursuitStageEventCommand(command) -> command`. It throws `TypeError` on a bad kind, stage, reply type, UUID or id shape. The id regex is `^[A-Za-z0-9_-]{1,240}$`.
  - `normalizePursuitStageEventRow(row) -> { id, idempotencyKey, opportunityId, previousEventId, kind, replyType, fromStage, stage, acknowledgedReplyId, acknowledgedProcessedAt, secureDocumentId, actor, policyVersion, createdAt }`.
- **Produces, on both adapters:**
  - `getPursuitStageEventByIdempotencyKey(key) -> event | null`.
  - `recordPursuitStageEvent({ id, idempotencyKey, requestDigest, opportunityId, expectedPreviousEventId, kind, replyType, fromStage, stage, acknowledgedReplyId, actor, now }) -> { applied, replay, conflict, event }`.
    - `expectedPreviousEventId: null` means "append after the latest, read under the lock".
    - `conflict` is one of `null`, `'idempotency_conflict'`, `'pursuit_stage_changed'`, `'not_pursued'`, `'opportunity_not_active'` or `'unknown_reply'`.
    - The order of checks inside the transaction:
      1. the idempotency key (replay or conflict);
      2. `opportunity.status = 'active'`;
      3. the latest owner decision is `pursue`;
      4. the predecessor matches;
      5. the acknowledged reply resolves.
    - **Resolving the acknowledged reply:** `acknowledged_processed_at` is copied from the `deal_hunter_gmail_reply_messages` row whose `conversation_id` is the latest campaign's conversation. Otherwise the result is `unknown_reply`.
- **Postgres RPC:** `pursuit_tracker_record_event_v1(p_command jsonb)`. It first runs `SELECT 1 FROM deal_hunter_opportunities WHERE opportunity_id = … FOR UPDATE`.
- **Table:** `deal_hunter_pursuit_stage_events`, with the columns in spec §4.3, CHECKs on every enum, UNIQUE (`opportunity_id`, `previous_event_id`), and index (`opportunity_id`, `created_at DESC`).
  - The no-update, no-delete and no-replace triggers raise `pursuit stage evidence is immutable`.
  - A CHECK enforces `secure_document_id IS NOT NULL` iff `kind = 'sim-intake'`.
- **Fixture:** `pursuitTrackerScenarios.js` exports `PURSUIT_TRACKER_SCENARIOS: Array<[name, (t, createBackend) => Promise]>`. It builds worlds with `createWorld` and `autoPursuedAndSent`, so every scenario runs on a real campaign on both adapters.

- [ ] **Step 1: Write the failing scenarios in `test/fixtures/pursuitTrackerScenarios.js`.** Run them from `test/pursuitTrackerStorage.test.js`, using the SQLite backend from `pursueCimGmailEndToEnd.test.js:29-41`, and from `test/pursuitTrackerStoragePostgres.test.js`, using the Postgres backend from `pursueCimGmailEndToEndPostgres.test.js:39-50`. The same names cover both.

```js
['a stage-move appends after genesis and replays its own key', async (t, createBackend) => {
  const first = await world.storage.recordPursuitStageEvent(command({ kind: 'stage-move', stage: 'nda-sent', expectedPreviousEventId: 'genesis' }));
  assert.deepEqual([first.applied, first.replay, first.conflict, first.event.previousEventId], [true, false, null, 'genesis']);
  const again = await world.storage.recordPursuitStageEvent(sameCommand);
  assert.deepEqual([again.applied, again.replay, again.conflict, again.event.id], [false, true, null, first.event.id]);
  assert.equal((await world.storage.recordPursuitStageEvent({ ...sameCommand, stage: 'passed', requestDigest: otherDigest })).conflict, 'idempotency_conflict');
}],
['a stale predecessor is refused with pursuit_stage_changed and writes nothing', …],   // count stays 1
['an append without a predecessor follows the latest event', …],                         // previousEventId === first.event.id
['a reply id outside the deal conversation is unknown_reply', …],
['an acknowledged reply copies processed_at from the stored Gmail row', …],               // after brokerReplies + pollAt
['writes on a watched or merged opportunity are refused', …],                             // 'not_pursued', 'opportunity_not_active'
['stage evidence is immutable', …],                                                      // UPDATE and DELETE via world.run reject /immutable/
['no tracker column can hold a body', …],                                                // column list has no subject|body|snippet|note|text
['a reply-type write leaves the campaign row_version and terminal_revision unchanged', …],
```

  In `test/pursuitTrackerStoragePostgres.test.js` only, add three more tests:
  - `an acknowledge waits for a locked stage-move and both commit`. Use a second `openSession`: session A runs `begin; select pursuit_tracker_record_event_v1(<stage-move>); select pg_sleep(1);`; the adapter on session B calls `recordPursuitStageEvent({ kind: 'acknowledge', expectedPreviousEventId: null, … })`; then A commits. Both are applied, and B's `previousEventId` equals A's id.
  - `anon and authenticated cannot read the table or execute the RPC`.
  - `migration and schema.sql define identical functions` (`migrationFunctionNames`, as in `gmailSendStoragePostgres.test.js`).

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `node --test test/pursuitTrackerStorage.test.js`
  Expected: FAIL with `recordPursuitStageEvent is not a function`.
- [ ] **Step 3: Implement the contract module, the SQLite DDL, triggers and methods (one `.immediate()` transaction each), the migration, the `schema.sql` mirror, and the Supabase methods.** `getPursuitStageEventByIdempotencyKey` reads with `client.from(...)`; the write goes through the RPC.
- [ ] **Step 4: Run them.**
  - `node --test test/pursuitTrackerStorage.test.js`: PASS.
  - `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test --test-concurrency=1 test/pursuitTrackerStoragePostgres.test.js`: PASS.
  - `node --test test/pursueCimGmailEndToEnd.test.js`: PASS, unchanged after the fixture exports.
- [ ] **Step 5: Commit** `feat: immutable pursuit stage events with a serialized predecessor chain on both adapters`.

### Task 2: Pursuit bundles on both adapters

**Files:**
- Modify: `server/storage/pursuitTrackerStorageContract.js`, `server/storage/sqlite.js`, `server/storage/supabase.js`, the migration, `supabase/schema.sql`, `test/fixtures/pursuitTrackerScenarios.js`

**Interfaces:**
- **Consumes:** Task 1's table and normalizer.
- **Produces:**
  - `normalizePursuitBundle(raw) -> PursuitBundle`, where:
    ```
    PursuitBundle = { opportunityId, name, opportunityStatus,
      decisions: [{ id, action, createdAt }],                         // every decision, oldest first
      campaign: null | { id, state, reasonCode, crmSubmissionId, conversationId, gmailThreadId },  // latest generation
      replies: [{ gmailMessageId, classification, processedAt, messageAt }],  // that conversation, any `applied`
      documents: [{ id, documentType, originalName, sizeBytes, createdAt }],  // document_type in cimDocumentTypes
      crm: null | { diligenceStage, diligenceUpdatedAt, pipelineStage, pipelineUpdatedAt },
      events: [PursuitStageEvent] }                                   // oldest first
    ```
    - `name` is `deal_hunter_opportunities.canonical_name`.
    - `documents` and `crm` come only from `campaign.crmSubmissionId`. When there is no campaign they are `[]` and `null`. `primary_submission_id` is never read.
    - The CRM fields read `metadata.diligence.stage`, `metadata.diligence.updated_at`, `metadata.acquisitionCommand.pipelineStage` and `metadata.acquisitionCommand.updatedAt`.
  - `listPursuitBundles({ opportunityIds } = {}) -> PursuitBundle[]` on both adapters.
    - Members are every opportunity with at least one `pursue` decision. The fold, not storage, decides who is listed.
    - `opportunityIds` (at most 200) narrows the result for single-row refreshes.
  - Postgres RPC `pursuit_tracker_list_v1(p_command jsonb)`, where `p_command` is `{ opportunityIds?: text[] }`. It returns `jsonb` (an array of raw bundles).

- [ ] **Step 1: Write the failing scenarios.**
  - `a pursued deal's bundle carries its campaign, thread, Gmail rows and only CIM-type documents on the campaign submission`. Seed a reply via `brokerReplies` and `pollAt`, a `cim` document and a `financials` document on `campaign.crm_submission_id`, and a `cim` document on another submission. Assert `documents.map((d) => d.documentType)` deep-equals `['cim']`, `replies[0].classification === 'reply'`, and that `gmailThreadId` matches the conversation.
  - `a pending (applied = 0) Gmail row is still in the bundle`.
  - `opportunityIds narrows the list` and `a deal never pursued has no bundle`.
  - `both adapters return deep-equal bundles for the same world`. Strip ids, normalize instants to ISO, and compare to a stored expectation literal in the fixture.
- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/pursuitTrackerStorage.test.js`. Expected: FAIL with `listPursuitBundles is not a function`.
- [ ] **Step 3: Implement both adapters and the RPC (`stable`, not `security invoker`), and mirror them.**
- [ ] **Step 4: Run** the SQLite and gated Postgres commands from Task 1. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pursuit bundles read the same evidence on both adapters`.

### Task 3: Stage fold, attention, and Gmail link

**Files:**
- Create: `server/services/pursuitTracker.js`, `test/pursuitTracker.test.js`

**Interfaces:**
- **Consumes:** `PursuitBundle` (Task 2) and `PURSUIT_STAGES` (Task 1).
- **Produces** `foldPursuitStage(bundle) -> PursuitProjection`, where:
  ```
  PursuitProjection = { member, passedInDealHunter, stage, stageSince, stageSource /* 'owner'|'evidence' */,
    needsAction: null | { reason: 'reply'|'bounce', at, replyId, classification },
    lastReplyAt, latestEventId /* 'genesis' when none */, replyCount }
  ```
- **Produces** `STAGE_LABELS` (id → label, in the fixed order) and `stageAfterReplyType(current, replyType) -> stage`.
- **Produces** `buildGmailThreadUrl({ threadId, address }) -> string | null`. It returns `null` for a bad or missing id, or an empty address.

**Fold rules.** The tests pin spec §5.1–§5.3.
- Membership:
  - The latest decision `pursue` → member.
  - The latest decision `pass`, with a pursue before it → member, with `passedInDealHunter: true` and stage `passed`.
  - The latest decision `watch` → `member: false`.
- The fold starts at the latest `pursue`:
  - Events, Gmail rows and documents for that campaign that are **older than that pursue** are dropped. The exception is documents and CRM stages, which are applied at the pursue instant.
- Sort key: `(instant, systemBeforeOwner, id)`.
- Evidence moves the stage forward only and never out of `passed`.
- Attention: the acknowledgement point is the maximum `(acknowledgedProcessedAt, acknowledgedReplyId)` over all events, compared to `(processedAt, gmailMessageId)`.
  - `reply` covers the classifications `reply` and `stop`.
  - `bounce` applies only while `campaign.state === 'action-required' && campaign.reasonCode === 'recipient_bounced'`.
  - `needsAction` names the oldest unacknowledged row, and its `at` is that row's `processedAt`.

- [ ] **Step 1: Write the failing tests.** Use one table-driven test per row of spec §5.2, named `fold: <event> → <effect>`, plus these:

```js
test('fold: watch after pursue removes the deal; a second pursue after restore starts again at cim-requested and ignores older events and replies', …);
test('fold: pass after pursue lists the deal as passed in Deal Hunter', () => {
  assert.deepEqual(pick(foldPursuitStage(bundle)), { member: true, passedInDealHunter: true, stage: 'passed' });
});
test('fold: evidence never moves backward or out of passed; only a stage-move reopens', …);
test('fold: a reply processed late with an older message_at still needs action', () => {
  // ack R1 (processedAt 10:00), R0 processedAt 10:05 messageAt 09:00 → needsAction.replyId === 'R0'
});
test('fold: acknowledgement is the largest acknowledged reply, not the newest event', …);
test('fold: a bounce needs action only while the campaign is action-required/recipient_bounced', …);
test('fold: a prospectus URL or a financials document is not SIM evidence', …);
test('fold: lender-review → financial-review; docs-received → cim-received; new-fit and not-started → none', …);
test('reply types: not-available → passed; question on financial-review stays financial-review', () => {
  assert.equal(stageAfterReplyType('financial-review', 'question'), 'financial-review');
  assert.equal(stageAfterReplyType('loi-candidate', 'not-available'), 'passed');
});
test('gmail link: authuser is encoded, #all is used, bad ids give null', () => {
  assert.equal(buildGmailThreadUrl({ threadId: '18c1a2b3d4e5f607', address: 'Owner+deals@uckele.test' }),
    'https://mail.google.com/mail/?authuser=Owner%2Bdeals%40uckele.test#all/18c1a2b3d4e5f607');
  for (const threadId of [null, '', 'a/b', 'x'.repeat(65), '<script>']) assert.equal(buildGmailThreadUrl({ threadId, address: 'o@u.test' }), null);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/pursuitTracker.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `foldPursuitStage`, `stageAfterReplyType` and `buildGmailThreadUrl` as pure functions with no I/O.
- [ ] **Step 4: Run** `node --test test/pursuitTracker.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fold pursued-deal stage and reply attention from evidence and owner events`.

### Task 4: SIM intake storage with materials convergence on both adapters

**Files:**
- Modify:
  - `server/storage/sqlite.js`: extract `insertSecureDocumentInTransaction` from `insertSecureDocument` `:9346-9358`; add `recordPursuitSimIntake`
  - `server/storage/supabase.js`, `server/storage/pursuitTrackerStorageContract.js`, the migration, `supabase/schema.sql`, `test/fixtures/pursuitTrackerScenarios.js`

**Interfaces:**
- **Consumes:** Task 1's event writer rules (lock, idempotency, membership).
- **Produces** `insertSecureDocumentInTransaction(document, { actor, source })`, a closure inside `createSqliteStorage`.
  - It runs `assertCrmSubmissionWritableInTransaction`, `insertSecureDocumentStatement`, the follow-up recommendation supersede, and `cimTransitions.convergeCimTerminalAuthority({ submissionId, evaluateMaterialsState: true, evidenceType: 'materials', evidenceId: document.id, actor, source, observedAt: document.created_at, now: document.created_at })`.
  - `insertSecureDocument` calls it with `{ actor: 'secure-document-writer', source: 'secure-document-transaction' }`, unchanged.
- **Produces** `validatePursuitSimIntakeCommand(command)` and, on both adapters, `recordPursuitSimIntake({ event, request, document, activity }) -> { applied, replay, conflict, event, document }`:
  - `event` is Task 1's command, with `kind: 'sim-intake'`, `expectedPreviousEventId: null` and `secureDocumentId`.
  - `request` is a synthetic `secure_upload_requests` row: `status 'completed'`, `requested_documents [{ category: 'cim', label: 'CIM', required: true }]`, `nda_required false`, `upload_batch_count 1`, `expires_at = closed_at = last_uploaded_at = now`.
  - `document` is a `secure_documents` row with `document_type 'cim'`.
  - `activity` is `buildCrmActivityEvent({ eventType: 'documents.uploaded', role: 'admin', … })`.
  - `conflict` adds `'no_crm_record'` (the submission isn't the latest campaign's `crm_submission_id`) and `'crm_superseded'`.
  - SQLite runs it in one `.immediate()` transaction: request, `insertSecureDocumentInTransaction(document, { actor, source: 'pursuit-sim-intake-transaction' })`, `insertCrmActivityEvent` (`:7872`), then the event.
- **Postgres RPC:** `pursuit_tracker_record_sim_intake_v1(p_command jsonb)`. It takes the same lock, checks for an active `crm_submission_supersessions` row (`crm_superseded`), and inserts into `secure_upload_requests`, `secure_documents`, `crm_activity_events` and the event table. `trg_000_pursue_cim_terminal_upload` and `_document` (`schema.sql:18824-18833`) and `trg_secure_document_supersede_follow_up_recommendation` (`:2939-2942`) do the convergence. No new trigger.

- [ ] **Step 1: Write the failing scenarios.**
  - `a SIM intake on an active-follow-up campaign ends materials-received with cancelled touches`. Assert `(await world.campaignFor(id)).state === 'materials-received'`, that `await world.scheduled(campaign)` deep-equals `[]`, that there is one `secure_documents` row with `document_type 'cim'`, one `documents.uploaded` activity, and one event with `kind 'sim-intake'`.
  - `a SIM intake replays by idempotency key and writes nothing twice`.
  - `a failure after the document insert leaves no request, document, activity or event`. Make the event insert fail with a duplicate `id` taken from an existing event.
  - `a SIM intake for a submission other than the campaign's is no_crm_record`.
  - `insertSecureDocument still converges as before`. This is the existing behavior through the extracted helper: a `cim` document on an active campaign gives `materials-received`.
- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/pursuitTrackerStorage.test.js`. Expected: FAIL with `recordPursuitSimIntake is not a function`.
- [ ] **Step 3: Implement the extraction, both adapters and the RPC.**
- [ ] **Step 4: Run** the SQLite and gated Postgres commands from Task 1, plus `node --test test/documentVault.test.js test/pursueCimGmailEndToEnd.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: SIM intake storage that converges materials on both adapters`.

### Task 5: Read service and `GET /api/admin/deal-hunter/pursuing`

**Files:**
- Create: `server/services/pursuedDeals.js`, `test/httpPursuedDeals.test.js`
- Modify: `server/app.js` (route after the auto-pursue routes, `:2462-2505`)

**Interfaces:**
- **Consumes:** `listPursuitBundles` (Task 2), `foldPursuitStage`, `STAGE_LABELS` and `buildGmailThreadUrl` (Task 3), `getPursueCimReleaseReport({ storage, opportunityId, now })` (`pursueCimRelease.js:143`), `storage.getGmailConnection()`, and `config.dealHunter.gmail.senderAddress`.
- **Produces** `listPursuedDeals({ storage, config, stage = 'all', role, now }) -> { ok: true, status: 200, asOf, counts: { needsAction, byStage }, rows, truncated }`, or `{ ok: false, status: 400, code: 'invalid_stage' }`.
  - `stage` is one of `all`, `needs-action`, or a stage id.
  - The sort is spec §6.1, and rows are capped at 200.
  - `counts` covers all members, whatever the filter.
- **Produces** `buildPursuedDealRow({ bundle, projection, release, role, gmailAddress }) -> row`. It has the spec §6.1 fields, plus `passedInDealHunter` and `opportunityActive`.
  - For a viewer: `gmailThreadUrl` is absent and `needsAction.replyId` is deleted.
  - `release` is `{ status, canStop, campaign: { id, state, rowVersion, terminalRevision } | null }`, or `null` with `releaseUnavailable: true` when the report throws.
- **Produces** `getPursuedDealRow({ storage, config, opportunityId, role, now }) -> row | null`. Later tasks use it to return the updated row.
- Release reports run through `mapWithConcurrency(items, 8, fn)`, a local helper in `pursuedDeals.js`.
- **Route:** `GET /api/admin/deal-hunter/pursuing?stage=…`. It uses `requireAdminAccess`, answers `401 { success: false, error: 'Authenticated admin access is required.' }` without access, and otherwise returns `{ success: result.ok, ...result }`.

- [ ] **Step 1: Write the failing HTTP tests in `test/httpPursuedDeals.test.js`.**
  - Use the harness pattern from `test/httpGmailConnection.test.js:1-110`, with a viewer user.
  - Seed through `getStorage()` with the world helpers. The fixture helpers accept a backend whose `storage` is `getStorage()`, plus a `Database` handle on `SQLITE_PATH`.
  - `createWorld` installs a global fake clock (`pursueCimEndToEndFixture.js:61`), so log in only after `createWorld`, at the world's time.

```js
test('admin sees the reply row first with a Gmail link; a viewer gets neither the link nor the reply id', async () => {
  const admin = await get(origin, '/api/admin/deal-hunter/pursuing', adminCookie);
  const [first] = JSON.parse(admin.body).rows;
  assert.equal(first.needsAction.reason, 'reply');
  assert.match(first.gmailThreadUrl, /^https:\/\/mail\.google\.com\/mail\/\?authuser=owner%40uckele\.test#all\//);
  const viewer = JSON.parse((await get(origin, '/api/admin/deal-hunter/pursuing', viewerCookie)).body);
  assert.equal(JSON.stringify(viewer).includes(first.needsAction.replyId), false);
  assert.equal('gmailThreadUrl' in viewer.rows[0], false);
});
test('rows carry the release campaign id, row version and terminal revision the stop route needs', …);
test('stage filter, needs-action filter and exact counts; unknown stage is 400 invalid_stage', …);
test('more than 200 members returns 200 rows and truncated: true', …);  // seed 201 decisions cheaply via recordOwnerDecision on seeded opportunities
test('a row whose release report throws shows releaseUnavailable and the page still loads', …);
test('anonymous read is 401', …);
```

- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/httpPursuedDeals.test.js`. Expected: FAIL with 404 for the route.
- [ ] **Step 3: Implement `pursuedDeals.js` (read half) and the route.**
- [ ] **Step 4: Run** `node --test test/httpPursuedDeals.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: read pursued deals with stage, attention, release status and role-safe Gmail links`.

### Task 6: Reply-type, stage-move and acknowledge routes

**Files:**
- Modify: `server/services/pursuedDeals.js`, `server/app.js`, `test/httpPursuedDeals.test.js`

**Interfaces:**
- **Consumes:** `recordPursuitStageEvent`, `pursuitStageRequestDigest` (Task 1), `stageAfterReplyType` and `foldPursuitStage` (Task 3), and `getPursuedDealRow` (Task 5).
- **Produces** `recordPursuitOwnerEvent({ storage, config, opportunityId, kind, input, actor, role, now }) -> { ok, status, code?, error?, row?, replay? }`.
  - `kind` is `'reply-type'`, `'stage-move'` or `'acknowledge'`.
  - **Validation:**
    - `idempotencyKey` uses the regex at `dealHunterTriage.js:1222-1225`.
    - `expectedLatestEventId` is required for `reply-type` and `stage-move`. It is `'genesis'` or an id. `acknowledge` sends `null`.
    - `replyType` is in `PURSUIT_REPLY_TYPES`; `stage` is in `PURSUIT_STAGES`.
    - `acknowledgedReplyId` is required for `acknowledge` and optional otherwise.
  - `fromStage` comes from a fresh fold. `stage` is `stageAfterReplyType(fromStage, replyType)`, the requested stage, or `fromStage`.
  - **Conflict → status:**
    - `not_pursued` → 404
    - `unknown_reply` → 422
    - `pursuit_stage_changed`, `idempotency_conflict`, `opportunity_not_active` → 409
    - A replay → 200 `{ replay: true }`
- **Routes** (`requireAdmin`; 401 `Administrator access is required.`):
  - `POST /api/admin/deal-hunter/pursuing/:opportunityId/reply-type`
  - `POST /api/admin/deal-hunter/pursuing/:opportunityId/stage`
  - `POST /api/admin/deal-hunter/pursuing/:opportunityId/acknowledge`

- [ ] **Step 1: Write the failing HTTP tests.**

```js
test('one reply-type click moves the stage, clears attention, and Undo moves it back', async () => {
  const recorded = await postJson(`${base}/${id}/reply-type`, { replyType: 'nda-requested', idempotencyKey: k1, expectedLatestEventId: 'genesis', acknowledgedReplyId: replyId }, admin);
  assert.deepEqual([recorded.status, recorded.json.row.stage, recorded.json.row.needsAction], [200, 'nda-sent', null]);
  const undo = await postJson(`${base}/${id}/stage`, { stage: 'broker-replied', idempotencyKey: k2, expectedLatestEventId: recorded.json.row.latestEventId }, admin);
  assert.equal(undo.json.row.stage, 'broker-replied');
});
test('not available moves the deal to passed in this tab only: no owner decision, no CRM archive, campaign unchanged', …);
test('two replies then one click: the later reply still needs action', …);              // Review Focus 5
test('a stale expectedLatestEventId is 409 pursuit_stage_changed; same key replays; same key other body is 409 idempotency_conflict', …);
test('acknowledge clears a bounce row', …);
test('viewer and anonymous writes are 401 and write nothing', …);
test('unknown reply id is 422 unknown_reply; watched deal is 404 not_pursued', …);
```

- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/httpPursuedDeals.test.js`. Expected: the new tests FAIL with 404.
- [ ] **Step 3: Implement `recordPursuitOwnerEvent` and the three routes.**
- [ ] **Step 4: Run** `node --test test/httpPursuedDeals.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: one-click reply type, stage moves and acknowledgements for pursued deals`.

### Task 7: Streaming SIM upload route

**Files:**
- Create: `server/services/pursuedDealsSimUpload.js`
- Modify:
  - `server/services/documentVault.js`: export `sanitizeFileName` `:98` and `bufferMatchesMimeType` `:245`, unchanged
  - `server/app.js`: middleware after `:675` and before the global parser `:736`; `createApp({ …, diskStats = (dir) => fs.promises.statfs(dir) })`
  - `test/httpPursuedDeals.test.js`

**Interfaces:**
- **Consumes:** `recordPursuitSimIntake` and `getPursuitStageEventByIdempotencyKey` (Tasks 1, 4), `getPursuedDealRow` (Task 5), `persistSecureDocumentCleanupJob` and `updateSecureDocumentCleanupJobState` (`secureDocumentCleanupState.js:212`, `:240`), `registerSecureDocumentCleanupIntent` and `unregisterSecureDocumentCleanupIntent`, `assertCrmSubmissionWritable`, and `buildCrmActivityEvent`.
- **Produces:**
  - `SIM_MAX_BYTES`.
  - `checkSimUploadHeaders(headers) -> { ok: true, idempotencyKey, fileName, contentLength, acknowledgedReplyId } | { ok: false, status, code }`. It runs the spec §8.1 step 3 order: 415, 411, 413, 400 `invalid_idempotency_key`, 400 `invalid_file_name`.
    - The file name is `decodeURIComponent` inside `try`, then `path.basename`, then `sanitizeFileName`, then `.pdf` appended if missing.
  - `receivePursuitSimUpload({ storage, config, request, opportunityId, headers, actor, role, diskStats, now }) -> { status, body }`, which:
    1. replays by key (`request.destroy()` without reading, then `200 { success: true, replay: true, row }`);
    2. resolves the latest campaign's `crm_submission_id`, then `assertCrmSubmissionWritable` (409 `crm_superseded`);
    3. checks disk admission: `(await diskStats(storageDir)).bavail * bsize - contentLength >= max(2**30, 2 * statSync(SQLITE_PATH).size)`, else 507 `storage_full`;
    4. persists the write-ahead cleanup job with exactly spec §8.4 step 1's `metadata` and `files`, and **no `requestId`**;
    5. streams with `stream.pipeline(request, check, fs.createWriteStream(finalPath, { flags: 'wx', mode: 0o600 }))`, into `storageDir/<requestId>/` (mode 0700). `check` counts bytes (413 past `contentLength` or `SIM_MAX_BYTES`), verifies `%PDF-` on the first 5 bytes (422 `not_a_pdf`), and updates a sha256;
    6. requires bytes == `Content-Length`;
    7. calls `recordPursuitSimIntake`;
    8. settles the job.

    On any failure before commit, it unlinks the file and settles the job `completed`.
- **Middleware order on `POST /api/admin/deal-hunter/pursuing/:opportunityId/sim`:**
  1. `requireAdmin` (401);
  2. the capacity gate on the shared `activeSecureUploads` (503 + `Retry-After: 30`, released on `finish` or `close`, as at `:651-674`);
  3. `checkSimUploadHeaders`;
  4. `receivePursuitSimUpload`.

  No body parser is mounted on this path.
- **Success:** `201 { success: true, document: { id, name, sizeBytes, uploadedAt }, row, stoppedFollowUps }`, where `stoppedFollowUps` is the prior `release.canStop`.

- [ ] **Step 1: Write the failing HTTP tests.**

```js
test('a PDF upload stores a 0600 file, marks SIM received, and stops follow-ups', async () => {
  const response = await upload(id, pdfBytes, { name: encodeURIComponent('Acme SIM (final).pdf') });
  assert.equal(response.status, 201);
  assert.equal(response.json.row.stage, 'cim-received');
  assert.equal(response.json.stoppedFollowUps, true);
  assert.equal((fs.statSync(storedPath).mode & 0o777), 0o600);
  assert.equal((await world.campaignFor(id)).state, 'materials-received');
});
test('anonymous and viewer uploads are 401 before any body byte is read', …);       // server-side counter on request 'data' stays 0
test('a full capacity gate is 503 with Retry-After 30 before any body byte is read', …);
test('header refusals: 415 pdf_only, 411 length_required, 413 by header, 400 invalid_idempotency_key, 400 invalid_file_name for %E0%A4%A', …);
test('a body longer than its Content-Length or 25 MiB is 413 and leaves no file', …);
test('a PNG renamed .pdf is 422 not_a_pdf and leaves no file', …);
test('../../etc/x.pdf is stored as a sanitized basename inside the request directory', …);   // Review Focus 2
test('507 storage_full when diskStats reports less than the reserve', …);              // createApp({ diskStats: async () => ({ bavail: 1, bsize: 4096 }) })
test('a replayed key returns the first result without reading the body', …);
test('a client abort mid-stream leaves no file and frees the capacity slot', …);
test('no campaign is 409 no_crm_record', …);
test('an upload during a backup leaves both consistent', …);                          // start createBackupBundle, upload, await both; verifyBackupBundle(...).ok and the document row exists
```

- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/httpPursuedDeals.test.js`. Expected: the new tests FAIL with 404.
- [ ] **Step 3: Implement the module, the exports and the middleware chain.**
- [ ] **Step 4: Run** `node --test test/httpPursuedDeals.test.js test/documentVault.test.js test/app.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: stream owner SIM uploads into the vault with capacity, disk and cleanup guards`.

### Task 8: Pursued deals tab

**Files:**
- Create: `src/components/admin/PursuedDeals.jsx`, `src/components/admin/PursuitReplyTypeControl.jsx`, `src/components/admin/pursuedDealsApi.js`, `test-ui/PursuedDeals.test.jsx`
- Modify:
  - `src/pages/DashboardPage.jsx`: lazy import beside `:43`; `showDealHunterPursued` at `:1403-1404`; render at `:3923`; nav `:3927-3929`
  - `src/components/admin/AcquisitionInbox.jsx`: nav `:1325`

**Interfaces:**
- **Consumes:** the routes from Tasks 5–7.
- **Produces, in `pursuedDealsApi.js`:**
  - `loadPursuedDeals(stage) -> Promise<response json>`
  - `recordReplyType({ opportunityId, replyType, expectedLatestEventId, acknowledgedReplyId, idempotencyKey })`
  - `moveStage({ …, stage })`
  - `acknowledgeReply({ opportunityId, acknowledgedReplyId, idempotencyKey })`
  - `uploadPursuedSim({ opportunityId, file, idempotencyKey, acknowledgedReplyId })`. It always sends `Content-Type: application/pdf` and `X-File-Name: encodeURIComponent(file.name)`, and refuses client-side, with "Only PDF files can be uploaded as a SIM.", unless the name ends in `.pdf` (case-insensitive) or `file.type === 'application/pdf'`.
- **Produces** `<PursuitReplyTypeControl name row readOnly onRecorded />`: spec §7.2. Idempotency keys live in a ref keyed by `${opportunityId}:${signature}`, as at `AcquisitionInbox.jsx:672-674`. Undo calls `moveStage` back to `from_stage`.
- **Produces** `<PursuedDeals readOnly />` at `/admin/deal-hunter?view=pursued`, with spec §7.1 chips, rows and band. The release status renders with `formatLabel(release.status.code)`, as in `OpportunityDrawer.jsx:281`.
- Every string is exactly spec §7.1 and §7.5.

- [ ] **Step 1: Write the failing Vitest tests in `test-ui/PursuedDeals.test.jsx`.**
  - `defaults to Needs your action when any row needs action and shows the counts on every chip`
  - `one click on NDA requested posts the reply type and shows Recorded: NDA requested. Undo`, then `Undo posts a stage move back`
  - `SIM received records the type then opens the upload control focused; Upload later closes it`
  - `uploadPursuedSim sends application/pdf for a .pdf file whose type is empty` (Review Focus 1)
  - `a 409 shows the refresh copy and reloads`
  - `upload errors map to the spec copy` (each code to its §7.5 string)
  - `read-only shows the viewer copy and no write controls or Gmail link`
  - `Open in Gmail opens in a new tab with noopener noreferrer`
  - `Stop SIM requests posts the release campaign id, row version and terminal revision to cim-release/stop`
  - `nav shows Pursued deals between Inbox and Operations`
  - `a deal passed in Deal Hunter shows Passed with the note Passed in Deal Hunter and no write controls`
  - `a merged opportunity (opportunityActive false) shows Merged into another listing and no write controls`
  - `a row with releaseUnavailable shows Status unavailable`
  - `truncated shows Showing the first 200. Use a stage filter to see the rest.`
- [ ] **Step 2: Run them and confirm they fail.** Run `npm run test:ui -- PursuedDeals` outside the sandbox. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the three files and the navigation.**
- [ ] **Step 4: Run** `npm run test:ui -- PursuedDeals AcquisitionInbox` outside the sandbox. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Pursued deals tab with one-click reply type and SIM upload`.

### Task 9: Broker replies in Needs Your Action

**Files:**
- Modify: `src/components/admin/AcquisitionInbox.jsx`: fetch beside `:415-429`; block inside `renderInboxArea` `:1290-1320`
- Test: `test-ui/AcquisitionInbox.test.jsx`

**Interfaces:**
- **Consumes:** `loadPursuedDeals('needs-action')` and `PursuitReplyTypeControl` (Task 8).
- **Behavior:**
  - The block renders inside `action-preview` only, using the "SIM requested automatically today" structure (`:1305-1308`), with the heading **Broker replies** and a footer link `All pursued deals →` to `?view=pursued`.
  - Rows without `needsAction` are ignored. Existing tests that answer every URL with a queue response therefore stay green.
  - The section's `No opportunities in this area.` text is hidden while the block has items.
  - A failed read hides the block, and the area renders exactly as today.

- [ ] **Step 1: Write the failing tests.**
  - `Needs Your Action lists a Gmail reply with Open in Gmail and the reply-type control`
  - `a bounce shows Bounced {date} and Mark handled`
  - `a delisted pursued deal still appears in Broker replies`
  - `the empty-area text is hidden while Broker replies has items`
  - `a failed pursuing read leaves the inbox unchanged`
  - `a viewer sees replies without write controls or Gmail links`
- [ ] **Step 2: Run them and confirm they fail.** Run `npm run test:ui -- AcquisitionInbox` outside the sandbox. Expected: the new tests FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** `npm run test:ui` outside the sandbox. Expected: PASS, the full suite.
- [ ] **Step 5: Commit** `feat: Broker replies block in Needs Your Action`.

### Task 10: End-to-end no-send proof on both adapters, and the PR

**Files:**
- Modify: `test/fixtures/pursueCimEndToEndFixture.js` (a new scenario in `END_TO_END_SCENARIOS`, `:711`)

**Interfaces:**
- **Consumes:** `listPursuedDeals` (Task 5), `recordPursuitOwnerEvent` (Task 6) and `receivePursuitSimUpload` (Task 7, driven with a `Readable.from([pdfBytes])` request stand-in carrying `headers`), on the world's storage.

- [ ] **Step 1: Add the scenario** `pursued deal: broker reply → Broker replies row → NDA requested → SIM upload → materials-received, with no email sent after the initial`.
  - Run `autoPursuedAndSent`, then `brokerReplies`, then `pollAt`.
  - Assert `listPursuedDeals(...).rows[0].needsAction.reason === 'reply'`.
  - Record `nda-requested`, then assert `stage === 'nda-sent'` and `needsAction === null`.
  - Upload, then assert `stage === 'cim-received'` and the campaign `materials-received`.
  - Assert `world.mailProvider.sent.length` equals its value right after the initial, and that it is still unchanged after `await sendAt(world, pacific('2030-01-09', '08:05'))` and `await sendAt(world, pacific('2030-01-14', '08:05'))`.
- [ ] **Step 2: Run it.**
  - `node --test test/pursueCimGmailEndToEnd.test.js`: PASS.
  - `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test --test-concurrency=1 test/pursueCimGmailEndToEndPostgres.test.js`: PASS.
- [ ] **Step 3: Commit** `test: pursued deals tracker end to end sends nothing on both adapters`.
- [ ] **Step 4: Run the full checks before the PR.**
  - `npm test`: PASS.
  - `npm run test:ui`, outside the sandbox: PASS.
  - `npm run build && PLAYWRIGHT_PORT=4273 npm run test:browser`, outside the sandbox: PASS, with no new spec.
  - `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test --test-concurrency=1 $(ls test/*Postgres*.test.js)`: PASS.
  - `npm run lint`: clean.

  The PR body links the spec and states that it depends on PR A. It lists the rollout steps from spec §11 steps 2–4: Supabase applies `20261105120000_pursuing_tracker.sql` before the deploy, the controlled Gmail test, and the post-backup link-count check.
