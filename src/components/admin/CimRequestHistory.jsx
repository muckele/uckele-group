import React from 'react';
import CommunicationLifecycleBadge from './CommunicationLifecycleBadge';

const defaultQuery = {
  search: '',
  requestState: 'all',
  deliveryState: 'all',
  replyState: 'all',
  followUpState: 'all',
  sort: 'first_requested_at',
  direction: 'desc',
  page: 1,
  pageSize: 25,
};

const countDefinitions = [
  { id: 'ready', label: 'Ready', tone: 'warning' },
  { id: 'pending', label: 'Pending', tone: 'warning' },
  { id: 'accepted', label: 'Provider accepted', tone: 'info' },
  { id: 'delivered', label: 'Delivered', tone: 'success' },
  { id: 'deliveryIssue', aliases: ['delivery_issue'], label: 'Delivery issues', tone: 'danger' },
  { id: 'replied', label: 'Replied', tone: 'success' },
];

const toneClasses = {
  success: 'border-moss/20 bg-moss/10 text-moss',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-700',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
};

const correctedRecipientStates = new Set(['bounced', 'failed', 'complained', 'suppressed', 'delivery-issue']);

function valueFrom(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }
  return undefined;
}

function normalizeState(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function formatTimestamp(value, fallback = 'Not recorded') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function countValue(counts, definition) {
  const keys = [definition.id, ...(definition.aliases || [])];
  const value = keys.map((key) => counts?.[key]).find((candidate) => candidate !== undefined && candidate !== null);
  return Math.max(0, Number(value) || 0);
}

function rangeLabel(page, pageSize, total) {
  if (!total) return '0 requests';
  const first = (page - 1) * pageSize + 1;
  return `${first}–${Math.min(total, page * pageSize)} of ${total} requests`;
}

function crmHrefFor(request) {
  const explicitHref = valueFrom(request, 'crm_href', 'crmHref');
  if (typeof explicitHref === 'string' && explicitHref.startsWith('/')) return explicitHref;
  const submissionId = valueFrom(request, 'submission_id', 'submissionId');
  return submissionId ? `/admin/crm/${encodeURIComponent(submissionId)}` : '';
}

function addressList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return String(value || '');
}

function exactCommunicationLabel(communication, index) {
  const kind = normalizeState(valueFrom(communication, 'kind'));
  if (kind.includes('follow-up')) return `CIM follow-up ${Math.max(1, index - 1)}`;
  if (kind.includes('request')) return 'Initial CIM request';
  return index === 1 ? 'Initial CIM request' : `CIM email ${index}`;
}

function CimRequestHistoryCard({ request, readOnly, retrying, onRetryCorrectedRecipient }) {
  const requestId = String(request.id || request.cim_request_id || request.deal_key || 'cim-request');
  const businessName = valueFrom(request, 'business_name', 'businessName', 'deal_name', 'dealName', 'name') || 'Unnamed opportunity';
  const brokerEmail = valueFrom(request, 'recipient_email', 'recipientEmail', 'broker_email', 'brokerEmail') || 'Recipient not recorded';
  const requestState = valueFrom(request, 'request_state', 'requestState', 'outreach_state', 'outreachState', 'status') || 'not-requested';
  const deliveryState = valueFrom(request, 'delivery_state', 'deliveryState') || 'not-attempted';
  const replied = Boolean(valueFrom(request, 'replied', 'has_reply', 'hasReply')) || ['replied', 'responded'].includes(normalizeState(requestState));
  const developmentOnly = Boolean(valueFrom(request, 'development_only', 'developmentOnly')) || String(request.provider || '').toLowerCase() === 'console';
  const firstRequestedAt = valueFrom(request, 'first_requested_at', 'firstRequestedAt', 'created_at', 'createdAt');
  const lastActivityAt = valueFrom(request, 'last_activity_at', 'lastActivityAt');
  const followUpCount = Number(valueFrom(request, 'follow_up_count', 'followUpCount') || 0);
  const nextFollowUpAt = valueFrom(request, 'next_follow_up_at', 'nextFollowUpAt');
  const listingHref = safeExternalUrl(valueFrom(request, 'listing_url', 'listingUrl'));
  const crmHref = crmHrefFor(request);
  const explicitRetry = valueFrom(request, 'can_retry_corrected_recipient', 'canRetryCorrectedRecipient');
  const canRetryCorrectedRecipient = typeof explicitRetry === 'boolean'
    ? explicitRetry
    : correctedRecipientStates.has(normalizeState(deliveryState));
  const failureReason = valueFrom(request, 'delivery_error', 'deliveryError', 'failure_reason', 'failureReason');
  const communications = Array.isArray(request.communications)
    ? request.communications.filter((communication) => normalizeState(communication.direction) === 'outbound')
    : [];

  return (
    <li className="min-w-0 rounded-2xl border border-line/80 bg-white/85 p-4 sm:p-5" data-cim-request-id={requestId}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <CommunicationLifecycleBadge deliveryState={deliveryState} developmentOnly={developmentOnly} replied={replied} requestState={requestState} />
          <h4 className="mt-3 break-words text-lg font-semibold text-ink">{businessName}</h4>
          <p className="mt-1 break-words text-sm text-ink/65">{brokerEmail}</p>
          {request.subject ? <p className="mt-2 break-words text-sm font-medium text-ink/75">{request.subject}</p> : null}
        </div>
        <dl className="grid shrink-0 gap-2 text-sm leading-6 text-ink/65 sm:grid-cols-2 lg:min-w-[22rem]">
          <div><dt className="font-semibold text-ink">First requested</dt><dd>{formatTimestamp(firstRequestedAt, 'Not requested')}</dd></div>
          <div><dt className="font-semibold text-ink">Last activity</dt><dd>{formatTimestamp(lastActivityAt)}</dd></div>
          <div><dt className="font-semibold text-ink">Follow-ups</dt><dd>{followUpCount}</dd></div>
          <div><dt className="font-semibold text-ink">Next follow-up</dt><dd>{formatTimestamp(nextFollowUpAt, 'None scheduled')}</dd></div>
        </dl>
      </div>

      {failureReason ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="status">{failureReason}</p> : null}

      {communications.length > 0 ? (
        <details className="mt-4 rounded-xl border border-line/80 bg-sand/35 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-moss">View exact sent email{communications.length === 1 ? '' : 's'} ({communications.length})</summary>
          <ol className="mt-4 space-y-4">
            {communications.map((communication, index) => {
              const copyNumber = index + 1;
              const fromAddress = valueFrom(communication, 'from_address', 'fromAddress') || 'Sender not recorded';
              const recipients = addressList(valueFrom(communication, 'to_addresses', 'toAddresses')) || 'Recipients not recorded';
              const replyTo = valueFrom(communication, 'reply_to_address', 'replyToAddress');
              const body = String(valueFrom(communication, 'body_text', 'bodyText') || '');
              return (
                <li className="min-w-0 rounded-xl border border-line/75 bg-white p-4" key={communication.id || `${requestId}-copy-${copyNumber}`}>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <h5 className="font-semibold text-ink">{exactCommunicationLabel(communication, copyNumber)}</h5>
                    <time className="text-xs font-medium text-ink/55" dateTime={valueFrom(communication, 'occurred_at', 'occurredAt') || ''}>{formatTimestamp(valueFrom(communication, 'occurred_at', 'occurredAt'))}</time>
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm leading-6 text-ink/65 sm:grid-cols-2">
                    <div><dt className="font-semibold text-ink">From</dt><dd className="break-words">{fromAddress}</dd></div>
                    <div><dt className="font-semibold text-ink">To</dt><dd className="break-words">{recipients}</dd></div>
                    {replyTo ? <div><dt className="font-semibold text-ink">Reply-to</dt><dd className="break-words">{replyTo}</dd></div> : null}
                    <div><dt className="font-semibold text-ink">Subject</dt><dd className="break-words">{communication.subject || 'No subject'}</dd></div>
                  </dl>
                  {body ? <p className="mt-3 whitespace-pre-wrap break-words border-t border-line/70 pt-3 text-sm leading-7 text-ink/75">{body}</p> : <p className="mt-3 text-sm text-ink/55">Exact plain-text copy is unavailable for this legacy request.</p>}
                </li>
              );
            })}
          </ol>
        </details>
      ) : <p className="mt-4 text-sm text-ink/55">Exact email copy is available from the linked CRM record for legacy requests that predate communication storage.</p>}

      <div className="mt-4 flex flex-col gap-2 border-t border-line/75 pt-4 sm:flex-row sm:flex-wrap sm:items-center">
        {crmHref ? <a className="inline-flex min-h-10 items-center justify-center rounded-full border border-moss/20 bg-white px-4 text-sm font-semibold text-moss" href={crmHref}>Open CRM record</a> : <span className="text-sm font-medium text-amber-800">CRM record not linked</span>}
        {listingHref ? <a className="inline-flex min-h-10 items-center justify-center rounded-full border border-ink/10 bg-white px-4 text-sm font-semibold text-ink" href={listingHref} rel="noreferrer" target="_blank">Original listing</a> : null}
        {canRetryCorrectedRecipient && !readOnly && typeof onRetryCorrectedRecipient === 'function' ? (
          <button className="inline-flex min-h-10 items-center justify-center rounded-full border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700 disabled:opacity-50 sm:ml-auto" disabled={retrying} onClick={() => onRetryCorrectedRecipient(request)} type="button">{retrying ? 'Opening retry…' : 'Retry with corrected recipient'}</button>
        ) : null}
      </div>
    </li>
  );
}

export default function CimRequestHistory({
  requests = [],
  counts = {},
  query = defaultQuery,
  onQueryChange,
  total = 0,
  totalPages = 1,
  loading = false,
  error = '',
  readOnly = false,
  retryingRequestId = '',
  onRetryCorrectedRecipient,
}) {
  const currentQuery = { ...defaultQuery, ...query };
  const page = Math.max(1, Number(currentQuery.page) || 1);
  const pageSize = [10, 25, 50, 100].includes(Number(currentQuery.pageSize)) ? Number(currentQuery.pageSize) : 25;
  const pages = Math.max(1, Number(totalPages) || 1);

  function updateQuery(patch, resetPage = true) {
    if (typeof onQueryChange !== 'function') return;
    onQueryChange({ ...currentQuery, ...patch, ...(resetPage ? { page: 1 } : {}) });
  }

  return (
    <section aria-labelledby="cim-request-history-heading" className="min-w-0 space-y-5" data-admin-tour="deal-hunter-history">
      <div className="rounded-2xl border border-line/80 bg-white/80 p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">Deal Hunter</p>
        <h2 className="mt-2 text-2xl font-semibold text-ink" id="cim-request-history-heading">CIM Request History</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/65">Durable request history remains available after a listing leaves the current source review.</p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" data-layout="responsive-counts">
          {countDefinitions.map((definition) => <div className={`rounded-xl border p-3 ${toneClasses[definition.tone]}`} key={definition.id}><p className="text-xs font-semibold uppercase tracking-[0.08em]">{definition.label}</p><p className="mt-1 text-xl font-semibold">{countValue(counts, definition)}</p></div>)}
        </div>

        <div className="mt-5 grid gap-4 border-t border-line/80 pt-5 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm font-semibold text-ink xl:col-span-2">Search CIM history<input className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ search: event.target.value })} placeholder="Business, broker, subject, URL, or deal key" type="search" value={currentQuery.search} /></label>
          <label className="text-sm font-semibold text-ink">Request state<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ requestState: event.target.value })} value={currentQuery.requestState}><option value="all">All request states</option><option value="not-requested">Not requested</option><option value="ready">Ready</option><option value="pending">Pending</option><option value="provider-accepted">Provider accepted</option><option value="responded">Replied</option><option value="stopped">Stopped</option><option value="failed">Failed</option></select></label>
          <label className="text-sm font-semibold text-ink">Delivery state<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ deliveryState: event.target.value })} value={currentQuery.deliveryState}><option value="all">All delivery states</option><option value="not-attempted">Not attempted</option><option value="accepted">Provider accepted / awaiting delivery</option><option value="delivered">Delivered</option><option value="delayed">Delayed</option><option value="bounced">Bounced</option><option value="failed">Failed</option><option value="complained">Complained</option><option value="suppressed">Suppressed</option><option value="development-only">Development only</option></select></label>
          <label className="text-sm font-semibold text-ink">Reply state<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ replyState: event.target.value })} value={currentQuery.replyState}><option value="all">All replies</option><option value="replied">Replied</option><option value="unreplied">No reply</option></select></label>
          <label className="text-sm font-semibold text-ink">Follow-up state<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ followUpState: event.target.value })} value={currentQuery.followUpState}><option value="all">All follow-up states</option><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="stopped">Stopped</option><option value="failed">Failed</option></select></label>
          <label className="text-sm font-semibold text-ink">Sort by<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ sort: event.target.value })} value={currentQuery.sort}><option value="first_requested_at">First request</option><option value="last_activity_at">Last activity</option><option value="failure">Failure priority</option></select></label>
          <label className="text-sm font-semibold text-ink">Direction<select className="form-control mt-2" disabled={loading} onChange={(event) => updateQuery({ direction: event.target.value })} value={currentQuery.direction}><option value="desc">Newest / highest first</option><option value="asc">Oldest / lowest first</option></select></label>
        </div>
      </div>

      {error ? <p className="min-w-0 break-words rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-layout="responsive-state" role="alert">{error}</p> : null}
      {loading && requests.length === 0 ? <p className="min-w-0 break-words rounded-2xl border border-line bg-white p-5 text-sm text-ink/65" data-layout="responsive-state" role="status">Loading CIM request history…</p> : null}
      {!loading && !error && requests.length === 0 ? <p className="min-w-0 break-words rounded-2xl border border-line bg-white p-5 text-sm text-ink/65" data-layout="responsive-state">No CIM requests match these filters.</p> : null}
      {requests.length > 0 ? <ol className="space-y-4" data-layout="responsive-stack">{requests.map((request) => <CimRequestHistoryCard key={request.id || request.cim_request_id || request.deal_key} onRetryCorrectedRecipient={onRetryCorrectedRecipient} readOnly={readOnly} request={request} retrying={String(retryingRequestId) === String(request.id || request.cim_request_id)} />)}</ol> : null}

      {total > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite" className="text-sm font-medium text-ink/65">{rangeLabel(page, pageSize, total)} · Page {page} of {pages}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="text-sm font-semibold text-ink">Per page<select className="form-control ml-2 inline-block w-auto" disabled={loading} onChange={(event) => updateQuery({ pageSize: Number(event.target.value) })} value={pageSize}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
            <button className="inline-flex min-h-10 items-center justify-center rounded-full border border-ink/10 bg-white px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || page <= 1} onClick={() => updateQuery({ page: page - 1 }, false)} type="button">Previous</button>
            <button className="inline-flex min-h-10 items-center justify-center rounded-full border border-ink/10 bg-white px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || page >= pages} onClick={() => updateQuery({ page: page + 1 }, false)} type="button">Next</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
