import React, { useState } from 'react';

function valueFrom(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }
  return undefined;
}

function formatTimestamp(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
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

function recordOption(record) {
  if (!record) return null;
  if (typeof record === 'string') return { id: record, label: record };
  const id = String(record.id || record.submission_id || record.submissionId || '');
  if (!id) return null;
  const company = record.company || record.business_name || record.businessName || record.name || 'Untitled CRM record';
  const contact = record.broker_email || record.brokerEmail || record.seller_email || record.sellerEmail || record.email || '';
  return { id, label: contact ? `${company} · ${contact}` : company };
}

function optionsForCommunication(communication, recordOptions) {
  const candidates = valueFrom(communication, 'candidate_records', 'candidateRecords', 'candidates');
  const combined = [...(Array.isArray(candidates) ? candidates : []), ...recordOptions];
  const seen = new Set();
  return combined.map(recordOption).filter((option) => {
    if (!option || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

function attachmentCount(communication) {
  const explicitCount = valueFrom(communication, 'attachment_count', 'attachmentCount');
  if (explicitCount !== undefined) return Math.max(0, Number(explicitCount) || 0);
  const attachments = valueFrom(communication, 'attachments', 'attachment_metadata', 'attachmentMetadata');
  return Array.isArray(attachments) ? attachments.length : 0;
}

function bodyPreview(communication, limit) {
  const text = String(valueFrom(communication, 'body_preview', 'bodyPreview', 'body_text', 'bodyText') || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No plain-text preview is available.';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export default function UnassignedCommunicationsInbox({
  communications = [],
  recordOptions = [],
  loading = false,
  error = '',
  readOnly = false,
  assigningId = '',
  onAssign,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onSearchRecords,
  previewLength = 240,
}) {
  const [selections, setSelections] = useState({});
  const [pendingId, setPendingId] = useState('');
  const [assignmentErrors, setAssignmentErrors] = useState({});
  const [recordSearch, setRecordSearch] = useState('');
  const [searchedRecords, setSearchedRecords] = useState([]);
  const [searchingRecords, setSearchingRecords] = useState(false);
  const [recordSearchError, setRecordSearchError] = useState('');
  const boundedPreviewLength = Math.max(80, Math.min(500, Number(previewLength) || 240));
  const canAssign = !readOnly && typeof onAssign === 'function';

  async function searchRecords(event) {
    event.preventDefault();
    const query = recordSearch.trim();
    if (query.length < 2) {
      setRecordSearchError('Enter at least two characters to search CRM records.');
      return;
    }
    setSearchingRecords(true);
    setRecordSearchError('');
    try {
      const results = await onSearchRecords(query);
      setSearchedRecords(Array.isArray(results) ? results : []);
      if (!Array.isArray(results) || results.length === 0) {
        setRecordSearchError('No CRM records matched that search.');
      }
    } catch (searchError) {
      setRecordSearchError(searchError?.message || 'Unable to search CRM records.');
    } finally {
      setSearchingRecords(false);
    }
  }

  async function assignCommunication(communication) {
    const id = String(communication.id || communication.communication_id || '');
    const submissionId = selections[id] || '';
    if (!id || !submissionId) {
      setAssignmentErrors((current) => ({ ...current, [id]: 'Select a CRM record before assigning.' }));
      return;
    }

    setPendingId(id);
    setAssignmentErrors((current) => ({ ...current, [id]: '' }));
    try {
      await onAssign({ communicationId: id, submissionId });
      setSelections((current) => ({ ...current, [id]: '' }));
    } catch (assignError) {
      setAssignmentErrors((current) => ({ ...current, [id]: assignError?.message || 'Unable to assign this communication.' }));
    } finally {
      setPendingId('');
    }
  }

  return (
    <section aria-labelledby="unassigned-communications-heading" className="min-w-0 rounded-2xl border border-line/80 bg-white/80 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">Communications inbox</p>
          <h2 className="mt-2 text-2xl font-semibold text-ink" id="unassigned-communications-heading">Unassigned inbound communications</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/65">Messages that could not be matched safely remain here until an administrator selects the correct CRM record.</p>
        </div>
        <span className="inline-flex self-start rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.1em] text-amber-800">{communications.length} shown</span>
      </div>

      {error ? <p className="mt-5 min-w-0 break-words rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-layout="responsive-state" role="alert">{error}</p> : null}
      {loading && communications.length === 0 ? <p className="mt-5 min-w-0 break-words text-sm text-ink/65" data-layout="responsive-state" role="status">Loading unassigned communications…</p> : null}
      {!loading && !error && communications.length === 0 ? <p className="mt-5 min-w-0 break-words rounded-2xl border border-line bg-fog/60 px-4 py-4 text-sm text-ink/65" data-layout="responsive-state">No unassigned communications need review.</p> : null}

      {canAssign && typeof onSearchRecords === 'function' && communications.length > 0 ? (
        <form className="mt-5 rounded-2xl border border-line/80 bg-fog/55 p-4" onSubmit={searchRecords}>
          <label className="text-sm font-semibold text-ink">Search all CRM records<input className="form-control mt-2" disabled={searchingRecords} maxLength={200} onChange={(event) => setRecordSearch(event.target.value)} placeholder="Business, broker, seller, email, or listing" type="search" value={recordSearch} /></label>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-ink/10 bg-white px-4 text-sm font-semibold text-ink disabled:opacity-50" disabled={searchingRecords} type="submit">{searchingRecords ? 'Searching…' : 'Search CRM'}</button>
            {searchedRecords.length > 0 ? <p className="text-sm text-emerald-700">{searchedRecords.length} CRM match{searchedRecords.length === 1 ? '' : 'es'} available below.</p> : null}
          </div>
          {recordSearchError ? <p className="mt-3 text-sm text-amber-800" role="status">{recordSearchError}</p> : null}
        </form>
      ) : null}

      {communications.length > 0 ? (
        <ol className="mt-6 space-y-4" data-layout="responsive-stack">
          {communications.map((communication, index) => {
            const id = String(communication.id || communication.communication_id || `unassigned-${index}`);
            const sender = addressLabel(valueFrom(communication, 'from_address', 'fromAddress', 'from')) || 'Sender unavailable';
            const recipients = normalizeAddressList(valueFrom(communication, 'to_addresses', 'toAddresses', 'to')).map(addressLabel).filter(Boolean);
            const subject = String(communication.subject || '').trim() || 'No subject';
            const receivedAt = valueFrom(communication, 'occurred_at', 'occurredAt', 'received_at', 'receivedAt', 'created_at', 'createdAt');
            const count = attachmentCount(communication);
            const candidates = optionsForCommunication(communication, [...recordOptions, ...searchedRecords]);
            const isAssigning = String(assigningId || pendingId) === id;

            return (
              <li className="min-w-0 rounded-2xl border border-line/80 bg-fog/55 p-4 sm:p-5" data-communication-id={id} key={id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-base font-semibold text-ink">{subject}</p>
                    <p className="mt-2 break-words text-sm text-ink/72"><strong>From:</strong> {sender}</p>
                    <p className="mt-1 break-words text-sm text-ink/72"><strong>To:</strong> {recipients.join(', ') || 'Recipients unavailable'}</p>
                  </div>
                  <time className="shrink-0 text-xs font-medium text-ink/55" dateTime={receivedAt}>{formatTimestamp(receivedAt)}</time>
                </div>

                <p className="mt-3 break-words rounded-xl border border-line/80 bg-white px-4 py-3 text-sm leading-6 text-ink/70">{bodyPreview(communication, boundedPreviewLength)}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.1em] text-moss/75">{count} attachment{count === 1 ? '' : 's'}</p>

                {canAssign ? (
                  <div className="mt-4 grid gap-3 border-t border-line/80 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <label className="min-w-0 text-sm font-semibold text-ink">Assign to CRM record<select className="form-control mt-2" disabled={isAssigning || candidates.length === 0} onChange={(event) => setSelections((current) => ({ ...current, [id]: event.target.value }))} value={selections[id] || ''}><option value="">Select a record</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
                    <button className="inline-flex min-h-[46px] w-full items-center justify-center rounded-full border border-moss bg-moss px-5 py-3 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto" disabled={isAssigning || candidates.length === 0 || !selections[id]} onClick={() => assignCommunication(communication)} type="button">{isAssigning ? 'Assigning…' : 'Assign Communication'}</button>
                    {candidates.length === 0 ? <p className="text-sm text-amber-800 sm:col-span-2">No safe candidate records are available. Use the CRM search above to find the destination record.</p> : null}
                    {assignmentErrors[id] ? <p className="text-sm text-red-700 sm:col-span-2" role="alert">{assignmentErrors[id]}</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {hasMore && typeof onLoadMore === 'function' ? <button className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-ink/10 bg-white px-5 py-2.5 text-sm font-semibold text-ink disabled:opacity-50 sm:w-auto" disabled={loadingMore} onClick={onLoadMore} type="button">{loadingMore ? 'Loading more…' : 'Load More'}</button> : null}
    </section>
  );
}
