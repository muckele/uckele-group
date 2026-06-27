import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.ADMIN_SESSION_SECRET = 'turnstile-session-secret';
process.env.TURNSTILE_SITE_KEY = 'turnstile-site-key';
process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';

const originalFetch = global.fetch;
const { verifyTurnstileToken } = await import('../server/services/turnstile.js');

after(() => {
  global.fetch = originalFetch;
});

test('Turnstile verification returns a controlled error when the provider request fails', async () => {
  global.fetch = async () => {
    throw new Error('network unavailable');
  };

  const result = await verifyTurnstileToken('token', '127.0.0.1');

  assert.equal(result.enabled, true);
  assert.equal(result.success, false);
  assert.match(result.error, /could not be validated/i);
});

test('Turnstile verification returns a controlled error when provider JSON is invalid', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new Error('invalid json');
    },
  });

  const result = await verifyTurnstileToken('token', '127.0.0.1');

  assert.equal(result.enabled, true);
  assert.equal(result.success, false);
  assert.match(result.error, /verification failed/i);
});
