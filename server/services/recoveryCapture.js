// Deliberately separate from scheduled backups: no retention and no live-source adapter.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const MiB = 1024 * 1024;
export const recoveryCaptureLimits = Object.freeze({
  maxDatabaseBytes: 154 * MiB,
  minimumFreeBytes: 850 * MiB,
  maxRssBytes: 256 * MiB,
  deadlineMs: 30_000,
});
// Shared by the source adapter so invalid bounds fail before opening SQLite.
export function getRecoveryCaptureLimits(overrides = {}) {
  const limits = { ...recoveryCaptureLimits, ...overrides };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(recoveryCaptureLimits, key) || !Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error('Invalid recovery limit.');
  }
  if (limits.minimumFreeBytes < recoveryCaptureLimits.minimumFreeBytes
      || limits.maxDatabaseBytes > recoveryCaptureLimits.maxDatabaseBytes
      || limits.maxRssBytes > recoveryCaptureLimits.maxRssBytes
      || limits.deadlineMs > recoveryCaptureLimits.deadlineMs) throw new Error('Recovery limit may only be tightened.');
  return limits;
}
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// The caller supplies an already-open trusted source. This helper never opens the
// live source, initializes application storage, changes its pragmas, or prunes data.
// Bounds are cooperative; an external process supervisor is required for hard
// wall/RSS enforcement of synchronous native SQLite operations.
export async function createZeroDocumentRecoveryBundle({ database, parentDirectory, signal, ...overrides }) {
  const limits = getRecoveryCaptureLimits(overrides);
  const started = performance.now();
  function checkBounds() {
    signal?.throwIfAborted();
    if (performance.now() - started >= limits.deadlineMs) throw new Error('Recovery deadline exceeded.');
    if (process.memoryUsage.rss() > limits.maxRssBytes) throw new Error('Recovery memory limit exceeded.');
  }
  checkBounds();
  if (!(database instanceof Database) || !database.open) throw new Error('An open trusted SQLite connection is required.');
  const parent = path.resolve(parentDirectory);
  if (await fs.realpath(parent) !== parent) throw new Error('Recovery parent must use its canonical path.');
  const parentIdentity = await fs.lstat(parent, { bigint: true });
  if (!parentIdentity.isDirectory() || (parentIdentity.mode & 0o077n) !== 0n
      || parentIdentity.uid !== BigInt(process.getuid())) throw new Error('Recovery parent must be a private owned directory.');
  // A private leaf under a non-sticky writable ancestor can still be replaced
  // by another uid while SQLite reopens its destination by pathname.
  for (let ancestor = path.dirname(parent); ; ancestor = path.dirname(ancestor)) {
    const stat = await fs.lstat(ancestor, { bigint: true });
    const trustedOwner = stat.uid === 0n || stat.uid === BigInt(process.getuid());
    if (!stat.isDirectory() || !trustedOwner
        || ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)) throw new Error('Recovery output directory ancestry is not trusted.');
    if (ancestor === path.dirname(ancestor)) break;
  }
  async function checkSpace(minimum) {
    const stat = await fs.statfs(parent, { bigint: true });
    if (stat.bavail * stat.bsize < BigInt(minimum)) throw new Error('Insufficient recovery free space.');
  }
  await checkSpace(limits.minimumFreeBytes);
  const pageSize = database.pragma('page_size', { simple: true });
  if (database.pragma('page_count', { simple: true }) * pageSize > limits.maxDatabaseBytes) throw new Error('Recovery database size limit exceeded.');
  checkBounds();
  const id = randomUUID();
  const root = path.join(parent, `recovery-${id}`);
  await fs.mkdir(root, { mode: 0o700 }); // Exclusive ownership; never adopt an existing root.
  const identity = await fs.lstat(root, { bigint: true });
  const working = path.join(root, 'bundle.incomplete');
  const published = path.join(root, 'bundle');
  let renamed = false;
  let complete = false;
  async function assertOwned() {
    const [currentParent, currentRoot] = await Promise.all([fs.lstat(parent, { bigint: true }), fs.lstat(root, { bigint: true })]);
    if (!currentParent.isDirectory() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino
        || !currentRoot.isDirectory() || currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino
        || await fs.realpath(root) !== root) throw new Error('Recovery directory identity changed; retained for manual inspection.');
  }
  try {
    await assertOwned();
    await fs.mkdir(working, { mode: 0o700 });
    const destination = path.join(working, 'database.sqlite');
    await database.backup(destination, { progress: ({ totalPages }) => {
      checkBounds();
      if (totalPages * pageSize > limits.maxDatabaseBytes) throw new Error('Recovery database size limit exceeded.');
      return 32;
    } });
    checkBounds();
    await assertOwned();
    await fs.chmod(destination, 0o600);
    const copied = await fs.lstat(destination);
    if (!copied.isFile() || copied.nlink !== 1 || copied.size > limits.maxDatabaseBytes) throw new Error('Recovery database size or file type invalid.');
    const inspection = new Database(destination, { fileMustExist: true });
    try {
      inspection.pragma('synchronous = FULL');
      inspection.pragma('cache_size = -2048');
      inspection.pragma('mmap_size = 0');
      if (inspection.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Recovery journal normalization failed.');
      inspection.pragma('query_only = ON');
      checkBounds();
      if (inspection.pragma('quick_check(1)', { simple: true }) !== 'ok') throw new Error('Recovery quick_check failed.');
      const documents = inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='secure_documents' COLLATE NOCASE").get();
      if (documents && inspection.prepare('SELECT 1 FROM secure_documents LIMIT 1').get()) throw new Error('Recovery capture does not support secure documents.');
    } finally { inspection.close(); }
    checkBounds();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await fs.lstat(`${destination}${suffix}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Recovery database has SQLite sidecars.');
    }
    const handle = await fs.open(destination, constants.O_RDWR | constants.O_NOFOLLOW);
    let digest;
    let size;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.maxDatabaseBytes)) throw new Error('Recovery database size or identity invalid.');
      const header = Buffer.alloc(20);
      await handle.read(header, 0, 20, 0);
      if (header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) throw new Error('Recovery database header invalid.');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < Number(before.size)) {
        checkBounds();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
        if (!bytesRead) throw new Error('Recovery database truncated.');
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await fs.lstat(destination, { bigint: true }))) throw new Error('Recovery database changed during verification.');
      await handle.sync();
      digest = hash.digest('hex');
      size = Number(before.size);
    } finally { await handle.close(); }
    const now = new Date().toISOString();
    const manifest = {
      version: 2, id, createdAt: now, provider: 'sqlite',
      database: { relativePath: 'database.sqlite', sizeBytes: size, sha256: digest },
      secureDocuments: { count: 0, totalBytes: 0, files: [] },
      retention: { days: 30, count: 2 }, // Compatibility metadata only; this helper never prunes.
      verification: { verifiedAt: now, databaseCheck: 'quick_check', checksum: 'sha256' },
    };
    const manifestHandle = await fs.open(path.join(working, 'manifest.json'), 'wx', 0o600);
    try { await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
    await syncDirectory(working);
    await assertOwned();
    await checkSpace(256 * MiB);
    checkBounds();
    await fs.rename(working, published);
    renamed = true;
    await syncDirectory(root);
    await syncDirectory(parent);
    complete = true;
    return { path: published, manifest };
  } catch (error) {
    if (renamed) {
      const uncertain = new Error(`Recovery published; durability uncertain. Retained at ${published}`, { cause: error });
      uncertain.code = 'RECOVERY_PUBLICATION_UNCERTAIN';
      uncertain.publishedPath = published;
      throw uncertain;
    }
    throw error;
  } finally {
    if (!complete && !renamed) {
      // Only unlink known files in our unchanged private directory. Never recursive
      // rm, follow symlinks, remove historical bundles, or clean a published bundle.
      await assertOwned();
      const workStat = await fs.lstat(working).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (workStat?.isDirectory() && !workStat.isSymbolicLink()) {
        for (const name of ['database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm', 'database.sqlite-journal', 'manifest.json']) await fs.unlink(path.join(working, name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(working);
      }
      await fs.rmdir(root);
      await syncDirectory(parent);
    }
  }
}
