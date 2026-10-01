import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  P10B_EXECUTION_CONFIRMATION,
  P10B_LIMITED_SMOKE_CONFIRMATION,
  buildP10bLimitedSmokePostRunAttestation,
  buildP10bReviewArtifact,
  executeP10bControlledMailbox,
  executeP10bLimitedFreeSmoke,
  prepareP10bControlledMailbox,
  prepareP10bLimitedFreeSmoke,
} from '../server/services/pursueCimControlledMailboxHarness.js';
import { readCleanImplementationHead } from '../scripts/run-pursue-cim-controlled-mailbox.js';
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
const limitedProfile = 'controlled-mailbox-limited-smoke-v1';
const limitedTemplateVersion = 'p10b-limited-free-smoke-test-v1';
const limitedSubject = 'P10B limited outbound-only smoke test';
const limitedText = [
  'Hello,',
  '',
  'This is a controlled, synthetic outbound-only smoke test for Uckele Group. It is not a request concerning a real business or transaction. No reply is requested or monitored.',
  '',
  'Best,',
  'Uckele Group',
].join('\n');
const limitedHtml = '<!doctype html><html><body><p>Hello,</p><p>This is a controlled, synthetic outbound-only smoke test for Uckele Group. It is not a request concerning a real business or transaction. No reply is requested or monitored.</p><p>Best,</p><p>Uckele Group</p></body></html>';
const databaseIdentityHash = '9'.repeat(64);
const implementationHead = '1'.repeat(40);

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

function limitedConfig(overrides = {}) {
  return {
    isProduction: false,
    server: { outboundRequestTimeoutMs: 100 },
    delivery: { provider: 'console', resendApiKey: '', resendFromEmail: '',
      resendReplyTo: '', resendInboundDomain: '', emailWebhookSecret: '' },
    dealHunter: {
      cimAutomation: { schedulerEnabled: false },
      cimFollowUp: { enabled: false },
      cimOutreach: { paused: true },
      cimProvider: {
        enabled: false,
        profile: limitedProfile,
        mode: 'controlled-mailbox-limited-smoke',
        provider: 'resend',
        resendApiKey: '',
        resendFromEmail: 'P10B Limited Smoke <sender@p10b.uckelegroup.com>',
        resendReplyTo: '', resendInboundDomain: '', emailWebhookSecret: '',
        reconciliationApiKey: '', sendingDomain: 'p10b.uckelegroup.com',
        apiKeyPermission: '', apiKeyDomainRestriction: '',
        allowedRecipients: ['mathew@uckelegroup.com'],
        ...overrides,
      },
    },
  };
}

function limitedExecutionConfig(overrides = {}) {
  return limitedConfig({ resendApiKey: 'fake-limited-sending-key',
    apiKeyPermission: 'sending-access',
    apiKeyDomainRestriction: 'p10b.uckelegroup.com', ...overrides });
}

function limitedReadiness(overrides = {}) {
  return { version: 'p10b-limited-free-smoke-readiness-v1', provider: 'resend',
    providerProfile: limitedProfile, outboundConfigured: true, senderConfigured: true,
    senderAuthenticationAttested: true, sendingDomainVerified: true,
    sendingDomain: 'p10b.uckelegroup.com', apiKeyPermission: 'sending-access',
    apiKeyDomainRestriction: 'p10b.uckelegroup.com', suppressionOperational: true,
    webhookConfigured: false, requestReplyRoutingVerified: false,
    replyTrackingVerified: false, reconciliationOperational: false,
    evidenceRevision: 'limited-dashboard-attestation-v1', generatedAt: now,
    expiresAt: '2026-10-01T16:10:00.000Z', ...overrides };
}

function limitedReport(overrides = {}) {
  const base = report();
  return { ...base,
    recipientAuthority: { ...base.recipientAuthority, address: 'mathew@uckelegroup.com' },
    transmission: { ...base.transmission, payloadVersion: limitedTemplateVersion,
      addressing: { from: 'P10B Limited Smoke <sender@p10b.uckelegroup.com>',
        to: ['mathew@uckelegroup.com'], cc: [], bcc: [], replyTo: '' },
      copy: { subject: limitedSubject, text: limitedText, html: limitedHtml } },
    ...overrides };
}

test('P10B limited prepare is keyless, no-reply, provider-inert, and permanently incomplete', async () => {
  const exactReport = limitedReport();
  let providerCalls = 0;
  const result = await prepareP10bLimitedFreeSmoke({ storage: {}, config: limitedConfig(),
    actor: 'fixture-owner', now, databaseIdentityHash, implementationHead,
    synthetic: { runId: 'p10b-limited-prepare', recipient: 'mathew@uckelegroup.com',
      permissionEvidenceId: 'permission-record-p10b', permissionEvidenceHash: 'f'.repeat(64) },
    services: {
      async setupSyntheticScenario() {
        return { opportunityId: 'opportunity-p10b',
          initialActivationId: 'activation-initial-p10b' };
      },
      async getReleaseReport() { return exactReport; },
      async finalizeAuthorized() { providerCalls += 1; },
    },
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.version, 'p10b-limited-free-smoke-preparation-v1');
  assert.equal(result.review.version, 'p10b-limited-free-smoke-review-v1');
  assert.equal(result.review.transmission.addressing.replyTo, '');
  assert.equal(result.review.transmission.copy.text, limitedText);
  assert.equal(result.review.databaseIdentityHash, databaseIdentityHash);
  assert.equal(result.review.implementationHead, implementationHead);
  assert.equal(result.review.p10bComplete, false);
  assert.equal(result.review.scenario74Passed, false);
  assert.equal(result.review.signedInboundCovered, false);
  assert.equal(result.review.reconciliationCovered, false);
  assert.equal(result.review.providerTenantIsolated, false);
});

test('P10B limited prepare rejects keys, inbound placeholders, reply copy, and envelope drift', async (t) => {
  const baseReport = limitedReport();
  for (const [label, config, exactReport, pattern] of [
    ['key present', limitedConfig({ resendApiKey: 'too-early' }), baseReport, /keyless/i],
    ['reply to', limitedConfig({ resendReplyTo: 'reply@p10b.uckelegroup.com' }), baseReport,
      /reply|inbound/i],
    ['webhook placeholder', limitedConfig({ emailWebhookSecret: 'dummy' }), baseReport,
      /inbound|webhook/i],
    ['reconciliation placeholder', limitedConfig({ reconciliationApiKey: 'dummy' }), baseReport,
      /reconciliation/i],
    ['wrong recipient', limitedConfig({ allowedRecipients: ['other@example.com'] }), baseReport,
      /recipient/i],
    ['wrong from domain', limitedConfig({
      resendFromEmail: 'sender@other.example.com' }), baseReport, /domain|sender/i],
    ['reply invitation', limitedConfig(), { ...baseReport, transmission: {
      ...baseReport.transmission, copy: { ...baseReport.transmission.copy,
        text: `${limitedText} Please reply.` } } }, /template/i],
  ]) {
    await t.test(label, async () => {
      let setupCalls = 0;
      await assert.rejects(prepareP10bLimitedFreeSmoke({ storage: {}, config,
        actor: 'fixture-owner', now, databaseIdentityHash, implementationHead,
        synthetic: { runId: `p10b-limited-${label}`, recipient: 'mathew@uckelegroup.com',
          permissionEvidenceId: 'permission-record-p10b',
          permissionEvidenceHash: 'f'.repeat(64) },
        services: {
          async setupSyntheticScenario() {
            setupCalls += 1;
            return { opportunityId: 'opportunity-p10b',
              initialActivationId: 'activation-initial-p10b' };
          },
          async getReleaseReport() { return exactReport; },
        },
      }), pattern);
      if (label !== 'reply invitation') assert.equal(setupCalls, 0);
    });
  }
});

async function prepareLimitedFixture() {
  const exactReport = limitedReport();
  const prepared = await prepareP10bLimitedFreeSmoke({ storage: {}, config: limitedConfig(),
    actor: 'fixture-owner', now, databaseIdentityHash, implementationHead,
    synthetic: { runId: 'p10b-limited-execute', recipient: 'mathew@uckelegroup.com',
      permissionEvidenceId: 'permission-record-p10b', permissionEvidenceHash: 'f'.repeat(64) },
    services: {
      async setupSyntheticScenario() {
        return { opportunityId: 'opportunity-p10b',
          initialActivationId: 'activation-initial-p10b' };
      },
      async getReleaseReport() { return exactReport; },
    },
  });
  return { exactReport, prepared };
}

test('P10B limited execute requires execution-only key scope and rejects fake inbound readiness', async (t) => {
  const { exactReport, prepared } = await prepareLimitedFixture();
  for (const [label, config, providerReadiness, confirmation, pattern] of [
    ['missing key', limitedConfig(), limitedReadiness(), P10B_LIMITED_SMOKE_CONFIRMATION,
      /sending key|outbound credential/i],
    ['wrong permission', limitedExecutionConfig({ apiKeyPermission: 'full-access' }),
      limitedReadiness(), P10B_LIMITED_SMOKE_CONFIRMATION, /permission|scope/i],
    ['wrong key domain', limitedExecutionConfig({ apiKeyDomainRestriction: 'other.example.com' }),
      limitedReadiness(), P10B_LIMITED_SMOKE_CONFIRMATION, /domain|scope/i],
    ['fake webhook readiness', limitedExecutionConfig(),
      limitedReadiness({ webhookConfigured: true }), P10B_LIMITED_SMOKE_CONFIRMATION,
      /inbound|webhook/i],
    ['canonical confirmation', limitedExecutionConfig(), limitedReadiness(),
      P10B_EXECUTION_CONFIRMATION, /confirmation/i],
  ]) {
    await t.test(label, async () => {
      let issued = 0;
      let providerCalls = 0;
      await assert.rejects(executeP10bLimitedFreeSmoke({
        storage: { async issueCimLiveProviderAuthorization() { issued += 1; } },
        config, opportunityId: prepared.opportunityId,
        initialActivationId: prepared.initialActivationId,
        reviewDigest: prepared.review.digest, confirmation,
        expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
        providerReadiness, databaseIdentityHash, implementationHead,
        services: {
          async getReleaseReport() { return exactReport; },
          async finalizeAuthorized() { providerCalls += 1; },
        },
      }), pattern);
      assert.equal(issued, 0);
      assert.equal(providerCalls, 0);
    });
  }
});

test('P10B limited execute rejects implementation-head drift before authorization or provider work', async () => {
  const { exactReport, prepared } = await prepareLimitedFixture();
  let issued = 0;
  let providerCalls = 0;
  await assert.rejects(executeP10bLimitedFreeSmoke({
    storage: { async issueCimLiveProviderAuthorization() { issued += 1; } },
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: limitedReadiness(), databaseIdentityHash,
    implementationHead: '2'.repeat(40),
    services: {
      async getReleaseReport() { return exactReport; },
      async finalizeAuthorized() { providerCalls += 1; },
    },
  }), /review digest|implementation head/i);
  assert.equal(issued, 0);
  assert.equal(providerCalls, 0);
});

test('P10B limited execute enters the fake provider seam once and emits partial evidence', async () => {
  const { exactReport, prepared } = await prepareLimitedFixture();
  const calls = [];
  let providerCalls = 0;
  let armedConfig;
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      calls.push('issue');
      assert.equal(command.providerProfile, limitedProfile);
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization() {
      calls.push('withdraw-authorization');
      return { applied: false, conflict: true, authorization: { consumed_at: now } };
    },
    async withdrawCimCapabilityActivation() {
      calls.push('withdraw-activation');
      return { applied: true };
    },
  };
  const result = await executeP10bLimitedFreeSmoke({ storage,
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: limitedReadiness(), databaseIdentityHash, implementationHead,
    services: {
      async getReleaseReport() { return exactReport; },
      async setPause({ paused }) { calls.push(`pause:${paused}`); },
      async authorizePrepared({ providerProfile, readProviderReadiness }) {
        assert.equal(providerProfile, limitedProfile);
        const readiness = await readProviderReadiness();
        assert.equal(readiness.ready, true);
        assert.equal(readiness.p10bComplete, false);
        assert.equal(readiness.webhookConfigured, false);
        return { authorized: true, boundaryNonce: 'ephemeral-boundary-nonce',
          transmission: { id: 'transmission-p10b', state: 'provider-pending',
            row_version: 2, invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized({ configOverride }) {
        providerCalls += 1;
        armedConfig = configOverride;
        assert.equal(configOverride.dealHunter.cimProvider.enabled, true);
        assert.equal(configOverride.dealHunter.cimProvider.resendApiKey,
          'fake-limited-sending-key');
        return { providerResult: { status: 'sent', provider: 'resend',
          providerAttempted: true, providerSeamEntered: true,
          providerMessageId: 'fake-limited-provider-id' },
        outcome: { category: 'accepted' }, durableResult: {} };
      },
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(armedConfig.dealHunter.cimProvider.enabled, false);
  assert.equal(armedConfig.dealHunter.cimProvider.resendApiKey, '');
  assert.deepEqual(calls, ['issue', 'pause:false', 'pause:true',
    'withdraw-authorization', 'withdraw-activation']);
  assert.equal(result.version, 'p10b-limited-free-smoke-execution-v1');
  assert.equal(result.evidence.version, 'p10b-limited-free-smoke-evidence-v1');
  assert.equal(result.evidence.providerCalls, 1);
  assert.equal(result.evidence.p10bComplete, false);
  assert.equal(result.evidence.scenario74Passed, false);
  assert.equal(result.evidence.signedInboundCovered, false);
  assert.equal(result.evidence.reconciliationCovered, false);
  assert.equal(result.evidence.providerTenantIsolated, false);
  assert.equal(result.evidence.databaseIdentityHash, databaseIdentityHash);
  assert.equal(result.evidence.implementationHead, implementationHead);
  assert.equal(JSON.stringify(result.evidence).includes('fake-limited-sending-key'), false);
  assert.equal(JSON.stringify(result.evidence).includes('fake-limited-provider-id'), false);
});

test('P10B limited provider-seam uncertainty records null calls, restores hard-off, and cannot retry', async () => {
  const { exactReport, prepared } = await prepareLimitedFixture();
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
  await assert.rejects(executeP10bLimitedFreeSmoke({ storage,
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: limitedReadiness(), databaseIdentityHash, implementationHead,
    services: {
      async getReleaseReport() { return exactReport; }, async setPause() {},
      async authorizePrepared() {
        return { authorized: true, boundaryNonce: 'nonce', transmission: {
          id: 'transmission-p10b', state: 'provider-pending', row_version: 2,
          invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized() {
        providerCalls += 1;
        throw new Error('synthetic response loss');
      },
    },
  }), (error) => {
    assert.equal(error.p10bEvidence.providerCalls, null);
    assert.equal(error.p10bEvidence.reconciliationOnly, true);
    assert.equal(error.p10bEvidence.cleanup.hardOffRestored, true);
    assert.equal(error.p10bEvidence.cleanup.pauseRestored, true);
    assert.equal(error.p10bEvidence.p10bComplete, false);
    return true;
  });
  assert.equal(providerCalls, 1);
});

test('P10B limited post-run attestation is separately hash-bound and never trusted lifecycle proof', async () => {
  const { exactReport, prepared } = await prepareLimitedFixture();
  const storage = {
    async issueCimLiveProviderAuthorization(command) {
      return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
    },
    async withdrawCimLiveProviderAuthorization() {
      return { applied: false, conflict: true, authorization: { consumed_at: now } };
    },
    async withdrawCimCapabilityActivation() { return { applied: true }; },
  };
  const execution = await executeP10bLimitedFreeSmoke({ storage,
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: limitedReadiness(), databaseIdentityHash, implementationHead,
    services: {
      async getReleaseReport() { return exactReport; }, async setPause() {},
      async authorizePrepared() {
        return { authorized: true, boundaryNonce: 'nonce', transmission: {
          id: 'transmission-p10b', state: 'provider-pending', row_version: 2,
          invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized() {
        return { providerResult: { providerAttempted: true, providerSeamEntered: true },
          outcome: { category: 'accepted' },
          durableResult: { applied: true, existing: false, conflict: false,
            transmission: { state: 'accepted' } } };
      },
    },
  });
  const runEvidenceRaw = `${JSON.stringify(execution.evidence, null, 2)}\n`;
  const attestation = buildP10bLimitedSmokePostRunAttestation({ runEvidenceRaw,
    review: prepared, actor: 'fixture-owner', observedAt: '2026-10-01T16:05:00.000Z',
    keyPermission: 'sending-access', keyDomainScope: 'p10b.uckelegroup.com',
    keyRevokedAt: '2026-10-01T16:04:00.000Z',
    secretRemovedAt: '2026-10-01T16:04:30.000Z', manualReceiptObserved: true,
    manualReceiptObservedAt: '2026-10-01T16:05:00.000Z' });
  assert.equal(attestation.version, 'p10b-limited-free-smoke-post-run-attestation-v1');
  assert.equal(attestation.runEvidenceDigest, sha256(runEvidenceRaw));
  assert.equal(attestation.reviewDigest, prepared.review.digest);
  assert.equal(attestation.databaseIdentityHash, databaseIdentityHash);
  assert.equal(attestation.implementationHead, implementationHead);
  assert.equal(attestation.authorizationIdHash, execution.evidence.authorizationIdHash);
  assert.equal(attestation.manualReceiptObserved, true);
  assert.equal(attestation.trustedLifecycleEvidence, false);
  assert.equal(attestation.runCleanupComplete, true);
  assert.equal(attestation.limitedSmokeSuccessful, true);
  assert.equal(attestation.p10bComplete, false);
  assert.equal(attestation.scenario74Passed, false);
});

test('P10B limited attestation cannot call provider acceptance successful without durable acceptance', async () => {
  const { exactReport, prepared } = await prepareLimitedFixture();
  const execution = await executeP10bLimitedFreeSmoke({
    storage: {
      async issueCimLiveProviderAuthorization(command) {
        return { issued: true, authorization: { id: command.id, maximum_calls: 1 } };
      },
      async withdrawCimLiveProviderAuthorization() {
        return { applied: false, conflict: true, authorization: { consumed_at: now } };
      },
      async withdrawCimCapabilityActivation() { return { applied: true }; },
    },
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: '2026-10-01T16:10:00.000Z', actor: 'fixture-owner', now,
    providerReadiness: limitedReadiness(), databaseIdentityHash, implementationHead,
    services: {
      async getReleaseReport() { return exactReport; }, async setPause() {},
      async authorizePrepared() {
        return { authorized: true, boundaryNonce: 'nonce', transmission: {
          id: 'transmission-p10b', state: 'provider-pending', row_version: 2,
          invocation_authority_count: 1, payload_digest: 'd'.repeat(64) } };
      },
      async finalizeAuthorized() {
        return { providerResult: { providerAttempted: true, providerSeamEntered: true },
          outcome: { category: 'accepted' }, durableResult: { applied: false,
            existing: false, conflict: true, transmission: { state: 'provider-pending' } } };
      },
    },
  });
  assert.equal(execution.evidence.providerOutcome, 'accepted');
  assert.equal(execution.evidence.outcome, 'ambiguous');
  assert.equal(execution.evidence.durableAcceptanceRecorded, false);
  const runEvidenceRaw = `${JSON.stringify(execution.evidence, null, 2)}\n`;
  const attestation = buildP10bLimitedSmokePostRunAttestation({ runEvidenceRaw,
    review: prepared, actor: 'fixture-owner', observedAt: '2026-10-01T16:05:00.000Z',
    keyPermission: 'sending-access', keyDomainScope: 'p10b.uckelegroup.com',
    keyRevokedAt: '2026-10-01T16:04:00.000Z',
    secretRemovedAt: '2026-10-01T16:04:30.000Z', manualReceiptObserved: true,
    manualReceiptObservedAt: '2026-10-01T16:05:00.000Z' });
  assert.equal(attestation.limitedSmokeSuccessful, false);
  assert.equal(attestation.p10bComplete, false);
});

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
  assert.match(output, /prepare-limited/);
  assert.match(output, /execute-limited/);
  assert.match(output, /attest-limited/);
});

test('P10B limited implementation identity requires the exact clean checkout head', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-head-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'p10b@example.test'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'P10B Fixture'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'implementation.js'), 'export const version = 1;\n');
  execFileSync('git', ['add', 'implementation.js'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: directory });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory,
    encoding: 'utf8' }).trim();
  assert.equal(readCleanImplementationHead(directory), head);
  fs.writeFileSync(path.join(directory, 'implementation.js'), 'export const version = 2;\n');
  assert.throws(() => readCleanImplementationHead(directory), /clean checkout/i);
  execFileSync('git', ['checkout', '--', 'implementation.js'], { cwd: directory });
  fs.writeFileSync(path.join(directory, 'untracked-implementation.js'), 'export const drift = true;\n');
  assert.throws(() => readCleanImplementationHead(directory), /clean checkout/i);
});

test('P10B limited CLI prepare is keyless and writes private partial evidence', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-limited-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/run-pursue-cim-controlled-mailbox.js', import.meta.url));
  const sqlitePath = path.join(directory, 'limited-p10b.sqlite');
  const outputPath = path.join(directory, 'review.json');
  const output = execFileSync(process.execPath, [script, 'prepare-limited',
    '--sqlite-path', sqlitePath, '--output', outputPath, '--run-id', 'p10b-limited-cli-prepare',
    '--recipient', 'mathew@uckelegroup.com',
    '--permission-evidence-id', 'permission-record-p10b',
    '--permission-evidence-hash', 'f'.repeat(64), '--actor', 'fixture-owner'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false',
      DEAL_HUNTER_CIM_PROVIDER_PROFILE: limitedProfile,
      DEAL_HUNTER_CIM_LIMITED_SMOKE_FROM_EMAIL:
        'P10B Limited Smoke <sender@p10b.uckelegroup.com>',
      DEAL_HUNTER_CIM_LIMITED_SMOKE_SENDING_DOMAIN: 'p10b.uckelegroup.com',
      DEAL_HUNTER_CIM_LIMITED_SMOKE_ALLOWED_RECIPIENTS: 'mathew@uckelegroup.com',
      DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
      DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false' },
  });
  const result = JSON.parse(output);
  const preparation = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(result.mode, 'prepare-limited');
  assert.equal(preparation.version, 'p10b-limited-free-smoke-preparation-v1');
  assert.equal(preparation.review.transmission.addressing.replyTo, '');
  assert.equal(preparation.review.p10bComplete, false);
  assert.match(preparation.review.databaseIdentityHash, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(output.includes('mathew@uckelegroup.com'), false);
});

test('P10B limited CLI writes a separate immutable hash-bound post-run attestation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-attestation-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/run-pursue-cim-controlled-mailbox.js', import.meta.url));
  const reviewDigest = 'a'.repeat(64);
  const reviewPath = path.join(directory, 'review.json');
  const evidencePath = path.join(directory, 'evidence.json');
  const outputPath = path.join(directory, 'attestation.json');
  const incomplete = { p10bComplete: false, scenario74Passed: false,
    signedInboundCovered: false, reconciliationCovered: false,
    providerTenantIsolated: false };
  const review = { version: 'p10b-limited-free-smoke-preparation-v1', review: {
    version: 'p10b-limited-free-smoke-review-v1', digest: reviewDigest,
    databaseIdentityHash, implementationHead, ...incomplete } };
  const evidence = { version: 'p10b-limited-free-smoke-evidence-v1',
    observedAt: now, reviewDigest, databaseIdentityHash, implementationHead,
    providerCalls: 0, outcome: 'authorization-denied',
    providerOutcome: 'authorization-denied', durableOutcome: 'unresolved',
    durableAcceptanceRecorded: false,
    authorizationIdHash: 'b'.repeat(64), ...incomplete };
  fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const output = execFileSync(process.execPath, [script, 'attest-limited',
    '--review', reviewPath, '--evidence', evidencePath, '--attestation-output', outputPath,
    '--observed-at', '2026-10-01T16:05:00.000Z', '--key-permission', 'sending-access',
    '--key-domain-scope', 'p10b.uckelegroup.com',
    '--key-revoked-at', '2026-10-01T16:04:00.000Z',
    '--secret-removed-at', '2026-10-01T16:04:30.000Z',
    '--manual-receipt', 'observed',
    '--manual-receipt-observed-at', '2026-10-01T16:05:00.000Z',
    '--actor', 'fixture-owner'], { encoding: 'utf8' });
  const attestation = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(JSON.parse(output).mode, 'attest-limited');
  assert.equal(attestation.runEvidenceDigest,
    sha256(fs.readFileSync(evidencePath, 'utf8')));
  assert.equal(attestation.trustedLifecycleEvidence, false);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.throws(() => execFileSync(process.execPath, [script, 'attest-limited',
    '--review', reviewPath, '--evidence', evidencePath, '--attestation-output', outputPath,
    '--observed-at', '2026-10-01T16:05:00.000Z', '--key-permission', 'sending-access',
    '--key-domain-scope', 'p10b.uckelegroup.com',
    '--key-revoked-at', '2026-10-01T16:04:00.000Z',
    '--secret-removed-at', '2026-10-01T16:04:30.000Z', '--manual-receipt', 'not-observed',
    '--actor', 'fixture-owner'], { encoding: 'utf8', stdio: 'pipe' }), /status 1|Command failed/i);
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

test('P10B limited real SQLite path enters one fake seam and replay enters zero', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-limited-execute-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'p10b.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const prepared = await prepareP10bLimitedFreeSmoke({ storage, config: limitedConfig(),
    actor: 'fixture-owner', now, databaseIdentityHash, implementationHead,
    synthetic: { runId: 'p10b-limited-real-authorities',
      recipient: 'mathew@uckelegroup.com', recipientDisplayName: 'Mathew',
      permissionEvidenceId: 'permission-record-p10b',
      permissionEvidenceHash: 'f'.repeat(64) } });
  assert.equal(prepared.review.transmission.addressing.replyTo, '');
  let providerCalls = 0;
  const expiresAt = new Date(Date.parse(prepared.preparedAt) + 10 * 60 * 1000).toISOString();
  const result = await executeP10bLimitedFreeSmoke({ storage,
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt, actor: 'fixture-owner', now: prepared.preparedAt,
    providerReadiness: limitedReadiness({ generatedAt: prepared.preparedAt, expiresAt }),
    databaseIdentityHash, implementationHead,
    fetcher: async (_url, options) => {
      providerCalls += 1;
      const payload = JSON.parse(options.body);
      assert.equal(Object.hasOwn(payload, 'reply_to'), false);
      return new Response(JSON.stringify({ id: 'fake-resend-message-p10b-limited' }),
        { status: 200 });
    } });
  assert.equal(result.evidence.outcome, 'accepted');
  assert.equal(result.evidence.providerCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal((await storage.getDealHunterCimSafetySettings()).outreach_paused, true);
  assert.equal((await storage.readPursueCimProjection({
    opportunityId: prepared.opportunityId })).transmission.state, 'accepted');
  await assert.rejects(executeP10bLimitedFreeSmoke({ storage,
    config: limitedExecutionConfig(), opportunityId: prepared.opportunityId,
    initialActivationId: prepared.initialActivationId,
    reviewDigest: prepared.review.digest, confirmation: P10B_LIMITED_SMOKE_CONFIRMATION,
    expiresAt: new Date(Date.parse(prepared.preparedAt) + 11 * 60 * 1000).toISOString(),
    actor: 'fixture-owner', now: prepared.preparedAt,
    providerReadiness: limitedReadiness({ generatedAt: prepared.preparedAt,
      expiresAt: new Date(Date.parse(prepared.preparedAt) + 11 * 60 * 1000).toISOString() }),
    databaseIdentityHash, implementationHead,
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
