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

export const triageViews = Object.freeze([
  'needs-review',
  'high-priority',
  'watchlist',
  'low-confidence',
  'dismissed',
  'all',
]);

export const triageSorts = Object.freeze(['fit-score', 'confidence', 'completeness', 'scored-at', 'name', 'changed']);

const maxNoteLength = 2000;

function normalizeText(value = '', maxLength = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeView(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageViews.includes(normalized) ? normalized : 'needs-review';
}

function normalizeSort(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageSorts.includes(normalized) ? normalized : 'fit-score';
}

function normalizeConfidence(value) {
  const normalized = normalizeText(value, 20).toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

// The row an operator scans. Fit and confidence stay separate values; there is
// deliberately no blended certainty number.
export function publicTriageRow(row = {}) {
  const dimensions = Array.isArray(row.dimensions) ? row.dimensions : [];
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
    missingEvidence: Array.isArray(row.missing_evidence) ? row.missing_evidence : [],
    contradictionCount: Number(row.contradiction_count || 0),
    confidenceReasons: Array.isArray(row.confidence_reasons) ? row.confidence_reasons : [],
    gates: Array.isArray(row.gates) ? row.gates : [],
    shouldRemove: Boolean(row.should_remove),
    highFit: Boolean(row.high_fit),
    dimensions: dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      contribution: Number(dimension.contribution || 0),
      verdict: dimension.verdict || 'absent',
      missingCount: Array.isArray(dimension.missing) ? dimension.missing.length : 0,
      contradictionCount: Array.isArray(dimension.contradictions) ? dimension.contradictions.length : 0,
    })),
    topReasons: [
      ...(row.summary?.strengths || []).slice(0, 1),
      ...(row.summary?.concerns || []).slice(0, 1),
    ],
    recommendation: row.summary?.recommendation || '',
    operatorPriority: row.operator_priority || 'normal',
    operatorNote: row.operator_note || '',
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
  sort = 'fit-score',
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
  const result = await storage.listDealHunterOpportunityScores({
    view: normalizeView(view),
    page,
    pageSize,
    search: normalizeText(search, 160),
    sort: normalizeSort(sort),
    direction: normalizeText(direction, 8).toLowerCase() === 'asc' ? 'asc' : 'desc',
    minScore: minScore === null || minScore === '' || !Number.isFinite(Number(minScore)) ? null : Number(minScore),
    confidence: normalizeConfidence(confidence),
    priority: priority ? normalizeDealOperatorPriority(priority, '') : '',
    state: normalizeText(state, 12),
  });

  return {
    ok: true,
    status: 200,
    view: normalizeView(view),
    sort: normalizeSort(sort),
    direction: normalizeText(direction, 8).toLowerCase() === 'asc' ? 'asc' : 'desc',
    rows: (result.rows || []).map(publicTriageRow),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    views: triageViews,
    priorities: dealOperatorPriorities,
  };
}

export async function getTriageOpportunityDetail({ opportunityId = '', storage = getStorage() } = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (typeof storage.getDealHunterOpportunityScore !== 'function') {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }
  const score = await storage.getDealHunterOpportunityScore(id);
  if (!score) return { ok: false, status: 404, error: 'No score has been recorded for this opportunity.' };
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
      listingUrl: row.listing_url || '',
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

  const summary = publicTriageRow(score);
  return {
    ok: true,
    status: 200,
    opportunity: summary,
    dimensions: (score.dimensions || []).map((dimension) => ({
      ...dimension,
      evidence: byDimension.get(dimension.id) || [],
    })),
    unattributedEvidence: unattributed,
    appliedCaps: score.applied_caps || [],
    gates: score.gates || [],
    confidenceReasons: score.confidence_reasons || [],
    missingEvidence: score.missing_evidence || [],
    summary: score.summary || {},
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
  if (typeof storage.setDealHunterOpportunityOperatorDecision !== 'function') {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }

  const current = await storage.getDealHunterOpportunityScore(id);
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

  const opportunity = await storage.getDealHunterOpportunity?.(id);
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

  return { ok: true, status: 200, opportunity: publicTriageRow(updated) };
}
