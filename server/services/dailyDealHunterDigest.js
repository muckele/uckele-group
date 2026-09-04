import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getSourceHealth } from './acquisitionCommandCenter.js';
import { refreshOpportunityScores } from './dealHunterScoreStore.js';
import { listTriageQueue } from './dealHunterTriage.js';

export const DAILY_DEAL_HUNTER_DIGEST_VERSION = 'daily-deal-hunter-digest-v1';
export const DAILY_DEAL_HUNTER_TOP_LIMIT = 5;

const MAX_BLOCKING_ISSUES = 3;
const MAX_OPTIONAL_WARNINGS = 1;

function normalizeText(value = '', maximum = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function safeDisplayText(value = '', maximum = 400) {
  return normalizeText(value, maximum * 2)
    .replace(/\b(?:https?|file):\/\/\S+/gi, '[redacted URL]')
    .replace(/\b(api[-_ ]?key|password|secret|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, maximum);
}

function boundedCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function projectedSummary(summary = {}) {
  return {
    needsReview: boundedCount(summary.needsReview),
    highPriority: boundedCount(summary.highPriority),
    watchlist: boundedCount(summary.watchlist),
    lowConfidence: boundedCount(summary.lowConfidence),
    currentOpportunities: boundedCount(summary.currentOpportunities),
  };
}

function sourceById(sourceHealth = {}) {
  return new Map((Array.isArray(sourceHealth?.sources) ? sourceHealth.sources : [])
    .map((source) => [normalizeText(source?.id, 160), source]));
}

function classifyIssue(issue = {}, fallback = 'source-unhealthy') {
  const text = normalizeText([
    issue.sourceId,
    issue.title,
    issue.message,
    issue.error,
  ].filter(Boolean).join(' '), 1000).toLowerCase();
  if (text.includes('identity')) return 'identity-incomplete';
  if (text.includes('score')) return 'scoring-refresh-failed';
  if (text.includes('queue')) return 'queue-unavailable';
  if (issue.sourceUnavailable === true || /unavailable|failed to fetch|lookup outage/.test(text)) return 'unavailable';
  if (/zero rows|empty/.test(text)) return 'empty';
  if (/row count dropped|incomplete|coverage/.test(text)) return 'suspiciously-incomplete';
  return fallback;
}

function projectedIssue(issue = {}, sources = new Map(), fallback = 'source-unhealthy') {
  const source = sources.get(normalizeText(issue.sourceId, 160)) || {};
  return {
    sourceId: safeDisplayText(issue.sourceId || source.id || 'acquisition-authority', 160),
    sourceName: safeDisplayText(source.name || issue.sourceName || 'Acquisition authority', 160),
    classification: classifyIssue(issue, fallback),
    title: safeDisplayText(issue.title || 'Acquisition authority needs attention', 160),
    message: safeDisplayText(issue.message || issue.error || 'Current acquisition authority could not be established.', 320),
    checkedAt: safeDisplayText(issue.checkedAt || source.checkedAt || '', 80),
  };
}

function sourceAuthority({ sourceHealth, scoreRefresh, queue }) {
  const sources = sourceById(sourceHealth);
  const issues = Array.isArray(sourceHealth?.issues) ? sourceHealth.issues : [];
  const blockingIssues = issues
    .filter((issue) => issue?.affectsHealth !== false)
    .map((issue) => projectedIssue(issue, sources));
  const optionalWarnings = issues
    .filter((issue) => issue?.affectsHealth === false)
    .map((issue) => projectedIssue(issue, sources, 'optional-source-unavailable'))
    .slice(0, MAX_OPTIONAL_WARNINGS);

  if (!sourceHealth || sourceHealth.healthy !== true) {
    if (blockingIssues.length === 0) {
      blockingIssues.push(projectedIssue({
        sourceId: 'source-health',
        title: 'Required source health is unavailable',
        message: 'Current required-source health could not be established.',
        sourceUnavailable: true,
        checkedAt: sourceHealth?.generatedAt,
      }, sources, 'unavailable'));
    }
  }

  if (scoreRefresh?.ok !== true) {
    blockingIssues.push(projectedIssue({
      sourceId: 'score-refresh',
      title: 'Authoritative score refresh failed',
      message: scoreRefresh?.error || 'Current score and eligibility authority could not be established.',
      checkedAt: sourceHealth?.generatedAt,
    }, sources, 'scoring-refresh-failed'));
  }

  const queueIsAuthoritative = queue?.ok === true
    && Array.isArray(queue.rows)
    && queue.summary
    && typeof queue.summary === 'object'
    && !Array.isArray(queue.summary);
  if (!queueIsAuthoritative) {
    blockingIssues.push(projectedIssue({
      sourceId: 'acquisition-inbox',
      title: 'Acquisition Inbox authority is unavailable',
      message: queue?.error || 'The current Acquisition Inbox could not be read.',
      checkedAt: sourceHealth?.generatedAt,
    }, sources, 'queue-unavailable'));
  }

  const boundedBlockingIssues = blockingIssues.slice(0, MAX_BLOCKING_ISSUES);
  return {
    requiredHealthy: boundedBlockingIssues.length === 0,
    blockingIssues: boundedBlockingIssues,
    optionalWarnings,
  };
}

function projectedOpportunity(row = {}) {
  return {
    opportunityId: safeDisplayText(row.opportunityId, 160),
    name: safeDisplayText(row.name || 'Unnamed opportunity', 160),
    state: safeDisplayText(row.state, 20),
    fitScore: Number.isFinite(Number(row.fitScore)) ? Number(row.fitScore) : 0,
    scoreStatus: safeDisplayText(row.scoreStatus || 'provisional', 40),
    confidence: safeDisplayText(row.confidence || 'low', 20),
    operatorPriority: safeDisplayText(row.operatorPriority || 'normal', 40),
    reviewed: Boolean(row.reviewed),
    changedSinceReview: Boolean(row.changedSinceReview),
    topStrength: safeDisplayText(row.topStrength, 400),
    topConcern: safeDisplayText(row.topConcern, 400),
    workflow: {
      crmStatus: safeDisplayText(row.workflow?.crmStatus || 'not-started', 80),
      cimStatus: safeDisplayText(row.workflow?.cimStatus || 'not-requested', 80),
    },
    observationFreshness: safeDisplayText(row.observationFreshness, 80),
  };
}

function projectedJob(job = {}, notificationType = '') {
  return {
    status: safeDisplayText(job.status, 40),
    attemptCount: boundedCount(job.attemptCount),
    completedAt: safeDisplayText(job.completedAt, 80),
    notificationType: safeDisplayText(job.notificationType || notificationType, 40),
  };
}

function applicationLinks() {
  const origin = getConfig().server.origin;
  return {
    inbox: new URL('/admin/deal-hunter', origin).toString(),
    operations: new URL('/admin/deal-hunter?view=operations', origin).toString(),
  };
}

export function projectDailyDealHunterDigest({
  businessDate,
  generatedAt,
  sourceHealth,
  scoreRefresh,
  queue,
  job,
} = {}) {
  const authority = sourceAuthority({ sourceHealth, scoreRefresh, queue });
  const alert = !authority.requiredHealthy;
  const notificationType = alert ? 'required-source-alert' : 'normal-digest';

  return {
    version: DAILY_DEAL_HUNTER_DIGEST_VERSION,
    businessDate: safeDisplayText(businessDate, 20),
    generatedAt: safeDisplayText(generatedAt || sourceHealth?.generatedAt, 80),
    status: alert ? 'action-required' : authority.optionalWarnings.length > 0 ? 'optional-warning' : 'ready',
    notificationType,
    sourceAuthority: authority,
    summary: alert ? null : projectedSummary(queue?.summary),
    topOpportunities: alert
      ? []
      : (Array.isArray(queue?.rows) ? queue.rows : [])
          .slice(0, DAILY_DEAL_HUNTER_TOP_LIMIT)
          .map(projectedOpportunity),
    job: projectedJob(job, notificationType),
    actionsAllowed: !alert,
    links: applicationLinks(),
  };
}

function unavailableSourceHealth(error, generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    healthy: false,
    sources: [],
    issues: [{
      sourceId: 'source-health',
      affectsHealth: true,
      sourceUnavailable: true,
      title: 'Required source health is unavailable',
      message: error?.message || 'Current required-source health could not be established.',
      checkedAt: generatedAt,
    }],
  };
}

export async function buildCurrentDailyDealHunterDigest({
  businessDate,
  storage = getStorage(),
  refreshScores = refreshOpportunityScores,
  readSourceHealth = getSourceHealth,
  readTriageQueue = listTriageQueue,
} = {}) {
  let scoreRefresh;
  try {
    scoreRefresh = await refreshScores({ storage, recordActivity: false });
  } catch (error) {
    scoreRefresh = { ok: false, status: 503, error: error?.message || 'Authoritative score refresh failed.' };
  }

  let sourceHealth;
  if (scoreRefresh?.review && typeof scoreRefresh.review === 'object') {
    try {
      sourceHealth = await readSourceHealth(storage, { persistSnapshot: true, review: scoreRefresh.review });
    } catch (error) {
      sourceHealth = unavailableSourceHealth(error, scoreRefresh.review.generatedAt);
    }
  } else {
    sourceHealth = unavailableSourceHealth(
      new Error('The authoritative score refresh did not return its source review.'),
    );
  }

  if (scoreRefresh?.ok !== true || sourceHealth?.healthy !== true) {
    return projectDailyDealHunterDigest({
      businessDate,
      generatedAt: sourceHealth?.generatedAt || scoreRefresh?.review?.generatedAt,
      sourceHealth,
      scoreRefresh,
      queue: { ok: true, rows: [], summary: {} },
    });
  }

  let queue;
  try {
    queue = await readTriageQueue({
      storage,
      view: 'needs-review',
      sort: 'acquisition-priority',
      direction: 'desc',
      page: 1,
      pageSize: DAILY_DEAL_HUNTER_TOP_LIMIT,
    });
  } catch (error) {
    queue = { ok: false, status: 503, error: error?.message || 'The current Acquisition Inbox could not be read.' };
  }

  return projectDailyDealHunterDigest({
    businessDate,
    generatedAt: sourceHealth.generatedAt || scoreRefresh.review.generatedAt,
    sourceHealth,
    scoreRefresh,
    queue,
  });
}
