import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  createBackupBundle,
  enforceBackupRetention,
  getBackupStatus,
  listBackupBundles,
  restoreBackupBundle,
  verifyBackupBundle,
} from '../server/services/backups.js';

function testConfig(root) {
  return {
    storage: { provider: 'sqlite', sqlitePath: path.join(root, 'source.sqlite') },
    secureDocuments: { storageDir: path.join(root, 'secure-documents') },
    protection: { rateLimitRetentionMs: 0 },
    backup: {
      enabled: true,
      directory: path.join(root, 'backups'),
      retentionDays: 30,
      retentionCount: 2,
      time: '03:30',
      timezone: 'America/Los_Angeles',
      checkIntervalMs: 900000,
    },
  };
}

test('SQLite backup drill snapshots, verifies, retains, and restores database and secure files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-recovery-drill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const requestDirectory = path.join(config.secureDocuments.storageDir, 'request-1');
  fs.mkdirSync(requestDirectory, { recursive: true });
  const sourceDocument = path.join(requestDirectory, 'financials.txt');
  fs.writeFileSync(sourceDocument, 'confidential recovery drill');

  await storage.insertSecureDocument({
    id: 'document-1', request_id: 'request-1', submission_id: 'submission-1',
    created_at: '2026-07-13T10:00:00.000Z', document_type: 'financials',
    file_name: 'financials.txt', original_name: 'financials.txt', mime_type: 'text/plain',
    size_bytes: Buffer.byteLength('confidential recovery drill'), storage_path: sourceDocument,
    uploaded_by_email: 'seller@example.com', note: '', nda_accepted_at: '2026-07-13T10:00:00.000Z',
  });

  const first = await createBackupBundle({ storage, config, now: new Date('2026-07-13T12:00:00.000Z') });
  const second = await createBackupBundle({ storage, config, now: new Date('2026-07-14T12:00:00.000Z') });
  await createBackupBundle({ storage, config, now: new Date('2026-07-15T12:00:00.000Z') });
  const bundles = await listBackupBundles(config);

  assert.equal(fs.existsSync(first.path), false, 'oldest backup should be removed by count retention');
  assert.equal(bundles.length, 2);
  const verification = await verifyBackupBundle(second.path);
  assert.equal(verification.ok, true, verification.errors.join(' '));
  assert.equal(verification.manifest.secureDocuments.count, 1);

  const restoredDatabasePath = path.join(root, 'drill', 'restored.sqlite');
  const restoredDocuments = path.join(root, 'drill', 'documents');
  const restore = await restoreBackupBundle(second.path, {
    databasePath: restoredDatabasePath,
    documentsDirectory: restoredDocuments,
  });
  assert.equal(restore.ok, true);
  assert.equal(restore.restoredDocuments, 1);

  const restoredDatabase = new Database(restoredDatabasePath, { readonly: true });
  const row = restoredDatabase.prepare('SELECT storage_path FROM secure_documents WHERE id = ?').get('document-1');
  assert.equal(restoredDatabase.pragma('quick_check', { simple: true }), 'ok');
  restoredDatabase.close();
  assert.ok(row.storage_path.startsWith(restoredDocuments));
  assert.equal(fs.readFileSync(row.storage_path, 'utf8'), 'confidential recovery drill');
});

test('backup verification detects secure-document tampering', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const backup = await createBackupBundle({ storage, config });
  const manifest = backup.manifest;
  assert.equal((await verifyBackupBundle(backup.path)).ok, true);
  fs.appendFileSync(path.join(backup.path, manifest.database.relativePath), 'tampered');
  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /checksum|size/i.test(error)));
  const status = await getBackupStatus(config);
  assert.equal(status.status, 'invalid');
  assert.ok(status.verificationErrors.length > 0);
});

test('backup verification rejects manifest paths outside the bundle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const backup = await createBackupBundle({ storage, config });
  const manifestPath = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.database.relativePath = '../../outside.sqlite';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /outside the backup bundle/i.test(error)));
});

test('backup verification requires every manifest document to match its SQLite row', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-row-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const requestDirectory = path.join(config.secureDocuments.storageDir, 'request-row-match');
  fs.mkdirSync(requestDirectory, { recursive: true });
  const sourceDocument = path.join(requestDirectory, 'financials.txt');
  fs.writeFileSync(sourceDocument, 'manifest row correspondence');
  await storage.insertSecureDocument({
    id: 'document-row-match', request_id: 'request-row-match', submission_id: 'submission-row-match',
    created_at: '2026-07-13T10:00:00.000Z', document_type: 'financials',
    file_name: 'financials.txt', original_name: 'financials.txt', mime_type: 'text/plain',
    size_bytes: Buffer.byteLength('manifest row correspondence'), storage_path: sourceDocument,
    uploaded_by_email: 'seller@example.com', note: '', nda_accepted_at: '2026-07-13T10:00:00.000Z',
  });
  const backup = await createBackupBundle({ storage, config });
  const manifestPath = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.secureDocuments.files[0].id = 'different-document-id';
  manifest.secureDocuments.files[0].requestId = 'different-request-id';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verification = await verifyBackupBundle(backup.path);

  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => /does not exist in the database snapshot/i.test(error)));
  await assert.rejects(
    restoreBackupBundle(backup.path, {
      databasePath: path.join(root, 'restore', 'database.sqlite'),
      documentsDirectory: path.join(root, 'restore', 'documents'),
    }),
    /backup verification failed/i,
  );
});

test('backup verification rejects a malformed zero-document manifest before restore', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const backup = await createBackupBundle({ storage, config });
  const manifestPath = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.secureDocuments;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verification = await verifyBackupBundle(backup.path);
  assert.equal(verification.ok, false);
  assert.ok(verification.errors.some((error) => /secureDocuments section is required/i.test(error)));
  await assert.rejects(
    restoreBackupBundle(backup.path, {
      databasePath: path.join(root, 'restore', 'database.sqlite'),
      documentsDirectory: path.join(root, 'restore', 'documents'),
    }),
    /backup verification failed/i,
  );
  const status = await getBackupStatus(config);
  assert.equal(status.status, 'invalid');
  assert.deepEqual(status.bundleCounts, { valid: 0, invalid: 1, incomplete: 0 });
});

test('restore removes its staging directory when installation fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-restore-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const backup = await createBackupBundle({ storage, config });
  const restoreRoot = path.join(root, 'restore');
  const targetDatabase = path.join(restoreRoot, 'database.sqlite');
  const targetDocuments = path.join(restoreRoot, 'documents');
  fs.mkdirSync(targetDocuments, { recursive: true });
  fs.writeFileSync(path.join(targetDocuments, 'keep.txt'), 'existing documents');

  await assert.rejects(
    restoreBackupBundle(backup.path, {
      databasePath: targetDatabase,
      documentsDirectory: targetDocuments,
    }),
    /restore destination already exists/i,
  );

  const stagePrefix = `${path.basename(targetDatabase)}.restore-`;
  assert.equal(fs.readdirSync(restoreRoot).some((entry) => entry.startsWith(stagePrefix)), false);
  assert.equal(fs.readFileSync(path.join(targetDocuments, 'keep.txt'), 'utf8'), 'existing documents');
});

test('retention prunes stale incomplete and invalid bundles but preserves recent work and reports it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  await createBackupBundle({ storage, config });

  const staleIncomplete = path.join(config.backup.directory, 'backup-stale.incomplete');
  const activeIncomplete = path.join(config.backup.directory, 'backup-active.incomplete');
  const recentIncomplete = path.join(config.backup.directory, 'backup-recent.incomplete');
  const staleInvalid = path.join(config.backup.directory, 'backup-stale-invalid');
  const recentInvalid = path.join(config.backup.directory, 'backup-recent-invalid');
  for (const directory of [staleIncomplete, activeIncomplete, recentIncomplete, staleInvalid, recentInvalid]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(activeIncomplete, '.active.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(staleInvalid, 'manifest.json'), '{invalid');
  fs.writeFileSync(path.join(recentInvalid, 'manifest.json'), '{invalid');
  const now = new Date();
  const stale = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  fs.utimesSync(staleIncomplete, stale, stale);
  fs.utimesSync(activeIncomplete, stale, stale);
  fs.utimesSync(staleInvalid, stale, stale);

  const removed = await enforceBackupRetention(config, now);
  assert.ok(removed.includes(staleIncomplete));
  assert.ok(removed.includes(staleInvalid));
  assert.equal(fs.existsSync(staleIncomplete), false);
  assert.equal(fs.existsSync(staleInvalid), false);
  assert.equal(fs.existsSync(activeIncomplete), true);
  assert.equal(fs.existsSync(recentIncomplete), true);
  assert.equal(fs.existsSync(recentInvalid), true);

  const status = await getBackupStatus(config);
  assert.equal(status.status, 'degraded');
  assert.deepEqual(status.bundleCounts, { valid: 1, invalid: 1, incomplete: 2 });
  assert.match(status.message, /1 invalid and 2 incomplete/i);
});
