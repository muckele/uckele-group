// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import CrmNavigation from '../src/components/admin/CrmNavigation.jsx';
import { crmFiltersFromSearch, crmSearchFromFilters } from '../src/pages/DashboardPage.jsx';

afterEach(cleanup);

describe('CRM navigation', () => {
  const filters = {
    search: '',
    status: 'all',
    created: 'all',
    page: 2,
    pageSize: 25,
    sort: 'created_at',
    direction: 'desc',
  };

  test('reports accurate record range and requests adjacent pages', () => {
    const onChange = vi.fn();
    render(<CrmNavigation filters={filters} onChange={onChange} total={63} totalPages={3} />);

    expect(screen.getByText('26–50 of 63 records · Page 2 of 3')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onChange).toHaveBeenCalledWith({ page: 3 });
  });

  test('resets the page when page size or status changes', () => {
    const onChange = vi.fn();
    render(<CrmNavigation filters={filters} onChange={onChange} total={63} totalPages={3} />);

    fireEvent.change(screen.getByLabelText('Per page'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'review' } });

    expect(onChange).toHaveBeenCalledWith({ pageSize: 50, page: 1 });
    expect(onChange).toHaveBeenCalledWith({ status: 'review', page: 1 });
  });

  test('round-trips URL-persisted CRM state', () => {
    const query = crmSearchFromFilters({
      ...filters,
      search: 'HVAC broker',
      status: 'review',
      created: 'last-7-days',
      pageSize: 50,
      sort: 'company',
      direction: 'asc',
    });
    const parsed = crmFiltersFromSearch(`?${query}`);

    expect(parsed).toEqual({
      search: 'HVAC broker',
      status: 'review',
      created: 'last-7-days',
      page: 2,
      pageSize: 50,
      sort: 'company',
      direction: 'asc',
    });
  });

  test('applies and clears the last-seven-days filter', () => {
    const onChange = vi.fn();
    render(<CrmNavigation filters={filters} onChange={onChange} total={63} totalPages={3} />);

    fireEvent.change(screen.getByLabelText('Created'), { target: { value: 'last-7-days' } });

    expect(onChange).toHaveBeenCalledWith({ created: 'last-7-days', page: 1 });
    expect(crmFiltersFromSearch('?created=last-7-days').created).toBe('last-7-days');
    expect(crmFiltersFromSearch('?created=not-valid').created).toBe('all');
  });

  test('shows the active filter count and clears discovery filters together', () => {
    const onChange = vi.fn();
    render(
      <CrmNavigation
        filters={{ ...filters, search: 'dental', status: 'review', created: 'last-7-days' }}
        onChange={onChange}
        total={4}
        totalPages={1}
      />,
    );

    expect(screen.getByText('Find a CRM record')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear 3 filters' }));

    expect(onChange).toHaveBeenCalledWith({ search: '', created: 'all', status: 'all', page: 1 });
  });

  test('represents every accepted deep-link sort direction in the visible control', () => {
    const onChange = vi.fn();
    const parsed = crmFiltersFromSearch('?sort=priority&direction=asc');

    render(<CrmNavigation filters={parsed} onChange={onChange} total={1} totalPages={1} />);

    expect(screen.getByLabelText('Sort')).toHaveValue('priority:asc');
    expect(screen.getByRole('option', { name: 'Lowest priority' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Highest deal score' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Newest listed' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'status:desc' } });
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'deal_score:desc' } });
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'listing_date:asc' } });
    expect(onChange).toHaveBeenCalledWith({ sort: 'status', direction: 'desc', page: 1 });
    expect(onChange).toHaveBeenCalledWith({ sort: 'deal_score', direction: 'desc', page: 1 });
    expect(onChange).toHaveBeenCalledWith({ sort: 'listing_date', direction: 'asc', page: 1 });
    expect(crmFiltersFromSearch('?sort=deal_score&direction=desc').sort).toBe('deal_score');
    expect(crmFiltersFromSearch('?sort=listing_date&direction=asc').sort).toBe('listing_date');
  });
});
