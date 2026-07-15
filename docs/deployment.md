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
  LEAD_NOTIFICATION_EMAIL=mathew@uckelegroup.com \
  RESEND_API_KEY=... \
  RESEND_FROM_EMAIL="Uckele Group <mathew@uckelegroup.com>" \
  RESEND_REPLY_TO=deals@replies.uckelegroup.com \
  RESEND_INBOUND_DOMAIN=replies.uckelegroup.com \
  RESEND_WEBHOOK_SECRET=... \
  EMAIL_BRAND_COMPANY_NAME="Uckele Group" \
  DEAL_HUNTER_EMAIL_RECIPIENT=mathew@uckelegroup.com \
  DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL="https://airtable.com/appEGxhjno0HTpEco/shrUhtbnzZTPaR4Lk/tblACIQ9QNiVmoWSK?viewControls=on" \
  DEAL_HUNTER_AIRTABLE_TOKEN=... \
  DEAL_HUNTER_SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/.../gviz/tq?tqx=out:csv&gid=..." \
  ADMIN_AUTH_MODE=magic-link \
  ADMIN_EMAIL=mathew@uckelegroup.com \
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
  DEAL_HUNTER_DAILY_EMAIL_TIME=10:15 \
  DEAL_HUNTER_DAILY_EMAIL_TIMEZONE=America/Los_Angeles \
  DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR=/data/deal-hunter-daily-email \
  ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH=/data/acquisition-command-center-source-health.json \
  DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES=8388608 \
  DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES=12582912 \
  DEAL_HUNTER_AIRTABLE_BASE_ID=appEGxhjno0HTpEco \
  DEAL_HUNTER_AIRTABLE_TABLE_ID=tblACIQ9QNiVmoWSK \
  DEAL_HUNTER_AIRTABLE_VIEW_ID=viw4OORhKKWPUsWa4 \
  DEFAULT_LEAD_ASSIGNEE="Mathew Uckele" \
  DEFAULT_FOLLOW_UP_DELAY_HOURS=24
```

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
- Keep `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=false` until the Operations email-readiness panel shows a verified inbound reply from the controlled test email. When enabling it, set the intended delay sequence, maximum count, weekday policy, and timezone explicitly.
- Apply every committed Supabase migration before deploying code when `STORAGE_PROVIDER=supabase` is enabled.
- Keep the secure document `.trash` directory on the persistent volume; startup and hourly cleanup reconciliation depend on it. Every file-mutating upload or deletion records a write-ahead cleanup intent before its first write or move. When database persistence cannot be confirmed, a private local `.reconciliation.json` sidecar preserves the intent until it can be imported safely; atomic temporary writes and directory syncing allow a valid intent to be recovered after abrupt process loss. Ambiguous mutations remain staged for the settlement window. A reconciler must then acquire the job's opaque, expiring lease token. The database clock renews a still-valid token before every filesystem mutation (including each file in a batch), and token-fenced state transitions reject expired leases. Reconciliation rejects paths outside the intent's exact operation directory, destinations inconsistent with the corresponding secure-document record, and filesystem or state changes from stale lease owners.
- Application-consistent SQLite backups run daily at `03:30 America/Los_Angeles`, retain 14 verified bundles/days by default, and are visible in the admin-only Operations page.
- Fly volume snapshots and application backup bundles are complementary. Follow [sqlite-recovery.md](/Users/Matt/Documents/uckele-group/docs/sqlite-recovery.md) for verification and restore drills.

## Before Go-Live

- Confirm the contact form is delivering to `mathew@uckelegroup.com`
- Confirm `/admin` can run Deal Hunter scoring and send the daily email
- Confirm `/admin` can send a 75+ Deal Hunter CIM request and run the CIM follow-up check
- Confirm the in-app scheduler logs `deal-hunter:scheduler` startup and sends after the configured Pacific time
- If using an external scheduler, confirm it posts to `/api/deal-hunter/daily-email` with `Authorization: Bearer DEAL_HUNTER_CRON_SECRET`
- Confirm the first successful daily email creates Deal Hunter history rows so later emails can separate newly seen matches from already reviewed listings
- Confirm magic-link sign-in emails are being delivered
- If SMB Deal Hunter viewer access is needed, configure `ADMIN_VIEWER_EMAILS` or `ADMIN_VIEWER_USERNAME` / `ADMIN_VIEWER_PASSWORD` and verify a viewer cannot save, export, send emails, or run imports
- Confirm Resend webhook events create email engagement records in the admin CRM
- Confirm Resend inbound `email.received` webhook events stop CIM follow-ups before enabling `DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=true`
- Confirm weekend-due CIM follow-ups are deferred when `DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY=true`
- Verify `/api/health` returns `200` for process liveness and `/api/ready` returns `200` for storage and document-vault readiness on the Fly URL
- Confirm uploaded secure documents are written under the mounted volume
- Delete a staging CRM record with a secure document and confirm its `secure_document_cleanup_jobs` row reaches `completed`
- Confirm an authenticated admin mutation creates `started` and `completed` rows in `admin_audit_events`
- Confirm Operations shows a healthy SQLite `quick_check`, sufficient disk space, source and scheduler history, and a verified backup newer than 36 hours
- Run `npm run backup:verify` inside the deployed Machine and rehearse the latest bundle into `/tmp` before accepting confidential production files
- Confirm a stale CRM tab receives `409` and keeps its unsaved draft until the user reloads
- Confirm `robots.txt` and `sitemap.xml` are live on `https://www.uckelegroup.com`
