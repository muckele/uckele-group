import { sha256, stableCanonicalJson } from '../utils/security.js';

const maximumProjectionKeys = 100;
const findingCodes = Object.freeze({
  duplicateProviderIdentities: 'duplicate_provider_identity',
  missingDurableAuthority: 'missing_durable_authority',
  multipleActiveCampaigns: 'multiple_active_campaigns',
  duplicateAcceptedTouches: 'duplicate_accepted_touch',
  activeIdentityAmbiguities: 'active_identity_ambiguity',
  unexpectedLegacyInvocations: 'unexpected_legacy_invocation',
  replyOrMaterialsBeforeGateProviderCalls: 'terminal_evidence_before_provider_call',
  invalidClaimedTimezones: 'invalid_claimed_timezone',
  expiredActivationAttempts: 'expired_activation_attempt',
  missingEnvelopeAttempts: 'missing_live_envelope',
  readinessLoss: 'inbound_or_reconciliation_readiness_loss',
  shadowProviderCalls: 'shadow_provider_call',
});
const automaticContainmentCodes = new Set(Object.values(findingCodes));

function boundedText(value, maximum = 160) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= maximum ? normalized : '';
}

function boundedInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : '';
}

function count(value) {
  const normalized = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function countMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, maximumProjectionKeys)
    .map(([key, item]) => [boundedText(key, 160), count(item)])
    .filter(([key]) => key));
}

function nestedCountMaps(value, allowedKeys) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(allowedKeys.map((key) => [key, countMap(source[key])]));
}

function normalizeCounts(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries([
    'ownerDecisions', 'enrollments', 'campaigns', 'touches', 'transmissions',
    'memberships', 'crmOutbound', 'outbox', 'providerAuthorizations',
    'providerPending', 'providerSeamEntries',
  ].map((key) => [key, count(source[key])]));
}

function normalizeSchemaEvidence(schema = {}) {
  const fields = ['sqliteStorageSourceHash', 'postgresSchemaHash', 'migrationChainHash'];
  const normalized = Object.fromEntries(fields.map((field) => [field,
    /^[0-9a-f]{64}$/.test(schema?.[field] || '') ? schema[field] : '']));
  if (fields.some((field) => !normalized[field])) {
    throw new Error('Complete Pursue CIM schema evidence is required');
  }
  return normalized;
}

const releaseEvidenceCommandIds = new Set([
  'pursue-cim-focused-tests',
  'pursue-cim-full-check',
  'pursue-cim-postgres-parity',
  'pursue-cim-ui-tests',
  'pursue-cim-production-build',
  'pursue-cim-p1d-schema-attestation',
]);

function normalizeCommandEvidence(commands = []) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 50) {
    throw new Error('Bounded Pursue CIM command evidence is required');
  }
  return commands.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'digest,exitCode,id') {
      throw new Error('Malformed Pursue CIM command evidence');
    }
    if (!releaseEvidenceCommandIds.has(item.id) || !/^[0-9a-f]{64}$/.test(item.digest || '')) {
      throw new Error('Malformed Pursue CIM command evidence');
    }
    if (!Number.isSafeInteger(item.exitCode) || item.exitCode < 0 || item.exitCode > 255) {
      throw new Error('Malformed Pursue CIM command evidence');
    }
    return { id: item.id, digest: item.digest, exitCode: item.exitCode };
  });
}

function findingList(invariants = {}) {
  return Object.entries(findingCodes).flatMap(([key, code]) => {
    const total = count(invariants[key]);
    if (total === 0) return [];
    return [{ code, count: total, severity: 'high',
      evidenceDigest: sha256(stableCanonicalJson({ version: 'p9-finding-v1', code, count: total })) }];
  });
}

function projectedFindingList(alerts = []) {
  return Array.isArray(alerts) ? alerts.slice(0, maximumProjectionKeys).flatMap((finding) => {
    const code = boundedText(finding?.code, 160);
    const total = count(finding?.count);
    const evidenceDigest = finding?.evidenceDigest;
    if (!automaticContainmentCodes.has(code) || total === 0
      || finding?.severity !== 'high' || !/^[0-9a-f]{64}$/.test(evidenceDigest || '')) return [];
    return [{ code, count: total, severity: 'high', evidenceDigest }];
  }) : [];
}

export function projectPursueCimOperations(snapshot = {}, {
  now = new Date().toISOString(),
} = {}) {
  const projectedAt = boundedInstant(now);
  if (!projectedAt) throw new Error('Invalid Pursue CIM operations instant');
  const alerts = snapshot.invariants && typeof snapshot.invariants === 'object'
    ? findingList(snapshot.invariants) : projectedFindingList(snapshot.alerts);
  const providerPending = snapshot.providerPending || {};
  const activations = snapshot.activations || {};
  const legacy = snapshot.legacy || {};
  const boundary = snapshot.boundary || {};
  const pause = snapshot.pause || {};
  return {
    projectedAt,
    counts: normalizeCounts(snapshot.counts),
    stateCounts: nestedCountMaps(snapshot.stateCounts,
      ['enrollments', 'campaigns', 'touches', 'transmissions', 'conversations']),
    reasonCounts: nestedCountMaps(snapshot.reasonCounts,
      ['enrollments', 'campaigns', 'touches', 'gateBlocks']),
    providerPending: {
      count: count(providerPending.count),
      oldestAt: boundedInstant(providerPending.oldestAt),
      oldestAgeSeconds: count(providerPending.oldestAgeSeconds),
    },
    activations: {
      current: count(activations.current),
      expired: count(activations.expired),
      nearestExpiryAt: boundedInstant(activations.nearestExpiryAt),
      modes: countMap(activations.modes),
    },
    legacy: {
      total: count(legacy.total), active: count(legacy.active),
      ambiguous: count(legacy.ambiguous),
      writerInvocations: count(legacy.writerInvocations),
      classifications: countMap(legacy.classifications),
    },
    boundary: {
      accepts: count(boundary.accepts), rejects: count(boundary.rejects),
      byWriterPath: countMap(boundary.byWriterPath),
    },
    pause: { paused: pause.paused !== false, source: boundedText(pause.source, 80) },
    alerts,
    containmentRequired: alerts.length > 0 || snapshot.containmentRequired === true,
  };
}

export async function getPursueCimOperations({ storage,
  now = new Date().toISOString(), limit = 100 } = {}) {
  if (!storage?.readPursueCimOperationsSnapshot
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Pursue CIM operations storage is unavailable');
  }
  const projectedAt = new Date(now).toISOString();
  const snapshot = await storage.readPursueCimOperationsSnapshot({ now: projectedAt, limit });
  return projectPursueCimOperations(snapshot, { now: projectedAt });
}

export async function runPursueCimShadow({ storage,
  config, now = new Date().toISOString(), limit = 100 } = {}) {
  if (!storage?.readPursueCimOperationsSnapshot
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Pursue CIM shadow storage is unavailable');
  }
  const projectedAt = new Date(now).toISOString();
  const snapshot = await storage.readPursueCimOperationsSnapshot({ now: projectedAt, limit });
  const configuredPaused = config?.dealHunter?.cimOutreach?.paused === true
    || config?.dealHunter?.cimAutomation?.paused === true;
  const candidates = Array.isArray(snapshot?.shadowCandidates)
    ? snapshot.shadowCandidates.slice(0, limit) : [];
  const decisions = candidates.flatMap((candidate) => {
    const action = boundedText(candidate?.kind, 40);
    const subjectId = boundedText(candidate?.subjectId, 240);
    const reason = boundedText(candidate?.reason, 160) || 'not_ready';
    if (!['would-enroll', 'would-claim', 'would-send'].includes(action) || !subjectId) return [];
    const eligible = candidate?.eligible === true && !configuredPaused;
    const effectiveReason = configuredPaused ? 'configured_outreach_pause' : reason;
    return [{ decisionDigest: sha256(stableCanonicalJson({
      version: 'pursue-cim-shadow-decision-v1', action, subjectId, eligible,
      reason: effectiveReason,
    })), action, eligible, reason: effectiveReason }];
  });
  const actionCount = (action) => decisions.filter((decision) =>
    decision.action === action && decision.eligible).length;
  const blocked = decisions.filter((decision) => !decision.eligible);
  const blockedReasons = {};
  for (const decision of blocked) blockedReasons[decision.reason] = count(blockedReasons[decision.reason]) + 1;
  const operations = projectPursueCimOperations(snapshot, { now: projectedAt });
  return {
    version: 'pursue-cim-shadow-v1', mode: 'shadow', projectedAt,
    providerCalls: 0,
    counts: { wouldEnroll: actionCount('would-enroll'),
      wouldClaim: actionCount('would-claim'), wouldSend: actionCount('would-send'),
      blocked: blocked.length },
    blockedReasons,
    decisions,
    alerts: operations.alerts,
    containmentRequired: operations.containmentRequired,
  };
}

export async function containPursueCimFindings({ storage, findings = [], actor,
  now = new Date().toISOString() } = {}) {
  if (!storage?.applyPursueCimAutomaticContainment) {
    throw new Error('Pursue CIM automatic containment storage is unavailable');
  }
  const occurredAt = new Date(now).toISOString();
  const normalizedActor = boundedText(actor, 200);
  if (!normalizedActor) throw new Error('Pursue CIM containment actor is required');
  const selected = findings.filter((finding) => finding?.severity === 'high'
    && automaticContainmentCodes.has(finding.code) && count(finding.count) > 0
    && /^[0-9a-f]{64}$/.test(finding.evidenceDigest || ''))
    .map((finding) => ({ code: finding.code, count: count(finding.count),
      evidenceDigest: finding.evidenceDigest })).sort((left, right) => left.code.localeCompare(right.code));
  if (selected.length === 0) return { applied: false, replay: false, paused: false,
    withdrawnActivations: 0, withdrawnAuthorizations: 0 };
  const evidenceDigest = sha256(stableCanonicalJson({
    version: 'pursue-cim-containment-evidence-v1', findings: selected,
  }));
  const findingId = sha256(stableCanonicalJson({
    version: 'pursue-cim-containment-command-v1', evidenceDigest,
  }));
  return storage.applyPursueCimAutomaticContainment({ findingId, evidenceDigest,
    findingCodes: selected.map((finding) => finding.code), actor: normalizedActor,
    now: occurredAt });
}

export async function runPursueCimAutomaticContainment({ storage, actor,
  now = new Date().toISOString() } = {}) {
  const observedAt = new Date(now).toISOString();
  const operations = await getPursueCimOperations({ storage, now: observedAt });
  const containment = await containPursueCimFindings({ storage,
    findings: operations.alerts, actor, now: observedAt });
  return { version: 'pursue-cim-automatic-containment-v1', observedAt,
    findingCodes: operations.alerts.map((finding) => finding.code), containment };
}

export function buildPursueCimReleaseEvidence({ candidate = {}, policy = {}, config = {},
  schema = {}, commands = [], scenarios = {}, operations = {}, shadow = {},
  generatedAt = new Date().toISOString() } = {}) {
  const report = {
    version: 'pursue-cim-release-evidence-v2',
    generatedAt: new Date(generatedAt).toISOString(),
    candidate: {
      commit: /^[0-9a-f]{40}$/.test(candidate.commit || '') ? candidate.commit : '',
      tree: /^[0-9a-f]{40}$/.test(candidate.tree || '') ? candidate.tree : '',
      clean: candidate.clean === true,
    },
    policy: { version: boundedText(policy.version, 120),
      hash: /^[0-9a-f]{64}$/.test(policy.hash || '') ? policy.hash : '' },
    config: { hash: /^[0-9a-f]{64}$/.test(config.hash || '') ? config.hash : '',
      providerEnabled: config.providerEnabled === true, centralPaused: config.centralPaused !== false },
    schema: normalizeSchemaEvidence(schema),
    commands: normalizeCommandEvidence(commands),
    scenarios: { attempted: count(scenarios.attempted), passed: count(scenarios.passed),
      failed: count(scenarios.failed),
      digest: /^[0-9a-f]{64}$/.test(scenarios.digest || '') ? scenarios.digest : '' },
    providerCalls: count(shadow.providerCalls),
    shadow: { counts: {
      wouldEnroll: count(shadow.counts?.wouldEnroll), wouldClaim: count(shadow.counts?.wouldClaim),
      wouldSend: count(shadow.counts?.wouldSend), blocked: count(shadow.counts?.blocked),
    }, decisionDigests: (shadow.decisions || []).slice(0, 100)
      .map((decision) => decision?.decisionDigest).filter((value) => /^[0-9a-f]{64}$/.test(value)) },
    operations: { counts: normalizeCounts(operations.counts),
      alertCodes: (operations.alerts || []).slice(0, 100)
        .map((alert) => boundedText(alert?.code, 160)).filter(Boolean).sort(),
      containmentRequired: operations.containmentRequired === true,
      activations: { current: count(operations.activations?.current),
        expired: count(operations.activations?.expired),
        modes: countMap(operations.activations?.modes) },
      pause: { paused: operations.pause?.paused !== false,
        source: boundedText(operations.pause?.source, 80) } },
  };
  if (!report.candidate.commit || !report.candidate.tree || !report.candidate.clean
    || !report.policy.hash || !report.config.hash || !report.scenarios.digest) {
    throw new Error('Incomplete Pursue CIM release evidence');
  }
  return { ...report, evidenceDigest: sha256(stableCanonicalJson(report)) };
}
