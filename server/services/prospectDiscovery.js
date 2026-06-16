import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { createManualSubmission } from './submissions.js';

const googlePlacesTextSearchUrl = 'https://places.googleapis.com/v1/places:searchText';
const googlePlacesFieldMask = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.types',
].join(',');

const actionableLeadTiers = new Set(['tier_a', 'tier_b', 'tier_c']);
const websiteFetchMaxRedirects = 5;
const hostedPresenceDomains = [
  'facebook.com',
  'instagram.com',
  'yelp.com',
  'yellowpages.com',
  'angi.com',
  'homeadvisor.com',
  'thumbtack.com',
  'nextdoor.com',
  'linktr.ee',
  'business.site',
  'sites.google.com',
  'square.site',
  'wixsite.com',
];

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeHostname(hostname = '') {
  return String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isPrivateIpAddress(hostname = '') {
  const normalized = normalizeHostname(hostname);

  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpAddress(normalized.slice(7));
  }

  const version = isIP(normalized);

  if (version === 4) {
    const octets = normalized.split('.').map((part) => Number(part));
    const [first, second] = octets;

    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (version === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  return false;
}

function isBlockedHostname(hostname = '') {
  const normalized = normalizeHostname(hostname);

  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    isPrivateIpAddress(normalized)
  );
}

function normalizeUrl(value = '') {
  const rawValue = normalizeText(value, 1000);

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || isBlockedHostname(url.hostname)) {
      return '';
    }

    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function assertPublicWebsiteUrl(value = '') {
  const normalized = normalizeUrl(value);

  if (!normalized) {
    throw new Error('Website URL is not a public HTTP(S) URL.');
  }

  const url = new URL(normalized);

  if (isBlockedHostname(url.hostname)) {
    throw new Error('Website URL points to a local or private network host.');
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });

  if (addresses.some((address) => isPrivateIpAddress(address.address))) {
    throw new Error('Website URL resolves to a local or private network address.');
  }

  return url.toString();
}

function getHostname(value = '') {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function isHostedPresenceUrl(value = '') {
  const hostname = getHostname(value);

  if (!hostname) {
    return false;
  }

  return hostedPresenceDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function placeText(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return normalizeText(value, 300);
  }

  return normalizeText(value.text || value.name || '', 300);
}

function mapGooglePlace(place = {}, query = '') {
  const name = placeText(place.displayName);
  const category = placeText(place.primaryTypeDisplayName) || normalizeText(place.primaryType || place.types?.[0] || '', 160);
  const websiteUrl = normalizeUrl(place.websiteUri || '');

  return {
    provider: 'google-places',
    source_id: normalizeText(place.id || place.name || '', 250),
    business_name: name || 'Unknown business',
    website_url: websiteUrl,
    phone: normalizeText(place.nationalPhoneNumber || place.internationalPhoneNumber || '', 80),
    address: normalizeText(place.formattedAddress || place.shortFormattedAddress || '', 500),
    category,
    rating: place.rating === undefined || place.rating === null ? null : toNumber(place.rating, null),
    review_count: Math.max(0, Math.round(toNumber(place.userRatingCount, 0))),
    search_query: query,
    source_data: {
      googleMapsUri: normalizeUrl(place.googleMapsUri || ''),
      businessStatus: normalizeText(place.businessStatus || '', 80),
      primaryType: normalizeText(place.primaryType || '', 120),
      types: Array.isArray(place.types) ? place.types.slice(0, 12) : [],
    },
  };
}

function extractHtmlTag(html, tagName) {
  const match = String(html || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return normalizeText(match?.[1]?.replace(/<[^>]*>/g, ' ') || '', 300);
}

function extractMetaDescription(html) {
  const match = String(html || '').match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/i)
    || String(html || '').match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  return normalizeText(match?.[1] || '', 500);
}

function htmlIncludesAny(html, patterns) {
  const haystack = String(html || '').toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

async function readLimitedResponseText(response, maxBytes) {
  const safeMaxBytes = Math.max(1024, Number(maxBytes) || 750000);
  const contentLength = Number(response.headers.get('content-length') || 0);

  if (!response.body?.getReader) {
    if (contentLength > safeMaxBytes) {
      return { text: '', byteLength: contentLength, truncated: true };
    }

    const text = await response.text();
    const byteLength = Buffer.byteLength(text, 'utf8');
    return {
      text: byteLength > safeMaxBytes ? text.slice(0, safeMaxBytes) : text,
      byteLength,
      truncated: byteLength > safeMaxBytes,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let byteLength = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const remainingBytes = safeMaxBytes - byteLength;

    if (value.byteLength > remainingBytes) {
      if (remainingBytes > 0) {
        chunks.push(decoder.decode(value.slice(0, remainingBytes), { stream: true }));
      }

      byteLength += value.byteLength;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }

    byteLength += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return {
    text: chunks.join(''),
    byteLength,
    truncated: truncated || contentLength > safeMaxBytes,
  };
}

async function fetchWebsiteHtml(url, timeoutMs, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    let currentUrl = await assertPublicWebsiteUrl(url);
    let response = null;

    for (let redirectCount = 0; redirectCount <= websiteFetchMaxRedirects; redirectCount += 1) {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ProspectDiscoveryBot/1.0; +https://www.uckelegroup.com)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      const location = response.headers.get('location');

      if (!location) {
        break;
      }

      if (redirectCount === websiteFetchMaxRedirects) {
        throw new Error('Website redirected too many times.');
      }

      currentUrl = await assertPublicWebsiteUrl(new URL(location, currentUrl).toString());
    }

    const elapsedMs = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const htmlResult = contentType.includes('text/html') || contentType.includes('application/xhtml')
      ? await readLimitedResponseText(response, maxBytes)
      : { text: '', byteLength: contentLength, truncated: false };

    return {
      ok: true,
      response: {
        ok: response.ok,
        status: response.status,
        url: currentUrl,
      },
      elapsedMs,
      contentType,
      contentLength: contentLength || htmlResult.byteLength,
      html: htmlResult.text,
      truncated: htmlResult.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectWebsitePresence(candidate, config) {
  const audit = {
    checked: false,
    url: candidate.website_url || '',
    finalUrl: candidate.website_url || '',
    status: null,
    elapsedMs: null,
    pageBytes: null,
    title: '',
    metaDescription: '',
    hasContactForm: false,
    hasCallToAction: false,
    hostedPresenceOnly: false,
    reachable: null,
    issues: [],
    signals: [],
  };

  if (!candidate.website_url) {
    audit.issues.push('No website is listed on the business profile');
    return audit;
  }

  audit.hostedPresenceOnly = isHostedPresenceUrl(candidate.website_url);

  if (audit.hostedPresenceOnly) {
    audit.issues.push('Website field points to a social/listing profile instead of a dedicated business website');
    audit.signals.push('Hosted or rented web presence');
    return audit;
  }

  if (!config.prospectDiscovery.websiteCheckEnabled) {
    audit.signals.push('Website check disabled by configuration');
    return audit;
  }

  audit.checked = true;

  try {
    const result = await fetchWebsiteHtml(
      candidate.website_url,
      config.prospectDiscovery.websiteCheckTimeoutMs,
      config.prospectDiscovery.websiteCheckMaxBytes,
    );
    const { response, html } = result;

    audit.finalUrl = response.url || candidate.website_url;
    audit.status = response.status;
    audit.elapsedMs = result.elapsedMs;
    audit.pageBytes = result.contentLength;
    audit.reachable = response.ok;
    audit.title = extractHtmlTag(html, 'title');
    audit.metaDescription = extractMetaDescription(html);
    audit.hasContactForm = /<form\b/i.test(html) && /type=["']email["']|name=["'](?:email|phone|name|contact|message)["']|contact|quote|estimate/i.test(html);

    if (result.truncated) {
      audit.issues.push('Website response exceeded the inspection size limit; only the first portion was reviewed');
    }
    audit.hasCallToAction = htmlIncludesAny(html, [
      'request a quote',
      'request quote',
      'get a quote',
      'free estimate',
      'schedule',
      'book now',
      'call now',
      'contact us',
      'make an appointment',
      'appointment',
    ]);

    if (!response.ok) {
      audit.issues.push(`Website returned HTTP ${response.status}`);
    }

    if (!audit.finalUrl.startsWith('https://')) {
      audit.issues.push('Website is not using HTTPS');
    }

    if (audit.elapsedMs > 3000) {
      audit.issues.push('Website took more than 3 seconds to respond');
    }

    if (audit.pageBytes > 1500000) {
      audit.issues.push('Website page appears unusually large');
    }

    if (!audit.title || audit.title.length < 12) {
      audit.issues.push('Page title is missing or too thin');
    }

    if (!audit.metaDescription || audit.metaDescription.length < 50) {
      audit.issues.push('Meta description is missing or too thin');
    }

    if (!audit.hasContactForm) {
      audit.issues.push('No obvious contact form found on the homepage');
    }

    if (!audit.hasCallToAction) {
      audit.issues.push('No obvious call to action found on the homepage');
    }
  } catch (error) {
    audit.reachable = false;
    audit.issues.push(error.name === 'AbortError' ? 'Website check timed out' : `Website could not be reached: ${error.message}`);
  }

  return audit;
}

function leadTierLabel(leadTier) {
  if (leadTier === 'tier_a') {
    return 'Tier A';
  }

  if (leadTier === 'tier_b') {
    return 'Tier B';
  }

  if (leadTier === 'tier_c') {
    return 'Tier C';
  }

  return 'DNP';
}

function buildTierRecommendation(leadTier) {
  if (leadTier === 'tier_a') {
    return 'Pitch a starter website, Google Business Profile cleanup, and a simple request-a-quote/contact flow.';
  }

  if (leadTier === 'tier_b') {
    return 'Pitch a website conversion audit focused on mobile usability, contact flow, speed, trust signals, and calls to action.';
  }

  if (leadTier === 'tier_c') {
    return 'Pitch ongoing online presence management: SEO basics, review strategy, website updates, tracking, and follow-up automation.';
  }

  return 'Do not prioritize for outreach until the business has stronger operating signals or a clearer online presence gap.';
}

function buildOutreachAngle(candidate, leadTier, websiteAudit = {}) {
  const businessName = candidate.business_name || 'the business';

  if (leadTier === 'tier_a') {
    if (!candidate.website_url) {
      return `${businessName} appears established on Google but does not have a website listed, so the pitch should focus on capturing more quote requests from search traffic.`;
    }

    if (websiteAudit.hostedPresenceOnly) {
      return `${businessName} appears to rely on a third-party profile instead of a dedicated website, so the pitch should focus on owning their local presence and contact flow.`;
    }

    return `${businessName} has a major website access issue, so the pitch should focus on fixing lost leads from customers who cannot easily reach them online.`;
  }

  if (leadTier === 'tier_b') {
    const issue = websiteAudit.issues?.[0] ? ` One visible issue: ${websiteAudit.issues[0].toLowerCase()}.` : '';
    return `${businessName} has a website, but it shows conversion gaps that can reduce calls and quote requests.${issue}`;
  }

  if (leadTier === 'tier_c') {
    return `${businessName} has enough online presence to be worth an optimization conversation around SEO basics, reviews, tracking, and ongoing website updates.`;
  }

  return `${businessName} should not be prioritized until there is stronger evidence of fit or a clearer online presence gap.`;
}

function scoreDiscoveredProspect(candidate, config, websiteAudit = {}) {
  const reasons = [];
  const businessStatus = normalizeText(candidate.source_data?.businessStatus || '', 80);
  const closedBusiness = /^closed/i.test(businessStatus);
  let businessQualityScore = closedBusiness ? 0 : 20;
  let presenceGapScore = 0;

  if (closedBusiness) {
    reasons.push(`Business status is ${businessStatus}`);
  } else if (businessStatus) {
    reasons.push(`Business status is ${businessStatus}`);
  }

  if (candidate.phone) {
    businessQualityScore += 20;
    reasons.push('Phone number available');
  } else {
    reasons.push('No phone number found');
  }

  if (candidate.address) {
    businessQualityScore += 15;
    reasons.push('Local address available');
  }

  if (candidate.review_count >= 50) {
    businessQualityScore += 30;
    reasons.push('Strong review volume');
  } else if (candidate.review_count >= 15) {
    businessQualityScore += 25;
    reasons.push('Meaningful review volume');
  } else if (candidate.review_count >= 5) {
    businessQualityScore += 15;
    reasons.push('Some review history');
  } else if (candidate.review_count > 0) {
    businessQualityScore += 8;
    reasons.push('Limited review history');
  } else {
    reasons.push('No review history found');
  }

  if (candidate.rating && candidate.rating >= 4.1) {
    businessQualityScore += 10;
    reasons.push('Strong public rating');
  } else if (candidate.rating && candidate.rating >= 3.5) {
    businessQualityScore += 7;
    reasons.push('Average public rating');
  } else if (candidate.rating) {
    businessQualityScore += 3;
    reasons.push('Reputation improvement opportunity');
  }

  if (candidate.category) {
    businessQualityScore += 5;
    reasons.push(`Category identified: ${candidate.category}`);
  }

  if (config.prospectDiscovery.minimumReviewCount > 0 && candidate.review_count < config.prospectDiscovery.minimumReviewCount) {
    businessQualityScore = Math.max(0, businessQualityScore - 20);
    reasons.push(`Below configured review threshold of ${config.prospectDiscovery.minimumReviewCount}`);
  }

  if (!candidate.website_url) {
    presenceGapScore += 80;
    reasons.push('Tier signal: Google profile has no website listed');
  } else if (websiteAudit.hostedPresenceOnly) {
    presenceGapScore += 65;
    reasons.push('Tier signal: Website field is only a social/listing profile');
  } else {
    presenceGapScore += 20;
    reasons.push('Website exists; use audit findings to assess conversion opportunity');
  }

  if (websiteAudit.reachable === false) {
    presenceGapScore += 45;
    reasons.push('Tier signal: Website appears unreachable');
  } else if (websiteAudit.status >= 400) {
    presenceGapScore += 35;
    reasons.push(`Tier signal: Website returned HTTP ${websiteAudit.status}`);
  }

  for (const issue of websiteAudit.issues || []) {
    if (issue.includes('HTTPS')) {
      presenceGapScore += 20;
    } else if (issue.includes('contact form') || issue.includes('call to action')) {
      presenceGapScore += 12;
    } else if (issue.includes('title') || issue.includes('Meta description')) {
      presenceGapScore += 10;
    } else if (issue.includes('3 seconds') || issue.includes('unusually large')) {
      presenceGapScore += 8;
    }
  }

  businessQualityScore = Math.max(0, Math.min(100, businessQualityScore));
  presenceGapScore = Math.max(0, Math.min(100, presenceGapScore));

  let leadTier = 'dnp';

  if (closedBusiness || businessQualityScore < 35) {
    leadTier = 'dnp';
  } else if (!candidate.website_url || websiteAudit.hostedPresenceOnly || websiteAudit.reachable === false) {
    leadTier = businessQualityScore >= 45 ? 'tier_a' : 'dnp';
  } else if (presenceGapScore >= 55) {
    leadTier = 'tier_b';
  } else if (businessQualityScore >= 55) {
    leadTier = 'tier_c';
  }

  if (leadTier === 'dnp') {
    reasons.push('DNP: weak operating signals or no clear outreach opportunity');
  } else {
    reasons.push(`${leadTierLabel(leadTier)}: ${buildTierRecommendation(leadTier)}`);
  }

  return {
    score: Math.round((businessQualityScore * 0.45) + (presenceGapScore * 0.55)),
    business_quality_score: businessQualityScore,
    presence_gap_score: presenceGapScore,
    lead_tier: leadTier,
    recommended_action: buildTierRecommendation(leadTier),
    outreach_angle: buildOutreachAngle(candidate, leadTier, websiteAudit),
    reasons,
  };
}

async function searchGooglePlaces({ query, maxResults, config }) {
  if (!config.prospectDiscovery.googlePlacesApiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is required for Google Places prospect discovery.');
  }

  const response = await fetch(googlePlacesTextSearchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.prospectDiscovery.googlePlacesApiKey,
      'X-Goog-FieldMask': googlePlacesFieldMask,
    },
    body: JSON.stringify({
      textQuery: query,
      pageSize: Math.max(1, Math.min(maxResults, 20)),
      includePureServiceAreaBusinesses: true,
      languageCode: 'en',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Places discovery failed with ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return (data.places || []).slice(0, maxResults).map((place) => mapGooglePlace(place, query));
}

async function findExistingSubmission(storage, candidate) {
  if (candidate.website_url && storage.getSubmissionByBusinessWebsite) {
    const existingByWebsite = await storage.getSubmissionByBusinessWebsite(candidate.website_url);

    if (existingByWebsite) {
      return existingByWebsite;
    }
  }

  return null;
}

function buildDiscoveryNotes(candidate, scoring) {
  return [
    `Prospect discovered from ${candidate.provider}: ${candidate.search_query}`,
    `Lead tier: ${leadTierLabel(scoring.lead_tier)}`,
    `Business quality score: ${scoring.business_quality_score}/100`,
    `Online presence gap score: ${scoring.presence_gap_score}/100`,
    `Recommended action: ${scoring.recommended_action}`,
    `Outreach angle: ${scoring.outreach_angle}`,
    candidate.category ? `Category: ${candidate.category}` : '',
    candidate.address ? `Address: ${candidate.address}` : '',
    candidate.phone ? `Phone: ${candidate.phone}` : '',
    candidate.rating ? `Rating: ${candidate.rating} (${candidate.review_count} reviews)` : '',
    candidate.source_data?.googleMapsUri ? `Google Maps: ${candidate.source_data.googleMapsUri}` : '',
    '',
    'Discovery score reasons:',
    ...scoring.reasons.map((reason) => `- ${reason}`),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function importDiscoveryToCrm({ storage, discovery, candidate, scoring, requestedBy }) {
  if (!actionableLeadTiers.has(scoring.lead_tier)) {
    return storage.updateProspectDiscovery(discovery.id, {
      updated_at: new Date().toISOString(),
      status: 'not-prioritized',
      lead_tier: scoring.lead_tier,
      business_quality_score: scoring.business_quality_score,
      presence_gap_score: scoring.presence_gap_score,
      recommended_action: scoring.recommended_action,
      outreach_angle: scoring.outreach_angle,
      score: scoring.score,
      reasons: scoring.reasons,
      source_data: discovery.source_data || {},
    });
  }

  const existingSubmission = await findExistingSubmission(storage, candidate);
  const now = new Date().toISOString();

  if (existingSubmission) {
    return storage.updateProspectDiscovery(discovery.id, {
      updated_at: now,
      status: 'duplicate',
      lead_tier: scoring.lead_tier,
      business_quality_score: scoring.business_quality_score,
      presence_gap_score: scoring.presence_gap_score,
      recommended_action: scoring.recommended_action,
      outreach_angle: scoring.outreach_angle,
      submission_id: existingSubmission.id,
      score: scoring.score,
      reasons: [...scoring.reasons, 'Skipped import because the website already exists in the CRM'],
      source_data: {
        ...(discovery.source_data || {}),
        duplicateSubmissionId: existingSubmission.id,
      },
    });
  }

  const created = await createManualSubmission(
    {
      company: candidate.business_name,
      role: 'Prospect',
      lead_type: 'prospect',
      status: 'review',
      priority: scoring.lead_tier === 'tier_a' ? 'high' : scoring.lead_tier === 'tier_b' ? 'medium' : 'normal',
      assigned_to: requestedBy || getConfig().workflow.defaultAssignee,
      tags: ['prospect-discovery', scoring.lead_tier.replace('_', '-'), candidate.provider, candidate.category].filter(Boolean),
      listing_url: candidate.source_data?.googleMapsUri || '',
      business_website: candidate.website_url,
      prospectus_url: `Discovery query: ${candidate.search_query}`,
      seller_name: candidate.business_name,
      seller_phone: candidate.phone,
      notes: buildDiscoveryNotes(candidate, scoring),
      source: 'prospect-discovery',
      next_action_at: '',
    },
    requestedBy || 'prospect-discovery',
  );

  if (!created.ok) {
    return storage.updateProspectDiscovery(discovery.id, {
      updated_at: now,
      status: 'import-error',
      lead_tier: scoring.lead_tier,
      business_quality_score: scoring.business_quality_score,
      presence_gap_score: scoring.presence_gap_score,
      recommended_action: scoring.recommended_action,
      outreach_angle: scoring.outreach_angle,
      score: scoring.score,
      reasons: [...scoring.reasons, ...(created.errors || ['Unable to import CRM record'])],
      source_data: discovery.source_data || {},
    });
  }

  return storage.updateProspectDiscovery(discovery.id, {
    updated_at: now,
    status: 'imported',
    lead_tier: scoring.lead_tier,
    business_quality_score: scoring.business_quality_score,
    presence_gap_score: scoring.presence_gap_score,
    recommended_action: scoring.recommended_action,
    outreach_angle: scoring.outreach_angle,
    submission_id: created.submission.id,
    score: scoring.score,
    reasons: scoring.reasons,
    source_data: {
      ...(discovery.source_data || {}),
      importedSubmissionId: created.submission.id,
    },
  });
}

async function discoverCandidates({ provider, query, maxResults, config }) {
  if (provider !== 'google-places') {
    throw new Error(`Unsupported prospect discovery provider: ${provider}`);
  }

  return searchGooglePlaces({ query, maxResults, config });
}

export async function runProspectDiscovery({ query = '', maxResults, autoImport, requestedBy = 'admin' } = {}) {
  const config = getConfig();
  const storage = getStorage();
  const provider = config.prospectDiscovery.provider;
  const discoveryQuery = normalizeText(query || config.prospectDiscovery.queries[0] || '', 500);
  const safeMaxResults = Math.max(1, Math.min(Number(maxResults) || config.prospectDiscovery.maxResultsPerQuery, 20));
  const shouldAutoImport = autoImport === undefined ? config.prospectDiscovery.autoImport : Boolean(autoImport);

  if (!config.prospectDiscovery.enabled) {
    return {
      ok: false,
      status: 400,
      error: 'Prospect discovery is disabled. Set PROSPECT_DISCOVERY_ENABLED=true after configuring a provider and target queries.',
    };
  }

  if (!discoveryQuery) {
    return {
      ok: false,
      status: 400,
      error: 'A prospect discovery query is required.',
    };
  }

  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    status: 'running',
    provider,
    query: discoveryQuery,
    requested_by: requestedBy,
    max_results: safeMaxResults,
    imported_count: 0,
    skipped_count: 0,
    error: '',
    source_data: {
      autoImport: shouldAutoImport,
    },
  };

  await storage.insertProspectDiscoveryRun(run);

  try {
    const candidates = await discoverCandidates({ provider, query: discoveryQuery, maxResults: safeMaxResults, config });
    const discoveries = [];
    let importedCount = 0;
    let skippedCount = 0;

    for (const candidate of candidates) {
      const websiteAudit = await inspectWebsitePresence(candidate, config);
      const scoring = scoreDiscoveredProspect(candidate, config, websiteAudit);
      const discovery = await storage.insertProspectDiscovery({
        id: randomUUID(),
        run_id: run.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...candidate,
        status: 'discovered',
        lead_tier: scoring.lead_tier,
        business_quality_score: scoring.business_quality_score,
        presence_gap_score: scoring.presence_gap_score,
        recommended_action: scoring.recommended_action,
        outreach_angle: scoring.outreach_angle,
        score: scoring.score,
        reasons: scoring.reasons,
        submission_id: null,
        source_data: {
          ...(candidate.source_data || {}),
          websiteAudit,
        },
      });
      const alreadySeen = discovery?.run_id && discovery.run_id !== run.id;

      if (alreadySeen) {
        if (!discovery.lead_tier || discovery.lead_tier === 'unclassified') {
          discoveries.push(
            await storage.updateProspectDiscovery(discovery.id, {
              updated_at: new Date().toISOString(),
              lead_tier: scoring.lead_tier,
              business_quality_score: scoring.business_quality_score,
              presence_gap_score: scoring.presence_gap_score,
              recommended_action: scoring.recommended_action,
              outreach_angle: scoring.outreach_angle,
              score: scoring.score,
              reasons: scoring.reasons,
              source_data: {
                ...(discovery.source_data || {}),
                websiteAudit,
              },
            }),
          );
        } else {
          discoveries.push(discovery);
        }
        skippedCount += 1;
        continue;
      }

      if (shouldAutoImport) {
        const imported = await importDiscoveryToCrm({
          storage,
          discovery,
          candidate,
          scoring,
          requestedBy,
        });

        discoveries.push(imported);

        if (imported?.status === 'imported') {
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      } else {
        discoveries.push(discovery);
      }
    }

    const completedRun = await storage.updateProspectDiscoveryRun(run.id, {
      updated_at: new Date().toISOString(),
      status: 'completed',
      imported_count: importedCount,
      skipped_count: skippedCount,
      source_data: {
        ...run.source_data,
        discoveredCount: candidates.length,
      },
    });

    return {
      ok: true,
      run: completedRun,
      discoveries,
      count: discoveries.length,
      importedCount,
      skippedCount,
    };
  } catch (error) {
    await storage.updateProspectDiscoveryRun(run.id, {
      updated_at: new Date().toISOString(),
      status: 'failed',
      error: error.message,
    });

    return {
      ok: false,
      status: 500,
      error: error.message,
    };
  }
}

export async function runConfiguredProspectDiscovery({ requestedBy = 'scheduler' } = {}) {
  const config = getConfig();
  const queries = config.prospectDiscovery.queries.slice(0, config.prospectDiscovery.maxQueriesPerRun);

  if (queries.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'No PROSPECT_DISCOVERY_QUERIES are configured.',
    };
  }

  const results = [];

  for (const query of queries) {
    results.push(
      await runProspectDiscovery({
        query,
        maxResults: config.prospectDiscovery.maxResultsPerQuery,
        autoImport: config.prospectDiscovery.autoImport,
        requestedBy,
      }),
    );
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    importedCount: results.reduce((total, result) => total + (result.importedCount || 0), 0),
    discoveredCount: results.reduce((total, result) => total + (result.count || 0), 0),
  };
}

function buildProspectDiscoverySummary(discoveries = []) {
  return discoveries.reduce(
    (accumulator, discovery) => {
      accumulator.total += 1;
      accumulator[discovery.status] = (accumulator[discovery.status] || 0) + 1;
      accumulator.byTier[discovery.lead_tier || 'unclassified'] = (accumulator.byTier[discovery.lead_tier || 'unclassified'] || 0) + 1;
      return accumulator;
    },
    {
      total: 0,
      imported: 0,
      discovered: 0,
      duplicate: 0,
      'import-error': 0,
      'not-prioritized': 0,
      byTier: { tier_a: 0, tier_b: 0, tier_c: 0, dnp: 0, unclassified: 0 },
    },
  );
}

export async function getProspectDiscoveryDashboard() {
  const config = getConfig();
  const storage = getStorage();
  const [runs, discoveries, storedSummary] = await Promise.all([
    storage.listProspectDiscoveryRuns ? storage.listProspectDiscoveryRuns({ limit: 10 }) : [],
    storage.listProspectDiscoveries ? storage.listProspectDiscoveries({ limit: 50 }) : [],
    storage.getProspectDiscoverySummary ? storage.getProspectDiscoverySummary() : null,
  ]);

  const summary = storedSummary || buildProspectDiscoverySummary(discoveries);

  return {
    ok: true,
    config: {
      enabled: config.prospectDiscovery.enabled,
      schedulerEnabled: config.prospectDiscovery.schedulerEnabled,
      provider: config.prospectDiscovery.provider,
      hasGooglePlacesApiKey: Boolean(config.prospectDiscovery.googlePlacesApiKey),
      queries: config.prospectDiscovery.queries,
      maxResultsPerQuery: config.prospectDiscovery.maxResultsPerQuery,
      autoImport: config.prospectDiscovery.autoImport,
      minimumReviewCount: config.prospectDiscovery.minimumReviewCount,
      websiteCheckEnabled: config.prospectDiscovery.websiteCheckEnabled,
      websiteCheckTimeoutMs: config.prospectDiscovery.websiteCheckTimeoutMs,
      websiteCheckMaxBytes: config.prospectDiscovery.websiteCheckMaxBytes,
    },
    summary,
    runs,
    discoveries,
  };
}
