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
  assert.deepEqual(status.bundleCounts, { valid: 0, legacy: 0, invalid: 1, incomplete: 0 });
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
  assert.deepEqual(status.bundleCounts, { valid: 0, legacy: 1, invalid: 0, incomplete: 0 });
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
  assert.deepEqual(status.bundleCounts, { valid: 1, legacy: 0, invalid: 1, incomplete: 2 });
  assert.match(status.message, /1 invalid and 2 incomplete/i);
});
