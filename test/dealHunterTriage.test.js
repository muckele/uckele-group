import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { createSupabaseStorage } = await import('../server/storage/supabase.js');
const { refreshOpportunityScores } = await import('../server/services/dealHunterScoreStore.js');
const { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } = await import('../server/services/dealHunterSourceSnapshotAdmission.js');
const { getTriageOpportunityDetail, listTriageQueue, passTriageOpportunity, setTriageOperatorDecision } =
  await import('../server/services/dealHunterTriage.js');
const { buildFreshInboxAreas } = await import('../server/services/dealHunterFreshInboxPolicy.js');

const briefingGeneratedAt = '2026-09-05T15:00:00.000Z';

function briefingSourceHealth(overrides = {}) {
  return {
    generatedAt: briefingGeneratedAt,
    dateKey: '2026-09-05',
    healthy: true,
    issues: [],
    sources: [
      { id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true, sourceRole: 'required-primary', fetched: true, rowCount: 12 },
      { id: 'deal-os-export', name: 'SMB Deal OS export', mode: 'manual-export', required: false, sourceRole: 'optional-supplemental', fetched: true, rowCount: 4 },
    ],
    totals: { reviewedDeals: 12 },
    cached: true,
    ...overrides,
  };
}

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

async function seedSourceObservation(storage, opportunityId, field, value, observedAt = '2026-08-16T12:00:00.000Z') {
  await storage.upsertDealHunterOpportunitySourceObservation({
    id: `triage-observation:${opportunityId}:${field}`,
    opportunity_id: opportunityId,
    source_id: 'deal-os-export',
    source_name: 'Deal OS',
    source_record_id: `record:${opportunityId}`,
    field,
    value: String(value),
    observed_at: observedAt,
    created_at: observedAt,
    updated_at: observedAt,
  });
}

function queueScore(opportunityId, overrides = {}) {
  return {
    opportunity_id: opportunityId,
    scored_at: '2026-08-16T10:00:00.000Z',
    deal_key: `deal-${opportunityId}`,
    name: opportunityId,
    state: 'NY',
    listing_url: `https://listings.example.invalid/${opportunityId}`,
    fit_score: 50,
    score_status: 'watchlist',
    confidence: 'low',
    completeness_score: 80,
    contradiction_count: 0,
    missing_evidence_count: 0,
    should_remove: false,
    high_fit: false,
    gate_count: 0,
    score_fingerprint: `fingerprint-${opportunityId}`,
    semantic_digest: `digest-${opportunityId}`,
    engine_version: 'triage-test',
    rules_version: 'triage-test',
    profile_version: 'triage-test',
    completeness_policy_version: 'triage-test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [],
    summary: { strengths: ['Strong'], concerns: ['Concern'] },
    ...overrides,
  };
}

async function seedPriorityLadder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-triage-priority-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'priority.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const entries = [
    queueScore('opp-tier-urgent', { fit_score: 1 }),
    queueScore('opp-tier-high', { fit_score: 2 }),
    queueScore('opp-tier-high-fit-new', { fit_score: 3, high_fit: true, score_status: 'high-fit' }),
    queueScore('opp-tier-high-fit-changed', { fit_score: 4, high_fit: true, score_status: 'high-fit' }),
    queueScore('opp-tier-reviewed-static', { fit_score: 5 }),
    queueScore('opp-tier-fit', { fit_score: 99 }),
    queueScore('opp-tier-confidence-high', { fit_score: 50, confidence: 'high' }),
    queueScore('opp-tier-confidence-medium', { fit_score: 50, confidence: 'medium' }),
    queueScore('opp-tier-fresh', { fit_score: 50, confidence: 'low' }),
    queueScore('opp-tier-old', { fit_score: 50, confidence: 'low' }),
    queueScore('opp-tier-tie-a', { fit_score: 10, confidence: 'low' }),
    queueScore('opp-tier-tie-b', { fit_score: 10, confidence: 'low' }),
  ].map((entry, index) => ({
    ...entry,
    completeness_score: index + 1,
    scored_at: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
  for (const entry of entries) {
    await seedOpportunity(storage, entry.opportunity_id);
    await storage.writeDealHunterOpportunityScore(entry, []);
  }
  await storage.reconcileDealHunterCurrentScoreEligibility(entries.map((entry) => entry.opportunity_id));
  await setTriageOperatorDecision({ opportunityId: 'opp-tier-urgent', priority: 'urgent', storage });
  await setTriageOperatorDecision({ opportunityId: 'opp-tier-high', priority: 'high', storage });
  await setTriageOperatorDecision({ opportunityId: 'opp-tier-high-fit-changed', markReviewed: true, storage });
  await setTriageOperatorDecision({ opportunityId: 'opp-tier-reviewed-static', markReviewed: true, storage });
  await storage.writeDealHunterOpportunityScore(queueScore('opp-tier-high-fit-changed', {
    fit_score: 4,
    high_fit: true,
    score_status: 'high-fit',
    semantic_digest: 'digest-opp-tier-high-fit-changed-material',
  }), []);
  await seedSourceObservation(storage, 'opp-tier-fresh', 'industry', 'Services', '2026-08-18T10:00:00.000Z');
  await seedSourceObservation(storage, 'opp-tier-old', 'industry', 'Services', '2026-08-17T10:00:00.000Z');
  await seedSourceObservation(storage, 'opp-tier-tie-a', 'industry', 'Services', '2026-08-16T10:00:00.000Z');
  await seedSourceObservation(storage, 'opp-tier-tie-b', 'industry', 'Services', '2026-08-16T10:00:00.000Z');
  return storage;
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

test('rows carry scan-ready fit and confidence values without blended scoring or full detail payloads', async (t) => {
  const storage = await seedQueue(t);
  const queue = await listTriageQueue({ storage });
  const row = queue.rows.find((item) => item.opportunityId === 'opp-high');

  assert.equal(typeof row.fitScore, 'number');
  assert.ok(['low', 'medium', 'high'].includes(row.confidence));
  assert.equal(typeof row.completenessScore, 'number');
  assert.equal(typeof row.topStrength, 'string');
  assert.equal(typeof row.topConcern, 'string');
  assert.equal(Object.hasOwn(row, 'overallCertainty'), false, 'there is no blended certainty number');
  assert.equal(Object.hasOwn(row, 'operatorScoreOverride'), false, 'operators set priority, not a numeric override');
  assert.equal(Object.hasOwn(row, 'dimensions'), false, 'dimension evidence belongs to the detail view');
  assert.equal(Object.hasOwn(row, 'missingEvidence'), false, 'full evidence belongs to the detail view');
  assert.equal(Object.hasOwn(row, 'sourceObservations'), false, 'source observation history belongs to the detail view');
  assert.equal(Object.hasOwn(row, 'contactDetails'), false, 'contact detail belongs to the detail view');
  assert.equal(Object.hasOwn(row, 'history'), false, 'history belongs to the detail view');
});

test('Needs Review defaults to deterministic acquisition priority and promotes operator attention first', async (t) => {
  const storage = await seedQueue(t);
  await setTriageOperatorDecision({ opportunityId: 'opp-watch', priority: 'urgent', storage });
  await setTriageOperatorDecision({ opportunityId: 'opp-sparse', priority: 'high', storage });

  const queue = await listTriageQueue({ pageSize: 100, storage });
  assert.equal(queue.sort, 'acquisition-priority');
  assert.deepEqual(
    new Set(queue.rows.map((row) => row.opportunityId).slice(0, 2)),
    new Set(['opp-watch', 'opp-sparse']),
    'urgent and high operator priorities outrank fit score regardless of their machine score',
  );

  const tiedPriority = await listTriageQueue({
    pageSize: 100,
    sort: 'acquisition-priority',
    storage,
  });
  assert.deepEqual(
    tiedPriority.rows.map((row) => row.opportunityId),
    queue.rows.map((row) => row.opportunityId),
    'the explicit Inbox sort is identical to the Needs Review default',
  );
});

test('acquisition priority applies every tier in order and keeps page boundaries deterministic', async (t) => {
  const storage = await seedPriorityLadder(t);
  const all = await listTriageQueue({ pageSize: 100, storage });
  const ids = all.rows.map((row) => row.opportunityId);

  assert.deepEqual(new Set(ids.slice(0, 2)), new Set(['opp-tier-urgent', 'opp-tier-high']));
  assert.ok(ids.indexOf('opp-tier-high-fit-new') < ids.indexOf('opp-tier-fit'), 'new high-fit work precedes score alone');
  assert.ok(ids.indexOf('opp-tier-high-fit-changed') < ids.indexOf('opp-tier-fit'), 'materially changed reviewed high-fit work precedes score alone');
  assert.ok(ids.indexOf('opp-tier-fit') < ids.indexOf('opp-tier-confidence-high'), 'fit score precedes confidence');
  assert.ok(ids.indexOf('opp-tier-confidence-high') < ids.indexOf('opp-tier-confidence-medium'));
  assert.ok(ids.indexOf('opp-tier-confidence-medium') < ids.indexOf('opp-tier-fresh'));
  assert.ok(ids.indexOf('opp-tier-fresh') < ids.indexOf('opp-tier-old'), 'newer observation precedes older observation');
  assert.ok(ids.indexOf('opp-tier-tie-a') < ids.indexOf('opp-tier-tie-b'), 'opportunity id resolves exact ties');

  const first = await listTriageQueue({ page: 1, pageSize: 3, storage });
  const second = await listTriageQueue({ page: 2, pageSize: 3, storage });
  const third = await listTriageQueue({ page: 3, pageSize: 3, storage });
  const fourth = await listTriageQueue({ page: 4, pageSize: 3, storage });
  assert.deepEqual(
    [...first.rows, ...second.rows, ...third.rows, ...fourth.rows].map((row) => row.opportunityId),
    ids,
    'database pagination has no duplicates or gaps at acquisition-priority boundaries',
  );
});

test('all advertised sorts preserve their requested direction and acquisition priority is always descending', async (t) => {
  const storage = await seedPriorityLadder(t);
  const sorts = ['fit-score', 'confidence', 'completeness', 'scored-at', 'name', 'changed'];
  for (const sort of sorts) {
    const ascending = await listTriageQueue({ view: 'all', sort, direction: 'asc', pageSize: 100, storage });
    const descending = await listTriageQueue({ view: 'all', sort, direction: 'desc', pageSize: 100, storage });
    assert.equal(ascending.sort, sort);
    assert.equal(ascending.direction, 'asc');
    assert.equal(descending.direction, 'desc');
    assert.notDeepEqual(
      ascending.rows.map((row) => row.opportunityId),
      descending.rows.map((row) => row.opportunityId),
      `${sort} must not silently fall back to the same ordering in both directions`,
    );
  }
  const fixed = await listTriageQueue({ sort: 'acquisition-priority', direction: 'asc', pageSize: 100, storage });
  const descending = await listTriageQueue({ sort: 'acquisition-priority', direction: 'desc', pageSize: 100, storage });
  assert.equal(fixed.direction, 'desc');
  assert.deepEqual(fixed.rows.map((row) => row.opportunityId), descending.rows.map((row) => row.opportunityId));
});

test('service normalizes malformed and fractional pagination before asking storage for a bounded page', async () => {
  const calls = [];
  const storage = {
    async listDealHunterOpportunityScores(options) {
      calls.push(options);
      return { rows: [], total: 0, summary: {}, page: options.page, pageSize: options.pageSize, totalPages: 1 };
    },
  };
  const result = await listTriageQueue({ page: '1.9', pageSize: '1.9', storage });
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 1);
  assert.deepEqual(calls[0], {
    view: 'needs-review', page: 1, pageSize: 1, search: '', sort: 'acquisition-priority', direction: 'desc',
    minScore: null, confidence: '', priority: '', state: '',
  });
  await listTriageQueue({ page: 'not-a-number', pageSize: Infinity, storage });
  assert.equal(calls[1].page, 1);
  assert.equal(calls[1].pageSize, 25);
});

test('queue list rows omit full operator notes before and after public mapping', async (t) => {
  const storage = await seedQueue(t);
  const sentinel = 'operator-note-sentinel-'.repeat(100).slice(0, 2000);
  await setTriageOperatorDecision({ opportunityId: 'opp-high', note: sentinel, storage });
  const raw = await storage.listDealHunterOpportunityScores({ view: 'all', pageSize: 100 });
  const persisted = raw.rows.find((row) => row.opportunity_id === 'opp-high');
  assert.equal(Object.hasOwn(persisted, 'operator_note'), false);
  const queue = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  const row = queue.rows.find((item) => item.opportunityId === 'opp-high');
  assert.equal(Object.hasOwn(row, 'operatorNote'), false);
  assert.equal(JSON.stringify(row).includes(sentinel), false);
});

test('triage detail retains a persisted operator note that the list redacts', async (t) => {
  const storage = await seedQueue(t);
  const sentinel = 'operator-note-sentinel-'.repeat(100).slice(0, 2000);
  await setTriageOperatorDecision({ opportunityId: 'opp-high', note: sentinel, storage });

  const detail = await getTriageOpportunityDetail({ opportunityId: 'opp-high', storage });
  assert.equal(detail.ok, true);
  assert.equal(detail.opportunity.operatorNote, sentinel);
});

test('queue summary uses the same persisted view semantics and browsing never scores or writes', async (t) => {
  const storage = await seedQueue(t);
  const browsingStorage = {
    ...storage,
    writeDealHunterOpportunityScore: async () => { throw new Error('queue browsing must not score'); },
    reconcileDealHunterCurrentScoreEligibility: async () => { throw new Error('queue browsing must not reconcile'); },
    setDealHunterOpportunityOperatorDecision: async () => { throw new Error('queue browsing must not write decisions'); },
  };

  const queue = await listTriageQueue({ page: 1, pageSize: 2, storage: browsingStorage });
  const [needsReview, highPriority, watchlist, lowConfidence, current] = await Promise.all([
    listTriageQueue({ view: 'needs-review', pageSize: 100, storage }),
    listTriageQueue({ view: 'high-priority', pageSize: 100, storage }),
    listTriageQueue({ view: 'watchlist', pageSize: 100, storage }),
    listTriageQueue({ view: 'low-confidence', pageSize: 100, storage }),
    listTriageQueue({ view: 'all', pageSize: 100, storage }),
  ]);

  assert.deepEqual(Object.keys(queue.summary).sort(), [
    'currentOpportunities', 'highPriority', 'lowConfidence', 'needsReview', 'watchlist',
  ]);
  assert.deepEqual(queue.summary, {
    needsReview: needsReview.total,
    highPriority: highPriority.total,
    watchlist: watchlist.total,
    lowConfidence: lowConfidence.total,
    currentOpportunities: current.total,
  });
  assert.equal(queue.rows.length, 2, 'the storage query, not service memory, owns page boundaries');
});

test('queue rows project retained financial scan fields and workflow freshness without detail payloads', async (t) => {
  const storage = await seedQueue(t);
  await Promise.all([
    seedSourceObservation(storage, 'opp-high', 'industry', 'Fire safety inspection'),
    seedSourceObservation(storage, 'opp-high', 'location', 'Springfield, NY'),
    seedSourceObservation(storage, 'opp-high', 'annual_profit', 450000),
    seedSourceObservation(storage, 'opp-high', 'annual_revenue', 1800000),
    seedSourceObservation(storage, 'opp-high', 'asking_price', 1300000),
    seedSourceObservation(storage, 'opp-high', 'profit_multiple', 2.9),
  ]);

  const queue = await listTriageQueue({ view: 'all', pageSize: 100, storage });
  const row = queue.rows.find((item) => item.opportunityId === 'opp-high');

  assert.deepEqual(row.geography, { city: 'Springfield', state: 'NY', label: 'Springfield, NY' });
  assert.equal(row.industry, 'Fire safety inspection');
  assert.deepEqual(row.financials, {
    annualProfit: 450000,
    annualRevenue: 1800000,
    askingPrice: 1300000,
    profitMultiple: 2.9,
  });
  assert.deepEqual(Object.keys(row.workflow).sort(), ['cimStatus', 'crmStatus']);
  assert.equal(row.observationFreshness, '2026-08-16T12:00:00.000Z');
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

test('requested fit-score sorting and pagination are stable across pages', async (t) => {
  const storage = await seedQueue(t);
  const all = await listTriageQueue({ view: 'all', pageSize: 100, sort: 'fit-score', storage });
  assert.ok(all.total >= 4);

  const scores = all.rows.map((row) => row.fitScore);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left), 'default sort is fit score descending');

  const first = await listTriageQueue({ view: 'all', pageSize: 2, page: 1, sort: 'fit-score', storage });
  const second = await listTriageQueue({ view: 'all', pageSize: 2, page: 2, sort: 'fit-score', storage });
  const third = await listTriageQueue({ view: 'all', pageSize: 2, page: 3, sort: 'fit-score', storage });
  const paged = [...first.rows, ...second.rows, ...third.rows].map((row) => row.opportunityId);
  assert.equal(new Set(paged).size, paged.length, 'no row appears on two pages');
  assert.deepEqual(paged.slice(0, all.rows.length), all.rows.map((row) => row.opportunityId));

  const ascending = await listTriageQueue({ view: 'all', pageSize: 100, sort: 'fit-score', direction: 'asc', storage });
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

test('fresh discovery has its own first page despite more than a page of old priorities', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-inbox-areas-'));
  const sqlitePath = path.join(directory, 'inbox.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const priorityIds = Array.from({ length: 15 }, (_, index) => `old-priority-${index}`);
  for (const id of priorityIds) {
    await seedOpportunity(storage, id);
    await storage.writeDealHunterOpportunityScore(queueScore(id, { fit_score: 88,
      confidence: 'high', high_fit: true }), []);
    await storage.setDealHunterOpportunityOperatorDecision({ opportunityId: id, priority: 'high' });
  }
  const freshId = 'fresh-worthwhile-unlinked';
  await seedOpportunity(storage, freshId);
  await storage.markDealHunterOpportunityDiscoveryPending({
    opportunityId: freshId, createdAt: '2026-08-16T10:00:00.000Z',
  });
  await storage.writeDealHunterOpportunityScore(queueScore(freshId, { fit_score: 92,
    confidence: 'high', high_fit: true }), []);
  await storage.reconcileDealHunterCurrentScoreEligibility([...priorityIds, freshId]);
  const run = await storage.allocateDealHunterSourceGeneration({ sourceId: 'sheet-0', runId: 'fresh-area-run' });
  const at = new Date().toISOString();
  const accepted = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
    storage, reviewMode: 'full-backfill', run,
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false },
    deals: [{ sourceId: 'sheet-0', sourceName: 'Synthetic Sheet', stableExternalId: true, id: 'FRESH' }] },
    records: [{ opportunity_id: freshId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
      source_record_id: 'external:FRESH', observations: [{ id: 'fresh-inbox-observation',
        opportunity_id: freshId, source_id: 'sheet-0', source_name: 'Synthetic Sheet',
        source_record_id: 'external:FRESH', field: 'name', value: 'Fresh worthwhile',
        observed_at: at, created_at: at, updated_at: at }], freshness_evidence: null }],
  });
  assert.equal(accepted.reconciled, true);
  const inbox = await storage.listDealHunterFreshInbox({ area: 'inbox', asOf: new Date().toISOString() });
  const actions = inbox.areas.find((area) => area.id === 'action-preview');
  const discovery = inbox.areas.find((area) => area.id === 'new-important');
  assert.equal(actions.total, 3);
  assert.equal(actions.counts.ownerPriority, 15);
  assert.equal(discovery.total, 1);
  assert.deepEqual(discovery.rows.map((row) => row.opportunity_id), [freshId]);
  assert.equal(discovery.rows[0].primary_submission_id, null, 'fresh discovery remains honestly unlinked');
  const served = await listTriageQueue({ view: 'inbox', storage,
    getCachedSourceHealth: async () => ({ healthy: false }) });
  assert.equal(served.ok, true);
  assert.deepEqual(served.areas.map((area) => area.id), ['action-preview', 'new-important']);
  assert.equal(served.areas[1].rows[0].freshness.newToUs, true);
  assert.equal(served.areas[1].rows[0].freshness.crmLinked, false);
  const servedPriorities = await listTriageQueue({ view: 'inbox', area: 'owner-priorities',
    pageSize: 5, storage, getCachedSourceHealth: async () => ({ healthy: false }) });
  assert.equal(servedPriorities.areas[0].total, 15);
  const servedSecondPage = await listTriageQueue({ view: 'inbox', area: 'owner-priorities',
    cursor: servedPriorities.areas[0].nextCursor, pageSize: 5, storage,
    getCachedSourceHealth: async () => ({ healthy: false }) });
  assert.equal(servedSecondPage.areas[0].rows.length, 5);
  const firstPage = await storage.listDealHunterFreshInbox({ area: 'owner-priorities', limit: 5,
    asOf: inbox.asOf });
  assert.equal(firstPage.areas[0].total, 15);
  const secondPage = await storage.listDealHunterFreshInbox({ area: 'owner-priorities', limit: 5,
    cursor: firstPage.areas[0].nextCursor, asOf: inbox.asOf });
  assert.equal(new Set([...firstPage.areas[0].rows, ...secondPage.areas[0].rows]
    .map((row) => row.opportunity_id)).size, 10);
  await storage.setDealHunterOpportunityOperatorDecision({ opportunityId: priorityIds[0], priority: 'urgent' });
  await assert.rejects(storage.listDealHunterFreshInbox({ area: 'owner-priorities', limit: 5,
    cursor: firstPage.areas[0].nextCursor, asOf: inbox.asOf }), /results changed/);
});

test('discovery orders each supported group by owner priority, due time, fit, confidence, then acceptance', () => {
  const common = { discovery_state: 'known_prospective', discovery_revision: 1,
    reviewed_discovery_revision: 0, publication_state: 'unknown',
    publication_distinct_count: 0, publication_unsupported_count: 0,
    first_accepted_at: '2026-09-22T18:00:00.000Z', confidence: 'high', fit_score: 80 };
  const rows = [
    { ...common, opportunity_id: 'normal-high', operator_priority: 'normal', fit_score: 95 },
    { ...common, opportunity_id: 'high-no-due', operator_priority: 'high', fit_score: 90 },
    { ...common, opportunity_id: 'high-due', operator_priority: 'high', fit_score: 76,
      due_at: '2026-09-23T17:00:00.000Z' },
    { ...common, opportunity_id: 'urgent', operator_priority: 'urgent', fit_score: 76,
      first_accepted_at: '2026-09-20T18:00:00.000Z' },
    { ...common, opportunity_id: 'normal-medium', operator_priority: 'normal', fit_score: 95,
      confidence: 'medium', first_accepted_at: '2026-09-23T17:00:00.000Z' },
  ];
  const result = buildFreshInboxAreas(rows, { area: 'new-important',
    asOf: '2026-09-23T18:00:00.000Z' });
  assert.deepEqual(result.areas[0].rows.map((row) => row.opportunity_id),
    ['urgent', 'high-due', 'high-no-due', 'normal-high', 'normal-medium']);
});

test('SQLite reader applies seven and thirty Pacific calendar-day boundaries to retained facts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-calendar-boundary-'));
  const sqlitePath = path.join(directory, 'calendar.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const id = 'calendar-boundary';
  await seedOpportunity(storage, id);
  await storage.writeDealHunterOpportunityScore(queueScore(id, { fit_score: 88,
    confidence: 'high', high_fit: true }), []);
  await storage.reconcileDealHunterCurrentScoreEligibility([id]);
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  db.prepare(`UPDATE deal_hunter_opportunities SET discovery_state = 'known_prospective',
    first_accepted_at = '2026-09-23T18:00:00.000Z', discovery_revision = 1
    WHERE opportunity_id = ?`).run(id);
  db.exec(`INSERT INTO deal_hunter_freshness_evidence
    (id, source_id, source_name, source_record_id, run_id, generation,
      event_type, current_canonical_id)
    VALUES ('calendar-core', 'synthetic-sheet', 'Synthetic Sheet', 'calendar-row',
      'calendar-run', 1, 'accepted_source_record', 'calendar-boundary');
    INSERT INTO deal_hunter_freshness_evidence
    (id, source_id, source_name, source_record_id, run_id, generation,
      event_type, field_key, current_canonical_id, publication_meaning,
      publication_date, publication_precision, publication_state)
    VALUES ('calendar-date', 'synthetic-sheet', 'Synthetic Sheet', 'calendar-row',
      'calendar-run', 1, 'publication_evidence', 'date_added', 'calendar-boundary',
      'listing_publication', '2026-09-22', 'date', 'valid');
    INSERT INTO deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field,
      value, observed_at, created_at, updated_at, accepted_evidence_id)
    VALUES ('calendar-observation', 'calendar-boundary', 'synthetic-sheet',
      'Synthetic Sheet', 'calendar-row', 'date_added', '2026-09-22',
      '2026-09-23T18:00:00.000Z', '2026-09-23T18:00:00.000Z',
      '2026-09-23T18:00:00.000Z', 'calendar-core');`);
  const atSeven = await storage.listDealHunterFreshInbox({ area: 'new-important',
    asOf: '2026-09-30T18:00:00.000Z' });
  const atEight = await storage.listDealHunterFreshInbox({ area: 'new-important',
    asOf: '2026-10-01T18:00:00.000Z' });
  assert.equal(atSeven.areas[0].total, 1);
  assert.equal(atEight.areas[0].total, 0);
  const atThirty = await storage.listDealHunterFreshInbox({ area: 'all-active',
    asOf: '2026-10-22T18:00:00.000Z' });
  const atThirtyOne = await storage.listDealHunterFreshInbox({ area: 'all-active',
    asOf: '2026-10-23T18:00:00.000Z' });
  assert.equal(atThirty.areas[0].rows[0].recently_listed, true);
  assert.equal(atThirtyOne.areas[0].rows[0].recently_listed, false);
  db.prepare('UPDATE deal_hunter_opportunity_scores SET reviewed_discovery_revision=1 WHERE opportunity_id=?')
    .run(id);
  const reviewed = await storage.listDealHunterFreshInbox({ area: 'all-active',
    asOf: '2026-09-23T18:00:00.000Z' });
  assert.equal(reviewed.areas[0].rows[0].new_to_ug, false);
  assert.equal(reviewed.areas[0].rows[0].recently_listed, true);
  assert.equal((await storage.listDealHunterFreshInbox({ area: 'new-important',
    asOf: '2026-09-23T18:00:00.000Z' })).areas[0].total, 0);
});

test('Supabase area cursor rejects changed revision or anchor before showing another page', async () => {
  const revision = 'a'.repeat(32);
  const returned = { id: 'owner-priorities', rows: [{ opportunity_id: 'one', fit_score: 90 }],
    total: 2, revision, nextOffset: 1, lastId: 'one', anchorId: null };
  let current = returned;
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid',
      supabaseServiceRoleKey: 'service-role-key' } },
    { client: { async rpc(name) {
      assert.equal(name, 'list_deal_hunter_fresh_inbox_v1');
      return { data: { areas: [current], counts: {}, asOf: new Date().toISOString() }, error: null };
    } } },
  );
  const first = await storage.listDealHunterFreshInbox({ area: 'owner-priorities' });
  const cursor = first.areas[0].nextCursor;
  assert.equal(cursor.lastId, 'one');
  current = { ...returned, rows: [{ opportunity_id: 'two', fit_score: 80 }],
    nextOffset: null, lastId: null, anchorId: 'one' };
  const second = await storage.listDealHunterFreshInbox({ area: 'owner-priorities', cursor });
  assert.equal(second.areas[0].rows[0].opportunity_id, 'two');
  current = { ...current, revision: 'b'.repeat(32) };
  await assert.rejects(storage.listDealHunterFreshInbox({ area: 'owner-priorities', cursor }),
    (error) => error.status === 409);
  current = { ...current, revision, anchorId: 'other' };
  await assert.rejects(storage.listDealHunterFreshInbox({ area: 'owner-priorities', cursor }),
    (error) => error.status === 409);
});

test('due overflow keeps complete access and dual-qualified actions use one preview slot', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-due-preview-'));
  const sqlitePath = path.join(directory, 'due.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  const ids = Array.from({ length: 5 }, (_, index) => `due-${index}`);
  const at = new Date().toISOString();
  const dueAt = new Date(Date.now() - 86_400_000).toISOString();
  for (const [index, id] of ids.entries()) {
    await seedOpportunity(storage, id);
    await storage.writeDealHunterOpportunityScore(queueScore(id, { fit_score: 85,
      confidence: 'high', high_fit: true }), []);
    const submissionId = `submission-${id}`;
    db.prepare(`INSERT INTO contact_submissions
      (id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message)
      VALUES (?, ?, ?, 'active', 'test', 'delivered', 'not-synced', 'synthetic',
        'hash', ?, 'broker@example.test', 'Synthetic')`
    ).run(submissionId, at, at, id);
    db.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
      .run(submissionId, id);
    db.prepare(`INSERT INTO deal_hunter_cim_requests
      (id, created_at, updated_at, opportunity_id, deal_key, recipient_email, status,
        next_follow_up_at, submission_id, request_state, delivery_state,
        follow_up_state, metadata)
      VALUES (?, ?, ?, ?, ?, 'broker@example.test', 'sent', ?, ?, 'provider_accepted',
        'accepted', 'scheduled', ?)`
    ).run(`request-${id}`, at, at, id, `deal-${id}`,
      new Date(Date.parse(dueAt) + index * 60_000).toISOString(), submissionId,
      JSON.stringify({ manualFollowUp: { version: 'deal-hunter-manual-follow-up-v1',
        mode: 'operator-approved', maximumFollowUps: 5,
        cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1' } }));
  }
  await storage.reconcileDealHunterCurrentScoreEligibility(ids);
  await storage.setDealHunterOpportunityOperatorDecision({ opportunityId: ids[0], priority: 'urgent' });
  const inbox = await storage.listDealHunterFreshInbox({ area: 'inbox', asOf: at });
  const preview = inbox.areas.find((area) => area.id === 'action-preview');
  assert.equal(preview.rows.length, 3);
  assert.equal(new Set(preview.rows.map((row) => row.opportunity_id)).size, 3);
  assert.deepEqual([preview.counts.due, preview.counts.ownerPriority], [5, 1]);
  assert.equal(preview.rows.find((row) => row.opportunity_id === ids[0])?.owner_priority, true);
  const allDue = await storage.listDealHunterFreshInbox({ area: 'due-actions', limit: 10, asOf: at });
  assert.equal(allDue.areas[0].total, 5);
  assert.equal(allDue.areas[0].rows.length, 5);
});

test('current verified broker reply and received materials join due actions without false overdue counts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-broker-actions-'));
  const sqlitePath = path.join(directory, 'actions.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  const at = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  for (const kind of ['reply', 'materials', 'nda']) {
    const id = `action-${kind}`;
    await seedOpportunity(storage, id);
    await storage.writeDealHunterOpportunityScore(queueScore(id, { fit_score: 85,
      confidence: 'high' }), []);
    const submissionId = `submission-${kind}`;
    db.prepare(`INSERT INTO contact_submissions
      (id, created_at, updated_at, status, delivery_provider, delivery_status,
        crm_status, source, ip_hash, name, email, message)
      VALUES (?, ?, ?, 'active', 'test', 'delivered', 'not-synced', 'synthetic',
        'hash', ?, 'broker@example.test', 'Synthetic')`).run(submissionId, at, at, id);
    db.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
      .run(submissionId, id);
  }
  await storage.reconcileDealHunterCurrentScoreEligibility(['action-reply', 'action-materials', 'action-nda']);
  db.prepare(`INSERT INTO crm_communications
    (id, submission_id, direction, channel, source, kind, occurred_at, created_at,
      updated_at, delivery_state) VALUES ('verified-reply', 'submission-reply', 'inbound',
      'email', 'resend-webhook', 'broker-reply', ?, ?, ?, 'replied')`).run(old, old, old);
  for (const [kind, requested] of [['materials', 'financials'], ['nda', 'nda']]) {
    db.prepare(`INSERT INTO secure_upload_requests
      (id, submission_id, created_at, updated_at, email, status, expires_at,
        last_uploaded_at, requested_documents) VALUES (?, ?, ?, ?, 'broker@example.test',
        'completed', ?, ?, ?)`).run(`upload-${kind}`, `submission-${kind}`, old, old, at, old,
      JSON.stringify([{ category: requested }]));
  }
  db.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message)
    VALUES ('historical-submission', ?, ?, 'active', 'test', 'delivered',
      'not-synced', 'synthetic', 'hash', 'Historical', 'broker@example.test', 'Synthetic')`
  ).run(at, at);
  db.prepare(`INSERT INTO deal_hunter_cim_requests
    (id, created_at, updated_at, opportunity_id, deal_key, recipient_email, status,
      next_follow_up_at, submission_id, request_state, delivery_state,
      follow_up_state, metadata) VALUES ('historical-action', ?, ?, 'action-nda',
      'deal-action-nda', 'broker@example.test', 'sent', ?, 'historical-submission',
      'provider_accepted', 'accepted', 'scheduled', ?)`
  ).run(at, at, old, JSON.stringify({ manualFollowUp: { mode: 'operator-approved',
    version: 'deal-hunter-manual-follow-up-v1', maximumFollowUps: 5,
    cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1' } }));
  const inbox = await storage.listDealHunterFreshInbox({ area: 'inbox', asOf: at });
  const preview = inbox.areas[0];
  assert.deepEqual([preview.counts.due, preview.counts.overdue], [2, 0]);
  assert.deepEqual(new Set(preview.rows.map((row) => row.action_reason)),
    new Set(['broker_reply', 'materials_ready']));
  const all = await storage.listDealHunterFreshInbox({ area: 'due-actions', asOf: at });
  assert.equal(all.areas[0].total, 2);
  db.prepare(`INSERT INTO crm_communications
    (id, submission_id, direction, channel, source, kind, occurred_at, created_at,
      updated_at, delivery_state) VALUES ('later-outbound', 'submission-reply', 'outbound',
      'email', 'synthetic', 'follow-up', ?, ?, ?, 'sent')`).run(at, at, at);
  db.prepare("UPDATE contact_submissions SET follow_up_state='completed' WHERE id='submission-materials'").run();
  const resolved = await storage.listDealHunterFreshInbox({ area: 'due-actions', asOf: at });
  assert.equal(resolved.areas[0].total, 0);
});

test('freshness review and Pass compare both shown revisions atomically while legacy review leaves them alone', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl01-review-cas-'));
  const sqlitePath = path.join(directory, 'review.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const id = 'op-fl01-review';
  await seedOpportunity(storage, id);
  await storage.writeDealHunterOpportunityScore(queueScore(id, { fit_score: 90, high_fit: true }), []);
  await storage.reconcileDealHunterCurrentScoreEligibility([id]);
  const db = new Database(sqlitePath);
  t.after(() => db.close());
  db.prepare('UPDATE deal_hunter_opportunities SET discovery_revision = 1, material_revision = 2 WHERE opportunity_id = ?').run(id);
  const stale = await setTriageOperatorDecision({ opportunityId: id, markReviewed: true,
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 2, storage, getCachedSourceHealth: null });
  assert.equal(stale.status, 409);
  assert.equal((await storage.getDealHunterOpportunityScore(id)).reviewed_at, null);
  const reviewed = await setTriageOperatorDecision({ opportunityId: id, markReviewed: true,
    expectedDiscoveryRevision: 1, expectedMaterialRevision: 2, storage, getCachedSourceHealth: null });
  assert.equal(reviewed.ok, true);
  let score = await storage.getDealHunterOpportunityScore(id);
  assert.deepEqual([score.reviewed_discovery_revision, score.reviewed_material_revision], [1, 2]);
  db.prepare('UPDATE deal_hunter_opportunities SET discovery_revision = 2, material_revision = 3 WHERE opportunity_id = ?').run(id);
  const stalePass = await passTriageOpportunity({ opportunityId: id, reason: 'not-a-fit',
    expectedDiscoveryRevision: 1, expectedMaterialRevision: 2, storage, getCachedSourceHealth: null });
  assert.equal(stalePass.status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM deal_hunter_dispositions WHERE deal_key = ?').get(`deal-${id}`).n, 0);
  const passed = await passTriageOpportunity({ opportunityId: id, reason: 'not-a-fit',
    expectedDiscoveryRevision: 2, expectedMaterialRevision: 3, storage, getCachedSourceHealth: null });
  assert.equal(passed.ok, true);
  score = await storage.getDealHunterOpportunityScore(id);
  assert.deepEqual([score.reviewed_discovery_revision, score.reviewed_material_revision], [2, 3]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM deal_hunter_dispositions WHERE deal_key = ?').get(`deal-${id}`).n, 1);
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
  const persisted = await storage.getDealHunterOpportunityScore('opp-watch');
  assert.equal(persisted.operator_note, 'Broker call booked.',
    'the operator decision still persists its note for a later detail surface');
  const detail = await getTriageOpportunityDetail({ opportunityId: 'opp-watch', storage });
  assert.equal(detail.opportunity.operatorNote, 'Broker call booked.');
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
  assert.equal(detail.score.dimensions.length, 7);
  const financial = detail.score.dimensions.find((dimension) => dimension.id === 'financial-fit');
  assert.ok(financial.evidence.length > 0, 'financial fit is explained by evidence rows');
  assert.ok(financial.evidence.every((row) => row.ruleId && row.ruleLabel && row.evidenceClass));
  assert.ok(
    financial.evidence.some((row) => row.evidenceClass === 'observed' && row.sourceId === 'deal-os-export'),
    'observed evidence names the source it came from',
  );
  // Phase 3A produces no model-generated evidence anywhere.
  const everyRow = detail.score.dimensions.flatMap((dimension) => dimension.evidence).concat(detail.score.unattributedEvidence);
  assert.equal(everyRow.some((row) => row.evidenceClass === 'inferred'), false);

  const sparse = await getTriageOpportunityDetail({ opportunityId: 'opp-sparse', storage });
  assert.ok(sparse.score.missingEvidence.length > 0, 'a sparse listing names what is missing');
  assert.ok(sparse.score.confidenceReasons.length > 0);

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
  assert.ok(detail.score.gates.length > 0);
  assert.equal(detail.score.gates.some((gate) => gate.ruleId === 'gate.excluded-category'), true);
  assert.equal(detail.opportunity.shouldRemove, true);
  assert.equal(detail.opportunity.highFit, false);
  assert.ok(detail.score.dimensions.some((dimension) => dimension.contribution !== 0), 'gated deals still explain themselves');
});

test('triage reports unavailable storage rather than failing opaquely', async () => {
  const queue = await listTriageQueue({ storage: {} });
  assert.equal(queue.ok, false);
  assert.equal(queue.status, 503);

  const decision = await setTriageOperatorDecision({ opportunityId: 'opp-high', priority: 'high', storage: {} });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
});

test('queue projects cached source health without refreshing source data', async (t) => {
  const storage = await seedQueue(t);
  const calls = [];
  const cachedHealth = { cached: true, healthy: false, issues: [{ title: 'Cached source warning' }], sources: [] };
  const queue = await listTriageQueue({
    storage,
    getCachedSourceHealth: async (...args) => {
      calls.push(args);
      return cachedHealth;
    },
  });

  assert.equal(queue.ok, true);
  assert.deepEqual(queue.sourceHealth, cachedHealth);
  assert.deepEqual(calls, [[storage, { persistSnapshot: false, refresh: false }]], 'queue allows only the non-persisting, non-refreshing cached health read');
});

test('triage response includes the bounded server-owned morning briefing projection', async () => {
  const requestedPages = [];
  const ordered = [
    queueScore('briefing-first', { name: 'Server first', fit_score: 61, operator_priority: 'urgent', top_strength: 'Urgent operator attention.', top_concern: 'Margin detail is incomplete.', crm_status: 'reviewing', cim_status: 'not-requested', observation_freshness: briefingGeneratedAt }),
    queueScore('briefing-second', { name: 'Server second', fit_score: 99, confidence: 'high', top_strength: 'Strong service revenue.', top_concern: 'Customer concentration needs review.', crm_status: 'active', cim_status: 'received', observation_freshness: briefingGeneratedAt }),
  ];
  const storage = {
    async listDealHunterOpportunityScores(options) {
      requestedPages.push(options);
      const briefing = options.view === 'needs-review'
        && options.page === 1
        && options.pageSize === 5
        && options.search === ''
        && options.confidence === ''
        && options.priority === ''
        && options.state === '';
      const rows = briefing ? ordered : [ordered[1]];
      return {
        rows,
        total: rows.length,
        page: options.page,
        pageSize: options.pageSize,
        totalPages: 1,
        summary: { needsReview: 7, highPriority: 3, watchlist: 2, lowConfidence: 1, currentOpportunities: 12 },
      };
    },
    async getScheduledJob() {
      return {
        status: 'completed', attempt_count: 2, completed_at: '2026-09-05T15:02:00.000Z',
        metadata: { notificationType: 'normal-digest', recipient: 'private@example.test', preparedEnvelope: { text: 'private body' } },
      };
    },
  };

  const response = await listTriageQueue({
    storage,
    view: 'all',
    search: 'Server second',
    getCachedSourceHealth: async () => briefingSourceHealth(),
  });

  assert.equal(response.dailyDigest?.status, 'ready');
  assert.deepEqual(response.dailyDigest?.summary, {
    needsReview: 7,
    highPriority: 3,
    watchlist: 2,
    lowConfidence: 1,
    currentOpportunities: 12,
  });
  assert.deepEqual(response.dailyDigest?.topOpportunities.map((row) => row.name), ['Server first', 'Server second']);
  assert.deepEqual(Object.keys(response.dailyDigest?.topOpportunities[0] || {}).sort(), [
    'changedSinceReview', 'confidence', 'fitScore', 'name', 'observationFreshness', 'operatorPriority',
    'opportunityId', 'reviewed', 'scoreStatus', 'state', 'topConcern', 'topStrength', 'workflow',
  ]);
  assert.equal(response.dailyDigest?.actionsAllowed, true);
  assert.equal(requestedPages.length, 2, 'the bounded briefing query is independent of the visible filtered page');
  assert.doesNotMatch(JSON.stringify(response.dailyDigest), /private@example\.test|private body|preparedEnvelope|dealKey|listingUrl/);
});

test('required source failure returns null briefing summary no recommendations and actions disallowed', async (t) => {
  const storage = await seedQueue(t);
  const requiredFailure = briefingSourceHealth({
    healthy: false,
    issues: [{ sourceId: 'sheet-0', affectsHealth: true, sourceUnavailable: true, title: 'Private raw source failure', message: 'https://private.example.test/token=secret', checkedAt: briefingGeneratedAt }],
    sources: [{ id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true, sourceRole: 'required-primary', fetched: false, rowCount: 0 }],
  });

  const response = await listTriageQueue({ storage, getCachedSourceHealth: async () => requiredFailure });

  assert.equal(response.dailyDigest?.status, 'action-required');
  assert.equal(response.dailyDigest?.summary, null);
  assert.deepEqual(response.dailyDigest?.topOpportunities, []);
  assert.equal(response.dailyDigest?.actionsAllowed, false);
  assert.doesNotMatch(JSON.stringify(response.dailyDigest), /private\.example|token=secret|Synthetic Opportunity/);
});

test('optional stale Deal OS returns warning with primary-backed briefing and actions allowed', async (t) => {
  const storage = await seedQueue(t);
  const optionalWarning = briefingSourceHealth({
    issues: [{ sourceId: 'deal-os-export', affectsHealth: false, sourceUnavailable: true, title: 'Private stale export path', message: '/private/deal-os.csv is stale', checkedAt: briefingGeneratedAt }],
    sources: [
      { id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true, sourceRole: 'required-primary', fetched: true, rowCount: 12 },
      { id: 'deal-os-export', name: 'SMB Deal OS export', mode: 'manual-export', required: false, sourceRole: 'optional-supplemental', fetched: false, rowCount: 0 },
    ],
  });

  const response = await listTriageQueue({ storage, getCachedSourceHealth: async () => optionalWarning });

  assert.equal(response.dailyDigest?.status, 'optional-warning');
  assert.equal(response.dailyDigest?.sourceAuthority.optionalWarnings.length, 1);
  assert.equal(response.dailyDigest?.summary.needsReview, response.summary.needsReview);
  assert.ok(response.dailyDigest?.topOpportunities.length > 0);
  assert.equal(response.dailyDigest?.actionsAllowed, true);
  assert.doesNotMatch(JSON.stringify(response.dailyDigest), /private stale export path|private\/deal-os\.csv/);
});

test('triage decision mutation rechecks required source authority server-side', async (t) => {
  const storage = await seedQueue(t);
  const before = await storage.getCurrentDealHunterOpportunityScore('opp-high');
  const failure = briefingSourceHealth({
    healthy: false,
    issues: [{ sourceId: 'sheet-0', affectsHealth: true, sourceUnavailable: true, checkedAt: briefingGeneratedAt }],
    sources: [{ id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true, sourceRole: 'required-primary', fetched: false, rowCount: 0 }],
  });

  const result = await setTriageOperatorDecision({
    opportunityId: 'opp-high',
    priority: 'urgent',
    markReviewed: true,
    storage,
    getCachedSourceHealth: async () => failure,
  });
  const after = await storage.getCurrentDealHunterOpportunityScore('opp-high');

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'required_source_authority_unavailable');
  assert.deepEqual(
    { priority: after.operator_priority, reviewedAt: after.reviewed_at, reviewedBy: after.reviewed_by },
    { priority: before.operator_priority, reviewedAt: before.reviewed_at, reviewedBy: before.reviewed_by },
  );
});

test('viewer projection contains no recipient envelope provider secret or operator note', async (t) => {
  const storage = await seedQueue(t);
  const operatorNote = 'PRIVATE OPERATOR NOTE SENTINEL';
  await setTriageOperatorDecision({ opportunityId: 'opp-high', note: operatorNote, storage });
  const unsafeStorage = {
    ...storage,
    async getScheduledJob() {
      return {
        status: 'pending', attempt_count: 1,
        metadata: {
          recipient: 'recipient-sentinel@example.test',
          providerSecret: 'PROVIDER SECRET SENTINEL',
          preparedEnvelope: { from: 'sender-sentinel@example.test', text: 'PRIVATE ENVELOPE BODY' },
        },
      };
    },
  };

  const response = await listTriageQueue({ storage: unsafeStorage, getCachedSourceHealth: async () => briefingSourceHealth() });
  const serialized = JSON.stringify(response);

  assert.equal(response.dailyDigest?.actionsAllowed, true);
  for (const forbidden of [operatorNote, 'recipient-sentinel@example.test', 'PROVIDER SECRET SENTINEL', 'sender-sentinel@example.test', 'PRIVATE ENVELOPE BODY', 'preparedEnvelope']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
