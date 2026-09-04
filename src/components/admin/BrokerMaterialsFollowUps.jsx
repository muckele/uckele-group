import React, { useEffect, useId, useRef, useState } from 'react';

const primaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-moss bg-moss px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';

const statePresentation = {
  'not-enrolled': { badge: 'Not Scheduled', description: 'This accepted request is not enrolled in human-approved follow-ups.' },
  scheduled: { badge: 'Scheduled', description: 'The next follow-up is scheduled from durable provider acceptance.' },
  due: { badge: 'Due', description: 'The next follow-up is due for human review.' },
  overdue: { badge: 'Overdue', description: 'The next follow-up is overdue and still requires human review.' },
  retry: { badge: 'Delivery Issue', description: 'The failed communication can be reviewed for an exact retry.' },
  ambiguous: { badge: 'Checking', description: 'The provider outcome is unresolved. Check authoritative status; retransmission is prohibited.' },
  completed: { badge: 'Completed', description: 'All five human-approved follow-ups are complete.' },
  stopped: { badge: 'Stopped', description: 'Future follow-ups were permanently stopped.' },
  closed: { badge: 'Closed', description: 'This request is closed to follow-ups.' },
};

const terminalReasonMessages = {
  reply_received: 'Broker replied.',
  materials_received: 'Broker materials were received.',
  advanced_beyond_broker_outreach: 'This opportunity advanced beyond broker outreach.',
  opportunity_passed: 'This opportunity was passed.',
  crm_archived: 'The linked CRM opportunity is archived.',
  recipient_suppressed: 'The recipient is suppressed from outreach.',
  terminal_delivery: 'A delivery issue closed this follow-up sequence.',
  outcome_unresolved: 'The current delivery outcome is unresolved.',
  existing_follow_up_lifecycle: 'An existing follow-up lifecycle already owns this request.',
  manual_follow_up_stopped: 'Follow-Ups stopped.',
  follow_up_complete: 'Follow-up sequence complete.',
};

function terminalReasonMessage(reason) {
  return terminalReasonMessages[String(reason || '')] || '';
}

function validTimestamp(value) {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function formatPacific(value, fallback = 'Not recorded') {
  if (!validTimestamp(value)) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function blockerMessages(followUps, preparation) {
  const seen = new Set();
  return [...(preparation?.sendBlockers || []), ...(followUps?.sendBlockers || []), ...(followUps?.preparationBlockers || [])]
    .filter((item) => item?.message && !seen.has(item.code || item.message) && seen.add(item.code || item.message));
}

function validatePlainText(value, maximum, label, optional = false) {
  const unsafe = [...String(value || '')].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 || character === '<' || character === '>';
  });
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if ((!optional && !normalized) || normalized.length > maximum || unsafe) {
    return `${label} must be ${optional ? 'optional ' : ''}plain text of at most ${maximum} characters.`;
  }
  return '';
}

function MessageList({ items, empty = '' }) {
  if (!items?.length) return empty ? <p className="mt-2 text-sm text-ink/58">{empty}</p> : null;
  return <ul className="mt-2 space-y-2">{items.map((item, index) => <li className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" key={`${item.code || item.message}-${index}`}>{item.message || item.code}</li>)}</ul>;
}

function lifecycleAnnouncement(followUps, terminalMessage = '') {
  const state = followUps?.state;
  if (state === 'completed') return 'Follow-up sequence completed.';
  if (state === 'stopped') return 'Follow-up sequence permanently stopped.';
  if (state === 'closed') return `Follow-up sequence closed.${terminalMessage ? ` ${terminalMessage}` : ''}`;
  if (state === 'scheduled') return `Follow-Up ${followUps.currentFollowUpNumber || ''} scheduled.`.replace('  ', ' ');
  if (state === 'due') return `Follow-Up ${followUps.currentFollowUpNumber || ''} is due.`.replace('  ', ' ');
  if (state === 'overdue') return `Follow-Up ${followUps.currentFollowUpNumber || ''} is overdue.`.replace('  ', ' ');
  if (state === 'ambiguous') return 'Provider outcome unresolved. Check status; do not resend.';
  return '';
}

export default function BrokerMaterialsFollowUps({
  businessName = 'this opportunity',
  checking = false,
  checkingFailed = false,
  developmentOnly = false,
  error = '',
  followUps = null,
  onApprove,
  onCheckStatus,
  onCloseReview,
  onInvalidatePreparation,
  onPrepare,
  onStart,
  onStop,
  preparation = null,
  preparing = false,
  readOnly = false,
  sending = false,
  stale = false,
  stopStatus = '',
  updated = false,
  updating = false,
}) {
  const contentId = useId();
  const headingRef = useRef(null);
  const reviewHeadingRef = useRef(null);
  const greetingRef = useRef(null);
  const stopButtonRef = useRef(null);
  const stopReasonRef = useRef(null);
  const errorRef = useRef(null);
  const stopStatusRef = useRef(null);
  const approvalLockRef = useRef(false);
  const approvalAuthorityRef = useRef(preparation?.preparationToken || '');
  const actionRef = useRef('');
  const dirtyRef = useRef(false);
  const [greeting, setGreeting] = useState(preparation?.review?.message?.greeting || '');
  const [localBusy, setLocalBusy] = useState('');
  const [localError, setLocalError] = useState('');
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const [reviewClosed, setReviewClosed] = useState(false);

  const state = followUps?.state || 'not-enrolled';
  const serverStopInFlight = stopStatus === 'server-in-flight';
  const clientStopUnknown = stopStatus === 'client-unknown';
  const presentation = statePresentation[state] || statePresentation.closed;
  const review = reviewClosed ? null : preparation?.review;
  const message = review?.message;
  const firstAttempt = review?.mode === 'first-attempt';
  const greetingEditable = firstAttempt && message?.greetingEditable && !readOnly;
  const greetingDirty = Boolean(greetingEditable && greeting !== message?.greeting);
  const greetingError = greetingDirty ? validatePlainText(greeting, 120, 'The greeting') : '';
  const blockers = blockerMessages(followUps, preparation);
  const hasApprovalAuthority = !readOnly && Boolean(preparation?.preparationToken && preparation?.proposalDigest);
  const busy = Boolean(preparing || updating || sending || localBusy);
  const approvalInvalid = !hasApprovalAuthority || stale || greetingDirty || blockers.length > 0 || busy;
  const currentNumber = review?.followUpNumber || followUps?.currentFollowUpNumber;
  const maximum = followUps?.maximumFollowUps || 5;
  const showReviewAction = !readOnly && !review && ['due', 'overdue', 'retry'].includes(state);
  const showViewerPreview = readOnly && !review && ['due', 'overdue', 'retry'].includes(state);
  const canStop = !readOnly && !stopStatus && followUps?.enrolled && ['scheduled', 'due', 'overdue', 'retry'].includes(state);
  const mobileSticky = Boolean(review && !readOnly && !approvalInvalid);
  const terminalMessage = followUps?.startBlockers?.find((item) => item.code === followUps?.terminalReason)?.message
    || followUps?.startBlockers?.[0]?.message
    || followUps?.preparationBlockers?.find((item) => item.code === followUps?.terminalReason)?.message
    || followUps?.sendBlockers?.find((item) => item.code === followUps?.terminalReason)?.message
    || terminalReasonMessage(followUps?.terminalReason);
  const effectiveError = localError || error;
  const preparationKey = preparation?.review ? [
    preparation.preparedAt,
    preparation.review.mode,
    preparation.review.followUpNumber,
    preparation.review.message?.greeting,
    preparation.review.message?.subject,
    preparation.review.message?.body,
  ].join('|') : '';

  let announcement = lifecycleAnnouncement(followUps, terminalMessage);
  if (preparing || localBusy === 'prepare') announcement = 'Preparing follow-up review.';
  else if (updating || localBusy === 'update') announcement = 'Updating follow-up preview.';
  else if (updated) announcement = 'Follow-up preview updated.';
  else if (sending || localBusy === 'approve') announcement = 'Sending approved follow-up.';
  else if (checking) announcement = clientStopUnknown
    ? 'Checking Stop status.'
    : checkingFailed
    ? 'Authoritative follow-up status is still unavailable.'
    : 'Checking authoritative follow-up status.';
  else if (effectiveError) announcement = effectiveError;

  useEffect(() => {
    const nextGreeting = preparation?.review?.message?.greeting || '';
    setGreeting(nextGreeting);
    dirtyRef.current = false;
    setReviewClosed(false);
    approvalLockRef.current = false;
    if (preparation?.review && actionRef.current) {
      if (actionRef.current === 'update' && preparation.review.message?.greetingEditable) greetingRef.current?.focus();
      else reviewHeadingRef.current?.focus();
      actionRef.current = '';
    }
  // Authority-only token removal must not erase an operator's unsaved greeting.
  // The server-authored review identity changes whenever a fresh preview arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparationKey]);

  useEffect(() => {
    const nextAuthority = preparation?.preparationToken || '';
    if (nextAuthority && nextAuthority !== approvalAuthorityRef.current) approvalLockRef.current = false;
    if (nextAuthority) approvalAuthorityRef.current = nextAuthority;
  }, [preparation?.preparationToken]);

  useEffect(() => {
    if (!stopOpen) return;
    stopReasonRef.current?.focus();
  }, [stopOpen]);

  useEffect(() => {
    if (!canStop && stopOpen) {
      setStopOpen(false);
      setStopReason('');
    }
  }, [canStop, stopOpen]);

  useEffect(() => {
    if (clientStopUnknown && actionRef.current === 'stop') stopStatusRef.current?.focus();
  }, [clientStopUnknown]);

  useEffect(() => {
    if (!effectiveError || !actionRef.current) return;
    errorRef.current?.focus();
    actionRef.current = '';
  }, [effectiveError]);

  useEffect(() => {
    if (!followUps || !actionRef.current || review) return;
    if (['start', 'stop', 'approve', 'prepare'].includes(actionRef.current)) {
      headingRef.current?.focus();
      actionRef.current = '';
    }
  }, [followUps, review, state]);

  function closeStop() {
    setStopOpen(false);
    setStopReason('');
    setLocalError('');
    requestAnimationFrame(() => stopButtonRef.current?.focus());
  }

  function handleKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (stopOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeStop();
      return;
    }
    if (review && onCloseReview) {
      event.preventDefault();
      event.stopPropagation();
      headingRef.current?.focus();
      setReviewClosed(true);
      onCloseReview();
    }
  }

  async function runAction(kind, callback, argument) {
    if (!callback || localBusy) return false;
    actionRef.current = kind;
    setLocalBusy(kind);
    setLocalError('');
    try {
      const result = await callback(argument);
      if (!result && kind === 'prepare') headingRef.current?.focus();
      return result;
    } catch (actionError) {
      setLocalError(actionError?.message || 'The follow-up action could not be completed.');
      return false;
    } finally {
      setLocalBusy('');
    }
  }

  function changeGreeting(value) {
    setGreeting(value);
    setLocalError('');
    const becomesDirty = value !== message?.greeting;
    if (becomesDirty && !dirtyRef.current) onInvalidatePreparation?.();
    dirtyRef.current = becomesDirty;
  }

  function updatePreview() {
    const validation = validatePlainText(greeting, 120, 'The greeting');
    if (validation) {
      setLocalError(validation);
      actionRef.current = 'update';
      requestAnimationFrame(() => greetingRef.current?.focus());
      return;
    }
    runAction('update', onPrepare, { greeting: greeting.replace(/\s+/g, ' ').trim() });
  }

  function approve() {
    if (approvalInvalid || approvalLockRef.current || !onApprove) return;
    approvalLockRef.current = true;
    const authority = preparation;
    actionRef.current = 'approve';
    setLocalBusy('approve');
    setLocalError('');
    onInvalidatePreparation?.();
    Promise.resolve(onApprove(authority))
      .catch((approvalError) => setLocalError(approvalError?.message || 'The approved follow-up could not be sent.'))
      .finally(() => setLocalBusy(''));
  }

  async function confirmStop() {
    const validation = validatePlainText(stopReason, 240, 'The Stop reason', true);
    if (validation) {
      setLocalError(validation);
      stopReasonRef.current?.focus();
      return;
    }
    const body = stopReason.trim() ? { reason: stopReason.replace(/\s+/g, ' ').trim() } : {};
    setStopOpen(false);
    await runAction('stop', onStop, body);
  }

  if (!followUps) return null;

  return (
    // The labelled region owns two nested transient layers (Stop confirmation and
    // review) so Escape is consumed here before the enclosing drawer handles it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section aria-labelledby={`${contentId}-heading`} className="mt-5 border-t border-moss/15 pt-5" data-testid="broker-materials-follow-ups" onKeyDown={handleKeyDown}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-ink outline-none" id={`${contentId}-heading`} ref={headingRef} tabIndex={-1}>Follow-Ups</h4>
          <p className="mt-1 text-sm text-ink/68">Every follow-up requires a fresh review and explicit administrator approval.</p>
        </div>
        <span className="rounded-full border border-moss/20 bg-moss/10 px-3 py-1 text-xs font-semibold text-moss">{presentation.badge}</span>
      </div>

      <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">{announcement}</p>
      <p className="mt-3 text-sm text-ink/68">{presentation.description}</p>
      {developmentOnly ? <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">Development only. No production provider delivery is claimed.</p> : null}

      <dl className="mt-3 grid gap-2 text-sm text-ink/68 sm:grid-cols-2">
        <div><dt className="font-semibold text-ink">Progress</dt><dd>{followUps.followUpCount || 0} of {maximum} sent</dd></div>
        {currentNumber ? <div><dt className="font-semibold text-ink">Current touch</dt><dd>Follow-Up {currentNumber} of {maximum}</dd></div> : null}
        {followUps.nextFollowUpAt ? <div className="sm:col-span-2"><dt className="font-semibold text-ink">Next due</dt><dd>{formatPacific(followUps.nextFollowUpAt)} PT</dd></div> : null}
      </dl>

      {state === 'closed' && terminalMessage ? <p className="mt-3 rounded-lg border border-line bg-fog/70 px-3 py-2 text-sm text-ink/68">{terminalMessage}</p> : null}
      {serverStopInFlight ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><p>Future follow-ups are stopped.</p><p className="mt-1">The current follow-up outcome is still being checked.</p></div> : null}
      {clientStopUnknown ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 outline-none" ref={stopStatusRef} tabIndex={-1}><p>Stop outcome is unknown.</p><p className="mt-1">Checking current follow-up status…</p></div> : null}
      {effectiveError ? <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 outline-none" ref={errorRef} role="alert" tabIndex={-1}>{effectiveError}</p> : null}

      {!review && blockers.length ? <MessageList items={blockers} /> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {!readOnly && state === 'not-enrolled' && followUps.startEligible ? <button className={primaryButton} disabled={busy} onClick={() => runAction('start', onStart, {})} type="button">Start Follow-Up Sequence</button> : null}
        {showReviewAction ? <button className={primaryButton} disabled={busy || followUps.preparationBlockers?.length > 0} onClick={() => runAction('prepare', onPrepare, {})} type="button">{state === 'retry' ? 'Review Retry' : 'Review Follow-Up'}</button> : null}
        {showViewerPreview ? <button className={secondaryButton} disabled={busy || followUps.preparationBlockers?.length > 0} onClick={() => runAction('prepare', onPrepare, {})} type="button">Preview Follow-Up</button> : null}
        {canStop ? <button className={`${secondaryButton} text-red-700`} disabled={busy} onClick={() => setStopOpen(true)} ref={stopButtonRef} type="button">Stop Follow-Up Sequence</button> : null}
        {state === 'ambiguous' || checking || stopStatus ? <button className={secondaryButton} disabled={!onCheckStatus || (checking && !checkingFailed)} onClick={onCheckStatus} type="button">{checkingFailed || state === 'ambiguous' ? 'Check Again' : 'Check Status'}</button> : null}
      </div>

      {stopOpen ? <div aria-label="Permanently stop follow-ups" aria-modal="true" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4" role="dialog">
        <h5 className="text-sm font-semibold text-red-950">Permanently stop follow-ups</h5>
        <p className="mt-1 text-sm text-red-900/75">This cannot be restarted. A currently provider-authorized touch may still need status reconciliation.</p>
        <label className="mt-3 block text-xs font-semibold text-ink/68">Stop reason (optional)<textarea aria-label="Stop reason (optional)" className="form-control mt-1 min-h-20" maxLength={240} onChange={(event) => setStopReason(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation(); }} ref={stopReasonRef} value={stopReason} /></label>
        <div className="mt-3 flex flex-wrap gap-2"><button className={`${primaryButton} bg-red-700 hover:bg-red-800`} disabled={busy} onClick={confirmStop} type="button">Permanently Stop</button><button className={secondaryButton} disabled={busy} onClick={closeStop} type="button">Cancel</button></div>
      </div> : null}

      {preparing && !review ? <div className="mt-4"><p className="text-sm text-ink/68">Preparing the exact server-authored follow-up for review…</p><div aria-hidden="true" className="mt-3 animate-pulse space-y-2"><div className="h-4 rounded bg-moss/10" /><div className="h-24 rounded bg-moss/10" /></div></div> : null}

      {review ? <div className={`mt-5 space-y-5 border-t border-moss/15 pt-5 ${mobileSticky ? 'pb-32 sm:pb-0' : ''}`} data-testid="broker-materials-follow-up-review">
        <h5 className="text-base font-semibold text-ink outline-none" ref={reviewHeadingRef} tabIndex={-1}>{review.mode === 'exact-retry' ? 'Review Retry' : 'Review'} Follow-Up {review.followUpNumber} of {maximum}</h5>
        <section><h6 className="text-sm font-semibold text-ink">Opportunity</h6><p className="mt-2 text-sm text-ink/68">{businessName}</p></section>
        <section><h6 className="text-sm font-semibold text-ink">Chronology</h6><p className="mt-2 text-sm text-ink/68">Initial request · {formatPacific(review.initialRequestedAt)} PT</p><p className="mt-1 text-sm text-ink/68">Previous provider acceptance · {formatPacific(review.previousAcceptedAt)} PT</p><p className="mt-1 text-sm text-ink/68">This follow-up due · {formatPacific(review.dueAt)} PT</p></section>
        <section><h6 className="text-sm font-semibold text-ink">Recipient</h6><p className="mt-2 text-sm text-ink/68">{review.recipient?.displayName || 'Broker'} · {review.recipient?.email || 'Email unavailable'}</p></section>
        <section><h6 className="text-sm font-semibold text-ink">Sender</h6><p className="mt-2 text-sm text-ink/68">{review.sender?.displayName || 'Sender'} · {review.sender?.email || 'Email unavailable'}{review.sender?.replyTo ? ` · Reply to ${review.sender.replyTo}` : ''}</p></section>
        <section><h6 className="text-sm font-semibold text-ink">Greeting</h6>{greetingEditable ? <><input aria-describedby={greetingDirty ? `${contentId}-greeting-help` : undefined} aria-label="Follow-up greeting" className="form-control mt-2 scroll-mb-32 sm:scroll-mb-0" maxLength={120} onChange={(event) => changeGreeting(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (greetingDirty) updatePreview(); } }} ref={greetingRef} value={greeting} />{greetingDirty ? <p className="mt-2 text-sm text-amber-800" id={`${contentId}-greeting-help`}>{greetingError || 'Preview needs updating before approval.'}</p> : null}{greetingDirty ? <button className={`${secondaryButton} mt-2`} disabled={busy || Boolean(greetingError)} onClick={updatePreview} type="button">Update Preview</button> : null}</> : <p className="mt-2 whitespace-pre-wrap text-sm text-ink/68">{message?.greeting || 'Persisted in the exact message below.'}</p>}</section>
        <section><h6 className="text-sm font-semibold text-ink">Subject</h6><input aria-label="Follow-up subject" className="form-control mt-2" readOnly value={message?.subject || ''} /></section>
        <section><h6 className="text-sm font-semibold text-ink">Complete message body</h6><textarea aria-label="Complete follow-up body" className="form-control mt-2 min-h-52 whitespace-pre-wrap" readOnly value={message?.body || ''} /></section>
        <section><h6 className="text-sm font-semibold text-ink">Current send blockers</h6><MessageList empty="No current send blockers." items={blockers} /></section>
        <section><h6 className="text-sm font-semibold text-ink">Expiration</h6><p className="mt-2 text-sm text-ink/68">Prepared {formatPacific(preparation.preparedAt)} PT · Expires {formatPacific(preparation.expiresAt)} PT</p></section>
        <section className={mobileSticky ? 'sticky bottom-0 z-[5] -mx-4 border-t border-moss/20 bg-white/95 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(25,56,44,0.12)] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0 sm:shadow-none sm:backdrop-blur-0' : ''} data-mobile-sticky={mobileSticky ? 'true' : 'false'} data-testid="broker-materials-follow-up-approval">
          <h6 className="text-sm font-semibold text-ink">Final approval</h6>
          <p className="mt-2 text-sm text-ink/68">This sends exactly Follow-Up {review.followUpNumber} of {maximum} to {review.recipient?.email || 'the reviewed recipient'}.</p>
          {stale ? <p className="mt-2 text-sm text-amber-800">Current authority changed. Review a fresh server-authored proposal before sending.</p> : null}
          {readOnly ? <p className="mt-2 text-sm font-semibold text-ink/62">Read-only preview. Approval authority is unavailable.</p> : <><button className={`${primaryButton} mt-3 w-full sm:w-auto`} disabled={approvalInvalid} onClick={approve} type="button">Approve &amp; Send Follow-Up</button>{stale ? <button className={`${secondaryButton} mt-3 w-full sm:ml-2 sm:w-auto`} disabled={busy} onClick={() => runAction('update', onPrepare, message?.greetingEditable ? { greeting: message.greeting } : {})} type="button">Review Again</button> : null}</>}
          {sending || localBusy === 'approve' ? <p className="mt-2 text-sm text-ink/68">Submitting the one approved follow-up…</p> : null}
        </section>
      </div> : null}
    </section>
  );
}
