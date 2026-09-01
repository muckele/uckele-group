import assert from 'node:assert/strict';
import test from 'node:test';

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
import { sha256, stableCanonicalJson, verifySignedPayload } from '../server/utils/security.js';

const now = new Date();
const opportunityId = 'opp-broker-materials';

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
    async listDealHunterCimRequests() { return state.requests; },
    async getDealHunterCimOpportunityClaim() { return state.opportunityClaim; },
    async getDealHunterCimRecipientClaim(email) { return state.recipientClaims.get(String(email).toLowerCase()) || null; },
    async getActiveEmailSuppression() { return state.suppression; },
    async getDealHunterCimSafetySettings() { return state.safety; },
    async getBrokerMaterialsEmailReadiness() { return state.readiness; },
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

test('trusted source, current CRM, and verified operator contacts are selectable but unverified operator facts are excluded', async () => {
  const storage = authorityStorage({
    facts: [
      { id: 'fact-unverified', opportunity_id: opportunityId, field: 'broker_email', value: 'unverified@example.test', verified: false, updated_at: '2026-08-31T17:59:00.000Z' },
      { id: 'fact-verified', opportunity_id: opportunityId, field: 'broker_email', value: 'verified@example.test', verified: true, updated_at: '2026-08-31T17:40:00.000Z' },
    ],
    submission: { ...authorityStorage().state.submission, broker_email: 'crm@example.test' },
  });
  const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now });
  const emails = authority.recipientOptions.map(({ email }) => email).sort();

  assert.deepEqual(emails, ['crm@example.test', 'source-broker@example.test', 'verified@example.test']);
  assert.equal(emails.includes('unverified@example.test'), false);
  assert.deepEqual(new Set(authority.recipientOptions.map(({ provenance }) => provenance)), new Set(['crm', 'operator_verified', 'structured_source']));
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
