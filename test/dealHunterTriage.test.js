import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');
const { getTriageOpportunityDetail, listTriageQueue, setTriageOperatorDecision } =
  await import('../server/services/dealHunterTriage.js');

function scoredDeal(id, overrides = {}) {
  const deal = {
    id: `source-${id}`,
    opportunityId: `opp-${id}`,
    identityStatus: 'resolved',
    dealKey: `deal-${id}`,
    name: `Synthetic Opportunity ${id}`,
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
    listingUrl: `https://listings.example.invalid/opp-${id}`,
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

async function seedOpportunity(storage, opportunityId) {
  const now = '2026-08-16T10:00:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: now,
    updated_at: now,
    canonical_name: opportunityId,
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'triage-test-v1',
    status: 'active',
    metadata: {},
  });
}

// A spread of listings that lands in different queue views.
async function seedQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-triage-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'triage.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const deals = [
    scoredDeal('high'),
    scoredDeal('watch', { annualProfit: 260000, annualRevenue: 900000, askingPrice: 900000, profitMultiple: 3.4 }),
    scoredDeal('sparse', {
      industry: '', description: '', annualRevenue: null, askingPrice: null, profitMultiple: null,
      brokerEmail: '', brokerName: '', yearsEstablished: null, fiveYearsFlag: '',
    }),
    scoredDeal('removed', { industry: 'Restaurant and catering', description: 'A restaurant serving food and beverage in a hospitality setting.' }),
    scoredDeal('dismissed'),
  ];
  for (const deal of deals) await seedOpportunity(storage, deal.opportunityId);
  const refreshed = await refreshOpportunityScores({ deals, storage });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed.errors));
  await storage.reconcileDealHunterCurrentScoreEligibility(deals.map((deal) => deal.opportunityId));

  await storage.upsertDealHunterDisposition({
    id: 'disposition-dismissed',
    deal_key: 'deal-dismissed',
    created_at: '2026-08-16T11:00:00.000Z',
    updated_at: '2026-08-16T11:00:00.000Z',
    disposition: 'dismissed',
    reason: 'not-a-fit',
    note: 'Outside the acquisition profile.',
    created_by: 'admin',
    updated_by: 'admin',
    metadata: {},
  });

  return storage;
}

test('the default queue shows unreviewed opportunities and excludes dismissed and removed ones', async (t) => {
  const storage = await seedQueue(t);
  const queue = await listTriageQueue({ storage });

  assert.equal(queue.ok, true);
  assert.equal(queue.view, 'needs-review');
  const ids = queue.rows.map((row) => row.opportunityId);
  assert.equal(ids.includes('opp-dismissed'), false, 'a dismissed opportunity never appears in a working view');
  assert.equal(ids.includes('opp-removed'), false, 'a gated listing is not offered as work');
  assert.ok(ids.includes('opp-high'));
  assert.ok(queue.rows.every((row) => row.reviewed === false));
});

test('rows carry fit and confidence as separate values with no blended score', async (t) => {
  const storage = await seedQueue(t);
  const queue = await listTriageQueue({ storage });
  const row = queue.rows.find((item) => item.opportunityId === 'opp-high');

  assert.equal(typeof row.fitScore, 'number');
  assert.ok(['low', 'medium', 'high'].includes(row.confidence));
  assert.equal(typeof row.completenessScore, 'number');
  assert.equal(row.dimensions.length, 7);
  assert.ok(row.dimensions.every((dimension) => typeof dimension.contribution === 'number' && dimension.verdict));
  assert.ok(row.topReasons.length > 0);
  assert.equal(Object.hasOwn(row, 'overallCertainty'), false, 'there is no blended certainty number');
  assert.equal(Object.hasOwn(row, 'operatorScoreOverride'), false, 'operators set priority, not a numeric override');
});

test('each view selects the right population', async (t) => {
  const storage = await seedQueue(t);

  const high = await listTriageQueue({ view: 'high-priority', storage });
  assert.ok(high.rows.every((row) => row.highFit || ['urgent', 'high'].includes(row.operatorPriority)));
  assert.ok(high.rows.some((row) => row.opportunityId === 'opp-high'));

  const watchlist = await listTriageQueue({ view: 'watchlist', storage });
  assert.ok(watchlist.rows.every((row) => (row.fitScore >= 60 && row.fitScore < 75) || row.operatorPriority === 'watch'));

  const lowConfidence = await listTriageQueue({ view: 'low-confidence', storage });
  assert.ok(lowConfidence.rows.every((row) => row.confidence === 'low' || row.contradictionCount > 0));
  assert.ok(lowConfidence.rows.some((row) => row.opportunityId === 'opp-sparse'));

  const dismissed = await listTriageQueue({ view: 'dismissed', storage });
  assert.deepEqual(dismissed.rows.map((row) => row.opportunityId), ['opp-dismissed']);
  assert.equal(dismissed.rows[0].dismissedReason, 'not-a-fit');
});

test('sorting and pagination are stable across pages', async (t) => {
  const storage = await seedQueue(t);
  const all = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  assert.ok(all.total >= 4);

  const scores = all.rows.map((row) => row.fitScore);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left), 'default sort is fit score descending');

  const first = await listTriageQueue({ view: 'all', pageSize: 2, page: 1, storage });
  const second = await listTriageQueue({ view: 'all', pageSize: 2, page: 2, storage });
  const third = await listTriageQueue({ view: 'all', pageSize: 2, page: 3, storage });
  const paged = [...first.rows, ...second.rows, ...third.rows].map((row) => row.opportunityId);
  assert.equal(new Set(paged).size, paged.length, 'no row appears on two pages');
  assert.deepEqual(paged.slice(0, all.rows.length), all.rows.map((row) => row.opportunityId));

  const ascending = await listTriageQueue({ view: 'all', pageSize: 100, direction: 'asc', storage });
  assert.deepEqual(
    ascending.rows.map((row) => row.fitScore),
    [...scores].sort((left, right) => left - right),
  );
});

test('search and filters narrow the queue', async (t) => {
  const storage = await seedQueue(t);

  const searched = await listTriageQueue({ view: 'all', search: 'Opportunity high', storage });
  assert.deepEqual(searched.rows.map((row) => row.opportunityId), ['opp-high']);

  const filtered = await listTriageQueue({ view: 'all', minScore: 75, storage });
  assert.ok(filtered.rows.every((row) => row.fitScore >= 75));

  const byState = await listTriageQueue({ view: 'all', state: 'ny', storage });
  assert.ok(byState.rows.length > 0);
  assert.ok(byState.rows.every((row) => row.state === 'NY'));

  const byConfidence = await listTriageQueue({ view: 'all', confidence: 'low', storage });
  assert.ok(byConfidence.rows.every((row) => row.confidence === 'low'));
});

test('marking reviewed clears needs-review until the score actually moves', async (t) => {
  const storage = await seedQueue(t);

  const before = await listTriageQueue({ storage });
  assert.ok(before.rows.some((row) => row.opportunityId === 'opp-high'));

  const decision = await setTriageOperatorDecision({
    opportunityId: 'opp-high', markReviewed: true, actor: 'owner@example.invalid', storage,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.opportunity.reviewed, true);
  assert.equal(decision.opportunity.changedSinceReview, false);

  const afterReview = await listTriageQueue({ storage });
  assert.equal(afterReview.rows.some((row) => row.opportunityId === 'opp-high'), false);

  // A no-op refresh must not drag it back into the queue.
  await refreshOpportunityScores({ deals: [scoredDeal('high')], storage });
  const afterNoop = await listTriageQueue({ storage });
  assert.equal(afterNoop.rows.some((row) => row.opportunityId === 'opp-high'), false);

  // A real change does.
  await refreshOpportunityScores({ deals: [scoredDeal('high', { annualProfit: 120000 })], storage });
  const afterChange = await listTriageQueue({ view: 'all', storage });
  const changed = afterChange.rows.find((row) => row.opportunityId === 'opp-high');
  assert.equal(changed.changedSinceReview, true);
  assert.equal(changed.reviewed, true, 'the earlier review is remembered, not erased');
});

test('operator priority is recorded without touching the machine score', async (t) => {
  const storage = await seedQueue(t);
  const before = await storage.getDealHunterOpportunityScore('opp-watch');

  const result = await setTriageOperatorDecision({
    opportunityId: 'opp-watch', priority: 'urgent', note: 'Broker call booked.', actor: 'owner@example.invalid', storage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.opportunity.operatorPriority, 'urgent');
  assert.equal(result.opportunity.operatorNote, 'Broker call booked.');
  assert.equal(result.opportunity.fitScore, before.fit_score, 'human priority does not rewrite the machine number');

  const highPriority = await listTriageQueue({ view: 'high-priority', storage });
  assert.ok(
    highPriority.rows.some((row) => row.opportunityId === 'opp-watch'),
    'an urgent operator priority promotes a mid-band listing into the working queue',
  );
});

test('invalid and empty operator decisions are rejected', async (t) => {
  const storage = await seedQueue(t);

  const badPriority = await setTriageOperatorDecision({ opportunityId: 'opp-high', priority: 'critical', storage });
  assert.equal(badPriority.ok, false);
  assert.equal(badPriority.status, 400);

  const empty = await setTriageOperatorDecision({ opportunityId: 'opp-high', storage });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 400);

  const missing = await setTriageOperatorDecision({ opportunityId: 'opp-nope', priority: 'high', storage });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const noId = await setTriageOperatorDecision({ priority: 'high', storage });
  assert.equal(noId.ok, false);
  assert.equal(noId.status, 400);
});

test('the detail view explains a score from persisted evidence alone', async (t) => {
  const storage = await seedQueue(t);
  const detail = await getTriageOpportunityDetail({ opportunityId: 'opp-high', storage });

  assert.equal(detail.ok, true);
  assert.equal(detail.dimensions.length, 7);
  const financial = detail.dimensions.find((dimension) => dimension.id === 'financial-fit');
  assert.ok(financial.evidence.length > 0, 'financial fit is explained by evidence rows');
  assert.ok(financial.evidence.every((row) => row.ruleId && row.ruleLabel && row.evidenceClass));
  assert.ok(
    financial.evidence.some((row) => row.evidenceClass === 'observed' && row.sourceId === 'deal-os-export'),
    'observed evidence names the source it came from',
  );
  // Phase 3A produces no model-generated evidence anywhere.
  const everyRow = detail.dimensions.flatMap((dimension) => dimension.evidence).concat(detail.unattributedEvidence);
  assert.equal(everyRow.some((row) => row.evidenceClass === 'inferred'), false);

  const sparse = await getTriageOpportunityDetail({ opportunityId: 'opp-sparse', storage });
  assert.ok(sparse.missingEvidence.length > 0, 'a sparse listing names what is missing');
  assert.ok(sparse.confidenceReasons.length > 0);

  const absent = await getTriageOpportunityDetail({ opportunityId: 'opp-nope', storage });
  assert.equal(absent.ok, false);
  assert.equal(absent.status, 404);
});

test('inactive historical scores disappear from every triage surface without losing score or evidence history', async (t) => {
  const storage = await seedQueue(t);
  const evidenceBefore = await storage.listDealHunterScoreEvidence('opp-high');
  assert.ok(evidenceBefore.length > 0);

  await storage.reconcileDealHunterCurrentScoreEligibility([
    'opp-watch', 'opp-sparse', 'opp-removed', 'opp-dismissed',
  ]);

  const queue = await listTriageQueue({ view: 'all', search: 'Opportunity high', storage });
  assert.equal(queue.total, 0);
  assert.deepEqual(queue.rows, []);

  const detail = await getTriageOpportunityDetail({ opportunityId: 'opp-high', storage });
  assert.equal(detail.ok, false);
  assert.equal(detail.status, 404);

  const decision = await setTriageOperatorDecision({
    opportunityId: 'opp-high', priority: 'urgent', actor: 'owner@example.invalid', storage,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 404);

  assert.ok(await storage.getDealHunterOpportunityScore('opp-high'), 'raw historical score remains available');
  assert.equal(
    (await storage.listDealHunterScoreEvidence('opp-high')).length,
    evidenceBefore.length,
    'raw historical evidence remains available',
  );
});

test('a gated opportunity keeps its explanation and its gate reason', async (t) => {
  const storage = await seedQueue(t);
  const detail = await getTriageOpportunityDetail({ opportunityId: 'opp-removed', storage });
  assert.equal(detail.ok, true);
  assert.ok(detail.gates.length > 0);
  assert.equal(detail.gates.some((gate) => gate.ruleId === 'gate.excluded-category'), true);
  assert.equal(detail.opportunity.shouldRemove, true);
  assert.equal(detail.opportunity.highFit, false);
  assert.ok(detail.dimensions.some((dimension) => dimension.contribution !== 0), 'gated deals still explain themselves');
});

test('triage reports unavailable storage rather than failing opaquely', async () => {
  const queue = await listTriageQueue({ storage: {} });
  assert.equal(queue.ok, false);
  assert.equal(queue.status, 503);

  const decision = await setTriageOperatorDecision({ opportunityId: 'opp-high', priority: 'high', storage: {} });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});
