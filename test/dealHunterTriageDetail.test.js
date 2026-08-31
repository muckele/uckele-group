import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setOperatorOpportunityFact } from '../server/services/dealHunterOpportunityFacts.js';
import { getTriageOpportunityDetail } from '../server/services/dealHunterTriage.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

// These response contracts are deliberately independent literals. Importing
// either production allowlist would let implementation and proof widen together.
const approvedPhase1FactFields = Object.freeze([
  'seller_name',
  'seller_email',
  'seller_phone',
  'broker_name',
  'broker_company',
  'broker_email',
  'broker_phone',
  'reason_for_sale',
  'real_estate_included',
  'seller_financing',
  'management_structure',
  'customer_concentration',
  'operator_contact_notes',
]);

const approvedSourceObservationFields = Object.freeze([
  'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
  'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
  'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact',
  'broker_email', 'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone',
  'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure',
  'customer_concentration', 'operator_contact_notes', 'listing_url', 'listing_source', 'listing_id',
  'deal_key', 'source_identity', 'date_added', 'last_updated', 'business_website', 'prospectus_url',
  'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age', 'sba_eligible', 'lead_type',
]);

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

test('detail reads a phone-like legacy broker_contact without relabeling its source observation', async (t) => {
  // Break caught: legacy durable source rows either remain invisible to the
  // Broker & Seller fact model or are rewritten as if their original source
  // field had been broker_phone.
  const { storage, opportunityId } = await detailStorage(t);
  await storage.upsertDealHunterOpportunitySourceObservation({
    id: 'legacy-broker-contact-phone', opportunity_id: opportunityId,
    source_id: 'legacy-sheet', source_name: 'Legacy Deal Hunter Sheet', source_record_id: 'row-42',
    field: 'broker_contact', value: '555-1212',
    observed_at: '2026-08-30T10:00:00.000Z', created_at: '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z',
  });

  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  const legacySource = detail.sourceObservations.find((source) => source.sourceId === 'legacy-sheet');
  assert.deepEqual({
    sourceFieldValue: legacySource?.values.broker_contact,
    sourceWasRelabeled: Object.hasOwn(legacySource?.values || {}, 'broker_phone'),
    effectiveBrokerPhone: detail.effectiveFacts.broker_phone,
    brokerPhoneMissing: detail.missingCriticalFields.includes('broker_phone'),
  }, {
    sourceFieldValue: '555-1212',
    sourceWasRelabeled: false,
    effectiveBrokerPhone: {
      value: '555-1212', provenance: 'structured-source', verified: false, actor: null, note: null,
    },
    brokerPhoneMissing: false,
  });
});

test('detail keeps date-like and ZIP-plus-four legacy broker_contact generic and marks broker_phone missing', async (t) => {
  // Break caught: loose legacy fallback promotion turns generic identifiers
  // into effective broker_phone facts and incorrectly clears the missing flag.
  const { storage, opportunityId } = await detailStorage(t);
  for (const [id, value] of [
    ['legacy-broker-contact-date', '2026-08-30'],
    ['legacy-broker-contact-zip', '12345-6789'],
  ]) {
    await storage.upsertDealHunterOpportunitySourceObservation({
      id, opportunity_id: opportunityId,
      source_id: id, source_name: 'Legacy Deal Hunter Sheet', source_record_id: id,
      field: 'broker_contact', value,
      observed_at: '2026-08-30T10:00:00.000Z', created_at: '2026-08-30T10:00:00.000Z', updated_at: '2026-08-30T10:00:00.000Z',
    });
  }

  const detail = await getTriageOpportunityDetail({ opportunityId, storage });
  assert.deepEqual(
    detail.sourceObservations
      .filter((source) => source.sourceName === 'Legacy Deal Hunter Sheet')
      .map((source) => ({
        sourceId: source.sourceId,
        brokerContact: source.values.broker_contact,
        hasBrokerPhone: Object.hasOwn(source.values, 'broker_phone'),
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    [
      { sourceId: 'legacy-broker-contact-date', brokerContact: '2026-08-30', hasBrokerPhone: false },
      { sourceId: 'legacy-broker-contact-zip', brokerContact: '12345-6789', hasBrokerPhone: false },
    ],
  );
  assert.equal(detail.effectiveFacts.broker_phone, undefined);
  assert.equal(detail.missingCriticalFields.includes('broker_phone'), true);
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
  // Breaks caught: widening either fact allowlist, raising/removing any detail
  // collection cap, dropping a scalar truncation, coercing an object/array into
  // a scalar, or spreading a raw provider row into the response.
  const { storage, opportunityId } = await detailStorage(t);
  const sentinel = 'DO-NOT-LEAK-DETAIL-SENTINEL';
  const overlong = 'x'.repeat(9000);
  const calls = {};
  const sourceConflictFields = [
    'seller_name',
    ...approvedSourceObservationFields.filter((field) => field !== 'seller_name'),
  ].slice(0, 21);
  const sourceRows = Array.from({ length: 101 }, (_, index) => {
    const fields = index < 2 ? sourceConflictFields : ['seller_name'];
    return [
      ...fields.map((field) => ({
        source_id: `source-${index}`,
        source_name: overlong,
        source_record_id: `record-${index}`,
        field,
        value: field === 'seller_name' ? `${index}-${overlong}` : `${field}-${index}-${overlong}`,
        observed_at: overlong,
        updated_at: overlong,
        metadata: { private: sentinel },
      })),
      {
        source_id: `source-${index}`,
        source_name: overlong,
        source_record_id: `record-${index}`,
        field: 'listing_url',
        value: `https://broker.example/source/${index}`,
        observed_at: overlong,
        updated_at: overlong,
        metadata: { private: sentinel },
      },
    ];
  }).flat();
  sourceRows.push(
    { source_id: { private: sentinel }, source_name: [sentinel], source_record_id: { private: sentinel }, field: 'secret_provider_metadata', value: { private: sentinel }, observed_at: [sentinel] },
    { source_id: 'object-source', source_name: 'Object source', source_record_id: 'object-record', field: { private: sentinel }, value: [sentinel], observed_at: { private: sentinel } },
  );
  const operatorRows = [
    ...Array.from({ length: 99 }, (_, index) => ({
      id: index === 0 ? overlong : `fact-${index}`,
      field: approvedPhase1FactFields[index % approvedPhase1FactFields.length],
      value: overlong,
      verified: index % 2,
      actor: overlong,
      note: overlong,
      created_at: overlong,
      updated_at: overlong,
      metadata: { private: sentinel },
    })),
    {
      id: 'unsupported-fact', field: 'secret_provider_fact', value: sentinel, verified: true,
      actor: sentinel, note: sentinel, created_at: overlong, updated_at: overlong,
    },
    ...Array.from({ length: 2 }, (_, offset) => ({
      id: `fact-${99 + offset}`,
      field: approvedPhase1FactFields[(99 + offset) % approvedPhase1FactFields.length],
      value: overlong,
      verified: true,
      actor: overlong,
      note: overlong,
      created_at: overlong,
      updated_at: overlong,
      metadata: { private: sentinel },
    })),
  ];
  const crmFactValues = {
    sellerName: `seller_name-${overlong}`,
    sellerEmail: `seller_email-${overlong}`,
    sellerPhone: `seller_phone-${overlong}`,
    brokerName: `broker_name-${overlong}`,
    brokerCompany: `broker_company-${overlong}`,
    brokerEmail: `broker_email-${overlong}`,
    brokerPhone: `broker_phone-${overlong}`,
    reasonForSale: `reason_for_sale-${overlong}`,
    realEstateIncluded: false,
    sellerFinancing: 0,
    managementStructure: `management_structure-${overlong}`,
    customerConcentration: `customer_concentration-${overlong}`,
    operatorContactNotes: `operator_contact_notes-${overlong}`,
  };
  const hostile = new Proxy(storage, {
    get(target, property) {
      if (property === 'getCurrentDealHunterOpportunityScore') return async () => ({
        ...currentScore(opportunityId),
        opportunity_id: { private: sentinel }, deal_key: overlong, name: overlong, state: overlong,
        industry: overlong, annual_profit: '123', annual_revenue: { private: sentinel }, asking_price: [sentinel], profit_multiple: '4.5',
        top_strength: overlong, top_concern: overlong, crm_status: overlong, cim_status: overlong,
        operator_priority: { private: sentinel }, operator_note: overlong, reviewed_at: { private: sentinel },
        reviewed_by: [sentinel], reviewed_fingerprint: { private: sentinel }, dismissed_reason: overlong,
        missing_evidence_count: 52, contradiction_count: 23, rules_version: overlong, scored_at: overlong,
        listing_url: 'https://broker.example/score',
        dimensions: Array.from({ length: 8 }, (_, index) => ({ id: `dimension-${index}`, label: overlong, contribution: index, private: sentinel })),
        gates: Array.from({ length: 51 }, (_, index) => ({ rule_id: `gate-${index}`, reason: overlong, cap: index, value: index, private: sentinel })),
        applied_caps: Array.from({ length: 51 }, (_, index) => ({ rule_id: `cap-${index}`, reason: overlong, cap: index, value: index, private: sentinel })),
        confidence_reasons: [...Array.from({ length: 51 }, () => overlong), { private: sentinel }],
        missing_evidence: [...Array.from({ length: 51 }, () => overlong), [sentinel]],
        summary: {
          strengths: [...Array.from({ length: 21 }, () => overlong), { private: sentinel }],
          concerns: [...Array.from({ length: 21 }, () => overlong), [sentinel]],
          private: sentinel,
        },
      });
      if (property === 'listDealHunterScoreEvidence') return async (...args) => {
        calls.evidence = args;
        const makeEvidence = (index, dimension, prefix) => ({
          dimension,
          rule_id: `${prefix}-${index}`,
          rule_label: index === 1 ? { private: sentinel } : overlong,
          evidence_class: index === 1 ? [sentinel] : overlong,
          field: index === 1 ? { private: sentinel } : overlong,
          value: index === 1 ? { private: sentinel } : overlong,
          observed_value: index === 1 ? [sentinel] : overlong,
          terms: [...Array.from({ length: 21 }, () => overlong), { private: sentinel }],
          source_id: index === 1 ? { private: sentinel } : overlong,
          source_name: index === 1 ? [sentinel] : overlong,
          source_record_id: index === 1 ? { private: sentinel } : overlong,
          listing_url: 'https://user:pass@broker.example/private',
          observed_at: index === 1 ? { private: sentinel } : overlong,
          metadata: { private: sentinel },
        });
        return [
          ...Array.from({ length: 101 }, (_, index) => makeEvidence(index, 'dimension-0', 'rule')),
          ...Array.from({ length: 101 }, (_, index) => makeEvidence(index, '', 'unattributed')),
        ];
      };
      if (property === 'listDealHunterOpportunitySourceObservations') return async (...args) => { calls.sources = args; return sourceRows; };
      if (property === 'listDealHunterOpportunityFacts') return async (...args) => { calls.facts = args; return operatorRows; };
      if (property === 'listDealHunterCimRequests') return async (...args) => {
        calls.cimRequests = args;
        return Array.from({ length: 101 }, (_, index) => ({ id: `cim-${index}`, status: overlong, request_state: sentinel, delivery_state: sentinel, provider: sentinel, reply_to: sentinel, metadata: { private: sentinel }, updated_at: overlong }));
      };
      if (property === 'listCrmActivityEvents') return async (...args) => {
        calls.activities = args;
        return Array.from({ length: 101 }, (_, index) => ({ id: `activity-${index}`, event_type: overlong, summary: overlong, created_at: overlong, actor: overlong, provider: sentinel, reply_to: sentinel, delivery_state: sentinel, metadata: { private: sentinel } }));
      };
      if (property === 'listDealHunterDispositions') return async (...args) => {
        calls.dispositions = args;
        return Array.from({ length: 21 }, (_, index) => ({ id: `disposition-${index}`, disposition: overlong, reason: overlong, note: overlong, dismissed_at: overlong, dismissed_by: overlong, provider: sentinel, reply_to: sentinel, delivery_state: sentinel, metadata: { private: sentinel } }));
      };
      if (property === 'listCrmCommunications') return async (...args) => {
        calls.communications = args;
        return { rows: Array.from({ length: 101 }, (_, index) => ({ id: `comm-${index}`, direction: overlong, channel: overlong, kind: overlong, occurred_at: overlong, cim_request_id: `cim-${index}`, provider: sentinel, reply_to: sentinel, delivery_state: sentinel, metadata: { private: sentinel } })) };
      };
      if (property === 'getSubmission') return async () => ({
        id: overlong,
        status: overlong,
        company: { private: sentinel },
        seller_name: { private: sentinel },
        seller_email: [sentinel],
        broker_name: { private: sentinel },
        broker_email: [sentinel],
        updated_at: overlong,
        provider: sentinel,
        reply_to: sentinel,
        delivery_state: sentinel,
        metadata: { private: sentinel, dealHunter: { ...crmFactValues, providerPrivate: sentinel } },
      });
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
  const assertRecordContract = (record, contract, label) => {
    assert.deepEqual(Object.keys(record).sort(), Object.keys(contract).sort(), `${label} has exact keys`);
    for (const [key, rule] of Object.entries(contract)) {
      const value = record[key];
      if (rule.nullable && value === null) continue;
      assert.equal(typeof value, rule.type, `${label}.${key} has ${rule.type} type`);
      if (rule.type === 'string') assert.ok(value.length <= rule.max, `${label}.${key} is at most ${rule.max} chars`);
    }
  };
  const text = (max) => ({ type: 'string', max });
  const number = { type: 'number' };
  const boolean = { type: 'boolean' };
  const nullableNumber = { type: 'number', nullable: true };
  const opportunityContract = {
    opportunityId: text(200), dealKey: text(200), name: text(500), state: text(40), listingUrl: text(2000),
    fitScore: number, scoreStatus: text(80), confidence: text(80), completenessScore: number,
    missingEvidenceCount: number, contradictionCount: number, shouldRemove: boolean, highFit: boolean,
    geography: { type: 'object' }, industry: text(240), financials: { type: 'object' }, topStrength: text(400),
    topConcern: text(400), workflow: { type: 'object' }, observationFreshness: text(80), operatorPriority: text(40),
    operatorNote: text(2000), reviewed: boolean, reviewedAt: text(80), reviewedBy: text(160),
    changedSinceReview: boolean, dismissed: boolean, dismissedReason: text(160), scoredAt: text(80),
    scoreFingerprint: text(200), rulesVersion: text(160),
  };
  const operatorFactContract = { id: text(200), field: text(80), value: text(4000), verified: boolean, actor: text(160), note: text(500), createdAt: text(80), updatedAt: text(80) };
  const evidenceContract = {
    ruleId: text(160), ruleLabel: text(160), evidenceClass: text(80), field: text(80), value: text(500),
    observedValue: text(500), terms: { type: 'object' }, sourceId: text(200), sourceName: text(160),
    sourceRecordId: text(200), listingUrl: text(2000), observedAt: text(80),
  };
  const communicationContract = { id: text(200), direction: text(80), channel: text(80), kind: text(80), occurredAt: text(80), cimRequestId: text(200) };
  assertRecordContract(detail.opportunity, opportunityContract, 'opportunity');
  assertRecordContract(detail.opportunity.geography, { city: text(160), state: text(40), label: text(240) }, 'opportunity.geography');
  assertRecordContract(detail.opportunity.financials, { annualProfit: nullableNumber, annualRevenue: nullableNumber, askingPrice: nullableNumber, profitMultiple: nullableNumber }, 'opportunity.financials');
  assertRecordContract(detail.opportunity.workflow, { crmStatus: text(80), cimStatus: text(80) }, 'opportunity.workflow');
  assert.equal(detail.opportunity.missingEvidenceCount, 52, 'persisted missing-evidence count remains exact');
  assert.equal(detail.opportunity.contradictionCount, 23, 'persisted contradiction count remains exact');

  assert.deepEqual(calls.evidence, [opportunityId, { limit: 500 }], 'evidence read is capped at 500');
  assert.deepEqual(calls.sources, [opportunityId, { limit: 500 }], 'source-observation read is capped at 500');
  assert.deepEqual(calls.facts, [opportunityId, { limit: 100 }], 'operator-fact read is capped at 100');
  assert.deepEqual(calls.cimRequests, [{ opportunityIds: [opportunityId], limit: 100 }], 'CIM request read is independently capped at 100');
  assert.deepEqual(calls.activities, [{ submissionId: 'submission-detail', limit: 100 }], 'CRM activity read is capped at 100');
  assert.equal(calls.dispositions.length, 1);
  assert.equal(calls.dispositions[0].limit, 20, 'disposition read is capped at 20');
  assert.equal(Array.isArray(calls.dispositions[0].dealKeys), true);
  assert.deepEqual(calls.communications, [{ submissionId: 'submission-detail', page: 1, pageSize: 100 }], 'CRM communication read is capped at 100');

  assert.deepEqual(Object.keys(detail.effectiveFacts).sort(), [...approvedPhase1FactFields].sort(), 'effective facts expose exactly the literal 13-field Phase 1 contract');
  for (const [field, fact] of Object.entries(detail.effectiveFacts)) {
    assert.ok(approvedPhase1FactFields.includes(field), `effective fact ${field} is approved`);
    assertRecordContract(fact, { value: text(4000), provenance: text(80), verified: boolean, actor: { ...text(200), nullable: true }, note: { ...text(500), nullable: true } }, `effectiveFacts.${field}`);
  }
  assert.equal(Object.hasOwn(detail.effectiveFacts, 'secret_provider_fact'), false, 'hostile provider fact cannot widen effective facts');
  assert.equal(detail.operatorFacts.length, 100, 'operator facts retain the literal 100-record cap');
  assert.equal(detail.operatorFacts.at(-1).id, 'fact-99', 'operator facts retain the deterministic first 100 approved records');
  assert.deepEqual([
    ...detail.operatorFacts.map(({ field }) => ({ container: 'operatorFacts', field })),
    ...detail.history.operatorFacts.map(({ field }) => ({ container: 'history.operatorFacts', field })),
  ].filter(({ field }) => !approvedPhase1FactFields.includes(field)), [], 'top-level and history operator facts reject hostile fields outside the literal Phase 1 contract');
  for (const fact of detail.operatorFacts) {
    assertRecordContract(fact, operatorFactContract, 'operator fact');
    assert.ok(approvedPhase1FactFields.includes(fact.field), `operator fact ${fact.field} is approved`);
  }

  assert.equal(detail.sourceObservations.length, 100, 'source groups retain the literal 100-group cap');
  assert.equal(detail.sourceObservations[0].sourceRecordId, 'record-0');
  assert.equal(detail.sourceObservations.at(-1).sourceRecordId, 'record-99');
  assert.equal(detail.sourceObservations.some((group) => group.sourceRecordId === 'record-100'), false, 'source group 101 is truncated');
  for (const group of detail.sourceObservations) {
    assertRecordContract(group, { sourceId: text(200), sourceName: text(160), sourceRecordId: text(200), observedAt: text(80), values: { type: 'object' }, conflicts: { type: 'object' } }, 'source group');
    for (const [field, value] of Object.entries(group.values)) {
      assert.ok(approvedSourceObservationFields.includes(field), `source value ${field} is approved`);
      assert.equal(typeof value, 'string', `source value ${field} is a string`);
      assert.ok(value.length <= (['listing_url', 'prospectus_url', 'business_website'].includes(field) ? 2000 : 5000), `source value ${field} is bounded`);
    }
    for (const conflict of group.conflicts) {
      assertRecordContract(conflict, { field: text(80), observations: { type: 'object' } }, 'source conflict');
      assert.ok(conflict.observations.length <= 20, 'conflict observations retain the 20-record cap');
      for (const observation of conflict.observations) {
        assertRecordContract(observation, { sourceId: text(200), sourceName: text(160), sourceRecordId: text(200), value: text(5000), observedAt: text(80) }, 'conflict observation');
      }
    }
  }
  assert.equal(detail.sourceObservations[0].conflicts.length, 20, 'conflicts per source group retain the literal 20-field cap');
  assert.deepEqual(detail.sourceObservations[0].conflicts.map(({ field }) => field), sourceConflictFields.slice(0, 20), 'conflict truncation retains the first 20 fields');
  const sellerConflict = detail.sourceObservations[0].conflicts.find(({ field }) => field === 'seller_name');
  assert.equal(sellerConflict.observations.length, 20, 'conflict observations retain the literal 20-record cap');
  assert.deepEqual(sellerConflict.observations.map(({ sourceRecordId }) => sourceRecordId), Array.from({ length: 20 }, (_, index) => `record-${index}`), 'conflict truncation retains this group and the first 19 peers');

  assert.equal(detail.listingUrls.length, 100, 'listing URLs retain the literal 100-URL cap');
  assert.equal(detail.listingUrls[0], 'https://broker.example/score');
  assert.equal(detail.listingUrls.at(-1), 'https://broker.example/source/98');
  assert.equal(detail.listingUrls.includes('https://broker.example/source/99'), false, 'listing URL 101 is truncated');
  for (const url of detail.listingUrls) { assert.equal(typeof url, 'string'); assert.ok(url.length <= 2000); }

  assertRecordContract(detail.score, {
    fitScore: number, scoreStatus: text(80), confidence: text(80), completenessScore: number,
    dimensions: { type: 'object' }, unattributedEvidence: { type: 'object' }, appliedCaps: { type: 'object' },
    gates: { type: 'object' }, confidenceReasons: { type: 'object' }, missingEvidence: { type: 'object' }, summary: { type: 'object' },
  }, 'score');
  assert.equal(detail.score.dimensions.length, 7, 'score dimensions retain the literal seven-dimension cap');
  assert.deepEqual(detail.score.dimensions.map(({ id }) => id), Array.from({ length: 7 }, (_, index) => `dimension-${index}`));
  for (const dimension of detail.score.dimensions) assertRecordContract(dimension, { id: text(80), label: text(160), contribution: number, evidence: { type: 'object' } }, 'score dimension');
  assert.equal(detail.score.dimensions[0].evidence.length, 100, 'dimension evidence retains the literal 100-record cap');
  assert.equal(detail.score.dimensions[0].evidence.at(-1).ruleId, 'rule-99');
  assert.equal(detail.score.unattributedEvidence.length, 100, 'unattributed evidence retains the literal 100-record cap');
  assert.equal(detail.score.unattributedEvidence.at(-1).ruleId, 'unattributed-99');
  for (const evidence of [...detail.score.dimensions[0].evidence, ...detail.score.unattributedEvidence]) {
    assertRecordContract(evidence, evidenceContract, 'score evidence');
    assert.equal(evidence.terms.length, 20, 'evidence terms retain the literal 20-item cap');
    for (const term of evidence.terms) { assert.equal(typeof term, 'string'); assert.ok(term.length <= 160); }
  }
  const ruleContract = { ruleId: text(160), reason: text(500), cap: number, value: number };
  for (const [name, prefix] of [['appliedCaps', 'cap'], ['gates', 'gate']]) {
    assert.equal(detail.score[name].length, 50, `${name} retains the literal 50-record cap`);
    assert.equal(detail.score[name].at(-1).ruleId, `${prefix}-49`);
    for (const rule of detail.score[name]) assertRecordContract(rule, ruleContract, `score.${name}`);
  }
  for (const name of ['confidenceReasons', 'missingEvidence']) {
    assert.equal(detail.score[name].length, 50, `${name} retains the literal 50-item cap`);
    for (const value of detail.score[name]) { assert.equal(typeof value, 'string'); assert.ok(value.length <= 500); }
  }
  assertRecordContract(detail.score.summary, { strengths: { type: 'object' }, concerns: { type: 'object' } }, 'score summary');
  for (const name of ['strengths', 'concerns']) {
    assert.equal(detail.score.summary[name].length, 20, `summary ${name} retains the literal 20-item cap`);
    for (const value of detail.score.summary[name]) { assert.equal(typeof value, 'string'); assert.ok(value.length <= 500); }
  }

  assertRecordContract(detail.cimSummary, { requests: { type: 'object' }, communications: { type: 'object' } }, 'CIM summary');
  assert.equal(detail.cimSummary.requests.length, 100, 'CIM requests retain the literal 100-record response cap');
  assert.equal(detail.cimSummary.requests.at(-1).id, 'cim-99', 'CIM request 101 is deterministically truncated');
  for (const request of detail.cimSummary.requests) assertRecordContract(request, { id: text(200), status: text(80), updatedAt: text(80) }, 'CIM request');
  assert.equal(detail.cimSummary.communications.length, 100, 'CIM communications retain the literal 100-record cap');
  assert.equal(detail.cimSummary.communications.at(-1).id, 'comm-99');
  for (const communication of detail.cimSummary.communications) assertRecordContract(communication, communicationContract, 'CIM communication');

  assertRecordContract(detail.crmSummary, { submission: { type: 'object' }, communications: { type: 'object' }, factObservations: { type: 'object' }, conflicts: { type: 'object' } }, 'CRM summary');
  assertRecordContract(detail.crmSummary.submission, { id: text(200), status: text(80), company: text(500), sellerName: text(500), sellerEmail: text(500), brokerName: text(500), brokerEmail: text(500), updatedAt: text(80) }, 'CRM submission');
  assert.equal(detail.crmSummary.communications.length, 100, 'CRM communications retain the literal 100-record cap');
  assert.equal(detail.crmSummary.communications.at(-1).id, 'comm-99');
  for (const communication of detail.crmSummary.communications) assertRecordContract(communication, communicationContract, 'CRM communication');
  assert.equal(detail.crmSummary.factObservations.length, 13, 'CRM facts retain the literal 13-field cap');
  assert.deepEqual(detail.crmSummary.factObservations.map(({ field }) => field).sort(), [...approvedPhase1FactFields].sort());
  for (const fact of detail.crmSummary.factObservations) assertRecordContract(fact, { field: text(80), value: text(4000), provenance: text(80) }, 'CRM fact observation');
  assert.equal(detail.crmSummary.conflicts.length, 13, 'CRM conflicts retain the literal 13-field cap');
  assert.deepEqual(detail.crmSummary.conflicts.map(({ field }) => field).sort(), [...approvedPhase1FactFields].sort());
  for (const conflict of detail.crmSummary.conflicts) assertRecordContract(conflict, { field: text(80), winningProvenance: text(80), crmValue: text(4000) }, 'CRM conflict');

  assertRecordContract(detail.history, { activities: { type: 'object' }, dispositions: { type: 'object' }, operatorFacts: { type: 'object' }, operatorState: { type: 'object' } }, 'history');
  assert.equal(detail.history.activities.length, 100, 'activities retain the literal 100-record cap');
  assert.equal(detail.history.activities.at(-1).id, 'activity-99');
  for (const activity of detail.history.activities) assertRecordContract(activity, { id: text(200), eventType: text(80), summary: text(500), createdAt: text(80), actor: text(160) }, 'activity');
  assert.equal(detail.history.dispositions.length, 20, 'dispositions retain the literal 20-record cap');
  assert.equal(detail.history.dispositions.at(-1).id, 'disposition-19');
  for (const disposition of detail.history.dispositions) assertRecordContract(disposition, { id: text(200), disposition: text(80), reason: text(160), note: text(500), dismissedAt: text(80), dismissedBy: text(160) }, 'disposition');
  assert.equal(detail.history.operatorFacts.length, 100, 'history operator facts retain the literal 100-record cap');
  assert.equal(detail.history.operatorFacts.at(-1).id, 'fact-99');
  for (const fact of detail.history.operatorFacts) {
    assertRecordContract(fact, operatorFactContract, 'history operator fact');
    assert.ok(approvedPhase1FactFields.includes(fact.field), `history operator fact ${fact.field} is approved`);
  }
  assertRecordContract(detail.history.operatorState, { priority: text(40), note: text(2000), reviewed: boolean, reviewedAt: text(80), reviewedBy: text(160) }, 'history operator state');

  assert.equal(JSON.stringify(detail).includes(sentinel), false, 'raw provider/storage metadata and hostile object/array values never cross the API boundary');
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

test('detail URL projection table-drives unsafe score and evidence URLs while retaining canonical listing categories', async (t) => {
  // Break caught: either score/evidence branch can return a credentialed,
  // control-character, or non-HTTP(S) link after source URLs stay safe.
  const { storage, opportunityId } = await detailStorage(t);
  const invalidUrls = [
    ['credentials', 'https://user:pass@broker.example/private'],
    ['ASCII control', 'https://broker.example/new\nline'],
    ['unsupported scheme', 'ftp://broker.example/listing'],
  ];
  const sourceRows = [
    // The first pair canonicalizes to the same link, proving dedupe remains
    // independent of the invalid score/evidence cases below.
    { source_id: 'a', source_name: 'A', source_record_id: '1', field: 'listing_url', value: 'https://broker.example/a/../listing', observed_at: '2026-08-30T10:00:00Z' },
    { source_id: 'b', source_name: 'B', source_record_id: '2', field: 'listing_url', value: 'https://broker.example/listing', observed_at: '2026-08-30T10:00:00Z' },
    { source_id: 'c', source_name: 'C', source_record_id: '3', field: 'prospectus_url', value: 'https://broker.example/prospectus.pdf', observed_at: '2026-08-30T10:00:00Z' },
    { source_id: 'd', source_name: 'D', source_record_id: '4', field: 'business_website', value: 'https://business.example/', observed_at: '2026-08-30T10:00:00Z' },
  ];
  for (const [kind, invalidUrl] of invalidUrls) {
    for (const [path, scoreUrl, evidenceUrl] of [
      ['score', invalidUrl, 'https://broker.example/a/../listing'],
      ['evidence', 'https://broker.example/a/../listing', invalidUrl],
    ]) {
      const hostile = new Proxy(storage, {
        get(target, property) {
          if (property === 'getCurrentDealHunterOpportunityScore') return async () => ({ ...currentScore(opportunityId), listing_url: scoreUrl });
          if (property === 'listDealHunterScoreEvidence') return async () => [{ listing_url: evidenceUrl, value: 'evidence', terms: [], dimension: 'financial-fit' }];
          if (property === 'listDealHunterOpportunitySourceObservations') return async () => sourceRows;
          const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const detail = await getTriageOpportunityDetail({ opportunityId, storage: hostile });
      assert.deepEqual(detail.listingUrls, ['https://broker.example/listing'], `${kind} ${path} preserves canonical source-listing dedupe`);
      assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '3').values.prospectus_url, 'https://broker.example/prospectus.pdf');
      assert.equal(detail.sourceObservations.find((item) => item.sourceRecordId === '4').values.business_website, 'https://business.example/');
      if (path === 'score') {
        assert.equal(detail.opportunity.listingUrl, '', `${kind} score listing is omitted from opportunity`);
        assert.equal(detail.listingUrls.includes(invalidUrl), false, `${kind} score listing is absent from listing URLs`);
      } else {
        assert.equal(detail.score.dimensions[0].evidence[0].listingUrl, '', `${kind} evidence listing is projected empty`);
      }
    }
  }
});
