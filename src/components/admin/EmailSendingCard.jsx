import React, { useCallback, useEffect, useRef, useState } from 'react';

const STATUS_URL = '/api/admin/deal-hunter/email-sending';
const CONTROLS_URL = '/api/admin/deal-hunter/email-sending/controls';
const CONNECT_URL = '/api/admin/deal-hunter/gmail/connect';
const DISCONNECT_URL = '/api/admin/deal-hunter/gmail/disconnect';

// One plain sentence per readiness code (spec §4.4, Ruling F).
export const READINESS_SENTENCES = Object.freeze({
  gmail_not_connected: "Gmail isn't connected.",
  gmail_token_invalid: 'Google access was revoked or expired — reconnect Gmail.',
  gmail_token_refresh_failed: "Couldn't reach Google just now; it will retry.",
  gmail_address_mismatch: "The connected mailbox isn't the configured sending address.",
  wording_not_approved: "The email wording isn't approved.",
  contact_rule_off: 'The contact rule is off.',
  live_sending_off: 'Live sending is off.',
  signature_incomplete: 'Your name, title, phone, or mailing address is missing from settings.',
});

// The `gmail` query value the connect callback redirects back with.
const CONNECT_RESULTS = Object.freeze({
  connected: { tone: 'ok', text: 'Gmail is connected.' },
  gmail_state_invalid: { tone: 'warn', text: 'The Google sign-in expired or was already used. Click Connect Gmail to try again.' },
  gmail_address_mismatch: { tone: 'warn', text: "That Google account isn't the configured sending address. Connect Gmail again and choose the sending address." },
  gmail_scope_missing: { tone: 'warn', text: "Google didn't grant permission to both send and read email. Connect Gmail again and allow both." },
  gmail_connect_failed: { tone: 'warn', text: "Gmail couldn't be connected. Check the Google settings in the Gmail setup runbook, then try again." },
});

const RECONNECT_REASONS = new Set(['gmail_token_invalid', 'gmail_address_mismatch']);

const buttonBase = 'inline-flex min-h-9 items-center justify-center rounded-full border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton = `${buttonBase} border-moss bg-moss text-white hover:bg-pine`;
const secondaryButton = `${buttonBase} border-line bg-white text-ink hover:border-moss/35 hover:text-moss`;
const dangerButton = `${buttonBase} border-red-200 bg-red-50 text-red-800 hover:border-red-300`;

function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not recorded'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function shortDigest(value) {
  return value ? `${String(value).slice(0, 12)}…` : 'none';
}

// `code` comes from the router when the parent has one; otherwise from the page URL.
function connectResult(code = typeof window === 'undefined'
  ? null : new URLSearchParams(window.location.search).get('gmail')) {
  if (!code) return null;
  return CONNECT_RESULTS[code] || { tone: 'warn', text: "Gmail couldn't be connected. Try Connect Gmail again." };
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function runLine(run, kind) {
  if (!run) return 'No run recorded yet.';
  const counts = run.counts || {};
  const parts = kind === 'sender'
    ? [plural(counts.sentInitial || 0, 'initial email', 'initial emails'),
      plural(counts.sentFollowUps || 0, 'follow-up', 'follow-ups'), `${counts.expired || 0} expired`]
    : [plural(counts.processed || 0, 'message checked', 'messages checked'), `${counts.responded || 0} replies`,
      `${counts.stopped || 0} stopped`];
  const notes = [];
  if (run.stoppedFor) notes.push(`stopped early: ${run.stoppedFor}`);
  if (run.error) notes.push(`error: ${run.error}`);
  return `${run.status} · ${formatDate(run.updatedAt)} · ${parts.join(' · ')}${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
}

// Copy for each confirmation. `run` performs the request the dialog guards.
function confirmation(action, data) {
  switch (action.kind) {
    case 'wording':
      return { title: 'Approve this wording?', confirmLabel: 'Approve wording',
        body: 'Every Pursue email will use the wording in the preview, with your signature. Any later change to the wording or your signature pauses sending until you approve it again.' };
    case 'contact_rule':
      return action.enabled
        ? { title: 'Turn on the contact rule?', confirmLabel: 'Turn on contact rule',
          body: "The app may email a listing's broker once about that listing without asking you about each broker first. Generic mailboxes, suppressed addresses and brokers already contacted about the listing are skipped." }
        : { title: 'Turn off the contact rule?', confirmLabel: 'Turn off contact rule',
          body: 'Brokers need your approval one at a time again. Campaigns started under the rule pause until you turn it back on.' };
    case 'live_sending':
      return action.enabled
        ? { title: 'Turn on Live sending?', confirmLabel: 'Turn on Live sending',
          body: `Pursue emails and follow-ups will be sent from ${data?.gmail?.emailAddress || 'your Gmail'} on schedule whenever everything else below is ready.` }
        : { title: 'Turn off Live sending?', confirmLabel: 'Turn off Live sending',
          body: 'No more Pursue emails or follow-ups will be sent. Emails that were about to go out go back on schedule and wait until Live sending is on again.' };
    case 'disconnect':
      return { title: 'Disconnect Gmail?', confirmLabel: 'Disconnect', withoutReason: true,
        body: 'Sending and reply checks stop until you connect Gmail again.' };
    default:
      return null;
  }
}

function ConfirmDialog({ copy, pending, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    function handleKeyDown(event) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, pending]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" role="presentation">
      <div aria-describedby="email-sending-confirm-message" aria-labelledby="email-sending-confirm-title" aria-modal="true" className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-2xl" ref={dialogRef} role="dialog">
        <h2 className="text-base font-semibold text-ink" id="email-sending-confirm-title">{copy.title}</h2>
        <p className="mt-2 text-sm leading-6 text-ink/72" id="email-sending-confirm-message">{copy.body}</p>
        {!copy.withoutReason ? (
          <div className="mt-4">
            <label className="text-xs font-semibold text-ink/65" htmlFor="email-sending-confirm-reason">Reason (optional)</label>
            <input className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm text-ink" disabled={pending} id="email-sending-confirm-reason" maxLength={500} onChange={(event) => setReason(event.target.value)} type="text" value={reason} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className={secondaryButton} disabled={pending} onClick={onCancel} ref={cancelRef} type="button">Cancel</button>
          <button className={primaryButton} disabled={pending} onClick={() => onConfirm(reason.trim())} type="button">{pending ? 'Saving…' : copy.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="rounded-2xl border border-line bg-fog/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/55">{label}</p>
      <div className="mt-2 space-y-2 text-sm text-ink/75">{children}</div>
    </div>
  );
}

export default function EmailSendingCard({ readOnly = false, connectResultCode }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [retryAction, setRetryAction] = useState(null);
  const [redirectResult] = useState(() => connectResult(connectResultCode ?? undefined));
  const triggerRef = useRef(null);
  const activeRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(STATUS_URL, { credentials: 'same-origin' });
      const result = await response.json().catch(() => ({}));
      if (!activeRef.current) return;
      if (!response.ok || !result.success || !result.emailSending) {
        setLoadError(result.error || 'Email sending status is unavailable.');
        return;
      }
      setData(result.emailSending);
      setLoadError('');
    } catch {
      if (activeRef.current) setLoadError('Email sending status is unavailable.');
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    load();
    return () => { activeRef.current = false; };
  }, [load]);

  function open(action, event) {
    triggerRef.current = event?.currentTarget || null;
    setNotice(null);
    setRetryAction(null);
    setPendingAction(action);
  }

  const close = useCallback(() => {
    setPendingAction(null);
    triggerRef.current?.focus();
  }, []);

  async function send(action, reason) {
    setSaving(true);
    try {
      const request = action.kind === 'disconnect'
        ? { url: DISCONNECT_URL, body: {} }
        : { url: CONTROLS_URL, body: { controlKey: action.kind === 'wording' ? 'wording_approval' : action.kind,
          enabled: action.enabled, expectedRevision: action.expectedRevision, reason } };
      const response = await fetch(request.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const result = await response.json().catch(() => ({}));
      if (!activeRef.current) return;
      if (response.ok && result.success) {
        setRetryAction(null);
      } else if (result.code === 'live_sending_sync_failed' && result.control) {
        setNotice({ tone: 'warn', text: result.error });
        setRetryAction({ ...action, expectedRevision: Number(result.control.revision) || 0, reason });
      } else {
        setNotice({ tone: 'warn', text: result.error || 'The change was not saved. Try again.' });
      }
    } catch {
      if (activeRef.current) setNotice({ tone: 'warn', text: 'The change may not have been saved. Check the card before trying again.' });
    } finally {
      if (activeRef.current) {
        setSaving(false);
        await load();
      }
    }
  }

  async function confirm(reason) {
    const action = pendingAction;
    if (!action) return;
    await send(action, reason);
    if (activeRef.current) close();
  }

  const gmail = data?.gmail || {};
  const wording = data?.wording || {};
  const contactRule = data?.contactRule || {};
  const liveSending = data?.liveSending || {};
  const readiness = data?.readiness || { ready: false, reasons: [] };
  const reasons = Array.isArray(readiness.reasons) ? readiness.reasons : [];
  const lastRuns = data?.lastRuns || {};
  const wordingCurrent = Boolean(wording.approvedDigest) && wording.approvedDigest === wording.currentDigest;
  const wordingChanged = Boolean(wording.approvedDigest) && !wordingCurrent;
  const needsReconnect = gmail.connected && reasons.some((reason) => RECONNECT_REASONS.has(reason));
  const copy = pendingAction ? confirmation(pendingAction, data) : null;
  const controlsDisabled = saving || loading;

  return (
    <section className="panel p-5 sm:p-7" aria-labelledby="email-sending-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Pursue emails</p>
          <h3 className="mt-2 text-xl font-semibold text-ink" id="email-sending-heading">Email sending</h3>
          <p className="mt-2 text-sm text-ink/65">Pursue emails go out from your Gmail only when every check below is green.</p>
        </div>
        {data ? (
          <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${readiness.ready ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {readiness.ready ? 'Ready' : 'Paused'}
          </span>
        ) : null}
      </div>
      {redirectResult ? <p className={`mt-4 rounded-xl border px-3 py-2 text-sm ${redirectResult.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role="status">{redirectResult.text}</p> : null}
      {notice ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <p>{notice.text}</p>
          {retryAction && !readOnly ? <button className={`${secondaryButton} mt-2`} disabled={saving} onClick={() => send(retryAction, retryAction.reason)} type="button">Try again</button> : null}
        </div>
      ) : null}
      {loadError ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          <p>{loadError}</p>
          <button className={`${secondaryButton} mt-2`} disabled={loading} onClick={load} type="button">Retry</button>
        </div>
      ) : null}
      {!data && loading ? <p className="mt-4 text-sm text-ink/60" role="status">Loading email sending status…</p> : null}
      {readOnly ? <p className="mt-4 rounded-xl border border-line bg-fog px-3 py-2 text-xs text-ink/60">Read-only view. Changing these settings requires a full administrator.</p> : null}
      {data ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Row label="Gmail">
            {gmail.connected ? (
              <>
                <p>Connected as <strong className="break-all text-ink">{gmail.emailAddress}</strong></p>
                <p className="text-xs text-ink/60">Last token check: {formatDate(gmail.lastTokenOkAt)}{gmail.lastErrorCode ? ` · last problem: ${gmail.lastErrorCode}` : ''}</p>
              </>
            ) : <p className="font-semibold text-ink">Not connected</p>}
            {!readOnly ? (
              <div className="flex flex-wrap gap-2">
                {!gmail.connected ? <a className={primaryButton} href={CONNECT_URL}>Connect Gmail</a> : null}
                {needsReconnect ? <a className={primaryButton} href={CONNECT_URL}>Reconnect Gmail</a> : null}
                {gmail.connected ? <button className={dangerButton} disabled={controlsDisabled} onClick={(event) => open({ kind: 'disconnect' }, event)} type="button">Disconnect</button> : null}
              </div>
            ) : null}
          </Row>
          <Row label="Wording">
            {wordingCurrent ? <p>Approved by {wording.approvedBy || 'Not recorded'} on {formatDate(wording.approvedAt)}.</p> : null}
            {wordingChanged ? <p className="font-semibold text-amber-900">The wording or signature changed since it was approved on {formatDate(wording.approvedAt)}. Approve it again to resume sending.</p> : null}
            {!wording.approvedDigest ? <p className="font-semibold text-ink">Not approved yet.</p> : null}
            <p className="break-all text-xs text-ink/60">Approved version {shortDigest(wording.approvedDigest)} · current version {shortDigest(wording.currentDigest)}</p>
            {!readOnly ? (
              <div>
                <button aria-describedby={!wording.signatureComplete ? 'email-sending-signature-note' : undefined} className={primaryButton} disabled={controlsDisabled || !wording.signatureComplete || wordingCurrent} onClick={(event) => open({ kind: 'wording', enabled: true, expectedRevision: Number(wording.revision) || 0 }, event)} type="button">Approve wording</button>
                {!wording.signatureComplete ? <p className="mt-2 text-xs text-amber-900" id="email-sending-signature-note">{READINESS_SENTENCES.signature_incomplete} Add it before approving.</p> : null}
              </div>
            ) : null}
            {Array.isArray(wording.preview) && wording.preview.length > 0 ? (
              <details className="rounded-xl border border-line bg-white p-3">
                <summary className="cursor-pointer text-sm font-semibold text-ink">Preview the emails ({wording.preview.length})</summary>
                <ol className="mt-3 space-y-3">
                  {wording.preview.map((item, index) => (
                    <li className="rounded-lg border border-line/70 p-3" key={`${item.variant}-${index}`}>
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink/50">{index === 0 ? 'First email' : `Follow-up ${index}`}</p>
                      <p className="mt-1 text-sm font-semibold text-ink">{item.subject}</p>
                      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-ink/75">{item.text}</pre>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </Row>
          <Row label="Contact rule">
            <p>{contactRule.enabled ? <><strong className="text-ink">On</strong> · policy {contactRule.policyVersion || 'not recorded'}</> : <strong className="text-ink">Off</strong>}</p>
            {contactRule.changedAt ? <p className="text-xs text-ink/60">Changed by {contactRule.changedBy || 'Not recorded'} on {formatDate(contactRule.changedAt)}</p> : null}
            {!readOnly ? <button className={contactRule.enabled ? secondaryButton : primaryButton} disabled={controlsDisabled} onClick={(event) => open({ kind: 'contact_rule', enabled: !contactRule.enabled, expectedRevision: Number(contactRule.revision) || 0 }, event)} type="button">{contactRule.enabled ? 'Turn off contact rule' : 'Turn on contact rule'}</button> : null}
          </Row>
          <Row label="Live sending">
            <p><strong className="text-ink">{liveSending.enabled ? 'On' : 'Off'}</strong></p>
            {liveSending.changedAt ? <p className="text-xs text-ink/60">{liveSending.enabled ? 'Turned on' : 'Turned off'} by {liveSending.changedBy || 'Not recorded'} on {formatDate(liveSending.changedAt)}</p> : null}
            {!readOnly ? <button className={liveSending.enabled ? dangerButton : primaryButton} disabled={controlsDisabled} onClick={(event) => open({ kind: 'live_sending', enabled: !liveSending.enabled, expectedRevision: Number(liveSending.revision) || 0 }, event)} type="button">{liveSending.enabled ? 'Turn off Live sending' : 'Turn on Live sending'}</button> : null}
          </Row>
          <Row label="Readiness">
            {readiness.ready ? <p className="font-semibold text-emerald-800">Ready to send.</p> : (
              <ul aria-label="Why sending is paused" className="list-disc space-y-1 pl-5">
                {reasons.map((reason) => <li key={reason}>{READINESS_SENTENCES[reason] || 'Sending is paused for a reason this page does not recognize yet.'}</li>)}
              </ul>
            )}
          </Row>
          <Row label="Last runs">
            <p><span className="font-semibold text-ink">Sender:</span> {runLine(lastRuns.sender, 'sender')}</p>
            <p><span className="font-semibold text-ink">Reply checks:</span> {runLine(lastRuns.replyPoller, 'poller')}</p>
          </Row>
        </div>
      ) : null}
      {copy && !readOnly ? <ConfirmDialog copy={copy} onCancel={close} onConfirm={confirm} pending={saving} /> : null}
    </section>
  );
}
