import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';

function createStorage() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-scheduled-job-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'jobs.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  return { storage, tempDir };
}

test('scheduled job claim permits only one concurrent owner', async (t) => {
  const { storage, tempDir } = createStorage();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const nowIso = '2026-07-12T17:00:00.000Z';
  const attempts = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      storage.claimScheduledJob({
        jobKey: 'daily-deal-hunter-email:2026-07-12',
        jobName: 'daily-deal-hunter-email',
        triggeredBy: `worker-${index}`,
        nowIso,
        staleBefore: '2026-07-12T16:00:00.000Z',
      }),
    ),
  );

  assert.equal(attempts.filter((attempt) => attempt.claimed).length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.claimed).length, 9);
});

test('completed scheduled jobs cannot be reclaimed and failed jobs can retry', async (t) => {
  const { storage, tempDir } = createStorage();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const jobKey = 'daily-deal-hunter-email:2026-07-13';
  const first = await storage.claimScheduledJob({
    jobKey,
    jobName: 'daily-deal-hunter-email',
    triggeredBy: 'scheduler',
    nowIso: '2026-07-13T17:00:00.000Z',
  });
  assert.equal(first.claimed, true);

  await storage.completeScheduledJob(jobKey, {
    completed_at: '2026-07-13T17:01:00.000Z',
    status: 'completed',
    provider_message_id: 'email-123',
  });
  const completedClaim = await storage.claimScheduledJob({
    jobKey,
    jobName: 'daily-deal-hunter-email',
    triggeredBy: 'external-cron',
    nowIso: '2026-07-13T17:02:00.000Z',
  });
  assert.equal(completedClaim.claimed, false);
  assert.equal(completedClaim.run.status, 'completed');

  const retryKey = 'daily-deal-hunter-email:2026-07-14';
  await storage.claimScheduledJob({
    jobKey: retryKey,
    jobName: 'daily-deal-hunter-email',
    triggeredBy: 'scheduler',
    nowIso: '2026-07-14T17:00:00.000Z',
  });
  await storage.completeScheduledJob(retryKey, {
    completed_at: '2026-07-14T17:01:00.000Z',
    status: 'failed',
    last_error: 'provider unavailable',
  });
  const retry = await storage.claimScheduledJob({
    jobKey: retryKey,
    jobName: 'daily-deal-hunter-email',
    triggeredBy: 'scheduler',
    nowIso: '2026-07-14T17:30:00.000Z',
  });
  assert.equal(retry.claimed, true);
  assert.equal(retry.run.attempt_count, 2);
});
