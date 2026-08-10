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

function numberListFromEnv(value, fallback = []) {
  const values = listFromEnv(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);

  return values.length > 0 ? values : fallback;
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
  const viewerUsername = process.env.ADMIN_VIEWER_USERNAME || process.env.SMB_DEAL_HUNTER_VIEWER_USERNAME || (isProduction ? '' : 'smb-deal-hunter');
  const viewerPassword = process.env.ADMIN_VIEWER_PASSWORD || process.env.SMB_DEAL_HUNTER_VIEWER_PASSWORD || (isProduction ? '' : 'view-only-local');
  const viewerEmails = listFromEnv(process.env.ADMIN_VIEWER_EMAILS || process.env.SMB_DEAL_HUNTER_VIEWER_EMAILS);
  const sqlitePath = process.env.SQLITE_PATH || path.join(rootDir, 'data', 'uckele-group.sqlite');
  const defaultDataDir = path.dirname(sqlitePath);

  cachedConfig = {
    rootDir,
    isProduction,
    server: {
      port: numberFromEnv(process.env.PORT, 8787),
      origin: process.env.PUBLIC_SITE_URL || defaultPublicOrigin,
      outboundRequestTimeoutMs: numberFromEnv(process.env.OUTBOUND_HTTP_TIMEOUT_MS, 1000 * 10),
    },
    storage: {
      provider: process.env.STORAGE_PROVIDER || 'sqlite',
      sqlitePath,
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    },
    backup: {
      enabled: booleanFromEnv(process.env.BACKUP_ENABLED, isProduction && (process.env.STORAGE_PROVIDER || 'sqlite') === 'sqlite'),
      directory: process.env.BACKUP_DIRECTORY || path.join(defaultDataDir, 'backups'),
      retentionDays: Math.max(1, numberFromEnv(process.env.BACKUP_RETENTION_DAYS, 14)),
      retentionCount: Math.max(1, numberFromEnv(process.env.BACKUP_RETENTION_COUNT, 14)),
      time: process.env.BACKUP_DAILY_TIME || '03:30',
      timezone: process.env.BACKUP_TIMEZONE || 'America/Los_Angeles',
      checkIntervalMs: Math.max(60_000, numberFromEnv(process.env.BACKUP_CHECK_INTERVAL_MS, 1000 * 60 * 15)),
    },
    delivery: {
      provider: process.env.DELIVERY_PROVIDER || 'console',
      fallbackRecipient: process.env.LEAD_NOTIFICATION_EMAIL || (isProduction ? '' : 'mathew@example.com'),
      resendApiKey: process.env.RESEND_API_KEY || '',
      resendFromEmail: process.env.RESEND_FROM_EMAIL || '',
      resendReplyTo: process.env.RESEND_REPLY_TO || '',
      resendInboundDomain: process.env.RESEND_INBOUND_DOMAIN || '',
      emailWebhookSecret: process.env.EMAIL_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET || '',
      formspreeEndpoint: process.env.FORMSPREE_ENDPOINT || '',
      emailjsServiceId: process.env.EMAILJS_SERVICE_ID || '',
      emailjsTemplateId: process.env.EMAILJS_TEMPLATE_ID || '',
      emailjsPublicKey: process.env.EMAILJS_PUBLIC_KEY || '',
      emailjsPrivateKey: process.env.EMAILJS_PRIVATE_KEY || '',
      emailjsRateLimitMs: numberFromEnv(process.env.EMAILJS_RATE_LIMIT_MS, 1000),
    },
    brand: {
      companyName: process.env.EMAIL_BRAND_COMPANY_NAME || 'Uckele Group',
      websiteUrl: process.env.PUBLIC_SITE_URL || defaultPublicOrigin,
      mailingAddress: process.env.EMAIL_BRAND_MAILING_ADDRESS || '',
    },
    crm: {
      webhookUrl: process.env.CRM_WEBHOOK_URL || '',
      webhookSecret: process.env.CRM_WEBHOOK_SECRET || '',
    },
    turnstile: {
      siteKey: process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || '',
      secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    },
    admin: {
      authMode: adminAuthMode,
      email: adminEmail,
      username: adminUsername,
      password: adminPassword,
      viewerEmails,
      viewerUsername,
      viewerPassword,
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
    followUp: {
      emailEnabled: booleanFromEnv(process.env.FOLLOW_UP_EMAIL_ENABLED, false),
      aiEnabled: booleanFromEnv(process.env.FOLLOW_UP_AI_ENABLED, false),
      aiApiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      aiModel: process.env.FOLLOW_UP_AI_MODEL || '',
      aiTimeoutMs: Math.max(1_000, Math.min(numberFromEnv(process.env.FOLLOW_UP_AI_TIMEOUT_MS, 12_000), 60_000)),
      aiMaxContextChars: Math.max(2_000, Math.min(numberFromEnv(process.env.FOLLOW_UP_AI_MAX_CONTEXT_CHARS, 30_000), 100_000)),
      timezone: process.env.FOLLOW_UP_TIMEZONE || process.env.DEAL_HUNTER_CIM_FOLLOW_UP_TIMEZONE || 'America/Los_Angeles',
      sendWindowStart: process.env.FOLLOW_UP_SEND_WINDOW_START || '08:00',
      sendWindowEnd: process.env.FOLLOW_UP_SEND_WINDOW_END || '17:00',
      weekdaysOnly: booleanFromEnv(process.env.FOLLOW_UP_WEEKDAYS_ONLY, true),
      dailyCap: Math.max(1, Math.min(numberFromEnv(process.env.FOLLOW_UP_DAILY_CAP, 25), 500)),
      recipientRollingCap: Math.max(1, Math.min(numberFromEnv(process.env.FOLLOW_UP_RECIPIENT_30_DAY_CAP, 4), 50)),
      maxTouches: Math.max(1, Math.min(numberFromEnv(process.env.FOLLOW_UP_MAX_TOUCHES, 3), 10)),
      cadenceHours: numberListFromEnv(process.env.FOLLOW_UP_CADENCE_HOURS, [48, 72, 96]).slice(0, 10),
      minimumAiDraftConfidence: Math.max(0, Math.min(numberFromEnv(process.env.FOLLOW_UP_AI_MIN_CONFIDENCE, 0.72), 1)),
      senderName: process.env.FOLLOW_UP_SENDER_NAME || process.env.EMAIL_BRAND_COMPANY_NAME || 'Uckele Group',
      senderEmail: process.env.FOLLOW_UP_SENDER_EMAIL || process.env.RESEND_FROM_EMAIL || '',
      replyTo: process.env.FOLLOW_UP_REPLY_TO || process.env.RESEND_REPLY_TO || '',
      requireSignedPreview: booleanFromEnv(process.env.FOLLOW_UP_REQUIRE_SIGNED_PREVIEW, true),
      requireVerifiedReply: booleanFromEnv(process.env.FOLLOW_UP_REQUIRE_VERIFIED_REPLY, isProduction),
      physicalPostalAddress: process.env.FOLLOW_UP_PHYSICAL_POSTAL_ADDRESS || process.env.EMAIL_BRAND_MAILING_ADDRESS || '',
      optOutBaseUrl: process.env.FOLLOW_UP_OPT_OUT_BASE_URL || '',
      replyOptOutEnabled: booleanFromEnv(process.env.FOLLOW_UP_REPLY_OPT_OUT_ENABLED, false),
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
      maxSourceRecords: numberFromEnv(process.env.DEAL_HUNTER_MAX_SOURCE_RECORDS, 8000),
      sheetCsvMaxPayloadBytes: numberFromEnv(process.env.DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES, 8 * 1024 * 1024),
      airtableSharedMaxPayloadBytes: numberFromEnv(process.env.DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES, 12 * 1024 * 1024),
      dailyEmail: {
        enabled: booleanFromEnv(process.env.DEAL_HUNTER_DAILY_EMAIL_ENABLED, isProduction),
        time: process.env.DEAL_HUNTER_DAILY_EMAIL_TIME || '08:00',
        timezone: process.env.DEAL_HUNTER_DAILY_EMAIL_TIMEZONE || 'America/Los_Angeles',
        checkIntervalMs: numberFromEnv(process.env.DEAL_HUNTER_DAILY_EMAIL_CHECK_INTERVAL_MS, 1000 * 60),
        retryIntervalMs: numberFromEnv(process.env.DEAL_HUNTER_DAILY_EMAIL_RETRY_INTERVAL_MS, 1000 * 60 * 30),
        markerDir: process.env.DEAL_HUNTER_DAILY_EMAIL_MARKER_DIR || path.join(defaultDataDir, 'deal-hunter-daily-email'),
      },
      cimFollowUp: {
        enabled: booleanFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED, false),
        checkIntervalMs: numberFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_CHECK_INTERVAL_MS, 1000 * 60 * 60),
        firstDelayHours: numberFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_FIRST_DELAY_HOURS, 48),
        intervalHours: numberFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_INTERVAL_HOURS, 72),
        maxCount: Math.max(0, Math.min(numberFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_MAX_COUNT, 3), 10)),
        delaySequenceHours: numberListFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_DELAYS_HOURS, [48, 72, 96]).slice(0, 10),
        weekdaysOnly: booleanFromEnv(process.env.DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY, true),
        timezone: process.env.DEAL_HUNTER_CIM_FOLLOW_UP_TIMEZONE || 'America/Los_Angeles',
      },
      cimAutomation: {
        stage: Math.max(1, Math.min(numberFromEnv(process.env.DEAL_HUNTER_CIM_AUTOMATION_STAGE, 1), 3)),
        paused: booleanFromEnv(process.env.DEAL_HUNTER_CIM_AUTOMATION_PAUSED, false),
        stage2MinimumReviews: Math.max(25, numberFromEnv(process.env.DEAL_HUNTER_CIM_STAGE2_MIN_REVIEWS, 25)),
        stage3MinimumReviews: Math.max(50, numberFromEnv(process.env.DEAL_HUNTER_CIM_STAGE3_MIN_REVIEWS, 50)),
        stage3MinimumApprovalRate: Math.max(0.9, Math.min(numberFromEnv(process.env.DEAL_HUNTER_CIM_STAGE3_MIN_APPROVAL_RATE, 0.9), 1)),
        minimumScore: Math.max(75, numberFromEnv(process.env.DEAL_HUNTER_CIM_AUTOMATION_MIN_SCORE, 90)),
        maximumDailyInitials: Math.max(1, Math.min(numberFromEnv(process.env.DEAL_HUNTER_CIM_AUTOMATION_DAILY_CAP, 3), 10)),
        maximumBrokerContacts30Days: Math.max(1, Math.min(numberFromEnv(process.env.DEAL_HUNTER_CIM_BROKER_30_DAY_CAP, 3), 20)),
        maximumProfitMultiple: Math.max(1, numberFromEnv(process.env.DEAL_HUNTER_CIM_AUTOMATION_MAX_PROFIT_MULTIPLE, 4)),
      },
    },
    secureDocuments: {
      tokenSecret: process.env.SECURE_DOCUMENTS_TOKEN_SECRET || sessionSecret,
      requestTtlMs: numberFromEnv(process.env.SECURE_DOCUMENTS_REQUEST_TTL_MS, 1000 * 60 * 60 * 24 * 14),
      maxUploadBytes: numberFromEnv(process.env.SECURE_DOCUMENTS_MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
      maxTotalUploadBytes: numberFromEnv(process.env.SECURE_DOCUMENTS_MAX_TOTAL_UPLOAD_BYTES, 24 * 1024 * 1024),
      maxConcurrentUploads: Math.max(1, numberFromEnv(process.env.SECURE_DOCUMENTS_MAX_CONCURRENT_UPLOADS, 2)),
      storageDir: process.env.SECURE_DOCUMENTS_STORAGE_DIR || path.join(rootDir, 'data', 'secure-documents'),
    },
    protection: {
      contactJsonLimit: process.env.CONTACT_JSON_LIMIT || '64kb',
      rateLimitWindowMs: numberFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 1000 * 60 * 10),
      rateLimitRetentionMs: numberFromEnv(process.env.RATE_LIMIT_RETENTION_MS, 1000 * 60 * 60 * 24 * 30),
      rateLimitMax: numberFromEnv(process.env.RATE_LIMIT_MAX, 6),
      minSubmitTimeMs: numberFromEnv(process.env.MIN_SUBMIT_TIME_MS, 4000),
      spamScoreThreshold: numberFromEnv(process.env.SPAM_SCORE_THRESHOLD, 50),
    },
    analytics: {
      enabled: booleanFromEnv(process.env.ANALYTICS_ENABLED, true),
      retentionDays: Math.max(1, numberFromEnv(process.env.ANALYTICS_RETENTION_DAYS, 90)),
      rateLimitWindowMs: Math.max(1_000, numberFromEnv(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS, 60_000)),
      rateLimitMax: Math.max(1, numberFromEnv(process.env.ANALYTICS_RATE_LIMIT_MAX, 120)),
    },
  };

  return cachedConfig;
}

export function validateConfig(config = getConfig()) {
  const errors = [];
  const warnings = [];
  const requireValue = (value, label) => {
    if (!String(value || '').trim()) {
      errors.push(`${label} is required.`);
    }
  };
  const requirePositiveNumber = (value, label, { integer = false, max = Infinity } = {}) => {
    if (value === undefined) {
      return;
    }
    const numericValue = Number(value);
    if (
      !Number.isFinite(numericValue) ||
      numericValue <= 0 ||
      numericValue > max ||
      (integer && !Number.isInteger(numericValue))
    ) {
      errors.push(`${label} must be a positive${integer ? ' integer' : ''}${Number.isFinite(max) ? ` no greater than ${max}` : ''}.`);
    }
  };
  const requireNonNegativeNumber = (value, label, { integer = false, max = Infinity } = {}) => {
    if (value === undefined) {
      return;
    }
    const numericValue = Number(value);
    if (
      !Number.isFinite(numericValue) ||
      numericValue < 0 ||
      numericValue > max ||
      (integer && !Number.isInteger(numericValue))
    ) {
      errors.push(`${label} must be a non-negative${integer ? ' integer' : ''}${Number.isFinite(max) ? ` no greater than ${max}` : ''}.`);
    }
  };
  const requireHttpUrl = (value, label, { originOnly = false } = {}) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    try {
      const url = new URL(String(value));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('invalid protocol or credentials');
      }
      if (originOnly && (url.pathname !== '/' || url.search || url.hash)) {
        throw new Error('not an origin');
      }
    } catch {
      errors.push(`${label} must be a valid HTTP(S)${originOnly ? ' origin without a path, query, or fragment' : ' URL'}.`);
    }
  };

  if (!['sqlite', 'supabase'].includes(config.storage.provider)) {
    errors.push('STORAGE_PROVIDER must be sqlite or supabase.');
  }

  if (!['console', 'resend', 'emailjs', 'formspree'].includes(config.delivery.provider)) {
    errors.push('DELIVERY_PROVIDER must be console, resend, emailjs, or formspree.');
  }

  if (!['password', 'magic-link', 'hybrid'].includes(config.admin.authMode)) {
    errors.push('ADMIN_AUTH_MODE must be password, magic-link, or hybrid.');
  }

  if (Boolean(config.turnstile.siteKey) !== Boolean(config.turnstile.secretKey)) {
    errors.push('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together.');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.dealHunter.dailyEmail.timezone }).format();
  } catch {
    errors.push('DEAL_HUNTER_DAILY_EMAIL_TIMEZONE is not a valid IANA timezone.');
  }

  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.dealHunter.cimFollowUp?.timezone || config.dealHunter.dailyEmail.timezone,
    }).format();
  } catch {
    errors.push('DEAL_HUNTER_CIM_FOLLOW_UP_TIMEZONE is not a valid IANA timezone.');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.backup?.timezone || 'America/Los_Angeles' }).format();
  } catch {
    errors.push('BACKUP_TIMEZONE is not a valid IANA timezone.');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.followUp?.timezone || 'America/Los_Angeles' }).format();
  } catch {
    errors.push('FOLLOW_UP_TIMEZONE is not a valid IANA timezone.');
  }

  if (config.storage.provider === 'supabase') {
    requireValue(config.storage.supabaseUrl, 'SUPABASE_URL');
    requireValue(config.storage.supabaseServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY');
    requireHttpUrl(config.storage.supabaseUrl, 'SUPABASE_URL');
  }

  if (config.delivery.provider === 'resend') {
    requireValue(config.delivery.resendApiKey, 'RESEND_API_KEY');
    requireValue(config.delivery.resendFromEmail, 'RESEND_FROM_EMAIL');
    requireValue(config.delivery.fallbackRecipient, 'LEAD_NOTIFICATION_EMAIL');
  }

  if (config.delivery.provider === 'emailjs') {
    requireValue(config.delivery.emailjsServiceId, 'EMAILJS_SERVICE_ID');
    requireValue(config.delivery.emailjsTemplateId, 'EMAILJS_TEMPLATE_ID');
    requireValue(config.delivery.emailjsPublicKey, 'EMAILJS_PUBLIC_KEY');
    requireValue(config.delivery.fallbackRecipient, 'LEAD_NOTIFICATION_EMAIL');
  }

  if (config.delivery.provider === 'formspree') {
    requireValue(config.delivery.formspreeEndpoint, 'FORMSPREE_ENDPOINT');
    requireHttpUrl(config.delivery.formspreeEndpoint, 'FORMSPREE_ENDPOINT');
  }

  requireHttpUrl(config.server?.origin, 'PUBLIC_SITE_URL', { originOnly: true });
  requireHttpUrl(config.crm?.webhookUrl, 'CRM_WEBHOOK_URL');

  const scheduledTime = String(config.dealHunter.dailyEmail.time || '10:15');
  const scheduledTimeMatch = scheduledTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!scheduledTimeMatch || Number(scheduledTimeMatch[1]) > 23 || Number(scheduledTimeMatch[2]) > 59) {
    errors.push('DEAL_HUNTER_DAILY_EMAIL_TIME must use a valid 24-hour HH:MM value.');
  }

  const backupTime = String(config.backup?.time || '03:30');
  const backupTimeMatch = backupTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!backupTimeMatch || Number(backupTimeMatch[1]) > 23 || Number(backupTimeMatch[2]) > 59) {
    errors.push('BACKUP_DAILY_TIME must use a valid 24-hour HH:MM value.');
  }

  requirePositiveNumber(config.server?.port, 'PORT', { integer: true, max: 65_535 });
  requirePositiveNumber(config.server?.outboundRequestTimeoutMs, 'OUTBOUND_HTTP_TIMEOUT_MS');
  requirePositiveNumber(config.delivery?.emailjsRateLimitMs, 'EMAILJS_RATE_LIMIT_MS');
  requirePositiveNumber(config.admin.magicLinkTtlMs, 'ADMIN_MAGIC_LINK_TTL_MS');
  requirePositiveNumber(config.admin.sessionMaxAgeMs, 'ADMIN_SESSION_MAX_AGE_MS');
  requirePositiveNumber(config.secureDocuments.requestTtlMs, 'SECURE_DOCUMENTS_REQUEST_TTL_MS');
  requirePositiveNumber(config.secureDocuments.maxUploadBytes, 'SECURE_DOCUMENTS_MAX_UPLOAD_BYTES', { integer: true });
  requirePositiveNumber(config.secureDocuments.maxTotalUploadBytes, 'SECURE_DOCUMENTS_MAX_TOTAL_UPLOAD_BYTES', { integer: true });
  requirePositiveNumber(config.secureDocuments.maxConcurrentUploads, 'SECURE_DOCUMENTS_MAX_CONCURRENT_UPLOADS', { integer: true });
  requirePositiveNumber(config.dealHunter.dailyEmail.checkIntervalMs, 'DEAL_HUNTER_DAILY_EMAIL_CHECK_INTERVAL_MS');
  requirePositiveNumber(config.dealHunter.dailyEmail.retryIntervalMs, 'DEAL_HUNTER_DAILY_EMAIL_RETRY_INTERVAL_MS');
  requirePositiveNumber(config.dealHunter.cimFollowUp?.checkIntervalMs, 'DEAL_HUNTER_CIM_FOLLOW_UP_CHECK_INTERVAL_MS');
  requirePositiveNumber(config.dealHunter.cimFollowUp?.firstDelayHours, 'DEAL_HUNTER_CIM_FOLLOW_UP_FIRST_DELAY_HOURS');
  requirePositiveNumber(config.dealHunter.cimFollowUp?.intervalHours, 'DEAL_HUNTER_CIM_FOLLOW_UP_INTERVAL_HOURS');
  requireNonNegativeNumber(config.dealHunter.cimFollowUp?.maxCount, 'DEAL_HUNTER_CIM_FOLLOW_UP_MAX_COUNT', { integer: true, max: 10 });
  requirePositiveNumber(config.dealHunter.lookbackDays, 'DEAL_HUNTER_LOOKBACK_DAYS');
  requirePositiveNumber(config.dealHunter.maxSourceRecords, 'DEAL_HUNTER_MAX_SOURCE_RECORDS', { integer: true });
  requirePositiveNumber(config.dealHunter.sheetCsvMaxPayloadBytes, 'DEAL_HUNTER_SHEET_CSV_MAX_PAYLOAD_BYTES', { integer: true });
  requirePositiveNumber(config.dealHunter.airtableSharedMaxPayloadBytes, 'DEAL_HUNTER_AIRTABLE_SHARED_MAX_PAYLOAD_BYTES', { integer: true });
  requirePositiveNumber(config.protection?.rateLimitWindowMs, 'RATE_LIMIT_WINDOW_MS');
  requirePositiveNumber(config.protection?.rateLimitRetentionMs, 'RATE_LIMIT_RETENTION_MS');
  requirePositiveNumber(config.protection?.rateLimitMax, 'RATE_LIMIT_MAX', { integer: true });
  requirePositiveNumber(config.protection?.minSubmitTimeMs, 'MIN_SUBMIT_TIME_MS');
  requirePositiveNumber(config.protection?.spamScoreThreshold, 'SPAM_SCORE_THRESHOLD');
  requirePositiveNumber(config.analytics?.retentionDays, 'ANALYTICS_RETENTION_DAYS', { integer: true, max: 3650 });
  requirePositiveNumber(config.analytics?.rateLimitWindowMs, 'ANALYTICS_RATE_LIMIT_WINDOW_MS');
  requirePositiveNumber(config.analytics?.rateLimitMax, 'ANALYTICS_RATE_LIMIT_MAX', { integer: true });
  requirePositiveNumber(config.backup?.retentionDays, 'BACKUP_RETENTION_DAYS', { integer: true });
  requirePositiveNumber(config.backup?.retentionCount, 'BACKUP_RETENTION_COUNT', { integer: true });
  requirePositiveNumber(config.backup?.checkIntervalMs, 'BACKUP_CHECK_INTERVAL_MS');
  requirePositiveNumber(config.followUp?.aiTimeoutMs, 'FOLLOW_UP_AI_TIMEOUT_MS', { integer: true, max: 60_000 });
  requirePositiveNumber(config.followUp?.aiMaxContextChars, 'FOLLOW_UP_AI_MAX_CONTEXT_CHARS', { integer: true, max: 100_000 });
  requirePositiveNumber(config.followUp?.dailyCap, 'FOLLOW_UP_DAILY_CAP', { integer: true, max: 500 });
  requirePositiveNumber(config.followUp?.recipientRollingCap, 'FOLLOW_UP_RECIPIENT_30_DAY_CAP', { integer: true, max: 50 });
  requirePositiveNumber(config.followUp?.maxTouches, 'FOLLOW_UP_MAX_TOUCHES', { integer: true, max: 10 });

  for (const [value, label] of [
    [config.followUp?.sendWindowStart || '08:00', 'FOLLOW_UP_SEND_WINDOW_START'],
    [config.followUp?.sendWindowEnd || '17:00', 'FOLLOW_UP_SEND_WINDOW_END'],
  ]) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      errors.push(`${label} must use a valid 24-hour HH:MM value.`);
    }
  }

  if (config.followUp?.aiEnabled) {
    requireValue(config.followUp.aiModel, 'FOLLOW_UP_AI_MODEL');
    if (!config.followUp.aiApiKeyConfigured) {
      errors.push('OPENAI_API_KEY is required when FOLLOW_UP_AI_ENABLED=true.');
    }
  }

  if (config.followUp?.emailEnabled) {
    if (config.delivery.provider !== 'resend') {
      errors.push('DELIVERY_PROVIDER=resend is required when generic CRM follow-up email is enabled.');
    }
    requireValue(config.delivery.resendApiKey, 'RESEND_API_KEY');
    requireValue(config.followUp.senderEmail, 'FOLLOW_UP_SENDER_EMAIL or RESEND_FROM_EMAIL');
    requireValue(config.followUp.replyTo, 'FOLLOW_UP_REPLY_TO or RESEND_REPLY_TO');
    const followUpSender = String(config.followUp.senderEmail || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
    const deliverySender = String(config.delivery.resendFromEmail || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
    const followUpReplyTo = String(config.followUp.replyTo || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
    const deliveryReplyTo = String(config.delivery.resendReplyTo || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
    if (followUpSender && deliverySender && followUpSender !== deliverySender) {
      errors.push('FOLLOW_UP_SENDER_EMAIL must match the RESEND_FROM_EMAIL address.');
    }
    if (followUpReplyTo && deliveryReplyTo && followUpReplyTo !== deliveryReplyTo) {
      errors.push('FOLLOW_UP_REPLY_TO must match RESEND_REPLY_TO.');
    }
    if (followUpReplyTo && config.delivery.resendInboundDomain
      && followUpReplyTo.split('@')[1] !== String(config.delivery.resendInboundDomain).trim().toLowerCase().replace(/^@/, '')) {
      errors.push('FOLLOW_UP_REPLY_TO must use RESEND_INBOUND_DOMAIN.');
    }
    if (config.isProduction && config.followUp.requireSignedPreview === false) {
      errors.push('FOLLOW_UP_REQUIRE_SIGNED_PREVIEW cannot be disabled in production.');
    }
    if (config.followUp.requireSignedPreview !== false && String(config.admin?.sessionSecret || '').length < 16) {
      errors.push('ADMIN_SESSION_SECRET is required to sign exact CRM follow-up previews.');
    }
    requireValue(config.delivery.emailWebhookSecret, 'RESEND_WEBHOOK_SECRET or EMAIL_WEBHOOK_SECRET');
    requireValue(config.delivery.resendInboundDomain, 'RESEND_INBOUND_DOMAIN');
    requireValue(config.followUp.physicalPostalAddress, 'FOLLOW_UP_PHYSICAL_POSTAL_ADDRESS or EMAIL_BRAND_MAILING_ADDRESS');
    if (!config.followUp.replyOptOutEnabled && !config.followUp.optOutBaseUrl) {
      errors.push('FOLLOW_UP_REPLY_OPT_OUT_ENABLED=true or FOLLOW_UP_OPT_OUT_BASE_URL is required when generic CRM follow-up email is enabled.');
    }
    requireHttpUrl(config.followUp.optOutBaseUrl, 'FOLLOW_UP_OPT_OUT_BASE_URL');
  }

  if (
    Number.isFinite(Number(config.protection?.rateLimitRetentionMs)) &&
    Number.isFinite(Number(config.protection?.rateLimitWindowMs)) &&
    Number(config.protection.rateLimitRetentionMs) < Number(config.protection.rateLimitWindowMs)
  ) {
    errors.push('RATE_LIMIT_RETENTION_MS must be greater than or equal to RATE_LIMIT_WINDOW_MS.');
  }

  if (config.isProduction) {
    requireValue(config.admin.email, 'ADMIN_EMAIL');

    if (String(config.admin.sessionSecret || '').length < 32) {
      errors.push('ADMIN_SESSION_SECRET must contain at least 32 characters in production.');
    }

    if (['magic-link', 'hybrid'].includes(config.admin.authMode) && String(config.admin.magicLinkSecret || '').length < 32) {
      errors.push('ADMIN_MAGIC_LINK_SECRET must contain at least 32 characters when magic-link authentication is enabled.');
    }

    if (String(config.secureDocuments.tokenSecret || '').length < 32) {
      errors.push('SECURE_DOCUMENTS_TOKEN_SECRET must contain at least 32 characters in production.');
    }

    if (config.secureDocuments.tokenSecret === config.admin.sessionSecret) {
      errors.push('SECURE_DOCUMENTS_TOKEN_SECRET must be different from ADMIN_SESSION_SECRET in production.');
    }

    if (config.delivery.provider === 'console') {
      errors.push('DELIVERY_PROVIDER=console is not allowed in production.');
    }

    if (config.delivery.provider === 'formspree') {
      errors.push('DELIVERY_PROVIDER=formspree is inbound-only and cannot support production admin or Deal Hunter email. Use resend or emailjs.');
    }

    const magicLinkUsable = ['magic-link', 'hybrid'].includes(config.admin.authMode)
      && Boolean(config.admin.email && config.admin.magicLinkSecret)
      && !['console', 'formspree'].includes(config.delivery.provider);
    const passwordUsable = ['password', 'hybrid'].includes(config.admin.authMode)
      && Boolean(config.admin.allowPasswordAuth && config.admin.username && config.admin.password);
    if (!magicLinkUsable && !passwordUsable) {
      errors.push('Production configuration must provide at least one usable admin authentication path.');
    }

    if (config.dealHunter.cimFollowUp.enabled) {
      if (config.delivery.provider !== 'resend') {
        errors.push('DELIVERY_PROVIDER=resend is required when CIM follow-ups are enabled.');
      }
      if (!config.delivery.emailWebhookSecret) {
        errors.push('RESEND_WEBHOOK_SECRET or EMAIL_WEBHOOK_SECRET is required when CIM follow-ups are enabled.');
      }
      requireValue(config.delivery.resendReplyTo, 'RESEND_REPLY_TO');
      requireValue(config.delivery.resendInboundDomain, 'RESEND_INBOUND_DOMAIN');

      const replyAddress = String(config.delivery.resendReplyTo || '').match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1] || '';
      const replyDomain = replyAddress.split('@')[1]?.toLowerCase().replace(/\.+$/, '') || '';
      const inboundDomain = String(config.delivery.resendInboundDomain || '').trim().toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
      if (replyAddress && inboundDomain && replyDomain !== inboundDomain) {
        errors.push('RESEND_REPLY_TO must use the RESEND_INBOUND_DOMAIN when CIM follow-ups are enabled.');
      }
    }
  } else if (config.admin.password === 'change-me-now') {
    warnings.push('The local admin account is using the documented development password.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertValidConfig(config = getConfig()) {
  const validation = validateConfig(config);

  if (!validation.ok) {
    const error = new Error(`Invalid application configuration:\n- ${validation.errors.join('\n- ')}`);
    error.name = 'ConfigurationError';
    throw error;
  }

  return validation;
}
