import 'dotenv/config';
import { getConfig } from '../server/config.js';
import { getStorage } from '../server/storage/index.js';
import { getCimAutomationStatus } from '../server/services/cimAutomation.js';

function countBy(rows, field) {
  return rows.reduce((counts, row) => {
    const key = String(row?.[field] || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    considered: Number(run.considered_count || 0),
    eligible: Number(run.eligible_count || 0),
    wouldSend: Number(run.would_send_count || 0),
    attempted: Number(run.attempted_count || 0),
    accepted: Number(run.accepted_count || 0),
    failed: Number(run.failed_count || 0),
    ambiguous: Number(run.ambiguous_count || 0),
    deferred: Number(run.deferred_count || 0),
    blockedCounts: run.blocked_counts || {},
    providerCalls: Number(run.metadata?.providerCalls || 0),
    unexpectedSources: Number(run.metadata?.sourceReview?.unexpectedCount || 0),
  };
}

async function main() {
  const storage = getStorage();
  const config = getConfig();
  const [status, storageHealth, runs, decisions, requests, communicationPage] = await Promise.all([
    getCimAutomationStatus({ storage, config, privacySafe: true }),
    storage.checkCimStage2Storage?.() || { ok: false },
    storage.listCimStage2Runs?.({ limit: 100 }) || [],
    storage.listCimStage2Decisions?.({ limit: 500 }) || [],
    storage.listCimStage2MetricRequests?.({ limit: 500 }) || [],
    storage.listCimStage2MetricCommunications?.({ limit: 500 }) || [],
  ]);
  const identity = status.identitySummary || {};
  const communications = (Array.isArray(communicationPage) ? communicationPage : [])
    .filter((item) => item.kind === 'deal-hunter-cim-request');
  const runIds = new Set(runs.map((run) => run.id));
  const requestIds = new Set(requests.map((request) => request.id));
  const communicationIds = new Set(communications.map((communication) => communication.id));
  const liveDecisions = decisions.filter((decision) => ['attempting', 'accepted', 'failed', 'ambiguous'].includes(decision.decision_state));
  const latestShadow = runs.find((run) => run.mode === 'shadow') || null;
  const latestCanary = runs.find((run) => run.mode === 'canary') || null;
  const output = {
    generatedAt: new Date().toISOString(),
    privacy: 'Count-only audit. No addresses, aliases, message bodies, headers, cookies, secrets, or unrestricted row lists are emitted.',
    stages: {
      configured: status.configuredStage,
      evidence: status.evidenceStage,
      effective: status.effectiveStage,
      activationMode: status.activationMode,
      automaticTransmissionAllowed: status.automaticTransmissionAllowed,
      automationPaused: status.automationPaused,
      centralOutreachPaused: status.centralOutreachPaused,
      followUpsEnabled: Boolean(config.dealHunter?.cimFollowUp?.enabled),
    },
    hashes: {
      policy: status.policy?.policyHash || '',
      sourcePolicy: status.policy?.sourcePolicyHash || '',
      evidence: status.evidenceChecksum || '',
      acceptedPolicy: status.activation?.policyHash || '',
      acceptedSourcePolicy: status.activation?.sourcePolicyHash || '',
      acceptedEvidence: status.activation?.evidenceChecksum || '',
    },
    gates: status.stage2Readiness.map((gate) => ({
      code: gate.code,
      passed: gate.passed,
      observed: gate.observed,
      required: gate.required,
      reason: gate.reason,
    })),
    evidence: {
      canonicalHumanReviews: status.metrics.canonicalHumanReviews,
      remaining: status.metrics.remainingStage2Reviews,
      compatible: status.metrics.compatibleEvidence,
      legacyUnversioned: status.metrics.legacyUnversionedEvidence,
      incompatible: status.metrics.incompatibleEvidence,
      unlinked: status.metrics.unlinkedEvidence,
      ambiguous: status.metrics.ambiguousEvidence,
      eligibleCohort: status.metrics.stage2EligibleCohort,
      unchangedApprovals: status.metrics.stage2UnchangedApprovals,
      unchangedApprovalRate: status.metrics.stage2UnchangedApprovalRate,
      cohortIdentityProblems: status.metrics.stage2CohortIdentityProblems,
    },
    sourcePolicy: {
      version: status.policy?.sourcePolicy?.version || '',
      allowedSourceIds: status.policy?.sourcePolicy?.allowedSourceIds || [],
      latestShadowUnexpectedSources: Number(latestShadow?.metadata?.sourceReview?.unexpectedCount || 0),
      latestShadowFailedSources: Number(latestShadow?.metadata?.sourceReview?.failedCount || 0),
      latestShadowEmptySources: Number(latestShadow?.metadata?.sourceReview?.emptyCount || 0),
      latestShadowDuplicateSources: Number(latestShadow?.metadata?.sourceReview?.duplicateSourceCount || 0),
      latestShadowWarnings: Number(latestShadow?.metadata?.sourceReview?.warningCount || 0),
    },
    latestRuns: { shadow: summarizeRun(latestShadow), canary: summarizeRun(latestCanary) },
    runCounts: countBy(runs, 'mode'),
    decisionCounts: countBy(decisions, 'decision_state'),
    identity: {
      canonicalOpportunities: identity.canonicalOpportunities,
      unresolvedExceptions: identity.unresolvedIdentityExceptions,
      duplicateActiveSequences: identity.duplicateActiveSequences,
      missingOpportunityLinks: identity.missingOpportunityLinks,
      safelyRepairableLinks: identity.safelyRepairableLinks,
      linkageMismatches: identity.linkageMismatches,
      recipientsAtCap: identity.recipientsAtCap,
      recipientCapDeferrals: identity.recipientCapDeferrals,
      outOfWindowDeferrals: identity.outOfWindowDeferrals,
    },
    lifecycle: {
      logicalInitialMessages: status.metrics.logicalInitialMessages,
      rawLifecycleEvents: status.metrics.rawLifecycleEvents,
      delivered: status.metrics.delivered,
      replies: status.metrics.replies,
      complaints: status.metrics.complained,
      bounces: status.metrics.bounced,
      failures: status.metrics.failed,
      explicitOptOuts: status.metrics.explicitOptOuts,
      activeSuppressions: status.metrics.activeSuppressions,
      unresolvedAmbiguousDecisions: status.unresolvedAmbiguousDecisions,
    },
    linkage: {
      sampledDecisions: decisions.length,
      sampledRequests: requests.length,
      sampledInitialCommunications: communications.length,
      decisionMissingRun: decisions.filter((decision) => !runIds.has(decision.run_id)).length,
      consumedDecisionMissingRequest: liveDecisions.filter((decision) => decision.cim_request_id && !requestIds.has(decision.cim_request_id)).length,
      acceptedDecisionMissingRequest: decisions.filter((decision) => decision.decision_state === 'accepted' && !decision.cim_request_id).length,
      decisionCommunicationMismatch: decisions.filter((decision) => decision.communication_id && !communicationIds.has(decision.communication_id)).length,
      requestCommunicationMismatch: requests.filter((request) => {
        const communicationId = request.metadata?.initialCommunicationId || request.initial_communication_id;
        return communicationId && !communicationIds.has(communicationId);
      }).length,
      safelyReplayableFailures: decisions.filter((decision) => decision.decision_state === 'failed' && !decision.provider_state).length,
      ambiguousProviderStates: decisions.filter((decision) => decision.decision_state === 'ambiguous' || decision.provider_state === 'ambiguous').length,
      boundedSample: decisions.length >= 500 || requests.length >= 500 || communications.length >= 500,
    },
    storage: storageHealth,
    safeNextAction: status.safeNextAction,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(`[cim-stage2-audit] ${error.message}`);
  process.exitCode = 1;
});
