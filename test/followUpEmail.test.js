import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  buildFollowUpEmailContent,
  processCrmEmailOutbox,
  previewCrmFollowUpEmail,
  sendCrmFollowUpEmail,
} from '../server/services/followUpEmail.js';

const initialAt = '2026-08-10T16:00:00.000Z';
const sendAt = new Date('2026-08-10T17:00:00.000Z');

function readyConfig(overrides = {}) {
  const base = {
    admin: { sessionSecret: 'test-follow-up-preview-secret-at-least-32-characters' },
    brand: { companyName: 'Uckele Group' },
    delivery: {
      provider: 'resend',
      resendApiKey: 're_test_key',
      resendFromEmail: 'outreach@example.test',
      resendReplyTo: 'reply@inbound.example.test',
      resendInboundDomain: 'inbound.example.test',
      emailWebhookSecret: 'whsec_test',
    },
    followUp: {
      emailEnabled: true,
      aiEnabled: false,
      timezone: 'America/Los_Angeles',
      sendWindowStart: '08:00',
      sendWindowEnd: '17:00',
      weekdaysOnly: true,
      dailyCap: 25,
      recipientRollingCap: 4,
      maxTouches: 3,
      cadenceHours: [48, 72, 96],
      senderName: 'Mathew Uckele',
      senderEmail: 'outreach@example.test',
      replyTo: 'reply@inbound.example.test',
      requireSignedPreview: false,
      physicalPostalAddress: '123 Main Street, San Diego, CA 92101',
      optOutBaseUrl: '',
      replyOptOutEnabled: true,
    },
  };
  return {
    ...base,
    ...overrides,
    brand: { ...base.brand, ...(overrides.brand || {}) },
    admin: { ...base.admin, ...(overrides.admin || {}) },
    delivery: { ...base.delivery, ...(overrides.delivery || {}) },
    followUp: { ...base.followUp, ...(overrides.followUp || {}) },
  };
}

function submission(overrides = {}) {
  return {
    id: 'follow-up-email-submission',
    created_at: initialAt,
    updated_at: initialAt,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'follow-up-email-test',
    ip_hash: '',
    user_agent: '',
    name: 'Avery Broker',
    email: 'avery@example.test',
    phone: '',
    company: 'Example Manufacturing',
    role: 'Broker',
    message: 'Test fixture.',
    status_updated_at: initialAt,
    listing_url: 'https://example.test/listing',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Avery Broker',
    broker_email: 'avery@example.test',
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'high',
    tags: [],
    assigned_to: 'Mathew Uckele',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: sendAt.toISOString(),
    last_contacted_at: null,
    metadata: {},
    ...overrides,
  };
}

function createStorage(t, record = submission()) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-follow-up-email-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage.insertSubmission(record).then(() => storage);
}

function sendInput(overrides = {}) {
  return {
    clientRequestToken: 'confirmation-token-123456',
    expectedSubmissionVersion: initialAt,
    recipient: 'avery@example.test',
    subject: 'Example Manufacturing next step',
    bodyText: 'Thank you for the conversation. Could we review the CIM together next week?',
    nextFollowUpState: 'waiting-on-owner',
    nextActionAt: '2026-08-13T16:00:00.000Z',
    ...overrides,
  };
}

test('generic follow-up persists the exact command before provider transmission and replays one confirmation once', async (t) => {
  const storage = await createStorage(t);
  const providerCalls = [];
  const sender = async (message) => {
    providerCalls.push(structuredClone(message));
    const storedCommunication = await storage.getCrmCommunication(message.communicationId);
    const storedOutbox = await storage.getCrmEmailOutbox(storedCommunication.outbox_id);
    assert.equal(storedCommunication.body_text, message.text, 'exact final body exists before provider call');
    assert.equal(storedOutbox.state, 'sending', 'durable command is claimed before provider call');
    assert.equal(storedOutbox.idempotency_key, message.idempotencyKey);
    return { status: 'sent', providerMessageId: 'resend-provider-id-1', error: '' };
  };

  const first = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    sender,
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(first.ok, true);
  assert.equal(first.outbox.state, 'accepted');
  assert.equal(first.communication.delivery_state, 'accepted');
  assert.match(first.communication.body_text, /123 Main Street/);
  assert.match(first.communication.body_text, /reply with “unsubscribe” or “stop”/);
  assert.equal(first.communication.bcc_addresses.length, 0);
  assert.equal(providerCalls.length, 1);

  const replay = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    sender,
    config: readyConfig(),
    now: new Date('2026-08-10T17:01:00.000Z'),
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayedCommand, true);
  assert.equal(replay.outbox.id, first.outbox.id);
  assert.equal(providerCalls.length, 1, 'a duplicate confirmation never calls the provider again');
});

test('disabled, suppressed, archived, stale, deceptive, and unapproved recipient states fail before provider work', async (t) => {
  const cases = [
    {
      name: 'disabled',
      config: readyConfig({ followUp: { emailEnabled: false } }),
      expectedCode: 'email-disabled',
    },
    {
      name: 'stale',
      config: readyConfig(),
      input: sendInput({ expectedSubmissionVersion: '2026-08-10T15:59:00.000Z' }),
      expectedCode: 'stale-submission',
    },
    {
      name: 'deceptive-new-reply',
      config: readyConfig(),
      input: sendInput({ subject: 'Re: We spoke yesterday' }),
      expectedCode: 'deceptive-subject-prefix',
    },
    {
      name: 'recipient-override',
      config: readyConfig(),
      input: sendInput({ recipient: 'different@example.test' }),
      expectedCode: 'recipient-override-required',
    },
  ];

  for (const item of cases) {
    const storage = await createStorage(t, submission({ id: `${submission().id}-${item.name}` }));
    let providerCalls = 0;
    const result = await sendCrmFollowUpEmail({
      submissionId: `${submission().id}-${item.name}`,
      actor: 'admin@example.test',
      input: item.input || sendInput(),
      storage,
      sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'unexpected' }; },
      config: item.config,
      now: sendAt,
    });
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, item.expectedCode, item.name);
    assert.equal(providerCalls, 0, item.name);
  }

  const suppressedStorage = await createStorage(t, submission({ id: `${submission().id}-suppressed` }));
  await suppressedStorage.upsertEmailSuppression({
    id: 'suppression-1', normalized_email: 'avery@example.test', reason: 'complaint', source: 'resend-webhook',
    created_at: initialAt, created_by: 'email-webhook', metadata: {},
  });
  const suppressed = await sendCrmFollowUpEmail({
    submissionId: `${submission().id}-suppressed`, actor: 'admin@example.test', input: sendInput(),
    storage: suppressedStorage, config: readyConfig(), now: sendAt,
    sender: async () => { throw new Error('must not be called'); },
  });
  assert.equal(suppressed.code, 'recipient-suppressed');

  const archivedStorage = await createStorage(t, submission({ id: `${submission().id}-archived`, status: 'archived' }));
  const archived = await sendCrmFollowUpEmail({
    submissionId: `${submission().id}-archived`, actor: 'admin@example.test', input: sendInput(),
    storage: archivedStorage, config: readyConfig(), now: sendAt,
    sender: async () => { throw new Error('must not be called'); },
  });
  assert.equal(archived.code, 'submission-archived');
});

test('a true reply requires RFC identity and sends bounded In-Reply-To and References', async (t) => {
  const storage = await createStorage(t);
  const parent = await storage.insertCrmCommunication({
    id: 'parent-inbound', submission_id: submission().id, deal_key: null, cim_request_id: null,
    direction: 'inbound', channel: 'email', source: 'resend-webhook', kind: 'broker-reply', provider: 'resend',
    provider_message_id: 'received-provider-id', source_event_id: 'received-event-id', idempotency_key: 'received-idempotency',
    message_id: '<parent-message@example.test>', in_reply_to: '<root-message@example.test>',
    references_json: ['<root-message@example.test>'], parent_communication_id: null,
    thread_key: `${submission().id}:avery@example.test`, legacy_content_unavailable: false,
    content_redaction_state: 'sanitized', recommendation_id: null, outbox_id: null, headers_json: {},
    reply_to_address: 'avery@example.test', from_address: 'Avery <avery@example.test>',
    to_addresses: ['reply@inbound.example.test'], cc_addresses: [], bcc_addresses: [],
    subject: 'Example Manufacturing diligence', body_text: 'Could you share your preferred review time?',
    body_html_sanitized: '', occurred_at: initialAt, created_at: initialAt, updated_at: initialAt,
    delivery_state: 'replied', delivery_state_at: initialAt, content_state: 'complete', content_attempt_count: 1,
    content_last_error: null, content_next_attempt_at: null, attachment_metadata: [], assigned_at: initialAt,
    assigned_by: 'resend-ingestion', created_by: 'resend-ingestion', updated_by: 'resend-ingestion', metadata: {},
  });
  let prepared;
  const result = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput({ parentCommunicationId: parent.id, subject: 'client value is not authoritative for replies' }),
    storage,
    sender: async (message) => { prepared = message; return { status: 'sent', providerMessageId: 'reply-provider-id' }; },
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(result.ok, true);
  assert.equal(prepared.subject, 'Re: Example Manufacturing diligence');
  assert.equal(prepared.headers['In-Reply-To'], '<parent-message@example.test>');
  assert.equal(prepared.headers.References, '<root-message@example.test> <parent-message@example.test>');
  assert.equal(result.communication.parent_communication_id, parent.id);
});

test('ambiguous provider failure is retained without falsely marking delivery failed or permitting a duplicate resend', async (t) => {
  const storage = await createStorage(t);
  let providerCalls = 0;
  const ambiguousSender = async () => {
    providerCalls += 1;
    throw new Error('Resend delivery timed out.');
  };
  const first = await sendCrmFollowUpEmail({
    submissionId: submission().id, actor: 'admin@example.test', input: sendInput(), storage,
    sender: ambiguousSender, config: readyConfig(), now: sendAt,
  });
  assert.equal(first.ok, false);
  assert.equal(first.status, 202);
  assert.equal(first.code, 'provider-ambiguous');
  assert.equal(first.outbox.state, 'ambiguous');
  assert.equal(first.communication.delivery_state, 'not-attempted');

  const replay = await sendCrmFollowUpEmail({
    submissionId: submission().id, actor: 'admin@example.test', input: sendInput(), storage,
    sender: ambiguousSender, config: readyConfig(), now: new Date('2026-08-10T17:02:00.000Z'),
  });
  assert.equal(replay.replayedCommand, true);
  assert.equal(replay.outbox.state, 'ambiguous');
  assert.equal(providerCalls, 1);
});

test('required server compliance content is escaped and cannot be removed by client input', () => {
  const content = buildFollowUpEmailContent({
    bodyText: 'Hello <script>alert(1)</script>',
    config: readyConfig(),
  });
  assert.match(content.bodyText, /123 Main Street/);
  assert.match(content.bodyText, /unsubscribe/);
  assert.doesNotMatch(content.bodyHtmlSanitized, /<script>/);
  assert.match(content.bodyHtmlSanitized, /&lt;script&gt;/);
});

test('storage command failure means the provider is never called', async () => {
  let providerCalls = 0;
  const record = submission();
  const storage = {
    async getSubmission() { return structuredClone(record); },
    async getCrmEmailOutboxByClientRequestKey() { return null; },
    async getActiveEmailSuppression() { return null; },
    async listCrmCommunications() { return { rows: [], total: 0, page: 1, pageSize: 100 }; },
    async listCrmEmailOutbox() { return []; },
    async countCrmFollowUpSends() { return 0; },
    async createCrmEmailCommand() { throw new Error('fixture storage failure'); },
  };
  const result = await sendCrmFollowUpEmail({
    submissionId: record.id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    config: readyConfig(),
    now: sendAt,
    sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'unexpected' }; },
  });
  assert.equal(result.code, 'command-persistence-failed');
  assert.equal(providerCalls, 0);
});

test('preview has no send or persistence side effect', async (t) => {
  const storage = await createStorage(t);
  const preview = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: sendInput(),
    storage,
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(preview.ok, true);
  assert.equal((await storage.listCrmCommunications({ submissionId: submission().id })).total, 0);
  assert.equal(await storage.countCrmEmailOutboxByStates(['queued', 'accepted']), 0);
});

test('sender alignment, suppression-store health, and production reply verification fail closed', async (t) => {
  const storage = await createStorage(t);
  const misaligned = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: sendInput(),
    storage,
    config: readyConfig({ followUp: { senderEmail: 'different@example.test' } }),
    now: sendAt,
  });
  assert.equal(misaligned.code, 'email-unready');
  assert.ok(misaligned.readiness.blockers.includes('sender-alignment'));

  const missingSuppressionStore = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: sendInput(),
    storage: {},
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(missingSuppressionStore.code, 'suppression-readiness-unavailable');

  const unverifiedReply = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: sendInput(),
    storage,
    config: readyConfig({ followUp: { requireVerifiedReply: true } }),
    now: sendAt,
  });
  assert.equal(unverifiedReply.code, 'reply-tracking-unverified');
});

test('a signed server preview binds exact content and workflow choices before one command can be queued', async (t) => {
  const storage = await createStorage(t);
  const signedConfig = readyConfig({ followUp: { requireSignedPreview: true } });
  const preview = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    config: signedConfig,
    now: sendAt,
  });
  assert.match(preview.preview.confirmationToken, /^[A-Za-z0-9_-]{40,}$/);

  let providerCalls = 0;
  const tampered = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput({
      bodyText: 'This body was changed after the exact preview.',
      previewConfirmationToken: preview.preview.confirmationToken,
      previewConfirmationExpiresAt: preview.preview.confirmationExpiresAt,
    }),
    storage,
    config: signedConfig,
    now: sendAt,
    sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
  });
  assert.equal(tampered.code, 'preview-confirmation-invalid');
  assert.equal(providerCalls, 0);
  assert.equal(await storage.countCrmEmailOutboxByStates(['queued', 'accepted']), 0);

  const confirmed = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput({
      previewConfirmationToken: preview.preview.confirmationToken,
      previewConfirmationExpiresAt: preview.preview.confirmationExpiresAt,
    }),
    storage,
    config: signedConfig,
    now: sendAt,
    sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'signed-preview-provider-id' }; },
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.outbox.state, 'accepted');
  assert.equal(providerCalls, 1);
});

test('a signed preview is scoped to the administrator and expires before command persistence', async (t) => {
  const storage = await createStorage(t);
  const signedConfig = readyConfig({ followUp: { requireSignedPreview: true } });
  const preview = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'reviewer@example.test',
    input: sendInput(),
    storage,
    config: signedConfig,
    now: sendAt,
  });

  let providerCalls = 0;
  const wrongActor = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'different-admin@example.test',
    input: sendInput({
      previewConfirmationToken: preview.preview.confirmationToken,
      previewConfirmationExpiresAt: preview.preview.confirmationExpiresAt,
    }),
    storage,
    config: signedConfig,
    now: sendAt,
    sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
  });
  assert.equal(wrongActor.code, 'preview-confirmation-invalid');

  const expired = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'reviewer@example.test',
    input: sendInput({
      clientRequestToken: 'expired-confirmation-token-123456',
      previewConfirmationToken: preview.preview.confirmationToken,
      previewConfirmationExpiresAt: preview.preview.confirmationExpiresAt,
    }),
    storage,
    config: signedConfig,
    now: new Date(Date.parse(preview.preview.confirmationExpiresAt) + 1),
    sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
  });
  assert.equal(expired.code, 'preview-confirmation-expired');
  assert.equal(providerCalls, 0);
  assert.equal(await storage.countCrmEmailOutboxByStates(['queued', 'accepted']), 0);
});

test('a durable queued command revalidates archive and suppression state before provider work', async (t) => {
  const cases = [
    {
      name: 'archived',
      expectedCode: 'submission-archived',
      async mutate(storage, command) {
        await storage.updateSubmission(submission().id, {
          status: 'archived',
          updated_at: new Date(Date.parse(command.outbox.created_at) + 1_000).toISOString(),
        });
      },
    },
    {
      name: 'suppressed',
      expectedCode: 'recipient-suppressed',
      async mutate(storage, command) {
        await storage.upsertEmailSuppression({
          id: 'late-suppression',
          normalized_email: 'avery@example.test',
          reason: 'complaint',
          source: 'provider-lifecycle',
          created_at: new Date(Date.parse(command.outbox.created_at) + 1_000).toISOString(),
          created_by: 'email-webhook',
          metadata: {},
        });
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (nested) => {
      const storage = await createStorage(nested);
      const queued = await sendCrmFollowUpEmail({
        submissionId: submission().id,
        actor: 'admin@example.test',
        input: sendInput(),
        storage,
        config: readyConfig(),
        now: sendAt,
        processImmediately: false,
      });
      assert.equal(queued.outbox.state, 'queued');
      await item.mutate(storage, queued);
      let providerCalls = 0;
      const processed = await processCrmEmailOutbox({
        outboxId: queued.outbox.id,
        storage,
        config: readyConfig(),
        now: new Date(Date.parse(queued.outbox.created_at) + 2_000),
        sender: async () => { providerCalls += 1; return { status: 'sent', providerMessageId: 'must-not-send' }; },
      });
      assert.equal(processed.code, item.expectedCode);
      assert.equal(processed.outbox.state, 'cancelled');
      assert.equal(providerCalls, 0);
    });
  }
});

test('maximum touches and configured cadence are hard send-policy gates', async (t) => {
  const storage = await createStorage(t);
  const first = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    config: readyConfig(),
    now: sendAt,
    sender: async () => ({ status: 'sent', providerMessageId: 'first-touch-provider-id' }),
  });
  assert.equal(first.ok, true);
  await storage.updateCrmCommunication(first.communication.id, {
    delivery_state: 'delivered',
    delivery_state_at: sendAt.toISOString(),
    updated_at: sendAt.toISOString(),
    updated_by: 'test-webhook',
  });
  const secondAt = new Date(sendAt.getTime() + 24 * 60 * 60 * 1_000);
  const current = await storage.getSubmission(submission().id);
  await storage.updateSubmission(submission().id, {
    follow_up_state: 'needs-response',
    next_action_at: secondAt.toISOString(),
    updated_at: new Date(Date.parse(current.updated_at) + 1_000).toISOString(),
  });
  const reopened = await storage.getSubmission(submission().id);
  const nextInput = sendInput({
    clientRequestToken: 'second-confirmation-token-123456',
    expectedSubmissionVersion: reopened.updated_at,
  });

  const maxTouches = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: nextInput,
    storage,
    config: readyConfig({ followUp: { maxTouches: 1 } }),
    now: secondAt,
  });
  assert.equal(maxTouches.code, 'maximum-follow-up-touches-reached');

  const cadence = await previewCrmFollowUpEmail({
    submissionId: submission().id,
    input: nextInput,
    storage,
    config: readyConfig({ followUp: { maxTouches: 3, cadenceHours: [48, 72, 96] } }),
    now: secondAt,
  });
  assert.equal(cadence.code, 'follow-up-cadence');
});

test('durable provider acceptance remains successful when communication reconciliation needs a retry', async (t) => {
  const storage = await createStorage(t);
  const originalUpdate = storage.updateCrmCommunication.bind(storage);
  let updateAttempts = 0;
  storage.updateCrmCommunication = async (...args) => {
    updateAttempts += 1;
    if (updateAttempts === 1) throw new Error('simulated communication reconciliation outage');
    return originalUpdate(...args);
  };
  const result = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput(),
    storage,
    config: readyConfig(),
    now: sendAt,
    sender: async () => ({ status: 'sent', providerMessageId: 'accepted-needs-reconciliation' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outbox.state, 'accepted');
  assert.equal(result.reconciliationRequired, true);
  assert.equal((await storage.getCrmEmailOutbox(result.outbox.id)).provider_message_id, 'accepted-needs-reconciliation');
});

test('linked manual send atomically takes over Deal Hunter automation and a scheduler claim conflicts before provider work', async (t) => {
  const storage = await createStorage(t);
  const cimRequest = {
    id: 'manual-takeover-cim-request',
    created_at: initialAt,
    updated_at: initialAt,
    deal_key: 'deal-key-manual-takeover',
    recipient_email: 'avery@example.test',
    requested_by: 'admin@example.test',
    status: 'sent',
    delivery_error: null,
    provider_message_id: 'provider-cim-initial',
    subject: 'CIM / NDA request for Example Manufacturing',
    deal_name: 'Example Manufacturing',
    source_name: 'Test marketplace',
    listing_url: 'https://example.test/listing',
    score: 88,
    follow_up_count: 1,
    next_follow_up_at: '2026-08-11T17:00:00.000Z',
    submission_id: submission().id,
    request_state: 'provider_accepted',
    delivery_state: 'delivered',
    delivery_state_at: '2026-08-10T16:30:00.000Z',
    follow_up_state: 'scheduled',
    metadata: {},
  };
  await storage.upsertDealHunterCimRequest(cimRequest);
  const providerCalls = [];
  const accepted = await sendCrmFollowUpEmail({
    submissionId: submission().id,
    actor: 'admin@example.test',
    input: sendInput({
      cimRequestId: cimRequest.id,
      dealKey: cimRequest.deal_key,
      manualTakeoverAcknowledged: true,
    }),
    storage,
    sender: async (message) => {
      providerCalls.push(message);
      return { status: 'sent', providerMessageId: 'provider-manual-takeover' };
    },
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(accepted.ok, true);
  assert.equal(providerCalls.length, 1);
  const takenOver = await storage.getLatestDealHunterCimRequestForSubmission(submission().id);
  assert.equal(takenOver.request_state, 'manual_takeover');
  assert.equal(takenOver.follow_up_state, 'stopped');
  assert.equal(takenOver.next_follow_up_at, null);
  assert.equal(takenOver.follow_up_count, 2, 'the manual email consumes a reporting sequence touch');
  assert.equal(accepted.communication.cim_request_id, cimRequest.id);

  const raceStorage = await createStorage(t, submission({ id: 'scheduler-race-submission' }));
  await raceStorage.upsertDealHunterCimRequest({
    ...cimRequest,
    id: 'scheduler-race-cim-request',
    submission_id: 'scheduler-race-submission',
    deal_key: 'scheduler-race-deal',
    status: 'follow_up_pending',
  });
  let raceProviderCalls = 0;
  const conflict = await sendCrmFollowUpEmail({
    submissionId: 'scheduler-race-submission',
    actor: 'admin@example.test',
    input: sendInput({
      cimRequestId: 'scheduler-race-cim-request',
      dealKey: 'scheduler-race-deal',
      manualTakeoverAcknowledged: true,
    }),
    storage: raceStorage,
    sender: async () => {
      raceProviderCalls += 1;
      return { status: 'sent', providerMessageId: 'must-not-send' };
    },
    config: readyConfig(),
    now: sendAt,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'cim-send-in-progress');
  assert.equal(raceProviderCalls, 0);
  assert.equal((await raceStorage.listCrmCommunications({ submissionId: 'scheduler-race-submission' })).total, 0);
});
