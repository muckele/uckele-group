# Acquisition Inbox v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Acquisition Inbox the default Deal Hunter daily operating surface, with acquisition-priority triage, a consolidated opportunity drawer, durable operator-verified facts/provenance, and Pursue / Watch / Pass actions without changing machine scoring or outbound automation.

**Architecture:** Extend the existing `dealHunterTriage` service and admin routes rather than create a parallel backend. Add two bounded durable projections—operator facts and source observations—owned by the canonical opportunity ID, then compose a lightweight Inbox list response and a richer opportunity-detail response from existing scores/evidence, canonical opportunity state, CRM/CIM history, source provenance, and operator facts. Keep machine scoring, canonical identity, CIM delivery, Stage 2, and acquisition pipeline semantics unchanged.

**Tech Stack:** Node 22.23.2, Express 4, React 18, React Router, SQLite (`better-sqlite3`), Supabase/Postgres, Tailwind CSS, Vitest/Testing Library, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-acquisition-inbox-v1-design.md`

## Global Constraints

- Inbox is the default Deal Hunter destination.
- Machine owns score/confidence/evidence/canonical identity; operator owns review/priority/note/verified facts/pass; acquisition pipeline owns CIM and later stages.
- Primary Phase 1 actions are Pursue / Watch / Pass.
- Pursue = mark reviewed at current semantic digest + priority `high`; no CIM send or Stage 2.
- Watch = mark reviewed + priority `watch`.
- Pass = existing durable disposition/dismissal + review acknowledgement.
- Operator-verified facts outrank direct CRM/broker data, structured sources, and future enrichment suggestions.
- Structured-source refreshes must never overwrite operator-verified facts.
- Phase 1 does not independently scrape marketplace pages.
- Show “Not provided” only for acquisition-critical missing fields; omit empty low-value fields.
- Opening/paging Inbox or Opportunity View must never trigger scoring/backfill.
- Preserve the durable CIM outreach pause and all outbound automation safety behavior.
- SQLite and Supabase behavior must remain semantically equivalent.
- No new scoring policy, canonical identity algorithm, pipeline enum, or Stage 2 behavior.

---

## Task 1 — Isolated Phase 1 worktree + approved docs

- Verify `/Users/Matt/Documents/uckele-group-deploy-readiness` is clean and `HEAD = local main = origin/main = b385585c451cb68769c764deb7227b3d07fb4b36`.
- Use `superpowers:using-git-worktrees`.
- Create `/Users/Matt/Documents/uckele-group-acquisition-inbox-v1` on `codex/acquisition-inbox-v1`.
- Add:
  - `docs/superpowers/specs/2026-08-30-acquisition-inbox-v1-design.md`
  - `docs/superpowers/plans/2026-08-30-acquisition-inbox-v1.md`
- Run placeholder scan + `git diff --check`.
- Commit: `Document Acquisition Inbox v1`.

## Task 2 — Durable operator facts + source provenance

**Create**
- `server/services/dealHunterOpportunityFacts.js`
- `test/dealHunterOpportunityFacts.test.js`

**Modify**
- `server/storage/sqlite.js`
- `server/storage/supabase.js`

**Storage interfaces**
```js
listDealHunterOpportunityFacts(opportunityId)
upsertDealHunterOpportunityFact(fact)
listDealHunterOpportunitySourceObservations(opportunityId)
upsertDealHunterOpportunitySourceObservation(observation)
```

**Fact service**
```js
normalizeOpportunityFactField(field)
setOperatorOpportunityFact({ opportunityId, field, value, actor, verified, note, storage })
getEffectiveOpportunityFacts({ opportunityId, sourceFacts, crmFacts, operatorFacts })
```

**Supported Phase 1 operator fields**
```js
[
  'seller_name',
  'seller_email',
  'seller_phone',
  'broker_name',
  'broker_company',
  'broker_email',
  'broker_phone',
  'reason_for_sale',
  'real_estate_included',
  'seller_financing',
  'management_structure',
  'customer_concentration',
  'operator_contact_notes'
]
```

**Required RED coverage**
- verified operator fact survives source refresh;
- precedence: operator > CRM/direct > structured source > enrichment suggestion;
- suggestions cannot overwrite verified facts;
- malformed/unsupported fact fields reject;
- SQLite/Supabase shapes match;
- history remains queryable.

Commit: `Add opportunity facts and provenance storage`.

## Task 3 — Persist source observations at canonical ingestion

**Modify**
- `server/services/dealHunter.js`
- `server/services/dealHunterOpportunityFacts.js`
- relevant source/import tests

**Required behavior**
- Google Sheet and Deal OS observations persist separately;
- source disagreement is preserved;
- deterministic observation identity prevents unbounded duplicates;
- no raw workbook/file blobs are retained;
- repeated source refresh updates the source observation;
- operator facts remain untouched;
- no listing-page scraping is added.

Run canonical/current-semantics + source-import tests.

Commit: `Persist Deal Hunter source observations`.

## Task 4 — Acquisition Inbox queue semantics

**Modify**
- `server/services/dealHunterTriage.js`
- `server/storage/sqlite.js`
- `server/storage/supabase.js`
- `server/app.js`

**Create**
- `test/dealHunterTriage.test.js`

**Add**
```js
sort: 'acquisition-priority'
```

**Priority order**
1. urgent/high operator priority;
2. high-fit + new/changed;
3. higher fit score;
4. confidence high > medium > low;
5. newest observation;
6. deterministic final tie-breaker.

**Add summary**
```js
{
  needsReview,
  highPriority,
  watchlist,
  lowConfidence,
  currentOpportunities
}
```

**Required tests**
- sorting order;
- summary equals underlying view semantics;
- paginated DB-side behavior;
- lightweight row contains financial scan fields and workflow summary but not full evidence;
- opening/paging does not score.

Commit: `Add Acquisition Inbox queue semantics`.

## Task 5 — Consolidated opportunity detail + actions

**Modify**
- `server/services/dealHunterTriage.js`
- `server/services/dealHunterOpportunityFacts.js`
- `server/app.js`

**Detail response**
```js
{
  opportunity,
  effectiveFacts,
  operatorFacts,
  sourceObservations,
  missingCriticalFields,
  listingUrls,
  score,
  cimSummary,
  crmSummary,
  history
}
```

**Add fact mutation**
```text
PUT /api/admin/deal-hunter/opportunities/:opportunityId/facts/:field
```

**Add Pursue/Watch convenience action**
```text
POST /api/admin/deal-hunter/triage/:opportunityId/action
```

- Pursue maps to existing decision service with `priority=high` + markReviewed.
- Watch maps to `priority=watch` + markReviewed.
- Pass continues using existing disposition boundary and must only mark reviewed when dismissal succeeds.
- Read-only users may GET, not mutate.
- No CIM send or Stage 2 path is called.

**Detail tests**
- effective fact precedence;
- source-by-source observations;
- listing URL dedupe;
- source conflict projection;
- acquisition-critical missing fields only;
- CRM/CIM history read;
- score/evidence read;
- superseded opportunity cannot masquerade as current authority.

Commit: `Add consolidated opportunity detail workflow`.

## Task 6 — Default Acquisition Inbox UI + drawer

**Create**
- `src/components/admin/AcquisitionInbox.jsx`
- `src/components/admin/OpportunityDrawer.jsx`
- `test-ui/AcquisitionInbox.test.jsx`
- `test-ui/OpportunityDrawer.test.jsx`

**Modify**
- `src/pages/DashboardPage.jsx`
- `src/components/admin/DealHunterTriage.jsx` only for small reusable presentation extraction if needed.

**UI requirements**
- `/admin/deal-hunter` opens Inbox by default;
- Operations remains separately reachable;
- summary strip;
- Needs Review default;
- dense desktop list, compact mobile cards;
- search/filter/sort/pagination;
- Pursue / Watch / Pass;
- right-side desktop drawer and mobile full-height view;
- sections: Overview, Business & Financials, Broker & Seller, Score & Evidence, Sources, CRM/CIM, Notes & History;
- safe original listing links;
- provenance labels;
- “Not provided” only for critical fields;
- Add/Edit verified operator facts;
- no send actions in Phase 1.

Commit: `Build Acquisition Inbox experience`.

## Task 7 — Error states, accessibility, responsive hardening

**Required tests**
- degraded source banner leaves persisted Inbox usable;
- detail error keeps queue usable and supports retry;
- failed mutation preserves prior durable value and announces error;
- Escape closes drawer;
- focus returns to triggering control;
- dialog semantics and keyboard flow;
- mobile exposes all primary actions;
- browsing/detail loading never calls score refresh/backfill.

Commit: `Harden Acquisition Inbox interactions`.

## Task 8 — End-to-end Phase 1 acceptance

**Modify**
- `docs/deal-scoring-and-triage.md`
- Playwright admin smoke spec
- operator docs referring to old default Deal Hunter workspace

**Browser acceptance**
- Deal Hunter opens to Inbox;
- summary counts load;
- Needs Review priority order;
- filters/search;
- drawer keeps queue context;
- source/listing/broker/evidence sections render;
- operator fact persists and survives simulated source refresh;
- Pursue/Watch preserve machine score;
- Pass retains historical visibility;
- no send/Stage 2 endpoint invoked.

**Validation**
```bash
node --test test/dealHunterOpportunityFacts.test.js test/dealHunterTriage.test.js test/dealHunterSourceImport.test.js
npx vitest run test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx
git diff --check
npm run check
npm run test:browser
```

Require zero failures/skips/todos, lint clean, build/prerender green, browser green.

Final prohibited-scope review:
- no scoring policy changes;
- no canonical identity algorithm changes;
- no Stage 2/send behavior changes;
- no outreach-pause changes;
- no independent marketplace scraper.

Stop with:
`READY FOR PHASE 1 INDEPENDENT REVIEW`

---

## Self-review

Coverage includes default Inbox/navigation, summary counts, acquisition-priority ordering, responsive dense queue, Pursue/Watch/Pass, consolidated drawer, source-by-source provenance, critical missing information, operator fact precedence and refresh survival, score/evidence explanation, CRM/CIM history, security/read-only behavior, provider parity, error/degraded states, non-scoring browsing, and full CI/browser acceptance.

No new pipeline state machine is introduced. Existing triage owns priority/review/note, existing disposition owns Pass, acquisition command center owns later stages, and scoring/canonical identity remain machine-owned.
