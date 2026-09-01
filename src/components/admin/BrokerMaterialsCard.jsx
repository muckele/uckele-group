import React, { useEffect, useId, useRef, useState } from 'react';

const primaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-moss bg-moss px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';

function formatDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not supplied';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function lifecyclePresentation(request) {
  if (request?.respondedAt || request?.status === 'responded' || request?.requestState === 'responded') {
    return { badge: 'Replied', sentence: 'The broker replied to this request.', action: 'View Broker Reply' };
  }
  if (request?.status === 'ambiguous' || request?.requestState === 'provider_ambiguous' || request?.deliveryState === 'ambiguous') {
    return { badge: 'Ambiguous', sentence: 'Delivery could not be confirmed. Do not send another request.', action: 'Review Ambiguous Result' };
  }
  if (request?.status === 'delivery_issue' || request?.status === 'failed' || request?.requestState === 'failed' || ['bounced', 'failed', 'rejected', 'suppressed', 'complained'].includes(request?.deliveryState)) {
    return {
      badge: 'Delivery Issue', sentence: request.errorSummary || 'The request has a delivery issue.',
      action: 'Review Delivery Issue',
    };
  }
  if (request?.status === 'logged' || request?.requestState === 'logged') {
    return { badge: 'Sent', sentence: 'The broker materials request is logged.', action: 'View Logged Request' };
  }
  if (request?.status === 'delivered' || request?.deliveryState === 'delivered') {
    return { badge: 'Sent', sentence: `Delivered to ${request.recipient?.email || request.recipient?.displayName || 'the broker'}.`, action: 'View Request Status' };
  }
  if (request?.status === 'sent' || ['accepted', 'delivered'].includes(request?.deliveryState) || request?.providerAcceptedAt) {
    const timestamp = formatDateTime(request.providerAcceptedAt || request.requestedAt || request.updatedAt);
    return { badge: 'Sent', sentence: `Sent to ${request.recipient?.email || request.recipient?.displayName || 'the broker'} · ${timestamp}.`, action: 'View Sent Request' };
  }
  return { badge: 'Sending / Pending', sentence: 'A broker materials request is pending.', action: 'View Request Status' };
}

function blockerPresentation(brokerMaterials) {
  const blocker = brokerMaterials?.preparationBlockers?.[0];
  if (!blocker) return null;
  const recipientBlocker = ['recipient_authority_unavailable', 'broker_email_required', 'recipient_required'].includes(blocker.code);
  return { badge: 'Blocked', sentence: blocker.message || 'Broker materials cannot be prepared yet.', action: recipientBlocker ? 'Add / Verify Broker Email' : 'View Requirements', recipientBlocker };
}

function MessageList({ empty = 'None', items }) {
  if (!items?.length) return <p className="mt-2 text-sm text-ink/58">{empty}</p>;
  return <ul className="mt-2 space-y-2">{items.map((item, index) => <li className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" key={`${item.code || item.message}-${index}`}>{item.message || item.code}</li>)}</ul>;
}

export default function BrokerMaterialsCard({
  brokerMaterials = {}, checking = false, checkingFailed = false, error = '', onAddBrokerEmail, onApprove,
  onCheckStatus, onInvalidatePreparation, onPrepare, onViewRequest, preparation: providedPreparation = null,
  preparing = false, recipientSelection: providedRecipientSelection = null,
  readOnly = false, sending = false, stale = false, updating = false,
}) {
  const contentId = useId();
  const recipientHelpId = useId();
  const greetingHelpId = useId();
  const approvalContextId = useId();
  const recipientRef = useRef(null);
  const greetingRef = useRef(null);
  const disclosureRef = useRef(null);
  const reviewHeadingRef = useRef(null);
  const statusHeadingRef = useRef(null);
  const alertRef = useRef(null);
  const approvalLockRef = useRef(false);
  const contactMenuOpenRef = useRef(false);
  const operatorActionRef = useRef('');
  const [expanded, setExpanded] = useState(Boolean(providedPreparation || providedRecipientSelection || preparing || checking));
  const [greeting, setGreeting] = useState(providedPreparation?.review?.message?.greeting || '');
  const [localInvalid, setLocalInvalid] = useState(false);
  const [localUpdating, setLocalUpdating] = useState(false);
  const [localSending, setLocalSending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const existingRequest = brokerMaterials?.existingRequest || null;
  const preparation = existingRequest ? null : providedPreparation;
  const recipientSelection = existingRequest ? null : providedRecipientSelection;
  const blocker = blockerPresentation(brokerMaterials);
  const lifecycle = existingRequest ? lifecyclePresentation(existingRequest) : null;
  const review = preparation?.review;
  const message = review?.message;
  const recipient = review?.recipient;
  const recipientOptions = preparation?.recipientOptions || brokerMaterials?.recipientOptions || [];
  const warnings = preparation?.warnings || brokerMaterials?.warnings || [];
  const sendBlockers = preparation?.sendBlockers || brokerMaterials?.sendBlockers || [];
  const sendingPaused = !existingRequest && !preparation && sendBlockers.some((item) => ['cim_outreach_paused', 'outreach_paused', 'global_pause'].includes(item.code));
  const greetingDirty = Boolean(message && greeting !== message.greeting);
  const invalid = localInvalid || stale || !preparation?.preparationToken || !preparation?.proposalDigest;
  const busy = preparing || updating || sending || localUpdating || localSending;
  const mobileSticky = Boolean(preparation && !checking && !readOnly && !stale && !invalid && !greetingDirty && !preparing && !updating && !localUpdating && !localSending && !sending);

  useEffect(() => {
    if (preparation || recipientSelection || preparing || checking) setExpanded(true);
  }, [checking, preparation, preparing, recipientSelection]);

  useEffect(() => {
    setGreeting(preparation?.review?.message?.greeting || '');
    setLocalInvalid(false);
    setLocalUpdating(false);
  }, [preparation]);

  useEffect(() => {
    if (!preparation || operatorActionRef.current !== 'prepare') return;
    reviewHeadingRef.current?.focus();
    operatorActionRef.current = '';
  }, [preparation]);

  useEffect(() => {
    if (!error || !operatorActionRef.current) return;
    alertRef.current?.focus();
    operatorActionRef.current = '';
  }, [error]);

  useEffect(() => {
    if (!existingRequest) return;
    setAnnouncement(existingRequest.status === 'ambiguous' || existingRequest.requestState === 'provider_ambiguous' || existingRequest.deliveryState === 'ambiguous'
      ? 'Ambiguous. Do not send another request.'
      : `Broker Materials status: ${lifecycle?.badge || 'Current'}`);
    if (operatorActionRef.current === 'approve') statusHeadingRef.current?.focus();
    operatorActionRef.current = '';
  }, [existingRequest, lifecycle?.badge]);

  useEffect(() => {
    if (!checking) return;
    setAnnouncement(checkingFailed ? 'Checking failed. Do not resend until authoritative status is available.' : 'Checking authoritative request status.');
    if (operatorActionRef.current === 'approve') statusHeadingRef.current?.focus();
    operatorActionRef.current = '';
  }, [checking, checkingFailed]);

  function handleRecipientMenuKeyDown(event) {
    if (event.key === 'Escape' && contactMenuOpenRef.current) {
      event.preventDefault();
      event.stopPropagation();
      contactMenuOpenRef.current = false;
      return;
    }
    if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) contactMenuOpenRef.current = true;
  }

  async function beginPreparation() {
    if (!onPrepare) return false;
    operatorActionRef.current = 'prepare';
    setExpanded(true);
    setAnnouncement('Preparing broker materials preview…');
    const result = await onPrepare({});
    if (result === false && operatorActionRef.current === 'prepare') operatorActionRef.current = '';
    return result;
  }

  async function regenerate(body, { focusGreeting = false, keepFocus = false } = {}) {
    if (!onPrepare || localUpdating) return false;
    operatorActionRef.current = keepFocus ? 'recipient' : 'greeting';
    setLocalInvalid(true);
    setLocalUpdating(true);
    setAnnouncement(keepFocus ? 'Updating recipient and preview…' : 'Updating broker materials preview…');
    onInvalidatePreparation?.();
    try {
      const result = await onPrepare(body);
      setAnnouncement(result === false ? 'Preview update was not completed.' : 'Updated');
      return result;
    } finally {
      setLocalUpdating(false);
      if (keepFocus) recipientRef.current?.focus();
      else if (focusGreeting) greetingRef.current?.focus();
    }
  }

  async function approve() {
    if (approvalLockRef.current || invalid || greetingDirty || sendBlockers.length || readOnly || !onApprove) return;
    approvalLockRef.current = true;
    operatorActionRef.current = 'approve';
    setLocalSending(true);
    setAnnouncement('Broker request submission in progress.');
    try {
      await onApprove(preparation);
    } finally {
      approvalLockRef.current = false;
      setLocalSending(false);
    }
  }

  function lifecycleAction() {
    return onViewRequest?.(existingRequest);
  }

  const collapsed = lifecycle || (checking
    ? { badge: 'Checking', sentence: checkingFailed ? 'Unable to confirm request status. Do not resend until authoritative status is available.' : 'The request outcome is not yet confirmed. Checking authoritative status…', action: checkingFailed ? 'Check Again' : 'Check Request Status' }
    : recipientSelection
      ? { badge: 'Recipient required', sentence: recipientSelection.message || 'Select one authoritative broker recipient before preparing the request.', action: '' }
    : blocker || {
      badge: sendingPaused ? 'Ready · Sending paused' : 'Ready',
      sentence: sendingPaused ? 'You can prepare and review while CIM sending is paused.' : 'Prepare a reviewed request using current broker details.',
      action: readOnly ? 'Preview Broker Materials' : 'Request Broker Materials',
    });
  const statusLabel = preparation && !checking ? stale ? 'Preparation out of date' : 'Prepared' : collapsed.badge;
  const liveMessage = existingRequest
    ? existingRequest.status === 'ambiguous' || existingRequest.requestState === 'provider_ambiguous' || existingRequest.deliveryState === 'ambiguous'
      ? 'Ambiguous. Do not send another request.'
      : `Broker Materials status: ${lifecycle?.badge || 'Current'}`
    : checking
      ? checkingFailed ? 'Checking failed. Do not resend until authoritative status is available.' : 'Checking authoritative request status.'
      : busy
        ? preparing ? 'Preparing broker materials preview…' : localSending || sending ? 'Submitting the approved request…' : 'Updating broker materials preview…'
        : announcement;

  return (
    <section aria-busy={busy ? 'true' : 'false'} aria-labelledby={`${contentId}-title`} className="rounded-xl border border-moss/20 bg-moss/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-ink" id={`${contentId}-title`}>Broker Materials</h4>
          <div className="mt-1 flex items-center gap-2"><h5 aria-label={`Broker Materials status: ${statusLabel}`} className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-moss" ref={statusHeadingRef} tabIndex={-1}>{statusLabel}</h5></div>
        </div>
        <button aria-controls={contentId} aria-expanded={expanded} aria-label="Broker Materials review" className={secondaryButton} onClick={() => { const next = !expanded; setExpanded(next); if (!next) disclosureRef.current?.focus(); }} ref={disclosureRef} type="button">{expanded ? 'Hide review' : 'Show review'}</button>
      </div>

      {!preparation || checking ? <p className="mt-3 text-sm leading-6 text-ink/68">{collapsed.sentence}</p> : null}
      <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">{liveMessage}</p>
      {error ? <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" ref={alertRef} role="alert" tabIndex={-1}>{error}</p> : null}

      {!preparation && !recipientSelection && !checking ? <div className="mt-3">
        {blocker?.recipientBlocker && !readOnly ? <button className={secondaryButton} onClick={onAddBrokerEmail} type="button">{collapsed.action}</button>
          : blocker ? <button className={secondaryButton} onClick={() => setExpanded(true)} type="button">{collapsed.action}</button>
            : lifecycle ? <button className={secondaryButton} onClick={lifecycleAction} type="button">{collapsed.action}</button>
              : <button className={primaryButton} disabled={preparing} onClick={beginPreparation} type="button">{collapsed.action}</button>}
      </div> : null}

      {checking ? <div className="mt-3"><button className={secondaryButton} disabled={!onCheckStatus} onClick={onCheckStatus} type="button">{checkingFailed ? 'Check Again' : 'Check Request Status'}</button></div> : null}

      <div hidden={!expanded} id={contentId}>
        {preparing && !preparation ? <div className="mt-4"><p className="text-sm text-ink/68">Preparing a review from current opportunity and broker information…</p><div className="mt-3 animate-pulse space-y-2" aria-hidden="true"><div className="h-4 rounded bg-moss/10" /><div className="h-20 rounded bg-moss/10" /></div></div> : null}
        {blocker && !preparation && expanded ? <MessageList items={brokerMaterials.preparationBlockers} /> : null}
        {recipientSelection ? <div className="mt-4 space-y-4 border-t border-moss/15 pt-4">
          <section><h5 className="text-sm font-semibold text-ink">Recipient and provenance</h5>
            <label className="mt-2 block text-xs font-semibold text-ink/62">Authoritative broker recipient<select aria-describedby={recipientHelpId} aria-label="Authoritative broker recipient" className="form-control mt-1" disabled={busy || readOnly} onBlur={() => { contactMenuOpenRef.current = false; }} onChange={(event) => { contactMenuOpenRef.current = false; if (event.target.value) regenerate({ recipientContactRef: event.target.value }, { keepFocus: true }); }} onKeyDown={handleRecipientMenuKeyDown} onMouseDown={() => { contactMenuOpenRef.current = true; }} ref={recipientRef} value=""><option disabled value="">Select an authoritative recipient</option>{recipientSelection.recipientOptions?.map((option) => <option key={option.recipientContactRef} value={option.recipientContactRef}>{option.displayName || option.email} · {option.email}</option>)}</select></label>
            <p className="mt-1 text-xs text-ink/55" id={recipientHelpId}>Choose one server-authoritative contact. No request can be approved before preparation succeeds.</p>
          </section>
          {recipientSelection.warnings?.length ? <section><h5 className="text-sm font-semibold text-ink">Manual Stage 1 warnings</h5><MessageList items={recipientSelection.warnings} /></section> : null}
          {recipientSelection.sendBlockers?.length ? <section><h5 className="text-sm font-semibold text-ink">Current send blockers</h5><MessageList items={recipientSelection.sendBlockers} /></section> : null}
        </div> : null}
        {review ? <div className={`mt-4 space-y-5 border-t border-moss/15 pt-4 ${mobileSticky ? 'pb-32 sm:pb-0' : ''}`} data-testid="broker-materials-review-content">
          <h5 className="text-base font-semibold text-ink outline-none" ref={reviewHeadingRef} tabIndex={-1}>Prepared Broker Materials review</h5>
          <section><h5 className="text-sm font-semibold text-ink">Opportunity context</h5><p className="mt-2 text-sm text-ink/68">{review.opportunity?.displayName || 'Opportunity'} · {review.opportunity?.sourceLabel || 'Authoritative source'} · {review.opportunity?.pursued ? 'Pursued' : 'Not pursued'} · {review.opportunity?.current ? 'Current' : 'Not current'}</p></section>
          <section><h5 className="text-sm font-semibold text-ink">Manual Stage 1 warnings</h5><MessageList empty="No warnings." items={warnings} /></section>
          <section><h5 className="text-sm font-semibold text-ink">Recipient and provenance</h5>
            {recipientOptions.length > 1 && !readOnly ? <label className="mt-2 block text-xs font-semibold text-ink/62">Authoritative broker recipient<select aria-describedby={recipientHelpId} aria-label="Authoritative broker recipient" className="form-control mt-1" disabled={busy} onBlur={() => { contactMenuOpenRef.current = false; }} onChange={(event) => { contactMenuOpenRef.current = false; regenerate({ recipientContactRef: event.target.value }, { keepFocus: true }); }} onKeyDown={handleRecipientMenuKeyDown} onMouseDown={() => { contactMenuOpenRef.current = true; }} ref={recipientRef} value={recipient?.contactRef || ''}>{recipientOptions.map((option) => <option key={option.recipientContactRef} value={option.recipientContactRef}>{option.displayName || option.email} · {option.email}</option>)}</select></label>
              : <p className="mt-2 text-sm text-ink/68">{recipient?.displayName || 'Broker'} · {recipient?.email || 'Email unavailable'}</p>}
            <p className="mt-1 text-xs text-ink/55" id={recipientHelpId}>Provenance: {recipientOptions.find((option) => option.recipientContactRef === recipient?.contactRef)?.provenanceLabel || recipient?.provenance || 'Authoritative contact source'}</p>
          </section>
          <section><h5 className="text-sm font-semibold text-ink">Sender</h5><p className="mt-2 text-sm text-ink/68">{review.sender?.displayName} · {review.sender?.email}{review.sender?.replyTo ? ` · Reply to ${review.sender.replyTo}` : ''}</p></section>
          <section><h5 className="text-sm font-semibold text-ink" id={`${contentId}-greeting-label`}>Greeting</h5><input aria-describedby={greetingDirty ? greetingHelpId : undefined} aria-labelledby={`${contentId}-greeting-label`} className="form-control mt-2 scroll-mb-32 sm:scroll-mb-0" id={`${contentId}-greeting`} onChange={(event) => setGreeting(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && greetingDirty) { event.preventDefault(); regenerate({ recipientContactRef: recipient?.contactRef, greeting }, { focusGreeting: true }); } }} readOnly={readOnly} ref={greetingRef} value={greeting} />{greetingDirty ? <p className="mt-2 text-sm text-amber-800" id={greetingHelpId}>Preview needs updating before approval.</p> : null}{greetingDirty && !readOnly ? <button className={`${secondaryButton} mt-2 scroll-mb-32 sm:scroll-mb-0`} disabled={busy} onClick={() => regenerate({ recipientContactRef: recipient?.contactRef, greeting }, { focusGreeting: true })} type="button">Update Preview</button> : null}</section>
          <section><h5 className="text-sm font-semibold text-ink">Subject</h5><label className="sr-only" htmlFor={`${contentId}-subject`}>Subject</label><input aria-label="Subject" className="form-control mt-2" id={`${contentId}-subject`} readOnly value={message?.subject || ''} /></section>
          <section><h5 className="text-sm font-semibold text-ink">Complete message body</h5><label className="sr-only" htmlFor={`${contentId}-body`}>Complete message body</label><textarea aria-label="Complete message body" className="form-control mt-2 min-h-52 whitespace-pre-wrap" id={`${contentId}-body`} readOnly value={message?.body || ''} /></section>
          <section><h5 className="text-sm font-semibold text-ink">Current send blockers</h5><MessageList empty="No current send blockers." items={sendBlockers} /></section>
          <section><h5 className="text-sm font-semibold text-ink">Expiration</h5><p className="mt-2 text-sm text-ink/68">Prepared {formatDateTime(preparation.preparedAt)} · Expires {formatDateTime(preparation.expiresAt)}</p></section>
          <section className={mobileSticky ? 'sticky bottom-0 z-[5] -mx-4 border-t border-moss/20 bg-white/95 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(25,56,44,0.12)] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0 sm:shadow-none sm:backdrop-blur-0' : ''} data-mobile-sticky={mobileSticky ? 'true' : 'false'} data-testid="broker-materials-final-approval"><h5 className="text-sm font-semibold text-ink">Final approval</h5><p className="mt-2 text-sm text-ink/68" id={approvalContextId}>This sends one CIM request to {recipient?.email || 'the reviewed broker'}.{sendBlockers.length ? ` Sending is unavailable: ${sendBlockers.map((item) => item.message || item.code).join(' ')}` : ''}</p>{stale ? <p className="mt-2 text-sm text-amber-800">The reviewed copy is retained for orientation only. Generate a fresh proposal before sending.</p> : null}<div className="mt-3 flex flex-wrap gap-2">
            {readOnly ? <button className={secondaryButton} onClick={onCheckStatus} type="button">Check Request Status</button>
              : checking || localUpdating ? null
                : greetingDirty ? <button aria-describedby={approvalContextId} className={`${primaryButton} w-full sm:w-auto`} disabled type="button">Approve &amp; Send</button>
                  : stale || invalid ? <button className={primaryButton} disabled={busy} onClick={() => regenerate({ recipientContactRef: recipient?.contactRef, greeting: message?.greeting })} type="button">Regenerate Request</button>
                    : <button aria-describedby={approvalContextId} className={`${primaryButton} w-full sm:w-auto`} disabled={busy || sendBlockers.length > 0} onClick={approve} type="button">Approve &amp; Send</button>}
            {localSending || sending ? <span className="self-center text-sm text-ink/68">Submitting the approved request…</span> : null}
            {localUpdating || updating ? <span className="self-center text-sm text-ink/68">Updating…</span> : null}
          </div></section>
        </div> : null}
      </div>
    </section>
  );
}
