// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CimRequestHistory from '../src/components/admin/CimRequestHistory.jsx';

afterEach(cleanup);

const defaultQuery = {
  search: '',
  requestState: 'all',
  deliveryState: 'all',
  replyState: 'all',
  followUpState: 'all',
  sort: 'first_requested_at',
  direction: 'desc',
  page: 2,
  pageSize: 10,
};

const bouncedRequest = {
  id: 'cim-request-1',
  submission_id: 'crm-record-1',
  business_name: 'Northstar Services',
  recipient_email: 'old-address@broker.example',
  subject: 'CIM / NDA request for Northstar Services',
  request_state: 'provider-accepted',
  delivery_state: 'bounced',
  first_requested_at: '2026-07-01T18:00:00.000Z',
  last_activity_at: '2026-07-02T18:00:00.000Z',
  updated_at: '2035-01-01T00:00:00.000Z',
  follow_up_count: 0,
  delivery_error: 'Mailbox does not exist.',
  listing_url: 'https://broker.example/northstar',
};

describe('CimRequestHistory', () => {
  test('shows durable counts, independent lifecycle, stable first-request time, and CRM/listing links', () => {
    const { container } = render(
      <CimRequestHistory
        counts={{ ready: 2, pending: 1, accepted: 4, delivered: 3, delivery_issue: 1, replied: 2 }}
        query={defaultQuery}
        requests={[bouncedRequest]}
        total={11}
        totalPages={2}
      />,
    );

    expect(screen.getByRole('heading', { name: 'CIM Request History' })).toBeVisible();
    const lifecycle = within(container.querySelector('[data-cim-request-id="cim-request-1"]')).getByLabelText('Communication lifecycle');
    expect(within(lifecycle).getByText('Provider accepted')).toBeVisible();
    expect(within(lifecycle).getByText('Bounced')).toBeVisible();
    expect(screen.getByText(/Jul 1, 2026/)).toBeVisible();
    expect(screen.queryByText(/2035/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open CRM record' })).toHaveAttribute('href', '/admin/crm/crm-record-1');
    expect(screen.getByRole('link', { name: 'Original listing' })).toHaveAttribute('href', 'https://broker.example/northstar');
    expect(screen.getByText('Delivery issues').parentElement).toHaveTextContent('1');
    expect(container.querySelector('[data-layout="responsive-counts"]')).toHaveClass('grid-cols-2', 'sm:grid-cols-3', 'xl:grid-cols-6');
  });

  test('emits controlled search, filter, sorting, and pagination query changes', () => {
    const onQueryChange = vi.fn();
    render(
      <CimRequestHistory
        onQueryChange={onQueryChange}
        query={defaultQuery}
        requests={[bouncedRequest]}
        total={11}
        totalPages={2}
      />,
    );

    fireEvent.change(screen.getByLabelText('Search CIM history'), { target: { value: 'Northstar' } });
    fireEvent.change(screen.getByLabelText('Delivery state'), { target: { value: 'bounced' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'Northstar', page: 1 }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ deliveryState: 'bounced', page: 1 }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ sort: 'failure', page: 1 }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }));
  });

  test('reveals the exact persisted initial and follow-up email copies as safe plain text', () => {
    render(
      <CimRequestHistory
        query={defaultQuery}
        requests={[{
          ...bouncedRequest,
          communications: [
            {
              id: 'communication-initial',
              direction: 'outbound',
              kind: 'deal-hunter-cim-request',
              from_address: 'Mathew Uckele <mathew@example.com>',
              to_addresses: ['broker@example.com'],
              reply_to_address: 'cim-request-1@inbound.example.com',
              subject: 'Exact initial subject',
              body_text: 'Exact initial body. <script>never executes</script>',
              occurred_at: '2026-07-01T18:00:00.000Z',
            },
            {
              id: 'communication-follow-up',
              direction: 'outbound',
              kind: 'deal-hunter-cim-follow-up',
              from_address: 'Mathew Uckele <mathew@example.com>',
              to_addresses: ['broker@example.com'],
              subject: 'Exact follow-up subject',
              body_text: 'Exact follow-up body.',
              occurred_at: '2026-07-03T18:00:00.000Z',
            },
          ],
        }]}
      />,
    );

    fireEvent.click(screen.getByText('View exact sent emails (2)'));
    expect(screen.getByRole('heading', { name: 'Initial CIM request' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'CIM follow-up 1' })).toBeVisible();
    expect(screen.getByText('Exact initial subject')).toBeVisible();
    expect(screen.getByText('Exact initial body. <script>never executes</script>')).toBeVisible();
    expect(screen.getByText('Exact follow-up body.')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
  });

  test('CIM Request History renders deterministic Follow-Up four and five communications', () => {
    render(<CimRequestHistory
      query={defaultQuery}
      requests={[{
        ...bouncedRequest,
        communications: [
          { id: 'initial', direction: 'outbound', kind: 'deal-hunter-cim-request', subject: 'Initial', body_text: 'Initial body.' },
          { id: 'five', direction: 'outbound', kind: 'deal-hunter-cim-follow-up', follow_up_number: 5, subject: 'Fifth', body_text: 'Exact fifth follow-up.' },
          { id: 'four', direction: 'outbound', kind: 'deal-hunter-cim-follow-up', metadata: { followUpNumber: 4 }, subject: 'Fourth', body_text: 'Exact fourth follow-up.' },
        ],
      }]}
    />);

    fireEvent.click(screen.getByText('View exact sent emails (3)'));
    expect(screen.getByRole('heading', { name: 'CIM follow-up 4' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'CIM follow-up 5' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'CIM follow-up 1' })).not.toBeInTheDocument();
    expect(screen.getByText('Exact fourth follow-up.')).toBeVisible();
    expect(screen.getByText('Exact fifth follow-up.')).toBeVisible();
  });

  test('offers corrected-recipient retry only to administrators for delivery issues', () => {
    const onRetryCorrectedRecipient = vi.fn();
    const { rerender } = render(
      <CimRequestHistory
        onRetryCorrectedRecipient={onRetryCorrectedRecipient}
        query={defaultQuery}
        requests={[bouncedRequest]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry with corrected recipient' }));
    expect(onRetryCorrectedRecipient).toHaveBeenCalledWith(bouncedRequest);

    rerender(
      <CimRequestHistory
        onRetryCorrectedRecipient={onRetryCorrectedRecipient}
        query={defaultQuery}
        readOnly
        requests={[bouncedRequest]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry with corrected recipient' })).not.toBeInTheDocument();
  });

  test('labels console-provider rows as development only without claiming delivery', () => {
    const { container } = render(
      <CimRequestHistory
        query={defaultQuery}
        requests={[{ ...bouncedRequest, id: 'console-request', provider: 'console', delivery_state: 'accepted' }]}
      />,
    );

    const lifecycle = within(container.querySelector('[data-cim-request-id="console-request"]')).getByLabelText('Communication lifecycle');
    expect(within(lifecycle).getByText('Development only')).toBeVisible();
    expect(within(lifecycle).queryByText('Provider accepted')).not.toBeInTheDocument();
    expect(within(lifecycle).queryByText('Awaiting delivery')).not.toBeInTheDocument();
    expect(within(lifecycle).queryByText('Delivered')).not.toBeInTheDocument();
  });

  test('has explicit loading, error, and empty states and rejects unsafe listing URLs', () => {
    const { rerender } = render(<CimRequestHistory loading query={defaultQuery} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading CIM request history');
    expect(screen.getByRole('status')).toHaveAttribute('data-layout', 'responsive-state');
    expect(screen.getByRole('status')).toHaveClass('min-w-0', 'break-words');

    rerender(<CimRequestHistory error="History unavailable." query={defaultQuery} />);
    expect(screen.getByRole('alert')).toHaveTextContent('History unavailable.');
    expect(screen.getByRole('alert')).toHaveClass('min-w-0', 'break-words');

    rerender(<CimRequestHistory query={defaultQuery} />);
    expect(screen.getByText('No CIM requests match these filters.')).toBeVisible();
    expect(screen.getByText('No CIM requests match these filters.')).toHaveClass('min-w-0', 'break-words');

    rerender(<CimRequestHistory query={defaultQuery} requests={[{ ...bouncedRequest, listing_url: 'javascript:alert(1)' }]} />);
    expect(screen.queryByRole('link', { name: 'Original listing' })).not.toBeInTheDocument();
  });
});
