// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import UnassignedCommunicationsInbox from '../src/components/admin/UnassignedCommunicationsInbox.jsx';

afterEach(cleanup);

const unassigned = {
  id: 'communication-1',
  from_address: 'broker@example.com',
  to_addresses: ['deals@inbound.example.com'],
  subject: 'Re: confidential listing',
  body_text: '<img src=x onerror=alert(1)> The listing is no longer available. '.repeat(8),
  occurred_at: '2026-08-06T17:00:00.000Z',
  attachment_count: 2,
  candidate_records: [
    { id: 'crm-1', company: 'Northstar Services', broker_email: 'broker@example.com' },
    { id: 'crm-2', company: 'West Coast Services', broker_email: 'broker@example.com' },
  ],
};

describe('UnassignedCommunicationsInbox', () => {
  test('shows only bounded assignment context and renders preview markup as text', () => {
    const { container } = render(<UnassignedCommunicationsInbox communications={[unassigned]} previewLength={100} />);

    expect(screen.getByText('Re: confidential listing')).toBeVisible();
    expect(screen.getByText('broker@example.com', { exact: false })).toBeVisible();
    expect(screen.getByText('2 attachments')).toBeVisible();
    const preview = container.querySelector('[data-communication-id="communication-1"] > p.rounded-xl');
    expect(preview.textContent.length).toBeLessThanOrEqual(100);
    expect(preview).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-layout="responsive-stack"]')).toHaveClass('space-y-4');
  });

  test('assigns one communication to an explicitly selected CRM record', async () => {
    const onAssign = vi.fn().mockResolvedValue({ success: true });
    render(<UnassignedCommunicationsInbox communications={[unassigned]} onAssign={onAssign} />);

    fireEvent.change(screen.getByLabelText('Assign to CRM record'), { target: { value: 'crm-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign Communication' }));

    await waitFor(() => expect(onAssign).toHaveBeenCalledWith({ communicationId: 'communication-1', submissionId: 'crm-2' }));
  });

  test('can accept externally searched record options and hides assignment controls in read-only mode', () => {
    const onAssign = vi.fn();
    const { rerender } = render(
      <UnassignedCommunicationsInbox
        communications={[{ ...unassigned, candidate_records: [] }]}
        onAssign={onAssign}
        recordOptions={[{ id: 'crm-search-result', company: 'Searched Business', seller_email: 'seller@example.com' }]}
      />,
    );

    expect(screen.getByRole('option', { name: 'Searched Business · seller@example.com' })).toBeInTheDocument();

    rerender(<UnassignedCommunicationsInbox communications={[unassigned]} onAssign={onAssign} readOnly />);
    expect(screen.queryByLabelText('Assign to CRM record')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign Communication' })).not.toBeInTheDocument();
  });

  test('searches the server-backed CRM list when sender candidates are empty', async () => {
    const onAssign = vi.fn().mockResolvedValue({ success: true });
    const onSearchRecords = vi.fn().mockResolvedValue([
      { id: 'crm-found', company: 'Found Destination', broker_email: 'other@example.com' },
    ]);
    render(
      <UnassignedCommunicationsInbox
        communications={[{ ...unassigned, candidate_records: [] }]}
        onAssign={onAssign}
        onSearchRecords={onSearchRecords}
      />,
    );

    expect(screen.getByText(/No safe candidate records are available/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Search all CRM records'), { target: { value: 'Found Destination' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search CRM' }));

    await waitFor(() => expect(onSearchRecords).toHaveBeenCalledWith('Found Destination'));
    const option = await screen.findByRole('option', { name: 'Found Destination · other@example.com' });
    expect(option).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assign to CRM record'), { target: { value: 'crm-found' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign Communication' }));
    await waitFor(() => expect(onAssign).toHaveBeenCalledWith({ communicationId: 'communication-1', submissionId: 'crm-found' }));
  });

  test('has explicit loading, error, empty, and Load More states', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<UnassignedCommunicationsInbox loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading unassigned communications');
    expect(screen.getByRole('status')).toHaveAttribute('data-layout', 'responsive-state');
    expect(screen.getByRole('status')).toHaveClass('min-w-0', 'break-words');

    rerender(<UnassignedCommunicationsInbox error="Inbox temporarily unavailable." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Inbox temporarily unavailable.');
    expect(screen.getByRole('alert')).toHaveClass('min-w-0', 'break-words');

    rerender(<UnassignedCommunicationsInbox />);
    expect(screen.getByText('No unassigned communications need review.')).toBeVisible();
    expect(screen.getByText('No unassigned communications need review.')).toHaveClass('min-w-0', 'break-words');

    rerender(<UnassignedCommunicationsInbox communications={[unassigned]} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
