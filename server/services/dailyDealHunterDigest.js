import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getSourceHealth } from './acquisitionCommandCenter.js';
import { refreshOpportunityScores } from './dealHunterScoreStore.js';
import { listTriageQueue } from './dealHunterTriage.js';

export const DAILY_DEAL_HUNTER_DIGEST_VERSION = 'daily-deal-hunter-digest-v1';
export const DAILY_DEAL_HUNTER_TOP_LIMIT = 5;

const MAX_BLOCKING_ISSUES = 3;
const MAX_OPTIONAL_WARNINGS = 1;
const SUMMARY_FIELDS = Object.freeze([
  'needsReview',
  'highPriority',
  'watchlist',
  'lowConfidence',
  'currentOpportunities',
]);

const ISSUE_PRESENTATION = Object.freeze({
  'identity-incomplete': {
    title: 'Required source identity is incomplete',
    message: 'Required source identity could not be validated.',
  },
  'scoring-refresh-failed': {
    title: 'Opportunity score refresh failed',
    message: 'Current opportunity scores could not be refreshed.',
  },
  'queue-unavailable': {
    title: 'Acquisition Inbox authority is unavailable',
    message: 'Current acquisition queue could not be built.',
  },
  unavailable: {
    title: 'Required source is unavailable',
    message: 'Required source data is currently unavailable.',
  },
  empty: {
    title: 'Required source is empty',
    message: 'Required source data is currently empty.',
  },
  'suspiciously-incomplete': {
    title: 'Required source may be incomplete',
    message: 'Required source data could not be validated as complete.',
  },
  'optional-source-unavailable': {
    title: 'Optional Deal OS context is unavailable',
    message: 'Optional Deal OS context is currently unavailable.',
  },
  'authority-invalid': {
    title: 'Acquisition authority is invalid',
    message: 'Current acquisition authority could not be validated.',
  },
  'source-unhealthy': {
    title: 'Required source needs attention',
    message: 'Required source data could not be validated.',
  },
});

function normalizeText(value = '', maximum = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function safeDisplayText(value = '', maximum = 400) {
  return normalizeText(value, maximum * 2)
    .replace(/\b(?:https?|file):\/\/\S+/gi, '[redacted URL]')
    .replace(/\b(api[-_ ]?key|password|secret|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, maximum);
}

function safeTimestamp(value) {
  const normalized = normalizeText(value, 80);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized
    : '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && normalizeText(value, 400).length > 0;
}

function isNonnegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function boundedCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function projectedSummary(summary = {}) {
  return {
    needsReview: summary.needsReview,
    highPriority: summary.highPriority,
    watchlist: summary.watchlist,
    lowConfidence: summary.lowConfidence,
    currentOpportunities: summary.currentOpportunities,
  };
}

function validSourceHealthIssue(issue) {
  return isRecord(issue)
    && isNonemptyString(issue.sourceId)
    && (issue.affectsHealth === undefined || typeof issue.affectsHealth === 'boolean')
    && (issue.sourceUnavailable === undefined || typeof issue.sourceUnavailable === 'boolean')
    && (issue.title === undefined || typeof issue.title === 'string')
    && (issue.message === undefined || typeof issue.message === 'string')
    && (issue.error === undefined || typeof issue.error === 'string')
    && (issue.checkedAt === undefined || typeof issue.checkedAt === 'string');
}

function validSourceHealthSource(source) {
  return isRecord(source)
    && isNonemptyString(source.id)
    && typeof source.name === 'string'
    && typeof source.required === 'boolean'
    && ['required-primary', 'optional-supplemental'].includes(source.sourceRole)
    && typeof source.fetched === 'boolean'
    && isNonnegativeInteger(source.rowCount);
}

function validSourceHealth(sourceHealth) {
  if (!isRecord(sourceHealth)
    || typeof sourceHealth.healthy !== 'boolean'
    || !safeTimestamp(sourceHealth.generatedAt)
    || !Array.isArray(sourceHealth.issues)
    || !Array.isArray(sourceHealth.sources)
    || !sourceHealth.issues.every(validSourceHealthIssue)
    || !sourceHealth.sources.every(validSourceHealthSource)) {
    return false;
  }

  const blockingIssues = sourceHealth.issues.filter((issue) => issue.affectsHealth !== false);
  if (sourceHealth.healthy) {
    const requiredSources = sourceHealth.sources.filter((source) => (
      source.required === true && source.sourceRole === 'required-primary'
    ));
    return blockingIssues.length === 0
      && requiredSources.length > 0
      && requiredSources.every((source) => source.fetched === true && source.rowCount > 0);
  }
  return blockingIssues.length > 0;
}

function validSummary(summary, rowCount) {
  if (!isRecord(summary)
    || !SUMMARY_FIELDS.every((field) => (
      Object.hasOwn(summary, field) && isNonnegativeInteger(summary[field])
    ))) {
    return false;
  }
  return summary.needsReview >= rowCount
    && summary.currentOpportunities >= summary.needsReview
    && summary.highPriority <= summary.currentOpportunities
    && summary.watchlist <= summary.currentOpportunities
    && summary.lowConfidence <= summary.currentOpportunities;
}

function validOpportunityRow(row) {
  return isRecord(row)
    && isNonemptyString(row.opportunityId)
    && isNonemptyString(row.name)
    && typeof row.state === 'string'
    && typeof row.fitScore === 'number'
    && Number.isFinite(row.fitScore)
    && isNonemptyString(row.scoreStatus)
    && isNonemptyString(row.confidence)
    && isNonemptyString(row.operatorPriority)
    && typeof row.reviewed === 'boolean'
    && typeof row.changedSinceReview === 'boolean'
    && typeof row.topStrength === 'string'
    && typeof row.topConcern === 'string'
    && isRecord(row.workflow)
    && isNonemptyString(row.workflow.crmStatus)
    && isNonemptyString(row.workflow.cimStatus)
    && typeof row.observationFreshness === 'string';
}

function validQueue(queue) {
  if (!isRecord(queue) || queue.ok !== true || !Array.isArray(queue.rows)) return false;
  const selectedRows = queue.rows.slice(0, DAILY_DEAL_HUNTER_TOP_LIMIT);
  return validSummary(queue.summary, queue.rows.length)
    && selectedRows.every(validOpportunityRow);
}

function classifyIssue(issue = {}, fallback = 'source-unhealthy') {
  if (Object.hasOwn(ISSUE_PRESENTATION, issue.classification)) return issue.classification;
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

function trustedSourceIdentity(issue = {}) {
  const sourceId = typeof issue.sourceId === 'string' ? normalizeText(issue.sourceId, 160) : '';
  const sheetMatch = sourceId.match(/^sheet-(\d+)$/);
  if (sheetMatch) {
    const sheetNumber = Number(sheetMatch[1]);
    return {
      sourceId,
      sourceName: sheetNumber === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${sheetNumber + 1}`,
    };
  }
  if (/^google-sheet-\d+$/.test(sourceId)) {
    return { sourceId, sourceName: 'Required Google Sheet' };
  }
  const known = {
    'deal-os-export': 'SMB Deal OS export',
    'source-health': 'Deal Hunter source health',
    'source-health-cache': 'Deal Hunter source health',
    'deal-hunter-review': 'Deal Hunter source health',
    'daily-update-window': 'Deal Hunter source health',
    'score-refresh': 'Opportunity score authority',
    'acquisition-inbox': 'Acquisition Inbox',
    'acquisition-authority': 'Acquisition authority',
  };
  return Object.hasOwn(known, sourceId)
    ? { sourceId, sourceName: known[sourceId] }
    : { sourceId: 'acquisition-authority', sourceName: 'Acquisition authority' };
}

function projectedIssue(issue = {}, fallback = 'source-unhealthy') {
  const classification = classifyIssue(issue, fallback);
  const presentation = ISSUE_PRESENTATION[classification] || ISSUE_PRESENTATION['source-unhealthy'];
  const source = trustedSourceIdentity(issue);
  return {
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    classification,
    title: presentation.title,
    message: presentation.message,
    checkedAt: safeTimestamp(issue.checkedAt),
  };
}

function sourceAuthority({ sourceHealth, scoreRefresh, queue }) {
  const sourceHealthIsAuthoritative = validSourceHealth(sourceHealth);
  const issues = sourceHealthIsAuthoritative ? sourceHealth.issues : [];
  const blockingIssues = issues
    .filter((issue) => issue?.affectsHealth !== false)
    .map((issue) => projectedIssue(issue));
  const optionalWarnings = issues
    .filter((issue) => issue?.affectsHealth === false)
    .map((issue) => projectedIssue(issue, 'optional-source-unavailable'))
    .slice(0, MAX_OPTIONAL_WARNINGS);

  if (!sourceHealthIsAuthoritative) {
    blockingIssues.push(projectedIssue({
      sourceId: 'source-health',
      classification: 'authority-invalid',
      checkedAt: sourceHealth?.generatedAt,
    }, 'authority-invalid'));
  } else if (sourceHealth.healthy !== true) {
    if (blockingIssues.length === 0) {
      blockingIssues.push(projectedIssue({
        sourceId: 'source-health',
        title: 'Required source health is unavailable',
        message: 'Current required-source health could not be established.',
        sourceUnavailable: true,
        checkedAt: sourceHealth?.generatedAt,
        classification: 'unavailable',
      }, 'unavailable'));
    }
  }

  if (scoreRefresh?.ok !== true) {
    blockingIssues.push(projectedIssue({
      sourceId: 'score-refresh',
      title: 'Authoritative score refresh failed',
      message: scoreRefresh?.error || 'Current score and eligibility authority could not be established.',
      checkedAt: sourceHealth?.generatedAt,
      classification: 'scoring-refresh-failed',
    }, 'scoring-refresh-failed'));
  }

  const queueIsAuthoritative = validQueue(queue);
  if (!queueIsAuthoritative) {
    blockingIssues.push(projectedIssue({
      sourceId: 'acquisition-inbox',
      title: 'Acquisition Inbox authority is unavailable',
      message: queue?.error || 'The current Acquisition Inbox could not be read.',
      checkedAt: sourceHealth?.generatedAt,
      classification: 'queue-unavailable',
    }, 'queue-unavailable'));
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
    name: safeDisplayText(row.name, 160),
    state: safeDisplayText(row.state, 20),
    fitScore: row.fitScore,
    scoreStatus: safeDisplayText(row.scoreStatus, 40),
    confidence: safeDisplayText(row.confidence, 20),
    operatorPriority: safeDisplayText(row.operatorPriority, 40),
    reviewed: row.reviewed,
    changedSinceReview: row.changedSinceReview,
    topStrength: safeDisplayText(row.topStrength, 400),
    topConcern: safeDisplayText(row.topConcern, 400),
    workflow: {
      crmStatus: safeDisplayText(row.workflow.crmStatus, 80),
      cimStatus: safeDisplayText(row.workflow.cimStatus, 80),
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

function unavailableSourceHealth(generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    healthy: false,
    sources: [],
    issues: [{
      sourceId: 'source-health',
      affectsHealth: true,
      sourceUnavailable: true,
      title: 'Required source health is unavailable',
      message: 'Current required-source health could not be established.',
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
  } catch {
    scoreRefresh = { ok: false, status: 503, error: 'Authoritative score refresh failed.' };
  }

  let sourceHealth;
  if (scoreRefresh?.review && typeof scoreRefresh.review === 'object') {
    try {
      sourceHealth = await readSourceHealth(storage, { persistSnapshot: true, review: scoreRefresh.review });
    } catch {
      sourceHealth = unavailableSourceHealth(scoreRefresh.review.generatedAt);
    }
  } else {
    sourceHealth = unavailableSourceHealth();
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
  } catch {
    queue = { ok: false, status: 503, error: 'The current Acquisition Inbox could not be read.' };
  }

  return projectDailyDealHunterDigest({
    businessDate,
    generatedAt: sourceHealth.generatedAt || scoreRefresh.review.generatedAt,
    sourceHealth,
    scoreRefresh,
    queue,
  });
}
