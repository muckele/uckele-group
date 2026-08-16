import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { fullRebuildConfirmation, refreshOpportunityScores, requestOpportunityScoreRefresh } =
  await import('../server/services/dealHunterScoreStore.js');
const { createManualSubmission } = await import('../server/services/submissions.js');

function scoredDeal(overrides = {}) {
  const deal = {
    id: 'source-1',
    opportunityId: 'opp-refresh-1',
    identityStatus: 'resolved',
    dealKey: 'deal-refresh-1',
    name: 'Commercial Fire Safety Inspection Co',
    industry: 'Fire safety inspection',
    description: 'Recurring maintenance contracts and service agreements with commercial customers on scheduled preventive maintenance.',
    city: 'Springfield',
    county: '',
    state: 'NY',
    country: 'USA',
    location: 'Springfield, NY',
    annualProfit: 450000,
    annualRevenue: 1800000,
    askingPrice: 1300000,
    profitMultiple: 2.9,
    yearsEstablished: 14,
    fiveYearsFlag: 'Yes',
    remoteFlag: '',
    franchiseFlag: '',
    brokerName: 'Broker',
    brokerEmail: 'broker@example.invalid',
    brokerContact: '',
    listingUrl: 'https://listings.example.invalid/opp-refresh-1',
    sourceId: 'deal-os-export',
    sourceName: 'Deal OS',
    dateAdded: '2026-01-05',
    lastUpdated: '2026-01-06',
    ...overrides,
  };
  deal.fullText = [
    deal.name, deal.industry, deal.description, deal.city, deal.county, deal.state, deal.remoteFlag, deal.franchiseFlag,
  ].join(' ').replace(/\s+/g, ' ').trim();
  return deal;
}

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-score-refresh-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'refresh.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedOpportunity(storage, opportunityId, primarySubmissionId = null) {
  const now = '2026-08-16T10:00:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: now,
    updated_at: now,
    canonical_name: opportunityId,
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: primarySubmissionId,
    identity_version: 'refresh-test-v1',
    status: 'active',
    metadata: {},
  });
}

test('the first refresh scores and persists evidence, and a repeat refresh writes nothing', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  const deals = [scoredDeal()];

  const first = await refreshOpportunityScores({ deals, storage });
  assert.equal(first.ok, true);
  assert.deepEqual(first.counts, { considered: 1, scored: 1, skipped: 0, failed: 0 });

  const stored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.ok(stored.fit_score > 0);
  assert.ok((await storage.listDealHunterScoreEvidence('opp-refresh-1')).length > 0);

  // A second pass over identical inputs must not write a row, replace evidence,
  // or emit an event.
  let writes = 0;
  const realWrite = storage.writeDealHunterOpportunityScore.bind(storage);
  storage.writeDealHunterOpportunityScore = async (...args) => { writes += 1; return realWrite(...args); };

  const second = await refreshOpportunityScores({ deals, storage });
  assert.equal(second.ok, true);
  assert.deepEqual(second.counts, { considered: 1, scored: 0, skipped: 1, failed: 0 });
  assert.equal(writes, 0, 'an unchanged opportunity must not be rewritten');

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.scored_at, stored.scored_at, 'scored_at must not churn on a no-op refresh');
});

test('a material source change rescores and replaces evidence atomically', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const before = await storage.getDealHunterOpportunityScore('opp-refresh-1');

  const changed = await refreshOpportunityScores({
    deals: [scoredDeal({ annualProfit: 120000, annualRevenue: 400000 })],
    storage,
  });
  assert.deepEqual(changed.counts, { considered: 1, scored: 1, skipped: 0, failed: 0 });

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.notEqual(after.score_fingerprint, before.score_fingerprint);
  assert.notEqual(after.fit_score, before.fit_score);

  const evidence = await storage.listDealHunterScoreEvidence('opp-refresh-1');
  assert.ok(evidence.length > 0);
  assert.equal(
    evidence.every((row) => row.score_fingerprint === after.score_fingerprint),
    true,
    'evidence must never describe a superseded fingerprint',
  );
});

test('volatile bookkeeping alone does not trigger a rescore', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  const noisy = await refreshOpportunityScores({
    deals: [scoredDeal({
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-08-16T00:00:00.000Z',
      isNew: true,
      netMargin: 91,
      dateAdded: '2026-08-01',
      lastUpdated: '2026-08-16',
    })],
    storage,
  });
  assert.deepEqual(noisy.counts, { considered: 1, scored: 0, skipped: 1, failed: 0 });
});

test('operator decisions survive rescoring, forced refresh, and retries', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1',
    priority: 'urgent',
    note: 'Confirmed the contract base with the broker.',
    reviewed: true,
    reviewedBy: 'owner@example.invalid',
    reviewedFingerprint: (await storage.getDealHunterOpportunityScore('opp-refresh-1')).score_fingerprint,
  });

  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 500000 })], storage });
  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 500000 })], storage, force: true });
  await refreshOpportunityScores({ deals: [scoredDeal({ askingPrice: 2600000 })], storage });

  const stored = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(stored.operator_priority, 'urgent');
  assert.equal(stored.operator_note, 'Confirmed the contract base with the broker.');
  assert.equal(stored.reviewed_by, 'owner@example.invalid');
  assert.equal(stored.changed_since_review, true, 'the operator should see that the machine judgment moved');
});

test('a forced refresh over unchanged inputs rewrites without claiming a change', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const before = await storage.getDealHunterOpportunityScore('opp-refresh-1');

  await storage.setDealHunterOpportunityOperatorDecision({
    opportunityId: 'opp-refresh-1', reviewed: true, reviewedBy: 'admin', reviewedFingerprint: before.score_fingerprint,
  });

  const forced = await refreshOpportunityScores({ deals: [scoredDeal()], storage, force: true });
  assert.deepEqual(forced.counts, { considered: 1, scored: 1, skipped: 0, failed: 0 });

  const after = await storage.getDealHunterOpportunityScore('opp-refresh-1');
  assert.equal(after.score_fingerprint, before.score_fingerprint);
  assert.equal(after.changed_since_review, false, 'a forced rewrite of identical inputs is not a change');
});

test('a failed opportunity is reported without stopping the batch, and a retry resumes it', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await seedOpportunity(storage, 'opp-refresh-2');
  const deals = [
    scoredDeal(),
    scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2', name: 'Second Synthetic Co' }),
  ];

  const realWrite = storage.writeDealHunterOpportunityScore.bind(storage);
  let injected = 0;
  storage.writeDealHunterOpportunityScore = async (score, evidence) => {
    if (score.opportunity_id === 'opp-refresh-2' && injected === 0) {
      injected += 1;
      throw new Error('injected transient score write failure');
    }
    return realWrite(score, evidence);
  };

  const partial = await refreshOpportunityScores({ deals, storage });
  assert.equal(partial.ok, false);
  assert.equal(partial.status, 207);
  assert.deepEqual(partial.counts, { considered: 2, scored: 1, skipped: 0, failed: 1 });
  assert.equal(partial.errors[0].opportunityId, 'opp-refresh-2');
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-1'));
  assert.equal(await storage.getDealHunterOpportunityScore('opp-refresh-2'), null);

  // The retry redoes only the opportunity that did not land.
  const retry = await refreshOpportunityScores({ deals, storage });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.counts, { considered: 2, scored: 1, skipped: 1, failed: 0 });
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-2'));
});

test('refresh can be scoped to specific opportunities', async (t) => {
  const storage = withStorage(t);
  await seedOpportunity(storage, 'opp-refresh-1');
  await seedOpportunity(storage, 'opp-refresh-2');
  const deals = [
    scoredDeal(),
    scoredDeal({ opportunityId: 'opp-refresh-2', dealKey: 'deal-refresh-2', id: 'source-2' }),
  ];

  const scoped = await refreshOpportunityScores({ deals, opportunityIds: ['opp-refresh-2'], storage });
  assert.deepEqual(scoped.counts, { considered: 1, scored: 1, skipped: 0, failed: 0 });
  assert.equal(await storage.getDealHunterOpportunityScore('opp-refresh-1'), null);
  assert.ok(await storage.getDealHunterOpportunityScore('opp-refresh-2'));
});

test('unresolved canonical identities are never scored into the queue', async (t) => {
  const storage = withStorage(t);
  const result = await refreshOpportunityScores({
    deals: [scoredDeal({ identityStatus: 'ambiguous' }), scoredDeal({ opportunityId: '', identityStatus: 'unavailable' })],
    storage,
  });
  assert.deepEqual(result.counts, { considered: 0, scored: 0, skipped: 0, failed: 0 });
});

test('a rescore emits one activity event only when the score actually moved', async (t) => {
  const storage = withStorage(t);
  const created = await createManualSubmission({
    name: 'Broker',
    email: 'broker@example.invalid',
    company: 'Commercial Fire Safety Inspection Co',
    message: 'Seed CRM record for the rescore activity event test.',
  }, 'admin', { storage });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const submission = created.submission;
  await seedOpportunity(storage, 'opp-refresh-1', submission.id);

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const afterFirst = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  const firstRescores = afterFirst.filter((event) => event.event_type === 'opportunity.rescored');
  assert.equal(firstRescores.length, 1);
  assert.equal(firstRescores[0].metadata.previousScore, null);

  await refreshOpportunityScores({ deals: [scoredDeal()], storage });
  const afterNoop = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  assert.equal(
    afterNoop.filter((event) => event.event_type === 'opportunity.rescored').length,
    1,
    'a fingerprint-identical refresh must not emit a rescore event',
  );

  await refreshOpportunityScores({ deals: [scoredDeal({ annualProfit: 120000 })], storage });
  const afterChange = await storage.listCrmActivityEvents({ submissionId: submission.id, limit: 50 });
  const rescores = afterChange.filter((event) => event.event_type === 'opportunity.rescored');
  assert.equal(rescores.length, 2);
  const latest = rescores[0];
  assert.equal(typeof latest.metadata.previousScore, 'number');
  assert.notEqual(latest.metadata.previousFingerprint, latest.metadata.fingerprint);
  assert.ok(Array.isArray(latest.metadata.dimensionChanges));
  assert.ok(latest.metadata.dimensionChanges.some((change) => change.dimension === 'financial-fit'));
});

test('a full forced rebuild requires the typed confirmation', async (t) => {
  const storage = withStorage(t);
  const rejected = await requestOpportunityScoreRefresh({ force: true, confirmation: 'nope', storage });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
  assert.match(rejected.error, /REBUILD ALL SCORES/);

  // A scoped forced refresh is bounded and needs no confirmation.
  await seedOpportunity(storage, 'opp-refresh-1');
  const scoped = await requestOpportunityScoreRefresh({
    force: true, opportunityIds: ['opp-refresh-1'], requestedBy: 'admin', storage,
  });
  assert.notEqual(scoped.status, 400);
  assert.equal(fullRebuildConfirmation, 'REBUILD ALL SCORES');
});

test('scoring reports unavailable storage instead of failing opaquely', async () => {
  const result = await refreshOpportunityScores({ deals: [scoredDeal()], storage: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.ok(result.missingMethods.includes('writeDealHunterOpportunityScore'));
});
