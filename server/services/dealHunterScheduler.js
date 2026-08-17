import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { runCimStage2Automation, runDealHunterCimFollowUps, sendDailyDealHunterReview } from './dealHunter.js';
import { evaluateCimStage2Window, getCimAutomationStatus, getCimStage2Policy } from './cimAutomation.js';

const dailyEmailSource = 'daily-deal-hunter';
const dailyEmailJobName = 'daily-deal-hunter-email';
const dailyEmailClaimStaleMs = 60 * 60 * 1000;

function parseScheduleTime(value = '10:15') {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return { hour: 10, minute: 15 };
  }

  const hour = Math.max(0, Math.min(Number(match[1]), 23));
  const minute = Math.max(0, Math.min(Number(match[2]), 59));
  return { hour, minute };
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: hour * 60 + Number(parts.minute),
  };
}

function dailyEmailMarkerPath(markerDir, dateKey) {
  return path.join(markerDir, `${dateKey}.json`);
}

async function hasSentDailyEmailMarker(markerDir, dateKey) {
  if (!markerDir) {
    return false;
  }

  try {
    await fs.access(dailyEmailMarkerPath(markerDir, dateKey));
    return true;
  } catch {
    return false;
  }
}

async function writeSentDailyEmailMarker(markerDir, dateKey, result) {
  if (!markerDir) {
    return;
  }

  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(
    dailyEmailMarkerPath(markerDir, dateKey),
    JSON.stringify(
      {
        dateKey,
        createdAt: new Date().toISOString(),
        emailStatus: result.emailResult.status,
        providerMessageId: result.emailResult.providerMessageId || '',
        totals: result.review?.totals || {},
        crmSync: result.crmSync || result.review?.crmSync || {},
      },
      null,
      2,
    ),
  );
}

export function shouldRunDailyDealHunterEmail({
  now = new Date(),
  timezone = 'America/Los_Angeles',
  scheduleTime = '10:15',
} = {}) {
  const scheduled = parseScheduleTime(scheduleTime);
  const zoned = getZonedParts(now, timezone);

  return {
    dateKey: zoned.dateKey,
    due: zoned.minutesSinceMidnight >= scheduled.hour * 60 + scheduled.minute,
  };
}

async function hasSentDailyEmailForDate(storage, dateKey, timezone, markerDir) {
  if (await hasSentDailyEmailMarker(markerDir, dateKey)) {
    return true;
  }

  if (!storage.listEmailEvents) {
    return false;
  }

  try {
    const events = await storage.listEmailEvents({
      source: dailyEmailSource,
      limit: 50,
    });

    return events.some((event) => {
      if (event.event_type !== 'sent' || !event.created_at) {
        return false;
      }

      return getZonedParts(new Date(event.created_at), timezone).dateKey === dateKey;
    });
  } catch (error) {
    console.warn(`[deal-hunter:scheduler] sent-email history lookup failed: ${error.message}`);
    return false;
  }
}

export async function runClaimedDailyDealHunterEmail({
  triggeredBy = 'admin',
  now = new Date(),
  storage = getStorage(),
  sendReview = sendDailyDealHunterReview,
  markerDir,
} = {}) {
  const config = getConfig();
  const schedule = config.dealHunter.dailyEmail;
  const effectiveMarkerDir = markerDir === undefined ? schedule.markerDir : markerDir;
  const { dateKey } = shouldRunDailyDealHunterEmail({
    now,
    timezone: schedule.timezone,
    scheduleTime: schedule.time,
  });
  const jobKey = `${dailyEmailJobName}:${dateKey}`;

  if (await hasSentDailyEmailForDate(storage, dateKey, schedule.timezone, effectiveMarkerDir)) {
    let jobRun = null;

    try {
      const existingRun = await storage.getScheduledJob?.(jobKey);
      jobRun = existingRun?.status === 'completed'
        ? existingRun
        : await storage.completeScheduledJob?.(jobKey, {
            status: 'completed',
            provider_message_id: existingRun?.provider_message_id || '',
            metadata: {
              ...(existingRun?.metadata || {}),
              dateKey,
              timezone: schedule.timezone,
              reconciledFromDeliveryEvidence: true,
            },
          });
    } catch (error) {
      console.warn(`[deal-hunter:scheduler] sent-email reconciliation failed: ${error.message}`);
    }

    return {
      alreadySent: true,
      jobKey,
      jobRun,
      emailResult: { status: 'already-sent', error: '', providerMessageId: '' },
      review: null,
    };
  }

  const nowIso = now.toISOString();
  const claim = await storage.claimScheduledJob({
    jobKey,
    jobName: dailyEmailJobName,
    triggeredBy,
    nowIso,
    staleBefore: new Date(now.getTime() - dailyEmailClaimStaleMs).toISOString(),
    metadata: { dateKey, timezone: schedule.timezone },
  });

  if (!claim.claimed) {
    return {
      alreadySent: claim.run?.status === 'completed',
      inProgress: claim.run?.status === 'pending',
      jobKey,
      jobRun: claim.run,
      emailResult: {
        status: claim.run?.status === 'completed' ? 'already-sent' : 'in-progress',
        error: '',
        providerMessageId: claim.run?.provider_message_id || '',
      },
      review: null,
    };
  }

  let result;
  let deliveryConfirmed = false;

  try {
    result = await sendReview({ idempotencyKey: jobKey });
    const failed = result.emailResult.status === 'failed';
    deliveryConfirmed = !failed;

    if (deliveryConfirmed) {
      await writeSentDailyEmailMarker(effectiveMarkerDir, dateKey, result).catch((error) => {
        console.warn(`[deal-hunter:scheduler] daily email marker write failed: ${error.message}`);
      });
    }

    const completedAt = new Date().toISOString();
    const jobRun = await storage.completeScheduledJob(jobKey, {
      completed_at: completedAt,
      status: failed ? 'failed' : 'completed',
      provider_message_id: result.emailResult.providerMessageId || '',
      last_error: result.emailResult.error || '',
      metadata: {
        dateKey,
        timezone: schedule.timezone,
        totals: result.review?.totals || {},
        crmSync: result.crmSync || result.review?.crmSync || {},
      },
    });

    return { ...result, jobKey, jobRun, alreadySent: false };
  } catch (error) {
    if (!deliveryConfirmed) {
      await storage.completeScheduledJob(jobKey, {
        status: 'failed',
        last_error: error.message || 'Daily Deal Hunter email failed.',
        metadata: { dateKey, timezone: schedule.timezone },
      }).catch(() => {});
    } else {
      error.deliveryConfirmed = true;
    }
    throw error;
  }
}

export async function getDailyDealHunterJobStatus(now = new Date()) {
  const config = getConfig();
  const { dateKey } = shouldRunDailyDealHunterEmail({
    now,
    timezone: config.dealHunter.dailyEmail.timezone,
    scheduleTime: config.dealHunter.dailyEmail.time,
  });
  return getStorage().getScheduledJob(`${dailyEmailJobName}:${dateKey}`);
}

export function startDealHunterDailyEmailScheduler({
  getNow = () => new Date(),
  runEmail = runClaimedDailyDealHunterEmail,
  scheduleTimer = setTimeout,
  scheduleOverride = {},
} = {}) {
  const config = getConfig();
  const schedule = { ...config.dealHunter.dailyEmail, ...scheduleOverride };

  if (!schedule.enabled) {
    console.log('[deal-hunter:scheduler] daily email scheduler disabled');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let lastAttemptDate = '';
  let lastAttemptAt = 0;
  const sentDates = new Set();

  async function tick() {
    if (stopped || inFlight) {
      return;
    }

    const now = getNow();
    const { dateKey, due } = shouldRunDailyDealHunterEmail({
      now,
      timezone: schedule.timezone,
      scheduleTime: schedule.time,
    });

    if (!due || sentDates.has(dateKey)) {
      return;
    }

    const nowMs = now.getTime();
    if (lastAttemptDate === dateKey && nowMs - lastAttemptAt < schedule.retryIntervalMs) {
      return;
    }

    inFlight = true;
    lastAttemptDate = dateKey;
    lastAttemptAt = nowMs;

    try {
      console.log(`[deal-hunter:scheduler] sending daily email for ${dateKey} at ${schedule.time} ${schedule.timezone}`);
      const result = await runEmail({ triggeredBy: 'scheduler', now });

      if (result.alreadySent) {
        sentDates.add(dateKey);
        return;
      }

      if (result.inProgress) {
        return;
      }

      if (result.emailResult.status === 'failed') {
        console.error(`[deal-hunter:scheduler] daily email failed: ${result.emailResult.error || 'unknown error'}`);
        return;
      }

      sentDates.add(dateKey);
      console.log(`[deal-hunter:scheduler] daily email ${result.emailResult.status} for ${dateKey}`);
    } catch (error) {
      console.error(`[deal-hunter:scheduler] daily email crashed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext(delayMs = schedule.checkIntervalMs) {
    timer = scheduleTimer(async () => {
      await tick();

      if (!stopped) {
        scheduleNext();
      }
    }, delayMs);

    if (timer.unref) {
      timer.unref();
    }
  }

  console.log(`[deal-hunter:scheduler] enabled for ${schedule.time} ${schedule.timezone}`);
  scheduleNext(1000);

  return {
    tick,
    stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export function startDealHunterCimFollowUpScheduler() {
  const config = getConfig();
  const schedule = config.dealHunter.cimFollowUp;

  if (!schedule.enabled) {
    console.log('[deal-hunter:cim-follow-up] scheduler disabled');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;

    try {
      const result = await runDealHunterCimFollowUps();

      if (!result.ok) {
        console.error(`[deal-hunter:cim-follow-up] failed: ${result.error || 'unknown error'}`);
        return;
      }

      if (result.reviewed > 0 || result.sent > 0 || result.responded > 0 || result.stopped > 0 || result.failed > 0) {
        console.log(
          `[deal-hunter:cim-follow-up] reviewed=${result.reviewed} sent=${result.sent} responded=${result.responded} stopped=${result.stopped} failed=${result.failed}`,
        );
      }
    } catch (error) {
      console.error(`[deal-hunter:cim-follow-up] crashed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext(delayMs = schedule.checkIntervalMs) {
    timer = setTimeout(async () => {
      await tick();

      if (!stopped) {
        scheduleNext();
      }
    }, delayMs);

    if (timer.unref) {
      timer.unref();
    }
  }

  console.log(
    `[deal-hunter:cim-follow-up] enabled every ${Math.round(schedule.checkIntervalMs / 60000)} minute(s), max ${schedule.maxCount} follow-up(s)`,
  );
  scheduleNext(1000);

  return {
    stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export function startDealHunterCimStage2Scheduler({
  getNow = () => new Date(),
  runStage2 = runCimStage2Automation,
  scheduleTimer = setTimeout,
} = {}) {
  const config = getConfig();
  const schedule = config.dealHunter.cimAutomation;
  if (!schedule.schedulerEnabled) {
    console.log('[deal-hunter:cim-stage2] scheduler disabled');
    return { stop() {} };
  }
  let stopped = false;
  let inFlight = false;
  let timer = null;
  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const now = getNow();
      const status = await getCimAutomationStatus({ now });
      const mode = ['canary', 'active'].includes(status.activationMode) ? status.activationMode : 'shadow';
      if (mode !== 'shadow' && !evaluateCimStage2Window(now, getCimStage2Policy(config)).open) return;
      const result = await runStage2({ mode, triggeredBy: 'stage2-scheduler', now });
      if (!result.ok && !result.duplicateInvocation) {
        console.error(`[deal-hunter:cim-stage2] ${mode} run blocked: ${result.error || 'readiness gate failed'}`);
      }
    } catch (error) {
      console.error(`[deal-hunter:cim-stage2] scheduler failed closed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }
  function scheduleNext(delayMs = schedule.schedulerCheckIntervalMs) {
    timer = scheduleTimer(async () => {
      await tick();
      if (!stopped) scheduleNext();
    }, delayMs);
    if (timer.unref) timer.unref();
  }
  console.log(`[deal-hunter:cim-stage2] scheduler enabled; check interval ${Math.round(schedule.schedulerCheckIntervalMs / 60000)} minute(s)`);
  scheduleNext(1000);
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
