# Best-First Deal List and Shared Criteria Profile — Design

**Status:** Proposed implementation specification. Product decisions approved in chat on 2026-11-02; mechanics re-grounded on current `main` and pending owner approval.

**Date:** 2026-11-02

**Repository baseline inspected:** `origin/main` at `f22738d22ee33ed3f30df448fdcbebbad396d91a` (PR #81)

**Supersedes:** the draft committed as `6eae52b` on `codex/deal-hunter-removal-source-boundary`, which was written against the stale August base `0b7b79e` and referenced screens and send paths that `main` has since replaced.

**Implementation status:** Not implemented by this specification

**MVP sub-project:** 1 of 3 (best-first list and automatic Pursue). Later sub-projects are listed in §13.

## 1. Purpose

The owner wants the best deals that meet his acquisition criteria at the top of one list, with broker outreach as fast as safety allows:

- A deal scoring **90 or higher** that meets every must-have is **Pursued automatically** once that capability is activated.
- A deal scoring **75–89** that meets every must-have goes to the owner's review. One click records **Pursue**, which already starts the same campaign an automatic Pursue starts: initial SIM request plus automatic follow-ups that stop on a reply.
- One versioned criteria definition drives the list and automatic Pursue.

`main` already has the Acquisition Inbox (`src/components/admin/AcquisitionInbox.jsx`), a fresh-first ranking policy (`server/services/dealHunterFreshInboxPolicy.js`, which already treats `fit_score >= 75` as worthwhile), a five-row daily shortlist, and the Pursue → CIM autopilot campaign model (`docs/superpowers/specs/2026-09-24-pursue-cim-autopilot-design.md`). What it lacks is the owner's must-have criteria: the inbox ranks by score and freshness only, and Pursue is never taken automatically. This design adds those two things and nothing else.

## 2. Terminology

The owner says **SIM**; code and documents say **CIM**. The owner-facing action label becomes **Request SIM**, and it records the existing `pursue` owner command. No identifier, table, policy version, or route is renamed.

## 3. Non-goals

This design does not:

- change the fit score, its rules version, the 506-case scoring corpus, or the fresh-inbox discovery rules;
- change campaign cadence (sub-project 2) or any campaign, transmission, conversation, batching, or final-gate behavior;
- relax any final-gate condition, the P8-00 contact-permission prerequisite, the central pause, or the default-deny live-provider envelope;
- modify or reactivate legacy Stage 2 (`server/services/cimAutomation.js`); its criteria constants are left in place and remain inert;
- activate anything in any environment, run a production score refresh, or change production configuration.

## 4. The criteria profile

### 4.1 Values (owner-confirmed 2026-11-02)

Profile version `uckele-criteria-v1`.

| Must-have | Rule |
|---|---|
| Annual profit | 300,000 ≤ profit ≤ 750,000 |
| Profit multiple | 0 < multiple ≤ 4.0 |
| Geography | Location (or state field) contains one of NY, CA, NJ, AZ, NV, CT, using the token rule in `cimAutomation.js` (`(^|[^A-Z])ST([^A-Z]|$)` on the upper-cased location), after mapping the full state names New York, California, New Jersey, Arizona, Nevada, Connecticut to their codes |
| Industry | Name or industry text contains a trusted term: hvac, plumbing, electrical, landscape, maintenance, repair, restoration, field service, commercial service, environmental, waste, pet, veterinary, healthcare service, professional service, property management (same matching as `containsTrustedIndustryTerm`) |
| Not gated | No scoring gate (excluded category, franchise) |

| Threshold | Value |
|---|---|
| Review floor | fit score ≥ 75 |
| Automatic floor | fit score ≥ 90 (code-enforced minimum; the profile cannot lower it) |

### 4.2 Outcomes per must-have

- **pass**: value present and satisfies the rule;
- **fail**: value present and does not satisfy it;
- **unknown**: profit or multiple missing or non-numeric; location or industry text empty.

A gate is always **fail**. Missing information is never treated as a bad answer, consistent with the scoring absent-evidence rule.

### 4.3 Groups

Evaluated in order; first match wins.

| Group | Condition |
|---|---|
| `below-review` | fit score < 75 |
| `near-miss` | any must-have is **fail** |
| `needs-info` | no **fail**, at least one **unknown** |
| `auto` | all **pass** and fit score ≥ 90 |
| `review` | all **pass** and fit score 75–89 |

Passed, Watched, removed, and already-Pursued opportunities keep their existing inbox handling and never appear in these groups; the group is a property of the scored opportunity, and the inbox applies its existing decision filters first.

An `auto` deal that automatic Pursue cannot act on (§6.3) is shown under **Your review** with the reason, so the owner can Pursue it by hand.

### 4.4 Module

New file `server/services/dealCriteriaProfile.js`, pure (no storage, clock, or network):

```js
export const DEAL_CRITERIA_PROFILE_VERSION = 'uckele-criteria-v1';
export function getDealCriteriaProfile(config) {}
export function evaluateDealCriteria(deal, { profile } = {}) {
  // -> { profileVersion, group, mustHaves: [{ id, outcome, observed }], failed: [id], unknown: [id] }
}
```

## 5. Storing the group

Score rows do not persist profit, multiple, location, or industry, so the group is computed in `refreshOpportunityScores` (`server/services/dealHunterScoreStore.js`), where the full deal is available, and written on the score row as:

- `criteria_profile_version` (TEXT)
- `criteria_group` (TEXT)
- `criteria_result` (bounded JSON: outcomes, failed, unknown)

`storedScoreIsCurrent` also requires `criteria_profile_version === DEAL_CRITERIA_PROFILE_VERSION`, so a profile change forces recomputation through the existing refresh. Columns are additive in both SQLite (`ensureColumn`) and a new Supabase migration, written by the machine-owned score write only.

A row whose stored profile version is not current is shown in **Your review** with “criteria out of date” and is never acted on automatically.

## 6. Automatic Pursue

### 6.1 What it does

A new runner records the existing `pursue` owner command for `auto` deals, with:

- actor `automation-auto-pursue` and decision policy version `auto-pursue-v1` (owner clicks keep `owner-decision-v1`);
- the recipient the existing broker-materials loader selects when exactly one verified recipient exists. When the loader cannot select exactly one, no command is recorded (§6.3).

It calls the same `recordAcquisitionOwnerCommand` path an owner click uses (`server/services/dealHunterTriage.js:1137`), so enrollment, campaign creation, cadence, and every final-gate check in the autopilot design apply unchanged. Automatic Pursue never crosses the provider boundary itself.

### 6.2 Activation ladder

A separate durable capability `auto-pursue`, shipped **off**, with modes:

- **off**: no Pursue recorded; the runner still evaluates §6.3 blockers so the inbox shows an accurate “Would Pursue automatically” group;
- **shadow**: the runner computes and stores what it would Pursue, records no Pursue, reports zero commands;
- **canary**: at most **1** automatic Pursue per owner business date;
- **active**: at most the configured cap per owner business date (default **3**, maximum **10**).

Each mode change requires the owner's typed confirmation, mirroring the existing activation-confirmation pattern. The capability depends on the autopilot's own initial-request capability being activated; an automatic Pursue recorded while that capability is not live simply waits as `waiting-on-eligibility`, exactly as an owner click does.

### 6.3 Per-deal blockers

The runner skips an `auto` deal, and the inbox shows it under Your review with a plain reason, when: identity is unresolved or has an open exception; the broker-materials loader does not yield exactly one verified recipient; the recipient is a generic mailbox (existing `genericMailboxNames` list); the opportunity or recipient has any prior CIM request or campaign; the recipient is suppressed; the stored criteria version is out of date; or the owner has a current Watch or Pass.

### 6.4 Warm-up gate (owner decision 2026-11-02: keep)

Canary cannot be enabled until the owner's own decisions show automatic picks match his judgment:

- at least **25** owner Pursue or Pass decisions under `owner-decision-v1` on scored opportunities;
- at least **10** of those on opportunities whose `criteria_group` was `auto` at decision time;
- at least **95%** of those `auto`-group decisions are Pursue with the loader-selected recipient unchanged.

The owner decision event table has no metadata column and its writer is a locked RPC, so the criteria group and recipient-unchanged flag at decision time are written to a separate additive table keyed by decision event id, immediately after the decision succeeds. A failed evidence write never fails the owner's command; it only means that decision does not count toward warm-up.

The latest §6.3 blocker for each `auto` deal is stored on its score row (`auto_pursue_blocker`, written only by the runner) so the inbox can place blocked deals under Your review.

### 6.5 Runner trigger

A cron endpoint `POST /api/deal-hunter/auto-pursue/run`, authenticated by the existing Deal Hunter cron secret, idempotent per owner business date and mode. The daily digest job does not call it.

## 7. Inbox changes

The Acquisition Inbox default view keeps its **action preview** (due actions and owner priorities) and replaces the **New & important** section with the criteria groups:

1. **Pursuing automatically**: mode badge (Off / Shadow / Test / On), today's count against the cap, a link to stop via the existing campaign stop control;
2. **Your review**;
3. **Needs info**;
4. **Near misses**, collapsed by default.

Within each group: existing `compareDiscovery` order (fresh-first, then fit score, confidence, newest). Each row adds a criteria line, e.g. “Profit $420K ✓ · 3.2× ✓ · AZ ✓ · HVAC ✓”, or for near misses the failed must-have, e.g. “Multiple 5.1× (max 4×)”.

Row actions: **Request SIM** (records `pursue`), **Watch**, **Pass**: the existing three commands, relabeled for Pursue only. On a near-miss row, Request SIM first shows one confirmation naming the failed must-have.

The other inbox areas (due actions, owner priorities, updated, research, all active, passed) and the daily shortlist email are unchanged.

## 8. Failure behavior

Every uncertainty resolves toward not acting:

- criteria unevaluable or out of date: never automatic; shown in Your review;
- runner storage, activation record, or warm-up evidence unavailable: zero commands, reason reported;
- per-deal blocker: skipped and surfaced, never retried within the same business date;
- cap reached: remaining `auto` deals wait for the next business date and stay visible.

## 9. Testing

Node 22; `npm test`, `npm run test:ui` (outside the Bash sandbox), `npm run test:browser`, `npm run build`.

- **Criteria module:** profit 299,999 / 300,000 / 750,000 / 750,001; multiple 4.0 / 4.01 / 0 / missing; state tokens including near-miss strings (“NYC Metro”, “CAN”); trusted and untrusted industries; empty location and industry; gates; every group and its precedence.
- **Score refresh:** groups written; profile-version change forces recompute; scoring corpus unchanged.
- **Automatic Pursue:** off and shadow record nothing; canary caps at 1 and active at the configured cap per business date; idempotent rerun; each §6.3 blocker skips; uses `recordAcquisitionOwnerCommand` with the automation actor and policy version; warm-up gate blocks canary until all three thresholds hold.
- **Boundary:** the daily digest job never calls the runner; the runner never calls a provider.
- **Inbox (Vitest):** groups, ordering, criteria line, near-miss confirmation, read-only view, mode badge states.
- **Browser (Playwright):** Request SIM from Your review shows the existing Pursue outcomes.

## 10. Rollout

Ships with `auto-pursue` off. After merge and deploy, the owner separately approves: the score refresh that fills the new columns; then, once warm-up passes and the autopilot initial-request capability is live, shadow, canary, and active in turn.

## 11. Prerequisites outside this design

Automatic Pursue only produces email when the autopilot's own path is live: P8-00 contact-permission acceptance, controlled-mailbox evidence, signed inbound readiness, an unpaused central outreach control, and a live-provider envelope. This design neither satisfies nor bypasses them.

## 12. Relationship to earlier designs

- **Pursue → CIM autopilot (2026-09-24):** §9.3 states that a current owner Pursue is the acquisition authorization. This design adds a second, separately activated authorization source: the owner's standing instruction, recorded as `auto-pursue-v1`. Every other eligibility and final-gate rule is unchanged.
- **Acquisition Inbox v1 (2026-08-30) and fresh-first inbox policy:** extended, not replaced.
- **Legacy Stage 2:** untouched.

## 13. Later sub-projects

2. **Cadence:** `deal-hunter-cim-cadence-v2` allows follow-ups 2+ on weekends. The owner requires every touch every other business day, Monday–Friday. Needs a new cadence policy version; existing campaigns keep theirs.
3. **Activation:** walking autopilot initial and follow-up capabilities, then `auto-pursue`, through their gates in production.

The former sub-project “automatic follow-ups” is already provided by the autopilot campaign model and is dropped.
