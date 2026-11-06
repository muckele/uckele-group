import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  createBackupBundle,
  enforceBackupRetention,
  getBackupStatus,
  listBackupBundles,
  restoreBackupBundle,
  startBackupScheduler,
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

const sqliteSidecarSuffixes = ['-wal', '-shm', '-journal'];

function backupDatabasePath(backup) {
  return path.join(backup.path, backup.manifest.database.relativePath);
}

function assertBackupIsSidecarFree(backup) {
  const databasePath = backupDatabasePath(backup);
  for (const suffix of sqliteSidecarSuffixes) {
    assert.equal(fs.existsSync(`${databasePath}${suffix}`), false, `backup must not contain ${suffix}`);
  }
}

function sqliteSidecars(databasePath) {
  return sqliteSidecarSuffixes.filter((suffix) => fs.existsSync(`${databasePath}${suffix}`));
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sqliteHeaderBytes(databasePath) {
  return [...fs.readFileSync(databasePath).subarray(18, 20)];
}

function writeEmptyBackupManifest(bundlePath, databasePath, {
  version = 1,
  id = 'legacy-backup',
  createdAt = '2026-08-29T20:45:00.000Z',
} = {}) {
  const databaseBytes = fs.readFileSync(databasePath);
  const manifest = {
    version,
    id,
    createdAt,
    provider: 'sqlite',
    database: {
      relativePath: path.basename(databasePath),
      sizeBytes: databaseBytes.length,
      sha256: createHash('sha256').update(databaseBytes).digest('hex'),
    },
    secureDocuments: { count: 0, totalBytes: 0, files: [] },
    retention: { days: 30, count: 2 },
    verification: { verifiedAt: createdAt, databaseCheck: 'quick_check', checksum: 'sha256' },
  };
  fs.writeFileSync(path.join(bundlePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

test('verification rejects a raw WAL-mode main file whose committed WAL state is missing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-missing-wal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.sqlite');
  const source = new Database(sourcePath);
  t.after(() => source.close());
  assert.equal(source.pragma('journal_mode = WAL', { simple: true }), 'wal');
  source.exec('CREATE TABLE wal_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  source.pragma('wal_checkpoint(TRUNCATE)');
  source.pragma('wal_autocheckpoint = 0');
  source.prepare('INSERT INTO wal_records (value) VALUES (?)').run('committed-only-in-wal');

  assert.equal(source.prepare('SELECT COUNT(*) AS count FROM wal_records').get().count, 1);
  assert.ok(fs.statSync(`${sourcePath}-wal`).size > 0, 'committed record must remain in the source WAL');

  const bundlePath = path.join(root, 'backup-missing-wal');
  fs.mkdirSync(bundlePath);
  const databasePath = path.join(bundlePath, 'database.sqlite');
  fs.copyFileSync(sourcePath, databasePath);
  const rawMainBytes = fs.readFileSync(databasePath);
  assert.deepEqual([...rawMainBytes.subarray(18, 20)], [2, 2]);
  const inspectableRawMain = Buffer.from(rawMainBytes);
  inspectableRawMain[18] = 1;
  inspectableRawMain[19] = 1;
  const rawMain = new Database(inspectableRawMain);
  assert.equal(rawMain.prepare('SELECT COUNT(*) AS count FROM wal_records').get().count, 0);
  rawMain.close();

  writeEmptyBackupManifest(bundlePath, databasePath, { id: 'missing-wal-regression' });

  const verification = await verifyBackupBundle(bundlePath);

  assert.equal(verification.ok, false, 'a raw main file without its committed WAL must never be certified');
  assert.equal(verification.legacy, true);
  assert.equal(verification.classification, 'legacy');
});

test('SQLite online-backup and old-style on-disk read primitives expose the WAL-header sidecar behavior', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-primitives-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const source = new Database(config.storage.sqlitePath, { readonly: true, fileMustExist: true });
  assert.equal(source.pragma('journal_mode', { simple: true }), 'wal');
  source.close();

  const destination = path.join(root, 'direct-online-backup.sqlite');
  await storage.createApplicationBackup(destination);

  assert.deepEqual(sqliteSidecars(destination), [], 'database.backup(destination) must leave no sidecars');
  assert.deepEqual(sqliteHeaderBytes(destination), [2, 2]);
  const readOnly = new Database(destination, { readonly: true, fileMustExist: true });
  assert.deepEqual(sqliteSidecars(destination), [], 'read-only construction alone must not create sidecars');
  readOnly.prepare('SELECT 1 AS ok').get();
  assert.equal(fs.statSync(`${destination}-wal`).size, 0);
  assert.ok(fs.statSync(`${destination}-shm`).size > 0);
  assert.equal(fs.existsSync(`${destination}-journal`), false);
  readOnly.close();
});

test('WAL-mode backup creation captures committed WAL state and persists immutable current-format bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-sidecar-free-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const sourceDatabase = new Database(config.storage.sqlitePath);
  t.after(() => sourceDatabase.close());
  assert.equal(sourceDatabase.pragma('journal_mode', { simple: true }), 'wal');
  sourceDatabase.exec('CREATE TABLE backup_wal_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  sourceDatabase.pragma('wal_autocheckpoint = 0');
  sourceDatabase.prepare('INSERT INTO backup_wal_records (value) VALUES (?)').run('captured-from-wal');
  assert.equal(sourceDatabase.prepare('SELECT COUNT(*) AS count FROM backup_wal_records').get().count, 1);
  assert.ok(fs.statSync(`${config.storage.sqlitePath}-wal`).size > 0);

  const directDestination = path.join(root, 'direct-wal-snapshot.sqlite');
  await storage.createApplicationBackup(directDestination);
  assert.deepEqual(sqliteSidecars(directDestination), []);
  assert.deepEqual(sqliteHeaderBytes(directDestination), [2, 2]);
  const directBytes = fs.readFileSync(directDestination);
  directBytes[18] = 1;
  directBytes[19] = 1;
  const directSnapshot = new Database(directBytes);
  assert.equal(directSnapshot.prepare('SELECT COUNT(*) AS count FROM backup_wal_records').get().count, 1);
  assert.equal(directSnapshot.pragma('quick_check', { simple: true }), 'ok');
  directSnapshot.close();
  assert.ok(fs.statSync(`${config.storage.sqlitePath}-wal`).size > 0, 'online backup must not checkpoint the source WAL');

  const now = new Date('2026-08-29T20:30:00.000Z');
  const backup = await createBackupBundle({ storage, config, now });

  assert.deepEqual(fs.readdirSync(backup.path).sort(), ['database.sqlite', 'manifest.json']);
  assert.equal(backup.manifest.version, 2);
  assertBackupIsSidecarFree(backup);
  const databasePath = backupDatabasePath(backup);
  const manifestPath = path.join(backup.path, 'manifest.json');
  assert.deepEqual(sqliteHeaderBytes(databasePath), [1, 1]);
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
  assert.equal(backup.manifest.database.sha256, fileSha256(databasePath));
  const persistedDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(persistedDatabase.prepare('SELECT COUNT(*) AS count FROM backup_wal_records').get().count, 1);
  assert.equal(persistedDatabase.pragma('quick_check', { simple: true }), 'ok');
  persistedDatabase.close();
  assertBackupIsSidecarFree(backup);

  const databaseSha256 = fileSha256(databasePath);
  const manifestSha256 = fileSha256(manifestPath);
  for (let verificationAttempt = 0; verificationAttempt < 2; verificationAttempt += 1) {
    const verification = await verifyBackupBundle(backup.path);
    assert.equal(verification.ok, true, verification.errors.join(' '));
    assert.equal(verification.current, true);
    assert.equal(verification.classification, 'current');
    assert.equal(fileSha256(databasePath), databaseSha256);
    assert.equal(fileSha256(manifestPath), manifestSha256);
    assertBackupIsSidecarFree(backup);
  }

  const bundles = await listBackupBundles(config);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].state, 'valid');
  assert.equal(fileSha256(databasePath), databaseSha256);
  assert.equal(fileSha256(manifestPath), manifestSha256);
  assertBackupIsSidecarFree(backup);
  assert.deepEqual(await enforceBackupRetention(config, now), []);
  assert.equal(fileSha256(databasePath), databaseSha256);
  assert.equal(fileSha256(manifestPath), manifestSha256);
  assertBackupIsSidecarFree(backup);
});

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
  assert.equal(second.manifest.version, 2);
  assert.deepEqual(sqliteHeaderBytes(backupDatabasePath(second)), [1, 1]);
  assertBackupIsSidecarFree(second);
  const verification = await verifyBackupBundle(second.path);
  assert.equal(verification.ok, true, verification.errors.join(' '));
  assert.equal(verification.manifest.secureDocuments.count, 1);
  assertBackupIsSidecarFree(second);

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
  assert.equal(
    restoredDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'secure_documents'").get().count,
    1,
  );
  assert.equal(restoredDatabase.pragma('quick_check', { simple: true }), 'ok');
  restoredDatabase.close();
  assert.deepEqual(sqliteSidecars(restoredDatabasePath), []);
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

for (const { suffix, bytes } of [
  { suffix: '-wal', bytes: Buffer.alloc(0) },
  { suffix: '-shm', bytes: Buffer.alloc(32 * 1024) },
  { suffix: '-journal', bytes: Buffer.alloc(0) },
]) {
  test(`backup verification rejects an unmanifested SQLite ${suffix} sidecar without creating another sidecar`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-sidecar-rejection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = testConfig(root);
    const storage = createSqliteStorage(config);
    t.after(() => storage.close());
    const backup = await createBackupBundle({ storage, config });
    assertBackupIsSidecarFree(backup);
    const databasePath = backupDatabasePath(backup);
    const manifestPath = path.join(backup.path, 'manifest.json');
    const databaseSha256 = fileSha256(databasePath);
    const manifestSha256 = fileSha256(manifestPath);
    const sidecarPath = `${databasePath}${suffix}`;
    fs.writeFileSync(sidecarPath, bytes);
    const sidecarBefore = { size: fs.statSync(sidecarPath).size, sha256: fileSha256(sidecarPath) };

    const verification = await verifyBackupBundle(backup.path);

    assert.equal(verification.ok, false);
    assert.ok(
      verification.errors.some((error) => error.includes('unverified SQLite sidecar') && error.includes(suffix)),
      verification.errors.join(' '),
    );
    const presentSidecars = sqliteSidecarSuffixes.filter((candidate) => fs.existsSync(`${databasePath}${candidate}`));
    assert.deepEqual(presentSidecars, [suffix]);
    assert.deepEqual(
      { size: fs.statSync(sidecarPath).size, sha256: fileSha256(sidecarPath) },
      sidecarBefore,
    );
    assert.equal(fileSha256(databasePath), databaseSha256);
    assert.equal(fileSha256(manifestPath), manifestSha256);
  });
}

test('current-format verification fails closed on persisted 2/2 bytes even when manifest size and checksum match', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-current-wal-header-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const backup = await createBackupBundle({ storage, config });
  const databasePath = backupDatabasePath(backup);
  const manifestPath = path.join(backup.path, 'manifest.json');
  const databaseBytes = fs.readFileSync(databasePath);
  databaseBytes[18] = 2;
  databaseBytes[19] = 2;
  fs.writeFileSync(databasePath, databaseBytes);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.database.sizeBytes = databaseBytes.length;
  manifest.database.sha256 = createHash('sha256').update(databaseBytes).digest('hex');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verification = await verifyBackupBundle(backup.path);

  assert.equal(verification.ok, false);
  assert.equal(verification.classification, 'invalid');
  assert.ok(verification.errors.some((error) => /must persist SQLite rollback header bytes 1\/1; found 2\/2/i.test(error)));
  assert.deepEqual(sqliteSidecars(databasePath), []);
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
  assert.deepEqual(status.bundleCounts, { valid: 0, degraded: 0, legacy: 0, invalid: 1, incomplete: 0 });
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

test('retention classifies and preserves historical v1 WAL-header bundles without treating them as current', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-legacy-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  const legacyPath = path.join(config.backup.directory, 'backup-legacy-v1');
  fs.mkdirSync(legacyPath, { recursive: true });
  const legacyDatabasePath = path.join(legacyPath, 'database.sqlite');
  await storage.createApplicationBackup(legacyDatabasePath);
  assert.deepEqual(sqliteHeaderBytes(legacyDatabasePath), [2, 2]);
  writeEmptyBackupManifest(legacyPath, legacyDatabasePath, {
    id: 'preserved-legacy-v1',
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  const before = Object.fromEntries(
    fs.readdirSync(legacyPath).sort().map((name) => [name, fileSha256(path.join(legacyPath, name))]),
  );
  const stale = new Date('2026-06-01T00:00:00.000Z');
  fs.utimesSync(legacyPath, stale, stale);

  const verification = await verifyBackupBundle(legacyPath);
  assert.equal(verification.ok, false);
  assert.equal(verification.legacy, true);
  assert.equal(verification.classification, 'legacy');
  assert.match(verification.errors.join(' '), /pre-invariant.*not eligible/i);
  const [listed] = await listBackupBundles(config);
  assert.equal(listed.state, 'legacy');
  const removed = await enforceBackupRetention(config, new Date('2026-08-29T21:00:00.000Z'));
  assert.equal(removed.includes(legacyPath), false);
  assert.equal(fs.existsSync(legacyPath), true);
  assert.deepEqual(
    Object.fromEntries(fs.readdirSync(legacyPath).sort().map((name) => [name, fileSha256(path.join(legacyPath, name))])),
    before,
  );
  const status = await getBackupStatus(config);
  assert.equal(status.status, 'legacy');
  assert.deepEqual(status.bundleCounts, { valid: 0, degraded: 0, legacy: 1, invalid: 0, incomplete: 0 });
  await assert.rejects(
    restoreBackupBundle(legacyPath, {
      databasePath: path.join(root, 'restore', 'database.sqlite'),
      documentsDirectory: path.join(root, 'restore', 'documents'),
    }),
    /legacy pre-invariant backup.*not eligible/i,
  );
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
  assert.deepEqual(status.bundleCounts, { valid: 1, degraded: 0, legacy: 0, invalid: 1, incomplete: 2 });
  assert.match(status.message, /1 invalid and 2 incomplete/i);
});

const documentContent = 'confidential recovery drill';

async function seedVaultDocument(storage, config, { sizeBytes = Buffer.byteLength(documentContent) } = {}) {
  const requestDirectory = path.join(config.secureDocuments.storageDir, 'request-1');
  fs.mkdirSync(requestDirectory, { recursive: true });
  const sourceDocument = path.join(requestDirectory, 'financials.txt');
  fs.writeFileSync(sourceDocument, documentContent);
  await storage.insertSecureDocument({
    id: 'document-1', request_id: 'request-1', submission_id: 'submission-1',
    created_at: '2026-07-13T10:00:00.000Z', document_type: 'financials',
    file_name: 'financials.txt', original_name: 'financials.txt', mime_type: 'text/plain',
    size_bytes: sizeBytes, storage_path: sourceDocument,
    uploaded_by_email: 'seller@example.com', note: '', nda_accepted_at: '2026-07-13T10:00:00.000Z',
  });
  return sourceDocument;
}

function backupSetup(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  const storage = createSqliteStorage(config);
  t.after(() => storage.close());
  return { root, config, storage };
}

function bundledDocumentPath(backup) {
  return path.join(backup.path, backup.manifest.secureDocuments.files[0].relativePath);
}

// Replace the bundled file rather than writing through it. Bundled documents are hardlinks of the
// vault file, so an in-place write would damage the vault copy (and every other bundle) as well.
function damageBundledDocument(backup, content = 'x'.repeat(Buffer.byteLength(documentContent))) {
  const bundled = bundledDocumentPath(backup);
  fs.rmSync(bundled);
  fs.writeFileSync(bundled, content);
}

test('a bundle whose stored document no longer matches its checksum is degraded, kept past 24 hours, and not restorable', async (t) => {
  const { root, config, storage } = backupSetup(t, 'ug-backup-degraded-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  assert.deepEqual(backup.documentsDegraded, []);
  damageBundledDocument(backup);

  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.classification, 'degraded');
  assert.equal(result.ok, false);
  assert.equal(result.databaseVerified, true);
  assert.deepEqual(result.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  assert.ok(result.errors.some((error) => /document-1 checksum does not match/.test(error)));

  const removed = await enforceBackupRetention(config, new Date(Date.now() + 48 * 3600_000));
  assert.equal(removed.includes(backup.path), false);
  assert.equal(fs.existsSync(backup.path), true);

  const status = await getBackupStatus(config);
  assert.equal(status.status, 'degraded');
  assert.equal(status.bundleCounts.degraded, 1);
  assert.match(status.message, /^1 backup bundle holds documents that changed after they were backed up \(id: document-1\)\. Their database backups are intact and kept\. Check the live vault file and recover it from a Fly volume snapshot\. Use --accept-degraded-documents only if you must restore the database from one of these bundles\.$/);
  assert.doesNotMatch(status.message, /valid application backup is available/);
  assert.deepEqual(status.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  assert.ok(status.latest);

  const databasePath = path.join(root, 'restore', 'database.sqlite');
  const documentsDirectory = path.join(root, 'restore', 'documents');
  await assert.rejects(restoreBackupBundle(backup.path, { databasePath, documentsDirectory }), /Backup verification failed/);
  const restored = await restoreBackupBundle(backup.path, { databasePath, documentsDirectory, acceptDegradedDocuments: true });
  assert.deepEqual(restored.degradedDocuments, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  assert.equal(restored.restoredDocuments, 1);
  const restoredDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.equal(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM secure_documents WHERE id = ?').get('document-1').count, 1);
  } finally {
    restoredDatabase.close();
  }
});

test('a bundled document that differs in size or cannot be read is degraded with its own reason', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-degraded-reasons-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  const bundled = bundledDocumentPath(backup);

  damageBundledDocument(backup, `${documentContent}extra`);
  assert.deepEqual((await verifyBackupBundle(backup.path)).documentsDegraded, [
    { id: 'document-1', reason: 'size_mismatch' },
    { id: 'document-1', reason: 'checksum_mismatch' },
  ]);

  fs.rmSync(bundled);
  const missing = await verifyBackupBundle(backup.path);
  assert.equal(missing.classification, 'degraded');
  assert.deepEqual(missing.documentsDegraded, [{ id: 'document-1', reason: 'unreadable' }]);
});

test('acceptDegradedDocuments never restores an invalid bundle', async (t) => {
  const { root, config, storage } = backupSetup(t, 'ug-backup-degraded-invalid-');
  const backup = await createBackupBundle({ storage, config });
  fs.appendFileSync(backupDatabasePath(backup), 'tampered');
  await assert.rejects(
    restoreBackupBundle(backup.path, {
      databasePath: path.join(root, 'restore', 'database.sqlite'),
      documentsDirectory: path.join(root, 'restore', 'documents'),
      acceptDegradedDocuments: true,
    }),
    /Backup verification failed/,
  );
});

test('a document problem alongside a database problem keeps the bundle invalid', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-degraded-mixed-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  damageBundledDocument(backup);
  fs.appendFileSync(backupDatabasePath(backup), 'tampered');
  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.classification, 'invalid');
  assert.equal(result.databaseVerified, false);
});

test('a vault document whose size no longer matches its row still lets the database backup succeed', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-size-mismatch-');
  const sourceDocument = await seedVaultDocument(storage, config);
  fs.appendFileSync(sourceDocument, ' plus appended bytes');
  const backup = await createBackupBundle({ storage, config });
  assert.deepEqual(backup.documentsDegraded, [{ id: 'document-1', reason: 'database_size_mismatch' }]);
  assert.equal(fs.existsSync(backup.path), true);
  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.classification, 'degraded');
  assert.equal(result.databaseVerified, true);
});

test('a missing vault document still fails the backup', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-missing-source-');
  const sourceDocument = await seedVaultDocument(storage, config);
  fs.rmSync(sourceDocument);
  await assert.rejects(createBackupBundle({ storage, config }), /ENOENT|no such file/i);
  assert.equal((await listBackupBundles(config)).length, 0);
});

test('a degraded bundle counts toward count retention like a valid one', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-degraded-retention-');
  await seedVaultDocument(storage, config);
  const first = await createBackupBundle({ storage, config, now: new Date('2026-07-13T12:00:00.000Z') });
  damageBundledDocument(first);
  const second = await createBackupBundle({ storage, config, now: new Date('2026-07-14T12:00:00.000Z') });
  assert.equal((await verifyBackupBundle(first.path)).classification, 'degraded');
  assert.equal(fs.existsSync(first.path), true, 'two bundles fit within retentionCount 2');
  const third = await createBackupBundle({ storage, config, now: new Date('2026-07-15T12:00:00.000Z') });

  assert.equal(fs.existsSync(first.path), false, 'the oldest bundle is pruned by count even though it is degraded');
  assert.equal(fs.existsSync(second.path), true);
  assert.equal(fs.existsSync(third.path), true);
});

test('a tampered database is still invalid and is pruned after 24 hours', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-tampered-prune-');
  const backup = await createBackupBundle({ storage, config });
  fs.appendFileSync(backupDatabasePath(backup), 'tampered');
  const stale = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(backup.path, stale, stale);
  assert.equal((await verifyBackupBundle(backup.path)).classification, 'invalid');
  assert.ok((await enforceBackupRetention(config, new Date())).includes(backup.path));
});

test('an accepted degraded restore skips an unreadable bundled document and reports it', async (t) => {
  const { root, config, storage } = backupSetup(t, 'ug-backup-degraded-unreadable-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  fs.rmSync(bundledDocumentPath(backup));

  const databasePath = path.join(root, 'restore', 'database.sqlite');
  const documentsDirectory = path.join(root, 'restore', 'documents');
  await assert.rejects(restoreBackupBundle(backup.path, { databasePath, documentsDirectory }), /Backup verification failed/);
  const restored = await restoreBackupBundle(backup.path, { databasePath, documentsDirectory, acceptDegradedDocuments: true });
  assert.deepEqual(restored.degradedDocuments, [{ id: 'document-1', reason: 'unreadable' }]);
  assert.equal(restored.restoredDocuments, 0, 'only documents actually installed are counted');
  const restoredDatabase = new Database(databasePath, { readonly: true });
  try {
    const row = restoredDatabase.prepare('SELECT storage_path FROM secure_documents WHERE id = ?').get('document-1');
    assert.ok(row.storage_path.startsWith(documentsDirectory));
    assert.equal(fs.existsSync(row.storage_path), false);
  } finally {
    restoredDatabase.close();
  }
});

test('a legacy bundle with a verified database but damaged documents stays legacy and survives retention', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-legacy-damaged-docs-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  const manifestPath = path.join(backup.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: 1 }));
  damageBundledDocument(backup);
  const stale = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(backup.path, stale, stale);

  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.classification, 'legacy');
  assert.equal(result.databaseVerified, true);
  assert.deepEqual(result.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  const removed = await enforceBackupRetention(config, new Date(Date.now() + 48 * 3600_000));
  assert.equal(removed.includes(backup.path), false);
  assert.equal(fs.existsSync(backup.path), true);
  assert.equal((await listBackupBundles(config))[0].state, 'legacy');
});

test('backup bundles hardlink vault documents instead of copying them', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-hardlink-');
  const sourceDocument = await seedVaultDocument(storage, config);
  const first = await createBackupBundle({ storage, config, now: new Date('2026-07-13T12:00:00.000Z') });
  const second = await createBackupBundle({ storage, config, now: new Date('2026-07-14T12:00:00.000Z') });
  const vault = fs.statSync(sourceDocument);
  for (const backup of [first, second]) {
    assert.equal(fs.statSync(bundledDocumentPath(backup)).ino, vault.ino);
  }
  assert.equal(fs.statSync(sourceDocument).nlink, 3);
  assert.equal(fs.statSync(sourceDocument).mode & 0o777, 0o600);
});

test('pruning a linked bundle keeps the vault document', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-hardlink-prune-');
  const sourceDocument = await seedVaultDocument(storage, config);
  const first = await createBackupBundle({ storage, config, now: new Date('2026-07-13T12:00:00.000Z') });
  await createBackupBundle({ storage, config, now: new Date('2026-07-14T12:00:00.000Z') });
  await createBackupBundle({ storage, config, now: new Date('2026-07-15T12:00:00.000Z') });
  assert.equal(fs.existsSync(first.path), false, 'retentionCount 2 prunes the oldest bundle');
  assert.equal(fs.readFileSync(sourceDocument, 'utf8'), documentContent);
  assert.equal(fs.statSync(sourceDocument).nlink, 3);
});

test('restore from a linked bundle installs independent copies', async (t) => {
  const { root, config, storage } = backupSetup(t, 'ug-backup-hardlink-restore-');
  const sourceDocument = await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  const databasePath = path.join(root, 'restore', 'database.sqlite');
  const documentsDirectory = path.join(root, 'restore', 'documents');
  const restore = await restoreBackupBundle(backup.path, { databasePath, documentsDirectory });
  assert.equal(restore.restoredDocuments, 1);
  const restoredDatabase = new Database(databasePath, { readonly: true });
  let restoredFile;
  try {
    restoredFile = restoredDatabase.prepare('SELECT storage_path FROM secure_documents WHERE id = ?').get('document-1').storage_path;
  } finally {
    restoredDatabase.close();
  }
  assert.notEqual(fs.statSync(restoredFile).ino, fs.statSync(sourceDocument).ino);
  assert.equal(fs.readFileSync(restoredFile, 'utf8'), documentContent);
});

for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']) {
  test(`any link error falls back to a copy (${code})`, async (t) => {
    const { config, storage } = backupSetup(t, `ug-backup-link-${code.toLowerCase()}-`);
    const sourceDocument = await seedVaultDocument(storage, config);
    const backup = await createBackupBundle({
      storage,
      config,
      fileOps: {
        link: async () => { throw Object.assign(new Error(code), { code }); },
        copyFile: fs.promises.copyFile,
      },
    });
    assert.notEqual(fs.statSync(bundledDocumentPath(backup)).ino, fs.statSync(sourceDocument).ino);
    assert.equal(fs.statSync(sourceDocument).nlink, 1);
    assert.equal((await verifyBackupBundle(backup.path)).ok, true);
  });
}

test('a link that fails after creating a partial file is cleaned up before the copy', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-link-partial-');
  const sourceDocument = await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({
    storage,
    config,
    fileOps: {
      link: async (_source, destination) => {
        fs.writeFileSync(destination, 'partial');
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      },
      copyFile: async (source, destination) => {
        assert.equal(fs.existsSync(destination), false, 'the partial destination is removed first');
        return fs.promises.copyFile(source, destination);
      },
    },
  });
  assert.notEqual(fs.statSync(bundledDocumentPath(backup)).ino, fs.statSync(sourceDocument).ino);
  assert.equal((await verifyBackupBundle(backup.path)).ok, true);
});

test('with hardlinks, a vault document damaged in place degrades every bundle, keeps them all, and a new backup still succeeds', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-hardlink-damage-');
  const sourceDocument = await seedVaultDocument(storage, config);
  const first = await createBackupBundle({ storage, config });
  const second = await createBackupBundle({ storage, config });
  fs.writeFileSync(sourceDocument, 'x'.repeat(Buffer.byteLength(documentContent)));

  for (const backup of [first, second]) {
    const result = await verifyBackupBundle(backup.path);
    assert.equal(result.classification, 'degraded');
    assert.deepEqual(result.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  }
  const removed = await enforceBackupRetention(config, new Date(Date.now() + 48 * 3600_000));
  assert.deepEqual(removed.filter((entry) => [first.path, second.path].includes(entry)), []);
  const third = await createBackupBundle({ storage, config });
  assert.equal((await verifyBackupBundle(third.path)).databaseVerified, true);
  assert.equal((await getBackupStatus(config)).status, 'degraded');
});

test('the degraded status message adds the other bundle problems and the staleness warning', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-degraded-message-');
  await seedVaultDocument(storage, config);
  const first = await createBackupBundle({ storage, config });
  const second = await createBackupBundle({ storage, config });
  damageBundledDocument(first);
  fs.appendFileSync(backupDatabasePath(second), 'tampered');

  const mixed = await getBackupStatus(config);
  assert.equal(mixed.status, 'degraded');
  assert.match(mixed.message, / Bundles needing attention: 1 with mismatched documents and 1 invalid\.$/);
  assert.doesNotMatch(mixed.message, /older than 36 hours/);
});

test('a degraded status still names a stopped backup scheduler', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-degraded-stale-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config, now: new Date(Date.now() - 48 * 3600_000) });
  damageBundledDocument(backup);
  const status = await getBackupStatus(config);
  assert.equal(status.status, 'degraded');
  assert.match(status.message, /\(id: document-1\)\..* The latest application backup is older than 36 hours\.$/);
});

function countingVerifier() {
  const verifier = async (bundlePath) => {
    verifier.calls.push(path.basename(bundlePath));
    return verifyBackupBundle(bundlePath);
  };
  verifier.calls = [];
  return verifier;
}

// Moves every file in the bundles an hour into the past, so their recorded verification is no
// longer inside the racy-timestamp window and can be trusted by later status reads.
function ageBundleFiles(backups, ageMs = 60 * 60 * 1000) {
  const past = new Date(Date.now() - ageMs);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else fs.utimesSync(entryPath, past, past);
    }
  };
  for (const backup of backups) visit(backup.path);
}

function verificationRecordNames(config) {
  const directory = path.join(config.backup.directory, '.verification-cache');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

test('status reads of N bundles reuse recorded verification instead of re-verifying every bundle', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-recorded-');
  config.backup.retentionCount = 10;
  await seedVaultDocument(storage, config);
  const bundleCount = 6;
  const backups = [];
  for (let index = 0; index < bundleCount; index += 1) {
    backups.push(await createBackupBundle({ storage, config, now: new Date(Date.now() - (bundleCount - index) * 60_000) }));
  }
  ageBundleFiles(backups);
  const bundleListing = backups.map((backup) => fs.readdirSync(backup.path).sort());

  const verifier = countingVerifier();
  const first = await getBackupStatus(config, { verifyBundle: verifier });
  assert.equal(first.status, 'healthy');
  assert.deepEqual(first.bundleCounts, { valid: bundleCount, degraded: 0, legacy: 0, invalid: 0, incomplete: 0 });
  assert.equal(verifier.calls.length, bundleCount, 'files changed since the creation-time records, so each bundle is verified once');
  // Newest first, so a long background pass reaches the latest bundle first.
  assert.deepEqual(verifier.calls, backups.map((backup) => path.basename(backup.path)).reverse());

  for (let read = 0; read < 3; read += 1) {
    const status = await getBackupStatus(config, { verifyBundle: verifier });
    assert.deepEqual(status, first);
  }
  assert.equal(verifier.calls.length, bundleCount, 'unchanged bundles are never re-verified on later reads');

  // Records live outside the bundles and leave the bundles' own files untouched.
  assert.deepEqual(verificationRecordNames(config), backups.map((backup) => `${path.basename(backup.path)}.json`).sort());
  assert.deepEqual(backups.map((backup) => fs.readdirSync(backup.path).sort()), bundleListing);

  // A bundle whose files change is verified again and reported honestly; the others stay recorded.
  const damaged = backups[2];
  damageBundledDocument(damaged);
  const afterDamage = await getBackupStatus(config, { verifyBundle: verifier });
  assert.deepEqual(verifier.calls.slice(bundleCount), [path.basename(damaged.path)]);
  assert.equal(afterDamage.status, 'degraded');
  assert.equal(afterDamage.bundleCounts.valid, bundleCount - 1);
  assert.equal(afterDamage.bundleCounts.degraded, 1);
  assert.deepEqual(afterDamage.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);

  // A tampered database snapshot changes its size and mtime, so it is caught as well.
  fs.appendFileSync(backupDatabasePath(backups[4]), 'tampered');
  const afterTamper = await getBackupStatus(config, { verifyBundle: verifier });
  assert.equal(afterTamper.bundleCounts.invalid, 1);
  assert.ok(verifier.calls.includes(path.basename(backups[4].path)));

  // Records for bundles that no longer exist are pruned.
  fs.rmSync(backups[0].path, { recursive: true, force: true });
  await getBackupStatus(config, { verifyBundle: verifier });
  assert.equal(verificationRecordNames(config).includes(`${path.basename(backups[0].path)}.json`), false);
});

test('a recorded result is not trusted while bundle files are inside the racy-timestamp window', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-racy-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  ageBundleFiles([backup]);
  const touchDatabase = () => {
    const justNow = new Date();
    fs.utimesSync(backupDatabasePath(backup), justNow, justNow);
  };

  const verifier = countingVerifier();
  touchDatabase();
  assert.equal((await getBackupStatus(config, { verifyBundle: verifier })).status, 'healthy');
  touchDatabase();
  assert.equal((await getBackupStatus(config, { verifyBundle: verifier })).status, 'healthy');
  assert.equal(verifier.calls.length, 2, 'a just-written database snapshot is verified on every read');
});

test('a file whose mtime is still in the future does not force re-verification on every read', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-future-mtime-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  ageBundleFiles([backup], -24 * 60 * 60 * 1000);

  const verifier = countingVerifier();
  for (let read = 0; read < 3; read += 1) {
    assert.equal((await getBackupStatus(config, { verifyBundle: verifier })).status, 'healthy');
  }
  assert.equal(verifier.calls.length, 1);
});

test('retention and the backup listing always fully verify, catching damage that kept size and mtime, and refresh the record', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-silent-damage-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  ageBundleFiles([backup]);
  assert.equal((await getBackupStatus(config)).status, 'healthy');

  // Same-size in-place write with the old timestamps restored: the fingerprint cannot see it.
  const bundled = bundledDocumentPath(backup);
  const { atime, mtime } = fs.statSync(bundled);
  fs.writeFileSync(bundled, 'y'.repeat(Buffer.byteLength(documentContent)));
  fs.utimesSync(bundled, atime, mtime);
  assert.equal((await getBackupStatus(config)).status, 'healthy', 'documented limitation of the status read');

  const [listed] = await listBackupBundles(config);
  assert.equal(listed.state, 'degraded');
  assert.equal((await getBackupStatus(config)).status, 'degraded', 'the full pass refreshed the record');

  fs.writeFileSync(bundled, documentContent);
  fs.utimesSync(bundled, atime, mtime);
  assert.equal((await getBackupStatus(config)).status, 'degraded');
  await enforceBackupRetention(config);
  assert.equal((await getBackupStatus(config)).status, 'healthy', 'the retention pass also refreshes the record');
});

test('a bundle removed while it is being verified is neither reported nor recorded, and its directory is not recreated', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-removed-mid-verify-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  ageBundleFiles([backup]);
  fs.rmSync(path.join(config.backup.directory, '.verification-cache'), { recursive: true, force: true });

  const status = await getBackupStatus(config, {
    verificationBudgetMs: Infinity,
    verifyBundle: async (bundlePath) => {
      fs.rmSync(config.backup.directory, { recursive: true, force: true });
      return verifyBackupBundle(bundlePath);
    },
  });
  assert.equal(status.status, 'missing');
  assert.deepEqual(status.bundleCounts, { valid: 0, degraded: 0, legacy: 0, invalid: 0, incomplete: 0 });
  assert.equal(fs.existsSync(config.backup.directory), false);
});

test('bundles still verifying when the status budget runs out are reported as verifying and finish in the background', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-verifying-');
  await seedVaultDocument(storage, config);
  const backup = await createBackupBundle({ storage, config });
  ageBundleFiles([backup]);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const calls = [];
  const slowVerifier = async (bundlePath) => {
    calls.push(bundlePath);
    await gate;
    return verifyBackupBundle(bundlePath);
  };

  const [first, concurrent] = await Promise.all([
    getBackupStatus(config, { verifyBundle: slowVerifier, verificationBudgetMs: 20 }),
    getBackupStatus(config, { verifyBundle: slowVerifier, verificationBudgetMs: 20 }),
  ]);
  for (const status of [first, concurrent]) {
    assert.equal(status.status, 'verifying');
    assert.equal(status.latest, null);
    assert.deepEqual(status.bundleCounts, { valid: 0, degraded: 0, legacy: 0, invalid: 0, incomplete: 0, verifying: 1 });
    assert.match(status.message, /^Backup verification is still running for 1 bundle; refresh in a few minutes\.$/);
  }
  assert.equal(calls.length, 1, 'concurrent reads share one background verification');

  release();
  const verifier = countingVerifier();
  const settled = await getBackupStatus(config, { verifyBundle: verifier });
  assert.equal(settled.status, 'healthy');
  assert.deepEqual(settled.bundleCounts, { valid: 1, degraded: 0, legacy: 0, invalid: 0, incomplete: 0 });
  assert.equal(calls.length, 1);
  assert.equal((await getBackupStatus(config, { verifyBundle: verifier })).status, 'healthy');
  assert.equal(verifier.calls.length, 0, 'the background verification was recorded and reused');
});

test('a verified backup stays the latest while an older bundle is still verifying, and the message says so', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-verifying-partial-');
  await seedVaultDocument(storage, config);
  const older = await createBackupBundle({ storage, config, now: new Date(Date.now() - 60_000) });
  const newer = await createBackupBundle({ storage, config });
  ageBundleFiles([older, newer]);
  await getBackupStatus(config);
  damageBundledDocument(older);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const status = await getBackupStatus(config, {
    verificationBudgetMs: 20,
    verifyBundle: async (bundlePath) => { await gate; return verifyBackupBundle(bundlePath); },
  });
  assert.equal(status.status, 'healthy');
  assert.equal(status.latest.createdAt, newer.manifest.createdAt);
  assert.deepEqual(status.bundleCounts, { valid: 1, degraded: 0, legacy: 0, invalid: 0, incomplete: 0, verifying: 1 });
  assert.match(status.message, /within the expected daily window\. 1 backup bundle is still being verified; refresh in a few minutes\.$/);
  release();
  // Join the background verification so it cannot outlive this test.
  assert.equal((await getBackupStatus(config, { verificationBudgetMs: Infinity })).status, 'degraded');
});

test('the backup scheduler warms verification records in the background at startup', async (t) => {
  const { config, storage } = backupSetup(t, 'ug-backup-warm-');
  const warmed = [];
  const timers = [];
  const scheduler = startBackupScheduler({
    storage,
    config,
    getNow: () => new Date('2026-11-06T09:00:00.000Z'),
    scheduleTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return { unref() {} };
    },
    warmBackupVerification: async (warmConfig) => { warmed.push(warmConfig); },
  });
  t.after(() => scheduler.stop());
  assert.deepEqual(warmed, [], 'the warm-up waits until startup has settled');
  const warmUp = timers.find(({ delayMs }) => delayMs === 60_000);
  assert.ok(warmUp);
  warmUp.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warmed, [config]);
});
