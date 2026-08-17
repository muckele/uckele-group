import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getEmailReadiness } from './emailReadiness.js';
import {
  getCimIdentityOperationsStatus,
  logicalCimTouchesForRecipient,
} from './cimOpportunityIdentity.js';

export const CIM_STAGE2_EVIDENCE_VERSION = 'cim-stage2-human-evidence-v2';
export const CIM_STAGE2_ACTIVATION_CONFIRMATIONS = Object.freeze({
  off: 'SET CIM STAGE 2 OFF',
  shadow: 'ACTIVATE CIM STAGE 2 SHADOW',
  canary: 'ACTIVATE CIM STAGE 2 CANARY',
  active: 'ACTIVATE CIM STAGE 2 ACTIVE',
});

const passReasons = new Set([
  'industry', 'geography', 'valuation', 'profit', 'owner-dependence', 'duplicate',
  'recipient', 'financing', 'quality', 'timing', 'other',
]);
const genericMailboxNames = new Set([
  'admin', 'broker', 'contact', 'deals', 'enquiries', 'hello', 'info', 'inquiries',
  'listings', 'mail', 'office', 'sales', 'support', 'team',
]);
const suppressionTypes = new Set(['bounced', 'complained', 'failed', 'suppressed', 'unsubscribed']);
const adverseDeliveryStates = new Set(['bounced', 'complained', 'failed', 'suppressed']);
const acceptedInitialStates = new Set([
  'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'suppressed', 'replied', 'development-only',
]);
const trustedIndustryTerms = [
  'hvac', 'plumbing', 'electrical', 'landscape', 'maintenance', 'repair', 'restoration',
  'field service', 'commercial service', 'environmental', 'waste', 'pet', 'veterinary',
  'healthcare service', 'professional service', 'property management',
];
const trustedTargetStates = ['NY', 'CA', 'NJ', 'AZ', 'NV', 'CT'];
const automationModes = new Set(['off', 'shadow', 'canary', 'active']);

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeEmail(value = '') {
  return normalizeText(value, 320).toLowerCase();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableCimStage2Json(value) {
  return JSON.stringify(stableValue(value));
}

export function cimStage2Digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableCimStage2Json(value)).digest('hex');
}

export function hashCimStage2Recipient(value = '') {
  const email = normalizeEmail(value);
  return email ? cimStage2Digest(`cim-stage2-recipient:${email}`) : '';
}

function roundRate(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function providerIds(request = {}) {
  return new Set([
    request.provider_message_id,
    ...(Array.isArray(request.metadata?.providerMessageIds) ? request.metadata.providerMessageIds : []),
  ].filter(Boolean));
}

function safeDateMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseClock(value, fallback) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function getCimStage2Policy(config = getConfig()) {
  const configured = config.dealHunter?.cimAutomation || {};
  const outreach = config.dealHunter?.cimOutreach || {};
  const allowedSourceIds = [...new Set((configured.allowedSourceIds || ['sheet-0']).map((value) => normalizeText(value, 200)).filter(Boolean))].sort();
  const sourcePolicy = {
    version: configured.sourcePolicyVersion || 'cim-stage2-smb-sheet-only-v1',
    allowedSourceIds,
    exclusiveProvenanceRequired: true,
    blockingCoverageWarnings: true,
    maximumAgeHours: Number(configured.maximumSourceAgeHours || 24),
  };
  const rules = {
    version: configured.ruleVersion || 'cim-stage2-trusted-rules-v2',
    minimumScore: Math.max(90, Number(configured.minimumScore || 90)),
    minimumAnnualProfit: 300000,
    maximumAnnualProfit: 750000,
    maximumProfitMultiple: Number(configured.maximumProfitMultiple || 4),
    trustedIndustryTerms,
    targetStates: trustedTargetStates,
    namedSourceContactRequired: true,
    exactSourceAddressRequired: true,
    recipientFirstContactOnly: true,
  };
  const window = {
    timezone: configured.timezone || 'America/Los_Angeles',
    start: configured.sendWindowStart || '08:00',
    end: configured.sendWindowEnd || '17:00',
    weekdaysOnly: configured.weekdaysOnly !== false,
  };
  const caps = {
    canaryDailyInitials: 1,
    activeDailyInitials: Math.max(1, Math.min(Number(configured.activeDailyInitialCap || 3), 10)),
    recipient24Hours: Number(outreach.recipientCap24Hours || 1),
    recipient30Days: Number(outreach.recipientCap30Days || 4),
  };
  const compliance = {
    postalAddressConfigured: Boolean(normalizeText(configured.physicalPostalAddress, 500)),
    postalAddressHash: cimStage2Digest(normalizeText(configured.physicalPostalAddress, 500)),
    replyOptOutEnabled: Boolean(configured.replyOptOutEnabled),
    classificationAccepted: Boolean(normalizeText(configured.complianceClassificationReference, 300)),
    classificationReferenceHash: cimStage2Digest(normalizeText(configured.complianceClassificationReference, 300)),
    copyAccepted: Boolean(normalizeText(configured.copyAcceptanceReference, 300)),
    copyAcceptanceReferenceHash: cimStage2Digest(normalizeText(configured.copyAcceptanceReference, 300)),
    senderAuthenticationAttested: Boolean(normalizeText(configured.senderAuthenticationReference, 300)),
    senderAuthenticationReferenceHash: cimStage2Digest(normalizeText(configured.senderAuthenticationReference, 300)),
    dmarcReviewed: Boolean(normalizeText(configured.dmarcReviewReference, 300)),
    dmarcReviewReferenceHash: cimStage2Digest(normalizeText(configured.dmarcReviewReference, 300)),
  };
  const sourcePolicyHash = cimStage2Digest(sourcePolicy);
  const policyHash = cimStage2Digest({
    rules,
    sourcePolicy,
    window,
    caps,
    compliance,
    sender: {
      fromHash: cimStage2Digest(normalizeText(config.delivery?.resendFromEmail, 320)),
      replyToHash: cimStage2Digest(normalizeEmail(config.delivery?.resendReplyTo)),
      provider: normalizeText(config.delivery?.provider, 60),
    },
  });
  return {
    configuredStage: Math.max(1, Math.min(Number(configured.stage || 1), 3)),
    stage2MinimumReviews: Math.max(25, Number(configured.stage2MinimumReviews || 25)),
    stage2MinimumEligibleCohort: Math.max(10, Number(configured.stage2MinimumEligibleCohort || 10)),
    stage2MinimumUnchangedApprovalRate: Math.max(0.95, Number(configured.stage2MinimumUnchangedApprovalRate || 0.95)),
    stage3MinimumReviews: Math.max(50, Number(configured.stage3MinimumReviews || 50)),
    stage3MinimumApprovalRate: Math.max(0.9, Number(configured.stage3MinimumApprovalRate || 0.9)),
    shadowFreshnessHours: Number(configured.shadowFreshnessHours || 24),
    activationMaxAgeHours: Number(configured.activationMaxAgeHours || 168),
    adverseEventWindowDays: Number(configured.adverseEventWindowDays || 30),
    rules,
    sourcePolicy,
    sourcePolicyHash,
    window,
    caps,
    compliance,
    policyHash,
  };
}

export function evaluateCimStage2Window(now = new Date(), policy = getCimStage2Policy()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.window.timezone,
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const minutes = hour * 60 + Number(parts.minute);
  const start = parseClock(policy.window.start, 8 * 60);
  const end = parseClock(policy.window.end, 17 * 60);
  const weekday = !['Sat', 'Sun'].includes(parts.weekday);
  const open = (!policy.window.weekdaysOnly || weekday) && minutes >= start && minutes < end;
  return {
    open,
    businessDay: weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutesSinceMidnight: minutes,
    timezone: policy.window.timezone,
    start: policy.window.start,
    end: policy.window.end,
    weekdaysOnly: policy.window.weekdaysOnly,
    reason: open ? '' : !weekday && policy.window.weekdaysOnly ? 'weekend' : 'outside-operating-window',
  };
}

async function listCimCommunications(storage, limit = 10000) {
  if (storage.listCimStage2MetricCommunications) {
    return storage.listCimStage2MetricCommunications({ limit });
  }
  if (!storage.listCrmCommunications) return [];
  const pageSize = 100;
  const rows = [];
  for (let page = 1; rows.length < limit; page += 1) {
    const result = await storage.listCrmCommunications({ page, pageSize });
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize || page >= Number(result?.totalPages || page)) break;
  }
  return rows.slice(0, limit);
}

function reviewOpportunity(review, opportunityIdsByDeal, knownOpportunityIds) {
  const explicit = normalizeText(review.opportunity_id || review.metadata?.opportunityId, 160);
  if (explicit && (knownOpportunityIds.size === 0 || knownOpportunityIds.has(explicit))) {
    return { opportunityId: explicit, deterministic: true, legacy: false };
  }
  const candidates = opportunityIdsByDeal.get(normalizeText(review.deal_key, 1000)) || new Set();
  return candidates.size === 1
    ? { opportunityId: [...candidates][0], deterministic: true, legacy: true }
    : { opportunityId: '', deterministic: false, legacy: true, ambiguous: candidates.size > 1 };
}

async function canonicalHumanEvidence({ storage, reviews, policy }) {
  const [aliases, opportunities] = await Promise.all([
    storage.listCimStage2EvidenceAliases?.({ limit: 100000 })
      || storage.listDealHunterOpportunityAliases?.({ limit: 100000 }) || [],
    storage.listCimStage2IdentityOpportunities?.({ limit: 100000 })
      || storage.listDealHunterOpportunities?.({ limit: 100000 }) || [],
  ]);
  const opportunityIdsByDeal = new Map();
  for (const alias of aliases) {
    if (!['deal-key', 'deal_key'].includes(String(alias.alias_type || '').toLowerCase())) continue;
    const dealKey = normalizeText(alias.alias_value, 1000);
    if (!dealKey || !alias.opportunity_id) continue;
    const ids = opportunityIdsByDeal.get(dealKey) || new Set();
    ids.add(alias.opportunity_id);
    opportunityIdsByDeal.set(dealKey, ids);
  }
  const knownOpportunityIds = new Set(opportunities.map((item) => item.opportunity_id).filter(Boolean));
  const humanRows = reviews.filter((review) => review.metadata?.source === 'approval-queue' && ['approved', 'rejected'].includes(review.decision));
  const linked = [];
  let unlinked = 0;
  let ambiguous = 0;
  let unsupportedActor = 0;
  let incompatiblePolicy = 0;
  for (const review of humanRows) {
    const identity = reviewOpportunity(review, opportunityIdsByDeal, knownOpportunityIds);
    if (!identity.opportunityId) {
      if (identity.ambiguous) ambiguous += 1;
      else unlinked += 1;
      continue;
    }
    if (!normalizeText(review.actor, 200)) {
      unsupportedActor += 1;
      continue;
    }
    const explicitlyVersioned = Boolean(review.rule_version || review.source_policy_hash);
    const currentPolicy = review.rule_version === policy.rules.version
      && review.source_policy_hash === policy.sourcePolicyHash
      && review.evidence_version === CIM_STAGE2_EVIDENCE_VERSION;
    if (explicitlyVersioned && !currentPolicy) {
      incompatiblePolicy += 1;
      continue;
    }
    linked.push({
      ...review,
      opportunity_id: identity.opportunityId,
      deterministic_legacy_link: identity.legacy,
      current_policy: currentPolicy,
      decision_at: review.decision_at || review.created_at,
    });
  }
  linked.sort((left, right) => safeDateMs(right.decision_at) - safeDateMs(left.decision_at)
    || String(right.id || '').localeCompare(String(left.id || '')));
  const latestByOpportunity = new Map();
  for (const review of linked) {
    if (!latestByOpportunity.has(review.opportunity_id)) latestByOpportunity.set(review.opportunity_id, review);
  }
  const latest = [...latestByOpportunity.values()];
  const cohort = latest.filter((review) => review.current_policy && review.metadata?.stage2CohortEligible === true);
  const unchangedApprovals = cohort.filter((review) => review.decision === 'approved' && !review.recipient_edited);
  const cohortIdentityProblems = cohort.filter((review) => review.recipient_edited
    || (review.decision === 'rejected' && ['duplicate', 'recipient'].includes(review.pass_reason)));
  return {
    latest,
    cohort,
    unchangedApprovals,
    cohortIdentityProblems,
    rawHumanRows: humanRows.length,
    unlinked,
    ambiguous,
    unsupportedActor,
    incompatiblePolicy,
  };
}

export async function getCimAutomationMetrics({ storage = getStorage(), config = getConfig(), now = new Date() } = {}) {
  const policy = getCimStage2Policy(config);
  const [reviews, requests, events, communications] = await Promise.all([
    storage.listCimStage2MetricReviews?.({ limit: 100000 })
      || storage.listDealHunterCimReviews?.({ limit: 100000 }) || [],
    storage.listCimStage2MetricRequests?.({ limit: 100000 })
      || storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
    storage.listCimStage2MetricEmailEvents?.({ limit: 100000 })
      || storage.listEmailEvents?.({ limit: 100000 }) || [],
    listCimCommunications(storage),
  ]);
  const evidence = await canonicalHumanEvidence({ storage, reviews, policy });
  const humanReviews = evidence.latest;
  const automatedReviews = reviews.filter((review) => review.metadata?.source === 'automation');
  const approved = humanReviews.filter((review) => review.decision === 'approved');
  const rejected = humanReviews.filter((review) => review.decision === 'rejected');
  const edited = approved.filter((review) => review.recipient_edited);
  const requestIds = new Set(requests.map((request) => request.id));
  const initialCommunications = communications.filter((communication) => (
    requestIds.has(communication.cim_request_id)
    && communication.direction === 'outbound'
    && communication.kind === 'deal-hunter-cim-request'
  ));
  const communicationIds = new Set(initialCommunications.map((communication) => communication.id));
  const providerMessageKeys = new Set(initialCommunications.flatMap((communication) => [
    communication.provider_message_id ? `${communication.provider || 'resend'}:${communication.provider_message_id}` : '',
  ]).filter(Boolean));
  const lifecycleEvents = events.filter((event) => communicationIds.has(event.communication_id)
    || providerMessageKeys.has(`${event.provider || 'resend'}:${event.message_id}`));
  const countInitialState = (state) => initialCommunications.filter((communication) => communication.delivery_state === state).length;
  const delivered = countInitialState('delivered');
  const bounced = countInitialState('bounced');
  const complained = countInitialState('complained');
  const failed = countInitialState('failed') + countInitialState('suppressed');
  const sent = initialCommunications.filter((communication) => acceptedInitialStates.has(communication.delivery_state)).length;
  const passReasonCounts = rejected.reduce((counts, review) => {
    const reason = review.pass_reason || 'other';
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
  const responseOutcomes = {};
  for (const review of reviews.filter((item) => item.metadata?.source === 'response-outcome' && item.deal_key)) {
    if (!responseOutcomes[review.deal_key]) responseOutcomes[review.deal_key] = review.metadata?.outcome || '';
  }
  const positiveResponses = Object.values(responseOutcomes).filter((outcome) => outcome === 'positive').length;
  const replied = requests.filter((request) => request.responded_at || request.request_state === 'responded' || request.status === 'responded').length;
  const uniqueRecipients = [...new Set(requests.map((request) => normalizeEmail(request.recipient_email)).filter(Boolean))].slice(0, 5000);
  const suppressions = storage.getActiveEmailSuppression
    ? (await Promise.all(uniqueRecipients.map((recipient) => Promise.resolve(storage.getActiveEmailSuppression(recipient)).catch(() => null)))).filter(Boolean)
    : [];
  const explicitOptOuts = suppressions.filter((item) => item.reason === 'explicit-opt-out').length;
  const adverseCutoff = now.getTime() - policy.adverseEventWindowDays * 24 * 60 * 60 * 1000;
  const adverseInitials = initialCommunications.filter((communication) => {
    if (!adverseDeliveryStates.has(communication.delivery_state)) return false;
    const observedAt = safeDateMs(communication.delivery_state_at || communication.occurred_at || communication.created_at);
    return observedAt === 0 || observedAt >= adverseCutoff;
  }).length;
  const cohortUnchangedApprovalRate = roundRate(evidence.unchangedApprovals.length, evidence.cohort.length);
  const metrics = {
    reviewed: humanReviews.length,
    canonicalHumanReviews: humanReviews.length,
    rawHumanReviewRows: evidence.rawHumanRows,
    compatibleEvidence: humanReviews.filter((review) => review.current_policy).length,
    legacyUnversionedEvidence: humanReviews.filter((review) => !review.current_policy).length,
    incompatibleEvidence: evidence.incompatiblePolicy,
    unlinkedEvidence: evidence.unlinked,
    ambiguousEvidence: evidence.ambiguous,
    unsupportedActorEvidence: evidence.unsupportedActor,
    remainingStage2Reviews: Math.max(0, policy.stage2MinimumReviews - humanReviews.length),
    stage2EligibleCohort: evidence.cohort.length,
    stage2UnchangedApprovals: evidence.unchangedApprovals.length,
    stage2CohortIdentityProblems: evidence.cohortIdentityProblems.length,
    stage2UnchangedApprovalRate: cohortUnchangedApprovalRate,
    automatedReviews: automatedReviews.length,
    approved: approved.length,
    rejected: rejected.length,
    approvalRate: roundRate(approved.length, humanReviews.length),
    rejectionRate: roundRate(rejected.length, humanReviews.length),
    passReasons: passReasonCounts,
    recipientEdits: edited.length,
    recipientEditRate: roundRate(edited.length, approved.length),
    requests: requests.length,
    sent,
    logicalInitialMessages: initialCommunications.length,
    rawLifecycleEvents: lifecycleEvents.length,
    delivered,
    bounced,
    complained,
    failed,
    adverseInitials,
    adverseEventWindowDays: policy.adverseEventWindowDays,
    explicitOptOuts,
    activeSuppressions: suppressions.length,
    deliveryRate: roundRate(delivered, initialCommunications.length),
    bounceRate: roundRate(bounced, initialCommunications.length),
    replies: replied,
    replyRate: roundRate(replied, initialCommunications.length),
    positiveResponses,
    positiveResponseRate: roundRate(positiveResponses, Math.max(1, replied)),
    responseOutcomes,
    duplicateListingRate: roundRate(rejected.filter((review) => review.pass_reason === 'duplicate').length, humanReviews.length),
    incorrectRecipientRate: roundRate(rejected.filter((review) => review.pass_reason === 'recipient').length + edited.length, humanReviews.length),
    latestReviews: reviews.slice(0, 100),
  };
  const latestHumanByDeal = new Map();
  const latestHumanByOpportunity = new Map();
  for (const review of humanReviews) {
    if (!latestHumanByDeal.has(review.deal_key)) latestHumanByDeal.set(review.deal_key, review);
    if (!latestHumanByOpportunity.has(review.opportunity_id)) latestHumanByOpportunity.set(review.opportunity_id, review);
  }
  Object.defineProperty(metrics, 'latestHumanByDeal', { value: latestHumanByDeal, enumerable: false });
  Object.defineProperty(metrics, 'latestHumanByOpportunity', { value: latestHumanByOpportunity, enumerable: false });
  Object.defineProperty(metrics, 'canonicalLatestReviews', { value: humanReviews, enumerable: false });
  return metrics;
}

export async function recordCimReviewDecisions({
  decisions = [], actor = '', actorRole = 'admin', stage = 1, source = 'approval-queue', storage = getStorage(),
} = {}) {
  const createdAt = new Date().toISOString();
  const safe = (Array.isArray(decisions) ? decisions : []).slice(0, 100).map((decision) => {
    const result = decision?.decision === 'approved' ? 'approved' : 'rejected';
    const originalRecipient = normalizeEmail(decision?.originalRecipientEmail);
    const finalRecipient = normalizeEmail(decision?.finalRecipientEmail || originalRecipient);
    const reason = result === 'rejected' && passReasons.has(decision?.passReason) ? decision.passReason : result === 'rejected' ? 'other' : '';
    return {
      id: randomUUID(), created_at: createdAt, decision_at: decision?.decisionAt || createdAt,
      deal_key: normalizeText(decision?.dealKey, 1000), opportunity_id: normalizeText(decision?.opportunityId, 160) || null,
      decision: result, pass_reason: reason, original_recipient_email: originalRecipient,
      final_recipient_email: finalRecipient, recipient_edited: originalRecipient !== finalRecipient,
      score: Number.isFinite(Number(decision?.score)) ? Number(decision.score) : null,
      actor: normalizeText(actor || 'admin', 160), actor_role: normalizeText(actorRole || 'admin', 80),
      automation_stage: Math.max(1, Math.min(Number(stage) || 1, 3)),
      snapshot_digest: normalizeText(decision?.snapshotDigest, 64) || null,
      evidence_version: normalizeText(decision?.evidenceVersion || CIM_STAGE2_EVIDENCE_VERSION, 100),
      rule_version: normalizeText(decision?.ruleVersion, 100) || null,
      source_policy_version: normalizeText(decision?.sourcePolicyVersion, 100) || null,
      source_policy_hash: normalizeText(decision?.sourcePolicyHash, 64) || null,
      source_ids: [...new Set((decision?.sourceIds || []).map((value) => normalizeText(value, 200)).filter(Boolean))],
      metadata: {
        dealName: normalizeText(decision?.dealName, 220),
        recipientName: normalizeText(decision?.finalRecipientName, 160),
        source,
        stage2CohortEligible: decision?.stage2CohortEligible === true,
      },
    };
  }).filter((decision) => decision.deal_key && (source !== 'approval-queue' || decision.opportunity_id));
  if (safe.length === 0) return [];
  if (!storage.insertDealHunterCimReviews) throw new Error('CIM review decision storage is not configured.');
  return storage.insertDealHunterCimReviews(safe);
}

export async function recordCimResponseOutcome({ dealKey = '', outcome = '', actor = '', storage = getStorage() } = {}) {
  if (!dealKey || !['positive', 'negative', 'neutral'].includes(outcome)) throw new Error('A valid CIM response outcome is required.');
  if (!storage.insertDealHunterCimReviews) throw new Error('CIM response outcome storage is not configured.');
  const requests = await storage.listDealHunterCimRequests?.({ dealKeys: [String(dealKey)], limit: 100 }) || [];
  const responded = requests.some((request) => request.deal_key === String(dealKey) && (request.responded_at || request.status === 'responded'));
  if (!responded) throw new Error('A broker response must be recorded before classifying its outcome.');
  const now = new Date().toISOString();
  const review = {
    id: randomUUID(), created_at: now, decision_at: now, deal_key: normalizeText(dealKey, 1000),
    opportunity_id: requests.find((request) => request.opportunity_id)?.opportunity_id || null,
    decision: 'outcome', pass_reason: '', original_recipient_email: '', final_recipient_email: '',
    recipient_edited: false, score: null, actor: normalizeText(actor || 'admin', 160), actor_role: 'admin', automation_stage: 1,
    snapshot_digest: null, evidence_version: null, rule_version: null, source_policy_version: null,
    source_policy_hash: null, source_ids: [], metadata: { source: 'response-outcome', outcome },
  };
  await storage.insertDealHunterCimReviews([review]);
  return review;
}

function gate(code, passed, observed, required, reason, evidenceAt = '') {
  return { code, passed: Boolean(passed), observed, required, reason: passed ? '' : reason, evidenceAt };
}

function safeCheck(promise, fallback) {
  return Promise.resolve(promise).then((value) => value ?? fallback).catch(() => fallback);
}

function activationIsFresh(activation, now, policy) {
  const expiresAt = safeDateMs(activation?.expires_at);
  const createdAt = safeDateMs(activation?.created_at);
  return Boolean(expiresAt > now.getTime()
    && createdAt > 0
    && now.getTime() - createdAt <= policy.activationMaxAgeHours * 60 * 60 * 1000);
}

function evidenceChecksum({ metrics, identity, email, policy, unresolvedAmbiguousDecisions = 0 }) {
  return cimStage2Digest({
    policyHash: policy.policyHash,
    sourcePolicyHash: policy.sourcePolicyHash,
    canonicalHumanReviews: metrics.canonicalHumanReviews,
    eligibleCohort: metrics.stage2EligibleCohort,
    unchangedApprovalRate: metrics.stage2UnchangedApprovalRate,
    cohortIdentityProblems: metrics.stage2CohortIdentityProblems,
    adverseInitials: metrics.adverseInitials,
    explicitOptOuts: metrics.explicitOptOuts,
    unresolvedAmbiguousDecisions,
    identity: {
      exceptions: identity.unresolvedIdentityExceptions,
      duplicateActiveSequences: identity.duplicateActiveSequences,
      missingOpportunityLinks: identity.missingOpportunityLinks,
      linkageMismatches: identity.linkageMismatches,
    },
    replyReady: Boolean(email.replyTrackingConfigured && email.replyTrackingVerified),
    suppressionOperational: Boolean(email.suppressionOperational),
  });
}

export async function getCimAutomationStatus({
  storage = getStorage(), config = getConfig(), now = new Date(), privacySafe = false,
} = {}) {
  const policy = getCimStage2Policy(config);
  const window = evaluateCimStage2Window(now, policy);
  const [metrics, persisted, activation, email, identity, storageHealth, shadowRuns, liveRuns, capacityUsed, ambiguousDecisions] = await Promise.all([
    getCimAutomationMetrics({ storage, config, now }),
    safeCheck(storage.getDealHunterAutomationSettings?.(), null),
    safeCheck(storage.getCurrentCimStage2Activation?.(), null),
    safeCheck(getEmailReadiness({ storage, config }), {}),
    safeCheck(getCimIdentityOperationsStatus({ storage, config, privacySafe }), {
      pause: { paused: true, source: 'identity-status-unavailable' }, storageHealthy: false,
      unresolvedIdentityExceptions: null, duplicateActiveSequences: null, missingOpportunityLinks: null, linkageMismatches: null,
    }),
    safeCheck(storage.checkCimStage2Storage?.(), { ok: false }),
    safeCheck(storage.listCimStage2Runs?.({ mode: 'shadow', policyHash: policy.policyHash, limit: 5 }), []),
    safeCheck(storage.listCimStage2Runs?.({ policyHash: policy.policyHash, limit: 25 }), []),
    safeCheck(storage.countCimStage2Capacity?.({ pacificBusinessDate: window.dateKey }), Number.POSITIVE_INFINITY),
    storage.listCimStage2Decisions
      ? safeCheck(storage.listCimStage2Decisions({ state: 'ambiguous', limit: 1 }), [{}])
      : [{}],
  ]);
  const generatedAt = now.toISOString();
  const unresolvedAmbiguousDecisions = ambiguousDecisions.length;
  const checksum = evidenceChecksum({ metrics, identity, email, policy, unresolvedAmbiguousDecisions });
  const automationPaused = Boolean(config.dealHunter?.cimAutomation?.paused || persisted?.paused);
  const centralPaused = identity.pause?.paused !== false;
  const currentShadow = shadowRuns.find((run) => run.policy_hash === policy.policyHash && ['completed', 'blocked'].includes(run.status));
  const latestLiveRun = liveRuns.find((run) => ['canary', 'active'].includes(run.mode)) || null;
  const shadowFresh = Boolean(currentShadow && safeDateMs(currentShadow.completed_at || currentShadow.updated_at)
    >= now.getTime() - policy.shadowFreshnessHours * 60 * 60 * 1000);
  const shadowSourceHealthy = Boolean(currentShadow?.metadata?.sourcePolicyHealthy && currentShadow?.metadata?.coverageComplete);
  const activationMode = automationModes.has(activation?.mode) ? activation.mode : 'off';
  const activationFresh = activationIsFresh(activation, now, policy);
  const activationPolicyMatches = Boolean(activation && activation.policy_hash === policy.policyHash
    && activation.source_policy_hash === policy.sourcePolicyHash && activation.rule_version === policy.rules.version);
  // The evidence digest is stable while its underlying evidence is unchanged;
  // the separately stored generated-at value proves the accepted snapshot was fresh.
  const acceptedChecksum = activation ? evidenceChecksum({
    metrics, identity, email, policy, unresolvedAmbiguousDecisions,
  }) : '';
  const acceptedEvidenceMatches = Boolean(activation && activation.evidence_checksum === acceptedChecksum);
  const dailyCap = activationMode === 'canary' ? policy.caps.canaryDailyInitials : policy.caps.activeDailyInitials;
  const remainingCapacity = Number.isFinite(Number(capacityUsed)) ? Math.max(0, dailyCap - Number(capacityUsed)) : 0;
  const sourcePolicyConfigured = policy.sourcePolicy.allowedSourceIds.length === 1
    && policy.sourcePolicy.allowedSourceIds[0] === 'sheet-0'
    && (config.dealHunter?.sheetCsvUrls || []).length === 1
    && config.dealHunter?.airtableEnabled === false;
  const senderConfigured = Boolean(email.outboundConfigured && email.replyTrackingConfigured);
  const readiness = [
    gate('stage2_storage', storageHealth?.ok, storageHealth?.ok ? 'available' : 'missing', 'available', 'Required Stage 2 tables or review-evidence columns are unavailable.'),
    gate('canonical_human_reviews', metrics.canonicalHumanReviews >= policy.stage2MinimumReviews, metrics.canonicalHumanReviews, policy.stage2MinimumReviews, `${metrics.remainingStage2Reviews} additional genuine canonical human decision(s) are required.`),
    gate('eligible_cohort_reviews', metrics.stage2EligibleCohort >= policy.stage2MinimumEligibleCohort, metrics.stage2EligibleCohort, policy.stage2MinimumEligibleCohort, 'The current trusted-rule cohort lacks enough policy-compatible human reviews.'),
    gate('unchanged_recipient_approval', metrics.stage2UnchangedApprovalRate >= policy.stage2MinimumUnchangedApprovalRate * 100, metrics.stage2UnchangedApprovalRate, policy.stage2MinimumUnchangedApprovalRate * 100, 'Unchanged-recipient approval quality is below the conservative minimum.'),
    gate('cohort_identity_quality', metrics.stage2CohortIdentityProblems === 0, metrics.stage2CohortIdentityProblems, 0, 'The eligible cohort contains a duplicate, incorrect-recipient, or recipient-edit decision.'),
    gate('identity_health', identity.storageHealthy && identity.unresolvedIdentityExceptions === 0 && identity.duplicateActiveSequences === 0 && identity.missingOpportunityLinks === 0 && identity.linkageMismatches === 0,
      { storageHealthy: Boolean(identity.storageHealthy), unresolvedIdentityExceptions: identity.unresolvedIdentityExceptions, duplicateActiveSequences: identity.duplicateActiveSequences, missingOpportunityLinks: identity.missingOpportunityLinks, linkageMismatches: identity.linkageMismatches },
      { unresolvedIdentityExceptions: 0, duplicateActiveSequences: 0, missingOpportunityLinks: 0, linkageMismatches: 0 }, 'Canonical identity or request/communication linkage requires review.'),
    gate('adverse_event_health', metrics.adverseInitials === 0 && metrics.explicitOptOuts === 0, { adverseInitials: metrics.adverseInitials, explicitOptOuts: metrics.explicitOptOuts }, { adverseInitials: 0, explicitOptOuts: 0 }, 'A complaint, bounce, failure, suppression, or explicit opt-out requires review.'),
    gate('provider_reconciliation', unresolvedAmbiguousDecisions === 0, unresolvedAmbiguousDecisions, 0, 'An ambiguous provider outcome must be reconciled before any further automatic broker outreach.'),
    gate('reply_readiness', email.replyTrackingConfigured && email.replyTrackingVerified, Boolean(email.replyTrackingVerified), true, 'Signed inbound reply tracking has not been verified end to end.'),
    gate('suppression_readiness', email.suppressionOperational, Boolean(email.suppressionOperational), true, 'The global suppression store is not operationally verified.'),
    gate('sender_configuration', senderConfigured, senderConfigured, true, 'Accurate Resend From and verified Reply-To behavior are not fully configured.'),
    gate('compliance_copy_configuration', policy.compliance.postalAddressConfigured && policy.compliance.replyOptOutEnabled && policy.compliance.classificationAccepted && policy.compliance.copyAccepted,
      policy.compliance, 'postal address, reply opt-out, classification acceptance, and copy acceptance', 'Conservative Stage 2 compliance/copy configuration is incomplete; this is a technical gate, not legal advice.'),
    gate('sender_authentication', policy.compliance.senderAuthenticationAttested && policy.compliance.dmarcReviewed,
      { senderAuthenticationAttested: policy.compliance.senderAuthenticationAttested, dmarcReviewed: policy.compliance.dmarcReviewed },
      { senderAuthenticationAttested: true, dmarcReviewed: true }, 'SPF/DKIM readiness and DMARC review have not been attested for the actual From domain.'),
    gate('source_policy_configuration', sourcePolicyConfigured, policy.sourcePolicy.allowedSourceIds, ['sheet-0'], 'Stage 2 must be restricted to the single accepted SMB Deal Hunter Sheet source.'),
    gate('authoritative_caps', policy.caps.recipient24Hours === 1 && policy.caps.recipient30Days === 4 && policy.caps.canaryDailyInitials === 1,
      policy.caps, { recipient24Hours: 1, recipient30Days: 4, canaryDailyInitials: 1 }, 'The accepted 1/24-hour, 4/30-day, and 1/Pacific-business-day canary caps must remain authoritative.'),
    gate('current_shadow_evidence', shadowFresh && shadowSourceHealthy, currentShadow ? { completedAt: currentShadow.completed_at, sourcePolicyHealthy: shadowSourceHealthy } : null, 'fresh, complete, policy-matching shadow run', 'A fresh Stage 2 shadow run with complete Sheet-only coverage is required.'),
    gate('followups_disabled', config.dealHunter?.cimFollowUp?.enabled === false, Boolean(config.dealHunter?.cimFollowUp?.enabled), false, 'CIM follow-ups must remain disabled for the Stage 2 rollout.'),
    gate('activation_record', Boolean(activation && activation.status === 'current'), activationMode, 'current durable activation', 'No current release-owner Stage 2 activation is recorded.'),
    gate('activation_mode', ['canary', 'active'].includes(activationMode), activationMode, 'canary or active', 'The durable activation is off or shadow-only, so provider work is forbidden.'),
    gate('activation_freshness', activationFresh, activation?.expires_at || null, `within ${policy.activationMaxAgeHours} hours`, 'The Stage 2 activation is stale or expired.'),
    gate('activation_policy_hash', activationPolicyMatches, activation?.policy_hash || null, policy.policyHash, 'The accepted rule/config/source-policy hash no longer matches runtime policy.'),
    gate('activation_evidence', acceptedEvidenceMatches, activation?.evidence_checksum || null, acceptedChecksum || checksum, 'The accepted evidence checksum no longer matches the current canonical evidence snapshot.'),
    gate('activation_backup', Boolean(activation?.backup_reference && activation?.backup_checksum), Boolean(activation?.backup_reference && activation?.backup_checksum), true, 'Fresh verified backup evidence is not bound to activation.'),
    gate('activation_identity_audit', Boolean(activation?.identity_audit_reference && activation?.identity_audit_checksum), Boolean(activation?.identity_audit_reference && activation?.identity_audit_checksum), true, 'A dry-run identity audit reference/checksum is not bound to activation.'),
    gate('central_outreach_pause', !centralPaused, centralPaused, false, 'The central all-CIM-outreach pause is active or unavailable.'),
    gate('automation_pause', !automationPaused, automationPaused, false, 'The automation-only emergency pause is active.'),
    gate('operating_window', window.open, window.reason || 'open', `${policy.window.start}-${policy.window.end} ${policy.window.timezone}, weekdays`, 'The current time is outside the Pacific weekday operating window.'),
    gate('daily_capacity', remainingCapacity > 0, Number(capacityUsed), `< ${dailyCap}`, 'The accepted Pacific business-day automatic-initial capacity is exhausted.'),
  ].map((item) => ({ ...item, evidenceAt: item.evidenceAt || generatedAt }));
  const evidenceGateCodes = new Set([
    'stage2_storage', 'canonical_human_reviews', 'eligible_cohort_reviews', 'unchanged_recipient_approval',
    'cohort_identity_quality', 'identity_health', 'adverse_event_health', 'provider_reconciliation', 'reply_readiness',
    'suppression_readiness', 'sender_configuration', 'compliance_copy_configuration',
    'sender_authentication', 'source_policy_configuration', 'authoritative_caps', 'current_shadow_evidence', 'followups_disabled',
  ]);
  const evidenceStage = readiness.filter((item) => evidenceGateCodes.has(item.code)).every((item) => item.passed) ? 2 : 1;
  const configuredStage = policy.configuredStage;
  const automaticTransmissionAllowed = configuredStage >= 2
    && evidenceStage >= 2
    && readiness.every((item) => item.passed);
  const effectiveStage = automaticTransmissionAllowed ? 2 : 1;
  const blockers = readiness.filter((item) => !item.passed);
  return {
    configuredStage,
    evidenceStage,
    effectiveStage,
    activationMode,
    automaticTransmissionAllowed,
    blockerCodes: blockers.map((item) => item.code),
    paused: automationPaused,
    automationPaused,
    centralOutreachPaused: centralPaused,
    pauseSource: persisted?.paused ? 'emergency-control' : config.dealHunter?.cimAutomation?.paused ? 'configuration' : '',
    stage2Ready: evidenceStage >= 2,
    stage3Ready: false,
    stage2Readiness: readiness,
    policy: { ...config.dealHunter?.cimAutomation, ...policy },
    recipientPolicy: config.dealHunter?.cimOutreach || {},
    metrics,
    identitySummary: {
      canonicalOpportunities: identity.canonicalOpportunities,
      unresolvedIdentityExceptions: identity.unresolvedIdentityExceptions,
      duplicateActiveSequences: identity.duplicateActiveSequences,
      recipientsAtCap: identity.recipientsAtCap,
      recipientCapDeferrals: identity.recipientCapDeferrals,
      outOfWindowDeferrals: identity.outOfWindowDeferrals,
      missingOpportunityLinks: identity.missingOpportunityLinks,
      linkageMismatches: identity.linkageMismatches,
      safelyRepairableLinks: identity.safelyRepairableLinks,
    },
    unresolvedAmbiguousDecisions,
    activation: activation ? {
      id: activation.id,
      mode: activation.mode,
      actor: activation.actor,
      createdAt: activation.created_at,
      expiresAt: activation.expires_at,
      reason: activation.reason,
      policyHash: activation.policy_hash,
      sourcePolicyHash: activation.source_policy_hash,
      evidenceChecksum: activation.evidence_checksum,
      evidenceGeneratedAt: activation.evidence_generated_at,
      backupReference: activation.backup_reference,
      identityAuditReference: activation.identity_audit_reference,
    } : null,
    evidenceChecksum: checksum,
    evidenceGeneratedAt: generatedAt,
    operatingWindow: window,
    capacity: { used: Number.isFinite(Number(capacityUsed)) ? Number(capacityUsed) : null, limit: dailyCap, remaining: remainingCapacity, pacificBusinessDate: window.dateKey },
    latestShadowRun: currentShadow || null,
    latestLiveRun,
    safeNextAction: blockers[0]?.reason || 'Stage 2 provider work is authorized under the current canary/active acceptance.',
  };
}

export async function isCimAutomationPaused({ storage = getStorage(), config = getConfig() } = {}) {
  const persisted = await storage.getDealHunterAutomationSettings?.() || null;
  return Boolean(config.dealHunter?.cimAutomation?.paused || persisted?.paused);
}

export async function setCimAutomationPaused({ paused, actor = '', reason = '', storage = getStorage() } = {}) {
  if (!storage.upsertDealHunterAutomationSettings) throw new Error('CIM automation settings storage is not configured.');
  const safeReason = normalizeText(reason, 500);
  if (!paused && safeReason.length < 20) {
    throw new Error('Clearing the automation pause requires an accountable reason of at least 20 characters.');
  }
  return storage.upsertDealHunterAutomationSettings({
    updated_at: new Date().toISOString(), paused: Boolean(paused), updated_by: actor,
    metadata: { reason: safeReason || 'Emergency automation pause enabled by the authenticated operator.' },
  });
}

export function expectedCimStage2Confirmation(mode = '') {
  return CIM_STAGE2_ACTIVATION_CONFIRMATIONS[mode] || '';
}

function checksumValue(value = '') {
  return /^[a-f0-9]{64}$/i.test(normalizeText(value, 64));
}

export async function createCimStage2Activation({
  mode = '', confirmation = '', actor = '', reason = '', evidenceChecksum: acceptedEvidenceChecksum = '',
  evidenceGeneratedAt = '', backupReference = '', backupChecksum = '', identityAuditReference = '',
  identityAuditChecksum = '', complianceReference = '', senderAuthReference = '', storage = getStorage(),
  config = getConfig(), now = new Date(), statusCheck = getCimAutomationStatus,
} = {}) {
  const normalizedMode = normalizeText(mode, 20).toLowerCase();
  const policy = getCimStage2Policy(config);
  if (!automationModes.has(normalizedMode)) throw new Error('Activation mode must be off, shadow, canary, or active.');
  if (confirmation !== expectedCimStage2Confirmation(normalizedMode)) throw new Error(`Enter the exact confirmation phrase: ${expectedCimStage2Confirmation(normalizedMode)}`);
  if (normalizeText(reason, 1000).length < 20) throw new Error('A substantive activation reason of at least 20 characters is required.');
  if (!normalizeText(actor, 200)) throw new Error('An accountable activation actor is required.');
  if (!storage.createCimStage2Activation) throw new Error('Stage 2 activation storage is unavailable.');
  const status = await statusCheck({ storage, config, now });
  const liveMode = ['canary', 'active'].includes(normalizedMode);
  if (liveMode && status.evidenceStage < 2) throw new Error('Stage 2 evidence/readiness gates do not pass. Live activation remains blocked.');
  const acceptedEvidenceAtMs = safeDateMs(evidenceGeneratedAt);
  const evidenceAgeMs = now.getTime() - acceptedEvidenceAtMs;
  if (liveMode && (
    !acceptedEvidenceChecksum
    || acceptedEvidenceChecksum !== status.evidenceChecksum
    || acceptedEvidenceAtMs === 0
    || evidenceAgeMs < 0
    || evidenceAgeMs > 10 * 60 * 1000
  )) {
    throw new Error('The accepted evidence checksum must match the current readiness snapshot and its generated-at timestamp must be within the last 10 minutes.');
  }
  if (liveMode && (!normalizeText(backupReference, 500) || !checksumValue(backupChecksum))) throw new Error('A fresh verified backup reference and SHA-256 checksum are required.');
  if (liveMode && (!normalizeText(identityAuditReference, 500) || !checksumValue(identityAuditChecksum))) throw new Error('A dry-run identity audit reference and SHA-256 checksum are required.');
  if (liveMode && (!normalizeText(complianceReference, 500) || !normalizeText(senderAuthReference, 500))) throw new Error('Compliance/copy and sender-authentication acceptance references are required.');
  const createdAt = now.toISOString();
  const record = {
    id: randomUUID(), created_at: createdAt, updated_at: createdAt, status: 'current', mode: normalizedMode,
    actor: normalizeText(actor, 200), reason: normalizeText(reason, 1000), confirmation_phrase: confirmation,
    policy_hash: policy.policyHash, rule_version: policy.rules.version,
    source_policy_version: policy.sourcePolicy.version, source_policy_hash: policy.sourcePolicyHash,
    evidence_checksum: liveMode ? acceptedEvidenceChecksum : status.evidenceChecksum,
    evidence_generated_at: liveMode ? evidenceGeneratedAt : status.evidenceGeneratedAt,
    backup_reference: normalizeText(backupReference, 500) || 'not-required-non-transmitting-mode',
    backup_checksum: normalizeText(backupChecksum, 64) || cimStage2Digest('not-required-non-transmitting-mode'),
    identity_audit_reference: normalizeText(identityAuditReference, 500) || 'not-required-non-transmitting-mode',
    identity_audit_checksum: normalizeText(identityAuditChecksum, 64) || cimStage2Digest('not-required-non-transmitting-mode'),
    compliance_reference: normalizeText(complianceReference, 500) || 'not-required-non-transmitting-mode',
    sender_auth_reference: normalizeText(senderAuthReference, 500) || 'not-required-non-transmitting-mode',
    timezone: policy.window.timezone, window_start: policy.window.start, window_end: policy.window.end,
    weekdays_only: policy.window.weekdaysOnly, canary_daily_cap: 1, active_daily_cap: policy.caps.activeDailyInitials,
    recipient_cap_24_hours: policy.caps.recipient24Hours, recipient_cap_30_days: policy.caps.recipient30Days,
    expires_at: new Date(now.getTime() + policy.activationMaxAgeHours * 60 * 60 * 1000).toISOString(),
    superseded_at: null, superseded_by: null,
    metadata: { configurationStage: policy.configuredStage, automaticTransmissionAuthorized: liveMode },
  };
  const auditEvent = {
    id: randomUUID(), created_at: createdAt, request_id: `cim-stage2-activation:${record.id}`,
    actor: record.actor, role: 'admin', method: 'SERVICE', path: '/cim-stage2/activation-intent', status_code: 202,
    metadata: {
      mode: normalizedMode, reason: record.reason, policyHash: policy.policyHash,
      evidenceChecksum: record.evidence_checksum, activationId: record.id,
    },
  };
  if (liveMode) {
    if (!storage.insertAdminAuditEvent) throw new Error('Append-only admin audit storage is required before live Stage 2 activation.');
    await storage.insertAdminAuditEvent(auditEvent);
  } else if (storage.insertAdminAuditEvent) {
    await storage.insertAdminAuditEvent(auditEvent).catch(() => null);
  }
  return storage.createCimStage2Activation(record);
}

function sourceIdsForDeal(deal = {}) {
  return [...new Set([
    normalizeText(deal.sourceId, 200),
    ...(Array.isArray(deal.sourceRecords) ? deal.sourceRecords.map((record) => normalizeText(record?.sourceId, 200)) : []),
  ].filter(Boolean))].sort();
}

export function sourceSnapshotDigestForDeal(deal = {}) {
  return cimStage2Digest({
    sourceIds: sourceIdsForDeal(deal),
    sourceRecords: (deal.sourceRecords || []).map((record) => ({
      sourceId: normalizeText(record?.sourceId, 200), externalId: normalizeText(record?.externalId, 120),
      stableExternalId: Boolean(record?.stableExternalId), listingUrl: normalizeText(record?.listingUrl, 1000),
    })),
    listingUrl: normalizeText(deal.listingUrl, 1000),
    lastUpdated: normalizeText(deal.lastUpdated, 100),
  });
}

export function cimStage2SnapshotDigest(deal = {}) {
  return cimStage2Digest({
    opportunityId: normalizeText(deal.opportunityId || deal.opportunity_id, 160),
    dealKey: normalizeText(deal.dealKey || deal.deal_key, 1000),
    recipientHash: hashCimStage2Recipient(deal.brokerEmail || deal.recipient_email),
    brokerName: normalizeText(deal.brokerName, 220),
    score: Number(deal.score || 0), industry: normalizeText(deal.industry, 220), location: normalizeText(deal.location, 220),
    annualProfit: Number(deal.annualProfit || 0), profitMultiple: Number(deal.profitMultiple || 0),
    listingUrl: normalizeText(deal.listingUrl, 1000), sourceSnapshotDigest: sourceSnapshotDigestForDeal(deal),
  });
}

export function assessCimStage2SourceReview(review = {}, policy = getCimStage2Policy(), now = new Date()) {
  const sources = Array.isArray(review.sources) ? review.sources : [];
  const configuredIds = sources.map((source) => normalizeText(source.id, 200)).filter(Boolean).sort();
  const unexpected = configuredIds.filter((id) => !policy.sourcePolicy.allowedSourceIds.includes(id));
  const missing = policy.sourcePolicy.allowedSourceIds.filter((id) => !configuredIds.includes(id));
  const failed = sources.filter((source) => !source.fetched || source.error).map((source) => normalizeText(source.id, 200));
  const empty = sources.filter((source) => source.fetched && Number(source.rowCount || 0) <= 0)
    .map((source) => normalizeText(source.id, 200));
  const duplicateSourceIds = configuredIds.length - new Set(configuredIds).size;
  const warningSource = Array.isArray(review.stage2CoverageWarnings) ? review.stage2CoverageWarnings : review.coverageWarnings;
  const warnings = Array.isArray(warningSource) ? warningSource.filter(Boolean) : [];
  const generatedAt = safeDateMs(review.generatedAt);
  const stale = !generatedAt || now.getTime() - generatedAt > policy.sourcePolicy.maximumAgeHours * 60 * 60 * 1000;
  const futureTimestamp = generatedAt > now.getTime() + 5 * 60 * 1000;
  const blockerCodes = [];
  if (sources.length === 0) blockerCodes.push('source_evidence_missing');
  if (unexpected.length > 0) blockerCodes.push('unexpected_source');
  if (missing.length > 0) blockerCodes.push('allowed_source_missing');
  if (failed.length > 0) blockerCodes.push('source_failure');
  if (empty.length > 0) blockerCodes.push('source_empty');
  if (duplicateSourceIds > 0) blockerCodes.push('duplicate_source_configuration');
  if (warnings.length > 0) blockerCodes.push('coverage_warning');
  if (stale) blockerCodes.push('source_stale');
  if (futureTimestamp) blockerCodes.push('source_timestamp_invalid');
  return {
    healthy: blockerCodes.length === 0,
    blockerCodes,
    configuredIds,
    unexpectedCount: unexpected.length,
    missingCount: missing.length,
    failedCount: failed.length,
    emptyCount: empty.length,
    duplicateSourceCount: duplicateSourceIds,
    warningCount: warnings.length,
    generatedAt: review.generatedAt || '',
  };
}

function reason(code, message) {
  return { code, message };
}

function exactSourceContact(deal, email) {
  return (Array.isArray(deal.brokerContacts) ? deal.brokerContacts : []).find((contact) => (
    normalizeEmail(contact?.email) === email
    && normalizeText(contact?.name, 220)
    && normalizeText(contact?.sourceColumn, 220)
  ));
}

function containsTrustedIndustryTerm(value = '', term = '') {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(value);
}

export function assessCimStage2StaticCandidate(deal = {}, { policy = getCimStage2Policy() } = {}) {
  const reasons = [];
  const email = normalizeEmail(deal.brokerEmail);
  const mailbox = email.split('@')[0];
  const mailboxSegments = mailbox.split(/[^a-z0-9]+/).filter(Boolean);
  const text = `${deal.name || ''} ${deal.industry || ''}`.toLowerCase();
  const location = normalizeText(deal.location, 220).toUpperCase();
  const sourceIds = sourceIdsForDeal(deal);
  const sourceContact = exactSourceContact(deal, email);
  if (Number(deal.score || 0) < policy.rules.minimumScore) reasons.push(reason('score_below_90', `Score must be at least ${policy.rules.minimumScore}.`));
  if (!normalizeText(deal.opportunityId || deal.opportunity_id, 160) || deal.identityStatus !== 'resolved') reasons.push(reason('canonical_identity_unresolved', 'Canonical opportunity identity is not resolved.'));
  if (!normalizeText(deal.listingUrl, 1000)) reasons.push(reason('listing_url_missing', 'An original listing URL is required.'));
  if (sourceIds.length === 0 || sourceIds.some((id) => !policy.sourcePolicy.allowedSourceIds.includes(id))) reasons.push(reason('source_provenance_not_allowed', 'Candidate provenance is not exclusively within the accepted SMB Sheet allowlist.'));
  if (!normalizeText(deal.brokerName, 220)) reasons.push(reason('broker_name_missing', 'A source-provided broker/contact name is required.'));
  if (!isValidEmail(email) || !sourceContact) reasons.push(reason('source_recipient_unverified', 'The exact source-provided direct recipient address is required.'));
  if (genericMailboxNames.has(mailbox) || genericMailboxNames.has(mailboxSegments[0])) {
    reasons.push(reason('generic_mailbox', 'Generic broker mailboxes are not eligible for automation.'));
  }
  if (!trustedIndustryTerms.some((term) => containsTrustedIndustryTerm(text, term))) {
    reasons.push(reason('industry_not_trusted', 'Industry is outside the versioned trusted list.'));
  }
  if (!policy.rules.targetStates.some((state) => new RegExp(`(^|[^A-Z])${state}([^A-Z]|$)`).test(location))) {
    reasons.push(reason('geography_not_trusted', 'Geography is outside the versioned target states.'));
  }
  if (!(Number(deal.annualProfit) >= policy.rules.minimumAnnualProfit && Number(deal.annualProfit) <= policy.rules.maximumAnnualProfit)) reasons.push(reason('profit_outside_profile', 'Annual profit is outside the accepted acquisition profile.'));
  if (!Number(deal.profitMultiple) || Number(deal.profitMultiple) > policy.rules.maximumProfitMultiple) reasons.push(reason('multiple_outside_profile', 'Profit multiple is missing or above the accepted maximum.'));
  if (deal.shouldRemove || deal.dismissed || deal.archived) reasons.push(reason('lifecycle_not_actionable', 'The opportunity is dismissed, archived, or not actionable.'));
  if ((deal.deduplicationMatches || []).some((match) => match?.decision === 'duplicate')) reasons.push(reason('duplicate_listing', 'The candidate is a known duplicate.'));
  return { eligible: reasons.length === 0, reasons, sourceIds };
}

export function evaluateCimAutomationCandidates({
  review = {}, scoredDeals = [], status = {}, requests = [], events = [], suppressions = [],
  recipientClaims = [], opportunityClaims = [], now = new Date(),
} = {}) {
  const policy = status.policy?.policyHash ? status.policy : getCimStage2Policy();
  const latestDecision = status.metrics?.latestHumanByDeal instanceof Map ? status.metrics.latestHumanByDeal : new Map();
  const latestOpportunityDecision = status.metrics?.latestHumanByOpportunity instanceof Map
    ? status.metrics.latestHumanByOpportunity
    : new Map();
  if (latestDecision.size === 0) {
    for (const decision of (status.metrics?.latestReviews || []).filter((item) => item.metadata?.source === 'approval-queue')) {
      if (!latestDecision.has(decision.deal_key)) latestDecision.set(decision.deal_key, decision);
    }
  }
  const sourceReview = assessCimStage2SourceReview(review, policy, now);
  const nameCounts = scoredDeals.reduce((counts, deal) => {
    const name = normalizeText(deal.name, 300).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    counts.set(name, (counts.get(name) || 0) + 1);
    return counts;
  }, new Map());
  const suppressionSet = new Set(suppressions.map((item) => normalizeEmail(item.normalized_email || item.email)).filter(Boolean));
  const recipientClaimSet = new Set(recipientClaims.map((item) => normalizeEmail(item.recipient_email)).filter(Boolean));
  const opportunityClaimSet = new Set(opportunityClaims.map((item) => normalizeText(item.opportunity_id, 160)).filter(Boolean));
  const exceptions = [];
  const eligible = [];
  const nowMs = now.getTime();

  for (const deal of scoredDeals.filter((item) => item.cimRequest?.canRequest || item.cimRequest?.eligible)) {
    const email = normalizeEmail(deal.brokerEmail);
    const opportunityId = normalizeText(deal.opportunityId, 160);
    const staticAssessment = assessCimStage2StaticCandidate(deal, { policy, review });
    const reasons = [...staticAssessment.reasons];
    for (const code of sourceReview.blockerCodes) reasons.push(reason(code, 'The current source review is incomplete, stale, widened, or warning-bearing.'));
    const normalizedName = normalizeText(deal.name, 300).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if ((nameCounts.get(normalizedName) || 0) > 1) reasons.push(reason('same_name_ambiguity', 'More than one candidate has the same normalized name.'));
    const opportunityRequests = requests.filter((request) => request.opportunity_id === opportunityId
      || request.deal_key === deal.dealKey || (deal.dealKeyAliases || []).includes(request.deal_key));
    const brokerRequests = requests.filter((request) => normalizeEmail(request.recipient_email) === email);
    const touches = logicalCimTouchesForRecipient(brokerRequests, email);
    const touches24Hours = touches.filter((touch) => safeDateMs(touch.occurredAt) >= nowMs - 24 * 60 * 60 * 1000).length;
    const touches30Days = touches.filter((touch) => safeDateMs(touch.occurredAt) >= nowMs - 30 * 24 * 60 * 60 * 1000).length;
    const messageIds = new Set(brokerRequests.flatMap((request) => [...providerIds(request)]));
    const adverse = events.some((event) => messageIds.has(event.message_id) && suppressionTypes.has(event.event_type));
    const replied = opportunityRequests.some((request) => request.responded_at || request.request_state === 'responded' || request.status === 'responded');
    if (opportunityRequests.length > 0) reasons.push(reason('opportunity_prior_sequence', 'The canonical opportunity already has a CIM sequence.'));
    if (brokerRequests.length > 0) reasons.push(reason('recipient_prior_outreach', 'The recipient has prior CIM outreach; automatic initials are first-contact only.'));
    if (touches24Hours >= policy.caps.recipient24Hours) reasons.push(reason('recipient_24_hour_cap', 'The rolling 24-hour logical-touch cap is reached.'));
    if (touches30Days >= policy.caps.recipient30Days) reasons.push(reason('recipient_30_day_cap', 'The rolling 30-day logical-touch cap is reached.'));
    if (recipientClaimSet.has(email)) reasons.push(reason('recipient_claim_pending', 'Another recipient transmission claim is pending.'));
    if (opportunityClaimSet.has(opportunityId)) reasons.push(reason('opportunity_claim_pending', 'Another canonical opportunity claim is pending.'));
    if (suppressionSet.has(email) || adverse) reasons.push(reason('recipient_suppressed', 'The recipient has a suppression or adverse delivery state.'));
    if (replied) reasons.push(reason('reply_state_ambiguous', 'The opportunity has a reply and requires human review.'));
    if ((latestOpportunityDecision.get(opportunityId) || latestDecision.get(deal.dealKey))?.decision === 'rejected') {
      reasons.push(reason('manual_pass_recorded', 'The latest human decision passed on this opportunity.'));
    }
    if (reasons.length === 0) eligible.push(deal);
    else exceptions.push({
      dealKey: deal.dealKey, opportunityId, name: deal.name, recipientEmail: email,
      recipientHash: hashCimStage2Recipient(email), score: deal.score,
      reasonCodes: [...new Set(reasons.map((item) => item.code))],
      reasons: [...new Map(reasons.map((item) => [item.code, item.message])).values()],
    });
  }
  eligible.sort((left, right) => Number(right.score || 0) - Number(left.score || 0)
    || normalizeText(left.opportunityId, 160).localeCompare(normalizeText(right.opportunityId, 160))
    || normalizeText(left.dealKey, 1000).localeCompare(normalizeText(right.dealKey, 1000)));
  return { eligible, exceptions, sourceHealthy: sourceReview.healthy, sourceReview };
}

export function buildCimStage2DecisionRecord({ run, deal, evaluation, activationId = '', policy, createdAt = new Date().toISOString() }) {
  const blocked = evaluation?.reasonCodes?.length > 0;
  return {
    id: randomUUID(), run_id: run.id, created_at: createdAt, updated_at: createdAt,
    opportunity_id: normalizeText(deal.opportunityId, 160), deal_key: normalizeText(deal.dealKey, 1000),
    decision_state: blocked ? 'blocked' : 'eligible', policy_hash: policy.policyHash,
    rule_version: policy.rules.version, source_policy_hash: policy.sourcePolicyHash,
    activation_id: activationId || null, snapshot_digest: cimStage2SnapshotDigest(deal),
    recipient_hash: hashCimStage2Recipient(deal.brokerEmail), source_snapshot_digest: sourceSnapshotDigestForDeal(deal),
    reasons: evaluation?.reasonCodes || [],
    metadata: {
      score: Number(deal.score || 0), sourceIds: sourceIdsForDeal(deal),
      decisionReasonCount: evaluation?.reasonCodes?.length || 0,
    },
  };
}

export async function authorizeCimStage2SendBoundary({
  decisionId = '', runId = '', activationId = '', claimToken = '', deal = {}, snapshotDigest = '',
  storage = getStorage(), config = getConfig(), now = new Date(), statusCheck = getCimAutomationStatus,
} = {}) {
  if (!decisionId || !runId || !activationId || !claimToken) return { ok: false, code: 'stage2_authorization_missing', error: 'A durable Stage 2 decision authorization is required.' };
  const [decision, run, activation, status] = await Promise.all([
    storage.getCimStage2Decision?.(decisionId),
    storage.getCimStage2Run?.({ id: runId }),
    storage.getCurrentCimStage2Activation?.(),
    statusCheck({ storage, config, now }),
  ]);
  const policy = getCimStage2Policy(config);
  const expectedSnapshot = cimStage2SnapshotDigest(deal);
  // Capacity includes the current claimed/attempting decision. The last valid
  // reservation may therefore make remaining capacity zero; allow only that
  // reservation when every non-cap readiness gate still passes.
  const reservedCapacityAuthorized = status.configuredStage >= 2
    && status.evidenceStage >= 2
    && ['canary', 'active'].includes(status.activationMode)
    && status.blockerCodes?.every((code) => code === 'daily_capacity')
    && Number(status.capacity?.used) > 0
    && Number(status.capacity?.used) <= Number(status.capacity?.limit);
  const checks = [
    ['decision_missing', decision],
    ['run_missing', run],
    ['activation_missing', activation],
    ['automatic_transmission_blocked', status.automaticTransmissionAllowed || reservedCapacityAuthorized],
    ['wrong_run', decision?.run_id === runId],
    ['wrong_activation', decision?.activation_id === activationId && activation?.id === activationId],
    ['wrong_mode', ['canary', 'active'].includes(run?.mode) && run?.mode === activation?.mode],
    ['wrong_policy', decision?.policy_hash === policy.policyHash && run?.policy_hash === policy.policyHash && activation?.policy_hash === policy.policyHash],
    ['wrong_opportunity', decision?.opportunity_id === normalizeText(deal.opportunityId, 160)],
    ['wrong_recipient', decision?.recipient_hash === hashCimStage2Recipient(deal.brokerEmail)],
    ['wrong_snapshot', decision?.snapshot_digest === expectedSnapshot && snapshotDigest === expectedSnapshot],
    ['wrong_source_snapshot', decision?.source_snapshot_digest === sourceSnapshotDigestForDeal(deal)],
    ['wrong_claim', decision?.claim_token === claimToken && ['claimed', 'attempting'].includes(decision?.decision_state)],
    ['decision_consumed', !decision?.consumed_at],
    ['window_closed', evaluateCimStage2Window(now, policy).open],
    ['source_provenance_changed', assessCimStage2StaticCandidate(deal, { policy }).reasons.every((item) => item.code !== 'source_provenance_not_allowed')],
  ];
  const failed = checks.find(([, passed]) => !passed);
  return failed
    ? { ok: false, code: failed[0], error: `Stage 2 final authorization failed (${failed[0]}). No broker email was transmitted.` }
    : { ok: true, decision, run, activation, status, policy };
}

export async function reconcileCimStage2AmbiguousDecisions({ storage = getStorage(), now = new Date() } = {}) {
  if (!storage.listCimStage2Decisions || !storage.getCrmCommunication || !storage.transitionCimStage2Decision) {
    return { reviewed: 0, reconciled: 0, accepted: 0, failed: 0 };
  }
  const decisions = await storage.listCimStage2Decisions({ state: 'ambiguous', limit: 100 });
  const summary = { reviewed: decisions.length, reconciled: 0, accepted: 0, failed: 0 };
  for (const decision of decisions) {
    if (!decision.communication_id) continue;
    const communication = await Promise.resolve(storage.getCrmCommunication(decision.communication_id)).catch(() => null);
    const state = normalizeText(communication?.delivery_state, 80).toLowerCase().replaceAll('_', '-');
    const accepted = ['accepted', 'delivered', 'delayed', 'replied', 'development-only'].includes(state);
    const failed = ['bounced', 'complained', 'failed', 'suppressed'].includes(state);
    if (!accepted && !failed) continue;
    const result = await storage.transitionCimStage2Decision({
      id: decision.id,
      expectedStates: ['ambiguous'],
      state: accepted ? 'accepted' : 'failed',
      updates: {
        consumed_at: now.toISOString(),
        provider_state: state,
        last_error: accepted ? null : `Reconciled provider delivery state: ${state}.`,
      },
    });
    if (!result?.applied) continue;
    summary.reconciled += 1;
    if (accepted) summary.accepted += 1;
    else summary.failed += 1;
  }
  return summary;
}
