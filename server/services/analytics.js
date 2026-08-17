import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp } from '../utils/http.js';
import { hashIp } from '../utils/security.js';

export const analyticsEventNames = Object.freeze([
  'page_view',
  'contact_form_started',
  'contact_submission_succeeded',
  'criteria_downloaded',
]);

const analyticsEventSet = new Set(analyticsEventNames);
const publicPathSet = new Set([
  '/',
  '/about',
  '/criteria',
  '/why-sell-to-me',
  '/process',
  '/faq',
  '/contact',
  '/privacy',
  '/thank-you',
]);
const downloadPlacements = new Set(['homepage', 'criteria_page', 'footer']);

function cleanText(value, maxLength) {
  return String(value || '')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, maxLength);
}

function normalizeHostname(value) {
  const rawValue = cleanText(value, 300).toLowerCase();

  if (!rawValue) return '';

  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;
    const hostname = new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
    return /^[a-z0-9.-]+$/.test(hostname) ? hostname.slice(0, 200) : '';
  } catch {
    return '';
  }
}

export function normalizeAttribution(value = {}, request = null) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const headerReferrer = request?.headers?.referer || request?.headers?.referrer || '';
  const referrerValue = Object.hasOwn(input, 'referrerHost') ? input.referrerHost : headerReferrer;

  return {
    referrerHost: normalizeHostname(referrerValue),
    utmSource: cleanText(input.utmSource, 100),
    utmMedium: cleanText(input.utmMedium, 100),
    utmCampaign: cleanText(input.utmCampaign, 120),
  };
}

function normalizePath(value) {
  const path = cleanText(value, 160).split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  return publicPathSet.has(path) ? path : '';
}

export async function recordAnalyticsEvent(body, request, options = {}) {
  const config = options.config || getConfig();
  const storage = options.storage || getStorage();

  if (!config.analytics?.enabled) {
    return { ok: true, stored: false };
  }

  const eventName = cleanText(body?.eventName, 80);
  const path = normalizePath(body?.path);

  if (!analyticsEventSet.has(eventName) || !path) {
    return { ok: false, status: 400, error: 'Unsupported analytics event.' };
  }

  const placement = cleanText(body?.placement, 40);
  if (eventName === 'criteria_downloaded' && !downloadPlacements.has(placement)) {
    return { ok: false, status: 400, error: 'Unsupported download placement.' };
  }

  const now = new Date();
  const windowMs = Math.max(1_000, Number(config.analytics.rateLimitWindowMs) || 60_000);
  const bucket = `analytics:${hashIp(getClientIp(request))}`;
  const eventCount = await storage.countRateLimitEvents(bucket, new Date(now.getTime() - windowMs).toISOString());

  if (eventCount >= Math.max(1, Number(config.analytics.rateLimitMax) || 120)) {
    return { ok: false, status: 429, error: 'Analytics event limit exceeded.' };
  }

  await storage.addRateLimitEvent(bucket, now.toISOString());
  const attribution = normalizeAttribution(body?.attribution, request);
  const event = {
    id: randomUUID(),
    created_at: now.toISOString(),
    event_name: eventName,
    path,
    referrer_host: attribution.referrerHost,
    utm_source: attribution.utmSource,
    utm_medium: attribution.utmMedium,
    utm_campaign: attribution.utmCampaign,
    placement: eventName === 'criteria_downloaded' ? placement : '',
  };

  await storage.insertAnalyticsEvent(event, config.analytics.retentionDays);
  return { ok: true, stored: true, event };
}
