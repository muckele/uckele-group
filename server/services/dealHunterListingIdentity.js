export const DEAL_HUNTER_CRM_MATCH_MAXIMUM_ALIASES = 500;

function normalizeListingText(value = '', maxLength = 1000) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeListingText(item, maxLength)).filter(Boolean).join(', ');
  }

  if (value && typeof value === 'object') {
    if (value.url) return normalizeListingText(value.url, maxLength);
    if (value.label) return normalizeListingText(value.label, maxLength);
    return normalizeListingText(Object.values(value).join(' '), maxLength);
  }

  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeDealHunterListingUrl(value = '') {
  const normalized = normalizeListingText(value, 1000);

  if (!normalized) return '';

  const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeDealHunterListingIdentity(value = '') {
  const normalized = normalizeListingText(value, 1000).toLowerCase();

  if (!normalized) return '';

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) return '';

    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => !/^utm_/i.test(key) && !['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));
    const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';

    return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}${query}`;
  } catch {
    return normalized.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/[?&]utm_[^&]*/gi, '');
  }
}

export function dealHunterListingMarketplaceAliases(listingUrl = '') {
  const normalized = normalizeDealHunterListingUrl(listingUrl);
  if (!normalized) return [];

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase();
    const aliases = [];
    const numericAdId = pathname.match(/(?:\/|[-_])(\d{5,})(?:\.[a-z]+)?$/)?.[1];

    const exactHost = (domain) => host === domain || host.endsWith(`.${domain}`);
    if (numericAdId && ['bizbuysell.com', 'bizquest.com', 'loopnet.com'].some(exactHost)) {
      aliases.push(`costar:${numericAdId}`);
    }
    if (exactHost('dealstream.com') && pathname && pathname !== '/') aliases.push(`dealstream:${pathname}`);
    if (numericAdId && exactHost('businessbroker.net')) aliases.push(`businessbroker:${numericAdId}`);
    return aliases;
  } catch {
    return [];
  }
}
