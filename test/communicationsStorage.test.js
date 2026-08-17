import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const timestamp = '2026-08-06T12:00:00.000Z';

function submission(id, { status = 'review', email = 'owner@example.com', brokerEmail = 'shared@example.com' } = {}) {
  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    status,
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'communications-storage-test',
    ip_hash: '',
    user_agent: '',
    name: `Contact ${id}`,
    email,
    phone: '',
    company: `Company ${id}`,
    role: 'Broker',
    message: 'Storage adapter test.',
    status_updated_at: timestamp,
    listing_url: `https://example.test/${id}`,
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Shared Broker',
    broker_email: brokerEmail,
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    metadata: {},
  };
}

function communication(overrides = {}) {
  return {
    id: 'communication-1',
    submission_id: null,
    deal_key: 'deal-1',
    cim_request_id: null,
    direction: 'inbound',
    channel: 'email',
    source: 'resend-webhook',
    kind: 'broker-reply',
    provider: 'resend',
    provider_message_id: 'provider-message-1',
    source_event_id: 'provider-event-1',
    idempotency_key: 'communication-idempotency-1',
    in_reply_to: null,
    reply_to_address: 'cim-request-token@example.test',
    from_address: 'shared@example.com',
    to_addresses: ['cim-request-token@example.test'],
    cc_addresses: [],
    bcc_addresses: [],
    subject: 'Re: CIM request',
    body_text: 'The requested material is attached.',
    body_html_sanitized: '',
    occurred_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    delivery_state: 'replied',
    delivery_state_at: timestamp,
    content_state: 'complete',
    content_attempt_count: 1,
    content_last_error: null,
    content_next_attempt_at: null,
    attachment_metadata: [{ filename: 'cim.pdf', size: 1024 }],
    assigned_at: null,
    assigned_by: null,
    created_by: 'resend-webhook',
    updated_by: 'resend-webhook',
    metadata: { fixture: true },
    ...overrides,
  };
}

function emailEvent(overrides = {}) {
  return {
    id: 'email-event-1',
    created_at: timestamp,
    provider: 'resend',
    event_type: 'delivered',
    message_id: 'provider-message-1',
    provider_event_id: 'provider-email-event-1',
    event_key: 'email-event-key-1',
    recipient_email: 'shared@example.com',
    subject: 'Re: CIM request',
    submission_id: null,
    communication_id: null,
    source: 'resend-webhook',
    metadata: { fixture: true },
    ...overrides,
  };
}

function cimClaimRequest(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    created_at: timestamp,
    updated_at: timestamp,
    deal_key: 'claim-deal-1',
    recipient_email: 'first-broker@example.com',
    requested_by: 'storage-admin',
    status: 'pending',
    request_state: 'pending',
    delivery_state: 'not-attempted',
    follow_up_state: 'not-scheduled',
    first_requested_at: timestamp,
    attempt_count: 0,
    metadata: {},
    ...overrides,
  };
}

test('SQLite communications storage is ambiguity-safe, durable, atomic, and accepts partial legacy CIM rows', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-communications-storage-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('open-lead'));
  await storage.insertSubmission(submission('spam-lead', { status: 'spam', email: 'spam@example.com' }));
  await storage.insertSubmission(submission('archived-lead', { status: 'archived', email: 'archived@example.com' }));

  const everyMatch = await storage.listSubmissionsByContactEmail('SHARED@example.com', { limit: 10 });
  const openMatches = await storage.listSubmissionsByContactEmail('shared@example.com', { limit: 10, openOnly: true });
  assert.equal(everyMatch.length, 3);
  assert.deepEqual(openMatches.map((row) => row.id), ['open-lead']);
  assert.deepEqual(await storage.listSubmissionsByContactEmail('', { openOnly: true }), []);

  const stored = await storage.insertCrmCommunication(communication());
  assert.deepEqual(stored.to_addresses, ['cim-request-token@example.test']);
  assert.deepEqual(stored.attachment_metadata, [{ filename: 'cim.pdf', size: 1024 }]);
  const duplicate = await storage.insertCrmCommunication(communication({ id: 'communication-replay' }));
  assert.equal(duplicate.id, stored.id, 'provider/source idempotency returns the original row');

  const assignment = await storage.mutateWithCrmActivity({
    operation: 'assign_crm_communication',
    payload: {
      id: stored.id,
      submissionId: 'open-lead',
      updatedAt: '2026-08-06T12:05:00.000Z',
      assignedBy: 'storage-admin',
    },
    activity: {
      id: 'communication-assignment-activity',
      submission_id: 'open-lead',
      created_at: '2026-08-06T12:05:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'communication.assigned',
      summary: 'Inbound communication assigned.',
      metadata: { communicationId: stored.id },
    },
  });
  assert.equal(assignment.applied, true);
  assert.equal(assignment.record.submission_id, 'open-lead');
  assert.equal((await storage.listCrmActivityEvents({ submissionId: 'open-lead' })).length, 1);

  const cimRequest = await storage.upsertDealHunterCimRequest({
    id: 'request-token-12345678',
    created_at: timestamp,
    updated_at: timestamp,
    deal_key: 'deal-1',
    recipient_email: 'shared@example.com',
    status: 'sent',
    submission_id: 'open-lead',
    metadata: { replyToAddress: 'cim-request-token@example.test' },
  });
  assert.equal(cimRequest.delivery_error, null);
  assert.equal(cimRequest.request_state, 'provider_accepted');
  assert.equal(cimRequest.delivery_state, 'accepted');
  assert.equal(cimRequest.follow_up_state, 'not-scheduled');
  assert.equal(cimRequest.first_requested_at, timestamp);
  assert.equal((await storage.getDealHunterCimRequestByReplyToAddress('CIM-request-token@example.test')).id, cimRequest.id);

  const unassignedReply = await storage.insertCrmCommunication(communication({
    id: 'communication-atomic-cim-link',
    deal_key: null,
    provider_message_id: 'provider-message-atomic-cim-link',
    source_event_id: 'provider-event-atomic-cim-link',
    idempotency_key: 'communication-atomic-cim-link',
  }));
  const atomicAssignment = await storage.mutateWithCrmActivity({
    operation: 'assign_crm_communication',
    payload: {
      id: unassignedReply.id,
      submissionId: 'open-lead',
      dealKey: cimRequest.deal_key,
      cimRequestId: cimRequest.id,
      updatedAt: '2026-08-06T12:06:00.000Z',
      assignedBy: 'resend-ingestion',
      metadata: { fixture: true, assignmentMethod: 'reply-alias' },
    },
    activity: {
      id: 'communication-atomic-cim-link-activity',
      submission_id: 'open-lead',
      created_at: '2026-08-06T12:06:00.000Z',
      actor: 'shared@example.com',
      role: 'contact',
      event_type: 'communication.assigned',
      summary: 'Inbound communication atomically assigned to its CIM request.',
      metadata: { communicationId: unassignedReply.id },
    },
  });
  assert.equal(atomicAssignment.applied, true);
  assert.equal(atomicAssignment.record.deal_key, cimRequest.deal_key);
  assert.equal(atomicAssignment.record.cim_request_id, cimRequest.id);
  assert.equal(atomicAssignment.record.metadata.assignmentMethod, 'reply-alias');

  const history = await storage.listDealHunterCimRequestHistory({ search: 'shared@example.com', page: 1, pageSize: 10 });
  assert.equal(history.total, 1);
  assert.equal(history.counts.accepted, 1);

  for (let index = 2; index <= 7; index += 1) {
    await storage.upsertDealHunterCimRequest({
      id: `request-history-${index}`,
      created_at: `2026-08-0${index}T12:00:00.000Z`,
      updated_at: `2026-08-0${index}T12:00:00.000Z`,
      first_requested_at: `2026-08-0${index}T12:00:00.000Z`,
      deal_key: `expired-source-deal-${index}`,
      recipient_email: `history-${index}@example.com`,
      subject: `Expired source CIM ${index}`,
      deal_name: `Expired Source Business ${index}`,
      listing_url: `https://expired.example.test/listing-${index}`,
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'accepted',
      metadata: {},
    });
  }
  const durableHistoryPageOne = await storage.listDealHunterCimRequestHistory({ page: 1, pageSize: 5 });
  const durableHistoryPageTwo = await storage.listDealHunterCimRequestHistory({ page: 2, pageSize: 5 });
  assert.equal(durableHistoryPageOne.total, 7, 'history must not be limited to four current Deal Hunter cards');
  assert.equal(durableHistoryPageOne.rows.length, 5);
  assert.equal(durableHistoryPageTwo.rows.length, 2);
  await storage.upsertDealHunterCimRequest({
    id: 'failure-sort-early',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-06T10:00:00.000Z',
    deal_key: 'failure-sort-early-deal',
    recipient_email: 'failure-sort-early@example.com',
    status: 'delivery_issue',
    request_state: 'stopped',
    delivery_state: 'bounced',
    last_delivery_event_at: '2026-08-06T10:00:00.000Z',
    metadata: {},
  });
  await storage.upsertDealHunterCimRequest({
    id: 'failure-sort-late',
    created_at: '2026-08-01T11:00:00.000Z',
    updated_at: '2026-08-06T11:00:00.000Z',
    deal_key: 'failure-sort-late-deal',
    recipient_email: 'failure-sort-late@example.com',
    status: 'delivery_issue',
    request_state: 'stopped',
    delivery_state: 'failed',
    last_delivery_event_at: '2026-08-06T11:00:00.000Z',
    metadata: {},
  });
  const failuresAscending = await storage.listDealHunterCimRequestHistory({
    sort: 'failure',
    direction: 'asc',
    page: 1,
    pageSize: 2,
  });
  const failuresDescending = await storage.listDealHunterCimRequestHistory({
    sort: 'failure',
    direction: 'desc',
    page: 1,
    pageSize: 2,
  });
  assert.deepEqual(failuresAscending.rows.map((request) => request.id), ['failure-sort-early', 'failure-sort-late']);
  assert.deepEqual(failuresDescending.rows.map((request) => request.id), ['failure-sort-late', 'failure-sort-early']);
  const expiredSourceSearch = await storage.listDealHunterCimRequestHistory({ search: 'expired-source-deal-6', page: 1, pageSize: 5 });
  assert.equal(expiredSourceSearch.total, 1, 'history remains searchable without a current source-review row');
  assert.equal((await storage.listCrmCommunications({ page: Infinity })).page, 1);
  assert.equal((await storage.listDealHunterCimRequestHistory({ page: Number('1e309') })).page, 1);
  assert.equal((await storage.listCrmCommunications({ page: 10001 })).page, 10000);
  assert.equal((await storage.listDealHunterCimRequestHistory({ page: 10001 })).page, 10000);

  await storage.upsertDealHunterDisposition({
    id: '00000000-0000-4000-8000-000000000010',
    deal_key: 'deal-1',
    submission_id: 'open-lead',
    status: 'dismissed',
    reason: 'unavailable',
    created_at: timestamp,
    updated_at: timestamp,
    updated_by: 'storage-admin',
    metadata: {},
  });
  assert.equal((await storage.listDealHunterDispositions({ activeOnly: true })).length, 1);

  await storage.deleteSubmission('open-lead');
  assert.equal(await storage.getCrmCommunication(stored.id), null);
  const requestAfterDelete = await storage.getDealHunterCimRequestById(cimRequest.id);
  assert.equal(requestAfterDelete.submission_id, null);
  assert.equal(requestAfterDelete.request_state, 'stopped');
  assert.equal(requestAfterDelete.follow_up_state, 'stopped');
  assert.equal((await storage.getDealHunterDisposition({ dealKey: 'deal-1' })).submission_id, null);
});

test('SQLite lifecycle mutations require an expected submission version', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-lifecycle-version-guard-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('version-guard-lead'));
  const activity = {
    id: 'version-guard-activity',
    submission_id: 'version-guard-lead',
    created_at: '2026-08-06T12:10:00.000Z',
    actor: 'storage-admin',
    role: 'admin',
    event_type: 'submission.archived',
    summary: 'Mutation without a version must be rejected.',
    metadata: {},
  };

  const archive = await storage.mutateWithCrmActivity({
    operation: 'archive_submission',
    payload: {
      id: 'version-guard-lead',
      values: { updated_at: '2026-08-06T12:10:00.000Z' },
    },
    activity,
  });
  assert.equal(archive.applied, false);
  assert.equal(archive.reason, 'missing-expected-version');
  assert.equal(archive.record.status, 'review');

  const dismissal = await storage.mutateWithCrmActivity({
    operation: 'dismiss_deal_hunter_opportunity',
    payload: {
      submissionId: 'version-guard-lead',
      values: { updated_at: '2026-08-06T12:10:00.000Z' },
      disposition: { id: 'version-guard-disposition', deal_key: 'version-guard-deal' },
    },
    activity: { ...activity, id: 'version-guard-dismissal-activity' },
  });
  assert.equal(dismissal.applied, false);
  assert.equal(dismissal.reason, 'missing-expected-version');
  assert.equal(dismissal.record.submission.status, 'review');
  assert.equal(dismissal.record.disposition, null);
  assert.equal((await storage.listCrmActivityEvents({ submissionId: 'version-guard-lead' })).length, 0);
});

test('SQLite atomically back-links a matching email event when a linked communication is inserted', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-communication-email-link-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('linked-email-lead'));
  await storage.insertEmailEvent(emailEvent({
    id: 'linked-email-event',
    event_key: 'linked-email-event-key',
    message_id: 'linked-provider-message',
  }));

  const result = await storage.mutateWithCrmActivity({
    operation: 'insert_crm_communication',
    payload: {
      communication: communication({
        id: 'linked-email-communication',
        submission_id: 'linked-email-lead',
        provider_message_id: 'linked-provider-message',
        source_event_id: 'linked-source-event',
        idempotency_key: 'linked-idempotency-key',
      }),
    },
    activity: {
      id: 'linked-email-activity',
      submission_id: 'linked-email-lead',
      created_at: timestamp,
      actor: 'resend-webhook',
      role: 'system',
      event_type: 'communication.created',
      summary: 'Linked communication recorded.',
      metadata: { communicationId: 'linked-email-communication' },
    },
  });

  assert.equal(result.applied, true);
  const linkedEvents = await storage.listEmailEvents({ submissionId: 'linked-email-lead' });
  assert.equal(linkedEvents.length, 1);
  assert.equal(linkedEvents[0].id, 'linked-email-event');
  assert.equal(linkedEvents[0].communication_id, 'linked-email-communication');
});

test('SQLite pending-ingestion claims lease work once across independent connections', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-communication-ingestion-claim-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const firstStorage = createSqliteStorage(config);
  const secondStorage = createSqliteStorage(config);
  t.after(() => {
    firstStorage.close();
    secondStorage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await firstStorage.insertCrmCommunication(communication({
    id: 'pending-ingestion-communication',
    provider_message_id: 'pending-ingestion-provider-message',
    source_event_id: 'pending-ingestion-source-event',
    idempotency_key: 'pending-ingestion-idempotency-key',
    content_state: 'pending',
    content_attempt_count: 0,
    content_next_attempt_at: '2026-08-06T12:01:00.000Z',
  }));

  const claimOptions = {
    dueBefore: '2026-08-06T12:02:00.000Z',
    leaseUntil: '2026-08-06T12:12:00.000Z',
    limit: 1,
    claimedBy: 'communications-worker-1',
  };
  const claims = await Promise.all([
    firstStorage.claimCrmCommunicationsPendingIngestion(claimOptions),
    secondStorage.claimCrmCommunicationsPendingIngestion(claimOptions),
  ]);
  const claimedRows = claims.flat();

  assert.equal(claimedRows.length, 1, 'only one connection may acquire the same due communication');
  assert.equal(claimedRows[0].id, 'pending-ingestion-communication');
  assert.equal(claimedRows[0].content_next_attempt_at, claimOptions.leaseUntil);
  assert.equal(claimedRows[0].updated_by, claimOptions.claimedBy);
  assert.deepEqual(
    await secondStorage.claimCrmCommunicationsPendingIngestion(claimOptions),
    [],
    'the active lease excludes the row from another due-work claim',
  );
});

test('SQLite deal-wide CIM claims admit one initial recipient and only delivery-issue retries', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-wide-cim-claim-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const firstStorage = createSqliteStorage(config);
  const secondStorage = createSqliteStorage(config);
  t.after(() => {
    firstStorage.close();
    secondStorage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const linkedSubmissionId = 'claim-submission-1';
  await firstStorage.insertSubmission(submission(linkedSubmissionId));

  const initialRequests = [
    cimClaimRequest({ submission_id: linkedSubmissionId }),
    cimClaimRequest({
      id: '00000000-0000-4000-8000-000000000102',
      recipient_email: 'second-broker@example.com',
      submission_id: linkedSubmissionId,
    }),
  ];
  const initialClaims = await Promise.all([
    firstStorage.claimDealHunterCimRequest(initialRequests[0]),
    secondStorage.claimDealHunterCimRequest(initialRequests[1]),
  ]);
  const successfulInitialClaims = initialClaims.filter((claim) => claim.claimed);

  assert.equal(successfulInitialClaims.length, 1, 'a deal can have only one active initial CIM claim');
  const originalRequest = successfulInitialClaims[0].request;
  assert.equal((await firstStorage.listDealHunterCimRequests({ dealKeys: ['claim-deal-1'] })).length, 1);

  const prematureRetry = await secondStorage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000103',
    recipient_email: 'premature-correction@example.com',
    retry_of_request_id: originalRequest.id,
    submission_id: linkedSubmissionId,
  }));
  assert.equal(prematureRetry.claimed, false, 'an accepted initial request cannot be retried to another recipient');
  assert.equal(
    (await firstStorage.listDealHunterCimRequests({ dealKeys: ['claim-deal-1'] })).length,
    1,
    'a rejected corrected-recipient retry must not leave a durable request row',
  );

  await firstStorage.upsertDealHunterCimRequest({
    ...originalRequest,
    updated_at: '2026-08-06T12:05:00.000Z',
    status: 'delivery_issue',
    request_state: 'stopped',
    delivery_state: 'bounced',
    delivery_state_at: '2026-08-06T12:05:00.000Z',
    follow_up_state: 'stopped',
    metadata: { deliveryIssueType: 'bounced' },
  });
  const correctedRetry = await secondStorage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000104',
    updated_at: '2026-08-06T12:06:00.000Z',
    recipient_email: 'corrected-broker@example.com',
    retry_of_request_id: originalRequest.id,
    submission_id: linkedSubmissionId,
  }));

  assert.equal(correctedRetry.claimed, true);
  assert.equal(correctedRetry.request.retry_of_request_id, originalRequest.id);
  assert.equal(correctedRetry.request.recipient_email, 'corrected-broker@example.com');
});

test('SQLite serializes CIM claims against archive and rejects stale finalization', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-archive-claim-race-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const claimStorage = createSqliteStorage(config);
  const archiveStorage = createSqliteStorage(config);
  t.after(() => {
    claimStorage.close();
    archiveStorage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await claimStorage.insertSubmission(submission('claim-race-lead'));
  const claim = await claimStorage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000110',
    deal_key: 'claim-race-deal',
    submission_id: 'claim-race-lead',
  }));
  assert.equal(claim.claimed, true);

  const activeArchive = await archiveStorage.mutateWithCrmActivity({
    operation: 'archive_submission',
    payload: {
      id: 'claim-race-lead',
      expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-08-06T12:05:00.000Z', archived_at: '2026-08-06T12:05:00.000Z' },
    },
    activity: {
      id: 'claim-race-active-archive-activity',
      submission_id: 'claim-race-lead',
      created_at: '2026-08-06T12:05:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.archived',
      summary: 'Archive while a CIM send is actively claimed.',
      metadata: {},
    },
  });
  assert.equal(activeArchive.applied, false);
  assert.equal(activeArchive.reason, 'cim-send-in-progress');
  assert.notEqual((await archiveStorage.getSubmission('claim-race-lead')).status, 'archived');

  const staleArchive = await archiveStorage.mutateWithCrmActivity({
    operation: 'archive_submission',
    payload: {
      id: 'claim-race-lead',
      expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-08-06T12:11:00.000Z', archived_at: '2026-08-06T12:11:00.000Z' },
    },
    activity: {
      id: 'claim-race-stale-archive-activity',
      submission_id: 'claim-race-lead',
      created_at: '2026-08-06T12:11:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.archived',
      summary: 'Archive after the initial CIM claim lease expires.',
      metadata: {},
    },
  });
  assert.equal(staleArchive.applied, true);
  assert.equal(staleArchive.record.status, 'archived');

  const staleFinalization = await claimStorage.mutateWithCrmActivity({
    operation: 'finalize_deal_hunter_cim_request_claim',
    payload: {
      request: {
        ...claim.request,
        updated_at: '2026-08-06T12:12:00.000Z',
        status: 'sent',
        request_state: 'provider_accepted',
        delivery_state: 'accepted',
      },
      expectedUpdatedAt: claim.request.updated_at,
      expectedStatuses: ['pending'],
    },
    activity: {
      id: 'claim-race-stale-finalize-activity',
      submission_id: 'claim-race-lead',
      created_at: '2026-08-06T12:12:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'cim.request-sent',
      summary: 'Stale provider result must not revive an archived CIM request.',
      metadata: {},
    },
  });
  assert.equal(staleFinalization.applied, false);
  assert.equal(staleFinalization.reason, 'submission-archived');
  const stoppedRequest = await claimStorage.getDealHunterCimRequestById(claim.request.id);
  assert.equal(stoppedRequest.status, 'pending');
  assert.equal(stoppedRequest.request_state, 'stopped');
  assert.equal(stoppedRequest.updated_at, '2026-08-06T12:11:00.000Z');

  await claimStorage.insertSubmission(submission('already-archived-claim-lead', { status: 'archived' }));
  const archivedClaim = await archiveStorage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000111',
    deal_key: 'already-archived-claim-deal',
    submission_id: 'already-archived-claim-lead',
  }));
  assert.equal(archivedClaim.claimed, false);
  assert.equal(archivedClaim.reason, 'submission-archived');
  assert.equal(await claimStorage.getDealHunterCimRequestById('00000000-0000-4000-8000-000000000111'), null);

  await claimStorage.insertSubmission(submission('follow-up-claim-lead'));
  await claimStorage.upsertDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000112',
    deal_key: 'follow-up-claim-deal',
    submission_id: 'follow-up-claim-lead',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    next_follow_up_at: '2026-08-06T11:59:00.000Z',
  }));
  const followUpClaim = await claimStorage.claimDealHunterCimFollowUpRequest({
    id: '00000000-0000-4000-8000-000000000112',
    dueBefore: timestamp,
    staleBefore: '2026-08-06T11:30:00.000Z',
    nowIso: timestamp,
  });
  assert.equal(followUpClaim.claimed, true);
  const followUpArchive = await archiveStorage.mutateWithCrmActivity({
    operation: 'archive_submission',
    payload: {
      id: 'follow-up-claim-lead',
      expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-08-06T12:05:00.000Z', archived_at: '2026-08-06T12:05:00.000Z' },
    },
    activity: {
      id: 'follow-up-claim-archive-activity',
      submission_id: 'follow-up-claim-lead',
      created_at: '2026-08-06T12:05:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.archived',
      summary: 'Archive while a follow-up send is actively claimed.',
      metadata: {},
    },
  });
  assert.equal(followUpArchive.applied, false);
  assert.equal(followUpArchive.reason, 'cim-send-in-progress');
});

test('SQLite atomically preserves stopped CIM outreach when late delivery writes race archive or follow restore', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-late-delivery-race-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('late-delivery-race-lead'));
  const activeRequest = await storage.upsertDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000119',
    deal_key: 'late-delivery-race-deal',
    submission_id: 'late-delivery-race-lead',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    next_follow_up_at: '2026-08-07T12:00:00.000Z',
  }));

  const archived = await storage.mutateWithCrmActivity({
    operation: 'archive_submission',
    payload: {
      id: 'late-delivery-race-lead',
      expectedUpdatedAt: timestamp,
      values: {
        updated_at: '2026-08-06T12:10:00.000Z',
        archived_at: '2026-08-06T12:10:00.000Z',
      },
    },
    activity: {
      id: 'late-delivery-race-archive-activity',
      submission_id: 'late-delivery-race-lead',
      created_at: '2026-08-06T12:10:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.archived',
      summary: 'Archive before a stale delivery mutation commits.',
      metadata: {},
    },
  });
  assert.equal(archived.applied, true);

  const delivered = await storage.mutateWithCrmActivity({
    operation: 'upsert_deal_hunter_cim_request',
    payload: {
      request: {
        ...activeRequest,
        updated_at: '2026-08-06T12:11:00.000Z',
        status: 'sent',
        request_state: 'provider_accepted',
        delivery_state: 'delivered',
        delivered_at: '2026-08-06T12:11:00.000Z',
        last_delivery_event_at: '2026-08-06T12:11:00.000Z',
        follow_up_state: 'scheduled',
        next_follow_up_at: '2026-08-07T12:00:00.000Z',
      },
      preserveStoppedOutreach: true,
    },
    activity: {
      id: 'late-delivery-race-delivered-activity',
      submission_id: 'late-delivery-race-lead',
      created_at: '2026-08-06T12:11:00.000Z',
      actor: 'resend',
      role: 'system',
      event_type: 'cim.delivery-updated',
      summary: 'Late delivery fact recorded after archive.',
      metadata: { deliveryState: 'delivered' },
    },
  });
  assert.equal(delivered.applied, true);
  assert.equal(delivered.record.delivery_state, 'delivered');
  assert.equal(delivered.record.delivered_at, '2026-08-06T12:11:00.000Z');
  assert.equal(delivered.record.status, 'sent');
  assert.equal(delivered.record.request_state, 'stopped');
  assert.equal(delivered.record.follow_up_state, 'stopped');
  assert.equal(delivered.record.next_follow_up_at, null);

  const restored = await storage.mutateWithCrmActivity({
    operation: 'update_submission',
    payload: {
      id: 'late-delivery-race-lead',
      expectedUpdatedAt: archived.record.updated_at,
      values: {
        updated_at: '2026-08-06T12:20:00.000Z',
        status: 'review',
        status_updated_at: '2026-08-06T12:20:00.000Z',
        archived_at: null,
        archived_by: null,
        archive_reason: null,
        archive_note: null,
        restored_at: '2026-08-06T12:20:00.000Z',
        restored_by: 'storage-admin',
      },
    },
    activity: {
      id: 'late-delivery-race-restore-activity',
      submission_id: 'late-delivery-race-lead',
      created_at: '2026-08-06T12:20:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.restored',
      summary: 'Restore without restarting outreach.',
      metadata: { outreachRestarted: false },
    },
  });
  assert.equal(restored.applied, true);

  const bounced = await storage.mutateWithCrmActivity({
    operation: 'upsert_deal_hunter_cim_request',
    payload: {
      request: {
        ...activeRequest,
        updated_at: '2026-08-06T12:21:00.000Z',
        status: 'delivery_issue',
        request_state: 'provider_accepted',
        delivery_state: 'bounced',
        last_delivery_event_at: '2026-08-06T12:21:00.000Z',
        delivery_error: 'Email bounced.',
        follow_up_state: 'scheduled',
        next_follow_up_at: '2026-08-07T12:00:00.000Z',
      },
      preserveStoppedOutreach: true,
    },
    activity: {
      id: 'late-delivery-race-bounced-activity',
      submission_id: 'late-delivery-race-lead',
      created_at: '2026-08-06T12:21:00.000Z',
      actor: 'resend',
      role: 'system',
      event_type: 'cim.delivery-updated',
      summary: 'Late bounce fact recorded after restore.',
      metadata: { deliveryState: 'bounced' },
    },
  });
  assert.equal(bounced.applied, true);
  assert.equal(bounced.record.delivery_state, 'bounced');
  assert.equal(bounced.record.delivery_error, 'Email bounced.');
  assert.equal(bounced.record.status, 'sent');
  assert.equal(bounced.record.request_state, 'stopped');
  assert.equal(bounced.record.follow_up_state, 'stopped');
  assert.equal(bounced.record.next_follow_up_at, null);

  const activities = await storage.listCrmActivityEvents({
    submissionId: 'late-delivery-race-lead',
    limit: 20,
  });
  assert.equal(activities.filter((event) => event.event_type === 'cim.delivery-updated').length, 2);
});

test('SQLite permanent deletion refuses fresh CIM leases and permits deletion after they expire', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-delete-lease-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const claimStorage = createSqliteStorage(config);
  const deleteStorage = createSqliteStorage(config);
  t.after(() => {
    claimStorage.close();
    deleteStorage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await claimStorage.insertSubmission(submission('initial-delete-lease-lead'));
  const initialClaim = await claimStorage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000120',
    deal_key: 'initial-delete-lease-deal',
    submission_id: 'initial-delete-lease-lead',
  }));
  assert.equal(initialClaim.claimed, true);
  await assert.rejects(
    deleteStorage.deleteSubmission('initial-delete-lease-lead', {
      deletedAt: '2026-08-06T12:05:00.000Z',
    }),
    (error) => error.code === 'CIM_SEND_IN_PROGRESS' && error.status === 409,
  );
  assert.ok(await claimStorage.getSubmission('initial-delete-lease-lead'));

  const deletedInitial = await deleteStorage.deleteSubmission('initial-delete-lease-lead', {
    deletedAt: '2026-08-06T12:11:00.000Z',
  });
  assert.equal(deletedInitial.id, 'initial-delete-lease-lead');
  assert.equal(await claimStorage.getSubmission('initial-delete-lease-lead'), null);
  const detachedInitial = await claimStorage.getDealHunterCimRequestById(initialClaim.request.id);
  assert.equal(detachedInitial.submission_id, null);
  assert.equal(detachedInitial.request_state, 'stopped');
  assert.equal(detachedInitial.follow_up_state, 'stopped');

  await claimStorage.insertSubmission(submission('follow-up-delete-lease-lead'));
  await claimStorage.upsertDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000121',
    deal_key: 'follow-up-delete-lease-deal',
    submission_id: 'follow-up-delete-lease-lead',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'scheduled',
    next_follow_up_at: '2026-08-06T11:59:00.000Z',
  }));
  const followUpClaim = await claimStorage.claimDealHunterCimFollowUpRequest({
    id: '00000000-0000-4000-8000-000000000121',
    dueBefore: timestamp,
    staleBefore: '2026-08-06T11:30:00.000Z',
    nowIso: timestamp,
  });
  assert.equal(followUpClaim.claimed, true);
  await assert.rejects(
    deleteStorage.deleteSubmission('follow-up-delete-lease-lead', {
      deletedAt: '2026-08-06T12:20:00.000Z',
    }),
    (error) => error.code === 'CIM_SEND_IN_PROGRESS' && error.status === 409,
  );
  assert.ok(await claimStorage.getSubmission('follow-up-delete-lease-lead'));

  const deletedFollowUp = await deleteStorage.deleteSubmission('follow-up-delete-lease-lead', {
    deletedAt: '2026-08-06T12:31:00.000Z',
  });
  assert.equal(deletedFollowUp.id, 'follow-up-delete-lease-lead');
  assert.equal(await claimStorage.getSubmission('follow-up-delete-lease-lead'), null);
});

test('SQLite Deal Hunter dismissal archives and records its disposition in one compound mutation', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-dismissal-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await storage.insertSubmission(submission('dismissed-lead'));
  await storage.upsertDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000105',
    deal_key: 'dismissed-deal',
    recipient_email: 'dismissed-broker@example.com',
    submission_id: 'dismissed-lead',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    attempt_count: 1,
  }));
  const result = await storage.mutateWithCrmActivity({
    operation: 'dismiss_deal_hunter_opportunity',
    payload: {
      submissionId: 'dismissed-lead',
      expectedUpdatedAt: timestamp,
      values: {
        updated_at: '2026-08-06T12:10:00.000Z',
        archived_at: '2026-08-06T12:10:00.000Z',
        archived_by: 'storage-admin',
        archive_reason: 'not-a-fit',
      },
      disposition: {
        id: '00000000-0000-4000-8000-000000000106',
        deal_key: 'dismissed-deal',
        status: 'dismissed',
        reason: 'not-a-fit',
        created_at: '2026-08-06T12:10:00.000Z',
        updated_at: '2026-08-06T12:10:00.000Z',
        created_by: 'storage-admin',
        updated_by: 'storage-admin',
        metadata: {},
      },
    },
    activity: {
      id: 'dismissed-lead-activity',
      submission_id: 'dismissed-lead',
      created_at: '2026-08-06T12:10:00.000Z',
      actor: 'storage-admin',
      role: 'admin',
      event_type: 'submission.archived',
      summary: 'Deal Hunter opportunity dismissed.',
      metadata: { dealKey: 'dismissed-deal' },
    },
  });

  assert.equal(result.applied, true);
  assert.equal(result.record.submission.status, 'archived');
  assert.equal(result.record.submission.follow_up_state, 'completed');
  assert.equal(result.record.disposition.disposition, 'dismissed');
  assert.equal(result.record.disposition.submission_id, 'dismissed-lead');
  const stoppedRequest = await storage.getDealHunterCimRequestById('00000000-0000-4000-8000-000000000105');
  assert.equal(stoppedRequest.request_state, 'stopped');
  assert.equal(stoppedRequest.follow_up_state, 'stopped');
});

test('Supabase routes communications, lifecycle lookup, and history through service-role RPC contracts', async () => {
  const calls = [];
  const client = {
    from(tableName) {
      throw new Error(`Expected lifecycle storage to use an RPC instead of direct ${tableName} access.`);
    },
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      if (name === 'mutate_communications_with_crm_activity') {
        if (parameters.p_operation === 'finalize_deal_hunter_cim_request_claim') {
          return {
            data: {
              applied: true,
              record: cimClaimRequest({
                id: '00000000-0000-4000-8000-000000000005',
                submission_id: '00000000-0000-4000-8000-000000000001',
                status: 'sent',
              }),
              activity: {
                id: '00000000-0000-4000-8000-000000000008',
                submission_id: '00000000-0000-4000-8000-000000000001',
                event_type: 'cim.request-sent',
                metadata: {},
              },
            },
            error: null,
          };
        }
        if (parameters.p_operation === 'dismiss_deal_hunter_opportunity') {
          return {
            data: {
              applied: true,
              record: {
                submission: {
                  ...submission('00000000-0000-4000-8000-000000000001', { status: 'archived' }),
                  follow_up_state: 'completed',
                },
                disposition: {
                  id: '00000000-0000-4000-8000-000000000006',
                  deal_key: 'deal-1',
                  submission_id: '00000000-0000-4000-8000-000000000001',
                  disposition: 'dismissed',
                  metadata: {},
                },
              },
              activity: {
                id: '00000000-0000-4000-8000-000000000007',
                submission_id: '00000000-0000-4000-8000-000000000001',
                event_type: 'submission.archived',
                metadata: {},
              },
            },
            error: null,
          };
        }
        return {
          data: {
            applied: true,
            record: communication({ submission_id: '00000000-0000-4000-8000-000000000001' }),
            activity: {
              id: '00000000-0000-4000-8000-000000000002',
              submission_id: '00000000-0000-4000-8000-000000000001',
              event_type: 'communication.created',
              metadata: {},
            },
          },
          error: null,
        };
      }
      if (name === 'delete_crm_submission_lifecycle') {
        return { data: submission('00000000-0000-4000-8000-000000000003'), error: null };
      }
      if (name === 'claim_crm_communications_pending_ingestion') {
        return {
          data: [communication({
            id: '00000000-0000-4000-8000-000000000004',
            content_state: 'pending',
            content_next_attempt_at: parameters.p_lease_until,
            updated_by: parameters.p_claimed_by,
          })],
          error: null,
        };
      }
      if (name === 'claim_deal_hunter_cim_request') {
        return {
          data: {
            claimed: true,
            request: cimClaimRequest({
              id: '00000000-0000-4000-8000-000000000005',
              recipient_email: parameters.p_request.recipient_email,
              submission_id: parameters.p_request.submission_id,
            }),
          },
          error: null,
        };
      }
      if (name === 'claim_deal_hunter_cim_follow_up_request') {
        return {
          data: {
            claimed: true,
            reason: '',
            request: cimClaimRequest({
              id: parameters.p_request_id,
              submission_id: '00000000-0000-4000-8000-000000000001',
              status: 'follow_up_pending',
              updated_at: parameters.p_claimed_at,
            }),
          },
          error: null,
        };
      }
      if (name === 'renew_deal_hunter_cim_request_claim') {
        return {
          data: {
            renewed: true,
            reason: '',
            request: cimClaimRequest({
              id: parameters.p_request_id,
              submission_id: '00000000-0000-4000-8000-000000000001',
              status: parameters.p_expected_status,
              updated_at: parameters.p_renewed_at,
            }),
          },
          error: null,
        };
      }
      if (name === 'list_submissions_by_contact_email') {
        return { data: [submission('00000000-0000-4000-8000-000000000001')], error: null };
      }
      if (name === 'list_deal_hunter_cim_request_history') {
        return {
          data: {
            rows: [{
              id: 'request-1',
              request_state: 'provider_accepted',
              follow_up_count: 0,
              attempt_count: 1,
              metadata: {},
            }],
            total: 1,
            page: 1,
            pageSize: 25,
            counts: { accepted: 1, deliveryIssue: 0 },
          },
          error: null,
        };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client },
  );

  const mutation = await storage.mutateWithCrmActivity({
    operation: 'insert_crm_communication',
    payload: { communication: communication() },
    activity: { id: 'activity-1' },
  });
  assert.equal(mutation.applied, true);
  assert.deepEqual(mutation.record.to_addresses, ['cim-request-token@example.test']);

  const matches = await storage.listSubmissionsByContactEmail('SHARED@example.com', { limit: 3, openOnly: true });
  assert.equal(matches.length, 1);
  const history = await storage.listDealHunterCimRequestHistory({ deliveryStates: ['not_attempted'] });
  assert.equal(history.total, 1);
  assert.equal(history.counts.accepted, 1);

  const deleted = await storage.deleteSubmission('00000000-0000-4000-8000-000000000003', {
    deletedAt: '2026-08-06T12:30:00.000Z',
  });
  assert.equal(deleted.id, '00000000-0000-4000-8000-000000000003');
  const ingestionClaim = await storage.claimCrmCommunicationsPendingIngestion({
    dueBefore: '2026-08-06T12:02:00.000Z',
    leaseUntil: '2026-08-06T12:12:00.000Z',
    limit: 7,
    claimedBy: 'supabase-communications-worker',
  });
  assert.equal(ingestionClaim.length, 1);
  assert.equal(ingestionClaim[0].content_next_attempt_at, '2026-08-06T12:12:00.000Z');
  const cimClaim = await storage.claimDealHunterCimRequest(cimClaimRequest({
    id: '00000000-0000-4000-8000-000000000005',
    recipient_email: 'MIXED.CASE@EXAMPLE.COM',
    submission_id: '00000000-0000-4000-8000-000000000001',
  }), { pendingCutoff: '2026-08-06T11:50:00.000Z' });
  assert.equal(cimClaim.claimed, true);
  assert.equal(cimClaim.request.recipient_email, 'mixed.case@example.com');
  const followUpClaim = await storage.claimDealHunterCimFollowUpRequest({
    id: '00000000-0000-4000-8000-000000000005',
    dueBefore: '2026-08-06T12:20:00.000Z',
    staleBefore: '2026-08-06T11:50:00.000Z',
    nowIso: '2026-08-06T12:20:00.000Z',
  });
  assert.equal(followUpClaim.claimed, true);
  const renewedClaim = await storage.renewDealHunterCimRequestClaim({
    id: '00000000-0000-4000-8000-000000000005',
    expectedUpdatedAt: '2026-08-06T12:20:00.000Z',
    expectedStatus: 'follow_up_pending',
    nowIso: '2026-08-06T12:21:00.000Z',
  });
  assert.equal(renewedClaim.renewed, true);
  const finalizedClaim = await storage.mutateWithCrmActivity({
    operation: 'finalize_deal_hunter_cim_request_claim',
    payload: {
      request: cimClaimRequest({
        id: '00000000-0000-4000-8000-000000000005',
        submission_id: '00000000-0000-4000-8000-000000000001',
        status: 'sent',
      }),
      expectedUpdatedAt: '2026-08-06T12:21:00.000Z',
      expectedStatuses: ['follow_up_pending'],
    },
    activity: { id: '00000000-0000-4000-8000-000000000008' },
  });
  assert.equal(finalizedClaim.applied, true);
  assert.equal(finalizedClaim.record.status, 'sent');
  const dismissal = await storage.mutateWithCrmActivity({
    operation: 'dismiss_deal_hunter_opportunity',
    payload: {
      submissionId: '00000000-0000-4000-8000-000000000001',
      expectedUpdatedAt: timestamp,
      values: { updated_at: '2026-08-06T12:15:00.000Z' },
      disposition: {
        id: '00000000-0000-4000-8000-000000000006',
        deal_key: 'deal-1',
        status: 'dismissed',
      },
    },
    activity: { id: '00000000-0000-4000-8000-000000000007' },
  });
  assert.equal(dismissal.record.submission.status, 'archived');
  assert.equal(dismissal.record.disposition.disposition, 'dismissed');
  assert.equal(dismissal.record.disposition.status, 'dismissed');

  assert.equal(calls[0].name, 'mutate_communications_with_crm_activity');
  assert.deepEqual(calls[1], {
    name: 'list_submissions_by_contact_email',
    parameters: { p_email: 'shared@example.com', p_limit: 3, p_open_only: true },
  });
  assert.equal(calls[2].name, 'list_deal_hunter_cim_request_history');
  assert.deepEqual(calls[2].parameters.p_delivery_states, ['not-attempted']);

  const deleteCall = calls.find((call) => call.name === 'delete_crm_submission_lifecycle');
  assert.equal(deleteCall.parameters.p_submission_id, '00000000-0000-4000-8000-000000000003');
  assert.equal(deleteCall.parameters.p_deleted_at, '2026-08-06T12:30:00.000Z');
  assert.deepEqual(
    calls.find((call) => call.name === 'claim_crm_communications_pending_ingestion'),
    {
      name: 'claim_crm_communications_pending_ingestion',
      parameters: {
        p_due_before: '2026-08-06T12:02:00.000Z',
        p_lease_until: '2026-08-06T12:12:00.000Z',
        p_limit: 7,
        p_claimed_by: 'supabase-communications-worker',
      },
    },
  );
  const cimClaimCall = calls.find((call) => call.name === 'claim_deal_hunter_cim_request');
  assert.equal(cimClaimCall.parameters.p_pending_cutoff, '2026-08-06T11:50:00.000Z');
  assert.equal(cimClaimCall.parameters.p_request.recipient_email, 'mixed.case@example.com');
  assert.equal(cimClaimCall.parameters.p_request.deal_key, 'claim-deal-1');
  assert.equal(cimClaimCall.parameters.p_request.submission_id, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(
    calls.find((call) => call.name === 'claim_deal_hunter_cim_follow_up_request'),
    {
      name: 'claim_deal_hunter_cim_follow_up_request',
      parameters: {
        p_request_id: '00000000-0000-4000-8000-000000000005',
        p_due_before: '2026-08-06T12:20:00.000Z',
        p_stale_before: '2026-08-06T11:50:00.000Z',
        p_claimed_at: '2026-08-06T12:20:00.000Z',
      },
    },
  );
  assert.deepEqual(
    calls.find((call) => call.name === 'renew_deal_hunter_cim_request_claim'),
    {
      name: 'renew_deal_hunter_cim_request_claim',
      parameters: {
        p_request_id: '00000000-0000-4000-8000-000000000005',
        p_expected_updated_at: '2026-08-06T12:20:00.000Z',
        p_expected_status: 'follow_up_pending',
        p_renewed_at: '2026-08-06T12:21:00.000Z',
      },
    },
  );
  const dismissCall = calls.find(
    (call) => call.name === 'mutate_communications_with_crm_activity'
      && call.parameters.p_operation === 'dismiss_deal_hunter_opportunity',
  );
  assert.equal(dismissCall.parameters.p_payload.submissionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(dismissCall.parameters.p_payload.disposition.deal_key, 'deal-1');
});

test('Supabase maps a fresh CIM deletion lease refusal to a deterministic conflict', async () => {
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name, parameters) {
          assert.equal(name, 'delete_crm_submission_lifecycle');
          assert.equal(parameters.p_submission_id, '00000000-0000-4000-8000-000000000030');
          assert.equal(parameters.p_deleted_at, '2026-08-06T12:05:00.000Z');
          return {
            data: null,
            error: {
              code: 'P0001',
              message: 'CIM transmission is in progress; CRM deletion is blocked until its claim lease expires.',
            },
          };
        },
      },
    },
  );

  await assert.rejects(
    storage.deleteSubmission('00000000-0000-4000-8000-000000000030', {
      deletedAt: '2026-08-06T12:05:00.000Z',
    }),
    (error) => error.code === 'CIM_SEND_IN_PROGRESS' && error.status === 409,
  );
});

test('direct Supabase communication and CIM-history pagination clamps non-finite and oversized pages', async () => {
  const ranges = [];
  const historyPages = [];
  const query = {
    select() { return this; },
    order() { return this; },
    range(from, to) {
      ranges.push([from, to]);
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    },
  };
  const client = {
    from(tableName) {
      assert.equal(tableName, 'crm_communications');
      return query;
    },
    async rpc(name, parameters) {
      assert.equal(name, 'list_deal_hunter_cim_request_history');
      historyPages.push(parameters.p_page);
      return {
        data: {
          rows: [], total: 0, page: parameters.p_page, pageSize: parameters.p_page_size, counts: {},
        },
        error: null,
      };
    },
  };
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    { client },
  );

  assert.equal((await storage.listCrmCommunications({ page: Number('1e309'), pageSize: 25 })).page, 1);
  assert.equal((await storage.listCrmCommunications({ page: 10001, pageSize: 25 })).page, 10000);
  assert.equal((await storage.listDealHunterCimRequestHistory({ page: Infinity })).page, 1);
  assert.equal((await storage.listDealHunterCimRequestHistory({ page: 10001 })).page, 10000);
  assert.deepEqual(ranges, [[0, 24], [249975, 249999]]);
  assert.deepEqual(historyPages, [1, 10000]);
});
