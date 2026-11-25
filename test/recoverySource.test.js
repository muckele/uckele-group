import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { captureRecoveryFromSqlitePath } from '../server/services/recoverySource.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ug-recovery-source-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'source.sqlite');
  const writer = new Database(sqlitePath);
  t.after(() => writer.close());
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE records(value TEXT);');
  writer.pragma('wal_checkpoint(TRUNCATE)'); writer.pragma('wal_autocheckpoint = 0');
  writer.exec("INSERT INTO records VALUES ('WAL-only row')");
  const parentDirectory = path.join(root, 'output');
  await fs.mkdir(parentDirectory, { mode: 0o700 });
  return { root, writer, options: { sqlitePath, parentDirectory, acknowledgeWalSharedMemoryEffects: true } };
}

test('read-only adapter captures committed WAL data and closes its own connection before returning', async (t) => {
  const f = await fixture(t);
  const before = await Promise.all(['', '-wal'].map((suffix) => fs.readFile(`${f.options.sqlitePath}${suffix}`)));
  const result = await captureRecoveryFromSqlitePath(f.options);
  assert.equal(result.sourceConnectionClosed, true);
  assert.equal(result.sourceReadOnly, true);
  const copy = new Database(path.join(result.path, 'database.sqlite'), { readonly: true });
  try { assert.equal(copy.prepare('SELECT value FROM records').get().value, 'WAL-only row'); } finally { copy.close(); }
  for (const [index, suffix] of ['', '-wal'].entries()) assert.deepEqual(await fs.readFile(`${f.options.sqlitePath}${suffix}`), before[index]);
  assert.equal(f.writer.open, true);
  f.writer.exec("INSERT INTO records VALUES ('writer still usable')");
});

test('source access requires explicit acknowledgement of SQLite shared-memory side effects', async (t) => {
  const f = await fixture(t);
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, acknowledgeWalSharedMemoryEffects: false }), /acknowledge/i);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('missing WAL source is never created and symlink/hardlinked source is rejected', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'missing.sqlite');
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, sqlitePath: missing }), /ENOENT/);
  await assert.rejects(fs.stat(missing), /ENOENT/);
  const link = path.join(f.root, 'linked.sqlite'); await fs.symlink(f.options.sqlitePath, link);
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, sqlitePath: link }), /canonical/);
  await fs.link(f.options.sqlitePath, path.join(f.root, 'hard.sqlite'));
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), /regular|owned/);
});

test('absent WAL/SHM files fail before opening SQLite and are not manufactured', async (t) => {
  const f = await fixture(t);
  // A separate closed DELETE-mode database has no WAL/SHM files.
  const sqlitePath = path.join(f.root, 'closed.sqlite');
  const closed = new Database(sqlitePath); closed.exec('CREATE TABLE records(value TEXT)'); closed.close();
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, sqlitePath }), /WAL/);
  await assert.rejects(fs.stat(`${sqlitePath}-wal`), /ENOENT/);
  await assert.rejects(fs.stat(`${sqlitePath}-shm`), /ENOENT/);
});

test('space/abort/invalid limits reject before any native source connection opens', async (t) => {
  const f = await fixture(t);
  const backup = Database.prototype.backup;
  t.mock.method(Database.prototype, 'backup', function (...args) { assert.fail('backup must not run'); return backup.apply(this, args); });
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, minimumFreeBytes: Number.MAX_SAFE_INTEGER }), /free space/);
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, minimumFreeBytes: 1 }), /tightened/);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('document rejection closes the adapter connection and retains older output', async (t) => {
  const f = await fixture(t);
  f.writer.exec("CREATE TABLE secure_documents(id TEXT); INSERT INTO secure_documents VALUES ('doc')");
  let readonlyClosed = 0;
  const close = Database.prototype.close;
  t.mock.method(Database.prototype, 'close', function () { if (this.readonly) readonlyClosed += 1; return close.call(this); });
  await fs.writeFile(path.join(f.options.parentDirectory, 'retain'), 'old');
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), /secure documents/);
  assert.equal(readonlyClosed, 1);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), ['retain']);
});

test('missing SHM closes pinned main/WAL descriptors and never creates the missing sidecar', async (t) => {
  const f = await fixture(t);
  await fs.rename(`${f.options.sqlitePath}-shm`, path.join(f.root, 'held-shm'));
  const open = fs.open;
  let handlesOpen = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args); handlesOpen += 1;
    const close = handle.close.bind(handle);
    handle.close = async () => { try { await close(); } finally { handlesOpen -= 1; } };
    return handle;
  });
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), /ENOENT/);
  assert.equal(handlesOpen, 0);
  await assert.rejects(fs.stat(`${f.options.sqlitePath}-shm`), /ENOENT/);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('late source identity drift reports and retains the published bundle after source closure', async (t) => {
  const f = await fixture(t);
  const lstat = fs.lstat;
  let sourceChecks = 0;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    const stat = await lstat(file, ...args);
    if (file === f.options.sqlitePath && ++sourceChecks === 3) stat.ino += 1n;
    return stat;
  });
  let failure;
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), (error) => {
    failure = error;
    return error.code === 'RECOVERY_SOURCE_FINALIZATION_UNCERTAIN' && error.message.includes(error.publishedPath);
  });
  assert.deepEqual((await fs.readdir(failure.publishedPath)).sort(), ['database.sqlite', 'manifest.json']);
});

test('a source descriptor close failure preserves the published path and closes all other descriptors', async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  let handlesOpen = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args); handlesOpen += 1;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      try { await close(); } finally { handlesOpen -= 1; }
      if (file === f.options.sqlitePath) throw new Error('injected source close failure');
    };
    return handle;
  });
  let failure;
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), (error) => {
    failure = error;
    return error.code === 'RECOVERY_SOURCE_FINALIZATION_UNCERTAIN';
  });
  assert.equal(handlesOpen, 0);
  assert.equal(failure.cause.closeErrors.length, 1);
  assert.deepEqual((await fs.readdir(failure.publishedPath)).sort(), ['database.sqlite', 'manifest.json']);
});

test('a source directory writable by another uid is rejected before SQLite access', async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.root, 0o777);
  await assert.rejects(captureRecoveryFromSqlitePath(f.options), /directory ancestry/);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('unsafe non-sticky writable ancestors cannot be hidden behind a private source parent', async (t) => {
  const f = await fixture(t);
  const privateSource = path.join(f.root, 'private');
  await fs.mkdir(privateSource, { mode: 0o700 });
  await fs.chmod(f.root, 0o777);
  // An owned regular dummy file is enough: ancestry must fail before reading SQLite.
  const sqlitePath = path.join(privateSource, 'source.sqlite'); await fs.writeFile(sqlitePath, 'not opened', { mode: 0o600 });
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, sqlitePath }), /directory ancestry/);
  assert.deepEqual(await fs.readdir(f.options.parentDirectory), []);
});

test('private output under an unsafe ancestor is rejected independently of safe source ancestry', async (t) => {
  const f = await fixture(t);
  const unsafe = path.join(f.root, 'unsafe-output'); await fs.mkdir(unsafe, { mode: 0o777 }); await fs.chmod(unsafe, 0o777);
  const parentDirectory = path.join(unsafe, 'private'); await fs.mkdir(parentDirectory, { mode: 0o700 });
  await assert.rejects(captureRecoveryFromSqlitePath({ ...f.options, parentDirectory }), /directory ancestry/);
  assert.deepEqual(await fs.readdir(parentDirectory), []);
});
