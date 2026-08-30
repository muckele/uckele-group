// Operator triage over persisted Deal Hunter scores.
//
// The queue reads persisted score rows only. It never scores, so opening the
// workspace or paging through it cannot trigger a rebuild.
//
// Triage adds exactly one piece of new operator state: priority. Everything else
// it shows is derived from state that already exists -- "needs review" and
// "changed since reviewed" come from comparing the reviewed fingerprint with the
// current one, dismissal comes from the existing disposition record, and
// acquisition progress stays owned by the command center.

import { recordCrmActivity } from './activity.js';
import { getStorage } from '../storage/index.js';
import {
  dealOperatorPriorities,
  normalizeDealOperatorPriority,
} from './dealHunterScoringPolicy.js';
import {
  getEffectiveOpportunityFacts,
  opportunityFactFields,
} from './dealHunterOpportunityFacts.js';

export const triageViews = Object.freeze([
  'needs-review',
  'high-priority',
  'watchlist',
  'low-confidence',
  'dismissed',
  'all',
]);

export const triageSorts = Object.freeze(['acquisition-priority', 'fit-score', 'confidence', 'completeness', 'scored-at', 'name', 'changed']);

const maxNoteLength = 2000;

function normalizeText(value = '', maxLength = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeView(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageViews.includes(normalized) ? normalized : 'needs-review';
}

function normalizeSort(value, fallback = 'fit-score') {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageSorts.includes(normalized) ? normalized : fallback;
}

function normalizeConfidence(value) {
  const normalized = normalizeText(value, 20).toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

function normalizeBoundedInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), maximum));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(normalized) ? normalized : null;
}

function queueGeography(row = {}) {
  const label = normalizeText(row.location, 240);
  const state = normalizeText(row.state, 40).toUpperCase();
  const [city = ''] = label.split(',');
  return {
    city: normalizeText(city, 160),
    state,
    label: label || state,
  };
}

function publicTriageSummary(summary = {}) {
  return {
    needsReview: Number(summary.needsReview || summary.needs_review || 0),
    highPriority: Number(summary.highPriority || summary.high_priority || 0),
    watchlist: Number(summary.watchlist || 0),
    lowConfidence: Number(summary.lowConfidence || summary.low_confidence || 0),
    currentOpportunities: Number(summary.currentOpportunities || summary.current_opportunities || 0),
  };
}

// The list row an operator scans. Fit and confidence stay separate values;
// there is deliberately no blended certainty number. Detail and decision
// responses can explicitly retain the persisted operator note.
export function publicTriageRow(row = {}, { includeOperatorNote = false } = {}) {
  return {
    opportunityId: row.opportunity_id,
    dealKey: row.deal_key || '',
    name: row.name || 'Unnamed opportunity',
    state: row.state || '',
    listingUrl: row.listing_url || '',
    fitScore: Number(row.fit_score || 0),
    scoreStatus: row.score_status || 'provisional',
    confidence: row.confidence || 'low',
    completenessScore: Number(row.completeness_score || 0),
    missingEvidenceCount: Number(row.missing_evidence_count || 0),
    contradictionCount: Number(row.contradiction_count || 0),
    shouldRemove: Boolean(row.should_remove),
    highFit: Boolean(row.high_fit),
    geography: queueGeography(row),
    industry: normalizeText(row.industry, 240),
    financials: {
      annualProfit: nullableNumber(row.annual_profit),
      annualRevenue: nullableNumber(row.annual_revenue),
      askingPrice: nullableNumber(row.asking_price),
      profitMultiple: nullableNumber(row.profit_multiple),
    },
    topStrength: normalizeText(row.top_strength, 400),
    topConcern: normalizeText(row.top_concern, 400),
    workflow: {
      crmStatus: normalizeText(row.crm_status, 80) || 'not-started',
      cimStatus: normalizeText(row.cim_status, 80) || 'not-requested',
    },
    observationFreshness: row.observation_freshness || row.scored_at || '',
    operatorPriority: row.operator_priority || 'normal',
    ...(includeOperatorNote ? { operatorNote: row.operator_note || '' } : {}),
    reviewed: Boolean(row.reviewed),
    reviewedAt: row.reviewed_at || '',
    reviewedBy: row.reviewed_by || '',
    changedSinceReview: Boolean(row.changed_since_review),
    dismissed: Boolean(row.dismissed_at || row.dismissed_reason),
    dismissedReason: row.dismissed_reason || '',
    scoredAt: row.scored_at || '',
    scoreFingerprint: row.score_fingerprint || '',
    rulesVersion: row.rules_version || '',
  };
}

export async function listTriageQueue({
  view = 'needs-review',
  page = 1,
  pageSize = 25,
  search = '',
  sort = '',
  direction = 'desc',
  minScore = null,
  confidence = '',
  priority = '',
  state = '',
  storage = getStorage(),
} = {}) {
  if (typeof storage.listDealHunterOpportunityScores !== 'function') {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }
  const normalizedView = normalizeView(view);
  const normalizedSort = normalizeSort(
    sort,
    normalizedView === 'needs-review' ? 'acquisition-priority' : 'fit-score',
  );
  const normalizedDirection = normalizedSort === 'acquisition-priority'
    ? 'desc'
    : (normalizeText(direction, 8).toLowerCase() === 'asc' ? 'asc' : 'desc');
  const result = await storage.listDealHunterOpportunityScores({
    view: normalizedView,
    page: normalizeBoundedInteger(page, 1, 10000),
    pageSize: normalizeBoundedInteger(pageSize, 25, 100),
    search: normalizeText(search, 160),
    sort: normalizedSort,
    direction: normalizedDirection,
    minScore: minScore === null || minScore === '' || !Number.isFinite(Number(minScore)) ? null : Number(minScore),
    confidence: normalizeConfidence(confidence),
    priority: priority ? normalizeDealOperatorPriority(priority, '') : '',
    state: normalizeText(state, 12),
  });

  return {
    ok: true,
    status: 200,
    view: normalizedView,
    sort: normalizedSort,
    direction: normalizedDirection,
    rows: (result.rows || []).map(publicTriageRow),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    summary: publicTriageSummary(result.summary),
    views: triageViews,
    priorities: dealOperatorPriorities,
  };
}

function safeListingUrl(value) {
  const raw = normalizeText(value, 2000);
  if (!raw || [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

function directCrmFactRows(submission = {}) {
  if (!submission || typeof submission !== 'object') return [];
  const dealHunter = submission.metadata?.dealHunter && typeof submission.metadata.dealHunter === 'object'
    ? submission.metadata.dealHunter
    : {};
  const fields = [
    ['seller_name', ['seller_name', 'sellerName']],
    ['seller_email', ['seller_email', 'sellerEmail']],
    ['seller_phone', ['seller_phone', 'sellerPhone']],
    ['broker_name', ['broker_name', 'brokerName']],
    ['broker_company', ['broker_company', 'brokerCompany']],
    ['broker_email', ['broker_email', 'brokerEmail']],
    ['broker_phone', ['broker_phone', 'brokerPhone']],
    ['reason_for_sale', ['reason_for_sale', 'reasonForSale']],
    ['real_estate_included', ['real_estate_included', 'realEstateIncluded']],
    ['seller_financing', ['seller_financing', 'sellerFinancing']],
    ['management_structure', ['management_structure', 'managementStructure']],
    ['customer_concentration', ['customer_concentration', 'customerConcentration']],
    ['operator_contact_notes', ['operator_contact_notes', 'operatorContactNotes']],
  ];
  return fields.flatMap(([field, keys]) => {
    const value = keys.map((key) => submission[key] ?? dealHunter[key]).find((item) => normalizeText(item, 4000));
    return value === undefined ? [] : [{ field, value }];
  });
}

function projectSourceObservations(rows = []) {
  const all = rows.slice(0, 500).map((row) => ({
    sourceId: row.source_id || '', sourceName: row.source_name || '', sourceRecordId: row.source_record_id || '',
    field: row.field || '', value: ['listing_url', 'prospectus_url', 'business_website'].includes(row.field) ? safeListingUrl(row.value) : normalizeText(row.value, 5000), observedAt: row.observed_at || '', updatedAt: row.updated_at || '',
  }));
  const valuesByField = new Map();
  for (const row of all) {
    const key = row.field;
    const values = valuesByField.get(key) || [];
    values.push(row);
    valuesByField.set(key, values);
  }
  const conflicts = [...valuesByField.entries()].flatMap(([field, values]) => {
    const distinct = new Set(values.map((item) => normalizeText(item.value, 5000)));
    return distinct.size > 1 ? [{ field, observations: values.map(({ sourceId, sourceName, sourceRecordId, value, observedAt }) => ({ sourceId, sourceName, sourceRecordId, value, observedAt })) }] : [];
  });
  const groups = new Map();
  for (const row of all) {
    const key = [row.sourceId, row.sourceRecordId].join('\u0000');
    const group = groups.get(key) || {
      sourceId: row.sourceId, sourceName: row.sourceName, sourceRecordId: row.sourceRecordId,
      observedAt: row.observedAt, values: {}, conflicts: [],
    };
    group.values[row.field] = row.value;
    if (Date.parse(row.observedAt || '') > Date.parse(group.observedAt || '')) group.observedAt = row.observedAt;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.conflicts = conflicts.filter((conflict) => conflict.observations.some((item) => (
      item.sourceId === group.sourceId && item.sourceRecordId === group.sourceRecordId
    )));
  }
  return { sourceObservations: [...groups.values()].slice(0, 100), conflicts };
}

function criticalMissingFields({ effectiveFacts, sourceRows, summary, listingUrls }) {
  const sourceValues = new Map();
  for (const row of sourceRows) {
    if (normalizeText(row.value, 5000)) sourceValues.set(row.field, row.value);
  }
  const financials = summary.financials || {};
  const present = (field, alternatives = []) => {
    if (effectiveFacts[field]?.value) return true;
    if (sourceValues.get(field)) return true;
    return alternatives.some((key) => financials[key] !== null && financials[key] !== undefined && financials[key] !== '');
  };
  const fields = [
    ['seller_name'], ['seller_email'], ['seller_phone'], ['broker_name'], ['broker_email'], ['broker_phone'],
    ['annual_profit', ['annualProfit']], ['annual_revenue', ['annualRevenue']], ['asking_price', ['askingPrice']],
    ['customer_concentration'], ['management_structure'], ['reason_for_sale'], ['real_estate_included'], ['seller_financing'],
  ];
  const missing = fields.filter(([field, alternatives]) => !present(field, alternatives)).map(([field]) => field);
  if (listingUrls.length === 0) missing.push('listing_url');
  return missing;
}

function projectScore(score, byDimension, unattributed) {
  return {
    fitScore: Number(score.fit_score || 0),
    scoreStatus: score.score_status || 'provisional',
    confidence: score.confidence || 'low',
    completenessScore: Number(score.completeness_score || 0),
    dimensions: (score.dimensions || []).map((dimension) => ({ ...dimension, evidence: byDimension.get(dimension.id) || [] })),
    unattributedEvidence: unattributed,
    appliedCaps: score.applied_caps || [], gates: score.gates || [], confidenceReasons: score.confidence_reasons || [],
    missingEvidence: score.missing_evidence || [], summary: score.summary || {},
  };
}

function projectCrmSubmission(submission) {
  if (!submission) return null;
  return {
    id: submission.id || '', status: submission.status || '', company: submission.company || '',
    sellerName: submission.seller_name || submission.sellerName || '', sellerEmail: submission.seller_email || submission.sellerEmail || '',
    brokerName: submission.broker_name || submission.brokerName || submission.metadata?.dealHunter?.brokerName || '',
    brokerEmail: submission.broker_email || submission.brokerEmail || submission.metadata?.dealHunter?.brokerEmail || '',
    updatedAt: submission.updated_at || '',
  };
}

export async function getTriageOpportunityDetail({ opportunityId = '', storage = getStorage() } = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (
    typeof storage.getCurrentDealHunterOpportunityScore !== 'function'
    || typeof storage.getCurrentDealHunterOpportunity !== 'function'
  ) {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }
  const [currentOpportunity, score] = await Promise.all([
    storage.getCurrentDealHunterOpportunity(id), storage.getCurrentDealHunterOpportunityScore(id),
  ]);
  if (!currentOpportunity || !score) return { ok: false, status: 404, error: 'No current score has been recorded for this opportunity.' };
  const evidence = await storage.listDealHunterScoreEvidence?.(id, { limit: 500 }) || [];

  // Evidence is grouped by dimension so an operator sees why a dimension landed
  // where it did without reading raw rows.
  const byDimension = new Map();
  const unattributed = [];
  for (const row of evidence) {
    const projected = {
      ruleId: row.rule_id,
      ruleLabel: row.rule_label,
      evidenceClass: row.evidence_class,
      field: row.field || '',
      value: row.value,
      observedValue: row.observed_value,
      terms: row.terms || [],
      sourceId: row.source_id || '',
      sourceName: row.source_name || '',
      sourceRecordId: row.source_record_id || '',
      listingUrl: safeListingUrl(row.listing_url),
      observedAt: row.observed_at || '',
    };
    if (!row.dimension) {
      unattributed.push(projected);
      continue;
    }
    const rows = byDimension.get(row.dimension) || [];
    rows.push(projected);
    byDimension.set(row.dimension, rows);
  }

  const [operatorFacts, sourceRows, submission, cimRequests, activities, dispositions, crmCommunications] = await Promise.all([
    storage.listDealHunterOpportunityFacts?.(id, { limit: 100 }) || [],
    storage.listDealHunterOpportunitySourceObservations?.(id, { limit: 500 }) || [],
    currentOpportunity.primary_submission_id && storage.getSubmission
      ? storage.getSubmission(currentOpportunity.primary_submission_id)
      : null,
    storage.listDealHunterCimRequests?.({ opportunityIds: [id], limit: 100 }) || [],
    currentOpportunity.primary_submission_id && storage.listCrmActivityEvents
      ? storage.listCrmActivityEvents({ submissionId: currentOpportunity.primary_submission_id, limit: 100 })
      : [],
    storage.listDealHunterDispositions?.({ dealKeys: [score.deal_key], limit: 20 }) || [],
    currentOpportunity.primary_submission_id && storage.listCrmCommunications
      ? storage.listCrmCommunications({ submissionId: currentOpportunity.primary_submission_id, page: 1, pageSize: 100 })
      : { rows: [] },
  ]);
  const sourceFacts = sourceRows.filter((row) => opportunityFactFields.includes(row.field));
  const crmFacts = directCrmFactRows(submission);
  const effectiveFacts = getEffectiveOpportunityFacts({
    opportunityId: id,
    operatorFacts,
    crmFacts,
    sourceFacts,
  });
  const { sourceObservations } = projectSourceObservations(sourceRows);
  const listingUrls = [...new Set([
    safeListingUrl(score.listing_url),
    ...sourceRows
      .filter((row) => row.field === 'listing_url')
      .map((row) => safeListingUrl(row.value)),
  ].filter(Boolean))].slice(0, 100);
  const opportunity = publicTriageRow(score, { includeOperatorNote: true });
  opportunity.listingUrl = safeListingUrl(score.listing_url);
  const projectedScore = projectScore(score, byDimension, unattributed);
  const communications = (crmCommunications?.rows || []).slice(0, 100).map((communication) => ({
    id: communication.id || '', direction: communication.direction || '', channel: communication.channel || '',
    kind: communication.kind || '', occurredAt: communication.occurred_at || '', deliveryState: communication.delivery_state || '',
    cimRequestId: communication.cim_request_id || '',
  }));
  return {
    ok: true,
    status: 200,
    opportunity,
    effectiveFacts,
    operatorFacts: operatorFacts.slice(0, 100),
    sourceObservations,
    missingCriticalFields: criticalMissingFields({ effectiveFacts, sourceRows, summary: opportunity, listingUrls }),
    listingUrls,
    score: projectedScore,
    cimSummary: {
      requests: cimRequests.slice(0, 100).map((item) => ({ id: item.id || '', status: item.status || '', requestState: item.request_state || '', deliveryState: item.delivery_state || '', updatedAt: item.updated_at || '' })),
      communications: communications.filter((communication) => communication.cimRequestId),
    },
    crmSummary: {
      submission: projectCrmSubmission(submission), communications,
      factObservations: crmFacts.slice(0, 13).map((fact) => ({ field: fact.field, value: normalizeText(fact.value, 4000), provenance: 'crm' })),
      conflicts: crmFacts.filter((fact) => effectiveFacts[fact.field]?.provenance !== 'crm' && effectiveFacts[fact.field]?.value !== String(fact.value).trim())
        .map((fact) => ({ field: fact.field, winningProvenance: effectiveFacts[fact.field]?.provenance || '', crmValue: normalizeText(fact.value, 4000) })),
    },
    history: {
      activities: activities.slice(0, 100).map((item) => ({ id: item.id || '', eventType: item.event_type || '', summary: normalizeText(item.summary, 500), createdAt: item.created_at || '', actor: normalizeText(item.actor, 160) })),
      dispositions: dispositions.slice(0, 20).map((item) => ({ id: item.id || '', disposition: item.disposition || '', reason: item.reason || '', note: normalizeText(item.note, 500), dismissedAt: item.dismissed_at || '', dismissedBy: normalizeText(item.dismissed_by, 160) })),
      operatorFacts: operatorFacts.slice(0, 100).map((item) => ({ id: item.id || '', field: item.field || '', value: normalizeText(item.value, 4000), verified: Boolean(item.verified), actor: normalizeText(item.actor, 160), note: normalizeText(item.note, 500), createdAt: item.created_at || '', updatedAt: item.updated_at || '' })),
      operatorState: {
        priority: opportunity.operatorPriority, note: opportunity.operatorNote,
        reviewed: opportunity.reviewed, reviewedAt: opportunity.reviewedAt, reviewedBy: opportunity.reviewedBy,
      },
    },
  };
}

/**
 * Record an operator decision.
 *
 * Only priority, note, and review acknowledgement are writable. There is no
 * numeric score override: the machine's judgment and the human's judgment stay
 * separately legible.
 */
export async function setTriageOperatorDecision({
  opportunityId = '',
  priority,
  note,
  markReviewed = false,
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (
    typeof storage.setDealHunterOpportunityOperatorDecision !== 'function'
    || typeof storage.getCurrentDealHunterOpportunityScore !== 'function'
  ) {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }

  const current = await storage.getCurrentDealHunterOpportunityScore(id);
  if (!current) return { ok: false, status: 404, error: 'No score has been recorded for this opportunity.' };

  const decision = { opportunityId: id };
  if (priority !== undefined) {
    const normalized = normalizeDealOperatorPriority(priority, '');
    if (!normalized) {
      return { ok: false, status: 400, error: `Priority must be one of ${dealOperatorPriorities.join(', ')}.` };
    }
    decision.priority = normalized;
  }
  if (note !== undefined) decision.note = note === null ? null : normalizeText(note, maxNoteLength);
  if (markReviewed) {
    decision.reviewed = true;
    decision.reviewedBy = normalizeText(actor, 160) || 'admin';
    // Snapshotting what the operator actually saw is what makes "changed since
    // reviewed" meaningful later. The semantic digest is the one that decides
    // staleness; the fingerprint is kept for provenance and legacy rows.
    decision.reviewedFingerprint = current.score_fingerprint;
    decision.reviewedSemanticDigest = current.semantic_digest;
  }
  if (decision.priority === undefined && decision.note === undefined && !decision.reviewed) {
    return { ok: false, status: 400, error: 'No operator decision was provided.' };
  }

  const updated = await storage.setDealHunterOpportunityOperatorDecision(decision);

  const opportunity = await storage.getCurrentDealHunterOpportunity?.(id);
  const submissionId = opportunity?.primary_submission_id || '';
  if (submissionId) {
    const parts = [];
    if (decision.priority) parts.push(`priority ${decision.priority}`);
    if (decision.reviewed) parts.push('marked reviewed');
    if (decision.note !== undefined) parts.push('note updated');
    await recordCrmActivity({
      storage,
      submissionId,
      opportunityId: id,
      eventType: 'opportunity.triaged',
      summary: `Operator triage: ${parts.join(', ')}.`,
      actor: normalizeText(actor, 160) || 'admin',
      role: 'admin',
      metadata: {
        priority: decision.priority || updated?.operator_priority || null,
        markedReviewed: Boolean(decision.reviewed),
        reviewedFingerprint: decision.reviewedFingerprint || null,
        fitScoreAtDecision: current.fit_score,
      },
    });
  }

  return { ok: true, status: 200, opportunity: publicTriageRow(updated, { includeOperatorNote: true }) };
}
