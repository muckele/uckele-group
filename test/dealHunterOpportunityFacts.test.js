import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  getEffectiveOpportunityFacts,
  normalizeOpportunityFactField,
  setOperatorOpportunityFact,
} from '../server/services/dealHunterOpportunityFacts.js';
import {
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  getCanonicalOpportunityMergeApproval,
} from '../server/repairs/canonicalOpportunityMerge.js';

const supabaseModule = await import('../server/storage/supabase.js');

const opportunityId = 'opp-facts-1';

function factRecord(overrides = {}) {
  return {
    id: 'fact-seller-verified',
    opportunity_id: opportunityId,
    field: 'seller_name',
    value: 'Verified Seller',
    source: 'operator',
    verified: true,
    actor: 'acquisition-admin',
    note: 'Confirmed during diligence call.',
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
    ...overrides,
  };
}

function observationRecord(overrides = {}) {
  return {
    id: 'sheet:row-42:seller_name',
    opportunity_id: opportunityId,
    source_id: 'deal-hunter-sheet',
    source_name: 'Deal Hunter Google Sheet',
    source_record_id: 'row-42',
    field: 'seller_name',
    value: 'Source Refresh Seller',
    observed_at: '2026-08-30T12:30:00.000Z',
    created_at: '2026-08-30T12:30:00.000Z',
    updated_at: '2026-08-30T12:30:00.000Z',
    ...overrides,
  };
}

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-opportunity-facts-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'facts.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedOpportunity(storage, id = opportunityId) {
  await storage.upsertDealHunterOpportunity({
    opportunity_id: id,
    created_at: '2026-08-30T11:00:00.000Z',
    updated_at: '2026-08-30T11:00:00.000Z',
    canonical_name: 'Facts Test Services',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'facts-test-v1',
    status: 'active',
    metadata: {},
  });
}

function supabaseChain({ facts = [], observations = [] } = {}) {
  const calls = [];
  const chainFor = (table) => {
    let payload = null;
    const rows = table === 'deal_hunter_opportunity_facts' ? facts : observations;
    const chain = {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      upsert(value, options) {
        payload = value;
        calls.push({ table, value, options });
        return this;
      },
      single() {
        return Promise.resolve({ data: payload, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };
  return { client: { from: chainFor }, calls };
}

test('verified operator facts survive a structured-source refresh', async (t) => {
  // Break caught: a source refresh mutates or takes precedence over a verified operator fact.
  const storage = withStorage(t);
  await seedOpportunity(storage);

  await setOperatorOpportunityFact({
    opportunityId,
    field: 'seller_name',
    value: 'Verified Seller',
    actor: 'acquisition-admin',
    verified: true,
    note: 'Confirmed during diligence call.',
    storage,
  });
  await storage.upsertDealHunterOpportunitySourceObservation(observationRecord());

  const operatorFacts = await storage.listDealHunterOpportunityFacts(opportunityId);
  const sourceFacts = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.equal(operatorFacts.length, 1);
  assert.equal(operatorFacts[0].value, 'Verified Seller');
  assert.deepEqual(getEffectiveOpportunityFacts({ opportunityId, operatorFacts, crmFacts: [], sourceFacts }), {
    seller_name: {
      value: 'Verified Seller',
      provenance: 'operator',
      verified: true,
      actor: 'acquisition-admin',
      note: 'Confirmed during diligence call.',
    },
  });
});

test('effective facts use operator, CRM, structured-source, then enrichment-suggestion precedence', () => {
  // Break caught: a lower-authority source wins when the same field is present at multiple authority levels.
  const effective = getEffectiveOpportunityFacts({
    opportunityId,
    operatorFacts: [factRecord()],
    crmFacts: [
      { field: 'seller_name', value: 'CRM Seller' },
      { field: 'broker_name', value: 'CRM Broker' },
    ],
    sourceFacts: [
      { field: 'seller_name', value: 'Structured Seller' },
      { field: 'broker_name', value: 'Structured Broker' },
      { field: 'reason_for_sale', value: 'Structured retirement' },
      { field: 'seller_financing', value: 'Structured unknown' },
      { field: 'seller_financing', value: 'Suggested financing', suggestion: true },
      { field: 'management_structure', value: 'Suggested management', suggestion: true },
    ],
  });

  assert.deepEqual(effective, {
    seller_name: { value: 'Verified Seller', provenance: 'operator', verified: true, actor: 'acquisition-admin', note: 'Confirmed during diligence call.' },
    broker_name: { value: 'CRM Broker', provenance: 'crm', verified: false, actor: null, note: null },
    reason_for_sale: { value: 'Structured retirement', provenance: 'structured-source', verified: false, actor: null, note: null },
    seller_financing: { value: 'Structured unknown', provenance: 'structured-source', verified: false, actor: null, note: null },
    management_structure: { value: 'Suggested management', provenance: 'enrichment-suggestion', verified: false, actor: null, note: null },
  });
});

test('enrichment suggestions cannot overwrite a verified operator fact', () => {
  // Break caught: a future enrichment suggestion replaces a verified operator value.
  const effective = getEffectiveOpportunityFacts({
    opportunityId,
    operatorFacts: [factRecord({ field: 'broker_email', value: 'verified@example.test' })],
    crmFacts: [],
    sourceFacts: [{ field: 'broker_email', value: 'suggested@example.test', suggestion: true }],
  });

  assert.deepEqual(effective.broker_email, {
    value: 'verified@example.test',
    provenance: 'operator',
    verified: true,
    actor: 'acquisition-admin',
    note: 'Confirmed during diligence call.',
  });
});

test('malformed or unsupported operator fact fields reject before persistence', async () => {
  // Break caught: a caller can persist an unapproved field identifier or a malformed fact payload.
  assert.equal(normalizeOpportunityFactField(' Seller Name '), 'seller_name');
  assert.throws(() => normalizeOpportunityFactField('seller_names'), /Unsupported opportunity fact field/);
  assert.throws(() => normalizeOpportunityFactField('seller\u0000name'), /Unsupported opportunity fact field/);
  await assert.rejects(
    setOperatorOpportunityFact({
      opportunityId,
      field: 'broker_name',
      value: { raw: 'blob' },
      actor: 'acquisition-admin',
      verified: true,
      storage: { upsertDealHunterOpportunityFact: async () => null },
    }),
    /plain text, number, or boolean/,
  );
});

test('SQLite and Supabase adapters expose matching fact and source-observation shapes', async (t) => {
  // Break caught: one provider serializes booleans, names, or bounded columns differently from the other.
  const storage = withStorage(t);
  await seedOpportunity(storage);
  const fact = factRecord();
  const observation = observationRecord();
  await storage.upsertDealHunterOpportunityFact(fact);
  await storage.upsertDealHunterOpportunitySourceObservation(observation);

  const sqliteFacts = await storage.listDealHunterOpportunityFacts(opportunityId);
  const sqliteObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const chain = supabaseChain({ facts: [fact], observations: [observation] });
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: chain.client },
  );
  const supabaseFacts = await supabase.listDealHunterOpportunityFacts(opportunityId);
  const supabaseObservations = await supabase.listDealHunterOpportunitySourceObservations(opportunityId);
  await supabase.upsertDealHunterOpportunityFact(fact);
  await supabase.upsertDealHunterOpportunitySourceObservation(observation);

  assert.deepEqual(sqliteFacts, [fact]);
  assert.deepEqual(supabaseFacts, sqliteFacts);
  assert.deepEqual(sqliteObservations, [observation]);
  assert.deepEqual(supabaseObservations, sqliteObservations);
  assert.deepEqual(chain.calls, [
    { table: 'deal_hunter_opportunity_facts', value: fact, options: { onConflict: 'id' } },
    {
      table: 'deal_hunter_opportunity_source_observations',
      value: observation,
      options: { onConflict: 'opportunity_id,source_id,source_record_id,field' },
    },
  ]);
});

test('operator-fact history remains queryable after a corrected value is recorded', async (t) => {
  // Break caught: upserting a correction destroys the older operator fact instead of retaining audit history.
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'fact-seller-initial',
    value: 'Initial Seller',
    created_at: '2026-08-30T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
  }));
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'fact-seller-corrected',
    value: 'Corrected Seller',
    created_at: '2026-08-30T11:00:00.000Z',
    updated_at: '2026-08-30T11:00:00.000Z',
  }));

  assert.deepEqual(
    (await storage.listDealHunterOpportunityFacts(opportunityId)).map((fact) => ({ id: fact.id, value: fact.value })),
    [
      { id: 'fact-seller-corrected', value: 'Corrected Seller' },
      { id: 'fact-seller-initial', value: 'Initial Seller' },
    ],
  );
});

test('canonical-merge inspection classifies and preserves opportunity-owned facts and observations', async (t) => {
  // Break caught: a canonical merge treats either durable projection as unknown
  // schema or ignores its rows while deciding whether a merge is safe.
  const storage = withStorage(t);
  const approval = getCanonicalOpportunityMergeApproval({
    exceptionId: '8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571',
    survivorId: 'opp_cd57a315-feaf-4158-a02e-4bdde97a922e',
    supersededId: 'opp_c92d0c73-6a47-4fed-b528-6f310745e448',
  });
  for (const id of [approval.survivorId, approval.supersededId]) {
    await storage.upsertDealHunterOpportunity({
      opportunity_id: id,
      created_at: '2026-08-21T15:00:29.815Z',
      updated_at: '2026-08-26T19:00:00.000Z',
      canonical_name: approval.approvedFacts.canonicalName,
      canonical_recipient: 'broker@example.test',
      canonical_location: approval.approvedFacts.canonicalLocation,
      primary_submission_id: null,
      identity_version: approval.expectedEvidenceVersion,
      status: approval.expectedOpportunityStatus,
      metadata: {
        identitySnapshot: {
          name: approval.approvedFacts.identityName,
          description: 'x'.repeat(approval.approvedFacts.identityDescriptionLength),
          recipient: 'broker@example.test',
          location: approval.approvedFacts.canonicalLocation.toLowerCase(),
          city: approval.approvedFacts.city,
          county: approval.approvedFacts.county,
          state: approval.approvedFacts.state,
          country: approval.approvedFacts.country,
          askingPrice: approval.approvedFacts.askingPrice,
          revenue: approval.approvedFacts.revenue,
          profit: approval.approvedFacts.profit,
          sourceIds: ['sheet 0'],
          listingIds: approval.approvedFacts.listingIds,
          listingUrl: approval.approvedFacts.listingUrl,
        },
      },
    });
  }
  for (const [index, alias] of approval.expectedAliases.entries()) {
    await storage.upsertDealHunterOpportunityAlias({
      id: `merge-guard-alias-${index}`,
      opportunity_id: alias.opportunityId,
      alias_type: alias.aliasType,
      alias_value: alias.aliasValue,
      alias_key: alias.aliasKey,
      source: 'merge-guard-test',
      first_observed_at: '2026-08-21T15:00:29.815Z',
      last_observed_at: '2026-08-26T19:00:00.000Z',
      evidence_version: approval.expectedEvidenceVersion,
      resolution_method: 'exact-alias',
      confidence_state: 'exact',
      resolved_by: 'deal-hunter-review',
      metadata: {},
    });
  }
  await storage.upsertDealHunterIdentityException({
    id: approval.exceptionId,
    created_at: '2026-08-21T15:00:29.815Z',
    updated_at: '2026-08-26T19:00:00.000Z',
    status: approval.expectedExceptionStatus,
    observed_deal_key: null,
    observed_name: approval.approvedFacts.canonicalName,
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: [approval.supersededId, approval.survivorId],
    reason: approval.expectedExceptionReason,
    evidence_version: approval.expectedEvidenceVersion,
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: {},
  });
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'merge-guard-fact',
    opportunity_id: approval.survivorId,
  }));
  await storage.upsertDealHunterOpportunitySourceObservation(observationRecord({
    id: 'merge-guard-observation',
    opportunity_id: approval.survivorId,
  }));

  const inventory = new Map(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries
    .map((entry) => [`${entry.table}.${entry.column}`, entry]));
  assert.equal(
    inventory.get('deal_hunter_opportunity_facts.opportunity_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
  );
  assert.equal(
    inventory.get('deal_hunter_opportunity_source_observations.opportunity_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
  );
  assert.equal(
    inventory.get('deal_hunter_opportunity_source_observations.source_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
  );

  await assert.rejects(
    storage.inspectDealHunterCanonicalOpportunityMerge({
      approval,
      actor: 'acquisition-admin',
      reason: 'Verify durable fact projections block a canonical merge.',
    }),
    /unexpected dependent state: operatorFacts, sourceObservations/,
  );
  assert.deepEqual((await storage.listDealHunterOpportunityFacts(approval.survivorId)).map((fact) => fact.id), ['merge-guard-fact']);
  assert.deepEqual(
    (await storage.listDealHunterOpportunitySourceObservations(approval.survivorId)).map((observation) => observation.id),
    ['merge-guard-observation'],
  );
});
