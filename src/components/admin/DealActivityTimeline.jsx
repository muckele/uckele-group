import React, { useMemo, useState } from 'react';

const filters = [
  { id: 'all', label: 'All activity', matches: () => true },
  { id: 'changes', label: 'Record changes', matches: (type) => type.startsWith('submission.') },
  { id: 'email', label: 'Email', matches: (type) => type.startsWith('email.') },
  { id: 'cim', label: 'CIM', matches: (type) => type.startsWith('cim.') },
  { id: 'documents', label: 'Documents', matches: (type) => type.startsWith('documents.') },
  { id: 'diligence', label: 'Diligence', matches: (type) => type.startsWith('diligence.') },
];

const maximumVisibleChanges = 8;
const sensitiveMetadataKeyPattern = /(authorization|cookie|credential|file_?path|password|secret|signature|storage_?path|token)/i;

function sanitizeStructuredValue(value, depth = 0) {
  if (depth >= 3) return '[nested value]';
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeStructuredValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 20)
      .map(([key, nestedValue]) => [
        key,
        sensitiveMetadataKeyPattern.test(key) ? '[redacted]' : sanitizeStructuredValue(nestedValue, depth + 1),
      ]),
  );
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/([?&](?:access_?token|key|secret|signature|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
}

export function formatActivityChangeValue(value) {
  if (value === null || value === undefined || value === '') return 'Not set';

  let displayValue;
  if (typeof value === 'object') {
    try {
      displayValue = JSON.stringify(sanitizeStructuredValue(value));
    } catch {
      displayValue = '[structured value]';
    }
  } else if (typeof value === 'boolean') {
    displayValue = value ? 'Yes' : 'No';
  } else {
    displayValue = String(value);
  }

  const normalized = redactSensitiveText(displayValue).replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized || 'Not set';
}

function eventChanges(event) {
  return Array.isArray(event.metadata?.changes)
    ? event.metadata.changes.filter((change) => change && typeof change === 'object' && change.field)
    : [];
}

function formatTimestamp(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function eventLabel(type) {
  return String(type || 'activity')
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export default function DealActivityTimeline({ events = [], loading = false, error = '' }) {
  const [activeFilter, setActiveFilter] = useState('all');
  const visibleEvents = useMemo(() => {
    const selected = filters.find((filter) => filter.id === activeFilter) || filters[0];
    return events.filter((event) => selected.matches(String(event.event_type || '')));
  }, [activeFilter, events]);
  const visibleRawCount = visibleEvents.reduce((count, event) => count + Math.max(1, Number(event.metadata?.rawEventCount || 1)), 0);

  return (
    <section aria-labelledby="deal-activity-heading" className="mt-6 rounded-2xl border border-line/80 bg-white/75 p-4 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">Deal activity</p>
          <h3 className="mt-2 text-xl font-semibold text-ink" id="deal-activity-heading">Durable activity timeline</h3>
          <p className="mt-2 text-sm leading-6 text-ink/64">Record, email, CIM, document, and diligence events are retained with their actor and timestamp.</p>
        </div>
        <label className="text-sm font-semibold text-ink" htmlFor="deal-activity-filter">
          Show
          <select
            className="form-control mt-2 min-w-52"
            id="deal-activity-filter"
            onChange={(event) => setActiveFilter(event.target.value)}
            value={activeFilter}
          >
            {filters.map((filter) => <option key={filter.id} value={filter.id}>{filter.label}</option>)}
          </select>
        </label>
      </div>

      {error ? <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p> : null}
      {loading ? <p className="mt-5 text-sm text-ink/64" role="status">Loading activity…</p> : null}
      {!loading && !error && visibleEvents.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-line/80 bg-fog/60 px-4 py-4 text-sm text-ink/64">No events match this timeline filter.</p>
      ) : null}
      {!loading && !error && activeFilter === 'email' && visibleEvents.length > 0 ? (
        <p className="mt-4 text-sm text-ink/64">{visibleEvents.length} logical email{visibleEvents.length === 1 ? '' : 's'} · {visibleRawCount} retained lifecycle event{visibleRawCount === 1 ? '' : 's'}</p>
      ) : null}

      {visibleEvents.length > 0 ? (
        <ol className="mt-6 space-y-4">
          {visibleEvents.map((event) => {
            const changes = eventChanges(event);

            return (
            <li className="relative border-l-2 border-moss/25 pl-5" key={event.id}>
              <span aria-hidden="true" className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-moss" />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-ink">{event.summary}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.12em] text-moss/75">{eventLabel(event.event_type)}</p>
                </div>
                <time className="shrink-0 text-xs text-ink/55" dateTime={event.created_at}>{formatTimestamp(event.created_at)}</time>
              </div>
              <p className="mt-2 text-xs text-ink/60">{event.actor || 'system'} · {event.role || 'system'}</p>
              {event.metadata?.logicalMessage ? (
                <>
                  <p className="mt-2 text-xs text-ink/60">First lifecycle event {formatTimestamp(event.metadata.firstLifecycleAt)} · latest lifecycle {formatTimestamp(event.metadata.latestLifecycleAt)}</p>
                  <details className="mt-3 rounded-xl border border-line/80 bg-fog/60 p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-moss/80">Provider and audit events ({event.metadata.rawEventCount})</summary>
                    <ol className="mt-3 space-y-2">
                      {(event.metadata.auditEvents || []).map((auditEvent) => (
                        <li className="text-xs leading-5 text-ink/65" key={auditEvent.id}>
                          <span className="font-semibold text-ink/75">{eventLabel(auditEvent.eventType)}</span> · {formatTimestamp(auditEvent.createdAt)} · {auditEvent.provider || auditEvent.role || 'system'}
                        </li>
                      ))}
                    </ol>
                  </details>
                </>
              ) : null}
              {changes.length > 0 ? (
                <div className="mt-3 rounded-xl border border-line/80 bg-fog/60 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-moss/80">Changed fields</p>
                  <dl className="mt-2 space-y-2">
                    {changes.slice(0, maximumVisibleChanges).map((change, index) => (
                      <div className="grid gap-1 text-xs leading-5 sm:grid-cols-[9rem_minmax(0,1fr)]" key={`${change.field}-${index}`}>
                        <dt className="font-semibold text-ink/75">{eventLabel(change.field)}</dt>
                        <dd className="min-w-0 text-ink/65">
                          <span><span className="sr-only">Before: </span>{formatActivityChangeValue(change.before)}</span>
                          <span aria-hidden="true" className="px-2 text-moss/60">→</span>
                          <span><span className="sr-only">After: </span>{formatActivityChangeValue(change.after)}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {changes.length > maximumVisibleChanges ? <p className="mt-2 text-xs text-ink/55">{changes.length - maximumVisibleChanges} additional changed field(s) retained in the activity record.</p> : null}
                </div>
              ) : null}
            </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
