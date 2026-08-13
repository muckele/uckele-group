# CIM Stage 2 human-review and pre-canary playbook

This playbook reaches a pre-canary readiness checkpoint. It does not authorize, create, or run a canary. It is an operational control, not legal advice.

## Roles and authority

- **Authenticated human administrator:** reviews one canonical opportunity at a time in the protected Operations workflow and records the administrator's own approve, approve-with-edit, or reject decision.
- **Compliance owner:** supplies attributable acceptance references for communication classification, postal address, reply-based opt-out behavior, and the exact automatic copy.
- **Domain/email administrator:** supplies attributable evidence for the actual Resend From and Reply-To configuration, SPF/DKIM verification for the actual From domain, and DMARC review.
- **Release owner:** separately decides whether to activate a canary only after every gate has real evidence. Passing the review counts does not make or imply that decision.
- **Codex/automation:** may implement, test, audit, back up, and report. It must never create, infer, simulate, import, seed, or submit a human decision or self-attestation.

## Controls that must remain fail-closed

Before and after every review session, confirm all of the following:

- configured, evidence, and effective automation stages remain Stage 1 until the independent gates genuinely pass;
- activation remains `off` (or an already-authorized non-transmitting `shadow` record), and `automaticTransmissionAllowed` remains `false`;
- the automation-only pause remains on;
- the dedicated Stage 2 scheduler remains disabled;
- CIM follow-ups remain disabled;
- the central/manual Stage 1 pause is not changed by this process;
- the only allowed Stage 2 source is `sheet-0`;
- no broker email, provider call, canary, or active run occurs.

Stop immediately if the queue reports unhealthy, stale, widened, empty, or warning-bearing source coverage; an unresolved canonical identity; a changed policy binding; a duplicate submission; or any unexpected transmission state.

## Human review procedure

1. Sign in with the individual full-administrator account that will be attributable to the decision. A viewer account cannot load candidate detail or write evidence. Do not share the session.
2. Open **Operations → Guarded Stage 2 rollout → Protected zero-send human evidence queue**.
3. Select **Load human review queue**. Confirm the panel says the source snapshot is healthy, the allowed source is exactly `sheet-0`, and the displayed rule, policy, source-policy, evidence, and queue bindings are present.
4. Review the one candidate presented in the fixed order. The order is a hash of the rule version, source-policy hash, and canonical opportunity ID; it does not rank by score, eligibility, or predicted approval. Do not skip candidates because an approval seems more or less likely. Do not search for likely approvals to improve the quality percentage.
5. Open the original broker listing from the protected candidate card. Compare it with the Sheet source information.
6. Verify the displayed canonical opportunity ID belongs to that listing. If the listing appears duplicated, conflated, or linked to the wrong canonical opportunity, reject with the factual reason and stop for identity review when appropriate. Never repair identity by guessing.
7. Verify the exact source recipient evidence:
   - check the source-provided name, address, role/source column, and listing context;
   - do not infer an address from a name or domain;
   - do not use an address from an unrelated listing or an unrestricted external list.
8. Record the actual decision:
   - **Approve unchanged:** use only when the exact source recipient is correct and no recipient field is changed.
   - **Approve with recipient edit:** enter the verified final address and name and record at least 20 characters of factual, attributable edit evidence. The original and final recipient evidence are both retained.
   - **Reject:** select the actual reason. For `Other`, add a factual note. Rejects remain evidence and must not be removed to improve the rate.
9. Check the per-opportunity confirmation only after personally checking the Sheet source, original listing, canonical identity, and original/final recipient evidence.
10. Select **Record this decision (zero send)** once. This endpoint appends one evidence record and has no send path. If the response is uncertain, times out, or says the exact snapshot was already reviewed, do not resubmit blindly: refresh the queue and counters first.
11. Verify the success notice explicitly says no broker email or provider call was made. Verify the aggregate Operations counters refresh, then continue to the next candidate in the fixed order.
12. At the end of the session, record a count-only checkpoint: timestamp; reviewer account; canonical total; current-policy-compatible total; legacy/unversioned total; eligible-cohort total; unchanged-recipient approvals and rate; policy/source/evidence hashes; and any blocker. Do not copy candidate names, recipient data, listing details, notes, or message content into the checkpoint.

Each stored current-policy decision binds the authenticated actor and role, decision time, canonical opportunity, exact original/final recipient evidence, decision and rejection/edit evidence, immutable candidate snapshot, immutable rule/source-policy snapshot, source-review snapshot, rule version, policy/source bindings, evidence version, queue rank, and snapshot digest. Storage is append-only. Aggregate/viewer projections exclude the protected snapshots and recipient detail.

## Three distinct review thresholds

These gates are related but not interchangeable:

1. **25 total canonical human reviews:** count the latest genuine human decision for each distinct canonical opportunity. Repeated rows or aliases for one opportunity count once. Legitimate legacy/unversioned decisions can contribute to this total, but automation actors, fixtures, imports, inferred decisions, unsupported actors, ambiguous links, and unlinked rows do not.
2. **10 current-policy eligible-cohort reviews:** count only genuine decisions whose immutable evidence matches the current evidence version, rule version, and `sheet-0` source-policy hash and whose signed candidate snapshot satisfies the current static cohort rules. The system classifies cohort eligibility; the reviewer must not be coached by that classification.
3. **At least 95% unchanged-recipient approval quality:** numerator = current-policy eligible-cohort decisions that are approved with the original recipient unchanged. Denominator = all current-policy eligible-cohort decisions, including rejects and recipient edits. Do not discard, relabel, or replace an unfavorable result. With a cohort of 10, one reject or edit produces 90%, which does not pass.

The separate zero-cohort-identity-problem gate may be stricter than the percentage: a duplicate, incorrect-recipient rejection, or recipient edit in the eligible cohort requires review and keeps readiness blocked.

Reaching 25, 10, and 95% does not authorize canary activation. Every other technical, compliance, sender, identity, backup, shadow, pause, schedule, cap, window, suppression, and release-owner gate remains independent.

## Compliance and sender-authentication evidence checklist

Do not self-attest. Each reference must identify the accountable owner, acceptance or verification time, controlled artifact or system, exact scope, and a durable reference (ticket, approved document, provider record, or other access-controlled evidence). Include a checksum when the evidence is a file. A config value that merely says “approved” is not enough for the readiness packet.

- [ ] **Physical postal address:** compliance owner confirms the exact postal address that will appear in every automatic text and HTML message; reference identifies the accepted copy/version and date.
- [ ] **Reply-based opt-out behavior:** compliance/product owner confirms that the exact automatic copy tells recipients to reply with `unsubscribe` or `stop`; operational evidence shows signed inbound reply processing creates a global suppression before later outreach.
- [ ] **Communication classification:** compliance owner explicitly accepts the documented classification and scope of this acquisition outreach. Record the owner and substantive reference. This implementation is not legal advice.
- [ ] **Exact automatic copy:** compliance owner reviews and accepts the exact automatic text and HTML generated by the deployed commit, including purpose disclosure, opt-out language, and postal address. Bind the copy/version or checksum, not a paraphrase.
- [ ] **Resend From configuration:** domain/email administrator confirms the exact deployed From display name and address are accurate. The reference must identify the actual From domain.
- [ ] **Reply-To configuration:** domain/email administrator confirms the exact deployed Reply-To and signed inbound route are correct and monitored.
- [ ] **SPF/DKIM:** domain/email administrator records current provider verification for the actual From domain, including the verification time and provider/domain reference.
- [ ] **DMARC:** domain/email administrator records review of the actual From domain's DMARC policy and alignment behavior, including date and evidence reference.

Never put raw DNS secrets, API keys, cookies, unrestricted provider output, recipient addresses, or message bodies in the readiness report.

## Work allowed only after the human and attestation gates exist

Do not perform this section merely because reviews or attestations were requested. Perform it only after the protected aggregate status shows the authentic review thresholds actually pass and the required attributable compliance/sender references actually exist.

1. Create one fresh application-consistent production backup with `npm run backup:create` and verify it with `npm run backup:verify`. Retain the private bundle reference and SHA-256 checksum.
2. Run the CIM identity audit in dry-run mode. Require zero ambiguous pairs, duplicate active sequences, unresolved identity exceptions, missing links, safely repairable links, and linkage mismatches. Retain a count-only reference and checksum.
3. Run exactly one fresh production Stage 2 `shadow`. Require `providerCalls=0`, complete current `sheet-0` coverage, and a completed policy-matching run. Do not run canary or active mode.
4. Refresh Operations and the Stage 2 audit. Bind the backup, identity-audit, shadow, policy, source-policy, and evidence references only in a pre-canary readiness packet. Do not create an activation record.
5. Confirm again that the automation pause is on, scheduler and follow-ups are disabled, activation is off, automatic transmission is false, and no automatic initial count increased.

## Pre-canary report and handoff

The count-only report must show, for every gate, the observed value, required value, evidence time, and pass/block state. It must also include:

- deployed release/commit identity;
- rule version, policy hash, source-policy hash, evidence checksum, and evidence generated-at time;
- verified backup reference/checksum, or `not created—human/attestation gates still blocked`;
- identity-audit reference/checksum, clearly labeled current audit versus packet-fresh audit;
- shadow run ID, completion time, complete `sheet-0` coverage result, and `providerCalls`;
- attributable compliance/copy and sender-authentication references, or `not supplied`;
- remaining blockers in gate order;
- the exact safe next action.

The final handoff stops before activation and asks the release owner for a separate explicit decision only when the packet is complete. Until then, the safe next action is the specific missing human, compliance-owner, or domain/email-administrator action—not a canary.
