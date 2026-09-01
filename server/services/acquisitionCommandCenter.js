import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { summarizeEmailEngagement } from './emailEvents.js';
import { reviewDailyDeals } from './dealHunter.js';
import { normalizeDiligenceReview } from './submissions.js';
import { buildFollowUpPrompt } from './workflow.js';
import { commitCrmActivityMutation } from './activity.js';
import { archiveLead } from './leadLifecycle.js';
import { evaluateAcquisitionMaterialsState } from './acquisitionMaterials.js';

export const acquisitionPipelineStages = [
  'new-fit',
  'cim-requested',
  'broker-replied',
  'docs-received',
  'diligence',
  'loi-candidate',
  'passed',
];

export const acquisitionPassReasons = [
  'fedex-route',
  'physician-owner-required',
  'too-small',
  'too-expensive',
  'customer-concentration',
  'weak-recurring-revenue',
  'poor-management-transition',
  'food-or-hospitality',
  'high-capex',
  'low-ai-recession-resistance',
  'seller-financing-gap',
  'other',
];

const acquisitionFitFeedbackValues = ['neutral', 'good-fit', 'false-positive'];
const commandCenterLimit = 5000;
const batchSize = 250;
const sourceHealthWarningDropRatio = 0.7;
const sourceHealthUpdateBufferMinutes = 30;

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value = '') {
  return normalizeText(value, 320).toLowerCase();
}

function normalizePipelineStage(value, fallback = 'new-fit') {
  const normalized = normalizeText(value, 80).toLowerCase();
  return acquisitionPipelineStages.includes(normalized) ? normalized : fallback;
}

function normalizePassReason(value) {
  const normalized = normalizeText(value, 100).toLowerCase();
  return acquisitionPassReasons.includes(normalized) ? normalized : '';
}

function archiveReasonForCommandCenterPass(reason) {
  if (reason === 'too-expensive') return 'valuation';
  if (reason === 'seller-financing-gap') return 'financing';
  if (reason === 'other') return 'other';
  return 'not-a-fit';
}

function normalizeFitFeedback(value, fallback = 'neutral') {
  const normalized = normalizeText(value, 80).toLowerCase();
  return acquisitionFitFeedbackValues.includes(normalized) ? normalized : fallback;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 1000)).filter(Boolean)));
}

function chunkValues(values = [], size = batchSize) {
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

function collectContactEmails(submission = {}) {
  return [submission.email, submission.broker_email, submission.seller_email]
    .map(normalizeEmail)
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function dedupeEmailEvents(events = []) {
  const seen = new Set();

  return events.filter((event) => {
    const key = event.id || event.event_key || `${event.message_id || ''}:${event.event_type || ''}:${event.created_at || ''}:${event.recipient_email || ''}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function loadRelatedSubmissionData(storage, submissions = []) {
  const submissionIds = submissions.map((submission) => submission.id);
  const contactEmails = submissions.flatMap(collectContactEmails);

  if (
    storage.listLatestSecureUploadRequestsForSubmissions &&
    storage.listSecureDocumentsForSubmissions &&
    storage.listEmailEventsForSubmissions &&
    storage.listEmailEventsForRecipients
  ) {
    const [uploadRequests, documents, submissionEmailEvents, recipientEmailEvents] = await Promise.all([
      listInBatches(submissionIds, (ids) => storage.listLatestSecureUploadRequestsForSubmissions(ids)),
      listInBatches(submissionIds, (ids) => storage.listSecureDocumentsForSubmissions(ids)),
      listInBatches(submissionIds, (ids) => storage.listEmailEventsForSubmissions(ids)),
      listInBatches(contactEmails, (emails) => storage.listEmailEventsForRecipients(emails)),
    ]);

    return {
      latestUploadBySubmission: firstBy(uploadRequests, (request) => request.submission_id),
      documentsBySubmission: groupBy(documents, (document) => document.submission_id),
      eventsBySubmission: groupBy(submissionEmailEvents, (event) => event.submission_id),
      eventsByRecipient: groupBy(recipientEmailEvents, (event) => normalizeEmail(event.recipient_email)),
    };
  }

  const entries = await Promise.all(
    submissions.map(async (submission) => {
      const emailQueries = storage.listEmailEvents
        ? [
            storage.listEmailEvents({ submissionId: submission.id, limit: 100 }),
            ...collectContactEmails(submission).map((recipientEmail) => storage.listEmailEvents({ recipientEmail, limit: 100 })),
          ]
        : [];
      const [uploadRequest, documents, ...emailEventResults] = await Promise.all([
        storage.getLatestSecureUploadRequestForSubmission?.(submission.id) || null,
        storage.listSecureDocumentsForSubmission?.(submission.id) || [],
        ...emailQueries,
      ]);

      return {
        submission,
        uploadRequest,
        documents,
        emailEvents: emailEventResults.flat(),
      };
    }),
  );

  return {
    latestUploadBySubmission: new Map(entries.map((entry) => [entry.submission.id, entry.uploadRequest]).filter((entry) => entry[1])),
    documentsBySubmission: new Map(entries.map((entry) => [entry.submission.id, entry.documents])),
    eventsBySubmission: new Map(entries.map((entry) => [entry.submission.id, entry.emailEvents])),
    eventsByRecipient: new Map(),
  };
}

function commandMetadata(submission = {}) {
  return objectValue(submission.metadata?.acquisitionCommand);
}

function dealHunterMetadata(submission = {}) {
  return objectValue(submission.metadata?.dealHunter);
}

function diligenceMetadata(submission = {}) {
  return normalizeDiligenceReview(submission.metadata?.diligence || {});
}

function getDealScore(submission = {}) {
  const metadataScore = numberValue(dealHunterMetadata(submission).score, NaN);

  if (Number.isFinite(metadataScore)) {
    return Math.max(0, Math.min(100, Math.round(metadataScore)));
  }

  return 0;
}

function getDealKey(submission = {}) {
  return normalizeText(dealHunterMetadata(submission).dealKey || '', 1000);
}

function hasAcquisitionDealFields(submission = {}) {
  return Boolean(
    submission.listing_url ||
      submission.prospectus_url ||
      submission.asking_price ||
      submission.ttm_ebitda ||
      submission.broker_email ||
      submission.seller_email ||
      getDealKey(submission),
  );
}

function isAcquisitionCandidate(submission = {}) {
  if (['archived', 'spam'].includes(submission.status) && getDealScore(submission) < 75) {
    return false;
  }

  const score = getDealScore(submission);
  const activeConversation = !['archived', 'spam'].includes(submission.status) && submission.follow_up_state !== 'completed';

  return score >= 75 || (activeConversation && hasAcquisitionDealFields(submission));
}

function chooseCimRequest(submission = {}, cimRequestsByDealKey = new Map()) {
  const dealKey = getDealKey(submission);

  if (!dealKey) {
    return null;
  }

  const requests = cimRequestsByDealKey.get(dealKey) || [];
  const preferredEmails = [submission.broker_email, submission.seller_email, submission.email].map(normalizeEmail).filter(Boolean);
  const matchingRequest = requests.find((request) => preferredEmails.includes(normalizeEmail(request.recipient_email)));

  return matchingRequest || requests[0] || null;
}

function hasDiligenceContent(diligence = {}) {
  return (
    diligence.stage !== 'not-started' ||
    diligence.decision !== 'undecided' ||
    Object.values(diligence.checklist || {}).some(Boolean) ||
    Object.values(diligence.financing || {}).some(Boolean) ||
    Boolean(normalizeText(diligence.questions, 10)) ||
    Boolean(normalizeText(diligence.memo, 10))
  );
}

function textIncludes(text, patterns = []) {
  const normalized = normalizeText(text, 10000).toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

function checklistComplete(diligence, key) {
  return Boolean(diligence?.checklist?.[key]);
}

function documentsText(documents = []) {
  return documents
    .map((document) =>
      [
        document.document_type,
        document.original_name,
        document.name,
        document.filename,
        document.note,
      ].join(' '),
    )
    .join(' ');
}

function parseFinancialNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = normalizeText(value, 100)
    .toLowerCase()
    .replace(/[$,%]/g, '')
    .replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?\s*(billion|bn|b|million|mm|m|thousand|k|x)?/);

  if (!match) {
    return null;
  }

  const parsed = Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const suffix = match[1] || '';

  if (suffix === 'x') {
    return parsed;
  }

  const multiplier =
    suffix === 'billion' || suffix === 'bn' || suffix === 'b'
      ? 1_000_000_000
      : suffix === 'million' || suffix === 'mm' || suffix === 'm'
        ? 1_000_000
        : suffix === 'thousand' || suffix === 'k'
          ? 1_000
          : 1;

  return parsed * multiplier;
}

function valuationMultiple(submission = {}) {
  const explicitMultiple = parseFinancialNumber(submission.ebitda_multiple);

  if (explicitMultiple && explicitMultiple > 0 && explicitMultiple < 25) {
    return explicitMultiple;
  }

  const askingPrice = parseFinancialNumber(submission.asking_price);
  const earnings = parseFinancialNumber(submission.ttm_ebitda);

  if (askingPrice && earnings && askingPrice > 0 && earnings > 0) {
    return askingPrice / earnings;
  }

  return null;
}

function readinessItem({ id, label, weight, complete, risk }) {
  return {
    id,
    label,
    weight,
    complete: Boolean(complete),
    risk: complete ? '' : risk,
  };
}

export function calculateDiligenceReadiness({ submission = {}, documents = [] } = {}) {
  const diligence = diligenceMetadata(submission);
  const documentText = documentsText(documents);
  const evidenceText = [
    submission.ttm_revenue,
    submission.ttm_ebitda,
    submission.ebitda_multiple,
    submission.asking_price,
    documentText,
    diligence.memo,
    diligence.financing?.seller_note,
    diligence.financing?.sba_lender_status,
  ].join(' ');
  const hasCimOrTeaser =
    Boolean(submission.prospectus_url) ||
    checklistComplete(diligence, 'cim') ||
    textIncludes(evidenceText, ['cim', 'teaser', 'confidential information memorandum', 'nda', 'prospectus']);
  const hasFinancialPackage =
    checklistComplete(diligence, 'p_and_l') ||
    checklistComplete(diligence, 'tax_returns') ||
    checklistComplete(diligence, 'balance_sheet') ||
    textIncludes(evidenceText, ['p&l', 'p and l', 'profit and loss', 'tax return', 'tax returns', 'balance sheet', 'financial package', 'financials']);
  const multiple = valuationMultiple(submission);
  const hasValuationSupport = Number.isFinite(multiple) ? multiple > 0 && multiple <= 4.25 : false;
  const hasRevenueQuality =
    textIncludes(evidenceText, [
      'recurring revenue',
      'recurring maintenance',
      'service contract',
      'service contracts',
      'maintenance contract',
      'repeat customers',
      'commercial customers',
      'contracted revenue',
      'scheduled maintenance',
    ]) && !textIncludes(evidenceText, ['project-based', 'project based', 'one-time projects', 'non-recurring']);
  const items = [
    readinessItem({
      id: 'cim-or-teaser',
      label: 'CIM / teaser received',
      weight: 10,
      complete: hasCimOrTeaser,
      risk: 'No CIM, teaser, NDA package, prospectus link, or secure upload received yet.',
    }),
    readinessItem({
      id: 'financial-package',
      label: 'Financial package received',
      weight: 18,
      complete: hasFinancialPackage,
      risk: 'P&L, tax returns, balance sheet, or detailed financial package still needs to be reviewed.',
    }),
    readinessItem({
      id: 'valuation-fit',
      label: 'Valuation fit',
      weight: 14,
      complete: hasValuationSupport,
      risk: multiple ? `Valuation multiple is ${Number(multiple.toFixed(2))}x and needs stronger support.` : 'Asking price and earnings do not yet support a financeable multiple.',
    }),
    readinessItem({
      id: 'seller-financing-fit',
      label: 'Seller financing fit',
      weight: 12,
      complete: Boolean(diligence.financing?.seller_note) || textIncludes(evidenceText, ['seller note', 'seller financing', 'seller finance', 'owner financing']),
      risk: 'Seller note or structure still needs confirmation.',
    }),
    readinessItem({
      id: 'sba-fit',
      label: 'SBA fit',
      weight: 12,
      complete:
        checklistComplete(diligence, 'sba_fit') ||
        submission.sba_eligible === 'yes' ||
        textIncludes(diligence.financing?.sba_lender_status, ['approved', 'pre-screened', 'prescreened', 'reviewed', 'sba']),
      risk: 'SBA lender fit has not been confirmed.',
    }),
    readinessItem({
      id: 'owner-role-risk',
      label: 'Owner role risk',
      weight: 10,
      complete: checklistComplete(diligence, 'owner_role') || textIncludes(evidenceText, ['owner role', 'owner duties', 'transition plan']),
      risk: 'Owner duties and transition risk still need diligence.',
    }),
    readinessItem({
      id: 'management-depth',
      label: 'Management depth',
      weight: 8,
      complete: checklistComplete(diligence, 'management_depth') || textIncludes(evidenceText, ['general manager', 'manager', 'management depth', 'trained staff']),
      risk: 'Management depth is not yet confirmed.',
    }),
    readinessItem({
      id: 'customer-concentration',
      label: 'Customer concentration',
      weight: 10,
      complete: checklistComplete(diligence, 'customer_concentration') || textIncludes(evidenceText, ['customer concentration', 'top 5', 'top five', 'top 10', 'top ten']),
      risk: 'Customer concentration has not been reviewed.',
    }),
    readinessItem({
      id: 'revenue-quality',
      label: 'Recurring revenue quality',
      weight: 6,
      complete: hasRevenueQuality,
      risk: 'Recurring, contracted, scheduled, repeat, or commercial revenue quality still needs confirmation.',
    }),
  ];
  const complete = items.filter((item) => item.complete).length;
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const completeWeight = items.filter((item) => item.complete).reduce((sum, item) => sum + item.weight, 0);

  return {
    score: Math.round((completeWeight / totalWeight) * 100),
    complete,
    total: items.length,
    completeWeight,
    totalWeight,
    items,
    missing: items.filter((item) => !item.complete),
  };
}

export function deriveAcquisitionPipelineStage({ submission = {}, cimRequest = null, documents = [], latestUploadRequest = null } = {}) {
  const command = commandMetadata(submission);
  const commandStage = normalizePipelineStage(command.pipelineStage, '');

  if (commandStage) {
    return commandStage;
  }

  const diligence = diligenceMetadata(submission);

  if (diligence.stage === 'passed' || diligence.decision === 'pass' || command.passReason) {
    return 'passed';
  }

  if (diligence.stage === 'loi-candidate') {
    return 'loi-candidate';
  }

  if (['financial-review', 'lender-review', 'cim-received'].includes(diligence.stage) || hasDiligenceContent(diligence)) {
    return 'diligence';
  }

  const materials = evaluateAcquisitionMaterialsState({
    submission,
    secureDocuments: documents,
    latestUploadRequest,
  });

  if (materials.materialsReceived) {
    return 'docs-received';
  }

  if (cimRequest?.status === 'responded') {
    return 'broker-replied';
  }

  if (['sent', 'logged', 'failed', 'follow_up_failed', 'follow_up_pending', 'pending'].includes(cimRequest?.status) || ['cim-requested', 'nda-sent'].includes(diligence.stage)) {
    return 'cim-requested';
  }

  return 'new-fit';
}

function pipelineTone(stage) {
  if (stage === 'passed') {
    return 'danger';
  }

  if (['docs-received', 'diligence', 'loi-candidate'].includes(stage)) {
    return 'success';
  }

  if (['cim-requested', 'broker-replied'].includes(stage)) {
    return 'warning';
  }

  return 'info';
}

function commandRecordFromSubmission({
  submission,
  cimRequest = null,
  documents = [],
  latestUploadRequest = null,
  emailEvents = [],
  now = new Date(),
}) {
  const command = commandMetadata(submission);
  const dealHunter = dealHunterMetadata(submission);
  const diligence = diligenceMetadata(submission);
  const emailEngagement = summarizeEmailEngagement(dedupeEmailEvents(emailEvents));
  const enrichedForPrompt = {
    ...submission,
    latest_upload_request: latestUploadRequest,
    secure_documents: documents,
    email_engagement: emailEngagement,
  };
  const followUpPrompt = buildFollowUpPrompt(enrichedForPrompt, now);
  const readiness = calculateDiligenceReadiness({ submission, documents, latestUploadRequest });
  const pipelineStage = deriveAcquisitionPipelineStage({ submission, cimRequest, documents, latestUploadRequest });
  const score = getDealScore(submission);

  return {
    id: submission.id,
    company: submission.company || submission.name || 'Unnamed opportunity',
    status: submission.status,
    leadType: submission.lead_type,
    source: submission.source,
    priority: submission.priority,
    score,
    dealKey: getDealKey(submission),
    listingUrl: submission.listing_url || '',
    prospectusUrl: submission.prospectus_url || '',
    askingPrice: submission.asking_price || '',
    ttmRevenue: submission.ttm_revenue || '',
    ttmEbitda: submission.ttm_ebitda || '',
    ebitdaMultiple: submission.ebitda_multiple || '',
    sbaEligible: submission.sba_eligible || 'unknown',
    brokerName: submission.broker_name || '',
    brokerEmail: submission.broker_email || '',
    sellerName: submission.seller_name || '',
    sellerEmail: submission.seller_email || '',
    nextActionAt: submission.next_action_at || '',
    updatedAt: submission.updated_at || '',
    createdAt: submission.created_at || '',
    pipelineStage,
    pipelineTone: pipelineTone(pipelineStage),
    passReason: normalizePassReason(command.passReason),
    fitFeedback: normalizeFitFeedback(command.fitFeedback),
    feedbackNote: normalizeText(command.feedbackNote, 1000),
    feedbackUpdatedAt: command.updatedAt || '',
    recommendation: dealHunter.recommendation || '',
    strengths: Array.isArray(dealHunter.strengths) ? dealHunter.strengths.slice(0, 5) : [],
    concerns: Array.isArray(dealHunter.concerns) ? dealHunter.concerns.slice(0, 5) : [],
    questions: Array.isArray(dealHunter.questions) ? dealHunter.questions.slice(0, 5) : [],
    diligence,
    readiness,
    cimRequest: cimRequest
      ? {
          id: cimRequest.id,
          status: cimRequest.status,
          recipientEmail: cimRequest.recipient_email,
          followUpCount: Number(cimRequest.follow_up_count || 0),
          nextFollowUpAt: cimRequest.next_follow_up_at || '',
          respondedAt: cimRequest.responded_at || '',
          deliveryError: cimRequest.delivery_error || '',
        }
      : null,
    latestUploadRequest,
    documentCount: documents.length,
    emailEngagement,
    followUpPrompt,
  };
}

function actionPriorityValue(priority) {
  if (priority === 'danger') {
    return 0;
  }

  if (priority === 'warning') {
    return 1;
  }

  return 2;
}

export function buildActionQueue(records = [], sourceHealth = {}) {
  const actions = [];

  for (const issue of sourceHealth.issues || []) {
    actions.push({
      id: `source-${issue.sourceId || issue.message}`,
      type: 'source-health',
      priority: issue.tone || 'warning',
      title: issue.title || 'Source health issue',
      message: issue.message,
      dueAt: sourceHealth.generatedAt || '',
      record: null,
    });
  }

  for (const record of records) {
    if (record.pipelineStage === 'passed') {
      continue;
    }

    if (record.followUpPrompt) {
      actions.push({
        id: `follow-up-${record.id}`,
        type: 'follow-up',
        priority: record.followUpPrompt.severity || 'warning',
        title: record.followUpPrompt.title,
        message: record.followUpPrompt.prompt || record.followUpPrompt.message,
        dueAt: record.followUpPrompt.dueAt || record.nextActionAt || '',
        record,
      });
    }

    if (record.score >= 75 && record.pipelineStage === 'new-fit' && record.brokerEmail) {
      actions.push({
        id: `cim-ready-${record.id}`,
        type: 'cim-ready',
        priority: 'warning',
        title: `Request CIM for ${record.company}`,
        message: `Score ${record.score}/100 and broker email is available: ${record.brokerEmail}.`,
        dueAt: record.createdAt,
        record,
      });
    }

    if (['docs-received', 'diligence', 'loi-candidate'].includes(record.pipelineStage) && record.readiness.score < 70) {
      actions.push({
        id: `readiness-${record.id}`,
        type: 'diligence-readiness',
        priority: record.readiness.score < 40 ? 'danger' : 'warning',
        title: `Complete diligence readiness for ${record.company}`,
        message: record.readiness.missing.slice(0, 3).map((item) => item.label).join(', '),
        dueAt: record.nextActionAt || record.updatedAt,
        record,
      });
    }
  }

  return actions
    .sort((left, right) => {
      const priorityDifference = actionPriorityValue(left.priority) - actionPriorityValue(right.priority);

      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return (dateMs(left.dueAt) || Number.MAX_SAFE_INTEGER) - (dateMs(right.dueAt) || Number.MAX_SAFE_INTEGER);
    });
}

function buildPipeline(records = []) {
  const recordsByStage = groupBy(records, (record) => record.pipelineStage);

  return acquisitionPipelineStages.map((stage) => {
    const stageRecords = (recordsByStage.get(stage) || []).sort((left, right) => {
      const scoreDifference = right.score - left.score;

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return dateMs(right.updatedAt || right.createdAt) - dateMs(left.updatedAt || left.createdAt);
    });

    return {
      id: stage,
      count: stageRecords.length,
      records: stageRecords.slice(0, 10),
    };
  });
}

function buildFeedbackSummary(records = []) {
  const falsePositiveReasons = records.reduce((accumulator, record) => {
    if (record.fitFeedback === 'false-positive' && record.passReason) {
      accumulator[record.passReason] = (accumulator[record.passReason] || 0) + 1;
    }

    return accumulator;
  }, {});
  const recommendations = [];

  if ((falsePositiveReasons['fedex-route'] || 0) > 0) {
    recommendations.push('FedEx, package route, and delivery-route exclusions are still catching false positives; keep these terms excluded.');
  }

  if ((falsePositiveReasons['physician-owner-required'] || 0) > 0) {
    recommendations.push('Keep excluding physician-owner and licensed medical practice listings unless a non-physician ownership path is explicit.');
  }

  if ((falsePositiveReasons['too-expensive'] || 0) > 0) {
    recommendations.push('Add stricter price or multiple language when listings exceed your likely ROBS/SBA/seller-note structure.');
  }

  if ((falsePositiveReasons['weak-recurring-revenue'] || 0) > 0) {
    recommendations.push('Require stronger recurring, repeat, maintenance, or contracted revenue language before advancing similar listings.');
  }

  return {
    goodFit: records.filter((record) => record.fitFeedback === 'good-fit').length,
    falsePositive: records.filter((record) => record.fitFeedback === 'false-positive').length,
    falsePositiveReasons,
    recommendations,
  };
}

function parseScheduleTime(value = '10:15') {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return { hour: 10, minute: 15 };
  }

  return {
    hour: Math.max(0, Math.min(Number(match[1]), 23)),
    minute: Math.max(0, Math.min(Number(match[2]), 59)),
  };
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

function sourceSnapshotPath(config) {
  const configuredPath = process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH;

  if (configuredPath) {
    return configuredPath;
  }

  return path.join(path.dirname(config.storage.sqlitePath), 'acquisition-command-center-source-health.json');
}

async function readSourceSnapshot(config) {
  try {
    return JSON.parse(await fs.readFile(sourceSnapshotPath(config), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSourceSnapshot(config, snapshot) {
  try {
    const filePath = sourceSnapshotPath(config);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.warn(`[acquisition-command-center] source health snapshot write failed: ${error.message}`);
  }
}

function isRetiredAirtableSource(source = {}) {
  const id = typeof source === 'string' ? source : source.id || source.sourceId || '';
  const name = typeof source === 'string' ? '' : source.name || '';
  return String(id).toLowerCase().startsWith('airtable') || /airtable/i.test(String(name));
}

function isRequiredDealHunterSource(source = {}) {
  if (source.required === false || source.sourceRole === 'optional-supplemental' || source.id === 'deal-os-export') return false;
  if (source.required === true || source.sourceRole === 'required-primary' || String(source.id || '').startsWith('sheet-')) return true;
  return true;
}

export function buildNextSourceSnapshot(sourceHealth = {}, previousSnapshot = {}, generatedAt = new Date().toISOString()) {
  const previousSources = objectValue(previousSnapshot.sources);
  const issueSourceIds = new Set(
    (sourceHealth.issues || [])
      .map((issue) => issue.sourceId)
      .filter((sourceId) => sourceId && sourceId !== 'daily-update-window'),
  );
  const nextSources = {};

  for (const source of sourceHealth.sources || []) {
    if (isRetiredAirtableSource(source)) continue;
    const previous = objectValue(previousSources[source.id]);

    if (source.fetched && !issueSourceIds.has(source.id)) {
      nextSources[source.id] = {
        rowCount: source.rowCount,
        name: source.name,
        mode: source.mode,
        required: isRequiredDealHunterSource(source),
        sourceRole: source.sourceRole || (isRequiredDealHunterSource(source) ? 'required-primary' : 'optional-supplemental'),
        checkedAt: sourceHealth.generatedAt || generatedAt,
        exportedAt: source.exportedAt || '',
        importedAt: source.importedAt || '',
        importedBy: source.importedBy || '',
        importAgeHours: source.importAgeHours ?? null,
        maxAgeHours: source.maxAgeHours ?? null,
        scope: source.scope || '',
        coverageLabel: source.coverageLabel || '',
        expectedRowCount: source.expectedRowCount ?? null,
        duplicateCount: Number(source.duplicateCount || 0),
        stableIdCount: Number(source.stableIdCount || 0),
        listingUrlCount: Number(source.listingUrlCount || 0),
        coverageLimitReached: Boolean(source.coverageLimitReached),
      };
      continue;
    }

    if (Object.keys(previous).length > 0) {
      nextSources[source.id] = previous;
    }
  }

  for (const [sourceId, previous] of Object.entries(previousSources)) {
    if (isRetiredAirtableSource({ id: sourceId, name: previous?.name })) continue;
    if (!nextSources[sourceId]) {
      nextSources[sourceId] = previous;
    }
  }

  return {
    generatedAt,
    dateKey: sourceHealth.dateKey || previousSnapshot.dateKey || '',
    issues: (sourceHealth.issues || []).filter((issue) => !isRetiredAirtableSource(issue?.sourceId || '')),
    totals: sourceHealth.totals || {},
    sources: nextSources,
  };
}

function buildCachedSourceHealth(previousSnapshot = {}, now = new Date(), config = getConfig()) {
  const sourceSnapshots = objectValue(previousSnapshot.sources);
  const issues = (Array.isArray(previousSnapshot.issues) ? previousSnapshot.issues : [])
    .filter((issue) => !isRetiredAirtableSource(issue?.sourceId || ''))
    .map((issue) => issue?.sourceId === 'deal-os-export'
      ? { ...issue, tone: 'warning', affectsHealth: false }
      : issue);
  const issueSourceIds = new Set(issues.map((issue) => issue?.sourceId).filter(Boolean));
  const sources = Object.entries(sourceSnapshots)
    .filter(([id, source]) => !isRetiredAirtableSource({ id, name: source?.name }))
    .map(([id, source]) => {
    const mode = source.mode || 'cached';
    const required = isRequiredDealHunterSource({ ...source, id });
    const exportedTimestamp = Date.parse(source.exportedAt || '');
    const maxAgeHours = Number(source.maxAgeHours);
    const ageHours = Number.isFinite(exportedTimestamp)
      ? Math.max(0, (now.getTime() - exportedTimestamp) / (60 * 60 * 1000))
      : null;
    const staleManualExport = mode === 'manual-export'
      && Number.isFinite(ageHours)
      && Number.isFinite(maxAgeHours)
      && maxAgeHours > 0
      && ageHours > maxAgeHours;
    const freshnessError = staleManualExport
      ? `The Deal OS export is ${ageHours.toFixed(1)} hours old and exceeds the ${maxAgeHours}-hour freshness limit.`
      : '';

    if (freshnessError && !issueSourceIds.has(id)) {
      issues.push({
        sourceId: id,
        tone: required ? 'danger' : 'warning',
        title: `${source.name || 'Deal source'} needs attention`,
        message: freshnessError,
        affectsHealth: required,
        sourceUnavailable: true,
      });
      issueSourceIds.add(id);
    }

    const sourceIssue = issues.find((issue) => issue?.sourceId === id);
    const sourceUnavailable = sourceIssue?.sourceUnavailable === true;

    return {
      ...source,
      id,
      name: source.name || id,
      mode,
      required,
      sourceRole: source.sourceRole || (required ? 'required-primary' : 'optional-supplemental'),
      fetched: !staleManualExport && !sourceUnavailable,
      rowCount: Number(source.rowCount || 0),
      previousRowCount: Number(source.rowCount || 0),
      rowDelta: 0,
      tone: staleManualExport || sourceUnavailable
        ? (required ? 'danger' : 'warning')
        : sourceIssue?.tone || 'success',
      error: freshnessError || (sourceUnavailable ? sourceIssue?.message || 'Source failed to fetch.' : ''),
      requiresConfiguration: false,
      configurationKey: '',
      checkedAt: source.checkedAt || previousSnapshot.generatedAt || '',
      importAgeHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(1)) : source.importAgeHours ?? null,
    };
  });

  const requiredSources = sources.filter(isRequiredDealHunterSource);

  if (requiredSources.length === 0) {
    return {
      generatedAt: previousSnapshot.generatedAt || now.toISOString(),
      dateKey: previousSnapshot.dateKey || getZonedParts(now, config.dealHunter.dailyEmail.timezone).dateKey,
      afterDailyUpdateWindow: false,
      healthy: false,
      issues: [
        {
          sourceId: 'source-health-cache',
          tone: 'warning',
          title: 'Source health has not been checked yet',
          message: 'Use Deal Hunter > Review Sources to refresh source health before relying on source status.',
        },
      ],
      sources: [],
      totals: previousSnapshot.totals || {},
      cached: true,
    };
  }

  if (!sources.some((source) => source.id === 'deal-os-export')) {
    const message = 'No optional Deal OS CSV/XLSX import is active. Google Sheets remains the required primary source.';
    sources.push({
      id: 'deal-os-export',
      name: 'SMB Deal OS export',
      mode: 'manual-export',
      required: false,
      sourceRole: 'optional-supplemental',
      fetched: false,
      rowCount: 0,
      previousRowCount: 0,
      rowDelta: 0,
      tone: 'warning',
      error: message,
    });
    if (!issueSourceIds.has('deal-os-export')) {
      issues.push({
        sourceId: 'deal-os-export',
        tone: 'warning',
        title: 'Optional Deal OS import is missing',
        message,
        affectsHealth: false,
        sourceUnavailable: true,
      });
    }
  }

  return {
    generatedAt: previousSnapshot.generatedAt || now.toISOString(),
    dateKey: previousSnapshot.dateKey || getZonedParts(now, config.dealHunter.dailyEmail.timezone).dateKey,
    afterDailyUpdateWindow: false,
    healthy: issues.every((issue) => issue?.affectsHealth === false),
    issues,
    sources,
    totals: previousSnapshot.totals || {},
    cached: true,
  };
}

export function buildAcquisitionSourceHealth({ review = null, previousSnapshot = {}, now = new Date(), config = getConfig() } = {}) {
  const sources = (review?.sources || []).filter((source) => !isRetiredAirtableSource(source));
  const issues = [];
  const sourceSnapshots = objectValue(previousSnapshot.sources);
  const schedule = config.dealHunter.dailyEmail;
  const scheduled = parseScheduleTime(schedule.time);
  const zoned = getZonedParts(now, schedule.timezone);
  const updateWindowMinute = scheduled.hour * 60 + scheduled.minute + sourceHealthUpdateBufferMinutes;
  const afterDailyUpdateWindow = zoned.minutesSinceMidnight >= updateWindowMinute;
  const requiredSources = sources.filter(isRequiredDealHunterSource);
  const allRequiredSourcesFetched = requiredSources.length > 0
    && requiredSources.every((source) => source.fetched && !source.error && Number(source.rowCount || 0) > 0);
  const sourceStatuses = sources.map((source) => {
    const required = isRequiredDealHunterSource(source);
    const previous = objectValue(sourceSnapshots[source.id]);
    const rowCount = Number(source.rowCount || 0);
    const previousRowCount = Number(previous.rowCount || 0);
    const rowDelta = previousRowCount ? rowCount - previousRowCount : 0;
    const requiresConfiguration = Boolean(source.requiresConfiguration);
    let tone = source.fetched ? 'success' : required && !requiresConfiguration ? 'danger' : 'warning';
    const sourceIssues = [];

    if (!source.fetched) {
      tone = required && !requiresConfiguration ? 'danger' : 'warning';
      sourceIssues.push(source.error || 'Source failed to fetch.');
    } else if (rowCount === 0) {
      tone = required ? 'danger' : 'warning';
      sourceIssues.push('Source returned zero rows.');
    } else if (previousRowCount > 0 && rowCount < previousRowCount * sourceHealthWarningDropRatio) {
      tone = 'warning';
      sourceIssues.push(`Row count dropped from ${previousRowCount} to ${rowCount}.`);
    }

    for (const message of sourceIssues) {
      issues.push({
        sourceId: source.id,
        tone,
        title: `${source.name || 'Deal source'} needs attention`,
        message,
        affectsHealth: required,
        sourceUnavailable: !source.fetched || rowCount === 0,
      });
    }

    return {
      id: source.id,
      name: source.name,
      mode: source.mode,
      required,
      sourceRole: source.sourceRole || (required ? 'required-primary' : 'optional-supplemental'),
      fetched: Boolean(source.fetched),
      rowCount,
      previousRowCount,
      rowDelta,
      tone,
      error: source.error || '',
      requiresConfiguration,
      configurationKey: source.configurationKey || '',
      exportedAt: source.exportedAt || '',
      importedAt: source.importedAt || '',
      importedBy: source.importedBy || '',
      importAgeHours: source.importAgeHours ?? null,
      maxAgeHours: source.maxAgeHours ?? null,
      scope: source.scope || '',
      coverageLabel: source.coverageLabel || '',
      expectedRowCount: source.expectedRowCount ?? null,
      duplicateCount: Number(source.duplicateCount || 0),
      stableIdCount: Number(source.stableIdCount || 0),
      listingUrlCount: Number(source.listingUrlCount || 0),
      coverageLimitReached: Boolean(source.coverageLimitReached),
    };
  });

  if (requiredSources.length === 0) {
    issues.push({
      sourceId: 'sheet-0',
      tone: 'danger',
      title: 'Required Google Sheet source is missing',
      message: 'The source review did not include the required SMB Deal Hunter Google Sheet.',
      affectsHealth: true,
      sourceUnavailable: true,
    });
  }

  if (!sourceStatuses.some((source) => source.id === 'deal-os-export')) {
    const message = 'No optional Deal OS CSV/XLSX import is active. Google Sheets remains the required primary source.';
    sourceStatuses.push({
      id: 'deal-os-export',
      name: 'SMB Deal OS export',
      mode: 'manual-export',
      required: false,
      sourceRole: 'optional-supplemental',
      fetched: false,
      rowCount: 0,
      previousRowCount: 0,
      rowDelta: 0,
      tone: 'warning',
      error: message,
      requiresConfiguration: false,
      configurationKey: '',
    });
    issues.push({
      sourceId: 'deal-os-export',
      tone: 'warning',
      title: 'Optional Deal OS import is missing',
      message,
      affectsHealth: false,
      sourceUnavailable: true,
    });
  }

  if (afterDailyUpdateWindow && review && allRequiredSourcesFetched && (review.totals?.newDeals || 0) === 0) {
    issues.push({
      sourceId: 'daily-update-window',
      tone: 'warning',
      title: 'No new deals after normal update window',
      message: `No new deals were detected after the ${schedule.time} ${schedule.timezone} update window.`,
      affectsHealth: true,
    });
  }

  return {
    generatedAt: review?.generatedAt || now.toISOString(),
    dateKey: zoned.dateKey,
    afterDailyUpdateWindow,
    healthy: issues.every((issue) => issue?.affectsHealth === false),
    issues,
    sources: sourceStatuses,
    totals: review?.totals || {},
  };
}

export async function getSourceHealth(storage = getStorage(), { persistSnapshot = true, review = null, refresh = false } = {}) {
  const config = getConfig();
  const previousSnapshot = await readSourceSnapshot(config);

  if (!review && !refresh) {
    return buildCachedSourceHealth(previousSnapshot, new Date(), config);
  }

  try {
    const sourceReview = review || await reviewDailyDeals({ markSeen: false, storage });
    const sourceHealth = buildAcquisitionSourceHealth({ review: sourceReview, previousSnapshot, config });

    if (persistSnapshot) {
      await writeSourceSnapshot(config, buildNextSourceSnapshot(sourceHealth, previousSnapshot));
      if (storage.insertSourceHealthSnapshot) {
        await storage.insertSourceHealthSnapshot({
          id: randomUUID(),
          created_at: sourceHealth.generatedAt || new Date().toISOString(),
          healthy: Boolean(sourceHealth.healthy),
          source_count: sourceHealth.sources?.length || 0,
          issue_count: sourceHealth.issues?.length || 0,
          snapshot: sourceHealth,
        });
      }
    }

    return sourceHealth;
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      healthy: false,
      issues: [
        {
          sourceId: 'deal-hunter-review',
          tone: 'danger',
          title: 'Deal source review failed',
          message: error.message || 'Unable to fetch Deal Hunter sources.',
        },
      ],
      sources: [],
      totals: {},
    };
  }
}

export async function getAcquisitionCommandCenter({ storage = getStorage(), persistSourceHealth = true, refreshSourceHealth = false } = {}) {
  const submissionsResult = await storage.listSubmissions({ limit: commandCenterLimit, page: 1, status: 'all' });
  const submissions = submissionsResult.rows || [];
  const related = await loadRelatedSubmissionData(storage, submissions);
  const dealKeys = submissions.map(getDealKey).filter(Boolean);
  const cimRequests = storage.listDealHunterCimRequests
    ? await storage.listDealHunterCimRequests({ dealKeys, limit: commandCenterLimit })
    : [];
  const cimRequestsByDealKey = groupBy(cimRequests, (request) => request.deal_key);
  const now = new Date();
  const records = submissions
    .filter(isAcquisitionCandidate)
    .map((submission) => {
      const documents = related.documentsBySubmission.get(submission.id) || [];
      const emailEvents = [
        ...(related.eventsBySubmission.get(submission.id) || []),
        ...collectContactEmails(submission).flatMap((email) => related.eventsByRecipient.get(email) || []),
      ];

      return commandRecordFromSubmission({
        submission,
        cimRequest: chooseCimRequest(submission, cimRequestsByDealKey),
        documents,
        latestUploadRequest: related.latestUploadBySubmission.get(submission.id) || null,
        emailEvents,
        now,
      });
    });
  const sourceHealth = await getSourceHealth(storage, { persistSnapshot: persistSourceHealth, refresh: refreshSourceHealth });
  const pipeline = buildPipeline(records);
  const actionQueue = buildActionQueue(records, sourceHealth);

  return {
    generatedAt: now.toISOString(),
    summary: {
      totalRecords: records.length,
      score75Plus: records.filter((record) => record.score >= 75).length,
      activeConversations: records.filter((record) =>
        ['cim-requested', 'broker-replied', 'docs-received', 'diligence', 'loi-candidate'].includes(record.pipelineStage),
      ).length,
      actionItems: actionQueue.length,
      sourceIssues: sourceHealth.issues.length,
      lowReadiness: records.filter((record) => ['docs-received', 'diligence', 'loi-candidate'].includes(record.pipelineStage) && record.readiness.score < 70).length,
    },
    pipeline,
    actionQueue,
    sourceHealth,
    feedback: buildFeedbackSummary(records),
    records: records
      .sort((left, right) => {
        const stageDifference = acquisitionPipelineStages.indexOf(left.pipelineStage) - acquisitionPipelineStages.indexOf(right.pipelineStage);

        if (stageDifference !== 0) {
          return stageDifference;
        }

        return right.score - left.score || dateMs(right.updatedAt || right.createdAt) - dateMs(left.updatedAt || left.createdAt);
      })
      .slice(0, 100),
  };
}

export async function updateAcquisitionCommandCenterRecord({
  submissionId = '',
  pipelineStage = '',
  passReason = '',
  fitFeedback = '',
  feedbackNote = '',
  updatedBy = '',
  storage = getStorage(),
} = {}) {
  const id = normalizeText(submissionId, 120);
  const existing = id ? await storage.getSubmission(id) : null;

  if (!existing) {
    return { ok: false, status: 404, error: 'CRM record not found.' };
  }

  const normalizedStage = pipelineStage ? normalizePipelineStage(pipelineStage, '') : '';
  const normalizedPassReason = passReason ? normalizePassReason(passReason) : '';
  const normalizedFeedback = fitFeedback ? normalizeFitFeedback(fitFeedback, '') : '';

  if (pipelineStage && !normalizedStage) {
    return { ok: false, status: 400, error: 'Pipeline stage is not valid.' };
  }

  if (passReason && !normalizedPassReason) {
    return { ok: false, status: 400, error: 'Pass reason is not valid.' };
  }

  if (fitFeedback && !normalizedFeedback) {
    return { ok: false, status: 400, error: 'Fit feedback is not valid.' };
  }

  if (normalizedStage === 'passed' && !normalizedPassReason) {
    return { ok: false, status: 400, error: 'Pass & Archive requires a disposition reason.' };
  }

  if (!normalizedStage && !normalizedPassReason && !normalizedFeedback && feedbackNote === '') {
    return { ok: false, status: 400, error: 'No command center update was provided.' };
  }

  const now = new Date().toISOString();
  const metadata = objectValue(existing.metadata);
  const existingCommand = objectValue(metadata.acquisitionCommand);
  const nextStage = normalizedPassReason ? 'passed' : normalizedStage || existingCommand.pipelineStage || '';
  const nextFeedback = normalizedPassReason ? 'false-positive' : normalizedFeedback || existingCommand.fitFeedback || 'neutral';
  const acquisitionCommand = {
    ...existingCommand,
    ...(nextStage ? { pipelineStage: nextStage } : {}),
    ...(normalizedPassReason ? { passReason: normalizedPassReason } : {}),
    ...(normalizedFeedback || normalizedPassReason ? { fitFeedback: nextFeedback } : {}),
    ...(feedbackNote !== '' ? { feedbackNote: normalizeText(feedbackNote, 1000) } : {}),
    updatedAt: now,
    updatedBy: normalizeText(updatedBy, 160) || 'admin',
  };
  const diligencePatch =
    nextStage === 'passed'
      ? { stage: 'passed', decision: 'pass' }
      : nextStage === 'loi-candidate'
        ? { stage: 'loi-candidate', decision: 'advance' }
        : {};

  if (normalizedPassReason) {
    const archiveResult = await archiveLead({
      submissionId: existing.id,
      reason: archiveReasonForCommandCenterPass(normalizedPassReason),
      note: normalizeText(feedbackNote, 1000),
      actor: acquisitionCommand.updatedBy,
      role: 'admin',
      storage,
      metadataPatch: {
        acquisitionCommand,
        diligence: normalizeDiligenceReview(diligencePatch, metadata.diligence, { now }),
      },
    });

    return archiveResult.ok
      ? {
          ok: true,
          status: archiveResult.status,
          submission: archiveResult.submission,
          acquisitionCommand,
          archived: true,
        }
      : archiveResult;
  }

  const updates = {
    updated_at: now,
    ...(nextStage === 'passed' ? { follow_up_state: 'completed' } : {}),
    metadata: {
      ...metadata,
      acquisitionCommand,
      ...(Object.keys(diligencePatch).length > 0
        ? {
            diligence: normalizeDiligenceReview(diligencePatch, metadata.diligence, { now }),
          }
        : {}),
    },
  };
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_submission',
    payload: { id: existing.id, values: updates },
    activity: {
      submissionId: existing.id,
      eventType: 'diligence.command-center-updated',
      summary: normalizedPassReason
        ? `Deal passed: ${normalizedPassReason}.`
        : `Operations pipeline updated${nextStage ? ` to ${nextStage}` : ''}.`,
      actor: acquisitionCommand.updatedBy,
      role: 'admin',
      metadata: {
        pipelineStage: nextStage,
        passReason: normalizedPassReason,
        fitFeedback: nextFeedback,
      },
    },
  });

  if (!mutation.applied || !mutation.record) {
    return { ok: false, status: 409, error: 'The CRM record changed before the command center update could be saved.' };
  }

  return {
    ok: true,
    status: 200,
    submission: mutation.record,
    acquisitionCommand,
  };
}
