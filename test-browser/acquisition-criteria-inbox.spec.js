import { expect, test } from '@playwright/test';
import { appOrigin } from './app-origin.js';


function mustHaves({ multiple = { outcome: 'pass', observed: 3.2 } } = {}) {
  return [
    { id: 'profit', outcome: 'pass', observed: 420000, limit: { min: 300000, max: 750000 } },
    { id: 'multiple', limit: { max: 4 }, ...multiple },
    { id: 'geography', outcome: 'pass', observed: 'Phoenix, AZ | AZ', targetStates: ['AZ', 'CA'] },
    { id: 'industry', outcome: 'pass', observed: 'Desert HVAC' },
    { id: 'gates', outcome: 'pass', observed: 0 },
  ];
}

function opportunity(overrides = {}) {
  return {
    opportunityId: 'opp-review',
    dealKey: 'deal-review',
    name: 'Desert Air HVAC',
    state: 'AZ',
    listingUrl: 'https://broker.example/desert-air',
    fitScore: 92,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 90,
    missingEvidenceCount: 0,
    contradictionCount: 0,
    shouldRemove: false,
    highFit: true,
    geography: { city: 'Phoenix', state: 'AZ', label: 'Phoenix, AZ' },
    industry: 'HVAC',
    financials: { annualProfit: 420000, annualRevenue: 2000000, askingPrice: 1344000, profitMultiple: 3.2 },
    topStrength: 'Recurring maintenance contracts.',
    topConcern: '',
    workflow: { crmStatus: 'active', cimStatus: 'not-requested' },
    observationFreshness: '2026-11-02T15:00:00.000Z',
    operatorPriority: 'normal',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-11-02T15:00:00.000Z',
    scoreFingerprint: 'criteria-fingerprint',
    rulesVersion: 'deal-hunter-fit-v2',
    criteriaGroup: 'auto',
    criteriaCurrent: true,
    autoPursueBlocker: 'generic_mailbox',
    criteriaResult: { mustHaves: mustHaves(), failed: [], unknown: [] },
    freshness: { discoveryState: 'current', discoveryRevision: 2, materialRevision: 3 },
    ...overrides,
  };
}

const reviewRow = opportunity();
const nearMissRow = opportunity({
  opportunityId: 'opp-near', dealKey: 'deal-near', name: 'Pricey Plumbing', industry: 'Plumbing',
  criteriaGroup: 'near-miss', autoPursueBlocker: '',
  criteriaResult: { mustHaves: mustHaves({ multiple: { outcome: 'fail', observed: 5.1 } }), failed: ['multiple'], unknown: [] },
});

function queueResponse() {
  const areas = [
    { id: 'action-preview', rows: [], total: 0, counts: {} },
    { id: 'auto-pursue', rows: [], total: 0, counts: {} },
    { id: 'your-review', rows: [reviewRow], total: 1, counts: {} },
    { id: 'needs-info', rows: [], total: 0, counts: {} },
    { id: 'near-miss', rows: [nearMissRow], total: 1, counts: {} },
  ];
  return {
    success: true, ok: true, view: 'inbox', sort: 'acquisition-priority', direction: 'desc',
    rows: [reviewRow, nearMissRow], total: 2, page: 1, pageSize: 25, totalPages: 1, areas,
    summary: { needsReview: 2, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 2 },
    views: ['inbox'], priorities: ['urgent', 'high', 'normal', 'watch'],
    dailyDigest: {
      businessDate: '2026-11-02', generatedAt: '2026-11-02T15:00:00.000Z', status: 'ready',
      notificationType: 'normal-digest',
      sourceAuthority: { requiredHealthy: true, blockingIssues: [], optionalWarnings: [] },
      summary: { needsReview: 2, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 2 },
      topOpportunities: [], job: { status: 'completed', attemptCount: 1, completedAt: '2026-11-02T15:02:00.000Z' },
      actionsAllowed: true, links: { inbox: '/admin/deal-hunter', operations: '/admin/deal-hunter?view=operations' },
    },
  };
}

function detailResponse(row) {
  return {
    opportunity: row, effectiveFacts: {}, operatorFacts: [], sourceObservations: [],
    missingCriticalFields: [], listingUrls: [],
    score: { dimensions: [], summary: {}, confidenceReasons: [], gates: [], appliedCaps: [], missingEvidence: [], unattributedEvidence: [] },
    brokerMaterials: { existingRequest: null, pursued: false, preparationBlockers: [], sendBlockers: [], warnings: [], recipientOptions: [] },
    cimSummary: { requests: [], communications: [] },
    crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
    history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
  };
}

const recipientOptions = [
  { recipientContactRef: 'ref-1', email: 'jane@broker.example', displayName: 'Jane Broker', provenance: 'structured_source', provenanceLabel: 'Deal Hunter Sheet', primary: true },
  { recipientContactRef: 'ref-2', email: 'sam@broker.example', displayName: 'Sam Broker', provenance: 'structured_source', provenanceLabel: 'Deal Hunter Sheet', primary: false },
];

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ contentType: 'application/json', status, body: JSON.stringify(body) });
}

// Every API call is answered by the fixture, so nothing here can reach a real
// delivery provider: Request SIM only records the owner command.
async function installFixture(page) {
  const state = { actions: [], unexpected: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== appOrigin) { await route.abort('blockedbyclient'); return; }
    if (url.pathname.startsWith('/api/')) {
      state.unexpected.push({ method: route.request().method(), path: url.pathname });
      await fulfillJson(route, { success: false, error: 'Unexpected API request.' }, 418);
      return;
    }
    await route.continue();
  });
  await page.route(`${appOrigin}/admin/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'document') { await route.fallback(); return; }
    const response = await route.fetch();
    const body = (await response.text()).replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '');
    await route.fulfill({ response, body });
  });
  await page.route('**/api/admin/session', (route) => fulfillJson(route, {
    authenticated: true, username: 'owner@example.test', role: 'admin', authMode: 'hybrid',
    magicLinkEnabled: true, passwordEnabled: true,
  }));
  await page.route('**/api/admin/onboarding', (route) => fulfillJson(route, {
    success: true,
    progress: [
      { tourKey: 'admin-foundations', tourVersion: 1, status: 'completed', lastCompletedStepId: 'foundations-page-guide' },
      { tourKey: 'deal-hunter', tourVersion: 1, status: 'completed', lastCompletedStepId: 'deal-hunter-history' },
    ],
  }));
  await page.route('**/api/admin/deal-hunter/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage') {
      await fulfillJson(route, queueResponse());
    } else if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/pursuing') {
      // The Broker replies block reads the tracker; these fixtures have no pursued deals.
      await fulfillJson(route, { success: true, asOf: '2030-01-07T00:00:00.000Z', counts: { needsAction: 0, byStage: {} }, rows: [], truncated: false });
    } else if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/auto-pursue') {
      await fulfillJson(route, { success: true, mode: 'shadow', dailyCap: 1, todayCommands: 0, warmup: { ready: true }, latestRun: null });
    } else if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage/opp-review') {
      await fulfillJson(route, detailResponse(reviewRow));
    } else if (method === 'POST' && url.pathname === '/api/admin/deal-hunter/triage/opp-review/action') {
      state.actions.push({ path: url.pathname, body: request.postDataJSON() });
      await fulfillJson(route, { success: true, action: 'pursue', enrollment: { state: 'action-required' }, recipientOptions });
    } else if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage/opp-near') {
      await fulfillJson(route, detailResponse(nearMissRow));
    } else if (method === 'POST' && url.pathname === '/api/admin/deal-hunter/triage/opp-near/action') {
      state.actions.push({ path: url.pathname, body: request.postDataJSON() });
      await fulfillJson(route, { success: true, action: 'pursue' });
    } else {
      state.unexpected.push({ method, path: url.pathname });
      await fulfillJson(route, { success: false, error: 'Unexpected Deal Hunter request.' }, 418);
    }
  });
  return state;
}

test('criteria groups list in order and Request SIM on a Your review row shows the Pursue outcome', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto('/admin/deal-hunter');

  const review = page.getByRole('region', { name: 'Your review' });
  await expect(review).toBeVisible();
  await expect(page.getByRole('heading', { level: 3 }).filter({ hasText: /Pursuing automatically|Your review|Needs info|Near misses/ }))
    .toHaveText(['Pursuing automatically', 'Your review', 'Needs info', 'Near misses']);
  await expect(page.getByRole('region', { name: 'Pursuing automatically' }).getByText('Shadow', { exact: true })).toBeVisible();
  await expect(review.getByText('Profit $420K ✓ · 3.2× ✓ · AZ ✓ · HVAC ✓')).toBeVisible();
  await expect(review.getByText('Not automatic: only a generic mailbox')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pursue / })).toHaveCount(0);

  await review.getByRole('button', { name: 'Request SIM Desert Air HVAC' }).click();
  await expect(page.getByLabel('Choose Pursue recipient')).toBeVisible();
  await expect(page.getByText('Choose the authoritative broker recipient to continue Pursue')).toBeVisible();
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0].body).toEqual(expect.objectContaining({ action: 'pursue' }));
  expect(state.unexpected).toEqual([]);
  expect(state.consoleErrors).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('near misses stay collapsed and ask before Request SIM', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto('/admin/deal-hunter');

  const nearMisses = page.getByRole('region', { name: 'Near misses' });
  await expect(nearMisses.getByRole('button', { name: 'Open Pricey Plumbing' })).toHaveCount(0);
  await nearMisses.getByRole('button', { name: 'Show near misses (1)' }).click();
  await expect(nearMisses.getByText('Profit $420K ✓ · Multiple 5.1× (max 4×) · AZ ✓ · Plumbing ✓')).toBeVisible();

  await nearMisses.getByRole('button', { name: 'Request SIM Pricey Plumbing' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('This deal misses the multiple limit. Request the SIM anyway?')).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(state.actions).toHaveLength(0);

  await nearMisses.getByRole('button', { name: 'Request SIM Pricey Plumbing' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Request SIM' }).click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0].body).toEqual(expect.objectContaining({ action: 'pursue' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
  expect(state.consoleErrors).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('a near miss opened in the drawer asks before Request SIM', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto('/admin/deal-hunter');

  await page.getByRole('button', { name: 'Show near misses (1)' }).click();
  await page.getByRole('button', { name: 'Open Pricey Plumbing' }).click();
  const drawer = page.getByRole('dialog', { name: /Pricey Plumbing/ });
  await drawer.getByRole('button', { name: 'Request SIM Pricey Plumbing' }).click();
  const confirm = drawer.getByRole('group', { name: 'Confirm Request SIM' });
  await expect(confirm.getByText('This deal misses the multiple limit. Request the SIM anyway?')).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(state.actions).toHaveLength(0);

  await drawer.getByRole('button', { name: 'Request SIM Pricey Plumbing' }).click();
  await drawer.getByRole('group', { name: 'Confirm Request SIM' }).getByRole('button', { name: 'Request SIM' }).click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0].body).toEqual(expect.objectContaining({ action: 'pursue' }));
  expect(state.unexpected).toEqual([]);
  expect(state.consoleErrors).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
