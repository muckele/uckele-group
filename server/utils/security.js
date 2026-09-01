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
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`Unsupported symbol key at ${path}.`);
    const propertyNames = Object.getOwnPropertyNames(value);
    const allowedNames = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (propertyNames.some((key) => !allowedNames.has(key))) throw new TypeError(`Unsupported array property at ${path}.`);
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`Unsupported sparse array at ${path}.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`Unsupported array property at ${path}[${index}].`);
      result.push(canonicalJsonValue(descriptor.value, `${path}[${index}]`));
    }
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Unsupported object at ${path}.`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`Unsupported symbol key at ${path}.`);
    return Object.getOwnPropertyNames(value).sort().reduce((result, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`Unsupported object property at ${path}.${key}.`);
      result[key] = canonicalJsonValue(descriptor.value, `${path}.${key}`);
      return result;
    }, Object.create(null));
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
