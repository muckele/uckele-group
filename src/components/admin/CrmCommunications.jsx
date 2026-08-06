import React, { useMemo, useState } from 'react';
import CommunicationLifecycleBadge from './CommunicationLifecycleBadge';

export const communicationFieldLimits = {
  address: 320,
  recipients: 2000,
  subject: 300,
  bodyText: 20000,
  cimRequestId: 120,
};

const directions = ['inbound', 'outbound'];
const channels = ['email', 'phone', 'meeting', 'text', 'note'];
// Archive and spam remain explicit lifecycle actions; manual logging may only
// advance an active CRM record through the bounded working statuses.
const crmStatuses = ['new', 'review', 'contacted'];
const followUpStates = ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'];

function currentLocalDateTimeValue(date = new Date()) {
  const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60 * 1000));
  return localDate.toISOString().slice(0, 16);
}

function createInitialManualDraft() {
  return {
    direction: 'outbound',
    channel: 'email',
    occurredAt: currentLocalDateTimeValue(),
    fromAddress: '',
    to: '',
    subject: '',
    bodyText: '',
    cimRequestId: '',
    status: '',
    followUpState: '',
  };
}

function valueFrom(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }
  return undefined;
}

function formatLabel(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function normalizeAddressList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  return value ? [value] : [];
}

function addressLabel(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const email = value.email || value.address || '';
  return value.name && email ? `${value.name} <${email}>` : email || value.name || '';
}

function attachmentList(communication) {
  const attachments = valueFrom(communication, 'attachments', 'attachment_metadata', 'attachmentMetadata');
  return Array.isArray(attachments) ? attachments.slice(0, 25) : [];
}

function bodyTextFor(communication) {
  return String(valueFrom(communication, 'body_text', 'bodyText', 'body', 'notes') || '');
}

function occurredAtFor(communication) {
  return valueFrom(communication, 'occurred_at', 'occurredAt', 'received_at', 'receivedAt', 'created_at', 'createdAt') || '';
}

function communicationId(communication, index) {
  return String(communication.id || communication.communication_id || `communication-${index}`);
}

function workflowWarningFor(communication) {
  const metadata = communication?.metadata && typeof communication.metadata === 'object' ? communication.metadata : {};
  const workflowUpdate = metadata.workflowUpdate && typeof metadata.workflowUpdate === 'object'
    ? metadata.workflowUpdate
    : {};
  const state = String(workflowUpdate.state || '').toLowerCase();
  const warning = String(workflowUpdate.warning || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (warning) return warning;
  return ['pending', 'conflict', 'failed'].includes(state)
    ? 'Communication logged, but the optional CRM workflow update is not confirmed. Reload the CRM record before applying that workflow change separately.'
    : '';
}

function cimRequestOption(option) {
  if (typeof option === 'string') return { id: option, label: option };
  return {
    id: String(option?.id || option?.cimRequestId || ''),
    label: option?.label || option?.subject || option?.dealName || option?.id || '',
  };
}

function MessageBody({ communication, longBodyThreshold }) {
  const bodyText = bodyTextFor(communication);
  const retainedHtml = Boolean(valueFrom(communication, 'body_html_sanitized', 'bodyHtmlSanitized', 'body_html', 'bodyHtml'));

  if (!bodyText) {
    return (
      <p className="mt-3 rounded-xl border border-line/80 bg-fog/60 px-4 py-3 text-sm text-ink/60">
        {retainedHtml ? 'Plain-text body unavailable. Retained HTML is not rendered.' : 'No message body was recorded.'}
      </p>
    );
  }

  if (bodyText.length > longBodyThreshold) {
    return (
      <details className="mt-3 rounded-xl border border-line/80 bg-fog/60 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-moss">Show full message ({bodyText.length.toLocaleString()} characters)</summary>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink/76">{bodyText}</p>
      </details>
    );
  }

  return <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink/76">{bodyText}</p>;
}

function CommunicationCard({ communication, index, longBodyThreshold }) {
  const id = communicationId(communication, index);
  const direction = String(communication.direction || 'inbound').toLowerCase();
  const channel = String(communication.channel || 'email').toLowerCase();
  const metadata = communication.metadata && typeof communication.metadata === 'object' ? communication.metadata : {};
  const manualParticipants = metadata.manualParticipants && typeof metadata.manualParticipants === 'object'
    ? metadata.manualParticipants
    : {};
  const fromAddress = addressLabel(valueFrom(communication, 'from_address', 'fromAddress', 'from')) || addressLabel(manualParticipants.from) || 'Not recorded';
  const toAddresses = normalizeAddressList(valueFrom(communication, 'to_addresses', 'toAddresses', 'to')).map(addressLabel).filter(Boolean);
  const displayedToAddresses = toAddresses.length > 0
    ? toAddresses
    : normalizeAddressList(manualParticipants.to).map(addressLabel).filter(Boolean);
  const ccAddresses = normalizeAddressList(valueFrom(communication, 'cc_addresses', 'ccAddresses', 'cc')).map(addressLabel).filter(Boolean);
  const bccAddresses = normalizeAddressList(valueFrom(communication, 'bcc_addresses', 'bccAddresses', 'bcc')).map(addressLabel).filter(Boolean);
  const attachments = attachmentList(communication);
  const cimRequestId = valueFrom(communication, 'cim_request_id', 'cimRequestId');
  const followUpNumber = Number(
    valueFrom(communication, 'follow_up_number', 'followUpNumber')
    || valueFrom(metadata, 'follow_up_number', 'followUpNumber')
    || 0,
  );
  const requestState = valueFrom(communication, 'request_state', 'requestState', 'outreach_state', 'outreachState') || '';
  const deliveryState = valueFrom(communication, 'delivery_state', 'deliveryState') || '';
  const developmentOnly = Boolean(valueFrom(communication, 'development_only', 'developmentOnly')) || String(communication.provider || '').toLowerCase() === 'console';
  const replied = Boolean(valueFrom(communication, 'replied', 'is_reply', 'isReply'))
    || ['replied', 'responded'].includes(String(requestState).toLowerCase())
    || ['replied', 'responded'].includes(String(deliveryState).toLowerCase());
  const subject = String(communication.subject || '').trim();
  const workflowWarning = workflowWarningFor(communication);

  return (
    <li className="min-w-0 rounded-2xl border border-line/80 bg-white/80 p-4 sm:p-5" data-communication-id={id}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] ${direction === 'inbound' ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-moss/20 bg-moss/10 text-moss'}`}>
              {formatLabel(direction)}
            </span>
            <span className="inline-flex rounded-full border border-ink/10 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink/65">
              {formatLabel(channel)}
            </span>
            {cimRequestId ? (
              <span className="inline-flex rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-violet-700">
                {direction === 'inbound' ? 'CIM reply' : followUpNumber > 0 ? `CIM follow-up ${followUpNumber}` : 'CIM request'}
              </span>
            ) : null}
          </div>
          <h4 className="mt-3 break-words text-base font-semibold text-ink">{subject || `${formatLabel(channel)} communication`}</h4>
        </div>
        <time className="shrink-0 text-xs font-medium text-ink/55" dateTime={occurredAtFor(communication)}>{formatTimestamp(occurredAtFor(communication))}</time>
      </div>

      <CommunicationLifecycleBadge
        className="mt-3"
        deliveryState={deliveryState}
        developmentOnly={developmentOnly}
        replied={replied}
        requestState={requestState}
      />

      {workflowWarning ? (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900" role="status">
          <strong>Workflow note:</strong> {workflowWarning}
        </p>
      ) : null}

      <dl className="mt-4 grid min-w-0 gap-3 text-sm leading-6 text-ink/72 sm:grid-cols-2">
        <div className="min-w-0"><dt className="font-semibold text-ink">From</dt><dd className="break-words">{fromAddress}</dd></div>
        <div className="min-w-0"><dt className="font-semibold text-ink">To</dt><dd className="break-words">{displayedToAddresses.join(', ') || 'Not recorded'}</dd></div>
        {ccAddresses.length > 0 ? <div className="min-w-0"><dt className="font-semibold text-ink">Cc</dt><dd className="break-words">{ccAddresses.join(', ')}</dd></div> : null}
        {bccAddresses.length > 0 ? <div className="min-w-0"><dt className="font-semibold text-ink">Bcc</dt><dd className="break-words">{bccAddresses.join(', ')}</dd></div> : null}
      </dl>

      <MessageBody communication={communication} longBodyThreshold={longBodyThreshold} />

      {attachments.length > 0 ? (
        <div className="mt-4 rounded-xl border border-line/80 bg-white px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-moss">{attachments.length} attachment{attachments.length === 1 ? '' : 's'}</p>
          <ul className="mt-2 space-y-2 text-sm text-ink/70">
            {attachments.map((attachment, attachmentIndex) => {
              const name = attachment.name || attachment.filename || attachment.file_name || `Attachment ${attachmentIndex + 1}`;
              const contentType = attachment.content_type || attachment.contentType || attachment.mime_type || attachment.mimeType || '';
              const size = formatBytes(attachment.size || attachment.size_bytes || attachment.sizeBytes);
              return <li className="break-words" key={`${name}-${attachmentIndex}`}><strong className="text-ink">{name}</strong>{contentType || size ? ` · ${[contentType, size].filter(Boolean).join(' · ')}` : ''}</li>;
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function ManualCommunicationForm({ cimRequestOptions, onCancel, onSubmit, pending, error, workflowUpdatesDisabled = false }) {
  const [draft, setDraft] = useState(createInitialManualDraft);
  const [localError, setLocalError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setLocalError('');

    if (!draft.occurredAt || !draft.bodyText.trim()) {
      setLocalError('Occurrence time and communication body are required.');
      return;
    }

    const occurredDate = new Date(draft.occurredAt);
    if (Number.isNaN(occurredDate.getTime())) {
      setLocalError('Enter a valid occurrence date and time.');
      return;
    }

    try {
      await onSubmit({
        direction: draft.direction,
        channel: draft.channel,
        occurredAt: occurredDate.toISOString(),
        fromAddress: draft.fromAddress.trim(),
        // Preserve names for phone, meeting, text, and note entries. The server
        // normalizes actual email addresses while retaining manual participant labels.
        toAddresses: normalizeAddressList(draft.to),
        subject: draft.subject.trim(),
        bodyText: draft.bodyText.trim(),
        cimRequestId: draft.cimRequestId || '',
        ...(draft.status ? { status: draft.status } : {}),
        ...(draft.followUpState ? { followUpState: draft.followUpState } : {}),
      });
      setDraft(createInitialManualDraft());
      onCancel();
    } catch (submitError) {
      setLocalError(submitError?.message || 'Unable to log this communication.');
    }
  }

  const options = cimRequestOptions.map(cimRequestOption).filter((option) => option.id);

  return (
    <form className="mt-5 rounded-2xl border border-moss/20 bg-moss/5 p-4 sm:p-5" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-moss">Manual entry</p><h4 className="mt-1 text-lg font-semibold text-ink">Log Communication</h4></div>
        <button className="text-sm font-semibold text-moss underline underline-offset-4" disabled={pending} onClick={onCancel} type="button">Cancel</button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold text-ink">Direction<select className="form-control mt-2" disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, direction: event.target.value }))} value={draft.direction}>{directions.map((direction) => <option key={direction} value={direction}>{formatLabel(direction)}</option>)}</select></label>
        <label className="text-sm font-semibold text-ink">Channel<select className="form-control mt-2" disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value }))} value={draft.channel}>{channels.map((channel) => <option key={channel} value={channel}>{formatLabel(channel)}</option>)}</select></label>
        <label className="text-sm font-semibold text-ink">Occurred at<input className="form-control mt-2" disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, occurredAt: event.target.value }))} required type="datetime-local" value={draft.occurredAt} /></label>
        <label className="text-sm font-semibold text-ink">CIM request<select className="form-control mt-2" disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, cimRequestId: event.target.value }))} value={draft.cimRequestId}><option value="">No CIM request</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label className="text-sm font-semibold text-ink">From<input className="form-control mt-2" disabled={pending} maxLength={communicationFieldLimits.address} onChange={(event) => setDraft((current) => ({ ...current, fromAddress: event.target.value }))} placeholder="person@example.com or contact name" value={draft.fromAddress} /></label>
        <label className="text-sm font-semibold text-ink">To<input className="form-control mt-2" disabled={pending} maxLength={communicationFieldLimits.recipients} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} placeholder="Comma-separated recipients" value={draft.to} /></label>
        <label className="text-sm font-semibold text-ink">Update CRM status (optional)<select className="form-control mt-2" disabled={pending || workflowUpdatesDisabled} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))} value={draft.status}><option value="">No status update</option>{crmStatuses.map((status) => <option key={status} value={status}>{formatLabel(status)}</option>)}</select></label>
        <label className="text-sm font-semibold text-ink">Update follow-up state (optional)<select className="form-control mt-2" disabled={pending || workflowUpdatesDisabled} onChange={(event) => setDraft((current) => ({ ...current, followUpState: event.target.value }))} value={draft.followUpState}><option value="">No follow-up update</option>{followUpStates.map((state) => <option key={state} value={state}>{formatLabel(state)}</option>)}</select></label>
      </div>
      {workflowUpdatesDisabled ? <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">This lead is archived. You may record the communication, but restore the lead before changing workflow or scheduling follow-up.</p> : null}
      <label className="mt-4 block text-sm font-semibold text-ink">Subject<input className="form-control mt-2" disabled={pending} maxLength={communicationFieldLimits.subject} onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))} value={draft.subject} /></label>
      <label className="mt-4 block text-sm font-semibold text-ink">Body / notes<textarea className="form-control mt-2 min-h-36 whitespace-pre-wrap" disabled={pending} maxLength={communicationFieldLimits.bodyText} onChange={(event) => setDraft((current) => ({ ...current, bodyText: event.target.value }))} required value={draft.bodyText} /></label>
      {localError || error ? <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{localError || error}</p> : null}
      <button className="mt-4 inline-flex min-h-[46px] w-full items-center justify-center rounded-full border border-moss bg-moss px-5 py-3 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto" disabled={pending} type="submit">{pending ? 'Logging…' : 'Save Communication'}</button>
    </form>
  );
}

export default function CrmCommunications({
  communications = [],
  loading = false,
  error = '',
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  readOnly = false,
  onLogCommunication,
  logPending = false,
  logError = '',
  cimRequestOptions = [],
  longBodyThreshold = 600,
  workflowUpdatesDisabled = false,
}) {
  const [showLogForm, setShowLogForm] = useState(false);
  const boundedLongBodyThreshold = Math.max(160, Math.min(5000, Number(longBodyThreshold) || 600));
  const chronologicalCommunications = useMemo(() => [...communications].sort((left, right) => {
    const leftTime = new Date(occurredAtFor(left)).getTime();
    const rightTime = new Date(occurredAtFor(right)).getTime();
    if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
    if (!Number.isFinite(leftTime)) return 1;
    if (!Number.isFinite(rightTime)) return -1;
    return leftTime - rightTime;
  }), [communications]);
  const canLog = !readOnly && typeof onLogCommunication === 'function';

  return (
    <section aria-labelledby="crm-communications-heading" className="mt-6 min-w-0 rounded-2xl border border-line/80 bg-white/75 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">Communications</p>
          <h3 className="mt-2 text-xl font-semibold text-ink" id="crm-communications-heading">Broker and seller correspondence</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/64">Inbound, outbound, CIM, and manually logged communications are shown in occurrence order. Message HTML is never rendered.</p>
        </div>
        {canLog ? <button aria-expanded={showLogForm} className="inline-flex min-h-[46px] w-full items-center justify-center rounded-full border border-moss bg-moss px-5 py-3 text-sm font-semibold text-white sm:w-auto" onClick={() => setShowLogForm((current) => !current)} type="button">Log Communication</button> : null}
      </div>

      {showLogForm && canLog ? <ManualCommunicationForm cimRequestOptions={cimRequestOptions} error={logError} onCancel={() => setShowLogForm(false)} onSubmit={onLogCommunication} pending={logPending} workflowUpdatesDisabled={workflowUpdatesDisabled} /> : null}
      {error ? <p className="mt-5 min-w-0 break-words rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-layout="responsive-state" role="alert">{error}</p> : null}
      {loading && chronologicalCommunications.length === 0 ? <p className="mt-5 min-w-0 break-words text-sm text-ink/64" data-layout="responsive-state" role="status">Loading communications…</p> : null}
      {!loading && !error && chronologicalCommunications.length === 0 ? <p className="mt-5 min-w-0 break-words rounded-2xl border border-line/80 bg-fog/60 px-4 py-4 text-sm text-ink/64" data-layout="responsive-state">No communications have been recorded for this CRM record.</p> : null}

      {chronologicalCommunications.length > 0 ? (
        <ol className="mt-6 space-y-4" data-layout="responsive-stack">
          {chronologicalCommunications.map((communication, index) => <CommunicationCard communication={communication} index={index} key={communicationId(communication, index)} longBodyThreshold={boundedLongBodyThreshold} />)}
        </ol>
      ) : null}

      {hasMore && typeof onLoadMore === 'function' ? <button className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-ink/10 bg-white px-5 py-2.5 text-sm font-semibold text-ink disabled:opacity-50 sm:w-auto" disabled={loadingMore} onClick={onLoadMore} type="button">{loadingMore ? 'Loading more…' : 'Load More'}</button> : null}
    </section>
  );
}
