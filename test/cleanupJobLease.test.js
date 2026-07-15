import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const leaseTokenA = 'cleanup_lease_owner_A_0001';
const leaseTokenB = 'cleanup_lease_owner_B_0002';
const leaseTokenC = 'cleanup_lease_owner_C_0003';

function isoFrom(baseMs, offsetMs = 0) {
  return new Date(baseMs + offsetMs).toISOString();
}

function cleanupJob(id, status = 'cleanup-failed') {
  const createdAt = '2026-07-13T12:00:00.000Z';
  return {
    id,
    submission_id: 'cleanup-lease-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status,
    trash_directory: `/secure-documents/.trash/${id}`,
    files: [{ originalPath: '/secure-documents/source.txt', stagedPath: `/secure-documents/.trash/${id}/source.txt` }],
    attempt_count: 1,
    last_error: 'retry me',
    metadata: { reason: 'test' },
  };
}

function sqliteStorage(t, prefix = 'ug-cleanup-lease-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'storage.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
}

test('SQLite cleanup-job leases are atomic, expire, and exclude terminal jobs', async (t) => {
  const storage = sqliteStorage(t);
  const job = await storage.insertSecureDocumentCleanupJob(cleanupJob('sqlite-cleanup-lease'));

  assert.equal(job.lease_claimed_at, null);
  assert.equal(job.lease_expires_at, null);
  assert.equal(job.lease_token, null);

  const baseMs = Date.now();
  const claimedAt = isoFrom(baseMs, -1000);
  const leaseExpiresAt = isoFrom(baseMs, 5 * 60 * 1000);
  const claims = await Promise.all([
    storage.claimSecureDocumentCleanupJob(job.id, { claimedAt, leaseExpiresAt, leaseToken: leaseTokenA }),
    storage.claimSecureDocumentCleanupJob(job.id, { claimedAt, leaseExpiresAt, leaseToken: leaseTokenB }),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).lease_claimed_at, claimedAt);
  assert.equal(claims.find(Boolean).lease_expires_at, leaseExpiresAt);
  assert.ok([leaseTokenA, leaseTokenB].includes(claims.find(Boolean).lease_token));
  assert.equal(
    await storage.claimSecureDocumentCleanupJob(job.id, {
      claimedAt: isoFrom(baseMs, 5 * 60 * 1000 - 1),
      leaseExpiresAt: isoFrom(baseMs, 10 * 60 * 1000),
      leaseToken: leaseTokenC,
    }),
    null,
  );

  const reclaimed = await storage.claimSecureDocumentCleanupJob(job.id, {
    claimedAt: leaseExpiresAt,
    leaseExpiresAt: isoFrom(baseMs, 10 * 60 * 1000),
    leaseToken: leaseTokenB,
  });
  assert.equal(reclaimed.lease_claimed_at, leaseExpiresAt);
  assert.equal(reclaimed.lease_expires_at, isoFrom(baseMs, 10 * 60 * 1000));
  assert.equal(reclaimed.lease_token, leaseTokenB);

  const [listed] = await storage.listPendingSecureDocumentCleanupJobs();
  assert.equal(listed.lease_claimed_at, leaseExpiresAt);
  assert.equal(listed.lease_expires_at, isoFrom(baseMs, 10 * 60 * 1000));
  assert.equal(listed.lease_token, leaseTokenB);
  assert.deepEqual(listed.files, job.files);
  assert.deepEqual(listed.metadata, job.metadata);

  await storage.updateSecureDocumentCleanupJobIfLeased(job.id, leaseTokenB, {
    updated_at: isoFrom(baseMs, 10 * 60 * 1000 + 30_000),
    completed_at: isoFrom(baseMs, 10 * 60 * 1000 + 30_000),
    status: 'completed',
    lease_token: null,
  });
  assert.equal(
    await storage.claimSecureDocumentCleanupJob(job.id, {
      claimedAt: isoFrom(baseMs, 12 * 60 * 1000),
      leaseExpiresAt: isoFrom(baseMs, 17 * 60 * 1000),
      leaseToken: leaseTokenC,
    }),
    null,
  );

  const partialUploadJob = await storage.insertSecureDocumentCleanupJob(
    cleanupJob('sqlite-partial-upload-cleanup', 'cleanup-pending'),
  );
  const partialUploadClaim = await storage.claimSecureDocumentCleanupJob(partialUploadJob.id, {
    claimedAt: isoFrom(baseMs, -1000),
    leaseExpiresAt: isoFrom(baseMs, 5 * 60 * 1000),
    leaseToken: leaseTokenC,
  });
  assert.equal(partialUploadClaim.status, 'cleanup-pending');
});

test('SQLite adds cleanup-job lease columns to an existing database', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cleanup-lease-upgrade-'));
  const sqlitePath = path.join(tempDir, 'storage.sqlite');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const legacy = new Database(sqlitePath);
  legacy.exec(`
    CREATE TABLE secure_document_cleanup_jobs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      trash_directory TEXT,
      files TEXT NOT NULL DEFAULT '[]',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    )
  `);
  legacy.close();

  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  const job = await storage.insertSecureDocumentCleanupJob(cleanupJob('upgraded-cleanup-lease'));
  const claimed = await storage.claimSecureDocumentCleanupJob(job.id, {
    claimedAt: '2026-07-13T13:00:00.000Z',
    leaseExpiresAt: '2026-07-13T13:05:00.000Z',
    leaseToken: leaseTokenA,
  });

  assert.equal(claimed.lease_claimed_at, '2026-07-13T13:00:00.000Z');
  assert.equal(claimed.lease_expires_at, '2026-07-13T13:05:00.000Z');
  assert.equal(claimed.lease_token, leaseTokenA);
});

test('cleanup-job lease input strictly rejects non-UTC timestamps, invalid tokens, and invalid durations', async (t) => {
  const storage = sqliteStorage(t, 'ug-cleanup-lease-validation-');
  await storage.insertSecureDocumentCleanupJob(cleanupJob('invalid-cleanup-lease'));

  await assert.rejects(
    () => storage.claimSecureDocumentCleanupJob('invalid-cleanup-lease', {}),
    /canonical UTC ISO timestamp/i,
  );
  await assert.rejects(
    () => storage.claimSecureDocumentCleanupJob('invalid-cleanup-lease', {
      claimedAt: '2026-07-13T13:00:00.000Z',
      leaseExpiresAt: '2026-07-13T13:00:00.000Z',
      leaseToken: leaseTokenA,
    }),
    /later than its claim time/i,
  );
  await assert.rejects(
    () => storage.claimSecureDocumentCleanupJob('invalid-cleanup-lease', {
      claimedAt: '2026-07-13T06:00:00.000-07:00',
      leaseExpiresAt: '2026-07-13T06:05:00.000-07:00',
      leaseToken: leaseTokenA,
    }),
    /canonical UTC ISO timestamp/i,
  );
  await assert.rejects(
    () => storage.claimSecureDocumentCleanupJob('invalid-cleanup-lease', {
      claimedAt: '2026-07-13T13:00:00.000Z',
      leaseExpiresAt: '2026-07-13T13:05:00.000Z',
      leaseToken: 'short token',
    }),
    /URL-safe opaque value/i,
  );
  await assert.rejects(
    () => storage.claimSecureDocumentCleanupJob('invalid-cleanup-lease', {
      claimedAt: '2026-07-13T13:00:00.000Z',
      leaseExpiresAt: '2026-07-14T13:00:00.001Z',
      leaseToken: leaseTokenA,
    }),
    /between 1 millisecond and 24 hours/i,
  );
});

test('SQLite lease renewal uses the database clock and expired leases cannot mutate state', async (t) => {
  const storage = sqliteStorage(t, 'ug-cleanup-lease-renewal-');
  const baseMs = Date.now();
  const activeJob = await storage.insertSecureDocumentCleanupJob(cleanupJob('active-renewal-cleanup-lease'));
  await storage.claimSecureDocumentCleanupJob(activeJob.id, {
    claimedAt: isoFrom(baseMs, -1000),
    leaseExpiresAt: isoFrom(baseMs, 60_000),
    leaseToken: leaseTokenA,
  });

  const renewed = await storage.renewSecureDocumentCleanupJobLease(activeJob.id, leaseTokenA, 5 * 60 * 1000);
  assert.equal(renewed.lease_token, leaseTokenA);
  assert.ok(Date.parse(renewed.lease_expires_at) >= Date.now() + 4 * 60 * 1000);

  const expiredJob = await storage.insertSecureDocumentCleanupJob(cleanupJob('expired-renewal-cleanup-lease'));
  await storage.claimSecureDocumentCleanupJob(expiredJob.id, {
    claimedAt: isoFrom(baseMs, -2 * 60 * 1000),
    leaseExpiresAt: isoFrom(baseMs, -60_000),
    leaseToken: leaseTokenB,
  });

  assert.equal(
    await storage.renewSecureDocumentCleanupJobLease(expiredJob.id, leaseTokenB, 5 * 60 * 1000),
    null,
  );
  assert.equal(
    await storage.updateSecureDocumentCleanupJobIfLeased(expiredJob.id, leaseTokenB, {
      updated_at: isoFrom(baseMs),
      status: 'completed',
      lease_token: null,
    }),
    null,
  );
  assert.equal((await storage.getSecureDocumentCleanupJob(expiredJob.id)).status, 'cleanup-failed');
});

test('a stale SQLite lease owner cannot finalize or release after another owner reclaims', async (t) => {
  const storage = sqliteStorage(t, 'ug-cleanup-lease-fencing-');
  const job = await storage.insertSecureDocumentCleanupJob(cleanupJob('stale-owner-cleanup-lease'));
  const baseMs = Date.now();
  await storage.claimSecureDocumentCleanupJob(job.id, {
    claimedAt: isoFrom(baseMs, -10 * 60 * 1000),
    leaseExpiresAt: isoFrom(baseMs, -5 * 60 * 1000),
    leaseToken: leaseTokenA,
  });
  const reclaimed = await storage.claimSecureDocumentCleanupJob(job.id, {
    claimedAt: isoFrom(baseMs, -5 * 60 * 1000),
    leaseExpiresAt: isoFrom(baseMs, 5 * 60 * 1000),
    leaseToken: leaseTokenB,
  });
  assert.equal(reclaimed.lease_token, leaseTokenB);

  assert.equal(
    await storage.updateSecureDocumentCleanupJob(job.id, { status: 'completed' }),
    null,
  );
  assert.equal((await storage.getSecureDocumentCleanupJob(job.id)).lease_token, leaseTokenB);

  const staleFinalize = await storage.updateSecureDocumentCleanupJobIfLeased(job.id, leaseTokenA, {
    updated_at: isoFrom(baseMs),
    completed_at: isoFrom(baseMs),
    status: 'completed',
    lease_token: null,
  });
  assert.equal(staleFinalize, null);
  const afterStaleAttempt = await storage.getSecureDocumentCleanupJob(job.id);
  assert.equal(afterStaleAttempt.status, 'cleanup-failed');
  assert.equal(afterStaleAttempt.lease_token, leaseTokenB);

  const finalized = await storage.updateSecureDocumentCleanupJobIfLeased(job.id, leaseTokenB, {
    updated_at: isoFrom(baseMs, 1000),
    completed_at: isoFrom(baseMs, 1000),
    status: 'completed',
    last_error: null,
    lease_token: null,
  });
  assert.equal(finalized.status, 'completed');
  assert.equal(finalized.lease_claimed_at, null);
  assert.equal(finalized.lease_expires_at, null);
  assert.equal(finalized.lease_token, null);

  assert.equal(
    await storage.updateSecureDocumentCleanupJobIfLeased(job.id, leaseTokenA, {
      updated_at: isoFrom(baseMs, 2000),
      status: 'restore-failed',
    }),
    null,
  );
});

test('separate SQLite connections coordinate claims and fence the expired owner', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cleanup-lease-connections-'));
  const sqlitePath = path.join(tempDir, 'storage.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const storageA = createSqliteStorage(config);
  const storageB = createSqliteStorage(config);
  t.after(() => {
    storageA.close();
    storageB.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const job = await storageA.insertSecureDocumentCleanupJob(cleanupJob('separate-connection-cleanup-lease'));
  const baseMs = Date.now();
  const claimedAt = isoFrom(baseMs, -10 * 60 * 1000);
  const leaseExpiresAt = isoFrom(baseMs, -5 * 60 * 1000);

  const ownerA = await storageA.claimSecureDocumentCleanupJob(job.id, {
    claimedAt,
    leaseExpiresAt,
    leaseToken: leaseTokenA,
  });
  const blockedOwnerB = await storageB.claimSecureDocumentCleanupJob(job.id, {
    claimedAt,
    leaseExpiresAt,
    leaseToken: leaseTokenB,
  });

  assert.equal(ownerA.lease_token, leaseTokenA);
  assert.equal(blockedOwnerB, null);

  const ownerB = await storageB.claimSecureDocumentCleanupJob(job.id, {
    claimedAt: leaseExpiresAt,
    leaseExpiresAt: isoFrom(baseMs, 5 * 60 * 1000),
    leaseToken: leaseTokenB,
  });
  assert.equal(ownerB.lease_token, leaseTokenB);
  assert.equal(
    await storageA.updateSecureDocumentCleanupJobIfLeased(job.id, leaseTokenA, {
      updated_at: isoFrom(baseMs),
      status: 'completed',
      lease_token: null,
    }),
    null,
  );
  assert.equal(
    await storageA.updateSecureDocumentCleanupJob(job.id, { status: 'completed' }),
    null,
  );
  assert.equal((await storageB.getSecureDocumentCleanupJob(job.id)).lease_token, leaseTokenB);
});

test('Supabase cleanup-job claims use the atomic lease RPC and normalize its row', async () => {
  const calls = [];
  const row = {
    ...cleanupJob('00000000-0000-4000-8000-000000000031', 'reconciliation-pending'),
    lease_claimed_at: '2026-07-13T14:00:00.000Z',
    lease_expires_at: '2026-07-13T14:05:00.000Z',
    lease_token: leaseTokenA,
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name, parameters) {
          calls.push({ name, parameters });
          return { data: row, error: null };
        },
      },
    },
  );

  const claimed = await storage.claimSecureDocumentCleanupJob(row.id, {
    claimedAt: row.lease_claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: leaseTokenA,
  });

  assert.deepEqual(calls, [{
    name: 'claim_secure_document_cleanup_job',
    parameters: {
      p_id: row.id,
      p_lease_duration_ms: 300000,
      p_lease_token: leaseTokenA,
    },
  }]);
  assert.equal(claimed.id, row.id);
  assert.equal(claimed.attempt_count, 1);
  assert.equal(claimed.lease_claimed_at, row.lease_claimed_at);
  assert.equal(claimed.lease_expires_at, row.lease_expires_at);
  assert.equal(claimed.lease_token, leaseTokenA);
  assert.deepEqual(claimed.metadata, { reason: 'test' });
});

test('Supabase lease renewal uses the server-timed token-and-expiry RPC', async () => {
  const calls = [];
  const id = '00000000-0000-4000-8000-000000000033';
  const row = {
    ...cleanupJob(id),
    lease_claimed_at: '2026-07-13T14:00:00.000Z',
    lease_expires_at: '2026-07-13T14:10:00.000Z',
    lease_token: leaseTokenA,
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name, parameters) {
          calls.push({ name, parameters });
          return { data: row, error: null };
        },
      },
    },
  );

  const renewed = await storage.renewSecureDocumentCleanupJobLease(id, leaseTokenA, 300000);

  assert.deepEqual(calls, [{
    name: 'renew_secure_document_cleanup_job_lease',
    parameters: {
      p_id: id,
      p_lease_token: leaseTokenA,
      p_lease_duration_ms: 300000,
    },
  }]);
  assert.equal(renewed.lease_token, leaseTokenA);
  assert.equal(renewed.lease_expires_at, row.lease_expires_at);
});

test('Supabase fenced updates pass the expected token and explicit release payload to the RPC', async () => {
  const calls = [];
  const id = '00000000-0000-4000-8000-000000000032';
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name, parameters) {
          calls.push({ name, parameters });
          return {
            data: parameters.p_lease_token === leaseTokenB
              ? { ...cleanupJob(id, 'completed'), completed_at: parameters.p_values.completed_at, ...parameters.p_values }
              : null,
            error: null,
          };
        },
      },
    },
  );
  const values = {
    updated_at: '2026-07-13T16:01:00.000Z',
    completed_at: '2026-07-13T16:01:00.000Z',
    status: 'completed',
    lease_token: null,
  };

  assert.equal(await storage.updateSecureDocumentCleanupJobIfLeased(id, leaseTokenA, values), null);
  const updated = await storage.updateSecureDocumentCleanupJobIfLeased(id, leaseTokenB, values);

  assert.equal(updated.status, 'completed');
  assert.equal(updated.lease_token, null);
  assert.deepEqual(calls[1], {
    name: 'update_secure_document_cleanup_job_if_leased',
    parameters: {
      p_id: id,
      p_lease_token: leaseTokenB,
      p_values: {
        ...values,
        lease_claimed_at: null,
        lease_expires_at: null,
      },
    },
  });
});

test('Supabase cleanup-job lease migration performs one guarded update and restricts the RPC', () => {
  const migration = fs.readFileSync(
    new URL('../supabase/migrations/20260713111500_secure_document_cleanup_lease_tokens.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /status in \([\s\S]*'staging'[\s\S]*'pending-purge'[\s\S]*'cleanup-pending'[\s\S]*'reconciliation-pending'[\s\S]*'cleanup-failed'[\s\S]*'restore-failed'[\s\S]*\)/i);
  assert.match(migration, /v_claimed_at timestamptz := clock_timestamp\(\)/i);
  assert.match(migration, /lease_expires_at is null[\s\S]*lease_expires_at <= v_claimed_at/i);
  assert.match(migration, /lease_token = p_lease_token/i);
  assert.match(migration, /returning to_jsonb\(cleanup_job\) into v_job/i);
  assert.match(migration, /revoke all on function public\.claim_secure_document_cleanup_job[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.claim_secure_document_cleanup_job[\s\S]*to service_role/i);
  assert.match(migration, /where cleanup_job\.id = p_id[\s\S]*cleanup_job\.lease_token = p_lease_token/i);
  assert.match(migration, /revoke all on function public\.update_secure_document_cleanup_job_if_leased[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.update_secure_document_cleanup_job_if_leased[\s\S]*to service_role/i);
});

test('Supabase cleanup-job renewal migration time-fences renewal and every leased transition', () => {
  const migration = fs.readFileSync(
    new URL('../supabase/migrations/20260713113000_secure_document_cleanup_lease_renewal.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /renew_secure_document_cleanup_job_lease/i);
  assert.match(migration, /v_renewed_at timestamptz := clock_timestamp\(\)/i);
  assert.match(migration, /lease_expires_at = v_renewed_at \+ \(p_lease_duration_ms \* interval '1 millisecond'\)/i);
  assert.match(migration, /lease_token = p_lease_token[\s\S]*lease_expires_at > v_renewed_at/i);
  assert.match(migration, /revoke all on function public\.renew_secure_document_cleanup_job_lease[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.renew_secure_document_cleanup_job_lease[\s\S]*to service_role/i);
  assert.match(migration, /v_checked_at timestamptz := clock_timestamp\(\)/i);
  assert.match(migration, /update_secure_document_cleanup_job_if_leased[\s\S]*lease_token = p_lease_token[\s\S]*lease_expires_at > v_checked_at/i);
});
