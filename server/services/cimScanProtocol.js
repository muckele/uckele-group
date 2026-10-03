import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const secureDocumentAllowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/x-zip-compressed',
]);

export const CIM_SCAN_PROTOCOL = 'uckele.cim-scan.v1';
export const CIM_SCAN_PROTOCOL_LIMITS = Object.freeze({
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxEnvelopeBytes: 16 * 1024,
  maxRequestLifetimeMs: 5 * 60 * 1000,
  maxWorkerDurationMs: 90_000,
  maxClockSkewMs: 30_000,
  maxSignatureAgeMs: 24 * 60 * 60 * 1000,
});

const requestDomain = 'uckele.cim-scan.v1/request';
const resultDomain = 'uckele.cim-scan.v1/result';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const boundedCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const allowedOutcomes = new Set(['clean', 'unsafe', 'unavailable', 'ambiguous']);
const allowedCleanupStatuses = new Set(['cleaned', 'retained']);

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function boundedString(value, label, maxLength = 120) {
  const hasControl = typeof value === 'string' && [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  if (typeof value !== 'string' || !value || value.length > maxLength || hasControl) {
    throw new Error(`${label} must be bounded text.`);
  }
  return value;
}

function uuid(value, label) {
  const normalized = boundedString(value, label, 36).toLowerCase();
  if (!uuidPattern.test(normalized)) throw new Error(`${label} must be a UUID.`);
  return normalized;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its allowed range.`);
  }
  return value;
}

function utcTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a UTC timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function timeMs(value) {
  return Date.parse(value);
}

function resolveKey(keyResolver, keyId) {
  if (typeof keyResolver !== 'function') throw new Error('A protocol key resolver is required.');
  const value = keyResolver(keyId);
  const key = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!key || key.length < 32) throw new Error('Protocol authentication key is unavailable or too short.');
  return key;
}

function deriveDirectionKey(key, domain) {
  return createHmac('sha256', key).update(`${domain}/derived-key`, 'utf8').digest();
}

function signCanonical(canonicalUnsigned, key, domain) {
  return createHmac('sha256', deriveDirectionKey(key, domain))
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalUnsigned, 'utf8')
    .digest('hex');
}

function verifySignature(actual, expected) {
  if (!sha256Pattern.test(String(actual || ''))) throw new Error('Protocol signature is invalid.');
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Protocol signature verification failed.');
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseCanonicalWire(wire, fields, label) {
  if (typeof wire !== 'string' || Buffer.byteLength(wire, 'utf8') > CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes) {
    throw new Error(`${label} is too large.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(wire);
  } catch {
    throw new Error(`${label} is not valid canonical JSON.`);
  }
  assertExactFields(parsed, fields, label);
  if (JSON.stringify(parsed) !== wire) throw new Error(`${label} is not canonical JSON.`);
  return parsed;
}

const requestUnsignedFields = [
  'protocol', 'requestId', 'intakeId', 'attempt', 'jobOwner', 'issuedAt', 'expiresAt',
  'leaseExpiresAt', 'sha256', 'sizeBytes', 'mimeType', 'maxBytes', 'maxDurationMs',
  'keyId', 'algorithm',
];
const requestWireFields = [...requestUnsignedFields, 'signature'];

function normalizeRequest(input) {
  const request = {
    protocol: input?.protocol || CIM_SCAN_PROTOCOL,
    requestId: uuid(input?.requestId, 'Scan request id'),
    intakeId: uuid(input?.intakeId, 'Attachment intake id'),
    attempt: integer(input?.attempt, 'Scan attempt', 1, 3),
    jobOwner: boundedString(input?.jobOwner, 'Scan job owner', 120),
    issuedAt: utcTimestamp(input?.issuedAt, 'Request issued-at'),
    expiresAt: utcTimestamp(input?.expiresAt, 'Request expiry'),
    leaseExpiresAt: utcTimestamp(input?.leaseExpiresAt, 'Scan lease expiry'),
    sha256: String(input?.sha256 || ''),
    sizeBytes: integer(input?.sizeBytes, 'Attachment size', 1, CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes),
    mimeType: boundedString(input?.mimeType, 'Attachment MIME type', 160),
    maxBytes: integer(input?.maxBytes, 'Request maximum bytes', 1, CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes),
    maxDurationMs: integer(input?.maxDurationMs, 'Request maximum duration', 1, CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs),
    keyId: boundedString(input?.keyId, 'Protocol key id', 120),
    algorithm: input?.algorithm || 'hmac-sha256',
  };
  if (request.protocol !== CIM_SCAN_PROTOCOL) throw new Error('Scan protocol is unsupported.');
  if (!ownerPattern.test(request.jobOwner)) throw new Error('Scan job owner is invalid.');
  if (!sha256Pattern.test(request.sha256)) throw new Error('Attachment SHA-256 is invalid.');
  if (!secureDocumentAllowedMimeTypes.has(request.mimeType)) throw new Error('Attachment MIME type is unsupported.');
  if (request.sizeBytes > request.maxBytes) throw new Error('Attachment size exceeds request maximum bytes.');
  if (request.algorithm !== 'hmac-sha256') throw new Error('Protocol authentication algorithm is unsupported.');
  const issued = timeMs(request.issuedAt);
  const expires = timeMs(request.expiresAt);
  const leaseExpires = timeMs(request.leaseExpiresAt);
  if (expires <= issued || expires - issued > CIM_SCAN_PROTOCOL_LIMITS.maxRequestLifetimeMs) {
    throw new Error('Request lifetime is invalid.');
  }
  if (expires > leaseExpires) throw new Error('Request expiry exceeds the scan lease.');
  return request;
}

function assertCurrentRequest(request, now, maxClockSkewMs) {
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(current)) throw new Error('A valid protocol verification time is required.');
  if (timeMs(request.issuedAt) > current + maxClockSkewMs) throw new Error('Scan request is issued in the future.');
  if (timeMs(request.expiresAt) <= current) throw new Error('Scan request is expired.');
}

export function createSignedScanRequest(input, { keyResolver } = {}) {
  const unsigned = normalizeRequest(input);
  const canonicalUnsigned = JSON.stringify(unsigned);
  const signature = signCanonical(canonicalUnsigned, resolveKey(keyResolver, unsigned.keyId), requestDomain);
  return JSON.stringify({ ...unsigned, signature });
}

export function parseAndVerifyScanRequest(wire, {
  keyResolver,
  now = new Date(),
  maxClockSkewMs = CIM_SCAN_PROTOCOL_LIMITS.maxClockSkewMs,
} = {}) {
  const parsed = parseCanonicalWire(wire, requestWireFields, 'Scan request envelope');
  const { signature, ...input } = parsed;
  const unsigned = normalizeRequest(input);
  const canonicalUnsigned = JSON.stringify(unsigned);
  if (canonicalUnsigned !== JSON.stringify(input)) {
    throw new Error('Scan request canonical binding does not match normalized fields.');
  }
  verifySignature(signature, signCanonical(canonicalUnsigned, resolveKey(keyResolver, unsigned.keyId), requestDomain));
  assertCurrentRequest(unsigned, now, maxClockSkewMs);
  return Object.freeze({ ...unsigned, signature, requestDigest: digest(canonicalUnsigned) });
}

const resultUnsignedFields = [
  'protocol', 'requestDigest', 'requestId', 'intakeId', 'attempt', 'jobOwner', 'sha256',
  'sizeBytes', 'mimeType', 'maxBytes', 'maxDurationMs', 'outcome', 'reasonCode',
  'engineVersion', 'signatureVersion', 'signatureUpdatedAt', 'scannedAt', 'expiresAt',
  'cleanupStatus', 'keyId', 'algorithm',
];
const resultWireFields = [...resultUnsignedFields, 'signature'];

function normalizeResult(input) {
  const request = input?.request;
  if (!request || !sha256Pattern.test(String(request.requestDigest || ''))) {
    throw new Error('Verified scan request digest is required.');
  }
  const result = {
    protocol: CIM_SCAN_PROTOCOL,
    requestDigest: request.requestDigest,
    requestId: uuid(request.requestId, 'Scan request id'),
    intakeId: uuid(request.intakeId, 'Attachment intake id'),
    attempt: integer(request.attempt, 'Scan attempt', 1, 3),
    jobOwner: boundedString(request.jobOwner, 'Scan job owner', 120),
    sha256: String(request.sha256 || ''),
    sizeBytes: integer(request.sizeBytes, 'Attachment size', 1, CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes),
    mimeType: boundedString(request.mimeType, 'Attachment MIME type', 160),
    maxBytes: integer(request.maxBytes, 'Request maximum bytes', 1, CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes),
    maxDurationMs: integer(request.maxDurationMs, 'Request maximum duration', 1, CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs),
    outcome: String(input.outcome || ''),
    reasonCode: String(input.reasonCode || ''),
    engineVersion: boundedString(input.engineVersion, 'Scanner engine version', 120),
    signatureVersion: boundedString(input.signatureVersion, 'Scanner signature version', 120),
    signatureUpdatedAt: utcTimestamp(input.signatureUpdatedAt, 'Scanner signature update time'),
    scannedAt: utcTimestamp(input.scannedAt, 'Scan completion time'),
    expiresAt: utcTimestamp(input.expiresAt, 'Scan result expiry'),
    cleanupStatus: String(input.cleanupStatus || ''),
    keyId: request.keyId,
    algorithm: 'hmac-sha256',
  };
  if (!sha256Pattern.test(result.sha256)) throw new Error('Attachment SHA-256 is invalid.');
  if (!secureDocumentAllowedMimeTypes.has(result.mimeType)) throw new Error('Attachment MIME type is unsupported.');
  if (!allowedOutcomes.has(result.outcome)) throw new Error('Scan result outcome is invalid.');
  if (!boundedCodePattern.test(result.reasonCode)) throw new Error('Scan result reason code is invalid.');
  if (!allowedCleanupStatuses.has(result.cleanupStatus)) throw new Error('Scan cleanup status is invalid.');
  const scanned = timeMs(result.scannedAt);
  const signatureUpdated = timeMs(result.signatureUpdatedAt);
  const expires = timeMs(result.expiresAt);
  if (scanned < timeMs(request.issuedAt) || scanned > timeMs(request.leaseExpiresAt)) {
    throw new Error('Scan completion is outside the request lease.');
  }
  if (scanned > timeMs(request.issuedAt) + request.maxDurationMs) {
    throw new Error('Scan completion exceeds the authenticated worker duration.');
  }
  if (expires <= scanned || expires > timeMs(request.expiresAt) || expires > timeMs(request.leaseExpiresAt)) {
    throw new Error('Scan result expiry exceeds the request or lease window.');
  }
  if (signatureUpdated > scanned) throw new Error('Scanner signature evidence is from the future.');
  if (result.outcome === 'clean' && scanned - signatureUpdated > CIM_SCAN_PROTOCOL_LIMITS.maxSignatureAgeMs) {
    throw new Error('Scanner signature evidence is stale.');
  }
  if (result.outcome === 'clean' && result.cleanupStatus !== 'cleaned') {
    throw new Error('A clean scan requires confirmed cleanup.');
  }
  return result;
}

export function createSignedScanResult(input, { keyResolver } = {}) {
  const unsigned = normalizeResult(input);
  const canonicalUnsigned = JSON.stringify(unsigned);
  const signature = signCanonical(canonicalUnsigned, resolveKey(keyResolver, unsigned.keyId), resultDomain);
  return JSON.stringify({ ...unsigned, signature });
}

export function parseAndVerifyScanResult(wire, {
  request,
  keyResolver,
  now = new Date(),
  maxClockSkewMs = CIM_SCAN_PROTOCOL_LIMITS.maxClockSkewMs,
} = {}) {
  const parsed = parseCanonicalWire(wire, resultWireFields, 'Scan result envelope');
  if (!request || parsed.requestDigest !== request.requestDigest) {
    throw new Error('Scan result request digest does not match.');
  }
  const { signature, ...payload } = parsed;
  const unsigned = normalizeResult({ ...payload, request });
  const canonicalUnsigned = JSON.stringify(unsigned);
  if (canonicalUnsigned !== JSON.stringify(payload)) throw new Error('Scan result binding does not match its request.');
  verifySignature(signature, signCanonical(canonicalUnsigned, resolveKey(keyResolver, unsigned.keyId), resultDomain));
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(current)) throw new Error('A valid protocol verification time is required.');
  if (timeMs(unsigned.scannedAt) > current + maxClockSkewMs) {
    throw new Error('Scan result is completed in the future.');
  }
  if (timeMs(unsigned.expiresAt) <= current) throw new Error('Scan result is expired.');
  return Object.freeze({ ...unsigned, signature });
}
