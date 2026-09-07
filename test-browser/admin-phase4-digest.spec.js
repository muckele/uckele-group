import { expect, test } from '@playwright/test';

const appOrigin = 'http://127.0.0.1:4173';
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

function healthyDigest(mode = 'healthy') {
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
    topOpportunities: briefingRows,
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
    dailyDigest: state.sourceMode === 'required-failure' ? requiredFailureDigest() : healthyDigest(state.sourceMode),
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

function dailyOperationsProjection(mode) {
  const common = {
    businessDate: '2026-09-05',
    notificationType: 'normal-digest',
    prepared: true,
    attemptCount: 2,
    completedAt: '',
    failedAt: '',
    nextRetryAt: '',
    provider: 'resend',
    providerMessageId: 'provider-safe-id-42',
    errorCategory: '',
    reconciliation: { source: 'provider-status', errorCategory: '' },
    markerStatus: 'agreed',
    stale: false,
    attentionRequired: false,
    sourceAuthority: { status: 'healthy' },
    failedCount: 0,
    ambiguousCount: 0,
  };
  if (mode === 'failed') return {
    ...common,
    status: 'failed',
    failedAt: '2026-09-05T15:03:00.000Z',
    nextRetryAt: '2026-09-05T15:18:00.000Z',
    errorCategory: 'provider-temporary',
    failedCount: 1,
  };
  if (mode === 'transmitting') return {
    ...common,
    status: 'transmitting',
    prepared: true,
    markerStatus: 'pending',
    reconciliation: { source: 'provider-status', errorCategory: 'reconciling' },
  };
  if (mode === 'ambiguous') return {
    ...common,
    status: 'ambiguous',
    markerStatus: 'mismatch',
    attentionRequired: true,
    errorCategory: 'provider-identity-conflict',
    reconciliation: { source: 'marker', errorCategory: 'marker-mismatch' },
    ambiguousCount: 1,
  };
  if (mode === 'required-source') return {
    ...common,
    status: 'failed',
    prepared: false,
    notificationType: 'alert',
    failedAt: '2026-09-05T15:01:00.000Z',
    attentionRequired: true,
    sourceAuthority: { status: 'required-source-action-required' },
    failedCount: 1,
  };
  if (mode === 'optional-source') return {
    ...common,
    status: 'completed',
    completedAt: '2026-09-05T15:02:00.000Z',
    sourceAuthority: { status: 'optional-degraded' },
  };
  return { ...common, status: 'completed', completedAt: '2026-09-05T15:02:00.000Z' };
}

function operationsResponse(state) {
  return {
    success: true,
    operations: {
      dailyDigest: dailyOperationsProjection(state.operationsMode),
      scheduler: { runs: [], failures: state.operationsMode === 'failed' ? 1 : 0, pending: state.operationsMode === 'transmitting' ? 1 : 0 },
      sources: { current: { healthy: state.operationsMode !== 'required-source', generatedAt: '2026-09-05T15:00:00.000Z', issues: [] }, history: [] },
      audit: { events: [] },
      cleanup: { jobs: [], failures: [] },
      storage: {
        disk: { ok: true, totalBytes: 1000, freeBytes: 700, usedBytes: 300, freePercent: 70 },
        database: { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 300 },
      },
      backup: { status: 'healthy', message: 'Latest backup verified.', latest: { createdAt: '2026-09-05T10:00:00.000Z', documentCount: 2 } },
      communications: { pending: 0, failed: 0, unassigned: 0 },
      cimAutomation: { configuredStage: 1, evidenceStage: 1, effectiveStage: 1, activationMode: 'off', automaticTransmissionAllowed: false, stage2Readiness: [], safeNextAction: 'Keep Stage 2 off.' },
      cimIdentity: { pause: { paused: true } },
    },
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
    privateJobMetadata: {
      preparedEnvelope: {
        recipient: privateSentinels[0], sender: privateSentinels[1], subject: privateSentinels[2],
        text: privateSentinels[3], html: privateSentinels[4],
      },
      claimToken: privateSentinels[5],
      idempotencyKey: privateSentinels[6],
      rawMetadata: privateSentinels[7],
      providerRawError: privateSentinels[8],
    },
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
    await fulfillJson(route, state, operationsResponse(state));
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
      if (!row || !['pursue', 'watch', 'pass'].includes(body?.action)) {
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

test('healthy administrator sees the server briefing above usable filters and drawer at desktop and mobile widths', async ({ page }) => {
  const state = await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin/deal-hunter');

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  const filters = page.getByRole('searchbox', { name: 'Search opportunities' });
  await expect(briefing).toBeVisible();
  await expectBriefingCounts(page);
  await expect(briefing.getByRole('list', { name: 'Morning briefing opportunities' }).locator('li')).toHaveText([
    /Alpha Fire Systems/,
    /Beta Safety Services/,
  ]);
  expect(await briefing.evaluate((node) => Boolean(node.compareDocumentPosition(document.querySelector('[aria-label="Search opportunities"]')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(filters).toBeVisible();
  await page.getByRole('button', { name: 'Open Alpha Fire Systems' }).click();
  await expect(page.getByRole('dialog', { name: 'Alpha Fire Systems' })).toBeVisible();
  await page.getByRole('button', { name: 'Close opportunity detail' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
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

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  await expectBriefingCounts(page);
  await expect(briefing.getByRole('status', { name: 'Optional source status' })).toHaveText(/Primary Sheet-backed review remains available/);
  await expect(page.getByText('STALE OPTIONAL-ONLY OPPORTUNITY')).toHaveCount(0);
  const watch = page.getByRole('button', { name: 'Watch Alpha Fire Systems' });
  await expect(watch).toBeEnabled();
  await watch.click();
  await expect.poll(() => state.acceptedMutations.length).toBe(1);
  expect(state.acceptedMutations[0].body).toEqual({ action: 'watch' });
  await assertNoOutreachOrAuthoritySideEffects(page, state);
});

test('required source failure suppresses current authority, rejects direct mutation, and recovers only after an authoritative reload', async ({ page }) => {
  const state = await installFixture(page, { sourceMode: 'required-failure' });
  await page.goto('/admin/deal-hunter');

  const briefing = page.getByRole('region', { name: 'Morning briefing' });
  await expect(briefing.getByText('ACTION REQUIRED', { exact: true })).toBeVisible();
  await expect(briefing).toContainText('Current required-source authority is unavailable.');
  await expect(briefing.getByText('Needs Review', { exact: true })).toHaveCount(0);
  await expect(briefing.getByRole('list', { name: 'Morning briefing opportunities' })).toHaveCount(0);
  await expect(page.getByText(/Last known queue/)).toBeVisible();
  for (const action of ['Pursue', 'Watch', 'Pass']) await expect(page.getByRole('button', { name: `${action} Alpha Fire Systems` })).toBeDisabled();

  const directResult = await page.evaluate(async () => {
    const response = await fetch('/api/admin/deal-hunter/triage/opp-phase4-alpha/action', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'watch' }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(directResult).toEqual({
    status: 503,
    body: { success: false, error: 'Current required source authority is unavailable. Try again after source health recovers.' },
  });
  expect(state.acceptedMutations).toEqual([]);
  expect(state.rejectedMutations).toEqual([{ opportunityId: 'opp-phase4-alpha', body: { action: 'watch' }, reason: 'required-source' }]);

  state.sourceMode = 'healthy';
  await page.reload();
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
