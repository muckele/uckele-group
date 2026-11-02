import React, { useEffect, useRef } from 'react';

// Presentation of the owner criteria groups in the Acquisition Inbox. The server
// decides pass/fail and sends each rule's limits on the must-have entry; nothing
// here knows a threshold. Rows stored before limits were emitted simply show the
// observed value without the parenthetical rule.

const blockerReasons = {
  generic_mailbox: 'only a generic mailbox',
  recipient_not_single: 'no single verified broker',
  prior_outreach: 'this broker or deal was contacted before',
  identity_unresolved: 'identity needs review',
  suppressed: 'the broker opted out or bounced',
  criteria_out_of_date: 'criteria out of date',
  owner_decision_exists: 'you already decided on this deal',
  authority_unavailable: 'broker details could not be checked',
};

const missedLabels = {
  profit: 'the profit range',
  multiple: 'the multiple limit',
  geography: 'the target geography',
  industry: 'the target industries',
  gates: 'a deal gate',
};

const modeLabels = {
  off: 'Off — would Pursue', shadow: 'Shadow', canary: 'Test', active: 'On',
};

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactMoney(value) {
  if (value >= 1_000_000) return `$${(Math.round(value / 100_000) / 10).toString()}M`;
  return `$${Math.round(value / 1000)}K`;
}

function multiple(value, digits = 1) {
  return `${Number.isInteger(value) ? value : value.toFixed(digits)}×`;
}

function stateCode(observed) {
  const text = String(observed || '');
  const afterBar = text.split('|').at(-1).trim();
  if (/^[A-Z]{2}$/.test(afterBar)) return afterBar;
  return text.match(/(?:^|[^A-Za-z])([A-Z]{2})(?![A-Za-z])/)?.[1] || '';
}

function mustHavePhrase(entry, row) {
  const observed = entry.observed;
  const pass = entry.outcome === 'pass';
  const unknown = entry.outcome === 'unknown';
  switch (entry.id) {
    case 'profit': {
      const value = number(observed);
      if (unknown || value === null) return 'Profit not disclosed';
      if (pass) return `Profit ${compactMoney(value)} ✓`;
      const min = number(entry.limit?.min);
      const max = number(entry.limit?.max);
      let rule = '';
      if (min !== null && value < min) rule = ` (min ${compactMoney(min)})`;
      else if (max !== null && value > max) rule = ` (max ${compactMoney(max)})`;
      return `Profit ${compactMoney(value)}${rule}`;
    }
    case 'multiple': {
      const value = number(observed);
      if (unknown || value === null) return 'Multiple not disclosed';
      if (pass) return `${multiple(value)} ✓`;
      const max = number(entry.limit?.max);
      return `Multiple ${multiple(value)}${max !== null ? ` (max ${multiple(max)})` : ''}`;
    }
    case 'geography': {
      const code = stateCode(observed);
      if (unknown) return 'Location not disclosed';
      if (pass) return `${code || 'Target state'} ✓`;
      const states = Array.isArray(entry.targetStates) ? entry.targetStates.filter((state) => typeof state === 'string' && state) : [];
      return `Location ${code || 'unknown'}${states.length > 0 ? ` (target: ${states.join(', ')})` : ''}`;
    }
    case 'industry': {
      const industry = String(row?.industry || '').trim();
      if (unknown) return 'Industry not disclosed';
      return pass ? `${industry || 'Target industry'} ✓` : `Industry ${industry || 'unknown'} (not a target industry)`;
    }
    case 'gates': {
      if (pass) return '';
      const count = number(observed);
      return count && count > 1 ? `${count} blocking gates` : 'Blocking gate';
    }
    default:
      return '';
  }
}

export function criteriaLineText(row) {
  const mustHaves = row?.criteriaResult?.mustHaves;
  if (!Array.isArray(mustHaves) || mustHaves.length === 0) return '';
  return mustHaves.map((entry) => mustHavePhrase(entry, row)).filter(Boolean).join(' · ');
}

export function CriteriaLine({ row }) {
  const text = criteriaLineText(row);
  if (!text) return null;
  const clean = row.criteriaResult.mustHaves.every((entry) => entry.outcome === 'pass');
  return <p className={`mt-1 text-sm font-medium ${clean ? 'text-moss' : 'text-amber-800'}`}>{text}</p>;
}

export function blockerReason(code) {
  return blockerReasons[code] || 'not eligible right now';
}

export function NotAutomaticReason({ row }) {
  const code = row?.autoPursueBlocker || (row?.criteriaCurrent === false ? 'criteria_out_of_date' : '');
  if (!code) return null;
  return <p className="mt-1 text-sm text-ink/68">Not automatic: {blockerReason(code)}</p>;
}

export function isNearMiss(row) {
  return row?.criteriaGroup === 'near-miss' && row?.criteriaCurrent !== false;
}

export function missedMustHaves(row) {
  const failed = Array.isArray(row?.criteriaResult?.failed) ? row.criteriaResult.failed : [];
  const labels = failed.map((id) => missedLabels[id]).filter(Boolean);
  if (labels.length === 0) return 'a must-have';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export function nearMissPrompt(row) {
  return `This deal misses ${missedMustHaves(row)}. Request the SIM anyway?`;
}

export function AutoPursueModeBadge({ status }) {
  const label = modeLabels[status?.mode];
  if (!label) return null;
  const counted = status.mode === 'canary' || status.mode === 'active';
  const cap = number(status.dailyCap);
  const today = number(status.todayCommands);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-moss/10 px-2 py-0.5 text-xs font-semibold text-moss">{label}</span>
      {counted && cap !== null && today !== null ? <span className="text-xs font-semibold text-ink/62">{today} of {cap} today</span> : null}
    </span>
  );
}

export function NearMissConfirmDialog({ name, onCancel, onConfirm, pending, row }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
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
      const focusable = [...dialog.querySelectorAll('button:not([disabled])')];
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
      <div aria-describedby="near-miss-confirm-message" aria-labelledby="near-miss-confirm-title" aria-modal="true" className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-2xl" ref={dialogRef} role="dialog">
        <h2 className="sr-only" id="near-miss-confirm-title">Confirm Request SIM for {name}</h2>
        <p className="text-sm font-semibold leading-6 text-ink" id="near-miss-confirm-message">{nearMissPrompt(row)}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50" disabled={pending} onClick={onCancel} ref={cancelRef} type="button">Cancel</button>
          <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-moss bg-moss px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50" disabled={pending} onClick={onConfirm} type="button">Request SIM</button>
        </div>
      </div>
    </div>
  );
}

// Inline variant for the opportunity drawer, which traps focus and so cannot host a second modal.
export function NearMissConfirmPanel({ onCancel, onConfirm, pending, row }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div aria-label="Confirm Request SIM" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4" role="group">
      <p className="text-sm font-semibold leading-6 text-amber-950">{nearMissPrompt(row)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-moss bg-moss px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50" disabled={pending} onClick={onConfirm} type="button">Request SIM</button>
        <button className="inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50" disabled={pending} onClick={onCancel} ref={cancelRef} type="button">Cancel</button>
      </div>
    </div>
  );
}
