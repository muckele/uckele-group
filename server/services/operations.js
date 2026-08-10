import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getSourceHealth } from './acquisitionCommandCenter.js';
import { getBackupStatus } from './backups.js';
import { getEmailReadiness } from './emailReadiness.js';
import { getCimAutomationStatus } from './cimAutomation.js';
import { getCommunicationOperationsStatus } from './communications.js';

function safeError(error) {
  return error?.message || 'Status check failed.';
}

async function getDiskStatus(config) {
  const target = path.dirname(config.storage.sqlitePath);
  try {
    await fs.mkdir(target, { recursive: true });
    const stats = await fs.statfs(target);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      ok: true,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

async function getDatabaseStatus(storage, config) {
  try {
    const status = storage.getDatabaseStatus
      ? await storage.getDatabaseStatus()
      : { provider: config.storage.provider, ...(await storage.checkHealth()) };
    let fileBytes = null;
    if (config.storage.provider === 'sqlite') {
      fileBytes = Number((await fs.stat(config.storage.sqlitePath)).size);
    }
    return { ok: true, ...status, fileBytes };
  } catch (error) {
    return { ok: false, provider: config.storage.provider, error: safeError(error) };
  }
}

function sanitizeCleanupJob(job) {
  return {
    id: job.id,
    submissionId: job.submission_id,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
    status: job.status,
    attemptCount: Number(job.attempt_count || 0),
    fileCount: Array.isArray(job.files) ? job.files.length : 0,
    lastError: job.last_error || '',
  };
}

function sanitizeCommunicationOperations(status = {}) {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  return {
    pending: count(status.pending),
    failed: count(status.failed),
    unassigned: count(status.unassigned),
  };
}

function settledPanel(result, fallback, error) {
  return result.status === 'fulfilled'
    ? { value: result.value, error: '' }
    : { value: fallback, error };
}

export async function getOperationsCenter({ storage = getStorage(), config = getConfig(), checks = {} } = {}) {
  const sourceHealthCheck = checks.sourceHealth || getSourceHealth;
  const diskStatusCheck = checks.disk || getDiskStatus;
  const databaseStatusCheck = checks.database || getDatabaseStatus;
  const backupStatusCheck = checks.backup || getBackupStatus;
  const emailReadinessCheck = checks.emailReadiness || getEmailReadiness;
  const cimAutomationCheck = checks.cimAutomation || getCimAutomationStatus;
  const communicationOperationsCheck = checks.communications || getCommunicationOperationsStatus;
  const tasks = [
    () => storage.listScheduledJobs?.({ limit: 50 }) || [],
    () => storage.listAdminAuditEvents?.({ limit: 100 }) || [],
    () => storage.listSecureDocumentCleanupJobs?.({ limit: 100 }) || storage.listPendingSecureDocumentCleanupJobs?.(100) || [],
    () => storage.listSourceHealthSnapshots?.({ limit: 30 }) || [],
    () => sourceHealthCheck(storage, { persistSnapshot: false, refresh: false }),
    () => diskStatusCheck(config),
    () => databaseStatusCheck(storage, config),
    () => backupStatusCheck(config),
    () => emailReadinessCheck({ storage, config }),
    () => cimAutomationCheck({ storage, config }),
    () => communicationOperationsCheck({ storage }),
  ];
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const scheduledPanel = settledPanel(results[0], [], 'Scheduler history is temporarily unavailable.');
  const auditPanel = settledPanel(results[1], [], 'Audit history is temporarily unavailable.');
  const cleanupPanel = settledPanel(results[2], [], 'Secure-document cleanup history is temporarily unavailable.');
  const sourceHistoryPanel = settledPanel(results[3], [], 'Source-health history is temporarily unavailable.');
  const sourceHealthPanel = settledPanel(results[4], {
    generatedAt: new Date().toISOString(), healthy: false, issues: [], sources: [], totals: {},
  }, 'Current source health is temporarily unavailable.');
  const diskPanel = settledPanel(results[5], { ok: false, error: 'Disk status is temporarily unavailable.' }, 'Disk status is temporarily unavailable.');
  const databasePanel = settledPanel(results[6], {
    ok: false, provider: config.storage.provider, error: 'Database status is temporarily unavailable.',
  }, 'Database status is temporarily unavailable.');
  const backupPanel = settledPanel(results[7], {
    status: 'error', message: 'Backup status is temporarily unavailable.', latest: null,
  }, 'Backup status is temporarily unavailable.');
  const emailPanel = settledPanel(results[8], {
    provider: config.delivery?.provider || 'unknown',
    outboundConfigured: false,
    webhookConfigured: false,
    webhookVerified: false,
    deliveryTrackingConfigured: false,
    deliveryTrackingVerified: false,
    replyTrackingConfigured: false,
    replyTrackingVerified: false,
    genericFollowUpsEnabled: Boolean(config.followUp?.emailEnabled),
    genericFollowUpsSafe: false,
    suppressionOperational: false,
    physicalPostalAddressConfigured: false,
    optOutConfigured: false,
    aiEnabled: Boolean(config.followUp?.aiEnabled),
    aiReady: false,
    metricsAvailable: false,
    metrics: {},
    followUpsEnabled: Boolean(config.dealHunter?.cimFollowUp?.enabled),
    followUpsSafe: false,
    issues: ['Email readiness is temporarily unavailable.'],
  }, 'Email readiness is temporarily unavailable.');
  const cimAutomationPanel = settledPanel(results[9], {
    configuredStage: 1, effectiveStage: 1, paused: true, stage2Ready: false, stage3Ready: false, metrics: {}, policy: {},
  }, 'CIM automation status is temporarily unavailable.');
  const communicationsPanel = settledPanel(results[10], {
    pending: 0, failed: 0, unassigned: 0,
  }, 'Communication ingestion status is temporarily unavailable.');

  const scheduledJobs = Array.isArray(scheduledPanel.value) ? scheduledPanel.value : [];
  const auditEvents = Array.isArray(auditPanel.value) ? auditPanel.value : [];
  const cleanupJobs = Array.isArray(cleanupPanel.value) ? cleanupPanel.value : [];
  const sourceHistory = Array.isArray(sourceHistoryPanel.value) ? sourceHistoryPanel.value : [];

  const cleanup = cleanupJobs.map(sanitizeCleanupJob);
  const communicationCounts = sanitizeCommunicationOperations(communicationsPanel.value);
  return {
    generatedAt: new Date().toISOString(),
    scheduler: {
      runs: scheduledJobs,
      failures: scheduledJobs.filter((job) => job.status === 'failed').length,
      pending: scheduledJobs.filter((job) => job.status === 'pending').length,
      error: scheduledPanel.error,
    },
    sources: {
      current: sourceHealthPanel.value,
      history: sourceHistory,
      currentError: sourceHealthPanel.error,
      historyError: sourceHistoryPanel.error,
    },
    audit: { events: auditEvents, error: auditPanel.error },
    cleanup: {
      jobs: cleanup,
      failures: cleanup.filter((job) => !['completed', 'restored'].includes(job.status)),
      error: cleanupPanel.error,
    },
    storage: {
      disk: diskPanel.value,
      database: databasePanel.value,
      diskError: diskPanel.error,
      databaseError: databasePanel.error,
    },
    backup: { ...backupPanel.value, error: backupPanel.error },
    email: { ...emailPanel.value, error: emailPanel.error },
    cimAutomation: { ...cimAutomationPanel.value, error: cimAutomationPanel.error },
    communications: { ...communicationCounts, error: communicationsPanel.error },
  };
}
