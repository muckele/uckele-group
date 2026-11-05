// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import PursuedDeals from '../src/components/admin/PursuedDeals.jsx';
import { uploadPursuedSim } from '../src/components/admin/pursuedDealsApi.js';

const LIST = '/api/admin/deal-hunter/pursuing';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_COPY = 'This deal changed in another tab. We refreshed it — check the stage and try again.';

const STAGES = ['cim-requested', 'broker-replied', 'nda-sent', 'cim-received', 'financial-review', 'loi-candidate', 'passed'];

function byStage(overrides = {}) {
  return { ...Object.fromEntries(STAGES.map((id) => [id, 0])), ...overrides };
}

function release(overrides = {}) {
  return { status: { code: 'active-follow-up', reason: null, actionRequired: false }, canStop: false, campaign: null, ...overrides };
}

function dealRow(overrides = {}) {
  return {
    opportunityId: 'opp-1',
    name: 'Acme Plumbing',
    crmSubmissionId: 'crm-1',
    stage: 'cim-requested',
    stageLabel: 'SIM requested',
    stageSince: '2026-11-02T15:00:00.000Z',
    stageSource: 'evidence',
    lastReplyAt: null,
    needsAction: null,
    simDocuments: [],
    latestEventId: 'evt-1',
    release: release(),
    passedInDealHunter: false,
    opportunityActive: true,
    gmailThreadUrl: null,
    ...overrides,
  };
}

function replyRow(overrides = {}) {
  return dealRow({
    lastReplyAt: '2026-11-03T15:00:00.000Z',
    needsAction: { reason: 'reply', at: '2026-11-03T15:00:00.000Z', replyId: 'reply-1', classification: 'reply' },
    gmailThreadUrl: 'https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-1',
    ...overrides,
  });
}

function page(rows, { needsAction = rows.filter((row) => row.needsAction).length, stages = {}, truncated = false } = {}) {
  return { success: true, asOf: '2026-11-04T12:00:00.000Z', counts: { needsAction, byStage: byStage(stages) }, rows, truncated };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fetch stub: `handlers` map "METHOD path" (query string ignored for the key) to a function. */
function stubFetch(handlers) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).split('?')[0];
    const handler = handlers[`${method} ${path}`];
    if (!handler) return jsonResponse({ success: false, error: `Unexpected ${method} ${url}` }, 404);
    return handler(options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body, options, String(url));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const listCalls = (fetchMock) => fetchMock.mock.calls.filter(([url, options]) => String(url).startsWith(LIST) && (options?.method ?? 'GET') === 'GET');
const postsTo = (fetchMock, suffix) => fetchMock.mock.calls.filter(([url, options]) => options?.method === 'POST' && String(url).endsWith(suffix));

function renderTab(props = {}) {
  return render(<MemoryRouter initialEntries={['/admin/deal-hunter?view=pursued']}><PursuedDeals {...props} /></MemoryRouter>);
}

const pdf = (name = 'sim.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pursued deals tab', () => {
  test('defaults to Needs your action when any row needs action and shows the counts on every chip', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow()], { needsAction: 2, stages: { 'cim-requested': 3, 'broker-replied': 1, passed: 1 } })),
    });
    renderTab();

    expect(await screen.findByText('Acme Plumbing')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Pursued deals' })).toBeVisible();
    expect(screen.getByText('Every deal you\'ve asked a broker for a SIM on, and where it stands.')).toBeVisible();
    expect(fetchMock.mock.calls[0][0]).toBe(`${LIST}?stage=needs-action`);

    const chips = within(screen.getByRole('group', { name: 'Filter by stage' }));
    expect(chips.getByRole('button', { name: 'Needs your action (2)' })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.getByRole('button', { name: 'All (5)' })).toHaveAttribute('aria-pressed', 'false');
    expect(chips.getByRole('button', { name: 'SIM requested (3)' })).toBeVisible();
    expect(chips.getByRole('button', { name: 'Broker replied (1)' })).toBeVisible();
    for (const label of ['NDA (0)', 'SIM received (0)', 'Reviewing (0)', 'LOI candidate (0)', 'Passed (1)']) {
      expect(chips.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('falls back to All when nothing needs action, and never sends an empty stage', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: (_body, _options, url) => jsonResponse(url.endsWith('stage=needs-action')
        ? page([], { needsAction: 0, stages: { 'cim-requested': 1 } })
        : page([dealRow()], { needsAction: 0, stages: { 'cim-requested': 1 } })),
    });
    renderTab();

    expect(await screen.findByText('Acme Plumbing')).toBeVisible();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${LIST}?stage=needs-action`, LIST]);
    expect(screen.getByRole('button', { name: 'All (1)' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Reviewing (0)' }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)[0]).toBe(`${LIST}?stage=financial-review`));
  });

  test('shows the empty-state copy', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([], { needsAction: 0 })) });
    renderTab();
    expect(await screen.findByText('No pursued deals yet. Deals you Pursue — or that are pursued automatically at 90+ — show up here.'))
      .toBeVisible();
  });

  test('an empty stage filter says there are no deals at that stage', async () => {
    stubFetch({
      [`GET ${LIST}`]: (_body, _options, url) => jsonResponse(url.includes('stage=nda-sent')
        ? page([], { needsAction: 0, stages: { 'cim-requested': 1 } }) : page([dealRow()], { needsAction: 0, stages: { 'cim-requested': 1 } })),
    });
    renderTab();
    await screen.findByText('Acme Plumbing');
    fireEvent.click(screen.getByRole('button', { name: 'NDA (0)' }));
    expect(await screen.findByText('No deals at this stage.')).toBeVisible();
  });

  test('a failed load shows the error copy and Retry loads again', async () => {
    let calls = 0;
    stubFetch({
      [`GET ${LIST}`]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ success: false, error: 'boom' }, 500) : jsonResponse(page([dealRow()], { needsAction: 0 }));
      },
    });
    renderTab();
    expect(await screen.findByText('Pursued deals couldn\'t load.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Acme Plumbing')).toBeVisible();
  });

  test('one click on NDA requested posts the reply type and shows Recorded: NDA requested. Undo', async () => {
    const after = dealRow({ stage: 'nda-sent', stageLabel: 'NDA', latestEventId: 'evt-2', needsAction: null });
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow()], { stages: { 'cim-requested': 1 } })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/reply-type': () => jsonResponse({ success: true, row: after, replay: false }),
      'POST /api/admin/deal-hunter/pursuing/opp-1/stage': () => jsonResponse({ success: true, row: dealRow({ latestEventId: 'evt-3' }), replay: false }),
    });
    renderTab();

    const group = await screen.findByRole('group', { name: 'Reply type for Acme Plumbing' });
    expect(screen.getByText(/Broker replied .* — what did they say\?/)).toBeVisible();
    for (const label of ['NDA requested', 'SIM received', 'Not available', 'Question', 'Other']) {
      expect(within(group).getByRole('button', { name: label })).toBeVisible();
    }
    fireEvent.click(within(group).getByRole('button', { name: 'NDA requested' }));

    const status = await screen.findByText(/^Recorded: NDA requested\./);
    expect(status.closest('[role="status"]')).toHaveTextContent('Recorded: NDA requested. Undo');
    const [, options] = postsTo(fetchMock, '/reply-type')[0];
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({
      replyType: 'nda-requested', expectedLatestEventId: 'evt-1', acknowledgedReplyId: 'reply-1',
      idempotencyKey: expect.stringMatching(UUID),
    });
    // The row stays on screen, now at its new stage, and the counts follow it.
    expect(screen.getByText('Acme Plumbing')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Needs your action (0)' })).toBeVisible();
    expect(listCalls(fetchMock)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(postsTo(fetchMock, '/stage')).toHaveLength(1));
    expect(JSON.parse(postsTo(fetchMock, '/stage')[0][1].body)).toEqual({
      stage: 'cim-requested', expectedLatestEventId: 'evt-2', idempotencyKey: expect.stringMatching(UUID),
    });
    await waitFor(() => expect(screen.queryByText(/^Recorded:/)).not.toBeInTheDocument());
  });

  test('SIM received records the type then opens the upload control focused; Upload later closes it', async () => {
    const after = dealRow({ stage: 'cim-received', stageLabel: 'SIM received', latestEventId: 'evt-2' });
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow()])),
      'POST /api/admin/deal-hunter/pursuing/opp-1/reply-type': () => jsonResponse({ success: true, row: after }),
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'SIM received' }));
    const input = await screen.findByLabelText('SIM file for Acme Plumbing');
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByText(/^Recorded: SIM received\./)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Upload later' }));
    expect(screen.queryByLabelText('SIM file for Acme Plumbing')).not.toBeInTheDocument();
  });

  test('a 409 shows the refresh copy and reloads', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow()])),
      'POST /api/admin/deal-hunter/pursuing/opp-1/reply-type': () => jsonResponse(
        { success: false, code: 'pursuit_stage_changed', error: 'server words' }, 409),
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Question' }));
    expect(await screen.findByText(REFRESH_COPY)).toBeVisible();
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(2));
  });

  test('a stage move on the Move to… select posts the stage with the reply it answers', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow()])),
      'POST /api/admin/deal-hunter/pursuing/opp-1/stage': () => jsonResponse({
        success: true, row: dealRow({ stage: 'financial-review', stageLabel: 'Reviewing', latestEventId: 'evt-2' }) }),
    });
    renderTab();

    const select = await screen.findByRole('combobox', { name: /^Move to…/ });
    fireEvent.change(select, { target: { value: 'financial-review' } });
    await waitFor(() => expect(postsTo(fetchMock, '/stage')).toHaveLength(1));
    expect(JSON.parse(postsTo(fetchMock, '/stage')[0][1].body)).toEqual({
      stage: 'financial-review', expectedLatestEventId: 'evt-1', acknowledgedReplyId: 'reply-1',
      idempotencyKey: expect.stringMatching(UUID),
    });
  });

  test('a bounce shows its band with Mark handled, which acknowledges the reply', async () => {
    const bounced = dealRow({
      needsAction: { reason: 'bounce', at: '2026-11-03T15:00:00.000Z', replyId: 'bounce-1', classification: 'bounce' },
      gmailThreadUrl: 'https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-1',
      release: release({ canStop: true, campaign: { id: 'camp-1', state: 'active-follow-up', rowVersion: 4, terminalRevision: 2 } }),
    });
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([bounced])),
      'POST /api/admin/deal-hunter/pursuing/opp-1/acknowledge': () => jsonResponse({ success: true, row: dealRow({ latestEventId: 'evt-2' }) }),
    });
    renderTab();

    expect(await screen.findByText(/^SIM request bounced .*\.$/)).toBeVisible();
    expect(screen.queryByRole('group', { name: /Reply type for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Gmail' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop SIM requests' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(postsTo(fetchMock, '/acknowledge')).toHaveLength(1));
    expect(JSON.parse(postsTo(fetchMock, '/acknowledge')[0][1].body)).toEqual({
      acknowledgedReplyId: 'bounce-1', idempotencyKey: expect.stringMatching(UUID),
    });
    await waitFor(() => expect(screen.queryByText(/^SIM request bounced/)).not.toBeInTheDocument());
  });

  test('a stop-word reply adds the do-not-email line', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([replyRow({
        needsAction: { reason: 'reply', at: '2026-11-03T15:00:00.000Z', replyId: 'reply-1', classification: 'stop' } })])),
    });
    renderTab();
    expect(await screen.findByText('They asked not to be emailed again.')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Reply type for Acme Plumbing' })).toBeVisible();
  });

  test('shows the stage pill, release status, reply date, SIM links and the CRM link', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow({
        stage: 'cim-received', stageLabel: 'SIM received', lastReplyAt: '2026-11-03T15:00:00.000Z',
        release: release({ status: { code: 'materials-received', reason: null, actionRequired: false } }),
        simDocuments: [{ id: 'doc-1', name: 'Acme SIM.pdf', sizeBytes: 2048, uploadedAt: '2026-11-03T16:00:00.000Z' }],
      })], { needsAction: 0 })),
    });
    renderTab();

    const item = (await screen.findByText('Acme Plumbing')).closest('li');
    expect(within(item).getByRole('link', { name: 'Acme Plumbing' })).toHaveAttribute('href', '/admin/crm/crm-1');
    expect(within(item).getByText('SIM received')).toBeVisible();
    expect(within(item).getByText(/^since /)).toBeVisible();
    expect(within(item).getByText('Materials Received')).toBeVisible();
    expect(within(item).getByText(/^Replied /)).toBeVisible();
    expect(within(item).getByRole('link', { name: /Acme SIM\.pdf/ })).toHaveAttribute('href', '/api/admin/secure-documents/doc-1/download');
  });

  test('Open in Gmail opens in a new tab with noopener noreferrer', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([replyRow()])) });
    renderTab();
    const link = await screen.findByRole('link', { name: 'Open in Gmail' });
    expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel').split(' ').sort()).toEqual(['noopener', 'noreferrer']);
  });

  test('an admin row without a thread says the Gmail thread is not available yet', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })) });
    renderTab();
    expect(await screen.findByText('Gmail thread not available yet.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open in Gmail' })).not.toBeInTheDocument();
  });

  test('read-only shows the viewer copy and no write controls or Gmail link', async () => {
    const viewerRow = dealRow({
      needsAction: { reason: 'reply', at: '2026-11-03T15:00:00.000Z', classification: 'reply' },
      release: release({ canStop: true, campaign: { id: 'camp-1', state: 'active-follow-up', rowVersion: 4, terminalRevision: 2 } }),
    });
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([viewerRow])) });
    renderTab({ readOnly: true });

    expect(await screen.findByText('Acme Plumbing')).toBeVisible();
    expect(screen.getByText('Read-only access: stage changes and uploads are unavailable.')).toBeVisible();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload SIM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop SIM requests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark handled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Reply type for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in Gmail' })).not.toBeInTheDocument();
    expect(screen.queryByText('Gmail thread not available yet.')).not.toBeInTheDocument();
  });

  test('Stop SIM requests posts the release campaign id, row version and terminal revision to cim-release/stop', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow({
        release: release({ canStop: true, campaign: { id: 'camp-1', state: 'active-follow-up', rowVersion: 4, terminalRevision: 2 } }),
      })], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/triage/opp-1/cim-release/stop': () => jsonResponse({ success: true, report: {} }),
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop SIM requests' }));
    await waitFor(() => expect(postsTo(fetchMock, '/cim-release/stop')).toHaveLength(1));
    expect(JSON.parse(postsTo(fetchMock, '/cim-release/stop')[0][1].body)).toMatchObject({
      campaignId: 'camp-1', expectedRowVersion: 4, expectedTerminalRevision: 2, idempotencyKey: expect.stringMatching(UUID),
    });
    // The page reloads so the row shows the stopped campaign.
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(2));
  });

  test('no Stop SIM requests button unless the release can be stopped', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })) });
    renderTab();
    await screen.findByText('Acme Plumbing');
    expect(screen.queryByRole('button', { name: 'Stop SIM requests' })).not.toBeInTheDocument();
  });

  test('nav shows Pursued deals between Inbox and Operations', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })) });
    renderTab();
    await screen.findByText('Acme Plumbing');
    const links = within(screen.getByRole('navigation', { name: 'Deal Hunter views' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Inbox', 'Pursued deals', 'Operations']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin/deal-hunter', '/admin/deal-hunter?view=pursued', '/admin/deal-hunter?view=operations']);
  });

  test('a deal passed in Deal Hunter shows Passed with the note Passed in Deal Hunter and no write controls', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow({
        stage: 'passed', stageLabel: 'Passed', passedInDealHunter: true,
        release: release({ canStop: true, campaign: { id: 'camp-1', state: 'active-follow-up', rowVersion: 1, terminalRevision: 0 } }),
      })], { needsAction: 0, stages: { passed: 1 } })),
    });
    renderTab();

    const item = (await screen.findByText('Acme Plumbing')).closest('li');
    expect(within(item).getByText('Passed')).toBeVisible();
    expect(within(item).getByText('Passed in Deal Hunter')).toBeVisible();
    expect(within(item).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Upload SIM' })).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Stop SIM requests' })).not.toBeInTheDocument();
  });

  test('a merged opportunity (opportunityActive false) shows Merged into another listing and no write controls', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow({
        opportunityActive: false,
        release: release({ canStop: true, campaign: { id: 'camp-1', state: 'active-follow-up', rowVersion: 1, terminalRevision: 0 } }),
      })], { needsAction: 0 })),
    });
    renderTab();

    const item = (await screen.findByText('Acme Plumbing')).closest('li');
    expect(within(item).getByText('Merged into another listing')).toBeVisible();
    expect(within(item).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Upload SIM' })).not.toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'Stop SIM requests' })).not.toBeInTheDocument();
  });

  test('a row with releaseUnavailable shows Status unavailable', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow({ release: null, releaseUnavailable: true })], { needsAction: 0 })),
    });
    renderTab();
    expect(await screen.findByText('Status unavailable')).toBeVisible();
  });

  test('truncated shows Showing the first 200. Use a stage filter to see the rest.', async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0, truncated: true })) });
    renderTab();
    expect(await screen.findByText('Showing the first 200. Use a stage filter to see the rest.')).toBeVisible();
  });
});

describe('Upload SIM', () => {
  async function openUpload() {
    const input = await (async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Upload SIM' }));
      return screen.findByLabelText('SIM file for Acme Plumbing');
    })();
    return input;
  }

  test('uploads the PDF with its headers and shows SIM uploaded. Follow-ups for this deal have stopped.', async () => {
    const after = dealRow({ latestEventId: 'evt-2', stage: 'cim-received', stageLabel: 'SIM received',
      simDocuments: [{ id: 'doc-1', name: 'sim.pdf', sizeBytes: 8, uploadedAt: '2026-11-04T12:00:00.000Z' }] });
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => jsonResponse(
        { success: true, document: { id: 'doc-1' }, row: after, stoppedFollowUps: true }, 201),
    });
    renderTab();

    fireEvent.change(await openUpload(), { target: { files: [pdf('Acme SIM.pdf')] } });
    expect(await screen.findByText('SIM uploaded. Follow-ups for this deal have stopped.')).toBeVisible();
    const [, options] = postsTo(fetchMock, '/sim')[0];
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/pdf', 'X-File-Name': 'Acme%20SIM.pdf', 'X-Idempotency-Key': expect.stringMatching(UUID),
    });
    expect(options.headers['X-Acknowledged-Reply-Id']).toBeUndefined();
    expect(screen.getByRole('link', { name: /sim\.pdf/ })).toHaveAttribute('href', '/api/admin/secure-documents/doc-1/download');
    expect(screen.queryByLabelText('SIM file for Acme Plumbing')).not.toBeInTheDocument();
  });

  test('says SIM uploaded. when nothing was stopped', async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => jsonResponse(
        { success: true, document: { id: 'doc-1' }, row: dealRow({ latestEventId: 'evt-2' }), stoppedFollowUps: false }, 201),
    });
    renderTab();
    fireEvent.change(await openUpload(), { target: { files: [pdf()] } });
    expect(await screen.findByText('SIM uploaded.')).toBeVisible();
  });

  test.each([
    [415, 'pdf_only', 'Only PDF files can be uploaded as a SIM.'],
    [413, 'file_too_large', 'This file is larger than 25 MB.'],
    [422, 'not_a_pdf', 'That file isn\'t a valid PDF.'],
    [400, 'invalid_file_name', 'The file name couldn\'t be read. Rename it and try again.'],
    [503, 'upload_capacity', 'Uploads are busy. Try again in 30 seconds.'],
    [507, 'storage_full', 'The server is low on storage space. Tell your engineer before uploading more.'],
    [409, 'no_crm_record', 'This deal has no CRM record yet, so a SIM can\'t be stored.'],
  ])('upload errors map to the spec copy: %i %s', async (status, code, copy) => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => jsonResponse({ success: false, code, error: 'server words' }, status),
    });
    renderTab();
    fireEvent.change(await openUpload(), { target: { files: [pdf()] } });
    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
  });

  test('a file that is not a PDF is refused before any request', async () => {
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })) });
    renderTab();
    fireEvent.change(await openUpload(), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    expect(await screen.findByText('Only PDF files can be uploaded as a SIM.')).toBeVisible();
    expect(postsTo(fetchMock, '/sim')).toHaveLength(0);
  });

  test.each([
    [false, 'SIM uploaded.'],
    [true, 'SIM uploaded. Follow-ups for this deal have stopped.'],
  ])('a network error whose reload shows the new SIM closes the panel with the OK copy (canStop %s)', async (canStop, copy) => {
    let posted = false;
    const before = dealRow({ release: release({ canStop, campaign: canStop
      ? { id: 'camp-1', state: 'active-follow-up', rowVersion: 4, terminalRevision: 2 } : null }) });
    // After the upload the campaign is stopped, so the reloaded row can no longer be stopped.
    const landed = dealRow({ latestEventId: 'evt-2', release: release({ canStop: false }),
      simDocuments: [{ id: 'doc-1', name: 'sim.pdf', sizeBytes: 8, uploadedAt: '2026-11-04T12:00:00.000Z' }] });
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([posted ? landed : before], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => {
        posted = true; // The server committed, then the connection dropped.
        throw new TypeError('Failed to fetch');
      },
    });
    renderTab();

    fireEvent.change(await openUpload(), { target: { files: [pdf()] } });
    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.queryByLabelText('SIM file for Acme Plumbing')).not.toBeInTheDocument();
    expect(screen.queryByText('The upload was interrupted. Try again.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sim\.pdf/ })).toBeVisible();
    expect(postsTo(fetchMock, '/sim')).toHaveLength(1);
  });

  test('a network error with no new SIM shows the interrupted copy on every attempt, under one key', async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => { throw new TypeError('Failed to fetch'); },
    });
    renderTab();

    const input = await openUpload();
    const file = pdf();
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('The upload was interrupted. Try again.')).toBeVisible();

    fireEvent.change(screen.getByLabelText('SIM file for Acme Plumbing'), { target: { files: [file] } });
    await waitFor(() => expect(postsTo(fetchMock, '/sim')).toHaveLength(2));
    expect(screen.getByText('The upload was interrupted. Try again.')).toBeVisible();
    expect(screen.getByLabelText('SIM file for Acme Plumbing')).toBeVisible();

    fireEvent.change(screen.getByLabelText('SIM file for Acme Plumbing'), { target: { files: [file] } });
    await waitFor(() => expect(postsTo(fetchMock, '/sim')).toHaveLength(3));
    expect(await screen.findByText('The upload was interrupted. Try again.')).toBeVisible();
    const keys = postsTo(fetchMock, '/sim').map(([, options]) => options.headers['X-Idempotency-Key']);
    expect(keys[0]).toMatch(UUID);
    expect(new Set(keys).size).toBe(1);
  });

  // A 5xx without a code may have come after the commit (a proxy's 502, a failed read-back), so it
  // is ambiguous like a network failure; a coded 5xx (upload_capacity, storage_full) stays definite.
  test.each([
    ['a 502 with no body', () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } })],
    ['a 500 without a code', () => jsonResponse({ success: false, error: 'Internal server error.' }, 500)],
  ])('%s runs the landed check and the retry reuses the key', async (_label, failure) => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': failure,
    });
    renderTab();
    await screen.findByRole('button', { name: 'Upload SIM' });
    const loadsBefore = listCalls(fetchMock).length;

    const file = pdf();
    fireEvent.change(await openUpload(), { target: { files: [file] } });
    expect(await screen.findByText('The upload was interrupted. Try again.')).toBeVisible();
    expect(listCalls(fetchMock).length).toBeGreaterThan(loadsBefore); // the deal was read again

    fireEvent.change(screen.getByLabelText('SIM file for Acme Plumbing'), { target: { files: [file] } });
    await waitFor(() => expect(postsTo(fetchMock, '/sim')).toHaveLength(2));
    expect(await screen.findByText('The upload was interrupted. Try again.')).toBeVisible();
    const keys = postsTo(fetchMock, '/sim').map(([, options]) => options.headers['X-Idempotency-Key']);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  test('a 502 whose reload shows the new SIM closes the panel with the OK copy', async () => {
    let posted = false;
    const landed = dealRow({ latestEventId: 'evt-2',
      simDocuments: [{ id: 'doc-1', name: 'sim.pdf', sizeBytes: 8, uploadedAt: '2026-11-04T12:00:00.000Z' }] });
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse(page([posted ? landed : dealRow()], { needsAction: 0 })),
      'POST /api/admin/deal-hunter/pursuing/opp-1/sim': () => {
        posted = true; // The upload committed; the answer was lost behind a 502.
        return { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
      },
    });
    renderTab();
    fireEvent.change(await openUpload(), { target: { files: [pdf()] } });
    expect(await screen.findByText('SIM uploaded.')).toBeVisible();
    expect(screen.queryByLabelText('SIM file for Acme Plumbing')).not.toBeInTheDocument();
  });
});

describe('uploadPursuedSim', () => {
  test('uploadPursuedSim sends application/pdf for a .pdf file whose type is empty', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, row: dealRow() }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-1.4'], 'Q3 SIM — café 100%.PDF', { type: '' });

    await uploadPursuedSim({ opportunityId: 'opp 1', file, idempotencyKey: '8f9b1c5e-0d3a-4c7e-9b2a-1a2b3c4d5e6f', acknowledgedReplyId: 'reply-1' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/deal-hunter/pursuing/opp%201/sim');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(file);
    expect(options.headers).toEqual({
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent('Q3 SIM — café 100%.PDF'),
      'X-Idempotency-Key': '8f9b1c5e-0d3a-4c7e-9b2a-1a2b3c4d5e6f',
      'X-Acknowledged-Reply-Id': 'reply-1',
    });
  });

  test('accepts a file typed application/pdf whose name has no .pdf, and refuses anything else client-side', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, row: dealRow() }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const key = '8f9b1c5e-0d3a-4c7e-9b2a-1a2b3c4d5e6f';

    await uploadPursuedSim({ opportunityId: 'opp-1', file: new File(['%PDF-'], 'scan', { type: 'application/pdf' }), idempotencyKey: key });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(uploadPursuedSim({ opportunityId: 'opp-1', file: new File(['x'], 'sim.docx', { type: '' }), idempotencyKey: key }))
      .rejects.toThrow('Only PDF files can be uploaded as a SIM.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
