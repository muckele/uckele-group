# Uckele Group — Fresh Leads, Complete Deal Review, and Searchable Archives

**Document ID:** UG-MVP-FRESH-LEADS-2026-09-22  
**Version:** 1.0 — additive MVP roadmap extension  
**Planning date:** September 22, 2026, America/Los_Angeles  
**Product owner:** Mathew Uckele  
**Audience:** Owner, research agents, Codex implementation owner, and independent reviewer  
**Suggested repository path:** `docs/roadmap/2026-09-22-uckele-group-fresh-lead-mvp-roadmap-addendum.md`  
**Parent roadmap:** `2026-09-20-uckele-group-product-vision-and-roadmap.md`  
**Research code baseline:** `dca501e4220173b187e69b3e2e4639c5d21d0d62`  
**Status:** The owner explicitly requested these goals be added to the MVP and delegated prioritization. This document records the additional goals and recommended product contracts. It does not claim implementation, deployed acceptance, repository integration, or new production authorization.

> **MVP outcome:** Open Uckele Group, see the most important genuinely fresh opportunities, understand each one quickly, obtain the appropriate broker/owner materials through an authorized channel, and preserve every decision in a searchable history.

## Reading guide

Read Sections 1–4 for direction and current evidence, Sections 5–12 for product behavior, and Sections 15–18 for sequencing and acceptance. Implementation agents should read their selected work package rather than load the entire repair history. This document extends the original roadmap; it does not replace its communications, secure-materials, automation, or diligence workstreams.

The original roadmap and `Summarize Uckele MVP.txt` remain the two primary references. The dated system baseline establishes last-reported operational state. This addendum supplies the new MVP requirements and their place within that existing plan. [FL-R01, FL-R02]

## 1. What changes in our MVP goals

### 1.1 Owner intent

The owner wants a simple interface that puts worthwhile new leads in front of him as soon as available source data supports doing so. He needs enough context to choose an action without opening numerous screens, and a complete lead page when deeper research is necessary. He must be able to correct information, record decisions, archive unsuitable or unavailable opportunities, and search those archives later. Existing roadmap goals remain in place. [FL-D01]

The additions are therefore **MVP completion requirements**, not a cosmetic wishlist:

| Goal | Required owner outcome | Completion evidence |
|---|---|---|
| G1 — Fresh opportunities first | Worthwhile newly discovered/currently recent opportunities are not buried by old high-score backlog. | Deterministic ranking fixtures plus an owner walkthrough. |
| G2 — One opportunity, multiple sources | A repeated CSV row or second source enriches the same established opportunity where identity is proven. | Cross-source and repeat-import regression cases; visible source attribution. |
| G3 — Simple first view | Each row explains why it matters, what is missing, and its next action. | Rendered desktop/narrow-screen review; measured navigation. |
| G4 — Complete lead workspace | All available relevant information and its provenance are accessible from one lead context. | Detail-page field/content and navigation checklist. |
| G5 — Controlled editing | The owner can correct allowed facts and add notes without destroying source evidence or silently changing policy. | Save/conflict/audit/import-refresh tests. |
| G6 — Fast disposition | Pursue, Watch, and Pass/Archive are understandable, consistent, and persistent. | UI-to-service/storage lifecycle tests. |
| G7 — Searchable archives | A previously archived business can be found even when absent from today's source or current-score cohort. | Historical, stale, unlinked, and alias-aware archive search tests. |
| G8 — No unwanted resurfacing | Reimports and background refreshes do not undo Pass, restart outreach, or relabel an old business as new. | Refresh/reimport/relist/restore tests. |
| G9 — Short path to a CIM | A worthwhile lead leads to the correct permitted materials request or explicit prerequisite, with the conversation retained. | Existing manual request/reply/materials workflow acceptance. |
| G10 — Reliable, accountable progress | The system distinguishes unknown, pending, failed, received, and reviewed; meaningful work proceeds with few engineering handoffs. | Instrumented status checks, acceptance report, and owner-effort measures. |

### 1.2 Preserve the original mission

The primary outcome remains useful acquisition decisions per unit of owner effort. A high-quality Pass, an accurately identified NDA prerequisite, or a discovered financial contradiction can be as valuable as a new materials request. This extension does not promise an acquisition, a particular return, or a universally duplicate-free database. [FL-R01, Sections 1 and 13]

The historical `v1.0.0` MVP acceptance is not revoked or retagged. These are added acceptance goals for the next owner-facing release. No new application version is declared released by this document.

### 1.3 Scope of this planning action

This task produced documents and researched selected repository paths and public guidance. It did not run the application, test the live UI, inspect production, import a CSV, modify GitHub, send a message, or change an archive/disposition. Proposed contracts below must be verified through implementation and acceptance before being described as available to the owner.

## 2. Priority decision: do this next within the existing roadmap

**Recommendation:** Make the fresh-lead-to-CIM owner experience the next product increment after the completed fixed-pair repair and memory closeout. Implement it through the existing P7-Q1, P7-Q2, P7-W, and P8-01 work, rather than creating a competing product roadmap.

Three priorities control the sequence:

1. **Truth before a freshness boost.** Establish reliable newness, retained source metric/period, and visible uncertainty before emphasizing “new” or comparing financials more aggressively.
2. **Owner control before autonomous volume.** Make review, editing, archive/search, and the manual materials handoff dependable before expanding automatic contact.
3. **Useful releases before broad redesign.** Ship coherent improvements to the existing Inbox and detail workspace. Keep advanced automation and evaluated CIM extraction on the original schedule of dependencies.

Provider/contact-permission research under P8-00 can proceed in parallel. It need not block local UI work or archive search, but remains a prerequisite to a live contact pilot. The owner does not have to wait for native Gmail integration or fully automated document extraction to review opportunities and make decisions. [FL-R01, Sections 17–18]

### 2.1 Preserved workstream map

| Original package | Treatment under this extension |
|---|---|
| P7-R — Duplicate stabilization | Preserve the recorded fixed-pair closure. Do not repeat the repair. New unrelated identity defects receive their own bounded assessment. |
| P7-Q1 — Financial/source provenance | Still required; now explicitly includes honest listing/newness dates and metric labels on list and detail screens. |
| P7-Q2 — Confidence/contradictions/eligibility | Still required; supplies visible research/contact blockers without blending uncertainty into a misleading score. |
| P7-W — Owner next-action handoff | Expanded acceptance: fresh-first triage, clear detail/editing, coherent archive/search, and one next action. |
| P8-00 — Provider and scope decision | Unchanged, and advanced in parallel as research. Fast UI does not imply contact permission. |
| P8-01 — Manual communication loop | Unchanged, with the lead-page entry point and archive/takeover interaction made explicit. |
| P8-02 — Secure material capture | Unchanged; the lead page displays its actual ingestion state rather than inventing completion. |
| P8-03 — Enrollment/shadow | Unchanged; receives freshness, availability, and owner disposition as governed inputs. |
| P8-04 — Controlled automation | Unchanged; no activation until its existing permission, cap, stop, inbound, and canary gates pass. |
| P8-05 — Broker response/exception handling | Unchanged; availability changes, questions, and NDA prerequisites link back to the same lead. |
| P8-06 — Measurement/expansion | Unchanged; add owner-effort and false-new/archive-resurfacing measures. |
| P9-01 — CIM extraction/decision briefs | Unchanged; extracted claims remain attributable proposals until accepted. |
| Optional native Gmail branch | Still optional according to mailbox coverage needs and provider permission, not a prerequisite imposed by this addendum. |

No package is deleted or silently renamed. The new `MVP-FL-*` identifiers in Section 15 are delivery slices within those packages, not a replacement phase numbering system.

## 3. Current evidence: built foundations and real gaps

### 3.1 Repository and production are separate

Remote main was read at `dca501e4220173b187e69b3e2e4639c5d21d0d62`. The committed baseline records the owner's fixed Pooler/Berlin V3 repair closure on Fly v127 at revision `52e8753119d320a7299021d6a42ad3d3dd8db0b1`, with 1024 MB live memory. PR #23 changes the repository memory declaration and adds that baseline; it is not a new live deployment. This research does not independently re-certify production. [FL-R03, FL-R04]

PR #21 was freshly read as open/draft at `f6b09a6c9c2e8ed2cca458da201038e4e7ae8e87`. The roadmap is available as a source document, but its repository integration is a separate unfinished documentation action. Reading this extension does not authorize merging that PR. [FL-R05]

### 3.2 Important correction to the earlier discussion

The current `AcquisitionInbox.jsx` component already contains **Pursue, Watch, and Pass buttons**, a **Passed** view, queue search, and an opportunity drawer. `OpportunityDrawer.jsx` already contains a Pass form and a verified-operator-fact editor. The earlier description based mainly on `DealHunterTriage.jsx` understated that existing UI. We should improve and test the mounted Inbox path, not rebuild actions that already exist. Production route behavior still needs its own authorized acceptance. [FL-R06, FL-R07]

### 3.3 Capability assessment

| Capability | Repository-observed foundation | Gap or limit for these MVP goals |
|---|---|---|
| Inbox decisions | Pursue/Watch/Pass controls and service decisions exist. | Ensure their outcome is clear and consistent across Inbox, detail, CRM, and archive. |
| Current prioritization | Needs-review defaults to acquisition-priority. SQL favors owner priority, high-fit review need, fit, confidence, then observed freshness. | This is not a genuine first-seen/newly-listed ordering. Newness needs its own truthful semantics. |
| Changed-since-review | Reviewed semantic/fingerprint state supports meaningful-change detection. | Prove timestamp-only refreshes and owner notes do not become false new opportunities. |
| Detail and editing | Thirteen operator fact fields include seller/broker contacts, sale reason, financing, management, concentration, and notes. | Generic financial or identity editing is not included in that field set; do not promise arbitrary edits through it. |
| Financial display | Inbox displays `SDE / Profit` for a normalized annual-profit value. | Preserve original metric and period; this remains P7-Q1 work, not proof of actual SDE. |
| Pass/Archive | Durable disposition and CRM archive/restore services exist. | The free-text Pass reason is normalized to a small code set; specific unsupported wording may become `other`. Preserve the precise explanation in the improved contract. |
| Passed search | Queue can select dismissed records and search name/deal key. | It still requires current triage eligibility and an active opportunity join. It is not a complete historical archive search. |
| Archive restoration | CRM restore deliberately leaves outreach stopped. | Restore of disposition, CRM state, source actionability, and any historical identity must be coherent; a success label alone is insufficient. |
| Cross-source identity | Existing import/canonicalization and supersession foundations are retained. | Fixed-pair cleanup does not prove every future identity case; ambiguous matches must remain reviewable. |
| Broker materials | Existing Inbox/detail components integrate materials and follow-up controls. | Reuse the governed prepare/approve/status flow, characterize actual side effects, and honor current provider/safety gates. |

Evidence: [FL-R06–FL-R11]. This is a source-level assessment; no test counts or live-readiness outcomes were generated by this research.

### 3.4 A small UI change is not the whole scope

Card labels and visual hierarchy are bounded presentation work. Persisting true first-seen history, broadening archive retrieval beyond current scores, and extending editable financial evidence can affect durable contracts. Split those changes deliberately. Reuse the present architecture, but do not describe the entire requirement set as a purely cosmetic change or promise that no data contract will need modification.

## 4. Product principles and non-negotiable boundaries

- One current sale opportunity can have many source observations and historical representations. Do not deduplicate by equal revenue, title, broker email, or asking price alone.
- New to Uckele Group, newly listed, recently checked, materially changed, and newly scored are different facts.
- Owner intent outranks an unattended refresh. Pass does not expire because a CSV arrives; Watch is not automatic permission to contact.
- Archive means preserve and remove from active work. Delete is a separate destructive administrative action, not the ordinary investment-decision button.
- A missing reason for sale is unknown evidence; it is not proof of bad faith. An owner can record a concern or Pass without the system asserting an allegation as fact.
- Score, evidence confidence, owner priority, availability, and sending permission remain separate.
- Restoring a record does not restart a sequence, reset touch caps, undo opt-out, or reverse a historical supersession.
- The quickest permitted next action may be review, verify contact, complete an NDA prerequisite, or use an approved listing portal—not always Send.
- Search, list, and detail disclosure must preserve access controls and source attribution. Archived does not mean public.
- No automatic broker contact, mailbox connection, legal signature, proof-of-funds disclosure, model access to confidential CIMs, or production repair is authorized by roadmap adoption.

## 5. Freshness: define what “new” actually means

### 5.1 Required date vocabulary

These are conceptual facts, not mandated database column names. Reuse trustworthy retained facts before adding fields.

| Fact | Meaning | What must not reset it |
|---|---|---|
| First seen in Uckele Group | Earliest defensible accepted observation of this canonical opportunity within the system. | Re-upload, source refresh, rescore, archive/restore, or alias addition. |
| Source listing date | The date a source explicitly says the listing was published. | Today's ingestion time; an unrelated source's modified timestamp. |
| Source observation time | When a specific source snapshot/record was observed. | It must not be presented as the listing's birthday. |
| Last material change | When a defined decision-relevant fact actually changed. | Harmless reordering, formatting, refreshed timestamps, or identical re-score output. |
| Last owner review | The evidence version the owner reviewed, with date and actor. | A background import or automated action must not invent a new human review. |
| Last score calculation | When the current score was calculated and under which rules/profile. | It must not define whether a business is new. |
| Availability last confirmed | Date/evidence for active, under-contract, withdrawn, sold, or unknown availability. | A source fetch alone must not count as seller confirmation. |
| Archive/restore date | When an owner lifecycle action was committed. | It must not overwrite source date or first-seen history. |

### 5.2 Legacy and uncertain dates

Historical first-seen dates should be reconstructed only from trustworthy retained events. Never mark the entire legacy backlog “new today” during migration. Where original evidence is unavailable, show **First seen unknown — existing record** and retain the derivation limitation. A backfill's processing time is a technical event, not new business discovery.

Store unambiguous timestamps consistently and display owner-facing dates in the configured timezone. Date-only source values must retain their date-only precision. Future dates, malformed dates, and contradictory sources need an explicit uncertainty state; do not select a convenient date merely to boost priority.

When two existing identities are lawfully consolidated, use an approved earliest-evidence rule and preserve the contributing records. An ownership/identity conflict is not solved by taking the minimum date across unrelated records.

### 5.3 Recommended initial freshness defaults

The owner approved fresh-first behavior, not exact day cutoffs. The following are versioned pilot recommendations:

| Label | Proposed interpretation |
|---|---|
| New to UG | First defensible system discovery within the last 7 days and not yet reviewed at current evidence. |
| Recently listed | Supported source listing date within the last 30 days; display the source and date. |
| Updated | A material change since the owner's last review; preserve original first-seen/listed dates. |
| Existing backlog | Older/unreviewed or previously reviewed opportunities without a new material reason for attention. |
| Age unknown | Listing age cannot be supported; do not silently class it as newly listed. |
| Needs revalidation | Current actionability/source health is not established under the existing policy. |

The 7/30-day recommendations organize the owner queue; they are not new automatic-send eligibility, data deletion, or provider rules. Existing 72-hour export freshness and other source policies retain their own meaning unless separately changed.

Example: a 90-day-old listing imported for the first time today may be **New to UG / Listed 90 days ago**. It must not receive the same “freshly listed” treatment as a supported two-day-old listing. Conversely, a two-year-old business is not a two-year-old listing: business age and listing age must not be confused.

## 6. Ranking and the default Inbox

### 6.1 Three visible work areas

The default Inbox should emphasize **New & Important**. A compact **Needs Your Action** area keeps time-sensitive broker questions, requested NDA steps, and received materials from being lost. Explicit owner-pinned priorities remain visible without forcing stale backlog to dominate the fresh discovery queue.

Recommended navigation: **Inbox**, **Watchlist**, **Archives**. The Inbox can offer filters for New, Updated, Needs Review, High Priority, and All Active. Reuse existing routes/views where practical; this is information architecture, not a requirement to create three applications or three independent task stores.

### 6.2 Prefer explainable groups over an opaque new score

Do not change the existing fit score merely to sort a list. Add a separately named, deterministic queue-order policy that can be explained and tested. Suggested default behavior:

1. Keep urgent owner-pinned work and due reply/materials tasks visible in their compact work area.
2. In the discovery list, prioritize unreviewed, currently actionable, recent/newly discovered high-fit opportunities, with known old listings distinguished from genuinely recent ones.
3. Place genuinely material updates in an adjacent Updated group. Important developments in an older opportunity must remain easy to find.
4. Keep recent lower-confidence/uncertain-age prospects in a visible research group instead of presenting them as ready-to-contact.
5. Leave older unchanged backlog discoverable through All Active/Watchlist rather than repopulating the daily top list.

Within a group, use documented fit bands, freshness, evidence quality, and stable identity as tie-breakers. The first implementation must publish the exact comparison order and examples. Retain a simple Newest and Highest Fit sort for deliberate exploration. Sort the full eligible result set on the server before pagination; do not reorder only the first page in the browser.

The existing 75+ interest threshold can label the current high-fit cohort where current policy already supports it. This extension does not lower Stage 2's automatic threshold, expand the buy box, or change send permissions.

### 6.3 Ranking acceptance examples

| Situation | Required behavior |
|---|---|
| New recent 82-fit opportunity and old unchanged 92-fit backlog | Fresh discovery is prominent in New & Important; the older deal remains searchable and can be pinned. |
| New 40-fit opportunity versus a worthwhile recent 82-fit opportunity | Newness does not make the poor-fit deal the recommended contact. |
| Old high-fit business gets a substantive broker reply | Show in Needs Your Action, not relabeled New. |
| Owner pins an older high-priority opportunity | Preserve deliberate priority visibly; explain the pin rather than modifying first-seen. |
| Exact same CSV is uploaded again | No new-business badge or novelty boost for the same established opportunity. |
| Listing price changes materially | Show Updated with the old/new price evidence; do not create a second business. |
| Only the score-calculation timestamp changes | No newness or material-change boost. |
| Required source is unhealthy | Show last-known information and appropriate action blockers; do not assert current readiness. |
| Owner has passed the opportunity | Exclude from active discovery even if a new source mentions it. |

### 6.4 Stable browsing and actionable explanations

A row should expose a short “Why here?” explanation, such as **New to UG · recent listing · current high-fit evidence**, **Owner pinned**, or **Broker question awaiting you**. Never present that phrase as independent financial due diligence.

New arrivals should not move rows under the pointer or discard an open detail/edit draft. Offer a restrained new-results indicator and preserve filters, pagination, scroll, and return context. Persist view preferences without overriding the owner's explicit current choice.

Queue ordering is not an SLA to the source provider. Measure time from accepted ingestion to visible ready-to-review data separately from how long Deal OS or the Google Sheet takes to supply the listing.

## 7. Simple first view, complete lead page

### 7.1 Inbox row: decision context, not every field

Recommended first-view content:

- Business name, location, and short industry descriptor.
- One truthful freshness badge and its date basis.
- Fit and evidence confidence shown separately.
- Asking price and source-labeled earnings value/period; unknowns stay visible.
- One strongest reason to look, one most consequential concern or missing fact.
- Current owner decision and a single understandable next action.
- Visible Details, Pursue, Watch, and Pass/Archive actions without opening administrative tools.

Do not stack machine status, CRM status, CIM status, operator status, review status, completeness, and multiple technical chips with equal emphasis. Preserve the information in the detail view, but elevate only what changes the owner's next action. A meaningful restriction such as **Do not contact**, **Under contract**, or **Recipient unverified** must not be hidden in a collapsed section.

An illustrative card, not a claim about a real listing:

```text
Commercial Inspection Business — Southern California
New to UG · 2 days     Fit 82 · Medium evidence confidence
Asking $1.4M · Annual Profit $490K · Period not supplied
Why review: recurring commercial work; established operating team
Check next: customer concentration and seller's reason for sale

[View details] [Pursue] [Watch] [Pass]
Next action: Verify broker contact before requesting materials
```

This applies progressive disclosure: frequent decisions remain visible; specialized evidence appears when requested. The approach is grounded in established usability guidance, but the exact information hierarchy above is this product's recommendation. [FL-W01]

### 7.2 Lead page information architecture

Use one opportunity context with a drawer or full page backed by the same data contract. Support a deep link for returning to or sharing an authorized view, where existing routing permits. “More details” must not create a separate divergent record.

| Section | Relevant information | Essential presentation rule |
|---|---|---|
| Overview | Business name, geography, industry, description, operating age, canonical listing references, source count, availability. | Distinguish missing data from false/zero; show source conflicts where relevant. |
| Financials | Revenue, asking price, source earnings metric, value, currency, period, margins/multiple where valid, seller financing, real estate. | Do not rename Annual Profit as SDE/EBITDA or invent TTM periods; derived ratios identify their inputs. |
| Ownership and sale rationale | Seller/broker roles, reason for sale, owner hours/dependence, succession/management, evidence and date. | Unknown rationale is a diligence question; an owner concern is labeled as judgment. |
| Contacts | Broker/owner name, company, email/phone, listing association, verification source, permission/suppression state. | A seller email in raw data is not automatically the correct permitted recipient. |
| Fit and risk | Current score/profile version, evidence confidence, strengths, contradictions, missing information, owner flags. | Keep evidence completeness separate from consistency and investment judgment. |
| Communications and next action | Latest relevant exchange, channel coverage, request state, waiting reason, follow-up owner/due time, contact budget. | Accepted, delivered, replied, and materials received are separate states. |
| Documents and CIM | Secure document list, type, origin, received/scan/review status, period coverage, unresolved portal/NDA prerequisites. | Metadata or “attached” text is not proof of safe retrievable materials. |
| Decision history and sources | Notes, owner edits, dispositions, archive/restore history, source observations/aliases, original listing links. | Preserve origin attribution and private permissions, including historical superseded records. |

The current drawer/fact machinery covers a meaningful subset of this. Completeness means every relevant available fact has an accessible home and every absent key fact is explicitly unknown; it does not require inventing data or acquiring new confidential data. [FL-R07, FL-R10]

### 7.3 Essential interaction behavior

Retain list context on close/back. Opening details must not mark reviewed automatically, claim a sequence, or score again merely because the owner is looking. Where a current detail route performs additional reconciliation, characterize and separate that behavior before claiming read-only semantics.

Keep contact/material actions near the lead summary with a visible explanation when unavailable. Long financial/source evidence can use sections; safety and identity contradictions remain discoverable without hunting. Use standard labels such as **Edit details**, **Archive**, **Restore for review**, and **Request broker materials** rather than internal storage vocabulary.

## 8. Editing: owner control with retained evidence

### 8.1 Three distinct kinds of data

1. **Source observations:** What a source or broker document said, with when/where it was observed. Editing must not erase these originals.
2. **Owner observations and judgments:** Corrections, verification, notes, priorities, and decisions made by Mathew. These need attribution and history.
3. **Derived values:** Scores, calculated ratios, statuses inferred under policy, and next-action proposals. These are not arbitrary editable text fields.

The existing operator-fact service permits a fixed thirteen-field set; its structured-source projection is broader. Financial fields and canonical identity do not become safely editable merely because they appear on the page. [FL-R10]

### 8.2 Editing scope and delivery order

**First release:** Make the existing seller/broker contacts, reason for sale, financing, real-estate, management, concentration, and contact notes easy to find and edit. Reuse priority/review/owner-note controls. Confirm those edits survive a source refresh without overwriting the original evidence.

**With P7-Q1:** Add or extend structured financial observations where needed for revenue, asking price, and earnings. A financial edit must include its metric, currency, period or explicit unknown, evidence source, and verification state. Editing a displayed earnings number without that context is not a complete feature.

**Through governed identity handling only:** Canonical IDs, alias ownership, repaired supersession relationships, receipt identities, and source-record identifiers are not ordinary editable fields. A suspected identity mistake routes to review, not a free-form edit box.

### 8.3 Save contract

- Show current effective value and where it came from before editing.
- Let an owner record an unverified note without falsely marking it verified. Existing verified-fact controls may remain explicit; broader editing must distinguish entry from verification.
- Record actor, timestamp, field, previous/effective value, new observation, and optional rationale/evidence reference within existing authorization and privacy rules.
- Preserve a draft on validation/network error and visibly report saving/saved/failed state.
- Use the existing version/CAS mechanism or a compatible conditional-update contract to detect stale edits. Do not silently overwrite a simultaneous owner or broker correction. HTTP conditional requests provide a standard pattern, not a mandated endpoint redesign. [FL-W06]
- Define clearing a correction separately from deleting source history: removing an override reveals the underlying evidence and records the action.
- Repeated submit must not duplicate observations or activities.
- A recipient-changing edit invalidates previously prepared content/approval authority. The next send must use a freshly reviewed envelope and current permission.
- A changed owner fact must not silently overwrite the machine score, start contact, or mark a source claim verified.

When a financial correction merits re-scoring, show that the existing score used earlier evidence and use the approved refresh/versioning pathway. Do not calculate a secret client-side replacement score.

## 9. Pursue, Watch, Pass, and availability

### 9.1 Keep separate questions separate

| Dimension | Examples | Owned by |
|---|---|---|
| Availability | Active, under contract, withdrawn, sold, unknown | Source/owner evidence with date and verification basis |
| Owner decision | Unreviewed, pursue, watch, pass | Explicit owner decision |
| Active-work visibility | Active, archived | Governed lifecycle/disposition projection |
| Contact permission | Permitted, paused, suppressed, unverified | Existing server-side policy and consent/recipient evidence |
| Materials work | Not requested, awaiting reply, NDA required, received, reviewed | Request/conversation/document state |

Avoid forcing these into one new status enum that replaces existing authorities. In particular, **under contract is not the same as a poor business fit**, and archiving an opportunity is not necessarily suppressing that broker for all other businesses.

### 9.2 Owner action meanings

**Pursue:** Worth the next evidence-gathering step. Record the decision and connect it to one existing work item or explicit waiting condition. It is not an automatic send. If linking/creating a CRM representation is necessary, use the existing unambiguous matching path; a repeated click must not create multiple records.

**Watch:** Keep for later, with a reason and optional review date/condition. A review date produces an owner reminder, not automatic contact. Do not let a high score override Watch into unattended enrollment.

**Pass / Archive:** Stop treating the opportunity as active acquisition work, keep the reason and history, and enforce the corresponding stop/hold on future outreach through existing policy boundaries. Use the owner-facing phrase **Pass & archive** where the single action has both effects.

**Restore for review:** Return to an explicitly reviewable state, retain prior decisions and contact history, and re-evaluate current availability/source/permission. It does not mean resume all previous activity.

### 9.3 Reasons matching actual acquisition decisions

The current generic reasons remain valuable compatibility categories. Add a versioned specific reason and readable label without silently changing old records. An unsupported free-text reason currently normalizes to `other`; the improved UI must not lose the owner's original explanation. [FL-R07, FL-R09]

| Owner-facing reason | Existing broad category where appropriate | Suggested behavior |
|---|---|---|
| Under contract / pending | unavailable | Archive or Watch/hold; backup-interest inquiry only by explicit, permitted owner action. |
| Sold | unavailable | Archive; no automatic re-entry. |
| No longer for sale / withdrawn | unavailable | Archive and preserve availability evidence. |
| Seller changed mind | unavailable or broker-declined, according to evidence | Archive; do not generalize to every opportunity from that broker. |
| Seller not ready / timing | timing | Prefer Watch with review condition or archive by owner choice. |
| Reason for sale needs verification | other | Prefer research/Watch; allow owner Pass with a clear judgment note. |
| Unconvincing sale rationale | not-a-fit | Preserve as owner assessment, not a verified misconduct finding. |
| Financial performance / quality concern | not-a-fit | Archive if owner chooses; retain financial evidence and uncertainty. |
| Valuation too high | valuation | Pass or Watch; an eventual price change does not silently undo the decision. |
| Owner/key-person dependence | not-a-fit | Preserve the specific risk and evidence. |
| Customer concentration | not-a-fit | Preserve the specific risk and evidence. |
| Industry / operating model mismatch | not-a-fit | Record the actual fit reason. |
| Geography mismatch | geography | Record preference; do not silently alter the global profile. |
| Financing concern | financing | Preserve owner's stated concern without asserting lender eligibility. |
| Material red flags | not-a-fit | Record bounded facts and owner judgment; sensitive notes remain permissioned. |
| Suspected duplicate | duplicate, subject to review | Review identity; selecting a reason must not itself merge or delete records. |
| Other | other | Require a meaningful note so the historical decision is useful. |

Do not train scoring feedback to treat “sold,” “under contract,” or “seller withdrew” as proof that the fit model was wrong. Keep availability outcomes separate from genuine fit feedback. Existing paths that populate generic false-positive metadata should be traced before adding any automated learning or analytics based on those fields.

### 9.4 Archive and send races

The server must enforce terminal decisions at the final send boundary, not merely disable a button. Archive should prevent new claims and cancel or hold untransmitted queued work through the current ownership rules. Already provider-accepted messages cannot be recalled by changing a local status; display an in-flight or accepted result honestly. A subsequently received reply still needs to be retained and associated without automatically restoring or contacting the archived lead.

Where current source-health gates block disposition changes, do not remove those gates casually. The design should separately evaluate a safe owner Stop/hold path based on persisted identity and version checks: stopping contact is not granting new source authority. This is a bounded safety-contract decision within P7-Q2/P7-W, not a frontend workaround.

## 10. Archives: searchable institutional memory

### 10.1 What belongs in the archive

The archive must include owner-passed opportunities and archived CRM records even when no current source row or current score remains. It must support both linked and unlinked opportunities. Historical superseded records remain attributable references, not independent active prospects and not ordinarily restorable as competing identities.

Do not implement the archive as the current triage list with only `view=dismissed`. That query still requires `scores.current_triage_eligible = 1` and an active canonical opportunity. An opportunity can disappear from those joins without the owner's decision or history disappearing. [FL-R08]

### 10.2 Search requirements

**MVP search:** business/current and known historical names, exact listing/alias references, location, broker/owner/company names when permitted, broad/specific archive reason, and owner decision notes. Provide useful filters for archive date, reason, availability, geography, industry, source, prior score range, and review disposition.

Offer scopes **Active**, **Archived**, and **All records**; the default active Inbox remains uncluttered. Preserve the search query and filters when opening a result and returning. Explain which scope is being searched and how many records match.

MVP search does not need to index full private message bodies, OCR every CIM, or add a separate hosted search service. Start with permission-checked structured fields and existing database capabilities; extend full-text document search only through a separate privacy/performance assessment.

### 10.3 Search result and historical detail

Show name/location, archived date, exact reason, availability evidence date, last owner note excerpt if permitted, last known fit with its as-of date, and the latest meaningful activity. Do not present an old score as current just because the archived record was found today.

Opening an archive result should show the same lead context with an archive banner and its historical evidence, subject to permissions. Documents/messages remain accessible only where their underlying access and retention permit. An unavailable document should say unavailable; search must not invent its content.

### 10.4 Restoration and reappearance

A reimport of an archived listing should add legitimate source evidence to the matching opportunity without clearing the disposition. A credible availability change may produce **Archived opportunity updated — review required** in a separate review surface; it must not restore, reset caps, or send automatically.

Restore requires an explicit owner action, a current identity check, coherent lifecycle updates, and review of unresolved availability/suppression. It preserves first-seen, prior archive reason/date, old communications, and contact budgets. Where restored source data is stale, show review-only or needs-revalidation, not contact-ready.

Do not use ordinary Restore to undo V3 supersession, revive a historical loser as a second current CRM row, or repurpose an immutable receipt.

### 10.5 Deletion and retention

Keep permanent deletion out of the ordinary Inbox action row. A separate administrative action may exist for mistaken/test/spam records, governed by existing document/history/reference protection. Deletion is not a strategy for keeping old opportunities out of future imports.

Archive does not promise indefinite retention of every confidential document. Respect established retention and access policies while preserving the allowed decision/audit references. Do not purge receipt-bound recovery material or change storage policies as part of a UX task.

## 11. Duplicate behavior and import feedback

### 11.1 User-facing promise

The target is **one operational card per established canonical opportunity**, with multiple sources behind it. The system should collapse proven within-file identities, attach proven cross-source observations, and flag ambiguity. It should not claim every similar-looking pair is the same business.

Equal revenue, common broker, similar title, or a changed price is insufficient identity proof. One broker can represent many businesses; one business can have several legitimate listings. The fixed Pooler/Berlin repair remains complete and must not be turned into a generic merge button.

### 11.2 Repeat-import acceptance

Re-uploading the same data may produce a distinct retained import-history event if the current importer is designed that way. It must not produce another current opportunity, reset first-seen, erase an operator correction, reactivate an archive, or generate another outreach request. Count imports separately from businesses.

The import result should distinguish parsed/accepted rows, within-file duplicates, matched existing opportunities, genuinely new opportunities, material updates, archived matches, unresolved identities, score refresh/defer status, and CRM reconciliation status where supported. Do not add those labels to the UI until the backend can truthfully supply them.

An upload success is not proof that every row was scored or linked to CRM. Required-source health can defer scoring; show the completed versus pending stages. A user should not need to repeatedly upload because a response timed out—offer status/readback of the original operation where available, and preserve ambiguous outcomes.

### 11.3 Source loss and relisting

Absence from a supplemental CSV is not proof a business was sold or withdrawn. A changed scope, filter, partial export, freshness expiry, or source outage must not silently archive leads. Conversely, historical archives remain searchable when a source disappears.

A possible relisting with new identifiers requires existing identity evidence or owner review. Do not automatically restore a passed opportunity merely because its source gave it a new date or URL.

## 12. Shorten the path to broker/owner materials

### 12.1 A lead page must answer “what can I do next?”

Use the existing Request Broker Materials preparation, approval, status, communications, and document pathways. The visible next action should be one of:

| State | Appropriate next action |
|---|---|
| Current fit/evidence is promising, recipient and transport permitted | Review the exact proposed materials request. |
| Broker/owner contact is missing or unverified | Verify or add the permitted contact evidence. |
| Opportunity is already represented in CRM | Open/link the established record; do not create another. |
| Canonical identity is ambiguous | Resolve the identity exception before contact. |
| NDA or buyer-profile step is required | Present the prerequisite to the owner; do not auto-sign or disclose confidential qualifications. |
| Request already accepted or awaiting response | Open that conversation and its current status; do not generate another initial request. |
| Broker asks a question | Owner reply task; stop inappropriate no-response follow-ups. |
| Materials are pending retrieval or scanning | Show the ingestion issue, not “broker never sent.” |
| Safe materials are available | Open materials for review; do not call their financial claims verified. |
| Paused, passed, unavailable, suppressed, or provider permission missing | Explain the block and any permitted review action. |

### 12.2 Preserve contact-policy dependencies

The desired 75+ cohort remains a roadmap target, not an authorization shortcut. This research reconfirmed that Resend's published acceptable-use policy prohibits unsolicited/cold outreach and requires opt-in. The specific listing-inquiry use and its recipient-permission evidence still need the original P8-00 determination; a publicly visible email address is not enough to infer provider permission. [FL-W07]

Gmail-native coverage remains optional as the original roadmap defines. Do not introduce a second sender or imply that Resend alone captures independent Gmail activity. No provider migration, mailbox connection, or outbound activation is included in the fresh-lead UI work.

### 12.3 Avoid sequence pressure and misleading completion

Preserve the original unresolved distinction between five total touches and five follow-ups, recipient caps, send windows, stop conditions, and re-entry rules. This extension adds archive/availability inputs to those governed decisions; it does not settle them by convenience.

An owner note, direct reply, new email address, a new CSV, a restore, or a price change must not restart an exhausted sequence. Delivery ambiguity requires status reconciliation, not another send. Archive/Pass is opportunity-specific unless the contact has made a broader opt-out request.

## 13. UX quality, accessibility, and performance

### 13.1 Usability acceptance

The list should support scanning; the detail view should support thinking. Preserve meaningful whitespace, readable labels, keyboard access, visible focus, and consistent action placement. Do not make color the only indicator of freshness, risk, or status.

Use visible, reversible owner actions with clear feedback. A draft can be cancelled without losing unrelated work; a reversible archive action can have a properly bounded Undo/Restore path, never a disguised database restore. User-control guidance supports accessible exits and recovery from mistakes; the particular archive semantics are this product's contract. [FL-W02]

The initial owner benchmark is identifying the best next action in approximately 30 seconds, as already proposed in the operating guide. It is a target to measure with Mathew, not a current performance claim. A small owner pilot is qualitative evidence, not a population usability study. [FL-R02]

### 13.2 Accessibility baseline

Target WCAG 2.2 AA for the affected flows. Interactive pointer targets should meet the 24-by-24 CSS-pixel minimum or a valid spacing/other exception; aim for more generous touch controls where layout allows. Keep keyboard focus visible and not obscured by drawers/sticky controls. Announce save/import/search-status changes programmatically without gratuitously moving focus. [FL-W03, FL-W04, FL-W05]

Test tab order, dialog focus trapping and restoration, Escape/cancel behavior, label/error association, screen-reader-friendly action names, loading announcements, and narrow layouts. Selecting Archive must not accidentally trigger the adjacent contact action.

### 13.3 Performance recommendations

Proposed pilot objectives under documented representative data and healthy local/staging dependencies: responsive list/detail interaction, queue responses around one second or better at p95, and useful archive results within two seconds at p95. Treat these as measurement targets to calibrate, not promises or reasons to hide errors.

Use server pagination, deterministic tie-breakers, bounded result sizes, lazy detail loading, and indexed queries appropriate to actual access patterns. Inspect query plans before adding indexes. Do not fetch every archived message/document into the browser to search it, and do not perform full-table repair inspections on ordinary page loads.

Keep sorting/counts/filtering consistent across server and UI. Test at current representative volume and a documented growth fixture, including at least a full supported CSV batch and a materially larger archive set. Record dataset size and environment with results.

The recorded 1 GB deployment capacity and repaired memory issue are operating context. Do not assume the UX can allocate another full database copy per request; preserve existing resource configuration and measure changed paths.

## 14. Data, safety, and API boundaries

### 14.1 Extend existing authorities

Continue using the existing canonical opportunity, source observation, score/evidence, operator fact, disposition, CRM lifecycle, request/outbox, and secure-document responsibilities. Conceptual additions may include reliable first-seen/last-material-change facts, specific disposition reasons, and archive-friendly read projections. These are not instructions to add a separate record per UI section.

If the existing schema cannot express a required durable fact, propose the smallest compatible additive contract within the owning work package. Test previous-schema migration and rollback compatibility. Do not repurpose old timestamps or overload notes with opaque unvalidated state solely to avoid a migration.

### 14.2 Server-side authorization

View/edit/archive/restore/search/contact endpoints must enforce the current role and record permissions on every request; hiding a UI button is not authorization. Archive search and historical detail must not reveal information through snippets, result counts, aliases, or documents the requester cannot otherwise access. Default-deny and per-request checks are supported by OWASP guidance. [FL-W08]

Protect owner overrides and archive intent against refresh races. Restore and archive need coherent transitions across linked state or an explicit recoverable outcome; do not show Saved after only half a cross-record transition succeeded. Preserve immutable repair history and existing suppression authority.

### 14.3 Untrusted text and minimal disclosure

Render owner/source/broker strings safely. Treat source CSV, email, and CIM content as data, never implementation instructions or authority to run commands. Do not send whole lead histories or archived document contents to a model for a simple list sort.

Logs should use bounded reason codes, operation IDs, counts, and privacy-safe context. Do not log every edited value, broker address, or document body in routine diagnostics. Audit records still need sufficient authorized evidence to reconstruct a decision.

### 14.4 Failure behavior

Source unavailable: show last-known state and clear action restrictions. Save conflict: retain the user's draft and show the differing versions. Import timeout: inspect original operation status before retry. Archive race with in-flight send: show the true outcome and prevent another send. Search unavailable: show an error distinct from no matches. Missing historical source/document: preserve the archived decision with an explicit evidence limitation.

## 15. Delivery slices, dependencies, and priorities

These slices operationalize the original packages. Their individual implementation briefs should identify actual files, current baseline, permitted writes, acceptance evidence, and delivery authority. Adoption of this roadmap does not authorize every slice to execute simultaneously.

### MVP-FL-00 — Confirm the owner-flow baseline

**Priority:** First, short discovery within the first implementation work package, not a new research project.  
**Parent:** P7-Q1, P7-Q2, P7-W.

Trace the mounted Inbox and detail routes, the source-to-score path, owner fact editor, archive/restore services, and current query constraints. Characterize five existing user journeys with synthetic local records: new lead, repeat-source observation, owner edit, unavailable/pass/archive, and materials next action. Identify the actual timestamp/provenance gaps and any ongoing agent branch that already addresses them. Reuse completed work rather than redispatch it.

Produce a small capability/side-effect map and a representative acceptance fixture set. Distinguish current behavior from mock-only screens. Record unresolved numerical buy-box values without changing them. Exit when the implementer knows which durable facts exist and which changes need a reviewed contract; do not spend days re-auditing the completed fixed repair.

### MVP-FL-01 — Fresh-first Inbox with honest evidence

**Priority:** First owner-visible increment.  
**Parent:** P7-Q1, P7-Q2, P7-W.  
**Depends on:** FL-00 and trustworthy timestamp/evidence semantics for the claims shown.

Deliver newness labels, deterministic server-side ordering, explicit owner-pin/needs-action treatment, retained search/filter context, and a simplified row. Preserve fit, confidence, and score versions. Remove misleading financial labels where the source does not support them; show metric/period unknowns rather than block all useful browsing until every historical field is recovered.

Implement first-seen/material-change support only through a justified durable contract. Test reimports, old listings first seen today, unknown-age records, refreshed score dates, contradictory sources, time boundaries, and manual priority. Keep older opportunities findable. Show an honest pipeline status when source or scoring stages have not completed.

**Done:** A fresh worthwhile opportunity beats unchanged old backlog in the intended default view, without a poor-fit row or a reimport obtaining an undeserved novelty boost. The owner can explain why each top item appears.

### MVP-FL-02 — Fast disposition and a real archive

**Priority:** Immediately after FL-01; prevents accumulating another unusable backlog.  
**Parent:** P7-W, P7-Q2; coordination with P8-01/P8-05 stop behavior.

Unify the existing Pass/Archive presentation, preserve exact reason/detail, expose archive search beyond current-score eligibility, and implement or complete coherent restore-for-review. Search historical aliases and allowed notes/contacts while retaining permissions. Keep decision reason distinct from availability and scoring feedback.

Test archives after source loss, current-eligibility removal, reimport, review changes, and historical supersession. Check that archive blocks future untransmitted work correctly and that restore does not resume mail or erase previous caps. If that requires a service/storage contract change, isolate it in the lifecycle slice; do not disguise it as a label-only edit.

**Done:** Mathew can remove an unsuitable lead, later find it with the recorded reason, and restore it deliberately without accidental re-contact or duplicate revival.

### MVP-FL-03 — Complete lead detail and safe editing

**Priority:** Next; portions can proceed alongside FL-02 only with non-overlapping file ownership.  
**Parent:** P7-Q1 and P7-W.

Organize the existing drawer/page into the sections in Section 7, reuse existing fact controls, and provide clear edit/save/conflict behavior. Surface seller rationale, contacts, risk, source differences, communication/material status, and the next action. Extend financial evidence editing only with typed metric/period provenance under P7-Q1.

Preserve source observations, owner-verified precedence, historical notes, and immutable identity. A recipient edit must invalidate prepared send authority. Provide unknown values rather than fake completeness, and do not convert all editor entries to verified claims without a deliberate verification action.

**Done:** The owner can inspect all relevant available context, correct a supported fact, see its provenance after refresh, and return to the same place in the queue.

### MVP-FL-04 — Lead-to-CIM next-action handoff

**Priority:** After the basic lead and lifecycle surfaces are usable; transport research proceeds earlier in parallel.  
**Parent:** P7-W and P8-01, with P8-00 permission and P8-02 material capture retained.

Connect Pursue to one existing work item/current CRM representation and expose the correct materials preparation/review action. Complete missing navigation rather than a new email system. Cover unverified contact, exact recipient selection, existing requests, broker questions, NDA prerequisites, document retrieval problems, and materials review.

Use synthetic providers locally. Live sending requires separate cohort/transport/readiness authorization. If provider applicability is unresolved, deliver a usable draft/prerequisite flow and label the live communication gate incomplete rather than claiming end-to-end production sending.

**Done:** Each pursued lead has a clear next action or waiting reason; eligible permitted requests use existing durable communication authority, and actual inbound/material states remain visible.

### MVP-FL-05 — Owner pilot, reliability, and adoption

**Priority:** Close the first owner-experience release; do not postpone until autonomous outreach exists.  
**Parent:** P7-W and P8-06.

Run the integrated synthetic test matrix, a small owner-reviewed walkthrough, and representative performance/accessibility checks. Include fresh high-fit, older high-fit, new low-fit, unknown-age, material-update, archived/reimported, and broker-response/materials cases. Check backend-connected paths as well as mocked UI. Preserve observed failures and code revision in the handoff.

Measure owner time/navigation without inventing statistics. Document what was locally tested, hosted-CI tested, deployed, and live-piloted. Carry unfinished provider/materials capabilities back to the original roadmap with explicit status. Do not hold a useful UI release hostage to optional AI or Gmail-native work.

**Done:** The owner can complete the intended daily session and find an archived decision without engineering assistance; any remaining gap has a specific work item and honest status.

### 15.1 Execution order

```text
Completed fixed repair + memory closeout (preserve; do not repeat)
  -> FL-00 baseline / timestamp and lifecycle contract check
  -> FL-01 fresh-first Inbox + minimum Q1/Q2 truthfulness
  -> FL-02 archive/search/restore
  -> FL-03 complete detail/editing
  -> FL-04 existing next-action / permitted manual materials loop
  -> FL-05 owner pilot and release acceptance
  -> continue original P8-02 / P8-03 / P8-04 / P8-05 / P8-06
  -> original P9-01 evaluated extraction and decision briefs

In parallel: P8-00 provider/contact scope and necessary buy-box decisions.
```

P7-Q1/Q2 work beyond the minimum UI-safe slice remains on the original roadmap. FL-04 can integrate already-available P8-02 outputs without rebuilding ingestion. This is an overlapping dependency map, not two budgets for the same code.

## 16. Acceptance scenarios

The following are proposed release tests and observations, not tests already run. The implementation owner should map each to existing or new focused, integration, browser, or owner-pilot evidence. Test names and exact file layout can follow current repository conventions.

| ID | Scenario | Expected result |
|---|---|---|
| FL-T01 | Exact same CSV uploaded twice | Same established opportunities; no false newness or extra logical outreach. |
| FL-T02 | Proven Sheet and Deal OS listing identity match | One active opportunity; both source observations retained. |
| FL-T03 | Equal revenue/title/broker but different businesses | No automatic identity collapse without sufficient evidence. |
| FL-T04 | Ambiguous source aliases | Visible identity exception; no hidden merge/contact. |
| FL-T05 | Known superseded record appears through legacy link | Correct survivor context with attributable historical reference. |
| FL-T06 | New fresh 82-fit versus unchanged old 92-fit | New & Important prioritizes the intended fresh discovery. |
| FL-T07 | New low-fit versus good fresh fit | Newness does not convert poor fit to contact-ready. |
| FL-T08 | High completeness with material contradictions | Risk visible; no unsupported high-confidence contact label. |
| FL-T09 | CSV refresh changes only observed timestamps | No false first-seen/material-change reset. |
| FL-T10 | Re-score with identical semantic evidence | No false New or Changed badge. |
| FL-T11 | Material asking-price correction | Updated badge and source history; original newness retained. |
| FL-T12 | Old listing first imported today | New to UG and old listing age both visible. |
| FL-T13 | Missing or conflicting listing dates | Unknown/conflict shown; no fabricated recent date. |
| FL-T14 | Legacy records have no trustworthy first-seen | Existing/unknown, not a migration-created new-lead flood. |
| FL-T15 | Freshness boundary across timezone/day change | Deterministic labels and ordering under documented clock semantics. |
| FL-T16 | Owner pins an older lead | Explicit priority remains visible without date mutation. |
| FL-T17 | Broker response arrives for an old lead | Needs Your Action; not falsely relabeled New. |
| FL-T18 | Several pages with tied rank values | Stable, server-ordered pagination; no duplicate/missing page items for a fixed snapshot. |
| FL-T19 | New results arrive while detail/edit is open | No lost draft, involuntary focus change, or row movement under action. |
| FL-T20 | Source/scoring is unavailable | Last-known data and pending/blocked stage clearly labeled. |
| FL-T21 | Open list/detail/search | No unintended scoring, reconciliation, or send side effect in the promised read path. |
| FL-T22 | Basic lead row | Core fit/freshness/evidence/next action readable without technical clutter. |
| FL-T23 | Open detail and return | Query, filters, page, scroll, and focus context retained. |
| FL-T24 | Missing source financial period | Explicit unknown; no TTM/SDE/EBITDA relabel. |
| FL-T25 | Conflicting financial observations | Both preserved, effective view and source selection explained. |
| FL-T26 | Edit one allowed owner fact | Authorized save with actor/date/provenance; source history untouched. |
| FL-T27 | Source refresh after verified correction | Owner correction retained under current precedence; source observation updated separately. |
| FL-T28 | Enter unverified information | No automatic verified label unless deliberately verified. |
| FL-T29 | Concurrent owner/source update | Stale-save conflict handled without silent overwrite or lost draft. |
| FL-T30 | Repeated save click | No duplicate logical mutation/activity. |
| FL-T31 | Clear an override | Underlying evidence returns; historical correction remains attributable. |
| FL-T32 | Recipient edited after a prepared message | Old envelope approval invalidated; new review required. |
| FL-T33 | Attempt to edit raw score, identity, or receipt | Rejected at server boundary; no UI-only protection. |
| FL-T34 | Pass from list and from detail | Same durable decision and understandable result. |
| FL-T35 | Specific reason not in old generic enum | Specific wording retained with a valid broad code; not silently lost as `other`. |
| FL-T36 | Other reason selected | Meaningful note required by the chosen new UI contract. |
| FL-T37 | Under-contract lead | Hold/archive behavior; no uncontrolled contact or false poor-fit feedback. |
| FL-T38 | Seller withdrew or sold | Archived from active work with dated evidence. |
| FL-T39 | Sale reason missing | Unknown/research-needed; no invented bad-faith allegation. |
| FL-T40 | Archive while a touch is queued | Future untransmitted work is safely stopped/held. |
| FL-T41 | Archive while provider acceptance is in flight | Honest race outcome; no claim to recall an accepted message. |
| FL-T42 | Reply arrives after archive | Retained history/task as appropriate; no automatic restore/send. |
| FL-T43 | Search archives after source disappears | Archived decision remains findable without current-source eligibility. |
| FL-T44 | Archived record lacks current score or CRM link | Search/detail still represents allowed historical record accurately. |
| FL-T45 | Search old name/listing alias | Correct canonical/historical result without a duplicate active lead. |
| FL-T46 | Search archive reasons and owner notes | Relevant authorized result; record count/scope clear. |
| FL-T47 | Search Active versus Archived versus All | Correct scope, filters, totals, and preserved return context. |
| FL-T48 | Reimport archived opportunity | Archive intent stays effective; new evidence does not reactivate it. |
| FL-T49 | Credible relisting/availability change | Review-needed event; no automatic reset or send. |
| FL-T50 | Restore for review | Prior reason/history/first-seen/contact caps remain; outreach stays stopped. |
| FL-T51 | Restore historical superseded loser | No competing active identity created through ordinary Restore. |
| FL-T52 | Viewer attempts edit/archive/restore | Server refuses unauthorized mutation; read permissions preserved. |
| FL-T53 | Search attempts to expose restricted notes/documents | No snippet, count, or document-access leak. |
| FL-T54 | Pursue repeated across an unlinked lead | One correct next-action/CRM representation; no duplicate creation. |
| FL-T55 | Existing materials request | Opens the existing request/thread; no duplicate initial contact. |
| FL-T56 | Provider permission or recipient evidence missing | Block/preparation/prerequisite displayed; score alone does not authorize send. |
| FL-T57 | Broker asks a question or requires NDA | Owner action replaces no-response pressure; no auto-signature. |
| FL-T58 | Attachment exists but retrieval/scan incomplete | Pending/error state; no false “CIM reviewed” claim. |
| FL-T59 | Safe correct-business materials available | Review action and provenance shown; factual verification remains separate. |
| FL-T60 | Wrong-business or ambiguous materials | Unassigned/conflict; no silent factual overwrite. |
| FL-T61 | Import saved but scoring deferred | Separate stage results; no unnecessary repeat-upload instruction. |
| FL-T62 | Import request times out after server acceptance | Outcome inspected before retry; ambiguity visible. |
| FL-T63 | Keyboard/narrow viewport/archive dialog | Focus, labels, cancellation, and controls are usable; no accidental adjacent send. |
| FL-T64 | Save/import/search status updates | Accessible status announcements with honest success/failure. |
| FL-T65 | Representative queue/archive volume | Documented latency, bounded memory, and query behavior; no all-history browser download. |
| FL-T66 | Owner daily walkthrough and archive recovery | Measured navigation/effort with limitations; no fabricated benchmark. |


## 17. Release gates and definition of done

### 17.1 Definition of ready for an implementation slice

A slice is ready when its outcome, known code paths, unresolved contract changes, representative fixtures, test evidence, delivery permissions, and real stop conditions are specified. A simple UI slice should not inherit the old repair's production ceremony. A durable archive/identity/send-boundary change still needs appropriate contract review.

Do not begin by asking the owner to approve every helper name. Ask only for consequential unresolved policy or scope decisions; otherwise use this document's recommendations with explicit attribution in the brief.

### 17.2 Completion levels

| Level | Evidence required | Claim permitted |
|---|---|---|
| Documented | Addendum/brief exists | Goal added to roadmap, not implemented. |
| Locally implemented | Code + meaningful focused/integration/rendered checks | Local behavior demonstrated, not deployed. |
| Reviewed and merged | Accepted diff, required CI, current commit recorded | Repository contains the feature. |
| Deployed | Explicit deployment authorization + deployment verification | Exact version is live. |
| Owner-piloted | Authorized live/synthetic scope, observed user results and limits | Specific journey accepted in the stated environment. |
| Outreach enabled | Existing permission/provider/safety/activation gates separately satisfied | Only the approved cohort/channel can send under its policy. |

### 17.3 MVP exit criteria for this extension

The added owner-experience scope is complete when fresh ranking is honest and stable, detailed available evidence is accessible, supported edits persist with provenance, Pass/Archive is coherent, archive search survives source/score inactivity, restoration is explicit and does not send, and every pursued opportunity has an understandable next action or waiting condition.

The user must be able to perform the daily review and historical search without an engineering agent operating the database. Required safety, privacy, access, and data-integrity acceptance must pass. A blocked provider channel may still allow a release of Inbox/archive improvements, but that release must not be called a fully live end-to-end CIM-request workflow until P8-00/P8-01 are accepted.

Existing repair receipts, disclosure limits, and source/recipient authority are not weakened to obtain acceptance. The completed fixed-pair repair is not replayed as a regression test in production.

### 17.4 Rollout approach

Use local disposable fixtures first, required hosted CI, and a separately authorized deployment. Preserve the 1024 MB repository setting. Verify read paths before a live owner walkthrough and identify any GET route that currently performs a mutation or reconciliation. Start the owner pilot with a small deliberate set; do not auto-send to every qualifying row as a UI test.

Retain a rollback plan for changed UI/query contracts. Rollback must not drop archive history, erase operator facts, or undo repaired canonical relationships. Use normal operational recovery authorization for any actual production data change.

## 18. Measurements and engineering estimates

### 18.1 Product measures

Measure ingestion-to-visible-opportunity delay, time to identify the next action, clicks to relevant evidence/request preparation, archive retrieval success, and owner review effort. Track false-new appearances, accidental resurfacing, duplicate active representations, and incorrect recipient/contact attempts as quality indicators.

Separate new opportunities from import rows, newly received CIMs from duplicate attachments, and reviewed decisions from automated scores. Record sample sizes and missing measurements. “No data” is not zero failures, and a small pilot is not a calibrated conversion forecast.

Use existing events and reports where sufficient. Do not create a new analytics platform to measure a few owner outcomes.

### 18.2 Effort range for the added owner-experience scope

These are planning judgments based on the source-level reuse assessment, not quotes, measured agent runtimes, or a promise. They include focused tests/review within each slice. Final cross-flow verification is counted in FL-05 rather than repeated in every row.

| Slice | Planning range |
|---|---:|
| FL-00 current-flow/contract confirmation | 2–4 engineering hours |
| FL-01 freshness foundation and Inbox ordering | 8–16 hours |
| FL-02 archive/search/restore/disposition coherence | 8–16 hours |
| FL-03 detailed lead page and supported editing | 8–16 hours |
| FL-04 existing next-action/materials integration | 6–12 hours |
| FL-05 integrated pilot, accessibility, performance, and release evidence | 4–8 hours |
| **Total overlapping delivery scope** | **36–72 engineering hours** |

Do not add this entire total to the old roadmap's 134-hour working estimate: substantial Q1/Q2/W/manual-communication work overlaps, and the old estimate included repair work now recorded as complete. Rebaseline actual remaining effort after FL-00 and subtract accepted reused work.

The range excludes a new mail provider integration, full native Gmail sync, generalized identity repair, a financial model/rule-builder, autonomous contact activation, broad data migration, or evaluated CIM extraction. Missing durable first-seen evidence, historical archive coverage gaps, and typed financial editing may push individual slices beyond the range; identify those before expanding scope.

At six productive engineering hours per day, 36–72 hours represents approximately 6–12 engineering days. Codex wall-clock execution can differ substantially, and provider approval, owner availability, and real broker response time are separate calendar factors. The owner wants longer autonomous runs, not an invented speed guarantee.

### 18.3 Faster delivery contract

Use one implementation owner and one independent reviewer per coherent outcome. Several focused commits may fit inside a longer autonomous session. Ordinary in-scope diagnosis/corrections should not require another ChatGPT-to-Codex round trip. Stop for changed authority, unavailable required access/evidence, new disclosure, or a genuinely unresolved design decision—not every failed local test. [FL-R02]

Work orders should state the outcome, relevant context, constraints, allowed resources/actions, and observable finish condition. Current OpenAI guidance supports explicit goals and verification rather than prescribing every intermediate thought or step. The risk-specific acceptance requirements here remain intact. [FL-W09, FL-W10]

Every Codex prompt includes an exact model and reasoning level above and inside its execution text. Suggested starting settings: GPT-5.6 Sol / Medium for a bounded UI or documentation task; GPT-5.6 Sol / High for timestamp, lifecycle, or concurrency contracts. These are recommendations to recheck against available models at task start, not permanent architecture. [FL-W11]

## 19. Decision register and unresolved policy

| Decision | Position in this addendum | Status |
|---|---|---|
| Add these goals to the MVP | Fresh-first, simple/full-detail, editing, archive/search, and CIM next action are required outcomes. | Owner-directed by latest request. |
| Preserve existing roadmap | All original packages/dependencies remain; this extension is additive. | Owner-directed. |
| Prioritize owner workflow now | FL-00 through FL-05 under P7-Q1/Q2/W and P8-01. | Research recommendation within delegated sequencing discretion. |
| Exact freshness bands | New to UG 7 days; recently listed 30 days, with honest unknowns. | Pilot recommendation, not existing production configuration. |
| Exact ranking comparisons | Explicit work areas and deterministic order; publish comparison fixtures before release. | Product contract to finalize within FL-01 without a new blended score. |
| Financial size/geography criteria | Keep unresolved legacy/current differences visible; no silent thresholds changed. | Owner confirmation still needed for an operative profile change. |
| Under-contract behavior | Default no automatic contact; Watch/archive with explicit backup-interest exception only through permitted owner action. | Preserves original roadmap direction. |
| Archive explanation | Preserve both broad compatibility category and precise owner reason; Other needs a note. | Recommended lifecycle/UI contract. |
| Restore | Review-only re-entry; no automatic outreach or contact-cap reset. | Required safety outcome, aligned with existing restore service. |
| Financial edits | Typed metric/period/source observations; no arbitrary score/identity overwrite. | Required design boundary under P7-Q1. |
| Provider permission/Gmail scope | Retain P8-00; no provider switch or mailbox access inferred. | Unresolved original decision, not blocked UI work. |
| Follow-up touches/cadence/caps | Preserve original unresolved policy reconciliation and explicit activation. | Not settled by this addendum. |
| Deep archived document/body search | Defer beyond structured MVP archive search unless a measured need justifies it. | Recommended scope limit. |

The unresolved buy box is documented in `Uckele-Group-Acquisition-Criteria-and-Decision-Policy.md`. Historic $300K–$750K implemented annual-profit scoring, public $250K–$750K+ references, and broader owner discussions are not interchangeable current approval. The UI should expose the profile version and relevant evidence without pretending those conflicts have been resolved. [FL-R12]

## 20. Documentation integration and continuation

### 20.1 Preserve both primary references

Keep the original September 20 roadmap and `Summarize Uckele MVP.txt` unchanged. This addendum is the new MVP extension. An optional compiled reading copy appends it to the exact original roadmap bytes; that copy is not a second independent source of truth.

Update START HERE to point to this extension and the current status source. Keep the repository baseline separate from the product roadmap. Do not upload every intermediate execution report as a standing Project source.

### 20.2 Repository adoption

This file package has not been pushed to GitHub or attached to Project membership by this research task. To adopt it in Codex, add the new addendum at the suggested path, link it from a small roadmap index/agent pointer consistent with the existing instructions, and preserve the original master bytes and PR #21 boundaries. A docs-only PR can carry that integration; source-code implementation is a separate approved work package.

If another agent is already executing UG-OWNER-FLOW-01, do not interrupt it or start a competing edit of the same files. Compare its actual accepted results with this addendum and implement only remaining gaps. The research source describes desired outcomes, not a command to redispatch completed work.

### 20.3 New research window summary

The known fixed Pooler/Berlin repair is owner-reported complete and recorded in the repository. Memory configuration closeout is merged in PR #23; production remains last-reported v127 and was not audited here. The next product priority is the additive fresh-lead-to-CIM owner experience: reliable newness, simple Inbox, complete editable detail, durable archive/search, then the existing permitted manual materials loop. All original automation and diligence stages remain. Do not rerun the repair or assume sending is enabled.

## 21. Source register and research limits

### 21.1 How to interpret sources

`FL-D` denotes current owner direction. `FL-R` denotes the parent roadmap, provided files, or selected repository code. `FL-W` denotes public research. Product defaults, estimates, and exact recommendations are identified as recommendations; none is presented as a benchmark established by these sources.

Repository reads are pinned to `dca501e4220173b187e69b3e2e4639c5d21d0d62` unless another revision is explicitly named. The source review was selected-path research, not an exhaustive code or production audit. All public references were consulted for this September 22 planning update; provider/model guidance must be rechecked when used operationally.

### 21.2 Owner and project evidence

- **FL-D01:** Mathew's current request in this conversation: add the fresh-lead, simple/full-detail UI, editing, archive/search, and fast CIM-review goals to the existing MVP roadmap without replacing its work; researcher may prioritize the additions.
- **FL-R01:** Original 1,384-line `2026-09-20-uckele-group-product-vision-and-roadmap.md`; SHA-256 `f2238f9b88f8cc328007f4978d2cbcbbf4d40e53b9e4fbf7cd8f27b61f7d14fb`. In particular Sections 1, 5, 6, 8–13, and 17–24. Exact repository source on preserved documentation branch: https://github.com/muckele/uckele-group/blob/f6b09a6c9c2e8ed2cca458da201038e4e7ae8e87/docs/roadmap/2026-09-20-uckele-group-product-vision-and-roadmap.md
- **FL-R02:** `Summarize Uckele MVP.txt`, the owner-workflow operating discussion; division of labor, fewer handoffs, risk-based verification, and acquisition-first UX. This is the workflow document, not the different same-named file describing a ZIP handoff.
- **FL-R03:** Remote `main` GET read resolves to `dca501e4220173b187e69b3e2e4639c5d21d0d62`: https://api.github.com/repos/muckele/uckele-group/git/ref/heads/main . This endpoint is mutable; the revision above is the recorded observation.
- **FL-R04:** `docs/operations/current-system-baseline.md`, owner-attributed fixed-pair closure and operational limits: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/docs/operations/current-system-baseline.md
- **FL-R05:** PR #21 read as open/draft at head `f6b09a6c9c2e8ed2cca458da201038e4e7ae8e87`; documentation only and unchanged by this task: https://github.com/muckele/uckele-group/pull/21
- **FL-R06:** `src/components/admin/AcquisitionInbox.jsx`, beginning of file through row actions/views and queue presentation: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/src/components/admin/AcquisitionInbox.jsx
- **FL-R07:** `src/components/admin/OpportunityDrawer.jsx`, lines 1–180; editable field list, Pass form, verification form, and detail behavior: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/src/components/admin/OpportunityDrawer.jsx
- **FL-R08:** `server/storage/sqlite.js`, lines 9533–9695; current-eligibility and active-opportunity joins, name/key search, acquisition-priority ordering, and observed freshness: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/server/storage/sqlite.js
- **FL-R09:** `server/services/leadLifecycle.js`, lines 1–185; archive codes, archive/restore state, and generic reason normalization: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/server/services/leadLifecycle.js
- **FL-R10:** `server/services/dealHunterOpportunityFacts.js`, lines 1–195; editable versus source-observation fields and validation: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/server/services/dealHunterOpportunityFacts.js
- **FL-R11:** `server/services/dealHunterTriage.js`, lines 1–140 and conversation-provided path analysis; persisted-score triage and allowed query views/sorts: https://github.com/muckele/uckele-group/blob/dca501e4220173b187e69b3e2e4639c5d21d0d62/server/services/dealHunterTriage.js
- **FL-R12:** `Uckele-Group-Acquisition-Criteria-and-Decision-Policy.md`, preserved Project source-pack record, together with the dated owner-workflow pilot's acquisition-profile comparison. Conflicts remain explicitly unresolved.

### 21.3 Public research

- **FL-W01 — Progressive disclosure:** NN/g, *Progressive Disclosure*. Supports separating frequent/simple decisions from advanced detail. https://www.nngroup.com/articles/progressive-disclosure/
- **FL-W02 — Recoverable user actions:** NN/g, *User Control and Freedom*. Supports clear exits/cancellation and recovery from mistakes. https://www.nngroup.com/articles/user-control-and-freedom/
- **FL-W03 — Pointer targets:** W3C, WCAG 2.2 Understanding SC 2.5.8. https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
- **FL-W04 — Keyboard focus visibility:** W3C, WCAG 2.2 Understanding SC 2.4.11. https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum
- **FL-W05 — Status announcements:** W3C, WCAG 2.2 Understanding SC 4.1.3. https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- **FL-W06 — Conditional edits:** IETF, RFC 9110, HTTP Semantics, Section 13.1.1 If-Match. https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match
- **FL-W07 — Sending permission:** Resend, Acceptable Use Policy, page states last updated August 27, 2026. The actual recipient/cohort applicability remains a separate decision. https://resend.com/legal/acceptable-use
- **FL-W08 — Access enforcement:** OWASP Authorization Cheat Sheet. https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- **FL-W09 — Agent task structure:** OpenAI, Codex best practices; current URL redirects to ChatGPT Learn. https://developers.openai.com/codex/learn/best-practices
- **FL-W10 — Scoped goals and verification:** OpenAI, *Using Goals in Codex* and reasoning-model guidance. The product need is a bounded completion contract, not a requirement to enable a particular Goal feature. https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex ; https://developers.openai.com/api/docs/guides/reasoning
- **FL-W11 — Suggested coding model:** OpenAI, GPT-5.6 Sol model reference; Medium and High are supported reasoning settings at research time. https://developers.openai.com/api/docs/models/gpt-5.6-sol

### 21.4 Not verified by this research

No claim is made that the new freshness fields, ranking defaults, full archive scope, richer reason taxonomy, typed financial editor, or all UI states already exist. No current production UI, live CSV result, mailbox/provider entitlement, sent message, document ingestion, or new performance benchmark was exercised. Existing fixed-pair repair evidence remains owner-attributed. Detailed implementation may find additional affected paths; re-estimate and document those changes without erasing the original roadmap.

## Change log

- **2026-09-22 / v1.0:** Added owner-directed fresh-lead, complete-detail/edit, archive/search, and short-CIM-handoff MVP goals; mapped them into the preserved original roadmap; corrected the earlier underestimate of existing Inbox UI controls; recorded current archive/query and first-seen gaps; added delivery slices, 66 acceptance scenarios, risk boundaries, and effort ranges. No repository or production changes performed.
