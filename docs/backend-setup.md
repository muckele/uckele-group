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
- Secure upload request generation and a seller-facing upload page at `/secure-documents`
- Email engagement event tracking and follow-up triage via `/api/webhooks/resend`
- Acquisition Command Center for 75+ deals, active CIM conversations, pass reasons, source health, and diligence readiness
- Spam protection with honeypot, time-to-submit checks, rate limiting, message heuristics, and optional Cloudflare Turnstile
- Serverless support through [api/[...path].js](/Users/Matt/Documents/Uckele Group/api/[...path].js)

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

The private admin CRM includes a Deal Hunter scoring panel that can pull the SMB Deal Hunter Google Sheet CSV and the larger Airtable shared business list, score recent listings, and send the daily email.

Configure:

- `DEAL_HUNTER_EMAIL_RECIPIENT`
- `DEAL_HUNTER_SHEET_CSV_URL` or `DEAL_HUNTER_SHEET_CSV_URLS`
- `DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL`
- `DEAL_HUNTER_DAILY_EMAIL_ENABLED`
- `DEAL_HUNTER_DAILY_EMAIL_TIME`
- `DEAL_HUNTER_DAILY_EMAIL_TIMEZONE`
- `DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR` if you want to override the default durable send-marker directory
- `ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH` if you want to override where the source-health row-count snapshot is stored
- `DEAL_HUNTER_CRON_SECRET` if you also want to trigger the protected endpoint externally

Optional Airtable API mode:

- `DEAL_HUNTER_AIRTABLE_TOKEN` with `data.records:read`
- `DEAL_HUNTER_AIRTABLE_BASE_ID`
- `DEAL_HUNTER_AIRTABLE_TABLE_ID`
- `DEAL_HUNTER_AIRTABLE_VIEW_ID`

Use Airtable API mode for the larger business list in production. The unauthenticated shared-view payload is guarded by `DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES`; if Airtable returns an oversized JSON payload, the source is marked failed instead of crashing the daily email job. Google Sheet CSV imports are similarly capped by `DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES` and `DEAL_HUNTER_MAX_SOURCE_RECORDS` before records are normalized.

Admin endpoints:

- `GET /api/admin/deal-hunter/review`
- `POST /api/admin/deal-hunter/send`
- `POST /api/admin/deal-hunter/cim-request`
- `POST /api/admin/deal-hunter/cim-follow-ups/run`
- `GET /api/admin/acquisition-command-center`
- `POST /api/admin/acquisition-command-center/:id`

Read-only viewer access can be enabled for the SMB Deal Hunter team without granting write permissions:

- `ADMIN_VIEWER_EMAILS=person1@example.com,person2@example.com` allows magic-link viewer sign-in.
- `ADMIN_VIEWER_USERNAME` and `ADMIN_VIEWER_PASSWORD` allow password viewer sign-in when password auth is enabled.

Viewer sessions can load the protected CRM, Acquisition Command Center, Deal Hunter source review, and prospect discovery dashboard. They cannot create or edit CRM records, export CSVs, send daily emails, send CIM requests, run CIM follow-ups, run prospect discovery imports, create secure upload links, or update command-center feedback.

The production Fly machine runs the in-app scheduler once daily at the configured local time. The scheduler records successful Daily Deal Hunter sends in `email_events` and also writes a local send marker under the configured data directory, so a server restart does not resend the same day's email.

Optional external scheduler endpoint:

```text
POST /api/deal-hunter/daily-email
Authorization: Bearer DEAL_HUNTER_CRON_SECRET
```

The scoring profile treats management in place as preferred, not required. It flags food/beverage, hospitality, retail/ecommerce, SaaS/software, marketing, staffing, franchises, delivery routes, FedEx/Amazon route listings, and owner-license medical practices for removal from the next daily update. A 75+ score now requires hard evidence of recurring or repeat revenue, recession-resistant demand, AI-resistant field/regulated/relationship-heavy work, and a financeable size or multiple. Listings with owner-dependency, customer-concentration, project-based revenue, missing profit, or expensive valuation language are capped below high-fit status until the broker confirms the risk is manageable.

The send path imports every non-removal 75+ Deal Hunter listing into the protected CRM as a `deal-hunter-daily-review` record, including score notes, listing details, broker contact fields, strengths, concerns, questions, and structured metadata. Listing URL duplicate detection prevents the same deal from creating a new CRM card every day. The send path also records Deal Hunter listing history in `deal_hunter_seen_deals`, so future daily emails can identify newly seen matches instead of repeatedly treating the same source rows as new. Admin-only source reviews show the current new/seen status without marking listings as seen; sending the daily email marks that reviewed batch as seen after delivery succeeds.

The Acquisition Command Center is an admin-only view over CRM records that scored 75+ or have active acquisition conversation data. It groups records into New fit, CIM requested, Broker replied, Docs received, Diligence, LOI candidate, and Passed stages; provides one-click pass reasons; records good-fit or false-positive feedback under `contact_submissions.metadata.acquisitionCommand`; and flags source failures, row-count drops, and no-new-deal checks after the normal daily update window. Its diligence readiness score is weighted toward CIM/teaser receipt, real financial statements, valuation fit, seller financing, SBA fit, owner role, management depth, customer concentration, and recurring revenue quality.

### CIM Requests And Broker Follow-Ups

Deal Hunter deals scoring 75+ can be approved from the protected admin dashboard with the `Send CIM Request` button. Each request is stored in `deal_hunter_cim_requests`, including the broker email, provider message id, follow-up count, next follow-up date, and response status.

Automatic follow-ups are controlled by:

- `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=true`
- `DEAL_HUNTER_CIM_FOLLOW_UP_DELAYS_HOURS=48,72,168`
- `DEAL_HUNTER_CIM_FOLLOW_UP_MAX_COUNT=3`

The recommended cadence is three professional touches: first follow-up after 48 hours, second follow-up 72 hours later, and final follow-up 168 hours after that. The follow-up job checks for Resend inbound `email.received` webhook events before sending and stores them internally as replies. Configure the delivery provider webhook with `EMAIL_WEBHOOK_SECRET` or `RESEND_WEBHOOK_SECRET`; without inbound reply webhook events, the app can send due follow-ups but cannot automatically know when a broker responded. The job stops follow-ups on replies, bounces, complaints, failures, or unsubscribes.

### Diligence And Decisioning

The protected admin CRM includes a Phase 2 diligence panel on each record. It tracks diligence stage, internal decision, document checklist progress, financing structure, broker or seller questions, and a go/no-go memo.

This data is stored under `contact_submissions.metadata.diligence`, so it works with the existing SQLite and Supabase storage paths without an additional schema migration. The admin update endpoint only accepts a whitelisted diligence payload and merges it into the existing metadata object, preserving Deal Hunter source metadata and import history.

## Prospect Discovery And Import

The private admin CRM also includes a Prospect Discovery panel for finding local businesses through Google Places Text Search, saving each result, scoring it, tiering it, and optionally importing it as a CRM record.

Configure:

- `PROSPECT_DISCOVERY_ENABLED=true`
- `PROSPECT_DISCOVERY_PROVIDER=google-places`
- `GOOGLE_PLACES_API_KEY`
- `PROSPECT_DISCOVERY_QUERIES`, separated with `|`, for example `plumbers near New Rochelle NY|HVAC contractors near White Plains NY`
- `PROSPECT_DISCOVERY_AUTO_IMPORT=true` if discovered businesses should become CRM records automatically
- `PROSPECT_DISCOVERY_WEBSITE_CHECK_ENABLED=true` to run a lightweight homepage check for obvious conversion gaps
- `PROSPECT_DISCOVERY_WEBSITE_CHECK_TIMEOUT_MS=8000`
- `PROSPECT_DISCOVERY_WEBSITE_CHECK_MAX_BYTES=750000` to cap how much homepage HTML is inspected per business
- `PROSPECT_DISCOVERY_SCHEDULER_ENABLED=true` only after the manual admin run produces useful results

Lead tiers:

- `Tier A`: established local business signals with no dedicated website, a social/listing-only web presence, or a broken/unreachable website.
- `Tier B`: established business with a website that shows obvious conversion gaps such as missing HTTPS, thin SEO metadata, no contact form, no CTA, slow response, or an unusually large page.
- `Tier C`: established business with a real web presence that is better suited for ongoing SEO, reviews, tracking, website updates, and automation.
- `DNP`: do not prioritize. The result is saved for audit history but is not auto-imported into the CRM follow-up queue.

Admin endpoints:

- `GET /api/admin/prospect-discovery`
- `POST /api/admin/prospect-discovery/run`

The scheduler runs the configured queries on a long-running Node deployment. Keep it disabled on serverless deployments unless an external cron or background worker calls the discovery endpoint intentionally.

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

Formspree works for inbound lead routing, but it is not used for outbound admin magic-link emails or secure upload invite emails. For those, use Resend or keep password fallback enabled.

### EmailJS

Set:

- `DELIVERY_PROVIDER=emailjs`
- `EMAILJS_SERVICE_ID`
- `EMAILJS_TEMPLATE_ID`
- `EMAILJS_PUBLIC_KEY`
- `EMAILJS_PRIVATE_KEY` if your EmailJS account requires it

EmailJS can be used for both inbound lead notifications and the new outbound admin/upload messages, assuming your template accepts the provided generic email parameters.

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

Recommended for serverless deployments:

1. Set:
   - `STORAGE_PROVIDER=supabase`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Run the SQL in [schema.sql](/Users/Matt/Documents/Uckele Group/supabase/schema.sql)

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
- status updates
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
- `SECURE_DOCUMENTS_STORAGE_DIR`

Uploads are currently stored on the local filesystem under the configured secure documents directory. That is a good fit for local development or a single Node deployment. For serverless production, you should plan to swap file storage to object storage.

## Production Paths

You now have two deployment paths:

1. Node server:
   - `npm run build`
   - `npm start`

2. Serverless:
   - deploy the Vite frontend plus [api/[...path].js](/Users/Matt/Documents/Uckele Group/api/[...path].js)
   - use `STORAGE_PROVIDER=supabase`
   - configure the same environment variables in your platform
   - note that the current secure document implementation writes files to local disk, so for serverless production you should replace that storage path with object storage before launch
