import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { getStorage } from '../storage/index.js';

const defaultTimeoutMs = 12000;
const maxCheckedLinks = 12;
const maxReportLength = 50000;
const maxFetchBodyBytes = 2_000_000;
const maxRedirects = 5;
const maxCompetitorsChecked = 3;

class AuditUrlSafetyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuditUrlSafetyError';
    this.status = status;
  }
}

function normalizeText(value = '', maxLength = 5000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeUrl(value = '') {
  const raw = normalizeText(value, 1000);

  if (!raw) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeHostname(hostname = '') {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function parseIpv4(address = '') {
  const parts = String(address)
    .split('.')
    .map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

function isBlockedIpv4(address = '') {
  const parts = parseIpv4(address);

  if (!parts) {
    return false;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function extractIpv4MappedAddress(address = '') {
  const lower = String(address || '').toLowerCase();
  const mappedPrefix = '::ffff:';

  if (lower.startsWith(mappedPrefix)) {
    return lower.slice(mappedPrefix.length);
  }

  const longMappedPrefix = '0:0:0:0:0:ffff:';

  if (lower.startsWith(longMappedPrefix)) {
    return lower.slice(longMappedPrefix.length);
  }

  return '';
}

function isBlockedIpv6(address = '') {
  const lower = String(address || '').toLowerCase();
  const mappedIpv4 = extractIpv4MappedAddress(lower);

  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }

  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  );
}

function isBlockedIpAddress(address = '') {
  const normalized = normalizeHostname(address);
  const version = net.isIP(normalized);

  if (version === 4) {
    return isBlockedIpv4(normalized);
  }

  if (version === 6) {
    return isBlockedIpv6(normalized);
  }

  return false;
}

function isBlockedHostname(hostname = '') {
  const normalized = normalizeHostname(hostname);

  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  );
}

function normalizeLookupResults(results) {
  const values = Array.isArray(results) ? results : [results];

  return values
    .map((result) => (typeof result === 'string' ? result : result?.address))
    .map(normalizeHostname)
    .filter(Boolean);
}

async function assertPublicAuditUrl(urlString, { resolveHost = dnsLookup } = {}) {
  let parsed;

  try {
    parsed = new URL(urlString);
  } catch {
    throw new AuditUrlSafetyError('Add a valid website URL before running the audit.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AuditUrlSafetyError('Website audits only support public http(s) URLs.');
  }

  const hostname = normalizeHostname(parsed.hostname);

  if (isBlockedHostname(hostname)) {
    throw new AuditUrlSafetyError('Website audits can only run against public business websites.');
  }

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new AuditUrlSafetyError('Website audits can only run against public business websites.');
    }

    return true;
  }

  let addresses;

  try {
    addresses = normalizeLookupResults(await resolveHost(hostname, { all: true, verbatim: false }));
  } catch (error) {
    throw new AuditUrlSafetyError(`The website host could not be resolved: ${error.message}`, 502);
  }

  if (addresses.length === 0) {
    throw new AuditUrlSafetyError('The website host could not be resolved.', 502);
  }

  if (addresses.some(isBlockedIpAddress)) {
    throw new AuditUrlSafetyError('Website audits can only run against public business websites.');
  }

  return true;
}

function byteSize(value = '') {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function escapeMarkdown(value = '') {
  return String(value || '').replaceAll('|', '\\|').trim();
}

function extractFirst(html, pattern) {
  return html.match(pattern)?.[1]?.trim() || '';
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html = '') {
  return normalizeText(extractFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i), 180);
}

function extractMeta(html = '', name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escapedName}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+property=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escapedName}["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const value = extractFirst(html, pattern);

    if (value) {
      return normalizeText(value, 500);
    }
  }

  return '';
}

function extractLinks(html = '', baseUrl = '') {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const href = normalizeText(match[1], 1000);

    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }

    try {
      const url = new URL(href, baseUrl);

      if (!['http:', 'https:'].includes(url.protocol)) {
        continue;
      }

      url.hash = '';
      const normalized = url.toString();

      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      links.push({
        href: normalized,
        text: normalizeText(stripHtml(match[2]), 120),
      });
    } catch {
      // Ignore malformed links; the page may include app-specific pseudo links.
    }
  }

  return links;
}

function addFinding(findings, { category, severity = 'medium', title, impact, recommendation, evidence = '' }) {
  findings.push({
    category,
    severity,
    title: normalizeText(title, 160),
    impact: normalizeText(impact, 320),
    recommendation: normalizeText(recommendation, 320),
    evidence: normalizeText(evidence, 320),
  });
}

function getHeader(headers, name) {
  if (!headers) {
    return '';
  }

  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }

  return headers[name] || headers[name.toLowerCase()] || '';
}

async function readResponseText(response, maxBytes = maxFetchBodyBytes) {
  const contentLength = Number(getHeader(response.headers, 'content-length')) || 0;

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const sizeBytes = byteSize(text);

    if (sizeBytes <= maxBytes) {
      return { text, sizeBytes: Math.max(sizeBytes, contentLength), truncated: false };
    }

    return {
      text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
      sizeBytes: Math.max(sizeBytes, contentLength),
      truncated: true,
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
      const remainingBytes = maxBytes - receivedBytes;

      if (remainingBytes > 0) {
        chunks.push(chunk.subarray(0, remainingBytes));
      }

      receivedBytes += chunk.byteLength;

      if (receivedBytes > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  return {
    text: Buffer.concat(chunks).toString('utf8'),
    sizeBytes: Math.max(receivedBytes, contentLength),
    truncated: truncated || contentLength > maxBytes,
  };
}

async function fetchWithTimeout(
  url,
  { fetchImpl = fetch, method = 'GET', timeoutMs = defaultTimeoutMs, headers = {}, resolveHost = dnsLookup } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let currentUrl = url;
  let redirectCount = 0;

  try {
    while (redirectCount <= maxRedirects) {
      await assertPublicAuditUrl(currentUrl, { resolveHost });

      const response = await fetchImpl(currentUrl, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'UckeleGroupManualAudit/1.0',
          ...headers,
        },
      });
      const status = Number(response.status) || 0;
      const location = getHeader(response.headers, 'location');

      if (status >= 300 && status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount += 1;
        continue;
      }

      const durationMs = Date.now() - startedAt;
      const body = method === 'HEAD' ? { text: '', sizeBytes: 0, truncated: false } : await readResponseText(response);

      return {
        ok: true,
        url,
        finalUrl: response.url || currentUrl,
        status,
        statusText: response.statusText,
        durationMs,
        headers: response.headers,
        text: body.text,
        sizeBytes: body.sizeBytes,
        truncated: body.truncated,
        redirects: redirectCount,
      };
    }

    return {
      ok: false,
      url,
      finalUrl: currentUrl,
      status: 0,
      statusText: '',
      durationMs: Date.now() - startedAt,
      headers: new Headers(),
      text: '',
      sizeBytes: 0,
      error: 'Too many redirects.',
    };
  } catch (error) {
    return {
      ok: false,
      url,
      finalUrl: currentUrl,
      status: 0,
      statusText: '',
      durationMs: Date.now() - startedAt,
      headers: new Headers(),
      text: '',
      sizeBytes: 0,
      blocked: error instanceof AuditUrlSafetyError && error.status === 400,
      error: error.name === 'AbortError' ? 'Request timed out.' : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLink(link, { fetchImpl, resolveHost }) {
  const head = await fetchWithTimeout(link.href, {
    fetchImpl,
    resolveHost,
    method: 'HEAD',
    timeoutMs: 5000,
  });

  if (head.ok && head.status > 0 && head.status < 400) {
    return { ...link, status: head.status, ok: true };
  }

  const get = await fetchWithTimeout(link.href, {
    fetchImpl,
    resolveHost,
    method: 'GET',
    timeoutMs: 6000,
    headers: { Range: 'bytes=0-1024' },
  });

  return {
    ...link,
    status: get.status || head.status || 0,
    ok: get.ok && get.status > 0 && get.status < 400,
    error: get.error || head.error || '',
  };
}

async function checkBrokenLinks(html, pageUrl, { fetchImpl, resolveHost }) {
  const pageOrigin = new URL(pageUrl).origin;
  const links = extractLinks(html, pageUrl)
    .filter((link) => new URL(link.href).origin === pageOrigin)
    .slice(0, maxCheckedLinks);

  const checked = await Promise.all(links.map((link) => checkLink(link, { fetchImpl, resolveHost })));

  return {
    checkedCount: checked.length,
    broken: checked.filter((link) => !link.ok || link.status >= 400),
  };
}

function analyzeHtml({ html, pageUrl, response, brokenLinks }) {
  const findings = [];
  const visibleText = stripHtml(html);
  const lowerText = visibleText.toLowerCase();
  const lowerHtml = html.toLowerCase();
  const title = extractTitle(html);
  const description = extractMeta(html, 'description');
  const viewport = extractMeta(html, 'viewport');
  const lastModified = getHeader(response.headers, 'last-modified');
  const contentLengthHeader = Number(getHeader(response.headers, 'content-length')) || 0;
  const sizeBytes = Math.max(response.sizeBytes, contentLengthHeader);
  const ctaPattern = /\b(call|contact|schedule|book|quote|estimate|consultation|get started|request|demo|learn more)\b/i;
  const hasCta = ctaPattern.test(visibleText) || /href=["'](?:tel:|mailto:)/i.test(html);
  const hasContactForm = /<form\b/i.test(html) && /(name=["']?(email|phone|name|message)|type=["']?(email|tel)|textarea)/i.test(html);
  const hasContactPath = hasContactForm || /href=["'](?:tel:|mailto:)/i.test(html) || /\bcontact\b/i.test(visibleText);
  const fixedWidthMatches = [...html.matchAll(/(?:width|min-width)\s*:\s*(\d{3,})px/gi)].map((match) => Number(match[1]));
  const maxFixedWidth = fixedWidthMatches.length ? Math.max(...fixedWidthMatches) : 0;
  const currentYear = new Date().getFullYear();
  const copyrightYears = [...visibleText.matchAll(/(?:copyright|©)\s*(?:\D{0,8})(20\d{2})/gi)].map((match) => Number(match[1]));
  const latestCopyrightYear = copyrightYears.length ? Math.max(...copyrightYears) : 0;

  if (!response.ok || response.status >= 400) {
    addFinding(findings, {
      category: 'uptime',
      severity: 'high',
      title: `Homepage returned HTTP ${response.status || 'error'}`,
      impact: 'Visitors and search engines may not be able to reliably access the site.',
      recommendation: 'Fix the server response and confirm the primary homepage returns a successful 200-level response.',
      evidence: response.error || response.statusText || pageUrl,
    });
  }

  if (!new URL(response.finalUrl || pageUrl).protocol.startsWith('https')) {
    addFinding(findings, {
      category: 'trust',
      severity: 'high',
      title: 'Primary page is not loading over HTTPS',
      impact: 'Browsers may show a not-secure warning, which can reduce trust before a visitor calls or submits a form.',
      recommendation: 'Redirect all HTTP traffic to HTTPS and confirm the SSL certificate is valid.',
      evidence: response.finalUrl || pageUrl,
    });
  }

  if (!title) {
    addFinding(findings, {
      category: 'seo',
      severity: 'medium',
      title: 'Homepage is missing a page title',
      impact: 'Search results and browser tabs will not clearly describe the business.',
      recommendation: 'Add a concise title with the business name, service category, and city or service area.',
    });
  } else if (title.length < 25 || title.length > 70) {
    addFinding(findings, {
      category: 'seo',
      severity: 'low',
      title: 'Page title length should be tightened',
      impact: 'The title may be too vague or may truncate in search results.',
      recommendation: 'Aim for roughly 30-65 characters and include the primary service plus local market.',
      evidence: title,
    });
  }

  if (!description) {
    addFinding(findings, {
      category: 'seo',
      severity: 'medium',
      title: 'Homepage is missing a meta description',
      impact: 'Search results may show random page text instead of a clear reason to contact the business.',
      recommendation: 'Add a 120-160 character description that mentions the service, location, and next action.',
    });
  } else if (description.length < 70 || description.length > 170) {
    addFinding(findings, {
      category: 'seo',
      severity: 'low',
      title: 'Meta description could be clearer',
      impact: 'A weak snippet can reduce search click-through from qualified local prospects.',
      recommendation: 'Rewrite it as a direct value proposition with service, location, trust signal, and CTA.',
      evidence: description,
    });
  }

  if (!hasCta) {
    addFinding(findings, {
      category: 'conversion',
      severity: 'high',
      title: 'No clear call to action was visible on the page',
      impact: 'Visitors may understand the business but not know what to do next.',
      recommendation: 'Add prominent call, quote, schedule, or contact buttons near the top of the mobile and desktop page.',
    });
  }

  if (!hasContactPath) {
    addFinding(findings, {
      category: 'contact-flow',
      severity: 'high',
      title: 'No obvious contact form, phone link, or email link was found',
      impact: 'High-intent visitors may leave instead of starting a conversation.',
      recommendation: 'Add a short contact form and tappable phone/email links in the header, footer, and main CTA area.',
    });
  } else if (!hasContactForm && !/href=["']tel:/i.test(html)) {
    addFinding(findings, {
      category: 'contact-flow',
      severity: 'medium',
      title: 'Contact flow could be easier for mobile visitors',
      impact: 'Visitors may need extra taps or scrolling before they can reach the business.',
      recommendation: 'Add a short form or click-to-call button above the fold on mobile.',
    });
  }

  if (!viewport) {
    addFinding(findings, {
      category: 'mobile',
      severity: 'high',
      title: 'Mobile viewport tag is missing',
      impact: 'Phones may render the desktop layout scaled down, making calls and forms harder to use.',
      recommendation: 'Add a responsive viewport meta tag and test the homepage at common mobile widths.',
    });
  }

  if (maxFixedWidth > 900) {
    addFinding(findings, {
      category: 'mobile',
      severity: 'medium',
      title: 'Large fixed-width styling may hurt mobile layout',
      impact: 'Some sections may overflow or require sideways scrolling on smaller screens.',
      recommendation: 'Replace fixed pixel widths with responsive max-width, grid, or flex layouts.',
      evidence: `Largest fixed width detected: ${maxFixedWidth}px`,
    });
  }

  if (brokenLinks.broken.length > 0) {
    addFinding(findings, {
      category: 'broken-links',
      severity: brokenLinks.broken.length > 2 ? 'high' : 'medium',
      title: `${brokenLinks.broken.length} broken internal link${brokenLinks.broken.length === 1 ? '' : 's'} found`,
      impact: 'Broken links interrupt visitors and can reduce trust in the business.',
      recommendation: 'Fix or remove the broken links, then recheck the homepage navigation and footer.',
      evidence: brokenLinks.broken.slice(0, 3).map((link) => `${link.status || 'error'} ${link.href}`).join('; '),
    });
  }

  if (response.durationMs > 3500) {
    addFinding(findings, {
      category: 'speed',
      severity: response.durationMs > 6500 ? 'high' : 'medium',
      title: 'Homepage responded slowly during the audit',
      impact: 'Slow pages can reduce calls, form submissions, and local search performance.',
      recommendation: 'Review hosting, image weight, scripts, and caching for the homepage.',
      evidence: `${response.durationMs}ms response time`,
    });
  }

  if (sizeBytes > 1_500_000) {
    addFinding(findings, {
      category: 'speed',
      severity: sizeBytes > 3_000_000 ? 'high' : 'medium',
      title: 'Homepage HTML response is unusually large',
      impact: 'Large pages can be slow on mobile connections and may lose impatient visitors.',
      recommendation: 'Compress assets, lazy-load media, and remove unused scripts or markup.',
      evidence: `${Math.round(sizeBytes / 1024)} KB HTML response`,
    });
  }

  if (response.truncated) {
    addFinding(findings, {
      category: 'speed',
      severity: 'high',
      title: 'Homepage response was too large to fully scan',
      impact: 'Very large pages can load slowly and make mobile visitors leave before contacting the business.',
      recommendation: 'Reduce page weight, compress assets, and remove unused scripts before running another audit.',
      evidence: `Audit scan capped the HTML response at ${Math.round(maxFetchBodyBytes / 1024)} KB`,
    });
  }

  if (lastModified) {
    const lastModifiedDate = Date.parse(lastModified);
    const daysOld = Number.isFinite(lastModifiedDate)
      ? Math.floor((Date.now() - lastModifiedDate) / (1000 * 60 * 60 * 24))
      : 0;

    if (daysOld > 365) {
      addFinding(findings, {
        category: 'freshness',
        severity: 'low',
        title: 'Homepage may not have been updated recently',
        impact: 'Old visible content or stale trust signals can make the business look less active.',
        recommendation: 'Refresh testimonials, service details, photos, financing/offer notes, or local proof points.',
        evidence: `Last-Modified header is ${lastModified}`,
      });
    }
  } else if (latestCopyrightYear && latestCopyrightYear < currentYear - 1) {
    addFinding(findings, {
      category: 'freshness',
      severity: 'low',
      title: 'Visible copyright year appears stale',
      impact: 'A stale footer can make visitors wonder whether the business is still active.',
      recommendation: 'Update footer/legal content and review dated page copy.',
      evidence: `Latest visible copyright year: ${latestCopyrightYear}`,
    });
  }

  if (!/(review|testimonial|licensed|insured|certified|award|years|family owned|locally owned)/i.test(lowerText)) {
    addFinding(findings, {
      category: 'trust',
      severity: 'low',
      title: 'Trust signals could be stronger',
      impact: 'Visitors may compare competitors before deciding who to call.',
      recommendation: 'Add proof such as reviews, years in business, certifications, warranties, case examples, or local customer logos.',
    });
  }

  return {
    title,
    description,
    viewport,
    hasContactForm,
    hasCta,
    hasContactPath,
    lastModified,
    sizeBytes,
    checkedLinks: brokenLinks.checkedCount,
    brokenLinks: brokenLinks.broken,
    findings,
    visibleKeywords: {
      callsPhone: /href=["']tel:/i.test(html),
      emailLink: /href=["']mailto:/i.test(html),
      mentionsReviews: /review|testimonial/i.test(lowerHtml),
    },
  };
}

function scoreFindings(findings) {
  const penalty = findings.reduce((total, finding) => {
    if (finding.severity === 'high') {
      return total + 16;
    }

    if (finding.severity === 'medium') {
      return total + 9;
    }

    return total + 4;
  }, 0);

  return Math.max(0, Math.min(100, 100 - penalty));
}

function normalizeCompetitorUrls(value = []) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[\n,;]+/)
        .map((item) => item.trim());
  const urls = [];
  const seen = new Set();

  rawValues.forEach((rawValue) => {
    const normalized = normalizeUrl(rawValue);

    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    urls.push(normalized);
  });

  return urls.slice(0, maxCompetitorsChecked);
}

function buildPreviousCompetitorMap(previousInsights = []) {
  return previousInsights.reduce((accumulator, insight) => {
    const normalized = normalizeUrl(insight.url);

    if (normalized && !accumulator.has(normalized)) {
      accumulator.set(normalized, insight);
    }

    return accumulator;
  }, new Map());
}

function summarizeCompetitorChanges(current, previous) {
  if (!previous) {
    return [];
  }

  const changes = [];

  if (previous.status && current.status && previous.status !== current.status) {
    changes.push(`Status changed from ${previous.status} to ${current.status}`);
  }

  if (previous.title && current.title && previous.title !== current.title) {
    changes.push('Homepage title changed');
  }

  if (Number.isFinite(previous.score) && Number.isFinite(current.score) && Math.abs(previous.score - current.score) >= 10) {
    changes.push(`Audit score changed from ${previous.score} to ${current.score}`);
  }

  const previousSignals = Array.isArray(previous.signals) ? previous.signals.join('|') : '';
  const currentSignals = Array.isArray(current.signals) ? current.signals.join('|') : '';

  if (previousSignals && currentSignals && previousSignals !== currentSignals) {
    changes.push('Visible CTA/contact signals changed');
  }

  return changes;
}

async function loadPreviousCompetitorInsights(storage, submissionId) {
  if (!submissionId || !storage.listProspectAudits) {
    return [];
  }

  try {
    const audits = await storage.listProspectAudits({ submissionId, limit: 5 });

    return audits.flatMap((audit) => audit.competitor_insights || []);
  } catch {
    return [];
  }
}

async function auditCompetitors(competitorUrls = [], { fetchImpl, resolveHost, checkedAt, previousInsights = [] }) {
  const urls = normalizeCompetitorUrls(competitorUrls);
  const insights = [];
  const previousByUrl = buildPreviousCompetitorMap(previousInsights);

  for (const competitorUrl of urls) {
    try {
      const response = await fetchWithTimeout(competitorUrl, {
        fetchImpl,
        resolveHost,
        timeoutMs: 8000,
      });

      if (!response.ok || !response.text) {
        const current = {
          url: competitorUrl,
          status: 'unreachable',
          checkedAt,
          signals: [],
        };
        const changes = summarizeCompetitorChanges(current, previousByUrl.get(competitorUrl));

        insights.push({
          ...current,
          summary: changes.length
            ? `Competitor homepage could not be reached; changes detected since the prior audit.`
            : `Competitor homepage could not be reached: ${response.error || response.statusText || 'unknown error'}.`,
          changes,
          previousCheckedAt: previousByUrl.get(competitorUrl)?.checkedAt || '',
        });
        continue;
      }

      const analysis = analyzeHtml({
        html: response.text,
        pageUrl: competitorUrl,
        response,
        brokenLinks: { checkedCount: 0, broken: [] },
      });
      const competitorScore = scoreFindings(analysis.findings);
      const signals = [
        analysis.hasCta ? 'Clear call to action visible' : 'No clear call to action detected',
        analysis.hasContactPath ? 'Contact path visible' : 'Contact path was not obvious',
        analysis.lastModified ? `Last-Modified: ${analysis.lastModified}` : '',
      ].filter(Boolean);
      const current = {
        url: competitorUrl,
        status: 'checked',
        checkedAt,
        score: competitorScore,
        title: analysis.title,
        signals,
        topFindings: analysis.findings.slice(0, 3).map((finding) => finding.title),
      };
      const changes = summarizeCompetitorChanges(current, previousByUrl.get(competitorUrl));

      insights.push({
        ...current,
        summary: changes.length
          ? `${new URL(competitorUrl).hostname} has ${changes.length} visible change${changes.length === 1 ? '' : 's'} since the prior audit.`
          : previousByUrl.has(competitorUrl)
            ? `${new URL(competitorUrl).hostname} did not show obvious visible changes since the prior audit.`
            : `${new URL(competitorUrl).hostname} baseline captured for future change comparisons.`,
        changes,
        previousCheckedAt: previousByUrl.get(competitorUrl)?.checkedAt || '',
      });
    } catch (error) {
      const current = {
        url: competitorUrl,
        status: error instanceof AuditUrlSafetyError ? 'skipped' : 'error',
        checkedAt,
        signals: [],
      };
      const changes = summarizeCompetitorChanges(current, previousByUrl.get(competitorUrl));

      insights.push({
        ...current,
        summary: error.message || 'Competitor check could not be completed.',
        changes,
        previousCheckedAt: previousByUrl.get(competitorUrl)?.checkedAt || '',
      });
    }
  }

  return insights;
}

function buildReport({ businessName, targetUrl, audit, run, reportId }) {
  const findings = audit.findings || [];
  const topFindings = findings.slice(0, 5);
  const competitorInsights = audit.competitor_insights || [];
  const sourceRows = (audit.sources || [])
    .map((source) => `| ${escapeMarkdown(source.type)} | ${escapeMarkdown(source.url)} | ${escapeMarkdown(source.status || '')} | ${escapeMarkdown(source.note || '')} |`)
    .join('\n');
  const competitorRows = competitorInsights
    .map((insight) => `| ${escapeMarkdown(insight.url)} | ${escapeMarkdown(insight.status)} | ${escapeMarkdown(insight.summary)} |`)
    .join('\n');
  const competitorSection = competitorInsights.length
    ? `
## Competitor Snapshot

| Competitor | Status | Notes |
| --- | --- | --- |
${competitorRows}
`
    : '';
  const findingRows = topFindings.length
    ? topFindings
        .map(
          (finding, index) => `
${index + 1}. **${finding.title}** (${finding.severity})
   - Impact: ${finding.impact}
   - Recommended fix: ${finding.recommendation}
   ${finding.evidence ? `- Evidence: ${finding.evidence}` : ''}
`,
        )
        .join('\n')
    : 'No material lead-reducing issues were found in this manual homepage audit.';

  return `# Website Lead Audit: ${businessName}

Generated: ${new Date().toISOString()}
Website: ${targetUrl}
Audit ID: ${audit.id}
Run ID: ${run.id}
Report ID: ${reportId}
Score: ${audit.score}/100
Status: ${audit.status}

## Executive Summary

${audit.summary}

## Top Actionable Findings

${findingRows}

## Outreach Personalization Notes

- Reference the exact website checked: ${targetUrl}
- Lead with the strongest opportunity: ${topFindings[0]?.title || 'No urgent website issue found'}
- Keep the email practical: offer a 15-minute walkthrough of the highest-leverage fix.

## Sources Checked

| Type | URL | Status | Note |
| --- | --- | --- | --- |
${sourceRows || `| homepage | ${escapeMarkdown(targetUrl)} | not checked | No source data available |`}
${competitorSection}
`.slice(0, maxReportLength);
}

function deriveProspectFromSubmission(submission = {}) {
  const metadata = typeof submission.metadata === 'object' && submission.metadata !== null ? submission.metadata : {};

  return {
    businessName: submission.company || submission.name || 'Unknown business',
    websiteUrl: submission.business_website || submission.listing_url || '',
    contactName: submission.seller_name || submission.broker_name || submission.name || '',
    contactEmail: submission.seller_email || submission.broker_email || submission.email || '',
    phone: submission.seller_phone || submission.broker_phone || submission.phone || '',
    industry: submission.role || '',
    location: '',
    competitorUrls: metadata.competitorUrls || metadata.competitor_urls || metadata.competitors || [],
  };
}

function createAuditInput({
  run,
  submissionId,
  checkedAt,
  businessName,
  targetUrl,
  mergedProspect,
  status = 'completed',
  score = 0,
  summary,
  findings = [],
  competitorInsights = [],
  sources = [],
  error = '',
  metadata = {},
}) {
  return {
    id: randomUUID(),
    run_id: run.id,
    submission_id: submissionId || null,
    created_at: checkedAt,
    updated_at: checkedAt,
    status,
    business_name: businessName,
    website_url: targetUrl,
    contact_name: mergedProspect.contactName || '',
    contact_email: mergedProspect.contactEmail || '',
    phone: mergedProspect.phone || '',
    location: mergedProspect.location || '',
    industry: mergedProspect.industry || '',
    score,
    summary,
    findings,
    competitor_insights: competitorInsights,
    sources,
    report_id: null,
    error,
    metadata,
  };
}

async function saveAuditReport({ storage, run, auditInput, businessName, targetUrl, submissionId, score, summary }) {
  const audit = await storage.insertProspectAudit(auditInput);
  const reportId = randomUUID();
  const reportContent = buildReport({
    businessName,
    targetUrl,
    audit,
    run,
    reportId,
  });
  const now = new Date().toISOString();
  const report = await storage.insertGeneratedMarketReport({
    id: reportId,
    run_id: run.id,
    audit_id: audit.id,
    submission_id: submissionId || null,
    created_at: now,
    updated_at: now,
    report_type: 'prospect-website-audit',
    title: `${businessName} Website Lead Audit`,
    format: 'markdown',
    status: 'ready',
    storage_path: '',
    content: reportContent,
    summary,
    metadata: {
      score,
      findingCount: audit.findings.length,
      sourceUrl: targetUrl,
      competitorInsightCount: audit.competitor_insights.length,
    },
  });
  const document = await storage.insertGeneratedReportDocument({
    id: randomUUID(),
    report_id: report.id,
    run_id: run.id,
    audit_id: audit.id,
    submission_id: submissionId || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    document_type: 'markdown',
    title: `${businessName} Website Lead Audit Markdown`,
    file_name: `${businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'website'}-audit.md`,
    mime_type: 'text/markdown',
    size_bytes: byteSize(reportContent),
    storage_path: `inline:generated_market_reports/${report.id}`,
    checksum: createHash('sha256').update(reportContent).digest('hex'),
    status: 'ready',
    metadata: {
      inlineReportContent: true,
    },
  });

  await storage.updateProspectAudit(audit.id, {
    updated_at: new Date().toISOString(),
    report_id: report.id,
  });

  return {
    audit: await storage.getProspectAudit(audit.id),
    report,
    document,
  };
}

export async function runManualResearchAudit(
  { submissionId = '', url = '', prospect = {}, requestedBy = '' } = {},
  { storage = getStorage(), fetchImpl = fetch, resolveHost = dnsLookup } = {},
) {
  const now = new Date().toISOString();
  const submission = submissionId ? await storage.getSubmission(submissionId) : null;
  let run = null;

  if (submissionId && !submission) {
    return { ok: false, status: 404, error: 'CRM record was not found.' };
  }

  const mergedProspect = {
    ...deriveProspectFromSubmission(submission || {}),
    ...prospect,
  };
  const targetUrl = normalizeUrl(url || mergedProspect.websiteUrl);

  if (!targetUrl) {
    return { ok: false, status: 400, error: 'Add a valid website URL before running the audit.' };
  }

  try {
    await assertPublicAuditUrl(targetUrl, { resolveHost });
  } catch (error) {
    if (error instanceof AuditUrlSafetyError && error.status === 400) {
      return { ok: false, status: 400, error: error.message };
    }
  }

  try {
    run = await storage.insertResearchRun({
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      status: 'running',
      run_type: 'manual-website-audit',
      source: submissionId ? 'admin-crm-record' : 'admin-url',
      query: targetUrl,
      location: mergedProspect.location || '',
      industry: mergedProspect.industry || '',
      requested_by: requestedBy,
      started_at: now,
      completed_at: null,
      total_candidates: 1,
      total_audited: 0,
      total_reports: 0,
      error: '',
      metadata: {
        submissionId,
        prospect: mergedProspect,
      },
    });

    const businessName = normalizeText(mergedProspect.businessName, 160) || new URL(targetUrl).hostname;
    const checkedAt = new Date().toISOString();
    const response = await fetchWithTimeout(targetUrl, { fetchImpl, resolveHost });
    const competitorUrls = mergedProspect.competitorUrls || mergedProspect.competitor_urls || mergedProspect.competitors || [];
    const previousCompetitorInsights = await loadPreviousCompetitorInsights(storage, submissionId);
    const competitorInsights = await auditCompetitors(competitorUrls, {
      fetchImpl,
      resolveHost,
      checkedAt,
      previousInsights: previousCompetitorInsights,
    });

    if (!response.ok || !response.text) {
      const reason = response.error || response.statusText || 'unknown error';
      const findings = [
        {
          category: 'uptime',
          severity: 'high',
          title: 'Homepage could not be reached',
          impact: 'Prospects and search engines may be unable to reach the business website.',
          recommendation: 'Confirm DNS, hosting, redirects, and SSL configuration for the primary URL.',
          evidence: reason,
        },
      ];
      const summary = `The website could not be fully audited because the homepage request failed: ${reason}.`;
      const auditInput = createAuditInput({
        run,
        submissionId,
        checkedAt,
        businessName,
        targetUrl,
        mergedProspect,
        status: 'completed',
        score: 0,
        summary,
        findings,
        competitorInsights,
        sources: [
          {
            type: 'homepage',
            url: targetUrl,
            finalUrl: response.finalUrl,
            status: response.status || 'error',
            checkedAt,
            durationMs: response.durationMs,
            note: reason,
          },
        ],
        metadata: {
          finalUrl: response.finalUrl,
          fetchError: reason,
          blocked: Boolean(response.blocked),
          competitorCoverage: competitorInsights.length ? 'checked' : 'not_configured',
        },
      });
      const saved = await saveAuditReport({
        storage,
        run,
        auditInput,
        businessName,
        targetUrl,
        submissionId,
        score: 0,
        summary,
      });
      const completedRun = await storage.updateResearchRun(run.id, {
        updated_at: new Date().toISOString(),
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_audited: 1,
        total_reports: 1,
        error: '',
      });

      return {
        ok: true,
        status: 201,
        run: completedRun,
        ...saved,
      };
    }

    const brokenLinks = await checkBrokenLinks(response.text, response.finalUrl || targetUrl, { fetchImpl, resolveHost });
    const analysis = analyzeHtml({
      html: response.text,
      pageUrl: targetUrl,
      response,
      brokenLinks,
    });
    const score = scoreFindings(analysis.findings);
    const summary =
      analysis.findings.length > 0
        ? `${businessName} has ${analysis.findings.length} actionable website issue${analysis.findings.length === 1 ? '' : 's'} that could reduce leads. The highest-priority item is: ${analysis.findings[0].title}.`
        : `${businessName} did not show material lead-reducing issues in this homepage audit. Keep monitoring contact flow, speed, and local trust signals.`;
    const sources = [
      {
        type: 'homepage',
        url: targetUrl,
        finalUrl: response.finalUrl,
        status: response.status,
        checkedAt,
        durationMs: response.durationMs,
        sizeBytes: analysis.sizeBytes,
        note: analysis.title || 'Homepage fetched',
      },
      ...analysis.brokenLinks.slice(0, 8).map((link) => ({
        type: 'broken-link',
        url: link.href,
        status: link.status || 'error',
        checkedAt,
        note: link.text || link.error || 'Broken internal link',
      })),
    ];
    const saved = await saveAuditReport({
      storage,
      run,
      auditInput: createAuditInput({
        run,
        submissionId,
        checkedAt,
        businessName,
        targetUrl,
        mergedProspect,
        status: 'completed',
        score,
        summary,
        findings: analysis.findings,
        competitorInsights,
        sources,
        metadata: {
          pageTitle: analysis.title,
          metaDescription: analysis.description,
          viewport: analysis.viewport,
          hasContactForm: analysis.hasContactForm,
          hasCta: analysis.hasCta,
          checkedLinks: analysis.checkedLinks,
          visibleKeywords: analysis.visibleKeywords,
          competitorCoverage: competitorInsights.length ? 'checked' : 'not_configured',
        },
      }),
      businessName,
      targetUrl,
      submissionId,
      score,
      summary,
    });
    const completedRun = await storage.updateResearchRun(run.id, {
      updated_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
      total_audited: 1,
      total_reports: 1,
      error: '',
    });

    return {
      ok: true,
      status: 201,
      run: completedRun,
      ...saved,
    };
  } catch (error) {
    const errorMessage = normalizeText(error.message || 'Manual website audit failed.', 500);
    let failedRun = run;

    if (run?.id) {
      try {
        failedRun = await storage.updateResearchRun(run.id, {
          updated_at: new Date().toISOString(),
          status: 'failed',
          completed_at: new Date().toISOString(),
          error: errorMessage,
        });
      } catch {
        // Preserve the original failure so the API can return the actionable error.
      }
    }

    return {
      ok: false,
      status: error instanceof AuditUrlSafetyError ? error.status : 500,
      error: errorMessage,
      run: failedRun,
    };
  }
}
