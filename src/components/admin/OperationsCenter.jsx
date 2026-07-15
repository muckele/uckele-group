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

export default function OperationsCenter({ data, loading = false, error = '', onSendEmailTest, emailTestSending = false }) {
  if (loading && !data) return <div className="panel p-7 text-sm text-ink/65" role="status">Loading operations history…</div>;
  if (error && !data) return <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700" role="alert">{error}</div>;
  if (!data) return null;

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

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">{error}</div> : null}
      <EmailReadinessPanel data={data.email} onSendTest={onSendEmailTest} testSending={emailTestSending} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

      <section className="panel p-5 sm:p-7" aria-labelledby="scheduler-history-heading">
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
