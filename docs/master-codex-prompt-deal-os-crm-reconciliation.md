# Master Codex prompt: reconcile every Deal OS import into an accurate, duplicate-safe CRM

Use the prompt below in a fresh Codex task rooted at this repository.

---

You are working in the existing Uckele Group repository. Implement and verify a production-safe Deal OS import-to-CRM reconciliation system that accounts for every accepted CSV/XLSX row, maintains exactly one managed CRM record per canonical business opportunity, preserves deliberate deletions, reports ambiguous identities instead of guessing, and makes scoring accurate, explainable, versioned, and robust to incomplete source data.

Work through the implementation completely: inspect the current repository and available read-only operational evidence, confirm the root cause, make the smallest coherent changes that solve it, add equivalent SQLite and Supabase storage guarantees, implement a dry-run-first reconciliation workflow and legacy audit/repair tool, update the admin UI and runbook, add regression and concurrency tests, run the proportionate closure suite, perform two code-review passes, fix all findings, and report evidence. Do not stop after producing a plan.

## Working style

- Lead with verified evidence. Do not assume that a raw export row, a source listing, a canonical opportunity, and a CRM record have one-to-one cardinality.
- Follow existing repository patterns before introducing new abstractions. Prefer small, named pure functions and additive migrations over a big-bang rewrite.
- State each product rule once in code and reuse it across preview, execution, UI, scripts, SQLite, and Supabase.
- Keep import parsing, canonical identity resolution, scoring, CRM reconciliation, and outbound communication as separate boundaries.
- Make progress autonomously on safe local reads, edits, migrations, tests, and documentation. Stop before production writes, destructive cleanup, deployment, external messages, or any expansion of scope that needs approval.
- Preserve all unrelated worktree changes. Inspect `git status` before editing and before handoff. Do not stage, commit, delete, reformat, or overwrite files outside this task.
- Never expose secrets, cookies, session tokens, raw private email content, unrestricted recipient lists, or production database credentials in commands, logs, fixtures, screenshots, or the final report.

## Safety and authorization boundary

This prompt authorizes local code, test, migration, and documentation changes. It does **not** authorize:

- applying a production reconciliation or repair;
- archiving, deleting, merging, or restoring production CRM records;
- sending email, requesting a CIM, creating follow-ups, or changing outbound automation;
- crawling or scraping authenticated marketplace pages;
- broadening provider credentials or bypassing source policy;
- deploying, pushing, or committing;
- fabricating missing listing information.

Any production inspection must be read-only, bounded, and redacted. All repair/apply paths must default to dry run and fail closed unless a separately authorized administrator supplies the exact confirmation, a verified backup reference, and a fresh plan digest.

Do not weaken existing admin authentication, role checks, source-health gates, signed or expected-set freshness checks, durable tombstones, communication persistence, suppressions, archive guards, or CIM identity protections. CRM reconciliation must never implicitly trigger email, CIM requests, secure-document actions, or follow-up scheduling.

## Confirmed current-state evidence and root cause

Treat the following August 14, 2026 findings as a regression target, then re-verify them from current code and safe interfaces. Use synthetic data in committed tests.

1. The current SMB Deal OS export contained 261 accepted rows. The import validated and persisted the normalized source snapshot successfully.
2. A second current source contained 292 rows. Across both sources, 553 raw source rows resolved to 430 canonical opportunities because 123 rows represented duplicates or syndicated aliases.
3. A full scoring backfill evaluated all 430 canonical opportunities. That operation deliberately did not change CRM records.
4. The existing CRM sync selected only records returned by `dealHunterCrmCandidates`: not dismissed, not removed, score at least 75, and annual profit present. It therefore selected 11 high-fit canonical opportunities rather than the 261 uploaded rows.
5. The observed sync updated 10 existing CRM records, created none, and respected one durable `crm-deleted` tombstone. It did not fail, send email, request a CIM, or create follow-ups.
6. The CRM had 30 Deal Hunter records at the time of inspection. A read-only post-sync audit found legacy active records associated with the current candidate set, including records whose visible company/listing fields and nested Deal Hunter identity metadata did not describe the same canonical opportunity. The current run did not create those legacy inconsistencies.
7. The Deal OS export had no usable industry, description/notes, or broker-email values for the 261 rows. Other sources sometimes supplied those fields. Missing export data limited scoring evidence and enrichment; it must not be invented.
8. The current application explicitly parses uploads in memory and retains normalized fields and provenance. It does not crawl marketplace pages. Keep that boundary unless a separate, policy-reviewed data-source project is authorized.

The primary explanation is therefore not “250 rows failed to upload.” Upload, canonicalization, scoring, and high-fit CRM synchronization are separate workflows. The current CRM action is intentionally a high-fit subset action. The product lacks an explicit, safe “reconcile all canonical opportunities touched by this accepted import” workflow and lacks a complete row-to-outcome accounting report.

The implementation must preserve the useful distinction between raw rows and canonical opportunities. Writing all 261 raw rows as 261 independent CRM records would create duplicates whenever the CSV contains repeated listings, changing URLs, or marketplace syndication. The correct invariant is:

> Every accepted import row is accounted for exactly once, and every canonical opportunity touched by the import ends in exactly one explicit reconciliation outcome. At most one managed CRM record is the primary record for that canonical opportunity.

A canonical opportunity may legitimately have no active CRM record when it has a durable tombstone or an unresolved identity exception. Those outcomes must be visible and counted, not silently recreated or treated as success.

## Product behavior to implement

### 1. Establish an explicit import accounting contract

Extend the persisted Deal OS import record or add normalized child records so the system can answer, after every import:

- how many raw rows were read;
- how many rows were rejected and why;
- how many accepted rows were exact duplicates within the file;
- how many accepted rows matched aliases from another source;
- how many distinct canonical opportunities were touched;
- which import row IDs/source identities map to each canonical opportunity;
- how many opportunities were scored, unscorable, created in CRM, updated, unchanged, tombstoned, ambiguous, or failed;
- whether every accepted row and every touched opportunity has exactly one terminal accounting result.

Use immutable import IDs, a file digest, normalized source-row identity, row number, source stable ID when present, canonical `opportunity_id`, and timestamps. Do not store unrestricted raw workbooks merely for convenience. Retain only the current policy-approved normalized fields and provenance.

Validation must fail before persistence on malformed headers, unsupported encodings/types, stale exports, row-limit violations, impossible required values, or inconsistent coverage claims. Partial row failures must be explicit; never return a generic success message that hides skipped rows.

The API and UI must use precise language:

- “261 source rows accepted” does not mean “261 new CRM records.”
- “N canonical opportunities touched” is the reconciliation target.
- “N aliases collapsed” explains the difference.
- Tombstones, ambiguous identities, and failures are separate non-success outcomes.

### 2. Add field-level provenance and accuracy rules

For every CRM-managed listing field, preserve enough structured evidence to explain the selected value:

- normalized value and display value;
- source and source record/import ID;
- first and last observed time;
- confidence or validation state;
- whether the value was manually edited;
- competing values and the deterministic resolution rule when sources conflict;
- normalization/rule version.

At minimum cover company/listing name, listing URL and aliases, location, industry/categories, description/notes, asking price, revenue, profit/cash flow/EBITDA, margin, multiple, business age, source name, source IDs, broker name/company/email/phone, and observed dates.

Implement and test a deterministic precedence policy:

1. explicit protected manual CRM edits win by default;
2. a verified, more authoritative source may update a source-managed field under a documented rule;
3. a non-empty older value is not overwritten by missing/blank input;
4. missing means unknown, not zero, false, or a negative signal;
5. conflicting material values produce a visible conflict or review state instead of silent last-write-wins behavior;
6. derived values identify their inputs and calculation version;
7. impossible placeholders such as an asking price of zero are normalized to unknown/undisclosed unless the source explicitly and credibly represents a real zero;
8. unsafe URLs and invalid email/phone values are rejected or quarantined, not copied into CRM.

Do not infer an industry, description, broker identity, or contact value solely to fill a blank. If future enrichment is desired, design it as a separate source adapter using an authorized export or official API, with provenance, source policy, rate limits, and tests. Do not add authenticated browser scraping in this task.

### 3. Harden canonical duplicate resolution

Reuse and centralize the repository's current canonical opportunity and alias model. Inspect at least:

- `deal_hunter_opportunities`;
- `deal_hunter_opportunity_aliases`;
- `deal_hunter_identity_exceptions`;
- Deal OS import ledgers;
- `deal_hunter_crm_imports`;
- `contact_submissions` and Deal Hunter metadata;
- the identity and deduplication helpers in `server/services/dealHunter.js`.

Resolution order should prefer durable exact evidence:

1. an existing canonical alias;
2. a trusted provider listing ID or source stable ID;
3. normalized canonical listing identity, including provider-specific stable identifiers when available;
4. an exact/high-confidence fingerprint transition with no material conflicts;
5. a conservative syndicated-listing match supported by geography, financials, and other durable evidence;
6. an ambiguous identity exception;
7. a genuinely new canonical opportunity.

Retain all safe historical aliases when a fingerprint becomes a URL identity or a listing URL slug changes. Strip fragments and tracking-only parameters, normalize host/case/trailing separators, reject unsafe schemes, and preserve the provider's durable listing ID.

Do not merge based only on similar title, shared broker, shared recipient, industry, or financial proximity. Different stable provider IDs, incompatible geography, or material financial conflicts are strong vetoes. Same-title listings with distinct IDs must stay distinct. Punctuation-sensitive stable IDs must not be normalized into the same identifier accidentally.

Every automatic match must retain its resolution method, evidence version, and confidence state. Ambiguous comparisons must be durable, reviewable, and excluded from automatic CRM creation/update until resolved. Manual resolution must be administrator-only, explicitly confirmed, reasoned, timestamped, reversible where practical, and audited.

### 4. Enforce one CRM primary record per canonical opportunity in storage

Application lookups are not a sufficient duplicate-prevention boundary. Add database-enforced, provider-parity invariants.

Design an additive migration that gives the managed primary CRM record an explicit canonical opportunity reference, such as `contact_submissions.deal_hunter_opportunity_id`, and enforces at most one non-null primary link per canonical opportunity. Preserve legacy duplicates without assigning several rows as primary. Use an additive relation/disposition record when needed to keep legacy aliases and audit history.

Make `deal_hunter_crm_imports.opportunity_id` an authoritative, uniqueness-enforced claim for one canonical opportunity, including durable tombstones. Today it is indexed but not unique. Migrate legacy collisions deliberately before enabling the invariant; do not let a migration choose the newest row blindly.

Add foreign keys where repository/provider conventions permit, and add supporting indexes. Implement equivalent semantics in SQLite and Supabase/PostgreSQL. Remember that a partial unique index can enforce uniqueness over a selected subset of rows, while durable tombstone behavior may require a full opportunity-level claim. Document the chosen invariant and why it cannot recreate deliberately deleted CRM records.

Use an atomic insert-or-update/claim operation keyed by canonical `opportunity_id`, not mutable `deal_key`, row position, current URL, or a broad text search. The write must remain idempotent under retries and concurrent requests. Add race tests showing two aliases and two simultaneous reconciliations cannot create two CRM primaries.

Align provider lookup semantics. The current SQLite import lookup combines `id`, `deal_key`, and `listing_identity` in one newest-row query, while the Supabase helper checks them sequentially. Replace this ambiguity with one explicit canonical lookup order and test identical results on both providers.

Before any managed CRM write, validate that the company name, listing identity, `dealKey`, `opportunity_id`, source records, and planned field values all derive from the same canonical snapshot. If they disagree, fail that item closed as an integrity exception. Never copy one opportunity's identity metadata into another opportunity's visible CRM record.

### 5. Add an all-imported-canonical reconciliation planner and executor

Keep the existing high-fit sync behavior backward compatible, but rename or label it clearly as high-fit-only. Add a separate explicit mode such as `all-imported-canonical` that targets every canonical opportunity touched by one accepted import.

Implement two server-authoritative phases:

#### Preview/dry run

Given an immutable `importId`, bulk-load the accepted rows, canonical mappings, current opportunities, aliases, CRM import claims, CRM records, tombstones, source health, and scoring snapshots. Return a deterministic plan with:

- import/file digest and export time;
- raw/accepted/rejected row counts;
- duplicate and alias-collapse counts;
- canonical opportunity count;
- per-opportunity action: create, update, unchanged, tombstoned, ambiguous, conflict, or failed validation;
- proposed field changes with old/new values and provenance, excluding protected secrets;
- score/score-confidence changes and rule versions;
- warnings and blocking conditions;
- expected canonical opportunity IDs in stable order;
- a server-generated snapshot digest and expiry;
- exact confirmation text derived from the planned mutable count.

Preview performs no CRM writes and no outbound side effects.

#### Execute

Accept the import ID, mode, expected opportunity IDs, snapshot digest, and exact typed confirmation. Re-fetch server-owned source and storage state, repeat source-health and canonical-integrity checks, and reject stale or changed plans. Do not trust browser-supplied deal payloads or scores.

Process records in bounded chunks with a durable run/manifest record, per-item outcomes, progress, retry state, actor, timestamps, and plan digest. Prefer bulk reads and set-based provider operations to an N+1 query loop. Use transactional canonical claim plus CRM update/create per item. A crash or timeout must be safely resumable from the durable manifest without duplicate creation.

For an ordinary 261-row import, the workflow must remain within configured upload/request limits. If synchronous execution cannot reliably meet deployment timeouts, use the repository's durable job/lease conventions and show progress in Operations. Never solve timeout risk by dropping errors or silently truncating rows.

Every touched canonical opportunity must end in exactly one terminal result:

- `created`;
- `updated`;
- `unchanged`;
- `tombstoned`;
- `ambiguous`;
- `conflict`;
- `failed`.

Every accepted raw row must point to the terminal result of its canonical opportunity. Enforce and test the accounting equation before marking a run complete.

### 6. Keep low-fit and incomplete listings out of action queues

All-imported-canonical reconciliation does not mean every record is a high-priority lead.

Use an existing truly non-actionable CRM lifecycle state if one fits. Otherwise add a supported `sourced` or `research` state consistently across server validation, SQLite, Supabase, API serialization, filters, counts, UI badges, and tests. A low-fit, incomplete, or unscorable imported listing must default to:

- normal or low priority;
- no next action;
- no overdue/action-item status;
- no follow-up recommendation;
- no CIM eligibility caused merely by CRM presence;
- clear imported-source and completeness metadata.

High-fit opportunities may continue to enter the reviewed/high-priority workflow under the existing server-owned rules. Reconciliation itself must not promote, email, or schedule anything. Verify that dashboard “action items,” overdue counts, warm leads, and follow-up queues do not jump merely because all canonical listings are now visible in CRM.

Do not auto-archive a record just because it is absent from one export. An export may be filtered, stale, capped, partial, or temporarily unhealthy. Source-driven archival requires a separately verified full-coverage snapshot, explicit policy, grace period, and administrator confirmation.

### 7. Separate fit score, evidence completeness, and action eligibility

Refactor the score output into an explainable versioned contract. Preserve backward compatibility where APIs still require `score`, but make the following concepts explicit:

- `fitScore`: deterministic acquisition fit based only on known evidence;
- `completenessScore` or `evidenceConfidence`: how much required evidence is present and trustworthy;
- `scoreStatus`: `complete`, `partial`, or `unscorable`;
- `missingEvidence`: normalized field names;
- `scoreReasons`: bounded positive, negative, cap, and veto reasons;
- `scoringRuleVersion` and, where relevant, source-policy/normalization versions;
- `actionEligibility`: a separate server-owned result explaining whether high-fit CRM review or CIM actions are allowed.

Missing evidence is unknown, not automatically negative. However, action eligibility may conservatively require specific fields such as annual profit and a minimum completeness threshold. Preserve appropriate risk caps and removal rules, but make each cap/veto independently testable and visible.

Do not let one source's blank values erase evidence supplied by another source. Do not let duplicate aliases multiply scoring weight. Score the canonical opportunity once from its resolved field snapshot. If two material source values conflict, lower confidence or block action eligibility rather than choosing whichever row was processed last.

Keep the core score deterministic and testable. Optional model/AI output must not silently change canonical identity, source facts, protected manual fields, or action eligibility. If an AI recommendation exists, store its model/prompt/evidence version and treat it as advisory unless a separate policy explicitly promotes it.

Add golden synthetic fixtures for representative scores and identity cases. When a rule changes, tests should show the intended score delta and rule-version change rather than merely accepting a broad range.

### 8. Build a dry-run-first legacy integrity audit and reversible repair path

Create a dedicated script/service command following repository conventions. It must default to read-only dry run and examine all Deal Hunter CRM records, not only the current high-fit set.

The report must identify and count:

- multiple active/managed CRM records resolving to one canonical opportunity;
- CRM records whose visible company/listing fields disagree with Deal Hunter metadata;
- CRM import claims that disagree by `id`, `deal_key`, listing identity, or opportunity;
- missing primary CRM links;
- orphaned or conflicting aliases;
- durable tombstones with an active record or proposed recreation;
- material source-field conflicts;
- ambiguous pairs that must not be merged;
- related communications, CIM requests, secure documents, follow-ups, activities, and audit records that would make cleanup unsafe;
- raw rows, canonical opportunities, CRM primaries, legacy duplicates, and unresolved exceptions.

Produce a deterministic, checksummed repair manifest with proposed primaries, proposed legacy dispositions, child-link actions, reasons, and rollback data. Do not emit sensitive free text or complete recipient data in ordinary logs.

Apply mode must require all of the following:

- explicit `--apply`;
- exact confirmation tied to the manifest checksum;
- a fresh, successfully verified backup reference;
- an unchanged source/storage digest;
- healthy storage and no conflicting active reconciliation;
- full-administrator identity and audit reason.

Use bounded transactions. Preserve one chosen primary and all protected manual values. Re-link dependent records only when the relationship is deterministic and validated. Archive or mark legacy duplicates reversibly; never hard-delete them. If communications, documents, CIM requests, or follow-ups cannot be re-linked without ambiguity, leave the records untouched and create a manual exception.

Tombstones are authoritative. Do not restore or recreate a tombstoned opportunity unless a separately authorized administrator uses a deliberate restore workflow. Historical activity and source observations remain auditable.

Implement a rollback command or documented inverse manifest that is tested on synthetic data. A repair is not complete until a post-apply audit proves the uniqueness, identity-coherence, accounting, and child-link invariants.

### 9. Update the admin UI for clarity and control

In Deal Hunter/Operations, add an import result and reconciliation workspace that shows:

- source rows accepted and rejected;
- within-file duplicates and cross-source aliases collapsed;
- canonical opportunities touched;
- scored/partial/unscorable counts;
- existing high-fit-only candidate count;
- all-imported-canonical preview count;
- create/update/unchanged/tombstoned/ambiguous/conflict/failed counts;
- run status, progress, retry state, actor, timestamps, and snapshot digest;
- a downloadable redacted reconciliation report if current export conventions support it.

Use plain language explaining why 261 uploaded rows may produce fewer than 261 canonical CRM records. Display actionable blocking errors instead of a generic failure. Let the administrator inspect per-opportunity provenance and planned field changes before confirmation.

Only a full administrator may execute reconciliation or resolve identity exceptions. Viewers remain read-only. Use accessible labels, keyboard behavior, focus handling, status announcements, and responsive layouts. Confirmation must be based on the exact server plan, not a static phrase.

Keep high-fit-only sync as a clearly labeled, backward-compatible action until the new workflow is proven. Put automatic post-import reconciliation behind an off-by-default feature flag. Do not enable it in production in this task.

### 10. Add observability, idempotency, and recovery

Record bounded operational metrics and audit events for:

- import rows accepted/rejected;
- canonicalization and alias-collapse ratios;
- identity exceptions and conflict reasons;
- reconciliation planned/created/updated/unchanged/tombstoned/failed counts;
- retries, stale-plan rejections, lock/claim conflicts, and duration;
- score-status and completeness distributions by source;
- post-run invariant failures.

Never use raw listing names, full URLs with sensitive query strings, full email addresses, or free-form descriptions as metric labels.

Add a durable idempotency key based on import ID, mode, canonical opportunity ID, field-policy version, and plan digest. Replaying an identical completed import must create zero new CRM records and produce only unchanged/idempotent outcomes. Concurrent executions must be serialized or safely conflict at the canonical opportunity claim.

Source read failure, unhealthy storage, an expired/stale plan, migration mismatch, or identity ambiguity must fail closed. Operations should show how to recover or retry without encouraging an unsafe rerun.

## Storage and provider parity requirements

Implement and test equivalent behavior for local SQLite and production Supabase/PostgreSQL:

- additive schema changes and indexes;
- canonical opportunity foreign keys/claims;
- uniqueness at the authoritative boundary;
- transactions or atomic RPCs for claim-and-write behavior;
- normalized JSON/metadata serialization;
- lookup precedence;
- pagination and bounded bulk reads;
- tombstone behavior;
- dry-run and apply manifests;
- audit timestamps and actor fields;
- service-role isolation with no broadened client RLS access.

Update `supabase/schema.sql` in addition to adding a timestamped migration. Make migrations safe on databases containing legacy collisions: detect/report conflicts first, migrate deterministically when safe, and stop with an actionable error when not. Do not silently drop or overwrite conflicting data merely to make a unique index succeed.

## Files and boundaries to inspect before editing

Confirm current names and line numbers rather than assuming they are unchanged. At minimum inspect:

- `server/services/dealHunter.js` for normalization, identity aliases, deduplication, scoring, candidate selection, CRM payloads, lookup, claim, and sync;
- `server/app.js` for import, backfill, sync, auth, confirmation, and request-size boundaries;
- `server/storage/sqlite.js` and `server/storage/supabase.js` for schema, lookup parity, atomic writes, deletion/tombstone behavior, pagination, and transactions;
- `supabase/schema.sql` and relevant migrations;
- `src/pages/DashboardPage.jsx` and `src/components/admin/DealHunterWorkspace.jsx` for import/sync UX and queue side effects;
- command-center and follow-up services so sourced records remain non-actionable;
- backup, operations-job, audit, and repair scripts for established safety patterns;
- `test/dealOsImport.test.js`, `test/dealHunterScoring.test.js`, Deal Hunter CRM sync/identity tests, storage parity tests, HTTP tests, UI tests, and browser tests;
- `.env.example`, deployment documentation, and `package.json` scripts.

Search for other consumers before changing shared status values, score fields, candidate filters, or CRM metadata. Keep existing public shapes compatible or version them deliberately.

## Required tests and evals

Use synthetic fixtures; do not commit the production CSV or private CRM data.

### Import accounting

- 261 accepted rows are all accounted for even when they resolve to fewer canonical opportunities.
- Duplicate rows within one file map to one canonical result without disappearing.
- Cross-source syndicated aliases map to one canonical opportunity.
- Invalid rows have stable row-level reasons and are not counted as accepted.
- Rejected/stale/capped/partial imports cannot be represented as a healthy full snapshot.
- The accounting equation fails the run if any accepted row or touched opportunity lacks one terminal outcome.

### Identity and duplicates

- fingerprint-to-URL evolution reuses the existing opportunity and CRM primary;
- URL slug/tracking changes with the same stable provider ID reuse the opportunity;
- the same listing across approved marketplaces resolves through source aliases;
- same title/broker with different stable IDs, geography, or material financials remains distinct;
- punctuation-distinct stable IDs remain distinct;
- ambiguous evidence creates an exception and no CRM mutation;
- changing row order does not change durable identity;
- identical replays and concurrent aliases create at most one primary CRM record;
- durable tombstones block recreation across every known alias.

### Field accuracy

- blanks never erase known values;
- protected manual values survive reconciliation;
- newer verified source values update only source-managed fields;
- conflicts are surfaced, not resolved by processing order;
- zero placeholders become unknown under the documented rule;
- invalid numeric, URL, email, and phone values fail or quarantine safely;
- derived margin/multiple values retain inputs and version;
- visible company/listing fields and canonical metadata cannot cross opportunities.

### Scoring

- fit, completeness, score status, reasons, missing evidence, and action eligibility are distinct;
- missing fields are unknown rather than negative facts;
- incomplete evidence can conservatively block action eligibility without fabricating a low fit;
- aliases do not double-count evidence;
- conflicting source facts lower confidence or block eligibility;
- golden fixtures assert exact results and rule versions;
- the existing high-fit behavior remains compatible where inputs and rules are unchanged.

### Reconciliation and recovery

- preview is read-only and deterministic;
- execution rejects missing/incorrect confirmation, stale/expired digest, changed expected set, unhealthy source, wrong role, and migration mismatch;
- all-imported-canonical creates low-action sourced records and promotes only eligible high fits;
- reconciliation creates no email, communication, CIM request, document, or follow-up;
- identical replay creates zero additional records;
- partial crash resumes without duplicate creation;
- SQLite and Supabase choose the same canonical claim and outcome;
- a 1,000-row accepted import remains bounded and does not silently truncate;
- missing-from-partial-export never auto-archives a CRM record.

### Legacy repair

- dry run performs no mutation;
- apply requires verified backup, checksum-bound confirmation, admin actor, and fresh state;
- deterministic duplicates keep one primary and reversible legacy dispositions;
- ambiguous child links remain untouched and create exceptions;
- tombstones remain authoritative;
- rollback restores the synthetic pre-repair state;
- post-repair audit proves uniqueness and identity coherence.

### UI and HTTP

- role/auth coverage for every new endpoint;
- exact counts and terminology for rows versus canonical opportunities versus CRM records;
- accessible confirmation, progress, errors, and status announcements;
- sourced records do not inflate overdue/action/follow-up queues;
- browser coverage for import, preview, safe rejection, successful idempotent reconciliation, and tombstone display.

## Performance expectations

Profile before optimizing, but design away obvious N+1 behavior. Parse each upload once, normalize each row once per rule version, canonicalize through indexed/batched alias lookups, score each canonical snapshot once, bulk-read existing CRM/import state, and write in bounded chunks.

Add representative tests or instrumentation for 261 and 1,000 rows. Document query counts or provider round trips for preview and execution. The optimization goal is reliable completion with full accounting and safe recovery, not merely a lower response time.

Do not introduce a cache that can serve stale identities or scores without including import/source digest and relevant rule versions in the key. Correctness and idempotency take priority over throughput.

## Documentation and operations runbook

Update the administrator/deployment documentation with:

- the raw-row versus canonical-opportunity versus CRM-record model;
- why the prior 261-row upload produced 11 high-fit candidates;
- import field coverage and known source limitations;
- field precedence, protected manual fields, conflicts, and null semantics;
- scoring/completeness/action-eligibility definitions and rule versions;
- preview/execute confirmation flow;
- feature flags and their safe defaults;
- backup, dry-run audit, canary, apply, post-audit, rollback, and incident steps;
- metrics and alerts;
- explicit statement that CRM reconciliation sends no email and requests no CIM;
- explicit statement that source absence alone is not archival authority.

Provide exact safe commands using repository scripts. Do not include production secrets or an unverified production `--apply` example that can be pasted accidentally.

## Implementation sequence and closure

1. Inspect current behavior, tests, migrations, and dirty worktree.
2. Reproduce the root cause with a credential-free fixture: import accepted, full scoring complete, high-fit sync selects a subset, and no all-imported reconciliation exists.
3. Write a short implementation plan tied to invariants and rollback, then implement without stopping for routine local decisions.
4. Add migrations and provider-parity storage primitives before relying on application-only dedupe.
5. Implement accounting, field provenance, scoring contract, preview, executor, UI, observability, and dry-run repair in coherent increments.
6. Run focused tests while iterating, then the full repository closure command (`npm run check`) and relevant browser tests. If environment constraints prevent a test, report the exact command, error, and residual risk; do not claim it passed.
7. Perform a first code-review pass over the full diff for correctness, data loss, race conditions, authorization, source-policy regressions, duplicate creation, tombstone bypass, scoring drift, provider parity, UI queue side effects, accessibility, and operational recovery. Fix every finding.
8. Re-run affected tests and perform a second independent review from the acceptance criteria. If findings remain, fix and repeat until there are no actionable findings.
9. Produce a final handoff with changed files, migrations, invariant decisions, test evidence, performance evidence, dry-run usage, rollout/rollback steps, remaining risks, and the exact production actions that still require explicit authorization.

Do not commit, push, deploy, enable automatic reconciliation, or run a production apply under this prompt. End with the local implementation and a safe deployment/canary checklist so a separately authorized task can review and execute production changes.

## Definition of done

The task is complete only when all of the following are demonstrated:

- every accepted import row maps to exactly one canonical opportunity result;
- every touched canonical opportunity has exactly one terminal reconciliation outcome;
- at most one managed CRM primary can exist per canonical opportunity, enforced in storage;
- tombstones and ambiguous identities cannot be recreated by aliases, retries, concurrency, or provider differences;
- CRM-managed fields are coherent, provenance-backed, conflict-aware, and never overwritten by missing data;
- all canonical imported opportunities can be represented in CRM without turning low-fit/incomplete listings into action items;
- scoring separates fit from completeness and action eligibility, is deterministic, versioned, and covered by golden fixtures;
- import/reconciliation replay is idempotent and resumable;
- the legacy audit defaults to read-only and repair is backup-gated and reversible;
- SQLite and Supabase behavior is equivalent;
- CRM reconciliation produces no outbound communication side effects;
- focused, full, UI, provider-parity, concurrency, and relevant browser tests pass;
- two review passes have no remaining actionable findings;
- no unrelated worktree content was changed.
