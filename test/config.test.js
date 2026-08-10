import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../server/config.js';

function productionConfig() {
  return {
    isProduction: true,
    storage: {
      provider: 'sqlite',
      supabaseUrl: '',
      supabaseServiceRoleKey: '',
    },
    delivery: {
      provider: 'resend',
      resendApiKey: 'resend-test-key',
      resendFromEmail: 'Uckele Group <test@example.com>',
      resendReplyTo: 'deals@replies.example.com',
      resendInboundDomain: 'replies.example.com',
      fallbackRecipient: 'admin@example.com',
      emailWebhookSecret: 'webhook-secret',
    },
    turnstile: {
      siteKey: 'turnstile-site-key',
      secretKey: 'turnstile-secret-key',
    },
    admin: {
      authMode: 'magic-link',
      email: 'admin@example.com',
      password: '',
      sessionSecret: 's'.repeat(40),
      magicLinkSecret: 'm'.repeat(40),
      allowPasswordAuth: false,
      username: '',
    },
    secureDocuments: {
      tokenSecret: 'd'.repeat(40),
      requestTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTotalUploadBytes: 4096,
      maxConcurrentUploads: 2,
    },
    dealHunter: {
      dailyEmail: { timezone: 'America/Los_Angeles', time: '10:15', checkIntervalMs: 60_000, retryIntervalMs: 60_000 },
      cimFollowUp: {
        enabled: true,
        checkIntervalMs: 3_600_000,
        timezone: 'America/Los_Angeles',
      },
    },
  };
}

test('production configuration accepts independently secured enabled services', () => {
  const result = validateConfig(productionConfig());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('production configuration rejects missing and shared security secrets', () => {
  const config = productionConfig();
  config.admin.sessionSecret = 'short';
  config.admin.magicLinkSecret = '';
  config.secureDocuments.tokenSecret = 'short';
  config.turnstile.secretKey = '';
  config.delivery.emailWebhookSecret = '';
  config.delivery.resendReplyTo = '';
  config.delivery.resendInboundDomain = '';

  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('ADMIN_SESSION_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('ADMIN_MAGIC_LINK_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('SECURE_DOCUMENTS_TOKEN_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('TURNSTILE_SITE_KEY')));
  assert.ok(result.errors.some((error) => error.includes('WEBHOOK_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('RESEND_REPLY_TO')));
  assert.ok(result.errors.some((error) => error.includes('RESEND_INBOUND_DOMAIN')));
});

test('production follow-ups require the reply-to address to use the receiving domain', () => {
  const config = productionConfig();
  config.delivery.resendReplyTo = 'mathew@example.com';

  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('must use the RESEND_INBOUND_DOMAIN')));
});

test('AI follow-up enrichment fails closed without both a model and an API key', () => {
  const config = productionConfig();
  config.followUp = {
    aiEnabled: true,
    aiModel: 'gpt-test',
    aiApiKeyConfigured: false,
  };

  const missingKey = validateConfig(config);
  assert.equal(missingKey.ok, false);
  assert.ok(missingKey.errors.some((error) => error.includes('OPENAI_API_KEY')));

  config.followUp.aiApiKeyConfigured = true;
  config.followUp.aiModel = '';
  const missingModel = validateConfig(config);
  assert.equal(missingModel.ok, false);
  assert.ok(missingModel.errors.some((error) => error.includes('FOLLOW_UP_AI_MODEL')));
});

test('generic follow-up sender and reply identities must align with verified Resend configuration', () => {
  const config = productionConfig();
  config.followUp = {
    emailEnabled: true,
    senderEmail: 'Different Sender <different@example.com>',
    replyTo: 'different@other.example.com',
    physicalPostalAddress: '123 Main Street',
    replyOptOutEnabled: true,
    optOutBaseUrl: '',
    requireSignedPreview: false,
  };

  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('FOLLOW_UP_SENDER_EMAIL must match')));
  assert.ok(result.errors.some((error) => error.includes('FOLLOW_UP_REPLY_TO must match')));
  assert.ok(result.errors.some((error) => error.includes('FOLLOW_UP_REPLY_TO must use')));
  assert.ok(result.errors.some((error) => error.includes('FOLLOW_UP_REQUIRE_SIGNED_PREVIEW')));
});

test('production configuration validates EmailJS and Formspree provider requirements', () => {
  const emailJs = productionConfig();
  emailJs.delivery = {
    provider: 'emailjs',
    fallbackRecipient: 'admin@example.com',
    emailWebhookSecret: 'webhook-secret',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: '',
  };
  const emailJsResult = validateConfig(emailJs);
  assert.equal(emailJsResult.ok, false);
  assert.ok(emailJsResult.errors.some((error) => error.includes('EMAILJS_SERVICE_ID')));

  const formspree = productionConfig();
  formspree.delivery = {
    provider: 'formspree',
    formspreeEndpoint: '',
    emailWebhookSecret: 'webhook-secret',
  };
  const formspreeResult = validateConfig(formspree);
  assert.equal(formspreeResult.ok, false);
  assert.ok(formspreeResult.errors.some((error) => error.includes('FORMSPREE_ENDPOINT')));
  assert.ok(formspreeResult.errors.some((error) => error.includes('inbound-only')));
  assert.ok(formspreeResult.errors.some((error) => error.includes('authentication path')));
});

test('production configuration rejects unsupported auth modes and unsafe numeric limits', () => {
  const config = productionConfig();
  config.admin.authMode = 'passwordless-ish';
  config.secureDocuments.maxUploadBytes = -1;
  config.secureDocuments.maxTotalUploadBytes = 0;
  config.secureDocuments.maxConcurrentUploads = 1.5;
  config.dealHunter.dailyEmail.time = '29:99';
  config.dealHunter.cimFollowUp.checkIntervalMs = 0;
  config.dealHunter.cimFollowUp.timezone = 'Not/A-Timezone';
  config.backup = {
    time: '25:90',
    timezone: 'Not/A-Timezone',
    retentionDays: 0,
    retentionCount: 1.5,
    checkIntervalMs: -1,
  };

  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('ADMIN_AUTH_MODE')));
  assert.ok(result.errors.some((error) => error.includes('MAX_UPLOAD_BYTES')));
  assert.ok(result.errors.some((error) => error.includes('MAX_TOTAL_UPLOAD_BYTES')));
  assert.ok(result.errors.some((error) => error.includes('MAX_CONCURRENT_UPLOADS')));
  assert.ok(result.errors.some((error) => error.includes('DAILY_EMAIL_TIME')));
  assert.ok(result.errors.some((error) => error.includes('CIM_FOLLOW_UP_CHECK_INTERVAL_MS')));
  assert.ok(result.errors.some((error) => error.includes('CIM_FOLLOW_UP_TIMEZONE')));
  assert.ok(result.errors.some((error) => error.includes('BACKUP_DAILY_TIME')));
  assert.ok(result.errors.some((error) => error.includes('BACKUP_TIMEZONE')));
  assert.ok(result.errors.some((error) => error.includes('BACKUP_RETENTION_DAYS')));
  assert.ok(result.errors.some((error) => error.includes('BACKUP_RETENTION_COUNT')));
  assert.ok(result.errors.some((error) => error.includes('BACKUP_CHECK_INTERVAL_MS')));
  assert.ok(result.errors.some((error) => error.includes('authentication path')));
});

test('production password auth must include usable credentials', () => {
  const config = productionConfig();
  config.admin.authMode = 'password';
  config.admin.allowPasswordAuth = true;
  config.admin.username = '';
  config.admin.password = '';

  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('authentication path')));
});

test('configuration rejects unsafe origins, ports, retention, and resource limits', () => {
  const config = productionConfig();
  config.server = {
    origin: 'https://www.example.com/unexpected-path?token=leak',
    port: 70_000,
    outboundRequestTimeoutMs: 10_000,
  };
  config.protection = {
    rateLimitWindowMs: 600_000,
    rateLimitRetentionMs: 60_000,
    rateLimitMax: 6,
    minSubmitTimeMs: 0,
    spamScoreThreshold: -1,
  };
  config.dealHunter.lookbackDays = -4;
  config.dealHunter.maxSourceRecords = 1.5;

  const result = validateConfig(config);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('PUBLIC_SITE_URL')));
  assert.ok(result.errors.some((error) => error.includes('PORT')));
  assert.ok(result.errors.some((error) => error.includes('RATE_LIMIT_RETENTION_MS must be greater')));
  assert.ok(result.errors.some((error) => error.includes('MIN_SUBMIT_TIME_MS')));
  assert.ok(result.errors.some((error) => error.includes('SPAM_SCORE_THRESHOLD')));
  assert.ok(result.errors.some((error) => error.includes('DEAL_HUNTER_LOOKBACK_DAYS')));
  assert.ok(result.errors.some((error) => error.includes('DEAL_HUNTER_MAX_SOURCE_RECORDS')));
});
