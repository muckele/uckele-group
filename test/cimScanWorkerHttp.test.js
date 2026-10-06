import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import {
  CIM_SCAN_PROTOCOL_LIMITS,
  createSignedScanRequest,
  createSignedScanResult,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from '../server/services/cimScanProtocol.js';
import { createCimScanWorkerHttpComposition } from '../server/services/cimScanComposition.js';
import { createCimScanWorkerCheckContinueHandler } from '../server/services/cimScanWorkerHttp.js';
import { createSingleCimScanAdmission } from '../server/services/cimScanWorkerAdmission.js';
import { runOnDemandScanTask } from '../server/services/cimScanWorker.js';
import {
  createPinnedHttpScanRequestClient,
  isScannerReplayConflictError,
} from '../server/services/flyMachineOperabilityAdapters.js';
import {
  createSyntheticReplayStore,
  createSyntheticWorkerScanner,
} from './support/cimScanFixtures.js';

const key = Buffer.from('synthetic-p8-07-worker-http-key-material');
const keyResolver = (keyId) => keyId === 'test-key-1' ? key : null;
const attachment = Buffer.from('%PDF-1.7 synthetic HTTP endpoint fixture');

function signedRequest(overrides = {}) {
  return createSignedScanRequest({
    requestId: '91111111-1111-4111-8111-111111111111',
    intakeId: '92222222-2222-4222-8222-222222222222',
    attempt: 1,
    jobOwner: 'synthetic-app-1',
    issuedAt: '2026-10-03T12:00:00.000Z',
    expiresAt: '2026-10-03T12:03:00.000Z',
    leaseExpiresAt: '2026-10-03T12:04:00.000Z',
    sha256: createHash('sha256').update(attachment).digest('hex'),
    sizeBytes: attachment.length,
    mimeType: 'application/pdf',
    maxBytes: CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes,
    maxDurationMs: 90_000,
    keyId: 'test-key-1',
    ...overrides,
  }, { keyResolver });
}

function fakeRequest(requestWire, bytes = attachment, overrides = {}) {
  let reads = 0;
  const request = Readable.from((async function* body() {
    reads += 1;
    yield bytes;
  }()));
  request.method = overrides.method || 'POST';
  request.url = overrides.url || '/v1/cim-scan';
  request.headers = {
    expect: '100-continue',
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    'x-cim-scan-request': Buffer.from(requestWire, 'utf8').toString('base64url'),
    ...overrides.headers,
  };
  return { request, reads: () => reads };
}

function stalledFakeRequest(requestWire) {
  let reads = 0;
  let sent = false;
  const request = new Readable({
    read() {
      if (sent) return;
      sent = true;
      reads += 1;
      this.push(attachment.subarray(0, 1));
    },
  });
  request.method = 'POST';
  request.url = '/v1/cim-scan';
  request.headers = {
    expect: '100-continue',
    'content-type': 'application/octet-stream',
    'content-length': String(attachment.length),
    'x-cim-scan-request': Buffer.from(requestWire, 'utf8').toString('base64url'),
  };
  return { request, reads: () => reads };
}

function fakeResponse() {
  const events = [];
  let status = null;
  let headers = null;
  let body = Buffer.alloc(0);
  const finishListeners = [];
  return {
    response: {
      once(event, callback) { if (event === 'finish') finishListeners.push(callback); },
      writeContinue() { events.push('continue'); },
      writeHead(value, values) { status = value; headers = values; events.push(`status:${value}`); },
      end(value = Buffer.alloc(0)) {
        body = Buffer.from(value);
        events.push('end');
        for (const listener of finishListeners.splice(0)) listener();
      },
    },
    events,
    result: () => ({ status, headers, body: body.toString('utf8') }),
  };
}

async function withWorker(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-http-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let clock = new Date('2026-10-03T12:00:00.000Z');
  const now = () => new Date(clock);
  const replayStore = overrides.replayStore || createSyntheticReplayStore({ now });
  const composition = createCimScanWorkerHttpComposition({
    keyResolver,
    replayStore,
    ephemeralRoot: root,
    scanner: overrides.scanner || createSyntheticWorkerScanner(),
    now,
  });
  return {
    ...composition,
    root,
    replayStore,
    now,
    setClock(value) { clock = new Date(value); },
  };
}

function fakeOpenExchange(handler) {
  return async function openExchange(command) {
    const request = new PassThrough();
    const endpoint = new URL(command.endpoint);
    request.method = command.method;
    request.url = `${endpoint.pathname}${endpoint.search}`;
    request.headers = command.headers;
    let admissionSettled = false;
    let resolveAdmission;
    let resolveFinal;
    const admission = new Promise((resolve) => { resolveAdmission = resolve; });
    const final = new Promise((resolve) => { resolveFinal = resolve; });
    const earlyBody = {
      async *[Symbol.asyncIterator]() {
        const completed = await final;
        yield completed.body;
      },
    };
    let status;
    const response = {
      writeContinue() {
        admissionSettled = true;
        resolveAdmission({ status: 100 });
      },
      writeHead(value) {
        status = value;
        if (!admissionSettled) {
          admissionSettled = true;
          resolveAdmission({ status, body: earlyBody });
        }
      },
      end(value = Buffer.alloc(0)) {
        resolveFinal({ status, body: Buffer.from(value) });
      },
      destroy() { request.destroy(); },
    };
    void handler(request, response);
    return {
      async awaitAdmission() { return admission; },
      async write(chunk) { request.write(chunk); },
      async finish() {
        request.end();
        const completed = await final;
        return { status: completed.status, body: [completed.body] };
      },
      abort(error) { request.destroy(error); },
    };
  };
}

test('fake HTTP worker admits a new job, consumes exact bytes, and returns a verified signed result', async (t) => {
  const worker = await withWorker(t);
  const wire = signedRequest();
  const input = fakeRequest(wire);
  const output = fakeResponse();

  await worker.handleCheckContinue(input.request, output.response);

  assert.deepEqual(output.events, ['continue', 'status:200', 'end']);
  assert.equal(input.reads(), 1);
  assert.equal(output.result().headers['cache-control'], 'no-store');
  const request = parseAndVerifyScanRequest(wire, { keyResolver, now: worker.now() });
  const result = parseAndVerifyScanResult(output.result().body, {
    request, keyResolver, now: worker.now(),
  });
  assert.equal(result.outcome, 'clean');
  assert.equal(result.requestDigest, request.requestDigest);
});

test('completed replay returns an early verified 200 without continuing or reading attachment bytes', async (t) => {
  const worker = await withWorker(t);
  const wire = signedRequest();
  const firstInput = fakeRequest(wire);
  const firstOutput = fakeResponse();
  await worker.handleCheckContinue(firstInput.request, firstOutput.response);
  assert.equal(firstOutput.result().status, 200);

  const replayInput = fakeRequest(wire, Buffer.from('must never be read'));
  replayInput.request.headers['content-length'] = String(attachment.length);
  const replayOutput = fakeResponse();
  await worker.handleCheckContinue(replayInput.request, replayOutput.response);

  assert.deepEqual(replayOutput.events, ['status:200', 'end']);
  assert.equal(replayInput.reads(), 0);
  assert.equal(replayOutput.result().body, firstOutput.result().body);
});

test('fake client-to-handler exchange uploads a new job and reuses only its early verified replay', async (t) => {
  const worker = await withWorker(t);
  const client = createPinnedHttpScanRequestClient({
    endpoint: 'https://machine-1.vm.ug-scanner.internal/v1/cim-scan',
    certificatePinSha256: 'a'.repeat(64),
    openExchange: fakeOpenExchange(worker.handleCheckContinue),
  });
  const wire = signedRequest();
  let opened = 0;
  const run = async () => {
    const controller = new AbortController();
    const upload = await client.authorize({
      requestWire: wire,
      redirects: 'error',
      maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
      signal: controller.signal,
      deadlineAt: performance.now() + 1_000,
    });
    return upload.sendBody({
      openByteStream() {
        opened += 1;
        return Readable.from([attachment]);
      },
      maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
      signal: controller.signal,
      deadlineAt: performance.now() + 1_000,
    });
  };

  const first = await run();
  const replay = await run();
  assert.equal(replay, first);
  assert.equal(opened, 1);
  const conflictController = new AbortController();
  await assert.rejects(client.authorize({
    requestWire: signedRequest({ sha256: 'f'.repeat(64) }),
    redirects: 'error',
    maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
    signal: conflictController.signal,
    deadlineAt: performance.now() + 1_000,
  }), isScannerReplayConflictError);
  assert.equal(opened, 1);
  const request = parseAndVerifyScanRequest(wire, { keyResolver, now: worker.now() });
  assert.equal(parseAndVerifyScanResult(replay, {
    request, keyResolver, now: worker.now(),
  }).outcome, 'clean');
});

test('new stale-signature job is continued and exact-byte checked before its signed unavailable result', async (t) => {
  const worker = await withWorker(t, {
    scanner: createSyntheticWorkerScanner({
      preHealth: {
        healthy: true,
        daemonId: 'ClamAV synthetic-daemon',
        engineVersion: '1.synthetic',
        signatureVersion: 'stale-db',
        signatureUpdatedAt: '2026-09-30T00:00:00.000Z',
      },
    }),
  });
  const wire = signedRequest();
  const input = fakeRequest(wire);
  const output = fakeResponse();

  await worker.handleCheckContinue(input.request, output.response);

  assert.deepEqual(output.events, ['continue', 'status:200', 'end']);
  assert.equal(input.reads(), 1);
  const request = parseAndVerifyScanRequest(wire, { keyResolver, now: worker.now() });
  const result = parseAndVerifyScanResult(output.result().body, {
    request, keyResolver, now: worker.now(),
  });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reasonCode, 'stale_signatures');
});

test('HTTP worker rejects tampered, wrong-target, oversized, malformed, and expired requests before bytes', async (t) => {
  const worker = await withWorker(t);
  const validWire = signedRequest();
  const cases = [
    ['tampered', validWire.replace('synthetic-app-1', 'synthetic-app-2'), {}],
    ['wrong path', validWire, { url: '/v1/not-cim-scan' }],
    ['wrong size', validWire, { headers: { 'content-length': String(attachment.length + 1) } }],
    ['oversized', validWire, {
      headers: { 'content-length': String(CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes + 1) },
    }],
    ['malformed', validWire, { headers: { 'x-cim-scan-request': '***' } }],
    ['expired', signedRequest({
      issuedAt: '2026-10-03T11:55:00.000Z',
      expiresAt: '2026-10-03T11:58:00.000Z',
      leaseExpiresAt: '2026-10-03T11:59:00.000Z',
    }), {}],
  ];
  for (const [label, wire, requestOverrides] of cases) {
    const input = fakeRequest(wire, attachment, requestOverrides);
    const output = fakeResponse();
    await worker.handleCheckContinue(input.request, output.response);
    assert.equal(output.result().status, 400, label);
    assert.equal(output.result().body, '', label);
    assert.equal(output.events.includes('continue'), false, label);
    assert.equal(input.reads(), 0, label);
  }
});

test('HTTP worker refuses tampered, conflicting, and expired cached authority without early clean', async (t) => {
  const worker = await withWorker(t);
  const wire = signedRequest();
  const firstOutput = fakeResponse();
  await worker.handleCheckContinue(fakeRequest(wire).request, firstOutput.response);
  assert.equal(firstOutput.result().status, 200);

  const [entry] = worker.replayStore.entries.values();
  const originalResult = entry.resultWire;
  entry.resultWire = originalResult.replace('"outcome":"clean"', '"outcome":"unsafe"');
  const tamperedInput = fakeRequest(wire);
  const tamperedOutput = fakeResponse();
  await worker.handleCheckContinue(tamperedInput.request, tamperedOutput.response);
  assert.equal(tamperedOutput.result().status, 400);
  assert.equal(tamperedOutput.events.includes('continue'), false);
  assert.equal(tamperedInput.reads(), 0);

  entry.resultWire = originalResult;
  const conflictingWire = signedRequest({
    sha256: 'f'.repeat(64),
  });
  const conflictInput = fakeRequest(conflictingWire);
  const conflictOutput = fakeResponse();
  await worker.handleCheckContinue(conflictInput.request, conflictOutput.response);
  assert.equal(conflictOutput.result().status, 409);
  assert.equal(conflictOutput.events.includes('continue'), false);
  assert.equal(conflictInput.reads(), 0);

  worker.setClock('2026-10-03T12:02:01.000Z');
  const expiredInput = fakeRequest(wire);
  const expiredOutput = fakeResponse();
  await worker.handleCheckContinue(expiredInput.request, expiredOutput.response);
  assert.equal(expiredOutput.result().status, 400);
  assert.equal(expiredOutput.events.includes('continue'), false);
  assert.equal(expiredInput.reads(), 0);
});

test('HTTP worker bounds admission timeout before continue and exposes no failure detail', async () => {
  const wire = signedRequest({ maxDurationMs: 20 });
  const input = fakeRequest(wire);
  const output = fakeResponse();
  const handler = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore: createSyntheticReplayStore({ now: () => new Date('2026-10-03T12:00:00.000Z') }),
    admission: { async acquire() { return new Promise(() => {}); } },
    ephemeralRoot: path.join(os.tmpdir(), 'unused-cim-worker-http-timeout'),
    scanner: createSyntheticWorkerScanner(),
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  });

  await handler(input.request, output.response);

  assert.equal(output.result().status, 400);
  assert.equal(output.result().body, '');
  assert.equal(output.events.includes('continue'), false);
  assert.equal(input.reads(), 0);
});

test('real worker timeout flushes bodyless 408 before closing its stalled request', async (t) => {
  const wire = signedRequest({ maxDurationMs: 20 });
  const input = stalledFakeRequest(wire);
  const output = fakeResponse();
  const worker = await withWorker(t);
  const closed = new Promise((resolve) => input.request.once('close', () => {
    assert.equal(output.events.at(-1), 'end');
    resolve();
  }));

  await worker.handleCheckContinue(input.request, output.response);
  await closed;

  assert.equal(output.result().status, 408);
  assert.equal(output.result().body, '');
  assert.equal(output.events.includes('continue'), true);
  assert.equal(input.reads(), 1);
  assert.deepEqual(await fsp.readdir(worker.root), []);
});

test('HTTP worker maps unproven timeout cleanup to bodyless 500 and retains owned state', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-http-uncertain-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const issuedAt = new Date();
  const now = () => new Date();
  const wire = signedRequest({
    requestId: '93111111-1111-4111-8111-111111111111',
    intakeId: '93222222-2222-4222-8222-222222222222',
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 160).toISOString(),
    leaseExpiresAt: new Date(issuedAt.getTime() + 1_000).toISOString(),
    maxDurationMs: 30,
  });
  const input = stalledFakeRequest(wire);
  const output = fakeResponse();
  const handler = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore: createSyntheticReplayStore({ now }),
    admission: createSingleCimScanAdmission(),
    ephemeralRoot: root,
    scanner: createSyntheticWorkerScanner(),
    now,
    runTask: (options) => runOnDemandScanTask({
      ...options,
      cleanupOwnedTask: async () => new Promise(() => {}),
    }),
  });

  await handler(input.request, output.response);

  assert.equal(output.result().status, 500);
  assert.equal(output.result().body, '');
  assert.equal(output.events.includes('continue'), true);
  assert.equal(input.reads(), 1);
  assert.equal((await fsp.readdir(root)).length, 1);
});

test('HTTP worker maps admitted startup-recovery deadline to bodyless 500 without opening bytes',
  async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-http-sweep-timeout-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    let clock = new Date('2026-10-03T12:00:00.000Z');
    const now = () => new Date(clock);
    const orphanWire = signedRequest({
      requestId: '95111111-1111-4111-8111-111111111111',
      intakeId: '95222222-2222-4222-8222-222222222222',
    });
    await assert.rejects(runOnDemandScanTask({
      requestWire: orphanWire,
      openByteStream: () => Readable.from([attachment]),
      keyResolver,
      replayStore: createSyntheticReplayStore({ now }),
      admission: createSingleCimScanAdmission(),
      ephemeralRoot: root,
      scanner: createSyntheticWorkerScanner(),
      now,
      afterCopy() { throw new Error('synthetic abrupt process stop'); },
    }), /synthetic abrupt process stop/);

    clock = new Date('2026-10-03T12:03:01.000Z');
    const replayStore = createSyntheticReplayStore({ now });
    const wire = signedRequest({
      requestId: '96111111-1111-4111-8111-111111111111',
      intakeId: '96222222-2222-4222-8222-222222222222',
      issuedAt: clock.toISOString(),
      expiresAt: '2026-10-03T12:05:00.000Z',
      leaseExpiresAt: '2026-10-03T12:06:00.000Z',
      maxDurationMs: 30,
    });
    const input = fakeRequest(wire);
    const output = fakeResponse();
    let cleanupStepSettled = false;
    const handler = createCimScanWorkerCheckContinueHandler({
      keyResolver,
      replayStore,
      admission: createSingleCimScanAdmission(),
      ephemeralRoot: root,
      scanner: createSyntheticWorkerScanner(),
      now,
      runTask: (options) => runOnDemandScanTask({
        ...options,
        async afterCleanupStep(step) {
          if (step !== 'recovery_marker_linked') return;
          await new Promise((resolve) => setTimeout(resolve, 90));
          cleanupStepSettled = true;
        },
      }),
    });

    await handler(input.request, output.response);

    assert.equal(output.result().status, 500);
    assert.equal(output.result().body, '');
    assert.equal(output.events.includes('continue'), true);
    assert.equal(input.reads(), 0);
    assert.equal(cleanupStepSettled, true);
    assert.equal([...replayStore.entries.values()][0].resultWire, null);
    assert.deepEqual((await fsp.readdir(root)).sort(), [
      'recovery-95111111-1111-4111-8111-111111111111.json',
      'task-95111111-1111-4111-8111-111111111111',
    ]);
  });

test('HTTP worker maps late post-admission task creation to bodyless 500', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-worker-http-late-create-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const wire = signedRequest({
    requestId: '94111111-1111-4111-8111-111111111111',
    intakeId: '94222222-2222-4222-8222-222222222222',
    maxDurationMs: 25,
  });
  const input = fakeRequest(wire);
  const output = fakeResponse();
  const handler = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore: createSyntheticReplayStore({
      now: () => new Date('2026-10-03T12:00:00.000Z'),
    }),
    admission: createSingleCimScanAdmission(),
    ephemeralRoot: root,
    scanner: createSyntheticWorkerScanner(),
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    runTask: (options) => runOnDemandScanTask({
      ...options,
      createTaskDirectory: async (taskPath) => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        await fsp.mkdir(taskPath, { mode: 0o700 });
      },
    }),
  });

  await handler(input.request, output.response);
  assert.equal(output.result().status, 500);
  assert.equal(output.result().body, '');
  assert.equal(output.events.includes('continue'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await fsp.readdir(root),
    ['task-94111111-1111-4111-8111-111111111111']);
});

test('one composed worker admission rejects a concurrent job before bytes and releases afterward', async (t) => {
  let releaseHealth;
  let healthCalls = 0;
  const health = {
    healthy: true,
    daemonId: 'ClamAV synthetic-daemon',
    engineVersion: '1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  };
  const scanner = {
    async health() {
      healthCalls += 1;
      if (healthCalls === 1) return new Promise((resolve) => { releaseHealth = () => resolve(health); });
      return health;
    },
    async scan({ byteStream }) {
      for await (const _chunk of byteStream) { /* synthetic */ }
      return { outcome: 'clean', reasonCode: 'clean', daemonId: health.daemonId };
    },
  };
  const worker = await withWorker(t, { scanner });
  const firstInput = fakeRequest(signedRequest());
  const firstOutput = fakeResponse();
  const first = worker.handleCheckContinue(firstInput.request, firstOutput.response);
  while (!firstOutput.events.includes('continue') || typeof releaseHealth !== 'function') {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const secondWire = signedRequest({
    requestId: 'a1111111-1111-4111-8111-111111111111',
    intakeId: 'a2222222-2222-4222-8222-222222222222',
  });
  const secondInput = fakeRequest(secondWire);
  const secondOutput = fakeResponse();
  await worker.handleCheckContinue(secondInput.request, secondOutput.response);
  assert.equal(secondOutput.result().status, 400);
  assert.equal(secondOutput.events.includes('continue'), false);
  assert.equal(secondInput.reads(), 0);

  releaseHealth();
  await first;
  assert.equal(firstOutput.result().status, 200);
  const retryInput = fakeRequest(secondWire);
  const retryOutput = fakeResponse();
  await worker.handleCheckContinue(retryInput.request, retryOutput.response);
  assert.equal(retryOutput.result().status, 200);
  assert.equal(retryOutput.events.includes('continue'), true);
});

test('HTTP handler construction is inert and requires explicit process authorities', () => {
  const base = {
    keyResolver,
    replayStore: createSyntheticReplayStore({ now: () => new Date('2026-10-03T12:00:00.000Z') }),
    admission: createSingleCimScanAdmission(),
    ephemeralRoot: '/tmp/synthetic-worker-http-inert',
    scanner: createSyntheticWorkerScanner(),
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  assert.equal(typeof createCimScanWorkerCheckContinueHandler(base), 'function');
  for (const field of ['keyResolver', 'replayStore', 'admission', 'ephemeralRoot', 'scanner', 'now']) {
    assert.throws(() => createCimScanWorkerCheckContinueHandler({ ...base, [field]: undefined }),
      /required|authority|adapter/i, field);
  }
});

test('HTTP handler keeps protocol and signature-freshness clocks separate', async () => {
  const wire = signedRequest();
  const input = fakeRequest(wire);
  const output = fakeResponse();
  const protocolNow = () => new Date('2026-10-03T12:00:00.000Z');
  const signatureNow = () => new Date('2026-10-04T13:00:00.000Z');
  let observed;
  const handler = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore: createSyntheticReplayStore({ now: protocolNow }),
    admission: createSingleCimScanAdmission(),
    ephemeralRoot: '/tmp/synthetic-worker-http-clocks',
    scanner: createSyntheticWorkerScanner(),
    now: protocolNow,
    signatureNow,
    async runTask(options) {
      observed = options;
      return createSignedScanResult({
        request: parseAndVerifyScanRequest(wire, { keyResolver, now: protocolNow() }),
        outcome: 'unavailable',
        reasonCode: 'stale_signatures',
        engineVersion: 'unavailable',
        signatureVersion: 'unavailable',
        signatureUpdatedAt: protocolNow().toISOString(),
        scannedAt: protocolNow().toISOString(),
        expiresAt: '2026-10-03T12:02:00.000Z',
        cleanupStatus: 'cleaned',
      }, { keyResolver });
    },
  });
  await handler(input.request, output.response);
  assert.equal(output.result().status, 200);
  assert.equal(observed.now, protocolNow);
  assert.equal(observed.signatureNow, signatureNow);
});
