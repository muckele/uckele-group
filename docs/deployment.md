# Deployment

This project is prepared to deploy to Fly.io with the custom domain:

`https://www.uckelegroup.com`

The Fly configuration is committed in [fly.toml](/Users/Matt/Documents/uckele-group/fly.toml) and uses:

- one app machine
- one mounted Fly volume at `/data`
- SQLite at `/data/uckele-group.sqlite`
- secure document storage at `/data/secure-documents`
- Node 22 in the Docker build/runtime image

Before launching, complete the production checklist in [production-readiness.md](/Users/Matt/Documents/uckele-group/docs/production-readiness.md).

Local builds require Node.js `20.19+` or `22.12+`. Run `nvm use` before local backend testing, then run `npm ci` or `npm run rebuild:native` after changing Node versions so the native SQLite dependency matches the active runtime.

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
  RESEND_REPLY_TO=mathew@uckelegroup.com \
  RESEND_WEBHOOK_SECRET=... \
  EMAIL_BRAND_COMPANY_NAME="Uckele Group" \
  ADMIN_AUTH_MODE=magic-link \
  ADMIN_EMAIL=mathew@uckelegroup.com \
  ADMIN_SESSION_SECRET=... \
  ADMIN_MAGIC_LINK_SECRET=... \
  SECURE_DOCUMENTS_TOKEN_SECRET=... \
  TURNSTILE_SECRET_KEY=...
```

Optional overrides:

```bash
fly secrets set \
  CRM_WEBHOOK_URL=... \
  CRM_WEBHOOK_SECRET=... \
  EMAIL_BRAND_MAILING_ADDRESS="Your business mailing address" \
  PUBLIC_SCHEDULING_URL="https://cal.com/your-username/15-minute-website-audit" \
  OUTREACH_AUTOMATION_ENABLED=false \
  OUTREACH_SCHEDULER_ENABLED=false \
  OUTREACH_SCHEDULER_INTERVAL_MS=900000 \
  OUTREACH_AUTO_SCHEDULE_AFTER_RESEARCH=false \
  OUTREACH_DAILY_SEND_LIMIT=25 \
  OUTREACH_CADENCE_DAYS=0,3,7,14 \
  OUTREACH_UNSUBSCRIBE_SECRET=... \
  DEFAULT_LEAD_ASSIGNEE="Mathew Uckele" \
  DEFAULT_FOLLOW_UP_DELAY_HOURS=24
```

If you enable Turnstile, add the public site key in [fly.toml](/Users/Matt/Documents/uckele-group/fly.toml) under `[build.args]` before deploying:

```toml
[build.args]
  VITE_TURNSTILE_SITE_KEY = "your-public-turnstile-site-key"
```

Hosted Cal.com booking links are also frontend build-time values. After creating the Cal.com event for a 15-minute website audit call, add the public booking URL to [fly.toml](/Users/Matt/Documents/uckele-group/fly.toml):

```toml
[build.args]
  VITE_PUBLIC_SCHEDULING_URL = "https://cal.com/your-username/15-minute-website-audit"
```

Redeploy after changing this value so the public booking CTAs are rebuilt with the new URL.

For email-generated booking links, also set `PUBLIC_SCHEDULING_URL` at runtime so generated outreach emails point to the same Cal.com event.

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
- Configure Resend webhooks to post email events to `/api/webhooks/resend`; use the same signing secret in `RESEND_WEBHOOK_SECRET`.

## Before Go-Live

- Confirm the contact form is delivering to `mathew@uckelegroup.com`
- Confirm the Cal.com booking CTA opens the correct 15-minute website audit event when `VITE_PUBLIC_SCHEDULING_URL` is configured
- Confirm `/admin` can view inbound audit requests, notes, follow-up state, uploaded document metadata, and email engagement
- Confirm automated research can run on a test CRM record and creates an audit, report, tier score, and outreach cadence
- Keep `OUTREACH_AUTOMATION_ENABLED=false` and `OUTREACH_SCHEDULER_ENABLED=false` until sending domain DNS, unsubscribe/suppression handling, cadence review, and daily limits have been reviewed
- Confirm `/privacy` and `/terms` are live and linked in the footer
- Confirm magic-link sign-in emails are being delivered
- Confirm Resend webhook events create email engagement records in the admin CRM
- Verify `/api/health` returns `200` on the Fly URL
- Confirm uploaded secure documents are written under the mounted volume
- Confirm `robots.txt` and `sitemap.xml` are live on `https://www.uckelegroup.com`
