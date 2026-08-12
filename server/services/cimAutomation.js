import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { logicalCimTouchesForRecipient } from './cimOpportunityIdentity.js';

const passReasons = new Set([
  'industry', 'geography', 'valuation', 'profit', 'owner-dependence', 'duplicate',
  'recipient', 'financing', 'quality', 'timing', 'other',
]);
const genericMailboxNames = new Set([
  'admin', 'broker', 'contact', 'deals', 'enquiries', 'hello', 'info', 'inquiries',
  'listings', 'mail', 'office', 'sales', 'support', 'team',
]);
const suppressionTypes = new Set(['bounced', 'complained', 'failed', 'unsubscribed']);
const preferredTerms = [
  'hvac', 'plumbing', 'electrical', 'landscape', 'maintenance', 'repair', 'restoration',
  'field service', 'commercial service', 'environmental', 'waste', 'pet', 'veterinary',
  'healthcare service', 'professional service', 'property management',
];

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
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

export async function getCimAutomationMetrics({ storage = getStorage() } = {}) {
  const [reviews, requests, events] = await Promise.all([
    storage.listDealHunterCimReviews?.({ limit: 100000 }) || [],
    storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
    storage.listEmailEvents?.({ limit: 100000 }) || [],
  ]);
  const latestHumanByDeal = new Map();
  for (const review of reviews.filter((item) => item.metadata?.source === 'approval-queue' && item.deal_key)) {
    if (!latestHumanByDeal.has(review.deal_key)) latestHumanByDeal.set(review.deal_key, review);
  }
  const humanReviews = [...latestHumanByDeal.values()];
  const automatedReviews = reviews.filter((review) => review.metadata?.source === 'automation');
  const approved = humanReviews.filter((review) => review.decision === 'approved');
  const rejected = humanReviews.filter((review) => review.decision === 'rejected');
  const edited = approved.filter((review) => review.recipient_edited);
  const requestIds = new Set(requests.flatMap((request) => [...providerIds(request)]));
  const cimEvents = events.filter((event) => requestIds.has(event.message_id) || String(event.subject || '').toLowerCase().includes('cim / nda request'));
  const requestsWithEvent = (type) => requests.filter((request) => {
    const ids = providerIds(request);
    return cimEvents.some((event) => event.event_type === type && ids.has(event.message_id));
  }).length;
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
  const replied = requests.filter((request) => request.responded_at || request.status === 'responded').length;

  const metrics = {
    reviewed: humanReviews.length,
    automatedReviews: automatedReviews.length,
    approved: approved.length,
    rejected: rejected.length,
    approvalRate: roundRate(approved.length, humanReviews.length),
    rejectionRate: roundRate(rejected.length, humanReviews.length),
    passReasons: passReasonCounts,
    recipientEdits: edited.length,
    recipientEditRate: roundRate(edited.length, approved.length),
    sent: requests.length,
    delivered: requestsWithEvent('delivered'),
    bounced: requestsWithEvent('bounced'),
    complained: requestsWithEvent('complained'),
    failed: requestsWithEvent('failed'),
    deliveryRate: roundRate(requestsWithEvent('delivered'), requests.length),
    bounceRate: roundRate(requestsWithEvent('bounced'), requests.length),
    replies: replied,
    replyRate: roundRate(replied, requests.length),
    positiveResponses,
    positiveResponseRate: roundRate(positiveResponses, requests.length),
    responseOutcomes,
    duplicateListingRate: roundRate(rejected.filter((review) => review.pass_reason === 'duplicate').length, humanReviews.length),
    incorrectRecipientRate: roundRate(rejected.filter((review) => review.pass_reason === 'recipient').length + edited.length, humanReviews.length),
    latestReviews: reviews.slice(0, 100),
  };
  Object.defineProperty(metrics, 'latestHumanByDeal', { value: latestHumanByDeal, enumerable: false });
  return metrics;
}

export async function recordCimReviewDecisions({ decisions = [], actor = '', stage = 1, source = 'approval-queue', storage = getStorage() } = {}) {
  const createdAt = new Date().toISOString();
  const safe = (Array.isArray(decisions) ? decisions : []).slice(0, 100).map((decision) => {
    const result = decision?.decision === 'approved' ? 'approved' : 'rejected';
    const originalRecipient = normalizeEmail(decision?.originalRecipientEmail);
    const finalRecipient = normalizeEmail(decision?.finalRecipientEmail || originalRecipient);
    const reason = result === 'rejected' && passReasons.has(decision?.passReason) ? decision.passReason : result === 'rejected' ? 'other' : '';
    return {
      id: randomUUID(), created_at: createdAt, deal_key: String(decision?.dealKey || '').slice(0, 1000),
      decision: result, pass_reason: reason, original_recipient_email: originalRecipient,
      final_recipient_email: finalRecipient, recipient_edited: originalRecipient !== finalRecipient,
      score: Number.isFinite(Number(decision?.score)) ? Number(decision.score) : null,
      actor: String(actor || 'admin').slice(0, 160), automation_stage: Math.max(1, Math.min(Number(stage) || 1, 3)),
      metadata: {
        dealName: String(decision?.dealName || '').slice(0, 220),
        recipientName: String(decision?.finalRecipientName || '').slice(0, 160),
        source,
      },
    };
  }).filter((decision) => decision.deal_key);
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
  const review = {
    id: randomUUID(), created_at: new Date().toISOString(), deal_key: String(dealKey).slice(0, 1000),
    decision: 'outcome', pass_reason: '', original_recipient_email: '', final_recipient_email: '',
    recipient_edited: false, score: null, actor: String(actor || 'admin').slice(0, 160), automation_stage: 1,
    metadata: { source: 'response-outcome', outcome },
  };
  await storage.insertDealHunterCimReviews([review]);
  return review;
}

export async function getCimAutomationStatus({ storage = getStorage(), config = getConfig() } = {}) {
  const [metrics, persisted] = await Promise.all([
    getCimAutomationMetrics({ storage }),
    storage.getDealHunterAutomationSettings?.() || null,
  ]);
  const policy = config.dealHunter.cimAutomation;
  const paused = Boolean(policy.paused || persisted?.paused);
  const stage2Ready = metrics.reviewed >= policy.stage2MinimumReviews;
  const stage3Ready = metrics.reviewed >= policy.stage3MinimumReviews && metrics.approvalRate >= policy.stage3MinimumApprovalRate * 100;
  const effectiveStage = policy.stage === 3
    ? stage3Ready ? 3 : stage2Ready ? 2 : 1
    : policy.stage === 2 && !stage2Ready ? 1 : policy.stage;
  return {
    configuredStage: policy.stage,
    effectiveStage,
    paused,
    pauseSource: persisted?.paused ? 'emergency-control' : policy.paused ? 'configuration' : '',
    stage2Ready,
    stage3Ready,
    policy,
    recipientPolicy: config.dealHunter.cimOutreach,
    metrics,
  };
}

export async function isCimAutomationPaused({ storage = getStorage(), config = getConfig() } = {}) {
  const persisted = await storage.getDealHunterAutomationSettings?.() || null;
  return Boolean(config.dealHunter.cimAutomation.paused || persisted?.paused);
}

export async function setCimAutomationPaused({ paused, actor = '', storage = getStorage() } = {}) {
  if (!storage.upsertDealHunterAutomationSettings) throw new Error('CIM automation settings storage is not configured.');
  return storage.upsertDealHunterAutomationSettings({
    updated_at: new Date().toISOString(), paused: Boolean(paused), updated_by: actor,
    metadata: { reason: paused ? 'Emergency pause enabled from Operations.' : 'Emergency pause cleared from Operations.' },
  });
}

export function evaluateCimAutomationCandidates({ review = {}, scoredDeals = [], status = {}, requests = [], events = [] } = {}) {
  const policy = status.policy || {};
  const latestDecision = status.metrics?.latestHumanByDeal instanceof Map
    ? status.metrics.latestHumanByDeal
    : new Map();
  if (latestDecision.size === 0) {
    for (const decision of (status.metrics?.latestReviews || []).filter((item) => item.metadata?.source === 'approval-queue')) {
      if (!latestDecision.has(decision.deal_key)) latestDecision.set(decision.deal_key, decision);
    }
  }
  const sources = review.sources || [];
  const sourceHealthy = sources.length > 0 && sources.every((source) => source.fetched && !source.error);
  const nameCounts = scoredDeals.reduce((counts, deal) => {
    const name = String(deal.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    counts.set(name, (counts.get(name) || 0) + 1);
    return counts;
  }, new Map());
  const exceptions = [];
  const eligible = [];
  const trustedRulesStage = status.effectiveStage === 2;

  for (const deal of scoredDeals.filter((item) => item.cimRequest?.canRequest)) {
    const email = normalizeEmail(deal.brokerEmail);
    const mailbox = email.split('@')[0];
    const text = `${deal.name || ''} ${deal.industry || ''}`.toLowerCase();
    const location = String(deal.location || '').toUpperCase();
    const normalizedName = String(deal.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const brokerRequests = requests.filter((request) => normalizeEmail(request.recipient_email) === email);
    const brokerTouches = logicalCimTouchesForRecipient(brokerRequests, email);
    const touches30Days = brokerTouches.filter((touch) => Date.now() - Date.parse(touch.occurredAt || '') < 30 * 86400000).length;
    const recipientCap30Days = Number(status.recipientPolicy?.recipientCap30Days || policy.maximumBrokerContacts30Days || 3);
    const brokerMessageIds = new Set(brokerRequests.flatMap((request) => [...providerIds(request)]));
    const suppressed = events.some((event) => brokerMessageIds.has(event.message_id) && suppressionTypes.has(event.event_type));
    const reasons = [];
    const minimumProfit = Number(review.profile?.minAnnualProfit || 300000);
    const maximumProfit = Number(review.profile?.maxAnnualProfit || 750000);
    if (!sourceHealthy) reasons.push('Source health warning');
    if (trustedRulesStage && deal.score < Number(policy.minimumScore || 90)) reasons.push(`Score below ${policy.minimumScore || 90}`);
    if (trustedRulesStage && !(deal.annualProfit >= minimumProfit && deal.annualProfit <= maximumProfit)) reasons.push('Profit outside target range');
    if (trustedRulesStage && (!deal.profitMultiple || deal.profitMultiple > Number(policy.maximumProfitMultiple || 4))) reasons.push('Multiple unavailable or outside financing range');
    if (trustedRulesStage && !preferredTerms.some((term) => text.includes(term))) reasons.push('Industry requires review');
    if (trustedRulesStage && !(review.profile?.targetStates || []).some((state) => location.includes(String(state).toUpperCase()))) reasons.push('Geography requires review');
    if (genericMailboxNames.has(mailbox)) reasons.push('Generic broker mailbox');
    if (!deal.listingUrl) reasons.push('Original listing URL missing');
    if ((nameCounts.get(normalizedName) || 0) > 1) reasons.push('Possible duplicate listing');
    if (latestDecision.get(deal.dealKey)?.decision === 'rejected') reasons.push('Manual pass recorded');
    if (brokerRequests.some((request) => request.deal_key === deal.dealKey)) reasons.push('Opportunity previously contacted');
    if (trustedRulesStage && brokerRequests.length > 0) reasons.push('Broker or recipient has prior outreach');
    if (touches30Days >= recipientCap30Days) reasons.push('Broker recipient logical-touch cap reached');
    if (suppressed) reasons.push('Broker address suppressed');

    if (reasons.length === 0) eligible.push(deal);
    else exceptions.push({ dealKey: deal.dealKey, name: deal.name, recipientEmail: email, score: deal.score, reasons });
  }

  return { eligible, exceptions, sourceHealthy };
}
