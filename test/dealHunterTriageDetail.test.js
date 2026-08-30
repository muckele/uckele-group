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
