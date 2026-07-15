const attributionStorageKey = 'uckele-group:visit-attribution';
const allowedPaths = new Set([
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

function cleanValue(value, maxLength) {
  return String(value || '')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, maxLength);
}

function referrerHostname(value) {
  if (!value) return '';

  try {
    const hostname = new URL(value, window.location.origin).hostname.replace(/^www\./, '').toLowerCase();
    return hostname === window.location.hostname.replace(/^www\./, '').toLowerCase() ? '' : cleanValue(hostname, 200);
  } catch {
    return '';
  }
}

function readInitialAttribution() {
  const params = new URLSearchParams(window.location.search);
  return {
    referrerHost: referrerHostname(document.referrer),
    utmSource: cleanValue(params.get('utm_source'), 100),
    utmMedium: cleanValue(params.get('utm_medium'), 100),
    utmCampaign: cleanValue(params.get('utm_campaign'), 120),
  };
}

export function getSafeAttribution() {
  if (typeof window === 'undefined') {
    return { referrerHost: '', utmSource: '', utmMedium: '', utmCampaign: '' };
  }

  try {
    const storedValue = window.sessionStorage.getItem(attributionStorageKey);
    if (storedValue) return JSON.parse(storedValue);

    const attribution = readInitialAttribution();
    window.sessionStorage.setItem(attributionStorageKey, JSON.stringify(attribution));
    return attribution;
  } catch {
    return readInitialAttribution();
  }
}

export function trackAnalyticsEvent(eventName, { path = window.location.pathname, placement = '' } = {}) {
  if (typeof window === 'undefined' || !allowedPaths.has(path)) return;

  const payload = JSON.stringify({
    eventName,
    path,
    placement,
    attribution: getSafeAttribution(),
  });

  try {
    if (typeof navigator.sendBeacon === 'function') {
      const queued = navigator.sendBeacon('/api/analytics/events', new Blob([payload], { type: 'application/json' }));
      if (queued) return;
    }

    void fetch('/api/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never interrupt a public visitor's task.
  }
}
