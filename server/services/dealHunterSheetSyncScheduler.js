// Weekday scheduler for the Sheet sync (spec 2026-11-02 MVP send readiness, section 5).
//
// This lives beside, not inside, dealHunterScheduler.js on purpose: the daily digest scheduler
// must never reach the automatic Pursue runner through its imports, and the sheet sync does.
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getZonedParts, parseScheduleTime } from './dealHunterScheduler.js';
import { runDealHunterSheetSync } from './dealHunterSheetSync.js';

const sheetSyncJobName = 'deal-hunter-sheet-sync';
const sheetSyncClaimStaleMs = 60 * 60 * 1000;

function boundedSheetSyncError(value) {
  const text = String(value?.message ?? value ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
}

function sheetSyncMetadata(result, { ok, error }) {
  return JSON.parse(JSON.stringify({
    ok,
    sheets: Array.isArray(result?.sheets) ? result.sheets : [],
    scoredCount: Number(result?.scoredCount) || 0,
    groupCounts: result?.groupCounts && typeof result.groupCounts === 'object' ? result.groupCounts : {},
    requiredSourcesHealthy: result?.requiredSourcesHealthy === true,
    autoPursue: result?.autoPursue ?? null,
    durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null,
    error: error || null,
  }));
}

/**
 * Weekday sync of the Google Sheets, then automatic Pursue (spec section 5).
 *
 * One `scheduled_job_runs` claim per business date. A run whose required sheets are unhealthy, or
 * which throws, is recorded failed and retried every `retryIntervalMs` while the local time is
 * before `retryUntil`. The attempt that completes with healthy sheets is the only one that runs
 * automatic Pursue, and a completed date never runs again, so Pursue runs at most once per date.
 * The retry wait is also held in the durable claim, so a restart cannot shorten it.
 */
export function startDealHunterSheetSyncScheduler({
  storage = null,
  config = null,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  run = runDealHunterSheetSync,
  logger = console,
  claimTokenFactory = randomUUID,
} = {}) {
  const schedule = (config || getConfig()).dealHunter?.sheetSync || {};

  if (!schedule.enabled) {
    logger.log('[deal-hunter:sheet-sync] scheduler disabled');
    return { async tick() {}, stop() {} };
  }

  const runAt = parseScheduleTime(schedule.runAt);
  const retryUntil = parseScheduleTime(schedule.retryUntil);
  if (!runAt || !retryUntil) {
    logger.error('[deal-hunter:sheet-sync] scheduler disabled: runAt and retryUntil must be HH:MM');
    return { async tick() {}, stop() {} };
  }
  const startMinutes = runAt.hour * 60 + runAt.minute;
  const endMinutes = retryUntil.hour * 60 + retryUntil.minute;
  const retryIntervalMs = Math.max(0, Number(schedule.retryIntervalMs) || 0);
  const checkIntervalMs = Math.max(1000, Number(schedule.checkIntervalMs) || 60_000);

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let lastAttemptDate = '';
  let lastAttemptAt = 0;
  const finishedDates = new Set();

  async function attempt(at, dateKey) {
    const jobKey = `${sheetSyncJobName}:${dateKey}`;
    const claimToken = claimTokenFactory();
    const activeStorage = storage || getStorage();
    const claim = await activeStorage.claimScheduledJob({
      jobKey,
      jobName: sheetSyncJobName,
      triggeredBy: 'scheduler',
      claimToken,
      nowIso: at.toISOString(),
      staleBefore: new Date(at.getTime() - sheetSyncClaimStaleMs).toISOString(),
      retryDueAt: at.toISOString(),
      metadata: { businessDate: dateKey, dateKey, timezone: schedule.timezone, trigger: 'scheduler' },
    });
    if (!(claim.applied ?? claim.claimed)) {
      if (claim.run?.status === 'completed') finishedDates.add(dateKey);
      // Nothing ran, so the wait is the durable claim's to enforce, not this process's.
      lastAttemptDate = '';
      return;
    }

    logger.log(`[deal-hunter:sheet-sync] syncing sheets for ${dateKey}`);
    let result = null;
    let error = '';
    try {
      result = await run({ storage: activeStorage, now: at, triggeredBy: 'scheduler' });
      if (!result?.ok) error = boundedSheetSyncError(result?.error) || 'Required sheets were not healthy.';
    } catch (cause) {
      error = boundedSheetSyncError(cause) || 'The sheet sync threw.';
    }
    const ok = !error;
    const finishedAt = now();
    const finishedIso = (finishedAt instanceof Date && Number.isFinite(finishedAt.getTime()) ? finishedAt : at).toISOString();
    const transition = await activeStorage.transitionScheduledJob({
      jobKey,
      claimToken,
      expectedStatuses: ['pending'],
      status: ok ? 'completed' : 'failed',
      nowIso: finishedIso,
      ...(ok ? { completedAt: finishedIso } : { lastError: error }),
      metadataPatch: sheetSyncMetadata(result, { ok, error }),
    });
    if (ok) {
      // Automatic Pursue already ran on this attempt, so the date is finished here whether or not
      // the completion write landed; a stale pending claim must not run it a second time in-process.
      finishedDates.add(dateKey);
      if (!(transition.applied ?? transition.claimed)) {
        logger.error(`[deal-hunter:sheet-sync] completion not recorded date=${dateKey} reason=${transition.reason || 'unknown'}`);
      } else {
        logger.log(`[deal-hunter:sheet-sync] completed date=${dateKey}`);
      }
    } else {
      logger.error(`[deal-hunter:sheet-sync] failed date=${dateKey}: ${error}`);
    }
  }

  async function tick() {
    if (stopped || inFlight) return;
    const at = now();
    let zoned;
    try {
      zoned = getZonedParts(at, schedule.timezone);
    } catch {
      return;
    }
    const { dateKey, minutesSinceMidnight } = zoned;
    if (zoned.weekday === 'Sat' || zoned.weekday === 'Sun') return;
    if (minutesSinceMidnight < startMinutes || minutesSinceMidnight >= endMinutes) return;
    if (finishedDates.has(dateKey)) return;
    const atMs = at.getTime();
    if (lastAttemptDate === dateKey && atMs - lastAttemptAt < retryIntervalMs) return;

    inFlight = true;
    lastAttemptDate = dateKey;
    lastAttemptAt = atMs;
    try {
      await attempt(at, dateKey);
    } catch (error) {
      logger.error(`[deal-hunter:sheet-sync] crashed date=${dateKey}: ${boundedSheetSyncError(error)}`);
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext(delayMs = checkIntervalMs) {
    timer = setTimer(async () => {
      await tick();
      if (!stopped) scheduleNext();
    }, delayMs);
    if (timer?.unref) timer.unref();
  }

  logger.log(`[deal-hunter:sheet-sync] enabled for ${schedule.runAt} ${schedule.timezone} on weekdays, retrying until ${schedule.retryUntil}`);
  scheduleNext(1000);

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}
