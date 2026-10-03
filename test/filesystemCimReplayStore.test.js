import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemCimReplayStore } from '../server/services/filesystemCimReplayStore.js';

const keyId = 'test-key-1';
const requestId = 'a1111111-1111-4111-8111-111111111111';
const requestDigest = 'a'.repeat(64);

function claim(store, overrides = {}) {
  const controller = new AbortController();
  return store.claim({
    keyId,
    requestId,
    requestDigest,
    expiresAt: '2026-10-03T12:03:00.000Z',
    deadlineAt: performance.now() + 1_000,
    signal: controller.signal,
    ...overrides,
  });
}

function resultWire(overrides = {}) {
  return JSON.stringify({
    keyId,
    requestId,
    requestDigest,
    expiresAt: '2026-10-03T12:02:00.000Z',
    ...overrides,
  });
}

test('filesystem replay claim and completion survive process restart atomically', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-durable-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const clock = () => new Date('2026-10-03T12:00:00.000Z');

  const firstProcess = createFilesystemCimReplayStore({ root, now: clock });
  assert.equal((await claim(firstProcess)).status, 'accepted');

  const afterClaimCrash = createFilesystemCimReplayStore({ root, now: clock });
  assert.equal((await claim(afterClaimCrash)).status, 'inflight');
  assert.equal(await afterClaimCrash.complete({
    keyId, requestId, requestDigest, resultWire: resultWire(),
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  }), true);

  const afterCompletionCrash = createFilesystemCimReplayStore({ root, now: clock });
  assert.deepEqual(await claim(afterCompletionCrash), {
    status: 'replay', resultWire: resultWire(),
  });
});

test('filesystem replay identity conflicts, enforces its cap, and expires exact entries', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-cap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let clock = new Date('2026-10-03T12:00:00.000Z');
  const store = createFilesystemCimReplayStore({ root, maxEntries: 1, now: () => clock });

  assert.equal((await claim(store, { expiresAt: '2026-10-03T12:00:10.000Z' })).status, 'accepted');
  assert.equal((await claim(store, { requestDigest: 'b'.repeat(64) })).status, 'conflict');
  assert.equal((await claim(store, {
    requestId: 'b1111111-1111-4111-8111-111111111111', requestDigest: 'b'.repeat(64),
  })).status, 'capacity');

  clock = new Date('2026-10-03T12:00:11.000Z');
  assert.equal((await claim(store, {
    requestId: 'b1111111-1111-4111-8111-111111111111', requestDigest: 'b'.repeat(64),
  })).status, 'accepted');
  const names = await fsp.readdir(root);
  assert.equal(names.filter((name) => name.startsWith('claim-')).length, 1);
  assert.equal(names.filter((name) => name.startsWith('result-')).length, 0);
});

test('filesystem replay store serializes concurrent claims and ignores only its crash temp files', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-crash-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, '.cim-replay-tmp-interrupted'), '{partial', { mode: 0o600 });
  await fsp.writeFile(path.join(root, 'slot-00000.json'), JSON.stringify({
    identityHash: 'f'.repeat(64),
    ownerPid: 2_147_483_647,
    reservationId: 'crashed-reservation',
    expiresAt: '2026-10-03T12:03:00.000Z',
  }), { mode: 0o600 });
  const store = createFilesystemCimReplayStore({
    root, now: () => new Date('2026-10-03T12:00:00.000Z'),
  });

  const statuses = (await Promise.all([claim(store), claim(store)])).map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ['accepted', 'inflight']);
  assert.equal((await fsp.readdir(root)).some((name) => name.startsWith('.cim-replay-tmp-')), false);
  const slotWire = await fsp.readFile(path.join(root, 'slot-00000.json'), 'utf8');
  assert.equal(JSON.parse(slotWire).identityHash === 'f'.repeat(64), false);
});

test('filesystem replay claim stays atomic across independently constructed store instances', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-multiprocess-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const options = { root, now: () => new Date('2026-10-03T12:00:00.000Z') };
  const first = createFilesystemCimReplayStore(options);
  const second = createFilesystemCimReplayStore(options);
  const statuses = await Promise.race([
    Promise.all([claim(first), claim(second)]).then((values) => values.map(({ status }) => status).sort()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cross-instance claim deadlocked')), 500)),
  ]);
  assert.deepEqual(statuses, ['accepted', 'inflight']);
});

test('filesystem replay cap stays atomic across different identities and store instances', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-global-cap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const options = {
    root, maxEntries: 1, now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  const first = createFilesystemCimReplayStore(options);
  const second = createFilesystemCimReplayStore(options);
  const statuses = (await Promise.all([
    claim(first),
    claim(second, {
      requestId: 'b1111111-1111-4111-8111-111111111111',
      requestDigest: 'b'.repeat(64),
    }),
  ])).map(({ status }) => status).sort();
  assert.deepEqual(statuses, ['accepted', 'capacity']);
  assert.equal((await fsp.readdir(root)).filter((name) => name.startsWith('claim-')).length, 1);
});

test('filesystem replay cleanup leaves a live publisher temporary file alone', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-live-temp-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const liveTemp = `.cim-replay-tmp-${process.pid}-00000000-0000-4000-8000-000000000000`;
  await fsp.writeFile(path.join(root, liveTemp), '{partial', { mode: 0o600 });
  const store = createFilesystemCimReplayStore({
    root, now: () => new Date('2026-10-03T12:00:00.000Z'),
  });

  assert.equal((await claim(store)).status, 'accepted');
  assert.equal((await fsp.readdir(root)).includes(liveTemp), true);
});

test('filesystem replay refuses expired or aborted mutations before publishing state', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-deadline-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = createFilesystemCimReplayStore({
    root, now: () => new Date('2026-10-03T12:00:00.000Z'),
  });
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));

  await assert.rejects(claim(store, { signal: aborted.signal }), /abort|cancel/i);
  await assert.rejects(claim(store, { deadlineAt: performance.now() - 1 }), /deadline/i);
  const names = await fsp.readdir(root).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(names.some((name) => name.startsWith('claim-') || name.startsWith('result-')), false);

  assert.equal((await claim(store)).status, 'accepted');
  await assert.rejects(store.complete({
    keyId, requestId, requestDigest, resultWire: resultWire(),
    deadlineAt: performance.now() + 1_000, signal: aborted.signal,
  }), /abort|cancel/i);
  assert.equal((await fsp.readdir(root)).some((name) => name.startsWith('result-')), false);
});

test('filesystem replay completion refuses mismatched or expired result authority', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-replay-result-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = createFilesystemCimReplayStore({
    root, now: () => new Date('2026-10-03T12:00:00.000Z'),
  });
  assert.equal((await claim(store)).status, 'accepted');
  assert.equal(await store.complete({
    keyId, requestId, requestDigest, resultWire: resultWire({ requestDigest: 'f'.repeat(64) }),
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  }), false);
  assert.equal(await store.complete({
    keyId, requestId, requestDigest,
    resultWire: resultWire({ expiresAt: '2026-10-03T11:59:59.000Z' }),
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  }), false);
  assert.equal((await claim(store)).status, 'inflight');
});
