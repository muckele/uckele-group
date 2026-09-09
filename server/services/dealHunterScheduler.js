import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { runCimStage2Automation, runDealHunterCimFollowUps } from './dealHunter.js';
import { evaluateCimStage2Window, getCimAutomationStatus, getCimStage2Policy } from './cimAutomation.js';
import {
  buildCurrentDailyDealHunterDigest,
  buildDailyDealHunterEmailEnvelope,
  verifyDailyDealHunterEmailEnvelope,
} from './dailyDealHunterDigest.js';
import {
  lookupDailyDealHunterProviderMessages,
  sendPreparedMessage,
} from './delivery.js';
import { recordEmailEvent } from './emailEvents.js';
import {
  reconcileDailyDealHunterJob,
  writeDailyDealHunterMarker,
} from './dailyDealHunterReconciliation.js';

const dailyEmailSource = 'daily-deal-hunter';
const dailyEmailJobName = 'daily-deal-hunter-email';
const dailyEmailClaimStaleMs = 60 * 60 * 1000;

function boundedProviderIdentity(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:@-]{1,240}$/.test(normalized) ? normalized : '';
}

function acceptedResendProviderIdentity(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.status !== 'sent'
    || result.provider !== 'resend') {
    return '';
  }
  const providerMessageId = boundedProviderIdentity(result.providerMessageId);
  if (!providerMessageId) return '';
  for (const alias of ['id', 'email_id']) {
    if (Object.hasOwn(result, alias) && boundedProviderIdentity(result[alias]) !== providerMessageId) {
      return '';
    }
  }
  return providerMessageId;
}

function boundedIsoTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function boundedStatusText(value, maximum) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

export function projectDailyDealHunterJobStatus(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  const metadata = run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
    ? run.metadata
    : {};
  const reconciliation = metadata.reconciliation
    && typeof metadata.reconciliation === 'object'
    && !Array.isArray(metadata.reconciliation)
    ? metadata.reconciliation
    : {};
  const status = boundedStatusText(run.status, 40);
  const attemptCount = Number.isInteger(run.attempt_count) && run.attempt_count >= 0
    ? run.attempt_count
    : 0;
  const completedAt = boundedIsoTimestamp(run.completed_at);
  const projectedReconciliation = {
    checkedAt: boundedIsoTimestamp(reconciliation.checkedAt),
    source: boundedStatusText(reconciliation.source || metadata.reconciliationSource, 80),
    errorCategory: boundedStatusText(reconciliation.errorCategory, 120),
    severity: boundedStatusText(reconciliation.severity, 20),
  };
  return {
    status,
    notificationType: boundedStatusText(metadata.notificationType, 40),
    businessDate: boundedStatusText(metadata.businessDate || metadata.pacificDate || metadata.dateKey, 20),
    attemptCount,
    attempt_count: attemptCount,
    completedAt,
    completed_at: completedAt,
    failedAt: boundedIsoTimestamp(metadata.failedAt),
    nextRetryAt: boundedIsoTimestamp(metadata.nextRetryAt),
    provider: boundedStatusText(metadata.provider, 40),
    providerMessageId: boundedProviderIdentity(run.provider_message_id),
    errorCategory: boundedStatusText(
      reconciliation.errorCategory || metadata.failureCategory,
      120,
    ),
    reconciliation: projectedReconciliation,
    prepared: Boolean(metadata.preparedEnvelope),
    attentionRequired: status === 'ambiguous' || projectedReconciliation.severity === 'high',
  };
}

function parseScheduleTime(value = '08:00') {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
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

export function shouldRunDailyDealHunterEmail({
  now = new Date(),
  timezone = 'America/Los_Angeles',
  scheduleTime = '08:00',
} = {}) {
  const scheduled = parseScheduleTime(scheduleTime);
  try {
    if (!scheduled || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid schedule');
    const zoned = getZonedParts(now, timezone);
    return {
      dateKey: zoned.dateKey,
      due: zoned.minutesSinceMidnight >= scheduled.hour * 60 + scheduled.minute,
    };
  } catch {
    return { dateKey: '', due: false };
  }
}

export async function runClaimedDailyDealHunterEmail({
  triggeredBy = 'admin',
  now = new Date(),
  storage = getStorage(),
  buildDigest = buildCurrentDailyDealHunterDigest,
  buildEnvelope = buildDailyDealHunterEmailEnvelope,
  sendPrepared = sendPreparedMessage,
  reconcile = reconcileDailyDealHunterJob,
  recordEvent = recordEmailEvent,
  writeMarker = writeDailyDealHunterMarker,
  providerLookup,
  claimTokenFactory = randomUUID,
  configOverride,
  enforceDueTime = false,
  markerDir,
  getNow = () => new Date(),
} = {}) {
  const config = configOverride || getConfig();
  const schedule = config.dealHunter.dailyEmail;
  const effectiveMarkerDir = markerDir === undefined ? schedule.markerDir : markerDir;
  const dueState = shouldRunDailyDealHunterEmail({
    now,
    timezone: schedule.timezone,
    scheduleTime: schedule.time,
  });
  const { dateKey } = dueState;
  const automaticScheduleDisabled = enforceDueTime && schedule.enabled !== true;
  if (!dateKey || automaticScheduleDisabled || (enforceDueTime && !dueState.due)) {
    return {
      alreadySent: false,
      inProgress: false,
      jobKey: dateKey ? `${dailyEmailJobName}:${dateKey}` : '',
      jobRun: null,
      emailResult: {
        status: 'not-due',
        error: '',
        errorCategory: automaticScheduleDisabled ? 'schedule-disabled' : dateKey ? '' : 'invalid-schedule',
        providerMessageId: '',
      },
      review: null,
    };
  }
  const jobKey = `${dailyEmailJobName}:${dateKey}`;
  const nowIso = now.toISOString();
  const effectiveProviderLookup = providerLookup === undefined && !configOverride
    ? (input) => lookupDailyDealHunterProviderMessages(input)
    : providerLookup;
  let reconciliation = null;
  try {
    reconciliation = await reconcile({
      storage,
      jobKey,
      markerDir: effectiveMarkerDir,
      now,
      providerLookup: effectiveProviderLookup,
    });
  } catch {
    reconciliation = { status: 'reconciliation-unavailable', jobRun: await storage.getScheduledJob?.(jobKey) || null };
  }
  if (reconciliation?.status === 'completed') {
    return {
      alreadySent: true,
      inProgress: false,
      jobKey,
      jobRun: reconciliation.jobRun,
      emailResult: {
        status: 'already-sent',
        error: '',
        errorCategory: '',
        providerMessageId: reconciliation.jobRun?.provider_message_id || '',
      },
      review: null,
      reconciliationSource: reconciliation.source || '',
    };
  }

  const claimToken = claimTokenFactory();
  const claim = await storage.claimScheduledJob({
    jobKey,
    jobName: dailyEmailJobName,
    triggeredBy,
    claimToken,
    nowIso,
    staleBefore: new Date(now.getTime() - dailyEmailClaimStaleMs).toISOString(),
    retryDueAt: nowIso,
    metadata: {
      businessDate: dateKey,
      pacificDate: dateKey,
      dateKey,
      timezone: schedule.timezone,
      trigger: String(triggeredBy || '').slice(0, 80),
    },
  });

  if (!(claim.applied ?? claim.claimed)) {
    const status = claim.run?.status || '';
    const resultStatus = status === 'completed'
      ? 'already-sent'
      : status === 'pending'
        ? 'in-progress'
        : claim.reason === 'retry-not-due'
          ? 'retry-not-due'
          : ['transmitting', 'ambiguous'].includes(status)
            ? status
            : claim.reason || 'unavailable';
    return {
      alreadySent: status === 'completed',
      inProgress: status === 'pending',
      jobKey,
      jobRun: claim.run,
      emailResult: {
        status: resultStatus,
        error: '',
        errorCategory: ['transmitting', 'ambiguous'].includes(status)
          ? boundedStatusText(reconciliation?.reason, 120)
          : '',
        providerMessageId: claim.run?.provider_message_id || '',
      },
      review: null,
    };
  }

  let jobRun = claim.run;
  let projection = null;
  let envelope = jobRun?.metadata?.preparedEnvelope || null;
  if (!envelope) {
    projection = await buildDigest({ businessDate: dateKey, storage });
    envelope = buildEnvelope({
      projection,
      recipient: config.dealHunter.recipient || config.admin?.email || '',
      sender: config.delivery.resendFromEmail || '',
      replyTo: config.delivery.resendReplyTo || '',
      preparedAt: nowIso,
    });
    const prepared = await storage.transitionScheduledJob({
      jobKey,
      claimToken,
      expectedStatuses: ['pending'],
      status: 'pending',
      nowIso,
      metadataPatch: {
        preparedEnvelope: envelope,
        payloadDigest: envelope.payloadDigest,
        firstPreparedAt: envelope.preparedAt,
        preparedAt: envelope.preparedAt,
        businessDate: dateKey,
        pacificDate: dateKey,
        dateKey,
        timezone: schedule.timezone,
        notificationType: envelope.notificationType,
        projectionSummary: projection.summary ? {
          needsReview: projection.summary.needsReview,
          highPriority: projection.summary.highPriority,
          watchlist: projection.summary.watchlist,
          lowConfidence: projection.summary.lowConfidence,
          currentOpportunities: projection.summary.currentOpportunities,
        } : null,
      },
    });
    if (!prepared.applied) {
      return {
        alreadySent: prepared.run?.status === 'completed',
        inProgress: prepared.run?.status === 'pending',
        jobKey,
        jobRun: prepared.run,
        emailResult: { status: prepared.run?.status || prepared.reason, error: '', errorCategory: 'prepare-fence-denied', providerMessageId: '' },
        review: projection,
      };
    }
    jobRun = prepared.run;
    envelope = jobRun.metadata.preparedEnvelope;
  }

  const envelopeVerification = verifyDailyDealHunterEmailEnvelope(envelope);
  if (!envelopeVerification.ok || envelope.idempotencyKey !== jobKey || envelope.businessDate !== dateKey) {
    const failed = await storage.transitionScheduledJob({
      jobKey,
      claimToken,
      expectedStatuses: ['pending'],
      status: 'failed',
      nowIso,
      lastError: 'Persisted Daily Deal Hunter envelope failed integrity validation.',
      metadataPatch: { failureCategory: envelopeVerification.errorCategory || 'invalid-prepared-envelope' },
    });
    return {
      alreadySent: false,
      inProgress: false,
      jobKey,
      jobRun: failed.run || jobRun,
      emailResult: { status: 'failed', error: 'Prepared email authority is invalid.', errorCategory: envelopeVerification.errorCategory || 'invalid-prepared-envelope', providerMessageId: '' },
      review: projection,
    };
  }

  const boundary = await storage.transitionScheduledJob({
    jobKey,
    claimToken,
    expectedStatuses: ['pending'],
    status: 'transmitting',
    nowIso,
    metadataPatch: { provider: 'resend', providerBoundaryAt: nowIso, lastTrigger: String(triggeredBy || '').slice(0, 80) },
  });
  if (!boundary.applied) {
    return {
      alreadySent: boundary.run?.status === 'completed',
      inProgress: boundary.run?.status === 'pending',
      jobKey,
      jobRun: boundary.run,
      emailResult: { status: boundary.run?.status || boundary.reason, error: '', errorCategory: 'provider-boundary-denied', providerMessageId: boundary.run?.provider_message_id || '' },
      review: projection,
    };
  }
  jobRun = boundary.run;

  let emailResult;
  try {
    emailResult = await sendPrepared(envelope, configOverride ? { configOverride: config } : undefined);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    emailResult = {
      status: 'ambiguous',
      provider: 'resend',
      providerMessageId: '',
      error: 'Provider outcome is unknown and requires reconciliation.',
      errorCategory: /timeout|timed out|aborted/.test(message)
        ? 'provider-timeout'
        : /reset|connection|socket|network/.test(message)
          ? 'provider-connection-unknown'
          : 'provider-outcome-unknown',
    };
  }

  const acceptedProviderId = acceptedResendProviderIdentity(emailResult)
    || (emailResult.status === 'logged' && emailResult.provider === 'console' && !config.isProduction
      ? `development-only-${dateKey}`
      : '');
  if (acceptedProviderId) {
    const acceptedAt = nowIso;
    const evidence = {
      jobKey,
      businessDate: dateKey,
      notificationType: envelope.notificationType,
      payloadDigest: envelope.payloadDigest,
      providerMessageId: acceptedProviderId,
      acceptedAt,
    };
    let markerWritten = false;
    try {
      markerWritten = Boolean((await writeMarker({ markerDir: effectiveMarkerDir, evidence })).written || !effectiveMarkerDir);
    } catch {
      markerWritten = false;
    }
    let completed = null;
    try {
      completed = await storage.transitionScheduledJob({
        jobKey,
        claimToken,
        expectedStatuses: ['transmitting'],
        status: 'completed',
        nowIso,
        completedAt: acceptedAt,
        providerMessageId: acceptedProviderId,
        lastError: '',
        metadataPatch: {
          provider: emailResult.provider || (emailResult.status === 'logged' ? 'console' : 'resend'),
          providerMessageId: acceptedProviderId,
          acceptedAt,
          markerWritten,
          completionSource: emailResult.status === 'logged' ? 'development-console' : 'provider-response',
        },
      });
    } catch {
      completed = null;
    }
    try {
      await recordEvent({
        event_key: `resend:daily-deal-hunter:${acceptedProviderId}:sent`,
        created_at: acceptedAt,
        provider: emailResult.provider || (emailResult.status === 'logged' ? 'console' : 'resend'),
        event_type: 'sent',
        message_id: acceptedProviderId,
        recipient_email: envelope.to,
        subject: envelope.subject,
        source: dailyEmailSource,
        metadata: {
          tags: envelope.tags,
          tracking: { jobKey, businessDate: dateKey, notificationType: envelope.notificationType, payloadDigest: envelope.payloadDigest },
        },
      }, { storage });
    } catch {
      // The completed row and marker remain authoritative even if history is temporarily unavailable.
    }
    if (completed?.applied || completed?.reason === 'completed') {
      return {
        alreadySent: false,
        inProgress: false,
        jobKey,
        jobRun: completed.run || jobRun,
        notificationType: envelope.notificationType,
        emailResult: { ...emailResult, providerMessageId: acceptedProviderId },
        review: projection,
      };
    }
    return {
      alreadySent: false,
      inProgress: false,
      jobKey,
      jobRun: completed?.run || jobRun,
      notificationType: envelope.notificationType,
      emailResult: { status: 'ambiguous', provider: 'resend', providerMessageId: acceptedProviderId, error: 'Provider acceptance requires durable reconciliation.', errorCategory: 'post-acceptance-finalization-unknown' },
      review: projection,
    };
  }

  if (emailResult.status === 'failed' && emailResult.definitiveFailure === true) {
    const failureNow = getNow();
    const failureNowIso = failureNow instanceof Date && Number.isFinite(failureNow.getTime())
      ? failureNow.toISOString()
      : nowIso;
    const failed = await storage.transitionScheduledJob({
      jobKey,
      claimToken,
      expectedStatuses: ['transmitting'],
      status: 'failed',
      nowIso: failureNowIso,
      lastError: String(emailResult.errorCategory || 'provider-nonacceptance').slice(0, 200),
      metadataPatch: { failureCategory: emailResult.errorCategory || 'provider-nonacceptance' },
    });
    return {
      alreadySent: false,
      inProgress: false,
      jobKey,
      jobRun: failed.run || jobRun,
      notificationType: envelope.notificationType,
      emailResult,
      review: projection,
    };
  }

  const afterAmbiguity = await reconcile({
    storage,
    jobKey,
    markerDir: effectiveMarkerDir,
    now,
    providerLookup: effectiveProviderLookup,
  }).catch(() => null);
  return {
    alreadySent: afterAmbiguity?.status === 'completed',
    inProgress: false,
    jobKey,
    jobRun: afterAmbiguity?.jobRun || jobRun,
    notificationType: envelope.notificationType,
    emailResult: afterAmbiguity?.status === 'completed'
      ? { status: 'already-sent', error: '', errorCategory: '', providerMessageId: afterAmbiguity.jobRun?.provider_message_id || '' }
      : {
          ...emailResult,
          status: 'ambiguous',
          providerMessageId: '',
          errorCategory: boundedStatusText(
            afterAmbiguity?.reason
              || emailResult.errorCategory
              || (emailResult.status === 'sent' ? 'invalid-provider-acceptance' : 'provider-outcome-unknown'),
            120,
          ),
        },
    review: projection,
  };
}

export async function getDailyDealHunterJobStatus(now = new Date()) {
  const config = getConfig();
  const { dateKey } = shouldRunDailyDealHunterEmail({
    now,
    timezone: config.dealHunter.dailyEmail.timezone,
    scheduleTime: config.dealHunter.dailyEmail.time,
  });
  const run = await getStorage().getScheduledJob(`${dailyEmailJobName}:${dateKey}`);
  return projectDailyDealHunterJobStatus(run);
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
      const result = await runEmail({ triggeredBy: 'scheduler', now, getNow });

      if (result.alreadySent) {
        sentDates.add(dateKey);
        return;
      }

      if (result.inProgress) {
        return;
      }

      if (['failed', 'ambiguous', 'transmitting', 'retry-not-due', 'not-due'].includes(result.emailResult.status)) {
        console.error(
          `[deal-hunter:scheduler] daily email state=${result.emailResult.status} category=${result.emailResult.errorCategory || 'none'} date=${dateKey}`,
        );
        return;
      }

      if (['sent', 'logged', 'already-sent'].includes(result.emailResult.status)) sentDates.add(dateKey);
      console.log(`[deal-hunter:scheduler] daily email state=${result.emailResult.status} date=${dateKey}`);
    } catch {
      console.error(`[deal-hunter:scheduler] daily email state=crashed category=pre-boundary-error date=${dateKey}`);
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
