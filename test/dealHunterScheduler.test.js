import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runClaimedDailyDealHunterEmail, startDealHunterDailyEmailScheduler } from '../server/services/dealHunterScheduler.js';

function createJobStorage() {
  let run = null;

  return {
    async listEmailEvents() {
      return [];
    },
    async claimScheduledJob(input) {
      if (run) {
        return { claimed: false, run };
      }

      run = {
        job_key: input.jobKey,
        status: 'pending',
        started_at: input.nowIso,
        attempt_count: 1,
      };
      return { claimed: true, run };
    },
    async completeScheduledJob(jobKey, values) {
      run = {
        ...run,
        job_key: jobKey,
        status: values.status,
        completed_at: values.completed_at || new Date().toISOString(),
        provider_message_id: values.provider_message_id || '',
        last_error: values.last_error || '',
        metadata: values.metadata || {},
      };
      return run;
    },
    get run() {
      return run;
    },
  };
}

test('overlapping daily email triggers share one persistent claim', async () => {
  const storage = createJobStorage();
  let sendCount = 0;
  const sendReview = async () => {
    sendCount += 1;
    await Promise.resolve();
    return {
      emailResult: { status: 'sent', error: '', providerMessageId: 'email-1' },
      review: { totals: { reviewedDeals: 2 } },
      crmSync: { reviewed: 2 },
    };
  };
  const now = new Date('2026-07-12T18:00:00.000Z');
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      runClaimedDailyDealHunterEmail({
        triggeredBy: `worker-${index}`,
        now,
        storage,
        sendReview,
        markerDir: '',
      }),
    ),
  );

  assert.equal(sendCount, 1);
  assert.equal(results.filter((result) => result.emailResult.status === 'sent').length, 1);
  assert.equal(results.filter((result) => result.inProgress).length, 9);
  assert.equal(storage.run.status, 'completed');
});

test('failed daily email claims are persisted for a later retry', async () => {
  const storage = createJobStorage();
  const result = await runClaimedDailyDealHunterEmail({
    triggeredBy: 'scheduler',
    now: new Date('2026-07-15T18:00:00.000Z'),
    storage,
    markerDir: '',
    sendReview: async () => ({
      emailResult: { status: 'failed', error: 'provider unavailable', providerMessageId: '' },
      review: { totals: {} },
    }),
  });

  assert.equal(result.emailResult.status, 'failed');
  assert.equal(storage.run.status, 'failed');
  assert.equal(storage.run.last_error, 'provider unavailable');
});

test('scheduler keeps an in-progress date retryable', async () => {
  let attempts = 0;
  const scheduler = startDealHunterDailyEmailScheduler({
    getNow: () => new Date('2026-07-16T18:00:00.000Z'),
    scheduleTimer: () => ({ unref() {} }),
    scheduleOverride: {
      enabled: true,
      time: '00:00',
      timezone: 'UTC',
      retryIntervalMs: 0,
    },
    runEmail: async () => {
      attempts += 1;
      return attempts === 1
        ? { inProgress: true, emailResult: { status: 'in-progress' } }
        : { alreadySent: false, emailResult: { status: 'sent', error: '' } };
    },
  });

  await scheduler.tick();
  await scheduler.tick();
  scheduler.stop();
  assert.equal(attempts, 2);
});

test('confirmed delivery is not marked failed when completion bookkeeping crashes', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-email-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const storage = createJobStorage();
  const originalComplete = storage.completeScheduledJob;
  let completeAttempts = 0;
  storage.completeScheduledJob = async (...args) => {
    completeAttempts += 1;
    if (completeAttempts === 1) {
      throw new Error('database unavailable after provider acceptance');
    }
    return originalComplete.apply(storage, args);
  };
  let sendCount = 0;
  const now = new Date('2026-07-17T18:00:00.000Z');

  await assert.rejects(
    runClaimedDailyDealHunterEmail({
      now,
      storage,
      markerDir,
      sendReview: async ({ idempotencyKey }) => {
        sendCount += 1;
        assert.match(idempotencyKey, /2026-07-17/);
        return {
          emailResult: { status: 'sent', error: '', providerMessageId: 'accepted-message' },
          review: { totals: {} },
        };
      },
    }),
    (error) => error.deliveryConfirmed === true,
  );

  const retry = await runClaimedDailyDealHunterEmail({ now, storage, markerDir, sendReview: async () => {
    sendCount += 1;
    throw new Error('must not resend');
  } });
  assert.equal(retry.alreadySent, true);
  assert.equal(sendCount, 1);
  assert.notEqual(storage.run?.status, 'failed');
});
