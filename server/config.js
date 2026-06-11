import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production';

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function listFromEnv(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

let cachedConfig;

export function getConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  const defaultPublicOrigin = isProduction ? 'https://www.uckelegroup.com' : 'http://localhost:5173';
  const adminUsername = process.env.ADMIN_USERNAME || (isProduction ? '' : 'admin');
  const adminPassword = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'change-me-now');
  const sessionSecret =
    process.env.ADMIN_SESSION_SECRET || (isProduction ? '' : 'local-development-session-secret');
  const adminAuthMode = process.env.ADMIN_AUTH_MODE || (isProduction ? 'magic-link' : 'hybrid');
  const adminEmail = process.env.ADMIN_EMAIL || process.env.LEAD_NOTIFICATION_EMAIL || (isProduction ? '' : 'mathew@example.com');

  cachedConfig = {
    rootDir,
    isProduction,
    server: {
      port: numberFromEnv(process.env.PORT, 8787),
      origin: process.env.PUBLIC_SITE_URL || defaultPublicOrigin,
    },
    storage: {
      provider: process.env.STORAGE_PROVIDER || 'sqlite',
      sqlitePath: process.env.SQLITE_PATH || path.join(rootDir, 'data', 'uckele-group.sqlite'),
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    },
    delivery: {
      provider: process.env.DELIVERY_PROVIDER || 'console',
      fallbackRecipient: process.env.LEAD_NOTIFICATION_EMAIL || (isProduction ? '' : 'mathew@example.com'),
      resendApiKey: process.env.RESEND_API_KEY || '',
      resendFromEmail: process.env.RESEND_FROM_EMAIL || '',
      resendReplyTo: process.env.RESEND_REPLY_TO || '',
      emailWebhookSecret: process.env.EMAIL_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET || '',
      formspreeEndpoint: process.env.FORMSPREE_ENDPOINT || '',
      emailjsServiceId: process.env.EMAILJS_SERVICE_ID || '',
      emailjsTemplateId: process.env.EMAILJS_TEMPLATE_ID || '',
      emailjsPublicKey: process.env.EMAILJS_PUBLIC_KEY || '',
      emailjsPrivateKey: process.env.EMAILJS_PRIVATE_KEY || '',
      emailjsRateLimitMs: numberFromEnv(process.env.EMAILJS_RATE_LIMIT_MS, 1000),
    },
    outreach: {
      companyName: process.env.OUTREACH_COMPANY_NAME || 'Uckele Group',
      senderName: process.env.OUTREACH_SENDER_NAME || 'Mathew Uckele',
      schedulingUrl: process.env.PUBLIC_SCHEDULING_URL || process.env.CALENDLY_URL || '',
      contactFormUrl: process.env.PUBLIC_CONTACT_FORM_URL || `${process.env.PUBLIC_SITE_URL || defaultPublicOrigin}/contact`,
      websiteUrl: process.env.PUBLIC_SITE_URL || defaultPublicOrigin,
      mailingAddress: process.env.OUTREACH_MAILING_ADDRESS || '',
      unsubscribeBaseUrl: process.env.PUBLIC_UNSUBSCRIBE_URL || '',
    },
    crm: {
      webhookUrl: process.env.CRM_WEBHOOK_URL || '',
      webhookSecret: process.env.CRM_WEBHOOK_SECRET || '',
    },
    turnstile: {
      siteKey: process.env.VITE_TURNSTILE_SITE_KEY || '',
      secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    },
    admin: {
      authMode: adminAuthMode,
      email: adminEmail,
      username: adminUsername,
      password: adminPassword,
      sessionSecret,
      magicLinkSecret: process.env.ADMIN_MAGIC_LINK_SECRET || sessionSecret,
      magicLinkTtlMs: numberFromEnv(process.env.ADMIN_MAGIC_LINK_TTL_MS, 1000 * 60 * 20),
      allowPasswordAuth:
        adminAuthMode === 'password' ||
        adminAuthMode === 'hybrid' ||
        booleanFromEnv(process.env.ADMIN_ALLOW_PASSWORD_AUTH, !isProduction),
      sessionCookieName: 'ug_admin_session',
      sessionMaxAgeMs: numberFromEnv(process.env.ADMIN_SESSION_MAX_AGE_MS, 1000 * 60 * 60 * 12),
    },
    workflow: {
      defaultAssignee: process.env.DEFAULT_LEAD_ASSIGNEE || 'Mathew Uckele',
      defaultFollowUpDelayHours: numberFromEnv(process.env.DEFAULT_FOLLOW_UP_DELAY_HOURS, 24),
    },
    dealHunter: {
      recipient: process.env.DEAL_HUNTER_EMAIL_RECIPIENT || adminEmail,
      cronSecret: process.env.DEAL_HUNTER_CRON_SECRET || '',
      sheetCsvUrls: listFromEnv(process.env.DEAL_HUNTER_SHEET_CSV_URLS || process.env.DEAL_HUNTER_SHEET_CSV_URL),
      airtableSharedViewUrl:
        process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL ||
        'https://airtable.com/appEGxhjno0HTpEco/shrUhtbnzZTPaR4Lk/tblACIQ9QNiVmoWSK?viewControls=on',
      airtableToken: process.env.DEAL_HUNTER_AIRTABLE_TOKEN || process.env.AIRTABLE_TOKEN || '',
      airtableBaseId: process.env.DEAL_HUNTER_AIRTABLE_BASE_ID || 'appEGxhjno0HTpEco',
      airtableTableId: process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID || 'tblACIQ9QNiVmoWSK',
      airtableViewId: process.env.DEAL_HUNTER_AIRTABLE_VIEW_ID || 'viw4OORhKKWPUsWa4',
      lookbackDays: numberFromEnv(process.env.DEAL_HUNTER_LOOKBACK_DAYS, 4),
      maxSourceRecords: numberFromEnv(process.env.DEAL_HUNTER_MAX_SOURCE_RECORDS, 40000),
    },
    secureDocuments: {
      tokenSecret: process.env.SECURE_DOCUMENTS_TOKEN_SECRET || sessionSecret,
      requestTtlMs: numberFromEnv(process.env.SECURE_DOCUMENTS_REQUEST_TTL_MS, 1000 * 60 * 60 * 24 * 14),
      maxUploadBytes: numberFromEnv(process.env.SECURE_DOCUMENTS_MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
      storageDir: process.env.SECURE_DOCUMENTS_STORAGE_DIR || path.join(rootDir, 'data', 'secure-documents'),
    },
    protection: {
      rateLimitWindowMs: numberFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 1000 * 60 * 10),
      rateLimitMax: numberFromEnv(process.env.RATE_LIMIT_MAX, 6),
      minSubmitTimeMs: numberFromEnv(process.env.MIN_SUBMIT_TIME_MS, 4000),
      spamScoreThreshold: numberFromEnv(process.env.SPAM_SCORE_THRESHOLD, 50),
    },
  };

  return cachedConfig;
}
