import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, CalendarClock, ClipboardList, ExternalLink, Inbox, MailCheck, RefreshCw, Send, ShieldAlert, X } from 'lucide-react';
import Reveal from '../Reveal';
import EmailReadinessPanel from './EmailReadinessPanel';
import CommunicationLifecycleBadge from './CommunicationLifecycleBadge';

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
  const status = String(request.status || '');
  const requestState = String(request.requestState || '').replace(/_/g, '-');
  const deliveryState = String(request.deliveryState || '').replace(/_/g, '-');
  const dangerStates = new Set(['bounced', 'failed', 'complained', 'suppressed']);
  const tone = dangerStates.has(deliveryState) || ['failed', 'follow_up_failed', 'delivery_issue'].includes(status)
    ? 'danger'
    : deliveryState === 'delayed' || ['pending', 'follow_up_pending'].includes(status)
      ? 'warning'
      : deliveryState === 'delivered' || requestState === 'responded'
        ? 'success'
        : 'info';
  const statusLabel = requestState === 'responded' || status === 'responded'
    ? 'Broker replied'
    : deliveryState === 'development-only' || requestState === 'development-only' || status === 'logged'
      ? 'Development only'
      : deliveryState === 'delivered'
        ? 'Delivered'
        : deliveryState === 'accepted'
          ? 'Awaiting delivery'
          : deliveryState === 'delayed'
            ? 'Delivery delayed'
            : dangerStates.has(deliveryState) || status === 'delivery_issue'
      ? 'Delivery issue'
      : status === 'follow_up_failed'
        ? 'Follow-up failed'
        : status === 'follow_up_pending'
          ? 'Follow-up pending'
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
  const description = requestState === 'responded' || status === 'responded'
    ? `Reply recorded ${dateTime(request.respondedAt)}.`
    : deliveryState === 'development-only' || requestState === 'development-only' || status === 'logged'
      ? `Development-only console copy logged ${dateTime(request.requestedAt)}. No live delivery occurred.`
    : deliveryState === 'delivered'
      ? `Delivered ${dateTime(request.deliveredAt)}${request.recipientEmail ? ` to ${request.recipientEmail}` : ''}.${followUpSummary}${nextFollowUpSummary}`
    : deliveryState === 'accepted'
      ? `Accepted by the email provider ${dateTime(request.firstProviderAcceptedAt || request.requestedAt)}; recipient mail-server delivery is not yet confirmed.${nextFollowUpSummary}`
    : deliveryState === 'delayed'
      ? `The provider reported a delivery delay${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}.${nextFollowUpSummary}`
    : dangerStates.has(deliveryState) || status === 'delivery_issue'
      ? `Delivery ${deliveryState || 'issue'}${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}. Use the corrected-recipient workflow before retrying.`
    : status === 'failed'
      ? `The previous send attempt failed${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}. Confirm the recipient, then retry.`
    : status === 'follow_up_pending'
      ? `A CIM follow-up send is in progress${request.recipientEmail ? ` for ${request.recipientEmail}` : ''}.${nextFollowUpSummary}`
      : ['sent', 'follow_up_failed'].includes(status)
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

function DealSourceStatus({ source }) {
  const listingUrlCount = Number(source.listingUrlCount || 0);
  const listingUrlExpectedCount = Number(source.listingUrlExpectedCount || 0);
  const listingUrlCoverage = listingUrlExpectedCount > 0 ? Math.round((listingUrlCount / listingUrlExpectedCount) * 100) : 0;
  const setupRequired = Boolean(source.requiresConfiguration || source.configurationKey);
  const sourceTone = source.fetched ? 'success' : setupRequired ? 'warning' : 'danger';
  const sourceStatus = source.fetched ? `${source.rowCount || 0} rows` : setupRequired ? 'setup needed' : 'failed';

  return (
    <div className="rounded-2xl border border-line bg-white/75 p-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <strong>{source.name}</strong>
        <Pill tone={sourceTone}>{sourceStatus}</Pill>
        <Pill>{source.mode}</Pill>
      </div>
      {listingUrlExpectedCount > 0 ? <p className="mt-2 text-ink/65">{listingUrlCount} of {listingUrlExpectedCount} original listing links available ({listingUrlCoverage}%).</p> : listingUrlCount > 0 ? <p className="mt-2 text-ink/65">{listingUrlCount} original listing link{listingUrlCount === 1 ? '' : 's'} available.</p> : null}
      {source.error ? <p className={`mt-2 ${setupRequired ? 'text-amber-800' : 'text-red-700'}`}>{source.error}</p> : null}
      {setupRequired && source.configurationKey ? <p className="mt-2 text-xs font-semibold uppercase tracking-[0.1em] text-amber-800">Required setting: <code>{source.configurationKey}</code></p> : null}
      {source.listingUrlWarning ? <p className="mt-2 text-amber-800">Listing-link import warning: {source.listingUrlWarning}</p> : null}
    </div>
  );
}

function Stat({ icon: Icon, label: statLabel, value, tone = 'default' }) {
  const tones = { default: 'bg-moss/8 text-moss', warning: 'bg-amber-100 text-amber-700', danger: 'bg-red-100 text-red-700' };
  return <div className="panel p-4"><div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><Icon className="h-4 w-4" /></div><p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-moss/80">{statLabel}</p><p className="mt-2 text-2xl font-semibold text-ink">{value}</p></div>;
}

function ReviewNoteList({ empty, items = [] }) {
  return items.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-ink/75">{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p className="mt-3 text-sm leading-6 text-ink/60">{empty}</p>;
}

function OpportunityReview({ deal, onClose }) {
  const listing = safeUrl(deal.listingUrl);
  const brokerContactSummary = deal.brokerContacts?.length > 1
    ? deal.brokerContacts.map(contactLabel).join('\n')
    : deal.brokerEmail;
  const details = [
    ['Industry', deal.industry],
    ['Location', deal.location],
    ['Annual profit', Number.isFinite(deal.annualProfit) ? money(deal.annualProfit) : 'Not disclosed'],
    ['Annual revenue', Number.isFinite(deal.annualRevenue) ? money(deal.annualRevenue) : 'Not disclosed'],
    ['Asking price', Number.isFinite(deal.askingPrice) ? money(deal.askingPrice) : 'Not disclosed'],
    ['Profit multiple', Number.isFinite(deal.profitMultiple) ? `${deal.profitMultiple}x` : 'Not disclosed'],
    ['Years established', Number.isFinite(deal.yearsEstablished) ? deal.yearsEstablished : 'Not disclosed'],
    ['Broker', deal.brokerName || deal.brokerCompany],
    [deal.brokerContacts?.length > 1 ? 'Broker contacts' : 'Broker email', brokerContactSummary],
    ['Broker contact', deal.brokerContact],
    ['First seen', deal.firstSeenAt ? dateTime(deal.firstSeenAt) : 'Not recorded'],
    ['Last reviewed', deal.lastSeenAt ? dateTime(deal.lastSeenAt) : 'Not recorded'],
  ].filter(([, value]) => value);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div aria-labelledby="opportunity-review-title" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" role="dialog">
      <button aria-label="Close review backdrop" className="absolute inset-0 cursor-default" onClick={onClose} type="button" />
      <article className="relative z-10 max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl border border-line bg-parchment shadow-2xl sm:max-h-[90vh] sm:rounded-3xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-parchment px-5 py-4 shadow-[0_1px_0_rgba(255,255,255,0.7)] sm:px-7">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2"><Pill tone={deal.score >= 70 ? 'success' : deal.score >= 55 ? 'warning' : 'danger'}>Score {deal.score}</Pill>{deal.isNew ? <Pill tone="success">New</Pill> : null}<Pill>{deal.sourceName}</Pill></div>
            <h2 className="mt-3 text-xl font-semibold leading-snug text-ink sm:text-2xl" id="opportunity-review-title">{deal.name}</h2>
          </div>
          <button aria-label="Close opportunity review" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:text-moss" onClick={onClose} type="button"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-6 px-5 py-6 sm:px-7 sm:py-7">
          <section>
            <SectionLabel>Review notes</SectionLabel>
            <p className="mt-3 rounded-2xl border border-moss/15 bg-white px-4 py-3 text-sm leading-7 text-ink/78">{deal.recommendation || 'No overall recommendation was recorded in this review.'}</p>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {details.map(([detailLabel, value]) => <div className="rounded-2xl border border-line bg-white p-4" key={detailLabel}><p className="text-xs font-semibold uppercase tracking-[0.12em] text-moss/80">{detailLabel}</p><p className="mt-2 whitespace-pre-line break-words text-sm leading-6 text-ink">{value}</p></div>)}
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-2xl border border-moss/15 bg-moss/5 p-5">
              <h3 className="font-semibold text-ink">Why it scored</h3>
              <ReviewNoteList empty="No strengths were recorded in this review." items={deal.strengths} />
            </section>
            <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
              <h3 className="font-semibold text-ink">Concerns to validate</h3>
              <ReviewNoteList empty="No concerns were recorded in this review." items={deal.concerns?.length ? deal.concerns : deal.removeReasons} />
            </section>
          </div>

          <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-5">
            <h3 className="font-semibold text-ink">Questions for the broker or seller</h3>
            <ReviewNoteList empty="No diligence questions were generated in this review." items={deal.questions} />
          </section>

          <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-ink/60">{listing ? 'Open the source page in a new tab without exposing the full URL.' : 'No safe listing URL was supplied by the source sheet.'}</p>
            {listing ? <a className={primaryButton} href={listing} rel="noreferrer" target="_blank"><ExternalLink className="h-4 w-4" />View original listing</a> : <span className="text-sm font-semibold text-ink/55">Original broker listing unavailable</span>}
          </div>
        </div>
      </article>
    </div>
  );
}

function DealCard({ deal, mode = 'fit', onOpenDeal, onSendCimRequest, requestingCim, readOnly, outreachDisabled = false, onRecordCimOutcome, responseOutcome = '', onDismissDeal, dismissing = false }) {
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState(mode === 'remove' ? 'not-a-fit' : 'unavailable');
  const [dismissNote, setDismissNote] = useState('');
  const items = mode === 'remove' ? deal.removeReasons || deal.concerns || [] : deal.strengths || [];
  const listing = safeUrl(deal.listingUrl);
  const request = deal.cimRequest || {};
  const requestPresentation = getCimRequestPresentation(request);
  const outreachCardEligible = mode !== 'remove' && deal.score >= 75;
  const meta = [deal.industry, deal.location, deal.annualProfit ? `Profit ${money(deal.annualProfit)}` : '', deal.askingPrice ? `Ask ${money(deal.askingPrice)}` : '', deal.profitMultiple ? `${deal.profitMultiple}x profit` : ''].filter(Boolean);
  const background = mode === 'remove' ? 'border-red-200 bg-red-50 text-red-800' : mode === 'watch' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800';
  return (
    <article className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${background}`}>
      <div className="flex flex-wrap gap-2"><Pill tone={deal.score >= 70 ? 'success' : deal.score >= 55 ? 'warning' : 'danger'}>Score {deal.score}</Pill>{deal.isNew ? <Pill tone="success">New</Pill> : null}<Pill>{deal.sourceName}</Pill></div>
      <h3 className="mt-3 text-lg font-semibold leading-snug"><button className="text-left underline decoration-current/30 underline-offset-4 transition hover:text-moss" onClick={() => onOpenDeal?.(deal)} type="button">{deal.name}</button></h3>
      {meta.length ? <p className="mt-2 text-sm leading-6">{meta.join(' | ')}</p> : null}
      {deal.recommendation ? <p className="mt-3 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-6">{deal.recommendation}</p> : null}
      <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 p-4 text-sm leading-6">
          <div className="flex flex-wrap items-center gap-2"><strong>CIM request</strong>{request.requestState || request.deliveryState ? <CommunicationLifecycleBadge deliveryState={request.deliveryState} developmentOnly={request.deliveryState === 'development-only'} replied={request.requestState === 'responded'} requestState={request.requestState || request.status} /> : <Pill tone={requestPresentation.tone}>{requestPresentation.statusLabel}</Pill>}</div>
          <p className="mt-2">{requestPresentation.description}</p>
          {request.deliveryError ? <p className="mt-2 text-red-700" role="alert">{request.deliveryError}</p> : null}
          {outreachCardEligible && request.canRequest && request.status === 'failed' && onSendCimRequest && !readOnly ? <button className={`${primaryButton} mt-3 w-full`} disabled={requestingCim || outreachDisabled} onClick={() => onSendCimRequest(deal)} type="button"><Send className="h-4 w-4" />{requestingCim ? 'Sending…' : 'Retry CIM Request'}</button> : null}
          {outreachCardEligible && request.canRequest && outreachDisabled && !readOnly ? <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em]">Complete the source review before outreach</p> : outreachCardEligible && request.canRequest && request.status === 'ready' && !readOnly ? <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em]">Approval queue required</p> : null}
          {request.canRequest && readOnly ? <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em]">Read-only access</p> : null}
          {request.status === 'responded' && !readOnly ? <div className="mt-3"><p className="text-xs font-semibold uppercase tracking-[0.12em]">Response outcome {responseOutcome ? `· ${responseOutcome}` : ''}</p><div className="mt-2 flex flex-wrap gap-2">{['positive', 'neutral', 'negative'].map((outcome) => <button className={responseOutcome === outcome ? primaryButton : secondaryButton} key={outcome} onClick={() => onRecordCimOutcome?.(deal, outcome)} type="button">{label(outcome)}</button>)}</div></div> : null}
          <div className="mt-3 flex flex-wrap gap-3 text-sm font-semibold"><a className="text-moss underline" href="#cim-request-history-heading">Open CIM history</a>{request.submissionId ? <a className="text-moss underline" href={`/admin/crm/${encodeURIComponent(request.submissionId)}`}>Open CRM communications</a> : null}</div>
      </div>
      {items.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6">{items.slice(0, 3).map((item) => <li key={`${deal.id}-${item}`}>{item}</li>)}</ul> : null}
      {deal.questions?.length ? <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 p-4 text-sm leading-6"><strong className="uppercase tracking-[0.14em]">Questions</strong><ul className="mt-2 list-disc space-y-1 pl-5">{deal.questions.slice(0, 2).map((question) => <li key={`${deal.id}-${question}`}>{question}</li>)}</ul></div> : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2"><button className="inline-flex text-sm font-semibold text-moss underline" onClick={() => onOpenDeal?.(deal)} type="button">View opportunity review</button>{listing ? <a className="inline-flex items-center gap-1.5 text-sm font-semibold text-moss underline" href={listing} rel="noreferrer" target="_blank">Original broker listing<ExternalLink className="h-3.5 w-3.5" /></a> : null}{!readOnly && onDismissDeal ? <button className="inline-flex text-sm font-semibold text-red-700 underline" onClick={() => setDismissOpen((current) => !current)} type="button">{dismissOpen ? 'Cancel dismissal' : 'Pass & Dismiss'}</button> : null}</div>
      {dismissOpen && !readOnly ? <form className="mt-4 rounded-2xl border border-red-200 bg-white/80 p-4" onSubmit={(event) => { event.preventDefault(); onDismissDeal?.(deal, { reason: dismissReason, note: dismissNote }); }}><p className="text-sm font-semibold text-ink">Dismiss this Deal Hunter opportunity</p><label className="mt-3 block text-sm font-semibold text-ink">Disposition reason<select className="form-control mt-1.5" disabled={dismissing} onChange={(event) => setDismissReason(event.target.value)} value={dismissReason}><option value="not-a-fit">Not a fit</option><option value="unavailable">Unavailable</option><option value="duplicate">Duplicate</option><option value="broker-declined">Broker declined</option><option value="valuation">Valuation</option><option value="geography">Geography</option><option value="timing">Timing</option><option value="financing">Financing</option><option value="other">Other</option></select></label><label className="mt-3 block text-sm font-semibold text-ink">Optional note<textarea className="form-control mt-1.5 min-h-24" disabled={dismissing} maxLength={2000} onChange={(event) => setDismissNote(event.target.value)} value={dismissNote} /></label><button className={`${primaryButton} mt-3 w-full`} disabled={dismissing} type="submit">{dismissing ? 'Dismissing…' : 'Confirm Pass & Dismiss'}</button></form> : null}
    </article>
  );
}

function DealColumn({ title, deals, mode, empty, onOpenDeal, onSendCimRequest, readOnly, outreachDisabled, requestingCimDealKey, onRecordCimOutcome, responseOutcomes = {}, onDismissDeal, dismissingDealKey }) {
  return <div><div className="mb-3 flex items-center justify-between"><SectionLabel>{title}</SectionLabel><Pill tone={mode === 'remove' ? 'danger' : mode === 'watch' ? 'warning' : 'success'}>{deals.length}</Pill></div><div className="space-y-4">{deals.slice(0, 4).map((deal) => <DealCard deal={deal} dismissing={dismissingDealKey === deal.dealKey} key={`${title}-${deal.sourceName}-${deal.dealKey || deal.id || deal.listingUrl}`} mode={mode} onDismissDeal={onDismissDeal} onOpenDeal={onOpenDeal} onRecordCimOutcome={onRecordCimOutcome} onSendCimRequest={onSendCimRequest} outreachDisabled={outreachDisabled} readOnly={readOnly} requestingCim={requestingCimDealKey === deal.dealKey} responseOutcome={responseOutcomes[deal.dealKey]} />)}{deals.length === 0 ? <p className="text-sm text-ink/68">{empty}</p> : null}</div></div>;
}

function cimReadyDeals(review) {
  const seen = new Set();
  const ready = [];

  for (const deal of [...(review?.qualified || []), ...(review?.newlySeenMatches || []), ...(review?.watchlist || [])]) {
    const recipientEmail = deal?.cimRequest?.recipientEmail || deal?.brokerEmail || '';
    const key = `${deal?.dealKey || ''}|${recipientEmail.toLowerCase()}`;
    if (!deal?.dealKey || !deal?.cimRequest?.canRequest || !recipientEmail || seen.has(key)) continue;
    seen.add(key);
    ready.push(deal);
  }

  return ready;
}

function contactLabel(contact = {}) {
  return [contact.name, contact.role, contact.email, contact.sourceColumn ? `Sheet: ${contact.sourceColumn}` : ''].filter(Boolean).join(' · ');
}

function previewForDecision(deal, decision = {}) {
  const selected = (deal.cimRequest?.contactPreviews || []).find((preview) => preview.email === decision.recipientEmail);
  if (selected) return selected;
  const base = deal.cimRequest?.preview;
  if (!base?.text) return base;
  const greeting = `Hello${decision.recipientName ? ` ${decision.recipientName}` : ''},`;
  return { ...base, text: base.text.replace(/^Hello[^\n]*,/i, greeting) };
}

function CimApprovalQueue({ review, readOnly, actionsDisabled = false, sending, onOpenDeal, onSendApproved }) {
  const deals = useMemo(() => cimReadyDeals(review), [review]);
  const [decisions, setDecisions] = useState({});

  useEffect(() => {
    setDecisions(Object.fromEntries(deals.map((deal) => [deal.dealKey, {
      decision: 'pending',
      recipientEmail: deal.cimRequest?.recipientEmail || deal.brokerEmail || '',
      recipientName: deal.brokerContacts?.find((contact) => contact.email === (deal.cimRequest?.recipientEmail || deal.brokerEmail))?.name || deal.brokerName || '',
      passReason: '',
    }])));
  }, [deals]);

  const approvedDeals = deals
    .filter((deal) => decisions[deal.dealKey]?.decision === 'approved')
    .map((deal) => ({
      ...deal,
      confirmedRecipientEmail: String(decisions[deal.dealKey]?.recipientEmail || '').trim().toLowerCase(),
      confirmedRecipientName: String(decisions[deal.dealKey]?.recipientName || '').trim(),
    }));
  const invalidCount = approvedDeals.filter((deal) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deal.confirmedRecipientEmail)).length;
  const pendingCount = deals.filter((deal) => !['approved', 'rejected'].includes(decisions[deal.dealKey]?.decision)).length;
  const missingPassReasonCount = deals.filter((deal) => decisions[deal.dealKey]?.decision === 'rejected' && !decisions[deal.dealKey]?.passReason).length;
  const actionsBlocked = readOnly || actionsDisabled;

  if (deals.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5" id="cim-approvals">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <SectionLabel>CIM Approval Queue</SectionLabel>
          <h3 className="mt-2 text-xl font-semibold text-ink">Review first-contact broker emails</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/70">Approve only the businesses you want to contact today, correct any broker address, and pass on the rest for this run. The server revalidates every deal before sending.</p>
          {actionsDisabled ? <p className="mt-2 text-sm font-semibold text-amber-900" role="status">Complete a successful source review before approving or sending CIM requests.</p> : null}
        </div>
        <div className="flex flex-wrap gap-2"><Pill tone="warning">{approvedDeals.length} approved</Pill><Pill>{pendingCount} pending</Pill></div>
      </div>
      <div className="mt-5 space-y-3">
        {deals.map((deal) => {
          const decision = decisions[deal.dealKey] || { decision: 'pending', recipientEmail: deal.brokerEmail || '', recipientName: deal.brokerName || '', passReason: '' };
          const contacts = deal.brokerContacts || [];
          const selectedContact = contacts.find((contact) => contact.email === decision.recipientEmail);
          const emailPreview = previewForDecision(deal, decision);
          return (
            <article className="rounded-2xl border border-line bg-white/90 p-4" key={`approval-${deal.dealKey}`}>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2"><Pill tone="success">Score {deal.score}</Pill>{deal.annualProfit ? <Pill>{money(deal.annualProfit)} profit</Pill> : null}</div>
                  <h4 className="mt-2 font-semibold leading-6 text-ink"><button className="text-left underline decoration-ink/25 underline-offset-4 transition hover:text-moss" onClick={() => onOpenDeal?.(deal)} type="button">{deal.name}</button></h4>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1"><button className="inline-flex text-sm font-semibold text-moss underline" onClick={() => onOpenDeal?.(deal)} type="button">View opportunity review</button>{safeUrl(deal.listingUrl) ? <a className="inline-flex items-center gap-1.5 text-sm font-semibold text-moss underline" href={safeUrl(deal.listingUrl)} rel="noreferrer" target="_blank">Original broker listing<ExternalLink className="h-3.5 w-3.5" /></a> : null}</div>
                </div>
                <div className="text-sm font-semibold text-ink">
                  <p>Broker recipient</p>
                  {contacts.length > 1 ? (
                    <select
                      aria-label={`Broker contact for ${deal.name}`}
                      className="mt-1.5 w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-normal text-ink disabled:bg-fog"
                      disabled={actionsBlocked || decision.decision !== 'approved' || sending}
                      onChange={(event) => {
                        const contact = contacts.find((candidate) => candidate.email === event.target.value);
                        setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, recipientEmail: contact?.email || '', recipientName: contact?.name || '' } }));
                      }}
                      value={selectedContact?.email || ''}
                    >
                      {contacts.map((contact) => <option key={contact.email} value={contact.email}>{contactLabel(contact)}</option>)}
                      <option value="">Enter another address</option>
                    </select>
                  ) : null}
                  <input
                    aria-label={`Broker recipient for ${deal.name}`}
                    className={`${contacts.length > 1 ? 'mt-2' : 'mt-1.5'} w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-normal text-ink disabled:bg-fog`}
                    disabled={actionsBlocked || decision.decision !== 'approved' || sending}
                    onChange={(event) => {
                      const contact = contacts.find((candidate) => candidate.email === event.target.value.trim().toLowerCase());
                      setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, recipientEmail: event.target.value, recipientName: contact?.name || '' } }));
                    }}
                    type="email"
                    value={decision.recipientEmail}
                  />
                  {decision.decision === 'approved' ? (
                    <span className="mt-2 block">
                      <span className="block text-xs uppercase tracking-[0.1em] text-ink/60">Recipient name for greeting</span>
                      <input
                        aria-label={`Broker recipient name for ${deal.name}`}
                        className="mt-1 w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-normal text-ink disabled:bg-fog"
                        disabled={actionsBlocked || sending}
                        onChange={(event) => setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, recipientName: event.target.value } }))}
                        placeholder="Optional"
                        type="text"
                        value={decision.recipientName}
                      />
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={decision.decision === 'approved' ? primaryButton : secondaryButton} disabled={actionsBlocked || sending} onClick={() => setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, decision: 'approved' } }))} type="button">Approve</button>
                  <button className={decision.decision === 'rejected' ? primaryButton : secondaryButton} disabled={actionsBlocked || sending} onClick={() => setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, decision: 'rejected' } }))} type="button">Pass</button>
                </div>
              </div>
              {decision.decision === 'rejected' ? (
                <label className="mt-3 block text-sm font-semibold text-ink">
                  Pass reason
                  <select className="mt-1.5 w-full rounded-xl border border-ink/15 bg-white px-3 py-2.5 font-normal sm:max-w-sm" disabled={actionsBlocked || sending} onChange={(event) => setDecisions((current) => ({ ...current, [deal.dealKey]: { ...decision, passReason: event.target.value } }))} value={decision.passReason}>
                    <option value="industry">Industry fit</option><option value="geography">Geography</option><option value="valuation">Valuation / multiple</option><option value="profit">Profit outside target</option><option value="owner-dependence">Owner dependence</option><option value="duplicate">Duplicate listing</option><option value="recipient">Incorrect recipient</option><option value="financing">Financing fit</option><option value="quality">Listing quality</option><option value="timing">Timing</option><option value="other">Other</option>
                  </select>
                </label>
              ) : null}
              {emailPreview?.text ? (
                <details className="mt-3 rounded-xl border border-line bg-fog/55 p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-ink">Preview exact broker email</summary>
                  <p className="mt-3 text-sm font-semibold text-ink">Subject: {emailPreview.subject}</p>
                  <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-6 text-ink/75">{emailPreview.text}</pre>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
      {!readOnly ? (
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink/68">{actionsDisabled ? 'Outreach stays paused while any source is unavailable.' : `This final action sends ${approvedDeals.length} first-contact email${approvedDeals.length === 1 ? '' : 's'} and starts their follow-up sequences.`}</p>
          <button className={primaryButton} disabled={actionsDisabled || sending || invalidCount > 0 || pendingCount > 0 || missingPassReasonCount > 0} onClick={() => onSendApproved(approvedDeals, deals.map((deal) => ({ dealKey: deal.dealKey, snapshotToken: deal.cimRequest?.snapshotToken || '', decision: decisions[deal.dealKey]?.decision, passReason: decisions[deal.dealKey]?.passReason || '', finalRecipientEmail: decisions[deal.dealKey]?.recipientEmail || deal.brokerEmail || '', finalRecipientName: decisions[deal.dealKey]?.recipientName || '' })))} type="button"><Send className="h-4 w-4" />{sending ? 'Saving review…' : approvedDeals.length > 0 ? `Send ${approvedDeals.length} Approved` : 'Save Review'}</button>
        </div>
      ) : <p className="mt-4 text-sm font-semibold text-ink/68">Read-only users cannot approve or send CIM requests.</p>}
      {invalidCount > 0 ? <p className="mt-3 text-sm text-red-700" role="alert">Correct {invalidCount} invalid broker email address{invalidCount === 1 ? '' : 'es'} before sending.</p> : null}
      {pendingCount > 0 ? <p className="mt-3 text-sm text-amber-800" role="status">Review all {pendingCount} pending request{pendingCount === 1 ? '' : 's'} before saving.</p> : null}
      {missingPassReasonCount > 0 ? <p className="mt-3 text-sm text-red-700" role="alert">Select a pass reason for every rejected request.</p> : null}
    </section>
  );
}

export default function DealHunterWorkspace({
  review, loading, sending, bulkSending, followUpRunning, requestingCimDealKey, dismissingDealKey, feedback = {}, readOnly,
  emailTestSending, onReview, onOpenApprovals, onSendReady, onRunFollowUps, onSendEmail, onSendCimRequest, onSendEmailTest, onRecordCimOutcome, onDismissDeal,
}) {
  const [selectedDeal, setSelectedDeal] = useState(null);
  const busy = loading || sending || bulkSending || followUpRunning;
  const emailReadiness = review?.emailReadiness;
  const outboundReady = emailReadiness ? emailReadiness.outboundConfigured : true;
  const followUpsSafe = emailReadiness ? emailReadiness.followUpsSafe : true;
  const unavailableSources = (review?.sources || []).filter((source) => !source.fetched);
  const sourceReviewComplete = unavailableSources.length === 0;
  return (
    <section className="section-shell mt-5">
      <Reveal className="panel p-5 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between"><div><SectionLabel>Deal Hunter Scoring</SectionLabel><h2 className="mt-2 text-2xl font-semibold text-ink">Daily source review</h2><p className="mt-2 max-w-3xl text-sm leading-7 text-ink/68">Pulls configured deal sources, scores recent listings against the acquisition profile, and manages CIM outreach.</p></div><div className="flex flex-wrap gap-2"><button className={secondaryButton} disabled={busy} onClick={onReview} type="button"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Reviewing…' : 'Review Sources'}</button>{!readOnly ? <><button className={primaryButton} disabled={busy || !outboundReady || !sourceReviewComplete || !review?.totals?.cimReady} onClick={onOpenApprovals} type="button"><ClipboardList className="h-4 w-4" />Review CIM Requests</button><button className={secondaryButton} disabled={busy || !followUpsSafe} onClick={onRunFollowUps} type="button"><MailCheck className="h-4 w-4" />{followUpRunning ? 'Checking…' : followUpsSafe ? 'Run Follow-Ups' : 'Follow-Ups Paused'}</button><button className={secondaryButton} disabled={busy || !outboundReady || !sourceReviewComplete} onClick={onSendEmail} type="button"><Send className="h-4 w-4" />{sending ? 'Sending…' : 'Send Daily Email'}</button></> : null}</div></div>
        {feedback.error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{feedback.error}</p> : null}{feedback.message ? <p className="mt-5 rounded-2xl border border-moss/20 bg-moss/8 p-4 text-sm text-moss" role="status">{feedback.message}</p> : null}
        {review ? <div className="mt-7 space-y-7">{unavailableSources.length > 0 ? <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900" role="alert"><strong>Partial review.</strong> {unavailableSources.map((source) => source.name).join(', ')} {unavailableSources.length === 1 ? 'is' : 'are'} unavailable, so totals and candidates cover only successfully imported sources. Daily email, CRM sync, and new CIM outreach are paused until every source succeeds.</p> : null}<CimApprovalQueue actionsDisabled={!sourceReviewComplete} onOpenDeal={setSelectedDeal} onSendApproved={onSendReady} readOnly={readOnly} review={review} sending={bulkSending} />{review.cimAutomation ? <section className="rounded-2xl border border-line bg-fog/70 p-5"><div className="flex flex-wrap items-center gap-2"><strong>CIM automation</strong><Pill tone={review.cimAutomation.paused ? 'danger' : 'info'}>Stage {review.cimAutomation.effectiveStage || 1}{review.cimAutomation.paused ? ' paused' : ''}</Pill><Pill>{review.cimAutomation.metrics?.reviewed || 0} reviewed</Pill><Pill>{review.cimAutomation.metrics?.approvalRate || 0}% approved</Pill></div>{review.cimAutomation.run?.exceptions?.length ? <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-ink">{review.cimAutomation.run.exceptions.length} automation exception(s) require review</summary><ul className="mt-3 space-y-2 text-sm text-ink/70">{review.cimAutomation.run.exceptions.slice(0, 25).map((item) => <li className="rounded-xl border border-line bg-white p-3" key={`exception-${item.dealKey}`}><strong>{item.name}</strong><p className="mt-1">{item.reasons.join(' · ')}</p></li>)}</ul></details> : null}</section> : null}<EmailReadinessPanel data={emailReadiness} onSendTest={readOnly ? undefined : onSendEmailTest} testSending={emailTestSending} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-7"><Stat icon={ClipboardList} label="Reviewed" value={review.totals?.reviewedDeals || 0} /><Stat icon={BellRing} label="New Fits" value={review.totals?.newMatches || 0} tone="warning" /><Stat icon={MailCheck} label="High Fit" value={review.totals?.qualified || 0} tone="warning" /><Stat icon={Send} label="CIM Ready" value={review.totals?.cimReady || 0} tone="warning" /><Stat icon={Inbox} label="Watchlist" value={review.totals?.watchlist || 0} /><Stat icon={ShieldAlert} label="Remove" value={review.totals?.removalCandidates || 0} tone="danger" /><Stat icon={CalendarClock} label="Lookback" value={`${review.lookbackDays || 0}d`} /></div>
          {review.dailyEmailJob ? <div className="rounded-2xl border border-line bg-fog/70 p-4 text-sm text-ink/72"><p><strong>Today&apos;s daily email:</strong> {label(review.dailyEmailJob.status)} · attempt {review.dailyEmailJob.attempt_count || 1}{review.dailyEmailJob.completed_at ? ` · completed ${dateTime(review.dailyEmailJob.completed_at)}` : ''}</p>{review.dailyEmailJob.last_error ? <p className="mt-2 text-red-700">{review.dailyEmailJob.last_error}</p> : null}</div> : null}
          <div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border border-line bg-fog/70 p-5"><SectionLabel>Sources</SectionLabel><div className="mt-4 space-y-3">{(review.sources || []).map((source) => <DealSourceStatus key={source.id} source={source} />)}</div></div><div className="rounded-2xl border border-line bg-white/70 p-5"><SectionLabel>Criteria Notes</SectionLabel>{review.criteriaRecommendations?.length ? <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-ink/74">{review.criteriaRecommendations.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-4 text-sm text-ink/68">No criteria changes recommended.</p>}</div></div>
          {review.newlySeenMatches?.length ? <div><div className="mb-3 flex justify-between"><SectionLabel>Newly Seen Fits</SectionLabel><Pill tone="success">{review.newlySeenMatches.length}</Pill></div><div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{review.newlySeenMatches.slice(0, 6).map((deal) => <DealCard deal={deal} dismissing={dismissingDealKey === deal.dealKey} key={`new-${deal.dealKey}`} onDismissDeal={onDismissDeal} onOpenDeal={setSelectedDeal} onSendCimRequest={onSendCimRequest} outreachDisabled={!sourceReviewComplete} readOnly={readOnly} requestingCim={requestingCimDealKey === deal.dealKey} />)}</div></div> : null}
          <div className="grid gap-5 xl:grid-cols-3"><DealColumn deals={review.qualified || []} dismissingDealKey={dismissingDealKey} empty="No high-fit recent listings found." onDismissDeal={onDismissDeal} onOpenDeal={setSelectedDeal} onRecordCimOutcome={onRecordCimOutcome} onSendCimRequest={onSendCimRequest} outreachDisabled={!sourceReviewComplete} readOnly={readOnly} requestingCimDealKey={requestingCimDealKey} responseOutcomes={review.cimAutomation?.metrics?.responseOutcomes} title="High Fit" /><DealColumn deals={review.watchlist || []} dismissingDealKey={dismissingDealKey} empty="No watchlist listings found." mode="watch" onDismissDeal={onDismissDeal} onOpenDeal={setSelectedDeal} onRecordCimOutcome={onRecordCimOutcome} onSendCimRequest={onSendCimRequest} outreachDisabled={!sourceReviewComplete} readOnly={readOnly} requestingCimDealKey={requestingCimDealKey} responseOutcomes={review.cimAutomation?.metrics?.responseOutcomes} title="Watchlist" /><DealColumn deals={review.removalCandidates || []} dismissingDealKey={dismissingDealKey} empty="No removal candidates found." mode="remove" onDismissDeal={onDismissDeal} onOpenDeal={setSelectedDeal} readOnly={readOnly} title="Remove" /></div></div> : <p className="mt-6 rounded-2xl border border-line bg-fog/70 p-4 text-sm text-ink/70">No source review loaded yet. Review sources before sending CIM requests.</p>}
      </Reveal>
      {selectedDeal ? <OpportunityReview deal={selectedDeal} onClose={() => setSelectedDeal(null)} /> : null}
    </section>
  );
}
