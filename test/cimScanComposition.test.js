import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createCimScanWorkerHttpComposition,
  createFlyCimScannerComposition,
} from '../server/services/cimScanComposition.js';

const key = Buffer.from('synthetic-p8-07-composition-key-material');

function options(overrides = {}) {
  let fetchCalls = 0;
  let requestCalls = 0;
  return {
    value: {
      machineId: 'machine-1',
      appName: 'ug-scanner',
      apiBaseUrl: 'https://api.machines.dev',
      accessToken: 'synthetic-token',
      apiMaxResponseBytes: 4_096,
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must stay inert'); },
      wallNowMs: () => 1_700_000_000_000,
      monotonicNow: () => performance.now(),
      certificatePinSha256: 'a'.repeat(64),
      requestImpl: () => { requestCalls += 1; throw new Error('must stay inert'); },
      keyId: 'key-1',
      keyResolver: (candidate) => candidate === 'key-1' ? key : null,
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      ...overrides,
    },
    calls: () => ({ fetchCalls, requestCalls }),
  };
}

test('inert composition wires the reviewed Fly scanner stack without network or credential defaults', () => {
  const fixture = options();
  const composition = createFlyCimScannerComposition(fixture.value);

  assert.deepEqual(Object.keys(composition), ['scanner']);
  assert.equal(composition.scanner.name, 'offline-on-demand-protocol');
  assert.equal(composition.scanner.version, 'uckele.cim-scan.v1');
  assert.deepEqual(fixture.calls(), { fetchCalls: 0, requestCalls: 0 });
  assert.equal(Object.isFrozen(composition), true);
});

test('inert composition requires every network, credential, clock, and pin input explicitly', () => {
  for (const [field, pattern] of [
    ['accessToken', /token|credential/i],
    ['fetchImpl', /transport|injected/i],
    ['wallNowMs', /clock/i],
    ['monotonicNow', /clock/i],
    ['certificatePinSha256', /pin|digest/i],
    ['requestImpl', /request|injected/i],
    ['keyId', /key id/i],
    ['keyResolver', /key resolver/i],
    ['now', /clock/i],
  ]) {
    const fixture = options({ [field]: undefined });
    assert.throws(() => createFlyCimScannerComposition(fixture.value), pattern, field);
    assert.deepEqual(fixture.calls(), { fetchCalls: 0, requestCalls: 0 });
  }
});

test('worker HTTP composition is inert, owns one admission, and exposes no listener', () => {
  let replayCalls = 0;
  let scannerCalls = 0;
  const composition = createCimScanWorkerHttpComposition({
    keyResolver: () => key,
    replayStore: {
      async claim() { replayCalls += 1; },
      async complete() { replayCalls += 1; },
    },
    ephemeralRoot: '/tmp/synthetic-cim-worker-composition',
    scanner: {
      async health() { scannerCalls += 1; },
      async scan() { scannerCalls += 1; },
    },
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  });

  assert.deepEqual(Object.keys(composition), ['handleCheckContinue']);
  assert.equal(typeof composition.handleCheckContinue, 'function');
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual({ replayCalls, scannerCalls }, { replayCalls: 0, scannerCalls: 0 });
});
