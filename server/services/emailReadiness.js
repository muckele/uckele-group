import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import {
  FOLLOW_UP_AI_FALLBACK_REASONS,
  FOLLOW_UP_AI_RESPONSE_STATES,
  buildFollowUpAiReadiness,
} from './followUpAiPolicy.js';

const deliveryEventTypes = new Set(['delivered', 'delayed', 'bounced', 'complained', 'failed']);
const replyEventTypes = new Set(['replied', 'received']);

function normalizeText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  const normalized = normalizeText(value, 300);
  const angleAddress = normalized.match(/<([^<>@\s]+@[^<>\s]+)>/);
  const plainAddress = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return String(angleAddress?.[1] || plainAddress?.[0] || '').toLowerCase();
}

function normalizeDomain(value) {
  return normalizeText(value, 253)
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\.+$/, '');
}

function normalizedEventType(event) {
  return normalizeText(event?.event_type || event?.eventType, 80)
    .toLowerCase()
    .replace(/^email[._-]/, '')
    .replace(/[._-]/g, '_');
}

function newestEvent(events, predicate) {
  return events
    .filter(predicate)
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))[0] || null;
}

function publicEvent(event) {
  if (!event) return null;
  return {
    createdAt: event.created_at || '',
    eventType: normalizedEventType(event),
    subject: normalizeText(event.subject, 300),
    source: normalizeText(event.source, 100),
  };
}

function eventHasAdminTestMarker(event) {
  const subject = normalizeText(event?.subject, 300).toLowerCase();
  const source = normalizeText(event?.source, 100).toLowerCase();
  const tags = event?.metadata?.tags;
  const taggedSource = Array.isArray(tags)
    ? tags.find((tag) => normalizeText(tag?.name || tag?.key, 80) === 'source')?.value
    : tags?.source;
  return source === 'admin-email-test'
    || normalizeText(taggedSource, 100).toLowerCase() === 'admin-email-test'
    || subject.includes('[test] uckele group email delivery verification');
}

export function hasVerifiedFollowUpReply(events = []) {
  return events.some((event) => normalizeText(event?.source, 100).toLowerCase() === 'webhook'
    && replyEventTypes.has(normalizedEventType(event))
    && eventHasAdminTestMarker(event));
}

function count(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((count(numerator) / denominator) * 1_000) / 10 : 0;
}

function nullableNumber(value) {
  return (typeof value === 'number' || typeof value === 'string')
    && String(value).trim() !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}

function countMap(value, allowedValues) {
  const allowed = new Set(allowedValues);
  return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    .map(([key, total]) => [normalizeText(key, 80), count(total)])
    .filter(([key]) => allowed.has(key)));
}

function publicOperationalMetrics(metrics = {}, sentLast24Hours = 0, dailyCap = 0) {
  const outbox = Object.fromEntries(Object.entries(metrics.outbox || {}).map(([key, value]) => [key, count(value)]));
  const delivery = Object.fromEntries(Object.entries(metrics.delivery || {}).map(([key, value]) => [key, count(value)]));
  const recommendations = Object.fromEntries(Object.entries(metrics.recommendations || {}).map(([key, value]) => [key, count(value)]));
  const decisions = count(recommendations.accepted) + count(recommendations.editedAndAccepted) + count(recommendations.dismissed);
  const acceptedDecisions = count(recommendations.accepted) + count(recommendations.editedAndAccepted);
  const deliveryOutcomes = count(delivery.delivered) + count(delivery.bounced) + count(delivery.complained) + count(delivery.failed);
  const aiOutcomes = count(recommendations.aiUsed) + count(recommendations.aiFallback);
  const ai = metrics.ai || {};
  return {
    windowStartedAt: metrics.windowStartedAt || '',
    outbox,
    delivery,
    recommendations,
    ai: {
      fallbackReasons: countMap(ai.fallbackReasons, FOLLOW_UP_AI_FALLBACK_REASONS),
      responseStates: countMap(ai.responseStates, FOLLOW_UP_AI_RESPONSE_STATES),
      latencyMs: {
        observed: count(ai.latencyMs?.observed),
        average: nullableNumber(ai.latencyMs?.average),
        minimum: nullableNumber(ai.latencyMs?.minimum),
        maximum: nullableNumber(ai.latencyMs?.maximum),
      },
      tokens: {
        observed: count(ai.tokens?.observed),
        inputTotal: nullableNumber(ai.tokens?.inputTotal),
        outputTotal: nullableNumber(ai.tokens?.outputTotal),
        cachedTotal: nullableNumber(ai.tokens?.cachedTotal),
        reasoningTotal: nullableNumber(ai.tokens?.reasoningTotal),
      },
    },
    suppressions: { active: count(metrics.suppressions?.active) },
    sentLast24Hours: count(sentLast24Hours),
    dailyCap: count(dailyCap),
    rates: {
      recommendationAcceptance: percent(acceptedDecisions, decisions),
      recommendationEdit: percent(recommendations.editedAndAccepted, acceptedDecisions),
      recommendationDismissal: percent(recommendations.dismissed, decisions),
      delivery: percent(delivery.delivered, deliveryOutcomes),
      bounce: percent(delivery.bounced, deliveryOutcomes),
      reply: percent(delivery.replied, Math.max(1, count(delivery.delivered))),
      aiFallback: aiOutcomes > 0 ? percent(recommendations.aiFallback, aiOutcomes) : null,
    },
  };
}

export function buildEmailReadiness({
  config = getConfig(), events = [], operationalMetrics = {}, metricsAvailable = false, sentLast24Hours = 0,
} = {}) {
  const provider = normalizeText(config.delivery?.provider, 60) || 'unknown';
  const fromAddress = normalizeText(config.delivery?.resendFromEmail, 300);
  const replyToAddress = normalizeEmail(config.delivery?.resendReplyTo);
  const replyToDomain = normalizeDomain(replyToAddress.split('@')[1]);
  const inboundDomain = normalizeDomain(config.delivery?.resendInboundDomain);
  const allowedTestRecipients = Array.from(new Set([
    normalizeEmail(config.admin?.email),
    normalizeEmail(config.delivery?.fallbackRecipient),
    normalizeEmail(config.dealHunter?.recipient),
  ].filter(Boolean)));
  const outboundConfigured = provider === 'resend'
    && Boolean(config.delivery?.resendApiKey)
    && Boolean(fromAddress)
    && allowedTestRecipients.length > 0;
  const webhookConfigured = Boolean(config.delivery?.emailWebhookSecret);
  const replyAddressMatchesInboundDomain = Boolean(
    replyToAddress && inboundDomain && replyToDomain === inboundDomain,
  );
  const deliveryTrackingConfigured = provider === 'resend' && webhookConfigured;
  const replyTrackingConfigured = deliveryTrackingConfigured && replyAddressMatchesInboundDomain;
  const webhookEvents = events.filter((event) => normalizeText(event?.source, 100).toLowerCase() === 'webhook');
  const latestWebhookEvent = newestEvent(webhookEvents, () => true);
  const latestDeliveryEvent = newestEvent(webhookEvents, (event) => deliveryEventTypes.has(normalizedEventType(event)));
  const latestReplyEvent = newestEvent(webhookEvents, (event) => replyEventTypes.has(normalizedEventType(event)));
  const latestVerifiedReplyEvent = newestEvent(
    webhookEvents,
    (event) => replyEventTypes.has(normalizedEventType(event)) && eventHasAdminTestMarker(event),
  );
  const latestTestEvent = newestEvent(events, eventHasAdminTestMarker);
  const webhookVerified = Boolean(latestWebhookEvent);
  const deliveryTrackingVerified = Boolean(latestDeliveryEvent);
  const replyTrackingVerified = Boolean(latestVerifiedReplyEvent);
  const cimFollowUpsEnabled = Boolean(config.dealHunter?.cimFollowUp?.enabled);
  const genericFollowUpsEnabled = Boolean(config.followUp?.emailEnabled);
  const followUpSenderAddress = normalizeEmail(config.followUp?.senderEmail);
  const deliverySenderAddress = normalizeEmail(config.delivery?.resendFromEmail);
  const followUpReplyToAddress = normalizeEmail(config.followUp?.replyTo);
  const followUpSenderMatchesDelivery = Boolean(followUpSenderAddress && followUpSenderAddress === deliverySenderAddress);
  const followUpReplyToMatchesDelivery = Boolean(followUpReplyToAddress && followUpReplyToAddress === replyToAddress);
  const physicalPostalAddressConfigured = Boolean(normalizeText(config.followUp?.physicalPostalAddress, 500));
  const replyOptOutConfigured = Boolean(config.followUp?.replyOptOutEnabled);
  const optOutLinkConfigured = Boolean(normalizeText(config.followUp?.optOutBaseUrl, 2_000));
  const optOutConfigured = replyOptOutConfigured || optOutLinkConfigured;
  const suppressionOperational = Boolean(
    metricsAvailable
      && Number.isFinite(Number(operationalMetrics?.suppressions?.active)),
  );
  const aiReadiness = buildFollowUpAiReadiness(config);
  const aiEnabled = aiReadiness.enabled;
  const aiModelConfigured = aiReadiness.modelConfigured;
  const aiApiKeyConfigured = aiReadiness.apiKeyConfigured;
  const aiReady = aiReadiness.ready;
  const genericFollowUpsSafe = genericFollowUpsEnabled
    && outboundConfigured
    && replyTrackingConfigured
    && replyTrackingVerified
    && followUpSenderMatchesDelivery
    && followUpReplyToMatchesDelivery
    && physicalPostalAddressConfigured
    && optOutConfigured
    && suppressionOperational;
  const followUpsEnabled = cimFollowUpsEnabled;
  const followUpsSafe = outboundConfigured && replyTrackingConfigured && replyTrackingVerified;
  const issues = [];

  if (!outboundConfigured) issues.push('Resend outbound delivery is not fully configured.');
  if (!webhookConfigured) issues.push('The signed Resend webhook secret is missing.');
  if (!replyToAddress) issues.push('The Resend reply-to address is missing.');
  if (!inboundDomain) issues.push('The Resend inbound receiving domain is missing.');
  if (replyToAddress && inboundDomain && !replyAddressMatchesInboundDomain) {
    issues.push('The reply-to address does not use the configured inbound receiving domain.');
  }
  if (replyTrackingConfigured && !replyTrackingVerified) {
    issues.push('Inbound reply tracking is configured but has not passed an end-to-end reply test yet.');
  }
  if (genericFollowUpsEnabled && !followUpSenderMatchesDelivery) {
    issues.push('The generic follow-up sender must match the configured Resend From address.');
  }
  if (genericFollowUpsEnabled && !followUpReplyToMatchesDelivery) {
    issues.push('The generic follow-up Reply-To must match the verified Resend reply address.');
  }
  if (genericFollowUpsEnabled && !physicalPostalAddressConfigured) {
    issues.push('A physical postal address is required in the follow-up footer.');
  }
  if (genericFollowUpsEnabled && !optOutConfigured) {
    issues.push('A reply-based or one-click opt-out mechanism must be configured.');
  }
  if (genericFollowUpsEnabled && !suppressionOperational) {
    issues.push('The global suppression store could not be verified. Generic follow-up sending remains blocked.');
  }
  if (aiEnabled && !aiReady) {
    issues.push('AI enrichment is enabled without every required configuration, approval, evaluation, and synthetic-smoke gate. Deterministic recommendations remain the fallback.');
  }

  const metrics = publicOperationalMetrics(
    operationalMetrics,
    sentLast24Hours,
    config.followUp?.dailyCap,
  );

  return {
    provider,
    fromAddress,
    replyToAddress,
    inboundDomain,
    webhookEndpoint: `${String(config.server?.origin || '').replace(/\/+$/, '')}/api/webhooks/resend`,
    outboundConfigured,
    webhookConfigured,
    webhookVerified,
    deliveryTrackingConfigured,
    deliveryTrackingVerified,
    replyTrackingConfigured,
    replyTrackingVerified,
    replyAddressMatchesInboundDomain,
    cimFollowUpsEnabled,
    genericFollowUpsEnabled,
    genericFollowUpsSafe,
    followUpSenderAddress,
    followUpReplyToAddress,
    followUpSenderMatchesDelivery,
    followUpReplyToMatchesDelivery,
    physicalPostalAddressConfigured,
    replyOptOutConfigured,
    optOutLinkConfigured,
    oneClickOptOutVerified: false,
    optOutConfigured,
    suppressionOperational,
    aiEnabled,
    deterministicRecommendationsAvailable: true,
    aiModel: aiReadiness.model,
    aiModelConfigured,
    aiApiKeyConfigured,
    aiReady,
    aiReadiness,
    domainAuthentication: {
      state: 'manual-verification-required',
      guidance: 'Verify the sender domain SPF/DKIM status with Resend and publish a monitored DMARC policy before enabling real sends.',
      providerUrl: 'https://resend.com/domains',
    },
    followUpsEnabled,
    followUpsSafe,
    testRecipient: allowedTestRecipients[0] || '',
    allowedTestRecipients,
    latestWebhookEvent: publicEvent(latestWebhookEvent),
    latestDeliveryEvent: publicEvent(latestDeliveryEvent),
    latestReplyEvent: publicEvent(latestReplyEvent),
    latestVerifiedReplyEvent: publicEvent(latestVerifiedReplyEvent),
    latestTestEvent: publicEvent(latestTestEvent),
    metricsAvailable,
    metrics,
    issues,
  };
}

export async function getEmailReadiness({ storage = getStorage(), config = getConfig() } = {}) {
  let events = [];
  let operationalMetrics = {};
  let metricsAvailable = false;
  let sentLast24Hours = 0;

  if (storage?.listEmailEvents) {
    try {
      events = await storage.listEmailEvents({ limit: 500 });
    } catch {
      events = [];
    }
  }

  const now = new Date();
  const metricWindowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const dailyWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  if (storage?.getCrmFollowUpOperationalMetrics) {
    try {
      operationalMetrics = await storage.getCrmFollowUpOperationalMetrics({ since: metricWindowStart });
      metricsAvailable = true;
    } catch {
      operationalMetrics = {};
      metricsAvailable = false;
    }
  }
  if (storage?.countCrmFollowUpSends) {
    try {
      sentLast24Hours = await storage.countCrmFollowUpSends({ since: dailyWindowStart });
    } catch {
      sentLast24Hours = 0;
    }
  }

  return buildEmailReadiness({
    config,
    events: Array.isArray(events) ? events : [],
    operationalMetrics,
    metricsAvailable,
    sentLast24Hours,
  });
}
