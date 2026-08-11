import React from 'react';
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

export default function OperationsCenter({ data, loading = false, error = '', onSendEmailTest, emailTestSending = false, onToggleCimAutomation, cimAutomationUpdating = false }) {
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
  const cimMetrics = cimAutomation.metrics || {};
  const communications = data.communications || {};
  const communicationPending = Math.max(0, Number(communications.pending || 0));
  const communicationFailed = Math.max(0, Number(communications.failed || 0));
  const communicationUnassigned = Math.max(0, Number(communications.unassigned || 0));
  const communicationAttention = communicationPending + communicationFailed + communicationUnassigned;

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
      <EmailReadinessPanel data={data.email} onSendTest={onSendEmailTest} testSending={emailTestSending} />
      <section className="panel p-5 sm:p-7" aria-labelledby="cim-automation-heading">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">CIM outreach</p><h3 className="mt-2 text-xl font-semibold text-ink" id="cim-automation-heading">Automation stage and learning metrics</h3><p className="mt-2 text-sm text-ink/65">Configured Stage {cimAutomation.configuredStage || 1} · effective Stage {cimAutomation.effectiveStage || 1}</p></div>
          <button className={`rounded-full border px-4 py-2.5 text-sm font-semibold ${cimAutomation.paused ? 'border-moss bg-moss text-white' : 'border-red-200 bg-red-50 text-red-800'}`} disabled={cimAutomationUpdating} onClick={() => onToggleCimAutomation?.(!cimAutomation.paused)} type="button">{cimAutomationUpdating ? 'Updating…' : cimAutomation.paused ? 'Resume initial outreach' : 'Emergency pause'}</button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {[['Reviewed', cimMetrics.reviewed || 0], ['Approval rate', `${cimMetrics.approvalRate || 0}%`], ['Recipient edits', `${cimMetrics.recipientEditRate || 0}%`], ['Delivery rate', `${cimMetrics.deliveryRate || 0}%`], ['Bounce rate', `${cimMetrics.bounceRate || 0}%`], ['Reply rate', `${cimMetrics.replyRate || 0}%`], ['Positive replies', `${cimMetrics.positiveResponseRate || 0}%`], ['Duplicate rate', `${cimMetrics.duplicateListingRate || 0}%`], ['Recipient issue rate', `${cimMetrics.incorrectRecipientRate || 0}%`]].map(([metric, value]) => <div className="rounded-2xl border border-line bg-fog/60 p-4" key={metric}><p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink/55">{metric}</p><p className="mt-2 text-xl font-semibold text-ink">{value}</p></div>)}
        </div>
        <p className="mt-4 text-sm text-ink/65">Stage 2 readiness: {cimAutomation.stage2Ready ? 'ready' : `needs ${cimAutomation.policy?.stage2MinimumReviews || 25} reviewed requests`} · Stage 3 readiness: {cimAutomation.stage3Ready ? 'ready' : `${cimAutomation.policy?.stage3MinimumReviews || 50} reviews and ${Math.round((cimAutomation.policy?.stage3MinimumApprovalRate || 0.9) * 100)}% approval required`}.</p>
        {Object.keys(cimMetrics.passReasons || {}).length > 0 ? <p className="mt-3 text-sm text-ink/65"><strong>Pass reasons:</strong> {Object.entries(cimMetrics.passReasons).sort((left, right) => right[1] - left[1]).map(([reason, count]) => `${reason}: ${count}`).join(' · ')}</p> : null}
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
