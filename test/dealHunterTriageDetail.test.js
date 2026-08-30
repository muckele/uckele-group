import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setOperatorOpportunityFact } from '../server/services/dealHunterOpportunityFacts.js';
import { getTriageOpportunityDetail } from '../server/services/dealHunterTriage.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

function currentScore(opportunityId) {
  return {
    opportunity_id: opportunityId,
    scored_at: '2026-08-30T10:00:00.000Z',
    deal_key: `deal-${opportunityId}`,
    name: 'Detail Services Co',
    state: 'TX',
    listing_url: 'https://broker.example/listings/detail-services',
    fit_score: 81,
    score_status: 'high-fit',
    confidence: 'high',
    completeness_score: 78,
    contradiction_count: 1,
    missing_evidence_count: 2,
    should_remove: false,
    high_fit: true,
    gate_count: 0,
    score_fingerprint: `fingerprint-${opportunityId}`,
    semantic_digest: `digest-${opportunityId}`,
    engine_version: 'detail-test',
    rules_version: 'detail-test',
    profile_version: 'detail-test',
    completeness_policy_version: 'detail-test',
    dimensions: [{ id: 'financial-fit', label: 'Financial fit', contribution: 20 }],
    gates: [],
    applied_caps: [],
    missing_evidence: ['seller name'],
    confidence_reasons: ['Revenue observed'],
    summary: { strengths: ['Strong financials'], concerns: ['Seller contact missing'] },
  };
}

async function detailStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-triage-detail-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'detail.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const opportunityId = 'opp-detail';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: '2026-08-30T09:00:00.000Z',
    updated_at: '2026-08-30T09:00:00.000Z',
    canonical_name: 'Detail Services Co',
    canonical_recipient: null,
    canonical_location: 'Austin, TX',
    primary_submission_id: 'submission-detail',
    identity_version: 'detail-test',
    status: 'active',
    metadata: {},
  });
  await storage.writeDealHunterOpportunityScore(currentScore(opportunityId), [{
    id: 'detail-evidence', opportunity_id: opportunityId, dimension: 'financial-fit', rule_id: 'financial.sde',
    rule_label: 'SDE fits target', evidence_class: 'observed', field: 'annual_profit', value: '$450,000',
    observed_value: '$450,000', terms: [], source_id: 'deal-os', source_name: 'Deal OS', source_record_id: 'detail-1',
    listing_url: 'https://broker.example/listings/detail-services', observed_at: '2026-08-30T09:30:00.000Z',
  }]);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  const addObservation = async (id, sourceId, sourceName, recordId, field, value) => storage.upsertDealHunterOpportunitySourceObservation({
    id, opportunity_id: opportunityId, source_id: sourceId, source_name: sourceName, source_record_id: recordId,
    field, value, observed_at: '2026-08-30T09:30:00.000Z', created_at: '2026-08-30T09:30:00.000Z', updated_at: '2026-08-30T09:30:00.000Z',
  });
  await addObservation('source-seller', 'sheet', 'Deal Hunter Sheet', 'sheet-1', 'seller_name', 'Sheet Seller');
  await addObservation('source-broker', 'sheet', 'Deal Hunter Sheet', 'sheet-1', 'broker_email', 'sheet-broker@example.test');
  await addObservation('source-url-a', 'sheet', 'Deal Hunter Sheet', 'sheet-1', 'listing_url', 'https://broker.example/listings/detail-services');
  await addObservation('source-profit-sheet', 'sheet', 'Deal Hunter Sheet', 'sheet-1', 'annual_profit', '450000');
  await addObservation('source-url-b', 'deal-os', 'Deal OS', 'deal-1', 'listing_url', 'https://broker.example/listings/detail-services');
  await addObservation('source-url-bad', 'deal-os', 'Deal OS', 'deal-1', 'prospectus_url', 'javascript:alert(1)');
  await addObservation('source-conflict', 'deal-os', 'Deal OS', 'deal-1', 'annual_profit', '200000');
  await setOperatorOpportunityFact({
    opportunityId, field: 'seller_name', value: 'Verified Operator Seller', verified: true,
    note: 'Confirmed by phone.', actor: 'operator@example.test', storage,
  });
  return { storage, opportunityId };
}

test('consolidated detail returns the exact bounded view with authority, conflicts, safe URLs, and read-only history', async (t) => {
  const { storage, opportunityId } = await detailStorage(t);
  let scoreWrites = 0;
  const readOnlyStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'writeDealHunterOpportunityScore') return async () => { scoreWrites += 1; throw new Error('detail must not score'); };
      if (property === 'getSubmission') return async () => ({
        id: 'submission-detail', seller_name: 'CRM Seller', seller_email: 'crm-seller@example.test',
        broker_name: 'CRM Broker', broker_email: 'crm-broker@example.test', metadata: {},
      });
      if (property === 'listDealHunterCimRequests') return async () => [{ id: 'cim-detail', opportunity_id: opportunityId, status: 'requested' }];
      if (property === 'listCrmActivityEvents') return async () => [{ id: 'activity-detail', event_type: 'opportunity.triaged', created_at: '2026-08-30T10:00:00.000Z' }];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const detail = await getTriageOpportunityDetail({ opportunityId, storage: readOnlyStorage });

  assert.equal(detail.ok, true);
  assert.deepEqual(Object.keys(detail).sort(), [
    'cimSummary', 'crmSummary', 'effectiveFacts', 'history', 'listingUrls', 'missingCriticalFields',
    'ok', 'operatorFacts', 'opportunity', 'score', 'sourceObservations', 'status',
  ]);
  assert.equal(detail.effectiveFacts.seller_name.value, 'Verified Operator Seller');
  assert.equal(detail.effectiveFacts.seller_name.provenance, 'operator');
  assert.equal(detail.effectiveFacts.broker_email.value, 'crm-broker@example.test');
  assert.equal(detail.effectiveFacts.broker_email.provenance, 'crm');
  assert.equal(detail.operatorFacts[0].field, 'seller_name');
  assert.equal(detail.sourceObservations.length, 2);
  assert.equal(detail.sourceObservations.some((source) => source.conflicts.some((conflict) => conflict.field === 'annual_profit')), true);
  assert.deepEqual(detail.listingUrls, ['https://broker.example/listings/detail-services']);
  assert.equal(detail.listingUrls.some((url) => url.startsWith('javascript:')), false);
  assert.equal(detail.missingCriticalFields.includes('seller_name'), false);
  assert.equal(detail.missingCriticalFields.includes('annual_profit'), false);
  assert.equal(detail.missingCriticalFields.includes('seller_email'), false);
  assert.equal(detail.missingCriticalFields.includes('asking_price'), true);
  assert.deepEqual(detail.score.fitScore, 81);
  assert.equal(detail.score.dimensions[0].evidence[0].ruleId, 'financial.sde');
  assert.equal(detail.cimSummary.requests[0].id, 'cim-detail');
  assert.equal(detail.crmSummary.submission.id, 'submission-detail');
  assert.equal(detail.history.activities[0].id, 'activity-detail');
  assert.equal(scoreWrites, 0);
});

test('consolidated detail rejects a superseded opportunity even when its historical facts and score remain', async (t) => {
  const { storage, opportunityId } = await detailStorage(t);
  const historical = await storage.getDealHunterOpportunity(opportunityId);
  await storage.upsertDealHunterOpportunity({ ...historical, status: 'superseded', updated_at: '2026-08-30T11:00:00.000Z' });

  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.equal(detail.ok, false);
  assert.equal(detail.status, 404);
  assert.ok(await storage.getDealHunterOpportunityScore(opportunityId));
  assert.ok((await storage.listDealHunterOpportunityFacts(opportunityId)).length > 0);
});

test('detail sends bounded storage reads and closed, safe URL projections', async (t) => {
  const { storage, opportunityId } = await detailStorage(t);
  const calls = [];
  const boundedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'listDealHunterOpportunitySourceObservations') return async (...args) => {
        calls.push(args);
        return Array.from({ length: 700 }, (_, index) => ({
          id: `source-${index}`, opportunity_id: opportunityId, source_id: `source-${index}`, source_name: `Source ${index}`,
          source_record_id: `record-${index}`, field: 'listing_url', value: `https://broker.example/${index}`,
          observed_at: '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z', metadata: { private: 'x'.repeat(2000) },
        }));
      };
      if (property === 'listDealHunterCimRequests') return async () => [{ id: 'cim', status: 'requested', metadata: { private: 'x'.repeat(2000) }, provider_message_id: 'secret' }];
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: boundedStorage });
  assert.deepEqual(calls[0][1], { limit: 500 });
  assert.equal(detail.sourceObservations.length, 100);
  assert.equal(detail.listingUrls.length, 100);
  assert.equal(JSON.stringify(detail.cimSummary).includes('private'), false);
  assert.equal(JSON.stringify(detail.cimSummary).includes('provider_message_id'), false);
});

test('detail closes every nested projection and strips injected storage metadata', async (t) => {
  const { storage, opportunityId } = await detailStorage(t);
  const sentinel = 'DO-NOT-LEAK-DETAIL-SENTINEL';
  const hostile = new Proxy(storage, {
    get(target, property) {
      if (property === 'getCurrentDealHunterOpportunityScore') return async () => ({
        ...currentScore(opportunityId),
        opportunity_id: { private: sentinel }, name: { private: sentinel }, state: { private: sentinel }, operator_priority: { private: sentinel }, operator_note: { private: sentinel }, reviewed_at: { private: sentinel }, reviewed_by: { private: sentinel }, reviewed_fingerprint: { private: sentinel },
        listing_url: 'https://broker.example/score',
        dimensions: [{ id: 'financial-fit', label: 'x'.repeat(900), contribution: 20, private: sentinel }],
        gates: [{ rule_id: 'gate', reason: 'x'.repeat(900), private: sentinel }],
        applied_caps: [{ rule_id: 'cap', cap: 10, private: sentinel }],
        confidence_reasons: ['x'.repeat(900), { private: sentinel }],
        missing_evidence: ['x'.repeat(900), { private: sentinel }],
        summary: { strengths: ['x'.repeat(900)], concerns: ['x'.repeat(900)], private: sentinel },
      });
      if (property === 'listDealHunterScoreEvidence') return async () => Array.from({ length: 600 }, (_, index) => ({
        dimension: 'financial-fit', rule_id: `rule-${index}`, rule_label: 'x'.repeat(900), evidence_class: 'observed',
        field: 'annual_profit', value: { private: sentinel }, observed_value: [sentinel], terms: ['x'.repeat(900), { private: sentinel }],
        source_id: 'source', source_name: 'x'.repeat(900), source_record_id: 'record', listing_url: 'https://user:pass@broker.example/private',
        observed_at: '2026-08-30T10:00:00.000Z', private: sentinel,
      }));
      if (property === 'listDealHunterOpportunitySourceObservations') return async () => Array.from({ length: 700 }, (_, index) => ({
        source_id: index === 0 ? { private: sentinel } : `source-${index}`, source_name: index === 0 ? { private: sentinel } : 'Source',
        source_record_id: index === 0 ? { private: sentinel } : `record-${index}`, field: index === 0 ? { private: sentinel } : 'seller_name',
        value: index === 0 ? { private: sentinel } : `Seller ${index}`, observed_at: index === 0 ? { private: sentinel } : '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z',
      }));
      if (property === 'listDealHunterOpportunityFacts') return async () => [{ id: 'fact', field: 'seller_name', value: 'x'.repeat(9000), verified: true, actor: 'x'.repeat(900), note: 'x'.repeat(9000), created_at: '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z', private: sentinel }];
      if (property === 'listDealHunterCimRequests') return async () => [{ id: 'cim', status: 'requested', request_state: sentinel, delivery_state: sentinel, provider: sentinel, reply_to: sentinel, metadata: { private: sentinel }, updated_at: '2026-08-30T10:00:00.000Z' }];
      if (property === 'listCrmCommunications') return async () => ({ rows: [{ id: 'comm', direction: 'outbound', channel: 'email', kind: 'cim', occurred_at: '2026-08-30T10:00:00.000Z', provider: sentinel, reply_to: sentinel, delivery_state: sentinel, metadata: { private: sentinel } }] });
      if (property === 'getSubmission') return async () => ({ id: 'submission', status: 'open', company: 'x'.repeat(900), seller_name: 'x'.repeat(900), metadata: { private: sentinel, dealHunter: { sellerPhone: '555' } } });
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
  assert.deepEqual(Object.keys(detail.score).sort(), ['appliedCaps', 'completenessScore', 'confidence', 'confidenceReasons', 'dimensions', 'fitScore', 'gates', 'missingEvidence', 'scoreStatus', 'summary', 'unattributedEvidence']);
  assert.deepEqual(Object.keys(detail.score.dimensions[0]).sort(), ['contribution', 'evidence', 'id', 'label']);
  assert.deepEqual(Object.keys(detail.operatorFacts[0]).sort(), ['actor', 'createdAt', 'field', 'id', 'note', 'updatedAt', 'value', 'verified']);
  assert.deepEqual(Object.keys(detail.effectiveFacts.seller_name).sort(), ['actor', 'note', 'provenance', 'value', 'verified']);
  assert.deepEqual(Object.keys(detail.history.operatorState).sort(), ['note', 'priority', 'reviewed', 'reviewedAt', 'reviewedBy']);
  assert.deepEqual(Object.keys(detail.opportunity.geography).sort(), ['city', 'label', 'state']);
  assert.deepEqual(Object.keys(detail.opportunity.financials).sort(), ['annualProfit', 'annualRevenue', 'askingPrice', 'profitMultiple']);
  assert.deepEqual(Object.keys(detail.opportunity.workflow).sort(), ['cimStatus', 'crmStatus']);
  assert.deepEqual(Object.keys(detail.cimSummary.requests[0]).sort(), ['id', 'status', 'updatedAt']);
  assert.deepEqual(Object.keys(detail.crmSummary.communications[0]).sort(), ['channel', 'cimRequestId', 'direction', 'id', 'kind', 'occurredAt']);
  assert.ok(detail.score.dimensions[0].evidence.length <= 100);
  assert.ok(detail.score.dimensions[0].label.length <= 160);
  assert.ok(detail.operatorFacts[0].value.length <= 4000);
  assert.equal(typeof detail.opportunity.reviewed, 'boolean');
  assert.ok(detail.history.operatorState.note.length <= 2000);
  assert.equal(detail.sourceObservations.some((item) => JSON.stringify(item).includes(sentinel)), false);
  assert.ok(detail.sourceObservations.length <= 100);
  assert.ok(detail.sourceObservations.every((item) => Object.keys(item.values).every((field) => ['seller_name'].includes(field))));
  assert.equal(JSON.stringify(detail).includes(sentinel), false);
});

test('source conflicts retain late source-record membership while each serialized conflict stays bounded', async (t) => {
  // Break caught: selecting the first 20 observations before membership
  // attribution makes a real, later source record appear conflict-free.
  const { storage, opportunityId } = await detailStorage(t);
  const hostile = new Proxy(storage, {
    get(target, property) {
      if (property === 'listDealHunterOpportunitySourceObservations') return async () => Array.from({ length: 25 }, (_, index) => ({
        source_id: `source-${index}`, source_name: `Source ${index}`, source_record_id: `record-${index}`,
        field: 'reason_for_sale', value: index % 2 ? 'retirement' : 'relocation',
        observed_at: '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z',
      }));
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
  const late = detail.sourceObservations.find((group) => group.sourceRecordId === 'record-24');
  assert.ok(late, 'late bounded source group is emitted');
  assert.equal(late.conflicts.some((conflict) => conflict.field === 'reason_for_sale'), true);
  const conflict = late.conflicts.find((item) => item.field === 'reason_for_sale');
  assert.ok(conflict.observations.length <= 20);
  assert.equal(conflict.observations.some((item) => item.sourceRecordId === 'record-24'), true);
});

test('detail projects all thirteen scalar CRM facts and rejects non-scalar CRM values', async (t) => {
  // Break caught: false/zero CRM facts vanish or untrusted CRM objects cross
  // the authority boundary instead of producing all supported observations.
  const { storage, opportunityId } = await detailStorage(t);
  const values = {
    seller_name: 'crm-seller_name', seller_email: 'crm-seller_email', seller_phone: 'crm-seller_phone',
    broker_name: 'crm-broker_name', broker_company: 'crm-broker_company', broker_email: 'crm-broker_email', broker_phone: 'crm-broker_phone',
    reason_for_sale: 'crm-reason_for_sale', real_estate_included: false, seller_financing: 0,
    management_structure: 'crm-management_structure', customer_concentration: 'crm-customer_concentration', operator_contact_notes: 'crm-operator_contact_notes',
  };
  const hostile = new Proxy(storage, {
    get(target, property) {
      if (property === 'getSubmission') return async () => ({ id: 'submission-detail', metadata: { dealHunter: { ...values, sellerName: { private: 'nope' } } } });
      if (property === 'listDealHunterOpportunityFacts') return async () => Object.entries(values).map(([field]) => ({
        id: `operator-${field}`, field, value: `operator-${field}`, verified: true, actor: 'admin', note: 'verified', created_at: '2026-08-30T12:00:00.000Z', updated_at: '2026-08-30T12:00:00.000Z',
      }));
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
  assert.deepEqual(detail.crmSummary.factObservations.map((item) => item.field).sort(), Object.keys(values).sort());
  assert.equal(detail.crmSummary.factObservations.find((item) => item.field === 'real_estate_included').value, 'false');
  assert.equal(detail.crmSummary.factObservations.find((item) => item.field === 'seller_financing').value, '0');
  assert.deepEqual(detail.crmSummary.conflicts.map((item) => item.field).sort(), Object.keys(values).sort());
  assert.equal(detail.crmSummary.conflicts.every((item) => item.winningProvenance === 'operator'), true);
  assert.equal(JSON.stringify(detail.crmSummary).includes('nope'), false);
});

test('detail URL projection rejects credentials controls and schemes, dedupes canonical listings, and keeps non-listing URLs categorized', async (t) => {
  // Break caught: URL normalization accepts controls/credentials or promotes a
  // prospectus/business website into an original-listing link.
  const { storage, opportunityId } = await detailStorage(t);
  const hostile = new Proxy(storage, {
    get(target, property) {
      if (property === 'getCurrentDealHunterOpportunityScore') return async () => ({ ...currentScore(opportunityId), listing_url: 'https://broker.example/a/../listing' });
      if (property === 'listDealHunterScoreEvidence') return async () => [{ listing_url: 'https://user:pass@broker.example/private', value: 'evidence', terms: [], dimension: null }];
      if (property === 'listDealHunterOpportunitySourceObservations') return async () => [
        { source_id: 'a', source_name: 'A', source_record_id: '1', field: 'listing_url', value: 'https://broker.example/listing', observed_at: '2026-08-30T10:00:00Z' },
        { source_id: 'b', source_name: 'B', source_record_id: '2', field: 'listing_url', value: 'https://user:pass@broker.example/private', observed_at: '2026-08-30T10:00:00Z' },
        { source_id: 'c', source_name: 'C', source_record_id: '3', field: 'listing_url', value: 'https://broker.example/new\nline', observed_at: '2026-08-30T10:00:00Z' },
        { source_id: 'd', source_name: 'D', source_record_id: '4', field: 'listing_url', value: 'ftp://broker.example/listing', observed_at: '2026-08-30T10:00:00Z' },
        { source_id: 'e', source_name: 'E', source_record_id: '5', field: 'prospectus_url', value: 'https://broker.example/prospectus.pdf', observed_at: '2026-08-30T10:00:00Z' },
        { source_id: 'f', source_name: 'F', source_record_id: '6', field: 'business_website', value: 'https://business.example/', observed_at: '2026-08-30T10:00:00Z' },
      ];
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
  assert.deepEqual(detail.listingUrls, ['https://broker.example/listing']);
  assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '5').values.prospectus_url, 'https://broker.example/prospectus.pdf');
  assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '6').values.business_website, 'https://business.example/');
  assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '2').values.listing_url, '');
  assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '3').values.listing_url, '');
  assert.equal(detail.score.unattributedEvidence[0].listingUrl, '');
});
