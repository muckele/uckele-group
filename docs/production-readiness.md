# Production Readiness Checklist

Use this checklist before turning the app into the live online presence CRM and outreach system.

## 1. Runtime And Build

- Use Node.js `20.19+` or `22.12+`; the local shell was previously on `20.11.0`, which is too old for the current Vite version.
- Run `nvm use` from the repo root before local backend testing; `.nvmrc` pins local work to Node `22`.
- After switching Node versions, run `npm ci` or `npm run rebuild:native` so `better-sqlite3` is compiled for the active Node runtime.
- Run `npm run build` before each deploy.
- Confirm `/api/health` returns `200` after deploy.

## 2. Database Choice

Fastest launch path:

- Keep `STORAGE_PROVIDER=sqlite`.
- Keep the Fly volume mounted at `/data`.
- Back up `/data/uckele-group.sqlite` and `/data/secure-documents` before major deploys.

Stronger scale path:

- Move to Supabase/Postgres before high-volume outreach.
- Keep the compatibility fields in place until existing CRM records are migrated.
- Preserve clean API aliases such as `service_interest`, `partner_email`, and `primary_contact_email` at the app boundary.

## 3. Required Secrets

Set these in production:

- `PUBLIC_SITE_URL`
- `DELIVERY_PROVIDER=resend`
- `LEAD_NOTIFICATION_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `RESEND_REPLY_TO`
- `RESEND_WEBHOOK_SECRET`
- `ADMIN_AUTH_MODE=magic-link`
- `ADMIN_EMAIL`
- `ADMIN_SESSION_SECRET`
- `ADMIN_MAGIC_LINK_SECRET`
- `SECURE_DOCUMENTS_TOKEN_SECRET`
- `TURNSTILE_SECRET_KEY`
- `VITE_TURNSTILE_SITE_KEY`
- `EMAIL_BRAND_COMPANY_NAME`
- `EMAIL_BRAND_MAILING_ADDRESS`

Do not deploy with placeholder secrets from `.env.example`.

## 4. Email Sending And Compliance Gates

Before any automated outreach cadence is enabled:

- Verify the sending domain in Resend.
- Configure DNS for SPF, DKIM, and DMARC.
- Prefer a dedicated sending subdomain, such as `mail.uckelegroup.com` or `updates.uckelegroup.com`.
- Configure Resend open/click tracking only after the privacy page is live.
- Include a valid physical mailing address in marketing emails.
- Include a visible unsubscribe or opt-out path in every marketing email.
- Honor opt-out requests before any future cadence sends to the same recipient.
- Keep subject lines and sender details accurate.
- Avoid deceptive reply-style subject lines unless the message is an actual reply.
- Keep Gmail spam rates below the current sender guideline threshold.

References:

- FTC CAN-SPAM business guide: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- Gmail sender guidelines: https://support.google.com/mail/answer/81126
- Resend domain setup: https://resend.com/docs/dashboard/domains/introduction

## 5. Public Site Gates

- Homepage explains online presence management, not business acquisition.
- Contact form requires business name, website URL, service interest, timeline, and audit context.
- Hosted Cal.com event is created and `VITE_PUBLIC_SCHEDULING_URL` points to the public 15-minute audit call booking page.
- `/privacy` and `/terms` are live and linked in the footer.
- `/admin`, `/api`, and `/secure-documents` remain blocked in `robots.txt`.
- `sitemap.xml` includes the public marketing pages, privacy page, and terms page.

## 6. CRM Gates

- Inbound audit request creates a CRM record.
- Manual prospect/client record creation works.
- Record edits save clean fields such as service interest, package/budget, partner, and primary contact.
- Follow-up state, next action date, notes, tags, and assignee persist.
- Email engagement appears after Resend webhook events.
- Secure upload requests create tokenized links and uploaded document metadata appears on the CRM record.

## 7. Outreach Automation Gates

Do not automate broad sending until these are complete:

- Research/audit run storage is durable and reviewable in the CRM.
- Each prospect has a saved website audit or research summary.
- Personalization snippets are generated from saved research, not guessed at send time.
- Suppression list or unsubscribe table is implemented.
- Unsubscribe links are signed, included in every outreach email, and exposed through `List-Unsubscribe` headers.
- Draft cadences require admin approval before they become scheduled.
- Cadence rules stop automatically after reply, unsubscribe, bounce, or manual archive.
- Daily send limits are conservative while the domain warms up.
- Background sending stays disabled until `OUTREACH_AUTOMATION_ENABLED=true` and `OUTREACH_SCHEDULER_ENABLED=true`.
- Every sent email is logged with recipient, subject, send time, cadence step, provider message ID, and CRM record ID.
- Website visits from outreach links are tracked back to the CRM record only when the link includes the prospect CRM id.

## 8. Launch Smoke Test

Run this sequence on production:

1. Submit a real test website audit request.
2. Open the Cal.com booking CTA and confirm it points to the correct 15-minute audit event.
3. Confirm the notification email arrives.
4. Sign in to `/admin` with magic link.
5. Confirm the CRM record appears with clean field labels.
6. Run automated research on the CRM record and confirm the audit, generated report, tier score, email personalization, and cadence appear.
7. Open a tracked outreach link with `submission_id` and confirm the website visit appears on the CRM record.
8. Edit notes, tags, priority, next action date, and contact details.
9. Send a secure upload request.
10. Upload a small test file through `/secure-documents`.
11. Confirm uploaded document metadata appears in the CRM.
12. Trigger or receive a Resend webhook event.
13. Confirm email engagement is attached to the CRM record.
14. Verify `/privacy`, `/terms`, `/sitemap.xml`, `/robots.txt`, and `/api/health`.
