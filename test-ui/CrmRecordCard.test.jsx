// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { CrmRecordCard } from '../src/pages/DashboardPage.jsx';

afterEach(cleanup);

const submission = {
  id: 'record-123',
  company: 'Northstar Services',
  status: 'review',
  priority: 'high',
  lead_type: 'broker',
  created_at: '2026-07-20T18:00:00.000Z',
  assigned_to: 'Mathew',
  asking_price: '$2.4M',
  ttm_revenue: '$3.1M',
  ttm_ebitda: '$620K',
  ebitda_multiple: '3.9x',
  broker_name: 'Alex Broker',
  broker_email: 'alex@example.com',
  next_action_at: '2000-01-01T00:00:00.000Z',
  follow_up_state: 'needs-response',
  listing_url: 'https://example.com/listing',
  metadata: { dealHunter: { score: 82 } },
};

function renderCard(overrides = {}) {
  return render(
    <MemoryRouter>
      <CrmRecordCard
        detailHref="/admin/crm/record-123?status=review"
        submission={{ ...submission, ...overrides }}
      />
    </MemoryRouter>,
  );
}

describe('CRM record summary card', () => {
  test('surfaces triage information and preserves the filtered detail route', () => {
    renderCard();

    expect(screen.getByRole('heading', { name: 'Northstar Services' })).toBeVisible();
    expect(screen.getByText('High priority')).toBeVisible();
    expect(screen.getByText('Score 82')).toBeVisible();
    expect(screen.getByText('$620K')).toBeVisible();
    expect(screen.getByRole('link', { name: 'alex@example.com' })).toHaveAttribute('href', 'mailto:alex@example.com');
    expect(screen.getByRole('link', { name: 'Listing URL' })).toHaveAttribute('href', 'https://example.com/listing');
    expect(screen.getByRole('link', { name: 'Open record' })).toHaveAttribute('href', '/admin/crm/record-123?status=review');
    expect(screen.queryByRole('button', { name: 'Save Updates' })).not.toBeInTheDocument();
  });

  test('does not flag a completed follow-up as overdue', () => {
    renderCard({ follow_up_state: 'completed' });

    const nextActionSection = screen.getByText('Next action').parentElement;
    expect(nextActionSection.querySelector('.text-red-700')).toBeNull();
    expect(screen.getByText('Completed')).toBeVisible();
  });

  test('highlights an outstanding past-due next action', () => {
    renderCard();

    const nextActionSection = screen.getByText('Next action').parentElement;
    expect(nextActionSection.querySelector('.text-red-700')).not.toBeNull();
  });
});
