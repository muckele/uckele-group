# CRM follow-up operations runbook

This runbook covers the human-reviewed Follow-ups Workspace, generic CRM email actions, optional OpenAI recommendation enrichment, inbound email history, and the boundary with Deal Hunter CIM outreach.

The implementation is deliberately fail-closed:

- `FOLLOW_UP_EMAIL_ENABLED=false` and `FOLLOW_UP_AI_ENABLED=false` are the defaults.
- Loading a queue, opening a record, generating a recommendation, editing a draft, or previewing an email cannot send anything.
- Only a full administrator can retrieve message bodies, generate enriched recommendations, preview, confirm, send, dismiss, suppress, or mutate workflow state. A viewer receives a body-free queue summary only.
- A send requires a fresh CRM version, server-side policy approval, server-generated final content, a unique confirmation token, a second exact-content confirmation, and one explicit send action.
- A provider acceptance is recorded as `accepted`; it is never presented as proof of delivery.
- Recommendations are decision support. Their persisted `sendAllowed` value is always false and they cannot bypass recipient, suppression, cadence, delivery, lifecycle, or concurrency checks.

## What changes and what does not

The Follow-ups Workspace replaces the former passive six-card follow-up slice with server-side pagination, search, views, sorting, stable totals, a chronological conversation drawer, deterministic recommendations, optional AI enrichment, a dedicated compose/reply flow, global suppressions, and a durable email outbox.

Existing Deal Hunter scoring, source selection, opportunity review, initial CIM request policy, and scheduled CIM cadence remain authoritative. The generic workspace reads linked Deal Hunter context; it does not recalculate Deal Hunter scores. When an administrator explicitly takes over a linked active CIM sequence, the server atomically stops the scheduled sequence, clears its next send, records the takeover, and creates one durable generic email command. If a scheduler has already claimed the CIM send, the manual action fails with a conflict and performs no provider work.

## Storage rollout

Back up the current data before applying a production migration.

For SQLite, the application creates additive tables, columns, and indexes on startup. Restart one application instance at a time, then review `/api/ready` and the Operations page before enabling either feature flag. Keep a verified application backup bundle and volume snapshot according to [sqlite-recovery.md](sqlite-recovery.md).

For an existing Supabase database, apply these migrations in order:

1. `supabase/migrations/20260809120000_crm_follow_up_workspace.sql`
2. `supabase/migrations/20260809123000_follow_up_queue_pagination.sql`

`supabase/schema.sql` is the fresh-database schema. The new outbox, recommendation, suppression, and communication fields remain server-role only. Row-level security is enabled; privileges are revoked from `public`, `anon`, and `authenticated`, and granted to `service_role` only. Do not place the Supabase service-role key in browser configuration.

The migration is additive. Rollback should disable flags and roll back application code first; do not drop the new tables during an incident. The records are the audit trail needed to reconcile commands and suppressions.

## Required configuration

Start from `.env.example`. Keep both flags off during migration and provider verification.

Generic email requires all of the following:

- `DELIVERY_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `RESEND_REPLY_TO`
- `RESEND_INBOUND_DOMAIN`
- `RESEND_WEBHOOK_SECRET` or `EMAIL_WEBHOOK_SECRET`
- `FOLLOW_UP_SENDER_EMAIL` matching the Resend From identity
- `FOLLOW_UP_REPLY_TO` matching the verified Resend reply address
- `FOLLOW_UP_REQUIRE_VERIFIED_REPLY=true` in production
- `FOLLOW_UP_REQUIRE_SIGNED_PREVIEW=true` (production validation rejects disabling it)
- `FOLLOW_UP_PHYSICAL_POSTAL_ADDRESS`
- `FOLLOW_UP_REPLY_OPT_OUT_ENABLED=true`, or an externally operated and verified `FOLLOW_UP_OPT_OUT_BASE_URL`
- an explicit, reviewed send window, timezone, daily cap, recipient rolling cap, touch limit, and cadence

The server rejects an enabled but incomplete configuration during startup. Operations also checks live suppression-store access and a verified inbound reply before reporting generic CRM email actions as safe.

AI enrichment is independent and optional. Enabling it requires:

- `FOLLOW_UP_AI_ENABLED=true`
- `FOLLOW_UP_AI_MODEL` set to a model approved for this workload
- `OPENAI_API_KEY`

The application uses the OpenAI Responses API with strict structured output, `store: false`, no tools, a bounded context, a timeout, and application-side Zod validation. Email bodies are labeled as untrusted quoted data; instructions within them must be ignored. Attachment contents are not sent or analyzed—only bounded attachment metadata is available. The model cannot change the deterministic action or safety result, recipients, headers, or send authorization.

`store: false` is an API request control, not a claim of zero data retention or Zero Data Retention eligibility. Confirm the organization’s current OpenAI data controls, approved model, contractual terms, and retention requirements separately before enabling AI with real CRM data. Do not log prompts, raw message bodies, API keys, or model responses outside the protected recommendation record.

## Resend sender, receiving, and webhook setup

Complete these steps in the provider dashboard before enabling generic email:

1. Add the outbound sender domain in Resend and publish the exact DNS records Resend supplies.
2. Wait until the provider reports the sending domain and DKIM records as verified.
3. Review SPF alignment for the envelope and visible From domain. Avoid publishing multiple conflicting SPF records.
4. Publish and monitor an appropriate DMARC record. Begin with a policy selected by the domain owner and email/compliance advisers, inspect aggregate reports, then strengthen the policy when legitimate traffic is aligned.
5. Configure the inbound receiving domain used by `RESEND_REPLY_TO`. Its domain must exactly match `RESEND_INBOUND_DOMAIN`.
6. Configure signed webhooks to the Operations-reported endpoint: `/api/webhooks/resend` on the public origin.
7. Subscribe to the delivery and receiving lifecycle used by the application, including delivered, delayed, bounced, complained, failed, and received/replied events as supported by the provider account.
8. Copy the webhook signing secret into `RESEND_WEBHOOK_SECRET` or `EMAIL_WEBHOOK_SECRET`.
9. From Operations, send the restricted administrator test email. Confirm the provider delivery event appears.
10. Reply to the test without changing its subject. Confirm Operations reports a verified inbound reply.

SPF, DKIM, and DMARC status is a manual readiness item. The application cannot prove current DNS or provider-domain state from environment variables and intentionally does not label that state verified. Review it in Resend Domains and with an independent DNS lookup before rollout and after DNS changes.

## Opt-out and legal review

The built-in v1 opt-out mechanism is a clearly worded email reply such as “unsubscribe” or “stop.” A verified inbound message with an obvious unquoted opt-out creates a global normalized-email suppression and stops further outreach. Complaints, hard bounces, provider suppressions, and administrator blocks also create global suppressions. Lifting a suppression requires full administrator access, explicit confirmation, and an audited reason.

`FOLLOW_UP_OPT_OUT_BASE_URL`, when present, is rendered as an external link. This repository does not turn that base URL into a recipient-specific signed one-click endpoint. Do not describe it as one-click or rely on it unless a separately operated endpoint has been security-reviewed, tested to create the same global suppression, and monitored. If message classification, jurisdiction, or sending scale requires one-click unsubscribe, keep generic email disabled until that endpoint and appropriate headers are implemented and verified.

Before real outreach, have qualified counsel or the responsible compliance owner classify the messages and review, at minimum:

- CAN-SPAM and other US federal requirements;
- applicable state privacy and marketing rules;
- CASL, UK PECR/GDPR, EU ePrivacy/GDPR, or other rules when recipients or senders bring those regimes into scope;
- whether a physical postal address, sender identification, opt-out timing, one-click unsubscribe, consent, or record-retention requirement applies;
- the company’s privacy notice, internal suppression handling, and escalation process.

The software provides technical controls and auditability; it does not determine legal classification or replace legal advice.

## Staged rollout

Use this sequence and stop whenever a check is not green:

1. Back up data and deploy the additive migration with both feature flags false.
2. Confirm the normal CRM and Deal Hunter pages, score behavior, current CIM workflow, secure documents, and `/api/ready` remain healthy.
3. Confirm the Follow-ups queue paginates beyond six records, viewer access is body-free, and full administrators can open an exact chronological history.
4. Configure and manually verify Resend outbound identity, inbound receiving, signed webhooks, SPF, DKIM, DMARC, From/Reply-To alignment, postal address, and the chosen opt-out mechanism.
5. Complete the restricted send-and-reply test from Operations. Reconcile delayed, bounce, complaint, and reply lifecycle states.
6. Review existing recipient data, legacy-content gaps, active suppressions, delivery issues, archived/completed records, and linked Deal Hunter sequences.
7. Enable `FOLLOW_UP_EMAIL_ENABLED=true` for a small administrator group with conservative caps. Keep `FOLLOW_UP_AI_ENABLED=false` initially.
8. Send only a few manually reviewed messages. Inspect every durable outbox result and provider event. Confirm that provider acceptance is not being mistaken for delivery and that replies stop outreach.
9. Review the 30-day Operations metrics: recommendation acceptance, draft edits, dismissals, delivery, bounce, reply, AI fallback, active suppressions, recent volume, and outbox failures.
10. Only after the deterministic workflow is stable, complete the OpenAI privacy/model review and optionally enable AI for bounded enrichment. Deliberately test provider failure and timeout; deterministic recommendations must remain usable.
11. Increase caps only through a reviewed configuration change. Never use an empty queue or low bounce count as the sole justification for expansion.

No step in this runbook authorizes an automatic mass send. The workspace always requires a human preview, exact final confirmation, and one explicit send action.

## Daily monitoring

Review Operations and the Follow-ups Workspace at least each business day while sending is enabled:

- queued or sending commands that remain beyond their lease window;
- every `ambiguous` command;
- retryable and permanent failures;
- accepted commands without a later delivery event after the expected provider interval;
- delayed, bounced, complained, or failed messages;
- unassigned inbound email and content-ingestion failures;
- new opt-outs and provider suppressions;
- recipient-level and daily-cap proximity;
- recommendation acceptance, edit, and dismissal rates;
- delivery, bounce, and reply rates;
- AI fallback/error rate when AI is enabled;
- unexpected changes in sender domain authentication or webhook health.

Metrics are aggregate counts and rates derived from durable outbox, lifecycle, recommendation, and suppression records. The Operations response does not include message bodies. Metrics with very small denominators are directional only; investigate underlying audited records before changing policy.

## Ambiguous-send incident procedure

An ambiguous state means the provider result could not be safely classified. It is not a retry instruction.

1. Disable `FOLLOW_UP_EMAIL_ENABLED` if more than one command is ambiguous or the cause may affect other sends.
2. Do not click send again and do not create a new client confirmation token for the same message.
3. Record the outbox ID, communication ID, timestamp, recipient, and provider correlation information from protected administrator views. Do not paste message bodies or credentials into general-purpose logs or chat.
4. Inspect the Resend activity for the durable idempotency key/provider message ID and determine whether the provider accepted the request.
5. Check signed webhook events and the CRM communication lifecycle.
6. If accepted, reconcile the durable command as accepted and wait for delivery lifecycle confirmation. If definitively rejected before acceptance, follow the reviewed recovery procedure; do not mutate immutable message content.
7. Document the decision and operator in the audit trail. Escalate complaints, unexpected recipients, or duplicate delivery immediately.
8. Re-enable sending only after the cause is understood and one restricted test send plus reply succeeds.

## Legacy history behavior

New inbound and outbound records persist exact plain-text content, sanitized outbound HTML, RFC Message-ID/In-Reply-To/References identity, participants, subject, timestamps, delivery/content lifecycle, safe attachment metadata, and assignment provenance.

Older records may have only metadata. The UI must display “exact legacy copy unavailable”; it must not reconstruct, fabricate, or imply an exact historical body. Attachments are displayed as metadata and require separate human review. Raw inbound HTML is never rendered in the workspace.

## Emergency pause and rollback

For a generic-email incident:

1. Set `FOLLOW_UP_EMAIL_ENABLED=false` and restart/redeploy using the normal secret/configuration process.
2. If AI data handling is in question, also set `FOLLOW_UP_AI_ENABLED=false` and rotate `OPENAI_API_KEY` if exposure is suspected.
3. Pause Deal Hunter CIM automation separately if the incident could affect scheduled CIM sends. Its control and flag are independent.
4. Reconcile all queued, sending, retryable, and ambiguous outbox records before re-enabling. Disabling the flag prevents new generic sends but does not erase the audit trail.
5. Keep the additive schema. Roll application code back only after confirming the older version tolerates the added columns/tables.
6. Preserve provider events, activity events, recommendations, suppressions, and outbox records for investigation.
7. Run the backend, UI, build, and smoke checks against the rollback candidate before deployment.

If confidentiality, recipient correctness, or suppression integrity is uncertain, keep sending disabled and escalate to the responsible security/compliance owner. Safety and reconciliation take priority over cadence.
