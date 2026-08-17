import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const initialAt = '2026-08-09T17:00:00.000Z';
const commandAt = '2026-08-09T17:05:00.000Z';

function submission(overrides = {}) {
  return {
    id: 'follow-up-submission',
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
    source: 'follow-up-storage-test',
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
    assigned_to: 'Admin',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: commandAt,
    last_contacted_at: null,
    metadata: {},
    ...overrides,
  };
}

function communication(overrides = {}) {
  return {
    id: 'follow-up-communication',
    submission_id: 'follow-up-submission',
    deal_key: null,
    cim_request_id: null,
    direction: 'outbound',
    channel: 'email',
    source: 'manual',
    kind: 'crm-follow-up',
    provider: 'resend',
    provider_message_id: null,
    source_event_id: null,
    idempotency_key: 'crm-follow-up-permanent-key',
    message_id: null,
    in_reply_to: '<parent@example.test>',
    references_json: ['<root@example.test>', '<parent@example.test>'],
    parent_communication_id: null,
    thread_key: 'follow-up-submission:avery@example.test',
    legacy_content_unavailable: false,
    content_redaction_state: 'sanitized',
    recommendation_id: 'recommendation-1',
    outbox_id: 'outbox-1',
    headers_json: {
      'In-Reply-To': '<parent@example.test>',
      References: '<root@example.test> <parent@example.test>',
    },
    reply_to_address: 'reply@example.test',
    from_address: 'Uckele Group <outreach@example.test>',
    to_addresses: ['avery@example.test'],
    cc_addresses: [],
    bcc_addresses: [],
    subject: 'Re: Example Manufacturing',
    body_text: 'Thanks for the update. Could we review the CIM next week?',
    body_html_sanitized: '<p>Thanks for the update. Could we review the CIM next week?</p>',
    occurred_at: commandAt,
    created_at: commandAt,
    updated_at: commandAt,
    delivery_state: 'not-attempted',
    delivery_state_at: null,
    content_state: 'complete',
    content_attempt_count: 0,
    content_last_error: null,
    content_next_attempt_at: null,
    attachment_metadata: [],
    assigned_at: commandAt,
    assigned_by: 'admin@example.test',
    created_by: 'admin@example.test',
    updated_by: 'admin@example.test',
    metadata: { fixture: true },
    ...overrides,
  };
}

function outbox(overrides = {}) {
  return {
    id: 'outbox-1',
    communication_id: 'follow-up-communication',
    submission_id: 'follow-up-submission',
    cim_request_id: null,
    idempotency_key: 'crm-follow-up-permanent-key',
    client_request_key: 'follow-up-submission:admin@example.test:confirmation-1',
    state: 'queued',
    provider: 'resend',
    provider_message_id: null,
    attempt_count: 0,
    next_attempt_at: commandAt,
    claim_token: null,
    claimed_at: null,
    claim_expires_at: null,
    accepted_at: null,
    failed_at: null,
    ambiguous_at: null,
    last_error_category: null,
    last_error_message: null,
    expected_submission_version: initialAt,
    actor: 'admin@example.test',
    intended_follow_up_state: 'waiting-on-owner',
    intended_next_action_at: '2026-08-12T17:00:00.000Z',
    created_at: commandAt,
    updated_at: commandAt,
    metadata: { fixture: true, recommendationDecision: 'accepted' },
    ...overrides,
  };
}

function activity() {
  return {
    id: 'follow-up-command-activity',
    submission_id: 'follow-up-submission',
    created_at: commandAt,
    actor: 'admin@example.test',
    role: 'admin',
    event_type: 'follow-up.email.queued',
    summary: 'CRM follow-up email queued for provider transmission.',
    metadata: { communicationId: 'follow-up-communication', outboxId: 'outbox-1' },
  };
}

function recommendation(overrides = {}) {
  return {
    id: 'recommendation-1',
    submission_id: 'follow-up-submission',
    cim_request_id: null,
    triggering_communication_id: null,
    input_fingerprint: 'fingerprint-1',
    engine_version: 'follow-up-engine-v1',
    rules_version: 'follow-up-rules-v1',
    model_provider: null,
    model_id: null,
    status: 'current',
    conversation_state: 'reply_received',
    intent: 'information_request',
    action_type: 'answer_question',
    priority_score: 90,
    confidence: 0.92,
    recommended_next_action_at: commandAt,
    thread_parent_communication_id: null,
    rationale: 'The newest inbound message contains a direct question.',
    evidence_json: [],
    signals_json: ['direct_question'],
    commitments_json: [],
    questions_json: ['Could we review the CIM?'],
    blockers_json: [],
    safety_flags_json: [],
    draft_subject: communication().subject,
    draft_body_text: communication().body_text,
    created_at: commandAt,
    expires_at: null,
    acted_on_at: null,
    superseded_at: null,
    acted_on_by: null,
    outcome: null,
    metadata: { aiRequested: false, aiUsed: false },
    ...overrides,
  };
}

function createStorage(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-follow-up-storage-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage;
}

test('SQLite creates one immutable communication/outbox/activity command and token-fences its claim', async (t) => {
  const storage = createStorage(t);
  await storage.insertSubmission(submission());

  const created = await storage.createCrmEmailCommand({
    communication: communication(),
    outbox: outbox(),
    activity: activity(),
    expectedSubmissionVersion: initialAt,
  });
  assert.equal(created.applied, true);
  assert.equal(created.outbox.state, 'queued');
  assert.equal(created.communication.body_text, communication().body_text);
  assert.deepEqual(created.communication.references_json, ['<root@example.test>', '<parent@example.test>']);
  assert.equal(created.submission.updated_at, commandAt, 'the atomic command advances the CRM concurrency version');
  assert.equal((await storage.listCrmActivityEvents({ submissionId: submission().id })).length, 1);

  const duplicate = await storage.createCrmEmailCommand({
    communication: communication({ id: 'must-not-be-created' }),
    outbox: outbox({ id: 'must-not-be-created', communication_id: 'must-not-be-created' }),
    activity: { ...activity(), id: 'must-not-be-created' },
    expectedSubmissionVersion: initialAt,
  });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'duplicate-client-request');
  assert.equal(duplicate.communication.id, created.communication.id);
  assert.equal((await storage.listCrmCommunications({ submissionId: submission().id })).total, 1);

  const stale = await storage.createCrmEmailCommand({
    communication: communication({ id: 'stale-communication', idempotency_key: 'stale-idempotency', outbox_id: 'stale-outbox' }),
    outbox: outbox({
      id: 'stale-outbox',
      communication_id: 'stale-communication',
      idempotency_key: 'stale-idempotency',
      client_request_key: 'follow-up-submission:admin@example.test:confirmation-2',
    }),
    activity: { ...activity(), id: 'stale-activity' },
    expectedSubmissionVersion: initialAt,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale-submission');

  const firstClaim = await storage.claimCrmEmailOutbox({
    id: created.outbox.id,
    claimToken: 'claim-token-one-1234567890',
    claimedAt: '2026-08-09T17:06:00.000Z',
    claimExpiresAt: '2026-08-09T17:11:00.000Z',
  });
  const competingClaim = await storage.claimCrmEmailOutbox({
    id: created.outbox.id,
    claimToken: 'claim-token-two-1234567890',
    claimedAt: '2026-08-09T17:06:01.000Z',
    claimExpiresAt: '2026-08-09T17:11:01.000Z',
  });
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.outbox.attempt_count, 1);
  assert.equal(competingClaim.claimed, false);

  assert.equal(await storage.finishCrmEmailOutboxClaim(created.outbox.id, 'wrong-token', {
    state: 'accepted', updated_at: '2026-08-09T17:06:30.000Z', accepted_at: '2026-08-09T17:06:30.000Z',
  }), null);
  const accepted = await storage.finishCrmEmailOutboxClaim(created.outbox.id, 'claim-token-one-1234567890', {
    state: 'accepted',
    provider: 'resend',
    provider_message_id: 'provider-email-1',
    updated_at: '2026-08-09T17:06:30.000Z',
    accepted_at: '2026-08-09T17:06:30.000Z',
    metadata: { reconciled: false },
  });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.provider_message_id, 'provider-email-1');
  assert.equal((await storage.getCrmEmailOutboxByProviderMessageId('provider-email-1')).id, accepted.id);
  assert.equal(await storage.countCrmEmailOutboxByStates(['accepted']), 1);
});

test('durable email commands record recommendation decisions, invalidate stale advice, and expose count-only metrics', async (t) => {
  const storage = createStorage(t);
  await storage.insertSubmission(submission());
  await storage.insertCrmFollowUpRecommendation(recommendation({
    model_provider: 'openai',
    model_id: 'synthetic-model-snapshot',
    metadata: {
      aiRequested: true,
      aiUsed: true,
      aiResponseState: 'completed',
      aiLatencyMs: 40,
      aiInputTokens: 100,
      aiOutputTokens: 20,
      aiCachedTokens: 10,
      aiReasoningTokens: 5,
    },
  }));

  const acceptedDecision = await storage.createCrmEmailCommand({
    communication: communication(),
    outbox: outbox(),
    activity: activity(),
    expectedSubmissionVersion: initialAt,
  });
  assert.equal(acceptedDecision.applied, true);
  assert.equal((await storage.getCrmFollowUpRecommendation('recommendation-1')).status, 'accepted');
  assert.equal(await storage.getCurrentCrmFollowUpRecommendation('follow-up-submission'), null);

  await storage.insertSubmission(submission({
    id: 'edited-submission',
    email: 'edited@example.test',
    broker_email: 'edited@example.test',
  }));
  await storage.insertCrmFollowUpRecommendation(recommendation({
    id: 'recommendation-2',
    submission_id: 'edited-submission',
    input_fingerprint: 'fingerprint-2',
    draft_body_text: 'An original suggested draft.',
    metadata: {
      aiRequested: true,
      aiUsed: false,
      aiFallbackReason: 'timeout',
      aiResponseState: 'provider-error',
      aiLatencyMs: 120,
      aiInputTokens: null,
      aiOutputTokens: null,
      aiCachedTokens: null,
      aiReasoningTokens: null,
    },
  }));
  await storage.createCrmEmailCommand({
    communication: communication({
      id: 'edited-communication',
      submission_id: 'edited-submission',
      recommendation_id: 'recommendation-2',
      outbox_id: 'outbox-2',
      idempotency_key: 'edited-permanent-key',
      to_addresses: ['edited@example.test'],
      body_text: 'The administrator deliberately edited this draft.',
    }),
    outbox: outbox({
      id: 'outbox-2',
      communication_id: 'edited-communication',
      submission_id: 'edited-submission',
      idempotency_key: 'edited-permanent-key',
      client_request_key: 'edited-submission:admin@example.test:confirmation-2',
      metadata: { fixture: true, recommendationDecision: 'edited_and_accepted' },
    }),
    activity: {
      ...activity(), id: 'edited-command-activity', submission_id: 'edited-submission',
      metadata: { communicationId: 'edited-communication', outboxId: 'outbox-2' },
    },
    expectedSubmissionVersion: initialAt,
  });
  assert.equal((await storage.getCrmFollowUpRecommendation('recommendation-2')).status, 'edited_and_accepted');

  const metrics = await storage.getCrmFollowUpOperationalMetrics({ since: initialAt });
  assert.equal(metrics.outbox.queued, 2);
  assert.equal(metrics.recommendations.accepted, 1);
  assert.equal(metrics.recommendations.editedAndAccepted, 1);
  assert.equal(metrics.recommendations.aiUsed, 1);
  assert.equal(metrics.recommendations.aiFallback, 1);
  assert.deepEqual(metrics.ai.fallbackReasons, { timeout: 1 });
  assert.deepEqual(metrics.ai.responseStates, { completed: 1, 'provider-error': 1 });
  assert.deepEqual(metrics.ai.latencyMs, {
    observed: 2, average: 80, minimum: 40, maximum: 120, total: 160,
  });
  assert.deepEqual(metrics.ai.tokens, {
    observed: 1, inputTotal: 100, outputTotal: 20, cachedTotal: 10, reasoningTotal: 5,
  });
  assert.equal(metrics.suppressions.active, 0);
  assert.equal(Object.hasOwn(metrics, 'communications'), false, 'operational metrics never expose message records');
});

test('Supabase operational metrics preserve missing AI observations as null', async () => {
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } },
    {
      client: {
        async rpc(name) {
          assert.equal(name, 'get_crm_follow_up_operational_metrics');
          return {
            data: {
              ai: {
                fallbackReasons: { timeout: 2 },
                responseStates: { 'provider-error': 2 },
                latencyMs: { observed: 0, average: null, minimum: null, maximum: null, total: null },
                tokens: {
                  observed: 0,
                  inputTotal: null,
                  outputTotal: null,
                  cachedTotal: null,
                  reasoningTotal: null,
                },
              },
            },
            error: null,
          };
        },
      },
    },
  );

  const metrics = await storage.getCrmFollowUpOperationalMetrics({ since: initialAt });
  assert.deepEqual(metrics.ai.latencyMs, {
    observed: 0, average: null, minimum: null, maximum: null, total: null,
  });
  assert.deepEqual(metrics.ai.tokens, {
    observed: 0,
    inputTotal: null,
    outputTotal: null,
    cachedTotal: null,
    reasoningTotal: null,
  });
});

test('SQLite stores RFC identity, recommendations, and globally normalized suppressions', async (t) => {
  const storage = createStorage(t);
  await storage.insertSubmission(submission());
  const inbound = await storage.insertCrmCommunication(communication({
    id: 'inbound-rfc-communication',
    direction: 'inbound',
    provider_message_id: 'provider-inbound-1',
    source_event_id: 'provider-event-inbound-1',
    idempotency_key: 'inbound-rfc-idempotency',
    message_id: '<received-message@example.test>',
    in_reply_to: '<sent-message@example.test>',
    references_json: ['<root-message@example.test>', '<sent-message@example.test>'],
    outbox_id: null,
    recommendation_id: null,
  }));
  assert.equal((await storage.getCrmCommunicationByMessageId('  <received-message@example.test>  ')).id, inbound.id);
  assert.equal(inbound.legacy_content_unavailable, false);

  const storedRecommendation = await storage.insertCrmFollowUpRecommendation(recommendation({
    triggering_communication_id: inbound.id,
    thread_parent_communication_id: inbound.id,
    evidence_json: [{ communicationId: inbound.id, signal: 'direct_question', excerpt: 'Could we review the CIM?' }],
    draft_body_text: 'Yes. I can review it next week.',
  }));
  assert.equal(storedRecommendation.priority_score, 90);
  assert.equal((await storage.getCurrentCrmFollowUpRecommendation(submission().id)).id, storedRecommendation.id);
  await storage.upsertDealHunterCimRequest({
    id: 'recommendation-invalidation-cim',
    created_at: commandAt,
    updated_at: '2026-08-09T17:10:00.000Z',
    deal_key: 'recommendation-invalidation-deal',
    recipient_email: 'avery@example.test',
    status: 'sent',
    submission_id: submission().id,
    metadata: {},
  });
  assert.equal(await storage.getCurrentCrmFollowUpRecommendation(submission().id), null);
  assert.equal((await storage.getCrmFollowUpRecommendation(storedRecommendation.id)).status, 'superseded');

  const suppression = await storage.upsertEmailSuppression({
    id: 'suppression-1',
    normalized_email: ' AVERY@EXAMPLE.TEST ',
    reason: 'explicit-opt-out',
    source: 'inbound-content',
    source_event_id: null,
    source_communication_id: inbound.id,
    created_at: commandAt,
    created_by: 'communications-ingestion',
    metadata: { evidenceCommunicationId: inbound.id },
  });
  assert.equal(suppression.normalized_email, 'avery@example.test');
  assert.equal((await storage.getActiveEmailSuppression('AVERY@example.test')).reason, 'explicit-opt-out');
  const lifted = await storage.liftEmailSuppression('avery@example.test', {
    liftedAt: '2026-08-09T18:00:00.000Z',
    liftedBy: 'admin@example.test',
    liftReason: 'Verified administrative correction.',
  });
  assert.equal(lifted.lifted_by, 'admin@example.test');
  assert.equal(await storage.getActiveEmailSuppression('avery@example.test'), null);
});

test('SQLite follow-up queue uses filtered server pagination, subject search, and stable safety sorting', async (t) => {
  const storage = createStorage(t);
  const records = [
    submission({
      id: 'queue-overdue',
      company: 'Overdue Company',
      email: 'overdue@example.test',
      broker_email: 'overdue@example.test',
      next_action_at: '2026-08-07T17:00:00.000Z',
    }),
    submission({
      id: 'queue-inbound',
      company: 'Inbound Company',
      email: 'inbound@example.test',
      broker_email: 'inbound@example.test',
      next_action_at: '2026-08-10T17:00:00.000Z',
    }),
    submission({
      id: 'queue-bounced',
      company: 'Bounced Company',
      email: 'bounced@example.test',
      broker_email: 'bounced@example.test',
      next_action_at: '2026-08-11T17:00:00.000Z',
    }),
    submission({
      id: 'queue-completed',
      company: 'Completed Company',
      email: 'completed@example.test',
      broker_email: 'completed@example.test',
      follow_up_state: 'completed',
      next_action_at: null,
    }),
  ];
  for (const record of records) await storage.insertSubmission(record);
  await storage.insertCrmCommunication(communication({
    id: 'queue-inbound-message',
    submission_id: 'queue-inbound',
    direction: 'inbound',
    from_address: 'inbound@example.test',
    subject: 'Question about the turbine listing',
    provider_message_id: 'queue-provider-inbound',
    source_event_id: 'queue-event-inbound',
    idempotency_key: 'queue-inbound-idempotency',
    outbox_id: null,
    recommendation_id: null,
  }));
  await storage.insertCrmCommunication(communication({
    id: 'queue-bounced-message',
    submission_id: 'queue-bounced',
    direction: 'outbound',
    to_addresses: ['bounced@example.test'],
    subject: 'Machine shop acquisition',
    delivery_state: 'bounced',
    provider_message_id: 'queue-provider-bounced',
    source_event_id: 'queue-event-bounced',
    idempotency_key: 'queue-bounced-idempotency',
    outbox_id: null,
    recommendation_id: null,
  }));

  const firstPage = await storage.listFollowUpSubmissions({
    page: 1,
    pageSize: 2,
    view: 'all',
    sort: 'urgency',
    now: commandAt,
    todayStart: '2026-08-09T07:00:00.000Z',
    todayEnd: '2026-08-10T07:00:00.000Z',
  });
  const secondPage = await storage.listFollowUpSubmissions({
    page: 2,
    pageSize: 2,
    view: 'all',
    sort: 'urgency',
    now: commandAt,
    todayStart: '2026-08-09T07:00:00.000Z',
    todayEnd: '2026-08-10T07:00:00.000Z',
  });
  assert.equal(firstPage.total, 4);
  assert.deepEqual(firstPage.rows.map((row) => row.id), ['queue-bounced', 'queue-inbound']);
  assert.deepEqual(secondPage.rows.map((row) => row.id), ['queue-overdue', 'queue-completed']);
  assert.equal(firstPage.rows[0].follow_up_latest_delivery_state, 'bounced');

  const subjectSearch = await storage.listFollowUpSubmissions({
    page: 1,
    pageSize: 25,
    view: 'all',
    search: 'turbine',
    now: commandAt,
    todayStart: '2026-08-09T07:00:00.000Z',
    todayEnd: '2026-08-10T07:00:00.000Z',
  });
  assert.equal(subjectSearch.total, 1);
  assert.equal(subjectSearch.rows[0].id, 'queue-inbound');

  const deliveryProblems = await storage.listFollowUpSubmissions({
    page: 1,
    pageSize: 25,
    view: 'delivery-problem',
    now: commandAt,
    todayStart: '2026-08-09T07:00:00.000Z',
    todayEnd: '2026-08-10T07:00:00.000Z',
  });
  assert.equal(deliveryProblems.total, 1);
  assert.equal(deliveryProblems.rows[0].id, 'queue-bounced');
});
