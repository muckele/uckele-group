// The 15-minute Pursue sender scheduler (spec 2026-11-03 §5.1), after the Sheet sync
// scheduler's pattern. It is off unless DEAL_HUNTER_PURSUE_SENDER_ENABLED=true.
//
// Each 15-minute slot is one `scheduled_job_runs` claim, so overlapping ticks or two processes
// run the sender once per slot, and each run leaves one Job history row with its counts. The
// row never holds message bodies, addresses or tokens: only counts, skip reasons and codes.
import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { runPursueCimSender } from './pursueCimSender.js';

export const PURSUE_CIM_SENDER_JOB_NAME = 'pursue-cim-sender';
const claimStaleMs = 60 * 60 * 1000;
const checkIntervalMs = 60_000;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;

function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function codes(skipped) {
  const result = {};
  if (!skipped || typeof skipped !== 'object') return result;
  for (const [reason, value] of Object.entries(skipped)) {
    if (CODE.test(reason)) result[reason] = count(value);
  }
  return result;
}

function runMetadata(result, error) {
  return {
    ok: !error,
    sentInitial: count(result?.sentInitial),
    sentFollowUps: count(result?.sentFollowUps),
    expired: count(result?.expired),
    reconciled: count(result?.reconciled),
    released: count(result?.released),
    skipped: codes(result?.skipped),
    failed: count(result?.failed),
    ambiguous: count(result?.ambiguous),
    ...(['provider_quota', 'not_ready'].includes(result?.stoppedFor)
      ? { stoppedFor: result.stoppedFor } : {}),
    ...(Array.isArray(result?.notReadyReasons)
      ? { notReadyReasons: result.notReadyReasons.filter((reason) => CODE.test(reason)) } : {}),
    error: error || null,
  };
}

function errorCode(error) {
  return typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'pursue_sender_failed';
}

/**
 * Starts the sender scheduler. `run` defaults to the production sender with the owner's Gmail
 * mailbox. Returns `{ tick, stop }`.
 */
export function startPursueCimSenderScheduler({
  storage = null,
  config = null,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  run = runPursueCimSender,
  logger = console,
  claimTokenFactory = randomUUID,
} = {}) {
  const resolvedConfig = config || getConfig();
  const schedule = resolvedConfig.dealHunter?.pursueSender || {};
  if (!schedule.enabled) {
    logger.log('[pursue-cim-sender] scheduler disabled');
    return { async tick() {}, stop() {} };
  }
  const intervalMs = Math.max(1, Number(schedule.intervalMinutes) || 15) * 60_000;

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let lastSlot = '';

  async function attempt(at, slot) {
    const jobKey = `${PURSUE_CIM_SENDER_JOB_NAME}:${slot}`;
    const claimToken = claimTokenFactory();
    const activeStorage = storage || getStorage();
    const claim = await activeStorage.claimScheduledJob({
      jobKey,
      jobName: PURSUE_CIM_SENDER_JOB_NAME,
      triggeredBy: 'scheduler',
      claimToken,
      nowIso: at.toISOString(),
      staleBefore: new Date(at.getTime() - claimStaleMs).toISOString(),
      metadata: { slot, trigger: 'scheduler' },
    });
    // Another tick or process holds (or finished) this slot.
    if (!(claim.applied ?? claim.claimed)) return;

    let result = null;
    let error = '';
    try {
      // A live clock: each claim, gate attempt and send in the run reads its own instant.
      result = await run({ storage: activeStorage, now: at, clock: now,
        config: config || undefined });
    } catch (cause) {
      error = errorCode(cause);
    }
    const finishedAt = now();
    const finishedIso = (finishedAt instanceof Date && Number.isFinite(finishedAt.getTime())
      ? finishedAt : at).toISOString();
    try {
      const transition = await activeStorage.transitionScheduledJob({
        jobKey, claimToken, expectedStatuses: ['pending'],
        status: error ? 'failed' : 'completed', nowIso: finishedIso,
        ...(error ? { lastError: error } : { completedAt: finishedIso }),
        metadataPatch: runMetadata(result, error),
      });
      if (!(transition.applied ?? transition.claimed)) {
        logger.error(`[pursue-cim-sender] run not recorded slot=${slot} reason=${transition.reason || 'unknown'}`);
      } else if (error) {
        logger.error(`[pursue-cim-sender] failed slot=${slot} code=${error}`);
      } else {
        const metadata = runMetadata(result, '');
        // The sanitized skip codes, so a touch that is skipped on every run shows in the logs.
        const skipped = Object.entries(metadata.skipped).filter(([, value]) => value > 0)
          .map(([reason, value]) => `${reason}:${value}`).join(',');
        logger.log(`[pursue-cim-sender] slot=${slot} sent=${metadata.sentInitial}`
          + ` followUps=${metadata.sentFollowUps} expired=${metadata.expired}`
          + `${metadata.stoppedFor ? ` stoppedFor=${metadata.stoppedFor}` : ''}`
          + `${skipped ? ` skipped=${skipped}` : ''}`);
      }
    } catch (cause) {
      logger.error(`[pursue-cim-sender] run not recorded slot=${slot} code=${errorCode(cause)}`);
    }
  }

  async function tick() {
    if (stopped || inFlight) return;
    const at = now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return;
    const slot = new Date(Math.floor(at.getTime() / intervalMs) * intervalMs).toISOString();
    if (slot === lastSlot) return;
    inFlight = true;
    lastSlot = slot;
    try {
      await attempt(at, slot);
    } catch (cause) {
      logger.error(`[pursue-cim-sender] crashed slot=${slot} code=${errorCode(cause)}`);
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

  logger.log(`[pursue-cim-sender] enabled every ${intervalMs / 60_000} minutes`);
  scheduleNext(1000);

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}
