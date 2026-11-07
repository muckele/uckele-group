// Shared by the production boot tests: the real fly.toml [env], stand-ins for every production
// secret, and the settings at each stage of the Gmail send rollout runbook.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The `KEY = "value"` lines of fly.toml's [env] section. */
export function flyTomlEnv() {
  const env = {};
  let inEnv = false;
  for (const line of fs.readFileSync(path.join(rootDir, 'fly.toml'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) { inEnv = trimmed === '[env]'; continue; }
    const match = inEnv && trimmed.match(/^([A-Z0-9_]+)\s*=\s*"(.*)"$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

// Stand-ins for the production secrets (names as `fly secrets list` shows them on 2026-11-06).
export function productionSecrets(dataDir) {
  return {
    ADMIN_AUTH_MODE: 'magic-link',
    ADMIN_EMAIL: 'owner@example.com',
    ADMIN_MAGIC_LINK_SECRET: 'm'.repeat(40),
    ADMIN_SESSION_SECRET: 's'.repeat(40),
    DELIVERY_PROVIDER: 'resend',
    LEAD_NOTIFICATION_EMAIL: 'owner@example.com',
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM_EMAIL: 'Uckele Group <hello@example.com>',
    RESEND_REPLY_TO: 'deals@replies.example.com',
    RESEND_INBOUND_DOMAIN: 'replies.example.com',
    RESEND_WEBHOOK_SECRET: 'whsec_test',
    SECURE_DOCUMENTS_TOKEN_SECRET: 'd'.repeat(40),
    DEAL_HUNTER_SHEET_CSV_URL: 'https://docs.google.com/spreadsheets/d/example/export?format=csv',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'turnstile-site',
    DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false',
    DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true',
    DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true',
    DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'true',
    DEAL_HUNTER_CIM_AUTOMATION_PHYSICAL_POSTAL_ADDRESS: '1 Example Way, Portland, OR 97201',
    DEAL_HUNTER_GMAIL_SENDER_ADDRESS: 'sender@example.com',
    DEAL_HUNTER_GMAIL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    DEAL_HUNTER_SENDER_NAME: 'Pat Example',
    DEAL_HUNTER_SENDER_PHONE: '555-0100',
    DEAL_HUNTER_SENDER_TITLE: 'Owner',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    SQLITE_PATH: path.join(dataDir, 'app.sqlite'),
    DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR: path.join(dataDir, 'markers'),
    BACKUP_DIRECTORY: path.join(dataDir, 'backups'),
  };
}

export const RUNBOOK_STAGES = {
  'before the rollout (all send settings unset)': {},
  'step 5 controlled test through Gmail': {
    DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1',
    DEAL_HUNTER_CIM_MAILBOX_PROVIDER: 'gmail',
    DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'tester@example.net',
    DEAL_HUNTER_PURSUE_SENDER_ENABLED: 'true',
    DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED: 'true',
  },
  'step 6 production Gmail': {
    DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'production-gmail-v1',
    DEAL_HUNTER_PURSUE_SENDER_ENABLED: 'true',
    DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED: 'true',
  },
};
