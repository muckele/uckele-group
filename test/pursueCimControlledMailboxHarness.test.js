import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  P10B_EXECUTION_CONFIRMATION,
  buildP10bReviewArtifact,
  executeP10bControlledMailbox,
  prepareP10bControlledMailbox,
} from '../server/services/pursueCimControlledMailboxHarness.js';
import { readCimCurrentAuthority } from '../server/services/cimCampaignSafety.js';
import { loadBrokerMaterialsAuthority } from '../server/services/dealHunterBrokerMaterials.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const now = '2026-10-01T16:00:00.000Z';
const controlledTemplateVersion = 'p10b-controlled-mailbox-test-v1';
const controlledSubject = 'P10B controlled mailbox lifecycle test';
const controlledText = [
  'Hello,',
  '',
  'This is a controlled, synthetic end-to-end mailbox test for Uckele Group. It is not a request concerning a real business or transaction. Please reply so the authorized test can verify inbound routing and reconciliation.',
  '',
  'Best,',
  'Uckele Group',
].join('\n');
const controlledHtml = '<!doctype html><html><body><p>Hello,</p><p>This is a controlled, synthetic end-to-end mailbox test for Uckele Group. It is not a request concerning a real business or transaction. Please reply so the authorized test can verify inbound routing and reconciliation.</p><p>Best,</p><p>Uckele Group</p></body></html>';

function readiness(overrides = {}) {
  return { version: 'cim-provider-readiness-v1', provider: 'resend',
    providerProfile: 'controlled-mailbox-v1', outboundConfigured: true,
    senderConfigured: true, senderAuthenticationAttested: true, webhookConfigured: true,
    requestReplyRoutingVerified: true, replyTrackingVerified: true,
    suppressionOperational: true, reconciliationOperational: true,
    evidenceRevision: 'p10b-fake-readiness-v1', generatedAt: now,
    expiresAt: '2026-10-01T16:10:00.000Z', ...overrides };
}

function controlledConfig(overrides = {}) {
  return {
    isProduction: false,
    server: { outboundRequestTimeoutMs: 100 },
    delivery: { provider: 'console', resendApiKey: '', resendFromEmail: '' },
    dealHunter: {
      cimAutomation: { schedulerEnabled: false },
      cimFollowUp: { enabled: false },
      cimOutreach: { paused: true },
      cimProvider: {
        enabled: false,
        profile: 'controlled-mailbox-v1',
        mode: 'controlled-mailbox',
        provider: 'resend',
        resendApiKey: 'fake-mailbox-outbound-key',
        resendFromEmail: 'P10B Sender <sender@mailbox.example.test>',
        resendReplyTo: 'replies@mailbox.example.test',
        resendInboundDomain: 'mailbox.example.test',
        emailWebhookSecret: 'fake-mailbox-webhook-secret',
        reconciliationApiKey: 'fake-mailbox-read-key',
        allowedRecipients: ['owner@example.test'],
        ...overrides,
      },
    },
  };
}

function report(overrides = {}) {
  return {
    projectedAt: now,
    opportunity: { id: 'opportunity-p10b', name: 'P10B Synthetic Test', state: 'active' },
    status: { code: 'prepared', reason: '', actionRequired: false },
    campaign: { id: 'campaign-p10b', generation: 1, state: 'initial-pending',
      policyVersion: 'deal-hunter-cim-autopilot-v1',
      templateVersion: 'deal-hunter-cim-autopilot-v1' },
    recipientAuthority: { address: 'owner@example.test', authorityId: 'recipient-p10b',
      fingerprint: 'a'.repeat(64), permissionVersion: 'activation-enrollment-p10b',
      permissionDigest: 'b'.repeat(64), permissionRevision: 1,
      permissionScope: 'c'.repeat(64) },
    transmission: {
      id: 'transmission-p10b', state: 'prepared', releaseState: 'ordinary', rowVersion: 1,
      preparationGeneration: 1, payloadVersion: controlledTemplateVersion,
      payloadDigest: 'd'.repeat(64), memberDigest: 'e'.repeat(64),
      addressing: { from: 'P10B Sender <sender@mailbox.example.test>',
        to: ['owner@example.test'], cc: [], bcc: [],
        replyTo: 'cim-conversation@mailbox.example.test' },
      copy: { subject: controlledSubject, text: controlledText, html: controlledHtml },
      membership: [{ opportunityId: 'opportunity-p10b', campaignId: 'campaign-p10b',
        touchId: 'touch-p10b', displayOrdinal: 0, cancelledAt: '', cancellationReason: '' }],
      createdAt: now, updatedAt: now, providerOutcome: null,
    },
    liveAuthorization: null,
    pause: { paused: true, source: 'durable', updatedAt: now },
    ...overrides,
  };
}

test('P10B prepare is hard-off, provider-inert, and returns exact immutable review content', async () => {
  const exactReport = report();
  let setupCalls = 0;
  let providerCalls = 0;
  const result = await prepareP10bControlledMailbox({
    storage: {}, config: controlledConfig(), actor: 'fixture-owner', now,
    synthetic: { runId: 'p10b-prepare', recipient: 'owner@example.test',
      permissionEvidenceId: 'permission-record-p10b',
      permissionEvidenceHash: 'f'.repeat(64) },
    services: {
      async setupSyntheticScenario() {
        setupCalls += 1;
        return { opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b' };
      },
      async getReleaseReport() { return exactReport; },
      async finalizeAuthorized() { providerCalls += 1; throw new Error('must not execute'); },
    },
  });

  assert.equal(setupCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(result.review.transmission.id, 'transmission-p10b');
  assert.equal(result.review.transmission.copy.text, exactReport.transmission.copy.text);
  assert.equal(result.review.transmission.payloadVersion, controlledTemplateVersion);
  assert.deepEqual(result.review.transmission.copy,
    { subject: controlledSubject, text: controlledText, html: controlledHtml });
  const { digest, ...canonicalReview } = result.review;
  assert.equal(digest, sha256(stableCanonicalJson(canonicalReview)));
  assert.match(result.review.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.executionAuthorized, false);
});

test('P10B review accepts only the service-owned controlled mailbox template', () => {
  for (const [name, changedReport] of [
    ['payload version', report({ transmission: { ...report().transmission,
      payloadVersion: 'deal-hunter-cim-manual-stage1-v1' } })],
    ['subject', report({ transmission: { ...report().transmission,
      copy: { ...report().transmission.copy, subject: 'Operator supplied subject' } } })],
    ['text', report({ transmission: { ...report().transmission,
      copy: { ...report().transmission.copy, text: 'Operator supplied body' } } })],
    ['html', report({ transmission: { ...report().transmission,
      copy: { ...report().transmission.copy, html: '<p>Operator supplied body</p>' } } })],
  ]) {
    assert.throws(() => buildP10bReviewArtifact(changedReport, {
      providerProfile: 'controlled-mailbox-v1', initialActivationId: 'activation-initial-p10b',
    }), /controlled mailbox template/i, name);
  }
  assert.throws(() => buildP10bReviewArtifact(report(), {
    providerProfile: 'controlled-mailbox-v2', initialActivationId: 'activation-initial-p10b',
  }), /controlled mailbox profile/i);
});

test('P10B CLI defaults to help and exposes only explicit prepare/execute modes', () => {
  const script = fileURLToPath(new URL('../scripts/run-pursue-cim-controlled-mailbox.js', import.meta.url));
  const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(output, /cim:p10b -- prepare/);
  assert.match(output, /cim:p10b -- execute/);
  assert.match(output, /Prepare is provider-inert/);
});

test('P10B CLI prepare creates a private exact review artifact with fake credentials only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/run-pursue-cim-controlled-mailbox.js', import.meta.url));
  const sqlitePath = path.join(directory, 'isolated-p10b.sqlite');
  const outputPath = path.join(directory, 'review.json');
  const output = execFileSync(process.execPath, [script, 'prepare',
    '--sqlite-path', sqlitePath, '--output', outputPath, '--run-id', 'p10b-cli-prepare',
    '--recipient', 'owner@example.test', '--permission-evidence-id', 'permission-record-p10b',
    '--permission-evidence-hash', 'f'.repeat(64), '--actor', 'fixture-owner'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false',
      DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1',
      DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY: 'fake-mailbox-outbound-key',
      DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: 'P10B Sender <sender@mailbox.example.test>',
      DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: 'replies@mailbox.example.test',
      DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: 'mailbox.example.test',
      DEAL_HUNTER_CIM_MAILBOX_WEBHOOK_SECRET: 'fake-mailbox-webhook-secret',
      DEAL_HUNTER_CIM_MAILBOX_RECONCILIATION_API_KEY: 'fake-mailbox-read-key',
      DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'owner@example.test',
      DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
      DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false' },
  });
  const result = JSON.parse(output);
  const preparation = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(result.mode, 'prepare');
  assert.equal(preparation.executionAuthorized, false);
  assert.equal(preparation.review.transmission.addressing.to[0], 'owner@example.test');
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(output.includes('owner@example.test'), false);
});

test('P10B prepare rejects unsafe configuration before synthetic setup', async (t) => {
  for (const [name, config] of [
    ['already enabled', controlledConfig({ enabled: true })],
    ['production runtime', { ...controlledConfig(), isProduction: true }],
    ['production profile', controlledConfig({ profile: 'production-resend-v1', mode: 'production' })],
    ['substituted profile', controlledConfig({ profile: 'controlled-mailbox-v2' })],
    ['multiple recipients', controlledConfig({ allowedRecipients: ['owner@example.test', 'other@example.test'] })],
  ]) {
    await t.test(name, async () => {
      let setupCalls = 0;
      await assert.rejects(prepareP10bControlledMailbox({ storage: {}, config,
        actor: 'fixture-owner', now,
        synthetic: { runId: 'p10b-denied', recipient: 'owner@example.test',
          permissionEvidenceId: 'permission-record-p10b',
          permissionEvidenceHash: 'f'.repeat(64) },
        services: { async setupSyntheticScenario() { setupCalls += 1; } },
      }), /controlled mailbox|hard-off|recipient/i);
      assert.equal(setupCalls, 0);
    });
  }
});

test('P10B prepare rejects substituted recipient and inbound-domain bindings', async (t) => {
  for (const [name, config, recipient, pattern] of [
    ['recipient', controlledConfig(), 'other@example.test', /recipient/i],
    ['domain', controlledConfig({ resendReplyTo: 'replies@other.example.test' }),
      'owner@example.test', /review binding|reply domain/i],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(prepareP10bControlledMailbox({ storage: {}, config,
        actor: 'fixture-owner', now,
        synthetic: { runId: `p10b-${name}-denied`, recipient,
          permissionEvidenceId: 'permission-record-p10b',
          permissionEvidenceHash: 'f'.repeat(64) },
        services: {
          async setupSyntheticScenario() {
            return { opportunityId: 'opportunity-p10b',
              initialActivationId: 'activation-initial-p10b' };
          },
          async getReleaseReport() { return report(); },
        },
      }), pattern);
    });
  }
});

test('P10B default synthetic setup uses public authorities to persist one provider-inert transmission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-harness-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'p10b.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const before = await storage.readCimOutreachCounters();
  const prepared = await prepareP10bControlledMailbox({ storage, config: controlledConfig(),
    actor: 'fixture-owner', now,
    synthetic: { runId: 'p10b-public-setup', recipient: 'owner@example.test',
      recipientDisplayName: 'Owner', permissionEvidenceId: 'permission-record-p10b',
      permissionEvidenceHash: 'f'.repeat(64) },
  });
  const after = await storage.readCimOutreachCounters();

  assert.equal(prepared.executionAuthorized, false);
  assert.equal(prepared.review.transmission.state, 'prepared');
  assert.equal(prepared.review.transmission.addressing.to[0], 'owner@example.test');
  assert.equal(prepared.review.transmission.payloadVersion, controlledTemplateVersion);
  assert.deepEqual(prepared.review.transmission.copy,
    { subject: controlledSubject, text: controlledText, html: controlledHtml });
  assert.doesNotMatch(prepared.review.transmission.copy.text,
    /Golden Behavior|Tripadvisor|Better Mortgage|Wayfair|equity|SBA|proof of funds/i);
  assert.equal(after.providerSeamEntries - before.providerSeamEntries, 0);
  assert.equal(after.providerPending - before.providerPending, 0);
  assert.equal(after.transmissions - before.transmissions, 1);
  const projection = await storage.readPursueCimProjection({ opportunityId: prepared.opportunityId });
  assert.equal(projection.transmission.state, 'prepared');
  assert.equal(await storage.getPursueCimLiveProviderAuthorization(
    projection.transmission.id), null);
});

test('P10B execute requires exact review digest and confirmation before authority or provider work', async (t) => {
  const review = buildP10bReviewArtifact(report(), { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  for (const [name, overrides] of [
    ['wrong digest', { reviewDigest: '0'.repeat(64) }],
    ['wrong confirmation', { confirmation: 'SEND IT' }],
    ['expired', { expiresAt: now }],
    ['too long', { expiresAt: '2026-10-01T16:15:00.001Z' }],
  ]) {
    await t.test(name, async () => {
      const counts = { issued: 0, pause: 0, provider: 0 };
      await assert.rejects(executeP10bControlledMailbox({
        storage: { async issueCimLiveProviderAuthorization() { counts.issued += 1; } },
        config: controlledConfig(), opportunityId: 'opportunity-p10b',
        initialActivationId: 'activation-initial-p10b', reviewDigest: review.digest,
        confirmation: P10B_EXECUTION_CONFIRMATION,
        expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
        providerReadiness: readiness(), ...overrides,
        services: {
          async getReleaseReport() { return report(); },
          async setPause() { counts.pause += 1; },
          async finalizeAuthorized() { counts.provider += 1; },
        },
      }), /digest|confirmation|expir/i);
      assert.deepEqual(counts, { issued: 0, pause: 0, provider: 0 });
    });
  }
});

test('P10B execute rejects caller-declared readiness before issuing authority', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  let issued = 0;
  await assert.rejects(executeP10bControlledMailbox({
    storage: { async issueCimLiveProviderAuthorization() { issued += 1; } },
    config: controlledConfig(), opportunityId: 'opportunity-p10b',
    initialActivationId: 'activation-initial-p10b', reviewDigest: review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION, expiresAt: '2026-10-01T16:10:00.000Z',
    actor: 'fixture-owner', now, providerReadiness: { ready: true },
    services: { async getReleaseReport() { return exactReport; } },
  }), /provider readiness.*unavailable/i);
  assert.equal(issued, 0);
});

test('P10B execute rejects durable payload, copy, and addressing drift from the reviewed artifact', async (t) => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  for (const [name, transmission] of [
    ['payload version', { ...exactReport.transmission, payloadVersion: 'changed-v1' }],
    ['subject', { ...exactReport.transmission,
      copy: { ...exactReport.transmission.copy, subject: 'Changed after review.' } }],
    ['text', { ...exactReport.transmission,
      copy: { ...exactReport.transmission.copy, text: 'Changed after review.' } }],
    ['html', { ...exactReport.transmission,
      copy: { ...exactReport.transmission.copy, html: '<p>Changed after review.</p>' } }],
    ['from', { ...exactReport.transmission, addressing: {
      ...exactReport.transmission.addressing, from: 'Other <other@mailbox.example.test>' } }],
    ['recipient', { ...exactReport.transmission, addressing: {
      ...exactReport.transmission.addressing, to: ['other@example.test'] } }],
    ['reply domain', { ...exactReport.transmission, addressing: {
      ...exactReport.transmission.addressing, replyTo: 'cim-conversation@other.example.test' } }],
  ]) {
    await t.test(name, async () => {
      const changedReport = report({ transmission });
      let issued = 0;
      await assert.rejects(executeP10bControlledMailbox({
        storage: { async issueCimLiveProviderAuthorization() { issued += 1; } },
        config: controlledConfig(), opportunityId: 'opportunity-p10b',
        initialActivationId: 'activation-initial-p10b', reviewDigest: review.digest,
        confirmation: P10B_EXECUTION_CONFIRMATION, expiresAt: '2026-10-01T16:10:00.000Z',
        actor: 'fixture-owner', now, providerReadiness: readiness(),
        services: { async getReleaseReport() { return changedReport; } },
      }), /controlled mailbox template|review binding|review digest does not match durable state/i);
      assert.equal(issued, 0);
    });
  }
});

test('P10B execute requires both cleanup transitions before issuing live authority', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  let issued = 0;
  await assert.rejects(executeP10bControlledMailbox({
    storage: { async issueCimLiveProviderAuthorization() { issued += 1; } },
    config: controlledConfig(), opportunityId: 'opportunity-p10b',
    initialActivationId: 'activation-initial-p10b', reviewDigest: review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION, expiresAt: '2026-10-01T16:10:00.000Z',
    actor: 'fixture-owner', now, providerReadiness: readiness(),
    services: { async getReleaseReport() { return exactReport; } },
  }), /cleanup storage is unavailable/i);
  assert.equal(issued, 0);
});

test('P10B execute admits one fake call and restores hard-off and durable pause', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  const calls = [];
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      calls.push(['issue', command]);
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization(command) {
      calls.push(['withdraw-authorization', command]);
      return { applied: false, conflict: true, authorization: { consumed_at: now } };
    },
    async withdrawCimCapabilityActivation(command) {
      calls.push(['withdraw-activation', command]);
      return { applied: true };
    },
  };
  let providerCalls = 0;
  const config = controlledConfig();
  const result = await executeP10bControlledMailbox({
    storage, config, opportunityId: 'opportunity-p10b',
    initialActivationId: 'activation-initial-p10b', reviewDigest: review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: readiness(),
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause({ paused }) { calls.push(['pause', paused]); },
      async authorizePrepared() {
        calls.push(['gate']);
        return { authorized: true, boundaryNonce: 'ephemeral-boundary-nonce',
          transmission: { id: 'transmission-p10b', state: 'provider-pending',
            row_version: 2, invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized({ configOverride }) {
        providerCalls += 1;
        assert.equal(configOverride.dealHunter.cimProvider.enabled, true);
        return { providerResult: { status: 'sent', provider: 'resend',
          providerAttempted: true, providerSeamEntered: true,
          providerMessageId: 'fake-provider-id' }, outcome: { category: 'accepted' },
          durableResult: { transmission: { state: 'accepted' } } };
      },
    },
  });

  assert.equal(providerCalls, 1);
  assert.deepEqual(calls.map(([name, value]) => name === 'pause' ? `${name}:${value}` : name),
    ['issue', 'pause:false', 'gate', 'pause:true', 'withdraw-authorization', 'withdraw-activation']);
  assert.equal(config.dealHunter.cimProvider.enabled, false);
  assert.equal(result.evidence.providerCalls, 1);
  assert.equal(result.evidence.productionProfileCalls, 0);
  assert.match(result.evidence.readinessDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.evidence).includes('p10b-fake-readiness-v1'), false);
  assert.equal(JSON.stringify(result.evidence).includes('owner@example.test'), false);
  assert.equal(JSON.stringify(result.evidence).includes(exactReport.transmission.copy.text), false);
  assert.equal(JSON.stringify(result.evidence).includes('fake-provider-id'), false);
});

test('P10B final-gate denial restores safety and records zero provider calls', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  const pauses = [];
  let providerCalls = 0;
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization() {
      return { applied: true, authorization: { withdrawn_at: now } };
    },
    async withdrawCimCapabilityActivation() { return { applied: true }; },
  };
  await assert.rejects(executeP10bControlledMailbox({ storage, config: controlledConfig(),
    opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b',
    reviewDigest: review.digest, confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: readiness(),
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause({ paused }) { pauses.push(paused); },
      async authorizePrepared() { return { authorized: false, blockedReason: 'authority_changed' }; },
      async finalizeAuthorized() { providerCalls += 1; },
    },
  }), (error) => {
    assert.equal(error.code, 'P10B_FINAL_GATE_DENIED');
    assert.equal(error.p10bEvidence.providerCalls, 0);
    assert.equal(error.p10bEvidence.cleanup.pauseRestored, true);
    assert.equal(error.p10bEvidence.cleanup.authorizationClosed, true);
    return true;
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(pauses, [false, true]);
});

test('P10B authorization response loss leaves pause on and closes all attempted authority', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  const calls = [];
  const storage = {
    async issueCimLiveProviderAuthorization() {
      calls.push('issue');
      throw new Error('synthetic authorization response loss');
    },
    async withdrawCimLiveProviderAuthorization() {
      calls.push('withdraw-authorization');
      return { applied: true };
    },
    async withdrawCimCapabilityActivation() {
      calls.push('withdraw-activation');
      return { applied: true };
    },
  };
  await assert.rejects(executeP10bControlledMailbox({ storage, config: controlledConfig(),
    opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b',
    reviewDigest: review.digest, confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: readiness(),
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause({ paused }) { calls.push(`pause:${paused}`); },
      async authorizePrepared() { calls.push('gate'); },
      async finalizeAuthorized() { calls.push('provider'); },
    },
  }), (error) => {
    assert.equal(error.message, 'synthetic authorization response loss');
    assert.equal(error.p10bEvidence.providerCalls, 0);
    assert.equal(error.p10bEvidence.cleanup.pauseRestored, true);
    assert.equal(error.p10bEvidence.cleanup.authorizationClosed, true);
    return true;
  });
  assert.deepEqual(calls, ['issue', 'pause:true', 'withdraw-authorization', 'withdraw-activation']);
});

test('P10B fails closed when cleanup returns still-live authority conflicts', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization() {
      return { applied: false, conflict: true,
        authorization: { consumed_at: null, withdrawn_at: null,
          expires_at: '2026-10-01T16:10:00.000Z' } };
    },
    async withdrawCimCapabilityActivation() {
      return { applied: false, conflict: true, activation: { status: 'current' } };
    },
  };
  await assert.rejects(executeP10bControlledMailbox({ storage, config: controlledConfig(),
    opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b',
    reviewDigest: review.digest, confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: readiness(),
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause() {},
      async authorizePrepared() { return { authorized: false, blockedReason: 'authority_changed' }; },
    },
  }), (error) => {
    assert.equal(error.code, 'P10B_CLEANUP_FAILED');
    assert.deepEqual(error.p10bEvidence.cleanup.errors,
      ['authorization_close_unproven', 'activation_close_unproven']);
    assert.equal(error.p10bEvidence.cleanup.authorizationClosed, false);
    assert.equal(error.p10bEvidence.cleanup.activationClosed, false);
    return true;
  });
});

test('P10B real SQLite authorities admit exactly one fake-provider call and replay sends zero', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-execute-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'p10b.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = controlledConfig();
  const prepared = await prepareP10bControlledMailbox({ storage, config,
    actor: 'fixture-owner', now,
    synthetic: { runId: 'p10b-real-authorities', recipient: 'owner@example.test',
      recipientDisplayName: 'Owner', permissionEvidenceId: 'permission-record-p10b',
      permissionEvidenceHash: 'f'.repeat(64) },
  });
  const sourceAuthority = await readCimCurrentAuthority({ storage,
    opportunityId: prepared.opportunityId,
    readSourceHealth: async () => ({ healthy: true, issues: [], requiredSources: ['sheet-0'] }) });
  assert.equal(sourceAuthority.blocked, false, JSON.stringify(sourceAuthority.blockers));
  const brokerAuthority = await loadBrokerMaterialsAuthority({ storage,
    opportunityId: prepared.opportunityId, now: new Date(prepared.preparedAt) });
  assert.deepEqual(brokerAuthority.preparationBlockers, []);
  let providerCalls = 0;
  const executionNow = prepared.preparedAt;
  const authorizationExpiresAt = new Date(Date.parse(executionNow) + 10 * 60 * 1000).toISOString();
  const result = await executeP10bControlledMailbox({ storage, config,
    opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: authorizationExpiresAt, actor: 'fixture-owner', now: executionNow,
    providerReadiness: readiness({ generatedAt: executionNow, expiresAt: authorizationExpiresAt }),
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: 'fake-resend-message-p10b' }), { status: 200 });
    },
  });
  assert.equal(result.evidence.outcome, 'accepted');
  assert.equal(result.evidence.providerCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal((await storage.getDealHunterCimSafetySettings()).outreach_paused, true);
  const projection = await storage.readPursueCimProjection({ opportunityId: prepared.opportunityId });
  assert.equal(projection.transmission.state, 'accepted');
  await assert.rejects(executeP10bControlledMailbox({ storage, config,
    opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: new Date(Date.parse(executionNow) + 11 * 60 * 1000).toISOString(),
    actor: 'fixture-owner', now: executionNow,
    providerReadiness: readiness({ generatedAt: executionNow,
      expiresAt: new Date(Date.parse(executionNow) + 11 * 60 * 1000).toISOString() }),
    fetcher: async () => { providerCalls += 1; throw new Error('must not replay'); },
  }), /prepared|unauthorized/i);
  assert.equal(providerCalls, 1);
});

test('P10B atomic gate rejects synthetic identity drift after the service snapshot', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-identity-race-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'p10b.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = controlledConfig();
  const prepared = await prepareP10bControlledMailbox({ storage, config,
    actor: 'fixture-owner', now,
    synthetic: { runId: 'p10b-synthetic-identity-race', recipient: 'owner@example.test',
      recipientDisplayName: 'Owner', permissionEvidenceId: 'permission-record-p10b',
      permissionEvidenceHash: 'f'.repeat(64) },
  });
  let mutationApplied = false;
  const racingStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property !== 'authorizeCimProviderPending') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (command) => {
        const opportunity = await target.getCurrentDealHunterOpportunity(prepared.opportunityId);
        await target.upsertDealHunterOpportunity({ ...opportunity, updated_at: prepared.preparedAt,
          metadata: { ...opportunity.metadata, p10bSynthetic: false } });
        mutationApplied = true;
        return target.authorizeCimProviderPending(command);
      };
    },
  });
  let providerCalls = 0;
  const expiresAt = new Date(Date.parse(prepared.preparedAt) + 10 * 60 * 1000).toISOString();
  await assert.rejects(executeP10bControlledMailbox({ storage: racingStorage, config,
    opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt, actor: 'fixture-owner', now: prepared.preparedAt,
    providerReadiness: readiness({ generatedAt: prepared.preparedAt, expiresAt }),
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
    },
  }), /final gate denied/i);
  assert.equal(mutationApplied, true);
  assert.equal(providerCalls, 0);
  assert.equal((await storage.readPursueCimProjection({
    opportunityId: prepared.opportunityId,
  })).transmission.state, 'cancelled-before-provider');
});

test('P10B crash, timeout, and unknown outcomes restore pause without another call', async (t) => {
  for (const outcome of ['crash', 'timeout', 'unknown']) {
    await t.test(outcome, async () => {
      const exactReport = report();
      const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
        initialActivationId: 'activation-initial-p10b' });
      const pauses = [];
      let providerCalls = 0;
      const storage = {
        async issueCimLiveProviderAuthorization(command) {
          return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
        },
        async withdrawCimLiveProviderAuthorization() {
          return { applied: false, conflict: true, authorization: { consumed_at: now } };
        },
        async withdrawCimCapabilityActivation() { return { applied: true }; },
      };
      const invoke = () => executeP10bControlledMailbox({ storage, config: controlledConfig(),
        opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b',
        reviewDigest: review.digest, confirmation: P10B_EXECUTION_CONFIRMATION,
        expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
        providerReadiness: readiness(),
        services: {
          async getReleaseReport() { return exactReport; },
          async setPause({ paused }) { pauses.push(paused); },
          async authorizePrepared() {
            return { authorized: true, boundaryNonce: 'ephemeral-boundary-nonce',
              transmission: { id: 'transmission-p10b', state: 'provider-pending',
                row_version: 2, invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
          },
          async finalizeAuthorized() {
            providerCalls += 1;
            if (outcome !== 'unknown') {
              const error = new Error(outcome === 'timeout'
                ? 'synthetic provider timeout' : 'synthetic provider crash');
              if (outcome === 'timeout') error.code = 'ETIMEDOUT';
              throw error;
            }
            return { providerResult: { status: 'failed', provider: 'resend',
              providerAttempted: true, providerSeamEntered: true,
              errorCategory: 'provider-outcome-unknown' },
              outcome: { category: 'ambiguous' }, durableResult: null };
          },
        },
      });
      if (outcome !== 'unknown') await assert.rejects(invoke(), (error) => {
        assert.match(error.message, new RegExp(`synthetic provider ${outcome}`));
        assert.equal(error.p10bEvidence.outcome, 'execution-error');
        assert.equal(error.p10bEvidence.providerCalls, null);
        assert.equal(error.p10bEvidence.cleanup.pauseRestored, true);
        return true;
      });
      else assert.equal((await invoke()).evidence.outcome, 'ambiguous');
      assert.equal(providerCalls, 1);
      assert.deepEqual(pauses, [false, true]);
    });
  }
});

test('P10B reports cleanup failure without exposing raw errors or enabling a second call', async () => {
  const exactReport = report();
  const review = buildP10bReviewArtifact(exactReport, { providerProfile: 'controlled-mailbox-v1',
    initialActivationId: 'activation-initial-p10b' });
  let providerCalls = 0;
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization() { return { applied: true }; },
    async withdrawCimCapabilityActivation() { return { applied: true }; },
  };
  await assert.rejects(executeP10bControlledMailbox({ storage, config: controlledConfig(),
    opportunityId: 'opportunity-p10b', initialActivationId: 'activation-initial-p10b',
    reviewDigest: review.digest, confirmation: P10B_EXECUTION_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: readiness(),
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause({ paused }) {
        if (paused) throw new Error('private database failure details');
      },
      async authorizePrepared() {
        return { authorized: true, boundaryNonce: 'ephemeral-boundary-nonce',
          transmission: { id: 'transmission-p10b', state: 'provider-pending',
            row_version: 2, invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized() {
        providerCalls += 1;
        return { providerResult: { status: 'sent', provider: 'resend',
          providerAttempted: true, providerSeamEntered: true },
          outcome: { category: 'accepted' }, durableResult: {} };
      },
    },
  }), (error) => {
    assert.equal(error.code, 'P10B_CLEANUP_FAILED');
    assert.deepEqual(error.p10bEvidence.cleanup.errors, ['pause_restore_failed']);
    assert.equal(error.p10bEvidence.cleanup.hardOffRestored, true);
    assert.equal(JSON.stringify(error.p10bEvidence).includes('private database'), false);
    return true;
  });
  assert.equal(providerCalls, 1);
});
