# Uckele Group: Product Vision, Hardening Roadmap, and Broker-Materials Automation

**Document ID:** UG-VISION-ROADMAP-2026-09-20  
**Document version:** 1.0 — researched reference draft  
**Research date:** September 20, 2026, America/Los_Angeles  
**Product owner:** Mathew Uckele  
**Audience:** Codex project agents, implementation/review agents, and the owner  
**Suggested repository location:** `docs/roadmap/2026-09-20-uckele-group-product-vision-and-roadmap.md`  
**Status:** The owner approved the product direction. This document records that direction, current evidence, and implementation recommendations. Detailed policy values and production activation still require their specified approvals.

> **Operating rule:** Finish and verify the current integrity work. Reuse the existing acquisition, communication, and document infrastructure. Build a dependable broker-to-materials-to-decision workflow before expanding autonomous sending. A roadmap is not permission to mutate production or contact a broker.

## Reading guide

Agents starting a task should read Sections 1–5, then the relevant work package in Section 18 and the agent contract in Section 23. Agents working on communications must also read Sections 6–13. Reviewers should use the acceptance matrix in Section 19. The owner can start with Sections 1, 17, 18, 21, and 24.

### Contents

1. Product vision and business outcome
2. Evidence labels and authority
3. Baseline and current work in progress
4. Existing capabilities: reuse before adding
5. Decisions that must not be silently conflated
6. Provider choice and permission to contact
7. Target architecture and ownership boundaries
8. Outreach eligibility and score-policy evolution
9. Sequence lifecycle, cadence, caps, and stops
10. Delivery, concurrency, idempotency, and reconciliation
11. Inbound email, threading, and Gmail options
12. Secure attachment and CIM ingestion
13. In-application communication and owner work
14. AI-assisted interpretation and diligence
15. Security, privacy, and compliance
16. Operations, recovery, and measurable outcomes
17. Release sequence and activation gates
18. Work packages and dependencies
19. Acceptance-test matrix
20. Risks and mitigations
21. Engineering estimates and calendar assumptions
22. Documentation, decisions, and source governance
23. Agent execution contract
24. Immediate next actions and owner decisions
25. Source register and research notes

---

## 1. Product vision and business outcome

### 1.1 What we are building

Uckele Group should become Mathew's acquisition operating system: a private workspace that turns sourced business-sale opportunities into evidence-backed acquisition decisions with reliable communication and a clear next action.

The intended end-to-end journey is:

```text
Required source + optional permitted supplemental source
  -> normalize observations and resolve canonical opportunity
  -> score fit and expose confidence, contradictions, and missing evidence
  -> qualify for owner review or an explicitly authorized outreach policy
  -> request broker materials through the selected permitted transport
  -> log replies and delivery events in the correct conversation
  -> receive and safely store materials
  -> review evidence and identify missing information
  -> advance, hold, or pass with an accountable reason and next action
```

The owner wants qualifying opportunities at **75 or above** to become candidates for controlled automated broker contact, followed by a limited follow-up sequence when materials are not received. The application should support sending and replying directly, capture the broker conversation, obtain a **CIM—Confidential Information Memorandum—or other broker materials**, and eventually assist with analysis and re-evaluation. This is an approved direction, not approval to activate every proposed behavior immediately. [D01]

The user initially referred to a “SIM.” This document uses **CIM** consistently, while retaining the broader existing interface term **Request Broker Materials**. Some brokers provide a teaser, financial statements, an NDA portal, or a data-room link rather than a file explicitly called a CIM. The workflow must handle those real outcomes instead of treating every attachment as completion.

### 1.2 What success means

The primary business outcome is **more useful acquisition decisions per unit of owner effort**, not more email or a larger CRM.

A successful work session lets Mathew identify the best next action, understand why an opportunity deserves it, take that action, and later reconstruct the evidence and communication without asking an engineering agent to explain the database.

Good outcomes include a well-supported Pass, a broker identifying an NDA prerequisite, a material contradiction caught early, or a decision to stop an exhausted outreach sequence. A signed LOI or acquisition is a business outcome to measure, but it is not a software acceptance requirement under our control.

### 1.3 Product principles

- **One sale opportunity, one current operational identity.** Multiple listings and financial observations are evidence, not automatic permission to create more active deals.
- **Evidence remains attributable.** A surviving CRM row does not erase another row's historical email, notes, or financial provenance.
- **Score ranks; policy authorizes.** A score of 75 is not recipient verification, contact permission, source freshness, or owner intent.
- **An inbound response changes the work.** Do not keep sending “following up” messages after a broker asks a question or supplies an NDA.
- **Automation is bounded.** Each sequence has a purpose, policy version, maximum touches, stop rules, and an accountable activation.
- **The owner can intervene.** In-app replies, pause, takeover, and exception handling exist before autonomous volume expands.
- **Uncertainty is visible.** Unknown delivery, ambiguous identity, uncertain document type, and missing financial period must not become confident success labels.
- **Small durable mechanisms beat parallel systems.** Extend existing services, outbox, request history, and document vault before introducing another queue, CRM, or orchestration product.

### 1.4 Non-goals for the first automation release

Do not build a multi-tenant acquisition SaaS platform, generic arbitrary-record merger, autonomous negotiator, automatic NDA signer, financing adviser, or broker spam system. Do not migrate storage or adopt a new workflow platform without a demonstrated requirement. Do not make a new language model the owner of send authority.

---

## 2. Evidence labels and authority

This document intentionally separates the following:

| Label | Meaning | How agents may use it |
|---|---|---|
| **Owner direction** | A product outcome or explicit policy decision in the conversation | Preserve it; do not reinterpret it as an already-deployed capability. |
| **Repository-observed** | Documentation or selected code read at the pinned revision | Use as implementation context; trace the complete affected path before changing it. |
| **Reported live state** | A dated production result in an owner-supplied Codex handoff | Treat as historical evidence and recheck at the next authorized live gate. |
| **Reported local implementation** | Unpushed code/tests described by the implementing agent | Do not claim it is on main, deployed, or independently inspected here. |
| **Public research** | Official provider, standards/security, or regulatory documentation | Use with its research date; recheck changeable requirements before rollout. |
| **Recommendation** | A proposed implementation or operating choice in this document | Convert to a bounded task/design and record any required owner decision. |

**Authority order:** applicable system/security requirements; the current owner's explicit task authorization; accepted design/decision records; verified current code and deployment facts; this roadmap's recommendations; older conversational estimates. If these conflict, surface the conflict. Never weaken a safety gate just to make a new roadmap outcome appear available.

The research inspected selected code and repository documents, not the entire local implementation branch, and did not run the application's tests or access Fly, the production database, or a personal mailbox. This is a researched architecture and planning reference, **not a fresh production acceptance audit**.

---

## 3. Baseline and current work in progress

### 3.1 Verified and reported state

| Item | Evidence as of this research |
|---|---|
| Repository | `muckele/uckele-group` |
| Accepted first MVP | `v1.0.0`, accepted source `e48b8bb5d8e3ba89068f9faa7bae1846c04bb888`; preserve its historical tag |
| Freshly read remote main | `cec88c5a37a5dc433896ee5fd737d606691a3f31` [R01] |
| Last reported production | Fly `v125`, same `cec88…` revision [I03] |
| Production architecture | Node/Express, React/Vite, SQLite with a Fly persistent volume; optional Supabase is not the current production database [R02] |
| PR #19 | Merged and reported deployed: typed CRM ambiguity and transaction-bound match authority [I03] |
| Duplicate-consolidation branch | Last reported local-only branch `codex/p7-crm-duplicate-consolidation-implementation` at `ecf3888b95d6d5f87ea7b0e4eddcff2fb0c06102` [I01] |
| Remaining local release work | Task 9 correction and Task 10 final verification; no completion report received for the latest continuation authorization [I01, D01] |
| Last reported outbound state | Central CIM pause on, automation pause on, scheduler and automatic follow-ups disabled, Stage 1, activation off [I03] |

A local feature branch may have advanced since the supplied handoff. Each executing agent must inspect it freshly. Do not substitute the current remote main for the unpushed implementation branch or conclude that new supersession behavior is already in production.

### 3.2 Finish the existing stabilization task first

The last handoff reports Tasks 1–8, including compatibility and fixture corrections, completed locally with scoped reviews. Task 9 was stopped over checkpoint inputs and validation. Its CLI could open writable storage for a malformed nested checkpoint even when the enclosing artifact was canonical and checksummed. Four ad hoc environment values had also been introduced without an approved input contract. [I01]

The owner subsequently approved **one explicit `--checkpoint-evidence <path>` input**. The evidence envelope is versioned; it reuses the existing recovery-checkpoint domain shape, is bounded to 64 KiB, and has no ambient environment fallback. Both the checkpoint and reviewed repair artifact must independently validate and agree before a writable-storage constructor is called. Invalid non-database inputs must produce **zero writable opens**. This approval is documented in the conversation; completion is not yet evidenced. [D01]

Task 10 must also reconcile the full-suite discrepancy. The latest handoff reports **1,903 tests: 1,658 passed, 242 failed, 3 skipped**. The original implementation baseline reported **1,700: 1,697 passed, zero failed, 3 skipped**. Matching a failing intermediate branch's count is not proof that failures are unrelated. Compare exact test identities and error signatures on the original runtime base and branch under the same supported runtime and installation conditions. Fix introduced regressions; disclose genuinely shared environmental failures. Do not call the release green from focused suites alone. [I01, I05]

### 3.3 Preserve the approved duplicate-consolidation boundaries

The initial production cleanup, after a later reviewed release and preview, remains limited to **two confirmed CRM duplicate pairs**: Pooler, Georgia, listing `costar:2516010`, and Berlin Township, New Jersey, listing `costar:2436873`. These remain separate canonical sale identities. Exact approved IDs belong in the existing incident descriptor/spec, not in a new generic merge input. [I04]

The future first apply changes exactly four business rows: two supersession relations, one Berlin legacy import reference via compare-and-set, and one immutable repair receipt. Contact rows, historical activity/email, CIM history, financial values, canonical opportunities, aliases, and source evidence are retained. Supersession is not Archive or Pass. Canonical merge refuses when either merge subject has active **or reversed** supersession history; unrelated supersession does not block. [I04, D01]

The existing verified September 17 checkpoint is useful historical recovery evidence. After the new schema/runtime is deployed, obtain the separately authorized **post-migration/pre-repair** checkpoint required by the repair design. Do not treat an old backup as permanent current apply authority. [I03, I04]

### 3.4 Stabilization completion criteria

Stabilization is complete only when the following are evidenced:

1. Task 9 input/validation contract and Task 10 regression gates pass on the final implementation revision.
2. Independent full-branch review, exact-head CI, and owner-approved deployment are complete.
3. The new runtime is deployed inert, with health, source, database, and outbound controls verified.
4. A fresh checkpoint and production preview have been independently reviewed, followed by separately authorized exact four-row apply and postconditions.
5. The two repaired pairs produce two active operational records in total, while all four original records remain historically readable.
6. No duplicate send, historical evidence loss, unsolicited workflow reset, or score/source change resulted from cleanup.

Broader semantic duplicate candidates remain a review queue, not an automatic bulk cleanup obligation.

---

## 4. Existing capabilities: reuse before adding

The prior high-level estimate understated how much communication infrastructure already exists. The following map is based on the pinned main revision; feature presence is not proof of current configuration or real-provider acceptance.

| Capability | Existing foundation | Roadmap treatment |
|---|---|---|
| Acquisition Inbox and current score review | Existing triage UI, source health, current opportunity and operator decision services | Harden provenance and use it; do not build another inbox. [R02, I02] |
| CRM and owner next actions | Paginated CRM, deal rooms, Command Center, follow-up workspace | Repair the Pursue-to-existing-CRM handoff and clarify waiting states. [R02, I02] |
| Outbound email and outbox | Existing human-reviewed generic email workflow and durable outbox | Validate transport eligibility and extend approved automation ownership; do not create a second outbox. [R03] |
| In-app compose/reply | Existing Follow-ups Workspace compose/reply and conversation drawer | Bring into the broker-operating journey early; improve access and behavior rather than rebuild. [R03] |
| Inbound broker email | `communications.js` has Resend receiving, durable content state, retries, RFC-thread/reply-alias assignment, unassigned handling, and response stops | Verify completeness and improve ambiguous assignment/supersession handling. [R06] |
| Attachments | Receiving flow obtains bounded attachment metadata | Verify and build secure byte ingestion and CIM classification; metadata alone is not a vaulted CIM. [R06] |
| Secure documents | Expiring requests, categories, batches, protected files, cleanup/recovery | Reuse safe storage and write-ahead cleanup mechanics for mail attachments. [R02] |
| Human-approved CIM follow-ups | Versioned operator-approved sequence and five-follow-up maximum | Preserve existing sequences; a new automatic cadence requires its own version and rollout. [R05] |
| Stage 2 initial automation | Policy hashes, source restrictions, human-evidence thresholds, shadow/canary states and pauses | Extend only after policy approval and data-quality gates; no separate autonomous agent loop. [R04, R07] |
| Recovery | Application-consistent backup, checksums, documents, restore/drill tooling | Verify restoreability and independent storage; do not raw-copy a live database. [R02] |
| Optional recommendation AI | Bounded enrichment, explicit model/eval/data approvals, deterministic fallback | Reuse evaluation and minimal-data approach. Document extraction is a new data boundary. [R03] |

### 4.1 Repository navigation for agents

Start with these verified paths, then find exact callers and tests on the task's actual revision:

```text
README.md
server/services/dealHunter.js
server/services/cimAutomation.js
server/services/cimOpportunityIdentity.js
server/services/dealHunterManualFollowUpPolicy.js
server/services/communications.js
server/services/acquisitionCommandCenter.js
server/services/documentVault.js
server/storage/sqlite.js
server/storage/supabase.js
server/app.js
docs/follow-up-operations.md
docs/cim-stage2-rollout.md
docs/sqlite-recovery.md
docs/superpowers/specs/2026-09-17-crm-duplicate-consolidation-design.md
docs/superpowers/plans/2026-09-17-crm-duplicate-consolidation-implementation.md
```

The supersession spec/plan may reside on the local implementation/documentation ancestry rather than main. Preserve that distinction.

### 4.2 Resolve documentation drift without changing product authority

The current README says the Daily Digest is an internal Morning Briefing and does not mutate CRM or send brokers email. The older Stage 2 runbook includes a statement that the daily job owns CRM synchronization. These documents are inconsistent. Trace the actual current scheduler path before touching it, correct the outdated sentence in a bounded documentation change, and preserve the established no-broker-send boundary. This inconsistency is not authorization to attach outreach to the Digest. [R02, R07]

---

## 5. Decisions that must not be silently conflated

| Topic | Owner's destination | Current evidence | Required decision/change |
|---|---|---|---|
| Score threshold | Candidate automation at **75 or above** | `getCimStage2Policy()` clamps the automatic floor to **at least 90** | Version the policy, evaluate the 75–89 cohort, and obtain activation approval; changing an environment value alone cannot safely implement this. [R04] |
| Number of attempts | Limited persistent outreach; proposed default five total messages | Existing manual policy allows **five follow-ups**, in addition to the initial message | Define `totalTouches = 5` versus `followUps = 4` explicitly. Existing histories keep their original semantics. [R05, D01] |
| Cadence and recipient caps | Illustrative Day 0, 2, 5, 9, 14 sequence | Current policy includes one touch/24h and four/30 days per recipient | A fifth touch within 14 days conflicts with the current cap. Keep the cap until an explicit versioned policy reconciles it; do not invent an exception. [R04] |
| Eligibility versus Pursue | Eventual policy-driven enrollment | Existing owner-driven workflows separate Pursue/Watch/Pass from machine score | Do not fabricate a human Pursue decision. A future policy may authorize enrollment separately; Watch/Pass remain protected. [I02] |
| Email logging | A usable acquisition conversation history | App-controlled Resend mail handling exists | Does Mathew also require direct Gmail activity to sync? That changes architecture. [R03, R06] |
| Earnings | Comparable, interpretable economics | Historical normalization places different profit labels into generic fields; some UI labels overstate the metric | Preserve original metric/period and unknowns before using them for unattended decisions. [I02, I04] |
| Provider permission | Broker materials requests | Resend's policy is not blanket permission for cold outreach | Resolve provider suitability and recipient permission before auto-send. [W01] |
| Under-contract status | Avoid wasted contact | A listing may be under contract but accept backup interest | Default no automated sequence; require owner-reviewed backup-interest scope rather than treating it as sold or freely contactable. |

### 5.1 Acquisition profile reconciliation

The inspected Stage 2 policy still contains a $300,000–$750,000 annual-profit band and target states NY, CA, NJ, AZ, NV, and CT. These are implemented rules, not confirmation of current owner intent. Historic owner conversations have described a broader $600,000–$2 million SDE target and Western-US preferences; those must be re-confirmed, dated, and expressed with the correct earnings measure before changing code. [R04, D02]

Create one small owner-approved profile document covering size/metric, geography, recurring-revenue preferences, owner involvement, exclusions, and missing-evidence policy. Do not build a rule-builder UI merely to settle a profile discrepancy. Any changed scoring/profile version should have a before/after cohort impact preview.

---

## 6. Provider choice and permission to contact

### 6.1 Critical research correction

**Resend must not be selected unconditionally for cold broker outreach.** Its policy, updated August 27, 2026, prohibits unsolicited messages including cold outreach and requires recipients to have explicitly opted in. A published broker email, a purchased sourcing feed, or a high fit score is not itself evidence that this requirement is met. The previous unconditional Resend-first recommendation is therefore superseded by a provider-policy gate. [W01]

The unresolved question is whether a particular broker's invitation to inquire about a specific listing, followed by the proposed limited cadence, qualifies under the provider's rules. Do not decide that by inference. Obtain a documented provider determination for the actual workflow and record the relevant recipient-permission evidence. Legal classification is a separate question.

### 6.2 Recommended decision path

**Recommended default architecture:** Uckele Group remains the system of record for opportunity state and communication history; use one approved email transport for each conversation. Reuse Resend only for a cohort and purpose that comply with its rules. Select Gmail-native integration when native Inbox/Sent synchronization is a real requirement and the workflow complies with Google's rules. A transport switch is not a way to bypass restrictions.

| Option | Appropriate when | Engineering implications | Decision |
|---|---|---|---|
| Existing Resend + app-owned acquisition inbox | The sending purpose and recipient cohort are permitted; the owner works primarily in Uckele Group | Least transport rework; verify receiving, threading, durable event processing and attachment capture | Preferred reuse path **only after permission is established** |
| Gmail/Workspace-native transport and synchronization | The owner must also send/reply in Gmail and see those actions naturally reflected in the application | OAuth, token lifecycle, mailbox watch/history synchronization, native thread rules and limited-data handling | Valid alternative, not automatically required |
| Resend sends + independent Gmail two-way synchronization | A documented operational need cannot be met by either single-owner model | Higher duplicate-message, thread ownership and reconciliation complexity | Defer from first release |
| Manual listing inquiry or broker portal | No approved unattended email channel is available | Owner task with evidence logging; may precede a consented conversation | Legitimate fallback, not a covert automation workaround |

### 6.3 Native Gmail is not the same as Resend

Resend can receive mail on a receiving domain and expose message content through APIs. Gmail API supplies access to an actual mailbox and its change history. Neither capability implies permission to send any desired outreach. Selecting Resend does not automatically place outbound mail in Mathew's Gmail Sent folder or capture replies he sends independently in Gmail. [W02, W10]

Where a Gmail mailbox already owns the root domain, do not replace its MX records just to add Resend receiving. A dedicated receiving subdomain is the usual separation to evaluate; exact DNS changes require domain-owner approval. [W03]

### 6.4 Provider-policy work package output

Before production sending is designed as enabled, retain:

- the message purpose, proposed recipients, evidence of invitation/consent, and intended cadence;
- provider-policy reference and written applicability determination where needed;
- sending account/domain identity and responsible owner;
- approved message-copy and opt-out behavior;
- the decision whether native Gmail synchronization is mandatory;
- a refusal path when the proposed cohort is not permitted.

**Draft inquiry to the provider—not sent by this document:**

> We operate a private acquisition workflow contacting business-sale brokers about specific listings. Some listings invite buyers to request information; our proposed workflow would send a listing-specific materials request and a limited follow-up sequence, stopping on any response or opt-out. Please clarify what recipient-permission evidence your policy requires for this use, whether an invitation on a listing qualifies, and whether the proposed follow-ups are allowed. We will not activate the workflow until the permitted scope is established.

### 6.5 Compliance boundary

For messages classified as commercial, the FTC guide explains that CAN-SPAM is not limited to bulk mail and includes business-to-business messages. The applicable primary-purpose classification, jurisdictions, and required disclosures need a responsible compliance review; this document does not conclude that every acquisition inquiry has the same legal classification. Provider terms may be stricter than legal minimums. [W17]

---

## 7. Target architecture and ownership boundaries

### 7.1 Keep the existing application architecture

Retain the current Node/Express application, React operator workspace, SQLite transactional storage, and existing background-job patterns for the first release. The reason is scope control and reuse, not a claim that SQLite is suitable for unlimited scale. Revisit database topology only when measured concurrency, availability, or deployment requirements justify it. [R02]

```text
Google Sheet / optional approved CSV
              |
      source + identity services
              |
   canonical opportunity + evidence + score
              |
   operator intent / approved policy enrollment
              |
       deterministic eligibility
              |
   existing CIM request + durable command/outbox
              |
     fenced sender -> selected permitted provider
                          |
        signed event / mailbox history notification
                          |
       durable inbound event + reconciliation worker
                          |
      exact conversation assignment / exception queue
                          |
   broker reply ---- secure attachment quarantine
         |                     |
   next owner action       existing document vault
         |                     |
   owner review <----- material classification/evidence
```

The diagram describes responsibilities, not a requirement to create one new table or process per box.

### 7.2 Domain responsibilities

| Domain | Owns | Must not silently own |
|---|---|---|
| Canonical opportunity | Business-sale identity, source aliases/currentness | Broker identity or email send permission |
| CRM submission and supersession | Operational record and historical relationship | Financial truth simply because a row survived |
| Score/evidence | Deterministic ranking and provenance | Automatic sender authority |
| Outreach policy/enrollment | Approved scope, version, cohort, sequence ownership and caps | A fabricated human Pursue decision |
| CIM/request lifecycle | Materials request intent and completion/blocking state | Provider delivery truth |
| Communication/event history | Message content, identifiers, observed events and provenance | Undocumented reassignment to another deal |
| Outbox/command | Exact envelope, logical touch identity, lease/fence and send outcome | Recipient inference or model-selected scope |
| Secure documents | Bytes, access, scanning status, classification and retention | Verified financial facts before review |
| AI proposal | Bounded extracted facts or suggested interpretation | Sending, contracts, payment, recipient changes, or canonical mutation |

A thin new policy/enrollment record may be necessary if existing markers cannot encode the approved automatic workflow. First prove the gap. Extend a well-defined existing contract or introduce the smallest new one; do not create competing sequence ownership.

### 7.3 Minimal conceptual contracts

These are design shapes, not authorized SQL migrations or final API names:

```text
Outreach eligibility:
  opportunityId, currentCrmId, scoreVersion, evidenceFingerprint,
  policyVersion, sourceAuthority, recipientEvidence,
  permissionEvidenceReference, ownerDisposition,
  eligible, blockers[], warnings[], evaluatedAt

Logical touch:
  requestId, enrollmentId, touchNumber, commandId,
  approvedEnvelopeDigest, transportOwner, dueAt,
  state, leaseToken, providerMessageId, acceptanceEvidence

Conversation:
  communicationId, originSubmissionId, currentOperationalRecordId,
  provider/account namespace, providerMessageId, rfcMessageId,
  inReplyTo, references[], threadId, assignmentEvidence,
  occurredAt, receivedAt, contentState, attachmentReferences[]

Material evidence:
  documentId, originCommunicationId, opportunityId,
  contentSha256, scanState, classification, receivedAt,
  reviewedAt, reviewer, extractedProposals[], originalEvidenceReferences[]
```

Keep the originating submission and current operational representation separate after supersession. One display timeline may include multiple origins without rewriting stored event ownership.

---

## 8. Outreach eligibility and score-policy evolution

### 8.1 Eligibility predicate

The desired floor is **score >= 75**, but eventual unattended enrollment must satisfy every required gate, approximately:

```text
eligible = policyEnabledForThisCohort
  AND sourceAuthorityHealthyAndCurrent
  AND canonicalIdentityResolved
  AND currentCrmRepresentationUnambiguous
  AND noActiveSupersededRecordSelected
  AND scoreIsCurrentAndMeetsApprovedFloor
  AND materialContradictionsResolvedOrExplicitlyAllowed
  AND requiredProfileFactsSupported
  AND ownerDispositionPermitsEnrollment
  AND recipientIsVerifiedForThisListing
  AND contactPurposeAndRecipientPermissionAreAllowed
  AND noExistingConflictingRequestOrConversation
  AND notSuppressedOrAdverselyBlocked
  AND lifecycleAllowsContact
  AND contactCapsAllowThisTouch
  AND receivingAndReconciliationHealthAreAcceptable
  AND allRequiredActivationEvidenceIsCurrent
```

The predicate is an application policy proposal. Exact fields and thresholds must be bound to an accepted version; do not infer a new version merely because the score UI changes.

### 8.2 Hard blockers versus review warnings

**Block automated outreach:** unresolved identity or duplicate conflict, superseded CRM selection, stale required source, recipient mismatch, missing contact permission, unknown provider acceptance, suppression, material financial contradiction, owner Pass/Stop, unavailable reply processing, or conflicting sequence ownership.

**Potential warnings:** missing secondary diligence detail, unspecified seller financing, incomplete descriptive fields, or uncertain capex that does not contradict the approved cohort. Whether missing earnings measure or period is a warning or automatic blocker must be explicitly decided for the cohort. Conservative first canaries should require more evidence, not silently broaden eligibility to meet volume targets.

A completeness-derived “high confidence” label is not an empirically calibrated probability that a business is suitable or safe to contact. The pilot supplied a 100/high-confidence example with seven contradictions. Address that distinction in the policy and interface before lowering the automatic threshold. [I02]

### 8.3 Enrollment is not an invented owner decision

The first live operating pilot remains owner-led. Under the later automatic policy, an eligible unreviewed opportunity may be enrolled only if the owner has explicitly approved that cohort behavior. Store `enrollmentAuthority = approved-policy` separately from `operatorDecision = pursue`. Never mark an opportunity Pursue merely because automation contacted it.

Watch, Pass, manual hold, or an owner-managed active thread must not be overridden by a high score. Existing explicit human-approved follow-up sequences retain human approval requirements unless deliberately transitioned through a reviewed migration/takeover action.

### 8.4 Threshold rollout

Use shadow evaluation for the entire proposed >=75 cohort while preserving current production authorization. Compare outcomes in 75–79, 80–89, and >=90 bands. Record false-contact risk and evidence gaps, not only conversion.

A first canary should reuse the existing stronger >=90 and reviewed-cohort gates where applicable. Only a later versioned decision may admit the 75–89 cohort. The desired floor is an eventual policy target, not permission to remove the current clamp or reset human evidence. [R04, R07]

---

## 9. Sequence lifecycle, cadence, caps, and stops

### 9.1 Separate the states that answer different questions

Do not overload one `status` field to mean identity, sending, delivery, and diligence completion. Map proposed states into existing contracts deliberately.

| State dimension | Illustrative states | Question answered |
|---|---|---|
| Enrollment | Not eligible, shadow, owner-approved, policy-enrolled, paused, exhausted | Is this opportunity in an authorized sequence? |
| Message command | Prepared, queued, claimed, transmitting, accepted, definitively failed, ambiguous, cancelled | What happened to this exact logical touch? |
| Delivery evidence | Accepted, delivered, delayed, bounced, complained, suppressed | What does the provider report? |
| Broker work | Awaiting reply, needs owner reply, NDA required, call requested, awaiting materials, no longer available | What should the owner do? |
| Materials | Not received, attachment pending, quarantined, stored, candidate CIM, reviewed CIM, insufficient | Do we have usable materials? |
| Acquisition judgment | Unreviewed, Pursue, Watch, Pass, diligence | What decision has the owner made? |

Accepted is not delivered; delivered is not replied; replied is not CIM received; CIM received is not financially verified.

### 9.2 Proposed default cadence

**Recommendation for a new explicitly approved automatic policy:** five total outbound touches, not five follow-ups. The illustrative schedule is Day 0, Day 2, Day 5, Day 9, Day 14 when no window/cap delays intervene.

| Touch | Type | Minimum proposed interval from prior accepted touch | Purpose |
|---|---|---:|---|
| 1 | Initial materials request | Not applicable | Identify the specific listing and request available materials or the next prerequisite. |
| 2 | Follow-up 1 | 48 hours | Briefly ask whether the request reached the right person. |
| 3 | Follow-up 2 | 72 hours | Offer to complete the broker's normal next step; do not invent buyer qualifications. |
| 4 | Follow-up 3 | 96 hours | Ask whether the listing is still available or another contact is appropriate. |
| 5 | Final follow-up | 120 hours | Politely close this sequence without pressure or a false deadline. |

These are elapsed minimum intervals followed by the next permitted send window; they are a **proposed new cadence**, not the current manual policy. A Friday message, weekend boundary, unknown recipient timezone, provider issue, or recipient cap can push actual dates later. Do not compress delayed touches to catch up. Anchor each next interval to the previous accepted touch, not the original planned schedule.

The current four-per-30-day cap prevents the fifth touch on this illustrative timetable. The owner must either approve a revised aggregate cap consistent with the five-total policy or keep the existing cap and accept a shorter/slower sequence. Until then, the existing cap wins. [R04]

### 9.3 Contact-budget scope

Count contact pressure across **manual and automatic acquisition messages**, all relevant listings for the same normalized recipient, and unresolved send attempts conservatively. Do not evade a recipient limit by opening another opportunity, choosing a different provider, changing the template version, or using an alternate address for the same broker.

A later broker entity can improve cross-address aggregation, but the initial system should at least coordinate exact normalized email addresses using the existing recipient claims/caps. Ambiguous broker identity belongs in an exception queue; do not merge people simply to make cap accounting easier.

Persist reservations atomically when concurrency can otherwise exceed a cap. Definitively failed, never-accepted attempts do not become successful touches, but their retry rules still apply. Ambiguous attempts must reserve safety capacity until reconciled, rather than be treated as free opportunities to try again.

### 9.4 Stop and pause rules

| Event | Required behavior | Further action |
|---|---|---|
| Attributable inbound reply | Pause/stop automatic cadence promptly, before body retrieval completes where identity is established | Retrieve and present the reply; classify the next action. |
| CIM or other potentially useful material | Pause cadence while retrieving and reviewing | Confirm document association and sufficiency before marking the request complete. |
| NDA or buyer-profile prerequisite | Pause; create owner action | Do not sign, accept, or disclose financial qualification automatically. |
| Broker asks a question or requests a call | Pause | Owner responds or schedules deliberately. |
| Out-of-office response | Pause and label | Proposed return date may be suggested; resumption needs defined policy, not a guessed date. |
| Sold, withdrawn, or under contract | Stop the standard sequence | Record availability evidence; optional backup-interest contact is a different approved purpose. |
| Hard bounce, complaint, opt-out | Suppress and stop as appropriate to scope | No automated alternate-address retry. |
| Unresolved delivery/provider acceptance | Hold command and sequence | Reconcile existing evidence, never create a new logical touch as a retry. |
| Owner reply or manual takeover | Atomically suspend automatic ownership | Owner-controlled command uses the same communication history and caps. |
| Required-source or inbound-health failure | Pause new automatic work | Re-establish authority/health before resuming. |
| Last authorized touch exhausted | Mark `outreach_exhausted` | Retain evidence and future owner options; no automatic recycling. |

An unassigned message must not be linked to every deal represented by the sender. When attribution is uncertain, a conservative recipient-level hold can prevent further contact pending review without pretending that every opportunity received a reply.

### 9.5 Exhaustion and re-entry

`outreach_exhausted` means the particular approved request/cadence ended without the required outcome. It is not Pass, sold, or a permanent declaration that the business is unsuitable.

Re-importing a CSV, changing a price, receiving a new source alias, rescoring, or changing policy versions must not restart outreach. Re-entry requires a documented reason, fresh permission and eligibility, and explicit owner authorization or a separately approved re-engagement policy. Existing suppression remains binding.

### 9.6 Message-copy principles

Each message must identify the real sender and specific listing, make a concrete materials request, avoid unsupported financial claims, and provide a straightforward way to stop further contact. Later touches should add useful context or close the loop rather than repeat the first paragraph mechanically.

Do not imply a prior relationship that does not exist, claim financing/proof of funds not actually established, invent an urgent competing offer, or insert a sensitive document link automatically. Subjects and quoted history should preserve thread continuity where technically supported.

---

## 10. Delivery, concurrency, idempotency, and reconciliation

### 10.1 Reuse the existing durable command/outbox boundary

There should be one durable logical command for a touch. Its identity belongs to the request/enrollment and touch number, not the current time or a transient job execution. A policy-version change must not alone create a new identity for an already attempted touch.

Persist the exact server-authored envelope, recipient evidence, approval/policy reference, and content digest before provider transmission. An asynchronous worker claims the command with a fenced lease, rechecks current authority, and then contacts the selected provider. Record the outcome and provider identifiers. Do not keep a long SQLite write transaction open across a network request.

This extends existing outbox and CIM ownership concepts; it is not a new independent sending mechanism. Existing manual takeover already has an atomic relationship with a scheduled CIM sequence and must remain authoritative. [R03]

### 10.2 Provider idempotency is only one layer

Resend retains idempotency keys for 24 hours. That is useful transport behavior, but it does not replace the application's durable touch identity, permanent acceptance history, or ambiguous-outcome reconciliation. An unresolved command outside that window must not be resent with a new key merely because no local success row was found. [W07]

For any selected transport, document its exact retry/idempotency behavior. Where an equivalent provider guarantee does not exist, retain the command as ambiguous until read-only evidence or an owner incident decision resolves it. Never claim mathematical end-to-end “exactly once” for an external mail side effect. The practical requirement is **one logical command, no blind retransmission, and accountable reconciliation**.

### 10.3 Final authorization and competing events

The final local transaction should recheck current opportunity/CRM identity, supersession, recipient ownership, source/policy validity, suppression, inbound-stop state, caps, and command ownership. Build on the reviewed CRM authority binding instead of copying a weaker lookup into the sender.

A reply can race with an outbound attempt. If the reply commits before the final send authorization, the command must cancel/refuse. If provider transmission has already crossed the boundary, the system may be unable to recall that message; record this honestly and stop all subsequent touches. A “stop immediately” product promise must not imply that an already transmitted email can be recalled.

### 10.4 Event ingestion and reconciliation

Resend webhooks are delivered at least once and can arrive out of order. The receiver must durably deduplicate and acknowledge events, then process deferred retrieval independently. Signature validation uses the original raw request body and provider signature headers, not a reserialized body. [W05, W06]

Keep provider occurrence time, local receipt time, processing time, and durable event identity separate. A late delivered event must not erase a reply, suppression, or exhausted sequence. Do not base state on “last webhook wins.” Use explicit transition rules and preserve the original events.

Required recovery jobs include pending inbound content, unresolved provider acceptance, webhook or mailbox-history gaps, expired worker claims, and attachment retrieval retries. These jobs reconcile evidence; they do not grant new sending permission.

### 10.5 Deployment and pause behavior

The code should support an inert deployment: no automatic enrollment/send merely because new tables or policy code exist. Existing pauses remain enabled until the relevant activation is accepted.

An automation-only pause must not disable inbound receipt, suppression processing, or reconciliation of previously accepted commands. A central send pause should block new transmission while still allowing safe historical evidence to arrive. Distinguish inbound evidence recording from an owner business mutation against a superseded row; refusing all writes indiscriminately could lose a late delivery or reply event.

---

## 11. Inbound email, threading, and Gmail options

### 11.1 App-owned conversation capture

The existing Resend ingestion service already creates a durable placeholder, supports reply-alias/RFC association, retrieves content, retries pending ingestion, and stops a known CIM sequence before successful content retrieval. Build on that flow and test it against the newly deployed supersession semantics. [R06]

The receiving webhook does not contain the complete body, headers, or attachment bytes; the receiving/attachment APIs are needed for those. Treat notification acceptance and successful content ingestion as separate states. [W02]

Proposed order:

1. Verify the inbound provider event and persist its deduplication identity.
2. Establish a safe request/thread association where strong evidence exists.
3. Persist the attributable response stop/hold before slow content work.
4. Retrieve body/headers and bounded attachment metadata with retryable jobs.
5. Resolve any remaining ambiguity without guessing from the sender alone.
6. Store the communication under truthful origin/current-relationship semantics.
7. Present the owner's next action and start secure attachment ingestion.

### 11.2 Matching evidence hierarchy

Prefer exact request-specific reply address plus known provider/account context; then validated RFC `In-Reply-To`/`References` links to a known conversation; then an explicit operator association. A single currently matching contact email is a heuristic, not proof that a broker's reply concerns that deal.

The existing implementation includes a unique-contact-email fallback. Before automatic material completion or subsequent send authority depends on it, characterize that fallback with same-broker/multiple-deal fixtures and conflicting headers. An ambiguous assignment stays unassigned or held; do not silently bind it to the most recently updated deal. [R06]

A provider-signed webhook proves the event came through the provider's channel. It does not prove the email content is accurate, that the sender is the business owner, or that a new recipient mentioned in the body is authorized.

### 11.3 Identifier separation

Persist separate identifiers for:

- application communication and request;
- provider account/mailbox namespace;
- provider message and event;
- RFC Message-ID and References;
- native mailbox thread, where applicable;
- canonical opportunity and original CRM record.

Never compare a Gmail thread ID to an RFC Message-ID or assume a Resend outbound ID is the inbound provider ID. Header hints and quoted text must not become arbitrary database IDs or privileged routing instructions.

### 11.4 Gmail-native branch, only when required

Gmail push uses Cloud Pub/Sub and mailbox history identifiers; watches must be renewed at least every seven days, with daily renewal recommended by Google. Notifications are change signals, not complete messages. [W10]

A native adapter therefore needs bounded initial synchronization, durable history cursors, paginated incremental retrieval, message deduplication, and controlled re-synchronization when an old history ID returns 404. Persist a new cursor only after the relevant history is durably processed. [W11]

Gmail thread insertion/replies require the appropriate native thread ID and compatible RFC headers/subject. Test replies sent both in the application and in Gmail; do not assume native threading follows from a matching subject alone. [W12]

The OAuth choice matters: `gmail.send` is sensitive, while broader read/modify/compose scopes are restricted. Verification/security assessment applicability depends on scopes, data handling, and deployment/distribution; internal Workspace-only use has different verification conditions from an external app. Do not promise that all verification is required—or that none is—before classifying the app. [W13, W14]

Store refresh tokens encrypted with revocation and least-privilege access; do not expose them to the browser or repository. A dedicated acquisition mailbox or application-enforced inclusion rules should limit ingestion of unrelated personal messages. Labels are operational filters, not proof that an OAuth token has narrow access. Google's Workspace user-data rules are an additional design constraint. [W15]

### 11.5 Scope of “all broker interactions”

V1 captures all activity flowing through the approved application/provider conversation channel plus deliberate manual logs. It does not magically capture phone calls, broker portals, forwarded messages without stable identity, or replies Mathew sends from an unconnected mailbox.

Provide manual phone/meeting notes and clear “not synchronized” indicators. If native Gmail is chosen, define the exact mailbox/history coverage and disclose synchronization gaps. Avoid promising complete history until the channel coverage is established.

---

## 12. Secure attachment and CIM ingestion

### 12.1 Separate metadata, bytes, safety, and business meaning

A message can have an attachment record while its bytes are unavailable, unscanned, or irrelevant. Track at least: metadata observed, retrieval pending, retrieved, quarantined, accepted into vault, classification pending, candidate materials, owner reviewed, and rejected/insufficient.

Resend attachment download URLs expire after one hour; obtaining a fresh URL is possible through the attachment API. Persist stable message/attachment identities and content digests, not temporary URLs as the archival record. [W04]

An expired URL is a retrieval problem, not “broker never sent the CIM.” Pause the sequence while the application resolves the retrieval failure.

### 12.2 Proposed ingestion flow

1. Create a bounded ingestion job keyed by provider/account, inbound message, and attachment identity.
2. Retrieve only from the provider's approved endpoint/returned download flow; enforce size and time limits while streaming, not solely from declared headers.
3. Write to a private quarantine location with a generated storage name and compute a content hash.
4. Validate allowed extension, MIME and file signature; scan privately for malware and apply approved parser isolation.
5. Associate the document with the exact opportunity and original communication, or hold it as unassigned.
6. Use existing document-vault persistence and cleanup/recovery mechanisms to publish accepted bytes safely.
7. Classify the document and make it available to an authorized owner.
8. Mark CIM/material completion only when the document is associated and satisfies the chosen review rule.

The byte-ingestion job must be idempotent independently of the webhook and the communication-body retrieval job. Replayed events should not produce duplicate files or duplicate owner tasks.

### 12.3 File-safety policy

Use a restrictive initial file policy—PDF first, with explicit decisions for spreadsheets, archives, password-protected files, and office documents. Set limits consistent with the existing vault and available resources rather than silently accepting every provider-supported size. Reject executable content, traversal paths, and unbounded archive expansion; never execute macros. OWASP's upload guidance supports layered type/size validation, private storage, and scanning rather than trusting client metadata alone. [W18]

Malware scans and document processing must not upload confidential CIMs to a public analysis service by default. Confidentiality and retention requirements apply to scanners and model providers as well as storage.

Retain the original artifact where policy permits; derived text is a separate, reproducible object with parser/version provenance. Global content-hash equality can save bytes only if access remains scoped correctly; never expose another opportunity's document because its hash matches.

### 12.4 Broker links and data rooms

A link in an email is not automatically a safe download request. Store the link as evidence and create an owner action when it requires a login, NDA, identity proof, or unclear consent.

Any later fetcher must apply SSRF defenses: permitted protocols/hosts, private and metadata-network blocking, DNS/redirect revalidation, credential isolation, size/time limits, and no arbitrary browser automation against data rooms. Do not pass server credentials to a redirect target. [W19]

### 12.5 What counts as received

| Material | Default proposed result |
|---|---|
| Teaser or listing screenshot | Materials received, but CIM/financial package may remain incomplete |
| NDA or NDA link | Owner prerequisite; not CIM received |
| Broker says “attached” but no retrievable file | Reply received; ingestion/owner exception |
| Correct-business CIM, safely stored | Candidate CIM received; owner review required before verified financial facts |
| Wrong-business or ambiguous attachment | Unassigned/conflict; no automatic factual update |
| Financial statement with unspecified period | Retain original; flag missing period |
| Broker portal invitation | Owner action; no automatic acceptance/signature |

### 12.6 Recovery and retention

Extend backup coverage deliberately if quarantine/derived files are introduced. A database row without recoverable document bytes is not complete recovery. Use the existing private-file manifest and write-ahead cleanup pattern rather than a separate unsupervised folder. Retention, deletion, and revocation need explicit rules that preserve required audit facts without storing confidential documents indefinitely. [R02]

---

## 13. In-application communication and owner work

### 13.1 Make manual control usable before autonomy

The owner should be able to open a broker conversation, see the current request and outstanding prerequisite, compose/reply, review exact recipient/content, and take over a sequence. These functions should be integrated before automatic sending expands. Existing compose/reply/outbox and takeover contracts provide a foundation. [R03]

Do not require Mathew to copy messages between Codex and the application for routine broker correspondence. Codex builds and reviews the product; it should not become the production operator interface.

### 13.2 Opportunity workspace layout

A practical view should expose:

- business name **plus location and listing identity**, avoiding the four-identical-card problem;
- score, source as-of time, evidence gaps, and explicit blockers;
- current operator decision and automatic policy/enrollment status;
- latest meaningful message with original association;
- next action or waiting reason, due date, and responsible person;
- materials requested/received/reviewed;
- delivery state and remaining contact budget;
- pause/takeover and safe navigation to historical superseded records.

Separately label `CRM created`, `source listed/observed`, `last checked`, and `financial period`. The older “Added” display mixed source and CRM-created dates. [I02, I04]

### 13.3 My Work, not another CRM

Reuse the current queues and Command Center to surface: owner reply required, NDA/prerequisite, materials to review, due authorized action, ingestion/identity exception, and new opportunity evaluation.

Every pursued opportunity should have one clear next step or an explicit dated waiting condition. Do not duplicate tasks because a webhook replays or two historical records contribute to a timeline. A material review task is not the same as an automatic follow-up timer.

### 13.4 Communication safeguards

Render safe content; do not execute message HTML or load tracking content by default. Preserve quoted history and message attribution without exposing private body content to viewers. Sending must revalidate recipient and current authority on the server; disabling a button is not the security boundary.

Manual takeover cancels or suspends future automatic ownership atomically. If a provider-bound command is already in flight, show that fact and prevent the manual action from creating a duplicate simultaneous send. Owner edits create a new reviewed envelope for the intended command, not a covert change to an already approved queued payload.

---

## 14. AI-assisted interpretation and diligence

### 14.1 Introduce AI where it removes measured work

The first reliable automation release does not require an AI model to send email or parse every response. Deterministic rules can pause on any attributable reply, enforce limits, recognize explicit unquoted opt-outs, and preserve delivery truth. AI can then propose richer intent labels and draft owner responses.

The existing recommendation system already treats AI as bounded enrichment with deterministic fallback and no sending authority. Reuse those principles; expanding to document contents requires a new approved data-handling boundary. [R03]

### 14.2 Reply-intent proposals

Suggested labels: materials attached, NDA required, buyer qualification required, call requested, question for buyer, availability change, wrong contact, opt-out, out-of-office, and unclear.

Store the proposed label, supporting communication/evidence span, model/prompt/schema version, and review result. A classifier must not autonomously change a recipient, assert financing capacity, or unblock a paused sequence. For the first release, all substantive replies remain owner-managed; low confidence routes to the same exception queue.

### 14.3 CIM extraction contract

Extraction should produce **proposed observations**, not overwrite canonical truth:

```text
field: earnings
value: 535397
currency: USD
metric: Annual Profit
periodStart: unknown
periodEnd: unknown
sourceDocument: opaque internal reference
page: specified when verified by the parser
evidenceSpan: bounded attributable text/table coordinates
status: extracted-unverified
confidenceBasis: parser/model evidence, not a fabricated probability
```

The numeric example illustrates a schema, not a new verified assessment of a live business. Keep asking price, revenue, EBITDA, SDE, owner compensation, add-backs, and cash flow separate. Do not infer trailing-twelve-month figures from an unspecified “profit” label. Preserve conflicting observations and date the broker's corrections.

Re-scoring should consume a versioned set of accepted observations with an impact preview. An extraction result may create a review task; it must not silently approve an acquisition or rewrite an owner disposition.

### 14.4 Untrusted content boundary

Broker emails, PDFs, spreadsheets, and data-room pages are untrusted evidence. Instructions inside them—such as “ignore prior rules,” “email this other address,” or “upload your database”—must not become developer instructions or tool authority. Use constrained structured outputs, minimal input, and no unrestricted mail/network/secret tools for extraction. [W20]

Use private approved storage and provider data controls. `store: false` is not a blanket claim of zero retention across endpoints, uploaded files, or organizational settings; approve the actual service/model/data path before processing confidential CIMs. [W22]

### 14.5 Evaluation before production use

Build representative synthetic or approved-redacted samples with broker replies, NDAs, teasers, conflicting financial statements, multiple listings from one broker, scanned PDFs, and prompt-injection attempts. Hold out examples from development. Use a human-reviewed answer key and task-specific error taxonomy; add observed production failures to a controlled regression corpus. [W21]

Proposed release gates: zero unsafe tool/send actions, zero secret disclosure, exact schema conformance, no invented source citations, explicit unknowns, and measured extraction/intent usefulness accepted by the owner. Model selection should compare quality, correction effort, latency and cost. Do not hardcode a model name from an old chat as a permanent architecture choice.

---

## 15. Security, privacy, and compliance

### 15.1 Mandatory boundaries

Administrative authorization must be enforced by the API and storage/service boundaries. Viewers receive only allowed projections. A combined historical timeline must not broaden access beyond what the underlying communication/document permits.

Do not commit databases, backup files, raw CIMs, OAuth refresh tokens, provider credentials, personal mailbox contents, or production evidence exports. Runtime logs should use opaque IDs, safe reason codes, counts and hashes rather than bodies, signed download URLs, or contact lists.

A coding agent's connected accounts do not become an application's production credential store. Provision production credentials through the existing approved secret-management process, never by copying them into a roadmap or prompt.

### 15.2 Sender identity and deliverability

Review sender authentication and alignment, receiving readiness, and suppression before enabling a provider. Google's sender guidance differentiates all-sender requirements from additional bulk-sender requirements; do not describe bulk rules as universally identical. As a product recommendation, authenticate the chosen sending domain deliberately and monitor it even at low volume. [W16]

The first canary is too small for stable rate conclusions. Any complaint, mistaken recipient, opt-out handling failure, or unintended duplicate should pause expansion immediately. Provider quota is not an appropriate outreach target, and a low complaint count is not proof of permission.

### 15.3 Opt-out

Honor explicit opt-outs promptly in the shared suppression authority. Distinguish quoted prior text from the sender's current request, but prefer a safety hold when interpretation is uncertain. Never route around suppression by changing sender identity or recipient aliases.

The current runbook documents a reply-based opt-out and warns that an external opt-out base URL is not an implemented signed one-click unsubscribe endpoint. If the classified message/provider rules require one-click behavior, implement and test it explicitly before activation. [R03]

### 15.4 Approval records

Provider/copy/recipient-permission approval, automatic policy approval, model-data approval, deployment approval, and repair apply approval are different records. A successful code review is not authority for live mail. An approved checkpoint artifact is not authority to perform unrelated data mutations.

---

## 16. Operations, recovery, and measurable outcomes

### 16.1 Operations panel

Expose counts and actionable blockers for: ingestion backlog, attachment quarantine/failure, unattributed messages, ambiguous sends, due-but-blocked touches, current policy/cohort/caps, suppression events, source currentness, failed jobs, and backup freshness.

Keep central outreach pause, automation pause, provider health, and receiving health distinct. The owner should understand whether a sequence is waiting for a broker, waiting for him, or blocked by the system.

### 16.2 Proposed service objectives

These are targets to validate, not current guarantees:

| Workflow | Initial objective under healthy dependencies |
|---|---|
| Valid webhook reception | Persist or safely deduplicate before acknowledging; avoid synchronous attachment processing in the acknowledgement path |
| Attributable inbound stop | Apply in the durable reception path where possible; never wait for model analysis |
| Body visibility | Target most healthy-provider messages visible within five minutes after event receipt |
| Attachment availability | Target most permitted small documents scanned/stored within fifteen minutes; expose pending/blocked status sooner |
| Operator action | Each nonterminal pursued deal has an owner next step or an explicit waiting reason |
| Recovery | Demonstrated restore of database plus referenced documents, not just successful backup creation |

Provider downtime, notification delay, oversized documents, or quarantine can prevent these timing targets. Measure from clearly defined timestamps and show coverage; do not equate missing observations with zero latency/failures.

### 16.3 Funnel and quality measures

Track canonical opportunities, not source rows: eligible, owner-approved/policy-enrolled, initially contacted, human reply, materials received, materials reviewed, diligence advance, hold, Pass, and exhausted.

Track owner review time, time-to-first-review, time-to-CIM, time-from-materials-to-decision, next-action coverage, wrong-assignment count, duplicate-send incidents, suppression latency, and ambiguous-command age.

Compare score bands only with disclosed sample sizes and selection rules. A five-deal pilot or first canary does not justify a precise conversion forecast. Do not use email opens as acquisition intent or sending authority; prioritize actual replies, materials, and decisions.

### 16.4 Backup and incident recovery

Keep application-consistent backups, independent copies outside the primary failure domain, periodic isolated restore drills, and evidence that document bytes are included. Same-volume backups are rapid recovery, not complete disaster isolation. [R02]

A send incident normally calls for pausing new sends and preserving inbound/reconciliation evidence, not restoring an old database and forgetting that emails were accepted. Database restore can erase acceptance history and create duplicate-send risk. After recovery, reconcile provider/mailbox evidence before any sender restarts.

---

## 17. Release sequence and activation gates

### 17.1 Dependency order

```text
Finish current Task 9/10 and resolve full-suite failures
  -> reviewed supersession runtime release
  -> fresh checkpoint -> preview -> approved four-row cleanup -> verification
  -> profile/provenance/contradiction hardening + owner workflow pilot
  -> provider permission and mailbox/transport decision
  -> dependable manual communication + receiving + material capture
  -> shadow policy evaluation
  -> separately authorized initial-message canary
  -> separately authorized automated follow-up canary
  -> measured expansion toward the >=75 cohort
  -> evaluated reply assistance and CIM extraction
```

Provider-policy research can proceed in parallel with local stabilization because it does not require production mutation. Do not block a documentation or evaluation task on unrelated production access. Conversely, do not begin a real send just because provider documentation was researched.

### 17.2 Release gates

| Gate | Required evidence | Explicitly not implied |
|---|---|---|
| G0 — Current implementation complete | Task 9 validation, full regression comparison, full-branch review, exact-head CI | Not deployed; duplicates not cleaned |
| G1 — Integrity baseline deployed | Exact revision, additive schema health, source/database checks, controls unchanged | No cleanup apply or automatic sending |
| G2 — Confirmed cleanup accepted | Fresh checkpoint, pure preview, owner-reviewed artifact, exact four-row apply, history/projection audits | No broader merge or workflow reset |
| G3 — Communication permitted and usable | Provider/copy/cohort approval, identity/DNS/receiving readiness, manual compose/reply and safe attachment checks | No unattended enrollment |
| G4 — Shadow accepted | Zero provider sends, complete decisions, reviewed errors/false positives, current policy evidence | Not permission to lower existing thresholds or lift caps |
| G5 — Initial-message canary | Owner-accepted current activation evidence and deliberately small cohort/cap | No follow-up automation or unlimited active mode |
| G6 — Follow-up canary | Defined total touches/caps/cadence, stop/takeover tests, actual inbound coverage | No contact-pressure expansion by another feature |
| G7 — Broader policy | Cohort evidence including 75–89, policy-version change, owner approval | No automatic re-enrollment of exhausted or suppressed cases |
| G8 — AI evidence assistance | Data approval, held-out evaluation, secure pipeline, owner review | No autonomous contracts, financial commitments, or factual overwrites |

Existing Stage 2 requires at least 25 canonical human decisions, 10 current-policy cohort decisions, and 95% unchanged-recipient approvals, alongside identity/source/compliance gates. Preserve these until an explicitly reviewed replacement is accepted. A suggested 20–50 opportunity shadow sample is useful operating evidence, not a shortcut around that contract. [R04, R07]

### 17.3 Safe incremental deployment

Deploy runtime/schema support before filling new operational tables or activating policies. An empty supersession/enrollment table should not alter unrelated workflow behavior unexpectedly. Startup DDL must be tested against a disposable previous schema; it must not silently execute the incident repair.

Stage 2 initial sending and automatic follow-ups are separately controlled capabilities. Roll out the ability to observe and safely stop work before turning on the ability to initiate it. Keep a clear rollback path to pauses and compatible code; never drop history tables as a quick rollback.

### 17.4 Owner pilot

After identity hardening, run the prepared five-opportunity session and expand only as useful. Include a mid-score opportunity and a contradiction case, not only top scores. Observe actual navigation, decision evidence, next-action handoff, and return-to-work behavior.

The initial pilot may remain observation-only. Any saved disposition, note, upload request, or email is its own ordinary authorized application action. The agent must not invent owner decisions, timing measurements, reply rates, or successful provider tests.

---

## 18. Work packages and dependencies

These package names organize the roadmap. They do not renumber or replace the current Tasks 1–10, Task 6A/6B, or their execution history. Every package needs a bounded task brief with actual file paths, inputs, outputs, tests, and authorization.

### P7-R: Finish duplicate-consolidation stabilization

**Inputs:** Current local branch, accepted supersession spec/plan/addenda, Task 9 checkpoint artifact decision, last stop report.

**Deliverables:** Complete validation before writable opens; approved checkpoint file contract; controlled baseline regression diagnosis; full feature/compatibility tests; independent review; implementation PR and exact-head CI. Later authorized release/preview/apply produces two active HVAC sale representations with history intact.

**Reuse:** Existing repair code, outbox safeguards, authority binding, typed receipts, startup DDL, classifier and recovery tooling.

**Do not add:** Another repair architecture, arbitrary pair arguments, production test records, UI merge buttons, environment checkpoint fallback, or new unapproved outbound paths.

**Done:** G0–G2 evidence is available. A passing local four-row fixture is not production cleanup completion.

### P7-Q1: Correct financial and source provenance

**Problem:** A generic profit value and “Added” date can look more specific than the evidence supports.

**Deliverables:** Trace raw source labels and periods, preserve them where available, display unknowns, distinguish source date from CRM creation, and avoid reporting Annual Profit as TTM EBITDA. Identify any historical data that cannot be reconstructed honestly.

**Design choice:** Prefer additive source-observation fields or projections consistent with existing evidence machinery. Do not bulk relabel old financial records from a guess. Handle score compatibility/version changes separately.

**Tests:** Mixed SDE/EBITDA/profit inputs; missing period; conflicting observations; unchanged machine/operator ownership; historic record without recoverable raw label; source-updated versus CRM-created dates.

**Done:** An owner can identify the original earnings measure and period—or see that they are unknown—without opening implementation code.

### P7-Q2: Align confidence, contradictions, and eligibility

**Deliverables:** Explain the confidence basis; distinguish completeness from consistency; material contradictions become explicit auto-contact blockers; unresolved franchise/geography/identity conflicts cannot be hidden behind score 100.

**Reuse:** Existing score evidence, gate reasons, Low Confidence view and currentness checks.

**Tests:** High completeness with contradictory location/recipient; low/missing earnings evidence; profile changes; source failure; a clean high-score positive control.

**Done:** The same deterministic blocker is visible in the UI and enforced by the policy service. No model-derived probability is presented as calibrated confidence.

### P7-W: Complete the owner next-action handoff

**Deliverables:** A pursued unlinked opportunity locates the correct existing CRM record or safely creates one through shared authority, then attaches a clear next action/waiting state. Improve navigation to existing communication and material views.

**Dependency:** Supersession-aware matching must be complete first.

**Tests:** Existing primary, legacy duplicate, ambiguous match, no match, repeated click, concurrent handoff, Watch/Pass unchanged, no email generated simply from a decision.

**Done:** Each pilot Pursue has one understandable work item, without duplicate CRM creation or another task system.

### P8-00: Decide permitted transport and approved outreach scope

**Deliverables:** Written provider applicability, contact-permission evidence rules, mailbox coverage decision, current legal/copy review, sending identity and domain plan, default recipient caps and opt-out scope.

**Output:** A short decision record choosing permitted Resend reuse or a Gmail-native branch, plus unresolved blockers. If neither supports the proposed automatic purpose, the product remains manual/draft-only for that cohort.

**Done:** No provider-policy assumption remains buried in code or configuration. No production send is part of this research task.

### P8-01: Validate the existing manual communication loop

**Deliverables:** Reliable in-app compose/reply and history; exact recipient/server content confirmation; inbound reply stops; manual takeover; honest accepted/delivered status; safe unassigned handling; body/attachment retrieval observability.

**Reuse:** `communications.js`, follow-up workspace, email readiness, existing provider adapter, outbox and CIM request paths.

**Tests:** Repeated submit, stale CRM version, superseded ID, one broker/two deals, changed reply address, delivery event replay, delayed accepted evidence, manual-versus-scheduler race.

**Done:** The owner can run a small permitted communication pilot end to end before unattended sends are enabled.

### P8-02: Add secure mail-attachment material capture

**Deliverables:** Bounded private ingestion, stable attachment IDs/hash, quarantine/scan, vault publication, correct opportunity association, retrieval retries, material classification and owner task.

**Reuse:** Existing vault, upload/document access, cleanup intents and backup manifests. Do not create an unprotected “email attachments” folder.

**Tests:** Duplicate webhook, expired URL, interrupted download, wrong-business PDF, unsafe file, malformed MIME, oversized stream, parser timeout, private-link SSRF, disk-full, restart recovery.

**Done:** Correct permitted material survives recovery, appears under the correct deal, and pauses outreach without being mislabeled as reviewed financial truth.

### P8-03: Implement versioned policy enrollment and shadow evaluation

**Deliverables:** A deterministic policy/evidence record for each candidate; >=75 target cohort evaluation without sending; readable reasons for exclusion; preserved owner decisions; one logical request/sequence owner.

**Reuse:** Existing Stage 2 run/decision/evidence machinery. Add policy fields only where the current contract cannot express the approved behavior.

**Tests:** Score 74 versus75 versus90; stale score; threshold clamp compatibility; changed criteria; paused policy; uncertain recipient; permission missing; CSV duplicate; superseded CRM; noncurrent source.

**Done:** Shadow produces zero transmission and enough evidence to decide whether a live canary is justified. Do not count shadow eligibility as owner Pursue.

### P8-04: Release controlled initial and follow-up automation

**Deliverables:** Explicit activation for the selected permitted cohort, shared recipient budgets, fenced worker command, first-message canary, then separately accepted follow-up cadence with five-total semantics and stops.

**Prerequisites:** G2–G4; no unresolved provider/input-policy decisions; reliable inbound and manual control.

**Tests:** All final-boundary authority checks; recipient cap race; fifth-touch cap conflict; policy change midsequence; source loss; stop before claim; reply during provider call; manual takeover; lease expiry; no catch-up burst.

**Done:** Accepted logical touches occur only under the policy; every intervention and ambiguous outcome is visible; exhausted cases never restart automatically.

### P8-05: Broker response and exception handling

**Deliverables:** Structured next actions for NDA, call, buyer-profile question, material mismatch, no longer available, and out-of-office. Start with deterministic holds and owner review; add evaluated AI proposals only when justified.

**Tests:** Quoted unsubscribe text versus current opt-out; broker offers another listing; one message references several businesses; request for confidential financial qualification; ambiguous automated reply.

**Done:** Replies change the owner's work instead of leaving an inappropriate follow-up ready to send.

### P8-06: Measure, review, and expand deliberately

**Deliverables:** Funnel and safety metrics from existing records, score-band cohort analysis with sample counts, owner effort log, operational dashboards and a rollout review.

**Tests:** Canonical opportunity deduplication in counts; accepted versus delivered; materials received versus reviewed; missing data not zero; repeat event not repeat conversion.

**Done:** The owner can justify a next policy version from actual outcomes, not just email throughput.

### P9-01: Evidence-backed CIM extraction and decision briefs

**Deliverables:** Secure parsed text, structured financial/risk proposals with exact evidence, comparisons against listing observations, owner acceptance workflow, re-score preview and concise decision brief.

**Dependency:** Reliable capture and identity; explicit model/data-handling approval; representative evaluation.

**Done:** Extraction reduces measured review work without inventing metric/period/citation or taking acquisition action.

### Optional branch: Native Gmail coverage

This is selected only if required by the owner workflow. Deliver secure OAuth, scoped ingestion, Pub/Sub/watch renewal, history/cursor recovery, mailbox/thread mapping, in-app/native reply consistency, and revocation behavior. Do not add it as a second sender behind the owner's back or call it a prerequisite for an app-owned inbox.

---

## 19. Acceptance-test matrix

These are required scenarios to translate into exact repository tests; names here are behavior contracts, not claims that tests already exist.

| Area | Scenario | Required result |
|---|---|---|
| Identity | Same listing appears in Sheet and CSV | One canonical request authority; no duplicate outreach |
| Identity | Asking price or earnings change | New attributable observation, not automatic new lead/sequence |
| Identity | Same broker represents two distinct listings | Separate opportunities/conversations; shared contact cap |
| Identity | Superseded CRM ID used directly | Typed refusal before business/send side effects |
| Identity | Old record deep link opened | Historical read with truthful origin and safe survivor navigation |
| Merge | Relevant active/reversed supersession history | Canonical merge refuses; unrelated history does not globally block |
| Policy | Score75 but stale source/contradiction | Automatic contact blocked despite numeric threshold |
| Policy | Current implementation configured below90 | No silent bypass of existing clamp; new policy must be explicit |
| Policy | Watch/Pass/manual hold has high score | No automatic enrollment overriding owner intent |
| Policy | No recipient-permission evidence | No live send |
| Policy | Existing request or exhausted sequence reimported | No automatic re-enrollment |
| Budget | Fifth touch conflicts with4/30 rule | Refusal until approved compatible policy; no hidden exception |
| Budget | Two workers reserve same recipient | Atomic budget/command ownership prevents oversend |
| Cadence | Weekend/DST/window delay | Correct next eligible time; no compressed catch-up |
| Cadence | Provider accepts later than planned | Next interval anchored to actual accepted touch |
| Command | Retry same logical command | Same identity/envelope; no new touch from retry |
| Command | Provider timeout after possible acceptance | Ambiguous/held; no blind retransmission |
| Command | Late acceptance evidence arrives | Reconcile original command without resending |
| Command | Policy or score changes before send | Fresh authority check; stale command cannot bypass blockers |
| Stop | Reply commits before final send authorization | No provider attempt |
| Stop | Reply arrives after provider boundary | Preserve factual in-flight result; stop all later touches |
| Stop | Opt-out/complaint/hard bounce | Shared suppression and no alternate-contact evasion |
| Takeover | Owner send races with automatic worker | One clear owner, no duplicate command/provider attempt |
| Webhook | Duplicate event or reordered events | Idempotent ingest; reply/suppression not overwritten by late delivery |
| Webhook | Bad signature or reserialized body | Refuse before trusting event |
| Inbound | Body retrieval fails | Known reply still pauses; retry content safely |
| Inbound | Several conflicting thread hints | Exception/unassigned; do not pick newest CRM row |
| Inbound | Unique email match but ambiguous business content | No automatic material completion or recipient reassignment |
| Gmail | Watch expiry/history cursor404 | Renew/recover without duplicate message ingestion |
| Gmail | Reply sent outside app in connected mailbox | Sync actual message and stop/takeover according to accepted policy |
| Gmail | Token revoked or mailbox coverage lost | Pause dependent automation; show coverage gap |
| File | Metadata present but expired download URL | Retrieval pending, not “CIM missing” or false received success |
| File | Attachment replay/content duplicate | No duplicate stored artifact/task; access remains scoped |
| File | Wrong or malicious document | Quarantine/conflict; no model tool execution or canonical fact update |
| File | Crash between file write and DB publish | Existing cleanup/recovery mechanism resolves without orphan exposure |
| AI | Prompt injection in email/PDF | No authority change, tool action, or secret disclosure |
| AI | Missing earnings metric or period | Explicit unknown; no invented EBITDA/TTM |
| AI | Unsupported factual claim/citation | Rejected or flagged proposal; owner review |
| Recovery | Restore loses recent send state | Sender remains paused until external evidence reconciled |
| Repair | Malformed checkpoint/reviewed artifact | Zero writable opens before validation completes |
| Repair | Exact first cleanup apply | Exactly four approved rows, protected data unchanged |
| Repair | Replay or failure after any write | Zero-write valid replay or full rollback; no partial cleanup |
| Regression | Focused suites pass but full suite fails | Release gate remains failed/qualified until controlled comparison and resolution |

Tests must use real disposable SQLite adapters at authority boundaries, simulated providers, controlled clocks, and deterministic races where relevant. Do not mask regressions by disabling foreign keys, dropping current tables to reach an old assertion, weakening guards, or deleting meaningful assertions.

### 19.1 Test evidence quality

Record test command, exact source revision, runtime, fixtures, pass/fail/skip counts, and relevant side-effect assertions. A subtask review does not replace the full-branch gate. A matching failure count on two commits is weaker than matching failure names and causes under identical conditions.

A newly required field must have negative validation coverage. A test that never reaches the intended boundary is not proof of that boundary's safety. Include positive survivor/permitted-send controls so “block everything” does not masquerade as a working system.

---

## 20. Risks and mitigations

| Risk | Consequence | Primary mitigation |
|---|---|---|
| Provider disallows proposed outreach | Account enforcement, lost delivery, unusable automation | Resolve permitted purpose/recipient evidence before implementation activation; no quota/policy evasion |
| Threshold lowered without provenance work | Wrong businesses or brokers contacted | Separate score from eligibility; versioned cohort rollout and contradiction gates |
| Same broker on multiple listings | Duplicate pressure or misfiled CIM | Exact thread/request evidence plus shared recipient limits |
| Existing and new follow-up engines overlap | Duplicate sends | One sequence owner; atomic takeover and shared durable commands |
| Inbound processing unavailable | Cadence continues after replies | Receiving-health gate, durable reply stop and reconciliation |
| External send outcome ambiguous | Duplicate follow-up or lost evidence | Hold original command, local idempotency and evidence reconciliation |
| Supersession hides rather than preserves evidence | Owner loses history or old IDs keep acting | Durable relation, read-through provenance, transactional writer guards |
| False CIM completion | Diligence proceeds on wrong/incomplete document | Separate attachment, safe storage, material classification and review states |
| Model invents facts or follows hostile text | Bad acquisition decision/data leakage | Constrained extraction, evidence citations, no tools/send authority, evaluation |
| Broad Gmail access captures personal mail | Privacy exposure and unnecessary compliance scope | Dedicated mailbox/minimal scopes/application inclusion rules and access audit |
| Exhausted cases re-enroll after source changes | Harassment and duplicate contact | Durable lifecycle independent of mutable price/score/import keys |
| Conservative authority digest rejects unrelated change | False conflicts and extra review | Accept initially; measure frequency before narrowing authority safely |
| Growing repair scope delays owner value | More architecture than operating use | Freeze current pair scope, finish gates, deliver manual loop before optional expansion |
| Full-suite failures dismissed as pre-existing | Hidden release regressions | Original-base comparison and final exact-head evidence |
| Backup is only on the same volume | Shared failure destroys live and backup | Verified independent copy and isolated restoration exercise |

The user has already experienced repeated narrow design gaps during implementation. Prevent another cycle by making new task briefs explicit about CLI/config inputs, nested validation, provider permissions, dependency inventories, and success states **before** coding. Do not respond by inventing a universal repair or orchestration framework.

---

## 21. Engineering estimates and calendar assumptions

### 21.1 How to use these estimates

The figures below are **planning judgments**, not measured remaining work, vendor quotations, statistical confidence intervals, or promises. They represent remaining hands-on engineering and review effort from the last supplied stop state, using the existing codebase. Already completed development is excluded.

Each package includes its focused tests and ordinary review. Final integration/release rows cover cross-feature verification and authorized operational execution, not double-counted feature construction. Unresolved failures, provider applicability, and actual code reuse are the largest variables.

### 21.2 Remaining current hardening

| Remaining package | Optimistic | Working estimate | Cautious |
|---|---:|---:|---:|
| Task 9 checkpoint file/shared validation correction | 3h | 5h | 8h |
| Task10 baseline regression investigation, fixes, full verification and review | 6h | 14h | 28h |
| Reviewed release, fresh checkpoint, preview, approved cleanup and verification | 4h | 7h | 12h |
| Profile/source/financial metric and period provenance | 8h | 14h | 24h |
| Confidence/contradiction and eligibility presentation/enforcement | 4h | 6h | 10h |
| Owner pilot and existing next-action handoff improvements | 4h | 7h | 12h |
| **Current-hardening total** | **29h** | **53h** | **94h** |

Broader unresolved duplicate candidates are not included as an unlimited cleanup obligation. Budget each evidence review and separately approved repair cohort after the first two-pair result is accepted. Do not add a speculative total for an unknown number of businesses.

### 21.3 Broker-materials automation using a permitted existing transport

| Remaining package | Optimistic | Working estimate | Cautious |
|---|---:|---:|---:|
| Provider/cohort/copy decision and evidence contract | 3h | 5h | 10h |
| Validate/adapt existing transport, event and delivery plumbing | 4h | 8h | 14h |
| Thread ownership, in-app compose/reply and manual control improvements | 4h | 8h | 14h |
| Secure attachment capture and materials workflow | 8h | 14h | 24h |
| Eligibility, enrollment, cadence/caps and sender integration | 8h | 14h | 22h |
| Reply-intent/exception workflow, initially deterministic/owner-led | 4h | 8h | 14h |
| Cross-feature security/regression, canary preparation and rollout evidence | 10h | 18h | 30h |
| Minimal funnel and operational metrics | 3h | 6h | 10h |
| **Broker-automation total** | **44h** | **81h** | **138h** |

**Combined base scope: 73h optimistic / 134h working / 232h cautious.** For planning, hold roughly a 20–30% reserve on the working estimate, producing an approximately **160–175-hour budget**. This is not a maximum, particularly while the 242-failure diagnosis and provider-permission decision remain unresolved.

The estimate is lower than a greenfield mail/CRM build because receiving, compose/reply, outbox, follow-up and Stage 2 machinery already exist. It is not a claim that those capabilities need only configuration; every changed authority boundary still needs verification. [R02–R07]

### 21.4 Optional additions, not included above

| Optional scope | Optimistic | Working | Cautious |
|---|---:|---:|---:|
| Gmail-native mailbox integration and synchronization | 24h | 40h | 72h |
| Evaluated CIM extraction, evidence review and re-score preview | 24h | 40h | 64h |
| First-class broker entities and richer relationship analytics | 8h | 16h | 28h |

Select options deliberately. Gmail may replace some transport integration work, so do not mechanically add every row to a budget without revising the work breakdown. Likewise, a small reply classifier is not the same scope as full CIM extraction.

### 21.5 Calendar and ongoing cost

At 25–30 productive engineering hours per week, the working estimate with reserve suggests roughly **six to seven weeks of engineering capacity**. A larger weekly allocation can shorten that; owner availability, provider review, DNS, OAuth review if needed, and real broker response time add calendar uncertainty. The natural five-touch observation window alone spans approximately two weeks before window/cap delays and can overlap development. Do not promise a completed live cadence faster by shortening its safety intervals.

Codex can accelerate implementation, but waiting on tests, reviewing changes, debugging cross-feature behavior, and collecting live evidence do not disappear. Re-estimate after the full-suite diagnosis, provider decision, and first manual communication/material capture session.

Provider operating cost should be modeled separately as permitted message volume, inbound storage/processing, protected document storage, backup copies, model tokens, and review labor. Do not buy a larger send plan to solve a contact-policy problem. Use current account terms/pricing when the provider is chosen; this document does not fix a stale monthly price.

---

## 22. Documentation, decisions, and source governance

### 22.1 One reference, bounded task specifications

Keep this roadmap as the stable product-direction reference. Detailed implementation specs remain separate and small enough to review. Existing approved repair specs are authoritative for their exact incident; this roadmap does not rewrite their digests, tuples, or execution receipts.

Suggested layout:

```text
docs/roadmap/2026-09-20-uckele-group-product-vision-and-roadmap.md
docs/roadmap/DECISIONS.md                   # add when decisions are recorded
docs/superpowers/specs/<bounded-feature>.md
docs/superpowers/plans/<bounded-feature>.md
docs/reviews/<feature-verification>.md
docs/<operator-runbook>.md
AGENTS.md                                 # short pointer, not duplicate roadmap text
```

Do not create every suggested file empty merely to satisfy the layout. Append the companion guidance to an existing agent file rather than replace its instructions.

### 22.2 Decision record template

```text
Decision ID and date:
Owner and approver:
Question:
Selected behavior:
Rejected alternatives and reason:
Affected existing contracts and policy versions:
Inputs / validation / failure behavior:
Evidence and source references:
Production authority granted: NONE unless explicitly specified
Tests and rollout gate:
Revisit condition:
```

### 22.3 Reviewable policy decisions still needed

| Decision | Proposed position | Status |
|---|---|---|
| Permitted email channel/cohort | Conditional existing Resend reuse; Gmail-native only for a real mailbox requirement and permitted purpose | Provider applicability unresolved |
| Native Gmail coverage | Optional unless owner requires independent Gmail activity to synchronize | Owner confirmation needed |
| Size/geography/earnings profile | One dated owner profile; do not silently use conflicting historic criteria | Reconfirmation needed |
| Automatic >=75 enrollment | Approved direction; preserve current >=90 and manual gates until reviewed new policy | Detailed activation not approved |
| Touch count | Five total: initial + four follow-ups | Proposed explicit interpretation to ratify in policy |
| Fifth touch versus4/30 cap | Do not exceed existing cap until approved replacement | Required policy decision |
| Recipient timezone/window | Verified timezone where supported; explicit fallback, not inferred precise location | Detailed policy needed |
| No-reply re-engagement | No automatic recycling in V1 | Recommended |
| AI document data | No confidential document model processing without data/eval approval | Not activated |
| Broad duplicate cleanup | Pair-by-pair evidence and explicit approval | Deferred |

### 22.4 Source freshness and research limits

Pin repository citations to the reviewed commit; record current main separately. Provider and regulatory pages can change, so recheck them at activation and whenever a provider/policy version changes. A versioned URL in a research ledger is evidence of what was read, not a guarantee of permanent availability.

Avoid copying private reports wholesale into a public repository. Retain their hashes and names privately, and commit only the minimum sanitized operational facts needed by the task. Reading a source is not proof that its described feature is configured or passes live tests.

---

## 23. Agent execution contract

### 23.1 At task start

1. Read this roadmap's relevant sections and the current explicit owner task.
2. Inspect actual branch, HEAD, uncommitted changes, current spec/plan and execution ledger.
3. Separate main/deployed behavior from unpushed implementation and proposed future behavior.
4. Trace existing service/storage/UI paths before designing another subsystem.
5. State the narrow deliverable, inputs, outputs, tests, dependencies and non-authorized actions.

The immediate implementation task remains the approved Task 9 checkpoint correction plus Task10 verification. This new roadmap must not cause an agent to abandon that work and start auto-sending features.

### 23.2 During implementation

Use TDD and real disposable storage at authority boundaries. Preserve unrelated dirty worktrees. Reuse established errors, transactions, event identities, outbox, document recovery and authorization patterns. Mock providers and use synthetic or explicitly approved redacted data.

Compatible fixes within an approved task do not require a new architecture cycle. A changed production side-effect boundary, new permission scope, new provider, new durable input contract, widened repair target, or new data disclosure does require an explicit decision. Distinguish a broken fixture chronology from a runtime guard defect; never disable a correct guard simply to seed a test.

Use parallel agents only for genuinely independent tasks. Shared large storage/service files need a single integration owner and clear ordering. A review by a different agent should identify the exact revision and examined scope; do not label a summary reread a full independent audit.

### 23.3 Before handoff

Run verification against the final revision. If a fix changes tested code, rerun affected gates. Do not turn an old incident instruction such as “run check exactly once” into a permanent limit on verification.

Report failed and skipped tests honestly. Do not count unrun tests as pass or dismiss a failure solely because another intermediate branch had it. Record exact-head CI after the final commit. Put final CI references in the PR/handoff when necessary rather than creating an endless documentation-commit/changed-SHA loop.

### 23.4 Production actions remain separate

A code PR, roadmap approval, a tool's successful dry-run, or an AI recommendation is not authorization to merge, deploy, run a repair, activate sending, alter suppression, sign an NDA, or disclose buyer finances.

Before a separately authorized action, verify current release/state, current evidence, and the bounded action described by that authorization. Preserve the relevant checkpoint and receipt. Stop on material drift; never alter production to match a stale plan.

### 23.5 Required handoff shape

```text
Task and exact scope:
Branch/base/head:
Existing capabilities reused:
Files/contracts changed:
Owner decisions or policy versions affected:
Tests, commands, environment and counts:
Known failures/skips and classification:
Independent review scope/findings:
Local/disposable side effects:
Production actions actually performed:
PR/CI status where applicable:
Remaining blockers and next bounded task:
```

### 23.6 Definition of ready for a new feature

A task is ready when purpose, authority, inputs, allowed changes, failure behavior, observable outcome, test cases and rollout gate are defined. Do not start an automation feature with unresolved “where does this checkpoint/configuration come from?” or “which system owns the email?” questions hidden in implementation.

---

## 24. Immediate next actions and owner decisions

### Current execution priority

Finish the already-authorized **UG-P7-01H** continuation: explicit checkpoint artifact, shared complete validation before writable construction, Task9 review, controlled full-suite comparison, Task 10 final audit, then a reviewed implementation PR. No new autonomous outreach work should be mixed into that branch.

### Parallel planning priority

Open **P8-00** as a research/decision task: determine permitted outreach scope with the selected provider and confirm whether native Gmail activity must synchronize. This can advance without touching production. It is the largest new architectural uncertainty uncovered by the research.

### First owner-facing product increment after integrity work

Use the existing communication workspace to demonstrate a small permitted manual request/reply/materials workflow. Simultaneously correct financial metric/period and contradiction presentation enough to make future eligibility decisions trustworthy. Do not postpone manual control until after autonomous sending.

### Autonomy target

The goal remains a policy-driven >=75 acquisition workflow with limited follow-ups, reliable broker history, secure materials, and owner-directed next actions. Reach it through current-criteria reconciliation, provider permission, shadow evidence, a small initial canary, separately accepted follow-ups, and deliberate threshold expansion—not a single “enable automation” switch.

### Long-term expansion

Once the basic loop works, expand evidence-backed CIM extraction, broker relationship context, and funnel optimization. Later opportunities include reminders for NDA review, owner-prepared broker calls, comparison briefs across shortlisted businesses, and source-quality analysis. Automatic legal commitments, proof-of-funds disclosure, unbounded scraping, and autonomous purchase decisions remain outside this roadmap.

---

## 25. Source register and research notes

### 25.1 Citation convention

References such as `[R04]` identify repository evidence; `[I01]` identifies an owner-supplied report; `[W01]` identifies current official public research; `[D01]` identifies owner direction from the conversation. Source-derived facts are cited near their use. Uncited implementation choices are this document's recommendations, not claims of an existing implementation.

Public documentation was researched on September 20, 2026 in the owner's Pacific-date context. No personal Gmail content or production database was read. The latest report's filename uses September 21 UTC while the owner's handoff occurred September 20 Pacific; this is not evidence of a future deployment.

### 25.2 Repository sources, pinned to the observed main revision

**[R01] Remote main reference.** Fresh GitHub read resolved to `cec88c5a37a5dc433896ee5fd737d606691a3f31`. This proves repository state at inspection, not Fly state.  
https://api.github.com/repos/muckele/uckele-group/git/ref/heads/main

**[R02] README, application architecture, current feature inventory, Daily Digest and recovery boundaries.**  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/README.md

**[R03] Human-reviewed follow-up operations, compose/reply, outbox, takeover, provider setup, AI/data and opt-out boundaries.** Some historical model/provider rollout notes are dated; do not treat them as a current model selection.  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/docs/follow-up-operations.md

**[R04] Stage2 policy implementation, especially `getCimStage2Policy`.** Observed score clamp90, profit300k–750k, source restrictions, recipient caps and activation evidence.  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/server/services/cimAutomation.js

**[R05] Current operator-approved follow-up contract.** Maximum5 follow-ups and accepted-Pacific-date-plus2/weekend-forward09:00 cadence; distinct from proposed five-total automatic policy.  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/server/services/dealHunterManualFollowUpPolicy.js

**[R06] Communication normalization, assignment, Resend content retrieval, response-stop and retry code.** Selected inspected ranges1–240 and560–1150; not an exhaustive security audit of the file.  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/server/services/communications.js

**[R07] Guarded CIM Stage2 runbook.** Current infrastructure and strong canary requirements; contains older Daily Digest/CRM wording inconsistent with current README, as disclosed in Section4.2.  
https://github.com/muckele/uckele-group/blob/cec88c5a37a5dc433896ee5fd737d606691a3f31/docs/cim-stage2-rollout.md

These links may require the user's GitHub authorization. Do not copy private repository files to public services to bypass access.

### 25.3 Owner-supplied evidence register

The following original files were available in this conversation. Checksums identify bytes inspected, not source-code correctness. Keep the source files private; they are not included in the distribution package.

| ID | File / evidence | SHA-256 |
|---|---|---|
| I01 | `Pasted markdown(20260921-021416).md` — last implementation stop, Task9 issues, 242-failure full-suite disclosure | `21f734c3149e85c69cf7144f323f5ce7e24fa12b904620861cd0c12b8be5ebd5` |
| I02 | `Pasted markdown (2).md` — owner-workflow pilot, provenance/contradiction and navigation findings | `eb3c8f4c495a2479b000e1e24af9fcbca2f78b8adfb4601edfc709ff92b547a6` |
| I03 | `Pasted markdown(20260917-175513).md` — reported PR19 deployment/v125, health and recovery checkpoint | `ebd829d2c82c3f800cea0d66aa49f42eca4a01be9e500e07a452c6d3690017e4` |
| I04 | `Pasted markdown (2)(1).md` — approved confirmed-pair supersession design; subsequent owner-approved addenda also apply | `4d0cd122f964668ab9c5adca214bc330fb63945a8ad5ed31be365c00e2b0ce97` |
| I05 | `Pasted markdown(20260919-150757).md` — initial runtime baseline test result and local Tasks1–6 stop | `187284bcff9e10efc4ac20d4613c7b556d2eb64bef6b69764e31b485d6757a8d` |

**[D01] Current owner conversation.** Approved new acquisition automation direction; approved canonical-merge Option1 and checkpoint-artifact Option2; current task requests research and an agent-reference document. No new production execution authorization is inferred.

**[D02] Historical owner criteria.** Prior owner context described $600k–$2m SDE and Western-US targets. This is retained only as a discrepancy to reconfirm against implemented rules, not as silently current scoring authority.

### 25.4 Official public research

**[W01] Resend Acceptable Use Policy — updated August 27, 2026.** Critical provider-permission constraint: unsolicited/cold outreach prohibition and explicit opt-in requirement.  
https://resend.com/legal/acceptable-use

**[W02] Resend: Get Email Content.** Webhook metadata versus receiving/attachment API content retrieval.  
https://resend.com/docs/dashboard/receiving/get-email-content

**[W03] Resend: Custom Receiving Domains.** Receiving-domain/MX setup and existing mailbox separation.  
https://resend.com/docs/dashboard/receiving/custom-domains

**[W04] Resend: Receiving Attachments.** Attachment retrieval and expiring download URLs.  
https://resend.com/docs/dashboard/receiving/attachments

**[W05] Resend: Webhooks Introduction.** At-least-once delivery, ordering and retries.  
https://resend.com/docs/webhooks/introduction

**[W06] Resend: Verify Webhook Requests.** Raw-body and signature verification.  
https://resend.com/docs/webhooks/verify-webhooks-requests

**[W07] Resend: Idempotency Keys.** Provider key retention and exact-request retry semantics.  
https://resend.com/docs/dashboard/emails/idempotency-keys

**[W10] Gmail API: Push Notifications.** Pub/Sub, watch renewal and notification semantics.  
https://developers.google.com/workspace/gmail/api/guides/push

**[W11] Gmail API: Synchronize a Client.** Full/partial synchronization and stale history recovery.  
https://developers.google.com/workspace/gmail/api/guides/sync

**[W12] Gmail API: Manage Threads.** Native thread and RFC reply requirements.  
https://developers.google.com/workspace/gmail/api/guides/threads

**[W13] Gmail API: OAuth Scopes.** Sensitive/restricted classification and scope selection.  
https://developers.google.com/workspace/gmail/api/auth/scopes

**[W14] Google Workspace: Configure OAuth Consent.** Internal/external app configuration and verification context.  
https://developers.google.com/workspace/guides/configure-oauth-consent

**[W15] Google Workspace API User Data and Developer Policy.** Data use, protection and restricted-data obligations.  
https://developers.google.com/workspace/workspace-api-user-data-developer-policy

**[W16] Google Email Sender Guidelines.** Sender authentication, alignment and scale-specific requirements.  
https://support.google.com/a/answer/81126

**[W17] FTC: CAN-SPAM Act Compliance Guide for Business.** Commercial-message classification and compliance context; not a legal opinion about this specific acquisition workflow.  
https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business

**[W18] OWASP File Upload Cheat Sheet.** Layered file validation, storage and scanning.  
https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

**[W19] OWASP SSRF Prevention Cheat Sheet.** Safe outbound fetch boundaries for untrusted links.  
https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

**[W20] OpenAI: Safety in Building Agents.** Untrusted-data boundaries, constrained outputs and tool/approval controls.  
https://developers.openai.com/api/docs/guides/agent-builder-safety

**[W21] OpenAI: Evaluation Best Practices.** Representative task evaluation and continuous regression evidence.  
https://developers.openai.com/api/docs/guides/evaluation-best-practices

**[W22] OpenAI: Your Data.** Endpoint/data-control and retention distinctions to review before model processing.  
https://developers.openai.com/api/docs/guides/your-data

### 25.5 What remains unverified

- Whether the proposed broker cohort meets any particular provider's contact-permission rules.
- Whether the owner requires native Gmail Inbox/Sent synchronization.
- Current production state beyond the dated supplied deployment report.
- Whether Task 9/Task 10 advanced after the latest local handoff.
- Root causes of the 242-test discrepancy.
- Full byte-ingestion/CIM-vault behavior on the final local branch.
- Current OAuth application classification and any verification/security-assessment obligations.
- The most useful runtime model, its measured extraction quality, and approved data configuration.
- Real broker response/CIM rates and the economically useful score floor.

These are explicit next decisions or verification tasks, not reasons to abandon the product vision.

---

## Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-09-20 Pacific | Initial researched roadmap. Corrected unconditional Resend-first assumption; distinguished existing capabilities from new work; reconciled score/cadence/cap conflicts; preserved current stabilization and production gates. |

**End of reference.**
