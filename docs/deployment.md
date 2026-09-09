# Deployment

This project is prepared to deploy to Fly.io with the custom domain:

`https://www.uckelegroup.com`

The Fly configuration is committed in [fly.toml](/Users/Matt/Documents/uckele-group/fly.toml) and uses:

- one app machine
- one mounted Fly volume at `/data`
- SQLite at `/data/uckele-group.sqlite`
- secure document storage at `/data/secure-documents`
- verified application backup bundles at `/data/backups`
- Node 22 in the Docker build/runtime image

## Included Files

- [Dockerfile](/Users/Matt/Documents/uckele-group/Dockerfile)
- [fly.toml](/Users/Matt/Documents/uckele-group/fly.toml)
- [.dockerignore](/Users/Matt/Documents/uckele-group/.dockerignore)

## Production Secrets

Set these in Fly before the first deploy:

```bash
fly secrets set \
  DELIVERY_PROVIDER=resend \
  LEAD_NOTIFICATION_EMAIL='<configured internal address>' \
  RESEND_API_KEY=... \
  RESEND_FROM_EMAIL='<verified sender>' \
  RESEND_REPLY_TO='<configured reply address>' \
  RESEND_INBOUND_DOMAIN=replies.uckelegroup.com \
  RESEND_WEBHOOK_SECRET=... \
  EMAIL_BRAND_COMPANY_NAME="Uckele Group" \
  DEAL_HUNTER_EMAIL_RECIPIENT='<configured internal address>' \
  DEAL_HUNTER_SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/.../gviz/tq?tqx=out:csv&gid=..." \
  ADMIN_AUTH_MODE=magic-link \
  ADMIN_EMAIL='<configured administrator address>' \
  ADMIN_SESSION_SECRET=... \
  ADMIN_MAGIC_LINK_SECRET=... \
  SECURE_DOCUMENTS_TOKEN_SECRET=... \
  TURNSTILE_SITE_KEY=... \
  TURNSTILE_SECRET_KEY=...
```

Optional overrides:

```bash
fly secrets set \
  CRM_WEBHOOK_URL=... \
  CRM_WEBHOOK_SECRET=... \
  EMAIL_BRAND_MAILING_ADDRESS="Your business mailing address" \
  DEAL_HUNTER_CRON_SECRET=... \
  DEAL_HUNTER_DAILY_EMAIL_TIME=08:00 \
  DEAL_HUNTER_DAILY_EMAIL_TIMEZONE=America/Los_Angeles \
  DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR=/data/deal-hunter-daily-email \
  ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH=/data/acquisition-command-center-source-health.json \
  DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES=8388608 \
  DEAL_HUNTER_DEAL_OS_EXPORT_MAX_PAYLOAD_BYTES=8388608 \
  DEAL_HUNTER_DEAL_OS_EXPORT_MAX_RECORDS=1000 \
  DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS=72 \
  DEFAULT_LEAD_ASSIGNEE="Mathew Uckele" \
  DEFAULT_FOLLOW_UP_DELAY_HOURS=24
```

Google Sheets is the current required primary Deal Hunter source. Deal OS imports are optional supplemental data until the later Deal OS rollout. Airtable is retired: legacy `DEAL_HUNTER_AIRTABLE_*` variables are ignored and must not be added to new deployments.

If you enable Turnstile, configure the public site key and secret at runtime. The site key is browser-safe and is exposed through `/api/public-config`; the secret stays server-only:

```bash
fly secrets set \
  TURNSTILE_SITE_KEY=your-public-turnstile-site-key \
  TURNSTILE_SECRET_KEY=your-private-turnstile-secret
```

## First-Time Fly Setup

1. Install Fly CLI and log in.
2. Create the app if it does not already exist:

```bash
fly apps create uckele-group
```

3. Create the persistent volume in the same region defined in `fly.toml`:

```bash
fly volumes create uckele_group_data --region ewr --size 3
```

4. Set the production secrets.
5. Deploy:

```bash
fly deploy
```

## Custom Domain

After the first successful deploy:

```bash
fly certs add www.uckelegroup.com
fly certs add uckelegroup.com
```

Then update DNS:

- point `www.uckelegroup.com` to `uckele-group.fly.dev` with a `CNAME`
- point the apex `uckelegroup.com` to the Fly IPs shown by `fly ips list`

## Operational Notes

- Keep this app as a single machine while it uses local SQLite and the mounted `/data` volume.
- `ADMIN_AUTH_MODE=magic-link` is the recommended production mode.
- `/admin` is private and requires authentication.
- `/secure-documents` is token-protected and should remain unindexed.
- Turnstile should be enabled in production.
- Configure Resend webhooks to post `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, and `email.received` events to `/api/webhooks/resend`; store that webhook's signing secret in `RESEND_WEBHOOK_SECRET`.
- Configure a Resend receiving subdomain such as `replies.uckelegroup.com`, set `RESEND_INBOUND_DOMAIN` to that domain, and set `RESEND_REPLY_TO` to an address on it. Do not replace the root domain's existing MX records.
- Use `DELIVERY_PROVIDER=resend` for live CIM initial and follow-up outreach. EmailJS may still deliver ordinary application mail, but CIM sends intentionally fail closed before the network because that provider cannot supply the durable acceptance/idempotency proof required for safe retry.
- Keep `DEAL_HUNTER_CIM_OUTREACH_PAUSED=true` through the canonical-identity migration, dry-run audit, and any explicitly authorized repair. Keep `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=false` until the Operations email-readiness panel shows a verified inbound reply from the controlled test email. When enabling it, set the intended delay sequence, maximum count, weekday policy, timezone, business-hours start/end, and reviewed rolling recipient caps explicitly. The central pause covers manual sends as well as scheduled/automatic sends; `DEAL_HUNTER_CIM_AUTOMATION_PAUSED` does not.
- Apply every committed Supabase migration before deploying code when `STORAGE_PROVIDER=supabase` is enabled. Confirm that `20260806120000_crm_communications_lifecycle.sql`, `20260809120000_crm_follow_up_workspace.sql`, `20260809123000_follow_up_queue_pagination.sql`, `20260810120000_follow_up_ai_metrics.sql`, `20260810130000_deal_os_exports.sql`, `20260810143000_admin_onboarding_progress.sql`, and `20260812130000_cim_canonical_identity_safety.sql` complete successfully before starting the new application version.
- Keep `FOLLOW_UP_EMAIL_ENABLED=false` and `FOLLOW_UP_AI_ENABLED=false` through the schema rollout. AI startup validation requires an approved exact model/key project, explicit reasoning and request bounds, data-handling approval, accepted current eval version, cost/rate approval, and controlled synthetic-smoke evidence. Follow [follow-up-operations.md](/Users/Matt/Documents/uckele-group/docs/follow-up-operations.md) for the backup, provider, inbound-reply, suppression, compliance, AI evaluation, smoke, and restricted-canary checks required before either flag is enabled.
- Keep the secure document `.trash` directory on the persistent volume; startup and hourly cleanup reconciliation depend on it. Every file-mutating upload or deletion records a write-ahead cleanup intent before its first write or move. When database persistence cannot be confirmed, a private local `.reconciliation.json` sidecar preserves the intent until it can be imported safely; atomic temporary writes and directory syncing allow a valid intent to be recovered after abrupt process loss. Ambiguous mutations remain staged for the settlement window. A reconciler must then acquire the job's opaque, expiring lease token. The database clock renews a still-valid token before every filesystem mutation (including each file in a batch), and token-fenced state transitions reject expired leases. Reconciliation rejects paths outside the intent's exact operation directory, destinations inconsistent with the corresponding secure-document record, and filesystem or state changes from stale lease owners.
- Application-consistent SQLite backups run daily at `03:30 America/Los_Angeles`, retain 14 verified bundles/days by default, and are visible in the admin-only Operations page.
- Fly volume snapshots and application backup bundles are complementary. Follow [sqlite-recovery.md](/Users/Matt/Documents/uckele-group/docs/sqlite-recovery.md) for verification and restore drills.

### Required-source authority revalidation

Required-source authority revalidation is an exceptional administrator-only procedure for accepting a business-owner-confirmed, intentional reduction in the active/export-visible population of a configured required Google Sheet. It is not normal source review, a generic baseline setter, or a way to waive a source failure. Never lower the 70% guard and never edit the source-health JSON directly.

Before using `POST /api/admin/deal-hunter/source-authority/revalidate`, an authorized operator must:

1. obtain explicit business-owner confirmation that excluded rows are intentionally outside the active/export-visible population;
2. perform a fresh, read-only source review and record the current positive row count;
3. hash the exact current source-health snapshot bytes with SHA-256 and record its current authoritative row count;
4. obtain the safe server-computed source fingerprint for the configured required Sheet identity, without printing or copying the configured URL into the request; and
5. use an authenticated full-administrator session and submit only the exact expected fields.

For example, using synthetic counts and synthetic 64-character digests:

```json
{
  "sourceId": "sheet-0",
  "expectedPreviousRowCount": 1000,
  "expectedCurrentRowCount": 600,
  "expectedSnapshotSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedSourceFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "confirmation": "ACCEPT_REQUIRED_SOURCE_POPULATION_REDUCTION",
  "reasonCode": "business-confirmed-active-population-reset"
}
```

The service recomputes the configured-source fingerprint, hashes the exact current snapshot bytes before any live fetch or write, verifies the previous count, fetches the current source through the read-only Deal Hunter source path, and requires the observed count to equal the expected current count. It accepts only a valid required-primary Google Sheet whose sole target issue is the existing greater-than-30% row-count reduction. Unknown, retired, optional, unavailable, zero-row, parser-error, identity-mismatched, or already-healthy sources fail closed. Viewer and unauthenticated sessions cannot invoke it.

After validation, the service writes a unique no-overwrite backup of the exact old bytes beside the configured snapshot, verifies its SHA-256 and JSON, and only then performs a serialized same-directory atomic replacement. It rechecks the old snapshot SHA immediately before rename, preserves every unrelated source entry (including optional Deal OS authority), records one bounded latest revalidation provenance object plus source-health history evidence, reads the new snapshot back, and reruns source health. A stale SHA, changed fingerprint, changed count, backup failure, write failure, concurrent update, audit failure, or remaining required-source defect fails closed. The API response exposes only bounded identifiers, counts, digests, a backup identifier, time, reason, target-health result, and mutation-reconciliation state; it never exposes a source URL, snapshot contents, rows, credentials, recipients, or provider data.

Failures before replacement report `authorityState: "unchanged"`; they mean that request did not change authority. Once rename succeeds, a later failure reports one of `committed`, `restored`, or `indeterminate` together with `safeToRetry`, a stable recovery code, and bounded previous/candidate/observed hashes when available. If the response reports `committed`, do not retry: perform bounded readback/reconciliation against the supplied hashes. If it reports `indeterminate`, do not retry: inspect the current snapshot hash against the previous and candidate hashes and preserve the verified backup evidence. If it reports `restored`, confirm the old SHA before preparing a fresh authorized request after the underlying failure is resolved. Never directly edit the cache or delete backup evidence. Revalidation still does not authorize deployment or a manual Daily Digest.

After a successful revalidation, inspect the bounded audit/readback evidence and rerun the complete production preflight before making any separate release decision. This operation does not authorize deployment and must never trigger a manual Daily Digest, CIM/broker message, follow-up, Stage 2 action, scoring refresh, or CRM mutation.

## Before Go-Live

### Daily Deal Hunter Digest: authorized-release handoff

Task 5 is non-production evidence only. The historical/current-known baseline is Fly release 116, SQLite at `/data/uckele-group.sqlite`, and persistent `/data`; reverify all three during a separately authorized release and do not treat them as current assertions. Deploy only in a separately approved **pre-08:00 Pacific** window so the first natural scheduled result is the smoke. **DO NOT SEND A MANUAL TEST DAILY DIGEST AFTER DEPLOYMENT.** Do not manually trigger another same-date result to test delivery.

Immediately before an authorized deployment, verify the intended release SHA and production-base ancestry; rerun the complete Node v22.23.2 release suite; create and verify an application-consistent production SQLite backup; run SQLite integrity/`quick_check`; confirm persistent `/data`; confirm Daily Digest readiness; verify the server-owned recipient only as configured/valid plus a non-reversible fingerprint or suffix; confirm Resend and signed webhook readiness; confirm the durable marker path exists and is writable; prove exactly one `startDealHunterDailyEmailScheduler()` registration and no legacy/duplicate scheduler; and confirm source authority is healthy enough for the intended first result. Never print an address, secret, source key/private URL, session/token, claim token, prepared envelope, raw provider payload, or private broker/contact data.

The following are **MUST VERIFY DURING AUTHORIZED RELEASE**, both before and after deployment—not verified by Task 5:

- `cimOutreachPaused = true`
- `cimFollowUpEnabled = false`
- `cimAutomationStage = 1`
- `cimAutomationPaused = true`
- `cimAutomationSchedulerEnabled = false`

For the Phase 4 Daily Digest release, do not perform live CIM requests or sends, broker sends, Phase 3 follow-up transmissions, or Stage 2 execution/sends; do not lift the CIM outreach pause or enable follow-up automation. The first natural 08:00 Pacific Daily Digest result is the only email smoke, so do not send a second or manual Daily Digest message. Those broader workflows are outside this release check and require separate explicit authorization.

The release is **NO-GO** for any failed test/browser gate, unexpected dirty worktree, release/base mismatch, backup or SQLite integrity failure, non-unique/invalid recipient resolution, Resend or signed-webhook unreadiness, non-durable/unwritable marker path, multiple scheduler registrations, changed frozen safety value, unresolved current-date `transmitting`/`ambiguous` job, or unexpected unhealthy required source when a normal first result is intended. A known required-source problem may intentionally yield the approved `required-source-alert`; that is not permission to ignore an unexpected rollout blocker. An existing same-date completion is also a stop condition for using that date as the first-result smoke.

At the first natural 08:00 Pacific result, observe without creating another send:

1. correct Pacific calendar date and one `daily-deal-hunter-email:<date>` key;
2. exactly one current claim owner and exactly one result type, `normal-digest` or `required-source-alert`;
3. for an accepted result, exactly one provider identity, a matching completed `scheduled_job_runs` row, matching marker, and agreeing local/signed provider evidence;
4. repeated ordinary scheduler ticks produce no duplicate provider invocation;
5. Acquisition Inbox Morning Briefing and sanitized Operations state match durable authority; and
6. no CRM mutation, CIM request/send, broker-material send, Phase 3 follow-up send, or Stage 2 execution/send occurred, and all five frozen values remain unchanged.

For a normal result, confirm required source healthy, any optional warning bounded, trusted counts present, and no more than five existing-priority recommendations. For a required-source alert, confirm **ACTION REQUIRED**, no trusted counts/recommendations, persisted rows labeled last known, and protected mutations blocked by the server. If the result is `transmitting` or `ambiguous`, **STOP: do not retry transmission, delete the job, marker, or email events, or reset the date claim.** Reconcile only from the exact durable marker, local email event, signed/replay-safe Resend evidence, or bounded read-only provider lookup. One exact provider identity may complete; zero remains unresolved/ambiguous according to the window; multiple identities are high attention and must not resend. Favor a missed digest over a duplicate.

Rollback may revert only the approved application release or Daily Digest configuration. Preserve `scheduled_job_runs`, claim/state metadata, marker, `email_events`, provider evidence, the prepared-envelope/idempotency identity, and every ambiguity clue. Never “clean up” an ambiguous date by deleting it. Production GO remains conditional on the live checklist; the non-production conclusion is only **CODE READY FOR AUTHORIZED RELEASE CHECK**.

SQLite production must not receive the Supabase migration. If Supabase/PostgreSQL is deployed later, apply `20260904120000_daily_digest_scheduled_job_fencing.sql` through normal migration handling and verify `claim_scheduled_job` and `transition_scheduled_job` remain service-role-only. No table/column expansion is authorized.

### Broader-product go-live checks: outside Phase 4

The checklist below is not part of Phase 4 Daily Digest release verification. Any live CIM, follow-up, broker-outreach, or other broader-product transmission requires separate explicit authorization, must not be performed while validating the Phase 4 release, and must not require changing any of the five frozen Phase 4 safety values above.

- Confirm the contact form is delivering to the configured internal recipient without printing it
- Confirm `/admin` renders the bounded Morning Briefing and sanitized Operations authority; do not use the admin trigger as a production smoke
- Confirm no Airtable request is made and the admin/email label Airtable as retired
- In non-production with fake provider seams, confirm a healthy Google Sheet with no Deal OS import prepares a normal digest with a supplemental-data warning
- Upload controlled CSV and XLSX Deal OS fixtures as a full administrator; confirm viewer upload is denied, provenance/age/coverage appear in source health, duplicates collapse, and a stale export is excluded without blocking a Sheet-backed digest
- In non-production, make the Google Sheet CSV temporarily unavailable; confirm exactly one Pacific-date action-required alert is prepared through fake provider seams with no recommendations, CRM sync, CIM request, follow-up, or Stage 2 provider work, then restore access and verify source health
- With Resend configured, confirm `/admin` can send a controlled 75+ Deal Hunter CIM request and run the CIM follow-up check
- Confirm startup logs show exactly one `deal-hunter:scheduler` registration; observe only the first natural scheduled result after the configured Pacific time
- If an external scheduler is configured, verify its zero-payload request and `Authorization: Bearer DEAL_HUNTER_CRON_SECRET` configuration without invoking a second same-date production result
- Confirm the first accepted result creates one completed scheduled-job row, matching marker, and matching email/provider evidence without writing CRM or legacy seen-deal history
- Confirm magic-link sign-in emails are being delivered
- If SMB Deal Hunter viewer access is needed, configure `ADMIN_VIEWER_EMAILS` or `ADMIN_VIEWER_USERNAME` / `ADMIN_VIEWER_PASSWORD` and verify a viewer cannot save, export, send emails, or run imports
- Confirm Resend webhook events create email engagement records in the admin CRM
- Send a controlled inbound reply through the Resend receiving subdomain and confirm its plain-text body and attachment metadata appear once in CRM Communications; verify replaying the same webhook does not duplicate it
- Confirm ambiguous inbound mail appears only in the admin unassigned inbox and can be assigned to a searched CRM record
- Confirm Resend inbound `email.received` webhook events stop CIM follow-ups before enabling `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=true`
- Force a controlled bounce, confirm request and delivery state remain distinct, and verify corrected-recipient retry requires a different validated address or an explicit reasoned override
- Confirm archiving a CRM record stops linked CIM follow-ups, restoring it does not restart outreach, and permanent delete remains a separately confirmed action
- Confirm archive, dismissal, and permanent delete return a conflict instead of racing a fresh CIM transmission lease
- Confirm the CIM request history remains available after its source listing is removed or unavailable and reveals the exact stored initial/follow-up email copies
- Confirm weekend-due CIM follow-ups are deferred when `DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY=true`
- Confirm before-window, after-window, and weekend CIM follow-up runs return deferred without claiming or transmitting, and work remains eligible in the next configured window
- With central CIM outreach paused, confirm direct, bulk, automatic, scheduled, and admin-triggered follow-up paths perform no provider work while source review and inbound webhooks remain available
- Run `npm run cim:identity:audit`, review redacted exact/distinct/ambiguous groups, and follow [the CIM identity rollout and rollback runbook](cim-identity-incident-2026-08-12.md) before authorizing an apply or unpause
- With both generic follow-up flags still disabled, confirm the Follow-ups queue paginates, viewers receive only body-free summaries, administrators can open the exact chronology, and recommendation generation cannot send
- Verify `/api/health` returns `200` for process liveness and `/api/ready` returns `200` for storage and document-vault readiness on the Fly URL
- Confirm uploaded secure documents are written under the mounted volume
- Delete a staging CRM record with a secure document and confirm its `secure_document_cleanup_jobs` row reaches `completed`
- Confirm an authenticated admin mutation creates `started` and `completed` rows in `admin_audit_events`
- Confirm Operations shows a healthy SQLite `quick_check`, sufficient disk space, source and scheduler history, and a verified backup newer than 36 hours
- Run `npm run backup:verify` inside the deployed Machine and rehearse the latest bundle into `/tmp` before accepting confidential production files
- Confirm a stale CRM tab receives `409` and keeps its unsaved draft until the user reloads
- Confirm `robots.txt` and `sitemap.xml` are live on `https://www.uckelegroup.com`
