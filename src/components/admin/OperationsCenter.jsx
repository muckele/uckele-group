import React, { useState } from 'react';
import EmailReadinessPanel from './EmailReadinessPanel';

function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not recorded'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Managed remotely';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function StatusBadge({ children, healthy = false, warning = false }) {
  const tone = healthy
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : warning
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-red-200 bg-red-50 text-red-800';
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${tone}`}>{children}</span>;
}

function PanelError({ children }) {
  return children ? <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900" role="status">{children}</p> : null;
}

function shortHash(value) {
  return value ? `${String(value).slice(0, 12)}…` : 'Not recorded';
}

function formatGateValue(value) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function OperationsCenter({
  data, loading = false, error = '', onSendEmailTest, emailTestSending = false,
  onToggleCimAutomation, cimAutomationUpdating = false, onToggleCimOutreach,
  cimOutreachUpdating = false, onRunCimStage2, onActivateCimStage2,
  cimStage2Updating = false, readOnly = false,
}) {
  const [decisionAudit, setDecisionAudit] = useState(null);
  const [decisionAuditLoading, setDecisionAuditLoading] = useState(false);
  const [decisionAuditError, setDecisionAuditError] = useState('');
  if (loading && !data) return <div className="space-y-4"><div className="panel p-7 text-sm text-ink/65" data-admin-tour="operations-readiness" role="status">Loading operations readiness…</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-history">Operations history will appear when the readiness check completes.</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-storage">Storage and recovery status will appear when the readiness check completes.</div></div>;
  if (error && !data) return <div className="space-y-4"><div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700" data-admin-tour="operations-readiness" role="alert">{error}</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-history">Operations history is temporarily unavailable.</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-storage">Storage and recovery status is temporarily unavailable.</div></div>;
  if (!data) return <div className="space-y-4"><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-readiness">No operations readiness data is available.</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-history">No operations history is available.</div><div className="panel p-5 text-sm text-ink/55" data-admin-tour="operations-storage">No storage status is available.</div></div>;

  const jobs = data.scheduler?.runs || [];
  const auditEvents = data.audit?.events || [];
  const sourceHistory = data.sources?.history || [];
  const cleanupFailures = data.cleanup?.failures || [];
  const disk = data.storage?.disk || {};
  const database = data.storage?.database || {};
  const sourceHealth = data.sources?.current || {};
  const backupStatus = data.backup?.status || 'unknown';
  const schedulerFailures = Number(data.scheduler?.failures || 0);
  const schedulerPending = Number(data.scheduler?.pending || 0);
  const schedulerUnavailable = Boolean(data.scheduler?.error);
  const cimAutomation = data.cimAutomation || {};
  const cimIdentity = data.cimIdentity || {};
  const outreachPaused = Boolean(cimIdentity.pause?.paused);
  const cimMetrics = cimAutomation.metrics || {};
  const communications = data.communications || {};
  const communicationPending = Math.max(0, Number(communications.pending || 0));
  const communicationFailed = Math.max(0, Number(communications.failed || 0));
  const communicationUnassigned = Math.max(0, Number(communications.unassigned || 0));
  const communicationAttention = communicationPending + communicationFailed + communicationUnassigned;
  const stage2Gates = cimAutomation.stage2Readiness || [];
  const shadowRun = cimAutomation.latestShadowRun || null;
  const liveRun = cimAutomation.latestLiveRun || null;

  async function loadDecisionAudit(run, page = 1) {
    if (readOnly || !run?.id) return;
    setDecisionAuditLoading(true);
    setDecisionAuditError('');
    try {
      const response = await fetch(`/api/admin/deal-hunter/cim-stage2/runs/${encodeURIComponent(run.id)}/decisions?page=${page}&pageSize=100`, {
        credentials: 'same-origin',
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load Stage 2 decision evidence.');
      setDecisionAudit({ ...result, run });
    } catch (loadError) {
      setDecisionAuditError(loadError.message || 'Unable to load Stage 2 decision evidence.');
    } finally {
      setDecisionAuditLoading(false);
    }
  }

  function runCanary() {
    const confirmation = window.prompt('Stage 2 canary sends one real broker email without per-opportunity approval. Enter exactly: RUN CIM STAGE 2 CANARY');
    if (confirmation !== null) onRunCimStage2?.({ mode: 'canary', confirmation });
  }

  function activate(mode) {
    const phrases = {
      off: 'SET CIM STAGE 2 OFF',
      shadow: 'ACTIVATE CIM STAGE 2 SHADOW',
      canary: 'ACTIVATE CIM STAGE 2 CANARY',
    };
    const confirmation = window.prompt(`${mode === 'canary' ? 'Canary activation permits one automatic broker email per Pacific business day without per-opportunity approval. ' : ''}Enter exactly: ${phrases[mode]}`);
    if (confirmation === null) return;
    const reason = window.prompt('Record a substantive release reason (at least 20 characters):');
    if (reason === null) return;
    const payload = {
      mode,
      confirmation,
      reason,
      evidenceChecksum: cimAutomation.evidenceChecksum,
      evidenceGeneratedAt: cimAutomation.evidenceGeneratedAt,
    };
    if (mode === 'canary') {
      payload.backupReference = window.prompt('Fresh verified backup reference:') || '';
      payload.backupChecksum = window.prompt('Backup SHA-256 checksum:') || '';
      payload.identityAuditReference = window.prompt('Dry-run identity-audit reference:') || '';
      payload.identityAuditChecksum = window.prompt('Identity-audit SHA-256 checksum:') || '';
      payload.complianceReference = window.prompt('Compliance/copy acceptance reference:') || '';
      payload.senderAuthReference = window.prompt('SPF/DKIM and DMARC acceptance reference:') || '';
    }
    onActivateCimStage2?.(payload);
  }

  return (
    <div className="space-y-6" data-admin-tour="operations-readiness">
      {error ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">{error}</div> : null}
      <nav className="panel p-3 sm:p-4" aria-label="Operations sections">
        <p className="px-2 text-xs font-semibold uppercase tracking-[0.12em] text-moss/70">Jump to</p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {[
            ...(data.email ? [['#email-readiness-heading', 'Email']] : []),
            ['#cim-automation-heading', 'Automation'],
            ['#communication-ingestion-heading', 'Communications'],
            ['#core-systems-heading', 'Core systems'],
            ['#scheduler-history-heading', 'Jobs'],
            ['#source-history-heading', 'Sources'],
            ['#cleanup-heading', 'Cleanup'],
            ['#audit-heading', 'Audit'],
          ].map(([href, label]) => (
            <a className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-line bg-white px-3 text-xs font-semibold text-ink/72 transition hover:border-moss/30 hover:text-moss" href={href} key={href}>
              {label}
            </a>
          ))}
        </div>
      </nav>
      <EmailReadinessPanel data={data.email} onSendTest={readOnly ? undefined : onSendEmailTest} testSending={emailTestSending} />
      <section className="panel p-5 sm:p-7" aria-labelledby="cim-automation-heading">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">CIM outreach</p><h3 className="mt-2 text-xl font-semibold text-ink" id="cim-automation-heading">Guarded Stage 2 rollout</h3><p className="mt-2 text-sm text-ink/65">Configured Stage {cimAutomation.configuredStage || 1} · evidence Stage {cimAutomation.evidenceStage || 1} · effective Stage {cimAutomation.effectiveStage || 1} · activation {cimAutomation.activationMode || 'off'}</p><p className="mt-1 text-sm font-semibold text-ink">Automatic transmission: {cimAutomation.automaticTransmissionAllowed ? 'ALLOWED under the current durable activation' : 'BLOCKED'}</p></div>
          {!readOnly ? <div className="flex flex-wrap gap-2">
            <button className={`rounded-full border px-4 py-2.5 text-sm font-semibold ${outreachPaused ? 'border-moss bg-moss text-white' : 'border-red-200 bg-red-50 text-red-800'}`} disabled={cimOutreachUpdating} onClick={() => onToggleCimOutreach?.(!outreachPaused)} type="button">{cimOutreachUpdating ? 'Updating…' : outreachPaused ? 'Resume all CIM outreach' : 'Pause all CIM outreach'}</button>
            <button className={`rounded-full border px-4 py-2.5 text-sm font-semibold ${cimAutomation.paused ? 'border-moss bg-moss text-white' : 'border-line bg-white text-ink'}`} disabled={cimAutomationUpdating} onClick={() => onToggleCimAutomation?.(!cimAutomation.paused)} type="button">{cimAutomationUpdating ? 'Updating…' : cimAutomation.paused ? 'Resume automation only' : 'Pause automation only'}</button>
          </div> : <p className="rounded-xl border border-line bg-fog px-3 py-2 text-xs text-ink/60">Aggregate read-only view. Activation, run, pause, and decision-detail controls require a full administrator.</p>}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[['Canonical opportunities', cimIdentity.canonicalOpportunities ?? 0], ['Identity exceptions', cimIdentity.unresolvedIdentityExceptions ?? 0], ['Duplicate active sequences', cimIdentity.duplicateActiveSequences ?? 0], ['Linkage mismatches', cimIdentity.linkageMismatches ?? 'Link check unavailable'], ['Recipients currently at cap', cimIdentity.recipientsAtCap ?? 'Cap status unavailable'], ['Recipient-cap deferrals', cimIdentity.recipientCapDeferrals ?? 'Not tracked'], ['Out-of-window deferrals', cimIdentity.outOfWindowDeferrals ?? 'Not tracked'], ['Logical email messages', cimIdentity.logicalMessages ?? 'Logical count unavailable'], ['Raw lifecycle events', cimIdentity.rawLifecycleEvents ?? 'Raw count unavailable']].map(([metric, value]) => <div className="rounded-2xl border border-line bg-fog/60 p-4" key={metric}><p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/55">{metric}</p><p className="mt-2 text-xl font-semibold text-ink">{value}</p></div>)}
        </div>
        <p className="mt-3 text-sm text-ink/65">Canonical identity storage: {cimIdentity.storageHealthy ? 'healthy' : 'unavailable'} · all-outreach pause: {outreachPaused ? `active (${cimIdentity.pause?.source || 'unknown source'})` : 'clear'}.</p>
        <p className="mt-2 text-sm text-ink/65">Recipient policy: {cimIdentity.recipientPolicy?.cap24Hours ?? 'Not configured'} touch(es) / 24 hours · {cimIdentity.recipientPolicy?.cap30Days ?? 'Not configured'} touch(es) / 30 days. Follow-up window: {cimIdentity.followUpWindow?.start || '—'}–{cimIdentity.followUpWindow?.end || '—'} {cimIdentity.followUpWindow?.timezone || ''}{cimIdentity.followUpWindow?.weekdaysOnly ? ' · weekdays only' : ''}.</p>
        <p className="mt-2 text-xs text-ink/55">Latest read-only identity summary: {cimIdentity.lastAudit?.generatedAt ? formatDate(cimIdentity.lastAudit.generatedAt) : 'Unavailable'} · last applied repair: {cimIdentity.lastRepair?.createdAt ? `${formatDate(cimIdentity.lastRepair.createdAt)} · ${cimIdentity.lastRepair.status}` : 'Not recorded'}.</p>
        <PanelError>{cimIdentity.error}</PanelError>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {[['Canonical human reviews', cimMetrics.canonicalHumanReviews || 0], ['Still required', cimMetrics.remainingStage2Reviews ?? 'Unavailable'], ['Compatible evidence', cimMetrics.compatibleEvidence || 0], ['Legacy unversioned evidence', cimMetrics.legacyUnversionedEvidence || 0], ['Incompatible evidence', (cimMetrics.incompatibleEvidence || 0) + (cimMetrics.unlinkedEvidence || 0) + (cimMetrics.ambiguousEvidence || 0)], ['Eligible cohort', cimMetrics.stage2EligibleCohort || 0], ['Unchanged approval', `${cimMetrics.stage2UnchangedApprovalRate || 0}%`], ['Logical initials', cimMetrics.logicalInitialMessages || 0], ['Raw lifecycle events', cimMetrics.rawLifecycleEvents || 0], ['Delivered', cimMetrics.delivered || 0], ['Replies', cimMetrics.replies || 0], ['Complaints', cimMetrics.complained || 0], ['Bounces / failures', (cimMetrics.bounced || 0) + (cimMetrics.failed || 0)], ['Opt-outs', cimMetrics.explicitOptOuts || 0], ['Active suppressions', cimMetrics.activeSuppressions || 0], ['Ambiguous provider outcomes', cimAutomation.unresolvedAmbiguousDecisions || 0]].map(([metric, value]) => <div className="rounded-2xl border border-line bg-fog/60 p-4" key={metric}><p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/55">{metric}</p><p className="mt-2 text-xl font-semibold text-ink">{value}</p></div>)}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-white p-4"><p className="text-sm font-semibold text-ink">Bound policy and activation</p><p className="mt-2 break-all text-xs leading-5 text-ink/60">Rule {cimAutomation.policy?.rules?.version || cimAutomation.policy?.ruleVersion || 'Not recorded'} · policy {shortHash(cimAutomation.policy?.policyHash)} · source {shortHash(cimAutomation.policy?.sourcePolicyHash)} · evidence {shortHash(cimAutomation.evidenceChecksum)}</p><p className="mt-2 text-xs leading-5 text-ink/60">Actor {cimAutomation.activation?.actor || (readOnly ? 'Protected' : 'Not recorded')} · accepted {formatDate(cimAutomation.activation?.createdAt)} · expires {formatDate(cimAutomation.activation?.expiresAt)}</p></div>
          <div className="rounded-2xl border border-line bg-white p-4"><p className="text-sm font-semibold text-ink">Pacific operating boundary</p><p className="mt-2 text-xs leading-5 text-ink/60">{cimAutomation.operatingWindow?.open ? 'Open now' : `Closed: ${cimAutomation.operatingWindow?.reason || 'unknown'}`} · {cimAutomation.policy?.window?.start || '08:00'}–{cimAutomation.policy?.window?.end || '17:00'} {cimAutomation.policy?.window?.timezone || 'America/Los_Angeles'} · weekdays only</p><p className="mt-2 text-xs text-ink/60">Capacity {cimAutomation.capacity?.used ?? '—'} / {cimAutomation.capacity?.limit ?? '—'} used · {cimAutomation.capacity?.remaining ?? '—'} remaining · {cimAutomation.capacity?.pacificBusinessDate || 'no date'}</p></div>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-fog/60 p-4"><p className="text-sm font-semibold text-ink">Latest shadow run</p><p className="mt-2 text-xs leading-5 text-ink/65">{shadowRun ? `${shadowRun.status} · considered ${shadowRun.considered_count || 0} · eligible ${shadowRun.eligible_count || 0} · would send ${shadowRun.would_send_count || 0}` : 'No policy-matching shadow run recorded.'}</p>{shadowRun?.blocked_counts && Object.keys(shadowRun.blocked_counts).length ? <p className="mt-2 text-xs text-ink/60">Blocked: {Object.entries(shadowRun.blocked_counts).map(([code, count]) => `${code} ${count}`).join(' · ')}</p> : null}</div>
          <div className="rounded-2xl border border-line bg-fog/60 p-4"><p className="text-sm font-semibold text-ink">Latest live run</p><p className="mt-2 text-xs leading-5 text-ink/65">{liveRun ? `${liveRun.mode} · ${liveRun.status} · attempted ${liveRun.attempted_count || 0} · accepted ${liveRun.accepted_count || 0} · failed ${liveRun.failed_count || 0} · ambiguous ${liveRun.ambiguous_count || 0} · deferred ${liveRun.deferred_count || 0}` : 'No canary or active run recorded.'}</p></div>
        </div>
        {!readOnly ? <div className="mt-4 rounded-2xl border border-line bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-ink">Protected per-candidate decision evidence</p><p className="mt-1 text-xs text-ink/60">Full administrators only. Recipient references remain SHA-256 hashes.</p></div><div className="flex flex-wrap gap-2">{shadowRun ? <button className="rounded-full border border-line bg-white px-3 py-2 text-xs font-semibold" disabled={decisionAuditLoading} onClick={() => loadDecisionAudit(shadowRun)} type="button">Inspect shadow decisions</button> : null}{liveRun ? <button className="rounded-full border border-line bg-white px-3 py-2 text-xs font-semibold" disabled={decisionAuditLoading} onClick={() => loadDecisionAudit(liveRun)} type="button">Inspect live decisions</button> : null}</div></div>{decisionAuditError ? <p className="mt-3 text-xs text-red-700" role="alert">{decisionAuditError}</p> : null}{decisionAudit ? <div className="mt-4"><p className="text-xs text-ink/60">{decisionAudit.run.mode} run · page {decisionAudit.page} · {decisionAudit.decisions.length} decision(s)</p><div className="mt-2 overflow-x-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b border-line"><th className="px-2 py-2">Opportunity</th><th className="px-2 py-2">State</th><th className="px-2 py-2">Recipient hash</th><th className="px-2 py-2">Reasons</th></tr></thead><tbody>{decisionAudit.decisions.map((decision) => <tr className="border-b border-line/60" key={decision.id}><td className="max-w-48 break-all px-2 py-2">{decision.opportunity_id}</td><td className="px-2 py-2">{decision.decision_state}</td><td className="max-w-48 break-all px-2 py-2">{decision.recipient_hash}</td><td className="px-2 py-2">{(decision.reasons || []).join(', ') || 'eligible'}</td></tr>)}</tbody></table></div><div className="mt-3 flex gap-2"><button className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold" disabled={decisionAuditLoading || decisionAudit.page <= 1} onClick={() => loadDecisionAudit(decisionAudit.run, decisionAudit.page - 1)} type="button">Previous</button><button className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold" disabled={decisionAuditLoading || !decisionAudit.hasMore} onClick={() => loadDecisionAudit(decisionAudit.run, decisionAudit.page + 1)} type="button">Next</button></div></div> : null}</div> : null}
        <div className="mt-5"><h4 className="text-sm font-semibold text-ink">Every Stage 2 readiness gate</h4><div className="mt-3 grid gap-2 lg:grid-cols-2">{stage2Gates.map((gate) => <div className={`rounded-xl border p-3 text-xs leading-5 ${gate.passed ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`} key={gate.code}><strong>{gate.passed ? 'PASS' : 'BLOCK'} · {gate.code}</strong><p>{gate.passed ? 'Current evidence satisfies this gate.' : gate.reason}</p><p className="mt-1 break-words opacity-80">Observed: {formatGateValue(gate.observed)}</p><p className="break-words opacity-80">Required: {formatGateValue(gate.required)}</p><p className="opacity-70">Checked: {formatDate(gate.evidenceAt)}</p></div>)}</div></div>
        <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><strong>Safe next action:</strong> {cimAutomation.safeNextAction || 'Refresh readiness evidence.'}</p>
        {!readOnly ? <div className="mt-5 rounded-2xl border border-moss/20 bg-moss/5 p-4"><p className="text-sm font-semibold text-ink">Release-owner controls</p><p className="mt-2 text-xs leading-5 text-ink/65">Shadow performs zero provider work. Canary sends a real broker email without per-opportunity approval and is capped at one automatic initial per Pacific business day. Active mode and Stage 3 are intentionally unavailable here.</p><div className="mt-3 flex flex-wrap gap-2"><button className="rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink" disabled={cimStage2Updating} onClick={() => onRunCimStage2?.({ mode: 'shadow' })} type="button">Run zero-send shadow</button><button className="rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-950" disabled={cimStage2Updating || !cimAutomation.automaticTransmissionAllowed || cimAutomation.activationMode !== 'canary'} onClick={runCanary} type="button">Run one-email canary</button><button className="rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink" disabled={cimStage2Updating} onClick={() => activate('off')} type="button">Record off activation</button><button className="rounded-full border border-line bg-white px-4 py-2 text-sm font-semibold text-ink" disabled={cimStage2Updating} onClick={() => activate('shadow')} type="button">Record shadow activation</button><button className="rounded-full border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-900" disabled={cimStage2Updating || cimAutomation.evidenceStage < 2} onClick={() => activate('canary')} type="button">Accept canary activation…</button></div></div> : null}
        <PanelError>{cimAutomation.error}</PanelError>
      </section>
      <section aria-labelledby="core-systems-heading" data-admin-tour="operations-storage">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Infrastructure</p>
          <h3 className="mt-2 text-xl font-semibold text-ink" id="core-systems-heading">Core systems at a glance</h3>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <article className="panel p-5" aria-labelledby="communication-ingestion-heading">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Inbound communications</p>
          <h4 className="sr-only" id="communication-ingestion-heading">Communication ingestion status</h4>
          <div className="mt-3"><StatusBadge healthy={!communications.error && communicationAttention === 0} warning={!communications.error && communicationFailed === 0 && communicationAttention > 0}>{communications.error ? 'Check unavailable' : communicationAttention === 0 ? 'Healthy' : `${communicationAttention} need attention`}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink/68">{communicationPending} pending · {communicationFailed} failed · {communicationUnassigned} unassigned</p>
          <p className="mt-1 text-xs text-ink/50">Counts only; message content is never exposed in Operations.</p>
          <PanelError>{communications.error}</PanelError>
        </article>
        <article className="panel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Database</p>
          <div className="mt-3"><StatusBadge healthy={database.ok}>{database.ok ? 'Healthy' : 'Check failed'}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink/68">{database.provider || 'unknown'} · {formatBytes(database.fileBytes ?? database.databaseBytes)}</p>
          <p className="mt-1 text-xs text-ink/50">Integrity: {database.integrity || database.error || 'unavailable'}</p>
          <PanelError>{data.storage?.databaseError}</PanelError>
        </article>
        <article className="panel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Disk</p>
          <div className="mt-3"><StatusBadge healthy={disk.ok && disk.freePercent >= 20} warning={disk.ok && disk.freePercent < 20}>{disk.ok ? `${disk.freePercent}% free` : 'Check failed'}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink/68">{disk.ok ? `${formatBytes(disk.freeBytes)} available of ${formatBytes(disk.totalBytes)}` : disk.error}</p>
          <PanelError>{data.storage?.diskError}</PanelError>
        </article>
        <article className="panel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Deal sources</p>
          <div className="mt-3"><StatusBadge healthy={sourceHealth.healthy}>{sourceHealth.healthy ? 'Healthy' : `${sourceHealth.issues?.length || 0} issue(s)`}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink/68">Last checked {formatDate(sourceHealth.generatedAt)}</p>
          <PanelError>{data.sources?.currentError}</PanelError>
        </article>
        <article className="panel p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Backups</p>
          <div className="mt-3"><StatusBadge healthy={backupStatus === 'healthy'} warning={['disabled', 'missing', 'stale'].includes(backupStatus)}>{backupStatus}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink/68">{data.backup?.message || 'Backup status unavailable.'}</p>
          {data.backup?.latest?.createdAt ? <p className="mt-1 text-xs text-ink/50">Latest: {formatDate(data.backup.latest.createdAt)} · {data.backup.latest.documentCount} document(s)</p> : null}
          {data.backup?.bundleCounts ? <p className="mt-2 text-xs text-ink/55">Bundles: {data.backup.bundleCounts.valid || 0} valid · {data.backup.bundleCounts.invalid || 0} invalid · {data.backup.bundleCounts.incomplete || 0} incomplete</p> : null}
          <PanelError>{data.backup?.error}</PanelError>
        </article>
        </div>
      </section>

      <section className="panel p-5 sm:p-7" aria-labelledby="scheduler-history-heading" data-admin-tour="operations-history">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Scheduler</p><h3 className="mt-2 text-xl font-semibold text-ink" id="scheduler-history-heading">Job history</h3></div>
          <StatusBadge
            healthy={!schedulerUnavailable && schedulerFailures === 0 && schedulerPending === 0}
            warning={!schedulerUnavailable && schedulerFailures === 0 && schedulerPending > 0}
          >
            {schedulerUnavailable ? 'Unavailable' : `${schedulerFailures} failed · ${schedulerPending} pending`}
          </StatusBadge>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-ink/55"><tr><th className="px-3 py-3">Job</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Updated</th><th className="px-3 py-3">Attempts</th><th className="px-3 py-3">Error</th></tr></thead>
            <tbody>{jobs.slice(0, 20).map((job) => <tr className="border-b border-line/60" key={job.job_key}><td className="px-3 py-3 font-medium text-ink">{job.job_name}</td><td className="px-3 py-3">{job.status}</td><td className="px-3 py-3">{formatDate(job.updated_at)}</td><td className="px-3 py-3">{job.attempt_count}</td><td className="max-w-sm px-3 py-3 text-red-700">{job.last_error || '—'}</td></tr>)}</tbody>
          </table>
          {jobs.length === 0 ? <p className="py-5 text-sm text-ink/60">No scheduler runs have been recorded.</p> : null}
        </div>
        <PanelError>{data.scheduler?.error}</PanelError>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="panel p-5 sm:p-7" aria-labelledby="source-history-heading">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Source monitoring</p><h3 className="mt-2 text-xl font-semibold text-ink" id="source-history-heading">Source-health history</h3>
          <ol className="mt-5 space-y-3">{sourceHistory.slice(0, 12).map((item) => <li className="rounded-2xl border border-line/80 bg-fog/60 p-4" key={item.id}><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-ink">{item.healthy ? 'Healthy' : 'Issues detected'}</span><time className="text-xs text-ink/55">{formatDate(item.created_at)}</time></div><p className="mt-2 text-xs text-ink/60">{item.source_count} sources · {item.issue_count} issues</p></li>)}</ol>
          {sourceHistory.length === 0 ? <p className="mt-5 text-sm text-ink/60">History begins after the next persisted Deal Hunter source review.</p> : null}
          <PanelError>{data.sources?.historyError}</PanelError>
        </section>
        <section className="panel p-5 sm:p-7" aria-labelledby="cleanup-heading">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Secure cleanup</p><h3 className="mt-2 text-xl font-semibold text-ink" id="cleanup-heading">Cleanup failures</h3>
          <ol className="mt-5 space-y-3">{cleanupFailures.slice(0, 12).map((job) => <li className="rounded-2xl border border-red-100 bg-red-50/60 p-4" key={job.id}><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-red-800">{job.status}</span><time className="text-xs text-red-700/70">{formatDate(job.updatedAt)}</time></div><p className="mt-2 text-xs text-red-800/80">{job.fileCount} file(s) · {job.attemptCount} attempt(s)</p>{job.lastError ? <p className="mt-2 text-sm text-red-800">{job.lastError}</p> : null}</li>)}</ol>
          {cleanupFailures.length === 0 ? <p className="mt-5 text-sm text-ink/60">No unresolved secure-document cleanup failures.</p> : null}
          <PanelError>{data.cleanup?.error}</PanelError>
        </section>
      </div>

      <section className="panel p-5 sm:p-7" aria-labelledby="audit-heading">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Administration</p><h3 className="mt-2 text-xl font-semibold text-ink" id="audit-heading">Audit events</h3>
        <div className="mt-5 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="border-b border-line text-xs uppercase tracking-[0.12em] text-ink/55"><tr><th className="px-3 py-3">Time</th><th className="px-3 py-3">Actor</th><th className="px-3 py-3">Action</th><th className="px-3 py-3">Result</th></tr></thead><tbody>{auditEvents.slice(0, 50).map((event) => <tr className="border-b border-line/60" key={event.id}><td className="px-3 py-3">{formatDate(event.created_at)}</td><td className="px-3 py-3 font-medium text-ink">{event.actor} · {event.role}</td><td className="px-3 py-3">{event.method} {event.path}</td><td className="px-3 py-3">{event.status_code || event.metadata?.state}</td></tr>)}</tbody></table></div>
        <PanelError>{data.audit?.error}</PanelError>
      </section>
    </div>
  );
}
