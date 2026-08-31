// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import OpportunityDrawer from '../src/components/admin/OpportunityDrawer.jsx';

function detailFixture(overrides = {}) {
  return {
    opportunity: {
      opportunityId: 'opp-1',
      name: 'Evergreen Fire Protection',
      fitScore: 86,
      scoreStatus: 'high-fit',
      confidence: 'high',
      completenessScore: 88,
      geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
      industry: 'Fire protection services',
      financials: { annualProfit: 425000, annualRevenue: 2200000, askingPrice: null, profitMultiple: 4.24 },
      topStrength: 'Recurring inspections support durable demand.',
      topConcern: 'Customer concentration needs validation.',
      workflow: { crmStatus: 'active', cimStatus: 'not-requested' },
      observationFreshness: '2026-08-29T17:00:00.000Z',
      operatorPriority: 'high',
      operatorNote: 'Confirm inspection contract retention.',
      reviewed: true,
      reviewedAt: '2026-08-29T18:00:00.000Z',
      reviewedBy: 'admin@example.com',
      changedSinceReview: false,
    },
    effectiveFacts: {
      broker_name: { value: 'Alex Broker', provenance: 'operator', verified: true, actor: 'admin@example.com', note: 'Confirmed by phone.' },
      seller_name: { value: 'Jamie Seller', provenance: 'crm', verified: false, actor: null, note: null },
      management_structure: { value: 'General manager runs daily operations', provenance: 'structured-source', verified: false, actor: null, note: null },
      reason_for_sale: { value: 'Retirement', provenance: 'structured-source', verified: false, actor: null, note: null },
    },
    operatorFacts: [{ id: 'fact-1', field: 'broker_name', value: 'Alex Broker', verified: true, actor: 'admin@example.com', note: 'Confirmed by phone.', updatedAt: '2026-08-29T18:00:00.000Z' }],
    sourceObservations: [
      {
        sourceId: 'sheet', sourceName: 'Deal Hunter Google Sheet', sourceRecordId: 'row-9', observedAt: '2026-08-28T17:00:00.000Z',
        values: { annual_profit: '425000', listing_id: 'sheet-9', listing_url: 'https://broker.example/evergreen' },
        conflicts: [{ field: 'annual_profit', observations: [
          { sourceName: 'Deal Hunter Google Sheet', value: '425000' },
          { sourceName: 'Deal OS', value: '390000' },
        ] }],
      },
      {
        sourceId: 'deal-os', sourceName: 'Deal OS', sourceRecordId: 'listing-42', observedAt: '2026-08-29T17:00:00.000Z',
        values: { annual_profit: '390000', listing_id: 'listing-42' }, conflicts: [],
      },
    ],
    missingCriticalFields: ['broker_email', 'asking_price'],
    listingUrls: ['https://broker.example/evergreen', 'javascript:alert(1)', 'https://user:secret@private.example/listing'],
    score: {
      fitScore: 86,
      scoreStatus: 'high-fit',
      confidence: 'high',
      completenessScore: 88,
      dimensions: [{
        id: 'financial-fit', label: 'Financial fit', contribution: 34,
        evidence: [{ ruleId: 'profit.in-band', ruleLabel: 'Profit inside target band', evidenceClass: 'observed', field: 'annualProfit', value: '425000', sourceName: 'Deal Hunter Google Sheet' }],
      }],
      gates: [], appliedCaps: [], confidenceReasons: ['Core financial fields are present.'], missingEvidence: ['customerConcentration'],
      summary: { strengths: ['Profit is in range.'], concerns: ['Customer concentration is unknown.'] },
    },
    cimSummary: {
      requests: [{ id: 'cim-1', status: 'draft', updatedAt: '2026-08-28T18:00:00.000Z' }],
      communications: [{ id: 'communication-1', direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T18:00:00.000Z' }],
    },
    crmSummary: {
      submission: { id: 'crm-1', status: 'review', company: 'Evergreen Fire Protection', sellerName: 'Jamie Seller', sellerEmail: 'jamie@example.com', brokerName: 'Alex Broker', brokerEmail: 'alex@example.com', updatedAt: '2026-08-29T18:00:00.000Z' },
      communications: [{ id: 'communication-1', direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T18:00:00.000Z' }],
      factObservations: [{ field: 'seller_name', value: 'Jamie Seller', provenance: 'crm' }],
      conflicts: [],
    },
    history: {
      activities: [{ id: 'activity-1', eventType: 'deal-hunter-triage-decision', summary: 'Priority high; marked reviewed', createdAt: '2026-08-29T18:00:00.000Z', actor: 'admin@example.com' }],
      dispositions: [],
      operatorFacts: [{ id: 'fact-1', field: 'broker_name', value: 'Alex Broker', verified: true, actor: 'admin@example.com', note: 'Confirmed by phone.', updatedAt: '2026-08-29T18:00:00.000Z' }],
      operatorState: { priority: 'high', note: 'Confirm inspection contract retention.', reviewed: true, reviewedAt: '2026-08-29T18:00:00.000Z', reviewedBy: 'admin@example.com' },
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Opportunity drawer', () => {
  test('consolidates the record into the exact acquisition sections with safe provenance-aware content', () => {
    render(<OpportunityDrawer detail={detailFixture()} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
    for (const section of ['Overview', 'Business & Financials', 'Broker & Seller', 'Score & Evidence', 'Sources', 'CRM/CIM', 'Notes & History']) {
      expect(within(dialog).getByRole('heading', { name: section })).toBeVisible();
    }
    expect(within(dialog).getByText('Alex Broker')).toBeVisible();
    expect(within(dialog).getByText(/Operator verified/)).toBeVisible();
    expect(within(dialog).getAllByText('CRM').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('Structured source')).toHaveLength(2);
    expect(within(dialog).getByText(/Deal Hunter Google Sheet reported 425000/)).toBeVisible();
    expect(within(dialog).getByText(/Deal OS reported 390000/)).toBeVisible();
    expect(within(dialog).getByText(/Profit inside target band/)).toBeVisible();
    expect(within(dialog).getByText(/Priority high; marked reviewed/)).toBeVisible();
    expect(within(dialog).getByText(/draft/i)).toBeVisible();

    const missing = within(dialog).getByRole('region', { name: 'Missing Information' });
    expect(within(missing).getByText('Broker email')).toBeVisible();
    expect(within(missing).getByText('Asking price')).toBeVisible();
    expect(within(missing).getAllByText('Not provided')).toHaveLength(2);
    expect(within(dialog).queryByText('Years established')).not.toBeInTheDocument();

    const links = within(dialog).getAllByRole('link', { name: /View Original Listing/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://broker.example/evergreen');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(dialog).queryByRole('button', { name: /send|stage 2|refresh score|backfill|import/i })).not.toBeInTheDocument();
  });

  test('adds or edits one verified operator fact without exposing machine-owned fields', () => {
    const onSaveFact = vi.fn();
    render(<OpportunityDrawer detail={detailFixture()} onClose={vi.fn()} onSaveFact={onSaveFact} />);

    fireEvent.change(screen.getByLabelText('Verified fact field'), { target: { value: 'broker_name' } });
    fireEvent.change(screen.getByLabelText('Verified fact value'), { target: { value: 'Alexandra Broker' } });
    fireEvent.change(screen.getByLabelText('Verification note'), { target: { value: 'Confirmed on today’s call.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save verified fact' }));

    expect(onSaveFact).toHaveBeenCalledWith({ field: 'broker_name', value: 'Alexandra Broker', note: 'Confirmed on today’s call.', verified: true });
    expect(screen.queryByRole('option', { name: /fit score|confidence|canonical identity/i })).not.toBeInTheDocument();
  });

  test('keeps primary decisions accessible in the full-height responsive detail', () => {
    const onAction = vi.fn();
    render(<OpportunityDrawer detail={detailFixture()} onAction={onAction} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pursue Evergreen Fire Protection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch Evergreen Fire Protection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pass Evergreen Fire Protection' }));

    expect(onAction.mock.calls.map(([action]) => action)).toEqual(['pursue', 'watch', 'pass']);
    expect(screen.getByRole('dialog')).toHaveClass('h-full');
  });
});
