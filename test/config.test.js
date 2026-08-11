import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('AI enablement requires explicit bounded controls and documented rollout gates', () => {
  const config = productionConfig();
  config.followUp = {
    aiEnabled: true,
    aiModel: 'gpt-5.6-terra',
    aiApiKeyConfigured: true,
    aiReasoningEffort: 'implicit-default',
    aiTimeoutMs: 999,
    aiMaxContextChars: 1_999,
    aiMaxOutputTokens: 128,
    aiMaxRetries: 3,
    aiRateLimitPerMinute: 121,
    aiDataHandlingApprovalId: '',
    aiAcceptedEvalVersion: '',
    aiCostRateApprovalId: '',
    aiSyntheticSmokeId: '',
  };

  const blocked = validateConfig(config);
  assert.equal(blocked.ok, false);
  for (const setting of [
    'FOLLOW_UP_AI_REASONING_EFFORT',
    'FOLLOW_UP_AI_TIMEOUT_MS',
    'FOLLOW_UP_AI_MAX_CONTEXT_CHARS',
    'FOLLOW_UP_AI_MAX_OUTPUT_TOKENS',
    'FOLLOW_UP_AI_MAX_RETRIES',
    'FOLLOW_UP_AI_RATE_LIMIT_PER_MINUTE',
    'FOLLOW_UP_AI_DATA_HANDLING_APPROVAL_ID',
    'FOLLOW_UP_AI_ACCEPTED_EVAL_VERSION',
    'FOLLOW_UP_AI_COST_RATE_APPROVAL_ID',
    'FOLLOW_UP_AI_SYNTHETIC_SMOKE_ID',
  ]) {
    assert.ok(blocked.errors.some((error) => error.includes(setting)), `${setting} should block enablement`);
  }

  Object.assign(config.followUp, {
    aiReasoningEffort: 'low',
    aiTimeoutMs: 12_000,
    aiMaxContextChars: 30_000,
    aiMaxOutputTokens: 1_600,
    aiMaxRetries: 0,
    aiRateLimitPerMinute: 10,
    aiDataHandlingApprovalId: 'privacy-review-2026-08',
    aiAcceptedEvalVersion: 'follow-up-eval-v1',
    aiCostRateApprovalId: 'operations-envelope-2026-08',
    aiSyntheticSmokeId: 'synthetic-smoke-2026-08',
  });
  const configured = validateConfig(config);
  assert.equal(configured.ok, true);
});

test('environment parsing does not normalize invalid AI enablement controls into passing values', () => {
  const configModuleUrl = new URL('../server/config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    `import { getConfig, validateConfig } from ${JSON.stringify(configModuleUrl)};`,
    'const config = getConfig();',
    'const validation = validateConfig(config);',
    'console.log(JSON.stringify({ apiKeyConfigured: config.followUp.aiApiKeyConfigured, errors: validation.errors }));',
  ].join('\n')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      FOLLOW_UP_AI_ENABLED: 'true',
      FOLLOW_UP_AI_MODEL: 'gpt-test',
      OPENAI_API_KEY: '   ',
      FOLLOW_UP_AI_REASONING_EFFORT: 'low',
      FOLLOW_UP_AI_TIMEOUT_MS: 'not-a-number',
      FOLLOW_UP_AI_MAX_CONTEXT_CHARS: '1999',
      FOLLOW_UP_AI_MAX_OUTPUT_TOKENS: '128',
      FOLLOW_UP_AI_MAX_RETRIES: '3',
      FOLLOW_UP_AI_RATE_LIMIT_PER_MINUTE: '121',
      FOLLOW_UP_AI_DATA_HANDLING_APPROVAL_ID: 'privacy-review',
      FOLLOW_UP_AI_ACCEPTED_EVAL_VERSION: 'follow-up-eval-v1',
      FOLLOW_UP_AI_COST_RATE_APPROVAL_ID: 'cost-review',
      FOLLOW_UP_AI_SYNTHETIC_SMOKE_ID: 'synthetic-smoke',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim());
  assert.equal(parsed.apiKeyConfigured, false);
  for (const setting of [
    'OPENAI_API_KEY',
    'FOLLOW_UP_AI_TIMEOUT_MS',
    'FOLLOW_UP_AI_MAX_CONTEXT_CHARS',
    'FOLLOW_UP_AI_MAX_OUTPUT_TOKENS',
    'FOLLOW_UP_AI_MAX_RETRIES',
    'FOLLOW_UP_AI_RATE_LIMIT_PER_MINUTE',
  ]) {
    assert.ok(parsed.errors.some((error) => error.includes(setting)), `${setting} should remain invalid`);
  }
});

test('Deal Hunter parses explicit Airtable retirement and validates Deal OS import bounds', () => {
  const configModuleUrl = new URL('../server/config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    `import { getConfig, validateConfig } from ${JSON.stringify(configModuleUrl)};`,
    'const config = getConfig();',
    'const validation = validateConfig(config);',
    'console.log(JSON.stringify({ dealHunter: config.dealHunter, errors: validation.errors }));',
  ].join('\n')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DEAL_HUNTER_AIRTABLE_ENABLED: 'false',
      DEAL_HUNTER_DEAL_OS_EXPORT_MAX_PAYLOAD_BYTES: 'not-a-number',
      DEAL_HUNTER_DEAL_OS_EXPORT_MAX_RECORDS: '1001',
      DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS: '721',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim());
  assert.equal(parsed.dealHunter.airtableEnabled, false);
  assert.ok(parsed.errors.some((error) => error.includes('DEAL_HUNTER_DEAL_OS_EXPORT_MAX_PAYLOAD_BYTES')));
  assert.ok(parsed.errors.some((error) => error.includes('DEAL_HUNTER_DEAL_OS_EXPORT_MAX_RECORDS')));
  assert.ok(parsed.errors.some((error) => error.includes('DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS')));
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
