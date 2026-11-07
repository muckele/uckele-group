import React, { useEffect, useRef, useState } from 'react';
import { blockerReason } from './AcquisitionCriteria.jsx';

// The owner's Automatic Pursue switch in the Acquisition Inbox (spec 2026-11-02 best-first deal
// list, section 6.2). Only Off and Shadow are offered here; both record no Pursue. Test (canary)
// and On (active) stay out of this control. Off is still offered when either was set elsewhere,
// so the owner can always stop it from the inbox. The server checks the typed phrase again and
// owns every rule; this component only collects it.

const modeChanges = {
  shadow: {
    label: 'Shadow',
    phrase: 'ACTIVATE AUTO PURSUE SHADOW',
    explanation: 'Shadow checks every top-match deal after the weekday morning Sheet sync and records which ones it would Pursue. It never records a Pursue or sends email.',
  },
  off: {
    label: 'Off',
    phrase: 'SET AUTO PURSUE OFF',
    explanation: 'Off records no Pursue and sends no email. The weekday check still runs, so the inbox keeps showing which deals would qualify.',
  },
};

const warmupTargets = { decisions: 25, autoDecisions: 10, unchangedRate: 95 };
const staleRunMs = 60 * 60 * 1000;

// Why a deal the runner did not block was still held back (outcome skipped or error).
const heldBackLabels = {
  blocked_earlier_today: 'blocked earlier today',
  already_recorded: 'already requested today',
  stale_revision: 'the deal changed during the check',
  run_stopped: 'the check stopped early',
  warmup_not_ready: 'warm-up is not complete',
  warmup_unavailable: 'warm-up could not be checked',
  daily_cap_reached: 'the daily limit was reached',
  mode_changed: 'the mode changed during the check',
  business_date_changed: 'the business day ended during the check',
  decision_count_unavailable: "today's count could not be checked",
  runner_storage_unavailable: 'the check could not read its records',
  command_error: 'a request could not be recorded',
};

function heldBackLabel(code) {
  const text = String(code || '');
  if (heldBackLabels[text]) return heldBackLabels[text];
  if (text.startsWith('command_rejected_')) return 'a request could not be recorded';
  return blockerReason(text);
}

function count(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatRunTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  const text = new Date(parsed).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `${text} PT`;
}

/** Counts of one run's items: what it would (or did) Pursue, and why the rest were not automatic. */
export function summarizeAutoPursueRun(run) {
  const items = Array.isArray(run?.items) ? run.items : [];
  const counted = run?.mode === 'canary' || run?.mode === 'active';
  const reasons = new Map();
  let picked = 0;
  let blocked = 0;
  let heldBack = 0;
  const note = (label) => reasons.set(label, (reasons.get(label) || 0) + 1);
  for (const item of items) {
    if (item?.outcome === (counted ? 'pursued' : 'would-pursue')) picked += 1;
    else if (item?.outcome === 'blocked') {
      blocked += 1;
      note(blockerReason(item.reason));
    } else if (item?.outcome === 'skipped' || item?.outcome === 'error') {
      heldBack += 1;
      note(heldBackLabel(item.reason));
    }
  }
  const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { counted, picked, blocked, heldBack, reasons: sorted };
}

function LastRun({ run }) {
  if (!run) {
    return <p className="text-xs leading-5 text-ink/62">No automatic check has run yet. Checks run after the weekday 7:30 AM PT Sheet sync.</p>;
  }
  const when = formatRunTime(run.createdAt);
  const prefix = when ? `Last check ${when}` : 'Last check';
  if (!run.completedAt) {
    const startedAt = Date.parse(run.createdAt);
    if (Number.isFinite(startedAt) && Date.now() - startedAt > staleRunMs) {
      return <p className="text-xs leading-5 text-amber-800">{when ? `A check started ${when}` : 'A check started'} and did not record a result. The next weekday check will try again.</p>;
    }
    return <p className="text-xs leading-5 text-ink/62">A check is running now{when ? ` (started ${when})` : ''}.</p>;
  }
  if (run.status === 'failed') {
    return <p className="text-xs leading-5 text-amber-800">{prefix} did not finish. The next weekday check will try again.</p>;
  }
  if (run.reason === 'fingerprints_unavailable') {
    return <p className="text-xs leading-5 text-amber-800">{prefix} could not confirm deals against a fresh Sheet refresh, so no deals were checked.</p>;
  }
  const summary = summarizeAutoPursueRun(run);
  return (
    <div>
      <p className="text-xs leading-5 text-ink/70">{prefix}: {summary.counted ? 'requested' : 'would Pursue'} {summary.picked}, not automatic {summary.blocked}{summary.heldBack ? `, held back ${summary.heldBack}` : ''}.</p>
      {run.reason ? <p className="text-xs leading-5 text-amber-800">Stopped early: {heldBackLabel(run.reason)}.</p> : null}
      {summary.reasons.length ? (
        <ul aria-label="Why deals were not automatic" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink/58">
          {summary.reasons.map(([label, total]) => <li key={label}>{label}: {total}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function WarmupLine({ mode, warmup }) {
  if (!warmup || typeof warmup !== 'object') return null;
  if (warmup.ready === true) return <p className="text-xs leading-5 text-ink/62">Warm-up complete.</p>;
  const autoDecisions = count(warmup.autoDecisions);
  const parts = [
    `${count(warmup.totalDecisions)} of ${warmupTargets.decisions} decisions`,
    `${autoDecisions} of ${warmupTargets.autoDecisions} top-match decisions`,
  ];
  const rate = Number(warmup.autoUnchangedRate);
  if (autoDecisions > 0 && Number.isFinite(rate)) {
    // Floor, not round: the server needs at least 0.95, so 18 of 19 (94.7%) must not read as 95%.
    parts.push(`${Math.floor(Math.max(0, Math.min(rate, 1)) * 100)}% matched (${warmupTargets.unchangedRate}% needed)`);
  }
  const lead = mode === 'canary' || mode === 'active' ? 'Warm-up no longer met' : 'Warm-up before Test or On';
  return <p className="text-xs leading-5 text-ink/62">{lead}: {parts.join(' · ')}.</p>;
}

function ConfirmPanel({ change, onCancel, onConfirm, pending, error }) {
  const [phrase, setPhrase] = useState('');
  const [reason, setReason] = useState('');
  const phraseRef = useRef(null);
  useEffect(() => {
    phraseRef.current?.focus();
  }, []);
  const settings = modeChanges[change];
  const phraseId = `auto-pursue-phrase-${change}`;
  const reasonId = `auto-pursue-reason-${change}`;
  const matches = phrase === settings.phrase;
  return (
    <div aria-label={`Confirm ${settings.label} mode`} className="mt-3 rounded-xl border border-line bg-fog/60 p-3" role="group">
      <p className="text-sm leading-6 text-ink">{settings.explanation}</p>
      <label className="mt-3 block text-xs font-semibold text-ink/70" htmlFor={phraseId}>Type {settings.phrase} to confirm</label>
      <input autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" disabled={pending} id={phraseId} onChange={(event) => setPhrase(event.target.value)} ref={phraseRef} spellCheck={false} type="text" value={phrase} />
      <label className="mt-3 block text-xs font-semibold text-ink/70" htmlFor={reasonId}>Reason (optional)</label>
      <input className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" disabled={pending} id={reasonId} maxLength={500} onChange={(event) => setReason(event.target.value)} type="text" value={reason} />
      {error ? <p className="mt-2 text-xs font-semibold text-red-800" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-moss bg-moss px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50" disabled={pending || !matches} onClick={() => onConfirm({ phrase, reason: reason.trim() })} type="button">{pending ? 'Saving…' : `Confirm ${settings.label}`}</button>
        <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50" disabled={pending} onClick={onCancel} type="button">Cancel</button>
      </div>
    </div>
  );
}

export default function AutoPursueControl({ onChanged, readOnly = false, status }) {
  const [change, setChange] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlightRef = useRef(false);
  const triggerRef = useRef(null);
  const returnFocusRef = useRef(false);
  const mode = status?.mode;
  const changeRef = useRef('');
  changeRef.current = change;
  // A mode changed elsewhere makes an open panel's choice out of date: close it, unless a save
  // is in flight (its own result closes the panel or shows the error).
  useEffect(() => {
    if (inFlightRef.current) return;
    if (changeRef.current) returnFocusRef.current = true;
    setChange('');
    setError('');
  }, [mode]);
  useEffect(() => {
    if (!change && returnFocusRef.current) {
      returnFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [change]);
  if (!status || typeof status !== 'object' || !status.mode) return null;
  const target = status.mode === 'off' ? 'shadow' : 'off';
  const buttonLabel = target === 'shadow' ? 'Switch to Shadow' : 'Turn off Automatic Pursue';

  async function confirm({ phrase, reason }) {
    if (readOnly || inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    setError('');
    const failure = 'Unable to change the Automatic Pursue mode.';
    try {
      const response = await fetch('/api/admin/deal-hunter/auto-pursue/mode', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: change, confirmation: phrase, reason }),
      });
      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (!response.ok || !result?.success) throw new Error(result?.error || failure);
      returnFocusRef.current = true;
      setChange('');
      onChanged?.();
    } catch (changeError) {
      setError(changeError?.message || failure);
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="border-b border-line/80 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <LastRun run={status.latestRun} />
          <WarmupLine mode={status.mode} warmup={status.warmup} />
        </div>
        {!readOnly && !change ? (
          <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss" onClick={() => { setError(''); setChange(target); }} ref={triggerRef} type="button">{buttonLabel}</button>
        ) : null}
      </div>
      {!readOnly && change ? (
        <ConfirmPanel change={change} error={error} key={change} onCancel={() => { returnFocusRef.current = true; setChange(''); setError(''); }} onConfirm={confirm} pending={pending} />
      ) : null}
    </div>
  );
}
