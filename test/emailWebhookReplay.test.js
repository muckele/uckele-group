import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-webhook-replay-'));
process.env.SQLITE_PATH = path.join(tempDir, 'webhooks.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.RESEND_API_KEY = 're_fixture_received_email_key';
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

let receivedEmailFetchCount = 0;

async function receivedEmailFetcher(url) {
  receivedEmailFetchCount += 1;
  assert.equal(url, 'https://api.resend.com/emails/receiving/email_fixture_reply_001');
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id: 'email_fixture_reply_001',
        message_id: 'message_fixture_reply_001',
        from: 'Seller Example <seller@example.com>',
        to: ['mathew@uckelegroup.com'],
        subject: 'Re: Secure diligence request',
        text: 'Fixture reply body.',
        attachments: [],
        created_at: '2026-07-13T18:15:00.000Z',
      };
    },
  };
}

function receivedEmailFetcherFor({ emailId, from, body }) {
  return async (url) => {
    assert.equal(url, `https://api.resend.com/emails/receiving/${emailId}`);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: emailId,
          from,
          to: ['mathew@uckelegroup.com'],
          subject: 'Re: CIM request',
          text: body,
          attachments: [],
          created_at: '2026-07-13T19:00:00.000Z',
        };
      },
    };
  };
}

function receivedPayload({ id, emailId, from }) {
  return {
    id,
    type: 'email.received',
    created_at: '2026-07-13T19:00:00.000Z',
    data: {
      email_id: emailId,
      message_id: `<${emailId}@resend.example>`,
      from,
      to: ['mathew@uckelegroup.com'],
      subject: 'Re: CIM request',
    },
  };
}

test('Resend fixtures replay idempotently and create one durable deal event per provider event', async (t) => {
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const created = await createManualSubmission({ company: 'Webhook Replay Co', seller_name: 'Seller Example', seller_email: 'seller@example.com' }, 'fixture-admin');
  const submissionId = created.submission.id;
  const delivered = fixture('delivered', submissionId);
  const replied = fixture('replied', submissionId);

  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(delivered), { fetcher: receivedEmailFetcher })).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(delivered), { fetcher: receivedEmailFetcher })).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(replied), { fetcher: receivedEmailFetcher })).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(replied), { fetcher: receivedEmailFetcher })).ok, true);

  const storage = getStorage();
  const emailEvents = await storage.listEmailEvents({ submissionId, limit: 20 });
  const activity = await storage.listCrmActivityEvents({ submissionId, limit: 20 });
  const communications = await storage.listCrmCommunications({ submissionId, direction: 'inbound', pageSize: 20 });

  assert.equal(emailEvents.filter((event) => event.provider_event_id === delivered.id).length, 1);
  assert.equal(emailEvents.filter((event) => event.provider_event_id === replied.id).length, 1);
  assert.equal(activity.filter((event) => event.metadata.emailEventId && event.event_type === 'email.delivered').length, 1);
  assert.equal(activity.filter((event) => event.metadata.emailEventId && event.event_type === 'email.replied').length, 1);
  assert.equal(communications.total, 1);
  assert.equal(communications.rows[0].provider_message_id, 'email_fixture_reply_001');
  assert.equal(communications.rows[0].body_text, 'Fixture reply body.');
  assert.equal(communications.rows[0].content_attempt_count, 1);
  assert.equal(receivedEmailFetchCount, 1);

  const unique = await createManualSubmission({
    company: 'Unique Contact Co',
    role: 'broker',
    broker_name: 'Unique Broker',
    broker_email: 'unique-broker@example.com',
  }, 'fixture-admin');
  const uniqueReceived = receivedPayload({
    id: 'evt_fixture_unique_received_001',
    emailId: 'email_fixture_unique_received_001',
    from: 'Unique Broker <unique-broker@example.com>',
  });
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(uniqueReceived), {
    fetcher: receivedEmailFetcherFor({
      emailId: 'email_fixture_unique_received_001',
      from: 'Unique Broker <unique-broker@example.com>',
      body: 'Unique fallback reply.',
    }),
  })).ok, true);
  const uniqueCommunications = await storage.listCrmCommunications({
    submissionId: unique.submission.id,
    direction: 'inbound',
    pageSize: 20,
  });
  assert.equal(uniqueCommunications.total, 1);
  assert.equal(uniqueCommunications.rows[0].provider_message_id, 'email_fixture_unique_received_001');

  await createManualSubmission({
    company: 'Shared Contact Listing A',
    role: 'broker',
    broker_name: 'Shared Broker',
    broker_email: 'shared-broker@example.com',
  }, 'fixture-admin');
  await createManualSubmission({
    company: 'Shared Contact Listing B',
    role: 'broker',
    broker_name: 'Shared Broker',
    broker_email: 'shared-broker@example.com',
  }, 'fixture-admin');
  const ambiguousReceived = receivedPayload({
    id: 'evt_fixture_ambiguous_received_001',
    emailId: 'email_fixture_ambiguous_received_001',
    from: 'Shared Broker <shared-broker@example.com>',
  });
  assert.equal((await recordEmailEventsFromWebhook(webhookRequest(ambiguousReceived), {
    fetcher: receivedEmailFetcherFor({
      emailId: 'email_fixture_ambiguous_received_001',
      from: 'Shared Broker <shared-broker@example.com>',
      body: 'Ambiguous shared-address reply.',
    }),
  })).ok, true);
  const unassigned = await storage.listCrmCommunications({ unassigned: true, direction: 'inbound', pageSize: 20 });
  const ambiguousCommunication = unassigned.rows.find((row) => row.provider_message_id === 'email_fixture_ambiguous_received_001');
  assert.ok(ambiguousCommunication);
  assert.equal(ambiguousCommunication.submission_id, null);
});
