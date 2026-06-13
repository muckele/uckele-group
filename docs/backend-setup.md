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
- `DEAL_HUNTER_CRON_SECRET` if you also want to trigger the protected endpoint externally

Optional Airtable API mode:

- `DEAL_HUNTER_AIRTABLE_TOKEN` with `data.records:read`
- `DEAL_HUNTER_AIRTABLE_BASE_ID`
- `DEAL_HUNTER_AIRTABLE_TABLE_ID`
- `DEAL_HUNTER_AIRTABLE_VIEW_ID`

Use Airtable API mode for the larger business list in production. The unauthenticated shared-view payload is guarded by `DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES`; if Airtable returns an oversized JSON payload, the source is marked failed instead of crashing the daily email job.

Admin endpoints:

- `GET /api/admin/deal-hunter/review`
- `POST /api/admin/deal-hunter/send`

The production Fly machine runs the in-app scheduler once daily at the configured local time. The scheduler records successful Daily Deal Hunter sends in `email_events` and also writes a local send marker under the configured data directory, so a server restart does not resend the same day's email.

Optional external scheduler endpoint:

```text
POST /api/deal-hunter/daily-email
Authorization: Bearer DEAL_HUNTER_CRON_SECRET
```

The scoring profile treats management in place as preferred, not required. It flags food/beverage, hospitality, retail/ecommerce, SaaS/software, marketing, staffing, franchises, delivery routes, FedEx/Amazon route listings, and owner-license medical practices for removal from the next daily update.

The send path records Deal Hunter listing history in `deal_hunter_seen_deals`, so future daily emails can identify newly seen matches instead of repeatedly treating the same source rows as new. Admin-only source reviews show the current new/seen status without marking listings as seen; sending the daily email marks that reviewed batch as seen after delivery succeeds.

## Delivery Provider Options

### Resend

Set:

- `DELIVERY_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `LEAD_NOTIFICATION_EMAIL`
- `RESEND_WEBHOOK_SECRET` if you want open/click/bounce tracking in the admin CRM

Resend is the strongest fit if you want:

- inbound lead notifications
- admin magic-link sign-in
- secure document invite emails
- upload notifications
- email open/click/bounce events for follow-up triage

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

- `VITE_TURNSTILE_SITE_KEY`
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
