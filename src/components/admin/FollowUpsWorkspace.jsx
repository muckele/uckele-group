import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MailQuestion,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';

const views = [
  ['crm-actions', 'CRM actions'],
  ['email-triage', 'Email triage'],
  ['due-today', 'Due today'],
  ['overdue', 'Overdue'],
  ['awaiting-reply', 'Awaiting reply'],
  ['inbound-reply', 'Reply received'],
  ['delivery-problem', 'Delivery problems'],
  ['manual-review', 'Manual review'],
  ['completed', 'Completed'],
  ['all', 'All'],
];

const buttonPrimary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-moss bg-moss px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50';
const buttonSecondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-ink/10 bg-white px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-moss/30 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'min-h-11 w-full rounded-xl border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/45 focus:border-moss focus:ring-2 focus:ring-moss/15';

function formatDateTime(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed));
}

function formatRelative(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return 'No email activity';
  const hours = Math.round((parsed - Date.now()) / 3_600_000);
  if (Math.abs(hours) < 24) return hours === 0 ? 'Now' : `${Math.abs(hours)}h ${hours < 0 ? 'ago' : 'from now'}`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d ${days < 0 ? 'ago' : 'from now'}`;
}

function humanize(value = '') {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(value = '') {
  const normalized = String(value).toLowerCase();
  if (['bounced', 'failed', 'complained', 'suppressed', 'ambiguous', 'permanent_failed'].includes(normalized)) {
    return 'border-red-200 bg-red-50 text-red-800';
  }
  if (['delayed', 'pending', 'queued', 'sending', 'retryable_failed', 'manual_review'].includes(normalized)) {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  if (['accepted', 'delivered', 'replied', 'complete', 'completed'].includes(normalized)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  return 'border-ink/10 bg-sand/35 text-ink/75';
}

function Badge({ children, value = '' }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(value || children)}`}>{children}</span>;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok || !result.success) {
    const error = new Error(result.error || 'The request could not be completed.');
    error.status = response.status;
    error.result = result;
    throw error;
  }
  return result;
}

function queueSafety(record) {
  const state = record.follow_up_latest_delivery_state;
  if (['bounced', 'failed', 'complained', 'suppressed'].includes(state)) {
    return { label: humanize(state), className: 'border-red-200 bg-red-50 text-red-800' };
  }
  if (record.follow_up_latest_direction === 'inbound') {
    return { label: 'Reply received', className: 'border-blue-200 bg-blue-50 text-blue-800' };
  }
  if (record.follow_up_recommendation_action === 'manual_review') {
    return { label: 'Manual review', className: 'border-amber-200 bg-amber-50 text-amber-800' };
  }
  return null;
}

function emptyCompose() {
  return {
    open: false,
    step: 'edit',
    recipient: '',
    recipientOverride: false,
    recipientOverrideReason: '',
    subject: '',
    bodyText: '',
    parentCommunicationId: '',
    recommendationId: '',
    nextFollowUpState: 'waiting-on-owner',
    nextActionAt: '',
    manualTakeoverAcknowledged: false,
    confirmationChecked: false,
    clientRequestToken: '',
    preview: null,
    pending: false,
    error: '',
  };
}

function initialQueueView() {
  if (typeof window === 'undefined') return 'crm-actions';
  const requested = new URLSearchParams(window.location.search).get('view') || '';
  const aliases = {
    'action-items': 'crm-actions',
    'due-soon': 'due-today',
    'warm-leads': 'email-triage',
  };
  const resolved = aliases[requested] || requested;
  return views.some(([id]) => id === resolved) ? resolved : 'crm-actions';
}

function localDateTimeValue(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const pad = (item) => String(item).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function QueueRow({ record, onOpen }) {
  const safety = queueSafety(record);
  return (
    <button
      className="group grid w-full gap-3 border-b border-ink/8 px-4 py-4 text-left transition last:border-0 hover:bg-moss/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-moss sm:grid-cols-[minmax(0,1.5fr)_minmax(150px,.8fr)_auto] sm:items-center sm:px-5"
      onClick={() => onOpen(record)}
      type="button"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-ink">{record.company || record.name || 'Unnamed CRM record'}</span>
          {safety ? <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${safety.className}`}>{safety.label}</span> : null}
          {record.priority === 'high' || record.priority === 'urgent' ? <Badge value="delayed">{humanize(record.priority)}</Badge> : null}
        </span>
        <span className="mt-1 block truncate text-sm text-ink/60">
          {record.broker_name || record.seller_name || record.name || 'No contact'} · {record.broker_email || record.seller_email || record.email || 'No email'}
        </span>
        {record.follow_up_latest_subject ? <span className="mt-1 block truncate text-xs text-ink/50">Latest: {record.follow_up_latest_subject}</span> : null}
      </span>
      <span className="text-sm text-ink/65">
        <span className="block font-semibold text-ink/80">{record.follow_up_prompt?.title || humanize(record.follow_up_recommendation_action || record.follow_up_state)}</span>
        <span className="mt-1 block text-xs">{formatDateTime(record.next_action_at)}</span>
      </span>
      <span className="flex items-center justify-between gap-3 sm:justify-end">
        <span className="text-xs font-semibold text-ink/50">
          {record.follow_up_priority_score ? `Score ${record.follow_up_priority_score}` : formatRelative(record.follow_up_latest_communication_at)}
        </span>
        <ChevronRight className="h-5 w-5 text-ink/35 transition group-hover:translate-x-0.5 group-hover:text-moss" aria-hidden="true" />
      </span>
    </button>
  );
}

function RecommendationPanel({ recommendation, onCompose, onDismiss, pending, readOnly }) {
  if (!recommendation) {
    return (
      <div className="rounded-2xl border border-dashed border-ink/15 bg-sand/25 p-5 text-sm leading-6 text-ink/65">
        Generate a recommendation to apply the deterministic safety policy and inspect the current conversation state. This action never sends email.
      </div>
    );
  }
  const degraded = recommendation.metadata?.aiRequested && !recommendation.metadata?.aiUsed;
  const current = recommendation.status === 'current';
  return (
    <section aria-labelledby="follow-up-recommendation-title" className="rounded-2xl border border-moss/15 bg-moss/[0.035] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Recommendation</p>
          <h3 className="mt-1 text-lg font-semibold text-ink" id="follow-up-recommendation-title">{humanize(recommendation.action_type)}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge value={recommendation.conversation_state}>{humanize(recommendation.conversation_state)}</Badge>
          <Badge>Confidence {Math.round(Number(recommendation.confidence || 0) * 100)}%</Badge>
          <Badge>Priority {recommendation.priority_score || 0}</Badge>
        </div>
      </div>
      {degraded ? (
        <div className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>AI enrichment was unavailable ({humanize(recommendation.metadata.aiFallbackReason)}). The deterministic result remains available and authoritative.</span>
        </div>
      ) : null}
      {!current ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
          This recommendation is {humanize(recommendation.status)} and is retained only as decision history. Refresh after the CRM context changes to obtain current advice.
        </div>
      ) : null}
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="font-semibold text-ink/55">Proposed timing</dt><dd className="mt-1 text-ink">{formatDateTime(recommendation.recommended_next_action_at)}</dd></div>
        <div><dt className="font-semibold text-ink/55">Intent</dt><dd className="mt-1 text-ink">{humanize(recommendation.intent)}</dd></div>
      </dl>
      <div className="mt-4">
        <p className="text-sm font-semibold text-ink/55">Why</p>
        <p className="mt-1 text-sm leading-6 text-ink/78">{recommendation.rationale}</p>
      </div>
      {recommendation.evidence_json?.length ? (
        <div className="mt-4">
          <p className="text-sm font-semibold text-ink/55">Evidence communication IDs</p>
          <div className="mt-2 flex flex-wrap gap-2">{recommendation.evidence_json.map((id) => <code className="rounded bg-white px-2 py-1 text-xs" key={typeof id === 'string' ? id : id.communicationId}>{typeof id === 'string' ? id : id.communicationId}</code>)}</div>
        </div>
      ) : null}
      {recommendation.blockers_json?.length ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">Blockers</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">{recommendation.blockers_json.map((item) => <li key={item}>{humanize(item)}</li>)}</ul>
        </div>
      ) : null}
      {recommendation.safety_flags_json?.length ? (
        <div className="mt-4 flex flex-wrap gap-2">{recommendation.safety_flags_json.map((item) => <Badge key={item} value="failed">{humanize(item)}</Badge>)}</div>
      ) : null}
      {recommendation.draft_subject || recommendation.draft_body_text ? (
        <div className="mt-4 rounded-xl border border-ink/10 bg-white p-4">
          <p className="text-sm font-semibold text-ink">Suggested draft — review required</p>
          <p className="mt-2 text-sm font-semibold text-ink/75">{recommendation.draft_subject}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/70">{recommendation.draft_body_text}</p>
        </div>
      ) : null}
      {!readOnly && current ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {recommendation.draft_body_text ? <button className={buttonPrimary} onClick={() => onCompose(recommendation)} type="button"><Mail className="h-4 w-4" aria-hidden="true" />Review draft</button> : null}
          <button className={buttonSecondary} disabled={pending} onClick={() => onDismiss(recommendation)} type="button">Dismiss recommendation</button>
        </div>
      ) : null}
    </section>
  );
}

function Thread({ communications }) {
  if (!communications.length) {
    return <div className="rounded-2xl border border-dashed border-ink/15 p-5 text-sm text-ink/60">No exact CRM email copy has been stored for this record yet.</div>;
  }
  return (
    <ol aria-label="CRM correspondence in chronological order" className="space-y-4">
      {communications.map((communication) => (
        <li key={communication.id}>
          <article className={`rounded-2xl border p-4 ${communication.direction === 'inbound' ? 'border-blue-200 bg-blue-50/55' : 'border-ink/10 bg-white'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap gap-2"><Badge value={communication.direction}>{humanize(communication.direction)}</Badge><Badge value={communication.delivery_state}>{humanize(communication.delivery_state)}</Badge><Badge value={communication.content_state}>{humanize(communication.content_state)}</Badge></div>
                <h4 className="mt-3 font-semibold text-ink">{communication.subject || '(No subject)'}</h4>
                <p className="mt-1 break-all text-xs text-ink/55">From {communication.from_address || 'Unknown'} · To {(communication.to_addresses || []).join(', ') || 'Unknown'}</p>
              </div>
              <time className="text-xs font-semibold text-ink/45" dateTime={communication.occurred_at}>{formatDateTime(communication.occurred_at)}</time>
            </div>
            {communication.legacy_content_unavailable ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">Legacy exact copy unavailable</div>
            ) : communication.content_state === 'pending' ? (
              <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">Full received content is still being retrieved.</div>
            ) : communication.content_state === 'failed' ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">Content retrieval failed and remains eligible for the bounded retry process.</div>
            ) : (
              <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-ink/78">{communication.body_text || '(No plain-text content stored)'}</p>
            )}
            {communication.attachment_metadata?.length ? (
              <div className="mt-4 border-t border-ink/8 pt-3">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Attachment metadata — contents not reviewed</p>
                <ul className="mt-2 space-y-1 text-sm text-ink/65">{communication.attachment_metadata.map((attachment, index) => <li className="flex gap-2" key={attachment.id || attachment.attachment_id || `${communication.id}-${index}`}><FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{attachment.name || attachment.filename || 'Attachment'}{attachment.content_type ? ` · ${attachment.content_type}` : ''}</li>)}</ul>
              </div>
            ) : null}
            {communication.in_reply_to ? <p className="mt-3 break-all text-[11px] text-ink/40">In-Reply-To: {communication.in_reply_to}</p> : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

function ComposePanel({ compose, context, onCancel, onChange, onPreview, onSend }) {
  const cimRequest = context.dealHunter?.cimRequest;
  const requiresTakeover = Boolean(cimRequest && !['stopped', 'completed'].includes(cimRequest.follow_up_state));
  const preview = compose.preview;
  if (compose.step === 'confirm' && preview) {
    return (
      <section aria-labelledby="confirm-email-title" className="rounded-2xl border-2 border-moss/25 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Final confirmation</p><h3 className="mt-1 text-xl font-semibold text-ink" id="confirm-email-title">Confirm this exact email once</h3></div>
          <button aria-label="Return to editing" className="rounded-full p-2 hover:bg-sand" onClick={() => onChange({ step: 'edit', confirmationChecked: false })} type="button"><X className="h-5 w-5" /></button>
        </div>
        <dl className="mt-5 grid gap-3 rounded-xl bg-sand/35 p-4 text-sm sm:grid-cols-2">
          <div><dt className="font-semibold text-ink/55">From</dt><dd className="mt-1 break-all">{preview.from}</dd></div>
          <div><dt className="font-semibold text-ink/55">To</dt><dd className="mt-1 break-all">{preview.to}</dd></div>
          <div><dt className="font-semibold text-ink/55">Reply-To</dt><dd className="mt-1 break-all">{preview.replyTo}</dd></div>
          <div><dt className="font-semibold text-ink/55">Threading</dt><dd className="mt-1">{preview.inReplyTo ? 'Verified RFC reply' : 'New message'}</dd></div>
          <div className="sm:col-span-2"><dt className="font-semibold text-ink/55">Subject</dt><dd className="mt-1 font-semibold">{preview.subject}</dd></div>
        </dl>
        <div className="mt-4 rounded-xl border border-ink/10 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Exact final plain text, including server footer</p>
          <p className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-sm leading-6 text-ink/75">{preview.bodyText}</p>
        </div>
        <details className="mt-4 rounded-xl border border-ink/10 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Safe generated HTML preview</summary>
          <div className="prose prose-sm mt-4 max-w-none" dangerouslySetInnerHTML={{ __html: preview.bodyHtmlSanitized }} />
        </details>
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          After provider acceptance: {humanize(compose.nextFollowUpState)}{compose.nextActionAt ? ` · ${formatDateTime(compose.nextActionAt)}` : ' · no next action date'}.
          {requiresTakeover ? ' The linked Deal Hunter sequence will be stopped atomically and this manual touch will count in reporting.' : ''}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-ink/10 p-3 text-sm font-semibold text-ink">
          <input checked={compose.confirmationChecked} className="mt-1 h-4 w-4" onChange={(event) => onChange({ confirmationChecked: event.target.checked })} type="checkbox" />
          <span>I reviewed the exact recipient, subject, body, threading, automation takeover, and next CRM action. Queue this email once.</span>
        </label>
        {compose.error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{compose.error}</div> : null}
        <div className="mt-5 flex flex-wrap gap-3">
          <button className={buttonPrimary} disabled={!compose.confirmationChecked || compose.pending} onClick={onSend} type="button">{compose.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Queue one email</button>
          <button className={buttonSecondary} disabled={compose.pending} onClick={() => onChange({ step: 'edit', confirmationChecked: false })} type="button">Edit again</button>
          <button className={buttonSecondary} disabled={compose.pending} onClick={onCancel} type="button">Cancel</button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="compose-email-title" className="rounded-2xl border-2 border-moss/20 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Dedicated email action</p><h3 className="mt-1 text-xl font-semibold text-ink" id="compose-email-title">Review and compose</h3><p className="mt-1 text-sm text-ink/60">This is separate from Log Communication. Previewing and editing cannot send.</p></div>
        <button aria-label="Close email composer" className="rounded-full p-2 hover:bg-sand" onClick={onCancel} type="button"><X className="h-5 w-5" /></button>
      </div>
      {!context.policy.email.ready ? (
        <div className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>Sending is unavailable: {(context.policy.email.blockers || []).map(humanize).join(', ')}. Drafts remain local to this form until a successful server preview.</span></div>
      ) : null}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold text-ink">From<input className={`${inputClass} mt-1 bg-sand/30`} readOnly value={context.policy.sender?.from || 'Not configured'} /></label>
        <label className="text-sm font-semibold text-ink">Reply-To<input className={`${inputClass} mt-1 bg-sand/30`} readOnly value={context.policy.sender?.replyTo || 'Not configured'} /></label>
      </div>
      <div className="mt-4">
        <label className="text-sm font-semibold text-ink" htmlFor="follow-up-recipient">To</label>
        {!compose.recipientOverride ? (
          <select className={`${inputClass} mt-1`} id="follow-up-recipient" onChange={(event) => onChange({ recipient: event.target.value })} value={compose.recipient}>
            <option value="">Choose one validated contact</option>
            {context.recipients.map((recipient) => <option key={recipient.email} value={recipient.email}>{recipient.label || humanize(recipient.source)} — {recipient.email}</option>)}
          </select>
        ) : <input className={`${inputClass} mt-1`} id="follow-up-recipient" onChange={(event) => onChange({ recipient: event.target.value })} placeholder="corrected@example.com" type="email" value={compose.recipient} />}
        <button className="mt-2 text-xs font-semibold text-moss underline" onClick={() => onChange({ recipientOverride: !compose.recipientOverride, recipient: '', recipientOverrideReason: '' })} type="button">{compose.recipientOverride ? 'Use a validated CRM contact' : 'Use a corrected address with an audit warning'}</button>
        {compose.recipientOverride ? <label className="mt-3 block text-sm font-semibold text-ink">Required correction reason<textarea className={`${inputClass} mt-1 min-h-20`} onChange={(event) => onChange({ recipientOverrideReason: event.target.value })} value={compose.recipientOverrideReason} /></label> : null}
      </div>
      <label className="mt-4 block text-sm font-semibold text-ink">Subject<input className={`${inputClass} mt-1`} maxLength={300} onChange={(event) => onChange({ subject: event.target.value })} value={compose.subject} /></label>
      <label className="mt-4 block text-sm font-semibold text-ink">Plain-text body<textarea className={`${inputClass} mt-1 min-h-56 resize-y leading-6`} maxLength={20000} onChange={(event) => onChange({ bodyText: event.target.value })} value={compose.bodyText} /></label>
      <p className="mt-1 text-right text-xs text-ink/45">{compose.bodyText.length.toLocaleString()} / 20,000 · server footer is appended after this text</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold text-ink">After acceptance<select className={`${inputClass} mt-1`} onChange={(event) => onChange({ nextFollowUpState: event.target.value })} value={compose.nextFollowUpState}><option value="waiting-on-owner">Waiting on owner</option><option value="scheduled">Scheduled</option><option value="needs-response">Needs response</option><option value="completed">Completed</option></select></label>
        <label className="text-sm font-semibold text-ink">Next CRM action<input className={`${inputClass} mt-1`} onChange={(event) => onChange({ nextActionAt: event.target.value })} type="datetime-local" value={compose.nextActionAt} /></label>
      </div>
      {compose.parentCommunicationId ? <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">This draft requests a true reply. The server will verify the parent belongs to this CRM thread, recipient, and RFC Message-ID before previewing.</div> : null}
      {requiresTakeover ? <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900"><input checked={compose.manualTakeoverAcknowledged} className="mt-1 h-4 w-4" onChange={(event) => onChange({ manualTakeoverAcknowledged: event.target.checked })} type="checkbox" /><span>I understand this manual email will atomically stop the active Deal Hunter follow-up sequence and count as a sequence touch.</span></label> : null}
      {compose.error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{compose.error}</div> : null}
      <div className="mt-5 flex flex-wrap gap-3"><button className={buttonPrimary} disabled={compose.pending || !compose.recipient || !compose.subject.trim() || !compose.bodyText.trim() || (compose.recipientOverride && !compose.recipientOverrideReason.trim()) || (requiresTakeover && !compose.manualTakeoverAcknowledged)} onClick={onPreview} type="button">{compose.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailQuestion className="h-4 w-4" />}Preview exact server email</button><button className={buttonSecondary} disabled={compose.pending} onClick={onCancel} type="button">Cancel</button></div>
    </section>
  );
}

function DetailDrawer({ record, readOnly, onClose, onQueueRefresh }) {
  const closeRef = useRef(null);
  const drawerRef = useRef(null);
  const previousFocusRef = useRef(null);
  const composePendingRef = useRef(false);
  const [state, setState] = useState({ loading: !readOnly, error: '', context: null, pending: '' });
  const [compose, setCompose] = useState(emptyCompose);
  const [liveMessage, setLiveMessage] = useState('');
  const [snoozeAt, setSnoozeAt] = useState(localDateTimeValue(record.next_action_at));
  const [suppression, setSuppression] = useState({ reason: '', liftReason: '', confirmed: false, pending: false, error: '' });

  const loadContext = useCallback(async () => {
    if (readOnly) return;
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/context?communicationPageSize=100`);
      setState({ loading: false, error: '', context: result.context, pending: '' });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [readOnly, record.id]);

  useEffect(() => {
    composePendingRef.current = compose.pending;
  }, [compose.pending]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !composePendingRef.current) onClose();
      if (event.key === 'Tab' && drawerRef.current) {
        const focusable = Array.from(drawerRef.current.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hasAttribute('hidden')
          && element.getClientRects().length > 0
          && window.getComputedStyle(element).visibility !== 'hidden');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    loadContext();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [loadContext, onClose]);

  const context = state.context;
  const updateCompose = (values) => setCompose((current) => ({ ...current, ...values, error: values.error ?? '' }));

  const generateRecommendation = async () => {
    setState((current) => ({ ...current, pending: 'recommendation' }));
    setLiveMessage('Generating a bounded recommendation. No email will be sent.');
    try {
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/recommendations`, { method: 'POST', body: '{}' });
      setState((current) => ({ ...current, pending: '', context: { ...current.context, recommendation: result.recommendation } }));
      setLiveMessage(result.cached ? 'Current recommendation reused from its complete input fingerprint.' : 'Recommendation generated. No email was sent.');
    } catch (error) {
      setState((current) => ({ ...current, pending: '', error: error.message }));
      setLiveMessage(`Recommendation failed: ${error.message}`);
    }
  };

  const loadOlderCommunications = async () => {
    if (!context || state.pending === 'older-communications') return;
    const nextPage = Number(context.communicationPage || 1) + 1;
    setState((current) => ({ ...current, pending: 'older-communications' }));
    setLiveMessage('Loading older CRM communications.');
    try {
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/context?communicationPage=${nextPage}&communicationPageSize=100`);
      setState((current) => {
        const existing = current.context?.communications || [];
        const seen = new Set(existing.map((item) => item.id));
        const older = (result.context?.communications || []).filter((item) => !seen.has(item.id));
        return {
          ...current,
          pending: '',
          context: {
            ...current.context,
            communicationPage: nextPage,
            communicationPageSize: 100,
            communicationTotal: Number(result.context?.communicationTotal || current.context?.communicationTotal || 0),
            communications: [...older, ...existing],
          },
        };
      });
      setLiveMessage('Older CRM communications loaded in chronological order.');
    } catch (error) {
      setState((current) => ({ ...current, pending: '' }));
      setLiveMessage(`Older communications could not be loaded: ${error.message}`);
    }
  };

  const openCompose = (recommendation = null, preferReply = false) => {
    const communications = context?.communications || [];
    const latestInbound = [...communications].reverse().find((item) => item.direction === 'inbound');
    const replyParent = preferReply || recommendation?.thread_parent_communication_id
      ? communications.find((item) => item.id === recommendation?.thread_parent_communication_id) || latestInbound
      : null;
    const verifiedReplyParent = replyParent?.message_id ? replyParent : null;
    const defaultRecipient = replyParent?.from_address?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
      || context?.recipients?.[0]?.email
      || '';
    let subject = recommendation?.draft_subject
      || (verifiedReplyParent?.subject ? `Re: ${verifiedReplyParent.subject.replace(/^\s*re\s*:\s*/i, '')}` : '');
    if (!verifiedReplyParent && /^\s*(?:re|fw|fwd)\s*:/i.test(subject)) {
      subject = `Regarding ${subject.replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim()}`;
    }
    setCompose({
      ...emptyCompose(),
      open: true,
      recipient: defaultRecipient,
      subject,
      bodyText: recommendation?.draft_body_text || '',
      parentCommunicationId: verifiedReplyParent?.id || '',
      recommendationId: recommendation?.id || '',
      nextActionAt: localDateTimeValue(recommendation?.recommended_next_action_at || record.next_action_at),
      manualTakeoverAcknowledged: false,
    });
    setTimeout(() => document.getElementById('follow-up-recipient')?.focus(), 0);
  };

  const previewEmail = async () => {
    setCompose((current) => ({ ...current, pending: true, error: '' }));
    setLiveMessage('Validating the exact email preview. Nothing is being sent.');
    try {
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/email-preview`, {
        method: 'POST',
        body: JSON.stringify({
          expectedSubmissionVersion: context.submission.updated_at,
          recipient: compose.recipient,
          subject: compose.subject,
          bodyText: compose.bodyText,
          parentCommunicationId: compose.parentCommunicationId || null,
          confirmRecipientOverride: compose.recipientOverride,
          recipientOverrideReason: compose.recipientOverrideReason,
          recommendationId: compose.recommendationId || null,
          nextFollowUpState: compose.nextFollowUpState,
          nextActionAt: compose.nextActionAt ? new Date(compose.nextActionAt).toISOString() : null,
          cimRequestId: context.dealHunter?.cimRequest?.id || null,
          dealKey: context.dealHunter?.dealKey || null,
          manualTakeoverAcknowledged: compose.manualTakeoverAcknowledged,
        }),
      });
      setCompose((current) => ({
        ...current,
        pending: false,
        step: 'confirm',
        preview: result.preview,
        clientRequestToken: current.clientRequestToken || window.crypto.randomUUID(),
        confirmationChecked: false,
      }));
      setLiveMessage('Exact server preview ready. Review and confirm once to queue it.');
    } catch (error) {
      setCompose((current) => ({ ...current, pending: false, error: error.message }));
      setLiveMessage(`Preview blocked: ${error.message}`);
      if (error.status === 409 && error.result?.submission) setState((current) => ({ ...current, context: { ...current.context, submission: error.result.submission } }));
    }
  };

  const sendEmail = async () => {
    setCompose((current) => ({ ...current, pending: true, error: '' }));
    setLiveMessage('The immutable command is being saved before provider transmission.');
    try {
      const cimRequest = context.dealHunter?.cimRequest;
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/send-email`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestToken: compose.clientRequestToken,
          previewConfirmationToken: compose.preview?.confirmationToken || null,
          previewConfirmationExpiresAt: compose.preview?.confirmationExpiresAt || null,
          expectedSubmissionVersion: context.submission.updated_at,
          recipient: compose.recipient,
          subject: compose.subject,
          bodyText: compose.bodyText,
          parentCommunicationId: compose.parentCommunicationId || null,
          confirmRecipientOverride: compose.recipientOverride,
          recipientOverrideReason: compose.recipientOverrideReason,
          recommendationId: compose.recommendationId || null,
          nextFollowUpState: compose.nextFollowUpState,
          nextActionAt: compose.nextActionAt ? new Date(compose.nextActionAt).toISOString() : null,
          cimRequestId: cimRequest?.id || null,
          dealKey: context.dealHunter?.dealKey || null,
          manualTakeoverAcknowledged: compose.manualTakeoverAcknowledged,
        }),
      });
      const accepted = result.outbox?.state === 'accepted';
      setCompose(emptyCompose());
      setLiveMessage(accepted
        ? 'Provider accepted the email. Delivery is still pending lifecycle confirmation.'
        : `Email command state: ${humanize(result.outbox?.state || 'queued')}.`);
      await loadContext();
      onQueueRefresh();
    } catch (error) {
      const outboxState = error.result?.outbox?.state;
      setCompose((current) => ({ ...current, pending: false, error: outboxState === 'ambiguous'
        ? 'The provider result is ambiguous. Do not submit another email; use this same command for reconciliation.'
        : error.message }));
      setLiveMessage(`Email not confirmed as accepted: ${error.message}`);
      if (error.status === 409) await loadContext();
    }
  };

  const workflowAction = async (action) => {
    setState((current) => ({ ...current, pending: action }));
    try {
      const result = await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/workflow`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          expectedSubmissionVersion: context.submission.updated_at,
          nextActionAt: snoozeAt ? new Date(snoozeAt).toISOString() : null,
        }),
      });
      setState((current) => ({ ...current, pending: '', context: { ...current.context, submission: result.submission, recommendation: null } }));
      setLiveMessage(action === 'complete' ? 'Follow-up marked complete.' : 'Follow-up rescheduled.');
      onQueueRefresh();
    } catch (error) {
      setState((current) => ({ ...current, pending: '', error: error.message }));
      setLiveMessage(`Workflow update failed: ${error.message}`);
      if (error.status === 409) await loadContext();
    }
  };

  const dismissRecommendation = async (recommendation) => {
    setState((current) => ({ ...current, pending: 'dismiss' }));
    try {
      await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/recommendations/${encodeURIComponent(recommendation.id)}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ expectedSubmissionVersion: context.submission.updated_at }),
      });
      setState((current) => ({ ...current, pending: '', context: { ...current.context, recommendation: null } }));
      setLiveMessage('Recommendation dismissed. No email was sent.');
      onQueueRefresh();
    } catch (error) {
      setState((current) => ({ ...current, pending: '', error: error.message }));
    }
  };

  const createSuppression = async () => {
    const email = context.recipients?.[0]?.email;
    setSuppression((current) => ({ ...current, pending: true, error: '' }));
    try {
      await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/suppressions`, {
        method: 'POST',
        body: JSON.stringify({ email, reason: suppression.reason, confirmed: suppression.confirmed }),
      });
      setSuppression({ reason: '', liftReason: '', confirmed: false, pending: false, error: '' });
      setLiveMessage(`${email} is now globally suppressed across CRM and Deal Hunter outreach.`);
      await loadContext();
      onQueueRefresh();
    } catch (error) {
      setSuppression((current) => ({ ...current, pending: false, error: error.message }));
    }
  };

  const liftSuppression = async (email) => {
    setSuppression((current) => ({ ...current, pending: true, error: '' }));
    try {
      await requestJson(`/api/admin/follow-ups/${encodeURIComponent(record.id)}/suppressions/lift`, {
        method: 'POST',
        body: JSON.stringify({ email, liftReason: suppression.liftReason, confirmed: suppression.confirmed }),
      });
      setSuppression({ reason: '', liftReason: '', confirmed: false, pending: false, error: '' });
      setLiveMessage(`${email} suppression was lifted with an audit record.`);
      await loadContext();
      onQueueRefresh();
    } catch (error) {
      setSuppression((current) => ({ ...current, pending: false, error: error.message }));
    }
  };

  return (
    <div aria-labelledby="follow-up-detail-title" aria-modal="true" className="fixed inset-0 z-50 flex justify-end bg-ink/35 backdrop-blur-[2px]" ref={drawerRef} role="dialog">
      <div className="h-full w-full overflow-y-auto bg-[#fbfaf7] shadow-2xl sm:max-w-3xl xl:max-w-4xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink/10 bg-[#fbfaf7]/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Follow-Up detail</p><h2 className="mt-1 truncate text-xl font-semibold text-ink" id="follow-up-detail-title">{record.company || record.name}</h2><p className="mt-1 truncate text-sm text-ink/55">{record.broker_email || record.seller_email || record.email}</p></div>
          <button aria-label="Close follow-up detail" className="rounded-full border border-ink/10 bg-white p-2 text-ink hover:text-moss" onClick={onClose} ref={closeRef} type="button"><X className="h-5 w-5" /></button>
        </header>
        <div aria-atomic="true" aria-live="polite" className="sr-only">{liveMessage}</div>
        {liveMessage ? <div className="mx-4 mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 sm:mx-6">{liveMessage}</div> : null}
        {readOnly ? (
          <div className="p-4 sm:p-6"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-900"><ShieldAlert className="mb-3 h-5 w-5" /><p className="font-semibold">Full administrator access is required</p><p className="mt-1">The queue summary is available to viewers, but exact email bodies, AI-enriched recommendations, drafting, sending, suppression, and workflow mutations are restricted.</p></div><a className={`${buttonSecondary} mt-4`} href={`/admin/crm?search=${encodeURIComponent(record.company || record.email || record.id)}`}><ExternalLink className="h-4 w-4" />Open CRM search</a></div>
        ) : state.loading ? (
          <div className="flex min-h-80 items-center justify-center gap-3 p-8 text-sm text-ink/60"><Loader2 className="h-5 w-5 animate-spin" />Loading bounded CRM context…</div>
        ) : state.error && !context ? (
          <div className="p-6"><div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{state.error}</div><button className={`${buttonSecondary} mt-4`} onClick={loadContext} type="button"><RefreshCw className="h-4 w-4" />Retry</button></div>
        ) : context ? (
          <div className="space-y-6 p-4 pb-12 sm:p-6">
            {compose.open ? <ComposePanel compose={compose} context={context} onCancel={() => setCompose(emptyCompose())} onChange={updateCompose} onPreview={previewEmail} onSend={sendEmail} /> : null}
            <section className="rounded-2xl border border-ink/10 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">CRM facts</p><h3 className="mt-1 text-lg font-semibold text-ink">{context.submission.company || context.submission.name}</h3><p className="mt-1 text-sm text-ink/60">Version {context.submission.updated_at}</p></div>
                <div className="flex flex-wrap gap-2"><Badge value={context.submission.status}>{humanize(context.submission.status)}</Badge><Badge value={context.submission.follow_up_state}>{humanize(context.submission.follow_up_state)}</Badge><Badge>{humanize(context.submission.priority)}</Badge></div>
              </div>
              <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3"><div><dt className="font-semibold text-ink/50">Next action</dt><dd className="mt-1">{formatDateTime(context.submission.next_action_at)}</dd></div><div><dt className="font-semibold text-ink/50">Assigned</dt><dd className="mt-1">{context.submission.assigned_to || 'Unassigned'}</dd></div><div><dt className="font-semibold text-ink/50">Deal Hunter</dt><dd className="mt-1">{context.dealHunter.linked ? `Linked · score ${context.dealHunter.score ?? 'unavailable'}` : 'Not linked'}</dd></div></dl>
              {context.dealHunter.linked ? <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950"><p className="font-semibold">Deal Hunter context</p><p className="mt-1">Listing claims remain unverified until supported by a current source. CIM state: {humanize(context.dealHunter.cimRequest?.request_state || 'none')} · delivery: {humanize(context.dealHunter.cimRequest?.delivery_state || 'none')} · follow-ups: {context.dealHunter.cimRequest?.follow_up_count || 0}.</p>{context.dealHunter.concerns.length ? <p className="mt-2">Concerns: {context.dealHunter.concerns.join('; ')}</p> : null}</div> : null}
              <div className="mt-5 flex flex-wrap gap-3"><button className={buttonPrimary} disabled={compose.open || Boolean(context.suppressions.length)} onClick={() => openCompose(context.recommendation)} type="button"><Mail className="h-4 w-4" />Compose</button><button className={buttonSecondary} disabled={compose.open || ![...context.communications].reverse().some((item) => item.direction === 'inbound' && item.message_id)} onClick={() => openCompose(context.recommendation, true)} type="button">Reply</button><a className={buttonSecondary} href={`/admin/crm?search=${encodeURIComponent(context.submission.company || context.submission.email || context.submission.id)}`}><ExternalLink className="h-4 w-4" />Open CRM record</a></div>
            </section>

            {context.suppressions.length ? <section className="rounded-2xl border border-red-200 bg-red-50 p-5"><div className="flex gap-3"><CircleStop className="mt-0.5 h-5 w-5 shrink-0 text-red-700" /><div><h3 className="font-semibold text-red-900">Global suppression active</h3>{context.suppressions.map((item) => <p className="mt-1 text-sm text-red-800" key={item.id}>{item.normalized_email} · {humanize(item.reason)} · {formatDateTime(item.created_at)}</p>)}</div></div><label className="mt-4 block text-sm font-semibold text-red-900">Audited lift reason<textarea className={`${inputClass} mt-1 min-h-20`} onChange={(event) => setSuppression((current) => ({ ...current, liftReason: event.target.value }))} value={suppression.liftReason} /></label><label className="mt-3 flex items-start gap-2 text-sm font-semibold text-red-900"><input checked={suppression.confirmed} className="mt-1" onChange={(event) => setSuppression((current) => ({ ...current, confirmed: event.target.checked }))} type="checkbox" />I confirm lifting this suppression is legally and operationally appropriate.</label><button className={`${buttonSecondary} mt-4`} disabled={!suppression.confirmed || !suppression.liftReason.trim() || suppression.pending} onClick={() => liftSuppression(context.suppressions[0].normalized_email)} type="button">Lift suppression with audit</button>{suppression.error ? <p className="mt-3 text-sm text-red-800">{suppression.error}</p> : null}</section> : null}

            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Decision support</p><h3 className="mt-1 text-lg font-semibold text-ink">Recommended next action</h3></div><button className={buttonSecondary} disabled={state.pending === 'recommendation'} onClick={generateRecommendation} type="button">{state.pending === 'recommendation' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{context.recommendation ? 'Refresh inputs' : 'Review recommendation'}</button></div>
              <RecommendationPanel onCompose={openCompose} onDismiss={dismissRecommendation} pending={Boolean(state.pending)} readOnly={readOnly} recommendation={context.recommendation} />
            </section>

            <section className="rounded-2xl border border-ink/10 bg-white p-5">
              <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Workflow</p><h3 className="mt-1 text-lg font-semibold text-ink">Snooze or complete</h3></div><Badge>{humanize(context.submission.follow_up_state)}</Badge></div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"><label className="flex-1 text-sm font-semibold text-ink">Next action<input className={`${inputClass} mt-1`} onChange={(event) => setSnoozeAt(event.target.value)} type="datetime-local" value={snoozeAt} /></label><button className={buttonSecondary} disabled={!snoozeAt || Boolean(state.pending)} onClick={() => workflowAction('snooze')} type="button"><CalendarClock className="h-4 w-4" />Snooze</button><button className={buttonSecondary} disabled={Boolean(state.pending) || context.submission.follow_up_state === 'completed'} onClick={() => workflowAction('complete')} type="button"><CheckCircle2 className="h-4 w-4" />Mark complete</button></div>
            </section>

            {!context.suppressions.length && context.recipients.length ? <details className="rounded-2xl border border-red-200 bg-white p-5"><summary className="cursor-pointer font-semibold text-red-800">Create global suppression</summary><p className="mt-2 text-sm leading-6 text-ink/65">This immediately blocks the primary address across generic CRM and Deal Hunter outreach. It does not archive the CRM record.</p><label className="mt-4 block text-sm font-semibold text-ink">Reason<textarea className={`${inputClass} mt-1 min-h-20`} onChange={(event) => setSuppression((current) => ({ ...current, reason: event.target.value }))} value={suppression.reason} /></label><label className="mt-3 flex items-start gap-2 text-sm font-semibold text-red-900"><input checked={suppression.confirmed} className="mt-1" onChange={(event) => setSuppression((current) => ({ ...current, confirmed: event.target.checked }))} type="checkbox" />Suppress {context.recipients[0].email} from all future outreach.</label><button className={`${buttonSecondary} mt-4`} disabled={!suppression.confirmed || !suppression.reason.trim() || suppression.pending} onClick={createSuppression} type="button"><CircleStop className="h-4 w-4" />Create audited suppression</button>{suppression.error ? <p className="mt-3 text-sm text-red-800">{suppression.error}</p> : null}</details> : null}

            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Canonical correspondence</p><h3 className="mt-1 text-lg font-semibold text-ink">CRM email chronology</h3></div><span className="text-sm text-ink/55">Showing {context.communications.length} of {context.communicationTotal} communication{context.communicationTotal === 1 ? '' : 's'}</span></div>
              {context.communications.length < context.communicationTotal ? <button className={`${buttonSecondary} mb-3`} disabled={state.pending === 'older-communications'} onClick={loadOlderCommunications} type="button">{state.pending === 'older-communications' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}Load older communications</button> : null}
              <Thread communications={context.communications} />
            </section>

            {context.outbox.length ? <section><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink/45">Recent durable email commands</p><div className="mt-3 space-y-2">{context.outbox.map((item) => <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-white p-3 text-sm" key={item.id}><span>{formatDateTime(item.created_at)} · {item.attempt_count} attempt{item.attempt_count === 1 ? '' : 's'}</span><Badge value={item.state}>{item.state === 'accepted' ? 'Provider accepted · delivery pending' : humanize(item.state)}</Badge></div>)}</div></section> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function FollowUpsWorkspace({ readOnly = false }) {
  const [query, setQuery] = useState({ view: initialQueueView(), search: '', page: 1, pageSize: 25, sort: 'urgency', direction: 'desc' });
  const [searchInput, setSearchInput] = useState('');
  const [state, setState] = useState({ loading: true, error: '', items: [], total: 0, totalPages: 1, summary: null });
  const [selected, setSelected] = useState(null);
  const requestSequence = useRef(0);
  const closeDetail = useCallback(() => setSelected(null), []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery((current) => ({ ...current, search: searchInput.trim(), page: 1 })), 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const loadQueue = useCallback(async () => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    const parameters = new URLSearchParams({
      view: query.view,
      search: query.search,
      page: String(query.page),
      pageSize: String(query.pageSize),
      sort: query.sort,
      direction: query.direction,
    });
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await requestJson(`/api/admin/follow-ups?${parameters.toString()}`);
      if (requestSequence.current !== sequence) return;
      setState({
        loading: false,
        error: '',
        items: result.items || [],
        total: Number(result.total || 0),
        totalPages: Number(result.totalPages || 1),
        summary: result.summary || null,
      });
      if (result.page !== query.page) setQuery((current) => ({ ...current, page: result.page }));
    } catch (error) {
      if (requestSequence.current !== sequence) return;
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [query.direction, query.page, query.pageSize, query.search, query.sort, query.view]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const pageStart = state.total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const pageEnd = Math.min(query.page * query.pageSize, state.total);
  const selectedViewLabel = useMemo(() => views.find(([id]) => id === query.view)?.[1] || 'Follow-Ups', [query.view]);

  return (
    <section className="section-shell mt-8 pb-8">
      <div className="panel overflow-hidden">
        <div className="border-b border-ink/10 p-5 sm:p-7">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Human-reviewed workspace</p><h2 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">Follow-Up decisions and email actions</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ink/65">Review facts, chronology, safety policy, and a traceable recommendation before composing one email. Page loads, recommendations, previews, and drafts cannot send.</p></div>
            <div className="flex flex-wrap gap-2"><Badge>{state.total} filtered</Badge>{state.summary?.total !== undefined ? <Badge>{state.summary.total} CRM records</Badge> : null}{readOnly ? <Badge value="delayed">Viewer · queue summaries only</Badge> : <Badge value="delivered">Admin actions enabled</Badge>}</div>
          </div>
          <div aria-label="Follow-up queue filters" className="mt-5 flex gap-2 overflow-x-auto pb-2" role="tablist">
            {views.map(([id, label]) => <button aria-selected={query.view === id} className={`shrink-0 rounded-full border px-3 py-2 text-sm font-semibold transition ${query.view === id ? 'border-moss bg-moss text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-moss/30 hover:text-moss'}`} key={id} onClick={() => setQuery((current) => ({ ...current, view: id, page: 1 }))} role="tab" type="button">{label}</button>)}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_150px_auto]">
            <label className="relative"><span className="sr-only">Search follow-ups</span><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-ink/40" /><input className={`${inputClass} pl-9`} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search company, contact, email, subject, URL, or deal key" type="search" value={searchInput} /></label>
            <label><span className="sr-only">Sort follow-ups</span><select className={inputClass} onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value, page: 1 }))} value={query.sort}><option value="urgency">Safety and urgency</option><option value="next_action_at">Next action</option><option value="updated_at">Recently updated</option><option value="company">Company</option><option value="priority">CRM priority</option><option value="created_at">Created</option></select></label>
            <label><span className="sr-only">Sort direction</span><select className={inputClass} disabled={query.sort === 'urgency'} onChange={(event) => setQuery((current) => ({ ...current, direction: event.target.value, page: 1 }))} value={query.direction}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
            <button aria-label="Refresh follow-up queue" className={buttonSecondary} disabled={state.loading} onClick={loadQueue} type="button"><RefreshCw className={`h-4 w-4 ${state.loading ? 'animate-spin' : ''}`} />Refresh</button>
          </div>
        </div>

        <div aria-live="polite">
          {state.loading ? <div className="flex min-h-64 items-center justify-center gap-3 p-8 text-sm text-ink/60"><Loader2 className="h-5 w-5 animate-spin" />Loading {selectedViewLabel.toLowerCase()}…</div> : null}
          {!state.loading && state.error ? <div className="m-5 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><div className="flex gap-2"><AlertTriangle className="h-5 w-5 shrink-0" /><span>{state.error}</span></div><button className={`${buttonSecondary} mt-4`} onClick={loadQueue} type="button">Retry queue</button></div> : null}
          {!state.loading && !state.error && state.items.length === 0 ? <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center"><Inbox className="h-9 w-9 text-moss/55" /><h3 className="mt-4 text-lg font-semibold text-ink">No records match {selectedViewLabel.toLowerCase()}</h3><p className="mt-2 max-w-xl text-sm leading-6 text-ink/60">Try another filter or clear the search. No background recommendation or email action runs for an empty queue.</p>{query.search ? <button className={`${buttonSecondary} mt-4`} onClick={() => setSearchInput('')} type="button">Clear search</button> : null}</div> : null}
          {!state.loading && !state.error && state.items.length ? <div>{state.items.map((record) => <QueueRow key={record.id} onOpen={setSelected} record={record} />)}</div> : null}
        </div>

        {!state.loading && !state.error && state.total > 0 ? <div className="flex flex-col gap-3 border-t border-ink/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-ink/60">Showing {pageStart}–{pageEnd} of {state.total} filtered records</p><div className="flex items-center gap-2"><label className="text-sm text-ink/60">Rows <select className="ml-1 rounded-lg border border-ink/10 bg-white px-2 py-1" onChange={(event) => setQuery((current) => ({ ...current, pageSize: Number(event.target.value), page: 1 }))} value={query.pageSize}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><button aria-label="Previous follow-up page" className={buttonSecondary} disabled={query.page <= 1} onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))} type="button"><ArrowLeft className="h-4 w-4" /></button><span className="min-w-20 text-center text-sm font-semibold text-ink">{query.page} / {state.totalPages}</span><button aria-label="Next follow-up page" className={buttonSecondary} disabled={query.page >= state.totalPages} onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))} type="button"><ArrowRight className="h-4 w-4" /></button></div></div> : null}
      </div>
      {selected ? <DetailDrawer key={selected.id} onClose={closeDetail} onQueueRefresh={loadQueue} readOnly={readOnly} record={selected} /> : null}
    </section>
  );
}
