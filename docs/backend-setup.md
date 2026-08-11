# Backend Setup

## What This Adds

The site now includes:

- Backend form submission handling at `/api/contact`
- Configurable email delivery adapters for `resend`, `formspree`, `emailjs`, and `console`
- Optional CRM webhook forwarding
- Stored submissions
- Private admin CRM at `/admin`
- Email magic-link admin auth with optional password fallback
- Workflow fields for assignee, notes, tags, priority, follow-up state, and next action date
- Durable first-class CRM communication history for email, phone, meeting, text, and notes
- Separate CIM request, provider-delivery, reply, and follow-up lifecycle state with corrected-recipient retries
- Explicit archive/restore workflows and a separate permanent-delete action
- Secure upload request generation and a seller-facing upload page at `/secure-documents`
- Email engagement event tracking and follow-up triage via `/api/webhooks/resend`
- Acquisition Command Center for 75+ deals, active CIM conversations, pass reasons, source health, and diligence readiness
- Spam protection with honeypot, time-to-submit checks, rate limiting, message heuristics, and optional Cloudflare Turnstile

## Local Development

1. Copy `.env.example` to `.env`
2. Set at minimum:
   - `ADMIN_SESSION_SECRET`
   - `ADMIN_MAGIC_LINK_SECRET`
   - `SECURE_DOCUMENTS_TOKEN_SECRET`
   - `DELIVERY_PROVIDER`
3. Run:

```bash
npm run dev
```

This starts:

- Vite on `http://localhost:5173`
- The backend on `http://localhost:8787`

Vite proxies `/api/*` requests to the backend during development.

## Daily Deal Hunter Review

The private admin CRM includes a Deal Hunter scoring panel that can pull the SMB Deal Hunter Google Sheet CSV, accept a manually exported SMB Deal OS saved search or Deal Radar result, optionally retain the legacy Airtable source, score recent listings, and send the daily email.

Configure:

- `DEAL_HUNTER_EMAIL_RECIPIENT`
- `DEAL_HUNTER_SHEET_CSV_URL` or `DEAL_HUNTER_SHEET_CSV_URLS`
- `DEAL_HUNTER_AIRTABLE_ENABLED=false` to explicitly retire Airtable from the configured source set
- `DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL`
- `DEAL_HUNTER_DEAL_OS_EXPORT_MAX_PAYLOAD_BYTES` (default 8 MiB)
- `DEAL_HUNTER_DEAL_OS_EXPORT_MAX_RECORDS` (default and maximum 1,000)
- `DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS` (default 72 hours)
- `DEAL_HUNTER_DAILY_EMAIL_ENABLED`
- `DEAL_HUNTER_DAILY_EMAIL_TIME`
- `DEAL_HUNTER_DAILY_EMAIL_TIMEZONE`
- `DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR` if you want to override the default durable send-marker directory
- `ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH` if you want to override where the source-health row-count snapshot is stored
- `DEAL_HUNTER_CRON_SECRET` if you also want to trigger the protected endpoint externally

Airtable API mode (required when the shared-view export exceeds the payload limit):

- `DEAL_HUNTER_AIRTABLE_TOKEN` with `data.records:read`
- `DEAL_HUNTER_AIRTABLE_BASE_ID`
- `DEAL_HUNTER_AIRTABLE_TABLE_ID`
- `DEAL_HUNTER_AIRTABLE_VIEW_ID`

Use Airtable API mode only while the legacy source remains enabled. The unauthenticated shared-view payload is guarded by `DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES`; if Airtable returns an oversized JSON payload, the source is marked as needing setup instead of crashing the review. Google Sheet CSV imports are similarly capped by `DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES` and `DEAL_HUNTER_MAX_SOURCE_RECORDS` before records are normalized. When `DEAL_HUNTER_AIRTABLE_ENABLED=false`, no Airtable network request is made and the disabled source does not block the scheduler. The admin review and daily email explicitly warn that source coverage is limited.

### Manual SMB Deal OS export bridge

A full administrator can upload a `.csv` or `.xlsx` export under **Deal Hunter → Import SMB Deal OS export**. Viewer sessions cannot upload. The administrator must select `Saved search` or `Deal Radar filters`, describe the covered search/filter, record when the export was generated, and may enter the listing count shown by Deal OS. If an expected count is supplied, it must exactly match the file.

The importer requires every row to contain a business name and either a stable Deal OS/listing ID or a safe HTTP(S) View Listing URL. It normalizes listing identity, source, dates, business details, financial fields, and broker contacts; deduplicates repeated identities; and stores only allowlisted normalized fields plus file hash, size, type, coverage, export/import timestamps, and authenticated importer. The uploaded file and arbitrary spreadsheet columns are not retained. CSV must be valid UTF-8. XLSX formulas are never evaluated, external listing hyperlinks are extracted, compressed entries are bounded, and macro-enabled/legacy Excel formats are rejected.

An upload is rejected when it is empty, oversized, older than the configured freshness window, future-dated, structurally incompatible, over the configured row ceiling, missing durable identities, contains an unsafe listing URL, or disagrees with the administrator-supplied expected count. The accepted export becomes a first-class source in the existing scoring, history, CRM synchronization, and email workflow. Once its export timestamp exceeds `DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS`, that source becomes unavailable and the existing fail-closed source gate pauses new email/CRM/CIM activity until a fresh export is uploaded.

Exports at the 1,000-listing ceiling are accepted but prominently marked as potentially truncated. Source health records the covered search/filter, export and import timestamps, importer, age, expected/actual count, deduplication count, stable-ID count, link count, and cap warning.

If any configured source is unavailable, the admin shows a partial-review warning and pauses the daily review email, CRM synchronization, and new CIM outreach until every source passes a fresh review. Follow-ups for already-contacted deals remain governed separately by inbound-reply readiness.

Admin endpoints:

- `GET /api/admin/deal-hunter/review`
- `POST /api/admin/deal-hunter/deal-os-import` (full administrator only; raw CSV/XLSX body plus `X-Deal-OS-*` provenance headers)
- `POST /api/admin/deal-hunter/send`
- `POST /api/admin/deal-hunter/cim-request`
- `POST /api/admin/deal-hunter/cim-follow-ups/run`
- `GET /api/admin/acquisition-command-center`
- `POST /api/admin/acquisition-command-center/:id`

Read-only viewer access can be enabled for the SMB Deal Hunter team without granting write permissions:

- `ADMIN_VIEWER_EMAILS=person1@example.com,person2@example.com` allows magic-link viewer sign-in.
- `ADMIN_VIEWER_USERNAME` and `ADMIN_VIEWER_PASSWORD` allow password viewer sign-in when password auth is enabled.

Viewer sessions can load the protected CRM, Acquisition Command Center, and Deal Hunter source review. They cannot create or edit CRM records, export CSVs, send daily emails, send CIM requests, run CIM follow-ups, create secure upload links, or update command-center feedback.

The production Fly machine runs the in-app scheduler once daily at the configured local time. The scheduler records successful Daily Deal Hunter sends in `email_events` and also writes a local send marker under the configured data directory, so a server restart does not resend the same day's email.

Phase 15 also records an atomic daily job claim in `scheduled_job_runs`. Admin, in-process scheduler, and external cron triggers share the same date-keyed claim, preventing overlapping triggers from sending duplicate daily emails. Successful provider delivery uses a deterministic idempotency key, local delivery evidence is written before completion bookkeeping, and stale in-progress claims remain retryable.

Apply all committed Supabase migrations before deploying this version when `STORAGE_PROVIDER=supabase` is used. In particular, `20260806120000_crm_communications_lifecycle.sql` adds first-class communications, the expanded CIM lifecycle, Deal Hunter dispositions, and the atomic RPCs used by this release; `20260810130000_deal_os_exports.sql` adds the server-only normalized Deal OS import history. SQLite applies the equivalent additive migration automatically at startup; take and verify a backup before starting the upgraded process against production data.

Optional external scheduler endpoint:

```text
POST /api/deal-hunter/daily-email
Authorization: Bearer DEAL_HUNTER_CRON_SECRET
```

The scoring profile treats management in place as preferred, not required. It flags food/beverage, hospitality, retail/ecommerce, SaaS/software, marketing, staffing, franchises, delivery routes, FedEx/Amazon route listings, and owner-license medical practices for removal from the next daily update. A 75+ score now requires hard evidence of recurring or repeat revenue, recession-resistant demand, AI-resistant field/regulated/relationship-heavy work, and a financeable size or multiple. Listings with owner-dependency, customer-concentration, project-based revenue, missing profit, or expensive valuation language are capped below high-fit status until the broker confirms the risk is manageable.

The send path imports every non-removal 75+ Deal Hunter listing into the protected CRM as a `deal-hunter-daily-review` record, including score notes, listing details, broker contact fields, strengths, concerns, questions, and structured metadata. Listing URL duplicate detection prevents the same deal from creating a new CRM card every day. The send path also records Deal Hunter listing history in `deal_hunter_seen_deals`, so future daily emails can identify newly seen matches instead of repeatedly treating the same source rows as new. Admin-only source reviews show the current new/seen status without marking listings as seen; sending the daily email marks that reviewed batch as seen after delivery succeeds.

The Acquisition Command Center is an admin-only view over CRM records that scored 75+ or have active acquisition conversation data. It groups records into New fit, CIM requested, Broker replied, Docs received, Diligence, LOI candidate, and Passed stages; provides one-click pass reasons; records good-fit or false-positive feedback under `contact_submissions.metadata.acquisitionCommand`; and flags source failures, row-count drops, and no-new-deal checks after the normal daily update window. Its diligence readiness score is weighted toward CIM/teaser receipt, real financial statements, valuation fit, seller financing, SBA fit, owner role, management depth, customer concentration, and recurring revenue quality.

### CIM Requests And Broker Follow-Ups

Deal Hunter deals scoring 75+ can be approved from the protected admin dashboard with the `Send CIM Request` button. Each request is linked to a CRM record and keeps request, provider-delivery, reply, and follow-up state separately. The exact recipient, subject, text, HTML, reply alias, and idempotency key are persisted as a CRM communication before provider transmission. A failed first attempt can retry the same persisted copy; a delivery failure can use the separately confirmed corrected-recipient workflow without rewriting the original attempt. Live CIM initial and follow-up delivery requires `DELIVERY_PROVIDER=resend`, whose provider message IDs and idempotency keys make post-acceptance reconciliation safe. The console provider remains available for development-only verification. EmailJS remains available for ordinary application mail, but CIM outreach fails closed before the network because EmailJS does not provide the acceptance identity/idempotency boundary this workflow requires.

Automatic follow-ups are controlled by:

- `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=true`
- `DEAL_HUNTER_CIM_FOLLOW_UP_DELAYS_HOURS=48,72,96`
- `DEAL_HUNTER_CIM_FOLLOW_UP_MAX_COUNT=3`
- `DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY=true`
- `DEAL_HUNTER_CIM_FOLLOW_UP_TIMEZONE=America/Los_Angeles`

Initial CIM outreach uses a gated three-stage automation policy. Stage 1 is the production-safe default and requires administrator approval for every initial request. Stage 2 activates trusted-rule sends only after the configured minimum review history; Stage 3 additionally requires the configured review count and approval-rate threshold. Every higher-stage send creates and re-verifies a server-signed snapshot of the exact reviewed deal before persistence or transmission, and records the verified snapshot digest and automation stage on the durable request. Both higher stages retain daily and broker contact caps, source-health checks, suppression events, duplicate detection, and the Operations emergency pause.

- `DEAL_HUNTER_CIM_AUTOMATION_STAGE=1` (`1`, `2`, or `3`)
- `DEAL_HUNTER_CIM_AUTOMATION_PAUSED=false`
- `DEAL_HUNTER_CIM_STAGE2_MIN_REVIEWS=25`
- `DEAL_HUNTER_CIM_STAGE3_MIN_REVIEWS=50`
- `DEAL_HUNTER_CIM_STAGE3_MIN_APPROVAL_RATE=0.90`
- `DEAL_HUNTER_CIM_AUTOMATION_MIN_SCORE=90`
- `DEAL_HUNTER_CIM_AUTOMATION_DAILY_CAP=3`
- `DEAL_HUNTER_CIM_BROKER_30_DAY_CAP=3`
- `DEAL_HUNTER_CIM_AUTOMATION_MAX_PROFIT_MULTIPLE=4`

The production cadence is three persistent touches: first follow-up after 48 hours, second follow-up 72 hours later, and final follow-up 96 hours after that. With weekday-only delivery enabled, a follow-up that becomes due on Saturday or Sunday remains queued until the next scheduler check on a weekday in the configured timezone. The follow-up job checks for Resend inbound `email.received` webhook events before sending and stores them internally as replies. Configure the delivery provider webhook with `EMAIL_WEBHOOK_SECRET` or `RESEND_WEBHOOK_SECRET`; without inbound reply webhook events, the app can send due follow-ups but cannot automatically know when a broker responded. The job stops follow-ups on replies, bounces, complaints, failures, or unsubscribes.

For received mail, the signed webhook first creates a durable, replay-safe placeholder. The ingestion worker then uses the configured `RESEND_API_KEY` to retrieve the message text and attachment metadata from Resend's fixed receiving API endpoints. It does not download attachment content or retain provider attachment URLs, and inbound HTML is converted to plain text rather than trusted for rendering. A signed per-request reply alias wins over sender-email matching; otherwise sender matching assigns only when exactly one CRM record matches. Ambiguous mail remains in the admin-only unassigned inbox. Operations exposes counts and bounded failure status, never message bodies.

Archive is the normal way to close a CRM record. It stops linked CIM follow-ups, records a reason and actor, and remains reversible without restarting outreach. Permanent delete remains a distinct destructive action and should be reserved for retention/privacy requirements. Archive, Deal Hunter dismissal, and permanent delete all refuse to race a fresh CIM transmission lease; retry the lifecycle action after the in-flight attempt resolves or its bounded lease expires.

### Diligence And Decisioning

The protected admin CRM includes a Phase 2 diligence panel on each record. It tracks diligence stage, internal decision, document checklist progress, financing structure, broker or seller questions, and a go/no-go memo.

This data is stored under `contact_submissions.metadata.diligence`, so it works with the existing SQLite and Supabase storage paths without an additional schema migration. The admin update endpoint only accepts a whitelisted diligence payload and merges it into the existing metadata object, preserving Deal Hunter source metadata and import history.

## Delivery Provider Options

### Resend

Set:

- `DELIVERY_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `LEAD_NOTIFICATION_EMAIL`
- `RESEND_WEBHOOK_SECRET` if you want open/click/bounce/reply tracking in the admin CRM

Resend is the strongest fit if you want:

- inbound lead notifications
- admin magic-link sign-in
- secure document invite emails
- upload notifications
- email open/click/bounce/reply events for follow-up triage

Configure the Resend webhook URL as:

```text
https://your-domain.com/api/webhooks/resend
```

Use the Resend signing secret as `RESEND_WEBHOOK_SECRET`.

### Formspree

Set:

- `DELIVERY_PROVIDER=formspree`
- `FORMSPREE_ENDPOINT`

Use your Formspree endpoint in the format:

```text
https://formspree.io/f/your-form-id
```

Formspree works only for inbound lead routing. Production startup rejects it as the application-wide delivery provider because it cannot deliver admin magic links, Deal Hunter email, or secure upload invitations. Use Resend or EmailJS for the production application.

### EmailJS

Set:

- `DELIVERY_PROVIDER=emailjs`
- `EMAILJS_SERVICE_ID`
- `EMAILJS_TEMPLATE_ID`
- `EMAILJS_PUBLIC_KEY`
- `EMAILJS_PRIVATE_KEY` if your EmailJS account requires it

EmailJS can be used for both inbound lead notifications and outbound admin/upload messages, assuming your template accepts the provided generic email parameters. It is intentionally not eligible for CIM initial or follow-up outreach; use Resend for live CIM communications or the console provider for development-only verification.

## CRM Forwarding

If you want every inquiry forwarded to a CRM or automation platform, set:

- `CRM_WEBHOOK_URL`
- `CRM_WEBHOOK_SECRET` optionally

The backend will POST normalized lead JSON to that URL.

The CRM payload now includes:

- lead type
- priority
- source tags
- assignee
- follow-up state
- next action date
- freeform notes

## Storage Options

### SQLite

Default and works locally with no extra infrastructure:

- `STORAGE_PROVIDER=sqlite`

The database is created automatically under `./data`.

### Supabase

Available as an alternative managed database adapter:

1. Set:
   - `STORAGE_PROVIDER=supabase`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Run the SQL in [schema.sql](/Users/Matt/Documents/uckele-group/supabase/schema.sql), or apply every committed file under `supabase/migrations` in timestamp order.

## Dashboard

The private admin CRM is available at:

```text
/admin
```

Use:

- `ADMIN_AUTH_MODE`
- `ADMIN_EMAIL`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `ADMIN_MAGIC_LINK_SECRET`

The admin CRM supports:

- submission review
- paginated communication history with lifecycle badges and manual communication logging
- searchable CIM request history with each exact stored initial/follow-up email and safe retry actions
- an admin-only unassigned inbound communication inbox
- status updates
- archive and restore, with permanent delete kept separate
- assignee, notes, tags, priority, and reminder dates
- CSV export
- secure upload link generation
- basic lead metrics
- email engagement scoring and warm follow-up triage
- delivery visibility
- spam flag visibility

Recommended production mode:

- `ADMIN_AUTH_MODE=magic-link`

Recommended local mode:

- `ADMIN_AUTH_MODE=hybrid`

## Spam Protection

The backend always applies:

- hidden honeypot field
- minimum time-to-submit detection
- rate limiting
- suspicious-message heuristics

Optional Turnstile support:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

## Secure Documents

Secure document links are generated from the admin CRM per submission.

Required config:

- `SECURE_DOCUMENTS_TOKEN_SECRET`

Optional config:

- `SECURE_DOCUMENTS_REQUEST_TTL_MS`
- `SECURE_DOCUMENTS_MAX_UPLOAD_BYTES`
- `SECURE_DOCUMENTS_MAX_TOTAL_UPLOAD_BYTES`
- `SECURE_DOCUMENTS_MAX_CONCURRENT_UPLOADS`
- `SECURE_DOCUMENTS_STORAGE_DIR`

Uploads are stored on the local filesystem under the configured secure documents directory and require a persistent mounted volume.

CRM deletion first records a durable cleanup job, then stages document files under `.trash`. Startup and hourly reconciliation restores staged files if the CRM record still exists or purges them if deletion committed. Failed purges remain visible through `secure_document_cleanup_jobs` and are retried instead of being silently abandoned.

Admin mutations use append-only audit events. The API writes a `started` event before allowing a mutation and fails closed with `503` if that durable prewrite is unavailable; a second event records the final HTTP status and authenticated actor.

Production startup validates provider credentials, supported admin authentication modes, at least one usable admin sign-in path, secret separation, timezones and schedule times, and positive upload/rate-limit/TTL settings.

## Production Runtime

The supported production path is the long-running Node server deployed through the committed Fly configuration:

- `npm run build`
- `npm start`
- a persistent volume for SQLite and secure document files
- one app machine while SQLite and in-process schedulers are enabled
