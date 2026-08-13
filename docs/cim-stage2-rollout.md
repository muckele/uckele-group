# Guarded CIM Stage 2 rollout

This runbook deploys the Stage 2 safety architecture without authorizing automatic broker email. Code deployment and canary activation are separate release decisions. A successful deploy must continue to report effective Stage 1 and automatic transmission blocked unless a later, explicit release-owner acceptance satisfies every gate.

Use [the Stage 2 human-review and pre-canary playbook](./cim-stage2-human-review-playbook.md) for the protected deterministic evidence queue, authentic-review thresholds, attributable compliance/sender checklist, and count-only pre-canary handoff.

## Inert deployment baseline

The checked-in Fly configuration deliberately keeps:

- `DEAL_HUNTER_CIM_AUTOMATION_STAGE=1`;
- `DEAL_HUNTER_CIM_AUTOMATION_PAUSED=true`;
- `DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED=false`;
- `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=false`;
- the central all-outreach control unchanged, so correctly gated manual Stage 1 can remain available;
- Stage 3 non-transmitting.

The daily Deal Hunter job owns CRM sync and the internal summary only. It never calls the broker-send path. The Stage 2 shadow/canary runner has its own durable run and per-candidate decision evidence.

## Before deployment

1. Confirm the reviewed local commit equals the pushed branch commit.
2. Record privacy-safe baselines from `/api/ready`, `fly status -a uckele-group`, `fly releases -a uckele-group`, Operations, `npm run cim:identity:audit`, and `npm run cim:stage2:audit`. Do not copy addresses, bodies, aliases, headers, cookies, or secrets into the release record.
3. Ensure the automation-only pause is on with an accountable reason. Do not change the central all-outreach pause without separate authorization because it also affects manual Stage 1.
4. Confirm automatic provider permission is false, activation is off or shadow, follow-ups are disabled, the accepted source policy has not widened, and no unexpected send appears in logical-initial counts.
5. Create an application-consistent backup with `npm run backup:create`, verify it with `npm run backup:verify`, and retain the bundle reference plus SHA-256 evidence privately.
6. For SQLite, verify one machine and the persistent `/data` volume. For Supabase, apply `20260813120000_cim_stage2_guarded_rollout.sql` through the approved managed-backup procedure before starting the new code.

## Deploy and verify

Deploy the exact reviewed commit through the repository Fly workflow. Allow the additive SQLite migration to run at startup, then require:

- stable Fly machine and healthy `/api/ready`, including `cimStage2Storage`;
- automation pause on, automatic transmission false, activation off or shadow, Stage 3 inactive, and follow-ups off;
- dry-run identity audit with no duplicate active sequence, unresolved exception, missing link, or linkage mismatch;
- Stage 2 audit showing the real canonical human-review count and remaining gap;
- no unauthorized increase in logical initial messages, adverse events, or cap exceptions;
- signed inbound webhook/reply readiness unchanged;
- full-admin Operations showing all gates and a viewer receiving aggregate-only data;
- a shadow run that persists bounded decisions and reports `providerCalls: 0`.

Do not send a production internal test email or broker email under this runbook. If no production-scoped mock provider exists, stop at read-only and zero-send shadow verification.

## Separate canary acceptance

Canary activation is allowed only after the release owner accepts all current evidence in the protected workflow. At minimum, require 25 legitimate canonical human decisions, 10 current-policy cohort decisions, at least 95% unchanged-recipient approvals, zero cohort identity problems, a clean identity/linkage audit, complete `sheet-0`-only source coverage, score floor 90, current sender/reply/suppression readiness, configured postal address and opt-out copy, compliance/copy acceptance, SPF/DKIM and DMARC attestation, no adverse event requiring review, a fresh verified backup, a fresh shadow run, the Pacific weekday 08:00–17:00 window, the 1/24-hour and 4/30-day recipient caps, and follow-ups disabled.

The activation must bind the exact policy/source/evidence hashes, actor, substantive reason, backup reference/checksum, identity-audit reference/checksum, compliance reference, and sender-authentication reference. The UI requires the exact phrase `ACTIVATE CIM STAGE 2 CANARY`. A canary run separately requires `RUN CIM STAGE 2 CANARY` and can attempt at most one automatic initial per Pacific business day. It sends without per-opportunity approval. Do not activate unrestricted active mode or Stage 3 through this rollout.

## Rollback and incidents

On any readiness failure, provider call in shadow/off mode, duplicate or ambiguous outcome, missing decision evidence, source widening, cap/window violation, identity regression, complaint, bounce, opt-out, or unreviewed reply:

1. turn on the automation-only pause immediately;
2. turn on the central all-outreach pause only if manual or follow-up paths may also be affected;
3. keep inbound webhooks and reconciliation available;
4. preserve requests, communications, decisions, runs, provider identities, lifecycle events, and activations;
5. never retry an ambiguous provider outcome under a new identity;
6. run both audits in dry-run mode and retain count-only evidence;
7. roll application code back only when it remains compatible with the additive schema;
8. use an audited compensating action rather than destructive data reversal.
