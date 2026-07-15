import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'uckele-contact-test-'));

process.env.ADMIN_SESSION_SECRET = 'contact-submission-session-secret';
process.env.DELIVERY_PROVIDER = 'console';
process.env.LEAD_NOTIFICATION_EMAIL = 'mathew@example.com';
process.env.SQLITE_PATH = path.join(tempDir, 'contact-submission.sqlite');
process.env.TURNSTILE_SITE_KEY = 'turnstile-site-key';
process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
const { enforceContactBodyRateLimit, submitContactLead } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');
const { hashIp } = await import('../server/utils/security.js');

after(() => {
  global.fetch = originalFetch;
  console.log = originalConsoleLog;
});

test('contact submission sends the full Turnstile token to verification', async () => {
  const longToken = 'token-'.padEnd(1900, 'x');
  let verifiedToken = '';

  global.fetch = async (_url, options = {}) => {
    verifiedToken = options.body.get('response');

    return {
      ok: true,
      json: async () => ({ success: true, hostname: 'www.uckelegroup.com' }),
    };
  };
  console.log = () => {};

  const result = await submitContactLead(
    {
      name: 'Codex Test Lead',
      email: 'codex-test@example.com',
      phone: '555-0100',
      company: 'Uckele Group Test',
      role: 'Business Owner',
      message: 'This is a Turnstile token length regression test.',
      source: 'website-contact-form',
      turnstileToken: longToken,
      startedAt: String(Date.now() - 5000),
    },
    {
      headers: {
        host: 'www.uckelegroup.com',
      },
      ip: '127.0.0.1',
      socket: {},
    },
  );

  assert.equal(verifiedToken, longToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);

  const storage = getStorage();
  const submission = await storage.getSubmission(result.body.id);
  const activity = await storage.listCrmActivityEvents({ submissionId: result.body.id, limit: 20 });
  const routingEvent = activity.find((event) => event.event_type === 'submission.routing-updated');
  assert.equal(submission.delivery_status, 'logged');
  assert.equal(submission.crm_status, 'skipped');
  assert.ok(routingEvent, 'the final delivery and CRM routing result should be durable activity');
  assert.equal(routingEvent.metadata.routingKey, `contact-submission:${result.body.id}`);
  assert.deepEqual(routingEvent.metadata.changedFields.sort(), [
    'crm_status',
    'delivery_status',
  ]);
});

test('pre-body contact rate limit is not counted twice by submission handling', async () => {
  const ip = '203.0.113.44';
  const request = {
    headers: {
      host: 'www.uckelegroup.com',
    },
    ip,
    socket: {},
  };
  const storage = getStorage();
  const bucket = `contact:${hashIp(ip)}`;
  const windowStartIso = new Date(Date.now() - 1000 * 60 * 10).toISOString();

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, hostname: 'www.uckelegroup.com' }),
  });
  console.log = () => {};

  const bodyRateLimitResult = await enforceContactBodyRateLimit(request);
  const result = await submitContactLead(
    {
      name: 'Codex Rate Limit Test',
      email: 'codex-rate-limit@example.com',
      phone: '555-0101',
      company: 'Uckele Group Test',
      role: 'Business Owner',
      message: 'This verifies the contact body gate is not double counted.',
      source: 'website-contact-form',
      turnstileToken: 'valid-turnstile-token',
      startedAt: String(Date.now() - 5000),
    },
    request,
  );
  const count = await storage.countRateLimitEvents(bucket, windowStartIso);

  assert.deepEqual(bodyRateLimitResult, { ok: true });
  assert.equal(result.status, 200);
  assert.equal(count, 1);
});
