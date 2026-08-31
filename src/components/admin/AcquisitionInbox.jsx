import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import OpportunityDrawer from './OpportunityDrawer.jsx';

const emptySummary = { needsReview: 0, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 0 };
const summaryItems = [
  ['needsReview', 'Needs Review'], ['highPriority', 'High Priority'], ['watchlist', 'Watchlist'],
  ['lowConfidence', 'Low Confidence'], ['currentOpportunities', 'Current Opportunities'],
];
const views = [
  ['needs-review', 'Needs Review'], ['high-priority', 'High Priority'], ['watchlist', 'Watchlist'],
  ['low-confidence', 'Low Confidence'], ['dismissed', 'Passed'], ['all', 'All Current'],
];
const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-moss bg-moss px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-pine disabled:opacity-50';

function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value));
}

function formatLabel(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function ActionButtons({ disabled, name, onAction }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button aria-label={`Pursue ${name}`} className={primaryButtonClass} disabled={disabled} onClick={() => onAction('pursue')} type="button">Pursue</button>
      <button aria-label={`Watch ${name}`} className={buttonClass} disabled={disabled} onClick={() => onAction('watch')} type="button">Watch</button>
      <button aria-label={`Pass ${name}`} className={`${buttonClass} text-red-700`} disabled={disabled} onClick={() => onAction('pass')} type="button">Pass</button>
    </div>
  );
}

function OpportunityRow({ onAction, onOpen, pending, readOnly, row }) {
  return (
    <li className="grid gap-4 rounded-2xl border border-line bg-white p-4 shadow-sm md:grid-cols-[minmax(15rem,1.35fr)_repeat(4,minmax(6.5rem,.65fr))_minmax(10rem,.8fr)] md:items-center md:rounded-none md:border-x-0 md:border-b-0 md:p-3 md:shadow-none">
      <div className="min-w-0">
        <button aria-label={`Open ${row.name}`} className="text-left text-base font-semibold text-ink underline decoration-transparent underline-offset-4 transition hover:text-moss hover:decoration-moss/30" onClick={onOpen} type="button">{row.name}</button>
        <p className="mt-1 text-xs text-ink/58">{row.geography?.label || row.state || 'Location not supplied'} · {row.industry || 'Industry not supplied'}</p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
          {!row.reviewed ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">Needs review</span> : null}
          {row.changedSinceReview ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">Changed</span> : null}
          {row.operatorPriority !== 'normal' ? <span className="rounded-full bg-moss/10 px-2 py-0.5 text-moss">{formatLabel(row.operatorPriority)}</span> : null}
          <span className="rounded-full bg-fog px-2 py-0.5 text-ink/68">CRM: {formatLabel(row.workflow?.crmStatus || 'not-started')}</span>
          <span className="rounded-full bg-fog px-2 py-0.5 text-ink/68">CIM: {formatLabel(row.workflow?.cimStatus || 'not-requested')}</span>
        </div>
      </div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45 md:hidden">Fit</p><p className="text-xl font-semibold tabular-nums text-ink">{row.fitScore}</p><p className="text-[11px] font-semibold text-ink/58">{row.confidence} confidence</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">SDE / Profit</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.annualProfit)}</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">Revenue</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.annualRevenue)}</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">Ask / Multiple</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.askingPrice)}</p>{row.financials?.profitMultiple !== null && row.financials?.profitMultiple !== undefined ? <p className="text-xs text-ink/58">{row.financials.profitMultiple.toFixed(2)}×</p> : null}</div>
      <div className="min-w-0">
        {row.topStrength ? <p className="text-xs leading-5 text-moss">{row.topStrength}</p> : null}
        {row.topConcern ? <p className="mt-1 text-xs leading-5 text-amber-800">{row.topConcern}</p> : null}
        {!readOnly ? <div className="mt-2"><ActionButtons disabled={pending} name={row.name} onAction={onAction} /></div> : null}
      </div>
    </li>
  );
}

export default function AcquisitionInbox({ readOnly = false }) {
  const [view, setView] = useState('needs-review');
  const [search, setSearch] = useState('');
  const [confidence, setConfidence] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('acquisition-priority');
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState({ rows: [], total: 0, page: 1, totalPages: 1, summary: emptySummary });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState({ data: null, loading: false, error: '' });

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view, page: String(page), pageSize: '25', sort, direction: 'desc' });
      if (search.trim()) params.set('search', search.trim());
      if (confidence) params.set('confidence', confidence);
      if (priority) params.set('priority', priority);
      const response = await fetch(`/api/admin/deal-hunter/triage?${params}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load Acquisition Inbox.');
      setQueue(result);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load Acquisition Inbox.');
    } finally {
      setLoading(false);
    }
  }, [confidence, page, priority, search, sort, view]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const loadDetail = useCallback(async (opportunityId) => {
    setDetail({ data: null, loading: true, error: '' });
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load opportunity detail.');
      setDetail({ data: result, loading: false, error: '' });
    } catch (detailError) {
      setDetail({ data: null, loading: false, error: detailError.message || 'Unable to load opportunity detail.' });
    }
  }, []);

  function openDetail(opportunityId) {
    setSelectedId(opportunityId);
    loadDetail(opportunityId);
  }

  async function recordAction(opportunityId, action) {
    const reason = action === 'pass' ? window.prompt('Why are you passing on this opportunity?') : '';
    if (action === 'pass' && !reason?.trim()) return;
    setPendingId(opportunityId);
    setError('');
    try {
      const body = action === 'pass' ? { action, reason: reason.trim() } : { action };
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to record this decision.');
      await loadQueue();
    } catch (actionError) {
      setError(actionError.message || 'Unable to record this decision.');
    } finally {
      setPendingId('');
    }
  }

  async function saveFact({ field, value, note, verified }) {
    if (!selectedId) return;
    setPendingId(selectedId);
    setError('');
    try {
      const response = await fetch(`/api/admin/deal-hunter/opportunities/${encodeURIComponent(selectedId)}/facts/${encodeURIComponent(field)}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, note, verified }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save the verified fact.');
      await loadDetail(selectedId);
    } catch (factError) {
      setError(factError.message || 'Unable to save the verified fact.');
    } finally {
      setPendingId('');
    }
  }

  return (
    <section aria-label="Acquisition Inbox" className="section-shell mt-8 pb-8">
      <div className="panel overflow-hidden">
        <header className="flex flex-col gap-5 border-b border-line/80 p-5 sm:p-7 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-moss">Deal Hunter</p><h2 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">Acquisition Inbox</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">Review the authoritative opportunity queue, understand the evidence, and record a human decision without triggering scoring or outreach.</p></div>
          <nav aria-label="Deal Hunter views" className="flex rounded-full border border-line bg-fog/70 p-1"><NavLink className="rounded-full bg-moss px-4 py-2 text-sm font-semibold text-white" end to="/admin/deal-hunter">Inbox</NavLink><NavLink className="rounded-full px-4 py-2 text-sm font-semibold text-ink/68 hover:text-moss" to="/admin/deal-hunter?view=operations">Operations</NavLink></nav>
        </header>

        <div className="grid grid-cols-2 border-b border-line/80 sm:grid-cols-3 xl:grid-cols-5">{summaryItems.map(([key, itemLabel]) => <div className="border-b border-r border-line/70 px-4 py-4 last:border-r-0 xl:border-b-0" key={key}><p className="text-2xl font-semibold tabular-nums text-ink">{queue.summary?.[key] || 0}</p><p className="mt-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink/55">{itemLabel}</p></div>)}</div>

        <div className="border-b border-line/80 p-4 sm:p-5">
          <div aria-label="Opportunity queues" className="flex gap-2 overflow-x-auto" role="tablist">{views.map(([id, itemLabel]) => <button aria-selected={view === id} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${view === id ? 'border-moss bg-moss/10 text-moss' : 'border-line bg-white text-ink/62'}`} key={id} onClick={() => { setView(id); setPage(1); }} role="tab" type="button">{itemLabel}</button>)}</div>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(15rem,1fr)_repeat(3,minmax(9rem,auto))]">
            <label className="relative"><span className="sr-only">Search opportunities</span><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-ink/40" /><input aria-label="Search opportunities" className="form-control pl-9" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Business, geography, or deal key" type="search" value={search} /></label>
            <label className="text-xs font-semibold text-ink/58">Confidence<select className="form-control mt-1" onChange={(event) => { setConfidence(event.target.value); setPage(1); }} value={confidence}><option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            <label className="text-xs font-semibold text-ink/58">Operator priority<select className="form-control mt-1" onChange={(event) => { setPriority(event.target.value); setPage(1); }} value={priority}><option value="">All</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="watch">Watch</option></select></label>
            <label className="text-xs font-semibold text-ink/58">Sort opportunities<select className="form-control mt-1" onChange={(event) => { setSort(event.target.value); setPage(1); }} value={sort}><option value="acquisition-priority">Acquisition priority</option><option value="fit-score">Fit score</option><option value="confidence">Confidence</option><option value="scored-at">Newest observation</option><option value="name">Name</option></select></label>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {error ? <p className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
          {loading && queue.rows.length === 0 ? <p className="text-sm text-ink/62">Loading current opportunities…</p> : null}
          {!loading && !error && queue.rows.length === 0 ? <p className="rounded-xl border border-line bg-fog/60 p-4 text-sm text-ink/68">No opportunities in this view.</p> : null}
          <ul aria-label="Opportunity queue" className="space-y-3 overflow-hidden md:space-y-0 md:rounded-2xl md:border md:border-line">{queue.rows.map((row) => <OpportunityRow key={row.opportunityId} onAction={(action) => recordAction(row.opportunityId, action)} onOpen={() => openDetail(row.opportunityId)} pending={pendingId === row.opportunityId} readOnly={readOnly} row={row} />)}</ul>
          {queue.totalPages > 1 ? <div className="mt-4 flex items-center justify-between"><button aria-label="Previous page" className={buttonClass} disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft className="h-4 w-4" />Previous</button><p className="text-xs font-semibold text-ink/58">Page {queue.page || page} of {queue.totalPages}</p><button aria-label="Next page" className={buttonClass} disabled={page >= queue.totalPages || loading} onClick={() => setPage((current) => current + 1)} type="button">Next<ChevronRight className="h-4 w-4" /></button></div> : null}
          {readOnly ? <p className="mt-4 text-sm font-semibold text-ink/62">Read-only access: decisions and verified-fact edits are unavailable.</p> : null}
        </div>
      </div>

      {selectedId ? <OpportunityDrawer detail={detail.data} error={detail.error} loading={detail.loading} onAction={(action) => recordAction(selectedId, action)} onClose={() => { setSelectedId(''); setDetail({ data: null, loading: false, error: '' }); }} onSaveFact={saveFact} pending={pendingId === selectedId} readOnly={readOnly} /> : null}
    </section>
  );
}
