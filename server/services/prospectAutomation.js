import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp } from '../utils/http.js';
import { hashIp } from '../utils/security.js';
import { sendMessage } from './delivery.js';
import { recordEmailEvent } from './emailEvents.js';

const tierLabels = {
  A: 'Tier A - follow up first',
  B: 'Tier B - strong fit',
  C: 'Tier C - nurture',
  D: 'Tier D - low priority',
};

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value = '') {
  return normalizeText(value, 200).toLowerCase();
}

function sentenceFragment(value = '') {
  return normalizeText(value, 300).replace(/[.!?]+$/g, '');
}

function normalizeUrl(value = '') {
  const rawValue = normalizeText(value, 1000);

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) {
      return '';
    }

    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first, second] = parts;
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

function isPrivateIpv6(address) {
  const normalized = String(address || '').toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4[1]);
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function isPrivateAddress(address) {
  const version = isIP(address);

  if (version === 4) {
    return isPrivateIpv4(address);
  }

  if (version === 6) {
    return isPrivateIpv6(address);
  }

  return false;
}

async function getAuditTargetBlockReason(normalizedUrl) {
  const url = new URL(normalizedUrl);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return 'Website audit target resolves to a local or internal hostname.';
  }

  if (isIP(hostname)) {
    return isPrivateAddress(hostname) ? 'Website audit target uses a private or internal IP address.' : '';
  }

  try {
    const records = await lookup(hostname, { all: true });

    if (records.some((record) => isPrivateAddress(record.address))) {
      return 'Website audit target resolves to a private or internal IP address.';
    }
  } catch {
    // Let the fetch attempt return the user-facing DNS/network error.
  }

  return '';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function addDays(timestamp, days) {
  return new Date(timestamp + days * 24 * 60 * 60 * 1000).toISOString();
}

function startOfCurrentUtcDay() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function readLimitedResponseBytes(response, maxBytes) {
  const safeMaxBytes = Math.max(1, Number(maxBytes) || 1);

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      bytes: buffer.subarray(0, safeMaxBytes),
      truncated: buffer.length > safeMaxBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    const remainingBytes = safeMaxBytes - totalBytes;

    if (chunk.length > remainingBytes) {
      if (remainingBytes > 0) {
        chunks.push(chunk.subarray(0, remainingBytes));
        totalBytes += remainingBytes;
      }

      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }

    chunks.push(chunk);
    totalBytes += chunk.length;
  }

  return {
    bytes: Buffer.concat(chunks, totalBytes),
    truncated,
  };
}

async function fetchAuditResponse(initialUrl, config) {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const blockReason = await getAuditTargetBlockReason(currentUrl);

    if (blockReason) {
      const error = new Error(blockReason);
      error.auditBlockReason = blockReason;
      throw error;
    }

    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(config.outreach.websiteFetchTimeoutMs),
      headers: {
        'User-Agent': `${config.brand.companyName} website audit bot; ${config.server.origin}`,
      },
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const nextUrl = normalizeUrl(new URL(response.headers.get('location'), currentUrl).toString());

      if (!nextUrl) {
        const error = new Error('Website redirects to an invalid URL.');
        error.auditBlockReason = error.message;
        throw error;
      }

      currentUrl = nextUrl;
      continue;
    }

    return {
      response,
      finalUrl: response.url || currentUrl,
    };
  }

  const error = new Error('Website redirects too many times.');
  error.auditBlockReason = error.message;
  throw error;
}

function encodeTokenPayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function signTokenPayload(encodedPayload) {
  const config = getConfig();
  return createHmac('sha256', config.outreach.unsubscribeSecret).update(encodedPayload).digest('base64url');
}

function signaturesMatch(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''));
  const actualBuffer = Buffer.from(String(actual || ''));

  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function createSignedToken(payload) {
  const encodedPayload = encodeTokenPayload(payload);
  return `${encodedPayload}.${signTokenPayload(encodedPayload)}`;
}

function readSignedToken(token) {
  const [encodedPayload, signature] = String(token || '').split('.');

  if (!encodedPayload || !signature || !signaturesMatch(signTokenPayload(encodedPayload), signature)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function buildUnsubscribeUrl({ messageId, submissionId, email }) {
  const config = getConfig();
  const token = createSignedToken({
    messageId,
    submissionId,
    email: normalizeEmail(email),
  });

  return new URL(`/unsubscribe/${token}`, config.server.origin).toString();
}

function extractMatch(html, pattern) {
  const match = html.match(pattern);
  return normalizeText(match?.[1] || '', 500);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(html)) && links.length < 40) {
    const href = normalizeText(match[1], 1000);

    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }

    try {
      const url = new URL(href, baseUrl);

      if (['http:', 'https:'].includes(url.protocol)) {
        links.push({
          href: url.toString(),
          text: normalizeText(match[2].replace(/<[^>]*>/g, ' '), 140),
        });
      }
    } catch {
      // Skip malformed links.
    }
  }

  return links;
}

async function fetchWebsiteSnapshot(websiteUrl) {
  const config = getConfig();
  const startedAt = Date.now();
  const normalizedUrl = normalizeUrl(websiteUrl);

  if (!normalizedUrl) {
    return {
      ok: false,
      url: '',
      status: 0,
      error: 'No valid website URL is available.',
      html: '',
      sizeBytes: 0,
      loadTimeMs: 0,
      headers: {},
    };
  }

  try {
    const { response, finalUrl } = await fetchAuditResponse(normalizedUrl, config);
    const contentType = response.headers.get('content-type') || '';
    const { bytes, truncated } = await readLimitedResponseBytes(response, config.outreach.websiteFetchMaxBytes);

    return {
      ok: response.ok,
      url: finalUrl,
      status: response.status,
      error: response.ok ? '' : `Website returned HTTP ${response.status}.`,
      html: contentType.includes('text/html') ? bytes.toString('utf8') : '',
      sizeBytes: bytes.length,
      loadTimeMs: Date.now() - startedAt,
      headers: {
        contentType,
        server: response.headers.get('server') || '',
        truncated,
      },
    };
  } catch (error) {
    return {
      ok: false,
      url: normalizedUrl,
      status: 0,
      error: error.auditBlockReason || (error.name === 'TimeoutError' ? 'Website request timed out.' : error.message),
      html: '',
      sizeBytes: 0,
      loadTimeMs: Date.now() - startedAt,
      headers: {},
    };
  }
}

async function checkInternalLinks(links = [], baseUrl = '') {
  const config = getConfig();
  const base = normalizeUrl(baseUrl);

  if (!base) {
    return [];
  }

  const baseHost = new URL(base).hostname.replace(/^www\./, '');
  const candidates = Array.from(
    new Map(
      links
        .filter((link) => {
          try {
            const url = new URL(link.href);
            return url.hostname.replace(/^www\./, '') === baseHost;
          } catch {
            return false;
          }
        })
        .slice(0, 8)
        .map((link) => [link.href, link]),
    ).values(),
  );
  const results = [];

  for (const link of candidates) {
    try {
      const response = await fetch(link.href, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(config.outreach.websiteFetchTimeoutMs, 5000)),
        headers: {
          'User-Agent': `${config.brand.companyName} link audit bot; ${config.server.origin}`,
        },
      });

      if (response.status >= 400) {
        results.push({
          href: link.href,
          text: link.text,
          status: response.status,
        });
      }
    } catch (error) {
      results.push({
        href: link.href,
        text: link.text,
        status: 0,
        error: error.name === 'TimeoutError' ? 'timeout' : error.message,
      });
    }
  }

  return results;
}

function buildFinding({ severity = 'medium', category, title, recommendation }) {
  return {
    severity,
    category,
    title,
    recommendation,
  };
}

async function analyzeWebsite({ submission, snapshot }) {
  const html = snapshot.html || '';
  const lowerHtml = html.toLowerCase();
  const title = extractMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    extractMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    extractMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
  const sourceLinks = extractLinks(html, snapshot.url || submission.business_website);
  const brokenLinks = await checkInternalLinks(sourceLinks, snapshot.url || submission.business_website);
  const findings = [];
  const ctaMatches = lowerHtml.match(/\b(call|book|schedule|quote|estimate|contact|get started|request|consultation)\b/g) || [];
  const hasContactForm = /<form\b/i.test(html) && /(contact|quote|estimate|message|name|email)/i.test(html);
  const hasPhoneLink = /href=["']tel:/i.test(html);
  const hasBookingLink = /(cal\.com|calendly\.com|book|schedule|appointment)/i.test(html);
  const hasMobileViewport = /<meta[^>]+name=["']viewport["']/i.test(html);

  if (!snapshot.url.startsWith('https://')) {
    findings.push(
      buildFinding({
        severity: 'high',
        category: 'Trust',
        title: 'The site is not loading over HTTPS.',
        recommendation: 'Use HTTPS by default so visitors do not see browser trust warnings before contacting the business.',
      }),
    );
  }

  if (!snapshot.ok) {
    findings.push(
      buildFinding({
        severity: 'high',
        category: 'Uptime',
        title: snapshot.status ? `The homepage returned HTTP ${snapshot.status}.` : 'The homepage could not be reached reliably.',
        recommendation: 'Fix the hosting, DNS, redirect, or server response before sending more paid or organic traffic to the site.',
      }),
    );
  }

  if (!title || title.length < 15 || title.length > 70) {
    findings.push(
      buildFinding({
        category: 'SEO Basics',
        title: 'The page title is missing, too short, or too long.',
        recommendation: 'Use a clear title with the business name, service, and local relevance so searchers understand the page quickly.',
      }),
    );
  }

  if (!metaDescription || metaDescription.length < 60 || metaDescription.length > 180) {
    findings.push(
      buildFinding({
        category: 'SEO Basics',
        title: 'The meta description needs improvement.',
        recommendation: 'Write a concise summary that explains the service, location, and next action a customer should take.',
      }),
    );
  }

  if (!hasMobileViewport) {
    findings.push(
      buildFinding({
        severity: 'high',
        category: 'Mobile',
        title: 'The page is missing a mobile viewport tag.',
        recommendation: 'Add mobile viewport support so the site scales properly on phones.',
      }),
    );
  }

  if (ctaMatches.length < 2) {
    findings.push(
      buildFinding({
        category: 'Conversion',
        title: 'Calls to action are not obvious enough.',
        recommendation: 'Add clear “Call”, “Book”, “Request a Quote”, or “Schedule” actions near the top and bottom of the page.',
      }),
    );
  }

  if (!hasContactForm && !hasPhoneLink && !hasBookingLink) {
    findings.push(
      buildFinding({
        severity: 'high',
        category: 'Contact Flow',
        title: 'The homepage does not expose an obvious form, phone link, or booking path.',
        recommendation: 'Make the easiest next step visible on desktop and mobile so interested visitors can become leads.',
      }),
    );
  }

  if (snapshot.sizeBytes > 900000) {
    findings.push(
      buildFinding({
        category: 'Speed',
        title: 'The homepage appears unusually large.',
        recommendation: 'Compress images, remove unused scripts, and keep the first page light enough for mobile visitors.',
      }),
    );
  }

  if (brokenLinks.length > 0) {
    findings.push(
      buildFinding({
        severity: 'medium',
        category: 'Broken Links',
        title: `${brokenLinks.length} internal link${brokenLinks.length === 1 ? '' : 's'} returned an error or timeout.`,
        recommendation: 'Fix broken customer paths so visitors do not hit dead pages while trying to evaluate or contact the business.',
      }),
    );
  }

  if (findings.length === 0) {
    findings.push(
      buildFinding({
        severity: 'low',
        category: 'Opportunity',
        title: 'No obvious homepage blockers were found in the first automated pass.',
        recommendation: 'Use a deeper audit to review forms, service pages, local search signals, reviews, and competitor positioning.',
      }),
    );
  }

  return {
    website_url: snapshot.url || submission.business_website || '',
    uptime_status: snapshot.ok ? 'up' : 'issue',
    http_status: snapshot.status || 0,
    ssl_status: snapshot.url?.startsWith('https://') ? 'valid-or-present' : 'missing-or-not-used',
    page_title: title,
    meta_description: metaDescription,
    has_contact_form: hasContactForm,
    has_phone_link: hasPhoneLink,
    has_booking_link: hasBookingLink,
    has_mobile_viewport: hasMobileViewport,
    cta_count: ctaMatches.length,
    broken_link_count: brokenLinks.length,
    page_size_bytes: snapshot.sizeBytes,
    load_time_ms: snapshot.loadTimeMs,
    findings,
    source_links: sourceLinks.slice(0, 12),
    raw_snapshot: {
      fetchedUrl: snapshot.url,
      requestedUrl: submission.business_website,
      error: snapshot.error,
      headers: snapshot.headers,
      title,
      metaDescription,
      sourceLinkCount: sourceLinks.length,
      brokenLinks,
    },
  };
}

function determineTier(score) {
  if (score >= 80) {
    return 'A';
  }

  if (score >= 60) {
    return 'B';
  }

  if (score >= 40) {
    return 'C';
  }

  return 'D';
}

export function scoreProspect({ submission, audit = null, emailEngagement = null, visits = [] } = {}) {
  let score = 20;
  const reasons = [];
  const findings = audit?.findings || [];
  const highFindings = findings.filter((finding) => finding.severity === 'high').length;

  if (submission?.business_website) {
    score += 10;
    reasons.push('Website URL available');
  }

  if (submission?.primary_contact_email || submission?.seller_email || submission?.email) {
    score += 10;
    reasons.push('Contact email available');
  }

  if (audit?.uptime_status === 'up') {
    score += 8;
    reasons.push('Website reachable');
  }

  if (findings.length >= 3) {
    score += 18;
    reasons.push('Multiple actionable website issues found');
  }

  if (highFindings > 0) {
    score += Math.min(20, highFindings * 10);
    reasons.push('High-impact lead-flow issues found');
  }

  if (emailEngagement?.opened >= 2) {
    score += 12;
    reasons.push('Email opened multiple times');
  }

  if (emailEngagement?.clicked) {
    score += 18;
    reasons.push('Clicked outreach link');
  }

  if (emailEngagement?.replied) {
    score += 25;
    reasons.push('Replied to outreach');
  }

  if (visits.length > 0) {
    score += Math.min(20, visits.length * 8);
    reasons.push('Visited the website after outreach');
  }

  if (emailEngagement?.bounced || emailEngagement?.complained || emailEngagement?.unsubscribed) {
    score -= 60;
    reasons.push('Suppression or delivery issue');
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  const tier = determineTier(normalizedScore);

  return {
    score: normalizedScore,
    tier,
    tierLabel: tierLabels[tier],
    reasons,
  };
}

function buildReportMarkdown({ submission, audit, score }) {
  const company = normalizeText(submission.company || submission.name || 'this business', 160);
  const findings = audit.findings || [];

  return [
    `# Website Audit Snapshot: ${company}`,
    '',
    `Priority tier: ${score.tierLabel} (${score.score}/100)`,
    '',
    `Website reviewed: ${audit.website_url || 'Not available'}`,
    `Homepage status: ${audit.uptime_status}${audit.http_status ? ` (${audit.http_status})` : ''}`,
    `Page title: ${audit.page_title || 'Missing or unclear'}`,
    `Meta description: ${audit.meta_description || 'Missing or unclear'}`,
    '',
    '## Top Actionable Findings',
    ...findings.slice(0, 5).map((finding, index) => `${index + 1}. ${finding.title} ${finding.recommendation}`),
    '',
    '## Recommended Outreach Angle',
    `Lead with one specific issue tied to ${company}'s website, then offer a short audit review call focused on calls, quote requests, bookings, or form fills.`,
  ].join('\n');
}

function buildPersonalization({ submission, audit, score }) {
  const company = normalizeText(submission.company || submission.name || 'your business', 160);
  const topFinding = audit.findings?.find((finding) => finding.severity === 'high') || audit.findings?.[0];
  const website = audit.website_url || submission.business_website || '';
  const leadReason = sentenceFragment(topFinding?.title || 'a few online presence items worth reviewing');

  return {
    company,
    website,
    tier: score.tier,
    tierLabel: score.tierLabel,
    leadReason,
    recommendedOpener: `I reviewed ${company}'s website and noticed ${leadReason.toLowerCase()}.`,
    valueProposition:
      'I help local businesses keep websites current, fix contact-flow problems, clean up local SEO basics, and turn more visitors into calls, bookings, quote requests, or form fills.',
    cta: 'Book a 15-minute website audit call or send the inquiry form with the customer action you want more of.',
  };
}

function trackingUrl(path, submissionId, source) {
  const config = getConfig();
  const base = new URL(path, config.server.origin);
  base.searchParams.set('submission_id', submissionId);
  base.searchParams.set('utm_source', source);
  base.searchParams.set('utm_medium', 'email');
  base.searchParams.set('utm_campaign', 'website-audit-outreach');
  return base.toString();
}

function buildEmailBody({ submission, personalization, step, unsubscribeUrl = '' }) {
  const company = personalization.company;
  const opener = personalization.recommendedOpener;
  const value = personalization.valueProposition;
  const cta = personalization.cta;
  const signoff = 'Mathew Uckele';

  if (step === 1) {
    return [
      `Hi ${submission.primary_contact_name || submission.seller_name || submission.name || 'there'},`,
      '',
      opener,
      '',
      value,
      '',
      `${cta}`,
      '',
      `Best,`,
      signoff,
      ...(unsubscribeUrl ? ['', `Opt out: ${unsubscribeUrl}`] : []),
    ].join('\n');
  }

  if (step === 2) {
    return [
      `Hi ${submission.primary_contact_name || submission.seller_name || submission.name || 'there'},`,
      '',
      `I wanted to follow up on ${company}'s website. The main thing I would review first is: ${personalization.leadReason}`,
      '',
      'If useful, I can walk through the quick audit and show where a few small fixes may improve lead flow.',
      '',
      signoff,
      ...(unsubscribeUrl ? ['', `Opt out: ${unsubscribeUrl}`] : []),
    ].join('\n');
  }

  if (step === 3) {
    return [
      `Hi ${submission.primary_contact_name || submission.seller_name || submission.name || 'there'},`,
      '',
      `For local service businesses, the easiest wins are often clearer calls to action, cleaner mobile contact paths, and pages that match what customers are searching for.`,
      '',
      `That is the type of practical online presence work I help with. If ${company} is already covered, no problem.`,
      '',
      signoff,
      ...(unsubscribeUrl ? ['', `Opt out: ${unsubscribeUrl}`] : []),
    ].join('\n');
  }

  return [
    `Hi ${submission.primary_contact_name || submission.seller_name || submission.name || 'there'},`,
    '',
    `Last note from me. I reviewed ${company}'s site because it looked like there may be practical opportunities to improve calls, forms, bookings, or trust signals.`,
    '',
    'If now is not the right time, feel free to ignore this or reply “not interested” and I will not keep following up.',
    '',
    signoff,
    ...(unsubscribeUrl ? ['', `Opt out: ${unsubscribeUrl}`] : []),
  ].join('\n');
}

function buildEmailHtml({ subject, bodyText, ctaUrl, formUrl, unsubscribeUrl }) {
  const paragraphs = bodyText
    .split('\n\n')
    .map((paragraph) => escapeHtml(paragraph).replace(/\n/g, '<br />'))
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 16px;color:#33443B;font-size:16px;line-height:1.65;">${paragraph}</p>`)
    .join('');

  return `
    <!doctype html>
    <html>
      <body style="margin:0;padding:0;background:#F8F4ED;color:#18211D;font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#F8F4ED;">
          <tr>
            <td style="padding:28px 14px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;margin:0 auto;border-collapse:collapse;">
                <tr>
                  <td style="padding:0 0 14px;">
                    <div style="display:inline-block;height:40px;width:40px;border-radius:10px;background:#284638;color:#fff;font-weight:800;line-height:40px;text-align:center;">UG</div>
                    <span style="display:inline-block;margin-left:10px;color:#18211D;font-size:18px;font-weight:800;vertical-align:middle;">Uckele Group</span>
                  </td>
                </tr>
                <tr>
                  <td style="border:1px solid #E3D9CA;border-radius:18px;background:#fff;padding:32px;">
                    <p style="margin:0 0 12px;color:#7A5A3B;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;">Website Audit</p>
                    <h1 style="margin:0 0 18px;color:#18211D;font-size:26px;line-height:1.22;">${escapeHtml(subject)}</h1>
                    ${paragraphs}
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
                      <tr>
                        <td style="padding:0 10px 10px 0;">
                          <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;border:1px solid #284638;border-radius:999px;background:#284638;color:#fff;font-size:14px;font-weight:700;line-height:1;padding:14px 18px;text-decoration:none;">Book a 15-minute call</a>
                        </td>
                        <td style="padding:0 0 10px 0;">
                          <a href="${escapeHtml(formUrl)}" style="display:inline-block;border:1px solid #D6CCBE;border-radius:999px;background:#fff;color:#284638;font-size:14px;font-weight:700;line-height:1;padding:14px 18px;text-decoration:none;">Send website details</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:18px 0 0;color:#6A756F;font-size:12px;line-height:1.6;">If this is not relevant, reply “not interested” or <a href="${escapeHtml(unsubscribeUrl)}" style="color:#284638;text-decoration:underline;">unsubscribe from these emails</a>.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

function buildOutreachMessages({ submission, report, personalization }) {
  const config = getConfig();
  const now = Date.now();
  const recipientEmail = normalizeEmail(submission.primary_contact_email || submission.seller_email || submission.email);
  const bookingUrl = config.brand.schedulingUrl
    ? trackingUrl(config.brand.schedulingUrl, submission.id, 'outreach-booking')
    : trackingUrl('/contact', submission.id, 'outreach-booking');
  const formUrl = trackingUrl('/contact', submission.id, 'outreach-form');
  const cadenceDays = config.outreach.cadenceDays.length ? config.outreach.cadenceDays : [0, 3, 7, 14];
  const subjects = [
    `${personalization.company} website audit note`,
    `Following up on ${personalization.company}'s website`,
    `Quick lead-flow idea for ${personalization.company}`,
    `Should I close the loop?`,
  ];

  return cadenceDays.map((days, index) => {
    const step = index + 1;
    const messageId = randomUUID();
    const subject = subjects[index] || `Website audit follow-up for ${personalization.company}`;
    const unsubscribeUrl = buildUnsubscribeUrl({
      messageId,
      submissionId: submission.id,
      email: recipientEmail,
    });
    const bodyText = buildEmailBody({ submission, personalization, step, unsubscribeUrl });

    return {
      id: messageId,
      submission_id: submission.id,
      report_id: report.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cadence_name: 'website-audit-intro',
      cadence_step: step,
      status: config.outreach.autoScheduleAfterResearch ? 'scheduled' : 'draft',
      scheduled_at: addDays(now, days),
      sent_at: '',
      recipient_email: recipientEmail,
      subject,
      body_text: bodyText,
      body_html: buildEmailHtml({ subject, bodyText, ctaUrl: bookingUrl, formUrl, unsubscribeUrl }),
      provider_message_id: '',
      error: '',
      metadata: {
        bookingUrl,
        formUrl,
        unsubscribeUrl,
        tier: personalization.tier,
        generatedFromReportId: report.id,
      },
    };
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function actionableFindings(audit) {
  return (audit?.findings || []).filter(
    (finding) => finding?.title && !/no obvious homepage blockers/i.test(finding.title),
  );
}

async function supersedeDraftOutreachMessages({ storage, messages = [], reason = 'A newer research run generated a replacement cadence.' }) {
  const now = new Date().toISOString();
  const superseded = [];

  for (const message of messages.filter((item) => item.status === 'draft')) {
    superseded.push(
      await storage.updateOutreachMessage(message.id, {
        updated_at: now,
        status: 'superseded',
        error: reason,
        metadata: {
          ...(message.metadata || {}),
          supersededAt: now,
          supersededReason: reason,
        },
      }),
    );
  }

  return superseded;
}

async function evaluateOutreachEligibility({ submission, outreachMessage = null, audit = null, report = null, storage }) {
  const config = getConfig();
  const recipientEmail = normalizeEmail(
    outreachMessage?.recipient_email || submission?.primary_contact_email || submission?.seller_email || submission?.email,
  );
  const reasons = [];

  if (!recipientEmail || !isValidEmail(recipientEmail)) {
    reasons.push('valid recipient email is required');
  }

  if (!normalizeUrl(submission?.business_website)) {
    reasons.push('valid business website is required');
  }

  if (['archived', 'spam'].includes(String(submission?.status || '').toLowerCase())) {
    reasons.push('CRM record is archived or marked spam');
  }

  if (!config.brand.mailingAddress) {
    reasons.push('physical mailing address is required before marketing outreach');
  }

  if (!audit) {
    reasons.push('completed website audit is required');
  } else if (actionableFindings(audit).length === 0) {
    reasons.push('at least one actionable audit finding is required');
  }

  if (!report || report.status !== 'ready') {
    reasons.push('ready generated report is required');
  }

  const suppression = recipientEmail && storage.getEmailSuppression ? await storage.getEmailSuppression(recipientEmail) : null;

  if (suppression) {
    reasons.push(`recipient is suppressed (${suppression.reason})`);
  }

  if (recipientEmail && storage.listEmailEvents) {
    const events = await storage.listEmailEvents({ recipientEmail, limit: 50 });
    const hasStopEvent = events.some((event) =>
      ['bounced', 'complained', 'failed', 'replied', 'unsubscribed'].includes(String(event.event_type || '').toLowerCase()),
    );

    if (hasStopEvent) {
      reasons.push('recipient has a prior reply, bounce, complaint, failure, or unsubscribe event');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    recipientEmail,
  };
}

export async function unsubscribeOutreachRecipient(token, request) {
  const storage = getStorage();
  const payload = readSignedToken(token);

  if (!payload) {
    return {
      ok: false,
      status: 400,
      error: 'That unsubscribe link is invalid or has expired.',
    };
  }

  const recipientEmail = normalizeEmail(payload.email);

  if (!isValidEmail(recipientEmail)) {
    return {
      ok: false,
      status: 400,
      error: 'That unsubscribe link does not include a valid recipient.',
    };
  }

  const now = new Date().toISOString();
  const submissionId = normalizeText(payload.submissionId, 80) || null;
  const messageId = normalizeText(payload.messageId, 120) || null;
  const metadata = {
    messageId,
    ipHash: hashIp(getClientIp(request)),
    userAgent: normalizeText(request?.headers?.['user-agent'], 300),
  };
  const existingSuppression = await storage.getEmailSuppression(recipientEmail);

  if (!existingSuppression) {
    await storage.insertEmailSuppression({
      id: randomUUID(),
      created_at: now,
      email: recipientEmail,
      reason: 'unsubscribed',
      source: 'one-click-unsubscribe',
      submission_id: submissionId,
      metadata,
    });
  }

  await recordEmailEvent({
    created_at: now,
    provider: 'uckele-group',
    event_type: 'unsubscribed',
    message_id: messageId,
    recipient_email: recipientEmail,
    submission_id: submissionId,
    source: 'unsubscribe-link',
    metadata,
  });

  const relatedMessages = submissionId ? await storage.listOutreachMessagesForSubmission(submissionId, 100) : [];
  const currentMessage = relatedMessages.find((message) => message.id === messageId);

  if (messageId) {
    await storage.updateOutreachMessage(messageId, {
      updated_at: now,
      status: 'unsubscribed',
      error: '',
      metadata: {
        ...(currentMessage?.metadata || {}),
        unsubscribedAt: now,
      },
    });
  }

  if (submissionId) {
    const pendingMessages = relatedMessages.filter(
      (message) =>
        normalizeEmail(message.recipient_email) === recipientEmail &&
        ['draft', 'scheduled'].includes(String(message.status || '').toLowerCase()) &&
        message.id !== messageId,
    );

    for (const message of pendingMessages) {
      await storage.updateOutreachMessage(message.id, {
        updated_at: now,
        status: 'suppressed',
        error: 'Recipient unsubscribed from outreach.',
        metadata: {
          ...(message.metadata || {}),
          suppressedAt: now,
          suppressionReason: 'unsubscribed',
        },
      });
    }
  }

  return {
    ok: true,
    email: recipientEmail,
    alreadySuppressed: Boolean(existingSuppression),
  };
}

export function previewOutreachUnsubscribe(token) {
  const payload = readSignedToken(token);

  if (!payload) {
    return {
      ok: false,
      status: 400,
      error: 'That unsubscribe link is invalid or has expired.',
    };
  }

  const recipientEmail = normalizeEmail(payload.email);

  if (!isValidEmail(recipientEmail)) {
    return {
      ok: false,
      status: 400,
      error: 'That unsubscribe link does not include a valid recipient.',
    };
  }

  return {
    ok: true,
    email: recipientEmail,
  };
}

export async function approveOutreachCadence({ submissionId, approvedBy = 'admin' } = {}) {
  const config = getConfig();
  const storage = getStorage();
  const submission = await storage.getSubmission(submissionId);

  if (!submission) {
    return {
      ok: false,
      status: 404,
      error: 'CRM record not found.',
    };
  }

  const [audits, reports, outreachMessages] = await Promise.all([
    storage.listProspectAuditsForSubmission(submission.id, 5),
    storage.listGeneratedReportsForSubmission(submission.id, 5),
    storage.listOutreachMessagesForSubmission(submission.id, 20),
  ]);
  const latestAudit = audits[0] || null;
  const latestReport = reports[0] || null;
  const staleDraftMessages = latestReport
    ? outreachMessages.filter((message) => message.status === 'draft' && message.report_id !== latestReport.id)
    : [];
  const draftMessages = latestReport
    ? outreachMessages.filter((message) => message.status === 'draft' && message.report_id === latestReport.id)
    : [];

  if (draftMessages.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'No draft outreach messages for the latest report are available to approve.',
    };
  }

  const eligibility = await evaluateOutreachEligibility({
    submission,
    outreachMessage: draftMessages[0],
    audit: latestAudit,
    report: latestReport,
    storage,
  });

  if (!eligibility.ok) {
    return {
      ok: false,
      status: 400,
      error: `Outreach cannot be approved yet: ${eligibility.reasons.join('; ')}.`,
      reasons: eligibility.reasons,
    };
  }

  const approved = [];
  const approvedAt = new Date();
  const cadenceDays = config.outreach.cadenceDays.length ? config.outreach.cadenceDays : [0, 3, 7, 14];

  await supersedeDraftOutreachMessages({
    storage,
    messages: staleDraftMessages,
    reason: 'A newer report was approved for this CRM record.',
  });

  for (const [index, message] of draftMessages.entries()) {
    approved.push(
      await storage.updateOutreachMessage(message.id, {
        updated_at: approvedAt.toISOString(),
        status: 'scheduled',
        scheduled_at: addDays(approvedAt.getTime(), cadenceDays[index] ?? Math.max(0, index * 3)),
        metadata: {
          ...(message.metadata || {}),
          approvedBy,
          approvedAt: approvedAt.toISOString(),
        },
      }),
    );
  }

  return {
    ok: true,
    approved,
    count: approved.length,
  };
}

export async function runProspectAutomation({ submissionId, requestedBy = 'admin' } = {}) {
  const storage = getStorage();
  const submission = await storage.getSubmission(submissionId);

  if (!submission) {
    return {
      ok: false,
      status: 404,
      error: 'CRM record not found.',
    };
  }

  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    created_at: now,
    updated_at: now,
    submission_id: submission.id,
    run_type: 'website-audit-and-outreach',
    status: 'running',
    requested_by: requestedBy,
    started_at: now,
    completed_at: '',
    error: '',
    source_url: submission.business_website || '',
    score: 0,
    tier: '',
    summary: '',
    source_data: {},
  };

  await storage.insertResearchRun(run);

  try {
    const existingOutreachMessages = storage.listOutreachMessagesForSubmission
      ? await storage.listOutreachMessagesForSubmission(submission.id, 100)
      : [];
    const snapshot = await fetchWebsiteSnapshot(submission.business_website);
    const auditData = await analyzeWebsite({ submission, snapshot });
    const audit = {
      id: randomUUID(),
      run_id: run.id,
      submission_id: submission.id,
      created_at: new Date().toISOString(),
      ...auditData,
    };
    const score = scoreProspect({ submission, audit });
    const personalization = buildPersonalization({ submission, audit, score });
    const report = {
      id: randomUUID(),
      run_id: run.id,
      submission_id: submission.id,
      created_at: new Date().toISOString(),
      report_type: 'prospect-website-audit',
      status: 'ready',
      title: `Website audit snapshot for ${personalization.company}`,
      summary: `${score.tierLabel}. ${audit.findings.slice(0, 2).map((finding) => finding.title).join(' ')}`,
      content_markdown: buildReportMarkdown({ submission, audit, score }),
      personalization,
      recommended_email_subject: `${personalization.company} website audit note`,
      recommended_email_body: buildEmailBody({ submission, personalization, step: 1 }),
    };
    const messages = buildOutreachMessages({ submission, report, personalization });

    await storage.insertProspectAudit(audit);
    await storage.insertGeneratedReport(report);

    for (const message of messages) {
      await storage.insertOutreachMessage(message);
    }

    await supersedeDraftOutreachMessages({
      storage,
      messages: existingOutreachMessages,
      reason: 'A newer research run generated a replacement cadence.',
    });

    const updatedRun = await storage.updateResearchRun(run.id, {
      updated_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
      source_url: audit.website_url,
      score: score.score,
      tier: score.tier,
      summary: report.summary,
      source_data: {
        snapshot: audit.raw_snapshot,
        scoreReasons: score.reasons,
        generatedOutreachMessages: messages.length,
      },
    });

    return {
      ok: true,
      run: updatedRun,
      audit,
      report,
      outreachMessages: messages,
      score,
    };
  } catch (error) {
    await storage.updateResearchRun(run.id, {
      updated_at: new Date().toISOString(),
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: error.message,
    });

    return {
      ok: false,
      status: 500,
      error: error.message,
    };
  }
}

export async function recordWebsiteVisit(body = {}, request) {
  const storage = getStorage();
  const submissionId = normalizeText(body.submission_id || body.submissionId || body.sid, 80);
  const submission = submissionId ? await storage.getSubmission(submissionId) : null;
  const visit = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    submission_id: submission?.id || null,
    session_id: normalizeText(body.session_id || body.sessionId, 120),
    page_path: normalizeText(body.page_path || body.pagePath || '/', 500) || '/',
    full_url: normalizeText(body.full_url || body.fullUrl, 1000),
    referrer: normalizeText(body.referrer, 1000),
    source: normalizeText(body.source || body.utm_source, 120),
    ip_hash: hashIp(getClientIp(request)),
    user_agent: normalizeText(request?.headers?.['user-agent'], 300),
    metadata: {
      utm_medium: normalizeText(body.utm_medium, 120),
      utm_campaign: normalizeText(body.utm_campaign, 160),
      tracked: Boolean(submission?.id),
    },
  };

  await storage.insertWebsiteVisit(visit);

  return {
    ok: true,
    tracked: Boolean(submission?.id),
  };
}

export async function sendDueOutreachMessages({ limit } = {}) {
  const config = getConfig();
  const storage = getStorage();

  if (!config.outreach.enabled) {
    return {
      ok: false,
      status: 400,
      error: 'Outreach automation is disabled. Set OUTREACH_AUTOMATION_ENABLED=true when the sending domain, unsubscribe process, and daily limits are ready.',
    };
  }

  const dailyLimitSince = startOfCurrentUtcDay();
  const sentBeforeRun = await storage.countSentOutreachMessagesSince(dailyLimitSince);
  const dailyRemainingBeforeRun = Math.max(0, config.outreach.dailySendLimit - sentBeforeRun);
  const requestedLimit = Math.min(Number(limit) || config.outreach.dailySendLimit, config.outreach.dailySendLimit);
  const safeLimit = Math.min(requestedLimit, dailyRemainingBeforeRun);

  if (safeLimit <= 0) {
    return {
      ok: true,
      sent: [],
      failed: [],
      count: 0,
      dailyLimitReached: true,
      dailyLimit: config.outreach.dailySendLimit,
      dailySent: sentBeforeRun,
      dailyRemaining: 0,
      dailyLimitSince,
    };
  }

  const dueMessages = await storage.listDueOutreachMessages({ limit: safeLimit });
  const sent = [];
  const failed = [];

  for (const dueMessage of dueMessages) {
    const latestSentToday = await storage.countSentOutreachMessagesSince(dailyLimitSince);

    if (latestSentToday >= config.outreach.dailySendLimit) {
      break;
    }

    const claimedMessage = await storage.claimOutreachMessageForSending(dueMessage.id, {
      now: new Date().toISOString(),
    });

    if (!claimedMessage) {
      continue;
    }

    const outreachMessage = claimedMessage;
    const submission = await storage.getSubmission(outreachMessage.submission_id);

    if (!submission) {
      await storage.updateOutreachMessage(outreachMessage.id, {
        updated_at: new Date().toISOString(),
        status: 'failed',
        error: 'CRM record no longer exists.',
      });
      failed.push(outreachMessage.id);
      continue;
    }

    const [audits, reports] = await Promise.all([
      storage.listProspectAuditsForSubmission(submission.id, 1),
      storage.listGeneratedReportsForSubmission(submission.id, 1),
    ]);
    const eligibility = await evaluateOutreachEligibility({
      submission,
      outreachMessage,
      audit: audits[0] || null,
      report: reports[0] || null,
      storage,
    });

    if (!eligibility.ok) {
      const suppressed = eligibility.reasons.some((reason) => /suppressed|reply|bounce|complaint|failure|unsubscribe/i.test(reason));

      await storage.updateOutreachMessage(outreachMessage.id, {
        updated_at: new Date().toISOString(),
        status: suppressed ? 'suppressed' : 'blocked',
        error: eligibility.reasons.join('; '),
        metadata: {
          ...(outreachMessage.metadata || {}),
          lastEligibilityCheckAt: new Date().toISOString(),
          blockingReasons: eligibility.reasons,
        },
      });
      failed.push(outreachMessage.id);
      continue;
    }

    const unsubscribeUrl = outreachMessage.metadata?.unsubscribeUrl || '';
    const result = await sendMessage({
      kind: 'outreach',
      to: outreachMessage.recipient_email,
      subject: outreachMessage.subject,
      text: outreachMessage.body_text,
      html: outreachMessage.body_html,
      headers: unsubscribeUrl
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : undefined,
      tags: [
        { name: 'source', value: 'outreach' },
        { name: 'submission_id', value: submission.id },
        { name: 'outreach_message_id', value: outreachMessage.id },
      ],
      tracking: {
        submissionId: submission.id,
        outreachMessageId: outreachMessage.id,
        cadenceName: outreachMessage.cadence_name,
        cadenceStep: outreachMessage.cadence_step,
      },
    });

    await storage.updateOutreachMessage(outreachMessage.id, {
      updated_at: new Date().toISOString(),
      status: result.status === 'sent' || result.status === 'logged' ? 'sent' : 'failed',
      sent_at: result.status === 'sent' || result.status === 'logged' ? new Date().toISOString() : '',
      provider_message_id: result.providerMessageId || '',
      error: result.error || '',
    });

    if (result.status === 'sent' || result.status === 'logged') {
      sent.push(outreachMessage.id);
    } else {
      failed.push(outreachMessage.id);
    }
  }

  const sentAfterRun = await storage.countSentOutreachMessagesSince(dailyLimitSince);

  return {
    ok: true,
    sent,
    failed,
    count: dueMessages.length,
    dailyLimitReached: sentAfterRun >= config.outreach.dailySendLimit,
    dailyLimit: config.outreach.dailySendLimit,
    dailySent: sentAfterRun,
    dailyRemaining: Math.max(0, config.outreach.dailySendLimit - sentAfterRun),
    dailyLimitSince,
  };
}

export function summarizeAutomationState({ latestRun = null, latestAudit = null, latestReport = null, outreachMessages = [], visits = [], emailEngagement = null, submission = null } = {}) {
  const score = scoreProspect({
    submission,
    audit: latestAudit,
    emailEngagement,
    visits,
  });
  const scheduledMessages = outreachMessages.filter((message) => message.status === 'scheduled');
  const sentMessages = outreachMessages.filter((message) => message.status === 'sent');
  const draftMessages = outreachMessages.filter((message) => message.status === 'draft');
  const latestVisit = visits[0] || null;

  return {
    score: score.score,
    tier: score.tier,
    tier_label: score.tierLabel,
    score_reasons: score.reasons,
    latest_run: latestRun,
    latest_audit: latestAudit,
    latest_report: latestReport,
    outreach_messages: outreachMessages,
    website_visits: visits,
    scheduled_count: scheduledMessages.length,
    sent_count: sentMessages.length,
    draft_count: draftMessages.length,
    visit_count: visits.length,
    latest_visit_at: latestVisit?.created_at || '',
  };
}
