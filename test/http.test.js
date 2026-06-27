import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithTimeout, getClientIp } from '../server/utils/http.js';

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
