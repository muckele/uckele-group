import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createSignedScanRequest,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from '../server/services/cimScanProtocol.js';
import { runOnDemandScanTask } from '../server/services/cimScanWorker.js';
import {
  createSyntheticAdmission,
  createSyntheticReplayStore,
  createSyntheticWorkerScanner,
} from './support/cimScanFixtures.js';

const key = Buffer.from('synthetic-p8-03-worker-key-material-only');
const keyResolver = (keyId) => keyId === 'test-key-1' ? key : null;
const now = new Date('2026-10-03T12:00:00.000Z');
const bytes = Buffer.from('%PDF-1.7 synthetic worker fixture');

function requestWire(overrides = {}) {
  return createSignedScanRequest({
    requestId: '31111111-1111-4111-8111-111111111111',
    intakeId: '32222222-2222-4222-8222-222222222222',
    attempt: 1,
    jobOwner: 'synthetic-app-1',
    issuedAt: '2026-10-03T12:00:00.000Z',
    expiresAt: '2026-10-03T12:03:00.000Z',
    leaseExpiresAt: '2026-10-03T12:04:00.000Z',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mimeType: 'application/pdf',
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 90_000,
    keyId: 'test-key-1',
    ...overrides,
  }, { keyResolver });
}

function byteStream(value = bytes) {
  return Readable.from([value.subarray(0, 7), value.subarray(7)]);
}

function workerOptions(root, overrides = {}) {
  return {
    requestWire: requestWire(),
    openByteStream: () => byteStream(),
    keyResolver,
    replayStore: createSyntheticReplayStore({ now: () => new Date(now) }),
    admission: createSyntheticAdmission(),
    ephemeralRoot: root,
    scanner: createSyntheticWorkerScanner(),
    now: () => new Date(now),
    ...overrides,
  };
}

function verifiedRequest() {
  return parseAndVerifyScanRequest(requestWire(), { keyResolver, now });
}

test('worker authenticates before opening bytes and rejects noncanonical/tampered requests', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-auth-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let opened = 0;
  const options = workerOptions(root, {
    requestWire: requestWire().replace('synthetic-app-1', 'synthetic-app-2'),
    openByteStream() { opened += 1; return byteStream(); },
  });
  await assert.rejects(runOnDemandScanTask(options), /signature/i);
  assert.equal(opened, 0);
  assert.deepEqual(await fsp.readdir(root), []);
});

test('worker scans exact bytes, cleans before signing, and replays without reopening bytes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-clean-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let opened = 0;
  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  const scanner = createSyntheticWorkerScanner();
  const options = workerOptions(root, {
    replayStore,
    scanner,
    openByteStream() { opened += 1; return byteStream(); },
  });
  const first = await runOnDemandScanTask(options);
  const verified = parseAndVerifyScanResult(first, {
    request: verifiedRequest(),
    keyResolver,
    now,
  });
  assert.equal(verified.outcome, 'clean');
  assert.equal(verified.cleanupStatus, 'cleaned');
  assert.equal(opened, 1);
  assert.equal(scanner.scanCount, 1);
  assert.deepEqual(await fsp.readdir(root), []);

  const replay = await runOnDemandScanTask(options);
  assert.equal(replay, first);
  assert.equal(opened, 1);
  assert.equal(scanner.scanCount, 1);
});

test('worker refuses stale signatures before opening attachment bytes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-stale-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let opened = 0;
  const scanner = createSyntheticWorkerScanner({
    preHealth: {
      healthy: true,
      daemonId: 'ClamAV synthetic-daemon',
      engineVersion: '1.synthetic',
      signatureVersion: 'old-db',
      signatureUpdatedAt: '2026-09-30T00:00:00.000Z',
    },
  });
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner,
    openByteStream() { opened += 1; return byteStream(); },
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'unavailable');
  assert.equal(verified.reasonCode, 'stale_signatures');
  assert.equal(opened, 0);
});

test('worker stale benchmark advances signature freshness only, not request or lease time', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-signature-clock-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let opened = 0;
  const scanner = createSyntheticWorkerScanner({
    preHealth: {
      healthy: true,
      daemonId: 'ClamAV synthetic-daemon',
      engineVersion: '1.synthetic',
      signatureVersion: 'synthetic-db-1',
      signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
    },
  });
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner,
    signatureNow: () => new Date('2026-10-04T13:00:00.000Z'),
    openByteStream() { opened += 1; return byteStream(); },
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'unavailable');
  assert.equal(verified.reasonCode, 'stale_signatures');
  assert.equal(opened, 0);
});

test('worker hash mismatch fails closed and removes its exact task copy', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-hash-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const wire = await runOnDemandScanTask(workerOptions(root, {
    openByteStream: () => byteStream(Buffer.from('%PDF-1.7 different bytes')),
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'ambiguous');
  assert.equal(verified.reasonCode, 'attachment_identity_mismatch');
  assert.deepEqual(await fsp.readdir(root), []);
});

test('cleanup failure cannot expose or replay a clean result', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-cleanup-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  const wire = await runOnDemandScanTask(workerOptions(root, {
    replayStore,
    cleanupOwnedTask: async () => ({ cleaned: false }),
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'ambiguous');
  assert.equal(verified.cleanupStatus, 'retained');
  assert.notEqual(verified.outcome, 'clean');
  const stored = [...replayStore.entries.values()][0];
  assert.equal(stored.resultWire, wire);
  assert.equal(JSON.parse(stored.resultWire).outcome, 'ambiguous');
});

test('worker preserves definite unsafe verdict when cleanup is uncertain', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-unsafe-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner: createSyntheticWorkerScanner({ outcome: 'unsafe' }),
    cleanupOwnedTask: async () => ({ cleaned: false }),
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'unsafe');
  assert.equal(verified.cleanupStatus, 'retained');
});

test('worker refuses unknown or symlinked orphan state before opening bytes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-orphan-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-outside-'));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  await fsp.symlink(outside, path.join(root, 'task-unknown'));
  let opened = 0;
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    openByteStream() { opened += 1; return byteStream(); },
  })), /orphan|ephemeral root/i);
  assert.equal(opened, 0);
  assert.equal(fs.lstatSync(path.join(root, 'task-unknown')).isSymbolicLink(), true);
});

test('worker refuses a relative or overly broad ephemeral root before opening bytes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-root-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let opened = 0;
  await assert.rejects(runOnDemandScanTask(workerOptions(path.relative(process.cwd(), root), {
    openByteStream() { opened += 1; return byteStream(); },
  })), /absolute|root/i);
  assert.equal(opened, 0);
});

test('worker derives every operation budget from one decreasing monotonic deadline', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-deadline-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const observed = [];
  const health = {
    healthy: true,
    daemonId: 'ClamAV synthetic-daemon',
    engineVersion: '1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  };
  const scanner = {
    async health({ deadlineMs }) {
      observed.push(deadlineMs);
      if (observed.length === 1) await new Promise((resolve) => setTimeout(resolve, 30));
      return health;
    },
    async scan({ byteStream: stream, deadlineMs }) {
      observed.push(deadlineMs);
      for await (const _chunk of stream) { /* synthetic */ }
      return { outcome: 'clean', reasonCode: 'clean', daemonId: health.daemonId };
    },
  };
  const wire = requestWire({ maxDurationMs: 200 });
  const resultWire = await runOnDemandScanTask(workerOptions(root, {
    requestWire: wire,
    scanner,
  }));
  const request = parseAndVerifyScanRequest(wire, { keyResolver, now });
  assert.equal(parseAndVerifyScanResult(resultWire, { request, keyResolver, now }).outcome, 'clean');
  assert.equal(observed.length, 3);
  assert.ok(observed[1] < observed[0] - 15, 'scan must consume the shared deadline budget');
  assert.ok(observed[2] <= observed[1], 'post-scan health must not receive a reset budget');
});

test('worker bounds admission and cleanup with the same task deadline before signing', async (t) => {
  const admissionRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-admission-timeout-'));
  const cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-cleanup-timeout-'));
  t.after(() => Promise.all([
    fsp.rm(admissionRoot, { recursive: true, force: true }),
    fsp.rm(cleanupRoot, { recursive: true, force: true }),
  ]));
  let opened = 0;
  await assert.rejects(runOnDemandScanTask(workerOptions(admissionRoot, {
    requestWire: requestWire({ maxDurationMs: 40 }),
    admission: { async acquire() { return new Promise(() => {}); } },
    openByteStream() { opened += 1; return byteStream(); },
  })), /deadline/i);
  assert.equal(opened, 0);

  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  await assert.rejects(runOnDemandScanTask(workerOptions(cleanupRoot, {
    requestWire: requestWire({
      requestId: '41111111-1111-4111-8111-111111111111',
      maxDurationMs: 60,
    }),
    replayStore,
    cleanupOwnedTask: async () => new Promise(() => {}),
  })), /deadline/i);
  assert.equal([...replayStore.entries.values()][0].resultWire, null);
});

test('worker actively aborts a timed-out task copy before returning', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-copy-timeout-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let sourceClosed = false;
  let lateTimer;
  const slowBytes = new Readable({
    read() {
      if (lateTimer) return;
      this.push(bytes.subarray(0, 1));
      lateTimer = setTimeout(() => {
        this.push(bytes.subarray(1));
        this.push(null);
      }, 250);
    },
    destroy(error, callback) {
      clearTimeout(lateTimer);
      sourceClosed = true;
      callback(error);
    },
  });
  const startedAt = performance.now();
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '51111111-1111-4111-8111-111111111111',
      maxDurationMs: 40,
    }),
    openByteStream: () => slowBytes,
  })), /deadline/i);
  assert.ok(performance.now() - startedAt < 150, 'active abort must honor the shared deadline');
  assert.equal(sourceClosed, true, 'pipeline must close the source before the worker returns');
  const [taskName] = await fsp.readdir(root);
  const attachmentPath = path.join(root, taskName, 'attachment.bin');
  const sizeAtReturn = (await fsp.stat(attachmentPath)).size;
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal((await fsp.stat(attachmentPath)).size, sizeAtReturn, 'no late writer may remain');
});

test('worker preserves scanner-unavailable semantics when the scanner throws', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-scan-unavailable-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const health = {
    healthy: true,
    daemonId: 'unix-socket-inode:stable',
    engineVersion: '1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  };
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner: {
      async health() { return health; },
      async scan() { throw new Error('synthetic scanner outage'); },
    },
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'unavailable');
  assert.equal(verified.reasonCode, 'scanner_unavailable');
});

test('worker normalizes malformed health to a signed unavailable result', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-bad-health-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner: {
      async health() { return { healthy: true, daemonId: 'truthy-but-incomplete' }; },
      async scan() { throw new Error('must not scan'); },
    },
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'unavailable');
  assert.equal(verified.reasonCode, 'stale_signatures');
});

test('synthetic replay authority is bounded and never replays expired results', async () => {
  let clock = new Date('2026-10-03T12:00:00.000Z');
  const replayStore = createSyntheticReplayStore({ maxEntries: 2, now: () => new Date(clock) });
  const claim = (requestId, requestDigest, expiresAt) => replayStore.claim({
    keyId: 'test-key-1', requestId, requestDigest, expiresAt,
  });
  const firstId = '61111111-1111-4111-8111-111111111111';
  const secondId = '71111111-1111-4111-8111-111111111111';
  const thirdId = '81111111-1111-4111-8111-111111111111';
  assert.equal((await claim(firstId, 'a'.repeat(64), '2026-10-03T12:00:10.000Z')).status, 'accepted');
  assert.equal((await claim(secondId, 'b'.repeat(64), '2026-10-03T12:03:00.000Z')).status, 'accepted');
  assert.equal((await claim(thirdId, 'c'.repeat(64), '2026-10-03T12:03:00.000Z')).status, 'capacity');
  clock = new Date('2026-10-03T12:00:11.000Z');
  assert.equal((await claim(thirdId, 'c'.repeat(64), '2026-10-03T12:03:00.000Z')).status, 'accepted');

  const resultWire = JSON.stringify({
    keyId: 'test-key-1', requestId: secondId, requestDigest: 'b'.repeat(64),
    expiresAt: '2026-10-03T12:00:20.000Z',
  });
  assert.equal(await replayStore.complete({
    keyId: 'test-key-1', requestId: secondId, requestDigest: 'b'.repeat(64), resultWire,
  }), true);
  assert.equal((await claim(secondId, 'b'.repeat(64), '2026-10-03T12:03:00.000Z')).status, 'replay');
  clock = new Date('2026-10-03T12:00:21.000Z');
  assert.equal((await claim(secondId, 'b'.repeat(64), '2026-10-03T12:03:00.000Z')).status, 'inflight');
});

test('worker refuses clean authority when the Unix peer generation changes during scan', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-peer-swap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const health = {
    healthy: true,
    daemonId: 'unix-socket-inode:pre-post',
    engineVersion: '1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  };
  const wire = await runOnDemandScanTask(workerOptions(root, {
    scanner: {
      async health() { return health; },
      async scan({ byteStream: stream }) {
        for await (const _chunk of stream) { /* synthetic */ }
        return { outcome: 'clean', reasonCode: 'clean', daemonId: 'unix-socket-inode:swapped' };
      },
    },
  }));
  const verified = parseAndVerifyScanResult(wire, {
    request: verifiedRequest(), keyResolver, now,
  });
  assert.equal(verified.outcome, 'ambiguous');
  assert.equal(verified.reasonCode, 'scanner_identity_changed');
});
