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
import { RUNBOOK_STAGES, flyTomlEnv, productionSecrets } from './productionBootEnv.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configModuleUrl = pathToFileURL(path.join(rootDir, 'server', 'config.js')).href;

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

test('production boots with the step 6 profile while the test-only settings are still set', () => {
  // The go-live switch stages the profile before removing the test-only settings. If removing
  // them failed, the app must still start, and must not keep the test's one allowed recipient.
  const booted = bootProductionConfig({ ...RUNBOOK_STAGES['step 5 controlled test through Gmail'],
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'production-gmail-v1' });
  assert.deepEqual(booted.errors, []);
  assert.equal(booted.delivery.provider, 'resend');
  assert.equal(booted.cimProvider.mode, 'production-gmail');
  assert.deepEqual(booted.cimProvider.allowedRecipients, []);
});

test('production boots after the go-live recovery command removes the profile', () => {
  // scripts/go-live-production-gmail.sh tells the owner to unset the profile if the switch's
  // deploy fails; with the test-only settings already gone, that must start the app.
  const { DEAL_HUNTER_CIM_PROVIDER_PROFILE: _profile, ...withoutProfile } = RUNBOOK_STAGES['step 6 production Gmail'];
  const booted = bootProductionConfig(withoutProfile);
  assert.deepEqual(booted.errors, []);
  assert.equal(booted.delivery.provider, 'resend');
  assert.notEqual(booted.cimProvider.provider, 'gmail');
});
