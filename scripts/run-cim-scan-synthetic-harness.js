#!/usr/bin/env node
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createSignedScanRequest,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from '../server/services/cimScanProtocol.js';
import { runOnDemandScanTask } from '../server/services/cimScanWorker.js';
import { createFilesystemCimReplayStore } from '../server/services/filesystemCimReplayStore.js';
import { createFlyMachineScanTransport } from '../server/services/flyMachineScanTransport.js';

const key = Buffer.from('synthetic-p8-04-protocol-harness-key');
const keyId = 'synthetic-key-1';
const keyResolver = (candidate) => candidate === keyId ? key : null;
const baseTime = new Date('2026-10-03T12:00:00.000Z');
const freshHealth = Object.freeze({
  healthy: true,
  daemonId: 'unix-socket:synthetic-generation-1',
  engineVersion: '1.synthetic',
  signatureVersion: 'synthetic-signatures-1',
  signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
});

function uuid(index) {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

function makeRequest({ index, bytes, now = baseTime, overrides = {} }) {
  const issuedAt = new Date(now);
  const input = {
    requestId: uuid(index),
    intakeId: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`,
    attempt: 1,
    jobOwner: 'synthetic-harness',
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 3 * 60_000).toISOString(),
    leaseExpiresAt: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mimeType: 'application/pdf',
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 90_000,
    keyId,
    ...overrides,
  };
  const wire = createSignedScanRequest(input, { keyResolver });
  return { wire, request: parseAndVerifyScanRequest(wire, { keyResolver, now: issuedAt }) };
}

function admission() {
  let owner = null;
  return {
    async acquire(requestId) {
      if (owner) return null;
      owner = requestId;
      return () => { if (owner === requestId) owner = null; };
    },
  };
}

function scanner({ outcome = 'clean', health = freshHealth } = {}) {
  return {
    async health() { return health; },
    async scan({ byteStream }) {
      for await (const _chunk of byteStream) { /* synthetic protocol consumption only */ }
      return {
        outcome,
        reasonCode: outcome === 'unsafe' ? 'malware_found' : 'clean',
        daemonId: health.daemonId,
      };
    },
  };
}

async function tempRoots(label) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), `ug-cim-harness-${label}-`));
  const ephemeralRoot = path.join(parent, 'tasks');
  const replayRoot = path.join(parent, 'replay');
  await fsp.mkdir(ephemeralRoot, { mode: 0o700 });
  return { parent, ephemeralRoot, replayRoot };
}

async function runWorker({ roots, request, bytes, clock = () => new Date(baseTime), workerScanner = scanner(), replayStore, onOpen }) {
  const resultWire = await runOnDemandScanTask({
    requestWire: request.wire,
    openByteStream() {
      onOpen?.();
      return Readable.from([bytes]);
    },
    keyResolver,
    replayStore: replayStore || createFilesystemCimReplayStore({ root: roots.replayRoot, now: clock }),
    admission: admission(),
    ephemeralRoot: roots.ephemeralRoot,
    scanner: workerScanner,
    now: clock,
  });
  return parseAndVerifyScanResult(resultWire, {
    request: request.request,
    keyResolver,
    now: clock(),
  });
}

async function cleanCase(name, size, index) {
  const roots = await tempRoots(name);
  try {
    const bytes = Buffer.alloc(size, index);
    const request = makeRequest({ index, bytes });
    const result = await runWorker({ roots, request, bytes });
    assert.equal(result.outcome, 'clean');
    assert.equal(result.cleanupStatus, 'cleaned');
    assert.deepEqual(await fsp.readdir(roots.ephemeralRoot), []);
    return { name, passed: true, outcome: result.outcome, bytes: size };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

async function fakeEicarCase() {
  const name = 'fake-eicar-verdict';
  const roots = await tempRoots(name);
  try {
    const bytes = Buffer.from('synthetic harmless bytes; no antivirus signature fixture');
    const request = makeRequest({ index: 3, bytes });
    const result = await runWorker({ roots, request, bytes, workerScanner: scanner({ outcome: 'unsafe' }) });
    assert.equal(result.outcome, 'unsafe');
    return { name, passed: true, outcome: result.outcome, scanner: 'synthetic-verdict-only' };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

async function staleSignatureCase() {
  const name = 'stale-signatures';
  const roots = await tempRoots(name);
  try {
    const bytes = Buffer.alloc(1024, 4);
    const request = makeRequest({ index: 4, bytes });
    let opened = 0;
    const result = await runWorker({
      roots, request, bytes, onOpen: () => { opened += 1; },
      workerScanner: scanner({
        health: { ...freshHealth, signatureUpdatedAt: '2026-09-30T00:00:00.000Z' },
      }),
    });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.reasonCode, 'stale_signatures');
    assert.equal(opened, 0);
    return { name, passed: true, outcome: result.outcome, bodyOpenCount: opened };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

async function mismatchCase() {
  const name = 'hash-and-size-mismatch';
  const roots = await tempRoots(name);
  try {
    const expected = Buffer.alloc(1024, 5);
    const hashRequest = makeRequest({ index: 5, bytes: expected });
    const hashResult = await runWorker({ roots, request: hashRequest, bytes: Buffer.alloc(1024, 6) });
    const sizeRequest = makeRequest({ index: 6, bytes: expected });
    const sizeResult = await runWorker({ roots, request: sizeRequest, bytes: expected.subarray(1) });
    assert.equal(hashResult.reasonCode, 'attachment_identity_mismatch');
    assert.equal(sizeResult.reasonCode, 'attachment_identity_mismatch');
    return { name, passed: true, outcome: 'ambiguous', checks: ['hash', 'size'] };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

async function replayCase() {
  const name = 'replay-duplicate-and-conflict-without-body-reopen';
  const roots = await tempRoots(name);
  try {
    const bytes = Buffer.alloc(1024, 7);
    const request = makeRequest({ index: 7, bytes });
    const replayStore = createFilesystemCimReplayStore({
      root: roots.replayRoot, now: () => new Date(baseTime),
    });
    let bodyOpenCount = 0;
    await runWorker({ roots, request, bytes, replayStore, onOpen: () => { bodyOpenCount += 1; } });
    await runWorker({ roots, request, bytes, replayStore, onOpen: () => { bodyOpenCount += 1; } });
    const conflictBytes = Buffer.alloc(1024, 8);
    const conflict = makeRequest({ index: 7, bytes: conflictBytes });
    let conflictOpenedBody = false;
    await assert.rejects(runWorker({
      roots, request: conflict, bytes: conflictBytes, replayStore,
      onOpen: () => { conflictOpenedBody = true; },
    }), /conflict/i);
    assert.equal(bodyOpenCount, 1);
    assert.equal(conflictOpenedBody, false);
    return { name, passed: true, outcome: 'replay-and-conflict', bodyOpenCount, conflictOpenedBody };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

async function timeoutCleanupAndStopCase() {
  const name = 'timeout-task-copy-cleanup-and-owned-stop';
  const roots = await tempRoots(name);
  try {
    let clock = new Date(baseTime);
    const bytes = Buffer.alloc(1024, 9);
    const timedRequest = makeRequest({
      index: 9,
      bytes,
      now: clock,
      overrides: {
        expiresAt: new Date(clock.getTime() + 60).toISOString(),
        leaseExpiresAt: new Date(clock.getTime() + 80).toISOString(),
        maxDurationMs: 40,
      },
    });
    let timer;
    await assert.rejects(runOnDemandScanTask({
      requestWire: timedRequest.wire,
      openByteStream: () => new Readable({
        read() {
          if (timer) return;
          this.push(bytes.subarray(0, 1));
          timer = setTimeout(() => { this.push(bytes.subarray(1)); this.push(null); }, 250);
        },
        destroy(error, callback) { clearTimeout(timer); callback(error); },
      }),
      keyResolver,
      replayStore: createFilesystemCimReplayStore({ root: roots.replayRoot, now: () => clock }),
      admission: admission(),
      ephemeralRoot: roots.ephemeralRoot,
      scanner: scanner(),
      now: () => clock,
    }), /deadline/i);
    assert.equal((await fsp.readdir(roots.ephemeralRoot)).length, 1);

    clock = new Date(baseTime.getTime() + 1_000);
    const recoveryBytes = Buffer.alloc(1024, 10);
    const recovery = makeRequest({ index: 10, bytes: recoveryBytes, now: clock });
    const recovered = await runWorker({
      roots, request: recovery, bytes: recoveryBytes, clock: () => clock,
      replayStore: createFilesystemCimReplayStore({ root: roots.replayRoot, now: () => clock }),
    });
    assert.equal(recovered.outcome, 'clean');
    assert.deepEqual(await fsp.readdir(roots.ephemeralRoot), []);

    let owner = 'transport-request';
    let stopCount = 0;
    const transport = createFlyMachineScanTransport({
      machineId: 'synthetic-machine-1',
      machineController: {
        async acquireStoppedSession() { return { initialState: 'stopped', providerGeneration: 'provider-1' }; },
        async startSession() {},
        async ownsSession({ sessionGeneration }) { return owner === sessionGeneration; },
        async stopSessionIfOwned({ sessionGeneration }) {
          if (owner !== sessionGeneration) return false;
          owner = null;
          stopCount += 1;
          return true;
        },
      },
      requestClient: { async authorize() { return new Promise(() => {}); } },
    });
    await assert.rejects(transport.run({
      requestWire: '{}',
      requestId: 'transport-request',
      leaseExpiresAt: new Date(Date.now() + 80).toISOString(),
      openByteStream: () => Readable.from([Buffer.from('x')]),
    }), /deadline/i);
    assert.equal(stopCount, 1);
    return { name, passed: true, outcome: 'failed-closed', orphanCleaned: true, ownedStopCount: stopCount };
  } finally {
    await fsp.rm(roots.parent, { recursive: true, force: true });
  }
}

export async function runSyntheticCimScannerHarness() {
  const cases = [];
  cases.push(await cleanCase('clean-1-kib', 1024, 1));
  cases.push(await cleanCase('clean-8-mib', 8 * 1024 * 1024, 2));
  cases.push(await fakeEicarCase());
  cases.push(await staleSignatureCase());
  cases.push(await mismatchCase());
  cases.push(await replayCase());
  cases.push(await timeoutCleanupAndStopCase());
  return Object.freeze({
    protocolOnly: true,
    realEicarDetectionClaimed: false,
    cases: Object.freeze(cases),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSyntheticCimScannerHarness()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(() => {
      process.stderr.write('Synthetic CIM scanner harness failed.\n');
      process.exitCode = 1;
    });
}
