import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function safeBase64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function safeBase64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJsonValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Unsupported non-finite number at ${path}.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Unsupported object at ${path}.`);
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalJsonValue(value[key], `${path}.${key}`);
      return result;
    }, {});
  }
  throw new TypeError(`Unsupported JSON value at ${path}.`);
}

export function stableCanonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function hashIp(value) {
  return sha256(value).slice(0, 24);
}

export function safeCompareText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function signPayload(payload, secret) {
  const encodedPayload = safeBase64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySignedPayload(token, secret) {
  if (!token || !secret) {
    return null;
  }

  const parts = String(token).split('.');

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  if (!safeCompareText(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(safeBase64UrlDecode(encodedPayload));

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    if (
      Object.hasOwn(payload, 'exp') &&
      (!Number.isFinite(payload.exp) || payload.exp <= Date.now())
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
