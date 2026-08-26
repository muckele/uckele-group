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
      if (run && run.status !== 'failed') {
        return { claimed: false, run };
      }

      run = {
        ...run,
        job_key: input.jobKey,
        status: 'pending',
        started_at: input.nowIso,
        attempt_count: Number(run?.attempt_count || 0) + 1,
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

test('ten overlapping degraded-alert triggers make one provider call', async () => {
  const storage = createJobStorage();
  let providerCalls = 0;
  const sendReview = async () => {
    providerCalls += 1;
    await Promise.resolve();
    return {
      notificationType: 'required-source-alert',
      emailResult: { status: 'sent', error: '', providerMessageId: 'alert-1' },
      review: { totals: {}, sources: [{ id: 'sheet-0', fetched: false }] },
      crmSync: { paused: true },
    };
  };
  const now = new Date('2026-07-13T18:00:00.000Z');
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (
    runClaimedDailyDealHunterEmail({
      triggeredBy: `alert-worker-${index}`,
      now,
      storage,
      sendReview,
      markerDir: '',
    })
  )));

  assert.equal(providerCalls, 1);
  assert.equal(results.filter((result) => result.emailResult.status === 'sent').length, 1);
  assert.equal(results.filter((result) => result.inProgress).length, 9);
  assert.equal(storage.run.status, 'completed');
  assert.equal(storage.run.metadata.notificationType, 'required-source-alert');
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

test('a failed provider attempt remains retryable under the same date claim', async () => {
  const storage = createJobStorage();
  const now = new Date('2026-07-15T18:00:00.000Z');
  let providerCalls = 0;
  const sendReview = async () => {
    providerCalls += 1;
    return providerCalls === 1
      ? { emailResult: { status: 'failed', error: 'provider unavailable', providerMessageId: '' }, review: { totals: {} } }
      : { emailResult: { status: 'sent', error: '', providerMessageId: 'retry-accepted' }, review: { totals: {} } };
  };

  const first = await runClaimedDailyDealHunterEmail({ now, storage, markerDir: '', sendReview });
  const second = await runClaimedDailyDealHunterEmail({ now, storage, markerDir: '', sendReview });

  assert.equal(first.emailResult.status, 'failed');
  assert.equal(second.emailResult.status, 'sent');
  assert.equal(providerCalls, 2);
  assert.equal(storage.run.status, 'completed');
  assert.equal(storage.run.attempt_count, 2);
});

test('one completed date cannot alternate from an alert to a normal digest', async () => {
  const storage = createJobStorage();
  const now = new Date('2026-07-18T18:00:00.000Z');
  let providerCalls = 0;
  const alert = await runClaimedDailyDealHunterEmail({
    now,
    storage,
    markerDir: '',
    sendReview: async () => {
      providerCalls += 1;
      return {
        notificationType: 'required-source-alert',
        emailResult: { status: 'sent', error: '', providerMessageId: 'alert-first' },
        review: { totals: {} },
      };
    },
  });
  const normal = await runClaimedDailyDealHunterEmail({
    now,
    storage,
    markerDir: '',
    sendReview: async () => {
      providerCalls += 1;
      return { emailResult: { status: 'sent', error: '', providerMessageId: 'digest-second' }, review: { totals: {} } };
    },
  });

  assert.equal(alert.notificationType, 'required-source-alert');
  assert.equal(normal.alreadySent, true);
  assert.equal(normal.emailResult.status, 'already-sent');
  assert.equal(providerCalls, 1);
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
          notificationType: 'required-source-alert',
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
