// Exported adapter only: no CLI, config loader, storage initialization, or live invocation.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createZeroDocumentRecoveryBundle, getRecoveryCaptureLimits } from './recoveryCapture.js';

export async function captureRecoveryFromSqlitePath({
  sqlitePath, parentDirectory, acknowledgeWalSharedMemoryEffects = false, signal, ...overrides
}) {
  if (acknowledgeWalSharedMemoryEffects !== true) throw new Error('Explicitly acknowledge SQLite WAL shared-memory side effects.');
  const limits = getRecoveryCaptureLimits(overrides);
  const started = performance.now();
  function checkBounds() {
    signal?.throwIfAborted();
    if (performance.now() - started >= limits.deadlineMs) throw new Error('Recovery source deadline exceeded.');
    if (process.memoryUsage.rss() > limits.maxRssBytes) throw new Error('Recovery source memory limit exceeded.');
  }
  checkBounds();
  const parent = path.resolve(parentDirectory);
  if (await fs.realpath(parent) !== parent) throw new Error('Recovery parent must use its canonical path.');
  const parentStat = await fs.lstat(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.uid !== BigInt(process.getuid()) || (parentStat.mode & 0o077n) !== 0n) throw new Error('Recovery parent must be a private owned directory.');
  const free = await fs.statfs(parent, { bigint: true });
  if (free.bavail * free.bsize < BigInt(limits.minimumFreeBytes)) throw new Error('Insufficient recovery free space.');
  const source = path.resolve(sqlitePath);
  if (await fs.realpath(source) !== source) throw new Error('Recovery source must use its canonical path.');
  const pinned = [];
  let reader;
  let result;
  let failure;
  async function assertSourceIdentities() {
    for (const file of pinned) {
      const current = await fs.lstat(file.path, { bigint: true });
      if (current.dev !== file.identity.dev || current.ino !== file.identity.ino) throw new Error('Recovery source identity changed.');
      if (file.directory) assertTrustedDirectory(current, file.immediate);
      else if (!current.isFile() || current.nlink !== 1n) throw new Error('Recovery source identity changed.');
    }
  }
  function assertTrustedDirectory(stat, immediate) {
    const own = stat.uid === BigInt(process.getuid());
    const trustedOwner = own || stat.uid === 0n;
    const writableByOthers = (stat.mode & 0o022n) !== 0n;
    const sticky = (stat.mode & 0o1000n) !== 0n;
    if (!stat.isDirectory() || !trustedOwner || (immediate && !own)
        || (writableByOthers && (immediate || !sticky))) throw new Error('Recovery source directory ancestry is not trusted.');
  }
  try {
    // Native SQLite reopens a pathname rather than the pinned descriptor. Protect
    // every ancestor against replacement by another uid; sticky /tmp ancestors
    // are allowed, but the immediate source parent may not be writable by others.
    const sourceParent = path.dirname(source);
    for (const leaf of [sourceParent, parent]) {
      for (let directory = leaf; ; directory = path.dirname(directory)) {
        const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const entry = { path: directory, handle, directory: true, immediate: directory === leaf };
        pinned.push(entry);
        entry.identity = await handle.stat({ bigint: true });
        assertTrustedDirectory(entry.identity, entry.immediate);
        if (directory === path.dirname(directory)) break;
      }
    }
    // Require existing WAL/SHM instead of silently manufacturing sidecars. The
    // read-only connection can still update SQLite SHM read marks/locks; the
    // explicit acknowledgement above is a contract, not a no-write guarantee.
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${source}${suffix}`;
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const entry = { path: file, handle };
      pinned.push(entry);
      entry.identity = await handle.stat({ bigint: true });
      if (!entry.identity.isFile() || entry.identity.nlink !== 1n || entry.identity.uid !== BigInt(process.getuid())
          || (entry.identity.mode & 0o022n) !== 0n) throw new Error('Recovery source files must be regular, singly linked, owned and not writable by others.');
      if (!suffix) {
        const header = Buffer.alloc(20);
        await handle.read(header, 0, 20, 0);
        if (header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header[18] !== 2 || header[19] !== 2) throw new Error('Recovery source must be an existing WAL database.');
      }
      checkBounds();
    }
    await assertSourceIdentities();
    reader = new Database(source, { readonly: true, fileMustExist: true, timeout: 1000 });
    reader.pragma('query_only = ON');
    reader.pragma('cache_size = -2048');
    reader.pragma('mmap_size = 0');
    if (!reader.readonly || reader.pragma('query_only', { simple: true }) !== 1
        || reader.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('Recovery source could not be restricted to read-only WAL inspection.');
    await assertSourceIdentities();
    checkBounds();
    result = await createZeroDocumentRecoveryBundle({ database: reader, parentDirectory: parent, signal,
      ...limits, deadlineMs: Math.max(0, limits.deadlineMs - Math.ceil(performance.now() - started)) });
    await assertSourceIdentities();
  } catch (error) { failure = error; }
  finally {
    const closeErrors = [];
    try { if (reader?.open) reader.close(); } catch (error) { closeErrors.push(error); }
    for (const file of [...pinned].reverse()) {
      try { await file.handle.close(); } catch (error) { closeErrors.push(error); }
    }
    if (closeErrors.length) {
      failure ||= new Error('Recovery source connection/file closure failed.');
      failure.closeErrors = closeErrors;
    }
  }
  if (failure) {
    if (result) {
      const uncertain = new Error(`Recovery source finalization failed; published bundle retained at ${result.path}`, { cause: failure });
      uncertain.code = 'RECOVERY_SOURCE_FINALIZATION_UNCERTAIN';
      uncertain.publishedPath = result.path;
      throw uncertain;
    }
    throw failure;
  }
  return { ...result, sourceReadOnly: true, sourceConnectionClosed: true, sharedMemorySideEffectsAcknowledged: true };
}
