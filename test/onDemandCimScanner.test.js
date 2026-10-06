import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnDemandScannerAdapter } from '../server/services/onDemandCimScanner.js';
import {
  createSignedScanResult,
  parseAndVerifyScanRequest,
} from '../server/services/cimScanProtocol.js';

const key = Buffer.from('synthetic-p8-03-adapter-key-material-only');
const keyResolver = (keyId) => keyId === 'test-key-1' ? key : null;
const current = new Date('2026-10-03T12:00:00.000Z');
const claim = {
  intakeId: '52222222-2222-4222-8222-222222222222',
  requestId: '51111111-1111-4111-8111-111111111111',
  attempt: 1,
  jobOwner: 'synthetic-app-1',
  leaseExpiresAt: '2026-10-03T12:04:00.000Z',
};

function transportFixture({
  outcome = 'clean', stopConfirmed = true, tamper = false,
  scannedAt = '2026-10-03T12:00:10.000Z',
  reasonCode = outcome === 'clean' ? 'clean' : outcome === 'unsafe' ? 'malware_found' : 'scanner_error',
  cleanupStatus = 'cleaned',
} = {}) {
  return {
    request: null,
    async run(command) {
      this.request = parseAndVerifyScanRequest(command.requestWire, { keyResolver, now: current });
      let resultWire = createSignedScanResult({
        request: this.request,
        outcome,
        reasonCode,
        engineVersion: 'ClamAV synthetic',
        signatureVersion: 'db-1',
        signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
        scannedAt,
        expiresAt: '2026-10-03T12:02:00.000Z',
        cleanupStatus,
      }, { keyResolver });
      if (tamper) resultWire = resultWire.replace('db-1', 'db-2');
      return { resultWire, stopConfirmed };
    },
  };
}

function adapter(transport, requestMaxDurationMs, resultNow) {
  return createOnDemandScannerAdapter({
    keyId: 'test-key-1',
    keyResolver,
    transport,
    now: () => new Date(current),
    ...(resultNow === undefined ? {} : { resultNow }),
    ...(requestMaxDurationMs === undefined ? {} : { requestMaxDurationMs }),
  });
}

test('on-demand adapter binds an explicitly shortened benchmark worker deadline', async () => {
  const transport = transportFixture();
  await adapter(transport, 20_000).scan({
    claim,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.equal(transport.request.maxDurationMs, 20_000);
  assert.throws(() => adapter(transport, 0), /duration|limit/i);
});

test('result verification uses its live clock without changing frozen request issuance', async () => {
  const transport = transportFixture({ scannedAt: '2026-10-03T12:00:40.000Z' });
  const result = await adapter(transport, undefined,
    () => new Date('2026-10-03T12:00:40.000Z')).scan({
    claim,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.equal(transport.request.issuedAt, current.toISOString());
  assert.equal(result.scannedAt, '2026-10-03T12:00:40.000Z');
});

test('on-demand adapter binds request identity, limits, hash, MIME, and claim', async () => {
  const transport = transportFixture();
  const result = await adapter(transport).scan({
    claim,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.equal(result.outcome, 'clean');
  assert.equal(result.cleanupStatus, 'cleaned');
  assert.equal(result.engineVersion, 'ClamAV synthetic');
  assert.equal(transport.request.requestId, claim.requestId);
  assert.equal(transport.request.intakeId, claim.intakeId);
  assert.equal(transport.request.sha256, 'a'.repeat(64));
  assert.equal(transport.request.leaseExpiresAt, claim.leaseExpiresAt);
});

test('on-demand adapter preserves signed retained cleanup evidence', async () => {
  const result = await adapter(transportFixture({
    outcome: 'ambiguous',
    reasonCode: 'cleanup_uncertain',
    cleanupStatus: 'retained',
  })).scan({
    claim,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.equal(result.cleanupStatus, 'retained');
  assert.equal(result.reasonCode, 'cleanup_uncertain');
});

test('on-demand adapter rejects tampered or mismatched signed results', async () => {
  await assert.rejects(adapter(transportFixture({ tamper: true })).scan({
    claim,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  }), /signature/i);
});

test('stop uncertainty downgrades clean but preserves definite unsafe', async () => {
  const clean = await adapter(transportFixture({ stopConfirmed: false })).scan({
    claim, sha256: 'a'.repeat(64), sizeBytes: 123, mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.deepEqual(clean, { outcome: 'unavailable', reasonCode: 'machine_stop_uncertain' });

  const unsafe = await adapter(transportFixture({ outcome: 'unsafe', stopConfirmed: false })).scan({
    claim, sha256: 'a'.repeat(64), sizeBytes: 123, mimeType: 'application/pdf',
    openByteStream: () => (async function* () {})(),
  });
  assert.equal(unsafe.outcome, 'unsafe');
});

test('adapter has no implicit transport, credentials, job owner, or machine defaults', () => {
  assert.throws(() => createOnDemandScannerAdapter(), /explicit|injected/i);
  assert.throws(() => createOnDemandScannerAdapter({
    keyId: 'test-key-1', keyResolver, transport: {}, now: () => new Date(current),
  }), /transport/i);
});
