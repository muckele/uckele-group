import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedScanRequest,
  createSignedScanResult,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from '../server/services/cimScanProtocol.js';

const key = Buffer.from('synthetic-p8-03-protocol-key-material-only');
const keyResolver = (keyId) => keyId === 'test-key-1' ? key : null;
const now = new Date('2026-10-03T12:00:00.000Z');

function requestInput(overrides = {}) {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    intakeId: '22222222-2222-4222-8222-222222222222',
    attempt: 1,
    jobOwner: 'synthetic-app-1',
    issuedAt: '2026-10-03T12:00:00.000Z',
    expiresAt: '2026-10-03T12:03:00.000Z',
    leaseExpiresAt: '2026-10-03T12:04:00.000Z',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 90_000,
    keyId: 'test-key-1',
    ...overrides,
  };
}

test('request protocol signs canonical exact hash-bound input with injected synthetic key', () => {
  const wire = createSignedScanRequest(requestInput(), { keyResolver });
  const verified = parseAndVerifyScanRequest(wire, { keyResolver, now });
  assert.equal(verified.protocol, 'uckele.cim-scan.v1');
  assert.equal(verified.sha256, 'a'.repeat(64));
  assert.equal(verified.requestDigest.length, 64);
  assert.equal(verified.signature.length, 64);
});

test('request parser rejects tampering, noncanonical JSON, duplicate keys, unknown fields, and oversize before use', () => {
  const wire = createSignedScanRequest(requestInput(), { keyResolver });
  assert.throws(
    () => parseAndVerifyScanRequest(wire.replace('1024', '1025'), { keyResolver, now }),
    /signature/i,
  );
  assert.throws(
    () => parseAndVerifyScanRequest(`${wire.slice(0, -1)}, "extra": true}`, { keyResolver, now }),
    /fields|canonical/i,
  );
  assert.throws(
    () => parseAndVerifyScanRequest(wire.replace('{', '{"protocol":"uckele.cim-scan.v1",'), { keyResolver, now }),
    /canonical/i,
  );
  assert.throws(
    () => parseAndVerifyScanRequest(` ${wire}`, { keyResolver, now }),
    /canonical/i,
  );
  assert.throws(
    () => parseAndVerifyScanRequest('x'.repeat(16 * 1024 + 1), { keyResolver, now }),
    /too large/i,
  );

  const normalizedTamper = JSON.parse(wire);
  normalizedTamper.protocol = '';
  assert.throws(
    () => parseAndVerifyScanRequest(JSON.stringify(normalizedTamper), { keyResolver, now }),
    /binding|canonical/i,
  );
});

test('request parser rejects invalid identity, limits, time windows, and missing key', () => {
  for (const [overrides, pattern] of [
    [{ requestId: 'not-a-uuid' }, /request id/i],
    [{ attempt: 0 }, /attempt/i],
    [{ sha256: 'A'.repeat(64) }, /sha-256/i],
    [{ sizeBytes: 0 }, /size/i],
    [{ maxBytes: 9 * 1024 * 1024 }, /maximum bytes/i],
    [{ maxDurationMs: 90_001 }, /duration/i],
    [{ expiresAt: '2026-10-03T12:06:00.000Z' }, /lifetime/i],
    [{ expiresAt: '2026-10-03T12:04:01.000Z' }, /lease/i],
    [{ keyId: 'missing-key' }, /key/i],
  ]) {
    assert.throws(() => createSignedScanRequest(requestInput(overrides), { keyResolver }), pattern);
  }

  const expired = createSignedScanRequest(requestInput({
    issuedAt: '2026-10-03T11:54:00.000Z',
    expiresAt: '2026-10-03T11:59:00.000Z',
  }), { keyResolver });
  assert.throws(() => parseAndVerifyScanRequest(expired, { keyResolver, now }), /expired/i);

  const future = createSignedScanRequest(requestInput({
    issuedAt: '2026-10-03T12:00:31.000Z',
    expiresAt: '2026-10-03T12:03:00.000Z',
  }), { keyResolver });
  assert.throws(() => parseAndVerifyScanRequest(future, { keyResolver, now }), /future/i);
});

test('result is direction-separated and bound to the complete request digest and evidence', () => {
  const requestWire = createSignedScanRequest(requestInput(), { keyResolver });
  const request = parseAndVerifyScanRequest(requestWire, { keyResolver, now });
  const resultWire = createSignedScanResult({
    request,
    outcome: 'clean',
    reasonCode: 'clean',
    engineVersion: 'ClamAV 1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
    scannedAt: '2026-10-03T12:00:10.000Z',
    expiresAt: '2026-10-03T12:02:00.000Z',
    cleanupStatus: 'cleaned',
  }, { keyResolver });
  const result = parseAndVerifyScanResult(resultWire, { request, keyResolver, now });
  assert.equal(result.outcome, 'clean');
  assert.equal(result.requestDigest, request.requestDigest);
  assert.equal(result.engineVersion, 'ClamAV 1.synthetic');

  assert.throws(
    () => parseAndVerifyScanResult(resultWire.replace('synthetic-db-1', 'synthetic-db-2'), {
      request, keyResolver, now,
    }),
    /signature/i,
  );
  assert.throws(
    () => parseAndVerifyScanResult(resultWire, {
      request: { ...request, requestDigest: 'b'.repeat(64) }, keyResolver, now,
    }),
    /request digest/i,
  );
  assert.notEqual(request.signature, result.signature);
});

test('clean result fails closed on stale, future, mismatched, or expired evidence', () => {
  const request = parseAndVerifyScanRequest(
    createSignedScanRequest(requestInput(), { keyResolver }),
    { keyResolver, now },
  );
  const valid = {
    request,
    outcome: 'clean',
    reasonCode: 'clean',
    engineVersion: 'ClamAV synthetic',
    signatureVersion: 'db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
    scannedAt: '2026-10-03T12:00:10.000Z',
    expiresAt: '2026-10-03T12:02:00.000Z',
    cleanupStatus: 'cleaned',
  };
  for (const [overrides, pattern] of [
    [{ signatureUpdatedAt: '2026-10-01T00:00:00.000Z' }, /stale/i],
    [{ signatureUpdatedAt: '2026-10-03T12:00:11.000Z' }, /future/i],
    [{ scannedAt: '2026-10-03T12:04:01.000Z' }, /lease/i],
    [{ expiresAt: '2026-10-03T12:04:01.000Z' }, /request|lease/i],
    [{ cleanupStatus: 'retained' }, /cleanup/i],
  ]) {
    assert.throws(() => createSignedScanResult({ ...valid, ...overrides }, { keyResolver }), pattern);
  }

  const shortRequest = parseAndVerifyScanRequest(createSignedScanRequest(requestInput({
    requestId: '31111111-1111-4111-8111-111111111111',
    maxDurationMs: 5_000,
  }), { keyResolver }), { keyResolver, now });
  assert.throws(() => createSignedScanResult({
    ...valid,
    request: shortRequest,
    scannedAt: '2026-10-03T12:00:10.000Z',
  }, { keyResolver }), /worker duration/i);

  const expiredWire = createSignedScanResult({
    ...valid,
    expiresAt: '2026-10-03T12:00:15.000Z',
  }, { keyResolver });
  assert.throws(
    () => parseAndVerifyScanResult(expiredWire, {
      request, keyResolver, now: new Date('2026-10-03T12:00:16.000Z'),
    }),
    /expired/i,
  );

  const futureWire = createSignedScanResult({
    ...valid,
    signatureUpdatedAt: '2026-10-03T12:00:31.000Z',
    scannedAt: '2026-10-03T12:00:31.000Z',
    expiresAt: '2026-10-03T12:02:00.000Z',
  }, { keyResolver });
  assert.throws(
    () => parseAndVerifyScanResult(futureWire, { request, keyResolver, now }),
    /future/i,
  );
});
