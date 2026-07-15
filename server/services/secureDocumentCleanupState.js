import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';

export const secureDocumentCleanupSidecarName = '.reconciliation.json';
export const secureDocumentCleanupSettlementMs = 15 * 60 * 1000;
const temporarySidecarPattern = /^\.reconciliation-.+\.tmp$/;
const activeCleanupIntentIds = new Set();

export function registerSecureDocumentCleanupIntent(id) {
  activeCleanupIntentIds.add(String(id));
}

export function unregisterSecureDocumentCleanupIntent(id) {
  activeCleanupIntentIds.delete(String(id));
}

export function isSecureDocumentCleanupIntentActive(id) {
  return activeCleanupIntentIds.has(String(id));
}

function isStrictChild(candidate, parent) {
  return candidate.startsWith(`${parent}${path.sep}`);
}

async function syncDirectory(fileSystem, directory) {
  const directoryHandle = await fileSystem.open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function resolveTrashDirectory(directory, storageDir = getConfig().secureDocuments.storageDir) {
  const trashRoot = path.join(path.resolve(storageDir), '.trash');
  const resolvedDirectory = path.resolve(String(directory || ''));

  if (!resolvedDirectory.startsWith(`${trashRoot}${path.sep}`)) {
    throw new Error('Cleanup sidecar directory is outside the secure document trash directory.');
  }

  return resolvedDirectory;
}

function validateCleanupJob(job, storageDir) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('Cleanup sidecar must contain a job object.');
  }
  if (!String(job.id || '').trim() || !String(job.status || '').trim()) {
    throw new Error('Cleanup sidecar is missing its job identity or status.');
  }
  if (!Array.isArray(job.files) || !job.metadata || typeof job.metadata !== 'object' || Array.isArray(job.metadata)) {
    throw new Error('Cleanup sidecar has invalid files or metadata.');
  }

  const trashDirectory = resolveTrashDirectory(job.trash_directory, storageDir);
  if (path.basename(trashDirectory) !== String(job.id)) {
    throw new Error('Cleanup sidecar job identity does not match its operation directory.');
  }
  const storageRoot = path.resolve(storageDir);
  const trashRoot = path.join(storageRoot, '.trash');
  const files = job.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('Cleanup sidecar contains an invalid file entry.');
    }
    const originalPath = path.resolve(String(file.originalPath || ''));
    const stagedPath = path.resolve(String(file.stagedPath || ''));
    if (!isStrictChild(originalPath, storageRoot) || originalPath === trashRoot || isStrictChild(originalPath, trashRoot)) {
      throw new Error('Cleanup sidecar original path is outside the canonical secure document vault.');
    }
    if (path.dirname(stagedPath) !== trashDirectory) {
      throw new Error('Cleanup sidecar staged path is outside its operation directory.');
    }
    return { ...file, originalPath, stagedPath };
  });

  return { ...job, trash_directory: trashDirectory, files };
}

export async function writeSecureDocumentCleanupSidecar(job, {
  storageDir = getConfig().secureDocuments.storageDir,
  fileSystem = fs,
} = {}) {
  const normalizedJob = validateCleanupJob(job, storageDir);
  const directory = normalizedJob.trash_directory;
  const destination = path.join(directory, secureDocumentCleanupSidecarName);
  const temporaryPath = path.join(directory, `.reconciliation-${process.pid}-${randomUUID()}.tmp`);

  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(directory, 0o700);
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(normalizedJob, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, destination);
    await fileSystem.chmod(destination, 0o600);
    await syncDirectory(fileSystem, directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
  }

  return { job: normalizedJob, path: destination };
}

async function readCleanupSidecarCandidate(fileSystem, candidatePath, directory, storageDir) {
  const stat = await fileSystem.lstat(candidatePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Cleanup sidecar is not a regular file.');
  }
  const parsed = JSON.parse(await fileSystem.readFile(candidatePath, 'utf8'));
  const job = validateCleanupJob(parsed, storageDir);
  if (job.trash_directory !== directory) {
    throw new Error('Cleanup sidecar directory does not match its operation directory.');
  }
  return { job, stat };
}

async function recoverCleanupSidecarInDirectory(fileSystem, directory, storageDir) {
  const destination = path.join(directory, secureDocumentCleanupSidecarName);
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  const candidates = [];
  const hasDestination = entries.some((entry) => entry.name === secureDocumentCleanupSidecarName);
  const temporaryCandidates = entries
    .filter((entry) => entry.isFile() && temporarySidecarPattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  const candidatePaths = [...(hasDestination ? [destination] : []), ...temporaryCandidates];
  const candidateStats = await Promise.all(candidatePaths.map(async (candidatePath) => ({
    candidatePath,
    stat: await fileSystem.lstat(candidatePath),
  })));
  candidateStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  candidates.push(...candidateStats.map((candidate) => candidate.candidatePath));

  const errors = [];
  for (const candidatePath of candidates) {
    try {
      const { job } = await readCleanupSidecarCandidate(fileSystem, candidatePath, directory, storageDir);
      if (candidatePath !== destination) {
        await fileSystem.rename(candidatePath, destination);
        await fileSystem.chmod(destination, 0o600);
      }
      for (const temporaryPath of temporaryCandidates) {
        if (temporaryPath !== candidatePath) await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
      }
      await syncDirectory(fileSystem, directory);
      return { sidecar: { job, path: destination }, errors: [] };
    } catch (error) {
      errors.push({ path: candidatePath, error });
    }
  }

  return { sidecar: null, errors };
}

export async function listSecureDocumentCleanupSidecars({
  storageDir = getConfig().secureDocuments.storageDir,
  fileSystem = fs,
} = {}) {
  const trashRoot = path.join(path.resolve(storageDir), '.trash');
  let entries;

  try {
    entries = await fileSystem.readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { sidecars: [], errors: [] };
    return { sidecars: [], errors: [{ path: trashRoot, error }] };
  }

  const sidecars = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(trashRoot, entry.name);

    try {
      const recovered = await recoverCleanupSidecarInDirectory(fileSystem, directory, storageDir);
      if (recovered.sidecar) sidecars.push(recovered.sidecar);
      errors.push(...recovered.errors);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ path: directory, error });
    }
  }

  return { sidecars, errors };
}

export async function removeSecureDocumentCleanupSidecar(sidecarPath, {
  storageDir = getConfig().secureDocuments.storageDir,
  fileSystem = fs,
} = {}) {
  const trashRoot = path.join(path.resolve(storageDir), '.trash');
  const resolvedPath = path.resolve(String(sidecarPath || ''));

  if (!resolvedPath.startsWith(`${trashRoot}${path.sep}`) || path.basename(resolvedPath) !== secureDocumentCleanupSidecarName) {
    throw new Error('Cleanup sidecar path is outside the secure document trash directory.');
  }

  await fileSystem.rm(resolvedPath, { force: true });
  try {
    await syncDirectory(fileSystem, path.dirname(resolvedPath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function persistSecureDocumentCleanupJob(storage, job, options = {}) {
  let persistenceError = null;

  if (storage.insertSecureDocumentCleanupJob) {
    try {
      const persisted = await storage.insertSecureDocumentCleanupJob(job);
      if (persisted) return { job: persisted, sidecarPath: '' };
      persistenceError = new Error('Cleanup storage did not confirm the inserted job.');
    } catch (error) {
      persistenceError = error;
    }
  } else {
    persistenceError = new Error('Cleanup storage is unavailable.');
  }

  const sidecar = await writeSecureDocumentCleanupSidecar(job, options);
  console.error(
    `[secure-documents] cleanup job ${job.id} was retained in a local recovery sidecar: ${persistenceError.message}`,
  );
  return { job: sidecar.job, sidecarPath: sidecar.path, persistenceError };
}

function cleanupStateMatches(record, values) {
  return Boolean(record) && Object.entries(values).every(([key, value]) => (
    JSON.stringify(record[key] ?? null) === JSON.stringify(value ?? null)
  ));
}

export async function updateSecureDocumentCleanupJobState(storage, job, values, options = {}) {
  const nextJob = { ...job, ...values };
  let persistenceError = null;

  if (storage.updateSecureDocumentCleanupJob) {
    try {
      const updated = await storage.updateSecureDocumentCleanupJob(job.id, values);
      if (updated) return { job: updated, sidecarPath: '' };
      persistenceError = new Error('Cleanup storage did not find the job to update.');
    } catch (error) {
      persistenceError = error;
    }
  } else {
    persistenceError = new Error('Cleanup storage cannot update jobs.');
  }

  if (storage.getSecureDocumentCleanupJob) {
    try {
      const current = await storage.getSecureDocumentCleanupJob(job.id);
      if (cleanupStateMatches(current, values)) return { job: current, sidecarPath: '' };
    } catch (error) {
      persistenceError = error;
    }
  }

  const sidecar = await writeSecureDocumentCleanupSidecar(nextJob, options);
  console.error(
    `[secure-documents] cleanup job ${job.id} state was retained in a local recovery sidecar: ${persistenceError.message}`,
  );
  return { job: sidecar.job, sidecarPath: sidecar.path, persistenceError };
}
