import { expect, test } from '@playwright/test';
import { getOperationsCenter, sanitizeViewerOperations } from '../server/services/operations.js';

const appOrigin = 'http://127.0.0.1:4173';
const ownerCommandUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const privateSentinels = [
  'PRIVATE_RECIPIENT_phase4@example.test',
  'PRIVATE_SENDER_phase4@example.test',
  'PRIVATE_SUBJECT_PHASE4',
  'PRIVATE_TEXT_PHASE4',
  '<p>PRIVATE_HTML_PHASE4</p>',
  'PRIVATE_CLAIM_TOKEN_PHASE4',
  'PRIVATE_IDEMPOTENCY_KEY_PHASE4',
  'PRIVATE_RAW_METADATA_PHASE4',
  'PRIVATE_PROVIDER_ERROR_PHASE4',
];
const viewerProviderSentinel = 'viewer-raw-provider-sentinel-9f2';

function opportunity(overrides = {}) {
  return {
    opportunityId: 'opp-phase4-alpha',
    dealKey: 'deal-phase4-alpha',
    name: 'Alpha Fire Systems',
    state: 'CA',
    listingUrl: 'https://broker.example/alpha',
    fitScore: 91,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 92,
    missingEvidenceCount: 1,
    contradictionCount: 0,
    shouldRemove: false,
    highFit: true,
    geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
    industry: 'Fire protection services',
    financials: { annualProfit: 480000, annualRevenue: 2500000, askingPrice: 1900000, profitMultiple: 3.0 },
    topStrength: 'Contracted inspections support recurring demand.',
    topConcern: 'Customer concentration needs confirmation.',
    workflow: { crmStatus: 'active', cimStatus: 'not-requested' },
    observationFreshness: '2026-09-05T14:30:00.000Z',
    operatorPriority: 'urgent',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-09-05T14:30:00.000Z',
    scoreFingerprint: 'phase4-alpha-fingerprint',
    rulesVersion: 'deal-hunter-fit-v2',
    freshness: { discoveryState: 'untracked_legacy', discoveryRevision: 0, materialRevision: 0 },
    ...overrides,
  };
}

const briefingRows = [
  opportunity(),
  opportunity({
    opportunityId: 'opp-phase4-beta',
    dealKey: 'deal-phase4-beta',
    name: 'Beta Safety Services',
    fitScore: 84,
    operatorPriority: 'high',
    topStrength: 'Dense local service routes support efficient operations.',
    topConcern: 'Management transition remains unverified.',
  }),
];

function healthyDigest(mode = 'healthy', rows = briefingRows) {
  const optionalWarnings = mode === 'optional-degraded' ? [{
    sourceId: 'deal-os',
    classification: 'stale',
    title: 'Optional Deal OS stale',
    message: 'Supplemental Deal OS data is not current.',
  }] : [];
  return {
    businessDate: '2026-09-05',
    generatedAt: '2026-09-05T15:00:00.000Z',
    status: 'ready',
    notificationType: 'normal-digest',
    sourceAuthority: { requiredHealthy: true, blockingIssues: [], optionalWarnings },
    summary: { needsReview: 7, highPriority: 5, watchlist: 3, lowConfidence: 2, currentOpportunities: 19 },
    topOpportunities: rows,
    job: { status: 'completed', attemptCount: 1, completedAt: '2026-09-05T15:02:00.000Z', notificationType: 'normal-digest' },
    actionsAllowed: true,
    links: { inbox: '/admin/deal-hunter', operations: '/admin/deal-hunter?view=operations' },
  };
}

function requiredFailureDigest() {
  return {
    businessDate: '2026-09-05',
    generatedAt: '2026-09-05T15:00:00.000Z',
    status: 'action-required',
    notificationType: 'alert',
    sourceAuthority: {
      requiredHealthy: false,
      blockingIssues: [{
        sourceId: 'sheet-0',
        classification: 'unavailable',
        title: 'Required Sheet unavailable',
        message: 'Current required-source authority is unavailable.',
      }],
      optionalWarnings: [],
    },
    summary: null,
    topOpportunities: [],
    job: { status: 'completed', attemptCount: 1, completedAt: '2026-09-05T15:02:00.000Z', notificationType: 'alert' },
    actionsAllowed: false,
    links: { inbox: '/admin/deal-hunter', operations: '/admin/deal-hunter?view=operations' },
  };
}

function queueResponse(state) {
  const rows = state.rows.map((row) => ({ ...row }));
  return {
    success: true,
    ok: true,
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    summary: { needsReview: rows.length, highPriority: rows.length, watchlist: 0, lowConfidence: 0, currentOpportunities: rows.length },
    views: ['needs-review', 'high-priority', 'watchlist', 'low-confidence', 'dismissed', 'all'],
    priorities: ['urgent', 'high', 'normal', 'watch'],
    dailyDigest: state.sourceMode === 'required-failure' ? requiredFailureDigest() : healthyDigest(state.sourceMode, state.briefingRows),
  };
}

function detailResponse(row) {
  return {
    opportunity: row,
    effectiveFacts: {},
    operatorFacts: [],
    sourceObservations: [],
    missingCriticalFields: [],
    listingUrls: [],
    score: { dimensions: [], summary: {}, confidenceReasons: [], gates: [], appliedCaps: [], missingEvidence: [], unattributedEvidence: [] },
    brokerMaterials: { existingRequest: null, pursued: false, preparationBlockers: [], sendBlockers: [], warnings: [], recipientOptions: [] },
    cimSummary: { requests: [], communications: [] },
    crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
    history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
  };
}

function rawOperationsJob(state) {
  const failed = state.operationsMode === 'failed' || state.operationsMode === 'required-source';
  const transmitting = state.operationsMode === 'transmitting';
  const ambiguous = state.operationsMode === 'ambiguous';
  const completed = !failed && !transmitting && !ambiguous;
  return {
    job_key: 'daily-deal-hunter-email:2026-09-05',
    job_name: 'daily-deal-hunter-email',
    status: failed ? 'failed' : transmitting ? 'transmitting' : ambiguous ? 'ambiguous' : 'completed',
    created_at: '2026-09-05T15:00:00.000Z',
    started_at: '2026-09-05T15:00:30.000Z',
    updated_at: '2026-09-05T15:03:00.000Z',
    completed_at: completed ? '2026-09-05T15:02:00.000Z' : null,
    attempt_count: 2,
    provider_message_id: state.role === 'viewer' ? viewerProviderSentinel : 'provider-safe-id-42',
    last_error: privateSentinels[8],
    metadata: {
      businessDate: '2026-09-05',
      notificationType: state.operationsMode === 'required-source' ? 'required-source-alert' : 'normal-digest',
      provider: 'resend',
      payloadDigest: 'a'.repeat(64),
      failedAt: failed ? '2026-09-05T15:03:00.000Z' : '',
      nextRetryAt: state.operationsMode === 'failed' ? '2026-09-05T15:18:00.000Z' : '',
      failureCategory: failed ? 'provider-temporary' : '',
      reconciliation: transmitting
        ? { checkedAt: '2026-09-05T15:03:00.000Z', source: 'provider-status', errorCategory: 'reconciling', severity: '' }
        : ambiguous
          ? { checkedAt: '2026-09-05T15:03:00.000Z', source: 'marker', errorCategory: 'marker-mismatch', severity: 'high' }
          : { checkedAt: '2026-09-05T15:02:00.000Z', source: 'provider-status', errorCategory: '', severity: '' },
      recipient: privateSentinels[0],
      sender: privateSentinels[1],
      subject: privateSentinels[2],
      text: privateSentinels[3],
      html: privateSentinels[4],
      claimToken: privateSentinels[5],
      idempotencyKey: privateSentinels[6],
      rawMetadata: privateSentinels[7],
      preparedEnvelope: {
        to: privateSentinels[0],
        from: privateSentinels[1],
        subject: privateSentinels[2],
        text: privateSentinels[3],
        html: privateSentinels[4],
        idempotencyKey: privateSentinels[6],
      },
      providerResponse: { error: privateSentinels[8] },
    },
  };
}

async function operationsResponse(state) {
  const rawJob = rawOperationsJob(state);
  state.rawOperationsJob = rawJob;
  const optionalIssue = state.operationsMode === 'optional-source'
    ? [{ sourceId: 'deal-os', affectsHealth: false }]
    : [];
  const requiredIssue = state.operationsMode === 'required-source'
    ? [{ sourceId: 'sheet-0', affectsHealth: true }]
    : [];
  const operations = await getOperationsCenter({
    now: new Date('2026-09-05T16:00:00.000Z'),
    config: {
      storage: { provider: 'sqlite', sqlitePath: '/tmp/phase4-browser.sqlite' },
      delivery: { provider: 'resend' },
      dealHunter: { dailyEmail: { timezone: 'America/Los_Angeles', time: '08:00', markerDir: '' }, cimFollowUp: {} },
    },
    storage: {
      async listScheduledJobs() { return [rawJob]; },
      async listAdminAuditEvents() { return []; },
      async listSecureDocumentCleanupJobs() { return []; },
      async listSourceHealthSnapshots() { return []; },
    },
    checks: {
      async sourceHealth() {
        return {
          generatedAt: '2026-09-05T15:00:00.000Z',
          healthy: state.operationsMode !== 'required-source',
          issues: [...requiredIssue, ...optionalIssue],
          sources: [],
          totals: {},
        };
      },
      async disk() { return { ok: true, totalBytes: 1000, freeBytes: 700, usedBytes: 300, freePercent: 70 }; },
      async database() { return { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 300 }; },
      async backup() { return { status: 'healthy', message: 'Latest backup verified.', latest: { createdAt: '2026-09-05T10:00:00.000Z', documentCount: 2 } }; },
      async emailReadiness() { return { provider: 'resend', issues: [] }; },
      async cimAutomation() { return { configuredStage: 1, evidenceStage: 1, effectiveStage: 1, activationMode: 'off', automaticTransmissionAllowed: false, stage2Readiness: [], safeNextAction: 'Keep Stage 2 off.', metrics: {}, policy: {} }; },
      async communications() { return { pending: 0, failed: 0, unassigned: 0 }; },
      async cimIdentity() { return { pause: { paused: true }, storageHealthy: true }; },
    },
  });
  return {
    success: true,
    operations: state.role === 'viewer' ? sanitizeViewerOperations(operations) : operations,
  };
}

function createFixtureState({ role = 'admin', sourceMode = 'healthy', operationsMode = 'completed' } = {}) {
  return {
    role,
    sourceMode,
    operationsMode,
    rows: [opportunity()],
    acceptedMutations: [],
    rejectedMutations: [],
    apiRequests: [],
    unexpectedRequests: [],
    offOriginRequests: [],
    responseBodies: [],
    consoleErrors: [],
    pageErrors: [],
    sideEffects: { dailyDigest: 0, crm: 0, cim: 0, broker: 0, followUp: 0, stage2: 0, provider: 0, scoreRefresh: 0 },
  };
}

function recordRequest(state, request) {
  const url = new URL(request.url());
  const record = { method: request.method(), path: url.pathname, search: url.search };
  state.apiRequests.push(record);
  return record;
}

async function fulfillJson(route, state, body, status = 200) {
  const serialized = JSON.stringify(body);
  state.responseBodies.push(serialized);
  await route.fulfill({ contentType: 'application/json', status, body: serialized });
}

async function installFixture(page, options = {}) {
  const state = createFixtureState(options);
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname.startsWith('/api/')) recordRequest(state, request);
    if (url.origin !== appOrigin) state.offOriginRequests.push({ method: request.method(), url: request.url() });
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      state.unexpectedRequests.push({ method: request.method(), path: url.pathname, search: url.search });
      await fulfillJson(route, state, { success: false, error: 'Unexpected Phase 4 API request.' }, 418);
      return;
    }
    await route.continue();
  });

  await page.route(`${appOrigin}/admin/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'document') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '');
    await route.fulfill({ response, body });
  });

  await page.route('**/api/admin/session', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      state.unexpectedRequests.push(recordRequest(state, request));
      await fulfillJson(route, state, { success: false, error: 'Unexpected session mutation.' }, 418);
      return;
    }
    await fulfillJson(route, state, {
      authenticated: true,
      username: `phase4-${state.role}`,
      role: state.role,
      authMode: 'hybrid',
      magicLinkEnabled: true,
      passwordEnabled: true,
    });
  });

  await page.route('**/api/admin/onboarding', async (route) => {
    await fulfillJson(route, state, {
      success: true,
      progress: [
        { tourKey: 'admin-foundations', tourVersion: 1, status: 'completed', lastCompletedStepId: 'foundations-page-guide' },
        { tourKey: 'deal-hunter', tourVersion: 1, status: 'completed', lastCompletedStepId: 'deal-hunter-history' },
      ],
    });
  });

  await page.route('**/api/admin/operations', async (route) => {
    if (route.request().method() !== 'GET') {
      state.unexpectedRequests.push({ method: route.request().method(), path: '/api/admin/operations', search: '' });
      await fulfillJson(route, state, { success: false, error: 'Operations is read-only.' }, 418);
      return;
    }
    await fulfillJson(route, state, await operationsResponse(state));
  });

  await page.route('**/api/admin/deal-hunter/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const detailMatch = url.pathname.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)$/);
    const actionMatch = url.pathname.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/action$/);
    if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage') {
      await fulfillJson(route, state, queueResponse(state));
      return;
    }
    if (method === 'GET' && detailMatch) {
      const row = state.rows.find((item) => item.opportunityId === decodeURIComponent(detailMatch[1]));
      await fulfillJson(route, state, row ? detailResponse(row) : { success: false, error: 'Not found.' }, row ? 200 : 404);
      return;
    }
    if (method === 'POST' && actionMatch) {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      const attempt = { opportunityId: decodeURIComponent(actionMatch[1]), body };
      if (state.role !== 'admin') {
        state.rejectedMutations.push({ ...attempt, reason: 'viewer' });
        await fulfillJson(route, state, { success: false, error: 'Administrator access is required.' }, 403);
        return;
      }
      if (state.sourceMode === 'required-failure') {
        state.rejectedMutations.push({ ...attempt, reason: 'required-source' });
        await fulfillJson(route, state, { success: false, error: 'Current required source authority is unavailable. Try again after source health recovers.' }, 503);
        return;
      }
      const row = state.rows.find((item) => item.opportunityId === attempt.opportunityId);
      const expectedKeys = ['action', 'expectedDiscoveryRevision', 'expectedMaterialRevision',
        'idempotencyKey', ...(body?.action === 'pass' ? ['note', 'reason'] : [])];
      if (!row || !['pursue', 'watch', 'pass'].includes(body?.action)
        || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)
        || typeof body.idempotencyKey !== 'string'
        || !ownerCommandUuidPattern.test(body.idempotencyKey)
        || !Number.isSafeInteger(body.expectedDiscoveryRevision)
        || !Number.isSafeInteger(body.expectedMaterialRevision)
        || body.expectedDiscoveryRevision !== row.freshness.discoveryRevision
        || body.expectedMaterialRevision !== row.freshness.materialRevision
        || (body.action === 'pass' && (typeof body.reason !== 'string'
          || !body.reason.trim() || typeof body.note !== 'string'))) {
        state.rejectedMutations.push({ ...attempt, reason: 'invalid' });
        await fulfillJson(route, state, { success: false, error: 'Invalid decision.' }, 400);
        return;
      }
      row.reviewed = true;
      row.operatorPriority = body.action === 'watch' ? 'watch' : row.operatorPriority;
      state.acceptedMutations.push(attempt);
      await fulfillJson(route, state, { success: true, ok: true, action: body.action, opportunity: row });
      return;
    }
    state.unexpectedRequests.push({ method, path: url.pathname, search: url.search });
    await fulfillJson(route, state, { success: false, error: 'Unexpected Deal Hunter request.' }, 418);
  });

  return state;
}

function assertNoPrivateProjection(state) {
  const serialized = state.responseBodies.join('\n');
  for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
  if (state.role === 'viewer') expect(serialized).not.toContain(viewerProviderSentinel);
  expect(serialized).not.toContain('preparedEnvelope');
}

async function assertNoOutreachOrAuthoritySideEffects(page, state) {
  expect(state.sideEffects).toEqual({ dailyDigest: 0, crm: 0, cim: 0, broker: 0, followUp: 0, stage2: 0, provider: 0, scoreRefresh: 0 });
  const prohibited = /(?:daily-deal-hunter|\/send(?:\/|$)|broker-materials|cim-|follow-up|stage2|crm-sync|score|backfill|refresh)/i;
  expect(state.apiRequests.filter(({ path }) => prohibited.test(path))).toEqual([]);
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.offOriginRequests).toEqual([]);
  const expectedRequiredSourceRejection = state.rejectedMutations.some(({ reason }) => reason === 'required-source');
  const unexpectedConsoleErrors = state.consoleErrors.filter((message) => !(
    expectedRequiredSourceRejection
    && message === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
  ));
  expect(unexpectedConsoleErrors).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  assertNoPrivateProjection(state);
}

async function expectBriefingCounts(page) {
  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  for (const [label, value] of [['Needs Review', '7'], ['High Priority', '5'], ['Watchlist', '3'], ['Low Confidence', '2'], ['Current Opportunities', '19']]) {
    const labelNode = briefing.getByText(label, { exact: true });
    await expect(labelNode.locator('..')).toContainText(value);
  }
}

const queueTabs = [['inbox', 'Fresh-first Inbox'], ['needs-review', 'Needs Review'], ['high-priority', 'High Priority'], ['watchlist', 'Watchlist'], ['low-confidence', 'Low Confidence'], ['dismissed', 'Passed'], ['all', 'All Current']];

for (const width of [1920, 390]) {
  test(`queue navigation remains present across all tabs, history and empty results at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1080 });
    const state = await installFixture(page);
    await page.route('**/api/admin/deal-hunter/triage?*', async route => {
      const params = new URL(route.request().url()).searchParams;
      const view = params.get('view');
      const label = queueTabs.find(([id]) => id === view)[1];
      const rows = params.get('search') ? [] : [opportunity({ name: `Navigation result ${label}`, dismissed: view === 'dismissed' })];
      await fulfillJson(route, state, { ...queueResponse(state), view, rows, total: rows.length,
        areas: view === 'inbox' ? [{ id: 'new-important', total: rows.length, rows, counts: {}, revision: 'navigation' }] : undefined });
    });
    await page.goto('/admin/deal-hunter');
    const tabs = page.getByRole('tablist', { name: 'Opportunity queues' });
    const observations = [];
    for (const [id, label] of queueTabs) {
      if (id !== 'inbox') {
        const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/triage') && new URL(r.url()).searchParams.get('view') === id);
        await tabs.getByRole('tab', { name: label, exact: true }).click();
        await response;
      }
      await expect(page.getByRole('button', { name: `Open Navigation result ${label}`, exact: true })).toBeVisible();
      observations.push({ view: id, url: page.url(), header: await page.getByRole('heading', { name: 'Acquisition Inbox', exact: true }).count(),
        areaNavigation: await page.getByRole('navigation', { name: 'Fresh Inbox areas' }).count(),
        tabs: await tabs.count(), search: await page.getByRole('searchbox', { name: 'Search opportunities' }).count(),
        briefing: await page.getByRole('region', { name: 'Morning briefing' }).count(),
        controlsBeforeBriefing: await page.getByRole('searchbox', { name: 'Search opportunities' }).evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[aria-labelledby=morning-briefing-heading]')) & Node.DOCUMENT_POSITION_FOLLOWING)) });
      await page.screenshot({ path: testInfo.outputPath(`navigation-${id}-${width}.png`) });
    }
    await testInfo.attach('navigation-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
    for (const observation of observations) expect(observation).toMatchObject({ header: 1, areaNavigation: 1, tabs: 1, search: 1, briefing: 1, controlsBeforeBriefing: true });
    for (let index = queueTabs.length - 2; index >= 0; index -= 1) {
      await page.goBack();
      await expect(tabs.getByRole('tab', { name: queueTabs[index][1], exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: `Open Navigation result ${queueTabs[index][1]}`, exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Fresh Inbox areas' })).toBeVisible();
    }
    for (let index = 1; index < queueTabs.length; index += 1) {
      await page.goForward();
      await expect(tabs.getByRole('tab', { name: queueTabs[index][1], exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: `Open Navigation result ${queueTabs[index][1]}`, exact: true })).toBeVisible();
    }
    for (const [id, label] of queueTabs) {
      await tabs.getByRole('tab', { name: label, exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search opportunities' }).fill('empty-query');
      await expect(page.getByText(id === 'inbox' ? 'No opportunities in this area.' : 'No opportunities in this view.', { exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Fresh Inbox areas' })).toBeVisible();
      await expect(tabs.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('searchbox', { name: 'Search opportunities' }).fill('');
    }
    await page.getByRole('button', { name: 'New & Important', exact: true }).click();
    await expect(tabs.getByRole('tab', { name: 'Fresh-first Inbox', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(tabs.getByRole('tab', { name: 'Fresh-first Inbox', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'Fresh Inbox areas' })).toBeVisible();
    await assertNoOutreachOrAuthoritySideEffects(page, state);
  });
}

test('queue history resets pagination and inbox cursors before fetching the restored view', async ({ page }, testInfo) => {
  const state = await installFixture(page);
  const requests = [];
  await page.route('**/api/admin/deal-hunter/triage?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const view = params.get('view');
    const pageNumber = Number(params.get('page'));
    const area = params.get('area');
    const cursor = params.get('cursor');
    requests.push({ view, page: pageNumber, area, cursor });
    const rows = [opportunity({ name: `History ${view} ${area || 'queue'} page ${pageNumber}${cursor ? ' continued' : ''}` })];
    await fulfillJson(route, state, { ...queueResponse(state), view, rows, page: pageNumber, total: 75, totalPages: 3,
      areas: view === 'inbox' ? [{ id: area === 'inbox' ? 'new-important' : area, total: 75, rows,
        nextCursor: cursor ? '' : 'history-next-cursor', counts: {}, revision: 'history' }] : undefined });
  });
  const expectHistoryRow = (name) => expect(page.getByRole('button', { name: `Open ${name}`, exact: true })).toBeVisible();
  await page.goto('/admin/deal-hunter');
  await expectHistoryRow('History inbox inbox page 1');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await expectHistoryRow('History inbox research page 1');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectHistoryRow('History inbox research page 1 continued');
  await page.getByRole('tab', { name: 'High Priority', exact: true }).click();
  await expectHistoryRow('History high-priority queue page 1');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectHistoryRow('History high-priority queue page 2');
  await page.getByRole('tab', { name: 'Watchlist', exact: true }).click();
  await expectHistoryRow('History watchlist queue page 1');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectHistoryRow('History watchlist queue page 2');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectHistoryRow('History watchlist queue page 3');
  let start = requests.length;
  await page.goBack();
  await expectHistoryRow('History high-priority queue page 1');
  expect(requests.slice(start).length).toBeGreaterThan(0);
  expect(requests.slice(start).every(request => request.view === 'high-priority' && request.page === 1 && request.area === null && request.cursor === null)).toBe(true);
  start = requests.length;
  await page.goBack();
  await expectHistoryRow('History inbox inbox page 1');
  expect(requests.slice(start).length).toBeGreaterThan(0);
  expect(requests.slice(start).every(request => request.view === 'inbox' && request.page === 1 && request.area === 'inbox' && request.cursor === null)).toBe(true);
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await expectHistoryRow('History inbox research page 1');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expectHistoryRow('History inbox research page 1 continued');
  start = requests.length;
  await page.goForward();
  await expectHistoryRow('History high-priority queue page 1');
  expect(requests.slice(start).length).toBeGreaterThan(0);
  expect(requests.slice(start).every(request => request.view === 'high-priority' && request.page === 1 && request.area === null && request.cursor === null)).toBe(true);
  start = requests.length;
  await page.goBack();
  await expectHistoryRow('History inbox inbox page 1');
  expect(requests.slice(start).length).toBeGreaterThan(0);
  expect(requests.slice(start).every(request => request.view === 'inbox' && request.page === 1 && request.area === 'inbox' && request.cursor === null)).toBe(true);
  await page.getByRole('tab', { name: 'Watchlist', exact: true }).click();
  await expectHistoryRow('History watchlist queue page 1');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await expectHistoryRow('History inbox research page 1');
  await expect(page.getByRole('button', { name: 'Research', exact: true })).toHaveAttribute('aria-current', 'page');
  await testInfo.attach('history-pagination-requests', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

for (const mode of ['required-failure', 'optional-degraded', 'queue-unavailable']) {
  test(`queue navigation and recovery controls remain available with ${mode}`, async ({ page }) => {
    const state = await installFixture(page, { sourceMode: mode === 'queue-unavailable' ? 'healthy' : mode });
    if (mode === 'queue-unavailable') await page.route('**/api/admin/deal-hunter/triage?*', route => fulfillJson(route, state, { success: false, error: 'Synthetic queue unavailable.' }, 503));
    await page.goto('/admin/deal-hunter');
    for (const [, label] of queueTabs) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Acquisition Inbox', exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Fresh Inbox areas' })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Opportunity queues' })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Search opportunities' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Confidence', exact: true })).toBeVisible();
      const briefing = page.getByRole('region', { name: 'Morning briefing' });
      if (mode === 'required-failure') {
        await expect(briefing.getByText('ACTION REQUIRED', { exact: true })).toBeVisible();
        await expect(briefing.getByRole('link', { name: 'Open Operations' })).toBeVisible();
        await expect(briefing.getByRole('list', { name: 'Morning briefing opportunities' })).toHaveCount(0);
      } else if (mode === 'optional-degraded') {
        await expect(briefing.getByRole('status', { name: 'Optional source status' })).toBeVisible();
      } else {
        await expect(page.getByRole('alert')).toContainText('Synthetic queue unavailable.');
        await expect(page.getByRole('button', { name: label === 'Fresh-first Inbox' ? 'Refresh this area' : 'Retry loading opportunities', exact: true })).toBeVisible();
      }
    }
    if (mode !== 'queue-unavailable') await assertNoOutreachOrAuthoritySideEffects(page, state);
    else {
      expect(state.pageErrors).toEqual([]);
      expect(state.consoleErrors.every(message => message === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)')).toBe(true);
      expect(state.apiRequests.every(request => request.method === 'GET')).toBe(true);
      expect(state.offOriginRequests).toEqual([]);
      expect(state.unexpectedRequests).toEqual([]);
    }
  });
}

for (const [width, columns] of [[2560, 3], [1920, 3], [1440, 2], [1280, 2], [1024, 1], [390, 1], [320, 1]]) {
  test(`priority shortlist uses ${columns} readable columns at ${width}px with aligned actions`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1080 });
    const state = await installFixture(page);
    state.rows = Array.from({ length: 5 }, (_, index) => opportunity({
      opportunityId: `tile-${index}`, dealKey: `tile-deal-${index}`,
      name: index === 2 ? 'Regional Fire Inspection and Suppression Services with Long Established Customer Relationships' : `Priority business ${index + 1}`,
      listingUrl: index === 3 ? '' : `https://broker.example/tile-${index}`,
      topStrength: index === 0 ? 'Recurring inspections.' : 'Recurring commercial inspection contracts and dense service routes support continued demand.',
      topConcern: index === 0 ? '' : 'Customer concentration and the proposed management transition require supporting evidence before pursuit.',
      contradictionCount: index === 1 ? 2 : 0,
    }));
    state.briefingRows = state.rows;
    await page.goto('/admin/deal-hunter');
    const list = page.getByRole('list', { name: 'Morning briefing opportunities', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(5);
    const layout = await list.evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      cards: [...element.children].map((card) => {
        const bounds = card.getBoundingClientRect();
        const button = card.querySelector('button[aria-label^="Pursue shortlist lead"]');
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          actionY: button.getBoundingClientRect().y,
          titlePx: parseFloat(getComputedStyle(card.querySelector('button[aria-label^="Open shortlist lead"]')).fontSize),
          bodyPx: parseFloat(getComputedStyle([...card.querySelectorAll('p')].find(p => p.textContent.startsWith('Why it fits:'))).fontSize),
          overflow: card.scrollWidth > card.clientWidth };
      }),
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      zoom: getComputedStyle(document.documentElement).zoom,
    }));
    expect(layout.columns).toBe(columns);
    expect(layout.documentOverflow).toBe(false);
    expect(layout.zoom).toBe('1');
    for (const card of layout.cards) {
      expect(card.titlePx).toBeGreaterThanOrEqual(16);
      expect(card.bodyPx).toBeGreaterThanOrEqual(14);
      expect(card.overflow).toBe(false);
      if (columns > 1) expect(card.width).toBeGreaterThanOrEqual(400);
    }
    for (let index = 0; index < layout.cards.length; index += columns) {
      const row = layout.cards.slice(index, index + columns);
      for (const card of row) {
        expect(Math.abs(card.y - row[0].y)).toBeLessThan(1);
        expect(Math.abs(card.height - row[0].height)).toBeLessThan(1);
        expect(Math.abs(card.actionY - row[0].actionY)).toBeLessThan(1);
      }
    }
    expect((await page.locator('.admin-workspace-shell').boundingBox()).width).toBe(width);
    await testInfo.attach('priority-layout', { body: JSON.stringify({ width, ...layout }, null, 2), contentType: 'application/json' });
    await list.screenshot({ path: testInfo.outputPath(`priority-tiles-${width}.png`) });
    assertNoPrivateProjection(state);
    await assertNoOutreachOrAuthoritySideEffects(page, state);
    expect(state.consoleErrors).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test('healthy administrator can reach the legacy briefing and drawer at desktop and mobile widths', async ({ page }) => {
  const state = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin/deal-hunter');
  await page.getByRole('tab', { name: 'Needs Review' }).click();

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  const filters = page.getByRole('searchbox', { name: 'Search opportunities' });
  await expect(briefing).toBeVisible();
  await expectBriefingCounts(page);
  await expect(briefing.getByRole('list', { name: 'Morning briefing opportunities' }).locator('li')).toHaveText([
    /Alpha Fire Systems/,
    /Beta Safety Services/,
  ]);
  await expect(filters).toBeVisible();
  await page.getByRole('button', { name: 'Open Alpha Fire Systems' }).click();
  await expect(page.getByRole('dialog', { name: 'Alpha Fire Systems' })).toBeVisible();
  await page.getByRole('button', { name: 'Close opportunity detail' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('tab', { name: 'Needs Review' }).click();
  await expect(briefing).toBeVisible();
  await expectBriefingCounts(page);
  await expect(filters).toBeVisible();
  const overflow = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

test('optional Deal OS degradation stays bounded and leaves primary-backed review usable', async ({ page }) => {
  const state = await installFixture(page, { sourceMode: 'optional-degraded' });
  await page.goto('/admin/deal-hunter');
  await page.getByRole('tab', { name: 'Needs Review' }).click();

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  await expectBriefingCounts(page);
  await expect(briefing.getByRole('status', { name: 'Optional source status' })).toHaveText(/Primary Sheet-backed review remains available/);
  await expect(page.getByText('STALE OPTIONAL-ONLY OPPORTUNITY')).toHaveCount(0);
  const watch = page.getByRole('button', { name: 'Watch Alpha Fire Systems' });
  await expect(watch).toBeEnabled();
  await watch.click();
  await expect.poll(() => state.acceptedMutations.length).toBe(1);
  const command = state.acceptedMutations[0].body;
  expect(command.action).toBe('watch');
  expect(command.idempotencyKey).toMatch(ownerCommandUuidPattern);
  expect(command.expectedDiscoveryRevision).toBe(state.rows[0].freshness.discoveryRevision);
  expect(command.expectedMaterialRevision).toBe(state.rows[0].freshness.materialRevision);
  expect(Object.keys(command).sort()).toEqual(['action', 'expectedDiscoveryRevision',
    'expectedMaterialRevision', 'idempotencyKey']);
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

test('required source failure suppresses current authority, rejects direct mutation, and recovers only after an authoritative reload', async ({ page }) => {
  const state = await installFixture(page, { sourceMode: 'required-failure' });
  await page.goto('/admin/deal-hunter');
  await page.getByRole('tab', { name: 'Needs Review' }).click();

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  await expect(briefing.getByText('ACTION REQUIRED', { exact: true })).toBeVisible();
  await expect(briefing).toContainText('Current required-source authority is unavailable.');
  await expect(briefing.getByText('Needs Review', { exact: true })).toHaveCount(0);
  await expect(briefing.getByRole('list', { name: 'Morning briefing opportunities' })).toHaveCount(0);
  await expect(page.getByText(/Last known queue/)).toBeVisible();
  for (const action of ['Pursue', 'Watch', 'Pass']) await expect(page.getByRole('button', { name: `${action} Alpha Fire Systems` })).toBeDisabled();

  const directCommand = { action: 'watch', idempotencyKey: globalThis.crypto.randomUUID(),
    expectedDiscoveryRevision: state.rows[0].freshness.discoveryRevision,
    expectedMaterialRevision: state.rows[0].freshness.materialRevision };
  const directResult = await page.evaluate(async (command) => {
    const response = await fetch('/api/admin/deal-hunter/triage/opp-phase4-alpha/action', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    return { status: response.status, body: await response.json() };
  }, directCommand);
  expect(directResult).toEqual({
    status: 503,
    body: { success: false, error: 'Current required source authority is unavailable. Try again after source health recovers.' },
  });
  expect(state.acceptedMutations).toEqual([]);
  expect(state.rejectedMutations).toEqual([{ opportunityId: 'opp-phase4-alpha', body: directCommand, reason: 'required-source' }]);

  state.sourceMode = 'healthy';
  await page.reload();
  await page.getByRole('tab', { name: 'Needs Review' }).click();
  await expect(briefing.getByText('ACTION REQUIRED', { exact: true })).toHaveCount(0);
  await expectBriefingCounts(page);
  await expect(page.getByRole('button', { name: 'Watch Alpha Fire Systems' })).toBeEnabled();
  expect(state.acceptedMutations).toEqual([]);
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

test('viewer can read briefing and sanitized Operations but has no mutation or digest-send controls', async ({ page }) => {
  const state = await installFixture(page, { role: 'viewer' });
  await page.goto('/admin/deal-hunter');

  await expectBriefingCounts(page);
  await expect(page.getByText('Read-only access: decisions and verified-fact edits are unavailable.')).toBeVisible();
  for (const action of ['Pursue', 'Watch', 'Pass']) await expect(page.getByRole('button', { name: new RegExp(`^${action} `) })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Run Daily Digest|Send Daily Digest|Retry Daily Digest|Send Again/i })).toHaveCount(0);

  await page.goto('/admin/operations');
  await expect(page.getByRole('heading', { name: 'Daily Digest status' })).toBeVisible();
  await expect(page.getByText('Source authority: HEALTHY')).toBeVisible();
  await expect(page.getByRole('button', { name: /Run Daily Digest|Send Daily Digest|Retry Daily Digest|Send Again/i })).toHaveCount(0);
  const rawOperationsInput = JSON.stringify(state.rawOperationsJob);
  for (const sentinel of privateSentinels) expect(rawOperationsInput).toContain(sentinel);
  expect(rawOperationsInput).toContain(viewerProviderSentinel);
  const interceptedOperations = state.responseBodies.filter((body) => body.includes('"dailyDigest"')).join('\n');
  for (const sentinel of [...privateSentinels, viewerProviderSentinel]) expect(interceptedOperations).not.toContain(sentinel);
  const visibleOperations = await page.locator('body').innerText();
  for (const sentinel of [...privateSentinels, viewerProviderSentinel]) expect(visibleOperations).not.toContain(sentinel);
  expect(state.acceptedMutations).toEqual([]);
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

test('Operations presents completed, retry, reconciling, ambiguous, and source-authority states without private data or resend actions', async ({ page }) => {
  const state = await installFixture(page, { operationsMode: 'completed' });
  await page.goto('/admin/operations');
  const card = page.getByRole('heading', { name: 'Daily Digest status' }).locator('..');

  await expect(card).toContainText('Completed');
  await expect(card).toContainText('Source authority: HEALTHY');
  await expect(card).toContainText('provider-safe-id-42');

  state.operationsMode = 'failed';
  await page.reload();
  await expect(card).toContainText('Failed');
  await expect(card).toContainText('Retry is scheduled');

  state.operationsMode = 'transmitting';
  await page.reload();
  await expect(card).toContainText('Transmitting');
  await expect(card).toContainText('Provider Status');

  state.operationsMode = 'ambiguous';
  await page.reload();
  await expect(card).toContainText('HIGH ATTENTION · Ambiguous');
  await expect(card.getByRole('alert')).toHaveText(/Do not send another digest/);

  state.operationsMode = 'required-source';
  await page.reload();
  await expect(card).toContainText('Source authority: REQUIRED SOURCE ACTION REQUIRED');

  state.operationsMode = 'optional-source';
  await page.reload();
  await expect(card).toContainText('Source authority: OPTIONAL DEGRADED');
  await expect(page.getByRole('button', { name: /Run Daily Digest|Send Daily Digest|Retry Daily Digest|Send Again/i })).toHaveCount(0);

  const visibleText = await page.locator('body').innerText();
  for (const sentinel of privateSentinels) expect(visibleText).not.toContain(sentinel);
  expect(visibleText).not.toContain('preparedEnvelope');
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});
