import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

const factFields = [
  ['seller_name', 'Seller name'], ['seller_email', 'Seller email'], ['seller_phone', 'Seller phone'],
  ['broker_name', 'Broker name'], ['broker_company', 'Broker company'], ['broker_email', 'Broker email'], ['broker_phone', 'Broker phone'],
  ['reason_for_sale', 'Reason for sale'], ['real_estate_included', 'Real estate included'], ['seller_financing', 'Seller financing'],
  ['management_structure', 'Management structure'], ['customer_concentration', 'Customer concentration'], ['operator_contact_notes', 'Operator contact notes'],
];
const factLabels = Object.fromEntries(factFields);
const missingLabels = { annual_profit: 'SDE / profit', annual_revenue: 'Revenue', asking_price: 'Asking price', listing_url: 'Original listing URL', ...factLabels };
const sectionClass = 'rounded-2xl border border-line bg-white p-4 sm:p-5';
const secondaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:opacity-50';
const primaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-moss bg-moss px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50';

function formatLabel(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number) : String(value);
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

function safeListingUrl(value) {
  if (typeof value !== 'string' || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return '';
  try {
    const parsed = new URL(value.trim());
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

function hasValue(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function focusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

function Section({ children, title, ...props }) {
  return <section className={sectionClass} {...props}><h3 className="text-base font-semibold text-ink">{title}</h3><div className="mt-4">{children}</div></section>;
}

function Provenance({ fact }) {
  const labels = { operator: 'Operator verified', crm: 'CRM', 'structured-source': 'Structured source', 'enrichment-suggestion': 'Enrichment suggestion' };
  return <span className="rounded-full border border-line bg-fog px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/58">{labels[fact?.provenance] || formatLabel(fact?.provenance || 'unknown')}</span>;
}

function Fact({ detail, field }) {
  const fact = detail.effectiveFacts?.[field];
  if (!hasValue(fact?.value)) return null;
  return <div className="rounded-xl border border-line/70 bg-fog/50 p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink/48">{factLabels[field]}</p><Provenance fact={fact} /></div><p className="mt-1.5 text-sm leading-6 text-ink">{String(fact.value)}</p>{fact.note ? <p className="mt-1 text-xs text-ink/58">{fact.note}</p> : null}</div>;
}

function MissingInformation({ fields }) {
  if (!fields?.length) return null;
  return <section aria-label="Missing Information" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h4 className="text-sm font-semibold text-amber-950">Missing Information</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{fields.map((field) => <div className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm" key={field}><span className="font-medium text-ink">{missingLabels[field] || formatLabel(field)}</span><span className="text-amber-800">Not provided</span></div>)}</div></section>;
}

export function PassForm({ error = '', initialFocusRef, name, onCancel, onSubmit, pending = false }) {
  const [draft, setDraft] = useState({ reason: '', note: '' });
  function submit(event) {
    event.preventDefault();
    const reason = draft.reason.trim();
    if (!reason) return;
    onSubmit?.({ reason, note: draft.note.trim() });
  }
  return (
    <form aria-label={`Pass ${name}`} className="rounded-xl border border-red-200 bg-red-50 p-4" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-red-950">Pass on {name}</h4>
      <p className="mt-1 text-xs leading-5 text-red-900/70">The opportunity stays in durable disposition history and can be restored later.</p>
      {error ? <p className="mt-3 rounded-lg border border-red-200 bg-white/75 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      <label className="mt-3 block text-xs font-semibold text-ink/62">Pass reason<input aria-label="Pass reason" className="form-control mt-1" maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} ref={initialFocusRef} required value={draft.reason} /></label>
      <label className="mt-3 block text-xs font-semibold text-ink/62">Pass note (optional)<textarea aria-label="Pass note (optional)" className="form-control mt-1 min-h-24" maxLength={2000} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} value={draft.note} /></label>
      <div className="mt-3 flex flex-wrap gap-2"><button className={`${secondaryButton} text-red-700`} disabled={pending || !draft.reason.trim()} type="submit">Confirm Pass</button>{onCancel ? <button className={secondaryButton} disabled={pending} onClick={onCancel} type="button">Cancel</button> : null}</div>
    </form>
  );
}

function DetailActions({ name, onAction, onPass, pending }) {
  if (!onAction) return null;
  return <div className="flex flex-wrap gap-2"><button aria-label={`Pursue ${name}`} className={primaryButton} disabled={pending} onClick={() => onAction('pursue')} type="button">Pursue</button><button aria-label={`Watch ${name}`} className={secondaryButton} disabled={pending} onClick={() => onAction('watch')} type="button">Watch</button><button aria-label={`Pass ${name}`} className={`${secondaryButton} text-red-700`} disabled={pending} onClick={onPass} type="button">Pass</button></div>;
}

function VerifiedFactForm({ detail, onSaveFact, pending }) {
  const [draft, setDraft] = useState({ field: factFields[0][0], value: detail.effectiveFacts?.[factFields[0][0]]?.value || '', note: '' });
  function selectField(field) {
    const current = detail.effectiveFacts?.[field];
    setDraft({ field, value: current?.value || '', note: current?.note || '' });
  }
  function submit(event) {
    event.preventDefault();
    if (!String(draft.value).trim()) return;
    onSaveFact({ field: draft.field, value: String(draft.value).trim(), note: draft.note.trim(), verified: true });
  }
  return (
    <form className="rounded-xl border border-moss/20 bg-moss/5 p-4" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-ink">Add or edit a verified operator fact</h4>
      <p className="mt-1 text-xs leading-5 text-ink/58">Verified facts remain separate from machine scoring and outrank refreshed source observations.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-ink/62">Verified fact field<select aria-label="Verified fact field" className="form-control mt-1" onChange={(event) => selectField(event.target.value)} value={draft.field}>{factFields.map(([field, label]) => <option key={field} value={field}>{label}</option>)}</select></label><label className="text-xs font-semibold text-ink/62">Verified fact value<input aria-label="Verified fact value" className="form-control mt-1" onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} value={draft.value} /></label></div>
      <label className="mt-3 block text-xs font-semibold text-ink/62">Verification note<textarea aria-label="Verification note" className="form-control mt-1 min-h-20" onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} value={draft.note} /></label>
      <button className={`${primaryButton} mt-3`} disabled={pending || !String(draft.value).trim()} type="submit">Save verified fact</button>
    </form>
  );
}

function EvidenceItem({ evidence }) {
  const listingUrl = safeListingUrl(evidence.listingUrl);
  return <li className="rounded-lg bg-fog/60 p-3 text-xs leading-5 text-ink/68"><strong>{evidence.ruleLabel || formatLabel(evidence.ruleId)}</strong><p>{[evidence.evidenceClass && `Class: ${formatLabel(evidence.evidenceClass)}`, evidence.field && `Field: ${formatLabel(evidence.field)}`, hasValue(evidence.value) && `Value: ${evidence.value}`].filter(Boolean).join(' · ')}</p>{hasValue(evidence.observedValue) ? <p>Observed value: {String(evidence.observedValue)}</p> : null}{evidence.terms?.length ? <p>Terms: {evidence.terms.join(', ')}</p> : null}{evidence.sourceName || evidence.sourceId ? <p>Source: {evidence.sourceName || evidence.sourceId}</p> : null}{evidence.sourceRecordId ? <p>Source record: {evidence.sourceRecordId}</p> : null}{evidence.observedAt ? <p>Observed {formatDate(evidence.observedAt)}</p> : null}{listingUrl ? <a className="font-semibold text-moss underline" href={listingUrl} rel="noopener noreferrer" target="_blank">Open evidence listing<ExternalLink className="ml-1 inline h-3 w-3" /></a> : null}</li>;
}

function CommunicationList({ communications, title }) {
  if (!communications?.length) return null;
  return <div className="mt-4"><h4 className="text-sm font-semibold text-ink">{title}</h4><ul className="mt-2 space-y-2">{communications.map((item) => <li className="rounded-lg border border-line/70 bg-white p-3 text-sm text-ink/68" key={`${title}-${item.id}`}>{formatLabel(item.direction)} · {formatLabel(item.channel)} · {formatLabel(item.kind)}{item.occurredAt ? ` · ${formatDate(item.occurredAt)}` : ''}</li>)}</ul></div>;
}

function conflictKey(observation) {
  return `${observation.sourceId || observation.sourceName}-${observation.sourceRecordId || ''}-${observation.value}`;
}

export default function OpportunityDrawer({ detail, error = '', focusGuardRef, loading = false, mutationError = '', onAction, onClose, onRetry, onSaveFact, pending = false, readOnly = false }) {
  const [passOpen, setPassOpen] = useState(false);
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const opportunity = detail?.opportunity;
  const name = opportunity?.name || 'Opportunity detail';
  const safeUrls = [...new Set((detail?.listingUrls || []).map(safeListingUrl).filter(Boolean))];
  const actionable = Boolean(onAction && opportunity && !opportunity.dismissed && !readOnly);
  const strengths = (detail?.score?.summary?.strengths || []).filter(hasValue);
  const concerns = (detail?.score?.summary?.concerns || []).filter(hasValue);
  const reviewState = opportunity?.reviewed ? 'Reviewed' : 'Needs Review';
  const changedState = opportunity?.changedSinceReview ? 'Changed' : 'Current';
  useLayoutEffect(() => {
    closeButtonRef.current?.focus();
  }, [loading]);
  function handleDialogKeyDown(event) {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(dialogRef.current);
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  useEffect(() => {
    function handleDocumentKeyDown(event) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.contains(document.activeElement)) {
        if (event.key === 'Tab') {
          event.preventDefault();
          closeButtonRef.current?.focus();
        }
        return;
      }
      handleDialogKeyDown(event);
    }
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown);
  });
  useEffect(() => {
    function handleDocumentFocusIn(event) {
      const dialog = dialogRef.current;
      if (focusGuardRef?.current && dialog && !dialog.contains(event.target)) closeButtonRef.current?.focus();
    }
    document.addEventListener('focusin', handleDocumentFocusIn);
    return () => document.removeEventListener('focusin', handleDocumentFocusIn);
  }, [focusGuardRef]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" role="presentation">
      <section aria-labelledby="opportunity-detail-title" aria-modal="true" className="h-full w-full overflow-y-auto border-l border-line bg-fog shadow-2xl sm:max-w-3xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-line bg-white/95 p-5 backdrop-blur"><div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-moss">Opportunity View</p><h2 className="mt-1 truncate text-xl font-semibold text-ink" id="opportunity-detail-title">{name}</h2>{opportunity ? <p className="mt-1 text-xs text-ink/58">{opportunity.geography?.label || opportunity.state} · {opportunity.industry}</p> : null}</div><button aria-label="Close opportunity detail" className="rounded-full border border-line bg-white p-2 text-ink/60 hover:text-ink disabled:opacity-50" disabled={pending} onClick={onClose} ref={closeButtonRef} type="button"><X className="h-5 w-5" /></button></header>
        <div className="space-y-5 p-4 sm:p-5">
          {loading ? <p className="text-sm text-ink/62">Loading everything currently known…</p> : null}
          {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
          {error && onRetry ? <button className={secondaryButton} onClick={onRetry} type="button">Retry opportunity detail</button> : null}
          {mutationError ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{mutationError}</p> : null}
          {detail ? <>
            <Section title="Overview">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
                ['Fit', opportunity.fitScore], ['Confidence', formatLabel(opportunity.confidence)], ['Operator state', formatLabel(opportunity.operatorPriority || 'normal')], ['Machine state', formatLabel(opportunity.scoreStatus)],
                ['Completeness', `${opportunity.completenessScore}%`], ['Review', `${reviewState} · ${changedState}`], ['Workflow', `CRM: ${formatLabel(opportunity.workflow?.crmStatus || 'not-started')} · CIM: ${formatLabel(opportunity.workflow?.cimStatus || 'not-requested')}`],
                ['Evidence', `${opportunity.missingEvidenceCount} missing evidence · ${opportunity.contradictionCount} contradiction${opportunity.contradictionCount === 1 ? '' : 's'}`],
              ].map(([label, value]) => <div className="rounded-xl bg-fog/70 p-3" key={label}><p className="text-xs text-ink/48">{label}</p><p className="mt-1 text-sm font-semibold text-ink">{value}</p></div>)}</div>
              {opportunity.observationFreshness ? <p className="mt-3 text-xs text-ink/55">Observed {formatDate(opportunity.observationFreshness)}{opportunity.scoredAt ? ` · Scored ${formatDate(opportunity.scoredAt)}` : ''}{opportunity.rulesVersion ? ` · ${opportunity.rulesVersion}` : ''}</p> : null}
              {opportunity.dismissed ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">Passed: {formatLabel(opportunity.dismissedReason || 'dismissed')}</p> : null}
              <div className="mt-4"><DetailActions name={name} onAction={actionable ? onAction : undefined} onPass={() => setPassOpen(true)} pending={pending} /></div>
              {passOpen && actionable ? <div className="mt-4"><PassForm error="" name={name} onCancel={() => setPassOpen(false)} onSubmit={(payload) => onAction('pass', payload)} pending={pending} /></div> : null}
              {opportunity.topStrength ? <p className="mt-4 rounded-xl bg-moss/8 p-3 text-sm leading-6 text-moss">{opportunity.topStrength}</p> : null}{opportunity.topConcern ? <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">{opportunity.topConcern}</p> : null}{detail.missingCriticalFields?.length ? <div className="mt-4"><MissingInformation fields={detail.missingCriticalFields} /></div> : null}
            </Section>

            <Section title="Business & Financials">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['SDE / profit', formatMoney(opportunity.financials?.annualProfit)], ['Revenue', formatMoney(opportunity.financials?.annualRevenue)], ['Asking price', formatMoney(opportunity.financials?.askingPrice)], ['Profit multiple', opportunity.financials?.profitMultiple === null || opportunity.financials?.profitMultiple === undefined ? '' : `${opportunity.financials.profitMultiple}×`]].filter(([, value]) => value).map(([label, value]) => <div className="rounded-xl bg-fog/70 p-3" key={label}><p className="text-xs text-ink/48">{label}</p><p className="mt-1 text-sm font-semibold text-ink">{value}</p></div>)}</div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">{['management_structure', 'customer_concentration', 'reason_for_sale', 'real_estate_included', 'seller_financing'].map((field) => <Fact detail={detail} field={field} key={field} />)}</div>
            </Section>

            <Section title="Broker & Seller"><div className="grid gap-3 sm:grid-cols-2">{['broker_name', 'broker_company', 'broker_email', 'broker_phone', 'seller_name', 'seller_email', 'seller_phone', 'operator_contact_notes'].map((field) => <Fact detail={detail} field={field} key={field} />)}</div>{!readOnly && onSaveFact ? <div className="mt-4"><VerifiedFactForm detail={detail} key={opportunity.opportunityId} onSaveFact={onSaveFact} pending={pending} /></div> : null}</Section>

            <Section title="Score & Evidence">
              {strengths.length || concerns.length ? <div className="grid gap-3 sm:grid-cols-2">{strengths.length ? <div className="rounded-xl bg-moss/8 p-3"><h4 className="text-sm font-semibold text-moss">Strengths</h4>{strengths.map((item) => <p className="mt-1 text-sm text-ink/70" key={item}>{item}</p>)}</div> : null}{concerns.length ? <div className="rounded-xl bg-amber-50 p-3"><h4 className="text-sm font-semibold text-amber-900">Concerns</h4>{concerns.map((item) => <p className="mt-1 text-sm text-ink/70" key={item}>{item}</p>)}</div> : null}</div> : null}
              {detail.score.confidenceReasons?.length ? <p className="mt-3 rounded-xl bg-fog/70 p-3 text-sm text-ink/70">Confidence: {detail.score.confidenceReasons.join(' ')}</p> : null}{detail.score.missingEvidence?.length ? <p className="mt-3 text-sm text-amber-800">Missing evidence: {detail.score.missingEvidence.map(formatLabel).join(' · ')}</p> : null}
              <div className="mt-3 space-y-3">{detail.score.dimensions?.map((dimension) => <div className="rounded-xl border border-line/70 p-3" key={dimension.id}><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold text-ink">{dimension.label}</h4><span className="text-sm font-semibold tabular-nums text-moss">{dimension.contribution > 0 ? '+' : ''}{dimension.contribution}</span></div>{dimension.evidence?.length ? <ul className="mt-2 space-y-2">{dimension.evidence.map((evidence, index) => <EvidenceItem evidence={evidence} key={`${evidence.ruleId}-${evidence.field}-${index}`} />)}</ul> : null}</div>)}</div>
              {detail.score.unattributedEvidence?.length ? <div className="mt-3 rounded-xl border border-line/70 p-3"><h4 className="text-sm font-semibold text-ink">Unattributed evidence</h4><ul className="mt-2 space-y-2">{detail.score.unattributedEvidence.map((evidence, index) => <EvidenceItem evidence={evidence} key={`${evidence.ruleId}-${index}`} />)}</ul></div> : null}{detail.score.gates?.length ? <p className="mt-3 text-sm text-red-800">Gates: {detail.score.gates.map((gate) => gate.reason || gate.ruleId).join(' · ')}</p> : null}{detail.score.appliedCaps?.length ? <p className="mt-2 text-sm text-amber-800">Caps: {detail.score.appliedCaps.map((cap) => cap.reason || cap.ruleId || cap).join(' · ')}</p> : null}
            </Section>

            <Section title="Sources">
              {safeUrls.length ? <div className="flex flex-wrap gap-2">{safeUrls.map((url, index) => <a className={primaryButton} href={url} key={url} rel="noopener noreferrer" target="_blank">View Original Listing{safeUrls.length > 1 ? ` ${index + 1}` : ''}<ExternalLink className="h-4 w-4" /></a>)}</div> : null}
              <div className={safeUrls.length ? 'mt-4 space-y-3' : 'space-y-3'}>{detail.sourceObservations?.map((source) => <div className="rounded-xl border border-line/70 p-3" key={`${source.sourceId}-${source.sourceRecordId}`}><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold text-ink">{source.sourceName || source.sourceId}</h4>{source.sourceRecordId ? <span className="text-xs text-ink/48">{source.sourceRecordId}</span> : null}{source.observedAt ? <span className="text-xs text-ink/48">Observed {formatDate(source.observedAt)}</span> : null}</div><dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{Object.entries(source.values || {}).filter(([, value]) => hasValue(value)).map(([field, value]) => <div className="flex gap-2" key={field}><dt className="font-semibold text-ink/55">{formatLabel(field)}</dt><dd className="break-all text-ink/72">{String(value)}</dd></div>)}</dl>{source.conflicts?.map((conflict) => <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" key={conflict.field}><h5 className="font-semibold">Conflict: {formatLabel(conflict.field)}</h5>{conflict.observations?.map((observation, index) => <p className="mt-1" key={`${conflictKey(observation)}-${index}`}>{observation.sourceName || observation.sourceId} reported {observation.value}</p>)}</div>)}</div>)}</div>
            </Section>

            <Section title="CRM/CIM">
              {detail.crmSummary?.submission ? <div className="rounded-xl bg-fog/70 p-3"><h4 className="text-sm font-semibold text-ink">CRM record</h4><p className="mt-2 text-sm text-ink/68">{detail.crmSummary.submission.company} · {formatLabel(detail.crmSummary.submission.status)}{detail.crmSummary.submission.updatedAt ? ` · ${formatDate(detail.crmSummary.submission.updatedAt)}` : ''}</p>{[['Seller', detail.crmSummary.submission.sellerName, detail.crmSummary.submission.sellerEmail], ['Broker', detail.crmSummary.submission.brokerName, detail.crmSummary.submission.brokerEmail]].map(([label, person, email]) => person || email ? <p className="mt-1 text-sm text-ink/68" key={label}>{label}: {[person, email].filter(Boolean).join(' · ')}</p> : null)}</div> : null}
              {detail.crmSummary?.factObservations?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">CRM facts</h4>{detail.crmSummary.factObservations.map((fact) => <p className="mt-2 rounded-lg bg-fog/60 p-3 text-sm text-ink/68" key={fact.field}>CRM fact · {formatLabel(fact.field)} · {String(fact.value)}</p>)}</div> : null}{detail.crmSummary?.conflicts?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">CRM conflicts</h4>{detail.crmSummary.conflicts.map((conflict) => <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" key={conflict.field}>CRM conflict · {formatLabel(conflict.field)} · {conflict.crmValue} · {formatLabel(conflict.winningProvenance)} wins</p>)}</div> : null}
              {detail.cimSummary?.requests?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">CIM history</h4>{detail.cimSummary.requests.map((request) => <p className="mt-2 rounded-lg bg-fog/60 p-3 text-sm text-ink/68" key={request.id}>{formatLabel(request.status)}{request.updatedAt ? ` · ${formatDate(request.updatedAt)}` : ''}</p>)}</div> : null}<CommunicationList communications={detail.crmSummary?.communications} title="CRM communications" /><CommunicationList communications={detail.cimSummary?.communications} title="CIM communications" />
            </Section>

            <Section title="Notes & History">
              {detail.history?.operatorState ? <div className="rounded-xl bg-fog/70 p-3"><h4 className="text-sm font-semibold text-ink">Operator state</h4><p className="mt-2 text-sm text-ink/68">Priority: {formatLabel(detail.history.operatorState.priority || 'normal')}</p>{detail.history.operatorState.note ? <p className="mt-1 text-sm text-ink/68">Note: {detail.history.operatorState.note}</p> : null}<p className="mt-1 text-sm text-ink/68">Review state · {detail.history.operatorState.reviewed ? `Reviewed${detail.history.operatorState.reviewedBy ? ` by ${detail.history.operatorState.reviewedBy}` : ''}${detail.history.operatorState.reviewedAt ? ` on ${formatDate(detail.history.operatorState.reviewedAt)}` : ''}` : 'Needs Review'}</p></div> : null}
              {detail.history?.operatorFacts?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">Operator fact audit</h4>{detail.history.operatorFacts.map((fact) => <div className="mt-2 rounded-lg border border-line/70 p-3 text-sm text-ink/68" key={fact.id}><p>Operator fact · {formatLabel(fact.field)} · {fact.value} · {fact.verified ? 'Verified' : 'Unverified'}</p>{fact.actor || fact.updatedAt || fact.note ? <p className="mt-1 text-xs text-ink/55">{[fact.actor, formatDate(fact.updatedAt), fact.note].filter(Boolean).join(' · ')}</p> : null}</div>)}</div> : null}
              {detail.history?.activities?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">Activity</h4><ul className="mt-2 space-y-2">{detail.history.activities.map((activity) => <li className="border-l-2 border-moss/25 pl-3 text-sm leading-6 text-ink/68" key={activity.id}><p className="text-xs font-semibold uppercase tracking-wide text-ink/48">Event: {formatLabel(activity.eventType)}</p><strong>{activity.summary}</strong>{activity.actor ? ` · ${activity.actor}` : ''}{activity.createdAt ? ` · ${formatDate(activity.createdAt)}` : ''}</li>)}</ul></div> : null}
              {detail.history?.dispositions?.length ? <div className="mt-4"><h4 className="text-sm font-semibold text-ink">Disposition history</h4><ul className="mt-2 space-y-2">{detail.history.dispositions.map((item) => <li className="border-l-2 border-red-200 pl-3 text-sm leading-6 text-ink/68" key={item.id}>Passed: {formatLabel(item.reason)}{item.note ? ` · ${item.note}` : ''}{item.dismissedBy ? ` · ${item.dismissedBy}` : ''}{item.dismissedAt ? ` · ${formatDate(item.dismissedAt)}` : ''}</li>)}</ul></div> : null}
            </Section>
          </> : null}
          {readOnly ? <p className="text-sm font-semibold text-ink/62">Read-only access: decisions and verified-fact edits are unavailable.</p> : null}
        </div>
      </section>
    </div>
  );
}
