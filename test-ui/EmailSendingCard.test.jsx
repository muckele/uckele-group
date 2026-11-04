// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import EmailSendingCard from '../src/components/admin/EmailSendingCard.jsx';

const statusUrl = '/api/admin/deal-hunter/email-sending';
const controlsUrl = '/api/admin/deal-hunter/email-sending/controls';
const digest = 'a'.repeat(64);

function control(overrides = {}) {
  return { enabled: false, policyVersion: null, changedAt: null, changedBy: null, revision: 0, ...overrides };
}

function status(overrides = {}) {
  return {
    gmail: { connected: false, emailAddress: null, lastTokenOkAt: null, lastErrorCode: null },
    wording: {
      approvedDigest: null,
      currentDigest: digest,
      approvedAt: null,
      approvedBy: null,
      revision: 0,
      signatureComplete: true,
      preview: [
        { variant: 'initial', subject: 'Inquiry about Sample Business', text: 'Hi Jordan,\n\nInitial body' },
        { variant: 'gentle', subject: 'Re: Inquiry about Sample Business', text: 'Hi Jordan,\n\nFollow-up body' },
      ],
    },
    contactRule: control(),
    liveSending: control(),
    readiness: { ready: false, reasons: ['gmail_not_connected', 'wording_not_approved', 'contact_rule_off', 'live_sending_off'] },
    lastRuns: { sender: null, replyPoller: null },
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

function stubFetch(initial, { onPost } = {}) {
  let current = initial;
  const fetchMock = vi.fn(async (url, options = {}) => {
    if (url === statusUrl) return jsonResponse({ success: true, emailSending: current });
    if (url === controlsUrl && options.method === 'POST') {
      const result = onPost ? onPost(JSON.parse(options.body)) : null;
      if (result?.next) current = result.next;
      return result?.response || jsonResponse({ success: true, control: control() });
    }
    if (url === '/api/admin/deal-hunter/gmail/disconnect' && options.method === 'POST') {
      current = status();
      return jsonResponse({ success: true, revokedAt: '2026-11-03T18:00:00.000Z' });
    }
    return jsonResponse({ success: false, error: `Unexpected ${url}` }, { ok: false, status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock) => fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/operations');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Email sending card', () => {
  test('renders the not-connected state with a Connect Gmail link', async () => {
    stubFetch(status());
    render(<EmailSendingCard />);

    expect(await screen.findByRole('heading', { name: 'Email sending' })).toBeVisible();
    const connect = await screen.findByRole('link', { name: 'Connect Gmail' });
    expect(connect).toHaveAttribute('href', '/api/admin/deal-hunter/gmail/connect');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeVisible();
  });

  test('renders the connected state with the address, last token check and a confirmed Disconnect', async () => {
    const fetchMock = stubFetch(status({
      gmail: { connected: true, emailAddress: 'owner@uckele.test', lastTokenOkAt: '2026-11-03T17:00:00.000Z', lastErrorCode: null },
      readiness: { ready: false, reasons: ['live_sending_off'] },
    }));
    render(<EmailSendingCard />);

    expect(await screen.findByText('owner@uckele.test')).toBeVisible();
    expect(screen.getByText(/Last token check/)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Connect Gmail' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog', { name: 'Disconnect Gmail?' });
    expect(posts(fetchMock)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(posts(fetchMock)[0][0]).toBe('/api/admin/deal-hunter/gmail/disconnect');
    expect(await screen.findByRole('link', { name: 'Connect Gmail' })).toBeVisible();
  });

  test('offers Reconnect Gmail when Google access was revoked', async () => {
    stubFetch(status({
      gmail: { connected: true, emailAddress: 'owner@uckele.test', lastTokenOkAt: null, lastErrorCode: 'gmail_token_invalid' },
      readiness: { ready: false, reasons: ['gmail_token_invalid'] },
    }));
    render(<EmailSendingCard />);

    expect(await screen.findByRole('link', { name: 'Reconnect Gmail' })).toHaveAttribute('href', '/api/admin/deal-hunter/gmail/connect');
  });

  test('renders each readiness reason as a plain sentence', async () => {
    stubFetch(status({ readiness: { ready: false, reasons: [
      'gmail_not_connected', 'gmail_token_invalid', 'gmail_token_refresh_failed', 'gmail_address_mismatch',
      'wording_not_approved', 'contact_rule_off', 'live_sending_off', 'signature_incomplete',
    ] } }));
    render(<EmailSendingCard />);

    const list = await screen.findByRole('list', { name: 'Why sending is paused' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      "Gmail isn't connected.",
      'Google access was revoked or expired — reconnect Gmail.',
      "Couldn't reach Google just now; it will retry.",
      "The connected mailbox isn't the configured sending address.",
      "The email wording isn't approved.",
      'The contact rule is off.',
      'Live sending is off.',
      'Your name, title, phone, or mailing address is missing from settings.',
    ]);
    expect(screen.queryByText(/gmail_not_connected/)).not.toBeInTheDocument();
  });

  test('says why sending is held when the sender, reply checking or outreach is off', async () => {
    stubFetch(status({ readiness: { ready: false, reasons: [
      'sender_off', 'reply_poller_off', 'reply_poller_stale', 'central_pause',
    ] } }));
    render(<EmailSendingCard />);

    const list = await screen.findByRole('list', { name: 'Why sending is paused' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'The sender is switched off in server settings.',
      'Reply checking is switched off in server settings, so follow-ups are held.',
      "Reply checking hasn't run recently, so follow-ups are held.",
      'All CIM outreach is paused.',
    ]);
    expect(screen.queryByText('Ready to send.')).not.toBeInTheDocument();
  });

  test('says ready when no reason remains', async () => {
    stubFetch(status({ readiness: { ready: true, reasons: [] } }));
    render(<EmailSendingCard />);
    expect(await screen.findByText('Ready to send.')).toBeVisible();
  });

  test.each([
    ['Approve wording', 'Approve this wording?', { controlKey: 'wording_approval', enabled: true, expectedRevision: 3 }],
    ['Turn on contact rule', 'Turn on the contact rule?', { controlKey: 'contact_rule', enabled: true, expectedRevision: 4 }],
    ['Turn on Live sending', 'Turn on Live sending?', { controlKey: 'live_sending', enabled: true, expectedRevision: 5 }],
  ])('the confirm dialog gates %s', async (buttonName, dialogName, expected) => {
    const fetchMock = stubFetch(status({
      wording: { ...status().wording, revision: 3 },
      contactRule: control({ revision: 4 }),
      liveSending: control({ revision: 5 }),
    }));
    render(<EmailSendingCard />);

    const trigger = await screen.findByRole('button', { name: buttonName });
    fireEvent.click(trigger);
    let dialog = screen.getByRole('dialog', { name: dialogName });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    dialog = screen.getByRole('dialog', { name: dialogName });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(fetchMock)).toHaveLength(0);

    fireEvent.click(trigger);
    dialog = screen.getByRole('dialog', { name: dialogName });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Reviewed today' } });
    fireEvent.click(within(dialog).getByRole('button', { name: buttonName }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    const [url, options] = posts(fetchMock)[0];
    expect(url).toBe(controlsUrl);
    expect(JSON.parse(options.body)).toEqual({ ...expected, reason: 'Reviewed today' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('turning things off is also confirmed and offers the off labels', async () => {
    const fetchMock = stubFetch(status({
      contactRule: control({ enabled: true, policyVersion: 'listing-broker-inquiry-v1', revision: 2 }),
      liveSending: control({ enabled: true, changedAt: '2026-11-03T16:00:00.000Z', changedBy: 'admin', revision: 7 }),
    }));
    render(<EmailSendingCard />);

    expect(await screen.findByText(/listing-broker-inquiry-v1/)).toBeVisible();
    expect(screen.getByText(/Turned on by admin/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Live sending' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off Live sending?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off Live sending' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(posts(fetchMock)[0][1].body)).toEqual({ controlKey: 'live_sending', enabled: false,
      expectedRevision: 7, reason: '' });
    expect(screen.getByRole('button', { name: 'Turn off contact rule' })).toBeVisible();
  });

  test('a stale revision shows a conflict message and reloads', async () => {
    const fetchMock = stubFetch(status(), { onPost: () => ({
      response: jsonResponse({ success: false, code: 'send_control_conflict',
        error: 'This setting changed since the card loaded. Review the latest state and try again.' }, { ok: false, status: 409 }),
    }) });
    render(<EmailSendingCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Turn on contact rule' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on contact rule' }));
    expect(await screen.findByText(/This setting changed since the card loaded/)).toBeVisible();
    expect(fetchMock.mock.calls.filter(([url]) => url === statusUrl).length).toBeGreaterThanOrEqual(2);
  });

  test('a failed Live sending sync shows the server message and a Try again derived from the reloaded status', async () => {
    let attempts = 0;
    const outOfSync = status({ liveSending: control({ enabled: true, revision: 2, capabilitiesInSync: false }),
      readiness: { ready: false, reasons: ['live_sending_not_applied'] } });
    const fetchMock = stubFetch(status({ liveSending: control({ revision: 1, capabilitiesInSync: true }) }), { onPost: () => {
      attempts += 1;
      if (attempts === 1) {
        return { next: outOfSync, response: jsonResponse({ success: false, code: 'live_sending_sync_failed',
          error: 'Live sending was saved as on, but its sending permissions were not fully recorded, so nothing will send yet. Use Try again to finish.',
          control: control({ enabled: true, revision: 2, capabilitiesInSync: false }) }, { ok: false, status: 500 }) };
      }
      return { next: status({ liveSending: control({ enabled: true, revision: 3, capabilitiesInSync: true }),
        readiness: { ready: true, reasons: [] } }),
      response: jsonResponse({ success: true, control: control({ enabled: true, revision: 3, capabilitiesInSync: true }) }) };
    } });
    render(<EmailSendingCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Live sending' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on Live sending' }));
    expect(await screen.findByText(/not fully recorded/)).toBeVisible();
    expect(await screen.findByText(/Live sending is on, but it was not fully applied/)).toBeVisible();
    expect(screen.getByText('Live sending needs to be re-applied — use Try again.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    expect(JSON.parse(posts(fetchMock)[1][1].body)).toEqual({ controlKey: 'live_sending', enabled: true,
      expectedRevision: 2, reason: '' });
    expect(await screen.findByText('Ready to send.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test.each([
    [true, /Live sending is on, but it was not fully applied/],
    [false, /Live sending is off, but it was not fully applied/],
  ])('after a reload, an out-of-sync Live sending (on=%s) shows the re-apply prompt and Try again re-applies it', async (enabled, prompt) => {
    const fetchMock = stubFetch(status({
      liveSending: control({ enabled, revision: 6, capabilitiesInSync: false }),
      readiness: { ready: false, reasons: ['live_sending_not_applied'] },
    }), { onPost: () => ({ next: status({ liveSending: control({ enabled, revision: 7, capabilitiesInSync: true }) }) }) });
    render(<EmailSendingCard />);

    expect(await screen.findByText(prompt)).toBeVisible();
    expect(screen.queryByText('Ready to send.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(JSON.parse(posts(fetchMock)[0][1].body)).toEqual({ controlKey: 'live_sending', enabled,
      expectedRevision: 6, reason: '' });
    await waitFor(() => expect(screen.queryByText(prompt)).not.toBeInTheDocument());
  });

  test('a viewer sees the out-of-sync prompt without a Try again button', async () => {
    const viewerStatus = status({ liveSending: control({ enabled: true, capabilitiesInSync: false }),
      readiness: { ready: false, reasons: ['live_sending_not_applied'] } });
    delete viewerStatus.wording.preview;
    stubFetch(viewerStatus);
    render(<EmailSendingCard readOnly />);
    expect(await screen.findByText(/Live sending is on, but it was not fully applied/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('shows which sending setup Live sending applies to', async () => {
    stubFetch(status({ liveSending: control({ providerProfile: 'controlled-mailbox-v1', capabilitiesInSync: true }) }));
    render(<EmailSendingCard />);
    expect(await screen.findByText('Sending setup: controlled test (one allowed recipient)')).toBeVisible();
  });

  test('says when the server is not set to send through Gmail', async () => {
    stubFetch(status({ readiness: { ready: false, reasons: ['provider_not_gmail'] } }));
    render(<EmailSendingCard />);
    expect(await screen.findByText("The server isn't set to send through Gmail yet (see the Gmail setup runbook).")).toBeVisible();
  });

  test('approve wording is disabled while the signature is incomplete', async () => {
    stubFetch(status({
      wording: { ...status().wording, signatureComplete: false },
      readiness: { ready: false, reasons: ['wording_not_approved', 'signature_incomplete'] },
    }));
    render(<EmailSendingCard />);

    const approve = await screen.findByRole('button', { name: 'Approve wording' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/missing from settings/);
  });

  test('shows the wording preview and the approval date', async () => {
    stubFetch(status({ wording: { ...status().wording, approvedDigest: digest, approvedAt: '2026-11-02T16:00:00.000Z', approvedBy: 'admin' } }));
    render(<EmailSendingCard />);

    expect(await screen.findByText(/Approved by admin/)).toBeVisible();
    expect(screen.getByText('Inquiry about Sample Business')).toBeInTheDocument();
    expect(screen.getByText(/Follow-up body/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve wording' })).toBeDisabled();
  });

  test('flags wording that changed since it was approved', async () => {
    stubFetch(status({ wording: { ...status().wording, approvedDigest: 'b'.repeat(64), approvedAt: '2026-11-02T16:00:00.000Z', approvedBy: 'admin' } }));
    render(<EmailSendingCard />);

    expect(await screen.findByText(/changed since it was approved/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve wording' })).toBeEnabled();
  });

  test('shows the latest sender and reply-poller runs', async () => {
    stubFetch(status({ lastRuns: {
      sender: { status: 'completed', updatedAt: '2026-11-03T15:15:00.000Z', completedAt: '2026-11-03T15:15:00.000Z',
        counts: { sentInitial: 2, sentFollowUps: 3, expired: 1 }, stoppedFor: null, notReadyReasons: [], error: null },
      replyPoller: { status: 'failed', updatedAt: '2026-11-03T15:10:00.000Z', completedAt: null,
        counts: { processed: 4, responded: 1, stopped: 1 }, stoppedFor: null, notReadyReasons: [], error: 'pursue_reply_poller_failed' },
    } }));
    render(<EmailSendingCard />);

    expect(await screen.findByText(/2 initial emails · 3 follow-ups · 1 expired/)).toBeVisible();
    expect(screen.getByText(/4 messages checked · 1 replies · 1 stopped/)).toBeVisible();
    expect(screen.getByText(/pursue_reply_poller_failed/)).toBeVisible();
  });

  test('shows the result of the Gmail connect redirect as a sentence', async () => {
    window.history.replaceState(null, '', '/admin/deal-hunter?view=operations&gmail=gmail_address_mismatch');
    stubFetch(status());
    render(<EmailSendingCard />);
    expect(await screen.findByText(/That Google account isn't the configured sending address/)).toBeVisible();

    cleanup();
    window.history.replaceState(null, '', '/admin/deal-hunter?view=operations&gmail=connected');
    render(<EmailSendingCard />);
    expect(await screen.findByText('Gmail is connected.')).toBeVisible();
  });

  test('a viewer sees status without controls or preview', async () => {
    const viewerStatus = status({ contactRule: control({ enabled: true, policyVersion: 'listing-broker-inquiry-v1' }) });
    delete viewerStatus.wording.preview;
    const fetchMock = stubFetch(viewerStatus);
    render(<EmailSendingCard readOnly />);

    expect(await screen.findByText("Gmail isn't connected.")).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect Gmail' })).not.toBeInTheDocument();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.getByText(/requires a full administrator/)).toBeVisible();
    expect(posts(fetchMock)).toHaveLength(0);
  });

  test('a failed status load shows an error with Retry', async () => {
    let failing = true;
    vi.stubGlobal('fetch', vi.fn(async () => (failing
      ? jsonResponse({ success: false, error: 'Email sending status is unavailable.' }, { ok: false, status: 503 })
      : jsonResponse({ success: true, emailSending: status() }))));
    render(<EmailSendingCard />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Email sending status is unavailable.');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Connect Gmail' })).toBeVisible();
  });
});
