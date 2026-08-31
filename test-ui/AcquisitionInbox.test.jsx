// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function activateWithKeyboard(control, key = 'Enter') {
  control.focus();
  const keyDown = createEvent.keyDown(control, { key, code: key === ' ' ? 'Space' : key });
  fireEvent(control, keyDown);
  const keyUp = createEvent.keyUp(control, { key, code: key === ' ' ? 'Space' : key });
  fireEvent(control, keyUp);
  if (!keyDown.defaultPrevented && control instanceof HTMLButtonElement && (key === 'Enter' || key === ' ')) {
    fireEvent.click(control, { detail: 0 });
  }
}

function typeWithKeyboard(control, text) {
  control.focus();
  for (const key of text) {
    fireEvent.keyDown(control, { key });
    fireEvent.input(control, { target: { value: `${control.value}${key}` } });
    fireEvent.keyUp(control, { key });
  }
}

function selectWithKeyboard(control, value) {
  control.focus();
  fireEvent.keyDown(control, { key: 'ArrowDown', code: 'ArrowDown' });
  fireEvent.input(control, { target: { value } });
  fireEvent.change(control, { target: { value } });
  fireEvent.keyUp(control, { key: 'ArrowDown', code: 'ArrowDown' });
}

function expectMobileReachable(control, container) {
  expect(control).toBeVisible();
  expect(control).not.toHaveAttribute('hidden');
  expect(control).not.toHaveAttribute('aria-hidden', 'true');
  for (let node = control; node && node !== document.body; node = node.parentElement) {
    const className = typeof node.className === 'string' ? node.className : '';
    expect(node).not.toHaveAttribute('hidden');
    expect(node).not.toHaveAttribute('aria-hidden', 'true');
    expect(className).not.toMatch(/(?:^|\s)(?:hidden|max-sm:hidden)(?:\s|$)/);
  }
  expect(container.contains(control)).toBe(true);
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

  test('keeps the authoritative Passed state visible when the post-success queue refresh fails', async () => {
    // Break caught: a successful Pass followed by a failed queue reload leaves
    // the stale actionable row mounted even though the server has durably
    // dismissed it.
    let queueReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        return jsonResponse({
          success: true,
          action: 'pass',
          disposition: { disposition: 'dismissed', reason: 'valuation' },
          opportunity: queueRow({ reviewed: true, dismissed: true, dismissedReason: 'valuation' }),
        });
      }
      queueReads += 1;
      return queueReads === 1
        ? jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }))
        : jsonResponse({ success: false, error: 'Authoritative queue refresh is unavailable.' }, { ok: false, status: 503 });
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    const form = screen.getByRole('form', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(form).getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm Pass' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pass Evergreen Fire Protection' })).not.toBeInTheDocument());
    expect(await screen.findByText('Passed: Valuation')).toBeVisible();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('alert')).toHaveTextContent('Authoritative queue refresh is unavailable.');
  });

  test('retains the authoritative Watch result when both post-success queue and detail refreshes fail', async () => {
    // Break caught: post-success refresh failures replace the successful
    // server result with stale queue controls and an empty detail drawer.
    let queueReads = 0;
    let detailReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        return jsonResponse({ success: true, action: 'watch', opportunity: queueRow({ reviewed: true, operatorPriority: 'watch' }) });
      }
      if (url.endsWith('/triage/opp-1')) {
        detailReads += 1;
        return detailReads === 1
          ? jsonResponse(detailResponse())
          : jsonResponse({ error: 'Authoritative detail refresh is unavailable.' }, { ok: false, status: 503 });
      }
      queueReads += 1;
      return queueReads === 1
        ? jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }))
        : jsonResponse({ success: false, error: 'Authoritative queue refresh is unavailable.' }, { ok: false, status: 503 });
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Watch Evergreen Fire Protection' }));

    expect(await within(drawer).findByText('Reviewed · Current')).toBeVisible();
    expect(within(drawer).getAllByText('Operator state')[0].parentElement).toHaveTextContent('Watch');
    expect(within(drawer).getByRole('alert')).toHaveTextContent('Authoritative detail refresh is unavailable.');
    expect(screen.getByText('Review: Reviewed')).toBeVisible();
    expect(screen.getAllByText('Operator: Watch')).toHaveLength(1);
  });

  test('keeps a persisted queue usable with a degraded cached-source warning and makes no prohibited read-flow request', async () => {
    const requests = [];
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/action')) {
        writes.push(JSON.parse(options.body));
        return jsonResponse({ success: true, action: 'watch' });
      }
      return jsonResponse(queueResponse({
        rows: [queueRow()], total: 1,
        sourceHealth: { healthy: false, cached: true, issues: [{ title: 'Deal OS is stale', message: 'The last cached export is stale.' }] },
      }));
    }));

    renderInbox();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Deal OS is stale.*last cached export is stale/i);
    expect(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'evergreen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    await waitFor(() => expect(writes).toEqual([{ action: 'watch' }]));
    expect(requests.every((url) => url.startsWith('/api/admin/deal-hunter/triage'))).toBe(true);
    expect(requests.some((url) => /\/refresh|\/backfill|\/import|\/send|\/stage.?2|\/outreach|\/cim-/i.test(url))).toBe(false);
  });

  test('keeps queue context in place when detail fails and retries the selected canonical opportunity only', async () => {
    const reads = [];
    let detailAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      reads.push(url);
      if (url.endsWith('/triage/opp-1')) {
        detailAttempts += 1;
        return detailAttempts === 1
          ? jsonResponse({ error: 'Detail service is temporarily unavailable.' }, { ok: false, status: 503 })
          : jsonResponse(detailResponse());
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Opportunity detail' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Detail service is temporarily unavailable.');
    expect(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry opportunity detail' }));
    expect(await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    expect(reads.filter((url) => url.endsWith('/triage/opp-1'))).toHaveLength(2);
    expect(reads.some((url) => /\/refresh|\/backfill|\/import|\/send|stage.?2|\/outreach|\/cim-/i.test(url))).toBe(false);
  });

  test('keeps queue Pass input and durable queue content visible after a failed write, then releases the lock for one retry', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [];
    const reads = [];
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        writes.push(JSON.parse(options.body));
        return writes.length === 1 ? first.promise : second.promise;
      }
      reads.push(url);
      return Promise.resolve(jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    const queuePass = await screen.findByRole('button', { name: 'Pass Evergreen Fire Protection' });
    expect(screen.getByText('Review: Needs Review')).toBeVisible();
    expect(screen.getAllByText('Operator: Normal')).toHaveLength(1);
    expect(screen.queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(screen.getByRole('button', { name: action })).toBeEnabled();
    }
    fireEvent.click(queuePass);
    const dialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(dialog).getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.change(within(dialog).getByLabelText('Pass note (optional)'), { target: { value: 'Retain the existing record.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Pass' }));
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await act(async () => first.resolve(jsonResponse({ success: false, error: 'Pass could not be saved.' }, { ok: false, status: 409 })));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Pass could not be saved.');
    expect(within(dialog).getByLabelText('Pass reason')).toHaveValue('valuation');
    expect(within(dialog).getByLabelText('Pass note (optional)')).toHaveValue('Retain the existing record.');
    expect(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' })).toBeVisible();
    expect(screen.getByText('Review: Needs Review')).toBeVisible();
    expect(screen.getAllByText('Operator: Normal')).toHaveLength(1);
    expect(screen.queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(screen.getByRole('button', { name: action })).toBeEnabled();
    }
    expect(reads).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm Pass' }));
    expect(writes).toHaveLength(2);
  });

  test('keeps drawer Pass open with its durable content and draft after a deferred write failure, then permits one retry', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [];
    const reads = [];
    const persistedDetail = detailResponse(queueRow());
    persistedDetail.effectiveFacts = { seller_name: { value: 'Existing durable seller', provenance: 'operator', note: '' } };
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) { writes.push(JSON.parse(options.body)); return writes.length === 1 ? first.promise : second.promise; }
      reads.push(url);
      return Promise.resolve(url.endsWith('/triage/opp-1') ? jsonResponse(persistedDetail) : jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    expect(within(drawer).getByText('Needs Review · Current')).toBeVisible();
    expect(within(drawer).getByText('Priority: Normal')).toBeVisible();
    expect(within(drawer).queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(within(drawer).getByRole('button', { name: action })).toBeEnabled();
    }
    fireEvent.click(within(drawer).getByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    const passForm = within(drawer).getByRole('form', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(passForm).getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.click(within(passForm).getByRole('button', { name: 'Confirm Pass' }));
    expect(writes).toEqual([{ action: 'pass', reason: 'valuation', note: '' }]);
    expect(reads).toHaveLength(2);
    await act(async () => first.resolve(jsonResponse({ success: false, error: 'Drawer pass failed.' }, { ok: false, status: 409 })));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Drawer pass failed.');
    expect(within(passForm).getByLabelText('Pass reason')).toHaveValue('valuation');
    expect(within(drawer).getByText('Existing durable seller')).toBeVisible();
    expect(within(drawer).getByText('Needs Review · Current')).toBeVisible();
    expect(within(drawer).getByText('Priority: Normal')).toBeVisible();
    expect(within(drawer).queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(within(drawer).getByRole('button', { name: action })).toBeEnabled();
    }
    expect(reads).toHaveLength(2);
    fireEvent.click(within(passForm).getByRole('button', { name: 'Confirm Pass' }));
    expect(writes).toHaveLength(2);
  });

  test('keeps verified-fact edit open with its prior durable value after a deferred save failure, then permits one retry', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [];
    const reads = [];
    const persistedDetail = detailResponse(queueRow());
    persistedDetail.effectiveFacts = { seller_name: { value: 'Existing durable seller', provenance: 'operator', note: '' } };
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.includes('/facts/seller_name')) { writes.push(JSON.parse(options.body)); return writes.length === 1 ? first.promise : second.promise; }
      reads.push(url);
      return Promise.resolve(url.endsWith('/triage/opp-1') ? jsonResponse(persistedDetail) : jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.change(within(drawer).getByLabelText('Verified fact value'), { target: { value: 'Updated seller' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save verified fact' }));
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(2);
    await act(async () => first.resolve(jsonResponse({ success: false, error: 'Verified fact could not be saved.' }, { ok: false, status: 409 })));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Verified fact could not be saved.');
    expect(within(drawer).getByLabelText('Verified fact value')).toHaveValue('Updated seller');
    expect(within(drawer).getByText('Existing durable seller')).toBeVisible();
    expect(reads).toHaveLength(2);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save verified fact' }));
    expect(writes).toHaveLength(2);
  });

  test('announces a failed row Watch in queue context without a success refresh and permits one retry', async () => {
    const first = deferred();
    const second = deferred();
    const writes = [];
    const reads = [];
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) { writes.push(JSON.parse(options.body)); return writes.length === 1 ? first.promise : second.promise; }
      reads.push(url);
      return Promise.resolve(jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    const watch = await screen.findByRole('button', { name: 'Watch Evergreen Fire Protection' });
    expect(screen.getByText('Review: Needs Review')).toBeVisible();
    expect(screen.getAllByText('Operator: Normal')).toHaveLength(1);
    expect(screen.queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(screen.getByRole('button', { name: action })).toBeEnabled();
    }
    fireEvent.click(watch);
    expect(writes).toEqual([{ action: 'watch' }]);
    await act(async () => first.resolve(jsonResponse({ success: false, error: 'Watch could not be saved.' }, { ok: false, status: 409 })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Watch could not be saved.');
    expect(reads).toHaveLength(1);
    expect(screen.getByText('Review: Needs Review')).toBeVisible();
    expect(screen.getAllByText('Operator: Normal')).toHaveLength(1);
    expect(screen.queryByText(/^Passed:/)).not.toBeInTheDocument();
    for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection']) {
      expect(screen.getByRole('button', { name: action })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    expect(writes).toHaveLength(2);
  });

  test('traps keyboard focus in drawer and queue Pass dialogs, closes by Escape or controls, and restores each triggering control', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) return jsonResponse(detailResponse());
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    const open = await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' });
    open.focus();
    fireEvent.click(open);
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    const firstDrawerControl = within(drawer).getByRole('button', { name: 'Close opportunity detail' });
    const lastDrawerControl = within(drawer).getByLabelText('Verification note');
    await waitFor(() => expect(document.activeElement).toBe(firstDrawerControl));
    lastDrawerControl.focus();
    fireEvent.keyDown(lastDrawerControl, { key: 'Tab', code: 'Tab' });
    expect(document.activeElement).toBe(firstDrawerControl);
    fireEvent.keyDown(firstDrawerControl, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastDrawerControl);
    open.focus();
    fireEvent.keyDown(open, { key: 'Tab', code: 'Tab' });
    expect(document.activeElement).toBe(firstDrawerControl);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close opportunity detail' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evergreen Fire Protection' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    const escapeDrawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    within(escapeDrawer).getByRole('button', { name: 'Close opportunity detail' }).focus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evergreen Fire Protection' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(open);

    const pass = screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' });
    pass.focus();
    fireEvent.click(pass);
    const queueDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
    expect(queueDialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(within(queueDialog).getByLabelText('Pass reason'));
    fireEvent.keyDown(document.activeElement, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(queueDialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document.activeElement, { key: 'Tab', code: 'Tab' });
    expect(document.activeElement).toBe(within(queueDialog).getByLabelText('Pass reason'));
    pass.focus();
    fireEvent.keyDown(pass, { key: 'Tab', code: 'Tab' });
    expect(document.activeElement).toBe(within(queueDialog).getByLabelText('Pass reason'));
    fireEvent.click(within(queueDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pass Evergreen Fire Protection' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(pass);

    fireEvent.click(pass);
    const escapeQueueDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
    within(escapeQueueDialog).getByLabelText('Pass reason').focus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pass Evergreen Fire Protection' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(pass);
  });

  test('immediately redirects background focus before it can activate queue controls behind either modal', async () => {
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/action')) writes.push(JSON.parse(options.body));
      if (url.endsWith('/triage/opp-1')) return jsonResponse(detailResponse());
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 1 }));
    }));

    renderInbox();
    const open = await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' });
    const watch = screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' });
    fireEvent.click(open);
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    const drawerClose = within(drawer).getByRole('button', { name: 'Close opportunity detail' });
    watch.focus();
    expect(document.activeElement).toBe(drawerClose);
    activateWithKeyboard(document.activeElement, 'Enter');
    expect(writes).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evergreen Fire Protection' })).not.toBeInTheDocument());

    const pass = screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.click(pass);
    const passDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
    const passReason = within(passDialog).getByLabelText('Pass reason');
    watch.focus();
    expect(document.activeElement).toBe(passReason);
    activateWithKeyboard(document.activeElement, ' ');
    expect(writes).toHaveLength(0);
    expect(passDialog).toBeVisible();
  });

  test('uses the connected triggering control only and falls back to Inbox search after filters remove it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) return jsonResponse(detailResponse());
      const params = new URL(url, 'https://admin.example').searchParams;
      return jsonResponse(queueResponse({ rows: params.get('search') ? [] : [queueRow()], total: params.get('search') ? 0 : 1 }));
    }));

    renderInbox();
    const open = await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' });
    fireEvent.click(open);
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'no-match' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Evergreen Fire Protection' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close opportunity detail' }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search opportunities' }));
  });

  test('confines every Inbox and read-only-detail transition to the exact GET queue/detail allowlist', async () => {
    const calls = [];
    let detailAttempts = 0;
    const fetchMock = vi.fn(async (input, options = {}) => {
      const url = String(input);
      calls.push({ method: options.method || 'GET', path: new URL(url, 'https://admin.example').pathname });
      if (url.endsWith('/triage/opp-1')) {
        detailAttempts += 1;
        return detailAttempts === 1
          ? jsonResponse({ error: 'Temporary detail failure.' }, { ok: false, status: 503 })
          : jsonResponse(detailResponse());
      }
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 51, totalPages: 3 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = renderInbox();
    await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' });
    fireEvent.click(screen.getByRole('tab', { name: 'Watchlist' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search opportunities' }), { target: { value: 'fire' } });
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Operator priority'), { target: { value: 'watch' } });
    fireEvent.change(screen.getByLabelText('Sort opportunities'), { target: { value: 'fit-score' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(calls.filter(({ path }) => path === '/api/admin/deal-hunter/triage').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const failedDrawer = await screen.findByRole('dialog', { name: 'Opportunity detail' });
    fireEvent.click(within(failedDrawer).getByRole('button', { name: 'Retry opportunity detail' }));
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.click(screen.getByRole('button', { name: 'Close opportunity detail' }));
    first.unmount();

    renderInbox({ readOnly: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    expect(calls).not.toHaveLength(0);
    expect(calls.every(({ method }) => method === 'GET')).toBe(true);
    expect(calls.every(({ path }) => path === '/api/admin/deal-hunter/triage' || path === '/api/admin/deal-hunter/triage/opp-1')).toBe(true);
    expect(calls.filter(({ path }) => path === '/api/admin/deal-hunter/triage/opp-1')).toHaveLength(3);
  });

  test('keeps all primary mobile controls visible and keyboard-operable at a small viewport', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const detail = detailResponse();
    let detailAttempts = 0;
    const writes = [];
    const queueRequests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = String(input);
      if (url.endsWith('/triage/opp-1')) {
        detailAttempts += 1;
        return detailAttempts === 1 ? jsonResponse({ error: 'Retry on mobile.' }, { ok: false, status: 503 }) : jsonResponse(detail);
      }
      if (url.endsWith('/action') || url.includes('/facts/')) {
        writes.push({ url, body: JSON.parse(options.body) });
        return jsonResponse({ success: true, action: JSON.parse(options.body).action });
      }
      queueRequests.push(url);
      return jsonResponse(queueResponse({ rows: [queueRow()], total: 51, totalPages: 3 }));
    }));

    try {
      renderInbox();
      await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' });
      const tablist = screen.getByRole('tablist', { name: 'Opportunity queues' });
      expect(tablist).toHaveClass('overflow-x-auto');
      const queueControls = [
        ...within(tablist).getAllByRole('tab'),
        screen.getByRole('button', { name: 'Open Evergreen Fire Protection' }),
        screen.getByRole('button', { name: 'Pursue Evergreen Fire Protection' }),
        screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' }),
        screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' }),
        screen.getByRole('button', { name: 'Previous page' }),
        screen.getByRole('button', { name: 'Next page' }),
        screen.getByRole('searchbox', { name: 'Search opportunities' }),
        screen.getByRole('combobox', { name: 'Confidence' }),
        screen.getByRole('combobox', { name: 'Operator priority' }),
        screen.getByRole('combobox', { name: 'Sort opportunities' }),
      ];
      expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Needs Review', 'High Priority', 'Watchlist', 'Low Confidence', 'Passed', 'All Current']);
      for (const control of queueControls) {
        expectMobileReachable(control, tablist.closest('section'));
      }
      expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
      for (const tab of within(tablist).getAllByRole('tab')) {
        activateWithKeyboard(tab, ' ');
        await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
      }
      const search = screen.getByRole('searchbox', { name: 'Search opportunities' });
      typeWithKeyboard(search, 'fire');
      await waitFor(() => expect(queueRequests.some((url) => new URL(url, 'https://admin.example').searchParams.get('search') === 'fire')).toBe(true));
      const confidence = screen.getByRole('combobox', { name: 'Confidence' });
      selectWithKeyboard(confidence, 'high');
      await waitFor(() => expect(confidence).toHaveValue('high'));
      const priority = screen.getByRole('combobox', { name: 'Operator priority' });
      selectWithKeyboard(priority, 'watch');
      await waitFor(() => expect(priority).toHaveValue('watch'));
      const sort = screen.getByRole('combobox', { name: 'Sort opportunities' });
      selectWithKeyboard(sort, 'fit-score');
      await waitFor(() => expect(sort).toHaveValue('fit-score'));
      activateWithKeyboard(screen.getByRole('button', { name: 'Next page' }), 'Enter');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled());
      activateWithKeyboard(screen.getByRole('button', { name: 'Previous page' }), ' ');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled());

      for (const action of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection']) {
        const button = screen.getByRole('button', { name: action });
        activateWithKeyboard(button, 'Enter');
        await waitFor(() => expect(writes).toHaveLength(action.startsWith('Watch') ? 2 : 1));
      }
      const pass = screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' });
      activateWithKeyboard(pass, ' ');
      let passDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
      for (const control of [within(passDialog).getByLabelText('Pass reason'), within(passDialog).getByLabelText('Pass note (optional)'), within(passDialog).getByRole('button', { name: 'Confirm Pass' }), within(passDialog).getByRole('button', { name: 'Cancel' })]) expectMobileReachable(control, passDialog);
      activateWithKeyboard(within(passDialog).getByRole('button', { name: 'Cancel' }), 'Enter');
      activateWithKeyboard(pass, 'Enter');
      passDialog = screen.getByRole('dialog', { name: 'Pass Evergreen Fire Protection' });
      typeWithKeyboard(within(passDialog).getByLabelText('Pass reason'), 'mobile review');
      activateWithKeyboard(within(passDialog).getByRole('button', { name: 'Confirm Pass' }), ' ');
      await waitFor(() => expect(writes).toHaveLength(3));

      activateWithKeyboard(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' }), 'Enter');
      const retryDrawer = await screen.findByRole('dialog', { name: 'Opportunity detail' });
      const retry = within(retryDrawer).getByRole('button', { name: 'Retry opportunity detail' });
      expectMobileReachable(retry, retryDrawer);
      activateWithKeyboard(retry, ' ');
      let drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
      for (const control of ['Pursue Evergreen Fire Protection', 'Watch Evergreen Fire Protection', 'Pass Evergreen Fire Protection', 'Save verified fact', 'Close opportunity detail']) {
        expectMobileReachable(within(drawer).getByRole('button', { name: control }), drawer);
      }
      expect(drawer).toHaveClass('h-full');
      expect(drawer).toHaveClass('overflow-y-auto');
      expect(drawer).not.toHaveClass('hidden');
      expect(drawer).not.toHaveClass('overflow-hidden');
      const factValue = within(drawer).getByRole('textbox', { name: 'Verified fact value' });
      expectMobileReachable(factValue, drawer);
      typeWithKeyboard(factValue, 'Mobile verified seller');
      activateWithKeyboard(within(drawer).getByRole('button', { name: 'Save verified fact' }), 'Enter');
      await waitFor(() => expect(writes).toHaveLength(4));
      drawer = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
      activateWithKeyboard(within(drawer).getByRole('button', { name: 'Pursue Evergreen Fire Protection' }), 'Enter');
      await waitFor(() => expect(writes).toHaveLength(5));
      drawer = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
      activateWithKeyboard(within(drawer).getByRole('button', { name: 'Watch Evergreen Fire Protection' }), ' ');
      await waitFor(() => expect(writes).toHaveLength(6));
      drawer = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
      activateWithKeyboard(within(drawer).getByRole('button', { name: 'Pass Evergreen Fire Protection' }), 'Enter');
      const drawerPassForm = within(drawer).getByRole('form', { name: 'Pass Evergreen Fire Protection' });
      typeWithKeyboard(within(drawerPassForm).getByLabelText('Pass reason'), 'mobile drawer pass');
      activateWithKeyboard(within(drawerPassForm).getByRole('button', { name: 'Confirm Pass' }), ' ');
      await waitFor(() => expect(writes).toHaveLength(7));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evergreen Fire Protection' })).not.toBeInTheDocument());
      activateWithKeyboard(screen.getByRole('button', { name: 'Open Evergreen Fire Protection' }), ' ');
      drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
      activateWithKeyboard(within(drawer).getByRole('button', { name: 'Close opportunity detail' }), ' ');
      expect(writes.map(({ body }) => body.action || body.value)).toEqual(['pursue', 'watch', 'pass', 'Mobile verified seller', 'pursue', 'watch', 'pass']);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  test('refuses Escape and explicit drawer Close synchronously while a Pass write is unresolved', async () => {
    const action = deferred();
    let close;
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = String(input);
      if (url.endsWith('/action')) {
        fireEvent.click(close);
        return action.promise;
      }
      return Promise.resolve(url.endsWith('/triage/opp-1') ? jsonResponse(detailResponse()) : jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Pass Evergreen Fire Protection' }));
    const form = within(drawer).getByRole('form', { name: 'Pass Evergreen Fire Protection' });
    fireEvent.change(within(form).getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    close = within(drawer).getByRole('button', { name: 'Close opportunity detail' });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm Pass' }));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    fireEvent.keyDown(close, { key: 'Escape' });
    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    await act(async () => action.resolve(jsonResponse({ success: false, error: 'Pass failed.' }, { ok: false, status: 409 })));
  });

  test('refuses Escape and explicit drawer Close synchronously while a verified-fact write is unresolved', async () => {
    const save = deferred();
    let close;
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = String(input);
      if (url.includes('/facts/seller_name')) {
        fireEvent.click(close);
        return save.promise;
      }
      return Promise.resolve(url.endsWith('/triage/opp-1') ? jsonResponse(detailResponse()) : jsonResponse(queueResponse({ rows: [queueRow()], total: 1 })));
    }));

    renderInbox();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Evergreen Fire Protection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Evergreen Fire Protection' });
    fireEvent.change(within(drawer).getByLabelText('Verified fact value'), { target: { value: 'Updated seller' } });
    close = within(drawer).getByRole('button', { name: 'Close opportunity detail' });
    const saveButton = within(drawer).getByRole('button', { name: 'Save verified fact' });
    fireEvent.click(saveButton);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    fireEvent.keyDown(close, { key: 'Escape' });
    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: 'Evergreen Fire Protection' })).toBeVisible();
    await act(async () => save.resolve(jsonResponse({ success: false, error: 'Fact failed.' }, { ok: false, status: 409 })));
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
