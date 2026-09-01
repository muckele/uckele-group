# Acquisition Inbox v1 — Phase 1 Design

**Project:** Uckele Group / Deal Hunter<br>
**Phase:** MVP Phase 1<br>
**Status:** Approved design<br>
**Date:** 2026-08-30

## Purpose

Acquisition Inbox v1 turns the recovered Deal Hunter scoring and canonical-identity system into the primary daily acquisition operating surface.

The application should open into the question:

**Which acquisition opportunities deserve my attention today, why, and what should I do next?**

Phase 1 does not redesign scoring, canonical identity, CIM delivery, automation, or the acquisition pipeline. It builds a focused operator experience over those existing durable systems.

Inbox becomes the default Deal Hunter destination. Source health, imports, backfills, diagnostics, and other administrative controls move into a secondary Operations area.

## Product Goal

An operator should be able to open Deal Hunter each morning and process the complete authoritative current opportunity set without consulting the source Google Sheet.

The operator must be able to review opportunities in acquisition-priority order; understand score, confidence, evidence, financials, provenance, and missing information; record Pursue, Watch, or Pass decisions; enrich missing broker/seller information manually; see all available source and listing information; retain operator-verified information across source refreshes; and remain inside a single Inbox workflow while reviewing an opportunity in detail.

Phase 1 remains human-controlled. No Phase 1 action automatically sends a CIM request, emails a broker, activates Stage 2, triggers follow-ups, or changes machine scoring.

## Navigation

- **Inbox** — primary daily acquisition review.
- **CRM / Pipeline** — active acquisition relationships and later-stage progression.
- **Follow-ups** — manual follow-up workflow; Phase 3 expands this.
- **Operations** — source health, Deal OS import, score refresh/backfill controls, diagnostics.
- **Settings** — safety/configuration controls where appropriate.

Inbox is the default Deal Hunter destination.

## Inbox Summary

Top summary strip:
- Needs Review
- High Priority
- Watchlist
- Low Confidence
- Current Opportunities

A reserved Follow-up Due slot may exist but Phase 3 populates it.

Counts use the same server-side semantics as the queues.

## Main Inbox Queue

Desktop uses a dense list/table-oriented presentation.

Each row should include business name, geography, industry, fit score, confidence, SDE/profit, revenue, asking price, multiple when available, review state, operator state, machine status, top strengths/concerns, workflow status summary, and useful observation freshness.

Full evidence, source observations, contact details, and communication history load only in Opportunity View.

## Default Sorting

Needs Review defaults to `acquisition-priority`:

1. urgent/high operator priority;
2. high-fit opportunities that are new or materially changed;
3. higher fit score;
4. higher confidence;
5. more recently observed opportunity;
6. deterministic final tie-breaker.

## Primary Operator Actions

### Pursue
- mark the current semantic score/evidence state reviewed;
- set operator priority to `high`;
- keep active/current;
- do not change machine score;
- do not send CIM;
- do not activate Stage 2.

### Watch
- mark reviewed;
- set operator priority to `watch`;
- keep active and visible in Watchlist.

### Pass
- use existing durable disposition/dismissal;
- record reason + optional note;
- mark reviewed only if dismissal succeeds;
- remove from active daily triage;
- preserve canonical opportunity, score, evidence, disposition, and history;
- allow restoration.

Urgent remains an advanced priority in Opportunity View.

## Ownership Boundaries

**Machine owns:** fit score, confidence, dimensions, evidence, gates, canonical identity, machine high-fit/watch classifications.

**Operator owns:** review acknowledgement, priority, operator note, verified facts, pass/disposition decision.

**Pipeline/CRM owns:** CIM requested, broker replied, documents received, diligence, LOI candidate, and later acquisition progression.

Operator decisions never rewrite machine scoring.

## Opportunity View

Clicking a listing opens a right-side drawer on desktop and a full-height compact view on smaller screens. The operator remains in Inbox and retains queue context.

The drawer is the consolidated record for:

**Everything Uckele Group currently knows about this business and where each fact came from.**

Sections:

### Overview
Fit, confidence, operator state, machine state, key financials, important missing information, strengths, concerns, and Pursue/Watch/Pass.

### Business & Financials
Meaningful retained fields such as SDE/profit, revenue, ask, multiple, margin, years established, location, industry, management, recurring revenue, customer characteristics, franchise/remote indicators, reason for sale, real estate, seller financing, and other retained acquisition-relevant data.

Populated noncritical fields show. Empty noncritical fields hide. Important missing fields may show `Not provided`.

### Broker & Seller
All known broker and seller/owner contacts with provenance.

Potential fields: broker name, brokerage, email, phone/contact, seller/owner name, seller email, seller phone, and verified contact notes.

Multiple contacts may show.

Critical missing contact fields may show `Not provided` + Add information.

### Score & Evidence
Seven dimensions, rules, evidence, contradictions, missing evidence, confidence explanations, gates, and caps. Fit and confidence remain separate.

### Sources
Show stored source observations that contributed to the canonical opportunity, including Deal Hunter Google Sheet, Deal OS import, and syndicated marketplace identities.

Display source name, observed values, marketplace/listing ID, observation timestamps where useful, and original listing URLs.

Multiple marketplace listings for one canonical opportunity are shown together.

Conflicts are explicit, e.g. Deal Hunter SDE vs Deal OS SDE.

Phase 1 displays all relevant source-supplied information actually retained. It does not imply unavailable/discarded raw fields exist.

If needed, Phase 1 may add a bounded durable source-observation projection. Do not store arbitrary raw workbook/file blobs.

### Original Listing
Prominent **View Original Listing ↗** and all safe known source listing URLs.

Phase 1 does not independently crawl/scrape marketplace pages.

### CRM / CIM
Read current CIM state and CRM/CIM history. Phase 2 owns polished request/review/approve/send.

### Notes & History
Operator note, review acknowledgement, priority/status changes, relevant audit events, and future enrichment approvals.

## Missing Information Rule

Do not show every possible empty field.

Show missing values explicitly only when the absence is acquisition-relevant.

Examples: seller/owner, broker contacts, SDE/profit, revenue, asking price, customer concentration, management structure, reason for sale, real estate, seller financing, original listing URL.

A concise Missing Information section summarizes important gaps.

## Manual Opportunity Enrichment

Phase 1 introduces durable operator enrichment for facts learned later.

Examples: seller/owner identity, seller contact, broker corrections, brokerage, phone, and other explicitly approved facts.

Operator-enriched information is separate from machine/source-managed fields.

A later Sheet refresh or Deal OS import cannot overwrite an operator-verified fact.

## Fact Authority and Provenance

Effective precedence:

1. Operator-entered / operator-verified
2. Direct CRM / broker / seller information
3. Current structured source
4. Automated enrichment suggestion

Lower-authority observations remain visible as evidence/history.

Automated enrichment may not silently overwrite operator-verified facts.

## Operator Fact Model

Operator facts need canonical opportunity ID, field identifier, value, provenance/source, verification state, actor, created/updated timestamps, and useful history.

Implementation may use a dedicated fact table or equivalent normalized model.

It must support SQLite/Supabase parity, prevent source writes from mutating operator facts, be auditable, and allow future enrichment suggestions without redesign.

## Automated Enrichment Boundary

Automated opportunity enrichment is outside Phase 1.

Later enrichment may inspect permitted original listing/business/broker sources and propose facts.

High-risk identity/contact changes require operator review when sourced through automated enrichment.

## API Design

Extend existing triage rather than create a parallel backend.

- Inbox list: paginated scan-ready rows + summary counts.
- Opportunity detail: consolidated canonical/source/contact/evidence/history record.
- Operator decision: existing review/priority/note boundary.
- Pass: existing disposition boundary.
- Operator facts: new bounded authenticated admin mutation.

Opening Inbox or Opportunity View must never run scoring.

## Error and Degraded State

- degraded source → warning, persisted Inbox remains readable;
- detail failure → queue remains usable, drawer retry;
- operator save failure → prior durable value remains visible;
- conflicting source/enrichment → never silently overwrite verified data;
- unavailable original listing → preserve URL/provenance and show unavailable state.

## Performance

- Open Inbox → one paginated queue/summary request.
- Open opportunity → one consolidated detail request or a small bounded set of lazy detail reads.
- Mutation → one explicit authenticated mutation + affected state refresh.
- No scoring/backfill on browse.
- No N+1 per-row evidence/history fetching.

## Responsive

Desktop: dense list + right-side drawer.<br>
Tablet: fewer visible columns / expandable secondary details.<br>
Mobile: compact cards + full-height detail view.<br>
All primary actions remain accessible.

## Security

Preserve admin auth, origin protection, audit logging, read-only roles, safe URL validation, non-executable source content, and CIM/outreach safety controls.

Phase 1 must not reactivate automatic outreach.

## Acceptance Criteria

Phase 1 is complete when:
- Deal Hunter opens into Acquisition Inbox;
- summary counts are correct;
- Needs Review uses acquisition-priority ordering;
- the authoritative current set is searchable/filterable;
- each canonical opportunity appears once;
- Opportunity View opens without losing Inbox context;
- business/financial/broker/seller information is available;
- critical missing values are clear;
- all known safe original listing URLs are accessible;
- source observations/conflicts are attributable;
- score/evidence is understandable;
- CRM/CIM history is readable;
- operator facts can be added/verified;
- verified facts survive source refresh;
- Pursue/Watch/Pass work without changing machine score;
- changed evidence returns reviewed opportunities to Needs Review;
- desktop matches approved visual direction;
- mobile is functional;
- browsing does not trigger scoring/automation;
- full backend/UI/browser validation remains green.

## Non-Goals

No independent marketplace scraping, automated contact enrichment, automatic broker outreach, automatic CIM requests/follow-ups, Stage 2 autonomous execution, scoring redesign, canonical identity redesign, CIM document analysis, SBA underwriting, LOI automation, or new pipeline state machine.

## Roadmap Integration

After Phase 1:
1. Manual CIM/SIM Workflow
2. Follow-Up Workflow v1
3. Daily Digest
4. Automated Opportunity Enrichment
5. Deal OS Import Parity
6. MVP Polish & Acceptance

## Estimate

Approximately **8–14 focused engineering hours**.
