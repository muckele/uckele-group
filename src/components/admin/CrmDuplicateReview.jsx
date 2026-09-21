import React, { useEffect, useState } from 'react';

const categoryOrder = [
  'resolved/superseded',
  'confirmed-duplicate',
  'strong-candidate',
  'uncertain',
  'keep-distinct',
];

function RecordLink({ submissionId, children }) {
  return (
    <a className="font-semibold text-moss underline underline-offset-4" href={`/admin/crm/${encodeURIComponent(submissionId)}`}>
      {children}
    </a>
  );
}

function EvidenceList({ label, items = [] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/55">{label}</p>
      <ul className="mt-2 space-y-1 text-sm text-ink/70">
        {items.map((item) => (
          <li key={`${item.category}:${item.hash}`}>
            <span className="font-medium text-ink">{item.category}</span>{' '}
            <code className="text-xs text-ink/55">{item.hash.slice(0, 12)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PairRow({ row }) {
  return (
    <li className="rounded-2xl border border-line/75 bg-white p-4">
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <RecordLink submissionId={row.lowerSubmissionId}>Record {row.lowerSubmissionId}</RecordLink>
        <RecordLink submissionId={row.higherSubmissionId}>Record {row.higherSubmissionId}</RecordLink>
        {row.activeSupersession?.survivorSubmissionId ? (
          <RecordLink submissionId={row.activeSupersession.survivorSubmissionId}>Open surviving CRM record</RecordLink>
        ) : null}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <EvidenceList items={row.corroboratingEvidence} label="Corroborating evidence" />
        <EvidenceList items={row.conflictingEvidence} label="Conflicting evidence" />
      </div>
      {row.blockers.length > 0 ? (
        <p className="mt-4 text-sm text-ink/65">Blockers: {row.blockers.join(', ')}</p>
      ) : null}
    </li>
  );
}

export default function CrmDuplicateReview({ report: providedReport = null }) {
  const [report, setReport] = useState(providedReport);
  const [error, setError] = useState('');

  useEffect(() => {
    if (providedReport) {
      setReport(providedReport);
      return undefined;
    }
    const controller = new AbortController();
    fetch('/api/admin/crm-duplicates', {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body?.report) throw new Error(body?.error || 'Unable to load duplicate review.');
        setReport(body.report);
      })
      .catch((loadError) => {
        if (loadError?.name !== 'AbortError') setError(loadError?.message || 'Unable to load duplicate review.');
      });
    return () => controller.abort();
  }, [providedReport]);

  return (
    <div aria-labelledby="crm-duplicate-review-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss/75">Read-only identity review</p>
        <h2 className="mt-2 text-2xl font-semibold text-ink" id="crm-duplicate-review-title">CRM duplicate review</h2>
        <p className="mt-2 text-sm leading-6 text-ink/65">Pairwise evidence is shown independently. Open a CRM record to inspect its retained history.</p>
      </div>

      {error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</p> : null}
      {!report && !error ? <p className="mt-5 text-sm text-ink/60" role="status">Loading duplicate review…</p> : null}
      {report && report.complete !== true ? (
        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
          The review could not prove a complete bounded snapshot, so no candidate rows are shown.
        </p>
      ) : null}
      {report?.complete === true ? (
        <div className="mt-6 grid gap-5">
          {categoryOrder.map((category) => {
            const rows = report.rows.filter((row) => row.category === category);
            return (
              <section aria-labelledby={`crm-duplicate-${category}`} className="rounded-2xl border border-line/75 bg-fog/45 p-4 sm:p-5" key={category}>
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-lg font-semibold text-ink" id={`crm-duplicate-${category}`}>{category}</h3>
                  <span className="text-sm text-ink/55">{rows.length}</span>
                </div>
                {rows.length > 0 ? (
                  <ul className="mt-4 space-y-3">{rows.map((row) => <PairRow key={row.pairKey} row={row} />)}</ul>
                ) : (
                  <p className="mt-3 text-sm text-ink/55">No pairs in this category.</p>
                )}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
