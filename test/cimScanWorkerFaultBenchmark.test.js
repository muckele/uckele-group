import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CIM_SCAN_WORKER_FAULT_MODES,
  createCimScanWorkerFaultBenchmarkRunTask,
} from '../server/services/cimScanWorkerFaultBenchmark.js';
import { runCimScanWorkerFaultBenchmarkEntrypoint } from '../server/services/cimScanWorkerFaultBenchmarkEntrypoint.js';
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

const key = Buffer.from('synthetic-fault-benchmark-key-material');
const keyResolver = (keyId) => keyId === 'fault-key-1' ? key : null;
const bytes = Buffer.from('%PDF-1.7 fault benchmark fixture');

function signedRequest({
  requestId,
  intakeId,
  issuedAt,
  expiresAt,
  leaseExpiresAt,
} = {}) {
  return createSignedScanRequest({
    requestId,
    intakeId,
    attempt: 1,
    jobOwner: 'fault-benchmark',
    issuedAt,
    expiresAt,
    leaseExpiresAt,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mimeType: 'application/pdf',
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 90_000,
    keyId: 'fault-key-1',
  }, { keyResolver });
}

function stream() {
  return Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
}

function taskOptions({ root, requestWire, replayStore, scanner, clock }) {
  return {
    requestWire,
    openByteStream: stream,
    keyResolver,
    replayStore,
    admission: createSyntheticAdmission(),
    ephemeralRoot: root,
    scanner,
    now: () => new Date(clock.value),
  };
}

async function recoverExpiredOrphan({ root, replayStore, clock, suffix }) {
  clock.value = '2026-10-03T12:01:01.000Z';
  const wire = signedRequest({
    requestId: `9${suffix}111111-1111-4111-8111-111111111111`,
    intakeId: `8${suffix}222222-2222-4222-8222-222222222222`,
    issuedAt: clock.value,
    expiresAt: '2026-10-03T12:04:01.000Z',
    leaseExpiresAt: '2026-10-03T12:05:01.000Z',
  });
  const resultWire = await runOnDemandScanTask(taskOptions({
    root,
    requestWire: wire,
    replayStore,
    scanner: createSyntheticWorkerScanner({
      preHealth: {
        healthy: true,
        daemonId: 'ClamAV recovery-daemon',
        engineVersion: '1.synthetic',
        signatureVersion: 'recovery-db',
        signatureUpdatedAt: '2026-10-03T12:00:00.000Z',
      },
    }),
    clock,
  }));
  const request = parseAndVerifyScanRequest(wire, { keyResolver, now: new Date(clock.value) });
  const result = parseAndVerifyScanResult(resultWire, {
    request, keyResolver, now: new Date(clock.value),
  });
  assert.equal(result.outcome, 'clean');
  assert.deepEqual(await fsp.readdir(root), []);
}

test('fault benchmark exposes only the three approved immutable modes', () => {
  assert.deepEqual(CIM_SCAN_WORKER_FAULT_MODES, [
    'after-copy-crash',
    'after-scan-crash',
    'cleanup-refusal',
  ]);
  assert.equal(Object.isFrozen(CIM_SCAN_WORKER_FAULT_MODES), true);
});

for (const [mode, expectedScans, suffix] of [
  ['after-copy-crash', 0, '1'],
  ['after-scan-crash', 1, '2'],
]) {
  test(`${mode} exits without a result and recovery cleans only the expired owned orphan`, async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ug-cim-${mode}-`));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const clock = { value: '2026-10-03T12:00:00.000Z' };
    const replayStore = createSyntheticReplayStore({ now: () => new Date(clock.value) });
    const scanner = createSyntheticWorkerScanner();
    const abruptExit = new Error(`${mode} process exited`);
    const requestWire = signedRequest({
      requestId: `7${suffix}111111-1111-4111-8111-111111111111`,
      intakeId: `6${suffix}222222-2222-4222-8222-222222222222`,
      issuedAt: clock.value,
      expiresAt: '2026-10-03T12:01:00.000Z',
      leaseExpiresAt: '2026-10-03T12:01:00.000Z',
    });
    const runTask = createCimScanWorkerFaultBenchmarkRunTask({
      mode,
      terminateProcess() { throw abruptExit; },
    });

    await assert.rejects(runTask(taskOptions({
      root, requestWire, replayStore, scanner, clock,
    })), (error) => error === abruptExit);

    assert.equal(scanner.scanCount, expectedScans);
    assert.equal([...replayStore.entries.values()][0].resultWire, null);
    const [taskName] = await fsp.readdir(root);
    assert.match(taskName, /^task-/);
    assert.deepEqual((await fsp.readdir(path.join(root, taskName))).sort(), [
      'attachment.bin', 'owner.json',
    ]);

    clock.value = '2026-10-03T12:00:59.000Z';
    const blockedWire = signedRequest({
      requestId: `5${suffix}111111-1111-4111-8111-111111111111`,
      intakeId: `4${suffix}222222-2222-4222-8222-222222222222`,
      issuedAt: clock.value,
      expiresAt: '2026-10-03T12:03:59.000Z',
      leaseExpiresAt: '2026-10-03T12:04:59.000Z',
    });
    await assert.rejects(runOnDemandScanTask(taskOptions({
      root,
      requestWire: blockedWire,
      replayStore,
      scanner: createSyntheticWorkerScanner(),
      clock,
    })), /unexpired.*orphan/i);

    await recoverExpiredOrphan({ root, replayStore, clock, suffix });
  });
}

test('cleanup-refusal emits no clean authority and expiry recovery removes the retained owned copy', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-cleanup-refusal-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const clock = { value: '2026-10-03T12:00:00.000Z' };
  const replayStore = createSyntheticReplayStore({ now: () => new Date(clock.value) });
  const requestWire = signedRequest({
    requestId: '73111111-1111-4111-8111-111111111111',
    intakeId: '63222222-2222-4222-8222-222222222222',
    issuedAt: clock.value,
    expiresAt: '2026-10-03T12:01:00.000Z',
    leaseExpiresAt: '2026-10-03T12:01:00.000Z',
  });
  const runTask = createCimScanWorkerFaultBenchmarkRunTask({ mode: 'cleanup-refusal' });
  const resultWire = await runTask(taskOptions({
    root,
    requestWire,
    replayStore,
    scanner: createSyntheticWorkerScanner(),
    clock,
  }));
  const request = parseAndVerifyScanRequest(requestWire, { keyResolver, now: new Date(clock.value) });
  const result = parseAndVerifyScanResult(resultWire, {
    request, keyResolver, now: new Date(clock.value),
  });
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.reasonCode, 'cleanup_uncertain');
  assert.equal(result.cleanupStatus, 'retained');
  assert.notEqual(result.outcome, 'clean');
  assert.equal(JSON.parse([...replayStore.entries.values()][0].resultWire).outcome, 'ambiguous');
  assert.equal((await fsp.readdir(root)).length, 1);

  await recoverExpiredOrphan({ root, replayStore, clock, suffix: '3' });
});

test('fault runner rejects unknown modes and never accepts an environment or request selector', () => {
  assert.throws(() => createCimScanWorkerFaultBenchmarkRunTask({ mode: 'request-selected' }),
    /fault mode/i);
  assert.throws(() => createCimScanWorkerFaultBenchmarkRunTask({
    mode: 'after-copy-crash', terminateProcess: 'SIGKILL',
  }), /terminator/i);
});

test('fault entrypoint constructs an inert HTTP runtime with only its hard-coded task runner', async () => {
  const runtime = Object.freeze({ start() {}, close() {} });
  let runtimeOptions;
  const returned = await runCimScanWorkerFaultBenchmarkEntrypoint({
    mode: 'cleanup-refusal',
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    async createRuntime(options) { runtimeOptions = options; return runtime; },
  });
  assert.equal(returned, runtime);
  assert.equal(typeof runtimeOptions.now, 'function');
  const composition = runtimeOptions.createWorkerComposition({
    keyResolver,
    replayStore: createSyntheticReplayStore(),
    ephemeralRoot: '/tmp/inert-fault-entrypoint-test',
    scanner: createSyntheticWorkerScanner(),
    now: runtimeOptions.now,
    signatureNow: runtimeOptions.now,
  });
  assert.equal(typeof composition.handleCheckContinue, 'function');
});
