# Backend Setup

## What This Adds

The site now includes:

- Backend form submission handling at `/api/contact`
- Configurable email delivery adapters for `resend`, `formspree`, `emailjs`, and `console`
- Optional CRM webhook forwarding
- Stored submissions
- Private admin CRM at `/admin`
- Email magic-link admin auth with optional password fallback
- Admin auth rate limiting for password and magic-link requests
- Workflow fields for assignee, notes, tags, priority, follow-up state, and next action date
- Secure upload request generation and a seller-facing upload page at `/secure-documents`
- Admin-only Deal Hunter review for scoring daily SMB Deal Hunter Pro emails
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

## Delivery Provider Options

### Resend

Set:

- `DELIVERY_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `LEAD_NOTIFICATION_EMAIL`

Resend is the strongest fit if you want:

- inbound lead notifications
- admin magic-link sign-in
- secure document invite emails
- upload notifications

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
- `ADMIN_AUTH_RATE_LIMIT_WINDOW_MS`
- `ADMIN_AUTH_RATE_LIMIT_MAX`

If the app is deployed behind a trusted proxy that provides a canonical client-IP header, set:

- `TRUST_PROXY=true`

On Fly.io this uses `Fly-Client-IP` for rate limiting and Turnstile validation.

The admin CRM supports:

- submission review
- status updates
- assignee, notes, tags, priority, and reminder dates
- CSV export
- secure upload link generation
- basic lead metrics
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

## Deal Hunter

The private admin CRM includes a Deal Hunter panel for daily SMB Deal Hunter Pro emails and the SMB Deal Hunter Pro Google Sheet. Use `/admin` to import the latest sheet rows or paste email text manually, then score listings for:

- recession resistance
- AI resistance
- fit with the updated search criteria
- hard exclusions such as food, beverage, hospitality, restaurants, retail, SaaS, and online businesses
- broker and owner follow-up questions

Set:

- `DEAL_HUNTER_DIGEST_EMAIL`
- `DEAL_HUNTER_SHEET_URL`
- `DEAL_HUNTER_SHEET_CSV_URL`
- `DEAL_HUNTER_MINIMUM_QUALIFIED_SCORE`
- `DEAL_HUNTER_WATCH_SCORE`

`DEAL_HUNTER_SHEET_URL` is the human-facing Google Sheet link used from the admin dashboard. `DEAL_HUNTER_SHEET_CSV_URL` must point to the exact deal tab export URL for imports, for example:

```text
https://docs.google.com/spreadsheets/d/<sheet-id>/gviz/tq?tqx=out:csv&gid=<deal-tab-gid>
```

The SMB Deal Hunter Pro document's first tab may be a resource guide. Open the deal tab in Google Sheets, copy its `gid` from the browser URL, and use that `gid` in `DEAL_HUNTER_SHEET_CSV_URL`.

Optional inbound automation:

- `DEAL_HUNTER_WEBHOOK_SECRET`

When the webhook secret is set, an email-forwarding tool can POST the daily email body to `/api/deal-hunter/inbound` with the secret in `X-Deal-Hunter-Secret`. Viewing results remains admin-only.

The current scoring is deterministic and auditable. AI can be layered in later for narrative memo writing or deeper diligence prompts, but the first-pass score intentionally avoids sending deal data to a third-party model provider.

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
