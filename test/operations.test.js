import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { getOperationsCenter } from '../server/services/operations.js';

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
