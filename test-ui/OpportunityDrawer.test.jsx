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
      missingEvidenceCount: 2,
      contradictionCount: 1,
      shouldRemove: false,
      highFit: true,
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
      dismissed: false,
      dismissedReason: '',
      scoredAt: '2026-08-29T16:00:00.000Z',
      rulesVersion: 'deal-hunter-fit-v2',
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
        evidence: [{
          ruleId: 'profit.in-band', ruleLabel: 'Profit inside target band', evidenceClass: 'observed',
          field: 'annualProfit', value: '425000', observedValue: '$425,000 reported', terms: ['recurring', 'inspection'],
          sourceId: 'sheet', sourceName: 'Deal Hunter Google Sheet', sourceRecordId: 'row-9',
          listingUrl: 'https://broker.example/evergreen', observedAt: '2026-08-28T17:00:00.000Z',
        }],
      }],
      unattributedEvidence: [{
        ruleId: 'market.fragmented', ruleLabel: 'Fragmented market signal', evidenceClass: 'inferred',
        field: 'industry', value: 'fire protection', observedValue: 'regional operators', terms: ['fragmented'],
        sourceId: 'deal-os', sourceName: 'Deal OS', sourceRecordId: 'listing-42', observedAt: '2026-08-29T17:00:00.000Z',
      }],
      gates: [{ ruleId: 'owner.transition', reason: 'Confirm transition support', value: 1 }],
      appliedCaps: [{ ruleId: 'customer.concentration', reason: 'Concentration is unverified', cap: 90 }],
      confidenceReasons: ['Core financial fields are present.'], missingEvidence: ['customerConcentration'],
      summary: { strengths: ['Profit is in range.'], concerns: ['Customer concentration is unknown.'] },
    },
    brokerMaterials: {
      existingRequest: null,
      pursued: true,
      preparationBlockers: [],
      sendBlockers: [],
      warnings: [],
      recipientOptions: [{ recipientContactRef: 'contact-ref-1', email: 'alex@example.com', displayName: 'Alex Broker', provenance: 'structured_source', provenanceLabel: 'Deal Hunter Google Sheet · row-9', primary: true }],
    },
    cimSummary: {
      requests: [{ id: 'cim-1', status: 'draft', updatedAt: '2026-08-28T18:00:00.000Z' }],
      communications: [{ id: 'communication-1', direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T18:00:00.000Z', cimRequestId: 'cim-1' }],
    },
    crmSummary: {
      submission: { id: 'crm-1', status: 'review', company: 'Evergreen Fire Protection', sellerName: 'Jamie Seller', sellerEmail: 'jamie@example.com', brokerName: 'Alex Broker', brokerEmail: 'alex@example.com', updatedAt: '2026-08-29T18:00:00.000Z' },
      communications: [
        { id: 'communication-1', direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T18:00:00.000Z', cimRequestId: 'cim-1' },
        { id: 'communication-2', direction: 'outbound', channel: 'phone', kind: 'seller-call', occurredAt: '2026-08-28T18:00:00.000Z', cimRequestId: '' },
      ],
      factObservations: [{ field: 'seller_name', value: 'Jamie Seller from CRM', provenance: 'crm' }],
      conflicts: [{ field: 'broker_name', winningProvenance: 'operator', crmValue: 'Alexander Broker' }],
    },
    history: {
      activities: [{ id: 'activity-1', eventType: 'deal-hunter-triage-decision', summary: 'Priority high; marked reviewed', createdAt: '2026-08-29T18:00:00.000Z', actor: 'admin@example.com' }],
      dispositions: [{ id: 'disposition-1', disposition: 'dismissed', reason: 'valuation', note: 'Previously passed.', dismissedAt: '2026-08-27T18:00:00.000Z', dismissedBy: 'reviewer@example.com' }],
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
    expect(within(dialog).getByText('Financial fit')).toBeVisible();
    expect(within(dialog).getByText('+34')).toBeVisible();
    expect(within(dialog).getByText(/Scored Aug 29, 2026/)).toBeVisible();
    expect(within(dialog).getByText(/deal-hunter-fit-v2/)).toBeVisible();
    expect(within(dialog).getByText(/Class: Observed · Field: Annual Profit · Value: 425000/)).toBeVisible();
    expect(within(dialog).getByText('Source: Deal Hunter Google Sheet')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: /Open evidence listing/ })).toHaveAttribute('href', 'https://broker.example/evergreen');
    expect(within(dialog).getByText(/Gates: Confirm transition support/)).toBeVisible();
    expect(within(dialog).getByText(/Caps: Concentration is unverified/)).toBeVisible();
    expect(within(dialog).getByText(/Confidence: Core financial fields are present/)).toBeVisible();
    expect(within(dialog).getByText('88%')).toBeVisible();
    expect(within(dialog).getByText('Reviewed · Current')).toBeVisible();
    expect(within(dialog).getByText(/CRM: Active · CIM: Not Requested/)).toBeVisible();
    expect(within(dialog).getAllByText(/Observed Aug 29, 2026/)).toHaveLength(3);
    expect(within(dialog).getByText(/2 missing evidence · 1 contradiction/)).toBeVisible();
    expect(within(dialog).getByText('Profit is in range.')).toBeVisible();
    expect(within(dialog).getByText('Customer concentration is unknown.')).toBeVisible();
    expect(within(dialog).getByText(/Missing evidence: Customer Concentration/)).toBeVisible();
    expect(within(dialog).getByText(/Fragmented market signal/)).toBeVisible();
    expect(within(dialog).getByText(/Observed value: regional operators/)).toBeVisible();
    expect(within(dialog).getByText(/Terms: fragmented/)).toBeVisible();
    expect(within(dialog).getByText(/Source record: listing-42/)).toBeVisible();
    expect(within(dialog).getByText('sheet-9')).toBeVisible();
    expect(within(dialog).getByText('General manager runs daily operations')).toBeVisible();
    expect(within(dialog).getByText('Retirement')).toBeVisible();
    expect(within(dialog).getByText(/Conflict: Annual Profit/)).toBeVisible();
    expect(within(dialog).getByText(/CRM fact · Seller Name · Jamie Seller from CRM/)).toBeVisible();
    expect(within(dialog).getByText(/CRM conflict · Broker Name · Alexander Broker · Operator wins/)).toBeVisible();
    expect(within(dialog).getAllByText(/Inbound · Email · Broker Reply · Aug 29, 2026/)).toHaveLength(2);
    expect(within(dialog).getByText(/Outbound · Phone · Seller Call · Aug 28, 2026/)).toBeVisible();
    expect(within(dialog).getByText(/Review state · Reviewed by admin@example.com on Aug 29, 2026/)).toBeVisible();
    expect(within(dialog).getByText(/Note: Confirm inspection contract retention/)).toBeVisible();
    expect(within(dialog).getByText(/Operator fact · Broker Name · Alex Broker · Verified/)).toBeVisible();
    expect(within(dialog).getByText(/admin@example.com · Aug 29, 2026 · Confirmed by phone/)).toBeVisible();
    expect(within(dialog).getByText(/Event: Deal Hunter Triage Decision/)).toBeVisible();
    expect(within(dialog).getByText(/Passed: Valuation · Previously passed. · reviewer@example.com · Aug 27, 2026/)).toBeVisible();
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

  test('keeps all acquisition section headings while omitting empty low-value score and source rows', () => {
    const sparse = detailFixture();
    sparse.opportunity = {
      ...sparse.opportunity,
      completenessScore: 0,
      missingEvidenceCount: 0,
      contradictionCount: 0,
      topStrength: '',
      topConcern: '',
    };
    sparse.score = {
      ...sparse.score,
      summary: { strengths: [], concerns: [] },
      dimensions: [],
      unattributedEvidence: [],
      gates: [],
      appliedCaps: [],
      confidenceReasons: [],
      missingEvidence: [],
    };
    sparse.sourceObservations = [{
      sourceId: 'sparse',
      sourceName: 'Sparse Source',
      sourceRecordId: 'sparse-1',
      observedAt: '',
      values: { empty_value: '', null_value: null, missing_value: undefined, zero_count: 0, false_flag: false },
      conflicts: [],
    }];

    render(<OpportunityDrawer detail={sparse} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
    for (const section of ['Overview', 'Business & Financials', 'Broker & Seller', 'Score & Evidence', 'Sources', 'CRM/CIM', 'Notes & History']) {
      expect(within(dialog).getByRole('heading', { name: section })).toBeVisible();
    }
    expect(within(dialog).queryByRole('heading', { name: 'Strengths' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Concerns' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Empty Value')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Null Value')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Missing Value')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Zero Count')).toBeVisible();
    expect(within(dialog).getByText('False Flag')).toBeVisible();
    const sparseSource = within(dialog).getByRole('heading', { name: 'Sparse Source' }).parentElement.parentElement;
    expect(within(sparseSource).getByText('0')).toBeVisible();
    expect(within(sparseSource).getByText('false')).toBeVisible();
    expect(within(dialog).getByText('0%')).toBeVisible();
    expect(within(dialog).getByText(/0 missing evidence · 0 contradictions/)).toBeVisible();
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

    expect(onAction.mock.calls.map(([action]) => action)).toEqual(['pursue', 'watch']);
    expect(screen.getByRole('form', { name: 'Pass Evergreen Fire Protection' })).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveClass('h-full');
  });

  test('places one Broker Materials card directly below decisions before strengths and keeps durable history in CRM/CIM', () => {
    const onBrokerMaterialsPrepare = vi.fn();
    render(<OpportunityDrawer detail={detailFixture()} onAction={vi.fn()} onBrokerMaterialsPrepare={onBrokerMaterialsPrepare} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Evergreen Fire Protection' });
    const pursue = within(dialog).getByRole('button', { name: 'Pursue Evergreen Fire Protection' });
    const card = within(dialog).getByRole('region', { name: 'Broker Materials' });
    const strength = within(dialog).getByText('Recurring inspections support durable demand.');
    expect(pursue.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(strength) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Request Broker Materials' }));
    expect(onBrokerMaterialsPrepare).toHaveBeenCalledWith({});
    expect(within(card).queryByText(/CIM history|CRM communications|CIM communications/i)).not.toBeInTheDocument();
    const crmCim = within(dialog).getByRole('heading', { name: 'CRM/CIM' }).parentElement;
    expect(within(crmCim).getByText('CIM history')).toBeVisible();
    expect(within(crmCim).getByText('CRM communications')).toBeVisible();
    expect(within(crmCim).getByText('CIM communications')).toBeVisible();
  });
});
