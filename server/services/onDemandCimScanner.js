import {
  CIM_SCAN_PROTOCOL_LIMITS,
  createSignedScanRequest,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from './cimScanProtocol.js';

const requestLifetimeMs = 3 * 60 * 1000;

function dateFromClock(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('On-demand scanner clock is invalid.');
  return date;
}

function validateFactory({
  keyId, keyResolver, transport, now, resultNow,
  requestMaxDurationMs = CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs,
} = {}) {
  if (typeof keyId !== 'string' || !keyId) throw new Error('An explicit protocol key id is required.');
  if (typeof keyResolver !== 'function') throw new Error('An explicit protocol key resolver is required.');
  if (!transport || typeof transport.run !== 'function') throw new Error('An injected scan transport is required.');
  if (now !== undefined && typeof now !== 'function') throw new Error('Scanner clock must be injected as a function.');
  if (resultNow !== undefined && typeof resultNow !== 'function') {
    throw new Error('Scanner result clock must be injected as a function.');
  }
  if (!Number.isSafeInteger(requestMaxDurationMs) || requestMaxDurationMs < 1
    || requestMaxDurationMs > CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs) {
    throw new Error('Scanner request duration limit is invalid.');
  }
}

export function createOnDemandScannerAdapter(options = {}) {
  validateFactory(options);
  const {
    keyId, keyResolver, transport, now = () => new Date(), resultNow = now,
    requestMaxDurationMs = CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs,
  } = options;
  return Object.freeze({
    name: 'offline-on-demand-protocol',
    version: 'uckele.cim-scan.v1',
    async scan({ claim, sha256, sizeBytes, mimeType, openByteStream } = {}) {
      if (!claim || typeof claim !== 'object') throw new Error('An exact scan claim is required.');
      if (typeof openByteStream !== 'function') throw new Error('A lazy attachment stream factory is required.');
      const issuedAt = dateFromClock(now);
      const leaseExpiresAt = new Date(claim.leaseExpiresAt);
      if (!Number.isFinite(leaseExpiresAt.getTime()) || leaseExpiresAt <= issuedAt) {
        throw new Error('Scan claim lease is expired.');
      }
      const expiresAt = new Date(Math.min(
        leaseExpiresAt.getTime(),
        issuedAt.getTime() + requestLifetimeMs,
      ));
      const requestWire = createSignedScanRequest({
        requestId: claim.requestId,
        intakeId: claim.intakeId,
        attempt: claim.attempt,
        jobOwner: claim.jobOwner,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        sha256,
        sizeBytes,
        mimeType,
        maxBytes: CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes,
        maxDurationMs: requestMaxDurationMs,
        keyId,
      }, { keyResolver });
      const request = parseAndVerifyScanRequest(requestWire, { keyResolver, now: issuedAt });
      const transportResult = await transport.run({
        requestWire,
        requestId: claim.requestId,
        leaseExpiresAt: claim.leaseExpiresAt,
        openByteStream,
      });
      const result = parseAndVerifyScanResult(transportResult.resultWire, {
        request, keyResolver, now: dateFromClock(resultNow),
      });
      if (transportResult.stopConfirmed !== true && result.outcome !== 'unsafe') {
        return { outcome: 'unavailable', reasonCode: 'machine_stop_uncertain' };
      }
      return {
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        cleanupStatus: result.cleanupStatus,
        engineVersion: result.engineVersion,
        signatureVersion: result.signatureVersion,
        signatureUpdatedAt: result.signatureUpdatedAt,
        scannedAt: result.scannedAt,
        protocolResultExpiresAt: result.expiresAt,
        requestDigest: result.requestDigest,
      };
    },
  });
}
