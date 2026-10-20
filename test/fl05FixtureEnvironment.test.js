import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fixtureEnvironment } from '../scripts/fl05-fixture-environment.js';

test('FL05 child environment contains only local synthetic configuration', () => {
  const root = path.resolve('/tmp/fl05-test');
  const env = fixtureEnvironment(root, '/tmp/chromium');
  assert.equal(env.HOME, path.join(root, 'home'));
  assert.equal(env.SQLITE_PATH, path.join(root, 'owner.sqlite'));
  assert.equal(env.DELIVERY_PROVIDER, 'console');
  assert.equal(env.DEAL_HUNTER_CIM_AUTOMATION_PAUSED, 'true');
  assert.equal(env.DEAL_HUNTER_CIM_OUTREACH_PAUSED, 'true');
  assert.equal(env.DEAL_HUNTER_DAILY_EMAIL_ENABLED, 'false');
  assert.equal(env.DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED, 'false');
  assert.equal(env.FL05_BROWSER_EXECUTABLE, '/tmp/chromium');
  for (const key of ['FLY_API_TOKEN', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'DATABASE_URL',
    'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(env[key], undefined, key);
  }
  assert.deepEqual(fixtureEnvironment(root, '/tmp/chromium'), env);
});

test('FL05 requires absolute fixture and browser paths', () => {
  assert.throws(() => fixtureEnvironment('.', '/tmp/chromium'), /absolute/);
  assert.throws(() => fixtureEnvironment('/tmp/fl05-test', 'chromium'), /absolute/);
});
