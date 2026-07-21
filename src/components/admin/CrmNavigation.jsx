import React from 'react';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';

const pageSizes = [10, 25, 50, 100];

const sortOptions = [
  { value: 'created_at:desc', label: 'Newest added' },
  { value: 'created_at:asc', label: 'Oldest added' },
  { value: 'updated_at:desc', label: 'Recently updated' },
  { value: 'updated_at:asc', label: 'Least recently updated' },
  { value: 'next_action_at:asc', label: 'Next action soonest' },
  { value: 'next_action_at:desc', label: 'Next action latest' },
  { value: 'priority:desc', label: 'Highest priority' },
  { value: 'priority:asc', label: 'Lowest priority' },
  { value: 'deal_score:desc', label: 'Highest deal score' },
  { value: 'deal_score:asc', label: 'Lowest deal score' },
  { value: 'listing_date:desc', label: 'Newest listed' },
  { value: 'listing_date:asc', label: 'Oldest listed' },
  { value: 'company:asc', label: 'Company A–Z' },
  { value: 'company:desc', label: 'Company Z–A' },
  { value: 'status:asc', label: 'Status A–Z' },
  { value: 'status:desc', label: 'Status Z–A' },
];

function rangeLabel(page, pageSize, total) {
  if (!total) {
    return '0 records';
  }

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return `${first}–${last} of ${total} records`;
}

export default function CrmNavigation({ filters, total, totalPages, onChange, disabled = false }) {
  const sortValue = `${filters.sort}:${filters.direction}`;
  const activeFilterCount = [filters.search, filters.created !== 'all', filters.status !== 'all'].filter(Boolean).length;

  function clearFilters() {
    onChange({ search: '', created: 'all', status: 'all', page: 1 });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-moss" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-ink">Find a CRM record</h2>
          </div>
          <p className="mt-1 text-sm leading-6 text-ink/60">Search and filter the index, then open a record to edit its full deal room.</p>
        </div>
        {activeFilterCount > 0 ? (
          <button
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink/75 transition hover:border-moss/30 hover:text-moss"
            disabled={disabled}
            onClick={clearFilters}
            type="button"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Clear {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 border-t border-line/80 pt-4 md:grid-cols-2 xl:grid-cols-[minmax(15rem,1.4fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(11rem,1fr)_minmax(7rem,0.55fr)]">
        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Search CRM
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" aria-hidden="true" />
            <input
              className="form-control pl-10"
              onChange={(event) => onChange({ search: event.target.value, page: 1 })}
              placeholder="Company, contact, notes, URL, or email"
              type="search"
              value={filters.search}
            />
          </span>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Created
          <select className="form-control" onChange={(event) => onChange({ created: event.target.value, page: 1 })} value={filters.created || 'all'}>
            <option value="all">Any time</option>
            <option value="last-7-days">Last 7 days</option>
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Status
          <select className="form-control" onChange={(event) => onChange({ status: event.target.value, page: 1 })} value={filters.status}>
            <option value="all">All statuses</option>
            {['new', 'review', 'contacted', 'archived', 'spam'].map((status) => (
              <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Sort
          <select
            className="form-control"
            onChange={(event) => {
              const [sort, direction] = event.target.value.split(':');
              onChange({ sort, direction, page: 1 });
            }}
            value={sortValue}
          >
            {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Per page
          <select
            className="form-control"
            onChange={(event) => onChange({ pageSize: Number(event.target.value), page: 1 })}
            value={filters.pageSize}
          >
            {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t border-line/80 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite" className="text-sm font-medium text-ink/70">
          {rangeLabel(filters.page, filters.pageSize, total)} · Page {filters.page} of {Math.max(1, totalPages)}
        </p>
        <div className="flex gap-2">
          <button
            className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink transition hover:border-moss/30 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled || filters.page <= 1}
            onClick={() => onChange({ page: Math.max(1, filters.page - 1) })}
            type="button"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <button
            className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-ink transition hover:border-moss/30 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled || filters.page >= totalPages}
            onClick={() => onChange({ page: Math.min(totalPages, filters.page + 1) })}
            type="button"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
