import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';

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

export function buildEmailReadiness({ config = getConfig(), events = [] } = {}) {
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
  const followUpsEnabled = Boolean(config.dealHunter?.cimFollowUp?.enabled);
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
    followUpsEnabled,
    followUpsSafe,
    testRecipient: allowedTestRecipients[0] || '',
    allowedTestRecipients,
    latestWebhookEvent: publicEvent(latestWebhookEvent),
    latestDeliveryEvent: publicEvent(latestDeliveryEvent),
    latestReplyEvent: publicEvent(latestReplyEvent),
    latestVerifiedReplyEvent: publicEvent(latestVerifiedReplyEvent),
    latestTestEvent: publicEvent(latestTestEvent),
    issues,
  };
}

export async function getEmailReadiness({ storage = getStorage(), config = getConfig() } = {}) {
  let events = [];

  if (storage?.listEmailEvents) {
    try {
      events = await storage.listEmailEvents({ limit: 500 });
    } catch {
      events = [];
    }
  }

  return buildEmailReadiness({ config, events: Array.isArray(events) ? events : [] });
}
