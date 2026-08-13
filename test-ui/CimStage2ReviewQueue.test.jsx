// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CimStage2ReviewQueue from '../src/components/admin/CimStage2ReviewQueue.jsx';

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function queueResponse({ page = 1, candidates = [] } = {}) {
  return {
    success: true,
    queue: {
      version: 'cim-stage2-deterministic-review-queue-v1',
      generatedAt: '2026-08-12T18:00:00.000Z',
      sourceHealthy: true,
      queueDigest: 'a'.repeat(64),
      page,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      hasMore: page < 2,
      counts: { currentPolicyRemaining: 2 },
      progress: {
        canonicalHumanReviews: 9,
        canonicalHumanReviewsRequired: 25,
        eligibleCohortReviews: 0,
        eligibleCohortRequired: 10,
        unchangedRecipientApprovalRate: 0,
        unchangedRecipientApprovalRateRequired: 95,
      },
      policy: {
        policyHash: 'b'.repeat(64),
        ruleVersion: 'rules-v2',
        sourcePolicyHash: 'c'.repeat(64),
        evidenceVersion: 'evidence-v2',
        allowedSourceIds: ['sheet-0'],
      },
      candidates,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('protected Stage 2 human review queue', () => {
  test('presents one deterministic candidate and records one explicit zero-send decision before refreshing counters', async () => {
    const candidate = {
      opportunityId: 'opportunity-1',
      dealKey: 'deal-1',
      name: 'Commercial HVAC Maintenance',
      listingUrl: 'https://example.test/listing',
      sourceId: 'sheet-0',
      sourceName: 'SMB Sheet',
      score: 95,
      industry: 'Commercial HVAC maintenance',
      location: 'Phoenix, AZ',
      annualProfit: 500000,
      askingPrice: 1500000,
      brokerName: 'Jane Broker',
      brokerEmail: 'jane.broker@example.test',
      queueRank: 'd'.repeat(64),
      currentPolicyReviewed: false,
      exactSnapshotReviewed: false,
      reviewToken: 'signed-review-token',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => jsonResponse(queueResponse({ candidates: [candidate] })))
      .mockImplementationOnce((_url, options) => {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
          reviewToken: 'signed-review-token',
          action: 'reject',
          passReason: 'industry',
          reviewConfirmed: true,
        });
        return jsonResponse({ success: true, recorded: { id: 'review-1' }, automation: { metrics: { canonicalHumanReviews: 10 } } }, 201);
      })
      .mockImplementationOnce(() => jsonResponse(queueResponse({ page: 2, candidates: [] })));
    const onEvidenceRecorded = vi.fn().mockResolvedValue(undefined);
    render(<CimStage2ReviewQueue onEvidenceRecorded={onEvidenceRecorded} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load human review queue' }));
    expect(await screen.findByRole('heading', { name: 'Commercial HVAC Maintenance' })).toBeVisible();
    expect(screen.getByText('9 / 25')).toBeVisible();
    expect(screen.getByText('0 / 10')).toBeVisible();
    expect(screen.getByText('0% / 95%')).toBeVisible();
    expect(screen.getByText(/hash-determined order that does not use score, eligibility, or predicted approval/i)).toBeVisible();
    expect(screen.queryByText(/eligible cohort candidate/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Reject'));
    fireEvent.click(screen.getByLabelText(/I personally checked this candidate’s Sheet source/i));
    fireEvent.click(screen.getByRole('button', { name: 'Record this decision (zero send)' }));

    expect(await screen.findByText(/One authenticated human decision was appended/i)).toBeVisible();
    await waitFor(() => expect(onEvidenceRecorded).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/deal-hunter/cim-stage2/review-decisions');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-ready'))).toBe(false);
  });
});
