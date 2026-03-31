import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp } from '../utils/http.js';
import { hashIp } from '../utils/security.js';
import { forwardToCrm } from './crmForwarder.js';
import { deliverSubmission } from './delivery.js';
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

const dealFieldNormalizers = {
  company: (value) => normalizeField(value, 160),
  role: (value) => normalizeField(value, 80),
  listing_url: (value) => normalizeField(value, 500),
  business_website: (value) => normalizeField(value, 500),
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

function buildCsv(submissions) {
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

async function enrichSubmission(submission, storage, nowValue = new Date()) {
  const [uploadRequest, documents] = await Promise.all([
    storage.getLatestSecureUploadRequestForSubmission(submission.id),
    storage.listSecureDocumentsForSubmission(submission.id),
  ]);

  const enriched = {
    ...submission,
    latest_upload_request: uploadRequest,
    secure_documents: documents,
    status_updated_at: submission.status_updated_at || submission.updated_at,
    days_since_added: daysAgoFrom(submission.created_at, nowValue),
  };

  return {
    ...enriched,
    follow_up_prompt: buildFollowUpPrompt(enriched, nowValue),
  };
}

function buildNotificationSummary(summary, submissions) {
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
    message: normalizeMessage(body.message, 5000),
    source: normalizeField(body.source, 80) || 'website-contact-form',
    website: normalizeField(body.website, 120),
    turnstileToken: normalizeField(body.turnstileToken, 600),
    startedAt: Number(body.startedAt) || Date.now(),
  };

  const errors = validateWebsiteSubmission(input);

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
  const enriched = await Promise.all(submissions.rows.map((submission) => enrichSubmission(submission, storage, now)));
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

  return {
    summary: buildNotificationSummary(baseSummary, enriched),
    notifications,
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
  const enriched = await Promise.all(result.rows.map((submission) => enrichSubmission(submission, storage, now)));
  return buildCsv(enriched);
}
