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
- Secure upload request generation and a client onboarding upload page at `/secure-documents`
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

## Research And Audit Workflow

The private admin CRM is oriented around website audit requests, lead follow-up, secure onboarding files, and email engagement tracking. Manual prospect research and audit records should be saved to the CRM before any automated outreach cadence is enabled, so findings can be reviewed before they are used in client-facing emails.

Current backend support includes:

- inbound website audit requests through `/api/contact`
- private CRM records at `/admin`
- secure onboarding file requests through `/secure-documents`
- Resend webhook event tracking for opens, clicks, bounces, complaints, and unsubscribes
- durable storage for contact notes, follow-up state, tags, uploaded document metadata, and email events

The CRM API exposes production-facing field aliases such as `lead_source_url`, `service_interest`, `package_budget`, `partner_email`, and `primary_contact_email`. The underlying storage still keeps some older compatibility columns so existing records remain readable until a formal database migration is scheduled.

## Cal.com Scheduling Link

Use hosted Cal.com for prospect scheduling. Create an event such as `15-minute website audit call`, connect your calendar in Cal.com, then set:

```bash
PUBLIC_SCHEDULING_URL=https://cal.com/your-username/15-minute-website-audit
VITE_PUBLIC_SCHEDULING_URL=https://cal.com/your-username/15-minute-website-audit
```

When this value is present, the public site changes booking CTAs from the contact-form fallback to the Cal.com booking link. Because this is a Vite frontend variable, rebuild and redeploy after changing it.
The runtime `PUBLIC_SCHEDULING_URL` is used when generating personalized outreach emails.

## Prospect Automation

The CRM stores automated prospect work in durable tables:

- `research_runs`
- `prospect_audits`
- `generated_reports`
- `outreach_messages`
- `website_visits`
- `email_suppressions`

Admin endpoints:

- `POST /api/admin/submissions/:id/automation/run` runs website research for one CRM record, saves findings, creates a report, scores the prospect into Tier A-D, and generates a personalized outreach cadence.
- `POST /api/admin/submissions/:id/outreach/approve` moves reviewed draft outreach messages into the scheduled queue after compliance and research-quality checks pass.
- `POST /api/admin/outreach/send-due` sends due scheduled outreach messages only when `OUTREACH_AUTOMATION_ENABLED=true`.
- `POST /api/track/visit` records visits from tracked outreach links back to the CRM record.
- `GET|POST /unsubscribe/:token` suppresses a recipient from future outreach and blocks remaining draft/scheduled messages for that CRM record.

Recommended launch defaults:

```bash
OUTREACH_AUTOMATION_ENABLED=false
OUTREACH_SCHEDULER_ENABLED=false
OUTREACH_SCHEDULER_INTERVAL_MS=900000
OUTREACH_AUTO_SCHEDULE_AFTER_RESEARCH=false
OUTREACH_DAILY_SEND_LIMIT=25
OUTREACH_CADENCE_DAYS=0,3,7,14
OUTREACH_UNSUBSCRIBE_SECRET=replace-with-a-random-secret
```

Keep broad sending disabled until the sending domain, physical mailing address, unsubscribe/suppression process, and review workflow are ready.

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
