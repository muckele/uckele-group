# CIM Stage 2 pre-canary readiness checkpoint — 2026-08-13

**Disposition: BLOCKED AT HUMAN/OWNER CHECKPOINT. No canary decision is requested or authorized.**

This is a count-only, redacted checkpoint for the guarded CIM Automation Stage 2 rollout. It is not legal advice. It records what is observable now, distinguishes current technical evidence from packet-fresh evidence that must be created later, and stops before activation.

## Release and control identity

- Production app: `uckele-group`
- Fly release: `v100` (`complete`, one machine healthy, one of one checks passing)
- Deployed implementation commit: `d4017bf5570bf9416369cceafee06d2d0f119401`
- Base reviewed commit: `f7dcf59ef8f3c1dabe80a8ab887685c1c7322bba`
- Branch: `codex/cim-stage2-evidence-readiness`
- Image: `registry.fly.io/uckele-group:deployment-01KZWMM2C0V7HNKX5W09F1B7NX`
- Image manifest: `sha256:07f1750b6b56a48b4ab6ab7da323e9a20f356ce0f5ed229675373505d12ce52d`
- Post-deploy readiness: HTTP 200; configuration, storage, CIM Stage 2 storage, and document vault all `ok`
- Protected review endpoint check: HTTP 401 without an authenticated administrator
- Runtime controls rechecked after deploy: configured stage `1`; automation-only pause `true`; Stage 2 scheduler `false`; CIM follow-ups `false`; central/manual outreach pause `false`

No Fly configuration or database schema was changed. No review decision, activation, canary, active run, mail-provider call, or automatic initial communication was created by this phase.

## Evidence bindings

Observed at `2026-08-13T04:05:56.625Z`:

| Binding | Observed value |
| --- | --- |
| Rule version | `cim-stage2-trusted-rules-v2` |
| Policy hash | `6b2d2bd0bad92c566f01972e46c0accd772f547497109eba42fd1702c7fcc93a` |
| Source-policy version | `cim-stage2-smb-sheet-only-v1` |
| Source-policy hash | `d61dda19712b2d92bece72b8a8916d386533f76fae8ae1cc532f2eaaf7cc1ee4` |
| Evidence version | `cim-stage2-human-evidence-v2` |
| Deterministic queue version | `cim-stage2-deterministic-review-queue-v1` |
| Current evidence checksum | `5145964061b39e691b65c552ef5ea6c3fff837c9fec757dac8575c4ab4d5208a` |
| Allowed Stage 2 source | exactly `sheet-0` |

## Every runtime readiness gate

The production count-only audit was generated at `2026-08-13T04:04:32.124Z`. A blocked activation gate is expected before a separate release-owner decision and must not be bypassed.

| Gate | Observed | Required | State |
| --- | --- | --- | --- |
| Stage 2 storage | available; no missing tables or review columns | available | PASS |
| Canonical human reviews | 9 genuine canonical decisions; 16 remaining | 25 | BLOCK |
| Eligible-cohort reviews | 0 current-policy eligible-cohort decisions | 10 | BLOCK |
| Unchanged-recipient approval | 0 unchanged approvals; reported rate 0% with no eligible-cohort denominator yet | at least 95% of the full eligible cohort | BLOCK |
| Cohort identity quality | 0 identity problems | 0 | PASS |
| Identity health | storage healthy; 0 unresolved exceptions, duplicate active sequences, missing links, or linkage mismatches | all zero and storage healthy | PASS |
| Adverse-event health | 0 adverse automatic initials; 0 explicit opt-outs | both zero | PASS |
| Provider reconciliation | 0 unresolved ambiguous decisions | 0 | PASS |
| Reply readiness | true | true | PASS |
| Suppression readiness | true | true | PASS |
| Sender configuration | true at the runtime configuration gate | true | PASS; attributable owner evidence remains missing below |
| Compliance/copy configuration | postal address absent; reply opt-out disabled; classification/copy acceptance absent | all present and accepted | BLOCK |
| Sender authentication | SPF/DKIM attestation absent; DMARC review absent | both explicitly attested | BLOCK |
| Source-policy configuration | `[sheet-0]` | `[sheet-0]` | PASS |
| Authoritative caps | canary/day 1; active/day 3; recipient/24h 1; recipient/30d 4 | canary/day 1; recipient/24h 1; recipient/30d 4 | PASS |
| Current runtime shadow evidence | completed `2026-08-13T03:06:33.124Z`; source-policy healthy | fresh, complete, policy-matching shadow | PASS at runtime; not the later packet-fresh shadow |
| Follow-ups disabled | false/enabled flag is off | false | PASS |
| Activation record | none; mode `off` | current durable activation | BLOCK AS REQUIRED |
| Activation mode | `off` | canary or active | BLOCK AS REQUIRED |
| Activation freshness | no expiry/activation | within 168 hours | BLOCK AS REQUIRED |
| Activation policy hash | none accepted | current policy hash | BLOCK AS REQUIRED |
| Activation evidence | none accepted | current evidence checksum | BLOCK AS REQUIRED |
| Activation backup | no backup bound to activation | verified reference and checksum | BLOCK |
| Activation identity audit | no audit bound to activation | dry-run reference and checksum | BLOCK |
| Central/manual outreach pause | false | false | PASS; unchanged |
| Automation-only pause | true | false for live authorization | BLOCK AS REQUIRED; must remain true during this phase |
| Operating window | outside the Pacific weekday window at audit time | 08:00–17:00 America/Los_Angeles, weekdays | BLOCK at audit time |
| Daily capacity | 0 used | less than active cap 3 | PASS |

Configured, evidence, and effective stages are all `1`; activation mode is `off`; `automaticTransmissionAllowed=false`.

## Human-review checkpoint

| Review evidence | Observed | Required | Remaining action |
| --- | --- | --- | --- |
| Latest genuine canonical human decisions | 9, all legacy/unversioned | 25 | 16 additional genuine per-opportunity decisions |
| Current-policy-compatible decisions | 0 | current evidence/rule/source bindings | use only the protected zero-send queue |
| Current-policy eligible-cohort decisions | 0 | at least 10 | at least 10 of the authentic new reviews must naturally fall in the eligible cohort |
| Eligible-cohort unchanged approvals | 0 | at least 95% of all eligible-cohort outcomes | retain every approve, edit, and reject outcome; do not select or coach for approvals |
| Eligible-cohort identity problems | 0 | 0 | any duplicate/recipient rejection or edit requires review and keeps readiness blocked |

Only an authenticated human administrator may take the per-opportunity actions in the protected Operations queue. The administrator must review the presented fixed-order candidate, Sheet source, original listing, canonical identity, and exact original/final recipient evidence, then record the actual approve-unchanged, approve-with-edit, or reject result. Codex did not load protected candidate detail or submit a decision.

Meeting 25 total, 10 eligible-cohort, and 95% unchanged-recipient quality does not authorize a canary. Every other gate and the separate release-owner decision remain mandatory.

## Compliance and sender evidence checkpoint

No item below has an attributable owner reference yet. Runtime booleans or empty hashes are not self-attestation.

| Required evidence | Current reference | Required owner/action |
| --- | --- | --- |
| Physical postal address in exact automatic text and HTML | not supplied | compliance owner accepts the exact address and copy/version |
| Reply-based `unsubscribe`/`stop` behavior and suppression before later outreach | not supplied; reply opt-out configuration is currently false | compliance/product owner supplies acceptance and operational evidence |
| Communication classification | not supplied | compliance owner supplies explicit, attributable scope acceptance |
| Exact automatic text and HTML copy | not supplied | compliance owner accepts the deployed copy/version or checksum |
| Accurate Resend From configuration and actual From domain | runtime configuration gate passes; owner reference not supplied | domain/email administrator supplies the exact controlled reference |
| Accurate Reply-To and monitored signed inbound route | runtime reply gate passes; owner reference not supplied | domain/email administrator supplies the exact controlled reference |
| SPF/DKIM for the actual From domain | not supplied | domain/email administrator supplies current provider/domain verification |
| DMARC policy/alignment review for the actual From domain | not supplied | domain/email administrator supplies dated review evidence |

## Backup, identity audit, and shadow references

- Pre-canary packet backup: **not created—authentic human-review and attestation gates are still blocked**. Reference/checksum: not applicable.
- Current read-only identity dry-run reference: production count-only audit at `2026-08-13T04:04:41.548Z`; evidence version `cim-opportunity-v1`; checksum `34d4cbb748183871b1274651f2c39d8c2ea83d6b60d4cef79aa1b8d60194020`.
- Identity counts: 10 requests; 9 canonical request groups; 251 stored canonical opportunities in Stage 2 status; 0 ambiguous pairs; 0 duplicate active sequences; 0 duplicate CRM-submission groups; 0 missing opportunity links; 0 safely repairable request links; 0 linkage mismatches. One historical recipient-cap excess/deferral remains the expected baseline.
- Packet-fresh post-threshold identity audit: **not run**. The current audit is a safe baseline, not the later packet-bound audit.
- Existing verified shadow: run `331399b4-85dd-4eec-92e5-c330aac01f1b`; completed `2026-08-13T03:06:33.124Z`; 8 considered, 0 eligible, 0 would-send, 0 attempted, 0 accepted, 0 failed, 0 ambiguous, 0 deferred; `providerCalls=0`; complete `sheet-0` coverage with 0 unexpected, missing, failed, empty, duplicate, or warning sources.
- Exactly-one packet-fresh post-threshold shadow: **not run**. It may be run only after the authentic review thresholds and all attributable attestations actually exist.
- Canary/active runs: none. Automatic initial communications: 0. New automatic transmissions in this phase: 0.

## Verification and reviews

- Two explicit code-review passes completed. The first closed legacy-evidence compatibility, queue pagination/digest, and bounded-lookup issues. The second added current-source revalidation before persistence and a deterministic exact-snapshot evidence ID for refresh-race safety.
- Backend: 427 tests passed under verified Node `v22.23.2` with serial execution.
- UI: 20 files, 106 tests passed.
- Browser: 10 Playwright tests passed.
- Focused authentication/privacy/storage/human-review checks: 10 passed.
- Lint: passed with zero warnings.
- Production build/prerender: passed; 1,640 modules and 9 public routes.
- Synthetic follow-up safety evaluation: 51 deterministic and 24 adapter-fault cases passed; no live comparisons.
- Image build production dependency audit: 0 vulnerabilities.

## Remaining blockers and exact safe next action

1. An authenticated human administrator must record 16 additional genuine decisions in the protected fixed-order queue. The eventual evidence must include at least 10 current-policy eligible-cohort outcomes and an unchanged-recipient approval rate of at least 95%, without discarding rejects/edits or selecting likely approvals.
2. The compliance owner must supply attributable postal-address, reply-opt-out, classification, and exact-copy acceptance references.
3. The domain/email administrator must supply attributable From, Reply-To, SPF/DKIM, and DMARC references for the actual From domain.
4. Only after items 1–3 genuinely pass: create and verify one fresh production backup, run a packet-fresh count-only identity dry-run, and run exactly one fresh zero-send shadow. Bind their references/checksums to a new readiness packet and confirm `providerCalls=0` with complete `sheet-0` coverage.
5. Re-audit every gate. If the packet is complete, stop and ask the release owner for a separate explicit canary-activation decision.

Until then, preserve Stage 1, activation `off`, the automation-only pause `true`, the Stage 2 scheduler and follow-ups disabled, the central/manual pause `false`, `automaticTransmissionAllowed=false`, and zero new automatic initial communications.
