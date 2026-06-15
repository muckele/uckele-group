import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp } from '../utils/http.js';
import { hashIp } from '../utils/security.js';
import { forwardToCrm } from './crmForwarder.js';
import { deliverSubmission } from './delivery.js';
import { summarizeEmailEngagement } from './emailEvents.js';
import { summarizeAutomationState } from './prospectAutomation.js';
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

const allowedStatuses = ['new', 'review', 'contacted', 'archived', 'spam'];
const enrichmentLookupBatchSize = 250;
const urlFieldLabels = {
  listing_url: 'Lead source URL',
  business_website: 'Business website',
};
const dealFieldAliasMap = {
  company: 'company',
  role: 'role',
  lead_source_url: 'listing_url',
  listing_url: 'listing_url',
  business_website: 'business_website',
  website: 'business_website',
  service_interest: 'prospectus_url',
  prospectus_url: 'prospectus_url',
  prospectus_cim: 'prospectus_url',
  package_budget: 'asking_price',
  asking_price: 'asking_price',
  monthly_lead_value: 'ttm_revenue',
  ttm_revenue: 'ttm_revenue',
  lead_goal: 'ttm_ebitda',
  ttm_ebitda: 'ttm_ebitda',
  current_provider: 'ebitda_multiple',
  ebitda_multiple: 'ebitda_multiple',
  conversion_issue: 'net_margin',
  net_margin: 'net_margin',
  business_age: 'business_age',
  age: 'business_age',
  priority_fit: 'sba_eligible',
  sba_eligible: 'sba_eligible',
  partner_name: 'broker_name',
  broker_name: 'broker_name',
  partner_email: 'broker_email',
  broker_email: 'broker_email',
  partner_phone: 'broker_phone',
  broker_phone: 'broker_phone',
  broker_phone_number: 'broker_phone',
  primary_contact_name: 'seller_name',
  seller_name: 'seller_name',
  primary_contact_email: 'seller_email',
  seller_email: 'seller_email',
  primary_contact_phone: 'seller_phone',
  seller_phone: 'seller_phone',
  seller_phone_number: 'seller_phone',
  lead_type: 'lead_type',
};

const dealFieldNormalizers = {
  company: (value) => normalizeField(value, 160),
  role: (value) => normalizeField(value, 80),
  listing_url: (value) => normalizeHttpUrl(value, 500),
  business_website: (value) => normalizeHttpUrl(value, 500),
  prospectus_url: (value) => normalizeField(value, 500),
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
  lead_type: (value) => normalizeLeadType(value, 'prospect'),
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

function normalizeEmail(value, maxLength = 200) {
  return normalizeField(value, maxLength).toLowerCase();
}

function normalizeMessage(value, maxLength = 5000) {
  return String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .slice(0, maxLength);
}

function normalizeHttpUrl(value, maxLength = 500) {
  const rawValue = normalizeField(value, maxLength);

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);
    const protocol = url.protocol.toLowerCase();

    if (!['http:', 'https:'].includes(protocol) || !url.hostname || !url.hostname.includes('.')) {
      return '';
    }

    url.protocol = protocol;
    url.hash = '';
    return url.toString().slice(0, maxLength);
  } catch {
    return '';
  }
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

function normalizeStatus(value, fallback = 'new') {
  const normalized = normalizeField(value, 40).toLowerCase();
  return allowedStatuses.includes(normalized) ? normalized : fallback;
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

function validateUrlFields(rawFields, errors) {
  Object.entries(urlFieldLabels).forEach(([field, label]) => {
    const rawValue = normalizeField(rawFields[field], 500);

    if (hasOwn(rawFields, field) && rawValue && !normalizeHttpUrl(rawValue, 500)) {
      errors.push(`${label} must be a valid http or https URL.`);
    }
  });
}

function collectAliasedDealFieldUpdates(source = {}) {
  return collectDealFieldUpdates(collectAliasedRawDealFields(source));
}

function collectAliasedRawDealFields(source = {}) {
  const raw = {};

  Object.entries(dealFieldAliasMap).forEach(([sourceKey, targetKey]) => {
    if (hasOwn(source, sourceKey)) {
      raw[targetKey] = source[sourceKey];
    }
  });

  return raw;
}

function derivePrimaryContact(fields) {
  const leadType = normalizeLeadType(fields.lead_type, 'prospect');
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
    leadType === 'partner' ||
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

  if (!normalizeField(input.company, 160)) {
    errors.push('Business name is required.');
  }

  if (!normalizeField(input.businessWebsite, 500)) {
    errors.push('Business website is required.');
  }

  if (normalizeField(input.businessWebsite, 500) && !normalizeHttpUrl(input.businessWebsite, 500)) {
    errors.push('Business website must be a valid website URL.');
  }

  if (!normalizeMessage(input.message, 5000)) {
    errors.push('Message is required.');
  }

  return errors;
}

function validateManualSubmission(input, rawInput = input) {
  const errors = [];

  if (!input.company && !input.seller_name && !input.broker_name) {
    errors.push('Add a company/business name or at least one primary or partner contact.');
  }

  validateOptionalEmail(input.broker_email, 'Partner email', errors);
  validateOptionalEmail(input.seller_email, 'Primary contact email', errors);
  validateUrlFields(rawInput, errors);

  return errors;
}

function buildCsv(submissions) {
  const headers = [
    'Company/Business',
    'Date Added',
    'Status',
    'Last Edit (Status)',
    'Days Ago',
    'Lead Source URL',
    'Website',
    'Service Interest',
    'Package / Budget',
    'Monthly Revenue Impact',
    'Lead Goal',
    'Current Provider',
    'Conversion Issue',
    'Business Age',
    'Priority Fit?',
    'Partner Name',
    'Partner Email',
    'Partner Phone Number',
    'Primary Contact Name',
    'Primary Contact Email',
    'Primary Contact Phone Number',
    'CRM Notes',
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

  const escapeCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [
    headers.join(','),
    ...submissions.map((submission) => {
      const followUpPrompt = submission.follow_up_prompt || buildFollowUpPrompt(submission);

      return [
        submission.company,
        submission.created_at,
        submission.status,
        submission.status_updated_at || submission.updated_at,
        submission.days_since_added ?? daysAgoFrom(submission.created_at),
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
  return [submission.email, submission.partner_email || submission.broker_email, submission.primary_contact_email || submission.seller_email]
    .map((value) => normalizeEmail(value, 200))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function withCrmAliases(submission) {
  return {
    ...submission,
    lead_source_url: submission.lead_source_url || submission.listing_url || '',
    service_interest: submission.service_interest || submission.prospectus_url || '',
    package_budget: submission.package_budget || submission.asking_price || '',
    monthly_lead_value: submission.monthly_lead_value || submission.ttm_revenue || '',
    lead_goal: submission.lead_goal || submission.ttm_ebitda || '',
    current_provider: submission.current_provider || submission.ebitda_multiple || '',
    conversion_issue: submission.conversion_issue || submission.net_margin || '',
    priority_fit: normalizeSbaEligibility(submission.priority_fit || submission.sba_eligible, 'unknown'),
    partner_name: submission.partner_name || submission.broker_name || '',
    partner_email: submission.partner_email || submission.broker_email || '',
    partner_phone: submission.partner_phone || submission.broker_phone || '',
    primary_contact_name: submission.primary_contact_name || submission.seller_name || '',
    primary_contact_email: submission.primary_contact_email || submission.seller_email || '',
    primary_contact_phone: submission.primary_contact_phone || submission.seller_phone || '',
  };
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
  {
    uploadRequest = null,
    documents = [],
    emailEvents = [],
    researchRuns = [],
    audits = [],
    reports = [],
    outreachMessages = [],
    websiteVisits = [],
  } = {},
  nowValue = new Date(),
) {
  const emailEngagement = summarizeEmailEngagement(dedupeEmailEvents(emailEvents));
  const normalizedSubmission = withCrmAliases(submission);
  const latestRun = researchRuns[0] || null;
  const latestAudit = audits[0] || null;
  const latestReport = reports[0] || null;
  const automation = summarizeAutomationState({
    latestRun,
    latestAudit,
    latestReport,
    outreachMessages,
    visits: websiteVisits,
    emailEngagement,
    submission: normalizedSubmission,
  });
  const enriched = {
    ...normalizedSubmission,
    latest_upload_request: uploadRequest,
    secure_documents: documents,
    email_engagement: emailEngagement,
    automation,
    status_updated_at: normalizedSubmission.status_updated_at || normalizedSubmission.updated_at,
    days_since_added: daysAgoFrom(normalizedSubmission.created_at, nowValue),
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
      researchRuns: storage.listResearchRunsForSubmission ? await storage.listResearchRunsForSubmission(submission.id, 5) : [],
      audits: storage.listProspectAuditsForSubmission ? await storage.listProspectAuditsForSubmission(submission.id, 5) : [],
      reports: storage.listGeneratedReportsForSubmission ? await storage.listGeneratedReportsForSubmission(submission.id, 5) : [],
      outreachMessages: storage.listOutreachMessagesForSubmission ? await storage.listOutreachMessagesForSubmission(submission.id, 20) : [],
      websiteVisits: storage.listWebsiteVisitsForSubmission ? await storage.listWebsiteVisitsForSubmission(submission.id, 50) : [],
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
    !storage.listEmailEventsForRecipients ||
    !storage.listResearchRunsForSubmissions ||
    !storage.listProspectAuditsForSubmissions ||
    !storage.listGeneratedReportsForSubmissions ||
    !storage.listOutreachMessagesForSubmissions ||
    !storage.listWebsiteVisitsForSubmissions
  ) {
    return Promise.all(submissions.map((submission) => enrichSubmission(submission, storage, nowValue)));
  }

  const submissionIds = submissions.map((submission) => submission.id);
  const contactEmails = submissions.flatMap(collectContactEmails);
  const [
    uploadRequests,
    documents,
    submissionEmailEvents,
    recipientEmailEvents,
    researchRuns,
    audits,
    reports,
    outreachMessages,
    websiteVisits,
  ] = await Promise.all([
    listInBatches(submissionIds, (ids) => storage.listLatestSecureUploadRequestsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listSecureDocumentsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listEmailEventsForSubmissions(ids)),
    listInBatches(contactEmails, (emails) => storage.listEmailEventsForRecipients(emails)),
    listInBatches(submissionIds, (ids) => storage.listResearchRunsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listProspectAuditsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listGeneratedReportsForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listOutreachMessagesForSubmissions(ids)),
    listInBatches(submissionIds, (ids) => storage.listWebsiteVisitsForSubmissions(ids)),
  ]);
  const latestUploadBySubmission = firstBy(uploadRequests, (request) => request.submission_id);
  const documentsBySubmission = groupBy(documents, (document) => document.submission_id);
  const eventsBySubmission = groupBy(submissionEmailEvents, (event) => event.submission_id);
  const eventsByRecipient = groupBy(recipientEmailEvents, (event) => normalizeEmail(event.recipient_email, 200));
  const runsBySubmission = groupBy(researchRuns, (run) => run.submission_id);
  const auditsBySubmission = groupBy(audits, (audit) => audit.submission_id);
  const reportsBySubmission = groupBy(reports, (report) => report.submission_id);
  const outreachBySubmission = groupBy(outreachMessages, (message) => message.submission_id);
  const visitsBySubmission = groupBy(websiteVisits, (visit) => visit.submission_id);

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
        researchRuns: runsBySubmission.get(submission.id) || [],
        audits: auditsBySubmission.get(submission.id) || [],
        reports: reportsBySubmission.get(submission.id) || [],
        outreachMessages: outreachBySubmission.get(submission.id) || [],
        websiteVisits: visitsBySubmission.get(submission.id) || [],
      },
      nowValue,
    );
  });
}

function buildNotificationSummary(summary, submissions, emailTriage = [], automationTriage = []) {
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
    tierA: automationTriage.filter((submission) => submission.automation?.tier === 'A').length,
    tierB: automationTriage.filter((submission) => submission.automation?.tier === 'B').length,
    websiteVisits: submissions.reduce((total, submission) => total + (submission.automation?.visit_count || 0), 0),
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

export async function submitContactLead(body, request) {
  const config = getConfig();
  const storage = getStorage();
  const input = {
    name: normalizeField(body.name, 120),
    email: normalizeEmail(body.email, 200),
    phone: normalizeField(body.phone, 40),
    company: normalizeField(body.company, 160),
    role: normalizeField(body.role, 80),
    businessWebsite: normalizeField(body.businessWebsite || body.business_website || body.businessUrl, 500),
    serviceInterest: normalizeField(body.serviceInterest || body.service_interest, 160),
    timeline: normalizeField(body.timeline, 120),
    message: normalizeMessage(body.message, 5000),
    source: normalizeField(body.source, 80) || 'website-contact-form',
    website: normalizeField(body.website, 120),
    turnstileToken: normalizeField(body.turnstileToken, 600),
    startedAt: Number(body.startedAt) || Date.now(),
  };

  const errors = validateWebsiteSubmission(input);
  const normalizedBusinessWebsite = normalizeHttpUrl(input.businessWebsite, 500);

  if (errors.length > 0) {
    return {
      status: 400,
      body: { success: false, errors },
    };
  }

  const ipHash = hashIp(getClientIp(request));
  const rateLimitResult = await enforceRateLimit(storage, ipHash);

  if (rateLimitResult.blocked) {
    return {
      status: 429,
      body: { success: false, errors: [rateLimitResult.error] },
    };
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
  const contactDetails =
    workflowDefaults.leadType === 'partner'
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
    business_website: normalizedBusinessWebsite,
    prospectus_url: input.serviceInterest,
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    ...contactDetails,
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
      serviceInterest: input.serviceInterest,
      timeline: input.timeline,
      turnstileEnabled: turnstileResult.enabled,
      turnstileValidated: turnstileResult.success,
    },
  };

  if (spamAssessment.hardBlock) {
    submission.status = 'spam';
    submission.delivery_status = 'skipped';
    submission.crm_status = 'skipped';
    await storage.insertSubmission(submission);

    return {
      status: 200,
      body: {
        success: true,
        message: 'Thank you. Your inquiry has been received.',
      },
    };
  }

  await storage.insertSubmission(submission);

  let deliveryResult = { status: 'skipped', error: '' };
  let crmResult = { status: 'skipped', error: '' };

  if (!spamAssessment.isSpam) {
    deliveryResult = await deliverSubmission(submission);
    crmResult = await forwardToCrm(submission);
  }

  await storage.updateSubmission(submission.id, {
    updated_at: new Date().toISOString(),
    delivery_status: deliveryResult.status,
    delivery_error: deliveryResult.error,
    crm_status: crmResult.status,
    crm_error: crmResult.error,
    status: spamAssessment.isSpam ? 'spam' : 'new',
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

export async function createManualSubmission(body, adminUsername = '') {
  const config = getConfig();
  const storage = getStorage();
  const now = new Date().toISOString();
  const roleSeed =
    normalizeField(body.role, 80) ||
    normalizeField(body.lead_type, 80) ||
    (normalizeField(body.partner_name || body.broker_name, 120) || normalizeField(body.partner_email || body.broker_email, 200)
      ? 'partner'
      : 'prospect');
  const workflowDefaults = deriveWorkflowDefaults({
    role: roleSeed,
    source: 'manual-crm-entry',
    submittedAt: now,
  });
  const rawDealFields = {
    company: body.company,
    role: body.role || roleSeed,
    listing_url: body.lead_source_url || body.listing_url,
    business_website: body.business_website || body.website,
    prospectus_url: body.service_interest || body.prospectus_url || body.prospectus_cim,
    asking_price: body.package_budget || body.asking_price,
    ttm_revenue: body.monthly_lead_value || body.ttm_revenue,
    ttm_ebitda: body.lead_goal || body.ttm_ebitda,
    ebitda_multiple: body.current_provider || body.ebitda_multiple,
    net_margin: body.conversion_issue || body.net_margin,
    business_age: body.business_age || body.age,
    sba_eligible: body.priority_fit || body.sba_eligible,
    broker_name: body.partner_name || body.broker_name,
    broker_email: body.partner_email || body.broker_email,
    broker_phone: body.partner_phone || body.broker_phone || body.broker_phone_number,
    seller_name: body.primary_contact_name || body.seller_name,
    seller_email: body.primary_contact_email || body.seller_email,
    seller_phone: body.primary_contact_phone || body.seller_phone || body.seller_phone_number,
    lead_type: body.lead_type || workflowDefaults.leadType,
  };
  const dealFields = normalizeDealFields(rawDealFields);
  const notes = normalizeMessage(body.notes || body.deal_notes, 4000);
  const tags = normalizeTags(body.tags || `manual, ${dealFields.lead_type}`);
  const contact = derivePrimaryContact({
    ...dealFields,
    company: dealFields.company,
    name: body.name,
    email: body.email,
    phone: body.phone,
  });
  const errors = validateManualSubmission(dealFields, rawDealFields);

  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      errors,
    };
  }

  const status = normalizeStatus(body.status, 'review');
  const message =
    normalizeMessage(body.message, 5000) ||
    notes ||
    'Manual CRM record created from the Uckele Group admin CRM.';

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
    role: dealFields.role || (dealFields.lead_type === 'partner' ? 'Partner' : 'Business Owner'),
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
      manualEntry: true,
      createdBy: adminUsername || 'admin',
    },
  };

  await storage.insertSubmission(submission);
  const enriched = await enrichSubmission(submission, storage);

  return {
    ok: true,
    status: 201,
    submission: enriched,
  };
}

export async function listDashboardSubmissions({ page, search, status }) {
  const storage = getStorage();
  const [baseSummary, submissions] = await Promise.all([
    storage.getSummary(),
    storage.listSubmissions({ page, search, status }),
  ]);
  const now = new Date();
  const enriched = await enrichSubmissions(submissions.rows, storage, now);
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
  const automationTriage = enriched
    .filter((submission) => submission.automation?.score > 0)
    .sort((left, right) => {
      const scoreDifference = (right.automation?.score || 0) - (left.automation?.score || 0);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      const rightVisitAt = Date.parse(right.automation?.latest_visit_at || '') || 0;
      const leftVisitAt = Date.parse(left.automation?.latest_visit_at || '') || 0;
      return rightVisitAt - leftVisitAt;
    });

  return {
    summary: buildNotificationSummary(baseSummary, enriched, emailTriage, automationTriage),
    notifications,
    emailTriage,
    automationTriage,
    submissions: enriched,
    total: submissions.total,
  };
}

export async function updateSubmissionWorkflow(id, fields) {
  const storage = getStorage();
  const existing = await storage.getSubmission(id);

  if (!existing) {
    return null;
  }

  const updates = {};
  const now = new Date().toISOString();

  if (fields.status !== undefined) {
    const nextStatus = normalizeStatus(fields.status, '');

    if (!nextStatus) {
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
    updates.next_action_at = normalizeField(fields.next_action_at, 80) || null;
  }

  if (fields.follow_up_state !== undefined) {
    updates.follow_up_state = normalizeFollowUpState(fields.follow_up_state, existing.follow_up_state);
  }

  if (fields.tags !== undefined) {
    updates.tags = normalizeTags(fields.tags);
  }

  const rawDealFieldUpdates = collectAliasedRawDealFields(fields);
  const dealFieldUpdates = collectDealFieldUpdates(rawDealFieldUpdates);

  const emailErrors = [];
  validateOptionalEmail(dealFieldUpdates.broker_email, 'Partner email', emailErrors);
  validateOptionalEmail(dealFieldUpdates.seller_email, 'Primary contact email', emailErrors);
  validateUrlFields(rawDealFieldUpdates, emailErrors);

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
    updates.role = merged.role || (merged.lead_type === 'partner' ? 'Partner' : 'Business Owner');
  }

  if (updates.status === 'contacted') {
    updates.last_contacted_at = now;
  }

  if (Object.keys(updates).length === 0) {
    return storage.getSubmission(id);
  }

  updates.updated_at = now;
  const updated = await storage.updateSubmission(id, updates);

  if (!updated) {
    return null;
  }

  return enrichSubmission(updated, storage);
}

export async function exportDashboardSubmissionsCsv() {
  const storage = getStorage();
  const now = new Date();
  const result = await storage.listSubmissions({ limit: 5000, page: 1, status: 'all' });
  const enriched = await enrichSubmissions(result.rows, storage, now);
  return buildCsv(enriched);
}
