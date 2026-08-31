// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AcquisitionInbox from '../src/components/admin/AcquisitionInbox.jsx';
import DashboardPage from '../src/pages/DashboardPage.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }))));

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
    expect(screen.getByText(/CRM: Active/)).toBeVisible();
    expect(screen.getByText(/CIM: Not Requested/i)).toBeVisible();
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

  test('records Pursue, Watch, and Pass only through the bounded action route', async () => {
    const writes = [];
    vi.stubGlobal('prompt', vi.fn(() => 'valuation'));
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
    fireEvent.click(screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    await waitFor(() => expect(writes).toHaveLength(3));

    expect(writes).toEqual([
      { url: '/api/admin/deal-hunter/triage/opp-1/action', method: 'POST', body: { action: 'pursue' } },
      { url: '/api/admin/deal-hunter/triage/opp-1/action', method: 'POST', body: { action: 'watch' } },
      { url: '/api/admin/deal-hunter/triage/opp-1/action', method: 'POST', body: { action: 'pass', reason: 'valuation' } },
    ]);
    expect(writes.some(({ url }) => /send|cim|backfill|refresh|import/.test(url))).toBe(false);
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
