# Deployment

This project is prepared to deploy to Vercel with the custom domain:

`https://www.uckelegroup.com`

## Production Environment Variables

Set these in your hosting provider before going live:

```bash
PUBLIC_SITE_URL=https://www.uckelegroup.com
VITE_PUBLIC_SITE_URL=https://www.uckelegroup.com

VITE_PUBLIC_CONTACT_EMAIL=
VITE_PUBLIC_CONTACT_PHONE=
VITE_PUBLIC_LINKEDIN_URL=

DELIVERY_PROVIDER=resend
LEAD_NOTIFICATION_EMAIL=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_REPLY_TO=

ADMIN_AUTH_MODE=magic-link
ADMIN_EMAIL=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
ADMIN_MAGIC_LINK_SECRET=

SECURE_DOCUMENTS_TOKEN_SECRET=
TURNSTILE_SECRET_KEY=
VITE_TURNSTILE_SITE_KEY=
```

## Recommended Production Choices

- Use `DELIVERY_PROVIDER=resend`
- Use `ADMIN_AUTH_MODE=magic-link`
- Keep the CRM at `/admin`
- Keep `/secure-documents` private and unindexed
- Turn on Turnstile in production

## Vercel Notes

- `vercel.json` is included for SPA routing, API functions, and production headers
- `api/[...path].js` serves the backend API as a serverless function
- Public marketing routes resolve through the Vite SPA
- `/admin` remains private and requires login

## Before Go-Live

- Replace public contact blanks with your real email, phone, and LinkedIn if you want them visible on the site
- Confirm the contact form is delivering to your real inbox
- Set a strong `ADMIN_SESSION_SECRET`
- Set a strong `ADMIN_MAGIC_LINK_SECRET`
- Verify your custom domain in the hosting provider
- Confirm `robots.txt` and `sitemap.xml` are live on the production domain
