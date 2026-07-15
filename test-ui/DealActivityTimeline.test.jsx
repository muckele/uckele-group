// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DealActivityTimeline from '../src/components/admin/DealActivityTimeline';

afterEach(cleanup);

const events = [
  {
    id: '1',
    event_type: 'submission.updated',
    summary: 'Record updated.',
    actor: 'matt',
    role: 'admin',
    created_at: '2026-07-13T12:00:00.000Z',
    metadata: {
      changes: [
        { field: 'status', before: 'review', after: 'contacted' },
        {
          field: 'metadata',
          before: { diligence: { stage: 'not-started' }, snapshotToken: 'old-sensitive-token' },
          after: { diligence: { stage: 'financial-review' }, snapshotToken: 'new-sensitive-token' },
        },
      ],
    },
  },
  { id: '2', event_type: 'email.replied', summary: 'Email replied.', actor: 'seller@example.com', role: 'contact', created_at: '2026-07-13T13:00:00.000Z' },
  { id: '3', event_type: 'documents.uploaded', summary: 'Two documents uploaded.', actor: 'seller@example.com', role: 'contact', created_at: '2026-07-13T14:00:00.000Z' },
];

describe('DealActivityTimeline', () => {
  it('shows actor and timestamp information for durable events', () => {
    render(<DealActivityTimeline events={events} />);
    expect(screen.getByText('matt · admin')).toBeInTheDocument();
    expect(screen.getAllByText('seller@example.com · contact')).toHaveLength(2);
    expect(screen.getAllByText(/Jul 13, 2026/i)).toHaveLength(3);
  });

  it('filters events by workflow area', () => {
    render(<DealActivityTimeline events={events} />);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'documents' } });
    expect(screen.getByText('Two documents uploaded.')).toBeInTheDocument();
    expect(screen.queryByText('Record updated.')).not.toBeInTheDocument();
    expect(screen.queryByText('Email replied.')).not.toBeInTheDocument();
  });

  it('shows safe before and after values for recorded field changes', () => {
    render(<DealActivityTimeline events={events} />);

    expect(screen.getByText('Changed fields')).toBeVisible();
    expect(screen.getByText('Status')).toBeVisible();
    expect(screen.getByText('review')).toBeInTheDocument();
    expect(screen.getByText('contacted')).toBeInTheDocument();
    expect(screen.getAllByText('Before:')).toHaveLength(2);
    expect(screen.getAllByText('After:')).toHaveLength(2);
    expect(screen.getAllByText(/\[redacted\]/)).toHaveLength(2);
    expect(screen.queryByText(/sensitive-token/)).not.toBeInTheDocument();
  });
});
