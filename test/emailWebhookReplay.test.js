import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-webhook-replay-'));
process.env.SQLITE_PATH = path.join(tempDir, 'webhooks.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.ADMIN_SESSION_SECRET = 'fixture-session-secret';

const { recordEmailEventsFromWebhook } = await import('../server/services/emailEvents.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');

function fixture(name, submissionId) {
  const filePath = path.join(process.cwd(), 'test', 'fixtures', 'resend', `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replaceAll('__SUBMISSION_ID__', submissionId));
}

function webhookRequest(body) {
  return {
    body,
    rawBody: JSON.stringify(body),
    headers: { 'x-webhook-secret': 'fixture-webhook-secret' },
  };
}

test('Resend fixtures replay idempotently and create one durable deal event per provider event', async (t) => {
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const created = await createManualSubmission({ company: 'Webhook Replay Co', seller_name: 'Seller Example', seller_email: 'seller@example.com' }, 'fixture-admin');
  const submissionId = created.submission.id;
  const delivered = fixture('delivered', submissionId);
  const replied = fixture('replied', submissionId);

  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(delivered))).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(delivered))).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(replied))).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(replied))).ok, true);

  const storage = getStorage();
  const emailEvents = await storage.listEmailEvents({ submissionId, limit: 20 });
  const activity = await storage.listCrmActivityEvents({ submissionId, limit: 20 });

  assert.equal(emailEvents.filter((event) => event.provider_event_id === delivered.id).length, 1);
  assert.equal(emailEvents.filter((event) => event.provider_event_id === replied.id).length, 1);
  assert.equal(activity.filter((event) => event.metadata.emailEventId && event.event_type === 'email.delivered').length, 1);
  assert.equal(activity.filter((event) => event.metadata.emailEventId && event.event_type === 'email.replied').length, 1);
});
