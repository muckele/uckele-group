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

  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  if (!safeCompareText(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(safeBase64UrlDecode(encodedPayload));

    if (payload.exp && payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
