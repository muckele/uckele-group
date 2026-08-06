// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import DashboardPage from '../src/pages/DashboardPage.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function renderDashboard(path) {
  vi.stubGlobal('React', React);
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<DashboardPage />} path="/admin" />
          <Route element={<DashboardPage />} path="/admin/crm/:submissionId" />
          <Route element={<DashboardPage />} path="/admin/:section" />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

function authenticatedSession(role = 'admin') {
  return {
    authenticated: true,
    username: role === 'viewer' ? 'viewer@example.com' : 'admin@example.com',
    role,
    authMode: 'hybrid',
    magicLinkEnabled: true,
    passwordEnabled: true,
    viewerAccessEnabled: true,
  };
}

function crmSubmission(overrides = {}) {
  return {
    id: 'record-1',
    name: 'Northstar Services',
    company: 'Northstar Services',
    status: 'review',
    priority: 'high',
    lead_type: 'broker',
    follow_up_state: 'needs-response',
    next_action_at: null,
    tags: [],
    notes: '',
    delivery_status: 'delivered',
    crm_status: 'active',
    assigned_to: 'Mathew',
    broker_name: 'Alex Broker',
    broker_email: 'alex@example.com',
    secure_documents: [],
    latest_upload_request: null,
    created_at: '2026-08-01T17:00:00.000Z',
    updated_at: '2026-08-06T17:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function createCrmFetch(role = 'admin', initialSubmission = crmSubmission()) {
  let currentSubmission = initialSubmission;
  const outboundCommunication = {
    id: 'communication-1',
    submission_id: 'record-1',
    cim_request_id: 'cim-1',
    direction: 'outbound',
    channel: 'email',
    from_address: 'admin@example.com',
    to_addresses: ['alex@example.com'],
    subject: 'CIM request for Northstar Services',
    body_text: 'Please send the confidential information memorandum.',
    occurred_at: '2026-08-05T17:00:00.000Z',
    request_state: 'provider-accepted',
    delivery_state: 'delivered',
  };
  const fetchMock = vi.fn(async (input, options = {}) => {
    const url = String(input);
    const method = options.method || 'GET';

    if (url === '/api/admin/session') return jsonResponse(authenticatedSession(role));
    if (url.startsWith('/api/admin/submissions/record-1/communications?') && method === 'GET') {
      return jsonResponse({ success: true, rows: [outboundCommunication], total: 1, page: 1, pageSize: 25 });
    }
    if (url === '/api/admin/submissions/record-1/communications' && method === 'POST') {
      const payload = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        communication: {
          id: 'manual-communication',
          submission_id: 'record-1',
          ...payload,
          body_text: payload.bodyText,
          occurred_at: payload.occurredAt,
        },
      }, { status: 201 });
    }
    if (url === '/api/admin/submissions/record-1/archive' && method === 'POST') {
      const payload = JSON.parse(options.body);
      currentSubmission = crmSubmission({
        ...currentSubmission,
        status: 'archived',
        follow_up_state: 'completed',
        next_action_at: null,
        archive_reason: payload.reason,
        archive_note: payload.note,
        archive_communication_id: payload.communicationId,
        archived_at: '2026-08-06T19:00:00.000Z',
      });
      return jsonResponse({ success: true, submission: currentSubmission });
    }
    if (url === '/api/admin/submissions/record-1/restore' && method === 'POST') {
      const payload = JSON.parse(options.body);
      currentSubmission = crmSubmission({ ...currentSubmission, status: payload.status, follow_up_state: 'completed' });
      return jsonResponse({ success: true, submission: currentSubmission });
    }
    if (url === '/api/admin/submissions/record-1/activity') {
      return jsonResponse({ success: true, events: [] });
    }
    if (url === '/api/admin/submissions/record-1') {
      return jsonResponse({ success: true, submission: currentSubmission });
    }
    if (url === '/api/admin/acquisition-command-center') {
      return jsonResponse({ success: true, commandCenter: { summary: {}, sourceHealth: { sources: [], issues: [] }, pipeline: [], actionItems: [], feedback: {} } });
    }
    if (url === '/api/admin/follow-ups') {
      return jsonResponse({ success: true, summary: {}, notifications: [], emailTriage: [], total: 0 });
    }
    return jsonResponse({ success: false, error: `Unexpected request: ${method} ${url}` }, { ok: false, status: 404 });
  });

  return fetchMock;
}

function dealHunterReview() {
  return {
    totals: { reviewedDeals: 2, qualified: 1, removalCandidates: 1, cimReady: 1 },
    sources: [],
    criteriaRecommendations: [],
    newlySeenMatches: [],
    watchlist: [],
    qualified: [{
      id: 'qualified-1',
      dealKey: 'qualified-1',
      name: 'Recurring HVAC Services',
      sourceName: 'Test source',
      score: 84,
      annualProfit: 450000,
      listingUrl: 'https://broker.example/hvac',
      brokerEmail: 'broker@example.com',
      brokerContacts: [{ name: 'Alex Broker', email: 'broker@example.com', role: 'Broker' }],
      strengths: ['Recurring service agreements'],
      cimRequest: {
        submissionId: 'record-1',
        eligible: true,
        canRequest: true,
        status: 'ready',
        requestState: 'ready',
        deliveryState: 'not-attempted',
        recipientEmail: 'broker@example.com',
        snapshotToken: 'signed-snapshot',
        preview: { subject: 'CIM request', text: 'Hello Alex,\n\nPlease share the CIM.' },
      },
    }],
    removalCandidates: [{
      id: 'remove-1',
      dealKey: 'remove-1',
      name: 'Route Opportunity',
      sourceName: 'Test source',
      score: 32,
      listingUrl: 'https://broker.example/route',
      removeReasons: ['Outside acquisition criteria'],
    }],
  };
}

function createDealHunterFetch(role = 'admin') {
  const review = dealHunterReview();
  return vi.fn(async (input, options = {}) => {
    const url = String(input);
    const method = options.method || 'GET';

    if (url === '/api/admin/session') return jsonResponse(authenticatedSession(role));
    if (url === '/api/admin/deal-hunter/review') return jsonResponse({ success: true, review });
    if (url.startsWith('/api/admin/deal-hunter/cim-requests?')) {
      return jsonResponse({
        success: true,
        rows: [{
          id: 'cim-bounced',
          submission_id: 'record-1',
          deal_key: 'qualified-1',
          deal_name: 'Recurring HVAC Services',
          recipient_email: 'failed@example.com',
          request_state: 'provider-accepted',
          delivery_state: 'bounced',
          first_requested_at: '2026-08-01T18:00:00.000Z',
          last_activity_at: '2026-08-02T18:00:00.000Z',
          delivery_error: 'Mailbox unavailable.',
          metadata: { brokerContacts: [{ name: 'Alex Broker', email: 'broker@example.com' }] },
        }],
        counts: { accepted: 1, deliveryIssue: 1 },
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      });
    }
    if (url.startsWith('/api/admin/communications/unassigned?')) {
      return jsonResponse({
        success: true,
        rows: [{
          id: 'unassigned-1',
          direction: 'inbound',
          from_address: 'shared-broker@example.com',
          to_addresses: ['inbound@example.com'],
          subject: 'Which deal is this?',
          body_preview: 'Please attach this reply to the correct opportunity.',
          occurred_at: '2026-08-06T18:00:00.000Z',
          candidates: [{ id: 'record-1', company: 'Northstar Services', brokerEmail: 'shared-broker@example.com' }],
        }],
        total: 1,
        page: 1,
        pageSize: 25,
      });
    }
    if (url === '/api/admin/acquisition-command-center') {
      return jsonResponse({ success: true, commandCenter: { summary: {}, sourceHealth: { sources: [], issues: [] }, pipeline: [], actionItems: [], feedback: {} } });
    }
    if (url === '/api/admin/deal-hunter/cim-reviews' && method === 'POST') {
      return jsonResponse({ success: true, recorded: 1 });
    }
    if (url === '/api/admin/deal-hunter/dispositions' && method === 'POST') {
      return jsonResponse({ success: true, disposition: { id: 'disposition-1' } });
    }
    if (url === '/api/admin/deal-hunter/cim-requests/cim-bounced/retry' && method === 'POST') {
      return jsonResponse({ success: true, request: { id: 'cim-retry' } });
    }
    if (url === '/api/admin/communications/unassigned-1/assign' && method === 'PATCH') {
      return jsonResponse({ success: true, communication: { id: 'unassigned-1', submission_id: 'record-1' } });
    }
    return jsonResponse({ success: false, error: `Unexpected request: ${method} ${url}` }, { ok: false, status: 404 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('Dashboard communications and lead lifecycle integration', () => {
  test('loads CRM communications, logs bounded workflow updates, and keeps archive/restore separate from permanent delete', async () => {
    const fetchMock = createCrmFetch();
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard('/admin/crm/record-1');

    expect(await screen.findByText('Broker and seller correspondence')).toBeVisible();
    expect(screen.getByText('CIM request for Northstar Services')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/submissions/record-1/communications?page=1&pageSize=25',
      expect.objectContaining({ credentials: 'same-origin' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Log Communication' }));
    fireEvent.change(screen.getByLabelText('Occurred at'), { target: { value: '2026-08-06T12:30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'alex@example.com' } });
    fireEvent.change(screen.getByLabelText('Body / notes'), { target: { value: 'Broker confirmed a follow-up call.' } });
    fireEvent.change(screen.getByLabelText('Update CRM status (optional)'), { target: { value: 'contacted' } });
    fireEvent.change(screen.getByLabelText('Update follow-up state (optional)'), { target: { value: 'completed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Communication' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, options]) => url === '/api/admin/submissions/record-1/communications' && options?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({
        bodyText: 'Broker confirmed a follow-up call.',
        status: 'contacted',
        followUpState: 'completed',
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archive Lead' }));
    fireEvent.change(screen.getByLabelText('Disposition reason'), { target: { value: 'broker-declined' } });
    fireEvent.change(screen.getByLabelText('Archive note (optional)'), { target: { value: 'Broker said the opportunity is no longer available.' } });
    fireEvent.change(screen.getByLabelText('Triggering communication (optional)'), { target: { value: 'communication-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Archive' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/submissions/record-1/archive',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByRole('button', { name: 'Restore Lead' })).toBeVisible();
    expect(screen.getByLabelText('Follow-up state')).toBeDisabled();
    expect(screen.getByLabelText('Next action')).toBeDisabled();
    expect(screen.getByText('Permanent delete')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Permanently Delete Record' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Lead' }));
    fireEvent.change(screen.getByLabelText('Restore status'), { target: { value: 'contacted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restore' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, options]) => url === '/api/admin/submissions/record-1/restore' && options?.method === 'POST');
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({ status: 'contacted', expectedUpdatedAt: expect.any(String) }));
    });
  });

  test('lets viewers inspect exact communications while hiding every communication and lifecycle write', async () => {
    const fetchMock = createCrmFetch('viewer', crmSubmission({
      status: 'archived',
      archive_reason: 'unavailable',
      archived_at: '2026-08-06T19:00:00.000Z',
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard('/admin/crm/record-1');

    expect(await screen.findByText('CIM request for Northstar Services')).toBeVisible();
    expect(screen.getByText(/Disposition: Unavailable/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Log Communication' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive Lead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Lead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Permanently Delete Record' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, options]) => ['POST', 'PATCH', 'DELETE'].includes(options?.method)).length).toBe(0);
  });
});

describe('Dashboard Deal Hunter communications integration', () => {
  test('loads durable history and the admin inbox, persists approval passes and card dismissals, retries safely, and assigns inbound mail', async () => {
    const fetchMock = createDealHunterFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));

    renderDashboard('/admin/deal-hunter');

    expect(await screen.findByRole('heading', { name: 'CIM Request History' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Unassigned inbound communications' })).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/deal-hunter/cim-requests?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/communications/unassigned?'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    fireEvent.change(screen.getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Review' }));

    await waitFor(() => {
      const dispositionCall = fetchMock.mock.calls.find(([url, options]) => url === '/api/admin/deal-hunter/dispositions' && JSON.parse(options.body).dealKey === 'qualified-1');
      expect(JSON.parse(dispositionCall[1].body)).toEqual(expect.objectContaining({
        dealKey: 'qualified-1',
        listingUrl: 'https://broker.example/hvac',
        dealName: 'Recurring HVAC Services',
        reason: 'valuation',
        submissionId: 'record-1',
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry with corrected recipient' }));
    fireEvent.change(screen.getByLabelText('Corrected recipient email'), { target: { value: 'corrected@example.com' } });
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'Broker provided a corrected address.' } });
    fireEvent.click(screen.getByLabelText('I confirm this manually entered address is the corrected broker recipient.'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry CIM Request' }));

    await waitFor(() => {
      const retryCall = fetchMock.mock.calls.find(([url, options]) => url === '/api/admin/deal-hunter/cim-requests/cim-bounced/retry' && options?.method === 'POST');
      expect(JSON.parse(retryCall[1].body)).toEqual({
        newRecipientEmail: 'corrected@example.com',
        confirmed: true,
        overrideReason: 'Broker provided a corrected address.',
      });
    });

    fireEvent.change(screen.getByLabelText('Assign to CRM record'), { target: { value: 'record-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign Communication' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/communications/unassigned-1/assign',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ submissionId: 'record-1' }) }),
    ));

    const removalCard = screen.getByRole('heading', { name: 'Route Opportunity' }).closest('article');
    fireEvent.click(within(removalCard).getByRole('button', { name: 'Pass & Dismiss' }));
    fireEvent.change(within(removalCard).getByLabelText('Optional note'), { target: { value: 'Outside the acquisition profile.' } });
    fireEvent.click(within(removalCard).getByRole('button', { name: 'Confirm Pass & Dismiss' }));

    await waitFor(() => {
      const dismissalCall = fetchMock.mock.calls.find(([url, options]) => url === '/api/admin/deal-hunter/dispositions' && JSON.parse(options.body).dealKey === 'remove-1');
      expect(JSON.parse(dismissalCall[1].body)).toEqual(expect.objectContaining({
        dealKey: 'remove-1',
        reason: 'not-a-fit',
        note: 'Outside the acquisition profile.',
      }));
    });
  });

  test('keeps durable CIM history visible to viewers without loading the admin-only inbox or rendering writes', async () => {
    const fetchMock = createDealHunterFetch('viewer');
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard('/admin/deal-hunter');

    expect(await screen.findByRole('heading', { name: 'CIM Request History' })).toBeVisible();
    expect(screen.getByText('Mailbox unavailable.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Unassigned inbound communications' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry with corrected recipient' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pass & Dismiss' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/communications/unassigned?'))).toBe(false);
  });
});
