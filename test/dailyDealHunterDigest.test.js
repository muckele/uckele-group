import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DAILY_DEAL_HUNTER_DIGEST_VERSION,
  DAILY_DEAL_HUNTER_TOP_LIMIT,
  buildCurrentDailyDealHunterDigest,
  projectDailyDealHunterDigest,
} = await import('../server/services/dailyDealHunterDigest.js');

const generatedAt = '2026-09-05T15:00:00.000Z';
const businessDate = '2026-09-05';

function healthyReview() {
  return {
    generatedAt,
    reviewMode: 'full-backfill',
    selection: { strategy: 'all-canonical-listings' },
    sources: [
      {
        id: 'google-sheet-1',
        name: 'Daily Deal Update',
        required: true,
        sourceRole: 'required-primary',
        fetched: true,
        rowCount: 12,
      },
      {
        id: 'deal-os-export',
        name: 'SMB Deal OS export',
        required: false,
        sourceRole: 'optional-supplemental',
        fetched: true,
        rowCount: 4,
      },
    ],
    totals: { reviewedDeals: 12 },
  };
}

function healthySourceHealth(overrides = {}) {
  return {
    generatedAt,
    dateKey: businessDate,
    healthy: true,
    issues: [],
    sources: healthyReview().sources,
    totals: { reviewedDeals: 12 },
    ...overrides,
  };
}

function healthyScoreRefresh(overrides = {}) {
  return {
    ok: true,
    status: 200,
    review: healthyReview(),
    counts: { considered: 12, scored: 12, skipped: 0, failed: 0, changed: 12, versionOnly: 0 },
    eligibilityReconciliation: { active: 12, inactive: 0 },
    ...overrides,
  };
}

function queueRow(index, overrides = {}) {
  return {
    opportunityId: `opp-${index}`,
    dealKey: `private-deal-key-${index}`,
    name: `Opportunity ${index}`,
    state: 'CA',
    listingUrl: `https://broker.example.invalid/${index}`,
    fitScore: 90 - index,
    scoreStatus: 'qualified',
    confidence: index % 2 ? 'high' : 'medium',
    completenessScore: 88,
    missingEvidenceCount: 1,
    contradictionCount: 0,
    shouldRemove: false,
    highFit: true,
    geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
    industry: 'Commercial services',
    financials: { annualProfit: 450000, annualRevenue: 1800000, askingPrice: 1300000, profitMultiple: 2.9 },
    topStrength: `Strength ${index}`,
    topConcern: `Concern ${index}`,
    workflow: { crmStatus: 'reviewing', cimStatus: 'not-requested', privateWorkflowField: 'do-not-copy' },
    observationFreshness: `2026-09-0${Math.min(index, 9)}T12:00:00.000Z`,
    operatorPriority: index === 1 ? 'urgent' : 'normal',
    operatorNote: `Private operator note ${index}`,
    reviewed: index === 2,
    reviewedAt: '2026-09-01T12:00:00.000Z',
    reviewedBy: 'owner@example.invalid',
    changedSinceReview: index === 2,
    dismissed: false,
    dismissedReason: '',
    scoredAt: generatedAt,
    scoreFingerprint: `private-fingerprint-${index}`,
    rulesVersion: 'private-rules-version',
    brokerEmail: `broker-${index}@example.invalid`,
    arbitraryPrivateField: `private-value-${index}`,
    ...overrides,
  };
}

function healthyQueue(rows = [queueRow(1), queueRow(2)]) {
  return {
    ok: true,
    status: 200,
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    rows,
    total: rows.length,
    page: 1,
    pageSize: 5,
    totalPages: rows.length > 0 ? 1 : 0,
    summary: {
      needsReview: rows.length,
      highPriority: 1,
      watchlist: 2,
      lowConfidence: 3,
      currentOpportunities: 12,
    },
  };
}

test('daily digest projection uses the Acquisition Inbox summary and exact acquisition-priority order', async () => {
  const storage = { name: 'injected-storage' };
  const review = healthyReview();
  const sourceHealth = healthySourceHealth();
  const queue = healthyQueue([
    queueRow(1, { name: 'Operator urgent first', fitScore: 61 }),
    queueRow(2, { name: 'Existing rank second', fitScore: 99 }),
    queueRow(3, { name: 'Existing rank third', fitScore: 88 }),
  ]);
  const calls = [];

  const projection = await buildCurrentDailyDealHunterDigest({
    businessDate,
    storage,
    refreshScores: async (options) => {
      calls.push(['refresh', options]);
      return healthyScoreRefresh({ review });
    },
    readSourceHealth: async (injectedStorage, options) => {
      calls.push(['source-health', injectedStorage, options]);
      return sourceHealth;
    },
    readTriageQueue: async (options) => {
      calls.push(['triage', options]);
      return queue;
    },
  });

  assert.equal(DAILY_DEAL_HUNTER_DIGEST_VERSION, 'daily-deal-hunter-digest-v1');
  assert.equal(DAILY_DEAL_HUNTER_TOP_LIMIT, 5);
  assert.deepEqual(projection.summary, queue.summary);
  assert.deepEqual(projection.topOpportunities.map((row) => row.name), [
    'Operator urgent first',
    'Existing rank second',
    'Existing rank third',
  ]);
  assert.deepEqual(calls[0], ['refresh', { storage, recordActivity: false }]);
  assert.deepEqual(calls[1], ['source-health', storage, { persistSnapshot: true, review }]);
  assert.deepEqual(calls[2], ['triage', {
    storage,
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    page: 1,
    pageSize: 5,
  }]);
});

test('daily digest projection returns at most five allowlisted current opportunities', () => {
  const projection = projectDailyDealHunterDigest({
    businessDate,
    generatedAt,
    sourceHealth: healthySourceHealth(),
    scoreRefresh: healthyScoreRefresh({
      staleRows: [queueRow(90, { name: 'Stale refresh row must not be projected' })],
    }),
    queue: healthyQueue(Array.from({ length: 8 }, (_, index) => queueRow(index + 1))),
    job: {
      status: 'pending',
      attemptCount: 2,
      completedAt: '',
      notificationType: 'normal-digest',
      recipient: 'private-recipient@example.invalid',
      envelope: { html: '<p>private</p>' },
    },
  });

  assert.equal(projection.topOpportunities.length, 5);
  assert.deepEqual(projection.topOpportunities.map((row) => row.opportunityId), [
    'opp-1', 'opp-2', 'opp-3', 'opp-4', 'opp-5',
  ]);
  assert.deepEqual(Object.keys(projection.topOpportunities[0]).sort(), [
    'changedSinceReview',
    'confidence',
    'fitScore',
    'name',
    'observationFreshness',
    'operatorPriority',
    'opportunityId',
    'reviewed',
    'scoreStatus',
    'state',
    'topConcern',
    'topStrength',
    'workflow',
  ]);
  assert.deepEqual(projection.job, {
    status: 'pending',
    attemptCount: 2,
    completedAt: '',
    notificationType: 'normal-digest',
  });
  assert.doesNotMatch(JSON.stringify(projection), /Stale refresh row|private-recipient|<p>private<\/p>/);
});

test('daily digest projection omits contact data operator notes financials and arbitrary fields', () => {
  const unsafe = queueRow(1, {
    name: `Bounded ${'N'.repeat(500)}`,
    topStrength: `Safe prefix ${'S'.repeat(1000)}`,
    topConcern: `Safe concern ${'C'.repeat(1000)}`,
  });
  const input = {
    businessDate,
    generatedAt,
    sourceHealth: healthySourceHealth(),
    scoreRefresh: healthyScoreRefresh(),
    queue: healthyQueue([unsafe]),
  };

  const first = projectDailyDealHunterDigest(input);
  const second = projectDailyDealHunterDigest(input);
  const serialized = JSON.stringify(first);

  assert.deepEqual(second, first, 'identical authoritative inputs and as-of instant must be deterministic');
  assert.ok(first.topOpportunities[0].name.length <= 160);
  assert.ok(first.topOpportunities[0].topStrength.length <= 400);
  assert.ok(first.topOpportunities[0].topConcern.length <= 400);
  assert.doesNotMatch(serialized, /broker-1@example\.invalid|Private operator note|annualProfit|annualRevenue|askingPrice|profitMultiple/);
  assert.doesNotMatch(serialized, /listingUrl|brokerEmail|arbitraryPrivateField|private-fingerprint|private-rules-version|private-deal-key/);
});

test('required source failure returns one bounded action-required projection with no opportunity content', () => {
  const sourceHealth = healthySourceHealth({
    healthy: false,
    sources: [{
      id: 'google-sheet-1',
      name: `Daily Deal Update ${'X'.repeat(300)}`,
      required: true,
      sourceRole: 'required-primary',
      fetched: false,
      rowCount: 0,
      checkedAt: generatedAt,
    }],
    issues: [{
      sourceId: 'google-sheet-1',
      affectsHealth: true,
      sourceUnavailable: true,
      title: `Required source unavailable ${'T'.repeat(400)}`,
      message: 'Fetch failed for https://raw-source.example.invalid/private.csv?token=super-secret-token',
    }],
  });
  const projection = projectDailyDealHunterDigest({
    businessDate,
    generatedAt,
    sourceHealth,
    scoreRefresh: healthyScoreRefresh(),
    queue: healthyQueue([queueRow(1, { name: 'Must never leak into alert' })]),
  });
  const serialized = JSON.stringify(projection);

  assert.equal(projection.status, 'action-required');
  assert.equal(projection.notificationType, 'required-source-alert');
  assert.equal(projection.summary, null);
  assert.deepEqual(projection.topOpportunities, []);
  assert.equal(projection.actionsAllowed, false);
  assert.equal(projection.sourceAuthority.requiredHealthy, false);
  assert.equal(projection.sourceAuthority.blockingIssues.length, 1);
  assert.equal(projection.sourceAuthority.blockingIssues[0].classification, 'unavailable');
  assert.ok(projection.sourceAuthority.blockingIssues[0].sourceName.length <= 160);
  assert.ok(projection.sourceAuthority.blockingIssues[0].title.length <= 160);
  assert.ok(projection.sourceAuthority.blockingIssues[0].message.length <= 320);
  assert.doesNotMatch(serialized, /Must never leak|needsReview|queue|fitScore|raw-source|super-secret-token/);
});

test('identity score or queue authority failure returns action-required with no stale fallback', async (t) => {
  const cases = [
    ['identity', { ok: false, status: 409, error: 'Canonical identity admission is incomplete.' }, healthyQueue()],
    ['score', { ok: false, status: 207, error: 'One score write failed.' }, healthyQueue()],
    ['queue', healthyScoreRefresh(), { ok: false, status: 503, error: 'Queue authority is unavailable.' }],
    ['malformed queue', healthyScoreRefresh(), { ok: true, status: 200, summary: undefined }],
  ];

  for (const [name, scoreRefresh, queue] of cases) {
    await t.test(name, () => {
      const projection = projectDailyDealHunterDigest({
        businessDate,
        generatedAt,
        sourceHealth: healthySourceHealth(),
        scoreRefresh,
        queue: { ...queue, rows: [queueRow(1, { name: `Stale fallback ${name}` })] },
      });
      assert.equal(projection.notificationType, 'required-source-alert');
      assert.equal(projection.summary, null);
      assert.deepEqual(projection.topOpportunities, []);
      assert.doesNotMatch(JSON.stringify(projection), new RegExp(`Stale fallback ${name}|needsReview|fitScore`));
    });
  }
});

test('optional stale Deal OS keeps the primary-backed projection usable and emits one bounded warning', async () => {
  const review = healthyReview();
  review.staleSupplementalRows = [queueRow(90, { name: 'Stale Deal OS candidate' })];
  const sourceHealth = healthySourceHealth({
    issues: [
      {
        sourceId: 'deal-os-export',
        affectsHealth: false,
        sourceUnavailable: true,
        title: 'Optional Deal OS import is stale',
        message: 'The supplemental export is outside its freshness window.',
      },
      {
        sourceId: 'deal-os-export',
        affectsHealth: false,
        sourceUnavailable: true,
        title: 'Duplicate optional warning',
        message: 'This must be bounded away.',
      },
    ],
    sources: healthyReview().sources.map((source) => source.id === 'deal-os-export'
      ? { ...source, fetched: false, rowCount: 0, tone: 'warning' }
      : source),
  });
  const projection = await buildCurrentDailyDealHunterDigest({
    businessDate,
    storage: {},
    refreshScores: async () => healthyScoreRefresh({ review }),
    readSourceHealth: async () => sourceHealth,
    readTriageQueue: async () => healthyQueue([queueRow(1, { name: 'Primary-backed current row' })]),
  });

  assert.equal(projection.status, 'optional-warning');
  assert.equal(projection.notificationType, 'normal-digest');
  assert.equal(projection.sourceAuthority.requiredHealthy, true);
  assert.equal(projection.sourceAuthority.optionalWarnings.length, 1);
  assert.deepEqual(projection.topOpportunities.map((row) => row.name), ['Primary-backed current row']);
  assert.doesNotMatch(JSON.stringify(projection), /Stale Deal OS candidate|Duplicate optional warning/);
});

test('empty healthy Acquisition Inbox produces a normal zero-count digest', () => {
  const queue = healthyQueue([]);
  queue.summary = {
    needsReview: 0,
    highPriority: 0,
    watchlist: 0,
    lowConfidence: 0,
    currentOpportunities: 0,
  };
  const projection = projectDailyDealHunterDigest({
    businessDate,
    generatedAt,
    sourceHealth: healthySourceHealth(),
    scoreRefresh: healthyScoreRefresh(),
    queue,
  });

  assert.equal(projection.status, 'ready');
  assert.equal(projection.notificationType, 'normal-digest');
  assert.deepEqual(projection.summary, queue.summary);
  assert.deepEqual(projection.topOpportunities, []);
});

test('daily digest authority never calls CRM CIM follow-up Stage 2 or operator mutation methods', async () => {
  const forbiddenCalls = [];
  const storage = new Proxy({}, {
    get(_target, property) {
      return async () => { forbiddenCalls.push(String(property)); throw new Error(`forbidden ${String(property)}`); };
    },
  });

  const projection = await buildCurrentDailyDealHunterDigest({
    businessDate,
    storage,
    refreshScores: async ({ recordActivity }) => {
      assert.equal(recordActivity, false);
      return healthyScoreRefresh();
    },
    readSourceHealth: async () => healthySourceHealth(),
    readTriageQueue: async () => healthyQueue(),
  });

  assert.equal(projection.notificationType, 'normal-digest');
  assert.deepEqual(forbiddenCalls, []);
});
