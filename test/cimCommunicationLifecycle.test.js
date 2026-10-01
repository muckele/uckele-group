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
  assert.equal(output.result.errorCategory, 'cim-provider-hard-off');
  assert.equal(output.cimProviderCalls, 0);
  assert.equal(output.ordinaryResult.status, 'sent');
  assert.equal(output.providerCalls, 1, 'ordinary EmailJS application mail should remain available');
});

test('direct/admin CIM initial persists durable no-send evidence and makes zero provider calls', async (t) => {
  const storage = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'default-deny-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.request.status, 'failed');
  assert.equal(result.request.provider_message_id || '', '');
  assert.equal(resendCalls.length, 0);
  const communications = await storage.listCrmCommunications({
    submissionId: result.request.submission_id,
    page: 1,
    pageSize: 25,
  });
  assert.equal(communications.total, 1);
  assert.equal(communications.rows[0].kind, 'deal-hunter-cim-request');
  assert.equal(communications.rows[0].provider_message_id, null);
});

test('legacy CIM provider/retry surfaces remain explicit no-send paths after P6C', async (t) => {
  const { sendPreparedMessage } = await import('../server/services/delivery.js');
  for (const kind of ['deal-hunter-cim-request', 'deal-hunter-cim-follow-up',
    'cim-initial', 'cim-follow-up', 'cim-batch']) {
    await t.test(kind, async () => {
      let providerCalls = 0;
      const result = await sendPreparedMessage({
        kind, transmissionId: `legacy-${kind}`, from: 'sender@example.test',
        to: ['broker@example.test'], replyTo: 'reply@example.test',
        subject: 'Legacy no-send regression', text: 'No provider call.',
        html: '<p>No provider call.</p>', tags: [],
      }, {
        configOverride: { isProduction: false,
          server: { outboundRequestTimeoutMs: 100 },
          delivery: { provider: 'resend', resendApiKey: 'synthetic-key',
            resendFromEmail: 'sender@example.test' },
          dealHunter: { cimProvider: { enabled: true, profile: 'synthetic-provider' } } },
        fetcher: async () => { providerCalls += 1;
          return Response.json({ id: 'must-not-send' }); },
      });
      assert.equal(result.errorCategory, 'cim-provider-authorization-required');
      assert.equal(providerCalls, 0);
    });
  }
});


test('approved manual Stage 1 persists exact signed copy but cannot cross the P6B provider boundary', async (t) => {
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
  assert.equal(resendCalls.length, 0);

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
  assert.equal(communication.provider_message_id, null);

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
  assert.equal(resendCalls.length, 0, 'manual approval and replay cannot mint P6B provider authority');
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

test('manual approval returns a durable failed request without crossing the P6B boundary', async (t) => {
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
  assert.equal(resendCalls.length, 0);
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
  const secondOpportunityId = 'opp_shared_broker_second';
  const secondCreatedAt = new Date(Date.now() - 60_000).toISOString();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: secondOpportunityId,
    created_at: secondCreatedAt,
    updated_at: secondCreatedAt,
    canonical_name: 'Second Commercial Safety Services',
    canonical_recipient: initial.request.recipient_email,
    canonical_location: 'CA',
    primary_submission_id: null,
    identity_version: 'shared-broker-test-v1',
    status: 'active',
    metadata: {},
  });
  await storage.upsertDealHunterOpportunityAlias({
    id: 'alias_shared_broker_second',
    opportunity_id: secondOpportunityId,
    alias_type: 'listing-url',
    alias_value: 'https://broker.example.test/listing-shared-broker-2',
    alias_key: 'listing-url:https://broker.example.test/listing-shared-broker-2',
    source: 'shared-broker-test',
    first_observed_at: secondCreatedAt,
    last_observed_at: secondCreatedAt,
    evidence_version: 'shared-broker-test-v1',
    resolution_method: 'fixture',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: {},
  });
  await storage.insertSubmission({
    ...firstSubmission,
    id: secondSubmissionId,
    created_at: secondCreatedAt,
    updated_at: secondCreatedAt,
    company: 'Second Commercial Safety Services',
    listing_url: 'https://broker.example.test/listing-shared-broker-2',
    deal_hunter_opportunity_id: secondOpportunityId,
    metadata: {
      ...(firstSubmission.metadata || {}),
      dealHunter: {
        ...(firstSubmission.metadata?.dealHunter || {}),
        opportunityId: secondOpportunityId,
        dealKey: 'shared-broker-second-deal',
      },
    },
  });
  const secondLinkAuthority = await storage.readDealHunterCrmMatchAuthority();
  await storage.linkDealHunterCrmSubmissionIfAuthorityCurrent({
    opportunityId: secondOpportunityId,
    submissionId: secondSubmissionId,
    expectedAuthorityRevision: secondLinkAuthority.revision,
    updatedAt: secondCreatedAt,
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
    opportunity_id: secondOpportunityId,
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
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 2);
  assert.equal(resendCalls.length, 0);
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
