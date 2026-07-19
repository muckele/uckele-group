// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import DealHunterWorkspace, { getCimRequestPresentation } from '../src/components/admin/DealHunterWorkspace.jsx';

beforeAll(() => {
  global.IntersectionObserver = class IntersectionObserver {
    observe() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function reviewWithDeal(cimRequest) {
  return {
    totals: {},
    sources: [],
    criteriaRecommendations: [],
    qualified: [
      {
        id: 'deal-1',
        dealKey: 'deal-1',
        name: 'Recurring HVAC Services',
        score: 82,
        sourceName: 'Test source',
        strengths: ['Recurring maintenance contracts'],
        questions: ['What percentage of revenue is recurring?'],
        cimRequest,
      },
    ],
    watchlist: [],
    removalCandidates: [],
  };
}

describe('Deal Hunter CIM lifecycle presentation', () => {
  test('keeps an in-progress follow-up in the warning state with its schedule', () => {
    const presentation = getCimRequestPresentation({
      status: 'follow_up_pending',
      recipientEmail: 'broker@example.com',
      nextFollowUpAt: '2026-07-14T17:00:00.000Z',
    });

    expect(presentation.tone).toBe('warning');
    expect(presentation.statusLabel).toBe('Follow-up pending');
    expect(presentation.description).toContain('broker@example.com');
    expect(presentation.description).toContain('Next follow-up:');
  });

  test('retains delivery errors, questions, and read-only messaging after extraction', () => {
    render(
      <DealHunterWorkspace
        feedback={{ error: '', message: '' }}
        onReview={vi.fn()}
        readOnly
        review={reviewWithDeal({
          status: 'delivery_issue',
          recipientEmail: 'broker@example.com',
          requestedAt: '2026-07-13T17:00:00.000Z',
          deliveryError: 'Mailbox rejected the CIM request.',
          canRequest: true,
        })}
      />,
    );

    expect(screen.getByText('Delivery issue')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Mailbox rejected the CIM request.');
    expect(screen.getByText('Read-only access')).toBeVisible();
    expect(screen.getByText('What percentage of revenue is recurring?')).toBeVisible();
  });

  test('announces action failures and retains the daily-email job error', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.dailyEmailJob = {
      status: 'failed',
      attempt_count: 2,
      last_error: 'Email provider rejected the daily review.',
    };

    render(
      <DealHunterWorkspace
        feedback={{ error: 'Unable to refresh Deal Hunter.', message: '' }}
        onReview={vi.fn()}
        review={review}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Unable to refresh Deal Hunter.');
    expect(screen.getByText('Email provider rejected the daily review.')).toBeVisible();
    expect(screen.getByText(/Failed · attempt 2/)).toBeVisible();
  });

  test('labels a failed broker send as retryable and shows the previous failure context', () => {
    render(
      <DealHunterWorkspace
        feedback={{ error: '', message: '' }}
        onReview={vi.fn()}
        onSendCimRequest={vi.fn()}
        review={reviewWithDeal({
          eligible: true,
          canRequest: true,
          status: 'failed',
          recipientEmail: 'broker@example.com',
          deliveryError: 'Provider rejected the previous attempt.',
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry CIM Request' })).toBeEnabled();
    expect(screen.getByText(/previous send attempt failed/i)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Provider rejected the previous attempt.');
  });

  test('blocks the follow-up control until inbound reply tracking is verified', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.emailReadiness = {
      provider: 'resend',
      outboundConfigured: true,
      deliveryTrackingConfigured: true,
      deliveryTrackingVerified: true,
      replyTrackingConfigured: true,
      replyTrackingVerified: false,
      followUpsEnabled: false,
      followUpsSafe: false,
      testRecipient: 'admin@example.com',
      issues: ['Inbound reply tracking is configured but has not passed an end-to-end reply test yet.'],
    };

    render(
      <DealHunterWorkspace
        feedback={{ error: '', message: '' }}
        onReview={vi.fn()}
        onRunFollowUps={vi.fn()}
        review={review}
      />,
    );

    expect(screen.getByRole('button', { name: 'Follow-Ups Paused' })).toBeDisabled();
    expect(screen.getByText('Configured; reply test still required')).toBeVisible();
  });

  test('requires an explicit approval before recipient correction and bulk send', () => {
    const onSendReady = vi.fn();
    const review = reviewWithDeal({
      eligible: true,
      canRequest: true,
      status: 'ready',
      recipientEmail: 'broker@example.com',
      snapshotToken: 'signed-review-snapshot',
      preview: { subject: 'CIM / NDA request for Recurring HVAC Services', text: 'Hello Broker,\n\nPlease send the CIM.' },
    });
    review.totals.cimReady = 1;

    render(
      <DealHunterWorkspace
        feedback={{ error: '', message: '' }}
        onOpenApprovals={vi.fn()}
        onReview={vi.fn()}
        onSendReady={onSendReady}
        review={review}
      />,
    );

    const sendButton = screen.getByRole('button', { name: 'Save Review' });
    expect(sendButton).toBeDisabled();
    expect(screen.getByText('Review all 1 pending request before saving.')).toBeVisible();
    fireEvent.click(screen.getByText('Preview exact broker email'));
    expect(screen.getByText('Subject: CIM / NDA request for Recurring HVAC Services')).toBeVisible();
    expect(screen.getByText(/Please send the CIM/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const recipient = screen.getByLabelText('Broker recipient for Recurring HVAC Services');
    fireEvent.change(recipient, { target: { value: 'corrected@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 Approved' }));

    expect(onSendReady).toHaveBeenCalledWith(
      [expect.objectContaining({ confirmedRecipientEmail: 'corrected@example.com' })],
      [expect.objectContaining({ decision: 'approved', finalRecipientEmail: 'corrected@example.com', snapshotToken: 'signed-review-snapshot' })],
    );
  });

  test('requires a structured reason before saving a pass decision', () => {
    const onSendReady = vi.fn();
    const review = reviewWithDeal({ eligible: true, canRequest: true, status: 'ready', recipientEmail: 'broker@example.com' });
    review.totals.cimReady = 1;

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} onSendReady={onSendReady} review={review} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    expect(screen.getByRole('button', { name: 'Save Review' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Pass reason'), { target: { value: 'valuation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Review' }));
    expect(onSendReady).toHaveBeenCalledWith([], [expect.objectContaining({ decision: 'rejected', passReason: 'valuation' })]);
  });
});
