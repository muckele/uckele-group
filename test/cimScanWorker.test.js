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

test('worker bounds admission and gives timed-out cleanup one expiry-capped finalization attempt', async (t) => {
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

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 160);
  const leaseExpiresAt = new Date(issuedAt.getTime() + 1_000);
  const dynamicNow = () => new Date();
  const replayStore = createSyntheticReplayStore({ now: dynamicNow });
  let cleanupCalls = 0;
  const startedAt = performance.now();
  await assert.rejects(runOnDemandScanTask(workerOptions(cleanupRoot, {
    requestWire: requestWire({
      requestId: '41111111-1111-4111-8111-111111111111',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      maxDurationMs: 40,
    }),
    now: dynamicNow,
    requireAttachment: true,
    replayStore,
    cleanupOwnedTask: async () => {
      cleanupCalls += 1;
      return new Promise(() => {});
    },
  })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  assert.equal(cleanupCalls, 1);
  assert.ok(performance.now() - startedAt < 500,
    'cleanup finalization must be capped by the authenticated request expiry');
  assert.equal([...replayStore.entries.values()][0].resultWire, null);
  assert.equal((await fsp.readdir(cleanupRoot)).length, 1,
    'uncertain cleanup must retain its exact authenticated task');
});

test('worker aborts a timed-out task copy, cleans it within reserve, and leaves no late writer', async (t) => {
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
  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  const scanner = createSyntheticWorkerScanner();
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '51111111-1111-4111-8111-111111111111',
      maxDurationMs: 120,
    }),
    replayStore,
    scanner,
    openByteStream: () => slowBytes,
  })), /deadline/i);
  assert.ok(performance.now() - startedAt < 500,
    'active abort and exact cleanup must remain well inside the cleanup reserve');
  assert.equal(sourceClosed, true, 'pipeline must close the source before the worker returns');
  assert.equal(scanner.scanCount, 0, 'timed-out attachment bytes must never reach the scanner');
  assert.equal([...replayStore.entries.values()][0].resultWire, null,
    'timeout must not complete durable replay authority');
  assert.deepEqual(await fsp.readdir(root), [], 'timeout cleanup must prove empty state');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.deepEqual(await fsp.readdir(root), [], 'no late writer may recreate timeout state');
});

test('late task-directory creation is cleanup-uncertain and can never produce 408', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-late-mkdir-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '54111111-1111-4111-8111-111111111111',
      maxDurationMs: 30,
    }),
    replayStore,
    createTaskDirectory: async (taskPath) => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      await fsp.mkdir(taskPath, { mode: 0o700 });
    },
  })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await fsp.readdir(root),
    ['task-54111111-1111-4111-8111-111111111111']);
  assert.equal([...replayStore.entries.values()][0].resultWire, null);
});

test('late owner-marker creation is retained behind cleanup-uncertain failure', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-late-marker-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '55111111-1111-4111-8111-111111111111',
      maxDurationMs: 30,
    }),
    replayStore,
    writeOwnerMarker: async (markerPath, markerWire) => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      await fsp.writeFile(markerPath, markerWire, { mode: 0o600, flag: 'wx' });
    },
  })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const taskPath = path.join(root, 'task-55111111-1111-4111-8111-111111111111');
  assert.equal((await fsp.lstat(path.join(taskPath, 'owner.json'))).isFile(), true);
  assert.equal([...replayStore.entries.values()][0].resultWire, null);
});

test('terminal replay completion aborts before late publication', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-replay-commit-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const authority = createSyntheticReplayStore({ now: () => new Date(now) });
  const replayStore = {
    claim: (input) => authority.claim(input),
    async complete(input) {
      await new Promise((resolve) => setTimeout(resolve, 70));
      if (input.signal.aborted) throw input.signal.reason;
      return authority.complete(input);
    },
  };
  const wire = requestWire({
    requestId: '56111111-1111-4111-8111-111111111111',
    maxDurationMs: 35,
  });
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: wire,
    replayStore,
  })), (error) => error?.code === 'CIM_SCAN_DEADLINE');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal([...authority.entries.values()][0].resultWire, null,
    'aborted completion must never publish behind a timeout');
});

test('cleanup retains a same-name replacement instead of deleting an unbound task inode',
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-task-swap-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-task-original-'));
    t.after(() => Promise.all([
      fsp.rm(root, { recursive: true, force: true }),
      fsp.rm(outside, { recursive: true, force: true }),
    ]));
    const requestId = '57111111-1111-4111-8111-111111111111';
    const taskPath = path.join(root, `task-${requestId}`);
    const originalPath = path.join(outside, 'authenticated-original');
    await assert.rejects(runOnDemandScanTask(workerOptions(root, {
      requestWire: requestWire({ requestId }),
      afterScan: async () => {
        const marker = await fsp.readFile(path.join(taskPath, 'owner.json'));
        const attachmentCopy = await fsp.readFile(path.join(taskPath, 'attachment.bin'));
        await fsp.rename(taskPath, originalPath);
        await fsp.mkdir(taskPath, { mode: 0o700 });
        await fsp.writeFile(path.join(taskPath, 'owner.json'), marker, { mode: 0o600 });
        await fsp.writeFile(path.join(taskPath, 'attachment.bin'), attachmentCopy, { mode: 0o600 });
      },
    })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
    assert.equal((await fsp.lstat(taskPath)).isDirectory(), true,
      'same-name replacement must be retained');
    assert.equal((await fsp.lstat(originalPath)).isDirectory(), true,
      'original authenticated inode must not be confused with its replacement');
  });

test('timeout finalization retains a same-name replacement and the original task inode',
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-timeout-swap-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-timeout-original-'));
    t.after(() => Promise.all([
      fsp.rm(root, { recursive: true, force: true }),
      fsp.rm(outside, { recursive: true, force: true }),
    ]));
    const requestId = '5b111111-1111-4111-8111-111111111111';
    const taskPath = path.join(root, `task-${requestId}`);
    const originalPath = path.join(outside, 'authenticated-original');
    const slowBytes = new Readable({
      read() {
        if (this.pushed) return;
        this.pushed = true;
        this.push(bytes.subarray(0, 1));
      },
    });
    const running = runOnDemandScanTask(workerOptions(root, {
      requestWire: requestWire({ requestId, maxDurationMs: 120 }),
      openByteStream: () => slowBytes,
    }));
    const markerPath = path.join(taskPath, 'owner.json');
    const attachmentPath = path.join(taskPath, 'attachment.bin');
    while (true) {
      try {
        await fsp.access(markerPath);
        await fsp.access(attachmentPath);
        break;
      } catch {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const marker = await fsp.readFile(markerPath);
    const partial = await fsp.readFile(attachmentPath);
    await fsp.rename(taskPath, originalPath);
    await fsp.mkdir(taskPath, { mode: 0o700 });
    await fsp.writeFile(markerPath, marker, { mode: 0o600 });
    await fsp.writeFile(attachmentPath, partial, { mode: 0o600 });
    await assert.rejects(running,
      (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
    assert.equal((await fsp.lstat(taskPath)).isDirectory(), true);
    assert.equal((await fsp.lstat(originalPath)).isDirectory(), true);
  });

test('timeout cleanup refuses a tampered owner marker and retains the exact task', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-timeout-owner-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const slowBytes = new Readable({
    read() {
      if (this.pushed) return;
      this.pushed = true;
      this.push(bytes.subarray(0, 1));
    },
  });
  const running = runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '52111111-1111-4111-8111-111111111111',
      maxDurationMs: 100,
    }),
    openByteStream: () => slowBytes,
  }));
  let taskName;
  while (!taskName) {
    [taskName] = await fsp.readdir(root);
    if (!taskName) await new Promise((resolve) => setImmediate(resolve));
  }
  const markerPath = path.join(root, taskName, 'owner.json');
  while (true) {
    try {
      await fsp.access(markerPath);
      break;
    } catch {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await fsp.writeFile(markerPath, '{"tampered":true}', { mode: 0o600 });
  await assert.rejects(running,
    (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  assert.deepEqual(await fsp.readdir(root), [taskName]);
  assert.match(await fsp.readFile(markerPath, 'utf8'), /^\{"tampered":true\}/);
});

test('timeout cleanup retains unknown and symlinked task entries without touching targets',
  async (t) => {
    for (const variant of ['unknown', 'symlink']) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ug-cim-worker-${variant}-`));
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-target-'));
      t.after(() => Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(outside, { recursive: true, force: true }),
      ]));
      const target = path.join(outside, 'must-remain');
      await fsp.writeFile(target, 'outside authority', { mode: 0o600 });
      const requestId = variant === 'unknown'
        ? '58111111-1111-4111-8111-111111111111'
        : '59111111-1111-4111-8111-111111111111';
      const slowBytes = new Readable({
        read() {
          if (this.pushed) return;
          this.pushed = true;
          this.push(bytes.subarray(0, 1));
        },
      });
      const running = runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({ requestId, maxDurationMs: 300 }),
        openByteStream: () => slowBytes,
      }));
      const taskPath = path.join(root, `task-${requestId}`);
      const markerPath = path.join(taskPath, 'owner.json');
      while (true) {
        try {
          await fsp.access(markerPath);
          break;
        } catch {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (variant === 'unknown') {
        await fsp.writeFile(path.join(taskPath, 'unknown.bin'), 'unknown', { mode: 0o600 });
      } else {
        await fsp.symlink(target, path.join(taskPath, 'unknown.bin'));
      }
      await assert.rejects(running,
        (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
      assert.equal(await fsp.readFile(target, 'utf8'), 'outside authority');
      assert.equal((await fsp.lstat(taskPath)).isDirectory(), true);
    }
  });

test('timeout cleanup reserve exposes one monotonic deadline capped at 2000 ms', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-reserve-cap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let reserveMs;
  const slowBytes = new Readable({
    read() {
      if (this.pushed) return;
      this.pushed = true;
      this.push(bytes.subarray(0, 1));
    },
  });
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '5a111111-1111-4111-8111-111111111111',
      maxDurationMs: 30,
    }),
    openByteStream: () => slowBytes,
    cleanupOwnedTask: async ({ deadlineAt }) => {
      reserveMs = deadlineAt - performance.now();
      return { cleaned: false };
    },
  })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  assert.ok(reserveMs > 1_900 && reserveMs <= 2_000,
    `cleanup reserve must be one bounded 2000 ms window, observed ${reserveMs}`);
});

test('timeout cleanup reserve is capped by matching authenticated request and lease expiry', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-timeout-lease-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const issuedAt = new Date();
  const dynamicNow = () => new Date();
  let cleanupCalls = 0;
  const startedAt = performance.now();
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({
      requestId: '53111111-1111-4111-8111-111111111111',
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 160).toISOString(),
      leaseExpiresAt: new Date(issuedAt.getTime() + 160).toISOString(),
      maxDurationMs: 40,
    }),
    now: dynamicNow,
    requireAttachment: true,
    replayStore: createSyntheticReplayStore({ now: dynamicNow }),
    cleanupOwnedTask: async () => {
      cleanupCalls += 1;
      return new Promise(() => {});
    },
  })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
  assert.equal(cleanupCalls, 1);
  assert.ok(performance.now() - startedAt < 500,
    'cleanup finalization must be capped by authenticated request and lease expiry');
  assert.equal((await fsp.readdir(root)).length, 1);
});

test('authenticated recovery marker preserves every cleanup crash boundary and expires safely',
  async (t) => {
    const cases = [
      {
        step: 'recovery_marker_linked',
        rootEntries: ['recovery-5c111111-1111-4111-8111-111111111111.json',
          'task-5c111111-1111-4111-8111-111111111111'],
        taskEntries: ['attachment.bin', 'owner.json'],
      },
      {
        step: 'attachment_unlinked',
        rootEntries: ['recovery-5d111111-1111-4111-8111-111111111111.json',
          'task-5d111111-1111-4111-8111-111111111111'],
        taskEntries: ['owner.json'],
      },
      {
        step: 'owner_marker_unlinked',
        rootEntries: ['recovery-5e111111-1111-4111-8111-111111111111.json',
          'task-5e111111-1111-4111-8111-111111111111'],
        taskEntries: [],
      },
      {
        step: 'task_directory_removed',
        rootEntries: ['recovery-5f111111-1111-4111-8111-111111111111.json'],
        taskEntries: null,
      },
      {
        step: 'recovery_marker_unlinked',
        rootEntries: [],
        taskEntries: null,
      },
    ];
    for (const [index, expected] of cases.entries()) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-recovery-step-'));
      t.after(() => fsp.rm(root, { recursive: true, force: true }));
      const requestId = expected.rootEntries.find((name) => name.startsWith('task-'))?.slice(5)
        || expected.rootEntries[0]?.slice('recovery-'.length, -'.json'.length)
        || `60111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
      const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
      const resultWire = await runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({ requestId }),
        replayStore,
        afterCleanupStep(step) {
          if (step === expected.step) throw new Error(`synthetic crash after ${step}`);
        },
      }));
      const result = parseAndVerifyScanResult(resultWire, {
        request: parseAndVerifyScanRequest(requestWire({ requestId }), { keyResolver, now }),
        keyResolver,
        now,
      });
      assert.equal(result.cleanupStatus, 'retained');
      assert.equal(result.outcome, 'ambiguous');
      assert.deepEqual((await fsp.readdir(root)).sort(), expected.rootEntries);
      if (expected.taskEntries) {
        assert.deepEqual((await fsp.readdir(path.join(root, `task-${requestId}`))).sort(),
          expected.taskEntries);
      }

      const recoveryAt = new Date('2026-10-03T12:03:01.000Z');
      const successorId = `6${index}111111-1111-4111-8111-111111111111`;
      const successorWire = requestWire({
        requestId: successorId,
        issuedAt: recoveryAt.toISOString(),
        expiresAt: '2026-10-03T12:05:00.000Z',
        leaseExpiresAt: '2026-10-03T12:06:00.000Z',
      });
      await runOnDemandScanTask(workerOptions(root, {
        requestWire: successorWire,
        replayStore: createSyntheticReplayStore({ now: () => new Date(recoveryAt) }),
        now: () => new Date(recoveryAt),
      }));
      assert.deepEqual(await fsp.readdir(root), [],
        `startup recovery must finish the ${expected.step} state`);
    }
  });

test('unexpired transitional recovery state is fenced and left byte-for-byte intact', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-recovery-live-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const requestId = '65111111-1111-4111-8111-111111111111';
  await runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({ requestId }),
    afterCleanupStep(step) {
      if (step === 'recovery_marker_linked') throw new Error('synthetic live-owner stop');
    },
  }));
  const before = {};
  for (const name of (await fsp.readdir(root)).sort()) {
    const candidate = path.join(root, name);
    before[name] = (await fsp.lstat(candidate)).isDirectory()
      ? (await fsp.readdir(candidate)).sort()
      : await fsp.readFile(candidate, 'utf8');
  }
  let opened = 0;
  await assert.rejects(runOnDemandScanTask(workerOptions(root, {
    requestWire: requestWire({ requestId: '66111111-1111-4111-8111-111111111111' }),
    replayStore: createSyntheticReplayStore({ now: () => new Date(now) }),
    openByteStream() { opened += 1; return byteStream(); },
  })), /unexpired|in-flight/i);
  assert.equal(opened, 0);
  const after = {};
  for (const name of (await fsp.readdir(root)).sort()) {
    const candidate = path.join(root, name);
    after[name] = (await fsp.lstat(candidate)).isDirectory()
      ? (await fsp.readdir(candidate)).sort()
      : await fsp.readFile(candidate, 'utf8');
  }
  assert.deepEqual(after, before);
});

test('timed-out cleanup failure at every retained transition is typed and restart-recoverable',
  async (t) => {
    const cases = [
      ['recovery_marker_linked', '6b111111-1111-4111-8111-111111111111'],
      ['attachment_unlinked', '6c111111-1111-4111-8111-111111111111'],
      ['owner_marker_unlinked', '6d111111-1111-4111-8111-111111111111'],
      ['task_directory_removed', '6e111111-1111-4111-8111-111111111111'],
    ];
    for (const [index, [stepToStop, requestId]] of cases.entries()) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-timeout-recovery-'));
      t.after(() => fsp.rm(root, { recursive: true, force: true }));
      const replayStore = createSyntheticReplayStore({ now: () => new Date(now) });
      const slowBytes = new Readable({
        read() {
          if (this.pushed) return;
          this.pushed = true;
          this.push(bytes.subarray(0, 1));
        },
      });
      await assert.rejects(runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({ requestId, maxDurationMs: 35 }),
        replayStore,
        openByteStream: () => slowBytes,
        afterCleanupStep(step) {
          if (step === stepToStop) throw new Error(`synthetic timeout stop after ${step}`);
        },
      })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
      assert.equal([...replayStore.entries.values()][0].resultWire, null,
        'cleanup uncertainty must never complete replay authority');
      assert.ok((await fsp.readdir(root)).some((name) => name.startsWith('recovery-')),
        'every nonempty timeout transition must retain authenticated recovery authority');

      const recoveryAt = new Date('2026-10-03T12:03:01.000Z');
      await runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({
          requestId: `7${index}111111-1111-4111-8111-111111111111`,
          issuedAt: recoveryAt.toISOString(),
          expiresAt: '2026-10-03T12:05:00.000Z',
          leaseExpiresAt: '2026-10-03T12:06:00.000Z',
        }),
        replayStore: createSyntheticReplayStore({ now: () => new Date(recoveryAt) }),
        now: () => new Date(recoveryAt),
      }));
      assert.deepEqual(await fsp.readdir(root), []);
    }
  });

test('startup orphan sweep settles its current step and fails cleanup-uncertain at work deadline',
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-sweep-timeout-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const orphanId = '6f111111-1111-4111-8111-111111111111';
    await assert.rejects(runOnDemandScanTask(workerOptions(root, {
      requestWire: requestWire({ requestId: orphanId }),
      afterCopy() { throw new Error('synthetic abrupt process stop'); },
    })), /synthetic abrupt process stop/);
    assert.deepEqual((await fsp.readdir(path.join(root, `task-${orphanId}`))).sort(),
      ['attachment.bin', 'owner.json']);

    const recoveryAt = new Date('2026-10-03T12:03:01.000Z');
    const replayStore = createSyntheticReplayStore({ now: () => new Date(recoveryAt) });
    let cleanupStepSettled = false;
    const startedAt = performance.now();
    await assert.rejects(runOnDemandScanTask(workerOptions(root, {
      requestWire: requestWire({
        requestId: '6a211111-1111-4111-8111-111111111111',
        issuedAt: recoveryAt.toISOString(),
        expiresAt: '2026-10-03T12:05:00.000Z',
        leaseExpiresAt: '2026-10-03T12:06:00.000Z',
        maxDurationMs: 30,
      }),
      replayStore,
      now: () => new Date(recoveryAt),
      async afterCleanupStep(step) {
        if (step !== 'recovery_marker_linked') return;
        await new Promise((resolve) => setTimeout(resolve, 90));
        cleanupStepSettled = true;
      },
    })), (error) => error?.code === 'CIM_SCAN_CLEANUP_UNCERTAIN');
    assert.equal(cleanupStepSettled, true,
      'admission must remain held until the in-flight recovery step settles');
    assert.ok(performance.now() - startedAt >= 80,
      'startup sweep timeout must await its current step without starting a cleanup reserve');
    assert.equal([...replayStore.entries.values()][0].resultWire, null);
    assert.deepEqual((await fsp.readdir(root)).sort(), [
      `recovery-${orphanId}.json`,
      `task-${orphanId}`,
    ]);

    await runOnDemandScanTask(workerOptions(root, {
      requestWire: requestWire({
        requestId: '6a311111-1111-4111-8111-111111111111',
        issuedAt: recoveryAt.toISOString(),
        expiresAt: '2026-10-03T12:05:00.000Z',
        leaseExpiresAt: '2026-10-03T12:06:00.000Z',
      }),
      replayStore: createSyntheticReplayStore({ now: () => new Date(recoveryAt) }),
      now: () => new Date(recoveryAt),
    }));
    assert.deepEqual(await fsp.readdir(root), []);
  });

test('conflicting and symlinked recovery markers fail closed without deleting either authority',
  async (t) => {
    for (const variant of ['conflict', 'symlink']) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ug-cim-worker-recovery-${variant}-`));
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-recovery-target-'));
      t.after(() => Promise.all([
        fsp.rm(root, { recursive: true, force: true }),
        fsp.rm(outside, { recursive: true, force: true }),
      ]));
      const requestId = variant === 'conflict'
        ? '67111111-1111-4111-8111-111111111111'
        : '68111111-1111-4111-8111-111111111111';
      await runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({ requestId }),
        afterCleanupStep(step) {
          if (step === 'recovery_marker_linked') throw new Error('synthetic transition stop');
        },
      }));
      const taskPath = path.join(root, `task-${requestId}`);
      const ownerPath = path.join(taskPath, 'owner.json');
      const recoveryPath = path.join(root, `recovery-${requestId}.json`);
      if (variant === 'conflict') {
        await fsp.unlink(recoveryPath);
        await fsp.writeFile(recoveryPath, '{"conflicting":true}', { mode: 0o600, flag: 'wx' });
      } else {
        const target = path.join(outside, 'must-remain');
        await fsp.writeFile(target, await fsp.readFile(ownerPath), { mode: 0o600 });
        await fsp.unlink(recoveryPath);
        await fsp.symlink(target, recoveryPath);
      }
      const recoveryAt = new Date('2026-10-03T12:03:01.000Z');
      await assert.rejects(runOnDemandScanTask(workerOptions(root, {
        requestWire: requestWire({
          requestId: variant === 'conflict'
            ? '69111111-1111-4111-8111-111111111111'
            : '6a111111-1111-4111-8111-111111111111',
          issuedAt: recoveryAt.toISOString(),
          expiresAt: '2026-10-03T12:05:00.000Z',
          leaseExpiresAt: '2026-10-03T12:06:00.000Z',
        }),
        replayStore: createSyntheticReplayStore({ now: () => new Date(recoveryAt) }),
        now: () => new Date(recoveryAt),
      })), /orphan|authentic|recovery/i);
      assert.equal((await fsp.lstat(taskPath)).isDirectory(), true);
      assert.equal((await fsp.lstat(ownerPath)).isFile(), true);
      assert.equal(variant === 'symlink'
        ? (await fsp.lstat(recoveryPath)).isSymbolicLink()
        : (await fsp.lstat(recoveryPath)).isFile(), true);
    }
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
