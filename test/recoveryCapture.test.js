import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createZeroDocumentRecoveryBundle } from '../server/services/recoveryCapture.js';
import { verifyBackupBundle } from '../server/services/backups.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ug-recovery-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new Database(path.join(root, 'source.sqlite'));
  t.after(() => database.close());
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE records(value TEXT);');
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.pragma('wal_autocheckpoint = 0');
  database.prepare('INSERT INTO records VALUES (?)').run('committed in WAL');
  const output = path.join(root, 'output');
  await fs.mkdir(output, { mode: 0o700 });
  return { root, database, output, options: { database, parentDirectory: output } };
}

test('zero-document recovery captures WAL state, publishes a compatible durable bundle and never prunes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.output, 'old-recovery'), 'retain');
  const before = await Promise.all(['source.sqlite', 'source.sqlite-wal'].map((name) => fs.readFile(path.join(f.root, name))));
  const result = await createZeroDocumentRecoveryBundle(f.options);
  assert.equal((await verifyBackupBundle(result.path)).ok, true);
  const copy = new Database(path.join(result.path, 'database.sqlite'), { readonly: true });
  try { assert.equal(copy.prepare('SELECT value FROM records').get().value, 'committed in WAL'); } finally { copy.close(); }
  assert.deepEqual((await fs.readdir(result.path)).sort(), ['database.sqlite', 'manifest.json']);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(result.path, 'database.sqlite'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(f.output, 'old-recovery'), 'utf8'), 'retain');
  for (const [index, name] of ['source.sqlite', 'source.sqlite-wal'].entries()) assert.deepEqual(await fs.readFile(path.join(f.root, name)), before[index]);
});

test('any secure-document row fails closed and removes only the newly owned incomplete capture', async (t) => {
  const f = await fixture(t);
  f.database.exec('CREATE TABLE secure_documents(id TEXT); INSERT INTO secure_documents VALUES (\'document\');');
  await fs.writeFile(path.join(f.output, 'retain'), 'old');
  await assert.rejects(createZeroDocumentRecoveryBundle(f.options), /secure documents/);
  assert.deepEqual(await fs.readdir(f.output), ['retain']);
});

test('an existing empty secure-document table is accepted', async (t) => {
  const f = await fixture(t);
  f.database.exec('CREATE TABLE secure_documents(id TEXT);');
  assert.equal((await createZeroDocumentRecoveryBundle(f.options)).manifest.secureDocuments.count, 0);
});

for (const [name, limits, message] of [
  ['database size', { maxDatabaseBytes: 4096 }, /database size/],
  ['free space', { minimumFreeBytes: Number.MAX_SAFE_INTEGER }, /free space/],
  ['memory', { maxRssBytes: 1 }, /memory/],
  ['deadline', { deadlineMs: 0 }, /deadline/],
]) test(`${name} limit aborts before publication without touching older output`, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.output, 'retain'), 'old');
  await assert.rejects(createZeroDocumentRecoveryBundle({ ...f.options, ...limits }), message);
  assert.deepEqual(await fs.readdir(f.output), ['retain']);
});

test('symlink or publicly writable parent is rejected without writing through it', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, 'linked');
  await fs.symlink(f.output, link);
  await assert.rejects(createZeroDocumentRecoveryBundle({ ...f.options, parentDirectory: link }), /canonical/);
  await fs.chmod(f.output, 0o777);
  await assert.rejects(createZeroDocumentRecoveryBundle(f.options), /private/);
  assert.deepEqual(await fs.readdir(f.output), []);
});

test('aborted signal fails before work and invalid limits do not create output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createZeroDocumentRecoveryBundle({ ...f.options, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(createZeroDocumentRecoveryBundle({ ...f.options, maxDatabaseBytes: Infinity }), /limit/);
  assert.deepEqual(await fs.readdir(f.output), []);
});

test('abort during native backup closes work and cleans only its incomplete directory', async (t) => {
  const f = await fixture(t);
  f.database.exec('CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(2097152));');
  await fs.writeFile(path.join(f.output, 'retain'), 'old');
  const abort = new AbortController();
  const backup = Database.prototype.backup;
  let progressReached = false;
  t.mock.method(Database.prototype, 'backup', function (destination, options) {
    return backup.call(this, destination, { ...options, progress(state) {
      progressReached = true;
      abort.abort();
      return options.progress(state);
    } });
  });
  await assert.rejects(createZeroDocumentRecoveryBundle({ ...f.options, signal: abort.signal }), /abort/i);
  assert.equal(progressReached, true);
  assert.deepEqual(await fs.readdir(f.output), ['retain']);
  assert.equal(f.database.prepare('SELECT value FROM records').get().value, 'committed in WAL');
});

for (const failure of ['manifest-open', 'working-directory-sync']) test(`${failure} failure closes handles and cleans incomplete work`, async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  let injected = false;
  let handlesOpen = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (failure === 'manifest-open' && path.basename(file) === 'manifest.json') { injected = true; throw new Error('injected failure'); }
    const handle = await open(file, ...args);
    handlesOpen += 1;
    const close = handle.close.bind(handle);
    handle.close = async () => { try { return await close(); } finally { handlesOpen -= 1; } };
    if (failure === 'working-directory-sync' && path.basename(file) === 'bundle.incomplete') {
      handle.sync = async () => { injected = true; throw new Error('injected failure'); };
    }
    return handle;
  });
  await assert.rejects(createZeroDocumentRecoveryBundle(f.options), /injected failure/);
  assert.equal(injected, true);
  assert.equal(handlesOpen, 0);
  assert.deepEqual(await fs.readdir(f.output), []);
});

test('post-publication sync failure reports and retains the exact bundle with uncertain durability', async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.basename(file).startsWith('recovery-')) handle.sync = async () => { throw new Error('injected sync failure'); };
    return handle;
  });
  let failure;
  await assert.rejects(createZeroDocumentRecoveryBundle(f.options), (error) => {
    failure = error;
    return error.code === 'RECOVERY_PUBLICATION_UNCERTAIN' && error.message.includes(error.publishedPath);
  });
  assert.equal(path.dirname(path.dirname(failure.publishedPath)), f.output);
  assert.equal((await verifyBackupBundle(failure.publishedPath)).ok, true);
  assert.deepEqual(await fs.readdir(path.dirname(failure.publishedPath)), ['bundle']);
});

for (const schema of [
  'CREATE TABLE SECURE_DOCUMENTS(id TEXT); INSERT INTO SECURE_DOCUMENTS VALUES (\'document\');',
  "CREATE VIEW secure_documents AS SELECT 'document' AS id;",
]) test('case variants and views cannot bypass the zero-document restriction', async (t) => {
  const f = await fixture(t);
  f.database.exec(schema);
  await assert.rejects(createZeroDocumentRecoveryBundle(f.options), /secure documents/);
  assert.deepEqual(await fs.readdir(f.output), []);
});
