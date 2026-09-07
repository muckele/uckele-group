import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { getOperationsCenter, sanitizeViewerOperations } from '../server/services/operations.js';

const operationsNow = new Date('2026-09-05T16:00:00.000Z');

function completeOperationsChecks(sourceHealth = {
  generatedAt: operationsNow.toISOString(), healthy: true, issues: [],
  sources: [{ id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', required: true, sourceRole: 'required-primary', fetched: true, rowCount: 12 }], totals: {},
}) {
  return {
    async sourceHealth() { return sourceHealth; },
    async disk() { return { ok: true, totalBytes: 100, freeBytes: 50, usedBytes: 50, freePercent: 50 }; },
    async database() { return { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 10 }; },
    async backup() { return { status: 'healthy', message: 'Backup is healthy.', latest: null }; },
    async emailReadiness() { return { provider: 'resend', issues: [] }; },
    async cimAutomation() { return { configuredStage: 1, effectiveStage: 1, paused: true, metrics: {}, policy: {} }; },
    async communications() { return { pending: 0, failed: 0, unassigned: 0 }; },
    async cimIdentity() { return { pause: { paused: true, source: 'configuration' }, storageHealthy: true }; },
  };
}

function operationsConfig() {
  return {
    storage: { provider: 'sqlite', sqlitePath: path.join('/tmp', 'operations.sqlite') },
    delivery: { provider: 'resend' },
    dealHunter: {
      dailyEmail: { timezone: 'America/Los_Angeles', time: '08:00' },
      cimFollowUp: {},
    },
  };
}

function operationsStorage(runs = []) {
  return {
    async listScheduledJobs() { return runs; },
    async listAdminAuditEvents() { return []; },
    async listSecureDocumentCleanupJobs() { return []; },
    async listSourceHealthSnapshots() { return []; },
  };
}

test('Operations remains available with a sanitized per-panel error when one source rejects', async () => {
  const sensitiveFailure = '/private/data/operations.sqlite failed with secret-token';
  const storage = {
    listScheduledJobs() {
      throw new Error(sensitiveFailure);
    },
    async listAdminAuditEvents() {
      return [{ id: 'audit-1', actor: 'admin' }];
    },
    async listSecureDocumentCleanupJobs() {
      return [{ id: 'cleanup-1', status: 'completed', files: [] }];
    },
    async listSourceHealthSnapshots() {
      return [{ id: 'source-1', healthy: true }];
    },
  };
  const config = {
    storage: { provider: 'sqlite', sqlitePath: path.join('/tmp', 'operations.sqlite') },
  };
  const operations = await getOperationsCenter({
    storage,
    config,
    checks: {
      async sourceHealth() {
        return { generatedAt: '2026-07-13T12:00:00.000Z', healthy: true, issues: [], sources: [], totals: {} };
      },
      async disk() {
        return { ok: true, totalBytes: 100, freeBytes: 50, usedBytes: 50, freePercent: 50 };
      },
      async database() {
        return { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 10 };
      },
      async backup() {
        return { status: 'healthy', message: 'Backup is healthy.', latest: null, bundleCounts: { valid: 1, invalid: 0, incomplete: 0 } };
      },
      async communications() {
        return {
          pending: 2,
          failed: 1,
          unassigned: 3,
          recent: [{ subject: 'Sensitive inbound subject', body: 'Sensitive inbound body' }],
        };
      },
    },
  });

  assert.deepEqual(operations.scheduler.runs, []);
  assert.equal(operations.scheduler.error, 'Scheduler history is temporarily unavailable.');
  assert.equal(operations.audit.events.length, 1);
  assert.equal(operations.cleanup.jobs.length, 1);
  assert.equal(operations.sources.history.length, 1);
  assert.equal(operations.storage.database.ok, true);
  assert.equal(operations.backup.status, 'healthy');
  assert.deepEqual(operations.communications, { pending: 2, failed: 1, unassigned: 3, error: '' });
  assert.equal(JSON.stringify(operations).includes('Sensitive inbound'), false);
  assert.equal(JSON.stringify(operations).includes(sensitiveFailure), false);
});

test('Operations communication ingestion failure is isolated and never exposes the underlying error', async () => {
  const sensitiveFailure = 'provider failed while processing secret inbound body';
  const storage = {};
  const config = {
    storage: { provider: 'sqlite', sqlitePath: path.join('/tmp', 'operations.sqlite') },
    delivery: {},
    dealHunter: { cimFollowUp: {} },
  };
  const healthyChecks = {
    async sourceHealth() {
      return { generatedAt: '2026-08-06T12:00:00.000Z', healthy: true, issues: [], sources: [], totals: {} };
    },
    async disk() {
      return { ok: true, totalBytes: 100, freeBytes: 50, usedBytes: 50, freePercent: 50 };
    },
    async database() {
      return { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 10 };
    },
    async backup() {
      return { status: 'healthy', message: 'Backup is healthy.', latest: null };
    },
    async emailReadiness() {
      return { provider: 'console', issues: [] };
    },
    async cimAutomation() {
      return { configuredStage: 1, effectiveStage: 1, paused: true, metrics: {}, policy: {} };
    },
    async communications() {
      throw new Error(sensitiveFailure);
    },
  };

  const operations = await getOperationsCenter({ storage, config, checks: healthyChecks });

  assert.deepEqual(operations.communications, {
    pending: 0,
    failed: 0,
    unassigned: 0,
    error: 'Communication ingestion status is temporarily unavailable.',
  });
  assert.equal(JSON.stringify(operations).includes(sensitiveFailure), false);
});

test('viewer Operations projection retains aggregate Stage 2 gates and strips identities, addresses, bodies, and protected decision context', () => {
  const projected = sanitizeViewerOperations({
    scheduler: { runs: [{ job_key: 'job-1', job_name: 'shadow', status: 'completed', updated_at: '2026-08-12T12:00:00.000Z', last_error: 'private path' }] },
    audit: { events: [{ id: 'audit-1', actor: 'release-owner@example.test' }] },
    cleanup: { jobs: [], failures: [{ id: 'cleanup-1', lastError: 'private filename' }] },
    email: { testRecipient: 'admin@example.test', allowedTestRecipients: ['admin@example.test'] },
    cimAutomation: {
      configuredStage: 2,
      evidenceStage: 1,
      effectiveStage: 1,
      activation: { id: 'activation-1', actor: 'release-owner@example.test', reason: 'private reason', policyHash: 'policy' },
      policy: { policyHash: 'policy', physicalPostalAddress: '123 Private Address', complianceReference: 'private-compliance-reference', rules: {}, sourcePolicy: {} },
      metrics: {
        canonicalHumanReviews: 9,
        remainingStage2Reviews: 16,
        latestReviews: [{ original_recipient_email: 'broker@example.test', metadata: { body: 'private body' } }],
        responseOutcomes: { 'private-deal-key': 'positive' },
      },
      latestShadowRun: { id: 'run-1', mode: 'shadow', status: 'completed', considered_count: 4, metadata: { candidate: 'private candidate' } },
    },
    cimIdentity: {
      pause: { paused: true, source: 'operations-control', updatedAt: '2026-08-12T12:00:00.000Z', updatedBy: 'pause-owner@example.test' },
      canonicalOpportunities: 12,
      lastAudit: { mode: 'read-only', generatedAt: '2026-08-12T12:00:00.000Z', counts: { exceptions: 0 }, privateRows: ['broker-two@example.test'] },
    },
  });
  const serialized = JSON.stringify(projected);

  assert.equal(projected.viewerAggregateOnly, true);
  assert.equal(projected.cimAutomation.metrics.canonicalHumanReviews, 9);
  assert.equal(projected.cimAutomation.metrics.remainingStage2Reviews, 16);
  assert.equal(projected.cimAutomation.activation.actor, undefined);
  assert.equal(projected.cimAutomation.latestShadowRun.considered_count, 4);
  assert.equal(projected.cimIdentity.canonicalOpportunities, 12);
  assert.equal(projected.cimIdentity.pause.updatedBy, undefined);
  assert.equal(projected.cleanup.failureCount, 1);
  for (const forbidden of ['release-owner@example.test', 'admin@example.test', 'broker@example.test', 'pause-owner@example.test', 'broker-two@example.test', '123 Private Address', 'private-compliance-reference', 'private body', 'private-deal-key', 'private candidate', 'private path', 'private filename']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('operations sanitizes daily digest envelope and recipient from every scheduled job', async () => {
  const sentinels = [
    'recipient-sentinel@example.test', 'sender-sentinel@example.test', 'PRIVATE SUBJECT SENTINEL',
    'PRIVATE TEXT SENTINEL', 'PRIVATE HTML SENTINEL', 'CLAIM TOKEN SENTINEL',
    'IDEMPOTENCY SENTINEL', 'RAW METADATA SENTINEL', 'RAW PROVIDER ERROR SENTINEL',
  ];
  const operations = await getOperationsCenter({
    now: operationsNow,
    config: operationsConfig(),
    checks: completeOperationsChecks(),
    storage: operationsStorage([{
      job_key: 'daily-deal-hunter-email:2026-09-05',
      job_name: 'daily-deal-hunter-email',
      status: 'completed',
      created_at: '2026-09-05T15:00:00.000Z',
      updated_at: '2026-09-05T15:02:00.000Z',
      completed_at: '2026-09-05T15:02:00.000Z',
      attempt_count: 1,
      provider_message_id: 'resend-safe-123',
      last_error: sentinels[8],
      metadata: {
        businessDate: '2026-09-05', notificationType: 'normal-digest', provider: 'resend',
        recipient: sentinels[0], sender: sentinels[1], subject: sentinels[2], text: sentinels[3], html: sentinels[4],
        claimToken: sentinels[5], idempotencyKey: sentinels[6], rawMetadata: sentinels[7],
        preparedEnvelope: { to: sentinels[0], from: sentinels[1], subject: sentinels[2], text: sentinels[3], html: sentinels[4] },
        providerResponse: { error: sentinels[8] },
      },
    }]),
  });
  const serialized = JSON.stringify(operations);

  assert.equal(operations.dailyDigest?.status, 'completed');
  assert.equal(operations.dailyDigest?.providerMessageId, 'resend-safe-123');
  assert.equal(Object.hasOwn(operations.scheduler.runs[0], 'metadata'), false);
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false, sentinel);
  assert.equal(serialized.includes('preparedEnvelope'), false);
});

test('operations surfaces daily completed alert failed retry pending stale and ambiguous states', async (t) => {
  const cases = [
    ['completed', { status: 'completed', completed_at: '2026-09-05T15:02:00.000Z', metadata: { notificationType: 'normal-digest' } }, false],
    ['alert', { status: 'completed', completed_at: '2026-09-05T15:02:00.000Z', metadata: { notificationType: 'required-source-alert' } }, false],
    ['failed retry pending', { status: 'failed', metadata: { notificationType: 'normal-digest', failedAt: '2026-09-05T15:02:00.000Z', nextRetryAt: '2026-09-05T16:30:00.000Z', failureCategory: 'provider-nonacceptance' } }, false],
    ['stale pending', { status: 'pending', created_at: '2026-09-05T13:00:00.000Z', metadata: { notificationType: 'normal-digest' } }, true],
    ['ambiguous', { status: 'ambiguous', metadata: { notificationType: 'normal-digest', reconciliation: { checkedAt: '2026-09-05T15:30:00.000Z', source: 'provider-lookup', errorCategory: 'conflicting-provider-evidence', severity: 'high' } } }, true],
  ];

  for (const [name, run, attentionRequired] of cases) {
    await t.test(name, async () => {
      const operations = await getOperationsCenter({
        now: operationsNow,
        config: operationsConfig(),
        checks: completeOperationsChecks(),
        storage: operationsStorage([{
          job_key: 'daily-deal-hunter-email:2026-09-05', job_name: 'daily-deal-hunter-email', attempt_count: 2,
          ...run,
        }]),
      });
      assert.equal(operations.dailyDigest?.status, run.status);
      assert.equal(operations.dailyDigest?.notificationType, run.metadata.notificationType);
      assert.equal(operations.dailyDigest?.attentionRequired, attentionRequired);
    });
  }
});

test('operations reports marker mismatch without exposing marker content', async () => {
  const markerSentinel = 'PRIVATE MARKER PAYLOAD SENTINEL';
  const operations = await getOperationsCenter({
    now: operationsNow,
    config: operationsConfig(),
    checks: completeOperationsChecks(),
    storage: operationsStorage([{
      job_key: 'daily-deal-hunter-email:2026-09-05', job_name: 'daily-deal-hunter-email', status: 'ambiguous', attempt_count: 1,
      metadata: {
        businessDate: '2026-09-05', notificationType: 'normal-digest',
        reconciliation: { checkedAt: '2026-09-05T15:30:00.000Z', source: 'marker', errorCategory: 'marker-mismatch', severity: 'high' },
        marker: { raw: markerSentinel, payloadDigest: markerSentinel },
      },
    }]),
  });
  const serialized = JSON.stringify(operations);

  assert.equal(operations.dailyDigest?.markerStatus, 'mismatch');
  assert.equal(operations.dailyDigest?.attentionRequired, true);
  assert.equal(serialized.includes(markerSentinel), false);
  assert.equal(Object.hasOwn(operations.scheduler.runs[0], 'metadata'), false);
  assert.equal(Object.hasOwn(operations.dailyDigest, 'marker'), false);
});
