// The production app must still boot at every stage of the Gmail send rollout runbook
// (docs/runbooks/gmail-connect.md, Part C). On 2026-11-06 setting the step 5 controlled-test
// secrets took production down: the controlled profile blanked the app's own Resend settings and
// the startup config check refused to run. These tests boot the real fly.toml [env] plus a
// stand-in for every production secret, through the same getConfig + validateConfig the server
// runs at startup, for each stage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configModuleUrl = pathToFileURL(path.join(rootDir, 'server', 'config.js')).href;

/** The `KEY = "value"` lines of fly.toml's [env] section. */
function flyTomlEnv() {
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
function productionSecrets(dataDir) {
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

const RUNBOOK_STAGES = {
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

function bootProductionConfig(stageEnv, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-boot-'));
  try {
    // Only the variables production has: start from an empty environment, not the test runner's.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...flyTomlEnv(),
      ...productionSecrets(dataDir), ...stageEnv, ...extraEnv, NODE_ENV: 'production' };
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      `import { getConfig, validateConfig, getCimProviderDeliveryConfig, getCimWebhookAuthority } from ${JSON.stringify(configModuleUrl)};`,
      'const config = getConfig();',
      'const validation = validateConfig(config);',
      'const cim = getCimProviderDeliveryConfig(config).delivery;',
      'console.log(JSON.stringify({ errors: validation.errors, delivery: config.delivery,',
      '  followUp: { senderEmail: config.followUp.senderEmail, replyTo: config.followUp.replyTo },',
      '  cimProvider: config.dealHunter.cimProvider, webhook: getCimWebhookAuthority(config),',
      '  cimDelivery: { provider: cim.provider, resendApiKey: cim.resendApiKey } }));',
    ].join('\n')], { encoding: 'utf8', env, cwd: rootDir });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

for (const [stage, stageEnv] of Object.entries(RUNBOOK_STAGES)) {
  test(`production boots at runbook stage: ${stage}`, () => {
    const booted = bootProductionConfig(stageEnv);
    assert.deepEqual(booted.errors, []);
    // The app's own email (digest, sign-in links, notifications) keeps using Resend.
    assert.equal(booted.delivery.provider, 'resend');
    assert.equal(booted.delivery.resendApiKey, 're_test_key');
    assert.equal(booted.delivery.resendFromEmail, 'Uckele Group <hello@example.com>');
    assert.equal(booted.delivery.emailWebhookSecret, 'whsec_test');
    // Resend delivery events for the digest keep verifying against the app's webhook secret.
    assert.equal(booted.webhook.secret, 'whsec_test');
    assert.equal(booted.webhook.requireSignedProviderEvent, false);
  });
}

test('production also boots at stage 5 with CIM follow-ups enabled', () => {
  const booted = bootProductionConfig(RUNBOOK_STAGES['step 5 controlled test through Gmail'],
    { DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'true' });
  assert.deepEqual(booted.errors, []);
});

test('the step 5 controlled test sends broker email through Gmail to only the allowed inbox', () => {
  const booted = bootProductionConfig(RUNBOOK_STAGES['step 5 controlled test through Gmail']);
  assert.equal(booted.cimProvider.mode, 'controlled-mailbox');
  assert.equal(booted.cimProvider.provider, 'gmail');
  assert.deepEqual(booted.cimProvider.allowedRecipients, ['tester@example.net']);
  // Broker email never sees the app's Resend key while the controlled test is on.
  assert.equal(booted.cimDelivery.provider, 'gmail');
  assert.equal(booted.cimDelivery.resendApiKey, '');
});

test('the Resend controlled harness still blanks the app delivery settings', () => {
  const booted = bootProductionConfig({
    DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1',
    DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'tester@example.net',
  });
  assert.equal(booted.delivery.provider, 'console');
  assert.equal(booted.delivery.resendApiKey, '');
  assert.equal(booted.followUp.senderEmail, '');
  assert.equal(booted.webhook.requireSignedProviderEvent, true);
});

test('production names the cause when the controlled profile is set without the Gmail provider', () => {
  const booted = bootProductionConfig({
    DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1',
    DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'tester@example.net',
  });
  assert.match(booted.errors[0], /DEAL_HUNTER_CIM_MAILBOX_PROVIDER=gmail in production/);
});

test('the Gmail provider setting is matched without regard to case or spaces', () => {
  const booted = bootProductionConfig({ ...RUNBOOK_STAGES['step 5 controlled test through Gmail'],
    DEAL_HUNTER_CIM_MAILBOX_PROVIDER: ' Gmail ' });
  assert.deepEqual(booted.errors, []);
  assert.equal(booted.cimProvider.provider, 'gmail');
});
