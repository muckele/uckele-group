import assert from 'node:assert/strict';
import test from 'node:test';
import { getClientIp } from '../server/utils/http.js';

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
