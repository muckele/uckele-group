// Fingerprint-gated persistence for Deal Hunter opportunity scores.
//
// Scoring runs incrementally. An opportunity whose scoring inputs and scoring
// versions are unchanged is skipped entirely: no score write, no evidence
// replacement, and no activity event. Only a genuine change costs anything.
//
// Machine scoring is written through the ownership-separated storage method, so
// no path in this module can touch an operator decision.

import { recordCrmActivity } from './activity.js';
import { collectScoredOpportunities } from './dealHunter.js';
import { getStorage } from '../storage/index.js';
import {
  DEAL_SCORING_ENGINE_VERSION,
  DEAL_SCORING_PROFILE_VERSION,
  DEAL_SCORING_RULES_VERSION,
} from './dealHunterScoringPolicy.js';
import { scoreOpportunity } from './dealHunterScoring.js';

export const fullRebuildConfirmation = 'REBUILD ALL SCORES';

const maxRefreshBatch = 5000;

function normalizeText(value = '', maxLength = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function requiredStorageMethods(storage) {
  return [
    'writeDealHunterOpportunityScore',
    'getDealHunterOpportunityScore',
    'listDealHunterOpportunityScoreFingerprints',
  ].filter((method) => typeof storage[method] !== 'function');
}

// A stored score is reusable only when the inputs and every scoring version
// behind it are unchanged. A rules or profile bump therefore forces a rescore
// rather than serving a score computed under retired rules.
function storedScoreIsCurrent(stored, fingerprint) {
  return Boolean(stored)
    && stored.score_fingerprint === fingerprint
    && stored.engine_version === DEAL_SCORING_ENGINE_VERSION
    && stored.rules_version === DEAL_SCORING_RULES_VERSION
    && stored.profile_version === DEAL_SCORING_PROFILE_VERSION;
}

function machineScoreRow(deal, result) {
  return {
    opportunity_id: deal.opportunityId,
    scored_at: new Date().toISOString(),
    deal_key: deal.dealKey || null,
    name: deal.name || null,
    state: deal.state || null,
    listing_url: deal.listingUrl || null,
    fit_score: result.fitScore,
    score_status: result.scoreStatus,
    confidence: result.confidence,
    completeness_score: result.completenessScore,
    contradiction_count: result.contradictionCount,
    missing_evidence_count: result.missingEvidence.length,
    should_remove: result.shouldRemove,
    high_fit: result.actionEligibility?.highFit === true,
    gate_count: result.gates.length,
    score_fingerprint: result.fingerprint,
    engine_version: result.engineVersion,
    rules_version: result.rulesVersion,
    profile_version: result.profileVersion,
    completeness_policy_version: result.completenessPolicyVersion,
    dimensions: result.dimensions,
    gates: result.gates,
    applied_caps: result.appliedCaps,
    missing_evidence: result.missingEvidence,
    confidence_reasons: result.confidenceReasons,
    summary: {
      recommendation: result.recommendation,
      strengths: result.strengths.slice(0, 6),
      concerns: result.concerns.slice(0, 7),
    },
  };
}

function meaningfulDimensionChanges(previousDimensions = [], nextDimensions = []) {
  const previousById = new Map(previousDimensions.map((dimension) => [dimension.id, dimension]));
  return nextDimensions
    .map((dimension) => {
      const previous = previousById.get(dimension.id);
      if (!previous || previous.contribution === dimension.contribution) return null;
      return {
        dimension: dimension.id,
        previousContribution: previous.contribution,
        contribution: dimension.contribution,
        previousVerdict: previous.verdict,
        verdict: dimension.verdict,
      };
    })
    .filter(Boolean);
}

async function emitRescoreEvent({ storage, deal, previous, row, actor }) {
  // Activity events hang off a CRM record. A sourced opportunity with no linked
  // submission has nothing to attach to; its score row and fingerprint are the
  // durable audit trail in that case. The lookup happens here, and only for an
  // opportunity whose score actually moved, so a large rebuild does not pay it
  // per candidate.
  const opportunity = storage.getDealHunterOpportunity
    ? await storage.getDealHunterOpportunity(deal.opportunityId)
    : null;
  const submissionId = opportunity?.primary_submission_id || '';
  if (!submissionId) return null;

  return recordCrmActivity({
    storage,
    submissionId,
    opportunityId: deal.opportunityId,
    eventType: 'opportunity.rescored',
    summary: previous
      ? `Deal Hunter score moved from ${previous.fit_score} to ${row.fit_score}.`
      : `Deal Hunter scored this opportunity at ${row.fit_score}.`,
    actor: normalizeText(actor, 160) || 'deal-hunter',
    role: 'system',
    metadata: {
      previousScore: previous ? previous.fit_score : null,
      score: row.fit_score,
      previousFingerprint: previous ? previous.score_fingerprint : null,
      fingerprint: row.score_fingerprint,
      previousConfidence: previous ? previous.confidence : null,
      confidence: row.confidence,
      rulesVersion: row.rules_version,
      engineVersion: row.engine_version,
      dimensionChanges: meaningfulDimensionChanges(previous?.dimensions, row.dimensions).slice(0, 12),
    },
  });
}

/**
 * Refresh persisted scores for the supplied canonical listings.
 *
 * Idempotent and resumable: an unchanged opportunity is skipped without any
 * write, and a failed opportunity is reported without stopping the batch, so a
 * retry only redoes the work that did not land.
 */
export async function refreshOpportunityScores({
  deals = null,
  opportunityIds = [],
  force = false,
  reviewMode = 'full-backfill',
  actor = 'deal-hunter',
  storage = getStorage(),
} = {}) {
  const missingMethods = requiredStorageMethods(storage);
  if (missingMethods.length > 0) {
    return {
      ok: false,
      status: 503,
      error: 'Durable opportunity scoring storage is unavailable.',
      missingMethods,
    };
  }

  let candidates = Array.isArray(deals) ? deals : null;
  if (!candidates) {
    const collected = await collectScoredOpportunities({ reviewMode, storage });
    candidates = collected.scoredDeals || [];
  }

  const requested = new Set(opportunityIds.map((id) => String(id || '').trim()).filter(Boolean));
  const scoped = candidates
    .filter((deal) => deal?.opportunityId && deal.identityStatus === 'resolved')
    .filter((deal) => requested.size === 0 || requested.has(deal.opportunityId))
    .slice(0, maxRefreshBatch);

  // One batched read instead of a lookup per opportunity.
  const storedByOpportunity = new Map(
    (await storage.listDealHunterOpportunityScoreFingerprints(scoped.map((deal) => deal.opportunityId)))
      .map((row) => [row.opportunity_id, row]),
  );

  const counts = { considered: scoped.length, scored: 0, skipped: 0, failed: 0 };
  const errors = [];

  for (const deal of scoped) {
    try {
      const result = scoreOpportunity(deal);
      const stored = storedByOpportunity.get(deal.opportunityId);
      if (!force && storedScoreIsCurrent(stored, result.fingerprint)) {
        counts.skipped += 1;
        continue;
      }
      // A forced refresh over identical inputs rewrites the row but must not
      // claim the opportunity changed. The batched fingerprint read already
      // answers this, so no per-opportunity lookup is needed to decide it.
      const changed = !stored || stored.score_fingerprint !== result.fingerprint;
      const row = machineScoreRow(deal, result);
      // The previous row is read only when an event will describe it.
      const previous = changed ? await storage.getDealHunterOpportunityScore(deal.opportunityId) : null;
      await storage.writeDealHunterOpportunityScore(row, result.evidence);
      if (changed) await emitRescoreEvent({ storage, deal, previous, row, actor });
      counts.scored += 1;
    } catch (error) {
      counts.failed += 1;
      errors.push({ opportunityId: deal.opportunityId, error: normalizeText(error.message, 500) });
    }
  }

  return {
    ok: counts.failed === 0,
    status: counts.failed > 0 ? 207 : 200,
    counts,
    errors: errors.slice(0, 100),
    rulesVersion: DEAL_SCORING_RULES_VERSION,
    engineVersion: DEAL_SCORING_ENGINE_VERSION,
    profileVersion: DEAL_SCORING_PROFILE_VERSION,
  };
}

/**
 * Admin-triggered refresh. A narrow refresh runs unguarded; a forced rebuild of
 * every score requires the typed confirmation, matching the reconciliation and
 * CRM sync conventions.
 */
export async function requestOpportunityScoreRefresh({
  opportunityIds = [],
  force = false,
  confirmation = '',
  requestedBy = '',
  storage = getStorage(),
} = {}) {
  const scoped = opportunityIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (force && scoped.length === 0 && normalizeText(confirmation, 80) !== fullRebuildConfirmation) {
    return {
      ok: false,
      status: 400,
      error: `Type ${fullRebuildConfirmation} to force a rebuild of every opportunity score.`,
    };
  }
  return refreshOpportunityScores({
    opportunityIds: scoped,
    force: Boolean(force),
    actor: normalizeText(requestedBy, 160) || 'admin',
    storage,
  });
}
