import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAttribution, recordAnalyticsEvent } from '../server/services/analytics.js';

function createHarness({ eventCount = 0 } = {}) {
  const rateLimitEvents = [];
  const analyticsEvents = [];
  const storage = {
    async countRateLimitEvents() { return eventCount; },
    async addRateLimitEvent(bucket, createdAt) { rateLimitEvents.push({ bucket, createdAt }); },
    async insertAnalyticsEvent(event) { analyticsEvents.push(event); return event; },
  };
  const config = {
    analytics: { enabled: true, retentionDays: 90, rateLimitWindowMs: 60_000, rateLimitMax: 120 },
  };
  const request = {
    headers: {
      'fly-client-ip': '203.0.113.42',
      referer: 'https://broker.example/listing/secret-deal?owner=private',
    },
    ip: '203.0.113.42',
  };

  return { analyticsEvents, config, rateLimitEvents, request, storage };
}

test('analytics stores only an allowlisted public event and coarse attribution', async () => {
  const harness = createHarness();
  const result = await recordAnalyticsEvent({
    eventName: 'criteria_downloaded',
    path: '/criteria?private=value',
    placement: 'criteria_page',
    attribution: {
      referrerHost: 'https://broker.example/listing/secret-deal?owner=private',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'succession-outreach',
      email: 'must-not-be-stored@example.com',
    },
  }, harness.request, harness);

  assert.equal(result.ok, true);
  assert.equal(harness.analyticsEvents.length, 1);
  assert.deepEqual(
    harness.analyticsEvents[0],
    {
      id: harness.analyticsEvents[0].id,
      created_at: harness.analyticsEvents[0].created_at,
      event_name: 'criteria_downloaded',
      path: '/criteria',
      referrer_host: 'broker.example',
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'succession-outreach',
      placement: 'criteria_page',
    },
  );
  assert.doesNotMatch(JSON.stringify(harness.analyticsEvents[0]), /203\.0\.113\.42|secret-deal|must-not-be-stored/);
  assert.match(harness.rateLimitEvents[0].bucket, /^analytics:[a-f0-9]{24}$/);
});

test('analytics rejects protected paths, arbitrary events, and unbounded download placements', async () => {
  for (const body of [
    { eventName: 'page_view', path: '/admin' },
    { eventName: 'page_view', path: '/secure-documents' },
    { eventName: 'form_field_value', path: '/contact' },
    { eventName: 'criteria_downloaded', path: '/', placement: 'unknown' },
  ]) {
    const harness = createHarness();
    const result = await recordAnalyticsEvent(body, harness.request, harness);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(harness.analyticsEvents.length, 0);
  }
});

test('analytics rate limiting drops excess events without creating a tracking record', async () => {
  const harness = createHarness({ eventCount: 120 });
  const result = await recordAnalyticsEvent({ eventName: 'page_view', path: '/' }, harness.request, harness);

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(harness.analyticsEvents.length, 0);
  assert.equal(harness.rateLimitEvents.length, 0);
});

test('attribution keeps a hostname instead of a full referring URL', () => {
  assert.deepEqual(
    normalizeAttribution({}, { headers: { referer: 'https://www.example.com/private/path?token=secret' } }),
    { referrerHost: 'example.com', utmSource: '', utmMedium: '', utmCampaign: '' },
  );
  assert.equal(
    normalizeAttribution({ referrerHost: '' }, { headers: { referer: 'https://www.uckelegroup.com/contact' } }).referrerHost,
    '',
    'an explicitly direct visit must not be replaced with the first-party request referer',
  );
});
