import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DELIVERY_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test_local_only';
process.env.RESEND_FROM_EMAIL = 'buyer@example.test';
process.env.RESEND_REPLY_TO = 'replies@example.test';
process.env.EMAIL_WEBHOOK_SECRET = 'cim-lifecycle-webhook-secret';
process.env.LEAD_NOTIFICATION_EMAIL = 'admin@example.test';
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/cim-lifecycle.csv';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = '';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED = 'true';
process.env.DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY = 'false';
process.env.DEAL_HUNTER_CIM_RECIPIENT_24_HOUR_CAP = '100';
process.env.DEAL_HUNTER_CIM_RECIPIENT_30_DAY_TOUCH_CAP = '100';
process.env.DEAL_HUNTER_CIM_AUTOMATION_STAGE = '2';
process.env.DEAL_HUNTER_CIM_AUTOMATION_MIN_SCORE = '75';
process.env.ADMIN_SESSION_SECRET = 'cim-communication-lifecycle-test-secret';

const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Profit Multiple,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Listing URL,Description',
  `"Commercial Safety Services","Fire safety inspection maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","3.1","Erin Broker","erin@example.com","Alex Contact","alex@example.com","https://broker.example.test/listing-42","Recurring commercial inspection, maintenance contracts, compliance work, trained field technicians, management in place, SBA eligible."`,
].join('\n');
let activeSourceCsv = sourceCsv;

const originalFetch = globalThis.fetch;
let activeStorage = null;
let resendMode = 'ok';
let resendCalls = [];
let heldProviderEntered = null;
let releaseHeldProvider = null;
let expectedManualProviderInvariant = null;
const boundedCimRequestKeys = [
  'canCorrectRecipient', 'canRetry', 'correctionRoute', 'createdAt', 'deliveredAt', 'deliveryState',
  'errorSummary', 'followUpState', 'id', 'providerAcceptedAt', 'recipient', 'requestedAt', 'requestState',
  'respondedAt', 'retryRoute', 'status', 'subject', 'updatedAt',
].sort();

function assertBoundedCimRequest(request) {
  assert.deepEqual(Object.keys(request).sort(), boundedCimRequestKeys);
  assert.deepEqual(Object.keys(request.recipient).sort(), ['displayName', 'email']);
  for (const rawKey of [
    'metadata', 'administratorPrincipalId', 'proposalDigest', 'nonce', 'preparedAt', 'delivery_error',
    'provider_response', 'request_state', 'delivery_state', 'follow_up_state', 'signature', 'approvalClaims',
  ]) assert.equal(Object.hasOwn(request, rawKey), false, `${rawKey} must not cross the approval boundary`);
}

before(() => {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://example.test/cim-lifecycle.csv') {
      return new Response(activeSourceCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    if (target.includes('api.airtable.com')) {
      return Response.json({ records: [] });
    }
    if (target === 'https://api.resend.com/emails' && options.method === 'POST') {
      const storedBeforeProviderCall = await activeStorage.listCrmCommunications({ page: 1, pageSize: 100 });
      const crmBeforeProviderCall = await activeStorage.listSubmissions({ page: 1, limit: 100, status: 'all' });
      assert.ok(crmBeforeProviderCall.total > 0, 'CRM lead must exist before provider transmission');
      const providerBody = JSON.parse(options.body);
      if (/^CIM \/ NDA request/i.test(providerBody.subject || '')) {
        assert.ok(storedBeforeProviderCall.total > 0, 'exact CIM communication must exist before provider transmission');
      }
      if (expectedManualProviderInvariant) {
        const expected = expectedManualProviderInvariant;
        const durable = storedBeforeProviderCall.rows.find((row) => row.id === expected.communicationId);
        assert.ok(durable, 'manual follow-up communication must already be durable during provider invocation');
        assert.equal(durable.subject, expected.subject);
        assert.equal(durable.body_text, expected.text);
        assert.equal(durable.body_html_sanitized, expected.html);
        assert.deepEqual(durable.to_addresses, [expected.recipient]);
        assert.equal(durable.from_address, expected.senderEmail);
        assert.equal(durable.metadata?.manualApproval?.senderDisplayName, expected.senderDisplayName);
        assert.equal(durable.metadata?.manualApproval?.senderEmail, expected.senderEmail);
        assert.equal(durable.metadata?.manualApproval?.senderFrom, expected.senderFrom);
        assert.equal(durable.idempotency_key, expected.providerIdempotencyKey);
        assert.equal(options.headers['Idempotency-Key'], expected.providerIdempotencyKey);
      }
      resendCalls.push({
        body: providerBody,
        idempotencyKey: options.headers['Idempotency-Key'],
      });
      if (resendMode === 'hold') {
        heldProviderEntered?.();
        await new Promise((resolve) => { releaseHeldProvider = resolve; });
      }
      if (resendMode === 'ambiguous') throw new Error('simulated transport timeout after request dispatch');
      if (resendMode === 'fail') return new Response('provider rejected test message', { status: 503 });
      return Response.json({ id: `resend-message-${resendCalls.length}` }, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
});

beforeEach(() => {
  resendMode = 'ok';
  resendCalls = [];
  heldProviderEntered = null;
  releaseHeldProvider = null;
  expectedManualProviderInvariant = null;
  activeSourceCsv = sourceCsv;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function testStorage(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-communications-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  activeStorage = storage;
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (activeStorage === storage) activeStorage = null;
  });
  return storage;
}

async function reviewedDeal(storage) {
  const { reviewDailyDeals } = await import('../server/services/dealHunter.js');
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  assert.ok(deal, 'fixture should produce a CIM-ready opportunity');
  return deal;
}

async function preparedManualApproval(storage) {
  const deal = await reviewedDeal(storage);
  const scoredAt = new Date().toISOString();
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: deal.opportunityId,
    scored_at: scoredAt,
    deal_key: deal.dealKey,
    name: deal.name,
    state: deal.state || '',
    listing_url: deal.listingUrl || '',
    fit_score: 70,
    score_status: 'watchlist',
    confidence: 'medium',
    completeness_score: 70,
    contradiction_count: 0,
    missing_evidence_count: 0,
    should_remove: false,
    high_fit: false,
    gate_count: 0,
    score_fingerprint: `manual-score-${deal.opportunityId}`,
    semantic_digest: `manual-semantic-${deal.opportunityId}`,
    engine_version: 'manual-approval-test',
    rules_version: 'manual-approval-test',
    profile_version: 'manual-approval-test',
    completeness_policy_version: 'manual-approval-test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([deal.opportunityId]);
  const { setTriageOperatorDecision } = await import('../server/services/dealHunterTriage.js');
  const decision = await setTriageOperatorDecision({
    opportunityId: deal.opportunityId,
    priority: 'high',
    markReviewed: true,
    actor: 'manual-approval-admin',
    storage,
  });
  assert.equal(decision.ok, true, decision.error);
  const {
    loadBrokerMaterialsAuthority,
    prepareDealHunterBrokerMaterials,
  } = await import('../server/services/dealHunterBrokerMaterials.js');
  const authority = await loadBrokerMaterialsAuthority({ opportunityId: deal.opportunityId, storage });
  const recipient = authority.recipientOptions.find((option) => option.email === deal.brokerEmail)
    || authority.recipientOptions[0];
  assert.ok(recipient, 'fixture must expose an authoritative recipient');
  const preparation = await prepareDealHunterBrokerMaterials({
    opportunityId: deal.opportunityId,
    recipientContactRef: recipient.recipientContactRef,
    greeting: 'Hello Erin,',
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(preparation.success, true, preparation.error);
  return { deal, preparation };
}

async function approvePreparedManual({ storage, preparation }) {
  const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
  return approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
}

function observeApprovalDispositionReads(storage) {
  const listDispositions = storage.listDealHunterDispositions.bind(storage);
  let reads = 0;
  storage.listDealHunterDispositions = async (...args) => {
    reads += 1;
    return listDispositions(...args);
  };
  return () => reads;
}

test('production EmailJS CIM delivery fails closed before any provider call', () => {
  const deliveryModuleUrl = new URL('../server/services/delivery.js', import.meta.url).href;
  const script = `
    process.env.NODE_ENV = 'production';
    process.env.DELIVERY_PROVIDER = 'emailjs';
    process.env.EMAILJS_SERVICE_ID = 'service-test';
    process.env.EMAILJS_TEMPLATE_ID = 'template-test';
    process.env.EMAILJS_PUBLIC_KEY = 'public-test';
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      return new Response('OK', { status: 200 });
    };
    const { sendPreparedMessage } = await import(${JSON.stringify(deliveryModuleUrl)});
    const result = await sendPreparedMessage({
      kind: 'deal-hunter-cim-request',
      to: ['broker@example.test'],
      subject: 'CIM / NDA request for Safety Services',
      text: 'Exact private request',
      html: '<p>Exact private request</p>',
      idempotencyKey: 'emailjs-must-not-send',
    });
    const cimProviderCalls = providerCalls;
    const ordinaryResult = await sendPreparedMessage({
      kind: 'admin-email-test',
      to: ['admin@example.test'],
      subject: '[TEST] ordinary EmailJS delivery',
      text: 'Test-only ordinary application mail',
      html: '<p>Test-only ordinary application mail</p>',
    });
    process.stdout.write(JSON.stringify({ result, ordinaryResult, cimProviderCalls, providerCalls }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.result.status, 'failed');
  assert.match(output.result.error, /not eligible for CIM outreach/i);
  assert.equal(output.cimProviderCalls, 0);
  assert.equal(output.ordinaryResult.status, 'sent');
  assert.equal(output.providerCalls, 1, 'ordinary EmailJS application mail should remain available');
});

test('CIM send links CRM and persists the exact message before provider acceptance, then tracks delivery independently', async (t) => {
  const storage = testStorage(t);
  const {
    listDealHunterCimRequestHistory,
    runDealHunterCimFollowUps,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const { applyEmailLifecycleToCommunication } = await import('../server/services/communications.js');
  const deal = await reviewedDeal(storage);
  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'lifecycle-admin',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.request.request_state, 'provider_accepted');
  assert.equal(result.request.delivery_state, 'accepted');
  assert.equal(result.request.delivered_at, null);
  assert.ok(result.request.submission_id);
  assert.ok(result.request.first_requested_at);
  assert.ok(result.request.first_provider_accepted_at);
  assert.equal(resendCalls.length, 1);

  const initialRequestedAt = result.request.first_requested_at;
  const communicationResult = await storage.listCrmCommunications({
    submissionId: result.request.submission_id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(communicationResult.total, 1);
  const [communication] = communicationResult.rows;
  assert.equal(communication.cim_request_id, result.request.id);
  assert.deepEqual(communication.to_addresses, ['erin@example.com']);
  assert.equal(communication.subject, resendCalls[0].body.subject);
  assert.equal(communication.body_text, resendCalls[0].body.text);
  assert.equal(communication.body_html_sanitized, resendCalls[0].body.html);
  assert.equal(communication.reply_to_address, resendCalls[0].body.reply_to);
  assert.equal(communication.delivery_state, 'accepted');

  const deliveredAt = new Date(Date.now() + 1000).toISOString();
  await applyEmailLifecycleToCommunication({
    id: 'delivery-event-1',
    provider: 'resend',
    event_type: 'delivered',
    message_id: result.request.provider_message_id,
    communication_id: communication.id,
    created_at: deliveredAt,
    metadata: {},
  }, { storage });
  const deliveredCommunication = await storage.getCrmCommunication(communication.id);
  const deliveredRequest = await storage.getDealHunterCimRequestById(result.request.id);
  assert.equal(deliveredCommunication.delivery_state, 'delivered');
  assert.equal(deliveredRequest.delivery_state, 'delivered');
  assert.equal(deliveredRequest.delivered_at, deliveredAt);
  assert.equal(deliveredRequest.first_requested_at, initialRequestedAt);

  await storage.upsertDealHunterCimRequest({
    ...deliveredRequest,
    status: 'sent',
    next_follow_up_at: new Date(Date.now() - 1000).toISOString(),
    follow_up_state: 'scheduled',
  });
  const followUp = await runDealHunterCimFollowUps({
    storage,
    now: new Date(),
    settings: {
      enabled: true,
      firstDelayHours: 1,
      intervalHours: 1,
      delaySequenceHours: [1],
      maxCount: 3,
      weekdaysOnly: false,
      timezone: 'America/Los_Angeles',
      sendWindowStart: '00:00',
      sendWindowEnd: '23:59',
    },
  });
  assert.equal(followUp.sent, 1);
  const afterFollowUp = await storage.getDealHunterCimRequestById(result.request.id);
  assert.equal(afterFollowUp.first_requested_at, initialRequestedAt);
  const allCommunications = await storage.listCrmCommunications({ submissionId: result.request.submission_id, page: 1, pageSize: 25 });
  assert.equal(allCommunications.total, 2);
  const persistedFollowUp = allCommunications.rows.find((item) => item.kind === 'deal-hunter-cim-follow-up');
  assert.ok(persistedFollowUp);
  assert.equal(resendCalls.length, 2);
  assert.deepEqual(persistedFollowUp.to_addresses, resendCalls[1].body.to);
  assert.equal(persistedFollowUp.subject, resendCalls[1].body.subject);
  assert.equal(persistedFollowUp.body_text, resendCalls[1].body.text);
  assert.equal(persistedFollowUp.body_html_sanitized, resendCalls[1].body.html);
  assert.equal(persistedFollowUp.reply_to_address, resendCalls[1].body.reply_to);
  assert.equal(persistedFollowUp.delivery_state, 'accepted');

  const history = await listDealHunterCimRequestHistory({ search: 'Commercial Safety', storage });
  assert.equal(history.total, 1);
  assert.equal(history.rows[0].first_requested_at, initialRequestedAt);
  assert.equal(history.rows[0].submission_id, result.request.submission_id);
  assert.equal(history.rows[0].communications.length, 2);
  assert.equal(history.rows[0].communications[0].kind, 'deal-hunter-cim-request');
  assert.equal(history.rows[0].communications[0].body_text, resendCalls[0].body.text);
  assert.deepEqual(history.rows[0].communications[0].to_addresses, resendCalls[0].body.to);
  assert.equal(history.rows[0].communications[1].kind, 'deal-hunter-cim-follow-up');
  assert.equal(history.rows[0].communications[1].body_text, resendCalls[1].body.text);
});

test('direct CIM send preserves the signed approved copy when a later healthy review changes template fields', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const approvedPreview = deal.cimRequest.preview;

  activeSourceCsv = sourceCsv.replace(
    'Fire safety inspection',
    'Fire safety inspection - changed after approval',
  );

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'approved-copy-admin',
    storage,
  });
  const communicationResult = await storage.listCrmCommunications({
    submissionId: result.request.submission_id,
    page: 1,
    pageSize: 25,
  });
  const [communication] = communicationResult.rows;

  assert.equal(result.ok, true);
  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].body.subject, approvedPreview.subject);
  assert.equal(resendCalls[0].body.text, approvedPreview.text);
  assert.equal(communication.subject, approvedPreview.subject);
  assert.equal(communication.body_text, approvedPreview.text);
  assert.equal(result.request.metadata.industry, deal.industry);
  assert.doesNotMatch(communication.body_text, /changed after approval/i);
  assert.doesNotMatch(communication.body_html_sanitized, /changed after approval/i);
});

test('approved manual Stage 1 uses the existing durable executor once, persists exact signed copy, and never schedules follow-up', async (t) => {
  // Break caught: Task 2 has no trusted entry into the existing executor and
  // therefore cannot preserve exact approved copy or the manual no-follow-up policy.
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const service = await import('../server/services/dealHunterBrokerMaterials.js');
  const dealHunter = await import('../server/services/dealHunter.js');
  const { getConfig } = await import('../server/config.js');
  const { verifySignedPayload } = await import('../server/utils/security.js');
  assert.equal(typeof service.approveDealHunterBrokerMaterials, 'function');
  assert.equal(typeof dealHunter.executeApprovedDealHunterCimRequest, 'function');
  const signedClaims = verifySignedPayload(preparation.preparationToken, getConfig().admin.sessionSecret);
  assert.ok(signedClaims);

  const first = await service.approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(first.success, true);
  const request = first.durableResult.cimRequest;
  assert.equal(request.id, signedClaims.approvalBoundPayload.prospectiveRequestId);
  assert.equal(resendCalls.length, 1);
  assert.equal(
    resendCalls[0].body.from,
    `${preparation.review.sender.displayName} <${preparation.review.sender.email}>`,
  );
  assert.deepEqual(resendCalls[0].body.to, [preparation.review.recipient.email]);
  assert.equal(resendCalls[0].body.reply_to, preparation.review.sender.replyTo);
  assert.equal(resendCalls[0].body.subject, preparation.review.message.subject);
  assert.equal(resendCalls[0].body.text, preparation.review.message.body);
  assert.equal(resendCalls[0].body.html, preparation.review.message.html);

  assertBoundedCimRequest(request);
  assert.equal(request.recipient.email, preparation.review.recipient.email);
  assert.equal(request.followUpState, 'not-scheduled');
  const storedRequest = await storage.getDealHunterCimRequestById(request.id);
  assert.equal(storedRequest.next_follow_up_at, null);
  assert.equal(storedRequest.metadata?.manualApproval?.intent, 'manual_stage_1');
  assert.equal(storedRequest.metadata?.manualApproval?.followUpPolicy, 'none');
  const page = await storage.listCrmCommunications({ submissionId: storedRequest.submission_id, page: 1, pageSize: 25 });
  assert.equal(page.total, 1);
  const [communication] = page.rows;
  assert.equal(communication.cim_request_id, request.id);
  assert.equal(communication.kind, 'deal-hunter-cim-request');
  assert.equal(communication.from_address, preparation.review.sender.email);
  assert.deepEqual(communication.to_addresses, [preparation.review.recipient.email]);
  assert.equal(communication.reply_to_address, preparation.review.sender.replyTo);
  assert.equal(communication.subject, preparation.review.message.subject);
  assert.equal(communication.body_text, preparation.review.message.body);
  assert.equal(communication.body_html_sanitized, preparation.review.message.html);
  assert.equal(communication.metadata?.templateVersion, preparation.review.message.templateVersion);
  assert.equal(resendCalls[0].idempotencyKey, communication.idempotency_key);

  const replay = await service.approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(replay.success, true);
  assertBoundedCimRequest(replay.durableResult.cimRequest);
  assert.equal(replay.durableResult.cimRequest.id, request.id);
  assert.deepEqual(Object.keys(replay.durableResult.cimRequest).sort(), Object.keys(request).sort());
  assert.equal(resendCalls.length, 1, 'replaying the approval must not call the provider twice');
});

test('manual approval fails closed when final disposition authority throws after approval revalidation', async (t) => {
  // Break caught: the shared executor treats an indeterminate final disposition
  // as clear authority for trusted manual Stage 1 and reaches the provider.
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const approvalDispositionReads = observeApprovalDispositionReads(storage);
  let finalDispositionReads = 0;
  storage.getDealHunterDisposition = async () => {
    finalDispositionReads += 1;
    throw new Error('simulated final disposition authority outage');
  };

  const result = await approvePreparedManual({ storage, preparation });
  const request = result.durableResult?.cimRequest;
  const storedRequest = request?.id ? await storage.getDealHunterCimRequestById(request.id) : null;

  assert.equal(approvalDispositionReads(), 1, 'approval revalidation must first establish current disposition authority');
  assert.equal(finalDispositionReads, 1, 'the durable executor must perform its final disposition read');
  assert.equal(resendCalls.length, 0, 'indeterminate final disposition authority must block provider work');
  assert.equal(result.success, true, 'the already-created durable request remains authoritative');
  assert.equal(request.status, 'failed');
  assert.equal(request.providerAcceptedAt, '');
  assert.equal(storedRequest.provider_message_id || '', '');
  assert.equal(storedRequest.first_provider_accepted_at, null);
  assert.match(storedRequest.delivery_error, /final dismissal check is unavailable/i);
});

test('manual approval fails closed when final disposition capability is unavailable', async (t) => {
  // Break caught: an absent final disposition reader is treated as clear
  // authority for trusted manual Stage 1 and reaches the provider.
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const approvalDispositionReads = observeApprovalDispositionReads(storage);
  storage.getDealHunterDisposition = undefined;

  const result = await approvePreparedManual({ storage, preparation });
  const request = result.durableResult?.cimRequest;
  const storedRequest = request?.id ? await storage.getDealHunterCimRequestById(request.id) : null;

  assert.equal(approvalDispositionReads(), 1, 'approval revalidation must first establish current disposition authority');
  assert.equal(resendCalls.length, 0, 'missing final disposition capability must block provider work');
  assert.equal(result.success, true, 'the already-created durable request remains authoritative');
  assert.equal(request.status, 'failed');
  assert.equal(request.providerAcceptedAt, '');
  assert.equal(storedRequest.provider_message_id || '', '');
  assert.equal(storedRequest.first_provider_accepted_at, null);
  assert.match(storedRequest.delivery_error, /final dismissal check is unavailable/i);
});

test('manual approval blocks a late Pass returned after approval revalidation', async (t) => {
  // Break caught: a Pass winning the approval-to-claim race reaches the
  // provider instead of becoming durable no-send evidence.
  const storage = testStorage(t);
  const { deal, preparation } = await preparedManualApproval(storage);
  const approvalDispositionReads = observeApprovalDispositionReads(storage);
  let finalDispositionReads = 0;
  storage.getDealHunterDisposition = async () => {
    finalDispositionReads += 1;
    return { id: 'manual-late-pass', deal_key: deal.dealKey, disposition: 'dismissed' };
  };

  const result = await approvePreparedManual({ storage, preparation });
  const request = result.durableResult?.cimRequest;
  const storedRequest = request?.id ? await storage.getDealHunterCimRequestById(request.id) : null;

  assert.equal(approvalDispositionReads(), 1, 'approval revalidation must first establish current disposition authority');
  assert.equal(finalDispositionReads, 1);
  assert.equal(resendCalls.length, 0, 'a late returned Pass must block provider work');
  assert.equal(result.success, true, 'the already-created durable request remains authoritative');
  assert.equal(request.status, 'failed');
  assert.equal(request.providerAcceptedAt, '');
  assert.equal(storedRequest.provider_message_id || '', '');
  assert.equal(storedRequest.first_provider_accepted_at, null);
  assert.match(storedRequest.delivery_error, /dismissed before provider work/i);
});

test('manual approval returns a durable failed request instead of an unsafe transport error', async (t) => {
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
  assert.equal(typeof approveDealHunterBrokerMaterials, 'function');
  resendMode = 'fail';
  const result = await approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(result.success, true);
  assertBoundedCimRequest(result.durableResult.cimRequest);
  assert.equal(result.durableResult.cimRequest.status, 'failed');
  assert.equal(result.durableResult.cimRequest.followUpState, 'not-scheduled');
  assert.equal((await storage.getDealHunterCimRequestById(result.durableResult.cimRequest.id)).next_follow_up_at, null);
  assert.equal(resendCalls.length, 1);
});

test('manual approval keeps an ambiguous provider outcome durable and replay cannot retransmit it', async (t) => {
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
  assert.equal(typeof approveDealHunterBrokerMaterials, 'function');
  resendMode = 'ambiguous';
  const first = await approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(first.success, true);
  assertBoundedCimRequest(first.durableResult.cimRequest);
  assert.equal(first.durableResult.cimRequest.status, 'ambiguous');
  assert.equal(resendCalls.length, 1);

  resendMode = 'ok';
  const replay = await approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });
  assert.equal(replay.success, true);
  assertBoundedCimRequest(replay.durableResult.cimRequest);
  assert.equal(replay.durableResult.cimRequest.id, first.durableResult.cimRequest.id);
  assert.equal(replay.durableResult.cimRequest.status, 'ambiguous');
  assert.equal(resendCalls.length, 1, 'ambiguous approval replay must never retransmit');
});

test('manual approval final readiness drift persists one unscheduled durable failure before provider work', async (t) => {
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
  const { getConfig } = await import('../server/config.js');
  const config = getConfig();
  const originalApiKey = config.delivery.resendApiKey;
  const mutateWithCrmActivity = storage.mutateWithCrmActivity.bind(storage);
  t.after(() => {
    config.delivery.resendApiKey = originalApiKey;
    storage.mutateWithCrmActivity = mutateWithCrmActivity;
  });
  storage.mutateWithCrmActivity = async (mutation) => {
    const result = await mutateWithCrmActivity(mutation);
    if (mutation.operation === 'insert_crm_communication') config.delivery.resendApiKey = '';
    return result;
  };

  const result = await approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  });

  assert.equal(result.success, true);
  assertBoundedCimRequest(result.durableResult.cimRequest);
  assert.equal(result.durableResult.cimRequest.status, 'failed');
  assert.equal(result.durableResult.cimRequest.followUpState, 'not-scheduled');
  assert.equal(result.durableResult.cimRequest.errorSummary, 'Delivery failed.');
  assert.equal(resendCalls.length, 0, 'final readiness drift must stop before provider work');
  const storedRequest = await storage.getDealHunterCimRequestById(result.durableResult.cimRequest.id);
  assert.equal(storedRequest.next_follow_up_at, null);
  assert.match(storedRequest.delivery_error, /outbound delivery is not fully configured/i);
  const page = await storage.listCrmCommunications({
    submissionId: storedRequest.submission_id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(page.total, 1, 'the exact communication remains durable for authoritative reconciliation');
});

test('manual approval reconciles a provider-accepted communication after final request persistence fails without retransmission', async (t) => {
  const storage = testStorage(t);
  const { preparation } = await preparedManualApproval(storage);
  const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
  const mutateWithCrmActivity = storage.mutateWithCrmActivity.bind(storage);
  let injectFailure = true;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (injectFailure && mutation.activity?.event_type === 'cim.request-sent') {
      injectFailure = false;
      throw new Error('injected manual request/activity finalization failure');
    }
    return mutateWithCrmActivity(mutation);
  };

  const approvalInput = {
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
    storage,
  };
  const first = await approveDealHunterBrokerMaterials(approvalInput);

  assert.equal(first.success, true);
  assertBoundedCimRequest(first.durableResult.cimRequest);
  assert.equal(first.durableResult.cimRequest.requestState, 'provider_accepted');
  assert.equal(first.durableResult.cimRequest.deliveryState, 'accepted');
  assert.equal(first.durableResult.cimRequest.followUpState, 'not-scheduled');
  assert.equal(resendCalls.length, 1);
  const storedRequest = await storage.getDealHunterCimRequestById(first.durableResult.cimRequest.id);
  const beforeReplay = await storage.listCrmCommunications({ submissionId: storedRequest.submission_id, page: 1, pageSize: 25 });
  assert.equal(beforeReplay.total, 1);
  assert.equal(beforeReplay.rows[0].delivery_state, 'accepted');
  assert.equal(beforeReplay.rows[0].body_text, preparation.review.message.body);
  assert.equal(beforeReplay.rows[0].body_html_sanitized, preparation.review.message.html);
  const originalIdempotencyKey = beforeReplay.rows[0].idempotency_key;
  const activity = await storage.listCrmActivityEvents({ submissionId: storedRequest.submission_id, limit: 100 });
  assert.ok(activity.some((event) => event.event_type === 'cim.request-reconciled'));

  const replay = await approveDealHunterBrokerMaterials(approvalInput);
  assert.equal(replay.success, true);
  assertBoundedCimRequest(replay.durableResult.cimRequest);
  assert.equal(replay.durableResult.cimRequest.id, first.durableResult.cimRequest.id);
  assert.equal(replay.durableResult.cimRequest.requestState, 'provider_accepted');
  assert.equal(resendCalls.length, 1, 'recovery and replay must not retransmit');
  const afterReplay = await storage.listCrmCommunications({ submissionId: storedRequest.submission_id, page: 1, pageSize: 25 });
  assert.equal(afterReplay.total, 1);
  assert.equal(afterReplay.rows[0].idempotency_key, originalIdempotencyKey);
  assert.equal(afterReplay.rows[0].body_text, preparation.review.message.body);
  assert.equal(afterReplay.rows[0].body_html_sanitized, preparation.review.message.html);
});

test('manual approval rejects sender display-name or email drift before provider work', async (t) => {
  const { getConfig } = await import('../server/config.js');
  const config = getConfig();
  for (const [name, mutate, restore] of [
    [
      'display name',
      () => { const original = config.workflow.defaultAssignee; config.workflow.defaultAssignee = 'Changed Sender'; return original; },
      (original) => { config.workflow.defaultAssignee = original; },
    ],
    [
      'email',
      () => { const original = config.delivery.resendFromEmail; config.delivery.resendFromEmail = 'changed-sender@example.test'; return original; },
      (original) => { config.delivery.resendFromEmail = original; },
    ],
  ]) {
    await t.test(name, async () => {
      const storage = testStorage(t);
      const { preparation } = await preparedManualApproval(storage);
      const original = mutate();
      try {
        const { approveDealHunterBrokerMaterials } = await import('../server/services/dealHunterBrokerMaterials.js');
        const result = await approveDealHunterBrokerMaterials({
          opportunityId: preparation.review.opportunity.canonicalOpportunityId,
          preparationToken: preparation.preparationToken,
          approvedProposalDigest: preparation.proposalDigest,
          session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
          storage,
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'preparation_stale');
        assert.equal(resendCalls.length, 0);
      } finally {
        restore(original);
      }
    });
  }
});

test('daily summary and Stage 2 shadow evaluation never transmit a broker first contact', async (t) => {
  const storage = testStorage(t);
  const {
    cimStage2DailyLimit,
    reviewDailyDeals,
    runCimStage2Automation,
    sendDailyDealHunterReview,
  } = await import('../server/services/dealHunter.js');
  const previewReview = await reviewDailyDeals({ storage });
  const previewDeal = previewReview.qualified.find((item) => item.cimRequest?.canRequest);
  assert.ok(previewDeal?.cimRequest?.snapshotToken, 'the current review must expose a signed snapshot');

  const summary = await sendDailyDealHunterReview({
    idempotencyKey: 'stage-2-signed-snapshot-regression',
    storage,
  });
  const callsAfterSummary = resendCalls.length;
  const shadow = await runCimStage2Automation({
    mode: 'shadow',
    triggeredBy: 'stage-2-shadow-regression',
    storage,
  });
  const brokerProviderCalls = resendCalls.filter((call) => call.body.subject === previewDeal.cimRequest.preview.subject);
  const requests = await storage.listDealHunterCimRequests({ dealKeys: [previewDeal.dealKey], limit: 100 });
  const runs = await storage.listCimStage2Runs({ mode: 'shadow', limit: 10 });
  const decisions = await storage.listCimStage2Decisions({ runId: shadow.run.id, limit: 100 });

  assert.equal(summary.review.cimAutomation.run.mode, 'internal-summary-preview');
  assert.equal(summary.review.cimAutomation.run.providerCalls, 0);
  assert.equal(summary.review.cimAutomation.run.sent, 0);
  assert.equal(shadow.providerCalls, 0);
  assert.equal(shadow.run.mode, 'shadow');
  assert.equal(shadow.run.attempted, 0);
  assert.equal(cimStage2DailyLimit('shadow', { caps: { canaryDailyInitials: 1, activeDailyInitials: 3 } }), 1);
  assert.equal(resendCalls.length, callsAfterSummary, 'shadow evaluation must not call any provider');
  assert.equal(brokerProviderCalls.length, 0, 'daily summary and shadow evaluation must never send broker copy');
  assert.equal(requests.length, 0, 'shadow evaluation must not create a CIM request sequence');
  assert.equal(runs.length, 1);
  assert.ok(decisions.length > 0, 'every considered canonical opportunity should retain a durable decision');
  assert.equal(previewReview.cimAutomation.effectiveStage, 1, 'configuration alone cannot activate Stage 2');
  assert.equal(previewReview.cimAutomation.activationMode, 'off');
});

test('an automation actor cannot use the direct-send fallback without the private verified snapshot boundary', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'automation-stage-2',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /verified server-signed approval snapshot/i);
  assert.equal(resendCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 0);

  const stage3Result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'automation-stage-3',
    storage,
  });
  assert.equal(stage3Result.ok, false);
  assert.equal(stage3Result.status, 409);
  assert.match(stage3Result.error, /Stage 3 automatic transmission is not implemented/i);
  assert.equal(resendCalls.length, 0);
});

test('an initial provider failure retries the same exact persisted communication and idempotency key', async (t) => {
  const storage = testStorage(t);
  const {
    listDealHunterCimRequestHistory,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  resendMode = 'fail';
  const failed = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'retry-admin',
    storage,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.request.status, 'failed');
  assert.equal(failed.request.request_state, 'ready');
  assert.equal(failed.request.delivery_state, 'failed');
  const retryReadyHistory = await listDealHunterCimRequestHistory({
    requestState: 'ready',
    deliveryState: 'failed',
    storage,
  });
  assert.equal(retryReadyHistory.total, 1);
  assert.equal(retryReadyHistory.counts.ready, 1);

  const firstCommunicationResult = await storage.listCrmCommunications({ submissionId: failed.request.submission_id, page: 1, pageSize: 25 });
  assert.equal(firstCommunicationResult.total, 1);
  const originalCommunication = firstCommunicationResult.rows[0];
  const originalBody = originalCommunication.body_text;
  const originalIdempotencyKey = originalCommunication.idempotency_key;

  resendMode = 'ok';
  const retried = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'retry-admin',
    storage,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.request.delivery_state, 'accepted');
  assert.equal(retried.request.attempt_count, 2);
  assert.equal(resendCalls.length, 2);
  assert.equal(resendCalls[0].idempotencyKey, resendCalls[1].idempotencyKey);
  assert.equal(resendCalls[1].idempotencyKey, originalIdempotencyKey);
  assert.equal(resendCalls[0].body.text, resendCalls[1].body.text);

  const afterRetry = await storage.listCrmCommunications({ submissionId: retried.request.submission_id, page: 1, pageSize: 25 });
  assert.equal(afterRetry.total, 1);
  assert.equal(afterRetry.rows[0].id, originalCommunication.id);
  assert.equal(afterRetry.rows[0].body_text, originalBody);
});

test('an ambiguous Resend transport outcome is durable and cannot be retransmitted', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  resendMode = 'ambiguous';
  const first = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'ambiguity-test-admin',
    storage,
  });
  const communicationPage = await storage.listCrmCommunications({ page: 1, pageSize: 25 });

  assert.equal(first.ok, false);
  assert.equal(first.status, 503);
  assert.equal(first.providerOutcomeAmbiguous, true);
  assert.equal(first.request.status, 'ambiguous');
  assert.equal(first.request.request_state, 'provider_ambiguous');
  assert.equal(first.request.delivery_state, 'ambiguous');
  assert.equal(communicationPage.rows[0].delivery_state, 'ambiguous');
  assert.equal(resendCalls.length, 1);

  resendMode = 'ok';
  const second = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'ambiguity-test-admin',
    storage,
  });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.providerOutcomeAmbiguous, true);
  assert.match(second.error, /reconcile/i);
  assert.equal(resendCalls.length, 1, 'an ambiguous permanent message identity must never be transmitted again automatically');
});

test('an archived linked CRM record blocks a fresh CIM send before claim, communication, or provider work', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const { archiveLead } = await import('../server/services/leadLifecycle.js');
  const { createManualSubmission } = await import('../server/services/submissions.js');
  const deal = await reviewedDeal(storage);
  const created = await createManualSubmission({
    company: deal.name,
    listing_url: deal.listingUrl,
    broker_name: deal.brokerName,
    broker_email: deal.brokerEmail,
    lead_type: 'broker',
    status: 'review',
    notes: 'Archived CIM safety fixture.',
  }, 'archive-admin', { storage });
  assert.equal(created.ok, true);
  const archived = await archiveLead({
    submissionId: created.submission.id,
    reason: 'not-a-fit',
    actor: 'archive-admin',
    storage,
  });
  assert.equal(archived.ok, true);

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'archive-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /archived/i);
  assert.equal(result.deal.cimRequest.status, 'unavailable');
  assert.equal(result.deal.cimRequest.canRequest, false);
  assert.equal(resendCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 0);
});

test('a Deal Hunter dismissal winning after review stops the persisted initial before provider work', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  storage.getDealHunterDisposition = async () => ({
    id: 'late-dismissal',
    deal_key: deal.dealKey,
    disposition: 'dismissed',
  });

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'dismissal-race-admin',
    storage,
  });
  const communications = await storage.listCrmCommunications({ page: 1, pageSize: 25 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /dismissed before provider work/i);
  assert.equal(resendCalls.length, 0);
  assert.equal(communications.total, 1, 'the exact prepared communication remains as durable no-send evidence');
  assert.equal(result.request.status, 'failed');
});

test('an archived linked CRM record blocks corrected-recipient retry before a second communication or provider call', async (t) => {
  const storage = testStorage(t);
  const {
    retryDealHunterCimRequestWithCorrectedRecipient,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const { archiveLead } = await import('../server/services/leadLifecycle.js');
  const { applyEmailLifecycleToCommunication } = await import('../server/services/communications.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'archive-retry-admin',
    storage,
  });
  const [communication] = (await storage.listCrmCommunications({
    submissionId: initial.request.submission_id,
    page: 1,
    pageSize: 25,
  })).rows;
  await applyEmailLifecycleToCommunication({
    provider: 'resend',
    event_type: 'bounced',
    message_id: initial.request.provider_message_id,
    communication_id: communication.id,
    created_at: new Date(Date.now() + 1000).toISOString(),
    metadata: {},
  }, { storage });
  const archived = await archiveLead({
    submissionId: initial.request.submission_id,
    reason: 'not-a-fit',
    actor: 'archive-retry-admin',
    storage,
  });
  assert.equal(archived.ok, true);

  const result = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'alex@example.com',
    requestedBy: 'archive-retry-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /archived/i);
  assert.equal(resendCalls.length, 1);
  const communications = await storage.listCrmCommunications({
    submissionId: initial.request.submission_id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(communications.total, 1);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 1);
});

test('archive winning after an expired claim prevents transmission and stale request finalization', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const claimDealHunterCimRequest = storage.claimDealHunterCimRequest.bind(storage);
  const mutateWithCrmActivity = storage.mutateWithCrmActivity.bind(storage);
  let archiveMutation = null;

  storage.claimDealHunterCimRequest = async (...args) => {
    const claim = await claimDealHunterCimRequest(...args);
    if (!claim.claimed) return claim;
    const linkedSubmission = await storage.getSubmission(claim.request.submission_id);
    const archivedAt = new Date(Date.parse(claim.request.updated_at) + 11 * 60 * 1000).toISOString();
    archiveMutation = await mutateWithCrmActivity({
      operation: 'archive_submission',
      payload: {
        id: linkedSubmission.id,
        expectedUpdatedAt: linkedSubmission.updated_at,
        values: { updated_at: archivedAt, archived_at: archivedAt },
      },
      activity: {
        id: 'expired-claim-archive-activity',
        submission_id: linkedSubmission.id,
        created_at: archivedAt,
        actor: 'archive-race-admin',
        role: 'admin',
        event_type: 'submission.archived',
        summary: 'Archive after the initial CIM transmission claim expired.',
        metadata: {},
      },
    });
    return claim;
  };

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'archive-race-admin',
    storage,
  });

  assert.equal(archiveMutation?.applied, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(resendCalls.length, 0, 'claim renewal must fail before the provider is called');
  const request = await storage.getDealHunterCimRequestById(result.request.id);
  const submission = await storage.getSubmission(request.submission_id);
  assert.equal(submission.status, 'archived');
  assert.equal(request.status, 'pending');
  assert.equal(request.request_state, 'stopped');
  assert.notEqual(request.request_state, 'provider_accepted');
  const activities = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 100 });
  assert.equal(activities.some((event) => event.event_type === 'cim.request-sent'), false);
});

test('an exact late inbound reply is retained and marks an archived CIM request responded without restarting outreach', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const { ingestResendReceivedEmail } = await import('../server/services/communications.js');
  const { archiveLead } = await import('../server/services/leadLifecycle.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'late-reply-admin',
    storage,
  });
  const archived = await archiveLead({
    submissionId: initial.request.submission_id,
    reason: 'unavailable',
    actor: 'late-reply-admin',
    storage,
  });
  assert.equal(archived.ok, true);

  const replyAt = new Date(Date.now() + 1000).toISOString();
  const result = await ingestResendReceivedEmail({
    storage,
    event: {
      id: 'late-archived-reply-event',
      provider: 'resend',
      event_type: 'received',
      message_id: 'late-archived-reply-message',
      provider_event_id: 'late-archived-reply-provider-event',
      event_key: 'late-archived-reply-event-key',
      recipient_email: initial.request.recipient_email,
      subject: 'Re: requested CIM materials',
      created_at: replyAt,
      metadata: {
        resendEmailId: 'late-archived-received-email',
        fromEmail: initial.request.recipient_email,
        to: [initial.request.reply_to_address],
      },
    },
    fetcher: async () => Response.json({
      id: 'late-archived-received-email',
      from: initial.request.recipient_email,
      to: [initial.request.reply_to_address],
      subject: 'Re: requested CIM materials',
      text: 'The requested materials are attached.',
      attachments: [],
      created_at: replyAt,
    }),
  });

  assert.equal(result.ok, true);
  const submission = await storage.getSubmission(initial.request.submission_id);
  const request = await storage.getDealHunterCimRequestById(initial.request.id);
  assert.equal(submission.status, 'archived');
  assert.equal(submission.follow_up_state, 'completed');
  assert.equal(request.status, 'responded');
  assert.equal(request.request_state, 'responded');
  assert.equal(request.follow_up_state, 'stopped');
  assert.equal(request.next_follow_up_at, null);
  const communications = await storage.listCrmCommunications({
    submissionId: submission.id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(communications.total, 2);
  assert.ok(communications.rows.some((communication) => (
    communication.direction === 'inbound'
      && communication.provider_message_id === 'late-archived-received-email'
      && communication.content_state === 'complete'
  )));
  const activities = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 100 });
  assert.ok(activities.some((activity) => activity.event_type === 'communication.created'));
  assert.ok(activities.some((activity) => activity.event_type === 'cim.response-received'));
});

test('an exact inbound reply stops every sequence for the canonical opportunity but not another shared-broker deal', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const { recordEmailEventsFromWebhook } = await import('../server/services/emailEvents.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'canonical-reply-admin',
    storage,
  });
  const primarySubmission = await storage.getSubmission(initial.request.submission_id);
  const duplicateSubmissionId = '00000000-0000-4000-8000-000000000211';
  const unrelatedSubmissionId = '00000000-0000-4000-8000-000000000212';
  await storage.insertSubmission({
    ...primarySubmission,
    id: duplicateSubmissionId,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    deal_hunter_opportunity_id: null,
  });
  await storage.insertSubmission({
    ...primarySubmission,
    id: unrelatedSubmissionId,
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date(Date.now() - 30_000).toISOString(),
    deal_hunter_opportunity_id: null,
    company: 'Unrelated Shared Broker Opportunity',
    listing_url: 'https://broker.example.test/unrelated-shared-broker-opportunity',
  });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await storage.upsertDealHunterCimRequest({
    ...initial.request,
    id: 'canonical-duplicate-sequence',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    submission_id: duplicateSubmissionId,
    deal_key: 'fingerprint:canonical-duplicate-sequence',
    provider_message_id: 'canonical-duplicate-provider-message',
    reply_to_address: 'canonical-duplicate@inbound.example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    follow_up_state: 'scheduled',
    next_follow_up_at: dueAt,
    metadata: {
      ...(initial.request.metadata || {}),
      providerMessageIds: ['canonical-duplicate-provider-message'],
      replyToAddress: 'canonical-duplicate@inbound.example.test',
    },
  });
  await storage.upsertDealHunterCimRequest({
    ...initial.request,
    id: 'unrelated-shared-broker-sequence',
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date(Date.now() - 30_000).toISOString(),
    opportunity_id: null,
    submission_id: unrelatedSubmissionId,
    deal_key: 'unrelated-shared-broker-opportunity',
    deal_name: 'Unrelated Shared Broker Opportunity',
    listing_url: 'https://broker.example.test/unrelated-shared-broker-opportunity',
    provider_message_id: 'unrelated-shared-broker-provider-message',
    reply_to_address: 'unrelated-shared-broker@inbound.example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    follow_up_state: 'scheduled',
    next_follow_up_at: dueAt,
    metadata: {
      ...(initial.request.metadata || {}),
      providerMessageIds: ['unrelated-shared-broker-provider-message'],
      replyToAddress: 'unrelated-shared-broker@inbound.example.test',
    },
  });

  const replyAt = new Date(Date.now() + 1000).toISOString();
  const payload = {
    id: 'canonical-exact-reply-provider-event',
    type: 'email.received',
    created_at: replyAt,
    data: {
      email_id: 'canonical-exact-reply-email',
      message_id: '<canonical-exact-reply-email@resend.example>',
      from: initial.request.recipient_email,
      to: [initial.request.reply_to_address],
      subject: `Re: CIM / NDA request for ${initial.request.deal_name}`,
    },
  };
  const result = await recordEmailEventsFromWebhook({
    body: payload,
    rawBody: JSON.stringify(payload),
    headers: { 'x-webhook-secret': 'cim-lifecycle-webhook-secret' },
  }, {
    storage,
    fetcher: async () => Response.json({
      id: 'canonical-exact-reply-email',
      from: initial.request.recipient_email,
      to: [initial.request.reply_to_address],
      subject: payload.data.subject,
      text: 'Yes, I will send the CIM.',
      attachments: [],
      created_at: replyAt,
    }),
  });

  assert.equal(result.ok, true);
  const primaryAfter = await storage.getDealHunterCimRequestById(initial.request.id);
  const duplicateAfter = await storage.getDealHunterCimRequestById('canonical-duplicate-sequence');
  const unrelatedAfter = await storage.getDealHunterCimRequestById('unrelated-shared-broker-sequence');
  for (const request of [primaryAfter, duplicateAfter]) {
    assert.equal(request.request_state, 'responded');
    assert.equal(request.follow_up_state, 'stopped');
    assert.equal(request.next_follow_up_at, null);
    assert.equal(request.metadata.canonicalReplyOpportunityId, initial.request.opportunity_id);
  }
  assert.equal(unrelatedAfter.request_state, 'provider_accepted');
  assert.equal(unrelatedAfter.follow_up_state, 'scheduled');
  assert.equal(unrelatedAfter.next_follow_up_at, dueAt);
  const duplicateActivity = await storage.listCrmActivityEvents({ submissionId: duplicateSubmissionId, limit: 100 });
  assert.ok(duplicateActivity.some((event) => event.event_type === 'cim.canonical-reply-stopped'));
});

test('provider-accepted communication is reconciled after request activity persistence fails without retransmission', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const mutateWithCrmActivity = storage.mutateWithCrmActivity.bind(storage);
  let injectFailure = true;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (injectFailure && mutation.activity?.event_type === 'cim.request-sent') {
      injectFailure = false;
      throw new Error('injected request/activity persistence failure');
    }
    return mutateWithCrmActivity(mutation);
  };

  await assert.rejects(
    sendDealHunterCimRequest({
      dealKey: deal.dealKey,
      snapshotToken: deal.cimRequest.snapshotToken,
      requestedBy: 'reconcile-admin',
      storage,
    }),
    /accepted by the provider/i,
  );
  assert.equal(resendCalls.length, 1);
  const beforeRecovery = await storage.listCrmCommunications({ page: 1, pageSize: 25 });
  assert.equal(beforeRecovery.total, 1);
  assert.equal(beforeRecovery.rows[0].delivery_state, 'accepted');
  assert.equal(beforeRecovery.rows[0].provider_message_id, 'resend-message-1');
  const exactBody = beforeRecovery.rows[0].body_text;
  const exactIdempotencyKey = beforeRecovery.rows[0].idempotency_key;

  const recovered = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'reconcile-admin',
    storage,
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.alreadySent, true);
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.request.request_state, 'provider_accepted');
  assert.equal(recovered.request.delivery_state, 'accepted');
  assert.equal(recovered.request.provider_message_id, 'resend-message-1');
  assert.equal(resendCalls.length, 1);
  const afterRecovery = await storage.listCrmCommunications({ page: 1, pageSize: 25 });
  assert.equal(afterRecovery.total, 1);
  assert.equal(afterRecovery.rows[0].body_text, exactBody);
  assert.equal(afterRecovery.rows[0].idempotency_key, exactIdempotencyKey);
  const activity = await storage.listCrmActivityEvents({
    submissionId: recovered.request.submission_id,
    limit: 100,
  });
  assert.ok(activity.some((event) => event.event_type === 'cim.request-reconciled'));
});

test('legacy EmailJS acceptance with a blank provider ID reconciles after finalization failure without retransmission', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  resendMode = 'fail';
  const failed = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'legacy-emailjs-reconcile-admin',
    storage,
  });
  const [failedCommunication] = (await storage.listCrmCommunications({
    submissionId: failed.request.submission_id,
    page: 1,
    pageSize: 25,
  })).rows;
  const acceptedAt = new Date().toISOString();

  await storage.updateCrmCommunication(failedCommunication.id, {
    provider: 'emailjs',
    provider_message_id: null,
    delivery_state: 'accepted',
    delivery_state_at: acceptedAt,
    updated_at: acceptedAt,
  });
  await storage.upsertDealHunterCimRequest({
    ...failed.request,
    status: 'pending',
    request_state: 'pending',
    delivery_state: 'not-attempted',
    delivery_error: '',
    provider_message_id: null,
    updated_at: acceptedAt,
    last_activity_at: acceptedAt,
  });
  resendCalls = [];

  const recovered = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'legacy-emailjs-reconcile-admin',
    storage,
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.alreadySent, true);
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.request.request_state, 'provider_accepted');
  assert.equal(recovered.request.delivery_state, 'accepted');
  assert.equal(recovered.request.provider_message_id || '', '');
  assert.equal(resendCalls.length, 0, 'durable EmailJS acceptance proof must prevent a second provider call');
  const communication = await storage.getCrmCommunication(failedCommunication.id);
  assert.equal(communication.provider, 'emailjs');
  assert.equal(communication.delivery_state, 'accepted');
});

test('provider acceptance remains successful when the communication delivery-state write fails and retry does not resend', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const updateCrmCommunication = storage.updateCrmCommunication.bind(storage);
  let injectFailure = true;
  storage.updateCrmCommunication = async (id, values) => {
    if (injectFailure && values.delivery_state === 'accepted') {
      injectFailure = false;
      throw new Error('injected communication delivery-state failure');
    }
    return updateCrmCommunication(id, values);
  };

  const accepted = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'communication-fault-admin',
    storage,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.request.request_state, 'provider_accepted');
  assert.match(accepted.warning, /awaits reconciliation/i);
  assert.equal(resendCalls.length, 1);

  const retried = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'communication-fault-admin',
    storage,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.alreadySent, true);
  assert.equal(resendCalls.length, 1);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 1);
});

test('follow_up_failed request state cannot enter corrected-recipient retry even with failed delivery state', async () => {
  const { retryDealHunterCimRequestWithCorrectedRecipient } = await import('../server/services/dealHunter.js');
  let listedRequests = false;
  const result = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: 'follow-up-failed-request',
    newRecipientEmail: 'alex@example.com',
    requestedBy: 'strict-gate-admin',
    storage: {
      async getDealHunterCimRequestById() {
        return {
          id: 'follow-up-failed-request',
          deal_key: 'strict-gate-deal',
          recipient_email: 'erin@example.com',
          status: 'follow_up_failed',
          request_state: 'provider_accepted',
          delivery_state: 'failed',
          metadata: { brokerContacts: [{ name: 'Alex Contact', email: 'alex@example.com' }] },
        };
      },
      async listDealHunterCimRequests() {
        listedRequests = true;
        return [];
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /only available after a bounced or delivery-issue event/i);
  assert.equal(listedRequests, false);
});

test('a bounced request requires a different corrected recipient and audits snapshot or override evidence', async (t) => {
  const storage = testStorage(t);
  const {
    retryDealHunterCimRequestWithCorrectedRecipient,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const { applyEmailLifecycleToCommunication } = await import('../server/services/communications.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'bounce-admin',
    storage,
  });
  const [communication] = (await storage.listCrmCommunications({ submissionId: initial.request.submission_id, page: 1, pageSize: 25 })).rows;
  await applyEmailLifecycleToCommunication({
    provider: 'resend',
    event_type: 'bounced',
    message_id: initial.request.provider_message_id,
    communication_id: communication.id,
    created_at: new Date(Date.now() + 1000).toISOString(),
    metadata: {},
  }, { storage });

  const sameRecipient = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'erin@example.com',
    requestedBy: 'bounce-admin',
    storage,
  });
  assert.equal(sameRecipient.ok, false);
  assert.match(sameRecipient.error, /must be different/i);

  const unauditedOverride = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'corrected@example.com',
    requestedBy: 'bounce-admin',
    storage,
  });
  assert.equal(unauditedOverride.ok, false);
  assert.match(unauditedOverride.error, /confirmation and an override reason/i);

  const corrected = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'alex@example.com',
    requestedBy: 'bounce-admin',
    storage,
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.request.retry_of_request_id, initial.request.id);
  assert.equal(corrected.request.recipient_email, 'alex@example.com');
  assert.equal(corrected.request.metadata.correctedRecipient.selectedFromSignedSnapshot, true);

  const duplicateCorrected = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'another@example.com',
    confirmed: true,
    overrideReason: 'Broker supplied a replacement address by phone.',
    requestedBy: 'bounce-admin',
    storage,
  });
  assert.equal(duplicateCorrected.ok, false);
  assert.match(duplicateCorrected.error, /another accepted CIM request/i);

  const activity = await storage.listCrmActivityEvents({ submissionId: initial.request.submission_id, limit: 100 });
  const retryAudit = activity.find((event) => event.event_type === 'cim.corrected-recipient-retry');
  assert.ok(retryAudit);
  assert.equal(retryAudit.metadata.correctedRecipientEmail, 'alex@example.com');
  assert.equal(retryAudit.metadata.selectedFromSignedSnapshot, true);
});

test('a manually entered corrected recipient requires and retains confirmed override evidence', async (t) => {
  const storage = testStorage(t);
  const {
    retryDealHunterCimRequestWithCorrectedRecipient,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const { applyEmailLifecycleToCommunication } = await import('../server/services/communications.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'override-admin',
    storage,
  });
  const [communication] = (await storage.listCrmCommunications({ submissionId: initial.request.submission_id, page: 1, pageSize: 25 })).rows;
  await applyEmailLifecycleToCommunication({
    provider: 'resend',
    event_type: 'bounced',
    message_id: initial.request.provider_message_id,
    communication_id: communication.id,
    created_at: new Date(Date.now() + 1000).toISOString(),
    metadata: {},
  }, { storage });

  const reason = 'Broker supplied the corrected address during a verified phone call.';
  const corrected = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: initial.request.id,
    newRecipientEmail: 'verified-correction@example.com',
    confirmed: true,
    overrideReason: reason,
    requestedBy: 'override-admin',
    storage,
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.request.metadata.correctedRecipient.confirmed, true);
  assert.equal(corrected.request.metadata.correctedRecipient.selectedFromSignedSnapshot, false);
  assert.equal(corrected.request.metadata.correctedRecipient.overrideReason, reason);

  const activity = await storage.listCrmActivityEvents({ submissionId: initial.request.submission_id, limit: 100 });
  const audit = activity.find((event) => event.event_type === 'cim.corrected-recipient-retry');
  assert.ok(audit);
  assert.equal(audit.metadata.overrideReason, reason);
});

test('follow-up processing does not assign a subject-only reply across a shared broker address', async (t) => {
  const storage = testStorage(t);
  const {
    runDealHunterCimFollowUps,
    sendDealHunterCimRequest,
  } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'shared-broker-admin',
    storage,
  });
  const firstSubmission = await storage.getSubmission(initial.request.submission_id);
  const secondSubmissionId = '00000000-0000-4000-8000-000000000202';
  await storage.insertSubmission({
    ...firstSubmission,
    id: secondSubmissionId,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    company: 'Second Commercial Safety Services',
    listing_url: 'https://broker.example.test/listing-shared-broker-2',
    deal_hunter_opportunity_id: null,
    metadata: {
      ...(firstSubmission.metadata || {}),
      dealHunter: {
        ...(firstSubmission.metadata?.dealHunter || {}),
        dealKey: 'shared-broker-second-deal',
      },
    },
  });

  const dueAt = new Date(Date.now() - 1000).toISOString();
  await storage.upsertDealHunterCimRequest({
    ...initial.request,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'sent',
    follow_up_state: 'scheduled',
    next_follow_up_at: dueAt,
  });
  await storage.upsertDealHunterCimRequest({
    ...initial.request,
    id: 'shared-broker-second-request',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    deal_key: 'shared-broker-second-deal',
    deal_name: 'Second Commercial Safety Services',
    listing_url: 'https://broker.example.test/listing-shared-broker-2',
    submission_id: secondSubmissionId,
    provider_message_id: 'shared-broker-second-provider-message',
    reply_to_address: 'shared-broker-second-request@inbound.example.test',
    status: 'sent',
    follow_up_count: 0,
    follow_up_state: 'scheduled',
    next_follow_up_at: dueAt,
    metadata: {
      ...(initial.request.metadata || {}),
      providerMessageIds: ['shared-broker-second-provider-message'],
      replyToAddress: 'shared-broker-second-request@inbound.example.test',
    },
  });
  await storage.insertEmailEvent({
    id: 'shared-broker-subject-only-reply',
    created_at: new Date().toISOString(),
    provider: 'resend',
    event_type: 'received',
    message_id: 'shared-broker-unmatched-inbound-message',
    provider_event_id: 'shared-broker-unmatched-inbound-event',
    event_key: 'shared-broker-unmatched-inbound-event-key',
    recipient_email: initial.request.recipient_email,
    subject: `Re: CIM / NDA request for ${initial.request.deal_name}`,
    submission_id: null,
    communication_id: null,
    source: 'resend-webhook',
    metadata: {
      fromEmail: initial.request.recipient_email,
      toEmail: 'general-inbox@example.test',
    },
  });
  resendCalls = [];

  const result = await runDealHunterCimFollowUps({
    storage,
    now: new Date(),
    settings: {
      enabled: true,
      firstDelayHours: 1,
      intervalHours: 1,
      delaySequenceHours: [1],
      maxCount: 3,
      weekdaysOnly: false,
      timezone: 'America/Los_Angeles',
      sendWindowStart: '00:00',
      sendWindowEnd: '23:59',
    },
  });

  assert.equal(result.reviewed, 2);
  assert.equal(result.responded, 0);
  assert.equal(result.sent, 2);
  assert.equal(resendCalls.length, 2);
  const firstAfter = await storage.getDealHunterCimRequestById(initial.request.id);
  const secondAfter = await storage.getDealHunterCimRequestById('shared-broker-second-request');
  assert.notEqual(firstAfter.request_state, 'responded');
  assert.notEqual(secondAfter.request_state, 'responded');
});

test('CIM history preserves hyphenated delivery filters and maps display aliases to stored states', async () => {
  const { listDealHunterCimRequestHistory } = await import('../server/services/dealHunter.js');
  let captured = null;
  const storage = {
    async listDealHunterCimRequestHistory(options) {
      captured = options;
      return { rows: [], total: 0, page: 1, pageSize: 25, counts: {} };
    },
  };

  await listDealHunterCimRequestHistory({
    requestState: 'provider-accepted',
    deliveryState: 'development-only,awaiting-delivery',
    followUpState: 'not_scheduled',
    storage,
  });

  assert.deepEqual(captured.requestStates, ['provider_accepted']);
  assert.deepEqual(captured.deliveryStates, ['development-only', 'accepted']);
  assert.equal(captured.followUpState, 'not-scheduled');
});

test('manual executor persists exact communication before provider call and performs final terminal revalidation', async (t) => {
  const dependencies = {
    async getPause() { return { paused: false }; },
    async getReadiness() { return { outboundConfigured: true, issues: [] }; },
    async evaluateRecipientPolicy() { return { allowed: true, reason: '', override: null }; },
    evaluateWindow() { return { allowed: true, reason: '' }; },
  };
  const makeDuePreparation = async (storage) => {
    const { preparation } = await preparedManualApproval(storage);
    const initial = await approvePreparedManual({ storage, preparation });
    assert.equal(initial.success, true, initial.error);
    let request = await storage.getDealHunterCimRequestById(initial.durableResult.cimRequest.id);
    const service = await import('../server/services/dealHunterManualFollowUps.js');
    const enrolled = await service.startDealHunterManualFollowUps({
      opportunityId: request.opportunity_id,
      requestId: request.id,
      input: {},
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(enrolled.success, true, enrolled.error);
    request = await storage.getDealHunterCimRequestById(request.id);
    request = await storage.upsertDealHunterCimRequest({
      ...request,
      next_follow_up_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 30_000).toISOString(),
    });
    const followUpPreparation = await service.prepareDealHunterManualFollowUp({
      opportunityId: request.opportunity_id,
      requestId: request.id,
      greeting: 'Hello Erin,',
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(followUpPreparation.success, true, followUpPreparation.error);
    return { service, request, preparation: followUpPreparation };
  };

  await t.test('exact bytes are durable before the provider boundary', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const providerCallsBefore = resendCalls.length;
    expectedManualProviderInvariant = {
      communicationId: fixture.preparation.review.communication.id,
      providerIdempotencyKey: fixture.preparation.review.communication.providerIdempotencyKey,
      recipient: fixture.preparation.review.recipient.email,
      senderDisplayName: fixture.preparation.review.sender.displayName,
      senderEmail: fixture.preparation.review.sender.email,
      senderFrom: fixture.preparation.review.sender.from,
      subject: fixture.preparation.review.message.subject,
      text: fixture.preparation.review.message.body,
      html: fixture.preparation.review.message.html,
    };
    const approved = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(approved.success, true, approved.error);
    assert.equal(Object.hasOwn(approved, 'emailResult'), false);
    assert.equal(Object.hasOwn(approved, 'providerOutcomeAmbiguous'), false);
    const communications = await storage.listCrmCommunications({ cimRequestId: fixture.request.id, page: 1, pageSize: 25 });
    const followUp = communications.rows.find((item) => item.kind === 'deal-hunter-cim-follow-up');
    assert.ok(followUp);
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    assert.equal(resendCalls.at(-1).body.from, `${fixture.preparation.review.sender.displayName} <${fixture.preparation.review.sender.email}>`);
    assert.equal(resendCalls.at(-1).body.reply_to, fixture.preparation.review.sender.replyTo);
    assert.equal(followUp.from_address, fixture.preparation.review.sender.email);
    assert.equal(followUp.metadata?.manualApproval?.senderFrom, fixture.preparation.review.sender.from);
    assert.equal(followUp.subject, fixture.preparation.review.message.subject);
    assert.equal(followUp.body_text, fixture.preparation.review.message.body);
    assert.equal(followUp.body_html_sanitized, fixture.preparation.review.message.html);
    assert.equal(followUp.idempotency_key, fixture.preparation.review.communication.providerIdempotencyKey);
    assert.equal(followUp.delivery_state, 'accepted');
    const current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    assert.equal(current.follow_up_state, 'scheduled');
  });

  await t.test('Stop during an in-flight provider call returns Checking while preserving the permanent stop and later accepted reconciliation', async (subtest) => {
    // Break caught: Stop can report that the current touch was stopped even
    // after provider authorization has begun and the outcome is unknowable.
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const providerCallsBefore = resendCalls.length;
    const entered = new Promise((resolve) => { heldProviderEntered = resolve; });
    resendMode = 'hold';
    const approval = fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    await entered;
    const inFlight = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(inFlight.status, 'follow_up_pending');

    const stopped = await fixture.service.stopDealHunterManualFollowUps({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      reason: 'Stop future follow-ups while current provider outcome resolves.',
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    releaseHeldProvider();
    resendMode = 'ok';
    const accepted = await approval;
    assert.equal(stopped.code, 'outcome_unresolved');
    assert.equal(stopped.followUps.state, 'stopped');
    assert.equal(accepted.success, true, accepted.error);
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    const current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    assert.equal(current.follow_up_state, 'stopped');
    assert.equal(current.next_follow_up_at, null);
    assert.equal(current.metadata.manualFollowUp.acceptedTouches.length, 1);
  });

  await t.test('accepted reconciliation preserves the original provider acceptance timestamp across delivered delayed bounced complained and suppressed transitions', async (subtest) => {
    // Break caught: a later webhook state can erase accepted proof or replace
    // the cadence anchor with that later event timestamp.
    const { applyEmailLifecycleToCommunication } = await import('../server/services/communications.js');
    const { reconcileDealHunterApprovedFollowUp } = await import('../server/services/dealHunter.js');
    for (const deliveryState of ['delivered', 'delayed', 'bounced', 'complained', 'suppressed']) {
      await subtest.test(deliveryState, async (stateTest) => {
        const storage = testStorage(stateTest);
        const fixture = await makeDuePreparation(storage);
        const finalize = storage.finalizeDealHunterApprovedFollowUp.bind(storage);
        let rejectFinalization = true;
        storage.finalizeDealHunterApprovedFollowUp = async (input) => {
          if (rejectFinalization) {
            rejectFinalization = false;
            return { applied: false, reason: 'simulated-finalization-failure', request: await storage.getDealHunterCimRequestById(input.requestId) };
          }
          return finalize(input);
        };
        const providerCallsBefore = resendCalls.length;
        await assert.rejects(
          fixture.service.approveDealHunterManualFollowUp({
            opportunityId: fixture.request.opportunity_id,
            requestId: fixture.request.id,
            preparationToken: fixture.preparation.preparationToken,
            approvedProposalDigest: fixture.preparation.proposalDigest,
            session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
            storage,
            now: new Date(),
            dependencies,
          }),
          /accepted by the provider/i,
        );
        const communicationId = fixture.preparation.review.communication.id;
        const acceptedCommunication = await storage.getCrmCommunication(communicationId);
        const originalAcceptedAt = acceptedCommunication.metadata?.manualFollowUp?.firstProviderAcceptedAt;
        assert.ok(originalAcceptedAt, 'the original provider-acceptance instant must be durable before lifecycle transitions');
        const laterAt = new Date(Date.parse(originalAcceptedAt) + 60_000).toISOString();
        await applyEmailLifecycleToCommunication({
          id: `manual-${deliveryState}-event`,
          provider: 'resend',
          event_type: deliveryState,
          message_id: acceptedCommunication.provider_message_id,
          communication_id: communicationId,
          created_at: laterAt,
          metadata: {},
        }, { storage });

        const beforeReconciliation = await storage.getDealHunterCimRequestById(fixture.request.id);
        const reconciled = await reconcileDealHunterApprovedFollowUp({
          storage,
          request: beforeReconciliation,
          actor: 'manual-reconciliation-test',
        });
        assert.equal(reconciled.status, 'sent', reconciled.reason);
        assert.equal(resendCalls.length, providerCallsBefore + 1);
        const current = await storage.getDealHunterCimRequestById(fixture.request.id);
        assert.equal(current.follow_up_count, 1);
        assert.equal(current.last_follow_up_at, originalAcceptedAt);
        assert.equal(current.metadata.manualFollowUp.acceptedTouches[0].acceptedAt, originalAcceptedAt);
        if (['bounced', 'complained', 'suppressed'].includes(deliveryState)) {
          assert.equal(current.follow_up_state, 'stopped');
          assert.equal(current.next_follow_up_at, null);
        } else {
          assert.equal(current.follow_up_state, 'scheduled');
          assert.notEqual(current.next_follow_up_at, laterAt);
        }
      });
    }
  });

  await t.test('development-only logging does not count or report provider acceptance and leaves the touch safely reviewable', async (subtest) => {
    // Break caught: the console provider's logged result is finalized as if a
    // real provider accepted the private broker message.
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const { getConfig } = await import('../server/config.js');
    const config = getConfig();
    const priorProvider = config.delivery.provider;
    const originalConsoleLog = console.log;
    let developmentProviderCalls = 0;
    config.delivery.provider = 'console';
    console.log = (...args) => {
      if (String(args[0] || '').startsWith('[mail:deal-hunter-cim-follow-up]')) developmentProviderCalls += 1;
    };
    try {
      const result = await fixture.service.approveDealHunterManualFollowUp({
        opportunityId: fixture.request.opportunity_id,
        requestId: fixture.request.id,
        preparationToken: fixture.preparation.preparationToken,
        approvedProposalDigest: fixture.preparation.proposalDigest,
        session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
        storage,
        now: new Date(),
        dependencies,
      });
      assert.equal(result.code, 'development_only');
      assert.equal(developmentProviderCalls, 1);
      const communication = await storage.getCrmCommunication(fixture.preparation.review.communication.id);
      assert.equal(communication.delivery_state, 'development-only');
      const current = await storage.getDealHunterCimRequestById(fixture.request.id);
      assert.equal(current.follow_up_count, 0);
      assert.equal(current.metadata.manualFollowUp.acceptedTouches, undefined);
      assert.equal(current.next_follow_up_at, fixture.request.next_follow_up_at);
      assert.notEqual(current.status, 'follow_up_pending');
      assert.equal(await storage.getDealHunterCimRecipientClaim(current.recipient_email), null);
    } finally {
      config.delivery.provider = priorProvider;
      console.log = originalConsoleLog;
    }
  });

  await t.test('definitive failure preserves the logical touch for an exact newly approved retry', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const providerCallsBefore = resendCalls.length;
    resendMode = 'fail';
    const failed = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(failed.success, false);
    assert.equal(failed.code, 'provider_failed');
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    const firstAttempt = resendCalls.at(-1);
    let current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 0);
    assert.equal(current.follow_up_state, 'failed');
    assert.equal(current.next_follow_up_at, fixture.request.next_follow_up_at);

    const retry = await fixture.service.prepareDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      input: {},
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(retry.success, true, retry.error);
    assert.equal(retry.review.mode, 'exact-retry');
    assert.equal(retry.review.message.greetingEditable, false);
    assert.equal(retry.review.message.subject, fixture.preparation.review.message.subject);
    assert.equal(retry.review.message.body, fixture.preparation.review.message.body);
    assert.equal(retry.review.message.html, fixture.preparation.review.message.html);
    assert.equal(retry.review.communication.id, fixture.preparation.review.communication.id);
    assert.equal(retry.review.communication.providerIdempotencyKey, fixture.preparation.review.communication.providerIdempotencyKey);

    resendMode = 'ok';
    const accepted = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: retry.preparationToken,
      approvedProposalDigest: retry.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(accepted.success, true, accepted.error);
    assert.equal(resendCalls.length, providerCallsBefore + 2);
    assert.equal(resendCalls.at(-1).idempotencyKey, firstAttempt.idempotencyKey);
    assert.deepEqual(resendCalls.at(-1).body, firstAttempt.body);
    const communications = await storage.listCrmCommunications({ cimRequestId: fixture.request.id, page: 1, pageSize: 25 });
    assert.equal(communications.rows.filter((item) => item.kind === 'deal-hunter-cim-follow-up').length, 1);
    current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    assert.equal(current.follow_up_state, 'scheduled');
  });

  await t.test('ambiguous outcome blocks retransmission and later accepted proof reconciles once', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const providerCallsBefore = resendCalls.length;
    resendMode = 'ambiguous';
    const ambiguous = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(ambiguous.success, false);
    assert.equal(ambiguous.code, 'outcome_unresolved');
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    let current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 0);
    assert.equal(current.follow_up_state, 'ambiguous');
    assert.equal(current.next_follow_up_at, null);
    const outbox = await storage.listCrmEmailOutbox({ submissionId: current.submission_id, states: ['ambiguous'], limit: 10 });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].communication_id, fixture.preparation.review.communication.id);
    const mismatchedProof = await storage.recordDealHunterManualFollowUpAmbiguity({
      requestId: 'wrong-request',
      submissionId: current.submission_id,
      communicationId: fixture.preparation.review.communication.id,
      idempotencyKey: fixture.preparation.review.communication.providerIdempotencyKey,
      actor: 'manual-approval-admin',
      ambiguousAt: new Date().toISOString(),
    });
    assert.equal(mismatchedProof, null);

    const retry = await fixture.service.prepareDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      input: {},
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(retry.success, false);
    assert.equal(retry.code, 'outcome_unresolved');
    const replayBeforeProof = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(replayBeforeProof.success, false);
    assert.equal(replayBeforeProof.code, 'outcome_unresolved');
    assert.equal(resendCalls.length, providerCallsBefore + 1);

    const communication = await storage.getCrmCommunication(fixture.preparation.review.communication.id);
    const reconciledAt = new Date().toISOString();
    await storage.updateCrmCommunication(communication.id, {
      provider_message_id: `reconciled-provider-${providerCallsBefore}`,
      delivery_state: 'accepted',
      delivery_state_at: reconciledAt,
      updated_at: reconciledAt,
      updated_by: 'reconciliation-test',
    });
    const reconciled = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(reconciled.success, true, reconciled.error);
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    assert.equal(current.follow_up_state, 'scheduled');
  });

  await t.test('accepted communication proof repairs failed finalization without a second provider call', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const finalize = storage.finalizeDealHunterApprovedFollowUp.bind(storage);
    let finalizationCalls = 0;
    storage.finalizeDealHunterApprovedFollowUp = async (input) => {
      finalizationCalls += 1;
      if (finalizationCalls === 1) return { applied: false, reason: 'simulated-finalization-failure', request: await storage.getDealHunterCimRequestById(input.requestId) };
      return finalize(input);
    };
    const providerCallsBefore = resendCalls.length;
    await assert.rejects(
      fixture.service.approveDealHunterManualFollowUp({
        opportunityId: fixture.request.opportunity_id,
        requestId: fixture.request.id,
        preparationToken: fixture.preparation.preparationToken,
        approvedProposalDigest: fixture.preparation.proposalDigest,
        session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
        storage,
        now: new Date(),
        dependencies,
      }),
      /accepted by the provider/i,
    );
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    let current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 0);
    assert.equal(current.status, 'follow_up_pending');
    const { getTriageOpportunityDetail } = await import('../server/services/dealHunterTriage.js');
    const detail = await getTriageOpportunityDetail({
      opportunityId: fixture.request.opportunity_id,
      storage,
      reconcileAcceptedManualFollowUps: true,
      actor: 'manual-approval-admin',
    });
    assert.equal(detail.ok, true, detail.error);
    assert.equal(detail.brokerMaterials.existingRequest.followUps.followUpCount, 1);
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    const reconciled = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(reconciled.success, true, reconciled.error);
    assert.equal(resendCalls.length, providerCallsBefore + 1);
    current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    assert.equal(current.follow_up_state, 'scheduled');
    const activities = await storage.listCrmActivityEvents({ submissionId: current.submission_id, limit: 500 });
    assert.equal(activities.filter((event) => event.event_type === 'cim.manual-follow-up-accepted').length, 1);
    assert.ok(finalizationCalls >= 2);
  });

  await t.test('concurrent administrator approvals converge through the real claim and executor', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const secondPrincipal = { principal_id: 'manual-principal-2', role: 'admin', username: 'manual-approval-admin-2' };
    const secondPreparation = await fixture.service.prepareDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      input: { greeting: 'Hello Erin,' },
      session: secondPrincipal,
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(secondPreparation.success, true, secondPreparation.error);
    const providerCallsBefore = resendCalls.length;
    const [first, second] = await Promise.all([
      fixture.service.approveDealHunterManualFollowUp({
        opportunityId: fixture.request.opportunity_id,
        requestId: fixture.request.id,
        preparationToken: fixture.preparation.preparationToken,
        approvedProposalDigest: fixture.preparation.proposalDigest,
        session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
        storage,
        now: new Date(),
        dependencies,
      }),
      fixture.service.approveDealHunterManualFollowUp({
        opportunityId: fixture.request.opportunity_id,
        requestId: fixture.request.id,
        preparationToken: secondPreparation.preparationToken,
        approvedProposalDigest: secondPreparation.proposalDigest,
        session: secondPrincipal,
        storage,
        now: new Date(),
        dependencies,
      }),
    ]);
    assert.equal(resendCalls.length, providerCallsBefore + 1, JSON.stringify([first, second]));
    const communications = await storage.listCrmCommunications({ cimRequestId: fixture.request.id, page: 1, pageSize: 25 });
    assert.equal(communications.rows.filter((item) => item.kind === 'deal-hunter-cim-follow-up').length, 1);
    const current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 1);
    const activities = await storage.listCrmActivityEvents({ submissionId: current.submission_id, limit: 500 });
    assert.equal(activities.filter((event) => event.event_type === 'cim.manual-follow-up-accepted').length, 1);
  });

  await t.test('materials arriving after communication persistence stop final provider authorization', async (subtest) => {
    const storage = testStorage(subtest);
    const fixture = await makeDuePreparation(storage);
    const listSecureDocumentsForSubmission = storage.listSecureDocumentsForSubmission.bind(storage);
    let insertedLateCim = false;
    storage.listSecureDocumentsForSubmission = async (submissionId) => {
      const communication = await storage.getCrmCommunication(fixture.preparation.review.communication.id);
      if (communication && !insertedLateCim) {
        insertedLateCim = true;
        const arrivedAt = new Date().toISOString();
        await storage.insertSecureDocument({
          id: 'late-cim-after-follow-up-communication',
          request_id: fixture.request.id,
          submission_id: submissionId,
          created_at: arrivedAt,
          document_type: 'cim',
          file_name: 'late-cim.pdf',
          original_name: 'CIM.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1,
          storage_path: '/test/late-cim.pdf',
          uploaded_by_email: 'broker@example.test',
          note: 'Arrived during final manual follow-up authorization.',
          nda_accepted_at: null,
        });
      }
      return listSecureDocumentsForSubmission(submissionId);
    };
    const providerCallsBefore = resendCalls.length;
    const approved = await fixture.service.approveDealHunterManualFollowUp({
      opportunityId: fixture.request.opportunity_id,
      requestId: fixture.request.id,
      preparationToken: fixture.preparation.preparationToken,
      approvedProposalDigest: fixture.preparation.proposalDigest,
      session: { principal_id: 'manual-principal-1', role: 'admin', username: 'manual-approval-admin' },
      storage,
      now: new Date(),
      dependencies,
    });
    assert.equal(approved.success, false);
    assert.equal(approved.code, 'blocked');
    assert.equal(resendCalls.length, providerCallsBefore);
    const communications = await storage.listCrmCommunications({ cimRequestId: fixture.request.id, page: 1, pageSize: 25 });
    assert.equal(communications.rows.filter((item) => item.kind === 'deal-hunter-cim-follow-up').length, 1);
    assert.equal(insertedLateCim, true);
    assert.ok(await storage.getSecureDocument('late-cim-after-follow-up-communication'));
    const current = await storage.getDealHunterCimRequestById(fixture.request.id);
    assert.equal(current.follow_up_count, 0);
    assert.equal(current.follow_up_state, 'stopped');
    assert.equal(current.next_follow_up_at, null);
  });
});
