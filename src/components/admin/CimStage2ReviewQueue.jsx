import React, { useState } from 'react';

const passReasons = [
  ['industry', 'Industry fit'],
  ['geography', 'Geography'],
  ['valuation', 'Valuation / multiple'],
  ['profit', 'Profit outside target'],
  ['owner-dependence', 'Owner dependence'],
  ['duplicate', 'Duplicate listing'],
  ['recipient', 'Incorrect recipient'],
  ['financing', 'Financing fit'],
  ['quality', 'Listing quality'],
  ['timing', 'Timing'],
  ['other', 'Other'],
];

function safeUrl(value = '') {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function formatMoney(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value))
    : 'Not recorded';
}

function formatDate(value) {
  const parsed = new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString();
}

function initialDecision(candidate = {}) {
  return {
    action: '',
    finalRecipientEmail: candidate.brokerEmail || '',
    finalRecipientName: candidate.brokerName || '',
    passReason: 'industry',
    decisionNote: '',
    recipientEditReason: '',
    reviewConfirmed: false,
  };
}

export default function CimStage2ReviewQueue({ onEvidenceRecorded }) {
  const [queue, setQueue] = useState(null);
  const [decision, setDecision] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadQueue(page = 1, options = {}) {
    setLoading(true);
    setError('');
    if (!options.preserveMessage) setMessage('');
    try {
      const expectedDigest = options.expectedQueueDigest
        ? `&expectedQueueDigest=${encodeURIComponent(options.expectedQueueDigest)}`
        : '';
      const response = await fetch(`/api/admin/deal-hunter/cim-stage2/review-queue?page=${page}&pageSize=1${expectedDigest}`, {
        credentials: 'same-origin',
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load the protected Stage 2 review queue.');
      setQueue(result.queue);
      setDecision(initialDecision(result.queue?.candidates?.[0]));
    } catch (loadError) {
      setError(loadError.message || 'Unable to load the protected Stage 2 review queue.');
    } finally {
      setLoading(false);
    }
  }

  async function submitDecision(candidate) {
    if (!candidate || !decision?.action || !decision.reviewConfirmed) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/deal-hunter/cim-stage2/review-decisions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewToken: candidate.reviewToken,
          action: decision.action,
          finalRecipientEmail: decision.finalRecipientEmail,
          finalRecipientName: decision.finalRecipientName,
          passReason: decision.passReason,
          decisionNote: decision.decisionNote,
          recipientEditReason: decision.recipientEditReason,
          reviewConfirmed: decision.reviewConfirmed,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to append this Stage 2 human decision.');
      setMessage('One authenticated human decision was appended. No broker email or provider call was made. The aggregate counters were refreshed.');
      await Promise.resolve(onEvidenceRecorded?.());
      await loadQueue(Math.min((queue?.page || 1) + 1, queue?.totalPages || 1), {
        preserveMessage: true,
        expectedQueueDigest: queue?.queueDigest || '',
      });
    } catch (submitError) {
      setError(submitError.message || 'Unable to append this Stage 2 human decision.');
    } finally {
      setSubmitting(false);
    }
  }

  const candidate = queue?.candidates?.[0] || null;
  const sourceBlocked = queue && !queue.sourceHealthy;
  const exactSnapshotReviewed = Boolean(candidate?.exactSnapshotReviewed);
  const actionComplete = decision?.action === 'approve'
    || (decision?.action === 'approve-edit'
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(decision.finalRecipientEmail || '')
      && decision.finalRecipientEmail.trim().toLowerCase() !== String(candidate?.brokerEmail || '').trim().toLowerCase()
      && decision.recipientEditReason.trim().length >= 20)
    || (decision?.action === 'reject'
      && decision.passReason
      && (decision.passReason !== 'other' || decision.decisionNote.trim().length >= 10));

  return (
    <section className="mt-5 rounded-2xl border border-moss/20 bg-white p-4" aria-labelledby="cim-stage2-human-review-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink" id="cim-stage2-human-review-heading">Protected zero-send human evidence queue</p>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-ink/65">Full administrators only. The queue covers canonical Sheet-only opportunities in a hash-determined order that does not use score, eligibility, or predicted approval. Review the presented opportunity in order; approve, edit, and reject outcomes are all retained. Recording here never sends email.</p>
        </div>
        <button className="rounded-full border border-line bg-white px-3 py-2 text-xs font-semibold text-ink" disabled={loading || submitting} onClick={() => loadQueue(queue?.page || 1)} type="button">{loading ? 'Loading…' : queue ? 'Refresh current candidate' : 'Load human review queue'}</button>
      </div>

      {error ? <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800" role="alert">{error}</p> : null}
      {message ? <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">{message}</p> : null}

      {queue ? (
        <div className="mt-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-fog/60 p-3 text-xs"><strong>{queue.progress?.canonicalHumanReviews || 0} / {queue.progress?.canonicalHumanReviewsRequired || 25}</strong><p className="mt-1 text-ink/60">Total canonical human decisions</p></div>
            <div className="rounded-xl border border-line bg-fog/60 p-3 text-xs"><strong>{queue.progress?.eligibleCohortReviews || 0} / {queue.progress?.eligibleCohortRequired || 10}</strong><p className="mt-1 text-ink/60">Current-policy eligible cohort</p></div>
            <div className="rounded-xl border border-line bg-fog/60 p-3 text-xs"><strong>{queue.progress?.unchangedRecipientApprovalRate || 0}% / {queue.progress?.unchangedRecipientApprovalRateRequired || 95}%</strong><p className="mt-1 text-ink/60">Unchanged-recipient approvals in cohort</p></div>
            <div className="rounded-xl border border-line bg-fog/60 p-3 text-xs"><strong>{queue.counts?.currentPolicyRemaining ?? 0}</strong><p className="mt-1 text-ink/60">Queue snapshots without current-policy review</p></div>
          </div>
          <p className="mt-3 break-all text-[11px] leading-5 text-ink/55">Rule {queue.policy?.ruleVersion} · policy {queue.policy?.policyHash} · source {queue.policy?.sourcePolicyHash} · evidence {queue.policy?.evidenceVersion} · queue {queue.queueDigest}</p>
          <p className="mt-1 text-xs text-ink/60">Source snapshot {formatDate(queue.generatedAt)} · allowed source {queue.policy?.allowedSourceIds?.join(', ') || 'not recorded'} · {queue.total} reviewable canonical opportunities.</p>
        </div>
      ) : null}

      {sourceBlocked ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800" role="alert">The deterministic evidence queue is blocked because current Sheet-only coverage is incomplete, stale, widened, empty, or warning-bearing. Do not record a decision from this snapshot.</p> : null}

      {candidate && decision && !sourceBlocked ? (
        <article className="mt-4 rounded-2xl border border-line bg-fog/35 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-moss">Candidate {queue.page} of {queue.total}</p>
              <h4 className="mt-2 text-lg font-semibold text-ink">{candidate.name}</h4>
              <p className="mt-1 break-all text-xs text-ink/60">Canonical opportunity {candidate.opportunityId}</p>
              <p className="mt-1 text-xs text-ink/60">Queue rank {candidate.queueRank}</p>
            </div>
            {exactSnapshotReviewed ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-900">Exact snapshot already reviewed</span> : candidate.currentPolicyReviewed ? <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">Changed snapshot needs review</span> : null}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-white p-3 text-xs"><strong>Source</strong><p className="mt-1 break-words text-ink/65">{candidate.sourceName || candidate.sourceId || 'Not recorded'}</p></div>
            <div className="rounded-xl border border-line bg-white p-3 text-xs"><strong>Industry / location</strong><p className="mt-1 break-words text-ink/65">{candidate.industry || 'Not recorded'} · {candidate.location || 'Not recorded'}</p></div>
            <div className="rounded-xl border border-line bg-white p-3 text-xs"><strong>Profit / asking price</strong><p className="mt-1 text-ink/65">{formatMoney(candidate.annualProfit)} · {formatMoney(candidate.askingPrice)}</p></div>
            <div className="rounded-xl border border-line bg-white p-3 text-xs"><strong>Source recipient</strong><p className="mt-1 break-all text-ink/65">{candidate.brokerName || 'Name not recorded'} · {candidate.brokerEmail || 'Address not recorded'}</p></div>
          </div>
          {safeUrl(candidate.listingUrl) ? <a className="mt-3 inline-flex text-sm font-semibold text-moss underline" href={safeUrl(candidate.listingUrl)} rel="noreferrer" target="_blank">Open the original broker listing</a> : <p className="mt-3 text-xs font-semibold text-red-800">No safe original listing URL is recorded.</p>}

          {!exactSnapshotReviewed ? (
            <div className="mt-4 space-y-4 rounded-xl border border-line bg-white p-4">
              <fieldset>
                <legend className="text-sm font-semibold text-ink">Record this opportunity’s actual review outcome</legend>
                <p className="mt-1 text-xs leading-5 text-ink/60">The system’s cohort classification is deliberately not shown here and must not influence the human decision.</p>
                <div className="mt-3 flex flex-wrap gap-4 text-sm">
                  {[['approve', 'Approve unchanged'], ['approve-edit', 'Approve with recipient edit'], ['reject', 'Reject']].map(([value, label]) => <label className="inline-flex items-center gap-2" key={value}><input checked={decision.action === value} disabled={submitting} name={`stage2-action-${candidate.opportunityId}`} onChange={() => setDecision((current) => ({ ...current, action: value }))} type="radio" value={value} />{label}</label>)}
                </div>
              </fieldset>

              {decision.action === 'approve-edit' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-ink">Final recipient address<input className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm font-normal" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, finalRecipientEmail: event.target.value }))} type="email" value={decision.finalRecipientEmail} /></label>
                  <label className="text-xs font-semibold text-ink">Final recipient name<input className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm font-normal" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, finalRecipientName: event.target.value }))} type="text" value={decision.finalRecipientName} /></label>
                  <label className="text-xs font-semibold text-ink sm:col-span-2">Attributable edit evidence (at least 20 characters)<textarea className="mt-1 min-h-20 w-full rounded-xl border border-line px-3 py-2 text-sm font-normal" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, recipientEditReason: event.target.value }))} value={decision.recipientEditReason} /></label>
                </div>
              ) : null}

              {decision.action === 'reject' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-ink">Rejection reason<select className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm font-normal" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, passReason: event.target.value }))} value={decision.passReason}>{passReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label className="text-xs font-semibold text-ink">Factual review note {decision.passReason === 'other' ? '(required)' : '(optional)'}<textarea className="mt-1 min-h-20 w-full rounded-xl border border-line px-3 py-2 text-sm font-normal" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, decisionNote: event.target.value }))} value={decision.decisionNote} /></label>
                </div>
              ) : null}

              <label className="flex items-start gap-2 text-xs leading-5 text-ink/70"><input checked={decision.reviewConfirmed} className="mt-1" disabled={submitting} onChange={(event) => setDecision((current) => ({ ...current, reviewConfirmed: event.target.checked }))} type="checkbox" />I personally checked this candidate’s Sheet source, original listing, canonical identity, and exact original/final recipient evidence. This is my explicit per-opportunity decision.</label>
              <button className="rounded-full border border-moss bg-moss px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting || !decision.reviewConfirmed || !actionComplete} onClick={() => submitDecision(candidate)} type="button">{submitting ? 'Appending decision…' : 'Record this decision (zero send)'}</button>
            </div>
          ) : null}

          <div className="mt-4 flex gap-2">
            <button className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold" disabled={loading || submitting || queue.page <= 1} onClick={() => loadQueue(queue.page - 1, { expectedQueueDigest: queue.queueDigest })} type="button">Previous in fixed order</button>
            <button className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold" disabled={loading || submitting || !queue.hasMore} onClick={() => loadQueue(queue.page + 1, { expectedQueueDigest: queue.queueDigest })} type="button">Next in fixed order</button>
          </div>
        </article>
      ) : null}
    </section>
  );
}
