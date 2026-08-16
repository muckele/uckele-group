// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import DealHunterTriage from '../src/components/admin/DealHunterTriage';

function triageRow(overrides = {}) {
  return {
    opportunityId: 'opp-1',
    dealKey: 'deal-1',
    name: 'Commercial Fire Safety Inspection Co',
    state: 'NY',
    listingUrl: 'https://listings.example.invalid/opp-1',
    fitScore: 81,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 92,
    missingEvidenceCount: 1,
    missingEvidence: ['annualRevenue'],
    contradictionCount: 0,
    confidenceReasons: [],
    gates: [],
    shouldRemove: false,
    highFit: true,
    dimensions: [
      { id: 'financial-fit', label: 'Financial fit', contribution: 37, verdict: 'supported', missingCount: 0, contradictionCount: 0 },
      { id: 'revenue-durability', label: 'Revenue durability', contribution: 14, verdict: 'supported', missingCount: 0, contradictionCount: 0 },
      { id: 'demand-resilience', label: 'Demand resilience', contribution: 12, verdict: 'supported', missingCount: 0, contradictionCount: 0 },
      { id: 'transferability', label: 'Transferability', contribution: 0, verdict: 'absent', missingCount: 1, contradictionCount: 0 },
      { id: 'operating-profile', label: 'Operating profile', contribution: 0, verdict: 'absent', missingCount: 0, contradictionCount: 0 },
      { id: 'concentration-quality-risk', label: 'Concentration and quality risk', contribution: 0, verdict: 'absent', missingCount: 0, contradictionCount: 0 },
      { id: 'strategic-geographic-fit', label: 'Strategic and geographic fit', contribution: 9, verdict: 'supported', missingCount: 0, contradictionCount: 0 },
    ],
    topReasons: ['Annual profit is inside the target $300k-$750k range.'],
    recommendation: 'High fit.',
    operatorPriority: 'normal',
    operatorNote: '',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-08-16T12:00:00.000Z',
    scoreFingerprint: 'fingerprint-a',
    rulesVersion: 'deal-hunter-fit-v2',
    ...overrides,
  };
}

function queueResponse(rows, overrides = {}) {
  return {
    success: true, ok: true, view: 'needs-review', sort: 'fit-score', direction: 'desc',
    rows, total: rows.length, page: 1, pageSize: 25, totalPages: 1, ...overrides,
  };
}

function detailResponse(overrides = {}) {
  return {
    success: true,
    ok: true,
    opportunity: triageRow(),
    dimensions: [
      {
        id: 'financial-fit',
        label: 'Financial fit',
        contribution: 37,
        verdict: 'supported',
        rules: [{ ruleId: 'profit.in-band', label: 'Annual profit inside the target band', delta: 18 }],
        missing: [],
        evidence: [{
          ruleId: 'profit.in-band',
          ruleLabel: 'Annual profit inside the target band',
          evidenceClass: 'observed',
          field: 'annualProfit',
          value: '450000',
          terms: [],
          sourceId: 'deal-os-export',
          sourceName: 'Deal OS',
          sourceRecordId: 'row-9',
          listingUrl: 'https://listings.example.invalid/opp-1',
          observedAt: '2026-08-15',
        }],
      },
      {
        id: 'transferability',
        label: 'Transferability',
        contribution: 0,
        verdict: 'absent',
        rules: [{ ruleId: 'management.absent', label: 'Management in place is not shown', delta: 0 }],
        missing: [{ ruleId: 'management.absent', label: 'Management in place is not shown', field: 'fullText' }],
        evidence: [{
          ruleId: 'management.absent',
          ruleLabel: 'Management in place is not shown',
          evidenceClass: 'missing',
          field: 'fullText',
          value: null,
          terms: [],
          sourceId: 'deal-os-export',
          sourceName: 'Deal OS',
          sourceRecordId: 'row-9',
          listingUrl: '',
          observedAt: '',
        }],
      },
    ],
    unattributedEvidence: [],
    appliedCaps: [],
    gates: [],
    confidenceReasons: [],
    missingEvidence: ['annualRevenue'],
    summary: { recommendation: 'High fit.' },
    ...overrides,
  };
}

function mockFetch(handlers) {
  return vi.fn(async (url, options = {}) => {
    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) {
        const body = await handler(url, options);
        return { ok: true, json: async () => body };
      }
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Deal Hunter triage queue', () => {
  test('shows fit and confidence as separate readings with missing-evidence context', async () => {
    vi.stubGlobal('fetch', mockFetch([['/api/admin/deal-hunter/triage', () => queueResponse([triageRow()])]]));
    render(<DealHunterTriage />);

    expect(await screen.findByText('Commercial Fire Safety Inspection Co')).toBeVisible();
    expect(screen.getByText('81')).toBeVisible();
    expect(screen.getByText('fit')).toBeVisible();
    // Confidence is its own reading, never folded into the number above.
    expect(screen.getByText('high confidence')).toBeVisible();
    expect(screen.getByText('Completeness 92/100')).toBeVisible();
    expect(screen.getByText('1 missing field')).toBeVisible();
    expect(screen.getByText('Not yet reviewed')).toBeVisible();
  });

  test('flags an opportunity that changed after the operator reviewed it', async () => {
    vi.stubGlobal('fetch', mockFetch([
      ['/api/admin/deal-hunter/triage', () => queueResponse([triageRow({ reviewed: true, changedSinceReview: true, reviewedBy: 'owner' })])],
    ]));
    render(<DealHunterTriage />);

    expect(await screen.findByText('Changed since review')).toBeVisible();
    expect(screen.queryByText('Not yet reviewed')).not.toBeInTheDocument();
  });

  test('explains a score from evidence without exposing raw JSON', async () => {
    vi.stubGlobal('fetch', mockFetch([
      ['/api/admin/deal-hunter/triage/opp-1', () => detailResponse()],
      ['/api/admin/deal-hunter/triage', () => queueResponse([triageRow()])],
    ]));
    render(<DealHunterTriage />);

    fireEvent.click(await screen.findByRole('button', { name: /Why this score/ }));

    // Each dimension collapses by default so the drawer stays scannable; the
    // detail is one click away rather than buried in raw JSON.
    const financialSummary = await screen.findByText(/Financial fit/);
    expect(financialSummary).toBeVisible();
    const financial = financialSummary.closest('details');
    financial.open = true;
    expect(within(financial).getByText(/Annual profit inside the target band/)).toBeInTheDocument();
    expect(within(financial).getByText('observed')).toBeInTheDocument();
    expect(within(financial).getByText('annualProfit')).toBeInTheDocument();
    expect(within(financial).getByText(/Deal OS/)).toBeInTheDocument();
    expect(screen.getByText(/Research needed:/)).toBeVisible();

    // A dimension with no evidence reads as unknown, not as a negative finding.
    const transferability = screen.getByText(/Transferability/).closest('details');
    transferability.open = true;
    expect(within(transferability).getByText(/absent/)).toBeInTheDocument();
    expect(within(transferability).getByText(/Missing:/)).toBeInTheDocument();
    expect(within(transferability).getByText('missing')).toBeInTheDocument();
  });

  test('surfaces gate reasons for a disqualified listing', async () => {
    vi.stubGlobal('fetch', mockFetch([
      ['/api/admin/deal-hunter/triage/opp-1', () => detailResponse({
        gates: [{ ruleId: 'gate.franchise', reason: 'Franchise listing, which is outside the current acquisition strategy.' }],
      })],
      ['/api/admin/deal-hunter/triage', () => queueResponse([triageRow({ shouldRemove: true, highFit: false })])],
    ]));
    render(<DealHunterTriage />);

    fireEvent.click(await screen.findByRole('button', { name: /Why this score/ }));
    expect(await screen.findByText('Disqualified')).toBeVisible();
    expect(screen.getByText(/Franchise listing/)).toBeVisible();
  });

  test('records operator priority without sending a numeric score override', async () => {
    const decisions = [];
    vi.stubGlobal('fetch', mockFetch([
      ['/decision', (url, options) => {
        decisions.push(JSON.parse(options.body));
        return { success: true, ok: true, opportunity: triageRow({ operatorPriority: 'urgent' }) };
      }],
      ['/api/admin/deal-hunter/triage', () => queueResponse([triageRow()])],
    ]));
    render(<DealHunterTriage />);

    const select = await screen.findByLabelText(/Operator priority for/);
    fireEvent.change(select, { target: { value: 'urgent' } });

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toEqual({ priority: 'urgent' });
    expect(Object.keys(decisions[0])).not.toContain('scoreOverride');
    expect(Object.keys(decisions[0])).not.toContain('fitScore');
  });

  test('marking reviewed posts the acknowledgement and reloads the queue', async () => {
    const decisions = [];
    let queueLoads = 0;
    vi.stubGlobal('fetch', mockFetch([
      ['/decision', (url, options) => {
        decisions.push(JSON.parse(options.body));
        return { success: true, ok: true, opportunity: triageRow({ reviewed: true }) };
      }],
      ['/api/admin/deal-hunter/triage', () => { queueLoads += 1; return queueResponse([triageRow()]); }],
    ]));
    render(<DealHunterTriage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(decisions).toEqual([{ markReviewed: true }]));
    await waitFor(() => expect(queueLoads).toBeGreaterThan(1));
  });

  test('read-only users can inspect scores but get no decision controls', async () => {
    vi.stubGlobal('fetch', mockFetch([['/api/admin/deal-hunter/triage', () => queueResponse([triageRow()])]]));
    render(<DealHunterTriage readOnly />);

    expect(await screen.findByText('Commercial Fire Safety Inspection Co')).toBeVisible();
    expect(screen.getByRole('button', { name: /Why this score/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Operator priority for/)).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only users can review scores/)).toBeVisible();
  });

  test('switching views requests the matching queue', async () => {
    const requested = [];
    vi.stubGlobal('fetch', mockFetch([
      ['/api/admin/deal-hunter/triage', (url) => { requested.push(url); return queueResponse([]); }],
    ]));
    render(<DealHunterTriage />);

    await waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]).toContain('view=needs-review');

    fireEvent.click(screen.getByRole('tab', { name: 'Low confidence' }));
    await waitFor(() => expect(requested.some((url) => url.includes('view=low-confidence'))).toBe(true));
  });

  test('an empty view explains how to populate it instead of showing a blank panel', async () => {
    vi.stubGlobal('fetch', mockFetch([['/api/admin/deal-hunter/triage', () => queueResponse([])]]));
    render(<DealHunterTriage />);
    expect(await screen.findByText(/Import a Deal OS export or run a full backfill/)).toBeVisible();
  });

  test('a failed queue load surfaces the error rather than an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ success: false, error: 'Opportunity scoring storage is unavailable.' }) })));
    render(<DealHunterTriage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Opportunity scoring storage is unavailable.');
  });
});
