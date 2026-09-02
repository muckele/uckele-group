import assert from 'node:assert/strict';
import test from 'node:test';

test('manual approval enters the existing single-request durable executor only through trusted approved context', async () => {
  const dealHunter = await import('../server/services/dealHunter.js');
  assert.equal(typeof dealHunter.executeDealHunterCimFollowUpRequest, 'function');
  let storageReads = 0;
  const invalid = await dealHunter.executeDealHunterCimFollowUpRequest({
    request: { id: 'marked-request', metadata: { manualFollowUp: { mode: 'operator-approved' } } },
    approvedContext: {
      preparationToken: 'a forged browser artifact',
      approvedProposalDigest: 'c'.repeat(64),
    },
    storage: new Proxy({}, { get() { storageReads += 1; return async () => null; } }),
    now: new Date('2026-09-01T18:00:00.000Z'),
  });
  assert.equal(invalid.status, 'approval-required');
  assert.equal(storageReads, 0);
});

import { getConfig } from '../server/config.js';
import {
  BROKER_MATERIALS_TEMPLATE_VERSION,
  loadBrokerMaterialsAuthority,
  parseBrokerMaterialsPreparationInput,
  prepareDealHunterBrokerMaterials,
  projectDealHunterBrokerMaterials,
} from '../server/services/dealHunterBrokerMaterials.js';
import {
  buildDealHunterCimRequestId,
  evaluateDealHunterCimEligibility,
} from '../server/services/dealHunter.js';
import { sha256, signPayload, stableCanonicalJson, verifySignedPayload } from '../server/utils/security.js';

const now = new Date();
const opportunityId = 'opp-broker-materials';
const boundedCimRequestKeys = [
  'canCorrectRecipient',
  'canRetry',
  'correctionRoute',
  'createdAt',
  'deliveredAt',
  'deliveryState',
  'errorSummary',
  'followUpState',
  'id',
  'providerAcceptedAt',
  'recipient',
  'requestedAt',
  'requestState',
  'respondedAt',
  'retryRoute',
  'status',
  'subject',
  'updatedAt',
].sort();

function assertBoundedCimRequest(request) {
  const expectedKeys = request.followUps
    ? [...boundedCimRequestKeys, 'followUps'].sort()
    : boundedCimRequestKeys;
  assert.deepEqual(Object.keys(request).sort(), expectedKeys);
  assert.deepEqual(Object.keys(request.recipient).sort(), ['displayName', 'email']);
  for (const rawKey of [
    'metadata',
    'administratorPrincipalId',
    'proposalDigest',
    'nonce',
    'preparedAt',
    'delivery_error',
    'provider_response',
    'request_state',
    'delivery_state',
    'follow_up_state',
    'signature',
    'approvalClaims',
  ]) assert.equal(Object.hasOwn(request, rawKey), false, `${rawKey} must not cross the approval boundary`);
}

function sourceRow(overrides = {}) {
  return {
    id: 'source-name', opportunity_id: opportunityId, source_id: 'sheet', source_name: 'Deal Hunter Sheet',
    source_record_id: 'row-42', field: 'name', value: 'Durable Services Co',
    observed_at: '2026-08-31T17:00:00.000Z', created_at: '2026-08-31T17:00:00.000Z',
    updated_at: '2026-08-31T17:00:00.000Z', ...overrides,
  };
}

function authorityStorage(overrides = {}) {
  const state = {
    opportunity: {
      opportunity_id: opportunityId, canonical_name: 'Durable Services Co', canonical_location: 'Austin, TX',
      primary_submission_id: 'submission-1', identity_version: 'identity-v1', status: 'active',
      created_at: '2026-08-31T16:00:00.000Z', updated_at: '2026-08-31T17:00:00.000Z', metadata: {},
    },
    score: {
      opportunity_id: opportunityId, deal_key: 'deal-42', name: 'Durable Services Co', fit_score: 70,
      score_fingerprint: 'score-v1', semantic_digest: 'semantic-v1', reviewed_fingerprint: 'score-v1',
      reviewed_semantic_digest: 'semantic-v1', reviewed_at: '2026-08-31T17:30:00.000Z', reviewed_by: 'admin',
      operator_priority: 'high', changed_since_review: false, should_remove: false, listing_url: 'https://broker.example/deal-42',
      scored_at: '2026-08-31T17:00:00.000Z', metadata: {},
    },
    aliases: [{ id: 'alias-1', opportunity_id: opportunityId, alias_type: 'deal-key', alias_value: 'deal-42', alias_key: 'deal-key:deal-42', last_observed_at: '2026-08-31T17:00:00.000Z', evidence_version: 'v1', confidence_state: 'exact', metadata: {} }],
    facts: [],
    sources: [
      sourceRow(),
      sourceRow({ id: 'source-profit', field: 'annual_profit', value: '' }),
      sourceRow({ id: 'source-email', field: 'broker_email', value: 'source-broker@example.test' }),
      sourceRow({ id: 'source-first-name', field: 'broker_first_name', value: 'Avery' }),
    ],
    submission: {
      id: 'submission-1', status: 'active', company: 'Durable Services Co', broker_name: 'CRM Broker',
      broker_email: '', updated_at: '2026-08-31T17:00:00.000Z', metadata: {},
    },
    secureDocuments: [],
    latestUploadRequest: null,
    requests: [],
    opportunityClaim: null,
    recipientClaims: new Map(),
    suppression: null,
    safety: { outreach_paused: false, metadata: {} },
    readiness: { outboundConfigured: true, provider: 'resend', issues: [] },
    ...overrides,
  };
  return {
    state,
    async getCurrentDealHunterOpportunity(id) { return id === opportunityId ? state.opportunity : null; },
    async getCurrentDealHunterOpportunityScore(id) { return id === opportunityId ? state.score : null; },
    async listDealHunterOpportunityAliases() { return state.aliases; },
    async listDealHunterOpportunityFacts() { return state.facts; },
    async listDealHunterOpportunitySourceObservations() { return state.sources; },
    async getSubmission() { return state.submission; },
    async listSecureDocumentsForSubmission() { return state.secureDocuments; },
    async getLatestSecureUploadRequestForSubmission() { return state.latestUploadRequest; },
    async listDealHunterCimRequests({ opportunityIds = [], dealKeys = [], recipientEmails = [] } = {}) {
      return state.requests.filter((request) => (
        (!opportunityIds.length || opportunityIds.includes(request.opportunity_id))
        && (!dealKeys.length || dealKeys.includes(request.deal_key))
        && (!recipientEmails.length || recipientEmails.includes(request.recipient_email))
      ));
    },
    async listDealHunterDispositions() { return []; },
    async listDealHunterIdentityExceptions() { return []; },
    async getDealHunterCimOpportunityClaim() { return state.opportunityClaim; },
    async getDealHunterCimRecipientClaim(email) { return state.recipientClaims.get(String(email).toLowerCase()) || null; },
    async getActiveEmailSuppression() { return state.suppression; },
    async getDealHunterCimSafetySettings() { return state.safety; },
    async getBrokerMaterialsEmailReadiness() { return state.readiness; },
  };
}

function markedFollowUpRequest(overrides = {}) {
  return {
    id: 'request-manual-follow-up',
    opportunity_id: opportunityId,
    submission_id: 'submission-1',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'failed',
    follow_up_count: 0,
    next_follow_up_at: '2026-09-01T16:00:00.000Z',
    recipient_email: 'source-broker@example.test',
    created_at: '2026-08-31T17:40:00.000Z',
    updated_at: '2026-09-01T17:41:00.000Z',
    metadata: {
      manualFollowUp: {
        version: 'deal-hunter-manual-follow-up-v1',
        mode: 'operator-approved',
        maximumFollowUps: 5,
        cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
        enrolledAt: '2026-09-01T16:00:00.000Z',
        enrolledBy: 'admin@example.test',
      },
    },
    ...overrides,
  };
}

function adminSession(principalId = 'principal-admin-1') {
  return { principal_id: principalId, role: 'admin', username: 'admin' };
}

test('manual Stage 1 demotes low score and incomplete annual profit while automated remains strict', () => {
  const deal = { opportunityId, dealKey: 'deal-42', score: 70, annualProfit: null, shouldRemove: false };
  const automated = evaluateDealHunterCimEligibility({ deal, recipientEmail: 'broker@example.test' });
  const manual = evaluateDealHunterCimEligibility({ deal, recipientEmail: 'broker@example.test', policy: 'manual_stage_1' });

  assert.equal(automated.eligible, false);
  assert.deepEqual(automated.blockers.map(({ code }) => code), ['below_cim_score_threshold', 'annual_profit_incomplete']);
  assert.deepEqual(automated.warnings, []);
  assert.equal(manual.eligible, true);
  assert.deepEqual(manual.blockers, []);
  assert.deepEqual(manual.warnings.map(({ code }) => code), [
    'below_automated_cim_score_threshold',
    'annual_profit_incomplete',
  ]);
  assert.equal(buildDealHunterCimRequestId(opportunityId, ' Broker@Example.Test '), buildDealHunterCimRequestId(opportunityId, 'broker@example.test'));
});

test('manual preparation requires current explicit Pursue and actionable source authority', async (t) => {
  const cases = [
    ['watch', { score: { ...authorityStorage().state.score, operator_priority: 'watch' } }, 'not_pursued'],
    ['changed since review', { score: { ...authorityStorage().state.score, changed_since_review: true } }, 'pursue_not_current'],
    ['removed', { score: { ...authorityStorage().state.score, should_remove: true } }, 'opportunity_not_actionable'],
    ['superseded', { opportunity: { ...authorityStorage().state.opportunity, status: 'superseded' } }, 'canonical_authority_unavailable'],
    ['missing required source', { sources: [] }, 'required_source_authority_unavailable'],
  ];
  for (const [name, overrides, code] of cases) {
    await t.test(name, async () => {
      const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage: authorityStorage(overrides), now });
      assert.equal(result.success, false);
      assert.equal(result.code, code);
      assert.equal(Object.hasOwn(result, 'preparationToken'), false);
    });
  }
});

test('trusted source and current CRM contacts remain selectable when the newest operator email fact is unverified', async () => {
  const storage = authorityStorage({
    facts: [
      { id: 'fact-unverified', opportunity_id: opportunityId, field: 'broker_email', value: 'unverified@example.test', verified: false, updated_at: '2026-08-31T17:59:00.000Z' },
      { id: 'fact-verified', opportunity_id: opportunityId, field: 'broker_email', value: 'verified@example.test', verified: true, updated_at: '2026-08-31T17:40:00.000Z' },
    ],
    submission: { ...authorityStorage().state.submission, broker_email: 'crm@example.test' },
  });
  const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now });
  const emails = authority.recipientOptions.map(({ email }) => email).sort();

  assert.deepEqual(emails, ['crm@example.test', 'source-broker@example.test']);
  assert.equal(emails.includes('unverified@example.test'), false);
  assert.equal(emails.includes('verified@example.test'), false);
  assert.deepEqual(new Set(authority.recipientOptions.map(({ provenance }) => provenance)), new Set(['crm', 'structured_source']));
});

test('contact references are opaque, stable across ordering, canonical/provenance bound, and stale after authority identity changes', async () => {
  const firstStorage = authorityStorage();
  const first = await loadBrokerMaterialsAuthority({ opportunityId, storage: firstStorage, now });
  const original = first.recipientOptions[0];
  assert.equal(original.recipientContactRef.includes(original.email), false);

  const reordered = authorityStorage({ sources: [...firstStorage.state.sources].reverse() });
  const second = await loadBrokerMaterialsAuthority({ opportunityId, storage: reordered, now });
  assert.equal(second.recipientOptions.find(({ email }) => email === original.email).recipientContactRef, original.recipientContactRef);

  const changed = authorityStorage({ sources: firstStorage.state.sources.map((row) => row.field === 'broker_email' ? { ...row, id: 'source-email-v2', updated_at: '2026-08-31T17:59:00.000Z' } : row) });
  const stale = await prepareDealHunterBrokerMaterials({ opportunityId, recipientContactRef: original.recipientContactRef, session: adminSession(), storage: changed, now });
  assert.equal(stale.code, 'recipient_contact_stale');
  assert.equal(Object.hasOwn(stale, 'preparationToken'), false);
});

test('multiple contacts require explicit selection unless current authority marks one primary', async () => {
  const multiple = authorityStorage({ submission: { ...authorityStorage().state.submission, broker_email: 'crm@example.test' } });
  const required = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage: multiple, now });
  assert.equal(required.code, 'recipient_selection_required');
  assert.equal(required.recipientOptions.length, 2);
  assert.equal(Object.hasOwn(required, 'preparationToken'), false);

  const sourcePrimary = authorityStorage({
    submission: { ...authorityStorage().state.submission, broker_email: 'crm@example.test' },
    sources: authorityStorage().state.sources.map((row) => row.field === 'broker_email' ? { ...row, metadata: { primary: true } } : row),
  });
  const selected = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage: sourcePrimary, now });
  assert.equal(selected.success, true);
  assert.equal(selected.review.recipient.email, 'source-broker@example.test');
});

test('preparation input and greeting enforce the exact allowlist and one-line plain-text contract', () => {
  assert.deepEqual(parseBrokerMaterialsPreparationInput({ greeting: '  Hi Avery,  ' }), { greeting: 'Hi Avery,' });
  assert.deepEqual(parseBrokerMaterialsPreparationInput({ recipientContactRef: 'opaque.ref' }), { recipientContactRef: 'opaque.ref' });
  for (const body of [
    { greeting: 'a\nb' }, { greeting: 'a\rb' }, { greeting: '\nHello,' }, { greeting: 'Hello,\r' },
    { greeting: 'a\0b' }, { greeting: `Hi ${'x'.repeat(121)}` },
    { greeting: '<strong>Hello</strong>' }, { recipientEmail: 'raw@example.test' }, { subject: 'override' },
    { body: 'override' }, { sender: 'override' }, { dealKey: 'override' }, { policy: 'manual_stage_1' },
  ]) assert.throws(() => parseBrokerMaterialsPreparationInput(body), /invalid|unknown|plain text|greeting/i, JSON.stringify(body));
});

test('administrator preparation signs the exact principal-bound proposal for no more than fifteen minutes', async () => {
  const result = await prepareDealHunterBrokerMaterials({ opportunityId, greeting: '  Hi Avery,  ', session: adminSession(), storage: authorityStorage(), now });
  assert.equal(result.success, true);
  assert.equal(result.previewOnly, false);
  assert.equal(result.review.message.greeting, 'Hi Avery,');
  assert.equal(result.review.message.body.startsWith('Hi Avery,\n'), true);
  assert.equal(result.review.message.templateVersion, BROKER_MATERIALS_TEMPLATE_VERSION);
  assert.ok(result.review.message.html);
  assert.ok(result.review.sender.email);
  assert.ok(result.review.sender.replyTo);
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.preparedAt) <= 15 * 60 * 1000, true);

  const claims = verifySignedPayload(result.preparationToken, getConfig().admin.sessionSecret);
  assert.equal(claims.administratorPrincipalId, 'principal-admin-1');
  assert.equal(claims.canonicalOpportunityId, opportunityId);
  assert.equal(claims.proposalDigest, result.proposalDigest);
  assert.equal(claims.exp, Date.parse(result.expiresAt));
  assert.equal(sha256(stableCanonicalJson(claims.approvalBoundPayload)), result.proposalDigest);
  assert.equal(result.preparationToken.includes(getConfig().admin.sessionSecret), false);
  assert.equal(claims.approvalBoundPayload.bodyText, result.review.message.body);
  assert.equal(claims.approvalBoundPayload.bodyHtml, result.review.message.html);
});

test('viewer preview has no transferable authority and does not infer among multiple recipients', async () => {
  const single = await prepareDealHunterBrokerMaterials({ opportunityId, session: { principal_id: 'viewer-1', role: 'viewer', username: 'viewer' }, storage: authorityStorage(), now });
  assert.equal(single.success, true);
  assert.equal(single.previewOnly, true);
  for (const key of ['preparationToken', 'proposalDigest', 'nonce']) assert.equal(Object.hasOwn(single, key), false);
  assert.deepEqual(single.sendBlockers.map(({ code }) => code), ['administrator_required']);

  const multiple = await prepareDealHunterBrokerMaterials({
    opportunityId,
    session: { principal_id: 'viewer-1', role: 'viewer', username: 'viewer' },
    storage: authorityStorage({ submission: { ...authorityStorage().state.submission, broker_email: 'crm@example.test' } }),
    now,
  });
  assert.equal(multiple.previewOnly, true);
  assert.equal(multiple.code, 'recipient_selection_required');
  assert.equal(multiple.review, null);
  assert.equal(multiple.recipientOptions.length, 2);
});

test('preparation has zero durable side effects', async () => {
  const reads = authorityStorage();
  const mutationNames = /^(upsert|insert|write|claim|release|create|update|delete|record|set|reconcile|resolve|send|schedule|consume|import|refresh)/i;
  const guarded = new Proxy(reads, {
    get(target, property) {
      if (mutationNames.test(String(property))) return async () => { throw new Error(`unexpected mutation: ${String(property)}`); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const before = JSON.stringify(reads.state);
  const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage: guarded, now });
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(reads.state), before);
});

test('pause, suppression, cadence/readiness, and a live recipient claim are send-only blockers', async () => {
  const storage = authorityStorage({
    safety: { outreach_paused: true, metadata: { pauseReason: 'Operator pause' } },
    suppression: { id: 'suppression-1', reason: 'complaint' },
    readiness: { outboundConfigured: false, provider: 'console', issues: ['Provider unavailable.'] },
    requests: [{ id: 'old-touch', opportunity_id: 'other-opportunity', recipient_email: 'source-broker@example.test', status: 'sent', first_requested_at: new Date(now.getTime() - 15 * 60 * 1000).toISOString() }],
    recipientClaims: new Map([['source-broker@example.test', { request_id: 'other-request', expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString() }]]),
  });
  const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage, now });
  assert.equal(result.success, true);
  assert.ok(result.preparationToken);
  assert.deepEqual(new Set(result.sendBlockers.map(({ code }) => code)), new Set([
    'cim_outreach_paused', 'recipient_suppressed', 'recipient_cadence', 'provider_not_ready', 'recipient_claim_in_progress',
  ]));
});

test('mutable deal-key absence does not block fresh canonical manual preparation and aliases affect the authority fingerprint', async () => {
  const withoutKey = authorityStorage({ score: { ...authorityStorage().state.score, deal_key: '' }, aliases: [] });
  const fresh = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage: withoutKey, now });
  assert.equal(fresh.success, true);

  const first = await loadBrokerMaterialsAuthority({ opportunityId, storage: authorityStorage(), now });
  const changed = await loadBrokerMaterialsAuthority({ opportunityId, storage: authorityStorage({ aliases: [{ ...authorityStorage().state.aliases[0], alias_key: 'deal-key:renamed', alias_value: 'renamed' }] }), now });
  assert.notEqual(first.aliasResolutionFingerprint, changed.aliasResolutionFingerprint);
  assert.notEqual(first.authorityRevision, changed.authorityRevision);
});

test('projected broker materials exposes current Pursue, bounded lifecycle, warnings, options, and no provider internals', async () => {
  const storage = authorityStorage({ requests: [{
    id: 'request-1', opportunity_id: opportunityId, status: 'ambiguous', request_state: 'provider_unknown',
    delivery_state: 'unknown', follow_up_state: 'not-scheduled', recipient_email: 'source-broker@example.test',
    subject: 'CIM / NDA request for Durable Services Co', created_at: '2026-08-31T17:40:00.000Z', updated_at: '2026-08-31T17:41:00.000Z',
    first_requested_at: '2026-08-31T17:40:00.000Z', delivery_error: 'Safe summary',
    provider_message_id: 'secret-provider-id', metadata: { signature: 'secret', providerPayload: { secret: true } },
  }] });
  const projection = await projectDealHunterBrokerMaterials({ opportunityId, storage, now });
  assert.equal(projection.pursued, true);
  assert.deepEqual(projection.warnings.map(({ code }) => code), ['below_automated_cim_score_threshold', 'annual_profit_incomplete']);
  assert.equal(projection.existingRequest.id, 'request-1');
  assert.equal(projection.existingRequest.requestState, 'provider_unknown');
  assert.equal(projection.existingRequest.deliveryState, 'unknown');
  assert.equal(projection.existingRequest.followUpState, 'not-scheduled');
  const serialized = JSON.stringify(projection.existingRequest);
  for (const secret of ['secret-provider-id', 'providerPayload', 'signature']) assert.equal(serialized.includes(secret), false);
});

test('broker materials detail exposes bounded public manual follow-up projection without raw metadata', async () => {
  const privateSentinel = 'private-manual-follow-up-authority';
  const storage = authorityStorage({
    requests: [{
      id: 'request-manual-follow-up',
      opportunity_id: opportunityId,
      submission_id: 'submission-1',
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'accepted',
      follow_up_state: 'scheduled',
      follow_up_count: 2,
      next_follow_up_at: '2026-09-03T16:00:00.000Z',
      recipient_email: 'source-broker@example.test',
      created_at: '2026-08-31T17:40:00.000Z',
      updated_at: '2026-09-01T17:41:00.000Z',
      metadata: {
        privateSentinel,
        manualApproval: { signature: privateSentinel },
        manualFollowUp: {
          version: 'deal-hunter-manual-follow-up-v1',
          mode: 'operator-approved',
          maximumFollowUps: 5,
          cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
          enrolledAt: '2026-09-01T16:00:00.000Z',
          enrolledBy: privateSentinel,
        },
      },
    }],
  });

  const projection = await projectDealHunterBrokerMaterials({
    opportunityId,
    storage,
    now: new Date('2026-09-02T17:00:00.000Z'),
  });

  assert.deepEqual(projection.existingRequest.followUps, {
    enrolled: true,
    policyVersion: 'deal-hunter-manual-follow-up-v1',
    maximumFollowUps: 5,
    followUpCount: 2,
    currentFollowUpNumber: 3,
    nextFollowUpAt: '2026-09-03T16:00:00.000Z',
    state: 'scheduled',
    terminalReason: '',
    retryEligible: false,
    preparationBlockers: [],
    sendBlockers: [],
  });
  assert.equal(JSON.stringify(projection.existingRequest).includes(privateSentinel), false);
  assertBoundedCimRequest(projection.existingRequest);
});

test('critical authority read failures fail closed without issuing a preparation token', async (t) => {
  const cases = [
    ['persisted Pass authority', 'listDealHunterDispositions'],
    ['existing request authority', 'listDealHunterCimRequests'],
    ['opportunity claim authority', 'getDealHunterCimOpportunityClaim'],
    ['identity ambiguity authority', 'listDealHunterIdentityExceptions'],
  ];
  for (const [name, method] of cases) {
    await t.test(name, async () => {
      const storage = authorityStorage();
      storage[method] = async () => { throw new Error(`${method} unavailable`); };
      const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage, now });
      assert.equal(result.success, false);
      assert.equal(result.status, 503);
      assert.equal(result.code, 'broker_materials_authority_unavailable');
      assert.equal(Object.hasOwn(result, 'preparationToken'), false);
    });
  }
});

test('marked follow-up projection fails closed when secure-document authority cannot be read', async (t) => {
  const privateSentinel = 'private-secure-document-read-error';
  for (const [name, configure] of [
    ['thrown read', (storage) => { storage.listSecureDocumentsForSubmission = async () => { throw new Error(privateSentinel); }; }],
    ['missing capability', (storage) => { delete storage.listSecureDocumentsForSubmission; }],
  ]) {
    await t.test(name, async () => {
      const storage = authorityStorage({ requests: [markedFollowUpRequest()] });
      configure(storage);
      const projection = await projectDealHunterBrokerMaterials({
        opportunityId,
        storage,
        now: new Date('2026-09-02T17:00:00.000Z'),
      });

      assert.equal(projection.existingRequest.followUps.state, 'closed');
      assert.equal(projection.existingRequest.followUps.retryEligible, false);
      assert.equal(projection.existingRequest.followUps.currentFollowUpNumber, null);
      assert.deepEqual(projection.existingRequest.followUps.preparationBlockers, [{
        code: 'materials-authority-unavailable',
        message: 'Acquisition materials authority could not be verified.',
      }]);
      assert.equal(JSON.stringify(projection).includes(privateSentinel), false);
    });
  }
});

test('marked follow-up projection fails closed when upload-request authority cannot be read', async (t) => {
  const privateSentinel = 'private-upload-request-read-error';
  for (const [name, configure] of [
    ['thrown read', (storage) => { storage.getLatestSecureUploadRequestForSubmission = async () => { throw new Error(privateSentinel); }; }],
    ['missing capability', (storage) => { delete storage.getLatestSecureUploadRequestForSubmission; }],
  ]) {
    await t.test(name, async () => {
      const storage = authorityStorage({ requests: [markedFollowUpRequest()] });
      configure(storage);
      const projection = await projectDealHunterBrokerMaterials({
        opportunityId,
        storage,
        now: new Date('2026-09-02T17:00:00.000Z'),
      });

      assert.equal(projection.existingRequest.followUps.state, 'closed');
      assert.equal(projection.existingRequest.followUps.retryEligible, false);
      assert.equal(projection.existingRequest.followUps.currentFollowUpNumber, null);
      assert.deepEqual(projection.existingRequest.followUps.preparationBlockers, [{
        code: 'materials-authority-unavailable',
        message: 'Acquisition materials authority could not be verified.',
      }]);
      assert.equal(JSON.stringify(projection).includes(privateSentinel), false);
    });
  }
});

test('only the newest operator broker email fact can authorize a recipient', async () => {
  const verifiedA = {
    id: 'fact-email-a', opportunity_id: opportunityId, field: 'broker_email', value: 'operator-a@example.test',
    verified: true, created_at: '2026-08-31T17:20:00.000Z', updated_at: '2026-08-31T17:20:00.000Z',
  };
  const firstStorage = authorityStorage({ facts: [verifiedA] });
  const first = await loadBrokerMaterialsAuthority({ opportunityId, storage: firstStorage, now });
  const oldOption = first.recipientOptions.find(({ email }) => email === 'operator-a@example.test');
  assert.ok(oldOption);

  const verifiedB = {
    ...verifiedA, id: 'fact-email-b', value: 'operator-b@example.test',
    created_at: '2026-08-31T17:40:00.000Z', updated_at: '2026-08-31T17:40:00.000Z',
  };
  const replacementStorage = authorityStorage({ facts: [verifiedA, verifiedB] });
  const replacement = await loadBrokerMaterialsAuthority({ opportunityId, storage: replacementStorage, now });
  assert.equal(replacement.recipientOptions.some(({ email }) => email === 'operator-a@example.test'), false);
  assert.equal(replacement.recipientOptions.some(({ email }) => email === 'operator-b@example.test'), true);

  const stale = await prepareDealHunterBrokerMaterials({
    opportunityId, recipientContactRef: oldOption.recipientContactRef,
    session: adminSession(), storage: replacementStorage, now,
  });
  assert.equal(stale.code, 'recipient_contact_stale');
  assert.equal(Object.hasOwn(stale, 'preparationToken'), false);

  const unverifiedB = { ...verifiedB, verified: false };
  const unverifiedReplacement = await loadBrokerMaterialsAuthority({
    opportunityId, storage: authorityStorage({ facts: [verifiedA, unverifiedB] }), now,
  });
  assert.equal(unverifiedReplacement.recipientOptions.some(({ provenance }) => provenance === 'operator_verified'), false);
});

test('known deal-key aliases retain existing request and Pass ownership', async (t) => {
  const legacyAlias = {
    id: 'alias-legacy', opportunity_id: opportunityId, alias_type: 'deal-key', alias_value: 'legacy-key',
    alias_key: 'deal-key:legacy-key', evidence_version: 'legacy-v1', confidence_state: 'exact',
  };
  await t.test('existing request under a known alias', async () => {
    const storage = authorityStorage({ aliases: [legacyAlias], requests: [] });
    storage.listDealHunterCimRequests = async (options = {}) => (
      options.dealKeys?.includes('legacy-key')
        ? [{ id: 'legacy-request', deal_key: 'legacy-key', opportunity_id: null, status: 'sent', updated_at: '2026-08-31T17:50:00.000Z' }]
        : []
    );
    const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage, now });
    assert.equal(result.success, false);
    assert.equal(result.code, 'existing_request');
    assert.equal(Object.hasOwn(result, 'preparationToken'), false);
  });

  await t.test('Pass under a known alias with no current deal key', async () => {
    const storage = authorityStorage({
      aliases: [legacyAlias],
      score: { ...authorityStorage().state.score, deal_key: '' },
    });
    storage.listDealHunterDispositions = async (options = {}) => (
      options.dealKeys?.includes('legacy-key')
        ? [{ id: 'legacy-pass', deal_key: 'legacy-key', disposition: 'dismissed', updated_at: '2026-08-31T17:50:00.000Z' }]
        : []
    );
    const result = await prepareDealHunterBrokerMaterials({ opportunityId, session: adminSession(), storage, now });
    assert.equal(result.success, false);
    assert.equal(result.code, 'opportunity_passed');
    assert.equal(Object.hasOwn(result, 'preparationToken'), false);
  });

  await t.test('later durable restore supersedes historical Pass', async () => {
    const storage = authorityStorage({ aliases: [legacyAlias] });
    storage.listDealHunterDispositions = async () => [
      {
        id: 'legacy-pass', deal_key: 'legacy-key', disposition: 'dismissed',
        updated_at: '2026-08-31T17:50:00.000Z', dismissed_at: '2026-08-31T17:50:00.000Z',
      },
      {
        id: 'legacy-restore', deal_key: 'legacy-key', disposition: 'restored',
        updated_at: '2026-08-31T17:55:00.000Z', restored_at: '2026-08-31T17:55:00.000Z',
      },
    ];
    const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now });
    assert.equal(authority.currentDispositionState, 'restored');
    assert.equal(authority.preparationBlockers.some(({ code }) => code === 'opportunity_passed'), false);
  });
});

test('Broker Materials projection preserves production CIM lifecycle vocabulary', async (t) => {
  const cases = [
    ['ambiguous', { status: 'ambiguous', request_state: 'provider_ambiguous', delivery_state: 'ambiguous', follow_up_state: 'stopped' }],
    ['development', { status: 'logged', request_state: 'development_only', delivery_state: 'development-only', follow_up_state: 'not-scheduled' }],
    ['stopped', { status: 'delivery_issue', request_state: 'stopped', delivery_state: 'bounced', follow_up_state: 'completed' }],
  ];
  for (const [name, lifecycle] of cases) {
    await t.test(name, async () => {
      const projection = await projectDealHunterBrokerMaterials({
        opportunityId,
        storage: authorityStorage({ requests: [{
          id: `request-${name}`, opportunity_id: opportunityId, recipient_email: 'source-broker@example.test',
          created_at: '2026-08-31T17:40:00.000Z', updated_at: '2026-08-31T17:41:00.000Z', ...lifecycle,
        }] }),
        now,
      });
      assert.equal(projection.existingRequest.requestState, lifecycle.request_state);
      assert.equal(projection.existingRequest.deliveryState, lifecycle.delivery_state);
      assert.equal(projection.existingRequest.followUpState, lifecycle.follow_up_state);
    });
  }
});

test('Broker Materials projection replaces raw provider diagnostics with a closed safe summary', async () => {
  const rawProviderError = '{"message":"provider-private-sentinel"}';
  const projection = await projectDealHunterBrokerMaterials({
    opportunityId,
    storage: authorityStorage({ requests: [{
      id: 'request-provider-error', opportunity_id: opportunityId, recipient_email: 'source-broker@example.test',
      status: 'failed', request_state: 'ready', delivery_state: 'failed', follow_up_state: 'stopped',
      delivery_error: rawProviderError, created_at: '2026-08-31T17:40:00.000Z', updated_at: '2026-08-31T17:41:00.000Z',
    }] }),
    now,
  });
  assert.equal(projection.existingRequest.errorSummary, 'Delivery failed.');
  const serialized = JSON.stringify(projection.existingRequest);
  assert.equal(serialized.includes('provider-private-sentinel'), false);
  assert.equal(serialized.includes(rawProviderError), false);
});

test('stableCanonicalJson preserves prototype-named data and rejects collision-prone containers', () => {
  const withPrototypeKey = JSON.parse('{"a":1,"__proto__":{"x":2}}');
  const canonicalWithPrototypeKey = stableCanonicalJson(withPrototypeKey);
  assert.notEqual(canonicalWithPrototypeKey, stableCanonicalJson({ a: 1 }));
  const parsed = JSON.parse(canonicalWithPrototypeKey);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.deepEqual(parsed.__proto__, { x: 2 });

  assert.throws(() => stableCanonicalJson(Array(1)), /sparse array/i);
  const symbol = Symbol('private');
  assert.throws(() => stableCanonicalJson({ a: 1, [symbol]: 2 }), /symbol key/i);
  assert.equal(stableCanonicalJson(['second', 'first']), '["second","first"]');
  assert.throws(() => stableCanonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite/i);
});

async function task2Api() {
  const service = await import('../server/services/dealHunterBrokerMaterials.js');
  assert.equal(typeof service.parseBrokerMaterialsApprovalInput, 'function', 'Task 2 must export the strict approval parser');
  assert.equal(typeof service.approveDealHunterBrokerMaterials, 'function', 'Task 2 must export the approval adapter');
  return service;
}

async function preparedApproval({ storage = authorityStorage(), principalId = 'principal-admin-1', preparedAt = now } = {}) {
  const preparation = await prepareDealHunterBrokerMaterials({
    opportunityId,
    session: adminSession(principalId),
    storage,
    now: preparedAt,
  });
  assert.equal(preparation.success, true);
  return { storage, preparation };
}

function resignedPreparation(preparationToken, mutate) {
  const claims = verifySignedPayload(preparationToken, getConfig().admin.sessionSecret);
  assert.ok(claims);
  return signPayload(mutate(structuredClone(claims)), getConfig().admin.sessionSecret);
}

test('approval accepts only token plus digest and rejects every browser-authored authority field', async () => {
  const { parseBrokerMaterialsApprovalInput } = await task2Api();
  assert.deepEqual(parseBrokerMaterialsApprovalInput({ preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64) }), {
    preparationToken: 'signed.token',
    approvedProposalDigest: 'a'.repeat(64),
  });
  for (const body of [
    {}, { preparationToken: 'signed.token' }, { approvedProposalDigest: 'a'.repeat(64) },
    { preparationToken: '', approvedProposalDigest: 'a'.repeat(64) },
    { preparationToken: 'signed.token', approvedProposalDigest: 'not-a-digest' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), recipient: 'raw@example.test' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), recipientEmail: 'raw@example.test' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), recipientContactRef: 'client-ref' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), greeting: 'Hello,' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), subject: 'override' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), body: 'override' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), html: '<p>override</p>' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), sender: 'override' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), replyTo: 'override@example.test' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), dealKey: 'client-deal' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), policy: 'manual_stage_1' },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), pauseOverride: true },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), cadenceOverride: true },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), suppressionOverride: true },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), readinessOverride: true },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), followUp: true },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), scheduledAt: now.toISOString() },
    { preparationToken: 'signed.token', approvedProposalDigest: 'a'.repeat(64), pipelineState: 'contacted' },
  ]) assert.throws(() => parseBrokerMaterialsApprovalInput(body), /approval|unknown|token|digest/i, JSON.stringify(body));
});

test('approval rejects invalid signed claims, route, principal, and digest before durable execution', async (t) => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const { storage, preparation } = await preparedApproval();
  const claims = verifySignedPayload(preparation.preparationToken, getConfig().admin.sessionSecret);
  const cases = [
    ['invalid signature', `${preparation.preparationToken}tampered`, preparation.proposalDigest, opportunityId, adminSession(), 'invalid_preparation'],
    ['wrong type', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, typ: 'wrong-type' })), preparation.proposalDigest, opportunityId, adminSession(), 'invalid_preparation'],
    ['wrong version', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, version: 2 })), preparation.proposalDigest, opportunityId, adminSession(), 'invalid_preparation'],
    ['wrong intent', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, intent: 'automated' })), preparation.proposalDigest, opportunityId, adminSession(), 'invalid_preparation'],
    ['wrong request type', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, requestType: 'other' })), preparation.proposalDigest, opportunityId, adminSession(), 'invalid_preparation'],
    ['expired', signPayload({ ...claims, exp: Date.now() - 1 }, getConfig().admin.sessionSecret), preparation.proposalDigest, opportunityId, adminSession(), 'preparation_stale'],
    ['wrong route', preparation.preparationToken, preparation.proposalDigest, 'opp-other', adminSession(), 'preparation_mismatch'],
    ['wrong principal', preparation.preparationToken, preparation.proposalDigest, opportunityId, adminSession('principal-other'), 'preparation_mismatch'],
    ['submitted digest mismatch', preparation.preparationToken, 'b'.repeat(64), opportunityId, adminSession(), 'proposal_digest_mismatch'],
    ['signed digest mismatch', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, proposalDigest: 'c'.repeat(64) })), 'c'.repeat(64), opportunityId, adminSession(), 'proposal_digest_mismatch'],
    ['recomputed digest mismatch', resignedPreparation(preparation.preparationToken, (value) => ({ ...value, approvalBoundPayload: { ...value.approvalBoundPayload, subject: 'tampered but signed' } })), preparation.proposalDigest, opportunityId, adminSession(), 'proposal_digest_mismatch'],
  ];
  for (const [name, preparationToken, approvedProposalDigest, routeId, session, code] of cases) {
    await t.test(name, async () => {
      let executions = 0;
      const result = await approveDealHunterBrokerMaterials({
        opportunityId: routeId,
        preparationToken,
        approvedProposalDigest,
        session,
        storage,
        executeApprovedCimRequest: async () => { executions += 1; return { ok: true }; },
      });
      assert.equal(result.success, false);
      assert.equal(result.code, code);
      assert.equal(executions, 0);
      assert.equal(Object.hasOwn(result, 'durableResult'), false);
    });
  }
});

test('approval revalidates every material authority binding and returns preparation_stale before execution', async (t) => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const mutations = [
    ['current authority', (storage) => { storage.state.opportunity = { ...storage.state.opportunity, status: 'superseded' }; }],
    ['Pursue authority', (storage) => { storage.state.score = { ...storage.state.score, operator_priority: 'watch' }; }],
    ['actionability', (storage) => { storage.state.score = { ...storage.state.score, should_remove: true }; }],
    ['source authority', (storage) => { storage.state.sources = storage.state.sources.map((row) => row.id === 'source-name' ? { ...row, value: 'Changed Co', updated_at: '2026-08-31T17:59:00.000Z' } : row); }],
    ['alias fingerprint', (storage) => { storage.state.aliases = storage.state.aliases.map((row) => ({ ...row, alias_value: 'changed-key', alias_key: 'deal-key:changed-key' })); }],
    ['contact provenance', (storage) => { storage.state.sources = storage.state.sources.map((row) => row.id === 'source-email' ? { ...row, id: 'source-email-v2', updated_at: '2026-08-31T17:59:00.000Z' } : row); }],
    ['recipient email', (storage) => { storage.state.sources = storage.state.sources.map((row) => row.id === 'source-email' ? { ...row, value: 'changed@example.test' } : row); }],
    ['warning score', (storage) => { storage.state.score = { ...storage.state.score, fit_score: 71 }; }],
    ['warning profit', (storage) => { storage.state.sources = storage.state.sources.map((row) => row.id === 'source-profit' ? { ...row, value: '100000' } : row); }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const { storage, preparation } = await preparedApproval();
      mutate(storage);
      let executions = 0;
      const result = await approveDealHunterBrokerMaterials({
        opportunityId,
        preparationToken: preparation.preparationToken,
        approvedProposalDigest: preparation.proposalDigest,
        session: adminSession(),
        storage,
        executeApprovedCimRequest: async () => { executions += 1; return { ok: true }; },
      });
      assert.equal(result.success, false);
      assert.equal(result.code, 'preparation_stale');
      assert.equal(executions, 0);
    });
  }
});

test('existing durable ownership takes precedence over staleness without crossing the executor', async () => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const { storage, preparation } = await preparedApproval();
  storage.state.score = { ...storage.state.score, operator_priority: 'watch' };
  storage.state.requests = [{
    id: 'existing-durable-request', opportunity_id: opportunityId, deal_key: 'deal-42', recipient_email: 'source-broker@example.test',
    status: 'ambiguous', request_state: 'provider_ambiguous', delivery_state: 'ambiguous', follow_up_state: 'not-scheduled',
    created_at: '2026-08-31T17:50:00.000Z', updated_at: '2026-08-31T17:51:00.000Z',
  }];
  let executions = 0;
  const result = await approveDealHunterBrokerMaterials({
    opportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: adminSession(),
    storage,
    executeApprovedCimRequest: async () => { executions += 1; return { ok: true }; },
  });
  assert.equal(result.success, true);
  assert.equal(result.canonicalOpportunityId, opportunityId);
  assert.equal(result.durableResult.cimRequest.id, 'existing-durable-request');
  assert.equal(result.durableResult.cimRequest.status, 'ambiguous');
  assertBoundedCimRequest(result.durableResult.cimRequest);
  assert.equal(executions, 0);
});

test('verified approval crosses the trusted durable boundary exactly once with signed claims and server audit identity only', async () => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const { storage, preparation } = await preparedApproval();
  const claims = verifySignedPayload(preparation.preparationToken, getConfig().admin.sessionSecret);
  const calls = [];
  const durableRequest = {
    id: claims.approvalBoundPayload.prospectiveRequestId,
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    follow_up_state: 'not-scheduled',
    recipient_email: 'source-broker@example.test',
    recipient_name: 'Avery Broker',
    subject: 'Approved request',
    created_at: '2026-08-31T18:00:00.000Z',
    updated_at: '2026-08-31T18:01:00.000Z',
    first_requested_at: '2026-08-31T18:00:00.000Z',
    first_provider_accepted_at: '2026-08-31T18:01:00.000Z',
    metadata: {
      manualApproval: {
        administratorPrincipalId: 'principal-admin-1',
        proposalDigest: claims.proposalDigest,
        nonce: claims.nonce,
        preparedAt: claims.preparedAt,
      },
    },
    delivery_error: 'raw provider error',
    provider_response: { secret: 'raw provider response' },
    signature: 'must-not-escape',
    approvalClaims: claims,
  };
  const result = await approveDealHunterBrokerMaterials({
    opportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: adminSession(),
    storage,
    executeApprovedCimRequest: async (input) => { calls.push(input); return { ok: true, status: 201, request: durableRequest }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['administratorPrincipalId', 'approvedProposal', 'requestedBy', 'storage']);
  assert.deepEqual(calls[0].approvedProposal, {
    ...claims.approvalBoundPayload,
    proposalDigest: claims.proposalDigest,
    nonce: claims.nonce,
    preparedAt: claims.preparedAt,
    intent: claims.intent,
    requestType: claims.requestType,
  });
  assert.equal(calls[0].administratorPrincipalId, 'principal-admin-1');
  assert.equal(calls[0].requestedBy, 'admin');
  assert.equal(calls[0].storage, storage);
  assert.equal(result.success, true);
  assertBoundedCimRequest(result.durableResult.cimRequest);
  assert.equal(result.durableResult.cimRequest.id, durableRequest.id);
  assert.equal(result.durableResult.cimRequest.requestState, 'provider_accepted');
  assert.equal(result.durableResult.cimRequest.deliveryState, 'accepted');
  assert.deepEqual(result.durableResult.cimRequest.recipient, {
    email: 'source-broker@example.test',
    displayName: 'Avery Broker',
  });
});

test('every executor result containing a durable request normalizes safely regardless of delivery outcome', async (t) => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const cases = [
    ['pending', 'pending', 'pending'],
    ['sent', 'provider_accepted', 'accepted'],
    ['logged', 'development_only', 'development-only'],
    ['failed', 'failed', 'failed'],
    ['ambiguous', 'provider_ambiguous', 'ambiguous'],
    ['delivery_issue', 'stopped', 'bounced'],
    ['responded', 'responded', 'responded'],
  ];
  for (const [status, requestState, deliveryState] of cases) {
    await t.test(status, async () => {
      const { storage, preparation } = await preparedApproval();
      const request = {
        id: `durable-${status}`,
        status,
        request_state: requestState,
        delivery_state: deliveryState,
        follow_up_state: 'not-scheduled',
        recipient_email: 'source-broker@example.test',
        metadata: { manualApproval: { administratorPrincipalId: 'must-not-escape' } },
        delivery_error: 'must-not-escape',
        provider_response: { raw: true },
      };
      const result = await approveDealHunterBrokerMaterials({
        opportunityId,
        preparationToken: preparation.preparationToken,
        approvedProposalDigest: preparation.proposalDigest,
        session: adminSession(),
        storage,
        executeApprovedCimRequest: async () => ({ ok: false, status: 503, error: 'provider outcome', request }),
      });
      assert.equal(result.success, true);
      assert.equal(result.canonicalOpportunityId, opportunityId);
      assertBoundedCimRequest(result.durableResult.cimRequest);
      assert.equal(result.durableResult.cimRequest.id, request.id);
      assert.equal(result.durableResult.cimRequest.status, status);
      assert.equal(result.durableResult.cimRequest.requestState, requestState);
      assert.equal(result.durableResult.cimRequest.deliveryState, deliveryState);
      assert.equal(Object.hasOwn(result, 'error'), false);
    });
  }

  const { storage, preparation } = await preparedApproval();
  const blocked = await approveDealHunterBrokerMaterials({
    opportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session: adminSession(),
    storage,
    executeApprovedCimRequest: async () => ({ ok: false, status: 409, error: 'paused before claim', code: 'cim_outreach_paused' }),
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, 'cim_outreach_paused');
  assert.equal(Object.hasOwn(blocked, 'durableResult'), false);
});

test('an arbitrary pre-durable executor exception remains a non-durable failure', async () => {
  const { approveDealHunterBrokerMaterials } = await task2Api();
  const { storage, preparation } = await preparedApproval();

  await assert.rejects(
    approveDealHunterBrokerMaterials({
      opportunityId,
      preparationToken: preparation.preparationToken,
      approvedProposalDigest: preparation.proposalDigest,
      session: adminSession(),
      storage,
      executeApprovedCimRequest: async () => {
        throw new Error('pre-durable infrastructure unavailable');
      },
    }),
    /pre-durable infrastructure unavailable/,
  );
});
