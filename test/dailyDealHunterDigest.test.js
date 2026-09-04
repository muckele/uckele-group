import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DAILY_DEAL_HUNTER_DIGEST_VERSION,
  DAILY_DEAL_HUNTER_TOP_LIMIT,
  buildCurrentDailyDealHunterDigest,
  projectDailyDealHunterDigest,
} = await import('../server/services/dailyDealHunterDigest.js');
const { listTriageQueue } = await import('../server/services/dealHunterTriage.js');

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

function assertActionRequired(projection) {
  assert.equal(projection.status, 'action-required');
  assert.equal(projection.notificationType, 'required-source-alert');
  assert.equal(projection.actionsAllowed, false);
  assert.equal(projection.summary, null);
  assert.deepEqual(projection.topOpportunities, []);
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

test('daily digest alert never includes raw refresh source-health or queue diagnostics', async (t) => {
  const diagnostic = 'Acme Solar opp-secret broker@example.invalid 555-0101 $1300000 Authorization: Bearer TOPSECRET /srv/private/app.js:99';
  const cases = [
    {
      name: 'score refresh exception',
      expectedMessage: 'Current opportunity scores could not be refreshed.',
      dependencies: {
        refreshScores: async () => { throw new Error(diagnostic); },
      },
    },
    {
      name: 'source-health exception',
      expectedMessage: 'Required source data is currently unavailable.',
      dependencies: {
        refreshScores: async () => healthyScoreRefresh(),
        readSourceHealth: async () => { throw new Error(diagnostic); },
      },
    },
    {
      name: 'queue exception',
      expectedMessage: 'Current acquisition queue could not be built.',
      dependencies: {
        refreshScores: async () => healthyScoreRefresh(),
        readSourceHealth: async () => healthySourceHealth(),
        readTriageQueue: async () => { throw new Error(diagnostic); },
      },
    },
    {
      name: 'required-source issue',
      expectedMessage: 'Required source data is currently unavailable.',
      dependencies: {
        refreshScores: async () => healthyScoreRefresh(),
        readSourceHealth: async () => healthySourceHealth({
          healthy: false,
          sources: healthyReview().sources.map((source) => source.required
            ? { ...source, name: diagnostic, fetched: false, rowCount: 0 }
            : source),
          issues: [{
            sourceId: 'google-sheet-1',
            sourceName: diagnostic,
            affectsHealth: true,
            sourceUnavailable: true,
            title: diagnostic,
            message: diagnostic,
            error: diagnostic,
          }],
        }),
      },
    },
  ];

  for (const { name, expectedMessage, dependencies } of cases) {
    await t.test(name, async () => {
      const projection = await buildCurrentDailyDealHunterDigest({
        businessDate,
        storage: {},
        refreshScores: async () => healthyScoreRefresh(),
        readSourceHealth: async () => healthySourceHealth(),
        readTriageQueue: async () => healthyQueue(),
        ...dependencies,
      });

      assertActionRequired(projection);
      const serialized = JSON.stringify(projection);
      assert.doesNotMatch(
        serialized,
        /Acme Solar|opp-secret|broker@example\.invalid|555-0101|1300000|TOPSECRET|private\/app\.js/,
      );
      assert.ok(
        projection.sourceAuthority.blockingIssues.some((issue) => issue.message === expectedMessage),
        JSON.stringify(projection.sourceAuthority.blockingIssues),
      );
    });
  }
});

test('malformed digest authority fails closed without fabricated counts or rows', async (t) => {
  const missingSummaryField = healthyQueue();
  delete missingSummaryField.summary.currentOpportunities;
  const stringSummaryCount = healthyQueue();
  stringSummaryCount.summary.needsReview = '2';
  const nanSummaryCount = healthyQueue();
  nanSummaryCount.summary.highPriority = Number.NaN;
  const negativeSummaryCount = healthyQueue();
  negativeSummaryCount.summary.watchlist = -1;

  const cases = [
    ['incomplete source health', { sourceHealth: { healthy: true }, queue: healthyQueue() }],
    ['empty summary', { sourceHealth: healthySourceHealth(), queue: { ...healthyQueue(), summary: {} } }],
    ['missing summary field', { sourceHealth: healthySourceHealth(), queue: missingSummaryField }],
    ['string summary count', { sourceHealth: healthySourceHealth(), queue: stringSummaryCount }],
    ['NaN summary count', { sourceHealth: healthySourceHealth(), queue: nanSummaryCount }],
    ['negative summary count', { sourceHealth: healthySourceHealth(), queue: negativeSummaryCount }],
    ['empty object row', { sourceHealth: healthySourceHealth(), queue: healthyQueue([{}]) }],
    ['null row', { sourceHealth: healthySourceHealth(), queue: healthyQueue([null]) }],
    ['empty opportunity ID', {
      sourceHealth: healthySourceHealth(),
      queue: healthyQueue([queueRow(1, { opportunityId: '' })]),
    }],
    ['missing display identity', {
      sourceHealth: healthySourceHealth(),
      queue: healthyQueue([queueRow(1, { name: undefined })]),
    }],
    ['string fit score', {
      sourceHealth: healthySourceHealth(),
      queue: healthyQueue([queueRow(1, { fitScore: '89' })]),
    }],
    ['missing workflow', {
      sourceHealth: healthySourceHealth(),
      queue: healthyQueue([queueRow(1, { workflow: null })]),
    }],
  ];

  for (const [name, { sourceHealth, queue }] of cases) {
    await t.test(name, async () => {
      const inputs = {
        businessDate,
        generatedAt,
        sourceHealth,
        scoreRefresh: healthyScoreRefresh(),
        queue,
      };
      const direct = await Promise.resolve().then(() => projectDailyDealHunterDigest(inputs));
      const built = await buildCurrentDailyDealHunterDigest({
        businessDate,
        storage: {},
        refreshScores: async () => inputs.scoreRefresh,
        readSourceHealth: async () => sourceHealth,
        readTriageQueue: async () => queue,
      });

      for (const projection of [direct, built]) {
        assertActionRequired(projection);
        const serialized = JSON.stringify(projection);
        assert.doesNotMatch(serialized, /Unnamed opportunity/);
        assert.doesNotMatch(serialized, /"needsReview":0/);
        assert.ok(
          projection.sourceAuthority.blockingIssues.some((issue) => (
            issue.classification === 'authority-invalid'
            || issue.classification === 'queue-unavailable'
          )),
          JSON.stringify(projection.sourceAuthority.blockingIssues),
        );
      }
    });
  }
});

test('digest projection never serializes malformed timestamp diagnostics', async (t) => {
  const diagnostic = 'Acme Solar opp-secret broker@example.invalid 555-0101 $1300000 Authorization: Bearer TOPSECRET /srv/private/app.js:99';
  const unsafePattern = /Acme Solar|opp-secret|broker@example\.invalid|555-0101|1300000|TOPSECRET|private\/app\.js/;

  await t.test('source-health generatedAt', async () => {
    const projection = await buildCurrentDailyDealHunterDigest({
      businessDate,
      storage: {},
      refreshScores: async () => healthyScoreRefresh(),
      readSourceHealth: async () => healthySourceHealth({ generatedAt: diagnostic }),
      readTriageQueue: async () => healthyQueue(),
    });

    assertActionRequired(projection);
    assert.equal(projection.generatedAt, generatedAt);
    assert.doesNotMatch(JSON.stringify(projection), unsafePattern);
  });

  await t.test('source issue checkedAt', () => {
    const projection = projectDailyDealHunterDigest({
      businessDate,
      generatedAt,
      sourceHealth: healthySourceHealth({
        healthy: false,
        sources: healthyReview().sources.map((source) => source.required
          ? { ...source, fetched: false, rowCount: 0 }
          : source),
        issues: [{
          sourceId: 'google-sheet-1',
          affectsHealth: true,
          sourceUnavailable: true,
          checkedAt: diagnostic,
        }],
      }),
      scoreRefresh: healthyScoreRefresh(),
      queue: healthyQueue(),
    });

    assertActionRequired(projection);
    assert.equal(projection.sourceAuthority.blockingIssues[0].checkedAt, '');
    assert.doesNotMatch(JSON.stringify(projection), unsafePattern);
  });

  await t.test('explicit projector generatedAt', () => {
    const projection = projectDailyDealHunterDigest({
      businessDate,
      generatedAt: diagnostic,
      sourceHealth: healthySourceHealth(),
      scoreRefresh: healthyScoreRefresh(),
      queue: healthyQueue(),
    });

    assertActionRequired(projection);
    assert.equal(projection.generatedAt, '');
    assert.doesNotMatch(JSON.stringify(projection), unsafePattern);
  });

  await t.test('opportunity observation freshness', () => {
    const projection = projectDailyDealHunterDigest({
      businessDate,
      generatedAt,
      sourceHealth: healthySourceHealth(),
      scoreRefresh: healthyScoreRefresh(),
      queue: healthyQueue([queueRow(1, { observationFreshness: diagnostic })]),
    });

    assert.doesNotMatch(JSON.stringify(projection), unsafePattern);
  });

  await t.test('job completion timestamp', () => {
    const projection = projectDailyDealHunterDigest({
      businessDate,
      generatedAt,
      sourceHealth: healthySourceHealth(),
      scoreRefresh: healthyScoreRefresh(),
      queue: healthyQueue(),
      job: { status: 'pending', attemptCount: 1, completedAt: diagnostic },
    });

    assert.equal(projection.job.completedAt, '');
    assert.doesNotMatch(JSON.stringify(projection), unsafePattern);
  });

  for (const invalid of ['2026-02-30T15:00:00.000Z', Number.NaN, Number.POSITIVE_INFINITY]) {
    await t.test(`invalid explicit timestamp ${String(invalid)}`, () => {
      const projection = projectDailyDealHunterDigest({
        businessDate,
        generatedAt: invalid,
        sourceHealth: healthySourceHealth(),
        scoreRefresh: healthyScoreRefresh(),
        queue: healthyQueue(),
      });

      assertActionRequired(projection);
      assert.equal(projection.generatedAt, '');
    });
  }
});

test('digest projection normalizes valid timestamps deterministically', () => {
  const offsetTimestamp = '2026-09-05T08:00:00-07:00';
  const normal = projectDailyDealHunterDigest({
    businessDate,
    generatedAt: offsetTimestamp,
    sourceHealth: healthySourceHealth(),
    scoreRefresh: healthyScoreRefresh(),
    queue: healthyQueue([queueRow(1, { observationFreshness: offsetTimestamp })]),
    job: { status: 'completed', attemptCount: 1, completedAt: offsetTimestamp },
  });
  const alert = projectDailyDealHunterDigest({
    businessDate,
    generatedAt: offsetTimestamp,
    sourceHealth: healthySourceHealth({
      healthy: false,
      sources: healthyReview().sources.map((source) => source.required
        ? { ...source, fetched: false, rowCount: 0 }
        : source),
      issues: [{
        sourceId: 'google-sheet-1',
        affectsHealth: true,
        sourceUnavailable: true,
        checkedAt: offsetTimestamp,
      }],
    }),
    scoreRefresh: healthyScoreRefresh(),
    queue: healthyQueue(),
  });

  assert.equal(normal.generatedAt, generatedAt);
  assert.equal(normal.topOpportunities[0].observationFreshness, generatedAt);
  assert.equal(normal.job.completedAt, generatedAt);
  assert.equal(alert.generatedAt, generatedAt);
  assert.equal(alert.sourceAuthority.blockingIssues[0].checkedAt, generatedAt);
  assert.deepEqual(
    projectDailyDealHunterDigest({
      businessDate,
      generatedAt: offsetTimestamp,
      sourceHealth: healthySourceHealth(),
      scoreRefresh: healthyScoreRefresh(),
      queue: healthyQueue([queueRow(1, { observationFreshness: offsetTimestamp })]),
      job: { status: 'completed', attemptCount: 1, completedAt: offsetTimestamp },
    }),
    normal,
  );
});

test('daily digest rejects the real triage adapter missing-name fallback', async () => {
  const queue = await listTriageQueue({
    storage: {
      listDealHunterOpportunityScores: async () => ({
        rows: [{
          opportunity_id: 'opp-real-adapter',
          deal_key: 'real-adapter-deal',
          name: null,
          state: 'CA',
          fit_score: 90,
          score_status: 'qualified',
          confidence: 'high',
          completeness_score: 90,
          missing_evidence_count: 0,
          contradiction_count: 0,
          should_remove: false,
          high_fit: true,
          top_strength: 'Strong fit',
          top_concern: '',
          observation_freshness: generatedAt,
          operator_priority: 'normal',
          reviewed: false,
          changed_since_review: false,
          crm_status: 'not-started',
          cim_status: 'not-requested',
          scored_at: generatedAt,
        }],
        total: 1,
        page: 1,
        pageSize: 5,
        totalPages: 1,
        summary: {
          needsReview: 1,
          highPriority: 1,
          watchlist: 0,
          lowConfidence: 0,
          currentOpportunities: 1,
        },
      }),
    },
    getCachedSourceHealth: async () => healthySourceHealth(),
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    page: 1,
    pageSize: 5,
  });

  assert.equal(queue.rows[0].name, 'Unnamed opportunity');
  const projection = await buildCurrentDailyDealHunterDigest({
    businessDate,
    storage: {},
    refreshScores: async () => healthyScoreRefresh(),
    readSourceHealth: async () => healthySourceHealth(),
    readTriageQueue: async () => queue,
  });

  assertActionRequired(projection);
  assert.doesNotMatch(JSON.stringify(projection), /Unnamed opportunity/);
});

test('daily digest projector rejects the exact triage missing-name fallback', () => {
  const projection = projectDailyDealHunterDigest({
    businessDate,
    generatedAt,
    sourceHealth: healthySourceHealth(),
    scoreRefresh: healthyScoreRefresh(),
    queue: healthyQueue([queueRow(1, { name: 'Unnamed opportunity' })]),
  });

  assertActionRequired(projection);
  assert.doesNotMatch(JSON.stringify(projection), /Unnamed opportunity/);
});

test('daily digest keeps legitimate names without creating a broader name policy', async (t) => {
  for (const name of ['Acme', 'Acme Field Services LLC', '123 Industries, Inc.']) {
    await t.test(name, () => {
      const projection = projectDailyDealHunterDigest({
        businessDate,
        generatedAt,
        sourceHealth: healthySourceHealth(),
        scoreRefresh: healthyScoreRefresh(),
        queue: healthyQueue([queueRow(1, { name })]),
      });

      assert.equal(projection.status, 'ready');
      assert.equal(projection.actionsAllowed, true);
      assert.equal(projection.topOpportunities[0].name, name);
    });
  }
});
