import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runClaimedDailyDealHunterEmail,
  shouldRunDailyDealHunterEmail,
  startDealHunterDailyEmailScheduler,
} from '../server/services/dealHunterScheduler.js';
import { buildDailyDealHunterEmailEnvelope } from '../server/services/dailyDealHunterDigest.js';
import { writeDailyDealHunterMarker } from '../server/services/dailyDealHunterReconciliation.js';

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

function taskThreeConfig(markerDir = '') {
  return {
    isProduction: true,
    server: { origin: 'https://internal.example.test', outboundRequestTimeoutMs: 100 },
    admin: { email: 'admin@example.test' },
    delivery: {
      provider: 'resend',
      resendApiKey: 're_test_only',
      resendFromEmail: 'Uckele Group <sender@example.test>',
      resendReplyTo: '',
      emailWebhookSecret: 'whsec_test_only',
    },
    dealHunter: {
      recipient: 'digest@example.test',
      dailyEmail: {
        enabled: true,
        time: '08:00',
        timezone: 'America/Los_Angeles',
        checkIntervalMs: 60_000,
        retryIntervalMs: 1_800_000,
        markerDir,
      },
    },
  };
}

function taskThreeProjection(notificationType = 'normal-digest', businessDate = '2026-07-15') {
  const alert = notificationType === 'required-source-alert';
  return {
    version: 'daily-deal-hunter-digest-v1',
    businessDate,
    generatedAt: `${businessDate}T15:00:00.000Z`,
    status: alert ? 'action-required' : 'ready',
    notificationType,
    sourceAuthority: {
      requiredHealthy: !alert,
      blockingIssues: alert ? [{
        sourceId: 'sheet-0', sourceName: 'SMB Deal Hunter Google Sheet', classification: 'unavailable',
        title: 'Required source is unavailable', message: 'Required source data is currently unavailable.',
        checkedAt: `${businessDate}T15:00:00.000Z`,
      }] : [],
      optionalWarnings: [],
    },
    summary: alert ? null : {
      needsReview: 1, highPriority: 1, watchlist: 0, lowConfidence: 0, currentOpportunities: 1,
    },
    topOpportunities: alert ? [] : [{
      opportunityId: 'opportunity-1', name: 'Durable Services', state: 'CA', fitScore: 91,
      scoreStatus: 'current', confidence: 'high', operatorPriority: 'pursue', reviewed: false,
      changedSinceReview: true, topStrength: 'Recurring revenue', topConcern: 'Customer concentration',
      workflow: { crmStatus: 'not-started', cimStatus: 'not-requested' },
      observationFreshness: `${businessDate}T14:55:00.000Z`,
    }],
    job: { status: '', attemptCount: 0, completedAt: '', notificationType },
    actionsAllowed: !alert,
    links: {
      inbox: 'https://internal.example.test/admin/deal-hunter',
      operations: 'https://internal.example.test/admin/deal-hunter?view=operations',
    },
  };
}

function createTaskThreeStorage(initialRun = null) {
  let run = initialRun ? structuredClone(initialRun) : null;
  const state = { events: [], transitions: [], claims: [], failCompletionCount: 0 };
  const allowed = {
    pending: new Set(['pending', 'transmitting', 'failed', 'ambiguous', 'completed']),
    transmitting: new Set(['failed', 'ambiguous', 'completed']),
    ambiguous: new Set(['completed']),
  };
  const immutable = new Set([
    'preparedEnvelope', 'payloadDigest', 'firstPreparedAt', 'preparedAt', 'businessDate',
    'pacificDate', 'dateKey', 'timezone', 'notificationType',
  ]);

  return {
    state,
    async getScheduledJob(key) {
      return run?.job_key === key ? structuredClone(run) : null;
    },
    async listEmailEvents({ source } = {}) {
      return state.events
        .filter((event) => !source || event.source === source)
        .map((event) => structuredClone(event));
    },
    async insertEmailEvent(event) {
      if (!state.events.some((item) => item.event_key && item.event_key === event.event_key)) {
        state.events.push(structuredClone(event));
      }
      return structuredClone(event);
    },
    async claimScheduledJob(input) {
      state.claims.push(structuredClone(input));
      if (!run) {
        run = {
          job_key: input.jobKey, job_name: input.jobName, status: 'pending',
          created_at: input.nowIso, updated_at: input.nowIso, started_at: input.nowIso,
          completed_at: null, triggered_by: input.triggeredBy, attempt_count: 1,
          provider_message_id: null, last_error: null,
          metadata: { ...(input.metadata || {}), claimToken: input.claimToken, claimedAt: input.nowIso },
        };
        return { applied: true, claimed: true, reason: 'claimed', run: structuredClone(run) };
      }
      if (run.status === 'completed') return { applied: false, claimed: false, reason: 'completed', run: structuredClone(run) };
      if (['transmitting', 'ambiguous'].includes(run.status)) {
        return { applied: false, claimed: false, reason: 'wrong-state', run: structuredClone(run) };
      }
      if (run.status === 'pending' && (!input.staleBefore || run.updated_at > input.staleBefore)) {
        return { applied: false, claimed: false, reason: 'active', run: structuredClone(run) };
      }
      if (run.status === 'failed' && (!run.metadata.nextRetryAt || !input.retryDueAt || run.metadata.nextRetryAt > input.retryDueAt)) {
        return { applied: false, claimed: false, reason: 'retry-not-due', run: structuredClone(run) };
      }
      const merged = { ...run.metadata, ...(input.metadata || {}) };
      for (const key of immutable) if (Object.hasOwn(run.metadata, key)) merged[key] = run.metadata[key];
      run = {
        ...run,
        status: 'pending', updated_at: input.nowIso, started_at: input.nowIso, completed_at: null,
        triggered_by: input.triggeredBy, attempt_count: run.attempt_count + 1,
        provider_message_id: null, last_error: null,
        metadata: { ...merged, claimToken: input.claimToken, claimedAt: input.nowIso },
      };
      return { applied: true, claimed: true, reason: 'claimed', run: structuredClone(run) };
    },
    async transitionScheduledJob(input) {
      state.transitions.push(structuredClone(input));
      if (!run || run.job_key !== input.jobKey) return { applied: false, reason: 'missing', run: null };
      if (run.status === 'completed') return { applied: false, reason: 'completed', run: structuredClone(run) };
      if (run.metadata.claimToken !== input.claimToken) return { applied: false, reason: 'not-owner', run: structuredClone(run) };
      if (!input.expectedStatuses.includes(run.status) || !allowed[run.status]?.has(input.status)) {
        return { applied: false, reason: 'wrong-state', run: structuredClone(run) };
      }
      if (input.status === 'completed' && state.failCompletionCount > 0) {
        state.failCompletionCount -= 1;
        throw new Error('database unavailable after provider acceptance');
      }
      const merged = { ...run.metadata, ...(input.metadataPatch || {}) };
      for (const key of immutable) if (Object.hasOwn(run.metadata, key)) merged[key] = run.metadata[key];
      if (input.status === 'failed') {
        merged.failedAt = input.nowIso;
        merged.nextRetryAt = new Date(Date.parse(input.nowIso) + 30 * 60 * 1000).toISOString();
      }
      run = {
        ...run,
        status: input.status,
        updated_at: input.nowIso,
        completed_at: input.status === 'completed' ? (input.completedAt || input.nowIso) : run.completed_at,
        provider_message_id: input.providerMessageId || run.provider_message_id,
        last_error: input.lastError || null,
        metadata: merged,
      };
      return { applied: true, reason: 'claimed', run: structuredClone(run) };
    },
    get run() { return run ? structuredClone(run) : null; },
  };
}

function taskThreeRunOptions({ storage, now, markerDir = '', projection, sendPrepared, buildDigest, ...rest }) {
  return {
    triggeredBy: 'scheduler',
    now,
    storage,
    markerDir,
    configOverride: taskThreeConfig(markerDir),
    buildDigest: buildDigest || (async () => projection || taskThreeProjection('normal-digest', shouldRunDailyDealHunterEmail({ now }).dateKey)),
    buildEnvelope: buildDailyDealHunterEmailEnvelope,
    sendPrepared: sendPrepared || (async () => ({
      status: 'sent', provider: 'resend', providerMessageId: 'resend-task-three-1', error: '', errorCategory: '',
    })),
    claimTokenFactory: () => `task-three-token-${String(storage.state.claims.length + 1).padStart(4, '0')}`,
    ...rest,
  };
}

test('daily scheduler is due at 08:00 Pacific in winter PST', () => {
  const before = shouldRunDailyDealHunterEmail({ now: new Date('2026-01-15T15:59:59.000Z'), scheduleTime: '08:00' });
  const due = shouldRunDailyDealHunterEmail({ now: new Date('2026-01-15T16:00:00.000Z'), scheduleTime: '08:00' });
  assert.deepEqual(before, { dateKey: '2026-01-15', due: false });
  assert.deepEqual(due, { dateKey: '2026-01-15', due: true });
});

test('daily scheduler is due at 08:00 Pacific in summer PDT', () => {
  assert.equal(shouldRunDailyDealHunterEmail({ now: new Date('2026-07-15T14:59:59.000Z'), scheduleTime: '08:00' }).due, false);
  assert.equal(shouldRunDailyDealHunterEmail({ now: new Date('2026-07-15T15:00:00.000Z'), scheduleTime: '08:00' }).due, true);
});

test('daily scheduler remains one-date once-only across the spring DST transition', () => {
  const instants = ['2026-03-08T14:59:59.000Z', '2026-03-08T15:00:00.000Z', '2026-03-08T16:00:00.000Z'];
  assert.deepEqual(instants.map((now) => shouldRunDailyDealHunterEmail({ now: new Date(now), scheduleTime: '08:00' })), [
    { dateKey: '2026-03-08', due: false }, { dateKey: '2026-03-08', due: true }, { dateKey: '2026-03-08', due: true },
  ]);
});

test('daily scheduler remains one-date once-only across the fall DST transition', () => {
  const instants = ['2026-11-01T15:59:59.000Z', '2026-11-01T16:00:00.000Z', '2026-11-01T17:00:00.000Z'];
  assert.deepEqual(instants.map((now) => shouldRunDailyDealHunterEmail({ now: new Date(now), scheduleTime: '08:00' })), [
    { dateKey: '2026-11-01', due: false }, { dateKey: '2026-11-01', due: true }, { dateKey: '2026-11-01', due: true },
  ]);
});

test('daily scheduler derives different keys across Pacific midnight', () => {
  const before = shouldRunDailyDealHunterEmail({ now: new Date('2026-07-15T06:59:59.000Z'), scheduleTime: '08:00' });
  const after = shouldRunDailyDealHunterEmail({ now: new Date('2026-07-15T07:00:00.000Z'), scheduleTime: '08:00' });
  assert.equal(before.dateKey, '2026-07-14');
  assert.equal(after.dateKey, '2026-07-15');
});

test('daily scheduler applies the approved weekend decision explicitly', () => {
  const saturday = shouldRunDailyDealHunterEmail({ now: new Date('2026-07-18T15:00:00.000Z'), scheduleTime: '08:00' });
  const sunday = shouldRunDailyDealHunterEmail({ now: new Date('2026-07-19T15:00:00.000Z'), scheduleTime: '08:00' });
  assert.deepEqual(saturday, { dateKey: '2026-07-18', due: true });
  assert.deepEqual(sunday, { dateKey: '2026-07-19', due: true });
});

test('daily scheduler delayed start after 08:00 attempts the same Pacific date', () => {
  assert.deepEqual(
    shouldRunDailyDealHunterEmail({ now: new Date('2026-07-15T17:00:00.000Z'), scheduleTime: '08:00' }),
    { dateKey: '2026-07-15', due: true },
  );
});

test('daily scheduler invalid timezone or wall time fails safely', () => {
  assert.deepEqual(shouldRunDailyDealHunterEmail({ timezone: 'Not/A-Timezone', scheduleTime: '08:00' }), { dateKey: '', due: false });
  assert.deepEqual(shouldRunDailyDealHunterEmail({ timezone: 'America/Los_Angeles', scheduleTime: '8:00' }), { dateKey: '', due: false });
});

test('automatic cron execution cannot bypass disabled daily scheduling', async () => {
  const storage = createTaskThreeStorage();
  const configOverride = taskThreeConfig();
  configOverride.dealHunter.dailyEmail.enabled = false;
  let providerCalls = 0;
  const result = await runClaimedDailyDealHunterEmail({
    ...taskThreeRunOptions({
      storage,
      now: new Date('2026-07-15T15:00:00.000Z'),
      sendPrepared: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
    }),
    configOverride,
    enforceDueTime: true,
  });
  assert.equal(result.emailResult.status, 'not-due');
  assert.equal(result.emailResult.errorCategory, 'schedule-disabled');
  assert.equal(storage.state.claims.length, 0);
  assert.equal(providerCalls, 0);
});

test('duplicate scheduler admin and cron triggers make one provider call', async () => {
  const storage = createTaskThreeStorage();
  const now = new Date('2026-07-15T15:00:00.000Z');
  let providerCalls = 0;
  const sendPrepared = async () => {
    providerCalls += 1;
    await Promise.resolve();
    return { status: 'sent', provider: 'resend', providerMessageId: 'resend-concurrent-1', error: '' };
  };
  const results = await Promise.all(['scheduler', 'admin', 'external-cron'].map((triggeredBy) => (
    runClaimedDailyDealHunterEmail({
      ...taskThreeRunOptions({ storage, now, sendPrepared }), triggeredBy,
    })
  )));
  assert.equal(providerCalls, 1);
  assert.equal(results.filter((result) => result.emailResult.status === 'sent').length, 1);
  assert.equal(storage.run.status, 'completed');
});

test('first claim durably prepares the exact envelope before provider transmission', async () => {
  const storage = createTaskThreeStorage();
  const transition = storage.transitionScheduledJob.bind(storage);
  let persistedEnvelope = null;
  let providerCalls = 0;
  storage.transitionScheduledJob = async (input) => {
    const result = await transition(input);
    if (input.status === 'pending' && input.metadataPatch?.preparedEnvelope) {
      assert.equal(result.applied, true);
      assert.equal(result.run.status, 'pending');
      persistedEnvelope = structuredClone(result.run.metadata.preparedEnvelope);
    }
    if (input.status === 'transmitting') assert.ok(persistedEnvelope);
    return result;
  };
  const result = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:00:00.000Z'),
    sendPrepared: async (message) => {
      providerCalls += 1;
      assert.equal(storage.run.status, 'transmitting');
      assert.deepEqual(message, persistedEnvelope);
      return { status: 'sent', provider: 'resend', providerMessageId: 'prepared-before-provider-1' };
    },
  }));
  assert.equal(result.emailResult.status, 'sent');
  assert.equal(providerCalls, 1);
  assert.equal(storage.run.metadata.payloadDigest, persistedEnvelope.payloadDigest);
});

test('completed source alert prevents a normal digest after same-date source recovery', async () => {
  const storage = createTaskThreeStorage();
  const now = new Date('2026-07-15T15:00:00.000Z');
  let projectionCalls = 0;
  let providerCalls = 0;
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now,
    buildDigest: async () => { projectionCalls += 1; return taskThreeProjection('required-source-alert'); },
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', provider: 'resend', providerMessageId: 'alert-1' }; },
  }));
  const second = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T16:00:00.000Z'),
    buildDigest: async () => { projectionCalls += 1; return taskThreeProjection('normal-digest'); },
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', provider: 'resend', providerMessageId: 'normal-1' }; },
  }));
  assert.equal(first.notificationType, 'required-source-alert');
  assert.equal(second.emailResult.status, 'already-sent');
  assert.equal(projectionCalls, 1);
  assert.equal(providerCalls, 1);
});

test('fresh pending returns in-progress and stale pending reuses its prepared envelope', async () => {
  const envelope = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
    preparedAt: '2026-07-15T15:00:00.000Z',
  });
  const storage = createTaskThreeStorage({
    job_key: 'daily-deal-hunter-email:2026-07-15', job_name: 'daily-deal-hunter-email', status: 'pending',
    created_at: '2026-07-15T15:00:00.000Z', updated_at: '2026-07-15T15:00:00.000Z', started_at: '2026-07-15T15:00:00.000Z',
    completed_at: null, attempt_count: 1, provider_message_id: null,
    metadata: { claimToken: 'old-task-three-token', claimedAt: '2026-07-15T15:00:00.000Z', businessDate: '2026-07-15', notificationType: 'normal-digest', preparedEnvelope: envelope, payloadDigest: envelope.payloadDigest },
  });
  let projectionCalls = 0;
  let providerCalls = 0;
  const fresh = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T15:59:59.000Z'), buildDigest: async () => { projectionCalls += 1; throw new Error('must not rebuild'); },
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', provider: 'resend', providerMessageId: 'stale-1' }; },
  }));
  const stale = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T16:00:00.000Z'), buildDigest: async () => { projectionCalls += 1; throw new Error('must not rebuild'); },
    sendPrepared: async (message) => { providerCalls += 1; assert.deepEqual(message, envelope); return { status: 'sent', provider: 'resend', providerMessageId: 'stale-1' }; },
  }));
  assert.equal(fresh.emailResult.status, 'in-progress');
  assert.equal(stale.emailResult.status, 'sent');
  assert.equal(projectionCalls, 0);
  assert.equal(providerCalls, 1);
});

test('definitive failure retries the exact envelope no earlier than thirty minutes', async () => {
  const storage = createTaskThreeStorage();
  const envelopes = [];
  let projectionCalls = 0;
  let providerCalls = 0;
  const sendPrepared = async (message) => {
    providerCalls += 1;
    envelopes.push(structuredClone(message));
    return providerCalls === 1
      ? { status: 'failed', provider: 'resend', definitiveFailure: true, errorCategory: 'provider-nonacceptance', error: 'rejected' }
      : { status: 'sent', provider: 'resend', providerMessageId: 'retry-accepted', error: '' };
  };
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T15:00:00.000Z'), sendPrepared,
    buildDigest: async () => { projectionCalls += 1; return taskThreeProjection(); },
  }));
  const early = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T15:29:59.000Z'), sendPrepared,
    buildDigest: async () => { projectionCalls += 1; return taskThreeProjection('required-source-alert'); },
  }));
  const retry = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T15:30:00.000Z'), sendPrepared,
    buildDigest: async () => { projectionCalls += 1; return taskThreeProjection('required-source-alert'); },
  }));
  assert.equal(first.emailResult.status, 'failed');
  assert.equal(first.jobRun.metadata.nextRetryAt, '2026-07-15T15:30:00.000Z');
  assert.equal(early.emailResult.status, 'retry-not-due');
  assert.equal(retry.emailResult.status, 'sent');
  assert.equal(providerCalls, 2);
  assert.equal(projectionCalls, 1);
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.equal(envelopes[1].idempotencyKey, 'daily-deal-hunter-email:2026-07-15');
});

test('ambiguous provider outcome never makes a second provider call', async () => {
  const storage = createTaskThreeStorage();
  let providerCalls = 0;
  const sendPrepared = async () => {
    providerCalls += 1;
    return { status: 'ambiguous', provider: 'resend', errorCategory: 'provider-timeout', error: 'timeout' };
  };
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({ storage, now: new Date('2026-07-15T15:00:00.000Z'), sendPrepared }));
  const replay = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({ storage, now: new Date('2026-07-15T15:10:00.000Z'), sendPrepared }));
  assert.equal(first.emailResult.status, 'ambiguous');
  assert.ok(['transmitting', 'ambiguous'].includes(replay.emailResult.status));
  assert.equal(providerCalls, 1);
  assert.ok(['transmitting', 'ambiguous'].includes(storage.run.status));
});

test('crash before provider boundary recovers after one hour', async () => {
  const storage = createTaskThreeStorage();
  let providerCalls = 0;
  await assert.rejects(runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:00:00.000Z'),
    buildDigest: async () => { throw new Error('crash before envelope persistence'); },
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
  })), /crash before envelope persistence/);
  assert.equal(storage.run.status, 'pending');
  assert.equal(providerCalls, 0);
  const recovered = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T16:00:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', provider: 'resend', providerMessageId: 'recovered-1' }; },
  }));
  assert.equal(recovered.emailResult.status, 'sent');
  assert.equal(providerCalls, 1);
});

test('crash after envelope persistence but before transmitting reuses the durable envelope', async () => {
  const storage = createTaskThreeStorage();
  const transition = storage.transitionScheduledJob.bind(storage);
  let failBoundary = true;
  let providerCalls = 0;
  storage.transitionScheduledJob = async (input) => {
    if (failBoundary && input.status === 'transmitting') {
      failBoundary = false;
      throw new Error('crash between preparation and provider boundary');
    }
    return transition(input);
  };
  await assert.rejects(runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:00:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not send before boundary'); },
  })), /between preparation and provider boundary/);
  const persistedEnvelope = structuredClone(storage.run.metadata.preparedEnvelope);
  assert.equal(storage.run.status, 'pending');
  assert.equal(providerCalls, 0);

  const recovered = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T16:00:00.000Z'),
    buildDigest: async () => { throw new Error('must not rebuild prepared authority'); },
    sendPrepared: async (message) => {
      providerCalls += 1;
      assert.deepEqual(message, persistedEnvelope);
      return { status: 'sent', provider: 'resend', providerMessageId: 'prepared-recovery-1' };
    },
  }));
  assert.equal(recovered.emailResult.status, 'sent');
  assert.equal(providerCalls, 1);
});

test('crash after provider boundary remains reconciliation-only', async () => {
  const storage = createTaskThreeStorage();
  let providerCalls = 0;
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:00:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('connection reset'); },
  }));
  const second = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T16:01:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not send'); },
    providerLookup: async () => [],
  }));
  assert.equal(first.emailResult.status, 'ambiguous');
  assert.equal(second.emailResult.status, 'ambiguous');
  assert.equal(providerCalls, 1);
  assert.equal(storage.run.status, 'ambiguous');
});

test('crash after provider acceptance reconciles from marker without resend', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-task-three-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const storage = createTaskThreeStorage();
  storage.state.failCompletionCount = 1;
  let providerCalls = 0;
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, markerDir, now: new Date('2026-07-15T15:00:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; return { status: 'sent', provider: 'resend', providerMessageId: 'accepted-marker-1' }; },
  }));
  const second = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, markerDir, now: new Date('2026-07-15T15:05:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not resend'); },
  }));
  assert.equal(first.emailResult.status, 'ambiguous');
  assert.equal(second.emailResult.status, 'already-sent');
  assert.equal(providerCalls, 1);
  assert.equal(storage.run.status, 'completed');
  assert.equal(storage.run.provider_message_id, 'accepted-marker-1');
});

test('marker and database finalization failure reconciles from the durable local event', async () => {
  const storage = createTaskThreeStorage();
  storage.state.failCompletionCount = 1;
  let providerCalls = 0;
  const first = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:00:00.000Z'),
    writeMarker: async () => { throw new Error('marker unavailable'); },
    sendPrepared: async () => {
      providerCalls += 1;
      return { status: 'sent', provider: 'resend', providerMessageId: 'accepted-event-1' };
    },
  }));
  assert.equal(first.emailResult.status, 'ambiguous');
  assert.equal(storage.run.status, 'transmitting');
  assert.equal(storage.state.events.length, 1);

  const reconciled = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage,
    now: new Date('2026-07-15T15:05:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not resend'); },
  }));
  assert.equal(reconciled.emailResult.status, 'already-sent');
  assert.equal(storage.run.status, 'completed');
  assert.equal(storage.run.provider_message_id, 'accepted-event-1');
  assert.equal(providerCalls, 1);
});

test('completed database row prevents resend when marker is missing', async () => {
  const envelope = buildDailyDealHunterEmailEnvelope({ projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test' });
  const storage = createTaskThreeStorage({
    job_key: 'daily-deal-hunter-email:2026-07-15', job_name: 'daily-deal-hunter-email', status: 'completed',
    created_at: '2026-07-15T15:00:00.000Z', updated_at: '2026-07-15T15:01:00.000Z', started_at: '2026-07-15T15:00:00.000Z',
    completed_at: '2026-07-15T15:01:00.000Z', attempt_count: 1, provider_message_id: 'completed-db-1',
    metadata: { claimToken: 'completed-task-three-token', businessDate: '2026-07-15', notificationType: 'normal-digest', preparedEnvelope: envelope, payloadDigest: envelope.payloadDigest, acceptedAt: '2026-07-15T15:01:00.000Z' },
  });
  let providerCalls = 0;
  const result = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, now: new Date('2026-07-15T16:00:00.000Z'),
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not resend'); },
  }));
  assert.equal(result.emailResult.status, 'already-sent');
  assert.equal(providerCalls, 0);
});

test('marker mismatch never authorizes completion or transmission', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-task-three-marker-mismatch-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const envelope = buildDailyDealHunterEmailEnvelope({ projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test' });
  const storage = createTaskThreeStorage({
    job_key: 'daily-deal-hunter-email:2026-07-15', job_name: 'daily-deal-hunter-email', status: 'transmitting',
    created_at: '2026-07-15T15:00:00.000Z', updated_at: '2026-07-15T15:00:00.000Z', started_at: '2026-07-15T15:00:00.000Z',
    completed_at: null, attempt_count: 1, provider_message_id: null,
    metadata: { claimToken: 'mismatch-task-three-token', businessDate: '2026-07-15', notificationType: 'normal-digest', preparedEnvelope: envelope, payloadDigest: envelope.payloadDigest, providerBoundaryAt: '2026-07-15T15:00:00.000Z' },
  });
  await writeDailyDealHunterMarker({
    markerDir,
    evidence: { version: 1, jobKey: storage.run.job_key, businessDate: '2026-07-15', notificationType: 'normal-digest', payloadDigest: 'b'.repeat(64), providerMessageId: 'mismatched-1', acceptedAt: '2026-07-15T15:00:01.000Z' },
  });
  let providerCalls = 0;
  const result = await runClaimedDailyDealHunterEmail(taskThreeRunOptions({
    storage, markerDir, now: new Date('2026-07-15T15:10:00.000Z'), providerLookup: async () => [],
    sendPrepared: async () => { providerCalls += 1; throw new Error('must not send'); },
  }));
  assert.equal(result.emailResult.status, 'transmitting');
  assert.equal(storage.run.status, 'transmitting');
  assert.equal(providerCalls, 0);
});
