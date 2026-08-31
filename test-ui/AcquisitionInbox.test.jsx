// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AcquisitionInbox from '../src/components/admin/AcquisitionInbox.jsx';
import DashboardPage from '../src/pages/DashboardPage.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function detailResponse(row = queueRow()) {
  return {
    opportunity: row, effectiveFacts: {}, operatorFacts: [], sourceObservations: [],
    missingCriticalFields: [], listingUrls: [],
    score: { dimensions: [], summary: {}, confidenceReasons: [], gates: [], appliedCaps: [], missingEvidence: [], unattributedEvidence: [] },
    cimSummary: { requests: [], communications: [] },
    crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
    history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
  };
}

function queueResponse(overrides = {}) {
  return {
    success: true,
    ok: true,
    view: 'needs-review',
    sort: 'acquisition-priority',
    direction: 'desc',
    rows: [],
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    summary: {
      needsReview: 4,
      highPriority: 2,
      watchlist: 3,
      lowConfidence: 1,
      currentOpportunities: 12,
    },
    views: ['needs-review', 'high-priority', 'watchlist', 'low-confidence', 'dismissed', 'all'],
    priorities: ['urgent', 'high', 'normal', 'watch'],
    ...overrides,
  };
}

function queueRow(overrides = {}) {
  return {
    opportunityId: 'opp-1',
    dealKey: 'deal-1',
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
    workflow: { crmStatus: 'active', cimStatus: 'not-requested' },
    observationFreshness: '2026-08-29T17:00:00.000Z',
    operatorPriority: 'normal',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-08-29T17:00:00.000Z',
    scoreFingerprint: 'fingerprint-1',
    rulesVersion: 'deal-hunter-fit-v2',
    ...overrides,
  };
}

function renderInbox(props = {}) {
  return render(
    <MemoryRouter>
      <AcquisitionInbox {...props} />
    </MemoryRouter>,
  );
}

function renderDashboard(path = '/admin/deal-hunter') {
  vi.stubGlobal('React', React);
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<DashboardPage />} path="/admin/:section" />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Acquisition Inbox dashboard entry', () => {
  test('opens Inbox by default and keeps legacy operations separately reachable', async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url === '/api/admin/session') {
        return jsonResponse({
          authenticated: true,
          username: 'admin@example.com',
          role: 'admin',
          authMode: 'hybrid',
          magicLinkEnabled: true,
          passwordEnabled: true,
          viewerAccessEnabled: true,
        });
      }
      if (url.startsWith('/api/admin/deal-hunter/triage?')) return jsonResponse(queueResponse());
      return jsonResponse({ success: false, error: `Unexpected request: ${url}` }, { ok: false, status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard();

    expect(await screen.findByRole('heading', { name: 'Acquisition Inbox' })).toBeVisible();
    expect(within(screen.getByRole('navigation', { name: 'Deal Hunter views' })).getByRole('link', { name: 'Operations' }))
      .toHaveAttribute('href', '/admin/deal-hunter?view=operations');
    expect(await screen.findByText('4')).toBeVisible();
    expect(screen.getAllByText('Needs Review').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        '/api/admin/session',
        expect.stringMatching(/^\/api\/admin\/deal-hunter\/triage\?/),
      ]);
    });
    expect(fetchMock.mock.calls.some(([url]) => /\/review|\/backfill-review|\/send|\/cim-|\/deal-os-import/.test(String(url)))).toBe(false);
  });
});

describe('Acquisition Inbox queue', () => {
  test('renders the acquisition summary and scan-ready opportunity fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(queueResponse({ rows: [
      queueRow(),
      queueRow({
        opportunityId: 'opp-2', dealKey: 'deal-2', name: 'Passed Plumbing', reviewed: true,
        fitScore: 63, confidence: 'medium', operatorPriority: 'normal', scoreStatus: 'watchlist', dismissed: true,
        dismissedReason: 'valuation', observationFreshness: '2026-08-28T17:00:00.000Z',
        geography: { city: 'Pasadena', state: 'CA', label: 'Pasadena, CA' }, industry: 'Plumbing services',
        financials: { annualProfit: 200000, annualRevenue: 1000000, askingPrice: 900000, profitMultiple: 4.5 },
        topStrength: 'Stable service demand.', topConcern: 'Margins need review.',
      }),
    ], total: 2 }))));

    renderInbox();

    expect(await screen.findByRole('button', { name: /Open Evergreen Fire Protection/ })).toBeVisible();
    expect(screen.getByRole('tab', { name: /Needs Review/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Sacramento, CA/)).toBeVisible();
    expect(screen.getByText(/Fire protection services/)).toBeVisible();
    expect(screen.getByText('$425,000')).toBeVisible();
    expect(screen.getByText('$2,200,000')).toBeVisible();
    expect(screen.getByText('$1,800,000')).toBeVisible();
    expect(screen.getByText('4.24×')).toBeVisible();
    expect(screen.getByText('86')).toBeVisible();
    expect(screen.getByText(/high confidence/i)).toBeVisible();
    expect(screen.getByText(/Recurring inspections/)).toBeVisible();
    expect(screen.getByText(/Customer concentration/)).toBeVisible();
    expect(screen.getAllByText(/CRM: Active/)).toHaveLength(2);
    expect(screen.getAllByText(/CIM: Not Requested/i)).toHaveLength(2);
    expect(screen.getByText('Review: Needs Review')).toBeVisible();
    expect(screen.getAllByText('Operator: Normal')).toHaveLength(2);
    expect(screen.getByText('Machine: High Fit')).toBeVisible();
    expect(screen.getByText('Machine: Watchlist')).toBeVisible();
    expect(screen.getByText('Observed Aug 29, 2026')).toBeVisible();
    expect(screen.getByText('Review: Reviewed')).toBeVisible();
    expect(screen.getByText('Passed: Valuation')).toBeVisible();
    const passedRow = screen.getByRole('button', { name: 'Open Passed Plumbing' }).closest('li');
    expect(within(passedRow).queryByRole('button', { name: 'Pursue Passed Plumbing' })).not.toBeInTheDocument();
    expect(within(passedRow).queryByRole('button', { name: 'Watch Passed Plumbing' })).not.toBeInTheDocument();
    expect(within(passedRow).queryByRole('button', { name: 'Pass Passed Plumbing' })).not.toBeInTheDocument();
  });

  test('describes only supported search fields and labels scored-at as newest score', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(queueResponse())));
    renderInbox();
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search opportunities' })).toBeVisible());
    expect(screen.getByRole('searchbox', { name: 'Search opportunities' })).toHaveAttribute('placeholder', 'Business or deal key');
    expect(screen.getByRole('option', { name: 'Newest score' })).toHaveValue('scored-at');
    expect(screen.queryByRole('option', { name: 'Newest observation' })).not.toBeInTheDocument();
  });

  test('keeps the current queue loading while a stale request resolves and finalizes', async () => {
    const first = deferred();
    const second = deferred();
    let queueReads = 0;
    vi.stubGlobal('fetch', vi.fn((input) => {
      if (!String(input).startsWith('/api/admin/deal-hunter/triage?')) throw new Error(`Unexpected request: ${input}`);
      queueReads += 1;
      return queueReads === 1 ? first.promise : second.promise;
    }));

    renderInbox();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'current' } });
    await waitFor(() => expect(queueReads).toBe(2));

    await act(async () => first.resolve(jsonResponse(queueResponse({ rows: [queueRow({ opportunityId: 'opp-stale', name: 'Stale Controls Co' })], total: 1, summary: { ...queueResponse().summary, needsReview: 99 } }))));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Stale Controls Co' })).not.toBeInTheDocument());
    expect(screen.getByText('Loading current opportunities…')).toBeVisible();

    await act(async () => second.resolve(jsonResponse(queueResponse({ rows: [queueRow({ opportunityId: 'opp-current', name: 'Current Controls Co' })], total: 1, summary: { ...queueResponse().summary, needsReview: 7 } }))));
    expect(await screen.findByRole('button', { name: 'Open Current Controls Co' })).toBeVisible();
    expect(screen.getByText('7')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open Current Controls Co' })).toBeVisible();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading current opportunities…')).not.toBeInTheDocument();
  });

  test('refreshes a completed action with the latest visible search and filter controls', async () => {
    const action = deferred();
    const visibleQuery = deferred();
    const queueUrls = [];
    let actionResolved = false;
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1/action')) return action.promise;
      if (!url.startsWith('/api/admin/deal-hunter/triage?')) throw new Error(`Unexpected request: ${url}`);
      queueUrls.push(url);
      if (queueUrls.length === 1) return Promise.resolve(jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
      if (!actionResolved) return visibleQuery.promise;
      const params = new URL(url, 'https://admin.example').searchParams;
      const matchesVisibleControls = params.get('search') === 'fire' && params.get('confidence') === 'low';
      return Promise.resolve(jsonResponse(queueResponse({
        rows: [queueRow({
          opportunityId: matchesVisibleControls ? 'opp-latest' : 'opp-stale',
          name: matchesVisibleControls ? 'Latest Visible Query' : 'Stale Old Query',
        })],
        total: 1,
      })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'fire' } });
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'low' } });
    await waitFor(() => expect(queueUrls.some((url) => url.includes('search=fire') && url.includes('confidence=low'))).toBe(true));

    actionResolved = true;
    await act(async () => action.resolve(jsonResponse({ success: true, action: 'watch' })));

    expect(await screen.findByRole('button', { name: 'Open Latest Visible Query' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open Stale Old Query' })).not.toBeInTheDocument();
    const refreshParams = new URL(queueUrls.at(-1), 'https://admin.example').searchParams;
    expect(refreshParams.get('search')).toBe('fire');
    expect(refreshParams.get('confidence')).toBe('low');
  });

  test('sends search, filters, sorting, and pagination to the paginated queue boundary', async () => {
    const requested = [];
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      requested.push(String(input));
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 51, totalPages: 3 }));
    }));

    renderInbox();
    await screen.findByRole('button', { name: /Open Evergreen Fire Protection/ });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'fire' } });
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Operator priority'), { target: { value: 'watch' } });
    fireEvent.change(screen.getByLabelText('Sort opportunities'), { target: { value: 'fit-score' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes('search=fire'))).toBe(true);
      expect(requested.some((url) => url.includes('confidence=high'))).toBe(true);
      expect(requested.some((url) => url.includes('priority=watch'))).toBe(true);
      expect(requested.some((url) => url.includes('sort=fit-score'))).toBe(true);
      expect(requested.some((url) => url.includes('page=2'))).toBe(true);
    });
    expect(requested[0]).toContain('view=needs-review');
    expect(requested[0]).toContain('sort=acquisition-priority');
  });

  test('records Pursue and Watch only through the bounded action route', async () => {
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        writes.push({ url, method: options.method, body: JSON.parse(options.body) });
        return jsonResponse({ success: true, action: JSON.parse(options.body).action });
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    await screen.findByRole('button', { name: /Open Evergreen Fire Protection/ });
    fireEvent.click(screen.getByRole('button', { name: 'Pursue Evergreen Fire Protection' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    await waitFor(() => expect(writes).toHaveLength(2));

    expect(writes).toEqual([
      { url: '/api/admin/deal-hunter/triage/opp-1/action', method: 'POST', body: { action: 'pursue' } },
      { url: '/api/admin/deal-hunter/triage/opp-1/action', method: 'POST', body: { action: 'watch' } },
    ]);
    expect(writes.some(({ url }) => /send|cim|backfill|refresh|import/.test(url))).toBe(false);
  });

  test('collects a bounded Pass reason and optional note in-app, submits them, then closes the passed drawer', async () => {
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) return jsonResponse(detailResponse());
      if (url.endsWith('/action')) {
        writes.push({ url, body: JSON.parse(options.body) });
        return jsonResponse({ success: true, action: 'pass', disposition: { disposition: 'dismissed' } });
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).getByRole('button', { name: 'Pass Evergreen Fire Protection' }));

    const passForm = screen.getByRole('form', { name: 'Pass Evergreen Fire Protection' });
    const reason = within(passForm).getByLabelText('Pass reason');
    const note = within(passForm).getByLabelText('Pass note (optional)');
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxlength', '80');
    expect(note).toHaveAttribute('maxlength', '2000');
    fireEvent.change(reason, { target: { value: 'valuation' } });
    fireEvent.change(note, { target: { value: 'Price exceeds our return threshold.' } });
    fireEvent.click(within(passForm).getByRole('button', { name: 'Confirm Pass' }));

    await waitFor(() => expect(writes).toEqual([{
      url: '/api/admin/deal-hunter/triage/opp-1/action',
      body: { action: 'pass', reason: 'valuation', note: 'Price exceeds our return threshold.' },
    }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evergreen Fire Protection' })).not.toBeInTheDocument());
  });

  test('cancels a queue-row Pass without issuing an action request', async () => {
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) writes.push(JSON.parse(options.body));
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    const passDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(passDialog).getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.click(within(passDialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Pass Evergreen Fire Protection' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  test('submits queue-row Pass once when the optional note is omitted and submit repeats', async () => {
    const action = deferred();
    const writes = [];
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        writes.push({ url, body: JSON.parse(options.body) });
        return action.promise;
      }
      return Promise.resolve(jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    const passForm = screen.getByRole('form', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(passForm).getByLabelText('Pass reason'), { target: { value: 'not strategic' } });
    fireEvent.submit(passForm);
    fireEvent.submit(passForm);

    await waitFor(() => expect(writes).toEqual([{
      url: '/api/admin/deal-hunter/triage/opp-1/action',
      body: { action: 'pass', reason: 'not strategic', note: '' },
    }]));
    await act(async () => action.resolve(jsonResponse({ success: true, action: 'pass', disposition: { disposition: 'dismissed' } })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pass Evergreen Fire Protection' })).not.toBeInTheDocument());
  });

  test('keeps loaded detail identity aligned with drawer actions when detail reads resolve in reverse order', async () => {
    const detailA = deferred();
    const detailB = deferred();
    const writes = [];
    const rows = [queueRow({ opportunityId: 'opp-a', name: 'Opportunity A' }), queueRow({ opportunityId: 'opp-b', name: 'Opportunity B' })];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-a')) return detailA.promise;
      if (url.endsWith('/triage/opp-b')) return detailB.promise;
      if (url.endsWith('/action')) {
        writes.push({ type: 'action', url });
        return jsonResponse({ success: true, action: JSON.parse(options.body).action });
      }
      if (url === '/api/admin/deal-hunter/opportunities/opp-b/facts/broker_name') {
        writes.push({ type: 'fact', url });
        return jsonResponse({ success: true, fact: { field: 'broker_name', value: 'Broker B', verified: true } });
      }
      return jsonResponse(queueResponse({ rows, total: 2 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Opportunity A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close opportunity detail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Opportunity B' }));

    await act(async () => detailB.resolve(jsonResponse(detailResponse(rows[1]))));
    expect(await screen.findByRole('dialog', { name: 'Opportunity B' })).toBeVisible();
    await act(async () => detailA.resolve(jsonResponse(detailResponse(rows[0]))));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Opportunity A' })).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Opportunity B' })).getByRole('button', { name: 'Watch Opportunity B' }));
    await waitFor(() => expect(writes).toEqual([{ type: 'action', url: '/api/admin/deal-hunter/triage/opp-b/action' }]));
    fireEvent.change(screen.getByLabelText('Verified fact field'), { target: { value: 'broker_name' } });
    fireEvent.change(screen.getByLabelText('Verified fact value'), { target: { value: 'Broker B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save verified fact' }));
    await waitFor(() => expect(writes).toEqual([
      { type: 'action', url: '/api/admin/deal-hunter/triage/opp-b/action' },
      { type: 'fact', url: '/api/admin/deal-hunter/opportunities/opp-b/facts/broker_name' },
    ]));
    expect(writes.some(({ url }) => url.includes('opp-a'))).toBe(false);
  });

  test('refreshes Pursue and Watch detail only while the same loaded opportunity remains selected', async () => {
    let detailLoads = 0;
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) {
        detailLoads += 1;
        return jsonResponse(detailResponse(queueRow({ operatorPriority: detailLoads > 1 ? 'watch' : 'normal', reviewed: detailLoads > 1 })));
      }
      if (url.endsWith('/action')) {
        writes.push(JSON.parse(options.body));
        return jsonResponse({ success: true, action: 'watch' });
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).getByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    await waitFor(() => expect(detailLoads).toBe(2));
    expect(writes).toEqual([{ action: 'watch' }]);
    expect(within(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).getAllByText('Watch')).toHaveLength(2);
  });

  test('does not refresh the old or newly selected detail when selection changes during an action', async () => {
    const action = deferred();
    const detailLoads = { 'opp-a': 0, 'opp-b': 0 };
    const rows = [queueRow({ opportunityId: 'opp-a', name: 'Opportunity A' }), queueRow({ opportunityId: 'opp-b', name: 'Opportunity B' })];
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-a/action')) return action.promise;
      if (url.endsWith('/triage/opp-a')) {
        detailLoads['opp-a'] += 1;
        return Promise.resolve(jsonResponse(detailResponse(rows[0])));
      }
      if (url.endsWith('/triage/opp-b')) {
        detailLoads['opp-b'] += 1;
        return Promise.resolve(jsonResponse(detailResponse(rows[1])));
      }
      return Promise.resolve(jsonResponse(queueResponse({ rows, total: 2 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Opportunity A' }));
    const drawerA = await screen.findByRole('dialog', { name: 'Opportunity A' });
    fireEvent.click(within(drawerA).getByRole('button', { name: 'Watch Opportunity A' }));
    fireEvent.click(within(drawerA).getByRole('button', { name: 'Close opportunity detail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Opportunity B' }));
    expect(await screen.findByRole('dialog', { name: 'Opportunity B' })).toBeVisible();

    await act(async () => action.resolve(jsonResponse({ success: true, action: 'watch' })));
    await waitFor(() => expect(detailLoads).toEqual({ 'opp-a': 1, 'opp-b': 1 }));
    expect(screen.getByRole('dialog', { name: 'Opportunity B' })).toBeVisible();
  });

  test('keeps the queue mounted when an opportunity detail opens and hides writes for viewers', async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) {
        return jsonResponse({
          opportunity: queueRow(), effectiveFacts: {}, operatorFacts: [], sourceObservations: [],
          missingCriticalFields: [], listingUrls: [], score: { dimensions: [], summary: {} },
          cimSummary: { requests: [], communications: [] }, crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
          history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
        });
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderInbox({ readOnly: true });
    fireEvent.click(await screen.findByRole('button', { name: /Open Evergreen Fire Protection/ }));

    expect(await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Open Evergreen Fire Protection/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pursue Evergreen Fire Protection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save verified fact/ })).not.toBeInTheDocument();
  });

  test('saves a verified operator fact through the bounded fact route and refreshes detail', async () => {
    const writes = [];
    let detailLoads = 0;
    const detail = {
      opportunity: queueRow(), effectiveFacts: {}, operatorFacts: [], sourceObservations: [],
      missingCriticalFields: ['broker_name'], listingUrls: [],
      score: { dimensions: [], summary: {}, confidenceReasons: [], gates: [], appliedCaps: [] },
      cimSummary: { requests: [], communications: [] }, crmSummary: { submission: null, communications: [], factObservations: [], conflicts: [] },
      history: { activities: [], dispositions: [], operatorFacts: [], operatorState: {} },
    };
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) {
        detailLoads += 1;
        return jsonResponse(detail);
      }
      if (url === '/api/admin/deal-hunter/opportunities/opp-1/facts/broker_name') {
        writes.push({ method: options.method, body: JSON.parse(options.body) });
        return jsonResponse({ success: true, fact: { field: 'broker_name', value: 'Alex Broker', verified: true } });
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: /Open Evergreen Fire Protection/ }));
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.change(screen.getByLabelText('Verified fact field'), { target: { value: 'broker_name' } });
    fireEvent.change(screen.getByLabelText('Verified fact value'), { target: { value: 'Alex Broker' } });
    fireEvent.change(screen.getByLabelText('Verification note'), { target: { value: 'Confirmed with seller.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save verified fact' }));

    await waitFor(() => expect(writes).toEqual([{
      method: 'PUT',
      body: { value: 'Alex Broker', note: 'Confirmed with seller.', verified: true },
    }]));
    await waitFor(() => expect(detailLoads).toBe(2));
  });
});
