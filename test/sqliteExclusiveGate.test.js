// The exclusive section lets a long SQLite transaction return to the event loop without any
// other storage call reading or joining it (server/storage/sqliteExclusiveGate.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { installSqliteExclusiveGate, StorageClosingError } from '../server/storage/sqliteExclusiveGate.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

function world(t, extraMethods = {}) {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (name TEXT NOT NULL)');
  const names = () => database.prepare('SELECT name FROM items ORDER BY rowid').all().map((row) => row.name);
  const storageApi = {
    provider: 'test',
    async addItem(name) {
      database.prepare('INSERT INTO items (name) VALUES (?)').run(name);
      return name;
    },
    addItemSync(name) {
      database.prepare('INSERT INTO items (name) VALUES (?)').run(name);
      return name;
    },
    async countItems() {
      return database.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    },
    async checkHealth() {
      database.prepare('SELECT 1').get();
      return { ok: true, inTransaction: database.inTransaction };
    },
    close() {
      database.close();
    },
    ...extraMethods,
  };
  const logs = [];
  const gate = installSqliteExclusiveGate(storageApi, database, {
    exclusiveMethods: [],
    logger: { warn: (line) => logs.push(line), log: (line) => logs.push(`log: ${line}`) },
  });
  t.after(() => {
    if (database.open) database.close();
  });
  return { database, storageApi, gate, names, logs };
}

// A section that writes `names`, yielding to the event loop after each, then commits.
function writeInSection({ database, gate }, names, { failAfter = Infinity, onYield = async () => {} } = {}) {
  return gate.runExclusive('test-section', async ({ checkpoint }) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, name] of names.entries()) {
        if (index >= failAfter) throw new Error('injected failure');
        database.prepare('INSERT INTO items (name) VALUES (?)').run(name);
        await turn();
        checkpoint();
        await onYield(index);
      }
      database.exec('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw error;
    }
    return names.length;
  });
}

test('with no section held, a storage call runs synchronously and returns what the method returns', async (t) => {
  const { storageApi, names } = world(t);
  assert.equal(storageApi.addItemSync('sync'), 'sync', 'a synchronous method still returns its value, not a promise');
  const pending = storageApi.addItem('async');
  assert.deepEqual(names(), ['sync', 'async'], 'the async method body ran before the call returned');
  assert.equal(await pending, 'async');
});

test('a write issued while a section yields waits, lands after COMMIT, and is never part of the section', async (t) => {
  const context = world(t);
  const { storageApi, database, names } = context;
  const observed = [];
  let queued;
  await writeInSection(context, ['s1', 's2', 's3'], {
    async onYield(index) {
      if (index !== 0) return;
      queued = storageApi.addItem('outside');
      // Not run yet: the section still owns the connection.
      observed.push(names().includes('outside'));
      observed.push(database.inTransaction);
    },
  });
  assert.deepEqual(observed, [false, true]);
  assert.equal(await queued, 'outside');
  assert.deepEqual(names(), ['s1', 's2', 's3', 'outside']);
});

test('a section that throws after yielding rolls back, releases the gate and still runs the queued write', async (t) => {
  const context = world(t);
  const { storageApi, database, names, gate } = context;
  let queued;
  await assert.rejects(writeInSection(context, ['s1', 's2', 's3'], {
    failAfter: 2,
    async onYield(index) {
      if (index === 0) queued = storageApi.addItem('outside');
    },
  }), /injected failure/);
  assert.equal(database.inTransaction, false);
  assert.equal(gate.isHeld(), false);
  assert.equal(await queued, 'outside');
  assert.deepEqual(names(), ['outside'], 'the section rolled back; the queued write is durable on its own');
});

test('a synchronous storage method called during a section returns a promise and runs after release', async (t) => {
  const context = world(t);
  const { storageApi, names } = context;
  let result;
  await writeInSection(context, ['s1'], {
    async onYield() {
      result = storageApi.addItemSync('outside');
      assert.equal(typeof result?.then, 'function');
    },
  });
  assert.equal(await result, 'outside');
  assert.deepEqual(names(), ['s1', 'outside']);
});

test('read-only health checks are answered during a section instead of queueing', async (t) => {
  const context = world(t);
  const { storageApi } = context;
  const health = [];
  await writeInSection(context, ['s1', 's2'], {
    async onYield() {
      health.push(await storageApi.checkHealth());
    },
  });
  assert.deepEqual(health, [{ ok: true, inTransaction: true }, { ok: true, inTransaction: true }]);
});

test('a section waits for a running storage call that awaits, and that call can make nested calls meanwhile', async (t) => {
  let release;
  const waitForRelease = new Promise((resolve) => {
    release = resolve;
  });
  const context = world(t, {
    async slowBackup() {
      await waitForRelease;
      // A nested call through the storage object while the section is waiting to start.
      await this.addItem('from-backup');
      return 'backup-done';
    },
  });
  const { storageApi, names } = context;
  const backup = storageApi.slowBackup();
  const section = writeInSection(context, ['s1']);
  await turn();
  await turn();
  assert.deepEqual(names(), [], 'the section has not started while the backup runs');
  release();
  assert.equal(await backup, 'backup-done');
  await section;
  assert.deepEqual(names(), ['from-backup', 's1']);
});

test('close() during a section rolls it back, runs the calls queued before it, then closes', async (t) => {
  const context = world(t);
  const { storageApi, database } = context;
  let queued;
  const closes = [];
  const section = writeInSection(context, ['s1', 's2', 's3'], {
    async onYield(index) {
      if (index !== 0) return;
      queued = storageApi.countItems();
      closes.push(storageApi.close(), storageApi.close());
      assert.equal(database.open, true, 'the connection stays open until the section ends');
    },
  });
  await assert.rejects(section, StorageClosingError);
  assert.equal(await queued, 0, 'the queued call ran before the close and saw the rolled-back table');
  await Promise.all(closes);
  assert.equal(database.open, false);
});

test('close() after a section but before its queued calls have run lets them run, then closes', async (t) => {
  const context = world(t);
  const { storageApi, database, names } = context;
  let queued;
  await writeInSection(context, ['s1'], {
    async onYield() {
      queued = [storageApi.addItem('q1'), storageApi.addItem('q2')];
    },
  });
  const closed = storageApi.close();
  assert.equal(database.open, true, 'the queued calls have not run yet');
  assert.deepEqual(await Promise.all(queued), ['q1', 'q2']);
  assert.deepEqual(names(), ['s1', 'q1', 'q2']);
  await closed;
  assert.equal(database.open, false);
});

test('a ROLLBACK that throws still opens the gate', async (t) => {
  const context = world(t);
  const { storageApi, database, gate } = context;
  const exec = database.exec;
  let failRollback = true;
  database.exec = function execOnce(source) {
    if (source === 'ROLLBACK' && failRollback) {
      failRollback = false;
      throw new Error('rollback failed');
    }
    return exec.call(this, source);
  };
  t.after(() => {
    database.exec = exec;
  });
  await assert.rejects(gate.runExclusive('failing-rollback', async () => {
    database.exec('BEGIN IMMEDIATE');
    throw new Error('body failed');
  }), /rollback failed/);
  assert.equal(gate.isHeld(), false);
  database.exec('ROLLBACK');
  assert.equal(await storageApi.countItems(), 0);
});

test('a section waits for the calls queued behind the previous one before it starts', async (t) => {
  const context = world(t);
  const { storageApi, names } = context;
  let queued;
  let second;
  await writeInSection(context, ['s1'], {
    async onYield() {
      queued = [storageApi.addItem('q1'), storageApi.addItem('q2')];
      second = writeInSection(context, ['s2']);
    },
  });
  await Promise.all([...queued, second]);
  assert.deepEqual(names(), ['s1', 'q1', 'q2', 's2']);
});

test('callers queued behind a section each run their read-then-write chain unbroken', async (t) => {
  // Break caught: starting every queued call at once runs both callers' reads before either
  // write, so both act on the same state, which a single macrotask per caller never allowed.
  const context = world(t);
  const { storageApi } = context;
  const steps = [];
  const caller = async (name) => {
    const before = await storageApi.countItems();
    steps.push(`${name} read ${before}`);
    await storageApi.addItem(name);
    steps.push(`${name} wrote`);
  };
  let callers;
  await writeInSection(context, ['s1'], {
    async onYield() {
      callers = Promise.all([caller('a'), caller('b')]);
    },
  });
  await callers;
  assert.deepEqual(steps, ['a read 1', 'a wrote', 'b read 2', 'b wrote']);
});

test('sections run one at a time, in the order they were requested', async (t) => {
  const context = world(t);
  const { names } = context;
  await Promise.all([
    writeInSection(context, ['a1', 'a2', 'a3']),
    writeInSection(context, ['b1', 'b2']),
  ]);
  assert.deepEqual(names(), ['a1', 'a2', 'a3', 'b1', 'b2']);
});

test('a section that made calls wait warns how long it held the connection; one that did not stays quiet', async (t) => {
  const context = world(t);
  const { storageApi, logs } = context;
  await writeInSection(context, ['quiet']);
  assert.deepEqual(logs, []);
  let queued;
  await writeInSection(context, ['s1', 's2'], {
    async onYield(index) {
      if (index === 0) queued = storageApi.countItems();
    },
  });
  assert.equal(await queued, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[storage:exclusive\] test-section heldMs=\d+ waitedMs=\d+ queuedCalls=1 longestQueuedMs=\d+$/);
});
