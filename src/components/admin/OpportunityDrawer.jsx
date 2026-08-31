import React, { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

const factFields = [
  ['seller_name', 'Seller name'], ['seller_email', 'Seller email'], ['seller_phone', 'Seller phone'],
  ['broker_name', 'Broker name'], ['broker_company', 'Broker company'], ['broker_email', 'Broker email'], ['broker_phone', 'Broker phone'],
  ['reason_for_sale', 'Reason for sale'], ['real_estate_included', 'Real estate included'], ['seller_financing', 'Seller financing'],
  ['management_structure', 'Management structure'], ['customer_concentration', 'Customer concentration'], ['operator_contact_notes', 'Operator contact notes'],
];
const factLabels = Object.fromEntries(factFields);
const missingLabels = {
  annual_profit: 'SDE / profit', annual_revenue: 'Revenue', asking_price: 'Asking price', listing_url: 'Original listing URL',
  ...factLabels,
};
const sectionClass = 'rounded-2xl border border-line bg-white p-4 sm:p-5';
const secondaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:opacity-50';
const primaryButton = 'inline-flex min-h-10 items-center justify-center rounded-full border border-moss bg-moss px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine disabled:opacity-50';

function formatLabel(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
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

function Section({ children, title, ...props }) {
  return <section className={sectionClass} {...props}><h3 className="text-base font-semibold text-ink">{title}</h3><div className="mt-4">{children}</div></section>;
}

function Provenance({ fact }) {
  const labels = { operator: 'Operator verified', crm: 'CRM', 'structured-source': 'Structured source', 'enrichment-suggestion': 'Enrichment suggestion' };
  return <span className="rounded-full border border-line bg-fog px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink/58">{labels[fact?.provenance] || formatLabel(fact?.provenance || 'unknown')}</span>;
}

function Fact({ detail, field }) {
  const fact = detail.effectiveFacts?.[field];
  if (!fact?.value) return null;
  return <div className="rounded-xl border border-line/70 bg-fog/50 p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-ink/48">{factLabels[field]}</p><Provenance fact={fact} /></div><p className="mt-1.5 text-sm leading-6 text-ink">{fact.value}</p>{fact.note ? <p className="mt-1 text-xs text-ink/58">{fact.note}</p> : null}</div>;
}

function DetailActions({ name, onAction, pending }) {
  if (!onAction) return null;
  return <div className="flex flex-wrap gap-2"><button aria-label={`Pursue ${name}`} className={primaryButton} disabled={pending} onClick={() => onAction('pursue')} type="button">Pursue</button><button aria-label={`Watch ${name}`} className={secondaryButton} disabled={pending} onClick={() => onAction('watch')} type="button">Watch</button><button aria-label={`Pass ${name}`} className={`${secondaryButton} text-red-700`} disabled={pending} onClick={() => onAction('pass')} type="button">Pass</button></div>;
}

function MissingInformation({ fields }) {
  if (!fields?.length) return null;
  return <section aria-label="Missing Information" className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h4 className="text-sm font-semibold text-amber-950">Missing Information</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{fields.map((field) => <div className="flex items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-sm" key={field}><span className="font-medium text-ink">{missingLabels[field] || formatLabel(field)}</span><span className="text-amber-800">Not provided</span></div>)}</div></section>;
}

function VerifiedFactForm({ detail, onSaveFact, pending }) {
  const [draft, setDraft] = useState({ field: factFields[0][0], value: detail.effectiveFacts?.[factFields[0][0]]?.value || '', note: '' });
  function selectField(field) {
    const current = detail.effectiveFacts?.[field];
    setDraft({ field, value: current?.value || '', note: current?.note || '' });
  }
  function submit(event) {
    event.preventDefault();
    if (!draft.value.trim()) return;
    onSaveFact({ field: draft.field, value: draft.value.trim(), note: draft.note.trim(), verified: true });
  }
  return (
    <form className="rounded-xl border border-moss/20 bg-moss/5 p-4" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-ink">Add or edit a verified operator fact</h4>
      <p className="mt-1 text-xs leading-5 text-ink/58">Verified facts remain separate from machine scoring and outrank refreshed source observations.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-ink/62">Verified fact field<select aria-label="Verified fact field" className="form-control mt-1" onChange={(event) => selectField(event.target.value)} value={draft.field}>{factFields.map(([field, fieldLabel]) => <option key={field} value={field}>{fieldLabel}</option>)}</select></label>
        <label className="text-xs font-semibold text-ink/62">Verified fact value<input aria-label="Verified fact value" className="form-control mt-1" onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} value={draft.value} /></label>
      </div>
      <label className="mt-3 block text-xs font-semibold text-ink/62">Verification note<textarea aria-label="Verification note" className="form-control mt-1 min-h-20" onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} value={draft.note} /></label>
      <button className={`${primaryButton} mt-3`} disabled={pending || !draft.value.trim()} type="submit">Save verified fact</button>
    </form>
  );
}

export default function OpportunityDrawer({ detail, error = '', loading = false, onAction, onClose, onSaveFact, pending = false, readOnly = false }) {
  const opportunity = detail?.opportunity;
  const name = opportunity?.name || 'Opportunity detail';
  const safeUrls = [...new Set((detail?.listingUrls || []).map(safeListingUrl).filter(Boolean))];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" role="presentation">
      <section aria-label={name} aria-modal="true" className="h-full w-full overflow-y-auto border-l border-line bg-fog shadow-2xl sm:max-w-3xl" role="dialog">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-line bg-white/95 p-5 backdrop-blur">
          <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-moss">Opportunity View</p><h2 className="mt-1 truncate text-xl font-semibold text-ink">{name}</h2>{opportunity ? <p className="mt-1 text-xs text-ink/58">{opportunity.geography?.label || opportunity.state} · {opportunity.industry}</p> : null}</div>
          <button aria-label="Close opportunity detail" className="rounded-full border border-line bg-white p-2 text-ink/60 hover:text-ink" onClick={onClose} type="button"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-5 p-4 sm:p-5">
          {loading ? <p className="text-sm text-ink/62">Loading everything currently known…</p> : null}
          {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
          {detail ? (
            <>
              <Section title="Overview">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><div><p className="text-xs text-ink/48">Fit</p><p className="text-2xl font-semibold text-ink">{opportunity.fitScore}</p></div><div><p className="text-xs text-ink/48">Confidence</p><p className="text-sm font-semibold text-ink">{formatLabel(opportunity.confidence)}</p></div><div><p className="text-xs text-ink/48">Operator state</p><p className="text-sm font-semibold text-ink">{formatLabel(opportunity.operatorPriority)}</p></div><div><p className="text-xs text-ink/48">Machine state</p><p className="text-sm font-semibold text-ink">{formatLabel(opportunity.scoreStatus)}</p></div></div>
                <div className="mt-4"><DetailActions name={name} onAction={readOnly ? undefined : onAction} pending={pending} /></div>
                {opportunity.topStrength ? <p className="mt-4 rounded-xl bg-moss/8 p-3 text-sm leading-6 text-moss">{opportunity.topStrength}</p> : null}
                {opportunity.topConcern ? <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">{opportunity.topConcern}</p> : null}
                <div className="mt-4"><MissingInformation fields={detail.missingCriticalFields} /></div>
              </Section>

              <Section title="Business & Financials">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
                  ['SDE / profit', formatMoney(opportunity.financials?.annualProfit)], ['Revenue', formatMoney(opportunity.financials?.annualRevenue)],
                  ['Asking price', formatMoney(opportunity.financials?.askingPrice)], ['Profit multiple', opportunity.financials?.profitMultiple === null || opportunity.financials?.profitMultiple === undefined ? '' : `${opportunity.financials.profitMultiple}×`],
                ].filter(([, value]) => value).map(([itemLabel, value]) => <div className="rounded-xl bg-fog/70 p-3" key={itemLabel}><p className="text-xs text-ink/48">{itemLabel}</p><p className="mt-1 text-sm font-semibold text-ink">{value}</p></div>)}</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">{['management_structure', 'customer_concentration', 'reason_for_sale', 'real_estate_included', 'seller_financing'].map((field) => <Fact detail={detail} field={field} key={field} />)}</div>
              </Section>

              <Section title="Broker & Seller">
                <div className="grid gap-3 sm:grid-cols-2">{['broker_name', 'broker_company', 'broker_email', 'broker_phone', 'seller_name', 'seller_email', 'seller_phone', 'operator_contact_notes'].map((field) => <Fact detail={detail} field={field} key={field} />)}</div>
                {!readOnly && onSaveFact ? <div className="mt-4"><VerifiedFactForm detail={detail} onSaveFact={onSaveFact} pending={pending} /></div> : null}
              </Section>

              <Section title="Score & Evidence">
                {detail.score.confidenceReasons?.length ? <p className="rounded-xl bg-fog/70 p-3 text-sm text-ink/70">{detail.score.confidenceReasons.join(' ')}</p> : null}
                <div className="mt-3 space-y-3">{detail.score.dimensions?.map((dimension) => <div className="rounded-xl border border-line/70 p-3" key={dimension.id}><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold text-ink">{dimension.label}</h4><span className="text-sm font-semibold tabular-nums text-moss">{dimension.contribution > 0 ? '+' : ''}{dimension.contribution}</span></div>{dimension.evidence?.length ? <ul className="mt-2 space-y-2">{dimension.evidence.map((evidence, index) => <li className="text-xs leading-5 text-ink/68" key={`${evidence.ruleId}-${evidence.field}-${index}`}><strong>{evidence.ruleLabel || formatLabel(evidence.ruleId)}</strong>{evidence.value ? ` · ${evidence.field}: ${evidence.value}` : ''}{evidence.sourceName ? ` · ${evidence.sourceName}` : ''}</li>)}</ul> : <p className="mt-2 text-xs text-ink/55">No retained evidence in this dimension.</p>}</div>)}</div>
                {detail.score.gates?.length ? <p className="mt-3 text-sm text-red-800">Gates: {detail.score.gates.map((gate) => gate.reason || gate.ruleId).join(' · ')}</p> : null}
                {detail.score.appliedCaps?.length ? <p className="mt-2 text-sm text-amber-800">Caps: {detail.score.appliedCaps.map((cap) => cap.reason || cap.ruleId || cap).join(' · ')}</p> : null}
              </Section>

              <Section title="Sources">
                {safeUrls.length ? <div className="flex flex-wrap gap-2">{safeUrls.map((url, index) => <a className={primaryButton} href={url} key={url} rel="noopener noreferrer" target="_blank">View Original Listing{safeUrls.length > 1 ? ` ${index + 1}` : ''}<ExternalLink className="h-4 w-4" /></a>)}</div> : null}
                <div className="mt-4 space-y-3">{detail.sourceObservations?.map((source) => <div className="rounded-xl border border-line/70 p-3" key={`${source.sourceId}-${source.sourceRecordId}`}><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold text-ink">{source.sourceName || source.sourceId}</h4>{source.sourceRecordId ? <span className="text-xs text-ink/48">{source.sourceRecordId}</span> : null}{source.observedAt ? <span className="text-xs text-ink/48">Observed {formatDate(source.observedAt)}</span> : null}</div><dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{Object.entries(source.values || {}).map(([field, value]) => <div className="flex gap-2" key={field}><dt className="font-semibold text-ink/55">{formatLabel(field)}</dt><dd className="break-all text-ink/72">{String(value)}</dd></div>)}</dl>{source.conflicts?.flatMap((conflict) => conflict.observations || []).map((observation, index) => <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" key={`${conflictKey(observation)}-${index}`}>{observation.sourceName || observation.sourceId} reported {observation.value}</p>)}</div>)}</div>
              </Section>

              <Section title="CRM/CIM">
                <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-fog/70 p-3"><h4 className="text-sm font-semibold text-ink">CRM</h4>{detail.crmSummary?.submission ? <p className="mt-2 text-sm leading-6 text-ink/68">{detail.crmSummary.submission.company} · {formatLabel(detail.crmSummary.submission.status)}</p> : <p className="mt-2 text-sm text-ink/58">No linked CRM record.</p>}</div><div className="rounded-xl bg-fog/70 p-3"><h4 className="text-sm font-semibold text-ink">CIM history</h4>{detail.cimSummary?.requests?.length ? detail.cimSummary.requests.map((request) => <p className="mt-2 text-sm text-ink/68" key={request.id}>{formatLabel(request.status)}{request.updatedAt ? ` · ${formatDate(request.updatedAt)}` : ''}</p>) : <p className="mt-2 text-sm text-ink/58">No CIM request history.</p>}</div></div>
                {detail.crmSummary?.communications?.length ? <p className="mt-3 text-sm text-ink/62">{detail.crmSummary.communications.length} retained communication event{detail.crmSummary.communications.length === 1 ? '' : 's'}.</p> : null}
              </Section>

              <Section title="Notes & History">
                {opportunity.operatorNote ? <p className="rounded-xl bg-fog/70 p-3 text-sm leading-6 text-ink">{opportunity.operatorNote}</p> : null}
                <ul className="mt-3 space-y-2">{detail.history?.activities?.map((activity) => <li className="border-l-2 border-moss/25 pl-3 text-sm leading-6 text-ink/68" key={activity.id}><strong>{activity.summary}</strong>{activity.actor ? ` · ${activity.actor}` : ''}{activity.createdAt ? ` · ${formatDate(activity.createdAt)}` : ''}</li>)}{detail.history?.dispositions?.map((item) => <li className="border-l-2 border-red-200 pl-3 text-sm leading-6 text-ink/68" key={item.id}>Passed: {formatLabel(item.reason)}{item.note ? ` · ${item.note}` : ''}</li>)}</ul>
              </Section>
            </>
          ) : null}
          {readOnly ? <p className="text-sm font-semibold text-ink/62">Read-only access: decisions and verified-fact edits are unavailable.</p> : null}
        </div>
      </section>
    </div>
  );
}

function conflictKey(observation) {
  return `${observation.sourceId || observation.sourceName}-${observation.value}`;
}
