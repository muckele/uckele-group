import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { resolveSecureStoragePath } from './documentVault.js';

const manifestFileName = 'manifest.json';
const databaseFileName = 'database.sqlite';
const activeMarkerFileName = '.active.json';
const legacyBackupVersion = 1;
const backupVersion = 2;
const supportedBackupVersions = new Set([legacyBackupVersion, backupVersion]);
const backupJobName = 'sqlite-application-backup';
const abandonedBundleGraceMs = 24 * 60 * 60 * 1000;
const sqliteSidecarSuffixes = ['-wal', '-shm', '-journal'];
const activeBackupPaths = new Set();

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validateBackupManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['Backup manifest must be a JSON object.'];

  if (!supportedBackupVersions.has(manifest.version)) errors.push(`Unsupported manifest version ${manifest.version}.`);
  if (!isNonEmptyString(manifest.id)) errors.push('Backup manifest id is required.');
  if (!isValidDate(manifest.createdAt)) errors.push('Backup manifest createdAt must be a valid timestamp.');
  if (manifest.provider !== 'sqlite') errors.push('Backup manifest provider must be sqlite.');

  if (!isObject(manifest.database)) {
    errors.push('Backup manifest database section is required.');
  } else {
    if (!isNonEmptyString(manifest.database.relativePath)) errors.push('Database relativePath is required.');
    if (!isNonNegativeInteger(manifest.database.sizeBytes)) errors.push('Database sizeBytes must be a non-negative integer.');
    if (!isSha256(manifest.database.sha256)) errors.push('Database sha256 must be a SHA-256 checksum.');
  }

  if (!isObject(manifest.secureDocuments)) {
    errors.push('Backup manifest secureDocuments section is required.');
  } else {
    if (!isNonNegativeInteger(manifest.secureDocuments.count)) errors.push('Secure-document count must be a non-negative integer.');
    if (!isNonNegativeInteger(manifest.secureDocuments.totalBytes)) errors.push('Secure-document totalBytes must be a non-negative integer.');
    if (!Array.isArray(manifest.secureDocuments.files)) {
      errors.push('Secure-document files must be an array.');
    } else {
      const documentIds = new Set();
      const relativePaths = new Set();
      let totalBytes = 0;
      for (const [index, document] of manifest.secureDocuments.files.entries()) {
        const label = `Secure document at index ${index}`;
        if (!isObject(document)) {
          errors.push(`${label} must be an object.`);
          continue;
        }
        if (!isNonEmptyString(document.id)) errors.push(`${label} id is required.`);
        if (!isNonEmptyString(document.requestId)) errors.push(`${label} requestId is required.`);
        if (!(document.submissionId === null || isNonEmptyString(document.submissionId))) errors.push(`${label} submissionId must be a string or null.`);
        if (!isNonEmptyString(document.originalName)) errors.push(`${label} originalName is required.`);
        if (!isNonEmptyString(document.category)) errors.push(`${label} category is required.`);
        if (!isNonEmptyString(document.mimeType)) errors.push(`${label} mimeType is required.`);
        if (!isNonNegativeInteger(document.sizeBytes)) errors.push(`${label} sizeBytes must be a non-negative integer.`);
        if (!isValidDate(document.createdAt)) errors.push(`${label} createdAt must be a valid timestamp.`);
        if (!isNonEmptyString(document.relativePath)) errors.push(`${label} relativePath is required.`);
        if (!isSha256(document.sha256)) errors.push(`${label} sha256 must be a SHA-256 checksum.`);
        if (isNonEmptyString(document.id) && documentIds.has(document.id)) errors.push(`Secure document id ${document.id} is duplicated.`);
        if (isNonEmptyString(document.relativePath) && relativePaths.has(document.relativePath)) errors.push(`Secure document path ${document.relativePath} is duplicated.`);
        if (isNonEmptyString(document.id)) documentIds.add(document.id);
        if (isNonEmptyString(document.relativePath)) relativePaths.add(document.relativePath);
        if (isNonNegativeInteger(document.sizeBytes)) totalBytes += document.sizeBytes;
      }
      if (isNonNegativeInteger(manifest.secureDocuments.count) && manifest.secureDocuments.files.length !== manifest.secureDocuments.count) {
        errors.push('Secure-document file count does not match the manifest count.');
      }
      if (isNonNegativeInteger(manifest.secureDocuments.totalBytes) && totalBytes !== manifest.secureDocuments.totalBytes) {
        errors.push('Secure-document total size does not match the manifest.');
      }
    }
  }

  if (!isObject(manifest.retention)
      || !Number.isInteger(manifest.retention.days) || manifest.retention.days < 1
      || !Number.isInteger(manifest.retention.count) || manifest.retention.count < 1) {
    errors.push('Backup manifest retention must include positive integer days and count values.');
  }
  if (!isObject(manifest.verification)
      || !isValidDate(manifest.verification.verifiedAt)
      || manifest.verification.databaseCheck !== 'quick_check'
      || manifest.verification.checksum !== 'sha256') {
    errors.push('Backup manifest verification metadata is invalid.');
  }

  return errors;
}

function safeSegment(value, fallback = 'item') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function secureWriteJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function loadManifest(bundlePath) {
  return JSON.parse(await fs.readFile(path.join(bundlePath, manifestFileName), 'utf8'));
}

async function isActiveBackupPath(bundlePath) {
  if (activeBackupPaths.has(path.resolve(bundlePath))) return true;
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(bundlePath, activeMarkerFileName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    return true;
  }
  if (!Number.isInteger(marker?.pid) || marker.pid < 1) return false;
  try {
    process.kill(marker.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function openBackupDatabase(databasePath, options = {}) {
  return new Database(databasePath, { readonly: options.readonly !== false, fileMustExist: true });
}

function sqliteFileIdentityMatches(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .every((field) => before[field] === after[field]);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function existingSqliteSidecars(databasePath) {
  const present = [];
  for (const suffix of sqliteSidecarSuffixes) {
    try {
      await fs.lstat(`${databasePath}${suffix}`);
      present.push(suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return present;
}

function assertNoSqliteSidecars(sidecars) {
  if (sidecars.length > 0) {
    throw new Error(`Database snapshot has unverified SQLite sidecars: ${sidecars.join(', ')}.`);
  }
}

function sqliteHeaderVersions(snapshotBytes) {
  if (snapshotBytes.length < 20 || snapshotBytes.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
    throw new Error('Database snapshot is not a SQLite 3 database.');
  }
  const writeVersion = snapshotBytes[18];
  const readVersion = snapshotBytes[19];
  if (!((writeVersion === 1 && readVersion === 1) || (writeVersion === 2 && readVersion === 2))) {
    throw new Error(`Database snapshot has invalid SQLite journal header bytes ${writeVersion}/${readVersion}.`);
  }
  return { writeVersion, readVersion };
}

async function readStableSqliteSnapshot(databasePath, {
  expectedSizeBytes = null,
  expectedSha256 = '',
  allowLegacySidecars = false,
} = {}) {
  const sidecarsBefore = await existingSqliteSidecars(databasePath);
  if (!allowLegacySidecars) assertNoSqliteSidecars(sidecarsBefore);
  const before = await fs.lstat(databasePath, { bigint: true });
  if (!before.isFile()) throw new Error('Database snapshot is not a regular file.');
  if (expectedSizeBytes !== null && before.size !== BigInt(expectedSizeBytes)) {
    throw new Error('Database snapshot size does not match the manifest.');
  }

  const snapshotBytes = await fs.readFile(databasePath);
  const [after, sidecarsAfter] = await Promise.all([
    fs.lstat(databasePath, { bigint: true }),
    existingSqliteSidecars(databasePath),
  ]);
  if (!allowLegacySidecars) assertNoSqliteSidecars(sidecarsAfter);
  if (sidecarsBefore.join('\u0000') !== sidecarsAfter.join('\u0000')) {
    throw new Error('Database snapshot sidecars changed while loading immutable verification bytes.');
  }
  if (!sqliteFileIdentityMatches(before, after) || snapshotBytes.length !== Number(after.size)) {
    throw new Error('Database snapshot changed while loading immutable verification bytes.');
  }
  const snapshotSha256 = sha256Bytes(snapshotBytes);
  if (expectedSha256 && snapshotSha256 !== expectedSha256) {
    throw new Error('Database snapshot checksum does not match the manifest.');
  }
  const header = sqliteHeaderVersions(snapshotBytes);
  return {
    bytes: snapshotBytes,
    sha256: snapshotSha256,
    sizeBytes: snapshotBytes.length,
    sidecars: sidecarsAfter,
    ...header,
  };
}

function openQueryOnlySnapshotDatabase(snapshotBytes, { allowLegacyWalHeader = false } = {}) {
  const { writeVersion, readVersion } = sqliteHeaderVersions(snapshotBytes);
  if (writeVersion !== 1 || readVersion !== 1) {
    if (!allowLegacyWalHeader) {
      throw new Error(`Current-format database snapshot must persist SQLite rollback header bytes 1/1; found ${writeVersion}/${readVersion}.`);
    }
  }

  const inspectionBytes = Buffer.from(snapshotBytes);
  if (writeVersion === 2 && readVersion === 2) {
    inspectionBytes[18] = 1;
    inspectionBytes[19] = 1;
  }
  const database = new Database(inspectionBytes);
  try {
    database.pragma('query_only = ON');
    if (Number(database.pragma('query_only', { simple: true })) !== 1) {
      throw new Error('Database snapshot could not be restricted to query-only inspection.');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openImmutableBackupDatabase(databasePath, {
  expectedSizeBytes = null,
  expectedSha256 = '',
  allowLegacyWalHeader = false,
  allowLegacySidecars = false,
} = {}) {
  const snapshot = await readStableSqliteSnapshot(databasePath, {
    expectedSizeBytes,
    expectedSha256,
    allowLegacySidecars,
  });
  const database = openQueryOnlySnapshotDatabase(snapshot.bytes, { allowLegacyWalHeader });
  return { database, snapshot };
}

function assertSnapshotQuickCheck(database) {
  const integrity = String(database.pragma('quick_check', { simple: true }) || '');
  if (integrity !== 'ok') throw new Error(`SQLite integrity verification failed: ${integrity}`);
}

async function secureAtomicReplace(filePath, bytes) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function normalizeCreatedBackupDatabase(databasePath) {
  const created = await readStableSqliteSnapshot(databasePath);
  const normalizedBytes = Buffer.from(created.bytes);
  if (created.writeVersion === 2 && created.readVersion === 2) {
    normalizedBytes[18] = 1;
    normalizedBytes[19] = 1;
  }

  const normalizedDatabase = openQueryOnlySnapshotDatabase(normalizedBytes);
  try {
    assertSnapshotQuickCheck(normalizedDatabase);
  } finally {
    normalizedDatabase.close();
  }

  if (created.writeVersion !== 1 || created.readVersion !== 1) {
    await secureAtomicReplace(databasePath, normalizedBytes);
  }
  const persisted = await readStableSqliteSnapshot(databasePath, {
    expectedSizeBytes: normalizedBytes.length,
    expectedSha256: sha256Bytes(normalizedBytes),
  });
  if (persisted.writeVersion !== 1 || persisted.readVersion !== 1) {
    throw new Error('Normalized database snapshot did not persist SQLite rollback header bytes 1/1.');
  }
  return persisted;
}

async function readSecureDocumentRows(databasePath) {
  const { database } = await openImmutableBackupDatabase(databasePath);
  try {
    return readSecureDocumentRowsFromDatabase(database);
  } finally {
    database.close();
  }
}

function readSecureDocumentRowsFromDatabase(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secure_documents'").get();
  if (!table) return [];
  return database.prepare(`
    SELECT id, request_id, submission_id, original_name, document_type, mime_type,
           size_bytes, storage_path, created_at
    FROM secure_documents
    ORDER BY created_at ASC, id ASC
  `).all();
}

function compareManifestDocumentsToDatabase(manifestDocuments, databaseRows) {
  const errors = [];
  const rowsById = new Map(databaseRows.map((row) => [String(row.id), row]));

  for (const document of manifestDocuments) {
    const row = rowsById.get(String(document.id));
    if (!row) {
      errors.push(`Secure document ${document.id} does not exist in the database snapshot.`);
      continue;
    }

    const comparisons = [
      ['requestId', document.requestId, row.request_id],
      ['submissionId', document.submissionId ?? null, row.submission_id ?? null],
      ['originalName', document.originalName, row.original_name],
      ['category', document.category, row.document_type],
      ['mimeType', document.mimeType, row.mime_type],
      ['sizeBytes', Number(document.sizeBytes), Number(row.size_bytes)],
      ['createdAt', document.createdAt, row.created_at],
    ];

    for (const [field, manifestValue, databaseValue] of comparisons) {
      if (manifestValue !== databaseValue) {
        errors.push(`Secure document ${document.id} ${field} does not match the database snapshot.`);
      }
    }
  }

  return errors;
}

async function copySecureDocuments({ databasePath, documentsDirectory, destination }) {
  const rows = await readSecureDocumentRows(databasePath);
  const manifestDocuments = [];

  for (const row of rows) {
    const sourcePath = resolveSecureStoragePath(row.storage_path, documentsDirectory);
    if (!sourcePath) throw new Error(`Secure document ${row.id} has a path outside the configured vault.`);

    const relativePath = path.join(
      'documents',
      safeSegment(row.request_id, 'request'),
      `${safeSegment(row.id, 'document')}-${safeSegment(row.original_name, 'document')}`,
    );
    const copiedPath = path.join(destination, relativePath);
    await fs.mkdir(path.dirname(copiedPath), { recursive: true, mode: 0o700 });
    const before = await fs.stat(sourcePath);
    await fs.copyFile(sourcePath, copiedPath);
    await fs.chmod(copiedPath, 0o600);
    const after = await fs.stat(sourcePath);
    const copied = await fs.stat(copiedPath);

    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copied.size !== Number(row.size_bytes)) {
      throw new Error(`Secure document ${row.id} changed while the backup was being created.`);
    }

    manifestDocuments.push({
      id: row.id,
      requestId: row.request_id,
      submissionId: row.submission_id,
      originalName: row.original_name,
      category: row.document_type,
      mimeType: row.mime_type,
      sizeBytes: copied.size,
      createdAt: row.created_at,
      relativePath,
      sha256: await sha256File(copiedPath),
    });
  }

  return manifestDocuments;
}

async function inspectBackupDirectory(config) {
  let entries;
  try {
    entries = await fs.readdir(config.backup.directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const bundles = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue;
    const bundlePath = path.join(config.backup.directory, entry.name);
    let modifiedAt = 0;
    try {
      modifiedAt = (await fs.stat(bundlePath)).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entry.name.endsWith('.incomplete')) {
      bundles.push({ path: bundlePath, manifest: null, state: 'incomplete', errors: [], createdAt: modifiedAt, modifiedAt });
      continue;
    }

    const verification = await verifyBackupBundle(bundlePath);
    bundles.push({
      path: bundlePath,
      manifest: verification.manifest,
      state: verification.classification === 'legacy'
        ? 'legacy'
        : verification.ok ? 'valid' : 'invalid',
      errors: verification.errors,
      createdAt: Date.parse(verification.manifest?.createdAt || '') || modifiedAt,
      modifiedAt,
    });
  }
  return bundles.sort((left, right) => right.createdAt - left.createdAt || right.modifiedAt - left.modifiedAt);
}

export async function enforceBackupRetention(config = getConfig(), now = new Date()) {
  const root = config.backup.directory;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const inspected = await inspectBackupDirectory(config);
  const bundles = inspected.filter((bundle) => bundle.state === 'valid');
  const abandonedCutoff = now.getTime() - abandonedBundleGraceMs;
  const removed = [];

  for (const bundle of inspected) {
    if (!['incomplete', 'invalid'].includes(bundle.state)) continue;
    if (bundle.modifiedAt >= abandonedCutoff) continue;
    if (await isActiveBackupPath(bundle.path)) continue;
    await fs.rm(bundle.path, { recursive: true, force: true });
    removed.push(bundle.path);
  }

  const cutoff = now.getTime() - config.backup.retentionDays * 24 * 60 * 60 * 1000;
  for (const [index, bundle] of bundles.entries()) {
    if (index >= config.backup.retentionCount || bundle.createdAt < cutoff) {
      await fs.rm(bundle.path, { recursive: true, force: true });
      removed.push(bundle.path);
    }
  }
  return removed;
}

export async function createBackupBundle({ storage = getStorage(), config = getConfig(), now = new Date() } = {}) {
  if (storage.provider !== 'sqlite' || !storage.createApplicationBackup) {
    throw new Error('Application-consistent backup bundles require SQLite storage.');
  }

  await fs.mkdir(config.backup.directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const finalPath = path.join(config.backup.directory, `backup-${backupStamp(now)}-${id.slice(0, 8)}`);
  const workingPath = `${finalPath}.incomplete`;
  await fs.mkdir(workingPath, { recursive: true, mode: 0o700 });
  activeBackupPaths.add(path.resolve(workingPath));

  try {
    await secureWriteJson(path.join(workingPath, activeMarkerFileName), { pid: process.pid, startedAt: new Date().toISOString() });
    const databasePath = path.join(workingPath, databaseFileName);
    await storage.createApplicationBackup(databasePath);
    await fs.chmod(databasePath, 0o600);
    const persistedDatabase = await normalizeCreatedBackupDatabase(databasePath);
    const documents = await copySecureDocuments({
      databasePath,
      documentsDirectory: config.secureDocuments.storageDir,
      destination: workingPath,
    });
    const manifest = {
      version: backupVersion,
      id,
      createdAt: now.toISOString(),
      provider: 'sqlite',
      database: {
        relativePath: databaseFileName,
        sizeBytes: persistedDatabase.sizeBytes,
        sha256: persistedDatabase.sha256,
      },
      secureDocuments: {
        count: documents.length,
        totalBytes: documents.reduce((sum, document) => sum + document.sizeBytes, 0),
        files: documents,
      },
      retention: {
        days: config.backup.retentionDays,
        count: config.backup.retentionCount,
      },
      verification: {
        verifiedAt: now.toISOString(),
        databaseCheck: 'quick_check',
        checksum: 'sha256',
      },
    };
    await secureWriteJson(path.join(workingPath, manifestFileName), manifest);
    const verification = await verifyBackupBundle(workingPath);
    if (!verification.ok) {
      throw new Error(`Backup integrity verification failed: ${verification.errors.join(' ')}`);
    }
    await fs.rm(path.join(workingPath, activeMarkerFileName), { force: true });
    await fs.rename(workingPath, finalPath);
    await enforceBackupRetention(config, now);
    return { path: finalPath, manifest };
  } catch (error) {
    await fs.rm(workingPath, { recursive: true, force: true });
    throw error;
  } finally {
    activeBackupPaths.delete(path.resolve(workingPath));
  }
}

export async function verifyBackupBundle(bundlePath) {
  const resolvedBundle = path.resolve(String(bundlePath || ''));
  let manifest = null;
  try {
    manifest = await loadManifest(resolvedBundle);
  } catch (error) {
    return {
      ok: false,
      current: false,
      legacy: false,
      classification: 'invalid',
      errors: [`Backup manifest could not be loaded: ${error.message}`],
      manifest: null,
      path: resolvedBundle,
    };
  }
  const errors = validateBackupManifest(manifest);
  if (errors.length > 0) {
    return {
      ok: false,
      current: false,
      legacy: false,
      classification: 'invalid',
      errors,
      manifest,
      path: resolvedBundle,
    };
  }
  const isLegacy = manifest.version === legacyBackupVersion;
  const legacyReasons = [];

  const databasePath = path.resolve(resolvedBundle, manifest.database.relativePath);
  if (!databasePath.startsWith(`${resolvedBundle}${path.sep}`)) {
    errors.push('Database snapshot resolves outside the backup bundle.');
  } else {
    try {
      const { database, snapshot } = await openImmutableBackupDatabase(databasePath, {
        expectedSizeBytes: manifest.database.sizeBytes,
        expectedSha256: manifest.database.sha256,
        allowLegacyWalHeader: isLegacy,
        allowLegacySidecars: isLegacy,
      });
      try {
        assertSnapshotQuickCheck(database);
        const documentRows = readSecureDocumentRowsFromDatabase(database);
        if (documentRows.length !== manifest.secureDocuments.count) errors.push('Secure-document row count does not match the manifest.');
        errors.push(...compareManifestDocumentsToDatabase(manifest.secureDocuments.files, documentRows));
      } finally {
        database.close();
      }
      if (isLegacy && snapshot.sidecars.length > 0) {
        legacyReasons.push(`Legacy backup contains unverified SQLite sidecars: ${snapshot.sidecars.join(', ')}.`);
      }
    } catch (error) {
      errors.push(`Database snapshot could not be verified: ${error.message}`);
    }
  }

  for (const document of manifest.secureDocuments.files) {
    const filePath = path.resolve(resolvedBundle, document.relativePath);
    if (!filePath.startsWith(`${resolvedBundle}${path.sep}`)) {
      errors.push(`Document ${document.id} resolves outside the backup bundle.`);
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.size !== document.sizeBytes) errors.push(`Document ${document.id} size does not match.`);
      if (await sha256File(filePath) !== document.sha256) errors.push(`Document ${document.id} checksum does not match.`);
    } catch (error) {
      errors.push(`Document ${document.id} could not be verified: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      current: false,
      legacy: false,
      classification: 'invalid',
      errors,
      manifest,
      path: resolvedBundle,
    };
  }
  if (isLegacy) {
    return {
      ok: false,
      current: false,
      legacy: true,
      classification: 'legacy',
      errors: [
        'Manifest version 1 is a legacy pre-invariant backup and is not eligible for current restore or repair evidence.',
        ...legacyReasons,
      ],
      manifest,
      path: resolvedBundle,
    };
  }
  return {
    ok: true,
    current: true,
    legacy: false,
    classification: 'current',
    errors: [],
    manifest,
    path: resolvedBundle,
  };
}

export async function listBackupBundles(config = getConfig()) {
  return (await inspectBackupDirectory(config))
    .filter((bundle) => bundle.state !== 'incomplete')
    .map(({ path: bundlePath, manifest, state, errors, modifiedAt }) => ({
      path: bundlePath,
      manifest,
      state,
      errors,
      modifiedAt: new Date(modifiedAt).toISOString(),
    }));
}

export async function getBackupStatus(config = getConfig()) {
  const inspected = await inspectBackupDirectory(config);
  const valid = inspected.filter((bundle) => bundle.state === 'valid');
  const legacy = inspected.filter((bundle) => bundle.state === 'legacy');
  const invalid = inspected.filter((bundle) => bundle.state === 'invalid');
  const incomplete = inspected.filter((bundle) => bundle.state === 'incomplete');
  const bundleCounts = {
    valid: valid.length,
    legacy: legacy.length,
    invalid: invalid.length,
    incomplete: incomplete.length,
  };
  if (!config.backup.enabled) {
    return { status: 'disabled', message: 'Automated application backups are disabled.', latest: null, bundleCounts };
  }

  const [latest] = valid;
  if (!latest?.manifest) {
    if (invalid.length > 0) {
      return {
        status: 'invalid',
        message: 'No valid application backup is available.',
        latest: null,
        bundleCounts,
        verificationErrors: invalid[0].errors,
      };
    }
    if (incomplete.length > 0) {
      return {
        status: 'incomplete',
        message: 'No successful application backup is available, and an incomplete backup bundle remains.',
        latest: null,
        bundleCounts,
      };
    }
    if (legacy.length > 0) {
      return {
        status: 'legacy',
        message: 'Historical pre-invariant backup bundles are preserved, but no current fully verified application backup is available.',
        latest: null,
        bundleCounts,
        verificationErrors: legacy.flatMap((bundle) => bundle.errors).slice(0, 20),
      };
    }
    return { status: 'missing', message: 'No successful application backup is recorded yet.', latest: null, bundleCounts };
  }
  const latestSummary = {
    createdAt: latest.manifest.createdAt,
    verifiedAt: latest.manifest.verification?.verifiedAt || '',
    documentCount: latest.manifest.secureDocuments?.count || 0,
    totalBytes: (latest.manifest.database?.sizeBytes || 0) + (latest.manifest.secureDocuments?.totalBytes || 0),
  };
  const ageMs = Date.now() - Date.parse(latest.manifest.createdAt || '');
  const stale = !Number.isFinite(ageMs) || ageMs > 36 * 60 * 60 * 1000;
  if (legacy.length > 0 || invalid.length > 0 || incomplete.length > 0) {
    const issueSummary = [
      legacy.length > 0 ? `${legacy.length} legacy` : '',
      invalid.length > 0 ? `${invalid.length} invalid` : '',
      incomplete.length > 0 ? `${incomplete.length} incomplete` : '',
    ].filter(Boolean).join(' and ');
    return {
      status: 'degraded',
      message: `A valid application backup is available, but ${issueSummary} backup bundle(s) require attention.`,
      latest: latestSummary,
      bundleCounts,
      verificationErrors: invalid.flatMap((bundle) => bundle.errors).slice(0, 20),
    };
  }
  return {
    status: stale ? 'stale' : 'healthy',
    message: stale ? 'The latest application backup is older than 36 hours.' : 'The latest application backup is within the expected daily window.',
    latest: latestSummary,
    bundleCounts,
  };
}

async function replaceDirectory(source, destination, overwrite) {
  let safetyPath = '';
  try {
    await fs.access(destination);
    if (!overwrite) throw new Error(`Restore destination already exists: ${destination}`);
    safetyPath = `${destination}.before-restore-${backupStamp()}`;
    await fs.rename(destination, safetyPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && !safetyPath) throw error;
  }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (safetyPath) await fs.rename(safetyPath, destination).catch(() => {});
    throw error;
  }
  return safetyPath;
}

export async function restoreBackupBundle(bundlePath, {
  databasePath,
  documentsDirectory,
  overwrite = false,
} = {}) {
  const verification = await verifyBackupBundle(bundlePath);
  if (!verification.ok) throw new Error(`Backup verification failed: ${verification.errors.join(' ')}`);

  const targetDatabase = path.resolve(databasePath);
  const targetDocuments = path.resolve(documentsDirectory);
  const stageRoot = `${targetDatabase}.restore-${randomUUID()}`;
  const stagedDatabase = path.join(stageRoot, databaseFileName);
  const stagedDocuments = path.join(stageRoot, 'secure-documents');
  let databaseSafetyPath = '';
  let documentsSafetyPath = '';
  try {
    await fs.mkdir(stagedDocuments, { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(verification.path, verification.manifest.database.relativePath), stagedDatabase);

    for (const document of verification.manifest.secureDocuments.files) {
      const destination = path.join(stagedDocuments, safeSegment(document.requestId), path.basename(document.relativePath));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(path.join(verification.path, document.relativePath), destination);
      await fs.chmod(destination, 0o600);
    }

    const restoredDatabase = openBackupDatabase(stagedDatabase, { readonly: false });
    try {
      const updatePath = restoredDatabase.prepare('UPDATE secure_documents SET storage_path = ? WHERE id = ?');
      const transaction = restoredDatabase.transaction(() => {
        for (const document of verification.manifest.secureDocuments.files) {
          const result = updatePath.run(
            path.join(targetDocuments, safeSegment(document.requestId), path.basename(document.relativePath)),
            document.id,
          );
          if (result.changes !== 1) {
            throw new Error(`Restore could not map secure document ${document.id} to exactly one database row.`);
          }
        }
      });
      transaction();
    } finally {
      restoredDatabase.close();
    }

    await fs.mkdir(path.dirname(targetDatabase), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(targetDocuments), { recursive: true, mode: 0o700 });
    try {
      await fs.access(targetDatabase);
      if (!overwrite) throw new Error(`Restore destination already exists: ${targetDatabase}`);
      databaseSafetyPath = `${targetDatabase}.before-restore-${backupStamp()}`;
      await fs.rename(targetDatabase, databaseSafetyPath);
    } catch (error) {
      if (error.code !== 'ENOENT' && !databaseSafetyPath) throw error;
    }

    let documentsInstalled = false;
    let databaseInstalled = false;
    try {
      documentsSafetyPath = await replaceDirectory(stagedDocuments, targetDocuments, overwrite);
      documentsInstalled = true;
      await fs.rename(stagedDatabase, targetDatabase);
      databaseInstalled = true;
      await fs.chmod(targetDatabase, 0o600);
    } catch (error) {
      if (databaseInstalled) await fs.rm(targetDatabase, { force: true }).catch(() => {});
      if (databaseSafetyPath) await fs.rename(databaseSafetyPath, targetDatabase).catch(() => {});
      if (documentsInstalled) await fs.rm(targetDocuments, { recursive: true, force: true }).catch(() => {});
      if (documentsSafetyPath) await fs.rename(documentsSafetyPath, targetDocuments).catch(() => {});
      throw error;
    }

    return {
      ok: true,
      databasePath: targetDatabase,
      documentsDirectory: targetDocuments,
      databaseSafetyPath,
      documentsSafetyPath,
      restoredDocuments: verification.manifest.secureDocuments.count,
    };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

function zonedDateAndMinutes(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + Number(parts.minute) };
}

export async function runClaimedBackup({ storage = getStorage(), config = getConfig(), now = new Date(), triggeredBy = 'scheduler' } = {}) {
  const { dateKey } = zonedDateAndMinutes(now, config.backup.timezone);
  const jobKey = `${backupJobName}:${dateKey}`;
  const claim = await storage.claimScheduledJob({
    jobKey,
    jobName: backupJobName,
    triggeredBy,
    nowIso: now.toISOString(),
    staleBefore: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    metadata: { dateKey },
  });
  if (!claim.claimed) return { alreadyRun: claim.run?.status === 'completed', inProgress: claim.run?.status === 'pending', jobRun: claim.run };
  try {
    const backup = await createBackupBundle({ storage, config, now });
    const jobRun = await storage.completeScheduledJob(jobKey, {
      status: 'completed',
      metadata: { dateKey, backupId: backup.manifest.id, documentCount: backup.manifest.secureDocuments.count },
    });
    return { backup, jobRun };
  } catch (error) {
    await storage.completeScheduledJob(jobKey, { status: 'failed', last_error: error.message, metadata: { dateKey } }).catch(() => {});
    throw error;
  }
}

export function startBackupScheduler({ storage = getStorage(), config = getConfig(), getNow = () => new Date(), scheduleTimer = setTimeout } = {}) {
  if (!config.backup.enabled || storage.provider !== 'sqlite') {
    console.log('[backup:scheduler] automated SQLite backups disabled');
    return { stop() {} };
  }
  let stopped = false;
  let timer = null;
  let inFlight = false;
  const [hour, minute] = config.backup.time.split(':').map(Number);

  async function tick() {
    if (stopped || inFlight) return;
    const now = getNow();
    const zoned = zonedDateAndMinutes(now, config.backup.timezone);
    if (zoned.minutes < (Number.isFinite(hour) ? hour : 3) * 60 + (Number.isFinite(minute) ? minute : 30)) return;
    inFlight = true;
    try {
      await runClaimedBackup({ storage, config, now });
    } catch (error) {
      console.error(`[backup:scheduler] backup failed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = scheduleTimer(async () => {
      await tick();
      schedule();
    }, config.backup.checkIntervalMs);
    timer.unref?.();
  }
  tick();
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
