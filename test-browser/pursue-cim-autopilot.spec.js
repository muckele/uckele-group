import { expect, test } from '@playwright/test';

const appOrigin = 'http://127.0.0.1:4173';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function opportunity() {
  return {
    opportunityId: 'opp-p8a',
    dealKey: 'deal-p8a',
    name: 'Evergreen Fire Protection',
    state: 'CA',
    listingUrl: 'https://broker.example/evergreen',
    fitScore: 86,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 88,
    missingEvidenceCount: 1,
    contradictionCount: 0,
    shouldRemove: false,
    highFit: true,
    geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
    industry: 'Fire protection services',
    financials: { annualProfit: 425000, annualRevenue: 2200000, askingPrice: 1800000, profitMultiple: 4.24 },
    topStrength: 'Recurring inspections support durable demand.',
    topConcern: 'Customer concentration is not provided.',
    workflow: { crmStatus: 'active', cimStatus: 'requested' },
    observationFreshness: '2026-10-01T15:00:00.000Z',
    operatorPriority: 'high',
    reviewed: true,
    reviewedAt: '2026-10-01T15:00:00.000Z',
    reviewedBy: 'owner@example.test',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-10-01T15:00:00.000Z',
    scoreFingerprint: 'p8a-fingerprint',
    rulesVersion: 'deal-hunter-fit-v2',
    freshness: { discoveryState: 'current', discoveryRevision: 2, materialRevision: 3 },
  };
}

function queueResponse() {
  const row = opportunity();
  return {
    success: true,
    ok: true,
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    rows: [row],
    total: 1,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    summary: { needsReview: 1, highPriority: 1, watchlist: 0, lowConfidence: 0, currentOpportunities: 1 },
    views: ['needs-review', 'high-priority', 'watchlist', 'low-confidence', 'dismissed', 'all'],
    priorities: ['urgent', 'high', 'normal', 'watch'],
    dailyDigest: {
      businessDate: '2026-10-01',
      generatedAt: '2026-10-01T15:00:00.000Z',
      status: 'ready',
      notificationType: 'normal-digest',
      sourceAuthority: { requiredHealthy: true, blockingIssues: [], optionalWarnings: [] },
      summary: { needsReview: 1, highPriority: 1, watchlist: 0, lowConfidence: 0, currentOpportunities: 1 },
      topOpportunities: [row],
      job: { status: 'completed', attemptCount: 1, completedAt: '2026-10-01T15:02:00.000Z' },
      actionsAllowed: true,
      links: { inbox: '/admin/deal-hunter', operations: '/admin/deal-hunter?view=operations' },
    },
  };
}

function detailResponse() {
  return {
    opportunity: opportunity(),
    effectiveFacts: {},
    operatorFacts: [],
    sourceObservations: [],
    missingCriticalFields: [],
    listingUrls: [],
    score: { dimensions: [], summary: {}, confidenceReasons: [], gates: [], appliedCaps: [], missingEvidence: [], unattributedEvidence: [] },
    brokerMaterials: { existingRequest: null, pursued: true, preparationBlockers: [], sendBlockers: [], warnings: [], recipientOptions: [] },
    cimSummary: { requests: [], communications: [] },
    crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
    history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
    pursueCimReleaseAvailable: true,
  };
}

function activeRelease() {
  return {
    projectedAt: '2026-10-01T15:05:00.000Z',
    opportunity: { id: 'opp-p8a', name: 'Evergreen Fire Protection', state: 'active' },
    status: { code: 'awaiting_live_authorization', reason: '', actionRequired: true },
    enrollment: { state: 'campaign-created', reasonCode: '' },
    campaign: {
      id: 'campaign-p8a', generation: 1, state: 'initial-pending', reasonCode: '',
      rowVersion: 4, terminalRevision: 0, policyVersion: 'deal-hunter-cim-autopilot-v1',
      templateVersion: 'template-v1', localExpiryAt: '',
    },
    recipientAuthority: {
      address: 'broker@example.test', authorityId: 'recipient-authority', fingerprint: '2'.repeat(64),
      permissionVersion: 'activation-p8a', permissionDigest: '3'.repeat(64), permissionRevision: 7,
      permissionScope: 'cohort-p8a',
    },
    timezoneAuthority: {
      state: 'verified', ianaTimezone: 'America/Los_Angeles', revision: 3,
      selectedRevision: 3, current: true,
    },
    initialTouch: {
      id: 'touch-p8a', state: 'prepared', dueAt: '2026-10-01T16:00:00.000Z',
      dueLocal: '2026-10-01T09:00:00-07:00', rowVersion: 2,
    },
    transmission: {
      id: 'transmission-p8a', state: 'prepared', releaseState: 'awaiting-live-authorization',
      rowVersion: 2, preparationGeneration: 1, payloadVersion: 'payload-v1',
      payloadDigest: '4'.repeat(64), memberDigest: '5'.repeat(64),
      addressing: {
        from: 'buyer@example.test', to: ['broker@example.test'],
        cc: ['observer@example.test'], bcc: ['audit@example.test'],
        replyTo: 'reply@example.test',
      },
      copy: {
        subject: 'Persisted CIM subject', text: 'Exact persisted body.',
        html: '<p>Exact persisted body.</p>',
      },
      membership: [{
        opportunityId: 'opp-p8a', campaignId: 'campaign-p8a', touchId: 'touch-p8a',
        displayOrdinal: 1, cancelledAt: '', cancellationReason: '',
      }],
      providerOutcome: null,
    },
    liveAuthorization: null,
    activation: {
      id: 'activation-p8a', capability: 'fl04b-enrollment', mode: 'canary', status: 'current',
      expiresAt: '2026-10-02T15:00:00.000Z', matchesCampaign: true,
    },
    pause: { paused: true, source: 'operations-control' },
    actions: {
      canStop: true, campaignId: 'campaign-p8a', expectedRowVersion: 4,
      expectedTerminalRevision: 0,
    },
  };
}

function stoppedRelease() {
  const active = activeRelease();
  return {
    ...active,
    status: { code: 'campaign_stopped', reason: 'campaign_stopped', actionRequired: false },
    campaign: {
      ...active.campaign, state: 'stopped', reasonCode: 'campaign_stopped',
      rowVersion: 5, terminalRevision: 1,
    },
    initialTouch: { ...active.initialTouch, state: 'cancelled-before-provider' },
    actions: { canStop: false },
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ contentType: 'application/json', status, body: JSON.stringify(body) });
}

async function installFixture(page) {
  const state = { requests: [], stopCommands: [], unexpected: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname.startsWith('/api/')) {
      state.requests.push({ method: request.method(), path: url.pathname });
    }
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      state.unexpected.push({ method: request.method(), path: url.pathname });
      await fulfillJson(route, { success: false, error: 'Unexpected P8A API request.' }, 418);
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

  await page.route('**/api/admin/session', (route) => fulfillJson(route, {
    authenticated: true,
    username: 'owner@example.test',
    role: 'admin',
    authMode: 'hybrid',
    magicLinkEnabled: true,
    passwordEnabled: true,
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
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage/opp-p8a') {
      await fulfillJson(route, detailResponse());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/admin/deal-hunter/triage/opp-p8a/cim-release') {
      await fulfillJson(route, activeRelease());
      return;
    }
    if (method === 'POST' && url.pathname === '/api/admin/deal-hunter/triage/opp-p8a/cim-release/stop') {
      const command = request.postDataJSON();
      state.stopCommands.push(command);
      await fulfillJson(route, { success: true, ok: true, report: stoppedRelease() });
      return;
    }
    state.unexpected.push({ method, path: url.pathname });
    await fulfillJson(route, { success: false, error: 'Unexpected Deal Hunter request.' }, 418);
  });
  return state;
}

test('owner sees persisted canary evidence and can only issue the bounded stop command', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto('/admin/deal-hunter');
  await page.getByRole('tab', { name: 'Needs Review' }).click();
  await page.getByRole('button', { name: 'Open Evergreen Fire Protection' }).click();

  const card = page.getByRole('region', { name: 'Pursue CIM canary' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Persisted CIM subject');
  await expect(card).toContainText('Exact persisted body.');
  await expect(card).toContainText('buyer@example.test → broker@example.test');
  await expect(card).toContainText('CC observer@example.test');
  await expect(card).toContainText('BCC audit@example.test');
  await expect(card).toContainText('opp-p8a · campaign-p8a · touch-p8a');
  await expect(card.getByText('Not issued', { exact: true })).toBeVisible();
  await expect(card).toContainText('Campaign expiry is established after initial provider acceptance.');
  await expect(card).toContainText('America/Los_Angeles');
  await expect(card.getByRole('button', { name: /retry|send again|regenerate|authorize|resume/i })).toHaveCount(0);

  await card.getByRole('button', { name: 'Stop CIM campaign' }).click();
  await expect(card).toContainText('Campaign Stopped');
  await expect(card.getByRole('button', { name: 'Stop CIM campaign' })).toHaveCount(0);

  expect(state.stopCommands).toHaveLength(1);
  expect(state.stopCommands[0]).toEqual({
    campaignId: 'campaign-p8a',
    expectedRowVersion: 4,
    expectedTerminalRevision: 0,
    reason: 'Owner stopped the canary from its durable release report.',
    idempotencyKey: expect.stringMatching(uuidPattern),
  });
  expect(state.requests.filter(({ method }) => method !== 'GET')).toEqual([
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-p8a/cim-release/stop' },
  ]);
  expect(state.unexpected).toEqual([]);
  expect(state.consoleErrors).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
