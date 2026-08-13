# Uckele Group

Uckele Group is a full-stack acquisition website and private deal-operations application for Mathew Uckele. The public site supports confidential seller outreach; the authenticated workspace provides CRM, deal sourcing, diligence, secure documents, activity history, and operational health tooling.

The production deployment is designed to run economically on Fly.io with SQLite and a persistent volume. Supabase remains an optional storage provider, but it is not required for the current deployment.

## What is included

- Public acquisition site with responsive pages, accessible navigation, privacy language, contact intake, metadata, sitemap, and pre-rendered SEO heads.
- Paginated CRM with URL-persisted search, filtering, sorting, page size, accurate totals, a human-reviewed follow-up workspace, CSV export, and deal rooms.
- Durable deal activity events for CRM changes, email delivery and replies, CIM activity, diligence, and secure-document actions.
- Deal Hunter review workflow with source health, daily delivery history, CIM requests, and acquisition-command-center feedback.
- Secure Documents v2 with expiring request links, requested-document checklists, multiple batches, per-file categories, revocation, individual deletion, and NDA acknowledgment.
- Operations center with scheduler history, source-health history, audit events, cleanup failures, CRM email readiness and learning metrics, database and disk status, and backup status.
- Application-consistent SQLite backup bundles with secure-document manifests, checksums, integrity verification, retention, restore tooling, and a recovery drill.
- Single-use magic links and server-side, revocable admin sessions, including sign-out-all-sessions and automatic expired-record cleanup.

## Technology

- React 18, React Router, Vite, Tailwind CSS
- Express on Node.js
- SQLite through `better-sqlite3`, or optional Supabase/Postgres
- Node test runner for service and integration coverage
- Vitest and Testing Library for component coverage
- Playwright for browser smoke tests
- Fly.io for the current production deployment

## Requirements

- Node.js 22 is recommended. The package requires Node.js 20.19 or newer.
- npm
- A writable local directory for SQLite and secure documents

## Local setup

1. Install dependencies.

   ```bash
   npm ci
   ```

2. Create the local environment file.

   ```bash
   cp .env.example .env
   ```

3. Keep `STORAGE_PROVIDER=sqlite` for the default setup. The documented development administrator is `admin` with password `change-me-now`; change it whenever the environment is shared.

4. Start the API and Vite development server.

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`. The API listens on `http://localhost:8787` and Vite proxies `/api` requests to it.

Local data is stored under `data/` by default and is excluded from Git.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API and Vite development servers |
| `npm run build` | Build the site and generate static SEO entry documents |
| `npm start` | Run the Express production server against `dist/` |
| `npm run lint` | Run ESLint, including React hooks and accessibility rules |
| `npm test` | Run backend unit and integration tests |
| `npm run test:ui` | Run component tests in jsdom |
| `npm run test:browser` | Run Playwright browser smoke tests against a preview build |
| `npm run check` | Run lint, backend tests, UI tests, and a production build |
| `npm run backup:create` | Create and verify an application backup bundle |
| `npm run backup:verify` | Verify the newest or selected backup bundle |
| `npm run backup:restore` | Restore a verified backup bundle |
| `npm run backup:drill` | Execute the automated backup-and-restore recovery drill |
| `npm run cim:stage2:audit` | Run the count-only, address-free Stage 2 readiness and linkage audit |

Install the Playwright browser once before the first local browser run:

```bash
npx playwright install chromium
```

Build before using `npm run test:browser`, because the browser configuration serves `dist/` through Vite Preview.

## Application layout

```text
src/
  components/           Shared public and admin UI
  components/admin/     CRM, activity, Operations, and Deal Hunter modules
  pages/                Public, admin, and secure-upload routes
  content/              Public copy and SEO configuration
server/
  app.js                 HTTP routes and middleware
  services/              Business rules, auth, backups, CRM, and documents
  storage/               SQLite and Supabase adapters
scripts/                 Backup/restore CLI and build-time SEO generation
test/                    Backend and integration tests
test-ui/                 React component tests
test-browser/            Playwright browser tests
supabase/                Optional schema and forward migrations
docs/                    Deployment, backend, security, and recovery guides
```

The browser never receives storage credentials or privileged provider keys. Administrative authorization is enforced by the API; hiding an admin control in React is only a presentation measure, not the security boundary.

## Configuration

Copy `.env.example` and configure only the providers you use. Important groups are:

- Storage: `STORAGE_PROVIDER`, `SQLITE_PATH`, and the optional `SUPABASE_*` values.
- Delivery: `DELIVERY_PROVIDER` plus Resend or EmailJS credentials. `console` is appropriate only for development.
- Authentication: `ADMIN_AUTH_MODE`, administrator identity, unique session and magic-link secrets, session lifetime, and optional viewer access.
- Secure documents: a unique token secret, storage directory, request lifetime, and upload limits.
- Deal Hunter: source configuration, recipient, schedule, and optional automated CIM follow-ups.
- Human-reviewed follow-ups: `FOLLOW_UP_EMAIL_ENABLED`, optional `FOLLOW_UP_AI_ENABLED`, sender/reply identity, send windows, caps, cadence, postal footer, opt-out settings, and the AI model/reasoning/request bounds plus approval/eval/synthetic-smoke references. Both feature flags default to `false`.
- Protection: Turnstile, request limits, rate limiting, and spam thresholds.
- Backup: enabled state, private bundle directory, retention limits, daily time, timezone, and scheduler interval.

Production validation intentionally rejects missing or weak authentication secrets, reused secure-document secrets, unusable login configuration, and development-only delivery providers.

The generic CRM email action and AI enrichment flags are independent. Deterministic recommendations remain available when AI is disabled or degraded, and no recommendation may send an email. The credential-free synthetic gate is `npm run eval:follow-ups`; paid live comparison is separately guarded and never implied by that command. Before enabling either flag, use the staged checklist in [docs/follow-up-operations.md](docs/follow-up-operations.md).

## SQLite data and recovery

SQLite is the current economical production choice. The database, secure documents, scheduler markers, and application backup bundles live on the Fly volume mounted at `/data`.

A backup is not a raw live-database copy. The backup service asks SQLite for a consistent snapshot, then copies the secure files referenced by that snapshot, creates a checksummed manifest, performs SQLite `quick_check`, verifies each document, and only then publishes the bundle. Bundles are pruned by both age and count.

For operating and restore instructions, including Fly volume snapshots and the recovery drill, read [docs/sqlite-recovery.md](docs/sqlite-recovery.md). Treat same-volume bundles as rapid operational recovery, not as a substitute for a separately controlled offsite copy.

## Authentication and roles

Production should use `ADMIN_AUTH_MODE=magic-link` unless password login is deliberately required. Magic links are single-use. Successful login creates a server-side session whose ID is stored in a signed, secure, HTTP-only cookie. Logging out revokes the current session; “Sign Out Everywhere” revokes every active session for that identity.

The `admin` role can mutate deal data, use Operations release controls, export records, manage secure requests, and revoke sessions. The `viewer` role has limited read access, can see the aggregate body-free and address-free Operations status, and cannot activate, run, pause, inspect Stage 2 decision details, or perform other mutations.

## Secure-document handling

Secure upload links should be sent only to the intended recipient and revoked when no longer needed. Administrators can define a checklist, receive several upload batches, categorize each file, complete or revoke the request, and delete individual files. Files are stored outside the public build and downloaded only after authenticated authorization.

The uploader and privacy notice explain confidentiality and retention in plain language. Avoid requesting or uploading secrets that are not necessary for diligence, including account credentials, full card data, Social Security numbers, or unrelated medical information.

## Supabase option

Set `STORAGE_PROVIDER=supabase` and apply `supabase/schema.sql` plus the migrations when managed Postgres, multi-instance database access, or provider-managed database operations justify the additional cost. All application tables are server-only: row-level security and explicit privilege revocation block direct `anon` and `authenticated` Data API access, while the Node server uses the service-role credential. Never expose that credential to the browser. The application-managed backup commands intentionally support SQLite only; a Supabase deployment should use Supabase-managed backup and recovery controls for the database while separately protecting secure documents.

## Deployment

The checked-in `fly.toml` and `Dockerfile` build one Node service. Production uses one always-on shared machine and one persistent volume. Before deploying, set secrets through Fly rather than committing them:

```bash
fly secrets set -a uckele-group \
  ADMIN_EMAIL='...' \
  ADMIN_SESSION_SECRET='...' \
  ADMIN_MAGIC_LINK_SECRET='...' \
  SECURE_DOCUMENTS_TOKEN_SECRET='...' \
  DELIVERY_PROVIDER='resend' \
  RESEND_API_KEY='...' \
  RESEND_FROM_EMAIL='...' \
  LEAD_NOTIFICATION_EMAIL='...'
```

Then deploy and verify readiness:

```bash
fly deploy -a uckele-group
fly status -a uckele-group
curl -i https://www.uckelegroup.com/api/ready
```

See [docs/deployment.md](docs/deployment.md), [docs/backend-setup.md](docs/backend-setup.md), and the [guarded CIM Stage 2 rollout runbook](docs/cim-stage2-rollout.md) for the full provider and production checklist.

For the CRM follow-up rollout, provider receiving setup, compliance review, monitoring, ambiguous-send incident handling, and rollback procedure, see [docs/follow-up-operations.md](docs/follow-up-operations.md). Deployment is a separate, explicit operator action; this repository does not enable the feature or perform live sends by itself.

## Continuous integration

GitHub Actions installs dependencies, audits production dependencies, lints, runs backend and UI tests, builds the production application, installs Chromium, and runs Playwright smoke tests. New storage behavior should have provider-parity coverage where practical, and security-sensitive workflows should include integration tests that exercise the HTTP boundary.

## Privacy and security notes

- Do not commit `.env`, database files, uploaded documents, backup bundles, session secrets, provider credentials, or exported CRM data.
- Rotate a secret immediately if it appears in logs or source control.
- Audit mutations are written before an administrative change is allowed to proceed; an unavailable audit store fails the mutation closed.
- Cleanup failures are durable and visible to administrators without exposing confidential document paths in the Operations response.
- Before a secure-document upload or deletion writes or moves a file, the application durably records a write-ahead cleanup intent. If the database cannot confirm that record, it writes a private `.reconciliation.json` sidecar inside the operation's protected `.trash` directory. Sidecar writes are atomic and directory-synced; startup and hourly reconciliation also recover a valid synced temporary intent after an abrupt process exit. Ambiguous mutations remain staged through a settlement window, after which reconciliation acquires a token-fenced database lease. The database clock renews that still-unexpired lease before every restore, purge, fallback purge, and cleanup-directory removal; every leased state transition also requires an unexpired matching token. Reconciliation binds every file to that job's exact operation directory and database document identity, so stale or overlapping workers cannot touch later files, release a newer worker's lease, or finalize its job.
- Review disk space, database integrity, backup freshness, scheduler failures, source health, cleanup failures, and active sessions routinely.

This repository contains operational software for confidential business discussions. Access should be limited to people who need it, and deployment configuration should be reviewed before real seller information is accepted.
