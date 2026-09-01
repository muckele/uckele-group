// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import BrokerMaterialsCard from '../src/components/admin/BrokerMaterialsCard.jsx';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function recipient(overrides = {}) {
  return {
    recipientContactRef: 'contact-ref-1',
    email: 'jane@example.test',
    displayName: 'Jane Broker',
    provenance: 'structured_source',
    provenanceLabel: 'Deal Hunter Sheet · row-42',
    provenances: [{ provenance: 'structured_source', label: 'Deal Hunter Sheet · row-42' }],
    primary: true,
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    existingRequest: null,
    pursued: true,
    preparationBlockers: [],
    sendBlockers: [],
    warnings: [],
    recipientOptions: [recipient()],
    ...overrides,
  };
}

function preparation(overrides = {}) {
  return {
    success: true,
    previewOnly: false,
    preparationToken: 'signed.preparation',
    proposalDigest: 'a'.repeat(64),
    preparedAt: '2026-09-01T17:00:00.000Z',
    expiresAt: '2099-09-01T17:15:00.000Z',
    review: {
      opportunity: {
        canonicalOpportunityId: 'opp-1', displayName: 'Evergreen Fire Protection', sourceLabel: 'Deal Hunter Sheet',
        listingUrl: 'https://broker.example/evergreen', pursued: true, current: true, score: 68,
        automatedScoreThreshold: 75, annualProfit: null,
      },
      recipient: { contactRef: 'contact-ref-1', displayName: 'Jane Broker', email: 'jane@example.test', provenance: 'structured_source' },
      sender: { displayName: 'Mathew Uckele', email: 'buyer@example.test', replyTo: 'reply@example.test' },
      message: {
        requestType: 'cim_request', channel: 'email', greeting: 'Hi Jane,',
        subject: 'CIM / NDA request for Evergreen Fire Protection',
        body: 'Hi Jane,\n\nPlease share the CIM and NDA for Evergreen Fire Protection.\n\nThank you,\nMathew',
        templateVersion: 'deal-hunter-cim-manual-stage1-v1',
      },
    },
    recipientOptions: [recipient(), recipient({
      recipientContactRef: 'contact-ref-2', email: 'alex@example.test', displayName: 'Alex Broker',
      provenance: 'crm', provenanceLabel: 'Current CRM broker', provenances: [{ provenance: 'crm', label: 'Current CRM broker' }], primary: false,
    })],
    warnings: [{ code: 'below_automated_cim_score_threshold', message: 'Manual review is allowed; automated eligibility remains stricter.' }],
    sendBlockers: [],
    ...overrides,
  };
}

function existingRequest(overrides = {}) {
  return {
    id: 'request-1', status: 'sent', requestState: 'provider_accepted', deliveryState: 'accepted', followUpState: 'not-scheduled',
    recipient: { email: 'jane@example.test', displayName: 'Jane Broker' }, subject: 'Approved subject',
    createdAt: '2026-09-01T17:00:00.000Z', updatedAt: '2026-09-01T17:01:00.000Z',
    requestedAt: '2026-09-01T17:00:00.000Z', providerAcceptedAt: '2026-09-01T17:01:00.000Z',
    deliveredAt: '', respondedAt: '', errorSummary: '', canRetry: false, canCorrectRecipient: false,
    retryRoute: '', correctionRoute: '',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Broker Materials card', () => {
  test.each([
    ['Ready', projection(), 'Prepare a reviewed request using current broker details.', 'Request Broker Materials'],
    ['Blocked', projection({ preparationBlockers: [{ code: 'recipient_authority_unavailable', message: 'No usable broker email is available.' }], recipientOptions: [] }), 'No usable broker email is available.', 'Add / Verify Broker Email'],
    ['Sending / Pending', projection({ existingRequest: existingRequest({ status: 'pending', requestState: 'pending', deliveryState: 'pending', providerAcceptedAt: '' }) }), 'A broker materials request is pending.', 'View Request Status'],
    ['Sent', projection({ existingRequest: existingRequest() }), 'Sent to jane@example.test', 'View Sent Request'],
    ['Ambiguous', projection({ existingRequest: existingRequest({ status: 'ambiguous', requestState: 'provider_ambiguous', deliveryState: 'ambiguous' }) }), 'Delivery could not be confirmed. Do not send another request.', 'Review Ambiguous Result'],
    ['Delivery Issue', projection({ existingRequest: existingRequest({ status: 'delivery_issue', deliveryState: 'bounced', errorSummary: 'Delivery failed.', canCorrectRecipient: true, correctionRoute: '/correct' }) }), 'Delivery failed.', 'Correct Recipient'],
    ['Replied', projection({ existingRequest: existingRequest({ status: 'responded', requestState: 'responded', deliveryState: 'responded', respondedAt: '2026-09-01T18:00:00.000Z' }) }), 'The broker replied to this request.', 'View Broker Reply'],
  ])('renders the collapsed %s presentation from authoritative fields only', (badge, brokerMaterials, sentence, action) => {
    render(<BrokerMaterialsCard brokerMaterials={brokerMaterials} onAddBrokerEmail={vi.fn()} onPrepare={vi.fn()} onViewRequest={vi.fn()} />);
    const card = screen.getByRole('region', { name: 'Broker Materials' });
    expect(within(card).getByText(badge)).toBeVisible();
    expect(within(card).getByText(sentence, { exact: false })).toBeVisible();
    expect(within(card).queryByRole('button', { name: action }) || within(card).getByRole('link', { name: action })).toBeVisible();
    expect(within(card).queryByText(/CIM history|CRM communications|CIM communications/i)).not.toBeInTheDocument();
  });

  test('renders one continuous Prepared review in the required order with copyable exact subject and body', () => {
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={preparation()} />);
    const card = screen.getByRole('region', { name: 'Broker Materials' });
    const labels = ['Opportunity context', 'Manual Stage 1 warnings', 'Recipient and provenance', 'Sender', 'Greeting', 'Subject', 'Complete message body', 'Current send blockers', 'Expiration', 'Final approval'];
    const nodes = labels.map((name) => within(card).getByRole('heading', { name }));
    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index - 1].compareDocumentPosition(nodes[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(card).getByLabelText('Subject')).toHaveAttribute('readonly');
    expect(within(card).getByLabelText('Complete message body')).toHaveAttribute('readonly');
    expect(within(card).getByLabelText('Subject')).not.toBeDisabled();
    expect(within(card).getByLabelText('Complete message body')).toHaveValue(preparation().review.message.body);
    expect(within(card).getAllByText('Prepared')).toHaveLength(1);
  });

  test('keeps warnings non-blocking while send blockers and global pause disable approval without hiding review', () => {
    const paused = preparation({ sendBlockers: [{ code: 'cim_outreach_paused', message: 'CIM sending is globally paused.' }] });
    const { rerender } = render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={preparation()} />);
    expect(screen.getByText(/automated eligibility remains stricter/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve & Send' })).toBeEnabled();
    rerender(<BrokerMaterialsCard brokerMaterials={projection({ sendBlockers: paused.sendBlockers })} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={paused} />);
    expect(screen.getByLabelText('Complete message body')).toBeVisible();
    expect(screen.getByText('CIM sending is globally paused.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve & Send' })).toBeDisabled();
  });

  test('invalidates approval before recipient regeneration, posts only contactRef, and keeps selector focus', async () => {
    const update = deferred();
    const onPrepare = vi.fn(() => update.promise);
    const onInvalidatePreparation = vi.fn();
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onInvalidatePreparation={onInvalidatePreparation} onPrepare={onPrepare} preparation={preparation()} />);
    const selector = screen.getByLabelText('Authoritative broker recipient');
    selector.focus();
    fireEvent.change(selector, { target: { value: 'contact-ref-2' } });
    expect(onInvalidatePreparation).toHaveBeenCalledTimes(1);
    expect(onPrepare).toHaveBeenCalledWith({ recipientContactRef: 'contact-ref-2' });
    expect(screen.queryByRole('button', { name: 'Approve & Send' })).not.toBeInTheDocument();
    expect(selector).toHaveFocus();
    await act(async () => update.resolve(true));
    expect(await screen.findByText('Updated', { exact: true })).toBeVisible();
  });

  test('marks greeting edits stale without posting per keystroke and Update Preview regenerates the whole proposal', async () => {
    const onPrepare = vi.fn(async () => true);
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onPrepare={onPrepare} preparation={preparation()} />);
    const greeting = screen.getByLabelText('Greeting');
    fireEvent.change(greeting, { target: { value: 'Hello Jane,' } });
    expect(onPrepare).not.toHaveBeenCalled();
    expect(screen.getByText('Preview needs updating before approval.')).toBeVisible();
    expect(screen.getByLabelText('Complete message body')).toHaveValue(preparation().review.message.body);
    expect(screen.getByRole('button', { name: 'Approve & Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update Preview' }));
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith({ recipientContactRef: 'contact-ref-1', greeting: 'Hello Jane,' }));
  });

  test('Enter in greeting updates preview but never approves, and non-approval card activation never sends', async () => {
    const onPrepare = vi.fn(async () => true);
    const onApprove = vi.fn(async () => true);
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={onApprove} onPrepare={onPrepare} preparation={preparation()} />);
    const greeting = screen.getByLabelText('Greeting');
    fireEvent.change(greeting, { target: { value: 'Hello Jane,' } });
    fireEvent.keyDown(greeting, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(1));
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Broker Materials' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('heading', { name: 'Broker Materials' }));
    expect(onApprove).not.toHaveBeenCalled();
  });

  test('synchronously locks the first approval activation against repeated click, Space, and Enter', async () => {
    const approval = deferred();
    const onApprove = vi.fn(() => approval.promise);
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={onApprove} onPrepare={vi.fn()} preparation={preparation()} />);
    const button = screen.getByRole('button', { name: 'Approve & Send' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: ' ', code: 'Space' });
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByText('Submitting the approved request…')).toBeVisible();
    await act(async () => approval.resolve(true));
  });

  test('consumes durable authority into authoritative lifecycle and never restores the preparation action', () => {
    const { rerender } = render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={preparation()} />);
    expect(screen.getByRole('button', { name: 'Approve & Send' })).toBeVisible();
    rerender(<BrokerMaterialsCard brokerMaterials={projection({ existingRequest: existingRequest() })} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={null} />);
    expect(screen.getByText('Sent')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve & Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Broker Materials' })).not.toBeInTheDocument();
  });

  test('retains stale reviewed copy for orientation while removing approval authority and requiring regeneration', () => {
    render(<BrokerMaterialsCard brokerMaterials={projection()} onApprove={vi.fn()} onPrepare={vi.fn()} preparation={preparation({ preparationToken: '', proposalDigest: '' })} stale />);
    expect(screen.getByText('Preparation out of date')).toBeVisible();
    expect(screen.getByLabelText('Complete message body')).toHaveValue(preparation().review.message.body);
    expect(screen.queryByRole('button', { name: 'Approve & Send' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate Request' })).toBeVisible();
  });

  test('renders viewer preview read-only with no approval, mutation, retry, or correction controls', () => {
    const onCheckStatus = vi.fn();
    render(<BrokerMaterialsCard brokerMaterials={projection()} onCheckStatus={onCheckStatus} onPrepare={vi.fn()} preparation={preparation({ previewOnly: true, preparationToken: undefined, proposalDigest: undefined })} readOnly />);
    expect(screen.getByLabelText('Greeting')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Approve & Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update Preview|Correct Recipient|Retry/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check Request Status' }));
    expect(onCheckStatus).toHaveBeenCalledTimes(1);
  });

  test('Checking exposes only a read-only GET status action after authoritative refresh failure', () => {
    const onCheckStatus = vi.fn();
    render(<BrokerMaterialsCard brokerMaterials={projection()} checking checkingFailed onApprove={vi.fn()} onCheckStatus={onCheckStatus} preparation={preparation()} />);
    expect(screen.getByText('Checking')).toBeVisible();
    expect(screen.getByText(/Unable to confirm request status.*Do not resend/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve & Send' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    expect(onCheckStatus).toHaveBeenCalledTimes(1);
  });

  test('provides a labeled busy region, disclosure semantics, one polite live region, alerts, and provenance description', () => {
    const { rerender } = render(<BrokerMaterialsCard brokerMaterials={projection()} onPrepare={vi.fn()} preparing />);
    const card = screen.getByRole('region', { name: 'Broker Materials' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByRole('button', { name: /Broker Materials review/i })).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByRole('button', { name: /Broker Materials review/i })).toHaveAttribute('aria-controls');
    expect(within(card).getAllByRole('status')).toHaveLength(1);
    rerender(<BrokerMaterialsCard brokerMaterials={projection()} error="Preparation failed safely." onPrepare={vi.fn()} preparation={preparation()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Preparation failed safely.');
    expect(screen.getByLabelText('Authoritative broker recipient')).toHaveAttribute('aria-describedby');
  });
});
