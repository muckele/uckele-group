import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getSourceHealth } from './acquisitionCommandCenter.js';
import { refreshOpportunityScores } from './dealHunterScoreStore.js';
import { listTriageQueue } from './dealHunterTriage.js';

export const DAILY_DEAL_HUNTER_DIGEST_VERSION = 'daily-deal-hunter-digest-v1';
export const DAILY_DEAL_HUNTER_TOP_LIMIT = 5;
export const DAILY_DEAL_HUNTER_EMAIL_VERSION = 'daily-deal-hunter-email-v1';

const MAX_BLOCKING_ISSUES = 3;
const MAX_OPTIONAL_WARNINGS = 1;
const TRIAGE_MISSING_NAME = 'Unnamed opportunity';
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

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return '';

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59) {
    return '';
  }
  if (timezone !== 'Z') {
    const timezoneHour = Number(timezone.slice(1, 3));
    const timezoneMinute = Number(timezone.slice(4, 6));
    if (timezoneHour > 23 || timezoneMinute > 59) return '';
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
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
    || !normalizeIsoTimestamp(sourceHealth.generatedAt)
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
    && row.name !== TRIAGE_MISSING_NAME
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
    && typeof row.observationFreshness === 'string'
    && (row.observationFreshness === '' || Boolean(normalizeIsoTimestamp(row.observationFreshness)));
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
    checkedAt: normalizeIsoTimestamp(issue.checkedAt),
  };
}

function sourceAuthority({ generatedAt, sourceHealth, scoreRefresh, queue }) {
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

  if (!generatedAt) {
    blockingIssues.push(projectedIssue({
      sourceId: 'acquisition-authority',
      classification: 'authority-invalid',
    }, 'authority-invalid'));
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
    observationFreshness: normalizeIsoTimestamp(row.observationFreshness),
  };
}

function projectedJob(job = {}, notificationType = '') {
  return {
    status: safeDisplayText(job.status, 40),
    attemptCount: boundedCount(job.attemptCount),
    completedAt: normalizeIsoTimestamp(job.completedAt),
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

function envelopeEmail(value = '', { optional = false } = {}) {
  const normalized = normalizeText(value, 320);
  if (!normalized && optional) return '';
  const plain = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(normalized);
  const display = /^[^<>\r\n,]{1,160}<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(normalized);
  if (!plain && !display) {
    throw new TypeError('Daily Deal Hunter email authority requires a valid server-owned email address.');
  }
  return normalized;
}

function safeEmailUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function emailHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function emailLink(label, href) {
  const safeHref = safeEmailUrl(href);
  return safeHref
    ? `<a href="${emailHtml(safeHref)}" style="color:#284638;font-weight:700;">${emailHtml(label)}</a>`
    : '';
}

function normalDigestText(projection) {
  const summary = projection.summary || {};
  const lines = [
    'Daily Deal Hunter',
    '',
    `Pacific business date: ${projection.businessDate}`,
    `Generated: ${projection.generatedAt || 'Unavailable'}`,
    '',
    `Needs review: ${boundedCount(summary.needsReview)}`,
    `High priority: ${boundedCount(summary.highPriority)}`,
    `Watchlist: ${boundedCount(summary.watchlist)}`,
    `Low confidence: ${boundedCount(summary.lowConfidence)}`,
    `Current opportunities: ${boundedCount(summary.currentOpportunities)}`,
  ];

  const warnings = projection.sourceAuthority?.optionalWarnings || [];
  if (warnings.length > 0) {
    lines.push('', 'Optional source warning:');
    for (const warning of warnings.slice(0, MAX_OPTIONAL_WARNINGS)) {
      lines.push(`- ${safeDisplayText(warning.sourceName, 160)}: ${safeDisplayText(warning.message, 400)}`);
    }
  }

  lines.push('', 'Top opportunities:');
  for (const [index, opportunity] of (projection.topOpportunities || []).slice(0, DAILY_DEAL_HUNTER_TOP_LIMIT).entries()) {
    lines.push(
      `${index + 1}. ${safeDisplayText(opportunity.name, 160)}`,
      `   State: ${safeDisplayText(opportunity.state, 20) || 'Unavailable'}`,
      `   Fit: ${Number.isFinite(opportunity.fitScore) ? opportunity.fitScore : 0} · ${safeDisplayText(opportunity.scoreStatus, 40)} · ${safeDisplayText(opportunity.confidence, 20)}`,
      `   Operator priority: ${safeDisplayText(opportunity.operatorPriority, 40)}`,
      `   Review signal: ${opportunity.changedSinceReview ? 'changed since review' : opportunity.reviewed ? 'reviewed' : 'not reviewed'}`,
      `   Strength: ${safeDisplayText(opportunity.topStrength, 400) || 'None recorded'}`,
      `   Concern: ${safeDisplayText(opportunity.topConcern, 400) || 'None recorded'}`,
      `   Workflow: CRM ${safeDisplayText(opportunity.workflow?.crmStatus, 80)} · CIM ${safeDisplayText(opportunity.workflow?.cimStatus, 80)}`,
      `   Observation freshness: ${normalizeIsoTimestamp(opportunity.observationFreshness) || 'Unavailable'}`,
    );
  }
  lines.push(
    '',
    `Open Acquisition Inbox: ${safeEmailUrl(projection.links?.inbox)}`,
    `Open Operations: ${safeEmailUrl(projection.links?.operations)}`,
  );
  return lines.join('\n').slice(0, 32 * 1024);
}

function alertDigestText(projection) {
  const lines = [
    'ACTION REQUIRED — Deal Hunter source health',
    '',
    `Pacific business date: ${projection.businessDate}`,
    `Checked: ${projection.generatedAt || 'Unavailable'}`,
    'The normal digest was not prepared because current required acquisition authority could not be established.',
    'No CRM synchronization, CIM request, broker email, follow-up, or Stage 2 execution occurred.',
    '',
    'Required source issues:',
  ];
  for (const issue of (projection.sourceAuthority?.blockingIssues || []).slice(0, MAX_BLOCKING_ISSUES)) {
    lines.push(
      `- ${safeDisplayText(issue.sourceName, 160)} — ${safeDisplayText(issue.title, 200)}: ${safeDisplayText(issue.message, 400)}`,
    );
  }
  lines.push('', `Open Operations: ${safeEmailUrl(projection.links?.operations)}`);
  return lines.join('\n').slice(0, 16 * 1024);
}

function normalDigestHtml(projection) {
  const summary = projection.summary || {};
  const rows = (projection.topOpportunities || []).slice(0, DAILY_DEAL_HUNTER_TOP_LIMIT).map((opportunity, index) => `
    <section style="border-top:1px solid #E3D9CA;padding:16px 0;">
      <h2 style="margin:0 0 8px;font-size:18px;">${index + 1}. ${emailHtml(safeDisplayText(opportunity.name, 160))}</h2>
      <p style="margin:0 0 6px;">${emailHtml(safeDisplayText(opportunity.state, 20) || 'State unavailable')} · Fit ${emailHtml(Number.isFinite(opportunity.fitScore) ? opportunity.fitScore : 0)} · ${emailHtml(safeDisplayText(opportunity.confidence, 20))}</p>
      <p style="margin:0 0 6px;"><strong>Priority:</strong> ${emailHtml(safeDisplayText(opportunity.operatorPriority, 40))} · <strong>Score:</strong> ${emailHtml(safeDisplayText(opportunity.scoreStatus, 40))}</p>
      <p style="margin:0 0 6px;"><strong>Review:</strong> ${opportunity.changedSinceReview ? 'Changed since review' : opportunity.reviewed ? 'Reviewed' : 'Not reviewed'}</p>
      <p style="margin:0 0 6px;"><strong>Strength:</strong> ${emailHtml(safeDisplayText(opportunity.topStrength, 400) || 'None recorded')}</p>
      <p style="margin:0 0 6px;"><strong>Concern:</strong> ${emailHtml(safeDisplayText(opportunity.topConcern, 400) || 'None recorded')}</p>
      <p style="margin:0;"><strong>Workflow:</strong> CRM ${emailHtml(safeDisplayText(opportunity.workflow?.crmStatus, 80))} · CIM ${emailHtml(safeDisplayText(opportunity.workflow?.cimStatus, 80))}</p>
    </section>
  `).join('');
  const warnings = (projection.sourceAuthority?.optionalWarnings || []).slice(0, MAX_OPTIONAL_WARNINGS).map((warning) => (
    `<li>${emailHtml(safeDisplayText(warning.sourceName, 160))}: ${emailHtml(safeDisplayText(warning.message, 400))}</li>`
  )).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Daily Deal Hunter</title></head><body style="margin:0;background:#F8F4ED;color:#18211D;font-family:Arial,sans-serif;"><main style="max-width:680px;margin:0 auto;padding:32px 20px;"><h1>Daily Deal Hunter</h1><p><strong>Pacific business date:</strong> ${emailHtml(projection.businessDate)}</p><p>Needs review: ${boundedCount(summary.needsReview)} · High priority: ${boundedCount(summary.highPriority)} · Watchlist: ${boundedCount(summary.watchlist)} · Low confidence: ${boundedCount(summary.lowConfidence)} · Current: ${boundedCount(summary.currentOpportunities)}</p>${warnings ? `<aside><strong>Optional source warning</strong><ul>${warnings}</ul></aside>` : ''}${rows}<p>${emailLink('Open Acquisition Inbox', projection.links?.inbox)} · ${emailLink('Open Operations', projection.links?.operations)}</p></main></body></html>`.slice(0, 96 * 1024);
}

function alertDigestHtml(projection) {
  const issues = (projection.sourceAuthority?.blockingIssues || []).slice(0, MAX_BLOCKING_ISSUES).map((issue) => (
    `<li><strong>${emailHtml(safeDisplayText(issue.sourceName, 160))}</strong> — ${emailHtml(safeDisplayText(issue.title, 200))}: ${emailHtml(safeDisplayText(issue.message, 400))}</li>`
  )).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Deal Hunter source health</title></head><body style="margin:0;background:#FEF2F2;color:#7F1D1D;font-family:Arial,sans-serif;"><main style="max-width:680px;margin:0 auto;padding:32px 20px;"><h1>ACTION REQUIRED — Deal Hunter source health</h1><p><strong>Pacific business date:</strong> ${emailHtml(projection.businessDate)}</p><p>The normal digest was not prepared because current required acquisition authority could not be established.</p><ul>${issues}</ul><p>No CRM synchronization, CIM request, broker email, follow-up, or Stage 2 execution occurred.</p><p>${emailLink('Open Operations', projection.links?.operations)}</p></main></body></html>`.slice(0, 64 * 1024);
}

function digestableEnvelope(envelope) {
  return {
    version: envelope.version,
    kind: envelope.kind,
    provider: envelope.provider,
    businessDate: envelope.businessDate,
    notificationType: envelope.notificationType,
    to: envelope.to,
    from: envelope.from,
    replyTo: envelope.replyTo,
    subject: envelope.subject,
    text: envelope.text,
    html: envelope.html,
    idempotencyKey: envelope.idempotencyKey,
    tags: (envelope.tags || []).filter((tag) => tag.name !== 'payload_digest'),
    preparedAt: envelope.preparedAt,
    links: envelope.links,
  };
}

function envelopeDigest(envelope) {
  return createHash('sha256').update(JSON.stringify(digestableEnvelope(envelope))).digest('hex');
}

export function buildDailyDealHunterEmailEnvelope({
  projection,
  recipient,
  sender,
  replyTo = '',
  preparedAt = '',
} = {}) {
  if (!isRecord(projection) || !/^\d{4}-\d{2}-\d{2}$/.test(String(projection.businessDate || ''))
    || !['normal-digest', 'required-source-alert'].includes(projection.notificationType)) {
    throw new TypeError('Daily Deal Hunter email requires an authoritative bounded projection.');
  }
  const businessDate = projection.businessDate;
  const notificationType = projection.notificationType;
  const idempotencyKey = `daily-deal-hunter-email:${businessDate}`;
  const envelope = {
    version: DAILY_DEAL_HUNTER_EMAIL_VERSION,
    kind: 'daily-deal-hunter',
    provider: 'resend',
    businessDate,
    notificationType,
    to: envelopeEmail(recipient),
    from: envelopeEmail(sender),
    replyTo: envelopeEmail(replyTo, { optional: true }),
    subject: notificationType === 'required-source-alert'
      ? `ACTION REQUIRED — Deal Hunter source health — ${businessDate}`
      : `Daily Deal Hunter — ${boundedCount(projection.summary?.needsReview)} to review — ${businessDate}`,
    text: notificationType === 'required-source-alert' ? alertDigestText(projection) : normalDigestText(projection),
    html: notificationType === 'required-source-alert' ? alertDigestHtml(projection) : normalDigestHtml(projection),
    idempotencyKey,
    tags: [
      { name: 'source', value: 'daily-deal-hunter' },
      { name: 'business_date', value: businessDate },
      { name: 'notification', value: notificationType },
    ],
    preparedAt: normalizeIsoTimestamp(preparedAt) || projection.generatedAt || new Date().toISOString(),
    links: {
      inbox: safeEmailUrl(projection.links?.inbox),
      operations: safeEmailUrl(projection.links?.operations),
    },
  };
  const payloadDigest = envelopeDigest(envelope);
  return Object.freeze({
    ...envelope,
    tags: Object.freeze([...envelope.tags, { name: 'payload_digest', value: payloadDigest }].map(Object.freeze)),
    links: Object.freeze({ ...envelope.links }),
    payloadDigest,
  });
}

export function verifyDailyDealHunterEmailEnvelope(envelope = {}) {
  try {
    if (!isRecord(envelope)
      || envelope.version !== DAILY_DEAL_HUNTER_EMAIL_VERSION
      || envelope.kind !== 'daily-deal-hunter'
      || envelope.provider !== 'resend'
      || envelope.idempotencyKey !== `daily-deal-hunter-email:${envelope.businessDate}`
      || !['normal-digest', 'required-source-alert'].includes(envelope.notificationType)
      || !Array.isArray(envelope.tags)
      || envelopeEmail(envelope.to) !== envelope.to
      || envelopeEmail(envelope.from) !== envelope.from
      || envelopeEmail(envelope.replyTo, { optional: true }) !== envelope.replyTo) {
      return { ok: false, errorCategory: 'invalid-prepared-envelope' };
    }
    const requiredTags = new Map(envelope.tags.map((tag) => [tag?.name, tag?.value]));
    const expectedDigest = envelopeDigest(envelope);
    const valid = requiredTags.get('source') === 'daily-deal-hunter'
      && requiredTags.get('business_date') === envelope.businessDate
      && requiredTags.get('notification') === envelope.notificationType
      && requiredTags.get('payload_digest') === envelope.payloadDigest
      && envelope.payloadDigest === expectedDigest;
    return valid
      ? { ok: true, payloadDigest: expectedDigest }
      : { ok: false, errorCategory: 'prepared-envelope-digest-mismatch' };
  } catch {
    return { ok: false, errorCategory: 'invalid-prepared-envelope' };
  }
}

export function projectDailyDealHunterDigest({
  businessDate,
  generatedAt,
  sourceHealth,
  scoreRefresh,
  queue,
  job,
} = {}) {
  const normalizedGeneratedAt = normalizeIsoTimestamp(generatedAt);
  const authority = sourceAuthority({
    generatedAt: normalizedGeneratedAt,
    sourceHealth,
    scoreRefresh,
    queue,
  });
  const alert = !authority.requiredHealthy;
  const notificationType = alert ? 'required-source-alert' : 'normal-digest';

  return {
    version: DAILY_DEAL_HUNTER_DIGEST_VERSION,
    businessDate: safeDisplayText(businessDate, 20),
    generatedAt: normalizedGeneratedAt,
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
      generatedAt: scoreRefresh?.review?.generatedAt ?? sourceHealth?.generatedAt,
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
    generatedAt: scoreRefresh.review.generatedAt ?? sourceHealth.generatedAt,
    sourceHealth,
    scoreRefresh,
    queue,
  });
}
