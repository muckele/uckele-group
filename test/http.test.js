import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCookies } from '../server/utils/cookies.js';
import { fetchWithTimeout, getClientIp } from '../server/utils/http.js';
import { signPayload, verifySignedPayload } from '../server/utils/security.js';

test('cookie parsing tolerates malformed percent encoding', () => {
  assert.deepEqual(parseCookies('valid=value; malformed=%E0%A4%A'), {
    valid: 'value',
    malformed: '%E0%A4%A',
  });
});

test('signed payload verification rejects non-canonical and invalid expiry values', () => {
  const secret = 'signed-payload-test-secret';
  const token = signPayload({ type: 'test', exp: Date.now() + 60_000 }, secret);
  const invalidExpiryToken = signPayload({ type: 'test', exp: 'later' }, secret);

  assert.equal(verifySignedPayload(`${token}.unexpected`, secret), null);
  assert.equal(verifySignedPayload(invalidExpiryToken, secret), null);
  assert.equal(verifySignedPayload(token, secret)?.type, 'test');
});

test('getClientIp prefers trusted platform headers over forwarded-for', () => {
  const request = {
    headers: {
      'fly-client-ip': '203.0.113.9',
      'x-forwarded-for': '10.0.0.1, 198.51.100.4',
    },
    ip: '127.0.0.1',
  };

  assert.equal(getClientIp(request), '203.0.113.9');
});

test('getClientIp falls back to the right-most forwarded-for hop', () => {
  const request = {
    headers: {
      'x-forwarded-for': '10.0.0.1, 198.51.100.4',
    },
    ip: '127.0.0.1',
  };

  assert.equal(getClientIp(request), '198.51.100.4');
});

test('fetchWithTimeout aborts slow provider requests', async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async (_url, options = {}) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

    await assert.rejects(
      () =>
        fetchWithTimeout('https://example.com/slow', {
          timeoutMs: 1,
          timeoutMessage: 'Provider request timed out.',
        }),
      /provider request timed out/i,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
