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
  DEAL_SCORING_RULES_VERSION_PREVIOUS,
} from './dealHunterScoringPolicy.js';
import {
  canonicalDealHunterContradictionValue,
  scoreOpportunity,
} from './dealHunterScoring.js';

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

function deferredScoringError(review) {
  return review?.scoringDeferredReason
    || 'Scoring is deferred until every required Google Sheet is healthy.';
}

function authoritativeFullBackfillProblems(review, candidates = []) {
  const requiredSheets = (review?.sources || []).filter(
    (source) => source?.required === true && source?.sourceRole === 'required-primary',
  );
  const problems = [];
  if (review?.reviewMode !== 'full-backfill') problems.push('review mode is not full-backfill');
  if (review?.scoringDeferred) problems.push('scoring is deferred');
  if (review?.selection?.strategy !== 'all-canonical-listings') problems.push('selection is not the complete canonical set');
  if (requiredSheets.length === 0) problems.push('no required Google Sheet was reviewed');
  if (requiredSheets.some((source) => !source.fetched || source.error || Number(source.rowCount || 0) < 1)) {
    problems.push('a required Google Sheet is unhealthy or empty');
  }
  // Multiple reviewed source rows may collapse to one canonical opportunity.
  // The inverse (more canonical candidates than reviewed deals) would indicate
  // that this is not the builder's complete reviewed set.
  if (Number(review?.totals?.reviewedDeals ?? -1) < candidates.length) {
    problems.push('the canonical candidate count exceeds the reviewed full-backfill count');
  }
  if (candidates.some((deal) => !deal?.opportunityId || deal.identityStatus !== 'resolved')) {
    problems.push('the canonical candidate set contains an unresolved identity');
  }
  return problems;
}

function contradictionCoreSignature(evidence = []) {
  return JSON.stringify(evidence
    .filter((row) => (row.evidenceClass || row.evidence_class) === 'contradicted')
    .map((row) => ({
      field: canonicalDealHunterContradictionValue(row.field) || '',
      canonicalValue: canonicalDealHunterContradictionValue(row.value),
      observedValue: canonicalDealHunterContradictionValue(row.observedValue ?? row.observed_value),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function semanticDigestIsCurrent(stored, result, storedContradictions = null) {
  if (!stored) return false;
  if (stored.semantic_digest === result.semanticDigest) return true;
  return Boolean(result.legacySemanticDigest)
    && stored.semantic_digest === result.legacySemanticDigest
    && Array.isArray(storedContradictions)
    && contradictionCoreSignature(storedContradictions) === contradictionCoreSignature(result.evidence || []);
}

async function loadLegacyContradictions(storage, evaluated, storedByOpportunity) {
  if (typeof storage.listDealHunterContradictionEvidence !== 'function') return new Map();
  const opportunityIds = evaluated
    .filter(({ deal, result }) => {
      const stored = storedByOpportunity.get(deal.opportunityId);
      return stored
        && stored.semantic_digest !== result.semanticDigest
        && stored.semantic_digest === result.legacySemanticDigest;
    })
    .map(({ deal }) => deal.opportunityId);
  if (opportunityIds.length === 0) return new Map();
  const byOpportunity = new Map(opportunityIds.map((opportunityId) => [opportunityId, []]));
  for (const row of await storage.listDealHunterContradictionEvidence(opportunityIds)) {
    const rows = byOpportunity.get(row.opportunity_id);
    if (rows) rows.push(row);
  }
  return byOpportunity;
}

// A stored score is reusable only when both its input/version identity and its
// human-relevant conclusions match the already-computed fresh result.
function storedScoreIsCurrent(stored, result, storedContradictions = null) {
  if (!stored) return false;
  const semanticCurrent = semanticDigestIsCurrent(stored, result, storedContradictions);
  const unreviewedLegacyEncoding = semanticCurrent
    && stored.semantic_digest !== result.semanticDigest
    && !stored.reviewed_at;
  return stored.score_fingerprint === result.fingerprint
    && semanticCurrent
    // Migrate an unreviewed equivalent legacy digest silently so a strict audit
    // converges. A reviewed row keeps the encoding its operator acknowledged
    // until its core evidence genuinely changes.
    && !unreviewedLegacyEncoding
    && stored.engine_version === result.engineVersion
    && stored.rules_version === result.rulesVersion
    && stored.profile_version === result.profileVersion
    && stored.completeness_policy_version === result.completenessPolicyVersion;
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
    semantic_digest: result.semanticDigest,
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
  // opportunity whose human-relevant score conclusions or core evidence
  // changed, so a large rebuild does not pay it per candidate.
  const opportunity = storage.getCurrentDealHunterOpportunity
    ? await storage.getCurrentDealHunterOpportunity(deal.opportunityId)
    : null;
  const submissionId = opportunity?.primary_submission_id || '';
  if (!submissionId) return null;
  const scoreMoved = Boolean(previous) && previous.fit_score !== row.fit_score;
  const changeKind = !previous ? 'initial' : scoreMoved ? 'score' : 'semantic-evidence';

  return recordCrmActivity({
    storage,
    submissionId,
    opportunityId: deal.opportunityId,
    eventType: 'opportunity.rescored',
    summary: !previous
      ? `Deal Hunter scored this opportunity at ${row.fit_score}.`
      : scoreMoved
        ? `Deal Hunter score moved from ${previous.fit_score} to ${row.fit_score}.`
        : `Deal Hunter score evidence changed while the fit score remained ${row.fit_score}.`,
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
      changeKind,
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

  const callerSuppliedDeals = Array.isArray(deals);
  const requested = new Set(opportunityIds.map((id) => String(id || '').trim()).filter(Boolean));
  let candidates = callerSuppliedDeals ? deals : null;
  let authoritativeOpportunityIds = null;
  if (!candidates) {
    const collected = await collectScoredOpportunities({ reviewMode, storage });
    if (collected.review?.scoringDeferred) {
      return {
        ok: false,
        status: 503,
        scoringDeferred: true,
        error: deferredScoringError(collected.review),
        review: collected.review,
        counts: { considered: 0, scored: 0, skipped: 0, failed: 0, changed: 0, versionOnly: 0 },
        errors: [],
        rulesVersion: DEAL_SCORING_RULES_VERSION,
        engineVersion: DEAL_SCORING_ENGINE_VERSION,
        profileVersion: DEAL_SCORING_PROFILE_VERSION,
      };
    }
    candidates = collected.scoredDeals || [];
    if (reviewMode === 'full-backfill' && requested.size === 0) {
      const authorityProblems = authoritativeFullBackfillProblems(collected.review, candidates);
      if (authorityProblems.length > 0) {
        return {
          ok: false,
          status: 409,
          error: 'The canonical full-backfill review could not prove a complete authoritative opportunity set.',
          authorityProblems,
          counts: { considered: 0, scored: 0, skipped: 0, failed: 0, changed: 0, versionOnly: 0 },
          errors: [],
          rulesVersion: DEAL_SCORING_RULES_VERSION,
          engineVersion: DEAL_SCORING_ENGINE_VERSION,
          profileVersion: DEAL_SCORING_PROFILE_VERSION,
        };
      }
      if (typeof storage.reconcileDealHunterCurrentScoreEligibility !== 'function') {
        return {
          ok: false,
          status: 503,
          error: 'Durable current-triage eligibility reconciliation is unavailable.',
          missingMethods: ['reconcileDealHunterCurrentScoreEligibility'],
        };
      }
      // Capture the complete builder-owned set before the per-run score-write
      // batch limit. Existing scores outside this run's write slice must not be
      // deactivated merely because the scorer writes in bounded batches.
      authoritativeOpportunityIds = Array.from(new Set(candidates.map((deal) => deal.opportunityId)));
    }
  }

  const scoped = candidates
    .filter((deal) => deal?.opportunityId && deal.identityStatus === 'resolved')
    .filter((deal) => requested.size === 0 || requested.has(deal.opportunityId))
    .slice(0, maxRefreshBatch);
  const counts = { considered: scoped.length, scored: 0, skipped: 0, failed: 0, changed: 0, versionOnly: 0 };
  const errors = [];
  const evaluated = [];
  for (const deal of scoped) {
    try {
      evaluated.push({ deal, result: scoreOpportunity(deal) });
    } catch (error) {
      counts.failed += 1;
      errors.push({ opportunityId: deal.opportunityId, error: normalizeText(error.message, 500) });
    }
  }

  // One batched read instead of a lookup per opportunity.
  const storedByOpportunity = new Map(
    (await storage.listDealHunterOpportunityScoreFingerprints(evaluated.map(({ deal }) => deal.opportunityId)))
      .map((row) => [row.opportunity_id, row]),
  );
  // Only deployed contradiction digests need the compatibility evidence, and
  // those rows are loaded together rather than through an N+1 query.
  const legacyContradictions = await loadLegacyContradictions(storage, evaluated, storedByOpportunity);

  for (const { deal, result } of evaluated) {
    try {
      const stored = storedByOpportunity.get(deal.opportunityId);
      const storedContradictions = legacyContradictions.get(deal.opportunityId);
      if (!force && storedScoreIsCurrent(stored, result, storedContradictions)) {
        counts.skipped += 1;
        continue;
      }
      // An event describes a change in conclusions, not a change in version
      // metadata, so it is gated on the semantic digest rather than the
      // fingerprint. A rules bump that reproduces the same score is silent.
      // The batched read already carries the stored digest, so deciding this
      // costs no extra query.
      const semanticallyChanged = !semanticDigestIsCurrent(stored, result, storedContradictions);
      // A forced or version-only refresh over a reviewed, semantically
      // equivalent v111 digest keeps the exact digest the operator
      // acknowledged. Otherwise changing only the digest encoding would make
      // the derived review state falsely stale.
      const row = machineScoreRow(deal, result);
      if (!semanticallyChanged
        && stored?.reviewed_at
        && stored.semantic_digest !== result.semanticDigest) {
        row.semantic_digest = stored.semantic_digest;
      }
      // The previous row is read only when an event will actually describe it.
      const previous = semanticallyChanged
        ? await storage.getDealHunterOpportunityScore(deal.opportunityId)
        : null;
      await storage.writeDealHunterOpportunityScore(row, result.evidence);
      if (semanticallyChanged) {
        await emitRescoreEvent({ storage, deal, previous, row, actor });
        counts.changed += 1;
      } else {
        counts.versionOnly += 1;
      }
      counts.scored += 1;
    } catch (error) {
      counts.failed += 1;
      errors.push({ opportunityId: deal.opportunityId, error: normalizeText(error.message, 500) });
    }
  }

  let eligibilityReconciliation = null;
  if (authoritativeOpportunityIds && counts.failed === 0) {
    try {
      eligibilityReconciliation = await storage.reconcileDealHunterCurrentScoreEligibility(authoritativeOpportunityIds);
    } catch (error) {
      return {
        ok: false,
        status: 503,
        error: `Current-triage eligibility could not be reconciled: ${normalizeText(error.message, 500)}`,
        counts,
        errors: [],
        rulesVersion: DEAL_SCORING_RULES_VERSION,
        engineVersion: DEAL_SCORING_ENGINE_VERSION,
        profileVersion: DEAL_SCORING_PROFILE_VERSION,
      };
    }
  }

  return {
    ok: counts.failed === 0,
    status: counts.failed > 0 ? 207 : 200,
    counts,
    errors: errors.slice(0, 100),
    eligibilityReconciliation,
    rulesVersion: DEAL_SCORING_RULES_VERSION,
    engineVersion: DEAL_SCORING_ENGINE_VERSION,
    profileVersion: DEAL_SCORING_PROFILE_VERSION,
  };
}

/**
 * Preview what a refresh would do, writing nothing.
 *
 * This exists because a rules-version bump stales every stored fingerprint. The
 * preview separates opportunities whose conclusions actually move from those
 * whose only difference is version metadata, so an operator can see before
 * executing whether a rebuild will flood the review queue.
 */
export async function previewOpportunityScoreRefresh({
  deals = null,
  opportunityIds = [],
  reviewMode = 'full-backfill',
  storage = getStorage(),
} = {}) {
  if (typeof storage.getDealHunterOpportunityScore !== 'function') {
    return { ok: false, status: 503, error: 'Durable opportunity scoring storage is unavailable.' };
  }

  let candidates = Array.isArray(deals) ? deals : null;
  if (!candidates) {
    const collected = await collectScoredOpportunities({ reviewMode, storage });
    if (collected.review?.scoringDeferred) {
      return {
        ok: false,
        status: 503,
        preview: true,
        scoringDeferred: true,
        error: deferredScoringError(collected.review),
        review: collected.review,
        counts: {
          considered: 0,
          newlyScored: 0,
          unchanged: 0,
          versionOnly: 0,
          semanticChange: 0,
          scoreChange: 0,
          classificationChange: 0,
          gateChange: 0,
          evidenceOnlyChange: 0,
          highFitToWatchlist: 0,
          watchlistToHighFit: 0,
          newlyGated: 0,
          gateLifted: 0,
          operatorPrioritized: 0,
          reviewedAffected: 0,
          reviewedFlaggedChanged: 0,
          estimatedWrites: 0,
        },
        samples: [],
        confirmationRequired: fullRebuildConfirmation,
      };
    }
    candidates = collected.scoredDeals || [];
  }
  const requested = new Set(opportunityIds.map((id) => String(id || '').trim()).filter(Boolean));
  const scoped = candidates
    .filter((deal) => deal?.opportunityId && deal.identityStatus === 'resolved')
    .filter((deal) => requested.size === 0 || requested.has(deal.opportunityId))
    .slice(0, maxRefreshBatch);
  const evaluated = [];
  for (const deal of scoped) {
    evaluated.push({
      deal,
      result: scoreOpportunity(deal),
      stored: await storage.getDealHunterOpportunityScore(deal.opportunityId),
    });
  }
  const storedByOpportunity = new Map(
    evaluated.filter(({ stored }) => stored).map(({ deal, stored }) => [deal.opportunityId, stored]),
  );
  const legacyContradictions = await loadLegacyContradictions(storage, evaluated, storedByOpportunity);

  const counts = {
    considered: scoped.length,
    newlyScored: 0,
    unchanged: 0,
    versionOnly: 0,
    semanticChange: 0,
    scoreChange: 0,
    classificationChange: 0,
    gateChange: 0,
    evidenceOnlyChange: 0,
    highFitToWatchlist: 0,
    watchlistToHighFit: 0,
    newlyGated: 0,
    gateLifted: 0,
    operatorPrioritized: 0,
    reviewedAffected: 0,
    reviewedFlaggedChanged: 0,
    estimatedWrites: 0,
  };
  const samples = [];

  for (const { deal, result, stored } of evaluated) {
    if (!stored) {
      counts.newlyScored += 1;
      counts.estimatedWrites += 1;
      continue;
    }

    const semanticChange = stored.semantic_digest !== result.semanticDigest;
    const storedContradictions = legacyContradictions.get(deal.opportunityId);
    if (storedScoreIsCurrent(stored, result, storedContradictions)) {
      counts.unchanged += 1;
      continue;
    }
    counts.estimatedWrites += 1;
    if (!semanticChange || semanticDigestIsCurrent(stored, result, storedContradictions)) {
      // Same conclusions, different version metadata. This is the case a
      // version bump produces and the case that must not flood review.
      counts.versionOnly += 1;
      continue;
    }

    counts.semanticChange += 1;
    const scoreMoved = stored.fit_score !== result.fitScore;
    const statusMoved = stored.score_status !== result.scoreStatus;
    const gatesMoved = JSON.stringify((stored.gates || []).map((gate) => gate.ruleId).sort())
      !== JSON.stringify(result.gates.map((gate) => gate.ruleId).sort());
    if (scoreMoved) counts.scoreChange += 1;
    if (statusMoved) counts.classificationChange += 1;
    if (gatesMoved) counts.gateChange += 1;
    if (!scoreMoved && !statusMoved && !gatesMoved) counts.evidenceOnlyChange += 1;
    if (stored.high_fit && !(result.actionEligibility?.highFit === true)) counts.highFitToWatchlist += 1;
    if (!stored.high_fit && result.actionEligibility?.highFit === true) counts.watchlistToHighFit += 1;
    if (!stored.should_remove && result.shouldRemove) counts.newlyGated += 1;
    if (stored.should_remove && !result.shouldRemove) counts.gateLifted += 1;
    if (stored.operator_priority && stored.operator_priority !== 'normal') counts.operatorPrioritized += 1;
    if (stored.reviewed_at) {
      counts.reviewedAffected += 1;
      counts.reviewedFlaggedChanged += 1;
    }
    if (samples.length < 25) {
      samples.push({
        opportunityId: deal.opportunityId,
        previousScore: stored.fit_score,
        score: result.fitScore,
        previousStatus: stored.score_status,
        status: result.scoreStatus,
        reviewed: Boolean(stored.reviewed_at),
        operatorPriority: stored.operator_priority || 'normal',
      });
    }
  }

  return {
    ok: true,
    status: 200,
    preview: true,
    currentRulesVersion: DEAL_SCORING_RULES_VERSION_PREVIOUS,
    proposedRulesVersion: DEAL_SCORING_RULES_VERSION,
    engineVersion: DEAL_SCORING_ENGINE_VERSION,
    profileVersion: DEAL_SCORING_PROFILE_VERSION,
    counts,
    samples,
    confirmationRequired: fullRebuildConfirmation,
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
