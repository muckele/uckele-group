import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp } from '../utils/http.js';
import { hashIp } from '../utils/security.js';
import { forwardToCrm } from './crmForwarder.js';
import { deliverSubmission } from './delivery.js';
import { summarizeEmailEngagement } from './emailEvents.js';
import { evaluateSubmissionSpam } from './spamProtection.js';
import { verifyTurnstileToken } from './turnstile.js';
import {
  buildFollowUpPrompt,
  deriveWorkflowDefaults,
  normalizeFollowUpState,
  normalizeLeadType,
  normalizePriority,
  normalizeSbaEligibility,
} from './workflow.js';
import { resolveSecureStoragePath } from './documentVault.js';
import { commitCrmActivityMutation, summarizeSubmissionChanges } from './activity.js';
import { normalizeAttribution } from './analytics.js';
import {
  isSecureDocumentCleanupIntentActive,
  listSecureDocumentCleanupSidecars,
  persistSecureDocumentCleanupJob,
  removeSecureDocumentCleanupSidecar,
  secureDocumentCleanupSettlementMs,
  updateSecureDocumentCleanupJobState,
} from './secureDocumentCleanupState.js';

const allowedStatuses = ['new', 'review', 'contacted', 'archived', 'spam'];
const turnstileTokenMaxLength = 2048;
const cleanupWriteAheadGraceMs = secureDocumentCleanupSettlementMs;
const cleanupLeaseMs = secureDocumentCleanupSettlementMs;
let activeCleanupReconciliation = null;

class CleanupLeaseLostError extends Error {
  constructor() {
    super('Secure-document cleanup lease expired or was reclaimed.');
    this.name = 'CleanupLeaseLostError';
  }
}
const diligenceStages = [
  'not-started',
  'cim-requested',
  'nda-sent',
  'cim-received',
  'financial-review',
  'lender-review',
  'loi-candidate',
  'passed',
];
const diligenceDecisions = ['undecided', 'advance', 'pause', 'pass'];
const diligenceChecklistIds = [
  'cim',
  'nda',
  'p_and_l',
  'tax_returns',
  'balance_sheet',
  'customer_concentration',
  'payroll',
  'lease',
  'contracts',
  'equipment',
  'owner_role',
  'management_depth',
  'sba_fit',
];
const enrichmentLookupBatchSize = 250;

const dealFieldNormalizers = {
  company: (value) => normalizeField(value, 160),
  role: (value) => normalizeField(value, 80),
  listing_url: (value) => normalizeCrmUrl(value, 500),
  business_website: (value) => normalizeCrmUrl(value, 500),
  prospectus_url: (value) => normalizeCrmUrl(value, 500),
  asking_price: (value) => normalizeField(value, 80),
  ttm_revenue: (value) => normalizeField(value, 80),
  ttm_ebitda: (value) => normalizeField(value, 80),
  ebitda_multiple: (value) => normalizeField(value, 40),
  net_margin: (value) => normalizeField(value, 40),
  business_age: (value) => normalizeField(value, 80),
  sba_eligible: (value) => normalizeSbaEligibility(value, 'unknown'),
  broker_name: (value) => normalizeField(value, 120),
  broker_email: (value) => normalizeEmail(value, 200),
  broker_phone: (value) => normalizeField(value, 40),
  seller_name: (value) => normalizeField(value, 120),
  seller_email: (value) => normalizeEmail(value, 200),
  seller_phone: (value) => normalizeField(value, 40),
  lead_type: (value) => normalizeLeadType(value, 'seller'),
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeField(value, maxLength = 5000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeCrmUrl(value, maxLength = 500) {
  const normalized = normalizeField(value, maxLength);

  if (!normalized) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:/i.test(normalized) ? normalized : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeEmail(value, maxLength = 200) {
  return normalizeField(value, maxLength).toLowerCase();
}

function normalizeMessage(value, maxLength = 5000) {
  return String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .slice(0, maxLength);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeField(item, 60).toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
  }

  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeAllowedOption(value, allowedValues, fallback) {
  const normalized = normalizeField(value, 60).toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function normalizeDiligenceFinancing(raw = {}, fallback = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const existing = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};

  return {
    estimated_down_payment: normalizeField(
      hasOwn(source, 'estimated_down_payment') ? source.estimated_down_payment : existing.estimated_down_payment,
      120,
    ),
    seller_note: normalizeField(hasOwn(source, 'seller_note') ? source.seller_note : existing.seller_note, 120),
    investor_gap: normalizeField(hasOwn(source, 'investor_gap') ? source.investor_gap : existing.investor_gap, 120),
    sba_lender_status: normalizeField(
      hasOwn(source, 'sba_lender_status') ? source.sba_lender_status : existing.sba_lender_status,
      200,
    ),
  };
}

export function normalizeDiligenceReview(raw = {}, fallback = {}, options = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const existing = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const existingStage = normalizeAllowedOption(existing.stage, diligenceStages, 'not-started');
  const existingDecision = normalizeAllowedOption(existing.decision, diligenceDecisions, 'undecided');
  const sourceChecklist = source.checklist && typeof source.checklist === 'object' && !Array.isArray(source.checklist) ? source.checklist : {};
  const existingChecklist =
    existing.checklist && typeof existing.checklist === 'object' && !Array.isArray(existing.checklist) ? existing.checklist : {};
  const checklist = diligenceChecklistIds.reduce((accumulator, key) => {
    accumulator[key] = Boolean(hasOwn(sourceChecklist, key) ? sourceChecklist[key] : existingChecklist[key]);
    return accumulator;
  }, {});

  return {
    stage: normalizeAllowedOption(source.stage, diligenceStages, existingStage),
    decision: normalizeAllowedOption(source.decision, diligenceDecisions, existingDecision),
    checklist,
    financing: normalizeDiligenceFinancing(source.financing, existing.financing),
    questions: normalizeMessage(hasOwn(source, 'questions') ? source.questions : existing.questions, 3000),
    memo: normalizeMessage(hasOwn(source, 'memo') ? source.memo : existing.memo, 3000),
    updated_at: normalizeField(options.now || existing.updated_at, 80),
  };
}

function comparableDiligenceReview(value) {
  const normalized = normalizeDiligenceReview(value);
  const { updated_at: _updatedAt, ...comparable } = normalized;
  return comparable;
}

export function diligenceReviewsEqual(left, right) {
  return JSON.stringify(comparableDiligenceReview(left)) === JSON.stringify(comparableDiligenceReview(right));
}

function normalizeStatus(value, fallback = 'new') {
  const normalized = normalizeField(value, 40).toLowerCase();
  return allowedStatuses.includes(normalized) ? normalized : fallback;
}

function resultFromSettled(settledResult, fallbackPrefix) {
  if (settledResult.status === 'fulfilled') {
    return settledResult.value;
  }

  return {
    status: 'failed',
    error: `${fallbackPrefix}: ${settledResult.reason?.message || 'Unknown error'}`,
  };
}

function nextVersionTimestamp(previousValue = '') {
  const generated = new Date().toISOString();
  const previousTimestamp = Date.parse(previousValue);
  return Number.isFinite(previousTimestamp) && Date.parse(generated) <= previousTimestamp
    ? new Date(previousTimestamp + 1).toISOString()
    : generated;
}

function routingOutcomeMatches(record, updates) {
  return Boolean(record) && [
    'delivery_status',
    'delivery_error',
    'crm_status',
    'crm_error',
    'status',
  ].every((field) => (record[field] || '') === (updates[field] || ''));
}

async function persistSubmissionRoutingOutcome({ storage, submission, deliveryResult, crmResult, isSpam }) {
  const routingKey = `contact-submission:${submission.id}`;
  const deliveryStatus = normalizeField(deliveryResult?.status, 80) || 'failed';
  const deliveryError = normalizeMessage(deliveryResult?.error, 2000);
  const crmStatus = normalizeField(crmResult?.status, 80) || 'failed';
  const crmError = normalizeMessage(crmResult?.error, 2000);
  const outcome = {
    delivery_status: deliveryStatus,
    delivery_error: deliveryError,
    crm_status: crmStatus,
    crm_error: crmError,
    status: isSpam ? 'spam' : 'new',
  };
  let current = submission;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updates = { ...outcome, updated_at: nextVersionTimestamp(current.updated_at) };
    const changes = summarizeSubmissionChanges(current, updates);

    try {
      const mutation = await commitCrmActivityMutation({
        storage,
        operation: 'update_submission',
        payload: { id: submission.id, expectedUpdatedAt: current.updated_at, values: updates },
        activity: {
          submissionId: submission.id,
          eventType: 'submission.routing-updated',
          summary: `Inquiry routing completed: notification ${deliveryStatus}, CRM ${crmStatus}.`,
          actor: 'submission-router',
          role: 'system',
          metadata: {
            routingKey,
            deliveryStatus,
            crmStatus,
            changes,
            changedFields: changes.map((change) => change.field),
          },
        },
      });

      if (mutation.applied && mutation.record) {
        return mutation.record;
      }

      current = mutation.record || await storage.getSubmission(submission.id);
      if (routingOutcomeMatches(current, outcome)) {
        return current;
      }
    } catch (error) {
      lastError = error;
      current = await storage.getSubmission(submission.id).catch(() => current);
      if (routingOutcomeMatches(current, outcome)) {
        return current;
      }
    }
  }

  throw lastError || new Error(`Routing outcome ${routingKey} could not be persisted without overwriting a newer CRM version.`);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateOptionalEmail(email, label, errors) {
  if (email && !isValidEmail(email)) {
    errors.push(`${label} must be valid.`);
  }
}

function daysAgoFrom(timestamp, nowValue = Date.now()) {
  const dateValue = Date.parse(timestamp || '');

  if (!Number.isFinite(dateValue)) {
    return '';
  }

  const nowTimestamp = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  return Math.max(0, Math.floor((nowTimestamp - dateValue) / (1000 * 60 * 60 * 24)));
}

function submissionDateAdded(submission = {}) {
  const sourceDate = normalizeField(submission.metadata?.dealHunter?.dateAdded, 100);
  return Number.isFinite(Date.parse(sourceDate)) ? sourceDate : submission.created_at;
}

function normalizeDealFields(raw = {}) {
  return Object.entries(dealFieldNormalizers).reduce((accumulator, [key, normalizer]) => {
    accumulator[key] = normalizer(raw[key]);
    return accumulator;
  }, {});
}

function collectDealFieldUpdates(raw = {}) {
  return Object.entries(dealFieldNormalizers).reduce((accumulator, [key, normalizer]) => {
    if (hasOwn(raw, key)) {
      accumulator[key] = normalizer(raw[key]);
    }

    return accumulator;
  }, {});
}

function collectAliasedDealFieldUpdates(source = {}) {
  const raw = {};
  const aliasMap = {
    company: 'company',
    role: 'role',
    listing_url: 'listing_url',
    business_website: 'business_website',
    website: 'business_website',
    prospectus_url: 'prospectus_url',
    prospectus_cim: 'prospectus_url',
    asking_price: 'asking_price',
    ttm_revenue: 'ttm_revenue',
    ttm_ebitda: 'ttm_ebitda',
    ebitda_multiple: 'ebitda_multiple',
    net_margin: 'net_margin',
    business_age: 'business_age',
    age: 'business_age',
    sba_eligible: 'sba_eligible',
    broker_name: 'broker_name',
    broker_email: 'broker_email',
    broker_phone: 'broker_phone',
    broker_phone_number: 'broker_phone',
    seller_name: 'seller_name',
    seller_email: 'seller_email',
    seller_phone: 'seller_phone',
    seller_phone_number: 'seller_phone',
    lead_type: 'lead_type',
  };

  Object.entries(aliasMap).forEach(([sourceKey, targetKey]) => {
    if (hasOwn(source, sourceKey)) {
      raw[targetKey] = source[sourceKey];
    }
  });

  return collectDealFieldUpdates(raw);
}

function derivePrimaryContact(fields) {
  const leadType = normalizeLeadType(fields.lead_type, 'seller');
  const seller = {
    name: normalizeField(fields.seller_name, 120),
    email: normalizeEmail(fields.seller_email, 200),
    phone: normalizeField(fields.seller_phone, 40),
  };
  const broker = {
    name: normalizeField(fields.broker_name, 120),
    email: normalizeEmail(fields.broker_email, 200),
    phone: normalizeField(fields.broker_phone, 40),
  };
  const fallback = {
    name: normalizeField(fields.name, 120),
    email: normalizeEmail(fields.email, 200),
    phone: normalizeField(fields.phone, 40),
  };
  const preferBroker =
    leadType === 'broker' ||
    (!(seller.name || seller.email || seller.phone) && Boolean(broker.name || broker.email || broker.phone));
  const primary = preferBroker ? broker : seller;
  const secondary = preferBroker ? seller : broker;

  return {
    name: primary.name || secondary.name || fallback.name || normalizeField(fields.company, 120) || 'Unknown contact',
    email: primary.email || secondary.email || fallback.email,
    phone: primary.phone || secondary.phone || fallback.phone,
  };
}

function validateWebsiteSubmission(input) {
  const errors = [];

  if (!normalizeField(input.name, 120)) {
    errors.push('Name is required.');
  }

  if (!input.email) {
    errors.push('Email is required.');
  } else if (!isValidEmail(input.email)) {
    errors.push('Email must be valid.');
  }

  if (!normalizeMessage(input.message, 5000)) {
    errors.push('Message is required.');
  }

  return errors;
}

function validateManualSubmission(input) {
  const errors = [];

  if (!input.company && !input.seller_name && !input.broker_name) {
    errors.push('Add a company/business name or at least one broker or seller contact.');
  }

  validateOptionalEmail(input.broker_email, 'Broker email', errors);
  validateOptionalEmail(input.seller_email, 'Seller email', errors);

  return errors;
}

export function buildCsv(submissions) {
  const headers = [
    'Company/Business',
    'Date Added',
    'Status',
    'Last Edit (Status)',
    'Days Ago',
    'Listing URL',
    'Website',
    'Prospectus / CIM',
    'Asking Price',
    'TTM Revenue',
    'TTM EBITDA',
    'EBITDA Multiple',
    'Net Margin',
    'Age',
    'SBA Eligible?',
    'Broker Name',
    'Broker Email',
    'Broker Phone Number',
    'Seller Name',
    'Seller Email',
    'Seller Phone Number',
    'Deal Notes',
    'Lead Type',
    'Priority',
    'Assigned To',
    'Follow-Up State',
    'Next Action',
    'Email Engagement Score',
    'Last Email Event',
    'Email Follow-Up Signal',
    'Notification',
    'Follow-Up Prompt',
    'Source',
    'ID',
  ];

  const escapeCell = (value) => {
    let text = String(value ?? '');

    if (/^\s*[=+\-@]/.test(text)) {
      text = `'${text}`;
    }

    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [
    headers.join(','),
    ...submissions.map((submission) => {
      const followUpPrompt = submission.follow_up_prompt || buildFollowUpPrompt(submission);
      const dateAdded = submissionDateAdded(submission);

      return [
        submission.company,
        dateAdded,
        submission.status,
        submission.status_updated_at || submission.updated_at,
        submission.days_since_added ?? daysAgoFrom(dateAdded),
        submission.listing_url,
        submission.business_website,
        submission.prospectus_url,
        submission.asking_price,
        submission.ttm_revenue,
        submission.ttm_ebitda,
        submission.ebitda_multiple,
        submission.net_margin,
        submission.business_age,
        submission.sba_eligible,
        submission.broker_name,
        submission.broker_email,
        submission.broker_phone,
        submission.seller_name,
        submission.seller_email,
        submission.seller_phone,
        submission.notes || submission.message,
        submission.lead_type,
        submission.priority,
        submission.assigned_to,
        submission.follow_up_state,
        submission.next_action_at,
        submission.email_engagement?.score ?? 0,
        submission.email_engagement?.last_event_at || '',
        submission.email_engagement?.action || '',
        followUpPrompt?.title || '',
        followUpPrompt?.prompt || '',
        submission.source,
        submission.id,
      ]
        .map(escapeCell)
        .join(',');
    }),
  ];

  return lines.join('\n');
}

function collectContactEmails(submission) {
  return [submission.email, submission.broker_email, submission.seller_email]
    .map((value) => normalizeEmail(value, 200))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function dedupeEmailEvents(events) {
  const seen = new Set();

  return events.filter((event) => {
    const key = event.id || `${event.message_id || ''}:${event.event_type || ''}:${event.created_at || ''}:${event.recipient_email || ''}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function groupBy(items, keyGetter) {
  return items.reduce((accumulator, item) => {
    const key = keyGetter(item);

    if (!key) {
      return accumulator;
    }

    if (!accumulator.has(key)) {
      accumulator.set(key, []);
    }

    accumulator.get(key).push(item);
    return accumulator;
  }, new Map());
}

function firstBy(items, keyGetter) {
  return items.reduce((accumulator, item) => {
    const key = keyGetter(item);

    if (key && !accumulator.has(key)) {
      accumulator.set(key, item);
    }

    return accumulator;
  }, new Map());
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function chunkValues(values = [], size = enrichmentLookupBatchSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function listInBatches(values, listFn) {
  const unique = uniqueValues(values);

  if (unique.length === 0) {
    return [];
  }

  const results = [];

  for (const chunk of chunkValues(unique)) {
    results.push(...(await listFn(chunk)));
  }

  return results;
}

function enrichSubmissionWithRelatedData(
  submission,
  { uploadRequest = null, documents = [], emailEvents = [] } = {},
  nowValue = new Date(),
) {
  const emailEngagement = summarizeEmailEngagement(dedupeEmailEvents(emailEvents));
  const dateAdded = submissionDateAdded(submission);
  const enriched = {
    ...submission,
    latest_upload_request: uploadRequest,
    secure_documents: documents,
    email_engagement: emailEngagement,
    status_updated_at: submission.status_updated_at || submission.updated_at,
    days_since_added: daysAgoFrom(dateAdded, nowValue),
  };

  return {
    ...enriched,
    follow_up_prompt: buildFollowUpPrompt(enriched, nowValue),
  };
}

async function enrichSubmission(submission, storage, nowValue = new Date()) {
  const contactEmails = collectContactEmails(submission);
  const emailEventQueries = storage.listEmailEvents
    ? [
        storage.listEmailEvents({ submissionId: submission.id, limit: 100 }),
        ...contactEmails.map((recipientEmail) => storage.listEmailEvents({ recipientEmail, limit: 100 })),
      ]
    : [];
  const [uploadRequest, documents, ...emailEventResults] = await Promise.all([
    storage.getLatestSecureUploadRequestForSubmission(submission.id),
    storage.listSecureDocumentsForSubmission(submission.id),
    ...emailEventQueries,
  ]);

  return enrichSubmissionWithRelatedData(
    submission,
    {
      uploadRequest,
      documents,
      emailEvents: emailEventResults.flat(),
    },
    nowValue,
  );
}

async function enrichSubmissions(submissions, storage, nowValue = new Date()) {
  if (submissions.length === 0) {
    return [];
  }

  if (
    !storage.listLatestSecureUploadRequestsForSubmissions ||
    !storage.listSecureDocumentsForSubmissions ||
    !storage.listEmailEventsForSubmissions ||
    !storage.listEmailEventsForRecipients
  ) {
    return Promise.all(submissions.map((submission) => enrichSubmission(submission, storage, nowValue)));
  }

  const submissionIds = submissions.map((submission) => submission.id);
  const contactEmails = submissions.flatMap(collectContactEmails);
  const [uploadRequests, documents, submissionEmailEvents, recipientEmailEvents] = await Promise.all([
    listInBatches(submissionIds, (ids) => storage.listLatestSecureUploadRequestsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listSecureDocumentsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listEmailEventsForSubmissions(ids)),
    listInBatches(contactEmails, (emails) => storage.listEmailEventsForRecipients(emails)),
  ]);
  const latestUploadBySubmission = firstBy(uploadRequests, (request) => request.submission_id);
  const documentsBySubmission = groupBy(documents, (document) => document.submission_id);
  const eventsBySubmission = groupBy(submissionEmailEvents, (event) => event.submission_id);
  const eventsByRecipient = groupBy(recipientEmailEvents, (event) => normalizeEmail(event.recipient_email, 200));

  return submissions.map((submission) => {
    const emailEvents = [
      ...(eventsBySubmission.get(submission.id) || []),
      ...collectContactEmails(submission).flatMap((email) => eventsByRecipient.get(email) || []),
    ];

    return enrichSubmissionWithRelatedData(
      submission,
      {
        uploadRequest: latestUploadBySubmission.get(submission.id) || null,
        documents: documentsBySubmission.get(submission.id) || [],
        emailEvents,
      },
      nowValue,
    );
  });
}

function buildNotificationSummary(summary, submissions, emailTriage = []) {
  const actionItems = submissions.filter((submission) => submission.follow_up_prompt);
  const notificationSummary = actionItems.reduce(
    (accumulator, submission) => {
      const kind = submission.follow_up_prompt.kind;

      accumulator.total += 1;

      if (kind === 'overdue') {
        accumulator.overdue += 1;
      } else if (kind === 'today' || kind === 'due') {
        accumulator.dueSoon += 1;
      } else if (kind === 'missing') {
        accumulator.missingNextAction += 1;
      }

      return accumulator;
    },
    {
      total: 0,
      overdue: 0,
      dueSoon: 0,
      missingNextAction: 0,
    },
  );

  return {
    ...summary,
    actionItems: notificationSummary.total,
    overdue: notificationSummary.overdue,
    dueSoon: notificationSummary.dueSoon,
    missingNextAction: notificationSummary.missingNextAction,
    emailEngaged: emailTriage.length,
    hotLeads: emailTriage.filter((submission) => submission.email_engagement?.hot).length,
  };
}

async function enforceRateLimit(storage, ipHash) {
  const config = getConfig();
  const nowIso = new Date().toISOString();
  const windowStartIso = new Date(Date.now() - config.protection.rateLimitWindowMs).toISOString();
  const bucket = `contact:${ipHash}`;
  const count = await storage.countRateLimitEvents(bucket, windowStartIso);

  if (count >= config.protection.rateLimitMax) {
    return {
      blocked: true,
      error: 'Too many attempts from this source. Please wait a few minutes and try again.',
    };
  }

  await storage.addRateLimitEvent(bucket, nowIso);
  return { blocked: false };
}

async function enforceContactRateLimitForRequest(request, storage = getStorage()) {
  const ipHash = hashIp(getClientIp(request));
  const rateLimitResult = await enforceRateLimit(storage, ipHash);

  return {
    ...rateLimitResult,
    ipHash,
  };
}

export async function enforceContactBodyRateLimit(request) {
  const rateLimitResult = await enforceContactRateLimitForRequest(request);

  if (rateLimitResult.blocked) {
    return {
      ok: false,
      status: 429,
      error: rateLimitResult.error,
    };
  }

  request.contactIpHash = rateLimitResult.ipHash;
  request.contactRateLimitChecked = true;

  return { ok: true };
}

export async function submitContactLead(body, request) {
  const config = getConfig();
  const storage = getStorage();
  const input = {
    name: normalizeField(body.name, 120),
    email: normalizeEmail(body.email, 200),
    phone: normalizeField(body.phone, 40),
    company: normalizeField(body.company, 160),
    role: normalizeField(body.role, 80),
    message: normalizeMessage(body.message, 5000),
    source: normalizeField(body.source, 80) || 'website-contact-form',
    website: normalizeField(body.website, 120),
    turnstileToken: normalizeField(body.turnstileToken, turnstileTokenMaxLength),
    startedAt: Number(body.startedAt) || Date.now(),
  };

  const errors = validateWebsiteSubmission(input);

  if (errors.length > 0) {
    return {
      status: 400,
      body: { success: false, errors },
    };
  }

  let ipHash = request.contactIpHash || hashIp(getClientIp(request));

  if (!request.contactRateLimitChecked) {
    const rateLimitResult = await enforceContactRateLimitForRequest(request, storage);
    ipHash = rateLimitResult.ipHash;

    if (rateLimitResult.blocked) {
      return {
        status: 429,
        body: { success: false, errors: [rateLimitResult.error] },
      };
    }
  }

  const turnstileResult = await verifyTurnstileToken(input.turnstileToken, getClientIp(request));

  if (!turnstileResult.success) {
    return {
      status: 400,
      body: { success: false, errors: [turnstileResult.error] },
    };
  }

  const elapsedMs = Date.now() - input.startedAt;
  const spamAssessment = evaluateSubmissionSpam({ ...input, elapsedMs });
  const now = new Date().toISOString();
  const workflowDefaults = deriveWorkflowDefaults({
    role: input.role,
    source: input.source,
    submittedAt: now,
  });
  const sellerDetails =
    workflowDefaults.leadType === 'broker'
      ? { seller_name: '', seller_email: '', seller_phone: '', broker_name: input.name, broker_email: input.email, broker_phone: input.phone }
      : { seller_name: input.name, seller_email: input.email, seller_phone: input.phone, broker_name: '', broker_email: '', broker_phone: '' };

  const submission = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    status: spamAssessment.isSpam ? 'spam' : 'new',
    status_updated_at: now,
    spam_score: spamAssessment.score,
    spam_reasons: spamAssessment.reasons,
    delivery_provider: config.delivery.provider,
    delivery_status: 'pending',
    delivery_error: '',
    crm_status: 'pending',
    crm_error: '',
    source: input.source,
    ip_hash: ipHash,
    user_agent: normalizeField(request.headers['user-agent'], 300),
    name: input.name,
    email: input.email,
    phone: input.phone,
    company: input.company,
    role: input.role,
    message: input.message,
    listing_url: '',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    ...sellerDetails,
    lead_type: workflowDefaults.leadType,
    priority: workflowDefaults.priority,
    tags: workflowDefaults.tags,
    assigned_to: workflowDefaults.assignee,
    notes: '',
    follow_up_state: workflowDefaults.followUpState,
    next_action_at: workflowDefaults.nextActionAt,
    last_contacted_at: null,
    metadata: {
      elapsedMs,
      turnstileEnabled: turnstileResult.enabled,
      turnstileValidated: turnstileResult.success,
      attribution: normalizeAttribution(body.attribution, request),
    },
  };

  if (spamAssessment.hardBlock) {
    submission.status = 'spam';
    submission.delivery_status = 'skipped';
    submission.crm_status = 'skipped';
    await commitCrmActivityMutation({
      storage,
      operation: 'insert_submission',
      payload: { submission },
      activity: {
        submissionId: submission.id,
        eventType: 'submission.created',
        summary: 'Website inquiry received and quarantined by spam protection.',
        metadata: { source: submission.source, spamScore: submission.spam_score },
      },
    });

    return {
      status: 200,
      body: {
        success: true,
        message: 'Thank you. Your inquiry has been received.',
      },
    };
  }

  await commitCrmActivityMutation({
    storage,
    operation: 'insert_submission',
    payload: { submission },
    activity: {
      submissionId: submission.id,
      eventType: 'submission.created',
      summary: 'Website inquiry created a new CRM record.',
      actor: submission.name || 'website visitor',
      role: 'contact',
      metadata: { source: submission.source, company: submission.company },
    },
  });

  let deliveryResult = { status: 'skipped', error: '' };
  let crmResult = { status: 'skipped', error: '' };

  if (!spamAssessment.isSpam) {
    const [settledDelivery, settledCrm] = await Promise.allSettled([
      deliverSubmission(submission),
      forwardToCrm(submission),
    ]);

    deliveryResult = resultFromSettled(settledDelivery, 'Delivery failed');
    crmResult = resultFromSettled(settledCrm, 'CRM webhook failed');
  }

  await persistSubmissionRoutingOutcome({
    storage,
    submission,
    deliveryResult,
    crmResult,
    isSpam: spamAssessment.isSpam,
  });

  return {
    status: 200,
    body: {
      success: true,
      id: submission.id,
      message: 'Thanks. Your message has been received and routed.',
    },
  };
}

export async function createManualSubmission(body, adminUsername = '', options = {}) {
  const config = getConfig();
  const storage = options.storage || getStorage();
  const now = new Date().toISOString();
  const roleSeed =
    normalizeField(body.role, 80) ||
    normalizeField(body.lead_type, 80) ||
    (normalizeField(body.broker_name, 120) || normalizeField(body.broker_email, 200) ? 'broker' : 'seller');
  const workflowDefaults = deriveWorkflowDefaults({
    role: roleSeed,
    source: 'manual-crm-entry',
    submittedAt: now,
  });
  const dealFields = normalizeDealFields({
    company: body.company,
    role: body.role || roleSeed,
    listing_url: body.listing_url,
    business_website: body.business_website || body.website,
    prospectus_url: body.prospectus_url || body.prospectus_cim,
    asking_price: body.asking_price,
    ttm_revenue: body.ttm_revenue,
    ttm_ebitda: body.ttm_ebitda,
    ebitda_multiple: body.ebitda_multiple,
    net_margin: body.net_margin,
    business_age: body.business_age || body.age,
    sba_eligible: body.sba_eligible,
    broker_name: body.broker_name,
    broker_email: body.broker_email,
    broker_phone: body.broker_phone || body.broker_phone_number,
    seller_name: body.seller_name,
    seller_email: body.seller_email,
    seller_phone: body.seller_phone || body.seller_phone_number,
    lead_type: body.lead_type || workflowDefaults.leadType,
  });
  const notes = normalizeMessage(body.notes || body.deal_notes, 4000);
  const tags = normalizeTags(body.tags || `manual, ${dealFields.lead_type}`);
  const contact = derivePrimaryContact({
    ...dealFields,
    company: dealFields.company,
    name: body.name,
    email: body.email,
    phone: body.phone,
  });
  const errors = validateManualSubmission(dealFields);

  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      errors,
    };
  }

  const status = normalizeStatus(body.status, 'review');
  if (status === 'archived') {
    return {
      ok: false,
      status: 400,
      errors: ['Create the CRM record first, then use Archive Lead so a disposition reason and activity are retained.'],
    };
  }
  const message =
    normalizeMessage(body.message, 5000) ||
    notes ||
    'Manual CRM record created from the Uckele Group admin CRM.';
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { ...body.metadata } : {};
  const rawDiligence = body.diligence !== undefined ? body.diligence : metadata.diligence;

  if (rawDiligence !== undefined) {
    if (diligenceReviewsEqual(rawDiligence, {})) {
      delete metadata.diligence;
    } else {
      metadata.diligence = normalizeDiligenceReview(rawDiligence, {}, { now });
    }
  }

  const submission = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    status,
    status_updated_at: now,
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual-entry',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'manual-entry',
    crm_error: '',
    source: normalizeField(body.source, 80) || 'manual-crm-entry',
    ip_hash: 'manual-entry',
    user_agent: adminUsername ? `admin:${adminUsername}` : 'admin:manual-entry',
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: dealFields.company,
    role: dealFields.role || (dealFields.lead_type === 'broker' ? 'Broker' : 'Seller'),
    message,
    listing_url: dealFields.listing_url,
    business_website: dealFields.business_website,
    prospectus_url: dealFields.prospectus_url,
    asking_price: dealFields.asking_price,
    ttm_revenue: dealFields.ttm_revenue,
    ttm_ebitda: dealFields.ttm_ebitda,
    ebitda_multiple: dealFields.ebitda_multiple,
    net_margin: dealFields.net_margin,
    business_age: dealFields.business_age,
    sba_eligible: dealFields.sba_eligible,
    broker_name: dealFields.broker_name,
    broker_email: dealFields.broker_email,
    broker_phone: dealFields.broker_phone,
    seller_name: dealFields.seller_name,
    seller_email: dealFields.seller_email,
    seller_phone: dealFields.seller_phone,
    lead_type: dealFields.lead_type,
    priority: normalizePriority(body.priority, workflowDefaults.priority),
    tags,
    assigned_to: normalizeField(body.assigned_to, 120) || config.workflow.defaultAssignee,
    notes,
    follow_up_state: normalizeFollowUpState(body.follow_up_state, workflowDefaults.followUpState),
    next_action_at: normalizeField(body.next_action_at, 80) || workflowDefaults.nextActionAt,
    last_contacted_at: status === 'contacted' ? now : null,
    metadata: {
      ...metadata,
      manualEntry: true,
      createdBy: adminUsername || 'admin',
    },
  };

  await commitCrmActivityMutation({
    storage,
    operation: 'insert_submission',
    payload: { submission },
    activity: {
      submissionId: submission.id,
      eventType: 'submission.created',
      summary: 'CRM record created manually.',
      actor: adminUsername || 'admin',
      role: 'admin',
      metadata: { source: submission.source, company: submission.company },
    },
  });
  const enriched = await enrichSubmission(submission, storage);

  return {
    ok: true,
    status: 201,
    submission: enriched,
  };
}

function buildFollowUpQueues(enriched = []) {
  const notifications = enriched
    .filter((submission) => submission.follow_up_prompt)
    .sort((left, right) => {
      const leftDueAt = Date.parse(left.follow_up_prompt?.dueAt || '') || Number.MAX_SAFE_INTEGER;
      const rightDueAt = Date.parse(right.follow_up_prompt?.dueAt || '') || Number.MAX_SAFE_INTEGER;

      if (leftDueAt !== rightDueAt) {
        return leftDueAt - rightDueAt;
      }

      return Date.parse(right.created_at || '') - Date.parse(left.created_at || '');
    });
  const emailTriage = enriched
    .filter(
      (submission) =>
        submission.email_engagement?.actionable ||
        submission.email_engagement?.bounced ||
        submission.email_engagement?.complained ||
        submission.email_engagement?.failed ||
        submission.email_engagement?.unsubscribed,
    )
    .sort((left, right) => {
      const scoreDifference = (right.email_engagement?.score || 0) - (left.email_engagement?.score || 0);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      const rightLastEventAt = Date.parse(right.email_engagement?.last_event_at || '') || 0;
      const leftLastEventAt = Date.parse(left.email_engagement?.last_event_at || '') || 0;
      return rightLastEventAt - leftLastEventAt;
    });

  return { notifications, emailTriage };
}

export async function listDashboardSubmissions({ page, pageSize, search, status, created, sort, direction }) {
  const storage = getStorage();
  const safePageSize = [10, 25, 50, 100].includes(Number(pageSize)) ? Number(pageSize) : 25;
  const requestedPage = Number(page);
  const safePage = Number.isFinite(requestedPage)
    ? Math.max(1, Math.min(Math.trunc(requestedPage), 1_000_000))
    : 1;
  const safeSort = ['created_at', 'updated_at', 'company', 'next_action_at', 'priority', 'status', 'deal_score', 'listing_date'].includes(sort)
    ? sort
    : 'created_at';
  const safeDirection = String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const createdAfter = created === 'last-7-days'
    ? new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString()
    : '';
  const query = {
    limit: safePageSize,
    page: safePage,
    search,
    status,
    createdAfter,
    sort: safeSort,
    direction: safeDirection,
  };
  let [baseSummary, submissions] = await Promise.all([
    storage.getSummary(),
    storage.listSubmissions(query),
  ]);
  const totalPages = Math.max(1, Math.ceil(submissions.total / safePageSize));
  const resolvedPage = Math.min(safePage, totalPages);

  if (resolvedPage !== safePage) {
    submissions = await storage.listSubmissions({ ...query, page: resolvedPage });
  }

  const now = new Date();
  const enriched = await enrichSubmissions(submissions.rows, storage, now);
  const { notifications, emailTriage } = buildFollowUpQueues(enriched);

  return {
    summary: buildNotificationSummary(baseSummary, enriched, emailTriage),
    notifications,
    emailTriage,
    submissions: enriched,
    total: submissions.total,
    page: resolvedPage,
    pageSize: safePageSize,
    totalPages,
    sort: safeSort,
    direction: safeDirection,
  };
}

export async function getDashboardSubmission(id) {
  const storage = getStorage();
  const submissionId = String(id || '').trim();

  if (!submissionId) {
    return null;
  }

  const submission = await storage.getSubmission(submissionId);

  if (!submission) {
    return null;
  }

  return enrichSubmission(submission, storage);
}

function zonedDateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function zonedMidnightUtc({ year, month, day }, timeZone) {
  const targetWallTime = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  let guess = targetWallTime;
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedDateParts(new Date(guess), timeZone);
    const observedWallTime = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second), 0,
    );
    guess += targetWallTime - observedWallTime;
  }
  return new Date(guess);
}

function followUpDayBounds(now, timeZone) {
  const current = zonedDateParts(now, timeZone);
  const currentDate = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day)));
  const nextDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1_000);
  return {
    start: zonedMidnightUtc({
      year: currentDate.getUTCFullYear(),
      month: currentDate.getUTCMonth() + 1,
      day: currentDate.getUTCDate(),
    }, timeZone).toISOString(),
    end: zonedMidnightUtc({
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
    }, timeZone).toISOString(),
  };
}

function safeDealHunterQueueContext(metadata = {}) {
  const dealHunter = metadata?.dealHunter && typeof metadata.dealHunter === 'object' ? metadata.dealHunter : {};
  return {
    score: Number.isFinite(Number(dealHunter.score)) ? Number(dealHunter.score) : null,
    scoreVersion: normalizeField(dealHunter.scoreVersion, 120),
    strengths: Array.isArray(dealHunter.strengths) ? dealHunter.strengths.slice(0, 5).map((item) => normalizeField(item, 300)) : [],
    concerns: Array.isArray(dealHunter.concerns) ? dealHunter.concerns.slice(0, 5).map((item) => normalizeField(item, 300)) : [],
    unansweredQuestions: Array.isArray(dealHunter.unansweredQuestions)
      ? dealHunter.unansweredQuestions.slice(0, 5).map((item) => normalizeField(item, 300))
      : [],
    sourceFreshAt: normalizeField(dealHunter.sourceFreshAt || dealHunter.lastSeenAt, 80),
  };
}

function safeFollowUpQueueItem(submission) {
  return {
    id: submission.id,
    created_at: submission.created_at,
    updated_at: submission.updated_at,
    status_updated_at: submission.status_updated_at || submission.updated_at,
    status: submission.status,
    follow_up_state: submission.follow_up_state,
    next_action_at: submission.next_action_at,
    last_contacted_at: submission.last_contacted_at,
    priority: submission.priority,
    assigned_to: submission.assigned_to,
    lead_type: submission.lead_type,
    company: submission.company,
    name: submission.name,
    email: submission.email,
    broker_name: submission.broker_name,
    broker_email: submission.broker_email,
    seller_name: submission.seller_name,
    seller_email: submission.seller_email,
    listing_url: submission.listing_url,
    tags: submission.tags,
    follow_up_prompt: submission.follow_up_prompt,
    email_engagement: submission.email_engagement,
    follow_up_latest_subject: submission.follow_up_latest_subject || '',
    follow_up_latest_direction: submission.follow_up_latest_direction || '',
    follow_up_latest_delivery_state: submission.follow_up_latest_delivery_state || '',
    follow_up_latest_communication_at: submission.follow_up_latest_communication_at || '',
    follow_up_deal_key: submission.follow_up_deal_key || '',
    follow_up_recommendation_id: submission.follow_up_recommendation_id || '',
    follow_up_recommendation_action: submission.follow_up_recommendation_action || '',
    follow_up_conversation_state: submission.follow_up_conversation_state || '',
    follow_up_priority_score: Number(submission.follow_up_priority_score || 0),
    follow_up_confidence: Number(submission.follow_up_confidence || 0),
    deal_hunter: safeDealHunterQueueContext(submission.metadata),
  };
}

export async function listDashboardFollowUps({
  page = 1, pageSize = 25, search = '', view = 'crm-actions', sort = 'urgency', direction = 'desc',
} = {}) {
  const storage = getStorage();
  const config = getConfig();
  const safePageSize = [10, 25, 50, 100].includes(Number(pageSize)) ? Number(pageSize) : 25;
  const safePage = Math.max(1, Math.min(Math.trunc(Number(page) || 1), 1_000_000));
  const allowedViews = new Set([
    'crm-actions', 'email-triage', 'due-today', 'overdue', 'awaiting-reply', 'inbound-reply',
    'delivery-problem', 'manual-review', 'completed', 'all',
  ]);
  const safeView = allowedViews.has(view) ? view : 'crm-actions';
  const allowedSorts = new Set(['urgency', 'next_action_at', 'updated_at', 'company', 'priority', 'created_at']);
  const safeSort = allowedSorts.has(sort) ? sort : 'urgency';
  const safeDirection = String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const now = new Date();
  const bounds = followUpDayBounds(now, config.followUp.timezone);
  const [baseSummary, initialSubmissions] = await Promise.all([
    storage.getSummary(),
    storage.listFollowUpSubmissions({
      page: safePage,
      pageSize: safePageSize,
      search: normalizeField(search, 500),
      view: safeView,
      sort: safeSort,
      direction: safeDirection,
      now: now.toISOString(),
      todayStart: bounds.start,
      todayEnd: bounds.end,
    }),
  ]);
  let submissions = initialSubmissions;
  const initialTotalPages = Math.max(1, Math.ceil(submissions.total / safePageSize));
  const resolvedPage = Math.min(safePage, initialTotalPages);
  if (resolvedPage !== safePage) {
    submissions = await storage.listFollowUpSubmissions({
      page: resolvedPage,
      pageSize: safePageSize,
      search: normalizeField(search, 500),
      view: safeView,
      sort: safeSort,
      direction: safeDirection,
      now: now.toISOString(),
      todayStart: bounds.start,
      todayEnd: bounds.end,
    });
  }
  const enriched = await enrichSubmissions(submissions.rows, storage, now);
  const safeItems = enriched.map(safeFollowUpQueueItem);
  const { notifications, emailTriage } = buildFollowUpQueues(safeItems);
  const totalPages = Math.max(1, Math.ceil(submissions.total / safePageSize));

  return {
    summary: {
      ...buildNotificationSummary(baseSummary, safeItems, emailTriage),
      filteredTotal: submissions.total,
    },
    items: safeItems,
    notifications,
    emailTriage,
    total: submissions.total,
    page: resolvedPage,
    pageSize: safePageSize,
    totalPages,
    view: safeView,
    search: normalizeField(search, 500),
    sort: safeSort,
    direction: safeDirection,
  };
}

export async function updateSubmissionWorkflow(id, fields, options = {}) {
  const storage = options.storage || getStorage();
  const existing = await storage.getSubmission(id);

  if (!existing) {
    return null;
  }

  const expectedUpdatedAt = normalizeField(fields.expected_updated_at, 80);

  if (!expectedUpdatedAt) {
    return {
      conflict: true,
      current: await enrichSubmission(existing, storage),
      missingExpectedVersion: true,
    };
  }

  if (expectedUpdatedAt && existing.updated_at && expectedUpdatedAt !== existing.updated_at) {
    return {
      conflict: true,
      current: await enrichSubmission(existing, storage),
    };
  }

  const updates = {};
  const generatedNow = new Date().toISOString();
  const now = Date.parse(generatedNow) <= Date.parse(existing.updated_at || '')
    ? new Date(Date.parse(existing.updated_at) + 1).toISOString()
    : generatedNow;

  if (fields.status !== undefined) {
    const nextStatus = normalizeStatus(fields.status, '');

    if (!nextStatus) {
      return null;
    }

    // Archive and restore carry required disposition/audit semantics and must
    // use their explicit lifecycle operations instead of the generic status field.
    if (
      (nextStatus === 'archived' && existing.status !== 'archived') ||
      (existing.status === 'archived' && nextStatus !== 'archived')
    ) {
      return null;
    }

    updates.status = nextStatus;

    if (nextStatus !== existing.status) {
      updates.status_updated_at = now;
    }
  }

  if (fields.priority !== undefined) {
    updates.priority = normalizePriority(fields.priority, existing.priority || 'normal');
  }

  if (fields.assigned_to !== undefined) {
    updates.assigned_to = normalizeField(fields.assigned_to, 120);
  }

  if (fields.notes !== undefined) {
    updates.notes = normalizeMessage(fields.notes, 4000);
  }

  if (fields.next_action_at !== undefined) {
    const nextActionAt = normalizeField(fields.next_action_at, 80) || null;
    if (existing.status === 'archived' && nextActionAt) {
      return null;
    }
    updates.next_action_at = nextActionAt;
  }

  if (fields.follow_up_state !== undefined) {
    const followUpState = normalizeFollowUpState(fields.follow_up_state, existing.follow_up_state);
    if (existing.status === 'archived' && followUpState !== 'completed') {
      return null;
    }
    updates.follow_up_state = followUpState;
  }

  if (fields.tags !== undefined) {
    updates.tags = normalizeTags(fields.tags);
  }

  if (fields.diligence !== undefined) {
    const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {};
    const normalizedDiligence = normalizeDiligenceReview(fields.diligence, metadata.diligence, { now });

    if (!diligenceReviewsEqual(normalizedDiligence, metadata.diligence)) {
      updates.metadata = {
        ...metadata,
        diligence: normalizedDiligence,
      };
    }
  }

  const dealFieldUpdates = collectAliasedDealFieldUpdates(fields);

  const emailErrors = [];
  validateOptionalEmail(dealFieldUpdates.broker_email, 'Broker email', emailErrors);
  validateOptionalEmail(dealFieldUpdates.seller_email, 'Seller email', emailErrors);

  if (emailErrors.length > 0) {
    return null;
  }

  Object.assign(updates, dealFieldUpdates);

  const needsContactRefresh =
    'lead_type' in dealFieldUpdates ||
    'company' in dealFieldUpdates ||
    'role' in dealFieldUpdates ||
    'broker_name' in dealFieldUpdates ||
    'broker_email' in dealFieldUpdates ||
    'broker_phone' in dealFieldUpdates ||
    'seller_name' in dealFieldUpdates ||
    'seller_email' in dealFieldUpdates ||
    'seller_phone' in dealFieldUpdates;

  if (needsContactRefresh) {
    const merged = {
      ...existing,
      ...updates,
    };
    const contact = derivePrimaryContact(merged);
    updates.name = contact.name;
    updates.email = contact.email;
    updates.phone = contact.phone;
    updates.company = merged.company;
    updates.role = merged.role || (merged.lead_type === 'broker' ? 'Broker' : 'Seller');
  }

  if (updates.status === 'contacted') {
    updates.last_contacted_at = now;
  }

  if (Object.keys(updates).length === 0) {
    return storage.getSubmission(id);
  }

  updates.updated_at = now;
  const changes = summarizeSubmissionChanges(existing, updates);

  if (changes.length === 0) {
    return enrichSubmission(existing, storage);
  }

  const diligenceChanged = changes.some((change) => change.field === 'metadata' && fields.diligence !== undefined);
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_submission',
    payload: { id, expectedUpdatedAt, values: updates },
    activity: {
      submissionId: id,
      eventType: diligenceChanged ? 'diligence.updated' : 'submission.updated',
      summary: diligenceChanged
        ? 'Diligence review and checklist updated.'
        : `${changes.length} CRM field${changes.length === 1 ? '' : 's'} updated.`,
      actor: options.actor || 'admin',
      role: options.role || 'admin',
      metadata: {
        changes,
        changedFields: changes.map((change) => change.field),
      },
    },
  });
  const updated = mutation.applied ? mutation.record : null;

  if (!updated) {
    const current = mutation.record || await storage.getSubmission(id);

    return current
      ? { conflict: true, current: await enrichSubmission(current, storage) }
      : null;
  }

  await storage.supersedeCrmFollowUpRecommendations?.(id, updates.updated_at);

  return enrichSubmission(updated, storage);
}

async function stageSecureDocumentFiles(
  documents = [],
  {
    mkdir = fs.mkdir,
    renameFile = fs.rename,
    storageDir = getConfig().secureDocuments.storageDir,
    operationId = randomUUID(),
    onPrepared,
  } = {},
) {
  const paths = Array.from(
    new Set(
      (documents || [])
        .map((document) => document?.storage_path)
        .filter(Boolean),
    ),
  );
  const trashDirectory = path.join(storageDir, '.trash', operationId);
  const stagedFiles = [];
  const failures = [];

  if (paths.length === 0) {
    return { failures, stagedFiles, trashDirectory: '' };
  }

  const plannedFiles = [];
  for (const [index, filePath] of paths.entries()) {
    const resolvedPath = resolveSecureStoragePath(filePath, storageDir);

    if (!resolvedPath) {
      failures.push({
        filePath,
        message: 'Secure document file path is outside the configured document vault.',
      });
      return { failures, stagedFiles, trashDirectory, plannedFiles };
    }

    const stagedPath = path.join(trashDirectory, `${index}-${path.basename(resolvedPath)}`);
    plannedFiles.push({ originalPath: resolvedPath, stagedPath });
  }

  if (onPrepared) {
    await onPrepared({ plannedFiles, trashDirectory });
  }

  await mkdir(trashDirectory, { recursive: true, mode: 0o700 });

  for (const file of plannedFiles) {
    try {
      await renameFile(file.originalPath, file.stagedPath);
      stagedFiles.push(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      failures.push({
        filePath: file.originalPath,
        message: error.message || 'Unable to stage secure document file for deletion.',
      });
      break;
    }
  }

  return { failures, stagedFiles, trashDirectory, plannedFiles };
}

async function restoreStagedDocumentFiles(
  stagedFiles = [],
  renameFile = fs.rename,
  {
    accessFile = fs.access,
    storageDir = getConfig().secureDocuments.storageDir,
    beforeMutation = null,
  } = {},
) {
  const failures = [];
  const trashRoot = path.join(path.resolve(storageDir), '.trash');

  for (const file of [...stagedFiles].reverse()) {
    const originalPath = resolveSecureStoragePath(file.originalPath, storageDir);
    const stagedPath = path.resolve(String(file.stagedPath || ''));

    if (!originalPath || !stagedPath.startsWith(`${trashRoot}${path.sep}`)) {
      failures.push({ filePath: file.originalPath || file.stagedPath, message: 'Cleanup path is outside the secure document vault.' });
      continue;
    }

    await beforeMutation?.(file);
    try {
      await renameFile(stagedPath, originalPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          await accessFile(originalPath);
          continue;
        } catch {
          // Neither copy exists, so retain a durable cleanup failure.
        }
      }
      failures.push({ filePath: originalPath, message: error.message || 'Unable to restore secure document file.' });
    }
  }

  return failures;
}

async function purgeStagedDocumentFiles(
  stagedFiles = [],
  unlinkFile = fs.unlink,
  storageDir = getConfig().secureDocuments.storageDir,
  { beforeMutation = null } = {},
) {
  const failures = [];
  const trashRoot = path.join(path.resolve(storageDir), '.trash');

  for (const file of stagedFiles) {
    const stagedPath = path.resolve(String(file.stagedPath || ''));
    if (!stagedPath.startsWith(`${trashRoot}${path.sep}`)) {
      failures.push({ filePath: file.stagedPath, message: 'Cleanup path is outside the secure document trash directory.' });
      continue;
    }

    await beforeMutation?.(file);
    try {
      await unlinkFile(stagedPath);
    } catch (error) {
      if (error.code === 'ENOENT' && file.purgeOriginalIfStagedMissing) {
        const originalPath = resolveSecureStoragePath(file.originalPath, storageDir);

        if (!originalPath) {
          failures.push({ filePath: file.originalPath, message: 'Original cleanup path is outside the secure document vault.' });
          continue;
        }

        await beforeMutation?.(file);
        try {
          await unlinkFile(originalPath);
        } catch (originalError) {
          if (originalError.code !== 'ENOENT') {
            failures.push({ filePath: originalPath, message: originalError.message || 'Unable to purge retained secure document file.' });
          }
        }
      } else if (error.code !== 'ENOENT') {
        failures.push({ filePath: file.stagedPath, message: error.message || 'Unable to purge staged secure document file.' });
      }
    }
  }

  return failures;
}

function validateCleanupJobPaths(job, storageDir = getConfig().secureDocuments.storageDir) {
  const trashRoot = path.join(path.resolve(storageDir), '.trash');
  const trashDirectory = path.resolve(String(job.trash_directory || ''));
  if (!trashDirectory.startsWith(`${trashRoot}${path.sep}`) || path.basename(trashDirectory) !== String(job.id || '')) {
    throw new Error('Cleanup job directory is outside its secure document operation directory.');
  }

  const files = (job.files || []).map((file) => {
    const originalPath = resolveSecureStoragePath(file.originalPath, storageDir);
    const stagedPath = path.resolve(String(file.stagedPath || ''));
    if (!originalPath || originalPath === path.resolve(storageDir) || originalPath === trashRoot || originalPath.startsWith(`${trashRoot}${path.sep}`)) {
      throw new Error('Cleanup job original path is outside the canonical secure document vault.');
    }
    if (path.dirname(stagedPath) !== trashDirectory) {
      throw new Error('Cleanup job staged path is outside its exact operation directory.');
    }
    return { ...file, originalPath, stagedPath };
  });

  return { ...job, trash_directory: trashDirectory, files };
}

async function getSubmissionStrictly(storage, submissionId) {
  const strictLookup = storage.getSubmissionStrict;
  if (strictLookup) {
    return strictLookup.call(storage, submissionId);
  }
  if (storage.provider === 'supabase') {
    throw new Error('Strict submission lookup is required for Supabase cleanup reconciliation.');
  }
  if (!storage.getSubmission) {
    throw new Error('Submission lookup is required for cleanup reconciliation.');
  }
  return storage.getSubmission(submissionId);
}

function cleanupJobIsSettling(job, nowMs = Date.now()) {
  if (!job.metadata?.writeAheadIntent) {
    return false;
  }
  if (isSecureDocumentCleanupIntentActive(job.id)) {
    return true;
  }

  const explicitReconcileAfter = Date.parse(job.metadata?.reconcileAfter || '');
  if (Number.isFinite(explicitReconcileAfter)) {
    return nowMs < explicitReconcileAfter;
  }

  const intentCreatedAt = Date.parse(job.created_at || '');
  return Number.isFinite(intentCreatedAt) && nowMs - intentCreatedAt < cleanupWriteAheadGraceMs;
}

async function partitionCleanupJobFiles(storage, job, storageDir = getConfig().secureDocuments.storageDir) {
  const reason = String(job.metadata?.reason || '');

  if (reason === 'individual-document-deletion') {
    if (!storage.getSecureDocument) {
      throw new Error('Secure document lookup is required to reconcile an individual deletion.');
    }

    const documentId = job.metadata?.documentId || job.files?.[0]?.documentId;
    if (!documentId) {
      throw new Error('Individual document cleanup job is missing its document ID.');
    }
    if (job.files?.length !== 1 || job.files[0].documentId !== documentId) {
      throw new Error('Individual document cleanup job does not match its file identity.');
    }

    const document = await storage.getSecureDocument(documentId);
    if (document) {
      const file = job.files[0];
      const documentPath = resolveSecureStoragePath(document.storage_path, storageDir);
      if (!file || !documentPath || documentPath !== file.originalPath) {
        throw new Error('Individual cleanup destination does not match the secure document record.');
      }
    }
    return document
      ? { restoreFiles: job.files || [], purgeFiles: [] }
      : { restoreFiles: [], purgeFiles: job.files || [] };
  }

  if (reason === 'ambiguous-secure-upload-finalization') {
    if (!storage.getSecureDocument) {
      throw new Error('Secure document lookup is required to reconcile an ambiguous upload.');
    }

    const documentIds = Array.isArray(job.metadata?.documentIds) ? job.metadata.documentIds : [];
    const dispositions = await Promise.all((job.files || []).map(async (file, index) => {
      const documentId = documentIds[index];
      if (!documentId || file.documentId !== documentId) {
        throw new Error('Ambiguous upload cleanup job is missing a document ID.');
      }
      const document = await storage.getSecureDocument(documentId);
      if (document) {
        const documentPath = resolveSecureStoragePath(document.storage_path, storageDir);
        if (!documentPath || documentPath !== file.originalPath) {
          throw new Error(`Cleanup destination for secure document ${documentId} does not match its database record.`);
        }
      }
      return { file, document };
    }));

    return dispositions.reduce(
      (result, disposition) => {
        result[disposition.document ? 'restoreFiles' : 'purgeFiles'].push(disposition.file);
        return result;
      },
      { restoreFiles: [], purgeFiles: [] },
    );
  }

  const submission = await getSubmissionStrictly(storage, job.submission_id);
  return submission
    ? { restoreFiles: job.files || [], purgeFiles: [] }
    : { restoreFiles: [], purgeFiles: job.files || [] };
}

async function removeCleanupDirectory(directory, rmdir = fs.rmdir, storageDir = getConfig().secureDocuments.storageDir) {
  if (!directory) {
    return;
  }
  const trashRoot = path.join(path.resolve(storageDir), '.trash');
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(`${trashRoot}${path.sep}`)) {
    throw new Error('Cleanup directory is outside the secure document trash directory.');
  }
  try {
    await rmdir(resolvedDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function importSecureDocumentCleanupSidecars(storage, options = {}) {
  const discovery = await listSecureDocumentCleanupSidecars({
    storageDir: options.storageDir,
    fileSystem: options.fileSystem || fs,
  });
  const jobs = [];
  const errors = [...discovery.errors];

  for (const sidecar of discovery.sidecars) {
    let durableJob = null;
    let lastError = null;

    if (storage.getSecureDocumentCleanupJob) {
      try {
        durableJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);
      } catch (error) {
        lastError = error;
      }
    }

    if (!durableJob && storage.insertSecureDocumentCleanupJob) {
      try {
        durableJob = await storage.insertSecureDocumentCleanupJob(sidecar.job);
      } catch (error) {
        lastError = error;

        // The insert may have committed even when its response was lost. A
        // second read makes sidecar import idempotent without issuing a
        // duplicate mutation.
        if (storage.getSecureDocumentCleanupJob) {
          try {
            durableJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);
          } catch (inspectionError) {
            lastError = inspectionError;
          }
        }
      }
    }

    if (!durableJob) {
      errors.push({
        path: sidecar.path,
        error: lastError || new Error('Cleanup storage did not confirm the recovered sidecar job.'),
      });
      continue;
    }

    if (
      path.resolve(String(durableJob.trash_directory || '')) !== sidecar.job.trash_directory ||
      String(durableJob.submission_id || '') !== String(sidecar.job.submission_id || '')
    ) {
      errors.push({
        path: sidecar.path,
        error: new Error('Cleanup sidecar does not match the durable job with the same identity.'),
      });
      continue;
    }

    try {
      await removeSecureDocumentCleanupSidecar(sidecar.path, {
        storageDir: options.storageDir,
        fileSystem: options.fileSystem || fs,
      });
      if (['completed', 'restored'].includes(durableJob.status)) {
        await removeCleanupDirectory(
          durableJob.trash_directory,
          options.rmdir || fs.rmdir,
          options.storageDir,
        );
      }
    } catch (error) {
      if (['completed', 'restored'].includes(durableJob.status)) {
        errors.push({ path: sidecar.path, error });
      } else {
        // Keep processing the durable pending job. Its normal directory
        // removal will retry the sidecar cleanup and record one job failure if
        // the filesystem problem remains.
        console.warn(`[secure-documents] cleanup sidecar removal will be retried for job ${durableJob.id}: ${error.message}`);
      }
    }

    if (!['completed', 'restored'].includes(durableJob.status)) {
      jobs.push(durableJob);
    }
  }

  return { jobs, errors, discovered: discovery.sidecars.length + discovery.errors.length };
}

async function runSecureDocumentCleanupReconciliation(options = {}) {
  const storage = options.storage || getStorage();
  const reconciliationNowMs = options.now === undefined ? Date.now() : Date.parse(String(options.now));
  if (!Number.isFinite(reconciliationNowMs)) {
    throw new Error('Secure document cleanup reconciliation time is invalid.');
  }
  if (!storage.listPendingSecureDocumentCleanupJobs || !storage.updateSecureDocumentCleanupJob) {
    return { reviewed: 0, completed: 0, restored: 0, failed: 0 };
  }
  const recovered = await importSecureDocumentCleanupSidecars(storage, options);
  const persistedJobs = await storage.listPendingSecureDocumentCleanupJobs(options.limit || 100);
  const jobsById = new Map();
  for (const job of [...persistedJobs, ...recovered.jobs]) jobsById.set(job.id, job);
  const jobs = [...jobsById.values()];
  const summary = {
    reviewed: jobs.length + Math.max(0, recovered.discovered - recovered.jobs.length),
    completed: 0,
    restored: 0,
    failed: recovered.errors.length,
  };

  for (const failure of recovered.errors) {
    console.error(`[secure-documents] cleanup sidecar recovery failed: ${failure.error?.message || failure.error}`);
  }

  for (const job of jobs) {
    const now = new Date(reconciliationNowMs).toISOString();
    let leaseToken = null;
    const updateReconciliationState = async (values) => {
      if (leaseToken && storage.updateSecureDocumentCleanupJobIfLeased) {
        return storage.updateSecureDocumentCleanupJobIfLeased(job.id, leaseToken, values);
      }
      return storage.updateSecureDocumentCleanupJob(job.id, values);
    };

    try {
      let claimedJob = job;
      if (cleanupJobIsSettling(claimedJob, reconciliationNowMs)) {
        continue;
      }

      if (storage.claimSecureDocumentCleanupJob) {
        const requestedLeaseToken = randomUUID();
        if (
          !storage.updateSecureDocumentCleanupJobIfLeased ||
          !storage.renewSecureDocumentCleanupJobLease
        ) {
          throw new Error('Cleanup-job claims require token-fenced updates and server-timed lease renewal.');
        }
        // Retain the token even if the claim response is lost. A fenced
        // cleanup-failure update can then affect only a claim that actually
        // committed for this worker.
        leaseToken = requestedLeaseToken;
        claimedJob = await storage.claimSecureDocumentCleanupJob(job.id, {
          claimedAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + cleanupLeaseMs).toISOString(),
          leaseToken: requestedLeaseToken,
        });
        if (!claimedJob) {
          continue;
        }
        if (leaseToken && claimedJob.lease_token !== leaseToken) {
          throw new Error('Cleanup job claim returned a different lease owner.');
        }
      }

      let safeJob = validateCleanupJobPaths(claimedJob, options.storageDir);
      const renewReconciliationLease = async () => {
        if (!leaseToken) {
          return safeJob;
        }
        const renewedJob = await storage.renewSecureDocumentCleanupJobLease(
          job.id,
          leaseToken,
          cleanupLeaseMs,
        );
        if (!renewedJob) {
          throw new CleanupLeaseLostError();
        }
        safeJob = validateCleanupJobPaths(renewedJob, options.storageDir);
        return safeJob;
      };

      if (storage.claimSecureDocumentCleanupJob) {
        if (cleanupJobIsSettling(safeJob, reconciliationNowMs)) {
          await updateReconciliationState({
            lease_claimed_at: null,
            lease_expires_at: null,
            lease_token: null,
          });
          continue;
        }
      }

      const { restoreFiles, purgeFiles } = await partitionCleanupJobFiles(storage, safeJob, options.storageDir);
      if (leaseToken) {
        await renewReconciliationLease();
      }

      const restoreFailures = await restoreStagedDocumentFiles(restoreFiles, options.renameFile || fs.rename, {
        accessFile: options.accessFile || fs.access,
        storageDir: options.storageDir,
        beforeMutation: leaseToken ? renewReconciliationLease : null,
      });
      const purgeFailures = await purgeStagedDocumentFiles(
        purgeFiles,
        options.unlinkFile || fs.unlink,
        options.storageDir,
        { beforeMutation: leaseToken ? renewReconciliationLease : null },
      );
      const failures = [...restoreFailures, ...purgeFailures];

      if (failures.length > 0) {
        summary.failed += 1;
        await updateReconciliationState({
          updated_at: now,
          status: restoreFiles.length > 0 ? 'restore-failed' : 'cleanup-failed',
          attempt_count: Number(job.attempt_count || 0) + 1,
          last_error: failures.map((failure) => failure.message).join('; ').slice(0, 2000),
          lease_claimed_at: null,
          lease_expires_at: null,
          lease_token: null,
        });
        continue;
      }

      if (
        safeJob.metadata?.reason === 'ambiguous-secure-upload-finalization' &&
        restoreFiles.length === 0 &&
        safeJob.metadata?.requestId
      ) {
        const resetRequest = storage.resetSecureUploadRequestIfUploading || storage.updateSecureUploadRequest;
        if (resetRequest) {
          await renewReconciliationLease();
          await resetRequest.call(storage, safeJob.metadata.requestId, {
            updated_at: now,
            status: safeJob.metadata.resetStatus || 'open',
          });
        }
      }

      await renewReconciliationLease();
      await removeCleanupDirectory(safeJob.trash_directory, options.rmdir || fs.rmdir, options.storageDir);
      const status = restoreFiles.length > 0 ? 'restored' : 'completed';
      const terminalJob = await updateReconciliationState({
        updated_at: now,
        completed_at: now,
        status,
        attempt_count: Number(job.attempt_count || 0) + 1,
        last_error: null,
        lease_claimed_at: null,
        lease_expires_at: null,
        lease_token: null,
      });
      if (!terminalJob && leaseToken) {
        summary.failed += 1;
        continue;
      }
      summary[status] += 1;
    } catch (error) {
      if (error instanceof CleanupLeaseLostError) {
        continue;
      }
      summary.failed += 1;
      await updateReconciliationState({
        updated_at: now,
        status: 'cleanup-failed',
        attempt_count: Number(job.attempt_count || 0) + 1,
        last_error: String(error.message || error).slice(0, 2000),
        lease_claimed_at: null,
        lease_expires_at: null,
        lease_token: null,
      }).catch(() => {});
    }
  }

  return summary;
}

export async function reconcileSecureDocumentCleanupJobs(options = {}) {
  if (activeCleanupReconciliation) {
    return activeCleanupReconciliation;
  }

  const execution = runSecureDocumentCleanupReconciliation(options);
  activeCleanupReconciliation = execution;
  try {
    return await execution;
  } finally {
    if (activeCleanupReconciliation === execution) {
      activeCleanupReconciliation = null;
    }
  }
}

export function startSecureDocumentCleanupScheduler({ intervalMs = 60 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    reconcileSecureDocumentCleanupJobs().catch((error) => {
      console.error(`[secure-documents:cleanup] reconciliation failed: ${error.message}`);
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export async function deleteDashboardSubmission(id, options = {}) {
  const storage = options.storage || getStorage();
  const unlinkFile = options.unlinkFile || fs.unlink;
  const renameFile = options.renameFile || fs.rename;
  const mkdir = options.mkdir || fs.mkdir;
  const rmdir = options.rmdir || fs.rmdir;
  const submissionId = String(id || '').trim();

  if (!submissionId || !storage.deleteSubmission) {
    return null;
  }

  const existing = await getSubmissionStrictly(storage, submissionId);

  if (!existing) {
    return null;
  }

  const documents = storage.listSecureDocumentsForSubmission
    ? await storage.listSecureDocumentsForSubmission(submissionId)
    : [];
  const cleanupId = randomUUID();
  let cleanupJob = null;
  const updateCleanupState = async (values) => {
    if (!cleanupJob) return null;
    const result = await updateSecureDocumentCleanupJobState(storage, cleanupJob, values);
    cleanupJob = result.job;
    return result;
  };
  const staged = await stageSecureDocumentFiles(documents, {
    mkdir,
    renameFile,
    operationId: cleanupId,
    onPrepared: async ({ plannedFiles, trashDirectory }) => {
      if (plannedFiles.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const persistence = await persistSecureDocumentCleanupJob(storage, {
        id: cleanupId,
        submission_id: submissionId,
        created_at: now,
        updated_at: now,
        completed_at: null,
        status: 'staging',
        trash_directory: trashDirectory,
        files: plannedFiles,
        attempt_count: 0,
        last_error: null,
        metadata: {
          reconcileAfter: new Date(Date.parse(now) + secureDocumentCleanupSettlementMs).toISOString(),
          writeAheadIntent: true,
        },
      });
      cleanupJob = persistence.job;
    },
  });

  if (staged.failures.length > 0) {
    const restoreFailures = await restoreStagedDocumentFiles(staged.stagedFiles, renameFile);
    if (restoreFailures.length === 0) {
      await removeCleanupDirectory(staged.trashDirectory, rmdir).catch((error) => {
        restoreFailures.push({ filePath: staged.trashDirectory, message: error.message });
      });
    }
    if (cleanupJob) {
      const now = new Date().toISOString();
      await updateCleanupState({
        updated_at: now,
        completed_at: restoreFailures.length === 0 ? now : null,
        status: restoreFailures.length === 0 ? 'restored' : 'restore-failed',
        attempt_count: 1,
        last_error: restoreFailures.map((failure) => failure.message).join('; ') || null,
      });
    }
    console.warn(
      `[crm] blocked deletion for ${submissionId}; secure document staging failed for ${staged.failures.length} file(s).`,
    );

    return {
      ok: false,
      status: 500,
      error: 'Secure document cleanup could not be prepared. The CRM record and document files were kept so deletion can be retried.',
      cleanupFailures: [...staged.failures, ...restoreFailures],
    };
  }

  let deleted;
  let deletionError = null;

  try {
    deleted = await storage.deleteSubmission(submissionId);
  } catch (error) {
    deletionError = error;
  }

  if (deletionError) {
    if (deletionError.code === 'CIM_SEND_IN_PROGRESS' || deletionError.status === 409) {
      const restoreFailures = await restoreStagedDocumentFiles(staged.stagedFiles, renameFile);
      if (restoreFailures.length === 0) {
        await removeCleanupDirectory(staged.trashDirectory, rmdir).catch((error) => {
          restoreFailures.push({ filePath: staged.trashDirectory, message: error.message });
        });
      }
      if (cleanupJob) {
        const now = new Date().toISOString();
        await updateCleanupState({
          updated_at: now,
          completed_at: restoreFailures.length === 0 ? now : null,
          status: restoreFailures.length === 0 ? 'restored' : 'restore-failed',
          attempt_count: 1,
          last_error: restoreFailures.map((failure) => failure.message).join('; ') || null,
        }).catch(() => {});
      }
      return restoreFailures.length === 0
        ? {
            ok: false,
            status: 409,
            error: 'CRM deletion is blocked while a CIM transmission is in progress. Retry after the claim lease expires.',
            cleanupFailures: [],
          }
        : {
            ok: false,
            status: 500,
            error: 'CRM deletion was blocked, and staged documents could not be fully restored.',
            cleanupFailures: restoreFailures,
          };
    }

    const message = String(deletionError.message || deletionError).slice(0, 2000);
    if (cleanupJob) {
      await updateCleanupState({
        updated_at: new Date().toISOString(),
        status: 'reconciliation-pending',
        attempt_count: 1,
        last_error: message,
        metadata: { ...cleanupJob.metadata, ambiguousDelete: true },
      }).catch(() => {});
    }
    console.error(`[crm] deletion outcome for ${submissionId} is unknown; staged documents were retained for reconciliation.`);
    return {
      ok: false,
      status: 503,
      error: 'CRM deletion could not be confirmed. Document files remain securely staged while the database outcome is reconciled.',
      cleanupPending: staged.stagedFiles.length > 0,
      cleanupFailures: [{ message }],
    };
  }

  if (!deleted) {
    let currentSubmission;
    let inspectionError = null;

    try {
      currentSubmission = await getSubmissionStrictly(storage, submissionId);
    } catch (error) {
      inspectionError = error;
    }

    if (inspectionError) {
      const message = String(inspectionError.message || inspectionError).slice(0, 2000);
      if (cleanupJob) {
        await updateCleanupState({
          updated_at: new Date().toISOString(),
          status: 'reconciliation-pending',
          attempt_count: 1,
          last_error: message,
          metadata: { ...cleanupJob.metadata, ambiguousDelete: true },
        }).catch(() => {});
      }
      console.error(`[crm] deletion outcome for ${submissionId} is unknown; staged documents were retained for reconciliation.`);
      return {
        ok: false,
        status: 503,
        error: 'CRM deletion could not be confirmed. Document files remain securely staged while the database outcome is reconciled.',
        cleanupPending: staged.stagedFiles.length > 0,
        cleanupFailures: [{ message }],
      };
    }

    if (!currentSubmission) {
      // A strict read confirmed that the database deletion committed even
      // though its response was lost. Continue with the purge path.
      deleted = existing;
    } else {
      const restoreFailures = await restoreStagedDocumentFiles(staged.stagedFiles, renameFile);
      if (restoreFailures.length === 0) {
        await removeCleanupDirectory(staged.trashDirectory, rmdir).catch((error) => {
          restoreFailures.push({ filePath: staged.trashDirectory, message: error.message });
        });
      }
      if (cleanupJob) {
        const now = new Date().toISOString();
        await updateCleanupState({
          updated_at: now,
          completed_at: restoreFailures.length === 0 ? now : null,
          status: restoreFailures.length === 0 ? 'restored' : 'restore-failed',
          attempt_count: 1,
          last_error: restoreFailures.map((failure) => failure.message).join('; ') || null,
        }).catch(() => {});
      }
      return restoreFailures.length === 0
        ? null
        : { ok: false, status: 500, error: 'CRM record was not deleted, and staged documents could not be fully restored.', cleanupFailures: restoreFailures };
    }
  }

  if (cleanupJob) {
    const deletionConfirmedAt = new Date().toISOString();
    await updateCleanupState({
      updated_at: deletionConfirmedAt,
      status: 'pending-purge',
      metadata: {
        ...cleanupJob.metadata,
        deletionConfirmedAt,
        writeAheadIntent: false,
      },
    }).catch(() => {});
  }
  const purgeFailures = await purgeStagedDocumentFiles(staged.plannedFiles || staged.stagedFiles, unlinkFile);

  if (purgeFailures.length > 0) {
    console.warn(`[crm] deleted ${submissionId}; ${purgeFailures.length} staged secure file(s) remain for cleanup.`);
  }

  if (cleanupJob && purgeFailures.length === 0) {
    const completedAt = new Date().toISOString();
    await removeCleanupDirectory(staged.trashDirectory, rmdir).catch(() => {});
    await updateCleanupState({
      updated_at: completedAt,
      completed_at: completedAt,
      status: 'completed',
      attempt_count: 1,
      last_error: null,
    }).catch(() => {});
  } else if (cleanupJob) {
    await updateCleanupState({
      updated_at: new Date().toISOString(),
      status: 'cleanup-failed',
      attempt_count: 1,
      last_error: purgeFailures.map((failure) => failure.message).join('; ').slice(0, 2000),
    }).catch(() => {});
  }

  return {
    ok: true,
    submission: existing,
    cleanupPending: purgeFailures.length > 0,
    cleanupFailures: purgeFailures,
  };
}

export async function exportDashboardSubmissionsCsv() {
  const storage = getStorage();
  const now = new Date();
  const result = await storage.listSubmissions({ limit: 5000, page: 1, status: 'all' });
  const enriched = await enrichSubmissions(result.rows, storage, now);
  return buildCsv(enriched);
}
