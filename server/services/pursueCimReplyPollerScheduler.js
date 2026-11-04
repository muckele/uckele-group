// The 5-minute Gmail reply poller scheduler (spec 2026-11-03 §6), after the Pursue sender
// scheduler's pattern. It is off unless DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=true.
//
// Each 5-minute slot is one `scheduled_job_runs` claim, so overlapping ticks or two processes
// poll once per slot, and each poll leaves one Job history row with its counts. The row never
// holds message bodies, subjects, addresses or tokens: only counts and codes.
import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { runPursueCimReplyPoll } from './pursueCimReplyPoller.js';

export const PURSUE_CIM_REPLY_POLLER_JOB_NAME = 'pursue-cim-reply-poller';
const claimStaleMs = 30 * 60 * 1000;
const checkIntervalMs = 60_000;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const COUNTS = ['processed', 'responded', 'ownerReplied', 'bounced', 'autoReplies', 'stopped',
  'failed'];

function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function runMetadata(result, error) {
  return {
    ok: !error,
    ...Object.fromEntries(COUNTS.map((key) => [key, count(result?.[key])])),
    checkpointExpired: result?.checkpointExpired === true,
    checkpointAdvanced: result?.checkpointAdvanced === true,
    ...(result?.stoppedFor === 'gmail_not_connected' ? { stoppedFor: result.stoppedFor } : {}),
    error: error || null,
  };
}

function errorCode(error) {
  return typeof error?.code === 'string' && CODE.test(error.code)
    ? error.code : 'pursue_reply_poller_failed';
}

/**
 * Starts the reply poller scheduler. `run` defaults to the production poll with the owner's
 * Gmail mailbox. Returns `{ tick, stop }`.
 */
export function startPursueCimReplyPollerScheduler({
  storage = null,
  config = null,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  run = runPursueCimReplyPoll,
  logger = console,
  claimTokenFactory = randomUUID,
} = {}) {
  const resolvedConfig = config || getConfig();
  const schedule = resolvedConfig.dealHunter?.replyPoller || {};
  if (!schedule.enabled) {
    logger.log('[pursue-cim-reply-poller] scheduler disabled');
    return { async tick() {}, stop() {} };
  }
  const intervalMs = Math.max(1, Number(schedule.intervalMinutes) || 5) * 60_000;

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let lastSlot = '';

  async function attempt(at, slot) {
    const jobKey = `${PURSUE_CIM_REPLY_POLLER_JOB_NAME}:${slot}`;
    const claimToken = claimTokenFactory();
    const activeStorage = storage || getStorage();
    const claim = await activeStorage.claimScheduledJob({
      jobKey,
      jobName: PURSUE_CIM_REPLY_POLLER_JOB_NAME,
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
      result = await run({ storage: activeStorage, now, config: config || undefined });
    } catch (cause) {
      error = errorCode(cause);
    }
    const finishedAt = now();
    const finishedIso = (finishedAt instanceof Date && Number.isFinite(finishedAt.getTime())
      ? finishedAt : at).toISOString();
    try {
      const metadata = runMetadata(result, error);
      const transition = await activeStorage.transitionScheduledJob({
        jobKey, claimToken, expectedStatuses: ['pending'],
        status: error ? 'failed' : 'completed', nowIso: finishedIso,
        ...(error ? { lastError: error } : { completedAt: finishedIso }),
        metadataPatch: metadata,
      });
      if (!(transition.applied ?? transition.claimed)) {
        logger.error(`[pursue-cim-reply-poller] run not recorded slot=${slot} reason=${transition.reason || 'unknown'}`);
      } else if (error) {
        logger.error(`[pursue-cim-reply-poller] failed slot=${slot} code=${error}`);
      } else if (metadata.stoppedFor) {
        logger.log(`[pursue-cim-reply-poller] slot=${slot} skipped=${metadata.stoppedFor}`);
      } else {
        logger.log(`[pursue-cim-reply-poller] slot=${slot} processed=${metadata.processed}`
          + ` responded=${metadata.responded} stopped=${metadata.stopped}`
          + ` ownerReplied=${metadata.ownerReplied} bounced=${metadata.bounced}`
          + ` autoReplies=${metadata.autoReplies} failed=${metadata.failed}`);
      }
    } catch (cause) {
      logger.error(`[pursue-cim-reply-poller] run not recorded slot=${slot} code=${errorCode(cause)}`);
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
      logger.error(`[pursue-cim-reply-poller] crashed slot=${slot} code=${errorCode(cause)}`);
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

  logger.log(`[pursue-cim-reply-poller] enabled every ${intervalMs / 60_000} minutes`);
  scheduleNext(1000);

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}
