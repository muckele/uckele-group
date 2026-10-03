import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const migrationPath = path.resolve('supabase/migrations/20261011120000_secure_cim_attachment_foundation.sql');
const schemaPath = path.resolve('supabase/schema.sql');
const scannerProposalPath = path.resolve('docs/operations/sql/p8-03-offline-on-demand-scanner-proposal.sql');
const sqliteProposalPath = path.resolve('docs/operations/sql/p8-03-sqlite-local-fixture.sql');

test('SQLite creates the one approved secure attachment ingestion table with replay and publication uniqueness', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-attachment-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'application.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  storage.close();
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  t.after(() => database.close());
  const tables = database.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE '%attachment%' ORDER BY name`).all().map((row) => row.name);
  assert.deepEqual(tables, ['secure_attachment_ingestions']);
  const indexes = database.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'secure_attachment_ingestions' AND sql IS NOT NULL`).all().map((row) => row.sql).join('\n');
  const tableSql = database.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'secure_attachment_ingestions'`).get().sql;
  assert.match(tableSql, /unique\s*\(provider\s*,\s*provider_message_id\s*,\s*provider_attachment_id\)/i);
  assert.match(indexes, /vault_document_id/i);
  assert.match(tableSql, /retention_status[^,]+default 'hold'/i);
  assert.match(tableSql, /scan_attempt_count[^,]+<= 3/i);
  assert.match(tableSql, /lifecycle_status[\s\S]+quarantining/i);
  assert.match(tableSql, /sha256[^,]+not glob/i);
  assert.match(tableSql, /duplicate_of_id[^,]+references secure_attachment_ingestions/i);
  assert.match(tableSql, /approved_submission_id[^,]+references contact_submissions/i);
  assert.match(tableSql, /hold_reason/i);
  assert.match(tableSql, /'scanning'/i);
  assert.match(tableSql, /scan_request_id/i);
  assert.match(tableSql, /scan_job_owner/i);
  assert.match(tableSql, /scan_lease_expires_at/i);
  assert.match(tableSql, /scan_signature_version/i);
  assert.match(tableSql, /scan_verdict_expires_at/i);
  assert.match(indexes, /lifecycle_status\s*=\s*'scanning'/i);
});

test('SQLite attachment lifecycle atomically owns one global scan lease and rejects late completion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-attachment-scan-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'application.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const base = {
    communication_id: 'comm-synthetic', provider: 'synthetic', provider_message_id: 'message',
    original_file_name: 'fixture.pdf', declared_mime_type: 'application/pdf',
    detected_mime_type: 'application/pdf', size_bytes: 10, sha256: 'a'.repeat(64),
    quarantine_path: 'fixture.pdf', duplicate_of_id: null, lifecycle_status: 'scan-pending',
    scan_status: 'pending', scan_attempt_count: 0, scanner_name: null, scanner_version: null,
    scan_last_error: null, next_scan_at: null, hold_reason: null, owner_approved_at: null,
    owner_approved_by: null, approved_submission_id: null, approved_document_type: null,
    vault_request_id: null, vault_document_id: null, vault_relative_path: null, published_at: null,
    retention_status: 'hold', retention_review_at: '2026-11-02T12:00:00.000Z',
    created_at: '2026-10-03T12:00:00.000Z', updated_at: '2026-10-03T12:00:00.000Z',
    scan_request_id: null, scan_job_owner: null, scan_requested_at: null,
    scan_lease_expires_at: null, scan_completed_at: null, scan_request_digest: null,
    scan_signature_version: null, scan_signature_updated_at: null, scan_verdict_expires_at: null,
  };
  await storage.insertCimAttachmentIntake({
    ...base, id: '61111111-1111-4111-8111-111111111111', provider_attachment_id: 'attachment-1',
  });
  await storage.insertCimAttachmentIntake({
    ...base, id: '62222222-2222-4222-8222-222222222222', provider_attachment_id: 'attachment-2',
    sha256: 'b'.repeat(64), quarantine_path: 'fixture-2.pdf',
  });
  await assert.rejects(storage.claimCimAttachmentScan({
    intakeId: '61111111-1111-4111-8111-111111111111',
    requestId: '71111111-1111-4111-8111-111111111111',
    jobOwner: 'synthetic-owner',
    claimedAt: '2026-10-03T12:00:00.000Z',
    leaseExpiresAt: '2026-10-03T12:04:00.001Z',
  }), /bounded window/i);
  const first = await storage.claimCimAttachmentScan({
    intakeId: '61111111-1111-4111-8111-111111111111',
    requestId: '71111111-1111-4111-8111-111111111111',
    jobOwner: 'synthetic-owner',
    claimedAt: '2026-10-03T12:00:00.000Z',
    leaseExpiresAt: '2026-10-03T12:04:00.000Z',
  });
  assert.equal(first.lifecycle_status, 'scanning');
  assert.equal(first.scan_attempt_count, 1);
  assert.equal(await storage.claimCimAttachmentScan({
    intakeId: '62222222-2222-4222-8222-222222222222',
    requestId: '72222222-2222-4222-8222-222222222222',
    jobOwner: 'synthetic-owner',
    claimedAt: '2026-10-03T12:01:00.000Z',
    leaseExpiresAt: '2026-10-03T12:05:00.000Z',
  }), null);

  const expired = await storage.expireCimAttachmentScanLease({
    intakeId: first.id,
    requestId: first.scan_request_id,
    jobOwner: first.scan_job_owner,
    attempt: first.scan_attempt_count,
    now: '2026-10-03T12:05:00.000Z',
  });
  assert.equal(expired.lifecycle_status, 'scan-unavailable');
  assert.equal(expired.hold_reason, 'scan_lease_expired');
  assert.equal(expired.next_scan_at, '2026-10-03T12:20:00.000Z');

  const second = await storage.claimCimAttachmentScan({
    intakeId: '62222222-2222-4222-8222-222222222222',
    requestId: '72222222-2222-4222-8222-222222222222',
    jobOwner: 'synthetic-owner',
    claimedAt: '2026-10-03T12:05:00.000Z',
    leaseExpiresAt: '2026-10-03T12:09:00.000Z',
  });
  assert.equal(second.lifecycle_status, 'scanning');
  await assert.rejects(storage.completeCimAttachmentScan({
    intakeId: second.id,
    requestId: second.scan_request_id,
    jobOwner: second.scan_job_owner,
    attempt: second.scan_attempt_count,
    completedAt: '2026-10-03T12:06:00.000Z',
    verdictExpiresAt: '2026-10-04T12:06:00.001Z',
    result: { outcome: 'clean', reasonCode: 'clean', engineVersion: '', signatureVersion: 'db-1',
      signatureUpdatedAt: '2026-10-03T11:55:00.000Z', requestDigest: 'not-a-digest' },
  }), /engine version|digest|bounded window/i);
  assert.equal(await storage.completeCimAttachmentScan({
    intakeId: first.id,
    requestId: first.scan_request_id,
    jobOwner: first.scan_job_owner,
    attempt: first.scan_attempt_count,
    completedAt: '2026-10-03T12:05:01.000Z',
    verdictExpiresAt: '2026-10-04T12:05:01.000Z',
    result: { outcome: 'clean', reasonCode: 'clean', engineVersion: 'late', signatureVersion: 'late',
      signatureUpdatedAt: '2026-10-03T11:55:00.000Z', requestDigest: 'c'.repeat(64) },
  }), null);
  const completed = await storage.completeCimAttachmentScan({
    intakeId: second.id,
    requestId: second.scan_request_id,
    jobOwner: second.scan_job_owner,
    attempt: second.scan_attempt_count,
    completedAt: '2026-10-03T12:06:00.000Z',
    verdictExpiresAt: '2026-10-04T12:06:00.000Z',
    result: { outcome: 'clean', reasonCode: 'clean', engineVersion: 'ClamAV synthetic', signatureVersion: 'db-1',
      signatureUpdatedAt: '2026-10-03T11:55:00.000Z', requestDigest: 'd'.repeat(64) },
  });
  assert.equal(completed.lifecycle_status, 'awaiting-owner-approval');
  assert.equal(completed.scan_signature_version, 'db-1');
  await storage.updateCimAttachmentIntake(first.id, {
    lifecycle_status: 'awaiting-owner-approval', scan_status: 'clean',
    scan_verdict_expires_at: null, next_scan_at: null,
  }, { expectedStatus: 'scan-unavailable' });
  const reclaimedLegacyHold = await storage.claimCimAttachmentScan({
    intakeId: first.id,
    requestId: '73333333-3333-4333-8333-333333333333',
    jobOwner: 'synthetic-owner',
    claimedAt: '2026-10-03T12:07:00.000Z',
    leaseExpiresAt: '2026-10-03T12:11:00.000Z',
  });
  assert.equal(reclaimedLegacyHold.lifecycle_status, 'scanning');
  await storage.updateCimAttachmentIntake(completed.id, {
    lifecycle_status: 'publishing', scan_verdict_expires_at: null,
  }, { expectedStatus: 'awaiting-owner-approval' });
  await assert.rejects(storage.publishCimAttachmentToVault({
    intakeId: completed.id,
    expectedStatus: 'publishing',
    request: { id: null, submission_id: null },
    document: {},
    publishedAt: '2026-10-03T12:07:00.000Z',
  }), /publication authority/i);
});

test('Supabase migration is additive, service-role-only, and publishes through one atomic RPC', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.equal((migration.match(/create table if not exists public\.secure_attachment_ingestions/gi) || []).length, 1);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all privileges on table public\.secure_attachment_ingestions from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.secure_attachment_ingestions to service_role/i);
  assert.match(migration, /security definer[\s\S]+set search_path = ''/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /insert into public\.secure_upload_requests[\s\S]+insert into public\.secure_documents[\s\S]+lifecycle_status = 'published'/i);
  assert.match(migration, /crm_submission_supersessions[\s\S]+superseded_submission_id = v_intake\.approved_submission_id[\s\S]+status = 'active'/i);
  assert.match(migration, /v_intake\.approved_submission_id\s+is distinct from\s+\(v_request ->> 'submission_id'\)::uuid/i);
  assert.match(migration, /\(v_communication ->> 'submission_id'\)::uuid\s+is distinct from\s+v_intake\.approved_submission_id/i);
  assert.match(migration, /revoke all on function public\.publish_cim_attachment_to_vault_v1\(jsonb\)[\s\S]+public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.publish_cim_attachment_to_vault_v1\(jsonb\) to service_role/i);
  assert.equal(/delete from public\.secure_attachment_ingestions|drop table public\.secure_attachment_ingestions/i.test(migration), false);

  const schema = fs.readFileSync(schemaPath, 'utf8');
  assert.match(schema, /create table if not exists public\.secure_attachment_ingestions/i);
  assert.match(schema, /create or replace function public\.publish_cim_attachment_to_vault_v1/i);
});

test('offline scanner SQL is an unapplied service-role-only proposal, not a production migration', () => {
  const proposal = fs.readFileSync(scannerProposalPath, 'utf8');
  assert.match(proposal, /UNAPPLIED P8-03 PROPOSAL/i);
  assert.match(proposal, /drop constraint[\s\S]+lifecycle_status[\s\S]+add constraint/i);
  assert.match(proposal, /where lifecycle_status = 'scanning'/i);
  assert.match(proposal, /claim_cim_attachment_scan_v1/i);
  assert.match(proposal, /complete_cim_attachment_scan_v1/i);
  assert.match(proposal, /expire_cim_attachment_scan_lease_v1/i);
  assert.match(proposal, /v_completed timestamptz := pg_catalog\.clock_timestamp\(\)/i);
  assert.match(proposal, /v_now timestamptz := pg_catalog\.clock_timestamp\(\)/i);
  assert.match(proposal, /v_request_id is null or v_job_owner is null/i);
  assert.match(proposal, /v_lease is null or v_lease <= v_now/i);
  assert.match(proposal, /v_signature_updated_at < v_completed - interval '24 hours'/i);
  assert.match(proposal, /v_request_digest is null or v_request_digest !~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(proposal, /scan_verdict_expires_at = case when v_outcome = 'clean'[\s\S]+v_completed \+ interval '24 hours'/i);
  assert.match(proposal, /security definer[\s\S]+set search_path = ''/i);
  assert.match(proposal, /revoke all[\s\S]+public, anon, authenticated/i);
  assert.equal(fs.existsSync(path.resolve('supabase/migrations/20261012120000_offline_on_demand_scanner.sql')), false);
});

test('SQLite rebuild proposal preserves an exact PR55 fixture and is not runtime-wired', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-attachment-p803-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'fixture.sqlite');
  const failurePath = path.join(root, 'failure.sqlite');
  const database = new Database(databasePath);
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE contact_submissions (id TEXT PRIMARY KEY);
    CREATE TABLE secure_attachment_ingestions (
      id TEXT PRIMARY KEY, communication_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_message_id TEXT NOT NULL, provider_attachment_id TEXT NOT NULL,
      original_file_name TEXT NOT NULL, declared_mime_type TEXT NOT NULL,
      detected_mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      quarantine_path TEXT NOT NULL,
      duplicate_of_id TEXT REFERENCES secure_attachment_ingestions(id) ON DELETE RESTRICT,
      lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
        'quarantining', 'scan-pending', 'scan-unavailable', 'unsafe',
        'awaiting-owner-approval', 'publishing', 'published'
      )),
      scan_status TEXT NOT NULL CHECK (scan_status IN ('pending', 'clean', 'unsafe', 'unavailable')),
      scan_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (scan_attempt_count BETWEEN 0 AND 3),
      scanner_name TEXT, scanner_version TEXT, scan_last_error TEXT, next_scan_at TEXT,
      hold_reason TEXT, owner_approved_at TEXT, owner_approved_by TEXT,
      approved_submission_id TEXT REFERENCES contact_submissions(id) ON DELETE RESTRICT,
      approved_document_type TEXT, vault_request_id TEXT, vault_document_id TEXT,
      vault_relative_path TEXT, published_at TEXT,
      retention_status TEXT NOT NULL DEFAULT 'hold' CHECK (retention_status = 'hold'),
      retention_review_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (provider, provider_message_id, provider_attachment_id)
    );
    INSERT INTO secure_attachment_ingestions (
      id, communication_id, provider, provider_message_id, provider_attachment_id,
      original_file_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
      quarantine_path, lifecycle_status, scan_status, retention_review_at, created_at, updated_at
    ) VALUES (
      'fixture', 'comm', 'synthetic', 'message', 'attachment', 'fixture.pdf',
      'application/pdf', 'application/pdf', 10, '${'a'.repeat(64)}', 'fixture.pdf',
      'scan-pending', 'pending', '2026-11-02T00:00:00.000Z',
      '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'
    );
  `);
  fs.copyFileSync(databasePath, failurePath);
  database.exec(fs.readFileSync(sqliteProposalPath, 'utf8'));
  const row = database.prepare('SELECT * FROM secure_attachment_ingestions WHERE id = ?').get('fixture');
  assert.equal(row.lifecycle_status, 'scan-pending');
  assert.equal(row.sha256, 'a'.repeat(64));
  assert.equal(row.scan_request_id, null);
  database.prepare(`UPDATE secure_attachment_ingestions SET lifecycle_status = 'scanning',
    scan_request_id = 'request' WHERE id = 'fixture'`).run();
  assert.equal(database.prepare('SELECT lifecycle_status FROM secure_attachment_ingestions').get().lifecycle_status, 'scanning');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  const indexes = new Set(database.pragma('index_list(secure_attachment_ingestions)').map((entry) => entry.name));
  for (const expected of [
    'idx_secure_attachment_ingestions_sha256',
    'idx_secure_attachment_ingestions_communication',
    'idx_secure_attachment_ingestions_vault_document',
    'idx_secure_attachment_ingestions_single_scanning',
  ]) assert.equal(indexes.has(expected), true, `missing rebuilt index ${expected}`);

  const failure = new Database(failurePath);
  t.after(() => failure.close());
  failure.prepare(`UPDATE secure_attachment_ingestions SET vault_document_id = 'duplicate-vault'
    WHERE id = 'fixture'`).run();
  failure.exec(`INSERT INTO secure_attachment_ingestions (
    id, communication_id, provider, provider_message_id, provider_attachment_id,
    original_file_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
    quarantine_path, lifecycle_status, scan_status, scan_attempt_count,
    scanner_name, scanner_version, scan_last_error, next_scan_at, hold_reason,
    owner_approved_at, owner_approved_by, approved_submission_id, approved_document_type,
    vault_request_id, vault_document_id, vault_relative_path, published_at,
    retention_status, retention_review_at, created_at, updated_at
  ) SELECT
    'fixture-2', communication_id, provider, provider_message_id, 'attachment-2',
    original_file_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
    quarantine_path, lifecycle_status, scan_status, scan_attempt_count,
    scanner_name, scanner_version, scan_last_error, next_scan_at, hold_reason,
    owner_approved_at, owner_approved_by, approved_submission_id, approved_document_type,
    vault_request_id, vault_document_id, vault_relative_path, published_at,
    retention_status, retention_review_at, created_at, updated_at
  FROM secure_attachment_ingestions WHERE id = 'fixture'`);
  assert.throws(() => failure.exec(fs.readFileSync(sqliteProposalPath, 'utf8')), /unique/i);
  failure.exec('rollback; pragma foreign_keys = on;');
  assert.equal(failure.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(failure.pragma('foreign_key_check'), []);
  assert.equal(failure.prepare('SELECT COUNT(*) AS count FROM secure_attachment_ingestions').get().count, 2);
  assert.equal(failure.pragma('table_info(secure_attachment_ingestions)')
    .some((column) => column.name === 'scan_request_id'), false);
  const source = fs.readFileSync(path.resolve('server/storage/sqlite.js'), 'utf8');
  assert.doesNotMatch(source, /p8-03-sqlite-local-fixture|secure_attachment_ingestions_p802/i);
});

test('quarantine has no HTTP route or default live scanner implementation', () => {
  const app = fs.readFileSync(path.resolve('server/app.js'), 'utf8');
  const intakeService = fs.readFileSync(path.resolve('server/services/cimAttachmentIntake.js'), 'utf8');
  const testScanner = fs.readFileSync(path.resolve('test/support/cimAttachmentScanner.js'), 'utf8');
  assert.equal(/cim[-_/]attachment.*download/i.test(app), false);
  assert.equal(/fetch\s*\(|resend|clamav|clamd|scanner.*url/i.test(intakeService), false);
  assert.doesNotMatch(intakeService, /createDeterministicFakeScanner|deterministic-fake/);
  assert.match(testScanner, /createDeterministicFakeScanner/);
  const appScanner = fs.readFileSync(path.resolve('server/services/onDemandCimScanner.js'), 'utf8');
  const flyTransport = fs.readFileSync(path.resolve('server/services/flyMachineScanTransport.js'), 'utf8');
  const clamav = fs.readFileSync(path.resolve('server/services/clamavUnixSocketScanner.js'), 'utf8');
  assert.doesNotMatch(appScanner, /process\.env|fetch\s*\(|machine[_-]?id\s*=/i);
  assert.doesNotMatch(flyTransport, /process\.env|fetch\s*\(|@fly|flyctl/i);
  assert.doesNotMatch(clamav, /createConnection|host\s*:|port\s*:|3310/i);
});
