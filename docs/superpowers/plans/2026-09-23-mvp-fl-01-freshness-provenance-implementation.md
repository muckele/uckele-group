# MVP-FL-01 Freshness Provenance and Inbox Implementation Plan

> **For the later implementation owner:** Use superpowers:executing-plans with one implementation owner, focused commits, autonomous in-scope corrections, and one independent reviewer of the completed outcome. The checkboxes track work; they are not repeated owner-approval gates.

**Goal:** Make the existing Acquisition Inbox show defensible new discovery, supported listing age, and supported material changes while preserving urgent work and the existing authority boundaries.

**Architecture:** Extend the two approved durable tables and current records at the existing admitted Sheet and Deal OS boundaries. Keep source evidence separate from canonical identity and mutable current observations. Read action and discovery areas through one provider-owned, snapshot-consistent queue contract before rendering them in the mounted Inbox.

**Tech stack:** Node.js ESM, better-sqlite3, Supabase/Postgres SQL and RPCs, React/Vite, node:test, Vitest, Playwright Chromium.

**Approved spec:** docs/superpowers/specs/2026-09-23-mvp-fl-01-freshness-provenance-design.md at f13cfbee3cd7ffe97e73e1fd2984aac5d7f8996b, SHA-256 17ffe1c1c8c552f215cc18a3170ef26c0464c0a6674c11c59a60e935cb760fa7. Owner approved the two-table contract, 7-calendar-day New to UG, 30-calendar-day Recently listed, three material fields, three-row action preview, ten-row discovery first page, and specified independent counts/cursors. Keep the spec bytes unchanged.

## Global constraints and baseline

- Investigated code revision is fba00fd3579b49d64cc909dfc165a041604e600f; the design branch is codex/mvp-fl-01-freshness-design at f13cfbee3cd7ffe97e73e1fd2984aac5d7f8996b. Current remote main is 18a8645845be5c77c7422e0d20a49fa6003bef1b. The intervening main change is the documentation-only roadmap integration. After owner plan approval, the later executor should fetch and compare main again; if it still contains no conflicting runtime advance, create a new isolated codex/mvp-fl-01-implementation worktree from current main and carry the approved spec and plan documentation commits onto it without rewriting this design branch or the uncommitted FL-00 note. A new runtime advance requires explicit compatibility assessment before choosing the starting commit.
- Preserve existing identity matching, source admission, machine scoring, owner priority and review, Pass/archive, source-health blockers, 72-hour Deal OS export limit, and contact/send authority. FL-02 archive search, broad editing, complete unlinked Pursue-to-CRM handoff, and sending are outside FL-01.
- Do not interpret canonical created_at, date_added, observed_at, scored_at, or a new migration/import timestamp as universal first discovery. Existing canonical rows default to untracked_legacy and unknown first date. Supported recovery needs cited retained evidence.
- Date-only publication is a calendar date, never fabricated midnight. The current Sheet parser merges Date Added, Created, Posted Date, Date Listed, and Listing Date into dateAdded (server/services/dealHunter.js:640, 696-714); none proves publication merely by spelling. The same parser merges Annual Profit, Cash Flow, SDE, EBITDA, TTM EBITDA, Earnings, and Profit into annualProfit. Preserve original bounded header/value and source contract before normalization; until a source mapping proves meaning, publication or financial basis/currency/period is unknown and receives no recent-listing or comparable-change claim.
- All new freshness reads are read-only. No second task store, general event processor, raw workbook/event archive, source-authority bypass, or retired Postgres per-opportunity snapshot RPC.
- Use one implementation owner and one independent final reviewer. Commit coherent tested changes; do not run unchanged complete suites after every task.

## File and interface map

| Responsibility | Existing file or planned file | Boundary |
| --- | --- | --- |
| Bounded source/date/financial provenance | server/services/dealHunter.js; server/services/dealHunterOpportunityFacts.js | Carry original header, value, precision, offset, metric, currency, period and source-record identity before generic normalization drops them. |
| One-use complete Sheet admission | server/services/dealHunterSourceSnapshotAdmission.js | Fingerprint every fetched source record including unresolved ones and its exception link; existing private mint/consume remains sole Sheet capability. |
| Canonical continuity | server/services/cimOpportunityIdentity.js | Bind accepted events through existing proven resolver/exception resolution; never relax matching. |
| SQLite schema and transactions | server/storage/sqlite.js | Add two tables/columns; IMMEDIATE guarded acceptance, import, binding, material classification, review CAS, and consistent queue read. |
| Postgres schema and transactions | new dated supabase/migrations/20260923120000_deal_hunter_freshness_provenance.sql; supabase/schema.sql; server/storage/supabase.js | Versioned private admitted RPCs, fixed search path, RLS/role grants, source/canonical locks, and one-statement read projection. Replace the adapter call to the retired per-opportunity RPC with an admitted path or fail it closed. |
| Triage/API boundary | server/services/dealHunterTriage.js; server/app.js | Add expected freshness revisions on review and one area-query response without altering legacy score-review semantics or admin auth. |
| Mounted Inbox/detail | src/components/admin/AcquisitionInbox.jsx; src/components/admin/OpportunityDrawer.jsx | Compact action/priority preview, independent New & Important page, why-here facts, area-specific return state, accessible narrow/desktop presentation. |
| Focused verification | test/dealHunterSourceImport.test.js; test/dealHunterTriage.test.js; test/dealHunterAtomicPass.test.js; test/dealHunterFreshnessPostgres.test.js (new, using existing Docker/psql test style); test-ui/AcquisitionInbox.test.jsx; test-ui/OpportunityDrawer.test.jsx; test-browser/admin-phase16.spec.js | Real disposable-provider proof precedes UI transport mocks; extend the existing test stack. |

The provider interface to implement and keep identical in behavior is:

    allocateDealHunterSourceGeneration({ sourceId, runId }) -> { runId, generation } // caller supplies Deal OS import ID or Sheet UUID
    replaceAdmittedCompleteGoogleSheetSourceSnapshot({ source_id, source_name, records, admission, run }) -> { acceptedAt, projectionState }
    insertDealHunterDealOsImport({ ...existingRecord, freshnessRun, acceptedRowEvidence }) -> savedImport
    bindAcceptedDealHunterFreshness({ importId, exceptionId, opportunityId, expectedGeneration }) -> { bound, projectionState }
    readDealHunterInbox({ areas, filters, asOf, cursors }) -> { asOf, areas: { id, rows, total, counts, revision, nextCursor }[] }

Extend existing adapter methods where named above; the new binding/read methods remain service-role/private storage interfaces. The same IDs and acceptedAt from the admission/import transaction must flow into binding and projection. No source record may be minted by a queue/detail read.

## Review focus

1. An accepted older Deal OS row whose projection is superseded: preserve its evidence for proven later identity binding and earliest discovery; never let it replace newer current values (Task 2 provider test).
2. A complete Sheet collection containing an unresolved row: prove exact fetched scope, retain bounded evidence/exception, defer the entire current projection, and keep prior current rows (Task 2 provider test).
3. A pre-cutover current price lacking an evidence ID: first evidenced value is an unknown baseline, not a reported price rise/fall (Task 2 provider test).
4. A day boundary or intervening Pass/priority/score/import between area pages: continuation returns a stale-page refresh signal, with no skipped or duplicated rows (Task 3 provider test).
5. The same unlinked fresh opportunity in action and discovery: one canonical ID, consistent owner actions and count, with an honest CRM prerequisite (Task 4 UI/browser test).

---

### Task 1: Additive schema and bounded provenance input

**Dependencies:** Approved spec and current main comparison. **Deliverable:** SQLite and Postgres accept the same bounded source evidence shape, with legacy defaults and no enabled freshness labels.

- [ ] Add the named parser, legacy-default, catalog, uniqueness, and role assertions below.
- [ ] Run the Task 1 focused commands and confirm failures are contract failures.
- [ ] Add the approved schema and bounded parser fields.
- [ ] Run the same commands green and commit the schema/parser unit.

**Files:** Modify server/storage/sqlite.js, server/services/dealHunter.js, server/services/dealHunterOpportunityFacts.js, supabase/schema.sql. Create supabase/migrations/20260923120000_deal_hunter_freshness_provenance.sql. Extend test/dealHunterSourceImport.test.js and test/dealHunterOpportunityFacts.test.js; use new test/dealHunterFreshnessPostgres.test.js for catalog/role parity.

**Schema contract:** Add deal_hunter_source_freshness_state keyed by nonblank source_id, with next_generation, accepted_generation, accepted_run_id, accepted_digest, accepted_at, and projection_state. Enforce nonnegative monotone generation and bounded IDs/digest; initial accepted generation is 0. Add deal_hunter_freshness_evidence with immutable event ID, source/run/generation/record identity, event_type, non-null field_key default empty string, non-null event_ordinal default 0, DB-assigned accepted_at, nullable original/current canonical IDs and exception ID, bounded publication and typed before/after material fields, evidence references, classification, material revision, and provenance version. Unique(run_id, source_id, source_record_id, event_type, field_key, event_ordinal) uses no nullable uniqueness component: Postgres and SQLite must reject the same duplicate even when canonical/field evidence is absent. Index canonical/time, source-record/time, and run/source/record. Guard event payload UPDATE/DELETE; only audited current-canonical binding/reparent and reference-safe pruning of settled, unreferenced no-op Deal OS events are allowed. Historical discovery/publication/material/state-change events remain retained. Add nullable first_accepted_at and first_discovery_evidence_id, discovery_state, discovery_revision, material_revision, last_material_change_at to opportunities; accepted_at/run/evidence and bounded publication fields to current observations; reviewed_discovery_revision and reviewed_material_revision to scores. Add bounded import generation/projection status to the existing Deal OS import record. Set old opportunity state to untracked_legacy and revisions to 0; old writers during schema-first rollout do not create prospective facts. Add CHECK/FK/index parity; no cascade from a replaceable current observation to immutable evidence. Postgres RLS is enabled, public/anon/authenticated lack table and RPC access, and service-role SECURITY DEFINER RPCs use a fixed search path.

**Interface/RED:** A normalized accepted source record carries sourceId, sourceRecordId, rawDateHeader/value/precision/offset/meaning, and per-field rawHeader/metric/currency/period; values are length-limited and never include workbook payload. Add cases to existing parser/facts tests that assert:

    assert.equal(dateEvidence.precision, 'date');
    assert.equal(dateEvidence.meaning, 'unknown');
    assert.equal(financialEvidence.metric, 'unknown'); // generic Annual Profit alias
    assert.equal(legacyOpportunity.discovery_state, 'untracked_legacy');
    assert.equal(legacyOpportunity.first_accepted_at, null);

Run proposed RED: node --test test/dealHunterOpportunityFacts.test.js test/dealHunterSourceImport.test.js and DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/dealHunterFreshnessPostgres.test.js. Expect failures specifically for missing retained fields/tables/constraints; do not treat an environment error as RED evidence.

**GREEN:** Add bounded provenance capture before parseDate and financial alias collapse; default unsupported publication/metric/currency/period to unknown. Verify both fresh Postgres schema and migration from the prior schema, role grants, duplicate-null behavior, and SQLite old-row defaults. Run the same focused commands to green. Commit schema/parser as one reviewable unit. Completion evidence is field/precision parity, migration/catalog assertions, and zero change to old review/send fields.

### Task 2: Guarded acceptance, binding, and real provider verification

**Dependencies:** Task 1 schema/shape. **Deliverable:** Every admitted Sheet and Deal OS path writes successful evidence at its actual boundary with retry, rollback, identity, and history behavior.

- [ ] Add the named real-ingestion, retry, rollback, deferred, superseded, and material assertions below.
- [ ] Run the Task 2 focused commands and confirm contract failures.
- [ ] Extend only admitted writer and identity-binding transactions.
- [ ] Run focused SQLite/Postgres and identity regression commands green; commit the writer/provider unit.

**Files:** Modify server/services/dealHunterSourceSnapshotAdmission.js, server/services/dealHunter.js (importDealOsExport at 2396 and attachCanonicalOpportunityIdentities at 5819), server/services/cimOpportunityIdentity.js, server/storage/sqlite.js (import insert at 8884, per-record/complete snapshots at 11202/11248), server/storage/supabase.js (import insert at 2520, per-record/complete snapshots at 3396/3419), the new migration and schema. Extend test/dealHunterSourceImport.test.js and test/dealHunterFreshnessPostgres.test.js. Preserve test/dealHunterDeduplication.test.js and existing admission tests.

**Write protocol:** Allocate generation before collection in a short transaction; gaps after failure are allowed. Complete Sheet admission fingerprints all fetched source-record IDs, bounded provenance, resolved canonical IDs or exception IDs, and count/digest; consuming the private capability remains one-attempt. Under one SQLite IMMEDIATE or Postgres source advisory-lock transaction, reject stale/conflicting generations, insert first/changed accepted evidence, and either replace the complete current scope and classify canonical changes or mark the scope deferred/unhealthy without deleting last-known rows when any identity is unresolved. Existing provisional identity/exception creation is not itself accepted discovery. The accepted watermark advances only after this transaction commits. SQLite assigns acceptedAt with its transaction clock; Postgres assigns it with the database clock inside the RPC. The caller never supplies a successful acceptance time. For Deal OS, the existing import insert becomes phase 1: import record, accepted-row events, database acceptedAt, generation, and pending status commit together; rejected upload/row writes none. Phase 2 binds proven identity and projects current observations idempotently under source then sorted canonical locks; it may project only if its generation is still latest, while an older superseded import may still bind its evidence for earliest discovery. Indeterminate older identity keeps first date unknown. Use current accepted evidence IDs before deleting/replacing observations. Comparable changes require retained before/after IDs and identical metric/basis, currency, period, and canonical ID; new evidence, conflict, projection swap, or disappearance gets its distinct classification and no false material revision. A no-op Sheet run may keep an older accepted_evidence_id; each accepted Deal OS row gets bounded acceptance evidence without a material revision. Retry the same run ID/digest only as an idempotent latest-run replay; older run fails closed. Remove/disable the Supabase adapter call to replace_deal_hunter_opportunity_source_observation_snapshot, which was dropped by the 20260831220000 retirement migration; do not recreate it.

**RED:** Extend the real import/collection fixture to assert exact event/first-date/material rows after a same-run-ID/digest retry **and** a separately accepted identical-CSV upload with a new import ID/generation, a proven Sheet/Deal OS match, a moved Sheet row, unresolved Sheet exception, later resolution, old superseded Deal OS import, legacy first refresh, A→B→A→B, stale generation, rollback injection, and source removal. Add named real SQLite/Postgres fixtures for (a) retained-evidence historical recovery with citation, and archive → reimport preserving Passed, followed by existing review-only restore that keeps contact stopped and does not reset discovery; (b) a synthetic source with an explicitly proven publication mapping, plus missing/malformed/future/conflicting date values and date-only precision; and (c) two simultaneous source claims that disagree on asking price, which must be a conflict rather than a canonical price rise. The synthetic publication mapping is a test contract, not permission to label unsupported production headers. Use direct disposable Postgres SQL RPC calls plus the repository's Docker/psql pattern and equivalent SQLite adapter calls; do not count an in-memory storage fake as provider parity. Assert, for example:

    assert.equal(sameRunRetry.acceptedRowEventCount, 1); // one accepted row, one run
    assert.equal(twoIndependentUploads.acceptedRowEventCount, 2); // same CSV, two import IDs
    assert.equal(twoIndependentUploads.discoveryRevision, 1);
    assert.equal(twoIndependentUploads.materialRevision, 0);
    assert.equal(events.filter(e => e.event_type === 'material_change').length, 3);
    assert.equal(opportunity.first_accepted_at, originalAcceptedAt);
    assert.equal(oldImport.projection_state, 'superseded');
    assert.equal(currentValue, newerImportValue);
    assert.equal(afterRollbackEvents.length, beforeRollbackEvents.length);

Run proposed RED: node --test test/dealHunterSourceImport.test.js and DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/dealHunterFreshnessPostgres.test.js. The Postgres test uses docker run --pull=never --network=none postgres:16, applies fresh schema and upgrade migration in disposable databases, verifies RLS/privileges, runs concurrent psql clients, and removes its container in t.after. Adapt existing test/dealHunterCrmReconciliationPostgres.test.js scaffolding rather than adding another framework.

**GREEN:** Implement admitted writer transactions and exception binding without changing resolver policy or scoring. Run focused real-provider tests plus node --test test/dealHunterDeduplication.test.js. Completion evidence includes DB-level rollback/idempotency/concurrency, retained events after current-row deletion, and proof that rejected input cannot mint discovery. Commit coherent writer/provider changes after they pass.

### Task 3: Freshness readers, review CAS, and independent area queries

**Dependencies:** Task 2 accepted evidence and current projections. **Deliverable:** SQLite and Postgres return equivalent owner-facing facts and consistent area rows/counts/revisions, and review acknowledges only versions actually shown.

- [ ] Add the named queue, time-boundary, stale-cursor, review-CAS, and unlinked assertions below.
- [ ] Run the Task 3 focused commands and confirm contract failures.
- [ ] Add the provider/API read and review transactions; measure query/resource plans.
- [ ] Run the same commands green and commit the reader/review unit.

**Files:** Modify server/storage/sqlite.js (listDealHunterOpportunityScores at 9533, setDealHunterOpportunityOperatorDecision at 9345, passDealHunterOpportunity at 9159), server/storage/supabase.js (same interfaces at 3110, 2980, 2958), server/services/dealHunterTriage.js (listTriageQueue at 280, setTriageOperatorDecision at 807, Pass path at 918), server/app.js (triage GET at 1714, decision/action POST at 1955/1974), supabase/schema.sql and the new migration (versioned queue/review/Pass RPCs). Extend test/dealHunterTriage.test.js, test/dealHunterAtomicPass.test.js, test/dealHunterFreshnessPostgres.test.js.

**Reader contract:** Extend the existing authenticated triage route for view=inbox to request action preview (limit 3) and New & Important (limit 10) in one provider read; view-all uses the same provider interface with one area and its own cursor/limit. Provider returns { asOf, areas: [{ id, rows, total, counts, revision, nextCursor }] }. Area IDs are action-preview, due-actions, owner-priorities, new-important, updated, research, all-active; these are query selections over existing canonical/score/workflow records, not task entities. The action preview reserves up to two due and one owner-priority distinct ID, then backfills; dual-qualified ID occupies one slot with both reasons. Each count is DISTINCT canonical ID and cross-area totals are never added as a unique-business count. New & Important includes only approved groups 1 then 2, independently of older group-0 work; groups 3–6 remain accessible. Apply existing active/disposition eligibility and all filters before ranking; project source-health and action blockers on retained rows rather than silently excluding them. Due-action membership uses the existing deal_hunter_cim_requests.next_follow_up_at and follow_up_state with server/services/dealHunterManualFollowUps.js eligibility; broker-reply/materials indicators use existing CRM communication and secure-upload/request state only when those states prove an owner action. Never infer a due task from an unverified attachment or raw message, and never let low-confidence or 40-fit newness imply recommended contact. Newest is first accepted discovery known-first; Highest Fit is existing fit; final tie is canonical ID.

**Coherent read boundary:** SQLite performs candidate selection, ordered compact-tuple revision, counts, and requested rows inside one read transaction. Postgres returns them from one service-role RPC/statement snapshot. The revision folds only eligible canonical ID, ordinal, membership/sort/visible-action tuple, and distinct total in deterministic order; do not join full evidence history or load unrelated tables for each page. Use a fixed-size Postgres ordered aggregate whose step hashes the previous state plus a length-framed compact tuple (md5 is sufficient as a reader-only change detector, not authorization), and a streaming hash over the same ordered tuples in SQLite; neither provider may build one giant JSON/string aggregate. The provider query and hash consume the same filtered ordered candidate projection. Cursor binds area, normalized filters/sort, asOf business date/time (configured owner timezone, currently America/Los_Angeles), last tuple, and revision. Continuation recomputes revision and returns 409 stale-page/restart when it differs; crossing the configured calendar-day boundary likewise requires refresh. New arrivals do not mutate an open client page. The detail return token retains area, cursor/page, row anchor, and scroll. Use representative synthetic data (at least 10,000 score rows and 30,000 current observations) to capture SQLite EXPLAIN QUERY PLAN, Postgres EXPLAIN (ANALYZE, BUFFERS), p50/p95 response latency and peak process/DB memory. A full evidence-table scan per page, unbounded JSON aggregation, or material regression against the existing queue baseline blocks completion until corrected. Add only indexes justified by those plans.

**Review CAS:** Extend the existing review/action request with expectedDiscoveryRevision and expectedMaterialRevision when markReviewed, Pursue, Watch, or Pass is initiated from a freshness-aware client. The provider checks both under the same transaction as the existing fingerprint/semantic-digest review and disposition write; mismatch returns 409 with no watermark or partial Pass. A legacy client lacking either expected value retains its old score-review/action behavior but advances neither freshness watermark. Machine score refresh never writes the operator-owned revisions.

**RED/GREEN:** Write real SQLite and Postgres provider assertions for group membership, counts, 3/10 limits, 7/30 calendar boundaries, equal-ranked IDs, cross-page cursor continuation, changed import/Pass/priority/score causing 409, stale review CAS, score-only refresh, and unlinked opportunity. Include reader assertions for the Task 2 publication fixtures: a supported valid date may be Recently listed, while missing/malformed/future/conflicting evidence is Age unknown and cannot enter group 1. Assert a cross-source price disagreement produces a research explanation, not Updated or a price-change badge. Verify archived/reimported/then-restored opportunity does not gain a New badge or resume contact. Run proposed RED: node --test test/dealHunterTriage.test.js test/dealHunterAtomicPass.test.js and DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/dealHunterFreshnessPostgres.test.js. Implement the provider read and service/API projection; run the same commands green. Capture actual query/resource measurements and commit the reader/review unit.

### Task 4: Rendered Inbox, detail context, and final acceptance

**Dependencies:** Task 3 provider/API contract and provider-backed tests. **Deliverable:** Mounted Acquisition Inbox visibly separates urgent work from discovery and preserves existing action authority.

- [ ] Add the named mounted UI and browser scenarios below after provider proof.
- [ ] Run focused UI/browser RED checks and confirm contract failures.
- [ ] Render the approved areas and return/conflict behavior.
- [ ] Run focused UI/browser checks green, then commit the rendered integration.

**Files:** Modify src/components/admin/AcquisitionInbox.jsx and, only for freshness/review display, src/components/admin/OpportunityDrawer.jsx. Extend test-ui/AcquisitionInbox.test.jsx, test-ui/OpportunityDrawer.test.jsx, and test-browser/admin-phase16.spec.js. Keep existing route, decision, materials, and CRM navigation controls.

**UI contract:** Default Inbox renders compact Needs Your Action with total due/overdue and owner-priority/urgent counts plus separate View all links, followed by New & Important with its own ten-row page and total. At supported desktop viewport, its heading and first row are visible without scrolling past old priorities; narrow layout keeps counts, links, focus order, and first-discovery access. An item in both areas uses the same opportunity ID/detail/action state; it is not a duplicate task. Display supported New to UG, Recently listed, Updated, Age unknown/existing-record, source health, and why-here basis without treating them as contact permission. Reuse Pursue/Watch/Pass and linked CRM route; show a genuine unlinked lead's prerequisite honestly. Preserve a draft and current rows on background arrivals, offer a restrained new-results indicator, handle stale cursor/review conflicts with reload, and restore area/filter/cursor/row/scroll/focus on detail close.

**RED:** UI tests assert the two area headings, distinct counts, due overflow View all, dual-qualified ID/state, unknown dates and blockers, review conflict, keyboard/focus and narrow layout. Browser tests exercise more than a page of old priorities plus one new worthwhile row, due overflow, dual-qualified row, equal-ranked area pagination, and detail return; browser transport may mock only after Task 3 provider parity is green. Include one genuinely unlinked opportunity. Run proposed RED: npm run test:ui -- test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx; after a build, npm run test:browser -- test-browser/admin-phase16.spec.js. Then implement and run those focused checks green. Commit the rendered integration.

**Final candidate gates (once on unchanged candidate):** npm run check (evaluation, lint, node tests, UI tests, build), DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test test/dealHunterFreshnessPostgres.test.js, and npm run test:browser -- test-browser/admin-phase16.spec.js. Hosted pull-request CI, if later authorized, must independently pass the repository workflow's npm audit --omit=dev, lint, npm test, npm run test:ui, build, and browser gate. A real failure is diagnosed and fixed; rerun only affected checks and the final complete gate after code changes. No deployment is implied.

## Approved acceptance coverage map

| Planned case | Owning task and required evidence |
| --- | --- |
| Same-run retry, independent identical CSV upload, concurrent acceptance, injected rollback | Task 2: real SQLite/Postgres writers; one event set for same import ID/digest retry, two bounded accepted-row event sets for two import IDs, one discovery, no false material revision or partial commit |
| Proven Sheet/Deal OS match, moved Sheet row | Task 2: canonical ID/first date unchanged across source and position |
| Delayed identity; unresolved complete Sheet; superseded old Deal OS import | Task 2: accepted bounded evidence, deferred current scope, later proven binding, no stale projection |
| Legacy first refresh; supported historical recovery; archive/reimport/restore | Tasks 1–2: unknown stays unknown absent proof; retained citation and disposition/contact state unchanged |
| Date-only, missing, malformed, future, conflicting publication | Tasks 1–3: raw meaning/precision retained; unsupported/conflicting age never boosted |
| Unchanged refresh, price increase/decrease, source disagreement, old unknown baseline | Task 2: only comparable retained before/after evidence creates material revision |
| A→B→A→B, stale run, source removal | Task 2: three distinct transitions, stale rejection, event survival after current-row removal |
| Score-only refresh, owner note, Pursue/Watch/Pass | Task 3: separate watermarks, expected pair CAS, legacy behavior, Passed absent from active discovery |
| Old priorities fill more than a page; worthwhile new row | Tasks 3–4: independent full-set queries, default discovery first page visible |
| Due work exceeds compact limit | Tasks 3–4: bounded preview, distinct totals and complete View all access |
| Fresh lead also high priority | Tasks 3–4: one canonical ID/actions, accurate per-area counts |
| Equal ranks, different pages, time boundary, detail return | Tasks 3–4: stable ID tie, revision conflict/refresh, area/cursor/row/scroll restored |
| Genuinely unlinked lead and unhealthy required source | Tasks 3–4: honest prerequisite/last-known data; no unauthorized contact readiness |

## Prerequisites and rollout boundary

Read-only checks performed during this planning task: local Node v24.19.0 and npm 11.17.0 are available; Docker daemon 29.6.1 responds and local postgres:16 image sha256:a50864fb29a78647fdea5923ab249a1f07c39474b18eb4a9cbd07bd7ebacc08f is present; a Playwright browser cache exists. This isolated design worktree has no node_modules, while the main checkout has them. No dependencies were installed and no container or test was run. The later executor must install dependencies in its authorized implementation checkout and confirm Chromium/config compatibility; CI uses Node 22. The disposable Postgres precedent is test/dealHunterCrmReconciliationPostgres.test.js, gated by DEAL_HUNTER_POSTGRES_INTEGRATION=1, with an offline postgres:16 container and mandatory cleanup.

Rollout order for a later separately authorized release: additive SQLite/Postgres schema and old-row unknown defaults; dual-compatible private writers including complete Sheet and Deal OS phase boundaries; real-provider parity and recovery proof; review CAS and read projection; default Inbox areas/UI; candidate gates and hosted CI; deployment only under separate authority. Enable freshness labels/ranking only after every admitted path can persist provenance. If a provider path cannot do so, fail freshness projection closed and preserve its existing source-error behavior. Do not require production historical repair for prospective correctness. The retired Postgres per-opportunity RPC remains absent. No migration, deployment, production import, or send is authorized by this plan.

**Plan-review decision:** The approved pilot parameters need no new owner choice. A later implementer must substantiate source-specific publication and financial mappings before activating those individual claims; unsupported meaning stays unknown rather than becoming a design reopening. Any actual contract contradiction should be brought back with evidence and one proposed resolution.
