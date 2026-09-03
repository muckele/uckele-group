// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import BrokerMaterialsFollowUps from '../src/components/admin/BrokerMaterialsFollowUps.jsx';

const dueAt = '2026-09-03T16:00:00.000Z';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function followUps(overrides = {}) {
  return {
    enrolled: true,
    policyVersion: 'deal-hunter-manual-follow-up-v1',
    maximumFollowUps: 5,
    followUpCount: 0,
    currentFollowUpNumber: 1,
    nextFollowUpAt: dueAt,
    state: 'due',
    terminalReason: '',
    retryEligible: false,
    preparationBlockers: [],
    sendBlockers: [],
    ...overrides,
  };
}

function prepared(overrides = {}) {
  return {
    success: true,
    previewOnly: false,
    preparationToken: 'signed.follow-up',
    proposalDigest: 'b'.repeat(64),
    preparedAt: '2026-09-03T16:01:00.000Z',
    expiresAt: '2099-09-03T16:16:00.000Z',
    followUps: followUps(),
    sendBlockers: [],
    review: {
      mode: 'first-attempt',
      followUpNumber: 1,
      dueAt,
      initialRequestedAt: '2026-09-01T16:00:00.000Z',
      previousAcceptedAt: '2026-09-01T16:01:00.000Z',
      recipient: { displayName: 'Jane Broker', email: 'jane@example.test' },
      sender: { displayName: 'Mathew Uckele', email: 'mathew@example.test', replyTo: 'request@example.test' },
      message: {
        greeting: 'Hello Jane,',
        greetingEditable: true,
        subject: 'Following up on Evergreen Fire Protection',
        body: 'Hello Jane,\n\nFollowing up on Evergreen Fire Protection.\n\nThank you,\nMathew',
        html: '<p>Hello Jane,</p>',
        templateVersion: 'deal-hunter-cim-follow-up-1-v1',
      },
      communication: { id: 'communication-1', providerIdempotencyKey: 'follow-up-1' },
    },
    ...overrides,
  };
}

function renderFollowUps(props = {}) {
  return render(<BrokerMaterialsFollowUps
    businessName="Evergreen Fire Protection"
    followUps={followUps()}
    onApprove={vi.fn(async () => true)}
    onCheckStatus={vi.fn(async () => true)}
    onInvalidatePreparation={vi.fn()}
    onPrepare={vi.fn(async () => true)}
    onStart={vi.fn(async () => true)}
    onStop={vi.fn(async () => true)}
    {...props}
  />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Broker Materials Follow-Ups', () => {
  test('renders not-enrolled scheduled due overdue accepted-next completed stopped and terminal-closed states', () => {
    const { rerender } = renderFollowUps({ followUps: followUps({ enrolled: false, state: 'not-enrolled', followUpCount: 0, currentFollowUpNumber: 1, nextFollowUpAt: '', startEligible: true, startBlockers: [] }) });
    expect(screen.getByText('Not Scheduled')).toBeVisible();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'scheduled' })} />);
    expect(screen.getByText('Scheduled')).toBeVisible();
    expect(screen.getByText(/Follow-Up 1 of 5/)).toBeVisible();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'due' })} />);
    expect(screen.getByText('Due')).toBeVisible();
    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'overdue' })} />);
    expect(screen.getByText('Overdue')).toBeVisible();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'scheduled', followUpCount: 1, currentFollowUpNumber: 2 })} />);
    expect(screen.getByText(/1 of 5 sent/)).toBeVisible();
    expect(screen.getByText(/Follow-Up 2 of 5/)).toBeVisible();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'completed', followUpCount: 5, currentFollowUpNumber: null, nextFollowUpAt: '' })} />);
    expect(screen.getByText('Completed')).toBeVisible();
    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'stopped', currentFollowUpNumber: null, nextFollowUpAt: '' })} />);
    expect(screen.getByText('Stopped')).toBeVisible();
    rerender(<BrokerMaterialsFollowUps followUps={followUps({ enrolled: false, state: 'closed', currentFollowUpNumber: null, nextFollowUpAt: '', terminalReason: 'reply_received', startEligible: false, startBlockers: [{ code: 'reply_received', message: 'The broker has replied.' }] })} />);
    expect(screen.getByText('Closed')).toBeVisible();
    expect(screen.getByText('The broker has replied.')).toBeVisible();
  });

  test('administrator can start and stop while viewer receives no mutation controls or approval authority', async () => {
    const onStart = vi.fn();
    const { rerender } = renderFollowUps({ followUps: followUps({ enrolled: false, state: 'not-enrolled', nextFollowUpAt: '', startEligible: true, startBlockers: [] }), onStart });
    fireEvent.click(screen.getByRole('button', { name: 'Start Follow-Up Sequence' }));
    expect(onStart).toHaveBeenCalledTimes(1);

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'scheduled' })} onStop={vi.fn()} />);
    const stop = screen.getByRole('button', { name: 'Stop Follow-Up Sequence' });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);
    expect(screen.getByRole('dialog', { name: 'Permanently stop follow-ups' })).toBeVisible();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'due' })} preparation={prepared({ previewOnly: true, preparationToken: undefined, proposalDigest: undefined })} readOnly />);
    expect(screen.queryByRole('button', { name: /Start|Stop|Review|Approve|Retry/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Follow-up greeting')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('signed.follow-up');
    expect(document.body).not.toHaveTextContent('bbbbbbbb');
  });

  test('due review displays durable recipient sender subject selectable body prior touch and exact follow-up number', () => {
    renderFollowUps({ preparation: prepared() });
    const review = screen.getByTestId('broker-materials-follow-up-review');
    expect(within(review).getByRole('heading', { name: 'Review Follow-Up 1 of 5' })).toBeVisible();
    expect(within(review).getByText(/Jane Broker.*jane@example\.test/)).toBeVisible();
    expect(within(review).getByText(/Mathew Uckele.*mathew@example\.test/)).toBeVisible();
    expect(within(review).getByLabelText('Follow-up subject')).toHaveValue('Following up on Evergreen Fire Protection');
    expect(within(review).getByLabelText('Complete follow-up body')).toHaveValue(prepared().review.message.body);
    expect(within(review).getByText(/Initial request.*Sep 1, 2026/i)).toBeVisible();
    expect(within(review).getByText(/Previous provider acceptance.*Sep 1, 2026/i)).toBeVisible();
  });

  test('greeting is the only editable first-attempt field and Enter updates preview without sending', async () => {
    const onPrepare = vi.fn(async () => true);
    const onApprove = vi.fn(async () => true);
    renderFollowUps({ onApprove, onPrepare, preparation: prepared() });
    const greeting = screen.getByLabelText('Follow-up greeting');
    expect(greeting).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Follow-up subject')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Complete follow-up body')).toHaveAttribute('readonly');
    fireEvent.change(greeting, { target: { value: 'Hi Jane,' } });
    fireEvent.keyDown(greeting, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith({ greeting: 'Hi Jane,' }));
    expect(onApprove).not.toHaveBeenCalled();
  });

  test('changed greeting invalidates approval until Update Preview returns a fresh proposal', async () => {
    const update = deferred();
    const onInvalidatePreparation = vi.fn();
    const onPrepare = vi.fn(() => update.promise);
    const { rerender } = renderFollowUps({ onInvalidatePreparation, onPrepare, preparation: prepared() });
    fireEvent.change(screen.getByLabelText('Follow-up greeting'), { target: { value: 'Hi Jane,' } });
    expect(onInvalidatePreparation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update Preview' }));
    expect(screen.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeDisabled();
    await act(async () => update.resolve(true));
    rerender(<BrokerMaterialsFollowUps followUps={followUps()} onApprove={vi.fn()} onPrepare={onPrepare} preparation={prepared({ review: { ...prepared().review, message: { ...prepared().review.message, greeting: 'Hi Jane,', body: 'Hi Jane,\n\nFollowing up.' } } })} />);
    expect(screen.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeEnabled();
  });

  test('Approve and Send locks synchronously discards authority and reloads authoritative detail', async () => {
    const approval = deferred();
    const onApprove = vi.fn(() => approval.promise);
    const onInvalidatePreparation = vi.fn();
    renderFollowUps({ onApprove, onInvalidatePreparation, preparation: prepared() });
    const approve = screen.getByRole('button', { name: 'Approve & Send Follow-Up' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.keyDown(approve, { key: 'Enter' });
    expect(onInvalidatePreparation).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ preparationToken: 'signed.follow-up', proposalDigest: 'b'.repeat(64) }));
    await act(async () => approval.resolve(true));
  });

  test('definitive failure Review Retry displays exact persisted read-only content', () => {
    const retry = prepared({ review: { ...prepared().review, mode: 'exact-retry', message: { ...prepared().review.message, greetingEditable: false, subject: 'Exact persisted subject', body: 'Exact persisted failed communication.' } } });
    renderFollowUps({ followUps: followUps({ state: 'retry', retryEligible: true }), preparation: retry });
    expect(screen.getByRole('heading', { name: 'Review Retry Follow-Up 1 of 5' })).toBeVisible();
    expect(screen.queryByLabelText('Follow-up greeting')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Follow-up subject')).toHaveValue('Exact persisted subject');
    expect(screen.getByLabelText('Complete follow-up body')).toHaveValue('Exact persisted failed communication.');
  });

  test('ambiguous unknown outcome shows Checking and Check Again without retry or resend', () => {
    const onCheckStatus = vi.fn();
    renderFollowUps({ checking: true, checkingFailed: true, followUps: followUps({ state: 'ambiguous' }), onCheckStatus });
    expect(screen.getByText('Checking')).toBeVisible();
    expect(screen.getByText(/retransmission is prohibited/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Review|Retry|Approve|Send Again/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    expect(onCheckStatus).toHaveBeenCalledTimes(1);
  });

  test('future due has no Review action and exposes no early-send override', () => {
    renderFollowUps({ followUps: followUps({ state: 'scheduled' }) });
    expect(screen.queryByRole('button', { name: /Review|Send Now|Override|Early/i })).not.toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeVisible();
  });

  test('pause cadence readiness and delivery blockers are clear and never expose overrides', () => {
    const blockers = [
      { code: 'cim_outreach_paused', message: 'Deal Hunter CIM outreach is globally paused.' },
      { code: 'recipient_cadence', message: 'The durable recipient is blocked by the current CIM cadence policy.' },
      { code: 'provider_not_ready', message: 'The outbound provider is not ready.' },
      { code: 'delivery_delayed', message: 'The preceding message is delayed.' },
    ];
    renderFollowUps({ followUps: followUps({ sendBlockers: blockers }), preparation: prepared({ sendBlockers: blockers }) });
    blockers.forEach(({ message }) => expect(screen.getAllByText(message)[0]).toBeVisible());
    expect(screen.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Override|Send Anyway/i })).not.toBeInTheDocument();
  });

  test('focus moves intentionally for start stop prepare update approve failure and close transitions', async () => {
    const onPrepare = vi.fn(async () => false);
    const { rerender } = renderFollowUps({ followUps: followUps({ enrolled: false, state: 'not-enrolled', nextFollowUpAt: '', startEligible: true, startBlockers: [] }) });
    const start = screen.getByRole('button', { name: 'Start Follow-Up Sequence' });
    start.focus();
    fireEvent.click(start);
    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'scheduled' })} />);
    expect(screen.getByRole('heading', { name: 'Follow-Ups' })).toHaveFocus();

    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'scheduled' })} onStop={vi.fn(async () => true)} />);
    const stop = screen.getByRole('button', { name: 'Stop Follow-Up Sequence' });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);
    expect(screen.getByLabelText('Stop reason (optional)')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Permanently stop follow-ups' }), { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Follow-Up Sequence' })).toHaveFocus());

    rerender(<BrokerMaterialsFollowUps followUps={followUps()} onPrepare={onPrepare} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review Follow-Up' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Follow-Ups' })).toHaveFocus());
  });

  test('one stable live region announces preparing updated sending checking and final status once', () => {
    const { rerender } = renderFollowUps({ preparing: true });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing follow-up review.');
    rerender(<BrokerMaterialsFollowUps followUps={followUps()} preparation={prepared()} updated />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Follow-up preview updated.');
    rerender(<BrokerMaterialsFollowUps followUps={followUps()} preparation={prepared()} sending />);
    expect(screen.getByRole('status')).toHaveTextContent('Sending approved follow-up.');
    rerender(<BrokerMaterialsFollowUps checking followUps={followUps({ state: 'ambiguous' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking authoritative follow-up status.');
    rerender(<BrokerMaterialsFollowUps followUps={followUps({ state: 'completed', followUpCount: 5, currentFollowUpNumber: null, nextFollowUpAt: '' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Follow-up sequence completed.');
  });
});
