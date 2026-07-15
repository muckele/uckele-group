import React from 'react';
import { BellRing, CalendarClock, ClipboardList, Inbox, MailCheck, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import Reveal from '../Reveal';
import EmailReadinessPanel from './EmailReadinessPanel';

const primaryButton = 'inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full border border-moss bg-moss px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50';
const secondaryButton = 'inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full border border-ink/10 bg-white px-4 py-2.5 text-sm font-semibold text-ink transition hover:text-moss disabled:opacity-50';

function label(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function dateTime(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'not recorded' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function money(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value) : 'Not disclosed';
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function getCimRequestPresentation(request = {}) {
  const completeStatuses = new Set(['sent', 'logged', 'follow_up_failed', 'delivery_issue']);
  const dangerStatuses = new Set(['failed', 'follow_up_failed', 'delivery_issue']);
  const warningStatuses = new Set(['pending', 'follow_up_pending']);
  const status = String(request.status || '');
  const tone = dangerStatuses.has(status)
    ? 'danger'
    : warningStatuses.has(status)
      ? 'warning'
      : status === 'responded' || completeStatuses.has(status)
        ? 'success'
        : 'info';
  const statusLabel = status === 'responded'
    ? 'Broker replied'
    : status === 'delivery_issue'
      ? 'Delivery issue'
      : status === 'follow_up_failed'
        ? 'Follow-up failed'
        : status === 'follow_up_pending'
          ? 'Follow-up pending'
          : status === 'sent'
            ? 'CIM requested'
            : status === 'logged'
              ? 'CIM logged'
              : status === 'failed'
                ? 'CIM failed'
                : status === 'pending'
                  ? 'CIM pending'
                  : request.eligible
                    ? 'CIM ready'
                    : 'CIM blocked';
  const followUpSummary = Number(request.followUpCount || 0) > 0
    ? ` ${request.followUpCount} follow-up${Number(request.followUpCount) === 1 ? '' : 's'} sent.`
    : '';
  const nextFollowUpSummary = request.nextFollowUpAt ? ` Next follow-up: ${dateTime(request.nextFollowUpAt)}.` : '';
  const description = status === 'responded'
    ? `Reply recorded ${dateTime(request.respondedAt)}.`
    : status === 'failed'
      ? `The previous send attempt failed${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}. Confirm the recipient, then retry.`
    : status === 'follow_up_pending'
      ? `A CIM follow-up send is in progress${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}.${nextFollowUpSummary}`
      : completeStatuses.has(status)
        ? `Requested ${dateTime(request.requestedAt)}${request.recipientEmail ? ` to ${request.recipientEmail}` : ''}.${followUpSummary}${nextFollowUpSummary}`
        : request.eligible
          ? `Ready to request the CIM${request.recipientEmail ? ` from ${request.recipientEmail}` : ''}.`
          : request.reason || 'No broker or contact email is available for this listing.';

  return { description, statusLabel, tone };
}

function Pill({ children, tone = 'default' }) {
  const tones = { default: 'border-ink/10 bg-white text-ink/72', success: 'border-moss/20 bg-moss/10 text-moss', warning: 'border-amber-200 bg-amber-50 text-amber-700', danger: 'border-red-200 bg-red-50 text-red-700', info: 'border-sky-200 bg-sky-50 text-sky-700' };
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] ${tones[tone]}`}>{children}</span>;
}

function SectionLabel({ children }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">{children}</p>;
}

function Stat({ icon: Icon, label: statLabel, value, tone = 'default' }) {
  const tones = { default: 'bg-moss/8 text-moss', warning: 'bg-amber-100 text-amber-700', danger: 'bg-red-100 text-red-700' };
  return <div className="panel p-4"><div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><Icon className="h-4 w-4" /></div><p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-moss/80">{statLabel}</p><p className="mt-2 text-2xl font-semibold text-ink">{value}</p></div>;
}

function DealCard({ deal, mode = 'fit', onSendCimRequest, requestingCim, readOnly }) {
  const items = mode === 'remove' ? deal.removeReasons || deal.concerns || [] : deal.strengths || [];
  const listing = safeUrl(deal.listingUrl);
  const request = deal.cimRequest || {};
  const requestPresentation = getCimRequestPresentation(request);
  const meta = [deal.industry, deal.location, deal.annualProfit ? `Profit ${money(deal.annualProfit)}` : '', deal.askingPrice ? `Ask ${money(deal.askingPrice)}` : '', deal.profitMultiple ? `${deal.profitMultiple}x profit` : ''].filter(Boolean);
  const background = mode === 'remove' ? 'border-red-200 bg-red-50 text-red-800' : mode === 'watch' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800';
  return (
    <article className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${background}`}>
      <div className="flex flex-wrap gap-2"><Pill tone={deal.score >= 70 ? 'success' : deal.score >= 55 ? 'warning' : 'danger'}>Score {deal.score}</Pill>{deal.isNew ? <Pill tone="success">New</Pill> : null}<Pill>{deal.sourceName}</Pill></div>
      <h3 className="mt-3 text-lg font-semibold leading-snug">{deal.name}</h3>
      {meta.length ? <p className="mt-2 text-sm leading-6">{meta.join(' | ')}</p> : null}
      {deal.recommendation ? <p className="mt-3 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-6">{deal.recommendation}</p> : null}
      {mode !== 'remove' && deal.score >= 75 ? (
        <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 p-4 text-sm leading-6">
          <div className="flex flex-wrap items-center gap-2"><strong>CIM request</strong><Pill tone={requestPresentation.tone}>{requestPresentation.statusLabel}</Pill></div>
          <p className="mt-2">{requestPresentation.description}</p>
          {request.deliveryError ? <p className="mt-2 text-red-700" role="alert">{request.deliveryError}</p> : null}
          {request.canRequest && onSendCimRequest && !readOnly ? <button className={`${primaryButton} mt-3 w-full`} disabled={requestingCim} onClick={() => onSendCimRequest(deal)} type="button"><Send className="h-4 w-4" />{requestingCim ? 'Sending…' : request.status === 'failed' ? 'Retry CIM Request' : 'Send CIM Request'}</button> : null}
          {request.canRequest && readOnly ? <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em]">Read-only access</p> : null}
        </div>
      ) : null}
      {items.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6">{items.slice(0, 3).map((item) => <li key={`${deal.id}-${item}`}>{item}</li>)}</ul> : null}
      {deal.questions?.length ? <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 p-4 text-sm leading-6"><strong className="uppercase tracking-[0.14em]">Questions</strong><ul className="mt-2 list-disc space-y-1 pl-5">{deal.questions.slice(0, 2).map((question) => <li key={`${deal.id}-${question}`}>{question}</li>)}</ul></div> : null}
      {listing ? <a className="mt-4 inline-flex text-sm font-semibold text-moss underline" href={listing} rel="noreferrer" target="_blank">View listing</a> : null}
    </article>
  );
}

function DealColumn({ title, deals, mode, empty, onSendCimRequest, readOnly, requestingCimDealKey }) {
  return <div><div className="mb-3 flex items-center justify-between"><SectionLabel>{title}</SectionLabel><Pill tone={mode === 'remove' ? 'danger' : mode === 'watch' ? 'warning' : 'success'}>{deals.length}</Pill></div><div className="space-y-4">{deals.slice(0, 4).map((deal) => <DealCard deal={deal} key={`${title}-${deal.sourceName}-${deal.dealKey || deal.id || deal.listingUrl}`} mode={mode} onSendCimRequest={onSendCimRequest} readOnly={readOnly} requestingCim={requestingCimDealKey === deal.dealKey} />)}{deals.length === 0 ? <p className="text-sm text-ink/68">{empty}</p> : null}</div></div>;
}

export default function DealHunterWorkspace({
  review, loading, sending, bulkSending, followUpRunning, requestingCimDealKey, feedback = {}, readOnly,
  emailTestSending, onReview, onSendReady, onRunFollowUps, onSendEmail, onSendCimRequest, onSendEmailTest,
}) {
  const busy = loading || sending || bulkSending || followUpRunning;
  const emailReadiness = review?.emailReadiness;
  const outboundReady = emailReadiness ? emailReadiness.outboundConfigured : true;
  const followUpsSafe = emailReadiness ? emailReadiness.followUpsSafe : true;
  return (
    <section className="section-shell mt-5">
      <Reveal className="panel p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between"><div><SectionLabel>Deal Hunter Scoring</SectionLabel><h2 className="mt-2 text-2xl font-semibold text-ink">Daily source review</h2><p className="mt-2 max-w-3xl text-sm leading-7 text-ink/68">Pulls configured deal sources, scores recent listings against the acquisition profile, and manages CIM outreach.</p></div><div className="flex flex-wrap gap-2"><button className={secondaryButton} disabled={busy} onClick={onReview} type="button"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Reviewing…' : 'Review Sources'}</button>{!readOnly ? <><button className={primaryButton} disabled={busy || !outboundReady} onClick={onSendReady} type="button"><Send className="h-4 w-4" />{bulkSending ? 'Sending CIMs…' : 'Send CIM Requests'}</button><button className={secondaryButton} disabled={busy || !followUpsSafe} onClick={onRunFollowUps} type="button"><MailCheck className="h-4 w-4" />{followUpRunning ? 'Checking…' : followUpsSafe ? 'Run Follow-Ups' : 'Follow-Ups Paused'}</button><button className={secondaryButton} disabled={busy || !outboundReady} onClick={onSendEmail} type="button"><Send className="h-4 w-4" />{sending ? 'Sending…' : 'Send Daily Email'}</button></> : null}</div></div>
        {feedback.error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{feedback.error}</p> : null}{feedback.message ? <p className="mt-5 rounded-2xl border border-moss/20 bg-moss/8 p-4 text-sm text-moss" role="status">{feedback.message}</p> : null}
        {review ? <div className="mt-7 space-y-7"><EmailReadinessPanel data={emailReadiness} onSendTest={readOnly ? undefined : onSendEmailTest} testSending={emailTestSending} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-7"><Stat icon={ClipboardList} label="Reviewed" value={review.totals?.reviewedDeals || 0} /><Stat icon={BellRing} label="New Fits" value={review.totals?.newMatches || 0} tone="warning" /><Stat icon={MailCheck} label="High Fit" value={review.totals?.qualified || 0} tone="warning" /><Stat icon={Send} label="CIM Ready" value={review.totals?.cimReady || 0} tone="warning" /><Stat icon={Inbox} label="Watchlist" value={review.totals?.watchlist || 0} /><Stat icon={ShieldAlert} label="Remove" value={review.totals?.removalCandidates || 0} tone="danger" /><Stat icon={CalendarClock} label="Lookback" value={`${review.lookbackDays || 0}d`} /></div>
          {review.dailyEmailJob ? <div className="rounded-2xl border border-line bg-fog/70 p-4 text-sm text-ink/72"><p><strong>Today&apos;s daily email:</strong> {label(review.dailyEmailJob.status)} · attempt {review.dailyEmailJob.attempt_count || 1}{review.dailyEmailJob.completed_at ? ` · completed ${dateTime(review.dailyEmailJob.completed_at)}` : ''}</p>{review.dailyEmailJob.last_error ? <p className="mt-2 text-red-700">{review.dailyEmailJob.last_error}</p> : null}</div> : null}
          <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border border-line bg-fog/70 p-5"><SectionLabel>Sources</SectionLabel><div className="mt-4 space-y-3">{(review.sources || []).map((source) => <div className="rounded-2xl border border-line bg-white/75 p-4 text-sm" key={source.id}><div className="flex flex-wrap gap-2"><strong>{source.name}</strong><Pill tone={source.fetched ? 'success' : 'danger'}>{source.fetched ? `${source.rowCount || 0} rows` : 'failed'}</Pill><Pill>{source.mode}</Pill></div>{source.error ? <p className="mt-2 text-red-700">{source.error}</p> : null}</div>)}</div></div><div className="rounded-2xl border border-line bg-white/70 p-5"><SectionLabel>Criteria Notes</SectionLabel>{review.criteriaRecommendations?.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-ink/74">{review.criteriaRecommendations.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-4 text-sm text-ink/68">No criteria changes recommended.</p>}</div></div>
          {review.newlySeenMatches?.length ? <div><div className="mb-3 flex justify-between"><SectionLabel>Newly Seen Fits</SectionLabel><Pill tone="success">{review.newlySeenMatches.length}</Pill></div><div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{review.newlySeenMatches.slice(0, 6).map((deal) => <DealCard deal={deal} key={`new-${deal.dealKey}`} onSendCimRequest={onSendCimRequest} readOnly={readOnly} requestingCim={requestingCimDealKey === deal.dealKey} />)}</div></div> : null}
          <div className="grid gap-5 xl:grid-cols-3"><DealColumn deals={review.qualified || []} empty="No high-fit recent listings found." onSendCimRequest={onSendCimRequest} readOnly={readOnly} requestingCimDealKey={requestingCimDealKey} title="High Fit" /><DealColumn deals={review.watchlist || []} empty="No watchlist listings found." mode="watch" onSendCimRequest={onSendCimRequest} readOnly={readOnly} requestingCimDealKey={requestingCimDealKey} title="Watchlist" /><DealColumn deals={review.removalCandidates || []} empty="No removal candidates found." mode="remove" title="Remove" /></div></div> : <p className="mt-6 rounded-2xl border border-line bg-fog/70 p-4 text-sm text-ink/70">No source review loaded yet. Review sources before sending CIM requests.</p>}
      </Reveal>
    </section>
  );
}
