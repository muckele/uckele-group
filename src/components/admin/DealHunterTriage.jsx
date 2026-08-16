import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, RefreshCw, Search, ShieldAlert } from 'lucide-react';

const views = [
  { id: 'needs-review', label: 'Needs review', hint: 'New or materially changed since you last reviewed it.' },
  { id: 'high-priority', label: 'High priority', hint: 'High-fit listings and anything you marked urgent or high.' },
  { id: 'watchlist', label: 'Watchlist', hint: 'Mid-band listings and anything you marked watch.' },
  { id: 'low-confidence', label: 'Low confidence', hint: 'Not enough evidence to judge, or sources disagree.' },
  { id: 'dismissed', label: 'Dismissed', hint: 'Already rejected, with the recorded reason.' },
  { id: 'all', label: 'All scored', hint: 'Every scored opportunity.' },
];

const priorities = ['urgent', 'high', 'normal', 'watch'];

const confidenceTone = {
  high: 'bg-moss/10 text-moss border-moss/30',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  low: 'bg-red-50 text-red-800 border-red-200',
};

const verdictTone = {
  supported: 'bg-moss/70',
  mixed: 'bg-amber-400',
  negative: 'bg-red-400',
  absent: 'bg-line',
};

const secondaryButton = 'inline-flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm font-semibold text-ink transition hover:border-moss/40 disabled:cursor-not-allowed disabled:opacity-60';

function Chip({ children, tone = 'default' }) {
  const tones = {
    default: 'border-line bg-white text-ink/70',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    danger: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-moss/30 bg-moss/10 text-moss',
  };
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

// Fit and confidence are shown as two separate readings. They are never combined
// into one number, because a high score with weak evidence is a research task
// rather than a contact task.
function ScoreReadout({ row }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-ink">{row.fitScore}</span>
        <span className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/50">fit</span>
      </div>
      <span className={`inline-flex w-fit items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${confidenceTone[row.confidence] || confidenceTone.low}`}>
        {row.confidence} confidence
      </span>
    </div>
  );
}

function DimensionBar({ dimensions }) {
  return (
    <div className="flex gap-1" aria-hidden="true">
      {dimensions.map((dimension) => (
        <span
          className={`h-1.5 w-6 rounded-full ${verdictTone[dimension.verdict] || verdictTone.absent}`}
          key={dimension.id}
          title={`${dimension.label}: ${dimension.verdict}`}
        />
      ))}
    </div>
  );
}

function EvidenceDrawer({ detail, loading, error }) {
  if (loading) return <p className="mt-4 text-sm text-ink/62">Loading the score explanation…</p>;
  if (error) return <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>;
  if (!detail) return null;

  return (
    <div className="mt-4 space-y-4">
      {detail.gates?.length > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
          <strong className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" />Disqualified</strong>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {detail.gates.map((gate) => <li key={gate.ruleId}>{gate.reason}</li>)}
          </ul>
        </div>
      ) : null}

      {detail.confidenceReasons?.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Why confidence is limited</strong>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {detail.confidenceReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      ) : null}

      {detail.dimensions?.map((dimension) => (
        <details className="rounded-xl border border-line bg-white p-3" key={dimension.id}>
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            {dimension.label}
            <span className="ml-2 font-normal text-ink/62">
              {dimension.contribution > 0 ? `+${dimension.contribution}` : dimension.contribution} points · {dimension.verdict}
            </span>
          </summary>
          {dimension.rules?.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-ink/74">
              {dimension.rules.map((rule) => (
                <li key={rule.ruleId}>
                  <span className="tabular-nums font-semibold">{rule.delta > 0 ? `+${rule.delta}` : rule.delta}</span> {rule.label}
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-sm text-ink/62">No rule in this dimension applied to this listing.</p>}

          {dimension.evidence?.length > 0 ? (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/50">Evidence</p>
              <ul className="space-y-1 text-xs text-ink/70">
                {dimension.evidence.map((row) => (
                  <li key={`${row.ruleId}-${row.field}-${row.evidenceClass}`}>
                    <Chip tone={row.evidenceClass === 'contradicted' ? 'danger' : row.evidenceClass === 'missing' ? 'warning' : 'default'}>
                      {row.evidenceClass}
                    </Chip>{' '}
                    {row.field ? <span className="font-semibold">{row.field}</span> : null}
                    {row.value !== null && row.value !== undefined && row.value !== '' ? <> = {String(row.value)}</> : null}
                    {row.terms?.length > 0 ? <> · matched {row.terms.slice(0, 4).join(', ')}</> : null}
                    {row.sourceName ? <span className="text-ink/50"> · {row.sourceName}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {dimension.missing?.length > 0 ? (
            <p className="mt-3 text-xs text-amber-800">
              Missing: {dimension.missing.map((item) => item.field || item.label).join(', ')}
            </p>
          ) : null}
        </details>
      ))}

      {detail.missingEvidence?.length > 0 ? (
        <p className="text-sm text-ink/68">
          <strong>Research needed:</strong> the source did not supply {detail.missingEvidence.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

export default function DealHunterTriage({ readOnly = false }) {
  const [view, setView] = useState('needs-review');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState({ rows: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [detail, setDetail] = useState({ data: null, loading: false, error: '' });
  const [pendingId, setPendingId] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view, page: String(page), pageSize: '25' });
      if (search.trim()) params.set('search', search.trim());
      const response = await fetch(`/api/admin/deal-hunter/triage?${params}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load the triage queue.');
      setQueue(result);
    } catch (loadError) {
      setError(loadError.message || 'Unable to load the triage queue.');
    } finally {
      setLoading(false);
    }
  }, [page, search, view]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function openDetail(opportunityId) {
    if (expandedId === opportunityId) {
      setExpandedId('');
      return;
    }
    setExpandedId(opportunityId);
    setDetail({ data: null, loading: true, error: '' });
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load the score explanation.');
      setDetail({ data: result, loading: false, error: '' });
    } catch (detailError) {
      setDetail({ data: null, loading: false, error: detailError.message || 'Unable to load the score explanation.' });
    }
  }

  async function recordDecision(opportunityId, body) {
    setPendingId(opportunityId);
    setError('');
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/decision`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to record the decision.');
      await loadQueue();
    } catch (decisionError) {
      setError(decisionError.message || 'Unable to record the decision.');
    } finally {
      setPendingId('');
    }
  }

  const activeView = views.find((item) => item.id === view) || views[0];

  return (
    <section aria-label="Deal Hunter triage" className="rounded-2xl border border-line bg-white/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <strong>Opportunity triage</strong>
            <Chip>{queue.total} in view</Chip>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">{activeView.hint}</p>
        </div>
        <button className={secondaryButton} disabled={loading} onClick={loadQueue} type="button">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />Refresh queue
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {views.map((item) => (
          <button
            aria-selected={item.id === view}
            className={`rounded-xl border px-3 py-1.5 text-sm font-semibold transition ${item.id === view ? 'border-moss/40 bg-moss/10 text-moss' : 'border-line bg-white text-ink/70 hover:border-moss/30'}`}
            key={item.id}
            onClick={() => { setView(item.id); setPage(1); setExpandedId(''); }}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-ink">
        <Search className="h-4 w-4 text-ink/50" />
        <span className="sr-only">Search opportunities</span>
        <input
          className="form-control"
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          placeholder="Search by business name or deal key"
          value={search}
        />
      </label>

      {error ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}

      {queue.rows.length === 0 && !loading ? (
        <p className="mt-6 rounded-xl border border-line bg-fog/60 p-4 text-sm text-ink/68">
          Nothing in this view. Import a Deal OS export or run a full backfill to score new opportunities.
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {queue.rows.map((row) => (
          <li className="rounded-2xl border border-line bg-white p-4" key={row.opportunityId}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-ink">{row.name}</strong>
                  {row.state ? <Chip>{row.state}</Chip> : null}
                  {row.changedSinceReview ? <Chip tone="warning">Changed since review</Chip> : null}
                  {!row.reviewed ? <Chip>Not yet reviewed</Chip> : null}
                  {row.operatorPriority !== 'normal' ? <Chip tone="success">Priority: {row.operatorPriority}</Chip> : null}
                  {row.dismissed ? <Chip tone="danger">Dismissed{row.dismissedReason ? `: ${row.dismissedReason}` : ''}</Chip> : null}
                </div>
                <DimensionBar dimensions={row.dimensions} />
                {row.topReasons.length > 0 ? (
                  <p className="mt-2 text-sm leading-6 text-ink/70">{row.topReasons.join(' · ')}</p>
                ) : null}
                <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink/60">
                  <span>Completeness {row.completenessScore}/100</span>
                  {row.missingEvidenceCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-amber-800">
                      <AlertTriangle className="h-3.5 w-3.5" />{row.missingEvidenceCount} missing field{row.missingEvidenceCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {row.contradictionCount > 0 ? <span className="text-red-700">{row.contradictionCount} source conflict{row.contradictionCount === 1 ? '' : 's'}</span> : null}
                </p>
              </div>

              <div className="flex flex-col items-start gap-3 lg:items-end">
                <ScoreReadout row={row} />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    aria-expanded={expandedId === row.opportunityId}
                    className={secondaryButton}
                    onClick={() => openDetail(row.opportunityId)}
                    type="button"
                  >
                    <ChevronRight className="h-4 w-4" />Why this score
                  </button>
                  {!readOnly ? (
                    <>
                      <label className="text-sm font-semibold text-ink">
                        <span className="sr-only">Operator priority for {row.name}</span>
                        <select
                          className="form-control"
                          disabled={pendingId === row.opportunityId}
                          onChange={(event) => recordDecision(row.opportunityId, { priority: event.target.value })}
                          value={row.operatorPriority}
                        >
                          {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                        </select>
                      </label>
                      <button
                        className={secondaryButton}
                        disabled={pendingId === row.opportunityId}
                        onClick={() => recordDecision(row.opportunityId, { markReviewed: true })}
                        type="button"
                      >
                        Mark reviewed
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {expandedId === row.opportunityId ? (
              <EvidenceDrawer detail={detail.data} error={detail.error} loading={detail.loading} />
            ) : null}
          </li>
        ))}
      </ul>

      {queue.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-ink/68">
          <button className={secondaryButton} disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">
            Previous
          </button>
          <span>Page {queue.page} of {queue.totalPages}</span>
          <button className={secondaryButton} disabled={page >= queue.totalPages || loading} onClick={() => setPage((current) => current + 1)} type="button">
            Next
          </button>
        </div>
      ) : null}

      {readOnly ? <p className="mt-4 text-sm font-semibold text-ink/68">Read-only users can review scores and evidence but cannot record decisions.</p> : null}
    </section>
  );
}
