import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

const signingKey = Buffer.from('fixture-resend-webhook-signing-key');
process.env.EMAIL_WEBHOOK_SECRET = `whsec_${signingKey.toString('base64')}`;
process.env.RESEND_API_KEY = 're_fixture_received_email_key';
process.env.ADMIN_SESSION_SECRET = 'fixture-session-secret';

const {
  recordEmailEvent,
  recordEmailEventsFromWebhook,
  summarizeEmailEngagement,
} = await import('../server/services/emailEvents.js');
const {
  applyEmailLifecycleToCommunication,
  createManualCommunication,
  getCommunicationOperationsStatus,
  listUnassignedCommunications,
  retryPendingInboundIngestion,
} = await import('../server/services/communications.js');

function clone(value) {
  return structuredClone(value);
}

function contactEmails(submission) {
  return [
    submission.broker_email,
    submission.seller_email,
    submission.email,
    ...(Array.isArray(submission.contact_emails) ? submission.contact_emails : []),
  ].filter(Boolean).map((email) => String(email).toLowerCase());
}

function createStorage({ submissions = [], communications = [], cimRequests = [] } = {}) {
  const state = {
    activities: [],
    cimRequests: cimRequests.map(clone),
    communications: communications.map(clone),
    emailEvents: [],
    recommendationsSuperseded: [],
    suppressions: [],
    submissions: submissions.map(clone),
  };
  const closedStatuses = new Set(['archived', 'deleted', 'rejected', 'spam']);

  async function insertEmailEvent(event) {
    const existing = state.emailEvents.find((item) => item.event_key && item.event_key === event.event_key);
    if (existing) return clone(existing);
    state.emailEvents.push(clone(event));
    return clone(event);
  }

  async function insertCommunication(communication) {
    const existing = state.communications.find((item) =>
      item.provider === communication.provider
      && item.provider_message_id === communication.provider_message_id
      && item.direction === communication.direction);
    if (existing) return clone(existing);
    state.communications.push(clone(communication));
    return clone(communication);
  }

  const storage = {
    state,
    async getSubmission(id) {
      return clone(state.submissions.find((submission) => submission.id === id) || null);
    },
    async listSubmissionsByContactEmail(email, { limit = 3, openOnly = false } = {}) {
      const normalized = String(email || '').toLowerCase();
      return state.submissions
        .filter((submission) => contactEmails(submission).includes(normalized))
        .filter((submission) => !openOnly || !closedStatuses.has(submission.status))
        .slice(0, limit)
        .map(clone);
    },
    async getSubmissionByContactEmail() {
      throw new Error('Newest-contact fallback must not be used.');
    },
    insertEmailEvent,
    async mutateWithCrmActivity({ operation, payload, activity }) {
      if (operation === 'insert_email_event') {
        const before = state.emailEvents.length;
        const record = await insertEmailEvent(payload.event);
        const applied = state.emailEvents.length > before;
        if (applied) state.activities.push(clone(activity));
        return { applied, record, activity: applied ? clone(activity) : null };
      }
      if (operation === 'insert_crm_communication') {
        const before = state.communications.length;
        const record = await insertCommunication(payload.communication);
        const applied = state.communications.length > before;
        if (applied) state.activities.push(clone(activity));
        return { applied, record, activity: applied ? clone(activity) : null };
      }
      if (operation === 'assign_crm_communication') {
        const index = state.communications.findIndex((item) => item.id === payload.id);
        if (index < 0 || state.communications[index].submission_id) {
          return { applied: false, record: index < 0 ? null : clone(state.communications[index]), activity: null };
        }
        state.communications[index] = {
          ...state.communications[index],
          submission_id: payload.submissionId,
          deal_key: payload.dealKey || state.communications[index].deal_key,
          cim_request_id: payload.cimRequestId || state.communications[index].cim_request_id,
          assigned_at: payload.updatedAt,
          assigned_by: payload.assignedBy,
          updated_at: payload.updatedAt,
          updated_by: payload.assignedBy,
          metadata: payload.metadata || state.communications[index].metadata,
        };
        state.activities.push(clone(activity));
        return { applied: true, record: clone(state.communications[index]), activity: clone(activity) };
      }
      if (operation === 'upsert_deal_hunter_cim_request') {
        const request = clone(payload.request);
        const index = state.cimRequests.findIndex((item) => item.id === request.id);
        if (index >= 0) state.cimRequests[index] = request;
        else state.cimRequests.push(request);
        state.activities.push(clone(activity));
        return { applied: true, record: clone(request), activity: clone(activity) };
      }
      throw new Error(`Unsupported test mutation: ${operation}`);
    },
    async getCrmCommunication(id) {
      return clone(state.communications.find((communication) => communication.id === id) || null);
    },
    async getDealHunterCimRequestById(id) {
      return clone(state.cimRequests.find((request) => request.id === id) || null);
    },
    async getDealHunterCimRequestByReplyToAddress(address, requestToken = '') {
      const normalizedAddress = String(address || '').toLowerCase();
      return clone(state.cimRequests.find((request) =>
        String(request.reply_to_address || '').toLowerCase() === normalizedAddress
        && (!requestToken || request.id === requestToken)) || null);
    },
    async upsertDealHunterCimRequest(request) {
      const index = state.cimRequests.findIndex((item) => item.id === request.id);
      if (index >= 0) state.cimRequests[index] = clone(request);
      else state.cimRequests.push(clone(request));
      return clone(request);
    },
    async getCrmCommunicationByProviderMessage(provider, messageId, direction) {
      return clone(state.communications.find((communication) =>
        communication.provider === provider
        && communication.provider_message_id === messageId
        && (!direction || communication.direction === direction)) || null);
    },
    async getCrmCommunicationByMessageId(messageId) {
      return clone(state.communications.find((communication) => communication.message_id === messageId) || null);
    },
    async supersedeCrmFollowUpRecommendations(submissionId, supersededAt) {
      state.recommendationsSuperseded.push({ submissionId, supersededAt });
      return 1;
    },
    async upsertEmailSuppression(suppression) {
      const normalizedEmail = String(suppression.normalized_email || '').toLowerCase();
      const index = state.suppressions.findIndex((item) => item.normalized_email === normalizedEmail);
      const record = { ...clone(suppression), normalized_email: normalizedEmail, lifted_at: null };
      if (index >= 0) state.suppressions[index] = record;
      else state.suppressions.push(record);
      return clone(record);
    },
    insertCrmCommunication: insertCommunication,
    async updateCrmCommunication(id, updates) {
      const index = state.communications.findIndex((communication) => communication.id === id);
      if (index < 0) return null;
      state.communications[index] = { ...state.communications[index], ...clone(updates) };
      return clone(state.communications[index]);
    },
    async listCrmCommunications({ cimRequestId = '', unassigned = false, direction = '', pageSize = 25 } = {}) {
      const rows = state.communications
        .filter((communication) => !cimRequestId || communication.cim_request_id === cimRequestId)
        .filter((communication) => !unassigned || !communication.submission_id)
        .filter((communication) => !direction || communication.direction === direction)
        .slice(0, pageSize)
        .map(clone);
      return { rows, total: rows.length, page: 1, pageSize };
    },
    async listCrmCommunicationsPendingIngestion({ dueBefore, limit = 25 } = {}) {
      const dueAt = Date.parse(dueBefore || '');
      return state.communications
        .filter((communication) => ['pending', 'failed'].includes(communication.content_state))
        .filter((communication) => Date.parse(communication.content_next_attempt_at || '') <= dueAt)
        .slice(0, limit)
        .map(clone);
    },
    async countCrmCommunications({ contentStates = [], unassigned = false, direction = '' } = {}) {
      return state.communications
        .filter((communication) => contentStates.length === 0 || contentStates.includes(communication.content_state))
        .filter((communication) => !unassigned || !communication.submission_id)
        .filter((communication) => !direction || communication.direction === direction)
        .length;
    },
  };

  return storage;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return clone(body);
    },
  };
}

function sharedSecretRequest(body) {
  return {
    body,
    rawBody: JSON.stringify(body),
    headers: { 'x-webhook-secret': process.env.EMAIL_WEBHOOK_SECRET },
  };
}

function signedRequest(body, svixId) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', signingKey)
    .update(`${svixId}.${timestamp}.${rawBody}`)
    .digest('base64');
  return {
    body,
    rawBody,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}

function receivedPayload({
  id = 'evt-received-1',
  emailId = 'received-email-1',
  from = 'Broker <broker@example.com>',
  to = ['deals@inbound.example.com'],
} = {}) {
  return {
    id,
    type: 'email.received',
    created_at: '2026-08-06T16:00:00.000Z',
    data: {
      email_id: emailId,
      message_id: `<${emailId}@resend.example>`,
      from,
      to,
      subject: 'Re: CIM request',
    },
  };
}

test('received email uses only the fixed Resend API, persists bounded body and attachment metadata, and replays idempotently', async () => {
  const storage = createStorage({
    submissions: [{ id: 'submission-1', status: 'new', company: 'Unique Broker Co', broker_email: 'broker@example.com' }],
  });
  const requestedUrls = [];
  const fetcher = async (url, options) => {
    requestedUrls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${process.env.RESEND_API_KEY}`);
    if (url.endsWith('/attachments')) {
      return response({
        data: [{
          id: 'attachment-1',
          filename: 'overview.pdf',
          content_type: 'application/pdf',
          size: 2048,
          download_url: 'https://temporary-secret.example/download',
        }],
      });
    }
    return response({
      id: 'received-email-1',
      from: 'Broker <broker@example.com>',
      to: ['deals@inbound.example.com'],
      cc: ['assistant@example.com'],
      subject: 'Re: CIM request',
      text: 'Confidential inbound message body.',
      html: '<p>Confidential inbound message body.</p><script>bad()</script>',
      headers: {
        'in-reply-to': '<outbound-message@example>',
        'message-id': '<inbound-message@example>',
        references: '<earlier-message@example> <outbound-message@example>',
      },
      attachments: [{ id: 'attachment-1' }],
      created_at: '2026-08-06T16:00:00.000Z',
    });
  };
  const request = sharedSecretRequest(receivedPayload());

  const first = await recordEmailEventsFromWebhook(request, { storage, fetcher });
  const replay = await recordEmailEventsFromWebhook(request, { storage, fetcher });

  assert.equal(first.ok, true);
  assert.equal(first.status, 201);
  assert.equal(replay.ok, true);
  assert.equal(storage.state.emailEvents.length, 1);
  assert.equal(storage.state.communications.length, 1);
  assert.deepEqual(requestedUrls, [
    'https://api.resend.com/emails/receiving/received-email-1',
    'https://api.resend.com/emails/receiving/received-email-1/attachments',
  ]);

  const communication = storage.state.communications[0];
  assert.equal(communication.submission_id, 'submission-1');
  assert.equal(communication.content_state, 'complete');
  assert.equal(communication.body_text, 'Confidential inbound message body.');
  assert.equal(communication.body_html_sanitized, '');
  assert.equal(communication.in_reply_to, '<outbound-message@example>');
  assert.equal(communication.message_id, '<inbound-message@example>');
  assert.deepEqual(communication.references_json, ['<earlier-message@example>', '<outbound-message@example>']);
  assert.equal(communication.headers_json['message-id'], '<inbound-message@example>');
  assert.equal(communication.metadata.messageId, '<inbound-message@example>');
  assert.equal(communication.metadata.references, '<earlier-message@example> <outbound-message@example>');
  assert.equal(communication.attachment_metadata.length, 1);
  assert.deepEqual(communication.attachment_metadata[0], {
    id: 'attachment-1',
    filename: 'overview.pdf',
    contentType: 'application/pdf',
    contentDisposition: '',
    contentId: '',
    size: 2048,
  });
  assert.equal(JSON.stringify(communication).includes('temporary-secret.example'), false);
  assert.equal(JSON.stringify(first).includes('Confidential inbound message body.'), false);
  assert.equal(storage.state.recommendationsSuperseded.length > 0, true);
});

test('RFC In-Reply-To assigns a shared-address reply only to the unique matching CRM thread', async () => {
  const parent = {
    id: 'thread-parent-1',
    submission_id: 'submission-rfc-1',
    direction: 'outbound',
    channel: 'email',
    source: 'manual',
    provider: 'resend',
    provider_message_id: 'sent-provider-1',
    message_id: '<sent-rfc-message@example.test>',
    thread_key: 'thread-rfc-1',
    to_addresses: ['shared@example.com'],
    from_address: 'outreach@example.test',
    subject: 'Diligence question',
    body_text: 'Could you share the CIM?',
    body_html_sanitized: '',
    occurred_at: '2026-08-06T15:00:00.000Z',
    created_at: '2026-08-06T15:00:00.000Z',
    updated_at: '2026-08-06T15:00:00.000Z',
    delivery_state: 'delivered',
    content_state: 'complete',
    references_json: [],
    attachment_metadata: [],
    metadata: {},
  };
  const storage = createStorage({
    submissions: [
      { id: 'submission-rfc-1', status: 'review', company: 'First Shared Co', broker_email: 'shared@example.com' },
      { id: 'submission-rfc-2', status: 'review', company: 'Second Shared Co', broker_email: 'shared@example.com' },
    ],
    communications: [parent],
  });
  const fetcher = async (url) => {
    if (url.endsWith('/attachments')) return response({ data: [] });
    return response({
      id: 'received-rfc-1',
      from: 'Shared Broker <shared@example.com>',
      to: ['deals@inbound.example.com'],
      subject: 'Re: Diligence question',
      text: 'Yes, I can share it after the NDA.',
      headers: {
        'message-id': '<received-rfc-message@example.test>',
        'in-reply-to': '<sent-rfc-message@example.test>',
        references: '<sent-rfc-message@example.test>',
      },
      attachments: [],
      created_at: '2026-08-06T16:00:00.000Z',
    });
  };
  const result = await recordEmailEventsFromWebhook(
    sharedSecretRequest(receivedPayload({
      id: 'evt-rfc-1',
      emailId: 'received-rfc-1',
      from: 'Shared Broker <shared@example.com>',
    })),
    { storage, fetcher },
  );
  assert.equal(result.ok, true);
  const inbound = storage.state.communications.find((communication) => communication.direction === 'inbound');
  assert.equal(inbound.submission_id, 'submission-rfc-1');
  assert.equal(inbound.parent_communication_id, parent.id);
  assert.equal(inbound.thread_key, parent.thread_key);
  assert.equal(inbound.metadata.assignmentMethod, 'rfc-thread');
});

test('an obvious new inbound opt-out suppresses globally while quoted historical text does not', async () => {
  const makeStorage = () => createStorage({
    submissions: [{ id: 'submission-optout-1', status: 'review', company: 'Opt Out Co', broker_email: 'broker@example.com' }],
  });
  const directStorage = makeStorage();
  const directFetcher = async (url) => url.endsWith('/attachments')
    ? response({ data: [] })
    : response({
        id: 'received-optout-direct', from: 'Broker <broker@example.com>', to: ['deals@inbound.example.com'],
        subject: 'Re: Diligence', text: 'Stop.',
        headers: { 'message-id': '<optout-direct@example.test>' }, attachments: [],
        created_at: '2026-08-06T16:00:00.000Z',
      });
  await recordEmailEventsFromWebhook(
    sharedSecretRequest(receivedPayload({ id: 'evt-optout-direct', emailId: 'received-optout-direct' })),
    { storage: directStorage, fetcher: directFetcher },
  );
  assert.equal(directStorage.state.suppressions.length, 1);
  assert.equal(directStorage.state.suppressions[0].reason, 'explicit-opt-out');
  assert.equal(directStorage.state.suppressions[0].normalized_email, 'broker@example.com');

  const quotedStorage = makeStorage();
  const quotedFetcher = async (url) => url.endsWith('/attachments')
    ? response({ data: [] })
    : response({
        id: 'received-optout-quoted', from: 'Broker <broker@example.com>', to: ['deals@inbound.example.com'],
        subject: 'Re: Diligence', text: 'Thanks, Tuesday works.\n\n> Please unsubscribe me from all outreach.',
        headers: { 'message-id': '<optout-quoted@example.test>' }, attachments: [],
        created_at: '2026-08-06T16:05:00.000Z',
      });
  await recordEmailEventsFromWebhook(
    sharedSecretRequest(receivedPayload({ id: 'evt-optout-quoted', emailId: 'received-optout-quoted' })),
    { storage: quotedStorage, fetcher: quotedFetcher },
  );
  assert.equal(quotedStorage.state.suppressions.length, 0);
});

test('an archived CRM record rejects a follow-up-only manual workflow update before communication persistence', async () => {
  const storage = createStorage({
    submissions: [{
      id: 'archived-submission-1',
      status: 'archived',
      company: 'Archived Services',
      updated_at: '2026-08-06T12:00:00.000Z',
      follow_up_state: 'completed',
    }],
  });

  const rejected = await createManualCommunication({
    submissionId: 'archived-submission-1',
    actor: 'archive-admin',
    storage,
    input: {
      direction: 'inbound',
      channel: 'phone',
      occurredAt: '2026-08-06T13:00:00.000Z',
      bodyText: 'Broker called after the record was archived.',
      followUpState: 'scheduled',
    },
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
  assert.match(rejected.error, /archived CRM records/i);
  assert.equal(storage.state.communications.length, 0);
  assert.equal(storage.state.activities.length, 0);

  const loggedWithoutWorkflow = await createManualCommunication({
    submissionId: 'archived-submission-1',
    actor: 'archive-admin',
    storage,
    input: {
      direction: 'inbound',
      channel: 'phone',
      occurredAt: '2026-08-06T13:05:00.000Z',
      bodyText: 'Broker called after the record was archived.',
    },
  });
  assert.equal(loggedWithoutWorkflow.ok, true);
  assert.equal(loggedWithoutWorkflow.workflowUpdated, false);
  assert.equal(storage.state.communications.length, 1);
});

test('request-specific reply alias wins before a shared broker-email fallback and preserves outbound delivery state', async () => {
  const replyAlias = 'cim-request-alias-001@inbound.example.com';
  const storage = createStorage({
    submissions: [
      { id: 'submission-a', status: 'review', company: 'First Shared Listing', broker_email: 'shared@example.com' },
      { id: 'submission-b', status: 'review', company: 'Exact Alias Listing', broker_email: 'shared@example.com' },
    ],
    cimRequests: [{
      id: 'request-alias-001',
      submission_id: 'submission-b',
      deal_key: 'deal-b',
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'delivered',
      delivery_state_at: '2026-08-06T15:00:00.000Z',
      delivered_at: '2026-08-06T15:00:00.000Z',
      reply_to_address: replyAlias,
      follow_up_state: 'scheduled',
      metadata: {},
    }],
  });
  const fetcher = async () => response({
    id: 'received-alias-1',
    from: 'Shared Desk <shared@example.com>',
    to: [replyAlias],
    subject: 'Re: Exact CIM request',
    text: 'This response belongs to the second listing.',
    attachments: [{
      id: 'private-attachment-id',
      filename: 'confidential-listing-name.pdf',
      content_type: 'application/pdf',
      size: 1234,
    }],
    created_at: '2026-08-06T16:00:00.000Z',
  });

  const result = await recordEmailEventsFromWebhook(sharedSecretRequest(receivedPayload({
    id: 'evt-alias-1',
    emailId: 'received-alias-1',
    from: 'Shared Desk <shared@example.com>',
    to: [replyAlias],
  })), { storage, fetcher });

  assert.equal(result.ok, true);
  assert.equal(storage.state.emailEvents[0].submission_id, 'submission-b');
  assert.equal(storage.state.communications[0].submission_id, 'submission-b');
  assert.equal(storage.state.communications[0].cim_request_id, 'request-alias-001');
  const request = storage.state.cimRequests[0];
  assert.equal(request.request_state, 'responded');
  assert.equal(request.follow_up_state, 'stopped');
  assert.equal(request.delivery_state, 'delivered');
  assert.equal(request.delivery_state_at, '2026-08-06T15:00:00.000Z');
});

test('ambiguous shared broker email remains unassigned instead of selecting the newest CRM record', async () => {
  const storage = createStorage({
    submissions: [
      { id: 'submission-a', status: 'new', company: 'First Listing', broker_email: 'shared@example.com' },
      { id: 'submission-b', status: 'qualified', company: 'Second Listing', broker_email: 'shared@example.com' },
    ],
  });
  const fetcher = async () => response({
    id: 'received-shared-1',
    from: 'Shared Desk <shared@example.com>',
    to: ['deals@inbound.example.com'],
    subject: 'Re: Listing information',
    text: 'Which listing did you mean?',
    attachments: [{
      id: 'private-attachment-id',
      filename: 'confidential-listing-name.pdf',
      content_type: 'application/pdf',
      size: 1234,
    }],
  });

  const result = await recordEmailEventsFromWebhook(sharedSecretRequest(receivedPayload({
    id: 'evt-shared-1',
    emailId: 'received-shared-1',
    from: 'Shared Desk <shared@example.com>',
  })), { storage, fetcher });

  assert.equal(result.ok, true);
  assert.equal(storage.state.emailEvents[0].submission_id, null);
  assert.equal(storage.state.communications[0].submission_id, null);
  assert.equal(storage.state.communications[0].metadata.assignmentMethod, 'unassigned');
  const inbox = await listUnassignedCommunications({ storage });
  assert.equal(inbox.rows[0].attachment_count, 1);
  assert.equal(inbox.rows[0].body_preview, 'Which listing did you mean?');
  assert.deepEqual(Object.keys(inbox.rows[0]).sort(), [
    'attachment_count',
    'body_preview',
    'candidates',
    'from_address',
    'id',
    'occurred_at',
    'subject',
    'to_addresses',
  ]);
  assert.equal(JSON.stringify(inbox).includes('confidential-listing-name.pdf'), false);
  assert.equal(JSON.stringify(inbox).includes('provider_message_id'), false);
});

test('received content failure is acknowledged as pending retry and exposed only as sanitized Operations counts', async () => {
  const storage = createStorage();
  const body = receivedPayload({ id: 'evt-retry-1', emailId: 'received-retry-1', from: 'Unknown <unknown@example.com>' });
  const failed = await recordEmailEventsFromWebhook(sharedSecretRequest(body), {
    storage,
    fetcher: async (url) => {
      assert.equal(url, 'https://api.resend.com/emails/receiving/received-retry-1');
      return response({ privateProviderDetail: 'must not escape' }, 503);
    },
  });

  assert.equal(failed.ok, true);
  assert.equal(failed.status, 201);
  assert.deepEqual(failed.ingestion, [{
    eventId: storage.state.emailEvents[0].id,
    accepted: true,
    pendingRetry: true,
  }]);
  assert.equal(failed.error, undefined);
  assert.equal(storage.state.communications[0].content_state, 'failed');
  assert.equal(storage.state.communications[0].content_attempt_count, 1);
  assert.ok(storage.state.communications[0].content_next_attempt_at);
  assert.equal(JSON.stringify(failed).includes('privateProviderDetail'), false);
  assert.deepEqual(await getCommunicationOperationsStatus({ storage }), {
    pending: 0,
    failed: 1,
    unassigned: 1,
  });

  const retryNow = new Date(Date.now() + 16 * 60 * 1000);
  const listPending = storage.listCrmCommunicationsPendingIngestion.bind(storage);
  let claimOptions = null;
  storage.claimCrmCommunicationsPendingIngestion = async (options) => {
    claimOptions = clone(options);
    return listPending(options);
  };
  storage.listCrmCommunicationsPendingIngestion = async () => {
    throw new Error('plain pending-ingestion list must not run when the claim contract is available');
  };
  const retried = await retryPendingInboundIngestion({
    storage,
    now: retryNow,
    fetcher: async (url) => {
      assert.equal(url, 'https://api.resend.com/emails/receiving/received-retry-1');
      return response({
        id: 'received-retry-1',
        from: 'Unknown <unknown@example.com>',
        to: ['deals@inbound.example.com'],
        subject: 'Re: CIM request',
        text: 'Retry succeeded.',
        attachments: [],
      });
    },
  });

  assert.deepEqual({ reviewed: retried.reviewed, completed: retried.completed, failed: retried.failed }, {
    reviewed: 1,
    completed: 1,
    failed: 0,
  });
  assert.deepEqual(claimOptions, {
    dueBefore: retryNow.toISOString(),
    limit: 25,
    leaseUntil: new Date(retryNow.getTime() + 5 * 60 * 1000).toISOString(),
  });
  assert.equal(storage.state.communications[0].content_state, 'complete');
  assert.equal(storage.state.communications[0].body_text, 'Retry succeeded.');
});

test('scheduled content retry re-resolves the fetched reply alias and stops the exact CIM follow-up', async () => {
  const replyAlias = 'cim-request-retry-alias-01@inbound.example.com';
  const storage = createStorage({
    submissions: [
      { id: 'retry-submission-a', status: 'review', company: 'Shared Retry A', broker_email: 'shared-retry@example.com' },
      { id: 'retry-submission-b', status: 'review', company: 'Shared Retry B', broker_email: 'shared-retry@example.com' },
    ],
    cimRequests: [{
      id: 'request-retry-alias-01',
      submission_id: 'retry-submission-b',
      deal_key: 'retry-deal-b',
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'delivered',
      delivery_state_at: '2026-08-06T15:00:00.000Z',
      delivered_at: '2026-08-06T15:00:00.000Z',
      reply_to_address: replyAlias,
      follow_up_state: 'scheduled',
      next_follow_up_at: '2026-08-08T15:00:00.000Z',
      metadata: {},
    }],
  });
  const body = receivedPayload({
    id: 'evt-retry-alias-1',
    emailId: 'received-retry-alias-1',
    from: 'Unknown Webhook Sender <unknown@example.com>',
    to: ['deals@inbound.example.com'],
  });
  const failed = await recordEmailEventsFromWebhook(sharedSecretRequest(body), {
    storage,
    fetcher: async () => response({}, 503),
  });
  assert.equal(failed.ok, true);
  assert.equal(storage.state.communications[0].submission_id, null);
  assert.equal(storage.state.communications[0].content_state, 'failed');

  const retried = await retryPendingInboundIngestion({
    storage,
    now: new Date(Date.now() + 16 * 60 * 1000),
    fetcher: async () => response({
      id: 'received-retry-alias-1',
      from: 'Shared Retry Desk <shared-retry@example.com>',
      to: [replyAlias],
      subject: 'Re: Exact retry alias',
      text: 'The retry now has enough content to route safely.',
      attachments: [],
      created_at: '2026-08-06T16:00:00.000Z',
    }),
  });

  assert.equal(retried.completed, 1);
  assert.equal(storage.state.communications[0].submission_id, 'retry-submission-b');
  assert.equal(storage.state.communications[0].cim_request_id, 'request-retry-alias-01');
  assert.equal(storage.state.communications[0].metadata.assignmentMethod, 'cim-reply-alias');
  const request = storage.state.cimRequests[0];
  assert.equal(request.request_state, 'responded');
  assert.equal(request.follow_up_state, 'stopped');
  assert.equal(request.next_follow_up_at, null);
  assert.equal(request.delivery_state, 'delivered');
  assert.ok(storage.state.activities.some((activity) => activity.event_type === 'communication.assigned'));
  assert.ok(storage.state.activities.some((activity) => activity.event_type === 'cim.response-received'));
});

test('received content and generic email-event metadata are byte bounded before durable storage', async () => {
  const storage = createStorage();
  const oversizedPayload = JSON.stringify({
    id: 'received-oversized-1',
    from: 'Unknown <unknown@example.com>',
    to: ['deals@inbound.example.com'],
    subject: 'Oversized inbound payload',
    text: 'x'.repeat(600 * 1024),
    attachments: [],
  });
  const inbound = await recordEmailEventsFromWebhook(sharedSecretRequest(receivedPayload({
    id: 'evt-oversized-1',
    emailId: 'received-oversized-1',
    from: 'Unknown <unknown@example.com>',
  })), {
    storage,
    fetcher: async () => new Response(oversizedPayload, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  assert.equal(inbound.ok, true);
  assert.equal(storage.state.communications[0].content_state, 'failed');
  assert.equal(storage.state.communications[0].body_text, '');

  const event = await recordEmailEvent({
    id: 'event-large-metadata-1',
    provider: 'resend',
    eventType: 'delivered',
    messageId: 'message-large-metadata-1',
    metadata: {
      hugeUntrustedValue: 'z'.repeat(80 * 1024),
      tracking: {
        communicationId: 'communication-large-metadata-1',
        cimRequestId: 'request-large-metadata-1',
      },
    },
  }, { storage });
  assert.equal(event.metadata.truncated, true);
  assert.equal(event.metadata.tracking.communicationId, 'communication-large-metadata-1');
  assert.ok(Buffer.byteLength(JSON.stringify(event.metadata), 'utf8') <= 32 * 1024);
});

test('Svix ID is durable and timestamp ordering rejects stale delivery events while allowing newer correction', async () => {
  const storage = createStorage({
    communications: [{
      id: 'communication-outbound-1',
      submission_id: 'submission-1',
      cim_request_id: 'cim-request-outbound-1',
      direction: 'outbound',
      channel: 'email',
      provider: 'resend',
      provider_message_id: 'outbound-email-1',
      delivery_state: 'accepted',
      delivery_state_at: '2026-08-06T15:00:00.000Z',
      updated_at: '2026-08-06T15:00:00.000Z',
      metadata: {},
    }],
    cimRequests: [{
      id: 'cim-request-outbound-1',
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'accepted',
      delivery_error: '',
      follow_up_state: 'scheduled',
      metadata: {},
    }],
  });
  const bounced = {
    id: 'payload-bounce-id',
    type: 'email.bounced',
    created_at: '2026-08-06T17:00:00.000Z',
    data: { email_id: 'outbound-email-1', to: ['broker@example.com'] },
  };
  const olderDelivered = {
    id: 'payload-delivered-id',
    type: 'email.delivered',
    created_at: '2026-08-06T16:00:00.000Z',
    data: { email_id: 'outbound-email-1', to: ['broker@example.com'] },
  };
  const sameTimeDelivered = {
    id: 'payload-same-time-delivered-id',
    type: 'email.delivered',
    created_at: '2026-08-06T17:00:00.000Z',
    data: { email_id: 'outbound-email-1', to: ['broker@example.com'] },
  };
  const newerDelivered = {
    id: 'payload-newer-delivered-id',
    type: 'email.delivered',
    created_at: '2026-08-06T18:00:00.000Z',
    data: { email_id: 'outbound-email-1', to: ['broker@example.com'] },
  };

  assert.equal((await recordEmailEventsFromWebhook(signedRequest(bounced, 'svix-bounce-id'), { storage })).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(signedRequest(olderDelivered, 'svix-delivered-id'), { storage })).ok, true);
  assert.equal((await recordEmailEventsFromWebhook(signedRequest(sameTimeDelivered, 'svix-same-time-delivered-id'), { storage })).ok, true);

  let communication = storage.state.communications[0];
  assert.equal(communication.delivery_state, 'bounced');
  assert.equal(communication.delivery_state_at, '2026-08-06T17:00:00.000Z');

  assert.equal((await recordEmailEventsFromWebhook(signedRequest(newerDelivered, 'svix-newer-delivered-id'), { storage })).ok, true);
  communication = storage.state.communications[0];
  assert.equal(communication.delivery_state, 'delivered');
  assert.equal(communication.delivery_state_at, '2026-08-06T18:00:00.000Z');
  assert.equal(storage.state.cimRequests[0].status, 'sent');
  assert.equal(storage.state.cimRequests[0].delivery_state, 'delivered');
  assert.equal(storage.state.cimRequests[0].delivery_error, '');
  assert.deepEqual(storage.state.emailEvents.map((event) => event.provider_event_id), [
    'svix-bounce-id',
    'svix-delivered-id',
    'svix-same-time-delivered-id',
    'svix-newer-delivered-id',
  ]);
  assert.deepEqual(storage.state.emailEvents.map((event) => event.metadata.payloadProviderEventId), [
    'payload-bounce-id',
    'payload-delivered-id',
    'payload-same-time-delivered-id',
    'payload-newer-delivered-id',
  ]);
});

test('accepted, delivered, delayed, bounce, failure, complaint, and suppression remain distinct durable states', async () => {
  const cases = [
    ['sent', 'accepted', 'sent'],
    ['delivered', 'delivered', 'sent'],
    ['delayed', 'delayed', 'sent'],
    ['bounced', 'bounced', 'delivery_issue'],
    ['failed', 'failed', 'delivery_issue'],
    ['complained', 'complained', 'delivery_issue'],
    ['suppressed', 'suppressed', 'delivery_issue'],
  ];

  for (const [eventType, expectedDeliveryState, expectedStatus] of cases) {
    const communicationId = `communication-${eventType}`;
    const requestId = `request-${eventType}`;
    const storage = createStorage({
      communications: [{
        id: communicationId,
        submission_id: 'submission-1',
        cim_request_id: requestId,
        direction: 'outbound',
        channel: 'email',
        provider: 'resend',
        provider_message_id: `message-${eventType}`,
        delivery_state: 'not-attempted',
        metadata: {},
      }],
      cimRequests: [{
        id: requestId,
        status: 'pending',
        request_state: 'pending',
        delivery_state: 'not-attempted',
        follow_up_state: 'scheduled',
        metadata: {},
      }],
    });

    await applyEmailLifecycleToCommunication({
      id: `event-${eventType}`,
      provider: 'resend',
      event_type: eventType,
      message_id: `message-${eventType}`,
      communication_id: communicationId,
      created_at: '2026-08-06T20:00:00.000Z',
      metadata: {},
    }, { storage });

    assert.equal(storage.state.communications[0].delivery_state, expectedDeliveryState);
    assert.equal(storage.state.cimRequests[0].delivery_state, expectedDeliveryState);
    assert.equal(storage.state.cimRequests[0].status, expectedStatus);
    assert.equal(storage.state.recommendationsSuperseded.length > 0, true, `${eventType} invalidates current advice`);
  }
});

test('late provider events update delivery facts after archive and restore without restarting stopped CIM outreach', async () => {
  const storage = createStorage({
    submissions: [{
      id: 'late-delivery-submission',
      status: 'archived',
      follow_up_state: 'completed',
    }],
    communications: [{
      id: 'late-delivery-communication',
      submission_id: 'late-delivery-submission',
      cim_request_id: 'late-delivery-request',
      direction: 'outbound',
      channel: 'email',
      provider: 'resend',
      provider_message_id: 'late-delivery-message',
      delivery_state: 'accepted',
      delivery_state_at: '2026-08-06T16:00:00.000Z',
      metadata: {},
    }],
    cimRequests: [{
      id: 'late-delivery-request',
      submission_id: 'late-delivery-submission',
      status: 'sent',
      request_state: 'stopped',
      delivery_state: 'accepted',
      follow_up_state: 'stopped',
      next_follow_up_at: null,
      metadata: {},
    }],
  });

  await applyEmailLifecycleToCommunication({
    id: 'late-delivered-event',
    provider: 'resend',
    event_type: 'delivered',
    message_id: 'late-delivery-message',
    communication_id: 'late-delivery-communication',
    created_at: '2026-08-06T17:00:00.000Z',
    metadata: {},
  }, { storage });

  let request = storage.state.cimRequests[0];
  assert.equal(request.delivery_state, 'delivered');
  assert.equal(request.delivered_at, '2026-08-06T17:00:00.000Z');
  assert.equal(request.status, 'sent');
  assert.equal(request.request_state, 'stopped');
  assert.equal(request.follow_up_state, 'stopped');
  assert.equal(request.next_follow_up_at, null);

  storage.state.submissions[0].status = 'review';
  await applyEmailLifecycleToCommunication({
    id: 'late-bounced-after-restore-event',
    provider: 'resend',
    event_type: 'bounced',
    message_id: 'late-delivery-message',
    communication_id: 'late-delivery-communication',
    created_at: '2026-08-06T18:00:00.000Z',
    metadata: {},
  }, { storage });

  request = storage.state.cimRequests[0];
  assert.equal(request.delivery_state, 'bounced');
  assert.match(request.delivery_error, /bounced/i);
  assert.equal(request.status, 'sent');
  assert.equal(request.request_state, 'stopped');
  assert.equal(request.follow_up_state, 'stopped');
  assert.equal(request.next_follow_up_at, null);
});

test('reply events stop the CIM request without overwriting the outbound delivery outcome', async () => {
  const storage = createStorage({
    communications: [{
      id: 'communication-reply-1',
      submission_id: 'submission-1',
      opportunity_id: 'opportunity-reply-1',
      cim_request_id: 'cim-request-reply-1',
      direction: 'outbound',
      channel: 'email',
      provider: 'resend',
      provider_message_id: 'outbound-email-reply-1',
      delivery_state: 'delivered',
      delivery_state_at: '2026-08-06T16:00:00.000Z',
      updated_at: '2026-08-06T16:00:00.000Z',
      metadata: {},
    }],
    cimRequests: [{
      id: 'cim-request-reply-1',
      opportunity_id: 'opportunity-reply-1',
      status: 'sent',
      request_state: 'provider_accepted',
      follow_up_state: 'pending',
      next_follow_up_at: '2026-08-08T16:00:00.000Z',
      metadata: {},
    }],
  });
  const cimHistoryCalls = [];
  storage.listDealHunterCimRequests = async (options) => {
    cimHistoryCalls.push(clone(options));
    return storage.state.cimRequests.map(clone);
  };
  const replied = {
    id: 'payload-replied-id',
    type: 'email.replied',
    created_at: '2026-08-06T18:00:00.000Z',
    data: {
      email_id: 'outbound-email-reply-1',
      from: 'broker@example.com',
      to: ['deals@example.com'],
      tags: [{ name: 'communication_id', value: 'communication-reply-1' }],
    },
  };

  const result = await recordEmailEventsFromWebhook(sharedSecretRequest(replied), { storage });

  assert.equal(result.ok, true);
  assert.equal(storage.state.communications[0].delivery_state, 'delivered');
  assert.equal(storage.state.communications[0].delivery_state_at, '2026-08-06T16:00:00.000Z');
  assert.equal(storage.state.cimRequests[0].status, 'responded');
  assert.equal(storage.state.cimRequests[0].request_state, 'responded');
  assert.equal(storage.state.cimRequests[0].follow_up_state, 'stopped');
  assert.equal(storage.state.cimRequests[0].next_follow_up_at, null);
  assert.deepEqual(cimHistoryCalls, [{ opportunityIds: ['opportunity-reply-1'], limit: 500 }],
    'reply stopping retains generic operational history semantics');
});

test('suppression is normalized as a terminal non-actionable email outcome', () => {
  const summary = summarizeEmailEngagement([{
    id: 'event-suppressed-1',
    event_type: 'email.suppressed',
    created_at: '2026-08-06T18:00:00.000Z',
  }]);

  assert.equal(summary.suppressed, 1);
  assert.equal(summary.actionable, false);
  assert.equal(summary.tone, 'danger');
  assert.match(summary.action, /verif/i);
});

test('open tracking remains informational and never makes outreach actionable', () => {
  const summary = summarizeEmailEngagement([
    { id: 'opened-1', event_type: 'email.opened', created_at: '2026-08-06T18:00:00.000Z' },
    { id: 'opened-2', event_type: 'email.opened', created_at: '2026-08-06T18:05:00.000Z' },
  ]);

  assert.equal(summary.opened, 2);
  assert.equal(summary.actionable, false);
  assert.equal(summary.hot, false);
  assert.match(summary.action, /informational only/i);
});
