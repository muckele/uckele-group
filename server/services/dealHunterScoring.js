// Deterministic, explainable Deal Hunter opportunity scoring.
//
// Phase 3A does not compute a new score. It records the score the existing
// `deal-hunter-fit-v2` scorer already computes, attributing every point, cap,
// and disqualification to a dimension and to source evidence. `fitScore` is
// therefore identical to the v2 `score` by construction, not by approximation:
// the ledger observes the same code path rather than re-deriving it.
//
// There are no model calls here and no configuration that would make one
// possible. Scoring works with no provider configured.

import { createHash } from 'node:crypto';
import { scoreDeal } from './dealHunter.js';
import { DEAL_SEMANTIC_MATCHER_VERSION } from './dealHunterSemanticMatcher.js';
import {
  DEAL_COMPLETENESS_POLICY_VERSION,
  DEAL_SCORING_ENGINE_VERSION,
  DEAL_SCORING_PROFILE_VERSION,
  DEAL_SCORING_RULES_VERSION,
  dealScoreDimensions,
  dealScoreFieldDimensions,
  dealScoreRules,
} from './dealHunterScoringPolicy.js';

// Only the fields the scorer or the completeness policy actually reads. Volatile
// bookkeeping -- first/last seen, isNew, generated notes, per-run metadata, and
// fields such as netMargin that no scoring branch consults -- is deliberately
// excluded so an unchanged listing keeps an unchanged fingerprint.
export const dealScoreFingerprintFields = Object.freeze([
  'name',
  'industry',
  'description',
  'city',
  'county',
  'state',
  'country',
  'location',
  'annualProfit',
  'annualRevenue',
  'askingPrice',
  'profitMultiple',
  'yearsEstablished',
  'fiveYearsFlag',
  'remoteFlag',
  'franchiseFlag',
  'listingUrl',
  'brokerName',
  'brokerEmail',
  'brokerContact',
  'fullText',
]);

const maxEvidenceRows = 200;
const maxTermsPerRow = 8;

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return String(value).replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function dealScoreFingerprintInput(deal = {}) {
  const inputs = {};
  for (const field of dealScoreFingerprintFields) {
    inputs[field] = normalizeValue(deal[field]);
  }
  return {
    inputs,
    engineVersion: DEAL_SCORING_ENGINE_VERSION,
    rulesVersion: DEAL_SCORING_RULES_VERSION,
    profileVersion: DEAL_SCORING_PROFILE_VERSION,
    completenessPolicyVersion: DEAL_COMPLETENESS_POLICY_VERSION,
    // The matcher decides which keyword occurrences count, so its version is a
    // scoring input: a matcher change must stale every stored fingerprint.
    matcherVersion: DEAL_SEMANTIC_MATCHER_VERSION,
  };
}

export function dealScoreFingerprint(deal = {}) {
  return sha256(JSON.stringify(dealScoreFingerprintInput(deal)));
}

/**
 * Digest of what a score *concludes*, ignoring how it was computed.
 *
 * The fingerprint answers "should this be rescored" and therefore includes the
 * rules and matcher versions. This digest answers the different question "should
 * a human look again", so it deliberately excludes every version field. A rules
 * bump that reproduces the same conclusions leaves this digest unchanged, which
 * is what stops a version bump from flooding the review queue.
 */
export function dealSemanticDigest(result = {}) {
  return sha256(JSON.stringify({
    fitScore: result.fitScore ?? null,
    scoreStatus: result.scoreStatus || '',
    shouldRemove: Boolean(result.shouldRemove),
    confidence: result.confidence || '',
    completenessScore: result.completenessScore ?? null,
    highFit: result.actionEligibility?.highFit === true,
    cimRequest: result.actionEligibility?.cimRequest === true,
    gates: (result.gates || []).map((gate) => gate.ruleId).sort(),
    appliedCaps: (result.appliedCaps || []).map((cap) => `${cap.ruleId}:${cap.cap}`).sort(),
    dimensions: (result.dimensions || [])
      .map((dimension) => ({ id: dimension.id, contribution: dimension.contribution, verdict: dimension.verdict }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    missingEvidence: [...(result.missingEvidence || [])].sort(),
    contradictionCount: result.contradictionCount ?? 0,
  }));
}

function provenanceFor(deal, field) {
  const entry = deal.fieldProvenance?.[field];
  return {
    sourceId: entry?.sourceId || deal.sourceId || '',
    sourceName: entry?.sourceName || deal.sourceName || '',
    sourceRecordId: entry?.sourceRecordId || deal.id || '',
    listingUrl: entry?.listingUrl || deal.listingUrl || '',
    observedAt: entry?.observedAt || deal.lastUpdated || deal.dateAdded || '',
  };
}

// The ledger is passed into the untouched v2 scorer, which calls it as each rule
// fires. It never influences the arithmetic; it only records what happened.
export function createScoreLedger(deal = {}) {
  const adjustments = [];
  const absences = [];
  const gates = [];
  const floors = [];
  let baselinePoints = 0;
  let finalized = null;

  function evidenceRow(ruleId, { field = '', value, terms } = {}) {
    const rule = dealScoreRules[ruleId] || {};
    return {
      ruleId,
      ruleLabel: rule.label || ruleId,
      dimension: rule.dimension || null,
      evidenceClass: rule.evidenceClass || 'calculated',
      field,
      value: value === undefined ? null : normalizeValue(value),
      terms: Array.isArray(terms) ? terms.slice(0, maxTermsPerRow) : [],
      ...provenanceFor(deal, field),
    };
  }

  return {
    baseline(points) {
      baselinePoints = points;
    },
    adjust(ruleId, delta, context = {}) {
      adjustments.push({ ruleId, delta, evidence: evidenceRow(ruleId, context) });
    },
    absent(ruleId, context = {}) {
      absences.push({ ruleId, evidence: evidenceRow(ruleId, context) });
    },
    gate(ruleId, reason, context = {}) {
      gates.push({ ruleId, reason, evidence: evidenceRow(ruleId, context) });
    },
    floor(ruleId, floorValue) {
      floors.push({ ruleId, floor: floorValue });
    },
    finalize(result) {
      finalized = result;
    },
    read() {
      return { adjustments, absences, gates, floors, baselinePoints, finalized };
    },
  };
}

function verdictFor({ positive, negative, absent }) {
  if (positive > 0 && negative > 0) return 'mixed';
  if (negative > 0) return 'negative';
  if (positive > 0) return 'supported';
  if (absent > 0) return 'absent';
  return 'absent';
}

function buildDimensions(ledgerState, contradictionsByField) {
  const byId = new Map(dealScoreDimensions.map((dimension) => [dimension.id, {
    id: dimension.id,
    label: dimension.label,
    summary: dimension.summary,
    contribution: 0,
    positivePoints: 0,
    negativePoints: 0,
    caps: [],
    rules: [],
    missing: [],
    contradictions: [],
  }]));

  for (const item of ledgerState.adjustments) {
    const dimensionId = item.evidence.dimension;
    if (!dimensionId || !byId.has(dimensionId)) continue;
    const dimension = byId.get(dimensionId);
    dimension.contribution += item.delta;
    if (item.delta >= 0) dimension.positivePoints += item.delta;
    else dimension.negativePoints += Math.abs(item.delta);
    dimension.rules.push({ ruleId: item.ruleId, label: item.evidence.ruleLabel, delta: item.delta });
  }

  for (const item of ledgerState.absences) {
    const dimensionId = item.evidence.dimension;
    if (!dimensionId || !byId.has(dimensionId)) continue;
    const dimension = byId.get(dimensionId);
    dimension.missing.push({ ruleId: item.ruleId, label: item.evidence.ruleLabel, field: item.evidence.field });
    dimension.rules.push({ ruleId: item.ruleId, label: item.evidence.ruleLabel, delta: 0 });
  }

  for (const cap of ledgerState.finalized?.caps || []) {
    const dimensionId = dealScoreRules[cap.ruleId]?.dimension;
    if (!dimensionId || !byId.has(dimensionId)) continue;
    byId.get(dimensionId).caps.push({ ruleId: cap.ruleId, cap: cap.cap, reason: cap.reason, applied: Boolean(cap.applied) });
  }

  // A contradiction is attributed to a dimension only when the disputed field
  // unambiguously belongs to one. Narrative fields inform several dimensions and
  // stay unattributed rather than being assigned arbitrarily.
  for (const [field, conflicts] of contradictionsByField.entries()) {
    const dimensionId = dealScoreFieldDimensions[field];
    if (!dimensionId || !byId.has(dimensionId)) continue;
    byId.get(dimensionId).contradictions.push(...conflicts.map((conflict) => ({
      field,
      canonicalValue: conflict.value,
      observedValue: conflict.observedValue,
      conflictingSourceId: conflict.conflictingSourceId,
    })));
  }

  return [...byId.values()].map((dimension) => ({
    ...dimension,
    verdict: verdictFor({
      positive: dimension.positivePoints,
      negative: dimension.negativePoints,
      absent: dimension.missing.length,
    }),
  }));
}

function contradictionEvidence(deal) {
  const conflicts = Array.isArray(deal.fieldConflicts) ? deal.fieldConflicts : [];
  return conflicts.slice(0, 50).map((conflict) => ({
    ruleId: 'evidence.contradiction',
    ruleLabel: `Sources disagree on ${conflict.field}`,
    dimension: null,
    evidenceClass: 'contradicted',
    field: conflict.field || '',
    value: normalizeValue(conflict.canonicalValue),
    observedValue: normalizeValue(conflict.observedValue),
    terms: [],
    sourceId: conflict.canonicalSource?.sourceId || '',
    sourceName: conflict.canonicalSource?.sourceName || '',
    sourceRecordId: conflict.canonicalSource?.sourceRecordId || '',
    listingUrl: conflict.canonicalSource?.listingUrl || '',
    observedAt: conflict.canonicalSource?.observedAt || '',
    conflictingSourceId: conflict.observedSource?.sourceId || '',
  }));
}

/**
 * Score one canonical opportunity.
 *
 * Returns the v2 score together with the decomposition needed to explain it.
 * Pure and synchronous: no storage, no network, no model.
 */
export function scoreOpportunity(deal = {}) {
  const ledger = createScoreLedger(deal);
  const scored = scoreDeal(deal, ledger);
  const state = ledger.read();

  const contradictions = contradictionEvidence(deal);
  const contradictionsByField = new Map();
  for (const row of contradictions) {
    const rows = contradictionsByField.get(row.field) || [];
    rows.push(row);
    contradictionsByField.set(row.field, rows);
  }

  const dimensions = buildDimensions(state, contradictionsByField);
  const evidence = [
    ...state.adjustments.map((item) => item.evidence),
    ...state.absences.map((item) => item.evidence),
    ...state.gates.map((item) => item.evidence),
    ...contradictions,
    ...(scored.missingEvidence || []).map((field) => ({
      ruleId: 'completeness.missing-field',
      ruleLabel: `Source did not supply ${field}`,
      dimension: null,
      evidenceClass: 'missing',
      field,
      value: null,
      terms: [],
      ...provenanceFor(deal, field),
    })),
  ].slice(0, maxEvidenceRows);

  const gates = state.gates.map((item) => ({ ruleId: item.ruleId, reason: item.reason }));
  const appliedCaps = (state.finalized?.caps || [])
    .filter((cap) => cap.applied)
    .map((cap) => ({ ruleId: cap.ruleId || '', cap: cap.cap, reason: cap.reason }));

  const confidenceReasons = [];
  if (scored.completenessScore < 55) confidenceReasons.push('Fewer than half of the expected listing fields were supplied.');
  else if (scored.completenessScore < 80) confidenceReasons.push('Some expected listing fields were not supplied.');
  for (const row of contradictions) {
    confidenceReasons.push(`Sources disagree on ${row.field}; the canonical value was preserved.`);
  }

  const result = {
    // `fitScore` is the v2 score verbatim. Nothing in this module recomputes it.
    fitScore: scored.score,
    scoreStatus: scored.scoreStatus,
    shouldRemove: scored.shouldRemove,
    // Confidence is the v2 evidence-confidence band. It is intentionally the
    // same value rather than a second competing notion of certainty.
    confidence: scored.evidenceConfidence,
    confidenceReasons,
    completenessScore: scored.completenessScore,
    missingEvidence: scored.missingEvidence || [],
    contradictionCount: contradictions.length,
    dimensions,
    gates,
    appliedCaps,
    baselinePoints: state.baselinePoints,
    evidence,
    actionEligibility: scored.actionEligibility,
    strengths: scored.strengths || [],
    concerns: scored.concerns || [],
    recommendation: scored.recommendation || '',
    engineVersion: DEAL_SCORING_ENGINE_VERSION,
    rulesVersion: DEAL_SCORING_RULES_VERSION,
    profileVersion: DEAL_SCORING_PROFILE_VERSION,
    completenessPolicyVersion: DEAL_COMPLETENESS_POLICY_VERSION,
    matcherVersion: DEAL_SEMANTIC_MATCHER_VERSION,
    // Keyword occurrences the matcher declined to count, with the reason. These
    // explain why a listing that mentions a term did not score for it.
    suppressedMatches: state.finalized?.semantic?.suppressed || [],
    fingerprint: dealScoreFingerprint(deal),
    scoredDeal: scored,
  };
  result.semanticDigest = dealSemanticDigest(result);
  return result;
}
