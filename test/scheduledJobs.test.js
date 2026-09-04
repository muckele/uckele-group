import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dailyJobName = 'daily-deal-hunter-email';
const oneHourMs = 60 * 60 * 1000;
const startingHead = '7865e08feca43731865f3196cfec0b98837fe4cd';
const scheduledJobMigrationPath = path.join(
  repositoryRoot,
  'supabase/migrations/20260904120000_daily_digest_scheduled_job_fencing.sql',
);
const scheduledJobSchemaPath = path.join(repositoryRoot, 'supabase/schema.sql');
const scheduledJobPostgresEnabled = process.env.DAILY_DIGEST_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

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

function createAtomicStorage(t, prefix = 'ug-scheduled-job-atomic-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqlitePath = path.join(tempDir, 'jobs.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { storage, sqlitePath };
}

function atomicClaimInput(jobKey, claimToken, nowIso, overrides = {}) {
  return {
    jobKey,
    jobName: dailyJobName,
    triggeredBy: 'scheduler',
    claimToken,
    nowIso,
    staleBefore: new Date(Date.parse(nowIso) - oneHourMs).toISOString(),
    retryDueAt: nowIso,
    metadata: {
      businessDate: jobKey.slice(-10),
      notificationType: 'normal-digest',
    },
    ...overrides,
  };
}

function runClaimProcess(sqlitePath, input) {
  const source = `
    import { createSqliteStorage } from './server/storage/sqlite.js';
    const storage = createSqliteStorage({
      storage: { sqlitePath: process.env.SQLITE_PATH },
      protection: { rateLimitRetentionMs: 0 },
    });
    try {
      const result = await storage.claimScheduledJob(JSON.parse(process.env.CLAIM_INPUT));
      process.stdout.write(JSON.stringify(result));
    } finally {
      storage.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: repositoryRoot,
      env: { ...process.env, SQLITE_PATH: sqlitePath, CLAIM_INPUT: JSON.stringify(input) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(`SQLite claim worker exited ${status}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function preparedMetadata(businessDate) {
  return {
    businessDate,
    notificationType: 'normal-digest',
    firstPreparedAt: `${businessDate}T15:01:00.000Z`,
    payloadDigest: 'a'.repeat(64),
    preparedEnvelope: {
      to: 'internal@example.test',
      subject: `Daily Deal Hunter ${businessDate}`,
      text: 'Immutable prepared body',
    },
    volatile: 'initial',
  };
}

test('scheduled job claim returns one token owner across ten concurrent attempts', async (t) => {
  const { storage, sqlitePath } = createAtomicStorage(t, 'ug-scheduled-job-first-race-');
  const nowIso = '2026-09-04T15:00:00.000Z';
  const jobKey = `${dailyJobName}:2026-09-04`;
  const inputs = Array.from({ length: 10 }, (_, index) => atomicClaimInput(
    jobKey,
    `claim_first_${String(index).padStart(2, '0')}_${randomUUID()}`,
    nowIso,
    { triggeredBy: `worker-${index}` },
  ));

  const attempts = await Promise.all(inputs.map((input) => runClaimProcess(sqlitePath, input)));
  const winners = attempts.filter((attempt) => attempt.applied);
  const current = await storage.getScheduledJob(jobKey);

  assert.equal(winners.length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.applied).length, 9);
  assert.equal(winners[0].reason, 'claimed');
  assert.equal(winners[0].run.attempt_count, 1);
  assert.equal(inputs.some((input) => input.claimToken === winners[0].run.metadata.claimToken), true);
  assert.equal(current.attempt_count, 1);
  assert.equal(current.metadata.claimToken, winners[0].run.metadata.claimToken);
});

test('fresh pending scheduled job cannot be reclaimed', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = `${dailyJobName}:2026-09-05`;
  const first = await storage.claimScheduledJob(atomicClaimInput(
    jobKey, `claim_fresh_A_${randomUUID()}`, '2026-09-05T15:00:00.000Z',
  ));
  const second = await storage.claimScheduledJob(atomicClaimInput(
    jobKey, `claim_fresh_B_${randomUUID()}`, '2026-09-05T15:59:59.999Z',
  ));

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'active');
  assert.equal(second.run.attempt_count, 1);
  assert.equal(second.run.metadata.claimToken, first.run.metadata.claimToken);
});

test('pending scheduled job older than one hour is reclaimed with a new token', async (t) => {
  const { storage, sqlitePath } = createAtomicStorage(t, 'ug-scheduled-job-stale-race-');
  const jobKey = `${dailyJobName}:2026-09-06`;
  const firstToken = `claim_stale_A_${randomUUID()}`;
  const first = await storage.claimScheduledJob(atomicClaimInput(
    jobKey, firstToken, '2026-09-06T15:00:00.000Z',
  ));
  const reclaimAt = '2026-09-06T16:00:00.000Z';
  const reusedToken = await storage.claimScheduledJob(atomicClaimInput(
    jobKey, firstToken, reclaimAt,
  ));
  const reclaimInputs = [
    atomicClaimInput(jobKey, `claim_stale_B_${randomUUID()}`, reclaimAt),
    atomicClaimInput(jobKey, `claim_stale_C_${randomUUID()}`, reclaimAt),
  ];

  const reclaims = await Promise.all(reclaimInputs.map((input) => runClaimProcess(sqlitePath, input)));
  const winners = reclaims.filter((attempt) => attempt.applied);

  assert.equal(first.applied, true);
  assert.equal(reusedToken.applied, false);
  assert.equal(reusedToken.reason, 'wrong-state');
  assert.equal(reusedToken.run.attempt_count, 1);
  assert.equal(winners.length, 1);
  assert.equal(reclaims.filter((attempt) => !attempt.applied).length, 1);
  assert.notEqual(winners[0].run.metadata.claimToken, firstToken);
  assert.equal(winners[0].run.attempt_count, 2);
  assert.equal((await storage.getScheduledJob(jobKey)).attempt_count, 2);
});

test('stale worker cannot transition a job after a new owner reclaims it', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = `${dailyJobName}:2026-09-07`;
  const oldToken = `claim_old_${randomUUID()}`;
  const newToken = `claim_new_${randomUUID()}`;
  await storage.claimScheduledJob(atomicClaimInput(jobKey, oldToken, '2026-09-07T15:00:00.000Z'));
  const reclaimed = await storage.claimScheduledJob(atomicClaimInput(jobKey, newToken, '2026-09-07T16:00:00.000Z'));

  const staleTransition = await storage.transitionScheduledJob({
    jobKey,
    claimToken: oldToken,
    expectedStatuses: ['pending'],
    status: 'completed',
    nowIso: '2026-09-07T16:00:01.000Z',
    providerMessageId: 'stale-provider-id',
    metadataPatch: { volatile: 'stale-worker' },
  });

  assert.equal(reclaimed.applied, true);
  assert.equal(staleTransition.applied, false);
  assert.equal(staleTransition.reason, 'not-owner');
  assert.equal(staleTransition.run.status, 'pending');
  assert.equal(staleTransition.run.provider_message_id, null);
  assert.equal(staleTransition.run.metadata.claimToken, newToken);
  assert.notEqual(staleTransition.run.metadata.volatile, 'stale-worker');
});

test('failed scheduled job cannot retry before durable nextRetryAt', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = `${dailyJobName}:2026-09-08`;
  const token = `claim_failed_A_${randomUUID()}`;
  await storage.claimScheduledJob(atomicClaimInput(jobKey, token, '2026-09-08T15:00:00.000Z'));
  const failed = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['pending'],
    status: 'failed',
    nowIso: '2026-09-08T15:05:00.000Z',
    lastError: 'definitive rejection',
  });
  const retry = await storage.claimScheduledJob(atomicClaimInput(
    jobKey, `claim_failed_B_${randomUUID()}`, '2026-09-08T15:34:59.999Z',
  ));

  assert.equal(failed.applied, true);
  assert.equal(failed.run.metadata.nextRetryAt, '2026-09-08T15:35:00.000Z');
  assert.equal(retry.applied, false);
  assert.equal(retry.reason, 'retry-not-due');
  assert.equal(retry.run.attempt_count, 1);
  assert.equal(retry.run.metadata.claimToken, token);
});

test('failed scheduled job retries at nextRetryAt and preserves its immutable envelope', async (t) => {
  const { storage, sqlitePath } = createAtomicStorage(t, 'ug-scheduled-job-retry-race-');
  const jobKey = `${dailyJobName}:2026-09-09`;
  const token = `claim_retry_A_${randomUUID()}`;
  const immutable = preparedMetadata('2026-09-09');
  await storage.claimScheduledJob(atomicClaimInput(
    jobKey, token, '2026-09-09T15:00:00.000Z', { metadata: immutable },
  ));
  await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['pending'],
    status: 'failed',
    nowIso: '2026-09-09T15:05:00.000Z',
    lastError: 'definitive rejection',
    metadataPatch: { volatile: 'failed' },
  });
  const retryAt = '2026-09-09T15:35:00.000Z';
  const inputs = [
    atomicClaimInput(jobKey, `claim_retry_B_${randomUUID()}`, retryAt, {
      metadata: {
        ...immutable,
        notificationType: 'required-source-alert',
        preparedEnvelope: { text: 'replacement' },
        volatile: 'retry-B',
      },
    }),
    atomicClaimInput(jobKey, `claim_retry_C_${randomUUID()}`, retryAt, {
      metadata: { ...immutable, payloadDigest: 'b'.repeat(64), businessDate: '2099-01-01', volatile: 'retry-C' },
    }),
  ];

  const retries = await Promise.all(inputs.map((input) => runClaimProcess(sqlitePath, input)));
  const winners = retries.filter((attempt) => attempt.applied);
  const current = await storage.getScheduledJob(jobKey);

  assert.equal(winners.length, 1);
  assert.equal(retries.filter((attempt) => !attempt.applied).length, 1);
  assert.equal(winners[0].run.attempt_count, 2);
  assert.notEqual(winners[0].run.metadata.claimToken, token);
  assert.equal(current.attempt_count, 2);
  assert.equal(current.status, 'pending');
  for (const field of ['businessDate', 'notificationType', 'firstPreparedAt', 'payloadDigest', 'preparedEnvelope']) {
    assert.deepEqual(current.metadata[field], immutable[field]);
  }
});

test('transmitting and ambiguous scheduled jobs can never be claimed', async (t) => {
  const { storage } = createAtomicStorage(t);
  for (const [index, status] of ['transmitting', 'ambiguous'].entries()) {
    const businessDate = `2026-09-${10 + index}`;
    const jobKey = `${dailyJobName}:${businessDate}`;
    const token = `claim_nonretriable_${index}_${randomUUID()}`;
    await storage.claimScheduledJob(atomicClaimInput(jobKey, token, `${businessDate}T15:00:00.000Z`));
    await storage.transitionScheduledJob({
      jobKey,
      claimToken: token,
      expectedStatuses: ['pending'],
      status,
      nowIso: `${businessDate}T15:01:00.000Z`,
    });
    const denied = await storage.claimScheduledJob(atomicClaimInput(
      jobKey, `claim_nonretriable_retry_${index}_${randomUUID()}`, `${businessDate}T20:00:00.000Z`,
    ));
    assert.equal(denied.applied, false);
    assert.equal(denied.reason, 'wrong-state');
    assert.equal(denied.run.status, status);
    assert.equal(denied.run.attempt_count, 1);
    assert.equal(denied.run.metadata.claimToken, token);
  }
});

test('completed scheduled job can never change notification type or be reclaimed', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = `${dailyJobName}:2026-09-12`;
  const token = `claim_completed_${randomUUID()}`;
  const immutable = preparedMetadata('2026-09-12');
  await storage.claimScheduledJob(atomicClaimInput(
    jobKey, token, '2026-09-12T15:00:00.000Z', { metadata: immutable },
  ));
  const completed = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['pending'],
    status: 'completed',
    nowIso: '2026-09-12T15:01:00.000Z',
    providerMessageId: 'provider-completed',
  });
  const transition = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['completed'],
    status: 'failed',
    nowIso: '2026-09-12T15:02:00.000Z',
    metadataPatch: { notificationType: 'required-source-alert' },
  });
  const reclaim = await storage.claimScheduledJob(atomicClaimInput(
    jobKey,
    `claim_after_completed_${randomUUID()}`,
    '2026-09-12T20:00:00.000Z',
    { metadata: { notificationType: 'required-source-alert' } },
  ));

  assert.equal(completed.applied, true);
  assert.equal(transition.applied, false);
  assert.equal(transition.reason, 'completed');
  assert.equal(reclaim.applied, false);
  assert.equal(reclaim.reason, 'completed');
  assert.equal(reclaim.run.status, 'completed');
  assert.equal(reclaim.run.attempt_count, 1);
  assert.equal(reclaim.run.metadata.notificationType, 'normal-digest');
});

test('token-fenced transition atomically changes status metadata provider id and timestamps', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = `${dailyJobName}:2026-09-13`;
  const token = `claim_transition_${randomUUID()}`;
  const immutable = preparedMetadata('2026-09-13');
  await storage.claimScheduledJob(atomicClaimInput(
    jobKey, token, '2026-09-13T15:00:00.000Z', { metadata: immutable },
  ));

  const wrongState = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['transmitting'],
    status: 'completed',
    nowIso: '2026-09-13T15:01:00.000Z',
    providerMessageId: 'wrong-state-provider',
    metadataPatch: { volatile: 'wrong-state' },
  });
  const wrongToken = await storage.transitionScheduledJob({
    jobKey,
    claimToken: `claim_wrong_${randomUUID()}`,
    expectedStatuses: ['pending'],
    status: 'transmitting',
    nowIso: '2026-09-13T15:01:00.000Z',
    metadataPatch: { volatile: 'wrong-token' },
  });
  const transmitting = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['pending'],
    status: 'transmitting',
    nowIso: '2026-09-13T15:02:00.000Z',
    metadataPatch: { volatile: 'provider-boundary', preparedEnvelope: { text: 'replacement' } },
  });
  const completed = await storage.transitionScheduledJob({
    jobKey,
    claimToken: token,
    expectedStatuses: ['transmitting'],
    status: 'completed',
    nowIso: '2026-09-13T15:03:00.000Z',
    completedAt: '2026-09-13T15:03:00.000Z',
    providerMessageId: 'provider-atomic',
    metadataPatch: { reconciliationSource: 'local-acceptance' },
  });

  assert.equal(wrongState.applied, false);
  assert.equal(wrongState.reason, 'wrong-state');
  assert.equal(wrongState.run.metadata.volatile, 'initial');
  assert.equal(wrongToken.applied, false);
  assert.equal(wrongToken.reason, 'not-owner');
  assert.equal(wrongToken.run.metadata.volatile, 'initial');
  assert.equal(transmitting.applied, true);
  assert.equal(transmitting.run.status, 'transmitting');
  assert.equal(transmitting.run.updated_at, '2026-09-13T15:02:00.000Z');
  assert.equal(transmitting.run.metadata.volatile, 'provider-boundary');
  assert.deepEqual(transmitting.run.metadata.preparedEnvelope, immutable.preparedEnvelope);
  assert.equal(completed.applied, true);
  assert.equal(completed.run.status, 'completed');
  assert.equal(completed.run.updated_at, '2026-09-13T15:03:00.000Z');
  assert.equal(completed.run.completed_at, '2026-09-13T15:03:00.000Z');
  assert.equal(completed.run.provider_message_id, 'provider-atomic');
  assert.equal(completed.run.metadata.reconciliationSource, 'local-acceptance');
  assert.equal(completed.run.metadata.claimToken, token);
});

test('legacy backup scheduled job callers remain compatible', async (t) => {
  const { storage } = createAtomicStorage(t);
  const jobKey = 'backup:2026-09-14';
  const first = await storage.claimScheduledJob({
    jobKey,
    jobName: 'backup',
    triggeredBy: 'scheduler',
    nowIso: '2026-09-14T08:00:00.000Z',
    staleBefore: '2026-09-14T06:00:00.000Z',
    metadata: { dateKey: '2026-09-14' },
  });
  assert.equal(first.claimed, true);

  const failed = await storage.completeScheduledJob(jobKey, {
    status: 'failed',
    completed_at: '2026-09-14T08:01:00.000Z',
    last_error: 'backup failed',
    metadata: { dateKey: '2026-09-14' },
  });
  assert.equal(failed.status, 'failed');

  const retry = await storage.claimScheduledJob({
    jobKey,
    jobName: 'backup',
    triggeredBy: 'scheduler',
    nowIso: '2026-09-14T08:02:00.000Z',
    staleBefore: '2026-09-14T06:02:00.000Z',
    metadata: { dateKey: '2026-09-14' },
  });
  assert.equal(retry.claimed, true);
  assert.equal(retry.run.attempt_count, 2);

  const completed = await storage.completeScheduledJob(jobKey, {
    status: 'completed',
    completed_at: '2026-09-14T08:03:00.000Z',
    metadata: { dateKey: '2026-09-14', backupId: 'backup-1' },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.metadata.backupId, 'backup-1');
});

test('Supabase scheduled job adapter delegates claim and transition authority to atomic RPCs', async () => {
  const calls = [];
  const token = `claim_supabase_${randomUUID()}`;
  const row = {
    job_key: `${dailyJobName}:2026-09-15`,
    job_name: dailyJobName,
    created_at: '2026-09-15T15:00:00.000Z',
    updated_at: '2026-09-15T15:01:00.000Z',
    started_at: '2026-09-15T15:00:00.000Z',
    completed_at: null,
    status: 'transmitting',
    triggered_by: 'scheduler',
    attempt_count: 1,
    provider_message_id: null,
    last_error: null,
    metadata: { claimToken: token },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name, parameters) {
          calls.push({ name, parameters });
          return { data: { applied: true, reason: 'claimed', run: row }, error: null };
        },
      },
    },
  );
  const claim = atomicClaimInput(row.job_key, token, '2026-09-15T15:00:00.000Z');

  const claimed = await storage.claimScheduledJob(claim);
  const transitioned = await storage.transitionScheduledJob({
    jobKey: row.job_key,
    claimToken: token,
    expectedStatuses: ['pending'],
    status: 'transmitting',
    nowIso: '2026-09-15T15:01:00.000Z',
    providerMessageId: '',
    lastError: '',
    metadataPatch: { provider: 'resend' },
    completedAt: '',
  });

  assert.deepEqual(calls, [
    {
      name: 'claim_scheduled_job',
      parameters: {
        p_job_key: claim.jobKey,
        p_job_name: claim.jobName,
        p_triggered_by: claim.triggeredBy,
        p_claim_token: claim.claimToken,
        p_now: claim.nowIso,
        p_stale_before: claim.staleBefore,
        p_retry_due_at: claim.retryDueAt,
        p_metadata: claim.metadata,
      },
    },
    {
      name: 'transition_scheduled_job',
      parameters: {
        p_job_key: row.job_key,
        p_claim_token: token,
        p_expected_statuses: ['pending'],
        p_status: 'transmitting',
        p_now: '2026-09-15T15:01:00.000Z',
        p_provider_message_id: null,
        p_last_error: null,
        p_metadata_patch: { provider: 'resend' },
        p_completed_at: null,
      },
    },
  ]);
  assert.equal(claimed.applied, true);
  assert.equal(claimed.run.attempt_count, 1);
  assert.deepEqual(claimed.run.metadata, { claimToken: token });
  assert.equal(transitioned.applied, true);
  assert.equal(transitioned.run.status, 'transmitting');
});

function runLocal(command, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function docker(args, options = {}) {
  return runLocal(dockerCommand, args, options);
}

function waitForPostgres(containerName) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = docker(['logs', containerName], { allowFailure: true });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = docker(['exec', containerName, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
    if (readyEvents >= 2 && ready.status === 0) return;
    Atomics.wait(signal, 0, 0, 100);
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

function psql(containerName, database, sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', containerName,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
  ], { input: sql, allowFailure });
}

function psqlAsync(containerName, database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, [
      'exec', '-i', containerName,
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
    ], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlQuote(JSON.stringify(value))}::jsonb`;
}

function parsePostgresJson(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return output ? JSON.parse(output) : null;
}

function postgresClaim(jobKey, claimToken, nowIso, metadata = {}, overrides = {}) {
  return `select public.claim_scheduled_job(
    ${sqlQuote(jobKey)},
    ${sqlQuote(overrides.jobName || dailyJobName)},
    ${sqlQuote(overrides.triggeredBy || 'postgres-test')},
    ${sqlQuote(claimToken)},
    ${sqlQuote(nowIso)}::timestamptz,
    ${overrides.staleBefore === null ? 'null' : `${sqlQuote(overrides.staleBefore || new Date(Date.parse(nowIso) - oneHourMs).toISOString())}::timestamptz`},
    ${overrides.retryDueAt === null ? 'null' : `${sqlQuote(overrides.retryDueAt || nowIso)}::timestamptz`},
    ${sqlJson(metadata)}
  );`;
}

function postgresTransition(jobKey, claimToken, expectedStatuses, status, nowIso, overrides = {}) {
  const expected = `array[${expectedStatuses.map(sqlQuote).join(', ')}]::text[]`;
  return `select public.transition_scheduled_job(
    ${sqlQuote(jobKey)},
    ${sqlQuote(claimToken)},
    ${expected},
    ${sqlQuote(status)},
    ${sqlQuote(nowIso)}::timestamptz,
    ${sqlQuote(overrides.providerMessageId)},
    ${sqlQuote(overrides.lastError)},
    ${sqlJson(overrides.metadataPatch || {})},
    ${overrides.completedAt ? `${sqlQuote(overrides.completedAt)}::timestamptz` : 'null'}
  );`;
}

test('real PostgreSQL enforces atomic scheduled-job claims and token-fenced transitions', {
  skip: scheduledJobPostgresEnabled
    ? false
    : 'set DAILY_DIGEST_POSTGRES_INTEGRATION=1 for the required disposable PostgreSQL Task 2 gate',
  timeout: 180_000,
}, async (t) => {
  const dockerInfo = docker(['info'], { allowFailure: true });
  assert.equal(dockerInfo.status, 0, `Docker is required for this release gate.\n${dockerInfo.stderr}`);

  const containerName = `uckele-digest-task2-postgres-${process.pid}-${randomUUID().slice(0, 8)}`;
  docker([
    'run', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=task2-integration-only',
    '-d', 'postgres:16',
  ]);
  t.after(() => docker(['rm', '-f', containerName], { allowFailure: true }));
  waitForPostgres(containerName);

  const schema = fs.readFileSync(scheduledJobSchemaPath, 'utf8');
  const migration = fs.readFileSync(scheduledJobMigrationPath, 'utf8');
  const startingSchema = execFileSync('git', ['show', `${startingHead}:supabase/schema.sql`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  psql(containerName, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database task2_fresh;
    create database task2_upgrade;
  `);
  psql(containerName, 'task2_fresh', schema);
  psql(containerName, 'task2_upgrade', startingSchema);
  psql(containerName, 'task2_upgrade', migration);

  for (const database of ['task2_fresh', 'task2_upgrade']) {
    const functionCount = Number(psql(containerName, database, `
      select count(*) from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('claim_scheduled_job', 'transition_scheduled_job');
    `).stdout.trim());
    assert.equal(functionCount, 2);
    const privileges = psql(containerName, database, `
      select concat_ws(',',
        has_function_privilege('service_role', 'public.claim_scheduled_job(text,text,text,text,timestamptz,timestamptz,timestamptz,jsonb)', 'execute'),
        has_function_privilege('anon', 'public.claim_scheduled_job(text,text,text,text,timestamptz,timestamptz,timestamptz,jsonb)', 'execute'),
        has_function_privilege('authenticated', 'public.transition_scheduled_job(text,text,text[],text,timestamptz,text,text,jsonb,timestamptz)', 'execute')
      );
    `).stdout.trim();
    assert.equal(privileges, 't,f,f');
  }

  const database = 'task2_upgrade';
  const firstKey = `${dailyJobName}:2026-09-20`;
  const firstTokens = [`claim_pg_first_A_${randomUUID()}`, `claim_pg_first_B_${randomUUID()}`];
  const firstClaims = await Promise.all(firstTokens.map((token) => psqlAsync(
    containerName,
    database,
    postgresClaim(firstKey, token, '2026-09-20T15:00:00.000Z'),
  )));
  const firstResults = firstClaims.map(parsePostgresJson);
  assert.equal(firstResults.filter((result) => result.applied).length, 1);
  assert.equal(firstResults.filter((result) => !result.applied).length, 1);
  assert.equal(firstResults.find((result) => result.applied).run.attempt_count, 1);

  const staleKey = `${dailyJobName}:2026-09-21`;
  const staleOldToken = `claim_pg_stale_old_${randomUUID()}`;
  parsePostgresJson(psql(containerName, database, postgresClaim(
    staleKey,
    staleOldToken,
    '2026-09-21T15:00:00.000Z',
    preparedMetadata('2026-09-21'),
  )));
  const reusedStaleToken = parsePostgresJson(psql(containerName, database, postgresClaim(
    staleKey,
    staleOldToken,
    '2026-09-21T16:00:00.000Z',
  )));
  assert.equal(reusedStaleToken.applied, false);
  assert.equal(reusedStaleToken.reason, 'wrong-state');
  assert.equal(reusedStaleToken.run.attempt_count, 1);
  const staleTokens = [`claim_pg_stale_A_${randomUUID()}`, `claim_pg_stale_B_${randomUUID()}`];
  const staleClaims = await Promise.all(staleTokens.map((token) => psqlAsync(
    containerName,
    database,
    postgresClaim(staleKey, token, '2026-09-21T16:00:00.000Z', {
      notificationType: 'required-source-alert',
      preparedEnvelope: { text: 'replacement' },
    }),
  )));
  const staleResults = staleClaims.map(parsePostgresJson);
  const staleWinner = staleResults.find((result) => result.applied);
  assert.equal(staleResults.filter((result) => result.applied).length, 1);
  assert.equal(staleWinner.run.attempt_count, 2);
  assert.notEqual(staleWinner.run.metadata.claimToken, staleOldToken);
  assert.equal(staleWinner.run.metadata.notificationType, 'normal-digest');
  assert.equal(staleWinner.run.metadata.preparedEnvelope.text, 'Immutable prepared body');
  const staleCompletion = parsePostgresJson(psql(containerName, database, postgresTransition(
    staleKey,
    staleOldToken,
    ['pending'],
    'completed',
    '2026-09-21T16:00:01.000Z',
    { providerMessageId: 'stale-provider' },
  )));
  assert.equal(staleCompletion.applied, false);
  assert.equal(staleCompletion.reason, 'not-owner');
  assert.equal(staleCompletion.run.status, 'pending');
  assert.equal(staleCompletion.run.provider_message_id, null);

  const retryKey = `${dailyJobName}:2026-09-22`;
  const retryOldToken = `claim_pg_retry_old_${randomUUID()}`;
  parsePostgresJson(psql(containerName, database, postgresClaim(
    retryKey,
    retryOldToken,
    '2026-09-22T15:00:00.000Z',
    preparedMetadata('2026-09-22'),
  )));
  const failed = parsePostgresJson(psql(containerName, database, postgresTransition(
    retryKey,
    retryOldToken,
    ['pending'],
    'failed',
    '2026-09-22T15:05:00.000Z',
    { lastError: 'definitive rejection' },
  )));
  assert.equal(new Date(failed.run.metadata.nextRetryAt).toISOString(), '2026-09-22T15:35:00.000Z');
  const premature = parsePostgresJson(psql(containerName, database, postgresClaim(
    retryKey,
    `claim_pg_retry_early_${randomUUID()}`,
    '2026-09-22T15:34:59.999Z',
  )));
  assert.equal(premature.applied, false);
  assert.equal(premature.reason, 'retry-not-due');
  assert.equal(premature.run.attempt_count, 1);

  const retryTokens = [`claim_pg_retry_A_${randomUUID()}`, `claim_pg_retry_B_${randomUUID()}`];
  const retryClaims = await Promise.all(retryTokens.map((token) => psqlAsync(
    containerName,
    database,
    postgresClaim(retryKey, token, '2026-09-22T15:35:00.000Z'),
  )));
  const retryResults = retryClaims.map(parsePostgresJson);
  const retryWinner = retryResults.find((result) => result.applied);
  assert.equal(retryResults.filter((result) => result.applied).length, 1);
  assert.equal(retryWinner.run.attempt_count, 2);
  assert.notEqual(retryWinner.run.metadata.claimToken, retryOldToken);
  assert.equal(retryWinner.run.metadata.payloadDigest, 'a'.repeat(64));

  const mismatchKey = `${dailyJobName}:2026-09-23`;
  const mismatchToken = `claim_pg_mismatch_${randomUUID()}`;
  parsePostgresJson(psql(containerName, database, postgresClaim(
    mismatchKey,
    mismatchToken,
    '2026-09-23T15:00:00.000Z',
    preparedMetadata('2026-09-23'),
  )));
  const wrongState = parsePostgresJson(psql(containerName, database, postgresTransition(
    mismatchKey,
    mismatchToken,
    ['transmitting'],
    'completed',
    '2026-09-23T15:01:00.000Z',
    { metadataPatch: { volatile: 'wrong-state' } },
  )));
  const wrongToken = parsePostgresJson(psql(containerName, database, postgresTransition(
    mismatchKey,
    `claim_pg_wrong_${randomUUID()}`,
    ['pending'],
    'transmitting',
    '2026-09-23T15:01:00.000Z',
    { metadataPatch: { volatile: 'wrong-token' } },
  )));
  assert.equal(wrongState.reason, 'wrong-state');
  assert.equal(wrongToken.reason, 'not-owner');
  assert.equal(wrongToken.run.status, 'pending');
  assert.equal(wrongToken.run.metadata.volatile, 'initial');

  const completed = parsePostgresJson(psql(containerName, database, postgresTransition(
    mismatchKey,
    mismatchToken,
    ['pending'],
    'completed',
    '2026-09-23T15:02:00.000Z',
    { providerMessageId: 'provider-complete' },
  )));
  assert.equal(completed.applied, true);
  const completedClaim = parsePostgresJson(psql(containerName, database, postgresClaim(
    mismatchKey,
    `claim_pg_completed_${randomUUID()}`,
    '2026-09-23T20:00:00.000Z',
  )));
  const completedTransition = parsePostgresJson(psql(containerName, database, postgresTransition(
    mismatchKey,
    mismatchToken,
    ['completed'],
    'failed',
    '2026-09-23T20:01:00.000Z',
  )));
  assert.equal(completedClaim.reason, 'completed');
  assert.equal(completedTransition.reason, 'completed');
  assert.equal(completedTransition.run.status, 'completed');
  assert.equal(completedTransition.run.attempt_count, 1);

  for (const [index, status] of ['transmitting', 'ambiguous'].entries()) {
    const key = `${dailyJobName}:2026-09-${24 + index}`;
    const token = `claim_pg_terminal_${index}_${randomUUID()}`;
    parsePostgresJson(psql(containerName, database, postgresClaim(
      key,
      token,
      `2026-09-${24 + index}T15:00:00.000Z`,
    )));
    parsePostgresJson(psql(containerName, database, postgresTransition(
      key,
      token,
      ['pending'],
      status,
      `2026-09-${24 + index}T15:01:00.000Z`,
    )));
    const denied = parsePostgresJson(psql(containerName, database, postgresClaim(
      key,
      `claim_pg_terminal_retry_${index}_${randomUUID()}`,
      `2026-09-${24 + index}T20:00:00.000Z`,
    )));
    assert.equal(denied.applied, false);
    assert.equal(denied.reason, 'wrong-state');
    assert.equal(denied.run.status, status);
    assert.equal(denied.run.attempt_count, 1);
  }

  const anonCall = psql(containerName, database, `
    set role anon;
    ${postgresClaim(`${dailyJobName}:2026-09-30`, `claim_pg_anon_${randomUUID()}`, '2026-09-30T15:00:00.000Z')}
  `, { allowFailure: true });
  assert.notEqual(anonCall.status, 0);
  assert.match(anonCall.stderr, /permission denied for function claim_scheduled_job/i);
});
