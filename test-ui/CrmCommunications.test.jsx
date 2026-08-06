// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CrmCommunications, { communicationFieldLimits } from '../src/components/admin/CrmCommunications.jsx';

afterEach(cleanup);

const communications = [
  {
    id: 'newer-outbound',
    direction: 'outbound',
    channel: 'email',
    from_address: 'mathew@example.com',
    to_addresses: ['broker@example.com'],
    subject: 'CIM follow-up',
    body_text: 'Following up on the CIM request.',
    occurred_at: '2026-08-06T18:00:00.000Z',
    request_state: 'provider-accepted',
    delivery_state: 'awaiting-delivery',
    cim_request_id: 'cim-1',
    metadata: { followUpNumber: 1 },
  },
  {
    id: 'older-inbound',
    direction: 'inbound',
    channel: 'email',
    from_address: 'broker@example.com',
    to_addresses: ['cim-cim-1@inbound.example.com'],
    subject: 'Re: CIM request',
    body_text: 'Attached is the overview.',
    occurred_at: '2026-08-06T17:00:00.000Z',
    request_state: 'responded',
    delivery_state: 'delivered',
    cim_request_id: 'cim-1',
    attachments: [{ filename: 'overview.pdf', content_type: 'application/pdf', size: 2048 }],
  },
];

describe('CrmCommunications', () => {
  test('shows chronological inbound and outbound correspondence with lifecycle and attachment metadata', () => {
    const { container } = render(<CrmCommunications communications={communications} />);
    const cards = [...container.querySelectorAll('[data-communication-id]')];

    expect(cards.map((card) => card.getAttribute('data-communication-id'))).toEqual(['older-inbound', 'newer-outbound']);
    expect(screen.getByText('Re: CIM request')).toBeVisible();
    expect(screen.getByText('CIM reply')).toBeVisible();
    expect(screen.getByText('CIM follow-up 1')).toBeVisible();
    expect(screen.getByText('Delivered')).toBeVisible();
    expect(screen.getByText('Awaiting delivery')).toBeVisible();
    expect(screen.getByText('overview.pdf')).toBeVisible();
    expect(screen.getByText(/application\/pdf · 2\.00 KB/)).toBeVisible();
    expect(container.querySelector('[data-layout="responsive-stack"]')).toHaveClass('space-y-4');
  });

  test('renders untrusted markup only as text and never renders retained HTML', () => {
    const unsafeText = '<img src=x onerror="window.pwned=true"><script>alert(1)</script>';
    const { container } = render(
      <CrmCommunications
        communications={[
          { id: 'plain-text', direction: 'inbound', channel: 'email', body_text: unsafeText, occurred_at: '2026-08-06T17:00:00.000Z' },
          { id: 'html-only', direction: 'inbound', channel: 'email', body_html_sanitized: '<img src=x onerror=alert(1)>', occurred_at: '2026-08-06T18:00:00.000Z' },
        ]}
      />,
    );

    expect(screen.getByText(unsafeText)).toBeVisible();
    expect(screen.getByText('Plain-text body unavailable. Retained HTML is not rendered.')).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('dangerouslySetInnerHTML');
  });

  test('retains participant labels for non-email communication channels', () => {
    render(<CrmCommunications communications={[{
      id: 'manual-phone-call',
      direction: 'inbound',
      channel: 'phone',
      subject: 'Broker call',
      body_text: 'The broker called with an update.',
      occurred_at: '2026-08-06T19:00:00.000Z',
      metadata: {
        manualParticipants: {
          from: 'Robin Broker',
          to: ['Matt Uckele'],
        },
      },
    }]} />);

    expect(screen.getByText('Robin Broker')).toBeVisible();
    expect(screen.getByText('Matt Uckele')).toBeVisible();
  });

  test('surfaces a persisted optional-workflow warning after communications reload', () => {
    const warning = 'Communication logged, but the optional CRM workflow update was not applied because the CRM record changed.';
    render(<CrmCommunications communications={[{
      id: 'manual-workflow-conflict',
      direction: 'inbound',
      channel: 'phone',
      subject: 'Broker call',
      body_text: 'The communication itself remains durable.',
      occurred_at: '2026-08-06T20:00:00.000Z',
      metadata: {
        workflowUpdate: {
          state: 'conflict',
          warning,
        },
      },
    }]} />);

    expect(screen.getByRole('status')).toHaveTextContent('Workflow note:');
    expect(screen.getByRole('status')).toHaveTextContent(warning);
    expect(screen.getByText('The communication itself remains durable.')).toBeVisible();
  });

  test('collapses long bodies behind a native disclosure control', () => {
    const longBody = 'A'.repeat(240);
    render(<CrmCommunications communications={[{ id: 'long', body_text: longBody }]} longBodyThreshold={160} />);

    const disclosure = screen.getByText('Show full message (240 characters)').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure).toHaveTextContent(longBody);
  });

  test('emits a bounded manual-log payload for administrators and hides writes from viewers', async () => {
    const onLogCommunication = vi.fn().mockResolvedValue({ id: 'manual-1' });
    const { rerender } = render(
      <CrmCommunications
        cimRequestOptions={[{ id: 'cim-1', label: 'CIM for Northstar' }]}
        onLogCommunication={onLogCommunication}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Log Communication' }));
    expect(screen.getByLabelText('From')).toHaveAttribute('maxlength', String(communicationFieldLimits.address));
    expect(screen.getByLabelText('To')).toHaveAttribute('maxlength', String(communicationFieldLimits.recipients));
    expect(screen.getByLabelText('Subject')).toHaveAttribute('maxlength', String(communicationFieldLimits.subject));
    expect(screen.getByLabelText('Body / notes')).toHaveAttribute('maxlength', String(communicationFieldLimits.bodyText));
    expect(screen.getByLabelText('Occurred at')).not.toHaveValue('');

    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'inbound' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'phone' } });
    fireEvent.change(screen.getByLabelText('Occurred at'), { target: { value: '2026-08-06T12:30' } });
    fireEvent.change(screen.getByLabelText('CIM request'), { target: { value: 'cim-1' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'Broker Name' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'Mathew Uckele, Owner Contact' } });
    fireEvent.change(screen.getByLabelText('Update CRM status (optional)'), { target: { value: 'contacted' } });
    fireEvent.change(screen.getByLabelText('Update follow-up state (optional)'), { target: { value: 'completed' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Broker call' } });
    fireEvent.change(screen.getByLabelText('Body / notes'), { target: { value: 'The broker said the business is unavailable.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Communication' }));

    await waitFor(() => expect(onLogCommunication).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'inbound',
      channel: 'phone',
      occurredAt: expect.any(String),
      fromAddress: 'Broker Name',
      toAddresses: ['Mathew Uckele', 'Owner Contact'],
      subject: 'Broker call',
      bodyText: 'The broker said the business is unavailable.',
      cimRequestId: 'cim-1',
      status: 'contacted',
      followUpState: 'completed',
    })));

    rerender(<CrmCommunications onLogCommunication={onLogCommunication} readOnly />);
    expect(screen.queryByRole('button', { name: 'Log Communication' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Communication' })).not.toBeInTheDocument();
  });

  test('allows historical logging on an archived lead without exposing workflow scheduling controls', () => {
    render(<CrmCommunications onLogCommunication={vi.fn()} workflowUpdatesDisabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Log Communication' }));
    expect(screen.getByLabelText('Update CRM status (optional)')).toBeDisabled();
    expect(screen.getByLabelText('Update follow-up state (optional)')).toBeDisabled();
    expect(screen.getByText(/restore the lead before changing workflow or scheduling follow-up/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save Communication' })).toBeEnabled();
  });

  test('has explicit loading, error, empty, and Load More states', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<CrmCommunications loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading communications');
    expect(screen.getByRole('status')).toHaveAttribute('data-layout', 'responsive-state');
    expect(screen.getByRole('status')).toHaveClass('min-w-0', 'break-words');

    rerender(<CrmCommunications error="Communications are temporarily unavailable." />);
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('alert')).toHaveClass('min-w-0', 'break-words');

    rerender(<CrmCommunications />);
    expect(screen.getByText('No communications have been recorded for this CRM record.')).toBeVisible();
    expect(screen.getByText('No communications have been recorded for this CRM record.')).toHaveClass('min-w-0', 'break-words');

    rerender(<CrmCommunications communications={communications} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
