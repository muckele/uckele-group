// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  test('opens the complete opportunity review with a safe link to the original broker listing', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    Object.assign(review.qualified[0], {
      listingUrl: 'https://broker.example/listings/recurring-hvac',
      recommendation: 'High fit. Validate financial quality before advancing.',
      concerns: ['Customer concentration needs validation.', 'Confirm owner responsibilities.'],
      strengths: ['Recurring maintenance contracts', 'Commercial customer base'],
      questions: ['What percentage of revenue is recurring?', 'What does the owner do each week?'],
      brokerName: 'Jamie Broker',
      annualRevenue: 1800000,
    });

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recurring HVAC Services' }));

    const dialog = screen.getByRole('dialog', { name: 'Recurring HVAC Services' });
    expect(dialog).toBeVisible();
    expect(dialog.querySelector('article')).toHaveClass('bg-parchment');
    expect(dialog.querySelector('header')).toHaveClass('bg-parchment');
    expect(within(dialog).getByText('High fit. Validate financial quality before advancing.')).toBeVisible();
    expect(within(dialog).getByText('Customer concentration needs validation.')).toBeVisible();
    expect(within(dialog).getByText('What does the owner do each week?')).toBeVisible();
    expect(within(dialog).getByText('Jamie Broker')).toBeVisible();
    const listingButton = within(dialog).getByRole('link', { name: 'View original listing' });
    expect(listingButton).toHaveAttribute('href', 'https://broker.example/listings/recurring-hvac');
    expect(listingButton).toHaveAttribute('target', '_blank');
    expect(listingButton).toHaveAttribute('rel', 'noreferrer');
    expect(within(dialog).queryByText('https://broker.example/listings/recurring-hvac')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close opportunity review' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('does not make an unsafe broker listing URL clickable', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.qualified[0].listingUrl = 'javascript:alert(1)';

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recurring HVAC Services' }));

    expect(screen.getByText('Original broker listing unavailable')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'View original listing' })).not.toBeInTheDocument();
  });

  test('shows listing-link coverage and non-fatal workbook warnings', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.sources = [{
      id: 'sheet-0',
      name: 'SMB Deal Hunter Google Sheet',
      mode: 'csv',
      fetched: true,
      rowCount: 871,
      listingUrlCount: 302,
      listingUrlExpectedCount: 305,
      listingUrlWarning: 'Workbook export timed out; CSV deals were still imported.',
    }];

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);

    expect(screen.getByText('302 of 305 original listing links available (99%).')).toBeVisible();
    expect(screen.getByText(/Listing-link import warning: Workbook export timed out/)).toBeVisible();
    expect(screen.getByText('871 rows')).toBeVisible();
  });

  test('imports a fresh Deal OS export with explicit scope, coverage, timestamp, and expected count', () => {
    const onImportDealOs = vi.fn();
    const file = new File(['Listing ID,Business Name\nDOS-1,HVAC'], 'deal-os.csv', {
      type: 'text/csv',
      lastModified: new Date('2026-08-10T16:00:00.000Z').getTime(),
    });
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.dealOsImportPolicy = { maxRecords: 1000, maxAgeHours: 72 };

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onImportDealOs={onImportDealOs} onReview={vi.fn()} review={review} />);

    fireEvent.change(screen.getByLabelText('Deal OS export file'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Export type'), { target: { value: 'deal-radar' } });
    fireEvent.change(screen.getByLabelText('Coverage description'), { target: { value: 'NY field service filters' } });
    fireEvent.change(screen.getByLabelText('Exported at'), { target: { value: '2026-08-10T09:00' } });
    fireEvent.change(screen.getByLabelText(/Expected listings shown by Deal OS/), { target: { value: '1' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Validate & Import' }).closest('form'));

    expect(onImportDealOs).toHaveBeenCalledWith({
      file,
      scope: 'deal-radar',
      coverageLabel: 'NY field service filters',
      exportedAt: expect.any(String),
      expectedRowCount: '1',
      runFullBackfill: false,
    });
  });

  test('keeps full-backfill scoring explicit and separate from CRM sync', () => {
    const onImportDealOs = vi.fn();
    const file = new File(['Listing ID,Business Name\nDOS-1,HVAC'], 'deal-os.csv', {
      type: 'text/csv',
      lastModified: new Date('2026-08-10T16:00:00.000Z').getTime(),
    });
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.dealOsImportPolicy = { maxRecords: 1000, maxAgeHours: 72 };

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onImportDealOs={onImportDealOs} onReview={vi.fn()} review={review} />);

    fireEvent.change(screen.getByLabelText('Deal OS export file'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Coverage description'), { target: { value: 'Full saved search' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Score all current listings after import/ }));
    fireEvent.submit(screen.getByRole('button', { name: 'Validate & Import' }).closest('form'));

    expect(onImportDealOs).toHaveBeenCalledWith(expect.objectContaining({ runFullBackfill: true }));
    expect(screen.getByText(/does not create CRM records or send email/i)).toBeVisible();
  });

  test('shows post-import counts and only enables explicit CRM sync for eligible reviewed deals', () => {
    const onSyncHighFits = vi.fn();
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.reviewMode = 'full-backfill';
    review.totals = { reviewedDeals: 261, qualified: 3, crmEligible: 3 };
    const importSummary = {
      reviewMode: 'full-backfill',
      importedRows: 261,
      canonicalListings: 254,
      withinFileDuplicates: 1,
      collapsedDuplicates: 6,
      scoredListings: 261,
      highFitListings: 3,
      syncedListings: 0,
      fieldCoverage: {
        totalRecords: 261,
        fields: [
          { key: 'industry', label: 'Industry', present: 0, percent: 0 },
          { key: 'description', label: 'Description / notes', present: 0, percent: 0 },
          { key: 'brokerEmail', label: 'Broker email', present: 0, percent: 0 },
        ],
      },
    };

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} importSummary={importSummary} onReview={vi.fn()} onSyncHighFits={onSyncHighFits} review={review} />);

    expect(screen.getByRole('region', { name: 'Latest Deal OS import summary' })).toHaveTextContent('261');
    expect(screen.getByText(/Missing fields remain visibly undisclosed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Sync 3 High Fits to CRM' }));
    expect(onSyncHighFits).toHaveBeenCalledOnce();
  });

  test('makes the required coverage field actionable instead of silently disabling import', () => {
    const file = new File(['Listing,Listing URL\nHVAC,https://broker.example/hvac'], 'marketplace-export.csv', {
      type: 'text/csv',
      lastModified: new Date('2026-08-10T16:00:00.000Z').getTime(),
    });
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.dealOsImportPolicy = { maxRecords: 1000, maxAgeHours: 72 };

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onImportDealOs={vi.fn()} onReview={vi.fn()} review={review} />);
    fireEvent.change(screen.getByLabelText('Deal OS export file'), { target: { files: [file] } });

    expect(screen.getByRole('button', { name: 'Validate & Import' })).toBeEnabled();
    expect(screen.getByLabelText(/Coverage description/)).toBeRequired();
    expect(screen.getByText(/Describe the saved search or Deal Radar filters/)).toBeVisible();
  });

  test('surfaces Deal OS provenance and an explicit limited-coverage warning when Airtable is retired', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.coverageWarnings = ['Legacy Airtable is disabled. Deal OS coverage is limited to one saved search.'];
    review.sources = [{
      id: 'deal-os-export',
      name: 'SMB Deal OS export',
      mode: 'manual-export',
      fetched: true,
      rowCount: 120,
      exportedAt: '2026-08-10T16:00:00.000Z',
      importedAt: '2026-08-10T16:05:00.000Z',
      importedBy: 'mathew@example.com',
      importAgeHours: 2.5,
      scope: 'saved-search',
      coverageLabel: 'All active criteria',
      stableIdCount: 118,
      listingUrlCount: 120,
    }];
    review.disabledSources = [{
      id: 'airtable-disabled',
      name: 'Legacy Airtable Biz List',
      mode: 'disabled',
      disabled: true,
      fetched: true,
      reason: 'Explicitly retired with DEAL_HUNTER_AIRTABLE_ENABLED=false.',
    }];

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Limited source coverage.');
    expect(screen.getByRole('alert')).toHaveTextContent('Legacy Airtable is disabled');
    expect(screen.getByText('Saved Search · All active criteria')).toBeVisible();
    expect(screen.getByText('118 stable ID · 120 listing URLs')).toBeVisible();
    expect(screen.getByText(/by mathew@example.com/)).toBeVisible();
    expect(screen.getByText('Legacy Airtable Biz List').closest('div')).toHaveTextContent('disabled');
  });

  test('labels configuration failures as setup-needed and flags partial totals', () => {
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.sources = [{
      id: 'airtable-shared',
      name: 'Airtable Biz List',
      mode: 'shared-view',
      fetched: false,
      rowCount: 0,
      error: 'Airtable shared view requires API mode.',
      requiresConfiguration: true,
      configurationKey: 'DEAL_HUNTER_AIRTABLE_TOKEN',
    }];

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);

    expect(screen.getByText('setup needed')).toBeVisible();
    expect(screen.getByText(/Required setting:/)).toHaveTextContent('DEAL_HUNTER_AIRTABLE_TOKEN');
    expect(screen.getByRole('alert')).toHaveTextContent('Partial review.');
    expect(screen.getByRole('alert')).toHaveTextContent('totals and candidates cover only successfully imported sources');
  });

  test('pauses daily email and CIM outreach while a source review is partial', () => {
    const review = reviewWithDeal({
      eligible: true,
      canRequest: true,
      status: 'failed',
      recipientEmail: 'broker@example.com',
    });
    review.totals.cimReady = 1;
    review.sources = [{
      id: 'airtable-shared',
      name: 'Airtable Biz List',
      mode: 'shared-view',
      fetched: false,
      error: 'Airtable shared view requires API mode.',
      requiresConfiguration: true,
      configurationKey: 'DEAL_HUNTER_AIRTABLE_TOKEN',
    }];

    render(
      <DealHunterWorkspace
        feedback={{ error: '', message: '' }}
        onOpenApprovals={vi.fn()}
        onReview={vi.fn()}
        onSendCimRequest={vi.fn()}
        onSendEmail={vi.fn()}
        onSendReady={vi.fn()}
        review={review}
      />,
    );

    expect(screen.getByRole('button', { name: 'Review CIM Requests' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send Internal Daily Summary' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry CIM Request' })).toBeDisabled();
    expect(screen.getByText('Complete a successful source review before approving or sending CIM requests.')).toBeVisible();
    expect(screen.getByText('Complete the source review before outreach')).toBeVisible();
  });

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

  test('keeps durable CIM lifecycle and CRM links visible on watchlist and removal cards', () => {
    const watchDeal = {
      id: 'watch-deal',
      dealKey: 'watch-deal',
      name: 'Watchlist Industrial Services',
      score: 68,
      sourceName: 'Test source',
      strengths: ['Recurring customers'],
      cimRequest: {
        status: 'sent',
        requestState: 'provider_accepted',
        deliveryState: 'accepted',
        recipientEmail: 'watch@broker.example',
        submissionId: 'watch-submission',
        firstProviderAcceptedAt: '2026-08-06T17:00:00.000Z',
      },
    };
    const removalDeal = {
      id: 'remove-deal',
      dealKey: 'remove-deal',
      name: 'Unavailable Field Services',
      score: 44,
      sourceName: 'Test source',
      removeReasons: ['Listing is no longer available'],
      cimRequest: {
        status: 'delivery_issue',
        requestState: 'provider_accepted',
        deliveryState: 'bounced',
        recipientEmail: 'old@broker.example',
        submissionId: 'remove-submission',
        deliveryError: 'Mailbox rejected the message.',
      },
    };
    const review = reviewWithDeal({ eligible: false, reason: 'No recipient.' });
    review.qualified = [];
    review.watchlist = [watchDeal];
    review.removalCandidates = [removalDeal];

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} review={review} />);

    expect(screen.getByText('Watchlist Industrial Services').closest('article')).toHaveTextContent('Awaiting delivery');
    expect(screen.getByText('Unavailable Field Services').closest('article')).toHaveTextContent('Bounced');
    expect(screen.getAllByRole('link', { name: 'Open CIM history' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Open CRM communications' }).map((link) => link.getAttribute('href'))).toEqual([
      '/admin/crm/watch-submission',
      '/admin/crm/remove-submission',
    ]);
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

  test('selects one scraped contact and keeps the greeting synchronized with that recipient', () => {
    const onSendReady = vi.fn();
    const review = reviewWithDeal({
      eligible: true,
      canRequest: true,
      status: 'ready',
      recipientEmail: 'erin@broker.example',
      snapshotToken: 'signed-multi-contact-snapshot',
      preview: { subject: 'CIM request', text: 'Hello Erin,\n\nPlease send the CIM.' },
      contactPreviews: [
        { email: 'erin@broker.example', name: 'Erin', subject: 'CIM request', text: 'Hello Erin,\n\nPlease send the CIM.' },
        { email: 'alex@broker.example', name: 'Alex', subject: 'CIM request', text: 'Hello Alex,\n\nPlease send the CIM.' },
      ],
    });
    Object.assign(review.qualified[0], {
      brokerEmail: 'erin@broker.example',
      brokerName: 'Erin',
      brokerContacts: [
        { email: 'erin@broker.example', name: 'Erin', role: 'Broker', sourceColumn: 'Broker Email' },
        { email: 'alex@broker.example', name: 'Alex', role: 'Contact', sourceColumn: 'Contact Email 2' },
      ],
    });
    review.totals.cimReady = 1;

    render(<DealHunterWorkspace feedback={{ error: '', message: '' }} onReview={vi.fn()} onSendReady={onSendReady} review={review} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByText('Preview exact broker email'));
    fireEvent.change(screen.getByLabelText('Broker contact for Recurring HVAC Services'), { target: { value: 'alex@broker.example' } });

    expect(screen.getByLabelText('Broker recipient for Recurring HVAC Services')).toHaveValue('alex@broker.example');
    expect(screen.getByLabelText('Broker recipient name for Recurring HVAC Services')).toHaveValue('Alex');
    expect(screen.getByText(/Hello Alex,/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Send 1 Approved' }));
    expect(onSendReady).toHaveBeenCalledWith(
      [expect.objectContaining({ confirmedRecipientEmail: 'alex@broker.example', confirmedRecipientName: 'Alex' })],
      [expect.objectContaining({ finalRecipientEmail: 'alex@broker.example', finalRecipientName: 'Alex' })],
    );
  });
});
